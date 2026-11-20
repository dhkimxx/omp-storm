---
name: storm
description: OMP Storm team roles, the storm tool, and Storm run rules. Use when a message carries a <storm-request> or <storm-run> section, when delegating with the task tool or eval agent() in a project with a Storm team (.omp/storm/config.json), or when Storm blocks a spawn.
---

# OMP Storm

Storm gives three role agents the models the user approved and enforces them when they are spawned.

| Agent | Use for |
|---|---|
| `storm-explorer` | Read-only research: scope files, call sites, and contracts |
| `storm-implementer` | The code change itself, with verification |
| `storm-reviewer` | Independent read-only review of a change |

- Spawn these roles by agent name. Do not pass `model` for them; Storm replaces it with the approved models.
- If Storm blocks a spawn, stop and tell the user the reason and the command it names (`/storm` or `/storm review`). Do not retry with another agent to get around the block.
- Reuse finished subagents: follow-ups in the same area (fixing review findings, a second pass) go to the finished agent with `write agent://<id>` (or the eval handle's `.send()`) instead of a new spawn. When unsure whether its cache is still warm or its context too big, call the `storm` tool's `agents` action first.
- Never edit `.omp/storm/` or Storm's approval records. Team changes go through the `storm` tool or `/storm` and need the user's approval.

## `<storm-request>`: a `/storm` request in natural language

Handle it with the `storm` tool, then answer briefly in the user's language.

| The user wants | `storm` action |
|---|---|
| Team, run, trial or quota status | `status` |
| Newer, better or cheaper models than the current ones | `models` |
| A different optimization priority | `priority` |
| More or fewer workers for a role | `workers` |
| Another model for a role | `reselect` (pass `model` only if the user named one) |
| A provider ran out of quota | `quota` |
| To try a model on part of a role's work | `trial` |
| A spending limit per run | `budget` |
| Which subagents to reuse, start fresh or let go | `agents` |
| Work done (implement, analyze, fix…) | `run` with the request as `task` |

- Write actions only propose. The user approves in a dialog; report the tool's outcome as is and never claim a change was applied unless the tool said so.
- After `run`, end your reply at once without doing the work: Storm starts the run with the team contract right after your turn.
- If the user asks about models missing from the catalog, you may research them on the web, citing sources and stating low confidence.

## `<storm-run>`: a Storm run

The section lists the approved team and the rules for this run. Follow it: delegate through the listed `storm-*` agents, keep within the stated concurrency, and stop spawning when Storm reports the budget is used up.
