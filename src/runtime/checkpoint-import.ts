/**
 * Checkpoint import: what a resumed run may carry from the record it continues, and how each claim is re-proven now.
 *
 * A run record is session-store input, not authority. This module never trusts a stored status: an accepted row is
 * imported only when the current tree, the current session's retained artifact, or the cited source still shows the
 * exact content S1 observed. Every shape below is re-read field by field with the evidence module's bounds; unknown
 * or unbounded values reject the row instead of being copied. No answer text, stdout, patch body or working state is
 * ever persisted here — only digests, bounded paths and the host attempt reference.
 *
 * `normalizeCheckpointPlan` re-runs the plan through the plan validator against the current approved team, so a
 * stored role, job or contract that no longer exists is not imported.
 */
import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isRecord } from "../config/schema.ts";
import { usableRole } from "../policy/spawn.ts";
import {
	MAX_LANES,
	MAX_LANE_DEPENDENCIES,
	MAX_LANE_RESULTS,
	MAX_LANE_TEXT,
	MAX_RESULT_CONTAINS,
	MAX_RESULT_CRITERION,
	MAX_RESULT_ID,
	MAX_RESULT_PATH,
	RESULT_ID_RE,
	validatePlan,
} from "../plan/validate.ts";
import type { LaneKind, LaneNeed, LaneResultKind, PlanLaneResult, RunPlan, RunResult, StormConfig } from "../types.ts";
import {
	type ArtifactEvidenceSource,
	type ResultEvidenceItem,
	type ResultEvidenceLimits,
	captureSharedBaseline,
	resolveResultLimits,
	resultContractIdentity,
} from "./result-evidence.ts";
import { locateResult, projectAcceptedResult } from "./result-location.ts";

/** The bounded proof one accepted row keeps: the S1 item and, for an isolated artifact, its host-bound source. */
export interface ResultProof {
	item: ResultEvidenceItem;
	artifact?: ArtifactEvidenceSource;
}

const DIGEST = /^[0-9a-f]{64}$/u;
const UNSAFE_LINE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const UNSAFE_PATH = /[<>:"|?*]/u;
/** The same attempt-id bound the evidence modules use. */
const MAX_ATTEMPT_CHARS = 256;
/** One retained source absolute path; matches `prepareArtifact`. */
const MAX_ARTIFACT_PATH = 4_096;
/** Segments below the trusted artifacts dir: a bound, never a scan. */
const MAX_ARTIFACT_DEPTH = 16;
/** Segment bound for one answer citation re-read. */
const MAX_CITATION_DEPTH = 32;
/** The lane/result labels used only to re-read one cited file through the baseline reader. */
const CITATION_LANE = "checkpoint-answer";
const CITATION_RESULT = "checkpoint-answer";
/** A plan note is a hint, not the plan; longer text is not imported. */
const MAX_CHECKPOINT_NOTE = 1_000;
/** A persisted write scope is bounded like the evidence paths it is checked against. */
const MAX_CHECKPOINT_FILES = 64;

const KINDS: readonly LaneResultKind[] = ["change", "artifact", "answer"];
const ARTIFACT_FORMS: readonly NonNullable<ArtifactEvidenceSource["form"]>[] = ["auto", "directory", "patch", "file"];
const ARTIFACT_EVIDENCE: readonly NonNullable<ResultEvidenceItem["artifact"]>[] = ["directory", "patch", "file"];
const LANE_KINDS: readonly LaneKind[] = ["explore", "code", "run", "review", "design"];
const LANE_NEEDS: readonly LaneNeed[] = ["result", "integrated", "reviewable"];

const fail = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });

/** A digest exactly as the evidence modules write it: lowercase sha256 hex. */
function digestValue(value: unknown): string | undefined {
	return typeof value === "string" && DIGEST.test(value) ? value : undefined;
}

