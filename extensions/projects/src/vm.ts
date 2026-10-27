/**
 * What the extension runs on a project's VM over SSH. Secrets only ever go in on a script's
 * standard input, never in the script itself, so they don't show in the VM's process list or in
 * what the room hears of a script.
 */

/** Quotes for a POSIX shell. */
export function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Where the repo is cloned, below the VM user's home. */
export const REPO_DIR = "work/repo";
/** Where the env file is, below the VM user's home. */
export const ENV_FILE = ".nudge/project.env";

/** Secret names a shell takes as variables. */
export const SECRET_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;

/** Account secrets: the person's own logins, the same for every project. */
export const ACCOUNT_SECRETS = {
  CLAUDE_CODE_OAUTH_TOKEN:
    "Claude Code's token from `claude setup-token`, for your Claude subscription",
  CODEX_AUTH_JSON:
    "The contents of ~/.codex/auth.json after `codex login`, for your ChatGPT subscription",
  GH_TOKEN: "A fine-grained GitHub token with contents, pull requests and workflows on the repo",
} as const;

export type AccountSecret = keyof typeof ACCOUNT_SECRETS;

/** The env file's contents: one `export NAME='value'` per secret, for `stdin`. */
export function envFile(values: Readonly<Record<string, string>>): string {
  return (
    Object.entries(values)
      .filter(([name]) => SECRET_NAME.test(name) && name !== "CODEX_AUTH_JSON")
      .map(([name, value]) => `export ${name}=${quote(value)}`)
      .join("\n") + "\n"
  );
}

/** Writes stdin to the env file, readable by the VM user only, and has login shells load it. */
export const WRITE_ENV = `set -e
umask 077
mkdir -p "$HOME/.nudge"
cat > "$HOME/${ENV_FILE}.tmp"
mv "$HOME/${ENV_FILE}.tmp" "$HOME/${ENV_FILE}"
line='[ -f "$HOME/${ENV_FILE}" ] && set -a && . "$HOME/${ENV_FILE}" && set +a'
for rc in "$HOME/.profile" "$HOME/.bashrc"; do
  grep -qF "$line" "$rc" 2>/dev/null || printf '%s\\n' "$line" >> "$rc"
done
echo "env file written"`;

/** Writes stdin to Codex's login file, for a ChatGPT subscription. */
export const WRITE_CODEX_AUTH = `set -e
umask 077
mkdir -p "$HOME/.codex"
cat > "$HOME/.codex/auth.json"
echo "codex login written"`;

/**
 * Installs what agents need where missing (git, gh, Node, Claude Code, Codex), and clones the repo.
 * Says what it did, and what is still missing, line by line; exits non-zero only when the repo
 * couldn't be cloned. Loads the env file first, so `gh` has `GH_TOKEN`.
 */
