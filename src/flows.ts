/**
 * /storm flows: setup (detect → analyze → recommend → interview → approve → save), status, review, rollback, reset.
 * Nothing is written unless an interview step returned an explicit approval; reset deletes only after two explicit choices.
 */
import { readdir, rm, stat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { configHash, sha256Hex } from "./config/canonical.ts";
import { configPath, serializeConfig, writeConfig } from "./config/store.ts";
import { prepareAnalysis } from "./context.ts";
import { readQuota } from "./discovery/quota.ts";
import { buildEvidence } from "./evidence.ts";
import { readUsage, statsDbPath } from "./history/stats.ts";
import { renderStatus } from "./interview/render.ts";
import { runReview, runRollback } from "./interview/review.ts";
import { deriveScope, runSetupInterview } from "./interview/setup.ts";
import { newProposalId } from "./proposals/build.ts";
import { presentProposal } from "./proposals/present.ts";
import { createProposalStore } from "./proposals/store.ts";
import { adviseRows } from "./report/agents.ts";
import { renderModelCheck } from "./report/models.ts";
import { ROLES } from "./roles.ts";
import { activeLedgerRun } from "./runtime/ledger.ts";
import { lastRun, runsDir, stateDir } from "./runtime/run.ts";
import { readQuotaMarks } from "./runtime/state-files.ts";
import { trialViews } from "./runtime/views.ts";
import { entryEffort, formatModelEntry, parseModelEntry } from "./selector.ts";
import { loadProjectState, type ProjectEnv, type ProjectState } from "./state.ts";
import type {
	AgentEntry,
	EvidenceRecord,
	InterviewInput,
	LifecycleSettings,
	ModelCost,
	Priority,
	Proposal,
	RollbackOption,
	RunRecord,
	StormConfig,
	TrialView,
	UiPort,
} from "./types.ts";

export interface FlowEnv extends ProjectEnv {
	ompBin: string;
	ompVersion: string;
	/** omp host mode ("tui", "rpc", ...), recorded with approvals. */
	mode: string;
	registry: { getAll(kind?: string): unknown[]; getAvailable(kind?: string): unknown[] };
	activeTools: string[];
	now: () => number;
	/** The Storm run active in this session, for status. */
	activeRun?: () => RunRecord | undefined;
	/** Subagents under this session, for status. */
	agents?: () => AgentEntry[];
	/** omp's idle-park TTL and cache retention, for status. */
	lifecycleSettings?: () => Promise<LifecycleSettings>;
	modelCost?: (selector: string) => ModelCost | undefined;
}

const DEFAULTS: InterviewInput["defaults"] = { parallelism: 4, isolation: "shared", contract: "workflowz" };

function shortHash(hash: string): string {
	return hash.replace(/^jcs-sha256:/, "").slice(0, 12);
}

/** Writes the approval (and the evidence behind it) first, then the file, so the config never exists unapproved after a successful save. */
export async function approveAndSave(
	env: FlowEnv,
	state: ProjectState,
	config: StormConfig,
	scope: Parameters<ProjectState["store"]["approve"]>[0]["scope"],
	evidence?: EvidenceRecord,
): Promise<string> {
	const hash = configHash(config);
	await state.store.approve({
		configHash: hash,
		rawSha256: sha256Hex(serializeConfig(config)),
		config,
		scope,
		via: env.mode,
		ompVersion: env.ompVersion,
		supersedes: state.approval?.approvalId ?? null,
		...(evidence ? { evidence } : {}),
	});
	const written = await writeConfig(state.repo.root, config);
	if (written.hash !== hash) throw new Error(`저장한 설정의 해시가 승인한 해시와 다릅니다(${shortHash(written.hash)})`);
	return hash;
}

function proposalStore(state: ProjectState) {
	const hash = state.config.status === "ok" ? state.config.hash : null;
	return createProposalStore(state.repo.root, async () => hash);
}

export async function setupFlow(env: FlowEnv, ui: UiPort): Promise<void> {
	const state = await loadProjectState(env);
	const ctx = await prepareAnalysis(env, ui);
	const current =
		state.config.status === "ok"
			? { config: state.config.config, hash: state.config.hash, approved: state.approval !== undefined }
			: undefined;
	const priority: Priority = current?.config.priority ?? "balanced";
	const detectionWarnings: string[] = [];
	if (state.config.status === "invalid") detectionWarnings.push(`지금 설정 파일에 오류가 있어 새로 만듭니다: ${state.config.errors[0] ?? ""}`);
	const result = await runSetupInterview(ui, {
		detection: ctx.detection(env.activeTools, detectionWarnings),
		analysis: ctx.analysis,
		recommendations: ctx.recommend(priority),
		...(current ? { current } : {}),
		shadows: state.shadows,
		rerecommend: ctx.recommend,
		checkModel: ctx.checkModel,
		defaults: current
			? { parallelism: current.config.parallelism, isolation: current.config.isolation, contract: current.config.contract }
			: DEFAULTS,
		priority,
	});
	if (result.status !== "approved") {
		ui.notify("저장하지 않았습니다. 바뀐 것은 없습니다.");
		return;
	}
	const evidence = buildEvidence({
		source: "setup",
		priority: result.config.priority,
		dataAsOf: ctx.usage.dataAsOf,
		recommendations: ctx.recommend(result.config.priority),
		config: result.config,
		now: env.now(),
	});
	const hash = await approveAndSave(env, state, result.config, result.scope, evidence);
	ui.notify(`Storm 팀을 승인하고 저장했습니다(${shortHash(hash)}).`);
	await statusFlow(env, ui);
}

export async function statusFlow(env: FlowEnv, ui: UiPort): Promise<void> {
	const state = await loadProjectState(env);
	const now = env.now();
	const root = state.repo.root;
	const config = state.config.status === "ok" ? state.config.config : undefined;
	const [quota, quotaMarks, last, trials, pending, lifecycle] = await Promise.all([
		readQuota(env.exec, env.ompBin, now),
		readQuotaMarks(root, now),
		lastRun(root),
		config ? trialViews(root, config, now) : Promise.resolve([]),
		config ? proposalStore(state).list() : Promise.resolve([]),
		env.lifecycleSettings?.(),
	]);
	const usage = readUsage({ dbPath: statsDbPath(), windowDays: 1, now });
	const run = env.activeRun?.();
	const entries = env.agents?.() ?? [];
	const agents = entries.length
		? adviseRows(entries, { now, settings: lifecycle ?? {}, ...(env.modelCost ? { cost: env.modelCost } : {}) })
		: [];
	ui.report(
		"Storm 현황",
		renderStatus(
			{
				repo: state.repo,
				config: state.config,
				approval: state.approval,
				shadows: state.shadows,
				quota,
				dataAsOf: usage.dataAsOf,
				...(run ? { run } : {}),
				...(last ? { lastRun: last } : {}),
				...(trials.length ? { trials } : {}),
				...(quotaMarks.length ? { quotaMarks } : {}),
				...(pending.length ? { pending } : {}),
				...(agents.length ? { agents } : {}),
				...(lifecycle ? { lifecycle } : {}),
			},
			now,
		),
	);
	if (config && state.approval) await offerTrialDecisions(env, ui, state, config, trials);
}

/** Read-only model check without the LLM: newer, better or cheaper models than the team's current ones. */
export async function modelsFlow(env: FlowEnv, ui: UiPort): Promise<void> {
	const state = await loadProjectState(env);
	const ctx = await prepareAnalysis(env, ui);
	ui.report("Storm 모델 점검", renderModelCheck(ctx, state.config.status === "ok" ? state.config.config : undefined));
}

/** Ended trials: show is done by the status report; here the user decides to adopt the candidate or keep the current model. */
async function offerTrialDecisions(env: FlowEnv, ui: UiPort, state: ProjectState, config: StormConfig, trials: TrialView[]): Promise<void> {
	for (const view of trials) {
		if (view.phase !== "ended") continue;
		const { trial } = view;
		const role = config.roles[trial.role];
		if (!role) continue;
		const title = ROLES.find(spec => spec.id === trial.role)?.title ?? trial.role;
		const choice = await ui.select(`시험 사용이 끝났습니다: ${title} 역할의 ${trial.model}`, ["후보로 바꾸기", "지금 모델 유지", "나중에"]);
		if (choice !== "후보로 바꾸기" && choice !== "지금 모델 유지") return;
		const adopt = choice === "후보로 바꾸기";
		// The adopted model carries its own effort, so the role default and the other entries keep theirs.
		const candidate = parseModelEntry(trial.model).selector;
		const effort = trial.effort ?? entryEffort(role.models[0] ?? "", role.effort);
		const adopted = formatModelEntry({ selector: candidate, ...(effort ? { effort } : {}) });
		const next: StormConfig = {
			...config,
			roles: {
				...config.roles,
				...(adopt
					? { [trial.role]: { ...role, models: [adopted, ...role.models.filter(model => parseModelEntry(model).selector !== candidate)] } }
					: {}),
			},
		};
		const remaining = (config.trials ?? []).filter(other => other.id !== trial.id);
		if (remaining.length) next.trials = remaining;
		else delete next.trials;
		const proposal: Proposal = {
			schema: "storm.proposal/v1",
			id: newProposalId(env.now()),
			kind: adopt ? "reselect" : "trial",
			createdAt: new Date(env.now()).toISOString(),
			summary: adopt ? `${title} 역할을 ${trial.model}로 바꾸고 시험 사용 종료` : `${title} 역할 유지, 시험 사용 종료`,
			baseHash: state.config.status === "ok" ? state.config.hash : "",
			config: next,
		};
		await decideProposal(env, ui, state, config, proposal);
		return;
	}
}

/** Shows a proposal and applies it only on the exact approval label; a deferral is kept for /storm review. */
async function decideProposal(env: FlowEnv, ui: UiPort, state: ProjectState, current: StormConfig, proposal: Proposal): Promise<void> {
	const store = proposalStore(state);
	const decision = await presentProposal(ui, proposal, current);
	if (decision === "approved") {
		const hash = await approveAndSave(env, state, proposal.config, deriveScope(proposal.config, state.shadows), proposal.evidence);
		await store.remove(proposal.id);
		ui.notify(`승인했습니다(${shortHash(hash)}).`);
		return;
	}
	if (decision === "deferred") {
		await store.save(proposal);
		ui.notify("보류했습니다. /storm review 에서 승인할 수 있습니다.");
		return;
	}
	await store.remove(proposal.id);
	ui.notify("바꾸지 않았습니다.");
}

function unapprovedShadows(state: ProjectState): boolean {
	const approved = state.approval?.scope.shadowedAgents ?? [];
	return state.shadows.some(shadow => !approved.some(seen => seen.agent === shadow.agent && seen.sha256 === shadow.sha256));
}

export async function reviewFlow(env: FlowEnv, ui: UiPort): Promise<void> {
	const state = await loadProjectState(env);
	if (state.config.status === "missing") {
		ui.notify("Storm 설정이 없습니다. /storm 으로 팀을 설정하세요.");
		return;
	}
	if (state.config.status === "invalid") {
		ui.report("Storm 설정 오류", state.config.errors.map(error => `- ${error}`).join("\n"));
		ui.notify("설정 파일을 고치거나 /storm setup 으로 다시 만드세요.", "warning");
		return;
	}
	if (state.approval && !unapprovedShadows(state)) {
		const pending = await proposalStore(state).list();
		if (pending.length === 0) {
			ui.notify("이미 승인된 설정입니다.");
			return;
		}
		const options = pending.map(proposal => `${proposal.summary} (${proposal.id})`);
		const picked = await ui.select("보류 중인 변경 제안", [...options, "취소"]);
		const proposal = pending[options.indexOf(picked ?? "")];
		if (!proposal) {
			ui.notify("바꾸지 않았습니다.");
			return;
		}
		await decideProposal(env, ui, state, state.config.config, proposal);
		return;
	}
	const latest = (await state.store.list())[0];
	const previous = latest ? await state.store.snapshot(latest.configHash) : undefined;
	const { config, hash, rawSha256 } = state.config;
	const decision = await runReview(ui, { config, hash, ...(previous ? { previous } : {}), shadows: state.shadows });
	if (decision !== "approved") {
		ui.notify("승인하지 않았습니다. Storm 역할 스폰은 계속 막힙니다.");
		return;
	}
	await state.store.approve({
		configHash: hash,
		rawSha256,
		config,
		scope: deriveScope(config, state.shadows),
		via: env.mode,
		ompVersion: env.ompVersion,
		supersedes: latest?.approvalId ?? null,
	});
	ui.notify(`승인했습니다(${shortHash(hash)}).`);
}

export async function rollbackFlow(env: FlowEnv, ui: UiPort): Promise<void> {
	const state = await loadProjectState(env);
	const currentHash = state.config.status === "ok" ? state.config.hash : null;
	const options: RollbackOption[] = [];
	for (const record of await state.store.list()) {
		if (record.configHash === currentHash) continue;
		const config = await state.store.snapshot(record.configHash);
		if (config) options.push({ hash: record.configHash, approvedAt: record.approvedAt, config });
	}
	if (options.length === 0) {
		ui.notify("되돌릴 이전 승인 기록이 없습니다.");
		return;
	}
	const current = state.config.status === "ok" ? state.config.config : undefined;
	const result = await runRollback(ui, { options, ...(current ? { current } : {}) });
	if (result.status !== "approved") {
		ui.notify("되돌리지 않았습니다.");
		return;
	}
	const written = await writeConfig(state.repo.root, result.option.config);
	if (written.hash !== result.option.hash) throw new Error("되돌린 설정의 해시가 승인 기록과 다릅니다");
	await state.store.recordRollback(result.option.hash, currentHash);
	ui.notify(`${relative(state.repo.root, written.path)}를 ${shortHash(result.option.hash)}로 되돌렸습니다.`);
}

async function pathExists(file: string): Promise<boolean> {
	try {
		await stat(file);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

async function countJson(dir: string): Promise<number> {
	try {
		return (await readdir(dir)).filter(name => name.endsWith(".json")).length;
	} catch {
		return 0;
	}
}

/** Files under `dir` that git tracks; deleting them leaves a change in the work tree. */
async function trackedFiles(env: FlowEnv, root: string, dir: string): Promise<string[]> {
	const result = await env.exec("git", ["-C", root, "ls-files", "--", relative(root, dir)]).catch(() => undefined);
	return result?.code === 0 ? result.stdout.split("\n").filter(Boolean) : [];
}

/** Other worktrees of this repo; they share its approval records. */
async function otherWorktrees(env: FlowEnv, root: string): Promise<number> {
	const result = await env.exec("git", ["-C", root, "worktree", "list", "--porcelain"]).catch(() => undefined);
	if (result?.code !== 0) return 0;
	return Math.max(0, result.stdout.split("\n").filter(line => line.startsWith("worktree ")).length - 1);
}

/**
 * `/storm reset`: deletes the project's `.omp/storm/` and this repo's approval records in one go, after one
 * exact "초기화". Refuses while a run is active. Returns true when something was deleted.
 */
export async function resetFlow(env: FlowEnv, ui: UiPort): Promise<boolean> {
	const state = await loadProjectState(env);
	const running = env.activeRun?.() ?? activeLedgerRun(state.repo.repoId);
	if (running) {
		ui.notify(`Storm 실행(${running.runId})이 진행 중이라 초기화하지 않습니다. 실행이 끝난 뒤 다시 하세요.`, "warning");
		return false;
	}
	const root = state.repo.root;
	const local = dirname(configPath(root));
	const [hasLocal, hasApprovals] = await Promise.all([pathExists(local), pathExists(state.store.dir)]);
	if (!hasLocal && !hasApprovals) {
		ui.notify("초기화할 Storm 설정이나 기록이 없습니다.");
		return false;
	}
	const git = state.repo.kind === "git-common-dir";
	const [runs, proposals, tracked, worktrees, approvals, log, last] = await Promise.all([
		countJson(runsDir(root)),
		countJson(join(stateDir(root), "proposals")),
		hasLocal && git ? trackedFiles(env, root, local) : Promise.resolve([]),
		hasApprovals && git ? otherWorktrees(env, root) : Promise.resolve(0),
		state.store.list(),
		state.store.log(),
		lastRun(root),
	]);
	const c = state.config;
	const configLine =
		c.status === "ok"
			? `설정 ${shortHash(c.hash)}(${state.approval ? "승인됨" : "미승인"})`
			: c.status === "invalid"
				? "설정(오류)"
				: "설정 없음";
	const lines = ["### 지울 것"];
	if (hasLocal) {
		lines.push(`- \`${relative(root, local)}/\`: ${configLine}, 실행 기록 ${runs}개, 보류 제안 ${proposals}개, 시험 카운터·쿼터 표시`);
	}
	if (hasApprovals) lines.push(`- 승인 기록 \`${state.store.dir}\`: 유효한 승인 ${approvals.length}건, 기록 ${log.length}줄, 스냅숏·근거`);
	if (tracked.length) {
		lines.push(`- 주의: git에 커밋된 파일 ${tracked.length}개(${tracked.join(", ")})는 지우면 변경 사항으로 남습니다. 커밋은 직접 하세요.`);
	}
	if (worktrees > 0) lines.push(`- 주의: 이 저장소의 다른 worktree ${worktrees}개도 이 승인 기록을 씁니다. 그쪽 설정은 다시 승인해야 합니다.`);
	if (last?.status === "running") {
		lines.push(`- 주의: 마지막 실행(${last.runId})이 진행 중으로 남아 있습니다. 다른 터미널에서 실행 중이면 끝난 뒤 초기화하세요.`);
	}
	lines.push("", "### 그대로 두는 것", "- `.omp/`의 다른 파일, 여러 프로젝트가 함께 쓰는 사용 기록 보관본, omp 설정");
	ui.report("Storm 초기화", lines.join("\n"));
	if ((await ui.select("Storm 설정과 기록을 모두 지울까요? 되돌릴 수 없습니다.", ["초기화", "취소"])) !== "초기화") {
		ui.notify("초기화하지 않았습니다.");
		return false;
	}
	await rm(local, { recursive: true, force: true });
	const removed = hasApprovals ? await state.store.clear() : 0;
	ui.notify(
		[
			`Storm 설정과 기록을 지웠습니다(승인 ${removed}건 포함). 다시 쓰려면 /storm setup 으로 팀을 설정하세요.`,
			tracked.length ? "git에서 지워진 파일은 직접 커밋하세요." : "",
		]
			.filter(Boolean)
			.join(" "),
	);
	return true;
}
