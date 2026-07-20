import fs from "node:fs/promises";
import path from "node:path";
import { Ledger } from "./ledger.mjs";
import { AppServerClient } from "./app-server-client.mjs";
import { makeId, nowIso } from "./ids.mjs";
import { transition } from "./state-machine.mjs";

const ALLOWED_EFFORTS = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra"
]);

const ALLOWED_SANDBOXES = new Set([
  "read-only",
  "workspace-write",
  "danger-full-access"
]);

const ALLOWED_MESSAGE_TYPES = new Set([
  "QUESTION",
  "PROPOSAL",
  "STATUS",
  "REVIEW",
  "DECISION",
  "CANCEL"
]);

export class ControlPlaneError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "ControlPlaneError";
    this.code = code;
    this.details = details;
  }
}

export class ControlPlane {
  constructor({
    ledger = new Ledger(),
    appServerFactory = () => new AppServerClient(),
    clock = Date
  } = {}) {
    this.ledger = ledger;
    this.appServerFactory = appServerFactory;
    this.clock = clock;
    this.appServer = null;
  }

  async preflight({ cwd = process.cwd(), connect = false } = {}) {
    const absoluteCwd = path.resolve(cwd);
    const stat = await fs.stat(absoluteCwd);
    if (!stat.isDirectory()) {
      throw new ControlPlaneError("INVALID_CWD", `Not a directory: ${absoluteCwd}`);
    }

    const result = {
      ok: true,
      cwd: absoluteCwd,
      node: process.version,
      appServerConnected: false,
      models: [],
      constraints: {
        liveDispatchRequiresExplicitConfirmation: true,
        approvals: "never",
        defaultSandbox: "workspace-write"
      }
    };

    if (connect) {
      const client = await this.#client();
      const models = await client.listModels();
      result.appServerConnected = true;
      result.models = normalizeModelList(models);
    }
    return result;
  }

  async createRun({
    objective,
    controllerThreadId = null,
    controllerHostId = null,
    executionMode = "dry-run",
    maxRoundTrips = 8
  }) {
    if (typeof objective !== "string" || !objective.trim()) {
      throw new ControlPlaneError("INVALID_OBJECTIVE", "A non-empty objective is required");
    }
    if (!["dry-run", "live"].includes(executionMode)) {
      throw new ControlPlaneError("INVALID_EXECUTION_MODE", `Unsupported mode: ${executionMode}`);
    }
    if (!Number.isInteger(maxRoundTrips) || maxRoundTrips < 1 || maxRoundTrips > 64) {
      throw new ControlPlaneError("INVALID_MAX_ROUNDS", "maxRoundTrips must be an integer from 1 to 64");
    }

    const id = makeId("run");
    const at = nowIso(this.clock);
    const run = {
      id,
      objective: objective.trim(),
      status: "active",
      executionMode,
      createdAt: at,
      updatedAt: at,
      maxRoundTrips,
      controller: {
        role: "controller",
        threadId: controllerThreadId,
        hostId: controllerHostId
      },
      tasks: {},
      sessions: {},
      messages: [],
      events: [
        event("RUN_CREATED", "Control run created", { executionMode }, at)
      ]
    };

    await this.ledger.update((draft) => {
      draft.runs[id] = run;
      return { runId: id };
    });
    return structuredClone(run);
  }

