/**
 * P5 director provider-context projection.
 *
 * These tests use the patched host's revision-1 proof shape structurally, never a real host package: a custom
 * `async-result` message carries one proof per `details.jobs[]` row (or one message-level proof for a single job). The
 * cases pin the caller contract: exact owner, trusted retained lookup, byte-identical foreign/mixed/unconfirmed
 * messages, one bounded model-only summary per request, exact counts, replay collapse, call/role preservation,
 * source immutability and the no-change array reference.
 */
import { describe, expect, test } from "bun:test";
import {
	DIRECTOR_HANDLE_MAX_CHARS,
	DIRECTOR_SUMMARY_MAX_BYTES,
	DIRECTOR_SUMMARY_MAX_HANDLES,
	type DirectorContextInput,
	type DirectorContextProjection,
	type DirectorDeliveryProof,
	type DirectorRetainedDelivery,
	projectDirectorContext,
} from "../src/runtime/director-context.ts";

const OWNER = "session-owner-1";
const FOREIGN_OWNER = "session-owner-2";

type FixtureMessage = Record<string, unknown>;

function proofAt(index: number, overrides: Partial<DirectorDeliveryProof> = {}): DirectorDeliveryProof {
	return {
		revision: 1,
		jobId: `job-${index}`,
		type: "task",
		executionToken: `exec-${index}`,
		agentId: `agent-${index}`,
		itemIndex: index,
		ownerSessionId: OWNER,
		...overrides,
	};
}

function delivery(
	proofs: readonly DirectorDeliveryProof[],
	options: { readonly content?: string; readonly proofAtMessage?: boolean; readonly timestamp?: number } = {},
): FixtureMessage {
	const proofAtMessage = options.proofAtMessage === true;
	const jobs = proofs.map(proof => ({
		jobId: proof.jobId,
		type: proof.type,
		status: "completed",
		agentId: proof.agentId,
		resultText: `SECRET BODY ${proof.executionToken}`,
		...(proofAtMessage ? {} : { proof }),
	}));
	return {
		role: "custom",
		customType: "async-result",
		content: [{ type: "text", text: options.content ?? `delivery body ${proofs.map(proof => proof.executionToken).join(",")}` }],
		details: { meta: { source: { type: "report", value: "background job delivery" } }, jobs },
		display: true,
		attribution: "agent",
		timestamp: options.timestamp ?? 1_000,
		...(proofAtMessage && proofs[0] !== undefined ? { proof: proofs[0] } : {}),
	};
}

const userMessage = (text = "go on"): FixtureMessage => ({ role: "user", content: text, timestamp: 1 });
const assistantToolCall = (id: string, toolCallId = `call-${id}`): FixtureMessage => ({
	role: "assistant",
	content: [{ type: "toolCall", id: toolCallId, name: "task", arguments: {} }],
	timestamp: 2,
});
const toolResult = (toolCallId: string): FixtureMessage => ({
	role: "toolResult",
	toolCallId,
	toolName: "task",
	content: [{ type: "text", text: "spawned" }],
	isError: false,
	timestamp: 3,
});
const foreignDelivery = (text = "FOREIGN BODY"): FixtureMessage => ({
	role: "custom",
	customType: "async-result",
	content: [{ type: "text", text }],
	details: { jobs: [{ jobId: "foreign-job", type: "task", status: "completed", agentId: "foreign-agent" }] },
	display: true,
	attribution: "agent",
	timestamp: 4,
});

const retained = (inspect: string, unresolved = 0): DirectorRetainedDelivery => ({ inspect, unresolved });
const confirmAll = (unresolved = 0) => (proof: DirectorDeliveryProof): DirectorRetainedDelivery =>
	retained(`agent://${proof.agentId}`, unresolved);

function textOf(message: unknown): string {
	if (typeof message !== "object" || message === null || !("content" in message)) return "";
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map(part => (typeof part === "object" && part !== null && "text" in part && typeof part.text === "string" ? part.text : ""))
		.join("");
}

