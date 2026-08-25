const token = document.querySelector('meta[name="control-plane-token"]').content;
const state = {
  ledger: null,
  runId: null,
  taskId: null,
  languagePreference: localStorage.getItem("control-plane-language") || "system",
  themePreference: localStorage.getItem("control-plane-theme") || "system",
  timer: null
};

const translations = {
  en: {
    upperControl: "Upper Control", newRun: "New run", runs: "Runs", connecting: "Connecting", connected: "Connected", disconnected: "Disconnected",
    controlPlane: "Codex Task Control Plane", noRunSelected: "No run selected", language: "Language", theme: "Theme", refresh: "Refresh",
    runtimeBoundary: "Runtime boundary", runtimeBoundaryHelp: "This dashboard stores state and prepares calls. The active Codex controller executes native task tools.",
    runStatus: "Run status", threads: "Threads", tasks: "Tasks", operations: "Operations", workQueue: "Work queue", addTask: "Add task",
    role: "Role", task: "Task", workflow: "State control", status: "Status", actions: "Actions", noTasks: "No tasks", noTasksHelp: "Add one bounded visible-task contract.",
    nativeRuntime: "Native runtime", thread: "Thread", environment: "Environment", accessMode: "Access", repository: "Canonical repository", runtimePath: "Runtime path", purpose: "Purpose / authority", targetBranch: "Target branch", settlement: "Settlement", receipts: "Receipts", pin: "Pinned", noThreads: "No threads", noThreadsHelp: "A native task binding appears after the controller records a launch.",
    intentLedger: "Intent ledger", tool: "Tool", target: "Target", phase: "Phase", noOperations: "No operations", noOperationsHelp: "Prepared native calls and their results appear here.",
    inspection: "Inspection", resultAndArtifacts: "Result & artifacts", selectTask: "Select a task", selectTaskHelp: "Choose a task row to inspect its contract and evidence.",
    audit: "Audit", eventTimeline: "Event timeline", newControlRun: "New control run", objective: "Objective", mode: "Mode", maxRounds: "Max round trips",
    controllerThread: "Controller thread ID", cancel: "Cancel", create: "Create", addControlledTask: "Add controlled task", title: "Title", prompt: "Prompt",
    workingDirectory: "Working directory", codingScope: "CAO state scope", codingScopeHelp: "Optional; use only when Codex Activity Oversight state control is explicitly requested.",
    model: "Model override", authority: "Override authority", criteria: "Acceptance criteria", prepare: "Prepare", simulate: "Simulate", adopt: "Adopt", discard: "Discard", continue: "Continue", requestCancel: "Cancel request",
    evidence: "Verification", artifacts: "Artifacts", result: "Result", contract: "Contract", noEvidence: "No verification evidence", noArtifacts: "No artifacts",
    reconcile: "Reconcile", integrate: "Integrate", cleanup: "Clean up", actionCompleted: "Action completed", actionFailed: "Action failed", loadFailed: "Could not load control-plane state"
  },
  ja: {
    upperControl: "上位管制", newRun: "新規Run", runs: "Run一覧", connecting: "接続中", connected: "接続済み", disconnected: "切断",
    controlPlane: "Codex Task Control Plane", noRunSelected: "Runが選択されていません", language: "言語", theme: "テーマ", refresh: "更新",
    runtimeBoundary: "実行責任境界", runtimeBoundaryHelp: "この画面は状態を保存し呼び出しを準備します。純正taskツールの実行はアクティブなCodex管制役が担当します。",
    runStatus: "Run状態", threads: "スレッド", tasks: "タスク", operations: "操作", workQueue: "作業キュー", addTask: "タスク追加",
    role: "役割", task: "タスク", workflow: "状態管制", status: "状態", actions: "操作", noTasks: "タスクはありません", noTasksHelp: "境界を定めた表示タスク契約を追加してください。",
    nativeRuntime: "純正ランタイム", thread: "スレッド", environment: "環境", accessMode: "アクセス", repository: "正規リポジトリ", runtimePath: "実行worktree", purpose: "目的 / 権限", targetBranch: "対象ブランチ", settlement: "settlement", receipts: "証跡", pin: "ピン留め", noThreads: "スレッドはありません", noThreadsHelp: "管制役が起動結果を記録すると純正taskの紐付けが表示されます。",
    intentLedger: "呼び出し台帳", tool: "ツール", target: "対象", phase: "段階", noOperations: "操作はありません", noOperationsHelp: "準備済みの純正ツール呼び出しと結果が表示されます。",
    inspection: "詳細", resultAndArtifacts: "結果と成果物", selectTask: "タスクを選択", selectTaskHelp: "行を選ぶと契約と証跡を確認できます。",
    audit: "監査", eventTimeline: "イベント履歴", newControlRun: "新規管制Run", objective: "目的", mode: "モード", maxRounds: "最大往復数",
    controllerThread: "管制スレッドID", cancel: "キャンセル", create: "作成", addControlledTask: "管制タスクを追加", title: "タイトル", prompt: "指示",
    workingDirectory: "作業ディレクトリ", codingScope: "CAO状態スコープ", codingScopeHelp: "Codex Activity Oversightの状態管制を明示的に要求した場合だけ任意指定します。",
    model: "モデル上書き", authority: "上書き根拠", criteria: "受け入れ条件", prepare: "準備", simulate: "模擬完了", adopt: "採用", discard: "破棄", continue: "継続", requestCancel: "取消要求",
    evidence: "検証証跡", artifacts: "成果物", result: "結果", contract: "契約", noEvidence: "検証証跡なし", noArtifacts: "成果物なし",
    reconcile: "整合", integrate: "統合", cleanup: "後片付け", actionCompleted: "操作が完了しました", actionFailed: "操作に失敗しました", loadFailed: "管制状態を読み込めませんでした"
  }
};

