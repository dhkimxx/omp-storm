/**
 * /storm flows: setup (the recommended team or the role-by-role interview), status,
 * approval of a config changed by hand, rollback, trial decisions, automatic-delegation consent, reset. None of them
 * calls a model or sends a message. A config is approved only by the exact "승인" in Storm's dialog; the first such
 * approval initializes automatic delegation, later changes need its own exact choice, and reset deletes only after
 * the single exact "초기화" choice.
 */
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { initializeAutoDelegation, readAutoDelegationChoice, writeAutoDelegation } from "./approval/auto.ts";
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
import { acquireRunLease } from "./runtime/lease.ts";
import { lastRun, runsDir } from "./runtime/run.ts";
import { findResumeCandidate, resumePointerFile, resumeSpec } from "./runtime/resume.ts";
import { formatStorage, readStorage } from "./runtime/janitor.ts";
import { readRunIndex, runIndexFile } from "./runtime/run-index.ts";
import { readQuotaMarks } from "./runtime/state-files.ts";
import { trialViews } from "./runtime/views.ts";
import { BROWSE, commonSettingsForm, effortForm, FIELD, type FormRetry, interviewRoles, pickedEntry, readRoleChoices, recommendationNotes, type RoleAnswers, roleForm, type SetupFormInput, setupConfig, subagentShares } from "./setup/form.ts";
import { isApproved, loadProjectState, type ProjectEnv, type ProjectState } from "./state.ts";
import type { RunRequestResult } from "./tool/host.ts";
import type { AgentEntry, AnalysisContext, ApprovalScope, ConfigLoad, ExplicitSettings, FormData, InfoLine, ModelInfo, RoleId, RollbackOption, RunRecord, RunSpec, StatusView, StormConfig, TrialView, UiPort } from "./types.ts";

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

/** The explicit switch labels: the first approval initializes the choice, these change it later. */
const AUTO = { enable: "자동 위임 켜기", disable: "자동 위임 끄기" } as const;

/** A choice this flow can read. `unset` is not a decision yet; `invalid` is a file setup and migration never rewrite. */
type AutoChoice = "on" | "off" | "unset" | "invalid";

/** Shown first in the approval that carries the first local approval's default. */
const AUTO_DISCLOSURE = [
	"승인하면 자동 위임이 켜집니다",
	"",
	"- 승인한 팀이 이 저장소의 작업을 맡습니다. 메인 세션은 프로젝트 도구를 직접 쓰지 않고, 작은 수정도 팀 작업으로 넘깁니다.",
	"- 일반 대화는 지금처럼 메인 세션에서 이어집니다. 역할별 워커 수, 실행 한도, OMP의 승인 절차는 바뀌지 않습니다.",
	"- 이 프로필과 이 저장소에만 적용됩니다. 끄려면 `/storm auto`를 실행하세요.",
].join("\n");

/** The one-time choice added to the hub for a team approved before this default existed. */
const AUTO_MIGRATION = { switch: "자동 위임으로 전환", stay: "직접 작업 유지" } as const;
const AUTO_MIGRATION_NOTICE = [
	"자동 위임으로 전환하면 메인 세션이 이 저장소의 작업을 직접 하지 않습니다. 작은 수정도 Storm 팀이 맡습니다.",
	"일반 대화는 지금처럼 메인 세션에서 이어지고, 역할별 워커 수와 실행 한도, OMP의 승인 절차는 바뀌지 않습니다. 이 프로필과 이 저장소에만 적용되며, 끄려면 /storm auto 를 실행합니다.",
	`「${AUTO_MIGRATION.switch}」를 고르면 지금부터 적용하고, 「${AUTO_MIGRATION.stay}」를 고르면 지금처럼 직접 작업합니다. 결정하면 다시 묻지 않습니다.`,
].join("\n");

/** `on`/`off` are saved choices; `unset` has no file; `invalid` is an unreadable file, never turned into a yes here. */
async function savedAutoChoice(state: ProjectState): Promise<AutoChoice> {
	try {
		return await readAutoDelegationChoice(state.store.dir);
	} catch {
		// Fail closed: an unreadable choice is not the user's yes.
		return "invalid";
	}
}

