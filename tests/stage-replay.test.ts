/**
 * B4 record consistency: the stage never shows what the record does not say.
 *
 * Each case is a run told as ledger changes over time (`Ledger`): plans, spawns, deliveries, judgments, blocks,
 * refusals, phases, rounds, spend, the user's direct turns and stops, exclusions. Every change is one observation of
 * the run record by the real lane timeline (`LaneTimeline`), exactly as the live widget feeds it; between them the
 * stage is driven frame by frame (85 ms for a few seconds after a change, then every half second) through the real
 * sequencer (`stageAt`) and scene (`stageScene`). Every frame is checked against the record as it stood at that time:
 *
 * - an act of a lane plays only when the record says so for that lane at the act's arrival: accept only for a lane
 *   whose in-scope rows are all accepted, unmet only with an unmet row, submit only with a reviewable row, blocked
 *   only with a blocked row, a refused placement or a failed job, start only after a worker or job of that lane started,
 *   a user turn or stop only at the moment the ledger counted it;
 * - the finale only while every in-scope result is met and the run is stopping; lights out only while stopping;
 * - the waiting pose, the amber and the waiting act only in the waiting-user phase;
 * - no accept, unmet, submit, finale, lights-out, waiting, round, budget or user act for history that was already
 *   settled when the view first saw the run (the view opened late);
 * - the accents keep their meaning: a red edge only on a blocked lane, a green flash or accept burst only while an
 *   acceptance plays, a bolt only while a block plays, an accepted piece only for an accepted row, the rainbow only
 *   for a complete stopping run, the dimmed light only past the budget's warning line;
 * - an act seen playing never jumps in time (a later frame of the same event at another start would restart it).
 *
 * The first case replays the director's real run of 2026-11-26 (14:16:51 to 14:56:06; the plans, lanes, result ids
 * and times of `real-run-replay.test.ts`), then closes it with a review, a round, a wait and an exclusion that were
 * not in the real run, ending in lights out. Set `STAGE_REPLAY_REPORT=1` to print each case's acts against its ledger
 * events.
 */
import { describe, expect, test } from "bun:test";
import type { RunPhase } from "../src/view/appearance.ts";
import type { LaneSnapshot } from "../src/view/lane/model.ts";
import { LaneTimeline } from "../src/view/lane/timeline.ts";
import type { Species } from "../src/view/stage/cast.ts";
import { stageScene } from "../src/view/stage/scene.ts";
import { type ActKind, stageAt, stagePlan } from "../src/view/stage/sequencer.ts";
import type { AgentEntry, PlanLane, RunJob, RunRecord, RunResult, SpawnRecord } from "../src/types.ts";
import { agentEntry, runRecord, spawnRecord } from "./fixtures.ts";

const START = Date.parse("2026-11-26T14:16:51+09:00");
const iso = (offset: number): string => new Date(START + offset).toISOString();
/** Offset of a wall-clock time of the real run (Korean time). */
const K = (hms: string): number => Date.parse(`2026-11-26T${hms}+09:00`) - START;

type Role = "implementer" | "explorer" | "reviewer" | "quick";
type LedgerKind = ActKind | "replan";
interface LedgerEvent { kind: LedgerKind; at: number; lane?: string }

/** The run record as Storm keeps it, changed one ledger event at a time. */
class Ledger {
	at = 0;
	phase: RunPhase = "working";
	lanes: PlanLane[] = [];
	submittedAt: string | undefined;
	readonly results = new Map<string, RunResult>();
	readonly agents = new Map<string, AgentEntry>();
	readonly agentLane = new Map<string, string>();
	readonly spawns: SpawnRecord[] = [];
	readonly jobs: RunJob[] = [];
	turns = 0;
	costUsd = 0;
	budget: RunRecord["budget"];
	status: RunRecord["status"] = "running";
	readonly events: LedgerEvent[] = [];
	readonly #started = new Set<string>();

	constructor(readonly resumeOf?: string) {}

	emit(kind: LedgerKind, lane?: string): void {
		this.events.push({ kind, at: this.at, ...(lane === undefined ? {} : { lane }) });
	}

	/** A plan; the same result id keeps its row when it moves to another lane, a dropped one leaves. */
	plan(lanes: PlanLane[]): void {
		const before = this.lanes.map(lane => lane.name).sort().join("\n");
		this.lanes = lanes;
		this.submittedAt = iso(this.at);
		const declared = new Map<string, string>();
		for (const lane of lanes) for (const result of lane.results ?? []) declared.set(result.id, lane.name);
		for (const id of [...this.results.keys()]) if (!declared.has(id)) this.results.delete(id);
		for (const [id, lane] of declared) {
			const row = this.results.get(id);
			if (row === undefined) this.results.set(id, { id, lane, state: "pending" });
			else row.lane = lane;
		}
		const after = lanes.map(lane => lane.name).sort().join("\n");
		if (before !== "" && before !== after) this.emit("replan");
	}

