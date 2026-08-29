import fs from "node:fs/promises";
import fsSync from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { Ledger } from "./ledger.mjs";
import { makeId, nowIso } from "./ids.mjs";
import { transition } from "./state-machine.mjs";
import {
  MUTATING_THREAD_TOOLS,
  capabilityReport,
  createTaskRecord,
  buildDispatchPreparation,
  buildThreadIdentityMarker,
  buildNativeOperationIntent,
  resolveProjectLaunch
} from "./native-thread-tools.mjs";
import {
  acquireSettlementLock,
  releaseSettlementLock,
  inspectRepository,
  captureCandidate,
  integrateCandidate,
  verifyAdoption,
  removeExactWorktree,
  removeExactBranch
} from "./git-settlement.mjs";

const TERMINAL_TASK_STATES = new Set(["completed", "failed", "cancelled"]);
const MESSAGE_TYPES = new Set([
  "ASSIGN",
  "QUESTION",
  "PROPOSAL",
  "STATUS",
  "REVIEW",
  "RESULT",
  "DECISION",
  "CANCEL",
  "FORK"
]);
const OBSERVATION_STATES = new Set([
  "running",
  "idle",
  "completed",
  "review",
  "blocked",
  "needs_attention",
  "failed",
  "cancelled"
]);
const POST_COMPLETION_TOOLS = new Set([
  "codex_app__list_threads",
  "codex_app__read_thread",
  "codex_app__set_thread_title",
  "codex_app__move_thread_to_sidebar_section",
  "codex_app__set_thread_archived",
  "codex_app__navigate_to_codex_page"
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
  constructor({ ledger = new Ledger(), clock = Date } = {}) {
    this.ledger = ledger;
    this.clock = clock;
  }

  async preflight({ cwd = process.cwd(), availableTools = [] } = {}) {
    const absoluteCwd = path.resolve(cwd);
    const stat = await fs.stat(absoluteCwd);
    if (!stat.isDirectory()) {
      throw new ControlPlaneError("INVALID_CWD", `Not a directory: ${absoluteCwd}`);
    }
    const capabilities = capabilityReport(availableTools);
    return {
      ok: capabilities.coreReady,
      cwd: absoluteCwd,
      node: process.version,
      capabilities,
      ownership: {
        nativeTools: "visible Codex task runtime, worktrees, messages, waits, and UI management",
        controlPlane: "durable intents, bindings, observations, decisions, and audit events",
        controller: "tool execution, result normalization, integration, and final acceptance"
      },
      constraints: {
        pluginInvokesNativeTools: false,
        liveMutationRequiresExplicitConfirmation: true,
        modelOverrideRequiresExplicitUserAuthority: true,
        missingDirectStopTool: true
      }
    };
  }

  async createRun({
    objective,
    controllerThreadId = null,
    controllerHostId = null,
    executionMode = "dry-run",
    maxRoundTrips = 8
  }) {
    requireText(objective, "objective");
    for (const [name, value] of [
      ["controllerThreadId", controllerThreadId],
      ["controllerHostId", controllerHostId]
    ]) {
      if (value != null && (typeof value !== "string" || !value.trim())) {
        throw new ControlPlaneError("INVALID_CONTROLLER_ADDRESS", `${name} must be a string or null`);
      }
    }
    if (!["dry-run", "live"].includes(executionMode)) {
      throw new ControlPlaneError(
        "INVALID_EXECUTION_MODE",
        `Unsupported execution mode: ${executionMode}`
      );
    }
    if (!Number.isInteger(maxRoundTrips) || maxRoundTrips < 1 || maxRoundTrips > 64) {
      throw new ControlPlaneError(
        "INVALID_MAX_ROUNDS",
        "maxRoundTrips must be an integer from 1 to 64"
      );
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
        threadId: optionalText(controllerThreadId),
        hostId: optionalText(controllerHostId)
      },
      tasks: {},
      threads: {},
      operations: {},
      messages: [],
      events: [event("RUN_CREATED", "Task-control run created", { executionMode }, at)]
    };
    await this.ledger.update(async (draft) => {
      draft.runs[id] = run;
      return { runId: id };
    });
    return structuredClone(run);
  }

  async addTask(input) {
    const at = nowIso(this.clock);
    requireText(input.cwd, "cwd");
    const absoluteCwd = path.resolve(input.cwd);
    const stat = await fs.stat(absoluteCwd);
    if (!stat.isDirectory()) {
      throw new ControlPlaneError("INVALID_CWD", `Not a directory: ${absoluteCwd}`);
    }
    let task;
    try {
      task = createTaskRecord(
        { ...input, cwd: absoluteCwd },
        { id: makeId("task"), at }
      );
    } catch (error) {
      throw asControlPlaneError(error);
    }
    enrichSettlement(task);
    await this.ledger.update(async (draft) => {
      const run = requireRun(draft, input.runId);
      requireRunOpen(run);
      run.tasks[task.id] = task;
      touchRun(run, at);
      run.events.push(event("TASK_CREATED", `Task created: ${task.title}`, { taskId: task.id }, at));
      return { taskId: task.id };
    });
    return structuredClone(task);
  }

  async prepareDispatch({ runId, taskId }) {
    const at = nowIso(this.clock);
    let response;
    await this.ledger.update((draft) => {
      const run = requireRun(draft, runId);
      requireRunOpen(run);
      const task = requireTask(run, taskId);
      if (!["created", "failed"].includes(task.status)) {
        throw new ControlPlaneError(
          "TASK_NOT_PREPARABLE",
          `Task ${task.id} cannot prepare a new task from ${task.status}`
        );
      }
      const preparation = buildDispatchPreparation(run, task);
      const operation = createOperation({
        id: makeId("op"),
        kind: "dispatch",
        tool: "codex_app__create_thread",
        taskIds: [task.id],
        phase: "project_lookup",
        argumentsValue: null,
        at,
        metadata: {
          projectLookup: preparation.projectLookup,
          createThreadTemplate: preparation.createThreadTemplate
        }
      });
      transition(task, "task", "prepared", at);
      task.threadTitle = preparation.threadTitle;
      task.error = null;
      run.operations[operation.id] = operation;
      touchRun(run, at);
      recalculateRun(run, at);
      run.events.push(
        event(
          "DISPATCH_PREPARED",
          `Project lookup prepared for ${task.title}`,
          { taskId, operationId: operation.id },
          at
        )
      );
      response = {
        operation: structuredClone(operation),
        executable: run.executionMode === "live",
        nextCall: structuredClone(preparation.projectLookup)
      };
    });
    return response;
  }

  async resolveProject({ runId, operationId, project, confirmLiveAction = false }) {
    const at = nowIso(this.clock);
    let response;
    await this.ledger.update(async (draft) => {
      const run = requireRun(draft, runId);
      requireRunOpen(run);
      const operation = requireOperation(run, operationId);
      if (
        operation.kind !== "dispatch" ||
        operation.tool !== "codex_app__create_thread" ||
        operation.phase !== "project_lookup" ||
        operation.status !== "prepared"
      ) {
        throw new ControlPlaneError(
          "DISPATCH_NOT_WAITING_FOR_PROJECT",
          `Operation ${operationId} is not awaiting project resolution`
        );
      }
      requireLiveConfirmation(run, confirmLiveAction, "task creation");
      const task = requireTask(run, operation.taskIds[0]);
      const launch = resolveProjectLaunch(task, operation.metadata, project);
      if (task.target?.environment === "worktree") {
        const inspection = await inspectRepository(launch.project.path);
        if (!inspection.isPrimaryCheckout) {
          throw new ControlPlaneError(
            "PRIMARY_CHECKOUT_REQUIRED",
            "Worktree settlement requires the selected Local project to be the authoritative primary checkout"
          );
        }
        if (inspection.branch !== task.target.integrationTargetBranch) {
          throw new ControlPlaneError(
            "TARGET_BRANCH_NOT_CHECKED_OUT",
            `Selected Local checkout must be on ${task.target.integrationTargetBranch}`
          );
        }
        task.git.commonDirectory = inspection.commonDirectory;
        task.git.primaryCheckout = inspection.primaryCheckout;
        task.git.targetBranch = task.target.integrationTargetBranch;
        task.git.targetHeadAtDispatch = inspection.head;
      }
      operation.arguments = launch.arguments;
      operation.phase = "ready";
      operation.project = launch.project;
      operation.confirmedAt = run.executionMode === "live" ? at : null;
      operation.updatedAt = at;
      task.project = structuredClone(launch.project);
      touchRun(run, at);
      recalculateRun(run, at);
      run.events.push(
        event(
          "PROJECT_RESOLVED",
          `Native task target resolved for ${task.title}`,
          { taskId: task.id, operationId, projectId: launch.project.projectId },
          at
        )
      );
      response = {
        operation: structuredClone(operation),
        executable: run.executionMode === "live",
        nextCall: { tool: launch.tool, arguments: structuredClone(launch.arguments) }
      };
    });
    return response;
  }

  async recordThreadLaunch({ runId, operationId, result = null, error = null }) {
    const at = nowIso(this.clock);
    let response;
    await this.ledger.update((draft) => {
      const run = requireRun(draft, runId);
      const operation = requireOperation(run, operationId);
      if (
        !["codex_app__create_thread", "codex_app__fork_thread"].includes(operation.tool) ||
        operation.status !== "prepared" ||
        operation.phase !== "ready"
      ) {
        throw new ControlPlaneError(
          "LAUNCH_NOT_RECORDABLE",
          `Operation ${operationId} is not a ready task launch`
        );
      }
      if (run.executionMode !== "live") {
        throw new ControlPlaneError("DRY_RUN_ONLY", "A dry-run cannot record a native task launch");
      }
      const targetTaskId = operation.childTaskId || operation.taskIds[0];
      const task = requireTask(run, targetTaskId);
      const normalizedError = normalizeError(error || result?.error);
      if (normalizedError || result?.status === "failed") {
        transition(operation, "operation", "failed", at);
        operation.error = normalizedError || { code: "NATIVE_CALL_FAILED", message: "Task launch failed" };
        transition(task, "task", "failed", at);
        task.error = structuredClone(operation.error);
        touchRun(run, at);
        recalculateRun(run, at);
        response = { operation: structuredClone(operation), task: structuredClone(task) };
        return;
      }
      const threadId = optionalText(result?.threadId);
      const clientThreadId = optionalText(result?.clientThreadId);
      if (!threadId && !clientThreadId) {
        throw new ControlPlaneError(
          "MISSING_THREAD_IDENTIFIER",
          "A successful native launch must return threadId or clientThreadId"
        );
      }
      const hostId = optionalText(result?.hostId || task.project?.hostId);
      task.threadId = threadId;
      task.hostId = hostId;
      task.clientThreadId = clientThreadId;
      task.roundTrips += operation.tool === "codex_app__create_thread" ? 1 : 0;
      transition(task, "task", threadId ? (operation.childTaskId ? "idle" : "running") : "provisioning", at);
      const thread = makeThreadRecord({
        task,
        threadId,
        hostId,
        clientThreadId,
        status: threadId ? (operation.childTaskId ? "idle" : "active") : "provisioning",
        at
      });
      run.threads[threadKey(thread)] = thread;
      transition(operation, "operation", "succeeded", at);
      operation.result = {
        threadId,
        hostId,
        clientThreadId,
        queued: !threadId
      };
      if (operation.tool === "codex_app__create_thread") {
        run.messages.push(
          messageEnvelope(run, task, "ASSIGN", task.prompt, {
            senderTaskId: null,
            recipientTaskId: task.id
          }, at)
        );
      } else {
        run.messages.push(
          messageEnvelope(run, task, "FORK", `Forked from task ${task.sourceTaskId}`, {
            senderTaskId: task.sourceTaskId,
            recipientTaskId: task.id
          }, at)
        );
      }
      touchRun(run, at);
      recalculateRun(run, at);
      run.events.push(
        event(
          threadId ? "THREAD_BOUND" : "THREAD_PROVISIONING",
          threadId ? `Task bound to ${threadId}` : `Task queued as ${clientThreadId}`,
          { taskId: task.id, operationId, threadId, clientThreadId },
          at
        )
      );
      response = {
        operation: structuredClone(operation),
        task: structuredClone(task),
        thread: structuredClone(thread),
        next:
          threadId || !clientThreadId
            ? null
            : operation.tool !== "codex_app__create_thread"
              ? null
            : {
                tool: "codex_app__list_threads",
                purpose:
                  "Resolve the queued task from the schemaVersion 4 thread list by exact controller identity marker and environment-specific project evidence"
              },
        bindingBlocker:
          !threadId && clientThreadId && operation.tool !== "codex_app__create_thread"
            ? {
                code: "QUEUED_FORK_BINDING_EVIDENCE_UNAVAILABLE",
                message:
                  "The queued fork has no controller-assigned identity marker, and list_threads does not expose clientThreadId"
              }
            : null
      };
    });
    return response;
  }

  async prepareOperation({
    runId,
    tool,
    input = {},
    confirmLiveAction = false
  }) {
    const at = nowIso(this.clock);
    let response;
    await this.ledger.update((draft) => {
      const run = requireRun(draft, runId);
      if (["completed", "cancelled"].includes(run.status) && !POST_COMPLETION_TOOLS.has(tool)) {
        throw new ControlPlaneError(
          "RUN_CLOSED",
          `Run ${run.id} is ${run.status}; only read and organization operations remain available`
        );
      }
      if (MUTATING_THREAD_TOOLS.has(tool)) {
        requireLiveConfirmation(run, confirmLiveAction, tool);
      }
      if (tool === "codex_app__send_message_to_thread") {
        const target = requireTask(run, input.taskId);
        if (input.sourceTaskId) requireTask(run, input.sourceTaskId);
        if (!["idle", "blocked", "needs_attention"].includes(target.status)) {
          throw new ControlPlaneError(
            "TASK_NOT_READY_FOR_MESSAGE",
            `Task ${target.id} must be idle or awaiting attention before a follow-up; current state is ${target.status}`
          );
        }
        if (target.roundTrips >= run.maxRoundTrips) {
          throw new ControlPlaneError(
            "ROUND_TRIP_LIMIT",
            `Task ${input.taskId} reached maxRoundTrips=${run.maxRoundTrips}`
          );
        }
      }

      let childTask = null;
      let normalizedInput = structuredClone(input);
      if (tool === "codex_app__fork_thread") {
        const sourceTask = requireTask(run, input.taskId);
        if (!["idle", "review", "completed"].includes(sourceTask.status)) {
          throw new ControlPlaneError(
            "ACTIVE_THREAD_NOT_FORKABLE",
            "Wait for the source task to become idle or complete before forking"
          );
        }
        if (!isRecord(input.forkTask)) {
          throw new ControlPlaneError("FORK_TASK_REQUIRED", "forkTask must define the child task contract");
        }
        childTask = createTaskRecord(
          {
            ...input.forkTask,
            cwd: input.forkTask.cwd || sourceTask.cwd,
            sourceTaskId: sourceTask.id
          },
          { id: makeId("task"), at }
        );
        transition(childTask, "task", "prepared", at);
        normalizedInput.forkTask = structuredClone(childTask);
      }
      if (tool === "codex_app__handoff_thread") {
        const target = requireTask(run, input.taskId);
        if (!["running", "idle", "blocked", "needs_attention", "settling"].includes(target.status)) {
          throw new ControlPlaneError(
            "TASK_NOT_HANDOFF_READY",
            `Task ${target.id} cannot be handed off from ${target.status}`
          );
        }
      }
      if (input.taskId && run.tasks[input.taskId]) {
        enforceSettlementNativePreparation(run, run.tasks[input.taskId], tool, input);
      }

      let intent;
      try {
        intent = buildNativeOperationIntent({
          run,
          tasks: run.tasks,
          tool,
          input: normalizedInput,
          operations: run.operations
        });
      } catch (error) {
        throw asControlPlaneError(error);
      }
      if (childTask) run.tasks[childTask.id] = childTask;
      const operation = createOperation({
        id: makeId("op"),
        kind: "native",
        tool,
        taskIds: childTask ? [...intent.taskIds, childTask.id] : intent.taskIds,
        phase: "ready",
        argumentsValue: intent.arguments,
        at,
        metadata: compactObject({
          message: intent.message,
          parentOperationId: intent.parentOperationId
        })
      });
      if (childTask) operation.childTaskId = childTask.id;
      if (input.taskId && run.tasks[input.taskId]) {
        recordSettlementOperationPrepared(run.tasks[input.taskId], tool, input, operation.id);
      }
      operation.confirmedAt =
        run.executionMode === "live" && MUTATING_THREAD_TOOLS.has(tool) ? at : null;
      run.operations[operation.id] = operation;
      touchRun(run, at);
      run.events.push(
        event(
          "OPERATION_PREPARED",
          `Prepared ${tool}`,
          { operationId: operation.id, taskIds: operation.taskIds },
          at
        )
      );
      response = {
        operation: structuredClone(operation),
        childTask: childTask ? structuredClone(childTask) : null,
        executable: run.executionMode === "live",
        nextCall: { tool, arguments: structuredClone(intent.arguments) }
      };
    });
    return response;
  }

  async completeOperation({ runId, operationId, result = {} }) {
    const at = nowIso(this.clock);
    let response;
    await this.ledger.update(async (draft) => {
      const run = requireRun(draft, runId);
      const operation = requireOperation(run, operationId);
      if (["codex_app__create_thread", "codex_app__fork_thread"].includes(operation.tool)) {
        throw new ControlPlaneError(
          "USE_RECORD_THREAD_LAUNCH",
          "Task creation and fork results must be recorded with recordThreadLaunch"
        );
      }
      if (!["prepared", "pending"].includes(operation.status)) {
        throw new ControlPlaneError(
          "OPERATION_ALREADY_FINAL",
          `Operation ${operationId} is ${operation.status}`
        );
      }
      if (run.executionMode !== "live") {
        throw new ControlPlaneError("DRY_RUN_ONLY", "A dry-run cannot record a native tool result");
      }
      const failed = result.status === "failed" || result.ok === false || result.error;
      if (failed) {
        failOperation(run, operation, result.error, at);
        touchRun(run, at);
        recalculateRun(run, at);
        response = structuredClone(operation);
        return;
      }

      switch (operation.tool) {
        case "codex_app__list_threads":
          {
            const boundTaskIds = await applyThreadListBindings(run, operation, result, at);
            const locatedTaskIds = await applyKnownThreadLocations(run, operation, result, at);
            const affectedTaskIds = [...new Set([...boundTaskIds, ...locatedTaskIds])];
            finishOperation(
              operation,
              "succeeded",
              {
                ...result,
                bindingCount: boundTaskIds.length,
                locationUpdateCount: locatedTaskIds.length
              },
              at
            );
            for (const taskId of affectedTaskIds) {
              if (!operation.taskIds.includes(taskId)) operation.taskIds.push(taskId);
            }
          }
          break;
        case "codex_app__wait_threads":
        case "codex_app__read_thread":
          applyObservations(run, operation, result.observations || [], at);
          finishOperation(operation, "succeeded", result, at);
          break;
        case "codex_app__send_message_to_thread":
          applySendResult(run, operation, result, at);
          finishOperation(operation, "succeeded", result, at);
          break;
        case "codex_app__handoff_thread":
          applyHandoffStart(run, operation, result, at);
          break;
        case "codex_app__get_handoff_status":
          applyHandoffStatus(run, operation, result, at);
          break;
        case "codex_app__set_thread_title":
          applyTitleResult(run, operation, result, at);
          finishOperation(operation, "succeeded", result, at);
          break;
        case "codex_app__move_thread_to_sidebar_section":
          applyPinnedResult(run, operation, result, at);
          finishOperation(operation, "succeeded", result, at);
          break;
        case "codex_app__set_thread_archived":
          applyArchivedResult(run, operation, result, at);
          finishOperation(operation, "succeeded", result, at);
          break;
        case "codex_app__navigate_to_codex_page":
          finishOperation(operation, "succeeded", result, at);
          break;
        default:
          throw new ControlPlaneError(
            "UNSUPPORTED_COMPLETION",
            `No completion handler for ${operation.tool}`
          );
      }
      touchRun(run, at);
      recalculateRun(run, at);
      run.events.push(
        event(
          "OPERATION_RECORDED",
          `${operation.tool}: ${operation.status}`,
          { operationId, taskIds: operation.taskIds },
          at
        )
      );
      response = {
        operation: structuredClone(operation),
        tasks: operation.taskIds
          .filter((taskId) => run.tasks[taskId])
          .map((taskId) => structuredClone(run.tasks[taskId]))
      };
    });
    return response;
  }

  async decideTask({ runId, taskId, decision, note = "" }) {
    if (!["adopt", "continue", "discard"].includes(decision)) {
      throw new ControlPlaneError("INVALID_DECISION", `Unsupported decision: ${decision}`);
    }
    const currentRun = await this.snapshot({ runId });
    const currentTask = requireTask(currentRun, taskId);
    const worktree = isWorktreeTask(currentTask);
    let candidate = null;
    if (worktree && decision !== "continue") {
      const currentThread = findThreadForTask(currentRun, currentTask);
      if (!currentThread?.pinned || currentTask.worktree?.pinned !== true) {
        throw new ControlPlaneError(
          "WORKTREE_PIN_REQUIRED",
          "A managed worktree must remain pinned through review and settlement"
        );
      }
      const primaryCheckout = currentTask.git?.primaryCheckout || currentTask.cwd;
      const runtimePath = currentTask.worktree?.runtimeCwd || currentThread.runtimeCwd;
      const targetBranch = currentTask.git?.targetBranch || currentTask.target?.integrationTargetBranch;
      const commonDirectory = currentTask.git?.commonDirectory;
      if (
        !path.isAbsolute(primaryCheckout || "") ||
        !path.isAbsolute(runtimePath || "") ||
        !path.isAbsolute(commonDirectory || "")
      ) {
        throw new ControlPlaneError(
          "SETTLEMENT_IDENTITY_INCOMPLETE",
          "Review requires exact primary checkout, common directory, and runtime worktree path"
        );
      }
      try {
        candidate = await captureCandidate({
          primaryCheckout,
          runtimePath,
          targetBranch,
          expectedCommonDirectory: commonDirectory,
          expectedTemporaryBranch: currentTask.worktree?.branchAtBinding || null
        });
      } catch (error) {
        throw asControlPlaneError(error);
      }
    }
    const at = nowIso(this.clock);
    let response;
    await this.ledger.update((draft) => {
      const run = requireRun(draft, runId);
      const task = requireTask(run, taskId);
      if (task.status !== "review") {
        throw new ControlPlaneError(
          "TASK_NOT_IN_REVIEW",
          `Task ${taskId} is ${task.status}; a controller decision requires review`
        );
      }
      const nextStatus = decision === "continue" ? "idle" : worktree ? "settling" : decision === "adopt" ? "completed" : "failed";
      transition(task, "task", nextStatus, at);
      if (worktree) {
        enrichSettlement(task);
        if (decision === "continue") {
          task.settlement = defaultSettlement(true);
        } else {
          task.worktree.candidateCapture = structuredClone(candidate);
          task.worktree.headAtReview = candidate.candidateHead;
          task.worktree.branchAtReview = candidate.branchAtReview;
          task.worktree.candidateFingerprint = candidate.candidateFingerprint;
          task.settlement.required = true;
          task.settlement.decision = decision;
          task.settlement.phase = decision === "adopt" ? "handoff_preflight" : "discard_pending";
          task.settlement.terminalStatus = decision === "discard" ? "failed" : null;
          task.settlement.blocker = null;
        }
      }
      if (decision === "discard") {
        task.error = { code: "CONTROLLER_REJECTED", message: note || "Controller rejected result" };
      }
      run.messages.push(
        messageEnvelope(run, task, "DECISION", note || decision, {
          senderTaskId: null,
          recipientTaskId: task.id,
          metadata: { decision }
        }, at)
      );
      touchRun(run, at);
      recalculateRun(run, at);
      run.events.push(event("CONTROLLER_DECISION", `${decision}: ${task.title}`, { taskId, note }, at));
      response = structuredClone(task);
    });
    return response;
  }

  // Reconcile only worktrees already owned by this ledger. This is intentionally
  // observation-first: it never scans or adopts unrelated repositories.
  async reconcile({ runId = null } = {}) {
    const at = nowIso(this.clock);
    const ledger = await this.ledger.read();
    const runs = runId ? [requireRun(ledger, runId)] : Object.values(ledger.runs || {});
    const records = [];
    for (const run of runs) {
      for (const task of Object.values(run.tasks || {})) {
        if (task.target?.environment !== "worktree") continue;
        enrichSettlement(task);
        const runtimePath = task.worktree.runtimeCwd || findThreadForTask(run, task)?.runtimeCwd || null;
        const primaryCheckout = task.git?.primaryCheckout || task.cwd;
        let inspection = null;
        let error = null;
        try {
          if (runtimePath && path.isAbsolute(primaryCheckout)) inspection = await inspectRepository(primaryCheckout);
        } catch (cause) {
          error = { code: cause.code || "GIT_INSPECTION_FAILED", message: cause.message };
        }
        const registration = inspection?.worktrees?.find((entry) => runtimePath && filesystemPathEqual(entry.path, runtimePath));
        const pathExists = Boolean(runtimePath && pathExistsNoFollow(runtimePath));
        let classification = "awaiting_decision";
        if (error) classification = "ownership_ambiguous";
        else if (task.settlement?.cleanupReceipt && !pathExists && !registration) classification = "cleanup_verified";
        else if (
          task.settlement?.decision === "adopt" &&
          !task.settlement?.adoptionReceipt &&
          !pathExists &&
          !registration
        ) classification = "missing_before_adoption";
        else if (["completed", "failed", "cancelled"].includes(task.status) && (pathExists || registration)) classification = "orphan_recovery_required";
        else if (["cleanup_pending", "integration_verified", "discard_pending"].includes(task.settlement?.phase)) classification = "cleanup_pending";
        else if (["handoff_preflight", "handoff_pending"].includes(task.settlement?.phase)) classification = "handoff_unknown";
        else if (task.settlement?.phase === "integration_pending") classification = "integration_pending";
        else if (task.settlement?.phase === "blocked") classification = "ownership_ambiguous";
        else if (!["review", "settling"].includes(task.status)) classification = "healthy_active";
        records.push({ runId: run.id, taskId: task.id, threadId: task.threadId, commonDirectory: inspection?.commonDirectory || task.git?.commonDirectory || null, primaryCheckout, runtimePath, pathExists, registered: Boolean(registration), classification, inspection, error, at });
      }
    }
    return { at, records };
  }

  async integrateSettlement({ runId, taskId, commitMessage = null }) {
    const run = await this.snapshot({ runId });
    const task = requireTask(run, taskId);
    if (!isWorktreeTask(task)) {
      throw new ControlPlaneError("SETTLEMENT_NOT_REQUIRED", "Local tasks do not require worktree integration");
    }
    enrichSettlement(task);
    if (task.settlement.decision !== "adopt") {
      throw new ControlPlaneError("ADOPTION_NOT_SELECTED", "Only an adopted worktree candidate can be integrated");
    }
    if (task.settlement.adoptionReceipt) return task;
    const resumingBlockedIntegration =
      task.settlement.phase === "blocked" && task.settlement.blocker?.resumePhase === "integration_pending";
    if (task.settlement.phase !== "integration_pending" && !resumingBlockedIntegration) {
      throw new ControlPlaneError(
        "INTEGRATION_NOT_READY",
        `Adoption integration requires integration_pending; current phase is ${task.settlement.phase}`
      );
    }
    const thread = findThreadForTask(run, task);
    const primaryCheckout = task.git?.primaryCheckout || task.cwd;
    const commonDirectory = task.git?.commonDirectory;
    if (!thread || !filesystemPathEqual(thread.runtimeCwd, primaryCheckout)) {
      throw new ControlPlaneError(
        "LOCAL_LOCATION_NOT_CONFIRMED",
        "Adoption integration requires list_threads evidence that the task is at the authoritative Local checkout"
      );
    }
    if (!thread.pinned || task.worktree.pinned !== true) {
      throw new ControlPlaneError("WORKTREE_PIN_REQUIRED", "The task must remain pinned until adoption is verified");
    }
    if (!path.isAbsolute(primaryCheckout) || !path.isAbsolute(commonDirectory || "")) {
      throw new ControlPlaneError("INTEGRATION_IDENTITY_INCOMPLETE", "Exact primary checkout and common directory are required");
    }
    const lock = await acquireSettlementLock(commonDirectory, { runId, taskId, threadId: task.threadId || null });
    try {
      let adoptionReceipt;
      try {
        adoptionReceipt = await integrateCandidate({
          primaryCheckout,
          targetBranch: task.git.targetBranch,
          candidate: task.worktree.candidateCapture,
          commitMessage: commitMessage || `Integrate ${task.id}: ${task.title}`,
          transactionId: `${runId}:${taskId}`,
          recoveryState: resumingBlockedIntegration
            ? task.settlement.blocker?.details?.recoveryState || null
            : null
        });
      } catch (error) {
        await this.recordSettlementBlocker({ runId, taskId, resumePhase: "integration_pending", error });
        throw asControlPlaneError(error);
      }
      const at = nowIso(this.clock);
      let result;
      await this.ledger.update((draft) => {
        const currentRun = requireRun(draft, runId);
        const currentTask = requireTask(currentRun, taskId);
        enrichSettlement(currentTask);
        if (currentTask.settlement.adoptionReceipt) {
          if (
            currentTask.settlement.adoptionReceipt.candidateFingerprint !==
            adoptionReceipt.candidateFingerprint
          ) {
            throw new ControlPlaneError(
              "ADOPTION_RECEIPT_IMMUTABLE",
              "A different adoption receipt is already recorded"
            );
          }
        } else {
          currentTask.settlement.adoptionReceipt = structuredClone(adoptionReceipt);
        }
        currentTask.settlement.phase = "integration_verified";
        currentTask.settlement.blocker = null;
        touchRun(currentRun, at);
        recalculateRun(currentRun, at);
        currentRun.events.push(
          event("ADOPTION_VERIFIED", `Adoption verified: ${currentTask.title}`, { taskId }, at)
        );
        result = structuredClone(currentTask);
      });
      return result;
    } finally {
      await releaseSettlementLock(lock);
    }
  }

  async cleanupSettlement({ runId, taskId }) {
    const run = await this.snapshot({ runId });
    const task = requireTask(run, taskId);
    if (!isWorktreeTask(task)) {
      throw new ControlPlaneError("SETTLEMENT_NOT_REQUIRED", "Local tasks do not require worktree cleanup");
    }
    enrichSettlement(task);
    const decision = task.settlement.decision;
    if (!["adopt", "discard"].includes(decision)) {
      throw new ControlPlaneError("SETTLEMENT_DECISION_REQUIRED", "Cleanup requires adopt or discard");
    }
    if (decision === "adopt" && !task.settlement.adoptionReceipt) {
      throw new ControlPlaneError("ADOPTION_RECEIPT_REQUIRED", "Adopted cleanup requires verified target-branch adoption");
    }
    if (!task.settlement.unpinReceipt || !task.settlement.archiveReceipt) {
      throw new ControlPlaneError(
        "NATIVE_CLEANUP_RECEIPTS_REQUIRED",
        "Exact unpin and archive receipts are required before physical cleanup"
      );
    }
    const thread = findThreadForTask(run, task);
    if (!thread?.archived || thread.pinned || task.worktree.pinned) {
      throw new ControlPlaneError(
        "NATIVE_CLEANUP_STATE_REQUIRED",
        "The controlled task must be unpinned and archived before physical cleanup"
      );
    }
    const primaryCheckout = task.git?.primaryCheckout || task.cwd;
    const runtimePath = task.worktree?.runtimeCwd;
    const commonDirectory = task.git?.commonDirectory;
    if (
      !path.isAbsolute(primaryCheckout) ||
      !path.isAbsolute(runtimePath || "") ||
      !path.isAbsolute(commonDirectory || "")
    ) {
      throw new ControlPlaneError(
        "CLEANUP_IDENTITY_INCOMPLETE",
        "Exact primary checkout, common directory, and runtime path are required"
      );
    }
    if (decision === "adopt") {
      try {
        await verifyAdoption({
          primaryCheckout,
          targetBranch: task.git.targetBranch,
          candidate: task.worktree.candidateCapture,
          adoptionReceipt: task.settlement.adoptionReceipt
        });
      } catch (error) {
        await this.recordSettlementBlocker({ runId, taskId, resumePhase: "cleanup_pending", error });
        throw asControlPlaneError(error);
      }
    }
    const branchAtReview = task.worktree.branchAtReview;
    const temporaryBranchRef = task.worktree.branchAtBinding || null;
    if (
      branchAtReview &&
      temporaryBranchRef &&
      branchAtReview !== temporaryBranchRef
    ) {
      const error = new ControlPlaneError(
        "UNEXPECTED_REVIEW_BRANCH",
        "Review occurred on a branch different from the task-owned branch recorded at binding"
      );
      error.details = { branchAtReview, temporaryBranchRef };
      await this.recordSettlementBlocker({ runId, taskId, resumePhase: "cleanup_pending", error });
      throw error;
    }
    if (
      temporaryBranchRef &&
      temporaryBranchRef.replace(/^refs\/heads\//, "") === task.git.targetBranch
    ) {
      throw new ControlPlaneError(
        "TARGET_BRANCH_CLEANUP_REFUSED",
        "The authoritative target branch cannot be treated as a temporary task branch"
      );
    }
    const force = decision === "discard";
    const lock = await acquireSettlementLock(commonDirectory, {
      runId,
      taskId,
      threadId: task.threadId || null
    });
    try {
      let receipt;
      let branchReceipt;
      try {
        receipt = await removeExactWorktree({
          primaryCheckout,
          runtimePath,
          expectedCommonDirectory: commonDirectory,
          expectedBranch: branchAtReview,
          force
        });
        branchReceipt = await removeExactBranch({
          primaryCheckout,
          branch: temporaryBranchRef,
          expectedHead:
            task.settlement.adoptionReceipt?.temporaryBranchHeadAfterIntegration ||
            task.worktree.headAtReview,
          force
        });
      } catch (error) {
        await this.recordSettlementBlocker({ runId, taskId, resumePhase: "cleanup_pending", error });
        throw asControlPlaneError(error);
      }
      const verified = receipt.pathAbsent && receipt.registrationAbsent && branchReceipt.branchAbsent;
      if (!verified) {
        const error = new ControlPlaneError(
          "CLEANUP_POST_STATE_FAILED",
          "Cleanup did not prove exact path, registration, and branch absence"
        );
        await this.recordSettlementBlocker({ runId, taskId, resumePhase: "cleanup_pending", error });
        throw error;
      }
      const cleanupReceipt = {
        runId,
        taskId,
        threadId: task.threadId || null,
        commonDirectory,
        primaryCheckout,
        runtimePath,
        temporaryBranchRef,
        decision,
        authority: task.target.worktreeLifecycleAuthority,
        unpinReceipt: structuredClone(task.settlement.unpinReceipt),
        archiveReceipt: structuredClone(task.settlement.archiveReceipt),
        ...receipt,
        branchReceipt
      };
      const at = nowIso(this.clock);
      let result;
      await this.ledger.update((draft) => {
        const currentRun = requireRun(draft, runId);
        const currentTask = requireTask(currentRun, taskId);
        enrichSettlement(currentTask);
        currentTask.settlement.cleanupReceipt = structuredClone(cleanupReceipt);
        currentTask.settlement.phase = "cleanup_verified";
        currentTask.settlement.blocker = null;
        transition(
          currentTask,
          "task",
          decision === "adopt" ? "completed" : currentTask.settlement.terminalStatus || "failed",
          at
        );
        touchRun(currentRun, at);
        recalculateRun(currentRun, at);
        currentRun.events.push(
          event("CLEANUP_VERIFIED", `Cleanup verified: ${currentTask.title}`, { taskId }, at)
        );
        result = structuredClone(currentTask);
      });
      return result;
    } finally {
      await releaseSettlementLock(lock);
    }
  }

  async recordSettlementBlocker({ runId, taskId, resumePhase, error }) {
    const at = nowIso(this.clock);
    let result;
    await this.ledger.update((draft) => {
      const run = requireRun(draft, runId);
      const task = requireTask(run, taskId);
      enrichSettlement(task);
      task.settlement.phase = "blocked";
      task.settlement.blocker = {
        code: error?.code || "SETTLEMENT_BLOCKED",
        message: error?.message || "Settlement is blocked",
        details: error?.details || null,
        resumePhase,
        recordedAt: at
      };
      touchRun(run, at);
      recalculateRun(run, at);
      run.events.push(
        event("SETTLEMENT_BLOCKED", `Settlement blocked: ${task.title}`, { taskId, resumePhase }, at)
      );
      result = structuredClone(task);
    });
    return result;
  }

  async requestCancel({ runId, taskId, reason }) {
    requireText(reason, "reason");
    const at = nowIso(this.clock);
    let response;
    await this.ledger.update((draft) => {
      const run = requireRun(draft, runId);
      const task = requireTask(run, taskId);
      if (TERMINAL_TASK_STATES.has(task.status)) {
        throw new ControlPlaneError("TASK_ALREADY_TERMINAL", `Task ${taskId} is ${task.status}`);
      }
      const hasRuntime = Boolean(task.threadId || task.clientThreadId);
      if (hasRuntime) transition(task, "task", "cancel_requested", at);
      else transition(task, "task", "cancelled", at);
      run.messages.push(
        messageEnvelope(run, task, "CANCEL", reason.trim(), {
          senderTaskId: null,
          recipientTaskId: task.id
        }, at)
      );
      touchRun(run, at);
      recalculateRun(run, at);
      run.events.push(
        event(
          "CANCEL_REQUESTED",
          `Cancellation recorded for ${task.title}`,
          { taskId, humanStopRequired: hasRuntime },
          at
        )
      );
      response = {
        task: structuredClone(task),
        humanStopRequired: hasRuntime,
        threadId: task.threadId,
        clientThreadId: task.clientThreadId,
        guidance: hasRuntime
          ? "Stop the visible Codex task in the app, then record a cancelled or failed observation."
          : "The unlaunched task was cancelled in the ledger."
      };
    });
    return response;
  }

  async simulateTask({
    runId,
    taskId,
    summary,
    artifacts = [],
    verification = []
  }) {
    requireText(summary, "summary");
    const at = nowIso(this.clock);
    let response;
    await this.ledger.update((draft) => {
      const run = requireRun(draft, runId);
      if (run.executionMode !== "dry-run") {
        throw new ControlPlaneError("LIVE_RUN", "simulateTask is only available for dry-run runs");
      }
      const task = requireTask(run, taskId);
      if (!["created", "prepared"].includes(task.status)) {
        throw new ControlPlaneError("TASK_NOT_SIMULATABLE", `Task ${taskId} is ${task.status}`);
      }
      transition(task, "task", "review", at);
      task.result = { summary: summary.trim(), simulated: true };
      task.artifacts = normalizeStringArray(artifacts, "artifacts");
      task.verification = normalizeStringArray(verification, "verification");
      run.messages.push(
        messageEnvelope(run, task, "RESULT", task.result.summary, {
          senderTaskId: task.id,
          recipientTaskId: null,
          metadata: { simulated: true }
        }, at)
      );
      touchRun(run, at);
      recalculateRun(run, at);
      response = structuredClone(task);
    });
    return response;
  }

  async snapshot({ runId = null } = {}) {
    const ledger = await this.ledger.read();
    if (!runId) return ledger;
    return structuredClone(requireRun(ledger, runId));
  }

  async close() {}
}

function filesystemPathEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string" || !left || !right) return false;
  const normalize = (candidate) => {
    try { return fsSync.realpathSync(candidate); } catch { return path.resolve(candidate); }
  };
  return normalize(left) === normalize(right);
}

