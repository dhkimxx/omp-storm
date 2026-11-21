/**
 * The project's working tree against the commit a run started on, so a change made through a shell command counts as
 * much as one made with an edit tool and a later commit does not hide it. Read-only: nothing here writes to the
 * repository or takes its index lock. The diff is read whole into memory: a very large binary change costs that
 * memory or hits the timeout, and shows up as no tree at all.
 */
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import * as path from "node:path";
import type { Exec } from "../types.ts";

/**
 * The working tree against a commit: `diff` hashes changes to and deletions of files the commit has, `files` every
 * file that exists now and is not in the commit, content-hashed so a commit does not move it from one side to the other.
 */
export interface TreeState {
	diff: string;
	files: string;
}

/** A tree read and the commit it was compared with; later reads continue against the same commit. */
export interface TreeReading {
	base: string;
	state: TreeState;
}

/** A tree read that does not finish in this time is no tree at all. */
const TIMEOUT_MS = 10_000;

/** A file this large contributes its size and mtime: reading a huge artifact on every round costs more than it tells. */
const BIG_FILE = 2 * 1024 * 1024;
/** Past this many new paths only the names are hashed: their contents would cost more than the change they show. */
const MANY_FILES = 2_000;

/** `.omp` holds Storm's own state and every other tool's, at the top level and below any directory. */
const PROJECT_ONLY = [".", ":(exclude,glob)**/.omp/**"];

const hash = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex").slice(0, 16);

async function read(exec: Exec, root: string, args: string[]): Promise<string | undefined> {
	try {
		// `diff.autoRefreshIndex=false`: a plain `git diff` rewrites `.git/index` and takes its lock; Storm only reads.
		const res = await exec("git", ["-c", "diff.autoRefreshIndex=false", "-C", root, ...args], { timeout: TIMEOUT_MS });
		if (res.code !== 0 || res.killed) return undefined;
		return res.stdout;
	} catch {
		return undefined;
	}
}

/** NUL-separated paths from a `-z` listing. */
function paths(text: string): string[] {
	return text.split("\0").filter(name => name !== "");
}

/** One hash over every path's content, or its size and mtime when it is too large to read on every round. */
async function filesHash(root: string, names: string[]): Promise<string> {
	if (names.length > MANY_FILES) return hash(names.join("\n"));
	const lines: string[] = [];
	for (const name of names) {
		let part: string;
		try {
			const file = path.join(root, name);
			const info = await stat(file);
			part = info.size > BIG_FILE ? `big:${info.size}:${info.mtimeMs}` : hash(await readFile(file));
		} catch {
			part = "unreadable";
		}
		lines.push(`${name}\0${part}`);
	}
	return hash(lines.join("\n"));
}

/**
 * The tree against `base`, or against `HEAD` when no base is given (which then is the base). `undefined` outside a git
 * work tree, in a repo without a commit, or when git fails or times out.
 */
export async function treeAgainst(exec: Exec, root: string, base?: string): Promise<TreeReading | undefined> {
	const commit = base ?? (await read(exec, root, ["rev-parse", "--verify", "HEAD"]))?.trim();
	if (commit === undefined || commit === "") return undefined;
	const [diff, added, untracked] = await Promise.all([
		// `--diff-filter=a` leaves added files out, so committing one moves nothing; `--no-textconv` keeps a
		// non-deterministic filter from changing the hash on every read.
		read(exec, root, ["diff", commit, "--no-renames", "--diff-filter=a", "--no-ext-diff", "--no-textconv", "--binary", "--", ...PROJECT_ONLY]),
		// A file added since the base, committed or not: `git diff` sees the index and the tree, `ls-files` the rest.
		read(exec, root, ["diff", commit, "--name-only", "-z", "--no-renames", "--diff-filter=A", "--", ...PROJECT_ONLY]),
		read(exec, root, ["ls-files", "--others", "--exclude-standard", "-z", "--", ...PROJECT_ONLY]),
	]);
	if (diff === undefined || added === undefined || untracked === undefined) return undefined;
	const names = [...new Set([...paths(added), ...paths(untracked)])].sort();
	const files = await filesHash(root, names);
	return { base: commit, state: { diff: hash(diff), files } };
}
