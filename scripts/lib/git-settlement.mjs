import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const FULL_SHA = /^[0-9a-f]{40}$/;

export async function git(cwd, args, { timeout = 10_000 } = {}) {
  validateGitCall(cwd, args);
  const result = await exec("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    timeout,
    maxBuffer: 4 * 1024 * 1024
  });
  return { stdout: result.stdout, stderr: result.stderr, code: 0 };
}

async function gitBuffer(cwd, args, { timeout = 10_000 } = {}) {
  validateGitCall(cwd, args);
  const result = await exec("git", ["-C", cwd, ...args], {
    encoding: "buffer",
    timeout,
    maxBuffer: 16 * 1024 * 1024
  });
  return result.stdout;
}

export async function inspectRepository(primaryCheckout) {
  const common = (await git(primaryCheckout, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).stdout.trim();
  const gitDirectory = (await git(primaryCheckout, ["rev-parse", "--path-format=absolute", "--git-dir"])).stdout.trim();
  const branch = await git(primaryCheckout, ["symbolic-ref", "--quiet", "--short", "HEAD"])
    .then((result) => result.stdout.trim() || null)
    .catch(() => null);
  const head = (await git(primaryCheckout, ["rev-parse", "HEAD"])).stdout.trim();
  const status = (await git(primaryCheckout, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).stdout;
  const worktrees = parseWorktrees((await git(primaryCheckout, ["worktree", "list", "--porcelain"])).stdout);
  const commonDirectory = canonicalPath(common);
  const canonicalGitDirectory = canonicalPath(gitDirectory);
  return {
    commonDirectory,
    gitDirectory: canonicalGitDirectory,
    primaryCheckout: canonicalPath(primaryCheckout),
    isPrimaryCheckout: commonDirectory === canonicalGitDirectory,
    branch,
    head,
    status,
    dirty: status.length > 0,
    worktrees,
    candidateFingerprint: fingerprint({ head, branch, status })
  };
}

export function parseWorktrees(text) {
  const records = [];
  let current = null;
  for (const line of String(text).split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      if (current) records.push(current);
      current = {
        path: line.slice(9),
        head: null,
        branch: null,
        bare: false,
        detached: false,
        locked: false,
        prunable: false
      };
    } else if (!current) continue;
    else if (line.startsWith("HEAD ")) current.head = line.slice(5);
    else if (line.startsWith("branch ")) current.branch = line.slice(7);
    else if (line === "bare") current.bare = true;
    else if (line === "detached") current.detached = true;
    else if (line === "locked" || line.startsWith("locked ")) current.locked = true;
    else if (line === "prunable" || line.startsWith("prunable ")) current.prunable = true;
  }
  if (current) records.push(current);
  return records;
}

export function fingerprint(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export async function captureCandidate({
  primaryCheckout,
  runtimePath,
  targetBranch,
  expectedCommonDirectory = null,
  expectedTemporaryBranch = null
}) {
  requireAbsolutePaths(primaryCheckout, runtimePath);
  if (sameFilesystemPath(primaryCheckout, runtimePath)) {
    throw lifecycleError("WORKTREE_PATH_IS_PRIMARY", "Managed runtime path resolves to the primary checkout");
  }
  requireBranch(targetBranch);
  const primary = await inspectRepository(primaryCheckout);
  const runtime = await inspectRepository(runtimePath);
  requirePrimaryCheckout(primary);
  requireCommonDirectory(primary, runtime, expectedCommonDirectory);
  if (primary.branch !== normalizeBranch(targetBranch)) {
    throw lifecycleError(
      "TARGET_BRANCH_NOT_CHECKED_OUT",
      `Primary checkout must be on ${normalizeBranch(targetBranch)}; found ${primary.branch || "detached"}`
    );
  }
  const registration = requireExactRegistration(primary.worktrees, runtimePath);
  if (registration.head !== runtime.head) {
    throw lifecycleError("WORKTREE_HEAD_MISMATCH", "Recorded worktree registration HEAD differs from runtime HEAD");
  }
  const targetRef = branchRef(targetBranch);
  const targetHead = await resolveRef(primaryCheckout, targetRef);
  const mergeBase = await git(primaryCheckout, ["merge-base", targetHead, runtime.head])
    .then((result) => result.stdout.trim())
    .catch(() => null);
  if (!mergeBase || !FULL_SHA.test(mergeBase)) {
    throw lifecycleError("CANDIDATE_HISTORY_UNRELATED", "Candidate and target branch do not have a usable merge base");
  }
  const committedPaths = await nameOnly(runtimePath, ["diff", "--name-only", "-z", `${mergeBase}..${runtime.head}`]);
  const dirtyPaths = await collectDirtyPaths(runtimePath);
  const changedPaths = [...new Set([...committedPaths, ...dirtyPaths])].sort();
  const candidateCommits = await revList(runtimePath, ["--reverse", "--topo-order", `${mergeBase}..${runtime.head}`]);
  const mergeCommits = await revList(runtimePath, ["--min-parents=2", `${mergeBase}..${runtime.head}`]);
  const content = [];
  for (const relativePath of changedPaths) {
    content.push({ path: relativePath, snapshot: await snapshotWorkingPath(runtimePath, relativePath) });
  }
  const identity = {
    commonDirectory: primary.commonDirectory,
    primaryCheckout: primary.primaryCheckout,
    runtimePath: canonicalPath(runtimePath),
    targetBranch: normalizeBranch(targetBranch),
    targetHead,
    mergeBase,
    candidateHead: runtime.head,
    temporaryBranchRef: expectedTemporaryBranch,
    branchAtReview: registration.branch,
    branchOwnedAtReview: Boolean(
      expectedTemporaryBranch && registration.branch === expectedTemporaryBranch
    ),
    detachedAtReview: registration.detached,
    status: runtime.status,
    committedPaths,
    dirtyPaths,
    changedPaths,
    candidateCommits,
    mergeCommits,
    content
  };
  return {
    ...identity,
    candidateFingerprint: fingerprint(identity),
    capturedAt: new Date().toISOString()
  };
}

export async function integrateCandidate({
  primaryCheckout,
  targetBranch,
  candidate,
  commitMessage,
  transactionId = null,
  recoveryState = null
}) {
  if (!candidate || typeof candidate !== "object" || !Array.isArray(candidate.changedPaths)) {
    throw lifecycleError("CANDIDATE_RECEIPT_REQUIRED", "A machine-generated candidate capture is required");
  }
  requireBranch(targetBranch);
  const primary = await inspectRepository(primaryCheckout);
  requirePrimaryCheckout(primary);
  if (primary.commonDirectory !== candidate.commonDirectory) {
    throw lifecycleError("REPOSITORY_IDENTITY_CHANGED", "Primary checkout Git common directory changed after review");
  }
  const normalizedTarget = normalizeBranch(targetBranch);
  if (primary.branch !== normalizedTarget || normalizedTarget !== candidate.targetBranch) {
    throw lifecycleError("TARGET_BRANCH_NOT_CHECKED_OUT", `Primary checkout must be on ${candidate.targetBranch}`);
  }
  const expectedFingerprint = fingerprint(candidateIdentity(candidate));
  if (expectedFingerprint !== candidate.candidateFingerprint) {
    throw lifecycleError("CANDIDATE_RECEIPT_CHANGED", "Candidate capture fingerprint no longer matches its content");
  }
  const operationId = requireTransactionId(transactionId);
  const state = normalizeRecoveryState(recoveryState, operationId, candidate);
  const message = requireCommitMessage(commitMessage);
  try {
    await rejectUnresolvedGitOperation(primaryCheckout, state);
    const candidateRef = await resolveCandidateRef(primaryCheckout, candidate, state);
    const topology = await inspectIntegrationTopology({
      primaryCheckout,
      targetBranch: normalizedTarget,
      candidate,
      candidateHead: candidateRef.head
    });
    state.topology = topology;
    if (
      topology.relationship === "diverged" &&
      topology.overlappingPaths.length > 0
    ) {
      throw detailedLifecycleError(
        "TARGET_TASK_PATHS_DIVERGED",
        `Target branch changed accepted task-owned paths: ${topology.overlappingPaths.join(", ")}`,
        { paths: topology.overlappingPaths, topology }
      );
    }
    const strategy = selectIntegrationStrategy(topology, candidateRef);
    state.strategy = strategy;
    const primaryDirtyPaths = await collectDirtyPaths(primaryCheckout);
    const candidatePathSet = new Set(candidate.changedPaths);
    const primaryTaskPaths = primaryDirtyPaths.filter((entry) => candidatePathSet.has(entry));
    const unrelatedPaths = primaryDirtyPaths.filter((entry) => !candidatePathSet.has(entry));

    if (primaryTaskPaths.length > 0) {
      const mismatches = await compareWorkingContent(primaryCheckout, candidate.content);
      if (mismatches.length > 0) {
        throw detailedLifecycleError(
          "OVERLAPPING_LOCAL_TASK_CHANGES",
          `Local has task-owned changes that do not match the accepted candidate: ${mismatches.join(", ")}`,
          { paths: mismatches }
        );
      }
      state.candidateStash ||= await createOwnedStash({
        cwd: primaryCheckout,
        paths: primaryTaskPaths,
        message: stashMessage(operationId, "candidate", candidate.candidateFingerprint),
        role: "candidate",
        sourceCheckout: primaryCheckout
      });
    }

    if (candidate.dirtyPaths?.length > 0) {
      const runtimePath = candidate.runtimePath;
      const runtime = await inspectRepository(runtimePath).catch(() => null);
      if (runtime && runtime.commonDirectory === candidate.commonDirectory) {
        const runtimeDirtyPaths = await collectDirtyPaths(runtimePath);
        if (runtimeDirtyPaths.length > 0) {
          const unexpected = runtimeDirtyPaths.filter((entry) => !candidatePathSet.has(entry));
          const mismatches = await compareWorkingContent(runtimePath, candidate.content);
          if (unexpected.length > 0 || mismatches.length > 0) {
            throw detailedLifecycleError(
              "CANDIDATE_WORKTREE_CHANGED",
              "Managed worktree no longer matches the machine-captured candidate",
              { unexpectedPaths: unexpected, mismatchedPaths: mismatches }
            );
          }
          const receipt = await createOwnedStash({
            cwd: runtimePath,
            paths: runtimeDirtyPaths,
            message: stashMessage(
              operationId,
              state.candidateStash ? "candidate-runtime-copy" : "candidate",
              candidate.candidateFingerprint
            ),
            role: state.candidateStash ? "candidate-runtime-copy" : "candidate",
            sourceCheckout: runtimePath
          });
          if (state.candidateStash) state.runtimeStash = receipt;
          else state.candidateStash = receipt;
        }
      }
    }

    if (unrelatedPaths.length > 0 && !state.userStash) {
      state.userState = await capturePathState(primaryCheckout, unrelatedPaths);
      state.userStash = await createOwnedStash({
        cwd: primaryCheckout,
        paths: unrelatedPaths,
        message: stashMessage(operationId, "user", candidate.candidateFingerprint),
        role: "user",
        sourceCheckout: primaryCheckout
      });
    }

    const history = await executeIntegrationStrategy({
      primaryCheckout,
      runtimePath: candidate.runtimePath,
      targetBranch: normalizedTarget,
      candidate,
      candidateRef,
      topology,
      strategy,
      commitMessage: message
    });
    state.history = history;

    let targetCommit = await resolveRef(primaryCheckout, branchRef(targetBranch));
    let contentMismatches = await compareCommitContent(primaryCheckout, targetCommit, candidate.content);
    let createdCommit = Boolean(history.createdCommit);
    if (contentMismatches.length > 0) {
      if (!state.candidateStash) {
        throw detailedLifecycleError(
          "CANDIDATE_CONTENT_NOT_MATERIALIZED",
          `Integrated history does not contain the accepted candidate state and no owned candidate stash is available: ${contentMismatches.join(", ")}`,
          { paths: contentMismatches }
        );
      }
      state.candidateStash = await applyOwnedStash(primaryCheckout, state.candidateStash);
      const workingMismatches = await compareWorkingContent(primaryCheckout, candidate.content);
      if (workingMismatches.length > 0) {
        throw detailedLifecycleError(
          "CANDIDATE_STASH_APPLY_MISMATCH",
          `Candidate stash did not restore the accepted state: ${workingMismatches.join(", ")}`,
          { paths: workingMismatches }
        );
      }
      await git(primaryCheckout, ["add", "-A", "--", ...candidate.changedPaths]);
      const staged = await nameOnly(primaryCheckout, ["diff", "--cached", "--name-only", "-z"]);
      const stagedOutsideCandidate = staged.filter((entry) => !candidatePathSet.has(entry));
      if (stagedOutsideCandidate.length > 0) {
        throw detailedLifecycleError(
          "STAGING_SCOPE_CHANGED",
          "Staging included a path outside the accepted candidate",
          { paths: stagedOutsideCandidate }
        );
      }
      if (staged.length > 0) {
        await git(primaryCheckout, ["commit", "-m", message]);
        createdCommit = true;
      }
      targetCommit = await resolveRef(primaryCheckout, branchRef(targetBranch));
      contentMismatches = await compareCommitContent(primaryCheckout, targetCommit, candidate.content);
      if (contentMismatches.length > 0) {
        throw detailedLifecycleError(
          "ADOPTION_COMMIT_MISMATCH",
          `Target commit does not contain accepted candidate content for: ${contentMismatches.join(", ")}`,
          { paths: contentMismatches }
        );
      }
    }

    if (state.candidateStash) {
      state.candidateStash = await dropOwnedStash(primaryCheckout, state.candidateStash);
    }
    if (state.runtimeStash) {
      state.runtimeStash = await dropOwnedStash(primaryCheckout, state.runtimeStash);
    }
    if (state.userStash) {
      state.userStash = await applyOwnedStash(primaryCheckout, state.userStash);
      await verifyPathState(primaryCheckout, state.userState);
      state.userStash = await dropOwnedStash(primaryCheckout, state.userStash);
    }

    const taskOwnedDirty = candidate.changedPaths.length === 0
      ? ""
      : (await git(primaryCheckout, ["status", "--porcelain=v1", "-z", "--", ...candidate.changedPaths])).stdout;
    if (taskOwnedDirty.length > 0) {
      throw lifecycleError("TASK_PATHS_STILL_DIRTY", "Task-owned paths remain uncommitted after adoption");
    }
    const finalCommit = await resolveRef(primaryCheckout, branchRef(targetBranch));
    const finalMismatches = await compareCommitContent(primaryCheckout, finalCommit, candidate.content);
    if (finalMismatches.length > 0) {
      throw detailedLifecycleError(
        "ADOPTION_COMMIT_MISMATCH",
        `Target commit does not contain accepted candidate content for: ${finalMismatches.join(", ")}`,
        { paths: finalMismatches }
      );
    }
    return {
      commonDirectory: primary.commonDirectory,
      primaryCheckout: primary.primaryCheckout,
      targetBranch: normalizedTarget,
      targetHeadBefore: topology.targetHead,
      targetCommit: finalCommit,
      createdCommit,
      integrationStrategy: strategy.name,
      strategyReason: strategy.reason,
      topology,
      history,
      stashReceipt: {
        candidate: state.candidateStash,
        runtimeCopy: state.runtimeStash,
        user: state.userStash,
        userStateRestored: Boolean(!state.userState || state.userStash?.dropped)
      },
      candidateHead: candidate.candidateHead,
      integratedCandidateHead: history.integratedCandidateHead,
      temporaryBranchHeadAfterIntegration: history.temporaryBranchHeadAfterIntegration,
      candidateFingerprint: candidate.candidateFingerprint,
      changedPaths: [...candidate.changedPaths],
      contentFingerprint: fingerprint(candidate.content),
      taskOwnedDirty: false,
      verifiedAt: new Date().toISOString()
    };
  } catch (error) {
    error.details = {
      ...(error.details || {}),
      conflictPaths: await unresolvedPaths(primaryCheckout),
      recoveryState: state
    };
    throw error;
  }
}

export async function verifyAdoption({ primaryCheckout, targetBranch, candidate, adoptionReceipt }) {
  if (!adoptionReceipt || !FULL_SHA.test(adoptionReceipt.targetCommit || "")) {
    throw lifecycleError("ADOPTION_RECEIPT_REQUIRED", "A full verified adoption target commit is required");
  }
  if (adoptionReceipt.candidateFingerprint !== candidate?.candidateFingerprint) {
    throw lifecycleError("ADOPTION_CANDIDATE_CHANGED", "Adoption receipt belongs to a different candidate");
  }
  const targetRef = branchRef(targetBranch);
  await git(primaryCheckout, ["merge-base", "--is-ancestor", adoptionReceipt.targetCommit, targetRef])
    .catch(() => {
      throw lifecycleError("ADOPTION_COMMIT_NOT_ON_TARGET", "Verified adoption commit is no longer on the target branch");
    });
  if (
    adoptionReceipt.integrationStrategy !== "cherry_pick" &&
    adoptionReceipt.integratedCandidateHead
  ) {
    await git(primaryCheckout, [
      "merge-base",
      "--is-ancestor",
      adoptionReceipt.integratedCandidateHead,
      targetRef
    ]).catch(() => {
      throw lifecycleError(
        "INTEGRATED_CANDIDATE_NOT_ON_TARGET",
        "The history selected for adoption is no longer contained by the target branch"
      );
    });
  }
  for (const stash of [
    adoptionReceipt.stashReceipt?.candidate,
    adoptionReceipt.stashReceipt?.runtimeCopy,
    adoptionReceipt.stashReceipt?.user
  ].filter(Boolean)) {
    if (!stash.dropped) {
      throw lifecycleError("ADOPTION_STASH_UNRESOLVED", `Adoption stash was not disposed safely: ${stash.oid}`);
    }
  }
  const mismatches = await compareCommitContent(
    primaryCheckout,
    adoptionReceipt.targetCommit,
    candidate.content
  );
  if (mismatches.length > 0) {
    throw lifecycleError("ADOPTION_CONTENT_CHANGED", "Verified adoption commit no longer matches the candidate receipt");
  }
  return true;
}

export async function acquireSettlementLock(commonDirectory, owner) {
  if (!path.isAbsolute(commonDirectory) || !owner?.runId || !owner?.taskId) {
    throw new TypeError("exact repository and run/task owner required");
  }
  const lockPath = path.join(commonDirectory, "codex-task-control-plane.settlement.lock");
  let handle;
  try {
    handle = await fs.open(lockPath, "wx", 0o600);
  } catch (error) {
    if (error.code === "EEXIST") {
      throw lifecycleError("SETTLEMENT_LOCK_HELD", `Settlement lock is held: ${lockPath}`);
    }
    throw error;
  }
  const record = {
    ...owner,
    commonDirectory: canonicalPath(commonDirectory),
    pid: process.pid,
    acquiredAt: new Date().toISOString()
  };
  await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
  await handle.sync();
  await handle.close();
  return { lockPath, owner: record };
}

export async function releaseSettlementLock(lock) {
  if (!lock?.lockPath || !lock.owner?.runId || !lock.owner?.taskId) {
    throw new TypeError("lock receipt required");
  }
  const current = JSON.parse(await fs.readFile(lock.lockPath, "utf8"));
  if (
    current.runId !== lock.owner.runId ||
    current.taskId !== lock.owner.taskId ||
    current.commonDirectory !== lock.owner.commonDirectory
  ) {
    throw lifecycleError("SETTLEMENT_LOCK_OWNERSHIP_MISMATCH", "Settlement lock ownership changed");
  }
  await fs.unlink(lock.lockPath);
  return { lockPath: lock.lockPath, releasedAt: new Date().toISOString() };
}

export async function removeExactWorktree({
  primaryCheckout,
  runtimePath,
  expectedCommonDirectory,
  expectedBranch = null,
  force = false
}) {
  requireAbsolutePaths(primaryCheckout, runtimePath);
  if (sameFilesystemPath(primaryCheckout, runtimePath)) {
    throw lifecycleError("CLEANUP_PRIMARY_CHECKOUT_REFUSED", "Primary checkout cannot be removed as a managed worktree");
  }
  const before = await inspectRepository(primaryCheckout);
  requirePrimaryCheckout(before);
  if (before.commonDirectory !== canonicalPath(expectedCommonDirectory)) {
    throw lifecycleError("CLEANUP_REPOSITORY_MISMATCH", "Cleanup common directory does not match recorded ownership");
  }
  const registrations = before.worktrees.filter((entry) => sameFilesystemPath(entry.path, runtimePath));
  if (registrations.length > 1) {
    throw lifecycleError("CLEANUP_OWNERSHIP_AMBIGUOUS", "More than one worktree registration matches the runtime path");
  }
  const registration = registrations[0] || null;
  if (registration && expectedBranch && registration.branch !== expectedBranch) {
    throw lifecycleError("CLEANUP_BRANCH_MISMATCH", "Managed worktree branch differs from the reviewed branch");
  }
  const exists = pathExistsNoFollow(runtimePath);
  if (exists) {
    const stat = await fs.lstat(runtimePath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw lifecycleError("CLEANUP_PATH_TYPE_MISMATCH", "Managed runtime path is not an owned directory");
    }
  }
  if (!registration && !exists) {
    return {
      mode: "already_absent",
      forceUsed: false,
      processExit: null,
      before,
      after: before,
      pathAbsent: true,
      registrationAbsent: true,
      verificationTimestamp: new Date().toISOString()
    };
  }
  if (!registration && exists) {
    const stat = await fs.lstat(runtimePath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw lifecycleError("CLEANUP_PATH_TYPE_MISMATCH", "Residual runtime path is not an owned directory");
    }
    const entries = await fs.readdir(runtimePath);
    if (entries.length > 0) {
      throw lifecycleError("CLEANUP_BLOCKED", "Unregistered residual worktree is non-empty");
    }
    await fs.rmdir(runtimePath);
  } else {
    const args = ["worktree", "remove"];
    if (force) args.push("--force");
    args.push(runtimePath);
    try {
      await git(primaryCheckout, args);
    } catch (cause) {
      const raced = await inspectRepository(primaryCheckout);
      const pathAbsent = !pathExistsNoFollow(runtimePath);
      const registrationAbsent = !raced.worktrees.some((entry) => sameFilesystemPath(entry.path, runtimePath));
      if (pathAbsent && registrationAbsent) {
        return {
          mode: "git_worktree_remove_raced",
          forceUsed: force,
          processExit: typeof cause.code === "number" ? cause.code : 1,
          processError: String(cause.stderr || cause.message || "").trim(),
          before,
          after: raced,
          pathAbsent,
          registrationAbsent,
          verificationTimestamp: new Date().toISOString()
        };
      }
      throw detailedLifecycleError(
        "CLEANUP_BLOCKED",
        "Exact Git worktree removal failed and physical absence was not proved",
        {
          runtimePath,
          forceUsed: force,
          stderr: String(cause.stderr || cause.message || "").trim(),
          pathAbsent,
          registrationAbsent
        }
      );
    }
  }
  const after = await inspectRepository(primaryCheckout);
  return {
    mode: registration ? "git_worktree_remove" : "empty_rmdir",
    forceUsed: force,
    processExit: 0,
    before,
    after,
    pathAbsent: !pathExistsNoFollow(runtimePath),
    registrationAbsent: !after.worktrees.some((entry) => sameFilesystemPath(entry.path, runtimePath)),
    verificationTimestamp: new Date().toISOString()
  };
}

export async function removeExactBranch({
  primaryCheckout,
  branch,
  expectedHead = null,
  force = false
}) {
  if (!path.isAbsolute(primaryCheckout)) throw new TypeError("absolute checkout required");
  if (!branch) {
    return {
      branch: null,
      mode: "not_recorded",
      forceUsed: false,
      processExit: null,
      branchAbsent: true,
      verificationTimestamp: new Date().toISOString()
    };
  }
  const ref = branch.startsWith("refs/heads/") ? branch : branchRef(branch);
  const currentHead = await resolveRef(primaryCheckout, ref).catch(() => null);
  if (!currentHead) {
    return {
      branch: ref,
      mode: "already_absent",
      forceUsed: false,
      processExit: null,
      branchAbsent: true,
      verificationTimestamp: new Date().toISOString()
    };
  }
  if (expectedHead && currentHead !== expectedHead) {
    throw lifecycleError("CLEANUP_BRANCH_MOVED", "Temporary branch moved after candidate review");
  }
  await git(primaryCheckout, ["branch", force ? "-D" : "-d", ref.slice("refs/heads/".length)]);
  const after = await resolveRef(primaryCheckout, ref).catch(() => null);
  return {
    branch: ref,
    headBefore: currentHead,
    mode: "branch_delete",
    forceUsed: force,
    processExit: 0,
    branchAbsent: !after,
    verificationTimestamp: new Date().toISOString()
  };
}

async function collectDirtyPaths(runtimePath) {
  const groups = await Promise.all([
    nameOnly(runtimePath, ["diff", "--name-only", "-z"]),
    nameOnly(runtimePath, ["diff", "--cached", "--name-only", "-z"]),
    nameOnly(runtimePath, ["ls-files", "--others", "--exclude-standard", "-z"])
  ]);
  return [...new Set(groups.flat().map(requireRelativePath))].sort();
}

async function inspectIntegrationTopology({ primaryCheckout, targetBranch, candidate, candidateHead }) {
  const targetHead = await resolveRef(primaryCheckout, branchRef(targetBranch));
  const mergeBase = await git(primaryCheckout, ["merge-base", targetHead, candidateHead])
    .then((result) => result.stdout.trim())
    .catch(() => null);
  if (!mergeBase || !FULL_SHA.test(mergeBase)) {
    throw lifecycleError("CANDIDATE_HISTORY_UNRELATED", "Candidate and target branch do not have a usable merge base");
  }
  const candidateContained = await isAncestor(primaryCheckout, candidateHead, targetHead);
  const targetContained = await isAncestor(primaryCheckout, targetHead, candidateHead);
  const relationship = candidateContained
    ? "candidate_contained"
    : targetContained
      ? "fast_forward"
      : "diverged";
  const targetChangedPaths = relationship === "fast_forward"
    ? []
    : await nameOnly(primaryCheckout, ["diff", "--name-only", "-z", `${mergeBase}..${targetHead}`]);
  const candidateChangedPaths = await nameOnly(primaryCheckout, [
    "diff",
    "--name-only",
    "-z",
    `${mergeBase}..${candidateHead}`
  ]);
  const candidatePathSet = new Set(candidate.changedPaths);
  const overlappingPaths = targetChangedPaths.filter((entry) => candidatePathSet.has(entry));
  const candidateCommits = await revList(primaryCheckout, [
    "--reverse",
    "--topo-order",
    `${mergeBase}..${candidateHead}`
  ]);
  const mergeCommits = await revList(primaryCheckout, ["--min-parents=2", `${mergeBase}..${candidateHead}`]);
  return {
    relationship,
    targetHead,
    candidateHead,
    mergeBase,
    targetChangedPaths,
    candidateChangedPaths,
    overlappingPaths,
    candidateCommits,
    mergeCommits,
    targetAheadCount: Number((await git(primaryCheckout, ["rev-list", "--count", `${candidateHead}..${targetHead}`])).stdout.trim()),
    candidateAheadCount: Number((await git(primaryCheckout, ["rev-list", "--count", `${targetHead}..${candidateHead}`])).stdout.trim())
  };
}

function selectIntegrationStrategy(topology, candidateRef) {
  if (topology.relationship === "candidate_contained") {
    return { name: "already_contained", reason: "candidate HEAD is already an ancestor of the exact target branch" };
  }
  if (topology.relationship === "fast_forward") {
    return { name: "fast_forward", reason: "exact target HEAD is an ancestor of candidate HEAD" };
  }
  if (topology.overlappingPaths.length > 0) {
    throw detailedLifecycleError(
      "TARGET_TASK_PATHS_DIVERGED",
      "Target branch and candidate changed the same task-owned paths",
      { paths: topology.overlappingPaths, topology }
    );
  }
  if (candidateRef.branchOwned && topology.mergeCommits.length === 0) {
    return {
      name: "rebase_fast_forward",
      reason: "task-owned temporary branch is linear and target divergence does not overlap task-owned paths"
    };
  }
  if (candidateRef.branchOwned) {
    return {
      name: "merge",
      reason: "task-owned candidate contains merge topology that must be preserved"
    };
  }
  if (topology.mergeCommits.length > 0) {
    throw detailedLifecycleError(
      "DETACHED_MERGE_CANDIDATE_UNSAFE",
      "Detached candidate contains merge commits and cannot be cherry-picked without inventing a mainline parent",
      { mergeCommits: topology.mergeCommits }
    );
  }
  return {
    name: "cherry_pick",
    reason: "detached linear candidate has no owned branch that may be rebased or merged for cleanup"
  };
}

async function executeIntegrationStrategy({
  primaryCheckout,
  runtimePath,
  targetBranch,
  candidate,
  candidateRef,
  topology,
  strategy,
  commitMessage
}) {
  let integratedCandidateHead = candidateRef.head;
  let temporaryBranchHeadAfterIntegration = candidateRef.branchOwned ? candidateRef.head : null;
  let createdCommit = false;
  if (strategy.name === "fast_forward") {
    await runHistoryGit(primaryCheckout, ["merge", "--ff-only", candidateRef.head], "FAST_FORWARD_FAILED");
  } else if (strategy.name === "rebase_fast_forward") {
    const runtime = await inspectRepository(runtimePath);
    requireCommonDirectory(await inspectRepository(primaryCheckout), runtime, candidate.commonDirectory);
    if (runtime.dirty) {
      throw detailedLifecycleError(
        "REBASE_WORKTREE_DIRTY",
        "Task worktree must be clean after candidate stash before rebase",
        { runtimePath, dirtyPaths: await collectDirtyPaths(runtimePath) }
      );
    }
    if (runtime.branch !== candidateRef.branchName) {
      throw detailedLifecycleError(
        "REBASE_BRANCH_NOT_CHECKED_OUT",
        "Task-owned temporary branch is not checked out at the recorded worktree",
        { expected: candidateRef.branchName, actual: runtime.branch }
      );
    }
    await runHistoryGit(
      runtimePath,
      ["rebase", "--onto", topology.targetHead, topology.mergeBase],
      "REBASE_FAILED"
    );
    integratedCandidateHead = await resolveRef(primaryCheckout, candidateRef.branchRef);
    temporaryBranchHeadAfterIntegration = integratedCandidateHead;
    await runHistoryGit(primaryCheckout, ["merge", "--ff-only", integratedCandidateHead], "POST_REBASE_FAST_FORWARD_FAILED");
  } else if (strategy.name === "merge") {
    await runHistoryGit(
      primaryCheckout,
      ["merge", "--no-ff", "-m", commitMessage, candidateRef.head],
      "MERGE_FAILED"
    );
    createdCommit = true;
  } else if (strategy.name === "cherry_pick") {
    if (topology.candidateCommits.length === 0) {
      throw lifecycleError("CHERRY_PICK_COMMITS_MISSING", "Detached candidate has no unique commits to cherry-pick");
    }
    await runHistoryGit(
      primaryCheckout,
      ["cherry-pick", "--no-commit", ...topology.candidateCommits],
      "CHERRY_PICK_FAILED"
    );
    await git(primaryCheckout, ["commit", "-m", commitMessage]);
    createdCommit = true;
  }
  return {
    strategy: strategy.name,
    targetHeadBefore: topology.targetHead,
    candidateHeadBefore: candidateRef.head,
    integratedCandidateHead,
    temporaryBranchHeadAfterIntegration,
    targetHeadAfter: await resolveRef(primaryCheckout, branchRef(targetBranch)),
    createdCommit,
    completedAt: new Date().toISOString()
  };
}

async function resolveCandidateRef(primaryCheckout, candidate, recoveryState) {
  if (!candidate.branchOwnedAtReview || !candidate.branchAtReview || candidate.detachedAtReview) {
    return { branchOwned: false, branchRef: null, branchName: null, head: candidate.candidateHead };
  }
  const branchRefValue = candidate.branchAtReview.startsWith("refs/heads/")
    ? candidate.branchAtReview
    : branchRef(candidate.branchAtReview);
  const branchName = branchRefValue.slice("refs/heads/".length);
  const currentHead = await resolveRef(primaryCheckout, branchRefValue);
  const allowedHeads = new Set([
    candidate.candidateHead,
    recoveryState?.history?.integratedCandidateHead,
    recoveryState?.candidateRefHead
  ].filter(Boolean));
  if (!allowedHeads.has(currentHead) && recoveryState?.strategy?.name !== "rebase_fast_forward") {
    throw detailedLifecycleError(
      "CANDIDATE_BRANCH_MOVED",
      "Task-owned temporary branch moved after candidate capture",
      { branchRef: branchRefValue, expectedHeads: [...allowedHeads], actualHead: currentHead }
    );
  }
  return { branchOwned: true, branchRef: branchRefValue, branchName, head: currentHead };
}

async function createOwnedStash({ cwd, paths, message, role, sourceCheckout }) {
  if (paths.length === 0) return null;
  const existing = await findOwnedStash(cwd, message);
  if (existing) return { ...existing, role, sourceCheckout, paths: [...paths], reused: true };
  const before = await resolveRef(cwd, "refs/stash").catch(() => null);
  await git(cwd, ["stash", "push", "--include-untracked", "--message", message, "--", ...paths]);
  const after = await resolveRef(cwd, "refs/stash").catch(() => null);
  if (!after || after === before) {
    throw detailedLifecycleError("STASH_NOT_CREATED", `Exact-path ${role} stash was not created`, { paths, message });
  }
  return {
    role,
    sourceCheckout,
    paths: [...paths],
    message,
    oid: after,
    applied: false,
    dropped: false,
    reused: false,
    createdAt: new Date().toISOString()
  };
}

async function applyOwnedStash(cwd, receipt) {
  if (!receipt || receipt.applied) return receipt;
  const located = await findStashByOid(cwd, receipt.oid);
  if (!located) {
    throw detailedLifecycleError(
      "OWNED_STASH_MISSING",
      `Recorded ${receipt.role} stash is missing before restore`,
      { stash: receipt }
    );
  }
  try {
    await git(cwd, ["stash", "apply", "--index", receipt.oid]);
  } catch (cause) {
    throw detailedLifecycleError(
      "STASH_APPLY_FAILED",
      `Failed to restore exact ${receipt.role} stash`,
      { stash: receipt, stderr: String(cause.stderr || "").trim() }
    );
  }
  return { ...receipt, applied: true, appliedAt: new Date().toISOString() };
}

async function dropOwnedStash(cwd, receipt) {
  if (!receipt || receipt.dropped) return receipt;
  const located = await findStashByOid(cwd, receipt.oid);
  if (!located) {
    if (receipt.applied) return { ...receipt, dropped: true, dropMode: "already_absent" };
    throw detailedLifecycleError("OWNED_STASH_MISSING", "Owned stash disappeared before its state was represented", { stash: receipt });
  }
  await git(cwd, ["stash", "drop", located.ref]);
  const remains = await findStashByOid(cwd, receipt.oid);
  if (remains) throw lifecycleError("STASH_DROP_NOT_VERIFIED", `Owned stash still exists: ${receipt.oid}`);
  return { ...receipt, dropped: true, dropMode: "exact_ref_drop", droppedAt: new Date().toISOString() };
}

async function findOwnedStash(cwd, message) {
  const stashes = await listStashes(cwd);
  const matches = stashes.filter((entry) => entry.subject.endsWith(message));
  if (matches.length > 1) {
    throw detailedLifecycleError("OWNED_STASH_AMBIGUOUS", `More than one stash matches ${message}`, { stashes: matches });
  }
  return matches[0] || null;
}

async function findStashByOid(cwd, oid) {
  const matches = (await listStashes(cwd)).filter((entry) => entry.oid === oid);
  if (matches.length > 1) throw lifecycleError("OWNED_STASH_AMBIGUOUS", `Stash object is referenced more than once: ${oid}`);
  return matches[0] || null;
}

async function listStashes(cwd) {
  const output = (await git(cwd, ["stash", "list", "--format=%H%x09%gd%x09%gs"])).stdout.trim();
  if (!output) return [];
  return output.split("\n").map((line) => {
    const [oid, ref, ...subject] = line.split("\t");
    return { oid, ref, subject: subject.join("\t"), applied: false, dropped: false };
  });
}

async function capturePathState(root, paths) {
  const content = [];
  for (const relativePath of paths) {
    content.push({ path: relativePath, snapshot: await snapshotWorkingPath(root, relativePath) });
  }
  return {
    paths: [...paths],
    status: (await git(root, ["status", "--porcelain=v1", "-z", "--", ...paths])).stdout,
    content
  };
}

async function verifyPathState(root, state) {
  if (!state) return true;
  const contentMismatches = await compareWorkingContent(root, state.content);
  const status = (await git(root, ["status", "--porcelain=v1", "-z", "--", ...state.paths])).stdout;
  if (contentMismatches.length > 0 || status !== state.status) {
    throw detailedLifecycleError(
      "USER_STATE_RESTORE_MISMATCH",
      "Unrelated Local changes were not restored byte-for-byte with their original Git status",
      { paths: state.paths, contentMismatches, expectedStatus: state.status, actualStatus: status }
    );
  }
  return true;
}

async function runHistoryGit(cwd, args, code) {
  try {
    return await git(cwd, args);
  } catch (cause) {
    throw detailedLifecycleError(code, `Git history operation failed: git ${args.join(" ")}`, {
      stderr: String(cause.stderr || "").trim(),
      stdout: String(cause.stdout || "").trim()
    });
  }
}

async function rejectUnresolvedGitOperation(primaryCheckout, state) {
  const gitDirectory = (await git(primaryCheckout, ["rev-parse", "--path-format=absolute", "--git-dir"])).stdout.trim();
  const markers = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"]
    .filter((entry) => pathExistsNoFollow(path.join(gitDirectory, entry)));
  if (markers.length > 0) {
    throw detailedLifecycleError(
      "GIT_OPERATION_IN_PROGRESS",
      "Authoritative checkout has an unresolved Git history operation",
      { markers, priorStrategy: state?.strategy || null }
    );
  }
}

async function unresolvedPaths(cwd) {
  return nameOnly(cwd, ["diff", "--name-only", "-z", "--diff-filter=U"]).catch(() => []);
}

async function isAncestor(cwd, ancestor, descendant) {
  return git(cwd, ["merge-base", "--is-ancestor", ancestor, descendant])
    .then(() => true)
    .catch(() => false);
}

async function revList(cwd, args) {
  const output = (await git(cwd, ["rev-list", ...args])).stdout.trim();
  return output ? output.split(/\r?\n/).filter((entry) => FULL_SHA.test(entry)) : [];
}

function normalizeRecoveryState(recoveryState, operationId, candidate) {
  if (!recoveryState || recoveryState.operationId !== operationId) {
    return {
      operationId,
      candidateFingerprint: candidate.candidateFingerprint,
      candidateStash: null,
      runtimeStash: null,
      userStash: null,
      userState: null,
      topology: null,
      strategy: null,
      history: null
    };
  }
  if (recoveryState.candidateFingerprint !== candidate.candidateFingerprint) {
    throw lifecycleError("RECOVERY_CANDIDATE_CHANGED", "Integration recovery belongs to a different candidate");
  }
  return structuredClone(recoveryState);
}

function requireTransactionId(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError("stable settlement transaction id required");
  }
  return value.trim();
}

function requireCommitMessage(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw lifecycleError("COMMIT_MESSAGE_REQUIRED", "A task-purpose commit message is required");
  }
  return value.trim();
}

