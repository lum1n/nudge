import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, Outlet, redirect, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { ApiError, forgetToken, tokenFor } from "../../api.ts";
import { meQuery } from "../../queries.ts";

export const Route = createFileRoute("/$assistant")({
  beforeLoad: ({ params }) => {
    if (tokenFor(params.assistant) === undefined) throw redirect({ to: "/login" });
  },
  component: Assistant,
});

function Assistant() {
  const { assistant } = Route.useParams();
  const me = useQuery(meQuery(assistant));
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

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-6">
      <header className="flex items-baseline justify-between gap-4">
        <Link to="/$assistant" params={{ assistant }} className="text-xl font-semibold">
          {me.data?.assistant.displayName ?? assistant}
        </Link>
        <div className="flex items-baseline gap-3 text-sm text-stone-600">
          {me.data && <span>{me.data.player.displayName}</span>}
          <button type="button" onClick={signOut} className="underline">
            Sign out
          </button>
        </div>
      </header>
      {me.error && !(me.error instanceof ApiError && me.error.status === 401) ? (
        <p className="text-red-700">{me.error.message}</p>
      ) : (
        <Outlet />
      )}
    </div>
  );
}
