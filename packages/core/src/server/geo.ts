import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, open, readFile, rename, rm, statfs, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { totalmem } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createZstdDecompress } from "node:zlib";
import type { Geo } from "../geo/geo.ts";
import { GeoUnavailable } from "../geo/geo.ts";
import { httpGeo } from "../geo/http.ts";

/**
 * The map a server runs for itself (ADR 17): Photon for addresses and places, GraphHopper for
 * routes, both Java, on a JRE of their own, with the OpenStreetMap data of one region the owner
 * picks. Nothing about where people are or go leaves the machine.
 */

/** A file the server downloads, checked against its hash. */
type Pinned = { readonly url: string; readonly sha256: string };

const JRE: Partial<Record<NodeJS.Architecture, Pinned>> = {
  x64: {
    url: "https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.13%2B9/OpenJDK21U-jre_x64_linux_hotspot_21.0.13_9.tar.gz",
    sha256: "a535a1df9c6284d9618872984e026ae0352d1f7e9e0605425c0e6114f47351dd",
  },
  arm64: {
    url: "https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.12.1%2B1/OpenJDK21U-jre_aarch64_linux_hotspot_21.0.12.1_1.tar.gz",
    sha256: "14be1f35ebdbd1f6e8d57eb911a3ffb74d6d9aa255abc5daf2b1302002cf2cf2",
  },
};

const PHOTON: Pinned & { readonly file: string } = {
  file: "photon-1.3.0.jar",
  url: "https://github.com/komoot/photon/releases/download/1.3.0/photon-1.3.0.jar",
  sha256: "a89707c0045e4807b2a1180e132e68e108d998709f48b6c94b98a6e281f571a5",
};

const GRAPHHOPPER: Pinned & { readonly file: string } = {
  file: "graphhopper-web-11.1.jar",
  url: "https://github.com/graphhopper/graphhopper/releases/download/11.1/graphhopper-web-11.1.jar",
  sha256: "8462f758d9ea49edaded557cec5c687a0a24f004ec371cd4daaeb0534824ea33",
};

/** Regions an owner can pick, with where their data is on Geofabrik's and GraphHopper's servers. */
export const GEO_REGIONS: Readonly<
  Record<string, { readonly name: string; readonly path: string; readonly gigabytes: number }>
> = {
  no: { name: "Norway", path: "europe/norway", gigabytes: 4 },
  se: { name: "Sweden", path: "europe/sweden", gigabytes: 3 },
  dk: { name: "Denmark", path: "europe/denmark", gigabytes: 2 },
  fi: { name: "Finland", path: "europe/finland", gigabytes: 3 },
  nl: { name: "The Netherlands", path: "europe/netherlands", gigabytes: 5 },
};

const PHOTON_DUMPS = "https://download1.graphhopper.com/public";
const GEOFABRIK = "https://download.geofabrik.de";
/** New data once a month: shops open and close. */
const REFRESH_MS = 30 * 24 * 3_600_000;
const IDLE_MS = 10 * 60_000;
const STARTUP_MS = 3 * 60_000;

/** What owners see of the server's map. */
export type GeoStatus = {
  /** The region picked, by code (`GEO_REGIONS`). */
  readonly region?: string;
  /**
   * `off`: no region; `downloading` and `importing`: getting it ready, `step` says what;
   * `ready`: it answers; `failed`: see `error`, and it tries again at the next start.
   */
  readonly state: "off" | "downloading" | "importing" | "ready" | "failed";
  readonly step?: string;
  /** Of the current download, 0 to 1. */
  readonly progress?: number;
  /** When the data in use was fetched. */
  readonly updatedAt?: number;
  readonly error?: string;
  readonly regions: { code: string; name: string }[];
};

type Saved = {
  region?: string;
  installed?: { region: string; at: number; photon: string; osm: string };
};

export type ServerGeoOptions = {
  /** Where the JRE, jars and data go: `server/geo` beside the config. */
  readonly dir: string;
  readonly say?: (line: string) => void;
};

/** A process of the map's, while it runs. */
type Running = { child: ChildProcess; url: string; usedAt: number };

export class ServerGeo {
  private saved: Saved = {};
  private state: GeoStatus["state"] = "off";
  private step: string | undefined;
  private progress: number | undefined;
  private error: string | undefined;
  private installing: { abort: AbortController; done: Promise<void> } | undefined;
  private readonly running = new Map<"photon" | "graphhopper", Promise<Running>>();
  private readonly timer: NodeJS.Timeout;
  private readonly say: (line: string) => void;
  /** The service extensions use (`provideGeo`). */
  readonly geo: Geo;

