import { expect, test } from "bun:test";
import type { LanePolicy } from "../src/policy/capability.ts";
import { PLACEMENT_CHANGED_REASON, resolveTaskLanes, RunLanes, spawnKeyMismatchReason, UNPLANNED_NOTE_TAG, type HostJobRow } from "../src/runtime/lanes.ts";
import type { PlanLane, RunPlan } from "../src/types.ts";
import { agentEntry, teamOf } from "./fixtures.ts";

const team = teamOf({ implementer: "fake/dev", explorer: "fake/look", quick: "fake/q" });
const lane = (name: string, over: Partial<PlanLane> = {}): PlanLane => ({ name, kind: "code", role: "implementer", files: [`${name}.ts`], ...over });
const plan = (...lanes: PlanLane[]): RunPlan => ({ lanes, workers: { implementer: 9, explorer: 9, quick: 9 }, submittedAt: "2026-01-01T00:00:00Z" });
/** The approved definitions this fixture pretends to have read. An absent name is unknown (every tool). */
const TOOLS: Record<string, readonly string[]> = {
	"storm-implementer": ["read", "bash"],
	"storm-explorer": ["read", "grep"],
	"storm-quick": ["read", "write"],
};
const agentTools = (agent: string): readonly string[] | undefined => TOOLS[agent];
const readPolicy: LanePolicy = { kind: "read", reason: "read" };
const shellPolicy: LanePolicy = { kind: "read", reason: "shell", shell: true };
const unknownPolicy: LanePolicy = { kind: "unknown", reason: "unknown" };
const privatePolicy: LanePolicy = { kind: "private", reason: "private" };
const pathsPolicy = (paths: string[]): LanePolicy => ({ kind: "paths", paths, reason: "paths" });
const host = { enabled: true, apply: false };
const DIRECT = { directorTask: { policy: () => unknownPolicy } };
const READ = { directorTask: { policy: () => readPolicy } };

test("a reader cannot take a writer's place, even with the same name in one plan-less batch (corr2)", () => {
	const work = new RunLanes("run-corr");
	const placed = work.place(
		{
			tasks: [
				{ agent: "storm-implementer", name: "x", task: "write" },
				{ agent: "storm-explorer", name: "x", task: "read" },
			],
		},
		undefined,
		team,
		{ agentTools, callId: "call-1" },
	);
	expect(placed.ok).toBe(true);
	if (!placed.ok) return;
	const tasks = placed.input.tasks as Array<Record<string, unknown>>;
	const writer = String(tasks[0]!.name);
	const reader = String(tasks[1]!.name);
	// Every unplanned item gets its own handle; the director's shared name is not a correlation key (R4).
	expect(writer).toMatch(/^storm-implementer-run-.+-\d+$/);
	expect(reader).toMatch(/^storm-explorer-run-.+-\d+$/);
	expect(writer).not.toBe(reader);

	// The reader's hook runs first. It binds its own read placement and reserves nothing.
	const readerAdmission = work.admitChecked({ spawnKey: reader, agent: "storm-explorer", outcome: "routed" }, undefined, READ);
	expect(readerAdmission).toMatchObject({ ok: true, placed: true });
	if (readerAdmission.ok) expect(readerAdmission.hold).toBeUndefined();
	// The writer's reservation is untouched: a second writer is refused while it is placed and not yet admitted.
	expect(work.place({ agent: "storm-implementer", name: "z", task: "other" }, undefined, team, { agentTools, now: Date.now() + 1 })).toMatchObject({
		ok: false,
		code: "lane-write",
	});
	// The reader settling and its call ending free only the reader's place, never the writer's.
	work.releaseAgent(reader);
	work.callEnded("call-1");
	expect(work.place({ agent: "storm-implementer", name: "z", task: "other" }, undefined, team, { agentTools })).toMatchObject({ ok: false, code: "lane-write" });
	// The writer's own spawn now binds its reservation; its hold names the exact placement.
	expect(work.admitChecked({ spawnKey: writer, agent: "storm-implementer", outcome: "routed" }, undefined, DIRECT)).toMatchObject({
		ok: true,
		placed: true,
		hold: `spawn:${writer}`,
	});
});

