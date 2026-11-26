/**
 * Director reads of files its subagents already read. Raw evidence is the subagents' job: they read it and cite
 * locations (file and line range), the director checks those locations. Child sessions note every file they read per
 * run; while the run is active a director read of such a file is refused only when it asks for a wide line range.
 * A read without an end (bare, `:raw`, `:50-`) is not wide: omp pages it at `read.defaultLimit` lines.
 * Module-level on purpose: subagent sessions load this same module, so each child's reads land in the one map the
 * parent reads.
 */
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { Block } from "../types.ts";

const URL_SCHEME = /^([a-z][a-z0-9+.-]*):\/\//i;
const SSH_URL = "ssh://";
/** One range of a read selector: `50`, `50-200`, `50-` (open), `50+150`, `-60` (last lines). */
const RANGE = /^(?:(\d+)(?:-(\d*)|\+(\d+))?|-(\d+))$/;
/** Readers named in a block reason; the rest are counted. */
const MAX_NAMED_READERS = 3;

/** Most lines a director's read of an indexed file may ask for (all ranges of the selector together). */
export const MAX_RANGE_LINES = 400;
/**
 * Lines omp returns for a read without an end: the default of its `read.defaultLimit` setting. The setting itself is
 * not read (it takes an `omp config` call per run); a user who raised it gets larger pages than this counts.
 */
export const PAGE_LINES = 300;
/** A whole file up to this size is cheaper to return than to refuse: a refusal costs a director request. */
export const SMALL_FILE_BYTES = 16 * 1024;

/** `runId` → file key → ids of the run's subagents that read it. */
const runs = new Map<string, Map<string, Set<string>>>();

interface Selector {
	base: string;
	/** Lines the read asks for: its ranges together, each open-ended one and a read without ranges counted as one page. */
	lines: number;
}

function rangeLines(range: string): number | undefined {
	const m = RANGE.exec(range);
	if (!m) return undefined;
	const [, from, to, count, last] = m;
	if (last !== undefined) return Number(last);
	if (count !== undefined) return Number(count);
	if (to === undefined) return 1;
	if (to === "") return PAGE_LINES;
	return Math.max(1, Number(to) - Number(from) + 1);
}

/**
 * Splits the read tool's trailing selectors off a path (`:50`, `:50-200`, `:50+150`, `:-60`, `:5-16,960-973`,
 * `:raw`, `:2-4:raw`, `:raw:2-4`). Like omp, `raw` is matched without case.
 */
function splitSelector(path: string): Selector {
	let base = path;
	let ranged: number | undefined;
	for (;;) {
		const i = base.lastIndexOf(":");
		if (i <= 0) break;
		const part = base.slice(i + 1);
		if (part.toLowerCase() !== "raw") {
			const spans = part.split(",").map(rangeLines);
			if (spans.some(n => n === undefined)) break;
			ranged = (ranged ?? 0) + spans.reduce<number>((sum, n) => sum + (n ?? 0), 0);
		}
		base = base.slice(0, i);
	}
	return { base, lines: ranged ?? PAGE_LINES };
}

export interface ReadTarget extends Selector {
	/** The file as a key shared by every session of the process. */
	key: string;
	/** A directory listing: a trailing `/`, or a local path that stats as a directory. */
	dir: boolean;
	/** `ssh://` target: its size is unknown here. */
	remote: boolean;
	/** Size on disk of a local file; undefined when missing or remote. */
	bytes?: number;
}

/**
 * The file a `read` path names: local paths resolve against `cwd`, `ssh://host/path` keeps its host; selectors are
 * split off. Undefined for every other scheme (agent://, history://, skill://, local://, xd://, http(s):// …): those
 * are not working files, or not ones a subagent's read makes redundant.
 */
