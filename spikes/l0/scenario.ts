/**
 * A scripted Storm run of one minute that loops. It passes through every phase and every lane state:
 * a dependency wait, an unmet lane that retries, a user exclusion, a blocked lane, a job lane, an idle lane
 * and two round boundaries. `snapshotAt` cuts the script at time `t` the way a live run would see it:
 * spans that have not started are gone and spans still running are open.
 *
 * Two more scripts sit behind a name (`ScenarioName`): `happy`, where every lane is accepted so the run ends in the
 * finale, and `crowd`, twelve lanes with staggered starts for folding and for the shared stems. `full` is the original.
 */
import type { Lane, LaneSpan, LaneState, Phase, PhaseSpan, Role, RunSnapshot } from "./model.ts";

export const SCENARIO_MS = 60_000;

export const SCENARIOS = ["full", "happy", "crowd"] as const;
export type ScenarioName = (typeof SCENARIOS)[number];

type Script = readonly [from: number, state: LaneState];

interface LaneScript {
	name: string;
	role: Role;
	job?: true;
	dependsOn: readonly string[];
	/** Each entry starts at `from` and ends where the next one starts; the last one stays open. */
	steps: readonly Script[];
}

interface Scenario {
	ms: number;
	/** Offsets of the round starts; the first is 0. */
	rounds: readonly number[];
	phases: ReadonlyArray<readonly [from: number, phase: Phase]>;
	lanes: readonly LaneScript[];
}

const FULL_PHASES: Scenario["phases"] = [
	[0, "working"],
	[3_000, "workers"],
	[20_000, "verifying"],
	[29_000, "waiting-user"],
	[33_000, "between-rounds"],
	[36_000, "working"],
	[39_000, "workers"],
	[46_000, "verifying"],
	[50_000, "between-rounds"],
	[52_000, "working"],
	[55_000, "stopping"],
];

const FULL_LANES: readonly LaneScript[] = [
	{
		name: "탐색-구조", role: "explorer", dependsOn: [],
		steps: [[1_500, "reserved"], [3_000, "running"], [11_000, "submitted"], [20_000, "reviewing"], [24_000, "accepted"]],
	},
	{
		// Unmet at the first review, retried in round two, accepted at the end of the second verification.
		name: "구현-API", role: "implementer", dependsOn: [],
		steps: [
			[1_500, "reserved"], [3_000, "running"], [9_000, "quiet"], [12_000, "running"], [19_000, "submitted"],
			[20_500, "reviewing"], [27_000, "unmet"], [39_000, "running"], [45_000, "submitted"],
			[46_000, "reviewing"], [50_000, "accepted"],
		],
	},
	{
		// Waits for the explorer's result before it may start.
		name: "테스트-작성", role: "reviewer", dependsOn: ["탐색-구조"],
		steps: [[1_500, "waiting"], [11_000, "running"], [18_000, "submitted"], [20_000, "reviewing"], [26_000, "accepted"]],
	},
	{
		name: "빌드-잡", role: "quick", job: true, dependsOn: [],
		steps: [[1_500, "reserved"], [3_000, "running"], [16_000, "accepted"]],
	},
	{
		name: "설계-검토", role: "architect", dependsOn: [],
		steps: [[1_500, "reserved"], [3_000, "running"], [14_000, "blocked"]],
	},
	{
		// Settles without finishing, then the user drops it while the run waits for an answer.
		name: "문서-초안", role: "quick", dependsOn: [],
		steps: [[1_500, "reserved"], [3_000, "running"], [8_000, "idle"], [30_000, "excluded"]],
	},
];

function cutSpans(steps: readonly Script[], now: number): LaneSpan[] {
	const spans: LaneSpan[] = [];
	steps.forEach(([from, state], i) => {
		if (from > now) return;
		const end = steps[i + 1]?.[0];
		spans.push(end !== undefined && end <= now ? { from, to: end, state } : { from, state });
	});
	return spans;
}