  async addTask({
    runId,
    title,
    prompt,
    role,
    cwd,
    model,
    effort = "medium",
    sandbox = "workspace-write"
  }) {
    validateTaskInput({ title, prompt, role, cwd, model, effort, sandbox });
    const absoluteCwd = path.resolve(cwd);
    const stat = await fs.stat(absoluteCwd);
    if (!stat.isDirectory()) {
      throw new ControlPlaneError("INVALID_CWD", `Not a directory: ${absoluteCwd}`);
    }

    const taskId = makeId("task");
    const at = nowIso(this.clock);
    const task = {
      id: taskId,
      title: title.trim(),
      prompt: prompt.trim(),
      role: role.trim(),
      cwd: absoluteCwd,
      status: "created",
      profile: { model, effort, sandbox },
      sessionId: null,
      activeTurnId: null,
      createdAt: at,
      updatedAt: at,
      roundTrips: 0,
      result: null,
      error: null,
      artifacts: [],
      verification: []
    };

    await this.ledger.update((draft) => {
      const run = requireRun(draft, runId);
      requireRunOpen(run);
      run.tasks[taskId] = task;
      run.updatedAt = at;
      run.events.push(event("TASK_CREATED", `Task created: ${task.title}`, { taskId }, at));
      return { taskId };
    });
    return structuredClone(task);
  }

  async previewDispatch({ runId, taskId }) {
    const { run, task } = await this.#readTask(runId, taskId);
    return {
      live: run.executionMode === "live",
      requiresConfirmation: true,
      threadStart: threadStartParams(run, task),
      turnStart: {
        threadId: "<created-thread-id>",
        input: [{ type: "text", text: assignmentPrompt(run, task) }],
        model: task.profile.model,
        effort: task.profile.effort,
        sandboxPolicy: sandboxPolicy(task),
        approvalPolicy: "never",
        outputSchema: workerOutputSchema()
      }
    };
  }

  async dispatchTask({ runId, taskId, confirmLiveDispatch = false }) {
    const { run, task } = await this.#readTask(runId, taskId);
    if (run.executionMode !== "live") {
      throw new ControlPlaneError(
        "DRY_RUN_ONLY",
        "This run is dry-run. Create a live run before dispatching real Codex sessions."
      );
    }
    if (confirmLiveDispatch !== true) {
      throw new ControlPlaneError(
        "LIVE_CONFIRMATION_REQUIRED",
        "Live thread creation requires confirmLiveDispatch=true from an explicit user request"
      );
    }
    if (!["created", "failed", "blocked", "review"].includes(task.status)) {
      throw new ControlPlaneError("TASK_NOT_DISPATCHABLE", `Task is ${task.status}`);
    }

    const client = await this.#client();
    const started = await client.startThread(threadStartParams(run, task));
    const threadId = started?.thread?.id;
    if (!threadId) {
      throw new ControlPlaneError("THREAD_START_FAILED", "thread/start returned no thread id", started);
    }

    await client.setThreadName(threadId, `[Control] ${task.role}: ${task.title}`).catch(() => null);
    const turn = await client.startTurn({
      threadId,
      input: [{ type: "text", text: assignmentPrompt(run, task) }],
      model: task.profile.model,
      effort: task.profile.effort,
      sandboxPolicy: sandboxPolicy(task),
      approvalPolicy: "never",
      outputSchema: workerOutputSchema()
    });
    const turnId = turn?.turn?.id || null;
    const at = nowIso(this.clock);

    await this.ledger.update((draft) => {
      const draftRun = requireRun(draft, runId);
      const draftTask = requireTask(draftRun, taskId);
      transition(draftTask, "task", "dispatched", at);
      transition(draftTask, "task", "running", at);
      draftTask.sessionId = threadId;
      draftTask.activeTurnId = turnId;
      draftTask.roundTrips += 1;

      draftRun.sessions[threadId] = {
        id: threadId,
        hostId: null,
        role: draftTask.role,
        cwd: draftTask.cwd,
        status: "active",
        profile: structuredClone(draftTask.profile),
        createdAt: at,
        updatedAt: at
      };
      draftRun.messages.push(
        messageEnvelope(draftRun, draftTask, "ASSIGN", draftTask.prompt, null, at)
      );
      draftRun.updatedAt = at;
      draftRun.events.push(
        event("TASK_DISPATCHED", `Task dispatched to ${threadId}`, { taskId, threadId, turnId }, at)
      );
    });

    return { runId, taskId, threadId, turnId, status: "running" };
  }