const elements = {
  runList: document.querySelector("#run-list"), runTitle: document.querySelector("#run-title"), taskRows: document.querySelector("#task-rows"),
  threadRows: document.querySelector("#thread-rows"), operationRows: document.querySelector("#operation-rows"), taskEmpty: document.querySelector("#task-empty"),
  threadEmpty: document.querySelector("#thread-empty"), operationEmpty: document.querySelector("#operation-empty"), inspector: document.querySelector("#inspector-content"),
  eventList: document.querySelector("#event-list"), notice: document.querySelector("#notice"), connection: document.querySelector("#connection-status"),
  newRun: document.querySelector("#new-run-button"), addTask: document.querySelector("#add-task-button"), refresh: document.querySelector("#refresh-button"),
  language: document.querySelector("#language-select"), theme: document.querySelector("#theme-select"), runDialog: document.querySelector("#run-dialog"),
  runForm: document.querySelector("#run-form"), taskDialog: document.querySelector("#task-dialog"), taskForm: document.querySelector("#task-form"),
  metrics: { status: document.querySelector("#metric-run-status"), threads: document.querySelector("#metric-threads"), tasks: document.querySelector("#metric-tasks"), operations: document.querySelector("#metric-operations") }
};

elements.language.value = state.languagePreference;
elements.theme.value = state.themePreference;
applyLanguage();
applyTheme();
elements.language.addEventListener("change", () => { state.languagePreference = elements.language.value; localStorage.setItem("control-plane-language", state.languagePreference); applyLanguage(); render(); });
elements.theme.addEventListener("change", () => { state.themePreference = elements.theme.value; localStorage.setItem("control-plane-theme", state.themePreference); applyTheme(); });
elements.refresh.addEventListener("click", refresh);
elements.newRun.addEventListener("click", () => elements.runDialog.showModal());
elements.addTask.addEventListener("click", () => { if (!state.runId) return; elements.taskForm.elements.cwd.value = Object.values(selectedRun()?.tasks || {})[0]?.cwd || ""; elements.taskDialog.showModal(); });

