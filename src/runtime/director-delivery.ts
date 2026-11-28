/**
 * Native execution proofs for the director's provider-context projection.
 *
 * The host attaches one additive revision-1 proof to a background task row: the task acknowledgement
 * (`details.async.executions[]`), a terminal `wait` row (`jobs[].execution`) and an `async-result` job row
 * (`details.jobs[].execution`). Only the host mints the execution token; a job id, label, status, URL, timestamp or
 * model text never identifies an execution here.
 *
 * This module keeps the proofs that are exact for one native conversation and one current run:
 *
 * - A task acknowledgement is indexed only when its outer `toolCallId` and the item's original zero-based position and
 *   placed handle match the run placement table. A pending placement is accepted (the host can confirm a job before
 *   its spawn hook runs); the confirmation itself requires the handle to have been admitted.
 * - A terminal `wait` row is indexed only for the exact `op:"wait"` envelope, a terminal task status, the row's own
 *   job/handle identity and an admitted placement.
 * - A proof whose owner is not one of the request's exact native identities, whose fields conflict with an earlier
 *   witness of the same token, or that falls outside the bounded key set is never used.
 *
 * `confirm` then joins the push proof by the single exact execution token to one of those witnesses, re-reads the
 * placement (call, item, lane, admitted) now, and requires an exact persisted attempt or recorded delivery for this
 * run. A reused job id whose attempt carries a start stamp is confirmed only from a terminal wait row's own start; a
 * plain attempt id is confirmed only while this run has one observed token for that job and handle. Anything missing
 * or ambiguous returns undefined, so the caller keeps the original provider message.
 *
 * No I/O, clock, model text, host job-list snapshot or persisted-transcript edit. The caller scopes instances to the
 * director's native conversation and resets them on switch/shutdown.
 */
import { isRecord } from "../config/schema.ts";
import { asyncAttemptId } from "./attempt-report.ts";
import { DIRECTOR_TOKEN_MAX_CHARS, type DirectorDeliveryProof, type DirectorRetainedDelivery } from "./director-context.ts";

/** Total execution witnesses kept in one instance; older tokens fail closed. */
export const DIRECTOR_DELIVERY_INDEX_MAX = 1024;

const UNSAFE_TOKEN = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

/** A bounded host id, exactly as read. No trim: two different host ids must never become the same key. */
function safeToken(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length === 0 || value.length > DIRECTOR_TOKEN_MAX_CHARS) return undefined;
	return /\s/u.test(value) || UNSAFE_TOKEN.test(value) ? undefined : value;
}

/** One exact placement this run gave a host spawn handle, as the lane table has it now. */
export interface DirectorDeliveryPlacement {
	/** The run's spawn hook correlated this handle to the placement. */
	readonly admitted: boolean;
	/** The host tool call whose task item became this handle. */
	readonly callId?: string;
	/** Original zero-based position of that item in the call. */
	readonly itemIndex?: number;
	/** The plan lane the item was placed on; absent for an unplanned placement. */
	readonly lane?: string;
}

/** One result row the current run persisted. */
export interface DirectorDeliveryAttempt {
	readonly attemptId: string;
	readonly state: string;
	readonly lane?: string;
	readonly scope?: "excluded-by-user";
}

/** One delivery record the current run persisted for work that answers no declared result. */
export interface DirectorDeliveryRecord {
	/** Exact persisted identity: `job:<job>` or `job:<job>.t<start>`. */
	readonly id: string;
	readonly agent: string;
	readonly lane?: string;
	readonly status?: string;
}

/** The current run's exact persisted facts, captured once for one provider request. */
export interface DirectorDeliveryRequest {
	readonly runId: string;
	readonly ownerSessionId: string;
	readonly placement: (agentId: string) => DirectorDeliveryPlacement | undefined;
	readonly attempts: readonly DirectorDeliveryAttempt[];
	readonly unplanned: readonly DirectorDeliveryRecord[];
}

interface ParsedProof {
	readonly ownerSessionId: string;
	readonly jobId: string;
	readonly agentId: string;
	readonly itemIndex: number;
	readonly executionToken: string;
}

interface DeliveryEntry extends ParsedProof {
	readonly runId: string;
	/** The outer task call from the acknowledgement. Absent for a wait-only witness. */
	toolCallId?: string;
	/** The wait row proved this execution terminal and carried its own start. */
	terminal?: true;
	start?: number;
	/** Two witnesses disagreed about the same token: never use it. */
	conflict?: true;
}