  async sendMessage({
    runId,
    taskId,
    text,
    type = "QUESTION",
    model,
    effort,
    confirmLiveDispatch = false
  }) {
    if (typeof text !== "string" || !text.trim()) {
      throw new ControlPlaneError("INVALID_MESSAGE", "A non-empty message is required");
    }
    if (!ALLOWED_MESSAGE_TYPES.has(type)) {
      throw new ControlPlaneError("INVALID_MESSAGE_TYPE", `Unsupported message type: ${type}`);
    }
    const { run, task } = await this.#readTask(runId, taskId);
    if (run.executionMode !== "live" || confirmLiveDispatch !== true) {
      throw new ControlPlaneError(
        "LIVE_CONFIRMATION_REQUIRED",
        "Sending a live follow-up requires a live run and confirmLiveDispatch=true"
      );
    }
    if (!task.sessionId) {
      throw new ControlPlaneError("NO_SESSION", "Task has no assigned session");
    }
    if (!["review", "blocked", "dispatched"].includes(task.status)) {
      throw new ControlPlaneError(
        "TASK_NOT_READY_FOR_MESSAGE",
        `Task must be idle before a follow-up; current status is ${task.status}`
      );
    }
    if (task.roundTrips >= run.maxRoundTrips) {
      throw new ControlPlaneError("ROUND_LIMIT", "Maximum task round trips reached");
    }

    const selectedModel = model || task.profile.model;
    const selectedEffort = effort || task.profile.effort;
    if (!ALLOWED_EFFORTS.has(selectedEffort)) {
      throw new ControlPlaneError("INVALID_EFFORT", `Unsupported effort: ${selectedEffort}`);
    }
    const client = await this.#client();
    const turn = await client.startTurn({
      threadId: task.sessionId,
      input: [{ type: "text", text: text.trim() }],
      model: selectedModel,
      effort: selectedEffort,
      sandboxPolicy: sandboxPolicy(task),
      approvalPolicy: "never",
      outputSchema: workerOutputSchema()
    });
    const turnId = turn?.turn?.id || null;
    const at = nowIso(this.clock);
    await this.ledger.update((draft) => {
      const draftRun = requireRun(draft, runId);
      const draftTask = requireTask(draftRun, taskId);
      if (draftTask.status === "review") {
        transition(draftTask, "task", "dispatched", at);
        transition(draftTask, "task", "running", at);
      } else if (draftTask.status === "blocked") {
        transition(draftTask, "task", "running", at);
      } else if (draftTask.status === "dispatched") {
        transition(draftTask, "task", "running", at);
      }
      draftTask.activeTurnId = turnId;
      draftTask.roundTrips += 1;
      const session = draftRun.sessions[draftTask.sessionId];
      if (session && session.status === "idle") transition(session, "session", "active", at);
      draftRun.messages.push(messageEnvelope(draftRun, draftTask, type, text.trim(), null, at));
      draftRun.updatedAt = at;
      draftRun.events.push(
        event("MESSAGE_SENT", `Follow-up sent to ${draftTask.sessionId}`, { taskId, turnId }, at)
      );
    });
    return { runId, taskId, threadId: task.sessionId, turnId };
  }

