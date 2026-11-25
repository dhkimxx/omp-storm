/**
 * Answer evidence regressions (S1):
 * - fast acceptance is only exact, typed or signed agreement with the cited statement; `-42` never passes for `42`,
 *   and prose that overlaps a cited word or copies a cited number goes to review instead of being accepted;
 * - an answer stands on the exact cited bytes S1 judged: an edited or deleted source revokes it before a consumer
 *   starts and at the verified gate, and reopens what consumed its version;
 * - a reviewable answer closes only through the approved reviewer's final verdict that explicitly scopes that exact
 *   submission (result id + receipt over run, attempt and content version + anchor), given after it and while its cited
 *   bytes still match; a generic change verdict, another answer's entry, an outdated receipt, an earlier verdict or a
 *   moved source settles nothing, and the reviewer receives the verbatim answer through Storm's packet;
 * - a resumed run cannot rebind an earlier run's answer review: the answer reopens to its producer, which resubmits and
 *   is reviewed under the new run's receipt;
 * - a source edited before a drained verified recheck still leaves the accepted answer marked revoked;
 * - length never makes an answer unmet: a long answer is checked and digested whole, and one no check decides goes to
 *   review under the receipt of its whole text;
 * - every reviewable answer of a round gets a packet, split over reviewer turns, each handed out exactly once, and a
 *   long verdict list settles every answer it scopes.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AttemptSettlement } from "../src/runtime/attempt-bridge.ts";
import type { AttemptReport } from "../src/runtime/attempt-report.ts";
import { answerReviewReceipt } from "../src/runtime/answer-review.ts";
import { resetAgents } from "../src/runtime/agents.ts";
import { resetLedger } from "../src/runtime/ledger.ts";
import { evaluateSettledResults, verifyAnswerReceipt, type AnswerCitation, type ResultEvidenceItem } from "../src/runtime/result-evidence.ts";
import { treeFingerprint } from "../src/runtime/rounds.ts";
import { noteResumePointer } from "../src/runtime/resume.ts";
import { readRun } from "../src/runtime/run.ts";
import type { TreeReading } from "../src/runtime/tree.ts";
import type { AgentEntry, PlanLaneResult, RunPlan, RunResult } from "../src/types.ts";
import { fakeSession, until, type FakeSession } from "./fake-session.ts";
import { agentEntry, treeOf } from "./fixtures.ts";

const T0 = Date.parse("2026-11-20T09:00:00Z");
const REPORT = "report.json";
const AUTH = "auth.md";
const NOTE = "note.md";
const TREE0 = treeOf("d0", "f0");
const F0 = treeFingerprint(TREE0);

let root: string;
beforeEach(async () => {
	root = await realpath(await mkdtemp(path.join(os.tmpdir(), "storm-answer-evidence-")));
	await writeFile(path.join(root, REPORT), '{\n  "total": 42,\n  "offset": -42\n}\n');
	await writeFile(path.join(root, AUTH), "authentication is disabled\n");
	await writeFile(path.join(root, NOTE), "ready\n");
});
afterEach(async () => {
	resetLedger();
	resetAgents();
	await rm(root, { recursive: true, force: true });
});

async function evaluate(result: PlanLaneResult, text: string, citations: AnswerCitation[]): Promise<ResultEvidenceItem> {
	const out = await evaluateSettledResults({ lane: "read", attemptId: "attempt-1", results: [result], shared: { root }, answer: { text, citations } });
	if (!out.ok) throw new Error(out.reason);
	const item = out.report.results[0];
	if (item === undefined) throw new Error("no evaluated item");
	return item;
}

const total = (extra: Partial<PlanLaneResult> = {}): PlanLaneResult => ({
	id: "total",
	kind: "answer",
	criterion: "states the report total",
	path: REPORT,
	contains: '"total": 42',
	...extra,
});
const totalLine: AnswerCitation[] = [{ path: REPORT, line: 2 }];
const offsetLine: AnswerCitation[] = [{ path: REPORT, line: 3 }];
const authLine: AnswerCitation[] = [{ path: AUTH, line: 1 }];

describe("deterministic answer agreement", () => {
	test("typed and signed answers are decided exactly; a flipped sign is never the cited value", async () => {
		for (const text of ["42", "total: 42", "The total is 42", "The total is 42 (report.json:2)."]) {
			expect((await evaluate(total(), text, totalLine)).state).toBe("accepted");
		}
		for (const text of ["-42", "−42", "The total is -42", "total = -42"]) {
			const item = await evaluate(total(), text, totalLine);
			expect(item.state).toBe("unmet");
			expect(item.reason).toContain("부호");
		}

		const offset = total({ id: "offset", criterion: "states the report offset", contains: '"offset": -42' });
		for (const text of ["-42", "offset = -42"]) expect((await evaluate(offset, text, offsetLine)).state).toBe("accepted");
		for (const text of ["42", "+42"]) expect((await evaluate(offset, text, offsetLine)).state).toBe("unmet");

		// Without a declared literal a typed match is still exact, and a sign flip is never accepted.
		const open = total({ contains: undefined });
		expect((await evaluate(open, "42", totalLine)).state).toBe("accepted");
		expect((await evaluate(open, "-42", totalLine)).state).not.toBe("accepted");
		expect((await evaluate(open, "-42", offsetLine)).state).toBe("accepted");
	});

	test("prose with misleading token overlap or a copied number is never fast-accepted", async () => {
		const auth: PlanLaneResult = { id: "auth", kind: "answer", criterion: "says whether authentication is enabled", path: AUTH };
		const contradicted = await evaluate(auth, "authentication is enabled", authLine);
		expect(contradicted.state).toBe("reviewable");
		expect((await evaluate(auth, "authentication is disabled.", authLine)).state).toBe("accepted");
		// Exact text keeps letter case; a sentence-cased copy is not the cited bytes and needs review.
		expect((await evaluate(auth, "Authentication is disabled.", authLine)).state).toBe("reviewable");

		const literal = { ...auth, contains: "authentication is disabled" };
		for (const text of ["authentication is enabled", "Authentication is disabled.", "It is not true that authentication is disabled", "authentication is disabled, except it is enabled"]) {
			expect((await evaluate(literal, text, authLine)).state).not.toBe("accepted");
		}

		for (const text of ["The total is not 42 (report.json:2).", "42 was the old total; the report now differs", "Roughly 42 or so, per report.json:2"]) {
			expect((await evaluate(total(), text, totalLine)).state).toBe("reviewable");
		}
		// Prose is not decided by its numbers: other counts beside the fact neither support nor contradict it.
		for (const text of ["The total is 42 but the retry budget is 7", "The report lists 42 as the total across 3 sections and 120 lines (report.json:2)."]) {
			expect((await evaluate(total(), text, totalLine)).state).toBe("reviewable");
		}
		// A typed answer is still decided by its value, with or without a trailing reference.
		for (const text of ["7", "total: 7", "The total is 7 (report.json:2)."]) expect((await evaluate(total(), text, totalLine)).state).toBe("unmet");
		// Without contains, a copied number inside prose is not proof either.
		expect((await evaluate(total({ contains: undefined }), "The total is 42 only if you ignore the retries", totalLine)).state).toBe("reviewable");
	});

	test("typed scalars compare by value, so booleans and null stay case-insensitive while strings do not", async () => {
		await writeFile(path.join(root, NOTE), "flag: true\nlabel: \"alpha\"\nmissing: null\n");
		const flag: PlanLaneResult = { id: "flag", kind: "answer", criterion: "states the flag", path: NOTE, contains: "flag: true" };
		const flagLine: AnswerCitation[] = [{ path: NOTE, line: 1 }];
		for (const text of ["true", "TRUE", "True", "flag: TRUE"]) expect((await evaluate(flag, text, flagLine)).state).toBe("accepted");
		for (const text of ["false", "FALSE", "flag: FALSE"]) {
			const item = await evaluate(flag, text, flagLine);
			expect(item.state).toBe("unmet");
			expect(item.reason).toContain("값");
		}

		const missing: PlanLaneResult = { id: "missing", kind: "answer", criterion: "states the missing field", path: NOTE, contains: "missing: null" };
		const missingLine: AnswerCitation[] = [{ path: NOTE, line: 3 }];
		for (const text of ["null", "NULL", "missing: Null"]) expect((await evaluate(missing, text, missingLine)).state).toBe("accepted");
		expect((await evaluate(missing, "missing: none", missingLine)).state).not.toBe("accepted");

		const label: PlanLaneResult = { id: "label", kind: "answer", criterion: "states the label", path: NOTE, contains: 'label: "alpha"' };
		const labelLine: AnswerCitation[] = [{ path: NOTE, line: 2 }];
		expect((await evaluate(label, '"alpha"', labelLine)).state).toBe("accepted");
		// A different string is never a contradiction; it cannot be checked and stays reviewable.
		expect((await evaluate(label, '"Alpha"', labelLine)).state).toBe("reviewable");
		expect((await evaluate(label, '"beta"', labelLine)).state).toBe("reviewable");

		await writeFile(path.join(root, NOTE), "true\n");
		const bare: PlanLaneResult = { id: "bare", kind: "answer", criterion: "states the bare flag", path: NOTE };
		const bareLine: AnswerCitation[] = [{ path: NOTE, line: 1 }];
		for (const text of ["true", "TRUE"]) expect((await evaluate(bare, text, bareLine)).state).toBe("accepted");
		expect((await evaluate(bare, "false", bareLine)).state).toBe("reviewable");
	});
});

describe("answer receipts", () => {
	test("a receipt holds only while its cited bytes and its own submission are unchanged", async () => {
		const item = await evaluate(total(), "42", totalLine);
		expect(item.state).toBe("accepted");
		expect(await verifyAnswerReceipt({ root, receipt: item, expectedVersion: item.contentVersion })).toEqual({ ok: true });

		const other = await verifyAnswerReceipt({ root, receipt: item, expectedVersion: "0".repeat(64) });
		expect(other.ok).toBe(false);
		const forged = await verifyAnswerReceipt({ root, receipt: { ...item, digest: "1".repeat(64) } });
		expect(forged.ok).toBe(false);

		await writeFile(path.join(root, REPORT), '{\n  "total": 43,\n  "offset": -42\n}\n');
		const edited = await verifyAnswerReceipt({ root, receipt: item });
		expect(edited.ok).toBe(false);
		if (!edited.ok) expect(edited.reason).toContain("다릅니다");

		await rm(path.join(root, REPORT));
		const deleted = await verifyAnswerReceipt({ root, receipt: item });
		expect(deleted.ok).toBe(false);
		if (!deleted.ok) expect(deleted.reason).toContain("삭제");
	});
});

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

describe("answer length", () => {
	test("a 30,000-character answer that matches its contains is accepted, judged and digested whole", async () => {
		const line = `"settings": "${"x".repeat(30_000)}", "total": 42`;
		await writeFile(path.join(root, NOTE), `${line}\n`);
		const settings: PlanLaneResult = { id: "settings", kind: "answer", criterion: "quotes the settings line", path: NOTE, contains: '"total": 42' };
		const item = await evaluate(settings, line, [{ path: NOTE, line: 1 }]);
		expect(line.length).toBeGreaterThan(30_000);
		expect(item.state).toBe("accepted");
		expect(item.digest).toBe(sha256(line));
		// Length does not stop the typed check: a padded typed answer with another value is still a contradiction.
		const wrong = `${" ".repeat(30_000)}"total": 7`;
		expect((await evaluate(settings, wrong, [{ path: NOTE, line: 1 }])).state).toBe("unmet");
	});

	test("a long answer no check decides is reviewable, never unmet for its length", async () => {
		const auth: PlanLaneResult = { id: "auth", kind: "answer", criterion: "explains the authentication setup", path: AUTH };
		const prose = `Authentication is off here. ${"The deployment notes explain why it stays off. ".repeat(700)}`;
		expect(prose.length).toBeGreaterThan(30_000);
		const item = await evaluate(auth, prose, authLine);
		expect(item.state).toBe("reviewable");
		expect(item.digest).toBe(sha256(prose));
		expect(item.citation?.digest).toBeDefined();
	});

	test("a part the host delivered is never accepted or failed on its own: it goes to review", async () => {
		const part = async (text: string, citations: AnswerCitation[]) => {
			const out = await evaluateSettledResults({ lane: "read", attemptId: "attempt-1", results: [total()], shared: { root }, answer: { text, citations, partial: true } });
			if (!out.ok) throw new Error(out.reason);
			return out.report.results[0];
		};
		// A head that would be accepted whole, or contradicted whole, is only a part.
		for (const text of ["42", "-42"]) expect(await part(text, totalLine)).toMatchObject({ state: "reviewable", digest: sha256(text), citation: { path: REPORT, line: 2 } });
		// The part names no verifiable source; the whole may, so it is not unmet either.
		expect((await part("The answer begins here", [{ path: "missing.md", line: 1 }]))?.state).toBe("reviewable");
	});

	test("past the scan bound an answer goes to review bound to its whole text, with its source still verified", async () => {
		const text = `42 ${"padding ".repeat(50)}`;
		const scan = async (citations: AnswerCitation[]) => {
			const out = await evaluateSettledResults({ lane: "read", attemptId: "attempt-1", results: [total()], shared: { root }, answer: { text, citations }, limits: { answerChars: 100 } });
			if (!out.ok) throw new Error(out.reason);
			return out.report.results[0];
		};
		const item = await scan(totalLine);
		expect(item).toMatchObject({ state: "reviewable", digest: sha256(text) });
		// The bound skips only the text comparison: an answer without a verifiable source is still unmet.
		expect((await scan([{ path: "missing.md", line: 1 }]))?.state).toBe("unmet");
	});
});

// ── Through the run controller ─────────────────────────────────────────────────────────────

const tree = (): TreeReading => ({ base: "base-0", state: TREE0 });

function planFor(lanes: RunPlan["lanes"], workers: Record<string, number>): RunPlan {
	return { lanes, workers, submittedAt: new Date(T0).toISOString() };
}

function report(over: Partial<AttemptReport> & Pick<AttemptReport, "runId" | "spawnKey" | "attemptId">): AttemptReport {
	return {
		schema: "storm.attempt-report/v1",
		parentId: "main",
		outcome: "success",
		capture: "observed",
		observedAt: T0 + 1,
		version: "unknown",
		artifacts: [],
		observations: [],
		...over,
	};
}

let admitSerial = 0;

/** Admits one planned lane the way manual direction does, with the readiness its declared edges read. */
async function admit(h: FakeSession, plan: RunPlan, agents: AgentEntry[], laneName: string): Promise<string> {
	const lane = plan.lanes.find(candidate => candidate.name === laneName);
	if (lane === undefined) throw new Error(`no lane ${laneName}`);
	const lanes = h.controller.runLanes();
	if (lanes === undefined) throw new Error("the run has no lane matcher");
	const agent = h.config.roles[lane.role]?.agent ?? `storm-${lane.role}`;
	const needed = new Set((lane.dependsOn ?? []).map(dependency => dependency.lane));
	const readiness = needed.size === 0 ? undefined : await h.controller.laneReadiness(plan, needed);
	// `<serial>.<lane>`: manual admission binds the handle's last segment to that lane, so several answer lanes of one
	// role stay unambiguous.
	const spawnKey = `${laneName}-${++admitSerial}.${laneName}`;
	const bound = lanes.place({ name: laneName, agent, task: "do the lane" }, plan, h.config, readiness === undefined ? {} : { readiness });
	if (!bound.ok) throw new Error(bound.reason);
	const admission = lanes.admitChecked({ spawnKey, agent, outcome: "routed" }, { plan, config: h.config });
	if (!admission.ok) throw new Error(admission.reason);
	agents.push(agentEntry({ id: spawnKey, name: agent, role: lane.role, state: "idle", requests: 1, lastActivityAt: T0 + 1 }));
	return spawnKey;
}

