/**
 * /storm flows: setup (the recommended team, a one-slot model edit from the native picker, or the role-by-role
 * interview), status, approval of a config changed by hand, rollback, trial decisions, automatic-delegation consent,
 * template export and reset. None of them calls a model or sends a message. Everything they persist belongs to the
 * current native OMP session under its profile (`ProjectState.sessionDir`); the current work tree is only the target
 * an approval is bound to, never a storage key. A config is approved only by the exact "승인" in Storm's dialog; the
 * first such approval initializes automatic delegation, later changes need its own exact choice, and reset deletes
 * only this session's data after the single exact "초기화" choice.
 */
import { readdir, rm, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { initializeAutoDelegation, readAutoDelegationChoice, writeAutoDelegation } from "./approval/auto.ts";
import { configHash, shortHash } from "./config/canonical.ts";
import { teamPriority, validateConfig } from "./config/schema.ts";
import { configPath, serializeConfig, writeConfig } from "./config/store.ts";
import { prepareAnalysis } from "./context.ts";
import { readQuota } from "./discovery/quota.ts";
import { readUsage, statsDbPath } from "./history/stats.ts";
import { STORM_MARK, type RunPhase } from "./view/appearance.ts";
import { renderStatus, renderStatusBrief, renderTrial, resumeRunLine, targetScopeLine, visible } from "./view/render.ts";
import { runRollback } from "./view/review.ts";
import { recommendedConfig } from "./view/setup.ts";
import { buildTrialEnd, modelWarnings } from "./proposals/build.ts";
import { type DecideHost, type Decision, decideProposal, movedSince } from "./proposals/decide.ts";
import { APPROVE, CANCEL, renderApproval } from "./proposals/present.ts";
import { agentRows, renderAgentRows } from "./report/agents.ts";
import { renderModelCheck } from "./report/models.ts";
import { ompSettingsAdvice } from "./report/omp-settings.ts";
import { roleTitle } from "./roles.ts";
import { acquireSessionLease } from "./runtime/lease.ts";
import { lastRun, runsDir } from "./runtime/run.ts";
import { findResumeCandidate, resumeSpec } from "./runtime/resume.ts";
import { formatStorage, readStorage, storageDetailLines } from "./runtime/janitor.ts";
import { readRunIndex } from "./runtime/run-index.ts";
import { readQuotaMarks } from "./runtime/state-files.ts";
import { trialViews } from "./runtime/views.ts";
import { assertSessionStoreSafe, sessionStoreDir } from "./session-scope.ts";
import { BROWSE, commonSettingsForm, effortForm, FIELD, type FormRetry, interviewRoles, pickedEntry, readRoleChoices, recommendationNotes, type RoleAnswers, roleForm, type SetupFormInput, setupConfig, subagentShares } from "./setup/form.ts";
import { applySlotPick, entryForPick, modelSlots, slotCurrent } from "./setup/model-draft.ts";
import { type ModelEntry } from "./selector.ts";
import { isApproved, loadProjectState, type ProjectEnv, type ProjectState } from "./state.ts";
import type { RunRequestResult } from "./tool/host.ts";
import type { AgentEntry, AnalysisContext, ApprovalScope, ConfigLoad, ExplicitSettings, FormData, InfoLine, ModelInfo, Proposal, ProposalKind, RoleId, RollbackOption, RunRecord, RunSpec, StatusView, StormConfig, TrialView, UiPort } from "./types.ts";

export interface FlowEnv extends ProjectEnv {
	ompBin: string;
	/** Stats DB to read; omp's own when absent. */
	statsDb?: string;
	registry: { getAll(kind?: string): unknown[]; getAvailable(kind?: string): unknown[] };
	activeTools: string[];
	now: () => number;
	/** The Storm run active in this session, for status. */
	activeRun?: () => RunRecord | undefined;
	/** The live phase of that run, for views; undefined when the controller cannot say. Never persisted. */
	activePhase?: () => RunPhase | undefined;
	/** The current OMP mode that prevents automatic delegation, for the user's status only. */
	autoModeProblem?: () => string | undefined;
	/** Subagents under this session, for status. */
	agents?: () => AgentEntry[];
	/** The host's own transcript/artifact folder for this session, used only by the storage inventory; absent/empty → unnamed. */
	ompSessionDir?: string;
	/** omp settings as configured (concurrency, fallbacks, isolation); fields are undefined when unreadable. */
	ompSettings?: () => Promise<ExplicitSettings>;
	/** A newer Storm installed on disk than the one this process runs. */
	newerVersion?: () => string | undefined;
	/**
	 * Required live native-owner predicate, captured by the host: true only while the exact native main session
	 * (generation, id and canonical target) that opened this flow is still current. It must stay false after a
	 * switch, branch or A→B→A; a flow never re-authorizes by reloading its captured env.
	 */
	stillOwner: () => boolean;
	/** Starts a run in this session; absent where the caller cannot start one. */
	startRun?: (spec: RunSpec) => Promise<RunRequestResult>;
}

type OkState = ProjectState & { config: Extract<ConfigLoad, { status: "ok" }> };
type DecideOptions = { warnings?: readonly string[]; context?: string; notes?: string; notesInfo?: readonly InfoLine[]; extraOptions?: readonly string[] };

const STALE_ACTION = "대화가 바뀌어 이전 세션의 작업을 적용하지 않았습니다. 새 대화에서 다시 시도하세요.";

/** A delayed read or write is refused because its native owner is no longer live. */
class StaleOwnerError extends Error {
	constructor() {
		super(STALE_ACTION);
		this.name = "StaleOwnerError";
	}
}

/** True when the flow's native owner changed; says so once and lets the caller stop before any side effect. */
function stopIfStale(env: FlowEnv, ui: UiPort): boolean {
	if (env.stillOwner()) return false;
	ui.notify(STALE_ACTION, "warning");
	return true;
}

/** Writes the approval first, then the session config, so the file never exists unapproved after a successful save. */
export async function approveAndSave(state: ProjectState, config: StormConfig, scope: ApprovalScope, live?: () => boolean): Promise<string> {
	const hash = configHash(config);
	await assertSessionStoreSafe(state.sessionDir, state.repo.root);
	if (live !== undefined && !live()) throw new StaleOwnerError();
	await state.store.approve({ configHash: hash, config, scope });
	// A switch while the approval was being written must not add a config for an owner that is already gone.
	if (live !== undefined && !live()) throw new StaleOwnerError();
	await writeConfig(state.sessionDir, config);
	return hash;
}

function decideHost(env: FlowEnv, ui: UiPort): DecideHost {
	return {
		ui,
		loadState: async () => {
			// The post-dialog read is the first chance to catch a switch; the captured env alone would still return A.
			if (!env.stillOwner()) throw new StaleOwnerError();
			return loadProjectState(env);
		},
		approveAndSave: async (state, config, scope) => {
			if (!env.stillOwner()) throw new StaleOwnerError();
			return approveAndSave(state, config, scope, env.stillOwner);
		},
	};
}

/** Saves an already-approved change; a switch after its guard cancels before the config write. */
async function saveOwned(
	env: FlowEnv,
	ui: UiPort,
	state: ProjectState,
	config: StormConfig,
	scope: ApprovalScope,
): Promise<string | undefined> {
	try {
		return await approveAndSave(state, config, scope, env.stillOwner);
	} catch (error) {
		if (!(error instanceof StaleOwnerError)) throw error;
		ui.notify(STALE_ACTION, "warning");
		return undefined;
	}
}

/** Runs one proposal through its dialog; a stale owner cancels it before any approval or config write. */
async function decideOwned(
	env: FlowEnv,
	ui: UiPort,
	state: ProjectState,
	proposal: Proposal,
	opts: DecideOptions = {},
): Promise<Decision | undefined> {
	if (!env.stillOwner()) {
		ui.notify(STALE_ACTION, "warning");
		return undefined;
	}
	try {
		return await decideProposal(decideHost(env, ui), state, proposal, opts);
	} catch (error) {
		if (!(error instanceof StaleOwnerError)) throw error;
		ui.notify(STALE_ACTION, "warning");
		return undefined;
	}
}

/** The session or the target changed while a dialog was open: never apply the choice to either one. */
function ownerMoved(before: ProjectState, now: ProjectState): boolean {
	return now.sessionDir !== before.sessionDir || now.repo.root !== before.repo.root || movedSince(before, now);
}

/** Said when the session, target, config or shadowing definitions changed while a dialog was open: neither is overwritten. */
const MOVED = "창이 열려 있는 사이 세션·작업 대상·팀 설정이나 가림 정의가 바뀌어 저장하지 않았습니다. /storm 으로 다시 확인하세요.";

const PICK_BY_ROLE = "역할별로 고르기";
/** The direct one-slot edit: a native model pick becomes a real diff through the ordinary approval dialog. */
const EDIT_MODELS = "모델·effort 수정";
/** Offered on every direct-edit approval; the draft (including earlier edits in the same dialog) stays. */
const KEEP_EDITING = "계속 수정";
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

/** A choice this flow can read. `unset` is not a decision yet; `invalid` is a file setup never rewrites. */
type AutoChoice = "on" | "off" | "unset" | "invalid";

/** Shown first in the approval that carries the first local approval's default. */
const AUTO_DISCLOSURE = [
	"승인하면 이 세션의 자동 위임이 켜집니다",
	"",
	"- 승인한 팀이 이 작업 대상의 작업을 맡습니다. 메인 세션은 프로젝트 도구를 직접 쓰지 않고, 작은 수정도 팀 작업으로 넘깁니다.",
	"- 일반 대화는 지금처럼 메인 세션에서 이어집니다. 역할별 워커 수, 실행 한도, OMP의 승인 절차는 바뀌지 않습니다.",
	"- 이 OMP 세션에만 적용됩니다. 다른 세션이나 다른 작업 트리에는 적용되지 않으며, 끄려면 `/storm auto`를 실행하세요.",
].join("\n");

/** `on`/`off` are saved choices; `unset` has no file; `invalid` is an unreadable file, never turned into a yes here. */
async function savedAutoChoice(state: ProjectState): Promise<AutoChoice> {
	try {
		return await readAutoDelegationChoice(state.sessionDir);
	} catch {
		// Fail closed: an unreadable choice is not the user's yes.
		return "invalid";
	}
}

/**
 * The default-on disclosure and its activation belong to the first approval in this session for this target: no
 * earlier approval in the session's target store and no saved choice. A new or forked session starts here again;
 * the same native session keeps its earlier choice.
 */
async function firstLocalApproval(state: ProjectState): Promise<boolean> {
	return (await state.store.list()).length === 0 && (await savedAutoChoice(state)) === "unset";
}

/** Called only after the team's own approval was written; a failed or refused write leaves the team saved. */
async function activateAutoAfterApproval(env: FlowEnv, state: ProjectState, ui: UiPort, first: boolean): Promise<void> {
	if (!first) return;
	try {
		await assertSessionStoreSafe(state.sessionDir, state.repo.root);
		if (stopIfStale(env, ui)) return;
		if (await initializeAutoDelegation(state.sessionDir, true)) {
			ui.notify("자동 위임을 켰습니다. 끄려면 /storm auto 를 실행하세요.");
			return;
		}
		ui.notify("팀 설정은 저장했지만 자동 위임 상태는 확인하지 못했습니다(다른 선택이 이미 저장되어 있을 수 있습니다). /storm auto 에서 확인하세요.", "warning");
	} catch {
		ui.notify("팀 설정은 저장했지만 자동 위임을 켜지 못했습니다. /storm auto 에서 확인하세요.", "warning");
	}
}

/** An explicit choice overwrites the saved file, including an invalid one; a failed write changes nothing. */
async function saveAutoChoice(env: FlowEnv, state: ProjectState, ui: UiPort, enabled: boolean, done: string): Promise<void> {
	try {
		await assertSessionStoreSafe(state.sessionDir, state.repo.root);
		if (stopIfStale(env, ui)) return;
		await writeAutoDelegation(state.sessionDir, enabled);
		ui.notify(done);
	} catch {
		ui.notify("자동 위임 상태를 저장하지 못했습니다. 바뀐 것이 없습니다.", "warning");
	}
}

/**
 * What automatic delegation changes, shown wherever it is offered or inspected. The consent file belongs to this
 * native session alone (`state.sessionDir`); the team approval beside it is bound to the target shown below. No
 * other session and no other work tree reads either one.
 */
function autoDelegationDoc(state: { enabled: boolean; approved: boolean }, target: string): string {
	const now = state.enabled
		? state.approved
			? "- 지금 켜져 있고, 승인된 팀에서 동작합니다. 끄려면 「자동 위임 끄기」를 고르세요."
			: "- 지금 켜져 있지만 이 대상의 팀 설정이 승인되지 않아 동작하지 않습니다. 끄기는 지금도 할 수 있습니다."
		: state.approved
			? "- 지금은 꺼져 있습니다. 켜려면 「자동 위임 켜기」를 고르세요."
			: "- 이 대상의 팀 설정이 승인되어 있지 않아 지금은 켤 수 없습니다. `/storm` 으로 팀을 승인한 뒤 다시 `/storm auto` 를 실행하세요.";
	return [
		"### 적용 범위",
		`- 이 선택은 이 OMP 세션에만 저장되고, 승인된 팀은 지금 작업 대상(${target})에만 적용됩니다.`,
		"- 같은 프로필의 다른 세션과 다른 작업 트리는 각자의 선택과 승인을 따로 씁니다. 대상을 바꾸면 팀 설정은 남지만 다시 승인해야 합니다.",
		"",
		"### 켜면",
		"- 메인 세션은 이 대상의 프로젝트 도구를 직접 쓰지 않습니다. 작은 수정도 Storm 팀 작업으로 넘깁니다.",
		"- 프로젝트와 무관한 일반 대화는 지금처럼 메인 세션에서 이어집니다.",
		"- 역할별 워커 수와 실행 한도, OMP의 승인 절차는 바뀌지 않습니다.",
		"- 승인을 기다리는 동안 메인 세션이 직접 처리하는 식으로 대신하지 않습니다.",
		"",
		"이 세션의 첫 팀 승인은 자동 위임을 켜는 것이 기본이고, 저장된 선택은 다시 설정해도 그대로입니다.",
		"",
		now,
	].join("\n");
}

function autoDelegationMarkdown(state: { enabled: boolean; approved: boolean; invalid?: boolean }, target: string): string {
	return [
		`- 상태: **${state.enabled ? "켜짐" : "꺼짐"}**`,
		`- 팀 설정: ${state.approved ? "승인됨" : "승인되지 않음 — 자동 위임은 동작하지 않습니다."}`,
		...(state.invalid ? ["- 저장된 선택을 읽을 수 없어 꺼진 것으로 봅니다. 여기서 고르면 새 선택으로 고쳐집니다."] : []),
		"",
		autoDelegationDoc(state, target),
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
	if (stopIfStale(env, ui)) return false;
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
	/** A native pick is already a model and effort: no second effort page. Cancelling is not an invalid answer. */
	const native = async (title: string, id: RoleId, index: number): Promise<ModelEntry | "cancel" | "invalid"> => {
		const picked = await pickModel?.(title, slotCurrent(input.current?.roles[id], index));
		if (!picked) return "cancel";
		const made = entryForPick(picked, title);
		if ("error" in made) {
			ui.notify(made.error, "warning");
			return "invalid";
		}
		return made.entry;
	};
	for (const [index, id] of roles.entries()) {
		const title = roleTitle(id);
		let retry: FormRetry | undefined;
		let invalid = 0;
		while (true) {
			const answers = await form(roleForm(input, id, browse, index + 1, roles.length, retry));
			if (!answers) return cancelled();
			if (stopIfStale(env, ui)) return false;
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
			let primary: ModelEntry;
			if (choices.primary === BROWSE) {
				const picked = await native(`${title} · 주 모델`, id, 0);
				if (stopIfStale(env, ui)) return false;
				if (picked === "cancel" || picked === "invalid") continue;
				primary = picked;
			} else {
				const entry = await chooseEffort(id, "주 모델", choices.primary);
				if (stopIfStale(env, ui)) return false;
				if (!entry) return cancelled();
				primary = entry;
			}
			let fallback: ModelEntry | undefined;
			if (choices.fallback !== undefined) {
				let entry: ModelEntry | undefined;
				if (choices.fallback === BROWSE) {
					const picked = await native(`${title} · 폴백`, id, 1);
					if (stopIfStale(env, ui)) return false;
					if (picked === "cancel" || picked === "invalid") continue;
					entry = picked;
				} else if (choices.fallback !== primary.selector) {
					entry = await chooseEffort(id, "폴백", choices.fallback);
					if (stopIfStale(env, ui)) return false;
					if (!entry) return cancelled();
				}
				// The form says the same model in both slots means no fallback.
				if (entry && entry.selector !== primary.selector) fallback = entry;
			}
			selected[id] = { primary, ...(fallback ? { fallback } : {}), workers: choices.workers };
			break;
		}
	}
	let retry: FormRetry | undefined;
	for (let attempt = 0; attempt < FORM_TRIES; attempt++) {
		const answers = await form(commonSettingsForm(input, retry));
		if (!answers) return cancelled();
		if (stopIfStale(env, ui)) return false;
		const built = setupConfig(input, selected, answers);
		if ("errors" in built) {
			retry = { answers, errors: built.errors };
			continue;
		}
		const decision = await decideOwned(env, ui, state, { kind: "setup", summary: "역할별로 고른 팀", config: built.config }, {
			warnings: [...ctx.detection(env.activeTools).warnings, ...ctx.analysis.warnings, ...built.warnings, ...modelWarnings(built.config, ctx)],
			context: [...(firstApproval ? [AUTO_DISCLOSURE] : []), targetScopeLine(state.repo.root)].join("\n\n"),
		});
		if (!decision) return false;
		// No extra option was offered.
		if (decision.outcome !== "extra") notifySetup(ui, decision);
		return decision.outcome === "approved";
	}
	ui.notify(INVALID_FORM, "warning");
	return false;
}

interface SlotEditOptions {
	/** The project state the flow started from: the approval gate and the stale check use it. */
	state: ProjectState;
	/** One line above the approval; the first recommendation keeps its own summary. */
	summary: string;
	/** Disclosures that make the approval accurate (first-approval consent, cleanup, an invalid file being replaced). */
	context: string;
	/** Model warnings for the draft; the hub's one-slot edit has no analysis context to check against. */
	warnings?: (config: StormConfig) => readonly string[];
}

/**
 * One-slot model edits from the native picker: choose a slot of the draft, pick a model and effort, then approve the
 * ordinary diff. No form is opened. "계속 수정" keeps the draft (including earlier edits) and returns to the slot
 * list; cancelling the picker only returns to that list, while leaving it cancels the unsaved change. Only the exact
 * approval in `decideProposal` writes, and a stale config or an approval that is no longer there is refused there.
 */
async function editModelSlots(env: FlowEnv, ui: UiPort, base: StormConfig, opts: SlotEditOptions): Promise<boolean> {
	if (stopIfStale(env, ui)) return false;
	const pickModel = ui.pickModel?.bind(ui);
	if (!pickModel) return false;
	const kind: ProposalKind = isApproved(opts.state) ? "reselect" : "setup";
	let draft = base;
	while (true) {
		const slots = modelSlots(draft);
		if (!slots.length) {
			ui.notify("바꿀 모델 슬롯이 없습니다.", "warning");
			return false;
		}
		const choice = await ui.select("바꿀 모델 슬롯을 고르세요", [...slots.map((slot) => slot.label), CANCEL], {
			title: `${STORM_MARK} · ${EDIT_MODELS}`,
			markdown: [
				"### 지금 슬롯",
				...slots.map((slot) => {
					const now = slotCurrent(draft.roles[slot.roleId], slot.index);
					return visible(`- ${slot.label}: ${now ? [now.selector, ...(now.effort ? [now.effort] : [])].join(" · ") : "없음"}`);
				}),
			].join("\n"),
		});
		if (stopIfStale(env, ui)) return false;
		if (choice === undefined || choice === CANCEL) {
			ui.notify("모델·effort를 바꾸지 않았습니다.");
			return false;
		}
		const slot = slots.find((candidate) => candidate.label === choice);
		if (!slot) continue;
		const picked = await pickModel(slot.label, slotCurrent(draft.roles[slot.roleId], slot.index));
		if (stopIfStale(env, ui)) return false;
		// A cancelled picker is not an invalid pick: it goes back to the slot list.
		if (!picked) continue;
		const applied = applySlotPick(draft, slot, picked);
		if ("error" in applied) {
			ui.notify(applied.error, "warning");
			continue;
		}
		const decision = await decideOwned(env, ui, opts.state, { kind, summary: opts.summary, config: applied.config }, {
			...(opts.warnings ? { warnings: opts.warnings(applied.config) } : {}),
			...(opts.context ? { context: opts.context } : {}),
			extraOptions: [KEEP_EDITING],
		});
		if (!decision) return false;
		if (decision.outcome === "approved") {
			ui.notify(`모델·effort를 승인하고 저장했습니다(${shortHash(decision.hash)}).`);
			return true;
		}
		if (decision.outcome === "extra" && decision.extra === KEEP_EDITING) {
			// The reviewed draft carries forward, so another slot can be edited before the final approval.
			draft = applied.config;
			continue;
		}
		if (decision.outcome === "unchanged") {
			// A revert to the approved team is a draft change too; keeping the earlier edit here would save it later.
			draft = applied.config;
			ui.notify("지금 승인된 팀과 같은 모델·effort라 바뀐 것이 없습니다.");
			continue;
		}
		ui.notify(decision.outcome === "rejected" ? decision.reason : "모델·effort를 바꾸지 않았습니다.", decision.outcome === "rejected" ? "warning" : "info");
		return false;
	}
}

/**
 * Setup and re-setup, without the model: Storm computes the recommended team (what the user chose before carries
 * over) and shows it in the approval dialog. "승인" saves it; where the host draws forms, "역할별로 고르기" opens the
 * interview instead. The first approval on this machine turns automatic delegation on, after the team is saved.
 * Nothing reaches the main session.
 */
export async function setupFlow(env: FlowEnv, ui: UiPort): Promise<void> {
	const state = await loadProjectState(env);
	if (stopIfStale(env, ui)) return;
	/** Not "missing config": re-setup after a deleted config is still a later approval when an approval exists. */
	const firstApproval = await firstLocalApproval(state);
	const ctx = await prepareAnalysis(env, ui);
	const current = state.config.status === "ok" ? state.config.config : undefined;
	const priority = current ? teamPriority(current) : "balanced";
	const recs = ctx.recommend(priority);
	const proposed = recommendedConfig(recs, priority, current);
	const form = ui.form?.bind(ui);
	/** The native picker makes the one-slot edit possible without a form. */
	const canPick = ui.pickModel !== undefined;
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
				title: `${STORM_MARK} · 팀 제안`,
				markdown: checked.errors.map((error) => `- ${error}`).join("\n"),
			});
			if (stopIfStale(env, ui)) return;
			if (choice === PICK_BY_ROLE && (await pickByRole(env, ui, form, state, ctx, input, firstApproval))) {
				await activateAutoAfterApproval(env, state, ui, firstApproval);
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
		targetScopeLine(state.repo.root),
		cleanupNotice,
		state.config.status === "invalid" ? "이 세션의 팀 설정에 오류가 있어 새로 만듭니다." : "",
		form
			? ""
			: canPick
				? `이 환경에서는 역할별로 고르는 폼을 그릴 수 없습니다. 「${EDIT_MODELS}」으로 모델만 바꿀 수 있습니다.`
				: "이 환경에서는 역할별로 고르는 폼을 그릴 수 없습니다. 승인한 뒤 `/storm <요청>` 으로 바꾸세요.",
	]
		.filter(Boolean)
		.join("\n\n");
	const notesInfo: InfoLine[] = [];
	const notes = recommendationNotes(recs, proposed, notesInfo);
	const summary = current ? "Storm 추천 팀으로 다시 설정" : "Storm 추천 팀";
	const warnings = (config: StormConfig) => [...ctx.detection(env.activeTools).warnings, ...ctx.analysis.warnings, ...modelWarnings(config, ctx)];
	const extras = [...(canPick ? [EDIT_MODELS] : []), ...(form ? [PICK_BY_ROLE] : [])];
	const decision = await decideOwned(env, ui, state, { kind: "setup", summary, config: proposed }, {
		warnings: warnings(proposed),
		context,
		notes,
		notesInfo,
		...(extras.length ? { extraOptions: extras } : {}),
	});
	if (!decision) return;
	/** Both direct-edit routes approve through the ordinary dialog; only the exact approval turns auto on. */
	const edit = async (): Promise<void> => {
		if (await editModelSlots(env, ui, proposed, { state, summary, context, warnings })) {
			await activateAutoAfterApproval(env, state, ui, firstApproval);
		}
	};
	if (decision.outcome === "unchanged") {
		// The recommendation is the approved team, so there is nothing to approve; direct edit and role by role stay open.
		if (!form && !canPick) {
			notifySetup(ui, decision);
			return;
		}
		const options = [...(canPick ? [EDIT_MODELS] : []), ...(form ? [PICK_BY_ROLE] : []), MENU.close];
		const choice = await ui.select("Storm 추천 팀이 지금 승인된 팀과 같습니다", options, {
			title: `${STORM_MARK} · 팀 제안`,
			markdown: notes,
			info: notesInfo,
		});
		if (stopIfStale(env, ui)) return;
		if (choice === EDIT_MODELS) await edit();
		else if (choice === PICK_BY_ROLE && form && (await pickByRole(env, ui, form, state, ctx, input, firstApproval))) {
			await activateAutoAfterApproval(env, state, ui, firstApproval);
		}
		return;
	}
	if (decision.outcome !== "extra") {
		notifySetup(ui, decision);
		if (decision.outcome === "approved") await activateAutoAfterApproval(env, state, ui, firstApproval);
		return;
	}
	if (decision.extra === EDIT_MODELS) {
		await edit();
		return;
	}
	if (decision.extra === PICK_BY_ROLE && form && (await pickByRole(env, ui, form, state, ctx, input, firstApproval))) {
		await activateAutoAfterApproval(env, state, ui, firstApproval);
	}
}

