/**
 * "역할별로 고르기" of the team setup: two HTML forms (models, then settings) and the mapping from their answers to
 * a team config. Everything here is pure; `setupFlow` draws the forms through `UiPort.form` and puts the result in
 * the standard approval dialog. Answers a form cannot give (an option it did not offer, an effort the chosen model
 * lacks) fall back to the form's default; a number that is missing or out of range is an error, worded with the
 * form's own labels, that the form reopens with.
 */
import { MAX_CONTEXT_CAP, validateConfig } from "../config/schema.ts";
import { ON_EXCEED, pct, quotaText, speedText, tierLabel, usd } from "../view/render.ts";
import { scoreText } from "../lineage/metrics.ts";
import { dropAdoptedTrials, providerOf } from "../proposals/build.ts";
import { pickEffort, ROLE_EFFORT } from "../recommend/recommend.ts";
import { DEFAULT_CONTEXT_CAP, MAX_WORKERS, REQUIRED_ROLES, ROLES, roleTitle, workerRange } from "../roles.ts";
import { entryEffort, formatModelEntry, type ModelEntry, parseModelEntry } from "../selector.ts";
import { type Analysis, type BudgetConfig, type Candidate, EFFORTS, type Effort, type FormData, type ModelInfo, type RoleConfig, type RoleId, type RoleRecommendation, type StormConfig } from "../types.ts";

/** The team the setup forms describe with warnings for the approval dialog, or what is wrong with the answers. */
export type SetupResult = { config: StormConfig; warnings: string[] } | { errors: string[] };

export interface SetupFormInput {
	recs: readonly RoleRecommendation[];
	/** Storm's recommended team (`recommendedConfig`): the recommended models plus everything carried over from `current`. */
	proposed: StormConfig;
	/** The team in use, on a re-setup: its models are what the forms open with. */
	current?: StormConfig;
	/** Models usable now: names and effort levels. */
	models: readonly ModelInfo[];
	/** Lineage key → share of the user's recent subagent requests (`subagentShares`). */
	usage?: ReadonlyMap<string, number>;
}

/** The answers of a form shown again, with what was wrong with them. */
export interface FormRetry {
	answers: FormData;
	errors: readonly string[];
}

/** What the models form decided: primary and fallback selector per used role, and the roles set to "사용 안 함". */
export interface ModelPicks {
	roles: Partial<Record<RoleId, { primary: string; fallback?: string }>>;
	disabled: RoleId[];
}

/** Select value of "사용 안 함" and "폴백 없음"; no selector equals it ("provider/id" always has a slash). */
export const NONE = "none";
/** Effort select value of "모델 기본값": the entry is written without an effort. */
export const MODEL_DEFAULT = "default";
const ON = "on";
const OFF = "off";
const DASH = "—";
const EXCEED: readonly BudgetConfig["onExceed"][] = ["block-spawns", "stop"];

/** Control names, shared by the builders and the mapping. */
export const FIELD = {
	primary: (id: RoleId) => `primary_${id}`,
	fallback: (id: RoleId) => `fallback_${id}`,
	effort: (id: RoleId) => `effort_${id}`,
	workersMin: (id: RoleId) => `workers_min_${id}`,
	workersMax: (id: RoleId) => `workers_max_${id}`,
	parallelism: "parallelism",
	contextCap: "context_cap",
	budget: "budget_usd",
	budgetWarn: "budget_warn_usd",
	budgetExceed: "budget_exceed",
	cleanup: "cleanup",
	docs: "docs",
} as const;

const LABEL = {
	workersMin: "워커 최소",
	workersMax: "워커 최대",
	parallelism: "병렬도",
	contextCap: "팀 컨텍스트 상한",
	budget: "실행당 예산",
	budgetWarn: "예산 경고 수준",
} as const;

/** Share of the user's recent subagent requests per model lineage, for the candidate tables. */
export function subagentShares(analysis: Analysis): Map<string, number> {
	return new Map(analysis.preferences.subagent.map((usage) => [usage.modelKey, usage.shareRecent]));
}

