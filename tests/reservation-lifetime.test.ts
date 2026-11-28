/**
 * G1: a writer Storm admitted stays covered by a write reservation for as long as it can write. A reservation of an
 * admitted or awaited worker ends only with an event that ends its authority to write, never by a timer; one that was
 * only placed may lapse, and a late start must then pass the conflict check again and reserve in the same step.
 */
import { afterEach, expect, test } from "bun:test";
import { onLaneReservationEnd, PENDING_WRITE_MS, RunLanes, type ReservationEnd } from "../src/runtime/lanes.ts";
import type { LanePolicy } from "../src/policy/capability.ts";
import type { PlanLane, RunPlan } from "../src/types.ts";
import { agentEntry, teamOf } from "./fixtures.ts";

const team = teamOf({ quick: "fake/quick", implementer: "fake/dev", explorer: "fake/look" });
/** An exec-capable implementer lane with no files: an exclusive writer. */
const exclusive = (name: string): PlanLane => ({ name, kind: "code", role: "implementer", goal: `do ${name}` });
const pathLane = (name: string, role: string, files: string[]): PlanLane => ({ name, kind: "code", role, files, goal: name });
const reader: PlanLane = { name: "look", kind: "explore", role: "explorer", goal: "read" };
const plan = (...lanes: PlanLane[]): RunPlan => ({
	lanes: [...lanes, reader],
	workers: { quick: 2, implementer: 2, explorer: 1 },
	submittedAt: "2026-01-01T00:00:00Z",
});
const T0 = 1_000_000;
const LATE = T0 + PENDING_WRITE_MS + 1_000;

const assign = (work: RunLanes, p: RunPlan, name: string, agent: string, now: number, agents: ReturnType<typeof agentEntry>[] = []) =>
	work.assign({ agent, task: name, name }, p, team, { now, agents });
const idOf = (placed: ReturnType<RunLanes["assign"]>): string => {
	if (!placed.ok || typeof placed.input.name !== "string") throw new Error("not placed");
	return placed.input.name;
};
const refusedWrite = (placed: ReturnType<RunLanes["assign"]>): boolean => !placed.ok && placed.code === "lane-write";

const unsubscribe: Array<() => void> = [];
afterEach(() => {
	for (const off of unsubscribe.splice(0)) off();
});

/** Runs `body` with `Date.now()` pinned, the way a hook that fires late sees the clock. */
function at<T>(time: number, body: () => T): T {
	const real = Date.now;
	Date.now = () => time;
	try {
		return body();
	} finally {
		Date.now = real;
	}
}

for (const mode of ["manual", "auto"] as const) {
	test(`${mode}: a writer admitted after its pending window is reserved again, so a second writer is refused`, () => {
		const p = plan(pathLane("A", "quick", ["shared.txt"]), pathLane("B", "implementer", ["shared.txt"]));
		const work = new RunLanes(`late-${mode}`);
		const placed = mode === "auto"
			? work.assign({ agent: "storm-quick", name: "A", task: "a" }, p, team, { now: T0 })
			: work.place({ agent: "storm-quick", name: "A", task: "a" }, p, team, { now: T0 });
		const id = idOf(placed);
		// Any later gate call after the window lets A's unbound placement lapse (here a read-only lane).
		expect(work.assign({ agent: "storm-explorer", task: "look", name: "look" }, p, team, { now: LATE }).ok).toBe(true);
		const admitted = at(LATE, () => work.admitChecked({ spawnKey: id, agent: "storm-quick", outcome: "routed" }, mode === "auto" ? undefined : { plan: p, config: team }));
		expect(admitted.ok).toBe(true);
		const running = [agentEntry({ id, name: "storm-quick", role: "quick", state: "running" })];
		const second = work.place({ agent: "storm-implementer", name: "B", task: "b" }, p, team, { now: LATE + 1_000, agents: running });
		expect(refusedWrite(second)).toBe(true);
	});
}

