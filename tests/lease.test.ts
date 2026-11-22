import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createInterface, type Interface } from "node:readline";
import { acquireRunLease, type LeaseDeps, type RunLease } from "../src/runtime/lease.ts";

let tmp: string;
let root: string;
let leases: string;

beforeEach(async () => {
	tmp = await realpath(await mkdtemp(path.join(os.tmpdir(), "storm-lease-")));
	root = path.join(tmp, "worktree");
	leases = path.join(tmp, "leases");
	await mkdir(root);
});

afterEach(async () => {
	await rm(tmp, { recursive: true, force: true });
});

const deps = (over: LeaseDeps = {}): LeaseDeps => ({ dir: leases, ...over });

async function acquired(target: string, runId: string, over: LeaseDeps = {}): Promise<RunLease> {
	const result = await acquireRunLease(target, runId, deps(over));
	if (!result.ok) throw new Error(`expected a lease: ${result.reason}`);
	return result.lease;
}

async function refused(target: string, runId: string, over: LeaseDeps = {}): Promise<string> {
	const result = await acquireRunLease(target, runId, deps(over));
	if (result.ok) {
		await result.lease.release();
		throw new Error("expected a refusal");
	}
	return result.reason;
}

describe("per-worktree run lease", () => {
	test("one holder per canonical worktree; release opens the slot; the lock is outside the tree", async () => {
		const first = await acquired(root, "run-first");
		expect(first.root).toBe(root);
		expect(path.relative(root, first.path).startsWith("..")).toBe(true);

		const reason = await refused(root, "run-second");
		expect(reason).toContain("run-first");
		expect(reason).toContain("진행 중");

		await first.release();
		const third = await acquired(root, "run-third");
		expect(third.owner.token).not.toBe(first.owner.token);
		await third.release();
	});

	test("an alias path canonicalizes to the same slot", async () => {
		const alias = path.join(tmp, "worktree-alias");
		await symlink(root, alias, "dir");
		expect(await realpath(alias)).toBe(root);

		const first = await acquired(root, "run-via-real");
		expect(await refused(alias, "run-via-alias")).toContain("run-via-real");
		await first.release();

		const second = await acquired(alias, "run-via-alias");
		expect(second.root).toBe(root);
		await second.release();
	});

	test("distinct worktrees have distinct slots", async () => {
		const linked = path.join(tmp, "linked-worktree");
		await mkdir(linked);

		const main = await acquired(root, "run-main");
		const other = await acquired(linked, "run-linked");
		expect(main.path).not.toBe(other.path);
		expect(other.root).toBe(linked);

		await main.release();
		await other.release();
	});

	test("an unreadable or invalid owner fails closed and is never deleted", async () => {
		const holder = await acquired(root, "run-holder");
		await writeFile(holder.path, "{ this is not a lease\n");

		const reason = await refused(root, "run-other");
		expect(reason).toContain("확인할 수 없습니다");
		expect(reason).toContain(holder.path);
		expect(existsSync(holder.path)).toBe(true);

		await expect(holder.release()).rejects.toThrow();
		expect(existsSync(holder.path)).toBe(true);
	});

	test("an owner whose death cannot be proven is refused, not stolen", async () => {
		const holder = await acquired(root, "run-holder");
		const reason = await refused(root, "run-other", { liveness: () => "unknown" });

		expect(reason).toContain("확인할 수 없습니다");
		expect(existsSync(holder.path)).toBe(true);
		await holder.release();
	});

	test("a provably dead owner is reclaimed; the old lease cannot release the new one", async () => {
		const dead = await acquired(root, "run-dead");
		const deadToken = dead.owner.token;
		const reborn = await acquired(root, "run-reborn", {
			liveness: owner => (owner.token === deadToken ? "dead" : "alive"),
		});

		expect(reborn.owner.token).not.toBe(deadToken);
		await expect(dead.release()).rejects.toThrow();
		expect(existsSync(reborn.path)).toBe(true);
		await reborn.release();
	});

	test("a stale reclaim guard refuses instead of resetting or TTL-stealing", async () => {
		const dead = await acquired(root, "run-dead");
		await mkdir(`${dead.path}.reclaim`);

		const reason = await refused(root, "run-other", { liveness: () => "dead" });
		expect(reason).toContain(".reclaim");
		expect(existsSync(dead.path)).toBe(true);

		await rm(`${dead.path}.reclaim`, { recursive: true, force: true });
		await dead.release();
	});

	test("a lock directory inside the worktree is refused before creation", async () => {
		const inside = path.join(root, ".leases");
		const result = await acquireRunLease(root, "run-inside", { dir: inside });
		if (result.ok) {
			await result.lease.release();
			throw new Error("expected a refusal for an in-worktree lock dir");
		}
		expect(result.reason).toContain("worktree 밖");
		expect(existsSync(inside)).toBe(false);
	});

	test("bad roots and run ids refuse without writing anything", async () => {
		const missing = await acquireRunLease(path.join(tmp, "absent"), "run-a", deps());
		if (missing.ok) {
			await missing.lease.release();
			throw new Error("expected a refusal for a missing root");
		}
		expect(missing.reason).toContain("worktree");

		const emptyId = await acquireRunLease(root, "  ", deps());
		if (emptyId.ok) {
			await emptyId.lease.release();
			throw new Error("expected a refusal for an empty run id");
		}
		expect(emptyId.reason).toContain("실행 id");
		expect(existsSync(leases)).toBe(false);
	});
});

