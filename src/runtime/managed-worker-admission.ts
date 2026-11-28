/**
 * Managed worker admission proof for the native isolated first turn.
 *
 * Storm's durable record proves entitlement only. The native owner's router remains the sole authority for the live
 * `ManagedWorkerTurnScope`: it verifies the owner/actor/parent/registry binding before any prompt or paid send. This module
 * never instantiates the child director or integration journal, never reads "the latest admission row", and never treats a
 * cloned token as authority. It composes three already-durable facts:
 *
 *   1. the frozen native `ctx.workerTurn` / `subagent_entry` tuple (shape and identity cross-check only),
 *   2. the exact `IntegrationAdmissionStore` prepared admission and its first-entry claim (slot, Git/worktree, inputs),
 *   3. one immutable worker-turn claim keyed by the exact Storm `{key, attempt, turn token}`.
 *
 * A bind is a CAS against the current worker record under its per-key lock. A read or end requires the exact current
 * attempt and binding, so a replacement, revoke, expiry, changed checkout or missing record refuses without creating or
 * ending anything newer. The old `claimWorkerAdmission`/`resolveWorkerAdmission`/`endWorkerAdmission` fallbacks stay for
 * stock callers and are deliberately not used here.
 */
import { isAbsolute } from "node:path";
import { canonicalJson, sha256Hex } from "../config/canonical.ts";
import { isRecord } from "../config/schema.ts";
import { guardedDispatch, type NativeDispatch } from "../discovery/integration-host.ts";
import type {
	ChildEntryClaim,
	FrozenIntegrationAdmission,
	IntegrationAdmissionPort,
	IntegrationProblem,
	IntegrationRead,
	ObservationIdentity,
} from "./integration-admission.ts";
import type { ByteWindow, IntegrationDeltaPort } from "./integration-delta.ts";
import type { LiveCheck } from "../types.ts";
import {
	bindWorkerAdmissionTurn,
	endWorkerAdmissionTurn,
	parseWorkerTurnScope,
	readWorkerAdmissionByKey,
	readWorkerAdmissionTurn,
	type ManagedWorkerTurnScope,
	type WorkerAdmissionRecord,
	type WorkerAdmissionTurn,
	type WorkerTurnChildIdentity,
	type WorkerTurnFileIdentity,
	type WorkerTurnIntegrationRef,
} from "../worker-admission.ts";

const MAX_TEXT = 512;
const MAX_PATH = 1024;
const DEVICE = /^[0-9]{1,32}$/;
const DISPATCH = /^[a-zA-Z0-9_-]{1,128}$/;
const DEFINITION_DIGEST = /^sha256:[0-9a-f]{64}$/;

/** The exact native definition identity the host froze before the spawn hook. */
export interface ManagedWorkerDefinitionIdentity {
	readonly source: "bundled" | "user" | "project";
	readonly digest: string;
	readonly path?: string;
	readonly sourceDigest?: string;
}

/** The exact native first-turn tuple after shape, identity and parent-guard cross-checks. */
export interface ManagedWorkerEntryProof {
	readonly scope: ManagedWorkerTurnScope;
	readonly dispatchId: string;
	readonly guard: string;
	/** What the child's `subagent_entry` handler must echo for a managed dispatch. */
	readonly acknowledgement: Readonly<{ dispatchId: string; guard: string; workerTurnToken: string }>;
	readonly parent: Readonly<{ agentId: string; instanceKey: string; cwd: string; sessionFile?: string }>;
	readonly actor: Readonly<{ agentId: string; agentName: string; sessionId: string; instanceKey: string; generation: number }>;
	readonly sessionFile: WorkerTurnFileIdentity;
	readonly checkout: Readonly<{ path: string; isolated: true; device: string; inode: string }>;
	readonly definition: ManagedWorkerDefinitionIdentity;
}

export interface ManagedWorkerEntryParseInput {
	readonly ctx: unknown;
	readonly event: unknown;
	readonly guard: string;
	/** Explicit host-read scope. When absent, `ctx.workerTurn` is used. */
	readonly scope?: unknown;
	/** Exact native child session id when the caller already read it from the session manager. */
	readonly actorSessionId?: string;
	/** Exact native child session file when the caller already read it from the session manager. */
	readonly sessionFile?: string;
}

/** The already-published integration admission this turn must belong to. */
export interface ManagedWorkerAdmissionReference {
	readonly runId: string;
	readonly admissionKey: string;
	readonly admissionAttempt: string;
}

/** Only the disk-only integration methods this proof needs; never the director/journal composition. */
export type ManagedWorkerIntegrationStore = Pick<IntegrationAdmissionPort, "readPrepared" | "readClaim" | "claimAtEntry">;
export type ManagedWorkerCheckoutProof = Pick<IntegrationDeltaPort, "verifyCheckoutInputs">;

export interface ManagedWorkerEntryBindRequest extends ManagedWorkerEntryParseInput {
	readonly agentDir: string;
	readonly store: ManagedWorkerIntegrationStore;
	readonly delta: ManagedWorkerCheckoutProof;
	readonly window: ByteWindow;
	readonly live: () => LiveCheck;
	readonly now?: number;
}

export interface BoundManagedWorkerEntry {
	readonly record: WorkerAdmissionRecord;
	readonly binding: WorkerAdmissionTurn;
	readonly admission: FrozenIntegrationAdmission;
	readonly claim: ChildEntryClaim;
	readonly reference: ManagedWorkerAdmissionReference;
}

export interface ManagedWorkerTurnExpectation {
	readonly runId?: string;
	readonly actorSessionId?: string;
	readonly actorInstanceKey?: string;
	readonly generation?: number;
	readonly dispatchId?: string;
	readonly kind?: ManagedWorkerTurnScope["kind"];
}