/** Prepares and settles one answer attempt, releasing its reservation as the host's child-end event does. */
async function answerAttempt(
	h: FakeSession,
	runId: string,
	lane: string,
	spawnKey: string,
	dispatch: string,
	reportText: string,
	citations: AnswerCitation[],
): Promise<void> {
	expect(await h.controller.prepareAttempt({ runId, lane, spawnKey, parentId: "main", dispatch, followUp: false, artifactMode: "shared", startedAt: T0 })).toEqual({ ok: true });
	const input: AttemptSettlement = {
		runId,
		lane,
		spawnKey,
		parentId: "main",
		dispatch,
		startedAt: T0,
		observedAt: T0 + 1,
		report: report({ runId, spawnKey, attemptId: `job:${dispatch}:${spawnKey}` }),
		reportText,
		citations,
	};
	await h.controller.settleAttempt(input);
	h.controller.runLanes()?.releaseAgent(spawnKey);
}

const row = (h: FakeSession, id: string): RunResult | undefined => h.controller.active()?.results?.find(item => item.id === id);

/**
 * The approved reviewer's final verdict at one time on the current tree. `results` are its explicitly scoped answer
 * entries; without them it is a plain change/tree verdict, which must never settle an answer.
 */
function verdict(h: FakeSession, at: number, correct: boolean, results?: readonly Record<string, unknown>[]): AgentEntry {
	const entry = {
		...agentEntry({
			id: "Rev",
			name: h.config.roles.reviewer?.agent ?? "storm-reviewer",
			role: "reviewer",
			review: { reviews: 1, passed: correct ? 1 : 0, failed: correct ? 0 : 1, findings: [0, 0, 0, 0] },
			lastVerdict: { at, correct, tree: F0 },
		}),
		reviewLog: [{ at, correct, findings: [], tree: F0, ...(results === undefined ? {} : { results: [...results] }) }],
	};
	return entry as unknown as AgentEntry;
}

