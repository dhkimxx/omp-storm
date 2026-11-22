/**
 * /storm flows: setup (the recommended team or the role-by-role interview), status,
 * approval of a config changed by hand, rollback, trial decisions, reset. None of them calls a model or sends a
 * message. A config is approved only by the exact "승인" in Storm's dialog; reset deletes only after the single
 * exact "초기화" choice.
 */
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { configHash, shortHash } from "./config/canonical.ts";
import { teamPriority, validateConfig } from "./config/schema.ts";
import { configPath, writeConfig } from "./config/store.ts";
import { prepareAnalysis } from "./context.ts";
import { readQuota } from "./discovery/quota.ts";
import { readUsage, statsDbPath } from "./history/stats.ts";
import { renderStatus, renderStatusBrief, renderTrial, resumeRunLine, visible } from "./view/render.ts";
import { runRollback } from "./view/review.ts";
import { recommendedConfig } from "./view/setup.ts";
import { buildTrialEnd, modelWarnings } from "./proposals/build.ts";
import { type DecideHost, type Decision, decideProposal, movedSince } from "./proposals/decide.ts";
import { APPROVE, CANCEL, renderApproval } from "./proposals/present.ts";
import { agentRows, renderAgentRows } from "./report/agents.ts";
import { renderModelCheck } from "./report/models.ts";
import { ompSettingsAdvice } from "./report/omp-settings.ts";
import { roleTitle } from "./roles.ts";
import { activeLedgerRun } from "./runtime/ledger.ts";
import { lastRun, runsDir } from "./runtime/run.ts";
import { resumeCandidate, resumePointerFile, resumeSpec } from "./runtime/resume.ts";
import { formatStorage, readStorage } from "./runtime/janitor.ts";
import { readRunIndex, runIndexFile } from "./runtime/run-index.ts";
import { readQuotaMarks } from "./runtime/state-files.ts";
import { trialViews } from "./runtime/views.ts";
import { BROWSE, commonSettingsForm, effortForm, FIELD, type FormRetry, interviewRoles, pickedEntry, readRoleChoices, recommendationNotes, type RoleAnswers, roleForm, type SetupFormInput, setupConfig, subagentShares } from "./setup/form.ts";
import { isApproved, loadProjectState, type ProjectEnv, type ProjectState } from "./state.ts";
import type { RunRequestResult } from "./tool/host.ts";
import type { AgentEntry, AnalysisContext, ApprovalScope, ConfigLoad, ExplicitSettings, FormData, ModelInfo, RoleId, RollbackOption, RunRecord, RunSpec, StatusView, StormConfig, TrialView, UiPort } from "./types.ts";

export interface FlowEnv extends ProjectEnv {
	ompBin: string;
	/** Stats DB to read; omp's own when absent. */
	statsDb?: string;
	registry: { getAll(kind?: string): unknown[]; getAvailable(kind?: string): unknown[] };
	activeTools: string[];
	now: () => number;
	/** The Storm run active in this session, for status. */
	activeRun?: () => RunRecord | undefined;
	/** Subagents under this session, for status. */
	agents?: () => AgentEntry[];
	/** omp settings as configured (concurrency, fallbacks, isolation); fields are undefined when unreadable. */
	ompSettings?: () => Promise<ExplicitSettings>;
	/** A newer Storm installed on disk than the one this process runs. */
	newerVersion?: () => string | undefined;
	/** Starts a run in this session; absent where the caller cannot start one. */
	startRun?: (spec: RunSpec) => Promise<RunRequestResult>;
}

type OkState = ProjectState & { config: Extract<ConfigLoad, { status: "ok" }> };

/** Writes the approval first, then the file, so the config never exists unapproved after a successful save. */
export async function approveAndSave(state: ProjectState, config: StormConfig, scope: ApprovalScope): Promise<string> {
	const hash = configHash(config);
	await state.store.approve({ configHash: hash, config, scope });
	await writeConfig(state.repo.root, config);
	return hash;
}

function decideHost(env: FlowEnv, ui: UiPort): DecideHost {
	return { ui, loadState: () => loadProjectState(env), approveAndSave };
}