/** The fixture's own job-row array, validated once so tests never cast a member access. */
function jobsOf(message: FixtureMessage): Array<Record<string, unknown>> {
	const details = message.details;
	if (typeof details !== "object" || details === null || !("jobs" in details) || !Array.isArray(details.jobs)) {
		throw new Error("fixture message has no jobs array");
	}
	const jobs: unknown[] = details.jobs;
	if (!jobs.every(job => typeof job === "object" && job !== null && !Array.isArray(job))) {
		throw new Error("fixture job row is not an object");
	}
	return jobs as Array<Record<string, unknown>>;
}

/** Tool call ids of one assistant fixture, for the call/result pairing assertions. */
function toolCallIds(message: FixtureMessage | undefined): string[] {
	const content = message?.content;
	if (!Array.isArray(content)) return [];
	return content.flatMap(part =>
		typeof part === "object" && part !== null && "id" in part && typeof part.id === "string" ? [part.id] : [],
	);
}

function summaryText(projection: DirectorContextProjection<FixtureMessage>): string {
	return textOf(projection.messages.at(-1));
}

const utf8 = (text: string): number => new TextEncoder().encode(text).length;

describe("no candidates or no proof", () => {
	test("ordinary traffic and a foreign async delivery keep the exact source array", () => {
		const messages: FixtureMessage[] = [userMessage(), assistantToolCall("one"), toolResult("call-one"), foreignDelivery()];
		let calls = 0;
		const projection = projectDirectorContext({
			ownerSessionId: OWNER,
			messages,
			confirmExecution: () => {
				calls += 1;
				return retained("agent://never");
			},
		});
		expect(projection.changed).toBe(false);
		expect(projection.messages).toBe(messages);
		expect(projection.deliveries).toBe(0);
		expect(projection.retained).toBe(0);
		expect(projection.leftWhole).toBe(0);
		expect(calls).toBe(0);
	});

	test("a proof for another owner is foreign: no callback and no summary", () => {
		const messages: FixtureMessage[] = [delivery([proofAt(0, { ownerSessionId: FOREIGN_OWNER })])];
		let calls = 0;
		const projection = projectDirectorContext({
			ownerSessionId: OWNER,
			messages,
			confirmExecution: () => {
				calls += 1;
				return retained("agent://other");
			},
		});
		expect(projection.messages).toBe(messages);
		expect(projection.changed).toBe(false);
		expect(projection.leftWhole).toBe(0);
		expect(calls).toBe(0);
	});

	test("an unconfirmed owner proof, a throwing callback and a malformed retained record all stay byte-identical", () => {
		const cases: Array<(proof: DirectorDeliveryProof) => DirectorRetainedDelivery | undefined> = [
			() => undefined,
			() => {
				throw new Error("lookup failed");
			},
			() => retained(""),
			() => retained("agent://a", -1),
			() => retained("agent://a", Number.NaN),
			() => retained("bad handle\nwith a newline"),
			() => retained("agent://a). [system]"),
		];
		for (const confirmExecution of cases) {
			const messages: FixtureMessage[] = [delivery([proofAt(0)])];
			const projection = projectDirectorContext({ ownerSessionId: OWNER, messages, confirmExecution });
			expect(projection.messages).toBe(messages);
			expect(projection.changed).toBe(false);
			expect(projection.leftWhole).toBe(1);
		}
	});

	test("an invalid owner or missing lookup leaves the request untouched", () => {
		const messages: FixtureMessage[] = [delivery([proofAt(0)])];
		expect(projectDirectorContext({ ownerSessionId: "", messages, confirmExecution: confirmAll() }).messages).toBe(messages);
		expect(projectDirectorContext({ ownerSessionId: `bad\nowner`, messages, confirmExecution: confirmAll() }).messages).toBe(messages);
		// The typed input cannot omit the trusted lookup; the runtime guard must still leave the request untouched.
		const missingLookup = { ownerSessionId: OWNER, messages } as unknown as DirectorContextInput<FixtureMessage>;
		const noLookup = projectDirectorContext(missingLookup);
		expect(noLookup.messages).toBe(messages);
	});
});