elements.runForm.addEventListener("submit", async (event) => {
  if (event.submitter?.value !== "create") return;
  event.preventDefault();
  const form = new FormData(elements.runForm);
  const result = await action("createRun", { objective: form.get("objective"), executionMode: form.get("executionMode"), maxRoundTrips: Number(form.get("maxRoundTrips")), controllerThreadId: emptyToNull(form.get("controllerThreadId")) });
  if (!result) return;
  state.runId = result.id; state.taskId = null; elements.runForm.reset(); elements.runDialog.close(); await refresh();
});

elements.taskForm.addEventListener("submit", async (event) => {
  if (event.submitter?.value !== "create") return;
  event.preventDefault();
  const form = new FormData(elements.taskForm);
  const input = {
    runId: state.runId, title: form.get("title"), role: form.get("role"), prompt: form.get("prompt"), cwd: form.get("cwd"),
    environment: form.get("environment"), accessMode: form.get("accessMode"), integrationTargetBranch: emptyToNull(form.get("integrationTargetBranch")), worktreePurpose: emptyToNull(form.get("worktreePurpose")), worktreeLifecycleAuthority: emptyToNull(form.get("worktreeLifecycleAuthority")), stateControl: form.get("stateControl"), acceptanceCriteria: lines(form.get("acceptanceCriteria"))
  };
  for (const key of ["stateControlScope"]) {
    const value = emptyToNull(form.get(key)); if (value) input[key] = value;
  }
  const result = await action("addTask", input);
  if (!result) return;
  state.taskId = result.id; elements.taskForm.reset(); elements.taskDialog.close(); await refresh();
});

elements.taskRows.addEventListener("click", async (event) => {
  const row = event.target.closest("tr[data-task-id]"); if (!row) return;
  state.taskId = row.dataset.taskId;
  const command = event.target.closest("button[data-action]")?.dataset.action;
  if (!command) { render(); return; }
  const task = selectedTask();
  if (command === "prepare") await action("prepareDispatch", { runId: state.runId, taskId: task.id });
  if (command === "simulate") await action("simulateTask", { runId: state.runId, taskId: task.id, summary: "Dashboard dry-run simulation", verification: ["No native task call was executed"], artifacts: [] });
  if (["adopt", "continue", "discard"].includes(command)) await action("decide", { runId: state.runId, taskId: task.id, decision: command, note: `${command} from dashboard` });
  if (command === "integrate") await action("integrateSettlement", { runId: state.runId, taskId: task.id });
  if (command === "cleanup") await action("cleanupSettlement", { runId: state.runId, taskId: task.id });
  if (command === "reconcile") await action("reconcile", { runId: state.runId, taskId: task.id });
  if (command === "cancel") await action("requestCancel", { runId: state.runId, taskId: task.id, reason: "Cancellation requested from dashboard" });
  await refresh();
});

await refresh();
state.timer = window.setInterval(refresh, 5000);

async function refresh() {
  try {
    const body = await fetch("/api/snapshot", { cache: "no-store" }).then((response) => response.json());
    if (!body.ok) throw new Error(body.error?.message || "Snapshot failed");
    state.ledger = body.snapshot;
    const runs = Object.values(state.ledger.runs || {}).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    if (!state.runId || !state.ledger.runs[state.runId]) { state.runId = runs[0]?.id || null; state.taskId = null; }
    setConnection(true); render();
  } catch (error) { setConnection(false); showNotice(`${t("loadFailed")}: ${error.message}`, "danger"); }
}

function render() { renderRuns(); renderSummary(); renderTasks(); renderThreads(); renderOperations(); renderInspector(); renderEvents(); applyLanguage(); }

function renderRuns() {
  const runs = Object.values(state.ledger?.runs || {}).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  elements.runList.replaceChildren(...runs.map((run) => {
    const button = document.createElement("button"); button.type = "button"; button.className = "run-button"; button.setAttribute("aria-current", String(run.id === state.runId));
    button.innerHTML = `<strong>${escapeHtml(run.objective)}</strong><small>${escapeHtml(run.status)} · ${escapeHtml(run.executionMode)}</small>`;
    button.addEventListener("click", () => { state.runId = run.id; state.taskId = null; render(); }); return button;
  }));
}

