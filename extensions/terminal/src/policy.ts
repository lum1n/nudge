// What a shell command runs, read before it runs: every program it starts, through pipes, lists,
// substitutions, `sh -c`, `xargs`, `find -exec` and the like, and whether each may run freely,
// needs the room's approval, or never runs. The sandbox is what keeps commands from the machine;
// this keeps the assistant from deleting, sending or escalating without the people in the room.

/** What happens to a command. */
export type Verdict =
  | { readonly kind: "run" }
  | { readonly kind: "ask"; readonly reasons: readonly string[] }
  | { readonly kind: "deny"; readonly reasons: readonly string[] };

/** Programs by name, added to or overriding the built-in lists. */
export interface PolicyLists {
  readonly allow?: readonly string[];
  readonly ask?: readonly string[];
  readonly deny?: readonly string[];
}

/** Programs that run without asking: reading, searching, transforming, building, converting. */
export const ALLOWED: readonly string[] = [
  // Files and text
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "find",
  "fd",
  "fdfind",
  "sort",
  "uniq",
  "cut",
  "tr",
  "sed",
  "awk",
  "gawk",
  "mawk",
  "jq",
  "yq",
  "date",
  "cal",
  "echo",
  "printf",
  "pwd",
  "basename",
  "dirname",
  "realpath",
  "readlink",
  "stat",
  "file",
  "du",
  "df",
  "tree",
  "diff",
  "cmp",
  "comm",
  "paste",
  "join",
  "column",
  "fold",
  "fmt",
  "nl",
  "tac",
  "rev",
  "expand",
  "unexpand",
  "split",
  "csplit",
  "md5sum",
  "sha1sum",
  "sha256sum",
  "sha512sum",
  "b2sum",
  "cksum",
  "base64",
  "base32",
  "xxd",
  "od",
  "hexdump",
  "strings",
  "bc",
  "dc",
  "expr",
  "seq",
  "shuf",
  "numfmt",
  "factor",
  "test",
  "[",
  "[[",
  "true",
  "false",
  "yes",
  "sleep",
  "tee",
  "touch",
  "mkdir",
  "cp",
  "mv",
  "ln",
  "chmod",
  "install",
  "mktemp",
  "printenv",
  "which",
  "type",
  "whoami",
  "id",
  "uname",
  "hostname",
  "nproc",
  "locale",
  "iconv",
  "cd",
  "export",
  "unset",
  "set",
  "read",
  "local",
  "return",
  "exit",
  "shift",
  "wait",
  "kill",
  "pkill",
  "ps",
  "patch",
  // Archives
  "tar",
  "gzip",
  "gunzip",
  "zcat",
  "bzip2",
  "bunzip2",
  "bzcat",
  "xz",
  "unxz",
  "xzcat",
  "zstd",
  "unzstd",
  "zip",
  "unzip",
  "7z",
  // The network, when the terminal has it; what sends data is asked about by its arguments
  "curl",
  "wget",
  "git",
  "dig",
  "host",
  "nslookup",
  "whois",
  // Languages and builds
  "python",
  "python3",
  "pip",
  "pip3",
  "uv",
  "node",
  "npm",
  "npx",
  "pnpm",
  "deno",
  "bun",
  "perl",
  "ruby",
  "php",
  "lua",
  "go",
  "cargo",
  "rustc",
  "gcc",
  "g++",
  "cc",
  "make",
  "cmake",
  "bash",
  "sh",
  "dash",
  "zsh",
  // Documents and media
  "pandoc",
  "pdftotext",
  "pdfinfo",
  "pdftoppm",
  "pdfimages",
  "qpdf",
  "libreoffice",
  "soffice",
  "convert",
  "magick",
  "identify",
  "ffmpeg",
  "ffprobe",
  "exiftool",
  "sqlite3",
  "xmllint",
  "csvlook",
  "csvcut",
  "csvstat",
  "in2csv",
];

