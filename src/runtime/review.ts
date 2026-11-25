/** Reviewer yields from omp's `yield` tool args counted as reviews, and the one line the summary and status show. */
import { RESULT_ID_RE } from "../plan/validate.ts";
import type { AgentEntry, ReviewTally } from "../types.ts";

/** The parts of omp's `yield` args Storm reads; every field is checked before use. */
interface YieldArgs {
	data?: unknown;
	type?: unknown;
}
interface FinalPayload {
	overall_correctness?: unknown;
	findings?: unknown;
	results?: unknown;
}
interface Finding {
	priority?: unknown;
	kind?: unknown;
}

/** A final verdict payload and whether it passed. */
interface Verdict {
	payload: FinalPayload;
	correct: boolean;
}

/** Findings and doc findings counted from one yield. */
interface Counts {
	findings: ReviewTally["findings"];
	docs: number;
}

/** A priority the reviewer output schema allows. */
export type ReviewPriority = 0 | 1 | 2 | 3;

/** A kind the reviewer output schema allows; only doc kinds count as doc findings. */
export type ReviewKind = "code" | "doc_conflict" | "doc_copy";

/**
 * A finding as the proof uses it: priority and kind only. The proof never keeps titles, bodies, command output or log
 * text; those stay in the reviewer's own yield and record.
 */
export interface ReviewFinding {
	priority: ReviewPriority;
	kind?: ReviewKind;
}

/**
 * One explicitly scoped result verdict from a final payload's `results`: the declared result id, the review receipt
 * Storm issued for that exact pending submission, and the citation anchor the reviewer judged it against. It is a
 * claim about that one submission only; Storm accepts it only when all three still match what is pending now.
 */
export interface ReviewedResult {
	id: string;
	/** 32 lowercase hex characters, copied from Storm's review packet; never computed by the reviewer. */
	receipt: string;
	/** `path` or `path:line`, exactly as the packet named it. */
	citation: string;
	correct: boolean;
}

const RECEIPT_RE = /^[0-9a-f]{32}$/u;
const CITATION_MAX = 300;
const CITATION_UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

/** One scoped verdict, or undefined for an entry that does not name exactly one result, receipt, anchor and verdict. */
function reviewedResultOf(value: unknown): ReviewedResult | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const { id, receipt, citation, verdict, correct } = value as Record<string, unknown>;
	if (typeof id !== "string" || !RESULT_ID_RE.test(id)) return undefined;
	if (typeof receipt !== "string" || !RECEIPT_RE.test(receipt)) return undefined;
	if (typeof citation !== "string" || citation === "" || citation.length > CITATION_MAX || citation.trim() !== citation ||
		CITATION_UNSAFE.test(citation)) return undefined;
	// The wire spells it `verdict`; a stored record keeps the parsed boolean.
	const ok = verdict === "correct" ? true : verdict === "incorrect" ? false : typeof correct === "boolean" ? correct : undefined;
	if (ok === undefined) return undefined;
	return { id, receipt, citation, correct: ok };
}

/**
 * The scoped result verdicts of one payload, however many a reviewer judged in one turn: each entry is small and is
 * bound to its own receipt later, so the list length decides nothing. A malformed entry scopes nothing, and an id
 * named twice is ambiguous: every entry for it is dropped, so one review never settles a result it did not judge
 * exactly once.
 */
export function reviewedResultsIn(list: unknown): ReviewedResult[] {
	if (!Array.isArray(list)) return [];
	const parsed = list.map(reviewedResultOf).filter((entry): entry is ReviewedResult => entry !== undefined);
	const counts = new Map<string, number>();
	for (const entry of parsed) counts.set(entry.id, (counts.get(entry.id) ?? 0) + 1);
	return parsed.filter(entry => counts.get(entry.id) === 1);
}

/**
 * One review event: a findings yield before a verdict, or a final verdict. A verdict's `tree` is the exact
 * `<diff>:<files>` fingerprint Storm read when the verdict was given; without it the review is not proof.
 */
export interface ReviewEvidence {
	/** ms since epoch of the yield. */
	at: number;
	/** Present only for a final verdict; absent for findings that have not ended in one. */
	correct?: boolean;
	findings: ReviewFinding[];
	/** The exact tree the verdict was given against; absent when it could not be read then. */
	tree?: string;
	/** A final verdict's explicitly scoped result verdicts; absent for a plain change review. */
	results?: ReviewedResult[];
}

/**
 * The runtime fields the ledger adds to an agent entry. These are the additive `src/types.ts` fields: `AgentEntry`
 * gains `reviewLog?: ReviewEvidence[]` and `reviewLogOverflow?: true`.
 */
