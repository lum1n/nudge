# 28. The browser agent calls the tools pages offer through WebMCP, held to the same approvals as clicks

WebMCP lets a page offer tools to agents: `registerTool({ name, description, inputSchema, annotations, execute })` on `document.modelContext` (`navigator.modelContext` before mid-2026). Chrome ships it as an origin trial, and sites can bring a polyfill. A site that offers "search" or "add to basket" saves the browser agent the clicking, guessing and checking that makes browsing slow and fragile.

**The agent reads them, and its two tools list and call them.** The agent doesn't get one model tool per page tool. Tools that come and go with each page would change the agent's tool list in the middle of a task, which breaks prompt caching and lets one page's names clash with another's. Instead it gets two tools, as the MCP extension has `mcp_tools` and `mcp_call`:

- `browser_page_tools` describes the page's tools: the name, the description, the input schema cut to 800 characters, and whether the tool only reads.
- `browser_call_page_tool` calls one with `{ name, arguments }`.

The observation header names the tools, so the agent knows to look. The room's own model never sees page tools: they stay inside `browse`, whose result is untrusted data (ADR 20), and so are their descriptions and results.

**A script records what pages register, and stands in for the API where there is none.** Before any page script runs, `addInitScript` installs a script in every frame:

- Where the browser has `modelContext`, the script wraps `registerTool`, `unregisterTool`, `provideContext` and `clearContext`. Each wrapped method records the tool and then calls the browser's own.
- Where it doesn't, the script puts a small stand-in on `Document.prototype` and `Navigator.prototype`, with the same methods, `getTools`, and a `toolchange` event.

The registry sits under `Symbol.for("nudge.webmcp")`. The agent reads it and calls `execute` there, in the page's own world (`evaluate(…, isolatedContext: false)`), because Patchright evaluates in an isolated world by default. Recording the tools ourselves means the agent works the same with Chrome's implementation, without it, and on sites with their own polyfill. A page could detect the stand-in, so `"webmcp": false` leaves it out, and `"chromiumArgs"` can turn on Chrome's own implementation.

**A tool that may change something waits for the room, as a click on Pay does.** Only a tool whose `annotations.readOnlyHint` is `true` runs at once. The hint comes from the page, but trusting it only lets the page read itself sooner, which the agent can already do. Any other call fails with a message that tells the agent to call `browser_confirm` with `tool: "browser_call_page_tool"`, the tool's name and the exact arguments. The approval is pinned, as the browser's action gate pins a click (`PinnedAction` in `gate.ts`), to the site's host and `page tool "<name>" <sha256 of the arguments as canonical JSON>`. So approving "add milk" lets that one call through, once, and not "add bread" or the same call again.

**Calls are bounded.** A call fails after 30 seconds, so a tool that never answers can't hang the run. `requestUserInteraction` fails, because nobody sits at the room's browser; a tool that needs the user is a job for the live view. Results are cut at 8,000 characters, and saved logins are scrubbed from them as from page text. A result is turned into text from MCP-style `content[]`, a string, or JSON.

WebMCP's details may still change while it is in trial: where the API lives, the shape of `execute`'s second argument, and the annotation names. The script is the only part that depends on them.