function pathExistsNoFollow(candidate) {
  try {
    fsSync.lstatSync(candidate);
    return true;
  } catch {
    return false;
  }
}

function createOperation({
  id,
  kind,
  tool,
  taskIds,
  phase,
  argumentsValue,
  metadata = {},
  at
}) {
  return {
    id,
    kind,
    tool,
    status: "prepared",
    phase,
    taskIds: [...taskIds],
    childTaskId: null,
    arguments: argumentsValue ? structuredClone(argumentsValue) : null,
    metadata: structuredClone(metadata),
    project: null,
    confirmedAt: null,
    runtimeOperationId: null,
    runtimeRevision: null,
    result: null,
    error: null,
    createdAt: at,
    updatedAt: at
  };
}

async function applyThreadListBindings(run, operation, result, at) {
  rejectFabricatedThreadBindingEvidence(result);
  if (!isRecord(result) || result.schemaVersion !== 4) {
    throw new ControlPlaneError(
      "UNSUPPORTED_THREAD_LIST_SCHEMA",
      "Queued binding requires the native list_threads schemaVersion 4 result"
    );
  }
  if (!Array.isArray(result.threads)) {
    throw new ControlPlaneError(
      "INVALID_THREAD_LIST",
      "list_threads schemaVersion 4 result must include a threads array"
    );
  }

  const boundTaskIds = [];
  const bindingKeys = new Set();
  const provisioningTasks = Object.values(run.tasks).filter(
    (task) => task.clientThreadId && !task.threadId
  );

  for (const task of provisioningTasks) {
    const marker = buildThreadIdentityMarker(run, task);
    if (!hasExactIdentityMarker(task.threadTitle, marker)) continue;

    const bindingScope = queuedBindingScope(task);
    if (!bindingScope) continue;
    const bindingKey = `${marker}\u0000${bindingScope}`;
    if (bindingKeys.has(bindingKey)) {
      throw new ControlPlaneError(
        "CONTROLLER_IDENTITY_COLLISION",
        `More than one queued task has controller identity ${marker} in ${bindingScope}`
      );
    }
    bindingKeys.add(bindingKey);

    const matches = result.threads.filter(
      (entry) =>
        isRecord(entry) &&
        hasExactIdentityMarker(entry.title, marker) &&
        hasExactQueuedProjectEvidence(task, entry)
    );
    if (matches.length > 1) {
      throw new ControlPlaneError(
        "AMBIGUOUS_THREAD_BINDING",
        `Queued task ${task.id} matched ${matches.length} native threads by exact controller and project evidence`
      );
    }
    if (matches.length === 0) continue;

    const nativeThread = matches[0];
    validateNativeThreadEntry(nativeThread);
    const threadId = nativeThread.id.trim();
    const existingThread = run.threads[threadId];
    if (existingThread && existingThread.taskId !== task.id) {
      throw new ControlPlaneError(
        "THREAD_ADDRESS_CONFLICT",
        `Native thread ${threadId} is already bound to task ${existingThread.taskId}`
      );
    }

    const oldKey = `client:${task.clientThreadId}`;
    const oldThread = run.threads[oldKey];
    delete run.threads[oldKey];
    task.threadId = threadId;
    task.hostId = optionalText(nativeThread.hostId || task.hostId);
    task.clientThreadId = null;
    const boundStatus = task.sourceTaskId ? "idle" : "running";
    transition(task, "task", boundStatus, at);
    const thread = {
      ...(oldThread || makeThreadRecord({ task, status: "active", at })),
      id: task.threadId,
      hostId: task.hostId,
      clientThreadId: null,
      runtimeCwd: nativeThread.cwd,
      status: task.sourceTaskId ? "idle" : "active",
      updatedAt: at
    };
    if (task.target?.environment === "worktree") {
      task.worktree.runtimeCwd = nativeThread.cwd;
      task.worktree.threadId = task.threadId;
      task.worktree.clientThreadId = null;
      task.worktree.pinned = thread.pinned;
      await recordBoundWorktreeIdentity(task, nativeThread.cwd);
    }
    run.threads[task.threadId] = thread;
    run.events.push(
      event(
        "QUEUED_THREAD_BOUND",
        `Queued task bound to ${task.threadId}`,
        {
          taskId: task.id,
          operationId: operation.id,
          identityMarker: marker,
          declaredProjectRoot: task.cwd,
          runtimeCwd: nativeThread.cwd,
          projectId: nativeThread.projectId ?? null
        },
        at
      )
    );
    if (!operation.taskIds.includes(task.id)) operation.taskIds.push(task.id);
    boundTaskIds.push(task.id);
  }
  return boundTaskIds;
}

