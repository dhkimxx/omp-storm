/** File helpers shared by Storm's state modules: one atomic writer, one per-key serializer, one JSONL reader. */
import { linkSync, renameSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

/** Writes text through a temp file and rename, so readers never see a partial file. */
export async function writeTextAtomic(file: string, text: string, beforePublish?: () => void, exclusive = false): Promise<void> {
	const dir = path.dirname(file);
	await fs.mkdir(dir, { recursive: true });
	const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
	try {
		await fs.writeFile(tmp, text);
		if (exclusive) {
			beforePublish?.();
			linkSync(tmp, file);
		} else if (beforePublish === undefined) await fs.rename(tmp, file);
		else {
			beforePublish();
			renameSync(tmp, file);
		}
	} catch (error) {
		await fs.rm(tmp, { force: true }).catch(() => undefined);
		throw error;
	}
	if (exclusive) await fs.rm(tmp, { force: true }).catch(() => undefined);
}

export function writeJsonAtomic(file: string, value: unknown, beforePublish?: () => void, exclusive = false): Promise<void> {
	return writeTextAtomic(file, `${JSON.stringify(value, null, 2)}\n`, beforePublish, exclusive);
}

/** Reads and parses JSON; any failure (missing, unreadable, corrupt) is undefined. */
export async function readJson(file: string): Promise<unknown> {
	try {
		return JSON.parse(await fs.readFile(file, "utf8"));
	} catch {
		return undefined;
	}
}

/** The lines of a JSONL file that parse and pass `accept`, in file order; a missing file is empty, torn lines are skipped. */
export async function readJsonl<T>(file: string, accept: (value: unknown) => value is T): Promise<T[]> {
	let text: string;
	try {
		text = await fs.readFile(file, "utf8");
	} catch {
		return [];
	}
	const out: T[] = [];
	for (const line of text.split("\n")) {
		if (line.trim() === "") continue;
		try {
			const value: unknown = JSON.parse(line);
			if (accept(value)) out.push(value);
		} catch {
			// torn line
		}
	}
	return out;
}

const chains = new Map<string, Promise<void>>();

/**
 * Runs `task` after every earlier task of the same key in this process has settled (failed ones included), so
 * read-modify-write steps on one file or one project never interleave.
 */
export function serialized<T>(key: string, task: () => Promise<T>): Promise<T> {
	const result = (chains.get(key) ?? Promise.resolve()).then(task);
	const tail = result.then(
		() => undefined,
		() => undefined,
	);
	chains.set(key, tail);
	void tail.then(() => {
		if (chains.get(key) === tail) chains.delete(key);
	});
	return result;
}
