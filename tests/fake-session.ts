/** A main session as the run controller sees it: omp's session modes, a scripted UI and a fake ctx. */
import type { ExtensionContext, SessionModeRequest, SessionModeResult, SessionModeState } from "@oh-my-pi/pi-coding-agent";
import type { RunTimers } from "../src/runtime/controller.ts";
import { RunController } from "../src/runtime/controller.ts";
import type { TreeReading } from "../src/runtime/tree.ts";
import type { ProjectState } from "../src/state.ts";
import type { AgentEntry, RunRecord, RunSpec, StormConfig } from "../src/types.ts";
import { approvedState, teamOf } from "./fixtures.ts";
import { type Answer, type ScriptedUi, scriptedUi } from "./support.ts";

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

export interface FakeModes {
	requests: SessionModeRequest[];
	state: SessionModeState;
	snapshot(): SessionModeState;
	api: {
		getState(): SessionModeState;
		set(request: SessionModeRequest): Promise<SessionModeResult>;
	};
}

/** omp's session modes as an extension sees them: transitions apply at once and every request is recorded. */
export function fakeModes(
	opts: {
		vibe?: boolean;
		goal?: "inactive" | "active" | "paused";
		loop?: "inactive" | "active" | "paused";
		fail?: (request: SessionModeRequest) => ModeFailure | undefined;
	} = {},
): FakeModes {
	const state: SessionModeState = {
		plan: { status: "inactive" },
		vibe: { status: opts.vibe ? "active" : "inactive" },
		goal: { status: opts.goal ?? "inactive" },
		loop: { status: opts.loop ?? "inactive" },
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
				return { ok: true, changed: true, state: snapshot() };
			},
		},
	};
}

/** What the fake main session reports while Storm decides whether the next round may start. */
export interface SessionHold {
	/** No turn is streaming. */
	idle: boolean;
	/** A message is queued for the session. */
	pending: boolean;
	/** The user's draft in the editor. */
	editor: string;
}

/** The controller's wait timers as a test drives them: set, cleared and fired by hand instead of by the clock. */
export interface FakeTimers {
	api: RunTimers;
	/** Timers set and neither fired nor cleared. */
	pending(): number;
	/** The delays of the pending timers, oldest first. */
	delays(): number[];
	/** Fires every timer pending now, once each. */
	fire(): void;
}

export function fakeTimers(): FakeTimers {
	const pending: Array<{ handle: object; run: () => void; ms: number }> = [];
	return {
		api: {
			set: (run, ms) => {
				const handle = {};
				pending.push({ handle, run, ms });
				return handle;
			},
			clear: handle => {
				const at = pending.findIndex(timer => timer.handle === handle);
				if (at >= 0) pending.splice(at, 1);
			},
		},
		pending: () => pending.length,
		delays: () => pending.map(timer => timer.ms),
		fire: () => {
			for (const timer of pending.splice(0)) timer.run();
		},
	};
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
	/** What the session reports as its context usage. */
	usage?: { tokens: number; contextWindow: number; percent: number };
	/** Runs when the controller compacts the session. */
	compact?: (instructions: string) => Promise<void>;
	/** Runs when the controller sends a message to the session (a rejection is a failed send). */
	send?: (message: string) => Promise<void>;
	/** The run's subagents as the agent ledger reports them; a function is asked at every decision, an array may be mutated. */
	agents?: AgentEntry[] | (() => AgentEntry[]);
	/** The work tree the controller reads, with the root and base it passed; absent → no tree dep, as in a host without git. */
	tree?: (root: string, base?: string) => TreeReading | undefined | Promise<TreeReading | undefined>;
	/** What the session reports while Storm decides; idle and empty unless the test says otherwise. */
	hold?: Partial<SessionHold>;
	/** The whole process ledger; the run's agents when absent. */
	ledger?: () => AgentEntry[];
	/** omp's agent dir: with it the run-end janitor may delete omp records below `<agentDir>/sessions`. */
	agentDir?: string;
	/** The main session's artifacts dir, where omp keeps its subagents' records. */
	artifactsDir?: string;
	/** Receives the live status record: the run while it is on, `undefined` at its end. */
	live?: (ctx: ExtensionContext, run: RunRecord | undefined) => void;
	now?: () => number;
}

/** A run controller over a fake main session. */
export interface FakeSession {
	controller: RunController;
	ctx: ExtensionContext;
	config: StormConfig;
	repo: ProjectState["repo"];
	state: ProjectState;
	modes: FakeModes | undefined;
	ui: ScriptedUi;
	/** Messages sent to the session. */
	sent: string[];
	notices: ScriptedUi["notices"];
	/** What the fake ctx reports while Storm decides whether the next round may start. */
	hold: SessionHold;
	/** The hold timer: pending count and hand-fired callbacks. */
	timers: FakeTimers;
	/** What the session saw, in order: "select", "compact", "set:<mode>:<action>", "send". Notices and records are in `ui.events`. */
	readonly events: string[];
	/** One main turn: it starts, and settles. */
	turn(): Promise<void>;
	/** Starts a run or fails the test with the refusal. */
	start(spec?: RunSpec): Promise<string>;
	aborts(): number;
	/** Run summaries posted: the last thing a finished run does. */
	summaries(): number;
}

export function fakeSession(opts: SessionOptions): FakeSession {
	const config = opts.config ?? SESSION_TEAM;
	const approved = approvedState(opts.root, config);
	const state = opts.state ? opts.state(approved) : approved;
	const modes = opts.modes === null ? undefined : (opts.modes ?? fakeModes());
	const ui = scriptedUi(opts.answers ?? []);
	const sent: string[] = [];
	const hold: SessionHold = { idle: opts.hold?.idle ?? true, pending: opts.hold?.pending ?? false, editor: opts.hold?.editor ?? "" };
	const timers = fakeTimers();
	let aborts = 0;
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
		agents: () => (typeof opts.agents === "function" ? opts.agents() : (opts.agents ?? [])),
		...(opts.tree ? { tree: async (root: string, base?: string) => opts.tree!(root, base) } : {}),
		timers: timers.api,
		...(opts.ledger ? { ledger: opts.ledger } : {}),
		...(opts.agentDir !== undefined ? { agentDir: opts.agentDir } : {}),
		...(opts.live ? { live: opts.live } : {}),
	});
	// The controller hands ctx to its own deps and reads only these members of it.
	const ctx = {
		cwd: opts.root,
		hasUI: true,
		isIdle: () => hold.idle,
		hasPendingMessages: () => hold.pending,
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
		sent,
		notices: ui.notices,
		hold,
		timers,
		get events(): string[] {
			return ui.events.filter(event => !event.startsWith("notify:") && event !== "record" && event !== "report");
		},
		turn: async (): Promise<void> => {
			controller.onAgentStart();
			await controller.onAgentEnd({}, ctx);
		},
		start: async (spec: RunSpec = { task: "task" }): Promise<string> => {
			const started = await controller.start(ctx, spec);
			if (!started.ok) throw new Error(started.reason);
			return started.runId;
		},
		aborts: () => aborts,
		summaries: () => ui.records.length,
	};
}

