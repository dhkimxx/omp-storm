import { pickEffort, ROLE_EFFORT } from "../recommend/recommend.ts";
import { formatModelEntry, parseModelEntry } from "../selector.ts";
import {
	type ApprovalScope,
	type BudgetConfig,
	type Candidate,
	EFFORTS,
	type Effort,
	type InterviewInput,
	type InterviewResult,
	type Priority,
	type RoleConfig,
	type RoleRecommendation,
	type ShadowInfo,
	type StormConfig,
	type TrialConfig,
	type UiPort,
} from "../types.ts";
import {
	budgetText,
	fallbackOf,
	fallbackText,
	int,
	type PickedModel,
	priorityLabel,
	type RolePick,
	renderAnalysis,
	renderConfigDiff,
	renderDetection,
	renderEvidence,
	renderShadows,
	renderTeam,
	speedText,
	usd,
} from "./render.ts";

const PRIORITY_OPTIONS: Array<[string, Priority]> = [
	["균형", "balanced"],
	["품질 우선", "quality"],
	["비용 우선", "cost"],
	["속도 우선", "speed"],
	["쿼터 우선", "quota"],
];
const BACK = "뒤로";
const CANCEL = "취소";
const CUSTOM = "직접 입력";
const EVIDENCE = "근거 보기";
const STEPWISE = "단계별로 고르기";
const ACCEPT_ALL = "전체 수락";
const NO_FALLBACK = "폴백 없음";
const NEXT = "다음";
export const APPROVE_SAVE = "승인 후 저장";
const BLOCK = "차단";
const RECOMMENDED = "★ 추천 ";
const CURRENT = " (현재)";
const MAX_OPTIONS = 5;

type Step = "summary" | "priority" | "overview" | "models" | "fallbacks" | "efforts" | "settings" | "final";

export function buildConfig(
	recs: RoleRecommendation[],
	picks: Record<string, RolePick>,
	opts: {
		priority: Priority;
		parallelism: number;
		isolation: StormConfig["isolation"];
		contract: StormConfig["contract"];
		budget?: BudgetConfig;
		/** Workers per role id; roles not listed get `defaultWorkers`. */
		workers?: Record<string, number>;
		/** undefined → implementer when present; null → non-Storm agents are blocked during a run. */
		fallbackRole?: string | null;
		/** Kept for roles that still exist. */
		trials?: TrialConfig[];
	},
): StormConfig {
	const roles: Record<string, RoleConfig> = {};
	for (const rec of recs) {
		const pick = picks[rec.role.id];
		if (!pick) continue;
		// Each model carries its own effort suffix, so the role-level default stays unset.
		const models = [formatModelEntry(pick.primary)];
		if (pick.fallback) models.push(formatModelEntry(pick.fallback));
		roles[rec.role.id] = {
			agent: rec.role.agent,
			models,
			workers: opts.workers?.[rec.role.id] ?? defaultWorkers(rec.role.id),
		};
	}
	const config: StormConfig = {
		version: 1,
		priority: opts.priority,
		roles,
		parallelism: opts.parallelism,
		isolation: opts.isolation,
		contract: opts.contract,
		runtime: "omp",
	};
	if (opts.budget) config.budget = opts.budget;
	const fallback = opts.fallbackRole === undefined ? "implementer" : opts.fallbackRole;
	if (fallback !== null && Object.hasOwn(roles, fallback)) config.fallbackRole = fallback;
	const trials = opts.trials?.filter((t) => Object.hasOwn(roles, t.role));
	if (trials?.length) config.trials = structuredClone(trials);
	return config;
}

export function deriveScope(config: StormConfig, shadows: ShadowInfo[]): ApprovalScope {
	const providers = new Set<string>();
	for (const r of Object.values(config.roles)) {
		for (const m of r.models) {
			const selector = parseModelEntry(m).selector;
			const i = selector.indexOf("/");
			providers.add(i < 0 ? selector : selector.slice(0, i));
		}
	}
	const scope: ApprovalScope = {
		providers: [...providers].sort(),
		roles: structuredClone(config.roles),
		runtime: config.runtime,
		shadowedAgents: [...shadows],
	};
	if (config.budget) scope.budget = { ...config.budget };
	if (config.fallbackRole !== undefined) scope.fallbackRole = config.fallbackRole;
	if (config.trials) scope.trials = structuredClone(config.trials);
	return scope;
}

/** Explorers fan out over independent reads; other roles default to one worker. */
export function defaultWorkers(roleId: string): number {
	return roleId === "explorer" ? 2 : 1;
}

