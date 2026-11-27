/**
 * Which files one director tool call will write, named exactly, or why Storm cannot say. The run's write table orders
 * writers by the paths they hold, so a call whose targets cannot be named is refused: it would be a writer the table
 * cannot see (G1).
 *
 * Every input form is read by omp's own parser of the pinned host, never by a pattern of Storm's own: the replace,
 * patch, hashline and apply_patch forms of `edit` through the native `editInspect` (the one omp reads its approval
 * prompts and stream matchers with; the test file runs the native edit session against the same payloads and shows
 * that what it asks the host to write is inside this answer), the words-in-sections form of `edit.mode: magic` through
 * `magicEditPaths`, `ast_edit` entries through `parseSearchPath`, and the hashline wrapper of a `write` path through
 * `unwrapHashlineHeaderPath`. A form none of them can parse, or a path whose meaning depends on state Storm cannot read
 * (an address, a selector, a `~`, a list in one entry), is refused with its cause. Pure apart from reading the real
 * path of a directory, which the caller may replace.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { magicEditPaths } from "@oh-my-pi/pi-coding-agent/edit/magic";
import { unwrapHashlineHeaderPath } from "@oh-my-pi/pi-coding-agent/tools/hashline-header-path";
import { normalizePathLikeInput, parseSearchPath } from "@oh-my-pi/pi-coding-agent/tools/path-utils";
import { editInspect } from "@oh-my-pi/pi-natives";
import { pathWriteTool } from "./capability.ts";

/**
 * Why a call's targets are not named. `unknown`: the call or a path in it cannot be read exactly. `outside`: a target
 * resolves outside the run's root. `internal`: a target is under `.git/` or `.omp/`. `dispatched`: another tool made the
 * call. `address`: a target is an address (ssh://, xd://, conflict://, vault://, any scheme), not a plain project path.
 */
export type TargetCause = "unknown" | "outside" | "internal" | "dispatched" | "address";

export type TargetResult = { ok: true; paths: string[] } | { ok: false; cause: TargetCause; path?: string };

export interface TargetEnv {
	/** The run's work tree. Every target must resolve inside it. */
	root: string;
	/** The director session's working directory: relative targets resolve against it, as omp does. */
	cwd: string;
	/** omp's resolved edit mode for the call (`hashline`, `apply_patch`, `sloppy`, `magic`, ...). Absent: every form is tried. */
	editMode?: string;
	/** The id of the tool call that dispatched this one (eval, a kernel-defined tool); present means refused. */
	parentToolCallId?: string;
	/** The real path of an existing path; `fs.realpathSync` by default. Throws like it does. */
	realpath?: (target: string) => string;
}

/**
 * Control characters, and every space but the plain one: omp folds the unusual spaces to a plain space before it
 * resolves a path (`normalizeUnicodeSpaces`), so a path that has one may mean another file than it spells.
 */
const CONTROL_OR_ODD_SPACE = /[\x00-\x1f\x7f]|[^\S ]/u;
/** A scheme at the start of a path: `x://`, or omp's single-slash alias `x:/`. */
const LEADING_SCHEME = /^[a-z][a-z0-9+.-]*:\//i;
const INSPECT_MODES_FOR_INPUT = ["hashline", "apply_patch", "sloppy"] as const;
/** The segments that hold omp's or git's own state. Compared without case (the file system may not have one). */
const RESERVED_SEGMENTS: ReadonlySet<string> = new Set([".git", ".omp"]);

type Fail = Extract<TargetResult, { ok: false }>;
const fail = (cause: TargetCause, target?: string): Fail => (target === undefined ? { ok: false, cause } : { ok: false, cause, path: target });

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A path as the call wrote it, accepted only when it means one file on disk without asking the file system what it
 * means: no address, no selector or archive/database suffix (a `:` is how omp addresses an archive entry or a row), no
 * `~`/`@` prefix, no list, no backslash, nothing a terminal would hide.
 */
function plainPath(raw: string): Fail | undefined {
	if (raw === "" || raw.trim() !== raw || CONTROL_OR_ODD_SPACE.test(raw) || raw.includes("\\")) return fail("unknown");
	if (raw.includes("://") || LEADING_SCHEME.test(raw)) return fail("address", raw);
	if (raw.includes(":") || raw.startsWith("~") || raw.startsWith("@")) return fail("unknown");
	return undefined;
}