async function applyKnownThreadLocations(run, operation, result, at) {
  const updatedTaskIds = [];
  for (const task of Object.values(run.tasks || {})) {
    if (!task.threadId) continue;
    const matches = result.threads.filter((entry) => isRecord(entry) && entry.id === task.threadId);
    if (matches.length > 1) {
      throw new ControlPlaneError(
        "AMBIGUOUS_THREAD_LOCATION",
        `Native thread ${task.threadId} appeared more than once in list_threads`
      );
    }
    if (matches.length === 0) continue;
    const entry = matches[0];
    validateNativeThreadEntry(entry);
    if (typeof entry.cwd !== "string" || !entry.cwd || !path.isAbsolute(entry.cwd)) {
      throw new ControlPlaneError(
        "INVALID_THREAD_LOCATION",
        `Native thread ${task.threadId} must expose an absolute cwd`
      );
    }
    const thread = findThreadForTask(run, task);
    if (!thread) continue;
    if (
      isWorktreeTask(task) &&
      task.worktree?.identityCaptured !== true &&
      task.git?.primaryCheckout &&
      !filesystemPathEqual(entry.cwd, task.git.primaryCheckout)
    ) {
      await recordBoundWorktreeIdentity(task, entry.cwd);
    }
    thread.runtimeCwd = entry.cwd;
    thread.updatedAt = at;
    if (isWorktreeTask(task) && task.status === "settling" && task.settlement?.decision === "adopt") {
      enrichSettlement(task);
      const primaryCheckout = task.git?.primaryCheckout;
      const runtimePath = task.worktree?.runtimeCwd;
      if (primaryCheckout && filesystemPathEqual(entry.cwd, primaryCheckout)) {
        task.settlement.phase = "integration_pending";
        task.settlement.blocker = null;
      } else if (runtimePath && filesystemPathEqual(entry.cwd, runtimePath)) {
        if (task.settlement.phase === "blocked" && task.settlement.blocker?.resumePhase === "handoff_preflight") {
          task.settlement.phase = "handoff_preflight";
          task.settlement.blocker = null;
        }
      } else {
        task.settlement.phase = "blocked";
        task.settlement.blocker = {
          code: "HANDOFF_LOCATION_AMBIGUOUS",
          message: "Native thread cwd matches neither the managed worktree nor the authoritative Local checkout",
          details: { observedCwd: entry.cwd, runtimePath, primaryCheckout },
          resumePhase: "handoff_preflight",
          recordedAt: at
        };
      }
    }
    if (!operation.taskIds.includes(task.id)) operation.taskIds.push(task.id);
    updatedTaskIds.push(task.id);
  }
  return updatedTaskIds;
}

