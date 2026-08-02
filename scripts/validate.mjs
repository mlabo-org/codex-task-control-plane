#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NATIVE_THREAD_TOOLS } from "./lib/native-thread-tools.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requiredFiles = [
  ".codex-plugin/plugin.json",
  ".github/workflows/ci.yml",
  ".mcp.json",
  "LICENSE",
  "README.md",
  "creator-contract.json",
  "package.json",
  "skills/control-codex-sessions/SKILL.md",
  "skills/control-codex-sessions/agents/openai.yaml",
  "scripts/control-plane-mcp.mjs",
  "scripts/control-plane-cli.mjs",
  "scripts/lib/control-plane.mjs",
  "scripts/lib/dashboard-server.mjs",
  "scripts/lib/ledger.mjs",
  "scripts/lib/native-thread-tools.mjs",
  "scripts/lib/state-machine.mjs",
  "schemas/run.schema.json",
  "schemas/message.schema.json",
  "assets/dashboard/index.html",
  "assets/dashboard/app.js",
  "assets/dashboard/control-plane.css",
  "assets/dashboard/macos-local-html.css",
  "tests/control-plane.test.mjs",
  "tests/native-thread-tools.test.mjs",
  "tests/dashboard.test.mjs",
  "tests/ledger.test.mjs",
  "tests/mcp.test.mjs",
  "tests/state-machine.test.mjs",
  "tests/ui-contract.test.mjs"
];

for (const relative of requiredFiles) {
  const stat = await fs.stat(path.join(root, relative));
  assert.ok(stat.isFile(), `${relative} must be a file`);
}

for (const relative of [
  ".codex-plugin/plugin.json",
  ".mcp.json",
  "creator-contract.json",
  "package.json",
  "schemas/run.schema.json",
  "schemas/message.schema.json"
]) {
  JSON.parse(await fs.readFile(path.join(root, relative), "utf8"));
}

const plugin = await readJson(".codex-plugin/plugin.json");
const packageJson = await readJson("package.json");
const creator = await readJson("creator-contract.json");
const mcp = await readJson(".mcp.json");
const skill = await read("skills/control-codex-sessions/SKILL.md");
const openai = await read("skills/control-codex-sessions/agents/openai.yaml");
const readme = await read("README.md");
const nativeSource = await read("scripts/lib/native-thread-tools.mjs");
const mcpSource = await read("scripts/control-plane-mcp.mjs");
const uiSource = `${await read("assets/dashboard/index.html")}\n${await read("assets/dashboard/app.js")}\n${await read("assets/dashboard/macos-local-html.css")}`;

assert.equal(plugin.name, "codex-session-control-plane");
assert.equal(plugin.version, "0.2.0");
assert.equal(plugin.version, packageJson.version);
assert.equal(plugin.skills, "./skills/");
assert.equal(plugin.mcpServers, "./.mcp.json");
assert.equal(packageJson.license, "MIT");
assert.equal(creator.capability_id, plugin.name);
assert.equal(creator.official_creator, "plugin-creator");
assert.equal(mcp.mcpServers?.codex_session_control_plane?.command, "node");
assert.deepEqual(mcp.mcpServers?.codex_session_control_plane?.args, ["./scripts/control-plane-mcp.mjs"]);

assert.match(skill, /^---\nname: control-codex-sessions\ndescription:/);
assert.ok(skill.split("\n").length <= 500, "SKILL.md must remain concise enough for routing context");
assert.match(openai, /display_name: "Codex Thread Orchestration"/);
assert.match(openai, /value: "codex_session_control_plane"/);
assert.match(openai, /\$control-codex-sessions/);
assert.match(readme, /## English/);
assert.match(readme, /## 日本語/);
assert.match(readme, /MIT License/);

for (const tool of NATIVE_THREAD_TOOLS) {
  assert.match(nativeSource, new RegExp(escapeRegex(tool)), `${tool} must be executable-contract owned`);
  assert.match(skill, new RegExp(escapeRegex(tool)), `${tool} must be documented by the skill`);
  assert.match(readme, new RegExp(escapeRegex(tool)), `${tool} must be documented in README`);
}

for (const tool of [
  "control_plane_preflight",
  "control_plane_create_run",
  "control_plane_add_task",
  "control_plane_prepare_dispatch",
  "control_plane_resolve_project",
  "control_plane_record_thread_launch",
  "control_plane_prepare_operation",
  "control_plane_complete_operation",
  "control_plane_decide",
  "control_plane_request_cancel",
  "control_plane_simulate_task",
  "control_plane_snapshot",
  "control_plane_dashboard_start"
]) {
  assert.match(mcpSource, new RegExp(escapeRegex(tool)), `${tool} must be exposed by MCP`);
}

assert.doesNotMatch(nativeSource, /node:child_process|\bspawn\s*\(|\bexecFile\s*\(/);
assert.match(nativeSource, /workerMode === "coding-agents"/);
assert.match(nativeSource, /environment === "auto"/);
assert.match(nativeSource, /isGitRepository \? "worktree" : "local"/);
assert.match(uiSource, /control-plane-language/);
assert.match(uiSource, /control-plane-theme/);
assert.match(uiSource, /Japanese|日本語/);
assert.match(uiSource, /English/);
assert.match(uiSource, /Light/);
assert.match(uiSource, /Dark/);
assert.match(uiSource, /System/);

const activeSource = (
  await Promise.all(requiredFiles.map((relative) => fs.readFile(path.join(root, relative), "utf8")))
).join("\n");
assert.doesNotMatch(activeSource, /\bTODO\b|\[TODO:/, "Scaffold placeholders must be removed");
const supersededTerms = [
  ["app", "server", "client"].join("-"),
  ["app", "server"].join("-"),
  ["thread", "start"].join("/"),
  ["turn", "start"].join("/"),
  ["confirm", "Live", "Dispatch"].join(""),
  `control_plane_${["preview", "dispatch"].join("_")}`,
  `control_plane_${"dispatch"}`,
  `control_plane_${"poll"}`,
  `control_plane_${"relay"}`,
  `control_plane_${"stop"}`,
  `control_plane_${"archive"}`
];
for (const term of supersededTerms) {
  assert.equal(
    activeSource.includes(term),
    false,
    `Superseded contract must be physically absent: ${term}`
  );
}

process.stdout.write(`thread-orchestration source validation passed (${NATIVE_THREAD_TOOLS.length} native tools)\n`);

function read(relative) {
  return fs.readFile(path.join(root, relative), "utf8");
}

async function readJson(relative) {
  return JSON.parse(await read(relative));
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
