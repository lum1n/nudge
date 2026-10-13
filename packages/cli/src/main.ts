#!/usr/bin/env node
// node:sqlite warns that it is experimental on every start; that is noise for CLI users.
// Imports are hoisted, so the filter goes in before the rest of the CLI loads.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const text = typeof warning === "string" ? warning : warning.message;
  if (/SQLite is an experimental feature/.test(text)) return;
  (emitWarning as (...args: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

const { run } = await import("./cli.ts");
run(process.argv.slice(2));
