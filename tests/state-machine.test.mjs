import assert from "node:assert/strict";
import test from "node:test";
import { assertTransition, transition, TransitionError } from "../scripts/lib/state-machine.mjs";

test("visible task lifecycle requires controller review before completion", () => {
  const task = { status: "created", updatedAt: null };
  transition(task, "task", "prepared", "1");
  transition(task, "task", "provisioning", "2");
  transition(task, "task", "running", "3");
  transition(task, "task", "review", "4");
  transition(task, "task", "completed", "5");
  assert.equal(task.status, "completed");
  assert.equal(task.updatedAt, "5");
});

test("a running worker cannot bypass review", () => {
  assert.throws(
    () => assertTransition("task", "running", "completed"),
    (error) => error instanceof TransitionError && error.code === "INVALID_TRANSITION"
  );
});

test("thread, handoff, archive, and operation paths are explicit", () => {
  assert.doesNotThrow(() => assertTransition("thread", "active", "handoff"));
  assert.doesNotThrow(() => assertTransition("thread", "handoff", "idle"));
  assert.doesNotThrow(() => assertTransition("thread", "completed", "archived"));
  assert.doesNotThrow(() => assertTransition("operation", "prepared", "pending"));
  assert.doesNotThrow(() => assertTransition("operation", "pending", "succeeded"));
  assert.throws(() => assertTransition("operation", "succeeded", "pending"), TransitionError);
});
