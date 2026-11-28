/**
 * One bounded, model-only provider projection of the director's async deliveries.
 *
 * A patched host attaches a revision-1 execution proof to a delivered task row (`details.jobs[i].proof`, or the
 * message-level `proof` of a single-job message). The proof is the only thing this module reads to decide that a
 * delivery belongs to the director:
 *
 *   { revision: 1, jobId, type: "task", executionToken, agentId, itemIndex, ownerSessionId }
 *
 * A message is summarized only when every job it renders has such a proof for the exact owner and the trusted
 * `confirmExecution` callback returns the exact retained attempt for each proof. Nothing here infers ownership from a
 * label, rendered text, timestamp, job id currently present in a host snapshot, a status string or a lane name. A
 * message that mixes an owned job with a foreign/unproven job has no revision-1 per-segment boundary, so it is kept
 * byte-identical rather than split by a guess. A proof the callback cannot confirm, a malformed retained record, a
 * wrong owner, an unknown revision or a throwing callback also leaves that message byte-identical.
 *
 * The output is a provider projection, not a transcript edit: the extension returns it from `pi.on("context")`, whose
 * replacement is used for one request only. The native transcript, the user-visible history, the ledger and every
 * evaluator keep the original delivery text.
 *
 * Caller contract:
 * - Call only for the director (`ctx.agent.kind === "main"`). A child's request must call nothing here.
 * - Pass `ctx.agent.id` as `ownerSessionId`; it must be the exact id read for this request. No run id, lane, agent name,
 *   message field or previously remembered name is an owner.
 * - Pass the host's `event.messages` in order. Do not append a generated notice to it first; concatenating is the
 *   caller's separate step. Observe/evaluate the original deliveries first: this projection changes only what the
 *   provider sees and never replaces Storm's delivery evaluation, ledger facts or acceptance state.
 * - Return `undefined` from the hook when `changed` is false so the host keeps its original provider payload. When
 *   `changed` is true, return `{ messages }`; the array is fresh, but every untouched message is the same object.
 * - `confirmExecution` is synchronous and trusted. It must look up persisted Storm state by the whole proof
 *   (`ownerSessionId`, `jobId`, `executionToken`, `agentId`, `itemIndex`) and return only an exact retained attempt.
 *   It must not infer success from the job id being present in today's registry, from a label, a time or message text.
 *   It must not perform I/O; a lookup that cannot answer synchronously must return undefined. The proof handed to it is
 *   a frozen copy, safe to key or store for the duration of the call.
 * - `DirectorRetainedDelivery.inspect` is the exact persisted handle to inspect the attempt later (for example an
 *   `agent://…` or a stored attempt id) and `unresolved` is the exact count read from persisted Storm state. This
 *   module neither derives nor changes either value, and it never turns a summarized delivery into accepted/completed.
 * - `inspectAll` is an exact persisted handle for the run's live attempt/result projection (for example a stable
 *   `history://…` or run record handle). It is required only when the bounded handle list cannot name every retained
 *   attempt; without it the projection leaves every owned delivery whole instead of dropping an uninspectable attempt.
 *
 * The summary is one developer message per request, bounded by `DIRECTOR_SUMMARY_MAX_BYTES` and
 * `DIRECTOR_SUMMARY_MAX_HANDLES`. It names a bounded prefix of the exact handles and states the exact number of
 * attempts whose handle is not named. All owned delivery messages collapse into it; foreign, mixed and unconfirmed
 * messages stay in place. Scans and callbacks are one pass over the batch; repeated deliveries of the same proof
 * (including historical repetitions) are confirmed once and counted as replays. No state, clock, I/O or model call.
 */

import { isRecord } from "../config/schema.ts";

/** Wire tag of this projection. Bump only if an existing field changes meaning. */
export const DIRECTOR_CONTEXT_SCHEMA = "storm.director-context/v1";

/** The only host proof revision whose ownership semantics this module understands. */
export const DIRECTOR_PROOF_REVISION = 1;

/** The summary text (UTF-8) stays at or below this many bytes. */
export const DIRECTOR_SUMMARY_MAX_BYTES = 4_096;

/** At most this many exact inspect handles are named in one summary; the rest are counted exactly. */
export const DIRECTOR_SUMMARY_MAX_HANDLES = 32;

/** A persisted inspect handle is one token: no whitespace or control characters, at most this many UTF-16 units. */
export const DIRECTOR_HANDLE_MAX_CHARS = 160;