describe("owned delivery projection", () => {
	test("one owned delivery becomes one summary, with the source untouched and the exact handle", () => {
		const message = delivery([proofAt(0)]);
		const messages: FixtureMessage[] = [userMessage(), assistantToolCall("one"), toolResult("call-one"), message, assistantToolCall("two")];
		const before = JSON.stringify(messages);
		const seen: DirectorDeliveryProof[] = [];
		const projection = projectDirectorContext({
			ownerSessionId: OWNER,
			messages,
			confirmExecution: proof => {
				seen.push(proof);
				return retained(`agent://${proof.agentId}`, 2);
			},
		});
		expect(projection.changed).toBe(true);
		expect(projection.deliveries).toBe(1);
		expect(projection.retained).toBe(1);
		expect(projection.replays).toBe(0);
		expect(projection.unresolved).toBe(2);
		expect(projection.leftWhole).toBe(0);
		expect(projection.listedHandles).toBe(1);
		expect(projection.omittedHandles).toBe(0);
		expect(seen).toHaveLength(1);
		expect(Object.isFrozen(seen[0])).toBe(true);
		expect(seen[0]).toEqual(proofAt(0));
		expect(projection.messages).not.toBe(messages);
		expect(projection.messages.slice(0, 3)).toEqual(messages.slice(0, 3));
		expect(projection.messages[0]).toBe(messages[0]);
		expect(projection.messages[1]).toBe(messages[1]);
		expect(projection.messages[2]).toBe(messages[2]);
		expect(projection.messages[3]).toBe(messages[4]);
		expect(projection.messages.at(-1)?.role).toBe("developer");
		const summary = summaryText(projection);
		expect(summary).toContain("agent://agent-0");
		expect(summary).toContain("배달 1건");
		expect(summary).toContain("시도 1개");
		expect(summary).toContain("미해결 2개");
		expect(summary).not.toContain("SECRET BODY");
		expect(summary).not.toContain("delivery body");
		expect(JSON.stringify(messages)).toBe(before);
	});

	test("a proof, not a label, row job id, timestamp or role, decides ownership", () => {
		const proof = proofAt(0);
		const message = delivery([proof]);
		const jobs = jobsOf(message);
		jobs[0]!.jobId = "a different current row id";
		jobs[0]!.agentId = "a different current row agent";
		message.role = "user";
		message.label = "NOT A STORM DELIVERY";
		message.timestamp = 999_999;
		const projection = projectDirectorContext({ ownerSessionId: OWNER, messages: [message], confirmExecution: confirmAll() });
		expect(projection.changed).toBe(true);
		expect(projection.retained).toBe(1);
		expect(summaryText(projection)).toContain("agent://agent-0");
	});

	test("a single message-level proof without a row proof is accepted; a different row proof is not", () => {
		const top = delivery([proofAt(0)], { proofAtMessage: true });
		const accepted = projectDirectorContext({ ownerSessionId: OWNER, messages: [top], confirmExecution: confirmAll() });
		expect(accepted.changed).toBe(true);

		const conflicting = delivery([proofAt(0)], { proofAtMessage: false });
		conflicting.proof = proofAt(1);
		const rejected = projectDirectorContext({ ownerSessionId: OWNER, messages: [conflicting], confirmExecution: confirmAll() });
		expect(rejected.messages).toEqual([conflicting]);
		expect(rejected.changed).toBe(false);
		expect(rejected.leftWhole).toBe(1);
	});

	test("a malformed proof is foreign: no callback, no summary and no ownership inference", () => {
		const invalid: Array<Record<string, unknown>> = [
			{ ...proofAt(0), revision: 2 },
			{ ...proofAt(0), type: "bash" },
			{ ...proofAt(0), executionToken: "" },
			{ ...proofAt(0), itemIndex: -1 },
			{ ...proofAt(0), jobId: "bad\njob" },
		];
		for (const proof of invalid) {
			const message: FixtureMessage = { ...foreignDelivery(), details: { jobs: [{ jobId: "row", type: "task", status: "completed", proof }] } };
			let calls = 0;
			const projection = projectDirectorContext({
				ownerSessionId: OWNER,
				messages: [message],
				confirmExecution: () => {
					calls += 1;
					return retained("agent://never");
				},
			});
			expect(projection.changed).toBe(false);
			expect(projection.messages[0]).toBe(message);
			expect(projection.leftWhole).toBe(0);
			expect(calls).toBe(0);
		}
	});

	test("a multi-job message-level proof has no exact segment boundary and stays whole", () => {
		const message = delivery([proofAt(0), proofAt(1)], { proofAtMessage: true });
		const projection = projectDirectorContext({ ownerSessionId: OWNER, messages: [message], confirmExecution: confirmAll() });
		expect(projection.messages).toHaveLength(1);
		expect(projection.messages[0]).toBe(message);
		expect(projection.changed).toBe(false);
		expect(projection.leftWhole).toBe(1);
	});
});