export interface ManagedWorkerTurnRequest {
	readonly agentDir: string;
	readonly guard: string;
	readonly key: string;
	readonly attempt: string;
	readonly turnToken: string;
	readonly store: ManagedWorkerIntegrationStore;
	readonly delta: ManagedWorkerCheckoutProof;
	readonly window: ByteWindow;
	readonly live: () => LiveCheck;
	readonly expect?: ManagedWorkerTurnExpectation;
	readonly now?: number;
}

export interface ManagedWorkerTurnEndRequest extends ManagedWorkerTurnRequest {
	readonly childSessionId: string;
}

export interface AuthorizedManagedWorkerTurn {
	readonly record: WorkerAdmissionRecord;
	readonly binding: WorkerAdmissionTurn;
	readonly admission: FrozenIntegrationAdmission;
	readonly claim: ChildEntryClaim;
}

export type ManagedWorkerTurnRead = IntegrationRead<AuthorizedManagedWorkerTurn>;
export type ManagedWorkerTurnEnd =
	| { readonly kind: "ended" | "already-ended"; readonly record: WorkerAdmissionRecord; readonly binding: WorkerAdmissionTurn }
	| { readonly kind: "unknown"; readonly problem: IntegrationProblem };

/** A narrow port the extension can compose later without exposing any mutable controller or journal. */
export interface ManagedWorkerAdmissionPort {
	readonly guard: string;
	reference(admission: FrozenIntegrationAdmission, record: Pick<WorkerAdmissionRecord, "key" | "attempt">): IntegrationRead<ManagedWorkerAdmissionReference>;
	parse(input: Omit<ManagedWorkerEntryParseInput, "guard">): IntegrationRead<ManagedWorkerEntryProof>;
	bind(input: Omit<ManagedWorkerEntryBindRequest, "agentDir" | "guard" | "store" | "delta">): Promise<IntegrationRead<BoundManagedWorkerEntry>>;
	read(input: Omit<ManagedWorkerTurnRequest, "agentDir" | "guard" | "store" | "delta">): Promise<ManagedWorkerTurnRead>;
	end(input: Omit<ManagedWorkerTurnEndRequest, "agentDir" | "guard" | "store" | "delta">): Promise<ManagedWorkerTurnEnd>;
}

export interface ManagedWorkerAdmissionPortOptions {
	readonly agentDir: string;
	readonly guard: string;
	readonly store: ManagedWorkerIntegrationStore;
	readonly delta: ManagedWorkerCheckoutProof;
}

function unknown<T>(code: string, reason: string): IntegrationRead<T> {
	return { kind: "unknown", problem: { code, reason } };
}

function problem(code: string, reason: string): IntegrationProblem {
	return { code, reason };
}

function text(value: unknown, limit = MAX_TEXT): string | undefined {
	return typeof value === "string" && value.length > 0 && value.length <= limit && !/[\u0000-\u001f\u007f]/u.test(value)
		? value
		: undefined;
}

function absolutePath(value: unknown): string | undefined {
	const read = text(value, MAX_PATH);
	return read !== undefined && isAbsolute(read) ? read : undefined;
}

function fileIdentity(path: string, device: unknown, inode: unknown): WorkerTurnFileIdentity | undefined {
	if (typeof device !== "string" || !DEVICE.test(device) || typeof inode !== "string" || !DEVICE.test(inode)) return undefined;
	return Object.freeze({ canonicalPath: path, device, inode });
}

function definitionIdentity(value: unknown): ManagedWorkerDefinitionIdentity | undefined {
	if (!isRecord(value)) return undefined;
	const source = value.source;
	const digest = value.digest;
	if ((source !== "bundled" && source !== "user" && source !== "project") ||
		typeof digest !== "string" || !DEFINITION_DIGEST.test(digest)) {
		return undefined;
	}
	const sourcePathValue = value.sourcePath === undefined ? undefined : absolutePath(value.sourcePath);
	const sourceDigestValue = typeof value.sourceDigest === "string" ? value.sourceDigest : undefined;
	if (value.sourcePath !== undefined && sourcePathValue === undefined) return undefined;
	if (value.sourceDigest !== undefined && (sourceDigestValue === undefined || !DEFINITION_DIGEST.test(sourceDigestValue))) return undefined;
	return Object.freeze({
		source,
		digest,
		...(sourcePathValue === undefined ? {} : { path: sourcePathValue }),
		...(sourceDigestValue === undefined ? {} : { sourceDigest: sourceDigestValue }),
	});
}

/** Call one read-only session-manager accessor without trusting a shape the caller already validated. */
function sessionManagerString(manager: unknown, name: string): string | undefined {
	if (!isRecord(manager)) return undefined;
	const method = manager[name];
	if (typeof method !== "function") return undefined;
	try {
		const value = method.call(manager);
		return typeof value === "string" && value.length > 0 ? value : undefined;
	} catch {
		return undefined;
	}
}

interface ParsedContext {
	readonly agentId: string;
	readonly agentName: string;
	readonly parentAgentId: string;
	readonly cwd: string;
	readonly actorSessionId: string;
	readonly sessionFile: string;
	readonly workerTurn?: ManagedWorkerTurnScope;
}

function parseContext(input: ManagedWorkerEntryParseInput): ParsedContext | undefined {
	if (!isRecord(input.ctx) || !isRecord(input.ctx.agent)) return undefined;
	const agent = input.ctx.agent;
	const agentId = text(agent.id);
	const agentName = text(agent.name);
	const parentAgentId = text(agent.parentId);
	const cwd = absolutePath(input.ctx.cwd);
	const manager = input.ctx.sessionManager;
	const managerSessionId = sessionManagerString(manager, "getSessionId");
	const managerSessionFile = sessionManagerString(manager, "getSessionFile");
	if (input.actorSessionId !== undefined && managerSessionId !== undefined && input.actorSessionId !== managerSessionId) return undefined;
	if (input.sessionFile !== undefined && managerSessionFile !== undefined && input.sessionFile !== managerSessionFile) return undefined;
	const actorSessionId = text(input.actorSessionId ?? managerSessionId);
	const sessionFile = absolutePath(input.sessionFile ?? managerSessionFile);
	const workerTurn = input.ctx.workerTurn === undefined ? undefined : parseWorkerTurnScope(input.ctx.workerTurn);
	if (input.ctx.workerTurn !== undefined && workerTurn === undefined) return undefined;
	if (agent.kind !== "sub" || agentId === undefined || agentName === undefined || parentAgentId === undefined ||
		cwd === undefined || actorSessionId === undefined || sessionFile === undefined) {
		return undefined;
	}
	return {
		agentId,
		agentName,
		parentAgentId,
		cwd,
		actorSessionId,
		sessionFile,
		...(workerTurn === undefined ? {} : { workerTurn }),
	};
}

