import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { containsMagicKeyword } from "@oh-my-pi/pi-tui/prompt/magic-keywords";
import {
	activeLedgerRun,
	endLedgerRun,
	type LedgerRun,
	recordCost,
	resetLedger,
	startLedgerRun,
} from "../src/runtime/ledger.ts";
import {
	buildHandoff,
	lastRun,
	newRunId,
	pickKeyword,
	pruneRuns,
	readRun,
	runsDir,
	stateDir,
	writeRun,
} from "../src/runtime/run.ts";
import { addQuotaMark, readQuotaMarks, readTrialStates, updateTrialState } from "../src/runtime/state-files.ts";
import { activeTrialFor, shouldRouteToTrial, trialPhase } from "../src/runtime/trials.ts";
import type { RunRecord, StormConfig, TrialConfig } from "../src/types.ts";

const HASH = `jcs-sha256:${"ab12".repeat(16)}`;

const config: StormConfig = {
	version: 1,
	priority: "balanced",
	roles: {
		explorer: { agent: "storm-explorer", models: ["google/gemini-flash"], effort: "low", workers: 2 },
		implementer: { agent: "storm-implementer", models: ["openai/gpt-5.2"] },
	},
	parallelism: 3,
	isolation: "isolated",
	contract: "workflowz",
	runtime: "omp",
};

let root: string;
beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "storm-runtime-"));
	resetLedger();
});
afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

describe("ledger", () => {
	test("thresholds fire once each, with flags set first, and a throwing callback is harmless", () => {
		const seen: Array<[string, boolean, boolean, number]> = [];
		startLedgerRun({
			runId: "run-a",
			repoId: "repo",
			configHash: HASH,
			budget: { perRunUsd: 1, warnAtUsd: 0.5, onExceed: "block-spawns" },
			onThreshold: (kind, run) => {
				seen.push([kind, run.warned, run.exceeded, run.costUsd]);
				throw new Error("listener failed");
			},
		});
		recordCost("repo", "openai/gpt-5.2", 0.3);
		recordCost("repo", "openai/gpt-5.2", 0.3);
		recordCost("repo", "google/gemini-flash", 0.2);
		recordCost("repo", "google/gemini-flash", 0.5);
		recordCost("repo", "google/gemini-flash", 0.5);
		expect(seen.map(s => s.slice(0, 3))).toEqual([
			["warn", true, false],
			["limit", true, true],
		]);
		const run = activeLedgerRun("repo");
		expect(run?.costUsd).toBeCloseTo(1.8);
		expect(run?.costByModel["openai/gpt-5.2"]).toBeCloseTo(0.6);
		expect(run?.costByModel["google/gemini-flash"]).toBeCloseTo(1.2);
	});

	test("warn needs warnAtUsd; limit fires without it; one jump fires both", () => {
		const kinds: string[] = [];
		startLedgerRun({
			runId: "run-a",
			repoId: "repo",
			configHash: HASH,
			budget: { perRunUsd: 1, onExceed: "stop" },
			onThreshold: kind => kinds.push(kind),
		});
		recordCost("repo", "m", 2);
		expect(kinds).toEqual(["limit"]);
		endLedgerRun("run-a");
		const both: string[] = [];
		startLedgerRun({
			runId: "run-b",
			repoId: "repo",
			configHash: HASH,
			budget: { perRunUsd: 1, warnAtUsd: 0.5, onExceed: "stop" },
			onThreshold: kind => both.push(kind),
		});
		recordCost("repo", "m", 3);
		expect(both).toEqual(["warn", "limit"]);
	});

	test("one run per repo; costs without a run or with bad values are ignored", () => {
		expect(recordCost("repo", "m", 1)).toBeUndefined();
		const run: LedgerRun = startLedgerRun({ runId: "run-a", repoId: "repo", configHash: HASH });
		expect(() => startLedgerRun({ runId: "run-b", repoId: "repo", configHash: HASH })).toThrow();
		startLedgerRun({ runId: "run-c", repoId: "other", configHash: HASH });
		recordCost("repo", "m", Number.NaN);
		recordCost("repo", "m", -1);
		recordCost("repo", "m", Number.POSITIVE_INFINITY);
		expect(run.costUsd).toBe(0);
		expect(run.costByModel).toEqual({});
		recordCost("repo", "m", 0.25);
		expect(run.costUsd).toBe(0.25);
		expect(endLedgerRun("run-a")).toBe(run);
		expect(activeLedgerRun("repo")).toBeUndefined();
		expect(activeLedgerRun("other")?.runId).toBe("run-c");
		expect(endLedgerRun("run-a")).toBeUndefined();
		startLedgerRun({ runId: "run-d", repoId: "repo", configHash: HASH });
	});
});