function stashMessage(operationId, role, candidateFingerprint) {
  return `codex-task-control-plane:${operationId}:${role}:${candidateFingerprint}`;
}

async function nameOnly(cwd, args) {
  return parseNul((await git(cwd, args)).stdout).map(requireRelativePath);
}

function parseNul(value) {
  return String(value).split("\0").filter(Boolean);
}

async function compareWorkingContent(root, content) {
  const mismatches = [];
  for (const entry of content || []) {
    const actual = await snapshotWorkingPath(root, entry.path);
    if (JSON.stringify(actual) !== JSON.stringify(entry.snapshot)) mismatches.push(entry.path);
  }
  return mismatches;
}

async function compareCommitContent(root, commit, content) {
  const mismatches = [];
  for (const entry of content || []) {
    const actual = await snapshotCommitPath(root, commit, entry.path);
    if (JSON.stringify(actual) !== JSON.stringify(entry.snapshot)) mismatches.push(entry.path);
  }
  return mismatches;
}

async function snapshotWorkingPath(root, relativePath) {
  const absolutePath = path.join(root, requireRelativePath(relativePath));
  let stat;
  try {
    stat = await fs.lstat(absolutePath);
  } catch (error) {
    if (error.code === "ENOENT") return { kind: "absent" };
    throw error;
  }
  if (stat.isSymbolicLink()) {
    const target = await fs.readlink(absolutePath);
    return { kind: "symlink", mode: "120000", hash: hashBytes(Buffer.from(target)) };
  }
  if (!stat.isFile()) {
    throw lifecycleError("UNSUPPORTED_CANDIDATE_PATH", `Candidate path is not a regular file or symlink: ${relativePath}`);
  }
  const bytes = await fs.readFile(absolutePath);
  return {
    kind: "file",
    mode: (stat.mode & 0o111) === 0 ? "100644" : "100755",
    hash: hashBytes(bytes)
  };
}

