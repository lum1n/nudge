import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type BackupRemoteConfig,
  lastRemoteBackupAt,
  RemoteBackups,
  signV4,
} from "../src/index.ts";

const KEYS = { user: "AKIAIOSFODNN7EXAMPLE", secret: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" };
const EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

describe("SigV4", () => {
  // The examples in AWS's "Signature Calculations for the Authorization Header" for S3.
  it("signs AWS's GET Object example", () => {
    const authorization = signV4({
      method: "GET",
      url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
      headers: {
        range: "bytes=0-9",
        "x-amz-content-sha256": EMPTY,
        "x-amz-date": "20130524T000000Z",
      },
      payloadHash: EMPTY,
      credentials: KEYS,
      region: "us-east-1",
      now: new Date("2013-05-24T00:00:00Z"),
    });
    expect(authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, " +
        "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, " +
        "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
  });

  it("signs AWS's list example, with its query sorted", () => {
    const authorization = signV4({
      method: "GET",
      url: new URL("https://examplebucket.s3.amazonaws.com/?prefix=J&max-keys=2"),
      headers: { "x-amz-content-sha256": EMPTY, "x-amz-date": "20130524T000000Z" },
      payloadHash: EMPTY,
      credentials: KEYS,
      region: "us-east-1",
      now: new Date("2013-05-24T00:00:00Z"),
    });
    expect(authorization).toMatch(
      /SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7$/,
    );
  });
});

/** Reads a request's whole body. */
async function bodyOf(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

async function listen(
  handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>,
): Promise<{ server: Server; url: string }> {
  const server = createServer((request, response) => {
    handler(request, response).catch((error: unknown) => {
      response.statusCode = 500;
      response.end(String(error));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

/**
 * An S3 that checks every request's signature with the same keys, keeps objects in memory, and
 * lists two keys a page so continuation is used.
 */
function fakeS3(objects: Map<string, Buffer>, options: { refuse?: boolean } = {}) {
  return async (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url!, `http://${request.headers.host}`);
    const body = await bodyOf(request);
    const hash = createHash("sha256").update(body).digest("hex");
    const date = request.headers["x-amz-date"] as string;
    const expected = signV4({
      method: request.method!,
      url,
      headers: {
        "x-amz-content-sha256": request.headers["x-amz-content-sha256"] as string,
        "x-amz-date": date,
      },
      payloadHash: request.headers["x-amz-content-sha256"] as string,
      credentials: KEYS,
      region: "eu-test-1",
      now: new Date(
        `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${date.slice(9, 11)}:${date.slice(11, 13)}:${date.slice(13, 15)}Z`,
      ),
    });
    if (options.refuse || request.headers.authorization !== expected) {
      response.statusCode = 403;
      response.end(
        "<Error><Code>SignatureDoesNotMatch</Code><Message>The signature is wrong</Message></Error>",
      );
      return;
    }
    if (request.headers["x-amz-content-sha256"] !== hash) {
      response.statusCode = 400;
      response.end("<Error><Message>Content hash mismatch</Message></Error>");
      return;
    }
    const [, bucket, ...rest] = url.pathname.split("/");
    expect(bucket).toBe("vault");
    const key = rest.map(decodeURIComponent).join("/");
    if (request.method === "PUT") {
      objects.set(key, body);
      response.end();
    } else if (request.method === "DELETE") {
      objects.delete(key);
      response.statusCode = 204;
      response.end();
    } else if (request.method === "GET" && url.searchParams.get("list-type") === "2") {
      const prefix = url.searchParams.get("prefix") ?? "";
      const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = Number(url.searchParams.get("continuation-token") ?? 0);
      const page = keys.slice(start, start + 2);
      const more = start + 2 < keys.length;
      response.setHeader("content-type", "application/xml");
      response.end(
        `<?xml version="1.0"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">` +
          page.map((k) => `<Contents><Key>${k}</Key></Contents>`).join("") +
          `<IsTruncated>${more}</IsTruncated>` +
          (more ? `<NextContinuationToken>${start + 2}</NextContinuationToken>` : "") +
          `</ListBucketResult>`,
      );
    } else {
      response.statusCode = 400;
      response.end();
    }
  };
}

/** A WebDAV server over memory, behind basic auth, whose folder is made with MKCOL. */
function fakeWebDav(files: Map<string, Buffer>, folders: Set<string>) {
  const auth = `Basic ${Buffer.from("ann:hunter2").toString("base64")}`;
  return async (request: IncomingMessage, response: ServerResponse) => {
    const body = await bodyOf(request);
    if (request.headers.authorization !== auth) {
      response.statusCode = 401;
      response.end("Unauthorized");
      return;
    }
    const path = decodeURIComponent(new URL(request.url!, "http://dav").pathname);
    const parent = path.slice(0, path.lastIndexOf("/") + 1);
    switch (request.method) {
      case "MKCOL":
        if (folders.has(path)) response.statusCode = 405;
        else {
          folders.add(path);
          response.statusCode = 201;
        }
        break;
      case "PUT":
        if (!folders.has(parent)) response.statusCode = 409;
        else {
          files.set(path, body);
          response.statusCode = 201;
        }
        break;
      case "DELETE":
        response.statusCode = files.delete(path) ? 204 : 404;
        break;
      case "PROPFIND": {
        expect(request.headers.depth).toBe("1");
        if (!folders.has(path)) {
          response.statusCode = 404;
          break;
        }
        const inside = [...files.keys()].filter((f) => f.startsWith(path));
        response.statusCode = 207;
        response.setHeader("content-type", "application/xml");
        response.write(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">`);
        for (const href of [path, ...inside])
          response.write(
            `<d:response><d:href>${encodeURI(href)}</d:href><d:propstat><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`,
          );
        response.write("</d:multistatus>");
        break;
      }
      default:
        response.statusCode = 405;
    }
    response.end();
  };
}

const NAMES = [
  "nudge-20261020T010000Z.nudgebackup",
  "nudge-20261021T010000Z.nudgebackup",
  "nudge-20261022T010000Z.nudgebackup",
  "nudge-20261023T010000Z.nudgebackup",
];

describe("remote backups", () => {
  let dir: string;
  let server: Server | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "nudge-remote-test-"));
    for (const name of NAMES) await writeFile(join(dir, name), `sealed ${name}`);
  });

  afterEach(async () => {
    server?.close();
    server = undefined;
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  });

  it("uploads to S3, signed, and keeps only the newest there", async () => {
    const objects = new Map<string, Buffer>([["nudge/other.txt", Buffer.from("not ours")]]);
    let url: string;
    ({ server, url } = await listen(fakeS3(objects)));
    const remotes = new RemoteBackups(join(dir, "remote"));
    remotes.setCredentials(KEYS);
    const config: BackupRemoteConfig = {
      type: "s3",
      endpoint: url,
      bucket: "vault",
      region: "eu-test-1",
      prefix: "/nudge/",
    };
    for (const name of NAMES) await remotes.upload(config, join(dir, name), 2);
    expect([...objects.keys()].sort()).toEqual([
      "nudge/nudge-20261022T010000Z.nudgebackup",
      "nudge/nudge-20261023T010000Z.nudgebackup",
      "nudge/other.txt",
    ]);
    expect(objects.get(`nudge/${NAMES[3]}`)!.toString()).toBe(`sealed ${NAMES[3]}`);
    const remote = remotes.open(config);
    expect(remote.label).toBe("s3://vault/nudge/");
    expect(await lastRemoteBackupAt(remote)).toEqual(new Date("2026-10-23T01:00:00Z"));
    expect(remotes.state()).toMatchObject({ lastFile: NAMES[3] });
    // What it keeps survives a new process, the credentials sealed on disk.
    const again = new RemoteBackups(join(dir, "remote"));
    expect(again.credentials()).toEqual({ ...KEYS, from: "server" });
    expect(again.state().lastUploadAt).toBeGreaterThan(0);
    expect(await readFile(join(dir, "remote", "secrets.enc"), "utf8")).not.toContain(KEYS.secret);
    await again.check(config);
    expect(objects.has("nudge/nudge-check.txt")).toBe(false);
  });

  it("lists across pages", async () => {
    const objects = new Map(NAMES.map((name) => [name, Buffer.from("x")]));
    let url: string;
    ({ server, url } = await listen(fakeS3(objects)));
    const remotes = new RemoteBackups(undefined);
    const remote = remotes.open(
      { type: "s3", endpoint: url, bucket: "vault", region: "eu-test-1" },
      KEYS,
    );
    expect(await remote.list()).toEqual(NAMES);
  });

  it("reports a refused upload and records it", async () => {
    let url: string;
    ({ server, url } = await listen(fakeS3(new Map(), { refuse: true })));
    const remotes = new RemoteBackups(join(dir, "remote"));
    remotes.setCredentials(KEYS);
    const config: BackupRemoteConfig = {
      type: "s3",
      endpoint: url,
      bucket: "vault",
      region: "eu-test-1",
    };
    await expect(remotes.upload(config, join(dir, NAMES[0]!), 2)).rejects.toThrow(
      /Upload to s3:\/\/vault\/ failed: PUT \/vault\/nudge-20261020T010000Z.nudgebackup: 403 The signature is wrong/,
    );
    expect(remotes.state()).toMatchObject({ lastError: expect.stringContaining("403") });
    await expect(remotes.check(config)).rejects.toThrow(/403/);
  });

  it("refuses an S3 target without keys, and takes keys from the environment", async () => {
    const remotes = new RemoteBackups(undefined);
    const config: BackupRemoteConfig = { type: "s3", endpoint: "http://x", bucket: "b" };
    expect(() => remotes.open(config)).toThrow(/no access key/);
    vi.stubEnv("NUDGE_BACKUP_REMOTE_USER", "id");
    vi.stubEnv("NUDGE_BACKUP_REMOTE_SECRET", "secret");
    expect(remotes.credentials()).toEqual({ user: "id", secret: "secret", from: "env" });
  });

  it("uploads to WebDAV, making the folder, and keeps only the newest there", async () => {
    const files = new Map<string, Buffer>();
    const folders = new Set<string>(["/dav/"]);
    let url: string;
    ({ server, url } = await listen(fakeWebDav(files, folders)));
    const remotes = new RemoteBackups(undefined);
    remotes.setCredentials({ user: "ann", secret: "hunter2" });
    const config: BackupRemoteConfig = { type: "webdav", url: `${url}/dav/nudge backups` };
    expect(await remotes.open(config).list()).toEqual([]);
    for (const name of NAMES) await remotes.upload(config, join(dir, name), 3);
    expect(folders.has("/dav/nudge backups/")).toBe(true);
    expect([...files.keys()].sort()).toEqual(NAMES.slice(1).map((n) => `/dav/nudge backups/${n}`));
    expect(await remotes.open(config).list()).toEqual(NAMES.slice(1));
    await remotes.check(config);
  });

  it("reports a WebDAV refusal", async () => {
    let url: string;
    ({ server, url } = await listen(fakeWebDav(new Map(), new Set(["/dav/"]))));
    const remotes = new RemoteBackups(undefined);
    remotes.setCredentials({ user: "ann", secret: "wrong" });
    await expect(
      remotes.upload({ type: "webdav", url: `${url}/dav/` }, join(dir, NAMES[0]!), 3),
    ).rejects.toThrow(/PUT \/dav\/nudge-20261020T010000Z.nudgebackup: 401 Unauthorized/);
  });
});
