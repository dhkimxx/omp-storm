import { afterEach, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { configHash } from "../src/config/canonical.ts";
import { canonicalResourceKey, MAX_JOB_TIMEOUT_MS, validateConfig } from "../src/config/schema.ts";
import { MAX_CHECK_OUTPUT_BYTES } from "../src/runtime/checks.ts";
import {
	DEFAULT_JOB_TIMEOUT_MS,
	type JobExecutionReceipt,
	runConfiguredJob,
} from "../src/runtime/job-executor.ts";
import type { ConfiguredJob } from "../src/types.ts";
import { TEAM } from "./support.ts";

const dirs: string[] = [];
async function tempRoot(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "storm-jobs-"));
	dirs.push(dir);
	return dir;
}
afterEach(async () => {
	for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function writeScript(root: string, name: string, body: string): Promise<void> {
	await fs.writeFile(path.join(root, name), body);
}

function resourceKey(prefix: string): string {
	return `test:${prefix}:${randomUUID()}`;
}

/** Mirrors the executor's fixed host-global namespace. Tests only create/remove their own unique fence file. */
function lockRoot(): string {
	const base = process.platform === "darwin" || process.platform === "linux" ? "/tmp" : os.tmpdir();
	const uid = typeof process.getuid === "function" ? String(process.getuid()) : "user";
	return path.join(base, `omp-storm-jobs-${uid}`, "v1");
}

function fencePath(dir: string, key: string): string {
	return path.join(dir, `${createHash("sha256").update(key).digest("hex")}.lock`);
}

function runJob(
	job: ConfiguredJob,
	cwd: string,
	resourceKeys: readonly string[],
	options: { signal?: AbortSignal; canStart?: () => boolean | Promise<boolean> } = {},
): Promise<JobExecutionReceipt> {
	return runConfiguredJob({
		job,
		cwd,
		resourceKeys,
		...(options.signal === undefined ? {} : { signal: options.signal }),
		...(options.canStart === undefined ? {} : { canStart: options.canStart }),
	});
}

async function waitForFile(file: string, timeoutMs = 3_000): Promise<void> {
	const started = Date.now();
	while (!(await Bun.file(file).exists())) {
		if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${file}`);
		await Bun.sleep(10);
	}
}

/** A short-lived job that runs a script file in the test root. */
function writerJob(name: string, script: string): ConfiguredJob {
	return { name, argv: [process.execPath, script], timeoutMs: 10_000 };
}

describe("configured jobs schema", () => {
	const withJobs = (jobs: unknown): Record<string, unknown> => ({ ...structuredClone(TEAM), jobs });

	test("jobs are a known ordered field; absent keeps the hash, present joins it", () => {
		const absent = validateConfig(structuredClone(TEAM));
		expect(absent.errors).toEqual([]);
		expect(absent.config).not.toHaveProperty("jobs");

		const jobs: ConfiguredJob[] = [
			{ name: "eval", argv: ["bun", "run", "eval"] },
			{ name: "gpu-eval", argv: ["bun", "run", "gpu-eval"], resources: ["gpu:0", "repo:shared"], timeoutMs: 60_000 },
		];
		const present = validateConfig(withJobs(jobs));
		expect(present.errors).toEqual([]);
		expect(present.warnings).toEqual([]);
		expect(present.config?.jobs).toEqual(jobs);
		expect(configHash(present.config!)).not.toBe(configHash(TEAM));

		const empty = validateConfig(withJobs([]));
		expect(empty.errors).toEqual([]);
		expect(configHash(empty.config!)).not.toBe(configHash(TEAM));
	});

	test("names, argv, resources and timeout are bounded and unique", () => {
		const errorsOf = (jobs: unknown) => validateConfig(withJobs(jobs)).errors;
		const has = (jobs: unknown, prefix: string) => errorsOf(jobs).some((error) => error.startsWith(prefix));

		expect(has({}, "jobs:")).toBe(true);
		expect(has([1], "jobs[0]")).toBe(true);
		expect(has([{ name: "", argv: ["x"] }], "jobs[0].name:")).toBe(true);
		expect(has([{ name: " x", argv: ["x"] }], "jobs[0].name:")).toBe(true);
		expect(has([{ name: "x".repeat(81), argv: ["x"] }], "jobs[0].name:")).toBe(true);
		expect(
			has(
				[
					{ name: "x", argv: ["a"] },
					{ name: "x", argv: ["b"] },
				],
				"jobs[1].name:",
			),
		).toBe(true);
		expect(has([{ name: "x" }], "jobs[0].argv:")).toBe(true);
		expect(has([{ name: "x", argv: [] }], "jobs[0].argv:")).toBe(true);
		expect(has([{ name: "x", argv: [1] }], "jobs[0].argv[0]:")).toBe(true);
		expect(has([{ name: "x", argv: [" "] }], "jobs[0].argv[0]:")).toBe(true);
		expect(has([{ name: "x", argv: ["x".repeat(1025)] }], "jobs[0].argv[0]:")).toBe(true);
		expect(has([{ name: "x", argv: Array.from({ length: 33 }, (_, i) => `a${i}`) }], "jobs[0].argv:")).toBe(true);
		expect(has([{ name: "x", argv: Array.from({ length: 5 }, () => "x".repeat(1020)) }], "jobs[0].argv:")).toBe(true);

		expect(has([{ name: "x", argv: ["a"], resources: "gpu:0" }], "jobs[0].resources:")).toBe(true);
		expect(
			has([{ name: "x", argv: ["a"], resources: Array.from({ length: 9 }, (_, i) => `r${i}`) }], "jobs[0].resources:"),
		).toBe(true);
		expect(has([{ name: "x", argv: ["a"], resources: ["bad key"] }], "jobs[0].resources[0]:")).toBe(true);
		expect(has([{ name: "x", argv: ["a"], resources: ["키"] }], "jobs[0].resources[0]:")).toBe(true);
		expect(has([{ name: "x", argv: ["a"], resources: ["gpu:0", "gpu:0"] }], "jobs[0].resources[1]:")).toBe(true);

		expect(has([{ name: "x", argv: ["a"], timeoutMs: 0 }], "jobs[0].timeoutMs:")).toBe(true);
		expect(has([{ name: "x", argv: ["a"], timeoutMs: 1.5 }], "jobs[0].timeoutMs:")).toBe(true);
		expect(has([{ name: "x", argv: ["a"], timeoutMs: MAX_JOB_TIMEOUT_MS + 1 }], "jobs[0].timeoutMs:")).toBe(true);

		expect(has(Array.from({ length: 17 }, (_, i) => ({ name: `j${i}`, argv: [`v${i}`] })), "jobs:")).toBe(true);
	});

	test("unknown job fields warn, unsafe text is refused, and a valid list round-trips", () => {
		const valid = validateConfig(
			withJobs([
				{ name: "eval", argv: ["bun", "run", "eval"], resources: ["gpu:0"], timeoutMs: 1_000 },
				{ name: "note", argv: ["bun", "run", "note"], extra: true },
			]),
		);
		expect(valid.errors).toEqual([]);
		expect(valid.warnings).toEqual(["jobs[1].extra: 알 수 없는 필드입니다"]);
		expect(valid.config?.jobs?.[0]?.resources).toEqual(["gpu:0"]);
		expect(valid.config?.jobs?.[1]?.argv).toEqual(["bun", "run", "note"]);

		const unsafe = validateConfig(withJobs([{ name: "bad\u001b[31m", argv: ["bun"] }]));
		expect(unsafe.config).toBeUndefined();
		expect(unsafe.errors.some((error) => error.includes("jobs[0].name"))).toBe(true);
	});

	test("resource keys are canonical, portable and case-sensitive", () => {
		expect(canonicalResourceKey("gpu:0")).toBe("gpu:0");
		expect(canonicalResourceKey("repo:a/b")).toBe("repo:a/b");
		expect(canonicalResourceKey("tree:Main-1")).toBe("tree:Main-1");
		expect(canonicalResourceKey("x".repeat(128))).toBe("x".repeat(128));
		expect(canonicalResourceKey("")).toBeUndefined();
		expect(canonicalResourceKey(" bad")).toBeUndefined();
		expect(canonicalResourceKey("bad key")).toBeUndefined();
		expect(canonicalResourceKey("키")).toBeUndefined();
		expect(canonicalResourceKey("x".repeat(129))).toBeUndefined();
		expect(canonicalResourceKey("GPU:0")).not.toBe(canonicalResourceKey("gpu:0"));
	});
});

describe("runConfiguredJob", () => {
	// Real child processes need the platform clock: fake timers cannot end an OS process or make a queued lock holder
	// finish. These waits are short and only where a real process must actually run.
	test("runs the approved argv literally and records real timestamps and bounded output", async () => {
		const root = await tempRoot();
		await writeScript(root, "print.mjs", "process.stdout.write(process.argv[2] ?? '');\n");
		const argument = "$(touch injected); echo pwned";
		const receipt = await runJob(
			{ name: "literal", argv: [process.execPath, "print.mjs", argument], timeoutMs: 10_000 },
			root,
			[],
		);
		expect(receipt.status).toBe("passed");
		expect(receipt.exitCode).toBe(0);
		expect(receipt.signal).toBeNull();
		expect(receipt.stdout).toEqual({ tail: argument, totalBytes: Buffer.byteLength(argument), truncated: false });
		expect(receipt.stderr).toEqual({ tail: "", totalBytes: 0, truncated: false });
		expect(receipt.startedAt).not.toBeNull();
		expect(receipt.finishedAt).not.toBeNull();
		expect(Date.parse(receipt.startedAt!)).toBeLessThanOrEqual(Date.parse(receipt.finishedAt!));
		expect(receipt.durationMs).toBeGreaterThanOrEqual(0);
		expect(await Bun.file(path.join(root, "injected")).exists()).toBe(false);
	});

	test("a nonzero exit is observable with its real code and stderr", async () => {
		const root = await tempRoot();
		const receipt = await runJob(
			{
				name: "fails",
				argv: [process.execPath, "-e", "process.stdout.write('out'); process.stderr.write('boom'); process.exitCode = 7"],
				timeoutMs: 10_000,
			},
			root,
			[],
		);
		expect(receipt.status).toBe("failed");
		expect(receipt.exitCode).toBe(7);
		expect(receipt.signal).toBeNull();
		expect(receipt.stdout.tail).toBe("out");
		expect(receipt.stderr.tail).toBe("boom");
		expect(receipt.fenceRetained).toBeUndefined();
	});

	test("output beyond the receipt bound is truncated but its real size is kept", async () => {
		const root = await tempRoot();
		const receipt = await runJob(
			{
				name: "large-output",
				argv: [process.execPath, "-e", "process.stdout.write('x'.repeat(70000))"],
				timeoutMs: 10_000,
			},
			root,
			[],
		);
		expect(receipt.status).toBe("passed");
		expect(receipt.stdout.totalBytes).toBe(70_000);
		expect(receipt.stdout.truncated).toBe(true);
		expect(Buffer.byteLength(receipt.stdout.tail)).toBe(MAX_CHECK_OUTPUT_BYTES);
	});

	test("different resource keys overlap", async () => {
		const root = await tempRoot();
		await writeScript(
			root,
			"wait-a.mjs",
			`import { existsSync, writeFileSync } from "node:fs";
writeFileSync("a.flag", "");
const started = Date.now();
const wait = () => {
	if (existsSync("b.flag")) { writeFileSync("overlap.done", "a"); process.exit(0); }
	if (Date.now() - started > 3000) process.exit(9);
	setTimeout(wait, 10);
};
wait();
`,
		);
		await writeScript(
			root,
			"wait-b.mjs",
			`import { existsSync, writeFileSync } from "node:fs";
writeFileSync("b.flag", "");
const started = Date.now();
const wait = () => {
	if (existsSync("a.flag")) { writeFileSync("overlap.done", "b"); process.exit(0); }
	if (Date.now() - started > 3000) process.exit(9);
	setTimeout(wait, 10);
};
wait();
`,
		);
		const [a, b] = await Promise.all([
			runJob(writerJob("a", "wait-a.mjs"), root, [resourceKey("overlap-a")]),
			runJob(writerJob("b", "wait-b.mjs"), root, [resourceKey("overlap-b")]),
		]);
		expect([a.status, b.status]).toEqual(["passed", "passed"]);
		expect(await Bun.file(path.join(root, "overlap.done")).exists()).toBe(true);
	});

	test("the same resource key serializes", async () => {
		const root = await tempRoot();
		await writeScript(
			root,
			"append.mjs",
			`import { appendFileSync } from "node:fs";
appendFileSync("order.log", process.argv[2] + "-start\\n");
setTimeout(() => {
	appendFileSync("order.log", process.argv[2] + "-end\\n");
	process.exit(0);
}, Number(process.argv[3]));
`,
		);
		const key = resourceKey("serial");
		const [a, b] = await Promise.all([
			runJob({ name: "a", argv: [process.execPath, "append.mjs", "a", "120"], timeoutMs: 10_000 }, root, [key]),
			runJob({ name: "b", argv: [process.execPath, "append.mjs", "b", "40"], timeoutMs: 10_000 }, root, [key]),
		]);
		expect([a.status, b.status]).toEqual(["passed", "passed"]);
		const lines = (await fs.readFile(path.join(root, "order.log"), "utf8")).trim().split("\n");
		expect(lines).toHaveLength(4);
		const pairs = lines.map((line) => line.split("-")[0]);
		expect(pairs[0]).toBe(pairs[1]);
		expect(pairs[2]).toBe(pairs[3]);
		expect(pairs[0]).not.toBe(pairs[2]);
	});

	test("multi-key sets acquire in a stable order and do not deadlock", async () => {
		const root = await tempRoot();
		await writeScript(
			root,
			"append-set.mjs",
			`import { appendFileSync } from "node:fs";
appendFileSync("set.log", process.argv[2] + "-start\\n");
setTimeout(() => {
	appendFileSync("set.log", process.argv[2] + "-end\\n");
	process.exit(0);
}, 80);
`,
		);
		const left = resourceKey("set-left");
		const right = resourceKey("set-right");
		const [a, b] = await Promise.all([
			// The same two keys in opposite array order must still acquire in one global order.
			runJob({ name: "a", argv: [process.execPath, "append-set.mjs", "a"], timeoutMs: 3_000 }, root, [right, left]),
			runJob({ name: "b", argv: [process.execPath, "append-set.mjs", "b"], timeoutMs: 3_000 }, root, [left, right]),
		]);
		expect([a.status, b.status]).toEqual(["passed", "passed"]);
		const lines = (await fs.readFile(path.join(root, "set.log"), "utf8")).trim().split("\n");
		expect(lines).toHaveLength(4);
		const pairs = lines.map((line) => line.split("-")[0]);
		expect(pairs[0]).toBe(pairs[1]);
		expect(pairs[2]).toBe(pairs[3]);
		expect(pairs[0]).not.toBe(pairs[2]);
	});

	test("abort while queued does not execute the waiting job", async () => {
		const root = await tempRoot();
		await writeScript(
			root,
			"holder.mjs",
			`import { writeFileSync } from "node:fs";
writeFileSync("holder.started", String(process.pid));
setTimeout(() => { writeFileSync("holder.done", "yes"); process.exit(0); }, 500);
`,
		);
		await writeScript(root, "waiter.mjs", `require("node:fs").writeFileSync("waiter.ran", "yes");\n`);
		const key = resourceKey("abort");
		const holder = runJob(writerJob("holder", "holder.mjs"), root, [key]);
		await waitForFile(path.join(root, "holder.started"));
		const controller = new AbortController();
		const waiter = runJob(writerJob("waiter", "waiter.mjs"), root, [key], { signal: controller.signal });
		await Bun.sleep(80);
		controller.abort();
		const waiting = await waiter;
		expect(waiting.status).toBe("unrun");
		expect(waiting.startedAt).toBeNull();
		expect(waiting.detail).toContain("취소");
		expect(await Bun.file(path.join(root, "waiter.ran")).exists()).toBe(false);
		const held = await holder;
		expect(held.status).toBe("passed");
		await Bun.sleep(80);
		expect(await Bun.file(path.join(root, "waiter.ran")).exists()).toBe(false);
	});

	test("resource waiting is bounded by the job timeout", async () => {
		const root = await tempRoot();
		await writeScript(
			root,
			"holder.mjs",
			`import { writeFileSync } from "node:fs";
writeFileSync("holder.started", "yes");
setTimeout(() => { writeFileSync("holder.done", "yes"); process.exit(0); }, 500);
`,
		);
		await writeScript(root, "waiter.mjs", `require("node:fs").writeFileSync("waiter.ran", "yes");\n`);
		const key = resourceKey("queue-bound");
		const holder = runJob(writerJob("holder", "holder.mjs"), root, [key]);
		await waitForFile(path.join(root, "holder.started"));
		const waiter = await runJob(
			{ name: "waiter", argv: [process.execPath, "waiter.mjs"], timeoutMs: 100 },
			root,
			[key],
		);
		expect(waiter.status).toBe("unrun");
		expect(waiter.startedAt).toBeNull();
		expect(waiter.detail).toContain("대기 시간 한도");
		expect(await Bun.file(path.join(root, "waiter.ran")).exists()).toBe(false);
		expect((await holder).status).toBe("passed");
	});

	test("canStart is revalidated after the queue lock and a false answer releases it", async () => {
		const root = await tempRoot();
		await writeScript(
			root,
			"holder.mjs",
			`import { writeFileSync } from "node:fs";
writeFileSync("holder.started", "yes");
setTimeout(() => { writeFileSync("holder.done", "yes"); process.exit(0); }, 200);
`,
		);
		await writeScript(root, "waiter.mjs", `require("node:fs").writeFileSync("waiter.ran", "yes");\n`);
		const key = resourceKey("can-start");
		const holder = runJob(writerJob("holder", "holder.mjs"), root, [key]);
		await waitForFile(path.join(root, "holder.started"));
		let sawHolderDone = false;
		const waiter = runJob(writerJob("waiter", "waiter.mjs"), root, [key], {
			canStart: async () => {
				sawHolderDone = await Bun.file(path.join(root, "holder.done")).exists();
				return false;
			},
		});
		const [held, waiting] = await Promise.all([holder, waiter]);
		expect(held.status).toBe("passed");
		expect(sawHolderDone).toBe(true);
		expect(waiting.status).toBe("unrun");
		expect(waiting.detail).toContain("시작 조건");
		expect(await Bun.file(path.join(root, "waiter.ran")).exists()).toBe(false);

		// The fence must be free now: a third job with the same key can run.
		const after = await runJob(writerJob("after", "waiter.mjs"), root, [key]);
		expect(after.status).toBe("passed");
	});

	test("a timeout tears down the child's process group and releases the fence", async () => {
		const root = await tempRoot();
		await writeScript(
			root,
			"tree.mjs",
			`import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const child = spawn(process.execPath, ["-e", "setTimeout(() => require('node:fs').writeFileSync('grandchild.ran','x'), 400)"], { stdio: "ignore" });
writeFileSync("parent.started", String(child.pid));
setTimeout(() => {}, 10000);
`,
		);
		const key = resourceKey("timeout");
		const receipt = await runJob(
			{ name: "tree", argv: [process.execPath, "tree.mjs"], timeoutMs: 100 },
			root,
			[key],
		);
		expect(receipt.status).toBe("timed-out");
		expect(receipt.fenceRetained).toBeUndefined();
		expect(receipt.detail).toContain("시간 한도");
		await Bun.sleep(700);
		expect(await Bun.file(path.join(root, "grandchild.ran")).exists()).toBe(false);
		const after = await runJob(
			{ name: "after-timeout", argv: [process.execPath, "-e", "process.exit(0)"], timeoutMs: 5_000 },
			root,
			[key],
		);
		expect(after.status).toBe("passed");
	});

	test("a spawn error is observable and does not keep the fence", async () => {
		const root = await tempRoot();
		const key = resourceKey("spawn-error");
		const failed = await runJob(
			{ name: "missing", argv: ["omp-storm-no-such-executable-for-jobs-test"], timeoutMs: 1_000 },
			root,
			[key],
		);
		expect(failed.status).toBe("spawn-error");
		expect(failed.exitCode).toBeNull();
		expect(failed.detail).toContain("실행하지 못했습니다");
		expect(failed.fenceRetained).toBeUndefined();

		await writeScript(root, "ok.mjs", "process.exit(0);\n");
		const after = await runJob(writerJob("after-spawn-error", "ok.mjs"), root, [key]);
		expect(after.status).toBe("passed");
	});

	test("a fence whose recorded owner is dead is not reclaimed automatically", async () => {
		const root = await tempRoot();
		const key = resourceKey("dead-fence");
		const dir = lockRoot();
		await fs.mkdir(dir, { recursive: true, mode: 0o700 });
		const fence = fencePath(await fs.realpath(dir), key);
		// This process's pid with a different process start is a record from a dead prior process; a detached child
		// group from that process could still be running, so the fence must stay.
		const record = {
			schema: "storm.job-resource/v1",
			key,
			owner: { token: randomUUID(), pid: process.pid, host: os.hostname(), processStart: 1 },
			acquiredAt: new Date().toISOString(),
		};
		await fs.writeFile(fence, `${JSON.stringify(record)}\n`, { mode: 0o600 });
		try {
			await writeScript(root, "ran.mjs", `require("node:fs").writeFileSync("ran", "yes");\n`);
			const receipt = await runJob(
				{ name: "blocked", argv: [process.execPath, "ran.mjs"], timeoutMs: 1_000 },
				root,
				[key],
			);
			expect(receipt.status).toBe("unrun");
			expect(receipt.startedAt).toBeNull();
			expect(receipt.fenceRetained).toBeUndefined();
			expect(receipt.detail).toContain("자동으로 지우지 않았습니다");
			expect(receipt.detail).toContain("자식 프로세스");
			expect(receipt.detail).toContain(fence);
			expect(await Bun.file(path.join(root, "ran")).exists()).toBe(false);
			expect(await Bun.file(fence).exists()).toBe(true);
			const kept = JSON.parse(await fs.readFile(fence, "utf8")) as { owner: { token: string } };
			expect(kept.owner.token).toBe(record.owner.token);
		} finally {
			await fs.unlink(fence).catch(() => undefined);
		}
	});

	test("the same key is exclusive across separate processes even with different TMPDIR values", async () => {
		const root = await tempRoot();
		await writeScript(
			root,
			"exclusive.mjs",
			`import { unlinkSync, writeFileSync } from "node:fs";
try {
	writeFileSync("busy.flag", process.argv[2], { flag: "wx" });
} catch {
	process.exit(42);
}
setTimeout(() => {
	try { unlinkSync("busy.flag"); } catch {}
	process.exit(0);
}, 150);
`,
		);
		const executor = pathToFileURL(path.join(import.meta.dir, "..", "src", "runtime", "job-executor.ts")).href;
		await writeScript(
			root,
			"helper.mjs",
			`import { runConfiguredJob } from ${JSON.stringify(executor)};
const [name, key] = process.argv.slice(2);
const receipt = await runConfiguredJob({
	job: { name, argv: [process.execPath, "exclusive.mjs", name], timeoutMs: 10000 },
	cwd: ${JSON.stringify(root)},
	resourceKeys: [key],
});
process.stdout.write(JSON.stringify(receipt));
`,
		);
		const key = resourceKey("cross-process");
		const tmpA = path.join(root, "tmp-a");
		const tmpB = path.join(root, "tmp-b");
		await fs.mkdir(tmpA);
		await fs.mkdir(tmpB);
		const runHelper = async (name: string, tmpDir: string) => {
			const proc = Bun.spawn([process.execPath, "helper.mjs", name, key], {
				cwd: root,
				stdout: "pipe",
				stderr: "pipe",
				env: { ...process.env, TMPDIR: tmpDir },
			});
			const [stdout, stderr, code] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);
			if (code !== 0) throw new Error(`helper ${name} failed (${code}): ${stderr}`);
			return JSON.parse(stdout) as JobExecutionReceipt;
		};
		// Different TMPDIR values must still name one host-global fence namespace.
		const [a, b] = await Promise.all([runHelper("a", tmpA), runHelper("b", tmpB)]);
		expect([a.status, b.status]).toEqual(["passed", "passed"]);
		expect(await Bun.file(path.join(root, "busy.flag")).exists()).toBe(false);
	});
});

test("the configured timeout default is finite and below the schema maximum", () => {
	expect(DEFAULT_JOB_TIMEOUT_MS).toBeGreaterThan(0);
	expect(DEFAULT_JOB_TIMEOUT_MS).toBeLessThanOrEqual(MAX_JOB_TIMEOUT_MS);
});