test("an exec-capable writer admitted late keeps its approved unknown scope against a disjoint path writer", () => {
	const p = plan(pathLane("A", "quick", ["a.ts"]), pathLane("B", "implementer", ["b.ts"]));
	const policies = new Map<string, LanePolicy>([
		["A", { kind: "unknown", reason: "bash can write anywhere" }],
		["B", { kind: "paths", paths: ["b.ts"], reason: "paths" }],
	]);
	const work = new RunLanes("late-policy");
	const first = work.place({ agent: "storm-quick", name: "A", task: "a" }, p, team, { now: T0, policies });
	expect(first.ok).toBe(true);
	if (!first.ok) return;
	const key = String(first.input.name);
	work.place({ agent: "storm-explorer", name: "look", task: "look" }, p, team, { now: LATE, policies });
	expect(at(LATE, () => work.admitChecked({ spawnKey: key, agent: "storm-quick", outcome: "routed" }, { plan: p, config: team })).ok).toBe(true);
	const running = [agentEntry({ id: key, name: "storm-quick", role: "quick", state: "running" })];
	const second = work.place({ agent: "storm-implementer", name: "B", task: "b" }, p, team, { now: LATE + 1_000, agents: running, policies });
	expect(refusedWrite(second)).toBe(true);
});

test("a late admission that conflicts with a writer placed meanwhile is refused, and it leaves no reservation behind", () => {
	const p = plan(pathLane("A", "quick", ["shared.txt"]), pathLane("X", "implementer", ["shared.txt"]));
	const work = new RunLanes("late-conflict");
	const a = idOf(work.assign({ agent: "storm-quick", name: "A", task: "a" }, p, team, { now: T0 }));
	const x = idOf(work.assign({ agent: "storm-implementer", name: "X", task: "x" }, p, team, { now: LATE }));
	const refused = at(LATE, () => work.admitChecked({ spawnKey: a, agent: "storm-quick", outcome: "routed" }, undefined));
	expect(refused.ok).toBe(false);
	if (!refused.ok) expect(refused.code).toBe("lane-write");
	// X still holds the path; the refused A holds nothing, so X's own admission is fine and A cannot slip in later.
	expect(work.admitChecked({ spawnKey: x, agent: "storm-implementer", outcome: "routed" }, undefined).ok).toBe(true);
});

test("check, reserve and publish are one synchronous step: two late hooks cannot both pass for overlapping scopes", () => {
	const p = plan(pathLane("A", "quick", ["shared.txt"]), pathLane("B", "implementer", ["shared.txt"]));
	const work = new RunLanes("late-pair");
	const a = idOf(work.assign({ agent: "storm-quick", name: "A", task: "a" }, p, team, { now: T0 }));
	// B can only be placed once A's placement lapsed; both then reach their hooks, A first.
	const b = at(LATE, () => idOf(work.assign({ agent: "storm-implementer", name: "B", task: "b" }, p, team, { now: LATE })));
	const first = at(LATE, () => work.admitChecked({ spawnKey: a, agent: "storm-quick", outcome: "routed" }, undefined));
	const second = at(LATE, () => work.admitChecked({ spawnKey: b, agent: "storm-implementer", outcome: "routed" }, undefined));
	expect([first.ok, second.ok].filter(Boolean)).toHaveLength(1);
});

test("a bound reservation is not pruned by placement age while the worker has not reached the ledger", () => {
	const p = plan(exclusive("x"), exclusive("y"));
	const work = new RunLanes("bound-age");
	const x = idOf(assign(work, p, "x", "storm-implementer", T0));
	expect(work.admitChecked({ spawnKey: x, agent: "storm-implementer", outcome: "routed" })).toEqual({ ok: true, lane: "x" });
	// 31 s after placement the child is still starting (session, extensions, isolation): no ledger row yet.
	const second = assign(work, p, "y", "storm-implementer", LATE);
	expect(refusedWrite(second)).toBe(true);
	// A day later it still has not appeared: only an event ends an admitted worker's reservation.
	expect(refusedWrite(assign(work, p, "y", "storm-implementer", T0 + 24 * 3_600_000))).toBe(true);
});