/** Programs that delete or send: they run once someone in the room approves the command. */
export const ASKED: Readonly<Record<string, string>> = {
  rm: "deletes files",
  rmdir: "deletes directories",
  unlink: "deletes a file",
  shred: "destroys files",
  truncate: "empties files",
  ssh: "connects to another machine",
  scp: "copies files to or from another machine",
  sftp: "copies files to or from another machine",
  rsync: "copies files, possibly to another machine",
  ftp: "copies files to or from another machine",
  nc: "opens network connections",
  ncat: "opens network connections",
  netcat: "opens network connections",
  socat: "opens network connections",
  telnet: "opens network connections",
  mail: "sends mail",
  mailx: "sends mail",
  sendmail: "sends mail",
  msmtp: "sends mail",
  mutt: "sends mail",
  gh: "acts on GitHub as someone",
  dd: "writes raw data over files",
};

/** Programs that never run: they change the machine or reach outside the sandbox. */
export const DENIED: readonly string[] = [
  "sudo",
  "su",
  "doas",
  "pkexec",
  "run0",
  "mount",
  "umount",
  "chroot",
  "nsenter",
  "unshare",
  "bwrap",
  "docker",
  "podman",
  "systemctl",
  "service",
  "shutdown",
  "reboot",
  "poweroff",
  "halt",
  "init",
  "telinit",
  "crontab",
  "at",
  "passwd",
  "chpasswd",
  "useradd",
  "usermod",
  "userdel",
  "mkfs",
  "fdisk",
  "parted",
  "insmod",
  "modprobe",
  "rmmod",
  "iptables",
  "nft",
  "setcap",
];

/**
 * Reads a command and says whether it runs. Anything it can't read for sure, such as a program
 * named by a variable, is asked about, never run unread.
 */
export function judge(command: string, lists: PolicyLists = {}): Verdict {
  const reasons = { ask: [] as string[], deny: [] as string[] };
  const policy = new Policy(lists);
  try {
    for (const invocation of invocationsOf(command)) policy.check(invocation, reasons);
  } catch (error) {
    if (!(error instanceof Unreadable)) throw error;
    reasons.ask.push(error.message);
  }
  if (reasons.deny.length) return { kind: "deny", reasons: unique(reasons.deny) };
  if (reasons.ask.length) return { kind: "ask", reasons: unique(reasons.ask) };
  return { kind: "run" };
}

/** A word of a command: its text with quotes removed, and whether expansions make it unknown. */
interface Word {
  readonly text: string;
  readonly dynamic: boolean;
}

/** One program started, with its arguments, or a part of the command that can't be read. */
type Invocation = { readonly words: readonly Word[] } | { readonly unreadable: string };

class Unreadable extends Error {}

class Policy {
  private readonly allow: Set<string>;
  private readonly ask: Set<string>;
  private readonly deny: Set<string>;

  constructor(lists: PolicyLists) {
    this.allow = new Set(lists.allow);
    this.ask = new Set(lists.ask);
    this.deny = new Set(lists.deny);
  }

