/**
 * Storm run lifecycle for one main session. A run starts from `/storm` at once, or from the storm tool once the turn
 * that queued it settles: team gate, omp's session modes, compaction of a heavy context, then the handoff. An automatic
 * probe opens from the storm tool's first plan inside the running turn, with no handoff, compaction or dialog. At the
 * end of every round the round rules decide whether the run is over; when it is not, Storm sends the next round itself,
 * waiting out the hold while the session is busy. Spawn decisions arrive from any session in the process (children
 * included), so they are collected per run in module scope.
 */
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { ApprovalStore } from "../approval/store.ts";
import { docsEnabled } from "../policy/docs.ts";
import { clearRunReads, openRunReads } from "../policy/reads.ts";
import { formatUsd, shadowBlock, teamGate, usableRole } from "../policy/spawn.ts";
import { tokens } from "../report/agents.ts";
import { PREFLIGHT_SHARE, PREFLIGHT_TOKENS, roleTitle } from "../roles.ts";
import { isApproved, type ProjectState } from "../state.ts";
import type { RunRequestResult } from "../tool/host.ts";
import type {
	AgentEntry,
	RunCheckpoint,
	RunCheckEvidence,
	RunEndReason,
	RunPlan,
	RunRecord,
	RunSpec,
	SpawnBlockCode,
	SpawnRecord,
	StormConfig,
	UiPort,
} from "../types.ts";
import { markAgentsCleaned } from "./agents.ts";
import { bytesText, processKey, recordTrustedRun, runJanitor } from "./janitor.ts";
import { runRequiredChecks, type CheckReport } from "./checks.ts";
import { RunLanes } from "./lanes.ts";
import { acquireRunLease, type AcquireRunLeaseResult, type RunLease } from "./lease.ts";
import { activeLedgerRun, endLedgerRun, getLedgerRun, type LedgerRun, setLedgerPlan, startLedgerRun } from "./ledger.ts";
import { reviewLine } from "./review.ts";
import {
	buildRoundMessage,
	decideRound,
	END_STATUS,
	endLabel,
	HOLD_MS,
	maxRounds,
	reviewGate,
	ROUND_DELAY_MS,
	STATUS_LABEL,
	treeFingerprint,
	type CoverageCheck,
	type CoverageInput,
	type CoverageLane,
	type Gate,
	type RoundDecision,
} from "./rounds.ts";
import { buildHandoff, newRunId, pruneRuns, readRun, REQUEST_LIMIT, RUN_KEEP, writeRun } from "./run.ts";
import { appendRunIndex, summarizeForIndex } from "./run-index.ts";
import { noteResumePointer, protectedResumeRunIds } from "./resume.ts";
import type { TreeReading, TreeState } from "./tree.ts";

const spawnsByRun = new Map<string, SpawnRecord[]>();

/** Debounced writers of the runs owned by sessions in this process, keyed by run id. */
const liveWriters = new Map<string, () => void>();
/**
 * How often an active run's record is rewritten at most. The live record is what remains of a run whose process
 * dies: the next run's janitor marks it stopped and it shows up as the last run with what it had spent and spawned.
 */
const LIVE_FLUSH_MS = 2_000;
/** How often a stopping run asks whether work it still owns has settled. */
const DRAIN_POLL_MS = 1_000;
/** How long a stopping run keeps its scope, lease and accounting while owned work settles. */
const DRAIN_MAX_MS = 30_000;

/** Asks the owning session to rewrite the run's record soon (spawns, spend). */
export function touchRun(runId: string): void {
	liveWriters.get(runId)?.();
}

/** The spawns decided so far in a run, from whichever session decided them (a copy). */
export function runSpawns(runId: string): SpawnRecord[] {
	return [...(spawnsByRun.get(runId) ?? [])];
}

/** What compaction before a run must keep: the director works from it for the whole run. */
const PREFLIGHT_INSTRUCTIONS =
	"곧 Storm 실행을 시작합니다. 작업 계획, 내린 결정과 그 이유, 남은 문제, 관련 파일 경로는 빠짐없이 남기고 나머지는 짧게 줄이세요.";

/** Called by the spawn hook of whichever session decided the spawn. A finished run takes no more spawns. */
export function noteRunSpawn(runId: string, record: SpawnRecord): void {
	const list = spawnsByRun.get(runId);
	if (!list) return;
	list.push(record);
	touchRun(runId);
}

/** How much of the request a run record keeps. */
const TASK_CHARS = 200;

/** Whether a turn ended because it was interrupted: omp closes it with an assistant message marked aborted. */
export function turnAborted(messages: readonly unknown[] | undefined): boolean {
	for (let i = (messages?.length ?? 0) - 1; i >= 0; i--) {
		const message = messages?.[i];
		if (typeof message === "object" && message !== null && "role" in message && message.role === "assistant") {
			return "stopReason" in message && message.stopReason === "aborted";
		}
	}
	return false;
}

const iso = (ms: number): string => new Date(ms).toISOString();
const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** omp refuses a prompt whose setup the user interrupted with this error (`PromptDroppedError`, named in its class). */
const promptDropped = (error: unknown): boolean => error instanceof Error && error.name === "PromptDroppedError";

function withoutDocFindings(agent: AgentEntry): AgentEntry {
	if (agent.review?.docFindings === undefined) return agent;
	const review = { ...agent.review };
	delete review.docFindings;
	return { ...agent, review };
}

function withoutCleanup(config: StormConfig): StormConfig {
	const copy = { ...config };
	delete copy.cleanup;
	return copy;
}

/** Where the main session keeps its subagents' records: the run-end janitor finds them there later. */
function artifactsOf(ctx: ExtensionContext): { artifactsDir?: string } {
	// In-memory sessions (and bare test contexts) have no artifacts dir: their runs keep no cleanable records.
	const dir = ctx.sessionManager?.getArtifactsDir();
	return typeof dir === "string" && dir !== "" ? { artifactsDir: dir } : {};
}

/** The unverified gate a round message is built from, as `decideRound` hands it over. */
type RoundGate = Extract<RoundDecision, { action: "continue" }>["gate"];

interface OwnRun {
	record: RunRecord;
	root: string;
	repoId: string;
	/** The session that directs the run: live record writes happen without a ctx of their own. */
	ctx: ExtensionContext;
	/** The approved config the run started under. */
	config: StormConfig;
	/** Approval records of the repo: the run-end janitor keeps them within their limits. */
	store: ApprovalStore;
	/** The worktree execution slot, held through drain and released only at finalization. */
	lease?: RunLease;
	/** One lane matcher for this run; retained across replans so reservations do not collide. */
	lanes: RunLanes;
	/** Aborts checks and other bounded work as soon as the run starts stopping. */
	abort: AbortController;
	/** Required-check reports by tree fingerprint; "skipped" means the tree was decided ineligible. */
	checks: Map<string, CheckReport | "skipped">;
	/** The tree a required-check run is currently evaluating; no second run starts for it. */
	checking?: string;
	/** The compact evidence of the latest check report, written with every live and final record. */
	checkEvidence?: RunCheckEvidence[];
	/** The context of the first stop, reused when the run finalizes after a deferred drain. */
	finishCtx?: ExtensionContext;
	/** A stopping run's detached recheck timer; it never blocks a shutdown or an agent_end handler. */
	drainTimer?: unknown;
	/** Polls spent waiting for owned work; after the timeout the deferral is reported once. */
	drainPolls?: number;
	drainWarned?: boolean;
	/** A verified run that had to wait for owned work rechecks its proof before it may keep that label. */
	drained?: boolean;
	/** The end a round-limit/no-progress decision would take if the one pending check-only look cannot verify. */
	checksOnlyEnd?: RunEndReason;
	/** The handoff turn has begun; settles before it do not count. */
	turnStarted: boolean;
	/** A main turn is running: between an `agent_start` and the terminal `agent_end` after it. */
	inTurn: boolean;
	/** The Storm-scheduled round number this turn belongs to; undefined for a user clarification/activity turn. */
	roundInFlight?: number;
	/** A Storm round (or the initial handoff) was sent and its turn has not started yet. */
	awaitingRound?: number;
	/** Started inside a running turn as an automatic probe: it sends no handoff and keeps routine ends out of the transcript. */
	auto?: boolean;
	/** Why the run is over, decided while a turn was still running: that turn's end finishes it, its last message counted. */
	ending?: RunEndReason;
	/** Most rounds the run may take, fixed at start: a team edited mid-run must not move the goal posts. */
	maxRounds: number;
	/** The user's wall-time limit in minutes, when the request stated one. */
	minutes?: number;
	/** The work tree when the run started: the gate compares it with the tree at each round. */
	tree?: TreeState;
	/** The commit the start tree was read against: every later read compares with it, so a commit does not hide a change. */
	base?: string;
	/** When Storm first sent a round for a tree-only stale review: a verdict after it is not stale because of the tree. */
	rereviewedAt?: number;
	/** The team's activity when Storm sent its last round message: what the next round is expected to move. */
	progress?: { changes: number; reviews: number; requests: number };
	/** The pending look timer: the round delay, or the wait while the session is held. */
	hold?: unknown;
	/** The last `agent_end` paused the run on async work: a terminal end without a new turn means the user stopped that wait. */
	awaitingAsync: boolean;
}