function record(runId: string, startedAt: string, status: RunRecord["status"]): RunRecord {
	return {
		schema: "storm.run/v1",
		runId,
		configHash: HASH,
		approvalId: "apr_1",
		startedAt,
		status,
		contract: "workflowz",
		task: "do it",
		costUsd: 0,
		costByModel: {},
		spawns: [],
	};
}

describe("run files", () => {
	test("paths and run ids", () => {
		expect(stateDir("/r")).toBe(path.join("/r", ".omp", "storm", "state"));
		expect(runsDir("/r")).toBe(path.join("/r", ".omp", "storm", "state", "runs"));
		const id = newRunId(Date.parse("2026-11-20T15:30:12.000Z"));
		expect(id).toMatch(/^run-20261120-153012-[0-9a-f]{4}$/);
		const ids = new Set(Array.from({ length: 50 }, () => newRunId(0)));
		expect(ids.size).toBeGreaterThan(45);
		expect(newRunId(Date.parse("2026-11-20T15:30:13.000Z")) > id).toBe(true);
	});

	test("roundtrip, lastRun picks the newest finished run, unreadable files are skipped", async () => {
		const a = record("run-20261120-100000-aaaa", "2026-11-20T10:00:00.000Z", "done");
		const b = {
			...record("run-20261120-110000-bbbb", "2026-11-20T11:00:00.000Z", "budget-exceeded"),
			spawns: [
				{ ts: "2026-11-20T11:00:01.000Z", agent: "storm-explorer", invocationKind: "task" as const, requested: [], outcome: "routed" as const, models: ["m"] },
			],
		};
		const c = record("run-20261120-120000-cccc", "2026-11-20T12:00:00.000Z", "running");
		for (const r of [a, b, c]) await writeRun(root, r);
		expect(await readRun(root, b.runId)).toEqual(b);
		expect(await readRun(root, "run-missing")).toBeUndefined();
		expect(await readRun(root, "../escape")).toBeUndefined();
		await fs.writeFile(path.join(runsDir(root), "run-20261120-130000-dddd.json"), "{ not json");
		expect((await lastRun(root))?.runId).toBe(b.runId);
		expect(await lastRun(path.join(root, "nowhere"))).toBeUndefined();
		const left = (await fs.readdir(runsDir(root))).filter(n => n.endsWith(".tmp"));
		expect(left).toEqual([]);
		await expect(writeRun(root, { ...a, runId: "../x" })).rejects.toThrow();
	});

	test("pruneRuns keeps the newest files", async () => {
		for (let i = 0; i < 5; i++) await writeRun(root, record(`run-20261120-10000${i}-aaaa`, `2026-11-20T10:00:0${i}.000Z`, "done"));
		await fs.writeFile(path.join(runsDir(root), "notes.txt"), "keep me");
		await pruneRuns(root, 2);
		expect((await fs.readdir(runsDir(root))).sort()).toEqual([
			"notes.txt",
			"run-20261120-100003-aaaa.json",
			"run-20261120-100004-aaaa.json",
		]);
		await pruneRuns(path.join(root, "nowhere"));
	});
});

