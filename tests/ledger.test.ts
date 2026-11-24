import { afterEach, describe, expect, test } from "bun:test";
import {
	activeLedgerRun,
	bindLedgerChild,
	endLedgerRun,
	getLedgerRun,
	hasLedgerRun,
	ledgerRunForChild,
	ledgerRunForChildId,
	recordCost,
	resetLedger,
	startLedgerRun,
} from "../src/runtime/ledger.ts";

const SESSION_A = "/profiles/one/storm/sessions/a";
const SESSION_B = "/profiles/one/storm/sessions/b";
const SESSION_OTHER_PROFILE = "/profiles/two/storm/sessions/a";

afterEach(resetLedger);

describe("session-scoped ledger", () => {
	test("two sessions own concurrent runs on the same target without sharing cost or plan", () => {
		const a = startLedgerRun({
			runId: "run-a",
			sessionId: "native-a",
			sessionDir: SESSION_A,
			repoId: "repo",
			root: "/repo",
			budget: { perRunUsd: 1, onExceed: "stop" },
		});
		const b = startLedgerRun({
			runId: "run-b",
			sessionId: "native-b",
			sessionDir: SESSION_B,
			repoId: "repo",
			root: "/repo",
			budget: { perRunUsd: 10, onExceed: "stop" },
		});
		expect(a.sessionId).toBe("native-a");
		expect(b.sessionId).toBe("native-b");
		expect(a.sessionDir).toBe(SESSION_A);
		expect(activeLedgerRun(SESSION_A)).toBe(a);
		expect(activeLedgerRun(SESSION_B)).toBe(b);
		expect(hasLedgerRun(SESSION_A)).toBe(true);
		expect(hasLedgerRun(SESSION_OTHER_PROFILE)).toBe(false);
		expect(getLedgerRun("run-a")).toBe(a);
		expect(getLedgerRun("run-b")).toBe(b);

		recordCost("run-a", "m", 0.75);
		expect(a.costUsd).toBe(0.75);
		expect(b.costUsd).toBe(0);
		recordCost("run-a", "m", 0.75);
		expect(a.exceeded).toBe(true);
		expect(b.exceeded).toBe(false);

		endLedgerRun("run-a");
		expect(hasLedgerRun(SESSION_A)).toBe(false);
		expect(activeLedgerRun(SESSION_B)).toBe(b);
		expect(getLedgerRun("run-b")).toBe(b);
	});

	test("one session directory owns one run; a different profile may reuse the raw native id", () => {
		const a = startLedgerRun({ runId: "run-a", sessionId: "same-native", sessionDir: SESSION_A, repoId: "repo", root: "/repo" });
		expect(() =>
			startLedgerRun({ runId: "run-a2", sessionId: "same-native", sessionDir: SESSION_A, repoId: "repo", root: "/other" }),
		).toThrow(/이 세션/);
		expect(() =>
			startLedgerRun({ runId: "run-a", sessionId: "another-native", sessionDir: SESSION_B, repoId: "repo", root: "/repo" }),
		).toThrow(/중복/);
		const otherProfile = startLedgerRun({
			runId: "run-other-profile",
			sessionId: "same-native",
			sessionDir: SESSION_OTHER_PROFILE,
			repoId: "repo",
			root: "/repo",
		});
		expect(activeLedgerRun(SESSION_A)).toBe(a);
		expect(activeLedgerRun(SESSION_OTHER_PROFILE)).toBe(otherProfile);
		endLedgerRun("run-other-profile");
	});

	test("blank identities are refused instead of becoming an implicit key", () => {
		expect(() =>
			startLedgerRun({ runId: "run-a", sessionId: " ", sessionDir: SESSION_A, repoId: "repo", root: "/repo" }),
		).toThrow(/세션 id/);
		expect(() =>
			startLedgerRun({ runId: "run-a", sessionId: "a", sessionDir: "", repoId: "repo", root: "/repo" }),
		).toThrow(/세션 디렉터리/);
		expect(hasLedgerRun(SESSION_A)).toBe(false);
	});

	test("ending one run leaves the other session's child bindings and spend alone", () => {
		const a = startLedgerRun({ runId: "run-a", sessionId: "a", sessionDir: SESSION_A, repoId: "repo", root: "/repo" });
		const b = startLedgerRun({ runId: "run-b", sessionId: "b", sessionDir: SESSION_B, repoId: "repo", root: "/repo" });
		expect(bindLedgerChild(a.runId, "Worker", "Main", "/artifacts/a")).toBe(true);
		expect(bindLedgerChild(b.runId, "Worker", "Main", "/artifacts/b")).toBe(true);
		recordCost("run-a", "m", 2);
		recordCost("run-b", "m", 3);
		endLedgerRun("run-a");
		expect(ledgerRunForChild("Worker", "Main", "/artifacts/a")).toBeUndefined();
		expect(ledgerRunForChild("Worker", "Main", "/artifacts/b")).toBe(b);
		expect(b.costUsd).toBe(3);
		expect(a.costUsd).toBe(2);
	});
});