type Refusal = Extract<RunRequestResult, { ok: false }>;
const refuse = (reason: string): Refusal => ({ ok: false, reason });

const START = { vibeOff: "omp vibe 끄고 시작", cancel: "취소" } as const;

export interface RunTimers {
	set(run: () => void, ms: number): unknown;
	clear(handle: unknown): void;
}

const REAL_TIMERS: RunTimers = {
	set: (run, ms) => {
		const timer = setTimeout(run, ms);
		timer.unref?.();
		return timer;
	},
	clear: handle => clearTimeout(handle as NodeJS.Timeout),
};

export interface RunControllerDeps {
	pi: Pick<ExtensionAPI, "sendUserMessage">;
	ui(ctx: ExtensionContext): UiPort;
	loadState(ctx: ExtensionContext): Promise<ProjectState>;
	now(): number;
	/** Subagents whose latest turn was during the run, from the agent ledger. */
	agents?(runId: string): AgentEntry[];
	/** The work tree's state against `base` (HEAD when absent); absent in hosts and tests that have no git. */
	tree?(root: string, base?: string): Promise<TreeReading | undefined>;
	/** Every subagent this process has seen (any run): the janitor only cleans those omp has parked. */
	ledger?(): AgentEntry[];
	/** omp's agent dir: the janitor deletes omp records only below its `sessions/`. Absent → no omp record cleanup. */
	agentDir?: string;
	/** How long a live rewrite of the run record waits to batch changes; defaults to LIVE_FLUSH_MS. */
	flushMs?: number;
	/** The look timer's clock; real timers when absent. */
	timers?: RunTimers;
	/** Acquires the per-worktree execution lease; the real hard-link lease when absent. */
	lease?(root: string, runId: string): Promise<AcquireRunLeaseResult>;
	/**
	 * The live status record: the run after it was first written, on every live rewrite and when a round is sent;
	 * `undefined` when the run ends. A failing hook never breaks the run.
	 */
	live?(ctx: ExtensionContext, run: RunRecord | undefined): void;
}

export class RunController {
	#pending: { runId: string; spec: RunSpec } | undefined;
	/** A start is between its checks and its handoff (it may be asking, compacting, or recording the run). */
	#starting = false;
	#own: OwnRun | undefined;
	#flushTimer: ReturnType<typeof setTimeout> | undefined;
	/** Bumped when the run lifecycle ends (shutdown, session switch): a start in flight must not continue into the next session. */
	#generation = 0;
	/** The last live write; the final record waits for it so a late live write never lands on top. */
	#liveWrite: Promise<unknown> = Promise.resolve();
	/** One finalization per run: a second stop during drain joins it instead of writing a second record. */
	#finishing: Promise<RunRecord | undefined> | undefined;

	constructor(private readonly deps: RunControllerDeps) {}

