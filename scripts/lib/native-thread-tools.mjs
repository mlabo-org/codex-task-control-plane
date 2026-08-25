import path from "node:path";

export const CORE_NATIVE_THREAD_TOOLS = Object.freeze([
  "codex_app__list_projects",
  "codex_app__create_thread",
  "codex_app__list_threads",
  "codex_app__wait_threads",
  "codex_app__read_thread",
  "codex_app__send_message_to_thread"
]);

export const MANAGEMENT_NATIVE_THREAD_TOOLS = Object.freeze([
  "codex_app__fork_thread",
  "codex_app__handoff_thread",
  "codex_app__get_handoff_status",
  "codex_app__set_thread_title",
  "codex_app__set_thread_pinned",
  "codex_app__set_thread_archived",
  "codex_app__navigate_to_codex_page"
]);

export const NATIVE_THREAD_TOOLS = Object.freeze([
  ...CORE_NATIVE_THREAD_TOOLS,
  ...MANAGEMENT_NATIVE_THREAD_TOOLS
]);

export const PREPARABLE_THREAD_TOOLS = Object.freeze([
  "codex_app__list_threads",
  "codex_app__wait_threads",
  "codex_app__read_thread",
  "codex_app__send_message_to_thread",
  "codex_app__fork_thread",
  "codex_app__handoff_thread",
  "codex_app__get_handoff_status",
  "codex_app__set_thread_title",
  "codex_app__set_thread_pinned",
  "codex_app__set_thread_archived",
  "codex_app__navigate_to_codex_page"
]);

export const MUTATING_THREAD_TOOLS = new Set([
  "codex_app__send_message_to_thread",
  "codex_app__fork_thread",
  "codex_app__handoff_thread",
  "codex_app__set_thread_title",
  "codex_app__set_thread_pinned",
  "codex_app__set_thread_archived",
  "codex_app__navigate_to_codex_page"
]);

const ALLOWED_THINKING = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra"
]);

const ALLOWED_STATE_CONTROLS = new Set(["none", "codex-activity-oversight"]);
const ALLOWED_ENVIRONMENTS = new Set(["local", "worktree"]);
const ALLOWED_ACCESS_MODES = new Set(["read", "write"]);
const ALLOWED_WORKTREE_PURPOSES = new Set([
  "same_repo_parallel_write",
  "destructive_experiment",
  "explicit_user_isolation"
]);
const ALLOWED_DELIVERY_MODES = new Set(["ITERATIVE_DELIVERY", "ONE_SHOT_QUALITY"]);
const ALLOWED_MESSAGE_TYPES = new Set([
  "QUESTION",
  "PROPOSAL",
  "STATUS",
  "REVIEW",
  "DECISION",
  "CANCEL"
]);

export function capabilityReport(availableTools = []) {
  const available = [...new Set(availableTools.filter((value) => typeof value === "string"))]
    .filter((value) => NATIVE_THREAD_TOOLS.includes(value))
    .sort();
  const availableSet = new Set(available);
  const missingCore = CORE_NATIVE_THREAD_TOOLS.filter((tool) => !availableSet.has(tool));
  const missingManagement = MANAGEMENT_NATIVE_THREAD_TOOLS.filter(
    (tool) => !availableSet.has(tool)
  );
  return {
    coreReady: missingCore.length === 0,
    complete: missingCore.length === 0 && missingManagement.length === 0,
    available,
    missingCore,
    missingManagement,
    required: [...NATIVE_THREAD_TOOLS]
  };
}

