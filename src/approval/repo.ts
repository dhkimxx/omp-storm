import { realpath } from "node:fs/promises";
import * as path from "node:path";
import { sha256Hex } from "../config/canonical.ts";
import type { Exec, RepoIdentity } from "../types.ts";

function slug(name: string): string {
	let s = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	if (s.length > 32) s = s.slice(0, 32).replace(/-+$/, "");
	return s || "repo";
}

async function realOrResolved(p: string): Promise<string> {
	try {
		return await realpath(p);
	} catch {
		return path.resolve(p);
	}
}

async function run(exec: Exec, args: string[]): Promise<string[] | undefined> {
	try {
		const res = await exec("git", args);
		if (res.code !== 0) return undefined;
		return res.stdout
			.split(/\r?\n/)
			.map((l) => l.trim())
			.filter((l) => l.length > 0);
	} catch {
		return undefined;
	}
}

export async function resolveRepo(cwd: string, exec: Exec): Promise<RepoIdentity> {
	const lines = await run(exec, ["-C", cwd, "rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"]);
	const top = lines?.[0];
	const common = lines?.[1];
	if (!top || !common) {
		const root = await realOrResolved(cwd);
		return { repoId: `dir-${slug(path.basename(root))}-${sha256Hex(root).slice(0, 24)}`, kind: "dir", root };
	}

	const root = await realOrResolved(top);
	const commonDir = await realOrResolved(common);
	const base = path.basename(commonDir);
	const name = base === ".git" ? path.basename(path.dirname(commonDir)) : base.replace(/\.git$/, "");
	return { repoId: `git-${slug(name)}-${sha256Hex(commonDir).slice(0, 24)}`, kind: "git-common-dir", root };
}
