/**
 * Read-only evidence for a lane's declared results (`lane.results`).
 *
 * `lane.results` is a declaration, never proof: a worker's report, a path it names, a success claim or a command
 * string cannot authorize a read. This module accepts only the contract's fields, resolves every path under a tree
 * the caller owns (the run's shared worktree or a host-bound retained artifact), reads at most a configured number of
 * files and bytes, and refuses symlinks, escapes and non-regular files. It never shells out and never executes a
 * command from the contract; a `check` value only names one of the approved config's `requiredChecks` whose real
 * evidence the runtime supplies.
 *
 * The two halves are deliberately separate:
 * - `captureSharedBaseline` runs before the attempt and records the declared shared-tree paths. A pre-existing dirty
 *   file therefore cannot satisfy a change requirement by existing (T01).
 * - `evaluateSettledResults` runs after the attempt and compares against that baseline, reads a retained artifact
 *   only from a source bound to this attempt (never falling back to the parent checkout), or verifies a source-citing
 *   answer. An artifact declared by a shared lane uses its own pre/post tree baseline; an isolated lane requires the
 *   caller to supply its actual workspace mode and a fresh host-retained source.
 *
 * Result contract identity excludes the assigned lane and wall-clock time. Each item also carries a content-only
 * `contentVersion` (observed paths/digests and cited source version) that stays stable across a new attempt; the
 * report digest is per-attempt metadata. The run record still owns the final `done/verified` judgement: this module
 * only reports per-result `unmet`, `reviewable` and `accepted`.
 */
import { createHash } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import * as fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import * as path from "node:path";
import { MAX_RESULT_ID, MAX_RESULT_PATH, parseLaneResults } from "../plan/validate.ts";
import type { ApprovalRecord, ConfigLoad, LaneResultKind, PlanLaneResult, StormConfig } from "../types.ts";
import { checkGate, type CheckEvidence, type CheckReport, type CheckStatus } from "./checks.ts";

export type { LaneResultKind, PlanLaneResult };

export const RESULT_BASELINE_SCHEMA = "storm.result-baseline/v1";
export const RESULT_EVIDENCE_SCHEMA = "storm.result-evidence/v1";
const RESULT_IDENTITY_SCHEMA = "storm.result-identity/v1";
const RESULT_CONTENT_SCHEMA = "storm.result-content/v1";

/** The plan's result wire. Only its declared fields are read; every other key is rejected as untrusted input. */
export type LaneResult = PlanLaneResult;

/** The hard ceilings. Callers may ask for smaller limits, never larger ones. */
export interface ResultEvidenceLimits {
	/** Total pre-attempt path entries; a pathless change over `lane.files` uses one per declared file. */
	paths: number;
	pathChars: number;
	idChars: number;
	answerChars: number;
	citations: number;
	quoteChars: number;
	/** Bytes read from one file; a larger file is only attested by this prefix. */
	fileBytes: number;
	/** Bytes read across one capture/evaluation. */
	totalBytes: number;
}

export const RESULT_EVIDENCE_LIMITS: Readonly<ResultEvidenceLimits> = Object.freeze({
	paths: 32,
	// The wire parser and these two evidence bounds use the plan's own exported limits, not a second table.
	pathChars: MAX_RESULT_PATH,
	idChars: MAX_RESULT_ID,
	answerChars: 8_192,
	citations: 8,
	quoteChars: 512,
	fileBytes: 256 * 1024,
	totalBytes: 1024 * 1024,
});

/** One declared shared-tree path before the attempt. A missing entry is not an absent file: it is a contract error. */
export interface ResultBaselineEntry {
	resultId: string;
	/** `resultContractIdentity(result)` at capture time; a later contract change no longer matches. */
	identity: string;
	path: string;
	state: "absent" | "file" | "unsafe";
	bytes: number;
	/** sha256 of the observed bytes (the prefix when `truncated`), or "" when absent/unsafe. */
	digest: string;
	truncated: boolean;
	/** Why the path could not be read as a regular file (`symbolic-link`, `directory`, `outside-root`, ...). */
	detail?: string;
}

/** A pre-attempt manifest for one lane. Its digest covers the contract identities and observed states, not time. */
export interface ResultBaseline {
	schema: typeof RESULT_BASELINE_SCHEMA;
	lane: string;
	/** Present when the host allocated the attempt before the capture. */
	attemptId?: string;
	capturedAt: string;
	entries: ResultBaselineEntry[];
	digest: string;
}

/** Whether an artifact result is an ordinary shared output or a retained result of an isolated attempt. */
export type ArtifactMode = "shared" | "isolated";

export interface CaptureBaselineInput {
	lane: string;
	/** The raw `lane.results` value or an already parsed list. */
	results: unknown;
	/** The run's shared worktree. */
	root: string;
	attemptId?: string;
	/** The approved config whose `requiredChecks` a declared `check` may name; the shared plan parser validates it. */
	config?: StormConfig;
	/** Declared `lane.files`, used only for a pathless change's per-file pre/post fingerprints. */
	laneFiles?: readonly string[];
	/** Required when an artifact result is declared; never guessed from a missing patch. */
	artifactMode?: ArtifactMode;
	limits?: Partial<ResultEvidenceLimits>;
}

export type BaselineCapture = { ok: true; baseline: ResultBaseline } | { ok: false; reason: string };

/** One source path an answer cites. The quote (when present) must occur on the cited line, or anywhere without `line`. */
export interface AnswerCitation {
	path: string;
	/** 1-based line. */
	line?: number;
	quote?: string;
}

export interface AnswerSubmission {
	text: string;
	citations: AnswerCitation[];
}

/**
 * A host-bound retained artifact for one attempt: a directory tree or a single file (unified patch or plain file).
 * The caller must have obtained `path` from a host event (`SingleResult.patchPath`, registry `history.patchPath`),
 * never from model text or a previous follow-up. It must live outside the shared worktree; there is deliberately no
 * fallback to the parent checkout when an isolated lane's patch is missing.
 */
export interface ArtifactEvidenceSource {
	/** Host-owned attempt identity (never a worker role or a model-provided label). */
	attemptId: string;
	path: string;
	/** `auto` detects a patch by its header; everything else is read as a plain file. */
	form?: "auto" | "directory" | "patch" | "file";
	/** Optional host digest over the file source; a mismatch (or an unverifiable truncated source) is not accepted. */
	expectedDigest?: string;
}

/** Only `checkGate` admits these; a report from another config hash or tree is not evidence for this result. */
export interface ApprovedCheckEvidence {
	config: ConfigLoad;
	approval: ApprovalRecord | undefined;
	report: CheckReport | undefined;
	/** The settled integrated tree's fingerprint; the check report must carry the same one. */
	treeFingerprint: string;
}

export type ResultEvidenceState = "unmet" | "reviewable" | "accepted";

export interface ResultCheckView {
	name: string;
	status: CheckStatus;
	configHash: string;
	tree: string;
}

export interface ResultCitationView {
	path: string;
	line?: number;
	/** sha256 of the bounded cited file content; independent of the attempt/time. */
	digest?: string;
}

/** One declared file's before/after fact for a pathless change over `lane.files`. */
export interface ResultObservation {
	path: string;
	changed: boolean;
	digest?: string;
	previousDigest?: string;
}

/** Per-result evidence. `accepted` means only this declared result was met, never that the run is verified. */
export interface ResultEvidenceItem {
	id: string;
	identity: string;
	kind: LaneResultKind;
	criterion: string;
	attemptId: string;
	state: ResultEvidenceState;
	reason?: string;
	path?: string;
	/** sha256 of the observed evidence: changed file, artifact source/file, or answer text. */
	digest?: string;
	/** The pre-attempt digest when a shared file was observed before and after. */
	previousDigest?: string;
	/** Present for a pathless change: every declared lane file's before/after fact. */
	observations?: ResultObservation[];
	/** Content-only version (path/digests/source excerpt digest) reused across attempts while the content is unchanged. */
	contentVersion?: string;
	/** How a retained artifact was read. */
	artifact?: "directory" | "patch" | "file";
	check?: ResultCheckView;
	citation?: ResultCitationView;
	/**
	 * The content satisfied every declared condition and only an unavailable approved check kept this from being
	 * accepted. `state` is still `unmet`; callers defer the check, never the content observation.
	 */
	checkDeferred?: boolean;
}

export interface ResultEvidenceReport {
	schema: typeof RESULT_EVIDENCE_SCHEMA;
	lane: string;
	attemptId: string;
	evaluatedAt: string;
	/** The verified pre-attempt manifest, or null when no trusted baseline was supplied. */
	baselineDigest: string | null;
	results: ResultEvidenceItem[];
	accepted: number;
	reviewable: number;
	unmet: number;
	/** Every declared result is accepted. A `reviewable` submission still needs review; it is not complete. */
	complete: boolean;
	/** sha256 over the report without `evaluatedAt`/`digest`. */
	digest: string;
}