/** Said when the config file or the shadowing definitions changed while a dialog was open: the newer file is never overwritten. */
const MOVED = "창이 열려 있는 사이 팀 설정이나 가림 정의가 바뀌어 저장하지 않았습니다. /storm 으로 다시 확인하세요.";

const PICK_BY_ROLE = "역할별로 고르기";
/** Number of invalid submissions allowed per page; cancelling the native picker is not a validation error. */
const FORM_TRIES = 5;

function notifySetup(ui: UiPort, decision: Exclude<Decision, { outcome: "extra" }>): void {
	if (decision.outcome === "approved") ui.notify(`팀 설정을 승인하고 저장했습니다(${shortHash(decision.hash)}).`);
	else if (decision.outcome === "rejected") ui.notify(decision.reason, "warning");
	else if (decision.outcome === "unchanged") ui.notify("지금 승인된 팀과 같아 바꾸지 않았습니다.");
	else ui.notify("팀을 설정하지 않았습니다. 바뀐 것이 없습니다.");
}

const INVALID_FORM = "폼의 값이 계속 올바르지 않아 팀을 설정하지 않았습니다. 바뀐 것이 없습니다.";

/** The role form, then an effort page per chosen model, repeated before common settings and approval. */
async function pickByRole(
	env: FlowEnv,
	ui: UiPort,
	form: NonNullable<UiPort["form"]>,
	state: ProjectState,
	ctx: AnalysisContext,
	input: SetupFormInput,
): Promise<void> {
	const pickModel = ui.pickModel?.bind(ui);
	const browse = pickModel !== undefined;
	const roles = interviewRoles(input, browse);
	const selected: RoleAnswers = {};
	const cancelled = (): void => notifySetup(ui, { outcome: "cancelled" });
	const chooseEffort = async (id: RoleId, slot: "주 모델" | "폴백", selector: string, model?: ModelInfo) => {
		const page = effortForm(input, id, slot, selector, model);
		let effort: FormData[string] | undefined;
		if (page) {
			const answers = await form(page);
			if (!answers) return undefined;
			effort = answers[FIELD.effort];
		}
		return pickedEntry(input, id, selector, effort, model);
	};
	for (const [index, id] of roles.entries()) {
		const title = roleTitle(id);
		let retry: FormRetry | undefined;
		let invalid = 0;
		while (true) {
			const answers = await form(roleForm(input, id, browse, index + 1, roles.length, retry));
			if (!answers) return cancelled();
			const choices = readRoleChoices(input, id, browse, answers);
			if ("errors" in choices) {
				if (++invalid >= FORM_TRIES) return ui.notify(INVALID_FORM, "warning");
				retry = { answers, errors: choices.errors };
				continue;
			}
			if ("disabled" in choices) {
				selected[id] = choices;
				break;
			}
			retry = { answers, errors: [] };
			const primaryModel = choices.primary === BROWSE ? await pickModel?.(`${title} · 주 모델`) : undefined;
			if (choices.primary === BROWSE && !primaryModel) continue;
			const primary = await chooseEffort(id, "주 모델", primaryModel?.selector ?? choices.primary, primaryModel);
			if (!primary) return cancelled();
			let fallback;
			if (choices.fallback !== undefined) {
				const fallbackModel = choices.fallback === BROWSE ? await pickModel?.(`${title} · 폴백`) : undefined;
				if (choices.fallback === BROWSE && !fallbackModel) continue;
				const selector = fallbackModel?.selector ?? choices.fallback;
				if (selector !== primary.selector) {
					fallback = await chooseEffort(id, "폴백", selector, fallbackModel);
					if (!fallback) return cancelled();
				}
			}
			selected[id] = { primary, ...(fallback ? { fallback } : {}), workers: choices.workers };
			break;
		}
	}
	let retry: FormRetry | undefined;
	for (let attempt = 0; attempt < FORM_TRIES; attempt++) {
		const answers = await form(commonSettingsForm(input, retry));
		if (!answers) return cancelled();
		const built = setupConfig(input, selected, answers);
		if ("errors" in built) {
			retry = { answers, errors: built.errors };
			continue;
		}
		const decision = await decideProposal(decideHost(env, ui), state, { kind: "setup", summary: "역할별로 고른 팀", config: built.config }, {
			warnings: [...ctx.detection(env.activeTools).warnings, ...ctx.analysis.warnings, ...built.warnings, ...modelWarnings(built.config, ctx)],
		});
		// No extra option was offered.
		if (decision.outcome !== "extra") notifySetup(ui, decision);
		return;
	}
	ui.notify(INVALID_FORM, "warning");
}

