# B0 spike: can a janitor delete finished subagent records?

An omp-behaviour probe, not a test of Storm: the run-end janitor relies on what it shows, so rerun it after an omp
upgrade and compare with the recorded results. It drives the real omp binary (`--mode rpc`, no plugins) against
`fake-llm.ts` and deletes a finished child's `<id>.jsonl`, `<id>.md` and `<id>/` from the parent session's artifacts dir.

```sh
PATH=$PWD/node_modules/.bin:$PATH bun spikes/b0/run.ts
```

Runs the pinned omp (`node_modules/.bin/omp`; `OMP_BIN` picks another) and needs port 18557 free. Wipes and
recreates the `storm-b0` profile (`~/.omp/profiles/storm-b0`) and `/tmp/storm-b0`; never touches other profiles.

What it prints, one block per scenario:

- `0-control`: spawn a child via `task`, then follow-up `write agent://<id>`, `read agent://<id>`, `history://<id>`, `history://`.
- `1-idle`: same probes after deleting the records of an idle child that is still live in memory (TTL parking off).
- `2-parked`: second session with `task.agentIdleTtlMs: 2000` (`park.yml` overlay); waits for `parked` in `history://`, deletes, probes. A kept sibling is probed too.
- `3-resume`: `omp --resume <session file>` for both sessions; `history://` index, reads of the deleted id, follow-up to the kept one.
- `4-stats`: read-only row counts in the profile's `stats.db` for the child transcript before/after deletion and after `omp stats --summary`.
- `5-locks`: `lsof` of the omp process tree and `*.lock`/`*lease*`/`*.tombstone` files near the artifacts dir.
- `6-partial`: deletes `X.jsonl`, `X.json`, `X.jsonl.tombstone`, `X/` but keeps `X.md`, for an idle-live and a parked child; same probes, then resume.
- `7-id reuse`: respawns a deleted child's name in the same live session and after `--resume` (full vs partial deletion).
- `4b-stats`: stats.db rows and `file_offsets` for the reused `B0Live.jsonl` path after another sync.

Results and the decisions drawn from them: [docs/spikes.md](../../docs/spikes.md#b0-하위-기록-삭제).
