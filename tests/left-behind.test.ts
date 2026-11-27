/**
 * A command's end is an empty process group, not the leader's exit (G1). A member of the group that redirected its
 * output keeps neither pipe, so the leader's `close` can arrive while it still runs and writes. Each test starts real
 * processes; the descendants are plain `node -e` programs that write a file after a delay.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	PROCESS_GROUP_LIMIT,
	runBoundedProcess,
	runRequiredChecks,
	type CheckReport,
} from "../src/runtime/checks.ts";
import { configHash } from "../src/config/canonical.ts";
import { runConfiguredJob, targetJobBlock } from "../src/runtime/job-executor.ts";
import { DEFAULT_TIMINGS, type StormTimings } from "../src/runtime/timings.ts";
import type { ApprovalRecord, ConfigLoad, StormConfig } from "../src/types.ts";
import { approvalRecord } from "./fixtures.ts";
import { TEST_TIMINGS } from "./timings.ts";
import { TEAM } from "./support.ts";

const dirs: string[] = [];
const strays: number[] = [];
async function tempRoot(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "storm-left-"));
	dirs.push(dir);
	return dir;
}
afterEach(async () => {
	for (const pid of strays.splice(0)) {
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			// Already gone.
		}
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// Already gone.
		}
	}
	for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

const alive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};
const exists = (file: string): Promise<boolean> => Bun.file(file).exists();
async function pidIn(root: string, name = "child.pid"): Promise<number> {
	return Number(await fs.readFile(path.join(root, name), "utf8"));
}
async function waitFor(file: string, ms = 5_000): Promise<void> {
	const until = performance.now() + ms;
	while (!(await exists(file))) {
		if (performance.now() > until) throw new Error(`timed out waiting for ${file}`);
		await Bun.sleep(10);
	}
}

/** The descendant: records its pid, optionally ignores SIGTERM, and writes `late.txt` after `lateMs`. */
function descendant(opts: { lateMs: number; ignoreTerm?: boolean }): string {
	return (
		`const fs=require('node:fs');` +
		(opts.ignoreTerm === true ? `process.on('SIGTERM',()=>{});` : "") +
		`fs.writeFileSync('child.pid',String(process.pid));` +
		`setTimeout(()=>{fs.writeFileSync('late.txt','descendant wrote after the leader exited');process.exit(0)},${opts.lateMs});`
	);
}

/**
 * Source of a leader that starts one descendant (stdio ignored, so it holds no pipe and `close` does not wait for it),
 * waits until the descendant exists, then exits with `exitCode`. `detached` puts the descendant in its own session.
 */
function leader(child: string, opts: { exitCode?: number; detached?: boolean; stay?: boolean } = {}): string {
	return (
		`const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(child)}],` +
		`{stdio:'ignore',detached:${opts.detached === true}});c.unref();` +
		`const fs=require('node:fs');while(!fs.existsSync('child.pid')){}` +
		(opts.stay === true ? `setTimeout(()=>{},60000);` : `process.exit(${opts.exitCode ?? 0});`)
	);
}

const run = (cwd: string, source: string, timeoutMs = 10_000, signal?: AbortSignal, timings: StormTimings = TEST_TIMINGS) =>
	runBoundedProcess({
		argv: [process.execPath, "-e", source],
		cwd,
		timeoutMs,
		outputLimitBytes: 4_096,
		timings,
		...(signal === undefined ? {} : { signal }),
	});

