/**
 * Storm run lifecycle for one main session. A run starts from `/storm` at once, or from the storm tool once the turn
 * that queued it settles: team gate, mode preconditions, compaction of a heavy context, omp's goal or loop mode,
 * then the handoff. Its mode decides when it ends: a vibe run when the session settles, a goal run when omp's goal
 * ends, a loop run when omp's loop stops. Spawn decisions arrive from any session in the process (children
 * included), so they are collected per run in module scope.
 */
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext, SessionModeRequest, SessionModeState } from "@oh-my-pi/pi-coding-agent";
import type { ApprovalStore } from "../approval/store.ts";
import { docsEnabled } from "../policy/docs.ts";
import { clearRunReads, openRunReads } from "../policy/reads.ts";
import { formatUsd, shadowBlock, teamGate } from "../policy/spawn.ts";
import { tokens } from "../report/agents.ts";
import { PREFLIGHT_SHARE, PREFLIGHT_TOKENS, roleTitle } from "../roles.ts";
import type { ProjectState } from "../state.ts";
import type { RunRequestResult } from "../tool/host.ts";
import type {
	AgentEntry,
	RunCheckpoint,
	RunEndReason,
	RunPlan,
	RunRecord,
	RunSpec,
	RunStatus,
	SpawnBlockCode,
	SpawnRecord,
	StormConfig,
	UiPort,
} from "../types.ts";
import { markAgentsCleaned } from "./agents.ts";
import { bytesText, processKey, recordTrustedRun, runJanitor } from "./janitor.ts";
import { activeLedgerRun, endLedgerRun, type LedgerRun, setLedgerPlan, startLedgerRun } from "./ledger.ts";
import { END_LABEL, END_STATUS, GOAL_NUDGE, goalEnd, MAX_NUDGES, MODE_LABEL, modeEnd, modeFailureText, modeRequest, modeText, STALL_MS } from "./modes.ts";
import { reviewLine } from "./review.ts";
import { buildHandoff, newRunId, pruneRuns, writeRun } from "./run.ts";
import { appendRunIndex, summarizeForIndex } from "./run-index.ts";

const spawnsByRun = new Map<string, SpawnRecord[]>();

/** Debounced writers of the runs owned by sessions in this process, keyed by run id. */
const liveWriters = new Map<string, () => void>();
/**
 * How often an active run's record is rewritten at most. The live record is what remains of a run whose process
 * dies: the next run's janitor marks it stopped and it shows up as the last run with what it had spent and spawned.
 */
const LIVE_FLUSH_MS = 2_000;

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

/** Called by the spawn hook of whichever session decided the spawn. */
export function noteRunSpawn(runId: string, record: SpawnRecord): void {
	const list = spawnsByRun.get(runId);
	if (list) list.push(record);
	else spawnsByRun.set(runId, [record]);
	touchRun(runId);
}

/** How much of the request a run record keeps. */
const TASK_CHARS = 200;
/**
 * Ends after which omp's goal or loop must not stay on: those Storm decides itself, and a paused loop, whose next
 * typed message omp would take as a new loop body and repeat outside any run.
 */
const LEAVE_MODE: readonly RunEndReason[] = ["budget", "goal-stalled", "start-failed", "loop-paused"];

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

interface OwnRun {
	record: RunRecord;
	root: string;
	repoId: string;
	/** The approved config the run started under. */
	config: StormConfig;
	/** Approval records of the repo: the run-end janitor keeps them within their limits. */
	store: ApprovalStore;
	/** The handoff turn has begun; settles before it do not count. */
	turnStarted: boolean;
	/** A main turn is running: between an `agent_start` and the terminal `agent_end` after it. */
	inTurn: boolean;
	/** Why the run is over, decided while a turn was still running: that turn's end finishes it, its last message counted. */
	ending?: RunEndReason;
	/** Nudges sent to a stalled goal in a row: a turn the goal started by itself resets the count. */
	nudges: number;
	/** The last thing that happened to the session was Storm's nudge: the turn that starts next is its doing. */
	nudged: boolean;
	/** The stall watchdog's pending timer. */
	stall?: unknown;
}

