import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Ledger } from "../scripts/lib/ledger.mjs";

test("ledger serializes concurrent updates and persists atomically", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "control-plane-ledger-"));
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
  assert.equal(snapshot.revision, 12);
  assert.equal(Object.keys(snapshot.runs).length, 12);
  assert.equal((await fs.stat(filePath)).mode & 0o777, 0o600);
  assert.deepEqual(
    (await fs.readdir(path.dirname(filePath))).filter((name) => name.endsWith(".tmp")),
    []
  );
});