describe("the end of a command is an empty process group", () => {
	test("a member left behind by a clean exit is stopped before the end is reported, and the run does not count as passed", async () => {
		const cwd = await tempRoot();
		const result = await run(cwd, leader(descendant({ lateMs: 300 })));
		const pid = await pidIn(cwd);
		strays.push(pid);
		expect(result.processEnded).toBe(true);
		// Nothing of the command is left, so nothing can write after the end was reported.
		expect(alive(pid)).toBe(false);
		// The descendant writes late.txt only if it outlived the stop; the real clock is the proof that it did not.
		await Bun.sleep(450);
		expect(await exists(path.join(cwd, "late.txt"))).toBe(false);
		// The leader's own code is kept as observed, but a command cut off mid-work did not pass.
		expect(result.exitCode).toBe(0);
		expect(result.status).toBe("failed");
		expect(result.note).toBeDefined();
		await result.ended;
	});

	test("a non-zero exit with a member left behind is stopped too", async () => {
		const cwd = await tempRoot();
		const result = await run(cwd, leader(descendant({ lateMs: 300 }), { exitCode: 3 }));
		const pid = await pidIn(cwd);
		strays.push(pid);
		expect(result.processEnded).toBe(true);
		expect(result.status).toBe("failed");
		expect(result.exitCode).toBe(3);
		expect(alive(pid)).toBe(false);
		// The descendant writes late.txt only if it outlived the stop; the real clock is the proof that it did not.
		await Bun.sleep(450);
		expect(await exists(path.join(cwd, "late.txt"))).toBe(false);
	});

	test("a member that ignores SIGTERM is killed after the grace, still before the end is reported", async () => {
		const cwd = await tempRoot();
		const result = await run(cwd, leader(descendant({ lateMs: 1_500, ignoreTerm: true })), 10_000, undefined, DEFAULT_TIMINGS);
		const pid = await pidIn(cwd);
		strays.push(pid);
		expect(result.processEnded).toBe(true);
		expect(result.durationMs).toBeGreaterThanOrEqual(900);
		expect(alive(pid)).toBe(false);
		// The SIGKILLed member would have written late.txt by now had the grace let it live; only the real clock proves it did not.
		await Bun.sleep(700);
		expect(await exists(path.join(cwd, "late.txt"))).toBe(false);
	}, 15_000);

	test("a timeout whose leader dies on SIGTERM still kills a member that ignores it", async () => {
		const cwd = await tempRoot();
		const result = await run(cwd, leader(descendant({ lateMs: 1_500, ignoreTerm: true }), { stay: true }), 300, undefined, DEFAULT_TIMINGS);
		const pid = await pidIn(cwd);
		strays.push(pid);
		expect(result.status).toBe("timed-out");
		expect(result.processEnded).toBe(true);
		expect(alive(pid)).toBe(false);
		// The SIGKILLed member would have written late.txt by now had the grace let it live; only the real clock proves it did not.
		await Bun.sleep(700);
		expect(await exists(path.join(cwd, "late.txt"))).toBe(false);
	}, 15_000);

	test("an abort whose leader dies on SIGTERM still kills a member that ignores it", async () => {
		const cwd = await tempRoot();
		const abort = new AbortController();
		const running = run(cwd, leader(descendant({ lateMs: 1_500, ignoreTerm: true }), { stay: true }), 30_000, abort.signal, DEFAULT_TIMINGS);
		await waitFor(path.join(cwd, "child.pid"));
		abort.abort();
		const result = await running;
		const pid = await pidIn(cwd);
		strays.push(pid);
		expect(result.status).toBe("cancelled");
		expect(result.processEnded).toBe(true);
		expect(alive(pid)).toBe(false);
		// The member would have written late.txt by now had SIGKILL not landed; only the real clock can prove it did not.
		await Bun.sleep(700);
		expect(await exists(path.join(cwd, "late.txt"))).toBe(false);
	}, 15_000);

	test("a member that holds the output pipe is still waited for and is not a leftover", async () => {
		const cwd = await tempRoot();
		const child = `require('node:fs').writeFileSync('child.pid',String(process.pid));setTimeout(()=>require('node:fs').writeFileSync('late.txt','x'),200);`;
		const source =
			`const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:'inherit'});c.unref();` +
			`const fs=require('node:fs');while(!fs.existsSync('child.pid')){}process.exit(0);`;
		const result = await run(cwd, source);
		expect(result.status).toBe("passed");
		expect(result.processEnded).toBe(true);
		expect(await exists(path.join(cwd, "late.txt"))).toBe(true);
	});

	test("a member that left the group is not seen: the limit the user is told about", async () => {
		const cwd = await tempRoot();
		const result = await run(cwd, leader(descendant({ lateMs: 5_000 }), { detached: true }));
		const pid = await pidIn(cwd);
		strays.push(pid);
		// Its own session: the group the runner can ask about is empty, so the run passes while this still lives.
		expect(result.status).toBe("passed");
		expect(result.processEnded).toBe(true);
		expect(alive(pid)).toBe(true);
		expect(PROCESS_GROUP_LIMIT).toContain("setsid");
		expect(PROCESS_GROUP_LIMIT).toContain("Windows");
	});
});