/** A proof token (job id, execution token, agent id, owner session id) is bounded the same way. */
export const DIRECTOR_TOKEN_MAX_CHARS = 200;

/**
 * The exact execution proof a compatible patched host attaches to one delivered task job. Extra fields are ignored;
 * every field below must be present with this type and `ownerSessionId` must equal the director's exact id.
 */
export interface DirectorDeliveryProof {
	readonly revision: 1;
	readonly jobId: string;
	readonly type: "task";
	/** The host's token for this native execution, not a job id or a timestamp-derived value. */
	readonly executionToken: string;
	readonly agentId: string;
	/** Zero-based position of this execution in the admitted task batch. */
	readonly itemIndex: number;
	readonly ownerSessionId: string;
}

/** The exact persisted attempt behind one confirmed proof. Both values are copied, never derived. */
export interface DirectorRetainedDelivery {
	/** Exact persisted inspect handle: bounded ASCII token (`A-Za-z0-9._:/@+=#-`). */
	readonly inspect: string;
	/** Exact count of unresolved result/requirement rows this attempt represents in persisted state. */
	readonly unresolved: number;
}

export interface DirectorContextInput<Message> {
	/** The exact main-agent session id from `ctx.agent.id` at entry. */
	readonly ownerSessionId: string;
	/** The host's provider messages for this request, in their original order. */
	readonly messages: Message[];
	/**
	 * Trusted, synchronous proof lookup. Returns the exact retained attempt for the proof, or undefined. It is called
	 * once per unique proof in the batch, and only after the proof is structurally valid and names this director.
	 */
	readonly confirmExecution: (proof: DirectorDeliveryProof) => DirectorRetainedDelivery | undefined;
	/**
	 * Exact persisted handle for the run's live attempt/result projection. Required when more unique handles exist
	 * than the summary's handle/byte bound can name; a missing or invalid handle then keeps every original message.
	 */
	readonly inspectAll?: string;
}

export interface DirectorContextProjection<Message> {
	/**
	 * The provider messages to return from `context`. The exact input array when `changed` is false; otherwise a fresh
	 * array with untouched messages at their original references and one summary developer message at the end.
	 */
	readonly messages: Message[];
	readonly changed: boolean;
	/** Owned delivery messages collapsed into the summary. */
	readonly deliveries: number;
	/** Unique confirmed attempts named by those deliveries. */
	readonly retained: number;
	/** Repeated proofs collapsed into an already-counted attempt (including historical repetitions). */
	readonly replays: number;
	/** Sum of the exact `unresolved` counts of the unique retained attempts in the summary. */
	readonly unresolved: number;
	/** Messages with at least one owner-valid proof that stayed whole (mixed or unconfirmed). */
	readonly leftWhole: number;
	/** Exact persisted handles named in the summary. */
	readonly listedHandles: number;
	/** Exact persisted handles not named because of the handle/byte bound. */
	readonly omittedHandles: number;
}

/** The structural proof set of one async-result message, before any callback runs. */
interface StructuralProofs {
	readonly proofs: readonly DirectorDeliveryProof[];
	readonly complete: boolean;
	readonly ownedProofSeen: boolean;
}

/** A proof-backed message that is safe to collapse: every rendered job is owned and confirmed. */
interface OwnedDelivery {
	readonly kind: "owned";
	/** Unique proofs of this message, in job order, each with its exact retained attempt. */
	readonly attempts: readonly { readonly key: string; readonly record: DirectorRetainedDelivery }[];
	/** Proofs in the message including duplicates: the replay count uses this. */
	readonly totalProofs: number;
}

/** A message that must stay byte-identical; `ownedProofSeen` separates mixed/unproven from ordinary foreign traffic. */
interface KeptDelivery {
	readonly kind: "kept";
	readonly ownedProofSeen: boolean;
}

type DeliveryClass = OwnedDelivery | KeptDelivery;

const UNSAFE_TOKEN = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

/**
 * A bounded token, exactly as read. No trim: trimming would make two distinct host ids inspect the same attempt.
 * Whitespace is refused so one id can never start a second summary line or a new instruction.
 */
function safeToken(value: unknown, max: number): string | undefined {
	if (typeof value !== "string" || value.length === 0 || value.length > max) return undefined;
	return /\s/u.test(value) || UNSAFE_TOKEN.test(value) ? undefined : value;
}