interface ParsedEntryEvent {
	readonly dispatchId: string;
	readonly guard: string;
	readonly parentAgentId: string;
	readonly parentInstanceKey: string;
	readonly parentCwd: string;
	readonly parentSessionFile?: string;
	readonly agentId: string;
	readonly agentName: string;
	readonly generation: number;
	readonly actorInstanceKey: string;
	readonly sessionFile: string;
	readonly sessionFileIdentity: WorkerTurnFileIdentity;
	readonly checkoutPath: string;
	readonly checkoutIsolated: boolean;
	readonly checkoutIdentity: WorkerTurnFileIdentity;
	readonly definition: ManagedWorkerDefinitionIdentity;
	readonly workerTurn?: ManagedWorkerTurnScope;
}

function parseEntryEvent(event: unknown): ParsedEntryEvent | undefined {
	if (!isRecord(event) || event.type !== "subagent_entry") return undefined;
	if (!isRecord(event.parent) || !isRecord(event.agent) || !isRecord(event.checkout)) return undefined;
	const dispatchId = event.dispatchId;
	const guard = text(event.guard);
	const parentAgentId = text(event.parent.agentId);
	const parentInstanceKey = text(event.parent.sessionKey);
	const parentCwd = absolutePath(event.parent.cwd);
	const parentSessionFile = event.parent.sessionFile === undefined ? undefined : absolutePath(event.parent.sessionFile);
	const agentId = text(event.agent.id);
	const agentName = text(event.agent.name);
	const generation = event.agent.generation;
	const actorInstanceKey = text(event.agent.sessionKey);
	const sessionFile = absolutePath(event.sessionFile);
	const sessionDevice = isRecord(event.sessionFileIdentity) ? event.sessionFileIdentity.device : undefined;
	const sessionInode = isRecord(event.sessionFileIdentity) ? event.sessionFileIdentity.inode : undefined;
	const checkoutPath = absolutePath(event.checkout.cwd);
	const checkoutIsolated = event.checkout.isolated;
	const checkoutDevice = event.checkout.device;
	const checkoutInode = event.checkout.inode;
	const definition = definitionIdentity(event.agentDefinition);
	const workerTurn = event.workerTurn === undefined ? undefined : parseWorkerTurnScope(event.workerTurn);
	if (typeof dispatchId !== "string" || !DISPATCH.test(dispatchId) || guard === undefined || parentAgentId === undefined ||
		parentInstanceKey === undefined || parentCwd === undefined || (event.parent.sessionFile !== undefined && parentSessionFile === undefined) ||
		agentId === undefined || agentName === undefined || typeof generation !== "number" || !Number.isSafeInteger(generation) ||
		generation < 0 || actorInstanceKey === undefined || sessionFile === undefined || checkoutPath === undefined ||
		typeof checkoutIsolated !== "boolean" || definition === undefined) {
		return undefined;
	}
	const sessionFileIdentity = fileIdentity(sessionFile, sessionDevice, sessionInode);
	const checkoutIdentity = fileIdentity(checkoutPath, checkoutDevice, checkoutInode);
	if (sessionFileIdentity === undefined || checkoutIdentity === undefined) return undefined;
	if (event.workerTurn !== undefined && workerTurn === undefined) return undefined;
	return {
		dispatchId,
		guard,
		parentAgentId,
		parentInstanceKey,
		parentCwd,
		...(parentSessionFile === undefined ? {} : { parentSessionFile }),
		agentId,
		agentName,
		generation,
		actorInstanceKey,
		sessionFile,
		sessionFileIdentity,
		checkoutPath,
		checkoutIsolated,
		checkoutIdentity,
		definition,
		...(workerTurn === undefined ? {} : { workerTurn }),
	};
}

/**
 * Parse the frozen native tuple structurally. This verifies that the scope, child-entry event and live context name the
 * same parent, actor, instance, generation, dispatch and guard, and that the scope is the exact bounded v1 shape. It does
 * not confer authority: the owner's router must still validate the token.
 */