	/** A worker placed on a lane (or outside the plan when `lane` is undefined); `refused` when the hook refused it. */
	spawn(lane: string | undefined, id: string, role: Role, refused = false): void {
		this.spawns.push(spawnRecord({ spawnKey: id, agent: `storm-${role}`, role, ts: iso(this.at), outcome: refused ? "blocked" : "routed", ...(lane === undefined ? {} : { lane }) }));
		const row = lane ?? id;
		if (refused) return this.emit("blocked", row);
		this.agents.set(id, agentEntry({ id, name: `storm-${role}`, role, state: "running", startedAt: START + this.at, lastActivityAt: START + this.at }));
		this.agentLane.set(id, row);
		if (!this.#started.has(row)) this.emit("start", row);
		this.#started.add(row);
	}

	#agent(id: string, over: Partial<AgentEntry>): void {
		const agent = this.agents.get(id);
		if (agent === undefined) throw new Error(`no agent ${id}`);
		this.agents.set(id, { ...agent, ...over });
	}

	touch(id: string): void {
		this.#agent(id, { lastActivityAt: START + this.at });
	}

	followUp(id: string): void {
		const agent = this.agents.get(id)!;
		this.#agent(id, { state: "running", lastActivityAt: START + this.at, followUps: agent.followUps + 1 });
	}

	settle(id: string): void {
		this.#agent(id, { state: "idle" });
	}

	/** The worker's answer lands on its rows and its turn ends. */
	deliver(id: string, rows: readonly string[], state: "reviewable" | "unmet"): void {
		this.settle(id);
		for (const rowId of rows) this.#row(rowId, state);
	}

	judge(rowId: string, state: "accepted" | "unmet"): void {
		this.#row(rowId, state);
	}

	#row(rowId: string, state: RunResult["state"]): void {
		const row = this.results.get(rowId);
		if (row === undefined) throw new Error(`no row ${rowId}`);
		row.state = state;
		this.emit(state === "accepted" ? "accept" : state === "unmet" ? "unmet" : "submit", row.lane);
	}

	/** A known structured refusal: the row cannot continue until something outside the team changes. */
	block(rowId: string): void {
		const row = this.results.get(rowId)!;
		row.remedy = "blocked";
		for (const [id, lane] of this.agentLane) if (lane === row.lane && this.agents.get(id)!.state === "running") this.settle(id);
		this.emit("blocked", row.lane);
	}

	exclude(rowId: string): void {
		this.results.get(rowId)!.scope = "excluded-by-user";
	}

	setPhase(phase: RunPhase): void {
		if (phase === this.phase) return;
		this.phase = phase;
		if (phase === "waiting-user") this.emit("waiting");
		if (phase === "stopping") this.emit(this.complete() ? "finale" : "lights-out");
	}

	round(): void {
		this.turns++;
		this.emit("round");
	}

	spend(usd: number): void {
		const warn = this.budget?.warnAtUsd ?? Number.POSITIVE_INFINITY;
		if (this.costUsd < warn && usd >= warn) this.emit("budget");
		this.costUsd = usd;
	}

	steer(id: string): void {
		const agent = this.agents.get(id)!;
		this.#agent(id, { userTurns: (agent.userTurns ?? 0) + 1, state: "running", lastActivityAt: START + this.at });
		this.emit("user-steer", this.agentLane.get(id));
	}

	stop(id: string): void {
		const agent = this.agents.get(id)!;
		this.#agent(id, { userStops: (agent.userStops ?? 0) + 1, state: "idle" });
		this.emit("user-stop", this.agentLane.get(id));
	}

	job(lane: string, status: RunJob["status"]): void {
		const existing = this.jobs.findIndex(job => job.lane === lane);
		const startedAt = existing >= 0 ? this.jobs[existing]!.startedAt : iso(this.at);
		const job: RunJob = { lane, name: lane, status, exitCode: status === "passed" ? 0 : null, startedAt, finishedAt: status === "started" ? null : iso(this.at) };
		if (existing >= 0) this.jobs[existing] = job;
		else this.jobs.push(job);
		if (status === "started" && !this.#started.has(lane)) {
			this.#started.add(lane);
			this.emit("start", lane);
		}
		if (status === "spawn-error") this.emit("blocked", lane);
	}

	complete(): boolean {
		const inScope = [...this.results.values()].filter(row => row.scope === undefined);
		return inScope.length > 0 && inScope.every(row => row.state === "accepted");
	}

	record(): RunRecord {
		return structuredClone(runRecord({
			status: this.status,
			startedAt: iso(0),
			...(this.lanes.length === 0 ? {} : { plan: { lanes: this.lanes, workers: {}, submittedAt: this.submittedAt! } }),
			results: [...this.results.values()],
			agents: [...this.agents.values()],
			spawns: this.spawns,
			jobs: this.jobs,
			turns: this.turns,
			costUsd: this.costUsd,
			...(this.budget === undefined ? {} : { budget: this.budget }),
			...(this.resumeOf === undefined ? {} : { resumeOf: this.resumeOf }),
		}));
	}
}

