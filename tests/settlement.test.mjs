import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ControlPlane } from "../scripts/lib/control-plane.mjs";
import { Ledger } from "../scripts/lib/ledger.mjs";
import { inspectRepository } from "../scripts/lib/git-settlement.mjs";

test("managed worktree adoption remains nonterminal until exact cleanup receipt", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "task-control-settlement-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  git(root, ["init", "-b", "main"]);
  await fs.writeFile(path.join(root, "README.md"), "base\n");
  git(root, ["add", "README.md"]); git(root, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "base"]);
  const worktree = path.join(root, ".codex-worktrees", "candidate");
  git(root, ["worktree", "add", "-b", "candidate", worktree]);
  await fs.writeFile(path.join(worktree, "accepted.txt"), "accepted\n");
  const plane = new ControlPlane({ ledger: new Ledger(path.join(root, "ledger.json")) });
  const run = await plane.createRun({ objective: "settlement", executionMode: "dry-run" });
  const task = await plane.addTask({
    runId: run.id, title: "candidate", prompt: "produce candidate", role: "worker", cwd: root,
    environment: "worktree", accessMode: "write", worktreePurpose: "explicit_user_isolation",
    worktreeLifecycleAuthority: "user_request:settlement test", integrationTargetBranch: "main"
  });
  const inspected = await inspectRepository(root);
  await plane.ledger.update((draft) => {
    const item = draft.runs[run.id].tasks[task.id];
    item.git.commonDirectory = inspected.commonDirectory;
    item.git.primaryCheckout = root;
    item.git.targetBranch = "main";
    item.worktree.runtimeCwd = worktree;
    item.worktree.branchAtReview = "candidate";
    item.worktree.headAtReview = inspected.worktrees.find((entry) => entry.path === worktree)?.head;
    item.status = "review";
    return null;
  });
  const reviewed = await plane.snapshot({ runId: run.id });
  assert.equal(reviewed.tasks[task.id].status, "review");
  await plane.decideTask({ runId: run.id, taskId: task.id, decision: "discard" });
  assert.equal((await plane.snapshot({ runId: run.id })).tasks[task.id].status, "settling");
  const adoption = await plane.recordSettlement({ runId: run.id, taskId: task.id, phase: "discard_pending" });
  assert.equal(adoption.status, "settling");
  const cleaned = await plane.cleanupSettlement({ runId: run.id, taskId: task.id, force: true });
  assert.equal(cleaned.status, "failed");
  assert.equal(cleaned.settlement.phase, "cleanup_verified");
  assert.equal(cleaned.settlement.cleanupReceipt.pathAbsent, true);
  assert.equal((await plane.snapshot({ runId: run.id })).status, "failed");
});

test("reconciliation reopens a terminal task that still owns a worktree", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "task-control-reconcile-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  git(root, ["init", "-b", "main"]);
  await fs.writeFile(path.join(root, "README.md"), "base\n");
  git(root, ["add", "README.md"]); git(root, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "base"]);
  const worktree = path.join(root, "candidate"); git(root, ["worktree", "add", "-b", "candidate", worktree]);
  const plane = new ControlPlane({ ledger: new Ledger(path.join(root, "ledger.json")) });
  const run = await plane.createRun({ objective: "reconcile", executionMode: "dry-run" });
  const task = await plane.addTask({ runId: run.id, title: "candidate", prompt: "candidate", role: "worker", cwd: root, environment: "worktree", worktreePurpose: "explicit_user_isolation", worktreeLifecycleAuthority: "user_request:reconcile test", integrationTargetBranch: "main" });
  const inspected = await inspectRepository(root);
  await plane.ledger.update((draft) => { const item = draft.runs[run.id].tasks[task.id]; item.status = "completed"; item.git.commonDirectory = inspected.commonDirectory; item.git.primaryCheckout = root; item.worktree.runtimeCwd = worktree; return null; });
  const report = await plane.reconcile({ runId: run.id });
  assert.equal(report.records[0].classification, "orphan_recovery_required");
  assert.equal(report.records[0].registered, true);
});

function git(cwd, args) { execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" }); }
