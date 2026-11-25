import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { configHash } from "../src/config/canonical.ts";
import {
	checkGate,
	checkTimeoutMs,
	DEFAULT_CHECK_TIMEOUT_MS,
	MAX_CHECK_TIMEOUT_MS,
	type CheckReport,
	type RequiredChecksInput,
	runRequiredChecks,
} from "../src/runtime/checks.ts";
import { renderConfigDiff, renderStatus } from "../src/view/render.ts";
import type { ApprovalRecord, ConfigLoad, RequiredCheck, StatusView, StormConfig } from "../src/types.ts";
import { approvalRecord } from "./fixtures.ts";
import { TEAM } from "./support.ts";

function loaded(config: StormConfig): Extract<ConfigLoad, { status: "ok" }> {
	return { status: "ok", path: "/project/.omp/storm/config.json", config, hash: configHash(config), warnings: [] };
}

function approved(hash: string): ApprovalRecord {
	return approvalRecord(hash, { approvedAt: "2026-11-22T00:00:00.000Z" });
}

const dirs: string[] = [];
async function tempRoot(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "storm-checks-"));
	dirs.push(dir);
	return dir;
}
afterEach(async () => {
	vi.useRealTimers();
	for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function reportOf(input: RequiredChecksInput): Promise<CheckReport> {
	const result = await runRequiredChecks(input);
	if (result.status === "skipped") throw new Error(`checks skipped: ${result.reason}`);
	return result;
}

const checks = (list: RequiredCheck[]): StormConfig => ({ ...TEAM, requiredChecks: list });

describe("check gate", () => {
	test("checks never run without an approved config or without a configured list", async () => {
		const withChecks = loaded(checks([{ name: "write", argv: [process.execPath, "-e", "require('node:fs').writeFileSync('ran', 'yes')"] }]));
		expect(checkGate({ status: "missing", path: "/p" }, undefined)).toEqual({ status: "skipped", reason: "no-config" });
		expect(checkGate({ status: "invalid", path: "/p", errors: ["bad"] }, undefined)).toEqual({ status: "skipped", reason: "invalid-config" });
		expect(checkGate(withChecks, undefined)).toEqual({ status: "skipped", reason: "unapproved" });
		expect(checkGate(withChecks, approved("jcs-sha256:" + "0".repeat(64)))).toEqual({ status: "skipped", reason: "unapproved" });
		expect(checkGate(loaded(TEAM), approved(loaded(TEAM).hash))).toEqual({ status: "skipped", reason: "no-checks" });

		const root = await tempRoot();
		const noApproval = await runRequiredChecks({ config: withChecks, approval: undefined, cwd: root, fingerprint: "tree-1" });
		expect(noApproval).toEqual({ status: "skipped", reason: "unapproved" });
		expect(await Bun.file(path.join(root, "ran")).exists()).toBe(false);
	});

	test("a ready gate keeps the configured order", () => {
		const config = loaded(checks([
			{ name: "unit", argv: ["bun", "test"] },
			{ name: "types", argv: ["bunx", "tsc", "--noEmit"] },
		]));
		const gate = checkGate(config, approved(config.hash));
		expect(gate.status).toBe("ready");
		if (gate.status !== "ready") return;
		expect(gate.configHash).toBe(config.hash);
		expect(gate.checks.map((check) => check.name)).toEqual(["unit", "types"]);
	});
});

describe("runRequiredChecks", () => {
	test("runs argv directly in the target tree and records real status, order and fingerprint", async () => {
		const root = await tempRoot();
		await fs.writeFile(path.join(root, "marker.txt"), "target-tree");
		await fs.writeFile(
			path.join(root, "append.mjs"),
			"import { appendFileSync } from 'node:fs';\nappendFileSync('order.txt', process.argv[2] ?? '');\n",
		);
		const config = loaded(checks([
			{ name: "read", argv: [process.execPath, "-e", "process.stdout.write(require('node:fs').readFileSync('marker.txt', 'utf8'))"] },
			{ name: "first", argv: [process.execPath, "append.mjs", "a"] },
			{ name: "second", argv: [process.execPath, "append.mjs", "b"] },
		]));
		const report = await reportOf({ config, approval: approved(config.hash), cwd: root, fingerprint: "tree-1" });
		expect(report).toMatchObject({ status: "passed", complete: true, aborted: false, configHash: config.hash, fingerprint: "tree-1" });
		expect(report.checks.map((check) => [check.name, check.status, check.exitCode])).toEqual([
			["read", "passed", 0],
			["first", "passed", 0],
			["second", "passed", 0],
		]);
		expect(report.checks[0]!.stdout).toEqual({ tail: "target-tree", totalBytes: 11, truncated: false });
		expect(await Bun.file(path.join(root, "order.txt")).text()).toBe("ab");
		expect(report.checks.every((check) => check.startedAt !== null && check.finishedAt !== null)).toBe(true);
	});

	test("a failing check keeps its real exit status and a bounded output tail", async () => {
		const root = await tempRoot();
		const config = loaded(checks([
			{
				name: "fails loudly",
				argv: [
					process.execPath,
					"-e",
					"process.stdout.write('x'.repeat(5000)); process.stderr.write('bad'); process.exitCode = 7",
				],
			},
		]));
		const report = await reportOf({ config, approval: approved(config.hash), cwd: root, fingerprint: "tree-2", outputLimitBytes: 128 });
		expect(report.status).toBe("failed");
		expect(report.complete).toBe(true);
		const check = report.checks[0]!;
		expect([check.status, check.exitCode]).toEqual(["failed", 7]);
		expect(check.stdout.totalBytes).toBe(5000);
		expect(check.stdout.truncated).toBe(true);
		expect(check.stdout.tail).toBe("x".repeat(128));
		expect(check.stderr).toEqual({ tail: "bad", totalBytes: 3, truncated: false });
	});

	test("a timeout ends the process group and is failed, complete evidence", async () => {
		// The limit bounds a spawned OS process, which fake timers cannot advance; keep the real wait short.
		const root = await tempRoot();
		const config = loaded(checks([{ name: "slow", argv: [process.execPath, "-e", "setTimeout(() => {}, 10000)"], timeoutMs: 50 }]));
		const report = await reportOf({ config, approval: approved(config.hash), cwd: root, fingerprint: "tree-3" });
		expect(report.status).toBe("failed");
		expect(report.complete).toBe(true);
		expect(report.aborted).toBe(false);
		expect(report.checks[0]!.status).toBe("timed-out");
		expect(report.checks[0]!.durationMs).toBeLessThan(8000);
		expect(report.checks[0]!.note).toContain("시간 한도");
	});

	test("a check's own limit is used, and an absent one is the job's ten minutes", () => {
		const plain: RequiredCheck = { name: "unit", argv: ["bun", "test"] };
		expect(DEFAULT_CHECK_TIMEOUT_MS).toBe(10 * 60_000);
		expect(MAX_CHECK_TIMEOUT_MS).toBe(6 * 60 * 60 * 1000);
		expect(checkTimeoutMs(plain)).toBe(DEFAULT_CHECK_TIMEOUT_MS);
		expect(checkTimeoutMs({ ...plain, timeoutMs: 1_800_000 })).toBe(1_800_000);
		// A programmatically built config that skipped validation still cannot run past the job maximum.
		expect(checkTimeoutMs({ ...plain, timeoutMs: MAX_CHECK_TIMEOUT_MS + 1 })).toBe(MAX_CHECK_TIMEOUT_MS);
	});

	test("a limit above the old two-minute cut is not shortened", async () => {
		const root = await tempRoot();
		const config = loaded(checks([
			{ name: "long", argv: [process.execPath, "-e", "setTimeout(() => process.exit(0), 100)"], timeoutMs: 1_800_000 },
		]));
		// Only the runner's deadline is on the fake clock; the child's own timer is real so it exits promptly.
		vi.useFakeTimers();
		try {
			const running = reportOf({ config, approval: approved(config.hash), cwd: root, fingerprint: "tree-3a" });
			// Past the 10-minute job default: an ignored per-check value would have killed the child here.
			vi.advanceTimersByTime(10 * 60_000 + 1);
			const report = await running;
			expect(report.status).toBe("passed");
			expect(report.checks[0]!.status).toBe("passed");
		} finally {
			vi.useRealTimers();
		}
	});

	test("a check without a limit is not cut at two minutes", async () => {
		const root = await tempRoot();
		const config = loaded(checks([{ name: "plain", argv: [process.execPath, "-e", "setTimeout(() => process.exit(0), 100)"] }]));
		vi.useFakeTimers();
		try {
			const running = reportOf({ config, approval: approved(config.hash), cwd: root, fingerprint: "tree-3b" });
			vi.advanceTimersByTime(120_001);
			const report = await running;
			expect(report.status).toBe("passed");
		} finally {
			vi.useRealTimers();
		}
	});

	test("a timed-out check does not lend its limit to the next check", async () => {
		const root = await tempRoot();
		const config = loaded(checks([
			{ name: "short", argv: [process.execPath, "-e", "setTimeout(() => {}, 10000)"], timeoutMs: 50 },
			{ name: "next", argv: [process.execPath, "-e", "process.exit(0)"] },
		]));
		const report = await reportOf({ config, approval: approved(config.hash), cwd: root, fingerprint: "tree-3c" });
		expect(report.status).toBe("failed");
		expect(report.complete).toBe(true);
		expect(report.checks.map((check) => check.status)).toEqual(["timed-out", "passed"]);
	});

	test("abort cancels the running child and leaves later checks unrun", async () => {
		const root = await tempRoot();
		const config = loaded(checks([
			{ name: "slow", argv: [process.execPath, "-e", "setTimeout(() => {}, 10000)"] },
			{ name: "never", argv: [process.execPath, "-e", "process.exit(0)"] },
		]));
		const controller = new AbortController();
		const running = reportOf({
			config,
			approval: approved(config.hash),
			cwd: root,
			fingerprint: "tree-4",
			signal: controller.signal,
		});
		// `reportOf` starts the first child before its first await; abort on the next microtask, not a wall-clock guess.
		queueMicrotask(() => controller.abort());
		const report = await running;
		expect(report.status).toBe("aborted");
		expect([report.aborted, report.complete]).toEqual([true, false]);
		expect(report.checks.map((check) => [check.name, check.status])).toEqual([
			["slow", "cancelled"],
			["never", "unrun"],
		]);
		expect(report.checks[1]!.startedAt).toBeNull();
	});

	test("an already aborted signal runs nothing", async () => {
		const root = await tempRoot();
		const config = loaded(checks([{ name: "one", argv: [process.execPath, "-e", "process.exit(0)"] }]));
		const controller = new AbortController();
		controller.abort();
		const report = await reportOf({
			config,
			approval: approved(config.hash),
			cwd: root,
			fingerprint: "tree-5",
			signal: controller.signal,
		});
		expect(report.status).toBe("aborted");
		expect(report.complete).toBe(false);
		expect(report.checks[0]!.status).toBe("unrun");
	});

	test("a missing executable is spawn-error evidence, not a silent pass", async () => {
		const root = await tempRoot();
		const config = loaded(checks([{ name: "missing", argv: ["omp-storm-no-such-executable-for-checks-test"] }]));
		const report = await reportOf({ config, approval: approved(config.hash), cwd: root, fingerprint: "tree-6" });
		expect(report.status).toBe("failed");
		expect(report.complete).toBe(true);
		expect(report.checks[0]!.status).toBe("spawn-error");
		expect(report.checks[0]!.argv).toEqual(["omp-storm-no-such-executable-for-checks-test"]);
		expect(report.checks[0]!.note).toContain("실행하지 못했습니다");
	});

	test("arguments are literal: no shell interpolation or generated script", async () => {
		const root = await tempRoot();
		await fs.writeFile(path.join(root, "print-arg.mjs"), "process.stdout.write(process.argv[2] ?? '');\n");
		const injected = path.join(root, "injected");
		const argument = `$(touch ${injected}); echo pwned`;
		const config = loaded(checks([{ name: "literal", argv: [process.execPath, "print-arg.mjs", argument] }]));
		const report = await reportOf({ config, approval: approved(config.hash), cwd: root, fingerprint: "tree-7" });
		expect(report.status).toBe("passed");
		expect(report.checks[0]!.stdout.tail).toBe(argument);
		expect(await Bun.file(injected).exists()).toBe(false);
	});
});

describe("public approval summary", () => {
	const withChecks = checks([
		{ name: "unit", argv: ["bun", "test"] },
		{ name: "types", argv: ["bunx", "tsc", "--noEmit"] },
	]);

	test("a new config shows every exact executable and argument", () => {
		const text = renderConfigDiff(undefined, withChecks);
		expect(text).toContain('- 필수 검사 unit: ["bun","test"]');
		expect(text).toContain('- 필수 검사 types: ["bunx","tsc","--noEmit"]');
	});

	test("a diff shows a changed command and a removed obligation in full", () => {
		const changed: StormConfig = {
			...withChecks,
			requiredChecks: [
				{ name: "unit", argv: ["bun", "test", "--", "some test"] },
				{ name: "types", argv: ["bunx", "tsc", "--noEmit"] },
			],
		};
		expect(renderConfigDiff(withChecks, changed)).toContain('- 필수 검사 unit: ["bun","test"] → ["bun","test","--","some test"]');
		expect(renderConfigDiff(changed, withChecks)).toContain('- 필수 검사 unit: ["bun","test","--","some test"] → ["bun","test"]');
		expect(renderConfigDiff(withChecks, { ...withChecks, requiredChecks: [] })).toContain('- 필수 검사 unit 삭제: ["bun","test"]');
		expect(renderConfigDiff(withChecks, { ...withChecks, requiredChecks: [] })).toContain('- 필수 검사 types 삭제: ["bunx","tsc","--noEmit"]');
	});

	test("status lists the approved obligations in full", () => {
		const config = loaded(withChecks);
		const view: StatusView = { config, approval: approved(config.hash), shadows: [] };
		const text = renderStatus(view, Date.now());
		expect(text).toContain('- 필수 검사: unit: ["bun","test"] · types: ["bunx","tsc","--noEmit"]');
	});
});
