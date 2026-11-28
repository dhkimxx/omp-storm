/**
 * Frames for the README's lane view clip: a scripted Storm run played through the real widget (`LiveStatus`, the same
 * factory omp mounts below the editor), one frame per widget tick, written as JSON for a rasteriser.
 *
 *   node_modules/.bin/bun scripts/lane-clip.ts --out FILE [--story stage|lanes] [--columns N] [--rows N] [--tick MS]
 *
 * The run is a `RunRecord` that changes with a fake clock, shown with `LiveStatus.show` exactly as the controller does,
 * so the status row (phase, results, round, workers, cost, time) and the picture rows are both the product's own. The
 * script does not draw anything. The JSON holds, per frame, the rows the widget returned with their colour codes.
 *
 * Two stories. `stage` (the default, 120 columns, the 0.32 clip): the animal stage beside the lane graph plays its
 * species in turn. Starlings gather the team at the start, bees fly while only read lanes run, the octopus takes over
 * when reads and writes mix, ants carry while one writer that cannot be narrowed works and another write waits its
 * turn, orcas circle while the reviewer judges, every result is accepted and the orcas play the finale. `lanes` (80
 * columns, the 0.31 clip, no stage at that width): five lanes start one by one, one waits for another's submission,
 * the first result is reviewed and joins the trunk, a lane is judged unmet and retried in a second round, and when
 * every result is accepted the trunk runs its rainbow.
 *
 * The stage. In a terminal that shows images the widget draws the stage as a picture (T1); the test host has none, so
 * the widget returns the stage's text tier in those cells. The script asks the product for the T1 picture of the same
 * snapshot at the same moment (`stagePicture`, encoded by `encodeStageFrame` exactly as the image channel sends it) and
 * writes it with the cell box it covers (`stage`: base64 PNG, column, row, columns, rows); a rasteriser draws the PNG
 * scaled into that box instead of the text there. The phrase row below the box is text in the product too.
 *
 * Two clocks. The script and the playback run in "story" time (one frame per widget tick). The run the widget sees
 * lasts `runPerStory` times longer: the fake clock moves that much per tick, so the lanes grow long across the 30 s time
 * axis instead of staying short stubs. The animation clock (the `t` the widget hands `laneFrame` and `laneViewFrame` for
 * the flowing light and the creatures' loops) is put back to story time by spies on those two; event effects (a join's
 * burst, a bounce, the stage's handoffs, acts and gathering) are timed in run time by the renderer itself, so they play
 * `runPerStory` times faster than in a live run.
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
import { stageLaneColours, stagePicture } from "../src/view/stage/render-pixels.ts";
import { encodeStageFrame } from "../src/view/stage/t1.ts";
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
	/** The write scope; a writer without one is a writer the policy cannot narrow (the ants' rule). */
	files?: readonly string[];
	dependsOn?: readonly string[];
	steps: readonly Step[];
}

interface Story {
	/** Story milliseconds the clip lasts. */
	clipMs: number;
	/**
	 * Run milliseconds per story millisecond. The view's time axis is the smallest of 30, 45, 60 ... s that is 8 percent
	 * longer than the run, so a run under 27.7 s (`clipMs` x `runPerStory`) keeps the 30 s axis for the whole clip.
	 */
	runPerStory: number;
	columns: number;
	/** The director plans at this moment; before it the trunk runs alone. */
	planAt: number;
	lanes: readonly LaneScript[];
	/** Windows in which the reviewer works: every lane that has submitted shows as under review. */
	reviewing: ReadonlyArray<readonly [from: number, to: number]>;
	phases: ReadonlyArray<readonly [from: number, phase: RunPhase]>;
	/** The second round starts here: the record's round counter moves from 0 to 1. */
	roundTwoAt?: number;
	workers: Readonly<Record<string, number>>;
}

