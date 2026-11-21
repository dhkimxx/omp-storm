/**
 * Director reads of files its subagents already read. Raw evidence is the subagents' job: they read it and cite
 * locations (file and line range), the director checks those locations. Child sessions note every file they read
 * per run; while the run is active the director's whole-file read of such a file is refused, a bounded range passes.
 * Module-level on purpose: subagent sessions load this same module, so each child's reads land in the one map the
 * parent reads.
 */
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

const URL_SCHEME = /^([a-z][a-z0-9+.-]*):\/\//i;
const SSH_URL = "ssh://";
/** One range of a read selector: `50`, `50-200`, `50-` (open), `50+150`, `-60` (last lines). */
const RANGE = /^(?:\d+(?:-\d*|\+\d+)?|-\d+)$/;
/** Readers named in a block reason; the rest are counted. */
const MAX_NAMED_READERS = 3;

/** `runId` → file key → ids of the run's subagents that read it. */
const runs = new Map<string, Map<string, Set<string>>>();

/**
 * Splits the read tool's trailing selectors off a path (`:50`, `:50-200`, `:50+150`, `:-60`, `:5-16,960-973`,
 * `:raw`, `:2-4:raw`, `:raw:2-4`). `ranged` is true when a line selector is present and every range is bounded.
 */
function splitSelector(path: string): { base: string; ranged: boolean } {
	let base = path;
	let lines = false;
	let bounded = true;
	for (;;) {
		const i = base.lastIndexOf(":");
		if (i <= 0) break;
		const part = base.slice(i + 1);
		if (part === "raw") {
			base = base.slice(0, i);
			continue;
		}
		const ranges = part.split(",");
		if (!ranges.every(r => RANGE.test(r))) break;
		lines = true;
		if (ranges.some(r => r.endsWith("-"))) bounded = false;
		base = base.slice(0, i);
	}
	return { base, ranged: lines && bounded };
}

/**
 * The file a `read` path names, as a key shared by every session of the process: local paths resolve against `cwd`,
 * `ssh://host/path` keeps its host. Line selectors are stripped; `ranged` says whether they bound the read. `dir`
 * marks a directory listing: a trailing `/`, or a local path that stats as a directory.
 * Undefined for every other scheme (agent://, history://, skill://, local://, xd://, http(s):// …): those are not
 * working files, or not ones a subagent's read makes redundant.
 */
export function readTarget(path: string, cwd: string): { key: string; ranged: boolean; dir: boolean } | undefined {
	const trimmed = path.trim();
	if (trimmed === "") return undefined;
	const scheme = URL_SCHEME.exec(trimmed);
	if (scheme) {
		if (scheme[0].toLowerCase() !== SSH_URL) return undefined;
		const rest = trimmed.slice(SSH_URL.length);
		const slash = rest.indexOf("/");
		// The host part (`host` or `host:port`) carries no selector.
		const host = slash < 0 ? rest : rest.slice(0, slash);
		if (host === "") return undefined;
		const { base, ranged } = splitSelector(slash < 0 ? "/" : rest.slice(slash));
		const file = base || "/";
		return { key: `${SSH_URL}${host}${file}`, ranged, dir: file.endsWith("/") };
	}
	const { base, ranged } = splitSelector(trimmed);
	const expanded = base === "~" ? homedir() : base.startsWith("~/") ? homedir() + base.slice(1) : base;
	const key = resolve(cwd, expanded);
	const dir = base.endsWith("/") || statSync(key, { throwIfNoEntry: false })?.isDirectory() === true;
	return { key, ranged, dir };
}

/** Starts the read index of a run; child reads of runs that are not open are ignored. */
export function openRunReads(runId: string): void {
	if (!runs.has(runId)) runs.set(runId, new Map());
}

/**
 * Notes a subagent's `read` of `path` (as the tool got it, against the child's `cwd`) in its run's index. Only
 * whole-file reads of files count: ranged reads, directory listings, exempt URLs and runs that are not open are ignored.
 */
export function noteChildRead(runId: string, agentId: string, path: unknown, cwd: string): void {
	const files = runs.get(runId);
	if (!files || typeof path !== "string") return;
	const target = readTarget(path, cwd);
	if (!target || target.ranged || target.dir) return;
	let readers = files.get(target.key);
	if (!readers) {
		readers = new Set();
		files.set(target.key, readers);
	}
	readers.add(agentId);
}

/** Ids of the subagents of `runId` that read the file `key` whole, in first-read order. */
export function childReaders(runId: string, key: string): string[] {
	return [...(runs.get(runId)?.get(key) ?? [])];
}

/** Drops and closes the read index of a finished run. */
export function clearRunReads(runId: string): void {
	runs.delete(runId);
}

/**
 * Classifies a director `read` during a run: `blocked` (with the reason to return) for a whole-file read of a file a
 * subagent of the run already read whole, `duplicate` for a bounded read of such a file, `plain` otherwise (directory
 * listings included). Undefined when the path is not a string or names no working file (internal URLs, remote URLs):
 * those are not counted.
 */
export function directorRead(input: {
	runId: string;
	path: unknown;
	cwd: string;
}): { kind: "plain" | "duplicate" | "blocked"; reason?: string } | undefined {
	if (typeof input.path !== "string") return undefined;
	const target = readTarget(input.path, input.cwd);
	if (!target) return undefined;
	if (target.dir) return { kind: "plain" };
	const readers = childReaders(input.runId, target.key);
	if (readers.length === 0) return { kind: "plain" };
	if (target.ranged) return { kind: "duplicate" };
	const named = readers.slice(0, MAX_NAMED_READERS).map(id => `agent://${id}`).join(", ");
	const more = readers.length > MAX_NAMED_READERS ? ` 외 ${readers.length - MAX_NAMED_READERS}개` : "";
	const shown = splitSelector(input.path.trim()).base;
	return {
		kind: "blocked",
		reason: `${shown} 은(는) 이 실행의 하위 에이전트(${named}${more})가 이미 읽은 파일이라 통째로 읽기를 막았습니다. 원본은 하위 에이전트가 읽고 감독은 근거 위치만 확인합니다. 필요한 대목만 줄 범위를 정해 읽거나(예: ${shown}:120-180), 그 에이전트의 결과를 agent://<id> 로 읽고 모자라면 write agent://<id> 로 근거 위치(파일과 줄 범위)를 물으세요.`,
	};
}
