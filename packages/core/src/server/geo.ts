import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  statfs,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { totalmem } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Readable, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createZstdCompress, createZstdDecompress } from "node:zlib";
import type { Geo, GeoCoverage, GeoPoint } from "../geo/geo.ts";
import { GeoUnavailable } from "../geo/geo.ts";
import { httpGeo } from "../geo/http.ts";
import {
  contains,
  dumpUrl,
  GEOFABRIK_INDEX,
  type GeoRegion,
  parseGeofabrik,
  placeRegions,
  regionFor,
  sourcesFor,
} from "./geo-catalog.ts";

/**
 * The map a server runs for itself (ADR 17): Photon for addresses and places, GraphHopper for
 * routes, both Java, on a JRE of their own. It holds the regions owners pick, and the regions
 * people's phones say they are in, anywhere in the world, within a disk limit. Nothing about where
 * people are or go leaves the machine; only the regions' data comes in.
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

/** New data once a month: shops open and close. */
const REFRESH_MS = 30 * 24 * 3_600_000;
const IDLE_MS = 10 * 60_000;
const STARTUP_MS = 3 * 60_000;
/** A region that follows someone is at most this big, so a trip takes minutes, not hours. */
const FOLLOW_MAX_BYTES = 1.5 * 2 ** 30;
/** How long a failed region waits before it is tried again. */
const RETRY_MS = 6 * 3_600_000;
/** How often a region in use has that written down. */
const USED_EVERY_MS = 3_600_000;

/** One region of the map, as owners see it. */
export type GeoRegionStatus = {
  readonly id: string;
  readonly name: string;
  /** Picked by an owner, or fetched because someone was there; only the latter are dropped. */
  readonly by: "owner" | "follow";
  readonly state: "waiting" | "downloading" | "importing" | "ready" | "failed";
  readonly step?: string;
  /** Of the current download, 0 to 1. */
  readonly progress?: number;
  readonly bytes?: number;
  /** When its data was fetched. */
  readonly updatedAt?: number;
  /** When someone was last there, for regions that followed someone. */
  readonly usedAt?: number;
  readonly error?: string;
};

/** What owners see of the server's map. */
export type GeoStatus = {
  /** `off`: no regions; `working`: getting one ready; `ready`; `failed`: see the regions. */
  readonly state: "off" | "working" | "ready" | "failed";
  /** Whether it fetches the region someone's phone says they are in. */
  readonly follow: boolean;
  readonly limitGb: number;
  readonly usedBytes: number;
  readonly regions: GeoRegionStatus[];
  readonly error?: string;
};

type SavedRegion = {
  by: "owner" | "follow";
  addedAt: number;
  usedAt?: number;
  installed?: { at: number; photon: Record<string, string>; osm: string; bytes: number };
  failedAt?: number;
  error?: string;
};

type Saved = {
  follow?: boolean;
  limitGb?: number;
  regions?: Record<string, SavedRegion>;
  /** The regions the address database holds. */
  photon?: string[];
};

export type ServerGeoOptions = {
  /** Where the JRE, jars and data go: `server/geo` beside the config. */
  readonly dir: string;
  readonly say?: (line: string) => void;
  /** False to only keep the list of what it should hold, as in tests. Default true. */
  readonly download?: boolean;
};

/** A process of the map's, while it runs. */
type Running = { child: ChildProcess; url: string; usedAt: number };

type Activity = { step: string; state: "downloading" | "importing"; progress?: number };

