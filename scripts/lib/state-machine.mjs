export const RUN_TRANSITIONS = Object.freeze({
  draft: new Set(["active", "cancelled"]),
  active: new Set(["review", "failed", "cancelled"]),
  review: new Set(["active", "completed", "failed", "cancelled"]),
  completed: new Set(),
  failed: new Set(["active", "cancelled"]),
  cancelled: new Set()
});

export const TASK_TRANSITIONS = Object.freeze({
  created: new Set(["dispatched", "cancelled"]),
  dispatched: new Set(["accepted", "running", "failed", "cancelled"]),
  accepted: new Set(["running", "blocked", "failed", "cancelled"]),
  running: new Set(["blocked", "review", "failed", "cancelled"]),
  blocked: new Set(["running", "dispatched", "failed", "cancelled"]),
  review: new Set(["completed", "dispatched", "failed", "cancelled"]),
  completed: new Set(),
  failed: new Set(["dispatched", "cancelled"]),
  cancelled: new Set()
});

export const SESSION_TRANSITIONS = Object.freeze({
  planned: new Set(["starting", "archived"]),
  starting: new Set(["idle", "active", "failed", "archived"]),
  idle: new Set(["active", "completed", "failed", "archived"]),
  active: new Set(["idle", "blocked", "completed", "failed", "archived"]),
  blocked: new Set(["active", "failed", "archived"]),
  completed: new Set(["archived"]),
  failed: new Set(["starting", "archived"]),
  archived: new Set()
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
    session: SESSION_TRANSITIONS
  }[kind];
  if (!table || !table[from] || !table[from].has(to)) {
    throw new TransitionError(kind, from, to);
  }
}

export function transition(entity, kind, to, now = new Date().toISOString()) {
  assertTransition(kind, entity.status, to);
  entity.status = to;
  entity.updatedAt = now;
  return entity;
}