describe("foreign, mixed and unbound messages", () => {
	test("only fully owned messages collapse; a mixed message is not split", () => {
		const ownedA = delivery([proofAt(0)]);
		const ownedB = delivery([proofAt(1), proofAt(2)]);
		const mixed = delivery([proofAt(3)]);
		jobsOf(mixed).push({ jobId: "foreign-row", type: "task", status: "completed", agentId: "foreign-agent" });
		const unbound = delivery([proofAt(4)]);
		const foreign = foreignDelivery();
		const before = { mixed: JSON.stringify(mixed), foreign: JSON.stringify(foreign), unbound: JSON.stringify(unbound) };
		const messages: FixtureMessage[] = [userMessage(), foreign, ownedA, mixed, ownedB, unbound];
		const calls: string[] = [];
		const projection = projectDirectorContext({
			ownerSessionId: OWNER,
			messages,
			confirmExecution: proof => {
				calls.push(proof.executionToken);
				if (proof.executionToken === "exec-4") return undefined;
				return retained(`agent://${proof.agentId}`, 0);
			},
		});
		expect(projection.changed).toBe(true);
		expect(projection.deliveries).toBe(2);
		expect(projection.retained).toBe(3);
		expect(projection.leftWhole).toBe(2);
		expect(calls.sort()).toEqual(["exec-0", "exec-1", "exec-2", "exec-4"]);
		expect(projection.messages).toContain(foreign);
		expect(projection.messages).toContain(mixed);
		expect(projection.messages).toContain(unbound);
		expect(JSON.stringify(mixed)).toBe(before.mixed);
		expect(JSON.stringify(foreign)).toBe(before.foreign);
		expect(JSON.stringify(unbound)).toBe(before.unbound);
		expect(projection.messages).not.toContain(ownedA);
		expect(projection.messages).not.toContain(ownedB);
		const summary = summaryText(projection);
		expect(summary).toContain("원문을 그대로 둔 배달 2건");
		expect(summary).toContain("agent://agent-0");
		expect(summary).toContain("agent://agent-2");
		expect(summary).not.toContain("agent://agent-3");
		expect(summary).not.toContain("agent://agent-4");
	});
});

