import { createFileRoute, redirect } from "@tanstack/react-router";
import { setupInfo, signedIn } from "../api.ts";

// The first assistant this tab is signed in to, else setup on a server that isn't set up yet,
// else the login page.
export const Route = createFileRoute("/")({
  beforeLoad: async () => {
    const [assistant] = signedIn();
    if (assistant === undefined) {
      const setup = await setupInfo("").catch(() => undefined);
      throw redirect({ to: setup?.open === true ? "/setup" : "/login" });
    }
    throw redirect({ to: "/$assistant", params: { assistant } });
  },
});
