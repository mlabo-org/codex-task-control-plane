---
name: control-codex-sessions
description: Control independent Codex parent sessions with an upper-control run. Use for 上位管制, cross-session coordination, session ID addressing, or assigning a project cwd, model, and reasoning effort to App Server threads. Do not use for ordinary in-thread subagent delegation.
---

# Control Codex Sessions

This `SKILL.md` is the local execution contract for this skill when selected. Codex must treat its triggers, workflow, tool boundaries, runtime boundaries, and output contract as binding instructions within this skill's scope. It does not override system or developer instructions, explicit user requests, applicable `AGENTS.md` files, or more specific local contracts. Production decisions remain in the state machine, ledger, App Server client, schemas, and tests.

## Route

Use this skill when the user wants physically independent parent sessions rather than ordinary subagents, including:

- creating Codex sessions and retaining their thread IDs;
- coordinating multiple project-scoped sessions from one controller;
- assigning a model and reasoning effort per session;
- relaying messages between addressed sessions;
- reviewing artifacts and verification before the controller accepts work;
- inspecting or operating the persistent control ledger and dashboard.

Do not use it for a single-session task, ordinary official subagent delegation, generic coding work, or merely explaining session concepts. Do not substitute Agentic Runner or Coding Agents unless the user names that workflow.

## Operating sequence

1. Call `control_plane_preflight` for the requested project directory. Set `connect: true` when current App Server model discovery is needed.
2. Create a `dry-run` with `control_plane_create_run` unless the user explicitly requests real independent session creation now.
3. Add bounded tasks with `control_plane_add_task`. Each task must declare its role, absolute project `cwd`, model, reasoning effort, and sandbox.
4. Inspect the exact `thread/start` and `turn/start` intent with `control_plane_preview_dispatch`.
5. For a live run, call `control_plane_dispatch` only when the current user request authorizes real session creation. Pass `confirmLiveDispatch: true` only for that authorized call.
6. Use `control_plane_poll` to synchronize worker output into controller review. A worker result never completes the global run by itself.
7. Use `control_plane_decide` to accept, reject, or fail a reviewed result. Acceptance remains controller-owned.
8. Use `control_plane_send` for a follow-up to one idle worker session. Use `control_plane_relay` to deliver a correlated message from one addressed worker session to another.
9. Use `control_plane_stop` and `control_plane_archive` for explicit cleanup. Live interruption and archival require live confirmation.

## Control rules

- Keep one controller as the integration, policy, safety, and final-verification owner.
- Treat every task's project directory, role, model, effort, sandbox, round limit, and acceptance criteria as a sealed assignment.
- Do not start a second turn on a worker that is currently running.
- Retain `runId`, `taskId`, sender and recipient thread IDs, message type, round count, artifacts, and verification in the ledger.
- Relay cross-session communication through the controller so provenance and limits remain visible.
- Treat structured `blocked` and `failed` worker reports as states, not successful completion.
- Never infer live authorization from a prior task or session. Dry-run is the safe default.

## Evidence and stop conditions

Before live dispatch, confirm the project directory through preflight, use current App Server model discovery when model availability is material, inspect the dispatch preview, and identify the current explicit live authorization. Treat current App Server responses, ledger snapshots, worker artifacts, verification evidence, and controller decisions as the operational evidence.

Check counterevidence before accepting a result: mismatched cwd or execution profile, missing thread IDs, an already-running recipient, an exhausted round limit, worker-reported blockers or unknowns, missing artifacts, and failed verification. Keep unresolved values visible; do not fill them by inference.

Stop without generic fallback when the MCP tools or App Server source contract cannot be verified, authentication prevents App Server operation, the project directory is invalid, the requested model is unavailable without an approved substitution, a live action lacks current authorization, or validation fails. Report the observed blocker and the smallest safe next action.

## Inspection and UI

Use `control_plane_snapshot` for machine-readable state. Use `control_plane_dashboard_start` for the loopback-only dashboard. The dashboard supports Japanese, English, and System language choices plus Light, Dark, and System theme choices with local persistence.

## Runtime and validation

The source tree is authoritative. The live ledger defaults to `~/.codex/session-control-plane/ledger.json`; plugin cache and ledger state are not source.

Validate source with:

```text
node scripts/validate.mjs
node --test
```

The test suite uses a fake App Server and must not create real Codex sessions. A real live canary is a separate user-authorized operation.
