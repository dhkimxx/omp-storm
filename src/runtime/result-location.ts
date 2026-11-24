/**
 * Read-only location check for one result S1 already accepted: is its concrete output still a *retained* result
 * outside the parent tree, or is it actually *integrated* into the current parent?
 *
 * Neither a path, a status string, a checkout's existence, a director claim, nor another patch with the same path is
 * adoption. This module re-reads only the trusted evidence S1 bound to the attempt:
 * - a retained artifact must still live outside the shared worktree and hash to the digest S1 captured (and to the
 *   host's capture digest when one exists);
 * - an integrated shared change must equal the accepted post-digest at every observed path and must not have returned
 *   to the pre-attempt digest;
 * - an integrated isolated patch must still hash to the captured patch digest and every file section must match the
 *   parent's *whole* postimage: created content exactly, a deletion as absent, a modification by the postimage Git
 *   blob id in the captured patch index (or an equivalent authenticated whole-file digest). Hunk text alone is never
 *   accepted as whole-file proof; binary, rename and patches without a postimage id are unverifiable rather than
 *   guessed.
 *
 * Every path is workspace-relative and contained; artifact sources must be absolute and outside the parent. Reads are
 * bounded and refuse symlinks and escapes. Nothing here shells out, runs a plan `check`, writes a file, changes host
 * settings, or falls back to a directory scan. A caller runs it only for the dependency it is about to admit.
 */
import { createHash } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import * as fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import * as path from "node:path";
import { RESULT_ID_RE } from "../plan/validate.ts";
import type { LaneResultKind, PlanLaneResult, RunResult, RunResultState } from "../types.ts";
import {
	type ArtifactEvidenceSource,
	type ResultEvidenceItem,
	type ResultEvidenceLimits,
	resolveResultLimits,
	resultContractIdentity,
} from "./result-evidence.ts";

export type { ArtifactEvidenceSource, LaneResultKind, PlanLaneResult, ResultEvidenceLimits };

export const RESULT_LOCATION_SCHEMA = "storm.result-location/v1";