export function bootstrapScript(repo: string | undefined): string {
  const clone =
    repo === undefined
      ? `echo "no repo yet: set one with project_plan"`
      : `if [ -d "$HOME/${REPO_DIR}/.git" ]; then
  git -C "$HOME/${REPO_DIR}" fetch -q origin && echo "repo: fetched"
else
  mkdir -p "$HOME/work"
  gh repo clone ${quote(repo)} "$HOME/${REPO_DIR}" -- -q || git clone -q ${quote(
    repo.includes(":") ? repo : `https://github.com/${repo}.git`,
  )} "$HOME/${REPO_DIR}" || { echo "repo: could not clone ${repo.replaceAll('"', "")}"; exit 3; }
  echo "repo: cloned"
fi`;
  return `set -u
[ -f "$HOME/${ENV_FILE}" ] && set -a && . "$HOME/${ENV_FILE}" && set +a
export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"
have() { command -v "$1" >/dev/null 2>&1; }
sudo_() { if [ "$(id -u)" = 0 ]; then "$@"; elif have sudo; then sudo -n "$@"; else return 1; fi; }
apt_() { have apt-get && sudo_ env DEBIAN_FRONTEND=noninteractive apt-get install -y -q "$@" >/dev/null 2>&1; }
have git || apt_ git || echo "missing: git"
if ! have gh; then
  apt_ gh || {
    have curl && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo_ dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg 2>/dev/null &&
      echo "deb [signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo_ tee /etc/apt/sources.list.d/github-cli.list >/dev/null &&
      sudo_ apt-get update -q >/dev/null 2>&1 && apt_ gh
  } || echo "missing: gh"
fi
have node || apt_ nodejs npm || echo "missing: node"
if have npm; then
  npm config set prefix "$HOME/.npm-global" >/dev/null 2>&1
  have claude || npm install -g -s @anthropic-ai/claude-code >/dev/null 2>&1 || echo "missing: claude"
  have codex || npm install -g -s @openai/codex >/dev/null 2>&1 || echo "missing: codex"
fi
if have gh && [ -n "\${GH_TOKEN:-}" ]; then gh auth setup-git >/dev/null 2>&1 && echo "gh: git uses GH_TOKEN"; fi
git config --global user.name >/dev/null 2>&1 || git config --global user.name "Nudge"
git config --global user.email >/dev/null 2>&1 || git config --global user.email "nudge@users.noreply.github.com"
for tool in git gh node claude codex; do have "$tool" && echo "have: $tool"; done
${clone}`;
}

/** Makes the task's worktree on branch `task/<id>` from the default branch; prints its path. */
export function worktreeScript(taskId: string): string {
  const branch = `task/${taskId}`;
  return `set -e
cd "$HOME/${REPO_DIR}"
git fetch -q origin
base=$(git symbolic-ref -q --short refs/remotes/origin/HEAD 2>/dev/null || echo origin/main)
dir="$HOME/work/${taskId}"
if [ ! -d "$dir" ]; then
  if git show-ref -q --verify ${quote(`refs/remotes/origin/${branch}`)}; then
    git worktree add -q -B ${quote(branch)} "$dir" ${quote(`origin/${branch}`)}
  else
    git worktree add -q -B ${quote(branch)} "$dir" "$base"
  fi
fi
cd "$dir" && pwd -P`;
}

/** Merges the PRs in order, squashing; stops at the first that fails. */
export function mergeScript(prs: readonly string[]): string {
  return `set -u
[ -f "$HOME/${ENV_FILE}" ] && set -a && . "$HOME/${ENV_FILE}" && set +a
cd "$HOME/${REPO_DIR}"
${prs
  .map(
    (pr) =>
      `if gh pr merge ${quote(pr)} --squash --delete-branch >/dev/null 2>&1 || gh pr merge ${quote(pr)} --squash --auto >/dev/null 2>&1; then echo "merged: ${pr.replaceAll('"', "")}"; else echo "failed: ${pr.replaceAll('"', "")}"; gh pr view ${quote(pr)} --json mergeable,mergeStateStatus 2>&1 | head -c 400; exit 4; fi`,
  )
  .join("\n")}
git fetch -q origin && echo "fetched"`;
}

/** PR state and CI for each PR, one JSON per line. */
export function prsScript(prs: readonly string[]): string {
  return `set -u
[ -f "$HOME/${ENV_FILE}" ] && set -a && . "$HOME/${ENV_FILE}" && set +a
cd "$HOME/${REPO_DIR}" 2>/dev/null || cd "$HOME"
${prs
  .map(
    (pr) =>
      `gh pr view ${quote(pr)} --json url,number,state,statusCheckRollup -q '{url: .url, number: .number, state: .state, checks: [.statusCheckRollup[]? | (.conclusion // .status)]}' 2>/dev/null || echo '{"url": ${JSON.stringify(pr).replaceAll("'", "")}, "error": true}'`,
  )
  .join("\n")}`;
}

/** CI from a PR's check results: failing if any failed, pending if any still runs, else passing. */
export function ciOf(checks: readonly string[]): "pending" | "passing" | "failing" {
  const upper = checks.map((check) => String(check).toUpperCase());
  if (
    upper.some((c) => ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED"].includes(c))
  )
    return "failing";
  if (upper.some((c) => ["PENDING", "IN_PROGRESS", "QUEUED", "WAITING", "EXPECTED"].includes(c)))
    return "pending";
  return "passing";
}
