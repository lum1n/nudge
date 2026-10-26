import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { type ReactNode, useEffect, useState } from "react";
import { forgetToken } from "../../api.ts";
import { m } from "../../i18n/index.ts";
import { type ProjectSocket, type ProjectView, type TaskView, useProject } from "../../project.ts";
import { dollars } from "../../spend.ts";

export const Route = createFileRoute("/$assistant/$room_/project")({ component: Project });

const UNAUTHORIZED = 4401;
const NOT_FOUND = 4404;

function Project() {
  const { assistant, room } = Route.useParams();
  const [socket, state] = useProject(assistant, room);
  const navigate = useNavigate();

  useEffect(() => {
    if (state.status === "closed" && state.closeCode === UNAUTHORIZED) {
      forgetToken(assistant);
      void navigate({ to: "/login" });
    }
  }, [assistant, navigate, state.status, state.closeCode]);

  return (
    <section className="mx-auto flex max-w-3xl flex-col gap-3 p-3 sm:p-4">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <h2 className="text-lg font-medium">{m.panels.project.title}</h2>
        <Link
          to="/$assistant/$room"
          params={{ assistant, room }}
          className="text-sm text-stone-600 hover:underline"
        >
          {m.panels.backToRoom}
        </Link>
      </div>
      <p className="text-sm text-stone-600">{m.panels.project.intro}</p>
      {state.status === "closed" ? (
        <p className="text-red-700">
          {state.closeCode === NOT_FOUND
            ? m.panels.project.notFound
            : m.panels.disconnected(state.error)}
        </p>
      ) : socket === undefined || state.view === undefined ? (
        <p className="text-stone-500">{m.panels.connecting}</p>
      ) : (
        <>
          {state.error ? <p className="text-sm text-red-700">{state.error}</p> : null}
          {state.view === null ? (
            <p className="text-stone-500">{m.panels.project.none}</p>
          ) : (
            <ProjectDetails project={state.view} socket={socket} />
          )}
        </>
      )}
    </section>
  );
}

