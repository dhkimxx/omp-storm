/** The pure decisions behind R15: what a worker may call after the limit, and whether its next request may be sent. */
import { describe, expect, test } from "bun:test";
import {
	SPEND_CLOSED_LEAD,
	SPEND_SEND_REASON,
	SPEND_SPAWN_REASON,
	SPEND_TAG,
	SPEND_UNKNOWN_TAG,
	SPEND_USER_STOP_WORD,
	spendRequestStop,
	spendStopNotice,
	spendToolRefusal,
	type SpendCloseRead,
} from "../src/policy/spend-close.ts";

const OPEN: SpendCloseRead = { kind: "open" };
const CLOSED_BLOCK: SpendCloseRead = { kind: "closed", close: { at: 1_800_000_000_000, onExceed: "block-spawns" } };
const CLOSED_STOP: SpendCloseRead = { kind: "closed", close: { at: 1_800_000_000_000, onExceed: "stop" } };
const UNKNOWN: SpendCloseRead = { kind: "unknown", reason: "test marker is unreadable" };

/** A `write` call as the host delivers it. */
const write = (path: string) => ({ toolName: "write", input: { path, content: "message" } });

describe("a run whose spend is not closed", () => {
	test("leaves every call and every request to the lane policy", () => {
		for (const call of [write("agent://Impl"), write("agent://Impl?progress"), { toolName: "task", input: {} }, { toolName: "read", input: { path: "a.ts" } }]) {
			expect(spendToolRefusal(OPEN, call)).toBeUndefined();
		}
		expect(spendRequestStop(OPEN, "Impl")).toEqual({ stop: false });
	});
});

describe("under block-spawns", () => {
	test("a work send to another agent is refused and a quiet progress note passes", () => {
		const refused = spendToolRefusal(CLOSED_BLOCK, write("agent://Impl"));
		expect(refused).toMatchObject({ code: "spend" });
		expect(refused?.reason.startsWith(SPEND_TAG)).toBe(true);
		expect(refused?.reason).toContain(SPEND_SEND_REASON);
		// omp parses the flag, so any spelling it accepts is a quiet note.
		expect(spendToolRefusal(CLOSED_BLOCK, write("agent://Impl?progress"))).toBeUndefined();
		// An address is read the way omp reads it: a control write is a send, whatever its spelling.
		expect(spendToolRefusal(CLOSED_BLOCK, write("Agent://Impl/%6Dodel"))).toMatchObject({ code: "spend" });
	});

	test("a nested spawn is refused; reads, notes and the worker's own work are not", () => {
		const spawned = spendToolRefusal(CLOSED_BLOCK, { toolName: "task", input: { tasks: [] } });
		expect(spawned).toMatchObject({ code: "spend" });
		expect(spawned?.reason).toContain(SPEND_SPAWN_REASON);
		expect(spendToolRefusal(CLOSED_BLOCK, { toolName: "read", input: { path: "a.ts" } })).toBeUndefined();
		expect(spendToolRefusal(CLOSED_BLOCK, { toolName: "grep", input: { pattern: "x" } })).toBeUndefined();
		expect(spendToolRefusal(CLOSED_BLOCK, write("local://note.md"))).toBeUndefined();
		expect(spendToolRefusal(CLOSED_BLOCK, { toolName: "yield", input: {} })).toBeUndefined();
	});

	test("a turn that is already running is not cut: its next request is not aborted", () => {
		expect(spendRequestStop(CLOSED_BLOCK, "Impl")).toEqual({ stop: false });
	});
});

describe("under stop", () => {
	test("every tool but yield is refused", () => {
		for (const toolName of ["read", "grep", "bash", "eval", "task", "write", "ask", "edit"]) {
			const refused = spendToolRefusal(CLOSED_STOP, { toolName, input: { path: "agent://Impl" } });
			expect(refused).toMatchObject({ code: "spend" });
			expect(refused?.reason).toContain(`'${toolName}'`);
		}
		expect(spendToolRefusal(CLOSED_STOP, { toolName: "yield", input: {} })).toBeUndefined();
	});

	test("the next request is aborted with a notice that says which stop it was", () => {
		const decision = spendRequestStop(CLOSED_STOP, "Impl");
		expect(decision.stop).toBe(true);
		if (!decision.stop) throw new Error("expected a stopped request");
		expect(decision.notice).toBe(spendStopNotice("Impl"));
		expect(decision.notice).toContain(SPEND_CLOSED_LEAD);
		expect(decision.notice).toContain(SPEND_USER_STOP_WORD);
		expect(decision.notice).toContain("Impl");
	});
});

describe("a marker Storm cannot read", () => {
	test("refuses new work and leaves the running turn alone", () => {
		const send = spendToolRefusal(UNKNOWN, write("agent://Impl"));
		expect(send).toMatchObject({ code: "spend-unknown" });
		expect(send?.reason.startsWith(SPEND_UNKNOWN_TAG)).toBe(true);
		expect(spendToolRefusal(UNKNOWN, { toolName: "task", input: {} })).toMatchObject({ code: "spend-unknown" });
		expect(spendToolRefusal(UNKNOWN, { toolName: "read", input: { path: "a.ts" } })).toBeUndefined();
		expect(spendRequestStop(UNKNOWN, "Impl")).toEqual({ stop: false });
	});
});