describe("bound and scale", () => {
	test("100 active deliveries, mixed/foreign/unbound rows and 20 replays collapse to one bounded summary", () => {
		const active = Array.from({ length: 100 }, (_, index) => delivery([proofAt(index)], { content: `ACTIVE BODY ${index} ${"x".repeat(400)}` }));
		const replays = Array.from({ length: 20 }, (_, index) => delivery([proofAt(index % 10)], { content: `REPLAY BODY ${index}` }));
		const mixed = delivery([proofAt(200)]);
		jobsOf(mixed).push({ jobId: "foreign-row", type: "task", status: "completed" });
		const unbound = delivery([proofAt(201)]);
		const foreign = foreignDelivery();
		const messages: FixtureMessage[] = [
			userMessage(),
			assistantToolCall("batch", "call-batch"),
			...active,
			mixed,
			foreign,
			...replays,
			toolResult("call-batch"),
			unbound,
			assistantToolCall("tail", "call-tail"),
		];
		const source = JSON.stringify(messages);
		const calls: DirectorDeliveryProof[] = [];
		const projection = projectDirectorContext({
			ownerSessionId: OWNER,
			messages,
			inspectAll: "history://run-1",
			confirmExecution: proof => {
				calls.push(proof);
				if (proof.executionToken === "exec-201") return undefined;
				const index = Number(proof.executionToken.slice("exec-".length));
				// Long, unique persisted handles force the byte and handle bounds in the same batch.
				return retained(`agent://${index}-${"h".repeat(120)}`, index % 3);
			},
		});
		expect(projection.changed).toBe(true);
		expect(projection.deliveries).toBe(120);
		expect(projection.retained).toBe(100);
		expect(projection.replays).toBe(20);
		expect(projection.unresolved).toBe(99);
		expect(projection.leftWhole).toBe(2);
		expect(calls).toHaveLength(101);
		expect(calls.every(proof => Object.isFrozen(proof))).toBe(true);
		expect(projection.listedHandles).toBeGreaterThan(0);
		expect(projection.listedHandles).toBeLessThanOrEqual(DIRECTOR_SUMMARY_MAX_HANDLES);
		expect(projection.listedHandles + projection.omittedHandles).toBe(100);
		expect(projection.omittedHandles).toBeGreaterThan(0);
		const summary = summaryText(projection);
		expect(utf8(summary)).toBeLessThanOrEqual(DIRECTOR_SUMMARY_MAX_BYTES);
		expect(summary).toContain("배달 120건");
		expect(summary).toContain("시도 100개");
		expect(summary).toContain("재전송 20건");
		expect(summary).toContain("미해결 99개");
		expect(summary).toContain(`외 ${projection.omittedHandles}개(전체 history://run-1)`);
		expect(summary).not.toContain("ACTIVE BODY");
		expect(summary).not.toContain("REPLAY BODY");
		expect(summary).not.toContain("SECRET BODY");
		expect(summary).not.toContain("accepted");
		expect(summary).not.toContain("completed");
		// Only the summary was added; every foreign/mixed/unbound message and every role/call pair is still in place.
		expect(projection.messages).toHaveLength(messages.length - 120 + 1);
		expect(projection.messages.at(-1)?.role).toBe("developer");
		expect(projection.messages[0]).toBe(messages[0]);
		expect(projection.messages[1]).toBe(messages[1]);
		expect(projection.messages).toContain(mixed);
		expect(projection.messages).toContain(foreign);
		expect(projection.messages).toContain(unbound);
		const collapsed = [...active, ...replays];
		const expectedKept = messages.filter(message => !collapsed.includes(message));
		expect(projection.messages).toHaveLength(expectedKept.length + 1);
		expect(projection.messages.slice(0, -1).every((message, index) => message === expectedKept[index])).toBe(true);
		const originalTool = messages.findIndex(message => message.toolCallId === "call-batch");
		const projectedTool = projection.messages.findIndex(message => message.toolCallId === "call-batch");
		expect(originalTool).toBeGreaterThan(0);
		expect(projectedTool).toBeGreaterThan(0);
		expect(projection.messages[projectedTool]).toBe(messages[originalTool]);
		const projectedAssistant = projection.messages.indexOf(messages[1]!);
		expect(projectedAssistant).toBeGreaterThan(0);
		expect(projectedTool).toBeGreaterThan(projectedAssistant);
		expect(messages[originalTool]?.toolCallId).toBe("call-batch");
		expect(toolCallIds(projection.messages[projectedAssistant])).toEqual(["call-batch"]);
		expect(JSON.stringify(messages)).toBe(source);
	});

	test("the handle count is bounded even when the handles are short", () => {
		const messages = Array.from({ length: 100 }, (_, index) => delivery([proofAt(index)]));
		const projection = projectDirectorContext({
			ownerSessionId: OWNER,
			messages,
			inspectAll: "history://run-2",
			confirmExecution: proof => retained(`agent://a${proof.executionToken}`, 0),
		});
		expect(projection.listedHandles).toBe(DIRECTOR_SUMMARY_MAX_HANDLES);
		expect(projection.omittedHandles).toBe(100 - DIRECTOR_SUMMARY_MAX_HANDLES);
		const summary = summaryText(projection);
		expect(summary).toContain(`외 ${100 - DIRECTOR_SUMMARY_MAX_HANDLES}개(전체 history://run-2)`);
		expect(utf8(summary)).toBeLessThanOrEqual(DIRECTOR_SUMMARY_MAX_BYTES);
	});

	test("omitted handles without an exact run handle keep every owned delivery whole", () => {
		const messages = Array.from({ length: DIRECTOR_SUMMARY_MAX_HANDLES + 1 }, (_, index) => delivery([proofAt(index)]));
		const projection = projectDirectorContext({
			ownerSessionId: OWNER,
			messages,
			confirmExecution: proof => retained(`agent://a${proof.executionToken}`, 0),
		});
		expect(projection.changed).toBe(false);
		expect(projection.messages).toBe(messages);
		expect(projection.leftWhole).toBe(messages.length);
		expect(projection.listedHandles).toBe(0);
		expect(projection.omittedHandles).toBe(0);
	});

	test("a long but valid handle is still named within the byte bound", () => {
		const handle = `agent://${"h".repeat(DIRECTOR_HANDLE_MAX_CHARS - "agent://".length)}`;
		const projection = projectDirectorContext({
			ownerSessionId: OWNER,
			messages: [delivery([proofAt(0)])],
			confirmExecution: () => retained(handle, 0),
		});
		expect(projection.changed).toBe(true);
		expect(projection.listedHandles).toBe(1);
		expect(projection.omittedHandles).toBe(0);
		expect(summaryText(projection)).toContain(handle);
	});
});