	/** Why no run can be queued or started now: one run per session, running, queued or starting. */
	refusal(): string | undefined {
		if (this.#own) return `이미 Storm 실행(${this.#own.record.runId})이 진행 중입니다.`;
		if (this.#pending) return `이미 예약된 Storm 실행(${this.#pending.runId})이 있습니다.`;
		if (this.#starting) return "이미 Storm 실행을 시작하는 중입니다.";
		return undefined;
	}

	/**
	 * From the storm tool: the run starts once the current turn settles. A tool call cannot hand the session a
	 * message of its own, so every tool-requested run waits for the terminal `agent_end`.
	 */
	request(spec: RunSpec): RunRequestResult {
		const reason = this.refusal();
		if (reason !== undefined) return refuse(reason);
		const runId = newRunId(this.deps.now());
		this.#pending = { runId, spec };
		return { ok: true, runId };
	}

	/** This session's run with live spend from the ledger. */
	active(): RunRecord | undefined {
		const own = this.#own;
		if (!own) return undefined;
		const live = getLedgerRun(own.record.runId);
		const agents = this.deps.agents?.(own.record.runId) ?? [];
		const record: RunRecord = {
			...own.record,
			costUsd: live?.costUsd ?? own.record.costUsd,
			costByModel: { ...(live?.costByModel ?? own.record.costByModel) },
			spawns: [...(spawnsByRun.get(own.record.runId) ?? [])],
			...(agents.length ? { agents } : {}),
		};
		if (own.checkEvidence?.length) record.checks = own.checkEvidence;
		return record;
	}

	/**
	 * Checks the approved team and omp's session modes, compacts a heavy main context, records the run and sends the
	 * handoff. The session must be idle. It can take as long as a dialog or a compaction: callers inside an omp event
	 * handler use `launch`.
	 */
	async start(ctx: ExtensionContext, spec: RunSpec, runId = newRunId(this.deps.now())): Promise<RunRequestResult> {
		return this.#start(ctx, spec, runId);
	}

	/**
	 * Starts an automatic probe inside the main turn that is already running, under a caller-validated plan. It sends
	 * no handoff (the turn continues), does not wait for idle or compact, and asks no dialog; the in-flight turn is the
	 * run's first round. The plan is bound before this returns, so the first spawn sees it. When the caller passes the
	 * team hash it validated the plan against, a different approved team refuses the start.
	 */
	async startWithPlan(ctx: ExtensionContext, spec: RunSpec, plan: RunPlan, configHash?: string): Promise<RunRequestResult> {
		return this.#start(ctx, spec, newRunId(this.deps.now()), plan, configHash);
	}

	async #start(
		ctx: ExtensionContext,
		spec: RunSpec,
		runId: string,
		plan?: RunPlan,
		configHash?: string,
	): Promise<RunRequestResult> {
		// A queued run is not in the way of its own start: `onAgentEnd` takes it off the queue first.
		const reason = this.refusal();
		if (reason !== undefined) return refuse(reason);
		const generation = this.#generation;
		this.#starting = true;
		try {
			return await this.#begin(ctx, spec, runId, plan, configHash, generation);
		} finally {
			this.#starting = false;
		}
	}

	/**
	 * Starts a run without making the caller wait for it. omp gives an `agent_end` handler 30 s and a compaction of a
	 * heavy context takes longer, so the handler returns at once and a refused or failed start is reported by notice.
	 */
	launch(ctx: ExtensionContext, spec: RunSpec, runId?: string): void {
		const ui = this.deps.ui(ctx);
		this.start(ctx, spec, runId).then(
			result => {
				if (!result.ok) ui.notify(`Storm 실행을 시작하지 못했습니다: ${result.reason}`, "warning");
			},
			(error: unknown) => ui.notify(`Storm 실행을 시작하지 못했습니다: ${errorText(error)}`, "error"),
		);
	}

	async #begin(
		ctx: ExtensionContext,
		requested: RunSpec,
		runId: string,
		plan: RunPlan | undefined,
		configHash: string | undefined,
		generation: number,
	): Promise<RunRequestResult> {
		// Only an automatic probe starts inside a turn that is already running; a manual start waits for its handoff.
		const auto = plan !== undefined;
		const gone = (): Refusal => refuse("세션이 바뀌어 Storm 실행을 시작하지 않았습니다.");
		const state = await this.deps.loadState(ctx);
		if (this.#generation !== generation) return gone();
		const gate = teamGate(state);
		if (!gate.ok) return refuse(gate.block.reason);
		if (configHash !== undefined && gate.hash !== configHash) {
			return refuse("계획을 검증한 팀 설정과 지금 승인된 팀 설정이 다릅니다. 계획을 다시 내세요.");
		}
		const shadow = shadowBlock(state);
		if (shadow) return refuse(shadow.reason);
		const root = state.repo.root;
		const busy = refuse("이 작업 트리에서 다른 Storm 실행이 진행 중입니다.");
		if (activeLedgerRun(root)) return busy;
		const ui = this.deps.ui(ctx);
		const ready = await this.#ready(ctx, ui, !auto);
		if (this.#generation !== generation) return gone();
		if (!ready.ok) return ready;
		if (!auto) await this.#compactFirst(ctx, ui);
		if (this.#generation !== generation) return gone();
		// The dialog and the compaction awaited: another session's run may have started meanwhile.
		if (activeLedgerRun(root)) return busy;

		// The last step before the baseline snapshot: hold the worktree execution slot for the whole run. A failed
		// acquisition is a refusal, and everything below releases it unless the run takes ownership.
		let acquired: AcquireRunLeaseResult;
		try {
			acquired = await (this.deps.lease ?? acquireRunLease)(root, runId);
		} catch (error) {
			return refuse(`실행 잠금을 확인하지 못해 시작하지 않았습니다: ${errorText(error)}`);
		}
		if (this.#generation !== generation) {
			if (acquired.ok) await this.#releaseLease(acquired.lease, ctx);
			return gone();
		}
		if (!acquired.ok) return refuse(acquired.reason);
		let lease: RunLease | undefined = acquired.lease;
		try {
			const startTree = await this.#treeAt(root);
			if (this.#generation !== generation) return gone();
			// A resumed run starts a new record; what it continues is the old record on disk, when that is still readable.
			// An automatic probe has no handoff to put it in, so it does not read the old record.
			const continued = !auto && requested.resumeOf !== undefined ? await readRun(root, requested.resumeOf) : undefined;
			if (this.#generation !== generation) return gone();
			const resume =
				continued === undefined
					? undefined
					: {
							runId: continued.runId,
							...(continued.endReason !== undefined ? { endReason: continued.endReason } : {}),
							...(continued.turns !== undefined ? { turns: continued.turns } : {}),
							...(continued.plan !== undefined ? { plan: continued.plan } : {}),
							...(continued.request !== undefined ? { requestLength: continued.request.length } : {}),
							...(requested.resumeNote !== undefined ? { said: requested.resumeNote } : {}),
						};

			if (auto) {
				// The caller validated the plan against this session's loaded team. The awaits above may have outlived
				// that authority: re-read it and refuse rather than run the old plan under a fresh approval nobody checked.
				let current: ProjectState;
				try {
					current = await this.deps.loadState(ctx);
				} catch (error) {
					return refuse(`팀 설정을 다시 확인하지 못해 시작하지 않았습니다: ${errorText(error)}`);
				}
				if (this.#generation !== generation) return gone();
				const currentGate = teamGate(current);
				if (!currentGate.ok) return refuse(currentGate.block.reason);
				const currentShadow = shadowBlock(current);
				if (currentShadow) return refuse(currentShadow.reason);
				if (current.repo.repoId !== state.repo.repoId || current.repo.root !== root) {
					return refuse("다른 프로젝트의 팀 설정으로 바뀌어 실행을 시작하지 않았습니다.");
				}
				if (currentGate.hash !== gate.hash || (configHash !== undefined && currentGate.hash !== configHash)) {
					return refuse("시작하는 동안 팀 설정이 바뀌어 실행 계획을 다시 확인해야 합니다. 다시 시도하세요.");
				}
			}
			if (activeLedgerRun(root)) return busy;

			const { config, hash } = gate;
			const { task } = requested;
			const roundLimit = maxRounds(requested, config);
			const limits =
				requested.rounds !== undefined || requested.minutes !== undefined
					? {
							...(requested.rounds !== undefined ? { rounds: requested.rounds } : {}),
							...(requested.minutes !== undefined ? { minutes: requested.minutes } : {}),
						}
					: undefined;
			const record: RunRecord = {
				schema: "storm.run/v1",
				runId,
				configHash: hash,
				startedAt: iso(this.deps.now()),
				status: "running",
				task: task.slice(0, TASK_CHARS),
				request: task.slice(0, REQUEST_LIMIT),
				...(requested.resumeOf !== undefined ? { resumeOf: requested.resumeOf } : {}),
				costUsd: 0,
				costByModel: {},
				...(config.budget ? { budget: config.budget } : {}),
				spawns: [],
				...artifactsOf(ctx),
				process: processKey(),
				turns: 0,
				maxRounds: roundLimit,
				...(plan !== undefined ? { plan } : {}),
				...(limits ? { limits } : {}),
			};
			const own: OwnRun = {
				record,
				root,
				repoId: state.repo.repoId,
				ctx,
				config,
				store: state.store,
				lanes: new RunLanes(runId),
				abort: new AbortController(),
				checks: new Map(),
				// An automatic probe starts inside a turn whose `agent_start` already happened: it is round one, not a run
				// waiting for a handoff turn that will never begin.
				turnStarted: auto,
				inTurn: auto,
				...(auto ? { auto, roundInFlight: 1 } : {}),
				maxRounds: roundLimit,
				awaitingAsync: false,
				...(startTree !== undefined ? { tree: startTree.state, base: startTree.base } : {}),
				...(requested.minutes !== undefined ? { minutes: requested.minutes } : {}),
			};
			// A stored record is untrusted input: build the message before anything of this run exists, so a bad plan or
			// reason refuses the start instead of leaving a current run without a handoff.
			let handoff: string | undefined;
			if (!auto) {
				try {
					handoff = buildHandoff({ runId, config, hash, task, maxRounds: roundLimit, ...(resume ? { resume } : {}) });
				} catch (error) {
					return refuse(`실행 계약을 만들지 못해 시작하지 않았습니다: ${errorText(error)}`);
				}
			}
			// The run takes the lease from here; a failed start finalizes and releases it through `#stop`.
			own.lease = lease;
			lease = undefined;
			this.#own = own;
			try {
				startLedgerRun({
					runId,
					repoId: own.repoId,
					root: own.root,
					...(own.base !== undefined ? { base: own.base } : {}),
					...(config.budget ? { budget: config.budget } : {}),
					onThreshold: (kind, run) => this.#threshold(ctx, kind, run),
				});
				// Bound before anything below awaits: a spawn decided the moment this returns must see the first plan.
				if (plan !== undefined) setLedgerPlan(runId, plan);
				spawnsByRun.set(runId, []);
				openRunReads(runId);
				const startingWrite = writeRun(own.root, record);
				// The final record waits for the start write, so a shutdown that lands during admission cannot overwrite it.
				this.#liveWrite = startingWrite.catch(() => undefined);
				await startingWrite;
				if (this.#generation !== generation || this.#own !== own) {
					await this.#stop(own, "start-failed", ctx).catch(() => undefined);
					return gone();
				}
				// Outside the repository, so a record committed or rewritten there is not a run this machine started.
				await noteResumePointer(state.store.dir, own.root, record).catch(() => undefined);
				if (this.#generation !== generation || this.#own !== own) {
					await this.#stop(own, "start-failed", ctx).catch(() => undefined);
					return gone();
				}
			} catch (error) {
				// This session directs and the ledger is open, but nothing was handed off: close both rather than leave a run nobody started.
				await this.#stop(own, "start-failed", ctx).catch(() => undefined);
				return refuse(`실행을 기록하지 못해 시작하지 않았습니다: ${errorText(error)}`);
			}
			liveWriters.set(runId, () => this.#scheduleFlush(own));
			this.#liveStatus(own.ctx, this.active());
			if (handoff !== undefined) {
				ui.notify(`Storm 실행을 시작합니다(${runId}).`);
				own.awaitingRound = 1;
				this.deps.pi.sendUserMessage(handoff).catch((error: unknown) => {
					delete own.awaitingRound;
					ui.notify(`실행 계약을 보내지 못했습니다: ${errorText(error)}`, "error");
					this.#stopSoon(own, "start-failed", ctx);
				});
			}
			return { ok: true, runId };
		} finally {
			if (lease !== undefined) await this.#releaseLease(lease, ctx);
		}
	}

	/**
	 * What must hold before a run starts, decided while nothing has started. omp's goal and loop modes would move the
	 * session outside Storm's run, which decides on its own when another round follows, so they are checked first: no
	 * dialog offers to leave vibe only to be refused after it. omp's vibe mode replaces the director's tools, so the
	 * team cannot run inside it either.
	 */
	async #ready(ctx: ExtensionContext, ui: UiPort, allowDialog: boolean): Promise<{ ok: true } | Refusal> {
		const modes = ctx.sessionModes;
		if (!modes) return { ok: true };
		const state = modes.getState();
		if (state.goal.status === "active") {
			return refuse("omp 목표 모드가 켜져 있어 시작하지 않았습니다. 목표를 끝내거나 일시 정지한 뒤 다시 하세요.");
		}
		if (state.loop.status !== "inactive") return refuse("omp 반복 모드가 켜져 있어 시작하지 않았습니다. 반복을 끈 뒤 다시 하세요.");
		if (state.vibe.status !== "active") return { ok: true };
		// A tool call cannot ask the user to change modes: an automatic start refuses and leaves the session as it is.
		if (!allowDialog) return refuse("omp vibe 모드가 켜져 있어 자동 실행을 시작하지 않았습니다. vibe 모드를 끈 뒤 다시 하세요.");
		const choice = await ui.select("omp vibe 모드에서는 Storm 팀을 쓸 수 없습니다. vibe 모드를 끄고 시작할까요?", [START.vibeOff, START.cancel]);
		if (choice !== START.vibeOff) return refuse("omp vibe 모드가 켜져 있어 시작하지 않았습니다.");
		const left = await modes.set({ mode: "vibe", action: "exit" });
		if (!left.ok) {
			const setting = left.code === "disabled" ? " 확장의 모드 제어가 꺼져 있으면 `omp config set extensionHandlers.modeControl true` 로 켜세요." : "";
			return refuse(`${left.message}${setting}`);
		}
		return { ok: true };
	}

	/**
	 * A heavy main context is re-sent on every director request, so it is compacted before the handoff. Never asks
	 * and never stops the start: a failed compaction is reported and the run starts on the context as it is.
	 */
	async #compactFirst(ctx: ExtensionContext, ui: UiPort): Promise<void> {
		const usage = ctx.getContextUsage();
		if (!usage || !(usage.tokens >= PREFLIGHT_TOKENS || usage.percent >= PREFLIGHT_SHARE * 100)) return;
		ui.notify(`감독 컨텍스트가 ${tokens(usage.tokens)} 토큰(창의 ${Math.round(usage.percent)}%)이라 실행 전에 먼저 압축합니다.`);
		try {
			await ctx.compact(PREFLIGHT_INSTRUCTIONS);
		} catch (error) {
			ui.notify(`컨텍스트를 압축하지 못해 그대로 시작합니다: ${errorText(error)}`, "warning");
		}
	}

	onAgentStart(): void {
		const own = this.#own;
		if (!own) return;
		this.#disarm(own);
		own.awaitingAsync = false;
		delete own.checksOnlyEnd;
		if (own.awaitingRound !== undefined) {
			own.roundInFlight = own.awaitingRound;
			delete own.awaitingRound;
		} else if (!own.turnStarted && (own.record.turns ?? 0) === 0) {
			// The handoff turn when the send did not record a round first: the run's first round still counts once.
			own.roundInFlight = 1;
		}
		own.turnStarted = true;
		own.inTurn = true;
	}

	/** True while this session runs Storm: the main session directs and does not change files itself. */
	directing(): boolean {
		return this.#own !== undefined;
	}

	/** This session's run id while it directs, without building the live record. */
	runId(): string | undefined {
		return this.#own?.record.runId;
	}

	/** The lane matcher of this session's run: the extension assigns director task names and admits successful spawns. */
	runLanes(): RunLanes | undefined {
		return this.#own?.lanes;
	}

	/** Changes this session's run record and schedules its live rewrite; a no-op without a run. */
	#update(change: (record: RunRecord) => void): void {
		const own = this.#own;
		if (!own) return;
		change(own.record);
		this.#scheduleFlush(own);
	}

	/** Spend of this (main) session while its run is active: what directing costs. */
	noteMainSpend(usd: number): void {
		this.#update(record => {
			record.mainCostUsd = (record.mainCostUsd ?? 0) + usd;
		});
	}

	/** A file change the main session tried itself; director mode sent it back to delegation. */
	noteBlockedEdit(): void {
		this.#update(record => {
			record.blockedEdits = (record.blockedEdits ?? 0) + 1;
		});
	}

	/** A follow-up to an agent past its context cap, or cleaned, that Storm sent back to a fresh agent. */
	noteBlockedFollowUp(): void {
		this.#update(record => {
			record.blockedFollowUps = (record.blockedFollowUps ?? 0) + 1;
		});
	}

	#reads(record: RunRecord): NonNullable<RunRecord["reads"]> {
		record.reads ??= { director: 0, directorChars: 0, duplicateChars: 0, blocked: 0 };
		return record.reads;
	}

	/** A director `read` of a working file returned `chars` characters; `duplicate` when a subagent of the run read that file too. */
	noteRead(chars: number, duplicate: boolean): void {
		this.#update(record => {
			const reads = this.#reads(record);
			reads.director += 1;
			reads.directorChars += chars;
			if (duplicate) reads.duplicateChars += chars;
		});
	}

	/** A director `read` Storm refused. */
	noteBlockedRead(): void {
		this.#update(record => {
			this.#reads(record).blocked += 1;
		});
	}

	/** Prompt size of a director request; the run keeps the largest. */
	noteMainContext(promptTokens: number): void {
		if (promptTokens <= (this.#own?.record.maxMainContext ?? 0)) return;
		this.#update(record => {
			record.maxMainContext = promptTokens;
		});
	}

	/** When this run last started a mid-run compaction (ms since epoch). */
	lastCheckpointAt(): number | undefined {
		const last = this.#own?.record.checkpoints?.at(-1);
		return last ? Date.parse(last.at) : undefined;
	}

	/**
	 * A mid-run compaction started at `before` tokens. `done` records the size after it; `failed` drops the entry, so a
	 * compaction omp refused (one already running, nothing to compact) neither counts nor holds off the next try.
	 */
	noteCheckpoint(before: number): { done(after: number | undefined): void; failed(): void } {
		const own = this.#own;
		if (!own) return { done: () => undefined, failed: () => undefined };
		const checkpoint: RunCheckpoint = { at: iso(this.deps.now()), before };
		own.record.checkpoints = [...(own.record.checkpoints ?? []), checkpoint];
		this.#scheduleFlush(own);
		return {
			done: after => {
				if (after === undefined || this.#own !== own) return;
				checkpoint.after = after;
				this.#scheduleFlush(own);
			},
			failed: () => {
				if (this.#own !== own) return;
				own.record.checkpoints = (own.record.checkpoints ?? []).filter(entry => entry !== checkpoint);
				this.#scheduleFlush(own);
			},
		};
	}

	/** The approved config this session's run started under. */
	runConfig(): StormConfig | undefined {
		return this.#own?.config;
	}

	/** From the storm tool's plan action: the plan this session's run spawns under, visible to every session. */
	setPlan(plan: RunPlan): { ok: true } | { ok: false; reason: string } {
		const own = this.#own;
		if (!own) return { ok: false, reason: "진행 중인 Storm 실행이 없어 계획을 저장하지 않았습니다." };
		// A stopping run blocks new spawns; its plan is no longer authority for them.
		if (!setLedgerPlan(own.record.runId, plan)) {
			return { ok: false, reason: "실행이 끝나는 중이라 계획을 적용하지 않았습니다." };
		}
		own.record.plan = plan;
		this.#scheduleFlush(own);
		return { ok: true };
	}

	/**
	 * The main session's agent loop ended. A `willContinue` end is no round: omp itself resumes the loop, and a paused
	 * run that only async work resumes waits for one. When it settled (no automatic continuation, no background work
	 * that will resume it) a round of the run is over and the round rules decide what follows; and a queued run
	 * starts, detached from this handler, unless the user interrupted the turn that queued it.
	 */
	async onAgentEnd(
		event: { willContinue?: boolean; awaitingAsyncWork?: boolean; messages?: readonly unknown[] },
		ctx: ExtensionContext,
	): Promise<void> {
		const own = this.#own;
		if (event.awaitingAsyncWork) {
			// Only a new turn resumes this run, so a terminal end with no turn in between stopped the wait.
			if (own) own.awaitingAsync = true;
			return;
		}
		if (event.willContinue) return;
		// Esc while paused on async work ends the run without an aborted message and without a new agent_start.
		const stoppedWait = own?.awaitingAsync === true;
		if (own) own.awaitingAsync = false;
		if (own?.turnStarted) await this.#turnSettled(own, ctx, stoppedWait || turnAborted(event.messages));
		const pending = this.#pending;
		if (!pending) return;
		this.#pending = undefined;
		if (turnAborted(event.messages)) {
			this.deps.ui(ctx).notify(`응답을 중단해서 예약한 Storm 실행(${pending.runId})을 시작하지 않았습니다.`);
			return;
		}
		this.launch(ctx, pending.spec, pending.runId);
	}

	/**
	 * A turn of the run settled: the reason decided during the turn stands, otherwise the round rules decide whether
	 * another round follows.
	 */
	async #turnSettled(own: OwnRun, ctx: ExtensionContext, aborted: boolean): Promise<void> {
		if (own.inTurn) {
			own.inTurn = false;
			// A user clarification/activity turn is a turn but not another verification round: only a round Storm
			// scheduled (or the initial handoff) consumes the budget.
			if (own.roundInFlight !== undefined) {
				own.record.turns = Math.max(own.record.turns ?? 0, own.roundInFlight);
				delete own.roundInFlight;
				this.#scheduleFlush(own);
			}
		}
		if (own.awaitingRound !== undefined) delete own.awaitingRound;
		if (own.ending !== undefined) return this.#stop(own, own.ending, ctx);
		await this.#decide(own, ctx, aborted);
	}

	/**
	 * The decision after a settled round: the run ends here, or the next round waits out the delay. Inside this
	 * handler omp is still closing the turn, so nothing is sent from it.
	 */
	async #decide(own: OwnRun, ctx: ExtensionContext, aborted: boolean): Promise<void> {
		const turns = own.record.turns ?? 0;
		const decision = await this.#roundDecision(own, aborted, false);
		// The tree read may have outlasted the round: a new turn or an end decided meanwhile owns the run now.
		if (!this.#live(own, turns)) return;
		if (decision.action === "end") {
			// A ready required check is verification, not another model round. Give it one timer look before a budget
			// end, so a last-round review can still be proven or honestly fail.
			if ((decision.reason === "round-limit" || decision.reason === "no-progress") && (await this.#hasPendingCheck(own))) {
				if (!this.#live(own, turns)) return;
				own.checksOnlyEnd = decision.reason;
				this.#arm(own, ctx, ROUND_DELAY_MS);
				return;
			}
			return this.#stop(own, decision.reason, ctx);
		}
		this.#arm(own, ctx, ROUND_DELAY_MS);
	}

	/**
	 * Whether a required check is ready to run for this tree and could still change the gate. It is not a review,
	 * another model round, or a reason to replay a check already attempted for this tree.
	 */
	async #hasPendingCheck(own: OwnRun): Promise<boolean> {
		if ((own.config.requiredChecks?.length ?? 0) === 0) return false;
		if (own.ending !== undefined || own.abort.signal.aborted) return false;
		const now = await this.#treeAt(own.root, own.base);
		if (now === undefined) return false;
		const agents = this.deps.agents?.(own.record.runId) ?? [];
		const planLanes = this.#planLanes(own, agents);
		if (planLanes?.some(lane => lane.state !== "done")) return false;
		const fingerprint = treeFingerprint(now.state);
		if (own.checking !== undefined || own.checks.has(fingerprint)) return false;
		const gate = reviewGate(
			agents,
			own.config,
			{
				...(own.tree !== undefined ? { start: own.tree } : {}),
				now: now.state,
				...(own.rereviewedAt !== undefined ? { rereviewedAt: own.rereviewedAt } : {}),
			},
			{ checks: [], lanes: planLanes ?? [] },
		);
		return gate.state === "unverified" && gate.cause === "coverage";
	}

	/** Whether `own` is still what the decision was taken from: this session's run, the same round, and not already ending. */
	#live(own: OwnRun, turns: number): boolean {
		return this.#own === own && !own.inTurn && own.ending === undefined && (own.record.turns ?? 0) === turns;
	}

	/** The round's decision from the tree now and the gate as the ledger has it after that. */
	async #roundDecision(own: OwnRun, aborted: boolean, allowChecks: boolean): Promise<RoundDecision> {
		let now = await this.#treeAt(own.root, own.base);
		const agents = this.deps.agents?.(own.record.runId) ?? [];
		const planLanes = this.#planLanes(own, agents);
		const tree = {
			...(own.tree !== undefined ? { start: own.tree } : {}),
			...(now !== undefined ? { now: now.state } : {}),
			...(own.rereviewedAt !== undefined ? { rereviewedAt: own.rereviewedAt } : {}),
		};
		// The pure gate already knows empty coverage (no checks, no lanes) from the start. Checks run only from the
		// look timer, never inside omp's agent_end handler: they may take far longer than its budget.
		const initial: CoverageInput = { checks: [], lanes: planLanes ?? [] };
		if (allowChecks && !aborted) now = await this.#maybeRunChecks(own, reviewGate(agents, own.config, tree, initial), now, planLanes);
		const currentTree = {
			...(tree.start !== undefined ? { start: tree.start } : {}),
			...(now !== undefined ? { now: now.state } : {}),
			...(tree.rereviewedAt !== undefined ? { rereviewedAt: tree.rereviewedAt } : {}),
		};
		const coverage = this.#coverage(own, now?.state, planLanes);
		const gate = reviewGate(agents, own.config, currentTree, coverage);
		return decideRound({
			gate,
			turns: own.record.turns ?? 0,
			maxRounds: own.maxRounds,
			aborted,
			overBudget: getLedgerRun(own.record.runId)?.exceeded ?? false,
			elapsedMs: this.deps.now() - Date.parse(own.record.startedAt),
			...(own.minutes !== undefined ? { minutes: own.minutes } : {}),
			...(own.progress ? { progressSince: own.progress } : {}),
		});
	}

	/** Plan lanes as coverage evidence: only a lane with an admitted, settled worker is done. */
	#planLanes(own: OwnRun, agents: readonly AgentEntry[]): CoverageLane[] | undefined {
		const plan = own.record.plan;
		if (plan === undefined) return undefined;
		const remaining = new Set(own.lanes.remaining(plan, agents, this.#failedIds(own, agents)));
		return plan.lanes.map(lane => ({ name: lane.name, state: remaining.has(lane.name) ? "pending" : "done" }));
	}

	/** The latest native task outcome also catches admission and merge failures outside a child's agent loop. */
	#failedIds(own: OwnRun, agents: readonly AgentEntry[]): ReadonlySet<string> {
		const failed = new Set<string>();
		const snapshot = this.#asyncSnapshot(own.ctx);
		if (!snapshot) return failed;
		const bound = new Set(agents.map(agent => agent.id));
		for (const spawn of spawnsByRun.get(own.record.runId) ?? []) if (spawn.spawnKey !== undefined) bound.add(spawn.spawnKey);
		const latest = new Map<string, (typeof snapshot.recent)[number]>();
		for (const job of snapshot.recent) {
			if (job.agentId === undefined || !bound.has(job.agentId)) continue;
			const other = latest.get(job.agentId);
			if (other === undefined || (job.endTime ?? job.startTime) > (other.endTime ?? other.startTime)) latest.set(job.agentId, job);
		}
		for (const [id, job] of latest) {
			if (job.status === "failed" || job.status === "cancelled") failed.add(id);
		}
		return failed;
	}

	#asyncSnapshot(ctx: ExtensionContext) {
		try {
			return ctx.getAsyncJobSnapshot?.();
		} catch {
			return undefined;
		}
	}

	/** The evidence the gate may use for this exact tree; a missing or stale report stays missing, never a pass. */
	#coverage(own: OwnRun, tree: TreeState | undefined, planLanes: CoverageLane[] | undefined): CoverageInput {
		const coverage: CoverageInput = { checks: [], lanes: planLanes ?? [] };
		const required = own.config.requiredChecks?.map(check => check.name) ?? [];
		if (required.length) coverage.requiredChecks = required;
		if (tree === undefined) return coverage;
		const fingerprint = treeFingerprint(tree);
		coverage.fingerprint = fingerprint;
		const cached = own.checks.get(fingerprint);
		const report = cached === "skipped" ? undefined : cached;
		if (report !== undefined && report.configHash === own.record.configHash) {
			const checks: CoverageCheck[] = report.checks.map(check => ({
				name: check.name,
				status: check.status,
				tree: report.fingerprint,
				...(check.finishedAt !== null ? { finishedAt: check.finishedAt } : {}),
			}));
			coverage.checks = checks;
			coverage.complete = report.complete;
			coverage.aborted = report.aborted;
		} else if (required.length) {
			coverage.checks = [];
			coverage.complete = false;
		}
		return coverage;
	}

	/**
	 * Runs the approved required checks once for this tree when a passing gate is otherwise possible. It never runs
	 * for no-change/readonly work, an unapproved or changed config, or a run already stopping. A tree that moves while
	 * checks run is reported as lacking evidence now and evaluated once on the next look.
	 */
	async #maybeRunChecks(
		own: OwnRun,
		base: Gate,
		now: TreeReading | undefined,
		planLanes: CoverageLane[] | undefined,
	): Promise<TreeReading | undefined> {
		if (now === undefined || (own.config.requiredChecks?.length ?? 0) === 0) return now;
		// A check-ready state is not only no-proof: a quick-only change or a review whose check evidence is still
		// missing also needs the runner before it can be a pass or a quick-only end.
		if (base.state !== "unverified") return now;
		if (base.cause !== "no-proof" && base.cause !== "coverage") return now;
		if (own.ending !== undefined || own.abort.signal.aborted) return now;
		if (planLanes?.some(lane => lane.state !== "done")) return now;
		const fingerprint = treeFingerprint(now.state);
		if (own.checking !== undefined || own.checks.has(fingerprint)) return now;
		own.checking = fingerprint;
		try {
			const state = await this.deps.loadState(own.ctx).catch(() => undefined);
			if (this.#own !== own || own.ending !== undefined || own.abort.signal.aborted) return now;
			// A changed hash or a withdrawal of approval is not permission to run the run's old checks.
			if (state === undefined || state.config.status !== "ok") {
				own.checks.set(fingerprint, "skipped");
				return now;
			}
			const currentGate = teamGate(state);
			if (!currentGate.ok || currentGate.hash !== own.record.configHash || !isApproved(state)) {
				own.checks.set(fingerprint, "skipped");
				return now;
			}
			const report = await runRequiredChecks({
				config: state.config,
				approval: currentGate.approval,
				cwd: own.root,
				fingerprint,
				signal: own.abort.signal,
			});
			if (this.#own !== own) return now;
			if (report.status === "skipped") {
				own.checks.set(fingerprint, "skipped");
				return now;
			}
			own.checks.set(fingerprint, report);
			own.checkEvidence = report.checks.map(check => ({
				name: check.name,
				status: check.status,
				exitCode: check.exitCode,
				tree: report.fingerprint,
			}));
			this.#scheduleFlush(own);
			if (report.aborted) return now;
			// The tree may have moved while checks ran. Return the fresh read, including undefined when it cannot be
			// read: binding this report to an unknown tree is never allowed.
			return await this.#treeAt(own.root, own.base);
		} finally {
			if (own.checking === fingerprint) delete own.checking;
		}
	}

	/** The work tree at `root` against `base`, or no tree when the host has none or the read fails. */
	async #treeAt(root: string, base?: string): Promise<TreeReading | undefined> {
		try {
			return await this.deps.tree?.(root, base);
		} catch {
			return undefined;
		}
	}

	/**
	 * The look after a wait, taken from fresh gate data: ends the run, waits out a held session, or sends the next
	 * round. The only place a round message is sent from.
	 */
	async #look(own: OwnRun, ctx: ExtensionContext): Promise<void> {
		// A held session is no round, and a tree read is two git processes: wait out the hold before deciding.
		if (this.#held(ctx)) return this.#arm(own, ctx, HOLD_MS);
		const turns = own.record.turns ?? 0;
		const checkOnly = own.checksOnlyEnd;
		const decision = await this.#roundDecision(own, false, true);
		if (!this.#live(own, turns)) return;
		if (checkOnly !== undefined) {
			delete own.checksOnlyEnd;
			// Verification-only: the check outcome may end verified, or the original budget end stands. Never send a
			// model round from here, and never schedule a second look for the same tree.
			if (decision.action === "end") return this.#stop(own, decision.reason, ctx);
			return this.#stop(own, checkOnly, ctx);
		}
		if (decision.action === "end") return this.#stop(own, decision.reason, ctx);
		this.#sendRound(own, ctx, decision.gate, decision.round);
	}

	/**
	 * Whether omp is holding the next turn on purpose: the session is streaming, has a submission queued, plan mode is
	 * on, or the user has a draft in the editor. `isIdle` only means "not streaming", so a send during a compaction
	 * would also wait inside omp's `prompt()`. A held round is not a round.
	 */
	#held(ctx: ExtensionContext): boolean {
		if (!ctx.isIdle() || ctx.hasPendingMessages()) return true;
		if (ctx.sessionModes?.getState().plan.status === "active") return true;
		return ctx.hasUI && ctx.ui.getEditorText().trim() !== "";
	}

	/** Looks again after `ms`, as long as the run, the session state and the end decided so far still allow it. */
	#arm(own: OwnRun, ctx: ExtensionContext, ms: number): void {
		this.#disarm(own);
		own.hold = (this.deps.timers ?? REAL_TIMERS).set(() => {
			delete own.hold;
			if (this.#own !== own || own.inTurn || own.ending !== undefined) return;
			void this.#look(own, ctx).catch((error: unknown) =>
				this.deps.ui(ctx).notify(`Storm 실행을 이어가지 못했습니다: ${errorText(error)}`, "error"),
			);
		}, ms);
	}

	#disarm(own: OwnRun): void {
		if (own.hold === undefined) return;
		(this.deps.timers ?? REAL_TIMERS).clear(own.hold);
		delete own.hold;
	}

	/** Ends the run from a timer or a rejected send: a failure to record it is reported, not left unhandled. */
	#stopSoon(own: OwnRun, reason: RunEndReason, ctx: ExtensionContext): void {
		void this.#stop(own, reason, ctx).catch((error: unknown) =>
			this.deps.ui(ctx).notify(`Storm 실행을 끝내지 못했습니다: ${errorText(error)}`, "error"),
		);
	}

	/**
	 * Starts round `round`: remembers what the gate saw, says so, and hands the main session the round's message.
	 * omp resolves `sendUserMessage` only when the turn it starts is over, so nothing here waits on it.
	 */
	#sendRound(own: OwnRun, ctx: ExtensionContext, gate: RoundGate, round: number): void {
		if (own.ending !== undefined || this.#own !== own) return;
		const ui = this.deps.ui(ctx);
		own.progress = { changes: gate.changes, reviews: gate.reviews, requests: gate.requests };
		// Only a review repair needs a reviewer name; a lane or check repair round has no review to request.
		const reviewer = usableRole(own.config, "reviewer")?.agent;
		// Tree-only staleness is asked about once: a verdict given from now on is honoured whatever the tree does.
		if (gate.by === "tree" && own.rereviewedAt === undefined) own.rereviewedAt = this.deps.now();
		ui.notify(`검증되지 않은 변경이 있어 ${round}라운드를 시작합니다(최대 ${own.maxRounds}라운드).`);
		this.#liveStatus(ctx, this.active());
		own.awaitingRound = round;
		this.deps.pi.sendUserMessage(
			buildRoundMessage({ runId: own.record.runId, round, maxRounds: own.maxRounds, gate, ...(reviewer !== undefined ? { reviewer } : {}) }),
		).catch((error: unknown) => {
			// No turn started from this message: a later user turn must not be mistaken for the scheduled round.
			if (own.awaitingRound === round) delete own.awaitingRound;
			// The user interrupted the prompt's setup: no round started, so nothing about it is unverified progress.
			if (promptDropped(error)) {
				this.#stopSoon(own, "interrupted", ctx);
				return;
			}
			ui.notify(`라운드 메시지를 보내지 못했습니다: ${errorText(error)}`, "warning");
			this.#stopSoon(own, "no-progress", ctx);
		});
	}

	/** Ends `own` for `reason` unless an earlier reason stands; a run that is no longer this session's is left alone. */
	async #stop(own: OwnRun, reason: RunEndReason, ctx: ExtensionContext): Promise<void> {
		if (this.#own !== own) return;
		own.ending ??= reason;
		await this.finish(own.ending, ctx);
	}

	/** Ends this session's run (if any), writes its record and reports the summary. */
	async finish(reason: RunEndReason, ctx?: ExtensionContext): Promise<RunRecord | undefined> {
		// A queued run belongs to the session that shut down or switched; the next one starts clean.
		if (reason === "shutdown") this.#pending = undefined;
		const running = this.#finishing;
		if (running !== undefined) return running;
		// A start still awaiting must not continue in the session this run belonged to.
		this.#generation += 1;
		const own = this.#own;
		if (!own) return undefined;
		own.ending ??= reason;
		if (ctx !== undefined) own.finishCtx ??= ctx;
		own.abort.abort();
		this.#disarm(own);
		const ledger = getLedgerRun(own.record.runId);
		if (ledger) ledger.closing = true;
		// Never throw away scope, lease or accounting while owned work is alive. The stopped run keeps them and a
		// detached timer rechecks; a shutdown handler therefore returns without waiting for the work.
		if (this.#hasLiveWork(own)) {
			this.#deferFinalize(own);
			return undefined;
		}
		const task = (async () => {
			let finalReason = own.ending ?? reason;
			if (finalReason === "verified" && own.drained === true) finalReason = await this.#recheckVerified(own);
			return this.#finalize(own, finalReason, own.finishCtx);
		})();
		this.#finishing = task;
		try {
			return await task;
		} finally {
			if (this.#finishing === task) this.#finishing = undefined;
		}
	}

	/** Schedules the next look at this stopping run's owned work; the timer never holds the caller. */
	#deferFinalize(own: OwnRun): void {
		if (own.drainTimer !== undefined) return;
		own.drained = true;
		const polls = (own.drainPolls ?? 0) + 1;
		own.drainPolls = polls;
		if (!own.drainWarned && polls * DRAIN_POLL_MS > DRAIN_MAX_MS) {
			own.drainWarned = true;
			const ctx = own.finishCtx;
			if (ctx) {
				this.deps.ui(ctx).notify(
					"Storm 실행이 소유한 작업이 제한 시간 안에 끝나지 않습니다. 실행 범위·잠금·회계를 유지한 채 작업이 끝날 때까지 기다립니다.",
					"warning",
				);
			}
		}
		const timers = this.deps.timers ?? REAL_TIMERS;
		own.drainTimer = timers.set(() => {
			delete own.drainTimer;
			if (this.#own !== own) return;
			if (this.#hasLiveWork(own)) {
				this.#deferFinalize(own);
				return;
			}
			void this.#finishDeferred(own).catch((error: unknown) => {
				const ctx = own.finishCtx;
				if (ctx) this.deps.ui(ctx).notify(`Storm 실행을 끝내지 못했습니다: ${errorText(error)}`, "error");
			});
		}, DRAIN_POLL_MS);
	}

	/** Finalizes a drained run once its owned work has settled; shares the one-finalization guard. */
	async #finishDeferred(own: OwnRun): Promise<RunRecord | undefined> {
		const running = this.#finishing;
		if (running !== undefined) return running;
		if (this.#own !== own) return undefined;
		const task = (async () => {
			let finalReason = own.ending ?? "no-progress";
			if (finalReason === "verified" && own.drained === true) finalReason = await this.#recheckVerified(own);
			return this.#finalize(own, finalReason, own.finishCtx);
		})();
		this.#finishing = task;
		try {
			return await task;
		} finally {
			if (this.#finishing === task) this.#finishing = undefined;
		}
	}

	/**
	 * A would-be verified run that drained rechecks the current tree and proof before keeping that label. A verdict or
	 * check bound to the pre-drain tree is not replayed as authority for the tree that remains.
	 */
	async #recheckVerified(own: OwnRun): Promise<RunEndReason> {
		const now = await this.#treeAt(own.root, own.base);
		const agents = this.deps.agents?.(own.record.runId) ?? [];
		const planLanes = this.#planLanes(own, agents);
		const coverage = this.#coverage(own, now?.state, planLanes);
		const gate = reviewGate(
			agents,
			own.config,
			{
				...(own.tree !== undefined ? { start: own.tree } : {}),
				...(now !== undefined ? { now: now.state } : {}),
				...(own.rereviewedAt !== undefined ? { rereviewedAt: own.rereviewedAt } : {}),
			},
			coverage,
		);
		if (gate.state === "passed") return "verified";
		if (gate.state === "none") {
			if (gate.why === "no-changes") return "no-changes";
			if (gate.why === "quick-only") return "unreviewed";
			return "no-reviewer";
		}
		return "no-progress";
	}

	/** Whether this run still owns live work: a running agent, a running check, or a job bound to its agents/spawns. */
	#hasLiveWork(own: OwnRun): boolean {
		if (own.checking !== undefined) return true;
		const agents = this.deps.agents?.(own.record.runId) ?? [];
		if (agents.some(agent => agent.state === "running")) return true;
		const snapshot = this.#asyncSnapshot(own.ctx);
		if (!snapshot) return false;
		const bound = new Set(agents.map(agent => agent.id));
		for (const spawn of spawnsByRun.get(own.record.runId) ?? []) if (spawn.spawnKey !== undefined) bound.add(spawn.spawnKey);
		return [...snapshot.running].some(
			job =>
				(job.agentId !== undefined && bound.has(job.agentId)) ||
				(job.ownerId !== undefined && bound.has(job.ownerId)),
		);
	}

	/** Writes the final record and releases the lease; only runs after owned work has settled. */
	async #finalize(own: OwnRun, reason: RunEndReason, ctx: ExtensionContext | undefined): Promise<RunRecord | undefined> {
		if (this.#own !== own) return undefined;
		this.#own = undefined;
		delete own.awaitingRound;
		delete own.roundInFlight;
		delete own.checksOnlyEnd;
		this.#disarm(own);
		if (own.drainTimer !== undefined) {
			(this.deps.timers ?? REAL_TIMERS).clear(own.drainTimer);
			delete own.drainTimer;
		}
		clearTimeout(this.#flushTimer);
		this.#flushTimer = undefined;
		liveWriters.delete(own.record.runId);
		const ledger = endLedgerRun(own.record.runId);
		const spawns = spawnsByRun.get(own.record.runId) ?? [];
		spawnsByRun.delete(own.record.runId);
		clearRunReads(own.record.runId);
		const seen = this.deps.agents?.(own.record.runId) ?? [];
		// A team with doc consistency off asked for no doc findings, so none are counted.
		const agents = docsEnabled(own.config) ? seen : seen.map(withoutDocFindings);
		const record: RunRecord = {
			...own.record,
			endedAt: iso(this.deps.now()),
			status: ledger?.exceeded ? "budget-exceeded" : END_STATUS[reason],
			endReason: reason,
			costUsd: ledger?.costUsd ?? own.record.costUsd,
			costByModel: { ...(ledger?.costByModel ?? own.record.costByModel) },
			spawns,
			...(agents.length ? { agents } : {}),
		};
		if (own.checkEvidence?.length) record.checks = own.checkEvidence;
		try {
			await this.#liveWrite;
			// Only runs this machine recorded are ever cleaned later: run records in the repo are not trusted for paths.
			if (record.artifactsDir && record.process) {
				await recordTrustedRun(own.store.dir, {
					runId: record.runId,
					artifactsDir: record.artifactsDir,
					process: record.process,
					agents: agents.map(agent => agent.id),
					endedAt: record.endedAt ?? iso(this.deps.now()),
				}).catch(() => undefined);
			}
			// A shutdown (no ctx) must not wait on file cleanup; the next run's end catches up.
			const cleaned = ctx ? await this.#cleanUp(own, record, agents, ctx) : [];
			await writeRun(own.root, record);
			await appendRunIndex(own.root, summarizeForIndex(record)).catch(() => undefined);
			// The idle status line reads the last run from disk: report only once the final record is there.
			if (ctx) this.#liveStatus(ctx, undefined);
			const protect = await protectedResumeRunIds(own.store.dir, own.root).catch(() => []);
			await pruneRuns(own.root, RUN_KEEP, protect);
			if (cleaned.length) markAgentsCleaned(cleaned, this.deps.now());
			// An automatic probe stays out of the main transcript while it is routine; a blocked spawn is not routine, and
			// the live status line already carried the rest.
			const quietAuto =
				own.auto === true &&
				(record.endReason === "no-changes" || record.endReason === "verified") &&
				!record.spawns.some(spawn => spawn.outcome === "blocked");
			if (ctx && !quietAuto) this.deps.ui(ctx).record("Storm 실행 결과", summarizeRun(record));
			return record;
		} finally {
			if (own.lease !== undefined) await this.#releaseLease(own.lease, ctx);
		}
	}

	/** Releases the execution slot, surfacing a failed release instead of silently leaving it to a later owner. */
	async #releaseLease(lease: RunLease, ctx?: ExtensionContext): Promise<void> {
		try {
			await lease.release();
		} catch (error) {
			if (ctx) this.deps.ui(ctx).notify(`Storm 실행 잠금을 해제하지 못했습니다: ${errorText(error)}`, "error");
		}
	}

	/** Storm's limits and, when the team allows it, omp records of older runs' parked agents; best-effort. */
	async #cleanUp(own: OwnRun, record: RunRecord, agents: AgentEntry[], ctx: ExtensionContext): Promise<string[]> {
		try {
			// Consent and trials come from the approval in force now too: a consent withdrawn mid-run stops deletion.
			const state = await this.deps.loadState(ctx);
			const gate = teamGate(state);
			const agentDir = this.deps.agentDir;
			const { result, cleaned } = await runJanitor({
				root: own.root,
				storeDir: state.store.dir,
				// Without a known agent dir nothing of omp's is deleted: the config below then carries no consent.
				sessionsRoot: agentDir ? path.join(agentDir, "sessions") : "",
				config: gate.ok && agentDir ? gate.config : withoutCleanup(gate.ok ? gate.config : own.config),
				startConfig: own.config,
				configHash: gate.ok ? gate.hash : own.record.configHash,
				runId: own.record.runId,
				process: own.record.process ?? processKey(),
				now: this.deps.now(),
				ledger: this.deps.ledger?.() ?? agents,
				approvals: state.store,
				...(agentDir ? { agentDir } : {}),
			});
			if (result.agents || result.stormFiles) record.cleanup = result;
			return cleaned;
		} catch {
			// The run's own record and summary come first; whatever was left is retried at the next run end.
			return [];
		}
	}

	/** The status line's live record; a hook that throws must not keep the run from ending. */
	#liveStatus(ctx: ExtensionContext, run: RunRecord | undefined): void {
		try {
			this.deps.live?.(ctx, run);
		} catch {
			// A convenience of the screen: no run decision reads what it shows.
		}
	}

	#scheduleFlush(own: OwnRun): void {
		if (this.#flushTimer) return;
		this.#flushTimer = setTimeout(() => {
			this.#flushTimer = undefined;
			const live = this.active();
			// A run that finished meanwhile has already written its final record.
			if (!live || this.#own !== own) return;
			this.#liveStatus(own.ctx, live);
			this.#liveWrite = writeRun(own.root, { ...live, updatedAt: iso(this.deps.now()) }).catch(() => undefined);
		}, this.deps.flushMs ?? LIVE_FLUSH_MS);
		this.#flushTimer.unref?.();
	}

	#threshold(ctx: ExtensionContext, kind: "warn" | "limit", run: LedgerRun): void {
		const ui = this.deps.ui(ctx);
		const budget = run.budget;
		if (kind === "warn") {
			ui.notify(`Storm 실행 비용이 경고선 ${formatUsd(budget?.warnAtUsd ?? 0)}에 닿았습니다(누계 ${formatUsd(run.costUsd)}).`, "warning");
			return;
		}
		const stop = budget?.onExceed === "stop";
		ui.notify(
			`Storm 실행 예산 ${formatUsd(budget?.perRunUsd ?? 0)}을 넘었습니다(누계 ${formatUsd(run.costUsd)}). ${stop ? "실행을 중단합니다." : "새 스폰을 차단합니다."}`,
			"warning",
		);
		if (!stop) return;
		const own = this.#own?.record.runId === run.runId ? this.#own : undefined;
		if (own) own.ending ??= "budget";
		if (own && !own.inTurn) {
			// Between turns there is nothing to abort, and no turn's end to wait for: omp would run one more.
			void this.#stop(own, "budget", ctx).catch((error: unknown) => ui.notify(`Storm 실행을 끝내지 못했습니다: ${errorText(error)}`, "error"));
			return;
		}
		// The aborted turn's end finishes the run.
		ctx.abort();
	}
}

