/**
 * Native proof index behind the director provider-context projection. These tests use the host's additive revision-1
 * `execution` shape structurally: one exact task acknowledgement, an optional terminal wait row and persisted run
 * facts. They pin the join the extension relies on: exact native owner, outer call, original item/handle placement,
 * single execution token, bounded state and an exact persisted attempt/delivery handle.
 */
import { describe, expect, test } from "bun:test";
import { isRecord } from "../src/config/schema.ts";
import {
	DIRECTOR_DELIVERY_INDEX_MAX,
	DirectorDeliveryIndex,
	withHostExecutionProofs,
	type DirectorDeliveryPlacement,
	type DirectorDeliveryRequest,
} from "../src/runtime/director-delivery.ts";
import type { DirectorDeliveryProof } from "../src/runtime/director-context.ts";

const OWNER = "session-owner-1";
const RUN = "run-1";
const CALL = "call-1";

function proof(overrides: Partial<DirectorDeliveryProof> = {}): DirectorDeliveryProof {
	return {
		revision: 1,
		jobId: "job-1",
		type: "task",
		executionToken: "token-1",
		agentId: "agent-1",
		itemIndex: 0,
		ownerSessionId: OWNER,
		...overrides,
	};
}

function place(overrides: Partial<DirectorDeliveryPlacement> = {}): DirectorDeliveryPlacement {
	return { admitted: true, callId: CALL, itemIndex: 0, lane: "look", ...overrides };
}

/** An unplanned placement: exact call and item, no lane. */
const RESULTLESS: DirectorDeliveryPlacement = { admitted: true, callId: CALL, itemIndex: 0 };

function ack(proofs: readonly DirectorDeliveryProof[], state = "running"): Record<string, unknown> {
	return { async: { state, jobId: proofs[0]?.jobId, type: "task", executions: proofs } };
}

function waitRow(rowProof: DirectorDeliveryProof, overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		op: "wait",
		jobs: [
			{
				id: rowProof.jobId,
				type: "task",
				status: "completed",
				agentUrlId: rowProof.agentId,
				execution: rowProof,
				settledAtMs: 5_000,
				durationMs: 1_000,
				...overrides,
			},
		],
	};
}

function request(overrides: Partial<DirectorDeliveryRequest> = {}): DirectorDeliveryRequest {
	return {
		runId: RUN,
		ownerSessionId: OWNER,
		placement: () => place(),
		attempts: [{ attemptId: `job:job-1:agent-1`, state: "unmet", lane: "look" }],
		unplanned: [],
		...overrides,
	};
}

function observeAck(index: DirectorDeliveryIndex, value: DirectorDeliveryProof, toolCallId = CALL, placement = place()): void {
	index.observeTaskAck({
		runId: RUN,
		owners: [OWNER],
		toolCallId,
		details: ack([value]),
		placement: () => placement,
	});
}

describe("typed task acknowledgement indexing", () => {
	test("the exact owner, outer call and original item/handle confirm a planned attempt", () => {
		const index = new DirectorDeliveryIndex();
		const delivered = proof();
		observeAck(index, delivered);
		expect(index.owner()).toBe(OWNER);
		expect(index.confirm(delivered, request())).toEqual({
			inspect: "job:job-1:agent-1",
			unresolved: 1,
		});
		// The exact persisted row and count are read now, not from the acknowledgement.
		expect(index.confirm(delivered, request({
			attempts: [
				{ attemptId: "job:job-1:agent-1", state: "accepted", lane: "look" },
				{ attemptId: "job:job-1:agent-1", state: "reviewable", lane: "look" },
			],
		}))).toEqual({ inspect: "job:job-1:agent-1", unresolved: 1 });
	});

	test("a foreign owner, wrong outer call, wrong item or stock shape indexes nothing", () => {
		const cases: Array<{ proof: DirectorDeliveryProof; placement: DirectorDeliveryPlacement; toolCallId: string }> = [
			{ proof: proof({ ownerSessionId: "foreign" }), placement: place(), toolCallId: CALL },
			{ proof: proof(), placement: place({ callId: "call-other" }), toolCallId: CALL },
			{ proof: proof({ itemIndex: 1 }), placement: place(), toolCallId: CALL },
			{ proof: proof(), placement: place({ itemIndex: 1 }), toolCallId: CALL },
		];
		for (const value of cases) {
			const index = new DirectorDeliveryIndex();
			observeAck(index, value.proof, value.toolCallId, value.placement);
			expect(index.owner()).toBeUndefined();
			expect(index.confirm(value.proof, request())).toBeUndefined();
		}
		const malformed = new DirectorDeliveryIndex();
		malformed.observeTaskAck({ runId: RUN, owners: [OWNER], toolCallId: CALL, details: { progress: [] }, placement: () => place() });
		expect(malformed.owner()).toBeUndefined();
	});

	test("the confirmation re-reads the placement: a handle that was never admitted or moved items fails", () => {
		const index = new DirectorDeliveryIndex();
		const delivered = proof();
		observeAck(index, delivered);
		expect(index.confirm(delivered, request({ placement: () => place({ admitted: false }) }))).toBeUndefined();
		expect(index.confirm(delivered, request({ placement: () => place({ itemIndex: 1 }) }))).toBeUndefined();
		expect(index.confirm(delivered, request({ placement: () => undefined }))).toBeUndefined();
	});

	test("a malformed or foreign execution does not suppress a valid sibling", () => {
		const index = new DirectorDeliveryIndex();
		const delivered = proof();
		index.observeTaskAck({
			runId: RUN,
			owners: [OWNER],
			toolCallId: CALL,
			details: ack([proof({ executionToken: "" }), proof({ ownerSessionId: "foreign" }), delivered]),
			placement: () => place(),
		});
		expect(index.confirm(delivered, request())).not.toBeUndefined();
	});
});

