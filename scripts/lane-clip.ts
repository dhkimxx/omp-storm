/**
 * Frames for the README's lane view clip: a scripted Storm run played through the real widget (`LiveStatus`, the same
 * factory omp mounts below the editor), one frame per widget tick, written as JSON for a rasteriser.
 *
 *   node_modules/.bin/bun scripts/lane-clip.ts --out FILE [--columns N] [--rows N] [--tick MS]
 *
 * The run is a `RunRecord` that changes with a fake clock, shown with `LiveStatus.show` exactly as the controller does,
 * so the status row (phase, results, round, workers, cost, time) and the picture rows are both the product's own. The
 * script does not draw anything. The JSON holds, per frame, the rows the widget returned with their colour codes.
 *
 * Two clocks. The script and the playback run in "story" time (14.4 s of watching, one frame per widget tick). The run
 * the widget sees lasts `RUN_PER_STORY` times longer: the fake clock moves that much per tick, so the lanes grow long
 * across the 30 s time axis instead of staying short stubs. The animation clock (the `t` the widget hands `laneFrame`
 * for the flowing light) is put back to story time by a spy on `laneFrame`; event effects (a join's burst, a bounce)
 * are timed in run time by the renderer itself, so they play `RUN_PER_STORY` times faster than in a live run.
 *
 * The story (about 14 s of watching, a run of about 27 s): the director plans five lanes, they start one after another, one lane waits for another's
 * submission, the first result is reviewed and joins the trunk, a lane is judged unmet and retried in a second round,
 * and when every result is accepted the trunk runs its rainbow.
 */
import { spyOn } from "bun:test";
import { writeFileSync } from "node:fs";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { isUiNode, type UiNode } from "@oh-my-pi/pi-tui";
import type { AgentEntry, PlanLane, RunRecord, RunResult, RunResultState, SpawnRecord } from "../src/types.ts";
import type { RunPhase } from "../src/view/appearance.ts";
import { lookOf } from "../src/view/lane/colour.ts";
import * as frameModule from "../src/view/lane/frame.ts";
import { LIVE_WIDGET_KEY, LiveStatus } from "../src/view/live.ts";
import { agentEntry, runRecord, spawnRecord } from "../tests/fixtures.ts";
import { extensionTheme } from "../tests/tui-host.ts";

/** What a lane is doing in the script; `results` overrides the row states the lane's status would give. */
type LaneStatus = "pending" | "running" | "submitted" | "settled" | "accepted";
type Step = readonly [from: number, status: LaneStatus, results?: readonly RunResultState[]];

interface LaneScript {
	name: string;
	role: "explorer" | "implementer" | "reviewer";
	/** Criteria of the lane's required results, one per result row. */
	criteria: readonly string[];
	dependsOn?: readonly string[];
	steps: readonly Step[];
}

const CLIP_MS = 14_400;
/**
 * Run milliseconds per story millisecond. The view's time axis is the smallest of 30, 45, 60 ... s that is 8 percent
 * longer than the run, so a run under 27.7 s keeps the 30 s axis for the whole clip and ends with its head at about 91
 * percent of the width: 14.4 s x 1.9 = 27.4 s.
 */
const RUN_PER_STORY = 1.9;
/** The widget's own tick; frames are taken at this pace. */
const DEFAULT_TICK_MS = 85;
/** The director plans at this moment; before it the trunk runs alone. */
const PLAN_AT = 700;

const LANES: readonly LaneScript[] = [
	{
		name: "구조-탐색", role: "explorer", criteria: ["모듈 구조 정리"],
		steps: [[PLAN_AT, "pending"], [1_300, "running"], [3_600, "submitted"], [5_000, "accepted"]],
	},
	{
		name: "API-구현", role: "implementer", criteria: ["응답 계약", "에러 처리"],
		steps: [
			[PLAN_AT, "pending"], [1_600, "running"], [6_500, "submitted"], [7_700, "settled", ["accepted", "unmet"]],
			[8_900, "running", ["accepted", "unmet"]], [10_300, "submitted", ["accepted", "reviewable"]], [11_600, "accepted"],
		],
	},
	{
		name: "화면-구현", role: "implementer", criteria: ["목록 화면"],
		steps: [[PLAN_AT, "pending"], [1_900, "running"], [5_900, "submitted"], [7_500, "accepted"]],
	},
	{
		name: "테스트", role: "reviewer", criteria: ["회귀 테스트"], dependsOn: ["구조-탐색"],
		steps: [[PLAN_AT, "pending"], [4_000, "running"], [6_900, "submitted"], [7_900, "accepted"]],
	},
	{
		name: "문서", role: "implementer", criteria: ["사용 안내"],
		steps: [[PLAN_AT, "pending"], [2_200, "running"], [5_300, "submitted"], [7_200, "accepted"]],
	},
];