  async relayMessage({
    runId,
    fromTaskId,
    toTaskId,
    text,
    type = "PROPOSAL",
    confirmLiveDispatch = false
  }) {
    if (fromTaskId === toTaskId) {
      throw new ControlPlaneError("INVALID_RELAY", "Relay source and recipient must be different");
    }
    if (typeof text !== "string" || !text.trim()) {
      throw new ControlPlaneError("INVALID_MESSAGE", "A non-empty relay message is required");
    }
    if (!ALLOWED_MESSAGE_TYPES.has(type)) {
      throw new ControlPlaneError("INVALID_MESSAGE_TYPE", `Unsupported message type: ${type}`);
    }
    const ledger = await this.ledger.read();
    const run = requireRun(ledger, runId);
    const sourceTask = requireTask(run, fromTaskId);
    const targetTask = requireTask(run, toTaskId);
    if (run.executionMode !== "live" || confirmLiveDispatch !== true) {
      throw new ControlPlaneError(
        "LIVE_CONFIRMATION_REQUIRED",
        "Relaying between live sessions requires confirmLiveDispatch=true"
      );
    }
    if (!sourceTask.sessionId || !targetTask.sessionId) {
      throw new ControlPlaneError(
        "NO_SESSION",
        "Both relay source and recipient must have assigned sessions"
      );
    }
    if (!["review", "blocked", "dispatched"].includes(targetTask.status)) {
      throw new ControlPlaneError(
        "RECIPIENT_NOT_IDLE",
        `Relay recipient must be idle; current status is ${targetTask.status}`
      );
    }
    if (targetTask.roundTrips >= run.maxRoundTrips) {
      throw new ControlPlaneError("ROUND_LIMIT", "Maximum recipient round trips reached");
    }

    const client = await this.#client();
    const turn = await client.startTurn({
      threadId: targetTask.sessionId,
      input: [
        {
          type: "text",
          text: relayPrompt(run, sourceTask, targetTask, type, text.trim())
        }
      ],
      model: targetTask.profile.model,
      effort: targetTask.profile.effort,
      sandboxPolicy: sandboxPolicy(targetTask),
      approvalPolicy: "never",
      outputSchema: workerOutputSchema()
    });
    const turnId = turn?.turn?.id || null;
    const at = nowIso(this.clock);
    await this.ledger.update((draft) => {
      const draftRun = requireRun(draft, runId);
      const draftSource = requireTask(draftRun, fromTaskId);
      const draftTarget = requireTask(draftRun, toTaskId);
      if (draftTarget.status === "review") {
        transition(draftTarget, "task", "dispatched", at);
        transition(draftTarget, "task", "running", at);
      } else {
        transition(draftTarget, "task", "running", at);
      }
      draftTarget.activeTurnId = turnId;
      draftTarget.roundTrips += 1;
      const session = draftRun.sessions[draftTarget.sessionId];
      if (session?.status === "idle" || session?.status === "blocked") {
        transition(session, "session", "active", at);
      }
      draftRun.messages.push(
        messageEnvelope(draftRun, draftTarget, type, text.trim(), null, at, {
          senderTask: draftSource
        })
      );
      draftRun.updatedAt = at;
      draftRun.events.push(
        event(
          "MESSAGE_RELAYED",
          `Relayed ${draftSource.sessionId} -> ${draftTarget.sessionId}`,
          { fromTaskId, toTaskId, turnId, type },
          at
        )
      );
    });
    return {
      runId,
      fromTaskId,
      toTaskId,
      fromThreadId: sourceTask.sessionId,
      toThreadId: targetTask.sessionId,
      turnId
    };
  }