/**
 * Setup and re-setup, without the model: Storm computes the recommended team (what the user chose before carries
 * over) and shows it in the approval dialog. "승인" saves it; where the host draws forms, "역할별로 고르기" opens the
 * interview instead. Nothing reaches the main session.
 */
export async function setupFlow(env: FlowEnv, ui: UiPort): Promise<void> {
	const state = await loadProjectState(env);
	const ctx = await prepareAnalysis(env, ui);
	const current = state.config.status === "ok" ? state.config.config : undefined;
	const priority = current ? teamPriority(current) : "balanced";
	const recs = ctx.recommend(priority);
	const proposed = recommendedConfig(recs, priority, current);
	const form = ui.form?.bind(ui);
	const input: SetupFormInput = {
		recs,
		proposed,
		...(current ? { current } : {}),
		models: ctx.available,
		usage: subagentShares(ctx.analysis),
	};
	const checked = validateConfig(proposed);
	if (!checked.config) {
		if (form && ui.pickModel && ctx.available.some((model) => model.available && model.supportsTools)) {
			const choice = await ui.select("Storm 추천 팀을 만들 수 없습니다", [PICK_BY_ROLE, CANCEL], {
				title: "Storm 팀 제안",
				markdown: checked.errors.map((error) => `- ${error}`).join("\n"),
			});
			if (choice === PICK_BY_ROLE) await pickByRole(env, ui, form, state, ctx, input);
		} else {
			ui.notify(`지금 쓸 수 있는 모델로는 팀을 추천할 수 없습니다(${checked.errors.join("; ")}). omp에서 Provider에 로그인한 뒤 다시 /storm 을 실행하세요.`, "warning");
		}
		return;
	}
	// What "승인" switches on beyond the models comes first: a small terminal cuts the panel from the end.
	const cleanupNotice =
		proposed.cleanup === true && current?.cleanup !== true
			? `「실행이 끝나면 정리」가 켜집니다: 실행이 끝날 때마다 최근 3개를 뺀 Storm 실행의 끝난 서브에이전트 omp 기록을 지웁니다. 끄려면 ${form ? `「${PICK_BY_ROLE}」에서` : "승인한 뒤 `/storm <요청>` 으로"} 끄세요.`
			: "";
	const context = [
		cleanupNotice,
		state.config.status === "invalid" ? "지금 팀 설정 파일에 오류가 있어 새로 만듭니다." : "",
		form ? "" : "이 환경에서는 역할별로 고르는 폼을 그릴 수 없습니다. 승인한 뒤 `/storm <요청>` 으로 바꾸세요.",
	]
		.filter(Boolean)
		.join("\n\n");
	const notes = recommendationNotes(recs, proposed);
	const decision = await decideProposal(decideHost(env, ui), state, { kind: "setup", summary: current ? "Storm 추천 팀으로 다시 설정" : "Storm 추천 팀", config: proposed }, {
		warnings: [...ctx.detection(env.activeTools).warnings, ...ctx.analysis.warnings, ...modelWarnings(proposed, ctx)],
		context,
		notes,
		...(form ? { extraOptions: [PICK_BY_ROLE] } : {}),
	});
	// "역할별로 고르기" is offered only with a form.
	if (!form) return notifySetup(ui, decision.outcome === "extra" ? { outcome: "cancelled" } : decision);
	if (decision.outcome === "unchanged") {
		// The recommendation is the approved team, so there is nothing to approve; picking role by role is still open.
		const choice = await ui.select("Storm 추천 팀이 지금 승인된 팀과 같습니다", [PICK_BY_ROLE, MENU.close], { title: "Storm 팀 제안", markdown: notes });
		if (choice !== PICK_BY_ROLE) return;
	} else if (decision.outcome !== "extra") return notifySetup(ui, decision);
	await pickByRole(env, ui, form, state, ctx, input);
}