test("a deduped spawn key is refused and its sibling placement is unaffected", () => {
	const work = new RunLanes("run-dedupe");
	const placed = work.place(
		{ tasks: [{ agent: "storm-explorer", name: "look", task: "read" }, { agent: "storm-implementer", name: "work", task: "write" }] },
		undefined,
		team,
		{ agentTools },
	);
	expect(placed.ok).toBe(true);
	if (!placed.ok) return;
	const [reader, writer] = (placed.input.tasks as Array<Record<string, unknown>>).map(item => String(item.name));
	// omp appends `-2` to a name it has seen. Nothing matches that key: refuse, never guess the sibling (R4).
	const deduped = work.admitChecked({ spawnKey: `${reader}-2`, agent: "storm-explorer", outcome: "routed" }, undefined, READ);
	expect(deduped).toMatchObject({ ok: false, code: "internal" });
	if (!deduped.ok) expect(deduped.reason).toBe(spawnKeyMismatchReason(`${reader}-2`));
	// The exact keys still work: the refused impostor consumed nothing.
	expect(work.admitChecked({ spawnKey: reader, agent: "storm-explorer", outcome: "routed" }, undefined, READ)).toMatchObject({ ok: true, placed: true });
	expect(work.admitChecked({ spawnKey: writer, agent: "storm-implementer", outcome: "routed" }, undefined, DIRECT)).toMatchObject({
		ok: true,
		placed: true,
		hold: `spawn:${writer}`,
	});
});

test("a spawn key of an earlier run is refused in the next run (Q7)", () => {
	const first = new RunLanes("run-earlier");
	const placed = first.place({ agent: "storm-implementer", name: "w", task: "write" }, undefined, team, { agentTools });
	expect(placed.ok).toBe(true);
	if (!placed.ok) return;
	const key = String(placed.input.name);
	// A late async item of an earlier ask must not join the run that opened after it.
	const next = new RunLanes("run-later");
	expect(next.admitChecked({ spawnKey: key, agent: "storm-implementer", outcome: "routed" }, undefined, DIRECT)).toMatchObject({ ok: false, code: "internal" });
	// The key still belongs to its own run.
	expect(first.admitChecked({ spawnKey: key, agent: "storm-implementer", outcome: "routed" }, undefined, DIRECT)).toMatchObject({ ok: true, placed: true });
});

test("a name that matches no lane takes its role's only lane; ambiguity is unplanned; a wrong-role or job-lane name gets a note", () => {
	const p = plan(lane("api"), { name: "look", kind: "explore", role: "explorer" }, { name: "bench", kind: "run", role: "quick", job: "bench" });
	// Manual direction's own handle: the director's name is no lane, and the role has one usable lane. Binding it is what
	// placement always did, and what keeps a named task's results on its lane.
	const work = new RunLanes("run-r5");
	const unmatched = work.assign({ agent: "storm-implementer", name: "ghost", task: "G" }, p, team, { agentTools });
	expect(unmatched.ok).toBe(true);
	if (unmatched.ok) {
		expect(unmatched.input.name).toBe("run-r5-lane-1");
		expect(work.admitChecked({ spawnKey: String(unmatched.input.name), agent: "storm-implementer", outcome: "routed" }, { plan: p, config: team })).toMatchObject({ ok: true, lane: "api" });
	}
	// Two usable lanes make the same name ambiguous: the unplanned record state, with no refusal.
	const ambiguous = new RunLanes("run-r5-amb").assign({ agent: "storm-implementer", name: "ghost", task: "G" }, plan(lane("api"), lane("view")), team, { agentTools });
	expect(ambiguous.ok).toBe(true);
	if (ambiguous.ok) expect(ambiguous.input.name).toMatch(/^storm-implementer-run-.+-\d+$/);
	const wrongRole = new RunLanes("run-r5-role").assign({ agent: "storm-explorer", name: "api", task: "R" }, p, team, { agentTools });
	expect(wrongRole.ok).toBe(true);
	if (wrongRole.ok) {
		expect(wrongRole.input.name).toMatch(/^storm-explorer-run-.+-\d+$/);
		expect(wrongRole.notes?.some(note => note.includes(UNPLANNED_NOTE_TAG) && note.includes("역할"))).toBe(true);
	}
	const job = new RunLanes("run-r5-job").assign({ agent: "storm-quick", name: "bench", task: "B" }, p, team, { agentTools });
	expect(job.ok).toBe(true);
	if (job.ok) {
		expect(job.input.name).toMatch(/^storm-quick-run-.+-\d+$/);
		expect(job.notes?.some(note => note.includes(UNPLANNED_NOTE_TAG) && note.includes("정형 작업"))).toBe(true);
	}
	// The same lane twice in one batch keeps its refusal.
	const duplicate = new RunLanes("run-r5-dup").assign({ tasks: [{ agent: "storm-implementer", name: "api", task: "A" }, { agent: "storm-implementer", name: "api", task: "A" }] }, p, team, { agentTools });
	expect(duplicate).toMatchObject({ ok: false, code: "lane" });
	// A lane name of the right role is planned, and the automatic path rewrites its name (R4).
	const planned = new RunLanes("run-r5").assign({ agent: "storm-implementer", name: "api", task: "A" }, p, team, { agentTools });
	expect(planned.ok).toBe(true);
	if (planned.ok) expect(planned.input.name).toBe("run-r5-lane-1");
});