export interface EvaluateResultsInput {
	lane: string;
	/** The host-owned attempt reference; artifact evidence must be bound to exactly this value. */
	attemptId: string;
	results: unknown;
	shared: { root: string; baseline?: ResultBaseline };
	artifact?: ArtifactEvidenceSource;
	answer?: AnswerSubmission;
	checks?: ApprovedCheckEvidence;
	/** Required when an artifact result is declared: shared outputs use the tree baseline, isolated ones a retained source. */
	artifactMode?: ArtifactMode;
	/** Declared `lane.files`; a pathless change is evaluated only against exactly this captured scope. */
	laneFiles?: readonly string[];
	/** The approved config whose `requiredChecks` a declared `check` may name. Defaults to `checks.config` when valid. */
	config?: StormConfig;
	/** Cancels between bounded reads; a cancelled evaluation never reports `complete`. */
	signal?: AbortSignal;
	limits?: Partial<ResultEvidenceLimits>;
}

export type ResultEvaluation = { ok: true; report: ResultEvidenceReport } | { ok: false; reason: string };

const UNSAFE_LINE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const UNSAFE_PATH = /[<>:"|?*]/u;

const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");

function override(value: number | undefined, hard: number): number {
	if (value === undefined || !Number.isFinite(value)) return hard;
	return Math.min(Math.max(Math.floor(value), 1), hard);
}

/** Callers may tighten a bound for a small host or test, never widen the module's ceiling. */
export function resolveResultLimits(overrides: Partial<ResultEvidenceLimits> | undefined): Readonly<ResultEvidenceLimits> {
	return {
		paths: override(overrides?.paths, RESULT_EVIDENCE_LIMITS.paths),
		pathChars: override(overrides?.pathChars, RESULT_EVIDENCE_LIMITS.pathChars),
		idChars: override(overrides?.idChars, RESULT_EVIDENCE_LIMITS.idChars),
		answerChars: override(overrides?.answerChars, RESULT_EVIDENCE_LIMITS.answerChars),
		citations: override(overrides?.citations, RESULT_EVIDENCE_LIMITS.citations),
		quoteChars: override(overrides?.quoteChars, RESULT_EVIDENCE_LIMITS.quoteChars),
		fileBytes: override(overrides?.fileBytes, RESULT_EVIDENCE_LIMITS.fileBytes),
		totalBytes: override(overrides?.totalBytes, RESULT_EVIDENCE_LIMITS.totalBytes),
	};
}

function labelProblem(value: unknown, max: number, what: string): string | undefined {
	if (typeof value !== "string" || value === "") return `${what}이(가) 비어 있습니다.`;
	if (value.length > max) return `${what}이(가) ${max}자를 넘습니다.`;
	if (value.trim() !== value) return `${what} 앞뒤에 공백이 있습니다.`;
	if (UNSAFE_LINE.test(value)) return `${what}에 제어 문자가 있습니다.`;
	return undefined;
}

/**
 * A path read here (a baseline entry or an answer citation) follows the plan wire's rules: relative to the owned
 * root, no absolute/drive/home/UNC form, no empty or `.`/`..` segment, no Windows-special character and no Storm
 * state. Two spellings never silently normalize into one requirement.
 */
function safeRelativePath(value: unknown, maxChars: number): string | undefined {
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

/** One short line: the plan parser may return every problem in a lane, but a run record only needs the few that block it. */
function parsedResultReason(lane: string, errors: readonly string[]): string {
	const head = errors.slice(0, 3).join("; ");
	const rest = errors.length > 3 ? ` 외 ${errors.length - 3}건` : "";
	return `레인 '${lane}' 결과 계약이 올바르지 않습니다: ${head}${rest}`;
}

function artifactModeProblem(mode: unknown, hasArtifact: boolean): string | undefined {
	if (mode !== undefined && mode !== "shared" && mode !== "isolated") return "산출물 모드가 shared/isolated가 아닙니다.";
	if (hasArtifact && mode === undefined) return "산출물 결과에는 shared/isolated 산출물 모드가 필요합니다.";
	return undefined;
}

/** Bounded, deduplicated `lane.files` used only for pathless change fingerprints. Never a repo scan. */
function declaredFiles(value: readonly string[] | undefined, limits: Readonly<ResultEvidenceLimits>): { ok: true; files: string[] } | { ok: false; reason: string } {
	if (value === undefined) return { ok: true, files: [] };
	if (!Array.isArray(value)) return { ok: false, reason: "레인 files가 배열이 아닙니다." };
	const files: string[] = [];
	const seen = new Set<string>();
	for (const raw of value) {
		const file = safeRelativePath(raw, limits.pathChars);
		if (file === undefined) return { ok: false, reason: "레인 files에 안전하지 않은 경로가 있습니다." };
		if (seen.has(file)) continue;
		seen.add(file);
		files.push(file);
	}
	if (files.length > limits.paths) return { ok: false, reason: `레인 files가 ${limits.paths}개를 넘습니다.` };
	return { ok: true, files };
}

/**
 * Stable identity of one declared requirement. The assigned lane is deliberately not an input: an exact-contract
 * reassignment keeps the same obligation (the baseline records its lane only as metadata). Time, `progress` and
 * observed content are not inputs either.
 */
export function resultContractIdentity(result: LaneResult): string {
	return sha256(
		JSON.stringify([
			RESULT_IDENTITY_SCHEMA,
			result.id,
			result.kind,
			result.criterion,
			result.path ?? null,
			result.contains ?? null,
			result.check ?? null,
		]),
	);
}

export function resultBaselineDigest(baseline: Omit<ResultBaseline, "digest">): string {
	return sha256(
		JSON.stringify([
			baseline.schema,
			baseline.attemptId ?? null,
			baseline.entries.map(entry => [
				entry.resultId,
				entry.identity,
				entry.path,
				entry.state,
				entry.bytes,
				entry.digest,
				entry.truncated,
				entry.detail ?? null,
			]),
		]),
	);
}

export function resultEvidenceDigest(report: Omit<ResultEvidenceReport, "digest">): string {
	return sha256(
		JSON.stringify([
			report.schema,
			report.lane,
			report.attemptId,
			report.baselineDigest,
			report.accepted,
			report.reviewable,
			report.unmet,
			report.complete,
			report.results.map(item => [
				item.id,
				item.identity,
				item.kind,
				item.criterion,
				item.attemptId,
				item.state,
				item.reason ?? null,
				item.path ?? null,
				item.digest ?? null,
				item.previousDigest ?? null,
				item.observations === undefined
					? null
					: item.observations.map(observation => [observation.path, observation.changed, observation.digest ?? null, observation.previousDigest ?? null]),
				item.contentVersion ?? null,
				item.artifact ?? null,
				item.check === undefined ? null : [item.check.name, item.check.status, item.check.configHash, item.check.tree],
				item.citation === undefined ? null : [item.citation.path, item.citation.line ?? null, item.citation.digest ?? null],
				item.checkDeferred === true ? 1 : null,
			]),
		]),
	);
}

/**
 * Content-only version: same observed paths/content (and cited source version) gives the same value across a new
 * attempt or timestamp. It deliberately excludes the attempt id, lane, state, reason and report digest.
 */
function contentVersionOf(item: Omit<ResultEvidenceItem, "contentVersion">): string | undefined {
	const observed =
		item.observations !== undefined
			? item.observations.map(observation => [observation.path, observation.digest ?? null])
			: item.digest === undefined
				? undefined
				: [[item.path ?? "", item.digest]];
	if (observed === undefined) return undefined;
	return sha256(
		JSON.stringify([
			RESULT_CONTENT_SCHEMA,
			item.kind,
			item.artifact ?? null,
			observed,
			item.citation === undefined ? null : [item.citation.path, item.citation.line ?? null, item.citation.digest ?? null],
		]),
	);
}

// ── Bounded, contained reads ─────────────────────────────────────────────────────────────────

type FileState =
	| { kind: "absent" }
	| { kind: "file"; bytes: number; digest: string; truncated: boolean; content: Buffer }
	| { kind: "directory" }
	| { kind: "symlink" }
	| { kind: "other"; detail: string }
	| { kind: "budget" };

interface ReadBudget {
	remaining: number;
}

function isWithin(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function errorCode(error: unknown): string | undefined {
	const code = (error as NodeJS.ErrnoException | null | undefined)?.code;
	return typeof code === "string" ? code : undefined;
}

/** Every existing ancestor of the target must resolve inside the owned root; a symlinked parent cannot escape it. */
async function containedParent(root: string, target: string): Promise<boolean> {
	let dir = path.dirname(target);
	for (;;) {
		try {
			return isWithin(root, await fs.realpath(dir));
		} catch (error) {
			const code = errorCode(error);
			if (code !== "ENOENT" && code !== "ENOTDIR") return false;
			const parent = path.dirname(dir);
			if (parent === dir) return false;
			dir = parent;
		}
	}
}

/**
 * Reads a regular file with `O_NOFOLLOW`, verifies the inode did not change between `lstat` and `open`, and keeps at
 * most `cap` bytes (plus one lookahead byte to know the file continues). Node has no `openat`; the ancestor
 * containment check and inode check close the practical symlink/swap window, and the residual race is documented.
 */
async function readRegularFile(file: string, cap: number, budget: ReadBudget): Promise<FileState> {
	if (budget.remaining <= 0) return { kind: "budget" };
	const limit = Math.min(cap, budget.remaining);
	let before: Awaited<ReturnType<typeof fs.lstat>>;
	try {
		before = await fs.lstat(file);
	} catch (error) {
		const code = errorCode(error);
		if (code === "ENOENT") return { kind: "absent" };
		if (code === "ELOOP") return { kind: "symlink" };
		return { kind: "other", detail: "unreadable" };
	}
	if (before.isSymbolicLink()) return { kind: "symlink" };
	if (before.isDirectory()) return { kind: "directory" };
	if (!before.isFile()) return { kind: "other", detail: "not-a-regular-file" };

	let handle: FileHandle;
	try {
		handle = await fs.open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
	} catch (error) {
		const code = errorCode(error);
		if (code === "ENOENT") return { kind: "absent" };
		if (code === "ELOOP") return { kind: "symlink" };
		return { kind: "other", detail: "unreadable" };
	}
	try {
		const after = await handle.stat();
		if (!after.isFile()) return { kind: "other", detail: "not-a-regular-file" };
		if (after.dev !== before.dev || after.ino !== before.ino) return { kind: "other", detail: "changed-while-opening" };
		const buffer = Buffer.alloc(limit + 1);
		let read = 0;
		for (;;) {
			const next = await handle.read(buffer, read, buffer.length - read, read);
			if (next.bytesRead === 0) break;
			read += next.bytesRead;
			if (read === buffer.length) break;
		}
		const truncated = read > limit || after.size > limit;
		const content = buffer.subarray(0, Math.min(read, limit));
		budget.remaining -= content.length;
		return {
			kind: "file",
			bytes: after.size,
			digest: sha256(content),
			truncated,
			content: Buffer.from(content),
		};
	} finally {
		await handle.close().catch(() => undefined);
	}
}

async function readContained(root: string, relative: string, limits: Readonly<ResultEvidenceLimits>, budget: ReadBudget): Promise<FileState> {
	if (budget.remaining <= 0) return { kind: "budget" };
	const candidate = path.join(root, ...relative.split("/"));
	if (!(await containedParent(root, candidate))) return { kind: "other", detail: "outside-root" };
	return readRegularFile(candidate, limits.fileBytes, budget);
}

function unsafeDetail(state: FileState): string | undefined {
	if (state.kind === "directory") return "directory";
	if (state.kind === "symlink") return "symbolic-link";
	if (state.kind === "other") return state.detail;
	return undefined;
}

function fileContentIncludes(state: Extract<FileState, { kind: "file" }>, contains: string): boolean {
	return state.content.includes(Buffer.from(contains, "utf8"));
}

// ── Baseline capture ─────────────────────────────────────────────────────────────────────────

export async function captureSharedBaseline(input: CaptureBaselineInput): Promise<BaselineCapture> {
	const limits = resolveResultLimits(input.limits);
	const laneProblem = labelProblem(input.lane, limits.idChars, "레인 이름");
	if (laneProblem !== undefined) return { ok: false, reason: laneProblem };
	if (typeof input.root !== "string" || input.root === "") return { ok: false, reason: "작업 트리 경로가 비어 있습니다." };
	if (input.attemptId !== undefined) {
		const problem = labelProblem(input.attemptId, 256, "시도 id");
		if (problem !== undefined) return { ok: false, reason: problem };
	}
	const parsed = parseLaneResults(input.results, { config: input.config, path: `${input.lane}.results` });
	if (!parsed.ok) return { ok: false, reason: parsedResultReason(input.lane, parsed.errors) };
	const modeProblem = artifactModeProblem(input.artifactMode, parsed.results.some(result => result.kind === "artifact"));
	if (modeProblem !== undefined) return { ok: false, reason: modeProblem };
	const laneFiles = declaredFiles(input.laneFiles, limits);
	if (!laneFiles.ok) return { ok: false, reason: laneFiles.reason };

	const targets: Array<{ result: LaneResult; path: string }> = [];
	const targetKeys = new Set<string>();
	const addTarget = (result: LaneResult, file: string): void => {
		const key = `${result.id}\0${file}`;
		if (targetKeys.has(key)) return;
		targetKeys.add(key);
		targets.push({ result, path: file });
	};
	for (const result of parsed.results) {
		if (result.kind === "change") {
			if (result.path !== undefined) addTarget(result, result.path);
			else for (const file of laneFiles.files) addTarget(result, file);
		} else if (result.kind === "artifact" && input.artifactMode === "shared" && result.path !== undefined) {
			addTarget(result, result.path);
		}
	}
	if (targets.length > limits.paths) return { ok: false, reason: `사전 기준선 경로가 ${limits.paths}개를 넘습니다.` };

	let root: string;
	try {
		root = await fs.realpath(input.root);
		if (!(await fs.stat(root)).isDirectory()) return { ok: false, reason: "작업 트리가 디렉터리가 아닙니다." };
	} catch {
		return { ok: false, reason: "작업 트리를 확인할 수 없습니다." };
	}

	const budget: ReadBudget = { remaining: limits.totalBytes };
	const cache = new Map<string, FileState>();
	const entries: ResultBaselineEntry[] = [];
	for (const target of targets) {
		let state = cache.get(target.path);
		if (state === undefined) {
			state = await readContained(root, target.path, limits, budget);
			if (state.kind === "budget") return { ok: false, reason: "사전 기준선을 읽는 중 바이트 한도를 넘었습니다." };
			cache.set(target.path, state);
		}
		const detail = unsafeDetail(state);
		entries.push({
			resultId: target.result.id,
			identity: resultContractIdentity(target.result),
			path: target.path,
			state: state.kind === "file" ? "file" : state.kind === "absent" ? "absent" : "unsafe",
			bytes: state.kind === "file" ? state.bytes : 0,
			digest: state.kind === "file" ? state.digest : "",
			truncated: state.kind === "file" ? state.truncated : false,
			...(detail === undefined ? {} : { detail }),
		});
	}

	const draft: Omit<ResultBaseline, "digest"> = {
		schema: RESULT_BASELINE_SCHEMA,
		lane: input.lane,
		...(input.attemptId === undefined ? {} : { attemptId: input.attemptId }),
		capturedAt: new Date().toISOString(),
		entries,
	};
	return { ok: true, baseline: { ...draft, digest: resultBaselineDigest(draft) } };
}

// ── Baseline validation ──────────────────────────────────────────────────────────────────────

const DIGEST = /^[0-9a-f]{64}$/u;

/** A baseline is trusted only when its own manifest digest and every entry still agree. */
function baselineProblem(value: ResultBaseline, limits: Readonly<ResultEvidenceLimits>): string | undefined {
	if (typeof value !== "object" || value === null) return "사전 기준선이 객체가 아닙니다.";
	if (value.schema !== RESULT_BASELINE_SCHEMA) return "사전 기준선 스키마가 다릅니다.";
	const laneProblem = labelProblem(value.lane, limits.idChars, "기준선 레인 이름");
	if (laneProblem !== undefined) return laneProblem;
	if (value.attemptId !== undefined) {
		const problem = labelProblem(value.attemptId, 256, "기준선 시도 id");
		if (problem !== undefined) return problem;
	}
	if (typeof value.capturedAt !== "string" || value.capturedAt === "") return "기준선 캡처 시각이 없습니다.";
	if (!Array.isArray(value.entries) || value.entries.length > limits.paths) return "기준선 항목 수가 한도를 넘습니다.";
	const seen = new Set<string>();
	for (const entry of value.entries) {
		if (typeof entry !== "object" || entry === null) return "기준선 항목이 객체가 아닙니다.";
		const idProblem = labelProblem(entry.resultId, limits.idChars, "기준선 결과 id");
		if (idProblem !== undefined) return idProblem;
		if (safeRelativePath(entry.path, limits.pathChars) !== entry.path) return "기준선 경로가 안전한 상대 경로가 아닙니다.";
		const key = `${entry.resultId}\0${entry.path}`;
		if (seen.has(key)) return "기준선 결과 id와 경로가 중복됩니다.";
		seen.add(key);
		if (typeof entry.identity !== "string" || !DIGEST.test(entry.identity)) return "기준선 결과 identity가 올바르지 않습니다.";
		if (entry.state !== "absent" && entry.state !== "file" && entry.state !== "unsafe") return "기준선 상태가 올바르지 않습니다.";
		if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0) return "기준선 바이트 수가 올바르지 않습니다.";
		if (typeof entry.digest !== "string" || (entry.state === "file" ? !DIGEST.test(entry.digest) : entry.digest !== "")) {
			return "기준선 다이제스트가 올바르지 않습니다.";
		}
		if (typeof entry.truncated !== "boolean") return "기준선 절단 표시가 올바르지 않습니다.";
		if (entry.detail !== undefined && (typeof entry.detail !== "string" || entry.detail.length > 200)) return "기준선 상세가 올바르지 않습니다.";
	}
	if (typeof value.digest !== "string" || value.digest !== resultBaselineDigest(value)) return "사전 기준선 다이제스트가 일치하지 않습니다.";
	return undefined;
}

// ── Check evidence ──────────────────────────────────────────────────────────────────────────

function checkSkipReason(reason: "no-config" | "invalid-config" | "unapproved" | "no-checks"): string {
	if (reason === "no-config") return "승인된 설정이 없어 검사 근거를 쓸 수 없습니다.";
	if (reason === "invalid-config") return "설정이 유효하지 않아 검사 근거를 쓸 수 없습니다.";
	if (reason === "unapproved") return "현재 설정 hash가 승인되지 않아 검사 근거를 쓸 수 없습니다.";
	return "승인된 설정에 요구 검사가 없습니다.";
}

function evaluateCheck(
	checks: ApprovedCheckEvidence | undefined,
	name: string,
): { ok: true; evidence: CheckEvidence; configHash: string; tree: string } | { ok: false; reason: string } {
	if (checks === undefined) return { ok: false, reason: "승인된 설정의 검사 근거가 없습니다." };
	if (typeof checks.treeFingerprint !== "string" || checks.treeFingerprint === "") {
		return { ok: false, reason: "현재 트리 지문이 없어 검사 근거를 결속할 수 없습니다." };
	}
	const gate = checkGate(checks.config, checks.approval);
	if (gate.status === "skipped") return { ok: false, reason: checkSkipReason(gate.reason) };
	const configured = gate.checks.find(check => check.name === name);
	if (configured === undefined) return { ok: false, reason: `승인된 설정에 '${name}' 검사가 없습니다.` };
	const report = checks.report;
	if (report === undefined) return { ok: false, reason: `설정된 '${name}' 검사의 실행 근거가 없습니다.` };
	if (report.configHash !== gate.configHash) return { ok: false, reason: "검사가 다른 설정 hash에서 실행되었습니다." };
	if (report.fingerprint !== checks.treeFingerprint) return { ok: false, reason: "검사가 현재 트리와 다른 트리에서 실행되었습니다." };
	const evidence = report.checks.find(check => check.name === name);
	if (evidence === undefined) return { ok: false, reason: `'${name}' 검사의 실행 근거가 없습니다.` };
	if (JSON.stringify(evidence.argv) !== JSON.stringify(configured.argv)) return { ok: false, reason: `'${name}' 검사의 argv가 승인된 설정과 다릅니다.` };
	if (evidence.status !== "passed") return { ok: false, reason: `'${name}' 검사가 통과하지 않았습니다 (${evidence.status}).` };
	return { ok: true, evidence, configHash: gate.configHash, tree: report.fingerprint };
}

// ── Change evidence ─────────────────────────────────────────────────────────────────────────

/** An artifact's content evidence gains a check only as an additional condition; a passing check never replaces it. */
function applyArtifactCheck(outcome: ItemOutcome, result: LaneResult, checks: ApprovedCheckEvidence | undefined): ItemOutcome {
	if (result.check === undefined) return outcome;
	const checked = evaluateCheck(checks, result.check);
	if (!checked.ok) {
		const reason = outcome.reason === undefined ? checked.reason : `${outcome.reason} ${checked.reason}`;
		// A check that cannot be evaluated yet defers only itself: content that already failed a declared condition
		// stays unmet, and content that is a genuine submission (reviewable) waits on the check.
		const checkDeferred = checks === undefined && outcome.state === "reviewable";
		return { ...outcome, state: "unmet", reason, ...(checkDeferred ? { checkDeferred: true } : {}) };
	}
	return { ...outcome, check: { name: result.check, status: checked.evidence.status, configHash: checked.configHash, tree: checked.tree } };
}

interface ItemOutcome {
	state: ResultEvidenceState;
	reason?: string;
	digest?: string;
	previousDigest?: string;
	observations?: ResultObservation[];
	artifact?: "directory" | "patch" | "file";
	check?: ResultCheckView;
	citation?: ResultCitationView;
	/** Only an unavailable approved check blocks acceptance; the content conditions themselves passed. */
	checkDeferred?: boolean;
}

async function evaluateChange(
	result: LaneResult,
	entries: readonly ResultBaselineEntry[],
	sharedRoot: string,
	limits: Readonly<ResultEvidenceLimits>,
	budget: ReadBudget,
	cache: Map<string, FileState>,
	checks: ApprovedCheckEvidence | undefined,
): Promise<ItemOutcome> {
	const pathless = result.path === undefined;
	let targets: readonly ResultBaselineEntry[];
	if (pathless) {
		if (entries.length === 0) {
			return { state: "unmet", reason: "경로가 없는 변경 요구는 레인 files의 사전 기준선이 필요합니다." };
		}
		targets = entries;
	} else {
		const entry = entries.find(candidate => candidate.path === result.path);
		if (entry === undefined) return { state: "unmet", reason: "이 결과의 사전 기준선 항목이 없습니다." };
		targets = [entry];
	}
	for (const entry of targets) {
		if (entry.identity !== resultContractIdentity(result)) {
			return { state: "unmet", reason: "결과 계약이 사전 기준선과 달라졌습니다. 기준선을 다시 캡처해야 합니다." };
		}
		if (entry.state === "unsafe") {
			return { state: "unmet", reason: `사전 기준선 경로가 안전한 파일이 아닙니다 (${entry.detail ?? "unsafe"}).` };
		}
	}

	const observations: ResultObservation[] = [];
	const changedFiles: Array<{ entry: ResultBaselineEntry; state: Extract<FileState, { kind: "file" }> }> = [];
	let changedCount = 0;
	let firstFile: Extract<FileState, { kind: "file" }> | undefined;
	let firstPrevious: string | undefined;
	for (const entry of targets) {
		let observed = cache.get(entry.path);
		if (observed === undefined) {
			observed = await readContained(sharedRoot, entry.path, limits, budget);
			cache.set(entry.path, observed);
		}
		if (observed.kind === "budget") {
			return { state: "reviewable", reason: "읽기 바이트 한도를 넘어 현재 상태를 확인하지 못했습니다.", ...(pathless ? { observations } : {}) };
		}
		if (observed.kind === "symlink" || observed.kind === "directory" || observed.kind === "other") {
			return { state: "unmet", reason: `현재 경로를 일반 파일로 읽을 수 없습니다 (${unsafeDetail(observed) ?? "unsafe"}).`, ...(pathless ? { observations } : {}) };
		}
		const changed =
			entry.state === "absent"
				? observed.kind === "file"
				: observed.kind === "absent" || observed.bytes !== entry.bytes || observed.digest !== entry.digest;
		observations.push({
			path: entry.path,
			changed,
			...(observed.kind === "file" ? { digest: observed.digest } : {}),
			...(entry.digest === "" ? {} : { previousDigest: entry.digest }),
		});
		if (changed) changedCount += 1;
		if (observed.kind === "file") {
			firstFile ??= observed;
			firstPrevious ??= entry.digest === "" ? undefined : entry.digest;
			if (changed) changedFiles.push({ entry, state: observed });
		}
	}

	const firstChanged = changedFiles[0];
	const digest = firstChanged?.state.digest ?? firstFile?.digest;
	const previousDigest =
		firstChanged === undefined
			? firstPrevious ?? (targets[0]?.digest === "" ? undefined : targets[0]?.digest)
			: firstChanged.entry.digest === ""
				? undefined
				: firstChanged.entry.digest;
	if (changedCount === 0) {
		return {
			state: "unmet",
			reason: pathless ? "선언된 파일 중 바뀐 내용이 없습니다." : "사전 기준선 이후 바뀐 내용이 없습니다.",
			...(digest === undefined ? {} : { digest }),
			...(previousDigest === undefined ? {} : { previousDigest }),
			...(pathless ? { observations } : {}),
		};
	}

	const problems: string[] = [];
	let review: string | undefined;
	let checkProblem: string | undefined;
	let checkView: ResultCheckView | undefined;
	if (result.contains !== undefined) {
		const contains = result.contains;
		const hit = changedFiles.find(file => fileContentIncludes(file.state, contains));
		if (hit === undefined) {
			if (changedFiles.some(file => file.state.truncated)) {
				review = pathless
					? "바뀐 파일이 읽기 한도를 넘어 요구 내용을 확인하지 못했습니다."
					: "변경은 확인했지만 파일이 읽기 한도를 넘어 요구 내용을 확인하지 못했습니다.";
			} else {
				problems.push(pathless ? "바뀐 파일에 요구 문자열이 없습니다." : "변경된 내용에 요구 문자열이 없습니다.");
			}
		}
	}
	if (result.check !== undefined) {
		const checked = evaluateCheck(checks, result.check);
		if (!checked.ok) checkProblem = checked.reason;
		else checkView = { name: result.check, status: checked.evidence.status, configHash: checked.configHash, tree: checked.tree };
	}

	const outcome: ItemOutcome = {
		state: "reviewable",
		...(digest === undefined ? {} : { digest }),
		...(previousDigest === undefined ? {} : { previousDigest }),
		...(pathless ? { observations } : {}),
		...(checkView === undefined ? {} : { check: checkView }),
	};
	if (problems.length > 0) {
		return { ...outcome, state: "unmet", reason: [...problems, ...(checkProblem === undefined ? [] : [checkProblem])].join(" ") };
	}
	// A check Storm cannot evaluate yet is a deferred condition, not proof that the content is a submission. Only
	// content that passed its own conditions earns the marker; an absent change stays plain `unmet` below.
	if (checkProblem !== undefined) {
		return {
			...outcome,
			state: "unmet",
			reason: checkProblem,
			...(checks === undefined ? { checkDeferred: true } : {}),
		};
	}
	if (review !== undefined) return { ...outcome, reason: review };
	if (result.contains === undefined && result.check === undefined) {
		return {
			...outcome,
			reason: pathless
				? `선언된 파일 중 ${changedCount}개에서 변경을 확인했습니다. 완료 조건의 자연어 판단이 필요합니다.`
				: "변경을 확인했습니다. 완료 조건의 자연어 판단이 필요합니다.",
		};
	}
	return { ...outcome, state: "accepted" };
}

// ── Artifact evidence ───────────────────────────────────────────────────────────────────────

interface PatchSection {
	added: string[];
	removed: number;
	binary: boolean;
}

/** `+++ b/path` (or a quoted Git path); `/dev/null` is a deletion with no target path. */
function patchHeaderPath(header: string): string | undefined {
	let value = header.slice(4);
	const tab = value.indexOf("\t");
	if (tab >= 0) value = value.slice(0, tab);
	value = value.trim();
	if (value === "/dev/null") return undefined;
	if (value.startsWith('"')) {
		try {
			const decoded: unknown = JSON.parse(value);
			if (typeof decoded !== "string") return undefined;
			value = decoded;
		} catch {
			return undefined;
		}
	}
	if (value.startsWith("b/") || value.startsWith("a/")) value = value.slice(2);
	return value;
}

/**
 * Minimal unified-patch reader: only added lines after a `+++` header are evidence. Removed lines, context and mode
 * headers never satisfy `contains`. A malformed or binary patch is reported as such instead of guessing.
 */
function parseUnifiedPatch(text: string): Map<string, PatchSection> {
	const sections = new Map<string, PatchSection>();
	let current: PatchSection | undefined;
	let inHunk = false;
	let oldLeft = 0;
	let newLeft = 0;
	const endHunk = (): void => {
		inHunk = false;
		oldLeft = 0;
		newLeft = 0;
	};
	for (const rawLine of text.split("\n")) {
		const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
		// A file header always starts at column 0, which no hunk body line does.
		if (line.startsWith("diff --git ")) {
			current = undefined;
			endHunk();
			continue;
		}
		if (inHunk) {
			if (oldLeft <= 0 && newLeft <= 0) {
				endHunk();
			} else if (line.startsWith("\\")) {
				continue;
			} else if (line.startsWith("+")) {
				current?.added.push(line.slice(1));
				newLeft -= 1;
				continue;
			} else if (line.startsWith("-")) {
				if (current !== undefined) current.removed += 1;
				oldLeft -= 1;
				continue;
			} else if (line === "" || line.startsWith(" ")) {
				oldLeft -= 1;
				newLeft -= 1;
				continue;
			} else {
				endHunk();
			}
		}
		if (line.startsWith("+++ ")) {
			const name = patchHeaderPath(line);
			if (name === undefined) {
				current = undefined;
				continue;
			}
			current = sections.get(name) ?? { added: [], removed: 0, binary: false };
			sections.set(name, current);
			continue;
		}
		if (line.startsWith("--- ")) continue;
		if (line.startsWith("GIT binary patch") || line.startsWith("Binary files ")) {
			if (current !== undefined) current.binary = true;
			continue;
		}
		if (line.startsWith("@@")) {
			const header = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/u.exec(line);
			if (header === null) {
				endHunk();
				continue;
			}
			inHunk = true;
			oldLeft = Number(header[1] ?? 1);
			newLeft = Number(header[2] ?? 1);
			continue;
		}
	}
	return sections;
}

type PreparedArtifact =
	| { ok: false; reason: string }
	| { ok: true; state: "missing"; reason: string }
	| { ok: true; state: "directory"; root: string }
	| {
			ok: true;
			state: "patch" | "file";
			source: string;
			digest: string;
			bytes: number;
			truncated: boolean;
			content: Buffer;
			expectedDigest?: string;
	  };

function normalizeDigest(value: string): string | undefined {
	const trimmed = value.trim().toLowerCase();
	const hex = trimmed.startsWith("sha256:") ? trimmed.slice("sha256:".length) : trimmed;
	return DIGEST.test(hex) ? hex : undefined;
}

/** Resolves the single host-bound artifact for this attempt. Nothing here falls back to the shared tree. */
async function prepareArtifact(
	source: ArtifactEvidenceSource | undefined,
	attemptId: string,
	sharedRoot: string,
	limits: Readonly<ResultEvidenceLimits>,
	budget: ReadBudget,
): Promise<PreparedArtifact> {
	if (source === undefined) return { ok: true, state: "missing", reason: "시도에 결속된 보존 산출물이 없습니다." };
	if (typeof source !== "object" || source === null) return { ok: false, reason: "산출물 입력이 객체가 아닙니다." };
	if (typeof source.attemptId !== "string" || source.attemptId !== attemptId) {
		return { ok: false, reason: "산출물이 다른 시도에 결속되어 있습니다." };
	}
	if (typeof source.path !== "string" || source.path === "" || source.path.length > 4_096 || !path.isAbsolute(source.path)) {
		return { ok: false, reason: "산출물 경로는 호스트가 준 절대 경로여야 합니다." };
	}
	const form = source.form ?? "auto";
	if (form !== "auto" && form !== "directory" && form !== "patch" && form !== "file") return { ok: false, reason: "산출물 형식이 올바르지 않습니다." };
	let expectedDigest: string | undefined;
	if (source.expectedDigest !== undefined) {
		if (source.expectedDigest.length > 128) return { ok: false, reason: "호스트 산출물 다이제스트 형식이 올바르지 않습니다." };
		expectedDigest = normalizeDigest(source.expectedDigest);
		if (expectedDigest === undefined) return { ok: false, reason: "호스트 산출물 다이제스트 형식이 올바르지 않습니다." };
	}

	if (isWithin(sharedRoot, path.resolve(source.path))) {
		return { ok: false, reason: "보존 산출물이 부모 작업 트리 안에 있습니다. 부모 체크아웃을 결과로 채택할 수 없습니다." };
	}
	let before: Stats;
	try {
		before = await fs.lstat(source.path);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return { ok: true, state: "missing", reason: "보존 산출물을 찾을 수 없습니다." };
		return { ok: true, state: "missing", reason: "보존 산출물을 읽을 수 없습니다." };
	}
	if (before.isSymbolicLink()) return { ok: false, reason: "산출물 경로가 심볼릭 링크입니다." };
	let real: string;
	try {
		real = await fs.realpath(source.path);
	} catch {
		return { ok: true, state: "missing", reason: "보존 산출물을 확인할 수 없습니다." };
	}
	if (isWithin(sharedRoot, real)) {
		return { ok: false, reason: "보존 산출물이 부모 작업 트리를 가리킵니다." };
	}
	let resolved: Stats;
	try {
		resolved = await fs.stat(real);
	} catch {
		return { ok: true, state: "missing", reason: "보존 산출물을 확인할 수 없습니다." };
	}
	if (resolved.dev !== before.dev || resolved.ino !== before.ino) {
		return { ok: true, state: "missing", reason: "보존 산출물이 확인 중 바뀌었습니다." };
	}

	if (before.isDirectory()) {
		if (form === "patch" || form === "file") return { ok: false, reason: "산출물 형식이 디렉터리와 맞지 않습니다." };
		if (expectedDigest !== undefined) return { ok: false, reason: "디렉터리 산출물에는 파일 다이제스트를 적용할 수 없습니다." };
		return { ok: true, state: "directory", root: real };
	}
	if (!before.isFile()) return { ok: false, reason: "산출물이 일반 파일이나 디렉터리가 아닙니다." };
	if (form === "directory") return { ok: false, reason: "산출물 형식이 파일과 맞지 않습니다." };

	const read = await readRegularFile(real, limits.fileBytes, budget);
	if (read.kind === "budget") return { ok: true, state: "missing", reason: "읽기 바이트 한도를 넘어 산출물을 확인하지 못했습니다." };
	if (read.kind !== "file") return { ok: true, state: "missing", reason: "보존 산출물을 일반 파일로 읽을 수 없습니다." };
	const usePatch = form === "patch" || (form === "auto" && (read.content.includes(0) === false && isPatchText(read.content.toString("utf8"))));
	return {
		ok: true,
		state: usePatch ? "patch" : "file",
		source: real,
		digest: read.digest,
		bytes: read.bytes,
		truncated: read.truncated,
		content: read.content,
		...(expectedDigest === undefined ? {} : { expectedDigest }),
	};
}

function isPatchText(text: string): boolean {
	return /(^|\n)diff --git /u.test(text) || /(^|\n)--- [^\n]*\n\+\+\+ [^\n]*\n/u.test(text);
}

function expectedDigestProblem(prepared: Extract<PreparedArtifact, { ok: true; state: "patch" | "file" }>): ItemOutcome | undefined {
	if (prepared.expectedDigest === undefined) return undefined;
	if (prepared.truncated) {
		return { state: "reviewable", reason: "산출물이 읽기 한도를 넘어 호스트 다이제스트를 확인하지 못했습니다." };
	}
	if (prepared.digest !== prepared.expectedDigest) {
		return { state: "unmet", reason: "산출물 다이제스트가 호스트 결속과 다릅니다." };
	}
	return undefined;
}

async function evaluateArtifact(
	result: LaneResult,
	prepared: PreparedArtifact,
	limits: Readonly<ResultEvidenceLimits>,
	budget: ReadBudget,
): Promise<ItemOutcome> {
	if (!prepared.ok) return { state: "unmet", reason: prepared.reason };
	if (prepared.state === "missing") return { state: "unmet", reason: prepared.reason };
	if (prepared.state !== "directory") {
		const digestProblem = expectedDigestProblem(prepared);
		if (digestProblem !== undefined) return { ...digestProblem, artifact: prepared.state, digest: prepared.digest };
	}
	if (result.path === undefined) {
		if (result.contains !== undefined) {
			return { state: "unmet", reason: "contains를 확인할 경로가 없습니다.", artifact: prepared.state, ...(prepared.state === "directory" ? {} : { digest: prepared.digest }) };
		}
		return {
			state: "reviewable",
			reason: "경로가 없는 산출물 요구입니다. 제출된 산출물의 자연어 판단이 필요합니다.",
			artifact: prepared.state,
			...(prepared.state === "directory" ? {} : { digest: prepared.digest }),
		};
	}
	const declared = result.path;

	if (prepared.state === "directory") {
		const state = await readContained(prepared.root, declared, limits, budget);
		if (state.kind === "budget") return { state: "reviewable", reason: "읽기 바이트 한도를 넘어 산출물을 확인하지 못했습니다." };
		if (state.kind === "absent") return { state: "unmet", reason: "보존 산출물에 요구 경로가 없습니다." };
		if (state.kind === "directory") {
			return result.contains === undefined
				? { state: "reviewable", reason: "디렉터리 산출물이 있습니다. 자연어 판단이 필요합니다.", artifact: "directory" }
				: { state: "unmet", reason: "디렉터리에서는 요구 문자열을 확인할 수 없습니다.", artifact: "directory" };
		}
		if (state.kind !== "file") return { state: "unmet", reason: `산출물 경로를 일반 파일로 읽을 수 없습니다 (${unsafeDetail(state) ?? "unsafe"}).`, artifact: "directory" };
		if (result.contains === undefined) return { state: "reviewable", reason: "산출물을 확인했습니다. 자연어 판단이 필요합니다.", artifact: "directory", digest: state.digest };
		if (fileContentIncludes(state, result.contains)) return { state: "accepted", artifact: "directory", digest: state.digest };
		return state.truncated
			? { state: "reviewable", reason: "산출물이 읽기 한도를 넘어 요구 문자열을 확인하지 못했습니다.", artifact: "directory", digest: state.digest }
			: { state: "unmet", reason: "산출물 내용에 요구 문자열이 없습니다.", artifact: "directory", digest: state.digest };
	}

	if (prepared.state === "patch") {
		const text = prepared.content.toString("utf8");
		const binary = text.includes("\0");
		const section = parseUnifiedPatch(text).get(declared);
		if (section === undefined) {
			return prepared.truncated
				? { state: "reviewable", reason: "패치가 읽기 한도를 넘어 요구 경로를 확인하지 못했습니다.", artifact: "patch", digest: prepared.digest }
				: { state: "unmet", reason: "패치에 요구 경로가 없습니다.", artifact: "patch", digest: prepared.digest };
		}
		if (section.binary || binary) {
			return result.contains === undefined
				? { state: "reviewable", reason: "바이너리 패치 산출물입니다. 자연어 판단이 필요합니다.", artifact: "patch", digest: prepared.digest }
				: { state: "unmet", reason: "바이너리 패치에서는 요구 문자열을 확인할 수 없습니다.", artifact: "patch", digest: prepared.digest };
		}
		if (result.contains === undefined) {
			return { state: "reviewable", reason: "패치에 해당 경로의 변경이 있습니다. 자연어 판단이 필요합니다.", artifact: "patch", digest: prepared.digest };
		}
		if (section.added.join("\n").includes(result.contains)) {
			return { state: "accepted", artifact: "patch", digest: prepared.digest };
		}
		return prepared.truncated
			? { state: "reviewable", reason: "패치가 읽기 한도를 넘어 요구 문자열을 확인하지 못했습니다.", artifact: "patch", digest: prepared.digest }
			: { state: "unmet", reason: "패치의 추가 내용에 요구 문자열이 없습니다.", artifact: "patch", digest: prepared.digest };
	}

	if (path.basename(prepared.source) !== declared) {
		return { state: "unmet", reason: "단일 파일 산출물의 이름이 요구 경로와 다릅니다.", artifact: "file", digest: prepared.digest };
	}
	const state: Extract<FileState, { kind: "file" }> = {
		kind: "file",
		bytes: prepared.bytes,
		digest: prepared.digest,
		truncated: prepared.truncated,
		content: prepared.content,
	};
	if (result.contains === undefined) return { state: "reviewable", reason: "산출물을 확인했습니다. 자연어 판단이 필요합니다.", artifact: "file", digest: prepared.digest };
	if (fileContentIncludes(state, result.contains)) return { state: "accepted", artifact: "file", digest: prepared.digest };
	return prepared.truncated
		? { state: "reviewable", reason: "산출물이 읽기 한도를 넘어 요구 문자열을 확인하지 못했습니다.", artifact: "file", digest: prepared.digest }
		: { state: "unmet", reason: "산출물 내용에 요구 문자열이 없습니다.", artifact: "file", digest: prepared.digest };
}

// ── Answer evidence ─────────────────────────────────────────────────────────────────────────

interface VerifiedCitation {
	path: string;
	line?: number;
	content: string;
	truncated: boolean;
	digest: string;
	/** The cited line or quote; absent for a path-only citation, which cannot support a factual answer by itself. */
	excerpt?: string;
}

/**
 * Numeric facts only: file names and citation line references are stripped first so `report.json:2` cannot make the
 * answer look like it states `2`. A decimal is one fact; a number inside a longer token (`142`, `v2`) is not split. A
 * leading sign that is not part of a range or identifier is part of the fact, so `-42` and `42` are different facts
 * (U+2212 is a minus; `+42` and `-0` are the unsigned value).
 */
function numericFacts(text: string): string[] {
	const cleaned = text
		.replace(/\b[A-Za-z][A-Za-z0-9._/-]*\.(?:json|md|txt|ts|tsx|js|jsx|mjs|cjs|yaml|yml|toml|log|patch|diff)(?::\d+)?/giu, " ")
		.replace(/\b[A-Za-z][A-Za-z0-9+.-]*:\/\/\S+/gu, " ");
	const values: string[] = [];
	for (const match of cleaned.matchAll(/(?<![\p{L}\p{N}_.])([-+\u2212](?=\d))?(\d+(?:\.\d+)?)(?![\p{L}\p{N}_.])/gu)) {
		const digits = match[2];
		if (digits === undefined) continue;
		values.push(signedNumber(match[1], digits));
	}
	return values;
}

function signedNumber(sign: string | undefined, digits: string): string {
	const negative = sign === "-" || sign === "\u2212";
	return negative && /[1-9]/u.test(digits) ? `-${digits}` : digits;
}

/** A spelled-out sign makes a bare digit unreliable as a numeric fact; such an answer is never judged by its digits. */
const SIGN_WORD = /(?:^|[^\p{L}])(?:minus|negative|positive|음수|양수|마이너스|플러스)(?:[^\p{L}]|$)/iu;

/** Comparison form: case, whitespace, wrapping quotes/backticks and one trailing sentence stop are not content. */
function canonicalText(value: string): string {
	return value
		.normalize("NFKC")
		.replace(/\u2212/gu, "-")
		.replace(/\s+/gu, " ")
		.trim()
		.replace(/[.。!！]+$/u, "")
		.trim()
		.replace(/^[`"'\u201c\u2018]+|[`"'\u201d\u2019]+$/gu, "")
		.trim()
		.toLowerCase();
}

/** One typed scalar: a signed number, a boolean, null or a quoted string. Bare prose is never a scalar. */
type Scalar = { type: "number" | "boolean" | "null" | "string"; value: string };

function scalarOf(raw: string): Scalar | undefined {
	const text = raw.normalize("NFKC").replace(/\u2212/gu, "-").trim().replace(/[,;]$/u, "").trim();
	const number = /^([-+]?)(\d+(?:\.\d+)?)$/u.exec(text);
	if (number !== null) return { type: "number", value: signedNumber(number[1], number[2] as string) };
	const lower = text.toLowerCase();
	if (lower === "true" || lower === "false") return { type: "boolean", value: lower };
	if (lower === "null") return { type: "null", value: "null" };
	const quoted = /^(["'`])(.*)\1$/u.exec(text);
	if (quoted !== null && quoted[2] !== undefined && !/["'`]/u.test(quoted[2])) return { type: "string", value: quoted[2] };
	return undefined;
}

/** `key: value`, `key = value` or `"key": value` on one line, with a typed scalar value. Anything else is not typed. */
function typedPairOf(raw: string): { key: string; value: Scalar } | undefined {
	const text = raw.trim();
	if (text.includes("\n")) return undefined;
	const pair = /^["'`]?([A-Za-z_][A-Za-z0-9_.-]*)["'`]?\s*[:=]\s*(.+)$/u.exec(text);
	if (pair === null || pair[1] === undefined || pair[2] === undefined) return undefined;
	const value = scalarOf(pair[2]);
	return value === undefined ? undefined : { key: pair[1].toLowerCase(), value };
}

/** The typed value a whole text states: a bare scalar or one `key: value` pair; prose has none. */
function typedValueOf(text: string): { key?: string; value: Scalar } | undefined {
	const scalar = scalarOf(text.trim().replace(/[.。]$/u, ""));
	if (scalar !== undefined) return { value: scalar };
	return typedPairOf(text);
}

/** A trailing `(file.ext:line)` reference list is the answer's citation, not its content. */
const TRAILING_REFERENCE = /\s*\((?:[A-Za-z0-9_./-]+\.[A-Za-z0-9]+(?::\d+)?)(?:\s*,\s*[A-Za-z0-9_./-]+\.[A-Za-z0-9]+(?::\d+)?)*\)\s*([.。]?)\s*$/u;

/**
 * The typed value a whole answer states: what `typedValueOf` reads, or exactly `[the] <key> is|equals <scalar>` with at
 * most a trailing citation reference. Any other word (`not`, `about`, a second clause) leaves the answer untyped.
 */
function answerTypedValueOf(answer: string): { key?: string; value: Scalar } | undefined {
	const text = answer.replace(TRAILING_REFERENCE, "$1").trim();
	const typed = typedValueOf(text);
	if (typed !== undefined) return typed;
	const statement = /^(?:the\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s+(?:is|equals)\s+(.+?)\s*[.。]?$/iu.exec(text);
	if (statement === null || statement[1] === undefined || statement[2] === undefined) return undefined;
	const value = scalarOf(statement[2]);
	return value === undefined ? undefined : { key: statement[1].toLowerCase(), value };
}

type AnswerAgreement = "supported" | "contradicted" | "unverifiable";

/**
 * Deterministic agreement between a whole answer and one cited statement, with no token-overlap heuristic:
 * - the same text (after `canonicalText`) is support;
 * - a typed answer (a bare scalar, `key: value` or `the key is value` for the cited key) against the cited
 *   statement's typed value is support when equal and a contradiction when it differs;
 * - everything else, including prose that repeats a cited word or number, is unverifiable and needs review.
 */
function typedAgreement(answer: string, statement: string): AnswerAgreement {
	if (canonicalText(answer) !== "" && canonicalText(answer) === canonicalText(statement)) return "supported";
	const cited = typedValueOf(statement);
	const given = answerTypedValueOf(answer);
	if (cited === undefined || given === undefined) return "unverifiable";
	if (given.key !== undefined && cited.key !== undefined && given.key !== cited.key) return "unverifiable";
	if (given.key !== undefined && cited.key === undefined) return "unverifiable";
	return given.value.type === cited.value.type && given.value.value === cited.value.value ? "supported" : "contradicted";
}

/**
 * A factual answer without `contains` is accepted only on exact or typed agreement with a verified citation's own
 * excerpt. A typed mismatch is not proof of a wrong answer here (the cited line may not be the deciding one), so it
 * stays reviewable like any natural-language answer.
 */
function answerAligns(answer: string, excerpt: string): boolean {
	return typedAgreement(answer, excerpt) === "supported";
}

/**
 * A declared `contains` must support the reported answer, not only exist somewhere in the file. Support is the
 * literal itself, the cited line verbatim, or the same typed value (so `7`, `142` and `-42` never pass for `42`). An
 * answer whose signed numbers include one the literal does not state contradicts it; prose that merely repeats the
 * literal's number or words is unverifiable and goes to review instead of being accepted.
 */
function containsAgreement(answer: string, contains: string, excerpt: string | undefined): AnswerAgreement {
	const literal = typedAgreement(answer, contains);
	if (literal !== "unverifiable") return literal;
	if (excerpt !== undefined && typedAgreement(answer, excerpt) === "supported") return "supported";
	const requiredFacts = numericFacts(contains);
	if (requiredFacts.length === 0 || SIGN_WORD.test(answer)) return "unverifiable";
	const answerFacts = numericFacts(answer);
	// A new (or sign-flipped) number in the answer contradicts the declared fact; merely repeating one is not support.
	if (answerFacts.some(fact => !requiredFacts.includes(fact))) return "contradicted";
	return "unverifiable";
}

async function evaluateAnswer(
	result: LaneResult,
	answer: AnswerSubmission | undefined,
	sharedRoot: string,
	limits: Readonly<ResultEvidenceLimits>,
	budget: ReadBudget,
): Promise<ItemOutcome> {
	if (answer === undefined) return { state: "unmet", reason: "답변 제출이 없습니다." };
	if (typeof answer !== "object" || answer === null) return { state: "unmet", reason: "답변 형식이 올바르지 않습니다." };
	if (typeof answer.text !== "string" || answer.text.trim() === "") return { state: "unmet", reason: "답변 내용이 비어 있습니다." };
	if (answer.text.length > limits.answerChars) return { state: "unmet", reason: `답변이 ${limits.answerChars}자를 넘습니다.` };
	if (!Array.isArray(answer.citations)) return { state: "unmet", reason: "답변에 출처 목록이 없습니다." };
	if (answer.citations.length > limits.citations) return { state: "unmet", reason: `출처가 ${limits.citations}개를 넘습니다.` };

	const digest = sha256(answer.text);
	const verified: VerifiedCitation[] = [];
	let truncatedSource = false;
	for (const citation of answer.citations) {
		if (typeof citation !== "object" || citation === null) continue;
		const cited = safeRelativePath(citation.path, limits.pathChars);
		if (cited === undefined) continue;
		if (citation.line !== undefined && (!Number.isSafeInteger(citation.line) || citation.line < 1)) continue;
		if (citation.quote !== undefined && (typeof citation.quote !== "string" || citation.quote === "" || citation.quote.length > limits.quoteChars)) continue;
		const state = await readContained(sharedRoot, cited, limits, budget);
		if (state.kind === "budget") return { state: "reviewable", reason: "읽기 바이트 한도를 넘어 답변 출처를 모두 확인하지 못했습니다.", digest };
		if (state.kind !== "file") continue;
		const content = state.content.toString("utf8");
		if (state.truncated) truncatedSource = true;
		let excerpt: string | undefined;
		if (citation.line !== undefined) {
			const lines = content.split("\n");
			const line = lines[citation.line - 1];
			if (line === undefined) continue;
			if (citation.quote !== undefined && !line.includes(citation.quote)) continue;
			excerpt = citation.quote ?? line;
		} else if (citation.quote !== undefined) {
			if (!content.includes(citation.quote)) continue;
			excerpt = citation.quote;
		}
		verified.push({
			path: cited,
			...(citation.line === undefined ? {} : { line: citation.line }),
			content,
			truncated: state.truncated,
			digest: state.digest,
			...(excerpt === undefined ? {} : { excerpt }),
		});
	}

	const pathMatched = (citation: VerifiedCitation): boolean => result.path === undefined || citation.path === result.path;
	const viewOf = (citation: VerifiedCitation): ResultCitationView => ({
		path: citation.path,
		...(citation.line === undefined ? {} : { line: citation.line }),
		digest: citation.digest,
	});
	const contains = result.contains;
	if (verified.length === 0) return { state: "unmet", reason: "검증 가능한 출처를 인용하지 않았습니다.", digest };

	const first = verified.find(pathMatched) ?? verified[0] as VerifiedCitation;
	const citationView = viewOf(first);
	if (result.path !== undefined && !verified.some(citation => citation.path === result.path)) {
		return { state: "unmet", reason: "요구 경로를 인용한 출처가 없습니다.", digest };
	}
	if (contains !== undefined) {
		// The declared literal must be in the cited line/quote when one exists, not merely elsewhere in the file.
		const anchor = verified.find(citation => pathMatched(citation) && (citation.excerpt ?? citation.content).includes(contains));
		if (anchor === undefined) {
			return truncatedSource
				? { state: "reviewable", reason: "출처가 읽기 한도를 넘어 요구 내용을 확인하지 못했습니다.", digest, citation: citationView }
				: { state: "unmet", reason: "인용한 위치에서 요구 내용을 확인하지 못했습니다.", digest, citation: citationView };
		}
		const agreement = containsAgreement(answer.text, contains, anchor.excerpt);
		if (agreement === "supported") return { state: "accepted", digest, citation: viewOf(anchor) };
		if (agreement === "contradicted") {
			return { state: "unmet", reason: "답변의 값(수치·부호·타입)이 인용한 요구 내용과 다릅니다.", digest, citation: viewOf(anchor) };
		}
		return { state: "reviewable", reason: "출처는 요구 내용을 포함하지만 답변과의 일치를 기계적으로 확인하지 못했습니다. 자연어 판단이 필요합니다.", digest, citation: viewOf(anchor) };
	}
	const aligned = verified.find(citation => pathMatched(citation) && citation.excerpt !== undefined && answerAligns(answer.text, citation.excerpt));
	if (aligned !== undefined) return { state: "accepted", digest, citation: viewOf(aligned) };
	return {
		state: "reviewable",
		reason: "출처는 확인했지만 답변과 출처의 일치를 기계적으로 확인하지 못했습니다. 자연어 판단이 필요합니다.",
		digest,
		citation: citationView,
	};
}

// ── Answer receipt re-verification ─────────────────────────────────────────────────────────

/** The recorded answer evidence a caller re-checks: the anchor citation S1 read and the content version it formed. */
export interface AnswerReceipt {
	kind: LaneResultKind;
	/** The declared result path; when present the anchor must cite exactly it. */
	path?: string;
	/** sha256 of the answer text S1 judged. */
	digest?: string;
	citation?: ResultCitationView;
	contentVersion?: string;
}

export type AnswerReceiptCheck = { ok: true } | { ok: false; reason: string };

/**
 * Re-reads an answer's recorded anchor citation now, with the evaluator's own bounded, contained reader, and compares
 * the bytes S1 judged. A deleted, replaced, symlinked or otherwise unreadable source, a receipt whose content version
 * no longer describes its own answer/citation digests, or (with `expectedVersion`) a receipt for another submission
 * is not a usable answer. Nothing is searched for a different citation and no answer text is re-judged here.
 */
export async function verifyAnswerReceipt(input: {
	root: string;
	receipt: AnswerReceipt;
	/** The content version the caller's row holds; the receipt must be for exactly that submission. */
	expectedVersion?: string | undefined;
	limits?: Partial<ResultEvidenceLimits>;
}): Promise<AnswerReceiptCheck> {
	const limits = resolveResultLimits(input.limits);
	const receipt = input.receipt;
	if (typeof receipt !== "object" || receipt === null || receipt.kind !== "answer") return { ok: false, reason: "답변 근거가 아닙니다." };
	const citation = receipt.citation;
	if (citation === undefined || typeof citation.digest !== "string" || !DIGEST.test(citation.digest)) {
		return { ok: false, reason: "답변 출처의 저장된 다이제스트가 없습니다." };
	}
	if (typeof receipt.digest !== "string" || !DIGEST.test(receipt.digest)) return { ok: false, reason: "답변 내용의 저장된 다이제스트가 없습니다." };
	const cited = safeRelativePath(citation.path, limits.pathChars);
	if (cited === undefined) return { ok: false, reason: "답변 출처 경로가 안전한 상대 경로가 아닙니다." };
	if (receipt.path !== undefined && receipt.path !== cited) return { ok: false, reason: "답변 출처가 요구 경로와 다릅니다." };
	const version = contentVersionOf({
		kind: "answer",
		...(receipt.path === undefined ? {} : { path: receipt.path }),
		digest: receipt.digest,
		citation,
	} as Omit<ResultEvidenceItem, "contentVersion">);
	if (receipt.contentVersion !== undefined && receipt.contentVersion !== version) {
		return { ok: false, reason: "답변 근거의 내용 버전이 답변·출처 다이제스트와 다릅니다." };
	}
	if (input.expectedVersion !== undefined && input.expectedVersion !== version) {
		return { ok: false, reason: "답변 근거가 현재 제출과 다릅니다." };
	}
	if (typeof input.root !== "string" || input.root === "") return { ok: false, reason: "작업 트리 경로가 비어 있습니다." };
	let root: string;
	try {
		root = await fs.realpath(input.root);
		if (!(await fs.stat(root)).isDirectory()) return { ok: false, reason: "작업 트리가 디렉터리가 아닙니다." };
	} catch {
		return { ok: false, reason: "작업 트리를 확인할 수 없습니다." };
	}
	const state = await readContained(root, cited, limits, { remaining: limits.totalBytes });
	if (state.kind === "absent") return { ok: false, reason: `답변 출처 ${cited}이(가) 삭제되었습니다.` };
	if (state.kind !== "file") return { ok: false, reason: `답변 출처를 일반 파일로 읽을 수 없습니다(${unsafeDetail(state) ?? state.kind}).` };
	if (state.digest !== citation.digest) return { ok: false, reason: `답변 출처 ${cited}의 내용이 답변 당시와 다릅니다.` };
	return { ok: true };
}

// ── Settled evaluation ──────────────────────────────────────────────────────────────────────

export async function evaluateSettledResults(input: EvaluateResultsInput): Promise<ResultEvaluation> {
	const limits = resolveResultLimits(input.limits);
	const laneProblem = labelProblem(input.lane, limits.idChars, "레인 이름");
	if (laneProblem !== undefined) return { ok: false, reason: laneProblem };
	const attemptProblem = labelProblem(input.attemptId, 256, "시도 id");
	if (attemptProblem !== undefined) return { ok: false, reason: attemptProblem };
	const config = input.config ?? (input.checks?.config.status === "ok" ? input.checks.config.config : undefined);
	const parsed = parseLaneResults(input.results, { config, path: `${input.lane}.results` });
	if (!parsed.ok) return { ok: false, reason: parsedResultReason(input.lane, parsed.errors) };
	const modeProblem = artifactModeProblem(input.artifactMode, parsed.results.some(result => result.kind === "artifact"));
	if (modeProblem !== undefined) return { ok: false, reason: modeProblem };
	const laneFiles = declaredFiles(input.laneFiles, limits);
	if (!laneFiles.ok) return { ok: false, reason: laneFiles.reason };

	if (typeof input.shared?.root !== "string" || input.shared.root === "") return { ok: false, reason: "작업 트리 경로가 비어 있습니다." };
	let sharedRoot: string;
	try {
		sharedRoot = await fs.realpath(input.shared.root);
		if (!(await fs.stat(sharedRoot)).isDirectory()) return { ok: false, reason: "작업 트리가 디렉터리가 아닙니다." };
	} catch {
		return { ok: false, reason: "작업 트리를 확인할 수 없습니다." };
	}

	const baseline = input.shared.baseline;
	if (baseline !== undefined) {
		const problem = baselineProblem(baseline, limits);
		if (problem !== undefined) return { ok: false, reason: problem };
		// `lane` on the baseline is metadata; the contract identities decide whether an entry still applies.
		if (baseline.attemptId !== undefined && baseline.attemptId !== input.attemptId) {
			return { ok: false, reason: "사전 기준선이 다른 시도에 결속되어 있습니다." };
		}
	}
	const baselineEntries = new Map<string, ResultBaselineEntry[]>();
	for (const entry of baseline?.entries ?? []) {
		const list = baselineEntries.get(entry.resultId) ?? [];
		list.push(entry);
		baselineEntries.set(entry.resultId, list);
	}
	const budget: ReadBudget = { remaining: limits.totalBytes };
	const changeCache = new Map<string, FileState>();

	const needsArtifact = input.artifactMode === "isolated" && parsed.results.some(result => result.kind === "artifact");
	const preparedArtifact = needsArtifact
		? await prepareArtifact(input.artifact, input.attemptId, sharedRoot, limits, budget)
		: undefined;
	if (preparedArtifact !== undefined && !preparedArtifact.ok) return preparedArtifact;

	const items: ResultEvidenceItem[] = [];
	for (const result of parsed.results) {
		if (input.signal?.aborted === true) return { ok: false, reason: "결과 평가가 취소되었습니다." };
		let outcome: ItemOutcome;
		if (result.kind === "change") {
			const entries = baselineEntries.get(result.id) ?? [];
			if (result.path === undefined) {
				const actual = [...new Set(entries.map(entry => entry.path))].sort();
				const expected = [...laneFiles.files].sort();
				if (expected.length === 0) {
					outcome = { state: "unmet", reason: "경로가 없는 변경 요구는 레인 files가 필요합니다." };
				} else if (JSON.stringify(actual) !== JSON.stringify(expected)) {
					outcome = { state: "unmet", reason: "사전 기준선 파일 범위가 현재 레인 files와 다릅니다." };
				} else {
					outcome = await evaluateChange(result, entries, sharedRoot, limits, budget, changeCache, input.checks);
				}
			} else {
				outcome = await evaluateChange(result, entries, sharedRoot, limits, budget, changeCache, input.checks);
			}
		} else if (result.kind === "artifact") {
			if (input.artifactMode === "shared") {
				outcome = result.path === undefined
					? { state: "unmet", reason: "공유 산출물에는 path가 필요합니다." }
					: await evaluateChange(result, baselineEntries.get(result.id) ?? [], sharedRoot, limits, budget, changeCache, input.checks);
			} else {
				outcome = applyArtifactCheck(await evaluateArtifact(result, preparedArtifact as PreparedArtifact, limits, budget), result, input.checks);
			}
		} else {
			outcome = await evaluateAnswer(result, input.answer, sharedRoot, limits, budget);
		}
		const base: Omit<ResultEvidenceItem, "contentVersion"> = {
			id: result.id,
			identity: resultContractIdentity(result),
			kind: result.kind,
			criterion: result.criterion,
			attemptId: input.attemptId,
			state: outcome.state,
			...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
			...(result.path === undefined ? {} : { path: result.path }),
			...(outcome.digest === undefined ? {} : { digest: outcome.digest }),
			...(outcome.previousDigest === undefined ? {} : { previousDigest: outcome.previousDigest }),
			...(outcome.observations === undefined ? {} : { observations: outcome.observations }),
			...(outcome.artifact === undefined ? {} : { artifact: outcome.artifact }),
			...(outcome.check === undefined ? {} : { check: outcome.check }),
			...(outcome.citation === undefined ? {} : { citation: outcome.citation }),
			...(outcome.checkDeferred === true ? { checkDeferred: true } : {}),
		};
		const contentVersion = contentVersionOf(base);
		items.push({ ...base, ...(contentVersion === undefined ? {} : { contentVersion }) });
	}

	const accepted = items.filter(item => item.state === "accepted").length;
	const reviewable = items.filter(item => item.state === "reviewable").length;
	const unmet = items.filter(item => item.state === "unmet").length;
	const draft: Omit<ResultEvidenceReport, "digest"> = {
		schema: RESULT_EVIDENCE_SCHEMA,
		lane: input.lane,
		attemptId: input.attemptId,
		evaluatedAt: new Date().toISOString(),
		baselineDigest: baseline?.digest ?? null,
		results: items,
		accepted,
		reviewable,
		unmet,
		complete: items.every(item => item.state === "accepted"),
	};
	return { ok: true, report: { ...draft, digest: resultEvidenceDigest(draft) } };
}
