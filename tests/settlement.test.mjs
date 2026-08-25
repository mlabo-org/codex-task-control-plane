import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ControlPlane } from "../scripts/lib/control-plane.mjs";
import { Ledger } from "../scripts/lib/ledger.mjs";
import { inspectRepository } from "../scripts/lib/git-settlement.mjs";

test("adopt captures, hands off, commits to the exact target, archives, and removes all task Git state", async (context) => {
  const fixture = await settlementFixture(context, "adopt");
  await fs.writeFile(path.join(fixture.worktree, "accepted.txt"), "accepted\n");

  const adopted = await fixture.plane.decideTask({
    runId: fixture.run.id,
    taskId: fixture.task.id,
    decision: "adopt"
  });
  assert.equal(adopted.status, "settling");
  assert.equal(adopted.settlement.phase, "handoff_preflight");
  assert.deepEqual(adopted.worktree.candidateCapture.changedPaths, ["accepted.txt"]);

  await recordThreadLocation(fixture, fixture.worktree);
  const handoff = await fixture.plane.prepareOperation({
    runId: fixture.run.id,
    tool: "codex_app__handoff_thread",
    input: { taskId: fixture.task.id },
    confirmLiveAction: true
  });
  await fixture.plane.completeOperation({
    runId: fixture.run.id,
    operationId: handoff.operation.id,
    result: {
      runtimeOperationId: "handoff-1",
      runtimeRevision: 1,
      handoffState: "completed",
      taskStatus: "idle"
    }
  });

  await fs.copyFile(
    path.join(fixture.worktree, "accepted.txt"),
    path.join(fixture.root, "accepted.txt")
  );
  await fs.unlink(path.join(fixture.worktree, "accepted.txt"));
  await recordThreadLocation(fixture, fixture.root);

  const integrated = await fixture.plane.integrateSettlement({
    runId: fixture.run.id,
    taskId: fixture.task.id,
    commitMessage: "Integrate accepted fixture"
  });
  assert.equal(integrated.status, "settling");
  assert.equal(integrated.settlement.phase, "integration_verified");
  assert.equal(integrated.settlement.adoptionReceipt.integrationStrategy, "already_contained");
  assert.equal(integrated.settlement.adoptionReceipt.stashReceipt.candidate.dropped, true);
  assert.match(integrated.settlement.adoptionReceipt.targetCommit, /^[0-9a-f]{40}$/);
  assert.equal(git(fixture.root, ["show", "main:accepted.txt"]), "accepted");

  await unpinAndArchive(fixture);
  const cleaned = await fixture.plane.cleanupSettlement({
    runId: fixture.run.id,
    taskId: fixture.task.id
  });
  assert.equal(cleaned.status, "completed");
  assert.equal(cleaned.settlement.phase, "cleanup_verified");
  assert.equal(cleaned.settlement.cleanupReceipt.forceUsed, false);
  assert.equal(cleaned.settlement.cleanupReceipt.pathAbsent, true);
  assert.equal(cleaned.settlement.cleanupReceipt.registrationAbsent, true);
  assert.equal(cleaned.settlement.cleanupReceipt.branchReceipt.branchAbsent, true);
  assert.equal(fsSync.existsSync(fixture.worktree), false);
  assert.equal(hasRef(fixture.root, "refs/heads/candidate-adopt"), false);
  assert.equal((await fixture.plane.snapshot({ runId: fixture.run.id })).status, "completed");
});

test("adoption fast-forwards the exact target when candidate history is a strict descendant", async (context) => {
  const fixture = await settlementFixture(context, "ff");
  await fs.writeFile(path.join(fixture.worktree, "fast-forward.txt"), "candidate commit\n");
  git(fixture.worktree, ["add", "fast-forward.txt"]);
  git(fixture.worktree, ["commit", "-m", "candidate fast-forward"]);
  const candidateHead = git(fixture.worktree, ["rev-parse", "HEAD"]);

  await fixture.plane.decideTask({ runId: fixture.run.id, taskId: fixture.task.id, decision: "adopt" });
  await handoffToLocal(fixture, "handoff-ff");
  const integrated = await fixture.plane.integrateSettlement({
    runId: fixture.run.id,
    taskId: fixture.task.id,
    commitMessage: "Integrate fast-forward fixture"
  });

  assert.equal(integrated.settlement.adoptionReceipt.integrationStrategy, "fast_forward");
  assert.equal(integrated.settlement.adoptionReceipt.targetCommit, candidateHead);
  assert.equal(git(fixture.root, ["show", "main:fast-forward.txt"]), "candidate commit");
});