describe("handoff", () => {
	const base = { runId: "run-20261120-153012-a1b2", config, hash: HASH, task: "로그인 버그를 고쳐 주세요." };

	test("pickKeyword prefers the configured contract, then the other, then none", () => {
		expect(pickKeyword(config, { workflowz: true, orchestrate: true })).toBe("workflowz");
		expect(pickKeyword(config, { workflowz: false, orchestrate: true })).toBe("orchestrate");
		expect(pickKeyword({ ...config, contract: "orchestrate" }, { workflowz: true, orchestrate: false })).toBe("workflowz");
		expect(pickKeyword(config, { workflowz: false, orchestrate: false })).toBeNull();
	});

	test("line 1 is the keyword, the contract sits in an XML section, the task follows verbatim", () => {
		const text = buildHandoff({ ...base, keyword: "workflowz" });
		const lines = text.split("\n");
		expect(lines[0]).toBe("workflowz");
		expect(lines[1]).toBe('<storm-run id="run-20261120-153012-a1b2" config="ab12ab12ab12">');
		expect(text).toContain("- storm-explorer: 탐색, effort low, 동시에 최대 2개");
		expect(text).toContain("- storm-implementer: 구현, 동시에 최대 1개");
		expect(text).toContain("최대 3개");
		expect(text).toContain("model 을 넘기지 않습니다");
		expect(text).toContain("승인 밖 모델을 요청하면 스폰이 막힙니다.");
		expect(text).not.toContain("예산");
		expect(text.endsWith(`</storm-run>\n\n${base.task}`)).toBe(true);
		// Outside line 1 neither keyword appears anywhere.
		const rest = lines.slice(1).join("\n");
		expect(rest).not.toContain("workflowz");
		expect(rest).not.toContain("orchestrate");
	});

	test("budget and fallback rules follow the config", () => {
		const text = buildHandoff({
			...base,
			config: { ...config, budget: { perRunUsd: 5, onExceed: "block-spawns" }, fallbackRole: "explorer", isolation: "shared" },
			keyword: null,
		});
		expect(text).toContain("- 이 실행 예산 $5.00: 넘으면 새 스폰이 막힙니다.");
		expect(text).toContain("storm-explorer 역할의 모델로 바뀝니다.");
		expect(text).toContain("격리 없음");
		expect(text.startsWith("<storm-run ")).toBe(true);
	});

	test("omp's matcher sees only the intended keyword", () => {
		for (const keyword of ["workflowz", "orchestrate"] as const) {
			const other = keyword === "workflowz" ? "orchestrate" : "workflowz";
			const text = buildHandoff({ ...base, keyword });
			expect(containsMagicKeyword(text, keyword)).toBe(true);
			expect(containsMagicKeyword(text, other)).toBe(false);
		}
		const none = buildHandoff({ ...base, keyword: null });
		expect(containsMagicKeyword(none, "workflowz")).toBe(false);
		expect(containsMagicKeyword(none, "orchestrate")).toBe(false);
		// The contract alone never triggers, even with every optional rule present.
		const full = buildHandoff({
			...base,
			config: { ...config, budget: { perRunUsd: 0.5, onExceed: "stop" }, fallbackRole: "implementer" },
			keyword: null,
		});
		expect(containsMagicKeyword(full, "workflowz")).toBe(false);
		expect(containsMagicKeyword(full, "orchestrate")).toBe(false);
	});
});