/** Interview start values from the current config. A v0.2 config (roles carry workers) without fallbackRole was blocked on purpose. */
function initialFallback(current: StormConfig | undefined): string | null | undefined {
	if (!current) return undefined;
	if (current.fallbackRole !== undefined) return current.fallbackRole;
	return Object.values(current.roles).some((r) => r.workers !== undefined) ? null : undefined;
}

function picked(selector: string, label: string, effort: Effort | null | undefined): PickedModel {
	return effort ? { selector, label, effort } : { selector, label };
}

/** Recommended candidate first, then the rest in rank order, at most five. */
function ranked(rec: RoleRecommendation): Candidate[] {
	const chosen = rec.candidates[rec.chosenIndex];
	const rest = rec.candidates.filter((c) => c !== chosen);
	return (chosen ? [chosen, ...rest] : rest).slice(0, MAX_OPTIONS);
}

function candidateLabel(c: Candidate, recommended: boolean, current: boolean): string {
	return `${recommended ? RECOMMENDED : ""}${c.label} (${c.selector}) · 지능 ${int(c.int.value)} · ${speedText(c.speed)} · ${usd(c.referenceUsd)}${c.validated ? " · 사용 검증" : ""}${current ? CURRENT : ""}`;
}

interface EffortQuestion {
	rec: RoleRecommendation;
	slot: "primary" | "fallback";
	model: PickedModel;
	efforts: Effort[];
}