test("every manual planned placement gets a run-unique handle, and the lane stays the same", () => {
	const work = new RunLanes("run-reattempt");
	const p = plan(lane("api"));
	const first = work.place({ agent: "storm-implementer", name: "api", task: "A" }, p, team, { agentTools });
	expect(first.ok).toBe(true);
	if (!first.ok) return;
	// A1-5: the lane's name is the table and ledger key, never the child's name; the host gets a handle it has not seen.
	expect(String(first.input.name)).toMatch(/^run-reattempt-lane-\d+$/);
	expect(work.admitChecked({ spawnKey: String(first.input.name), agent: "storm-implementer", outcome: "routed" }, { plan: p, config: team })).toMatchObject({ ok: true, lane: "api" });
	// The first attempt ends before a re-attempt is placed. The re-attempt must not reuse the first handle either.
	work.releaseAgent(String(first.input.name));
	const second = work.place({ agent: "storm-implementer", name: "api", task: "A again" }, p, team, { agentTools });
	expect(second.ok).toBe(true);
	if (!second.ok) return;
	expect(String(second.input.name)).toMatch(/^run-reattempt-lane-\d+$/);
	expect(second.input.name).not.toBe(first.input.name);
	expect(work.admitChecked({ spawnKey: String(second.input.name), agent: "storm-implementer", outcome: "routed" }, { plan: p, config: team })).toMatchObject({ ok: true, lane: "api" });
});

test("a planned lane's first attempt in a resumed session gets a handle, not the lane's seen name", () => {
	const work = new RunLanes("run-resumed");
	const placed = work.place({ agent: "storm-implementer", name: "api", task: "A" }, plan(lane("api")), team, { agentTools });
	expect(placed.ok).toBe(true);
	if (placed.ok) expect(String(placed.input.name)).toMatch(/^run-resumed-lane-\d+$/);
});

test("a blocked spawn consumes its handle, so the lane's retry in the same run gets a new one", () => {
	const work = new RunLanes("run-blocked-retry");
	const p = plan(lane("api"));
	const first = work.place({ agent: "storm-implementer", name: "api", task: "A" }, p, team, { agentTools });
	expect(first.ok).toBe(true);
	if (!first.ok) return;
	const firstKey = String(first.input.name);
	expect(work.admitChecked({ spawnKey: firstKey, agent: "storm-implementer", outcome: "blocked" }, { plan: p, config: team })).toMatchObject({ ok: true });
	const retry = work.place({ agent: "storm-implementer", name: "api", task: "A again" }, p, team, { agentTools });
	expect(retry.ok).toBe(true);
	if (!retry.ok) return;
	expect(String(retry.input.name)).toMatch(/^run-blocked-retry-lane-\d+$/);
	expect(retry.input.name).not.toBe(firstKey);
	expect(work.admitChecked({ spawnKey: String(retry.input.name), agent: "storm-implementer", outcome: "routed" }, { plan: p, config: team })).toMatchObject({ ok: true, lane: "api" });
});

test("an unplanned handle carries its run id, so a resumed session in a new process cannot reuse one", () => {
	const place = (runId: string) => new RunLanes(runId).place({ agent: "storm-explorer", name: "look", task: "read" }, undefined, team, { agentTools });
	const first = place("run-20260101-000000-aaaa");
	const second = place("run-20260101-000000-bbbb");
	expect(first.ok && second.ok).toBe(true);
	if (!first.ok || !second.ok) return;
	// omp dedupes any name the native session has seen; a fresh process's counter starts at one again, so only the run
	// id (unique across processes) keeps the handle a first use. A handle without it is refused as `<name>-2`.
	expect(String(first.input.name)).toContain("run-20260101-000000-aaaa");
	expect(String(second.input.name)).toContain("run-20260101-000000-bbbb");
	expect(first.input.name).not.toBe(second.input.name);
});