/**
 * What the status shows. `user`: also what only the user's views need: omp settings advice and a newer installed
 * version (their fixes are commands for the user to run) and the storage line. Quota takes a CLI call, so only the
 * full report reads it. `trials` reuses views already computed.
 */
async function statusView(env: FlowEnv, state: ProjectState, opts: { quota: boolean; user: boolean; trials?: TrialView[] }): Promise<StatusView> {
	const now = env.now();
	const root = state.repo.root;
	const config = state.config.status === "ok" ? state.config.config : undefined;
	const [quota, quotaMarks, last, trials, settings, storage] = await Promise.all([
		opts.quota ? readQuota(env.exec, env.ompBin) : undefined,
		readQuotaMarks(root, now),
		lastRun(root),
		opts.trials ?? (config ? trialViews(env, root, config, now) : []),
		opts.user ? env.ompSettings?.() : undefined,
		opts.user ? readStorage(root, state.store.dir, join(env.agentDir, "sessions")) : undefined,
	]);
	const usage = readUsage({ dbPath: env.statsDb ?? statsDbPath(), windowDays: 1, now });
	const run = env.activeRun?.();
	const agents = env.agents?.() ?? [];
	const ompAdvice = config && settings ? ompSettingsAdvice(config, settings) : [];
	const newerVersion = opts.user ? env.newerVersion?.() : undefined;
	return {
		config: state.config,
		approval: state.approval,
		// The status never says where the project is.
		shadows: state.shadows.map(shadow => (shadow.scope === "project" ? { ...shadow, path: relative(root, shadow.path) } : shadow)),
		...(usage.status === "ok" ? { dataAsOf: usage.dataAsOf } : {}),
		...(storage ? { storage: formatStorage(storage, config?.cleanup === true) } : {}),
		...(quota ? { quota } : {}),
		...(run ? { run } : {}),
		...(last ? { lastRun: last } : {}),
		...(trials.length ? { trials } : {}),
		...(quotaMarks.length ? { quotaMarks } : {}),
		...(agents.length ? { agents } : {}),
		...(ompAdvice.length ? { ompAdvice } : {}),
		...(newerVersion ? { newerVersion } : {}),
	};
}

/**
 * The status as text. `quota: true` is the user's full report (`/storm status`): every section, quota included, with
 * the commands that fix what it points out. `quota: false` is the storm tool's: the same facts for the model, with no
 * extra CLI call, no advice to act on and no file paths.
 */
export async function statusText(env: FlowEnv, opts: { quota: boolean }): Promise<string> {
	const state = await loadProjectState(env);
	return renderStatus(await statusView(env, state, { quota: opts.quota, user: opts.quota }), env.now(), opts.quota ? "user" : "model");
}

/** `/storm status`: the whole status to read and close. It never asks anything. */
export async function statusFlow(env: FlowEnv, ui: UiPort): Promise<void> {
	await ui.report("Storm 현황", await statusText(env, { quota: true }));
}

/** The subagents of this session with their context and follow-up state. */
export async function agentsFlow(env: FlowEnv, ui: UiPort): Promise<void> {
	const state = await loadProjectState(env);
	const config = state.config.status === "ok" ? state.config.config : undefined;
	await ui.report("서브에이전트", renderAgentRows(agentRows(env.agents?.() ?? [], config), env.now()));
}

/** Read-only model check without the LLM: newer or better-ranked models than the team's current ones. */
export async function modelsFlow(env: FlowEnv, ui: UiPort): Promise<void> {
	const state = await loadProjectState(env);
	const ctx = await prepareAnalysis(env, ui);
	await ui.report("Storm 모델 점검", renderModelCheck(ctx, state.config.status === "ok" ? state.config.config : undefined));
}

