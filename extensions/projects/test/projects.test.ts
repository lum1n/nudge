import {
  ApprovalsDoc,
  BACKGROUND_CONTEXT,
  createNudge,
  LOBBY,
  type ModelContext,
  type Nudge,
} from "@nudge/core";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@nudge/core/testing";
import { accExtension } from "@nudge/ext-acc";
import { afterEach, describe, expect, it } from "vitest";
import { FakeAcc, push } from "../../acc/test/fake.ts";
import {
  ciOf,
  envFile,
  milestoneReady,
  newProject,
  nextHour,
  ProjectDoc,
  projectsExtension,
  quote,
  setPlan,
  vmName,
  WRITE_ENV,
} from "../src/index.ts";

const context = BACKGROUND_CONTEXT;
const STRIPE = "sk_test_51HcSecretValue0000";

function lastUser(request: ModelContext): string {
  const message = request.messages.findLast((m) => m.role === "user");
  return typeof message?.content === "string"
    ? message.content
    : (message?.content ?? []).map((part) => (part.type === "text" ? part.text : "")).join("");
}

async function until(check: () => boolean | Promise<boolean>, timeout = 8_000): Promise<void> {
  const end = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("Timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("the plan", () => {
  const owner = { playerId: "p1", displayName: "Vegard" };

  it("keeps tasks agents worked on when it changes", () => {
    const project = newProject("Toy", owner, 2, 0);
    setPlan(project, [
      {
        title: "API",
        tasks: [{ title: "Endpoint", criteria: ["GET /hello"] }, { title: "Tests" }],
      },
      { title: "Deploy", tasks: [{ title: "Fly" }] },
    ]);
    expect(project.milestones.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(project.tasks.map((t) => [t.id, t.milestone])).toEqual([
      ["t1", "m1"],
      ["t2", "m1"],
      ["t3", "m2"],
    ]);
    project.tasks[0]!.status = "running";
    setPlan(project, [{ title: "API", tasks: [{ title: "Docs" }] }]);
    expect(project.milestones.map((m) => m.title)).toEqual(["API"]);
    expect(project.tasks.map((t) => `${t.id} ${t.title} ${t.status}`)).toEqual([
      "t1 Endpoint running",
      "t4 Docs todo",
    ]);
  });

  it("is ready for its gate when every task is finished and has a PR", () => {
    const project = newProject("Toy", owner, 2, 0);
    setPlan(project, [{ title: "API", tasks: [{ title: "A" }, { title: "B" }] }]);
    expect(milestoneReady(project, "m1")).toBe(false);
    project.tasks[0]!.status = "review";
    project.tasks[0]!.pr = { url: "https://github.com/o/r/pull/1" };
    project.tasks[1]!.status = "skipped";
    expect(milestoneReady(project, "m1")).toBe(true);
  });

  it("names VMs the way exe.dev takes them", () => {
    expect(vmName("Tiny Hono API!", "ab12")).toBe("proj-tiny-hono-api-ab12");
    expect(vmName("Ærlig søk", "ab12")).toBe("proj-aerlig-sok-ab12");
    expect(vmName("???", "ab12")).toBe("proj-x-ab12");
  });

  it("writes secrets quoted, one per line, and leaves files out", () => {
    expect(envFile({ A: "x'y", CODEX_AUTH_JSON: "{}", "bad name": "z" })).toBe(
      `export A=${quote("x'y")}\n`,
    );
  });

  it("reads CI from check results", () => {
    expect(ciOf(["SUCCESS", "SKIPPED"])).toBe("passing");
    expect(ciOf(["SUCCESS", "IN_PROGRESS"])).toBe("pending");
    expect(ciOf(["FAILURE", "IN_PROGRESS"])).toBe("failing");
  });

  it("finds the next digest hour in the assistant's time zone", () => {
    const now = Date.UTC(2026, 9, 26, 10, 30); // 11:30 in Oslo
    expect(new Date(nextHour(now, 9, "Europe/Oslo")).toISOString()).toBe(
      "2026-10-27T08:00:00.000Z",
    );
  });
});

describe("projects", () => {
  const opened: Nudge[] = [];
  afterEach(async () => {
    for (const nudge of opened.splice(0)) await nudge.close(context);
  });

  /**
   * An assistant whose model calls `CALL <tool> <json>` from the last message, and otherwise says
   * what it heard; with acc on a fake binding and ticks every 30 ms.
   */
  async function open(acc: FakeAcc) {
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const requests: ModelContext[] = [];
    const answer = (request: ModelContext) => {
      requests.push(request);
      const last = request.messages.findLast((m) => m.role !== "system");
      if (last?.role === "toolResult")
        return fauxAssistantMessage([
          fauxText(last.content.map((p) => (p.type === "text" ? p.text : "")).join("")),
        ]);
      const said = lastUser(request);
      const call = /CALL (\w+) (.*)$/s.exec(said);
      if (call !== null)
        return fauxAssistantMessage([fauxToolCall(call[1]!, JSON.parse(call[2]!))], {
          stopReason: "toolUse",
        });
      return fauxAssistantMessage([fauxText("Okay.")]);
    };
    faux.setResponses(Array.from({ length: 400 }, () => answer));
    const nudge = await createNudge(
      {
        database: ":memory:",
        models,
        model: { provider: faux.provider.id, modelId: faux.getModel().id },
        timeZone: "Europe/Oslo",
        extensions: [
          {
            extension: accExtension({ backend: acc, report: () => {} }),
            settings: { local: false, hosts: [], approveStart: true },
          },
          {
            extension: projectsExtension({ tickMs: 30, random: () => "ab12", report: () => {} }),
            settings: { maxAgents: 1 },
          },
        ],
      },
      context,
    );
    opened.push(nudge);
    const vegard = (await nudge.players.invite("Vegard", context)).player;
    const by = { playerId: vegard.id, displayName: vegard.displayName };
    const say = async (roomId: string, text: string) => {
      const settled = await (
        await nudge.submit(roomId, { text, author: by }, context)
      ).wait(context);
      if (settled.status !== "done") throw new Error(`unanswered: ${JSON.stringify(settled)}`);
      await nudge.harness.waitForIdle(context);
    };
    const project = async (roomId: string) =>
      (await nudge.harness.snapshot(ProjectDoc, roomId, context))?.project;
    return { nudge, by, say, project, requests };
  }

  it("goes from idea to merged code, and no model sees a secret", async () => {
    const acc = new FakeAcc();
    acc.onExec = (script) => {
      if (script.includes("gh pr merge"))
        return { stdout: "merged: https://github.com/o/toy/pull/7\nfetched\n" };
      if (script.includes("have()")) return { stdout: "have: git\nrepo: cloned\n" };
      return undefined;
    };
    const { nudge, by, say, project, requests } = await open(acc);

    // Kickoff: a room of its own, with the extensions on, where the interview starts.
    await say(LOBBY, 'CALL project_create {"name": "Toy API"}');
    const room = (await nudge.rooms.list(context)).find((r) => r.name === "Toy API")!;
    expect(room).toBeDefined();
    expect(await project(room.id)).toMatchObject({ name: "Toy API", status: "planning" });
    expect(await nudge.extensionEnabled(room.id, "projects", context)).toBe(true);
    await until(() => requests.some((r) => lastUser(r).includes("interview them")));

    // The plan gate.
    await say(
      room.id,
      `CALL project_plan ${JSON.stringify({
        brief: "A tiny Hono API with one endpoint and tests.",
        repo: "o/toy",
        milestones: [{ title: "API", tasks: [{ title: "GET /hello", criteria: ["returns hi"] }] }],
      })}`,
    );
    await say(room.id, "CALL project_start {}");
    let [approval] = await nudge.approvals.list(room.id, context);
    expect(approval).toMatchObject({ kind: "plan", status: "pending" });
    await nudge.approvals.decide(room.id, approval!.id, { approve: true, by }, context);
    expect((await project(room.id))?.status).toBe("running");

    // A secret, given on its card.
    await say(room.id, 'CALL project_request_secret {"name": "STRIPE_KEY", "why": "Payments"}');
    [approval] = await nudge.approvals.list(room.id, context);
    expect(approval?.inputs).toEqual([
      { name: "value", label: "STRIPE_KEY", secret: true, description: "Payments" },
    ]);
    await nudge.approvals.decide(
      room.id,
      approval!.id,
      { approve: true, by, inputs: { value: STRIPE } },
      context,
    );
    expect((await project(room.id))?.secrets).toEqual(["STRIPE_KEY"]);

    // The VM, launched by the app, which approves with what exe.dev said.
    await say(room.id, "CALL project_request_vm {}");
    [approval] = await nudge.approvals.list(room.id, context);
    expect(approval?.clientAction).toEqual({
      type: "exe.new",
      name: "proj-toy-api-ab12",
      sshKey: expect.stringMatching(/^ssh-ed25519 /),
    });
    await nudge.approvals.decide(
      room.id,
      approval!.id,
      {
        approve: true,
        by,
        inputs: { vm: "proj-toy-api-ab12", sshHost: "proj-toy-api-ab12.exe.xyz" },
      },
      context,
    );
    await until(async () => (await project(room.id))?.vm?.ready === true);
    expect(acc.configs).toContainEqual(
      expect.objectContaining({ host: "proj-toy-api-ab12.exe.xyz", user: "exedev" }),
    );
    // The secret goes in on standard input, never in a script.
    const env = acc.execs.find((exec) => exec.script === WRITE_ENV)!;
    expect(env.stdin).toContain(`export STRIPE_KEY=${quote(STRIPE)}`);
    expect(acc.execs.every((exec) => !exec.script.includes(STRIPE))).toBe(true);

    // The ready task starts on its own, in its worktree.
    await until(async () => (await project(room.id))?.tasks[0]?.status === "running");
    const task = (await project(room.id))!.tasks[0]!;
    expect(task.branch).toBe("task/t1");
    const log = acc.logs.get(task.session!.id)!;
    await until(() => log.sent.length > 0);
    expect(log.sent[0]).toMatchObject({
      type: "prompt",
      text: expect.stringContaining("returns hi"),
    });

    // The agent prints the secret; the room hears it scrubbed.
    log.items = [
      {
        id: "i1",
        kind: "agent_message",
        status: "completed",
        text: `Set STRIPE_KEY=${STRIPE}. DONE https://github.com/o/toy/pull/7`,
        detail: { type: "agent_message" },
      },
    ];
    push(log, { type: "turn_completed" });
    await until(() => requests.some((r) => lastUser(r).includes("finished its turn")));
    await nudge.harness.waitForIdle(context);
    const heard = requests.find((r) => lastUser(r).includes("finished its turn"))!;
    expect(lastUser(heard)).toContain("STRIPE_KEY=[secret]");

    // Review, then the merge gate.
    await say(
      room.id,
      'CALL project_task_update {"id": "t1", "status": "review", "pr_url": "https://github.com/o/toy/pull/7", "ci": "passing", "stop_agent": true}',
    );
    await say(room.id, "CALL project_gate {}");
    expect((await project(room.id))?.status).toBe("gate");
    const gate = (await nudge.approvals.list(room.id, context)).find((a) => a.kind === "gate")!;
    expect(gate.summary).toContain("https://github.com/o/toy/pull/7");
    const merged = await nudge.approvals.decide(room.id, gate.id, { approve: true, by }, context);
    expect(merged).toMatchObject({ status: "done" });
    expect(await project(room.id)).toMatchObject({
      status: "done",
      milestones: [{ status: "merged" }],
      tasks: [{ status: "done" }],
    });

    // The end: the app deletes the VM.
    await say(room.id, 'CALL project_finish {"delete_vm": true}');
    const remove = (await nudge.approvals.list(room.id, context)).find(
      (a) => a.kind === "vmDelete",
    )!;
    expect(remove.clientAction).toEqual({ type: "exe.rm", name: "proj-toy-api-ab12" });
    await nudge.approvals.decide(room.id, remove.id, { approve: true, by }, context);
    expect((await project(room.id))?.vm).toBeUndefined();

    // Nothing the model was sent, nor the room's approvals, holds the secret.
    await nudge.harness.waitForIdle(context);
    expect(JSON.stringify(requests)).not.toContain(STRIPE);
    const approvals = await nudge.harness.snapshot(ApprovalsDoc, room.id, context);
    expect(JSON.stringify(approvals)).not.toContain(STRIPE);
  }, 30_000);

  it("pauses at the budget's warning level", async () => {
    const acc = new FakeAcc();
    const { nudge, by, say, project } = await open(acc);
    await say(LOBBY, 'CALL project_create {"name": "Spendy"}');
    const room = (await nudge.rooms.list(context)).find((r) => r.name === "Spendy")!;
    await say(
      room.id,
      `CALL project_plan ${JSON.stringify({
        brief: "Spends.",
        budget_usd: 0,
        milestones: [{ title: "M", tasks: [{ title: "T" }] }],
      })}`,
    );
    await say(room.id, "CALL project_start {}");
    const [plan] = await nudge.approvals.list(room.id, context);
    await nudge.approvals.decide(room.id, plan!.id, { approve: true, by }, context);
    await until(async () => (await project(room.id))?.status === "paused");
    expect((await project(room.id))?.budgetWarned).toBe(true);
  });
});
