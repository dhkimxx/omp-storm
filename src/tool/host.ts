/**
 * What the `storm` tool needs from the extension. The extension wires real implementations and tests pass fakes. A
 * plan past the approved bounds is refused: the tool never reads the UI, prepares analysis, or writes config or
 * approvals.
 */
import type { CloseoutDraft } from "../runtime/closeout.ts";
import type { ProjectState } from "../state.ts";
import type { AgentEntry, RunPlan, RunSpec } from "../types.ts";
import type { PlanView } from "./plan-view.ts";

/** What a continued run carried over from the run it continues: counts of results, and the lanes still to do. */
export interface ContinuedRun {
	/** Which of R12's two continuations happened: the old plan and rows carried, or a handoff with nothing re-proved. */
	mode: "carry" | "handoff";
	allExcluded?: true;
	from: string;
	/** Why the continued run stopped, in the words `/storm status` uses ("이유 기록 없음" for a record that names none). */
	ended: string;
	/** Accepted results proven again against the current bytes and carried. */
	kept: number;
	/** Results that are open again (never proven again, or never accepted). */
	reopened: number;
	/** Results the earlier run left blocked. */
	blocked: number;
	/** Lanes with work left, in plan order (bounded). */
	open: readonly string[];
}

export type RunRequestResult = { ok: true; runId: string; continued?: ContinuedRun } | { ok: false; reason: string };


/** A candidate id as persisted: `c1_` plus 64 lowercase hex, never model text or a path. */
export const INTEGRATION_CANDIDATE_ID_RE = /^c1_[0-9a-f]{64}$/u;
/** One `integrate` call accepts 1-128 distinct exact ids. */
export const INTEGRATION_SELECTION_MAX = 128;
/** The encoded id list stays at or below 16 KiB. */
export const INTEGRATION_SELECTION_MAX_BYTES = 16 * 1024;
/** A read-only run id is a bounded host token, not a path. */
export const INTEGRATION_RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/u;

/**
 * The exact id list a write request may carry, or the refusal for the whole call. Validation happens
 * before any writer, fence lookup or queue read: one malformed/duplicate id refuses every id in the
 * request. Known non-ready ids are per-item skips inside the controller instead.
 */
export function integrationIdListProblem(ids: readonly string[]): string | undefined {
	if (ids.length < 1 || ids.length > INTEGRATION_SELECTION_MAX) {
		return `통합할 후보 id를 ${INTEGRATION_SELECTION_MAX}개 이하로 1개 이상 정확히 고르세요.`;
	}
	const unique = new Set<string>();
	for (const id of ids) {
		if (!INTEGRATION_CANDIDATE_ID_RE.test(id)) return "후보 id 형식이 올바르지 않습니다. c1_ 뒤에 소문자 16진수 64자여야 합니다.";
		if (unique.has(id)) return "같은 후보 id를 두 번 넣었습니다. 각 id를 한 번씩만 넣으세요.";
		unique.add(id);
	}
	if (Buffer.byteLength(JSON.stringify(ids), "utf8") > INTEGRATION_SELECTION_MAX_BYTES) {
		return "후보 id 목록이 16 KiB를 넘습니다. 더 적은 id를 골라 나눠 요청하세요.";
	}
	return undefined;
}

/** A bounded reply from the integration runtime; the tool maps it to its own outcome type. */
export interface IntegrationToolReply {
	readonly outcome: "ok" | "rejected";
	readonly text: string;
}

/**
 * The bounded `candidates`/`integrate` surface. The extension supplies it from the bound A/B/C/D ports;
 * a host without them refuses both actions rather than reading a model-supplied run or authority.
 */
export interface IntegrationToolHost {
	candidates(
		input: { readonly candidateId?: string; readonly candidateRunId?: string; readonly candidateAfter?: string },
		signal?: AbortSignal,
	): Promise<IntegrationToolReply>;
	integrate(candidateIds: readonly string[], signal?: AbortSignal): Promise<IntegrationToolReply>;
}

/**
 * The personal automatic-delegation policy of the native main session that owns a tool call. Consent is read from
 * that session's own store, never derived from team approval: a blocked state keeps the main session's direct tools
 * blocked instead of silently falling back to them.
 */