describe("child binding keys", () => {
	test("an exact attested artifact root and parent bind one child; no artifact or cwd fallback exists", () => {
		const a = startLedgerRun({ runId: "run-a", sessionId: "a", sessionDir: SESSION_A, repoId: "repo", root: "/repo" });
		expect(bindLedgerChild(a.runId, "Worker", "Main", "/artifacts/a")).toBe(true);
		expect(ledgerRunForChild("Worker", "Main", "/artifacts/a")).toBe(a);
		expect(ledgerRunForChild("Worker", "Main", "/artifacts/other")).toBeUndefined();
		expect(ledgerRunForChild("Worker", "Main", undefined)).toBeUndefined();
		expect(ledgerRunForChild("Worker", "OtherParent", "/artifacts/a")).toBeUndefined();
		expect(ledgerRunForChild("OtherWorker", "Main", "/artifacts/a")).toBeUndefined();
	});

	test("a foreign run cannot take over an existing child key; ambiguous ids stay unattributed", () => {
		const a = startLedgerRun({ runId: "run-a", sessionId: "a", sessionDir: SESSION_A, repoId: "repo", root: "/repo" });
		const b = startLedgerRun({ runId: "run-b", sessionId: "b", sessionDir: SESSION_B, repoId: "repo", root: "/repo" });
		expect(bindLedgerChild(a.runId, "Worker", "Main", "/artifacts/a")).toBe(true);
		expect(bindLedgerChild(b.runId, "Worker", "Main", "/artifacts/a")).toBe(false);
		expect(ledgerRunForChild("Worker", "Main", "/artifacts/a")).toBe(a);

		expect(bindLedgerChild(a.runId, "Twin", "Main", "/artifacts/a")).toBe(true);
		expect(bindLedgerChild(b.runId, "Twin", "Main", "/artifacts/b")).toBe(true);
		// Two runs reported the same bare child id under different artifact roots: a parent-free lookup is not authority.
		expect(ledgerRunForChildId("Twin", "Main")).toBeUndefined();
		expect(ledgerRunForChildId("Twin", "Main")?.runId).toBeUndefined();
		expect(ledgerRunForChildId("Twin", "OtherParent")).toBeUndefined();
	});

	test("a closing run binds no new child; a child id from another artifact root never leaks", () => {
		const a = startLedgerRun({ runId: "run-a", sessionId: "a", sessionDir: SESSION_A, repoId: "repo", root: "/repo" });
		expect(bindLedgerChild(a.runId, "Worker", "Main", "/artifacts/a")).toBe(true);
		a.closing = true;
		expect(bindLedgerChild(a.runId, "Late", "Main", "/artifacts/a")).toBe(false);
		expect(bindLedgerChild("run-missing", "Worker", "Main", "/artifacts/a")).toBe(false);
		expect(ledgerRunForChild("Worker", "Main", "/artifacts/b")).toBeUndefined();
	});
});
