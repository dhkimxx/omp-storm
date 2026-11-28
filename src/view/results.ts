/**
 * The result-first projection every Storm surface reads: live widget, status report, and the settled-run card. It is
 * pure and keyed by the runtime ledger's stable result id. A plan criterion is a human label, never proof; only the
 * row state is the official disposition. Text that came from a plan, contract, lane, or attempt is bounded and made
 * single-line here so a stored record cannot forge a row or move the cursor.
 */
import type { InfoTone, PlanLane, PlanLaneResult, RunRecord, RunResult, RunResultState } from "../types.ts";
import { MAX_RESULT_ID } from "../plan/validate.ts";
import { ATTEMPT_REF } from "../runtime/attempt-report.ts";

/** Bounds are part of the display contract: no surface may show a longer fragment than this. */
const RESULT_ID_MAX = MAX_RESULT_ID;
export const RESULT_LABEL_MAX = 48;
export const RESULT_LANE_MAX = 30;
export const RESULT_REASON_MAX = 100;
export const RESULT_UNBLOCK_MAX = 120;
export const RESULT_REF_MAX = 64;

/** The public state words: reviewable and accepted stay distinct, and neither claims the run itself is done. */
export const RESULT_STATE_LABEL: Readonly<Record<RunResultState, string>> = {
	pending: "대기",
	unmet: "미충족",
	reviewable: "검토 가능",
	accepted: "이행",
};

/**
 * Row 1/§5: an accepted retained artifact is kept outside the parent work tree, and the word itself says so in every
 * form, including the narrowest chip. It never means the parent is unchanged or lacks those bytes.
 */
export const RETAINED_LABEL = "부모 밖 보존";
/** `부모 밖 보존 수용 N/M`: the acceptance count when every accepted row is a retained artifact, never tree work. */
export const RETAINED_ACCEPTED = "부모 밖 보존 수용";
/** An old or damaged row proves an isolated artifact acceptance but carries no bound capture reference: say unknown. */
export const RETAINED_REF_UNKNOWN = "참조 미확인(호스트 시도 기록)";
/** A retained artifact's form, then a safe file name and a digest prefix; no absolute host path. */
const RETAINED_FORM: Readonly<Record<NonNullable<RunResult["proof"]>["item"]["artifact"] & string, string>> = {
	patch: "패치",
	file: "파일",
	directory: "디렉터리",
};
const DIGEST = /^[0-9a-f]{64}$/u;

/** A safe, digest-bound reference to the retained source S1 accepted (never the absolute capture path). */
function retainedCapture(result: RunResult): string | undefined {
	const item = result.proof?.item;
	const form = item?.artifact;
	if (form === undefined) return undefined;
	const source = result.proof?.artifact;
	const name = typeof source?.path === "string" ? source.path.split(/[\\/]/u).pop() ?? "" : "";
	const digest = source?.expectedDigest ?? item?.digest;
	const parts = [RETAINED_FORM[form]];
	if (name !== "") parts.push(bounded(name, 40));
	if (digest !== undefined && DIGEST.test(digest)) parts.push(`sha256:${digest.slice(0, 12)}`);
	return bounded(parts.join(" "), RESULT_REF_MAX) || undefined;
}

/** The operator's orthogonal scope marker. It says who excluded the row, not what its evidence state is. */
export const RESULT_SCOPE_EXCLUDED = "excluded-by-user";

const RESULT_STATES: Readonly<Record<RunResultState, true>> = { pending: true, unmet: true, reviewable: true, accepted: true };
const RESULT_REMEDIES: Readonly<Record<NonNullable<RunResult["remedy"]>, true>> = {
	work: true,
	producer: true,
	review: true,
	retry: true,
	blocked: true,
};
/** Control characters, Unicode line separators, and bidi controls: never allowed to reach a terminal line. */
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g;
const UNSAFE_TEST = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/;
const ABSOLUTE_PATH = /^(?:\/|\\|[A-Za-z]:[\\/]|~)/;

/** One bounded, single-line presentation value; control and bidi characters become spaces and runs collapse. */
function bounded(value: unknown, max: number): string {
	if (typeof value !== "string") return "";
	const text = value.replace(UNSAFE, " ").replace(/\s+/g, " ").trim();
	if (text === "") return "";
	const points = Array.from(text);
	return points.length > max ? `${points.slice(0, Math.max(1, max - 1)).join("")}…` : text;
}

