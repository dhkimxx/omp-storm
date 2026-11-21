---
name: storm
description: OMP Storm team roles, the storm tool, and Storm run rules. Use when a message carries a <storm-request>, <storm-setup> or <storm-run> section, when delegating with the task tool or eval agent() in a project with a Storm team (.omp/storm/config.json), or when Storm blocks a spawn.
---

# OMP Storm

Storm gives its role agents the models the user approved and enforces them when they are spawned.

| Agent | Use for |
|---|---|
| `storm-explorer` | Read-only research: scope files, call sites, and contracts |
| `storm-implementer` | The code change itself, with verification |
| `storm-reviewer` | Independent read-only review of a change |
| `storm-quick` | Cheap mechanical edits: renames, version bumps, repeated edits, formatting, data collection |
| `storm-architect` | Read-only planning into disjoint lanes, stuck debugging, and design calls (expensive) |

- Spawn these roles by agent name. Do not pass `model` for them; Storm replaces it with the approved models.
- Never spawn a role the user disabled ("사용 안 함"); the run contract lists those roles.
- If Storm blocks a spawn, stop and tell the user the reason and to type `/storm`. Do not retry with another agent to get around the block.
- Reuse finished subagents: follow-ups in the same area (fixing review findings, a second pass) go to the finished agent with `write agent://<id>` (or the eval handle's `.send()`) instead of a new spawn. When unsure whether its cache is still warm or its context too big, call the `storm` tool's `agents` action first.
- Never edit `.omp/storm/` or Storm's approval records. Team changes go through the `storm` tool or `/storm` and need the user's approval.

## `<storm-request>`: a `/storm` request in natural language

Handle it with the `storm` tool, then answer briefly in the user's language.

| The user wants | `storm` action |
|---|---|
| Team, run, trial or quota status | `status` |
| Newer, better or cheaper models than the current ones | `models` |
| A different optimization priority | `priority` |
| A different worker range for a role | `workers` with `min` and/or `max` |
| Another model for a role | `reselect` (pass `model` only if the user named one) |
| A provider ran out of quota | `quota` |
| To try a model on part of a role's work | `trial` |
| A spending limit per run | `budget` |
| Which subagents to reuse, start fresh or let go | `agents` |
| (During a `<storm-run>`) the run plan, before any spawn or when it changes | `plan` |
| Work done (implement, analyze, fix…) | `run` with the request as `task` |
| Set the team up again, roll back to an earlier approval, reset Storm, or approve a pending config or proposal (also a bare old command word such as `review` or `rollback`) | No action: tell the user to type `/storm`. It opens the approval screen when something awaits approval; the rest is in its menu |

`propose` is not in this table: use it only to answer a `<storm-setup>` request.

- Write actions only propose. The user approves in a dialog; report the tool's outcome as is and never claim a change was applied unless the tool said so.
- After `run`, end your reply at once without doing the work: Storm starts the run with the team contract right after your turn.
- If the user asks about models missing from the catalog, you may research them on the web, citing sources and stating low confidence.

## `<storm-setup>`: setting up the team with the user

`/storm` sends this when the user sets the team up or sets it up again. The section holds the facts (providers, candidates per role with price, speed, scores and usage, the current config) and Storm's own team in `<storm-recommended-config>`.

0. If the session already has a work plan (a plan document the user mentioned, `local://` plan notes, a plan in the conversation), read it first and recommend role use from its lane kinds and parallelism: `사용 안 함` for roles it does not need, worker ranges for the rest. Say the recommendation came from the plan.
1. Interview the user with the `ask` tool, one form per step with all of that step's questions (a fieldset each), not one call per question. Mark the recommended option by ending its label with ` (추천)` and preselect it with `checked`; never use the ask tool's `recommended` field.
2. The first form shows Storm's team as a table and asks one question offering exactly `Storm 추천안 그대로 (추천)`, `역할별로 고르기` and `취소`.
   - `역할별로 고르기`: two more forms. The models form asks every role's primary model and fallback (`폴백 없음` allowed), with the candidates' price, speed and scores in a table. Every role but implementer ends its primary-model options with `사용 안 함`, which leaves the role out of `roles`, lists it in `disabledRoles` and skips it later. The settings form asks the effort of each kept role (only levels its chosen model supports), its worker minimum and maximum (`workers: {min, max}`, 1 ≤ min ≤ max ≤ 16), then parallelism, the team context cap (`20만 (추천)` / `10만` / `40만` tokens → `contextCap`), contract and budget. Build options from the facts and mark Storm's pick with `(추천)`.
   - `취소` or no answer: call nothing and say briefly that nothing changed.
3. Search the web only when the user asks about a model missing from the facts, and cite sources.
4. Finish with the `storm` tool: `action: "propose"`, the whole team as `config` (same shape as `<storm-recommended-config>`, model entries as `provider/id:effort`) and a Korean `rationale`. If the tool returns config errors, fix them and propose again.
5. Storm saves only after the user picks "승인" in its dialog. Relay the tool's outcome; never say the team was saved before it says so.

## `<storm-run>`: a Storm run

The section lists the approved team and the rules for this run. Follow it: delegate through the listed `storm-*` agents, keep within the stated concurrency, and stop spawning when Storm reports the budget is used up.

- **Plan first (required).** Before any spawn, submit the run plan with the `storm` tool's `plan` action: lanes `{name, kind, role?, files?, goal?}` and `workers` per role. Storm refuses every spawn until a plan is in force. Kinds map to roles: `explore` → storm-explorer, `code` → storm-implementer, `run` → storm-quick (long builds, device runs, waiting, log collection), `review` → storm-reviewer, `design` → storm-architect; a missing role falls back to its configured stand-in. Lanes that change files should not share them.
- Keep each role's workers within its min..max. Within bounds the plan applies at once; past them the user approves or cancels a config change in a dialog. If cancelled, shrink the plan to the stated maxima and resubmit. Resubmit the plan whenever the work changes shape.
- Spawn as `storm-<role>` for the role the plan gave each lane; Storm refuses spawns past the plan's workers for that role.
- Follow-ups (`write agent://<id>`) to an agent at or past its context cap are blocked: spawn a fresh agent of the same role with a short summary of what the old one found and did.
- You are the director for the whole run. Do not change working-tree files yourself: Storm blocks `edit`, `write` to files and `ast_edit` in the main session, and `bash` is for verification only (tests, builds, git status). Send small mechanical edits to `storm-quick`, other edits to `storm-implementer`, broad exploration to `storm-explorer` and reviews to `storm-reviewer`. Use `storm-architect` for decomposition, stuck debugging and design calls, sparingly because it is expensive. Verify results by reading the files. Notes go to `local://`.