type Step = readonly [at: number, change: (ledger: Ledger) => void];

/** What the record said at one moment. */
interface Truth { at: number; phase: RunPhase; record: RunRecord }

const rowsOf = (truth: Truth, lane: string): RunResult[] => (truth.record.results ?? []).filter(row => row.lane === lane);
const inScope = (rows: readonly RunResult[]): RunResult[] => rows.filter(row => row.scope === undefined);
function allAccepted(truth: Truth, lane: string): boolean {
	const rows = inScope(rowsOf(truth, lane));
	return rows.length > 0 && rows.every(row => row.state === "accepted");
}
const hasRow = (truth: Truth, lane: string, state: RunResult["state"]): boolean => inScope(rowsOf(truth, lane)).some(row => row.state === state);
function blockedNow(truth: Truth, lane: string): boolean {
	return rowsOf(truth, lane).some(row => row.remedy === "blocked" && row.state !== "accepted")
		|| truth.record.spawns.some(spawn => spawn.lane === undefined && spawn.spawnKey === lane && spawn.outcome === "blocked")
		|| (truth.record.jobs ?? []).some(job => job.lane === lane && job.status === "spawn-error");
}
function complete(truth: Truth): boolean {
	const rows = inScope(truth.record.results ?? []);
	return rows.length > 0 && rows.every(row => row.state === "accepted");
}
const warned = (truth: Truth): boolean => truth.record.budget?.warnAtUsd !== undefined && truth.record.costUsd >= truth.record.budget.warnAtUsd;

interface ActCount { kind: LedgerKind; acts: number; actLanes: number; ledger: number }
interface ReplayResult {
	violations: string[];
	counts: ActCount[];
	species: Species[];
	/** Distinct acts seen playing: kind, start, lane names. */
	acts: { kind: ActKind; at: number; lanes: string[] }[];
	frames: number;
}

const STAGE = { cols: 40, rows: 7 } as const;
const TICK = 85;
const DENSE_MS = 6_000;
const SPARSE_MS = 500;

/**
 * Plays `steps` against a live lane timeline and the stage; the view first observes the run at `open` (default: the
 * first step) and is driven until `end`.
 */