export async function runSetupInterview(ui: UiPort, input: InterviewInput): Promise<InterviewResult> {
	/** Supported efforts in EFFORTS order; none when the model does not check out. */
	const supported = (selector: string): Effort[] => {
		const r = input.checkModel(selector);
		return r.ok ? EFFORTS.filter((e) => r.efforts.includes(e)) : [];
	};
	const recommendedEffort = (rec: RoleRecommendation, efforts: readonly Effort[]): Effort | null =>
		pickEffort(ROLE_EFFORT[rec.role.id], efforts);
	const recommendedModel = (rec: RoleRecommendation, c: Candidate): PickedModel =>
		picked(c.selector, c.label, recommendedEffort(rec, supported(c.selector)));
	const recommendedFallback = (rec: RoleRecommendation, primary: string): PickedModel | undefined => {
		const fb = fallbackOf(rec, primary);
		return fb && recommendedModel(rec, fb);
	};
	const recommendedPicks = (list: RoleRecommendation[]): Record<string, RolePick> => {
		const out: Record<string, RolePick> = {};
		for (const rec of list) {
			const c = rec.candidates[rec.chosenIndex];
			if (!c) continue;
			const fallback = recommendedFallback(rec, c.selector);
			out[rec.role.id] = fallback ? { primary: recommendedModel(rec, c), fallback } : { primary: recommendedModel(rec, c) };
		}
		return out;
	};
	/** Primary and fallback models that have effort levels to choose, in role order. */
	const effortQuestions = (): EffortQuestion[] =>
		recs.flatMap((rec) => {
			const pick = picks[rec.role.id];
			if (!pick) return [];
			const out: EffortQuestion[] = [];
			for (const slot of ["primary", "fallback"] as const) {
				const model = pick[slot];
				const efforts = model ? supported(model.selector) : [];
				if (model && efforts.length) out.push({ rec, slot, model, efforts });
			}
			return out;
		});

	let step: Step = "summary";
	let priority = input.priority;
	let recs = input.recommendations;
	let picks = recommendedPicks(recs);
	let parallelism = input.defaults.parallelism;
	const isolation = input.defaults.isolation;
	let contract = input.defaults.contract;
	let budget: BudgetConfig | undefined = input.current?.config.budget;
	const workers: Record<string, number> = {};
	for (const [id, r] of Object.entries(input.current?.config.roles ?? {})) if (r.workers !== undefined) workers[id] = r.workers;
	let fallbackRole = initialFallback(input.current?.config);
	const trials = input.current?.config.trials;
	/** Role index in chapters 1 and 2, question index in chapter 3. */
	let at = 0;
	const cancelled = (where: Step): InterviewResult => ({ status: "cancelled", at: where });
	const config = () =>
		buildConfig(recs, picks, {
			priority,
			parallelism,
			isolation,
			contract,
			workers,
			...(fallbackRole !== undefined ? { fallbackRole } : {}),
			...(budget ? { budget } : {}),
			...(trials ? { trials } : {}),
		});
	const workersOf = (id: string) => workers[id] ?? defaultWorkers(id);
	/** Last question of chapter 3, or the last role of chapter 2 when no model has effort levels. */
	const backFromSettings = () => {
		const n = effortQuestions().length;
		if (n) {
			step = "efforts";
			at = n - 1;
		} else {
			step = "fallbacks";
			at = recs.length - 1;
		}
	};

	for (;;) {
		switch (step) {
			case "summary": {
				ui.report("Storm 탐지 요약", `${renderDetection(input.detection, Date.now())}\n\n${renderAnalysis(input.analysis, Date.now())}`);
				const a = await ui.select("Storm 팀 설정을 시작할까요?", ["계속", CANCEL]);
				if (a !== "계속") return cancelled(step);
				step = "priority";
				break;
			}
			case "priority": {
				const a = await ui.select(`최적화 우선순위 (현재: ${priorityLabel(priority)})`, [
					...PRIORITY_OPTIONS.map(([l]) => l),
					BACK,
				]);
				if (a === BACK) {
					step = "summary";
					break;
				}
				const found = PRIORITY_OPTIONS.find(([l]) => l === a);
				if (!found) return cancelled(step);
				if (found[1] !== priority) {
					priority = found[1];
					recs = input.rerecommend(priority);
					picks = recommendedPicks(recs);
				}
				step = "overview";
				break;
			}
			case "overview": {
				const draft = config();
				const resolvedWorkers: Record<string, number> = {};
				for (const rec of recs) resolvedWorkers[rec.role.id] = workersOf(rec.role.id);
				ui.report(
					"추천 팀 구성",
					renderTeam(recs, picks, {
						parallelism,
						isolation,
						contract,
						workers: resolvedWorkers,
						...(budget ? { budget } : {}),
						...(draft.fallbackRole !== undefined ? { fallbackRole: draft.fallbackRole } : {}),
						...(draft.trials ? { trials: draft.trials } : {}),
					}),
				);
				const a = await ui.select("추천 구성을 어떻게 할까요?", [STEPWISE, ACCEPT_ALL, EVIDENCE, BACK, CANCEL]);
				if (a === STEPWISE) {
					step = "models";
					at = 0;
				} else if (a === ACCEPT_ALL) {
					const missing = recs.filter((r) => !picks[r.role.id]).map((r) => r.role.title);
					if (missing.length) {
						ui.notify(`후보 없는 역할이 있습니다: ${missing.join(", ")}. 단계별로 고르기에서 직접 입력하세요.`, "warning");
						break;
					}
					step = "final";
				} else if (a === EVIDENCE) ui.report("추천 근거", renderEvidence(recs));
				else if (a === BACK) step = "priority";
				else return cancelled(step);
				break;
			}
			case "models": {
				const rec = recs[at];
				if (!rec) {
					step = "fallbacks";
					at = 0;
					break;
				}
				const id = rec.role.id;
				const pick = picks[id];
				const list = ranked(rec);
				const labels = list.map((c, i) =>
					candidateLabel(c, i === 0 && c === rec.candidates[rec.chosenIndex], c.selector === pick?.primary.selector),
				);
				const a = await ui.select(`1/4 작업별 모델 · ${rec.role.title}`, [...labels, CUSTOM, EVIDENCE, BACK]);
				if (a === undefined) return cancelled(step);
				if (a === EVIDENCE) {
					ui.report(`추천 근거 · ${rec.role.title}`, renderEvidence([rec]));
					break;
				}
				if (a === BACK) {
					if (at === 0) step = "overview";
					else at--;
					break;
				}
				let next: PickedModel;
				if (a === CUSTOM) {
					const m = await askModel(ui, input, `${rec.role.title} 모델 직접 입력`);
					if (!m) return cancelled(step);
					next = picked(m.selector, m.label, m.effort ?? recommendedEffort(rec, supported(m.selector)));
				} else {
					const c = list[labels.indexOf(a)];
					if (!c) return cancelled(step);
					next = recommendedModel(rec, c);
				}
				// Re-picking the same model keeps its effort and fallback; a new primary gets the recommended fallback.
				if (pick?.primary.selector !== next.selector) {
					const fallback = recommendedFallback(rec, next.selector);
					picks[id] = fallback ? { primary: next, fallback } : { primary: next };
				}
				at++;
				break;
			}
			case "fallbacks": {
				const rec = recs[at];
				if (!rec) {
					ui.report(
						"3/4 effort",
						"모델마다 지원하는 effort만 보여 줍니다. effort가 높을수록 생각 토큰을 더 써서 비용과 시간이 늘어납니다. " +
							"토큰당 가격은 effort와 관계없이 같습니다. effort를 지원하지 않는 모델은 묻지 않습니다.",
					);
					step = "efforts";
					at = 0;
					break;
				}
				const id = rec.role.id;
				const pick = picks[id];
				if (!pick) {
					// Chapter 1 always picks a primary; a role without one has nothing to fall back from.
					at++;
					break;
				}
				const primary = pick.primary.selector;
				const best = fallbackOf(rec, primary);
				const list = [...(best ? [best] : []), ...rec.candidates.filter((c) => c.selector !== primary && c !== best)];
				const labels = list.map((c) => candidateLabel(c, c === best, c.selector === pick.fallback?.selector));
				const a = await ui.select(`2/4 폴백 모델 · ${rec.role.title} (주 모델: ${pick.primary.label})`, [
					...labels,
					NO_FALLBACK,
					CUSTOM,
					BACK,
				]);
				if (a === undefined) return cancelled(step);
				if (a === BACK) {
					if (at === 0) {
						step = "models";
						at = recs.length - 1;
					} else at--;
					break;
				}
				if (a === NO_FALLBACK) {
					picks[id] = { primary: pick.primary };
					at++;
					break;
				}
				let next: PickedModel;
				if (a === CUSTOM) {
					const m = await askModel(ui, input, `${rec.role.title} 폴백 모델 직접 입력`, (s) =>
						s === primary ? "주 모델과 다른 모델을 입력하세요." : undefined,
					);
					if (!m) return cancelled(step);
					next = picked(m.selector, m.label, m.effort ?? recommendedEffort(rec, supported(m.selector)));
				} else {
					const c = list[labels.indexOf(a)];
					if (!c) return cancelled(step);
					next = recommendedModel(rec, c);
				}
				if (pick.fallback?.selector !== next.selector) picks[id] = { primary: pick.primary, fallback: next };
				at++;
				break;
			}
			case "efforts": {
				const q = effortQuestions()[at];
				if (!q) {
					step = "settings";
					break;
				}
				const recommended = recommendedEffort(q.rec, q.efforts);
				const labels = q.efforts.map(
					(e) => `${e}${e === recommended ? " (추천)" : ""}${e === q.model.effort && e !== recommended ? CURRENT : ""}`,
				);
				const a = await ui.select(
					`3/4 effort · ${q.rec.role.title} · ${q.model.label} (${q.slot === "primary" ? "주 모델" : "폴백"})`,
					[...labels, BACK],
				);
				if (a === undefined) return cancelled(step);
				if (a === BACK) {
					if (at === 0) {
						step = "fallbacks";
						at = recs.length - 1;
					} else at--;
					break;
				}
				const effort = q.efforts[labels.indexOf(a)];
				if (!effort) return cancelled(step);
				q.model.effort = effort;
				at++;
				break;
			}
			case "settings": {
				const options = [
					NEXT,
					`병렬도: ${parallelism}`,
					`워커 수: ${recs.map((r) => `${r.role.title} ${workersOf(r.role.id)}`).join(" · ")}`,
					`실행 중 다른 에이전트: ${fallbackText(config().fallbackRole)}`,
					`실행 계약: ${contract}`,
					`예산: ${budget ? budgetText(budget) : "없음"}`,
					BACK,
				];
				const a = await ui.select("4/4 실행 설정", options);
				const choice = a === undefined ? -1 : options.indexOf(a);
				if (choice === 0) step = "final";
				else if (choice === 1) {
					const n = await askNumber(ui, "병렬도 (1-16)", String(parallelism), (v) =>
						Number.isInteger(v) && v >= 1 && v <= 16 ? undefined : "1에서 16 사이 정수를 입력하세요.",
					);
					if (n === undefined) return cancelled(step);
					parallelism = n;
				} else if (choice === 2) {
					const r = await editWorkers(ui, recs, workersOf);
					if (r === undefined) return cancelled(step);
					if (r !== BACK) workers[r.role] = r.workers;
				} else if (choice === 3) {
					const r = await editFallback(ui, recs, config().fallbackRole);
					if (r === undefined) return cancelled(step);
					if (r !== BACK) fallbackRole = r;
				} else if (choice === 4) {
					const c = await ui.select(`실행 계약 (현재: ${contract})`, ["workflowz", "orchestrate", BACK]);
					if (c === "workflowz" || c === "orchestrate") contract = c;
					else if (c !== BACK) return cancelled(step);
				} else if (choice === 5) {
					const b = await askBudget(ui, budget);
					if (b === undefined) return cancelled(step);
					budget = b === null ? undefined : b;
				} else if (choice === 6) backFromSettings();
				else return cancelled(step);
				break;
			}
			case "final": {
				const next = config();
				ui.report("저장할 설정", renderConfigDiff(input.current?.config, next) + renderShadows(input.shadows));
				const a = await ui.select("이 구성을 승인하고 저장할까요?", [APPROVE_SAVE, BACK, CANCEL]);
				if (a === APPROVE_SAVE) return { status: "approved", config: next, scope: deriveScope(next, input.shadows) };
				if (a === BACK) {
					step = "overview";
					break;
				}
				return cancelled(step);
			}
		}
	}
}

