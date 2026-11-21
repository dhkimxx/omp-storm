/** A main session as the run controller sees it: omp's session modes, hand-fired timers, a scripted UI and a fake ctx. */
import type { ExtensionContext, SessionModeRequest, SessionModeResult, SessionModeState } from "@oh-my-pi/pi-coding-agent";
import { RunController, type RunTimers } from "../src/runtime/controller.ts";
import type { ProjectState } from "../src/state.ts";
import type { AgentEntry, RunSpec, StormConfig } from "../src/types.ts";
import { approvedState, teamOf } from "./fixtures.ts";
import { type Answer, scriptedUi } from "./support.ts";

/**
 * Resolves once `done()` holds; fails instead of hanging. Detached work (a queued start, a fired timer, a live write)
 * finishes through file I/O nothing exposes a promise for, so this yields to the event loop until the outcome shows:
 * it waits on what happened, never for a fixed time. The deadline only turns a condition that never holds into a failure.
 */
export async function until(done: () => boolean | Promise<boolean>): Promise<void> {
	const deadline = performance.now() + 10_000;
	do {
		if (await done()) return;
		const tick = Promise.withResolvers<void>();
		setImmediate(tick.resolve);
		await tick.promise;
	} while (performance.now() < deadline);
	throw new Error("the condition never held");
}

type ModeFailure = Pick<Extract<SessionModeResult, { ok: false }>, "code" | "message">;

/** omp's session modes as an extension sees them: transitions apply at once and every request is recorded. */
export function fakeModes(opts: { vibe?: boolean; pausedGoal?: { objective: string; tokenBudget?: number }; fail?: (request: SessionModeRequest) => ModeFailure | undefined } = {}) {
	const state: SessionModeState = {
		plan: { status: "inactive" },
		vibe: { status: opts.vibe ? "active" : "inactive" },
		goal: opts.pausedGoal ? { status: "paused", ...opts.pausedGoal } : { status: "inactive" },
		loop: { status: "inactive" },
	};
	const requests: SessionModeRequest[] = [];
	const snapshot = (): SessionModeState => structuredClone(state);
	return {
		requests,
		state,
		snapshot,
		api: {
			getState: snapshot,
			set: async (request: SessionModeRequest): Promise<SessionModeResult> => {
				requests.push(request);
				const failure = opts.fail?.(request);
				if (failure) return { ok: false, ...failure, state: snapshot() };
				if (request.mode === "vibe") state.vibe.status = request.action === "enter" ? "active" : "inactive";
				else if (request.mode === "loop") state.loop.status = request.action === "enter" ? "active" : "inactive";
				else if (request.mode === "goal") {
					if (request.action === "enter") {
						state.goal = { status: "active", objective: request.objective, ...(request.tokenBudget !== undefined ? { tokenBudget: request.tokenBudget } : {}) };
					} else state.goal.status = request.action === "pause" ? "paused" : request.action === "resume" ? "active" : "inactive";
				}
				return { ok: true, changed: true, state: snapshot() };
			},
		},
	};
}

export type FakeModes = ReturnType<typeof fakeModes>;

/** Timers the test fires by hand. */
export function fakeTimers() {
	const pending: Array<{ run: () => void; ms: number }> = [];
	const timers: RunTimers = {
		set: (run, ms) => {
			const timer = { run, ms };
			pending.push(timer);
			return timer;
		},
		clear: handle => {
			const at = pending.indexOf(handle as (typeof pending)[number]);
			if (at >= 0) pending.splice(at, 1);
		},
	};
	/** Fires the one pending timer and waits for `done`, what it is expected to bring about. */
	const fire = async (done: () => boolean): Promise<void> => {
		const timer = pending.shift();
		if (!timer) throw new Error("no timer is pending");
		timer.run();
		await until(done);
	};
	return { timers, pending, fire };
}

/** The team a session runs unless the test gives its own. */
export const SESSION_TEAM: StormConfig = teamOf({ explorer: "a/x", implementer: "a/i", reviewer: "a/r" });