function renderSummary() {
  const run = selectedRun(); elements.addTask.disabled = !run || ["completed", "cancelled"].includes(run.status);
  if (!run) { elements.runTitle.dataset.i18n = "noRunSelected"; elements.metrics.status.textContent = "—"; elements.metrics.threads.textContent = "0"; elements.metrics.tasks.textContent = "0"; elements.metrics.operations.textContent = "0"; return; }
  delete elements.runTitle.dataset.i18n; elements.runTitle.textContent = run.objective; elements.metrics.status.textContent = run.status;
  elements.metrics.threads.textContent = String(Object.keys(run.threads || {}).length); elements.metrics.tasks.textContent = String(Object.keys(run.tasks || {}).length); elements.metrics.operations.textContent = String(Object.keys(run.operations || {}).length);
}

function renderTasks() {
  const run = selectedRun(); const tasks = Object.values(run?.tasks || {}); elements.taskEmpty.hidden = tasks.length > 0;
  elements.taskRows.replaceChildren(...tasks.map((task) => {
    const row = document.createElement("tr"); row.dataset.taskId = task.id; row.classList.toggle("is-selected", task.id === state.taskId);
    row.innerHTML = `<td>${escapeHtml(task.role)}</td><td><strong>${escapeHtml(task.title)}</strong><br><code>${shortId(task.threadId || task.clientThreadId || task.id)}</code></td><td><span class="profile-stack"><code>${escapeHtml(task.target?.environment || "local")}</code><small>${escapeHtml(task.target?.accessMode || "write")}</small></span></td><td>${statusChip(displayStatus(task))}</td><td><div class="table-actions">${taskActions(task, run)}</div></td>`;
    return row;
  }));
}

function renderThreads() {
  const run = selectedRun(); const threads = Object.values(run?.threads || {}); elements.threadEmpty.hidden = threads.length > 0;
  elements.threadRows.replaceChildren(...threads.map((thread) => {
    const task = run.tasks?.[thread.taskId]; const row = document.createElement("tr");
    const settlement = task?.settlement || {};
    const worktree = task?.worktree || {};
    row.innerHTML = `<td><code title="${escapeHtml(thread.id || thread.clientThreadId)}">${shortId(thread.id || thread.clientThreadId)}</code><br><small>${escapeHtml(thread.hostId || "local")}</small></td><td>${escapeHtml(task?.title || thread.taskId)}</td><td>${escapeHtml(thread.project?.environment || task?.target?.environment || "local")}</td><td><code>${escapeHtml(thread.project?.canonicalRepository || task?.git?.commonDirectory || "—")}</code></td><td><code>${escapeHtml(thread.runtimeCwd || worktree.runtimeCwd || "—")}</code></td><td>${escapeHtml(settlement.phase || (settlement.required ? "awaiting_decision" : "not_required"))}</td><td>${escapeHtml(String(worktree.pinned ?? thread.pinned ?? false))}</td><td>${statusChip(displayStatus(task || thread))}</td>`; return row;
  }));
}

function renderOperations() {
  const run = selectedRun(); const operations = Object.values(run?.operations || {}).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); elements.operationEmpty.hidden = operations.length > 0;
  elements.operationRows.replaceChildren(...operations.map((operation) => {
    const row = document.createElement("tr"); row.innerHTML = `<td><code>${escapeHtml(operation.tool.replace("codex_app__", ""))}</code></td><td>${operation.taskIds.map(shortId).join(", ") || "—"}</td><td>${escapeHtml(operation.phase)}</td><td>${statusChip(operation.status)}</td>`; return row;
  }));
}