type Refusal = Extract<RunRequestResult, { ok: false }>;
const refuse = (reason: string): Refusal => ({ ok: false, reason });

const START = { vibeOff: "omp vibe 끄고 시작", free: "자유 실행으로 시작", cancel: "취소" } as const;

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
	clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface RunControllerDeps {
	pi: Pick<ExtensionAPI, "sendUserMessage">;
	ui(ctx: ExtensionContext): UiPort;
	loadState(ctx: ExtensionContext): Promise<ProjectState>;
	now(): number;
	/** Subagents whose latest turn was during the run, from the agent ledger. */
	agents?(runId: string): AgentEntry[];
	/** Every subagent this process has seen (any run): the janitor only cleans those omp has parked. */
	ledger?(): AgentEntry[];
	/** omp's agent dir: the janitor deletes omp records only below its `sessions/`. Absent → no omp record cleanup. */
	agentDir?: string;
	/** How long a live rewrite of the run record waits to batch changes; defaults to LIVE_FLUSH_MS. */
	flushMs?: number;
	/** The user's omp `loop.mode` setting; a loop run is refused while it is `reset`. */
	loopMode?(): Promise<string | undefined>;
	/** The goal stall watchdog's clock; real timers when absent. */
	timers?: RunTimers;
}

export class RunController {
	#pending: { runId: string; spec: RunSpec } | undefined;
	/** A start is between its checks and its handoff (it may be asking, compacting, or entering a mode). */
	#starting = false;
	#own: OwnRun | undefined;
	#flushTimer: ReturnType<typeof setTimeout> | undefined;
	/** The last live write; the final record waits for it so a late live write never lands on top. */
	#liveWrite: Promise<unknown> = Promise.resolve();

	constructor(private readonly deps: RunControllerDeps) {}