/** One additive proof from any host carrier, with owner equality checked against the exact request identities. */
function executionProof(value: unknown, owners: readonly string[]): ParsedProof | undefined {
	if (!isRecord(value) || value.revision !== 1 || value.type !== "task") return undefined;
	const jobId = safeToken(value.jobId);
	const agentId = safeToken(value.agentId);
	const executionToken = safeToken(value.executionToken);
	const ownerSessionId = safeToken(value.ownerSessionId);
	const index = value.itemIndex;
	if (jobId === undefined || agentId === undefined || executionToken === undefined || ownerSessionId === undefined) return undefined;
	if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0) return undefined;
	if (!owners.includes(ownerSessionId)) return undefined;
	return { ownerSessionId, jobId, agentId, itemIndex: index, executionToken };
}

/** Terminal host statuses. A running/queued row is not a terminal fact. */
const TERMINAL_STATUS: Readonly<Record<string, true>> = { completed: true, failed: true, cancelled: true };

/**
 * The exact start a wait row reports: `settledAtMs - durationMs`. Both fields must be nonnegative safe integers and
 * the start must fall inside the observed lifetime. Anything else leaves the start unknown (never derived).
 */
function waitStart(row: Record<string, unknown>): number | undefined {
	const settled = row.settledAtMs;
	const duration = row.durationMs;
	if (typeof settled !== "number" || !Number.isSafeInteger(settled) || settled < 0) return undefined;
	if (typeof duration !== "number" || !Number.isSafeInteger(duration) || duration < 0 || duration > settled) return undefined;
	return settled - duration;
}

/** The claim a task acknowledgement gives the index: the outer host call id. */
export interface DirectorTaskAckInput {
	readonly runId: string;
	/** Exact identities of this request's native conversation; the proof owner must be one of them. */
	readonly owners: readonly string[];
	readonly toolCallId: string;
	/** Host `TaskToolDetails`; only `async.executions[]` is read. */
	readonly details: unknown;
	readonly placement: (agentId: string) => DirectorDeliveryPlacement | undefined;
}

/** The terminal claim a native wait snapshot gives the index: its own status and start. */
export interface DirectorWaitInput {
	readonly runId: string;
	readonly owners: readonly string[];
	/** Host wait result details; only `op:"wait"` and its `jobs[]` rows are read. */
	readonly details: unknown;
	readonly placement: (agentId: string) => DirectorDeliveryPlacement | undefined;
}

/**
 * One native conversation's bounded proof index. The owner calls `beginRun` for the current ledger, `reset` on every
 * conversation boundary, and `confirm` once per unique projection proof.
 */
export class DirectorDeliveryIndex {
	readonly #entries = new Map<string, DeliveryEntry>();
	#runId: string | undefined;
	#ownerSessionId: string | undefined;

	/** Forget every proof. Called on switch, shutdown and when a different run is observed. */
	reset(): void {
		this.#entries.clear();
		this.#runId = undefined;
		this.#ownerSessionId = undefined;
	}

