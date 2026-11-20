/**
 * Storm run lifecycle for one main session: a run the storm tool queued (from a `/storm <request>`) becomes a
 * keyword handoff; the run ends when the session settles. Spawn decisions arrive from any session in
 * the process (children included), so they are collected per run in module scope.
 */
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { ProjectState } from "../state.ts";
import type { RunRequestResult } from "../tool/host.ts";
import type { AgentEntry, RunRecord, RunStatus, SpawnRecord, UiPort } from "../types.ts";
import { activeLedgerRun, endLedgerRun, type LedgerRun, startLedgerRun } from "./ledger.ts";
import { buildHandoff, newRunId, pickKeyword, pruneRuns, writeRun } from "./run.ts";

const spawnsByRun = new Map<string, SpawnRecord[]>();

/** Debounced writers of the runs owned by sessions in this process, keyed by run id. */
const liveWriters = new Map<string, () => void>();
/** How often an active run's record is rewritten at most, so other processes can follow it. */
const LIVE_FLUSH_MS = 2_000;

/** Asks the owning session to rewrite the run's record soon (spawns, spend, thresholds). */
export function touchRun(runId: string): void {
	liveWriters.get(runId)?.();
}

/** Called by the spawn hook of whichever session decided the spawn. */
export function noteRunSpawn(runId: string, record: SpawnRecord): void {
	const list = spawnsByRun.get(runId);
	if (list) list.push(record);
	else spawnsByRun.set(runId, [record]);
	touchRun(runId);
}

export function money(usd: number): string {
	return `$${usd >= 1 ? usd.toFixed(2) : usd.toFixed(4)}`;
}

/** A natural-language `/storm` request for the main LLM, which answers it through the storm tool. */
export function buildStormRequest(text: string): string {
	// The request sits in an XML section so a keyword the user typed cannot start a run by itself.
	return [
		"<storm-request>",
		text,
		"</storm-request>",
		"",
		"위는 /storm 요청입니다. storm 도구로 처리하세요. 상태·쿼터·모델 점검·서브에이전트는 조회 동작을, 설정 변경(우선순위·워커 수·모델 재선정·쿼터 대응·시험 사용·예산)은 해당 동작을 쓰고, 변경은 사용자가 승인 창에서 확정한다고 알리세요. 팀 다시 설정·되돌리기·초기화, 승인 대기 중인 설정·보류 제안의 승인은 도구로 할 수 없으니 /storm 을 입력하라고 안내하세요(승인할 것이 있으면 /storm 이 승인 화면을 띄우고, 나머지는 메뉴에 있습니다). 요청이 review·rollback 같은 예전 명령어 한 단어면 작업으로 실행하지 말고 /storm 을 안내하세요. 작업 요청이면 action \"run\"으로 실행을 예약하고 이 턴에서는 작업하지 말고 바로 응답을 끝내세요.",
	].join("\n");
}

const iso = (ms: number): string => new Date(ms).toISOString();

function unapprovedShadowPath(state: ProjectState): string | undefined {
	const approved = state.approval?.scope.shadowedAgents ?? [];
	return state.shadows.find(shadow => !approved.some(seen => seen.agent === shadow.agent && seen.sha256 === shadow.sha256))?.path;
}

interface OwnRun {
	record: RunRecord;
	root: string;
	repoId: string;
	/** The handoff turn has begun; the next settle ends the run. */
	turnStarted: boolean;
}

export interface RunControllerDeps {
	pi: Pick<ExtensionAPI, "sendUserMessage">;
	ui(ctx: ExtensionContext): UiPort;
	loadState(ctx: ExtensionContext): Promise<ProjectState>;
	/** Which magic keywords would attach their notice in this session. */
	usableKeywords(ctx: ExtensionContext): Promise<{ workflowz: boolean; orchestrate: boolean }>;
	now(): number;
	/** Subagents that started during the run, from the agent ledger. */
	agents?(runId: string): AgentEntry[];
	/** How long a live rewrite of the run record waits to batch changes; defaults to LIVE_FLUSH_MS. */
	flushMs?: number;
}

export class RunController {
	#pending: { runId: string; task: string } | undefined;
	#own: OwnRun | undefined;
	#flushTimer: ReturnType<typeof setTimeout> | undefined;
	/** The last live write; the final record waits for it so a late live write never lands on top. */
	#liveWrite: Promise<unknown> = Promise.resolve();

	constructor(private readonly deps: RunControllerDeps) {}

