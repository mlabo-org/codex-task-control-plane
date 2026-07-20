import assert from "node:assert/strict";
import test from "node:test";
import {
  assertTransition,
  transition,
  TransitionError
} from "../scripts/lib/state-machine.mjs";

test("task lifecycle accepts the controlled happy path", () => {
  const task = { status: "created", updatedAt: null };
  transition(task, "task", "dispatched", "2026-01-01T00:00:00.000Z");
  transition(task, "task", "running", "2026-01-01T00:00:01.000Z");
  transition(task, "task", "review", "2026-01-01T00:00:02.000Z");
  transition(task, "task", "completed", "2026-01-01T00:00:03.000Z");
  assert.equal(task.status, "completed");
  assert.equal(task.updatedAt, "2026-01-01T00:00:03.000Z");
});

test("controller cannot complete a running task without review", () => {
  assert.throws(
    () => assertTransition("task", "running", "completed"),
    (error) =>
      error instanceof TransitionError &&
      error.code === "INVALID_TRANSITION" &&
      error.from === "running" &&
      error.to === "completed"
  );
});

test("failed and reviewed work may be deliberately redispatched", () => {
  assert.doesNotThrow(() => assertTransition("task", "failed", "dispatched"));
  assert.doesNotThrow(() => assertTransition("task", "review", "dispatched"));
});

test("completed sessions can only be archived", () => {
  assert.doesNotThrow(() => assertTransition("session", "completed", "archived"));
  assert.throws(() => assertTransition("session", "completed", "active"), TransitionError);
});