export interface ReviewEvidenceEntry extends AgentEntry {
	reviewLog?: ReviewEvidence[];
	/** A P0-bearing entry fell out of the bounded log: unresolved findings cannot be ruled out. */
	reviewLogOverflow?: true;
}

/** The structured part of one `yield`: either findings before a verdict or the verdict itself. */
export type ParsedReview =
	| { kind: "findings"; findings: ReviewFinding[] }
	| { kind: "verdict"; findings: ReviewFinding[]; correct: boolean; results?: ReviewedResult[] };

/** One structured finding, or undefined for an item the schema does not allow. */
function findingOf(value: unknown): ReviewFinding | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const { priority: p, kind } = value as Finding;
	if (typeof p !== "number" || !Number.isInteger(p) || p < 0 || p > 3) return undefined;
	const finding: ReviewFinding = { priority: p as ReviewPriority };
	if (kind === "code" || kind === "doc_conflict" || kind === "doc_copy") finding.kind = kind;
	return finding;
}

/** Every valid finding in a single finding or a list of them; invalid items are not findings at all. */
function findingsIn(list: unknown): ReviewFinding[] {
	const out: ReviewFinding[] = [];
	for (const value of Array.isArray(list) ? list : [list]) {
		const finding = findingOf(value);
		if (finding) out.push(finding);
	}
	return out;
}

/**
 * Counts findings with an integer priority 0..3 into `counts.findings`, and those of kind `doc_conflict` or
 * `doc_copy` also into `counts.docs`; returns how many counted.
 */
function countFindings(counts: Counts, list: unknown): number {
	let counted = 0;
	for (const finding of findingsIn(list)) {
		counts.findings[finding.priority]++;
		if (finding.kind === "doc_conflict" || finding.kind === "doc_copy") counts.docs++;
		counted++;
	}
	return counted;
}

const EMPTY: ReviewTally = { reviews: 0, passed: 0, failed: 0, findings: [0, 0, 0, 0] };

/** The final verdict a `yield` input carries; undefined for a findings section and for anything that is no review. */
function verdictPayload(input: unknown): Verdict | undefined {
	if (typeof input !== "object" || input === null) return undefined;
	const { data, type } = input as YieldArgs;
	if (Array.isArray(type) && type.includes("findings")) return undefined;
	if (typeof data !== "object" || data === null || Array.isArray(data)) return undefined;
	const payload = data as FinalPayload;
	const verdict = payload.overall_correctness;
	if (verdict !== "correct" && verdict !== "incorrect") return undefined;
	return { payload, correct: verdict === "correct" };
}

/** Whether a `yield` input is a review verdict, and whether it passed; undefined for a findings section and other inputs. */
export function verdictOf(input: unknown): boolean | undefined {
	return verdictPayload(input)?.correct;
}

/**
 * The structured review a `yield` carries: a findings section, or a final verdict with its payload findings.
 * Undefined for unrelated input and for a findings section with no valid finding.
 */
export function reviewPart(input: unknown): ParsedReview | undefined {
	if (typeof input !== "object" || input === null) return undefined;
	const { data, type } = input as YieldArgs;
	if (Array.isArray(type) && type.includes("findings")) {
		const findings = findingsIn(data);
		return findings.length === 0 ? undefined : { kind: "findings", findings };
	}
	const verdict = verdictPayload(input);
	if (!verdict) return undefined;
	const findings = Array.isArray(verdict.payload.findings) ? findingsIn(verdict.payload.findings) : [];
	const results = reviewedResultsIn(verdict.payload.results);
	return { kind: "verdict", findings, correct: verdict.correct, ...(results.length === 0 ? {} : { results }) };
}

/** `base` with new finding counts; `docFindings` appears once a doc finding was counted. */
function withCounts(base: ReviewTally, counts: Counts): ReviewTally {
	const next: ReviewTally = { ...base, findings: counts.findings };
	if (counts.docs > 0) next.docFindings = counts.docs;
	return next;
}

/**
 * Folds one `yield` call (`{ data?, type?, error? }`) into the tally: a findings section adds its findings, a final
 * payload with `overall_correctness` is one more review (plus its findings). Doc findings count in `findings` and in
 * `docFindings`. Unrelated input returns `prev`.
 */
