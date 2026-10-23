// Gives the corpus's invented national IDs, account and card numbers valid check digits, as real
// ones have, keeping their layout. node eval/privacy/fix-numbers.ts [--write]
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  accountValid,
  fodselsnummerValid,
  ibanValid,
  luhnValid,
} from "../../dist/privacy/detectors.js";

const write = process.argv.includes("--write");
const dir = join(import.meta.dirname, "corpus");
const mod11 = (d: string, w: number[]) => {
  const r = 11 - (w.reduce((s, x, i) => s + x * Number(d[i]), 0) % 11);
  return r === 11 ? 0 : r;
};
function fixFnr(d: string): string | undefined {
  for (let ind = 0; ind < 1000; ind++) {
    const base = d.slice(0, 6) + String((Number(d.slice(6, 9)) + ind) % 1000).padStart(3, "0");
    const k1 = mod11(base, [3, 7, 6, 1, 8, 9, 4, 5, 2]);
    if (k1 === 10) continue;
    const k2 = mod11(base + k1, [5, 4, 3, 2, 7, 6, 5, 4, 3, 2]);
    if (k2 === 10) continue;
    return `${base}${k1}${k2}`;
  }
}
function fixAccount(d: string): string | undefined {
  for (let n = 0; n < 100; n++) {
    const base = d.slice(0, 8) + String((Number(d.slice(8, 10)) + n) % 100).padStart(2, "0");
    const k = mod11(base, [5, 4, 3, 2, 7, 6, 5, 4, 3, 2]);
    if (k !== 10) return `${base}${k}`;
  }
}
function fixCard(d: string): string {
  for (let k = 0; k < 10; k++) if (luhnValid(d.slice(0, -1) + k)) return d.slice(0, -1) + k;
  return d;
}
function fixIban(compact: string): string {
  const body = compact.slice(0, 2) + "00" + compact.slice(4);
  for (let k = 2; k < 99; k++) {
    const candidate = body.slice(0, 2) + String(k).padStart(2, "0") + body.slice(4);
    if (ibanValid(candidate)) return candidate;
  }
  return compact;
}
/** `value` with its digits replaced by `digits`, in order. */
const relayout = (value: string, digits: string) => {
  let i = 0;
  return value.replace(/\d/g, () => digits[i++]!);
};

for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
  const items = JSON.parse(readFileSync(join(dir, file), "utf8"));
  let changed = 0;
  for (const item of items)
    for (const h of item.hide) {
      const [value, kind] = h as [string, string];
      const d = value.replace(/\D/g, "");
      let fixed: string | undefined;
      if (kind === "NATIONALID" && d.length === 11 && !fodselsnummerValid(d)) fixed = fixFnr(d);
      if (kind === "ACCOUNT" && d.length === 11 && !accountValid(d)) fixed = fixAccount(d);
      if (kind === "CARD" && !luhnValid(d)) fixed = fixCard(d);
      if (kind === "IBAN" && !ibanValid(value.replace(/ /g, "")))
        fixed = fixIban(value.replace(/ /g, "")).replace(/\D/g, "");
      if (fixed === undefined) continue;
      const next = relayout(value, fixed);
      console.log(`${item.id} ${kind} ${value} -> ${next}`);
      item.text = item.text.split(value).join(next);
      h[0] = next;
      changed++;
    }
  if (write && changed > 0) writeFileSync(join(dir, file), `${JSON.stringify(items, null, 1)}\n`);
}