/**
 * The default-on disclosure and its activation belong to the first approval on this machine: no earlier approval
 * in this profile's store and no saved choice. A missing config alone does not make a re-setup a first approval.
 */
async function firstLocalApproval(state: ProjectState): Promise<boolean> {
	return (await state.store.list()).length === 0 && (await savedAutoChoice(state)) === "unset";
}

/** Called only after the team's own approval was written; a failed or refused write leaves the team saved. */
async function activateAutoAfterApproval(state: ProjectState, ui: UiPort, first: boolean): Promise<void> {
	if (!first) return;
	try {
		if (await initializeAutoDelegation(state.store.dir, true)) {
			ui.notify("자동 위임을 켰습니다. 끄려면 /storm auto 를 실행하세요.");
			return;
		}
		ui.notify("팀 설정은 저장했지만 자동 위임 상태는 확인하지 못했습니다(다른 선택이 이미 저장되어 있을 수 있습니다). /storm auto 에서 확인하세요.", "warning");
	} catch {
		ui.notify("팀 설정은 저장했지만 자동 위임을 켜지 못했습니다. /storm auto 에서 확인하세요.", "warning");
	}
}

/** An explicit choice overwrites the saved file, including an invalid one; a failed write changes nothing. */
async function saveAutoChoice(state: ProjectState, ui: UiPort, enabled: boolean, done: string): Promise<void> {
	try {
		await writeAutoDelegation(state.store.dir, enabled);
		ui.notify(done);
	} catch {
		ui.notify("자동 위임 상태를 저장하지 못했습니다. 바뀐 것이 없습니다.", "warning");
	}
}

/**
 * What automatic delegation changes, shown wherever it is offered or inspected. Settings live in this profile's
 * approval directory for this repository (`state.store.dir`), so linked worktrees share the choice while each
 * worktree's team config is still approved separately. Nothing here is a reason to fall back to direct tools.
 */
function autoDelegationDoc(state: { enabled: boolean; approved: boolean }): string {
	const now = state.enabled
		? state.approved
			? "- 지금 켜져 있고, 승인된 팀에서 동작합니다. 끄려면 「자동 위임 끄기」를 고르세요."
			: "- 지금 켜져 있지만 팀 설정이 승인되지 않아 동작하지 않습니다. 끄기는 지금도 할 수 있습니다."
		: state.approved
			? "- 지금은 꺼져 있습니다. 켜려면 「자동 위임 켜기」를 고르세요."
			: "- 팀 설정이 승인되어 있지 않아 지금은 켤 수 없습니다. `/storm` 으로 팀을 승인한 뒤 다시 `/storm auto` 를 실행하세요.";
	return [
		"### 적용 범위",
		"- 이 설정은 이 프로필과 이 저장소에만 적용됩니다. 이 저장소의 연결된 worktree는 이 선택을 함께 쓰고, 각 worktree의 팀 설정은 그곳에서 따로 승인합니다.",
		"",
		"### 켜면",
		"- 메인 세션은 프로젝트 도구를 직접 쓰지 않습니다. 작은 수정도 Storm 팀 작업으로 넘깁니다.",
		"- 프로젝트와 무관한 일반 대화는 지금처럼 메인 세션에서 이어집니다.",
		"- 역할별 워커 수와 실행 한도, OMP의 승인 절차는 바뀌지 않습니다.",
		"- 승인을 기다리는 동안 메인 세션이 직접 처리하는 식으로 대신하지 않습니다.",
		"",
		"첫 팀 승인은 자동 위임을 켜는 것이 기본이고, 저장된 선택은 다시 설정해도 그대로입니다.",
		"",
		now,
	].join("\n");
}