function replay(steps: readonly Step[], options: { open?: number; end: number; resumeOf?: string }): ReplayResult {
	const ledger = new Ledger(options.resumeOf);
	const truths: Truth[] = [];
	const ordered = [...steps].sort((a, b) => a[0] - b[0]);
	for (const [at, change] of ordered) {
		ledger.at = at;
		change(ledger);
		truths.push({ at, phase: ledger.phase, record: ledger.record() });
	}
	const open = options.open ?? ordered[0]![0];
	const truthAt = (t: number): Truth => {
		let found = truths[0]!;
		for (const truth of truths) if (truth.at <= t) found = truth;
		return found;
	};
	/** Since when, up to `t`, the predicate held without a break. */
	const since = (t: number, holds: (truth: Truth) => boolean): number => {
		let from = t;
		for (let i = truths.length - 1; i >= 0; i--) {
			const truth = truths[i]!;
			if (truth.at > t) continue;
			if (!holds(truth)) break;
			from = truth.at;
		}
		return from;
	};
	const ledgerAt = (kind: LedgerKind, at: number, lane?: string): LedgerEvent | undefined =>
		ledger.events.find(event => event.kind === kind && event.at === at && (lane === undefined || event.lane === lane));

	// The view observes the record as it stood at `open`, then every later change at its time.
	const observations = truths.filter(truth => truth.at > open);
	observations.unshift({ ...truthAt(open), at: open });
	const times = new Set<number>();
	for (const truth of observations) for (let t = truth.at; t <= Math.min(options.end, truth.at + DENSE_MS); t += TICK) times.add(t);
	for (let t = open; t <= options.end; t += SPARSE_MS) times.add(t);
	const frames = [...times].sort((a, b) => a - b);

	const timeline = new LaneTimeline();
	const violations: string[] = [];
	const fail = (t: number, what: string): void => {
		if (violations.length < 40) violations.push(`${(t / 1000).toFixed(3)}s: ${what}`);
	};
	const seen = new Map<string, { kind: ActKind; at: number; lanes: Set<string> }>();
	const starts = new Map<string, Set<number>>();
	const species: Species[] = [];
	let next = 0;
	for (const t of frames) {
		while (next < observations.length && observations[next]!.at <= t) {
			const truth = observations[next++]!;
			timeline.observe(truth.record, truth.phase, START + truth.at);
		}
		const snapshot: LaneSnapshot = timeline.snapshot(START + t);
		const moment = stageAt(snapshot, snapshot.now, true);
		const scene = stageScene({ snapshot, moment, cols: STAGE.cols, rows: STAGE.rows, t, motion: true });
		const truth = truthAt(t);
		const name = (lane: number): string => snapshot.lanes[lane]?.name ?? `#${lane}`;
		if (species[species.length - 1] !== moment.species) species.push(moment.species);

		for (const { act, lanes } of moment.acts) {
			const key = `${act.kind}@${act.cause}`;
			let entry = seen.get(key);
			if (entry === undefined) seen.set(key, (entry = { kind: act.kind, at: act.at, lanes: new Set() }));
			const lanesArrivals = lanes.map(lane => [name(lane), act.arrivals[act.lanes.indexOf(lane)]!] as const);
			const ids = lanesArrivals.length === 0 ? [`${act.kind}@${act.cause}`] : lanesArrivals.map(([lane, arrival]) => `${act.kind}/${lane}@${arrival}`);
			for (const id of ids) {
				const at = starts.get(id) ?? new Set<number>();
				at.add(act.at);
				starts.set(id, at);
				if (at.size > 1) fail(t, `${id} was seen playing from ${[...at].join(" and ")}: the act jumped`);
			}
			for (const [lane, arrival] of lanesArrivals) {
				entry.lanes.add(lane);
				const then = truthAt(arrival);
				const lateFor = (holds: (truth: Truth) => boolean): boolean => since(arrival, holds) < open;
				switch (act.kind) {
					case "accept":
						if (!allAccepted(then, lane)) fail(t, `accept for ${lane} at ${arrival} but its rows were not all accepted`);
						else if (lateFor(truth => allAccepted(truth, lane))) fail(t, `accept for ${lane}, accepted before the view opened`);
						break;
					case "unmet":
						if (!hasRow(then, lane, "unmet")) fail(t, `unmet for ${lane} at ${arrival} without an unmet row`);
						else if (lateFor(truth => hasRow(truth, lane, "unmet"))) fail(t, `unmet for ${lane}, unmet before the view opened`);
						break;
					case "submit":
						if (!hasRow(then, lane, "reviewable")) fail(t, `submit for ${lane} at ${arrival} without a reviewable row`);
						else if (lateFor(truth => hasRow(truth, lane, "reviewable"))) fail(t, `submit for ${lane}, submitted before the view opened`);
						break;
					case "blocked":
						if (!blockedNow(then, lane)) fail(t, `blocked for ${lane} at ${arrival} but nothing blocked it`);
						break;
					case "start":
						if (!ledger.events.some(event => event.kind === "start" && event.lane === lane && event.at <= arrival)) fail(t, `start for ${lane} at ${arrival} before any worker or job of it started`);
						break;
					case "user-steer":
					case "user-stop":
						if (ledgerAt(act.kind, arrival, lane) === undefined) fail(t, `${act.kind} for ${lane} at ${arrival} without that ledger event`);
						else if (arrival < open) fail(t, `${act.kind} for ${lane} from before the view opened`);
						break;
					default:
						fail(t, `${act.kind} names lane ${lane}`);
				}
			}
			const cause = act.cause;
			switch (act.kind) {
				case "waiting":
					if (truthAt(cause).phase !== "waiting-user") fail(t, `waiting act at ${cause} outside the waiting-user phase`);
					else if (since(cause, truth => truth.phase === "waiting-user") < open) fail(t, "waiting act for a wait that began before the view opened");
					break;
				case "finale":
					if (truth.phase !== "stopping" || !complete(truth)) fail(t, `finale while the record is ${truth.phase}, complete ${complete(truth)}`);
					else if (since(t, truth => truth.phase === "stopping" && complete(truth)) < open) fail(t, "finale for a run that had finished before the view opened");
					break;
				case "lights-out":
					if (truth.phase !== "stopping") fail(t, `lights out while the record is ${truth.phase}`);
					else if (since(t, truth => truth.phase === "stopping") < open) fail(t, "lights out for a run that was stopping before the view opened");
					break;
				case "round":
					if (ledgerAt("round", cause) === undefined) fail(t, `round act at ${cause} without a new round then`);
					else if (cause < open) fail(t, "round act for a round before the view opened");
					break;
				case "budget": {
					if (!warned(truthAt(cause))) fail(t, `budget act at ${cause} before spend reached the warning line`);
					const crossed = ledger.events.find(event => event.kind === "budget");
					if (crossed !== undefined && crossed.at < open) fail(t, `budget act at ${cause} for a line crossed at ${crossed.at}, before the view opened`);
					break;
				}
			}
		}

		// The scene's accents and poses against the record of this moment.
		const playing = (kind: ActKind, lane?: number): boolean => moment.acts.some(item => item.act.kind === kind && (lane === undefined || item.lanes.includes(lane)));
		for (const item of scene.individuals) {
			const pose = item.seq.split("/")[2];
			const who = item.lane < 0 ? "director" : name(item.lane);
			if ((item.amber === true || pose === "waiting-user") && truth.phase !== "waiting-user") fail(t, `${who} shows the waiting pose/amber in phase ${truth.phase}`);
			if (pose === "finale" && !(truth.phase === "stopping" && complete(truth))) fail(t, `${who} plays the finale pose in ${truth.phase}, complete ${complete(truth)}`);
			if (pose === "lights-out" && truth.phase !== "stopping") fail(t, `${who} plays lights out in ${truth.phase}`);
			if (item.blocked === true && !blockedNow(truth, who)) fail(t, `${who} has the red edge but is not blocked in the record`);
			if ((item.flash ?? 0) > 0 && !playing("accept", item.lane)) fail(t, `${who} flashes green without an acceptance playing`);
		}
		for (const piece of scene.pieces) {
			if (piece.state !== "accepted" || piece.excluded) continue;
			const row = truth.record.results?.find(candidate => candidate.id === piece.id);
			if (row?.state !== "accepted") fail(t, `piece ${piece.id} drawn accepted, the record says ${row?.state}`);
		}
		if (scene.bursts.some(burst => burst.kind === "accept") && !playing("accept")) fail(t, "accept burst without an acceptance playing");
		if (scene.bolts.length > 0 && !playing("blocked")) fail(t, "bolt without a block playing");
		if (scene.rainbow !== undefined && !(truth.phase === "stopping" && complete(truth))) fail(t, "rainbow without a complete stopping run");
		if (moment.dim && !warned(truth)) fail(t, "light dimmed before spend reached the warning line");
	}

	const acts = [...seen.values()].map(item => ({ kind: item.kind, at: item.at, lanes: [...item.lanes] }));
	const kinds = new Set<LedgerKind>([...ledger.events.map(event => event.kind), ...acts.map(act => act.kind)]);
	const counts = [...kinds].sort().map(kind => ({
		kind,
		acts: acts.filter(act => act.kind === kind).length,
		actLanes: acts.filter(act => act.kind === kind).reduce((sum, act) => sum + act.lanes.length, 0),
		ledger: ledger.events.filter(event => event.kind === kind && event.at >= open).length,
	}));
	if (process.env.STAGE_REPLAY_REPORT === "1") {
		console.log(`frames ${frames.length}, open at ${open} ms, species ${species.join(" > ")}`);
		console.table(counts);
		for (const act of acts) console.log(`  ${(act.at / 1000).toFixed(2).padStart(8)}s ${act.kind.padEnd(10)} ${act.lanes.join(", ")}`);
	}
	return { violations, counts, species, acts, frames: frames.length };
}

