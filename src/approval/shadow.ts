import { readFile, realpath } from "node:fs/promises";
import * as path from "node:path";
import type { EffectiveExtensionRoots } from "@oh-my-pi/pi-coding-agent/capability/types";
import { discoverAgents, getAgent } from "@oh-my-pi/pi-coding-agent/task/discovery";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
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

/**
 * The live session's native discovery inputs. `effectiveExtensionRoots` is the host object threaded whole (explicit
 * roots, mode, configured roots and their level); `sessionAgents` are the ones the host appends after discovery.
 */
export interface LiveDiscovery {
	extensionRoots: EffectiveExtensionRoots;
	sessionAgents: readonly AgentDefinition[];
}

async function realOrResolved(p: string): Promise<string> {
	try {
		return await realpath(p);
	} catch {
		return path.resolve(p);
	}
}

/**
 * One unattested shadow per routed name. Used when the live handle that owns this session is absent, cannot be
 * verified, or native discovery itself failed: no definition's selection can then be established. The empty digest
 * never matches an approval, so every routed name is refused with the ordinary shadow cause while config, status and
 * names Storm does not route still load.
 */
export function unattestedShadows(): ShadowInfo[] {
	return [...ROUTED_AGENT_NAMES].sort().map(agent => ({ agent, path: "", scope: "project", sha256: "" }));
}

/** The digest of exactly the definition native discovery selected, or an unattested shadow when it cannot be read. */
async function selectedShadow(agent: AgentDefinition, pluginReal: string): Promise<ShadowInfo | undefined> {
	const scope = agent.source;
	if (scope === "bundled") return undefined;
	const file = agent.filePath;
	if (file === undefined) return { agent: agent.name, path: "", scope, sha256: "" };
	let real: string;
	try {
		real = await realpath(file);
	} catch {
		return { agent: agent.name, path: file, scope, sha256: "" };
	}
	if (real === pluginReal || real.startsWith(pluginReal + path.sep)) return undefined;
	try {
		return { agent: agent.name, path: file, scope, sha256: sha256Hex(await readFile(real)) };
	} catch {
		// Selected by the host's parser but unreadable now: its bytes cannot be attested, never "no shadow".
		return { agent: agent.name, path: file, scope, sha256: "" };
	}
}

/**
 * The definitions the host would select now for the names Storm routes, resolved by the same native `discoverAgents`
 * the task preflight calls (`task/structured-subagent.ts:509`): project, user, effective extension-package roots,
 * Claude marketplace roots, then bundled, first name wins. `sessionAgents` are appended exactly as the host does.
 *
 * The spawn event names only the agent; it carries neither file nor digest. This attests the definition selected at
 * this read time, not one the host selected earlier. A definition that changes or disappears between the host's
 * resolution and this read is outside what a second discovery can prove; the approval digest covers the bytes hashed
 * here. When the host's inputs are unavailable, the caller refuses through {@link unattestedShadows} instead.
 */
export async function findShadows(opts: {
	cwd: string;
	pluginAgentsDir: string;
	discovery: LiveDiscovery;
	/** Home the host discovery reads for plugin/marketplace roots; the host default when absent. */
	home?: string;
}): Promise<ShadowInfo[]> {
	let agents: AgentDefinition[];
	try {
		({ agents } = await discoverAgents(opts.cwd, opts.home, opts.discovery.extensionRoots));
	} catch {
		return unattestedShadows();
	}
	const candidates = [...agents, ...(opts.discovery.sessionAgents ?? [])];
	const pluginReal = await realOrResolved(opts.pluginAgentsDir);
	const out: ShadowInfo[] = [];
	for (const name of [...ROUTED_AGENT_NAMES].sort()) {
		const agent = getAgent(candidates, name);
		if (agent === undefined) continue;
		const shadow = await selectedShadow(agent, pluginReal);
		if (shadow !== undefined) out.push(shadow);
	}
	return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.agent < b.agent ? -1 : a.agent > b.agent ? 1 : 0));
}

/** Shadowing definitions the approval does not cover (new, or changed since the user saw them). */
export function unapprovedShadows(approval: ApprovalRecord | undefined, shadows: readonly ShadowInfo[]): ShadowInfo[] {
	const seen = approval?.scope.shadowedAgents ?? [];
	// An empty digest is unattested by construction: an approval can never carry it, even if a record was tampered
	// with or copied from an older store.
	return shadows.filter(shadow => !seen.some(s => s.agent === shadow.agent && shadow.sha256 !== "" && s.sha256 === shadow.sha256));
}