	/** Why no run can be queued or started now: one run per session, running, queued or starting. */
	refusal(): string | undefined {
		if (this.#own) return `이미 Storm 실행(${this.#own.record.runId})이 진행 중입니다.`;
		if (this.#pending) return `이미 예약된 Storm 실행(${this.#pending.runId})이 있습니다.`;
		if (this.#starting) return "이미 Storm 실행을 시작하는 중입니다.";
		return undefined;
	}

	/**
	 * From the storm tool: the run starts once the current turn settles. omp refuses a mode change from inside a
	 * tool call, so every tool-requested run waits for the terminal `agent_end`.
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
		const live = activeLedgerRun(own.repoId);
		const agents = this.deps.agents?.(own.record.runId) ?? [];
		return {
			...own.record,
			costUsd: live?.costUsd ?? own.record.costUsd,
			costByModel: { ...(live?.costByModel ?? own.record.costByModel) },
			spawns: [...(spawnsByRun.get(own.record.runId) ?? [])],
			...(agents.length ? { agents } : {}),
		};
	}

	/**
	 * Checks the approved team and the mode's preconditions, compacts a heavy main context, enters omp's goal or loop
	 * mode, records the run and sends the handoff. The session must be idle. It can take as long as a dialog or a
	 * compaction: callers inside an omp event handler use `launch`.
	 */
	async start(ctx: ExtensionContext, spec: RunSpec, runId = newRunId(this.deps.now())): Promise<RunRequestResult> {
		// A queued run is not in the way of its own start: `onAgentEnd` takes it off the queue first.
		const reason = this.refusal();
		if (reason !== undefined) return refuse(reason);
		this.#starting = true;
		try {
			return await this.#begin(ctx, spec, runId);
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

	async #begin(ctx: ExtensionContext, requested: RunSpec, runId: string): Promise<RunRequestResult> {
		const state = await this.deps.loadState(ctx);
		const gate = teamGate(state);
		if (!gate.ok) return refuse(gate.block.reason);
		const shadow = shadowBlock(state);
		if (shadow) return refuse(shadow.reason);
		const busy = refuse("이 프로젝트에서 다른 Storm 실행이 진행 중입니다.");
		if (activeLedgerRun(state.repo.repoId)) return busy;
		const ui = this.deps.ui(ctx);
		const ready = await this.#readyMode(ctx, ui, requested);
		if (!ready.ok) return ready;
		await this.#compactFirst(ctx, ui);
		// The dialog and the compaction awaited: another session's run may have started meanwhile.
		if (activeLedgerRun(state.repo.repoId)) return busy;
		// Nothing of the run exists yet: a mode omp refuses leaves nothing behind.
		const entered = await this.#enterMode(ctx, ready.spec, runId);
		if (!entered.ok) return entered;

		const { config, hash } = gate;
		const { task } = entered;
		const mode = ready.spec.mode;
		const record: RunRecord = {
			schema: "storm.run/v1",
			runId,
			configHash: hash,
			startedAt: iso(this.deps.now()),
			status: "running",
			task: task.slice(0, TASK_CHARS),
			costUsd: 0,
			costByModel: {},
			...(config.budget ? { budget: config.budget } : {}),
			spawns: [],
			...artifactsOf(ctx),
			process: processKey(),
			mode,
			turns: 0,
			...entered.fields,
		};
		const own: OwnRun = {
			record,
			root: state.repo.root,
			repoId: state.repo.repoId,
			config,
			store: state.store,
			turnStarted: false,
			inTurn: false,
			nudges: 0,
			nudged: false,
		};
		this.#own = own;
		try {
			startLedgerRun({
				runId,
				repoId: own.repoId,
				...(config.budget ? { budget: config.budget } : {}),
				onThreshold: (kind, run) => this.#threshold(ctx, kind, run),
			});
			spawnsByRun.set(runId, []);
			openRunReads(runId);
			await writeRun(own.root, record);
		} catch (error) {
			// omp's mode is on and this session directs, but nothing was handed off: undo both rather than leave a run nobody started.
			await this.#stop(own, "start-failed", ctx).catch(() => undefined);
			return refuse(`실행을 기록하지 못해 시작하지 않았습니다: ${errorText(error)}`);
		}
		liveWriters.set(runId, () => this.#scheduleFlush(own));
		ui.notify(`Storm 실행을 시작합니다(${runId}, ${MODE_LABEL[mode]}).`);
		this.deps.pi.sendUserMessage(buildHandoff({ runId, config, hash, task, mode })).catch((error: unknown) => {
			ui.notify(`실행 계약을 보내지 못했습니다: ${errorText(error)}`, "error");
			void this.#stop(own, "start-failed", ctx);
		});
		return { ok: true, runId };
	}

	/**
	 * What must hold before a mode is entered, settled while nothing has started. omp's vibe mode replaces the
	 * director's tools, so the team cannot run inside it. A goal or a loop needs omp's mode control, which only the
	 * TUI has: elsewhere the user may take a vibe run instead. A loop that resets the session each turn would leave
	 * the run behind.
	 */
	async #readyMode(ctx: ExtensionContext, ui: UiPort, spec: RunSpec): Promise<{ ok: true; spec: RunSpec } | Refusal> {
		const modes = ctx.sessionModes;
		if (modes?.getState().vibe.status === "active") {
			const choice = await ui.select("omp vibe 모드에서는 Storm 팀을 쓸 수 없습니다. vibe 모드를 끄고 시작할까요?", [START.vibeOff, START.cancel]);
			if (choice !== START.vibeOff) return refuse("omp vibe 모드가 켜져 있어 시작하지 않았습니다.");
			const left = await modes.set({ mode: "vibe", action: "exit" });
			if (!left.ok) return refuse(modeFailureText(left));
		}
		if (spec.mode === "vibe") return { ok: true, spec };
		if (!modes) {
			const unsupported = `이 환경에서는 omp ${MODE_LABEL[spec.mode]} 모드를 쓸 수 없습니다(터미널 UI에서만 됩니다).`;
			if ("resume" in spec) return refuse(unsupported);
			const choice = await ui.select(`${unsupported} 자유 실행으로 시작할까요?`, [START.free, START.cancel]);
			return choice === START.free ? { ok: true, spec: { mode: "vibe", task: spec.task } } : refuse(unsupported);
		}
		if (spec.mode === "loop" && (await this.deps.loopMode?.()) === "reset") {
			return refuse(
				"omp 설정 loop.mode 가 reset 이라 반복마다 새 세션이 시작되어 Storm 실행이 이어지지 않습니다. `omp config set loop.mode prompt` 로 바꾼 뒤 다시 시도하세요.",
			);
		}
		// omp's resume leaves an active goal as it is: a goal restored with the session can be put under a run too.
		if ("resume" in spec && modes.getState().goal.status === "inactive") {
			return refuse("이어갈 목표가 없습니다. /storm goal <목표> 로 시작하세요.");
		}
		return { ok: true, spec };
	}

	/** Enters omp's goal or loop mode for the run. Resolves the task (a resumed goal's objective) and what the record keeps of the mode. */
	async #enterMode(
		ctx: ExtensionContext,
		spec: RunSpec,
		runId: string,
	): Promise<{ ok: true; task: string; fields: Pick<RunRecord, "goal" | "loop"> } | Refusal> {
		if (spec.mode === "vibe") return { ok: true, task: spec.task, fields: {} };
		const modes = ctx.sessionModes;
		if (!modes) return refuse("이 환경에서는 omp 모드를 바꿀 수 없습니다.");
		const result = await modes.set(modeRequest(spec, runId));
		if (!result.ok) return refuse(modeFailureText(result));
		if (spec.mode === "loop") {
			const loop = { ...(spec.limit ? { limit: spec.limit } : {}), ...(spec.condition ? { condition: spec.condition } : {}) };
			return { ok: true, task: spec.task, fields: { loop } };
		}
		const resumed = "resume" in spec;
		const task = resumed ? (result.state.goal.objective ?? "") : spec.task;
		const tokenBudget = resumed ? result.state.goal.tokenBudget : spec.tokenBudget;
		const goal = { objective: task.slice(0, TASK_CHARS), ...(tokenBudget !== undefined ? { tokenBudget } : {}) };
		return { ok: true, task, fields: { goal } };
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
		own.turnStarted = true;
		own.inTurn = true;
		// A turn Storm did not nudge into being means the goal moves by itself again.
		if (!own.nudged) own.nudges = 0;
		own.nudged = false;
		this.#disarm(own);
	}

	/** True while this session runs Storm: the main session directs and does not change files itself. */
	directing(): boolean {
		return this.#own !== undefined;
	}

	/** This session's run id while it directs, without building the live record. */
	runId(): string | undefined {
		return this.#own?.record.runId;
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
		setLedgerPlan(own.record.runId, plan);
		own.record.plan = plan;
		this.#scheduleFlush(own);
		return { ok: true };
	}

	/**
	 * The main session's agent loop ended. When it settled (no automatic continuation, no background work that will
	 * resume it) a turn of the run is over, which ends a vibe run; and a queued run starts, detached from this handler,
	 * unless the user interrupted the turn that queued it.
	 */
	async onAgentEnd(
		event: { willContinue?: boolean; awaitingAsyncWork?: boolean; messages?: readonly unknown[] },
		ctx: ExtensionContext,
	): Promise<void> {
		if (event.willContinue || event.awaitingAsyncWork) return;
		const own = this.#own;
		if (own?.turnStarted) await this.#turnSettled(own, ctx);
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
	 * A turn of the run settled. A vibe run is over. omp continues a goal or a loop by itself, so those end here only
	 * when the end was already decided during the turn, or when omp's mode is no longer on; a goal that stays active
	 * is watched for a stall.
	 */
	async #turnSettled(own: OwnRun, ctx: ExtensionContext): Promise<void> {
		if (own.inTurn) {
			own.inTurn = false;
			own.record.turns = (own.record.turns ?? 0) + 1;
			this.#scheduleFlush(own);
		}
		const mode = own.record.mode;
		if (own.ending !== undefined) return this.#stop(own, own.ending, ctx);
		if (mode !== "goal" && mode !== "loop") return this.#stop(own, "settled", ctx);
		const state = ctx.sessionModes?.getState();
		const over = state && modeEnd(mode, state);
		if (over) await this.#stop(own, over, ctx);
		else if (mode === "goal") this.#arm(own, ctx);
	}

	/** omp reported the goal: its token accounting, and whether it is over. */
	async onGoalUpdated(goal: { status: string; tokensUsed?: number } | null, ctx: ExtensionContext): Promise<void> {
		const own = this.#own;
		if (!own || own.record.mode !== "goal") return;
		if (goal && own.record.goal && goal.tokensUsed !== undefined) {
			own.record.goal.tokensUsed = goal.tokensUsed;
			this.#scheduleFlush(own);
		}
		// A goal omp no longer has was dropped.
		const reason = goal ? goalEnd(goal.status) : "goal-dropped";
		if (reason) await this.#endSoon(own, reason, ctx);
	}

	/** An omp session mode changed: a goal that is no longer active or a loop that stopped ends the run. */
	async onModeChanged(state: SessionModeState, ctx: ExtensionContext): Promise<void> {
		const own = this.#own;
		const reason = own && modeEnd(own.record.mode, state);
		if (own && reason) await this.#endSoon(own, reason, ctx);
	}

	/** The run is over for `reason` (the first reason given stands): now when the session is between turns, else at the turn's end. */
	async #endSoon(own: OwnRun, reason: RunEndReason, ctx: ExtensionContext): Promise<void> {
		own.ending ??= reason;
		if (!own.inTurn) await this.#stop(own, own.ending, ctx);
	}

	/**
	 * Ends `own` for `reason` unless an earlier reason stands; a run that is no longer this session's (a late failure
	 * of an older run's handoff) is left alone. After the ends in `LEAVE_MODE` omp's mode is left first.
	 */
	async #stop(own: OwnRun, reason: RunEndReason, ctx: ExtensionContext): Promise<void> {
		if (this.#own !== own) return;
		own.ending ??= reason;
		if (LEAVE_MODE.includes(own.ending)) await this.#leaveMode(own, ctx);
		await this.finish(own.ending, ctx);
	}

	/**
	 * Takes omp out of the run's mode so it does not keep the session going without the run: a goal is paused (the
	 * user can resume it), a loop exits. omp may refuse (it is busy tearing a goal down, or compacting); the user is
	 * told, since the session may then move again by itself.
	 */
	async #leaveMode(own: OwnRun, ctx: ExtensionContext): Promise<void> {
		const modes = ctx.sessionModes;
		const mode = own.record.mode;
		if (!modes || (mode !== "goal" && mode !== "loop")) return;
		let failure: string | undefined;
		try {
			const state = modes.getState();
			let request: SessionModeRequest | undefined;
			if (mode === "goal" && state.goal.status === "active") request = { mode: "goal", action: "pause" };
			if (mode === "loop" && state.loop.status !== "inactive") request = { mode: "loop", action: "exit" };
			const result = request && (await modes.set(request));
			if (result && !result.ok) failure = modeFailureText(result);
		} catch (error) {
			failure = errorText(error);
		}
		if (failure === undefined) return;
		this.deps.ui(ctx).notify(`omp ${MODE_LABEL[mode]} 모드를 끝내지 못했습니다(${failure}). 세션이 계속 이어지면 직접 멈추세요.`, "warning");
	}

	#disarm(own: OwnRun): void {
		if (own.stall === undefined) return;
		(this.deps.timers ?? REAL_TIMERS).clear(own.stall);
		delete own.stall;
	}