const TRIAL = { adopt: "후보로 교체", keep: "지금 모델 유지", later: "나중에" } as const;

/**
 * Ended trials, one dialog each with the measured comparison in view. Keeping the current model only removes the
 * trial, so it saves at once; adopting the candidate puts a new primary model in the team and goes through the
 * approval dialog. Returns true when the config changed.
 */
async function offerTrialDecisions(env: FlowEnv, ui: UiPort, state: OkState, trials: readonly TrialView[]): Promise<boolean> {
	const config = state.config.config;
	for (const view of trials) {
		if (view.phase !== "ended" || !config.roles[view.trial.role]) continue;
		const { trial } = view;
		const choice = await ui.select(`시험 사용이 끝났습니다: ${roleTitle(trial.role)} 역할 · ${trial.model}`, [TRIAL.adopt, TRIAL.keep, TRIAL.later], {
			title: "시험 사용 결과",
			consent: [TRIAL.adopt, TRIAL.keep],
			markdown: renderTrial(view),
		});
		if (choice !== TRIAL.adopt && choice !== TRIAL.keep) continue;
		const built = buildTrialEnd(config, trial, choice === TRIAL.adopt);
		if ("error" in built) continue;
		if (choice === TRIAL.keep) {
			if (movedSince(state, await loadProjectState(env))) {
				ui.notify(MOVED, "warning");
				return false;
			}
			// No new model enters the team and the shadows are the approved ones, so there is nothing more to show.
			const hash = await approveAndSave(state, built.config, { shadowedAgents: state.shadows });
			ui.notify(`${built.summary}. 저장했습니다(${shortHash(hash)}).`);
			return true;
		}
		const ctx = await prepareAnalysis(env, ui);
		const decision = await decideProposal(decideHost(env, ui), state, { kind: "reselect", summary: built.summary, config: built.config }, {
			warnings: modelWarnings(built.config, ctx),
		});
		if (decision.outcome === "approved") ui.notify(`${built.summary}. 승인하고 저장했습니다(${shortHash(decision.hash)}).`);
		else ui.notify(decision.outcome === "rejected" ? decision.reason : "바꾸지 않았습니다. 시험 사용 결과는 다음 /storm 에서 다시 묻습니다.");
		return decision.outcome === "approved";
	}
	return false;
}

/** An approved config as it was stored, when its snapshot is still there, intact and valid today. */
async function approvedSnapshot(state: ProjectState, hash: string): Promise<StormConfig | undefined> {
	const config = validateConfig(await state.store.snapshot(hash)).config;
	return config && configHash(config) === hash ? config : undefined;
}

/** Earlier approvals that can still be restored, newest first, without the current config. */
async function rollbackOptions(state: ProjectState): Promise<RollbackOption[]> {
	const currentHash = state.config.status === "ok" ? state.config.hash : null;
	const options: RollbackOption[] = [];
	for (const record of await state.store.list()) {
		if (record.configHash === currentHash) continue;
		const config = await approvedSnapshot(state, record.configHash);
		if (config) options.push({ hash: record.configHash, approvedAt: record.approvedAt, config });
	}
	return options;
}

/** Puts an earlier approved config back. Its approval record is still there, so nothing new is approved. */
async function rollbackFlow(env: FlowEnv, ui: UiPort, state: ProjectState, options: readonly RollbackOption[]): Promise<void> {
	const current = state.config.status === "ok" ? state.config.config : undefined;
	const option = await runRollback(ui, { options, ...(current ? { current } : {}) });
	if (!option) {
		ui.notify("되돌리지 않았습니다.");
		return;
	}
	if (movedSince(state, await loadProjectState(env))) {
		ui.notify(MOVED, "warning");
		return;
	}
	await writeConfig(state.repo.root, option.config);
	ui.notify(`이전에 승인한 팀 설정으로 되돌렸습니다(${shortHash(option.hash)}).`);
}

const MENU = {
	resume: "끝나지 않은 실행 이어 가기",
	setup: "팀 다시 설정",
	models: "모델 점검",
	agents: "서브에이전트",
	rollback: "이전 승인으로 되돌리기",
	reset: "초기화",
	close: "닫기",
} as const;

