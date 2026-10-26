import type { A2AAgentInfo, A2AClientCreated, A2AClientInfo } from "@nudge/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { ApiError, clientFor } from "./api.ts";
import { m } from "./i18n/index.ts";

/**
 * Outside AI agents, through the extension `a2a` (ADR 25): those let in to call the assistant,
 * each with a token shown once, and those it may message. Hidden on an assistant without it.
 */
export function A2AAgents({ assistant }: { assistant: string }) {
  const api = () => clientFor(assistant).api;
  const queryClient = useQueryClient();
  const clientsKey = [assistant, "a2a-clients"];
  const agentsKey = [assistant, "a2a-agents"];
  const clients = useQuery({
    queryKey: clientsKey,
    queryFn: () => api().a2aClients(),
    retry: false,
  });
  const agents = useQuery({ queryKey: agentsKey, queryFn: () => api().a2aAgents(), retry: false });
  const [created, setCreated] = useState<A2AClientCreated>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  if (clients.error instanceof ApiError && clients.error.status === 404) return null;
  if (clients.data === undefined || agents.data === undefined) return null;

  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError(undefined);
    try {
      await work();
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
      void queryClient.invalidateQueries({ queryKey: clientsKey });
      void queryClient.invalidateQueries({ queryKey: agentsKey });
    }
  }

  return (
    <section className="mx-auto flex max-w-3xl flex-col gap-4 p-3 sm:p-4">
      <div>
        <h2 className="text-lg font-medium">{m.settings.a2a.title}</h2>
        <p className="text-sm text-stone-600">{m.settings.a2a.intro}</p>
      </div>
      {error !== undefined && (
        <p className="rounded bg-red-50 px-2 py-1 text-sm text-red-800">{error}</p>
      )}
      <Clients
        clients={clients.data}
        created={created}
        busy={busy}
        onCreate={(name) =>
          run(async () => {
            setCreated(await api().createA2AClient(name));
          })
        }
        onRemove={(id) =>
          run(async () => {
            await api().removeA2AClient(id);
            if (created?.client.id === id) setCreated(undefined);
          })
        }
      />
      <Agents
        agents={agents.data}
        busy={busy}
        onAdd={(url, token) =>
          run(async () => {
            await api().addA2AAgent({ url, ...(token === "" ? {} : { token }) });
          })
        }
        onToken={(id, token) => run(() => api().setA2AAgentToken(id, token))}
        onRemove={(id) => run(() => api().removeA2AAgent(id))}
      />
    </section>
  );
}

function Clients({
  clients,
  created,
  busy,
  onCreate,
  onRemove,
}: {
  clients: A2AClientInfo[];
  created: A2AClientCreated | undefined;
  busy: boolean;
  onCreate: (name: string) => void;
  onRemove: (id: string) => void;
}) {
  const [name, setName] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (name.trim() === "") return;
    onCreate(name.trim());
    setName("");
  };
  return (
    <article className="flex flex-col gap-3 rounded border border-stone-300 bg-white p-3">
      <h3 className="font-medium">{m.settings.a2a.clients}</h3>
      {clients.length === 0 ? (
        <p className="text-sm text-stone-500">{m.settings.a2a.none}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-stone-100">
          {clients.map((client) => (
            <li key={client.id} className="flex items-center justify-between gap-3 py-1.5">
              <span className="min-w-0 truncate text-sm">{client.name}</span>
              <button
                type="button"
                disabled={busy}
                onClick={() => onRemove(client.id)}
                className="shrink-0 rounded border border-stone-300 px-2 py-1 text-xs disabled:opacity-50"
              >
                {m.common.remove}
              </button>
            </li>
          ))}
        </ul>
      )}
      {created !== undefined && (
        <div className="flex flex-col gap-1 rounded bg-amber-50 p-2 text-sm text-amber-950">
          <p>{m.settings.a2a.giveThese(created.client.name)}</p>
          <Copyable label={m.settings.a2a.card} value={created.card} />
          <Copyable label={m.settings.a2a.token} value={created.token} />
        </div>
      )}
      <form onSubmit={submit} className="flex flex-wrap gap-2">
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={m.settings.a2a.clientName}
          maxLength={100}
          className="min-w-0 flex-1 rounded border border-stone-300 px-2 py-1.5 text-sm"
        />
        <button
          type="submit"
          disabled={busy || name.trim() === ""}
          className="rounded bg-stone-900 px-3 py-1.5 text-sm text-white disabled:opacity-40"
        >
          {m.settings.a2a.letIn}
        </button>
      </form>
    </article>
  );
}