async function recordBoundWorktreeIdentity(task, runtimeCwd) {
  const primary = await inspectRepository(task.git.primaryCheckout || task.cwd);
  const registrations = primary.worktrees.filter((entry) =>
    filesystemPathEqual(entry.path, runtimeCwd)
  );
  if (registrations.length !== 1) {
    throw new ControlPlaneError(
      registrations.length === 0 ? "WORKTREE_REGISTRATION_MISSING" : "WORKTREE_OWNERSHIP_AMBIGUOUS",
      `Worktree binding requires one exact Git registration; found ${registrations.length}`
    );
  }
  const registration = registrations[0];
  task.worktree.runtimeCwd = runtimeCwd;
  task.worktree.identityCaptured = true;
  task.worktree.headAtBinding = registration.head;
  task.worktree.branchAtBinding = registration.branch;
  task.worktree.detachedAtBinding = registration.detached;
}

function enforceSettlementNativePreparation(run, task, tool, input) {
  if (!isWorktreeTask(task) || task.status !== "settling") return;
  enrichSettlement(task);
  const thread = findThreadForTask(run, task);
  if (tool === "codex_app__handoff_thread") {
    if (task.settlement.decision !== "adopt" || task.settlement.phase !== "handoff_preflight") {
      throw new ControlPlaneError(
        "SETTLEMENT_HANDOFF_NOT_READY",
        `Managed adoption Handoff requires handoff_preflight; current phase is ${task.settlement.phase}`
      );
    }
    if (!thread?.pinned || task.worktree.pinned !== true) {
      throw new ControlPlaneError("WORKTREE_PIN_REQUIRED", "Managed worktree must remain pinned before Handoff");
    }
    if (!thread.runtimeCwd || !filesystemPathEqual(thread.runtimeCwd, task.worktree.runtimeCwd)) {
      throw new ControlPlaneError(
        "HANDOFF_LOCATION_NOT_CONFIRMED",
        "list_threads must confirm the native task at the exact managed worktree before Handoff"
      );
    }
  }
  if (tool === "codex_app__move_thread_to_sidebar_section" && input.sectionId === "threads") {
    const ready = task.settlement.decision === "adopt"
      ? task.settlement.phase === "integration_verified" && Boolean(task.settlement.adoptionReceipt)
      : task.settlement.decision === "discard" && task.settlement.phase === "discard_pending";
    if (!ready) {
      throw new ControlPlaneError(
        "UNPIN_NOT_READY",
        "A managed worktree can be unpinned only after adoption proof or an explicit discard decision"
      );
    }
  }
  if (tool === "codex_app__set_thread_archived" && input.archived === true) {
    if (!task.settlement.unpinReceipt || thread?.pinned !== false || task.worktree.pinned !== false) {
      throw new ControlPlaneError(
        "ARCHIVE_NOT_READY",
        "A managed worktree can be archived only after a recorded unpin result"
      );
    }
    if (task.settlement.decision === "adopt" && !task.settlement.adoptionReceipt) {
      throw new ControlPlaneError("ADOPTION_RECEIPT_REQUIRED", "Archive cannot precede adoption proof");
    }
  }
}