  constructor(private readonly options: ServerGeoOptions) {
    this.say = options.say ?? (() => {});
    this.geo = httpGeo({
      photon: () => this.endpoint("photon"),
      graphhopper: () => this.endpoint("graphhopper"),
    });
    this.timer = setInterval(() => this.tick(), 60_000);
    this.timer.unref();
  }

  private get file(): string {
    return join(this.options.dir, "geo.json");
  }

  /** Reads what was picked, and goes on getting it ready where it stopped. */
  async load(): Promise<void> {
    this.saved = JSON.parse(await readFile(this.file, "utf8").catch(() => "{}")) as Saved;
    const { region, installed } = this.saved;
    if (region === undefined) return;
    if (installed?.region === region) this.state = "ready";
    if (installed?.region !== region || this.stale()) this.install(region);
  }

  status(): GeoStatus {
    const { region, installed } = this.saved;
    return {
      ...(region === undefined ? {} : { region }),
      state: this.state,
      ...(this.step === undefined ? {} : { step: this.step }),
      ...(this.progress === undefined ? {} : { progress: this.progress }),
      ...(installed?.region === region && installed !== undefined
        ? { updatedAt: installed.at }
        : {}),
      ...(this.error === undefined ? {} : { error: this.error }),
      regions: Object.entries(GEO_REGIONS).map(([code, { name }]) => ({ code, name })),
    };
  }

  /** Picks the region to get ready, or none, which removes the map and its data. */
  async setRegion(region: string | null): Promise<GeoStatus> {
    if (region !== null && GEO_REGIONS[region] === undefined)
      throw new GeoUnavailable(
        `No region "${region}"; pick one of ${Object.keys(GEO_REGIONS).join(", ")}`,
      );
    if (region === (this.saved.region ?? null) && this.state !== "failed") return this.status();
    await this.cancel();
    await this.stopAll();
    if (region === null) {
      this.saved = {};
      await this.save();
      await rm(join(this.options.dir, "data"), { recursive: true, force: true });
      this.state = "off";
      this.error = undefined;
      return this.status();
    }
    this.saved = { ...this.saved, region };
    await this.save();
    this.install(region);
    return this.status();
  }

  async close(): Promise<void> {
    clearInterval(this.timer);
    await this.cancel();
    await this.stopAll();
  }

  private async save(): Promise<void> {
    await mkdir(this.options.dir, { recursive: true });
    await writeFile(this.file, `${JSON.stringify(this.saved, null, 2)}\n`);
  }

  private stale(): boolean {
    const at = this.saved.installed?.at;
    return at !== undefined && Date.now() - at > REFRESH_MS;
  }

  private tick(): void {
    for (const [name, running] of this.running)
      void running
        .then((process) => {
          if (Date.now() - process.usedAt > IDLE_MS) void this.stop(name);
        })
        .catch(() => {});
    const region = this.saved.region;
    if (
      region !== undefined &&
      this.installing === undefined &&
      this.state === "ready" &&
      this.stale()
    )
      this.install(region);
  }

  private async cancel(): Promise<void> {
    const installing = this.installing;
    if (installing === undefined) return;
    installing.abort.abort();
    await installing.done.catch(() => {});
  }

  /** Gets `region` ready in the background; the data in use, if any, answers meanwhile. */
  private install(region: string): void {
    const abort = new AbortController();
    const refresh = this.saved.installed?.region === region;
    if (!refresh) this.state = "downloading";
    this.error = undefined;
    const done = this.build(region, abort.signal)
      .then(() => {
        this.state = "ready";
        this.say(`The map of ${GEO_REGIONS[region]!.name} is ready.`);
      })
      .catch((error: unknown) => {
        if (abort.signal.aborted) return;
        this.error = (error as Error).message;
        this.say(`The map of ${GEO_REGIONS[region]!.name} failed: ${this.error}`);
        if (!refresh) this.state = "failed";
      })
      .finally(() => {
        this.step = undefined;
        this.progress = undefined;
        if (this.installing?.abort === abort) this.installing = undefined;
      });
    this.installing = { abort, done };
  }

