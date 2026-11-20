import { readdir, readFile, realpath, stat } from "node:fs/promises";
import * as path from "node:path";
import { sha256Hex } from "../config/canonical.ts";
import { ROLE_AGENT_PREFIX } from "../roles.ts";
import type { ShadowInfo } from "../types.ts";

async function isDir(p: string): Promise<boolean> {
	try {
		return (await stat(p)).isDirectory();
	} catch {
		return false;
	}
}

async function realOrResolved(p: string): Promise<string> {
	try {
		return await realpath(p);
	} catch {
		return path.resolve(p);
	}
}

/** omp scans only the nearest `.omp/agents` walking up from cwd. */
async function nearestProjectAgentsDir(cwd: string): Promise<string | undefined> {
	let dir = path.resolve(cwd);
	for (;;) {
		const candidate = path.join(dir, ".omp", "agents");
		if (await isDir(candidate)) return candidate;
		const parent = path.dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

function frontmatterName(text: string): unknown {
	const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
	if (lines[0]?.trim() !== "---") return undefined;
	const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
	if (end === -1) return undefined;
	try {
		const data: unknown = Bun.YAML.parse(lines.slice(1, end).join("\n"));
		return typeof data === "object" && data !== null && "name" in data ? data.name : undefined;
	} catch {
		return undefined;
	}
}

async function scan(dir: string, scope: ShadowInfo["scope"], pluginReal: string): Promise<ShadowInfo[]> {
	let names: string[];
	try {
		names = await readdir(dir);
	} catch {
		return [];
	}
	const out: ShadowInfo[] = [];
	for (const name of names) {
		if (!name.endsWith(".md")) continue;
		const file = path.join(dir, name);
		let real: string;
		let bytes: Uint8Array;
		try {
			real = await realpath(file);
			if (!(await stat(real)).isFile()) continue;
			bytes = await readFile(real);
		} catch {
			continue;
		}
		if (real === pluginReal || real.startsWith(pluginReal + path.sep)) continue;
		const agent = frontmatterName(new TextDecoder().decode(bytes));
		if (typeof agent !== "string" || !agent.startsWith(ROLE_AGENT_PREFIX)) continue;
		out.push({ agent, path: file, scope, sha256: sha256Hex(bytes) });
	}
	return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export async function findShadows(opts: {
	cwd: string;
	userAgentsDir: string;
	pluginAgentsDir: string;
}): Promise<ShadowInfo[]> {
	const pluginReal = await realOrResolved(opts.pluginAgentsDir);
	const projectDir = await nearestProjectAgentsDir(opts.cwd);
	const project = projectDir ? await scan(projectDir, "project", pluginReal) : [];
	const user = await scan(path.resolve(opts.userAgentsDir), "user", pluginReal);
	return [...project, ...user];
}