// The child runs in a separate OS process, so its import specifier is supplied at test time through LEASE_MODULE;
// a static import cannot know it. The parent releases all children from a stdin barrier at once: no sleep decides who
// starts first, and 20 s of test-runner time is the only watchdog.
const CHILD = String.raw`
(async () => {
	const mod = await import(process.env.LEASE_MODULE);
	const say = async value => {
		const written = Promise.withResolvers();
		process.stdout.write(JSON.stringify(value) + "\n", error => {
			if (error) written.reject(error);
			else written.resolve();
		});
		await written.promise;
	};
	const start = Promise.withResolvers();
	process.stdin.once("data", start.resolve);
	await say({ ready: true });
	await start.promise;
	const result = await mod.acquireRunLease(process.env.LEASE_ROOT, process.env.LEASE_RUN, { dir: process.env.LEASE_DIR });
	if (!result.ok) {
		await say({ ok: false, reason: result.reason });
		process.exit(0);
	}
	const hold = Promise.withResolvers();
	process.stdin.once("data", hold.resolve);
	await say({ ok: true, runId: result.lease.runId, token: result.lease.owner.token, pid: process.pid });
	await hold.promise;
	await result.lease.release();
	process.exit(0);
})().catch(error => {
	process.stderr.write(String((error && error.stack) || error) + "\n");
	process.exit(1);
});
`;

type ChildResult =
	| { ok: true; runId: string; token: string; pid: number }
	| { ok: false; reason: string };

interface Racer {
	proc: ChildProcess;
	label: string;
	rl: Interface;
	lines: AsyncIterator<string>;
	stderr(): string;
}

function stop(proc: ChildProcess): void {
	proc.stdin?.destroy();
	if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
}

function waitExit(proc: ChildProcess): Promise<void> {
	if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
	const { promise, resolve } = Promise.withResolvers<void>();
	proc.once("exit", () => resolve());
	return promise;
}