// ---------------------------------------------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------------------------------------------

const answer = (id: string) => ({ id, kind: "answer" as const, criterion: id });
function lane(name: string, role: Role, results: readonly string[], extra: Partial<PlanLane> = {}): PlanLane {
	const kind = role === "explorer" ? "explore" : role === "reviewer" ? "review" : role === "quick" ? "run" : "code";
	return { name, kind, role, goal: `deliver ${name}`, results: results.map(answer), ...extra };
}
const dir = (name: string): string[] => [`.local-ops/benchmarks/${name}`];
const BODY = "qat-body-device";
const HEAD = "qat-head-device";
const RAM = "memory-handoff-device";
const CLAW = "claw-producer-provenance";
const HEAD_CONTROL = "head-control-source";
const HANDOFF_CONTROL = "handoff-control-source";
const WHOLE = ["qat-whole-generation", "matched-december-comparison"];
const integrate = (deps: readonly string[]): PlanLane =>
	lane("IntegrateGemmaQat", "implementer", WHOLE, { files: ["knowledge/genai/k0-index.md"], dependsOn: deps.map(name => ({ lane: name, need: "result" as const })) });

const P1 = [
	lane("GemmaQatBody", "implementer", [BODY]), lane("GemmaQatHead", "implementer", [HEAD]), lane("GemmaMemoryHandoff", "implementer", [RAM]),
	lane("TraceClawQatProducer", "explorer", [CLAW]), integrate(["GemmaQatBody", "GemmaQatHead", "GemmaMemoryHandoff"]),
];
const P2 = [
	lane("BuildGemmaBodyQat", "implementer", [BODY], { files: dir("gemma4-body-qat") }), lane("BuildGemmaQatHead", "implementer", [HEAD], { files: dir("gemma4-head-qat") }),
	lane("TestGemmaRamHandoff", "implementer", [RAM], { files: dir("gemma4-ram-handoff") }), lane("TraceClawQatProducer", "explorer", [CLAW]),
	integrate(["BuildGemmaBodyQat", "BuildGemmaQatHead", "TestGemmaRamHandoff"]),
];
const P3 = [
	lane("BuildGemmaBodyQat", "implementer", [BODY], { files: dir("gemma4-body-qat") }),
	lane("TrialGemmaQatHead", "implementer", [HEAD], { files: dir("gemma4-head-qat"), isolationReason: "the head trial needs no shared tracked tree" }),
	lane("TrialGemmaRamHandoff", "implementer", [RAM], { files: dir("gemma4-ram-handoff"), isolationReason: "the handoff trial only reads existing models" }),
	lane("TraceClawQatProducer", "explorer", [CLAW]), integrate(["BuildGemmaBodyQat", "TrialGemmaQatHead", "TrialGemmaRamHandoff"]),
];
const P4 = (need: "result" | "reviewable", edges = true): PlanLane[] => [
	lane("BuildGemmaBodyQat", "implementer", [BODY], { files: dir("gemma4-body-qat") }),
	lane("PinGemmaHeadControl", "explorer", [HEAD_CONTROL]),
	lane("PinGemmaHandoffControl", "explorer", [HANDOFF_CONTROL]),
	lane("BuildGemmaQatHeadShared", "implementer", [HEAD], { files: dir("gemma4-head-qat"), ...(edges ? { dependsOn: [{ lane: "PinGemmaHeadControl", need }] } : {}) }),
	lane("TestGemmaRamHandoffShared", "implementer", [RAM], {
		files: dir("gemma4-ram-handoff"),
		...(edges ? { dependsOn: [{ lane: "PinGemmaHandoffControl", need }, { lane: "BuildGemmaQatHeadShared", need }] } : {}),
	}),
	lane("TraceClawQatProducer", "explorer", [CLAW]),
	integrate(["BuildGemmaBodyQat", "BuildGemmaQatHeadShared", "TestGemmaRamHandoffShared"]),
];