  async pollTask({ runId, taskId }) {
    const { task } = await this.#readTask(runId, taskId);
    if (!task.sessionId) {
      throw new ControlPlaneError("NO_SESSION", "Task has no assigned session");
    }
    const client = await this.#client();
    const response = await client.readThread(task.sessionId, true);
    const observed = observeThread(response?.thread);
    const at = nowIso(this.clock);

    await this.ledger.update((draft) => {
      const run = requireRun(draft, runId);
      const draftTask = requireTask(run, taskId);
      const session = run.sessions[draftTask.sessionId];
      draftTask.updatedAt = at;
      if (observed.error) {
        if (draftTask.status === "running") transition(draftTask, "task", "failed", at);
        draftTask.error = observed.error;
        if (session?.status === "active") transition(session, "session", "failed", at);
      } else if (observed.completed && draftTask.status === "running") {
        draftTask.activeTurnId = null;
        draftTask.result = observed.result;
        draftTask.artifacts = observed.artifacts;
        draftTask.verification = observed.verification;
        const reportedStatus = observed.result?.status;
        if (reportedStatus === "blocked") {
          transition(draftTask, "task", "blocked", at);
          if (session?.status === "active") transition(session, "session", "blocked", at);
          run.messages.push(
            messageEnvelope(run, draftTask, "BLOCKED", observed.result, null, at, {
              artifacts: observed.artifacts,
              verification: observed.verification
            })
          );
          run.events.push(
            event("TASK_BLOCKED", `Task blocked: ${draftTask.title}`, { taskId }, at)
          );
        } else if (reportedStatus === "failed") {
          transition(draftTask, "task", "failed", at);
          draftTask.error = observed.result?.summary || "Worker reported failure";
          if (session?.status === "active") transition(session, "session", "failed", at);
          run.messages.push(
            messageEnvelope(run, draftTask, "RESULT", observed.result, null, at, {
              artifacts: observed.artifacts,
              verification: observed.verification
            })
          );
          run.events.push(
            event("TASK_FAILED", `Task failed: ${draftTask.title}`, { taskId }, at)
          );
          settleRun(run, at);
        } else {
          transition(draftTask, "task", "review", at);
          if (session?.status === "active") transition(session, "session", "idle", at);
          run.messages.push(
            messageEnvelope(run, draftTask, "RESULT", observed.result, null, at, {
              artifacts: observed.artifacts,
              verification: observed.verification
            })
          );
          run.events.push(
            event("RESULT_READY", `Task ready for review: ${draftTask.title}`, { taskId }, at)
          );
        }
      } else {
        run.events.push(
          event("TASK_POLLED", `Task status observed: ${observed.status}`, { taskId }, at)
        );
      }
      run.updatedAt = at;
    });
    return { runId, taskId, ...observed };
  }

  async decideTask({ runId, taskId, decision, note = "" }) {
    if (!["accept", "reject", "fail"].includes(decision)) {
      throw new ControlPlaneError("INVALID_DECISION", `Unsupported decision: ${decision}`);
    }
    const at = nowIso(this.clock);
    const { ledger } = await this.ledger.update((draft) => {
      const run = requireRun(draft, runId);
      const task = requireTask(run, taskId);
      if (task.status !== "review") {
        throw new ControlPlaneError("TASK_NOT_IN_REVIEW", `Task is ${task.status}`);
      }
      if (decision === "accept") {
        transition(task, "task", "completed", at);
        const session = task.sessionId ? run.sessions[task.sessionId] : null;
        if (session?.status === "idle") transition(session, "session", "completed", at);
      } else if (decision === "reject") {
        transition(task, "task", "dispatched", at);
      } else {
        transition(task, "task", "failed", at);
        task.error = note || "Rejected by controller";
      }
      run.messages.push(
        messageEnvelope(run, task, "DECISION", { decision, note }, null, at)
      );
      run.events.push(
        event("TASK_DECIDED", `Task decision: ${decision}`, { taskId, note }, at)
      );
      settleRun(run, at);
      run.updatedAt = at;
    });
    return structuredClone(ledger.runs[runId].tasks[taskId]);
  }

  async stopTask({ runId, taskId, confirmLiveDispatch = false }) {
    const { run, task } = await this.#readTask(runId, taskId);
    if (run.executionMode === "live" && confirmLiveDispatch !== true) {
      throw new ControlPlaneError(
        "LIVE_CONFIRMATION_REQUIRED",
        "Stopping a live turn requires confirmLiveDispatch=true"
      );
    }
    if (run.executionMode === "live" && task.sessionId && task.activeTurnId) {
      const client = await this.#client();
      await client.interruptTurn(task.sessionId, task.activeTurnId);
    }
    const at = nowIso(this.clock);
    await this.ledger.update((draft) => {
      const draftRun = requireRun(draft, runId);
      const draftTask = requireTask(draftRun, taskId);
      if (!["completed", "failed", "cancelled"].includes(draftTask.status)) {
        transition(draftTask, "task", "cancelled", at);
      }
      draftTask.activeTurnId = null;
      const session = draftTask.sessionId ? draftRun.sessions[draftTask.sessionId] : null;
      if (session && !["archived", "completed", "failed"].includes(session.status)) {
        transition(session, "session", "failed", at);
      }
      draftRun.events.push(event("TASK_STOPPED", "Task stopped by controller", { taskId }, at));
      settleRun(draftRun, at);
    });
    return { runId, taskId, status: "cancelled" };
  }