test("diverged linear task history rebases then fast-forwards while restoring unrelated Local state", async (context) => {
  const fixture = await settlementFixture(context, "rebase");
  await fs.writeFile(path.join(fixture.worktree, "candidate.txt"), "rebased candidate\n");
  git(fixture.worktree, ["add", "candidate.txt"]);
  git(fixture.worktree, ["commit", "-m", "candidate change"]);
  await fs.writeFile(path.join(fixture.root, "target.txt"), "target advance\n");
  git(fixture.root, ["add", "target.txt"]);
  git(fixture.root, ["commit", "-m", "advance target"]);
  await fs.writeFile(path.join(fixture.root, "user-local.txt"), "preserve me\n");

  await fixture.plane.decideTask({ runId: fixture.run.id, taskId: fixture.task.id, decision: "adopt" });
  await handoffToLocal(fixture, "handoff-rebase");
  const integrated = await fixture.plane.integrateSettlement({
    runId: fixture.run.id,
    taskId: fixture.task.id,
    commitMessage: "Integrate rebased fixture"
  });

  const receipt = integrated.settlement.adoptionReceipt;
  assert.equal(receipt.integrationStrategy, "rebase_fast_forward");
  assert.equal(receipt.stashReceipt.user.dropped, true);
  assert.equal(await fs.readFile(path.join(fixture.root, "user-local.txt"), "utf8"), "preserve me\n");
  assert.match(git(fixture.root, ["status", "--porcelain=v1", "--", "user-local.txt"]), /^\?\? user-local\.txt$/);
  assert.equal(git(fixture.root, ["show", "main:candidate.txt"]), "rebased candidate");
  assert.equal(git(fixture.root, ["show", "main:target.txt"]), "target advance");
  assert.equal(git(fixture.root, ["merge-base", "--is-ancestor", receipt.integratedCandidateHead, "main"]), "");
});

test("diverged task-owned merge topology is preserved with a merge commit", async (context) => {
  const fixture = await settlementFixture(context, "merge");
  git(fixture.worktree, ["branch", "fixture-side"]);
  await fs.writeFile(path.join(fixture.worktree, "candidate-main.txt"), "candidate main\n");
  git(fixture.worktree, ["add", "candidate-main.txt"]);
  git(fixture.worktree, ["commit", "-m", "candidate main"]);
  git(fixture.worktree, ["switch", "fixture-side"]);
  await fs.writeFile(path.join(fixture.worktree, "candidate-side.txt"), "candidate side\n");
  git(fixture.worktree, ["add", "candidate-side.txt"]);
  git(fixture.worktree, ["commit", "-m", "candidate side"]);
  git(fixture.worktree, ["switch", fixture.branch]);
  git(fixture.worktree, ["merge", "--no-ff", "fixture-side", "-m", "candidate topology"]);
  await fs.writeFile(path.join(fixture.root, "target-only.txt"), "target only\n");
  git(fixture.root, ["add", "target-only.txt"]);
  git(fixture.root, ["commit", "-m", "target only"]);

  await fixture.plane.decideTask({ runId: fixture.run.id, taskId: fixture.task.id, decision: "adopt" });
  await handoffToLocal(fixture, "handoff-merge");
  const integrated = await fixture.plane.integrateSettlement({
    runId: fixture.run.id,
    taskId: fixture.task.id,
    commitMessage: "Integrate merge fixture"
  });

  assert.equal(integrated.settlement.adoptionReceipt.integrationStrategy, "merge");
  assert.equal(git(fixture.root, ["rev-list", "--min-parents=2", "--count", "main"]), "2");
  assert.equal(git(fixture.root, ["show", "main:candidate-side.txt"]), "candidate side");
});

