# MCP servers

`extensions/mcp` gives the assistant the tools of [MCP](https://modelcontextprotocol.io) servers, started as programs or reached over HTTP:

```json
{
  "from": "./extensions/mcp",
  "settings": {
    "servers": {
      "github": {
        "command": "github-mcp-server",
        "args": ["stdio"],
        "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_TOKEN}" }
      },
      "docs": {
        "url": "https://mcp.example.com/mcp",
        "headers": { "Authorization": "Bearer ${DOCS_KEY}" }
      }
    }
  }
}
```

- Each tool becomes `mcp__<server>__<tool>`. They are not offered to the model up front: it finds the ones a task needs with `tool_search`, so a server with many tools doesn't fill the prompt.
- Calls wait for someone in the room to approve them, like the connectors' writes. A server marks its own tools read-only, so that mark counts only once you trust it: with `"trustReadOnlyHint": true`, tools it marks read-only run at once and only the rest are approved. Once a turn has read outside text, such as a server's answer, read-only ones wait too ([ADR 20](../adr/0020-untrusted-content-and-outbound-calls.md)). Set a server's `approval` to `"always"` or `"never"` to change that, and `tools` to offer only some of its tools.
- A started program runs in a bubblewrap sandbox, as the terminal's commands do: it sees the system's programs (`/usr`, `/opt`, `/etc` and the like) read-only, its own home under the extension's data, its `cwd` if you set one (read and write), an empty `/tmp`, and the network, but none of Nudge's files, such as the database, its key or the extensions' secrets. A program installed elsewhere (node or uv under your home, say) needs its directory in the extension's `readable` list. `"sandbox": false` runs a server's program as Nudge's user instead, able to read all of that; `nudge doctor` warns of each such server. Without bubblewrap, or in Docker without the `security_opt` lines from `compose.yaml`, started programs are left out and reported.
- `${NAME}` in `env` and `headers` comes from Nudge's environment, so keys stay out of `nudge.json`. A started program gets only those variables plus `PATH`, `HOME` (its own, in the sandbox) and the locale, not Nudge's own keys.
- Results reach the model through the same redaction as everything else, but redaction only reads text. **Images are not redacted.** So images in results are left out by default, and the model gets the line `[an image, not shown]` instead. A server that should show the model its images has to say so itself, with `"unredactedImages": true`. Then whatever its pictures show, such as names, numbers, addresses or faces in a screenshot, reaches the model's provider as it is. `nudge doctor` prints a `warn` line for each such server, and the server logs one at startup. The old key `"images": true` is still read, with a warning to rename it; `unredactedImages` wins when both are set. Servers rooms add can't pass images at all. ADR 12 sketches how images could be redacted later.
- The tool lists are read when the extension is installed; `nudge reload` reads them again. A server that can't be reached then is left out and reported. Connections close after `idleMinutes` (default 5) unused, and on reload and shutdown.

Rooms can also add servers from the chat ("add the Linear MCP server, https://mcp.linear.app/mcp"):

- `add_mcp_server` asks the room to approve the exact URL or command line. A remote server needs anyone in the room; a program, which runs on the server (in the sandbox, with the network), needs an admin. A room's servers are its own, like its connectors.
- Keys never go in the chat. The assistant names the headers or variables a server needs, and people set them on the room's **MCP** page (web) or **MCP servers** in About this room (apps). A remote server that signs in with OAuth gets a **Sign in** button there: it opens the server's sign-in page, which comes back to this server's `/v1/a/<assistant>/ext/mcp/oauth/callback`, so the browser you sign in with must reach the server at the address your app uses. Keys and tokens are kept encrypted in the extension's secrets, and scrubbed from results.
- The assistant sees a room's servers in its prompt, lists their tools with `mcp_tools` and calls them with `mcp_call`. Calls wait for approval. The page can let the tools a server marks read-only run at once (**Trust the server's read-only marks**, off for a new server), or make a server ask before every call, or never.
- A started program gets only its variables plus `PATH`, `HOME` and the locale, and works in its own directory under the extension's data, which is its home. It always runs in the sandbox above; there is no setting for a room to turn it off.
- Images in a room's servers' results are always left out, as `[an image, not shown]`: there is no setting for a room to turn them on.