/** A workspace-relative source path is usable; an absolute or control-bearing one is not shown at all. */
function relativeRef(value: unknown): string | undefined {
	if (typeof value !== "string" || value.trim() === "" || UNSAFE_TEST.test(value) || ABSOLUTE_PATH.test(value)) return undefined;
	return bounded(value, RESULT_REF_MAX) || undefined;
}

/**
 * The source a result was actually observed at, when the runtime recorded one: an answer citation first, then the
 * declared result path, then a retained artifact path. Digests and raw output are never reconstructed here.
 */
function sourceRef(result: RunResult): string | undefined {
	const item = result.proof?.item;
	const citation = item?.citation;
	const cited = relativeRef(citation?.path);
	if (cited !== undefined) {
		const line = citation?.line;
		return typeof line === "number" && Number.isInteger(line) && line > 0 ? `${cited}:${line}` : cited;
	}
	return relativeRef(item?.path) ?? relativeRef(result.proof?.artifact?.path);
}

/** One ledger row as the surfaces read it; the label is human-facing and the id remains the precise reference. */
export interface ResultRow {
	readonly id: string;
	/** Bounded contract criterion, else the matching plan criterion, else the legacy id. */
	readonly label: string;
	/** True when no criterion exists and the id itself is the only label; surfaces must not print the id twice. */
	readonly labelIsId: boolean;
	readonly lane?: string;
	readonly state: RunResultState;
	readonly stateLabel: string;
	readonly running: boolean;
	/** The operator excluded this requirement; its state is unchanged and it never counts as in scope. */
	readonly excluded: boolean;
	readonly remedy?: NonNullable<RunResult["remedy"]>;
	/** Finalization closed this row before any judgment: its `unmet` is a placeholder, not a verdict. */
	readonly closedUnjudged: boolean;
	readonly reason?: string;
	readonly unblock?: string;
	/** Safe host attempt reference, when one was observed. */
	readonly attempt?: string;
	/** Safe workspace-relative source reference, when the proof recorded one. */
	readonly source?: string;
	/** The accepted evidence is a retained artifact outside the target, never a tree change (row 1). */
	readonly kept: boolean;
	/** Safe digest-bound reference to the retained source: form, file name, digest prefix. Never an absolute path. */
	readonly capture?: string;
}

export interface ResultCounts {
	/** Every valid ledger row, excluded ones included. */
	readonly total: number;
	/** Rows the operator did not exclude. */
	readonly inScope: number;
	/** In-scope state counts; these sum to `inScope`. */
	readonly accepted: number;
	readonly reviewable: number;
	/** Judged unmet only; a row closed before any judgment is counted in `unjudged`. */
	readonly unmet: number;
	/** In-scope rows finalization closed before any judgment (state `unmet`, marker `unsettled`). */
	readonly unjudged: number;
	readonly running: number;
	readonly pending: number;
	/** In-scope accepted rows whose evidence is a retained artifact outside the target (row 1). */
	readonly retained: number;
	/** In-scope rows whose trusted remedy is a structured blocker, and those whose retry route is exhausted. */
	readonly blocked: number;
	readonly exhausted: number;
	/** Operator-excluded rows, listed separately and never added to an in-scope count. */
	readonly excluded: number;
}

export interface ResultProgress {
	/** False for every legacy record without a usable ledger; its ordinary view is unchanged. */
	readonly present: boolean;
	readonly rows: readonly ResultRow[];
	readonly counts: ResultCounts;
	/** The first in-scope blocked/unmet/reviewable/pending row, else the first accepted, else the first excluded row. */
	readonly focus?: ResultRow;
	/** The first accepted in-scope row: what the run actually delivered. */
	readonly delivered?: ResultRow;
	/** State/count parts without the focus label, e.g. `이행 1/3 · 미충족 2`. */
	readonly parts: readonly string[];
	/** One human line: focus criterion (with a precise id reference), then the state/count parts. */
	readonly headline: string;
	/** The same facts for native accessibility; the id is a reference, never the leading word. */
	readonly aria: string;
	/** Only approved semantic tones; a row state never invents an error class. */
	readonly tone: InfoTone;
	/** Every displayed row fact, so settlement repaints even when worker counters did not move. */
	readonly key: string;
}

function planLabel(run: Pick<RunRecord, "plan">, result: RunResult): string {
	const lanes = run.plan?.lanes ?? [];
	const preferred = typeof result.lane === "string" ? lanes.filter(lane => lane.name === result.lane) : [];
	const ordered = [...preferred, ...lanes.filter(lane => !preferred.includes(lane))];
	for (const lane of ordered) {
		for (const planned of lane.results ?? []) {
			if (typeof planned?.id !== "string" || planned.id !== result.id) continue;
			const label = bounded(planned.criterion, RESULT_LABEL_MAX);
			if (label !== "") return label;
		}
	}
	return "";
}

