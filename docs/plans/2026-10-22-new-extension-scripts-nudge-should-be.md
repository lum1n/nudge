# Scripts extension: saved programs Nudge reruns without a model

## Context
Today every watch check is a full model run with tools in a side conversation (`extensions/watches/src/extension.ts:296-317`). It costs tokens even when nothing changed, and the model works out the same steps on every check. Code mode (`extensions/codemode`) already runs QuickJS programs that call the room's tools, but only as a tool the model calls during a turn.

**Goal:** Nudge writes a small JS program once, saves it under a name, and reruns it. Reruns can come on demand, from a watch, or later from a trigger. A run uses no model turn. The model only steps in when there is news.

**Decisions (from the user):**
- Scripts are JavaScript in the code-mode sandbox, calling `tools.*`.
- When there is news, the script chooses who speaks: by default the model writes the message, or the script posts its own text with no model at all.
- Unattended scripts are read-only.

## Key findings
- pi-durable exports no way to run code mode outside a tool call. It does export the pieces: `ToolTask` and `NestedCallDoc` (pi-durable `index.d.ts:15`), and `CodemodeSandbox.start()` from pi-codemode.
- A nested tool call is just a `ToolTask` with input `{kind:"nested", parent, parentCallId, key, call}`, owned by any task. Its result is written to `NestedCallDoc(parent, key)` (pi-durable `harness/tool.js:552-603`, `:486-500`).
  - Reusing a key with the same arguments returns the existing task. A rerun after a restart therefore picks up the results it already has.
- The per-call redaction in `withToolValues` (`packages/core/src/privacy/tool-values.ts:39`) runs inside each tool, so it still applies.
- No tool says whether it only reads. The `keepsPlaceholders` marker (`tool-values.ts:20`) is the pattern to copy.
- Approvals never block (`packages/core/src/approvals/approvals.ts:116`), so a script that triggers one only gets "waiting". That is the reason read-only must be enforced in code.
- Cross-extension imports are normal practice. For example, terminal imports `@nudge/ext-documents`.

## Design

### Core (`packages/core`)
- `readsOnly(tool)` marker plus `isReadOnly(tool)`, next to `keepsPlaceholders` in `privacy/tool-values.ts` (or a new `tools/marks.ts`). Export both from `src/index.ts`.
- Mark these tools:
  - `web_search` and `read_page` (search).
  - `read_feeds` and `list_feeds` (rss).
  - `connector_docs`, plus `call_api` with GET only: when `call_api` runs from a script it refuses any other method.
  - The read and search tools of mail, calendar, contacts, lists and documents.
  - The `list_*` tools.
- Every other tool can't be called from a script.
- Guard: `requestApproval` throws "scripts can't ask for approval" when the current call is a script's. This needs a script flag in the turn context next to `currentTurn()`. It is a safety net in case a marked tool still asks for approval.

### New package `extensions/scripts` (`@nudge/ext-scripts`)
- **`model.ts`**
  - `ScriptsDoc`: a session-scoped doc family keyed by room, shaped like `WatchesDoc`. It holds `{ items: Script[] }`.
  - `Script = { name, description, code, createdAt, updatedAt, runs, lastRunAt?, lastError?, privateTo? }`.
  - `ScriptStoreDoc`: one per script, for `store`/`load` between runs.