export function parseManagedWorkerEntry(input: ManagedWorkerEntryParseInput): IntegrationRead<ManagedWorkerEntryProof> {
	const guard = text(input.guard);
	if (guard === undefined) return unknown("entry-guard-invalid", "자식 진입 가드가 올바르지 않습니다");
	const ctx = parseContext(input);
	if (ctx === undefined) return unknown("entry-context-invalid", "자식 컨텍스트의 신원이나 세션 파일이 올바르지 않습니다");
	const event = parseEntryEvent(input.event);
	if (event === undefined) return unknown("entry-event-invalid", "자식 진입 이벤트의 신원이나 물리 파일이 올바르지 않습니다");
	if (event.workerTurn === undefined) return unknown("entry-scope-missing", "관리 디스패치인데 자식 진입 이벤트에 네이티브 턴이 없습니다");
	const scope = parseWorkerTurnScope(input.scope ?? ctx.workerTurn ?? event.workerTurn);
	if (scope === undefined) return unknown("entry-scope-invalid", "네이티브 턴의 형식이 올바르지 않습니다");
	if (ctx.workerTurn !== undefined && canonicalJson(ctx.workerTurn) !== canonicalJson(scope)) {
		return unknown("entry-context-scope", "자식 컨텍스트의 턴이 선택된 턴과 다릅니다");
	}
	if (canonicalJson(event.workerTurn) !== canonicalJson(scope)) {
		return unknown("entry-event-scope", "자식 진입 이벤트의 턴이 선택된 턴과 다릅니다");
	}
	if (scope.kind !== "first") return unknown("entry-wake-unsupported", "첫 턴이 아닌 네이티브 턴으로 자식 진입을 결속할 수 없습니다");
	if (scope.guard !== guard || event.guard !== guard) return unknown("entry-guard-mismatch", "자식 진입 가드가 네이티브 턴과 다릅니다");
	if (scope.dispatchId !== event.dispatchId) return unknown("entry-dispatch-mismatch", "네이티브 턴과 진입 이벤트의 디스패치가 다릅니다");
	if (scope.agentId !== ctx.agentId || scope.agentId !== event.agentId) return unknown("entry-agent-mismatch", "네이티브 턴과 자식 에이전트 id가 다릅니다");
	if (scope.parentAgentId !== ctx.parentAgentId || scope.parentAgentId !== event.parentAgentId) {
		return unknown("entry-parent-mismatch", "네이티브 턴과 부모 에이전트 id가 다릅니다");
	}
	if (scope.actorSessionId !== ctx.actorSessionId) return unknown("entry-actor-session", "네이티브 턴과 자식 세션 id가 다릅니다");
	if (scope.actorInstanceKey !== event.actorInstanceKey) return unknown("entry-actor-instance", "네이티브 턴과 자식 세션 인스턴스가 다릅니다");
	if (scope.generation !== event.generation) return unknown("entry-generation-mismatch", "네이티브 턴과 자식 레지스트리 세대가 다릅니다");
	if (event.sessionFile !== ctx.sessionFile) return unknown("entry-session-file", "자식 진입 이벤트와 컨텍스트의 세션 파일이 다릅니다");
	if (event.checkoutPath !== ctx.cwd) return unknown("entry-checkout-cwd", "자식 진입 이벤트와 컨텍스트의 작업 경로가 다릅니다");
	if (event.checkoutIsolated !== true) return unknown("entry-not-isolated", "관리 턴의 자식 체크아웃이 격리 경로가 아닙니다");
	const proof: ManagedWorkerEntryProof = Object.freeze({
		scope,
		dispatchId: event.dispatchId,
		guard,
		acknowledgement: Object.freeze({ dispatchId: event.dispatchId, guard, workerTurnToken: scope.token }),
		parent: Object.freeze({
			agentId: event.parentAgentId,
			instanceKey: event.parentInstanceKey,
			cwd: event.parentCwd,
			...(event.parentSessionFile === undefined ? {} : { sessionFile: event.parentSessionFile }),
		}),
		actor: Object.freeze({
			agentId: event.agentId,
			agentName: event.agentName,
			sessionId: ctx.actorSessionId,
			instanceKey: event.actorInstanceKey,
			generation: event.generation,
		}),
		sessionFile: event.sessionFileIdentity,
		checkout: Object.freeze({
			path: event.checkoutPath,
			isolated: true,
			device: event.checkoutIdentity.device,
			inode: event.checkoutIdentity.inode,
		}),
		definition: event.definition,
	});
	return { kind: "known", value: proof };
}

/** The exact spawn-side reference the host accepts in `requireChildEntry.admission`; not a token. */
export function managedWorkerAdmissionReference(
	admission: FrozenIntegrationAdmission,
	record: Pick<WorkerAdmissionRecord, "key" | "attempt">,
): IntegrationRead<ManagedWorkerAdmissionReference> {
	if (admission.workerAdmission.key !== record.key || admission.workerAdmission.attempt !== record.attempt) {
		return unknown("reference-worker", "통합 승인과 자식 권한 시도가 다릅니다");
	}
	if (text(admission.key.runId) === undefined || text(admission.key.dispatch) === undefined) {
		return unknown("reference-admission", "통합 승인 키가 올바르지 않습니다");
	}
	return {
		kind: "known",
		value: Object.freeze({ runId: admission.key.runId, admissionKey: record.key, admissionAttempt: record.attempt }),
	};
}

