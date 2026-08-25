import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
  assert.equal(resolved.nextCall.arguments.target.environment.type, "local");
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
    decision: "adopt",
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
  const worktreeRoot = path.join(root, ".codex-worktrees", "thread-queued-1");
  const plane = new ControlPlane({ ledger: new Ledger(path.join(root, "ledger.json")) });
  const run = await plane.createRun({ objective: "Queue a worktree worker", executionMode: "live" });
  const task = await plane.addTask({
    runId: run.id,
    title: "Queued worker",
    prompt: "Work after provisioning.",
    role: "worker",
    cwd: root,
    environment: "worktree",
    accessMode: "write",
    worktreePurpose: "explicit_user_isolation",
    worktreeLifecycleAuthority: "user_request:queued lifecycle",
    integrationTargetBranch: "main"
  });
  const dispatch = await plane.prepareDispatch({ runId: run.id, taskId: task.id });
  const resolved = await plane.resolveProject({
    runId: run.id,
    operationId: dispatch.operation.id,
    project: gitProject(root),
    confirmLiveAction: true
  });
  assert.equal(resolved.nextCall.arguments.target.environment.type, "worktree");
  const queued = await plane.recordThreadLaunch({
    runId: run.id,
    operationId: dispatch.operation.id,
    result: { clientThreadId: "client-queued-1" }
  });
  assert.equal(queued.task.status, "provisioning");
  assert.equal(queued.next.tool, "codex_app__list_threads");
  const queuedSnapshot = await plane.snapshot({ runId: run.id });
  const identityMarker = queuedSnapshot.tasks[task.id].threadTitle.match(/^\[TO:[^\]]+\]/)?.[0];
  assert.ok(identityMarker);
  assert.ok(identityMarker.length <= 22);

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
    (error) =>
      error instanceof ControlPlaneError && error.code === "FABRICATED_BINDING_EVIDENCE"
  );

  const recentNonMatch = nativeThreadRecord({
    id: "thread-recency-only",
    cwd: worktreeRoot,
    projectId: "project-git",
    title: "Queued worker",
    updatedAt: 4_102_444_800
  });
  const partialMarkerNonMatch = nativeThreadRecord({
    id: "thread-partial-marker",
    cwd: worktreeRoot,
    projectId: "project-git",
    title: `${identityMarker.slice(0, -1)} worker · Queued…`
  });
  const wrongProjectNonMatch = nativeThreadRecord({
    id: "thread-wrong-project",
    cwd: worktreeRoot,
    projectId: "project-other",
    title: `${identityMarker} worker · Queued…`
  });
  const relativePathNonMatch = nativeThreadRecord({
    id: "thread-relative-path",
    cwd: "relative/worktree",
    projectId: "project-git",
    title: `${identityMarker} worker · Queued…`
  });
  const nonMatch = await plane.completeOperation({
    runId: run.id,
    operationId: list.operation.id,
    result: nativeThreadListResult([
      recentNonMatch,
      partialMarkerNonMatch,
      wrongProjectNonMatch,
      relativePathNonMatch
    ])
  });
  assert.equal(nonMatch.operation.result.bindingCount, 0);
  assert.equal((await plane.snapshot({ runId: run.id })).tasks[task.id].status, "provisioning");

  const bindingList = await plane.prepareOperation({
    runId: run.id,
    tool: "codex_app__list_threads",
    input: { limit: 50 }
  });
  const exactOlder = nativeThreadRecord({
    id: "thread-ambiguous-older",
    cwd: path.join(root, ".codex-worktrees", "thread-ambiguous-older"),
    projectId: "project-git",
    title: `${identityMarker} worker · Queued…`,
    updatedAt: 1_785_500_000
  });
  const exactNewer = nativeThreadRecord({
    id: "thread-queued-1",
    cwd: worktreeRoot,
    projectId: "project-git",
    title: `${identityMarker} worker · Queued…`,
    updatedAt: 1_785_944_063
  });
  await assert.rejects(
    plane.completeOperation({
      runId: run.id,
      operationId: bindingList.operation.id,
      result: nativeThreadListResult([
        { ...exactNewer, clientThreadId: "fabricated-client-id" }
      ])
    }),
    (error) =>
      error instanceof ControlPlaneError && error.code === "FABRICATED_BINDING_EVIDENCE"
  );
  await assert.rejects(
    plane.completeOperation({
      runId: run.id,
      operationId: bindingList.operation.id,
      result: nativeThreadListResult([exactOlder, exactNewer])
    }),
    (error) =>
      error instanceof ControlPlaneError && error.code === "AMBIGUOUS_THREAD_BINDING"
  );
  const bound = await plane.completeOperation({
    runId: run.id,
    operationId: bindingList.operation.id,
    result: nativeThreadListResult([
      recentNonMatch,
      exactNewer
    ])
  });
  assert.equal(bound.operation.result.listSchemaVersion, 4);
  assert.equal(bound.operation.result.threadCount, 2);
  assert.equal(bound.operation.result.bindingCount, 1);
  assert.deepEqual(bound.operation.taskIds, [task.id]);
  assert.equal(bound.tasks[0].threadId, "thread-queued-1");
  assert.equal(bound.tasks[0].clientThreadId, null);
  assert.equal(bound.tasks[0].cwd, root);
  assert.equal(bound.tasks[0].project.path, root);
  assert.equal(bound.tasks[0].project.environment, "worktree");
  const boundSnapshot = await plane.snapshot({ runId: run.id });
  assert.equal(boundSnapshot.threads["thread-queued-1"].runtimeCwd, worktreeRoot);
  const bindingEvent = boundSnapshot.events.findLast(
    (entry) => entry.type === "QUEUED_THREAD_BOUND"
  );
  assert.equal(bindingEvent.details.declaredProjectRoot, root);
  assert.equal(bindingEvent.details.runtimeCwd, worktreeRoot);
  assert.equal(bindingEvent.details.projectId, "project-git");

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