function ProjectDetails({
  project,
  socket,
}: {
  project: ProjectView;
  socket: ProjectSocket | undefined;
}) {
  const working = project.milestones.flatMap((milestone) =>
    milestone.tasks.filter((task) => task.session !== undefined),
  );
  return (
    <>
      <Card>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="font-medium">
            {project.name}{" "}
            <span className="text-sm font-normal text-stone-500">
              {m.panels.project.status[project.status]}
            </span>
          </h3>
          {project.status === "running" || project.status === "paused" ? (
            <button
              type="button"
              disabled={socket === undefined}
              onClick={() =>
                socket?.send({ type: project.status === "running" ? "pause" : "resume" })
              }
              className="rounded border px-3 py-1 text-sm disabled:opacity-50"
            >
              {project.status === "running" ? m.panels.project.pause : m.panels.project.resume}
            </button>
          ) : null}
        </div>
        {project.repo !== undefined && (
          <p className="text-sm text-stone-600 [overflow-wrap:anywhere]">
            {m.panels.project.repo}: {project.repo}
          </p>
        )}
        <p className="text-sm whitespace-pre-wrap">{project.brief}</p>
      </Card>

      <Card title={m.panels.project.milestones}>
        {project.milestones.length === 0 && (
          <p className="text-sm text-stone-500">{m.panels.project.noMilestones}</p>
        )}
        {project.milestones.map((milestone) => (
          <div key={milestone.id} className="flex flex-col gap-1">
            <h4 className="text-sm font-medium">
              {milestone.title}{" "}
              <span className="font-normal text-stone-500">
                {m.panels.project.milestoneStatus[milestone.status]}
              </span>
            </h4>
            <ul className="flex flex-col gap-2 border-l border-stone-200 pl-3">
              {milestone.tasks.map((task) => (
                <TaskRow key={task.id} task={task} />
              ))}
            </ul>
          </div>
        ))}
      </Card>

      <Card title={m.panels.project.agents}>
        {working.length === 0 ? (
          <p className="text-sm text-stone-500">{m.panels.project.noAgents}</p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm">
            {working.map((task) => (
              <li key={task.id} className="flex flex-wrap items-baseline gap-x-2">
                <span>{task.title}</span>
                <span className="text-xs text-stone-500">
                  {task.session && m.panels.project.session(task.session.host, task.session.id)}
                  {task.session?.state ? ` · ${task.session.state}` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-stone-500">{m.panels.project.vm}</dt>
          <dd className="[overflow-wrap:anywhere]">
            {project.vm === undefined
              ? m.panels.project.noVm
              : `${project.vm.name} · ${project.vm.host} · ${
                  project.vm.ready ? m.panels.project.ready : m.panels.project.notReady
                }`}
          </dd>
          <dt className="text-stone-500">{m.panels.project.secrets}</dt>
          <dd>
            {project.secrets.length === 0 ? (
              m.panels.project.noSecrets
            ) : (
              <>
                <span className="font-mono">{project.secrets.join(", ")}</span>
                <span className="block text-xs text-stone-500">
                  {m.panels.project.secretsNote}
                </span>
              </>
            )}
          </dd>
          <dt className="text-stone-500">{m.panels.project.spend}</dt>
          <dd>
            {m.panels.project.spent(
              dollars(project.spendUsd),
              project.budgetUsd === undefined ? undefined : dollars(project.budgetUsd),
            )}
            <span className="block text-xs text-stone-500">
              {m.panels.project.maxAgents(project.maxAgents)}
            </span>
          </dd>
        </dl>
      </Card>
    </>
  );
}

function Card({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2 rounded border border-stone-200 bg-white p-3">
      {title !== undefined && <h3 className="font-medium">{title}</h3>}
      {children}
    </div>
  );
}

const CHIP: Record<TaskView["status"], string> = {
  todo: "bg-stone-100 text-stone-600",
  running: "bg-sky-100 text-sky-800",
  review: "bg-amber-100 text-amber-800",
  done: "bg-emerald-100 text-emerald-800",
  blocked: "bg-red-100 text-red-800",
  skipped: "bg-stone-100 text-stone-400",
};

const CI: Record<NonNullable<NonNullable<TaskView["pr"]>["ci"]>, string> = {
  pending: "text-stone-500",
  passing: "text-emerald-700",
  failing: "text-red-700",
};

function TaskRow({ task }: { task: TaskView }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="flex flex-col gap-0.5 text-sm">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className={`rounded px-1.5 text-xs ${CHIP[task.status]}`}>
          {m.panels.project.taskStatus[task.status]}
        </span>
        <span className="min-w-0 [overflow-wrap:anywhere]">{task.title}</span>
        {task.criteria.length > 0 && (
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
            className="text-xs text-stone-500 hover:underline"
          >
            {m.panels.project.criteria(task.criteria.length)}
          </button>
        )}
      </div>
      {open && (
        <ul className="ml-4 list-disc text-xs text-stone-600">
          {task.criteria.map((criterion) => (
            <li key={criterion}>{criterion}</li>
          ))}
        </ul>
      )}
      {(task.branch !== undefined || task.pr !== undefined) && (
        <div className="flex flex-wrap gap-x-3 text-xs text-stone-500">
          {task.branch !== undefined && (
            <span>
              {m.panels.project.branch}: <span className="font-mono">{task.branch}</span>
            </span>
          )}
          {task.pr !== undefined && (
            <span>
              <a
                href={task.pr.url}
                target="_blank"
                rel="noreferrer"
                className="text-sky-700 hover:underline"
              >
                {m.panels.project.pr(task.pr.number)}
              </a>
              {task.pr.ci !== undefined && (
                <span className={CI[task.pr.ci]}> · {m.panels.project.ci[task.pr.ci]}</span>
              )}
            </span>
          )}
        </div>
      )}
      {task.note !== undefined && (
        <p className="text-xs whitespace-pre-wrap text-stone-600">{task.note}</p>
      )}
    </li>
  );
}