/** The real run's first forty minutes, then a close that was not in it (from 14:57). */
const REAL_RUN: Step[] = [
	[K("14:16:51"), l => l.plan(P1)],
	[K("14:18:50"), l => l.plan(P2)],
	[K("14:20:28"), l => { l.spawn("BuildGemmaBodyQat", "Body", "implementer"); l.setPhase("workers"); }],
	[K("14:21:38"), l => l.plan(P3)],
	[K("14:22:17"), l => l.touch("Body")],
	[K("14:23:58"), l => {
		l.plan(P4("result"));
		l.spawn("PinGemmaHeadControl", "HeadControl", "explorer");
		l.spawn("PinGemmaHandoffControl", "HandoffControl", "explorer");
		l.spawn("TraceClawQatProducer", "Claw", "explorer");
	}],
	[K("14:25:09"), l => l.touch("Body")],
	[K("14:25:55"), l => l.deliver("Claw", [CLAW], "reviewable")],
	[K("14:26:51"), l => l.followUp("Claw")],
	[K("14:27:06"), l => l.deliver("Claw", [CLAW], "reviewable")],
	[K("14:29:23"), l => l.deliver("HandoffControl", [HANDOFF_CONTROL], "reviewable")],
	[K("14:29:48"), l => l.deliver("HeadControl", [HEAD_CONTROL], "unmet")],
	[K("14:30:50"), l => { l.followUp("HandoffControl"); l.followUp("HeadControl"); }],
	[K("14:31:06"), l => l.deliver("HandoffControl", [HANDOFF_CONTROL], "reviewable")],
	[K("14:31:16"), l => l.deliver("HeadControl", [HEAD_CONTROL], "unmet")],
	[K("14:40:27"), l => l.followUp("HeadControl")],
	[K("14:40:37"), l => l.deliver("HeadControl", [HEAD_CONTROL], "unmet")],
	[K("14:45:17"), l => l.plan(P4("reviewable"))],
	[K("14:52:40"), l => l.followUp("HeadControl")],
	[K("14:52:53"), l => l.deliver("HeadControl", [HEAD_CONTROL], "reviewable")],
	[K("14:53:42"), l => l.plan(P4("result", false))],
	[K("14:55:41"), l => l.deliver("Body", [BODY], "reviewable")],
	[K("14:56:06"), l => l.spawn("BuildGemmaQatHeadShared", "HeadShared", "implementer")],
	// Not in the real run: the director's review, a round, a wait for the user's scope decision, lights out.
	[K("14:57:00"), l => { l.setPhase("verifying"); l.spawn(undefined, "Judge", "reviewer"); }],
	[K("14:58:10"), l => { l.judge(CLAW, "accepted"); l.judge(HANDOFF_CONTROL, "accepted"); }],
	[K("14:58:11"), l => l.judge(HEAD_CONTROL, "accepted")],
	[K("14:58:12"), l => l.judge(BODY, "accepted")],
	[K("14:58:30"), l => l.settle("Judge")],
	[K("15:00:00"), l => l.deliver("HeadShared", [HEAD], "unmet")],
	[K("15:01:00"), l => { l.round(); l.setPhase("between-rounds"); }],
	[K("15:01:30"), l => l.setPhase("working")],
	[K("15:02:00"), l => l.setPhase("waiting-user")],
	[K("15:03:00"), l => { l.exclude(RAM); for (const id of WHOLE) l.exclude(id); l.setPhase("working"); }],
	[K("15:03:10"), l => l.setPhase("stopping")],
	[K("15:03:20"), l => { l.status = "done"; }],
];
const REAL_END = K("15:03:30");