/** Windows in which the reviewer works: every lane that has submitted shows as under review. */
const REVIEWING: ReadonlyArray<readonly [from: number, to: number]> = [[3_800, 5_000], [6_100, 7_900], [10_500, 11_600]];

const PHASES: ReadonlyArray<readonly [from: number, phase: RunPhase]> = [
	[0, "working"], [1_100, "workers"], [3_800, "verifying"], [5_000, "workers"], [6_100, "verifying"],
	[7_800, "between-rounds"], [8_500, "workers"], [10_500, "verifying"], [11_800, "stopping"],
];
/** The second round starts here: the record's round counter moves from 0 to 1. */
const ROUND_TWO_AT = 8_500;

const T0 = Date.parse("2026-11-20T09:00:00Z");
const iso = (ms: number): string => new Date(ms).toISOString();
/** Index of the last row that starts at or before `t`, or -1. */
const since = (rows: ReadonlyArray<readonly [number, ...unknown[]]>, t: number): number => rows.findLastIndex(row => row[0] <= t);

function stepAt(lane: LaneScript, t: number): Step | undefined {
	const at = since(lane.steps, t);
	return at < 0 ? undefined : lane.steps[at];
}

function resultStates(lane: LaneScript, step: Step): readonly RunResultState[] {
	if (step[2] !== undefined) return step[2];
	const state: RunResultState = step[1] === "accepted" ? "accepted" : step[1] === "submitted" ? "reviewable" : "pending";
	return lane.criteria.map(() => state);
}

const resultId = (lane: LaneScript, index: number): string => `${lane.name}-${index + 1}`;

/** Wall-clock ms of story time `t`: the run clock runs `RUN_PER_STORY` times as fast as the story. */
const wallOf = (t: number): number => T0 + t * RUN_PER_STORY;

/** The run record at story time `t` (ms): what the controller would hold then. */
function runAt(t: number): RunRecord {
	const now = wallOf(t);
	const agents: AgentEntry[] = [];
	const spawns: SpawnRecord[] = [];
	const results: RunResult[] = [];
	const planLanes: PlanLane[] = [];
	LANES.forEach((lane, i) => {
		planLanes.push({
			name: lane.name,
			kind: lane.role === "explorer" ? "explore" : lane.role === "reviewer" ? "review" : "code",
			role: lane.role,
			results: lane.criteria.map((criterion, k) => ({ id: resultId(lane, k), kind: "answer", criterion })),
			...(lane.dependsOn === undefined ? {} : { dependsOn: lane.dependsOn.map(name => ({ lane: name, need: "reviewable" as const })) }),
		});
		const step = stepAt(lane, t);
		if (step === undefined) return;
		const states = resultStates(lane, step);
		lane.criteria.forEach((_, k) => {
			const state = states[k]!;
			results.push({ id: resultId(lane, k), lane: lane.name, state, ...(state === "unmet" ? { reason: "에러 응답이 계약과 다릅니다.", remedy: "work" as const } : {}) });
		});
		// A worker exists from the first moment its lane runs; it works while the lane runs and idles after.
		const began = lane.steps.find(s => s[1] === "running")?.[0];
		if (began === undefined || began > t) return;
		const running = step[1] === "running";
		// How long ago the worker last did something: it varies by lane and over time, so the flow speeds differ.
		const age = running ? Math.round((0.55 + 0.45 * Math.sin(t / 1_900 + i * 2.3)) * 30_000) : 0;
		agents.push(agentEntry({ id: lane.name, name: `storm-${lane.role}`, role: lane.role, state: running ? "running" : "idle", startedAt: wallOf(began), lastActivityAt: now - age, costUsd: 0.05 }));
		spawns.push(spawnRecord({ spawnKey: lane.name, lane: lane.name, agent: `storm-${lane.role}`, ts: iso(wallOf(began)) }));
	});
	const reviewing = REVIEWING.some(([from, to]) => from <= t && t < to);
	if (t >= REVIEWING[0]![0]) {
		agents.push(agentEntry({ id: "검토", name: "storm-reviewer", role: "reviewer", state: reviewing ? "running" : "idle", startedAt: wallOf(REVIEWING[0]![0]), lastActivityAt: now - 800, costUsd: 0.04 }));
	}
	const cost = Math.min(0.62, 0.02 + t * 0.00004);
	return runRecord({
		runId: "run-readme",
		status: "running",
		startedAt: iso(T0),
		task: "목록 화면에 필터 추가",
		turns: t >= ROUND_TWO_AT ? 1 : 0,
		costUsd: cost,
		...(t >= PLAN_AT
			? { plan: { lanes: planLanes, workers: { explorer: 1, implementer: 3, reviewer: 1 }, submittedAt: iso(wallOf(PLAN_AT)) }, results }
			: {}),
		agents,
		spawns,
	});
}