/** The real path of the deepest existing ancestor, with the part that does not exist yet joined back on. */
function canonicalPath(target: string, hasDotDot: boolean, realpath: (target: string) => string): string | undefined {
	const tail: string[] = [];
	let current = target;
	for (;;) {
		try {
			const real = realpath(current);
			return tail.length === 0 ? real : path.join(real, ...tail.reverse());
		} catch (error) {
			if ((error as NodeJS.ErrnoException | null | undefined)?.code !== "ENOENT") return undefined;
			// A dangling link is not a missing file: writing it creates whatever it points at.
			try {
				fs.lstatSync(current);
				return undefined;
			} catch {
				// Nothing is there at all: this segment is the part that does not exist yet.
			}
			// `a/../b` is resolved by the kernel across links, so only a path that exists can be named without guessing.
			if (hasDotDot) return undefined;
			const parent = path.dirname(current);
			if (parent === current) return undefined;
			tail.push(path.basename(current));
			current = parent;
		}
	}
}

interface Resolver {
	/** A plain authored path to its root-relative, slash-separated canonical name, or the refusal. */
	scope(raw: string): { ok: true; rel: string } | Fail;
}

function resolverFor(env: TargetEnv): Resolver | Fail {
	const realpath = env.realpath ?? ((target: string) => fs.realpathSync(target));
	let realRoot: string;
	try {
		realRoot = realpath(env.root);
	} catch {
		return fail("unknown");
	}
	return {
		scope(raw) {
			const bad = plainPath(raw);
			if (bad !== undefined) return bad;
			const hasDotDot = raw.split("/").includes("..");
			const joined = path.isAbsolute(raw) ? raw : `${env.cwd.replace(/\/+$/u, "")}/${raw}`;
			const lexical = path.resolve(env.cwd, raw);
			const real = canonicalPath(hasDotDot ? joined : lexical, hasDotDot, realpath);
			if (real === undefined) {
				// A `..` walk that ends above the tree and cannot be followed on disk is outside it, which says more than "unknown".
				const above = path.relative(path.resolve(env.root), lexical);
				return hasDotDot && (above === ".." || above.startsWith(`..${path.sep}`)) ? fail("outside", raw) : fail("unknown");
			}
			const relative = path.relative(realRoot, real);
			if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return fail("outside", raw);
			const rel = relative === "" ? "." : relative.split(path.sep).join("/");
			// The lexical spelling is judged too, so a link named `.git` or a `..` that walks into it does not hide it.
			const lexicalRelative = path.relative(path.resolve(env.root), lexical);
			const segments = [...rel.split("/"), ...(lexicalRelative.startsWith("..") ? [] : lexicalRelative.split(path.sep))];
			if (segments.some(segment => RESERVED_SEGMENTS.has(segment.toLowerCase()))) return fail("internal", raw);
			return { ok: true, rel };
		},
	};
}

function collect(resolver: Resolver, authored: readonly string[]): TargetResult {
	if (authored.length === 0) return fail("unknown");
	const out = new Set<string>();
	for (const raw of authored) {
		const scope = resolver.scope(raw);
		if (!scope.ok) return scope;
		out.add(scope.rel);
	}
	return { ok: true, paths: [...out].sort() };
}

/** Every file a native inspection says a payload writes: its sections, and the destination of each move. */
function inspectedPaths(mode: string, json: string): string[] {
	try {
		const inspection = editInspect(mode, json);
		const out = new Set(inspection.paths);
		for (const op of inspection.fileOps) {
			out.add(op.path);
			if (op.to !== undefined) out.add(op.to);
		}
		return [...out];
	} catch {
		return [];
	}
}

/**
 * The paths an `edit` call (any grammar of the pinned host) names, or undefined when no parser reads any. The grammar
 * is told by the shape of the input: `{ path, old_string, new_string }` is replace, `{ path, edits }` is patch (or a
 * replace batch), `{ input }` is hashline, apply_patch, sloppy or magic. The last has one shape for four grammars, so
 * the resolved edit mode picks the parser; without it every parser reads the payload and the answer is all of what
 * any of them finds, which can only hold more files, never fewer.
 */
