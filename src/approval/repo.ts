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
	const identity: RepoIdentity = {
		repoId: `git-${slug(name)}-${sha256Hex(commonDir).slice(0, 24)}`,
		kind: "git-common-dir",
		root,
		commonDir,
	};

	const remoteLines = await run(exec, ["-C", cwd, "remote", "-v"]);
	const remotes: Record<string, string> = {};
	for (const line of remoteLines ?? []) {
		const m = /^(\S+)\s+(.+?)\s+\(fetch\)$/.exec(line);
		if (m?.[1] && m[2]) remotes[m[1]] = normalizeRemote(m[2]);
	}
	if (Object.keys(remotes).length > 0) identity.remotes = remotes;

	const rootCommits = await run(exec, ["-C", cwd, "rev-list", "--max-parents=0", "HEAD"]);
	if (rootCommits && rootCommits.length > 0) identity.rootCommits = rootCommits;

	return identity;
}

function stripTail(p: string): string {
	let s = p.replace(/\/+$/, "");
	if (s.endsWith(".git")) s = s.slice(0, -4).replace(/\/+$/, "");
	return s;
}

export function normalizeRemote(url: string): string {
	const s = url.trim();

	const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(s);
	if (scheme) {
		const rest = s.slice(scheme[0].length).replace(/[?#].*$/, "");
		const slash = rest.indexOf("/");
		const authority = slash === -1 ? rest : rest.slice(0, slash);
		const pathPart = slash === -1 ? "" : rest.slice(slash);
		// Userinfo may carry tokens; everything up to the last '@' is dropped.
		const host = authority.slice(authority.lastIndexOf("@") + 1).toLowerCase();
		return stripTail(host + pathPart);
	}

	const firstSlash = s.indexOf("/");
	const prefix = firstSlash === -1 ? s : s.slice(0, firstSlash);
	const at = prefix.lastIndexOf("@");
	const hostAndPath = at === -1 ? s : s.slice(at + 1);
	const hostPrefix = at === -1 ? prefix : prefix.slice(at + 1);
	const colon = hostPrefix.indexOf(":");
	// scp-like "host:path"; a single letter before ':' is a Windows drive, not a host.
	if (colon > 1 || (at !== -1 && colon > 0)) {
		const host = hostAndPath.slice(0, colon).toLowerCase();
		const rest = hostAndPath.slice(colon + 1).replace(/^\/+/, "");
		return stripTail(`${host}/${rest}`);
	}
	if (at !== -1) return stripTail(hostAndPath);
	return stripTail(s);
}
