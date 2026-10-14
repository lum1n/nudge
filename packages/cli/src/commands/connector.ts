import { ExtensionChannel } from "../extension-channel.ts";
import { type Connector, describeConnector } from "../render.ts";
import { type AdminOptions, type ServerAccess, withAssistantOrServer } from "./admin.ts";

/** Whoever runs the CLI on the host, which makes them the owner. */
const HOST = { id: "host", displayName: "Host", createdAt: 0 };

/**
 * Lists a room's connectors, or shares one with every room or takes it back into the room: for
 * the owner, on the host or through the server with an admin's token.
 */
export async function connector(
  options: AdminOptions &
    ServerAccess & {
      readonly verb?: string;
      readonly id?: string;
      /** Default: the lobby. */
      readonly room?: string;
    },
): Promise<void> {
  const room = options.room ?? "lobby";
  const use = async (channel: ExtensionChannel) => {
    try {
      if (options.verb === "share" || options.verb === "unshare") {
        await channel.request({ type: options.verb, connector: options.id });
        console.log(
          options.verb === "share"
            ? `Shared ${options.id} with every room.`
            : `Moved ${options.id} back into room "${room}".`,
        );
      }
      const { connectors } = await channel.latest<{ type: string; connectors: Connector[] }>(
        "connectors",
      );
      if (connectors.length === 0) console.log(`No connectors in room "${room}".`);
      for (const each of connectors) console.log(describeConnector(each));
    } finally {
      channel.close();
    }
  };
  await withAssistantOrServer(
    options,
    async (nudge) => use(await ExtensionChannel.local(nudge, room, HOST, "connectors", true)),
    async (server) =>
      use(
        await ExtensionChannel.remote(
          server.origin,
          server.assistant,
          room,
          server.token,
          "connectors",
        ),
      ),
  );
}
