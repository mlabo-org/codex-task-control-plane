import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export async function git(cwd, args, { timeout = 10_000 } = {}) {
  if (!path.isAbsolute(cwd) || !Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
    throw new TypeError("git requires an absolute cwd and an argument vector");
  }
  const result = await exec("git", ["-C", cwd, ...args], { encoding: "utf8", timeout, maxBuffer: 4 * 1024 * 1024 });
  return { stdout: result.stdout, stderr: result.stderr, code: 0 };
}

export async function inspectRepository(primaryCheckout) {
  const common = (await git(primaryCheckout, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).stdout.trim();
  const branch = (await git(primaryCheckout, ["symbolic-ref", "--quiet", "--short", "HEAD"])).stdout.trim() || null;
  const head = (await git(primaryCheckout, ["rev-parse", "HEAD"])).stdout.trim();
  const status = (await git(primaryCheckout, ["status", "--porcelain=v1", "--untracked-files=all"])).stdout;
  const worktrees = parseWorktrees((await git(primaryCheckout, ["worktree", "list", "--porcelain"])).stdout);
  return { commonDirectory: path.resolve(common), primaryCheckout: path.resolve(primaryCheckout), branch, head, status, dirty: status.length > 0, worktrees, candidateFingerprint: fingerprint({ head, branch, status }) };
}

export function parseWorktrees(text) {
  const records = [];
  let current = null;
  for (const line of String(text).split(/\r?\n/)) {
    if (line.startsWith("worktree ")) { if (current) records.push(current); current = { path: line.slice(9), head: null, branch: null, bare: false, locked: false }; }
    else if (!current) continue;
    else if (line.startsWith("HEAD ")) current.head = line.slice(5);
    else if (line.startsWith("branch ")) current.branch = line.slice(7);
    else if (line === "bare") current.bare = true;
    else if (line === "locked") current.locked = true;
  }
  if (current) records.push(current);
  return records;
}

export function fingerprint(value) { return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex"); }

export async function acquireSettlementLock(commonDirectory, owner) {
  if (!path.isAbsolute(commonDirectory) || !owner?.runId || !owner?.taskId) throw new TypeError("exact repository and run/task owner required");
  const lockPath = path.join(commonDirectory, "codex-task-control-plane.settlement.lock");
  let handle;
  try { handle = await fs.open(lockPath, "wx", 0o600); }
  catch (error) {
    if (error.code === "EEXIST") { const busy = new Error(`Settlement lock is held: ${lockPath}`); busy.code = "SETTLEMENT_LOCK_HELD"; throw busy; }
    throw error;
  }
  const record = { ...owner, commonDirectory: path.resolve(commonDirectory), pid: process.pid, acquiredAt: new Date().toISOString() };
  await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8"); await handle.sync(); await handle.close();
  return { lockPath, owner: record };
}

export async function releaseSettlementLock(lock) {
  if (!lock?.lockPath || !lock.owner?.runId || !lock.owner?.taskId) throw new TypeError("lock receipt required");
  const current = JSON.parse(await fs.readFile(lock.lockPath, "utf8"));
  if (current.runId !== lock.owner.runId || current.taskId !== lock.owner.taskId || current.commonDirectory !== lock.owner.commonDirectory) {
    const error = new Error("Settlement lock ownership changed"); error.code = "SETTLEMENT_LOCK_OWNERSHIP_MISMATCH"; throw error;
  }
  await fs.unlink(lock.lockPath);
  return { lockPath: lock.lockPath, releasedAt: new Date().toISOString() };
}

export async function removeExactWorktree({ primaryCheckout, runtimePath, force = false, ownerPath }) {
  if (!path.isAbsolute(primaryCheckout) || !path.isAbsolute(runtimePath) || !path.isAbsolute(ownerPath || runtimePath)) throw new TypeError("absolute exact paths required");
  if (path.resolve(runtimePath) !== path.resolve(ownerPath || runtimePath)) throw new Error("runtime path does not match recorded owner path");
  const before = await inspectRepository(primaryCheckout);
  const registration = before.worktrees.find((entry) => sameFilesystemPath(entry.path, runtimePath));
  const exists = fsSync.existsSync(runtimePath);
  if (!registration && !exists) return { mode: "already_absent", forceUsed: false, before, after: before, pathAbsent: true, registrationAbsent: true };
  if (!registration && exists) {
    const entries = await fs.readdir(runtimePath); if (entries.length) { const error = new Error("Unregistered residual worktree is non-empty"); error.code = "CLEANUP_BLOCKED"; throw error; }
    await fs.rmdir(runtimePath);
  } else {
    const args = ["worktree", "remove"]; if (force) args.push("--force"); args.push(runtimePath); await git(primaryCheckout, args);
  }
  const after = await inspectRepository(primaryCheckout);
  return { mode: registration ? "git_worktree_remove" : "empty_rmdir", forceUsed: force, before, after, pathAbsent: !fsSync.existsSync(runtimePath), registrationAbsent: !after.worktrees.some((entry) => sameFilesystemPath(entry.path, runtimePath)), verificationTimestamp: new Date().toISOString() };
}

export async function removeExactBranch({ primaryCheckout, branch, force = false }) {
  if (!path.isAbsolute(primaryCheckout) || typeof branch !== "string" || !branch.trim()) throw new TypeError("exact checkout and branch required");
  const ref = branch.startsWith("refs/heads/") ? branch : `refs/heads/${branch}`;
  const before = (await git(primaryCheckout, ["show-ref", "--verify", "--quiet", ref]).catch(() => null)) !== null;
  if (!before) return { branch: ref, mode: "already_absent", forceUsed: false, branchAbsent: true, verificationTimestamp: new Date().toISOString() };
  await git(primaryCheckout, ["branch", force ? "-D" : "-d", ref.slice("refs/heads/".length)]);
  const after = (await git(primaryCheckout, ["show-ref", "--verify", "--quiet", ref]).catch(() => null)) !== null;
  return { branch: ref, mode: "branch_delete", forceUsed: force, branchAbsent: !after, verificationTimestamp: new Date().toISOString() };
}

function sameFilesystemPath(left, right) {
  const normalize = (candidate) => {
    try { return fsSync.realpathSync(candidate); } catch { return path.resolve(candidate); }
  };
  return normalize(left) === normalize(right);
}