async function snapshotCommitPath(root, commit, relativePath) {
  requireRelativePath(relativePath);
  const record = await git(root, ["ls-tree", "-z", commit, "--", relativePath])
    .then((result) => parseNul(result.stdout)[0] || null);
  if (!record) return { kind: "absent" };
  const separator = record.indexOf("\t");
  const metadata = separator >= 0 ? record.slice(0, separator).split(" ") : [];
  const mode = metadata[0];
  const type = metadata[1];
  if (type !== "blob" || !["100644", "100755", "120000"].includes(mode)) {
    throw lifecycleError("UNSUPPORTED_COMMITTED_PATH", `Committed path has unsupported Git type: ${relativePath}`);
  }
  const bytes = await gitBuffer(root, ["cat-file", "blob", `${commit}:${relativePath}`]);
  return { kind: mode === "120000" ? "symlink" : "file", mode, hash: hashBytes(bytes) };
}

async function resolveRef(cwd, ref) {
  const resolved = (await git(cwd, ["rev-parse", "--verify", ref])).stdout.trim();
  if (!FULL_SHA.test(resolved)) {
    throw lifecycleError("INVALID_GIT_OBJECT_ID", `Expected a full commit SHA for ${ref}`);
  }
  return resolved;
}

function candidateIdentity(candidate) {
  return {
    commonDirectory: candidate.commonDirectory,
    primaryCheckout: candidate.primaryCheckout,
    runtimePath: candidate.runtimePath,
    targetBranch: candidate.targetBranch,
    targetHead: candidate.targetHead,
    mergeBase: candidate.mergeBase,
    candidateHead: candidate.candidateHead,
    temporaryBranchRef: candidate.temporaryBranchRef,
    branchAtReview: candidate.branchAtReview,
    branchOwnedAtReview: candidate.branchOwnedAtReview,
    detachedAtReview: candidate.detachedAtReview,
    status: candidate.status,
    committedPaths: candidate.committedPaths,
    dirtyPaths: candidate.dirtyPaths,
    changedPaths: candidate.changedPaths,
    candidateCommits: candidate.candidateCommits,
    mergeCommits: candidate.mergeCommits,
    content: candidate.content
  };
}