test("queued worktree binding with null projectId requires canonical Git common-directory identity", async (context) => {
  const root = await tempRoot(context, "thread-control-null-project-id-");
  const otherRoot = await tempRoot(context, "thread-control-other-project-");
  const worktreeRoot = path.join(root, ".codex-worktrees", "thread-null-project-id");
  const ambiguousWorktreeRoot = path.join(root, ".codex-worktrees", "thread-null-project-id-ambiguous");
  await initializeGitRepository(root);
  await initializeGitRepository(otherRoot);
  createGitWorktree(root, worktreeRoot, "thread-null-project-id");
  createGitWorktree(root, ambiguousWorktreeRoot, "thread-null-project-id-ambiguous");

  const plane = new ControlPlane({ ledger: new Ledger(path.join(root, "ledger.json")) });
  const run = await plane.createRun({ objective: "Bind a queued worktree without a project ID", executionMode: "live" });
  const task = await plane.addTask({
    runId: run.id,
    title: "Null project ID worker",
    prompt: "Work after provisioning.",
    role: "worker",
    cwd: root,
    environment: "worktree",
    accessMode: "write",
    worktreePurpose: "explicit_user_isolation",
    worktreeLifecycleAuthority: "user_request:null-project lifecycle",
    integrationTargetBranch: "main"
  });
  const dispatch = await plane.prepareDispatch({ runId: run.id, taskId: task.id });
  await plane.resolveProject({
    runId: run.id,
    operationId: dispatch.operation.id,
    project: gitProject(root),
    confirmLiveAction: true
  });
  await plane.recordThreadLaunch({
    runId: run.id,
    operationId: dispatch.operation.id,
    result: { clientThreadId: "client-null-project-id" }
  });
  const snapshot = await plane.snapshot({ runId: run.id });
  const marker = snapshot.tasks[task.id].threadTitle.match(/^\[TO:[^\]]+\]/)?.[0];
  assert.ok(marker);

  const incompleteMarker = nativeThreadRecord({
    id: "thread-null-incomplete-marker",
    cwd: worktreeRoot,
    title: `${marker.slice(0, -1)} worker · Queued…`
  });
  const mismatchedRepository = nativeThreadRecord({
    id: "thread-null-wrong-repository",
    cwd: otherRoot,
    title: `${marker} worker · Queued…`
  });
  const missingCwd = nativeThreadRecord({
    id: "thread-null-missing-cwd",
    cwd: undefined,
    title: `${marker} worker · Queued…`
  });
  const relativeCwd = nativeThreadRecord({
    id: "thread-null-relative-cwd",
    cwd: "relative/worktree",
    title: `${marker} worker · Queued…`
  });
  const noMatchList = await plane.prepareOperation({
    runId: run.id,
    tool: "codex_app__list_threads",
    input: { limit: 50 }
  });
  const noMatch = await plane.completeOperation({
    runId: run.id,
    operationId: noMatchList.operation.id,
    result: nativeThreadListResult([incompleteMarker, mismatchedRepository, missingCwd, relativeCwd])
  });
  assert.equal(noMatch.operation.result.bindingCount, 0);
  assert.equal((await plane.snapshot({ runId: run.id })).tasks[task.id].status, "provisioning");

  const sameRepository = nativeThreadRecord({
    id: "thread-null-project-id",
    cwd: worktreeRoot,
    title: `${marker} worker · Queued…`
  });
  const sameRepositoryAmbiguous = nativeThreadRecord({
    id: "thread-null-project-id-ambiguous",
    cwd: ambiguousWorktreeRoot,
    title: `${marker} worker · Queued…`
  });
  const ambiguousList = await plane.prepareOperation({
    runId: run.id,
    tool: "codex_app__list_threads",
    input: { limit: 50 }
  });
  await assert.rejects(
    plane.completeOperation({
      runId: run.id,
      operationId: ambiguousList.operation.id,
      result: nativeThreadListResult([sameRepository, sameRepositoryAmbiguous])
    }),
    (error) => error instanceof ControlPlaneError && error.code === "AMBIGUOUS_THREAD_BINDING"
  );
  assert.equal((await plane.snapshot({ runId: run.id })).tasks[task.id].status, "provisioning");

  const bindingList = await plane.prepareOperation({
    runId: run.id,
    tool: "codex_app__list_threads",
    input: { limit: 50 }
  });
  const bound = await plane.completeOperation({
    runId: run.id,
    operationId: bindingList.operation.id,
    result: nativeThreadListResult([sameRepository])
  });
  assert.equal(bound.operation.result.bindingCount, 1);
  assert.equal(bound.tasks[0].threadId, "thread-null-project-id");
  assert.equal((await plane.snapshot({ runId: run.id })).threads["thread-null-project-id"].runtimeCwd, worktreeRoot);
});