function activityOf(state: LaneState, seed: number, now: number): number | undefined {
	if (state === "running") return 0.25 + 0.75 * (0.5 + 0.5 * Math.sin(now / 1_700 + seed * 2.1));
	if (state === "quiet") return 0.05;
	return undefined;
}

const FULL: Scenario = { ms: SCENARIO_MS, rounds: [0, 36_000, 52_000], phases: FULL_PHASES, lanes: FULL_LANES };

/** Every lane ends accepted: the run closes in the finale and then holds a calm picture. */
const HAPPY: Scenario = {
	ms: 58_000,
	rounds: [0, 30_000],
	phases: [
		[0, "working"], [3_000, "workers"], [18_000, "verifying"], [27_000, "between-rounds"], [30_000, "working"],
		[32_000, "workers"], [38_000, "verifying"], [44_000, "working"], [46_000, "stopping"],
	],
	lanes: [
		{
			name: "탐색-구조", role: "explorer", dependsOn: [],
			steps: [[1_500, "reserved"], [3_000, "running"], [10_000, "submitted"], [18_000, "reviewing"], [22_000, "accepted"]],
		},
		{
			// Unmet once, retried in round two, accepted at the second verification.
			name: "구현-API", role: "implementer", dependsOn: [],
			steps: [
				[1_500, "reserved"], [3_000, "running"], [8_000, "quiet"], [10_500, "running"], [17_000, "submitted"],
				[18_500, "reviewing"], [25_000, "unmet"], [32_000, "running"], [37_000, "submitted"],
				[38_000, "reviewing"], [43_000, "accepted"],
			],
		},
		{
			name: "테스트-작성", role: "reviewer", dependsOn: ["탐색-구조"],
			steps: [[1_500, "waiting"], [10_000, "running"], [16_000, "submitted"], [18_000, "reviewing"], [23_500, "accepted"]],
		},
		{
			name: "빌드-잡", role: "quick", job: true, dependsOn: [],
			steps: [[1_500, "reserved"], [3_000, "running"], [14_000, "accepted"]],
		},
		{
			name: "설계-검토", role: "architect", dependsOn: [],
			steps: [[1_500, "reserved"], [3_000, "running"], [12_000, "submitted"], [18_000, "reviewing"], [21_000, "accepted"]],
		},
		{
			name: "문서-초안", role: "quick", dependsOn: [],
			steps: [[1_500, "reserved"], [3_000, "running"], [7_000, "idle"], [11_000, "running"], [15_500, "submitted"], [18_000, "reviewing"], [26_000, "accepted"]],
		},
	],
};

/** Shorthand for the crowd script: a lane with a name, a role and its steps. */
function crowdLane(name: string, role: Role, steps: readonly Script[], extra: { job?: true; dependsOn?: readonly string[] } = {}): LaneScript {
	const lane: LaneScript = { name, role, dependsOn: extra.dependsOn ?? [], steps };
	if (extra.job) lane.job = true;
	return lane;
}

/**
 * Twelve lanes that start in four waves (at 1.5 s, 6 s, 9 s and 14 s), so lanes that start together share a stem and a
 * short terminal has to fold the finished ones. It ends in `stopping` with work left over (lights out).
 */