describe("a configured job keeps its fence until the group is empty", () => {
	test("the next job for the same key and target starts only after the first job's members are gone", async () => {
		const cwd = await tempRoot();
		await fs.writeFile(path.join(cwd, "lead.mjs"), leader(descendant({ lateMs: 400 })));
		await fs.writeFile(
			path.join(cwd, "next.mjs"),
			`import {existsSync,writeFileSync} from 'node:fs'; writeFileSync('next-started.txt', existsSync('child.pid')?'seen':'none');`,
		);
		const key = `test:left-behind:${randomUUID()}`;
		const first = await runConfiguredJob({
			job: { name: "first", argv: [process.execPath, "lead.mjs"], timeoutMs: 10_000 },
			cwd,
			resourceKeys: [key],
			targetFence: true,
			timings: TEST_TIMINGS,
		});
		const pid = await pidIn(cwd);
		strays.push(pid);
		// The fence is released only now, and only because nothing of the first job is left.
		expect(first.fence).toBeUndefined();
		expect(await targetJobBlock(cwd)).toBeUndefined();
		expect(alive(pid)).toBe(false);
		expect(first.status).toBe("failed");
		expect(first.exitCode).toBe(0);
		expect(first.detail).toBeDefined();
		const second = await runConfiguredJob({
			job: { name: "second", argv: [process.execPath, "next.mjs"], timeoutMs: 10_000 },
			cwd,
			resourceKeys: [key],
			targetFence: true,
			timings: TEST_TIMINGS,
		});
		expect(second.status).toBe("passed");
		// The first job's member would have written late.txt by now had the fence released before its group emptied.
		await Bun.sleep(600);
		expect(await exists(path.join(cwd, "late.txt"))).toBe(false);
	}, 15_000);
});

/** Makes the OS answer "a member still exists" for every group probe, as a member stuck in the kernel would. */
function stuckGroup(code: "EPERM" | "EIO" | "alive") {
	const real = process.kill.bind(process);
	let stuck = true;
	const spy = spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
		if (stuck && pid < 0 && signal === 0) {
			if (code === "alive") return true;
			throw Object.assign(new Error(code), { code });
		}
		return real(pid, signal as NodeJS.Signals | number);
	}) as typeof process.kill);
	return {
		release: (): void => {
			stuck = false;
		},
		restore: (): void => spy.mockRestore(),
	};
}

