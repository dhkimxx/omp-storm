/**
 * Direct user steering for a live Storm run: parse one bounded ordinary input, resolve its target against the stored
 * plan/ledger labels, and state the conservative runtime guards for excluding an untouched requirement or granting one
 * retry of a host-settled read-only lane. Nothing here executes a spawn, writes a record, or authorizes scope: the
 * controller applies an accepted action synchronously and persists the acknowledgement. The model has no tool for it.
 */
import type { PlanLane, ResultInputVersion, RunAdjustment, RunPlan, RunResult } from "../types.ts";

export type AdjustKind = RunAdjustment["kind"];

/** One parsed native directive. `target` is the bounded user phrase, never a command line or quoted passage. */
export interface ParsedAdjustment {
	kind: AdjustKind;
	target: string;
}

/** What the interactive layer hands the controller; `exact` is the human fallback's result id, not a phrase. */
export interface AdjustRequest {
	kind: AdjustKind;
	target: string;
	/** Command fallback: `target` is the exact plan-wide result id. */
	exact?: boolean;
	/** Only interactive native input is deduplicated by its bounded text; the explicit command is intentional. */
	source?: "interactive" | "command";
}

export type AdjustOutcome =
	| { ok: true; text: string; already?: boolean }
	| { ok: false; reason: string };

export interface AdjustTarget {
	resultId: string;
	laneName: string;
	/** Human label from the stored contract or criterion, never the raw user phrase. */
	label: string;
}

export type TargetResolution = { ok: true; target: AdjustTarget } | { ok: false; reason: string };

/** The in-memory one-shot retry grant. It is never restored by a continuation and never persisted as authority. */
export interface RetryGrant {
	key: string;
	lane: string;
	result: string;
	label: string;
	agentId?: string;
	dependencies: string;
	route: string;
	identity: string;
	inputs: readonly ResultInputVersion[];
	/** The host-settled attempt the user reacted to; a different row version is a different request. */
	baseAttempt: string;
	at: number;
	/** The bounded nudge was already sent (or included in a round message). */
	nudged?: boolean;
}

const MAX_INPUT = 160;
const MAX_TARGET_WORDS = 4;
const MAX_SUGGESTIONS = 6;