function autoDelegationMarkdown(state: { enabled: boolean; approved: boolean; invalid?: boolean }): string {
	return [
		`- 상태: **${state.enabled ? "켜짐" : "꺼짐"}**`,
		`- 팀 설정: ${state.approved ? "승인됨" : "승인되지 않음 — 자동 위임은 동작하지 않습니다."}`,
		...(state.invalid ? ["- 저장된 선택을 읽을 수 없어 꺼진 것으로 봅니다. 여기서 고르면 새 선택으로 고쳐집니다."] : []),
		"",
		autoDelegationDoc(state),
	].join("\n");
}

/** The role form, then an effort page per chosen model, repeated before common settings and approval. */
async function pickByRole(
	env: FlowEnv,
	ui: UiPort,
	form: NonNullable<UiPort["form"]>,
	state: ProjectState,
	ctx: AnalysisContext,
	input: SetupFormInput,
	firstApproval: boolean,
): Promise<boolean> {
	const pickModel = ui.pickModel?.bind(ui);
	const browse = pickModel !== undefined;
	const roles = interviewRoles(input, browse);
	const selected: RoleAnswers = {};
	const cancelled = (): boolean => {
		notifySetup(ui, { outcome: "cancelled" });
		return false;
	};
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
				if (++invalid >= FORM_TRIES) {
					ui.notify(INVALID_FORM, "warning");
					return false;
				}
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
			...(firstApproval ? { context: AUTO_DISCLOSURE } : {}),
		});
		// No extra option was offered.
		if (decision.outcome !== "extra") notifySetup(ui, decision);
		return decision.outcome === "approved";
	}
	ui.notify(INVALID_FORM, "warning");
	return false;
}

/**
 * Setup and re-setup, without the model: Storm computes the recommended team (what the user chose before carries
 * over) and shows it in the approval dialog. "승인" saves it; where the host draws forms, "역할별로 고르기" opens the
 * interview instead. The first approval on this machine turns automatic delegation on, after the team is saved.
 * Nothing reaches the main session.
 */
export async function setupFlow(env: FlowEnv, ui: UiPort): Promise<void> {
	const state = await loadProjectState(env);
	/** Not "missing config": re-setup after a deleted config is still a later approval when an approval exists. */
	const firstApproval = await firstLocalApproval(state);
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
			if (choice === PICK_BY_ROLE && (await pickByRole(env, ui, form, state, ctx, input, firstApproval))) {
				await activateAutoAfterApproval(state, ui, firstApproval);
			}
		} else {
			ui.notify(`지금 쓸 수 있는 모델로는 팀을 추천할 수 없습니다(${checked.errors.join("; ")}). omp에서 Provider에 로그인한 뒤 다시 /storm 을 실행하세요.`, "warning");
		}
		return;
	}
	// What "승인" switches on beyond the models comes first after the auto-delegation disclosure: a small terminal cuts the panel from the end.
	const cleanupNotice =
		proposed.cleanup === true && current?.cleanup !== true
			? `「실행이 끝나면 정리」가 켜집니다: 실행이 끝날 때마다 최근 3개를 뺀 Storm 실행의 끝난 서브에이전트 omp 기록을 지웁니다. 끄려면 ${form ? `「${PICK_BY_ROLE}」에서` : "승인한 뒤 `/storm <요청>` 으로"} 끄세요.`
			: "";
	const context = [
		firstApproval ? AUTO_DISCLOSURE : "",
		cleanupNotice,
		state.config.status === "invalid" ? "지금 팀 설정 파일에 오류가 있어 새로 만듭니다." : "",
		form ? "" : "이 환경에서는 역할별로 고르는 폼을 그릴 수 없습니다. 승인한 뒤 `/storm <요청>` 으로 바꾸세요.",
	]
		.filter(Boolean)
		.join("\n\n");
	const notesInfo: InfoLine[] = [];
	const notes = recommendationNotes(recs, proposed, notesInfo);
	const decision = await decideProposal(decideHost(env, ui), state, { kind: "setup", summary: current ? "Storm 추천 팀으로 다시 설정" : "Storm 추천 팀", config: proposed }, {
		warnings: [...ctx.detection(env.activeTools).warnings, ...ctx.analysis.warnings, ...modelWarnings(proposed, ctx)],
		context,
		notes,
		notesInfo,
		...(form ? { extraOptions: [PICK_BY_ROLE] } : {}),
	});
	// "역할별로 고르기" is offered only with a form.
	if (!form) {
		notifySetup(ui, decision.outcome === "extra" ? { outcome: "cancelled" } : decision);
		if (decision.outcome === "approved") await activateAutoAfterApproval(state, ui, firstApproval);
		return;
	}
	if (decision.outcome === "unchanged") {
		// The recommendation is the approved team, so there is nothing to approve; picking role by role is still open.
		const choice = await ui.select("Storm 추천 팀이 지금 승인된 팀과 같습니다", [PICK_BY_ROLE, MENU.close], {
			title: "Storm 팀 제안",
			markdown: notes,
			info: notesInfo,
		});
		if (choice !== PICK_BY_ROLE) return;
	} else if (decision.outcome !== "extra") {
		notifySetup(ui, decision);
		if (decision.outcome === "approved") await activateAutoAfterApproval(state, ui, firstApproval);
		return;
	}
	if (await pickByRole(env, ui, form, state, ctx, input, firstApproval)) await activateAutoAfterApproval(state, ui, firstApproval);
}