describe("purity and exact provider shape", () => {
	test("input messages are not mutated, even when frozen", () => {
		const message = Object.freeze(delivery([proofAt(0)]));
		const messages: FixtureMessage[] = [Object.freeze(userMessage()), message];
		const projection = projectDirectorContext({ ownerSessionId: OWNER, messages, confirmExecution: confirmAll() });
		expect(projection.changed).toBe(true);
		expect(projection.messages).toHaveLength(2);
		expect(projection.messages[0]).toBe(messages[0]);
		expect(projection.messages.at(-1)?.role).toBe("developer");
	});

	test("the summary is deterministic and carries no accepted/completion state", () => {
		const messages: FixtureMessage[] = [delivery([proofAt(0)])];
		const first = projectDirectorContext({ ownerSessionId: OWNER, messages, confirmExecution: confirmAll(3) });
		const second = projectDirectorContext({ ownerSessionId: OWNER, messages, confirmExecution: confirmAll(3) });
		expect(summaryText(second)).toBe(summaryText(first));
		const summary = summaryText(first);
		expect(summary).toContain("미해결 3개");
		expect(summary).toContain("수용이나 완료 판정이 아닙니다");
		expect(summary).not.toContain("status");
		expect(summary).not.toContain("resultText");
		expect(summary).not.toContain("SECRET BODY");
	});
});