/** The receipt Storm issues for the row's current submission in `runId`, or for the given overrides. */
function receiptFor(h: FakeSession, runId: string, id: string, over: { attemptId?: string; contentVersion?: string } = {}): string {
	const current = row(h, id);
	const receipt = answerReviewReceipt({
		runId,
		resultId: id,
		attemptId: over.attemptId ?? current?.attemptId ?? "",
		contentVersion: over.contentVersion ?? current?.contentVersion ?? "",
	});
	if (receipt === undefined) throw new Error(`no receipt for ${id}`);
	return receipt;
}

/** One scoped `results` entry as the reviewer's final yield returns it. */
const scopedEntry = (id: string, receipt: string, verdictWord: "correct" | "incorrect", citation = `${AUTH}:1`) => ({
	id,
	receipt,
	citation,
	verdict: verdictWord,
});

describe("answer receipts through the run", () => {
	const producerPlan = (): RunPlan =>
		planFor(
			[
				{ name: "read", kind: "explore", role: "explorer", goal: "Answer the total", results: [total()] },
				{
					name: "use",
					kind: "explore",
					role: "explorer",
					goal: "Use the total",
					results: [{ id: "summary", kind: "answer", criterion: "restates the note", path: NOTE, contains: "ready" }],
					dependsOn: [{ lane: "read", need: "result" }],
				},
			],
			{ explorer: 2 },
		);

	test("an edited source revokes the accepted answer before consumption and reopens its consumer", async () => {
		const agents: AgentEntry[] = [];
		const h = fakeSession({ root, agents, tree });
		const runId = await h.start();
		const plan = producerPlan();
		expect(await h.controller.setPlan(h.ctx, plan)).toEqual({ ok: true });
		await answerAttempt(h, runId, "read", await admit(h, plan, agents, "read"), "p1", "42", totalLine);
		expect(row(h, "total")?.state).toBe("accepted");
		await answerAttempt(h, runId, "use", await admit(h, plan, agents, "use"), "c1", "ready", [{ path: NOTE, line: 1 }]);
		expect(row(h, "summary")).toMatchObject({ state: "accepted", consumed: [{ id: "total" }] });

		await writeFile(path.join(root, REPORT), '{\n  "total": 43,\n  "offset": -42\n}\n');
		const readiness = await h.controller.laneReadiness(plan, new Set(["read"]));
		expect(readiness.get("read")?.results[0]).toMatchObject({ id: "total", state: "unmet" });
		expect(row(h, "total")?.state).toBe("unmet");
		expect(row(h, "total")?.reason).toContain("다릅니다");
		// The consumer started from the revoked version: its own accepted evidence is reopened too.
		expect(row(h, "summary")?.state).toBe("unmet");

		const final = await h.controller.finish("verified");
		expect(final?.endReason).not.toBe("verified");
	});

	test("a deleted source is caught at the verified gate and the row is marked revoked", async () => {
		const agents: AgentEntry[] = [];
		const h = fakeSession({ root, agents, tree });
		const runId = await h.start();
		const plan = planFor([{ name: "read", kind: "explore", role: "explorer", goal: "Answer the total", results: [total()] }], { explorer: 1 });
		expect(await h.controller.setPlan(h.ctx, plan)).toEqual({ ok: true });
		await answerAttempt(h, runId, "read", await admit(h, plan, agents, "read"), "p1", "The total is 42 (report.json:2).", totalLine);
		expect(row(h, "total")?.state).toBe("accepted");

		await rm(path.join(root, REPORT));
		const final = await h.controller.finish("verified");
		expect(final).toMatchObject({ status: "stopped", endReason: "no-progress" });
		const settled = final?.results?.find(item => item.id === "total");
		expect(settled).toMatchObject({ state: "unmet", finalized: "revoked" });
		expect(settled?.reason).toContain("삭제");
		expect((await readRun(h.sessionDir, runId))?.results?.find(item => item.id === "total")?.state).toBe("unmet");
	});
});