/** Every acting event in one complete run, through every working species. Offsets in ms. */
const EVERY_ACT: Step[] = [
	[0, l => {
		l.budget = { perRunUsd: 5, warnAtUsd: 4, onExceed: "block-spawns" };
		l.plan([lane("Scan", "explorer", ["r-scan"]), lane("Docs", "explorer", ["r-docs"])]);
	}],
	[1_000, l => { l.spawn("Scan", "Scan", "explorer"); l.spawn("Docs", "Docs", "explorer"); l.setPhase("workers"); }],
	[2_000, l => l.spend(1)],
	// The plan's lane set changes: the starlings gather again; a reader and two writers make an octopus.
	[5_000, l => {
		l.plan([
			lane("Scan", "explorer", ["r-scan"]), lane("Docs", "explorer", ["r-docs"]),
			lane("Api", "implementer", ["r-api1", "r-api2"], { files: ["src/api.ts"] }), lane("Infra", "implementer", ["r-infra"], { files: ["infra.ts"] }),
			lane("Lint", "quick", ["r-lint"], { job: "lint" }),
		]);
		l.spawn("Api", "Api", "implementer");
		l.spawn("Infra", "Infra", "implementer");
	}],
	[9_000, l => l.steer("Api")],
	[10_000, l => { l.deliver("Scan", ["r-scan"], "reviewable"); l.deliver("Docs", ["r-docs"], "reviewable"); }],
	[10_200, l => l.touch("Api")],
	[11_000, l => l.job("Lint", "started")],
	[12_000, l => l.block("r-infra")],
	[14_000, l => { l.job("Lint", "passed"); l.results.get("r-lint")!.state = "reviewable"; l.emit("submit", "Lint"); }],
	[16_000, l => l.deliver("Api", ["r-api1", "r-api2"], "reviewable")],
	// The director's reviewer: orca.
	[16_500, l => { l.setPhase("verifying"); l.spawn(undefined, "Judge", "reviewer"); }],
	[18_000, l => { l.judge("r-scan", "accepted"); l.judge("r-docs", "accepted"); l.judge("r-lint", "accepted"); }],
	[18_300, l => { l.judge("r-api1", "accepted"); l.judge("r-api2", "unmet"); }],
	[19_000, l => l.settle("Judge")],
	[20_000, l => l.spawn(undefined, "Rogue", "implementer", true)],
	// A wait cuts in.
	[21_000, l => l.setPhase("waiting-user")],
	[25_000, l => { l.setPhase("workers"); l.followUp("Api"); }],
	[26_000, l => l.stop("Api")],
	[27_000, l => l.spawn("Api", "Api2", "implementer")],
	[29_000, l => { l.round(); l.setPhase("between-rounds"); }],
	[30_000, l => l.setPhase("workers")],
	[31_000, l => l.spend(4.5)],
	[33_000, l => l.deliver("Api2", ["r-api2"], "reviewable")],
	[34_000, l => l.judge("r-api2", "accepted")],
	[36_000, l => l.exclude("r-infra")],
	[37_000, l => l.setPhase("stopping")],
	[38_000, l => { l.status = "done"; }],
];