test("a follow-up's awaiting reservation is not pruned by age before the woken turn starts", () => {
	const p = plan(exclusive("x"), exclusive("y"));
	const work = new RunLanes("follow-age");
	const idle = [agentEntry({ id: "w1", state: "idle" })];
	const follow = work.checkFollowUp({ agentId: "w1", agent: "storm-implementer", role: "implementer", lane: exclusive("x"), policy: { kind: "unknown", reason: "exec" }, isolated: false, agents: idle, now: T0 });
	expect(follow.ok).toBe(true);
	expect(refusedWrite(assign(work, p, "y", "storm-implementer", LATE, idle))).toBe(true);
	// The woken turn starts, runs, and settles: only then is the place free.
	work.agentStarted("w1");
	const running = [agentEntry({ id: "w1", state: "running" })];
	expect(refusedWrite(assign(work, p, "y", "storm-implementer", LATE + 1_000, running))).toBe(true);
	expect(assign(work, p, "y", "storm-implementer", LATE + 2_000, idle).ok).toBe(true);
});

test("an admitted worker whose row says it settled releases its place, and parked or failed counts as settled", () => {
	for (const settled of [
		agentEntry({ state: "idle", requests: 1 }),
		agentEntry({ state: "parked", requests: 0 }),
		agentEntry({ state: "idle", requests: 0, lastWorkFailed: true }),
	]) {
		const p = plan(exclusive("x"), exclusive("y"));
		const work = new RunLanes("settled");
		const x = idOf(assign(work, p, "x", "storm-implementer", T0));
		work.admitChecked({ spawnKey: x, agent: "storm-implementer", outcome: "routed" });
		const row = { ...settled, id: x };
		expect(assign(work, p, "y", "storm-implementer", T0 + 5_000, [row]).ok).toBe(true);
	}
});

test("a fresh worker that shows idle with no request yet and was never seen running still holds its place", () => {
	const p = plan(exclusive("x"), exclusive("y"));
	const work = new RunLanes("not-yet-running");
	const x = idOf(assign(work, p, "x", "storm-implementer", T0));
	work.admitChecked({ spawnKey: x, agent: "storm-implementer", outcome: "routed" });
	const fresh = agentEntry({ id: x, state: "idle", requests: 0 });
	expect(refusedWrite(assign(work, p, "y", "storm-implementer", T0 + 5_000, [fresh]))).toBe(true);
	// Seen running once, it is no longer a fresh start: idle then means its turn settled.
	const running = agentEntry({ id: x, state: "running", requests: 0 });
	expect(refusedWrite(assign(work, p, "y", "storm-implementer", T0 + 6_000, [running]))).toBe(true);
	expect(assign(work, p, "y", "storm-implementer", T0 + 7_000, [fresh]).ok).toBe(true);
});

test("a placement that was never admitted still lapses, and an unplanned child whose placement lapsed is checked again", () => {
	const work = new RunLanes("unplanned-late");
	// Plan-less manual work: the item's generated handle (D6) names the reservation, and omp's spawn key is that handle.
	const solo = work.place({ agent: "storm-implementer", name: "solo", task: "s" }, undefined, team, { now: T0 });
	expect(solo.ok).toBe(true);
	const soloKey = idOf(solo);
	expect(soloKey).not.toBe("solo");
	// Another unknown-scope writer is refused inside the window and allowed once the never-admitted placement lapsed.
	expect(refusedWrite(work.place({ agent: "storm-implementer", name: "other", task: "o" }, undefined, team, { now: T0 + 1_000 }))).toBe(true);
	expect(work.place({ agent: "storm-implementer", name: "other", task: "o" }, undefined, team, { now: LATE }).ok).toBe(true);
	// `solo` now starts late: its scope is checked against `other`, and the pair is refused as a conflict.
	const late = at(LATE, () => work.admitChecked({ spawnKey: soloKey, agent: "storm-implementer", outcome: "routed" }));
	expect(late.ok).toBe(false);
});