/** The 0.31 clip: the lane graph alone at 80 columns, about 14 s of watching for a run of 27.4 s. */
const LANES_STORY: Story = (() => {
	const planAt = 700;
	return {
		clipMs: 14_400,
		runPerStory: 1.9,
		columns: 80,
		planAt,
		lanes: [
			{
				name: "구조-탐색", role: "explorer", criteria: ["모듈 구조 정리"],
				steps: [[planAt, "pending"], [1_300, "running"], [3_600, "submitted"], [5_000, "accepted"]],
			},
			{
				name: "API-구현", role: "implementer", criteria: ["응답 계약", "에러 처리"],
				steps: [
					[planAt, "pending"], [1_600, "running"], [6_500, "submitted"], [7_700, "settled", ["accepted", "unmet"]],
					[8_900, "running", ["accepted", "unmet"]], [10_300, "submitted", ["accepted", "reviewable"]], [11_600, "accepted"],
				],
			},
			{
				name: "화면-구현", role: "implementer", criteria: ["목록 화면"],
				steps: [[planAt, "pending"], [1_900, "running"], [5_900, "submitted"], [7_500, "accepted"]],
			},
			{
				name: "테스트", role: "reviewer", criteria: ["회귀 테스트"], dependsOn: ["구조-탐색"],
				steps: [[planAt, "pending"], [4_000, "running"], [6_900, "submitted"], [7_900, "accepted"]],
			},
			{
				name: "문서", role: "implementer", criteria: ["사용 안내"],
				steps: [[planAt, "pending"], [2_200, "running"], [5_300, "submitted"], [7_200, "accepted"]],
			},
		],
		reviewing: [[3_800, 5_000], [6_100, 7_900], [10_500, 11_600]],
		phases: [
			[0, "working"], [1_100, "workers"], [3_800, "verifying"], [5_000, "workers"], [6_100, "verifying"],
			[7_800, "between-rounds"], [8_500, "workers"], [10_500, "verifying"], [11_800, "stopping"],
		],
		roundTwoAt: 8_500,
		workers: { explorer: 1, implementer: 3, reviewer: 1 },
	};
})();

/**
 * The 0.32 clip: the stage beside the graph at 120 columns, 17.4 s of watching for a run of 26.1 s. Each species holds
 * the stage for at least 3 s of run time, so every change is a full handoff, not a crossfade.
 */
const STAGE_STORY: Story = (() => {
	const planAt = 600;
	return {
		clipMs: 17_400,
		runPerStory: 1.5,
		columns: 120,
		planAt,
		lanes: [
			// Starlings gather from the start until 2.4 s of run time after the plan lands; then the two readers are alone: bees.
			{
				name: "구조-탐색", role: "explorer", criteria: ["모듈 구조 정리"],
				steps: [[planAt, "pending"], [1_000, "running"], [5_600, "submitted"], [12_200, "accepted"]],
			},
			{
				name: "자료-조사", role: "explorer", criteria: ["기존 필터 조사"],
				steps: [[planAt, "pending"], [1_300, "running"], [6_000, "submitted"], [12_200, "accepted"]],
			},
			// Two scoped writers join the readers: the octopus.
			{
				name: "API-구현", role: "implementer", criteria: ["응답 계약"], files: ["src/api/filter.ts"],
				steps: [[planAt, "pending"], [4_600, "running"], [7_600, "submitted"], [13_200, "accepted"]],
			},
			{
				name: "화면-구현", role: "implementer", criteria: ["목록 화면"], files: ["src/ui/list.tsx"],
				steps: [[planAt, "pending"], [5_000, "running"], [8_000, "submitted"], [13_200, "accepted"]],
			},
			// A writer without a file list works alone while the last write waits its turn: the ants.
			{
				name: "설정-이전", role: "implementer", criteria: ["설정 이전"],
				steps: [[planAt, "pending"], [7_800, "running"], [11_400, "submitted"], [14_200, "accepted"]],
			},
			{
				name: "문서", role: "implementer", criteria: ["사용 안내"], files: ["docs/filter.md"],
				steps: [[planAt, "pending"], [11_400, "running"], [12_800, "submitted"], [14_200, "accepted"]],
			},
		],
		// The reviewer judges every submitted lane: the orcas, until the last results are accepted and the finale plays.
		reviewing: [[11_000, 14_200]],
		phases: [[0, "working"], [900, "workers"], [11_000, "verifying"], [14_200, "stopping"]],
		workers: { explorer: 2, implementer: 4, reviewer: 1 },
	};
})();