/**
 * `/storm auto` and the hub entry: this native session's automatic-delegation consent, shown with its target and
 * changed only by an explicit choice. Turning on needs an approved team for the current target; turning off stays
 * possible while the config is stale, invalid or unapproved, and an explicit choice repairs an invalid saved file.
 * A host that cannot answer changes nothing.
 */
export async function autoDelegationFlow(env: FlowEnv, ui: UiPort): Promise<void> {
	const state = await loadProjectState(env);
	if (stopIfStale(env, ui)) return;
	const choice = await savedAutoChoice(state);
	const approved = state.config.status === "ok" && isApproved(state);
	const markdown = autoDelegationMarkdown({ enabled: choice === "on", approved, ...(choice === "invalid" ? { invalid: true } : {}) }, visible(state.repo.root));
	if (choice === "on") {
		const answer = await ui.select("자동 위임", [AUTO.disable, CANCEL], { title: "자동 위임", markdown });
		if (stopIfStale(env, ui)) return;
		if (answer !== AUTO.disable) {
			ui.notify("자동 위임을 그대로 둡니다.");
			return;
		}
		await saveAutoChoice(env, state, ui, false, "자동 위임을 껐습니다. 메인 세션이 프로젝트 작업을 직접 처리합니다.");
		return;
	}
	if (!approved) {
		// Enabling needs approval; an unreadable saved file can still be repaired to an explicit off.
		if (choice === "invalid") {
			const answer = await ui.select("자동 위임", [AUTO.disable, CANCEL], { title: "자동 위임", markdown });
			if (stopIfStale(env, ui)) return;
			if (answer !== AUTO.disable) {
				ui.notify("저장된 자동 위임 상태를 바꾸지 않았습니다.");
				return;
			}
			await saveAutoChoice(env, state, ui, false, "자동 위임을 꺼진 상태로 저장했습니다.");
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
	if (stopIfStale(env, ui)) return;
	if (answer === AUTO.disable) {
		await saveAutoChoice(env, state, ui, false, "자동 위임을 꺼진 상태로 저장했습니다.");
		return;
	}
	if (answer !== AUTO.enable) {
		ui.notify("자동 위임을 켜지 않았습니다.");
		return;
	}
	const current = await loadProjectState(env);
	if (stopIfStale(env, ui)) return;
	if (ownerMoved(state, current) || !isApproved(current)) {
		ui.notify("선택하는 사이 세션·작업 대상·팀 설정이나 승인이 바뀌어 자동 위임을 켜지 않았습니다. /storm 으로 다시 확인하세요.", "warning");
		return;
	}
	await saveAutoChoice(env, current, ui, true, "자동 위임을 켰습니다. 이 OMP 세션에서만 적용됩니다.");
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
		readQuotaMarks(state.sessionDir, now),
		lastRun(state.sessionDir),
		opts.trials ?? (config ? trialViews(env, state.sessionDir, config, now) : []),
		opts.user ? env.ompSettings?.() : undefined,
		opts.user
			? readStorage(state.sessionDir, join(env.agentDir, "sessions"), {
					...(env.ompSessionDir ? { ompSessionDir: env.ompSessionDir } : {}),
					cleanup: config?.cleanup === true,
				})
			: undefined,
		opts.user ? savedAutoChoice(state) : undefined,
	]);
	const usage = readUsage({ dbPath: env.statsDb ?? statsDbPath(), windowDays: 1, now });
	const run = env.activeRun?.();
	/** Only an active run has a phase; an absent callback or undefined means no phase is claimed. */
	const runPhase = run ? env.activePhase?.() : undefined;
	const agents = env.agents?.() ?? [];
	const ompAdvice = config && settings ? ompSettingsAdvice(config, settings) : [];
	const newerVersion = opts.user ? env.newerVersion?.() : undefined;
	const autoModeProblem = autoChoice === "on" && isApproved(state) ? env.autoModeProblem?.() : undefined;
	return {
		config: state.config,
		approval: state.approval,
		// An unset choice is off: an existing approved team gets no retroactive consent from this status.
		...(autoChoice !== undefined ? { autoDelegation: autoChoice === "on" ? (isApproved(state) && autoModeProblem === undefined ? "on" : "blocked") : "off" } : {}),
		...(autoModeProblem !== undefined ? { autoModeProblem } : {}),
		// The status never says where the project is.
		shadows: state.shadows.map(shadow => (shadow.scope === "project" ? { ...shadow, path: relative(root, shadow.path) } : shadow)),
		...(usage.status === "ok" ? { dataAsOf: usage.dataAsOf } : {}),
		...(storage ? { storage: formatStorage(storage, config?.cleanup === true), storageDetail: storageDetailLines(storage, config?.cleanup === true) } : {}),
		...(quota ? { quota } : {}),
		...(run ? { run } : {}),
		...(runPhase ? { runPhase } : {}),
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
 * storm tool's model view still passes none, so its payload is unchanged and names no path. The user's full status
 * ends by naming the one target this session's approval covers, so a target change is visible before acting.
 */
async function statusMarkdown(env: FlowEnv, opts: { quota: boolean }, info?: InfoLine[]): Promise<string> {
	const state = await loadProjectState(env);
	const view = await statusView(env, state, { quota: opts.quota, user: opts.quota });
	const body = renderStatus(view, env.now(), opts.quota ? "user" : "model", info);
	return opts.quota ? `${body}\n\n### 적용 범위\n- ${targetScopeLine(state.repo.root)}` : body;
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

/**
 * Only the team options a person may share: known config fields with no unknown fields, no session or target path,
 * no approval/hash/history/queue, no trial experiment and no required-check argv (which is target-bound and may name
 * a private path). The result is serialized as text; nothing here is read back by Storm.
 */
function exportableTeam(config: StormConfig): StormConfig {
	const roles: StormConfig["roles"] = {};
	for (const [id, role] of Object.entries(config.roles)) {
		roles[id] = {
			agent: role.agent,
			models: [...role.models],
			...(role.effort !== undefined ? { effort: role.effort } : {}),
			...(role.workers !== undefined ? { workers: typeof role.workers === "number" ? role.workers : { ...role.workers } } : {}),
			...(role.contextCap !== undefined ? { contextCap: role.contextCap } : {}),
		};
	}
	return {
		version: config.version,
		priority: config.priority,
		roles,
		isolation: config.isolation,
		...(config.budget
			? {
					budget: {
						perRunUsd: config.budget.perRunUsd,
						...(config.budget.warnAtUsd !== undefined ? { warnAtUsd: config.budget.warnAtUsd } : {}),
						onExceed: config.budget.onExceed,
					},
				}
			: {}),
		...(config.fallbackRole !== undefined ? { fallbackRole: config.fallbackRole } : {}),
		...(config.disabledRoles?.length ? { disabledRoles: [...config.disabledRoles] } : {}),
		...(config.contextCap !== undefined ? { contextCap: config.contextCap } : {}),
		...(config.cleanup !== undefined ? { cleanup: config.cleanup } : {}),
		...(config.docs !== undefined ? { docs: config.docs } : {}),
		...(config.rounds !== undefined ? { rounds: config.rounds } : {}),
	};
}

/**
 * `/storm export`: a human-only, explicit copy of this session's team options for sharing by hand. It writes nothing
 * and is not offered to the model or the storm tool; the text excludes approval, hashes, history, queues, credentials,
 * checks and every path. No import or inheritance exists on the other side.
 */
export async function exportFlow(env: FlowEnv, ui: UiPort): Promise<void> {
	const state = await loadProjectState(env);
	if (state.config.status !== "ok" || !isApproved(state)) {
		ui.notify("내보낼 승인된 팀 설정이 없습니다. /storm 에서 팀을 설정하고 승인한 뒤 다시 실행하세요.", "warning");
		return;
	}
	const template = serializeConfig(exportableTeam(state.config.config)).trimEnd();
	const markdown = [
		"### 복사용 팀 옵션",
		"",
		"- 모델·effort·워커·예산·실행 설정처럼 나눌 수 있는 값만 담았습니다.",
		"- 승인 기록, 설정 해시, 실행·시험 기록, 자동 위임 선택, 필수 검사 명령, 자격 증명, 세션·작업 대상 경로는 들어 있지 않습니다.",
		"- Storm은 이 내용을 읽어 들이거나 자동으로 물려받지 않습니다. 필요하면 사람이 직접 비교해 옮겨 적으세요.",
		"",
		"```json",
		template,
		"```",
	].join("\n");
	await ui.report("Storm 팀 템플릿", markdown);
}

const TRIAL = { adopt: "후보로 교체", keep: "지금 모델 유지", later: "나중에" } as const;

/**
 * Ended trials, one dialog each with the measured comparison in view. Keeping the current model only removes the
 * trial, so it saves at once; adopting the candidate puts a new primary model in the team and goes through the
 * approval dialog. Returns true when the config changed.
 */
async function offerTrialDecisions(env: FlowEnv, ui: UiPort, state: OkState, trials: readonly TrialView[]): Promise<boolean> {
	if (stopIfStale(env, ui)) return false;
	const config = state.config.config;
	for (const view of trials) {
		if (view.phase !== "ended" || !config.roles[view.trial.role]) continue;
		const { trial } = view;
		const choice = await ui.select(`시험 사용이 끝났습니다: ${roleTitle(trial.role)} 역할 · ${trial.model}`, [TRIAL.adopt, TRIAL.keep, TRIAL.later], {
			title: "시험 사용 결과",
			consent: [TRIAL.adopt, TRIAL.keep],
			markdown: renderTrial(view),
		});
		if (stopIfStale(env, ui)) return false;
		if (choice !== TRIAL.adopt && choice !== TRIAL.keep) continue;
		const built = buildTrialEnd(config, trial, choice === TRIAL.adopt);
		if ("error" in built) continue;
		if (choice === TRIAL.keep) {
			if (stopIfStale(env, ui)) return false;
			if (ownerMoved(state, await loadProjectState(env))) {
				ui.notify(MOVED, "warning");
				return false;
			}
			// No new model enters the team and the shadows are the approved ones, so there is nothing more to show.
			const hash = await saveOwned(env, ui, state, built.config, { shadowedAgents: state.shadows });
			if (hash === undefined) return false;
			ui.notify(`${built.summary}. 저장했습니다(${shortHash(hash)}).`);
			return true;
		}
		const ctx = await prepareAnalysis(env, ui);
		const decision = await decideOwned(env, ui, state, { kind: "reselect", summary: built.summary, config: built.config }, {
			warnings: modelWarnings(built.config, ctx),
			context: targetScopeLine(state.repo.root),
		});
		if (!decision) return false;
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
	if (stopIfStale(env, ui)) return;
	const current = state.config.status === "ok" ? state.config.config : undefined;
	const option = await runRollback(ui, {
		options,
		...(current ? { current } : {}),
		scope: targetScopeLine(state.repo.root),
		stillOwner: env.stillOwner,
	});
	if (stopIfStale(env, ui)) return;
	if (!option) {
		ui.notify("되돌리지 않았습니다.");
		return;
	}
	if (stopIfStale(env, ui)) return;
	if (ownerMoved(state, await loadProjectState(env))) {
		ui.notify(MOVED, "warning");
		return;
	}
	try {
		await assertSessionStoreSafe(state.sessionDir, state.repo.root);
	} catch (error) {
		ui.notify(`되돌리지 않았습니다: ${error instanceof Error ? error.message : String(error)}`, "warning");
		return;
	}
	if (stopIfStale(env, ui)) return;
	await writeConfig(state.sessionDir, option.config);
	ui.notify(`이전에 승인한 팀 설정으로 되돌렸습니다(${shortHash(option.hash)}).`);
}

const MENU = {
	resume: "끝나지 않은 실행 이어 가기",
	setup: "팀 다시 설정",
	models: "모델 점검",
	agents: "서브에이전트",
	status: "전체 현황",
	rollback: "이전 승인으로 되돌리기",
	reset: "초기화",
	close: "닫기",
} as const;

/** The hub's automatic-delegation entry says whether it is on or off; both open the same flow. */
const AUTO_MENU = { on: "자동 위임 · 켜짐", off: "자동 위임 · 꺼짐" } as const;

/** This session's config does not validate: every error in view, and the ways out. Setup starts only when picked. */
async function invalidFlow(env: FlowEnv, ui: UiPort, state: ProjectState, errors: readonly string[]): Promise<void> {
	const rollbacks = await rollbackOptions(state);
	if (stopIfStale(env, ui)) return;
	// The errors quote the file (keys, values), so each one is shown as a single line.
	const markdown = [
		...errors.map(error => `- ${visible(error)}`),
		"",
		`이 오류가 있는 동안 Storm 스폰은 막힙니다. \`/storm\`에서 팀을 새로 설정하거나 이전 승인으로 되돌리세요. 예전 작업 트리의 \`.omp/storm/\`은 읽지도 고치지도 않습니다.`,
	].join("\n");
	const choice = await ui.select("이 세션의 팀 설정에 오류가 있습니다", [...(rollbacks.length ? [MENU.rollback] : []), MENU.setup, CANCEL], {
		title: `${STORM_MARK} · 팀 설정 오류`,
		markdown,
	});
	if (stopIfStale(env, ui)) return;
	if (choice === MENU.rollback) await rollbackFlow(env, ui, state, rollbacks);
	else if (choice === MENU.setup) await setupFlow(env, ui);
}

/**
 * A valid team this session holds no approval for at the current target: the target changed, the session config
 * changed without an approval, or the approval was cleared. The dialog shows everything "승인" covers, against the
 * latest approval for this target.
 */
async function unapprovedFlow(env: FlowEnv, ui: UiPort, state: OkState): Promise<void> {
	const { config, hash, warnings } = state.config;
	const [records, rollbacks, ctx, firstApproval] = await Promise.all([state.store.list(), rollbackOptions(state), prepareAnalysis(env, ui), firstLocalApproval(state)]);
	if (stopIfStale(env, ui)) return;
	// A snapshot that no longer validates is not diffed against: the whole team is shown instead.
	const previous = records[0] ? await approvedSnapshot(state, records[0].configHash) : undefined;
	const info: InfoLine[] = [];
	const markdown = renderApproval(undefined, previous, config, {
		context: [...(firstApproval ? [AUTO_DISCLOSURE] : []), targetScopeLine(state.repo.root)].join("\n\n"),
		warnings: [...warnings, ...modelWarnings(config, ctx)],
		shadows: state.shadows,
	}, info);
	const choice = await ui.select("이 팀 설정을 승인할까요?", [APPROVE, ...(rollbacks.length ? [MENU.rollback] : []), MENU.setup, CANCEL], {
		title: `승인할 팀 설정 · ${shortHash(hash)}`,
		consent: [APPROVE],
		markdown,
		info,
	});
	if (stopIfStale(env, ui)) return;
	if (choice === MENU.rollback) return rollbackFlow(env, ui, state, rollbacks);
	if (choice === MENU.setup) return setupFlow(env, ui);
	if (choice !== APPROVE) {
		ui.notify("승인하지 않았습니다. Storm 스폰은 계속 막힙니다.");
		return;
	}
	// The live owner is checked before the captured env is reloaded; the reload alone would still return A.
	if (stopIfStale(env, ui)) return;
	if (ownerMoved(state, await loadProjectState(env))) {
		ui.notify("승인하는 사이 세션·작업 대상·팀 설정이나 가림 정의가 바뀌어 승인하지 않았습니다. /storm 으로 다시 확인하세요.", "warning");
		return;
	}
	if (stopIfStale(env, ui)) return;
	// The session's file is approved as it is; Storm does not rewrite it. The auto choice is initialized only after this succeeds.
	try {
		await assertSessionStoreSafe(state.sessionDir, state.repo.root);
	} catch (error) {
		ui.notify(`승인하지 않았습니다: ${error instanceof Error ? error.message : String(error)}`, "warning");
		return;
	}
	if (stopIfStale(env, ui)) return;
	await state.store.approve({ configHash: hash, config, scope: { shadowedAgents: state.shadows } });
	ui.notify(`승인했습니다(${shortHash(hash)}).`);
	await activateAutoAfterApproval(env, state, ui, firstApproval);
}

/**
 * Bare `/storm`: sets up this session without a config, shows the errors of an invalid one, asks for approval while
 * something is unapproved for the current target, and otherwise opens the menu with the status in view. Returns true
 * when the user reset this session's Storm data.
 */
export async function hubFlow(env: FlowEnv, ui: UiPort): Promise<boolean> {
	let state = await loadProjectState(env);
	if (stopIfStale(env, ui)) return false;
	if (state.config.status === "missing") {
		await setupFlow(env, ui);
		return false;
	}
	if (state.config.status === "invalid") {
		await invalidFlow(env, ui, state, state.config.errors);
		return false;
	}
	if (!isApproved(state)) {
		await unapprovedFlow(env, ui, state as OkState);
		return false;
	}
	let trials: TrialView[] | undefined = await trialViews(env, state.sessionDir, state.config.config, env.now());
	if (await offerTrialDecisions(env, ui, state as OkState, trials)) {
		// The panel must show the config as it is now.
		state = await loadProjectState(env);
		trials = undefined;
	}
	// The trial dialog may already have reported a switch; never build or act on its menu afterwards.
	if (!env.stillOwner()) return false;
	const [view, rollbacks, resume, autoChoice] = await Promise.all([
		statusView(env, state, { quota: false, user: true, ...(trials ? { trials } : {}) }),
		rollbackOptions(state),
		env.startRun ? findResumeCandidate(state.sessionDir, { repoId: state.repo.repoId, root: state.repo.root }) : undefined,
		savedAutoChoice(state),
	]);
	const options: string[] = [...(resume ? [MENU.resume] : []), MENU.setup, ...(ui.pickModel ? [EDIT_MODELS] : []), MENU.models];
	// The status view already read this session's agents; do not query the same trusted list again.
	if (view.agents?.length) options.push(MENU.agents);
	options.push(autoChoice === "on" ? AUTO_MENU.on : AUTO_MENU.off);
	if (rollbacks.length) options.push(MENU.rollback);
	options.push(MENU.reset, MENU.status, MENU.close);
	// The trusted candidate from above, not a second lookup, decides whether the state says "resume".
	const info: InfoLine[] = [];
	const brief = renderStatusBrief(view, env.now(), info, resume !== undefined);
	const choice = await ui.select("Storm 메뉴", options, {
		title: "Storm 현황",
		markdown: [brief, resume ? resumeRunLine(resume) : undefined, view.storage, `- ${targetScopeLine(state.repo.root)}`].filter(Boolean).join("\n\n"),
		...(info.length ? { info } : {}),
	});
	if (stopIfStale(env, ui)) return false;
	if (choice === MENU.resume && resume) await startResume(env, ui, resume);
	else if (choice === MENU.setup) await setupFlow(env, ui);
	else if (choice === EDIT_MODELS) {
		// The approved team as it is, never a recommendation: this change only replaces the picked slot.
		await editModelSlots(env, ui, (state as OkState).config.config, { state, summary: EDIT_MODELS, context: targetScopeLine(state.repo.root) });
	} else if (choice === MENU.models) await modelsFlow(env, ui);
	else if (choice === MENU.agents) await agentsFlow(env, ui);
	else if (choice === AUTO_MENU.on || choice === AUTO_MENU.off) await autoDelegationFlow(env, ui);
	else if (choice === MENU.rollback) await rollbackFlow(env, ui, state, rollbacks);
	else if (choice === MENU.reset) return resetFlow(env, ui);
	else if (choice === MENU.status) await statusFlow(env, ui);
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
	if (stopIfStale(env, ui)) return;
	const started = await start(spec.spec);
	if (!started.ok) ui.notify(`Storm 실행을 시작하지 못했습니다: ${started.reason}`, "warning");
}

/**
 * `/storm …` when the classifier reads the request as continuing the run that stopped unfinished: no menu, the
 * same start the menu's first option makes. `said` is what the user typed, kept as a note beside the old request.
 */
export async function resumeFlow(env: FlowEnv, ui: UiPort, said?: string): Promise<void> {
	const state = await loadProjectState(env);
	const resume = await findResumeCandidate(state.sessionDir, { repoId: state.repo.repoId, root: state.repo.root });
	if (!resume) {
		ui.notify("이어 갈 실행이 없습니다.");
		return;
	}
	if (!env.startRun) return;
	if (stopIfStale(env, ui)) return;
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

/** Whether a directory exists and holds at least one entry; absence is not an error. */
async function hasEntries(dir: string): Promise<boolean> {
	try {
		return (await readdir(dir)).length > 0;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

/**
 * `/storm reset`: deletes only this native session's Storm store below the profile, after one exact "초기화". It
 * never reads, edits or removes the target's `.omp/storm/`, another session's store, the OMP transcript, project
 * files or omp settings; the session-owned config, approvals, run history, trials, quota marks, resume marker and
 * automatic-delegation choice all go together. Refuses while this session has an active run and holds the session
 * lease across the deletion so a run cannot start under it. Returns true when something was deleted.
 */
export async function resetFlow(env: FlowEnv, ui: UiPort): Promise<boolean> {
	const state = await loadProjectState(env);
	const expected = sessionStoreDir(env.agentDir, env.sessionId);
	if (state.sessionDir !== expected) {
		ui.notify("이 세션의 Storm 저장 위치를 확인하지 못해 초기화하지 않았습니다.", "warning");
		return false;
	}
	if (stopIfStale(env, ui)) return false;
	/** Fast check inside this process; the session lease below closes the cross-process race. */
	const blockedByRun = (): boolean => {
		const running = env.activeRun?.();
		if (running) ui.notify(`Storm 실행(${running.runId})이 진행 중이라 초기화하지 않습니다. 실행이 끝난 뒤 다시 하세요.`, "warning");
		return running !== undefined;
	};
	if (blockedByRun()) return false;
	const sessionDir = state.sessionDir;
	if (!(await hasEntries(sessionDir))) {
		ui.notify("초기화할 Storm 세션 데이터가 없습니다.");
		return false;
	}
	const [hasConfig, approvals, autoChoice, runs, index] = await Promise.all([
		pathExists(configPath(sessionDir)),
		state.store.list(),
		savedAutoChoice(state),
		countJson(runsDir(sessionDir)),
		// A damaged index must not block removing the session it belongs to; the whole store goes anyway.
		readRunIndex(sessionDir).catch(() => []),
	]);
	const c = state.config;
	const configLine =
		c.status === "ok"
			? `팀 설정 ${shortHash(c.hash)}(${state.approval ? "승인됨" : "미승인"})`
			: c.status === "invalid"
				? "팀 설정(오류)"
				: "팀 설정 없음";
	const lines = ["### 지울 것 (이 OMP 세션만)"];
	if (hasConfig) lines.push(`- ${configLine}`);
	if (approvals.length) lines.push(`- 이 대상의 승인 기록 ${approvals.length}건과 승인한 팀 설정 사본`);
	if (runs) lines.push(`- 실행 기록 ${runs}개`);
	if (index.length) lines.push(`- 실행 요약 색인 ${index.length}줄`);
	lines.push("- 시험 사용 카운터, 쿼터 소진 표시, 이어 가기 표시");
	if (autoChoice !== "unset") lines.push("- 자동 위임 선택");
	lines.push(
		"",
		"### 그대로 두는 것",
		"- 같은 프로필의 다른 OMP 세션 Storm 데이터",
		"- 이 작업 트리의 예전 `.omp/storm/` 파일(읽지도 지우지도 않습니다)",
		"- OMP 대화 기록과 프로젝트 파일, omp 설정과 API 키",
		"",
		`대상: ${visible(state.repo.root)}`,
	);
	const choice = await ui.select("이 Storm 세션의 팀 설정과 기록을 지울까요? 되돌릴 수 없습니다.", ["초기화", CANCEL], {
		title: "Storm 초기화",
		markdown: lines.join("\n"),
		consent: ["초기화"],
	});
	if (stopIfStale(env, ui)) return false;
	if (choice !== "초기화") {
		ui.notify("초기화하지 않았습니다.");
		return false;
	}
	if (blockedByRun()) return false;
	// One owner per profile+session: no sibling session and no new run can be attributed to what is being removed.
	const ownership = await acquireSessionLease({ sessionDir, sessionId: env.sessionId, runId: "reset" });
	if (!ownership.ok) {
		ui.notify(`Storm 초기화를 하지 않았습니다: ${ownership.reason}`, "warning");
		return false;
	}
	try {
		// The dialog's owner and the lease are both held: a switch from here must not delete the warmed store.
		if (stopIfStale(env, ui)) return false;
		const fresh = await loadProjectState(env);
		if (stopIfStale(env, ui)) return false;
		if (ownerMoved(state, fresh)) {
			ui.notify(MOVED, "warning");
			return false;
		}
		try {
			await assertSessionStoreSafe(sessionDir, fresh.repo.root);
		} catch (error) {
			ui.notify(`Storm 초기화를 하지 않았습니다: ${error instanceof Error ? error.message : String(error)}`, "warning");
			return false;
		}
		// Recheck after the awaited guard, immediately before the only destructive call.
		if (stopIfStale(env, ui)) return false;
		await rm(sessionDir, { recursive: true, force: true });
		ui.notify("이 OMP 세션의 Storm 팀 설정과 기록을 지웠습니다. 다른 세션과 이 작업 트리의 예전 `.omp/storm/` 파일은 그대로입니다. 다시 쓰려면 /storm 으로 팀을 설정하세요.");
		return true;
	} finally {
		await ownership.lease.release();
	}
}
