import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * What approvals ask to do, by room and approval id. An approval's payload is stored with
 * placeholders (ADR 9), which can change a path or a machine's name on its way back, as ADR 12
 * found; so the payload stays empty and the request is kept here.
 */
export class Asked<T> {
  private entries: Record<string, T> | undefined;

  /** `file` keeps them across restarts; in memory only when absent. */
  constructor(private readonly file: string | undefined) {}

  set(roomId: string, approvalId: string, value: T): void {
    this.save({ ...this.load(), [`${roomId}/${approvalId}`]: value });
  }

  /** The request, forgotten once taken. */
  take(roomId: string, approvalId: string): T | undefined {
    const { [`${roomId}/${approvalId}`]: value, ...rest } = this.load();
    if (value !== undefined) this.save(rest);
    return value;
  }

  private load(): Record<string, T> {
    if (this.entries !== undefined) return this.entries;
    try {
      this.entries =
        this.file === undefined
          ? {}
          : (JSON.parse(readFileSync(this.file, "utf8")) as Record<string, T>);
    } catch {
      this.entries = {};
    }
    return this.entries;
  }

  private save(entries: Record<string, T>): void {
    this.entries = entries;
    if (this.file === undefined) return;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, `${JSON.stringify(entries, null, 2)}\n`);
  }
}