/** Quotes, code fences, control characters, and line breaks are never an ordinary adjustment. */
const UNSAFE_INPUT = /[\u0000-\u001f\u007f-\u009f\u2028\u2029`"'“”‘’「」『』]/u;
/** Code-shaped input is a passage, not a direct instruction. */
const CODE_SHAPED = /(?:=>|===|!==|\|\||&&|[{}[\];])|\b(?:function|const|let|var|class|import|export|return|for|while)\b/u;
/** Questions and conditional/reported speech are not a direct active-run directive. */
const NOT_DIRECT = /[?？]/u;
const EN_CONDITIONAL = /\b(?:if|when|whenever|unless|whether|suppose|assuming|don't|doesn't|didn't|do\s+not|never|not)\b/iu;
const KO_CONDITIONAL = /(?:하지\s*마|하지마|하지\s*말|빼지\s*마|빼지마|빼지\s*말|제외하지|(?:^|\s)(?:안|못)(?:\s|$)|없이|말고|만약|라면|으면|려면|빼면|하면|보면|되면|나면|오면|가면|주면|경우|라고|라는|라니|다는|(?:을까|를까|까|나요|가요|죠)(?:\s|$))/u;
/** A target phrase that still contains another clause verb is too complex for one native action. */
const COMPLEX_TARGET = /(?:두고|하고|해서|하구|그대로|대신|말고|말구|빼고|제외하고)|(?:\b(?:and|but|then|also)\b)/iu;
/** One input may carry one bounded adjustment; a second exclude/retry clause is a complex turn for the normal flow. */
const RETRY_MARKER = /(?:다시|재시도|리트라이|한\s*번\s*더)|\b(?:retry|rerun|re-run|again)\b/iu;
const EXCLUDE_MARKER = /(?:빼|제외)|\b(?:drop|exclude|remove|skip)\b/iu;

const EXCLUDE_KO = /^(?<target>.+?)\s*(?:은|는|이|가|을|를)?\s*(?:빼고|빼\s*줘|빼|제외하고|제외해\s*줘|제외해|제외)(?:\s+(?<rest>.+))?$/u;
const RETRY_KO = [
	/^(?:실패한\s+)?(?<target>.+?)\s*(?:만|을|를)?\s*(?:한\s*번\s*더|다시)\s*(?:해\s*줘|해주세요|해|시도해\s*줘|시도해|실행해\s*줘|실행해|재시도)?$/u,
	/^(?:실패한\s+)?(?<target>.+?)\s*(?:만|을|를)?\s*(?:재시도|리트라이)(?:\s*해\s*줘|해주세요|해)?$/u,
];
const EXCLUDE_EN = /^(?:please\s+)?(?:drop|exclude|remove|skip)\s+(?<target>.+?)(?:\s+and\s+(?<rest>.+))?$/iu;
const RETRY_EN = [
	/^(?:please\s+)?(?:retry|rerun|re-run)(?:\s+only)?\s+(?<target>.+?)(?:\s+(?:only|once|again))*\s*[.!]*$/iu,
	/^(?:please\s+)?only\s+(?:retry|rerun|re-run)\s+(?<target>.+?)(?:\s+(?:only|once))?\s*[.!]*$/iu,
	/^(?:please\s+)?try\s+(?<target>.+?)\s+again\s*[.!]*$/iu,
];
/** Only a plain continuation is redundant with exclusion. Extra work stays in the ordinary steer. */
const CONTINUE_KO = /^(?:[\p{L}\p{N}._-]+(?:\s+[\p{L}\p{N}._-]+){0,3}\s+)?(?:계속|진행)(?:해\s*(?:줘|주세요)?)?$/u;
const CONTINUE_EN = /^continue(?:\s+with\s+[\p{L}\p{N}._-]+(?:\s+[\p{L}\p{N}._-]+){0,3})?$/iu;

function tidyInput(text: string): string | undefined {
	if (typeof text !== "string") return undefined;
	const trimmed = text.normalize("NFC").trim();
	if (trimmed === "" || trimmed.length > MAX_INPUT || trimmed.startsWith("/")) return undefined;
	if (UNSAFE_INPUT.test(trimmed) || CODE_SHAPED.test(trimmed) || NOT_DIRECT.test(trimmed)) return undefined;
	if (EN_CONDITIONAL.test(trimmed) || KO_CONDITIONAL.test(trimmed)) return undefined;
	const stripped = trimmed.replace(/[.!]+$/u, "").trim();
	return stripped === "" ? undefined : stripped;
}

function usableTarget(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const target = value.trim().replace(/\s+/gu, " ");
	if (target === "" || COMPLEX_TARGET.test(target)) return undefined;
	const words = target.split(" ").filter(Boolean);
	if (words.length === 0 || words.length > MAX_TARGET_WORDS) return undefined;
	return target;
}

/**
 * Parses exactly one clear exclusion or retry directive. The grammar is deliberately narrow: the user's four ordinary
 * forms (`UI는 빼고 API만 계속해`, `실패한 API 검증만 다시 해`, `Drop UI and continue with API`, `retry API check
 * only`) and close variants. Anything quoted, code-shaped, conditional, negated, a question, or too complex returns
 * undefined so the caller keeps OMP's ordinary input path.
 */
export function parseAdjustment(text: string): ParsedAdjustment | undefined {
	const input = tidyInput(text);
	if (input === undefined) return undefined;
	const excluded = EXCLUDE_KO.exec(input) ?? EXCLUDE_EN.exec(input);
	if (excluded !== null) {
		if (RETRY_MARKER.test(input)) return undefined;
		const rest = excluded.groups?.rest;
		if (rest !== undefined && (EXCLUDE_MARKER.test(rest) || COMPLEX_TARGET.test(rest) || !(
			CONTINUE_KO.test(rest) || CONTINUE_EN.test(rest)
		))) return undefined;
		const target = usableTarget(excluded.groups?.target);
		return target === undefined ? undefined : { kind: "exclude", target };
	}
	for (const pattern of RETRY_KO) {
		const match = pattern.exec(input);
		if (match !== null) {
			if (EXCLUDE_MARKER.test(input)) return undefined;
			const target = usableTarget(match.groups?.target);
			return target === undefined ? undefined : { kind: "retry", target };
		}
	}
	for (const pattern of RETRY_EN) {
		const match = pattern.exec(input);
		if (match !== null) {
			if (EXCLUDE_MARKER.test(input)) return undefined;
			const target = usableTarget(match.groups?.target);
			return target === undefined ? undefined : { kind: "retry", target };
		}
	}
	return undefined;
}

/** The exact human fallback: `/storm adjust exclude <id>` or `/storm adjust retry <id>`. */
export function parseAdjustCommand(text: string): { kind: AdjustKind; id: string } | undefined {
	const input = text.trim();
	if (input.length > 96) return undefined;
	const match = /^(exclude|retry)\s+([A-Za-z0-9][A-Za-z0-9._-]{0,63})$/u.exec(input);
	if (match === null) return undefined;
	return { kind: match[1] as AdjustKind, id: match[2]! };
}

/** A stored lane/result label is one bounded line; it is shown as a label, never treated as proof or a path. */
function safeLabel(value: unknown, max = 60): string {
	if (typeof value !== "string") return "";
	const text = value.normalize("NFC").replace(UNSAFE_INPUT, " ").replace(/\s+/gu, " ").trim();
	if (text === "") return "";
	const points = Array.from(text);
	return points.length > max ? `${points.slice(0, Math.max(1, max - 1)).join("")}…` : text;
}

/** Korean particles on a stored label word are presentation, not part of the target vocabulary. */
const KO_PARTICLE = /(?:은|는|이|가|을|를|의|에|에서|만|도|과|와)$/u;
const STOPWORDS: Readonly<Record<string, true>> = {
	the: true, a: true, an: true, and: true, or: true, only: true, just: true, please: true, all: true, this: true,
	that: true, these: true, those: true, it: true, its: true, them: true, they: true, to: true, for: true, with: true,
	from: true, on: true, in: true, of: true, result: true, results: true, lane: true, lanes: true, 그: true, 저: true,
	좀: true, 이: true, 그거: true, 이거: true, 저거: true, 것: true, 거: true, 만: true,
};
/** Ordinary labels are compared by meaning for the fixture's UI/API words and verification vocabulary. */
const SYNONYMS: Readonly<Record<string, string>> = {
	check: "verify", checks: "verify", verification: "verify", verify: "verify", validation: "verify", validate: "verify",
	test: "verify", tests: "verify", 검증: "verify", 확인: "verify", 리뷰: "review", review: "review", reviews: "review",
	explore: "research", explorer: "research", explored: "research", research: "research", 조사: "research", 탐색: "research",
	preview: "ui", previews: "ui", interface: "ui", frontend: "ui", 화면: "ui", 미리보기: "ui", 프론트: "ui",
};

function canonicalToken(raw: string): string {
	let token = raw;
	while (token.length > 1 && KO_PARTICLE.test(token)) token = token.replace(KO_PARTICLE, "");
	return SYNONYMS[token] ?? token;
}

function tokensOf(text: string): Set<string> {
	const tokens = new Set<string>();
	for (const raw of text.normalize("NFC").toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
		if (raw === "" || STOPWORDS[raw] === true) continue;
		tokens.add(canonicalToken(raw));
	}
	return tokens;
}

interface Candidate {
	id: string;
	laneName: string;
	label: string;
	tokens: Set<string>;
	order: number;
}

function candidateLabel(...values: Array<string | undefined>): string {
	for (const value of values) {
		const label = safeLabel(value);
		if (label !== "") return label;
	}
	return "";
}

function candidatesFor(plan: RunPlan | undefined, rows: readonly RunResult[] | undefined): Candidate[] {
	const out: Candidate[] = [];
	const seen = new Set<string>();
	let order = 0;
	for (const lane of plan?.lanes ?? []) {
		for (const result of lane.results ?? []) {
			if (seen.has(result.id)) continue;
			seen.add(result.id);
			const label = candidateLabel(result.criterion, lane.goal, result.id);
			out.push({
				id: result.id,
				laneName: lane.name,
				label,
				tokens: tokensOf([result.id, lane.name, lane.goal ?? "", result.criterion].join(" ")),
				order: order++,
			});
		}
	}
	for (const row of rows ?? []) {
		if (typeof row !== "object" || row === null || typeof row.id !== "string" || seen.has(row.id)) continue;
		seen.add(row.id);
		const laneName = typeof row.lane === "string" ? row.lane : "";
		const label = candidateLabel(row.contract?.criterion, row.id);
		out.push({
			id: row.id,
			laneName,
			label,
			tokens: tokensOf([row.id, laneName, row.contract?.criterion ?? ""].join(" ")),
			order: order++,
		});
	}
	return out;
}

function suggestions(candidates: readonly Candidate[]): string {
	const ids = [...new Set(candidates.map(candidate => candidate.id))].slice(0, MAX_SUGGESTIONS);
	if (ids.length === 0) return "이 실행에는 조정할 결과 id가 없습니다.";
	const more = candidates.length > ids.length ? " 외" : "";
	return `결과 id 중 하나로 다시 지정하세요: ${ids.join(", ")}${more}.`;
}

function ambiguity(kind: AdjustKind, candidates: readonly Candidate[]): string {
	const example = candidates[0]?.id;
	const usage = example === undefined ? "" : ` 예: /storm adjust ${kind} ${example}`;
	return `대상이 모호합니다. ${suggestions(candidates)}${usage}`;
}

function notFound(kind: AdjustKind, candidates: readonly Candidate[]): string {
	const usage = candidates[0] === undefined ? "" : ` 예: /storm adjust ${kind} ${candidates[0].id}`;
	return `계획과 결과 기록에서 대상을 찾지 못했습니다. ${suggestions(candidates)}${usage}`;
}

function targetOf(candidate: Candidate): AdjustTarget {
	return { resultId: candidate.id, laneName: candidate.laneName, label: candidate.label };
}

/**
 * Resolves one target against the stored plan and ledger only. An exact command id is authoritative; an ordinary
 * phrase must identify exactly one result by id, lane name, criterion, or goal. No plan text is evidence, and an
 * ambiguous phrase names the ids to use instead of guessing.
 */
export function resolveAdjustTarget(
	plan: RunPlan | undefined,
	rows: readonly RunResult[] | undefined,
	kind: AdjustKind,
	target: string,
	exact = false,
): TargetResolution {
	const candidates = candidatesFor(plan, rows);
	if (candidates.length === 0) return { ok: false, reason: "이 실행에는 조정할 계획 결과가 없습니다." };
	const phrase = target.normalize("NFC").trim();
	if (exact) {
		const hit = candidates.filter(candidate => candidate.id === phrase);
		if (hit.length === 1) return { ok: true, target: targetOf(hit[0]!) };
		return { ok: false, reason: `결과 id '${safeLabel(phrase, 64)}'를 이 실행의 계획에서 찾지 못했습니다. ${suggestions(candidates)}` };
	}
	if (phrase === "") return { ok: false, reason: notFound(kind, candidates) };
	const lowered = phrase.toLowerCase();
	const exactId = candidates.filter(candidate => candidate.id.toLowerCase() === lowered);
	if (exactId.length === 1) return { ok: true, target: targetOf(exactId[0]!) };
	if (exactId.length > 1) return { ok: false, reason: ambiguity(kind, exactId) };
	const exactLane = candidates.filter(candidate => candidate.laneName.toLowerCase() === lowered);
	if (exactLane.length === 1) return { ok: true, target: targetOf(exactLane[0]!) };
	if (exactLane.length > 1) return { ok: false, reason: ambiguity(kind, exactLane) };
	const wanted = tokensOf(phrase);
	if (wanted.size === 0) return { ok: false, reason: notFound(kind, candidates) };
	const matches = candidates.filter(candidate => [...wanted].every(token => candidate.tokens.has(token)));
	if (matches.length === 1) return { ok: true, target: targetOf(matches[0]!) };
	if (matches.length === 0) return { ok: false, reason: notFound(kind, candidates) };
	return { ok: false, reason: ambiguity(kind, matches) };
}

export interface ExcludeGuardInput {
	plan: RunPlan;
	rows: readonly RunResult[];
	lane: PlanLane;
	resultId: string;
	/** A placed reservation, pending follow-up, prepared attempt, or running worker exists for the lane. */
	laneBusy: boolean;
	/** A non-blocked spawn was ever recorded for this lane. */
	laneTouched: boolean;
}

/**
 * Why the untouched single-result lane cannot be excluded. Exclusion removes a future obligation; it never cancels a
 * worker, rolls back a write, or deletes another lane's evidence. Every input is runtime state, never model text.
 */
export function excludeProblem(input: ExcludeGuardInput): string | undefined {
	const { plan, rows, lane, resultId } = input;
	if (plan.lanes.length <= 1) return "계획의 유일한 레인은 제외할 수 없습니다. 남은 계획 없이 실행을 바꾸지 않습니다.";
	const results = lane.results ?? [];
	if (results.length !== 1) return "'레인 하나에 결과 하나'인 경우에만 사용자 제외를 적용할 수 있습니다. 결과 id를 기준으로 다시 계획하세요.";
	if (lane.job !== undefined) return `'${safeLabel(lane.name, 40)}' 레인은 승인된 정형 작업이라 사용자 제외로 중단하거나 되돌릴 수 없습니다.`;
	if (lane.isolationReason !== undefined) return `'${safeLabel(lane.name, 40)}' 레인은 격리 실험이라 일반 범위 제외 대상이 아닙니다.`;
	if ((lane.dependsOn ?? []).length > 0) {
		return `'${safeLabel(lane.name, 40)}' 레인은 선행 결과에 의존해 시작 전에도 범위에서 뺄 수 없습니다. 결과 id와 계획을 다시 확인하세요.`;
	}
	const dependents = plan.lanes
		.filter(lane => lane.name !== input.lane.name && (lane.dependsOn ?? []).some(dependency => dependency.lane === input.lane.name))
		.map(lane => lane.name);
	if (dependents.length > 0) {
		return `'${safeLabel(lane.name, 40)}' 레인에 의존하는 레인이 있어 제외하면 계획이 깨집니다(${dependents.slice(0, 3).map(name => safeLabel(name, 30)).join(", ")}). 먼저 계획을 바꾸세요.`;
	}
	if (input.laneBusy) return `'${safeLabel(lane.name, 40)}' 레인에 진행 중인 배치·시도·예약이 있습니다. 진행 중인 작업은 취소할 수 없으니 끝난 뒤 다시 제외하세요.`;
	if (input.laneTouched) return `'${safeLabel(lane.name, 40)}' 레인은 이미 스폰된 기록이 있어 되돌릴 수 없습니다. 새 계획으로 범위를 정하세요.`;
	const row = rows.find(candidate => candidate.id === resultId);
	if (row === undefined) return `결과 '${safeLabel(resultId, 40)}'의 기록을 찾지 못해 제외하지 않았습니다.`;
	if (row.scope === "excluded-by-user") return undefined;
	if (row.state !== "pending" || row.attemptId !== undefined || row.contentVersion !== undefined ||
		row.proof !== undefined || (row.consumed?.length ?? 0) > 0 || row.restoredFrom !== undefined ||
		(row.origin !== undefined && row.origin !== "plan")) {
		return `결과 '${safeLabel(resultId, 40)}'는 이미 ${row.state === "pending" ? "대기" : row.state === "unmet" ? "미충족" : row.state === "reviewable" ? "검토 가능" : "이행"} 상태이거나 시도·근거가 있어 제외할 수 없습니다. 쓰기나 실행을 되돌리지 않습니다.`;
	}
	const consumers = rows
		.filter(candidate => candidate.id !== row.id && (candidate.consumed ?? []).some(input => input.id === resultId))
		.map(candidate => candidate.id);
	if (consumers.length > 0) {
		return `다른 결과(${consumers.slice(0, 3).map(id => safeLabel(id, 30)).join(", ")})가 이 결과를 입력으로 사용하고 있어 제외할 수 없습니다.`;
	}
	return undefined;
}

export interface RetryGuardInput {
	plan: RunPlan;
	rows: readonly RunResult[];
	lane: PlanLane;
	resultId: string;
	/** A prepared attempt, settlement, reservation, pending follow-up, or running worker exists for the lane. */
	laneBusy: boolean;
	/** The producer versions the next attempt would capture still match the settled attempt's snapshot. */
	inputsMatch: boolean;
	/** Every consumed producer had a usable version at the settled attempt; a captured `missing` stays unusable. */
	inputsAvailable: boolean;
}

/**
 * Why the host-settled unmet lane cannot receive one user retry. This is not a new native retry: only one read-only,
 * single-answer lane on its unchanged contract and route may be retried, and an exhausted route or an in-flight
 * worker is refused explicitly. No accepted proof, job, approval, round, role or budget is touched.
 */
export function retryProblem(input: RetryGuardInput): string | undefined {
	const { lane, rows, resultId } = input;
	if (lane.job !== undefined) return `'${safeLabel(lane.name, 40)}' 레인은 정형 작업이라 사용자 재시도를 예약하지 않습니다. 작업 결과를 확인하세요.`;
	if ((lane.files?.length ?? 0) > 0) {
		return `'${safeLabel(lane.name, 40)}' 레인은 쓰기 레인입니다. 이미 실행 중인 쓰기 작업은 취소하거나 다시 예약할 수 없습니다.`;
	}
	if (lane.isolationReason !== undefined) return `'${safeLabel(lane.name, 40)}' 레인은 격리 실험이라 같은 경로의 사용자 재시도 대상이 아닙니다.`;
	if (lane.kind !== "explore" && lane.kind !== "review") {
		return `'${safeLabel(lane.name, 40)}' 레인은 탐색·검증(읽기 전용) 레인이 아니라 사용자 재시도를 예약하지 않습니다.`;
	}
	const results = lane.results ?? [];
	if (results.length !== 1) return `결과가 하나뿐인 읽기 전용 레인만 한 번 재시도할 수 있습니다. 결과 id를 하나로 좁혀 계획하세요.`;
	const result = results[0]!;
	if (result.id !== resultId) return `레인 '${safeLabel(lane.name, 40)}'의 결과 id와 요청한 결과가 다릅니다. 결과 id를 다시 확인하세요.`;
	if (result.kind !== "answer") return `검증·조사 답변(answer) 결과만 읽기 전용 재시도할 수 있습니다.`;
	const row = rows.find(candidate => candidate.id === resultId);
	if (row === undefined) return `결과 '${safeLabel(resultId, 40)}'의 기록을 찾지 못해 재시도하지 않았습니다.`;
	if (input.laneBusy) return `'${safeLabel(lane.name, 40)}' 레인의 시도가 이미 진행 중입니다(자동 재시도 포함). 끝난 뒤 결과를 확인하세요.`;
	if (row.state === "accepted") return `결과 '${safeLabel(resultId, 40)}'는 이미 이행되어 재시도할 필요가 없습니다.`;
	if (row.state === "reviewable") return `결과 '${safeLabel(resultId, 40)}'는 검토 제출 상태입니다. 재시도 대신 승인된 리뷰가 필요합니다.`;
	if (row.state === "pending") {
		return row.attemptId === undefined
			? `결과 '${safeLabel(resultId, 40)}'는 아직 호스트가 확정한 실패 시도가 없어 재시도 대상이 아닙니다.`
			: `결과 '${safeLabel(resultId, 40)}'는 시도가 아직 끝나지 않았거나 새 시도가 시작되었습니다. 끝난 뒤 다시 요청하세요.`;
	}
	if (row.attemptId === undefined) return `결과 '${safeLabel(resultId, 40)}'는 호스트가 확정한 시도가 없어 한 번 재시도할 근거가 없습니다.`;
	if (row.remedy === "retry") return `결과 '${safeLabel(resultId, 40)}'는 호스트 기본 재시도·대체 경로가 이미 소진되었습니다. 같은 경로를 다시 예약하지 않습니다. 다른 승인 레인으로 계획하세요.`;
	if (row.remedy === "blocked") return `결과 '${safeLabel(resultId, 40)}'는 외부 차단 상태입니다. 먼저 차단 조건을 해소해야 하며 재시도로 우회하지 않습니다.`;
	if (!input.inputsAvailable) return `결과 '${safeLabel(resultId, 40)}'의 선행 입력이 아직 준비되지 않았습니다. 누락된 입력을 먼저 만들고 같은 결과를 다시 판단하세요.`;
	if (!input.inputsMatch) return `결과 '${safeLabel(resultId, 40)}'의 선행 입력 버전이 바뀌었습니다. 같은 입력으로 재시도할 수 없으니 현재 계획으로 다시 판단하세요.`;
	return undefined;
}

/** Two producer-version snapshots are the same only in the exact plan order the attempt captured. */
export function sameInputs(a: readonly ResultInputVersion[] | undefined, b: readonly ResultInputVersion[] | undefined): boolean {
	const left = a ?? [];
	const right = b ?? [];
	return left.length === right.length && left.every((input, index) => input.id === right[index]?.id && input.version === right[index]?.version);
}

/** The one-shot key that makes a repeated delivery of the same settled attempt harmless. */
export function retryAdjustmentKey(lane: string, result: string, baseAttempt: string): string {
	return `${lane}\u0000${result}\u0000${baseAttempt}`;
}

/** Excluded rows are not obligations a later plan may recreate. */
export function excludedPlanConflict(rows: readonly RunResult[] | undefined, plan: RunPlan): string | undefined {
	const excluded = (rows ?? []).filter(row => row.scope === "excluded-by-user");
	if (excluded.length === 0) return undefined;
	for (const lane of plan.lanes) {
		for (const result of lane.results ?? []) {
			if (excluded.some(row => row.id === result.id)) {
				return `사용자가 범위에서 제외한 결과 '${safeLabel(result.id, 40)}'를 다시 계획할 수 없습니다. 제외는 이 실행에서 유지됩니다.`;
			}
		}
	}
	for (const lane of plan.lanes) {
		if (excluded.some(row => row.lane === lane.name)) {
			return `사용자가 제외한 레인 '${safeLabel(lane.name, 40)}'의 이름을 다시 사용할 수 없습니다.`;
		}
	}
	return undefined;
}

/** A continuation keeps exclusions but never reintroduces their lanes into the effective plan. */
export function stripExcludedPlan(plan: RunPlan, rows: readonly RunResult[] | undefined): RunPlan | undefined {
	const excluded = (rows ?? []).filter(row => row.scope === "excluded-by-user");
	if (excluded.length === 0) return plan;
	const ids = new Set(excluded.map(row => row.id));
	const lanes = new Set(excluded.map(row => row.lane).filter((lane): lane is string => typeof lane === "string"));
	const kept = plan.lanes.filter(lane => !lanes.has(lane.name) && !(lane.results ?? []).some(result => ids.has(result.id)));
	return kept.length === 0 ? undefined : { ...plan, lanes: kept };
}

/** The bounded host-authored nudge for an accepted exclusion; it is not a new task or a model tool result. */
export function exclusionNudgeText(runId: string, target: AdjustTarget): string {
	const lane = nudgeValue(target.laneName);
	const id = nudgeValue(target.resultId);
	const label = nudgeValue(target.label, 80);
	return [
		`<storm-adjust run="${nudgeValue(runId, 80)}" action="exclude" result="${id}" lane="${lane}">`,
		`The user directly removed result \`${id}\`${label === "" ? "" : ` (${label})`} in lane \`${lane}\` from this run's scope.`,
		"Do not recreate or respawn that lane or result, and never report it as verified. Keep the same run and continue only the remaining plan; other lanes, checks, and evidence are unchanged.",
		"</storm-adjust>",
	].join("\n");
}

