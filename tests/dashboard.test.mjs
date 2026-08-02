import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ControlPlane } from "../scripts/lib/control-plane.mjs";
import { startDashboardServer } from "../scripts/lib/dashboard-server.mjs";
import { Ledger } from "../scripts/lib/ledger.mjs";

test("dashboard is loopback-only, token-guarded, bilingual, and intent-only", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "thread-control-dashboard-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const plane = new ControlPlane({ ledger: new Ledger(path.join(root, "ledger.json")) });
  const dashboard = await startDashboardServer({ controlPlane: plane, port: 0 });
  context.after(() => dashboard.close());

  assert.match(dashboard.url, /^http:\/\/127\.0\.0\.1:/);
  const healthResponse = await fetch(new URL("/api/health", dashboard.url));
  const health = await healthResponse.json();
  assert.equal(health.ok, true);
  assert.equal(health.role, "ledger-and-intent-dashboard");
  assert.match(healthResponse.headers.get("x-content-type-options"), /nosniff/);

  const htmlResponse = await fetch(dashboard.url);
  const html = await htmlResponse.text();
  assert.match(htmlResponse.headers.get("content-security-policy"), /default-src 'self'/);
  assert.match(html, /id="language-select"/);
  assert.match(html, /value="system"/);
  assert.match(html, /日本語/);
  assert.match(html, /English/);
  assert.match(html, /id="theme-select"/);
  assert.match(html, /value="light"/);
  assert.match(html, /value="dark"/);
  assert.doesNotMatch(html, /__CONTROL_PLANE_TOKEN__/);

  const rejected = await postAction(dashboard.url, null, "createRun", {
    objective: "must fail without token"
  });
  assert.equal(rejected.response.status, 403);

  const created = await postAction(dashboard.url, dashboard.token, "createRun", {
    objective: "dashboard test",
    executionMode: "dry-run"
  });
  assert.equal(created.body.ok, true);
  const task = await postAction(dashboard.url, dashboard.token, "addTask", {
    runId: created.body.result.id,
    title: "Plan",
    prompt: "Prepare only.",
    role: "planner",
    cwd: root
  });
  const prepared = await postAction(dashboard.url, dashboard.token, "prepareDispatch", {
    runId: created.body.result.id,
    taskId: task.body.result.id
  });
  assert.equal(prepared.body.result.nextCall.tool, "codex_app__list_projects");

  const forbiddenRuntimeAction = await postAction(
    dashboard.url,
    dashboard.token,
    "dispatch",
    {}
  );
  assert.equal(forbiddenRuntimeAction.response.status, 400);
  assert.equal(forbiddenRuntimeAction.body.error.code, "UNKNOWN_ACTION");
});

test("dashboard refuses non-loopback binding", async () => {
  const plane = new ControlPlane();
  await assert.rejects(
    startDashboardServer({ controlPlane: plane, host: "0.0.0.0", port: 0 }),
    /loopback/
  );
});

async function postAction(url, token, action, input) {
  const headers = { "content-type": "application/json" };
  if (token) headers["x-control-plane-token"] = token;
  const response = await fetch(new URL("/api/action", url), {
    method: "POST",
    headers,
    body: JSON.stringify({ action, input })
  });
  return { response, body: await response.json() };
}