test("the lane resolver keeps only the same-lane refusal and the unique role lane", () => {
	const p = plan(lane("api"), { name: "look", kind: "explore", role: "explorer" });
	const named = resolveTaskLanes({ agent: "storm-implementer", name: "api", task: "A" }, p, team);
	expect(named.ok).toBe(true);
	if (named.ok) expect(named.items[0]?.lane?.name).toBe("api");
	// A name that matches no lane takes the role's one usable lane, named or not.
	const unmatched = resolveTaskLanes({ agent: "storm-implementer", name: "ghost", task: "G" }, p, team);
	if (unmatched.ok) expect(unmatched.items[0]?.lane?.name).toBe("api");
	const nameless = resolveTaskLanes({ agent: "storm-explorer", task: "R" }, p, team);
	if (nameless.ok) expect(nameless.items[0]?.lane?.name).toBe("look");
	// Two usable lanes for an unmatched or nameless item is ambiguous: unplanned, not guessed.
	const ambiguous = resolveTaskLanes({ agent: "storm-implementer", task: "A" }, plan(lane("api"), lane("view")), team);
	if (ambiguous.ok) expect(ambiguous.items[0]?.lane).toBeUndefined();
	// The plan's absence makes every item unplanned.
	const none = resolveTaskLanes({ agent: "storm-implementer", name: "api", task: "A" }, undefined, team);
	if (none.ok) expect(none.items[0]?.lane).toBeUndefined();
});

test("an unplanned read item reserves nothing; a shell reader is ordered like a writer (R6)", () => {
	const work = new RunLanes("run-r6");
	const reader = work.place({ agent: "storm-explorer", name: "look", task: "read" }, undefined, team, { agentTools });
	expect(reader.ok).toBe(true);
	if (!reader.ok) return;
	const readerKey = String(reader.input.name);
	// The read placement did not take the tree: a writer may be placed beside it.
	expect(work.place({ agent: "storm-implementer", name: "work", task: "write" }, undefined, team, { agentTools }).ok).toBe(true);
	expect(work.admitChecked({ spawnKey: readerKey, agent: "storm-explorer", outcome: "routed" }, undefined, READ)).toMatchObject({ ok: true, placed: true });

	const shell = new RunLanes("run-r6-shell");
	const shellPlaced = shell.place({ agent: "storm-implementer", name: "sh", task: "run" }, undefined, team, { agentTools });
	expect(shellPlaced.ok).toBe(true);
	if (!shellPlaced.ok) return;
	const shellKey = String(shellPlaced.input.name);
	// A shell reader is ordered like a writer while its placement is live.
	expect(shell.place({ agent: "storm-quick", name: "next", task: "write" }, undefined, team, { agentTools })).toMatchObject({ ok: false, code: "lane-write" });
	expect(shell.admitChecked({ spawnKey: shellKey, agent: "storm-implementer", outcome: "routed" }, undefined, DIRECT)).toMatchObject({
		ok: true,
		placed: true,
		hold: `spawn:${shellKey}`,
	});
});

test("an isolated item that carries its own tools is refused at placement, on planned lanes too", () => {
	const call = { agent: "storm-implementer", name: "lab", task: "Try", tools: ["marker"] };
	// Plan-less, isolated: its tools would run in the director's work folder (D7).
	expect(new RunLanes("run-tools-planless").place({ ...call, isolated: true }, undefined, team, { host, agentTools })).toMatchObject({
		ok: false,
		code: "isolation",
	});
	// A planned isolated lane gets the same refusal.
	const isolatedPlan = plan({ ...lane("lab"), kind: "run", isolationReason: "independent" });
	expect(new RunLanes("run-tools-planned").place({ ...call }, isolatedPlan, team, { host, agentTools })).toMatchObject({ ok: false, code: "isolation" });
	// Shared, the item is an exclusive writer: it is placed.
	expect(new RunLanes("run-tools-shared").place({ ...call }, undefined, team, { agentTools }).ok).toBe(true);
});