export function validateTaskContract(input) {
  for (const name of ["title", "prompt", "role", "cwd"]) {
    if (typeof input[name] !== "string" || !input[name].trim()) {
      throw contractError("INVALID_TASK", `${name} is required`);
    }
  }
  if (!path.isAbsolute(input.cwd)) {
    throw contractError("INVALID_CWD", "cwd must be an absolute project path");
  }
  if (input.model != null && (typeof input.model !== "string" || !input.model.trim())) {
    throw contractError("INVALID_MODEL", "model must be a non-empty string when provided");
  }
  const stateControl = input.stateControl || "none";
  if (!ALLOWED_STATE_CONTROLS.has(stateControl)) {
    throw contractError("INVALID_STATE_CONTROL", `Unsupported state control: ${stateControl}`);
  }
  const environment = input.environment || "local";
  if (!ALLOWED_ENVIRONMENTS.has(environment)) {
    throw contractError("INVALID_ENVIRONMENT", `Unsupported environment: ${environment}`);
  }
  const accessMode = input.accessMode || "write";
  if (!ALLOWED_ACCESS_MODES.has(accessMode)) {
    throw contractError("INVALID_ACCESS_MODE", `Unsupported access mode: ${accessMode}`);
  }
  if (environment === "worktree") {
    if (accessMode !== "write") {
      throw contractError(
        "WORKTREE_WRITE_ACCESS_REQUIRED",
        "managed worktree tasks require accessMode: write"
      );
    }
    if (!ALLOWED_WORKTREE_PURPOSES.has(input.worktreePurpose)) {
      throw contractError(
        "WORKTREE_PURPOSE_REQUIRED",
        "worktreePurpose must identify the explicitly authorized worktree lifecycle"
      );
    }
    if (!isUserAuthority(input.worktreeLifecycleAuthority)) {
      throw contractError(
        "WORKTREE_AUTHORITY_REQUIRED",
        "worktreeLifecycleAuthority must begin with user_request:"
      );
    }
    if (
      typeof input.integrationTargetBranch !== "string" ||
      !input.integrationTargetBranch.trim()
    ) {
      throw contractError(
        "TARGET_BRANCH_REQUIRED",
        "worktree tasks require an exact integrationTargetBranch"
      );
    }
    if (input.startingState != null) {
      throw contractError(
        "UNSUPPORTED_WORKTREE_STARTING_STATE",
        "worktree startingState variants are unsupported; use the exact target branch"
      );
    }
  }
  if (input.thinking != null && !ALLOWED_THINKING.has(input.thinking)) {
    throw contractError("INVALID_THINKING", `Unsupported reasoning effort: ${input.thinking}`);
  }
  if ((input.model || input.thinking) && !isUserAuthority(input.profileAuthority)) {
    throw contractError(
      "MODEL_AUTHORITY_REQUIRED",
      "model or thinking overrides require profileAuthority beginning with user_request:"
    );
  }
  if (input.startingState != null) validateStartingState(input.startingState);
  const deliveryMode = input.deliveryMode || "ITERATIVE_DELIVERY";
  if (!ALLOWED_DELIVERY_MODES.has(deliveryMode)) {
    throw contractError("INVALID_DELIVERY_MODE", `Unsupported delivery mode: ${deliveryMode}`);
  }
  if (deliveryMode === "ONE_SHOT_QUALITY" && !isUserAuthority(input.deliveryModeAuthority)) {
    throw contractError(
      "ONE_SHOT_AUTHORITY_REQUIRED",
      "ONE_SHOT_QUALITY requires deliveryModeAuthority beginning with user_request:"
    );
  }
  if (stateControl === "codex-activity-oversight") {
    if (
      typeof input.stateControlScope !== "string" ||
      !input.stateControlScope.trim()
    ) {
      throw contractError(
        "STATE_CONTROL_SCOPE_REQUIRED",
        "stateControlScope is required for Codex Activity Oversight task threads"
      );
    }
  }
}

