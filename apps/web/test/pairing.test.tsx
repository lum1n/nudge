import type { PairingCodeResponse, Player } from "@nudge/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { invite, pairAnotherDevice, PairingCard, serverOf } from "../src/pairing.tsx";
import { routeTree } from "../src/routeTree.gen.ts";

// No socket: the settings page's room list is empty.
vi.mock("../src/api.ts", async (original) => ({
  ...(await original<typeof import("../src/api.ts")>()),
  tokenFor: () => "nudge_token",
  useConnection: () => ({ kind: "open" }),
  useRoomList: () => undefined,
}));

// The robot asks whether the reader wants less motion.
vi.stubGlobal("matchMedia", () => ({
  matches: false,
  addEventListener: () => {},
  removeEventListener: () => {},
}));

const LINK = "nudge://pair?server=https%3A%2F%2Fnudge.example&assistant=robin&code=ABCD-1234";

/** An admin's API that makes players and pairing codes, keeping what it was asked. */
function fakeApi() {
  const calls: string[] = [];
  return {
    calls,
    async createPlayer(displayName: string): Promise<Player> {
      calls.push(`createPlayer ${displayName}`);
      return { id: displayName.toLowerCase(), displayName };
    },
    async pairingCode(playerId: string): Promise<PairingCodeResponse> {
      calls.push(`pairingCode ${playerId}`);
      return { code: "ABCD-1234", link: LINK, expiresAt: Date.now() + 600_000 };
    },
  };
}

describe("invite", () => {
  it("makes the player, then a pairing code for them", async () => {
    const api = fakeApi();
    const pairing = await invite(api, "  Cy ");
    expect(api.calls).toEqual(["createPlayer Cy", "pairingCode cy"]);
    expect(pairing).toMatchObject({
      code: "ABCD-1234",
      link: LINK,
      displayName: "Cy",
      self: false,
    });
  });

  it("makes no one without a name", async () => {
    const api = fakeApi();
    await expect(invite(api, "  ")).rejects.toThrow("Give them a name first.");
    expect(api.calls).toEqual([]);
  });
});

describe("pairAnotherDevice", () => {
  it("makes a pairing code for the admin themselves", async () => {
    const api = fakeApi();
    const pairing = await pairAnotherDevice(api, { id: "ann", displayName: "Ann" });
    expect(api.calls).toEqual(["pairingCode ann"]);
    expect(pairing).toMatchObject({ displayName: "Ann", self: true });
  });
});

describe("serverOf", () => {
  it("reads the server from a pairing link", () => {
    expect(serverOf(LINK)).toBe("https://nudge.example");
    expect(serverOf("nudge://pair?code=ABCD-1234")).toBeUndefined();
    expect(serverOf("not a link")).toBeUndefined();
  });
});

describe("PairingCard", () => {
  const pairing = {
    code: "ABCD-1234",
    link: LINK,
    expiresAt: Date.now() + 600_000,
    displayName: "Cy",
    self: false,
  };

  it("shows the code, the server, and a QR code of the pairing link the apps open", () => {
    const html = renderToString(<PairingCard pairing={pairing} />);
    expect(html).toContain("ABCD-1234");
    expect(html).toContain("https://nudge.example");
    expect(html).toContain("Have Cy scan this");
    expect(html).toContain(`href="${LINK.replaceAll("&", "&amp;")}"`);
    expect(html).toContain("<svg");
  });

  it("speaks to the admin about their own device", () => {
    const html = renderToString(<PairingCard pairing={{ ...pairing, self: true }} />);
    expect(html).toContain("on your other device");
  });

  it("hides an expired code", () => {
    const html = renderToString(
      <PairingCard pairing={{ ...pairing, expiresAt: Date.now() - 1 }} />,
    );
    expect(html).toContain("This code expired");
    expect(html).not.toContain("<svg");
  });
});

describe("the settings page", () => {
  it("lets an admin invite someone and sign in another device", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(["robin", "me"], {
      player: { id: "ann", displayName: "Ann" },
      admin: true,
      clientId: "web-1",
    });
    queryClient.setQueryData(["assistants"], {
      assistants: [{ name: "robin", displayName: "Robin" }],
    });
    const router = createRouter({
      routeTree,
      context: { queryClient },
      history: createMemoryHistory({ initialEntries: ["/robin/settings"] }),
    });
    await router.load();
    const html = renderToString(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    expect(html).not.toContain("server rendering errored");
    expect(html).toContain("People and devices");
    expect(html).toContain("Invite someone");
    expect(html).toContain("Sign in another device");
  });
});