  async archiveSession({ runId, threadId, confirmLiveDispatch = false }) {
    const ledger = await this.ledger.read();
    const run = requireRun(ledger, runId);
    const session = run.sessions[threadId];
    if (!session) throw new ControlPlaneError("SESSION_NOT_FOUND", `Unknown session: ${threadId}`);
    if (run.executionMode === "live") {
      if (confirmLiveDispatch !== true) {
        throw new ControlPlaneError(
          "LIVE_CONFIRMATION_REQUIRED",
          "Archiving a live thread requires confirmLiveDispatch=true"
        );
      }
      const client = await this.#client();
      await client.archiveThread(threadId);
    }
    const at = nowIso(this.clock);
    await this.ledger.update((draft) => {
      const draftRun = requireRun(draft, runId);
      const draftSession = draftRun.sessions[threadId];
      if (draftSession.status !== "archived") {
        transition(draftSession, "session", "archived", at);
      }
      draftRun.events.push(
        event("SESSION_ARCHIVED", `Session archived: ${threadId}`, { threadId }, at)
      );
    });
    return { runId, threadId, status: "archived" };
  }

  async simulateTask({ runId, taskId, summary, artifacts = [], verification = [] }) {
    const at = nowIso(this.clock);
    const simulatedThreadId = `sim_${taskId}`;
    const { ledger } = await this.ledger.update((draft) => {
      const run = requireRun(draft, runId);
      if (run.executionMode !== "dry-run") {
        throw new ControlPlaneError("LIVE_RUN", "simulateTask is only available in dry-run mode");
      }
      const task = requireTask(run, taskId);
      transition(task, "task", "dispatched", at);
      transition(task, "task", "running", at);
      task.sessionId = simulatedThreadId;
      task.roundTrips = 1;
      run.sessions[simulatedThreadId] = {
        id: simulatedThreadId,
        hostId: null,
        role: task.role,
        cwd: task.cwd,
        status: "active",
        profile: structuredClone(task.profile),
        createdAt: at,
        updatedAt: at
      };
      run.messages.push(messageEnvelope(run, task, "ASSIGN", task.prompt, null, at));
      transition(task, "task", "review", at);
      task.result = { status: "completed", summary };
      task.artifacts = [...artifacts];
      task.verification = [...verification];
      transition(run.sessions[simulatedThreadId], "session", "idle", at);
      run.messages.push(
        messageEnvelope(run, task, "RESULT", task.result, null, at, {
          artifacts: task.artifacts,
          verification: task.verification
        })
      );
      run.events.push(
        event("TASK_SIMULATED", `Dry-run result ready: ${task.title}`, { taskId }, at)
      );
    });
    return structuredClone(ledger.runs[runId].tasks[taskId]);
  }

  async snapshot({ runId = null } = {}) {
    const ledger = await this.ledger.read();
    if (!runId) return ledger;
    return structuredClone(requireRun(ledger, runId));
  }

  async close() {
    await this.appServer?.stop();
    this.appServer = null;
  }

  async #client() {
    if (!this.appServer) {
      this.appServer = this.appServerFactory();
    }
    await this.appServer.start();
    return this.appServer;
  }

  async #readTask(runId, taskId) {
    const ledger = await this.ledger.read();
    const run = requireRun(ledger, runId);
    const task = requireTask(run, taskId);
    return { run, task };
  }
}