describe("answer review bound to the current submission", () => {
	const SUBMITTED = T0 + 10;
	const ANSWER = "Authentication is turned off in this deployment.";
	const authResult: PlanLaneResult = { id: "auth", kind: "answer", criterion: "says whether authentication is enabled", path: AUTH };
	const reviewPlan = (): RunPlan =>
		planFor([{ name: "read", kind: "explore", role: "explorer", goal: "Say whether authentication is enabled", results: [authResult] }], { explorer: 1 });

	/** One reviewable prose answer, with the run's clock at its submission. */
	async function submitted(): Promise<{ h: FakeSession; agents: AgentEntry[]; runId: string }> {
		const agents: AgentEntry[] = [];
		const h = fakeSession({ root, agents, tree, now: () => SUBMITTED });
		const runId = await h.start({ task: "t", rounds: 1 });
		const plan = reviewPlan();
		expect(await h.controller.setPlan(h.ctx, plan)).toEqual({ ok: true });
		await answerAttempt(h, runId, "read", await admit(h, plan, agents, "read"), "a1", ANSWER, authLine);
		const submittedRow = row(h, "auth");
		expect(submittedRow?.state).toBe("reviewable");
		expect(submittedRow?.reason).toContain(AUTH);
		return { h, agents, runId };
	}

	test("the reviewer's packet quotes the exact answer with its receipt and anchor", async () => {
		const { h, runId } = await submitted();
		const packets = h.controller.takeAnswerReviewBatch();
		expect(packets).toContain(ANSWER);
		expect(packets).toContain(receiptFor(h, runId, "auth"));
		expect(packets).toContain(`"citation": "${AUTH}:1"`);
		expect(packets).toContain("not a verdict");
		await h.controller.finish("interrupted");
	});

	test("a scoped correct verdict given after the submission accepts it without a tree binding", async () => {
		const { h, agents, runId } = await submitted();
		agents.push(verdict(h, SUBMITTED + 5, true, [scopedEntry("auth", receiptFor(h, runId, "auth"), "correct")]));
		await h.turn();
		const run = await readRun(h.sessionDir, runId);
		const settled = run?.results?.find(item => item.id === "auth");
		expect(settled).toMatchObject({ state: "accepted", origin: "review" });
		expect(settled?.reviewTree).toBeUndefined();
		expect(run).toMatchObject({ status: "done", endReason: "verified" });
	});

	test("a generic approved code verdict cannot accept an answer", async () => {
		const { h, agents, runId } = await submitted();
		agents.push(verdict(h, SUBMITTED + 5, true));
		await h.turn();
		const run = await readRun(h.sessionDir, runId);
		expect(run?.endReason).not.toBe("verified");
		expect(run?.results?.find(item => item.id === "auth")?.state).toBe("reviewable");
	});

	test("an explicit review of one answer cannot accept another", async () => {
		const agents: AgentEntry[] = [];
		const h = fakeSession({ root, agents, tree, now: () => SUBMITTED });
		const runId = await h.start({ task: "t", rounds: 1 });
		const other: PlanLaneResult = { id: "auth-mode", kind: "answer", criterion: "names the authentication mode", path: AUTH };
		const plan = planFor(
			[
				{ name: "read", kind: "explore", role: "explorer", goal: "Say whether authentication is enabled", results: [authResult] },
				{ name: "mode", kind: "explore", role: "explorer", goal: "Name the authentication mode", results: [other] },
			],
			{ explorer: 2 },
		);
		expect(await h.controller.setPlan(h.ctx, plan)).toEqual({ ok: true });
		await answerAttempt(h, runId, "read", await admit(h, plan, agents, "read"), "a1", ANSWER, authLine);
		await answerAttempt(h, runId, "mode", await admit(h, plan, agents, "mode"), "b1", "It runs without any login at all.", authLine);
		expect(row(h, "auth")?.state).toBe("reviewable");
		expect(row(h, "auth-mode")?.state).toBe("reviewable");
		const receiptA = receiptFor(h, runId, "auth");
		// A's entry is exact; B is named only with A's receipt, which is no receipt for B's submission.
		agents.push(verdict(h, SUBMITTED + 5, true, [scopedEntry("auth", receiptA, "correct"), scopedEntry("auth-mode", receiptA, "correct")]));
		await h.turn();
		const run = await readRun(h.sessionDir, runId);
		expect(run?.results?.find(item => item.id === "auth")).toMatchObject({ state: "accepted", origin: "review" });
		expect(run?.results?.find(item => item.id === "auth-mode")?.state).toBe("reviewable");
		expect(run?.endReason).not.toBe("verified");
	});

	test("a receipt for an outdated content version or another attempt fails closed", async () => {
		const { h, agents, runId } = await submitted();
		const outdated = receiptFor(h, runId, "auth", { contentVersion: "f".repeat(64) });
		const otherAttempt = receiptFor(h, runId, "auth", { attemptId: "job:a0:read-0.read" });
		const otherRun = answerReviewReceipt({ runId: "run-20261119-090000-zzzz", resultId: "auth", attemptId: row(h, "auth")!.attemptId!, contentVersion: row(h, "auth")!.contentVersion! })!;
		for (const receipt of [outdated, otherAttempt, otherRun]) expect(receipt).not.toBe(receiptFor(h, runId, "auth"));
		agents.push(verdict(h, SUBMITTED + 5, true, [scopedEntry("auth", outdated, "correct")]));
		agents.push({ ...verdict(h, SUBMITTED + 6, true, [scopedEntry("auth", otherAttempt, "correct")]), id: "Rev2" } as AgentEntry);
		agents.push({ ...verdict(h, SUBMITTED + 7, true, [scopedEntry("auth", otherRun, "correct")]), id: "Rev3" } as AgentEntry);
		// The right receipt with another anchor spelling is no review of this submission either.
		agents.push({ ...verdict(h, SUBMITTED + 8, true, [scopedEntry("auth", receiptFor(h, runId, "auth"), "correct", AUTH)]), id: "Rev4" } as AgentEntry);
		await h.turn();
		const run = await readRun(h.sessionDir, runId);
		expect(run?.endReason).not.toBe("verified");
		expect(run?.results?.find(item => item.id === "auth")?.state).toBe("reviewable");
	});

	test("a scoped incorrect verdict leaves the answer unmet, judged rather than revoked", async () => {
		const { h, agents, runId } = await submitted();
		agents.push(verdict(h, SUBMITTED + 5, true, [scopedEntry("auth", receiptFor(h, runId, "auth"), "incorrect")]));
		await h.turn();
		const run = await readRun(h.sessionDir, runId);
		expect(run?.endReason).not.toBe("verified");
		const settled = run?.results?.find(item => item.id === "auth");
		expect(settled).toMatchObject({ state: "unmet", origin: "review" });
		expect(settled?.finalized).toBeUndefined();
	});

	test("a scoped verdict older than the submission settles nothing", async () => {
		const { h, agents, runId } = await submitted();
		agents.push(verdict(h, SUBMITTED - 5, true, [scopedEntry("auth", receiptFor(h, runId, "auth"), "correct")]));
		await h.turn();
		const run = await readRun(h.sessionDir, runId);
		expect(run?.endReason).not.toBe("verified");
		expect(run?.results?.find(item => item.id === "auth")?.state).not.toBe("accepted");
	});

	test("a scoped correct verdict does not accept an answer whose cited source changed", async () => {
		const { h, agents, runId } = await submitted();
		const receipt = receiptFor(h, runId, "auth");
		await writeFile(path.join(root, AUTH), "authentication is enabled\n");
		agents.push(verdict(h, SUBMITTED + 5, true, [scopedEntry("auth", receipt, "correct")]));
		await h.turn();
		const run = await readRun(h.sessionDir, runId);
		expect(run?.endReason).not.toBe("verified");
		expect(run?.results?.find(item => item.id === "auth")?.state).toBe("unmet");
	});

	test("a resumed run reopens a reviewable answer to its producer, which resubmits and is reviewed anew", async () => {
		const { h, agents, runId: oldRunId } = await submitted();
		const oldReceipt = receiptFor(h, oldRunId, "auth");
		const old = await h.controller.finish("interrupted");
		expect(old?.results?.find(item => item.id === "auth")?.state).toBe("reviewable");
		await noteResumePointer(h.sessionDir, { repoId: h.repo.repoId, root: h.repo.root }, old!);

		// Rounds to spare: the first round below must not end the resumed run before its producer reruns.
		const runId = await h.start({ task: "carry on", resumeOf: oldRunId, rounds: 3 });
		const reopened = row(h, "auth");
		// Not restored as reviewable or accepted: the earlier run's receipt cannot be rebound and no packet is offered.
		expect(reopened?.state).toBe("pending");
		expect(reopened?.reason).toContain("다시 제출");
		expect(h.controller.takeAnswerReviewBatch()).toBeUndefined();
		// The old run's scoped verdict settles nothing in the new run.
		agents.push(verdict(h, SUBMITTED + 5, true, [scopedEntry("auth", oldReceipt, "correct")]));
		await h.turn();
		expect(row(h, "auth")?.state).not.toBe("accepted");

		// The producer reruns, the new submission gets this run's receipt, and its scoped review accepts it.
		const plan = h.controller.active()?.plan ?? reviewPlan();
		await answerAttempt(h, runId, "read", await admit(h, plan, agents, "read"), "a2", ANSWER, authLine);
		expect(row(h, "auth")?.state).toBe("reviewable");
		const receipt = receiptFor(h, runId, "auth");
		expect(receipt).not.toBe(oldReceipt);
		expect(h.controller.takeAnswerReviewBatch()).toContain(receipt);
		agents.push({ ...verdict(h, SUBMITTED + 9, true, [scopedEntry("auth", receipt, "correct")]), id: "Rev5" } as AgentEntry);
		await h.turn();
		expect((await readRun(h.sessionDir, runId))?.results?.find(item => item.id === "auth")).toMatchObject({ state: "accepted", origin: "review" });
	});

	test("a source edited before a drained verified recheck keeps the accepted answer marked revoked", async () => {
		const agents: AgentEntry[] = [];
		const h = fakeSession({ root, agents, tree });
		const runId = await h.start();
		const plan = planFor([{ name: "read", kind: "explore", role: "explorer", goal: "Answer the total", results: [total()] }], { explorer: 1 });
		expect(await h.controller.setPlan(h.ctx, plan)).toEqual({ ok: true });
		await answerAttempt(h, runId, "read", await admit(h, plan, agents, "read"), "p1", "42", totalLine);
		expect(row(h, "total")?.state).toBe("accepted");

		// Owned work is still live: a verified finish drains instead of finalizing now.
		const live = agentEntry({ id: "Late", name: "storm-explorer", role: "explorer", state: "running", requests: 1, lastActivityAt: T0 + 2 });
		agents.push(live);
		expect(await h.controller.finish("verified")).toBeUndefined();
		await writeFile(path.join(root, REPORT), '{\n  "total": 43,\n  "offset": -42\n}\n');
		live.state = "idle";
		h.timers.fire();
		await until(async () => (await readRun(h.sessionDir, runId))?.endedAt !== undefined);

		const final = await readRun(h.sessionDir, runId);
		expect(final?.endReason).not.toBe("verified");
		expect(final?.results?.find(item => item.id === "total")).toMatchObject({ state: "unmet", finalized: "revoked" });
	});
});

