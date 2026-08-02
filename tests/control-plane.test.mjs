import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ControlPlane, ControlPlaneError } from "../scripts/lib/control-plane.mjs";
import { Ledger } from "../scripts/lib/ledger.mjs";
import { NATIVE_THREAD_TOOLS } from "../scripts/lib/native-thread-tools.mjs";

test("native launch, observation, and controller acceptance complete one visible task", async (context) => {
  const root = await tempRoot(context, "thread-control-live-");
  const plane = new ControlPlane({ ledger: new Ledger(path.join(root, "ledger.json")) });

  const preflight = await plane.preflight({ cwd: root, availableTools: NATIVE_THREAD_TOOLS });
  assert.equal(preflight.ok, true);
  assert.equal(preflight.capabilities.complete, true);
  assert.equal(preflight.constraints.pluginInvokesNativeTools, false);

  const run = await plane.createRun({
    objective: "Complete one user-visible worker task",
    controllerThreadId: "controller-thread",
    executionMode: "live",
    maxRoundTrips: 3
  });
  const task = await plane.addTask({
    runId: run.id,
    title: "Implement bounded unit",
    prompt: "Return one complete result with evidence.",
    role: "implementation",
    cwd: root,
    acceptanceCriteria: ["Return primary-path evidence"]
  });

  const prepared = await plane.prepareDispatch({ runId: run.id, taskId: task.id });
  assert.equal(prepared.nextCall.tool, "codex_app__list_projects");
  await assert.rejects(
    plane.resolveProject({
      runId: run.id,
      operationId: prepared.operation.id,
      project: gitProject(root)
    }),
    (error) => error instanceof ControlPlaneError && error.code === "LIVE_CONFIRMATION_REQUIRED"
  );

  const resolved = await plane.resolveProject({
    runId: run.id,
    operationId: prepared.operation.id,
    project: gitProject(root),
    confirmLiveAction: true
  });
  assert.equal(resolved.nextCall.tool, "codex_app__create_thread");
  assert.equal(resolved.nextCall.arguments.target.environment.type, "worktree");
  assert.match(resolved.nextCall.arguments.prompt, /Return one complete result/);
  assert.match(resolved.nextCall.arguments.title, /^\[TO:/);

  const launched = await plane.recordThreadLaunch({
    runId: run.id,
    operationId: prepared.operation.id,
    result: { threadId: "thread-worker-1", hostId: "host-local" }
  });
  assert.equal(launched.task.status, "running");
  assert.equal(launched.thread.id, "thread-worker-1");

  const wait = await plane.prepareOperation({
    runId: run.id,
    tool: "codex_app__wait_threads",
    input: { taskIds: [task.id], timeoutMs: 60_000 }
  });
  assert.deepEqual(wait.nextCall.arguments.targets, [
    { threadId: "thread-worker-1", hostId: "host-local" }
  ]);
  await plane.completeOperation({
    runId: run.id,
    operationId: wait.operation.id,
    result: {
      status: "succeeded",
      observations: [
        {
          taskId: task.id,
          status: "completed",
          cursor: "cursor-1",
          summary: "Bounded unit completed.",
          artifacts: ["src/unit.mjs"],
          verification: ["primary path passed"]
        }
      ]
    }
  });

  let snapshot = await plane.snapshot({ runId: run.id });
  assert.equal(snapshot.status, "review");
  assert.equal(snapshot.tasks[task.id].status, "review");
  assert.equal(snapshot.threads["thread-worker-1"].status, "completed");
  assert.equal(snapshot.tasks[task.id].lastCursor, "cursor-1");

  await plane.decideTask({
    runId: run.id,
    taskId: task.id,
    decision: "accept",
    note: "Evidence satisfies the assignment"
  });
  snapshot = await plane.snapshot({ runId: run.id });
  assert.equal(snapshot.status, "completed");
  assert.equal(snapshot.tasks[task.id].status, "completed");
  assert.deepEqual(snapshot.messages.map((message) => message.type), [
    "ASSIGN",
    "RESULT",
    "DECISION"
  ]);
  assert.equal(snapshot.messages[0].recipient.threadId, "thread-worker-1");
});

test("queued worktree binding is exact and cancellation remains truthful", async (context) => {
  const root = await tempRoot(context, "thread-control-queued-");
  const plane = new ControlPlane({ ledger: new Ledger(path.join(root, "ledger.json")) });
  const run = await plane.createRun({ objective: "Queue a local worker", executionMode: "live" });
  const task = await plane.addTask({
    runId: run.id,
    title: "Queued worker",
    prompt: "Work after provisioning.",
    role: "worker",
    cwd: root
  });
  const dispatch = await plane.prepareDispatch({ runId: run.id, taskId: task.id });
  const resolved = await plane.resolveProject({
    runId: run.id,
    operationId: dispatch.operation.id,
    project: nonGitProject(root),
    confirmLiveAction: true
  });
  assert.equal(resolved.nextCall.arguments.target.environment.type, "local");
  const queued = await plane.recordThreadLaunch({
    runId: run.id,
    operationId: dispatch.operation.id,
    result: { clientThreadId: "client-queued-1" }
  });
  assert.equal(queued.task.status, "provisioning");
  assert.equal(queued.next.tool, "codex_app__list_threads");

  const list = await plane.prepareOperation({
    runId: run.id,
    tool: "codex_app__list_threads",
    input: { limit: 50 }
  });
  await assert.rejects(
    plane.completeOperation({
      runId: run.id,
      operationId: list.operation.id,
      result: {
        bindings: [
          {
            taskId: task.id,
            threadId: "thread-queued-1",
            clientThreadId: "client-queued-1",
            matchCount: 1,
            matchedTitle: "partial title"
          }
        ]
      }
    }),
    (error) => error instanceof ControlPlaneError && error.code === "TITLE_MATCH_REQUIRED"
  );
  const current = await plane.snapshot({ runId: run.id });
  await plane.completeOperation({
    runId: run.id,
    operationId: list.operation.id,
    result: {
      bindings: [
        {
          taskId: task.id,
          threadId: "thread-queued-1",
          hostId: "host-local",
          clientThreadId: "client-queued-1",
          matchCount: 1,
          matchedTitle: current.tasks[task.id].threadTitle
        }
      ]
    }
  });

  const idleRead = await plane.prepareOperation({
    runId: run.id,
    tool: "codex_app__read_thread",
    input: { taskId: task.id }
  });
  await plane.completeOperation({
    runId: run.id,
    operationId: idleRead.operation.id,
    result: { observations: [{ taskId: task.id, status: "idle" }] }
  });

  await assert.rejects(
    plane.prepareOperation({
      runId: run.id,
      tool: "codex_app__send_message_to_thread",
      input: { taskId: task.id, prompt: "Continue." }
    }),
    (error) => error instanceof ControlPlaneError && error.code === "LIVE_CONFIRMATION_REQUIRED"
  );
  const send = await plane.prepareOperation({
    runId: run.id,
    tool: "codex_app__send_message_to_thread",
    input: { taskId: task.id, prompt: "Continue.", messageType: "QUESTION" },
    confirmLiveAction: true
  });
  await plane.completeOperation({
    runId: run.id,
    operationId: send.operation.id,
    result: { status: "succeeded", cursor: "cursor-2" }
  });
  const cancelled = await plane.requestCancel({
    runId: run.id,
    taskId: task.id,
    reason: "User no longer needs this worker"
  });
  assert.equal(cancelled.task.status, "cancel_requested");
  assert.equal(cancelled.humanStopRequired, true);
  assert.match(cancelled.guidance, /Stop the visible Codex task/);
});

test("fork, handoff, metadata, archive, and navigation operations remain ledger-addressed", async (context) => {
  const root = await tempRoot(context, "thread-control-manage-");
  const plane = new ControlPlane({ ledger: new Ledger(path.join(root, "ledger.json")) });
  const { run, task } = await createBoundTask(plane, root, "thread-source");

  const read = await plane.prepareOperation({
    runId: run.id,
    tool: "codex_app__read_thread",
    input: { taskId: task.id }
  });
  await plane.completeOperation({
    runId: run.id,
    operationId: read.operation.id,
    result: { observations: [{ taskId: task.id, status: "idle", cursor: "idle-1" }] }
  });

  const title = await prepareAndComplete(plane, run.id, "codex_app__set_thread_title", {
    taskId: task.id,
    title: "Renamed worker"
  }, { title: "Renamed worker" });
  assert.equal(title.tasks[0].threadTitle, "Renamed worker");
  await prepareAndComplete(plane, run.id, "codex_app__set_thread_pinned", {
    taskId: task.id,
    pinned: true
  }, { pinned: true });
  await prepareAndComplete(plane, run.id, "codex_app__navigate_to_codex_page", {
    taskId: task.id
  }, { summary: "opened" });

  const fork = await plane.prepareOperation({
    runId: run.id,
    tool: "codex_app__fork_thread",
    input: {
      taskId: task.id,
      environment: "same-directory",
      forkTask: {
        title: "Forked investigation",
        prompt: "Investigate the alternative using copied completed history.",
        role: "investigation",
        cwd: root
      }
    },
    confirmLiveAction: true
  });
  assert.equal(fork.nextCall.arguments.threadId, "thread-source");
  assert.equal(fork.childTask.status, "prepared");
  const forked = await plane.recordThreadLaunch({
    runId: run.id,
    operationId: fork.operation.id,
    result: { threadId: "thread-forked", hostId: "host-local" }
  });
  assert.equal(forked.task.status, "idle");
  assert.equal(forked.task.sourceTaskId, task.id);

  const forkPrompt = await plane.prepareOperation({
    runId: run.id,
    tool: "codex_app__send_message_to_thread",
    input: {
      taskId: forked.task.id,
      sourceTaskId: task.id,
      messageType: "REVIEW",
      prompt: forked.task.prompt
    },
    confirmLiveAction: true
  });
  await plane.completeOperation({
    runId: run.id,
    operationId: forkPrompt.operation.id,
    result: { status: "succeeded" }
  });

  const handoff = await plane.prepareOperation({
    runId: run.id,
    tool: "codex_app__handoff_thread",
    input: { taskId: task.id, destinationHostId: "host-remote" },
    confirmLiveAction: true
  });
  await plane.completeOperation({
    runId: run.id,
    operationId: handoff.operation.id,
    result: {
      status: "pending",
      runtimeOperationId: "handoff-runtime-1",
      runtimeRevision: 1,
      handoffState: "pending"
    }
  });
  const status = await plane.prepareOperation({
    runId: run.id,
    tool: "codex_app__get_handoff_status",
    input: { handoffOperationId: handoff.operation.id, waitMs: 10 }
  });
  assert.equal(status.nextCall.arguments.operationId, "handoff-runtime-1");
  await plane.completeOperation({
    runId: run.id,
    operationId: status.operation.id,
    result: {
      handoffState: "completed",
      runtimeRevision: 2,
      threadId: "thread-source",
      hostId: "host-remote",
      taskStatus: "idle"
    }
  });

  await prepareAndComplete(plane, run.id, "codex_app__set_thread_archived", {
    taskId: task.id,
    archived: true
  }, { archived: true });
  await prepareAndComplete(plane, run.id, "codex_app__set_thread_archived", {
    taskId: task.id,
    archived: false
  }, { archived: false });

  const snapshot = await plane.snapshot({ runId: run.id });
  assert.equal(snapshot.tasks[task.id].hostId, "host-remote");
  assert.equal(snapshot.threads["thread-source"].pinned, true);
  assert.equal(snapshot.threads["thread-source"].archived, false);
  assert.equal(snapshot.threads["thread-source"].status, "idle");
  assert.equal(snapshot.operations[handoff.operation.id].status, "succeeded");
  assert.ok(snapshot.messages.some((message) => message.type === "FORK"));
  const relay = snapshot.messages.find((message) => message.type === "REVIEW");
  assert.equal(relay.sender.threadId, "thread-source");
  assert.equal(relay.recipient.threadId, "thread-forked");
});

test("dry-run simulation creates no native binding", async (context) => {
  const root = await tempRoot(context, "thread-control-dry-");
  const plane = new ControlPlane({ ledger: new Ledger(path.join(root, "ledger.json")) });
  const run = await plane.createRun({ objective: "Plan safely", executionMode: "dry-run" });
  const task = await plane.addTask({
    runId: run.id,
    title: "Plan",
    prompt: "Only simulate.",
    role: "planner",
    cwd: root
  });
  const prepared = await plane.prepareDispatch({ runId: run.id, taskId: task.id });
  const resolved = await plane.resolveProject({
    runId: run.id,
    operationId: prepared.operation.id,
    project: nonGitProject(root)
  });
  assert.equal(resolved.executable, false);
  await assert.rejects(
    plane.recordThreadLaunch({
      runId: run.id,
      operationId: prepared.operation.id,
      result: { threadId: "must-not-exist" }
    }),
    (error) => error instanceof ControlPlaneError && error.code === "DRY_RUN_ONLY"
  );
  const simulated = await plane.simulateTask({
    runId: run.id,
    taskId: task.id,
    summary: "Dry-run complete",
    verification: ["no native task was created"]
  });
  assert.equal(simulated.status, "review");
  assert.equal(simulated.threadId, null);
});

async function createBoundTask(plane, root, threadId) {
  const run = await plane.createRun({ objective: "Manage one bound task", executionMode: "live" });
  const task = await plane.addTask({
    runId: run.id,
    title: "Source worker",
    prompt: "Return a bounded result.",
    role: "worker",
    cwd: root
  });
  const dispatch = await plane.prepareDispatch({ runId: run.id, taskId: task.id });
  await plane.resolveProject({
    runId: run.id,
    operationId: dispatch.operation.id,
    project: nonGitProject(root),
    confirmLiveAction: true
  });
  await plane.recordThreadLaunch({
    runId: run.id,
    operationId: dispatch.operation.id,
    result: { threadId, hostId: "host-local" }
  });
  return { run, task };
}

async function prepareAndComplete(plane, runId, tool, input, result) {
  const operation = await plane.prepareOperation({
    runId,
    tool,
    input,
    confirmLiveAction: true
  });
  return plane.completeOperation({ runId, operationId: operation.operation.id, result });
}

function gitProject(root) {
  return {
    projectId: "project-git",
    projectKind: "local",
    label: "Git project",
    path: root,
    hostId: "host-local",
    isGitRepository: true
  };
}

function nonGitProject(root) {
  return {
    projectId: "project-local",
    projectKind: "local",
    label: "Local project",
    path: root,
    hostId: "host-local",
    isGitRepository: false
  };
}

async function tempRoot(context, prefix) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