test("an unplanned child that starts late with no rival is reserved, so a later writer is refused", () => {
	const work = new RunLanes("unplanned-reserved");
	const solo = work.place({ agent: "storm-implementer", name: "solo", task: "s" }, undefined, team, { now: T0 });
	expect(solo.ok).toBe(true);
	const soloKey = idOf(solo);
	expect(at(LATE, () => work.admitChecked({ spawnKey: soloKey, agent: "storm-implementer", outcome: "routed" })).ok).toBe(true);
	const running = [agentEntry({ id: soloKey, state: "running" })];
	expect(refusedWrite(work.place({ agent: "storm-implementer", name: "next", task: "n" }, undefined, team, { now: LATE + 1_000, agents: running }))).toBe(true);
});

test("a call that failed before admission releases its lapsed placement too, so a late spawn of it finds nothing to revive", () => {
	const p = plan(exclusive("x"), exclusive("y"));
	const work = new RunLanes("call-failed");
	const x = idOf(work.assign({ agent: "storm-implementer", name: "x", task: "x" }, p, team, { now: T0, callId: "call-1" }));
	work.assign({ agent: "storm-explorer", name: "look", task: "look" }, p, team, { now: LATE });
	work.releaseCall("call-1");
	// The call failed: a spawn of x that still arrives is no placement of anyone's, so it is not reserved on its own
	// authority and a writer placed beside it is not refused on its account.
	at(LATE, () => work.admitChecked({ spawnKey: x, agent: "storm-implementer", outcome: "routed" }, undefined));
	const running = [agentEntry({ id: x, state: "running" })];
	expect(assign(work, p, "y", "storm-implementer", LATE + 1_000, running).ok).toBe(true);
});

test("each way a bound reservation ends is reported once, with the worker it belonged to", () => {
	const ends: ReservationEnd[] = [];
	unsubscribe.push(onLaneReservationEnd(end => ends.push(end)));
	const p = plan(exclusive("x"), exclusive("y"));

	// Settled: the director side sees the row.
	const settled = new RunLanes("end-settled");
	const x = idOf(assign(settled, p, "x", "storm-implementer", T0));
	settled.admitChecked({ spawnKey: x, agent: "storm-implementer", outcome: "routed" });
	assign(settled, p, "y", "storm-implementer", T0 + 1_000, [agentEntry({ id: x, state: "idle" })]);
	expect(ends).toContainEqual(expect.objectContaining({ runId: "end-settled", agentId: x, reason: "settled" }));

	// Refused after admission: the hook's later guard blocked the spawn.
	const cancelled = new RunLanes("end-cancelled");
	const placed = cancelled.assign({ agent: "storm-implementer", name: "x", task: "x" }, p, team, { now: T0 });
	const c = idOf(placed);
	const placement = cancelled.placementOf(c);
	cancelled.admitChecked({ spawnKey: c, agent: "storm-implementer", outcome: "routed" });
	cancelled.cancel(c, placement);
	expect(ends).toContainEqual(expect.objectContaining({ runId: "end-cancelled", agentId: c, reason: "cancelled" }));

	// A follow-up whose preflight failed after it reopened the worker's authority.
	const follow = new RunLanes("end-follow");
	const idle = [agentEntry({ id: "w1", state: "idle" })];
	const gate = follow.checkFollowUp({ agentId: "w1", agent: "storm-implementer", role: "implementer", lane: exclusive("x"), policy: { kind: "unknown", reason: "exec" }, isolated: false, agents: idle, now: T0 });
	if (!gate.ok) throw new Error("follow-up refused");
	follow.finishFollowUp(gate.token, false);
	expect(ends).toContainEqual(expect.objectContaining({ runId: "end-follow", agentId: "w1", reason: "follow-up-failed" }));

	// A settled turn event from the child's own thread.
	const event = new RunLanes("end-event");
	const e = idOf(assign(event, p, "x", "storm-implementer", T0));
	event.admitChecked({ spawnKey: e, agent: "storm-implementer", outcome: "routed" });
	event.releaseAgent(e);
	expect(ends).toContainEqual(expect.objectContaining({ runId: "end-event", agentId: e, reason: "settled" }));
});