function recordSettlementOperationPrepared(task, tool, input, operationId) {
  if (!isWorktreeTask(task) || task.status !== "settling") return;
  enrichSettlement(task);
  if (!task.settlement.operationIds.includes(operationId)) {
    task.settlement.operationIds.push(operationId);
  }
  if (tool === "codex_app__handoff_thread") task.settlement.phase = "handoff_pending";
  if (tool === "codex_app__move_thread_to_sidebar_section" && input.sectionId === "threads") {
    task.settlement.phase = "cleanup_pending";
  }
}

function rejectFabricatedThreadBindingEvidence(result) {
  if (!isRecord(result)) return;
  const forbiddenFields = [
    "bindings",
    "clientThreadId",
    "fullTitle",
    "matchedTitle",
    "matchCount",
    "threadId"
  ];
  const fabricatedTopLevel = forbiddenFields.find((field) =>
    Object.prototype.hasOwnProperty.call(result, field)
  );
  if (fabricatedTopLevel) {
    throw new ControlPlaneError(
      "FABRICATED_BINDING_EVIDENCE",
      `list_threads schemaVersion 4 does not expose ${fabricatedTopLevel} as binding evidence`
    );
  }
  if (!Array.isArray(result.threads)) return;
  for (const entry of result.threads) {
    if (!isRecord(entry)) continue;
    const fabricatedEntryField = forbiddenFields.find((field) =>
      Object.prototype.hasOwnProperty.call(entry, field)
    );
    if (fabricatedEntryField) {
      throw new ControlPlaneError(
        "FABRICATED_BINDING_EVIDENCE",
        `list_threads schemaVersion 4 entries do not expose ${fabricatedEntryField}`
      );
    }
  }
}

