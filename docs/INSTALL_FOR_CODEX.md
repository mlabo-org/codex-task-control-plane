# Install Codex Thread Orchestration with Codex

This file is the installation execution contract delegated by the repository root `AGENTS.md`. Apply it only after the current user explicitly asks to install, set up, or activate this plugin.

## Goal and boundaries

Install the authoritative `codex-thread-orchestration` source through the standard personal marketplace and the official Codex CLI. Preserve unrelated user configuration. Never edit an installed plugin cache directly.

The repository must be installable without maintainer-specific absolute paths, private files, remembered setup, or hidden manual steps.

## Canonical source

Resolve the current user's home directory from the operating system. The canonical personal-plugin source is:

```text
<user-home>/plugins/codex-thread-orchestration
```

If the repository is not already at that location:

1. Resolve its Git origin.
2. If the canonical destination does not exist, clone that origin into the canonical destination.
3. If the destination exists, inspect it before acting. Continue only when it is this repository and no unresolved user change would be overwritten.
4. Stop and report the exact collision when the destination is a different repository, has ambiguous provenance, or cannot be preserved. Do not delete, move, reset, or overwrite it.

Run all remaining commands from the canonical source location. Do not substitute a maintainer path or write inside `~/.codex/plugins/cache/`.

## Preconditions

Confirm all of the following before mutation:

- Git is available.
- Node.js 22 or later is available.
- `codex` exposes `codex plugin add`, `codex plugin list`, and `codex plugin marketplace list`.
- `.codex-plugin/plugin.json` names `codex-thread-orchestration` and has a version.
- The current request authorizes local plugin installation and the required personal-marketplace write.

If one is unavailable, stop and report the exact missing prerequisite. Do not invent an alternate cache or configuration route.

## Fixed installation sequence

1. Read `.codex-plugin/plugin.json`, `.mcp.json`, this file, and the installation section of `README.md`.
2. Run `npm run check` once. Stop on failure and report the failing command; do not install a failed source candidate.
3. Run `npm run plugin:install:check`. This is read-only and prints the source, marketplace, planned write, and install selector as JSON.
4. Confirm that the JSON status is `ready`. A source-path collision, duplicate plugin entry, malformed marketplace, conflicting plugin source, or marketplace-name collision is a blocker.
5. Run `npm run plugin:install` once. The installer may add only this plugin's entry to `~/.agents/plugins/marketplace.json`, preserves unrelated entries, invokes `codex plugin add`, and verifies the installed name and version through `codex plugin list --json`.
6. Tell the user to restart Codex and start a new task so the manifest, skill, and MCP server are loaded. Do not claim the current task hot-reloaded the plugin.
7. In the new task, use the README's dry-run verification prompt. Do not create a real visible task unless the user separately and explicitly requests one.

Do not hand-edit the personal marketplace when the bundled installer can safely perform the same operation. Do not run `codex plugin marketplace add` for the default personal marketplace file.

## Completion report

Report:

- canonical source path;
- manifest plugin name and version;
- marketplace file and marketplace name;
- whether the entry was created or already matched;
- exact `codex plugin add` selector;
- installed version reported by `codex plugin list --json`;
- required restart and fresh-task verification;
- any uncompleted step or blocker.