function requireExactRegistration(worktrees, runtimePath) {
  const matches = worktrees.filter((entry) => sameFilesystemPath(entry.path, runtimePath));
  if (matches.length !== 1) {
    throw lifecycleError(
      matches.length === 0 ? "WORKTREE_REGISTRATION_MISSING" : "WORKTREE_OWNERSHIP_AMBIGUOUS",
      `Expected one exact managed worktree registration; found ${matches.length}`
    );
  }
  return matches[0];
}

function requirePrimaryCheckout(inspection) {
  if (!inspection.isPrimaryCheckout) {
    throw lifecycleError("PRIMARY_CHECKOUT_REQUIRED", "Selected Local checkout is itself a linked worktree");
  }
}

function requireCommonDirectory(primary, runtime, expectedCommonDirectory) {
  const expected = expectedCommonDirectory ? canonicalPath(expectedCommonDirectory) : primary.commonDirectory;
  if (primary.commonDirectory !== expected || runtime.commonDirectory !== expected) {
    throw lifecycleError("REPOSITORY_IDENTITY_MISMATCH", "Primary and runtime checkouts do not share the recorded Git common directory");
  }
}

function validateGitCall(cwd, args) {
  if (!path.isAbsolute(cwd) || !Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
    throw new TypeError("git requires an absolute cwd and an argument vector");
  }
}