describe("terminal wait facts and reused job ids", () => {
	test("a wait row's own start resolves a stamped attempt; without it a plain id is ambiguous", () => {
		const index = new DirectorDeliveryIndex();
		const first = proof({ executionToken: "token-first" });
		const second = proof({ executionToken: "token-second" });
		observeAck(index, first);
		observeAck(index, second);
		const stamped = `job:job-1.t4000:agent-1`;
		const facts = request({
			attempts: [
				{ attemptId: "job:job-1:agent-1", state: "accepted", lane: "look" },
				{ attemptId: stamped, state: "unmet", lane: "look" },
			],
		});
		expect(index.confirm(second, facts)).toBeUndefined();
		index.observeWait({ runId: RUN, owners: [OWNER], details: waitRow(second), placement: () => place() });
		expect(index.confirm(second, facts)).toEqual({ inspect: stamped, unresolved: 1 });
		expect(index.confirm(first, facts)).toBeUndefined();
	});

	test("a wait-only terminal fact confirms a recorded delivery for resultless work", () => {
		const index = new DirectorDeliveryIndex();
		const delivered = proof();
		index.observeWait({
			runId: RUN,
			owners: [OWNER],
			details: waitRow(delivered),
			placement: () => RESULTLESS,
		});
		const facts = request({
			placement: () => RESULTLESS,
			attempts: [],
			unplanned: [{ id: "job:job-1:agent-1", agent: "agent-1", status: "completed" }],
		});
		expect(index.confirm(delivered, facts)).toEqual({ inspect: "job:job-1:agent-1", unresolved: 0 });
		expect(index.confirm(delivered, request({ placement: () => RESULTLESS, attempts: [], unplanned: [] }))).toBeUndefined();
	});

	test("a resultless planned lane uses the run's recorded delivery for the same lane", () => {
		const index = new DirectorDeliveryIndex();
		const delivered = proof();
		index.observeWait({ runId: RUN, owners: [OWNER], details: waitRow(delivered), placement: () => place() });
		expect(index.confirm(delivered, request({
			attempts: [],
			unplanned: [{ id: "job:job-1:agent-1", agent: "agent-1", lane: "look", status: "completed" }],
		}))).toEqual({ inspect: "job:job-1:agent-1", unresolved: 0 });
		expect(index.confirm(delivered, request({
			attempts: [],
			unplanned: [{ id: "job:job-1:agent-1", agent: "agent-1", lane: "other", status: "completed" }],
		}))).toBeUndefined();
	});

	test("a nonterminal wait row, a different job/handle identity or a mismatched unplanned lane is not evidence", () => {
		const delivered = proof();
		const cases: Array<Record<string, unknown>> = [
			waitRow(delivered, { status: "running" }),
			waitRow(delivered, { id: "other-job" }),
			waitRow(delivered, { agentUrlId: "other-agent", agentId: undefined }),
		];
		for (const details of cases) {
			const index = new DirectorDeliveryIndex();
			index.observeWait({ runId: RUN, owners: [OWNER], details, placement: () => RESULTLESS });
			expect(index.confirm(delivered, request({ placement: () => RESULTLESS, attempts: [], unplanned: [
				{ id: "job:job-1:agent-1", agent: "agent-1", status: "completed" },
			] }))).toBeUndefined();
		}
		const index = new DirectorDeliveryIndex();
		index.observeWait({ runId: RUN, owners: [OWNER], details: waitRow(delivered), placement: () => place({ lane: "look" }) });
		expect(index.confirm(delivered, request({
			attempts: [],
			unplanned: [{ id: "job:job-1:agent-1", agent: "agent-1", status: "completed" }],
		}))).toBeUndefined();
	});
});