  check(invocation: Invocation, reasons: { ask: string[]; deny: string[] }): void {
    if ("unreadable" in invocation) {
      reasons.ask.push(invocation.unreadable);
      return;
    }
    const words = invocation.words;
    const first = words[0];
    if (!first) return;
    if (first.dynamic) {
      reasons.ask.push("it runs a program named by a variable or substitution");
      return;
    }
    const program = basename(first.text);
    const args = words.slice(1);
    // The settings first: an owner's lists override the built-in ones.
    if (this.deny.has(program)) return void reasons.deny.push(`${program} is not allowed here`);
    if (this.allow.has(program)) return this.inner(program, args, reasons);
    if (this.ask.has(program)) return void reasons.ask.push(`${program} needs approval`);
    if (DENIED.includes(program) || program.startsWith("mkfs."))
      return void reasons.deny.push(`${program} never runs in the terminal`);
    const asked = ASKED[program];
    if (asked) return void reasons.ask.push(`${program} ${asked}`);
    if (first.text.includes("/") && !/^\/(usr\/)?(local\/)?s?bin\//.test(first.text))
      return void reasons.ask.push(`it runs ${first.text}, a program or script of the workspace`);
    if (!ALLOWED.includes(program) && !WRAPPERS.has(program) && program !== "eval")
      return void reasons.ask.push(`${program} is not on the list of programs that run freely`);
    const ask = askedByArguments(program, args);
    if (ask) reasons.ask.push(ask);
    this.inner(program, args, reasons);
  }

  /** The commands a program runs in turn: wrappers, `sh -c`, `xargs`, `find -exec`, `eval`. */
  private inner(
    program: string,
    args: readonly Word[],
    reasons: { ask: string[]; deny: string[] },
  ) {
    for (const invocation of innerInvocations(program, args)) this.check(invocation, reasons);
  }
}

/** Runs the rest of its arguments as a command, after options that take these many values. */
const WRAPPERS = new Map<string, { flags: RegExp; valued: RegExp; leading?: RegExp }>([
  ["exec", { flags: /^-[cl]+$/, valued: /^-a$/ }],
  ["command", { flags: /^-[pvV]+$/, valued: /^$/ }],
  ["builtin", { flags: /^$/, valued: /^$/ }],
  ["nohup", { flags: /^$/, valued: /^$/ }],
  ["time", { flags: /^-[pv]+$/, valued: /^-[fo]$/ }],
  ["nice", { flags: /^-\d+$|^--adjustment=/, valued: /^-n$/ }],
  ["ionice", { flags: /^-t$/, valued: /^-[cnp]$/ }],
  ["stdbuf", { flags: /^-[ioe]./, valued: /^-[ioe]$/ }],
  [
    "env",
    {
      flags: /^-[i0v]+$|^--ignore-environment$|^--unset=/,
      valued: /^-[uCS]$/,
      leading: /^[A-Za-z_][A-Za-z0-9_]*=/,
    },
  ],
  [
    "timeout",
    {
      flags: /^-[v]+$|^--(preserve-status|foreground|verbose)$|^--(kill-after|signal)=/,
      valued: /^-[ks]$/,
      leading: /^\d+(\.\d+)?[smhd]?$/,
    },
  ],
  [
    "xargs",
    {
      flags:
        /^-[0ortpx]+$|^--(null|no-run-if-empty|interactive|verbose|exit)$|^-[IiLlnPsdEea].+|^--[a-z-]+=/,
      valued: /^-[IiLnPsdEa]$/,
    },
  ],
]);

/** Reserved words before a command, skipped to the program they run. */
const SHELL_WORDS = new Set([
  "!",
  "{",
  "}",
  "if",
  "then",
  "else",
  "elif",
  "fi",
  "while",
  "until",
  "do",
  "done",
]);

function innerInvocations(program: string, args: readonly Word[]): Invocation[] {
  const wrapper = WRAPPERS.get(program);
  if (wrapper) {
    let i = 0;
    let leading = true;
    while (i < args.length) {
      const arg = args[i]!;
      if (arg.text === "--") {
        i++;
        break;
      }
      if (wrapper.valued.test(arg.text)) i += 2;
      else if (arg.text.startsWith("-") && wrapper.flags.test(arg.text)) i++;
      else if (wrapper.leading?.test(arg.text) && leading) {
        i++;
        // `timeout` takes one duration; `env` any number of assignments.
        if (program === "timeout") leading = false;
      } else break;
    }
    const rest = args.slice(i);
    // `xargs` with no command runs echo.
    return rest.length ? [{ words: rest }] : [];
  }
  if (["sh", "bash", "dash", "zsh"].includes(program)) {
    const at = args.findIndex((a) => /^-[a-z]*c[a-z]*$/.test(a.text));
    if (at === -1) {
      // Commands from a script or from its input are hidden from this reading, as `./script` is.
      const script = args.find((a) => !/^[-+]/.test(a.text));
      return [
        {
          unreadable: script
            ? `${program} runs the script ${script.text}`
            : `${program} runs commands from its input`,
        },
      ];
    }
    const script = args[at + 1];
    if (!script) return [];
    if (script.dynamic)
      return [{ unreadable: `${program} -c runs a command built from a variable` }];
    return invocationsOf(script.text);
  }
  if (program === "eval") {
    if (args.some((a) => a.dynamic))
      return [{ unreadable: "eval runs a command built from a variable" }];
    return invocationsOf(args.map((a) => a.text).join(" "));
  }
  if (program === "find") {
    const found: Invocation[] = [];
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!.text;
      if (arg === "-delete") found.push({ words: [{ text: "rm", dynamic: false }] });
      if (["-exec", "-execdir", "-ok", "-okdir"].includes(arg)) {
        const end = args.findIndex((a, j) => j > i && (a.text === ";" || a.text === "+"));
        const stop = end === -1 ? args.length : end;
        found.push({ words: args.slice(i + 1, stop).filter((a) => a.text !== "{}") });
        i = stop;
      }
    }
    return found;
  }
  return [];
}

