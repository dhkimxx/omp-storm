/** A main session as the run controller sees it: omp's session modes, a scripted UI and a fake ctx. */
import type { AsyncJobSnapshot, ExtensionContext, SessionModeRequest, SessionModeResult, SessionModeState } from "@oh-my-pi/pi-coding-agent";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import type { RunTimers } from "../src/runtime/controller.ts";
import { RunController } from "../src/runtime/controller.ts";
import type {
	AcquireRunLeaseInput,
	AcquireRunLeaseResult,
	LeaseDeps,
	LeaseMode,
	LeaseRecord,
	LeaseSnapshot,
	RunLease,
	UpgradeResult,
	WriteScope,
} from "../src/runtime/lease.ts";
import type { TreeReading } from "../src/runtime/tree.ts";
import type { ProjectState } from "../src/state.ts";
import type { AgentEntry, RunRecord, RunSpec, StormConfig } from "../src/types.ts";
import { approvedState, fixtureSession, teamOf } from "./fixtures.ts";
import { type Answer, type ScriptedUi, scriptedUi, testSessionId } from "./support.ts";

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

type PathClaim = { ok: true; paths: readonly string[] | undefined } | { ok: false; reason: string };

/** The real lease's accepted path form, so an upgrade in a test behaves like one on disk. */
function claimOf(scope: WriteScope | undefined): PathClaim {
	if (scope === undefined || scope.kind === "unbounded") return { ok: true, paths: undefined };
	const unique = new Set<string>();
	for (const value of scope.paths) {
		if (
			typeof value !== "string" ||
			value.length === 0 ||
			path.isAbsolute(value) ||
			value.includes("\u0000") ||
			value.includes("\\")
		) {
			return { ok: false, reason: `경로 범위 쓰기의 경로가 올바르지 않습니다: ${JSON.stringify(value)}` };
		}
		const segments = value.split("/");
		if (segments.some(segment => segment === "" || segment === "." || segment === "..")) {
			return { ok: false, reason: `경로 범위 쓰기의 경로가 올바르지 않습니다: ${JSON.stringify(value)}` };
		}
		unique.add(value.normalize("NFC"));
	}
	if (unique.size === 0) return { ok: false, reason: "경로 범위 쓰기는 하나 이상의 저장소 상대 경로가 필요합니다." };
	return { ok: true, paths: Object.freeze([...unique].sort()) };
}