export interface SessionOptions {
	/** The project root: run records are written below it. */
	root: string;
	/** The approved team; `SESSION_TEAM` when absent. */
	config?: StormConfig;
	/** Changes the approved state the controller loads (unapprove it, add a shadow). */
	state?: (state: ProjectState) => ProjectState;
	/** Replaces the state load altogether: called at each start and at each run end. */
	loadState?: () => Promise<ProjectState>;
	/** omp's session modes; `null` is a host without mode control (RPC, print). */
	modes?: FakeModes | null;
	/** Scripted dialog answers; a dialog past them fails the test. */
	answers?: Answer[];
	loopMode?: string;
	/** What the session reports as its context usage. */
	usage?: { tokens: number; contextWindow: number; percent: number };
	/** Runs when the controller compacts the session. */
	compact?: (instructions: string) => Promise<void>;
	/** Runs when the controller sends a message to the session (a rejection is a failed send). */
	send?: (message: string) => Promise<void>;
	/** The run's subagents, as the agent ledger reports them at run end. */
	agents?: AgentEntry[];
	/** The whole process ledger; the run's agents when absent. */
	ledger?: () => AgentEntry[];
	/** omp's agent dir: with it the run-end janitor may delete omp records below `<agentDir>/sessions`. */
	agentDir?: string;
	/** The main session's artifacts dir, where omp keeps its subagents' records. */
	artifactsDir?: string;
	now?: () => number;
}

/** A run controller over a fake main session. Nothing is waited for by the clock: stall timers are fired by hand. */
export function fakeSession(opts: SessionOptions) {
	const config = opts.config ?? SESSION_TEAM;
	const approved = approvedState(opts.root, config);
	const state = opts.state ? opts.state(approved) : approved;
	const modes = opts.modes === null ? undefined : (opts.modes ?? fakeModes());
	const ui = scriptedUi(opts.answers ?? []);
	const sent: string[] = [];
	const clock = fakeTimers();
	let aborts = 0;
	/** What makes omp hold a continuation: the test sets these as the session would be. */
	const hold = { busy: false, pending: false, editor: "" };
	const controller = new RunController({
		pi: {
			sendUserMessage: async message => {
				const text = typeof message === "string" ? message : JSON.stringify(message);
				sent.push(text);
				ui.events.push("send");
				await opts.send?.(text);
			},
		},
		ui: () => ui.ui,
		loadState: opts.loadState ?? (async () => state),
		now: opts.now ?? Date.now,
		agents: () => opts.agents ?? [],
		...(opts.ledger ? { ledger: opts.ledger } : {}),
		...(opts.agentDir !== undefined ? { agentDir: opts.agentDir } : {}),
		timers: clock.timers,
		...(opts.loopMode !== undefined ? { loopMode: async () => opts.loopMode } : {}),
	});
	// The controller hands ctx to its own deps and reads only these members of it.
	const ctx = {
		cwd: opts.root,
		isIdle: () => !hold.busy,
		hasPendingMessages: () => hold.pending,
		hasUI: true,
		ui: { getEditorText: () => hold.editor },
		getContextUsage: () => opts.usage,
		compact: async (instructions: string) => {
			ui.events.push("compact");
			await opts.compact?.(instructions);
		},
		abort: () => {
			aborts++;
		},
		...(opts.artifactsDir !== undefined ? { sessionManager: { getArtifactsDir: () => opts.artifactsDir } } : {}),
		...(modes
			? {
					sessionModes: {
						getState: modes.api.getState,
						set: async (request: SessionModeRequest) => {
							ui.events.push(`set:${request.mode}:${request.action}`);
							return modes.api.set(request);
						},
					},
				}
			: {}),
	} as unknown as ExtensionContext;
	return {
		controller,
		ctx,
		config,
		repo: state.repo,
		state,
		modes,
		ui,
		/** Messages sent to the session: the handoff first, then goal nudges. */
		sent,
		notices: ui.notices,
		clock,
		hold,
		/** What the session saw, in order: "select", "compact", "set:<mode>:<action>", "send". Notices and records are in `ui.events`. */
		get events(): string[] {
			return ui.events.filter(event => !event.startsWith("notify:") && event !== "record" && event !== "report");
		},
		/** One main turn: it starts, and settles. */
		turn: async (): Promise<void> => {
			controller.onAgentStart();
			await controller.onAgentEnd({}, ctx);
		},
		/** Starts a run or fails the test with the refusal. */
		start: async (spec: RunSpec = { mode: "vibe", task: "task" }): Promise<string> => {
			const started = await controller.start(ctx, spec);
			if (!started.ok) throw new Error(started.reason);
			return started.runId;
		},
		aborts: () => aborts,
		/** Run summaries posted: the last thing a finished run does. */
		summaries: () => ui.records.length,
	};
}

export type FakeSession = ReturnType<typeof fakeSession>;