function validateTaskInput({ title, prompt, role, cwd, model, effort, sandbox }) {
  for (const [name, value] of Object.entries({ title, prompt, role, cwd, model })) {
    if (typeof value !== "string" || !value.trim()) {
      throw new ControlPlaneError("INVALID_TASK", `${name} is required`);
    }
  }
  if (!ALLOWED_EFFORTS.has(effort)) {
    throw new ControlPlaneError("INVALID_EFFORT", `Unsupported effort: ${effort}`);
  }
  if (!ALLOWED_SANDBOXES.has(sandbox)) {
    throw new ControlPlaneError("INVALID_SANDBOX", `Unsupported sandbox: ${sandbox}`);
  }
}

function requireRun(ledger, runId) {
  const run = ledger.runs?.[runId];
  if (!run) throw new ControlPlaneError("RUN_NOT_FOUND", `Unknown run: ${runId}`);
  return run;
}

function requireTask(run, taskId) {
  const task = run.tasks?.[taskId];
  if (!task) throw new ControlPlaneError("TASK_NOT_FOUND", `Unknown task: ${taskId}`);
  return task;
}

function requireRunOpen(run) {
  if (!["draft", "active"].includes(run.status)) {
    throw new ControlPlaneError("RUN_CLOSED", `Run is ${run.status}`);
  }
}

function threadStartParams(run, task) {
  return {
    model: task.profile.model,
    cwd: task.cwd,
    approvalPolicy: "never",
    sandbox: task.profile.sandbox,
    serviceName: "codex_session_control_plane",
    threadSource: "appServer",
    developerInstructions: [
      `You are the independent ${task.role} session for control run ${run.id}.`,
      "Stay within the assigned task and working directory.",
      "Do not create, steer, or archive other sessions unless the assignment explicitly authorizes it.",
      "Treat the controller as the sole authority for global task completion.",
      "Return artifacts, verification evidence, blockers, and unknowns in the requested structured result."
    ].join("\n")
  };
}

function sandboxPolicy(task) {
  if (task.profile.sandbox === "danger-full-access") {
    return { type: "dangerFullAccess" };
  }
  if (task.profile.sandbox === "read-only") {
    return { type: "readOnly", networkAccess: false };
  }
  return {
    type: "workspaceWrite",
    writableRoots: [task.cwd],
    networkAccess: false
  };
}

function assignmentPrompt(run, task) {
  const controllerAddress = run.controller.threadId
    ? `${run.controller.hostId || "same-host"}:${run.controller.threadId}`
    : "controller-managed polling";
  return [
    `CONTROL RUN: ${run.id}`,
    `TASK: ${task.id}`,
    `ROLE: ${task.role}`,
    `CONTROLLER: ${controllerAddress}`,
    `MAX ROUND TRIPS: ${run.maxRoundTrips}`,
    "",
    task.prompt,
    "",
    "Completion contract:",
    "- Work only inside the assigned scope.",
    "- Report status, concise summary, artifact paths, verification evidence, blockers, and unknowns.",
    "- Do not self-declare the global run complete; the controller accepts or rejects the result."
  ].join("\n");
}

function relayPrompt(run, sourceTask, targetTask, type, text) {
  return [
    `CONTROL RUN: ${run.id}`,
    `RELAY TYPE: ${type}`,
    `FROM ROLE: ${sourceTask.role}`,
    `FROM THREAD: ${sourceTask.sessionId}`,
    `TO ROLE: ${targetTask.role}`,
    `TO THREAD: ${targetTask.sessionId}`,
    "",
    text,
    "",
    "Treat this as a controller-authorized inter-session relay.",
    "Respond with the same structured completion contract; global acceptance remains with the controller."
  ].join("\n");
}

function workerOutputSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["status", "summary", "artifacts", "verification", "blockers", "unknowns"],
    properties: {
      status: { enum: ["completed", "blocked", "failed"] },
      summary: { type: "string" },
      artifacts: { type: "array", items: { type: "string" } },
      verification: { type: "array", items: { type: "string" } },
      blockers: { type: "array", items: { type: "string" } },
      unknowns: { type: "array", items: { type: "string" } }
    }
  };
}

