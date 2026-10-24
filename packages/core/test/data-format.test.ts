import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DATA_FORMAT,
  DataFormatError,
  dataFormatFile,
  recordedDataFormat,
  upgradeDataFormat,
} from "../src/index.ts";

describe("data formats", () => {
  let dir: string;
  const record = async (text: string) => {
    await mkdir(join(dir, "server"), { recursive: true });
    await writeFile(dataFormatFile(dir), text);
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "nudge-format-"));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("records this release's format in a data directory that has none", async () => {
    // Data from before formats were recorded is format 1.
    expect(await recordedDataFormat(dir)).toBe(1);
    await upgradeDataFormat(dir);
    expect(readFileSync(dataFormatFile(dir), "utf8")).toBe(`${DATA_FORMAT}\n`);
  });

  it("refuses data a newer release wrote, and leaves it be", async () => {
    await record("3\n");
    await expect(upgradeDataFormat(dir, { format: 2 })).rejects.toThrow(DataFormatError);
    await expect(upgradeDataFormat(dir, { format: 2 })).rejects.toThrow(/format 3.*reads format 2/);
    expect(readFileSync(dataFormatFile(dir), "utf8")).toBe("3\n");
  });

  it("calls beforeMoving, then records the newer format, only when the data moves", async () => {
    await record("1\n");
    const moves: string[] = [];
    const beforeMoving = async (from: number, to: number) => {
      moves.push(`${from}->${to}`);
      expect(readFileSync(dataFormatFile(dir), "utf8")).toBe("1\n");
    };
    expect(await upgradeDataFormat(dir, { format: 2, beforeMoving })).toBe(1);
    expect(readFileSync(dataFormatFile(dir), "utf8")).toBe("2\n");
    expect(await upgradeDataFormat(dir, { format: 2, beforeMoving })).toBe(2);
    expect(moves).toEqual(["1->2"]);
  });

  it("doesn't move the data when beforeMoving fails, as when the backup can't be made", async () => {
    await record("1\n");
    await expect(
      upgradeDataFormat(dir, {
        format: 2,
        beforeMoving: async () => {
          throw new Error("no room");
        },
      }),
    ).rejects.toThrow("no room");
    expect(await recordedDataFormat(dir)).toBe(1);
  });

  it("refuses a record it can't read", async () => {
    await record("two");
    await expect(recordedDataFormat(dir)).rejects.toThrow(DataFormatError);
  });
});
