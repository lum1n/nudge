import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, Outlet, redirect, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { ApiError, forgetToken, tokenFor, useConnection } from "../../api.ts";
import { assistantsQuery, meQuery } from "../../queries.ts";

export const Route = createFileRoute("/$assistant")({
  beforeLoad: ({ params }) => {
    if (tokenFor(params.assistant) === undefined) throw redirect({ to: "/login" });
  },
  component: Assistant,
});

/** `CLOSE.unauthorized` in the protocol: the token was revoked, or the database is new. */
const UNAUTHORIZED = 4401;

function Assistant() {
  const { assistant } = Route.useParams();
  const me = useQuery(meQuery(assistant));
  const assistants = useQuery(assistantsQuery());
  const connection = useConnection(assistant);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const signOut = () => {
    forgetToken(assistant);
    queryClient.removeQueries({ queryKey: [assistant] });
    void navigate({ to: "/login" });
  };

  // A token that stopped working (revoked, or a fresh database) sends the tab back to sign-in.
  useEffect(() => {
    if (me.error instanceof ApiError && me.error.status === 401) signOut();
  }, [me.error]);
  useEffect(() => {
    if (connection.kind === "closed" && connection.code === UNAUTHORIZED) signOut();
  }, [connection]);

  const name =
    assistants.data?.assistants.find((item) => item.name === assistant)?.displayName ?? assistant;
  const tab = "rounded px-2 py-1 text-stone-600 hover:bg-stone-100";
  const active = { className: "bg-stone-200 text-stone-900" };

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <header className="flex shrink-0 items-center gap-2 border-b border-stone-200 px-3 py-2 sm:gap-4 sm:px-4">
        <Link to="/$assistant" params={{ assistant }} className="truncate text-lg font-semibold">
          {name}
        </Link>
        <nav className="flex items-center gap-1 text-sm">
          <Link
            to="/$assistant"
            params={{ assistant }}
            activeOptions={{ exact: true }}
            activeProps={active}
            className={tab}
          >
            Rooms
          </Link>
          {me.data?.admin && (
            <Link
              to="/$assistant/settings"
              params={{ assistant }}
              activeProps={active}
              className={tab}
            >
              Settings
            </Link>
          )}
        </nav>
        <div className="ml-auto flex shrink-0 items-center gap-3 text-sm text-stone-600">
          {me.data && <span className="hidden sm:inline">{me.data.player.displayName}</span>}
          <button type="button" onClick={signOut} className="underline">
            Sign out
          </button>
        </div>
      </header>
      {/* Full width: the room page lays out its own sidebar and transcript columns and scrolls
          the transcript only; other pages just grow and let this scroll instead. */}
      <main className="min-h-0 flex-1 overflow-y-auto">
        {me.error && !(me.error instanceof ApiError && me.error.status === 401) ? (
          <p className="p-4 text-red-700">{me.error.message}</p>
        ) : (
          <Outlet />
        )}
      </main>
    </div>
  );
}