/**
 * `/storm auto` and the hub entry: the personal automatic-delegation consent for this profile and repository, shown
 * with its scope and changed only by an explicit choice. Turning on needs an approved team; turning off stays
 * possible while the config is stale, invalid or unapproved, and an explicit choice repairs an invalid saved file.
 * A host that cannot answer changes nothing.
 */
export async function autoDelegationFlow(env: FlowEnv, ui: UiPort): Promise<void> {
	const state = await loadProjectState(env);
	const choice = await savedAutoChoice(state);
	const approved = state.config.status === "ok" && isApproved(state);
	const markdown = autoDelegationMarkdown({ enabled: choice === "on", approved, ...(choice === "invalid" ? { invalid: true } : {}) });
	if (choice === "on") {
		const answer = await ui.select("자동 위임", [AUTO.disable, CANCEL], { title: "자동 위임", markdown });
		if (answer !== AUTO.disable) {
			ui.notify("자동 위임을 그대로 둡니다.");
			return;
		}
		await saveAutoChoice(state, ui, false, "자동 위임을 껐습니다. 메인 세션이 프로젝트 작업을 직접 처리합니다.");
		return;
	}
	if (!approved) {
		// Enabling needs approval; an unreadable saved file can still be repaired to an explicit off.
		if (choice === "invalid") {
			const answer = await ui.select("자동 위임", [AUTO.disable, CANCEL], { title: "자동 위임", markdown });
			if (answer !== AUTO.disable) {
				ui.notify("저장된 자동 위임 상태를 바꾸지 않았습니다.");
				return;
			}
			await saveAutoChoice(state, ui, false, "자동 위임을 꺼진 상태로 저장했습니다.");
			return;
		}
		await ui.report("자동 위임", markdown);
		ui.notify("자동 위임을 켜려면 팀 설정을 승인해야 합니다. /storm 으로 팀을 승인한 뒤 다시 /storm auto 를 실행하세요.", "warning");
		return;
	}
	const answer = await ui.select("자동 위임", choice === "invalid" ? [AUTO.enable, AUTO.disable, CANCEL] : [AUTO.enable, CANCEL], {
		title: "자동 위임",
		consent: [AUTO.enable],
		markdown,
	});
	if (answer === AUTO.disable) {
		await saveAutoChoice(state, ui, false, "자동 위임을 꺼진 상태로 저장했습니다.");
		return;
	}
	if (answer !== AUTO.enable) {
		ui.notify("자동 위임을 켜지 않았습니다.");
		return;
	}
	const current = await loadProjectState(env);
	if (current.repo.root !== state.repo.root || !isApproved(current) || movedSince(state, current)) {
		ui.notify("선택하는 사이 팀 설정이나 승인이 바뀌어 자동 위임을 켜지 않았습니다. /storm 으로 다시 확인하세요.", "warning");
		return;
	}
	await saveAutoChoice(current, ui, true, "자동 위임을 켰습니다. 이 프로필과 저장소에만 적용됩니다.");
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
	const [quota, quotaMarks, last, trials, settings, storage, autoChoice] = await Promise.all([
		opts.quota ? readQuota(env.exec, env.ompBin) : undefined,
		readQuotaMarks(root, now),
		lastRun(root),
		opts.trials ?? (config ? trialViews(env, root, config, now) : []),
		opts.user ? env.ompSettings?.() : undefined,
		opts.user ? readStorage(root, state.store.dir, join(env.agentDir, "sessions")) : undefined,
		opts.user ? savedAutoChoice(state) : undefined,
	]);
	const usage = readUsage({ dbPath: env.statsDb ?? statsDbPath(), windowDays: 1, now });
	const run = env.activeRun?.();
	const agents = env.agents?.() ?? [];
	const ompAdvice = config && settings ? ompSettingsAdvice(config, settings) : [];
	const newerVersion = opts.user ? env.newerVersion?.() : undefined;
	return {
		config: state.config,
		approval: state.approval,
		// An unset choice is off: an existing approved team gets no retroactive consent from this status.
		...(autoChoice !== undefined ? { autoDelegation: autoChoice === "on" ? (isApproved(state) && config ? "on" : "blocked") : "off" } : {}),
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
 * The status as text from one project read. `info` collects the TUI's semantic spans for the same Markdown; the
 * storm tool's model view still passes none, so its payload is unchanged.
 */
async function statusMarkdown(env: FlowEnv, opts: { quota: boolean }, info?: InfoLine[]): Promise<string> {
	const state = await loadProjectState(env);
	const view = await statusView(env, state, { quota: opts.quota, user: opts.quota });
	return renderStatus(view, env.now(), opts.quota ? "user" : "model", info);
}

/**
 * The status as text. `quota: true` is the user's full report (`/storm status`): every section, quota included, with
 * the commands that fix what it points out. `quota: false` is the storm tool's: the same facts for the model, with no
 * extra CLI call, no advice to act on and no file paths.
 */
export async function statusText(env: FlowEnv, opts: { quota: boolean }): Promise<string> {
	return statusMarkdown(env, opts);
}

/** `/storm status`: the whole status to read and close. It never asks anything. */
export async function statusFlow(env: FlowEnv, ui: UiPort): Promise<void> {
	const info: InfoLine[] = [];
	const markdown = await statusMarkdown(env, { quota: true }, info);
	await ui.report("Storm 현황", markdown, info);
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

/** The hub's automatic-delegation entry says whether it is on or off; both open the same flow. */
const AUTO_MENU = { on: "자동 위임 · 켜짐", off: "자동 위임 · 꺼짐" } as const;

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
	const [records, rollbacks, ctx, firstApproval] = await Promise.all([state.store.list(), rollbackOptions(state), prepareAnalysis(env, ui), firstLocalApproval(state)]);
	// A snapshot that no longer validates is not diffed against: the whole team is shown instead.
	const previous = records[0] ? await approvedSnapshot(state, records[0].configHash) : undefined;
	const info: InfoLine[] = [];
	const markdown = renderApproval(undefined, previous, config, {
		...(firstApproval ? { context: AUTO_DISCLOSURE } : {}),
		warnings: [...warnings, ...modelWarnings(config, ctx)],
		shadows: state.shadows,
	}, info);
	const choice = await ui.select("이 팀 설정을 승인할까요?", [APPROVE, ...(rollbacks.length ? [MENU.rollback] : []), MENU.setup, CANCEL], {
		title: `승인할 팀 설정 · ${shortHash(hash)}`,
		consent: [APPROVE],
		markdown,
		info,
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
	// The user's file is approved as it is; Storm does not rewrite it. The auto choice is initialized only after this succeeds.
	await state.store.approve({ configHash: hash, config, scope: { shadowedAgents: state.shadows } });
	ui.notify(`승인했습니다(${shortHash(hash)}).`);
	await activateAutoAfterApproval(state, ui, firstApproval);
}

/**
 * The one-time choice for a team approved before the default existed. Both actions use the exclusive initialize so a
 * choice saved from another process wins; only the exact labels write, and only the switch rechecks the team.
 */
async function migrateAutoDelegation(env: FlowEnv, ui: UiPort, before: OkState, choice: string): Promise<void> {
	if (choice === AUTO_MIGRATION.switch) {
		const fresh = await loadProjectState(env);
		// The same repo, config hash and approval (shadows included): nothing moved while the menu was open.
		if (
			fresh.repo.root !== before.repo.root ||
			fresh.config.status !== "ok" ||
			fresh.config.hash !== before.config.hash ||
			!isApproved(fresh) ||
			movedSince(before, fresh)
		) {
			ui.notify("선택하는 사이 팀 설정이나 승인이 바뀌어 자동 위임으로 전환하지 않았습니다. /storm 으로 다시 확인하세요.", "warning");
			return;
		}
		try {
			if (await initializeAutoDelegation(fresh.store.dir, true)) {
				ui.notify("자동 위임으로 전환했습니다. 끄려면 /storm auto 를 실행하세요.");
				return;
			}
			ui.notify("다른 선택이 이미 저장되어 자동 위임으로 전환하지 않았습니다. /storm auto 에서 확인하세요.", "warning");
		} catch {
			ui.notify("자동 위임으로 전환하지 못했습니다. /storm auto 에서 다시 확인하세요.", "warning");
		}
		return;
	}
	try {
		if (await initializeAutoDelegation(before.store.dir, false)) ui.notify("직접 작업을 유지합니다. 자동 위임은 꺼진 상태로 저장했습니다.");
		else ui.notify("다른 선택이 이미 저장되어 바꾸지 않았습니다. /storm auto 에서 확인하세요.", "warning");
	} catch {
		ui.notify("자동 위임 선택을 저장하지 못했습니다. /storm auto 에서 다시 확인하세요.", "warning");
	}
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
	const [view, rollbacks, resume, autoChoice] = await Promise.all([
		statusView(env, state, { quota: false, user: true, ...(trials ? { trials } : {}) }),
		rollbackOptions(state),
		env.startRun ? findResumeCandidate(state.store.dir, state.repo.root) : undefined,
		savedAutoChoice(state),
	]);
	/** An approved team from before the default: offer the transition once, beside every normal action. */
	const migrate = autoChoice === "unset";
	const options: string[] = [...(resume ? [MENU.resume] : []), MENU.setup, MENU.models];
	if (env.agents?.().length) options.push(MENU.agents);
	options.push(autoChoice === "on" ? AUTO_MENU.on : AUTO_MENU.off);
	if (migrate) options.push(AUTO_MIGRATION.switch, AUTO_MIGRATION.stay);
	if (rollbacks.length) options.push(MENU.rollback);
	options.push(MENU.reset, MENU.close);
	const choice = await ui.select("Storm 메뉴", options, {
		title: "Storm 현황",
		markdown: [migrate ? AUTO_MIGRATION_NOTICE : undefined, renderStatusBrief(view, env.now()), resume ? resumeRunLine(resume) : undefined, view.storage].filter(Boolean).join("\n\n"),
		// Only the switch accepts the migration notice; every normal action and "직접 작업 유지" stay available when it is cut.
		...(migrate ? { consent: [AUTO_MIGRATION.switch] } : {}),
	});
	if (choice === MENU.resume && resume) await startResume(env, ui, resume);
	else if (choice === MENU.setup) await setupFlow(env, ui);
	else if (choice === MENU.models) await modelsFlow(env, ui);
	else if (choice === MENU.agents) await agentsFlow(env, ui);
	else if (choice === AUTO_MENU.on || choice === AUTO_MENU.off) await autoDelegationFlow(env, ui);
	else if (migrate && (choice === AUTO_MIGRATION.switch || choice === AUTO_MIGRATION.stay)) await migrateAutoDelegation(env, ui, state as OkState, choice);
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
	const resume = await findResumeCandidate(state.store.dir, state.repo.root);
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
	/** Fast check inside this process; the worktree lease below closes the cross-process race. */
	const blockedByRun = (): boolean => {
		const running = env.activeRun?.() ?? activeLedgerRun(state.repo.root);
		if (running) ui.notify(`Storm 실행(${running.runId})이 진행 중이라 초기화하지 않습니다. 실행이 끝난 뒤 다시 하세요.`, "warning");
		return running !== undefined;
	};
	if (blockedByRun()) return false;
	const root = state.repo.root;
	const local = dirname(configPath(root));
	const [hasLocal, hasPointer, approvals, autoChoice] = await Promise.all([
		pathExists(local),
		pathExists(resumePointerFile(state.store.dir, root)),
		state.store.list(),
		savedAutoChoice(state),
	]);
	if (!hasLocal && !hasPointer && approvals.length === 0) {
		ui.notify("초기화할 Storm 팀 설정이나 기록이 없습니다.");
		return false;
	}
	const git = state.repo.kind === "git-common-dir";
	const [runs, tracked, worktrees, index] = await Promise.all([
		countJson(runsDir(root)),
		hasLocal && git ? trackedFiles(env, root, local) : Promise.resolve([]),
		approvals.length && git ? otherWorktrees(env, root) : Promise.resolve(0),
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
	lines.push(
		"",
		"### 그대로 두는 것",
		"- `.omp/`의 다른 파일, omp 설정",
		"- Storm 실행 목록(`runs.jsonl`): 어떤 omp 기록이 Storm 실행의 것인지 아는 유일한 근거라, 지우면 지난 실행의 서브에이전트 기록을 정리할 수 없습니다.",
	);
	if (index.length) lines.push(`- 실행 요약 색인 ${index.length}줄: 기본으로 남깁니다. 지우려면 "${RESET_WITH_INDEX}"를 고르세요.`);
	if (autoChoice === "on") lines.push("- 자동 위임 선택(켜짐): 지우지 않습니다. 팀 설정이 없어도 `/storm auto` 로 끌 수 있습니다.");
	const choice = await ui.select(
		"Storm 팀 설정과 기록을 모두 지울까요? 되돌릴 수 없습니다.",
		index.length ? ["초기화", RESET_WITH_INDEX, CANCEL] : ["초기화", CANCEL],
		{ title: "Storm 초기화", markdown: lines.join("\n"), consent: ["초기화", RESET_WITH_INDEX] },
	);
	if (choice !== "초기화" && !(index.length && choice === RESET_WITH_INDEX)) {
		ui.notify("초기화하지 않았습니다.");
		return false;
	}
	// Use the same lease as run admission so a second OMP process cannot start while reset removes its state.
	if (blockedByRun()) return false;
	const ownership = await acquireRunLease(root, "reset");
	if (!ownership.ok) {
		ui.notify(`Storm 초기화를 하지 않았습니다: ${ownership.reason}`, "warning");
		return false;
	}
	try {
		const fresh = await loadProjectState(env);
		if (movedSince(state, fresh)) {
			ui.notify(MOVED, "warning");
			return false;
		}
		const keptIndex = index.length && choice === "초기화" ? await readFile(runIndexFile(root), "utf8").catch(() => undefined) : undefined;
		await rm(local, { recursive: true, force: true });
		if (keptIndex !== undefined) {
			// Keep state out of Git when recreating the directory for its retained index.
			await mkdir(dirname(runIndexFile(root)), { recursive: true });
			await writeFile(join(local, ".gitignore"), "/state/\n");
			await writeFile(runIndexFile(root), keptIndex);
		}
		// The trust collection and team are removed; deliberate personal consent is not silently changed.
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
	} finally {
		await ownership.lease.release();
	}
}