  private async build(region: string, signal: AbortSignal): Promise<void> {
    const dir = this.options.dir;
    const { name, path, gigabytes } = GEO_REGIONS[region]!;
    const work = join(dir, "work");
    await rm(work, { recursive: true, force: true });
    await mkdir(work, { recursive: true });
    const free = await statfs(dir)
      .then((s) => s.bavail * s.bsize)
      .catch(() => Infinity);
    if (free < gigabytes * 1.5 * 2 ** 30)
      throw new Error(
        `The map of ${name} needs about ${Math.ceil(gigabytes * 1.5)} GB free on the disk`,
      );

    const quiet = this.state === "ready";
    const step = (text: string, state: "downloading" | "importing") => {
      this.step = text;
      this.progress = undefined;
      if (!quiet) this.state = state;
    };
    step("Java", "downloading");
    const java = await this.ensureJre(signal);
    step("the map programs", "downloading");
    await this.ensureFile(join(dir, PHOTON.file), PHOTON, signal);
    await this.ensureFile(join(dir, GRAPHHOPPER.file), GRAPHHOPPER, signal);

    const base = path.split("/").at(-1)!;
    const dumpUrl = `${PHOTON_DUMPS}/${path}/photon-dump-${base}-1.0-latest.jsonl.zst`;
    const osmUrl = `${GEOFABRIK}/${path}-latest.osm.pbf`;
    const photonMd5 = await md5Of(`${dumpUrl}.md5`, signal);
    const osmMd5 = await md5Of(`${osmUrl}.md5`, signal);
    const installed = this.saved.installed;
    if (
      installed?.region === region &&
      installed.photon === photonMd5 &&
      installed.osm === osmMd5
    ) {
      // Nothing new since the last time.
      this.saved = { ...this.saved, installed: { ...installed, at: Date.now() } };
      await this.save();
      return;
    }

    step(`addresses of ${name}`, "downloading");
    const dump = join(work, "photon.jsonl.zst");
    await this.download(dumpUrl, dump, { md5: photonMd5 }, signal);
    step(`addresses of ${name}`, "importing");
    const photonData = join(work, "photon");
    await run(
      java,
      [
        `-Xmx${heap(0.4, 2)}m`,
        "-jar",
        join(dir, PHOTON.file),
        "import",
        "-import-file",
        "-",
        "-data-dir",
        photonData,
      ],
      {
        cwd: work,
        signal,
        stdin: (input) => pipeline(createReadStream(dump), createZstdDecompress(), input),
      },
    );
    await rm(dump, { force: true });

    step(`roads of ${name}`, "downloading");
    const pbf = join(work, "region.osm.pbf");
    await this.download(osmUrl, pbf, { md5: osmMd5 }, signal);
    step(`roads of ${name}`, "importing");
    const graph = join(work, "graph");
    const config = join(work, "import.yml");
    await writeFile(
      config,
      graphhopperConfig({ pbf, graph, port: 0, adminPort: 0, store: "RAM_STORE" }),
    );
    await run(
      java,
      [`-Xmx${heap(0.6, 8)}m`, "-jar", join(dir, GRAPHHOPPER.file), "import", config],
      {
        cwd: work,
        signal,
      },
    );
    await rm(pbf, { force: true });

    // Swapped in whole, so the map never reads half of the new data.
    await this.stopAll();
    const target = join(dir, "data", region);
    await rm(join(dir, "data"), { recursive: true, force: true });
    await mkdir(target, { recursive: true });
    await rename(photonData, join(target, "photon"));
    await rename(graph, join(target, "graph"));
    await rm(work, { recursive: true, force: true });
    this.saved = {
      ...this.saved,
      installed: { region, at: Date.now(), photon: photonMd5, osm: osmMd5 },
    };
    await this.save();
  }

  private async ensureJre(signal: AbortSignal): Promise<string> {
    const java = join(this.options.dir, "jre", "bin", "java");
    const pinned = JRE[process.arch];
    if (pinned === undefined)
      throw new Error(`The map needs an x64 or arm64 machine, not ${process.arch}`);
    const marker = join(this.options.dir, "jre", ".sha256");
    if ((await readFile(marker, "utf8").catch(() => "")) === pinned.sha256 && existsSync(java))
      return java;
    const archive = join(this.options.dir, "work", "jre.tar.gz");
    await this.download(pinned.url, archive, { sha256: pinned.sha256 }, signal);
    const jre = join(this.options.dir, "jre");
    await rm(jre, { recursive: true, force: true });
    await mkdir(jre, { recursive: true });
    await run("tar", ["-xzf", archive, "-C", jre, "--strip-components=1"], { signal });
    await writeFile(marker, pinned.sha256);
    await rm(archive, { force: true });
    return java;
  }

  private async ensureFile(path: string, pinned: Pinned, signal: AbortSignal): Promise<void> {
    if (existsSync(path) && (await sha256File(path)) === pinned.sha256) return;
    await this.download(pinned.url, path, { sha256: pinned.sha256 }, signal);
  }

