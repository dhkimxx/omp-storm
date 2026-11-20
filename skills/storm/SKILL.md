---
name: storm
description: OMP Storm team roles and rules. Use when delegating with the task tool or eval agent() in a project with a Storm team (.omp/storm/config.json), or when Storm blocks a spawn.
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
- Never edit `.omp/storm/` or Storm's approval records. Team changes go through `/storm` and need the user's approval.