function hasExactIdentityMarker(title, marker) {
  return typeof title === "string" && (title === marker || title.startsWith(`${marker} `));
}

function queuedBindingScope(task) {
  if (task.project?.environment === "worktree") {
    return typeof task.project.projectId === "string" && task.project.projectId
      ? `worktree:${task.project.projectId}`
      : null;
  }
  if (task.project?.environment === "local") return `local:${task.cwd}`;
  return null;
}

function hasExactQueuedProjectEvidence(task, entry) {
  if (task.project?.environment === "worktree") {
    if (typeof entry.cwd !== "string" || !entry.cwd || !path.isAbsolute(entry.cwd)) return false;
    if (entry.projectId != null) return entry.projectId === task.project.projectId;
    return sameGitCommonDirectory(task.cwd, entry.cwd);
  }
  return task.project?.environment === "local" && entry.cwd === task.cwd;
}

function sameGitCommonDirectory(projectRoot, runtimeCwd) {
  const projectCommonDirectory = gitCommonDirectory(projectRoot);
  const runtimeCommonDirectory = gitCommonDirectory(runtimeCwd);
  return (
    projectCommonDirectory != null &&
    runtimeCommonDirectory != null &&
    projectCommonDirectory === runtimeCommonDirectory
  );
}

function gitCommonDirectory(cwd) {
  if (typeof cwd !== "string" || !cwd || !path.isAbsolute(cwd)) return null;
  try {
    const commonDirectory = execFileSync(
      "git",
      ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2_000 }
    ).trim();
    if (!commonDirectory || !path.isAbsolute(commonDirectory)) return null;
    return fsSync.realpathSync(commonDirectory);
  } catch {
    return null;
  }
}