- **`runner.ts`: `runScript(code, args, callTool, opts)`**
  - Starts `CappedSandbox` (export it from `extensions/codemode/src/extension.ts`; it is already in `@nudge/ext-codemode`).
  - Offers only the room's callable tools that are `isReadOnly`.
  - Exposes `args`, `store`/`load`, `console`, and the return value.
  - Returns `{ ok, value, console, error, calls }`.
  - `callTool` is the seam between the two ways to run:
    - **In a tool call** (`run_script`, `save_script`'s test run): `api.executeTool(name, args, ctx, {key})`.
    - **In a task** (scheduled run): `callNested(runtime, …)`, a copy of `startNestedCall`. It does `tx.createTask(ToolTask, {kind:"nested", parent: runtime.taskId, …}, {ownership:{kind:"task"}})`, then `waitForTask`, then reads `NestedCallDoc`. Keys are `c1, c2, …` in call order, so a rerun gets its earlier results back.
- **`scripts.run` task**: owned by the room's conversation or by its caller (a watch timer). It runs one script for unattended use and finishes with the result. If it restarts, it reruns from the top, which is safe because scripts are read-only.
- **Tools**
  - `save_script(name, description, code)`, wrapped in `keepsPlaceholders`. It runs the script once as a test and returns the output, so the model sees it work before it is saved.
  - `run_script(name, args?)`.
  - `list_scripts`.
  - `show_script(name)`, which returns the code.
  - `remove_script(name)`.
  - Private scripts follow the `privacy`/`visible` pattern from watches.
- **Section**: lists the room's scripts. Adds a rule: "When you'd run the same multi-step check again, save it as a script and reuse it."
- **Settings**: `timeoutSeconds` (30), `memoryMb` (64), `maxPerRoom` (20).
- **Exports** (`index.ts`): `runScriptTask`, `ScriptsDoc`, and the result type, for watches and triggers.

### Watches use scripts (`extensions/watches`)
- `add_watch` gets an optional `script` (the name of a saved script). `Watch` gets `script?: string`.
- The timer's `check` phase, when `watch.script` is set:
  1. It creates a `scripts.run` task owned by the timer task, waits for it, and reads the result. There is no side conversation and no `side.reset`/`submit`.
  2. The script returns `{ items: [{key, text}], message?: string }`. It is parsed with the same shape as `parseFound`, from an object rather than from text.
  3. If there are fresh items and no `message`, the existing `foundPrompt` path runs: the model writes the message, and only on news.
  4. If there are fresh items and a `message`, the text is posted to the room as a `FIRE_ENTRY` card with `source: "script"` and no model turn. Check whether pi-durable's passive `{type:"write", entry}` submission (`harness/types.d.ts:32`) works for this. If not, add a small core helper that appends the fire entry.
- A script watch may check as often as `minScriptMinutes` (default 5), separate from `minMinutes`, because it costs no tokens.
- Watches without a script keep working exactly as they do now.

### Later (not in this pass)
- Triggers that run a script and speak only when it returns something (`extensions/triggers/src/extension.ts:230`).
- A Scripts room page in the web app.

### Wiring and docs
- `nudge.example.json`, `BUNDLED_EXTENSIONS` (`packages/core/src/extensions/settings.ts:161`), `packages/release/package.json` deps.
- README: an extension list entry and a "Scripts" section near Watches (`README.md:467`).
- `docs/adr/0017-scripts-run-without-the-model.md`, covering read-only by marker, the nested-call reuse, and the two ways a script reports.

## Steps
1. **Spike:** from a test task, run one nested `ToolTask` with no `LiveDoc` `nestedTools` slot and check that it works. If `ToolTask` needs the slot (`toolSlot` at `tool.js:87,108,356`), add the slot the way `startNestedCall` does. `LiveDoc` may need to be imported from the dist path.
2. Core marker, the approval guard, and the read-only marks on the tools listed above.
3. `extensions/scripts`: model, runner, task, tools, section, tests.
4. Watches: the `script` option, the check path, posting directly, tests.
5. Wiring, README, ADR.

## Verification
- `extensions/scripts/test/scripts.test.ts`, using a real `createNudge({database:":memory:"})` with `fauxProvider` as in `extensions/watches/test/watches.test.ts`:
  - Save a script that calls a fake read-only tool and check it runs.
  - Check that a write tool is refused from a script.
  - Check that `store`/`load` persists between runs.
  - Check that a timeout is enforced.
- Watches test:
  - A script watch makes no model request on a check with nothing new (count the faux calls).
  - It makes exactly one request on news.
  - It makes zero requests when the script returns `message`, and the card is posted.
  - The run is reused after a simulated restart.
- `pnpm check` (typecheck, lint, test), and format only the changed files.
- Live check:
  1. `pnpm build`, then restart the server in tmux `nudge:1.1`.
  2. In a room, ask Nudge to watch an RSS feed or a search with a script.
  3. Check that `list_watches` shows checks going up while spend stays flat.