function requireAbsolutePaths(...values) {
  if (values.some((value) => typeof value !== "string" || !path.isAbsolute(value))) {
    throw new TypeError("absolute exact paths required");
  }
}

function requireBranch(branch) {
  if (typeof branch !== "string" || !branch.trim()) throw new TypeError("exact target branch required");
}

function normalizeBranch(branch) {
  requireBranch(branch);
  return branch.startsWith("refs/heads/") ? branch.slice("refs/heads/".length) : branch.trim();
}

function branchRef(branch) {
  return `refs/heads/${normalizeBranch(branch)}`;
}

function requireRelativePath(candidate) {
  if (typeof candidate !== "string" || !candidate || path.isAbsolute(candidate)) {
    throw lifecycleError("INVALID_TASK_PATH", "Task-owned paths must be non-empty repository-relative paths");
  }
  const normalized = path.normalize(candidate);
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
    throw lifecycleError("INVALID_TASK_PATH", `Task-owned path escapes the repository: ${candidate}`);
  }
  return normalized;
}

function canonicalPath(candidate) {
  try {
    return fsSync.realpathSync(candidate);
  } catch {
    return path.resolve(candidate);
  }
}

function sameFilesystemPath(left, right) {
  return canonicalPath(left) === canonicalPath(right);
}

function pathExistsNoFollow(candidate) {
  try {
    fsSync.lstatSync(candidate);
    return true;
  } catch {
    return false;
  }
}

function hashBytes(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function lifecycleError(code, message) {
  const error = new Error(message);
  error.name = "GitSettlementError";
  error.code = code;
  return error;
}

function detailedLifecycleError(code, message, details) {
  const error = lifecycleError(code, message);
  error.details = details;
  return error;
}