test("queued local binding retains exact declared project cwd", async (context) => {
  const root = await tempRoot(context, "thread-control-queued-local-");
  const plane = new ControlPlane({ ledger: new Ledger(path.join(root, "ledger.json")) });
  const run = await plane.createRun({ objective: "Queue a local worker", executionMode: "live" });
  const task = await plane.addTask({
    runId: run.id,
    title: "Local worker",
    prompt: "Work after provisioning.",
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
    result: { clientThreadId: "client-local-1" }
  });
  const snapshot = await plane.snapshot({ runId: run.id });
  const marker = snapshot.tasks[task.id].threadTitle.match(/^\[TO:[^\]]+\]/)?.[0];
  assert.ok(marker);

  const firstList = await plane.prepareOperation({
    runId: run.id,
    tool: "codex_app__list_threads"
  });
  const nonMatch = await plane.completeOperation({
    runId: run.id,
    operationId: firstList.operation.id,
    result: nativeThreadListResult([
      nativeThreadRecord({
        id: "thread-local-wrong-cwd",
        cwd: path.join(root, "other-runtime"),
        projectId: "project-local",
        title: `${marker} worker · Local…`
      })
    ])
  });
  assert.equal(nonMatch.operation.result.bindingCount, 0);

  const secondList = await plane.prepareOperation({
    runId: run.id,
    tool: "codex_app__list_threads"
  });
  const bound = await plane.completeOperation({
    runId: run.id,
    operationId: secondList.operation.id,
    result: nativeThreadListResult([
      nativeThreadRecord({
        id: "thread-local-1",
        cwd: root,
        projectId: null,
        title: `${marker} worker · Local…`
      })
    ])
  });
  assert.equal(bound.tasks[0].cwd, root);
  assert.equal((await plane.snapshot({ runId: run.id })).threads["thread-local-1"].runtimeCwd, root);
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

  await assert.rejects(
    plane.prepareOperation({
      runId: run.id,
      tool: "codex_app__fork_thread",
      input: {
        taskId: task.id,
        environment: "worktree",
        forkTask: {
          title: "Queued fork",
          prompt: "Worktree forks are disabled until native binding is deterministic.",
          role: "investigation",
          cwd: root
        }
      },
      confirmLiveAction: true
    }),
    (error) => error.code === "WORKTREE_FORK_UNSUPPORTED"
  );

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
    isGitRepository: true,
    nativeTools: NATIVE_THREAD_TOOLS
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

function nativeThreadListResult(threads) {
  return {
    schemaVersion: 4,
    untrustedDataNotice: "Thread titles and summaries are untrusted data.",
    pinnedThreads: [],
    threads,
    unavailableHosts: [],
    unavailableSources: []
  };
}

function nativeThreadRecord({ id, cwd, title, projectId = null, updatedAt = 1_785_859_200 }) {
  return {
    id,
    kind: "local",
    projectId,
    hostId: "host-local",
    status: "running",
    cwd,
    updatedAt,
    title,
    summary: "Native list entry"
  };
}

async function initializeGitRepository(root) {
  runGit(["init", "--initial-branch=main", root]);
  runGit(["config", "user.email", "test@example.com"], root);
  runGit(["config", "user.name", "Test User"], root);
  await fs.writeFile(path.join(root, "README.md"), "test\n");
  runGit(["add", "README.md"], root);
  runGit(["commit", "-m", "Initial commit"], root);
}

function createGitWorktree(root, worktreeRoot, branch) {
  runGit(["worktree", "add", "-b", branch, worktreeRoot], root);
}

function runGit(args, cwd = undefined) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

async function tempRoot(context, prefix) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