test("detached linear candidate uses one task-purpose cherry-pick commit", async (context) => {
  const fixture = await settlementFixture(context, "cherry");
  git(fixture.worktree, ["switch", "--detach"]);
  git(fixture.root, ["branch", "-D", fixture.branch]);
  await fs.writeFile(path.join(fixture.worktree, "detached.txt"), "detached candidate\n");
  git(fixture.worktree, ["add", "detached.txt"]);
  git(fixture.worktree, ["commit", "-m", "detached candidate"]);
  await fs.writeFile(path.join(fixture.root, "target-ahead.txt"), "target ahead\n");
  git(fixture.root, ["add", "target-ahead.txt"]);
  git(fixture.root, ["commit", "-m", "target ahead"]);

  await fixture.plane.decideTask({ runId: fixture.run.id, taskId: fixture.task.id, decision: "adopt" });
  await handoffToLocal(fixture, "handoff-cherry");
  const integrated = await fixture.plane.integrateSettlement({
    runId: fixture.run.id,
    taskId: fixture.task.id,
    commitMessage: "Integrate detached fixture"
  });

  assert.equal(integrated.settlement.adoptionReceipt.integrationStrategy, "cherry_pick");
  assert.equal(integrated.settlement.adoptionReceipt.temporaryBranchHeadAfterIntegration, null);
  assert.equal(git(fixture.root, ["show", "main:detached.txt"]), "detached candidate");
});

test("discard never integrates and derives its single forced cleanup from explicit authority", async (context) => {
  const fixture = await settlementFixture(context, "discard");
  await fs.writeFile(path.join(fixture.worktree, "rejected.txt"), "reject\n");

  const discarded = await fixture.plane.decideTask({
    runId: fixture.run.id,
    taskId: fixture.task.id,
    decision: "discard",
    note: "fixture rejection"
  });
  assert.equal(discarded.status, "settling");
  assert.equal(discarded.settlement.phase, "discard_pending");
  assert.equal(discarded.settlement.adoptionReceipt, null);

  await unpinAndArchive(fixture);
  const cleaned = await fixture.plane.cleanupSettlement({
    runId: fixture.run.id,
    taskId: fixture.task.id
  });
  assert.equal(cleaned.status, "failed");
  assert.equal(cleaned.settlement.cleanupReceipt.forceUsed, true);
  assert.equal(fsSync.existsSync(path.join(fixture.root, "rejected.txt")), false);
  assert.equal(fsSync.existsSync(fixture.worktree), false);
  assert.equal(hasRef(fixture.root, "refs/heads/candidate-discard"), false);
});

test("adoption content mismatch remains nonterminal and preserves the owned worktree", async (context) => {
  const fixture = await settlementFixture(context, "blocked");
  await fs.writeFile(path.join(fixture.worktree, "candidate.txt"), "candidate\n");
  await fixture.plane.decideTask({
    runId: fixture.run.id,
    taskId: fixture.task.id,
    decision: "adopt"
  });
  await recordThreadLocation(fixture, fixture.worktree);
  const handoff = await fixture.plane.prepareOperation({
    runId: fixture.run.id,
    tool: "codex_app__handoff_thread",
    input: { taskId: fixture.task.id },
    confirmLiveAction: true
  });
  await fixture.plane.completeOperation({
    runId: fixture.run.id,
    operationId: handoff.operation.id,
    result: { runtimeOperationId: "handoff-blocked", handoffState: "completed", taskStatus: "idle" }
  });
  await fs.writeFile(path.join(fixture.worktree, "candidate.txt"), "changed after review\n");
  await recordThreadLocation(fixture, fixture.root);

  await assert.rejects(
    fixture.plane.integrateSettlement({ runId: fixture.run.id, taskId: fixture.task.id }),
    (error) => error.code === "CANDIDATE_WORKTREE_CHANGED"
  );
  const blocked = await fixture.plane.snapshot({ runId: fixture.run.id });
  assert.equal(blocked.tasks[fixture.task.id].status, "settling");
  assert.equal(blocked.tasks[fixture.task.id].settlement.phase, "blocked");
  assert.equal(blocked.tasks[fixture.task.id].settlement.blocker.resumePhase, "integration_pending");
  assert.equal(fsSync.existsSync(fixture.worktree), true);
  assert.equal(hasRef(fixture.root, "refs/heads/candidate-blocked"), true);
  const reconciled = await fixture.plane.reconcile({ runId: fixture.run.id });
  assert.equal(reconciled.records[0].classification, "ownership_ambiguous");
});

