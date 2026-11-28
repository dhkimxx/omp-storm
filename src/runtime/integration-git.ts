/**
 * The exact Git side of one integration candidate: a strict parser for the host's root patch, object resolution in the
 * bound source ODB, scratch verification of the whole advertised transformation, live preimage/postimage checks and a
 * fixed non-staging installer.
 *
 * It never writes the target until the installer runs, never stages, never reads a target byte to invent proof, never
 * scans a worktree and never interprets a revision name: only full object ids or unique prefixes in the source ODB are
 * object names. A proof that cannot name every byte and every absence on both sides is refused whole.
 */
import { createHash } from "node:crypto";
import { type BigIntStats, constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type {
	ChildEntryClaim, ConsumedInput, FrozenScope, GitObjectSource, IntegrationCheck, IntegrationProblem,
	IntegrationRead, IntegrationTarget, LocatedInputPath, PathImage, RegularFileMode, SpaceIdentity,
} from "./integration-admission.ts";
import type {
	ByteWindow, DeltaImage, DirtyPaths, ExactDeltaProof, ExactPathDelta, IntegrationBytePort, IntegrationDeltaPort,
	Presence, RootProofRequest,
} from "./integration-delta.ts";

/** Per-candidate bounds; the caller's window may be smaller but never larger. */
export const DELTA_MAX_EXPANDED_BYTES = 64 * 1024 * 1024;
export const DELTA_MAX_TOUCHED_PATHS = 4_096;
export const DELTA_MAX_FILE_BYTES = 64 * 1024 * 1024;
export const DELTA_MAX_PATCH_BYTES = 64 * 1024 * 1024;
export const DELTA_MAX_PARTS = 8;
const MAX_INDEX_HASH_BYTES = 8 * 1024 * 1024;
const MAX_PATH_TEXT = 4_096;
const SCRATCH_PREFIX = "storm-integration-delta-";
/** After killing a timed-out child, how long its actual reap is awaited before the end stays unproved. */
const EXIT_PROOF_GRACE_MS = 5_000;

const REGULAR_MODES: ReadonlySet<string> = new Set(["100644", "100755"]);
const HEADER = "diff --git ";
const INDEX_LINE = /^index ([0-9a-f]{4,64})\.\.([0-9a-f]{4,64})(?: ([0-7]{6}))?$/u;
const HUNK_LINE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/u;

/** One Git command result. `started` is false only when no child process was created. */
export interface GitRunResult {
	readonly stdout: Uint8Array;
	readonly stderr: string;
	readonly code: number;
	readonly started: boolean;
	/** False only when a child started but its actual process end was not observed. */
	readonly ended?: boolean;
}

export interface GitRunOptions {
	readonly cwd?: string;
	readonly stdin?: string | Uint8Array;
	readonly env?: Readonly<Record<string, string>>;
	readonly timeoutMs?: number;
}

/** A narrow process port so tests prove the exact git semantics with a real `git` or a scripted failure. */
export type GitRun = (args: readonly string[], options?: GitRunOptions) => Promise<GitRunResult>;

function textOf(bytes: Uint8Array): string {
	return new TextDecoder().decode(bytes);
}

function hash(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function problem(code: string, reason: string, at?: string): IntegrationProblem {
	return at === undefined ? { code, reason } : { code, reason, path: at };
}

class Refusal extends Error {
	constructor(readonly problemValue: IntegrationProblem) {
		super(problemValue.reason);
	}
}

function refuse(code: string, reason: string, at?: string): never {
	throw new Refusal(problem(code, reason, at));
}

/** The OS error code of a failed fs/git operation, without asserting a shape onto an unread value. */
function errorCodeOf(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
	const code = error.code;
	return typeof code === "string" ? code : undefined;
}

function sanitizedEnv(extra?: Readonly<Record<string, string>>): Record<string, string> {
	const env: Record<string, string> = {};
	// Keep only what git needs to find itself; the user's repository configuration is not part of the pinned contract.
	for (const key of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "SYSTEMROOT", "ComSpec", "PATHEXT"]) {
		const value = process.env[key];
		if (value !== undefined) env[key] = value;
	}
	env.GIT_CONFIG_NOSYSTEM = "1";
	env.GIT_CONFIG_GLOBAL = "/dev/null";
	env.GIT_TERMINAL_PROMPT = "0";
	env.GIT_OPTIONAL_LOCKS = "0";
	env.GIT_NO_REPLACE_OBJECTS = "1";
	env.LC_ALL = "C";
	return { ...env, ...(extra ?? {}) };
}

/** The part of a spawned `git` child this runner uses; named so no caller depends on Bun's subprocess type. */
interface GitChild {
	readonly stdout: ReadableStream<Uint8Array>;
	readonly stderr: ReadableStream<Uint8Array>;
	readonly exited: Promise<number>;
	kill(signal?: string | number): void;
	unref?(): void;
}

/** Resolves true only when the child's own exited promise settles; a kill request alone proves no end. */
function awaitReap(exited: Promise<number>, timeoutMs: number): Promise<boolean> {
	const { promise, resolve } = Promise.withResolvers<boolean>();
	const timer = setTimeout(() => resolve(false), timeoutMs);
	const settle = (reaped: boolean): void => {
		clearTimeout(timer);
		resolve(reaped);
	};
	void exited.then(() => settle(true), () => settle(false));
	return promise;
}

/** The production runner: one `git` child with piped stdin/stdout and a hard timeout. */
export function spawnGit(args: readonly string[], options: GitRunOptions = {}): Promise<GitRunResult> {
	return (async () => {
		let proc: GitChild;
		try {
			proc = Bun.spawn(["git", ...args], {
				...(options.cwd === undefined ? {} : { cwd: options.cwd }),
				env: sanitizedEnv(options.env),
				stdin: options.stdin === undefined
					? "ignore"
					: typeof options.stdin === "string" ? new TextEncoder().encode(options.stdin) : options.stdin,
				stdout: "pipe",
				stderr: "pipe",
			});
		} catch (error) {
			return { stdout: new Uint8Array(), stderr: error instanceof Error ? error.message : String(error), code: -1, started: false };
		}
		const stdout = new Response(proc.stdout).arrayBuffer();
		const stderr = new Response(proc.stderr).text();
		const timeout = options.timeoutMs;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const exited = proc.exited;
		let result: number;
		if (timeout === undefined || timeout <= 0) {
			result = await exited;
		} else {
			const raced = Promise.withResolvers<number>();
			let timedOut = false;
			timer = setTimeout(() => {
				timedOut = true;
				proc.kill("SIGKILL");
				raced.resolve(-2);
			}, timeout);
			void exited.then(raced.resolve);
			result = await raced.promise;
			if (timedOut) {
				// The kill request is not an observed end: wait for the real reap before reporting any exit.
				if (!(await awaitReap(exited, EXIT_PROOF_GRACE_MS))) {
					proc.unref?.();
					return { stdout: new Uint8Array(), stderr: "", code: -2, started: true, ended: false };
				}
				result = await exited;
			}
		}
		clearTimeout(timer);
		const [out, err] = await Promise.all([stdout, stderr]);
		return { stdout: new Uint8Array(out), stderr: err, code: result, started: true, ended: true };
	})();
}

/** A small executable-file check independent of the host's `git` (used for scratch verification and readback). */
function modeOf(st: { mode: bigint }): RegularFileMode {
	return (st.mode & 0o111n) !== 0n ? "100755" : "100644";
}

function sameImage(a: PathImage, b: PathImage): boolean {
	if (a.kind === "absent" || b.kind === "absent") return a.kind === b.kind;
	return a.mode === b.mode && a.bytes === b.bytes && a.sha256 === b.sha256;
}

type FileImage = Extract<PathImage, { kind: "file" }>;

function imageOfBytes(bytes: Uint8Array, mode: RegularFileMode): FileImage {
	return { kind: "file", mode, bytes: bytes.byteLength, sha256: hash(bytes) };
}

function deltaToImage(image: DeltaImage): PathImage {
	return image.state.kind === "absent" ? { kind: "absent" } : image.state;
}

/** The literal path form accepted from a patch: target-relative, POSIX, without traversal or Git/Storm authority. */
function cleanRelative(value: string): string | undefined {
	if (value.length === 0 || value.length > MAX_PATH_TEXT) return undefined;
	if (value.includes("\\") || value.includes("\u0000")) return undefined;
	const segments = value.split("/");
	if (segments.some(segment => segment === "" || segment === "." || segment === "..")) return undefined;
	if (segments.some(segment => segment.toLowerCase() === ".git" || segment.toLowerCase() === ".omp")) return undefined;
	return segments.join("/");
}

/** Conservative alias identity: case and Unicode normalization cannot be ruled out on the supported platforms. */
function aliasKey(value: string): string {
	return value.normalize("NFC").toLowerCase();
}

function isInsideScope(targetPath: string, scope: FrozenScope): boolean {
	if (scope.kind === "unbounded") return true;
	return scope.paths.some(base => targetPath === base || targetPath.startsWith(`${base}/`));
}

function joinPrefix(prefix: string, relative: string): string {
	return prefix === "" ? relative : `${prefix}/${relative}`;
}

/** A per-call byte/deadline budget; the caller's cap is never exceeded silently. */
export class ByteBudget {
	#used = 0;
	constructor(
		readonly window: ByteWindow,
		private readonly now: () => number = Date.now,
		readonly cap: number = DELTA_MAX_EXPANDED_BYTES,
	) {}

	problem(): IntegrationProblem | undefined {
		if (this.window.signal.aborted) return problem("delta-aborted", "통합 작업이 중단되어 계속하지 않았습니다.");
		if (!(this.now() < this.window.deadline)) return problem("delta-deadline", "통합 작업 시간이 지나 계속하지 않았습니다.");
		const limit = Math.min(this.cap, this.window.maxBytes);
		if (!Number.isSafeInteger(limit) || limit < 0) return problem("delta-window", "통합 바이트 한도를 확인할 수 없습니다.");
		return undefined;
	}

	get used(): number {
		return this.#used;
	}

	charge(bytes: number): IntegrationProblem | undefined {
		const early = this.problem();
		if (early !== undefined) return early;
		if (!Number.isSafeInteger(bytes) || bytes < 0) return problem("delta-window", "통합 바이트 수를 확인할 수 없습니다.");
		const limit = Math.min(this.cap, this.window.maxBytes);
		if (this.#used + bytes > limit) {
			return problem("delta-too-large", `통합 검증 바이트가 한도(${limit})를 넘습니다.`);
		}
		this.#used += bytes;
		return undefined;
	}
}

interface Draft {
	gitPath: string;
	binary: boolean;
	newFile: boolean;
	deleted: boolean;
	oldPrefix: string | null;
	newPrefix: string | null;
	mode: RegularFileMode | undefined;
	hasIndex: boolean;
	hasOldMarker: boolean;
	hasNewMarker: boolean;
	oldNull: boolean;
	newNull: boolean;
	hunks: number;
}

function parseHeaderPath(rest: string): string {
	if (rest.startsWith('"')) refuse("delta-unsupported-path", "따옴표로 인코딩된 경로는 지원하지 않습니다.");
	let found: { a: string; b: string } | undefined;
	for (let at = rest.indexOf(" b/"); at >= 0; at = rest.indexOf(" b/", at + 1)) {
		if (!rest.startsWith("a/")) continue;
		const a = rest.slice(2, at);
		const b = rest.slice(at + 3);
		if (a === b && a.length > 0) {
			found = { a, b };
			break;
		}
	}
	if (found === undefined) refuse("delta-rename", "이름이 다른 항목(rename/copy)은 지원하지 않습니다.");
	return found.a;
}

function checkMode(value: string): RegularFileMode {
	if (!REGULAR_MODES.has(value)) refuse("delta-unsupported-mode", `일반 파일 모드가 아닌 항목은 지원하지 않습니다: ${value}`);
	return value as RegularFileMode;
}

function zeroPrefix(value: string): boolean {
	return /^0+$/u.test(value);
}

/** Strict parse of the host's root-only patch. One unsupported or malformed entry refuses the whole payload. */
export function parseRootPatch(patch: string): Draft[] {
	const drafts: Draft[] = [];
	let current: Draft | undefined;
	let inBinary = false;
	let binaryBlocks = 0;
	let remainingOld = 0;
	let remainingNew = 0;
	let inHunk = false;
	const lines = patch.split("\n");
	if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	for (const line of lines) {
		if (line.startsWith(HEADER)) {
			if (current !== undefined) {
				if (inHunk && (remainingOld > 0 || remainingNew > 0)) refuse("delta-malformed", "패치 hunk가 선언한 줄 수보다 일찍 끝났습니다.");
				drafts.push(current);
			}
			const gitPath = parseHeaderPath(line.slice(HEADER.length));
			const clean = cleanRelative(gitPath);
			if (clean === undefined) refuse("delta-unsafe-path", `패치 경로가 안전하지 않습니다: ${JSON.stringify(gitPath)}`);
			current = {
				gitPath: clean,
				binary: false,
				newFile: false,
				deleted: false,
				oldPrefix: null,
				newPrefix: null,
				mode: undefined,
				hasIndex: false,
				hasOldMarker: false,
				hasNewMarker: false,
				oldNull: false,
				newNull: false,
				hunks: 0,
			};
			inBinary = false;
			inHunk = false;
			remainingOld = 0;
			remainingNew = 0;
			continue;
		}
		if (current === undefined) {
			if (line === "") continue;
			refuse("delta-malformed", "패치가 파일 항목으로 시작하지 않습니다.");
		}
		if (line.startsWith("\\ No newline at end of file")) {
			// Git's hunk trailer; it changes no count and the scratch apply proves the bytes.
			continue;
		}
		if (inHunk && (remainingOld > 0 || remainingNew > 0)) {
			if (line.startsWith(" ")) {
				remainingOld--;
				remainingNew--;
			} else if (line.startsWith("-")) remainingOld--;
			else if (line.startsWith("+")) remainingNew--;
			else if (line.startsWith("\\ No newline at end of file")) {
				// marker line, no counts
			} else refuse("delta-malformed", `hunk 내용이 올바르지 않습니다: ${JSON.stringify(line.slice(0, 80))}`);
			if (remainingOld < 0 || remainingNew < 0) refuse("delta-malformed", "패치 hunk 줄 수가 맞지 않습니다.");
			if (remainingOld === 0 && remainingNew === 0) inHunk = false;
			continue;
		}
		if (line === "") {
			inBinary = false;
			continue;
		}
		if (line.startsWith("index ")) {
			if (current.hasIndex) refuse("delta-malformed", `${current.gitPath}에 index 줄이 둘 이상입니다.`);
			if (inBinary) refuse("delta-malformed", "binary 항목 안에 index 줄이 있습니다.");
			const match = INDEX_LINE.exec(line);
			if (match === null) refuse("delta-malformed", `index 줄이 올바르지 않습니다: ${line}`);
			current.hasIndex = true;
			current.oldPrefix = zeroPrefix(match[1]!) ? null : match[1]!;
			current.newPrefix = zeroPrefix(match[2]!) ? null : match[2]!;
			if (match[3] !== undefined) current.mode = checkMode(match[3]);
			continue;
		}
		if (line.startsWith("new file mode ")) {
			if (current.newFile || current.deleted) refuse("delta-malformed", "파일 종류 표시가 중복됩니다.");
			current.newFile = true;
			current.mode = checkMode(line.slice("new file mode ".length));
			continue;
		}
		if (line.startsWith("deleted file mode ")) {
			if (current.newFile || current.deleted) refuse("delta-malformed", "파일 종류 표시가 중복됩니다.");
			current.deleted = true;
			current.mode = checkMode(line.slice("deleted file mode ".length));
			continue;
		}
		if (line.startsWith("old mode ") || line.startsWith("new mode ")) {
			refuse("delta-mode-only", `${current.gitPath}: 내용 없는 모드 변경은 지원하지 않습니다.`);
		}
		if (
			line.startsWith("similarity index ") ||
			line.startsWith("dissimilarity index ") ||
			line.startsWith("rename from ") ||
			line.startsWith("rename to ") ||
			line.startsWith("copy from ") ||
			line.startsWith("copy to ")
		) {
			refuse("delta-rename", `${current.gitPath}: rename/copy 메타데이터는 지원하지 않습니다.`);
		}
		if (line.startsWith("Binary files ") && line.endsWith(" differ")) {
			refuse("delta-binary-unproved", `${current.gitPath}: full index 없는 binary 변경은 지원하지 않습니다.`);
		}
		if (line === "GIT binary patch") {
			if (current.binary) refuse("delta-malformed", `${current.gitPath}: binary 표시가 중복됩니다.`);
			current.binary = true;
			inBinary = true;
			binaryBlocks = 0;
			continue;
		}
		if (line.startsWith("literal ") || line.startsWith("delta ")) {
			if (!current.binary) refuse("delta-malformed", `${current.gitPath}: binary 블록 밖의 literal/delta 줄입니다.`);
			inBinary = true;
			if (!/^(literal|delta) \d+$/u.test(line)) refuse("delta-malformed", `${current.gitPath}: binary 블록 머리가 올바르지 않습니다.`);
			binaryBlocks++;
			continue;
		}
		if (inBinary) {
			if (/^[A-Za-z0-9!#$%&()*+\-;<=>?@^_`{|}~]+$/u.test(line)) continue;
			refuse("delta-malformed", `${current.gitPath}: binary 블록 안에 알 수 없는 줄이 있습니다.`);
		}
		if (line.startsWith("--- ")) {
			if (current.hasOldMarker) refuse("delta-malformed", `${current.gitPath}: --- 줄이 중복됩니다.`);
			current.hasOldMarker = true;
			const value = line.slice(4);
			if (value === "/dev/null") current.oldNull = true;
			else if (value === `a/${current.gitPath}`) {
				// exact marker
			} else refuse("delta-malformed", `${current.gitPath}: --- 경로가 diff 머리와 다릅니다.`);
			continue;
		}
		if (line.startsWith("+++ ")) {
			if (current.hasNewMarker) refuse("delta-malformed", `${current.gitPath}: +++ 줄이 중복됩니다.`);
			current.hasNewMarker = true;
			const value = line.slice(4);
			if (value === "/dev/null") current.newNull = true;
			else if (value === `b/${current.gitPath}`) {
				// exact marker
			} else refuse("delta-malformed", `${current.gitPath}: +++ 경로가 diff 머리와 다릅니다.`);
			continue;
		}
		const hunk = HUNK_LINE.exec(line);
		if (hunk !== null) {
			if (current.binary) refuse("delta-malformed", `${current.gitPath}: binary 항목에 hunk가 있습니다.`);
			if (!current.hasOldMarker || !current.hasNewMarker) refuse("delta-malformed", `${current.gitPath}: hunk 앞에 파일 표시가 없습니다.`);
			const oldCount = hunk[2] === undefined ? 1 : Number(hunk[2]);
			const newCount = hunk[4] === undefined ? 1 : Number(hunk[4]);
			if (!Number.isSafeInteger(oldCount) || !Number.isSafeInteger(newCount) || oldCount < 0 || newCount < 0) {
				refuse("delta-malformed", `${current.gitPath}: hunk 머리가 올바르지 않습니다.`);
			}
			current.hunks++;
			remainingOld = oldCount;
			remainingNew = newCount;
			inHunk = remainingOld > 0 || remainingNew > 0;
			continue;
		}
		refuse("delta-malformed", `${current.gitPath}: 알 수 없는 패치 줄입니다: ${JSON.stringify(line.slice(0, 80))}`);
	}
	if (current !== undefined) {
		if (inHunk && (remainingOld > 0 || remainingNew > 0)) refuse("delta-malformed", "패치 hunk가 선언한 줄 수보다 일찍 끝났습니다.");
		if (inBinary && binaryBlocks === 0) refuse("delta-malformed", `${current.gitPath}: binary 블록이 비어 있습니다.`);
		drafts.push(current);
	}
	if (drafts.length === 0) refuse("delta-empty-proof", "패치에 파일 항목이 없습니다.");
	return drafts;
}

function validateDraft(draft: Draft): void {
	if (!draft.hasIndex || draft.oldPrefix === null && draft.newPrefix === null) {
		refuse("delta-no-objects", `${draft.gitPath}: 객체 id가 있는 index 줄이 없습니다.`);
	}
	if (draft.mode === undefined) refuse("delta-no-mode", `${draft.gitPath}: 파일 모드를 증명할 수 없습니다.`);
	if (draft.binary) {
		if (draft.newFile || draft.deleted) refuse("delta-binary-kind", `${draft.gitPath}: binary 추가/삭제는 지원하지 않습니다.`);
		if (draft.oldPrefix === null || draft.newPrefix === null) refuse("delta-binary-kind", `${draft.gitPath}: binary 변경의 양쪽 객체가 필요합니다.`);
		if (draft.hasOldMarker || draft.hasNewMarker || draft.oldNull || draft.newNull) {
			refuse("delta-malformed", `${draft.gitPath}: binary 항목에 텍스트 파일 표시가 있습니다.`);
		}
		if (draft.hunks !== 0) refuse("delta-malformed", `${draft.gitPath}: binary 항목에 hunk가 있습니다.`);
		return;
	}
	if (draft.newFile) {
		if (draft.oldPrefix !== null || !draft.oldNull || draft.newNull || !draft.hasOldMarker || !draft.hasNewMarker) {
			refuse("delta-malformed", `${draft.gitPath}: 새 파일 표시가 일관되지 않습니다.`);
		}
		if (draft.newPrefix === null) refuse("delta-malformed", `${draft.gitPath}: 새 파일의 객체 id가 없습니다.`);
		if (draft.hunks === 0) refuse("delta-malformed", `${draft.gitPath}: 내용 없는 새 파일은 증명할 수 없습니다.`);
		return;
	}
	if (draft.deleted) {
		if (draft.newPrefix !== null || draft.oldPrefix === null || !draft.newNull || draft.oldNull || !draft.hasOldMarker || !draft.hasNewMarker) {
			refuse("delta-malformed", `${draft.gitPath}: 삭제 표시가 일관되지 않습니다.`);
		}
		if (draft.hunks === 0) refuse("delta-malformed", `${draft.gitPath}: 내용 없는 삭제는 증명할 수 없습니다.`);
		return;
	}
	if (draft.oldPrefix === null || draft.newPrefix === null) refuse("delta-malformed", `${draft.gitPath}: 수정 항목의 객체 id가 없습니다.`);
	if (draft.oldNull || draft.newNull) refuse("delta-malformed", `${draft.gitPath}: 수정 항목이 /dev/null을 가리킵니다.`);
	if (!draft.hasOldMarker || !draft.hasNewMarker || draft.hunks === 0) {
		refuse("delta-malformed", `${draft.gitPath}: 내용 변경 증거가 없습니다.`);
	}
}

function validateOdbIdentity(source: GitObjectSource, budget: ByteBudget): IntegrationProblem | undefined {
	if (source.objectFormat !== "sha1" && source.objectFormat !== "sha256") return problem("delta-odb", "객체 형식을 확인할 수 없습니다.");
	const text = [source.commonDir, source.objects];
	for (const space of text) {
		if (!path.isAbsolute(space.canonicalPath)) return problem("delta-odb", "객체 저장소 경로가 절대 경로가 아닙니다.");
		if (!/^\d+$/u.test(space.device) || !/^\d+$/u.test(space.inode)) return problem("delta-odb", "객체 저장소 identity가 올바르지 않습니다.");
	}
	return budget.problem();
}

async function verifySpaceIdentity(space: SpaceIdentity, what: string): Promise<void> {
	let real: string;
	let st: BigIntStats;
	try {
		real = await fs.realpath(space.canonicalPath);
		st = await fs.stat(real, { bigint: true });
	} catch {
		refuse("delta-odb", `${what} 경로를 확인할 수 없습니다: ${space.canonicalPath}`);
	}
	if (!st.isDirectory()) refuse("delta-odb", `디렉터리가 아닙니다: ${what} (${real})`);
	if (st.dev.toString() !== space.device || st.ino.toString() !== space.inode) {
		refuse("delta-odb", `${what}의 물리 identity가 바뀌었습니다: ${real}`);
	}
}

function gitObjectArgs(source: GitObjectSource): string[] {
	return ["--git-dir", source.commonDir.canonicalPath];
}

function objectEnv(source: GitObjectSource): Record<string, string> {
	return {
		GIT_OBJECT_DIRECTORY: source.objects.canonicalPath,
		GIT_NO_REPLACE_OBJECTS: "1",
	};
}

async function resolvePrefixes(
	prefixes: readonly string[],
	source: GitObjectSource,
	run: GitRun,
	budget: ByteBudget,
): Promise<Map<string, string>> {
	const resolved = new Map<string, string>();
	const width = source.objectFormat === "sha1" ? 40 : 64;
	for (const prefix of [...new Set(prefixes)]) {
		if (!/^[0-9a-f]+$/u.test(prefix) || prefix.length < 4 || prefix.length > width) {
			refuse("delta-object-name", `객체 id 접두사가 올바르지 않습니다: ${prefix}`);
		}
		const res = await run([...gitObjectArgs(source), "rev-parse", `--disambiguate=${prefix}`], {
			env: objectEnv(source),
			timeoutMs: Math.max(1_000, budget.window.deadline - Date.now()),
		});
		if (!res.started || res.code !== 0) refuse("delta-object-missing", `객체를 확인할 수 없습니다: ${prefix}`);
		const found = new Set<string>();
		for (const line of textOf(res.stdout).split("\n")) {
			const value = line.trim();
			if (value !== "" && /^[0-9a-f]+$/u.test(value)) found.add(value);
		}
		if (found.size === 0) refuse("delta-object-missing", `소스 객체 저장소에 없는 객체입니다: ${prefix}`);
		if (found.size > 1) refuse("delta-object-ambiguous", `객체 접두사가 여러 객체와 일치합니다: ${prefix}`);
		const oid = [...found][0]!;
		if (!oid.startsWith(prefix) || oid.length !== width) refuse("delta-object-mismatch", `객체 id가 접두사와 맞지 않습니다: ${prefix}`);
		resolved.set(prefix, oid);
	}
	return resolved;
}

/** Reads exact blob bytes in one `cat-file --batch`; a missing or non-blob object refuses the whole proof. */
async function readBlobs(
	oids: readonly string[],
	source: GitObjectSource,
	run: GitRun,
	budget: ByteBudget,
): Promise<Map<string, Uint8Array>> {
	const unique = [...new Set(oids)];
	const out = new Map<string, Uint8Array>();
	if (unique.length === 0) return out;
	const res = await run([...gitObjectArgs(source), "cat-file", "--batch"], {
		stdin: `${unique.join("\n")}\n`,
		env: objectEnv(source),
		timeoutMs: Math.max(1_000, budget.window.deadline - Date.now()),
	});
	if (!res.started || res.code !== 0) refuse("delta-object-read", "소스 객체 저장소를 읽을 수 없습니다.");
	const data = res.stdout;
	let at = 0;
	for (let index = 0; index < unique.length; index++) {
		const headerEnd = data.indexOf(0x0a, at);
		if (headerEnd < 0) refuse("delta-object-read", "객체 응답이 잘렸습니다.");
		const header = textOf(data.subarray(at, headerEnd));
		at = headerEnd + 1;
		const parts = header.split(" ");
		if (parts.length !== 3 || parts[1] !== "blob") {
			refuse("delta-object-type", `blob이 아닌 객체는 지원하지 않습니다: ${header}`);
		}
		if (!/^\d+$/u.test(parts[2]!)) refuse("delta-object-read", `객체 크기를 확인할 수 없습니다: ${header}`);
		const size = Number(parts[2]);
		if (!Number.isSafeInteger(size) || size < 0) refuse("delta-object-read", `객체 크기가 올바르지 않습니다: ${header}`);
		const charged = budget.charge(size);
		if (charged !== undefined) throw new Refusal(charged);
		const end = at + size;
		if (end > data.byteLength) refuse("delta-object-read", "객체 바이트가 잘렸습니다.");
		const bytes = data.subarray(at, end);
		if (bytes.byteLength !== size) refuse("delta-object-read", "객체 바이트 길이가 머리와 다릅니다.");
		out.set(parts[0]!, new Uint8Array(bytes));
		at = end + 1;
	}
	return out;
}

async function checkAttributes(gitRoot: string, gitPaths: readonly string[], run: GitRun, budget: ByteBudget): Promise<void> {
	if (gitPaths.length === 0) return;
	const res = await run(["-C", gitRoot, "check-attr", "-a", "--", ...gitPaths], {
		env: { GIT_OPTIONAL_LOCKS: "0" },
		timeoutMs: Math.max(1_000, budget.window.deadline - Date.now()),
	});
	if (!res.started || res.code !== 0) refuse("delta-attributes", "패치 대상의 Git attribute를 확인할 수 없습니다.");
	for (const line of textOf(res.stdout).split("\n")) {
		if (line.trim() === "") continue;
		// `<path>: <attr>: <value>`; any attribute means a filter/eol/encoding rule could change the bytes.
		refuse("delta-attributes", `패치 대상에 적용되는 Git attribute가 있습니다: ${line}`);
	}
}

/** Refuses a touched path whose ancestors contain a nested repository, without walking the whole tree. */
async function refuseNestedRepos(gitRoot: string, gitPaths: readonly string[]): Promise<void> {
	for (const gitPath of gitPaths) {
		const segments = gitPath.split("/");
		let current = gitRoot;
		for (const segment of segments.slice(0, -1)) {
			current = path.join(current, segment);
			try {
				const st = await fs.lstat(path.join(current, ".git"));
				if (st.isDirectory() || st.isFile() || st.isSymbolicLink()) {
					refuse("delta-nested-repo", `${gitPath}: 중첩 저장소 안의 경로는 지원하지 않습니다.`);
				}
			} catch (error) {
				if (errorCodeOf(error) !== "ENOENT") refuse("delta-unreadable", `${gitPath}: 상위 경로를 확인할 수 없습니다.`);
			}
		}
	}
}

async function verifyTargetIdentities(target: IntegrationTarget): Promise<void> {
	await verifySpaceIdentity(target.authorizedRoot, "승인 대상 루트");
	await verifySpaceIdentity(target.gitRoot, "Git 루트");
	await verifySpaceIdentity(target.gitDir, "Git 디렉터리");
	await verifySpaceIdentity(target.sourceOdb.commonDir, "Git common 디렉터리");
	await verifySpaceIdentity(target.sourceOdb.objects, "Git 객체 디렉터리");
	if (target.targetPrefix !== "") {
		const clean = cleanRelative(target.targetPrefix);
		if (clean === undefined || clean !== target.targetPrefix) refuse("delta-target-prefix", "승인 대상 접두사가 올바르지 않습니다.");
	}
}

async function verifyObjectFormat(source: GitObjectSource, run: GitRun, budget: ByteBudget): Promise<void> {
	const res = await run([...gitObjectArgs(source), "rev-parse", "--show-object-format"], {
		env: objectEnv(source),
		timeoutMs: Math.max(1_000, budget.window.deadline - Date.now()),
	});
	if (!res.started || res.code !== 0) refuse("delta-odb", "소스 객체 저장소의 형식을 확인할 수 없습니다.");
	const format = textOf(res.stdout).trim();
	if (format !== source.objectFormat) refuse("delta-odb", `객체 형식이 바인딩과 다릅니다: ${format}`);
}

interface ScratchEntry {
	readonly gitPath: string;
	readonly before: Uint8Array | null;
	readonly after: Uint8Array | null;
	readonly beforeMode: RegularFileMode | null;
	readonly afterMode: RegularFileMode | null;
}

async function verifyScratch(
	entries: readonly ScratchEntry[],
	patch: Uint8Array,
	run: GitRun,
	budget: ByteBudget,
	scratchParent: string | undefined,
): Promise<void> {
	const parent = scratchParent ?? os.tmpdir();
	const dir = await fs.mkdtemp(path.join(parent, SCRATCH_PREFIX));
	try {
		const init = await run(["init", "-q"], { cwd: dir });
		if (!init.started || init.code !== 0) refuse("delta-scratch", "검증용 임시 저장소를 만들 수 없습니다.");
		for (const entry of entries) {
			if (entry.before === null) continue;
			const file = path.join(dir, entry.gitPath);
			await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
			await fs.writeFile(file, entry.before);
			if (entry.beforeMode === "100755") await fs.chmod(file, 0o755);
		}
		const check = await run(["-c", "core.autocrlf=false", "-c", "core.safecrlf=false", "apply", "--check", "--binary", "--whitespace=nowarn"], {
			cwd: dir,
			stdin: patch,
			timeoutMs: Math.max(1_000, budget.window.deadline - Date.now()),
		});
		if (!check.started || check.code !== 0) {
			refuse("delta-scratch", `패치가 증명된 이전 바이트에 적용되지 않습니다: ${check.stderr.trim().slice(0, 300)}`);
		}
		const applied = await run(["-c", "core.autocrlf=false", "-c", "core.safecrlf=false", "apply", "--binary", "--whitespace=nowarn"], {
			cwd: dir,
			stdin: patch,
			timeoutMs: Math.max(1_000, budget.window.deadline - Date.now()),
		});
		if (!applied.started || applied.code !== 0) {
			refuse("delta-scratch", `패치를 검증용 임시 저장소에 적용할 수 없습니다: ${applied.stderr.trim().slice(0, 300)}`);
		}
		const expected = new Set(entries.filter(entry => entry.after !== null).map(entry => entry.gitPath));
		for (const entry of entries) {
			const file = path.join(dir, entry.gitPath);
			if (entry.after === null) {
				try {
					await fs.lstat(file);
					refuse("delta-scratch", `${entry.gitPath}: 삭제 후 파일이 남아 있습니다.`);
				} catch (error) {
					if (errorCodeOf(error) !== "ENOENT") throw error;
				}
				continue;
			}
			let st;
			try {
				st = await fs.lstat(file);
			} catch {
				refuse("delta-scratch", `${entry.gitPath}: 적용 후 파일이 없습니다.`);
			}
			if (!st.isFile() || st.isSymbolicLink()) refuse("delta-scratch", `${entry.gitPath}: 적용 결과가 일반 파일이 아닙니다.`);
			const bytes = await fs.readFile(file);
			if (bytes.byteLength !== entry.after.byteLength || !bytes.equals(entry.after)) {
				refuse("delta-scratch", `${entry.gitPath}: 적용 결과 바이트가 증명된 이후 상태와 다릅니다.`);
			}
			if (modeOf({ mode: BigInt(st.mode) }) !== entry.afterMode) {
				refuse("delta-scratch", `${entry.gitPath}: 적용 결과 모드가 증명된 이후 상태와 다릅니다.`);
			}
		}
		const extras = await listScratchFiles(dir);
		for (const relative of extras) {
			if (!expected.has(relative)) refuse("delta-scratch", `${relative}: 패치가 광고하지 않은 파일을 만들었습니다.`);
		}
	} finally {
		await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
	}
}

async function listScratchFiles(root: string, prefix = ""): Promise<string[]> {
	const out: string[] = [];
	const dir = prefix === "" ? root : path.join(root, prefix);
	const entries = await fs.readdir(dir, { withFileTypes: true });
	for (const entry of entries) {
		if (prefix === "" && entry.name === ".git") continue;
		const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
		if (entry.isDirectory()) out.push(...(await listScratchFiles(root, relative)));
		else out.push(relative);
	}
	return out;
}

export function deltaDigest(input: {
	readonly request: RootProofRequest;
	readonly entries: readonly ExactPathDelta[];
}): string {
	const { request, entries } = input;
	const target = request.target;
	const scope = request.scope.kind === "unbounded"
		? { kind: "unbounded" as const }
		: { kind: "paths" as const, paths: [...request.scope.paths] };
	return createHash("sha256")
		.update(JSON.stringify({
			schema: "storm.integration-delta/v1",
			key: request.key,
			candidateId: request.candidateId,
			target: {
				leaseKey: target.leaseKey,
				authorizedRoot: target.authorizedRoot.canonicalPath,
				gitRoot: target.gitRoot.canonicalPath,
				gitDir: target.gitDir.canonicalPath,
				targetPrefix: target.targetPrefix,
				objectFormat: target.sourceOdb.objectFormat,
			},
			scope,
			root: { objectKey: request.root.objectKey, bytes: request.root.bytes, sha256: request.root.sha256 },
			entries: entries.map(entry => ({
				gitPath: entry.gitPath,
				targetPath: entry.targetPath,
				encoding: entry.encoding,
				before: entry.before,
				after: entry.after,
			})),
		}))
		.digest("hex");
}

/** One target image read either exactly, as provable absence, or as unknown; a caller never invents an image. */
type ReadPath =
	| { readonly kind: "absent" }
	| { readonly kind: "file"; readonly image: FileImage; readonly bytes: Uint8Array }
	| { readonly kind: "unknown"; readonly problem: IntegrationProblem };

/**
 * Reads one target-relative regular file without following any link and without reading a path outside the root.
 * A missing final component is absence; a symlink, a non-regular file, a hard-link alias, a changed inode or an
 * oversized file is unknown. The same open handle is statted before and after the read.
 */
export async function readPathImage(root: string, relative: string, maxBytes = DELTA_MAX_FILE_BYTES): Promise<ReadPath> {
	const clean = cleanRelative(relative);
	if (clean === undefined) return { kind: "unknown", problem: problem("delta-unsafe-path", `경로가 안전하지 않습니다: ${relative}`, relative) };
	let current = root;
	const segments = clean.split("/");
	for (const segment of segments.slice(0, -1)) {
		current = path.join(current, segment);
		let st;
		try {
			st = await fs.lstat(current);
		} catch (error) {
			if (errorCodeOf(error) === "ENOENT") return { kind: "absent" };
			return { kind: "unknown", problem: problem("delta-unreadable", `경로를 확인할 수 없습니다: ${relative}`, relative) };
		}
		if (st.isSymbolicLink() || !st.isDirectory()) {
			return { kind: "unknown", problem: problem("delta-unsafe-path", `상위 경로가 안전하지 않습니다: ${relative}`, relative) };
		}
	}
	const file = path.join(root, clean);
	let handle: FileHandle | undefined;
	try {
		handle = await fs.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
	} catch (error) {
		if (errorCodeOf(error) === "ENOENT") return { kind: "absent" };
		return { kind: "unknown", problem: problem("delta-unreadable", `대상 파일을 열 수 없습니다: ${relative}`, relative) };
	}
	const opened = handle;
	try {
		const before = await opened.stat({ bigint: true });
		if (!before.isFile() || before.isSymbolicLink()) {
			return { kind: "unknown", problem: problem("delta-unsafe-path", `일반 파일이 아닙니다: ${relative}`, relative) };
		}
		if (before.nlink > 1n) {
			return { kind: "unknown", problem: problem("delta-hardlink", `하드 링크된 파일은 안전하게 증명할 수 없습니다: ${relative}`, relative) };
		}
		if (before.size > BigInt(maxBytes)) {
			return { kind: "unknown", problem: problem("delta-too-large", `파일이 한도보다 큽니다: ${relative}`, relative) };
		}
		const bytes = new Uint8Array(await opened.readFile());
		const after = await opened.stat({ bigint: true });
		if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs) {
			return { kind: "unknown", problem: problem("delta-changed", `읽는 동안 파일이 바뀌었습니다: ${relative}`, relative) };
		}
		if (bytes.byteLength !== Number(before.size)) {
			return { kind: "unknown", problem: problem("delta-changed", `읽은 바이트 길이가 파일 크기와 다릅니다: ${relative}`, relative) };
		}
		return { kind: "file", image: imageOfBytes(bytes, modeOf(before)), bytes };
	} catch {
		return { kind: "unknown", problem: problem("delta-unreadable", `대상 파일을 읽을 수 없습니다: ${relative}`, relative) };
	} finally {
		await opened.close().catch(() => undefined);
	}
}

export interface GitDeltaOptions {
	readonly bytes: IntegrationBytePort;
	readonly run?: GitRun;
	readonly now?: () => number;
	readonly scratchParent?: string;
	readonly maxExpandedBytes?: number;
	readonly maxTouchedPaths?: number;
}

/** B's `IntegrationDeltaPort`: strict proof, checkout-input verification and bounded presence/dirt observations. */
export class GitDelta implements IntegrationDeltaPort {
	private readonly bytes: IntegrationBytePort;
	private readonly run: GitRun;
	private readonly now: () => number;
	private readonly scratchParent: string | undefined;
	private readonly maxExpandedBytes: number;
	private readonly maxTouchedPaths: number;

	constructor(options: GitDeltaOptions) {
		this.bytes = options.bytes;
		this.run = options.run ?? spawnGit;
		this.now = options.now ?? Date.now;
		this.scratchParent = options.scratchParent;
		this.maxExpandedBytes = options.maxExpandedBytes ?? DELTA_MAX_EXPANDED_BYTES;
		this.maxTouchedPaths = options.maxTouchedPaths ?? DELTA_MAX_TOUCHED_PATHS;
	}

	async proveRoot(request: RootProofRequest, window: ByteWindow): Promise<IntegrationRead<ExactDeltaProof>> {
		const budget = new ByteBudget(window, this.now, this.maxExpandedBytes);
		try {
			const early = budget.problem();
			if (early !== undefined) return { kind: "unknown", problem: early };
			const odb = validateOdbIdentity(request.target.sourceOdb, budget);
			if (odb !== undefined) return { kind: "unknown", problem: odb };
			await verifyTargetIdentities(request.target);
			await verifyObjectFormat(request.target.sourceOdb, this.run, budget);
			const patch = await this.#readPatch(request, window);
			if (patch.bytes.byteLength === 0) return { kind: "unknown", problem: problem("delta-empty-patch", "루트 패치가 비어 있습니다.") };
			let text: string;
			try {
				text = new TextDecoder("utf-8", { fatal: true }).decode(patch.bytes);
			} catch {
				return { kind: "unknown", problem: problem("delta-malformed", "패치가 UTF-8이 아닙니다.") };
			}
			const drafts = parseRootPatch(text);
			if (drafts.length > this.maxTouchedPaths) {
				return { kind: "unknown", problem: problem("delta-too-many-paths", `패치 경로가 한도(${this.maxTouchedPaths})를 넘습니다.`) };
			}
			for (const draft of drafts) validateDraft(draft);
			const aliases = new Map<string, string>();
			for (const draft of drafts) {
				const key = aliasKey(draft.gitPath);
				const previous = aliases.get(key);
				if (previous !== undefined) {
					return { kind: "unknown", problem: problem("delta-path-alias", `같은 파일로 해석될 수 있는 경로가 둘입니다: ${previous}, ${draft.gitPath}`) };
				}
				aliases.set(key, draft.gitPath);
			}
			const sorted = [...aliases.keys()].sort();
			for (let index = 1; index < sorted.length; index++) {
				if (sorted[index]!.startsWith(`${sorted[index - 1]}/`)) {
					return { kind: "unknown", problem: problem("delta-path-alias", `경로가 다른 항목의 상위 디렉터리입니다: ${sorted[index - 1]}`) };
				}
			}
			const prefixes = drafts.flatMap(draft => [draft.oldPrefix, draft.newPrefix]).filter((value): value is string => value !== null);
			const resolved = await resolvePrefixes(prefixes, request.target.sourceOdb, this.run, budget);
			const blobs = await readBlobs([...resolved.values()], request.target.sourceOdb, this.run, budget);
			const entries: ExactPathDelta[] = [];
			const scratch: ScratchEntry[] = [];
			for (const draft of drafts) {
				const targetPath = request.target.targetPrefix === ""
					? draft.gitPath
					: draft.gitPath.startsWith(`${request.target.targetPrefix}/`)
						? draft.gitPath.slice(request.target.targetPrefix.length + 1)
						: undefined;
				if (targetPath === undefined) {
					return { kind: "unknown", problem: problem("delta-outside-target", `패치 경로가 승인 대상 밖입니다: ${draft.gitPath}`, draft.gitPath) };
				}
				if (!isInsideScope(targetPath, request.scope)) {
					return { kind: "unknown", problem: problem("delta-outside-scope", `패치 경로가 동결된 범위 밖입니다: ${targetPath}`, targetPath) };
				}
				const cleanTarget = cleanRelative(targetPath);
				if (cleanTarget === undefined) {
					return { kind: "unknown", problem: problem("delta-unsafe-path", `대상 경로가 안전하지 않습니다: ${targetPath}`, targetPath) };
				}
				const oldOid = draft.oldPrefix === null ? null : resolved.get(draft.oldPrefix) ?? null;
				const newOid = draft.newPrefix === null ? null : resolved.get(draft.newPrefix) ?? null;
				const beforeBytes = oldOid === null ? null : blobs.get(oldOid) ?? null;
				const afterBytes = newOid === null ? null : blobs.get(newOid) ?? null;
				if ((oldOid !== null && beforeBytes === null) || (newOid !== null && afterBytes === null)) {
					return { kind: "unknown", problem: problem("delta-object-read", `객체 바이트를 읽지 못했습니다: ${draft.gitPath}`, draft.gitPath) };
				}
				const mode = draft.mode!;
				const before: DeltaImage = beforeBytes === null
					? { state: { kind: "absent" } }
					: { state: imageOfBytes(beforeBytes, mode), oid: oldOid! };
				const after: DeltaImage = afterBytes === null
					? { state: { kind: "absent" } }
					: { state: imageOfBytes(afterBytes, mode), oid: newOid! };
				const encoding = draft.binary ? "binary" : "text";
				const entry: ExactPathDelta = { gitPath: draft.gitPath, targetPath: cleanTarget, encoding, before, after };
				entries.push(entry);
				scratch.push({
					gitPath: draft.gitPath,
					before: beforeBytes,
					after: afterBytes,
					beforeMode: beforeBytes === null ? null : mode,
					afterMode: afterBytes === null ? null : mode,
				});
			}
			await checkAttributes(request.target.gitRoot.canonicalPath, drafts.map(draft => draft.gitPath), this.run, budget);
			await refuseNestedRepos(request.target.gitRoot.canonicalPath, drafts.map(draft => draft.gitPath));
			await verifyScratch(scratch, patch.bytes, this.run, budget, this.scratchParent);
			const digest = deltaDigest({ request, entries });
			return {
				kind: "known",
				value: {
					...request,
					schema: "storm.integration-delta/v1",
					digest,
					entries,
					expandedBytes: budget.used,
				},
			};
		} catch (error) {
			if (error instanceof Refusal) return { kind: "unknown", problem: error.problemValue };
			return { kind: "unknown", problem: problem("delta-internal", error instanceof Error ? error.message : String(error)) };
		}
	}

	async #readPatch(request: RootProofRequest, window: ByteWindow): Promise<{ bytes: Uint8Array }> {
		const read = await this.bytes.readPatch(request.root, window);
		if (read.kind === "unknown") throw new Refusal(read.problem);
		const bytes = read.value;
		if (!(bytes instanceof Uint8Array)) refuse("delta-patch", "패치 바이트가 올바르지 않습니다.");
		if (request.root.bytes > DELTA_MAX_PATCH_BYTES || bytes.byteLength > DELTA_MAX_PATCH_BYTES) {
			refuse("delta-too-large", `루트 패치가 한도(${DELTA_MAX_PATCH_BYTES} bytes)를 넘습니다.`);
		}
		if (bytes.byteLength !== request.root.bytes) {
			refuse("delta-patch", `패치 바이트 길이가 저장된 값과 다릅니다: ${bytes.byteLength} != ${request.root.bytes}`);
		}
		if (hash(bytes) !== request.root.sha256) refuse("delta-patch", "패치 바이트 다이제스트가 저장된 값과 다릅니다.");
		return { bytes };
	}

	async verifyCheckoutInputs(claim: ChildEntryClaim, inputs: readonly ConsumedInput[], window: ByteWindow): Promise<IntegrationCheck> {
		const budget = new ByteBudget(window, this.now);
		try {
			const early = budget.problem();
			if (early !== undefined) return { ok: false, problem: early };
			if (claim.guardBuild.trim() === "" || claim.policyProofId.trim() === "") {
				return { ok: false, problem: problem("checkout-claim", "자식 진입 증거가 완전하지 않습니다.") };
			}
			const checkout = claim.checkout;
			let real: string;
			let st: BigIntStats;
			try {
				real = await fs.realpath(checkout.canonicalPath);
				st = await fs.stat(real, { bigint: true });
			} catch {
				return { ok: false, problem: problem("checkout-missing", "자식 체크아웃을 확인할 수 없습니다.") };
			}
			if (!st.isDirectory() || st.dev.toString() !== checkout.device || st.ino.toString() !== checkout.inode) {
				return { ok: false, problem: problem("checkout-changed", "자식 체크아웃의 물리 identity가 바뀌었습니다.") };
			}
			if (claim.checkoutTargetPrefix !== "" && cleanRelative(claim.checkoutTargetPrefix) !== claim.checkoutTargetPrefix) {
				return { ok: false, problem: problem("checkout-prefix", "자식 체크아웃 접두사가 올바르지 않습니다.") };
			}
			for (const input of inputs) {
				if (input.state !== "integrated") continue;
				for (const located of input.paths) {
					const relative = joinPrefix(claim.checkoutTargetPrefix, located.path);
					const read = await readPathImage(real, relative);
					if (read.kind === "unknown") return { ok: false, problem: read.problem };
					const image = read.kind === "absent" ? { kind: "absent" as const } : read.image;
					if (!sameImage(image, located.image)) {
						return {
							ok: false,
							problem: problem("checkout-input-changed", `자식 체크아웃의 입력 바이트가 소비한 버전과 다릅니다: ${located.path}`, located.path),
						};
					}
				}
			}
			return { ok: true };
		} catch (error) {
			return {
				ok: false,
				problem: error instanceof Refusal ? error.problemValue : problem("delta-internal", error instanceof Error ? error.message : String(error)),
			};
		}
	}

	async observePresence(target: IntegrationTarget, paths: readonly LocatedInputPath[], window: ByteWindow): Promise<Presence> {
		const budget = new ByteBudget(window, this.now);
		const early = budget.problem();
		if (early !== undefined) return { kind: "unknown", problem: early };
		if (paths.length === 0) return { kind: "unknown", problem: problem("presence-no-paths", "확인할 대상 경로가 없습니다.") };
		try {
			await verifyTargetIdentities(target);
			for (const located of paths) {
				const read = await readPathImage(target.authorizedRoot.canonicalPath, located.path);
				if (read.kind === "unknown") return { kind: "unknown", problem: read.problem };
				const image = read.kind === "absent" ? { kind: "absent" as const } : read.image;
				if (!sameImage(image, located.image)) {
					return { kind: "changed", observedAt: this.now(), firstPath: located.path };
				}
			}
			return { kind: "present", observedAt: this.now() };
		} catch (error) {
			return {
				kind: "unknown",
				problem: error instanceof Refusal ? error.problemValue : problem("delta-internal", error instanceof Error ? error.message : String(error)),
			};
		}
	}

	async observeDirtyPaths(proof: ExactDeltaProof, window: ByteWindow): Promise<IntegrationRead<DirtyPaths>> {
		const budget = new ByteBudget(window, this.now);
		try {
			const early = budget.problem();
			if (early !== undefined) return { kind: "unknown", problem: early };
			await verifyTargetIdentities(proof.target);
			if (proof.entries.length > this.maxTouchedPaths) {
				return { kind: "unknown", problem: problem("delta-too-many-paths", `패치 경로가 한도(${this.maxTouchedPaths})를 넘습니다.`) };
			}
			const gitPaths = proof.entries.map(entry => entry.gitPath);
			const status = await statusForPaths(proof.target.gitRoot.canonicalPath, gitPaths, this.run, budget);
			if (status.kind === "unknown") return status;
			const targetByGit = new Map(proof.entries.map(entry => [entry.gitPath, entry.targetPath]));
			const deletePaths = new Set(proof.entries.filter(entry => entry.after.state.kind === "absent").map(entry => entry.gitPath));
			const dirty = new Set<string>();
			const dirtyDeletes = new Set<string>();
			for (const [gitPath, entry] of status.paths) {
				const targetPath = targetByGit.get(gitPath);
				if (targetPath === undefined) continue;
				const dirtyIndex = entry.index !== ".";
				const dirtyWorktree = entry.worktree !== ".";
				const untracked = entry.untracked;
				if (!dirtyIndex && !dirtyWorktree && !untracked) continue;
				dirty.add(targetPath);
				if (deletePaths.has(gitPath) && (untracked || dirtyIndex || dirtyWorktree)) dirtyDeletes.add(targetPath);
			}
			return {
				kind: "known",
				value: {
					total: dirty.size,
					examples: [...dirty].slice(0, 8),
					dirtyDeletes: [...dirtyDeletes].slice(0, 8),
				},
			};
		} catch (error) {
			return {
				kind: "unknown",
				problem: error instanceof Refusal ? error.problemValue : problem("delta-internal", error instanceof Error ? error.message : String(error)),
			};
		}
	}
}

interface StatusEntry {
	readonly index: string;
	readonly worktree: string;
	readonly untracked: boolean;
}

export type StatusRead =
	| { readonly kind: "known"; readonly paths: ReadonlyMap<string, StatusEntry> }
	| { readonly kind: "unknown"; readonly problem: IntegrationProblem };

/** One bounded `git status` over exactly the touched paths; no worktree scan and no index refresh. */
export async function statusForPaths(
	gitRoot: string,
	gitPaths: readonly string[],
	run: GitRun,
	budget: ByteBudget,
): Promise<StatusRead> {
	if (gitPaths.length === 0) return { kind: "known", paths: new Map() };
	const res = await run(["-C", gitRoot, "status", "--porcelain=v2", "-z", "--untracked-files=all", "--", ...gitPaths], {
		env: { GIT_OPTIONAL_LOCKS: "0" },
		timeoutMs: Math.max(1_000, budget.window.deadline - Date.now()),
	});
	if (!res.started || res.code !== 0) {
		return { kind: "unknown", problem: problem("delta-status", "대상의 Git 상태를 확인할 수 없습니다.") };
	}
	const entries = new Map<string, StatusEntry>();
	const text = textOf(res.stdout);
	const records = text.split("\u0000").filter(record => record !== "");
	for (const record of records) {
		if (record.startsWith("? ")) {
			const gitPath = record.slice(2);
			entries.set(gitPath, { index: "?", worktree: "?", untracked: true });
			continue;
		}
		if (record.startsWith("u ")) {
			return { kind: "unknown", problem: problem("delta-unmerged", "병합되지 않은 경로가 있어 통합할 수 없습니다.") };
		}
		if (record.startsWith("1 ")) {
			const match = /^1 ([^ ]{2}) [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ (.+)$/su.exec(record);
			if (match === null) return { kind: "unknown", problem: problem("delta-status", "Git 상태 기록이 올바르지 않습니다.") };
			const xy = match[1]!;
			entries.set(match[2]!, { index: xy[0]!, worktree: xy[1]!, untracked: false });
			continue;
		}
		if (record.startsWith("2 ")) {
			// A rename/copy in the user's WIP is dirt on both named paths; the original name follows in the next NUL field.
			const match = /^2 ([^ ]{2}) [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ (.+)$/su.exec(record);
			if (match === null) return { kind: "unknown", problem: problem("delta-status", "Git rename 상태 기록이 올바르지 않습니다.") };
			const xy = match[1]!;
			entries.set(match[2]!, { index: xy[0]!, worktree: xy[1]!, untracked: false });
			continue;
		}
	}
	return { kind: "known", paths: entries };
}

export interface FootprintHead {
	readonly mode: string;
	readonly oid: string;
}

export interface FootprintIndex {
	readonly mode: string;
	readonly oid: string;
}

export interface FootprintPath {
	readonly gitPath: string;
	readonly targetPath: string;
	readonly before: DeltaImage;
	readonly after: DeltaImage;
	readonly head: FootprintHead | null;
	readonly index: FootprintIndex | null;
}

export interface Footprint {
	readonly paths: readonly FootprintPath[];
	readonly head: { readonly ref: string | null; readonly oid: string | null };
	readonly index: {
		readonly path: string;
		readonly file: SpaceIdentity | null;
		readonly sha256: string | null;
	};
}

export type FootprintRead = IntegrationRead<Footprint>;

function parseLsTree(text: string): Map<string, FootprintHead> {
	const out = new Map<string, FootprintHead>();
	for (const record of text.split("\u0000")) {
		if (record === "") continue;
		const tab = record.indexOf("\t");
		if (tab < 0) continue;
		const meta = record.slice(0, tab).split(" ");
		if (meta.length !== 3) continue;
		out.set(record.slice(tab + 1), { mode: meta[0]!, oid: meta[2]! });
	}
	return out;
}

function parseLsFiles(text: string): { paths: Map<string, FootprintIndex>; unmerged: boolean } {
	const paths = new Map<string, FootprintIndex>();
	let unmerged = false;
	for (const record of text.split("\u0000")) {
		if (record === "") continue;
		const tab = record.indexOf("\t");
		if (tab < 0) continue;
		const meta = record.slice(0, tab).split(" ");
		if (meta.length !== 3) continue;
		const stage = meta[2]!;
		if (stage !== "0") {
			unmerged = true;
			continue;
		}
		paths.set(record.slice(tab + 1), { mode: meta[0]!, oid: meta[1]! });
	}
	return { paths, unmerged };
}

function indexIdentity(filePath: string, st: { dev: bigint; ino: bigint }): SpaceIdentity {
	return { canonicalPath: filePath, device: st.dev.toString(), inode: st.ino.toString() };
}

/** Every strict ancestor of a repo-relative path, root first. */
function strictAncestorsOf(gitPath: string): string[] {
	const parts = gitPath.split("/");
	const out: string[] = [];
	for (let index = 1; index < parts.length; index++) out.push(parts.slice(0, index).join("/"));
	return out;
}

/** Adds every strict ancestor of a tracked path to the set of directories that contain a tracked entry. */
function addTrackedParents(gitPath: string, parents: Set<string>): void {
	for (const ancestor of strictAncestorsOf(gitPath)) parents.add(ancestor);
}

interface AncestorQuery {
	readonly ancestor: string;
	readonly source: "head" | "index";
}

/**
 * Exact D/F topology for the touched paths. `ls-tree -r`/`ls-files` already name real descendants; a batched
 * `cat-file --batch-check` names any tracked non-directory at a strict ancestor without listing a subtree.
 */
async function readBlockingAncestors(
	gitRoot: string,
	gitPaths: readonly string[],
	headOid: string | null,
	run: GitRun,
	budget: ByteBudget,
): Promise<IntegrationRead<ReadonlySet<string>>> {
	const queries: AncestorQuery[] = [];
	for (const ancestor of new Set(gitPaths.flatMap(strictAncestorsOf))) {
		if (headOid !== null) queries.push({ ancestor, source: "head" });
		queries.push({ ancestor, source: "index" });
	}
	if (queries.length === 0) return { kind: "known", value: new Set() };
	const res = await run(["-C", gitRoot, "cat-file", "--batch-check"], {
		stdin: queries.map(query => `${query.source === "head" ? "HEAD" : ""}:${query.ancestor}\n`).join(""),
		env: { GIT_OPTIONAL_LOCKS: "0" },
		timeoutMs: Math.max(1_000, budget.window.deadline - Date.now()),
	});
	if (!res.started || res.code !== 0) {
		return { kind: "unknown", problem: problem("delta-topology", "대상의 상위 Git 경로 상태를 확인할 수 없습니다.") };
	}
	const lines = textOf(res.stdout).split("\n");
	if (lines[lines.length - 1] === "") lines.pop();
	if (lines.length !== queries.length) {
		return { kind: "unknown", problem: problem("delta-topology", "상위 Git 경로 응답 수가 요청과 다릅니다.") };
	}
	const blocking = new Set<string>();
	for (let index = 0; index < queries.length; index++) {
		const query = queries[index]!;
		const fields = lines[index]!.split(" ");
		const type = fields.length >= 2 && fields[1] !== "missing" ? fields[1] : undefined;
		if (type === undefined) continue;
		// HEAD may legitimately name a tracked directory; every other resolved form is a file/gitlink ancestor.
		if (query.source === "head" && type === "tree") continue;
		blocking.add(query.ancestor);
	}
	return { kind: "known", value: blocking };
}

export interface GoldPath {
	readonly gitPath: string;
	readonly worktree: PathImage;
	readonly head: FootprintHead | null;
	readonly index: FootprintIndex | null;
	/** A HEAD or index entry at a strict ancestor path that is not a directory, so an add below it is a D/F conflict. */
	readonly blockingAncestor?: string;
	/** True when HEAD or index tracks any entry strictly below this path, so an add here is a D/F conflict. */
	readonly hasTrackedDescendant?: boolean;
}

export interface GoldState {
	readonly paths: readonly GoldPath[];
	readonly head: Footprint["head"];
	readonly index: Footprint["index"];
}

export type GoldRead = IntegrationRead<GoldState>;

/** Reads the exact HEAD/index state of the touched paths plus the index file identity; never computes a tree diff. */
export async function readGoldState(
	target: IntegrationTarget,
	gitPaths: readonly string[],
	run: GitRun,
	budget: ByteBudget,
	options: { readonly topology?: boolean } = {},
): Promise<GoldRead> {
	try {
		const early = budget.problem();
		if (early !== undefined) return { kind: "unknown", problem: early };
		await verifyTargetIdentities(target);
		await refuseNestedRepos(target.gitRoot.canonicalPath, gitPaths);
		const gitRoot = target.gitRoot.canonicalPath;
		const headRefRes = await run(["-C", gitRoot, "symbolic-ref", "-q", "HEAD"], {
			timeoutMs: Math.max(1_000, budget.window.deadline - Date.now()),
		});
		const headRef = headRefRes.started && headRefRes.code === 0 ? textOf(headRefRes.stdout).trim() || null : null;
		const headRes = await run(["-C", gitRoot, "rev-parse", "--verify", "HEAD"], {
			timeoutMs: Math.max(1_000, budget.window.deadline - Date.now()),
		});
		const headOid = headRes.started && headRes.code === 0 ? textOf(headRes.stdout).trim() || null : null;
		let headEntries = new Map<string, FootprintHead>();
		if (headOid !== null) {
			const tree = await run(["-C", gitRoot, "ls-tree", "-r", "-z", "--full-tree", "HEAD", "--", ...gitPaths], {
				timeoutMs: Math.max(1_000, budget.window.deadline - Date.now()),
			});
			if (!tree.started || tree.code !== 0) return { kind: "unknown", problem: problem("delta-head", "HEAD 경로 상태를 확인할 수 없습니다.") };
			headEntries = parseLsTree(textOf(tree.stdout));
		}
		const files = await run(["-C", gitRoot, "ls-files", "--stage", "-z", "--", ...gitPaths], {
			timeoutMs: Math.max(1_000, budget.window.deadline - Date.now()),
		});
		if (!files.started || files.code !== 0) return { kind: "unknown", problem: problem("delta-index", "index 경로 상태를 확인할 수 없습니다.") };
		const parsed = parseLsFiles(textOf(files.stdout));
		if (parsed.unmerged) return { kind: "unknown", problem: problem("delta-unmerged", "병합되지 않은 index 경로가 있습니다.") };
		const topology = options.topology !== false;
		const descendantParents = new Set<string>();
		let blockingAncestors: ReadonlySet<string> = new Set();
		if (topology) {
			for (const key of headEntries.keys()) addTrackedParents(key, descendantParents);
			for (const key of parsed.paths.keys()) addTrackedParents(key, descendantParents);
			const blocking = await readBlockingAncestors(gitRoot, gitPaths, headOid, run, budget);
			if (blocking.kind === "unknown") return blocking;
			blockingAncestors = blocking.value;
		}
		const indexFile = path.join(target.gitDir.canonicalPath, "index");
		let indexSpace: SpaceIdentity | null = null;
		let indexSha: string | null = null;
		try {
			const st = await fs.stat(indexFile, { bigint: true });
			indexSpace = indexIdentity(indexFile, st);
			if (st.size <= BigInt(MAX_INDEX_HASH_BYTES)) indexSha = hash(new Uint8Array(await fs.readFile(indexFile)));
		} catch (error) {
			if (errorCodeOf(error) !== "ENOENT") {
				return { kind: "unknown", problem: problem("delta-index", "index 파일 identity를 확인할 수 없습니다.") };
			}
		}
		const paths: GoldPath[] = [];
		for (const gitPath of gitPaths) {
			const targetPath = target.targetPrefix === "" ? gitPath : gitPath.startsWith(`${target.targetPrefix}/`) ? gitPath.slice(target.targetPrefix.length + 1) : gitPath;
			const read = await readPathImage(target.authorizedRoot.canonicalPath, targetPath);
			if (read.kind === "unknown") return { kind: "unknown", problem: read.problem };
			const blockingAncestor = topology ? strictAncestorsOf(gitPath).find(ancestor => blockingAncestors.has(ancestor)) : undefined;
			paths.push({
				gitPath,
				worktree: read.kind === "absent" ? { kind: "absent" } : read.image,
				head: headEntries.get(gitPath) ?? null,
				index: parsed.paths.get(gitPath) ?? null,
				...(blockingAncestor === undefined ? {} : { blockingAncestor }),
				...(topology && descendantParents.has(gitPath) ? { hasTrackedDescendant: true } : {}),
			});
		}
		return {
			kind: "known",
			value: { paths, head: { ref: headRef, oid: headOid }, index: { path: indexFile, file: indexSpace, sha256: indexSha } },
		};
	} catch (error) {
		return {
			kind: "unknown",
			problem: error instanceof Refusal ? error.problemValue : problem("delta-internal", error instanceof Error ? error.message : String(error)),
		};
	}
}

/** Binds a proof's images to the exact HEAD/index state taken at intent, without a second path scan. */
export async function readFootprint(
	proof: ExactDeltaProof,
	target: IntegrationTarget,
	run: GitRun,
	budget: ByteBudget,
): Promise<FootprintRead> {
	const gold = await readGoldState(target, proof.entries.map(entry => entry.gitPath), run, budget);
	if (gold.kind === "unknown") return gold;
	const byPath = new Map(gold.value.paths.map(path => [path.gitPath, path]));
	const paths: FootprintPath[] = [];
	for (const entry of proof.entries) {
		const live = byPath.get(entry.gitPath);
		if (live === undefined) return { kind: "unknown", problem: problem("delta-footprint", `대상 경로를 다시 읽지 못했습니다: ${entry.targetPath}`) };
		const footprintPath: FootprintPath = {
			gitPath: entry.gitPath,
			targetPath: entry.targetPath,
			before: entry.before,
			after: entry.after,
			head: live.head,
			index: live.index,
		};
		if (footprintPath.before.state.kind === "absent") {
			const add = checkAddAllowed(footprintPath, live);
			if (!add.ok) return { kind: "unknown", problem: add.problem };
		}
		paths.push(footprintPath);
	}
	return { kind: "known", value: { paths, head: gold.value.head, index: gold.value.index } };
}

/** A tracked non-directory ancestor or descendant conflicts with an absent-name add even if the live path is absent. */
function checkAddTopology(live: GoldPath, targetPath: string): IntegrationCheck {
	if (live.blockingAncestor !== undefined) {
		return {
			ok: false,
			problem: problem(
				"delta-absent-add-conflict",
				`새 파일 경로의 상위가 Git에서 파일입니다: ${live.blockingAncestor} (${targetPath})`,
				targetPath,
			),
		};
	}
	if (live.hasTrackedDescendant === true) {
		return {
			ok: false,
			problem: problem(
				"delta-absent-add-conflict",
				`새 파일 경로 아래에 Git이 추적하는 항목이 있습니다: ${targetPath}`,
				targetPath,
			),
		};
	}
	return { ok: true };
}

function checkAddAllowed(path: FootprintPath, live: GoldPath): IntegrationCheck {
	if (path.head !== null || path.index !== null) {
		return {
			ok: false,
			problem: problem("delta-absent-add-conflict", `새 파일 경로가 이미 Git에 있습니다: ${path.targetPath}`, path.targetPath),
		};
	}
	return checkAddTopology(live, path.targetPath);
}

function dirtyDelete(path: FootprintPath): IntegrationCheck {
	return {
		ok: false,
		problem: problem(
			"delta-dirty-delete",
			`삭제할 이전 바이트나 모드가 HEAD/index의 커밋된 값과 다릅니다: ${path.targetPath}`,
			path.targetPath,
		),
	};
}

function checkDeleteClean(path: FootprintPath, status: ReadonlyMap<string, StatusEntry>): IntegrationCheck {
	if (path.head === null || path.index === null) {
		return {
			ok: false,
			problem: problem("delta-untracked-delete", `추적되지 않는 파일은 통합으로 삭제할 수 없습니다: ${path.targetPath}`, path.targetPath),
		};
	}
	if (path.head.mode !== path.index.mode || path.head.oid !== path.index.oid) {
		return {
			ok: false,
			problem: problem("delta-staged-delete", `index에 다른 버전이 있는 파일은 통합으로 삭제할 수 없습니다: ${path.targetPath}`, path.targetPath),
		};
	}
	// Status can hide an assume-unchanged/skip-worktree edit; the patch's exact old object must be the committed one.
	if (!("oid" in path.before)) return dirtyDelete(path);
	if (path.before.oid !== path.head.oid || path.before.state.mode !== path.head.mode) return dirtyDelete(path);
	const entry = status.get(path.gitPath);
	if (entry !== undefined) {
		return {
			ok: false,
			problem: problem(
				entry.untracked ? "delta-untracked-delete" : "delta-dirty-delete",
				`작업 중인 변경이 있는 파일은 통합으로 삭제할 수 없습니다: ${path.targetPath}`,
				path.targetPath,
			),
		};
	}
	return { ok: true };
}

function indexSame(a: Footprint["index"], b: Footprint["index"]): boolean {
	const fileSame = a.file === null || b.file === null
		? a.file === b.file
		: a.file.canonicalPath === b.file.canonicalPath && a.file.device === b.file.device && a.file.inode === b.file.inode;
	return fileSame && a.sha256 === b.sha256;
}

/**
 * The exact pre/post check under the holder. `pre` proves every working-file preimage, add/delete index rules and the
 * index/HEAD state taken at intent; `post` proves every expected image, an untouched index and an unmoved HEAD.
 */
export async function verifyFootprint(
	footprint: Footprint,
	target: IntegrationTarget,
	run: GitRun,
	budget: ByteBudget,
	phase: "pre" | "post",
	earlyStatus?: ReadonlyMap<string, StatusEntry>,
): Promise<IntegrationCheck> {
	try {
		const early = budget.problem();
		if (early !== undefined) return { ok: false, problem: early };
		await verifyTargetIdentities(target);
		const gitPaths = footprint.paths.map(entry => entry.gitPath);
		let status: ReadonlyMap<string, StatusEntry>;
		if (earlyStatus !== undefined) status = earlyStatus;
		else {
			const read = await statusForPaths(target.gitRoot.canonicalPath, gitPaths, run, budget);
			if (read.kind === "unknown") return { ok: false, problem: read.problem };
			status = read.paths;
		}
		const current = await readGoldState(target, gitPaths, run, budget, { topology: phase === "pre" });
		if (current.kind === "unknown") return { ok: false, problem: current.problem };
		const now = current.value;
		for (const path of footprint.paths) {
			const live = now.paths.find(candidate => candidate.gitPath === path.gitPath);
			if (live === undefined) return { ok: false, problem: problem("delta-footprint", `대상 경로를 다시 읽지 못했습니다: ${path.targetPath}`) };
			const expected = phase === "pre" ? path.before : path.after;
			if (!sameImage(deltaToImage(expected), live.worktree)) {
				return {
					ok: false,
					problem: problem(
						phase === "pre" ? "delta-preimage-conflict" : "delta-postimage-mismatch",
						phase === "pre"
							? `대상 작업 파일이 증명된 이전 바이트와 다릅니다: ${path.targetPath}`
							: `대상 작업 파일이 기대한 이후 바이트와 다릅니다: ${path.targetPath}`,
						path.targetPath,
					),
				};
			}
			if (phase === "pre") {
				if (path.before.state.kind === "absent") {
					const add = checkAddAllowed(path, live);
					if (!add.ok) return add;
				} else if (path.after.state.kind === "absent") {
					const removed = checkDeleteClean(path, status);
					if (!removed.ok) return removed;
				}
			}
			if (live.head?.oid !== path.head?.oid || live.head?.mode !== path.head?.mode) {
				return { ok: false, problem: problem("delta-head-changed", `HEAD 경로 상태가 선택 뒤 바뀌었습니다: ${path.targetPath}`, path.targetPath) };
			}
			if (live.index?.oid !== path.index?.oid || live.index?.mode !== path.index?.mode) {
				return { ok: false, problem: problem("delta-index-changed", `index 경로 상태가 선택 뒤 바뀌었습니다: ${path.targetPath}`, path.targetPath) };
			}
		}
		if (!indexSame(now.index, footprint.index)) {
			return { ok: false, problem: problem("delta-index-changed", "대상 index 파일이 선택 뒤 바뀌었습니다.") };
		}
		if (now.head.oid !== footprint.head.oid || now.head.ref !== footprint.head.ref) {
			return { ok: false, problem: problem("delta-head-changed", "대상 HEAD가 선택 뒤 바뀌었습니다.") };
		}
		return { ok: true };
	} catch (error) {
		return {
			ok: false,
			problem: error instanceof Refusal ? error.problemValue : problem("delta-internal", error instanceof Error ? error.message : String(error)),
		};
	}
}

/** Whether every touched path currently holds its expected postimage; unknown on an unreadable path. */
export async function observePostimages(footprint: Footprint, target: IntegrationTarget): Promise<IntegrationRead<"all-pre" | "all-post" | "mixed">> {
	let allPre = true;
	let allPost = true;
	try {
		for (const path of footprint.paths) {
			const read = await readPathImage(target.authorizedRoot.canonicalPath, path.targetPath);
			if (read.kind === "unknown") return { kind: "unknown", problem: read.problem };
			const image = read.kind === "absent" ? { kind: "absent" as const } : read.image;
			if (!sameImage(image, deltaToImage(path.before))) allPre = false;
			if (!sameImage(image, deltaToImage(path.after))) allPost = false;
		}
	} catch (error) {
		return {
			kind: "unknown",
			problem: error instanceof Refusal ? error.problemValue : problem("delta-internal", error instanceof Error ? error.message : String(error)),
		};
	}
	if (allPre) return { kind: "known", value: "all-pre" };
	if (allPost) return { kind: "known", value: "all-post" };
	return { kind: "known", value: "mixed" };
}

/** What the fixed installer proved about its own child process. */
export type InstallOutcome =
	| { readonly kind: "never-dispatched"; readonly reason: string }
	| { readonly kind: "exited"; readonly code: number; readonly stderr: string }
	| { readonly kind: "effect-unknown"; readonly reason: string };

export interface InstallInput {
	readonly target: IntegrationTarget;
	readonly patch: Uint8Array;
	readonly window: ByteWindow;
	/** Synchronous final gate: called once after the awaited `apply --check` succeeds and before the mutating
	 * `apply`, with no await in between. A refusal is a no-effect dispatch and must leave the fence to the writer. */
	readonly beforeDispatch: () => IntegrationCheck;
}

/** The one fixed installer: `git apply --check`, then `git apply`, never staging, fuzz, 3-way or reject. */
export interface Installer {
	install(input: InstallInput): Promise<InstallOutcome>;
}

export class GitInstaller implements Installer {
	constructor(private readonly run: GitRun = spawnGit) {}

	async install(input: InstallInput): Promise<InstallOutcome> {
		const cwd = input.target.gitRoot.canonicalPath;
		const timeoutMs = Math.max(1_000, input.window.deadline - Date.now());
		const early = this.#windowProblem(input);
		if (early !== undefined) return { kind: "never-dispatched", reason: early };
		const base = ["-c", "core.autocrlf=false", "-c", "core.eol=lf", "-c", "core.safecrlf=false", "-c", "core.quotePath=false", "-c", "apply.whitespace=nowarn"];
		let check: GitRunResult;
		try {
			check = await this.run([...base, "apply", "--check", "--binary", "--whitespace=nowarn"], {
				cwd,
				stdin: input.patch,
				timeoutMs,
				env: { GIT_ATTR_NOSYSTEM: "1" },
			});
		} catch (error) {
			return { kind: "never-dispatched", reason: `적용 전 검사 프로세스를 시작할 수 없습니다: ${error instanceof Error ? error.message : String(error)}` };
		}
		if (!check.started) return { kind: "never-dispatched", reason: `설치 프로세스를 시작할 수 없습니다: ${check.stderr}` };
		if (check.ended === false) return { kind: "never-dispatched", reason: "적용 전 검사 프로세스의 종료를 확인하지 못했습니다." };
		if (check.code !== 0) return { kind: "never-dispatched", reason: `적용 전 검사가 실패했습니다: ${check.stderr.trim().slice(0, 400)}` };
		// This is the last external callback before the mutation: the writer rechecks live/lease/table/deadline here.
		let gate: IntegrationCheck;
		try {
			gate = input.beforeDispatch();
		} catch (error) {
			return { kind: "never-dispatched", reason: `적용 직전 검사를 실행할 수 없습니다: ${error instanceof Error ? error.message : String(error)}` };
		}
		if (!gate.ok) return { kind: "never-dispatched", reason: gate.problem.reason };
		const final = this.#windowProblem(input);
		if (final !== undefined) return { kind: "never-dispatched", reason: final };
		let applied: GitRunResult;
		try {
			applied = await this.run([...base, "apply", "--binary", "--whitespace=nowarn"], {
				cwd,
				stdin: input.patch,
				timeoutMs,
				env: { GIT_ATTR_NOSYSTEM: "1" },
			});
		} catch (error) {
			return { kind: "effect-unknown", reason: `설치 프로세스의 종료를 확인하지 못했습니다: ${error instanceof Error ? error.message : String(error)}` };
		}
		if (!applied.started) return { kind: "never-dispatched", reason: `설치 프로세스를 시작할 수 없습니다: ${applied.stderr}` };
		if (applied.ended === false) {
			return { kind: "effect-unknown", reason: `설치 프로세스가 시작됐지만 종료를 확인하지 못했습니다(코드 ${applied.code}).` };
		}
		return { kind: "exited", code: applied.code, stderr: applied.stderr };
	}

	#windowProblem(input: InstallInput): string | undefined {
		if (input.window.signal.aborted) return "통합 작업이 중단되었습니다.";
		if (!(Date.now() < input.window.deadline)) return "통합 작업 시간이 지났습니다.";
		return undefined;
	}
}

/** The literal path form the record layer may store without a second parser. */
export function cleanIntegrationPath(value: string): string | undefined {
	return cleanRelative(value);
}