/** A typed model that checks out; a typed ":<effort>" suffix is kept when the model supports it. undefined when cancelled. */
async function askModel(
	ui: UiPort,
	input: InterviewInput,
	title: string,
	reject?: (selector: string) => string | undefined,
): Promise<{ selector: string; label: string; effort?: Effort } | undefined> {
	for (;;) {
		const s = (await ui.input(title, "provider/id"))?.trim();
		if (s === undefined) return undefined;
		const typed = parseModelEntry(s);
		const err = reject?.(typed.selector);
		if (err) {
			ui.notify(err, "warning");
			continue;
		}
		const r = input.checkModel(typed.selector);
		if (r.ok) {
			const model = { selector: typed.selector, label: r.label };
			return typed.effort && r.efforts.includes(typed.effort) ? { ...model, effort: typed.effort } : model;
		}
		ui.notify(`사용할 수 없는 모델: ${r.reason}`, "warning");
	}
}

async function editWorkers(
	ui: UiPort,
	recs: RoleRecommendation[],
	current: (roleId: string) => number,
): Promise<{ role: string; workers: number } | typeof BACK | undefined> {
	const titles = recs.map((r) => r.role.title);
	const a = await ui.select("워커 수를 바꿀 역할", [...titles, BACK]);
	if (a === BACK) return BACK;
	const rec = a === undefined ? undefined : recs[titles.indexOf(a)];
	if (!rec) return undefined;
	const now = current(rec.role.id);
	const n = await ui.select(`${rec.role.title} 워커 수 (현재: ${now})`, ["1", "2", "3", "4", CUSTOM, BACK]);
	if (n === BACK) return BACK;
	if (n === CUSTOM) {
		const v = await askNumber(ui, `${rec.role.title} 워커 수 (1-16)`, String(now), (v) =>
			Number.isInteger(v) && v >= 1 && v <= 16 ? undefined : "1에서 16 사이 정수를 입력하세요.",
		);
		return v === undefined ? undefined : { role: rec.role.id, workers: v };
	}
	const v = Number(n);
	return n !== undefined && Number.isInteger(v) && v >= 1 && v <= 4 ? { role: rec.role.id, workers: v } : undefined;
}