describe("an end that cannot be proven keeps the fence", () => {
	for (const code of ["alive", "EPERM", "EIO"] as const) {
		test(`a group the OS keeps reporting as occupied (${code}) keeps the target marker until it is empty`, async () => {
			const cwd = await tempRoot();
			await fs.writeFile(path.join(cwd, "lead.mjs"), leader(descendant({ lateMs: 200 })));
			await fs.writeFile(path.join(cwd, "ok.mjs"), "process.exit(0);\n");
			const stuck = stuckGroup(code);
			const key = `test:left-behind:${randomUUID()}`;
			try {
				const first = await runConfiguredJob({
					job: { name: "stuck", argv: [process.execPath, "lead.mjs"], timeoutMs: 10_000 },
					cwd,
					resourceKeys: [key],
					targetFence: true,
					timings: TEST_TIMINGS,
				});
				strays.push(await pidIn(cwd));
				expect(first.fence?.cause).toBe("process-unproven");
				expect(first.status).toBe("failed");
				expect(await targetJobBlock(cwd)).toBeDefined();
				// Another job for the same resource cannot start while the end is unproven (its queue wait is bounded).
				const blocked = await runConfiguredJob({
					job: { name: "after", argv: [process.execPath, "ok.mjs"], timeoutMs: 300 },
					cwd,
					resourceKeys: [key],
					targetFence: true,
					timings: TEST_TIMINGS,
				});
				expect(blocked.status).toBe("unrun");
				expect(blocked.unrunCause).toBe("queue-timeout");
				// The receipt carries the proof to come, so the run can lift its own fence on the same event (R-G1 over-eager 2).
				expect(first.ended).toBeDefined();
				let proven = false;
				void first.ended?.then(() => {
					proven = true;
				});
				await Bun.sleep(100);
				expect(proven).toBe(false);
				// The OS now reports the group empty: exactly this attempt's marker is released.
				stuck.release();
				const until = performance.now() + 5_000;
				while ((await targetJobBlock(cwd)) !== undefined && performance.now() < until) await Bun.sleep(50);
				expect(await targetJobBlock(cwd)).toBeUndefined();
				expect(proven).toBe(true);
				const free = await runConfiguredJob({
					job: { name: "free", argv: [process.execPath, "ok.mjs"], timeoutMs: 10_000 },
					cwd,
					resourceKeys: [key],
					targetFence: true,
					timings: TEST_TIMINGS,
				});
				expect(free.status).toBe("passed");
			} finally {
				stuck.restore();
			}
		}, 30_000);
	}

	test("a required check whose end is unproven stops the later checks and says so", async () => {
		const cwd = await tempRoot();
		const config = loaded({
			...TEAM,
			requiredChecks: [
				{ name: "first", argv: [process.execPath, "-e", leader(descendant({ lateMs: 200 }))] },
				{ name: "second", argv: [process.execPath, "-e", `require('node:fs').writeFileSync('second.ran','x')`] },
			],
		});
		const stuck = stuckGroup("alive");
		const seen: string[] = [];
		let report: CheckReport;
		try {
			const result = await runRequiredChecks({
				config,
				approval: approved(config.hash),
				cwd,
				fingerprint: "tree-1",
				timings: TEST_TIMINGS,
				onEndUnproven: (info) => seen.push(info.check),
			});
			if (result.status === "skipped") throw new Error("checks skipped");
			report = result;
			strays.push(await pidIn(cwd));
		} finally {
			stuck.release();
			stuck.restore();
		}
		expect(seen).toEqual(["first"]);
		expect(report.endUnproven).toEqual({ check: "first" });
		expect(report.status).toBe("failed");
		expect(report.complete).toBe(false);
		expect(report.checks.map((check) => check.status)).toEqual(["failed", "unrun"]);
		expect(await exists(path.join(cwd, "second.ran"))).toBe(false);
	}, 30_000);

	test("a required check that left a member behind did not pass and the member is gone before the next one starts", async () => {
		const cwd = await tempRoot();
		const config = loaded({
			...TEAM,
			requiredChecks: [
				{ name: "first", argv: [process.execPath, "-e", leader(descendant({ lateMs: 300 }))] },
				{ name: "second", argv: [process.execPath, "-e", `require('node:fs').writeFileSync('second.ran',require('node:fs').existsSync('late.txt')?'late':'quiet')`] },
			],
		});
		const result = await runRequiredChecks({ config, approval: approved(config.hash), cwd, fingerprint: "tree-1", timings: TEST_TIMINGS });
		if (result.status === "skipped") throw new Error("checks skipped");
		strays.push(await pidIn(cwd));
		expect(result.endUnproven).toBeUndefined();
		expect(result.checks.map((check) => check.status)).toEqual(["failed", "passed"]);
		expect(result.checks[0]!.exitCode).toBe(0);
		expect(result.checks[0]!.note).toBeDefined();
		expect(result.status).toBe("failed");
		// The member would have written late.txt by now had it outlived the stop before the next check started.
		await Bun.sleep(500);
		expect(await exists(path.join(cwd, "late.txt"))).toBe(false);
	}, 15_000);
});

function loaded(config: StormConfig): Extract<ConfigLoad, { status: "ok" }> {
	return { status: "ok", path: "/project/.omp/storm/config.json", config, hash: configHash(config), warnings: [] };
}

function approved(hash: string): ApprovalRecord {
	return approvalRecord(hash, { approvedAt: "2026-11-22T00:00:00.000Z" });
}