/** A continued run: one lane was accepted in the earlier run and is seen accepted from the first look. */
const RESUMED: Step[] = [
	[0, l => {
		l.plan([lane("Kept", "implementer", ["r-kept"], { files: ["a.ts"] }), lane("Next", "implementer", ["r-next"], { files: ["b.ts"] })]);
		l.results.get("r-kept")!.state = "accepted";
		l.spawns.push(spawnRecord({ spawnKey: "Old", lane: "Kept", ts: iso(-60_000) }));
		l.agents.set("Old", agentEntry({ id: "Old", state: "idle", startedAt: START - 60_000, lastActivityAt: START - 30_000 }));
	}],
	[2_000, l => { l.spawn("Next", "Next", "implementer"); l.setPhase("workers"); }],
	[5_000, l => l.deliver("Next", ["r-next"], "reviewable")],
	[7_000, l => l.judge("r-next", "accepted")],
	[9_000, l => l.setPhase("stopping")],
	[9_500, l => { l.status = "done"; }],
];

const expectClean = (result: ReplayResult): void => expect(result.violations).toEqual([]);

describe("record consistency: every act the stage plays has its ledger event", () => {
	test("the real run of 2026-11-26, then a close that ends in lights out", () => {
		const result = replay(REAL_RUN, { end: REAL_END });
		expectClean(result);
		const kinds = new Set(result.acts.map(act => act.kind));
		for (const kind of ["start", "submit", "unmet", "accept", "round", "waiting", "lights-out"] as const) expect(kinds).toContain(kind);
		expect(kinds).not.toContain("finale");
		// The three replans of the first hour each gathered the team again.
		expect(result.species.filter(item => item === "starling").length).toBeGreaterThanOrEqual(3);
		// Four rows accepted within two seconds: one acceptance merges what came within half a second, the rest wait
		// for the accent budget; no lane is accepted twice and none without its row.
		const accepted = result.acts.filter(act => act.kind === "accept").flatMap(act => act.lanes).sort();
		expect(accepted).toEqual(["BuildGemmaBodyQat", "PinGemmaHandoffControl", "PinGemmaHeadControl", "TraceClawQatProducer"]);
	});

	test("every acting event of a complete run: start, submit, accept, unmet, blocked, refused, wait, round, budget, user turn and stop, replan, finale", () => {
		const result = replay(EVERY_ACT, { end: 46_000 });
		expectClean(result);
		const kinds = new Set(result.acts.map(act => act.kind));
		for (const kind of ["start", "submit", "accept", "unmet", "blocked", "waiting", "round", "budget", "user-steer", "user-stop", "finale"] as const) expect(kinds).toContain(kind);
		expect(kinds).not.toContain("lights-out");
		for (const item of ["starling", "bee", "octopus", "ant", "orca", "owl"] as const) expect(result.species).toContain(item);
		// The refusal and the block both play; each lane's acceptance plays once at most.
		expect(result.acts.filter(act => act.kind === "blocked").flatMap(act => act.lanes).sort()).toEqual(["Infra", "Rogue"]);
		const accepted = result.acts.filter(act => act.kind === "accept").flatMap(act => act.lanes);
		expect(new Set(accepted).size).toBe(accepted.length);
	});

	test("a lane accepted before the run continued plays no acceptance; the new one does, and the finale follows", () => {
		const result = replay(RESUMED, { end: 14_000, resumeOf: "run-0" });
		expectClean(result);
		expect(result.acts.filter(act => act.kind === "accept").flatMap(act => act.lanes)).toEqual(["Next"]);
		expect(result.acts.some(act => act.kind === "finale")).toBe(true);
	});

	test("the counts: never more acts of a kind than ledger events of it", () => {
		for (const [steps, end] of [[REAL_RUN, REAL_END], [EVERY_ACT, 46_000]] as const) {
			for (const count of replay(steps, { end }).counts) {
				if (count.kind === "replan") continue;
				expect(count.actLanes > 0 ? count.actLanes : count.acts, count.kind).toBeLessThanOrEqual(count.ledger);
			}
		}
	});
});

describe("the view opens late: nothing settled before it looked is played", () => {
	const late: Array<[string, readonly Step[], number, number]> = [
		["the real run, opened after the review accepted four lanes", REAL_RUN, K("14:58:40"), REAL_END],
		["the real run, opened while waiting for the user", REAL_RUN, K("15:02:01"), REAL_END],
		["the complete run, opened during its wait (past the round, a block and a refusal)", EVERY_ACT, 22_000, 46_000],
		["the complete run, opened past its budget line", EVERY_ACT, 31_400, 46_000],
		["the complete run, opened while it stops", EVERY_ACT, 37_200, 46_000],
	];
	for (const [name, steps, open, end] of late) test(name, () => expectClean(replay(steps, { open, end })));
});

describe("the plan is stable frame to frame", () => {
	test("a snapshot advanced only in time keeps the same plan", () => {
		const timeline = new LaneTimeline();
		const ledger = new Ledger();
		ledger.plan(P2);
		timeline.observe(ledger.record(), "working", START);
		const a = timeline.snapshot(START + 1_000);
		const b = timeline.snapshot(START + 2_000);
		expect(stagePlan(b)).toBe(stagePlan(a));
	});
});