const OUTCOME_LABEL: Record<SpawnRecord["outcome"], string> = {
	routed: "승인 모델",
	trial: "시험 사용",
	allowed: "그대로 허용",
	substituted: "대체 역할로 교체",
	blocked: "차단",
};

const BLOCK_LABEL: Record<SpawnBlockCode, string> = {
	"no-config": "팀 설정 문제",
	unapproved: "미승인",
	shadow: "미승인 역할 정의",
	"disabled-role": "쓰지 않는 역할",
	"no-plan": "계획 없음",
	"role-not-in-plan": "계획에 없는 역할",
	"role-cap": "역할 워커 상한",
	parallelism: "동시 상한",
	budget: "예산 초과",
	internal: "내부 오류",
};

function tally<K extends string>(keys: readonly K[], label: (key: K) => string): string {
	const counts = new Map<K, number>();
	for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
	return [...counts].map(([key, n]) => `${label(key)} ${n}`).join(" · ");
}

/** The run's record in the transcript: at most five lines, the one Storm output that stays there. */
export function summarizeRun(run: RunRecord): string {
	const blockCodes = run.spawns.flatMap(spawn => (spawn.outcome === "blocked" && spawn.code ? [spawn.code] : []));
	const spawnLine = run.spawns.length
		? tally(
				run.spawns.map(spawn => spawn.outcome),
				outcome => OUTCOME_LABEL[outcome] ?? outcome,
			)
		: "없음";
	const blockLine = blockCodes.length ? ` · 차단 사유: ${tally(blockCodes, code => BLOCK_LABEL[code] ?? code)}` : "";
	const end = run.endReason ? ` · ${endLabel(run.endReason)}` : "";
	// Records of 0.10 and earlier counted no rounds; `maxRounds` is absent from those written before it was kept.
	const rounds =
		run.turns === undefined
			? ""
			: run.maxRounds !== undefined
				? ` · ${run.turns}/${run.maxRounds}라운드`
				: ` · ${run.turns}라운드`;
	const lines = [
		`- 실행: ${run.runId} (${STATUS_LABEL[run.status]}${end})${rounds} · 비용(정가 환산) ${formatUsd(run.costUsd)}${run.budget ? ` / 예산 ${formatUsd(run.budget.perRunUsd)}` : ""}${run.plan ? ` · ${planText(run.plan)}` : ""}`,
		`- 스폰: ${spawnLine}${blockLine}`,
	];
	const main: string[] = [];
	if (run.mainCostUsd !== undefined && run.costUsd > 0) {
		main.push(`비용 ${formatUsd(run.mainCostUsd)}(전체의 ${Math.round((run.mainCostUsd / run.costUsd) * 100)}%)`);
	}
	if (run.blockedEdits) main.push(`직접 수정 ${run.blockedEdits}회를 위임으로 돌림`);
	if (run.blockedFollowUps) main.push(`후속 지시 ${run.blockedFollowUps}회를 새 서브에이전트로 돌림`);
	const reads = run.reads;
	// Records of 0.9 counted calls, not characters: they have no share to show.
	if (reads?.directorChars) {
		main.push(`읽기 ${tokens(reads.directorChars)}자(서브에이전트와 겹침 ${Math.round((reads.duplicateChars / reads.directorChars) * 100)}%)`);
	}
	if (reads?.blocked) main.push(`큰 읽기 ${reads.blocked}회를 막음`);
	if (run.maxMainContext) main.push(`최대 컨텍스트 ${tokens(run.maxMainContext)}`);
	if (run.checkpoints?.length) main.push(`실행 중 압축 ${run.checkpoints.length}회`);
	if (main.length) lines.push(`- 감독: ${main.join(" · ")}`);
	const agents = run.agents ?? [];
	const cleanup = run.cleanup?.agents ? `정리: 이전 실행 서브에이전트 기록 ${run.cleanup.agents}개(${bytesText(run.cleanup.bytes)})` : "";
	if (agents.length) {
		const followUps = agents.reduce((sum, agent) => sum + agent.followUps, 0);
		const reused = agents.filter(agent => agent.followUps > 0).length;
		lines.push(`- 서브에이전트: ${agents.length}개 · 재사용 ${reused}개(후속 지시 ${followUps}회)${cleanup ? ` · ${cleanup}` : ""}`);
	} else if (cleanup) {
		lines.push(`- ${cleanup}`);
	}
	if (run.spawns.length) lines.push(reviewLine(agents));
	return lines.join("\n");
}

/** `계획 레인 3(구현 2 · 리뷰 1)`: the plan's lanes counted per role, in lane order. */
function planText(plan: RunPlan): string {
	const roles = tally(
		plan.lanes.map(lane => lane.role),
		roleTitle,
	);
	return `계획 레인 ${plan.lanes.length}${roles ? `(${roles})` : ""}`;
}
