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
    upperControl: "Upper Control",
    newRun: "New run",
    runs: "Runs",
    connecting: "Connecting",
    connected: "Connected",
    disconnected: "Disconnected",
    controlPlane: "Control plane",
    noRunSelected: "No run selected",
    language: "Language",
    theme: "Theme",
    refresh: "Refresh",
    runStatus: "Run status",
    sessions: "Sessions",
    tasks: "Tasks",
    awaitingReview: "Awaiting review",
    workQueue: "Work queue",
    addTask: "Add task",
    role: "Role",
    task: "Task",
    profile: "Profile",
    status: "Status",
    actions: "Actions",
    noTasks: "No tasks",
    noTasksHelp: "Add a bounded task to begin planning.",
    runtime: "Runtime",
    session: "Session",
    model: "Model",
    noSessions: "No sessions",
    noSessionsHelp: "A session appears after a task is dispatched.",
    inspection: "Inspection",
    resultAndArtifacts: "Result & artifacts",
    selectTask: "Select a task",
    selectTaskHelp: "Choose a task row to inspect its result and evidence.",
    audit: "Audit",
    eventTimeline: "Event timeline",
    newControlRun: "New control run",
    objective: "Objective",
    mode: "Mode",
    maxRounds: "Max round trips",
    controllerThread: "Controller thread ID",
    controllerThreadHelp: "Optional reciprocal address for worker reports.",
    cancel: "Cancel",
    create: "Create",
    addControlledTask: "Add controlled task",
    title: "Title",
    prompt: "Prompt",
    workingDirectory: "Working directory",
    effort: "Effort",
    sandbox: "Sandbox",
    confirmAction: "Confirm action",
    note: "Note",
    confirm: "Confirm",
    preview: "Preview",
    dispatch: "Dispatch",
    poll: "Poll",
    accept: "Accept",
    reject: "Reject",
    stop: "Stop",
    archive: "Archive",
    evidence: "Verification",
    artifacts: "Artifacts",
    result: "Result",
    noEvidence: "No verification evidence",
    noArtifacts: "No artifacts",
    liveWarning: "This creates or changes a real Codex session. Continue?",
    stopWarning: "Interrupt and cancel this controlled task?",
    archiveWarning: "Archive this Codex session?",
    rejectWarning: "Reject this result and return the task for another turn?",
    actionCompleted: "Action completed",
    actionFailed: "Action failed",
    loadFailed: "Could not load control-plane state"
  },
  ja: {
    upperControl: "上位管制",
    newRun: "新規Run",
    runs: "Run一覧",
    connecting: "接続中",
    connected: "接続済み",
    disconnected: "切断",
    controlPlane: "管制面",
    noRunSelected: "Runが選択されていません",
    language: "言語",
    theme: "テーマ",
    refresh: "更新",
    runStatus: "Run状態",
    sessions: "セッション",
    tasks: "タスク",
    awaitingReview: "審査待ち",
    workQueue: "作業キュー",
    addTask: "タスク追加",
    role: "役割",
    task: "タスク",
    profile: "実行プロファイル",
    status: "状態",
    actions: "操作",
    noTasks: "タスクはありません",
    noTasksHelp: "境界を定めたタスクを追加してください。",
    runtime: "実行環境",
    session: "セッション",
    model: "モデル",
    noSessions: "セッションはありません",
    noSessionsHelp: "タスクを配信するとセッションが表示されます。",
    inspection: "検査",
    resultAndArtifacts: "結果と成果物",
    selectTask: "タスクを選択",
    selectTaskHelp: "行を選択すると結果と検証証跡を確認できます。",
    audit: "監査",
    eventTimeline: "イベント履歴",
    newControlRun: "新規管制Run",
    objective: "目的",
    mode: "モード",
    maxRounds: "最大往復数",
    controllerThread: "管制スレッドID",
    controllerThreadHelp: "ワーカーが返信するための相互アドレス。省略可能です。",
    cancel: "キャンセル",
    create: "作成",
    addControlledTask: "管制タスクを追加",
    title: "タイトル",
    prompt: "指示",
    workingDirectory: "作業ディレクトリ",
    effort: "推論深度",
    sandbox: "サンドボックス",
    confirmAction: "操作の確認",
    note: "注記",
    confirm: "実行",
    preview: "確認",
    dispatch: "配信",
    poll: "状態取得",
    accept: "受理",
    reject: "差し戻し",
    stop: "停止",
    archive: "保管",
    evidence: "検証証跡",
    artifacts: "成果物",
    result: "結果",
    noEvidence: "検証証跡なし",
    noArtifacts: "成果物なし",
    liveWarning: "実在するCodexセッションを作成または変更します。続行しますか？",
    stopWarning: "この管制タスクを中断してキャンセルしますか？",
    archiveWarning: "このCodexセッションをアーカイブしますか？",
    rejectWarning: "結果を差し戻し、次のターンへ戻しますか？",
    actionCompleted: "操作が完了しました",
    actionFailed: "操作に失敗しました",
    loadFailed: "管制状態を読み込めませんでした"
  }
};