	/** From the storm tool: the run starts once the current turn settles. */
	request(task: string): RunRequestResult {
		if (this.#own) return { ok: false, reason: `이미 Storm 실행(${this.#own.record.runId})이 진행 중입니다.` };
		if (this.#pending) return { ok: false, reason: `이미 예약된 Storm 실행(${this.#pending.runId})이 있습니다.` };
		const runId = newRunId(this.deps.now());
		this.#pending = { runId, task };
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

	/** Checks the approved team, records the run and sends the handoff. The session must be idle. */
	async start(ctx: ExtensionContext, task: string, runId = newRunId(this.deps.now())): Promise<RunRequestResult> {
		if (this.#own) return { ok: false, reason: `이미 Storm 실행(${this.#own.record.runId})이 진행 중입니다.` };
		const state = await this.deps.loadState(ctx);
		const load = state.config;
		if (load.status === "missing") return { ok: false, reason: "Storm 설정이 없습니다. /storm 으로 팀을 설정하세요." };
		if (load.status === "invalid") return { ok: false, reason: `Storm 설정 오류: ${load.errors[0] ?? "알 수 없는 오류"}` };
		if (!state.approval || state.approval.configHash !== load.hash) {
			const short = load.hash.replace(/^jcs-sha256:/, "").slice(0, 12);
			return { ok: false, reason: `승인되지 않은 Storm 설정입니다(${short}). /storm 으로 승인하세요.` };
		}
		const shadow = unapprovedShadowPath(state);
		if (shadow) return { ok: false, reason: `승인되지 않은 역할 정의가 있습니다: ${shadow}. /storm 으로 확인하세요.` };
		if (activeLedgerRun(state.repo.repoId)) return { ok: false, reason: "이 프로젝트에서 다른 Storm 실행이 진행 중입니다." };

		const config = load.config;
		const keyword = pickKeyword(config, await this.deps.usableKeywords(ctx));
		const record: RunRecord = {
			schema: "storm.run/v1",
			runId,
			configHash: load.hash,
			approvalId: state.approval.approvalId,
			startedAt: iso(this.deps.now()),
			status: "running",
			contract: keyword ?? "none",
			task: task.slice(0, 200),
			costUsd: 0,
			costByModel: {},
			...(config.budget ? { budget: config.budget } : {}),
			spawns: [],
		};
		const own: OwnRun = { record, root: state.repo.root, repoId: state.repo.repoId, turnStarted: false };
		startLedgerRun({
			runId,
			repoId: own.repoId,
			configHash: load.hash,
			...(config.budget ? { budget: config.budget } : {}),
			onThreshold: (kind, run) => this.#threshold(ctx, own, kind, run),
		});
		this.#own = own;
		spawnsByRun.set(runId, []);
		await writeRun(own.root, record);
		liveWriters.set(runId, () => this.#scheduleFlush(own));
		const ui = this.deps.ui(ctx);
		if (!keyword) ui.notify("이 세션에서 workflowz·orchestrate 키워드를 쓸 수 없어 팀 계약만 보냅니다.", "warning");
		ui.notify(`Storm 실행을 시작합니다(${runId}).`);
		this.deps.pi.sendUserMessage(buildHandoff({ runId, config, hash: load.hash, task, keyword })).catch((error: unknown) => {
			ui.notify(`Storm 실행 메시지를 보내지 못했습니다: ${error instanceof Error ? error.message : String(error)}`, "error");
			void this.finish("stopped", ctx);
		});
		return { ok: true, runId };
	}

	onAgentStart(): void {
		if (this.#own) this.#own.turnStarted = true;
	}

	/** True while this session runs Storm: the main session directs and does not change files itself. */
	directing(): boolean {
		return this.#own !== undefined;
	}

	/** Spend of this (main) session while its run is active: what directing costs. */
	noteMainSpend(usd: number): void {
		const own = this.#own;
		if (!own) return;
		own.record.mainCostUsd = (own.record.mainCostUsd ?? 0) + usd;
		this.#scheduleFlush(own);
	}

	/** A file change the main session tried itself; director mode sent it back to delegation. */
	noteBlockedEdit(): void {
		const own = this.#own;
		if (!own) return;
		own.record.blockedEdits = (own.record.blockedEdits ?? 0) + 1;
		this.#scheduleFlush(own);
	}

	async onAgentEnd(event: { willContinue?: boolean; awaitingAsyncWork?: boolean }, ctx: ExtensionContext): Promise<void> {
		// Not settled yet: an automatic continuation or background work will resume the session.
		if (event.willContinue || event.awaitingAsyncWork) return;
		if (this.#own?.turnStarted) await this.finish("done", ctx);
		const pending = this.#pending;
		if (!pending) return;
		this.#pending = undefined;
		const result = await this.start(ctx, pending.task, pending.runId);
		if (!result.ok) this.deps.ui(ctx).notify(`Storm 실행을 시작하지 못했습니다: ${result.reason}`, "warning");
	}

	/** Ends this session's run (if any), writes its record and reports the summary. */
	async finish(status: RunStatus, ctx?: ExtensionContext): Promise<RunRecord | undefined> {
		const own = this.#own;
		if (!own) return undefined;
		this.#own = undefined;
		clearTimeout(this.#flushTimer);
		this.#flushTimer = undefined;
		liveWriters.delete(own.record.runId);
		const ledger = endLedgerRun(own.record.runId);
		const spawns = spawnsByRun.get(own.record.runId) ?? [];
		spawnsByRun.delete(own.record.runId);
		const agents = this.deps.agents?.(own.record.runId) ?? [];
		const record: RunRecord = {
			...own.record,
			endedAt: iso(this.deps.now()),
			status: ledger?.exceeded ? "budget-exceeded" : status,
			costUsd: ledger?.costUsd ?? own.record.costUsd,
			costByModel: { ...(ledger?.costByModel ?? own.record.costByModel) },
			spawns,
			...(agents.length ? { agents } : {}),
		};
		await this.#liveWrite;
		await writeRun(own.root, record);
		await pruneRuns(own.root);
		if (ctx) this.deps.ui(ctx).record("Storm 실행 결과", summarizeRun(record));
		return record;
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

	#threshold(ctx: ExtensionContext, own: OwnRun, kind: "warn" | "limit", run: LedgerRun): void {
		const ui = this.deps.ui(ctx);
		const at = iso(this.deps.now());
		const budget = run.budget;
		if (kind === "warn") {
			own.record.warnedAt = at;
			this.#scheduleFlush(own);
			ui.notify(`Storm 실행 비용이 경고선 ${money(budget?.warnAtUsd ?? 0)}에 닿았습니다(누계 ${money(run.costUsd)}).`, "warning");
			return;
		}
		own.record.exceededAt = at;
		this.#scheduleFlush(own);
		ui.notify(`Storm 실행 예산 ${money(budget?.perRunUsd ?? 0)}을 넘었습니다(누계 ${money(run.costUsd)}). 새 스폰을 막습니다.`, "warning");
		if (budget?.onExceed === "stop") ctx.abort();
	}
}

/** The run's record in the transcript: at most four lines, the one Storm output that stays there. */
export function summarizeRun(run: RunRecord): string {
	const counts = new Map<string, number>();
	for (const spawn of run.spawns) counts.set(spawn.outcome, (counts.get(spawn.outcome) ?? 0) + 1);
	const label: Record<SpawnRecord["outcome"], string> = {
		routed: "승인 모델",
		trial: "시험 사용",
		allowed: "그대로 허용",
		substituted: "대체 역할로 교체",
		blocked: "차단",
	};
	const blocked = run.spawns.find(spawn => spawn.outcome === "blocked");
	const spawnLine = run.spawns.length
		? [...counts].map(([outcome, n]) => `${label[outcome as SpawnRecord["outcome"]] ?? outcome} ${n}`).join(" · ")
		: "없음";
	const status: Record<RunStatus, string> = { running: "진행 중", done: "완료", "budget-exceeded": "예산 초과", stopped: "중단" };
	const lines = [
		`- 실행: ${run.runId} (${status[run.status]}) · 비용(정가 환산) ${money(run.costUsd)}${run.budget ? ` / 예산 ${money(run.budget.perRunUsd)}` : ""}`,
		`- 스폰: ${spawnLine}${blocked?.reason ? ` · 차단 사유: ${blocked.reason}` : ""}`,
	];
	const main: string[] = [];
	if (run.mainCostUsd !== undefined && run.costUsd > 0) {
		main.push(`비용 ${money(run.mainCostUsd)}(전체의 ${Math.round((run.mainCostUsd / run.costUsd) * 100)}%)`);
	}
	if (run.blockedEdits) main.push(`직접 수정 ${run.blockedEdits}회를 위임으로 돌림`);
	if (main.length) lines.push(`- 메인(감독): ${main.join(" · ")}`);
	const agents = run.agents ?? [];
	if (agents.length) {
		const followUps = agents.reduce((sum, agent) => sum + agent.followUps, 0);
		const reused = agents.filter(agent => agent.followUps > 0).length;
		lines.push(`- 서브에이전트: ${agents.length}개 · 재사용 ${reused}개(후속 지시 ${followUps}회)`);
	}
	return lines.join("\n");
}