export function createTaskRecord(input, { id, at }) {
  validateTaskContract(input);
  return {
    id,
    title: input.title.trim(),
    prompt: input.prompt.trim(),
    role: input.role.trim(),
    cwd: path.resolve(input.cwd),
    status: "created",
    threadTitle: null,
    threadId: null,
    hostId: null,
    clientThreadId: null,
    sourceTaskId: input.sourceTaskId || null,
    project: null,
    target: {
      environment: input.environment || "local",
      accessMode: input.accessMode || "write",
      integrationTargetBranch: input.integrationTargetBranch?.trim() || null,
      worktreePurpose: input.worktreePurpose || null,
      worktreeLifecycleAuthority: input.worktreeLifecycleAuthority?.trim() || null,
      startingState: input.startingState ? structuredClone(input.startingState) : null
    },
    profile: {
      model: input.model?.trim() || null,
      thinking: input.thinking || null,
      authority: input.profileAuthority?.trim() || null
    },
    workflow: {
      stateControl: input.stateControl || "none",
      stateControlScope: input.stateControlScope?.trim() || null,
      deliveryMode: input.deliveryMode || "ITERATIVE_DELIVERY",
      deliveryModeAuthority: input.deliveryModeAuthority?.trim() || null
    },
    acceptanceCriteria: normalizeStringArray(input.acceptanceCriteria),
    createdAt: at,
    updatedAt: at,
    roundTrips: 0,
    lastCursor: null,
    result: null,
    error: null,
    artifacts: [],
    verification: []
  };
}

export function buildThreadIdentityMarker(run, task) {
  if (typeof run?.id !== "string" || !run.id.trim()) {
    throw contractError("INVALID_THREAD_IDENTITY", "run.id is required for thread identity");
  }
  if (typeof task?.id !== "string" || !task.id.trim()) {
    throw contractError("INVALID_THREAD_IDENTITY", "task.id is required for thread identity");
  }
  return `[TO:${shortId(run.id)}:${shortId(task.id)}]`;
}

export function buildDispatchPreparation(run, task) {
  const title = `${buildThreadIdentityMarker(run, task)} ${task.role} · ${task.title}`;
  return {
    projectLookup: {
      tool: "codex_app__list_projects",
      arguments: {},
      exactPath: task.cwd
    },
    createThreadTemplate: compactObject({
      prompt: buildWorkerPrompt(run, task),
      title,
      model: task.profile.model,
      thinking: task.profile.thinking
    }),
    threadTitle: title
  };
}

export function resolveProjectLaunch(task, operation, project) {
  for (const name of ["projectId", "path"]) {
    if (typeof project?.[name] !== "string" || !project[name].trim()) {
      throw contractError("INVALID_PROJECT", `${name} is required from list_projects`);
    }
  }
  if (path.resolve(project.path) !== path.resolve(task.cwd)) {
    throw contractError(
      "PROJECT_PATH_MISMATCH",
      `Selected project path ${project.path} does not match task cwd ${task.cwd}`
    );
  }
  if (project.projectKind === "chatgpt") {
    throw contractError(
      "UNSUPPORTED_PROJECT_KIND",
      "ChatGPT cloud projects are outside this local Codex thread route"
    );
  }
  const isGitRepository = project.isGitRepository === true;
  const environment = task.target.environment || "local";
  if (environment === "worktree" && !isGitRepository) {
    throw contractError(
      "WORKTREE_REQUIRES_GIT",
      "The selected project is not a Git repository; use the local environment"
    );
  }
  if (environment === "worktree") {
    if (project.isLinkedWorktree === true || project.isPrimaryCheckout === false) {
      throw contractError(
        "PRIMARY_CHECKOUT_REQUIRED",
        "worktree tasks require the repository's authoritative primary checkout"
      );
    }
    validateWorktreeAdmission(task, project.availableNativeTools || project.nativeTools || []);
  }
  const environmentValue =
    environment === "worktree"
      ? compactObject({ type: "worktree" })
      : { type: "local" };
  return {
    tool: "codex_app__create_thread",
    arguments: {
      ...structuredClone(operation.createThreadTemplate),
      target: {
        type: "project",
        projectId: project.projectId,
        environment: environmentValue
      }
    },
    project: {
      projectId: project.projectId,
      projectKind: project.projectKind || null,
      label: project.label || null,
      path: path.resolve(project.path),
      hostId: project.hostId || null,
      isGitRepository,
      environment
    }
  };
}