const elements = {
  runList: document.querySelector("#run-list"),
  runTitle: document.querySelector("#run-title"),
  taskRows: document.querySelector("#task-rows"),
  sessionRows: document.querySelector("#session-rows"),
  taskEmpty: document.querySelector("#task-empty"),
  sessionEmpty: document.querySelector("#session-empty"),
  inspector: document.querySelector("#inspector-content"),
  eventList: document.querySelector("#event-list"),
  notice: document.querySelector("#notice"),
  connection: document.querySelector("#connection-status"),
  newRun: document.querySelector("#new-run-button"),
  addTask: document.querySelector("#add-task-button"),
  refresh: document.querySelector("#refresh-button"),
  language: document.querySelector("#language-select"),
  theme: document.querySelector("#theme-select"),
  runDialog: document.querySelector("#run-dialog"),
  runForm: document.querySelector("#run-form"),
  taskDialog: document.querySelector("#task-dialog"),
  taskForm: document.querySelector("#task-form"),
  confirmDialog: document.querySelector("#confirm-dialog"),
  confirmForm: document.querySelector("#confirm-form"),
  confirmMessage: document.querySelector("#confirm-message"),
  confirmNote: document.querySelector("#confirm-note"),
  confirmNoteField: document.querySelector("#confirm-note-field"),
  metrics: {
    status: document.querySelector("#metric-run-status"),
    sessions: document.querySelector("#metric-sessions"),
    tasks: document.querySelector("#metric-tasks"),
    review: document.querySelector("#metric-review")
  }
};

elements.language.value = state.languagePreference;
elements.theme.value = state.themePreference;
applyLanguage();
applyTheme();

elements.language.addEventListener("change", () => {
  state.languagePreference = elements.language.value;
  localStorage.setItem("control-plane-language", state.languagePreference);
  applyLanguage();
  render();
});
elements.theme.addEventListener("change", () => {
  state.themePreference = elements.theme.value;
  localStorage.setItem("control-plane-theme", state.themePreference);
  applyTheme();
});
elements.refresh.addEventListener("click", refresh);
elements.newRun.addEventListener("click", () => elements.runDialog.showModal());
elements.addTask.addEventListener("click", () => {
  if (!state.runId) return;
  elements.taskForm.elements.cwd.value = selectedRun()?.tasks
    ? Object.values(selectedRun().tasks)[0]?.cwd || ""
    : "";
  elements.taskDialog.showModal();
});

elements.runForm.addEventListener("submit", async (event) => {
  if (event.submitter?.value !== "create") return;
  event.preventDefault();
  const form = new FormData(elements.runForm);
  const result = await action("createRun", {
    objective: form.get("objective"),
    executionMode: form.get("executionMode"),
    maxRoundTrips: Number(form.get("maxRoundTrips")),
    controllerThreadId: emptyToNull(form.get("controllerThreadId"))
  });
  if (!result) return;
  state.runId = result.id;
  state.taskId = null;
  elements.runForm.reset();
  elements.runDialog.close();
  await refresh();
});

elements.taskForm.addEventListener("submit", async (event) => {
  if (event.submitter?.value !== "create") return;
  event.preventDefault();
  const form = new FormData(elements.taskForm);
  const result = await action("addTask", {
    runId: state.runId,
    title: form.get("title"),
    role: form.get("role"),
    prompt: form.get("prompt"),
    cwd: form.get("cwd"),
    model: form.get("model"),
    effort: form.get("effort"),
    sandbox: form.get("sandbox")
  });
  if (!result) return;
  state.taskId = result.id;
  elements.taskForm.reset();
  elements.taskDialog.close();
  await refresh();
});