test("a placement that only lapsed is not reported: no worker held authority behind it", () => {
	const ends: ReservationEnd[] = [];
	unsubscribe.push(onLaneReservationEnd(end => ends.push(end)));
	const p = plan(exclusive("x"));
	const work = new RunLanes("end-lapsed");
	assign(work, p, "x", "storm-implementer", T0);
	work.assign({ agent: "storm-explorer", name: "look", task: "look" }, p, team, { now: LATE });
	expect(ends.filter(end => end.runId === "end-lapsed")).toEqual([]);
});

// R-G1 finding 2 and 4 (0.27.0 integration): the table holds a settled worker's place while the host still reaps for it, and
// every holder that starts meets that place with the same rule a director command meets.
type HostRows = Array<{ id: string; type: string; status: string; agentId?: string }>;
const writer = (name: string): PlanLane => pathLane(name, "implementer", [`${name}.txt`]);
const unknownPolicy = (...names: string[]) => new Map(names.map(name => [name, { kind: "unknown" as const, reason: "x" } satisfies LanePolicy]));

test("a job batch and a required check are refused while a settled worker's place is held until its parent's call ends", () => {
	const p = plan(writer("A"), writer("B"));
	const work = new RunLanes("holders-held", () => []);
	const first = work.place({ agent: "storm-implementer", name: "A", task: "x" }, p, team, { policies: unknownPolicy("A", "B"), callId: "sync-1", now: T0 });
	expect(first.ok).toBe(true);
	if (!first.ok) return;
	const key = String(first.input.name);
	work.admit({ spawnKey: key, agent: "storm-implementer", outcome: "routed" }, { plan: p, config: team });
	work.agentStarted(key);
	work.releaseAgent(key);
	const settled = [agentEntry({ id: key, name: "storm-implementer", role: "implementer", state: "idle", requests: 2, lastActivityAt: T0 + 5 })];
	// The worker's place is held (its call is still open): the same table that refuses a second worker and a director command
	// refuses a job batch and a required check.
	expect(refusedWrite(work.place({ agent: "storm-implementer", name: "B", task: "x" }, p, team, { policies: unknownPolicy("A", "B"), agents: settled, now: T0 + 10 }))).toBe(true);
	expect(work.commitDirectorExec({ callId: "c1", agents: settled, now: T0 + 10 }).ok).toBe(false);
	expect(work.commitHolder({ kind: "job", key: "batch-1", now: T0 + 10, agents: settled }).ok).toBe(false);
	expect(work.commitHolder({ kind: "check", key: "check-1", now: T0 + 10, agents: settled }).ok).toBe(false);
	// The call's end is the receipt: then both are admitted.
	work.callEnded("sync-1");
	expect(work.commitHolder({ kind: "job", key: "batch-2", now: T0 + 20, agents: settled }).ok).toBe(true);
});

test("a host that has job rows but cannot show them keeps a settled async worker's place, as it refuses a director command", () => {
	const rows: { current: HostRows | undefined } = { current: [] };
	const p = plan(writer("A"), writer("B"));
	const work = new RunLanes("rows-unreadable", () => rows.current);
	const first = work.place({ agent: "storm-implementer", name: "A", task: "x" }, p, team, { policies: unknownPolicy("A", "B"), callId: "async-1", now: T0 });
	expect(first.ok).toBe(true);
	if (!first.ok) return;
	const key = String(first.input.name);
	work.admit({ spawnKey: key, agent: "storm-implementer", outcome: "routed" }, { plan: p, config: team });
	work.callEnded("async-1");
	work.agentStarted(key);
	rows.current = undefined;
	work.releaseAgent(key);
	const settled = [agentEntry({ id: key, name: "storm-implementer", role: "implementer", state: "idle", requests: 2, lastActivityAt: T0 + 5 })];
	expect(refusedWrite(work.place({ agent: "storm-implementer", name: "B", task: "x" }, p, team, { policies: unknownPolicy("A", "B"), agents: settled, now: T0 + 10 }))).toBe(true);
	expect(work.commitDirectorExec({ callId: "c1", now: T0 + 10 }).ok).toBe(false);
	// The rows can be read again and show no running task job of A: the place is free.
	rows.current = [];
	expect(work.place({ agent: "storm-implementer", name: "B", task: "x" }, p, team, { policies: unknownPolicy("A", "B"), agents: settled, now: T0 + 20 }).ok).toBe(true);
});