function spawnRacer(n: number): Racer {
	const moduleUrl = new URL("../src/runtime/lease.ts", import.meta.url).href;
	const proc = spawn(process.execPath, ["-e", CHILD], {
		env: {
			...process.env,
			LEASE_MODULE: moduleUrl,
			LEASE_ROOT: root,
			LEASE_DIR: leases,
			LEASE_RUN: `run-racer-${n}`,
		},
		stdio: ["pipe", "pipe", "pipe"] as const,
	});
	let stderr = "";
	proc.stderr?.on("data", chunk => {
		stderr += String(chunk);
	});
	proc.on("error", () => undefined);
	proc.stdin?.on("error", () => undefined);
	const stdout = proc.stdout;
	if (!stdout) {
		proc.kill("SIGKILL");
		throw new Error(`racer-${n} has no stdout`);
	}
	const rl = createInterface({ input: stdout });
	return { proc, label: `racer-${n}`, rl, lines: rl[Symbol.asyncIterator](), stderr: () => stderr };
}

async function nextLine(racer: Racer): Promise<string> {
	const next = await racer.lines.next();
	if (next.done) throw new Error(`${racer.label} closed its output before a line (${racer.stderr()})`);
	return next.value;
}

async function acquireEventually(runId: string, attempts = 200): Promise<RunLease> {
	let last = "";
	for (let i = 0; i < attempts; i++) {
		const result = await acquireRunLease(root, runId, deps());
		if (result.ok) return result.lease;
		last = result.reason;
		// Yield to the event loop so libuv can finish reaping the killed child; no wall-clock duration is assumed.
		const yielded = Promise.withResolvers<void>();
		setImmediate(() => yielded.resolve());
		await yielded.promise;
	}
	throw new Error(`slot did not open: ${last}`);
}

test(
	"simultaneous OS processes: exactly one holds the slot; a killed holder is reclaimed",
	async () => {
		const racers: Racer[] = [];
		try {
			for (let n = 0; n < 4; n++) racers.push(spawnRacer(n));
			// Every child has imported the module and is blocked on its stdin barrier; release them together.
			await Promise.all(racers.map(nextLine));
			for (const racer of racers) {
				const input = racer.proc.stdin;
				if (input?.writable) input.write("go\n");
			}

			const results = (await Promise.all(racers.map(nextLine))).map(
				// Each racer prints exactly one JSON result line; the child built its own result object.
				line => JSON.parse(line) as ChildResult,
			);
			const winners = results.flatMap((result, index) => (result.ok ? [index] : []));
			expect(winners.length).toBe(1);
			const winnerIndex = winners[0] ?? -1;
			expect(winnerIndex).toBeGreaterThanOrEqual(0);

			// Losers were told who holds the slot; they did not steal it.
			for (const result of results) {
				if (result.ok) continue;
				expect(result.reason).toContain("진행 중");
			}

			const winner = racers[winnerIndex];
			if (!winner) throw new Error("winner disappeared");
			winner.proc.kill("SIGKILL");
			await waitExit(winner.proc);

			// The dead holder left its lock behind; a new process proves it dead and takes the slot.
			const reclaimed = await acquireEventually("run-after-crash");
			expect(reclaimed.owner.pid).toBe(process.pid);
			await reclaimed.release();
		} finally {
			for (const racer of racers) {
				stop(racer.proc);
				racer.rl.close();
			}
			await Promise.all(racers.map(racer => waitExit(racer.proc)));
		}
	},
	20_000,
);

test("the lock record carries the exact owner identity and run id", async () => {
	// The lock path is public for diagnostics; the record below is private state whose fields this test pins.
	const holder = await acquired(root, "run-record");
	const raw = JSON.parse(await readFile(holder.path, "utf8")) as Record<string, unknown>;
	expect(raw.schema).toBe("storm.lease/v1");
	expect(raw.runId).toBe("run-record");
	expect(raw.root).toBe(root);
	expect(raw.owner).toEqual(holder.owner);
	expect(holder.owner.pid).toBe(process.pid);
	expect(holder.owner.processStart).toBeGreaterThan(0);
	expect(holder.owner.token.length).toBeGreaterThan(0);
	expect(holder.owner.host.length).toBeGreaterThan(0);
	await holder.release();
});
