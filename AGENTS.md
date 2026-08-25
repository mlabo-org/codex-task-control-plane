# Codex Reader Installation Router

This file is the local `AGENTS.md` SSOT only for routing an explicit request to install, set up, or activate this repository as a Codex plugin. Higher-priority system, developer, user, and ancestor instructions still apply.

## Narrow scope

- Trigger this contract only when the current user explicitly asks to install, set up, or activate `codex-task-control-plane` from this repository.
- A request to inspect, explain, review, develop, test, document, or use the repository does not trigger installation.
- Outside the explicit installation trigger, do not run the installer, edit a marketplace, install or refresh a plugin, change Codex configuration, or add installation-specific process. Follow the current request and other applicable instructions normally.
- This file does not govern the installed plugin's runtime behavior. The plugin manifest, bundled skill, MCP source, and executable source own that behavior.

## Installation route

When the trigger applies:

1. Read `docs/INSTALL_FOR_CODEX.md` completely. That file is the delegated execution contract for this one installation decision.
2. Follow its preflight, canonical-source, mutation, verification, and reporting sequence exactly.
3. Stop on any blocker it defines. Do not replace its official-CLI route with cache editing or maintainer-specific paths.

When materially editing this router, apply an available AGENTS contract clarifier before commit. This maintenance condition does not apply to ordinary repository work or plugin installation.
