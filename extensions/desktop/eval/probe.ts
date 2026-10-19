// Drives real apps on a desktop of its own by hand, the way the desktop agent does, to see what
// their accessibility trees look like and which actions work. Commands come one per line on stdin:
//   launch <app> | observe [page] | find <words> | click <ref> | dclick <ref> | type <ref> <text>
//   submit <ref> <text> | press <keys> [ref] | select <ref> <option> | focus <ref> | sleep <ms>
// A ref may be `@words`: the ref on the first line of the desktop that contains every word.
// node eval/probe.ts --app editor=gnome-text-editor --app calc=libreoffice,--calc < steps.txt
// `--sandbox` runs the apps sandboxed, as Nudge does; `--readable <dir>` lets them read a directory.
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import type { Address } from "../src/atspi.ts";
import { DesktopSession } from "../src/session.ts";

const { values } = parseArgs({
  options: {
    app: { type: "string", multiple: true, default: [] },
    home: { type: "string" },
    quiet: { type: "boolean", default: false },
    "no-settle": { type: "boolean", default: false },
    sandbox: { type: "boolean", default: false },
    readable: { type: "string", multiple: true, default: [] },
  },
});
const apps = Object.fromEntries(
  values.app!.map((spec) => {
    const [name, command = ""] = spec.split(/=(.*)/s);
    return [name!, command.split(",")];
  }),
);
const homeDir = values.home ?? mkdtempSync(join(tmpdir(), "nudge-probe-home-"));
const desktop = await DesktopSession.open({
  apps,
  homeDir,
  ...(values.sandbox ? { sandbox: { readable: values.readable! } } : {}),
});
console.log(`# desktop ${desktop.display}, home ${homeDir}`);

const heard: string[] = [];

/** The object behind a ref, from the session's own map, for the commands that go around it. */
const addressOf = (ref: string): Address | undefined =>
  (desktop as unknown as { addresses: Map<string, Address> }).addresses.get(ref);

/** `@words` names the ref on the first matching line of the desktop. */
async function ref(word: string): Promise<string> {
  if (!word.startsWith("@")) return word;
  const hits = await desktop.find(word.slice(1).replace(/_/g, " "));
  const found = /\[(e\d+)\]/.exec(hits)?.[1];
  if (!found) throw new Error(`no ref for ${word}: ${hits.split("\n")[0]}`);
  return found;
}