export function tallyFromYield(prev: ReviewTally | undefined, input: unknown): ReviewTally | undefined {
	if (typeof input !== "object" || input === null) return prev;
	const base = prev ?? EMPTY;
	const counts: Counts = { findings: [...base.findings], docs: base.docFindings ?? 0 };
	const { data, type } = input as YieldArgs;
	if (Array.isArray(type) && type.includes("findings")) {
		if (countFindings(counts, data) === 0) return prev;
		return withCounts(base, counts);
	}
	const verdict = verdictPayload(input);
	if (!verdict) return prev;
	if (Array.isArray(verdict.payload.findings)) countFindings(counts, verdict.payload.findings);
	return withCounts(
		{
			...base,
			reviews: base.reviews + 1,
			passed: base.passed + (verdict.correct ? 1 : 0),
			failed: base.failed + (verdict.correct ? 0 : 1),
		},
		counts,
	);
}

/** The agents' review tallies added up; `docFindings` is always a number here. */
export function reviewTotals(agents: readonly AgentEntry[]): Required<ReviewTally> {
	const total: Required<ReviewTally> = { reviews: 0, passed: 0, failed: 0, findings: [0, 0, 0, 0], docFindings: 0 };
	for (const { review } of agents) {
		if (!review) continue;
		total.reviews += review.reviews;
		total.passed += review.passed;
		total.failed += review.failed;
		total.docFindings += review.docFindings ?? 0;
		review.findings.forEach((n, i) => {
			total.findings[i as 0 | 1 | 2 | 3] += n;
		});
	}
	return total;
}

/**
 * `- 리뷰 N회: 통과 a · 수정 필요 b (P0 x · P1 y) · 문서 상충 d건` summed over agents (the doc part only when above
 * zero), or `- 리뷰: 없음` before any verdict.
 */
export function reviewLine(agents: readonly AgentEntry[]): string {
	const total = reviewTotals(agents.filter(agent => (agent.review?.reviews ?? 0) > 0));
	if (total.reviews === 0) return "- 리뷰: 없음";
	const ps = total.findings.flatMap((n, i) => (n > 0 ? [`P${i} ${n}`] : []));
	return `- 리뷰 ${total.reviews}회: 통과 ${total.passed} · 수정 필요 ${total.failed}${ps.length ? ` (${ps.join(" · ")})` : ""}${total.docFindings > 0 ? ` · 문서 상충 ${total.docFindings}건` : ""}`;
}

/** Bounds on evidence read from a record: a persisted or malformed array must not make the gate loop unbounded. */
const REVIEW_EVIDENCE_MAX = 256;
const REVIEW_FINDINGS_MAX = 1024;

/** The review evidence an agent carries, validated; `complete: false` means no pass can be proven from it. */
export interface ReviewLedger {
	records: ReviewEvidence[];
	/** False when the field is malformed or a P0-bearing entry was dropped from the bounded log. */
	complete: boolean;
}

/**
 * The structured review history the ledger keeps on an agent, oldest first. An absent field is a record written
 * before the structured proof existed: readable, but it cannot clear a P0 or stand in for live evidence.
 */
export function reviewEvidenceOf(agent: AgentEntry): ReviewLedger {
	const entry = agent as ReviewEvidenceEntry;
	if (entry.reviewLogOverflow === true) return { records: [], complete: false };
	const raw = entry.reviewLog;
	if (raw === undefined) return { records: [], complete: true };
	if (!Array.isArray(raw) || raw.length > REVIEW_EVIDENCE_MAX) return { records: [], complete: false };
	const records: ReviewEvidence[] = [];
	for (const value of raw) {
		if (typeof value !== "object" || value === null) return { records: [], complete: false };
		const { at, correct, findings, tree, results } = value as ReviewEvidence;
		if (typeof at !== "number" || !Number.isFinite(at)) return { records: [], complete: false };
		if (correct !== undefined && typeof correct !== "boolean") return { records: [], complete: false };
		if (tree !== undefined && (typeof tree !== "string" || tree === "")) return { records: [], complete: false };
		if (!Array.isArray(findings) || findings.length > REVIEW_FINDINGS_MAX) return { records: [], complete: false };
		const parsed: ReviewFinding[] = [];
		for (const item of findings) {
			const finding = findingOf(item);
			// A malformed stored finding is not silently dropped: the log is not proof then.
			if (!finding) return { records: [], complete: false };
			parsed.push(finding);
		}
		// Scoped result verdicts exist only on a final verdict and are stored already parsed; anything else is not proof.
		let scoped: ReviewedResult[] | undefined;
		if (results !== undefined) {
			if (correct === undefined || !Array.isArray(results) || results.length === 0) return { records: [], complete: false };
			scoped = reviewedResultsIn(results);
			if (scoped.length !== results.length) return { records: [], complete: false };
		}
		records.push({
			at,
			findings: parsed,
			...(correct !== undefined ? { correct } : {}),
			...(tree !== undefined ? { tree } : {}),
			...(scoped !== undefined ? { results: scoped } : {}),
		});
	}
	return { records, complete: true };
}
