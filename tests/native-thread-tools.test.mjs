import assert from "node:assert/strict";
import test from "node:test";
import {
  CORE_NATIVE_THREAD_TOOLS,
  MANAGEMENT_NATIVE_THREAD_TOOLS,
  NATIVE_THREAD_TOOLS,
  PREPARABLE_THREAD_TOOLS,
  buildDispatchPreparation,
  buildNativeOperationIntent,
  buildWorkerPrompt,
  capabilityReport,
  createTaskRecord,
  resolveProjectLaunch
} from "../scripts/lib/native-thread-tools.mjs";

test("capability inventory covers the complete native task family", () => {
  assert.equal(CORE_NATIVE_THREAD_TOOLS.length, 6);
  assert.equal(MANAGEMENT_NATIVE_THREAD_TOOLS.length, 7);
  assert.equal(NATIVE_THREAD_TOOLS.length, 13);
  assert.equal(PREPARABLE_THREAD_TOOLS.length, 11);
  const missing = capabilityReport(["codex_app__list_projects"]);
  assert.equal(missing.coreReady, false);
  assert.ok(missing.missingCore.includes("codex_app__create_thread"));
  const complete = capabilityReport(NATIVE_THREAD_TOOLS);
  assert.equal(complete.complete, true);
  assert.deepEqual(complete.missingManagement, []);
});

test("task contracts guard model authority and Coding Agent Orchestrator scope", () => {
  const base = {
    title: "Worker",
    prompt: "Complete the slice.",
    role: "implementation",
    cwd: "/tmp/project"
  };
  assert.throws(
    () => createTaskRecord({ ...base, model: "gpt-example" }, { id: "task_1", at: "now" }),
    (error) => error.code === "MODEL_AUTHORITY_REQUIRED"
  );
  assert.throws(
    () => createTaskRecord({ ...base, workerMode: "coding-agent-orchestrator" }, { id: "task_1", at: "now" }),
    (error) => error.code === "CAO_SCOPE_REQUIRED"
  );
  assert.throws(
    () => createTaskRecord({ ...base, codingAgentOrchestratorDeliveryMode: "ONE_SHOT_QUALITY" }, { id: "task_1", at: "now" }),
    (error) => error.code === "ONE_SHOT_AUTHORITY_REQUIRED"
  );
  const task = createTaskRecord(
    {
      ...base,
      workerMode: "coding-agent-orchestrator",
      codingAgentOrchestratorScope: "src and focused tests",
      model: "gpt-example",
      thinking: "high",
      profileAuthority: "user_request:explicit model choice",
      maxDelegationDepth: 1,
      delegationAuthority: "user_request:one internal worker layer"
    },
    { id: "task_1", at: "now" }
  );
  const preparation = buildDispatchPreparation({ id: "run_1" }, task);
  assert.equal(preparation.createThreadTemplate.model, "gpt-example");
  assert.equal(preparation.createThreadTemplate.thinking, "high");
  assert.match(preparation.createThreadTemplate.prompt, /Coding Agent Orchestrator workflow/);
  assert.match(preparation.createThreadTemplate.prompt, /\$coding-agent-orchestrator/);
  assert.match(preparation.createThreadTemplate.prompt, /\.CAO\/.*legacy `\.coding-agents\/` state/);
  assert.doesNotMatch(preparation.createThreadTemplate.prompt, /\.coding-agent-orchestrator/);
  assert.match(preparation.createThreadTemplate.prompt, /src and focused tests/);
  const directTask = createTaskRecord(base, { id: "task_2", at: "now" });
  const directPrompt = buildWorkerPrompt({ id: "run_1" }, directTask);
  assert.doesNotMatch(directPrompt, /Coding Agent Orchestrator workflow|\$coding-agent-orchestrator/);
});

test("project resolution maps Git to worktree and non-Git to local", () => {
  const task = createTaskRecord(
    { title: "Worker", prompt: "Work.", role: "worker", cwd: "/tmp/project" },
    { id: "task_1", at: "now" }
  );
  const preparation = buildDispatchPreparation({ id: "run_1" }, task);
  const worktree = resolveProjectLaunch(task, preparation, {
    projectId: "project-1",
    path: "/tmp/project",
    projectKind: "local",
    isGitRepository: true
  });
  assert.equal(worktree.arguments.target.environment.type, "worktree");
  const local = resolveProjectLaunch(task, preparation, {
    projectId: "project-1",
    path: "/tmp/project",
    projectKind: "local",
    isGitRepository: false
  });
  assert.equal(local.arguments.target.environment.type, "local");
  assert.throws(
    () => resolveProjectLaunch(task, preparation, { projectId: "x", path: "/tmp/other" }),
    (error) => error.code === "PROJECT_PATH_MISMATCH"
  );
});

test("every post-launch native tool builds an exact addressed intent", () => {
  const tasks = {
    task_a: {
      id: "task_a",
      threadId: "thread-a",
      hostId: "host-a",
      lastCursor: "cursor-a"
    },
    task_b: {
      id: "task_b",
      threadId: "thread-b",
      hostId: null,
      lastCursor: null
    }
  };
  const run = { id: "run_1" };
  const operations = {
    op_handoff: {
      id: "op_handoff",
      tool: "codex_app__handoff_thread",
      runtimeOperationId: "runtime-1",
      runtimeRevision: 3,
      taskIds: ["task_a"]
    }
  };
  const cases = [
    ["codex_app__list_threads", { limit: 20 }, { limit: 20 }],
    ["codex_app__wait_threads", { taskIds: ["task_a", "task_b"], timeoutMs: 10 }, { timeoutMs: 10 }],
    ["codex_app__read_thread", { taskId: "task_a", includeOutputs: true }, { threadId: "thread-a" }],
    ["codex_app__send_message_to_thread", { taskId: "task_a", prompt: "Continue." }, { prompt: "Continue." }],
    ["codex_app__fork_thread", { taskId: "task_a", environment: "worktree", forkTask: {} }, { threadId: "thread-a" }],
    ["codex_app__handoff_thread", { taskId: "task_a", destinationHostId: "host-b" }, { destinationHostId: "host-b" }],
    ["codex_app__get_handoff_status", { handoffOperationId: "op_handoff", waitMs: 5 }, { operationId: "runtime-1" }],
    ["codex_app__set_thread_title", { taskId: "task_a", title: "New title" }, { title: "New title" }],
    ["codex_app__set_thread_pinned", { taskId: "task_a", pinned: true }, { pinned: true }],
    ["codex_app__set_thread_archived", { taskId: "task_a", archived: true }, { archived: true }],
    ["codex_app__navigate_to_codex_page", { taskId: "task_a" }, { threadId: "thread-a" }]
  ];
  for (const [tool, input, expected] of cases) {
    const intent = buildNativeOperationIntent({ run, tasks, tool, input, operations });
    assert.equal(intent.tool, tool);
    for (const [key, value] of Object.entries(expected)) assert.deepEqual(intent.arguments[key], value);
  }
  const wait = buildNativeOperationIntent({
    run,
    tasks,
    tool: "codex_app__wait_threads",
    input: { taskIds: ["task_a"] },
    operations
  });
  assert.equal(wait.arguments.targets[0].afterCursor, "cursor-a");
  assert.throws(
    () =>
      buildNativeOperationIntent({
        run,
        tasks,
        tool: "codex_app__get_handoff_status",
        input: { handoffOperationId: "op_handoff", waitMs: 60_001 },
        operations
      }),
    (error) => error.code === "INVALID_WAIT"
  );
});