/** The bounded host-authored nudge for a granted one-shot retry; a model still decides the ordinary lane attempt. */
export function retryNudgeText(runId: string, grant: RetryGrant): string {
	const lane = nudgeValue(grant.lane);
	const id = nudgeValue(grant.result);
	const label = nudgeValue(grant.label, 80);
	const delivery = grant.agentId === undefined
		? "Dispatch the same lane through the normal task tool."
		: `Resume the settled worker with \`write\` to \`agent://${nudgeValue(grant.agentId, 80)}\`; do not spawn its existing task name again.`;
	return [
		`<storm-adjust run="${nudgeValue(runId, 80)}" action="retry" result="${id}" lane="${lane}">`,
		`The user directly asked this active run to retry exactly result \`${id}\`${label === "" ? "" : ` (${label})`} in lane \`${lane}\` once.`,
		delivery,
		"Keep the same run, contract, route, and input versions. Do not start a new run, add approvals, reset rounds, or spawn any other lane for this request. Host evidence still decides the result.",
		"</storm-adjust>",
	].join("\n");
}

function nudgeValue(value: string, max = 40): string {
	const text = value.replace(/[<>&"`\u0000-\u001f\u007f-\u009f\u2028\u2029]+/gu, " ").replace(/\s+/gu, " ").trim();
	return (text === "" ? "?" : text).slice(0, max);
}