const CROWD: Scenario = {
	ms: 78_000,
	rounds: [0, 45_000],
	phases: [
		[0, "working"], [3_000, "workers"], [30_000, "verifying"], [36_000, "waiting-user"], [40_000, "between-rounds"],
		[45_000, "working"], [48_000, "workers"], [59_000, "verifying"], [66_000, "working"], [70_000, "stopping"],
	],
	lanes: [
		crowdLane("탐색-구조", "explorer", [[1_500, "reserved"], [3_000, "running"], [14_000, "submitted"], [31_000, "reviewing"], [35_000, "accepted"]]),
		crowdLane("탐색-의존", "explorer", [[1_500, "reserved"], [3_000, "running"], [11_000, "submitted"], [31_000, "reviewing"], [36_000, "accepted"]]),
		crowdLane("구현-API", "implementer", [
			[1_500, "reserved"], [3_000, "running"], [9_000, "quiet"], [12_000, "running"], [28_000, "submitted"], [31_500, "reviewing"],
			[38_000, "unmet"], [48_000, "running"], [58_000, "submitted"], [60_500, "reviewing"], [65_000, "accepted"],
		]),
		crowdLane("구현-UI", "implementer", [[1_500, "reserved"], [3_000, "running"], [24_000, "submitted"], [32_000, "reviewing"], [37_000, "accepted"]]),
		crowdLane("테스트-단위", "reviewer", [[6_000, "waiting"], [14_500, "running"], [26_000, "submitted"], [32_500, "reviewing"], [38_500, "accepted"]], { dependsOn: ["탐색-구조"] }),
		crowdLane("테스트-통합", "reviewer", [[6_000, "waiting"], [36_500, "running"], [47_000, "submitted"], [60_500, "reviewing"], [66_000, "accepted"]], { dependsOn: ["탐색-의존"] }),
		crowdLane("빌드-잡", "quick", [[6_000, "reserved"], [7_000, "running"], [18_000, "accepted"]], { job: true }),
		crowdLane("설계-검토", "architect", [[9_000, "reserved"], [10_000, "running"], [22_000, "blocked"]]),
		crowdLane("보안-점검", "reviewer", [[9_000, "reserved"], [10_000, "running"], [27_000, "submitted"], [31_500, "reviewing"], [39_000, "accepted"]]),
		crowdLane("문서-초안", "quick", [[14_000, "reserved"], [15_000, "running"], [21_000, "idle"], [37_000, "excluded"]]),
		crowdLane("이전-작업", "implementer", [
			[14_000, "reserved"], [15_000, "running"], [25_000, "quiet"], [28_000, "running"], [29_500, "submitted"], [32_000, "reviewing"], [40_000, "accepted"],
		]),
		crowdLane("성능-측정", "explorer", [[14_000, "reserved"], [15_000, "running"], [29_000, "accepted"]], { job: true }),
	],
};

const SCRIPTS: Record<ScenarioName, Scenario> = { full: FULL, happy: HAPPY, crowd: CROWD };

/** Length in ms of one loop of a scenario. */
export function scenarioMs(name: ScenarioName = "full"): number {
	return SCRIPTS[name].ms;
}

export function snapshotAt(t: number, name: ScenarioName = "full"): RunSnapshot {
	const script = SCRIPTS[name];
	const length = script.ms;
	const now = Math.floor(((t % length) + length) % length);
	const phases: PhaseSpan[] = [];
	script.phases.forEach(([from, phase], i) => {
		if (from > now) return;
		const end = script.phases[i + 1]?.[0];
		phases.push(end !== undefined && end <= now ? { from, to: end, phase } : { from, phase });
	});
	const lanes: Lane[] = [];
	script.lanes.forEach((laneScript, i) => {
		const spans = cutSpans(laneScript.steps, now);
		const current = spans[spans.length - 1];
		if (current === undefined) return;
		const lane: Lane = { name: laneScript.name, role: laneScript.role, dependsOn: laneScript.dependsOn, spans };
		if (laneScript.job) lane.job = true;
		const activity = activityOf(current.state, i, now);
		if (activity !== undefined) lane.activity = activity;
		lanes.push(lane);
	});
	const state = (lane: Lane): LaneState => lane.spans[lane.spans.length - 1]!.state;
	const excluded = lanes.filter((lane) => state(lane) === "excluded").length;
	return {
		now,
		phases,
		rounds: script.rounds.filter((offset) => offset <= now),
		maxRounds: 4,
		lanes,
		counts: {
			accepted: lanes.filter((lane) => state(lane) === "accepted").length,
			inScope: lanes.length - excluded,
			excluded,
		},
		costUsd: Math.round((now / length) * 1.84 * 100) / 100,
	};
}