test("an isolated unplanned item is private and runs beside a shared writer (D10)", () => {
	const work = new RunLanes("run-private");
	expect(work.place({ agent: "storm-implementer", name: "api", task: "write" }, plan(lane("api")), team, { agentTools }).ok).toBe(true);
	const isolated = work.place({ agent: "storm-implementer", name: "lab", task: "Try", isolated: true }, undefined, team, { host, agentTools });
	expect(isolated.ok).toBe(true);
	if (isolated.ok) {
		expect(isolated.input).toMatchObject({ isolated: true });
		expect(isolated.input.name).toMatch(/^storm-implementer-run-.+-\d+$/);
	}
});

test("the admission returns the reservation key bound to the child (R7)", () => {
	const work = new RunLanes("run-hold");
	const p = plan(lane("api"));
	const manual = work.place({ agent: "storm-implementer", name: "api", task: "A" }, p, team);
	expect(manual.ok).toBe(true);
	if (!manual.ok) return;
	// A planned item is matched by the exact handle its placement gave the host and holds the lane's reservation. The
	// hook derives the policy from the frozen placement; the result carries both the hold and the proven policy.
	const frozenLanes: Array<string | undefined> = [];
	expect(
		work.admitChecked({ spawnKey: String(manual.input.name), agent: "storm-implementer", outcome: "routed" }, { plan: p, config: team }, {
			directorTask: {
				policy: frozen => {
					frozenLanes.push(frozen.lane);
					return pathsPolicy(["api.ts"]);
				},
			},
		}),
	).toMatchObject({
		ok: true,
		lane: "api",
		placed: true,
		hold: "lane:api",
		authority: { kind: "paths", paths: ["api.ts"] },
		policy: { kind: "paths", paths: ["api.ts"] },
	});
	expect(frozenLanes).toEqual(["api"]);
	// Without the director-task option the older callers keep their exact shape (no new fields).
	const older = new RunLanes("run-hold-older");
	const olderPlaced = older.assign({ agent: "storm-implementer", name: "api", task: "A" }, p, team);
	expect(olderPlaced.ok).toBe(true);
	const key = olderPlaced.ok ? String(olderPlaced.input.name) : "";
	expect(older.admitChecked({ spawnKey: key, agent: "storm-implementer", outcome: "routed" })).toEqual({ ok: true, lane: "api" });
	// The automatic path is the same admission with a generated key: the frozen placement names its lane.
	const auto = new RunLanes("run-hold-auto");
	const autoPlaced = auto.assign({ agent: "storm-implementer", name: "api", task: "A" }, p, team);
	expect(autoPlaced.ok).toBe(true);
	const autoKey = autoPlaced.ok ? String(autoPlaced.input.name) : "";
	const autoLanes: Array<string | undefined> = [];
	expect(
		auto.admitChecked({ spawnKey: autoKey, agent: "storm-implementer", outcome: "routed" }, undefined, {
			directorTask: {
				policy: frozen => {
					autoLanes.push(frozen.lane);
					return pathsPolicy(["api.ts"]);
				},
			},
		}),
	).toMatchObject({ ok: true, lane: "api", placed: true, hold: "lane:api" });
	expect(autoLanes).toEqual(["api"]);
});

test("an unplanned follow-up gets a fresh hold, and a read-only one gets none (R7)", () => {
	const follow = new RunLanes("run-follow-hold");
	const idle = [agentEntry({ id: "W", state: "idle", requests: 1 })];
	const writer = follow.checkFollowUp({
		runId: "run-follow-hold",
		agentId: "W",
		agent: "storm-implementer",
		policy: unknownPolicy,
		isolated: false,
		agents: idle,
	});
	expect(writer).toMatchObject({ ok: true, hold: "spawn:W" });
	if (writer.ok) follow.finishFollowUp(writer.token, true);
	const reader = follow.checkFollowUp({
		runId: "run-follow-hold",
		agentId: "R",
		agent: "storm-explorer",
		policy: readPolicy,
		isolated: false,
		agents: [agentEntry({ id: "R", state: "idle", requests: 1 })],
	});
	expect(reader).toMatchObject({ ok: true });
	if (reader.ok) {
		expect(reader.hold).toBeUndefined();
		follow.finishFollowUp(reader.token, false);
	}
	const privateFollow = follow.checkFollowUp({
		runId: "run-follow-hold",
		agentId: "P",
		agent: "storm-implementer",
		policy: privatePolicy,
		isolated: true,
		agents: [agentEntry({ id: "P", state: "idle", requests: 1 })],
	});
	expect(privateFollow).toMatchObject({ ok: true, hold: "private:P" });
	if (privateFollow.ok) follow.finishFollowUp(privateFollow.token, false);
	const plannedLanes = new RunLanes("run-follow-hold-planned");
	const planned = plannedLanes.checkFollowUp({
		runId: "run-follow-hold-planned",
		agentId: "A",
		agent: "storm-implementer",
		lane: lane("api"),
		policy: pathsPolicy(["api.ts"]),
		isolated: false,
		agents: [agentEntry({ id: "A", state: "idle", requests: 1 })],
	});
	expect(planned).toMatchObject({ ok: true, hold: "lane:api" });
	if (planned.ok) plannedLanes.finishFollowUp(planned.token, false);
	if (writer.ok) follow.finishFollowUp(writer.token, false);
});