/** Why Storm recommends each role's primary model, for the approval dialog of the recommended team. */
export function recommendationNotes(recs: readonly RoleRecommendation[], config: StormConfig): string {
	const lines: string[] = [];
	for (const rec of recs) {
		const chosen = rec.candidates[rec.chosenIndex];
		if (!chosen || !Object.hasOwn(config.roles, rec.role.id)) continue;
		const facts = [tierLabel(chosen.tier), `참조 비용 ${usd(chosen.referenceUsd)}`, speedText(chosen.speed), `점수 ${scoreText(chosen.int)}`];
		lines.push(`- ${rec.role.title}: ${chosen.label} · ${facts.join(" · ")}${chosen.why[0] ? ` — ${chosen.why[0]}` : ""}`);
	}
	return lines.length ? ["### 추천 근거", ...lines].join("\n") : "";
}

function esc(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** What the forms open with: the recommended team, with the roles of the team in use as they are now. */
function baseConfig(input: SetupFormInput): StormConfig {
	return input.current ? { ...input.proposed, roles: { ...input.proposed.roles, ...input.current.roles } } : input.proposed;
}

interface ModelOption {
	selector: string;
	/** Absent for a model of the current team that is not a candidate. */
	candidate?: Candidate;
}

/** The models a role can be given: its ranked candidates, the recommended fallback, and the models it has now. */
function roleOptions(input: SetupFormInput, base: StormConfig, id: RoleId): ModelOption[] {
	const rec = input.recs.find((r) => r.role.id === id);
	const out: ModelOption[] = [];
	const add = (selector: string, candidate?: Candidate): void => {
		if (!out.some((option) => option.selector === selector)) out.push(candidate ? { selector, candidate } : { selector });
	};
	for (const candidate of rec?.candidates ?? []) add(candidate.selector, candidate);
	if (rec?.fallback) add(rec.fallback.selector, rec.fallback);
	for (const entry of base.roles[id]?.models ?? []) add(parseModelEntry(entry).selector);
	return out;
}

function optionLabel(input: SetupFormInput, option: ModelOption): string {
	const name = option.candidate?.label ?? input.models.find((m) => m.selector === option.selector)?.name;
	return name && name !== option.selector ? `${name} (${option.selector})` : option.selector;
}

function isRequired(id: RoleId): boolean {
	return REQUIRED_ROLES.includes(id);
}

/** A role's primary and fallback as the form opens: the base team's, "사용 안 함" for a role it does not have. */
function modelDefaults(base: StormConfig, id: RoleId, options: readonly ModelOption[]): { primary: string; fallback: string } {
	const models = base.roles[id]?.models ?? [];
	const first = models[0] ?? (isRequired(id) ? options[0]?.selector : undefined);
	return {
		primary: first === undefined ? NONE : parseModelEntry(first).selector,
		fallback: models[1] === undefined ? NONE : parseModelEntry(models[1]).selector,
	};
}

/** The answer when it is one of the offered values, else the default. */
function choice<T extends string>(data: FormData | undefined, name: string, offered: readonly T[], fallback: T): T {
	const answer = data?.[name];
	return offered.find((value) => value === answer) ?? fallback;
}

function select(name: string, label: string, options: ReadonlyArray<readonly [value: string, text: string]>, selected: string): string {
	const items = options.map(([value, text]) => `<option value="${esc(value)}"${value === selected ? " selected" : ""}>${esc(text)}</option>`);
	return `<label>${esc(label)} <select name="${name}">${items.join("")}</select></label>`;
}

function numberInput(name: string, label: string, value: string | number, min: number, max?: number): string {
	const bound = max === undefined ? "" : ` max="${max}"`;
	return `<label>${esc(label)} <input type="number" name="${name}" value="${esc(String(value))}" min="${min}"${bound} required></label>`;
}

function errorBlock(retry: FormRetry | undefined): string[] {
	if (!retry?.errors.length) return [];
	return ["<p><strong>다시 확인하세요</strong></p>", `<ul>${retry.errors.map((error) => `<li>${esc(error)}</li>`).join("")}</ul>`];
}

function candidateRow(input: SetupFormInput, option: ModelOption, recommended: boolean, current: boolean): string {
	const c = option.candidate;
	const name = `${recommended ? "★ " : ""}${optionLabel(input, option)}${current ? " · 지금" : ""}`;
	const cells = c
		? [name, tierLabel(c.tier), usd(c.referenceUsd), speedText(c.speed), scoreText(c.int), pct(input.usage?.get(c.modelKey)), quotaText(c.quota, c.quotaResetsAt)]
		: [name, DASH, DASH, DASH, DASH, DASH, "추천 후보 아님"];
	return `<tr>${cells.map((text) => `<td>${esc(text)}</td>`).join("")}</tr>`;
}

const TABLE_HEAD = ["모델", "가격대", "참조 비용", "속도", "점수", "내 사용", "쿼터"];

/** Form 1: per role the candidate table, the primary model and the fallback. */
export function modelsForm(input: SetupFormInput): string {
	const base = baseConfig(input);
	const out = [
		"<form>",
		"<p>역할마다 주 모델과 폴백을 고르세요. ★ 는 Storm 추천입니다. 점수와 속도의 ≈ 는 추정값입니다. 주 모델과 같은 폴백은 폴백 없음으로 봅니다.</p>",
	];
	for (const spec of ROLES) {
		const options = roleOptions(input, base, spec.id);
		if (!options.length) continue;
		const rec = input.recs.find((r) => r.role.id === spec.id);
		const recommended = rec?.candidates[rec.chosenIndex]?.selector;
		const now = input.current?.roles[spec.id]?.models[0];
		const nowSelector = now === undefined ? undefined : parseModelEntry(now).selector;
		const defaults = modelDefaults(base, spec.id, options);
		const labelled = options.map((option) => [option.selector, optionLabel(input, option)] as const);
		const primaries = isRequired(spec.id) ? labelled : [...labelled, [NONE, "사용 안 함"] as const];
		// Every candidate, not only those on another provider than the primary: the primary is chosen in this same
		// form. A fallback on the primary's provider is kept and warned about in the approval dialog.
		const fallbacks = [[NONE, "폴백 없음"] as const, ...labelled];
		// The form asks for one fallback; a role that has more keeps the rest behind the one picked here.
		const more = (base.roles[spec.id]?.models.slice(2) ?? []).map((model) => parseModelEntry(model).selector);
		out.push(
			`<fieldset><legend>${esc(spec.title)} (${spec.agent})</legend>`,
			`<p>${esc(spec.description)}</p>`,
			`<table><tr>${TABLE_HEAD.map((head) => `<th>${head}</th>`).join("")}</tr>`,
			...options.map((option) => candidateRow(input, option, option.selector === recommended, option.selector === nowSelector)),
			"</table>",
			select(FIELD.primary(spec.id), "주 모델", primaries, defaults.primary),
			select(FIELD.fallback(spec.id), "폴백", fallbacks, defaults.fallback),
			...(more.length ? [`<p>${esc(`폴백이 ${more.length}개 더 있습니다(${more.join(", ")}). 고른 폴백 뒤에 그대로 두며, 폴백 없음을 고르면 함께 뺍니다.`)}</p>`] : []),
			"</fieldset>",
		);
	}
	out.push("</form>");
	return out.join("\n");
}

/** Reads form 1. A role without any model to offer stays as it was: disabled when it was, else left out. */
export function readModelPicks(input: SetupFormInput, data: FormData): ModelPicks {
	const base = baseConfig(input);
	const picks: ModelPicks = { roles: {}, disabled: [] };
	for (const { id } of ROLES) {
		const options = roleOptions(input, base, id);
		if (!options.length) {
			if (base.disabledRoles?.includes(id)) picks.disabled.push(id);
			continue;
		}
		const defaults = modelDefaults(base, id, options);
		const selectors = options.map((option) => option.selector);
		const primary = choice(data, FIELD.primary(id), isRequired(id) ? selectors : [...selectors, NONE], defaults.primary);
		if (primary === NONE) {
			picks.disabled.push(id);
			continue;
		}
		const fallback = choice(data, FIELD.fallback(id), [NONE, ...selectors], defaults.fallback);
		picks.roles[id] = fallback === NONE || fallback === primary ? { primary } : { primary, fallback };
	}
	return picks;
}

function effortsOf(input: SetupFormInput, selector: string): readonly Effort[] {
	return input.models.find((m) => m.selector === selector)?.efforts ?? [];
}

/**
 * A model with the effort it runs with for a role when the user names none: as the base team has it (a bare entry
 * stays bare: the model's own default), else the recommender's effort, else the role default. An effort is always
 * one the model supports; a model without known levels (no effort control, or not usable now) keeps what it has.
 */
function defaultEntry(input: SetupFormInput, base: StormConfig, id: RoleId, selector: string): ModelEntry {
	const efforts = effortsOf(input, selector);
	const role = base.roles[id];
	const entry = role?.models.find((model) => parseModelEntry(model).selector === selector);
	let effort: Effort | null | undefined;
	if (entry !== undefined) {
		effort = entryEffort(entry, role?.effort);
		if (effort !== undefined && efforts.length) effort = pickEffort(effort, efforts);
	} else {
		const rec = input.recs.find((r) => r.role.id === id);
		const candidate = [...(rec?.candidates ?? []), ...(rec?.fallback ? [rec.fallback] : [])].find((c) => c.selector === selector);
		effort = pickEffort(candidate?.effort ?? ROLE_EFFORT[id], efforts);
	}
	return effort ? { selector, effort } : { selector };
}

function switchSelect(name: string, label: string, on: boolean, retry: FormRetry | undefined): string {
	return select(name, label, [[ON, "켬"], [OFF, "끔"]], choice(retry?.answers, name, [ON, OFF], on ? ON : OFF));
}

/** Form 2: per used role the effort (only what its primary supports) and the worker range, then the run settings. */
export function settingsForm(input: SetupFormInput, picks: ModelPicks, retry?: FormRetry): string {
	const base = baseConfig(input);
	/** A number field keeps what the user typed when the form reopens. */
	const typed = (name: string, fallback: number): string | number => {
		const answer = retry?.answers[name];
		return typeof answer === "number" || typeof answer === "string" ? answer : fallback;
	};
	const out = ["<form>", ...errorBlock(retry)];
	for (const { id } of ROLES) {
		const pick = picks.roles[id];
		if (!pick) continue;
		const efforts = effortsOf(input, pick.primary);
		const workers = workerRange(id, base.roles[id]);
		out.push(`<fieldset><legend>${esc(roleTitle(id))} · ${esc(pick.primary)}</legend>`);
		if (efforts.length) {
			const offered = [MODEL_DEFAULT, ...efforts];
			const fallback = defaultEntry(input, base, id, pick.primary).effort ?? MODEL_DEFAULT;
			out.push(
				select(
					FIELD.effort(id),
					"effort",
					offered.map((value) => [value, value === MODEL_DEFAULT ? "모델 기본값" : value] as const),
					choice(retry?.answers, FIELD.effort(id), offered, fallback),
				),
			);
		}
		out.push(
			numberInput(FIELD.workersMin(id), `${LABEL.workersMin} (계획이 수를 정하지 않을 때)`, typed(FIELD.workersMin(id), workers.min), 1, MAX_WORKERS),
			numberInput(FIELD.workersMax(id), `${LABEL.workersMax} (동시에 살아 있는 수의 상한)`, typed(FIELD.workersMax(id), workers.max), 1, MAX_WORKERS),
			"</fieldset>",
		);
	}
	const budget = base.budget;
	out.push(
		"<fieldset><legend>실행</legend>",
		numberInput(FIELD.parallelism, `${LABEL.parallelism} (동시에 도는 서브에이전트 수)`, typed(FIELD.parallelism, base.parallelism), 1, MAX_WORKERS),
		numberInput(FIELD.contextCap, `${LABEL.contextCap} (토큰. 넘은 서브에이전트는 후속 지시를 받지 않습니다)`, typed(FIELD.contextCap, base.contextCap ?? DEFAULT_CONTEXT_CAP), 1, MAX_CONTEXT_CAP),
		"</fieldset>",
		"<fieldset><legend>예산</legend>",
		numberInput(FIELD.budget, `${LABEL.budget} (USD, 0 = 없음)`, typed(FIELD.budget, budget?.perRunUsd ?? 0), 0),
		numberInput(FIELD.budgetWarn, `${LABEL.budgetWarn} (USD, 0 = 경고 없음)`, typed(FIELD.budgetWarn, budget?.warnAtUsd ?? 0), 0),
		select(
			FIELD.budgetExceed,
			"예산을 넘으면",
			EXCEED.map((value) => [value, ON_EXCEED[value]] as const),
			choice(retry?.answers, FIELD.budgetExceed, EXCEED, budget?.onExceed ?? "block-spawns"),
		),
		"</fieldset>",
		"<fieldset><legend>실행이 끝나면 정리</legend>",
		"<p>실행이 끝날 때 최근 3개를 뺀 Storm 실행의 끝난 서브에이전트 omp 기록(대화 기록·부속 파일)을 지웁니다. 결과(.md), 메인 세션, local:// 문서, omp 설정과 통계는 남깁니다.</p>",
		switchSelect(FIELD.cleanup, "실행이 끝나면 정리", base.cleanup === true, retry),
		"</fieldset>",
		"<fieldset><legend>문서 정합</legend>",
		"<p>실행 계약과 역할 프롬프트에 문서 규칙을 넣고, 리뷰에서 문서와 코드가 어긋나는지 확인합니다.</p>",
		switchSelect(FIELD.docs, "문서 정합", base.docs !== false, retry),
		"</fieldset>",
		"</form>",
	);
	return out.join("\n");
}

/**
 * A model with the effort the user asked for: a level the model does not have becomes the nearest it supports, and
 * "모델 기본값" a bare entry. Without an answer, or for a model without known levels, the default entry.
 */
function pickedEntry(input: SetupFormInput, base: StormConfig, id: RoleId, selector: string, want: FormData[string] | undefined): ModelEntry {
	const efforts = effortsOf(input, selector);
	if (efforts.length && want === MODEL_DEFAULT) return { selector };
	const asked = EFFORTS.find((level) => level === want);
	const effort = asked === undefined ? null : pickEffort(asked, efforts);
	return effort ? { selector, effort } : defaultEntry(input, base, id, selector);
}

/**
 * The team the two forms describe, validated. A role the forms left as it was keeps its config object untouched, so
 * submitting both forms unchanged gives the base team back. `warnings` are for the approval dialog.
 */
export function setupConfig(input: SetupFormInput, picks: ModelPicks, data: FormData): SetupResult {
	const base = baseConfig(input);
	const errors: string[] = [];
	const warnings: string[] = [];
	/** A whole number in [min, max] from a number field; anything else is an error under the field's label. */
	const whole = (name: string, label: string, min: number, max: number): number => {
		const value = data[name];
		if (typeof value === "number" && Number.isInteger(value) && value >= min && value <= max) return value;
		errors.push(`${label}: ${min}~${max.toLocaleString("en-US")} 사이 정수를 넣으세요`);
		return Number.NaN;
	};
	/** A USD amount, 0 or more. */
	const amount = (name: string, label: string): number => {
		const value = data[name];
		if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
		errors.push(`${label}: 0 이상의 숫자를 넣으세요`);
		return Number.NaN;
	};

	const roles: Record<string, RoleConfig> = {};
	for (const { id, agent } of ROLES) {
		const pick = picks.roles[id];
		if (!pick) continue;
		const title = roleTitle(id);
		const before = base.roles[id];
		const picked = [pickedEntry(input, base, id, pick.primary, data[FIELD.effort(id)])];
		if (pick.fallback !== undefined) {
			picked.push(pickedEntry(input, base, id, pick.fallback, undefined));
			if (providerOf(pick.fallback) === providerOf(pick.primary)) {
				warnings.push(`${title}: 폴백 ${pick.fallback} 은 주 모델과 같은 Provider입니다. 그 Provider의 쿼터가 소진되면 함께 막힙니다.`);
			}
			// The forms know one fallback; the ones the role has behind it stay, in their order and at their efforts.
			for (const model of before?.models.slice(2) ?? []) {
				const selector = parseModelEntry(model).selector;
				const effort = entryEffort(model, before?.effort);
				if (!picked.some((entry) => entry.selector === selector)) picked.push(effort ? { selector, effort } : { selector });
			}
		}
		const workers = {
			min: whole(FIELD.workersMin(id), `${title} ${LABEL.workersMin}`, 1, MAX_WORKERS),
			max: whole(FIELD.workersMax(id), `${title} ${LABEL.workersMax}`, 1, MAX_WORKERS),
		};
		if (workers.min > workers.max) errors.push(`${title}: ${LABEL.workersMin}(${workers.min})가 ${LABEL.workersMax}(${workers.max})보다 큽니다`);
		const range = workerRange(id, before);
		// Compared by meaning: a team written before per-model efforts spells the same models differently.
		const same =
			before !== undefined &&
			before.models.length === picked.length &&
			before.models.every((model, i) => parseModelEntry(model).selector === picked[i]!.selector && entryEffort(model, before.effort) === picked[i]!.effort);
		if (before && same && range.min === workers.min && range.max === workers.max) {
			roles[id] = structuredClone(before);
			continue;
		}
		roles[id] = { agent, models: picked.map(formatModelEntry), workers, ...(before?.contextCap !== undefined ? { contextCap: before.contextCap } : {}) };
	}

	const config: StormConfig = { ...structuredClone(base), roles, parallelism: whole(FIELD.parallelism, LABEL.parallelism, 1, MAX_WORKERS) };
	const contextCap = whole(FIELD.contextCap, LABEL.contextCap, 1, MAX_CONTEXT_CAP);
	// The default stays unwritten, as in a team that never set it.
	if (base.contextCap !== undefined || contextCap !== DEFAULT_CONTEXT_CAP) config.contextCap = contextCap;
	const perRunUsd = amount(FIELD.budget, LABEL.budget);
	const warnAtUsd = amount(FIELD.budgetWarn, LABEL.budgetWarn);
	if (perRunUsd === 0) delete config.budget;
	else {
		if (warnAtUsd > perRunUsd) errors.push(`${LABEL.budgetWarn}($${warnAtUsd})이 ${LABEL.budget}($${perRunUsd})보다 큽니다`);
		config.budget = {
			perRunUsd,
			...(warnAtUsd === 0 ? {} : { warnAtUsd }),
			onExceed: choice(data, FIELD.budgetExceed, EXCEED, base.budget?.onExceed ?? "block-spawns"),
		};
	}
	if (choice(data, FIELD.cleanup, [ON, OFF], base.cleanup === true ? ON : OFF) === ON) config.cleanup = true;
	else delete config.cleanup;
	if (choice(data, FIELD.docs, [ON, OFF], base.docs === false ? OFF : ON) === OFF) config.docs = false;
	else delete config.docs;
	if (picks.disabled.length) config.disabledRoles = [...picks.disabled];
	else delete config.disabledRoles;
	// Settings that name a role go with it.
	if (config.fallbackRole !== undefined && !Object.hasOwn(roles, config.fallbackRole)) {
		warnings.push(
			`${roleTitle(config.fallbackRole)} 역할을 쓰지 않게 되어 「실행 중 다른 에이전트」가 차단으로 바뀝니다: 실행 중에 Storm 역할이 아닌 에이전트는 승인되지 않은 모델로 뜨지 못합니다.`,
		);
		delete config.fallbackRole;
	}
	const trials = config.trials?.filter((trial) => Object.hasOwn(roles, trial.role));
	if (trials?.length) config.trials = trials;
	else delete config.trials;
	// A trial whose candidate was picked as the role's primary has nothing left to compare.
	dropAdoptedTrials(config);

	if (errors.length) return { errors };
	// The checks above cover everything the forms can get wrong; what is left would be a fault of the base team.
	const checked = validateConfig(config);
	return checked.config ? { config, warnings } : { errors: checked.errors };
}
