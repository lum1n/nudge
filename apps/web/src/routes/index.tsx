import { createFileRoute, redirect } from "@tanstack/react-router";
import { signedIn } from "../api.ts";

// The first assistant this tab is signed in to, else the login page.
export const Route = createFileRoute("/")({
  beforeLoad: () => {
    const [assistant] = signedIn();
    if (assistant === undefined) throw redirect({ to: "/login" });
    throw redirect({ to: "/$assistant", params: { assistant } });
  },
});