	/** Bind the index to one current run; a different run starts empty. */
	beginRun(runId: string): void {
		if (this.#runId === runId) return;
		this.reset();
		this.#runId = runId;
	}

	/** The one exact owner all kept witnesses name, or undefined when there is no witness or owners disagree. */
	owner(): string | undefined {
		return this.#entries.size === 0 ? undefined : this.#ownerSessionId;
	}

	/**
	 * Index the exact per-item executions of one task acknowledgement. Each execution stands alone: a malformed or
	 * foreign entry is skipped, never allowed to suppress a valid sibling. The caller may observe the acknowledgement
	 * before the spawn hook admits the handle; `confirm` requires the admission later.
	 */
	observeTaskAck(input: DirectorTaskAckInput): void {
		const runId = safeToken(input.runId);
		const toolCallId = safeToken(input.toolCallId);
		const details = input.details;
		if (runId === undefined || toolCallId === undefined) return;
		this.beginRun(runId);
		if (!isRecord(details) || !isRecord(details.async) || !Array.isArray(details.async.executions)) return;
		for (const raw of details.async.executions) {
			const proof = executionProof(raw, input.owners);
			if (proof === undefined) continue;
			if (!this.#claimOwner(proof.ownerSessionId)) continue;
			const placement = input.placement(proof.agentId);
			// The outer call and the item's original position are the exact placement identity. A call id that does
			// not name this item's placement is a different execution, not a useful hint.
			if (placement === undefined || placement.callId !== toolCallId || placement.itemIndex !== proof.itemIndex) continue;
			this.#merge(proof, { toolCallId });
		}
	}

	/**
	 * Index the terminal rows of one native wait snapshot. Only an exact `op:"wait"` envelope, a terminal task status,
	 * the row's own job/handle identity and an admitted placement are kept. The row's start (when the host supplied
	 * both fields) is the only discriminator a reused job id can use.
	 */
	observeWait(input: DirectorWaitInput): void {
		const runId = safeToken(input.runId);
		const details = input.details;
		if (runId === undefined) return;
		this.beginRun(runId);
		if (!isRecord(details) || details.op !== "wait" || !Array.isArray(details.jobs)) return;
		for (const raw of details.jobs) {
			if (!isRecord(raw) || raw.type !== "task") continue;
			const proof = executionProof(raw.execution, input.owners);
			if (proof === undefined) continue;
			if (!this.#claimOwner(proof.ownerSessionId)) continue;
			if (safeToken(raw.id) !== proof.jobId) continue;
			const rowAgent = safeToken(raw.agentUrlId) ?? safeToken(raw.agentId);
			if (rowAgent !== proof.agentId) continue;
			if (typeof raw.status !== "string" || TERMINAL_STATUS[raw.status] !== true) continue;
			const placement = input.placement(proof.agentId);
			if (placement === undefined || !placement.admitted || placement.itemIndex !== proof.itemIndex) continue;
			const start = waitStart(raw);
			this.#merge(proof, { terminal: true, ...(start === undefined ? {} : { start }) });
		}
	}

	/**
	 * Confirm one projection proof against this request's exact ledger facts. A task acknowledgement or a terminal wait
	 * row supplies the execution token; the placement, result row and recorded delivery are read now, never remembered
	 * from the carrier. Undefined keeps the original message whole.
	 */
	confirm(proof: DirectorDeliveryProof, request: DirectorDeliveryRequest): DirectorRetainedDelivery | undefined {
		if (this.#runId !== request.runId || this.#ownerSessionId !== request.ownerSessionId) return undefined;
		const entry = this.#entries.get(proof.executionToken);
		if (entry === undefined || entry.conflict === true) return undefined;
		if (
			entry.runId !== request.runId ||
			entry.ownerSessionId !== proof.ownerSessionId ||
			entry.jobId !== proof.jobId ||
			entry.agentId !== proof.agentId ||
			entry.itemIndex !== proof.itemIndex ||
			entry.executionToken !== proof.executionToken
		) {
			return undefined;
		}
		const placement = request.placement(proof.agentId);
		if (placement === undefined || !placement.admitted || placement.itemIndex !== proof.itemIndex) return undefined;
		// An acknowledged execution is tied to its outer task call. A wait-only witness has no outer call of its own,
		// so the current placement's exact call still says which task item this execution belongs to.
		if (entry.toolCallId !== undefined && placement.callId !== entry.toolCallId) return undefined;
		if (entry.toolCallId === undefined && (entry.terminal !== true || placement.callId === undefined)) return undefined;
		return this.#retained(entry, request, placement);
	}

	/** The exact persisted attempt behind the proof, or the run's recorded delivery when it declared no result. */
	#retained(
		entry: DeliveryEntry,
		request: DirectorDeliveryRequest,
		placement: DirectorDeliveryPlacement,
	): DirectorRetainedDelivery | undefined {
		const plain = asyncAttemptId(entry.jobId, entry.agentId);
		if (plain === undefined) return undefined;
		const stamped = entry.start === undefined ? undefined : asyncAttemptId(entry.jobId, entry.agentId, entry.start);
		const multiple = this.#tokenCount(entry.jobId, entry.agentId) > 1;
		if (placement.lane !== undefined) {
			const attemptIds = new Set<string>();
			for (const row of request.attempts) {
				if (row.lane !== placement.lane) continue;
				if (row.attemptId === plain || (stamped !== undefined && row.attemptId === stamped)) attemptIds.add(row.attemptId);
			}
			if (attemptIds.size > 0) {
				const chosen = chooseAttempt(attemptIds, plain, stamped, multiple);
				if (chosen === undefined) return undefined;
				let unresolved = 0;
				for (const row of request.attempts) {
					if (row.attemptId !== chosen) continue;
					if (row.state === "accepted" || row.scope === "excluded-by-user") continue;
					unresolved += 1;
					if (!Number.isSafeInteger(unresolved)) return undefined;
				}
				return { inspect: chosen, unresolved };
			}
		}
		// A lane with no declared result, or a plan-less placement, persists a delivery record instead of result rows.
		const deliveryIds = new Set<string>();
		for (const record of request.unplanned) {
			if (record.agent !== entry.agentId) continue;
			if (placement.lane === undefined ? record.lane !== undefined : record.lane !== placement.lane) continue;
			if (record.status === undefined || TERMINAL_STATUS[record.status] !== true) continue;
			if (record.id === plain || (stamped !== undefined && record.id === stamped)) deliveryIds.add(record.id);
		}
		const chosen = chooseAttempt(deliveryIds, plain, stamped, multiple);
		return chosen === undefined ? undefined : { inspect: chosen, unresolved: 0 };
	}

	/**
	 * Distinct acknowledged/terminal tokens this run has observed for one job id and handle. A conflicting token still
	 * counts: two witnesses disagreed, so a plain attempt id must stay ambiguous.
	 */
	#tokenCount(jobId: string, agentId: string): number {
		const seen = new Set<string>();
		for (const entry of this.#entries.values()) {
			if (entry.jobId !== jobId || entry.agentId !== agentId) continue;
			seen.add(entry.executionToken);
			if (seen.size > 1) return seen.size;
		}
		return seen.size;
	}

	#claimOwner(ownerSessionId: string): boolean {
		if (this.#ownerSessionId === undefined) this.#ownerSessionId = ownerSessionId;
		return this.#ownerSessionId === ownerSessionId;
	}

	/** Merge one exact witness of a token. Disagreement poisons the token rather than letting a later witness win. */
	#merge(proof: ParsedProof, claim: { toolCallId?: string; terminal?: true; start?: number }): void {
		const runId = this.#runId;
		if (runId === undefined) return;
		const existing = this.#entries.get(proof.executionToken);
		if (existing === undefined) {
			const entry: DeliveryEntry = {
				...proof,
				runId,
				...(claim.toolCallId === undefined ? {} : { toolCallId: claim.toolCallId }),
				...(claim.terminal === undefined ? {} : { terminal: true }),
				...(claim.start === undefined ? {} : { start: claim.start }),
			};
			this.#entries.set(proof.executionToken, entry);
			if (this.#entries.size > DIRECTOR_DELIVERY_INDEX_MAX) {
				const oldest = this.#entries.keys().next().value;
				if (oldest !== undefined) this.#entries.delete(oldest);
			}
			return;
		}
		if (existing.conflict === true) return;
		if (
			existing.runId !== this.#runId ||
			existing.ownerSessionId !== proof.ownerSessionId ||
			existing.jobId !== proof.jobId ||
			existing.agentId !== proof.agentId ||
			existing.itemIndex !== proof.itemIndex ||
			existing.executionToken !== proof.executionToken
		) {
			existing.conflict = true;
			return;
		}
		if (claim.toolCallId !== undefined) {
			if (existing.toolCallId !== undefined && existing.toolCallId !== claim.toolCallId) {
				existing.conflict = true;
				return;
			}
			existing.toolCallId = claim.toolCallId;
		}
		if (claim.terminal === true) existing.terminal = true;
		if (claim.start !== undefined) {
			if (existing.start !== undefined && existing.start !== claim.start) {
				existing.conflict = true;
				return;
			}
			existing.start = claim.start;
		}
	}
}

/**
 * Pick the one exact attempt id among the persisted rows. A plain attempt id (`job:<job>:<agent>`) is ambiguous once
 * this run observed more than one token for the job/handle; a terminal wait row's start stamp resolves it. When both
 * plain and stamped rows exist, the stamped one is the later execution.
 */
function chooseAttempt(ids: ReadonlySet<string>, plain: string, stamped: string | undefined, multiple: boolean): string | undefined {
	if (ids.size === 0) return undefined;
	if (multiple) {
		if (stamped === undefined || !ids.has(stamped)) return undefined;
		return stamped;
	}
	if (stamped !== undefined && ids.has(stamped)) return stamped;
	return ids.has(plain) ? plain : undefined;
}

/**
 * Present the host's own revision-1 `execution` proof as the projection's `proof` field without mutating the message.
 * Only a per-job execution is attached: a message that already has a proof, or a job that already carries one, stays
 * exactly as it was. The returned map identifies every proxy so a kept (foreign/mixed/unconfirmed) proxy can be
 * replaced by its original message before it reaches the provider.
 */
export function withHostExecutionProofs<Message>(messages: readonly Message[]): {
	readonly messages: Message[];
	readonly originals: ReadonlyMap<Message, Message>;
} {
	const originals = new Map<Message, Message>();
	const output: Message[] = [];
	for (const message of messages) {
		let proxy: Message | undefined;
		try {
			proxy = proxyWithProofs(message);
		} catch {
			proxy = undefined;
		}
		if (proxy === undefined) {
			output.push(message);
			continue;
		}
		originals.set(proxy, message);
		output.push(proxy);
	}
	return { messages: output, originals };
}

function proxyWithProofs<Message>(message: Message): Message | undefined {
	if (!isRecord(message) || message.customType !== "async-result" || Object.hasOwn(message, "proof")) return undefined;
	const details = message.details;
	if (!isRecord(details) || !Array.isArray(details.jobs) || details.jobs.length === 0) return undefined;
	let jobs: unknown[] | undefined;
	for (let at = 0; at < details.jobs.length; at++) {
		const job = details.jobs[at];
		if (!isRecord(job) || Object.hasOwn(job, "proof")) continue;
		const execution = job.execution;
		if (execution === undefined) continue;
		jobs ??= [...details.jobs];
		jobs[at] = { ...job, proof: execution };
	}
	if (jobs === undefined) return undefined;
	return { ...message, details: { ...details, jobs } } as Message;
}