function Agents({
  agents,
  busy,
  onAdd,
  onToken,
  onRemove,
}: {
  agents: A2AAgentInfo[];
  busy: boolean;
  onAdd: (url: string, token: string) => void;
  onToken: (id: string, token: string | null) => void;
  onRemove: (id: string) => void;
}) {
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (url.trim() === "") return;
    onAdd(url.trim(), token.trim());
    setUrl("");
    setToken("");
  };
  return (
    <article className="flex flex-col gap-3 rounded border border-stone-300 bg-white p-3">
      <h3 className="font-medium">{m.settings.a2a.agents}</h3>
      {agents.length === 0 ? (
        <p className="text-sm text-stone-500">{m.settings.a2a.none}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-stone-100">
          {agents.map((agent) => (
            <AgentRow
              key={agent.id}
              agent={agent}
              busy={busy}
              onToken={(token) => onToken(agent.id, token)}
              onRemove={() => onRemove(agent.id)}
            />
          ))}
        </ul>
      )}
      <form onSubmit={submit} className="flex flex-col gap-2 sm:flex-row">
        <input
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="https://agent.example.com"
          type="url"
          className="min-w-0 flex-1 rounded border border-stone-300 px-2 py-1.5 text-sm"
        />
        <input
          value={token}
          onChange={(event) => setToken(event.target.value)}
          placeholder={m.settings.a2a.tokenIfNeeded}
          type="password"
          autoComplete="off"
          className="min-w-0 rounded border border-stone-300 px-2 py-1.5 text-sm sm:w-48"
        />
        <button
          type="submit"
          disabled={busy || url.trim() === ""}
          className="rounded bg-stone-900 px-3 py-1.5 text-sm text-white disabled:opacity-40"
        >
          {m.settings.a2a.add}
        </button>
      </form>
    </article>
  );
}

function AgentRow({
  agent,
  busy,
  onToken,
  onRemove,
}: {
  agent: A2AAgentInfo;
  busy: boolean;
  onToken: (token: string | null) => void;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [token, setToken] = useState("");
  return (
    <li className="flex flex-col gap-2 py-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{agent.name}</p>
          <p className="truncate text-xs text-stone-500">
            {agent.url} · {agent.hasToken ? m.settings.a2a.withToken : m.settings.a2a.noToken}
          </p>
          {agent.description !== "" && (
            <p className="line-clamp-2 text-xs text-stone-600">{agent.description}</p>
          )}
        </div>
        <span className="flex shrink-0 gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => setEditing(!editing)}
            className="rounded border border-stone-300 px-2 py-1 text-xs disabled:opacity-50"
          >
            {m.settings.a2a.token}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onRemove}
            className="rounded border border-stone-300 px-2 py-1 text-xs disabled:opacity-50"
          >
            {m.common.remove}
          </button>
        </span>
      </div>
      {editing && (
        <div className="flex flex-wrap gap-2">
          <input
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder={m.settings.a2a.newToken}
            type="password"
            autoComplete="off"
            className="min-w-0 flex-1 rounded border border-stone-300 px-2 py-1 text-sm"
          />
          <button
            type="button"
            disabled={busy || token.trim() === ""}
            onClick={() => {
              onToken(token.trim());
              setToken("");
              setEditing(false);
            }}
            className="rounded bg-stone-900 px-2 py-1 text-xs text-white disabled:opacity-40"
          >
            {m.common.save}
          </button>
          {agent.hasToken && (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                onToken(null);
                setEditing(false);
              }}
              className="rounded border border-stone-300 px-2 py-1 text-xs disabled:opacity-50"
            >
              {m.settings.a2a.clear}
            </button>
          )}
        </div>
      )}
    </li>
  );
}

function Copyable({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2">
      <span className="w-20 shrink-0 text-xs font-medium">{label}</span>
      <code className="min-w-0 flex-1 truncate rounded bg-white px-1.5 py-0.5 text-xs">
        {value}
      </code>
      <button
        type="button"
        onClick={() =>
          void navigator.clipboard.writeText(value).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
        }
        className="shrink-0 rounded border border-amber-300 px-2 py-0.5 text-xs"
      >
        {copied ? m.settings.a2a.copied : m.settings.a2a.copy}
      </button>
    </div>
  );
}