describe("answer review batches", () => {
	const SUBMITTED = T0 + 10;
	const authLines: AnswerCitation[] = [{ path: AUTH, line: 1 }];
	const RECEIPT = /\(receipt ([0-9a-f]{32})\)/gu;
	const receiptsIn = (batch: string | undefined): string[] => [...(batch ?? "").matchAll(RECEIPT)].map(match => match[1] as string);
	const answerResults = (prefix: string, count: number): PlanLaneResult[] =>
		Array.from({ length: count }, (_, index) => ({ id: `${prefix}${index}`, kind: "answer", criterion: `explains authentication aspect ${index}`, path: AUTH }));

	/** One lane per result group; every answer is reviewable prose citing the same line. */
	async function reviewable(groups: number[], answer: string): Promise<{ h: FakeSession; agents: AgentEntry[]; runId: string; ids: string[]; spawnKeys: string[] }> {
		const agents: AgentEntry[] = [];
		const h = fakeSession({ root, agents, tree, now: () => SUBMITTED });
		const runId = await h.start({ task: "t", rounds: 3 });
		const lanes = groups.map((count, lane) => ({
			name: `read${lane}`,
			kind: "explore" as const,
			role: "explorer",
			goal: "Explain the authentication setup",
			results: answerResults(`a${lane}-`, count),
		}));
		const plan = planFor(lanes, { explorer: groups.length });
		expect(await h.controller.setPlan(h.ctx, plan)).toEqual({ ok: true });
		const spawnKeys: string[] = [];
		for (const lane of lanes) {
			const spawnKey = await admit(h, plan, agents, lane.name);
			spawnKeys.push(spawnKey);
			await answerAttempt(h, runId, lane.name, spawnKey, `d-${lane.name}`, answer, authLines);
		}
		const ids = lanes.flatMap(lane => lane.results.map(result => result.id));
		for (const id of ids) expect(row(h, id)?.state).toBe("reviewable");
		return { h, agents, runId, ids, spawnKeys };
	}

	test("a 30,000-character answer is handed to review as its head with the producer's handle, and a scoped verdict accepts it", async () => {
		const long = `Authentication is turned off. ${"The deployment notes explain why it stays off. ".repeat(700)}END`;
		const { h, agents, runId, ids, spawnKeys } = await reviewable([1], long);
		const id = ids[0] as string;
		const receipt = receiptFor(h, runId, id);
		const batch = h.controller.takeAnswerReviewBatch();
		expect(receiptsIn(batch)).toEqual([receipt]);
		expect(batch).toContain(`agent://${spawnKeys[0]}`);
		expect(batch).not.toContain("END");
		expect((batch ?? "").length).toBeLessThan(long.length);
		agents.push(verdict(h, SUBMITTED + 5, true, [scopedEntry(id, receipt, "correct")]));
		await h.turn();
		expect((await readRun(h.sessionDir, runId))?.results?.find(item => item.id === id)).toMatchObject({ state: "accepted", origin: "review" });
	});

	test("nine reviewable answers all get packets in one round, over several reviewer turns, each exactly once", async () => {
		const answer = `Authentication is turned off. ${"Login is not required anywhere. ".repeat(160)}`;
		const { h, runId, ids } = await reviewable([9], answer);
		const expected = ids.map(id => receiptFor(h, runId, id)).sort();
		const batches: string[][] = [];
		for (let batch = h.controller.takeAnswerReviewBatch(); batch !== undefined; batch = h.controller.takeAnswerReviewBatch()) {
			batches.push(receiptsIn(batch));
			expect(batches.length).toBeLessThanOrEqual(ids.length);
		}
		expect(batches.length).toBeGreaterThan(1);
		const handed = batches.flat();
		expect(handed).toHaveLength(ids.length);
		expect([...handed].sort()).toEqual(expected);

		// The round tells the director how many reviewer turns the answers take; with no reviewer running it re-offers all.
		const before = h.sent.length;
		await h.turn();
		h.timers.fire();
		await until(() => h.sent.length > before);
		const message = h.sent.at(-1) ?? "";
		expect(message).toContain(`${ids.length} reviewable answers`);
		expect(message).toContain(`${batches.length} review tasks`);
		expect(receiptsIn(h.controller.takeAnswerReviewBatch()).length).toBe(batches[0]?.length);
		await h.controller.finish("interrupted");
	});

	test("a batch handed to a reviewer still running is not re-offered when the next round starts", async () => {
		const answer = `Authentication is turned off. ${"Login is not required anywhere. ".repeat(160)}`;
		const { h, agents, ids } = await reviewable([9], answer);
		const first = receiptsIn(h.controller.takeAnswerReviewBatch());
		agents.push(agentEntry({ id: "RevBusy", name: h.config.roles.reviewer?.agent ?? "storm-reviewer", role: "reviewer", state: "running", requests: 1, lastActivityAt: SUBMITTED }));
		const before = h.sent.length;
		await h.turn();
		h.timers.fire();
		await until(() => h.sent.length > before);
		expect(h.sent.at(-1)).toContain(`${ids.length - first.length} reviewable answers`);
		const rest: string[] = [];
		for (let batch = h.controller.takeAnswerReviewBatch(); batch !== undefined; batch = h.controller.takeAnswerReviewBatch()) rest.push(...receiptsIn(batch));
		expect(rest).toHaveLength(ids.length - first.length);
		for (const receipt of first) expect(rest).not.toContain(receipt);
		await h.controller.finish("interrupted");
	});

	test("one verdict list of 20 scoped entries settles all 20 answers", async () => {
		const { h, agents, runId, ids } = await reviewable([10, 10], "Authentication is turned off in this deployment.");
		expect(ids).toHaveLength(20);
		agents.push(verdict(h, SUBMITTED + 5, true, ids.map(id => scopedEntry(id, receiptFor(h, runId, id), "correct"))));
		await h.turn();
		const run = await readRun(h.sessionDir, runId);
		for (const id of ids) expect(run?.results?.find(item => item.id === id)).toMatchObject({ state: "accepted", origin: "review" });
	});

	test("a foreign or stale receipt in a long verdict list settles nothing", async () => {
		const { h, agents, runId, ids } = await reviewable([10, 10], "Authentication is turned off in this deployment.");
		const [stale, foreign, ...good] = ids as [string, string, ...string[]];
		const staleReceipt = receiptFor(h, runId, stale, { contentVersion: "f".repeat(64) });
		const foreignReceipt = answerReviewReceipt({ runId: "run-20261119-090000-zzzz", resultId: foreign, attemptId: row(h, foreign)!.attemptId!, contentVersion: row(h, foreign)!.contentVersion! })!;
		agents.push(verdict(h, SUBMITTED + 5, true, [
			scopedEntry(stale, staleReceipt, "correct"),
			scopedEntry(foreign, foreignReceipt, "correct"),
			...good.map(id => scopedEntry(id, receiptFor(h, runId, id), "correct")),
		]));
		await h.turn();
		// The run stays open on the two unsettled answers, so the live rows are the state to read.
		expect(row(h, stale)?.state).toBe("reviewable");
		expect(row(h, foreign)?.state).toBe("reviewable");
		for (const id of good) expect(row(h, id)).toMatchObject({ state: "accepted", origin: "review" });
		expect(h.controller.active()?.runId).toBe(runId);
		await h.controller.finish("interrupted");
	});
});
