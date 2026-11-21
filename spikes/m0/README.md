# M0 spike: omp session modes (vibe, goal, loop) from an extension

An omp-behaviour probe, not a test of Storm: the run modes rely on what it shows, so rerun it after an omp upgrade
and compare with the recorded results. It drives the real omp binary against `fake-llm.ts` with the probe
extension in `plugin/`, which calls `ctx.sessionModes.set()` and logs `mode_changed`, `goal_updated`,
`agent_end` flags, `session_stop`, `before_subagent_spawn`, `tool_call` and `input` with `ctx.agent`.

```sh
PATH=$PWD/node_modules/.bin:$PATH bun spikes/m0/run.ts              # every scenario
PATH=$PWD/node_modules/.bin:$PATH bun spikes/m0/run.ts tui-goal     # some of them
```

Needs port 18558 free. Wipes and recreates the `storm-m0` profile (`~/.omp/profiles/storm-m0`) and
`/tmp/storm-m0`; never touches other profiles. The plugin is linked into that profile (`omp plugin link`);
`M0_PLUGIN=e` loads it with `-e <dir>` instead (then a vibe worker's `task` cannot see the plugin's agents).
`M0_KEEP_PROFILE=1` keeps the profile; `OMP_BIN` picks another omp. Each scenario prints one JSON line, also
appended to `/tmp/storm-m0/results.jsonl`; raw logs are `ext.jsonl` and `llm.jsonl` next to it.

The TUI is driven on a pty (`Bun.spawn({ terminal })`): the driver answers the DA1 and OSC 11 queries the
TUI waits for, types extension commands and reads the extension's log instead of the screen.

| scenario | what it shows |
|---|---|
| `tui-matrix` | every `set()` request against every mode combination: `ok`, `conflict`, `invalid_request`; active tools per mode |
| `tui-vibe`, `tui-vibe-overrides` | a vibe run: director tool list and context, worker models and tools, events in workers, a worker spawning a Storm role agent, a director-side `tool_call` block; with `task.agentModelOverrides` |
| `tui-goal` | a goal run to `goal({op:"complete"})` with a `task` subagent in between: flags, events, token accounting, injected texts |
| `tui-goal-stall` | a continuation turn that ends without a tool call stops the continuation; the goal stays active |
| `tui-goal-budget` | budget exhausted on the first turn; pause, resume, drop |
| `tui-loop` | iteration limit, `until` condition, and a loop entered without a prompt |
| `tui-goal-loop` | goal and loop active together |
| `tui-set-from` | `set()` from `session_start`, from a terminal `agent_end`, from a tool's execute |
| `tui-modecontrol-off` | `extensionHandlers.modeControl: false` |
| `tui-persist` | what `--continue` restores |
| `rpc-probe`, `print-probe`, `acp-probe` | no `ctx.sessionModes` outside the TUI; mode slash commands reach the model as text; the RPC `goal` command |
| `rpc-goal` | goal continuation in RPC with `goal.continuationModes: [interactive, rpc]` |
| `rpc-stop` | `session_stop` continuations and their cap |

Results and the decisions drawn from them: [docs/spikes.md](../../docs/spikes.md#m0-세션-모드vibegoalloop).
