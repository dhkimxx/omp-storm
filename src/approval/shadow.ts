import { readdir, readFile, realpath, stat } from "node:fs/promises";
import * as path from "node:path";
import { sha256Hex } from "../config/canonical.ts";
import { BUILTIN_AGENT_ROLES, ROLES } from "../roles.ts";
import type { ApprovalRecord, ShadowInfo } from "../types.ts";

/**
 * Every agent name Storm routes (B1): its own role agents and the bundled omp names it maps to a role. A definition
 * found ahead of a bundled one under any of these names is the definition that runs, so the approval must cover it by
 * the same mechanism and hash; a name outside this set is never routed by Storm and is not Storm's to judge.
 */
const ROUTED_AGENT_NAMES: ReadonlySet<string> = new Set([
	...ROLES.map(role => role.agent),
	...Object.keys(BUILTIN_AGENT_ROLES),
]);

/** Whether Storm may route this agent name, so that a definition under it needs the user's approval. */
export function isRoutedAgentName(name: string): boolean {
	return ROUTED_AGENT_NAMES.has(name);
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
		try {
			if ((await stat(candidate)).isDirectory()) return candidate;
		} catch (error) {
			// An unreadable candidate may hold definitions the host will load: hand it to `scan`, which fails closed.
			const absent = typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
			if (!absent) return candidate;
		}
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

/**
 * A directory that exists but cannot be listed: none of its definitions can be shown approved, so every name Storm
 * routes is reported as an unapproved shadow with a hash no approval can carry. A directory that is simply absent
 * (`ENOENT`) has no definitions and reports nothing.
 */
function unreadableDirShadows(dir: string, scope: ShadowInfo["scope"]): ShadowInfo[] {
	return [...ROUTED_AGENT_NAMES]
		.sort()
		.map(agent => ({ agent, path: dir, scope, sha256: "" }));
}

async function scan(dir: string, scope: ShadowInfo["scope"], pluginReal: string): Promise<ShadowInfo[]> {
	let names: string[];
	try {
		names = await readdir(dir);
	} catch (error) {
		const absent =
			typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
		return absent ? [] : unreadableDirShadows(dir, scope);
	}
	const out: ShadowInfo[] = [];
	for (const name of names) {
		if (!name.endsWith(".md")) continue;
		const file = path.join(dir, name);
		const stem = name.slice(0, -".md".length);
		let real: string;
		let bytes: Uint8Array;
		try {
			real = await realpath(file);
			if (!(await stat(real)).isFile()) continue;
			bytes = await readFile(real);
		} catch (error) {
			// B1: where Storm cannot establish which definition the host will load, it refuses. A routed file name that
			// cannot be read is an unapproved definition of that name, never evidence that there is none.
			const vanished = typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
			if (!vanished && isRoutedAgentName(stem)) {
				out.push({ agent: stem, path: file, scope, sha256: "" });
			}
			continue;
		}
		if (real === pluginReal || real.startsWith(pluginReal + path.sep)) continue;
		const front = frontmatterName(new TextDecoder().decode(bytes));
		// The host may name the definition by its frontmatter or by its file; either routed name needs approval.
		const names = new Set<string>();
		if (typeof front === "string" && isRoutedAgentName(front)) names.add(front);
		if (isRoutedAgentName(stem)) names.add(stem);
		if (names.size === 0) continue;
		const sha256 = sha256Hex(bytes);
		for (const agent of names) out.push({ agent, path: file, scope, sha256 });
	}
	return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.agent < b.agent ? -1 : a.agent > b.agent ? 1 : 0));
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

/** Shadowing definitions the approval does not cover (new, or changed since the user saw them). */
export function unapprovedShadows(approval: ApprovalRecord | undefined, shadows: readonly ShadowInfo[]): ShadowInfo[] {
	const seen = approval?.scope.shadowedAgents ?? [];
	return shadows.filter(shadow => !seen.some(s => s.agent === shadow.agent && s.sha256 === shadow.sha256));
}