/** Where a region's files go: `us/california` → `regions/us__california`. */
function folder(id: string): string {
  return id.replace(/\//g, "__");
}

export class ServerGeo {
  private saved: Saved = {};
  private catalog: GeoRegion[] | undefined;
  private loadingCatalog: Promise<GeoRegion[]> | undefined;
  private readonly sizes = new Map<string, Promise<number | undefined>>();
  /** What the work in progress is doing, by region. */
  private readonly activity = new Map<string, Activity>();
  private working: Promise<void> | undefined;
  private again = false;
  private readonly abort = new AbortController();
  private readonly running = new Map<string, Promise<Running>>();
  private readonly timer: NodeJS.Timeout;
  private readonly say: (line: string) => void;
  private error: string | undefined;
  private usedBytes = 0;
  /** The service extensions use (`provideGeo`). */
  readonly geo: Geo;

  constructor(private readonly options: ServerGeoOptions) {
    this.say = options.say ?? (() => {});
    const http = httpGeo({
      photon: () => this.photon(),
      graphhopper: (from, to) => this.graphhopper(from, to),
    });
    this.geo = { ...http, follow: (point) => this.follow(point) };
    this.timer = setInterval(() => this.tick(), 60_000);
    this.timer.unref();
  }

  private get dir(): string {
    return this.options.dir;
  }

  private get regions(): Record<string, SavedRegion> {
    this.saved.regions ??= {};
    return this.saved.regions;
  }

  /** Reads what the map holds, and goes on with what it hadn't finished. */
  async load(): Promise<void> {
    this.saved = JSON.parse(
      await readFile(join(this.dir, "geo.json"), "utf8").catch(() => "{}"),
    ) as Saved;
    this.usedBytes = await sizeOf(join(this.dir, "regions"));
    if (Object.keys(this.regions).length > 0) this.kick();
  }

  status(): GeoStatus {
    const regions = Object.entries(this.regions).map(([id, saved]): GeoRegionStatus => {
      const doing = this.activity.get(id);
      const state =
        doing?.state ?? (saved.installed ? "ready" : saved.error ? "failed" : "waiting");
      return {
        id,
        name: this.catalog?.find((r) => r.id === id)?.name ?? id,
        by: saved.by,
        state,
        ...(doing === undefined ? {} : { step: doing.step }),
        ...(doing?.progress === undefined ? {} : { progress: doing.progress }),
        ...(saved.installed === undefined
          ? {}
          : { bytes: saved.installed.bytes, updatedAt: saved.installed.at }),
        ...(saved.usedAt === undefined ? {} : { usedAt: saved.usedAt }),
        ...(saved.error === undefined ? {} : { error: saved.error }),
      };
    });
    const state: GeoStatus["state"] =
      regions.length === 0
        ? "off"
        : this.working !== undefined || regions.some((r) => r.state === "waiting")
          ? "working"
          : regions.some((r) => r.state === "ready")
            ? "ready"
            : "failed";
    return {
      state,
      follow: this.saved.follow ?? true,
      limitGb: this.saved.limitGb ?? 20,
      usedBytes: this.usedBytes,
      regions,
      ...(this.error === undefined ? {} : { error: this.error }),
    };
  }

  /** Every region the map can hold, for owners to pick from. */
  async available(): Promise<{ id: string; name: string; parent?: string }[]> {
    return (await this.loadCatalog()).map(({ id, name, parent }) => ({
      id,
      name,
      ...(parent === undefined ? {} : { parent }),
    }));
  }

  /**
   * Changes what the map holds: `regions` are the ones owners want, which it keeps; the ones they
   * picked before and no longer list go. `follow` and `limitGb` change when given.
   */
  async configure(change: {
    readonly regions?: readonly string[];
    readonly follow?: boolean;
    readonly limitGb?: number;
  }): Promise<GeoStatus> {
    if (change.regions !== undefined) {
      const catalog = await this.loadCatalog();
      for (const id of change.regions)
        if (!catalog.some((r) => r.id === id)) throw new GeoUnavailable(`No region "${id}"`);
      const wanted = new Set(change.regions);
      for (const [id, saved] of Object.entries(this.regions))
        if (saved.by === "owner" && !wanted.has(id)) delete this.regions[id];
      for (const id of wanted) {
        const saved = this.regions[id];
        if (saved === undefined) this.regions[id] = { by: "owner", addedAt: Date.now() };
        else {
          saved.by = "owner";
          // Picked again after it failed: try again now.
          delete saved.failedAt;
        }
      }
    }
    if (change.follow !== undefined) this.saved.follow = change.follow;
    if (change.limitGb !== undefined) {
      if (!(change.limitGb >= 1)) throw new GeoUnavailable("The limit is 1 GB or more");
      this.saved.limitGb = change.limitGb;
    }
    await this.save();
    this.kick();
    return this.status();
  }

  async close(): Promise<void> {
    clearInterval(this.timer);
    this.abort.abort();
    await this.working?.catch(() => {});
    await this.stopAll();
  }

  /**
   * Someone is at `point`: whether the map has it, and when it follows people, fetches the
   * region it is in if not.
   */
  async follow(point: GeoPoint): Promise<GeoCoverage> {
    const catalog = await this.loadCatalog().catch(() => undefined);
    if (catalog === undefined) return "outside";
    const now = Date.now();
    for (const [id, saved] of Object.entries(this.regions)) {
      const region = catalog.find((r) => r.id === id);
      if (region === undefined || !contains(region, point)) continue;
      if (saved.by === "follow" && now - (saved.usedAt ?? 0) > USED_EVERY_MS) {
        saved.usedAt = now;
        await this.save();
      }
      if (saved.installed !== undefined) return "ready";
      return saved.failedAt === undefined ? "fetching" : "outside";
    }
    if (!(this.saved.follow ?? true)) return "outside";
    const region = await regionFor(catalog, point, (r) => this.sizeOf(r), FOLLOW_MAX_BYTES);
    if (region === undefined || sourcesFor(region).length === 0) return "outside";
    this.regions[region.id] = { by: "follow", addedAt: now, usedAt: now };
    await this.save();
    this.say(`The map fetches ${region.name}: someone is there.`);
    this.kick();
    return "fetching";
  }

  private async save(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(join(this.dir, "geo.json"), `${JSON.stringify(this.saved, null, 2)}\n`);
  }

  /** Geofabrik's regions, with their outlines; fetched once a month and kept. */
  private loadCatalog(): Promise<GeoRegion[]> {
    if (this.catalog !== undefined) return Promise.resolve(this.catalog);
    this.loadingCatalog ??= (async () => {
      const file = join(this.dir, "regions.json");
      const kept = await stat(file).catch(() => undefined);
      let text: string | undefined;
      if (kept !== undefined && Date.now() - kept.mtimeMs < REFRESH_MS)
        text = await readFile(file, "utf8");
      if (text === undefined) {
        const response = await fetch(GEOFABRIK_INDEX, {
          signal: AbortSignal.timeout(120_000),
        }).catch(() => undefined);
        if (response?.ok) {
          text = await response.text();
          await mkdir(this.dir, { recursive: true });
          await writeFile(file, text);
        } else if (kept !== undefined) text = await readFile(file, "utf8");
        else throw new GeoUnavailable("The list of the world's regions couldn't be fetched");
      }
      this.catalog = parseGeofabrik(JSON.parse(text));
      return this.catalog;
    })().finally(() => {
      this.loadingCatalog = undefined;
    });
    return this.loadingCatalog;
  }

  /** Bytes of a region's roads, from its server. */
  private sizeOf(region: GeoRegion): Promise<number | undefined> {
    let size = this.sizes.get(region.id);
    if (size === undefined) {
      size = fetch(region.pbf, { method: "HEAD", signal: AbortSignal.timeout(15_000) })
        .then((r) => (r.ok ? Number(r.headers.get("content-length")) || undefined : undefined))
        .catch(() => undefined);
      this.sizes.set(region.id, size);
    }
    return size;
  }

  private tick(): void {
    for (const [name, running] of this.running)
      void running
        .then((process) => {
          if (Date.now() - process.usedAt > IDLE_MS) void this.stop(name);
        })
        .catch(() => {});
    if (Object.values(this.regions).some((saved) => this.due(saved))) this.kick();
  }

  /** Whether a region needs fetching: new, a month old, or failed long enough ago. */
  private due(saved: SavedRegion): boolean {
    const now = Date.now();
    if (saved.failedAt !== undefined) return now - saved.failedAt > RETRY_MS;
    return saved.installed === undefined || now - saved.installed.at > REFRESH_MS;
  }

  /** Starts the work, or has it look again once it is done. */
  private kick(): void {
    if (this.options.download === false) return;
    if (this.working !== undefined) {
      this.again = true;
      return;
    }
    this.working = (async () => {
      do {
        this.again = false;
        await this.work().catch((error: unknown) => {
          if (this.abort.signal.aborted) return;
          this.error = (error as Error).message;
          this.say(`The map: ${this.error}`);
        });
      } while (this.again && !this.abort.signal.aborted);
    })().finally(() => {
      this.working = undefined;
    });
  }

  private async work(): Promise<void> {
    const signal = this.abort.signal;
    const catalog = await this.loadCatalog();
    this.error = undefined;
    // Regions no longer wanted go first, and their space with them.
    const listed = new Set(Object.keys(this.regions).map(folder));
    for (const name of await readdir(join(this.dir, "regions")).catch(() => [] as string[]))
      if (!listed.has(name)) {
        await this.stop(`graphhopper:${name}`);
        await rm(join(this.dir, "regions", name), { recursive: true, force: true });
      }
    const due = Object.entries(this.regions)
      .filter(([, saved]) => this.due(saved))
      .map(([id]) => catalog.find((r) => r.id === id))
      .filter((region): region is GeoRegion => region !== undefined);
    if (due.length > 0) {
      const java = await this.ensureSoftware(due[0]!.id, signal);
      await this.makeRoom(catalog, due);
      // Regions with the same addresses' dump come out of one download, as a trip through
      // several American states does.
      const bySource = new Map<string, GeoRegion[]>();
      for (const region of due) {
        const saved = this.regions[region.id];
        if (saved === undefined || (saved.failedAt !== undefined && !this.due(saved))) continue;
        const source = sourcesFor(region)[0]?.path ?? "";
        bySource.set(source, [...(bySource.get(source) ?? []), region]);
      }
      for (const group of bySource.values()) {
        try {
          await this.fetchRegions(group, java, signal);
        } catch (error) {
          if (signal.aborted) throw error;
          for (const region of group) {
            const saved = this.regions[region.id];
            if (saved === undefined) continue;
            saved.failedAt = Date.now();
            saved.error = (error as Error).message;
            this.say(`The map of ${region.name} failed: ${saved.error}`);
          }
          await this.save();
        } finally {
          for (const region of group) this.activity.delete(region.id);
        }
      }
    }
    const installed = Object.entries(this.regions)
      .filter(([, saved]) => saved.installed !== undefined)
      .map(([id]) => id)
      .sort();
    if (installed.join() !== (this.saved.photon ?? []).join())
      await this.buildPhoton(installed, signal);
    this.usedBytes = await sizeOf(join(this.dir, "regions"));
  }

  /**
   * Drops regions that followed someone, the longest unused first, until those `due` fit the
   * limit. Owners' regions stay; a region bigger than the limit by itself fails.
   */
  private async makeRoom(catalog: readonly GeoRegion[], due: readonly GeoRegion[]): Promise<void> {
    const limit = (this.saved.limitGb ?? 20) * 2 ** 30;
    let needed = 0;
    for (const region of due) {
      // The roads' graph and the addresses take about twice the download.
      const bytes = ((await this.sizeOf(region)) ?? 0) * 2;
      if (bytes > limit) {
        const saved = this.regions[region.id]!;
        saved.failedAt = Date.now();
        saved.error = `It needs about ${Math.ceil(bytes / 2 ** 30)} GB, more than the map's limit of ${limit / 2 ** 30} GB`;
      } else if (this.regions[region.id]?.installed === undefined) needed += bytes;
    }
    const dropping = Object.entries(this.regions)
      .filter(
        ([id, saved]) =>
          saved.by === "follow" && saved.installed !== undefined && !due.some((r) => r.id === id),
      )
      .sort(([, a], [, b]) => (a.usedAt ?? 0) - (b.usedAt ?? 0));
    let used = await sizeOf(join(this.dir, "regions"));
    while (used + needed > limit && dropping.length > 0) {
      const [id, saved] = dropping.shift()!;
      used -= saved.installed!.bytes;
      delete this.regions[id];
      await this.stop(`graphhopper:${folder(id)}`);
      await rm(join(this.dir, "regions", folder(id)), { recursive: true, force: true });
      this.say(`The map dropped ${catalog.find((r) => r.id === id)?.name ?? id} to make room.`);
    }
    const free = await statfs(this.dir)
      .then((s) => s.bavail * s.bsize)
      .catch(() => Infinity);
    await this.save();
    if (needed * 1.5 > free)
      throw new Error(
        `The map needs about ${Math.ceil((needed * 1.5) / 2 ** 30)} GB free on the disk`,
      );
  }

  /** The JRE and both jars, downloaded and checked once. */
  private async ensureSoftware(first: string, signal: AbortSignal): Promise<string> {
    const show = (step: string) => this.activity.set(first, { step, state: "downloading" });
    await mkdir(join(this.dir, "work"), { recursive: true });
    show("Java");
    const java = await this.ensureJre(signal, first);
    show("the map programs");
    await this.ensureFile(join(this.dir, PHOTON.file), PHOTON, signal, first);
    await this.ensureFile(join(this.dir, GRAPHHOPPER.file), GRAPHHOPPER, signal, first);
    this.activity.delete(first);
    return java;
  }

  /**
   * Gets regions that share an addresses' dump ready: their places, cut from the dump to their
   * outlines, and each one's roads. Each region's files are swapped in whole when done.
   */
  private async fetchRegions(
    group: readonly GeoRegion[],
    java: string,
    signal: AbortSignal,
  ): Promise<void> {
    const work = join(this.dir, "work");
    await rm(work, { recursive: true, force: true });
    await mkdir(work, { recursive: true });
    const show = (region: GeoRegion, activity: Activity) => this.activity.set(region.id, activity);
    const progress = (got: number, total: number) => {
      for (const region of group) {
        const doing = this.activity.get(region.id);
        if (doing !== undefined && total > 0) doing.progress = got / total;
      }
    };

    // Addresses: one pass through each dump the regions' countries are in.
    const sources = [...new Map(group.flatMap(sourcesFor).map((s) => [s.path, s])).values()];
    const md5s: Record<string, string> = {};
    const outputs = new Map(
      group.map((region) => {
        const compress = createZstdCompress();
        const file = createWriteStream(join(work, `${folder(region.id)}.places.jsonl.zst`));
        return [region.id, { compress, done: pipeline(compress, file) }] as const;
      }),
    );
    const headerFile = join(this.dir, "photon-header.jsonl");
    for (const source of sources) {
      const url = dumpUrl(source);
      md5s[source.path] = await md5Of(`${url}.md5`, signal);
      for (const region of group)
        show(region, {
          step: `addresses of ${group.length === 1 ? region.name : "the area"}`,
          state: "downloading",
          progress: 0,
        });
      const response = await fetch(url, { signal });
      if (!response.ok || response.body === null)
        throw new Error(`${url} answered ${response.status}`);
      const total = Number(response.headers.get("content-length") ?? source.bytes);
      const hash = createHash("md5");
      let got = 0;
      const body = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
      body.on("data", (chunk: Buffer) => {
        hash.update(chunk);
        got += chunk.length;
        progress(got, total);
      });
      const lines = createInterface({
        input: body.pipe(createZstdDecompress()),
        crlfDelay: Infinity,
      });
      const keepHeader = !existsSync(headerFile);
      const headers: string[] = [];
      let header = 0;
      for await (const line of lines) {
        if (header < 2 && /"type":"(NominatimDumpFile|CountryInfo)"/.test(line)) {
          header++;
          if (keepHeader) headers.push(line);
          continue;
        }
        for (const id of placeRegions(line, group)) {
          const out = outputs.get(id)!.compress;
          if (!out.write(`${line}\n`)) await new Promise((resolve) => out.once("drain", resolve));
        }
      }
      if (hash.digest("hex") !== md5s[source.path])
        throw new Error(`${url.split("/").at(-1)} isn't the file it should be`);
      if (keepHeader && headers.length > 0) await writeFile(headerFile, `${headers.join("\n")}\n`);
    }
    for (const { compress, done } of outputs.values()) {
      compress.end();
      await done;
    }

    // Roads: each region's own extract and graph.
    for (const region of group) {
      show(region, { step: `roads of ${region.name}`, state: "downloading", progress: 0 });
      const osmMd5 = await md5Of(`${region.pbf}.md5`, signal);
      const pbf = join(work, "region.osm.pbf");
      await this.download(region.pbf, pbf, { md5: osmMd5 }, signal, region.id);
      show(region, { step: `roads of ${region.name}`, state: "importing" });
      const graph = join(work, `${folder(region.id)}.graph`);
      const config = join(work, "import.yml");
      await writeFile(
        config,
        graphhopperConfig({ pbf, graph, port: 0, adminPort: 0, store: "RAM_STORE" }),
      );
      await run(
        java,
        [`-Xmx${heap(0.6, 8)}m`, "-jar", join(this.dir, GRAPHHOPPER.file), "import", config],
        { cwd: work, signal },
      );
      await rm(pbf, { force: true });

      const target = join(this.dir, "regions", folder(region.id));
      await this.stop(`graphhopper:${folder(region.id)}`);
      await rm(target, { recursive: true, force: true });
      await mkdir(target, { recursive: true });
      await rename(
        join(work, `${folder(region.id)}.places.jsonl.zst`),
        join(target, "places.jsonl.zst"),
      );
      await rename(graph, join(target, "graph"));
      const saved = this.regions[region.id];
      if (saved === undefined) continue;
      delete saved.failedAt;
      delete saved.error;
      saved.installed = { at: Date.now(), photon: md5s, osm: osmMd5, bytes: await sizeOf(target) };
      // Built again with this region's addresses.
      this.saved.photon = (this.saved.photon ?? []).filter((id) => id !== region.id);
      await this.save();
      this.say(`The map of ${region.name} is ready.`);
    }
  }

  /** One address database for every region: their places, imported together. */
  private async buildPhoton(regions: readonly string[], signal: AbortSignal): Promise<void> {
    const work = join(this.dir, "work");
    await mkdir(work, { recursive: true });
    const next = join(work, "photon");
    await rm(next, { recursive: true, force: true });
    if (regions.length > 0) {
      for (const id of regions) this.activity.set(id, { step: "addresses", state: "importing" });
      const java = join(this.dir, "jre", "bin", "java");
      const header = join(this.dir, "photon-header.jsonl");
      const files = regions.map((id) => join(this.dir, "regions", folder(id), "places.jsonl.zst"));
      try {
        await run(
          java,
          [
            `-Xmx${heap(0.4, 4)}m`,
            "-jar",
            join(this.dir, PHOTON.file),
            "import",
            "-import-file",
            "-",
            "-data-dir",
            next,
          ],
          {
            cwd: work,
            signal,
            stdin: async (input) => {
              await pipeline(createReadStream(header), input, { end: false });
              for (const file of files)
                await pipeline(createReadStream(file), createZstdDecompress(), input, {
                  end: false,
                });
              input.end();
            },
          },
        );
      } finally {
        for (const id of regions) this.activity.delete(id);
      }
    }
    await this.stop("photon");
    await rm(join(this.dir, "photon"), { recursive: true, force: true });
    if (regions.length > 0) await rename(next, join(this.dir, "photon"));
    this.saved.photon = [...regions];
    await this.save();
  }

  private async ensureJre(signal: AbortSignal, region: string): Promise<string> {
    const java = join(this.dir, "jre", "bin", "java");
    const pinned = JRE[process.arch];
    if (pinned === undefined)
      throw new Error(`The map needs an x64 or arm64 machine, not ${process.arch}`);
    const marker = join(this.dir, "jre", ".sha256");
    if ((await readFile(marker, "utf8").catch(() => "")) === pinned.sha256 && existsSync(java))
      return java;
    const archive = join(this.dir, "work", "jre.tar.gz");
    await this.download(pinned.url, archive, { sha256: pinned.sha256 }, signal, region);
    const jre = join(this.dir, "jre");
    await rm(jre, { recursive: true, force: true });
    await mkdir(jre, { recursive: true });
    await run("tar", ["-xzf", archive, "-C", jre, "--strip-components=1"], { signal });
    await writeFile(marker, pinned.sha256);
    await rm(archive, { force: true });
    return java;
  }

  private async ensureFile(
    path: string,
    pinned: Pinned,
    signal: AbortSignal,
    region: string,
  ): Promise<void> {
    if (existsSync(path) && (await sha256File(path)) === pinned.sha256) return;
    await this.download(pinned.url, path, { sha256: pinned.sha256 }, signal, region);
  }

  /** Downloads `url` to `path`, checked against its hash before it takes the name. */
  private async download(
    url: string,
    path: string,
    expected: { sha256?: string; md5?: string },
    signal: AbortSignal,
    region: string,
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
        const doing = this.activity.get(region);
        if (doing !== undefined && total > 0) doing.progress = got / total;
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

  /** Photon's address, started if it isn't running. */
  private photon(): Promise<string> {
    if ((this.saved.photon ?? []).length === 0)
      return Promise.reject(
        new GeoUnavailable(
          Object.keys(this.regions).length === 0
            ? "The map has no regions yet: it fetches where people are as their phones say, or an owner picks regions under the server's Maps settings"
            : "The map isn't ready yet: it is still downloading",
        ),
      );
    return this.use("photon", () => this.start("photon"));
  }

  /** The GraphHopper of the smallest region that holds both points. */
  private async graphhopper(from: GeoPoint, to: GeoPoint): Promise<string> {
    const catalog = await this.loadCatalog();
    const region = Object.entries(this.regions)
      .filter(([, saved]) => saved.installed !== undefined)
      .map(([id]) => catalog.find((r) => r.id === id))
      .filter((r): r is GeoRegion => r !== undefined && contains(r, from) && contains(r, to))
      .sort((a, b) => area(a) - area(b))[0];
    if (region === undefined)
      throw new GeoUnavailable(
        "The map has no roads joining those places yet: it holds the roads of a region at a time, and fetches the region people are in",
      );
    const name = `graphhopper:${folder(region.id)}`;
    return this.use(name, () => this.start(name, region.id));
  }

  private async use(name: string, start: () => Promise<Running>): Promise<string> {
    let running = this.running.get(name);
    if (running === undefined) {
      running = start();
      this.running.set(name, running);
      running.catch(() => this.running.delete(name));
    }
    const process = await running;
    process.usedAt = Date.now();
    return process.url;
  }

  private async start(name: string, region?: string): Promise<Running> {
    const java = join(this.dir, "jre", "bin", "java");
    const port = await freePort();
    let args: string[];
    let cwd: string;
    if (region === undefined) {
      cwd = this.dir;
      args = [
        `-Xmx${heap(0.15, 2)}m`,
        "-jar",
        join(this.dir, PHOTON.file),
        "serve",
        "-data-dir",
        join(this.dir, "photon"),
        "-listen-ip",
        "127.0.0.1",
        "-listen-port",
        String(port),
      ];
    } else {
      cwd = join(this.dir, "regions", folder(region));
      const config = join(cwd, "serve.yml");
      await writeFile(
        config,
        graphhopperConfig({
          graph: join(cwd, "graph"),
          port,
          adminPort: await freePort(),
          store: "MMAP",
        }),
      );
      args = [`-Xmx${heap(0.1, 1)}m`, "-jar", join(this.dir, GRAPHHOPPER.file), "server", config];
    }
    const child = spawn(java, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const tail = keepTail(child);
    const url = `http://127.0.0.1:${port}`;
    const health = region === undefined ? `${url}/status` : `${url}/health`;
    const what = region === undefined ? "address search" : "router";
    const deadline = Date.now() + STARTUP_MS;
    while (Date.now() < deadline) {
      if (child.exitCode !== null)
        throw new GeoUnavailable(`The map's ${what} stopped as it started: ${reason(tail())}`);
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
    throw new GeoUnavailable(`The map's ${what} didn't start in time`);
  }

  private async stop(name: string): Promise<void> {
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
    await Promise.all([...this.running.keys()].map((name) => this.stop(name)));
  }
}

/** How big a region's box is, to prefer a state's roads over a country's. */
function area(region: GeoRegion): number {
  const [west, south, east, north] = region.bbox;
  return (east - west) * (north - south);
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

/** Bytes the files under `path` take; 0 when it isn't there. */
async function sizeOf(path: string): Promise<number> {
  const stats = await stat(path).catch(() => undefined);
  if (stats === undefined) return 0;
  if (!stats.isDirectory()) return stats.size;
  let total = 0;
  for (const entry of await readdir(path)) total += await sizeOf(join(path, entry));
  return total;
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
    readonly stdin?: (input: Writable) => Promise<void>;
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

/** What is wrong with the map's files, for `nudge doctor`; empty when it is fine or off. */
export async function checkGeo(dir: string): Promise<string[]> {
  const saved = JSON.parse(
    await readFile(join(dir, "geo.json"), "utf8").catch(() => "{}"),
  ) as Saved;
  const regions = Object.entries(saved.regions ?? {});
  const problems: string[] = [];
  for (const [id, region] of regions) {
    if (region.error !== undefined) problems.push(`The map of ${id} failed: ${region.error}`);
    else if (region.installed === undefined)
      problems.push(`The map of ${id} isn't ready yet: it downloads while the server runs`);
    else if (!existsSync(join(dir, "regions", folder(id), "graph")))
      problems.push(`The map is missing the roads of ${id}; pick the region again to fetch them`);
  }
  if (regions.some(([, r]) => r.installed) && !existsSync(join(dir, "jre", "bin", "java")))
    problems.push("The map is missing its Java; pick a region again to fetch it");
  return problems;
}