/** A config file that does not validate: every error in view, and the ways out. Setup starts only when the user picks it. */
async function invalidFlow(env: FlowEnv, ui: UiPort, state: ProjectState, errors: readonly string[], path: string): Promise<void> {
	const rollbacks = await rollbackOptions(state);
	// The errors quote the file (keys, values), so each one is shown as a single line.
	const markdown = [`\`${path}\``, "", ...errors.map(error => `- ${visible(error)}`), "", "파일을 직접 고쳐도 됩니다. 고칠 때까지 Storm 스폰은 막힙니다."].join("\n");
	const choice = await ui.select("팀 설정 파일에 오류가 있습니다", [...(rollbacks.length ? [MENU.rollback] : []), MENU.setup, CANCEL], {
		title: "팀 설정 오류",
		markdown,
	});
	if (choice === MENU.rollback) await rollbackFlow(env, ui, state, rollbacks);
	else if (choice === MENU.setup) await setupFlow(env, ui);
}

/**
 * A valid config nobody approved on this machine (changed by hand, pulled from a teammate) or new shadowing
 * definitions: the dialog shows everything "승인" covers, against the latest approved config.
 */
async function unapprovedFlow(env: FlowEnv, ui: UiPort, state: OkState): Promise<void> {
	const { config, hash, warnings } = state.config;
	const [records, rollbacks, ctx] = await Promise.all([state.store.list(), rollbackOptions(state), prepareAnalysis(env, ui)]);
	// A snapshot that no longer validates is not diffed against: the whole team is shown instead.
	const previous = records[0] ? await approvedSnapshot(state, records[0].configHash) : undefined;
	const markdown = renderApproval(undefined, previous, config, { warnings: [...warnings, ...modelWarnings(config, ctx)], shadows: state.shadows });
	const choice = await ui.select("이 팀 설정을 승인할까요?", [APPROVE, ...(rollbacks.length ? [MENU.rollback] : []), MENU.setup, CANCEL], {
		title: `승인할 팀 설정 · ${shortHash(hash)}`,
		consent: [APPROVE],
		markdown,
	});
	if (choice === MENU.rollback) return rollbackFlow(env, ui, state, rollbacks);
	if (choice === MENU.setup) return setupFlow(env, ui);
	if (choice !== APPROVE) {
		ui.notify("승인하지 않았습니다. Storm 스폰은 계속 막힙니다.");
		return;
	}
	if (movedSince(state, await loadProjectState(env))) {
		ui.notify("승인하는 사이 팀 설정이나 가림 정의가 바뀌어 승인하지 않았습니다. /storm 으로 다시 확인하세요.", "warning");
		return;
	}
	// The user's file is approved as it is; Storm does not rewrite it.
	await state.store.approve({ configHash: hash, config, scope: { shadowedAgents: state.shadows } });
	ui.notify(`승인했습니다(${shortHash(hash)}).`);
}

/**
 * Bare `/storm`: sets up a project without a config, shows the errors of an invalid one, asks for approval while
 * something is unapproved, and otherwise opens the menu with the status in view. Returns true when the user reset Storm.
 */