const run = async (line: string): Promise<string> => {
  const [command, ...rest] = line.trim().split(" ");
  const arg = rest.join(" ");
  const tail = (n: number) => rest.slice(n).join(" ");
  switch (command) {
    case "launch":
      return desktop.launch(arg);
    case "observe": {
      const started = performance.now();
      const text = await desktop.observe(Number(arg) || 1);
      const ms = Math.round(performance.now() - started);
      return `${text}\n# ${ms} ms, ${text.split("\n").length} lines, ${text.length} chars`;
    }
    case "find":
      return desktop.find(arg);
    case "click":
      return desktop.click(await ref(rest[0]!));
    case "dclick":
      return desktop.click(await ref(rest[0]!), { double: true });
    case "type":
      return desktop.type(await ref(rest[0]!), tail(1).replace(/\\n/g, "\n"));
    case "submit":
      return desktop.type(await ref(rest[0]!), tail(1), { submit: true });
    case "press":
      return desktop.press(rest[0]!, rest[1] ? await ref(rest[1]) : undefined);
    case "select":
      return desktop.select(await ref(rest[0]!), tail(1));
    case "focus":
      return desktop.focusWindow(await ref(rest[0]!));
    case "box": {
      // Where AT-SPI says an element is, on the screen and in its window.
      const address = addressOf(await ref(rest[0]!));
      if (!address) return "no such ref";
      return `screen ${await desktop.atspi.extents(address)}, window ${await desktop.atspi.extents(address, 1).catch((e: unknown) => String(e))}`;
    }
    case "clickat": {
      const [x, y] = rest.map(Number) as [number, number];
      await desktop.atspi.mouse(x, y, "abs");
      await new Promise((resolve) => setTimeout(resolve, 30));
      await desktop.atspi.mouse(x, y, "b1p");
      await new Promise((resolve) => setTimeout(resolve, 50));
      await desktop.atspi.mouse(x, y, "b1r");
      return `clicked at ${x},${y}`;
    }
    case "raw": {
      // The tree under an element as AT-SPI has it, before the renderer leaves anything out.
      const address = addressOf(await ref(rest[0]!));
      if (!address) return "no such ref";
      const out: string[] = [];
      const walk = async (a: Address, depth: number): Promise<void> => {
        const info = await desktop.atspi.info(a);
        const short = [...info.interfaces].map((i) => i.replace("org.a11y.atspi.", "")).join(",");
        out.push(
          `${"  ".repeat(depth)}${info.role} "${info.name}" desc=${JSON.stringify(info.description)} text=${JSON.stringify(info.text ?? null)} children=${info.childCount} [${[...info.states].join(" ")}] {${short}}`,
        );
        if (depth < 6)
          for (const child of await desktop.atspi.children(a, info.childCount, 50).catch(() => []))
            await walk(child, depth + 1);
      };
      await walk(address, 0);
      const atspi = desktop.atspi as unknown as {
        call(a: unknown, i: string, m: string, sig?: string, args?: unknown[]): Promise<unknown>;
      };
      const props = await atspi.call(address, "org.freedesktop.DBus.Properties", "GetAll", "s", [
        "org.a11y.atspi.Accessible",
      ]);
      const attributes = await atspi
        .call(address, "org.a11y.atspi.Accessible", "GetAttributes")
        .catch(String);
      const relations = await atspi
        .call(address, "org.a11y.atspi.Accessible", "GetRelationSet")
        .catch(String);
      const actions = await desktop.atspi.actions(address).catch(String);
      for (const [type, targets] of (relations as [[number, [string, string][]][]])[0]) {
        for (const [bus, path] of targets) {
          const target = await desktop.atspi.info({ bus, path }).catch((e: unknown) => String(e));
          out.push(
            `relation ${type} -> ${typeof target === "string" ? target : `${target.role} "${target.name}" text=${JSON.stringify(target.text ?? null)} [${[...target.states].join(" ")}]`}`,
          );
        }
      }
      out.push(
        JSON.stringify({ props, attributes, relations, actions }, (_k, v) =>
          typeof v === "bigint" ? String(v) : v,
        ),
      );
      return out.join("\n");
    }
    case "apps": {
      // Every app on the bus and its top-level objects, shown or not.
      const atspi = desktop.atspi;
      const root = await atspi.info(atspi.root);
      const out: string[] = [];
      for (const app of await atspi.children(atspi.root, root.childCount, 100)) {
        const info = await atspi.info(app).catch((e: unknown) => String(e));
        if (typeof info === "string") {
          out.push(`${app.bus}: ${info}`);
          continue;
        }
        out.push(`${app.bus} "${info.name}" children=${info.childCount}`);
        for (const top of await atspi.children(app, info.childCount, 20).catch(() => [])) {
          const t = await atspi.info(top).catch(() => undefined);
          if (t) out.push(`  ${t.role} "${t.name}" [${[...t.states].join(" ")}]`);
        }
      }
      return out.join("\n") || "no apps";
    }
    case "shot":
      // A picture of the display, for whoever runs the probe; the agent never gets one.
      execFileSync("import", ["-display", desktop.display, "-window", "root", arg]);
      return `saved ${arg}`;
    case "listen":
      // Every object and window event the apps send from now on; `heard` prints them.
      await desktop.atspi.onEvents(["object:", "window:"], (event, source, detail) => {
        heard.push(`${event} ${detail} ${source.bus}${source.path}`);
      });
      return "listening";
    case "heard": {
      const out = heard.splice(0).filter((l) => !arg || l.includes(arg));
      return out.join("\n") || "nothing heard";
    }
    case "walk": {
      // Every object of every app, printed before its children are asked for, to find the one a
      // crash comes from.
      const atspi = desktop.atspi;
      const raw = atspi as unknown as {
        call(a: unknown, i: string, m: string, sig?: string, args?: unknown[]): Promise<unknown>;
      };
      const walk = async (a: Address, depth: number): Promise<void> => {
        if (rest[1] === "steps") {
          let has = new Set<string>();
          // Each call on its own, logged first, to see which one an app dies of.
          for (const [iface, member, sig, args] of [
            ["org.a11y.atspi.Accessible", "GetRoleName"],
            ["org.freedesktop.DBus.Properties", "GetAll", "s", ["org.a11y.atspi.Accessible"]],
            ["org.a11y.atspi.Accessible", "GetState"],
            ["org.a11y.atspi.Accessible", "GetInterfaces"],
            ["org.a11y.atspi.Accessible", "GetRelationSet"],
            ["org.a11y.atspi.Text", "GetText", "ii", [0, -1]],
            ["org.freedesktop.DBus.Properties", "Get", "ss", ["org.a11y.atspi.Action", "NActions"]],
            [
              "org.freedesktop.DBus.Properties",
              "Get",
              "ss",
              ["org.a11y.atspi.Value", "CurrentValue"],
            ],
            ["org.freedesktop.DBus.Properties", "Get", "ss", ["org.a11y.atspi.Table", "NColumns"]],
          ] as [string, string, string?, unknown[]?][]) {
            const target = iface.endsWith("Properties") ? String(args![0]) : iface;
            if (!target.endsWith("Accessible") && !has.has(target)) continue;
            console.log(`${"  ".repeat(depth)}. ${member} ${JSON.stringify(args ?? [])}`);
            const result = await raw.call(a, iface, member, sig, args).catch(() => undefined);
            if (member === "GetInterfaces") has = new Set((result as [string[]])[0]);
          }
        }
        const info = await atspi.info(a);
        console.log(
          `${"  ".repeat(depth)}${info.role} "${info.name.slice(0, 40)}" n=${info.childCount} {${[...info.interfaces].map((i) => i.replace("org.a11y.atspi.", "")).join(",")}}`,
        );
        if (depth > 40) return;
        const children = await atspi.children(a, info.childCount, Number(rest[0]) || 20);
        if (rest[1] === "parallel") {
          // As the session reads: every child's info at once.
          await Promise.all(children.map((c) => atspi.info(c).catch(() => undefined)));
        }
        for (const child of children) await walk(child, depth + 1);
      };
      await walk(atspi.root, 0);
      return "walked";
    }
    case "act": {
      // An element's own first action, as the click fallback does it.
      const address = addressOf(await ref(rest[0]!));
      if (!address) return "no such ref";
      const actions = await desktop.atspi.actions(address);
      return `${actions.join(",")}: ${await desktop.atspi.doAction(address, 0)}`;
    }
    case "keys":
      // Text typed key by key into whatever has the focus.
      await desktop.atspi.typeString(arg);
      return `typed ${arg}`;
    case "sleep":
      await new Promise((resolve) => setTimeout(resolve, Number(arg)));
      return "";
    default:
      return `unknown command ${command}`;
  }
};

try {
  for await (const line of createInterface({ input: process.stdin })) {
    if (!line.trim() || line.startsWith("#")) continue;
    console.log(`\n> ${line}`);
    const started = performance.now();
    const result = await run(line).catch((error: unknown) => `ERROR ${String(error)}`);
    if (!values["no-settle"] && !/^(observe|find|sleep)/.test(line.trim())) await desktop.settle();
    const ms = Math.round(performance.now() - started);
    console.log(
      values.quiet ? result.split("\n")[0] : result,
      line.startsWith("observe") ? "" : `(${ms} ms)`,
    );
  }
} finally {
  await desktop.close();
}