test("a follow-up whose call failed after the woken turn already started keeps its place; one whose turn never started does not", () => {
	const p = plan(writer("A"));
	const work = new RunLanes("follow-failed");
	const lane = p.lanes[0]!;
	const follow = (id: string, callId: string) =>
		work.checkFollowUp({ agentId: id, agent: "storm-implementer", role: "implementer", lane, policy: { kind: "unknown", reason: "x" }, isolated: false, callId, plan: p, config: team, now: T0 });
	const gate = follow("A", "f-1");
	expect(gate.ok).toBe(true);
	if (gate.ok) work.finishFollowUp(gate.token, true);
	// The call ended in an error after omp delivered the message, and the list already shows the worker running.
	work.releaseCall("f-1", new Set(["A"]));
	expect(refusedWrite(work.assign({ agent: "storm-implementer", task: "other", name: "A2" }, plan(writer("A2")), team, { now: T0 + 1, agents: [agentEntry({ id: "A", name: "storm-implementer", role: "implementer", state: "running" })] }))).toBe(true);
	// A second follow-up on a fresh table whose turn never started is released with its call, as before.
	const other = new RunLanes("follow-failed-2");
	const second = other.checkFollowUp({ agentId: "A", agent: "storm-implementer", role: "implementer", lane, policy: { kind: "unknown", reason: "x" }, isolated: false, callId: "f-2", plan: p, config: team, now: T0 });
	expect(second.ok).toBe(true);
	if (second.ok) other.finishFollowUp(second.token, true);
	other.releaseCall("f-2", new Set());
	expect(other.assign({ agent: "storm-implementer", task: "other", name: "A2" }, plan(writer("A2")), team, { now: T0 + 1 }).ok).toBe(true);
});

test("a director path edit's hold is not a placement: no clock value lapses it, and it meets every writer that starts at any time", () => {
	const p = plan(exclusive("X"), pathLane("A", "quick", ["a.ts"]), pathLane("B", "implementer", ["b.ts"]));
	const work = new RunLanes("director-lifetime");
	expect(work.commitWriter({ kind: "director-path", callId: "e1", paths: ["a.ts"], live: () => ({ ok: true }), now: T0 })).toEqual({ ok: true });
	for (const now of [T0 + 1, T0 + PENDING_WRITE_MS - 1, T0 + PENDING_WRITE_MS, LATE, LATE * 1_000]) {
		expect(refusedWrite(assign(work, p, "A", "storm-quick", now))).toBe(true);
		expect(refusedWrite(assign(work, p, "X", "storm-implementer", now))).toBe(true);
		expect(work.takeWriterFreed([], now)).toBe(false);
	}
	// Other files were never in its way, whenever they start.
	expect(assign(work, p, "B", "storm-implementer", LATE * 1_000).ok).toBe(true);
	// Only the end of the turn that made the call frees the files.
	expect(work.releaseDirectorCalls(["e1"])).toBe(1);
	expect(assign(work, p, "A", "storm-quick", LATE * 1_000 + 1).ok).toBe(true);
});

test("a worker's late admission is checked against a director edit made while its placement had lapsed, and the edit stays", () => {
	const p = plan(pathLane("A", "quick", ["a.ts"]));
	const work = new RunLanes("director-late");
	const id = idOf(assign(work, p, "A", "storm-quick", T0));
	expect(work.commitWriter({ kind: "director-path", callId: "e1", paths: ["a.ts"], live: () => ({ ok: true }), now: LATE })).toEqual({ ok: true });
	const admitted = at(LATE, () => work.admitChecked({ spawnKey: id, agent: "storm-quick", outcome: "routed" }, { plan: p, config: team }));
	expect(admitted).toMatchObject({ ok: false, code: "lane-write" });
	expect(work.liveHolders(["director-path"])).toBe(1);
});
