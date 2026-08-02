export const RUN_TRANSITIONS = Object.freeze({
  active: new Set(["review", "completed", "failed", "cancelled"]),
  review: new Set(["active", "completed", "failed", "cancelled"]),
  completed: new Set(),
  failed: new Set(["active", "cancelled"]),
  cancelled: new Set()
});

export const TASK_TRANSITIONS = Object.freeze({
  created: new Set(["prepared", "review", "cancelled"]),
  prepared: new Set(["provisioning", "running", "idle", "review", "failed", "cancelled"]),
  provisioning: new Set(["running", "idle", "review", "needs_attention", "failed", "cancel_requested"]),
  running: new Set(["idle", "review", "blocked", "needs_attention", "failed", "cancel_requested"]),
  idle: new Set(["running", "review", "blocked", "needs_attention", "failed", "cancel_requested"]),
  blocked: new Set(["running", "idle", "review", "needs_attention", "failed", "cancel_requested"]),
  needs_attention: new Set(["running", "idle", "review", "blocked", "failed", "cancel_requested"]),
  review: new Set(["completed", "idle", "running", "failed", "cancel_requested"]),
  failed: new Set(["prepared", "cancelled"]),
  cancel_requested: new Set(["running", "failed", "cancelled"]),
  completed: new Set(),
  cancelled: new Set()
});

export const THREAD_TRANSITIONS = Object.freeze({
  provisioning: new Set(["active", "idle", "needs_attention", "failed", "archived"]),
  active: new Set(["idle", "completed", "blocked", "needs_attention", "handoff", "failed", "archived"]),
  idle: new Set(["active", "completed", "blocked", "needs_attention", "handoff", "failed", "archived"]),
  blocked: new Set(["active", "idle", "needs_attention", "handoff", "failed", "archived"]),
  needs_attention: new Set(["active", "idle", "blocked", "handoff", "failed", "archived"]),
  handoff: new Set(["provisioning", "active", "idle", "needs_attention", "failed", "archived"]),
  completed: new Set(["active", "handoff", "archived"]),
  failed: new Set(["active", "handoff", "archived"]),
  archived: new Set(["active", "idle", "blocked", "needs_attention", "completed", "failed"])
});

export const OPERATION_TRANSITIONS = Object.freeze({
  prepared: new Set(["pending", "succeeded", "failed"]),
  pending: new Set(["succeeded", "failed"]),
  succeeded: new Set(),
  failed: new Set()
});

export class TransitionError extends Error {
  constructor(entity, from, to) {
    super(`Invalid ${entity} transition: ${from} -> ${to}`);
    this.name = "TransitionError";
    this.code = "INVALID_TRANSITION";
    this.entity = entity;
    this.from = from;
    this.to = to;
  }
}

export function assertTransition(kind, from, to) {
  const table = {
    run: RUN_TRANSITIONS,
    task: TASK_TRANSITIONS,
    thread: THREAD_TRANSITIONS,
    operation: OPERATION_TRANSITIONS
  }[kind];
  if (!table || !table[from] || !table[from].has(to)) {
    throw new TransitionError(kind, from, to);
  }
}

export function transition(entity, kind, to, now = new Date().toISOString()) {
  if (entity.status === to) {
    entity.updatedAt = now;
    return entity;
  }
  assertTransition(kind, entity.status, to);
  entity.status = to;
  entity.updatedAt = now;
  return entity;
}