/** A short host label (attempt id) with no control characters or surrounding whitespace. */
function labelValue(value: unknown): string | undefined {
	if (typeof value !== "string" || value === "" || value.length > MAX_ATTEMPT_CHARS) return undefined;
	if (value.trim() !== value || UNSAFE_LINE.test(value)) return undefined;
	return value;
}

/**
 * A workspace-relative path under the plan wire's rules: no absolute/drive/home/UNC form, no empty or `.`/`..`
 * segment, no Windows-special character, no backslash and no Storm state directory. The value is never normalized.
 */
function safeRelative(value: unknown, maxChars = MAX_RESULT_PATH): string | undefined {
	if (typeof value !== "string" || value === "" || value.length > maxChars) return undefined;
	if (value.trim() !== value) return undefined;
	if (UNSAFE_LINE.test(value) || UNSAFE_PATH.test(value) || value.includes("\\")) return undefined;
	if (value.startsWith("/") || value.startsWith("~") || /^[A-Za-z]:/.test(value) || path.win32.isAbsolute(value)) return undefined;
	for (const segment of value.split("/")) {
		if (segment === "" || segment === "." || segment === "..") return undefined;
		if (segment === ".git" || segment === ".omp") return undefined;
	}
	return value;
}

function isWithin(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * A bounded copy of one accepted S1 item: only the fields a location check or a consumer needs, each re-validated.
 * `reason` is not evidence, `check` is old-run check evidence (never imported), and `checkDeferred` is not a final
 * state. Returns undefined for anything this version does not fully understand.
 */
function normalizeItem(value: unknown, bounds: Readonly<ResultEvidenceLimits>): ResultEvidenceItem | undefined {
	if (!isRecord(value)) return undefined;
	if (value.state !== "accepted" && !(value.state === "reviewable" && value.kind === "change")) return undefined;
	if (typeof value.id !== "string" || !RESULT_ID_RE.test(value.id)) return undefined;
	const identity = digestValue(value.identity);
	if (identity === undefined) return undefined;
	if (typeof value.kind !== "string" || !(KINDS as readonly string[]).includes(value.kind)) return undefined;
	if (typeof value.criterion !== "string" || value.criterion === "" || value.criterion.length > MAX_RESULT_CRITERION) return undefined;
	const attemptId = labelValue(value.attemptId);
	if (attemptId === undefined) return undefined;
	const contentVersion = digestValue(value.contentVersion);
	if (contentVersion === undefined) return undefined;

	let resultPath: string | undefined;
	if (value.path !== undefined) {
		resultPath = safeRelative(value.path, bounds.pathChars);
		if (resultPath === undefined) return undefined;
	}
	const digest = value.digest === undefined ? undefined : digestValue(value.digest);
	if (value.digest !== undefined && digest === undefined) return undefined;
	const previousDigest = value.previousDigest === undefined ? undefined : digestValue(value.previousDigest);
	if (value.previousDigest !== undefined && previousDigest === undefined) return undefined;

	let observations: NonNullable<ResultEvidenceItem["observations"]> | undefined;
	if (value.observations !== undefined) {
		if (!Array.isArray(value.observations) || value.observations.length === 0 || value.observations.length > bounds.paths) {
			return undefined;
		}
		observations = [];
		for (const raw of value.observations) {
			if (!isRecord(raw)) return undefined;
			const observedPath = safeRelative(raw.path, bounds.pathChars);
			if (observedPath === undefined || typeof raw.changed !== "boolean") return undefined;
			const observedDigest = raw.digest === undefined ? undefined : digestValue(raw.digest);
			if (raw.digest !== undefined && observedDigest === undefined) return undefined;
			const observedPrevious = raw.previousDigest === undefined ? undefined : digestValue(raw.previousDigest);
			if (raw.previousDigest !== undefined && observedPrevious === undefined) return undefined;
			observations.push({
				path: observedPath,
				changed: raw.changed,
				...(observedDigest === undefined ? {} : { digest: observedDigest }),
				...(observedPrevious === undefined ? {} : { previousDigest: observedPrevious }),
			});
		}
	}

	let artifact: ResultEvidenceItem["artifact"];
	if (value.artifact !== undefined) {
		if (typeof value.artifact !== "string" || !(ARTIFACT_EVIDENCE as readonly string[]).includes(value.artifact)) return undefined;
		if (value.kind !== "artifact") return undefined;
		artifact = value.artifact as NonNullable<ResultEvidenceItem["artifact"]>;
	}

	let citation: ResultEvidenceItem["citation"];
	if (value.citation !== undefined) {
		if (!isRecord(value.citation)) return undefined;
		const cited = safeRelative(value.citation.path, bounds.pathChars);
		if (cited === undefined) return undefined;
		let line: number | undefined;
		if (value.citation.line !== undefined) {
			if (typeof value.citation.line !== "number" || !Number.isSafeInteger(value.citation.line) || value.citation.line < 1) return undefined;
			line = value.citation.line;
		}
		const citedDigest = value.citation.digest === undefined ? undefined : digestValue(value.citation.digest);
		if (value.citation.digest !== undefined && citedDigest === undefined) return undefined;
		citation = { path: cited, ...(line === undefined ? {} : { line }), ...(citedDigest === undefined ? {} : { digest: citedDigest }) };
	}

	return {
		id: value.id,
		identity,
		kind: value.kind as LaneResultKind,
		criterion: value.criterion,
		attemptId,
		state: value.state as "accepted" | "reviewable",
		...(resultPath === undefined ? {} : { path: resultPath }),
		...(digest === undefined ? {} : { digest }),
		...(previousDigest === undefined ? {} : { previousDigest }),
		...(observations === undefined ? {} : { observations }),
		contentVersion,
		...(artifact === undefined ? {} : { artifact }),
		...(citation === undefined ? {} : { citation }),
	};
}

/** The host-bound retained source, bounded and re-shaped; the absolute path is checked for containment on import. */
function normalizeArtifact(value: unknown): ArtifactEvidenceSource | undefined {
	if (!isRecord(value)) return undefined;
	const attemptId = labelValue(value.attemptId);
	if (attemptId === undefined) return undefined;
	if (typeof value.path !== "string" || value.path === "" || value.path.length > MAX_ARTIFACT_PATH) return undefined;
	if (value.path.trim() !== value.path || UNSAFE_LINE.test(value.path) || !path.isAbsolute(value.path)) return undefined;
	let form: NonNullable<ArtifactEvidenceSource["form"]> | undefined;
	if (value.form !== undefined) {
		if (typeof value.form !== "string" || !(ARTIFACT_FORMS as readonly string[]).includes(value.form)) return undefined;
		form = value.form as NonNullable<ArtifactEvidenceSource["form"]>;
	}
	let expectedDigest: string | undefined;
	if (value.expectedDigest !== undefined) {
		if (typeof value.expectedDigest !== "string" || value.expectedDigest.length > 128) return undefined;
		const trimmed = value.expectedDigest.trim().toLowerCase();
		const hex = trimmed.startsWith("sha256:") ? trimmed.slice("sha256:".length) : trimmed;
		if (!DIGEST.test(hex)) return undefined;
		expectedDigest = hex;
	}
	return { attemptId, path: value.path, ...(form === undefined ? {} : { form }), ...(expectedDigest === undefined ? {} : { expectedDigest }) };
}

/** Whether a normalized item carries enough content facts to be re-proven at all. */
function selfConsistent(item: ResultEvidenceItem): boolean {
	if (item.digest === undefined) return false;
	if (item.kind === "answer") return item.citation !== undefined && item.citation.digest !== undefined;
	if (item.kind === "artifact" && item.artifact !== undefined) {
		// A retained artifact must say how it was read; the host source is attached by the caller.
		return true;
	}
	if (item.kind === "change" && item.path === undefined) {
		return (item.observations ?? []).some(observation => observation.changed && observation.digest !== undefined);
	}
	return true;
}

/**
 * The persistent proof of one accepted S1 item, bounded to validated scalars. `artifact` is attached only for an
 * `artifact` result whose evidence says it was a retained source; a mixed lane's single artifact source is not
 * evidence for a `change` or `answer` row. Returns undefined when no safe proof can be stored, and then the caller
 * imports nothing for that row.
 */
export function captureCheckpointProof(item: ResultEvidenceItem, artifact?: ArtifactEvidenceSource): ResultProof | undefined {
	const normalized = normalizeItem(item, resolveResultLimits(undefined));
	if (normalized === undefined || !selfConsistent(normalized)) return undefined;
	if (normalized.kind !== "artifact" || normalized.artifact === undefined) {
		// A shared artifact evaluated as an integrated change keeps no retained source; a change/answer never has one.
		return { item: normalized };
	}
	if (artifact === undefined) return { item: normalized };
	const source = normalizeArtifact(artifact);
	if (source === undefined || source.attemptId !== normalized.attemptId) return undefined;
	return { item: normalized, artifact: source };
}

export interface CheckpointProofInput {
	/** The stored ledger row; only its accepted state, identity, attempt, content version and proof are read. */
	row: RunResult;
	/** The current plan contract for the same result id (or the row's persisted contract when its lane left). */
	result: PlanLaneResult;
	/** The run's shared worktree: the only containment root for integrated content and answer citations. */
	root: string;
	/** This native session's artifacts dir: the only root a retained artifact may live under. */
	artifactsDir?: string;
	/** The planned lane's mode; an isolated artifact needs a retained host source. */
	isolated?: boolean;
	/** Re-prove a change's location only; the caller must still obtain a fresh review. */
	forReview?: true;
}

export type CheckpointProofCheck = { ok: true } | { ok: false; reason: string };

/** The persisted bounded contract of a row whose lane may have left the plan. */
function contractProblem(value: unknown): string | undefined {
	if (!isRecord(value)) return "저장된 결과 계약이 없습니다.";
	if (typeof value.id !== "string" || !RESULT_ID_RE.test(value.id)) return "저장된 결과 계약의 id가 올바르지 않습니다.";
	if (typeof value.kind !== "string" || !(KINDS as readonly string[]).includes(value.kind)) return "저장된 결과 계약의 종류가 올바르지 않습니다.";
	if (typeof value.criterion !== "string" || value.criterion === "" || value.criterion.length > MAX_RESULT_CRITERION) {
		return "저장된 결과 계약의 기준이 올바르지 않습니다.";
	}
	if (value.path !== undefined && safeRelative(value.path) === undefined) return "저장된 결과 계약의 경로가 올바르지 않습니다.";
	if (value.contains !== undefined && (typeof value.contains !== "string" || value.contains.length > MAX_RESULT_CONTAINS)) {
		return "저장된 결과 계약의 contains 값이 올바르지 않습니다.";
	}
	if (value.check !== undefined && (typeof value.check !== "string" || value.check === "")) return "저장된 결과 계약의 검사 이름이 올바르지 않습니다.";
	return undefined;
}

/**
 * A bounded projection of one persisted result contract, for a hard obligation whose old lane left the plan and
 * whose old plan no longer validates under the current team. Only the exact contract fields are copied; the result
 * follows the plan wire's own shape rules (one trimmed visible-line criterion, an exact `contains` without invisible
 * controls, a short check name). A contract this version cannot read is not an obligation it will enforce.
 */
export function normalizeCheckpointContract(value: unknown): PlanLaneResult | undefined {
	if (contractProblem(value) !== undefined || !isRecord(value)) return undefined;
	const id = value.id as string;
	const kind = value.kind as LaneResultKind;
	const criterion = value.criterion as string;
	if (criterion.trim() !== criterion || UNSAFE_LINE.test(criterion)) return undefined;
	const resultPath = value.path as string | undefined;
	const contains = value.contains as string | undefined;
	if (contains !== undefined && (contains.trim() === "" || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(contains))) {
		return undefined;
	}
	const check = value.check as string | undefined;
	if (check !== undefined && check.length > MAX_LANE_TEXT) return undefined;
	return {
		id,
		kind,
		criterion,
		...(resultPath === undefined ? {} : { path: resultPath }),
		...(contains === undefined ? {} : { contains }),
		...(check === undefined ? {} : { check }),
	};
}

/**
 * Whether one accepted stored row still holds now. The record alone accepts nothing: answers are re-read at exactly
 * the saved citation anchor, integrated changes/artifact outputs are re-located in the current parent, and a retained
 * artifact is read only from a non-symlink path physically below this session's artifacts dir. A reviewed change
 * may be located for a fresh judgement, never accepted on an old verdict. Check-backed rows always reopen.
 */
export async function revalidateCheckpointProof(input: CheckpointProofInput): Promise<CheckpointProofCheck> {
	if (!isRecord(input) || !isRecord(input.row) || !isRecord(input.result)) return fail("저장된 결과 근거의 형식이 올바르지 않습니다.");
	const row = input.row;
	const result = input.result;
	if (typeof result.id !== "string" || !RESULT_ID_RE.test(result.id)) return fail("현재 결과 계약의 id가 올바르지 않습니다.");
	if (typeof result.kind !== "string" || !(KINDS as readonly string[]).includes(result.kind)) return fail("현재 결과 계약의 종류가 올바르지 않습니다.");
	if (row.id !== result.id) return fail("저장된 결과 근거가 현재 요구와 다른 id입니다.");
	const reviewing = input.forReview === true && result.kind === "change";
	if (row.state !== "accepted" && !(reviewing && row.state === "reviewable")) return fail("저장된 결과 근거가 수용 상태가 아닙니다.");
	if (row.origin === "review" && !reviewing) return fail("리뷰로 수용된 결과는 현재 트리에서 새 판정이 필요합니다.");
	const attemptId = labelValue(row.attemptId);
	if (attemptId === undefined) return fail("저장된 결과 근거에 호스트 시도 id가 없습니다.");
	const identity = digestValue(row.identity);
	const contentVersion = digestValue(row.contentVersion);
	if (identity === undefined || contentVersion === undefined) return fail("저장된 결과 근거의 계약·내용 식별자가 올바르지 않습니다.");
	const contract = normalizeCheckpointContract(row.contract);
	if (contract === undefined) return fail("저장된 결과 계약이 올바르지 않습니다.");
	// The bounded contract is the row's own copy; it must describe the same contract as `result`.
	if (resultContractIdentity(contract) !== identity) return fail("저장된 결과 계약이 그 identity와 다릅니다.");
	if (identity !== resultContractIdentity(result)) return fail("저장된 결과 계약이 현재 요구와 다릅니다.");
	if (result.check !== undefined) return fail("필수 검사가 걸린 결과는 현재 트리에서 검사 근거를 다시 확인해야 합니다.");

	const bounds = resolveResultLimits(undefined);
	const proof = row.proof;
	if (!isRecord(proof)) return fail("저장된 결과 근거가 없습니다.");
	const item = normalizeItem(proof.item, bounds);
	if (item === undefined) return fail("저장된 결과 근거의 형식이 올바르지 않습니다.");
	if (item.state !== "accepted" && !reviewing) return fail("저장된 변경은 새 판정이 필요합니다.");
	if (item.id !== result.id || item.kind !== result.kind) return fail("저장된 결과 근거가 현재 요구와 다릅니다.");
	if (item.identity !== identity || item.attemptId !== attemptId) return fail("저장된 결과 근거의 계약이나 시도가 행과 다릅니다.");
	if (item.contentVersion !== contentVersion) return fail("저장된 결과 근거의 내용 버전이 행과 다릅니다.");
	if (!selfConsistent(item)) return fail("저장된 결과 근거에 다시 확인할 내용 다이제스트가 없습니다.");

	let artifact: ArtifactEvidenceSource | undefined;
	if (proof.artifact !== undefined) {
		if (item.kind !== "artifact" || item.artifact === undefined) {
			return fail("보존 산출물 근거는 보존된 artifact 결과에만 붙일 수 있습니다.");
		}
		artifact = normalizeArtifact(proof.artifact);
		if (artifact === undefined || artifact.attemptId !== attemptId) return fail("저장된 보존 산출물 근거가 올바르지 않습니다.");
	}
	if (input.isolated === true && item.kind === "artifact" && artifact === undefined) {
		return fail("격리 산출물에는 보존된 호스트 산출물 근거가 필요합니다.");
	}

	const projection = projectAcceptedResult({
		row: { id: row.id, state: "accepted", attemptId, identity, contentVersion },
		result,
		item: item.state === "accepted" ? item : { ...item, state: "accepted" },
		...(artifact === undefined ? {} : { artifact }),
	});
	if (!projection.ok) return fail("수용된 결과의 근거가 현재 계약과 다릅니다.");

	if (result.kind === "answer") return revalidateAnswer(item, result, input.root);

	if (artifact !== undefined) {
		const retained = await retainedArtifact(artifact, input.artifactsDir, input.root);
		if (!retained.ok) return retained;
		const location = await locateResult({
			mode: "retained",
			parentRoot: input.root,
			accepted: projection.accepted,
			expectedAttemptId: attemptId,
			limits: bounds,
		});
		if (!location.ok) return fail(`보존된 산출물을 현재 확인하지 못했습니다(${location.code}).`);
		return { ok: true };
	}

	const location = await locateResult({
		mode: "integrated",
		parentRoot: input.root,
		accepted: projection.accepted,
		expectedAttemptId: attemptId,
		limits: bounds,
	});
	if (!location.ok) return fail(`현재 트리에서 수용된 결과를 확인하지 못했습니다(${location.code}).`);
	return { ok: true };
}

/**
 * Re-reads exactly the citation S1 recorded as the anchor (its first applicable path), with the evidence reader's
 * own bounds: canonical root, contained parent, no symlink, regular file only, bounded bytes. The saved whole-file
 * (or bounded-prefix) digest is compared; no second search for another citation is made.
 */
async function revalidateAnswer(
	item: ResultEvidenceItem,
	result: PlanLaneResult,
	root: string,
): Promise<CheckpointProofCheck> {
	const citation = item.citation;
	if (citation === undefined || citation.digest === undefined) return fail("답변 출처의 저장된 다이제스트가 없습니다.");
	if (result.path !== undefined && citation.path !== result.path) return fail("답변 출처가 요구 경로와 다릅니다.");
	if (citation.path.split("/").length > MAX_CITATION_DEPTH) return fail("답변 출처 경로가 너무 깊습니다.");
	if (typeof root !== "string" || root === "") return fail("작업 트리 경로가 없습니다.");
	const read = await captureSharedBaseline({
		lane: CITATION_LANE,
		results: [{ id: CITATION_RESULT, kind: "change", criterion: "the cited source is the one S1 read", path: citation.path }],
		root,
		limits: resolveResultLimits(undefined),
	});
	if (!read.ok) return fail(`답변 출처를 기존 작업 트리에서 다시 읽지 못했습니다: ${read.reason}`);
	const entry = read.baseline.entries[0];
	if (entry === undefined || entry.state !== "file") {
		return fail(`답변 출처를 일반 파일로 읽을 수 없습니다(${entry?.detail ?? entry?.state ?? "missing"}).`);
	}
	if (entry.digest !== citation.digest) return fail("답변 출처 내용이 수용 당시와 다릅니다.");
	return { ok: true };
}

/**
 * A retained source is trusted only when it is physically below this session's native artifacts dir, outside the
 * worktree, not a symlink and unchanged between `lstat` and `realpath`. Nothing else is read here; the location check
 * then reads the resolved source under its own bounds.
 */
async function retainedArtifact(
	source: ArtifactEvidenceSource,
	artifactsDir: string | undefined,
	root: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
	if (typeof artifactsDir !== "string" || artifactsDir === "") return fail("보존 산출물을 확인할 산출물 디렉터리가 없습니다.");
	let trusted: string;
	try {
		trusted = await fs.realpath(artifactsDir);
		if (!(await fs.stat(trusted)).isDirectory()) return fail("산출물 디렉터리를 확인할 수 없습니다.");
	} catch {
		return fail("산출물 디렉터리를 확인할 수 없습니다.");
	}
	let parent: string | undefined;
	try {
		parent = await fs.realpath(root);
	} catch {
		parent = undefined;
	}
	// A session store inside the worktree cannot hold a retained result: every path under it is parent content.
	if (parent !== undefined && isWithin(parent, trusted)) return fail("산출물 디렉터리가 작업 트리 안에 있습니다.");

	let before: Stats;
	try {
		before = await fs.lstat(source.path);
	} catch {
		return fail("보존 산출물을 찾을 수 없습니다.");
	}
	if (before.isSymbolicLink()) return fail("보존 산출물 경로가 심볼릭 링크입니다.");
	if (!before.isFile() && !before.isDirectory()) return fail("보존 산출물이 일반 파일이나 디렉터리가 아닙니다.");
	let real: string;
	try {
		real = await fs.realpath(source.path);
	} catch {
		return fail("보존 산출물을 찾을 수 없습니다.");
	}
	if (!isWithin(trusted, real)) return fail("보존 산출물 경로가 이 세션의 산출물 디렉터리 밖입니다.");
	if (parent !== undefined && isWithin(parent, real)) return fail("보존 산출물이 작업 트리 안에 있습니다.");
	let resolved: Stats;
	try {
		resolved = await fs.stat(real);
	} catch {
		return fail("보존 산출물을 확인할 수 없습니다.");
	}
	if (resolved.dev !== before.dev || resolved.ino !== before.ino) return fail("보존 산출물이 확인 중 바뀌었습니다.");
	if (path.relative(trusted, real).split(path.sep).filter(Boolean).length > MAX_ARTIFACT_DEPTH) {
		return fail("보존 산출물 경로가 너무 깊습니다.");
	}
	return { ok: true };
}

/** One persisted plan lane copied field by field; `undefined` means a value this version will not import. */
function laneCopy(raw: unknown): Record<string, unknown> | undefined {
	if (!isRecord(raw)) return undefined;
	if (typeof raw.name !== "string" || raw.name.length > MAX_LANE_TEXT) return undefined;
	const lane: Record<string, unknown> = { name: raw.name };
	if (typeof raw.kind !== "string" || !(LANE_KINDS as readonly string[]).includes(raw.kind)) return undefined;
	lane.kind = raw.kind;
	// A deterministic job lane is not a person: its stored role is the internal lane-kind mapping `validatePlan`
	// derives, and passing it back would read as a role beside a job (which the plan wire rejects).
	if (raw.job !== undefined) {
		if (typeof raw.job !== "string" || raw.job.length > MAX_LANE_TEXT) return undefined;
		lane.job = raw.job;
	} else if (raw.role !== undefined) {
		if (typeof raw.role !== "string") return undefined;
		lane.role = raw.role;
	}
	if (raw.files !== undefined) {
		if (!Array.isArray(raw.files) || raw.files.length > MAX_CHECKPOINT_FILES) return undefined;
		const files: string[] = [];
		for (const file of raw.files) {
			const safe = safeRelative(file, MAX_RESULT_PATH);
			if (safe === undefined) return undefined;
			files.push(safe);
		}
		lane.files = files;
	}
	for (const key of ["goal", "isolationReason"] as const) {
		const value = raw[key];
		if (value === undefined) continue;
		if (typeof value !== "string" || value.length > MAX_LANE_TEXT) return undefined;
		lane[key] = value;
	}
	// `progress` is the old run's status text, never a fact a new run inherits: deliberately not copied.
	if (raw.results !== undefined) {
		if (!Array.isArray(raw.results) || raw.results.length < 1 || raw.results.length > MAX_LANE_RESULTS) return undefined;
		const results: Record<string, unknown>[] = [];
		for (const rawResult of raw.results) {
			if (!isRecord(rawResult)) return undefined;
			const { id, kind, criterion, path: resultPath, contains, check } = rawResult;
			if (typeof id !== "string" || id.length > MAX_RESULT_ID || !RESULT_ID_RE.test(id)) return undefined;
			if (typeof kind !== "string" || !(KINDS as readonly string[]).includes(kind)) return undefined;
			if (typeof criterion !== "string" || criterion.length > MAX_RESULT_CRITERION) return undefined;
			const result: Record<string, unknown> = { id, kind, criterion };
			if (resultPath !== undefined) {
				if (typeof resultPath !== "string" || resultPath.length > MAX_RESULT_PATH) return undefined;
				result.path = resultPath;
			}
			if (contains !== undefined) {
				if (typeof contains !== "string" || contains.length > MAX_RESULT_CONTAINS) return undefined;
				result.contains = contains;
			}
			if (check !== undefined) {
				if (typeof check !== "string" || check === "" || check.length > MAX_LANE_TEXT) return undefined;
				result.check = check;
			}
			results.push(result);
		}
		lane.results = results;
	}
	if (raw.dependsOn !== undefined) {
		if (!Array.isArray(raw.dependsOn) || raw.dependsOn.length > MAX_LANE_DEPENDENCIES) return undefined;
		const edges: Record<string, unknown>[] = [];
		for (const rawEdge of raw.dependsOn) {
			if (!isRecord(rawEdge)) return undefined;
			if (typeof rawEdge.lane !== "string" || rawEdge.lane.length > MAX_LANE_TEXT) return undefined;
			if (typeof rawEdge.need !== "string" || !(LANE_NEEDS as readonly string[]).includes(rawEdge.need)) return undefined;
			edges.push({ lane: rawEdge.lane, need: rawEdge.need });
		}
		lane.dependsOn = edges;
	}
	return lane;
}

/**
 * The old plan re-validated against the current approved team, or nothing. The stored plan is untrusted: only known
 * scalar fields are copied, a job lane's internal role is omitted so the deterministic run lane parses again, and
 * `workers` (a run-local allowance) is derived afresh. Any error, unavailable role or changed job/check definition
 * rejects the whole plan; the caller then seeds rows only, never a plan no current team approved.
 */
export function normalizeCheckpointPlan(config: StormConfig, previous: unknown): RunPlan | undefined {
	if (!isRecord(previous) || !Array.isArray(previous.lanes)) return undefined;
	if (previous.lanes.length < 1 || previous.lanes.length > MAX_LANES) return undefined;
	const lanes: Record<string, unknown>[] = [];
	for (const raw of previous.lanes) {
		const lane = laneCopy(raw);
		if (lane === undefined) return undefined;
		lanes.push(lane);
	}
	let note: string | undefined;
	if (previous.note !== undefined) {
		if (typeof previous.note !== "string") return undefined;
		const trimmed = previous.note.trim();
		if (trimmed === "" || trimmed.length > MAX_CHECKPOINT_NOTE) return undefined;
		note = trimmed;
	}
	const submitted = typeof previous.submittedAt === "string" ? Date.parse(previous.submittedAt) : Number.NaN;
	const now = Number.isFinite(submitted) ? submitted : Date.now();
	const checked = validatePlan(config, { lanes, ...(note === undefined ? {} : { note }) }, now);
	if (checked.plan === undefined || checked.errors.length > 0 || checked.outOfBounds.length > 0) return undefined;
	// `validatePlan` knows which roles exist, not which the team can still run: a disabled or modelless role is not
	// imported either. A deterministic job lane has no AI worker, so its internal lane-kind role is not checked.
	for (const lane of checked.plan.lanes) {
		if (lane.job !== undefined) continue;
		if (usableRole(config, lane.role) === undefined) return undefined;
	}
	return checked.plan;
}