test("overlapping target changes block before history or stash mutation", async (context) => {
  const fixture = await settlementFixture(context, "overlap");
  await fs.writeFile(path.join(fixture.worktree, "README.md"), "candidate version\n");
  git(fixture.worktree, ["add", "README.md"]);
  git(fixture.worktree, ["commit", "-m", "candidate overlap"]);
  await fs.writeFile(path.join(fixture.root, "README.md"), "target version\n");
  git(fixture.root, ["add", "README.md"]);
  git(fixture.root, ["commit", "-m", "target overlap"]);

  await fixture.plane.decideTask({ runId: fixture.run.id, taskId: fixture.task.id, decision: "adopt" });
  await handoffToLocal(fixture, "handoff-overlap");
  const targetHead = git(fixture.root, ["rev-parse", "main"]);
  await assert.rejects(
    fixture.plane.integrateSettlement({ runId: fixture.run.id, taskId: fixture.task.id }),
    (error) => error.code === "TARGET_TASK_PATHS_DIVERGED"
  );
  assert.equal(git(fixture.root, ["rev-parse", "main"]), targetHead);
  assert.equal(git(fixture.root, ["stash", "list"]), "");
  assert.equal(fsSync.existsSync(fixture.worktree), true);
});

test("cleanup refuses a review branch different from the branch owned at binding", async (context) => {
  const fixture = await settlementFixture(context, "switched");
  git(fixture.worktree, ["switch", "-c", "unexpected-review-branch"]);
  await fs.writeFile(path.join(fixture.worktree, "switched.txt"), "unexpected branch result\n");
  git(fixture.worktree, ["add", "switched.txt"]);
  git(fixture.worktree, ["commit", "-m", "unexpected review branch"]);

  await fixture.plane.decideTask({ runId: fixture.run.id, taskId: fixture.task.id, decision: "adopt" });
  await handoffToLocal(fixture, "handoff-switched");
  await fixture.plane.integrateSettlement({ runId: fixture.run.id, taskId: fixture.task.id });
  await unpinAndArchive(fixture);
  await assert.rejects(
    fixture.plane.cleanupSettlement({ runId: fixture.run.id, taskId: fixture.task.id }),
    (error) => error.code === "UNEXPECTED_REVIEW_BRANCH"
  );
  assert.equal(hasRef(fixture.root, "refs/heads/unexpected-review-branch"), true);
  assert.equal(fsSync.existsSync(fixture.worktree), true);
  const snapshot = await fixture.plane.snapshot({ runId: fixture.run.id });
  assert.equal(snapshot.tasks[fixture.task.id].settlement.phase, "blocked");
});

