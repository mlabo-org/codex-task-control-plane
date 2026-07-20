import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ControlPlane } from "../scripts/lib/control-plane.mjs";
import { startDashboardServer } from "../scripts/lib/dashboard-server.mjs";
import { Ledger } from "../scripts/lib/ledger.mjs";

test("dashboard is loopback-only, token-guarded, and exposes language/theme controls", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "control-plane-dashboard-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const plane = new ControlPlane({ ledger: new Ledger(path.join(root, "ledger.json")) });
  const dashboard = await startDashboardServer({ controlPlane: plane, port: 0 });
  context.after(() => dashboard.close());

  assert.match(dashboard.url, /^http:\/\/127\.0\.0\.1:/);
  const health = await fetch(new URL("/api/health", dashboard.url)).then((response) =>
    response.json()
  );
  assert.equal(health.ok, true);

  const html = await fetch(dashboard.url).then((response) => response.text());
  assert.match(html, /id="language-select"/);
  assert.match(html, /value="system"/);
  assert.match(html, /日本語/);
  assert.match(html, /English/);
  assert.match(html, /id="theme-select"/);
  assert.match(html, /value="light"/);
  assert.match(html, /value="dark"/);
  assert.doesNotMatch(html, /__CONTROL_PLANE_TOKEN__/);

  const rejected = await fetch(new URL("/api/action", dashboard.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: "createRun",
      input: { objective: "must fail without token" }
    })
  });
  assert.equal(rejected.status, 403);

  const created = await fetch(new URL("/api/action", dashboard.url), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-control-plane-token": dashboard.token
    },
    body: JSON.stringify({
      action: "createRun",
      input: { objective: "dashboard test", executionMode: "dry-run" }
    })
  }).then((response) => response.json());
  assert.equal(created.ok, true);
  assert.equal(created.result.objective, "dashboard test");
});

test("dashboard refuses non-loopback binding", async () => {
  const plane = new ControlPlane();
  await assert.rejects(
    startDashboardServer({ controlPlane: plane, host: "0.0.0.0", port: 0 }),
    /loopback/
  );
});