function renderInspector() {
  const task = selectedTask(); if (!task) { elements.inspector.innerHTML = `<div class="mlh-empty"><strong>${t("selectTask")}</strong><span>${t("selectTaskHelp")}</span></div>`; return; }
  const settlement = task.settlement || {}; const worktree = task.worktree || {}; const git = task.git || {};
  elements.inspector.innerHTML = `<div class="inspector-block"><h3>${t("contract")}</h3><p>${escapeHtml(task.prompt)}</p><code>${escapeHtml(task.cwd)}</code><p>${t("accessMode")}: ${escapeHtml(task.target?.accessMode || git.accessMode || "write")} · ${t("targetBranch")}: ${escapeHtml(task.target?.integrationTargetBranch || git.targetBranch || "—")}</p><p>${t("repository")}: <code>${escapeHtml(git.commonDirectory || task.project?.canonicalRepository || "—")}</code></p><p>${t("purpose")}: ${escapeHtml(worktree.purpose || "—")} / ${escapeHtml(worktree.authority || "—")}</p></div><div class="inspector-block"><h3>${t("settlement")}</h3><p>${escapeHtml(settlement.phase || (settlement.required ? "awaiting_decision" : "not_required"))}</p><p>${t("runtimePath")}: <code>${escapeHtml(worktree.runtimeCwd || task.thread?.runtimeCwd || "—")}</code></p><p>${t("pin")}: ${escapeHtml(String(worktree.pinned ?? task.thread?.pinned ?? false))}</p><p>${t("receipts")}: adoption=${escapeHtml(settlement.adoptionReceipt?.targetCommit || "—")} (${escapeHtml(settlement.adoptionReceipt?.integrationStrategy || "—")}); cleanup=${escapeHtml(settlement.cleanupReceipt?.mode || "—")}</p><p>${escapeHtml(settlement.blocker?.message || task.blocker?.message || "")}</p></div><div class="inspector-block"><h3>${t("result")}</h3><p>${escapeHtml(task.result?.summary || "—")}</p></div><div class="inspector-block"><h3>${t("evidence")}</h3>${renderList(task.verification, t("noEvidence"))}</div><div class="inspector-block"><h3>${t("artifacts")}</h3>${renderList(task.artifacts, t("noArtifacts"))}</div>`;
}

function renderEvents() {
  const events = [...(selectedRun()?.events || [])].reverse(); elements.eventList.replaceChildren(...events.map((entry) => {
    const item = document.createElement("li"); item.innerHTML = `<span class="event-dot" aria-hidden="true"></span><div><strong>${escapeHtml(entry.summary)}</strong><small>${escapeHtml(formatTime(entry.at))} · ${escapeHtml(entry.type)}</small></div>`; return item;
  }));
}

function taskActions(task, run) {
  const actions = [];
  if (["created", "failed"].includes(task.status)) actions.push(`<button class="mlh-button is-small" data-action="prepare">${t("prepare")}</button>`);
  if (run.executionMode === "dry-run" && ["created", "prepared"].includes(task.status)) actions.push(`<button class="mlh-button is-small is-quiet" data-action="simulate">${t("simulate")}</button>`);
  if (task.status === "review") { actions.push(`<button class="mlh-button is-small is-primary" data-action="adopt">${t("adopt")}</button>`); actions.push(`<button class="mlh-button is-small is-quiet" data-action="continue">${t("continue")}</button>`); actions.push(`<button class="mlh-button is-small is-danger" data-action="discard">${t("discard")}</button>`); }
  if (task.settlement?.phase === "integration_pending" || (task.settlement?.phase === "blocked" && task.settlement?.blocker?.resumePhase === "integration_pending")) actions.push(`<button class="mlh-button is-small is-primary" data-action="integrate">${t("integrate")}</button>`);
  if (task.settlement?.phase === "cleanup_pending" && task.settlement?.unpinReceipt && task.settlement?.archiveReceipt) actions.push(`<button class="mlh-button is-small is-primary" data-action="cleanup">${t("cleanup")}</button>`);
  if (["settling", "needs_attention"].includes(task.status) || ["integration_pending", "discard_pending", "cleanup_pending", "cleanup_blocked", "orphan_recovery_required"].includes(task.settlement?.phase)) actions.push(`<button class="mlh-button is-small is-quiet" data-action="reconcile">${t("reconcile")}</button>`);
  if (!["completed", "failed", "cancelled"].includes(task.status)) actions.push(`<button class="mlh-button is-small is-danger" data-action="cancel">${t("requestCancel")}</button>`);
  return actions.join("");
}