export async function hubFlow(env: FlowEnv, ui: UiPort): Promise<boolean> {
	let state = await loadProjectState(env);
	if (state.config.status === "missing") {
		await setupFlow(env, ui);
		return false;
	}
	if (state.config.status === "invalid") {
		await invalidFlow(env, ui, state, state.config.errors, state.config.path);
		return false;
	}
	if (!isApproved(state)) {
		await unapprovedFlow(env, ui, state as OkState);
		return false;
	}
	let trials: TrialView[] | undefined = await trialViews(env, state.repo.root, state.config.config, env.now());
	if (await offerTrialDecisions(env, ui, state as OkState, trials)) {
		// The panel must show the config as it is now.
		state = await loadProjectState(env);
		trials = undefined;
	}
	const [view, rollbacks, last] = await Promise.all([
		statusView(env, state, { quota: false, user: true, ...(trials ? { trials } : {}) }),
		rollbackOptions(state),
		env.startRun ? lastRun(state.repo.root) : undefined,
	]);
	const resume = await resumeCandidate(state.store.dir, state.repo.root, last);
	const options: string[] = [...(resume ? [MENU.resume] : []), MENU.setup, MENU.models];
	if (env.agents?.().length) options.push(MENU.agents);
	if (rollbacks.length) options.push(MENU.rollback);
	options.push(MENU.reset, MENU.close);
	const choice = await ui.select("Storm 메뉴", options, {
		title: "Storm 현황",
		markdown: [renderStatusBrief(view, env.now()), resume ? resumeRunLine(resume) : undefined, view.storage].filter(Boolean).join("\n\n"),
	});
	if (choice === MENU.resume && resume) await startResume(env, ui, resume);
	else if (choice === MENU.setup) await setupFlow(env, ui);
	else if (choice === MENU.models) await modelsFlow(env, ui);
	else if (choice === MENU.agents) await agentsFlow(env, ui);
	else if (choice === MENU.rollback) await rollbackFlow(env, ui, state, rollbacks);
	else if (choice === MENU.reset) return resetFlow(env, ui);
	return false;
}

/**
 * The one start both resume paths make: the old request through `runSpec` (its limits carried over) and the user's
 * words, when there were any, as a note for the director.
 */
async function startResume(env: FlowEnv, ui: UiPort, run: RunRecord & { request: string }, said?: string): Promise<void> {
	const spec = resumeSpec(run, said);
	if (!spec.ok) {
		ui.notify(`Storm 실행을 시작하지 못했습니다: ${spec.error}`, "warning");
		return;
	}
	const start = env.startRun;
	if (!start) return;
	const started = await start(spec.spec);
	if (!started.ok) ui.notify(`Storm 실행을 시작하지 못했습니다: ${started.reason}`, "warning");
}

/**
 * `/storm …` when the classifier reads the request as continuing the run that stopped unfinished: no menu, the
 * same start the menu's first option makes. `said` is what the user typed, kept as a note beside the old request.
 */