function verifyAdmissionAgainstRecord(input: {
	admission: FrozenIntegrationAdmission;
	record: WorkerAdmissionRecord;
	guard: string;
	dispatch?: NativeDispatch;
	binding?: WorkerAdmissionTurn;
}): IntegrationProblem | undefined {
	const { admission, record, guard, dispatch, binding } = input;
	if (admission.workerAdmission.key !== record.key || admission.workerAdmission.attempt !== record.attempt) {
		return problem("integration-worker", "통합 승인이 다른 자식 권한 시도를 가리킵니다");
	}
	if (canonicalJson(admission.workerAdmission.approved ?? null) !== canonicalJson(record.approved ?? null)) {
		return problem("integration-approval", "통합 승인과 자식 권한의 승인 모델이 다릅니다");
	}
	if (admission.key.runId !== record.runId) return problem("integration-run", "통합 승인 실행 id가 자식 권한 기록과 다릅니다");
	if (admission.director.sessionId !== record.sessionId || admission.director.parentId !== record.parentId ||
		admission.director.sessionDir !== record.sessionDir) {
		return problem("integration-director", "통합 승인의 감독 신원이 자식 권한 기록과 다릅니다");
	}
	if (admission.item.handle !== record.childId) return problem("integration-handle", "통합 승인의 작업 항목이 이 자식이 아닙니다");
	if (admission.target.authorizedRoot.canonicalPath !== record.targetRoot) {
		return problem("integration-target", "통합 승인의 대상 루트가 자식 권한 기록과 다릅니다");
	}
	if (admission.artifactRoot.canonicalPath !== record.artifactRoot) {
		return problem("integration-artifact", "통합 승인의 아티팩트 루트가 자식 권한 기록과 다릅니다");
	}
	if (admission.policy.guardBuild !== guard) return problem("integration-guard", "통합 승인의 가드 빌드가 현재 가드와 다릅니다");
	if (dispatch !== undefined) {
		if (admission.policy.backendProofId !== dispatch.token) return problem("integration-dispatch", "통합 승인의 네이티브 디스패치가 진입 이벤트와 다릅니다");
		if (admission.policy.backendSetting !== dispatch.backend) return problem("integration-backend", "통합 승인의 격리 백엔드가 진입 이벤트와 다릅니다");
		if (admission.slot.slotPath !== dispatch.slotPath) return problem("integration-slot", "통합 승인의 네이티브 슬롯이 진입 이벤트와 다릅니다");
		if (admission.target.gitRoot.canonicalPath !== dispatch.sourceRoot) return problem("integration-source", "통합 승인의 소스 루트가 진입 이벤트와 다릅니다");
		if (admission.approvedDefinitionDigest !== dispatch.definition.digest) {
			return problem("integration-definition", "통합 승인의 정의 다이제스트가 진입 이벤트와 다릅니다");
		}
	}
	if (binding !== undefined) {
		if (binding.integration === undefined) return problem("binding-integration", "결속된 턴에 통합 승인 참조가 없습니다");
		if (binding.key !== record.key || binding.attempt !== record.attempt) {
			return problem("binding-worker", "결속된 턴이 다른 자식 권한 시도를 가리킵니다");
		}
		if (binding.turn.runId !== record.runId || binding.turn.ownerSessionId !== record.sessionId ||
			binding.turn.parentAgentId !== record.parentId || binding.turn.agentId !== record.childId) {
			return problem("binding-scope", "결속된 턴의 신원이 자식 권한 기록과 다릅니다");
		}
		if (binding.turn.ownerInstanceKey !== admission.director.sessionInstance) {
			return problem("binding-owner-instance", "결속된 턴의 부모 세션 인스턴스가 통합 승인 감독과 다릅니다");
		}
		if (binding.turn.runId !== admission.key.runId || binding.turn.guard !== guard) {
			return problem("binding-admission", "결속된 턴의 실행 id나 가드가 통합 승인과 다릅니다");
		}
		if (admission.policy.backendProofId !== binding.turn.dispatchId) {
			return problem("integration-dispatch", "통합 승인의 네이티브 디스패치가 결속된 턴과 다릅니다");
		}
		if (binding.integration.runId !== admission.key.runId || binding.integration.dispatch !== admission.key.dispatch ||
			binding.integration.candidateId !== admission.candidateId ||
			binding.integration.policyProofId !== admission.policy.id ||
			binding.integration.slotOwnerToken !== admission.slot.ownerToken ||
			binding.integration.guardBuild !== guard) {
			return problem("binding-integration-ref", "결속된 턴의 통합 승인 참조가 준비된 승인과 다릅니다");
		}
	}
	return undefined;
}

function verifyClaimAgainstRecord(input: {
	claim: ChildEntryClaim;
	admission: FrozenIntegrationAdmission;
	record: WorkerAdmissionRecord;
	guard: string;
}): IntegrationProblem | undefined {
	const { claim, admission, record, guard } = input;
	if (claim.key.schema !== admission.key.schema || claim.key.runId !== admission.key.runId ||
		claim.key.dispatch !== admission.key.dispatch || claim.candidateId !== admission.candidateId) {
		return problem("claim-admission", "자식 진입 주장이 통합 승인 키와 다릅니다");
	}
	if (claim.workerAttempt !== record.attempt || claim.childHandle !== record.childId) {
		return problem("claim-worker", "자식 진입 주장이 이 자식 권한 시도와 다릅니다");
	}
	if (claim.policyProofId !== admission.policy.id || claim.slotOwnerToken !== admission.slot.ownerToken || claim.guardBuild !== guard) {
		return problem("claim-policy", "자식 진입 주장의 정책, 슬롯 또는 가드가 통합 승인과 다릅니다");
	}
	if (claim.hostOwner.host !== admission.policy.host) return problem("claim-host", "자식 진입 주장의 호스트가 통합 승인과 다릅니다");
	if (claim.checkoutTargetPrefix !== admission.target.targetPrefix) {
		return problem("claim-prefix", "자식 진입 주장의 대상 접두사가 통합 승인과 다릅니다");
	}
	if (canonicalJson(claim.sourceOdb) !== canonicalJson(admission.target.sourceOdb)) {
		return problem("claim-odb", "자식 진입 주장의 객체 저장소가 통합 승인과 다릅니다");
	}
	return undefined;
}

function verifyClaimAgainstProof(claim: ChildEntryClaim, proof: ManagedWorkerEntryProof): IntegrationProblem | undefined {
	if (claim.entry.registryInstance !== proof.actor.instanceKey) return problem("claim-actor-instance", "자식 진입 주장의 인스턴스가 네이티브 턴과 다릅니다");
	if (claim.entry.generation !== proof.actor.generation) return problem("claim-generation", "자식 진입 주장의 세대가 네이티브 턴과 다릅니다");
	// macOS `/tmp` is a symlink to `/private/tmp`: the existing integration entry records the canonical stat identity and
	// keeps the host spelling separately. Accept either exact spelling, but always require the same device/inode.
	const sessionPath =
		claim.entry.childSessionFile.canonicalPath === proof.sessionFile.canonicalPath ||
		claim.entry.hostSessionFile === proof.sessionFile.canonicalPath;
	if (!sessionPath || claim.entry.childSessionFile.device !== proof.sessionFile.device ||
		claim.entry.childSessionFile.inode !== proof.sessionFile.inode) {
		return problem("claim-session", "자식 진입 주장의 세션 파일 identity가 네이티브 턴과 다릅니다");
	}
	if (claim.checkout.device !== proof.checkout.device || claim.checkout.inode !== proof.checkout.inode) {
		return problem("claim-checkout", "자식 진입 주장의 체크아웃 identity가 네이티브 턴과 다릅니다");
	}
	return undefined;
}