async function action(actionName, input) {
  try {
    const body = await fetch("/api/action", { method: "POST", headers: { "content-type": "application/json", "x-control-plane-token": token }, body: JSON.stringify({ action: actionName, input }) }).then((response) => response.json());
    if (!body.ok) throw new Error(body.error?.message || actionName); showNotice(t("actionCompleted"), "success"); return body.result;
  } catch (error) { showNotice(`${t("actionFailed")}: ${error.message}`, "danger"); return null; }
}

function selectedRun() { return state.runId ? state.ledger?.runs?.[state.runId] || null : null; }
function selectedTask() { return state.taskId ? selectedRun()?.tasks?.[state.taskId] || null : null; }
function activeLanguage() { return state.languagePreference !== "system" ? state.languagePreference : navigator.language.toLowerCase().startsWith("ja") ? "ja" : "en"; }
function applyLanguage() { const language = activeLanguage(); document.documentElement.lang = language; document.querySelectorAll("[data-i18n]").forEach((element) => { const value = translations[language][element.dataset.i18n]; if (value) element.textContent = value; }); }
function applyTheme() { document.documentElement.classList.remove("mlh-theme-light", "mlh-theme-dark"); if (state.themePreference === "light") document.documentElement.classList.add("mlh-theme-light"); if (state.themePreference === "dark") document.documentElement.classList.add("mlh-theme-dark"); }
function t(key) { return translations[activeLanguage()][key] || key; }
function setConnection(connected) { elements.connection.dataset.tone = connected ? "success" : "danger"; const label = elements.connection.querySelector("span:last-child"); label.dataset.i18n = connected ? "connected" : "disconnected"; label.textContent = connected ? t("connected") : t("disconnected"); }
function showNotice(message, tone) { elements.notice.hidden = false; elements.notice.dataset.tone = tone; elements.notice.textContent = message; window.clearTimeout(showNotice.timer); showNotice.timer = window.setTimeout(() => { elements.notice.hidden = true; }, 5000); }
function displayStatus(task) { if (!task) return "unknown"; if (task.settlement?.required && task.status === "completed" && !task.settlement.cleanupReceipt) return "cleanup_pending"; return task.status; }
function statusChip(status) { const tones = { active: "success", running: "success", idle: "success", completed: "success", succeeded: "success", review: "warning", prepared: "warning", pending: "warning", provisioning: "warning", settling: "warning", integration_pending: "warning", discard_pending: "warning", cleanup_pending: "warning", cleanup_blocked: "danger", orphan_recovery_required: "danger", blocked: "warning", needs_attention: "warning", handoff: "warning", failed: "danger", cancelled: "neutral", archived: "neutral" }; return `<span class="mlh-status" data-tone="${tones[status] || "neutral"}">${escapeHtml(status)}</span>`; }
function renderList(values, emptyLabel) { return !Array.isArray(values) || values.length === 0 ? `<p class="mlh-help">${escapeHtml(emptyLabel)}</p>` : `<ul class="evidence-list">${values.map((value) => `<li>${escapeHtml(value)}</li>`).join("")}</ul>`; }
function formatTime(value) { try { return new Intl.DateTimeFormat(activeLanguage(), { dateStyle: "short", timeStyle: "medium" }).format(new Date(value)); } catch { return value; } }
function shortId(value) { if (!value) return "—"; const text = String(value); return text.length > 18 ? `${text.slice(0, 8)}…${text.slice(-6)}` : text; }
function emptyToNull(value) { const text = String(value || "").trim(); return text || null; }
function lines(value) { return String(value || "").split("\n").map((entry) => entry.trim()).filter(Boolean); }
function escapeHtml(value) { return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;"); }