/** Why a freely run program needs approval for what these arguments make it do, if they do. */
function askedByArguments(program: string, args: readonly Word[]): string | undefined {
  const texts = args.map((a) => a.text);
  const has = (pattern: RegExp) => texts.some((t) => pattern.test(t));
  switch (program) {
    case "curl": {
      if (has(/^(-[a-zA-Z]*[dFT]|--data|--form|--upload-file|--json|--url-query)/))
        return "curl sends data";
      const method = texts.findIndex((t) => t === "-X" || t === "--request");
      const value =
        method === -1
          ? texts.find((t) => /^(-X|--request=)./.test(t))?.replace(/^(-X|--request=)/, "")
          : texts[method + 1];
      if (value && !/^(GET|HEAD|OPTIONS)$/i.test(value))
        return `curl sends a ${value.toUpperCase()} request`;
      return undefined;
    }
    case "wget":
      return has(/^--(post-data|post-file|method|body-data|body-file)/)
        ? "wget sends data"
        : undefined;
    case "git": {
      // The subcommand, after git's own options.
      let i = 0;
      while (i < texts.length && texts[i]!.startsWith("-"))
        i += /^-[Cc]$|^--(git-dir|work-tree|namespace)$/.test(texts[i]!) ? 2 : 1;
      const sub = texts[i];
      const rest = texts.slice(i + 1);
      if (sub === "push") return "git push sends commits to another machine";
      if (sub === "send-email") return "git send-email sends mail";
      if (sub === "clean") return "git clean deletes files";
      if (sub === "reset" && rest.includes("--hard")) return "git reset --hard discards changes";
      if (sub === "branch" && rest.some((r) => /^(-D|--delete)$/.test(r)))
        return "it deletes a git branch";
      if (sub === "stash" && /^(drop|clear)$/.test(rest[0] ?? ""))
        return "it discards stashed changes";
      if (
        (sub === "checkout" || sub === "restore") &&
        rest.some((r) => r === "-f" || r === "--force" || r === ".")
      )
        return "it discards changes";
      return undefined;
    }
    default:
      return askedByCode(program, texts);
  }
}

/** The options that hand an interpreter its code inline, as `python3 -c` and `node -e` do. */
const INLINE_CODE: ReadonlyMap<string, RegExp> = new Map([
  ...["python", "python3"].map((p) => [p, /^-[A-Za-z]*c$/] as const),
  ...["node", "bun", "deno"].map((p) => [p, /^(-[ep]|--eval|--print|eval)$/] as const),
  ...["perl", "ruby"].map((p) => [p, /^-[A-Za-z]*[eE]$/] as const),
  ["php", /^-r$/],
]);