elements.taskRows.addEventListener("click", handleTaskClick);
elements.sessionRows.addEventListener("click", handleSessionClick);

await refresh();
state.timer = window.setInterval(refresh, 5000);

async function refresh() {
  try {
    const response = await fetch("/api/snapshot", { cache: "no-store" });
    const body = await response.json();
    if (!body.ok) throw new Error(body.error?.message || "Snapshot failed");
    state.ledger = body.snapshot;
    const runs = Object.values(state.ledger.runs || {});
    if (!state.runId || !state.ledger.runs[state.runId]) {
      state.runId = runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]?.id || null;
      state.taskId = null;
    }
    setConnection(true);
    render();
  } catch (error) {
    setConnection(false);
    showNotice(`${t("loadFailed")}: ${error.message}`, "danger");
  }
}

function render() {
  renderRuns();
  renderSummary();
  renderTasks();
  renderSessions();
  renderInspector();
  renderEvents();
  applyLanguage();
}

function renderRuns() {
  const runs = Object.values(state.ledger?.runs || {}).sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt)
  );
  elements.runList.replaceChildren(
    ...runs.map((run) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "run-button";
      button.setAttribute("aria-current", String(run.id === state.runId));
      button.innerHTML = `<strong>${escapeHtml(run.objective)}</strong><small>${escapeHtml(run.status)} · ${escapeHtml(run.executionMode)}</small>`;
      button.addEventListener("click", () => {
        state.runId = run.id;
        state.taskId = null;
        render();
      });
      return button;
    })
  );
}

function renderSummary() {
  const run = selectedRun();
  elements.addTask.disabled = !run || !["draft", "active"].includes(run.status);
  if (!run) {
    elements.runTitle.dataset.i18n = "noRunSelected";
    elements.metrics.status.textContent = "—";
    elements.metrics.sessions.textContent = "0";
    elements.metrics.tasks.textContent = "0";
    elements.metrics.review.textContent = "0";
    return;
  }
  delete elements.runTitle.dataset.i18n;
  elements.runTitle.textContent = run.objective;
  const tasks = Object.values(run.tasks || {});
  elements.metrics.status.textContent = run.status;
  elements.metrics.sessions.textContent = String(Object.keys(run.sessions || {}).length);
  elements.metrics.tasks.textContent = String(tasks.length);
  elements.metrics.review.textContent = String(tasks.filter((task) => task.status === "review").length);
}

function renderTasks() {
  const run = selectedRun();
  const tasks = Object.values(run?.tasks || {});
  elements.taskEmpty.hidden = tasks.length > 0;
  elements.taskRows.replaceChildren(
    ...tasks.map((task) => {
      const row = document.createElement("tr");
      row.dataset.taskId = task.id;
      row.classList.toggle("is-selected", task.id === state.taskId);
      row.innerHTML = `
        <td>${escapeHtml(task.role)}</td>
        <td><strong>${escapeHtml(task.title)}</strong><br><code>${shortId(task.id)}</code></td>
        <td><span class="profile-stack"><code>${escapeHtml(task.profile.model)}</code><small>${escapeHtml(task.profile.effort)} · ${escapeHtml(task.profile.sandbox)}</small></span></td>
        <td>${statusChip(task.status)}</td>
        <td><div class="table-actions">${taskActions(task, run)}</div></td>
      `;
      return row;
    })
  );
}

function renderSessions() {
  const run = selectedRun();
  const sessions = Object.values(run?.sessions || {});
  elements.sessionEmpty.hidden = sessions.length > 0;
  elements.sessionRows.replaceChildren(
    ...sessions.map((session) => {
      const row = document.createElement("tr");
      row.dataset.sessionId = session.id;
      row.innerHTML = `
        <td><code title="${escapeHtml(session.id)}">${shortId(session.id)}</code></td>
        <td>${escapeHtml(session.role)}</td>
        <td><span class="profile-stack"><code>${escapeHtml(session.profile.model)}</code><small>${escapeHtml(session.profile.effort)}</small></span></td>
        <td>${statusChip(session.status)}</td>
        <td><div class="table-actions"><button class="mlh-button is-small is-quiet" data-session-action="archive">${t("archive")}</button></div></td>
      `;
      return row;
    })
  );
}

