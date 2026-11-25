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
	/** The fingerprint can detect some changes, but cannot attest to these file contents. */
	incomplete?: true;
}

/** A tree read and the commit it was compared with; later reads continue against the same commit. */
export interface TreeReading {
	base: string;
	state: TreeState;
}

/**
 * The whole git side of one tree read shares this budget, so a slow diff no longer stacks on a slow listing. A run's
 * round decision runs inside omp's ~30 s `agent_end` handler: 20 s leaves room for the gate, the record write and the
 * notices that follow the read. Content hashing is separate and bounded by BIG_FILE and MANY_FILES. Callers that race
 * a read with their own timer take their bound from here, so the timer never cuts a read this budget would finish.
 */
export const TREE_READ_TIMEOUT_MS = 20_000;

/** A file this large contributes its size and mtime: reading a huge artifact on every round costs more than it tells. */
const BIG_FILE = 2 * 1024 * 1024;
/** Past this many new paths only the names are hashed: their contents would cost more than the change they show. */
const MANY_FILES = 2_000;

/** `.omp` holds Storm's own state and every other tool's, at the top level and below any directory. */
const PROJECT_ONLY = [".", ":(exclude,glob)**/.omp/**"];

const hash = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex").slice(0, 16);

async function read(exec: Exec, root: string, args: string[], deadline: number): Promise<string | undefined> {
	const remaining = deadline - Date.now();
	if (remaining <= 0) return undefined;
	try {
		// `diff.autoRefreshIndex=false`: a plain `git diff` rewrites `.git/index` and takes its lock; Storm only reads.
		const res = await exec("git", ["-c", "diff.autoRefreshIndex=false", "-C", root, ...args], { timeout: remaining });
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
async function filesHash(root: string, names: string[]): Promise<Pick<TreeState, "files" | "incomplete">> {
	if (names.length > MANY_FILES) return { files: hash(names.join("\n")), incomplete: true };
	const lines: string[] = [];
	let incomplete = false;
	for (const name of names) {
		let part: string;
		try {
			const file = path.join(root, name);
			const info = await stat(file);
			if (!info.isFile() || info.size > BIG_FILE) {
				part = `metadata:${info.size}:${info.mtimeMs}`;
				incomplete = true;
			} else part = hash(await readFile(file));
		} catch {
			incomplete = true;
			part = "unreadable";
		}
		lines.push(`${name}\0${part}`);
	}
	return { files: hash(lines.join("\n")), ...(incomplete ? { incomplete: true } : {}) };
}

/**
 * The tree against `base`, or against `HEAD` when no base is given (which then is the base). `undefined` outside a git
 * work tree, in a repo without a commit, or when git fails or times out.
 */
export async function treeAgainst(exec: Exec, root: string, base?: string): Promise<TreeReading | undefined> {
	const deadline = Date.now() + TREE_READ_TIMEOUT_MS;
	const commit = base ?? (await read(exec, root, ["rev-parse", "--verify", "HEAD"], deadline))?.trim();
	if (commit === undefined || commit === "") return undefined;
	const [diff, added, untracked] = await Promise.all([
		// `--diff-filter=a` leaves added files out, so committing one moves nothing; `--no-textconv` keeps a
		// non-deterministic filter from changing the hash on every read.
		read(exec, root, ["diff", commit, "--no-renames", "--diff-filter=a", "--no-ext-diff", "--no-textconv", "--binary", "--", ...PROJECT_ONLY], deadline),
		// A file added since the base, committed or not: `git diff` sees the index and the tree, `ls-files` the rest.
		read(exec, root, ["diff", commit, "--name-only", "-z", "--no-renames", "--diff-filter=A", "--", ...PROJECT_ONLY], deadline),
		read(exec, root, ["ls-files", "--others", "--exclude-standard", "-z", "--", ...PROJECT_ONLY], deadline),
	]);
	if (diff === undefined || added === undefined || untracked === undefined) return undefined;
	const names = [...new Set([...paths(added), ...paths(untracked)])].sort();
	return { base: commit, state: { diff: hash(diff), ...(await filesHash(root, names)) } };
}
