/**
 * Approved write authority for one Storm lane worker.
 *
 * A role name or lane goal is not a capability. The effective agent definition's tool list is the starting fact, and
 * the extension enforces the decision at the tool boundary and (where the host supports it) in the task item's `tools`.
 * A lane may be parallel with writers only when its worker actually cannot change the shared tree: a read-only tool
 * list, a proven private checkout, or a path-only write set for disjoint work. Everything else is an unknown
 * shared writer and serializes conservatively. A worker with `bash` or `eval` is such a writer in every mode.
 */
import { readFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import * as path from "node:path";
import type { PlanLane, ShadowInfo } from "../types.ts";

/** Tools that only read the workspace or the web; every other tool is treated as write/exec until proven otherwise. */
export const READ_ONLY_TOOLS: Readonly<Record<string, true>> = {
	read: true,
	find: true,
	grep: true,
	glob: true,
	ast_grep: true,
	web_search: true,
	read_url: true,
	skill: true,
	ask: true,
	wait: true,
	todo: true,
	yield: true,
	history: true,
	proc: true,
	out: true,
};

/**
 * OMP 19.0.1's `lsp` is deliberately absent: rename and apply-code-action requests, and raw requests, can mutate the
 * workspace through a language server even when the call looks like a query. There is no reliable read-only argument
 * guard across worker threads, so a read-only lane must not carry `lsp`; a definition that declares it is an unknown
 * writer and serializes or is blocked by `lanePolicy`.
 */

/** Tools whose only shared-tree effect is a path named in their arguments. */
export const PATH_WRITE_TOOLS: Readonly<Record<string, true>> = {
	write: true,
	edit: true,
	multi_edit: true,
	apply_patch: true,
	ast_edit: true,
	notebook_edit: true,
};

/** Default read-only set used when an agent definition has no explicit `tools` list (host default is all tools). */
export const DEFAULT_READ_ONLY_TOOLS: readonly string[] = Object.keys(READ_ONLY_TOOLS);

export interface ToolCapability {
	/** Every declared tool is read-only. An absent/unknown list is never read-only. */
	readOnly: boolean;
	/** At least one tool writes a path named in its arguments. */
	pathWrites: boolean;
	/** At least one tool can execute arbitrary code or has unknown effects (`bash`, `eval`, MCP, custom tools). */
	exec: boolean;
}

/** Classifies one effective tool list; an absent list means "all tools" and is an unknown capability. */
export function toolCapability(tools: readonly string[] | undefined): ToolCapability {
	if (tools === undefined) return { readOnly: false, pathWrites: false, exec: true };
	let pathWrites = false;
	let exec = false;
	for (const raw of tools) {
		const name = raw.trim();
		if (!name) continue;
		if (READ_ONLY_TOOLS[name] === true) continue;
		if (PATH_WRITE_TOOLS[name] === true) {
			pathWrites = true;
			continue;
		}
		exec = true;
	}
	return { readOnly: !pathWrites && !exec, pathWrites, exec };
}

export function readOnlyTool(name: string): boolean {
	return READ_ONLY_TOOLS[name] === true;
}

export function pathWriteTool(name: string): boolean {
	return PATH_WRITE_TOOLS[name] === true;
}

/**
 * A lane declared no writable intent: its kind is a read/review/design lane and it promises no change/artifact result.
 * `files` on such a lane is a read source or a later follow-up scope, not a claim that this turn writes; the policy
 * still enforces read-only tools, so an exec-capable agent definition cannot write through it.
 */
export function readOnlyIntent(lane: PlanLane): boolean {
	if ((lane.results ?? []).some(result => result.kind !== "answer")) return false;
	return lane.kind !== "code" && lane.kind !== "run";
}

/** No longer a cause of anything: automatic delegation does not widen a writer's scope. Kept so old imports compile. */
export const WHY_AUTO_WRITER = "자동 위임";
/** Why a shared writer's scope cannot be narrowed; short enough to sit in parentheses of a refusal or a plan line. */
export const WHY_EXEC_WRITER = "임의 실행 도구가 있음";
export const WHY_UNDECLARED_WRITER = "파일 목록이 없음";
/** A reviewer that may run commands can change files like any shell worker, so it is ordered like a writer. */
export const WHY_SHELL_REVIEWER = "리뷰어가 셸 명령을 실행할 수 있음";
/** The same for any other read lane (explore, design, answer-only) whose agent definition lists a shell. */
export const WHY_SHELL_READER = "읽기 레인 워커가 셸 명령을 실행할 수 있음";

/**
 * The one tool, besides the read-only ones, a read lane may carry: `bash`, so the worker can run read commands such as
 * `git log` or the project's checks itself. Path-write tools (`write`, `edit`, ...), `eval`, `lsp` and every other tool
 * stay refused to it.
 */
export const READ_SHELL_TOOLS: Readonly<Record<string, true>> = { bash: true };

export type LanePolicy =
	/**
	 * `shell` marks a read lane whose agent may also run commands (any read-intent lane, not only a review lane). It
	 * reads and runs commands but never edits or writes with path tools. Because a command can change the tree, such a
	 * lane is ordered like a shared writer (see `shellReader` and `writeScope` in lanes.ts); a read lane without
	 * `shell` reserves nothing.
	 */
	| { kind: "read"; reason: string; shell?: true }
	| { kind: "private"; reason: string }
	| { kind: "paths"; paths: string[]; reason: string }
	| { kind: "unknown"; reason: string }
	| { kind: "blocked"; reason: string };

export interface LanePolicyInput {
	/** The planned lane; absent for an unplanned manual task. */
	lane: PlanLane | undefined;
	/** Effective agent-definition tools; undefined means the host default (all tools). */
	tools: readonly string[] | undefined;
	/** The team/run places every worker in a private checkout. */
	isolated: boolean;
	/** Ignored: automatic delegation no longer changes a lane's write scope. Callers may still pass it. */
	auto?: boolean;
}

/** What a refused lane capability tells the director to check before it sends the same call again. */
export const CAPABILITY_CHECK_READ = "같은 호출을 다시 보내기 전에 이 레인의 kind와 결과 종류가 맞는지, 읽기 레인에는 읽기 전용 에이전트를 골랐는지 확인하세요.";
export const CAPABILITY_CHECK_WRITE = "같은 호출을 다시 보내기 전에 쓰기 도구가 있는 역할의 에이전트를 골랐는지 확인하세요.";

/** A review lane: the final reviewer's lane, whatever the role name says. */
export function reviewLane(lane: PlanLane): boolean {
	return lane.kind === "review" || lane.role === "reviewer";
}

/** Whether the list is read-only tools plus only the shell (`bash`), and has at least one shell tool. */
function readOnlyWithShell(tools: readonly string[] | undefined): boolean {
	if (tools === undefined) return false;
	let shell = false;
	for (const raw of tools) {
		const name = raw.trim();
		if (!name || READ_ONLY_TOOLS[name] === true) continue;
		if (READ_SHELL_TOOLS[name] !== true) return false;
		shell = true;
	}
	return shell;
}

/** Whether a policy is a read lane that may run commands: it reads, never writes with path tools, and is ordered like a writer. */
export function shellReader(policy: LanePolicy | undefined): boolean {
	return policy?.kind === "read" && policy.shell === true;
}

/** Why a shell reader is ordered like a writer, for a refusal or a plan line: names the review lane when it is one. */
export function shellReaderWhy(lane: PlanLane | undefined): string {
	return lane !== undefined && reviewLane(lane) ? WHY_SHELL_REVIEWER : WHY_SHELL_READER;
}

/**
 * The one classification used by admission and runtime enforcement. A read-only intent is enforced at the tool
 * boundary, so a `bash`-capable agent definition does not make a review/architecture lane a writer: it is refused.
 * The one exception is a read-intent lane (review, explore, design or answer-only) whose only extra tool is `bash`
 * (`read` with `shell`): the shell is the user's own definition's, and the lane is then ordered like a writer. A
 * writable intent needs path-only tools to be scoped; exec/unknown tools are an unknown writer. Automatic delegation
 * changes none of this.
 */
export function lanePolicy(input: LanePolicyInput): LanePolicy {
	const { lane, tools } = input;
	if (input.isolated) return { kind: "private", reason: "격리 체크아웃의 사적 산출물" };
	if (lane === undefined) return { kind: "unknown", reason: "계획에 없는 작업이라 쓰기 범위를 알 수 없습니다" };
	if (readOnlyIntent(lane)) {
		const capability = toolCapability(tools);
		if (!capability.readOnly && readOnlyWithShell(tools)) {
			return { kind: "read", reason: reviewLane(lane) ? "읽기와 셸 실행만 하는 리뷰 레인" : "읽기와 셸 실행만 하는 읽기 레인", shell: true };
		}
		if (!capability.readOnly) {
			return {
				kind: "blocked",
				reason: `'${lane.name}' 레인은 쓰기 의도가 없는데 이 에이전트의 실제 도구에 쓰기/실행 능력이 있습니다(${tools === undefined ? "도구 목록 없음=호스트 기본 전체" : tools.join(", ")}). 역할 이름으로 읽기 전용을 가정하지 않으며, 읽기 전용 정의나 승인된 센드박스가 필요합니다. ${CAPABILITY_CHECK_READ}`,
			};
		}
		return { kind: "read", reason: "실제 도구가 읽기 전용인 레인" };
	}
	const capability = toolCapability(tools);
	if (capability.readOnly) {
		return { kind: "blocked", reason: `'${lane.name}' 레인은 쓰기 결과를 요구하지만 이 에이전트의 도구는 읽기 전용입니다. ${CAPABILITY_CHECK_WRITE}` };
	}
	if (capability.exec) return { kind: "unknown", reason: WHY_EXEC_WRITER };
	if ((lane.files?.length ?? 0) === 0) return { kind: "unknown", reason: WHY_UNDECLARED_WRITER };
	return { kind: "paths", paths: [...new Set(lane.files ?? [])].sort(), reason: "경로 지정 도구만 있는 수동 공유 쓰기" };
}

/** The effective tool list: a project/user shadow wins over the plugin definition, as omp discovery does. */
export function effectiveAgentTools(
	agent: string,
	shadows: readonly ShadowInfo[],
	pluginAgentsDir: string,
): string[] | undefined {
	const shadow = shadows.find(item => item.agent === agent);
	const file = shadow?.path ?? path.join(pluginAgentsDir, `${agent}.md`);
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
	return parseToolsFrontmatter(text);
}

/** Reads only the frontmatter `tools` field; absent or malformed means unknown (host default), never read-only. */
export function parseToolsFrontmatter(text: string): string[] | undefined {
	const clean = text.replace(/^\uFEFF/, "");
	if (!clean.startsWith("---")) return undefined;
	const end = clean.indexOf("\n---", 3);
	if (end < 0) return undefined;
	const frontmatter = clean.slice(3, end);
	const line = frontmatter
		.split(/\r?\n/u)
		.find(candidate => /^tools\s*:/u.test(candidate.trimStart()));
	if (line === undefined) return undefined;
	let raw = line.slice(line.indexOf(":") + 1).trim();
	if (raw === "") {
		// A YAML list: collect the following indented `- tool` lines.
		const lines = frontmatter.split(/\r?\n/u);
		const at = lines.findIndex(candidate => /^tools\s*:/u.test(candidate.trimStart()));
		const values: string[] = [];
		for (let i = at + 1; i < lines.length; i++) {
			const match = /^\s*-\s*(.+?)\s*$/u.exec(lines[i] ?? "");
			if (match === null) break;
			values.push(match[1]!.replace(/^['"]|['"]$/gu, ""));
		}
		return values.length > 0 ? values : undefined;
	}
	if (raw.startsWith("[") && raw.endsWith("]")) raw = raw.slice(1, -1);
	const values = raw.split(",").map(value => value.trim().replace(/^['"]|['"]$/gu, "")).filter(value => value !== "");
	return values.length > 0 ? values : undefined;
}

/** `.`/`..` cleanup for a workspace-relative scope; undefined when the path escapes the workspace. */
export function normalizeScopePath(value: string): string | undefined {
	const clean = value.replace(/\\/gu, "/").replace(/^\.\/+/u, "").replace(/\/+/gu, "/");
	if (clean === "" || clean === ".") return ".";
	if (clean.startsWith("/") || /^[A-Za-z]:/u.test(clean) || clean.startsWith("~")) return undefined;
	const segments: string[] = [];
	for (const segment of clean.split("/")) {
		if (segment === "" || segment === ".") continue;
		if (segment === "..") {
			if (segments.length === 0) return undefined;
			segments.pop();
			continue;
		}
		segments.push(segment);
	}
	return segments.length > 0 ? segments.join("/") : ".";
}

/** Two paths collide when equal or when one is a directory ancestor of the other. */
export function pathsOverlap(a: string, b: string): boolean {
	const left = normalizeScopePath(a);
	const right = normalizeScopePath(b);
	if (left === undefined || right === undefined) return false;
	if (left === "." || right === ".") return true;
	return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

/**
 * The write table's comparison of two scopes: two writers must be ordered when their files could be one file. On the default macOS
 * volume and on Windows `src/NEW.ts` and `src/new.ts` are one file, and so are the NFD and NFC spellings of one name, so both
 * sides are compared in NFC with the case folded. It costs a rare over-refusal on a case-sensitive volume (two files whose names
 * differ only by case are ordered) and needs no probe of the volume. Only the table uses this: whether one file lies inside a
 * worker's declared scope (`pathsOverlap`) stays exact, because folding there would let a worker write another file.
 */
export function scopesOverlap(a: readonly string[], b: readonly string[]): boolean {
	const fold = (scope: string): string => scope.normalize("NFC").toLowerCase();
	return a.some(left => b.some(right => pathsOverlap(fold(left), fold(right))));
}

/**
 * Canonical workspace-relative scopes: resolve existing ancestors (symlink aliases included), keep a not-yet-created
 * tail lexical, and refuse any path whose real target escapes the root. The caller treats undefined as unknown scope.
 */
export async function canonicalScope(root: string, files: readonly string[]): Promise<string[] | undefined> {
	let realRoot: string;
	try {
		realRoot = await realpath(root);
	} catch {
		return undefined;
	}
	const out = new Set<string>();
	for (const file of files) {
		const normalized = normalizeScopePath(file);
		if (normalized === undefined) return undefined;
		const target = path.resolve(realRoot, normalized);
		const resolved = await canonicalExistingAncestor(target);
		if (resolved === undefined) return undefined;
		const relative = path.relative(realRoot, resolved);
		if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
		out.add(relative === "" ? "." : relative.replace(/\\/gu, "/"));
	}
	return [...out].sort();
}

async function canonicalExistingAncestor(target: string): Promise<string | undefined> {
	const tail: string[] = [];
	let current = target;
	for (;;) {
		try {
			const real = await realpath(current);
			return path.join(real, ...tail.reverse());
		} catch (error) {
			const code = (error as NodeJS.ErrnoException | null | undefined)?.code;
			if (code !== "ENOENT") return undefined;
			const parent = path.dirname(current);
			if (parent === current) return undefined;
			tail.push(path.basename(current));
			current = parent;
		}
	}
}

/** Paths named by a write-capable tool call; an empty list is an unknown target, never an allowed write. */
export function toolWriteTargets(toolName: string, input: unknown): string[] {
	if (!pathWriteTool(toolName) || input === null || typeof input !== "object") return [];
	const record = input as Record<string, unknown>;
	const out: string[] = [];
	const collect = (value: unknown): void => {
		if (typeof value === "string" && value !== "") out.push(value);
		else if (Array.isArray(value)) for (const item of value) collect(item);
		else if (value !== null && typeof value === "object") {
			for (const key of ["path", "file_path", "filePath", "target"]) collect((value as Record<string, unknown>)[key]);
		}
	};
	for (const key of ["path", "file_path", "filePath", "target", "paths", "files", "edits"]) {
		if (key in record) collect(record[key]);
	}
	return [...new Set(out)];
}

/** Whether a tool target stays inside one of the lane's canonical path scopes. Absolute targets resolve via cwd. */
export function targetWithinScope(target: string, scopes: readonly string[], cwd: string): boolean {
	const absolute = path.isAbsolute(target) ? path.resolve(target) : path.resolve(cwd, target);
	const relative = path.relative(cwd, absolute).replace(/\\/gu, "/");
	if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return false;
	return scopes.some(scope => pathsOverlap(relative, scope));
}