/** Role id to substitute, null to block, BACK, or undefined when cancelled. */
async function editFallback(
	ui: UiPort,
	recs: RoleRecommendation[],
	current: string | undefined,
): Promise<string | null | typeof BACK | undefined> {
	const labels = recs.map((r) => `${r.role.title} 역할 모델로 바꾸기`);
	const now = current === undefined ? BLOCK : `${recs.find((r) => r.role.id === current)?.role.title ?? current} 역할 모델`;
	const a = await ui.select(`실행 중 다른 에이전트 처리 (현재: ${now})`, [...labels, BLOCK, BACK]);
	if (a === BACK) return BACK;
	if (a === BLOCK) return null;
	const i = a === undefined ? -1 : labels.indexOf(a);
	return recs[i]?.role.id;
}

async function askNumber(
	ui: UiPort,
	title: string,
	placeholder: string,
	check: (v: number) => string | undefined,
): Promise<number | undefined> {
	for (;;) {
		const s = await ui.input(title, placeholder);
		if (s === undefined) return undefined;
		const v = Number(s.trim());
		const err = s.trim() === "" ? "값을 입력하세요." : check(v);
		if (!err) return v;
		ui.notify(err, "warning");
	}
}

/** null = no budget; undefined = cancelled. */
async function askBudget(ui: UiPort, current: BudgetConfig | undefined): Promise<BudgetConfig | null | undefined> {
	for (;;) {
		const s = await ui.input("실행당 예산 USD (빈 값이면 없음)", current ? String(current.perRunUsd) : "");
		if (s === undefined) return undefined;
		const t = s.trim();
		if (t === "") return null;
		const v = Number(t);
		if (Number.isFinite(v) && v > 0) return { perRunUsd: v, warnAtUsd: Math.round(v * 0.8 * 1e6) / 1e6, onExceed: "block-spawns" };
		ui.notify("0보다 큰 금액을 입력하세요.", "warning");
	}
}