function renderInspector() {
  const task = selectedTask();
  if (!task) {
    elements.inspector.innerHTML = `<div class="mlh-empty"><strong>${t("selectTask")}</strong><span>${t("selectTaskHelp")}</span></div>`;
    return;
  }
  elements.inspector.innerHTML = `
    <section class="inspection-block">
      <h3>${t("result")}</h3>
      <pre>${escapeHtml(JSON.stringify(task.result, null, 2) || "—")}</pre>
    </section>
    <section class="inspection-block">
      <h3>${t("artifacts")}</h3>
      ${renderList(task.artifacts, t("noArtifacts"))}
    </section>
    <section class="inspection-block">
      <h3>${t("evidence")}</h3>
      ${renderList(task.verification, t("noEvidence"))}
    </section>
  `;
}

function renderEvents() {
  const events = [...(selectedRun()?.events || [])].reverse().slice(0, 80);
  elements.eventList.replaceChildren(
    ...events.map((entry) => {
      const item = document.createElement("li");
      item.className = "event-item";
      item.innerHTML = `
        <span class="event-dot" aria-hidden="true"></span>
        <span class="event-copy"><strong>${escapeHtml(entry.message)}</strong><time datetime="${escapeHtml(entry.at)}">${formatTime(entry.at)}</time></span>
      `;
      return item;
    })
  );
}

async function handleTaskClick(event) {
  const row = event.target.closest("tr[data-task-id]");
  if (!row) return;
  state.taskId = row.dataset.taskId;
  const actionName = event.target.closest("button[data-task-action]")?.dataset.taskAction;
  render();
  if (!actionName) return;
  const run = selectedRun();
  const task = selectedTask();
  if (actionName === "preview") {
    const result = await action("previewDispatch", { runId: run.id, taskId: task.id });
    if (result) {
      task.result = result;
      renderInspector();
    }
    return;
  }
  if (actionName === "poll") {
    await action("poll", { runId: run.id, taskId: task.id });
    await refresh();
    return;
  }
  if (actionName === "accept") {
    await action("decide", { runId: run.id, taskId: task.id, decision: "accept" });
    await refresh();
    return;
  }
  if (actionName === "dispatch") {
    const confirmed = await confirmAction(t("liveWarning"), false);
    if (!confirmed.ok) return;
    await action("dispatch", {
      runId: run.id,
      taskId: task.id,
      confirmLiveDispatch: true
    });
    await refresh();
    return;
  }
  if (actionName === "reject") {
    const confirmed = await confirmAction(t("rejectWarning"), true);
    if (!confirmed.ok) return;
    await action("decide", {
      runId: run.id,
      taskId: task.id,
      decision: "reject",
      note: confirmed.note
    });
    await refresh();
    return;
  }
  if (actionName === "stop") {
    const confirmed = await confirmAction(t("stopWarning"), false);
    if (!confirmed.ok) return;
    await action("stop", {
      runId: run.id,
      taskId: task.id,
      confirmLiveDispatch: run.executionMode === "live"
    });
    await refresh();
  }
}

async function handleSessionClick(event) {
  const row = event.target.closest("tr[data-session-id]");
  const actionName = event.target.closest("button[data-session-action]")?.dataset.sessionAction;
  if (!row || actionName !== "archive") return;
  const run = selectedRun();
  const confirmed = await confirmAction(t("archiveWarning"), false);
  if (!confirmed.ok) return;
  await action("archive", {
    runId: run.id,
    threadId: row.dataset.sessionId,
    confirmLiveDispatch: run.executionMode === "live"
  });
  await refresh();
}

async function action(actionName, input) {
  try {
    const response = await fetch("/api/action", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-control-plane-token": token
      },
      body: JSON.stringify({ action: actionName, input })
    });
    const body = await response.json();
    if (!body.ok) throw new Error(body.error?.message || t("actionFailed"));
    showNotice(t("actionCompleted"), "success");
    return body.result;
  } catch (error) {
    showNotice(`${t("actionFailed")}: ${error.message}`, "danger");
    return null;
  }
}