interface PlannedIndex {
	readonly byLane: ReadonlyMap<string, PlanLane>;
	readonly byId: ReadonlyMap<string, PlanLaneResult>;
}

function rowOf(run: Pick<RunRecord, "plan">, value: unknown, runningLanes: ReadonlySet<string> | undefined, planned: PlannedIndex): ResultRow | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const result = value as RunResult & { readonly scope?: unknown };
	const id = bounded(result.id, RESULT_ID_MAX);
	const state =
		typeof result.state === "string" && Object.hasOwn(RESULT_STATES, result.state)
			? (result.state as RunResultState)
			: undefined;
	if (id === "" || state === undefined) return undefined;
	const label = bounded(result.contract?.criterion, RESULT_LABEL_MAX) || planLabel(run, result) || id;
	const lane = bounded(result.lane, RESULT_LANE_MAX) || undefined;
	const reason = bounded(result.reason, RESULT_REASON_MAX) || undefined;
	const unblock = bounded(result.unblock, RESULT_UNBLOCK_MAX) || undefined;
	const remedy =
		typeof result.remedy === "string" && Object.hasOwn(RESULT_REMEDIES, result.remedy)
			? (result.remedy as NonNullable<RunResult["remedy"]>)
			: undefined;
	const attempt = typeof result.attemptId === "string" && ATTEMPT_REF.test(result.attemptId) ? result.attemptId : undefined;
	const source = sourceRef(result);
	// A row accepted as an artifact of an isolated lane is retained even when an old record lost its bound source; the
	// kind comes from the stored contract, else the plan in force. Keyed lookups, so no per-row plan scan.
	const lanePlan = result.lane === undefined ? undefined : planned.byLane.get(result.lane);
	const plannedKind = result.contract?.kind ?? planned.byId.get(result.id)?.kind;
	const kept = state === "accepted" &&
		(result.proof?.item.artifact !== undefined || (lanePlan?.isolationReason !== undefined && plannedKind === "artifact"));
	const capture = kept ? retainedCapture(result) ?? RETAINED_REF_UNKNOWN : undefined;
	const excluded = result.scope === RESULT_SCOPE_EXCLUDED;
	const running = !excluded && (state === "pending" || state === "unmet") &&
		result.lane !== undefined && runningLanes?.has(result.lane) === true;
	return {
		id,
		label,
		labelIsId: label === id,
		...(lane === undefined ? {} : { lane }),
		state,
		stateLabel: running ? "진행 중" : RESULT_STATE_LABEL[state],
		running,
		excluded,
		closedUnjudged: !excluded && state === "unmet" && result.finalized === "unsettled",
		...(remedy === undefined ? {} : { remedy }),
		...(reason === undefined ? {} : { reason }),
		...(unblock === undefined ? {} : { unblock }),
		...(attempt === undefined ? {} : { attempt }),
		...(source === undefined ? {} : { source }),
		kept,
		...(capture === undefined ? {} : { capture }),
	};
}

/** State semantics only: when the record has no reason, say what the state means rather than invent a cause. */
export const RESULT_FALLBACK_REASON: Readonly<Record<RunResultState, string>> = {
	pending: "아직 판정 근거가 기록되지 않았습니다.",
	unmet: "미충족 사유가 기록되지 않았습니다.",
	reviewable: "판단할 제출물이 기록되었습니다.",
	accepted: "",
};


export interface ResultRowTextOptions {
	/** Include the state word; a reviewable-only line already carries its state in its header. */
	includeState?: boolean;
	/** Mark an operator-excluded row when the surrounding line does not already say so. */
	includeScope?: boolean;
}

/**
 * One compact row shared by the full status and the settled card: human criterion label, precise id reference, lane,
 * state, then only grounded reason/unblock and safe attempt/source references. No raw output or invented summary.
 */