const STORIES = { stage: STAGE_STORY, lanes: LANES_STORY } as const;
type StoryName = keyof typeof STORIES;

/** The widget's own tick; frames are taken at this pace. */
const DEFAULT_TICK_MS = 85;

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

/** Wall-clock ms of story time `t`: the run clock runs `runPerStory` times as fast as the story. */
const wallOf = (story: Story, t: number): number => T0 + t * story.runPerStory;

/** The run record at story time `t` (ms): what the controller would hold then. */
function runAt(story: Story, t: number): RunRecord {
	const now = wallOf(story, t);
	const agents: AgentEntry[] = [];
	const spawns: SpawnRecord[] = [];
	const results: RunResult[] = [];
	const planLanes: PlanLane[] = [];
	story.lanes.forEach((lane, i) => {
		planLanes.push({
			name: lane.name,
			kind: lane.role === "explorer" ? "explore" : lane.role === "reviewer" ? "review" : "code",
			role: lane.role,
			results: lane.criteria.map((criterion, k) => ({ id: resultId(lane, k), kind: "answer", criterion })),
			...(lane.files === undefined ? {} : { files: [...lane.files] }),
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
		agents.push(agentEntry({ id: lane.name, name: `storm-${lane.role}`, role: lane.role, state: running ? "running" : "idle", startedAt: wallOf(story, began), lastActivityAt: now - age, costUsd: 0.05 }));
		spawns.push(spawnRecord({ spawnKey: lane.name, lane: lane.name, agent: `storm-${lane.role}`, ts: iso(wallOf(story, began)) }));
	});
	const reviewing = story.reviewing.some(([from, to]) => from <= t && t < to);
	if (t >= story.reviewing[0]![0]) {
		agents.push(agentEntry({ id: "검토", name: "storm-reviewer", role: "reviewer", state: reviewing ? "running" : "idle", startedAt: wallOf(story, story.reviewing[0]![0]), lastActivityAt: now - 800, costUsd: 0.04 }));
	}
	const cost = Math.min(0.62, 0.02 + t * 0.00004);
	return runRecord({
		runId: "run-readme",
		status: "running",
		startedAt: iso(T0),
		task: "목록 화면에 필터 추가",
		turns: story.roundTwoAt !== undefined && t >= story.roundTwoAt ? 1 : 0,
		costUsd: cost,
		...(t >= story.planAt
			? { plan: { lanes: planLanes, workers: { ...story.workers }, submittedAt: iso(wallOf(story, story.planAt)) }, results }
			: {}),
		agents,
		spawns,
	});
}

function phaseAt(story: Story, t: number): RunPhase {
	return story.phases[since(story.phases, t)]![1];
}

/** The stage's T1 picture and the cells it covers in the frame's rows (row 0 is the widget's status row). */
interface StageCut {
	/** Base64 of the indexed PNG the image channel would send. */
	png: string;
	column: number;
	row: number;
	columns: number;
	rows: number;
	/** The phrase row's text: which species and why. */
	phrase: string;
}

interface Frame {
	/** Script time of the frame in ms. */
	t: number;
	rows: readonly string[];
	stage?: StageCut;
}

/** Plays the run through the real widget and returns what it drew, one entry per tick. */
export function playRun(story: Story, options: { columns: number; rows: number; tickMs: number }): Frame[] {
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

	// The widget hands `laneFrame` and `laneViewFrame` its own animation clock, which follows the run clock; the clip
	// wants the flowing light and the creatures at story pace, so that one argument is replaced. Everything else
	// (snapshot, columns, options) passes through. The view spy also asks for the stage's T1 picture of the same call;
	// what it took during one widget render is the last entry of `cuts`.
	let t = 0;
	const cuts: Array<{ lines: number; stage: Omit<StageCut, "row"> }> = [];
	const realFrame = frameModule.laneFrame;
	const realView = frameModule.laneViewFrame;
	const frameSpy = spyOn(frameModule, "laneFrame").mockImplementation((snapshot, cols, _t, frameOptions) => realFrame(snapshot, cols, t, frameOptions));
	const viewSpy = spyOn(frameModule, "laneViewFrame").mockImplementation((snapshot, cols, _t, frameOptions, tier) => {
		const lines = realView(snapshot, cols, t, frameOptions, tier);
		const parts = frameModule.laneViewParts(snapshot, cols, t, frameOptions);
		if (parts === undefined) return lines;
		const rows = parts.rows - 1;
		const picture = stagePicture(snapshot, parts.stageCols, rows, t, { motion: frameOptions.motion, dark: frameOptions.dark }, "t1");
		const png = encodeStageFrame({ w: picture.w, h: picture.h, rgb: picture.rgb, dark: frameOptions.dark, laneColours: stageLaneColours(snapshot, frameOptions.dark) });
		cuts.push({ lines: lines.length, stage: { png, column: 0, columns: parts.stageCols, rows, phrase: picture.phrase } });
		return lines;
	});
	const frames: Frame[] = [];
	try {
		for (t = 0; t <= story.clipMs; t += options.tickMs) {
			clock = wallOf(story, t);
			cuts.length = 0;
			if (!live.show(ctx, runAt(story, t), phaseAt(story, t))) throw new Error("the host refused the live widget");
			if (widget === undefined) throw new Error("the widget was not installed");
			const rows = widget.render(options.columns);
			// The view's lines are the widget's last rows (the status row comes first).
			const cut = cuts.at(-1);
			const stage = cut === undefined ? undefined : { ...cut.stage, row: rows.length - cut.lines };
			frames.push({ t, rows, ...(stage === undefined ? {} : { stage }) });
		}
	} finally {
		viewSpy.mockRestore();
		frameSpy.mockRestore();
		live.clear();
	}
	return frames;
}

/** The phrase rows the stage showed and from when, so a run of the script says which species played when. */
function castSummary(frames: readonly Frame[]): string {
	const spans: string[] = [];
	let last: string | undefined;
	for (const frame of frames) {
		const phrase = frame.stage?.phrase ?? "(no stage)";
		if (phrase === last) continue;
		spans.push(`  ${(frame.t / 1000).toFixed(2).padStart(5)} s  ${phrase}`);
		last = phrase;
	}
	return spans.join("\n");
}

const USAGE = "usage: bun scripts/lane-clip.ts --out FILE [--story stage|lanes] [--columns N] [--rows N] [--tick MS]";

function main(): void {
	const argv = process.argv.slice(2);
	const text = (flag: string): string | undefined => {
		const at = argv.indexOf(flag);
		return at < 0 ? undefined : argv[at + 1];
	};
	const read = (flag: string, fallback: number): number => {
		const raw = text(flag);
		const value = raw === undefined ? fallback : Number(raw);
		if (!Number.isFinite(value) || value <= 0) throw new Error(`${flag} needs a positive number`);
		return value;
	};
	const out = text("--out");
	const storyName = text("--story") ?? "stage";
	if (out === undefined || !(storyName in STORIES)) {
		process.stderr.write(`${USAGE}\n`);
		process.exit(2);
	}
	const story = STORIES[storyName as StoryName];
	const columns = read("--columns", story.columns);
	const rows = read("--rows", 40);
	const tickMs = read("--tick", DEFAULT_TICK_MS);
	const frames = playRun(story, { columns, rows, tickMs });
	const height = Math.max(...frames.map(frame => frame.rows.length));
	const background = `#${lookOf(true).background.toString(16).padStart(6, "0")}`;
	const runMs = Math.round(story.clipMs * story.runPerStory);
	writeFileSync(out, JSON.stringify({ story: storyName, columns, height, tickMs, background, durationMs: story.clipMs, runMs, frames }));
	const staged = frames.filter(frame => frame.stage !== undefined).length;
	process.stderr.write(
		`wrote ${out}: ${storyName} story, ${frames.length} frames (${staged} with a stage picture), ${columns} columns, up to ${height} rows, ` +
			`${(story.clipMs / 1000).toFixed(1)} s of story, a run of ${(runMs / 1000).toFixed(1)} s\n${staged > 0 ? `${castSummary(frames)}\n` : ""}`,
	);
	process.exit(0);
}

if (import.meta.main) main();