function samePaths(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
	if (a === undefined || b === undefined) return a === b;
	return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * An in-memory execution lease for controller tests: no lock file, but every access fact and transition the real
 * `RunLease` exposes is present, so `snapshot()`/`assertCurrent()`/`upgrade()`/`setWritePaths()` behave realistically.
 * Tests that need actual inter-run arbitration inject a real lease through `SessionOptions.lease`.
 */
function fakeLease(input: AcquireRunLeaseInput, onRelease: () => void): RunLease {
	const startedAt = new Date(0).toISOString();
	const owner = Object.freeze({ token: randomUUID(), pid: process.pid, host: "test", processStart: 1 });
	const initial = claimOf(input.mode === "write" ? input.scope : undefined);
	let mode: LeaseMode = input.mode;
	let paths: readonly string[] | undefined = initial.ok ? initial.paths : undefined;
	let epoch = 0;
	let released = false;
	let releasePromise: Promise<void> | undefined;
	const recordPath = path.join(path.dirname(input.sessionDir), "fake-leases", `${input.runId}.lock`);
	const sessionPath = path.join(path.dirname(input.sessionDir), "fake-leases", `session-${input.runId}.lock`);
	const snapshot = (): LeaseSnapshot =>
		Object.freeze({
			runId: input.runId,
			sessionId: input.sessionId,
			sessionDir: input.sessionDir,
			root: input.root,
			mode,
			paths: paths === undefined ? undefined : Object.freeze([...paths]),
			epoch,
		});
	const record = (): LeaseRecord => ({
		schema: "storm.lease/v2",
		kind: mode === "read" ? "read" : "write",
		key: input.root,
		root: input.root,
		runId: input.runId,
		sessionId: input.sessionId,
		sessionDir: input.sessionDir,
		owner,
		acquiredAt: startedAt,
		acquiredAtMs: 1,
		...(paths !== undefined ? { paths: [...paths] } : {}),
	});
	const release = async (): Promise<void> => {
		if (released) return;
		released = true;
		onRelease();
	};
	releasePromise = undefined;
	const lease: RunLease = {
		runId: input.runId,
		sessionId: input.sessionId,
		sessionDir: input.sessionDir,
		root: input.root,
		get mode(): LeaseMode {
			return mode;
		},
		get paths(): readonly string[] | undefined {
			return paths === undefined ? undefined : Object.freeze([...paths]);
		},
		get epoch(): number {
			return epoch;
		},
		owner,
		get record(): Readonly<LeaseRecord> {
			return record();
		},
		get path(): string {
			return recordPath;
		},
		sessionPath,
		snapshot,
		assertCurrent(snapshot: LeaseSnapshot): void {
			if (
				released ||
				snapshot.runId !== input.runId ||
				snapshot.sessionId !== input.sessionId ||
				snapshot.sessionDir !== input.sessionDir ||
				snapshot.root !== input.root ||
				snapshot.mode !== mode ||
				snapshot.epoch !== epoch ||
				!samePaths(snapshot.paths, paths)
			) {
				throw new Error("실행 잠금의 접근 상태가 바뀌었습니다.");
			}
		},
		async upgrade(over: { scope?: WriteScope } = {}): Promise<UpgradeResult> {
			if (released) return { ok: false, reason: "이미 해제된 실행 잠금은 바꿀 수 없습니다." };
			const claim = claimOf(over.scope);
			if (!claim.ok) return { ok: false, reason: claim.reason };
			if (mode === "read") {
				mode = "write";
				paths = claim.paths;
				epoch++;
				return { ok: true };
			}
			if (samePaths(paths, claim.paths)) return { ok: true };
			paths = claim.paths;
			epoch++;
			return { ok: true };
		},
		async setWritePaths(next: readonly string[]): Promise<UpgradeResult> {
			if (released) return { ok: false, reason: "이미 해제된 실행 잠금은 바꿀 수 없습니다." };
			if (mode !== "write") return { ok: false, reason: "읽기 실행은 먼저 upgrade로 쓰기 실행이 되어야 합니다." };
			const claim = claimOf({ kind: "paths", paths: next });
			if (!claim.ok) return { ok: false, reason: claim.reason };
			if (samePaths(paths, claim.paths)) return { ok: true };
			paths = claim.paths;
			epoch++;
			return { ok: true };
		},
		release(): Promise<void> {
			releasePromise ??= release();
			return releasePromise;
		},
	};
	return lease;
}

/**
 * Wraps any lease — the default fake or a real one a test injected — so its lifetime is observable without changing
 * its snapshot or transition behavior. Getters are forwarded, not copied, so a real lease stays authoritative.
 */
function tracedLease(lease: RunLease, onRelease: () => void): RunLease {
	let released = false;
	let releasePromise: Promise<void> | undefined;
	const release = async (): Promise<void> => {
		if (released) return;
		released = true;
		try {
			await lease.release();
		} finally {
			onRelease();
		}
	};
	return {
		get runId() {
			return lease.runId;
		},
		get sessionId() {
			return lease.sessionId;
		},
		get sessionDir() {
			return lease.sessionDir;
		},
		get root() {
			return lease.root;
		},
		get mode() {
			return lease.mode;
		},
		get paths() {
			return lease.paths;
		},
		get epoch() {
			return lease.epoch;
		},
		get owner() {
			return lease.owner;
		},
		get record() {
			return lease.record;
		},
		get path() {
			return lease.path;
		},
		get sessionPath() {
			return lease.sessionPath;
		},
		snapshot: () => lease.snapshot(),
		assertCurrent: snapshot => lease.assertCurrent(snapshot),
		upgrade: over => lease.upgrade(over),
		setWritePaths: next => lease.setWritePaths(next),
		release(): Promise<void> {
			releasePromise ??= release();
			return releasePromise;
		},
	};
}

/** The team a session runs unless the test gives its own. */
export const SESSION_TEAM: StormConfig = teamOf({ explorer: "a/x", implementer: "a/i", reviewer: "a/r" });

export interface SessionOptions {
	/** The actual target work tree: approvals are bound to it, but no Storm state is written under it. */
	root: string;
	/** A named native session identity, for a test that must reopen the same owner; a fresh one when absent. */
	sessionId?: string;
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
	/** Lease acquisition. Defaults to a realistic in-memory lease: tests never touch the real lock directory. */
	lease?: (input: AcquireRunLeaseInput, deps?: LeaseDeps) => Promise<AcquireRunLeaseResult>;
	/** What the fake main session reports as its running and recent async jobs (default: omp's snapshot with no jobs, as on the pinned host; `null` models a host that cannot show them). */
	asyncJobs?: () => AsyncJobSnapshot | null;
	now?: () => number;
}

/** A run controller over a fake main session. */
export interface FakeSession {
	controller: RunController;
	ctx: ExtensionContext;
	config: StormConfig;
	repo: ProjectState["repo"];
	state: ProjectState;
	/** This session's native identity and store; the target root is only `repo.root`. */
	sessionId: string;
	sessionDir: string;
	agentDir: string;
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
	/** Lease lifetimes the controller requested: run ids acquired and released, and the wrappers still live. */
	leases: { acquired: string[]; released: string[]; held: RunLease[] };
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
	const sessionId = opts.sessionId ?? testSessionId("fake-session");
	const profile = fixtureSession(opts.root, {
		...(opts.agentDir !== undefined ? { agentDir: opts.agentDir } : {}),
		sessionId,
	});
	const approved = approvedState(opts.root, config, { agentDir: profile.agentDir, sessionId });
	const state = opts.state ? opts.state(approved) : approved;
	const modes = opts.modes === null ? undefined : (opts.modes ?? fakeModes());
	const ui = scriptedUi(opts.answers ?? []);
	const sent: string[] = [];
	const hold: SessionHold = { idle: opts.hold?.idle ?? true, pending: opts.hold?.pending ?? false, editor: opts.hold?.editor ?? "" };
	const timers = fakeTimers();
	let aborts = 0;
	const leases: FakeSession["leases"] = { acquired: [], released: [], held: [] };

	/** The controller may call the old `(root, runId)` shape in an in-flight build; both normalize to the real input. */
	const leaseInput = (first: AcquireRunLeaseInput | string, second?: LeaseDeps | string): AcquireRunLeaseInput => {
		if (typeof first === "string") {
			return { sessionDir: state.sessionDir, sessionId, root: first, runId: typeof second === "string" ? second : "", mode: "write" };
		}
		return {
			sessionDir: first.sessionDir || state.sessionDir,
			sessionId: first.sessionId || sessionId,
			root: first.root,
			runId: first.runId,
			mode: first.mode,
			...(first.scope !== undefined ? { scope: first.scope } : {}),
		};
	};
	const lease = async (first: AcquireRunLeaseInput | string, second?: LeaseDeps | string): Promise<AcquireRunLeaseResult> => {
		const input = leaseInput(first, second);
		const acquired = opts.lease
			? await opts.lease(input)
			: { ok: true as const, lease: fakeLease(input, () => undefined) };
		if (!acquired.ok) return acquired;
		leases.acquired.push(input.runId);
		const held = tracedLease(acquired.lease, () => {
			leases.released.push(input.runId);
			const at = leases.held.indexOf(held);
			if (at >= 0) leases.held.splice(at, 1);
		});
		leases.held.push(held);
		return { ok: true, lease: held };
	};
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
		lease,
		...(opts.ledger ? { ledger: opts.ledger } : {}),
		agentDir: profile.agentDir,
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
		getAsyncJobSnapshot: opts.asyncJobs ?? (() => ({ running: [], recent: [], delivery: {} }) as unknown as AsyncJobSnapshot),
		compact: async (instructions: string) => {
			ui.events.push("compact");
			await opts.compact?.(instructions);
		},
		abort: () => {
			aborts++;
		},
		agent: { kind: "main", id: "main" },
		sessionManager: {
			getSessionId: () => sessionId,
			getArtifactsDir: () => opts.artifactsDir ?? "",
			getSessionDir: () => "",
		},
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
		sessionId,
		sessionDir: state.sessionDir,
		agentDir: profile.agentDir,
		modes,
		ui,
		sent,
		notices: ui.notices,
		hold,
		timers,
		leases,
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