/** Read one proof without trusting any other field. Owner equality is part of structural validity. */
function parseProof(value: unknown, ownerSessionId: string): DirectorDeliveryProof | undefined {
	if (!isRecord(value)) return undefined;
	if (value.revision !== DIRECTOR_PROOF_REVISION || value.type !== "task") return undefined;
	const jobId = safeToken(value.jobId, DIRECTOR_TOKEN_MAX_CHARS);
	const executionToken = safeToken(value.executionToken, DIRECTOR_TOKEN_MAX_CHARS);
	const agentId = safeToken(value.agentId, DIRECTOR_TOKEN_MAX_CHARS);
	const itemIndex = value.itemIndex;
	const owner = safeToken(value.ownerSessionId, DIRECTOR_TOKEN_MAX_CHARS);
	if (jobId === undefined || executionToken === undefined || agentId === undefined || owner === undefined) return undefined;
	if (typeof itemIndex !== "number" || !Number.isSafeInteger(itemIndex) || itemIndex < 0) return undefined;
	if (owner !== ownerSessionId) return undefined;
	return Object.freeze({ revision: 1 as const, jobId, type: "task" as const, executionToken, agentId, itemIndex, ownerSessionId: owner });
}

/** A persisted handle is rendered into the summary, so it is a conservative ASCII token rather than arbitrary text. */
const SAFE_HANDLE = /^[A-Za-z0-9][A-Za-z0-9._:/@+=#-]*$/u;

function safeHandle(value: unknown): string | undefined {
	const handle = safeToken(value, DIRECTOR_HANDLE_MAX_CHARS);
	return handle !== undefined && SAFE_HANDLE.test(handle) ? handle : undefined;
}

/** The exact retained state the summary is allowed to publish. A missing or malformed part keeps the delivery whole. */
function parseRetained(value: unknown): DirectorRetainedDelivery | undefined {
	if (!isRecord(value)) return undefined;
	const inspect = safeHandle(value.inspect);
	const unresolved = value.unresolved;
	if (inspect === undefined || typeof unresolved !== "number" || !Number.isSafeInteger(unresolved) || unresolved < 0) return undefined;
	// Copy only the two exact fields; a larger record cannot smuggle acceptance or completion into the summary.
	return Object.freeze({ inspect, unresolved });
}

/** Exact identity of one native execution. The owner is part of it so a reused job id in another owner never joins. */
function proofKey(proof: DirectorDeliveryProof): string {
	return JSON.stringify([proof.revision, proof.ownerSessionId, proof.jobId, proof.type, proof.executionToken, proof.agentId, proof.itemIndex]);
}

/** One host async-result envelope and the job rows whose text it renders. */
interface MessageJobs {
	readonly message: Record<string, unknown>;
	readonly jobs: readonly unknown[];
}

/**
 * The proof positions a compatible host may use: one `proof` per `details.jobs[]` row, or one message-level `proof`
 * for a single-job message. A message-level proof on a multi-job message is ambiguous and keeps the message whole.
 */
function messageJobs(message: unknown): MessageJobs | undefined {
	if (!isRecord(message) || message.customType !== "async-result") return undefined;
	const details = message.details;
	if (!isRecord(details) || !Array.isArray(details.jobs) || details.jobs.length === 0) return undefined;
	return { message, jobs: details.jobs };
}

/**
 * Collect the structural proof set of one async-result message. `complete` is true only when every rendered job is
 * proven for this exact owner and no ambiguous message-level proof was supplied.
 */
function structuralProofs(
	message: Record<string, unknown>,
	jobs: readonly unknown[],
	ownerSessionId: string,
): StructuralProofs {
	const proofs: DirectorDeliveryProof[] = [];
	let ownedProofSeen = false;
	let complete = true;
	const rawMessageProof = Object.hasOwn(message, "proof") ? message.proof : undefined;
	const hasMessageProof = rawMessageProof !== undefined;
	const messageProof = hasMessageProof ? parseProof(rawMessageProof, ownerSessionId) : undefined;
	// A message-level proof can bind one job only; on a multi-job message it has no exact segment boundary.
	if (hasMessageProof && (messageProof === undefined || jobs.length !== 1)) complete = false;
	for (const job of jobs) {
		if (!isRecord(job)) {
			complete = false;
			continue;
		}
		const raw = job.proof;
		if (raw === undefined) {
			// The one job of a single-job message may be proven once at the top level instead of on the row.
			if (!(hasMessageProof && messageProof !== undefined && jobs.length === 1)) complete = false;
			continue;
		}
		const proof = parseProof(raw, ownerSessionId);
		if (proof === undefined) {
			complete = false;
			continue;
		}
		ownedProofSeen = true;
		proofs.push(proof);
	}
	if (messageProof !== undefined) {
		ownedProofSeen = true;
		const jobProof = proofs[0];
		// One job and one message proof must be the same execution; two different valid proofs are ambiguous.
		if (jobProof !== undefined && proofKey(jobProof) !== proofKey(messageProof)) complete = false;
		if (jobProof === undefined) proofs.push(messageProof);
	}
	return { proofs, complete: complete && proofs.length === jobs.length, ownedProofSeen };
}

/**
 * Confirm one unique proof once per batch and return its exact retained record. A throwing callback or a malformed
 * record is an unconfirmed proof, never a reason to guess or to throw into the host hook.
 */
function establishConfirmer(
	confirmExecution: (proof: DirectorDeliveryProof) => DirectorRetainedDelivery | undefined,
): (proof: DirectorDeliveryProof) => DirectorRetainedDelivery | undefined {
	const known = new Map<string, DirectorRetainedDelivery | undefined>();
	return proof => {
		const key = proofKey(proof);
		if (known.has(key)) return known.get(key);
		let retained: DirectorRetainedDelivery | undefined;
		try {
			retained = parseRetained(confirmExecution(proof));
		} catch {
			retained = undefined;
		}
		known.set(key, retained);
		return retained;
	};
}

/** Classify and confirm one message. Structural incompleteness is decided before any callback runs. */
function classifyMessage(
	message: unknown,
	ownerSessionId: string,
	confirm: (proof: DirectorDeliveryProof) => DirectorRetainedDelivery | undefined,
): DeliveryClass {
	let envelope: MessageJobs | undefined;
	try {
		envelope = messageJobs(message);
	} catch {
		return { kind: "kept", ownedProofSeen: false };
	}
	if (envelope === undefined) return { kind: "kept", ownedProofSeen: false };
	let structural: StructuralProofs;
	try {
		structural = structuralProofs(envelope.message, envelope.jobs, ownerSessionId);
	} catch {
		return { kind: "kept", ownedProofSeen: false };
	}
	if (!structural.complete) return { kind: "kept", ownedProofSeen: structural.ownedProofSeen };
	const attempts: { key: string; record: DirectorRetainedDelivery }[] = [];
	const seen = new Set<string>();
	for (const proof of structural.proofs) {
		const key = proofKey(proof);
		if (seen.has(key)) continue;
		seen.add(key);
		const record = confirm(proof);
		if (record === undefined) return { kind: "kept", ownedProofSeen: true };
		attempts.push({ key, record });
	}
	if (attempts.length === 0) return { kind: "kept", ownedProofSeen: false };
	return { kind: "owned", attempts, totalProofs: structural.proofs.length };
}

const encoder = new TextEncoder();

/** The exact omitted-handle sentence; `omitted` is never truncated or rounded. */
function omittedSuffix(omitted: number, inspectAll: string): string {
	return omitted > 0 ? ` … 외 ${omitted}개(전체 ${inspectAll}).` : ".";
}

/**
 * Build the one summary. Handles are appended in first-confirmation order until the handle count or UTF-8 byte bound
 * would be crossed; the exact number left out is stated. A header that cannot fit on its own yields no summary, and
 * the caller then keeps every original message.
 */
function buildSummary(
	counts: { readonly deliveries: number; readonly retained: number; readonly replays: number; readonly unresolved: number; readonly leftWhole: number },
	handles: readonly string[],
	inspectAll: string | undefined,
): { readonly text: string; readonly listedHandles: number } | undefined {
	const header =
		`[storm] 비동기 배달 요약(모델 전용): 배달 ${counts.deliveries}건, 시도 ${counts.retained}개, 재전송 ${counts.replays}건, ` +
		`미해결 ${counts.unresolved}개. 수용이나 완료 판정이 아닙니다. 원문은 네이티브 트랜스크립트에 그대로 있습니다.` +
		(counts.leftWhole > 0 ? ` 원문을 그대로 둔 배달 ${counts.leftWhole}건이 있습니다(혼합 또는 확인 불가).` : "") +
		" 확인 핸들: ";
	let listed = Math.min(handles.length, DIRECTOR_SUMMARY_MAX_HANDLES);
	for (;;) {
		const named = `${header}${handles.slice(0, listed).join(", ")}`;
		const omitted = handles.length - listed;
		const suffix = omitted === 0 ? "." : inspectAll === undefined ? undefined : omittedSuffix(omitted, inspectAll);
		if (suffix !== undefined) {
			const summary = `${named}${suffix}`;
			if (encoder.encode(summary).length <= DIRECTOR_SUMMARY_MAX_BYTES) return { text: summary, listedHandles: listed };
		}
		// Either the full list is over budget, or the omitted-handle sentence has no exact run handle to point at.
		if (listed === 0) return undefined;
		listed -= 1;
	}
}

/**
 * Project one director provider request. Pure: it never reads the clock, performs I/O, mutates `messages`, or persists
 * the summary. See the module comment for the caller contract.
 */
export function projectDirectorContext<Message>(input: DirectorContextInput<Message>): DirectorContextProjection<Message> {
	let ownerSessionId: string | undefined;
	let confirmExecution: DirectorContextInput<Message>["confirmExecution"] | undefined;
	try {
		ownerSessionId = safeToken(input.ownerSessionId, DIRECTOR_TOKEN_MAX_CHARS);
		confirmExecution = input.confirmExecution;
	} catch {
		ownerSessionId = undefined;
	}
	const unchanged = (leftWhole: number): DirectorContextProjection<Message> => ({
		messages: input.messages,
		changed: false,
		deliveries: 0,
		retained: 0,
		replays: 0,
		unresolved: 0,
		leftWhole,
		listedHandles: 0,
		omittedHandles: 0,
	});
	// A changed owner or a missing trusted lookup is not a reason to guess: the host payload stays exactly as it was.
	if (ownerSessionId === undefined || typeof confirmExecution !== "function") return unchanged(0);

	const confirm = establishConfirmer(confirmExecution);
	const output: Message[] = [];
	const summaryKeys = new Set<string>();
	const summaryRecords: DirectorRetainedDelivery[] = [];
	let changed = false;
	let deliveries = 0;
	let totalProofs = 0;
	let leftWhole = 0;
	let lastTimestamp = 0;

	// One pass over the batch: untouched messages are pushed by reference; owned messages are removed as they are found.
	for (const message of input.messages) {
		try {
			if (isRecord(message) && typeof message.timestamp === "number" && Number.isFinite(message.timestamp)) lastTimestamp = message.timestamp;
		} catch {
			// A host object with a throwing getter has no timestamp this projection can use.
		}
		const classified = classifyMessage(message, ownerSessionId, confirm);
		if (classified.kind === "kept") {
			if (classified.ownedProofSeen) leftWhole += 1;
			output.push(message);
			continue;
		}
		changed = true;
		deliveries += 1;
		totalProofs += classified.totalProofs;
		for (const { key, record } of classified.attempts) {
			if (summaryKeys.has(key)) continue;
			summaryKeys.add(key);
			summaryRecords.push(record);
		}
	}
	if (!changed) return unchanged(leftWhole);

	const retained = summaryRecords.length;
	const replays = totalProofs - retained;
	let unresolved = 0;
	for (const record of summaryRecords) {
		unresolved += record.unresolved;
		// An exact total that cannot be represented is missing state: keep every original instead of publishing a cap.
		if (!Number.isSafeInteger(unresolved)) return unchanged(leftWhole + deliveries);
	}
	const handles: string[] = [];
	const seenHandles = new Set<string>();
	for (const record of summaryRecords) {
		if (seenHandles.has(record.inspect)) continue;
		seenHandles.add(record.inspect);
		handles.push(record.inspect);
	}
	let inspectAll: string | undefined;
	try {
		inspectAll = input.inspectAll === undefined ? undefined : safeHandle(input.inspectAll);
	} catch {
		inspectAll = undefined;
	}
	const summary = buildSummary({ deliveries, retained, replays, unresolved, leftWhole }, handles, inspectAll);
	if (summary === undefined) return unchanged(leftWhole + deliveries);
	const omittedHandles = handles.length - summary.listedHandles;
	const summaryMessage = {
		role: "developer",
		content: [{ type: "text", text: summary.text }],
		attribution: "agent",
		timestamp: lastTimestamp,
	} as unknown as Message;
	output.push(summaryMessage);
	return {
		messages: output,
		changed: true,
		deliveries,
		retained,
		replays,
		unresolved,
		leftWhole,
		listedHandles: summary.listedHandles,
		omittedHandles,
	};
}