export function readTarget(path: string, cwd: string): ReadTarget | undefined {
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
		const selector = splitSelector(slash < 0 ? "/" : rest.slice(slash));
		const file = selector.base || "/";
		return { ...selector, base: `${SSH_URL}${host}${file}`, key: `${SSH_URL}${host}${file}`, dir: file.endsWith("/"), remote: true };
	}
	const selector = splitSelector(trimmed);
	const { base } = selector;
	const expanded = base === "~" ? homedir() : base.startsWith("~/") ? homedir() + base.slice(1) : base;
	const key = resolve(cwd, expanded);
	const stat = statSync(key, { throwIfNoEntry: false });
	const target: ReadTarget = { ...selector, key, dir: base.endsWith("/") || stat?.isDirectory() === true, remote: false };
	if (stat?.isFile()) target.bytes = stat.size;
	return target;
}

/** Starts the read index of a run; child reads of runs that are not open are ignored. */
export function openRunReads(runId: string): void {
	if (!runs.has(runId)) runs.set(runId, new Map());
}

/**
 * Notes a subagent's `read` of `path` (as the tool got it, against the child's `cwd`) in its run's index, ranged or
 * not. Directory listings, exempt URLs and runs that are not open are ignored.
 */
export function noteChildRead(runId: string, agentId: string, path: unknown, cwd: string): void {
	const files = runs.get(runId);
	if (!files || typeof path !== "string") return;
	const target = readTarget(path, cwd);
	if (!target || target.dir) return;
	let readers = files.get(target.key);
	if (!readers) {
		readers = new Set();
		files.set(target.key, readers);
	}
	readers.add(agentId);
}

/** Ids of the subagents of `runId` that read the file `key`, in first-read order. */
function childReaders(runId: string, key: string): string[] {
	return [...(runs.get(runId)?.get(key) ?? [])];
}

/** Drops and closes the read index of a finished run. */
export function clearRunReads(runId: string): void {
	runs.delete(runId);
}

/** Whether the read asks for more lines than a director's check needs. */
function tooWide(target: ReadTarget): boolean {
	// A small local file bounds whatever is asked of it; a missing one returns nothing.
	if (!target.remote && (target.bytes === undefined || target.bytes <= SMALL_FILE_BYTES)) return false;
	return target.lines > MAX_RANGE_LINES;
}

export interface DirectorRead {
	/** A subagent of the run read this file too. */
	indexed: boolean;
	block?: Block<"read-large">;
}

/**
 * Judges a director `read` during a run. Undefined when the path is not a string or names no working file (internal
 * URLs, remote URLs): those are neither counted nor refused. A directory listing is never indexed. `isolated`: the
 * team's agents take no messages, so the block reason does not send the director to ask one.
 */
export function directorRead(input: { runId: string; path: unknown; cwd: string; isolated?: boolean }): DirectorRead | undefined {
	if (typeof input.path !== "string") return undefined;
	const target = readTarget(input.path, input.cwd);
	if (!target) return undefined;
	if (target.dir) return { indexed: false };
	const readers = childReaders(input.runId, target.key);
	if (readers.length === 0) return { indexed: false };
	if (!tooWide(target)) return { indexed: true };
	const named = readers.slice(0, MAX_NAMED_READERS).map(id => `agent://${id}`).join(", ");
	const more = readers.length > MAX_NAMED_READERS ? ` 외 ${readers.length - MAX_NAMED_READERS}개` : "";
	const shown = target.remote ? target.base : splitSelector(input.path.trim()).base;
	const next = input.isolated
		? "모자라면 그 결과(agent://<id>)를 읽는 새 서브에이전트에게 확인을 맡기세요."
		: "모자라면 그 서브에이전트에게 write agent://<id> 로 근거 위치를 물으세요.";
	return {
		indexed: true,
		block: {
			code: "read-large",
			reason: `${shown} 파일은 이 실행의 서브에이전트(${named}${more})가 읽었는데${target.lines}줄을 요청해 막았습니다(한 번에 ${MAX_RANGE_LINES}줄까지). 근거 위치만 좁혀 읽으세요(예: ${shown}:120-180). ${next}`,
		},
	};
}