  /** Downloads `url` to `path`, checked against its hash before it takes the name. */
  private async download(
    url: string,
    path: string,
    expected: { sha256?: string; md5?: string },
    signal: AbortSignal,
  ): Promise<void> {
    const response = await fetch(url, { signal });
    if (!response.ok || response.body === null)
      throw new Error(`${url} answered ${response.status}`);
    const total = Number(response.headers.get("content-length") ?? 0);
    const hash = createHash(expected.sha256 !== undefined ? "sha256" : "md5");
    const part = `${path}.part`;
    const out = await open(part, "w");
    let got = 0;
    try {
      for await (const chunk of response.body) {
        hash.update(chunk);
        await out.write(chunk);
        got += chunk.length;
        if (total > 0) this.progress = got / total;
      }
    } finally {
      await out.close();
    }
    if (hash.digest("hex") !== (expected.sha256 ?? expected.md5)) {
      await rm(part, { force: true });
      throw new Error(`${url.split("/").at(-1)} isn't the file it should be`);
    }
    await rename(part, path);
  }

  /** The address of a service, started if it isn't running. */
  private async endpoint(name: "photon" | "graphhopper"): Promise<string> {
    const region = this.saved.installed?.region;
    if (region === undefined)
      throw new GeoUnavailable(
        this.state === "off"
          ? "This server has no map: an owner picks a region under the server's Maps settings"
          : "The map isn't ready yet: it is still downloading",
      );
    let running = this.running.get(name);
    if (running === undefined) {
      running = this.start(name, region);
      this.running.set(name, running);
      running.catch(() => this.running.delete(name));
    }
    const process = await running;
    process.usedAt = Date.now();
    return process.url;
  }

  private async start(name: "photon" | "graphhopper", region: string): Promise<Running> {
    const dir = this.options.dir;
    const data = join(dir, "data", region);
    const java = join(dir, "jre", "bin", "java");
    const port = await freePort();
    let args: string[];
    if (name === "photon") {
      args = [
        `-Xmx${heap(0.15, 1)}m`,
        "-jar",
        join(dir, PHOTON.file),
        "serve",
        "-data-dir",
        join(data, "photon"),
        "-listen-ip",
        "127.0.0.1",
        "-listen-port",
        String(port),
      ];
    } else {
      const config = join(data, "serve.yml");
      await writeFile(
        config,
        graphhopperConfig({
          graph: join(data, "graph"),
          port,
          adminPort: await freePort(),
          store: "MMAP",
        }),
      );
      args = [`-Xmx${heap(0.15, 1)}m`, "-jar", join(dir, GRAPHHOPPER.file), "server", config];
    }
    const child = spawn(java, args, { cwd: data, stdio: ["ignore", "pipe", "pipe"] });
    const tail = keepTail(child);
    const url = `http://127.0.0.1:${port}`;
    const health = name === "photon" ? `${url}/status` : `${url}/health`;
    const deadline = Date.now() + STARTUP_MS;
    while (Date.now() < deadline) {
      if (child.exitCode !== null)
        throw new GeoUnavailable(`The map's ${name} stopped as it started: ${reason(tail())}`);
      const ok = await fetch(health, { signal: AbortSignal.timeout(2_000) })
        .then((r) => r.ok)
        .catch(() => false);
      if (ok) {
        child.once("exit", () => this.running.delete(name));
        return { child, url, usedAt: Date.now() };
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    child.kill();
    throw new GeoUnavailable(`The map's ${name} didn't start in time`);
  }

  private async stop(name: "photon" | "graphhopper"): Promise<void> {
    const running = this.running.get(name);
    this.running.delete(name);
    const process = await running?.catch(() => undefined);
    if (process === undefined || process.child.exitCode !== null) return;
    const exited = new Promise((resolve) => process.child.once("exit", resolve));
    process.child.kill("SIGTERM");
    const timeout = setTimeout(() => process.child.kill("SIGKILL"), 10_000);
    await exited;
    clearTimeout(timeout);
  }

  private async stopAll(): Promise<void> {
    await Promise.all([this.stop("photon"), this.stop("graphhopper")]);
  }
}

/** GraphHopper's config: car, bike and foot, fast to route (CH), logging to its output only. */
export function graphhopperConfig(options: {
  readonly pbf?: string;
  readonly graph: string;
  readonly port: number;
  readonly adminPort: number;
  readonly store: "RAM_STORE" | "MMAP";
}): string {
  const profiles = ["car", "bike", "foot"];
  return [
    "graphhopper:",
    `  datareader.file: ${JSON.stringify(options.pbf ?? "")}`,
    `  graph.location: ${JSON.stringify(options.graph)}`,
    "  profiles:",
    ...profiles.flatMap((name) => [
      `    - name: ${name}`,
      `      custom_model_files: [${name}.json]`,
    ]),
    "  profiles_ch:",
    ...profiles.map((name) => `    - profile: ${name}`),
    "  profiles_lm: []",
    "  graph.encoded_values: car_access, car_average_speed, road_access, road_class, roundabout, country, " +
      "foot_access, foot_priority, foot_average_speed, foot_road_access, hike_rating, mtb_rating, " +
      "bike_access, bike_priority, bike_average_speed, bike_road_access",
    // Every road counts: people walk and cycle as well as drive.
    '  import.osm.ignored_highways: ""',
    "  prepare.min_network_size: 200",
    "  prepare.subnetworks.threads: 1",
    "  routing.snap_preventions_default: tunnel, bridge, ferry",
    "  routing.non_ch.max_waypoint_distance: 1000000",
    `  graph.dataaccess.default_type: ${options.store}`,
    "server:",
    "  application_connectors:",
    "    - type: http",
    `      port: ${options.port}`,
    "      bind_host: 127.0.0.1",
    "  request_log:",
    "    appenders: []",
    "  admin_connectors:",
    "    - type: http",
    `      port: ${options.adminPort}`,
    "      bind_host: 127.0.0.1",
    "logging:",
    "  appenders:",
    "    - type: console",
    "",
  ].join("\n");
}

/** Megabytes of heap: `share` of the machine's memory, at most `maxGb`, at least 512. */
function heap(share: number, maxGb: number): number {
  return Math.max(512, Math.min(maxGb * 1024, Math.floor((totalmem() / 2 ** 20) * share)));
}

async function md5Of(url: string, signal: AbortSignal): Promise<string> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  const md5 = /^[0-9a-f]{32}/i.exec((await response.text()).trim())?.[0];
  if (md5 === undefined) throw new Error(`${url} has no checksum`);
  return md5.toLowerCase();
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address !== null
          ? resolve(address.port)
          : reject(new Error("No port")),
      );
    });
  });
}