function editAuthored(input: unknown, editMode: string | undefined): string[] | undefined {
	if (!isRecord(input)) return undefined;
	let json: string;
	try {
		json = JSON.stringify(input);
	} catch {
		return undefined;
	}
	const out = new Set<string>();
	if (typeof input.path === "string") {
		for (const mode of ["replace", "patch"]) for (const found of inspectedPaths(mode, json)) out.add(found);
	}
	if (typeof input.input === "string") {
		if (editMode === "magic") {
			for (const found of magicEditPaths(input.input)) out.add(found);
		} else if ((INSPECT_MODES_FOR_INPUT as readonly string[]).includes(editMode ?? "")) {
			for (const found of inspectedPaths(editMode as string, json)) out.add(found);
		} else {
			// No mode, or one that takes no `input` string: the grammar is not known, so every parser reads it.
			for (const mode of INSPECT_MODES_FOR_INPUT) for (const found of inspectedPaths(mode, json)) out.add(found);
			for (const found of magicEditPaths(input.input)) out.add(found);
		}
	}
	return out.size === 0 ? undefined : [...out];
}

/** `{ path }` of a `write` call with its hashline wrapper peeled the way omp peels it. */
function writeAuthored(input: unknown): string[] | undefined {
	if (!isRecord(input) || typeof input.path !== "string") return undefined;
	return [unwrapHashlineHeaderPath(input.path)];
}

/** Whether a list entry holds a delimiter omp may split on (`,`, `;` or a space outside braces): then it names several paths or one. */
function hasTopLevelDelimiter(entry: string): boolean {
	let depth = 0;
	for (const ch of entry) {
		if (ch === "{") depth++;
		else if (ch === "}") depth = Math.max(0, depth - 1);
		else if (depth === 0 && (ch === "," || ch === ";" || /\s/u.test(ch))) return true;
	}
	return false;
}

/**
 * The directories and files an `ast_edit` call may rewrite. A file is its own scope; a directory is its own scope; a
 * glob is the directory it starts in (everything the glob can match is below it). An entry omp may split into several
 * (a list in one string) is refused, because which paths it means then depends on the files on disk.
 */
function astAuthored(input: unknown): string[] | undefined {
	if (!isRecord(input) || !Array.isArray(input.paths) || input.paths.length === 0) return undefined;
	const out: string[] = [];
	for (const entry of input.paths) {
		if (typeof entry !== "string") return undefined;
		const normalized = normalizePathLikeInput(entry);
		if (normalized === "" || hasTopLevelDelimiter(normalized)) return undefined;
		let base: string;
		try {
			const parsed = parseSearchPath(normalized);
			if (parsed.glob?.split("/").includes("..") === true) return undefined;
			base = parsed.basePath === "" ? "." : parsed.basePath;
		} catch {
			return undefined;
		}
		out.push(base);
	}
	return out;
}

/**
 * The exact workspace paths one director call to a path-writing tool will write, root-relative, slash-separated and
 * sorted (`.` is the whole tree), or the cause it cannot be named. A target is judged by its real path: a link whose
 * parent leaves the root, or that itself points out of it, is `outside`; the root-relative name is the real one, so it
 * meets the real names the lanes' file lists were turned into.
 */
export function directorTargets(toolName: string, input: unknown, env: TargetEnv): TargetResult {
	if (env.parentToolCallId !== undefined) return fail("dispatched");
	if (!pathWriteTool(toolName)) return fail("unknown");
	const resolver = resolverFor(env);
	if (!("scope" in resolver)) return resolver;
	let authored: string[] | undefined;
	if (toolName === "write") authored = writeAuthored(input);
	else if (toolName === "edit" || toolName === "apply_patch") authored = editAuthored(input, toolName === "apply_patch" ? (env.editMode ?? "apply_patch") : env.editMode);
	else if (toolName === "ast_edit") authored = astAuthored(input);
	if (authored === undefined) return fail("unknown");
	return collect(resolver, authored);
}
