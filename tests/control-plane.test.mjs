import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AppServerClient } from "../scripts/lib/app-server-client.mjs";
import { ControlPlane, ControlPlaneError } from "../scripts/lib/control-plane.mjs";
import { Ledger } from "../scripts/lib/ledger.mjs";

const fixture = fileURLToPath(new URL("./fixtures/fake-app-server.mjs", import.meta.url));

test("live control path uses App Server without creating a real Codex thread", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "control-plane-live-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const plane = new ControlPlane({
    ledger: new Ledger(path.join(root, "ledger.json")),
    appServerFactory: () =>
      new AppServerClient({
        executable: process.execPath,
        args: [fixture],
        cwd: root,
        requestTimeoutMs: 5_000
      })
  });
  context.after(() => plane.close());

  const preflight = await plane.preflight({ cwd: root, connect: true });
  assert.equal(preflight.appServerConnected, true);
  assert.equal(preflight.models[0].id, "gpt-test");

  const run = await plane.createRun({
    objective: "Exercise the independent-session control path",
    controllerThreadId: "controller-thread",
    executionMode: "live",
    maxRoundTrips: 3
  });
  const task = await plane.addTask({
    runId: run.id,
    title: "Implement bounded unit",
    prompt: "Return one verified result.",
    role: "implementation",
    cwd: root,
    model: "gpt-test",
    effort: "high",
    sandbox: "workspace-write"
  });
  const reviewTask = await plane.addTask({
    runId: run.id,
    title: "Review bounded unit",
    prompt: "Review the implementation session result.",
    role: "review",
    cwd: root,
    model: "gpt-test",
    effort: "medium",
    sandbox: "read-only"
  });

  const preview = await plane.previewDispatch({ runId: run.id, taskId: task.id });
  assert.equal(preview.threadStart.model, "gpt-test");
  assert.equal(preview.turnStart.effort, "high");
  assert.equal(preview.threadStart.cwd, root);

  await assert.rejects(
    plane.dispatchTask({ runId: run.id, taskId: task.id }),
    (error) =>
      error instanceof ControlPlaneError && error.code === "LIVE_CONFIRMATION_REQUIRED"
  );

  const dispatched = await plane.dispatchTask({
    runId: run.id,
    taskId: task.id,
    confirmLiveDispatch: true
  });
  assert.match(dispatched.threadId, /^fake-thread-/);

  const observed = await plane.pollTask({ runId: run.id, taskId: task.id });
  assert.equal(observed.completed, true);
  assert.equal(observed.result.status, "completed");
  assert.deepEqual(observed.verification, ["fake App Server end-to-end path passed"]);

  const reviewDispatch = await plane.dispatchTask({
    runId: run.id,
    taskId: reviewTask.id,
    confirmLiveDispatch: true
  });
  await plane.pollTask({ runId: run.id, taskId: reviewTask.id });

  const relayed = await plane.relayMessage({
    runId: run.id,
    fromTaskId: task.id,
    toTaskId: reviewTask.id,
    text: "Cross-check the implementation result and its evidence.",
    type: "REVIEW",
    confirmLiveDispatch: true
  });
  assert.equal(relayed.fromThreadId, dispatched.threadId);
  assert.equal(relayed.toThreadId, reviewDispatch.threadId);
  await plane.pollTask({ runId: run.id, taskId: reviewTask.id });

  const accepted = await plane.decideTask({
    runId: run.id,
    taskId: task.id,
    decision: "accept"
  });
  assert.equal(accepted.status, "completed");
  await plane.decideTask({
    runId: run.id,
    taskId: reviewTask.id,
    decision: "accept"
  });

  const snapshot = await plane.snapshot({ runId: run.id });
  assert.equal(snapshot.status, "completed");
  assert.equal(snapshot.sessions[dispatched.threadId].status, "completed");
  assert.ok(snapshot.messages.some((message) => message.type === "ASSIGN"));
  assert.ok(snapshot.messages.some((message) => message.type === "RESULT"));
  const relay = snapshot.messages.find(
    (message) =>
      message.type === "REVIEW" &&
      message.sender.threadId === dispatched.threadId &&
      message.recipient.threadId === reviewDispatch.threadId
  );
  assert.ok(relay, "cross-session message must retain both thread addresses");
  assert.equal(
    snapshot.messages.filter((message) => message.type === "DECISION").length,
    2
  );
});

test("dry-run simulation cannot dispatch a real session", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "control-plane-dry-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const plane = new ControlPlane({ ledger: new Ledger(path.join(root, "ledger.json")) });
  const run = await plane.createRun({ objective: "Plan safely", executionMode: "dry-run" });
  const task = await plane.addTask({
    runId: run.id,
    title: "Plan",
    prompt: "Only simulate.",
    role: "planner",
    cwd: root,
    model: "gpt-test"
  });

  await assert.rejects(
    plane.dispatchTask({
      runId: run.id,
      taskId: task.id,
      confirmLiveDispatch: true
    }),
    (error) => error instanceof ControlPlaneError && error.code === "DRY_RUN_ONLY"
  );

  const simulated = await plane.simulateTask({
    runId: run.id,
    taskId: task.id,
    summary: "Dry-run complete",
    verification: ["no live thread was created"]
  });
  assert.equal(simulated.status, "review");
  assert.match(simulated.sessionId, /^sim_/);
  const snapshot = await plane.snapshot({ runId: run.id });
  assert.deepEqual(
    snapshot.messages.map((message) => message.type),
    ["ASSIGN", "RESULT"]
  );
});