test("the hook derives the policy from the frozen authority: an isolated shell worker stays private (D10)", () => {
	const work = new RunLanes("run-derived");
	const placed = work.place({ agent: "storm-implementer", name: "lab", task: "Try", isolated: true }, undefined, team, { host, agentTools });
	expect(placed.ok).toBe(true);
	if (!placed.ok) return;
	const seen: string[] = [];
	const admission = work.admitChecked(
		{ spawnKey: String(placed.input.name), agent: "storm-implementer", outcome: "routed" },
		undefined,
		{
			directorTask: {
				policy: frozen => {
					seen.push(frozen.lane === undefined ? frozen.authority.kind : `lane:${frozen.lane}`);
					return frozen.authority.kind === "private" ? privatePolicy : unknownPolicy;
				},
			},
		},
	);
	expect(seen).toEqual(["private"]);
	const key = String(placed.input.name);
	expect(admission).toMatchObject({
		ok: true,
		placed: true,
		authority: { kind: "private" },
		policy: { kind: "private" },
		// The isolated worker holds no shared reservation; the mark lets the guard allow writes inside its checkout.
		hold: `private:${key}`,
	});
});

test("a policy wider than the frozen placement is refused; a narrower one is admitted (R3)", () => {
	const p = plan(lane("api"));
	const paths = pathsPolicy(["api.ts"]);
	const broad = new RunLanes("run-r3-broad");
	const broadPlaced = broad.place({ agent: "storm-implementer", name: "api", task: "A" }, p, team, { policies: new Map([["api", paths]]) });
	expect(broadPlaced.ok).toBe(true);
	if (!broadPlaced.ok) return;
	const wider = broad.admitChecked({ spawnKey: String(broadPlaced.input.name), agent: "storm-implementer", outcome: "routed" }, { plan: p, config: team }, { directorTask: { policy: () => pathsPolicy(["api.ts", "other.ts"]) } });
	expect(wider).toMatchObject({ ok: false, code: "internal" });
	if (!wider.ok) expect(wider.reason).toBe(PLACEMENT_CHANGED_REASON);
	// The refused admission released the placement. The lane is attempted again in the same run; the host already
	// allocated the lane's name for the refused spawn, so the re-attempt gets a run-unique handle (R4/HF-2).
	const replanned = broad.place({ agent: "storm-implementer", name: "api", task: "A" }, p, team, { policies: new Map([["api", paths]]) });
	expect(replanned.ok).toBe(true);
	if (!replanned.ok) return;
	expect(String(replanned.input.name)).toMatch(/^run-r3-broad-lane-\d+$/);
	expect(broad.admitChecked({ spawnKey: String(replanned.input.name), agent: "storm-implementer", outcome: "routed" }, { plan: p, config: team }, { directorTask: { policy: () => pathsPolicy(["api.ts"]) } })).toMatchObject({
		ok: true,
		hold: "lane:api",
	});

	// A shared placement read as private would write the parent root: refused.
	const privateRead = new RunLanes("run-r3-private-read");
	const privatePlaced = privateRead.place({ agent: "storm-implementer", name: "api", task: "A" }, p, team, { policies: new Map([["api", paths]]) });
	expect(privatePlaced.ok).toBe(true);
	if (!privatePlaced.ok) return;
	expect(privateRead.admitChecked({ spawnKey: String(privatePlaced.input.name), agent: "storm-implementer", outcome: "routed" }, { plan: p, config: team }, { directorTask: { policy: () => privatePolicy } })).toMatchObject({
		ok: false,
		code: "internal",
	});

	// A read placement whose definition grew a shell has no reservation behind it: refused.
	const readGrew = new RunLanes("run-r3-read-grew");
	const look = readGrew.place({ agent: "storm-explorer", name: "look", task: "R" }, undefined, team, { agentTools });
	expect(look.ok).toBe(true);
	if (!look.ok) return;
	expect(readGrew.admitChecked({ spawnKey: String(look.input.name), agent: "storm-explorer", outcome: "routed" }, undefined, { directorTask: { policy: () => shellPolicy } })).toMatchObject({
		ok: false,
		code: "internal",
	});
	// The read policy is still covered, and a fresh read placement reserves nothing.
	const lookAgain = readGrew.place({ agent: "storm-explorer", name: "look", task: "R" }, undefined, team, { agentTools });
	expect(lookAgain.ok).toBe(true);
	if (!lookAgain.ok) return;
	expect(readGrew.admitChecked({ spawnKey: String(lookAgain.input.name), agent: "storm-explorer", outcome: "routed" }, undefined, READ)).toMatchObject({
		ok: true,
		placed: true,
	});
});