export interface AutoDelegationState {
	/** The user's explicit opt-in for this native session. */
	enabled: boolean;
	/** Why an automatic run cannot start now (team config/approval or an omp mode); absent when it can. */
	blocked?: string;
	/** The ordinary user prompt this turn started from: the task a first plan opens the run for. Absent on a revive, an empty prompt, or after the turn settled. */
	task?: string;
	/** With `task`: when the user's message that began this turn arrived (ms since the epoch), as the host recorded it. */
	turnStartedAt?: number;
}

/** The tool's host: project reads and the run operations only. Config/approval writes stay with `/storm` flows. */
export interface StormToolHost {
	/** Reads this session's project state fresh; the extension guards that it is still the owning conversation. */
	loadState(): Promise<ProjectState>;
	now(): number;
	/** The status report `/storm status` shows, as markdown; `quota` adds omp's provider quota (about a second). */
	statusText(opts: { quota: boolean }): Promise<string>;
	/**
	 * The run this session directs: its plan in force and its result rows, for the `status` action to hand the director
	 * its own plan back. Absent, or undefined outside a run or for a session that does not own one, the status text
	 * stands alone.
	 */
	planView?(): PlanView | undefined;
	/**
	 * Whether omp task isolation is on, when the host can prove it. The extension's host reads the live omp settings;
	 * absent or undefined means unknown, which the plan reply never reports as off.
	 */
	isolationEnabled?(): boolean | undefined;
	/** The main session's automatic-delegation policy; absent hosts behave as if it were never opted in. */
	auto?(): AutoDelegationState;
	/** Final authorization of an automatic start, after tool reply construction. */
	checkStartReply?(): string | Promise<string> | undefined;
	/** Candidate inspection and explicit parent writes; absent when no integration runtime is bound. */
	integration?: IntegrationToolHost;
	runtime: {
		/** Queues a run that starts once the current agent turn settles. */
		requestRun(spec: RunSpec): RunRequestResult;
		/**
		 * Why this plan would rewrite the evidence identity of a lane already in force, if it would; absent outside a
		 * run or when the runtime cannot answer. The tool checks it before the bounds check, and setRunPlan again at
		 * commit, so a refused replan leaves the plan in force untouched.
		 */
		replanConflict?(plan: RunPlan): string | undefined;
		/**
		 * Puts a validated plan in force for the active run (replacing any earlier one); fails when no run is active.
		 * A write-capable plan upgrades the target lease, so the runtime may answer asynchronously.
		 */
		setRunPlan(plan: RunPlan): { ok: true } | { ok: false; reason: string } | Promise<{ ok: true } | { ok: false; reason: string }>;
		/** Executes already planned named jobs, not arbitrary commands. */
		executeJobs?(lanes: readonly string[], signal?: AbortSignal): Promise<{ ok: true; text: string } | { ok: false; reason: string }>;
		/**
		 * Holds the director's closeout for this session's current run until it settles; a later brief replaces it.
		 * Optional for hosts without the closeout runtime, which the tool then refuses.
		 */
		submitCloseout?(draft: CloseoutDraft): { ok: true } | { ok: false; reason: string };
		/** Whether this session itself directs a run now; another session's run in the same repo is not this one. */
		runActive?(): boolean;
		/**
		 * Automatic delegation only: opens a run for this turn's user request with `plan` already in force. It sends
		 * no handoff; the in-flight turn is the run's first round. `turnStartedAt` is when that request's message
		 * arrived, for R9's same-turn rule; a host that cannot give it opens nothing.
		 */
		startWithPlan?(spec: RunSpec, plan: RunPlan, validatedHash?: string, turnStartedAt?: number): Promise<RunRequestResult>;
		/**
		 * Automatic delegation only: opens the run the `/storm` menu would resume (the same candidate and checks) inside
		 * this turn, with its checkpoint restored and its plan in force. Nothing is started when there is no candidate or
		 * the old plan no longer fits the approved team, or the run stopped at or after `turnStartedAt`: the user has to
		 * have spoken after it stopped. `said` is the user's message of this turn.
		 */
		continueRun?(said: string | undefined, turnStartedAt: number): Promise<RunRequestResult>;
		/** Subagents spawned under this session (any depth), from the agent ledger. */
		agents(): AgentEntry[];
	};
}
