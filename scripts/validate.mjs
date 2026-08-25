#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NATIVE_THREAD_TOOLS } from "./lib/native-thread-tools.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requiredFiles = [
  "AGENTS.md",
  ".codex-plugin/plugin.json",
  ".github/workflows/ci.yml",
  ".mcp.json",
  "LICENSE",
  "README.md",
  "creator-contract.json",
  "docs/INSTALL_FOR_CODEX.md",
  "package.json",
  "skills/control-codex-tasks/SKILL.md",
  "skills/control-codex-tasks/agents/openai.yaml",
  "scripts/control-plane-mcp.mjs",
  "scripts/control-plane-cli.mjs",
  "scripts/install-plugin.mjs",
  "scripts/lib/control-plane.mjs",
  "scripts/lib/dashboard-server.mjs",
  "scripts/lib/git-settlement.mjs",
  "scripts/lib/ledger.mjs",
  "scripts/lib/native-thread-tools.mjs",
  "scripts/lib/plugin-installer.mjs",
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
  "tests/installer.test.mjs",
  "tests/mcp.test.mjs",
  "tests/settlement.test.mjs",
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
const agents = await read("AGENTS.md");
const installContract = await read("docs/INSTALL_FOR_CODEX.md");
const skill = await read("skills/control-codex-tasks/SKILL.md");
const openai = await read("skills/control-codex-tasks/agents/openai.yaml");
const readme = await read("README.md");
const nativeSource = await read("scripts/lib/native-thread-tools.mjs");
const mcpSource = await read("scripts/control-plane-mcp.mjs");
const installerSource = `${await read("scripts/install-plugin.mjs")}\n${await read("scripts/lib/plugin-installer.mjs")}`;
const gitignore = await read(".gitignore");
const uiSource = `${await read("assets/dashboard/index.html")}\n${await read("assets/dashboard/app.js")}\n${await read("assets/dashboard/macos-local-html.css")}`;

assert.equal(plugin.name, "codex-task-control-plane");
assert.match(plugin.version, /^0\.2\.0\+codex\.[0-9A-Za-z.-]+$/);
assert.equal(packageJson.version, "0.2.0");
assert.equal(plugin.skills, "./skills/");
assert.equal(plugin.mcpServers, "./.mcp.json");
assert.equal(packageJson.license, "MIT");
assert.equal(plugin.license, "MIT");
assert.equal(plugin.repository, "https://github.com/mlabo-org/codex-task-control-plane");
assert.equal(plugin.homepage, "https://github.com/mlabo-org/codex-task-control-plane#readme");
assert.equal(creator.capability_id, plugin.name);
assert.equal(creator.official_creator, "plugin-creator");
assert.equal(mcp.mcpServers?.codex_task_control_plane?.command, "node");
assert.deepEqual(mcp.mcpServers?.codex_task_control_plane?.args, ["./scripts/control-plane-mcp.mjs"]);

assert.match(skill, /^---\nname: control-codex-tasks\ndescription:/);
assert.ok(skill.split("\n").length <= 500, "SKILL.md must remain concise enough for routing context");
assert.match(openai, /display_name: "Codex Task Control Plane"/);
assert.match(openai, /value: "codex_task_control_plane"/);
assert.match(openai, /\$control-codex-tasks/);
assert.match(readme, /## English/);
assert.match(readme, /## 日本語/);
assert.match(readme, /MIT License/);
assert.match(readme, /## Install with Codex \/ Codexでインストール/);
assert.match(readme, /^npm run plugin:install:check$/m);
assert.match(readme, /^npm run plugin:install$/m);
assert.match(readme, /docs\/INSTALL_FOR_CODEX\.md/);
assert.match(agents, /only for routing an explicit request to install/);
assert.match(agents, /Outside the explicit installation trigger, do not run the installer/);
assert.match(agents, /docs\/INSTALL_FOR_CODEX\.md/);
assert.match(installContract, /npm run check/);
assert.match(installContract, /npm run plugin:install:check/);
assert.match(installContract, /npm run plugin:install/);
assert.match(installContract, /Do not run `codex plugin marketplace add`/);
assert.equal(packageJson.scripts["plugin:install:check"], "node scripts/install-plugin.mjs --check");
assert.equal(packageJson.scripts["plugin:install"], "node scripts/install-plugin.mjs --install");
assert.match(gitignore, /^\.CAO\/$/m);
assert.match(gitignore, /^\.coding-agents\/$/m);
assert.match(installerSource, /execFileAsync\("codex", args/);
assert.match(installerSource, /\[\s*"plugin",\s*"add"/);
assert.match(installerSource, /PLUGIN_SOURCE_PATH = `\.\/plugins\/\$\{PLUGIN_NAME\}`/);
assert.doesNotMatch(installerSource, /\.codex[\\/]plugins[\\/]cache/);

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
  "control_plane_reconcile",
  "control_plane_integrate_settlement",
  "control_plane_cleanup_settlement",
  "control_plane_dashboard_start"
]) {
  assert.match(mcpSource, new RegExp(escapeRegex(tool)), `${tool} must be exposed by MCP`);
}

assert.doesNotMatch(nativeSource, /node:child_process|\bspawn\s*\(|\bexecFile\s*\(/);
assert.match(nativeSource, /stateControl === "codex-activity-oversight"/);
assert.match(nativeSource, /environment === "worktree"/);
assert.match(nativeSource, /environmentValue/);
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
assert.doesNotMatch(
  activeSource,
  /\/Users\/[A-Za-z0-9._-]+\//,
  "Public source must not contain a maintainer-specific absolute home path"
);
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

process.stdout.write(`task-control-plane source validation passed (${NATIVE_THREAD_TOOLS.length} native tools)\n`);

function read(relative) {
  return fs.readFile(path.join(root, relative), "utf8");
}

async function readJson(relative) {
  return JSON.parse(await read(relative));
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