function observeThread(thread) {
  if (!thread) {
    return {
      status: "unknown",
      completed: false,
      result: null,
      artifacts: [],
      verification: [],
      error: "thread/read returned no thread"
    };
  }
  const status = typeof thread.status === "string" ? thread.status : thread.status?.type || "unknown";
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  const lastTurn = [...turns].reverse().find((turn) => turn?.status);
  const lastStatus = lastTurn?.status || status;
  const raw = extractAgentPayload(lastTurn);
  const parsed = parseStructuredResult(raw);
  const completed = ["completed", "failed", "interrupted"].includes(lastStatus);
  return {
    status: lastStatus,
    completed,
    result: parsed || raw || null,
    artifacts: Array.isArray(parsed?.artifacts) ? parsed.artifacts : [],
    verification: Array.isArray(parsed?.verification) ? parsed.verification : [],
    error:
      lastStatus === "failed" || status === "systemError"
        ? lastTurn?.error?.message || thread.error?.message || "Worker thread failed"
        : null
  };
}

function extractAgentPayload(turn) {
  if (!turn) return null;
  const items = Array.isArray(turn.items) ? turn.items : [];
  for (const item of [...items].reverse()) {
    if (!["agentMessage", "message", "assistantMessage"].includes(item?.type)) continue;
    if (typeof item.text === "string") return item.text;
    if (typeof item.message === "string") return item.message;
    if (typeof item.content === "string") return item.content;
    if (Array.isArray(item.content)) {
      const text = item.content
        .map((part) => (typeof part === "string" ? part : part?.text || ""))
        .join("");
      if (text) return text;
    }
  }
  return null;
}

function parseStructuredResult(value) {
  if (!value || typeof value !== "string") return value && typeof value === "object" ? value : null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeModelList(response) {
  const data = response?.data || response?.models || [];
  if (!Array.isArray(data)) return [];
  return data.map((model) => ({
    id: model.id || model.model || model.slug,
    displayName: model.displayName || model.name || model.id,
    efforts: model.supportedReasoningEfforts || model.reasoningEfforts || []
  }));
}

function event(type, message, data, at) {
  return {
    id: makeId("event"),
    type,
    message,
    data,
    at
  };
}

function messageEnvelope(run, task, type, payload, replyTo, at, extra = {}) {
  const senderTask = extra.senderTask || null;
  const isWorkerResult = type === "RESULT" || type === "BLOCKED";
  return {
    schemaVersion: "control-plane-message/v1",
    runId: run.id,
    taskId: task.id,
    messageId: makeId("msg"),
    replyTo,
    sender: {
      role: senderTask?.role || (isWorkerResult ? task.role : "controller"),
      threadId:
        senderTask?.sessionId || (isWorkerResult ? task.sessionId : run.controller.threadId),
      hostId: senderTask || isWorkerResult ? null : run.controller.hostId
    },
    recipient: {
      role: isWorkerResult ? "controller" : task.role,
      threadId: isWorkerResult ? run.controller.threadId : task.sessionId,
      hostId: isWorkerResult ? run.controller.hostId : null
    },
    type,
    createdAt: at,
    revision: task.roundTrips + 1,
    maxHops: 1,
    payload,
    artifacts: extra.artifacts || [],
    verification: extra.verification || []
  };
}

function settleRun(run, at) {
  const tasks = Object.values(run.tasks);
  if (tasks.length === 0) return;
  if (tasks.every((task) => task.status === "completed")) {
    if (run.status === "active") transition(run, "run", "review", at);
    if (run.status === "review") transition(run, "run", "completed", at);
    return;
  }
  if (tasks.every((task) => ["completed", "failed", "cancelled"].includes(task.status))) {
    if (run.status === "active") transition(run, "run", "failed", at);
  }
}