function validateNativeThreadEntry(entry) {
  if (typeof entry.id !== "string" || !entry.id.trim()) {
    throw new ControlPlaneError(
      "INVALID_THREAD_LIST_ENTRY",
      "Matched list_threads entry must expose a non-empty id"
    );
  }
  if (entry.hostId != null && (typeof entry.hostId !== "string" || !entry.hostId.trim())) {
    throw new ControlPlaneError(
      "INVALID_THREAD_LIST_ENTRY",
      "Matched list_threads entry hostId must be a non-empty string or null"
    );
  }
}

function applyObservations(run, operation, observations, at) {
  if (!Array.isArray(observations) || observations.length === 0) {
    throw new ControlPlaneError(
      "OBSERVATIONS_REQUIRED",
      `${operation.tool} completion requires at least one normalized observation`
    );
  }
  for (const observation of observations) {
    if (!operation.taskIds.includes(observation.taskId)) {
      throw new ControlPlaneError(
        "OBSERVATION_OUT_OF_SCOPE",
        `Task ${observation.taskId} is not part of operation ${operation.id}`
      );
    }
    if (!OBSERVATION_STATES.has(observation.status)) {
      throw new ControlPlaneError(
        "INVALID_OBSERVATION_STATUS",
        `Unsupported observation state: ${observation.status}`
      );
    }
    const task = requireTask(run, observation.taskId);
    const thread = findThreadForTask(run, task);
    const worktree = task.target?.environment === "worktree" || task.project?.environment === "worktree";
    const taskStatus = worktree && ["failed", "cancelled"].includes(observation.status)
      ? "review"
      : observation.status === "completed" ? "review" : observation.status;
    const threadStatus =
      observation.status === "running"
        ? "active"
        : observation.status === "review"
          ? "completed"
          : observation.status === "cancelled"
            ? "completed"
            : observation.status;
    const alreadyTerminal = TERMINAL_TASK_STATES.has(task.status);
    if (!alreadyTerminal) {
      transition(task, "task", taskStatus, at);
      if (thread) transition(thread, "thread", threadStatus, at);
    }
    if (observation.cursor != null) task.lastCursor = String(observation.cursor);
    if (observation.summary != null) {
      requireText(observation.summary, "observation.summary");
      task.result = {
        summary: observation.summary.trim(),
        observedBy: operation.tool,
        rawStatus: observation.status
      };
    }
    if (observation.artifacts != null) {
      task.artifacts = normalizeStringArray(observation.artifacts, "artifacts");
    }
    if (observation.verification != null) {
      task.verification = normalizeStringArray(observation.verification, "verification");
    }
    if (observation.error != null) task.error = normalizeError(observation.error);
    if (taskStatus === "review" && !alreadyTerminal) {
      run.messages.push(
        messageEnvelope(run, task, "RESULT", task.result?.summary || "Task completed", {
          senderTaskId: task.id,
          recipientTaskId: null,
          metadata: { observationStatus: observation.status }
        }, at)
      );
    }
  }
}

function applySendResult(run, operation, result, at) {
  const task = requireTask(run, operation.taskIds[0]);
  transition(task, "task", "running", at);
  const thread = findThreadForTask(run, task);
  if (thread) transition(thread, "thread", "active", at);
  task.roundTrips += 1;
  if (result.cursor != null) task.lastCursor = String(result.cursor);
  const message = operation.metadata.message || {};
  const type = MESSAGE_TYPES.has(message.type) ? message.type : "QUESTION";
  run.messages.push(
    messageEnvelope(run, task, type, message.payload || "Follow-up sent", {
      senderTaskId: message.sourceTaskId || null,
      recipientTaskId: task.id
    }, at)
  );
}

function applyHandoffStart(run, operation, result, at) {
  requireText(result.runtimeOperationId, "runtimeOperationId");
  operation.runtimeOperationId = result.runtimeOperationId.trim();
  operation.runtimeRevision = Number.isInteger(result.runtimeRevision)
    ? result.runtimeRevision
    : null;
  const task = requireTask(run, operation.taskIds[0]);
  if (task.status !== "settling") transition(task, "task", "needs_attention", at);
  else {
    enrichSettlement(task);
    task.settlement.phase = "handoff_pending";
  }
  const thread = findThreadForTask(run, task);
  if (thread) transition(thread, "thread", "handoff", at);
  const state = requireHandoffState(result.handoffState);
  if (state === "completed") {
    finishOperation(operation, "succeeded", result, at);
    applyCompletedHandoff(run, task, result, at);
  } else if (state === "failed") {
    failOperation(run, operation, result.error, at);
    if (thread) transition(thread, "thread", "needs_attention", at);
  } else {
    finishOperation(operation, "pending", result, at);
  }
}

function applyHandoffStatus(run, operation, result, at) {
  const parent = requireOperation(run, operation.metadata.parentOperationId);
  const task = requireTask(run, parent.taskIds[0]);
  const state = requireHandoffState(result.handoffState);
  if (state === "pending") {
    operation.runtimeRevision = Number.isInteger(result.runtimeRevision)
      ? result.runtimeRevision
      : operation.runtimeRevision;
    finishOperation(operation, "pending", result, at);
    return;
  }
  if (state === "failed") {
    failOperation(run, operation, result.error, at);
    if (["prepared", "pending"].includes(parent.status)) failOperation(run, parent, result.error, at);
    const thread = findThreadForTask(run, task);
    if (thread) transition(thread, "thread", "needs_attention", at);
    return;
  }
  finishOperation(operation, "succeeded", result, at);
  if (["prepared", "pending"].includes(parent.status)) {
    finishOperation(parent, "succeeded", result, at);
  }
  applyCompletedHandoff(run, task, result, at);
}

function applyCompletedHandoff(run, task, result, at) {
  const oldThread = findThreadForTask(run, task);
  const oldKey = oldThread ? threadKey(oldThread) : null;
  const nextThreadId = optionalText(result.threadId || task.threadId);
  const nextHostId = optionalText(result.hostId || task.hostId);
  task.threadId = nextThreadId;
  task.hostId = nextHostId;
  const settling = task.status === "settling";
  if (!settling) transition(task, "task", result.taskStatus === "idle" ? "idle" : "running", at);
  else {
    enrichSettlement(task);
    task.settlement.phase = "handoff_pending";
  }
  if (oldKey) delete run.threads[oldKey];
  const thread = {
    ...(oldThread || makeThreadRecord({ task, status: "active", at })),
    id: nextThreadId,
    hostId: nextHostId,
    clientThreadId: null,
    runtimeCwd: typeof result.cwd === "string" && path.isAbsolute(result.cwd)
      ? result.cwd
      : oldThread?.runtimeCwd || null,
    status: result.taskStatus === "idle" ? "idle" : "active",
    updatedAt: at
  };
  run.threads[threadKey(thread)] = thread;
}

function applyTitleResult(run, operation, result, at) {
  const task = requireTask(run, operation.taskIds[0]);
  const title = optionalText(result.title || operation.arguments.title);
  task.threadTitle = title;
  const thread = findThreadForTask(run, task);
  if (thread) {
    thread.title = title;
    thread.updatedAt = at;
  }
}

function applyPinnedResult(run, operation, result, at) {
  const task = requireTask(run, operation.taskIds[0]);
  const sectionId = result.sectionId ?? operation.arguments.sectionId;
  if (typeof sectionId !== "string" || !sectionId.trim()) {
    throw new ControlPlaneError("INVALID_SECTION_RESULT", "sectionId result must be a non-empty string");
  }
  const pinned = sectionId === "pinned";
  const thread = findThreadForTask(run, task);
  if (thread) {
    thread.pinned = pinned;
    thread.updatedAt = at;
  }
  if (isWorktreeTask(task)) {
    enrichSettlement(task);
    task.worktree.pinned = pinned;
    if (task.status === "settling" && pinned === false) {
      task.settlement.unpinReceipt = {
        operationId: operation.id,
        threadId: task.threadId,
        sectionId,
        pinned: false,
        recordedAt: at
      };
    }
  }
}

function applyArchivedResult(run, operation, result, at) {
  const task = requireTask(run, operation.taskIds[0]);
  const archived = result.archived ?? operation.arguments.archived;
  if (typeof archived !== "boolean") {
    throw new ControlPlaneError("INVALID_ARCHIVED_RESULT", "archived result must be boolean");
  }
  const thread = findThreadForTask(run, task);
  if (!thread) return;
  thread.archived = archived;
  if (archived) {
    thread.previousStatus = thread.status;
    transition(thread, "thread", "archived", at);
  } else {
    const restoredStatus =
      thread.previousStatus && thread.previousStatus !== "archived"
        ? thread.previousStatus
        : "idle";
    transition(thread, "thread", restoredStatus, at);
    thread.previousStatus = null;
  }
  if (isWorktreeTask(task) && task.status === "settling" && archived) {
    enrichSettlement(task);
    task.settlement.archiveReceipt = {
      operationId: operation.id,
      threadId: task.threadId,
      hostId: task.hostId || null,
      archived: true,
      recordedAt: at
    };
    task.settlement.phase = "cleanup_pending";
  }
}

