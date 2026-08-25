import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";

export const LEDGER_SCHEMA_VERSION = "codex-task-control-plane-ledger/v3";
export const PREVIOUS_LEDGER_SCHEMA_VERSION = "codex-thread-orchestration-ledger/v2";

export function defaultLedgerPath() {
  const root = process.env.CODEX_TASK_CONTROL_PLANE_HOME || path.join(os.homedir(), ".codex", "task-control-plane");
  return path.join(root, "ledger.json");
}
export function legacyLedgerPath() { return path.join(os.homedir(), ".codex", "session-control-plane", "ledger.json"); }

export function emptyLedger() { return { schemaVersion: LEDGER_SCHEMA_VERSION, revision: 0, updatedAt: null, runs: {} }; }

export function migrateLedger(value, { pathExists = defaultPathExists } = {}) {
  if (!isRecord(value) || value.schemaVersion !== PREVIOUS_LEDGER_SCHEMA_VERSION || !isRecord(value.runs)) {
    const error = new Error("Only a valid codex-thread-orchestration-ledger/v2 can be migrated"); error.code = "INVALID_LEDGER_MIGRATION_INPUT"; throw error;
  }
  const migrated = structuredClone(value); migrated.schemaVersion = LEDGER_SCHEMA_VERSION;
  for (const run of Object.values(migrated.runs)) {
    if (!isRecord(run)) throw migrationError("run must be an object");
    for (const task of Object.values(run.tasks || {})) migrateTask(task, pathExists);
  }
  return migrated;
}

function migrateTask(task, pathExists) {
  if (!isRecord(task)) throw migrationError("task must be an object");
  const target = isRecord(task.target) ? task.target : {};
  const environment = target.environment || task.project?.environment || "local";
  const accessMode = target.accessMode || "write";
  task.target = { ...target, environment, accessMode, integrationTargetBranch: target.integrationTargetBranch ?? null, worktreePurpose: target.worktreePurpose ?? null, worktreeLifecycleAuthority: target.worktreeLifecycleAuthority ?? null };
  const managed = environment === "worktree";
  const runtimeCwd = task.thread?.runtimeCwd || task.runtimeCwd || null;
  const existing = managed && typeof runtimeCwd === "string" && pathExists(runtimeCwd);
  const terminal = ["completed", "failed", "cancelled"].includes(task.status);
  const prior = isRecord(task.settlement) ? task.settlement : {};
  task.git = { commonDirectory: null, primaryCheckout: task.cwd || null, targetBranch: task.target.integrationTargetBranch || null, targetHeadAtDispatch: null, accessMode, ...(isRecord(task.git) ? task.git : {}) };
  task.worktree = { managed, purpose: task.target.worktreePurpose, authority: task.target.worktreeLifecycleAuthority, runtimeCwd, threadId: task.threadId || null, clientThreadId: task.clientThreadId || null, pinned: false, identityCaptured: false, headAtBinding: null, branchAtBinding: null, detachedAtBinding: false, headAtReview: null, branchAtReview: null, candidateFingerprint: null, candidateCapture: null, ...(isRecord(task.worktree) ? task.worktree : {}) };
  task.settlement = managed ? { required: true, decision: prior.decision || null, phase: terminal ? (existing ? "orphan_recovery_required" : "cleanup_pending") : "awaiting_decision", terminalStatus: terminal ? task.status : null, operationIds: Array.isArray(prior.operationIds) ? prior.operationIds : [], adoptionReceipt: prior.adoptionReceipt || null, unpinReceipt: prior.unpinReceipt || null, archiveReceipt: prior.archiveReceipt || null, cleanupReceipt: prior.cleanupReceipt || null, blocker: prior.blocker || null } : { required: false, decision: null, phase: "not_required", terminalStatus: null, operationIds: [], adoptionReceipt: null, unpinReceipt: null, archiveReceipt: null, cleanupReceipt: null, blocker: null };
  if (managed && terminal && existing) task.status = "needs_attention";
}

function defaultPathExists(candidate) { try { return fsSync.lstatSync(candidate).isDirectory(); } catch { return false; } }
function migrationError(message) { const error = new Error(`Malformed v2 ledger: ${message}`); error.code = "MALFORMED_LEDGER"; return error; }

export class Ledger {
  #queue = Promise.resolve();
  constructor(filePath = null) { this.filePath = path.resolve(filePath || defaultLedgerPath()); this.legacyPath = path.resolve(legacyLedgerPath()); this.allowLegacyFallback = filePath == null; }
  async read() {
    try {
      let bytes;
      try { bytes = await fs.readFile(this.filePath, "utf8"); }
      catch (error) { if (error.code !== "ENOENT" || !this.allowLegacyFallback || this.filePath === this.legacyPath) throw error; bytes = await fs.readFile(this.legacyPath, "utf8"); }
      const parsed = JSON.parse(bytes);
      if (parsed.schemaVersion === PREVIOUS_LEDGER_SCHEMA_VERSION) return migrateLedger(parsed);
      if (parsed.schemaVersion !== LEDGER_SCHEMA_VERSION || !isRecord(parsed.runs)) { const error = new Error(`Unsupported ledger schema at ${this.filePath}`); error.code = "UNSUPPORTED_LEDGER_SCHEMA"; throw error; }
      return parsed;
    } catch (error) { if (error?.code === "ENOENT") return emptyLedger(); throw error; }
  }
  async migrate() {
    const parsed = JSON.parse(await fs.readFile(this.filePath, "utf8"));
    if (parsed.schemaVersion !== PREVIOUS_LEDGER_SCHEMA_VERSION) return this.read();
    const migrated = migrateLedger(parsed); await this.#writeAtomic(migrated); return structuredClone(migrated);
  }
  async update(mutator) {
    const operation = this.#queue.then(async () => { const current = await this.read(); const draft = structuredClone(current); const result = await mutator(draft); draft.revision = (current.revision || 0) + 1; draft.updatedAt = new Date().toISOString(); await this.#writeAtomic(draft); return { ledger: structuredClone(draft), result: result === undefined ? null : structuredClone(result) }; });
    this.#queue = operation.catch(() => {}); return operation;
  }
  async replace(next) { return this.update((draft) => { draft.runs = structuredClone(next.runs || {}); return { replaced: true }; }); }
  async #writeAtomic(value) {
    const directory = path.dirname(this.filePath); await fs.mkdir(directory, { recursive: true, mode: 0o700 }); const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`; const handle = await fs.open(tempPath, "wx", 0o600);
    try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8"); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(tempPath, this.filePath); const directoryHandle = await fs.open(directory, "r"); try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
  }
}
function isRecord(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