function verifyClaimAgainstBinding(claim: ChildEntryClaim, binding: WorkerAdmissionTurn): IntegrationProblem | undefined {
	if (claim.entry.registryInstance !== binding.child.registryInstance || claim.entry.generation !== binding.child.generation) {
		return problem("claim-binding-actor", "자식 진입 주장의 인스턴스나 세대가 결속된 턴과 다릅니다");
	}
	if (claim.entry.childSessionFile.canonicalPath !== binding.child.sessionFile.canonicalPath ||
		claim.entry.childSessionFile.device !== binding.child.sessionFile.device ||
		claim.entry.childSessionFile.inode !== binding.child.sessionFile.inode) {
		return problem("claim-binding-session", "자식 진입 주장의 세션 파일이 결속된 턴과 다릅니다");
	}
	if (claim.checkout.canonicalPath !== binding.child.checkout.canonicalPath ||
		claim.checkout.device !== binding.child.checkout.device || claim.checkout.inode !== binding.child.checkout.inode) {
		return problem("claim-binding-checkout", "자식 진입 주장의 체크아웃이 결속된 턴과 다릅니다");
	}
	if (claim.hostOwner.pid !== binding.host.pid || claim.hostOwner.processStart !== binding.host.processStart ||
		claim.hostOwner.host !== binding.host.host) {
		return problem("claim-binding-host", "자식 진입 주장의 호스트 인스턴스가 결속된 턴과 다릅니다");
	}
	return undefined;
}

/** All synchronous checks that must hold again on the freshly re-read record after any awaited proof. */
function settledEntitlementProblem(input: {
	admission: FrozenIntegrationAdmission;
	claim: ChildEntryClaim;
	record: WorkerAdmissionRecord;
	binding: WorkerAdmissionTurn;
	guard: string;
}): IntegrationProblem | undefined {
	const admissionProblem = verifyAdmissionAgainstRecord({
		admission: input.admission, record: input.record, guard: input.guard, binding: input.binding,
	});
	if (admissionProblem !== undefined) return admissionProblem;
	const claimProblem = verifyClaimAgainstRecord({
		claim: input.claim, admission: input.admission, record: input.record, guard: input.guard,
	});
	return claimProblem ?? verifyClaimAgainstBinding(input.claim, input.binding);
}

/**
 * Validate the existing first-entry claim and refresh its physical checkout proof. The claim already carries the slot,
 * Git and session identities; `GitDelta` re-proves the live checkout/Git identity at work/end without re-reading the
 * consumed input bytes, which legitimately change during work and were proven exactly once at entry. No second realpath
 * or stat of the same checkout is performed.
 */
async function verifyExistingClaim(input: {
	admission: FrozenIntegrationAdmission;
	store: ManagedWorkerIntegrationStore;
	delta: ManagedWorkerCheckoutProof;
	record: WorkerAdmissionRecord;
	guard: string;
	window: ByteWindow;
	live: () => LiveCheck;
	proof?: ManagedWorkerEntryProof;
	binding?: WorkerAdmissionTurn;
}): Promise<IntegrationRead<ChildEntryClaim>> {
	const claim = await input.store.readClaim(input.admission.key);
	if (claim.kind === "unknown") return claim;
	const recordProblem = verifyClaimAgainstRecord({
		claim: claim.value, admission: input.admission, record: input.record, guard: input.guard,
	});
	if (recordProblem !== undefined) return unknown(recordProblem.code, recordProblem.reason);
	if (input.proof !== undefined) {
		const proofProblem = verifyClaimAgainstProof(claim.value, input.proof);
		if (proofProblem !== undefined) return unknown(proofProblem.code, proofProblem.reason);
	}
	if (input.binding !== undefined) {
		const bindingProblem = verifyClaimAgainstBinding(claim.value, input.binding);
		if (bindingProblem !== undefined) return unknown(bindingProblem.code, bindingProblem.reason);
	}
	const before = input.live();
	if (!before.ok) return unknown("live-refused", before.reason);
	// Consumed input bytes are entry-time facts and work may legitimately have changed them. A bind re-proves them once
	// at entry; work/end only re-prove the physical checkout and Git identity against the durable claim.
	const inputs = input.proof !== undefined && input.admission.subject.kind === "planned"
		? input.admission.subject.consumed
		: [];
	const verified = await input.delta.verifyCheckoutInputs(claim.value, inputs, input.window);
	if (!verified.ok) return { kind: "unknown", problem: verified.problem };
	const after = input.live();
	if (!after.ok) return unknown("live-refused", after.reason);
	return claim;
}

/**
 * Child-entry bind: parse the native tuple, require the already-published integration admission and its physical claim,
 * then atomically bind the exact worker attempt. The worker record is re-read inside the worker-admission CAS after every
 * await; a revoked, replaced or expired attempt writes no binding.
 */