export function buildNativeOperationIntent({ run, tasks, tool, input, operations }) {
  if (!PREPARABLE_THREAD_TOOLS.includes(tool)) {
    throw contractError("UNSUPPORTED_NATIVE_TOOL", `Unsupported native tool: ${tool}`);
  }
  if (tool === "codex_app__list_threads") {
    const limit = input.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw contractError("INVALID_LIMIT", "list_threads limit must be from 1 to 200");
    }
    return { tool, arguments: { limit }, taskIds: [] };
  }
  if (tool === "codex_app__wait_threads") {
    const taskIds = requireTaskIds(input.taskIds, 1, 8);
    const afterCursors = input.afterCursors || {};
    if (!afterCursors || typeof afterCursors !== "object" || Array.isArray(afterCursors)) {
      throw contractError("INVALID_CURSORS", "afterCursors must be an object keyed by task ID");
    }
    const targets = taskIds.map((taskId) => {
      const task = requireThreadTask(tasks, taskId);
      return compactObject({
        threadId: task.threadId,
        hostId: task.hostId,
        afterCursor: afterCursors[taskId] || task.lastCursor
      });
    });
    const timeoutMs = input.timeoutMs ?? 120_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 3_600_000) {
      throw contractError("INVALID_TIMEOUT", "wait_threads timeoutMs must be from 0 to 3600000");
    }
    return { tool, arguments: { targets, timeoutMs }, taskIds };
  }
  if (tool === "codex_app__read_thread") {
    const task = requireThreadTask(tasks, input.taskId);
    const turnLimit = input.turnLimit ?? 5;
    if (!Number.isInteger(turnLimit) || turnLimit < 1) {
      throw contractError("INVALID_TURN_LIMIT", "turnLimit must be a positive integer");
    }
    if (
      input.maxOutputCharsPerItem != null &&
      (!Number.isInteger(input.maxOutputCharsPerItem) || input.maxOutputCharsPerItem < 1)
    ) {
      throw contractError(
        "INVALID_OUTPUT_LIMIT",
        "maxOutputCharsPerItem must be a positive integer"
      );
    }
    const argumentsValue = compactObject({
      threadId: task.threadId,
      hostId: task.hostId,
      cursor: input.cursor,
      turnLimit,
      includeOutputs: input.includeOutputs === true,
      maxOutputCharsPerItem: input.maxOutputCharsPerItem
    });
    return { tool, arguments: argumentsValue, taskIds: [task.id] };
  }
  if (tool === "codex_app__send_message_to_thread") {
    const task = requireThreadTask(tasks, input.taskId);
    requireText(input.prompt, "prompt");
    const profile = validateProfileOverride(input);
    const messageType = input.messageType || "QUESTION";
    if (!ALLOWED_MESSAGE_TYPES.has(messageType)) {
      throw contractError("INVALID_MESSAGE_TYPE", `Unsupported message type: ${messageType}`);
    }
    return {
      tool,
      arguments: compactObject({
        threadId: task.threadId,
        hostId: task.hostId,
        prompt: input.prompt.trim(),
        model: profile.model,
        thinking: profile.thinking
      }),
      taskIds: [task.id],
      message: {
        type: messageType,
        payload: input.prompt.trim(),
        sourceTaskId: input.sourceTaskId || null
      }
    };
  }
  if (tool === "codex_app__fork_thread") {
    const task = requireThreadTask(tasks, input.taskId);
    const environment = input.environment || "same-directory";
    if (!["same-directory", "worktree"].includes(environment)) {
      throw contractError("INVALID_FORK_ENVIRONMENT", `Unsupported fork environment: ${environment}`);
    }
    if (environment === "worktree") {
      throw contractError(
        "WORKTREE_FORK_UNSUPPORTED",
        "worktree fork is disabled until its native task binding is deterministic"
      );
    }
    return {
      tool,
      arguments: {
        threadId: task.threadId,
        environment: { type: environment }
      },
      taskIds: [task.id],
      forkTask: structuredClone(input.forkTask || null)
    };
  }
  if (tool === "codex_app__handoff_thread") {
    const task = requireThreadTask(tasks, input.taskId);
    if (input.destinationHostId != null) requireText(input.destinationHostId, "destinationHostId");
    if (input.followUpPrompt != null) requireText(input.followUpPrompt, "followUpPrompt");
    return {
      tool,
      arguments: compactObject({
        threadId: task.threadId,
        destinationHostId: input.destinationHostId,
        followUpPrompt: input.followUpPrompt
      }),
      taskIds: [task.id]
    };
  }
  if (tool === "codex_app__get_handoff_status") {
    const parent = operations?.[input.handoffOperationId];
    if (!parent || parent.tool !== "codex_app__handoff_thread" || !parent.runtimeOperationId) {
      throw contractError(
        "HANDOFF_OPERATION_NOT_READY",
        "handoffOperationId must reference a recorded handoff operation"
      );
    }
    const afterRevision = input.afterRevision ?? parent.runtimeRevision;
    const waitMs = input.waitMs ?? 30_000;
    if (afterRevision != null && (!Number.isInteger(afterRevision) || afterRevision < 0)) {
      throw contractError("INVALID_REVISION", "afterRevision must be a non-negative integer");
    }
    if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 60_000) {
      throw contractError("INVALID_WAIT", "waitMs must be an integer from 0 to 60000");
    }
    return {
      tool,
      arguments: compactObject({
        operationId: parent.runtimeOperationId,
        afterRevision,
        waitMs
      }),
      taskIds: [...parent.taskIds],
      parentOperationId: parent.id
    };
  }
  if (tool === "codex_app__set_thread_title") {
    const task = requireThreadTask(tasks, input.taskId);
    requireText(input.title, "title");
    return {
      tool,
      arguments: { threadId: task.threadId, title: input.title.trim() },
      taskIds: [task.id]
    };
  }
  if (tool === "codex_app__set_thread_pinned") {
    const task = requireThreadTask(tasks, input.taskId);
    if (typeof input.pinned !== "boolean") {
      throw contractError("INVALID_PINNED", "pinned must be boolean");
    }
    return {
      tool,
      arguments: { threadId: task.threadId, pinned: input.pinned },
      taskIds: [task.id]
    };
  }
  if (tool === "codex_app__set_thread_archived") {
    const task = requireThreadTask(tasks, input.taskId);
    if (typeof input.archived !== "boolean") {
      throw contractError("INVALID_ARCHIVED", "archived must be boolean");
    }
    return {
      tool,
      arguments: compactObject({
        threadId: task.threadId,
        hostId: task.hostId,
        archived: input.archived
      }),
      taskIds: [task.id]
    };
  }
  const task = requireThreadTask(tasks, input.taskId);
  return {
    tool,
    arguments: { threadId: task.threadId },
    taskIds: [task.id]
  };
}