test("an unplanned shared writer is rechecked at admission against a host job that appeared after its placement (A1-2)", () => {
	const rows: { current: readonly HostJobRow[] | undefined } = { current: [] };
	const work = new RunLanes("run-host-recheck", () => rows.current);
	const placed = work.place({ agent: "storm-implementer", name: "w", task: "write" }, undefined, team, { agentTools });
	expect(placed.ok).toBe(true);
	if (!placed.ok) return;
	const key = String(placed.input.name);
	// The placement is live and was gated against an empty table; a command the director sent to the background now runs.
	rows.current = [{ id: "bg-1", type: "bash", status: "running" }];
	const admitted = work.admitChecked({ spawnKey: key, agent: "storm-implementer", outcome: "routed" }, undefined, DIRECT);
	expect(admitted).toMatchObject({ ok: false, code: "lane-write" });
});

test("a planned reader that carries its own eval tools is reserved as a shared writer and the fact reaches the hook (D7/A1-7)", () => {
	const work = new RunLanes("run-carried-tools");
	const p = plan(lane("look", { kind: "explore", role: "explorer", files: [] }));
	const placed = work.place(
		{ agent: "storm-explorer", name: "look", task: "read", tools: ["my_lookup"] },
		p,
		team,
		{ policies: new Map([["look", readPolicy]]), agentTools },
	);
	expect(placed.ok).toBe(true);
	if (!placed.ok) return;
	const key = String(placed.input.name);
	const frozen: boolean[] = [];
	const admitted = work.admitChecked(
		{ spawnKey: key, agent: "storm-explorer", outcome: "routed" },
		{ plan: p, config: team },
		{
			directorTask: {
				policy: placement => {
					frozen.push(placement.toolsCarried);
					return readPolicy;
				},
			},
		},
	);
	// The placement reserved the whole shared tree, and the hook is told why; a read policy is narrower, so it is admitted.
	expect(frozen).toEqual([true]);
	expect(admitted).toMatchObject({ ok: true, hold: "lane:look" });
	if (admitted.ok) expect(admitted.authority).toEqual({ kind: "unknown" });
});

test("mismatch notes are counted by cause with a bounded number of examples, never one line per item (B9)", () => {
	const p = plan({ name: "api", kind: "code", role: "implementer", files: ["api.ts"] });
	const items = Array.from({ length: 64 }, (_, index) => ({ agent: "storm-explorer", name: "api", task: `read ${index}` }));
	const placed = new RunLanes("run-notes").place({ tasks: items }, p, team, { agentTools });
	expect(placed.ok).toBe(true);
	if (!placed.ok) return;
	const notes = placed.notes ?? [];
	// Two examples and one line that counts the rest, all under one cause.
	expect(notes).toHaveLength(3);
	expect(notes.every(note => note.includes(UNPLANNED_NOTE_TAG))).toBe(true);
	expect(notes.at(-1)).toContain("62개 더");
	expect(notes.join("\n").length).toBeLessThan(1_200);
});