/** The last few kilobytes a process wrote, for the error when it fails. */
function keepTail(child: ChildProcess): () => string {
  let tail = "";
  const keep = (chunk: Buffer) => {
    tail = (tail + chunk.toString()).slice(-4000);
  };
  child.stdout?.on("data", keep);
  child.stderr?.on("data", keep);
  return () => tail;
}

/** What went wrong, from a process's output: Java's exception line, or else its last lines. */
export function reason(output: string): string {
  const line = output.split("\n").find((l) => /^\S*(Exception|Error)\b.*:/.test(l.trim()));
  return (line?.trim() ?? output.trim().slice(-600)).slice(0, 600);
}

/** Runs a program to its end; rejects with the end of its output when it fails. */
async function run(
  command: string,
  args: readonly string[],
  options: {
    readonly cwd?: string;
    readonly signal: AbortSignal;
    readonly stdin?: (input: NodeJS.WritableStream) => Promise<void>;
  },
): Promise<void> {
  const child = spawn(command, args, {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    signal: options.signal,
  });
  const tail = keepTail(child);
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code));
  });
  const feeding = options.stdin?.(child.stdin!).catch((error: unknown) => {
    child.kill();
    throw error;
  });
  const [code] = await Promise.all([exited, feeding]);
  if (code !== 0) throw new Error(`${command.split("/").at(-1)} failed: ${reason(tail())}`);
}

/** What is wrong with the map's files, for `nudge doctor`; empty when it is ready or off. */
export async function checkGeo(dir: string): Promise<string[]> {
  const saved = JSON.parse(
    await readFile(join(dir, "geo.json"), "utf8").catch(() => "{}"),
  ) as Saved;
  if (saved.region === undefined) return [];
  const name = GEO_REGIONS[saved.region]?.name ?? saved.region;
  if (saved.installed?.region !== saved.region)
    return [`The map of ${name} isn't ready yet: it downloads while the server runs`];
  const missing = [
    join(dir, "jre", "bin", "java"),
    join(dir, PHOTON.file),
    join(dir, GRAPHHOPPER.file),
    join(dir, "data", saved.region, "photon"),
    join(dir, "data", saved.region, "graph"),
  ].filter((path) => !existsSync(path));
  return missing.map((path) => `The map is missing ${path}; pick its region again to fetch it`);
}