export function buildWorkerPrompt(run, task) {
  const lines = [
    `THREAD ORCHESTRATION RUN: ${run.id}`,
    `CONTROL TASK: ${task.id}`,
    `ROLE: ${task.role}`,
    `PROJECT PATH: ${task.cwd}`,
    "",
    task.prompt,
    "",
    "Controller contract:",
    "- This is a user-visible Codex task owned by the user.",
    "- Stay within the assigned project and outcome.",
    "- Do not create or steer sibling top-level tasks unless the assignment explicitly authorizes it.",
    "- Return a concise result with changed artifacts, verification, blockers, and unknowns.",
    "- The controller owns cross-thread integration and final acceptance."
  ];
  if (task.acceptanceCriteria.length > 0) {
    lines.push("", "Acceptance criteria:");
    for (const criterion of task.acceptanceCriteria) lines.push(`- ${criterion}`);
  }
  if (task.workflow.stateControl === "codex-activity-oversight") {
    lines.push(
      "",
      "Codex Activity Oversight state-control:",
      "- Native Codex exclusively owns task execution, official subagent dispatch, topology, and integration.",
      "- Use the installed `$codex-activity-oversight` skill only to activate or reconcile this task's `.CAO/` state.",
      `- Keep state-control scope to: ${task.workflow.stateControlScope}.`,
      `- Use delivery mode ${task.workflow.deliveryMode}.`
    );
  }
  return lines.join("\n");
}

export function isUserAuthority(value) {
  return typeof value === "string" && value.startsWith("user_request:") && value.length > 13;
}

