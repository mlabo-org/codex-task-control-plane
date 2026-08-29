import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LEDGER_SCHEMA_VERSION, Ledger } from "../scripts/lib/ledger.mjs";

test("v3 ledger serializes concurrent updates and persists atomically", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "thread-control-ledger-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, "state", "ledger.json");
  const ledger = new Ledger(filePath);

  await Promise.all(
    Array.from({ length: 12 }, (_, index) =>
      ledger.update((draft) => {
        draft.runs[`run-${index}`] = { id: `run-${index}` };
      })
    )
  );

  const snapshot = await ledger.read();
  assert.equal(snapshot.schemaVersion, LEDGER_SCHEMA_VERSION);
  assert.equal(snapshot.revision, 12);
  assert.equal(Object.keys(snapshot.runs).length, 12);
  assert.equal((await fs.stat(filePath)).mode & 0o777, 0o600);
  assert.deepEqual(
    (await fs.readdir(path.dirname(filePath))).filter((name) => name.endsWith(".tmp")),
    []
  );
});

test("separate Ledger instances serialize the complete read-mutate-write cycle", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "thread-control-ledger-process-lock-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, "ledger.json");
  const first = new Ledger(filePath);
  const second = new Ledger(filePath);
  const pause = () => new Promise((resolve) => setTimeout(resolve, 40));

  await Promise.all([
    first.update(async (draft) => {
      await pause();
      draft.runs.first = { id: "first" };
    }),
    second.update(async (draft) => {
      await pause();
      draft.runs.second = { id: "second" };
    }),
  ]);

  const snapshot = await first.read();
  assert.equal(snapshot.revision, 2);
  assert.deepEqual(Object.keys(snapshot.runs).sort(), ["first", "second"]);
  assert.deepEqual(await fs.readdir(root), ["ledger.json"]);
});

test("a superseded ledger is rejected instead of silently migrated", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "thread-control-old-ledger-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, "ledger.json");
  await fs.writeFile(
    filePath,
    `${JSON.stringify({ schemaVersion: "superseded-ledger/v1", runs: {} })}\n`,
    { mode: 0o600 }
  );
  await assert.rejects(
    new Ledger(filePath).read(),
    (error) => error.code === "UNSUPPORTED_LEDGER_SCHEMA"
  );
});