export async function bindManagedWorkerEntry(input: ManagedWorkerEntryBindRequest): Promise<IntegrationRead<BoundManagedWorkerEntry>> {
	const parsed = parseManagedWorkerEntry(input);
	if (parsed.kind === "unknown") return parsed;
	const proof = parsed.value;
	const dispatch = guardedDispatch(input.event);
	if (dispatch.kind === "unknown") return dispatch;
	if (dispatch.value.token !== proof.dispatchId || dispatch.value.definition.digest !== proof.definition.digest) {
		return unknown("entry-dispatch", "네이티브 디스패치와 자식 진입 턴의 디스패치나 정의가 다릅니다");
	}
	const read = await readWorkerAdmissionByKey(input.agentDir, proof.scope.admissionKey);
	if (read.kind !== "record") {
		return read.kind === "missing"
			? unknown("record-missing", "이 자식 작업 시도의 권한 기록이 없습니다")
			: unknown("record-invalid", read.reason);
	}
	const record = read.record;
	if (record.policy.kind !== "private") return unknown("record-not-private", "관리 턴 바인딩은 격리된 private 작업자에게만 허용됩니다");
	if (proof.scope.admissionAttempt !== record.attempt || proof.scope.runId !== record.runId ||
		proof.scope.ownerSessionId !== record.sessionId || proof.scope.parentAgentId !== record.parentId ||
		proof.scope.agentId !== record.childId) {
		return unknown("record-turn", "네이티브 턴과 자식 권한 기록의 신원이 다릅니다");
	}
	if (record.revokedAt !== undefined) return unknown("revoked", "이 작업의 실행 권한이 취소됐습니다");
	if (record.endedAt !== undefined) return unknown("ended", "이 작업의 실행 권한은 이번 턴에서 끝났습니다");
	if (record.expiresAt <= (input.now ?? Date.now())) return unknown("expired", "이 작업의 실행 권한이 만료됐습니다");
	const prepared = await input.store.readPrepared({ key: record.key, attempt: record.attempt });
	if (prepared.kind === "unknown") return prepared;
	const admission = prepared.value;
	if (admission.director.sessionInstance !== proof.scope.ownerInstanceKey || admission.key.runId !== proof.scope.runId) {
		return unknown("integration-director", "통합 승인의 감독 인스턴스나 실행 id가 네이티브 턴과 다릅니다");
	}
	const admissionProblem = verifyAdmissionAgainstRecord({ admission, record, guard: input.guard, dispatch: dispatch.value });
	if (admissionProblem !== undefined) return { kind: "unknown", problem: admissionProblem };
	const existing = await verifyExistingClaim({
		admission, store: input.store, delta: input.delta, record, guard: input.guard, window: input.window, live: input.live, proof,
	});
	let claim: ChildEntryClaim;
	if (existing.kind === "known") {
		claim = existing.value;
	} else if (existing.problem.code === "claim-missing") {
		const entry: ObservationIdentity = {
			registryInstance: proof.actor.instanceKey,
			generation: proof.actor.generation,
			childSessionFile: proof.sessionFile,
		};
		const created = await input.store.claimAtEntry({
			admission,
			worker: record,
			entry,
			childCwd: proof.checkout.path,
			guardBuild: input.guard,
			live: input.live,
			verifyInputs: (childClaim, inputs) => input.delta.verifyCheckoutInputs(childClaim, inputs, input.window),
		});
		if (created.kind === "unknown") return created;
		const recordProblem = verifyClaimAgainstRecord({ claim: created.value, admission, record, guard: input.guard });
		if (recordProblem !== undefined) return unknown(recordProblem.code, recordProblem.reason);
		const proofProblem = verifyClaimAgainstProof(created.value, proof);
		if (proofProblem !== undefined) return unknown(proofProblem.code, proofProblem.reason);
		const live = input.live();
		if (!live.ok) return unknown("live-refused", live.reason);
		claim = created.value;
	} else {
		return existing;
	}
	const child: WorkerTurnChildIdentity = Object.freeze({
		sessionIdSha256: sha256Hex(proof.actor.sessionId),
		sessionFile: Object.freeze({ ...claim.entry.childSessionFile }),
		checkout: Object.freeze({ ...claim.checkout }),
		registryInstance: claim.entry.registryInstance,
		generation: claim.entry.generation,
	});
	const integration: WorkerTurnIntegrationRef = Object.freeze({
		runId: admission.key.runId,
		dispatch: admission.key.dispatch,
		candidateId: admission.candidateId,
		policyProofId: admission.policy.id,
		slotOwnerToken: admission.slot.ownerToken,
		guardBuild: input.guard,
	});
	const bound = await bindWorkerAdmissionTurn({
		agentDir: input.agentDir,
		key: record.key,
		attempt: record.attempt,
		turn: proof.scope,
		child,
		integration,
		host: Object.freeze({ ...claim.hostOwner }),
		...(input.now === undefined ? {} : { now: input.now }),
	});
	if (bound.kind === "refused") return unknown(bound.code, bound.reason);
	const reference = managedWorkerAdmissionReference(admission, bound.record);
	if (reference.kind === "unknown") return reference;
	const live = input.live();
	if (!live.ok) return unknown("live-refused", live.reason);
	return {
		kind: "known",
		value: Object.freeze({
			record: bound.record,
			binding: bound.binding,
			admission,
			claim,
			reference: reference.value,
		}),
	};
}

/**
 * Read/work authorization: exact current worker record + binding + prepared admission + claim, with a fresh checkout proof.
 * Missing or foreign proof is a refusal, never an unmanaged fallback. The native paid gate still validates the scope.
 */
export async function readManagedWorkerTurn(input: ManagedWorkerTurnRequest): Promise<ManagedWorkerTurnRead> {
	const read = await readWorkerAdmissionTurn({
		agentDir: input.agentDir,
		key: input.key,
		attempt: input.attempt,
		turnToken: input.turnToken,
		...(input.expect === undefined ? {} : { expect: input.expect }),
		...(input.now === undefined ? {} : { now: input.now }),
	});
	if (read.kind === "refused") return unknown(read.code, read.reason);
	if (read.record.policy.kind !== "private") return unknown("record-not-private", "관리 턴 읽기는 격리된 private 작업자에게만 허용됩니다");
	const prepared = await input.store.readPrepared({ key: read.record.key, attempt: read.record.attempt });
	if (prepared.kind === "unknown") return prepared;
	const admissionProblem = verifyAdmissionAgainstRecord({
		admission: prepared.value, record: read.record, guard: input.guard, binding: read.binding,
	});
	if (admissionProblem !== undefined) return { kind: "unknown", problem: admissionProblem };
	const claim = await verifyExistingClaim({
		admission: prepared.value, store: input.store, delta: input.delta, record: read.record,
		guard: input.guard, window: input.window, live: input.live, binding: read.binding,
	});
	if (claim.kind === "unknown") return claim;
	// Every integration proof above awaited. Re-read the exact worker record/binding now and require the same attempt,
	// token, actor and open state; then repeat the synchronous record/admission/claim matches on the fresh snapshot.
	const settled = await readWorkerAdmissionTurn({
		agentDir: input.agentDir,
		key: input.key,
		attempt: input.attempt,
		turnToken: input.turnToken,
		...(input.expect === undefined ? {} : { expect: input.expect }),
		...(input.now === undefined ? {} : { now: input.now }),
	});
	if (settled.kind === "refused") return unknown(settled.code, settled.reason);
	const settledProblem = settledEntitlementProblem({
		admission: prepared.value, claim: claim.value, record: settled.record, binding: settled.binding, guard: input.guard,
	});
	if (settledProblem !== undefined) return { kind: "unknown", problem: settledProblem };
	const live = input.live();
	if (!live.ok) return unknown("live-refused", live.reason);
	return {
		kind: "known",
		value: Object.freeze({ record: settled.record, binding: settled.binding, admission: prepared.value, claim: claim.value }),
	};
}