describe("conflicts, scope and bounds", () => {
	test("two witnesses that disagree about the same token poison it", () => {
		const index = new DirectorDeliveryIndex();
		const delivered = proof();
		const conflicting = proof({ jobId: "other-job" });
		observeAck(index, delivered);
		observeAck(index, conflicting, CALL, place({ callId: CALL }));
		expect(index.confirm(delivered, request())).toBeUndefined();
	});

	test("reset and a different run start empty", () => {
		const index = new DirectorDeliveryIndex();
		const delivered = proof();
		observeAck(index, delivered);
		index.reset();
		expect(index.owner()).toBeUndefined();
		expect(index.confirm(delivered, request())).toBeUndefined();
		observeAck(index, delivered);
		index.beginRun("run-2");
		expect(index.owner()).toBeUndefined();
		expect(index.confirm(delivered, request())).toBeUndefined();
	});

	test("the key set is bounded and the oldest token fails closed", () => {
		const index = new DirectorDeliveryIndex();
		const first = proof({ executionToken: "token-0", agentId: "agent-0", jobId: "job-0" });
		observeAck(index, first, "call-0", place({ callId: "call-0" }));
		for (let at = 1; at <= DIRECTOR_DELIVERY_INDEX_MAX; at++) {
			const value = proof({ executionToken: `token-${at}`, agentId: `agent-${at}`, jobId: `job-${at}` });
			observeAck(index, value, `call-${at}`, place({ callId: `call-${at}` }));
		}
		const last = proof({ executionToken: `token-${DIRECTOR_DELIVERY_INDEX_MAX}`, agentId: `agent-${DIRECTOR_DELIVERY_INDEX_MAX}`, jobId: `job-${DIRECTOR_DELIVERY_INDEX_MAX}` });
		const facts = request({
			placement: () => place({ callId: `call-${DIRECTOR_DELIVERY_INDEX_MAX}` }),
			attempts: [{ attemptId: `job:job-${DIRECTOR_DELIVERY_INDEX_MAX}:agent-${DIRECTOR_DELIVERY_INDEX_MAX}`, state: "accepted", lane: "look" }],
		});
		expect(index.confirm(first, request({ attempts: [{ attemptId: "job:job-0:agent-0", state: "accepted", lane: "look" }] }))).toBeUndefined();
		expect(index.confirm(last, facts)).toEqual({ inspect: `job:job-${DIRECTOR_DELIVERY_INDEX_MAX}:agent-${DIRECTOR_DELIVERY_INDEX_MAX}`, unresolved: 0 });
	});
});

describe("provider message proxies", () => {
	const execution = proof();
	const delivery = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
		role: "custom",
		customType: "async-result",
		content: [{ type: "text", text: "SECRET BODY" }],
		details: { jobs: [{ jobId: "job-1", agentId: "agent-1", status: "completed", execution }] },
		timestamp: 7,
		...overrides,
	});

	test("the host execution is presented as a proof on a fresh message; the source is untouched", () => {
		const source = delivery();
		const before = JSON.stringify(source);
		const prepared = withHostExecutionProofs([source]);
		const proxy = prepared.messages[0];
		expect(proxy).not.toBe(source);
		expect(prepared.originals.get(proxy)).toBe(source);
		if (proxy === undefined || !isRecord(proxy)) throw new Error("no proxy message");
		const details = proxy.details;
		if (!isRecord(details) || !Array.isArray(details.jobs)) throw new Error("no proxy jobs");
		const job = details.jobs[0];
		if (!isRecord(job)) throw new Error("no proxy job");
		expect(job.proof).toBe(execution);
		expect(job.execution).toBe(execution);
		expect(JSON.stringify(source)).toBe(before);
	});

	test("an existing proof, no execution or a non-delivery message keeps the exact object", () => {
		const existing = delivery({ proof: proof() });
		const noExecution = delivery({ details: { jobs: [{ jobId: "job-1", agentId: "agent-1" }] } });
		const plain = { role: "user", content: "go on" };
		const prepared = withHostExecutionProofs([existing, noExecution, plain]);
		expect(prepared.messages[0]).toBe(existing);
		expect(prepared.messages[1]).toBe(noExecution);
		expect(prepared.messages[2]).toBe(plain);
		expect(prepared.originals.size).toBe(0);
	});

	test("only execution rows are proxied; a sibling row stays the same object", () => {
		const sibling = { jobId: "foreign", agentId: "foreign", status: "completed" };
		const source = delivery({ details: { jobs: [{ jobId: "job-1", agentId: "agent-1", execution }, sibling] } });
		const prepared = withHostExecutionProofs([source]);
		const proxy = prepared.messages[0];
		if (proxy === undefined || !isRecord(proxy)) throw new Error("no proxy message");
		const details = proxy.details;
		if (!isRecord(details) || !Array.isArray(details.jobs)) throw new Error("no proxy jobs");
		expect(details.jobs[1]).toBe(sibling);
		const job = details.jobs[0];
		if (!isRecord(job)) throw new Error("no execution job");
		expect(job.proof).toBe(execution);
	});
});