function finishOperation(operation, status, result, at) {
  transition(operation, "operation", status, at);
  operation.result = summarizeResult(result);
  operation.error = null;
}

function failOperation(run, operation, error, at) {
  transition(operation, "operation", "failed", at);
  operation.error = normalizeError(error) || {
    code: "NATIVE_CALL_FAILED",
    message: `${operation.tool} failed`
  };
  const task = run.tasks[operation.taskIds[0]];
  if (
    task &&
    !TERMINAL_TASK_STATES.has(task.status) &&
    [
      "codex_app__send_message_to_thread",
      "codex_app__handoff_thread",
      "codex_app__get_handoff_status"
    ].includes(operation.tool)
  ) {
    task.error = structuredClone(operation.error);
    if (task.status === "settling" && isWorktreeTask(task)) {
      enrichSettlement(task);
      task.settlement.phase = "blocked";
      task.settlement.blocker = {
        ...structuredClone(operation.error),
        resumePhase: operation.tool.includes("handoff") ? "handoff_pending" : task.settlement.phase,
        recordedAt: at
      };
      return;
    }
    try {
      transition(task, "task", "needs_attention", at);
    } catch {
      // The operation failure is still retained even when task state is not movable.
    }
  }
}

function makeThreadRecord({ task, threadId = task.threadId, hostId = task.hostId, clientThreadId = task.clientThreadId, status, at }) {
  return {
    id: threadId || null,
    hostId: hostId || null,
    clientThreadId: clientThreadId || null,
    taskId: task.id,
    sourceTaskId: task.sourceTaskId,
    title: task.threadTitle,
    project: structuredClone(task.project),
    runtimeCwd: null,
    status,
    previousStatus: null,
    pinned: false,
    archived: false,
    createdAt: at,
    updatedAt: at
  };
}

function threadKey(thread) {
  return thread.id || `client:${thread.clientThreadId}`;
}

function findThreadForTask(run, task) {
  if (task.threadId && run.threads[task.threadId]) return run.threads[task.threadId];
  if (task.clientThreadId && run.threads[`client:${task.clientThreadId}`]) {
    return run.threads[`client:${task.clientThreadId}`];
  }
  return Object.values(run.threads).find((thread) => thread.taskId === task.id) || null;
}

function messageEnvelope(run, task, type, payload, options, at) {
  if (!MESSAGE_TYPES.has(type)) {
    throw new ControlPlaneError("INVALID_MESSAGE_TYPE", `Unsupported message type: ${type}`);
  }
  const senderTask = options?.senderTaskId ? run.tasks[options.senderTaskId] : null;
  const recipientTask = options?.recipientTaskId ? run.tasks[options.recipientTaskId] : null;
  const provenanceTask = senderTask || task;
  return {
    schemaVersion: "codex-thread-message/v2",
    id: makeId("msg"),
    runId: run.id,
    type,
    createdAt: at,
    sender: {
      role: senderTask ? senderTask.role : "controller",
      taskId: senderTask?.id || null,
      threadId: senderTask?.threadId || run.controller.threadId || null,
      hostId: senderTask?.hostId || run.controller.hostId || null
    },
    recipient: {
      role: recipientTask ? recipientTask.role : "controller",
      taskId: recipientTask?.id || null,
      threadId: recipientTask?.threadId || run.controller.threadId || null,
      hostId: recipientTask?.hostId || run.controller.hostId || null
    },
    payload,
    metadata: structuredClone(options?.metadata || {}),
    provenance: {
      artifacts: [...provenanceTask.artifacts],
      verification: [...provenanceTask.verification]
    }
  };
}

function defaultSettlement(required = false) {
  return {
    required,
    decision: null,
    phase: required ? "awaiting_decision" : "not_required",
    terminalStatus: null,
    operationIds: [],
    adoptionReceipt: null,
    unpinReceipt: null,
    archiveReceipt: null,
    cleanupReceipt: null,
    blocker: null
  };
}

function enrichSettlement(task) {
  const worktree = isWorktreeTask(task);
  task.git = {
    commonDirectory: null,
    primaryCheckout: task.cwd,
    targetBranch: task.target?.integrationTargetBranch || null,
    targetHeadAtDispatch: null,
    accessMode: task.target?.accessMode || "write",
    ...(task.git || {})
  };
  task.worktree = {
    managed: worktree,
    purpose: task.target?.worktreePurpose || null,
    authority: task.target?.worktreeLifecycleAuthority || null,
    runtimeCwd: null,
    threadId: task.threadId || null,
    clientThreadId: task.clientThreadId || null,
    pinned: false,
    identityCaptured: false,
    headAtReview: null,
    branchAtReview: null,
    headAtBinding: null,
    branchAtBinding: null,
    detachedAtBinding: false,
    candidateFingerprint: null,
    candidateCapture: null,
    ...(task.worktree || {})
  };
  task.settlement = {
    ...defaultSettlement(worktree),
    ...(task.settlement || {})
  };
  if (!Array.isArray(task.settlement.operationIds)) task.settlement.operationIds = [];
}

function isWorktreeTask(task) {
  return task?.target?.environment === "worktree" || task?.project?.environment === "worktree";
}

function recalculateRun(run, at) {
  const tasks = Object.values(run.tasks);
  if (tasks.length === 0) return;
  let desired = "active";
  if (tasks.every((task) => task.status === "cancelled")) desired = "cancelled";
  else if (tasks.every((task) => ["completed", "cancelled"].includes(task.status))) desired = "completed";
  else if (tasks.every((task) => TERMINAL_TASK_STATES.has(task.status)) && tasks.some((task) => task.status === "failed")) desired = "failed";
  else if (tasks.some((task) => task.status === "settling")) desired = "settling";
  else if (
    tasks.some((task) => task.status === "review") &&
    tasks.every((task) => task.status === "review" || TERMINAL_TASK_STATES.has(task.status))
  ) desired = "review";
  if (run.status !== desired) transition(run, "run", desired, at);
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

function requireOperation(run, operationId) {
  const operation = run.operations?.[operationId];
  if (!operation) {
    throw new ControlPlaneError("OPERATION_NOT_FOUND", `Unknown operation: ${operationId}`);
  }
  return operation;
}

function requireRunOpen(run) {
  if (["completed", "cancelled"].includes(run.status)) {
    throw new ControlPlaneError("RUN_CLOSED", `Run ${run.id} is ${run.status}`);
  }
}

function requireLiveConfirmation(run, confirmed, action) {
  if (run.executionMode === "dry-run") return;
  if (confirmed !== true) {
    throw new ControlPlaneError(
      "LIVE_CONFIRMATION_REQUIRED",
      `${action} requires confirmLiveAction=true from an explicit user request`
    );
  }
}

function touchRun(run, at) {
  run.updatedAt = at;
}

function event(type, summary, details, at) {
  return { id: makeId("evt"), type, summary, details: structuredClone(details || {}), at };
}

function requireText(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new ControlPlaneError("INVALID_INPUT", `${name} is required`);
  }
}

function optionalText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function requireHandoffState(value) {
  const state = value || "pending";
  if (!["pending", "completed", "failed"].includes(state)) {
    throw new ControlPlaneError(
      "INVALID_HANDOFF_STATE",
      `handoffState must be pending, completed, or failed; received ${state}`
    );
  }
  return state;
}

function normalizeStringArray(value, name) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim())) {
    throw new ControlPlaneError("INVALID_STRING_ARRAY", `${name} must contain non-empty strings`);
  }
  return value.map((entry) => entry.trim());
}

function normalizeError(value) {
  if (!value) return null;
  if (typeof value === "string") return { code: "NATIVE_CALL_FAILED", message: value };
  if (!isRecord(value)) return { code: "NATIVE_CALL_FAILED", message: String(value) };
  return {
    code: optionalText(value.code) || "NATIVE_CALL_FAILED",
    message: optionalText(value.message) || "Native tool call failed",
    details: value.details ?? null
  };
}

function summarizeResult(result) {
  if (!isRecord(result)) return { value: result };
  return compactObject({
    status: result.status || "succeeded",
    summary: optionalText(result.summary),
    cursor: result.cursor ?? null,
    handoffState: result.handoffState ?? null,
    runtimeRevision: result.runtimeRevision ?? null,
    threadId: optionalText(result.threadId),
    hostId: optionalText(result.hostId),
    listSchemaVersion: Number.isInteger(result.schemaVersion) ? result.schemaVersion : null,
    threadCount: Array.isArray(result.threads) ? result.threads.length : null,
    bindingCount: Number.isInteger(result.bindingCount) ? result.bindingCount : null,
    observationCount: Array.isArray(result.observations) ? result.observations.length : null
  });
}

function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== null && entry !== undefined && entry !== "")
  );
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asControlPlaneError(error) {
  if (error instanceof ControlPlaneError) return error;
  return new ControlPlaneError(error.code || "INVALID_NATIVE_INTENT", error.message);
}
