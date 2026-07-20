#!/usr/bin/env node

import os from "node:os";
import path from "node:path";
import { ControlPlane } from "./lib/control-plane.mjs";
import { Ledger } from "./lib/ledger.mjs";
import { startDashboardServer } from "./lib/dashboard-server.mjs";

const [command = "help", ...args] = process.argv.slice(2);
const options = parseOptions(args);
const ledgerPath =
  options.state ||
  process.env.CODEX_SESSION_CONTROL_PLANE_LEDGER ||
  path.join(os.homedir(), ".codex", "session-control-plane", "ledger.json");
const controlPlane = new ControlPlane({ ledger: new Ledger(ledgerPath) });

try {
  if (command === "preflight") {
    print(await controlPlane.preflight({ cwd: options.cwd || process.cwd(), connect: options.connect === "true" }));
  } else if (command === "snapshot") {
    print(await controlPlane.snapshot({ runId: options.run || null }));
  } else if (command === "demo") {
    print(await seedDemo(controlPlane, options.cwd || process.cwd()));
  } else if (command === "smoke") {
    const state = options.state || path.join(os.tmpdir(), `codex-control-plane-smoke-${process.pid}.json`);
    const smokePlane = new ControlPlane({ ledger: new Ledger(state) });
    print(await seedDemo(smokePlane, options.cwd || process.cwd()));
  } else if (command === "serve") {
    if (options.demo === "true") await seedDemo(controlPlane, options.cwd || process.cwd());
    const dashboard = await startDashboardServer({
      controlPlane,
      port: Number.parseInt(options.port || "41739", 10)
    });
    process.stdout.write(`${dashboard.url}\n`);
    process.on("SIGINT", async () => {
      await dashboard.close();
      await controlPlane.close();
      process.exit(0);
    });
    await new Promise(() => {});
  } else {
    process.stdout.write(
      [
        "Usage:",
        "  node scripts/control-plane-cli.mjs preflight [--cwd PATH] [--connect true]",
        "  node scripts/control-plane-cli.mjs demo [--state PATH] [--cwd PATH]",
        "  node scripts/control-plane-cli.mjs smoke [--cwd PATH]",
        "  node scripts/control-plane-cli.mjs snapshot [--state PATH] [--run ID]",
        "  node scripts/control-plane-cli.mjs serve [--state PATH] [--port 41739] [--demo true]",
        ""
      ].join("\n")
    );
  }
} finally {
  if (command !== "serve") await controlPlane.close();
}

async function seedDemo(plane, cwd) {
  const run = await plane.createRun({
    objective: "Demonstrate controlled multi-session planning, verification, and acceptance",
    executionMode: "dry-run",
    maxRoundTrips: 4
  });
  const design = await plane.addTask({
    runId: run.id,
    title: "Inspect session topology",
    prompt: "Inspect the requested topology and return a bounded design.",
    role: "architecture",
    cwd,
    model: "gpt-5.6-terra",
    effort: "medium",
    sandbox: "read-only"
  });
  const review = await plane.addTask({
    runId: run.id,
    title: "Verify control contract",
    prompt: "Verify state transitions, ownership, and stop conditions.",
    role: "review",
    cwd,
    model: "gpt-5.6-sol",
    effort: "high",
    sandbox: "read-only"
  });
  await plane.simulateTask({
    runId: run.id,
    taskId: design.id,
    summary: "Topology is bounded and has a single integration owner.",
    artifacts: ["schemas/run.schema.json"],
    verification: ["dry-run topology check passed"]
  });
  await plane.simulateTask({
    runId: run.id,
    taskId: review.id,
    summary: "State transitions and stop conditions are explicit.",
    artifacts: ["scripts/lib/state-machine.mjs"],
    verification: ["state-machine dry-run passed"]
  });
  await plane.decideTask({ runId: run.id, taskId: design.id, decision: "accept" });
  await plane.decideTask({ runId: run.id, taskId: review.id, decision: "accept" });
  return plane.snapshot({ runId: run.id });
}

function parseOptions(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) continue;
    result[value.slice(2)] = values[index + 1] && !values[index + 1].startsWith("--")
      ? values[++index]
      : "true";
  }
  return result;
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