const DIGEST = /^[0-9a-f]{64}$/u;
const UNSAFE_LINE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const UNSAFE_PATH = /[<>:"|?*]/u;

/** One file the accepted evidence says the producer changed, with the exact post and (when known) pre digest. */
export interface AcceptedFileFingerprint {
	path: string;
	/** sha256 of the accepted postimage observed by S1. */
	digest: string;
	/** sha256 before the attempt. Omitted means S1's baseline found the path absent, never "unknown". */
	previousDigest?: string;
}

/**
 * Exact accepted facts projected from S1's ledger and evidence. Never model text: `attemptId` and the artifact path
 * come from the host, and `identity`/`contentVersion`/digests come from `ResultEvidenceItem` and `RunResult`.
 */
export interface AcceptedResultProjection {
	/** `RunResult.state`; only `accepted` may be located. */
	state: RunResultState;
	/** Host-bound attempt that produced the accepted evidence. */
	attemptId: string;
	/** `RunResult.contentVersion`, pinned to the observed content. */
	contentVersion: string;
	/** `RunResult.identity` = `resultContractIdentity(result)` at acceptance. */
	identity: string;
	/** The plan result exactly as accepted; its contract identity is rechecked. */
	result: PlanLaneResult;
	/** `ResultEvidenceItem.digest`: sha256 of what S1 observed (file, patch source, directory member, answer). */
	digest?: string;
	/** `ResultEvidenceItem.previousDigest` for the single declared path; `files` carries it for pathless changes. */
	previousDigest?: string;
	/** Changed paths for a shared `change`/`artifact` result; also optional whole-file postimage digests for a patch. */
	files?: readonly AcceptedFileFingerprint[];
	/** The host-bound retained source used at settlement, for an isolated `artifact` result. */
	artifact?: ArtifactEvidenceSource;
}

export type ResultLocationMode = "retained" | "integrated";

export interface LocateResultInput {
	mode: ResultLocationMode;
	/** The run's shared worktree: the only containment root and the tree a consumer reads. */
	parentRoot: string;
	accepted: AcceptedResultProjection;
	/**
	 * The attempt the scheduler is about to consume, when it knows it. An older accepted row (a later attempt was
	 * bound since) is reported as `attempt-mismatch` instead of silently reused.
	 */
	expectedAttemptId?: string;
	/** Callers may tighten, never widen, the evidence bounds. */
	limits?: Partial<ResultEvidenceLimits>;
}

/** Why a result has no usable location right now. Every value is a refusal, not a pass. */
export type ResultLocationCode =
	| "not-accepted"
	| "invalid-evidence"
	| "attempt-mismatch"
	| "not-locatable"
	| "artifact-missing"
	| "artifact-changed"
	| "artifact-unsafe"
	| "not-integrated"
	| "reverted"
	| "unverifiable";

/** One parent file verified against the accepted producer fingerprint. A deletion carries `deleted: true`. */
export interface VerifiedResultFile {
	path: string;
	/** sha256 of the current parent file; absent for a verified deletion. */
	digest?: string;
	deleted?: true;
}

/** Enough for a consumer: a compact content-pinned ref plus the exact location and version it may read. */
export interface ResultLocation {
	schema: typeof RESULT_LOCATION_SCHEMA;
	id: string;
	mode: ResultLocationMode;
	/** `${id}@${contentVersion}`: changes when the observed content changes, not when a worker retries. */
	ref: string;
	attemptId: string;
	contentVersion: string;
	/** `patch`/`file`/`directory`: retained source. `parent-file(s)`: verified current parent content. */
	kind: "patch" | "file" | "directory" | "parent-file" | "parent-files";
	/** Retained source absolute path, or the workspace-relative parent path for parent content. */
	path: string;
	/** sha256 of the retained source or the single parent file; absent when `parent-files` has several. */
	digest?: string;
	/** Resolved parent worktree the check actually used. */
	parent: string;
	/** Integrated artifacts and pathless changes: every file verified in the parent. */
	files?: VerifiedResultFile[];
}

export type ResultLocationFailure = { ok: false; code: ResultLocationCode; reason: string };
export type ResultLocationResult = { ok: true; location: ResultLocation } | ResultLocationFailure;

const fail = (code: ResultLocationCode, reason: string): ResultLocationFailure => ({ ok: false, code, reason });

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** One short, bounded field with no control characters and no surrounding whitespace. */
function labelProblem(value: unknown, max: number, what: string): string | undefined {
	if (typeof value !== "string" || value === "") return `${what}이(가) 비어 있습니다.`;
	if (value.length > max) return `${what}이(가) ${max}자를 넘습니다.`;
	if (value.trim() !== value) return `${what} 앞뒤에 공백이 있습니다.`;
	if (UNSAFE_LINE.test(value)) return `${what}에 제어 문자가 있습니다.`;
	return undefined;
}

/** The plan wire's path rules, repeated here because this reader must not trust a caller-supplied path. */
function safeRelative(value: unknown, maxChars: number): string | undefined {
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

function digestValue(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim().toLowerCase();
	const hex = trimmed.startsWith("sha256:") ? trimmed.slice("sha256:".length) : trimmed;
	return DIGEST.test(hex) ? hex : undefined;
}

function isWithin(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function errorCode(error: unknown): string | undefined {
	const code = (error as NodeJS.ErrnoException | null | undefined)?.code;
	return typeof code === "string" ? code : undefined;
}

/** Every existing ancestor must resolve inside the root; a symlinked parent cannot escape it. */
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

type ReadState =
	| { kind: "absent" }
	| { kind: "file"; bytes: number; digest: string; truncated: boolean; content: Buffer }
	| { kind: "unsafe"; detail: string }
	| { kind: "budget" };

interface ReadBudget {
	remaining: number;
}

/** A bounded regular-file read: no symlink, no directory, no inode swap between lstat and open. */
async function readRegularFile(file: string, cap: number, budget: ReadBudget): Promise<ReadState> {
	if (budget.remaining <= 0) return { kind: "budget" };
	const limit = Math.min(cap, budget.remaining);
	let before: Stats;
	try {
		before = await fs.lstat(file);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return { kind: "absent" };
		return { kind: "unsafe", detail: "unreadable" };
	}
	if (before.isSymbolicLink()) return { kind: "unsafe", detail: "symbolic-link" };
	if (before.isDirectory()) return { kind: "unsafe", detail: "directory" };
	if (!before.isFile()) return { kind: "unsafe", detail: "not-a-regular-file" };

	let handle: FileHandle;
	try {
		handle = await fs.open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
	} catch (error) {
		if (errorCode(error) === "ENOENT") return { kind: "absent" };
		return { kind: "unsafe", detail: "unreadable" };
	}
	try {
		const after = await handle.stat();
		if (!after.isFile()) return { kind: "unsafe", detail: "not-a-regular-file" };
		if (after.dev !== before.dev || after.ino !== before.ino) return { kind: "unsafe", detail: "changed-while-opening" };
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
			digest: createHash("sha256").update(content).digest("hex"),
			truncated,
			content: Buffer.from(content),
		};
	} finally {
		await handle.close().catch(() => undefined);
	}
}

/** Reads a workspace-relative path under the resolved parent, refusing escapes and symlinks. */
async function readWorkspace(root: string, relative: string, limits: ReadEvidenceLimits, budget: ReadBudget): Promise<ReadState> {
	if (budget.remaining <= 0) return { kind: "budget" };
	const target = path.join(root, ...relative.split("/"));
	if (!(await containedParent(root, target))) return { kind: "unsafe", detail: "outside-root" };
	const state = await readRegularFile(target, limits.fileBytes, budget);
	if (state.kind === "absent") return state;
	try {
		if (!isWithin(root, await fs.realpath(target))) return { kind: "unsafe", detail: "outside-root" };
	} catch {
		return { kind: "unsafe", detail: "unreadable" };
	}
	return state;
}

type ReadEvidenceLimits = Readonly<ResultEvidenceLimits>;

interface ResolvedArtifact {
	/** Real, verified path outside the parent. */
	path: string;
	form: "patch" | "file" | "directory";
	/** sha256 of the file source; absent for a directory. */
	digest?: string;
	content?: Buffer;
}

/** Resolves the host-bound retained source without ever falling back to the parent checkout. */
async function resolveArtifact(
	source: ArtifactEvidenceSource,
	attemptId: string,
	parent: string,
	limits: ReadEvidenceLimits,
	budget: ReadBudget,
): Promise<{ ok: true; artifact: ResolvedArtifact } | ResultLocationFailure> {
	if (typeof source !== "object" || source === null) return fail("invalid-evidence", "보존 산출물 입력이 객체가 아닙니다.");
	if (typeof source.attemptId !== "string" || source.attemptId === "") return fail("invalid-evidence", "보존 산출물에 시도 id가 없습니다.");
	if (source.attemptId !== attemptId) return fail("attempt-mismatch", "보존 산출물이 다른 시도에 결속되어 있습니다.");
	if (typeof source.path !== "string" || source.path === "" || source.path.length > 4_096 || !path.isAbsolute(source.path)) {
		return fail("invalid-evidence", "보존 산출물 경로는 호스트가 준 절대 경로여야 합니다.");
	}
	const form = source.form ?? "auto";
	if (form !== "auto" && form !== "directory" && form !== "patch" && form !== "file") {
		return fail("invalid-evidence", "보존 산출물 형식이 올바르지 않습니다.");
	}
	let expectedDigest: string | undefined;
	if (source.expectedDigest !== undefined) {
		expectedDigest = digestValue(source.expectedDigest);
		if (expectedDigest === undefined) return fail("invalid-evidence", "호스트 산출물 다이제스트 형식이 올바르지 않습니다.");
	}

	let before: Stats;
	try {
		before = await fs.lstat(source.path);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return fail("artifact-missing", "보존 산출물을 찾을 수 없습니다.");
		return fail("artifact-unsafe", "보존 산출물을 확인할 수 없습니다.");
	}
	if (before.isSymbolicLink()) return fail("artifact-unsafe", "보존 산출물 경로가 심볼릭 링크입니다.");
	let real: string;
	try {
		real = await fs.realpath(source.path);
	} catch {
		return fail("artifact-missing", "보존 산출물을 확인할 수 없습니다.");
	}
	if (isWithin(parent, real)) return fail("artifact-unsafe", "보존 산출물이 부모 작업 트리 안에 있습니다.");
	let resolved: Stats;
	try {
		resolved = await fs.stat(real);
	} catch {
		return fail("artifact-missing", "보존 산출물을 확인할 수 없습니다.");
	}
	if (resolved.dev !== before.dev || resolved.ino !== before.ino) {
		return fail("artifact-unsafe", "보존 산출물이 확인 중 바뀌었습니다.");
	}

	if (before.isDirectory()) {
		if (form === "patch" || form === "file") return fail("invalid-evidence", "산출물 형식이 디렉터리와 맞지 않습니다.");
		if (expectedDigest !== undefined) return fail("invalid-evidence", "디렉터리 산출물에는 파일 다이제스트를 적용할 수 없습니다.");
		return { ok: true, artifact: { path: real, form: "directory" } };
	}
	if (!before.isFile()) return fail("artifact-unsafe", "보존 산출물이 일반 파일이나 디렉터리가 아닙니다.");
	if (form === "directory") return fail("invalid-evidence", "산출물 형식이 파일과 맞지 않습니다.");

	const read = await readRegularFile(real, limits.fileBytes, budget);
	if (read.kind === "budget") return fail("unverifiable", "읽기 바이트 한도를 넘어 보존 산출물을 확인하지 못했습니다.");
	if (read.kind !== "file") return fail("artifact-missing", "보존 산출물을 일반 파일로 읽을 수 없습니다.");
	if (read.truncated) return fail("unverifiable", "보존 산출물이 읽기 한도를 넘어 다이제스트를 확인하지 못했습니다.");
	if (expectedDigest !== undefined && expectedDigest !== read.digest) {
		return fail("artifact-changed", "보존 산출물 다이제스트가 호스트 결속과 다릅니다.");
	}
	if (read.content.includes(0) && form === "auto") {
		// A binary source is a file, never a unified patch; a caller that claims `patch` is checked by the parser.
		return { ok: true, artifact: { path: real, form: "file", digest: read.digest, content: read.content } };
	}
	const usePatch = form === "patch" || (form === "auto" && isPatchText(read.content.toString("utf8")));
	return { ok: true, artifact: { path: real, form: usePatch ? "patch" : "file", digest: read.digest, content: read.content } };
}

function isPatchText(text: string): boolean {
	return /(^|\n)diff --git /u.test(text) || /(^|\n)--- [^\n]*\n\+\+\+ [^\n]*\n/u.test(text);
}

// ── Minimal unified-patch reader ─────────────────────────────────────────────────────────────

interface PatchHunk {
	oldCount: number;
	newLines: string[];
	/** The new side has no final newline (a `\ No newline at end of file` marker followed a `+` line). */
	newNoEol: boolean;
}

interface PatchFile {
	source?: string;
	target?: string;
	created: boolean;
	deleted: boolean;
	rename: boolean;
	binary: boolean;
	/** Postimage Git blob id from the captured patch `index` line; abbreviated ids are prefixes. */
	newBlob?: string;
	hunks: PatchHunk[];
}

type HeaderPath = { kind: "path"; value: string } | { kind: "devnull" } | { kind: "bad" };

/** `--- a/path` / `+++ b/path` (or a quoted Git path); a timestamp after a tab is not part of the name. */
function headerPath(line: string): HeaderPath {
	let value = line.slice(4);
	const tab = value.indexOf("\t");
	if (tab >= 0) value = value.slice(0, tab);
	value = value.trim();
	if (value === "/dev/null") return { kind: "devnull" };
	if (value.startsWith('"')) {
		try {
			const decoded: unknown = JSON.parse(value);
			if (typeof decoded !== "string") return { kind: "bad" };
			value = decoded;
		} catch {
			return { kind: "bad" };
		}
	}
	if (value.startsWith("b/") || value.startsWith("a/")) value = value.slice(2);
	return { kind: "path", value };
}

type PatchParse = { ok: true; files: PatchFile[] } | { ok: false; reason: string };

function malformed(reason: string): PatchParse {
	return { ok: false, reason };
}

/**
 * Reads only the structure this module verifies. Unknown structural text, malformed hunks, rename/copy and binary
 * sections are refused instead of interpreted; a patch that cannot be read exactly is never integration proof.
 */
function parsePatch(text: string, limits: ReadEvidenceLimits): PatchParse {
	const lines = text.split("\n");
	const files: PatchFile[] = [];
	let current: PatchFile | undefined;
	let index = 0;
	while (index < lines.length) {
		const raw = lines[index] ?? "";
		const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
		if (line.startsWith("diff --git ")) {
			current = { created: false, deleted: false, rename: false, binary: false, hunks: [] };
			files.push(current);
			if (files.length > limits.paths) return malformed(`패치 파일 수가 ${limits.paths}개를 넘습니다.`);
			index += 1;
			continue;
		}
		if (current === undefined) {
			if (line !== "") return malformed("패치 헤더 밖에 해석할 수 없는 내용이 있습니다.");
			index += 1;
			continue;
		}
		if (line.startsWith("--- ")) {
			const header = headerPath(line);
			if (header.kind === "bad") return malformed("패치 원본 경로를 읽을 수 없습니다.");
			if (header.kind === "devnull") current.created = true;
			else current.source = header.value;
			index += 1;
			continue;
		}
		if (line.startsWith("+++ ")) {
			const header = headerPath(line);
			if (header.kind === "bad") return malformed("패치 대상 경로를 읽을 수 없습니다.");
			if (header.kind === "devnull") current.deleted = true;
			else current.target = header.value;
			index += 1;
			continue;
		}
		if (line.startsWith("GIT binary patch") || line.startsWith("Binary files ")) {
			current.binary = true;
			index += 1;
			continue;
		}
		if (line.startsWith("rename from ") || line.startsWith("rename to ") || line.startsWith("copy from ") || line.startsWith("copy to ")) {
			current.rename = true;
			index += 1;
			continue;
		}
		if (line.startsWith("@@")) {
			const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(line);
			if (header === null) return malformed("패치 hunk 헤더가 올바르지 않습니다.");
			const oldCount = Number(header[2] ?? 1);
			const newCount = Number(header[4] ?? 1);
			if (!Number.isSafeInteger(oldCount) || !Number.isSafeInteger(newCount)) return malformed("패치 hunk 줄 수가 올바르지 않습니다.");
			if (oldCount > limits.fileBytes || newCount > limits.fileBytes) return malformed("패치 hunk 줄 수가 한도를 넘습니다.");
			if (current.hunks.length >= 256) return malformed("한 파일의 패치 hunk가 256개를 넘습니다.");
			const hunk: PatchHunk = { oldCount, newLines: [], newNoEol: false };
			let oldSeen = 0;
			let newSeen = 0;
			let lastSide: "old" | "new" | "both" | undefined;
			while (oldSeen < oldCount || newSeen < newCount) {
				index += 1;
				if (index >= lines.length) return malformed("패치 hunk가 선언한 줄 수보다 짧습니다.");
				const body = lines[index] ?? "";
				if (body.startsWith("\\")) {
					if (lastSide === "new" || lastSide === "both") hunk.newNoEol = true;
					continue;
				}
				const prefix = body.charAt(0);
				const content = body.slice(1);
				if (prefix === " ") {
					oldSeen += 1;
					newSeen += 1;
					hunk.newLines.push(content);
					lastSide = "both";
				} else if (prefix === "-") {
					oldSeen += 1;
					lastSide = "old";
				} else if (prefix === "+") {
					newSeen += 1;
					hunk.newLines.push(content);
					lastSide = "new";
				} else if (body === "") {
					oldSeen += 1;
					newSeen += 1;
					hunk.newLines.push("");
					lastSide = "both";
				} else {
					return malformed("패치 hunk 본문을 읽을 수 없습니다.");
				}
			}
			while (index + 1 < lines.length && (lines[index + 1] ?? "").startsWith("\\")) {
				index += 1;
				if (lastSide === "new" || lastSide === "both") hunk.newNoEol = true;
			}
			current.hunks.push(hunk);
			index += 1;
			continue;
		}
		if (line.startsWith("index ")) {
			const match = /^index ([0-9a-fA-F]{4,64})\.\.([0-9a-fA-F]{4,64})(?:\s+[0-7]{6})?$/u.exec(line);
			const newBlob = match?.[2]?.toLowerCase();
			// Git's default abbreviation is 7; a shorter prefix is not enough to authenticate a whole file.
			if (newBlob !== undefined && newBlob.length >= 7 && !/^0+$/u.test(newBlob)) current.newBlob = newBlob;
			index += 1;
			continue;
		}
		// Mode, similarity and other header metadata are not evidence; an unknown body is refused.
		if (
			line.startsWith("old mode ") ||
			line.startsWith("new mode ") ||
			line.startsWith("new file mode ") ||
			line.startsWith("deleted file mode ") ||
			line.startsWith("similarity index ") ||
			line.startsWith("dissimilarity index ") ||
			line === ""
		) {
			index += 1;
			continue;
		}
		return malformed("패치에서 해석할 수 없는 줄이 있습니다.");
	}
	if (files.length === 0) return malformed("패치에 파일 구역이 없습니다.");
	for (const file of files) {
		if (file.binary || file.rename) continue;
		if (file.deleted) {
			if (file.source === undefined || safeRelative(file.source, limits.pathChars) === undefined) {
				return malformed("삭제 패치의 원본 경로가 안전하지 않습니다.");
			}
			continue;
		}
		if (file.target === undefined || safeRelative(file.target, limits.pathChars) === undefined) {
			return malformed("패치 대상 경로가 안전한 상대 경로가 아닙니다.");
		}
	}
	return { ok: true, files };
}

// ── Integration verification ─────────────────────────────────────────────────────────────────

/**
 * A Git patch's `index` line names the exact postimage blob. Comparing the parent file's blob id (the same
 * `sha1("blob <len>\\0" + bytes)` Git computes) authenticates the *whole* file, unlike matching relocated hunk text.
 */
function gitBlobMatches(content: Buffer, expected: string): boolean {
	const wanted = expected.toLowerCase();
	if (!/^[0-9a-f]{4,64}$/u.test(wanted)) return false;
	if (wanted.length === 64) return createHash("sha256").update(`blob ${content.length}\0`).update(content).digest("hex").startsWith(wanted);
	// An abbreviated id can belong to a SHA-1 or a SHA-256 repository; both full ids are cheap to check.
	const sha1 = createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
	if (sha1.startsWith(wanted)) return true;
	return createHash("sha256").update(`blob ${content.length}\0`).update(content).digest("hex").startsWith(wanted);
}

type PatchVerification = { ok: true; files: VerifiedResultFile[] } | ResultLocationFailure;

async function verifyPatchInParent(
	patch: readonly PatchFile[],
	parent: string,
	declaredPath: string | undefined,
	wholeFiles: ReadonlyMap<string, AcceptedFileFingerprint> | undefined,
	limits: ReadEvidenceLimits,
	budget: ReadBudget,
): Promise<PatchVerification> {
	const seen = new Set<string>();
	const verified: VerifiedResultFile[] = [];
	for (const file of patch) {
		if (file.binary) return fail("unverifiable", "바이너리 패치는 부모 내용으로 확인할 수 없습니다.");
		if (file.rename) return fail("unverifiable", "이름 변경 패치는 부모 내용으로 확인할 수 없습니다.");
		if (file.deleted) {
			if (file.source === undefined) return fail("unverifiable", "삭제 패치의 원본 경로가 없습니다.");
			if (seen.has(file.source)) return fail("unverifiable", "패치 경로가 중복됩니다.");
			seen.add(file.source);
			const state = await readWorkspace(parent, file.source, limits, budget);
			if (state.kind === "budget") return fail("unverifiable", "읽기 바이트 한도를 넘었습니다.");
			if (state.kind === "unsafe") return fail("unverifiable", `${file.source} 경로를 안전하게 읽을 수 없습니다.`);
			if (state.kind === "file") return fail("not-integrated", `${file.source} 삭제가 부모에 반영되지 않았습니다.`);
			verified.push({ path: file.source, deleted: true });
			continue;
		}
		const target = file.target;
		if (target === undefined) return fail("unverifiable", "패치 대상 경로가 없습니다.");
		if (seen.has(target)) return fail("unverifiable", "패치 경로가 중복됩니다.");
		seen.add(target);
		const whole = wholeFiles?.get(target);
		if (file.created) {
			if (file.hunks.length !== 1) return fail("unverifiable", "생성 파일의 패치 구역을 정확히 확인할 수 없습니다.");
			const hunk = file.hunks[0]!;
			if (hunk.oldCount !== 0) return fail("unverifiable", "생성 파일 패치에 원본 줄이 있습니다.");
			const expected = Buffer.from(
				`${hunk.newLines.join("\n")}${hunk.newLines.length > 0 && !hunk.newNoEol ? "\n" : ""}`,
				"utf8",
			);
			const state = await readWorkspace(parent, target, limits, budget);
			if (state.kind === "budget") return fail("unverifiable", "읽기 바이트 한도를 넘었습니다.");
			if (state.kind === "absent") return fail("not-integrated", `${target} 생성이 부모에 반영되지 않았습니다.`);
			if (state.kind !== "file" || state.truncated) return fail("unverifiable", `${target} 내용을 정확히 읽을 수 없습니다.`);
			if (!state.content.equals(expected)) return fail("not-integrated", `${target} 생성 내용이 부모와 다릅니다.`);
			if (whole !== undefined && whole.digest !== state.digest) {
				return fail("invalid-evidence", `${target}의 승인된 post 지문이 패치 postimage와 다릅니다.`);
			}
			verified.push({ path: target, digest: state.digest });
			continue;
		}
		if (file.hunks.length === 0) return fail("unverifiable", "패치에 내용 변경이 없습니다.");
		const state = await readWorkspace(parent, target, limits, budget);
		if (state.kind === "budget") return fail("unverifiable", "읽기 바이트 한도를 넘었습니다.");
		if (state.kind === "absent") return fail("not-integrated", `${target}이(가) 부모에 없습니다.`);
		if (state.kind !== "file" || state.truncated) return fail("unverifiable", `${target} 내용을 정확히 읽을 수 없습니다.`);
		if (whole !== undefined) {
			if (whole.previousDigest !== undefined && state.digest === whole.previousDigest) {
				return fail("reverted", `${target}이(가) 이전 내용으로 되돌려졌습니다.`);
			}
			if (state.digest !== whole.digest) return fail("not-integrated", `${target} 전체 내용이 승인된 post 지문과 다릅니다.`);
		} else {
			if (file.newBlob === undefined) {
				return fail("unverifiable", `${target}의 postimage blob id가 없어 전체 내용을 확인할 수 없습니다.`);
			}
			if (!gitBlobMatches(state.content, file.newBlob)) {
				return fail("not-integrated", `${target} 전체 내용이 패치 postimage와 다릅니다.`);
			}
		}
		verified.push({ path: target, digest: state.digest });
	}
	if (wholeFiles !== undefined) {
		for (const path of wholeFiles.keys()) {
			if (!seen.has(path)) return fail("invalid-evidence", `승인된 post 지문 경로 ${path}이(가) 패치에 없습니다.`);
		}
	}
	if (declaredPath !== undefined) {
		const present = verified.some(file => file.path === declaredPath);
		if (!present) return fail("artifact-changed", "패치에 요구 경로가 없습니다.");
	}
	return { ok: true, files: verified };
}

// ── Accepted-fact checks ────────────────────────────────────────────────────────────────────

const KINDS: readonly LaneResultKind[] = ["change", "artifact", "answer"];

function resultProblem(result: unknown, limits: ReadEvidenceLimits): string | undefined {
	if (!isPlainObject(result)) return "결과 계약이 객체가 아닙니다.";
	if (typeof result.id !== "string" || !RESULT_ID_RE.test(result.id)) return "결과 id가 올바르지 않습니다.";
	if (typeof result.kind !== "string" || !(KINDS as readonly string[]).includes(result.kind)) return "결과 종류가 올바르지 않습니다.";
	const criterion = labelProblem(result.criterion, 300, "결과 기준");
	if (criterion !== undefined) return criterion;
	if (result.path !== undefined && safeRelative(result.path, limits.pathChars) !== result.path) {
		return "결과 경로가 안전한 상대 경로가 아닙니다.";
	}
	if (result.contains !== undefined && (typeof result.contains !== "string" || result.contains.length > 500)) {
		return "결과 contains 값이 올바르지 않습니다.";
	}
	if (result.check !== undefined && (typeof result.check !== "string" || result.check === "")) {
		return "결과 check 값이 올바르지 않습니다.";
	}
	return undefined;
}

function filesProblem(files: unknown, limits: ReadEvidenceLimits): string | undefined {
	if (!Array.isArray(files)) return "변경 파일 지문 목록이 배열이 아닙니다.";
	if (files.length === 0) return "변경 파일 지문이 비어 있습니다.";
	if (files.length > limits.paths) return `변경 파일 지문이 ${limits.paths}개를 넘습니다.`;
	const seen = new Set<string>();
	for (const file of files) {
		if (!isPlainObject(file)) return "변경 파일 지문이 객체가 아닙니다.";
		if (safeRelative(file.path, limits.pathChars) !== file.path) return "변경 파일 경로가 안전한 상대 경로가 아닙니다.";
		if (seen.has(file.path as string)) return "변경 파일 경로가 중복됩니다.";
		seen.add(file.path as string);
		if (digestValue(file.digest) !== file.digest) return "변경 파일의 post 다이제스트가 올바르지 않습니다.";
		if (file.previousDigest !== undefined && digestValue(file.previousDigest) !== file.previousDigest) {
			return "변경 파일의 pre 다이제스트가 올바르지 않습니다.";
		}
	}
	return undefined;
}

function acceptedProblem(accepted: AcceptedResultProjection, limits: ReadEvidenceLimits): string | undefined {
	if (!isPlainObject(accepted)) return "승인된 결과 투영이 객체가 아닙니다.";
	if (accepted.state !== "accepted") return "S1에서 accepted로 관찰된 결과만 위치를 확인할 수 있습니다.";
	const attempt = labelProblem(accepted.attemptId, 256, "시도 id");
	if (attempt !== undefined) return attempt;
	if (digestValue(accepted.contentVersion) !== accepted.contentVersion) return "결과 contentVersion이 올바르지 않습니다.";
	if (digestValue(accepted.identity) !== accepted.identity) return "결과 identity가 올바르지 않습니다.";
	const result = resultProblem(accepted.result, limits);
	if (result !== undefined) return result;
	if (accepted.identity !== resultContractIdentity(accepted.result)) return "결과 identity가 현재 계약과 다릅니다.";
	if (accepted.digest !== undefined && digestValue(accepted.digest) !== accepted.digest) return "관찰 다이제스트가 올바르지 않습니다.";
	if (accepted.previousDigest !== undefined && digestValue(accepted.previousDigest) !== accepted.previousDigest) {
		return "이전 다이제스트가 올바르지 않습니다.";
	}
	if (accepted.files !== undefined) {
		const files = filesProblem(accepted.files, limits);
		if (files !== undefined) return files;
	}
	if (accepted.artifact !== undefined) {
		if (accepted.result.kind !== "artifact") return "artifact 산출물 근거는 artifact 결과에만 쓸 수 있습니다.";
	}
	return undefined;
}

function resolvedParent(value: unknown): Promise<string | undefined> {
	if (typeof value !== "string" || value === "") return Promise.resolve(undefined);
	return fs
		.realpath(value)
		.then(async real => ((await fs.stat(real)).isDirectory() ? real : undefined))
		.catch(() => undefined);
}

function parentFiles(accepted: AcceptedResultProjection): readonly AcceptedFileFingerprint[] {
	if (accepted.files !== undefined) return accepted.files;
	const declared = accepted.result.path;
	if (declared === undefined || accepted.digest === undefined) return [];
	return [{ path: declared, digest: accepted.digest, ...(accepted.previousDigest === undefined ? {} : { previousDigest: accepted.previousDigest }) }];
}

/** What the scheduler passes: the accepted run row, the plan result and the S1 item/source it settled with. */
export interface AcceptedEvidenceInput {
	row: Pick<RunResult, "id" | "state" | "attemptId" | "identity" | "contentVersion">;
	result: PlanLaneResult;
	item: Pick<
		ResultEvidenceItem,
		"id" | "identity" | "kind" | "attemptId" | "state" | "path" | "digest" | "previousDigest" | "observations" | "artifact"
	>;
	/** The host-bound source kept with that settlement (`SettledAttempt.artifact`), for an isolated artifact. */
	artifact?: ArtifactEvidenceSource;
}

export type ResultProjection = { ok: true; accepted: AcceptedResultProjection } | { ok: false; reason: string };

function observedChangeFiles(
	result: PlanLaneResult,
	item: AcceptedEvidenceInput["item"],
): { ok: true; files: AcceptedFileFingerprint[] } | { ok: false; reason: string } {
	if (result.path !== undefined) {
		if (item.digest === undefined) return { ok: false, reason: "S1 evidence has no observed digest for the declared path." };
		return {
			ok: true,
			files: [
				{
					path: result.path,
					digest: item.digest,
					...(item.previousDigest === undefined ? {} : { previousDigest: item.previousDigest }),
				},
			],
		};
	}
	const files: AcceptedFileFingerprint[] = [];
	for (const observation of item.observations ?? []) {
		if (!observation.changed || observation.digest === undefined) continue;
		files.push({
			path: observation.path,
			digest: observation.digest,
			...(observation.previousDigest === undefined ? {} : { previousDigest: observation.previousDigest }),
		});
	}
	return files.length === 0
		? { ok: false, reason: "Pathless change evidence has no changed file digest." }
		: { ok: true, files };
}

/**
 * Projects exactly what S1 recorded, refusing a row/item/plan mismatch. It never fills an absent digest, attempt or
 * artifact path from a default: the caller passes the settlement's own evidence or the projection fails.
 */
export function projectAcceptedResult(input: AcceptedEvidenceInput): ResultProjection {
	if (input.row.state !== "accepted") return { ok: false, reason: "The run row is not accepted." };
	if (input.item.state !== "accepted") return { ok: false, reason: "The S1 evidence item is not accepted." };
	const attemptId = input.row.attemptId;
	if (typeof attemptId !== "string" || attemptId === "") return { ok: false, reason: "The run row has no bound attempt." };
	if (input.item.attemptId !== attemptId) return { ok: false, reason: "The evidence item belongs to another attempt." };
	if (input.item.id !== input.result.id || input.item.kind !== input.result.kind) {
		return { ok: false, reason: "The evidence item does not match the plan result." };
	}
	if (input.row.id !== input.result.id) return { ok: false, reason: "The run row does not match the plan result id." };
	const identity = input.row.identity;
	if (identity === undefined || identity !== input.item.identity || identity !== resultContractIdentity(input.result)) {
		return { ok: false, reason: "The run row, evidence and plan contract identities differ." };
	}
	const contentVersion = input.row.contentVersion;
	if (contentVersion === undefined) return { ok: false, reason: "The run row has no content version." };
	if ((input.item.path ?? undefined) !== (input.result.path ?? undefined)) {
		return { ok: false, reason: "The evidence path does not match the plan result path." };
	}

	if (input.result.kind === "change" || input.result.kind === "answer") {
		if (input.artifact !== undefined) return { ok: false, reason: "Only an artifact result may carry a retained source." };
		if (input.result.kind === "answer") {
			return {
				ok: true,
				accepted: {
					state: "accepted",
					attemptId,
					contentVersion,
					identity,
					result: input.result,
					...(input.item.digest === undefined ? {} : { digest: input.item.digest }),
				},
			};
		}
		const files = observedChangeFiles(input.result, input.item);
		if (!files.ok) return files;
		return {
			ok: true,
			accepted: {
				state: "accepted",
				attemptId,
				contentVersion,
				identity,
				result: input.result,
				...(input.item.digest === undefined ? {} : { digest: input.item.digest }),
				...(input.item.previousDigest === undefined ? {} : { previousDigest: input.item.previousDigest }),
				files: files.files,
			},
		};
	}

	if (input.item.artifact === undefined) {
		if (input.artifact !== undefined) return { ok: false, reason: "S1 did not bind a retained artifact for this result." };
		// A shared artifact was evaluated as a change; the same parent fingerprints apply.
		const files = observedChangeFiles(input.result, input.item);
		if (!files.ok) return files;
		return {
			ok: true,
			accepted: {
				state: "accepted",
				attemptId,
				contentVersion,
				identity,
				result: input.result,
				...(input.item.digest === undefined ? {} : { digest: input.item.digest }),
				...(input.item.previousDigest === undefined ? {} : { previousDigest: input.item.previousDigest }),
				files: files.files,
			},
		};
	}

	if (input.artifact === undefined) return { ok: false, reason: "The isolated artifact has no host-bound retained source." };
	if (input.artifact.attemptId !== attemptId) return { ok: false, reason: "The retained source belongs to another attempt." };
	const form = input.artifact.form ?? "auto";
	const consistent =
		(input.item.artifact === "directory" && (form === "directory" || form === "auto")) ||
		(input.item.artifact === "patch" && (form === "patch" || form === "auto")) ||
		(input.item.artifact === "file" && (form === "file" || form === "auto"));
	if (!consistent) return { ok: false, reason: "The retained source form does not match the S1 evidence." };
	if (input.item.digest === undefined) return { ok: false, reason: "The isolated artifact has no observed digest." };
	return {
		ok: true,
		accepted: {
			state: "accepted",
			attemptId,
			contentVersion,
			identity,
			result: input.result,
			digest: input.item.digest,
			artifact: input.artifact,
		},
	};
}

function locationOf(
	accepted: AcceptedResultProjection,
	mode: ResultLocationMode,
	parent: string,
	kind: ResultLocation["kind"],
	locationPath: string,
	digest: string | undefined,
	files?: VerifiedResultFile[],
): ResultLocationResult {
	return {
		ok: true,
		location: {
			schema: RESULT_LOCATION_SCHEMA,
			id: accepted.result.id,
			mode,
			ref: `${accepted.result.id}@${accepted.contentVersion}`,
			attemptId: accepted.attemptId,
			contentVersion: accepted.contentVersion,
			kind,
			path: locationPath,
			parent,
			...(digest === undefined ? {} : { digest }),
			...(files === undefined ? {} : { files }),
		},
	};
}

// ── Retained ────────────────────────────────────────────────────────────────────────────────

async function locateRetained(
	accepted: AcceptedResultProjection,
	parent: string,
	limits: ReadEvidenceLimits,
	budget: ReadBudget,
): Promise<ResultLocationResult> {
	const source = accepted.artifact;
	if (source === undefined) return fail("not-locatable", "공유 산출물은 부모 트리 밖에 보존된 소스가 없습니다.");
	if (accepted.digest === undefined) return fail("invalid-evidence", "S1이 관찰한 산출물 다이제스트가 없습니다.");
	const resolved = await resolveArtifact(source, accepted.attemptId, parent, limits, budget);
	if (!resolved.ok) return resolved;
	const artifact = resolved.artifact;

	if (artifact.form === "directory") {
		if (accepted.result.path === undefined) return fail("invalid-evidence", "디렉터리 산출물에는 요구 경로가 필요합니다.");
		const member = await readWorkspace(artifact.path, accepted.result.path, limits, budget);
		if (member.kind === "budget") return fail("unverifiable", "읽기 바이트 한도를 넘어 디렉터리 산출물을 확인하지 못했습니다.");
		if (member.kind === "absent") return fail("artifact-missing", "보존 산출물에 요구 경로가 없습니다.");
		if (member.kind !== "file" || member.truncated) return fail("unverifiable", "보존 산출물의 요구 경로를 정확히 읽을 수 없습니다.");
		if (member.digest !== accepted.digest) return fail("artifact-changed", "보존 산출물 내용이 S1 관찰과 다릅니다.");
		return locationOf(accepted, "retained", parent, "directory", artifact.path, accepted.digest, [
			{ path: accepted.result.path, digest: member.digest },
		]);
	}

	const sourceDigest = artifact.digest;
	if (sourceDigest === undefined) return fail("artifact-missing", "보존 산출물 다이제스트가 없습니다.");
	if (sourceDigest !== accepted.digest) return fail("artifact-changed", "보존 산출물이 S1 관찰 이후 바뀌었습니다.");
	if (artifact.form === "file" && accepted.result.path !== undefined && path.basename(artifact.path) !== accepted.result.path) {
		return fail("invalid-evidence", "단일 파일 산출물의 이름이 요구 경로와 다릅니다.");
	}
	return locationOf(accepted, "retained", parent, artifact.form, artifact.path, sourceDigest);
}

// ── Integrated ──────────────────────────────────────────────────────────────────────────────

async function locateIntegratedParent(
	accepted: AcceptedResultProjection,
	parent: string,
	limits: ReadEvidenceLimits,
	budget: ReadBudget,
): Promise<ResultLocationResult> {
	const files = parentFiles(accepted);
	if (files.length === 0) return fail("invalid-evidence", "변경 결과에 관찰된 파일 지문이 없습니다.");
	if (accepted.result.path !== undefined && (files.length !== 1 || files[0]?.path !== accepted.result.path)) {
		return fail("invalid-evidence", "경로가 있는 변경 결과의 파일 지문이 요구 경로와 다릅니다.");
	}
	const verified: VerifiedResultFile[] = [];
	for (const file of files) {
		const state = await readWorkspace(parent, file.path, limits, budget);
		if (state.kind === "budget") return fail("unverifiable", "읽기 바이트 한도를 넘어 부모 내용을 확인하지 못했습니다.");
		if (state.kind === "absent") return fail("not-integrated", `${file.path}이(가) 부모에 없습니다.`);
		if (state.kind !== "file" || state.truncated) return fail("unverifiable", `${file.path} 내용을 정확히 읽을 수 없습니다.`);
		if (file.previousDigest !== undefined && state.digest === file.previousDigest) {
			return fail("reverted", `${file.path}이(가) 이전 내용으로 되돌려졌습니다.`);
		}
		if (state.digest !== file.digest) return fail("not-integrated", `${file.path} 내용이 S1이 승인한 결과와 다릅니다.`);
		verified.push({ path: file.path, digest: state.digest });
	}
	return locationOf(
		accepted,
		"integrated",
		parent,
		verified.length === 1 ? "parent-file" : "parent-files",
		verified.length === 1 ? verified[0]!.path : accepted.result.path ?? verified[0]!.path,
		verified.length === 1 ? verified[0]!.digest : undefined,
		verified,
	);
}

async function locateIntegratedArtifact(
	accepted: AcceptedResultProjection,
	parent: string,
	limits: ReadEvidenceLimits,
	budget: ReadBudget,
): Promise<ResultLocationResult> {
	const source = accepted.artifact;
	if (source === undefined) return locateIntegratedParent(accepted, parent, limits, budget);
	if (accepted.digest === undefined) return fail("invalid-evidence", "S1이 관찰한 산출물 다이제스트가 없습니다.");
	const resolved = await resolveArtifact(source, accepted.attemptId, parent, limits, budget);
	if (!resolved.ok) return resolved;
	const artifact = resolved.artifact;

	if (artifact.form === "directory") {
		if (accepted.result.path === undefined) return fail("invalid-evidence", "디렉터리 산출물에는 요구 경로가 필요합니다.");
		const member = await readWorkspace(artifact.path, accepted.result.path, limits, budget);
		if (member.kind === "budget") return fail("unverifiable", "읽기 바이트 한도를 넘어 디렉터리 산출물을 확인하지 못했습니다.");
		if (member.kind === "absent") return fail("artifact-missing", "보존 산출물에 요구 경로가 없습니다.");
		if (member.kind !== "file" || member.truncated) return fail("unverifiable", "보존 산출물의 요구 경로를 정확히 읽을 수 없습니다.");
		if (member.digest !== accepted.digest) return fail("artifact-changed", "보존 산출물 내용이 S1 관찰과 다릅니다.");
		const state = await readWorkspace(parent, accepted.result.path, limits, budget);
		if (state.kind === "budget") return fail("unverifiable", "읽기 바이트 한도를 넘었습니다.");
		if (state.kind === "absent") return fail("not-integrated", `${accepted.result.path}이(가) 부모에 없습니다.`);
		if (state.kind !== "file" || state.truncated) return fail("unverifiable", `${accepted.result.path} 내용을 정확히 읽을 수 없습니다.`);
		if (state.digest !== accepted.digest) return fail("not-integrated", `${accepted.result.path} 내용이 채택된 산출물과 다릅니다.`);
		return locationOf(accepted, "integrated", parent, "parent-file", accepted.result.path, state.digest, [
			{ path: accepted.result.path, digest: state.digest },
		]);
	}

	const sourceDigest = artifact.digest;
	if (sourceDigest === undefined) return fail("artifact-missing", "보존 산출물 다이제스트가 없습니다.");
	if (sourceDigest !== accepted.digest) return fail("artifact-changed", "보존 산출물이 S1 관찰 이후 바뀌었습니다.");
	if (artifact.form === "patch") {
		const parsed = parsePatch(artifact.content?.toString("utf8") ?? "", limits);
		if (!parsed.ok) return fail("unverifiable", parsed.reason);
		const wholeFiles = accepted.files === undefined ? undefined : new Map(accepted.files.map(file => [file.path, file]));
		const verified = await verifyPatchInParent(parsed.files, parent, accepted.result.path, wholeFiles, limits, budget);
		if (!verified.ok) return verified;
		return locationOf(accepted, "integrated", parent, "patch", artifact.path, sourceDigest, verified.files);
	}

	if (accepted.result.path === undefined) return fail("invalid-evidence", "단일 파일 산출물에는 요구 경로가 필요합니다.");
	if (path.basename(artifact.path) !== accepted.result.path) return fail("invalid-evidence", "단일 파일 산출물의 이름이 요구 경로와 다릅니다.");
	const state = await readWorkspace(parent, accepted.result.path, limits, budget);
	if (state.kind === "budget") return fail("unverifiable", "읽기 바이트 한도를 넘었습니다.");
	if (state.kind === "absent") return fail("not-integrated", `${accepted.result.path}이(가) 부모에 없습니다.`);
	if (state.kind !== "file" || state.truncated) return fail("unverifiable", `${accepted.result.path} 내용을 정확히 읽을 수 없습니다.`);
	if (state.digest !== sourceDigest) return fail("not-integrated", `${accepted.result.path} 내용이 보존 산출물과 다릅니다.`);
	return locationOf(accepted, "integrated", parent, "parent-file", accepted.result.path, state.digest, [
		{ path: accepted.result.path, digest: state.digest },
	]);
}

// ── Entry point ─────────────────────────────────────────────────────────────────────────────

/**
 * Establishes one accepted result's usable location. `retained` is for an isolated artifact a consumer may still
 * read outside the parent; `integrated` means the accepted content is actually in the current parent. Shared changes
 * and shared artifact outputs are integrated content; answers have no file location. Every refusal is fail-closed.
 */
export async function locateResult(input: LocateResultInput): Promise<ResultLocationResult> {
	if (!isPlainObject(input)) return fail("invalid-evidence", "위치 확인 입력이 객체가 아닙니다.");
	if (input.mode !== "retained" && input.mode !== "integrated") return fail("invalid-evidence", "위치 확인 모드가 올바르지 않습니다.");
	const limits = resolveResultLimits(input.limits);
	const accepted = input.accepted;
	if (accepted.state !== "accepted") return fail("not-accepted", "S1에서 accepted로 관찰된 결과만 위치를 확인할 수 있습니다.");
	if (input.expectedAttemptId !== undefined) {
		const expected = labelProblem(input.expectedAttemptId, 256, "소비할 시도 id");
		if (expected !== undefined) return fail("invalid-evidence", expected);
		if (input.expectedAttemptId !== accepted.attemptId) {
			return fail("attempt-mismatch", "승인된 결과가 소비자가 기대한 시도보다 오래되었습니다.");
		}
	}
	const problem = acceptedProblem(accepted, limits);
	if (problem !== undefined) return fail("invalid-evidence", problem);
	const parent = await resolvedParent(input.parentRoot);
	if (parent === undefined) return fail("invalid-evidence", "부모 작업 트리를 확인할 수 없습니다.");
	if (accepted.result.kind === "answer") return fail("not-locatable", "답변 결과는 파일 위치가 없습니다.");

	const budget: ReadBudget = { remaining: limits.totalBytes };
	if (input.mode === "retained") {
		if (accepted.result.kind === "change") {
			return fail("not-locatable", "공유 트리 변경은 보존 산출물이 아닙니다. integrated 모드로 현재 부모를 확인하세요.");
		}
		return locateRetained(accepted, parent, limits, budget);
	}
	return locateIntegratedArtifact(accepted, parent, limits, budget);
}