/**
 * End exactly the bound attempt after a fresh checkout proof. A changed checkout, missing claim, revoked record or
 * replaced attempt refuses and leaves the current record open; an already-ended exact attempt is idempotent.
 */
export async function endManagedWorkerTurn(input: ManagedWorkerTurnEndRequest): Promise<ManagedWorkerTurnEnd> {
	const initial = await readWorkerAdmissionByKey(input.agentDir, input.key);
	if (initial.kind !== "record") {
		return initial.kind === "missing"
			? { kind: "unknown", problem: problem("record-missing", "이 자식 작업 시도의 권한 기록이 없습니다") }
			: { kind: "unknown", problem: problem("record-invalid", initial.reason) };
	}
	if (initial.record.attempt !== input.attempt) {
		return { kind: "unknown", problem: problem("attempt-replaced", "이 자식 작업 시도는 더 새로운 시도로 교체됐습니다") };
	}
	if (initial.record.policy.kind !== "private") {
		return { kind: "unknown", problem: problem("record-not-private", "관리 턴 종료는 격리된 private 작업자에게만 허용됩니다") };
	}
	if (initial.record.endedAt !== undefined) {
		const ended = await endWorkerAdmissionTurn({
			agentDir: input.agentDir,
			key: input.key,
			attempt: input.attempt,
			turnToken: input.turnToken,
			childSessionId: input.childSessionId,
			...(input.now === undefined ? {} : { now: input.now }),
		});
		return ended.kind === "refused" ? { kind: "unknown", problem: problem(ended.code, ended.reason) } : ended;
	}
	const read = await readWorkerAdmissionTurn({
		agentDir: input.agentDir,
		key: input.key,
		attempt: input.attempt,
		turnToken: input.turnToken,
		...(input.expect === undefined ? {} : { expect: input.expect }),
		...(input.now === undefined ? {} : { now: input.now }),
	});
	if (read.kind === "refused") return { kind: "unknown", problem: problem(read.code, read.reason) };
	if (read.record.policy.kind !== "private") return { kind: "unknown", problem: problem("record-not-private", "관리 턴 종료는 격리된 private 작업자에게만 허용됩니다") };
	const prepared = await input.store.readPrepared({ key: read.record.key, attempt: read.record.attempt });
	if (prepared.kind === "unknown") return { kind: "unknown", problem: prepared.problem };
	const admissionProblem = verifyAdmissionAgainstRecord({
		admission: prepared.value, record: read.record, guard: input.guard, binding: read.binding,
	});
	if (admissionProblem !== undefined) return { kind: "unknown", problem: admissionProblem };
	const claim = await verifyExistingClaim({
		admission: prepared.value, store: input.store, delta: input.delta, record: read.record,
		guard: input.guard, window: input.window, live: input.live, binding: read.binding,
	});
	if (claim.kind === "unknown") return { kind: "unknown", problem: claim.problem };
	// The checkout proof awaited; re-read the exact attempt/binding and require the same synchronous entitlement before
	// the end CAS. A revoke, replacement or expiry in that window closes nothing.
	const settled = await readWorkerAdmissionTurn({
		agentDir: input.agentDir,
		key: input.key,
		attempt: input.attempt,
		turnToken: input.turnToken,
		...(input.expect === undefined ? {} : { expect: input.expect }),
		...(input.now === undefined ? {} : { now: input.now }),
	});
	if (settled.kind === "refused") return { kind: "unknown", problem: problem(settled.code, settled.reason) };
	const settledProblem = settledEntitlementProblem({
		admission: prepared.value, claim: claim.value, record: settled.record, binding: settled.binding, guard: input.guard,
	});
	if (settledProblem !== undefined) return { kind: "unknown", problem: settledProblem };
	const live = input.live();
	if (!live.ok) return { kind: "unknown", problem: problem("live-refused", live.reason) };
	const ended = await endWorkerAdmissionTurn({
		agentDir: input.agentDir,
		key: input.key,
		attempt: input.attempt,
		turnToken: input.turnToken,
		childSessionId: input.childSessionId,
		...(input.now === undefined ? {} : { now: input.now }),
	});
	if (ended.kind === "refused") return { kind: "unknown", problem: problem(ended.code, ended.reason) };
	return ended;
}

/** Curry the disk-only stores so the extension can pass only the current native tuple and exact attempt. */
export function createManagedWorkerAdmissionPort(options: ManagedWorkerAdmissionPortOptions): ManagedWorkerAdmissionPort {
	const { agentDir, guard, store, delta } = options;
	return {
		guard,
		reference: (admission, record) => managedWorkerAdmissionReference(admission, record),
		parse: input => parseManagedWorkerEntry({ ...input, guard }),
		bind: input => bindManagedWorkerEntry({ ...input, agentDir, guard, store, delta }),
		read: input => readManagedWorkerTurn({ ...input, agentDir, guard, store, delta }),
		end: input => endManagedWorkerTurn({ ...input, agentDir, guard, store, delta }),
	};
}
