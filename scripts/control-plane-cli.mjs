#!/usr/bin/env node

import os from "node:os";
import path from "node:path";
import { ControlPlane } from "./lib/control-plane.mjs";
import { Ledger } from "./lib/ledger.mjs";
import { NATIVE_THREAD_TOOLS } from "./lib/native-thread-tools.mjs";
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
    print(
      await controlPlane.preflight({
        cwd: options.cwd || process.cwd(),
        availableTools:
          options.tools === "all"
            ? [...NATIVE_THREAD_TOOLS]
            : String(options.tools || "")
                .split(",")
                .map((value) => value.trim())
                .filter(Boolean)
      })
    );
  } else if (command === "snapshot") {
    print(await controlPlane.snapshot({ runId: options.run || null }));
  } else if (command === "demo") {
    print(await seedDemo(controlPlane, options.cwd || process.cwd()));
  } else if (command === "smoke") {
    const smokePath =
      options.state || path.join(os.tmpdir(), `codex-thread-orchestration-smoke-${process.pid}.json`);
    const smokePlane = new ControlPlane({ ledger: new Ledger(smokePath) });
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
        "Codex Thread Orchestration Control Plane",
        "",
        "Usage:",
        "  node scripts/control-plane-cli.mjs preflight --cwd PATH --tools all",
        "  node scripts/control-plane-cli.mjs demo [--state PATH] [--cwd PATH]",
        "  node scripts/control-plane-cli.mjs smoke [--cwd PATH]",
        "  node scripts/control-plane-cli.mjs snapshot [--state PATH] [--run ID]",
        "  node scripts/control-plane-cli.mjs serve [--state PATH] [--port 41739] [--demo true]",
        "",
        "The CLI manages ledger state only. Native Codex task tools are invoked by the active Codex controller.",
        ""
      ].join("\n")
    );
  }
} finally {
  if (command !== "serve") await controlPlane.close();
}

async function seedDemo(plane, cwd) {
  const run = await plane.createRun({
    objective: "Demonstrate visible Codex task orchestration with durable control state",
    executionMode: "dry-run",
    maxRoundTrips: 4
  });
  const architecture = await plane.addTask({
    runId: run.id,
    title: "Inspect task topology",
    prompt: "Return a bounded topology and ownership map.",
    role: "architecture",
    cwd,
    workerMode: "direct",
    acceptanceCriteria: ["Native task ownership and controller ownership are distinct"]
  });
  const implementation = await plane.addTask({
    runId: run.id,
    title: "Implement one isolated workstream",
    prompt: "Implement the assigned slice and return artifacts plus primary-path evidence.",
    role: "implementation",
    cwd,
    workerMode: "coding-agent-orchestrator",
    codingAgentOrchestratorScope: "one isolated implementation workstream",
    acceptanceCriteria: ["The first handoff is complete for the declared slice"]
  });
  await plane.simulateTask({
    runId: run.id,
    taskId: architecture.id,
    summary: "Topology assigns visible task runtime to native tools and state to the ledger.",
    artifacts: ["scripts/lib/native-thread-tools.mjs"],
    verification: ["dry-run ownership contract passed"]
  });
  await plane.simulateTask({
    runId: run.id,
    taskId: implementation.id,
    summary: "Coding Agent Orchestrator remains scoped inside its visible worker task.",
    artifacts: ["skills/control-codex-sessions/SKILL.md"],
    verification: ["dry-run worker-boundary contract passed"]
  });
  await plane.decideTask({ runId: run.id, taskId: architecture.id, decision: "accept" });
  await plane.decideTask({ runId: run.id, taskId: implementation.id, decision: "accept" });
  return plane.snapshot({ runId: run.id });
}

function parseOptions(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) continue;
    result[value.slice(2)] =
      values[index + 1] && !values[index + 1].startsWith("--")
        ? values[++index]
        : "true";
  }
  return result;
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