async function settlementFixture(context, suffix) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `task-control-settlement-${suffix}-`));
  const ledgerRoot = await fs.mkdtemp(path.join(os.tmpdir(), `task-control-ledger-${suffix}-`));
  const worktreeParent = await fs.mkdtemp(path.join(os.tmpdir(), `task-control-worktree-${suffix}-`));
  context.after(async () => {
    if (fsSync.existsSync(root)) {
      for (const entry of parseWorktreePaths(root)) {
        if (entry !== root && fsSync.existsSync(entry)) {
          try { git(root, ["worktree", "remove", "--force", entry]); } catch {}
        }
      }
      await fs.rm(root, { recursive: true, force: true });
    }
    await fs.rm(ledgerRoot, { recursive: true, force: true });
    await fs.rm(worktreeParent, { recursive: true, force: true });
  });
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.name", "Test"]);
  git(root, ["config", "user.email", "test@example.invalid"]);
  await fs.writeFile(path.join(root, "README.md"), "base\n");
  git(root, ["add", "README.md"]);
  git(root, ["commit", "-m", "base"]);
  const worktree = path.join(worktreeParent, `candidate-${suffix}`);
  const branch = `candidate-${suffix}`;
  git(root, ["worktree", "add", "-b", branch, worktree]);

  const plane = new ControlPlane({ ledger: new Ledger(path.join(ledgerRoot, "ledger.json")) });
  const run = await plane.createRun({ objective: `settlement ${suffix}`, executionMode: "live" });
  const task = await plane.addTask({
    runId: run.id,
    title: `candidate ${suffix}`,
    prompt: "produce candidate",
    role: "worker",
    cwd: root,
    environment: "worktree",
    accessMode: "write",
    worktreePurpose: "explicit_user_isolation",
    worktreeLifecycleAuthority: `user_request:${suffix} settlement fixture`,
    integrationTargetBranch: "main"
  });
  const inspected = await inspectRepository(root);
  const canonicalWorktree = fsSync.realpathSync(worktree);
  const registration = inspected.worktrees.find((entry) => fsSync.realpathSync(entry.path) === canonicalWorktree);
  assert.ok(registration);
  await plane.ledger.update((draft) => {
    const currentRun = draft.runs[run.id];
    const item = currentRun.tasks[task.id];
    item.status = "review";
    item.threadId = `thread-${suffix}`;
    item.hostId = "local";
    item.git.commonDirectory = inspected.commonDirectory;
    item.git.primaryCheckout = root;
    item.git.targetBranch = "main";
    item.git.targetHeadAtDispatch = inspected.head;
    item.worktree.runtimeCwd = worktree;
    item.worktree.threadId = item.threadId;
    item.worktree.pinned = true;
    item.worktree.identityCaptured = true;
    item.worktree.headAtBinding = registration.head;
    item.worktree.branchAtBinding = registration.branch;
    item.worktree.detachedAtBinding = registration.detached;
    currentRun.threads[item.threadId] = {
      id: item.threadId,
      hostId: "local",
      clientThreadId: null,
      taskId: item.id,
      sourceTaskId: null,
      title: item.title,
      project: null,
      runtimeCwd: worktree,
      status: "completed",
      previousStatus: null,
      pinned: true,
      archived: false,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt
    };
    return null;
  });
  return { root, worktree, branch, plane, run, task };
}

async function recordThreadLocation(fixture, cwd) {
  const prepared = await fixture.plane.prepareOperation({
    runId: fixture.run.id,
    tool: "codex_app__list_threads",
    input: { limit: 50 }
  });
  await fixture.plane.completeOperation({
    runId: fixture.run.id,
    operationId: prepared.operation.id,
    result: {
      schemaVersion: 4,
      threads: [{
        id: `thread-${fixture.branch.replace("candidate-", "")}`,
        hostId: "local",
        title: fixture.task.title,
        projectId: null,
        cwd
      }]
    }
  });
}

async function handoffToLocal(fixture, runtimeOperationId) {
  await recordThreadLocation(fixture, fixture.worktree);
  const handoff = await fixture.plane.prepareOperation({
    runId: fixture.run.id,
    tool: "codex_app__handoff_thread",
    input: { taskId: fixture.task.id },
    confirmLiveAction: true
  });
  await fixture.plane.completeOperation({
    runId: fixture.run.id,
    operationId: handoff.operation.id,
    result: { runtimeOperationId, handoffState: "completed", taskStatus: "idle" }
  });
  await recordThreadLocation(fixture, fixture.root);
}

async function unpinAndArchive(fixture) {
  const unpin = await fixture.plane.prepareOperation({
    runId: fixture.run.id,
    tool: "codex_app__set_thread_pinned",
    input: { taskId: fixture.task.id, pinned: false },
    confirmLiveAction: true
  });
  await fixture.plane.completeOperation({
    runId: fixture.run.id,
    operationId: unpin.operation.id,
    result: { pinned: false }
  });
  const archive = await fixture.plane.prepareOperation({
    runId: fixture.run.id,
    tool: "codex_app__set_thread_archived",
    input: { taskId: fixture.task.id, archived: true },
    confirmLiveAction: true
  });
  await fixture.plane.completeOperation({
    runId: fixture.run.id,
    operationId: archive.operation.id,
    result: { archived: true }
  });
}

function parseWorktreePaths(root) {
  try {
    const output = git(root, ["worktree", "list", "--porcelain"]);
    return output.split("\n").filter((line) => line.startsWith("worktree ")).map((line) => line.slice(9));
  } catch {
    return [];
  }
}

function hasRef(root, ref) {
  try {
    git(root, ["show-ref", "--verify", ref]);
    return true;
  } catch {
    return false;
  }
}

function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}
