import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { type ChangeEvent, useEffect, useState } from "react";
import { forgetToken } from "../../api.ts";
import { base64, type DocumentInfo, save, useDocuments } from "../../documents.ts";
import { dateLocale, m } from "../../i18n/index.ts";

export const Route = createFileRoute("/$assistant/$room_/documents")({ component: Documents });

const UNAUTHORIZED = 4401;
const NOT_FOUND = 4404;

function Documents() {
  const { assistant, room } = Route.useParams();
  const [socket, state] = useDocuments(assistant, room);
  const navigate = useNavigate();
  const [uploading, setUploading] = useState<string>();

  useEffect(() => {
    if (state.status === "closed" && state.closeCode === UNAUTHORIZED) {
      forgetToken(assistant);
      void navigate({ to: "/login" });
    }
  }, [assistant, navigate, state.status, state.closeCode]);

  async function upload(event: ChangeEvent<HTMLInputElement>) {
    const files = [...(event.target.files ?? [])];
    event.target.value = "";
    if (socket === undefined) return;
    for (const file of files) {
      setUploading(file.name);
      await socket.request({
        type: "upload",
        name: file.name,
        mime: file.type,
        data: await base64(file),
      });
    }
    setUploading(undefined);
  }

  async function download(document: DocumentInfo) {
    const reply = await socket?.request({ type: "download", id: document.id });
    if (reply?.type === "file") save(reply.name, reply.mime, reply.data);
  }

  return (
    <section className="mx-auto flex max-w-3xl flex-col gap-3 p-3 sm:p-4">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <h2 className="text-lg font-medium">{m.panels.documents.title}</h2>
        <Link
          to="/$assistant/$room"
          params={{ assistant, room }}
          className="text-sm text-stone-600 hover:underline"
        >
          {m.panels.backToRoom}
        </Link>
      </div>
      <p className="text-sm text-stone-600">{m.panels.documents.intro}</p>
      {state.status === "closed" ? (
        <p className="text-red-700">
          {state.closeCode === NOT_FOUND
            ? m.panels.documents.notFound
            : m.panels.disconnected(state.error)}
        </p>
      ) : socket === undefined || state.view === undefined ? (
        <p className="text-stone-500">{m.panels.connecting}</p>
      ) : (
        <>
          <label className="flex cursor-pointer items-center gap-3 self-start rounded bg-stone-900 px-3 py-1 text-sm text-white">
            {uploading === undefined
              ? m.panels.documents.upload
              : m.panels.documents.uploading(uploading)}
            <input
              type="file"
              multiple
              accept=".pdf,.txt,.md,.csv,.json,.eml,.ics,.html,image/*"
              className="hidden"
              disabled={uploading !== undefined}
              onChange={(event) => void upload(event)}
            />
          </label>
          {state.error ? <p className="text-sm text-red-700">{state.error}</p> : null}
          {state.view.length === 0 ? (
            <p className="text-stone-500">{m.panels.documents.empty}</p>
          ) : (
            <ul className="divide-y divide-stone-200 rounded border border-stone-200 bg-white">
              {state.view.map((document) => (
                <li key={document.id} className="flex items-baseline gap-3 px-4 py-2 text-sm">
                  <button
                    type="button"
                    onClick={() => void download(document)}
                    className="font-medium hover:underline"
                  >
                    {document.name}
                  </button>
                  <span className="text-xs text-stone-500">
                    {document.pages === undefined ? "" : m.panels.documents.pages(document.pages)}
                    {Math.max(1, Math.round(document.size / 1024))} kB · {document.addedBy} ·{" "}
                    {new Date(document.addedAt).toLocaleDateString(dateLocale())}
                    {document.note === undefined ? "" : ` · ${document.note}`}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      if (confirm(m.panels.documents.confirmDelete(document.name)))
                        socket.send({ type: "remove", id: document.id });
                    }}
                    className="ml-auto text-xs text-stone-400 hover:text-red-700"
                  >
                    {m.panels.documents.delete}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
