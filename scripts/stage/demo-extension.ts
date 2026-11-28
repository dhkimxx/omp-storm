/**
 * Stage demo: plays the lane-preview scenarios (`scripts/lane-preview-scenario.ts`) through the real live widget below
 * the editor, so the product's role painter, its T1 image channel or T2/T3 text drawing, and the host's own image
 * driver draw them on a real terminal. No model is called and nothing is stored: load it alone into the pinned omp.
 *
 *   home=$(mktemp -d); mkdir -p "$home/.omp/profiles/stage-demo/agent"
 *   printf 'setupVersion: 3\n' > "$home/.omp/profiles/stage-demo/agent/config.yml"   # no first-run wizard
 *   HOME="$home" node_modules/.bin/omp --profile stage-demo --no-extensions -e scripts/stage/demo-extension.ts \
 *       --no-session --no-skills --no-rules --no-context-files --no-lsp --no-title
 *
 * then type `/stage-demo <scenario> [from=<seconds>] [speed=<x>] [loop]`, with a scenario of `octopus`, `bee`, `ant`,
 * `orca`, `owl`, `tour`, `handoffs`, `full`, `happy` or `crowd`. It plays the script once from `from` (default 0) and
 * then clears the widget the way a finished run does (a transparent frame under the stage's key, then removal);
 * `loop` starts it again as a new run each time. `/stage-demo pause` freezes and resumes the clock, `/stage-demo stop`
 * ends the run. `PI_FORCE_IMAGE_PROTOCOL=iterm2` (or `kitty`) gives T1 in a terminal omp does not know draws images
 * (VS Code with `terminal.integrated.enableImages`); without images the stage is T2 with true colour, else T3.
 *
 * The scenario is the widget's input: the lane timeline's `snapshot` is replaced, in this process only, by the script
 * cut at the demo clock, and each phase change of the script reaches the widget through `LiveStatus.show` like a live
 * update. The demo clock is wall time scaled by `speed` and stopped while paused, so the widget's own tick, its image
 * channel's budget and its animation time all follow it.
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import type { RunRecord } from "../../src/types.ts";
import type { RunPhase } from "../../src/view/appearance.ts";
import { LaneTimeline } from "../../src/view/lane/timeline.ts";
import { LiveStatus } from "../../src/view/live.ts";
import { type ScenarioName, SCENARIOS, scenarioMs, snapshotAt } from "../lane-preview-scenario.ts";

/** How often the demo looks for a phase change or the end of the script. */
const POLL_MS = 50;
/** A fixed origin so the run's elapsed chip and the scenario clock agree. */
const ORIGIN = Date.parse("2026-11-28T09:00:00.000Z");

interface Play {
	scenario: ScenarioName;
	speed: number;
	loop: boolean;
	/** Scenario ms at `wall`; the demo clock is `ORIGIN + at + (now - wall) * speed` while running. */
	at: number;
	wall: number;
	paused: boolean;
	run: RunRecord;
	phase: RunPhase | undefined;
	timer: NodeJS.Timeout;
}

let play: Play | undefined;
let runs = 0;

/** The scenario time the demo clock shows now. */
function scenarioNow(current: Play): number {
	return current.paused ? current.at : current.at + (performance.now() - current.wall) * current.speed;
}

const clock = (): number => ORIGIN + (play === undefined ? 0 : scenarioNow(play));

// While a script plays, every lane timeline in this process reads the script at the demo clock.
const realSnapshot = LaneTimeline.prototype.snapshot;
LaneTimeline.prototype.snapshot = function snapshot(this: LaneTimeline, now: number) {
	return play === undefined ? realSnapshot.call(this, now) : snapshotAt(Math.max(0, now - ORIGIN), play.scenario);
};

function runRecord(): RunRecord {
	runs++;
	return {
		schema: "storm.run/v1",
		runId: `stage-demo-${runs}`,
		configHash: "stage-demo",
		startedAt: new Date(ORIGIN).toISOString(),
		status: "running",
		task: "stage demo",
		costUsd: 0,
		costByModel: {},
		spawns: [],
	};
}

const USAGE = `/stage-demo <${SCENARIOS.join("|")}> [from=<seconds>] [speed=<x>] [loop] · /stage-demo pause · /stage-demo stop`;

export default function stageDemo(pi: ExtensionAPI): void {
	const live = new LiveStatus({ now: clock });

	const stop = (): void => {
		if (play === undefined) return;
		clearInterval(play.timer);
		live.clear();
		play = undefined;
	};

	const tick = (ctx: ExtensionCommandContext): void => {
		const current = play;
		if (current === undefined) return;
		const ms = scenarioMs(current.scenario);
		if (scenarioNow(current) >= ms) {
			if (!current.loop) return stop();
			// The next loop is a new run: the widget clears the last run's picture and draws under a new key.
			current.at = 0;
			current.wall = performance.now();
			current.run = runRecord();
			current.phase = undefined;
		}
		const phase = snapshotAt(scenarioNow(current), current.scenario).phases.at(-1)?.phase ?? "working";
		if (phase === current.phase) return;
		current.phase = phase;
		if (!live.show(ctx, current.run, phase)) {
			ctx.ui.notify("stage-demo: this host draws no live widget (it needs omp's interactive TUI)", "error");
			stop();
		}
	};

	pi.registerCommand("stage-demo", {
		description: "Play a lane-preview scenario through Storm's live widget (stage check)",
		getArgumentCompletions: prefix => {
			const words = [...SCENARIOS, "pause", "stop"].filter(word => word.startsWith(prefix.trim()));
			return words.length > 0 ? words.map(value => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			const [first, ...rest] = args.trim().split(/\s+/).filter(word => word !== "");
			if (first === "stop") return stop();
			if (first === "pause") {
				if (play === undefined) return;
				play.at = scenarioNow(play);
				play.wall = performance.now();
				play.paused = !play.paused;
				return;
			}
			if (first === undefined || !(SCENARIOS as readonly string[]).includes(first)) {
				ctx.ui.notify(USAGE, "warning");
				return;
			}
			let from = 0;
			let speed = 1;
			let loop = false;
			for (const word of rest) {
				const [key, value] = word.split("=");
				if (key === "loop" && value === undefined) loop = true;
				else if (key === "from" && Number.isFinite(Number(value))) from = Number(value) * 1000;
				else if (key === "speed" && Number(value) > 0) speed = Number(value);
				else {
					ctx.ui.notify(USAGE, "warning");
					return;
				}
			}
			stop();
			const scenario = first as ScenarioName;
			play = {
				scenario,
				speed,
				loop,
				at: Math.min(Math.max(0, from), scenarioMs(scenario) - 1),
				wall: performance.now(),
				paused: false,
				run: runRecord(),
				phase: undefined,
				timer: setInterval(() => tick(ctx), POLL_MS),
			};
			play.timer.unref?.();
			tick(ctx);
		},
	});

	pi.on("session_shutdown", () => stop());
}
