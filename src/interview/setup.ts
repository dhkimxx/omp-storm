import type {
	ApprovalScope,
	BudgetConfig,
	Effort,
	InterviewInput,
	InterviewResult,
	Priority,
	RoleConfig,
	RoleRecommendation,
	ShadowInfo,
	StormConfig,
	TrialConfig,
	UiPort,
} from "../types.ts";
import {
	fallbackOf,
	int,
	pickedCandidate,
	priorityLabel,
	renderAnalysis,
	renderConfigDiff,
	renderDetection,
	renderEvidence,
	renderShadows,
	renderTeam,
	tierLabel,
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
export const APPROVE_SAVE = "승인 후 저장";
const WORKERS = "워커 수";
const OTHER_AGENTS = "다른 에이전트 처리";
const BLOCK = "차단";

type Step = "summary" | "priority" | "review" | "edit" | "evidence" | "final";

export function buildConfig(
	recs: RoleRecommendation[],
	picks: Record<string, number | string>,
	opts: {
		priority: Priority;
		parallelism: number;
		isolation: StormConfig["isolation"];
		contract: StormConfig["contract"];
		budget?: BudgetConfig;
		efforts?: Record<string, Effort | null>;
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
		const c = pickedCandidate(rec, pick);
		const selector = typeof pick === "string" ? pick : c?.selector;
		if (!selector) continue;
		const fb = fallbackOf(rec, selector);
		const effort =
			opts.efforts && rec.role.id in opts.efforts ? opts.efforts[rec.role.id] : (c?.effort ?? null);
		const role: RoleConfig = { agent: rec.role.agent, models: fb ? [selector, fb.selector] : [selector] };
		if (effort) role.effort = effort;
		role.workers = opts.workers?.[rec.role.id] ?? defaultWorkers(rec.role.id);
		roles[rec.role.id] = role;
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
			const i = m.indexOf("/");
			providers.add(i < 0 ? m : m.slice(0, i));
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

function initialPicks(recs: RoleRecommendation[]): Record<string, number | string> {
	const picks: Record<string, number | string> = {};
	for (const r of recs) if (r.chosenIndex >= 0 && r.candidates[r.chosenIndex]) picks[r.role.id] = r.chosenIndex;
	return picks;
}

/** Custom selectors get a mid effort when supported; the model's own default otherwise. */
function customEffort(efforts: Effort[]): Effort | null {
	if (!efforts.length) return null;
	return efforts.includes("medium") ? "medium" : (efforts[efforts.length - 1] ?? null);
}

export async function runSetupInterview(ui: UiPort, input: InterviewInput): Promise<InterviewResult> {
	let step: Step = "summary";
	let priority = input.priority;
	let recs = input.recommendations;
	let picks = initialPicks(recs);
	let efforts: Record<string, Effort | null> = {};
	let parallelism = input.defaults.parallelism;
	const isolation = input.defaults.isolation;
	let contract = input.defaults.contract;
	let budget: BudgetConfig | undefined = input.current?.config.budget;
	const workers: Record<string, number> = {};
	for (const [id, r] of Object.entries(input.current?.config.roles ?? {})) if (r.workers !== undefined) workers[id] = r.workers;
	let fallbackRole = initialFallback(input.current?.config);
	const trials = input.current?.config.trials;
	const cancelled = (at: Step): InterviewResult => ({ status: "cancelled", at });
	const config = () =>
		buildConfig(recs, picks, {
			priority,
			parallelism,
			isolation,
			contract,
			efforts,
			workers,
			...(fallbackRole !== undefined ? { fallbackRole } : {}),
			...(budget ? { budget } : {}),
			...(trials ? { trials } : {}),
		});

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
					picks = initialPicks(recs);
					efforts = {};
				}
				step = "review";
				break;
			}
			case "review": {
				const draft = config();
				const resolvedWorkers: Record<string, number> = {};
				for (const rec of recs) resolvedWorkers[rec.role.id] = workers[rec.role.id] ?? defaultWorkers(rec.role.id);
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
				const a = await ui.select("추천 구성을 어떻게 할까요?", ["전체 수락", "항목 수정", "근거 보기", BACK, CANCEL]);
				if (a === "전체 수락") {
					const missing = recs.filter((r) => picks[r.role.id] === undefined).map((r) => r.role.title);
					if (missing.length) {
						ui.notify(`후보 없는 역할이 있습니다: ${missing.join(", ")}. 직접 입력하세요.`, "warning");
						break;
					}
					step = "final";
				} else if (a === "항목 수정") step = "edit";
				else if (a === "근거 보기") step = "evidence";
				else if (a === BACK) step = "priority";
				else return cancelled(step);
				break;
			}
			case "evidence": {
				ui.report("추천 근거", renderEvidence(recs));
				step = "review";
				break;
			}
			case "edit": {
				const roleItems = recs.map((r) => `역할: ${r.role.title}`);
				const a = await ui.select("수정할 항목", [
					...roleItems,
					"병렬도",
					"실행 계약",
					"예산",
					WORKERS,
					OTHER_AGENTS,
					BACK,
				]);
				if (a === BACK) {
					step = "review";
					break;
				}
				const ri = a === undefined ? -1 : roleItems.indexOf(a);
				if (ri >= 0) {
					const rec = recs[ri]!;
					const r = await editRole(ui, rec, input);
					if (r === undefined) return cancelled(step);
					if (r !== BACK) {
						picks[rec.role.id] = r.pick;
						if (r.effort === undefined) delete efforts[rec.role.id];
						else efforts[rec.role.id] = r.effort;
					}
				} else if (a === "병렬도") {
					const n = await askNumber(ui, "병렬도 (1-16)", String(parallelism), (v) =>
						Number.isInteger(v) && v >= 1 && v <= 16 ? undefined : "1에서 16 사이 정수를 입력하세요.",
					);
					if (n === undefined) return cancelled(step);
					parallelism = n;
				} else if (a === "실행 계약") {
					const c = await ui.select(`실행 계약 (현재: ${contract})`, ["workflowz", "orchestrate", BACK]);
					if (c === "workflowz" || c === "orchestrate") contract = c;
					else if (c !== BACK) return cancelled(step);
				} else if (a === "예산") {
					const b = await askBudget(ui, budget);
					if (b === undefined) return cancelled(step);
					budget = b === null ? undefined : b;
				} else if (a === WORKERS) {
					const r = await editWorkers(ui, recs, (id) => workers[id] ?? defaultWorkers(id));
					if (r === undefined) return cancelled(step);
					if (r !== BACK) workers[r.role] = r.workers;
				} else if (a === OTHER_AGENTS) {
					const r = await editFallback(ui, recs, config().fallbackRole);
					if (r === undefined) return cancelled(step);
					if (r !== BACK) fallbackRole = r;
				} else return cancelled(step);
				break;
			}
			case "final": {
				const next = config();
				ui.report("저장할 설정", renderConfigDiff(input.current?.config, next) + renderShadows(input.shadows));
				const a = await ui.select("이 구성을 승인하고 저장할까요?", [APPROVE_SAVE, BACK, CANCEL]);
				if (a === APPROVE_SAVE) return { status: "approved", config: next, scope: deriveScope(next, input.shadows) };
				if (a === BACK) {
					step = "review";
					break;
				}
				return cancelled(step);
			}
		}
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

type RolePick = { pick: number | string; effort: Effort | null | undefined };

async function editRole(
	ui: UiPort,
	rec: RoleRecommendation,
	input: InterviewInput,
): Promise<RolePick | typeof BACK | undefined> {
	const labels = rec.candidates.map(
		(c) =>
			`${c.label} · ${tierLabel(c.tier)} · 지능 ${int(c.int.value)} · ${int(c.speed.value)} tok/s · $${c.referenceUsd == null ? "—" : c.referenceUsd.toFixed(4)}`,
	);
	const a = await ui.select(`${rec.role.title} 모델`, [...labels, CUSTOM, BACK]);
	if (a === BACK) return BACK;
	if (a === CUSTOM) {
		for (;;) {
			const s = (await ui.input(`${rec.role.title} 모델 직접 입력`, "provider/id"))?.trim();
			if (s === undefined) return undefined;
			const r = input.checkModel(s);
			if (r.ok) return { pick: s, effort: customEffort(r.efforts) };
			ui.notify(`사용할 수 없는 모델: ${r.reason}`, "warning");
		}
	}
	const i = a === undefined ? -1 : labels.indexOf(a);
	return i < 0 ? undefined : { pick: i, effort: undefined };
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