export function resultRowText(row: ResultRow, options: ResultRowTextOptions = {}): string {
	const label = row.label === "" ? "(id 없음)" : row.label;
	// The criterion is the headline; the stable id follows only when it is not already the label.
	const reference = row.labelIsId ? "" : ` [${row.id}]`;
	const lane = row.lane === undefined ? "" : ` [${row.lane}]`;
	const scope = options.includeScope === true && row.excluded ? " · 사용자 제외" : "";
	const reason = row.reason ?? RESULT_FALLBACK_REASON[row.state] ?? "사유 미기재";
	// Only a controller-classified row carries these; accepted rows never claim a pending remedy.
	const remedy = row.state === "accepted" ? undefined : row.remedy;
	const marker = remedy === "blocked" ? " · 차단" : remedy === "retry" ? " · 재시도 소진" : "";
	const attempt = row.attempt === undefined ? "" : ` · 시도: ${row.attempt}`;
	// A retained artifact's declared path is where the candidate would land, not where it is now: `대상` names it and
	// `보존` carries the digest-bound source. A tree or answer row keeps the old `출처`.
	const source = row.source === undefined ? "" : row.kept ? ` · 대상: ${row.source}` : ` · 출처: ${row.source}`;
	const capture = row.capture === undefined ? "" : ` · ${RETAINED_LABEL}: ${row.capture}`;
	const unblock = row.state === "accepted" || row.unblock === undefined ? "" : ` · 해소: ${row.unblock}`;
	const head = `${label}${reference}${lane}${options.includeState === false || row.excluded ? "" : ` ${row.stateLabel}`}${scope}${marker}${attempt}${source}${capture}`;
	const detail = `${reason}${unblock}`;
	return detail === "" ? head : `${head} — ${detail}`;
}

/** Blocked first (a trusted structured refusal), then ordinary unmet work, then a reviewable submission. */
function focusRank(row: ResultRow): number {
	if (row.excluded) return 6;
	if (row.remedy === "blocked" && !row.running) return 0;
	if (row.state === "unmet" && !row.running) return 1;
	if (row.running) return 2;
	if (row.state === "reviewable") return 3;
	if (row.state === "pending") return 4;
	return 5;
}

function firstByRank(rows: readonly ResultRow[]): ResultRow | undefined {
	let best: ResultRow | undefined;
	let bestRank = Number.POSITIVE_INFINITY;
	for (const row of rows) {
		const rank = focusRank(row);
		if (rank < bestRank) {
			best = row;
			bestRank = rank;
		}
	}
	return best;
}

function toneOf(counts: ResultCounts): InfoTone {
	if (counts.inScope === 0) return "muted";
	if (counts.blocked > 0 || counts.exhausted > 0 || counts.unmet > 0 || counts.unjudged > 0) return "warning";
	// Row 1: retained artifacts are not a verified tree. No success mark and no tick for that acceptance.
	if (counts.retained > 0 && counts.retained === counts.accepted) return "accent";
	if (counts.reviewable > 0 || counts.pending > 0) return "accent";
	if (counts.accepted === counts.inScope) return "success";
	return "accent";
}

type ResultSnapshot = Pick<RunRecord, "results" | "plan"> & Partial<Pick<RunRecord, "status" | "spawns" | "agents">>;

/** An admission alone is not work in progress: the host must show the same named worker running now. */
function activeResultLanes(run: ResultSnapshot): ReadonlySet<string> | undefined {
	if (run.status !== "running" || !run.agents?.some(agent => agent.state === "running")) return undefined;
	const running = new Set(run.agents.filter(agent => agent.state === "running").map(agent => agent.id));
	const lanes = new Set<string>();
	for (let i = (run.spawns?.length ?? 0) - 1; i >= 0 && running.size > 0; i--) {
		const spawn = run.spawns?.[i];
		if (spawn?.outcome === "blocked" || spawn?.spawnKey === undefined || !running.delete(spawn.spawnKey)) continue;
		if (spawn.lane !== undefined) lanes.add(spawn.lane);
	}
	return lanes;
}

/**
 * Shape the official result disposition once. Only `run.results` states, scopes, reasons, remedies and recorded
 * references are read. `run.plan` supplies a human label when the row has no contract copy; a plan never proves state,
 * and no model-supplied lane progress is consulted.
 */