function confirmAction(message, showNote) {
  elements.confirmMessage.textContent = message;
  elements.confirmNote.value = "";
  elements.confirmNoteField.hidden = !showNote;
  elements.confirmDialog.showModal();
  return new Promise((resolve) => {
    const onClose = () => {
      elements.confirmDialog.removeEventListener("close", onClose);
      resolve({
        ok: elements.confirmDialog.returnValue === "confirm",
        note: elements.confirmNote.value.trim()
      });
    };
    elements.confirmDialog.addEventListener("close", onClose);
  });
}

function taskActions(task, run) {
  const actions = [`<button class="mlh-button is-small is-quiet" data-task-action="preview">${t("preview")}</button>`];
  if (task.status === "created" && run.executionMode === "live") {
    actions.push(`<button class="mlh-button is-small is-primary" data-task-action="dispatch">${t("dispatch")}</button>`);
  }
  if (task.status === "running") {
    actions.push(`<button class="mlh-button is-small is-quiet" data-task-action="poll">${t("poll")}</button>`);
    actions.push(`<button class="mlh-button is-small is-danger" data-task-action="stop">${t("stop")}</button>`);
  }
  if (task.status === "review") {
    actions.push(`<button class="mlh-button is-small is-primary" data-task-action="accept">${t("accept")}</button>`);
    actions.push(`<button class="mlh-button is-small is-quiet" data-task-action="reject">${t("reject")}</button>`);
  }
  return actions.join("");
}

function selectedRun() {
  return state.runId ? state.ledger?.runs?.[state.runId] || null : null;
}

function selectedTask() {
  return state.taskId ? selectedRun()?.tasks?.[state.taskId] || null : null;
}

function activeLanguage() {
  if (state.languagePreference !== "system") return state.languagePreference;
  return navigator.language.toLowerCase().startsWith("ja") ? "ja" : "en";
}

function applyLanguage() {
  const language = activeLanguage();
  document.documentElement.lang = language;
  document.querySelectorAll("[data-i18n]").forEach((element) => {
    const key = element.dataset.i18n;
    if (translations[language][key]) element.textContent = translations[language][key];
  });
}

function applyTheme() {
  document.documentElement.classList.remove("mlh-theme-light", "mlh-theme-dark");
  if (state.themePreference === "light") document.documentElement.classList.add("mlh-theme-light");
  if (state.themePreference === "dark") document.documentElement.classList.add("mlh-theme-dark");
}

function t(key) {
  return translations[activeLanguage()][key] || key;
}

function setConnection(connected) {
  elements.connection.dataset.tone = connected ? "success" : "danger";
  const label = elements.connection.querySelector("span:last-child");
  label.dataset.i18n = connected ? "connected" : "disconnected";
  label.textContent = connected ? t("connected") : t("disconnected");
}

function showNotice(message, tone) {
  elements.notice.hidden = false;
  elements.notice.dataset.tone = tone;
  elements.notice.textContent = message;
  window.clearTimeout(showNotice.timer);
  showNotice.timer = window.setTimeout(() => {
    elements.notice.hidden = true;
  }, 5000);
}

function statusChip(status) {
  const tones = {
    active: "success",
    running: "success",
    completed: "success",
    review: "warning",
    blocked: "warning",
    failed: "danger",
    cancelled: "neutral",
    archived: "neutral"
  };
  return `<span class="mlh-status" data-tone="${tones[status] || "neutral"}">${escapeHtml(status)}</span>`;
}

function renderList(values, emptyLabel) {
  if (!Array.isArray(values) || values.length === 0) {
    return `<p class="mlh-help">${escapeHtml(emptyLabel)}</p>`;
  }
  return `<ul class="evidence-list">${values.map((value) => `<li>${escapeHtml(value)}</li>`).join("")}</ul>`;
}

function formatTime(value) {
  try {
    return new Intl.DateTimeFormat(activeLanguage(), {
      dateStyle: "short",
      timeStyle: "medium"
    }).format(new Date(value));
  } catch {
    return value;
  }
}

function shortId(value) {
  if (!value) return "—";
  return value.length > 18 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
}

function emptyToNull(value) {
  const text = String(value || "").trim();
  return text || null;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