describe("state files", () => {
	test("quota marks: active only, one per provider, expired ones dropped", async () => {
		const now = Date.parse("2026-11-20T12:00:00.000Z");
		expect(await readQuotaMarks(root, now)).toEqual([]);
		await addQuotaMark(root, { provider: "anthropic", source: "user", markedAt: "2026-11-20T00:00:00.000Z", until: "2026-11-20T06:00:00.000Z" });
		await addQuotaMark(root, { provider: "openai", source: "usage", markedAt: "2026-11-20T00:00:00.000Z", until: "2026-11-21T00:00:00.000Z" });
		expect((await readQuotaMarks(root, now)).map(m => m.provider)).toEqual(["openai"]);
		await addQuotaMark(root, { provider: "openai", source: "user", markedAt: "2026-11-20T12:00:00.000Z", until: "2026-11-22T00:00:00.000Z" });
		const marks = await readQuotaMarks(root, now);
		expect(marks).toEqual([{ provider: "openai", source: "user", markedAt: "2026-11-20T12:00:00.000Z", until: "2026-11-22T00:00:00.000Z" }]);
		const raw = JSON.parse(await fs.readFile(path.join(stateDir(root), "quota-marks.json"), "utf8"));
		expect(raw.marks).toHaveLength(1);
	});

	test("corrupt or unreadable files read as empty", async () => {
		await fs.mkdir(stateDir(root), { recursive: true });
		await fs.writeFile(path.join(stateDir(root), "quota-marks.json"), "{ broken");
		await fs.writeFile(path.join(stateDir(root), "trials.json"), JSON.stringify({ trials: { a: { id: "a", seen: "x" } } }));
		expect(await readQuotaMarks(root, 0)).toEqual([]);
		expect(await readTrialStates(root)).toEqual({});
		await fs.mkdir(path.join(root, "dir-as-root", ".omp", "storm", "state", "trials.json"), { recursive: true });
		expect(await readTrialStates(path.join(root, "dir-as-root"))).toEqual({});
	});

	test("concurrent trial updates lose no increment and leave no temp files", async () => {
		await Promise.all(
			Array.from({ length: 40 }, (_, i) =>
				updateTrialState(root, i % 2 === 0 ? "a" : "b", s => ({ ...s, seen: s.seen + 1, routed: s.routed + (i % 4 === 0 ? 1 : 0), costUsd: s.costUsd + 0.5 })),
			),
		);
		const states = await readTrialStates(root);
		expect(states.a).toEqual({ id: "a", seen: 20, routed: 10, costUsd: 10 });
		expect(states.b).toEqual({ id: "b", seen: 20, routed: 0, costUsd: 10 });
		expect((await fs.readdir(stateDir(root))).sort()).toEqual(["trials.json"]);
	});

	test("a failing update does not break the chain", async () => {
		await expect(
			updateTrialState(root, "a", () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		const next = await updateTrialState(root, "a", s => ({ ...s, seen: s.seen + 1 }));
		expect(next).toEqual({ id: "a", seen: 1, routed: 0, costUsd: 0 });
	});
});

const trial: TrialConfig = {
	id: "t1",
	role: "implementer",
	model: "zai/glm-5",
	share: 0.25,
	maxSpawns: 2,
	startsAt: "2026-11-20T00:00:00.000Z",
	endsAt: "2026-11-21T00:00:00.000Z",
	budgetUsd: 2,
};
const NOW = Date.parse("2026-11-20T12:00:00.000Z");

describe("trials", () => {
	test("phase follows time, spawns and budget; bad dates end the trial", () => {
		expect(trialPhase(trial, undefined, Date.parse("2026-11-19T00:00:00.000Z"))).toEqual({ phase: "pending" });
		expect(trialPhase(trial, undefined, NOW)).toEqual({ phase: "active" });
		expect(trialPhase(trial, undefined, Date.parse(trial.endsAt))).toEqual({ phase: "ended", endReason: "time" });
		expect(trialPhase(trial, { id: "t1", seen: 9, routed: 2, costUsd: 0 }, NOW)).toEqual({ phase: "ended", endReason: "spawns" });
		expect(trialPhase(trial, { id: "t1", seen: 1, routed: 1, costUsd: 2 }, NOW)).toEqual({ phase: "ended", endReason: "budget" });
		expect(trialPhase({ ...trial, endsAt: "soon" }, undefined, NOW)).toEqual({ phase: "ended", endReason: "time" });
		expect(trialPhase(trial, { id: "t1", seen: 1, routed: 0, costUsd: 0, endedAt: "2026-11-20T01:00:00.000Z", endReason: "budget" }, NOW)).toEqual({
			phase: "ended",
			endReason: "budget",
		});
	});

	test("share routes deterministically", () => {
		const pattern = (share: number, n: number): boolean[] => {
			let seen = 0;
			let routed = 0;
			const out: boolean[] = [];
			for (let i = 0; i < n; i++) {
				const go = shouldRouteToTrial({ ...trial, share }, { id: "t1", seen, routed, costUsd: 0 });
				out.push(go);
				seen++;
				if (go) routed++;
			}
			return out;
		};
		expect(pattern(0.25, 8)).toEqual([false, false, false, true, false, false, false, true]);
		expect(pattern(0.5, 4)).toEqual([false, true, false, true]);
		expect(pattern(1, 3)).toEqual([true, true, true]);
		expect(pattern(0.3, 10).filter(Boolean)).toHaveLength(3);
		expect(shouldRouteToTrial(trial, undefined)).toBe(false);
	});

	test("activeTrialFor picks the first active trial of the role", () => {
		const later: TrialConfig = { ...trial, id: "t2" };
		const c: StormConfig = { ...config, trials: [{ ...trial, startsAt: "2026-11-21T00:00:00.000Z", endsAt: "2026-11-22T00:00:00.000Z" }, later] };
		expect(activeTrialFor(c, "implementer", {}, NOW)?.id).toBe("t2");
		expect(activeTrialFor(c, "explorer", {}, NOW)).toBeUndefined();
		expect(activeTrialFor(config, "implementer", {}, NOW)).toBeUndefined();
	});
});