export function validateWorktreeAdmission(task, availableTools = []) {
  const target = task?.target || task || {};
  if (target.environment !== "worktree") return true;
  if (target.accessMode !== "write") {
    throw contractError("WORKTREE_WRITE_ACCESS_REQUIRED", "worktree mode requires accessMode: write");
  }
  if (!ALLOWED_WORKTREE_PURPOSES.has(target.worktreePurpose)) {
    throw contractError("WORKTREE_PURPOSE_REQUIRED", "worktreePurpose is required for worktree mode");
  }
  if (!isUserAuthority(target.worktreeLifecycleAuthority)) {
    throw contractError("WORKTREE_AUTHORITY_REQUIRED", "worktreeLifecycleAuthority must begin with user_request:");
  }
  if (typeof target.integrationTargetBranch !== "string" || !target.integrationTargetBranch.trim()) {
    throw contractError("TARGET_BRANCH_REQUIRED", "worktree mode requires an exact integrationTargetBranch");
  }
  if (target.startingState != null) {
    throw contractError("UNSUPPORTED_WORKTREE_STARTING_STATE", "worktree startingState is unsupported");
  }
  const available = new Set(availableTools);
  const missing = [
    "codex_app__list_threads",
    "codex_app__handoff_thread",
    "codex_app__get_handoff_status",
    "codex_app__set_thread_pinned",
    "codex_app__set_thread_archived"
  ].filter((tool) => !available.has(tool));
  if (missing.length > 0) {
    const error = contractError(
      "WORKTREE_NATIVE_CAPABILITIES_REQUIRED",
      `worktree mode requires native lifecycle tools: ${missing.join(", ")}`
    );
    error.missing = missing;
    throw error;
  }
  return true;
}

function validateStartingState(value) {
  if (!value || typeof value !== "object") {
    throw contractError("INVALID_STARTING_STATE", "startingState must be an object");
  }
  if (value.type === "working-tree") return;
  if (value.type === "branch" && typeof value.branchName === "string" && value.branchName.trim()) {
    return;
  }
  throw contractError(
    "INVALID_STARTING_STATE",
    "startingState must be {type:'working-tree'} or {type:'branch', branchName:'existing-ref'}"
  );
}

function validateProfileOverride(input) {
  if (input.model != null && (typeof input.model !== "string" || !input.model.trim())) {
    throw contractError("INVALID_MODEL", "model must be a non-empty string when provided");
  }
  if (input.thinking != null && !ALLOWED_THINKING.has(input.thinking)) {
    throw contractError("INVALID_THINKING", `Unsupported reasoning effort: ${input.thinking}`);
  }
  if ((input.model || input.thinking) && !isUserAuthority(input.profileAuthority)) {
    throw contractError(
      "MODEL_AUTHORITY_REQUIRED",
      "follow-up model overrides require profileAuthority beginning with user_request:"
    );
  }
  return {
    model: input.model?.trim() || null,
    thinking: input.thinking || null
  };
}

function requireTaskIds(value, minimum, maximum) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw contractError(
      "INVALID_TASK_IDS",
      `taskIds must contain from ${minimum} to ${maximum} tasks`
    );
  }
  if (new Set(value).size !== value.length) {
    throw contractError("DUPLICATE_TASK_IDS", "taskIds must be unique");
  }
  return [...value];
}

function requireThreadTask(tasks, taskId) {
  const task = tasks?.[taskId];
  if (!task) throw contractError("TASK_NOT_FOUND", `Unknown task: ${taskId}`);
  if (!task.threadId) {
    throw contractError("THREAD_NOT_BOUND", `Task ${taskId} has no ready thread id`);
  }
  return task;
}

function requireText(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw contractError("INVALID_INPUT", `${name} is required`);
  }
}

function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== null && entry !== undefined && entry !== "")
  );
}

function normalizeStringArray(value) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim())) {
    throw contractError("INVALID_STRING_ARRAY", "acceptanceCriteria must contain non-empty strings");
  }
  return value.map((entry) => entry.trim());
}

function shortId(value) {
  const tail = String(value).split("_").at(-1) || String(value);
  return tail.slice(0, 8);
}

function contractError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