export function resultProgress(run: ResultSnapshot): ResultProgress {
	const seen = new Set<string>();
	const rows: ResultRow[] = [];
	const runningLanes = activeResultLanes(run);
	const byLane = new Map<string, PlanLane>();
	const byId = new Map<string, PlanLaneResult>();
	for (const lane of run.plan?.lanes ?? []) {
		byLane.set(lane.name, lane);
		for (const result of lane.results ?? []) if (!byId.has(result.id)) byId.set(result.id, result);
	}
	const planned: PlannedIndex = { byLane, byId };
	for (const value of Array.isArray(run.results) ? run.results : []) {
		const row = rowOf(run, value, runningLanes, planned);
		if (row === undefined || seen.has(row.id)) continue;
		seen.add(row.id);
		rows.push(row);
	}
	const scoped: ResultRow[] = [];
	const excludedRows: ResultRow[] = [];
	let accepted = 0;
	let reviewable = 0;
	let unmet = 0;
	let unjudged = 0;
	let running = 0;
	let pending = 0;
	let retained = 0;
	let blocked = 0;
	let exhausted = 0;
	for (const row of rows) {
		if (row.excluded) {
			excludedRows.push(row);
			continue;
		}
		scoped.push(row);
		if (row.state === "accepted") {
			accepted++;
			if (row.kept) retained++;
		} else {
			if (row.running) {
				running++;
				continue;
			}
			if (row.state === "reviewable") reviewable++;
			else if (row.state === "unmet") {
				if (row.closedUnjudged) unjudged++;
				else unmet++;
			}
			else pending++;
			if (row.remedy === "blocked") blocked++;
			else if (row.remedy === "retry") exhausted++;
		}
	}
	const counts: ResultCounts = {
		total: rows.length,
		inScope: scoped.length,
		accepted,
		reviewable,
		unmet,
		unjudged,
		running,
		pending,
		retained,
		blocked,
		exhausted,
		excluded: excludedRows.length,
	};
	const inScope = counts.inScope;
	const focus = firstByRank(inScope > 0 ? scoped : excludedRows);
	const delivered = scoped.find(row => row.state === "accepted");
	const parts: string[] = [];
	if (inScope > 0) {
		// Row 1: acceptance of retained artifacts is not tree work. When every accepted row is kept, the count says
		// `보존 수용`; a mixed run adds a bounded `보존 N` part instead of reading the whole count as landed.
		parts.push(counts.retained > 0 && counts.retained === counts.accepted ? `${RETAINED_ACCEPTED} ${counts.accepted}/${inScope}` : `이행 ${counts.accepted}/${inScope}`);
		if (counts.retained > 0 && counts.retained !== counts.accepted) parts.push(`${RETAINED_LABEL} ${counts.retained}`);
		if (counts.reviewable > 0) parts.push(`검토 가능 ${counts.reviewable}`);
		if (counts.unmet > 0) parts.push(`미충족 ${counts.unmet}`);
		if (counts.unjudged > 0) parts.push(`판정 전 종료 ${counts.unjudged}`);
		if (counts.running > 0) parts.push(`진행 중 ${counts.running}`);
		if (counts.pending > 0) parts.push(`대기 ${counts.pending}`);
		if (counts.exhausted > 0) parts.push(`재시도 소진 ${counts.exhausted}`);
		if (counts.blocked > 0) parts.push(`차단 ${counts.blocked}`);
	}
	if (counts.excluded > 0) parts.push(`사용자 제외 ${counts.excluded}`);
	const focusText = focus === undefined ? "" : `${focus.label}${focus.labelIsId ? "" : ` (${focus.id})`}`;
	const headline = [focusText, parts.join(" · ")].filter(part => part !== "").join(" · ");
	return {
		present: rows.length > 0,
		rows,
		counts,
		...(focus === undefined ? {} : { focus }),
		...(delivered === undefined ? {} : { delivered }),
		parts,
		headline,
		aria: headline === "" ? "" : `결과 ${headline}`,
		tone: toneOf(counts),
		key: JSON.stringify([
			headline,
			rows.map(row => [
				row.id,
				row.state,
				row.stateLabel,
				row.excluded,
				row.label,
				row.lane,
				row.reason,
				row.unblock,
				row.attempt,
				row.source,
				row.kept,
				row.capture,
				row.remedy,
				row.closedUnjudged,
			]),
		]),
	};
}

/**
 * Display-safe criterion labels of the plan in force, in plan order and without repeats. This is approved plan input,
 * not observed evidence: a caller uses it for the first bound-plan notice or a no-widget line, never as proof that a
 * result was attempted or met.
 */
export function plannedResultLabels(run: Pick<RunRecord, "plan">): string[] {
	const labels: string[] = [];
	const seen = new Set<string>();
	for (const lane of run.plan?.lanes ?? []) {
		for (const result of lane.results ?? []) {
			const label = bounded(result?.criterion, RESULT_LABEL_MAX) || bounded(result?.id, RESULT_ID_MAX);
			if (label === "" || seen.has(label)) continue;
			seen.add(label);
			labels.push(label);
		}
	}
	return labels;
}