export async function resumeFlow(env: FlowEnv, ui: UiPort, said?: string): Promise<void> {
	const state = await loadProjectState(env);
	const resume = await resumeCandidate(state.store.dir, state.repo.root, await lastRun(state.repo.root));
	if (!resume) {
		ui.notify("이어 갈 실행이 없습니다.");
		return;
	}
	if (!env.startRun) return;
	await startResume(env, ui, resume, said);
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

const RESET_WITH_INDEX = "초기화하고 실행 요약 색인도 지우기";

/**
 * `/storm reset`: deletes the project's `.omp/storm/` and this repo's approvals in one go, after one exact "초기화".
 * Two things stay: the run summary index (unless the user picks the exact option that deletes it too) and the list of
 * Storm runs beside the approvals, without which the omp records of earlier runs could never be cleaned up.
 * Refuses while a run is active. Returns true when something was deleted.
 */
export async function resetFlow(env: FlowEnv, ui: UiPort): Promise<boolean> {
	const state = await loadProjectState(env);
	/** True, with a notice, while a Storm run of this repo is active here or in another process. */
	const blockedByRun = (): boolean => {
		const running = env.activeRun?.() ?? activeLedgerRun(state.repo.repoId);
		if (running) ui.notify(`Storm 실행(${running.runId})이 진행 중이라 초기화하지 않습니다. 실행이 끝난 뒤 다시 하세요.`, "warning");
		return running !== undefined;
	};
	if (blockedByRun()) return false;
	const root = state.repo.root;
	const local = dirname(configPath(root));
	const [hasLocal, hasPointer, approvals] = await Promise.all([
		pathExists(local),
		pathExists(resumePointerFile(state.store.dir, root)),
		state.store.list(),
	]);
	if (!hasLocal && !hasPointer && approvals.length === 0) {
		ui.notify("초기화할 Storm 팀 설정이나 기록이 없습니다.");
		return false;
	}
	const git = state.repo.kind === "git-common-dir";
	const [runs, tracked, worktrees, last, index] = await Promise.all([
		countJson(runsDir(root)),
		hasLocal && git ? trackedFiles(env, root, local) : Promise.resolve([]),
		approvals.length && git ? otherWorktrees(env, root) : Promise.resolve(0),
		lastRun(root),
		readRunIndex(root),
	]);
	const c = state.config;
	const configLine =
		c.status === "ok"
			? `팀 설정 ${shortHash(c.hash)}(${state.approval ? "승인됨" : "미승인"})`
			: c.status === "invalid"
				? "팀 설정(오류)"
				: "팀 설정 없음";
	const lines = ["### 지울 것"];
	if (hasLocal) lines.push(`- \`${relative(root, local)}/\`: ${configLine}, 실행 기록 ${runs}개, 시험 사용 카운터, 쿼터 소진 표시`);
	if (approvals.length) lines.push(`- 승인 기록 ${approvals.length}건과 승인한 팀 설정 사본: \`${state.store.dir}\``);
	if (tracked.length) {
		lines.push(`- 주의: git에 커밋된 파일 ${tracked.length}개(${tracked.join(", ")})는 지우면 변경 사항으로 남습니다. 커밋은 직접 하세요.`);
	}
	if (worktrees > 0) lines.push(`- 주의: 이 저장소의 다른 worktree ${worktrees}개도 이 승인 기록을 씁니다. 그쪽 팀 설정은 다시 승인해야 합니다.`);
	if (last?.status === "running") {
		lines.push(`- 주의: 마지막 실행(${last.runId})이 진행 중으로 남아 있습니다. 다른 터미널에서 실행 중이면 끝난 뒤 초기화하세요.`);
	}
	lines.push(
		"",
		"### 그대로 두는 것",
		"- `.omp/`의 다른 파일, omp 설정",
		"- Storm 실행 목록(`runs.jsonl`): 어떤 omp 기록이 Storm 실행의 것인지 아는 유일한 근거라, 지우면 지난 실행의 서브에이전트 기록을 정리할 수 없습니다.",
	);
	if (index.length) lines.push(`- 실행 요약 색인 ${index.length}줄: 기본으로 남깁니다. 지우려면 "${RESET_WITH_INDEX}"를 고르세요.`);
	const choice = await ui.select(
		"Storm 팀 설정과 기록을 모두 지울까요? 되돌릴 수 없습니다.",
		index.length ? ["초기화", RESET_WITH_INDEX, CANCEL] : ["초기화", CANCEL],
		{ title: "Storm 초기화", markdown: lines.join("\n"), consent: ["초기화", RESET_WITH_INDEX] },
	);
	if (choice !== "초기화" && !(index.length && choice === RESET_WITH_INDEX)) {
		ui.notify("초기화하지 않았습니다.");
		return false;
	}
	// A run may have started while the dialog was open.
	if (blockedByRun()) return false;
	const keptIndex = index.length && choice === "초기화" ? await readFile(runIndexFile(root), "utf8").catch(() => undefined) : undefined;
	await rm(local, { recursive: true, force: true });
	if (keptIndex !== undefined) {
		// The index holds task text; the recreated `.omp/storm/` must keep `state/` out of git as setup does.
		await mkdir(dirname(runIndexFile(root)), { recursive: true });
		await writeFile(join(local, ".gitignore"), "/state/\n");
		await writeFile(runIndexFile(root), keptIndex);
	}
	// `clear` keeps the run list but not this pointer: it names a run whose request was sent from this machine.
	await rm(resumePointerFile(state.store.dir, root), { force: true });
	const removed = await state.store.clear();
	ui.notify(
		[
			`Storm 팀 설정과 기록을 지웠습니다(승인 ${removed}건 포함). 다시 쓰려면 /storm 으로 팀을 설정하세요.`,
			tracked.length ? "git에서 지워진 파일은 직접 커밋하세요." : "",
			keptIndex !== undefined ? "실행 요약 색인은 남겼습니다." : "",
		]
			.filter(Boolean)
			.join(" "),
	);
	return true;
}