function phaseAt(t: number): RunPhase {
	return PHASES[since(PHASES, t)]![1];
}

interface Frame {
	/** Script time of the frame in ms. */
	t: number;
	rows: readonly string[];
}

/** Plays the run through the real widget and returns what it drew, one entry per tick. */
export function playRun(options: { columns: number; rows: number; tickMs: number }): Frame[] {
	let clock = T0;
	const live = new LiveStatus({ now: () => clock });
	let widget: { render(width: number): readonly string[]; dispose?(): void } | undefined;
	const uiHost = {
		requestRender: () => undefined,
		size: () => ({ columns: options.columns, rows: options.rows }),
		suspend: <R>(run: () => Promise<R>): Promise<R> => run(),
	};
	const ctx = {
		mode: "tui",
		hasUI: true,
		agent: { kind: "main", id: "main", name: "main" },
		ui: {
			setStatus: () => undefined,
			setWidget(key: string, content: unknown) {
				if (key !== LIVE_WIDGET_KEY || content === undefined || Array.isArray(content)) return;
				const built = (content as (host: typeof uiHost, theme: unknown) => unknown)(uiHost, extensionTheme(currentTheme()));
				if (isUiNode(built as UiNode)) throw new Error("the widget drew nodes, not rows (native rendering is on)");
				widget = built as typeof widget;
			},
		},
	} as unknown as ExtensionContext;

	// The widget hands `laneFrame` its own animation clock, which follows the run clock; the clip wants the flowing light
	// at story pace, so that one argument is replaced. Everything else (snapshot, columns, options) passes through.
	let story = 0;
	const realFrame = frameModule.laneFrame;
	const spy = spyOn(frameModule, "laneFrame").mockImplementation((snapshot, cols, _t, frameOptions) => realFrame(snapshot, cols, story, frameOptions));
	const frames: Frame[] = [];
	try {
		for (let t = 0; t <= CLIP_MS; t += options.tickMs) {
			story = t;
			clock = wallOf(t);
			if (!live.show(ctx, runAt(t), phaseAt(t))) throw new Error("the host refused the live widget");
			if (widget === undefined) throw new Error("the widget was not installed");
			frames.push({ t, rows: widget.render(options.columns) });
		}
	} finally {
		spy.mockRestore();
		live.clear();
	}
	return frames;
}

function main(): void {
	const argv = process.argv.slice(2);
	const read = (flag: string, fallback: number): number => {
		const at = argv.indexOf(flag);
		const value = at < 0 ? fallback : Number(argv[at + 1]);
		if (!Number.isFinite(value) || value <= 0) throw new Error(`${flag} needs a positive number`);
		return value;
	};
	const outAt = argv.indexOf("--out");
	const out = outAt < 0 ? undefined : argv[outAt + 1];
	if (out === undefined) {
		process.stderr.write("usage: bun scripts/lane-clip.ts --out FILE [--columns N] [--rows N] [--tick MS]\n");
		process.exit(2);
	}
	const columns = read("--columns", 80);
	const rows = read("--rows", 40);
	const tickMs = read("--tick", DEFAULT_TICK_MS);
	const frames = playRun({ columns, rows, tickMs });
	const height = Math.max(...frames.map(frame => frame.rows.length));
	const background = `#${lookOf(true).background.toString(16).padStart(6, "0")}`;
	writeFileSync(out, JSON.stringify({ columns, height, tickMs, background, durationMs: CLIP_MS, runMs: Math.round(CLIP_MS * RUN_PER_STORY), frames }));
	process.stderr.write(`wrote ${out}: ${frames.length} frames, ${columns} columns, up to ${height} rows, ${(CLIP_MS / 1000).toFixed(1)} s of story, a run of ${((CLIP_MS * RUN_PER_STORY) / 1000).toFixed(1)} s\n`);
	process.exit(0);
}

if (import.meta.main) main();
