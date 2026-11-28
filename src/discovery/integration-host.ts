import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { sha256Hex } from "../config/canonical.ts";
import { isRecord } from "../config/schema.ts";
import type { ApplyPolicyProofRef, DirectorIdentity, IntegrationRead, NativeTaskItem } from "../runtime/integration-admission.ts";
import { INTEGRATION_GUARD_BUILD, ISOLATION_BACKEND_UNPROVEN, ISOLATION_SCOPE_UNKNOWN, type DirectorIsolationObservation } from "./settings.ts";
import type { ApprovalRecord } from "../types.ts";

const DIGEST = /^sha256:[0-9a-f]{64}$/u;

interface NativeDefinitionIdentity {
	readonly source: "bundled" | "user" | "project";
	readonly path?: string;
	readonly digest: string;
	readonly sourceDigest?: string;
}

interface NativeDispatch {
	readonly token: string;
	readonly backend: string;
	readonly definition: NativeDefinitionIdentity;
}

/** Read the installed host's versioned API capability, not its version string or process environment. */
export function supportsGuardedIsolation(api: unknown): boolean {
	if (!isRecord(api)) return false;
	const capabilities = api.capabilities;
	if (!isRecord(capabilities) || capabilities.version !== 1 || !Object.isFrozen(capabilities)) return false;
	const isolation = capabilities.subagentIsolation;
	return isRecord(isolation) && Object.isFrozen(isolation) && isolation.version === 1 && isolation.spawnPolicy === true &&
		isolation.childEntryGuard === true && isolation.entryGuard === true && isolation.agentDefinitionIdentity === true;
}

function missing<T>(code: string, reason: string): IntegrationRead<T> {
	return { kind: "unknown", problem: { code, reason } };
}

/** Accept only the native, no-apply patch route and a frozen definition observed by the dispatch itself. */
export function guardedDispatch(event: unknown): IntegrationRead<NativeDispatch> {
	if (!isRecord(event) || typeof event.dispatchId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/u.test(event.dispatchId)) {
		return missing(ISOLATION_BACKEND_UNPROVEN, "호스트가 이 스폰의 격리 디스패치 키를 주지 않았습니다.");
	}
	const route = event.isolation;
	if (!isRecord(route) || !Object.isFrozen(route) || route.requested !== true || route.enabled !== true ||
		route.merge !== "patch" || route.apply !== false || route.commits !== "generic") {
		return missing("isolation-dispatch-policy", "호스트가 자동 적용 없는 patch 및 generic 커밋 정책으로 이 스폰을 고정하지 않았습니다.");
	}
	const workspace = route.workspace;
	if (!isRecord(workspace) || !Object.isFrozen(workspace) || workspace.kind !== "native" || typeof workspace.backend !== "string" ||
		workspace.ovnfsPath !== undefined || workspace.sessionId !== undefined) {
		return missing(ISOLATION_BACKEND_UNPROVEN, "호스트가 이 스폰의 네이티브 Git 체크아웃을 고정하지 않았습니다.");
	}
	const definition = event.agentDefinition;
	if (!isRecord(definition) || !Object.isFrozen(definition) ||
		(definition.source !== "bundled" && definition.source !== "user" && definition.source !== "project") ||
		typeof definition.digest !== "string" || !DIGEST.test(definition.digest) ||
		(definition.sourcePath !== undefined && (typeof definition.sourcePath !== "string" || !isAbsolute(definition.sourcePath))) ||
		(definition.sourceDigest !== undefined && (typeof definition.sourceDigest !== "string" || !DIGEST.test(definition.sourceDigest)))) {
		return missing("isolation-definition", "호스트가 실제 선택한 에이전트 정의의 신원을 주지 않았습니다.");
	}
	return { kind: "known", value: {
		token: event.dispatchId,
		backend: workspace.backend,
		definition: {
			source: definition.source,
			digest: definition.digest,
			...(definition.sourcePath === undefined ? {} : { path: definition.sourcePath }),
			...(definition.sourceDigest === undefined ? {} : { sourceDigest: definition.sourceDigest }),
		},
	} };
}

/** Tie host-parsed bytes to the selected approved definition; rediscovery cannot prove what the host already loaded. */
export async function approvedIntegrationDefinition(input: {
	readonly dispatch: NativeDispatch;
	readonly agent: string;
	readonly pluginAgentsDir: string;
	readonly approval: ApprovalRecord;
}): Promise<boolean> {
	const { definition } = input.dispatch;
	const approvedShadows = input.approval.scope.shadowedAgents;
	if (definition.source === "bundled") {
		return definition.path === undefined && definition.sourceDigest === undefined &&
			!approvedShadows.some(shadow => shadow.agent === input.agent);
	}
	if (definition.path === undefined || definition.sourceDigest === undefined) return false;
	if (approvedShadows.some(shadow => shadow.agent === input.agent && shadow.path === definition.path &&
		shadow.scope === definition.source && `sha256:${shadow.sha256}` === definition.sourceDigest)) return true;
	if (!/^storm-[a-z0-9-]+$/u.test(input.agent)) return false;
	try {
		const pluginFile = join(await realpath(input.pluginAgentsDir), `${input.agent}.md`);
		return await realpath(definition.path) === pluginFile &&
			`sha256:${sha256Hex(await readFile(pluginFile))}` === definition.sourceDigest;
	} catch {
		return false;
	}
}
/** Exact captured native policy must match the owner and the still-current placement observation. */
export function bindGuardedIsolation(input: {
	readonly director: DirectorIdentity;
	readonly item: NativeTaskItem;
	readonly profile: string;
	readonly observation: DirectorIsolationObservation;
	readonly dispatch: NativeDispatch;
}): IntegrationRead<ApplyPolicyProofRef> {
	const { director, item, profile, observation, dispatch } = input;
	if (item.toolCallId !== observation.toolCallId || profile.trim() === "" || observation.sessionInstance !== director.sessionInstance) {
		return missing(ISOLATION_SCOPE_UNKNOWN, "격리 디스패치가 배치한 감독이나 task 호출과 같지 않습니다.");
	}
	const check = observation.check();
	if (!check.ok) return { kind: "unknown", problem: check.problem };
	const snapshot = observation.snapshot;
	if (snapshot.enabled !== true || snapshot.apply !== false || snapshot.merge !== "patch" || snapshot.commits !== "generic" ||
		snapshot.backend === undefined || snapshot.backend === "auto" || snapshot.backend !== dispatch.backend) {
		return missing("isolation-dispatch-policy", "호스트가 고정한 격리 정책이 배치할 때 관찰한 정책과 다릅니다.");
	}
	return { kind: "known", value: {
		id: dispatch.token, host: "19.2.1", settingsInstance: observation.settingsInstance, relevantEpoch: observation.relevantEpoch,
		directorInstance: director.sessionInstance, toolCallId: item.toolCallId, enabled: true, backendProofId: dispatch.token,
		apply: false, merge: "patch", captureContract: "native-git-synthetic-tree", backendSetting: dispatch.backend,
		profile, guardBuild: INTEGRATION_GUARD_BUILD,
	} };
}