	/** Watches a goal that should continue by itself: no new turn within `STALL_MS` is a stall. */
	#arm(own: OwnRun, ctx: ExtensionContext): void {
		this.#disarm(own);
		own.stall = (this.deps.timers ?? REAL_TIMERS).set(() => {
			delete own.stall;
			void this.#stalled(own, ctx);
		}, STALL_MS);
	}

	/**
	 * Whether omp is holding the goal's continuation on purpose: the session is busy (a turn, a compaction), a
	 * submission is queued, plan mode is on, or the user has a draft in the editor. None of that is a stall.
	 */
	#held(ctx: ExtensionContext): boolean {
		if (!ctx.isIdle() || ctx.hasPendingMessages()) return true;
		if (ctx.sessionModes?.getState().plan.status === "active") return true;
		return ctx.hasUI && ctx.ui.getEditorText().trim() !== "";
	}

	/**
	 * omp stops continuing a goal silently after a turn without tool activity. A visible nudge restarts it; after
	 * `MAX_NUDGES` in a row with no turn of the goal's own in between, the goal is paused and the run ends, so nothing
	 * waits on a session that will not move. While omp holds the continuation the watch goes on without counting.
	 */
	async #stalled(own: OwnRun, ctx: ExtensionContext): Promise<void> {
		if (this.#own !== own || own.inTurn || own.ending !== undefined) return;
		if (ctx.sessionModes?.getState().goal.status !== "active") return;
		if (this.#held(ctx)) return this.#arm(own, ctx);
		const ui = this.deps.ui(ctx);
		if (own.nudges < MAX_NUDGES) {
			own.nudges += 1;
			own.nudged = true;
			// Armed again first: a nudge that starts no turn must not be the last thing that happens.
			this.#arm(own, ctx);
			this.deps.pi.sendUserMessage(GOAL_NUDGE).catch((error: unknown) => {
				ui.notify(`목표를 이어가라는 메시지를 보내지 못했습니다: ${errorText(error)}`, "warning");
			});
			return;
		}
		ui.notify(`목표가 ${MAX_NUDGES}번 재촉한 뒤에도 진행되지 않아 일시 정지하고 Storm 실행을 끝냅니다. /storm goal 로 이어갈 수 있습니다.`, "warning");
		await this.#stop(own, "goal-stalled", ctx);
	}

	/** Ends this session's run (if any), writes its record and reports the summary. */
	async finish(reason: RunEndReason, ctx?: ExtensionContext): Promise<RunRecord | undefined> {
		const own = this.#own;
		if (!own) return undefined;
		this.#own = undefined;
		this.#disarm(own);
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
		await pruneRuns(own.root);
		if (cleaned.length) markAgentsCleaned(cleaned, this.deps.now());
		if (ctx) this.deps.ui(ctx).record("Storm 실행 결과", summarizeRun(record));
		return record;
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

	#scheduleFlush(own: OwnRun): void {
		if (this.#flushTimer) return;
		this.#flushTimer = setTimeout(() => {
			this.#flushTimer = undefined;
			const live = this.active();
			// A run that finished meanwhile has already written its final record.
			if (!live || this.#own !== own) return;
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
		// The aborted turn's end finishes the run, and leaves omp's goal or loop so nothing continues it.
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

const STATUS_LABEL: Record<RunStatus, string> = { running: "진행 중", done: "완료", "budget-exceeded": "예산 초과", stopped: "중단" };

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
	const end = run.endReason ? ` · ${END_LABEL[run.endReason]}` : "";
	// Records of 0.9 and earlier have no mode: nothing is shown for them.
	const mode = run.mode ? ` · ${modeText(run)}${run.turns !== undefined ? ` ${run.turns}턴` : ""}` : "";
	const lines = [
		`- 실행: ${run.runId} (${STATUS_LABEL[run.status]}${end})${mode} · 비용(정가 환산) ${formatUsd(run.costUsd)}${run.budget ? ` / 예산 ${formatUsd(run.budget.perRunUsd)}` : ""}${run.plan ? ` · ${planText(run.plan)}` : ""}`,
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
	if (run.goal?.tokensUsed) main.push(`목표 토큰 ${tokens(run.goal.tokensUsed)}`);
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