/** What inline code does that needs approval, by the calls it makes; read like a command is. */
const CODE_ASKS: readonly [RegExp, string][] = [
  [
    /\bos\.(remove|unlink|rmdir|removedirs|truncate)\b|\bshutil\.rmtree\b|\.(unlink|rmdir|rmtree|truncate)\s*\(|\b(rmSync|unlinkSync|rmdirSync|truncateSync)\b|\bfs(\.promises)?\.(rm|unlink|rmdir|truncate)\b|\bDeno\.(remove|truncate)\b|\bFile(Utils)?\.(delete|unlink|rm\w*)\b|^\s*(unlink|rmdir)\b|[;{]\s*(unlink|rmdir)\b/,
    "deletes files",
  ],
  [
    /\b(socket|smtplib|ftplib|telnetlib|http\.client|urllib\.request|urlopen|httpx|aiohttp|paramiko|Net::\w+|LWP|IO::Socket|fsockopen|curl_exec)\b|\brequests\.(get|post|put|patch|delete|head|request|Session)\b|\bfetch\s*\(|\bhttps?\.(request|get)\b|\bnet\.(connect|createConnection)\b|['"](node:)?(https?|net|tls|dgram)['"]/,
    "connects elsewhere",
  ],
  [
    /\bsubprocess\b|\bos\.(system|popen|exec\w*|spawn\w*|fork)\b|\bchild_process\b|\b(execSync|spawnSync|execFile|shell_exec|passthru|proc_open|popen|Open3)\b|\bDeno\.(run|Command)\b|\bBun\.spawn|\b(system|exec)\s*\(|%x[({[]/,
    "runs other commands",
  ],
];

/** Why an interpreter's inline code needs approval, if it does. */
function askedByCode(program: string, texts: readonly string[]): string | undefined {
  const option = INLINE_CODE.get(program);
  if (!option) return undefined;
  const code: string[] = [];
  texts.forEach((text, i) => {
    if (option.test(text) && texts[i + 1] !== undefined) code.push(texts[i + 1]!);
    else if (/^--(eval|print)=/.test(text)) code.push(text.replace(/^--\w+=/, ""));
  });
  // Perl's and Ruby's backticks run the shell; JavaScript's make strings.
  const shell = (program === "perl" || program === "ruby" || program === "php") && /`/;
  const found = CODE_ASKS.filter(([pattern]) => code.some((c) => pattern.test(c))).map(
    ([, what]) => what,
  );
  if (shell && code.some((c) => shell.test(c)) && !found.includes("runs other commands"))
    found.push("runs other commands");
  return found.length ? `its ${program} code ${found.join(", ")}` : undefined;
}

/** Every program a command starts, in order, as far as it can be read. */
export function invocationsOf(command: string): Invocation[] {
  const { tokens, inner } = lex(command);
  const found: Invocation[] = [];
  let words: Word[] = [];
  let expectRedirect = false;
  const end = () => {
    if (words.length) found.push(...simpleCommand(words));
    words = [];
  };
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.kind === "op") {
      if (REDIRECTS.has(token.text)) {
        expectRedirect = true;
        continue;
      }
      if (token.text === ";;" || token.text === ";&")
        throw new Unreadable("it has a case statement");
      if (token.text === "(" && words.length) throw new Unreadable("it defines a function");
      end();
      continue;
    }
    if (expectRedirect) {
      // The file of a redirection, not a word of the command.
      expectRedirect = false;
      continue;
    }
    words.push(token);
  }
  end();
  for (const substitution of inner) found.push(...invocationsOf(substitution));
  return found;
}

/** The program of one simple command, past assignments and reserved words. */
function simpleCommand(words: readonly Word[]): Invocation[] {
  let i = 0;
  while (i < words.length) {
    const word = words[i]!;
    if (/^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(word.text) && !word.text.startsWith("=")) i++;
    else if (SHELL_WORDS.has(word.text) && !word.dynamic) i++;
    else break;
  }
  const rest = words.slice(i);
  const first = rest[0];
  if (!first) return [];
  if (!first.dynamic && ["for", "select"].includes(first.text)) return [];
  if (!first.dynamic && ["case", "function", "coproc"].includes(first.text))
    throw new Unreadable(`it has a ${first.text} statement`);
  return [{ words: rest }];
}

const REDIRECTS = new Set([">", ">>", ">|", "<", "<>", "<<<", "&>", "&>>", ">&", "<&"]);
const HEREDOCS = new Set(["<<", "<<-"]);

type Token = (Word & { readonly kind: "word" }) | { readonly kind: "op"; readonly text: string };

/**
 * Splits a command into words and operators as bash does, and collects the commands inside
 * `$(…)`, backticks and `<(…)`, which run too. Heredoc bodies are data, apart from their
 * substitutions.
 */
function lex(src: string): { tokens: Token[]; inner: string[] } {
  const tokens: Token[] = [];
  const inner: string[] = [];
  const heredocs: { delimiter: string; strip: boolean; expands: boolean }[] = [];
  let text = "";
  let dynamic = false;
  let inWord = false;
  let wantDelimiter: { strip: boolean } | undefined;
  let quotedDelimiter = false;
  const endWord = () => {
    if (!inWord) return;
    if (wantDelimiter) {
      heredocs.push({ delimiter: text, strip: wantDelimiter.strip, expands: !quotedDelimiter });
      wantDelimiter = undefined;
    } else tokens.push({ kind: "word", text, dynamic });
    text = "";
    dynamic = false;
    inWord = false;
    quotedDelimiter = false;
  };
  const op = (value: string) => {
    endWord();
    tokens.push({ kind: "op", text: value });
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    const next = src[i + 1];
    if (c === "\\" && next === "\n") {
      i += 2;
      continue;
    }
    if (c === "\\") {
      text += next ?? "";
      inWord = true;
      i += 2;
      continue;
    }
    if (c === " " || c === "\t") {
      endWord();
      i++;
      continue;
    }
    if (c === "#" && !inWord) {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "\n") {
      op(";");
      i++;
      // The bodies of heredocs started on this line.
      for (const doc of heredocs.splice(0)) {
        const lines: string[] = [];
        while (i < src.length) {
          const stop = src.indexOf("\n", i);
          const line = src.slice(i, stop === -1 ? src.length : stop);
          i = stop === -1 ? src.length : stop + 1;
          if ((doc.strip ? line.replace(/^\t+/, "") : line) === doc.delimiter) break;
          lines.push(line);
        }
        if (doc.expands) inner.push(...substitutionsIn(lines.join("\n")));
      }
      continue;
    }
    if (c === "'") {
      const close = src.indexOf("'", i + 1);
      if (close === -1) throw new Unreadable("it has an unclosed quote");
      text += src.slice(i + 1, close);
      inWord = true;
      if (wantDelimiter) quotedDelimiter = true;
      i = close + 1;
      continue;
    }
    if (c === '"') {
      i++;
      inWord = true;
      if (wantDelimiter) quotedDelimiter = true;
      while (i < src.length && src[i] !== '"') {
        if (src[i] === "\\" && i + 1 < src.length) {
          text += src[i + 1];
          i += 2;
        } else if (src[i] === "$" || src[i] === "`") {
          const read = expansion(src, i, inner);
          dynamic ||= read.dynamic;
          text += read.text;
          i = read.end;
        } else text += src[i++];
      }
      if (i >= src.length) throw new Unreadable("it has an unclosed quote");
      i++;
      continue;
    }
    if (c === "$" || c === "`") {
      const read = expansion(src, i, inner);
      dynamic ||= read.dynamic;
      text += read.text;
      inWord = true;
      i = read.end;
      continue;
    }
    if ((c === "<" || c === ">") && next === "(") {
      const close = matching(src, i + 1);
      inner.push(src.slice(i + 2, close));
      text += "/dev/fd/63";
      inWord = true;
      dynamic = true;
      i = close + 1;
      continue;
    }
    if (c === "<" || c === ">" || (c === "&" && next === ">")) {
      // A redirection's file descriptor, like the 2 of 2>, belongs to it.
      if (inWord && /^\d+$/.test(text) && !dynamic) {
        text = "";
        inWord = false;
      }
      const three = src.slice(i, i + 3);
      const two = src.slice(i, i + 2);
      const value = ["<<<", "&>>", "<<-"].includes(three)
        ? three
        : [">>", ">|", "<>", "&>", ">&", "<&", "<<"].includes(two)
          ? two
          : c;
      i += value.length;
      if (HEREDOCS.has(value)) {
        endWord();
        wantDelimiter = { strip: value === "<<-" };
        continue;
      }
      // >&2, 2>&1 and <&- duplicate descriptors: no file follows.
      if ((value === ">&" || value === "<&") && /^[\d-]/.test(src[i] ?? "")) {
        endWord();
        while (/[\d-]/.test(src[i] ?? "")) i++;
        continue;
      }
      op(value);
      continue;
    }
    if (c === "|" || c === "&" || c === ";" || c === "(" || c === ")") {
      const two = src.slice(i, i + 2);
      const value = ["||", "&&", "|&", ";;", ";&"].includes(two) ? two : c;
      op(value);
      i += value.length;
      continue;
    }
    text += c;
    inWord = true;
    i++;
  }
  endWord();
  return { tokens, inner };
}

/** A `$…` or backtick expansion at `start`: commands inside go to `inner`. */
function expansion(
  src: string,
  start: number,
  inner: string[],
): { text: string; dynamic: boolean; end: number } {
  if (src[start] === "`") {
    let i = start + 1;
    let body = "";
    while (i < src.length && src[i] !== "`") {
      if (src[i] === "\\" && i + 1 < src.length) {
        body += src[i + 1];
        i += 2;
      } else body += src[i++];
    }
    if (i >= src.length) throw new Unreadable("it has an unclosed backtick");
    inner.push(body);
    return { text: "", dynamic: true, end: i + 1 };
  }
  const next = src[start + 1];
  if (next === "(" && src[start + 2] === "(") {
    // Arithmetic: no commands, unless it substitutes one itself.
    const close = matching(src, start + 1);
    inner.push(...substitutionsIn(src.slice(start + 3, close - 1)));
    return { text: "0", dynamic: true, end: close + 1 };
  }
  if (next === "(") {
    const close = matching(src, start + 1);
    inner.push(src.slice(start + 2, close));
    return { text: "", dynamic: true, end: close + 1 };
  }
  if (next === "{") {
    const close = src.indexOf("}", start + 2);
    if (close === -1) throw new Unreadable("it has an unclosed ${");
    inner.push(...substitutionsIn(src.slice(start + 2, close)));
    return { text: "", dynamic: true, end: close + 1 };
  }
  const name = /^([A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-])/.exec(src.slice(start + 1));
  if (name) return { text: "", dynamic: true, end: start + 1 + name[0].length };
  return { text: "$", dynamic: false, end: start + 1 };
}

/** The index of the `)` closing the `(` at `open`, past quotes and nested parentheses. */
function matching(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") i++;
    else if (c === "'") {
      i = src.indexOf("'", i + 1);
      if (i === -1) break;
    } else if (c === '"') {
      i++;
      while (i < src.length && src[i] !== '"') i += src[i] === "\\" ? 2 : 1;
    } else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i;
  }
  throw new Unreadable("it has an unclosed parenthesis");
}

/** The commands substituted in text that is otherwise data, like a heredoc's body. */
function substitutionsIn(text: string): string[] {
  const inner: string[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === "`" || (text[i] === "$" && text[i + 1] === "(")) {
      i = expansion(text, i, inner).end - 1;
    }
  }
  return inner;
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
