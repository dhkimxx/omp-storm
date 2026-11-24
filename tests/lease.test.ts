import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createInterface, type Interface } from "node:readline";
import {
	acquireRunLease,
	acquireSessionLease,
	type AcquireRunLeaseInput,
	type LeaseDeps,
	type RunLease,
} from "../src/runtime/lease.ts";

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

function sessionDir(id: string): string {
	return path.join(tmp, "profile", "storm", "sessions", id);
}

function request(over: Partial<AcquireRunLeaseInput> = {}): AcquireRunLeaseInput {
	return {
		sessionDir: sessionDir("session-a"),
		sessionId: "session-a",
		root,
		runId: "run-a",
		mode: "read",
		...over,
	};
}

async function acquired(over: Partial<AcquireRunLeaseInput> = {}, overDeps: LeaseDeps = {}): Promise<RunLease> {
	const result = await acquireRunLease(request(over), deps(overDeps));
	if (!result.ok) throw new Error(`expected a lease: ${result.reason}`);
	return result.lease;
}

async function refused(over: Partial<AcquireRunLeaseInput> = {}, overDeps: LeaseDeps = {}): Promise<string> {
	const result = await acquireRunLease(request(over), deps(overDeps));
	if (result.ok) {
		await result.lease.release();
		throw new Error("expected a refusal");
	}
	return result.reason;
}

describe("session ownership and worktree access", () => {
	test("one session owner; a second process reopening the same session is refused; releasing opens it", async () => {
		const first = await acquired({ runId: "run-first" });
		expect(first.root).toBe(root);
		expect(first.sessionDir).toBe(sessionDir("session-a"));
		expect(first.mode).toBe("read");
		expect(first.paths).toBeUndefined();
		expect(path.relative(root, first.path)).toStartWith("..");
		expect(path.relative(root, first.sessionPath)).toStartWith("..");

		const reason = await refused({ runId: "run-second" });
		expect(reason).toContain("run-first");
		expect(reason).toContain("이 세션");

		await first.release();
		const third = await acquired({ runId: "run-third" });
		expect(third.owner.token).not.toBe(first.owner.token);
		await third.release();
	});

	test("different profiles may reuse the raw native id; the session directory is the owner key", async () => {
		const one = await acquired({ sessionDir: sessionDir("profile-one"), sessionId: "same-native", runId: "run-one" });
		const two = await acquired({ sessionDir: sessionDir("profile-two"), sessionId: "same-native", runId: "run-two" });
		expect(one.path).not.toBe(two.path);
		expect(one.sessionPath).not.toBe(two.sessionPath);
		await one.release();
		await two.release();
	});

	test("an alias path canonicalizes to the same worktree and session directory", async () => {
		const alias = path.join(tmp, "worktree-alias");
		await symlink(root, alias, "dir");
		expect(await realpath(alias)).toBe(root);

		const first = await acquired({ runId: "run-via-real" });
		const second = await refused({ root: alias, sessionDir: path.join(tmp, "profile", "storm", "sessions", "session-a"), runId: "run-alias-same-session" });
		expect(second).toContain("run-via-real");
		await first.release();

		const third = await acquired({ root: alias, runId: "run-via-alias" });
		expect(third.root).toBe(root);
		await third.release();
	});

	test("distinct worktrees in distinct sessions get distinct worktree records", async () => {
		const linked = path.join(tmp, "linked-worktree");
		await mkdir(linked);

		const main = await acquired({ sessionDir: sessionDir("one"), sessionId: "one", runId: "run-main" });
		const other = await acquired({ sessionDir: sessionDir("two"), sessionId: "two", root: linked, runId: "run-linked" });
		expect(main.path).not.toBe(other.path);
		expect(other.root).toBe(linked);
		expect(main.sessionPath).not.toBe(other.sessionPath);
		await main.release();
		await other.release();
	});

	test("an unreadable or invalid record fails closed and is never deleted", async () => {
		const holder = await acquired();
		await writeFile(holder.path, "{ this is not a lease\n");

		const reason = await refused({
			sessionDir: sessionDir("session-b"),
			sessionId: "session-b",
			runId: "run-other",
			mode: "write",
			scope: { kind: "unbounded" },
		});
		expect(reason).toContain("확인할 수 없습니다");
		expect(reason).toContain(holder.path);
		expect(existsSync(holder.path)).toBe(true);

		await expect(holder.release()).rejects.toThrow();
		expect(existsSync(holder.path)).toBe(true);
	});

	test("an owner whose death cannot be proven is refused, not stolen", async () => {
		const holder = await acquired();
		const reason = await refused(
			{
				sessionDir: sessionDir("session-b"),
				sessionId: "session-b",
				runId: "run-other",
				mode: "write",
				scope: { kind: "unbounded" },
			},
			{ liveness: () => "unknown" },
		);

		expect(reason).toContain("확인할 수 없습니다");
		expect(existsSync(holder.path)).toBe(true);
		await holder.release();
	});

	test("a provably dead owner is reclaimed; the old lease cannot release the new one", async () => {
		const dead = await acquired({ runId: "run-dead" });
		const deadToken = dead.owner.token;
		const reborn = await acquired(
			{ sessionDir: sessionDir("session-a"), sessionId: "session-a", runId: "run-reborn" },
			{ liveness: owner => (owner.token === deadToken ? "dead" : "alive") },
		);

		expect(reborn.owner.token).not.toBe(deadToken);
		await expect(dead.release()).rejects.toThrow();
		expect(existsSync(reborn.path)).toBe(true);
		await reborn.release();
	});

	test("a stale session reclaim guard refuses instead of resetting or TTL-stealing", async () => {
		const dead = await acquired({ runId: "run-dead" });
		await mkdir(`${dead.sessionPath}.reclaim`);

		const reason = await refused(
			{ sessionDir: sessionDir("session-a"), sessionId: "session-a", runId: "run-other" },
			{ liveness: () => "dead" },
		);
		expect(reason).toContain(".reclaim");
		expect(existsSync(dead.sessionPath)).toBe(true);

		await rm(`${dead.sessionPath}.reclaim`, { recursive: true, force: true });
		await dead.release();
	});

	test("a lock directory inside the worktree is refused before creation", async () => {
		const inside = path.join(root, ".leases");
		const result = await acquireRunLease(request(), { dir: inside });
		if (result.ok) {
			await result.lease.release();
			throw new Error("expected a refusal for an in-worktree lock dir");
		}
		expect(result.reason).toContain("worktree 밖");
		expect(existsSync(inside)).toBe(false);
	});

	test("bad roots, run ids, session ids and session directories refuse without writing anything", async () => {
		const missing = await acquireRunLease(request({ root: path.join(tmp, "absent") }), deps());
		if (missing.ok) {
			await missing.lease.release();
			throw new Error("expected a refusal for a missing root");
		}
		expect(missing.reason).toContain("worktree");

		const emptyId = await acquireRunLease(request({ runId: "  " }), deps());
		if (emptyId.ok) {
			await emptyId.lease.release();
			throw new Error("expected a refusal for an empty run id");
		}
		expect(emptyId.reason).toContain("실행 id");

		const emptySession = await acquireRunLease(request({ sessionId: " \t" }), deps());
		if (emptySession.ok) {
			await emptySession.lease.release();
			throw new Error("expected a refusal for an empty session id");
		}
		expect(emptySession.reason).toContain("세션 id");

		const relativeSession = await acquireRunLease(request({ sessionDir: "profile/session" }), deps());
		if (relativeSession.ok) {
			await relativeSession.lease.release();
			throw new Error("expected a refusal for a relative session dir");
		}
		expect(relativeSession.reason).toContain("절대 경로");
		expect(existsSync(leases)).toBe(false);
	});
});

describe("readers, writers and path claims", () => {
	test("independent read leases coexist on the same target and session ownership still applies", async () => {
		const one = await acquired({ sessionDir: sessionDir("one"), sessionId: "one", runId: "run-read-1" });
		const two = await acquired({ sessionDir: sessionDir("two"), sessionId: "two", runId: "run-read-2" });
		const three = await acquired({ sessionDir: sessionDir("three"), sessionId: "three", runId: "run-read-3" });
		expect(new Set([one.path, two.path, three.path]).size).toBe(3);
		expect(one.mode).toBe("read");
		expect(two.mode).toBe("read");
		expect(three.mode).toBe("read");
		await Promise.all([one.release(), two.release(), three.release()]);
	});

	test("a writer is refused while a reader holds the target; it succeeds after the reader releases", async () => {
		const reader = await acquired({ runId: "run-read" });
		const reason = await refused({
			sessionDir: sessionDir("writer"),
			sessionId: "writer",
			runId: "run-write",
			mode: "write",
			scope: { kind: "unbounded" },
		});
		expect(reason).toContain("읽기 실행");
		expect(reason).toContain("run-read");
		await reader.release();

		const writer = await acquired({
			sessionDir: sessionDir("writer"),
			sessionId: "writer",
			runId: "run-write",
			mode: "write",
			scope: { kind: "unbounded" },
		});
		expect(writer.mode).toBe("write");
		expect(writer.paths).toBeUndefined();
		await writer.release();
	});

	test("an unbounded writer excludes readers and other writers", async () => {
		const writer = await acquired({
			sessionDir: sessionDir("one"),
			sessionId: "one",
			runId: "run-write",
			mode: "write",
			scope: { kind: "unbounded" },
		});
		const readerReason = await refused({ sessionDir: sessionDir("two"), sessionId: "two", runId: "run-read" });
		expect(readerReason).toContain("run-write");
		const writerReason = await refused({
			sessionDir: sessionDir("three"),
			sessionId: "three",
			runId: "run-write-2",
			mode: "write",
			scope: { kind: "paths", paths: ["src/a.ts"] },
		});
		expect(writerReason).toContain("run-write");
		await writer.release();
	});

	test("disjoint path-only writers coexist; overlapping paths and directory prefixes are refused", async () => {
		const a = await acquired({
			sessionDir: sessionDir("one"),
			sessionId: "one",
			runId: "run-a",
			mode: "write",
			scope: { kind: "paths", paths: ["src/a.ts", "docs/a.md"] },
		});
		expect(a.paths).toEqual(["docs/a.md", "src/a.ts"]);

		const b = await acquired({
			sessionDir: sessionDir("two"),
			sessionId: "two",
			runId: "run-b",
			mode: "write",
			scope: { kind: "paths", paths: ["src/b.ts"] },
		});
		expect(b.paths).toEqual(["src/b.ts"]);

		const overlap = await refused({
			sessionDir: sessionDir("three"),
			sessionId: "three",
			runId: "run-c",
			mode: "write",
			scope: { kind: "paths", paths: ["src"] },
		});
		expect(overlap).toMatch(/run-[ab]/);
		expect(overlap).toContain("src");

		const sameFile = await refused({
			sessionDir: sessionDir("four"),
			sessionId: "four",
			runId: "run-d",
			mode: "write",
			scope: { kind: "paths", paths: ["src/b.ts"] },
		});
		expect(sameFile).toContain("run-b");

		await a.release();
		await b.release();
	});

	test("a reader cannot acquire while any writer exists", async () => {
		const writer = await acquired({
			sessionDir: sessionDir("one"),
			sessionId: "one",
			runId: "run-write",
			mode: "write",
			scope: { kind: "paths", paths: ["src/a.ts"] },
		});
		expect(await refused({ sessionDir: sessionDir("two"), sessionId: "two", runId: "run-read" })).toContain("run-write");
		await writer.release();
	});

	test("a stale writer guard fails closed and names its path", async () => {
		const reader = await acquired({ sessionDir: sessionDir("reader"), sessionId: "reader", runId: "run-read" });
		const worktreeDir = path.join(leases, "worktrees", reader.record.key);
		const guard = path.join(worktreeDir, "writer.guard");
		await mkdir(guard, { recursive: true });
		const blocked = await refused({
			sessionDir: sessionDir("writer"),
			sessionId: "writer",
			runId: "run-write",
			mode: "write",
			scope: { kind: "unbounded" },
		});
		expect(blocked).toContain("writer.guard");
		expect(existsSync(guard)).toBe(true);
		await rm(guard, { recursive: true, force: true });
		await reader.release();
		const writer = await acquired({
			sessionDir: sessionDir("writer"),
			sessionId: "writer",
			runId: "run-write",
			mode: "write",
			scope: { kind: "unbounded" },
		});
		await writer.release();
	});

	test("invalid path scopes refuse before any lock is written", async () => {
		for (const paths of [["/abs.ts"], ["../escape.ts"], ["src//a.ts"], ["src/./a.ts"], [""], ["a\\b.ts"]]) {
			const result = await acquireRunLease(
				request({
					sessionDir: sessionDir("bad"),
					sessionId: "bad",
					runId: "run-bad",
					mode: "write",
					scope: { kind: "paths", paths },
				}),
				deps(),
			);
			if (result.ok) {
				await result.lease.release();
				throw new Error(`expected a refusal for ${JSON.stringify(paths)}`);
			}
			expect(result.reason).toContain("경로");
		}
		expect(existsSync(leases)).toBe(false);
	});
});

describe("access transitions and snapshots", () => {
	test("read -> writer upgrade keeps the read lease when another reader is active", async () => {
		const a = await acquired({ sessionDir: sessionDir("one"), sessionId: "one", runId: "run-a" });
		const b = await acquired({ sessionDir: sessionDir("two"), sessionId: "two", runId: "run-b" });
		const before = a.snapshot();
		expect(a.mode).toBe("read");
		expect(a.epoch).toBe(0);

		const failed = await a.upgrade({ scope: { kind: "unbounded" } });
		expect(failed.ok).toBe(false);
		if (!failed.ok) expect(failed.reason).toContain("읽기 실행");
		expect(a.mode).toBe("read");
		expect(a.epoch).toBe(0);
		a.assertCurrent(before);

		await b.release();
		const upgraded = await a.upgrade({ scope: { kind: "paths", paths: ["src/a.ts"] } });
		expect(upgraded.ok).toBe(true);
		expect(a.mode).toBe("write");
		expect(a.paths).toEqual(["src/a.ts"]);
		expect(a.epoch).toBe(1);
		expect(() => a.assertCurrent(before)).toThrow();
		const after = a.snapshot();
		a.assertCurrent(after);
		await a.release();
	});

	test("a delayed upgrade after release fails closed and the released snapshot is stale", async () => {
		const lease = await acquired();
		const snapshot = lease.snapshot();
		lease.assertCurrent(snapshot);
		await lease.release();
		expect(() => lease.assertCurrent(snapshot)).toThrow();
		const late = await lease.upgrade({ scope: { kind: "unbounded" } });
		expect(late.ok).toBe(false);
	});

	test("a path set change is atomic and refuses a conflicting new path while keeping the old claim", async () => {
		const a = await acquired({
			sessionDir: sessionDir("one"),
			sessionId: "one",
			runId: "run-a",
			mode: "write",
			scope: { kind: "paths", paths: ["src/a.ts"] },
		});
		const b = await acquired({
			sessionDir: sessionDir("two"),
			sessionId: "two",
			runId: "run-b",
			mode: "write",
			scope: { kind: "paths", paths: ["src/b.ts"] },
		});
		const before = a.snapshot();

		const failed = await a.setWritePaths(["src/a.ts", "src/b.ts"]);
		expect(failed.ok).toBe(false);
		expect(a.paths).toEqual(["src/a.ts"]);
		expect(a.epoch).toBe(0);
		a.assertCurrent(before);

		const ok = await a.setWritePaths(["src/a.ts", "docs/a.md"]);
		expect(ok.ok).toBe(true);
		expect(a.paths).toEqual(["docs/a.md", "src/a.ts"]);
		expect(a.epoch).toBe(1);
		await a.release();
		await b.release();
	});

	test("widening a writer to unbounded fails while a disjoint writer exists", async () => {
		const a = await acquired({
			sessionDir: sessionDir("one"),
			sessionId: "one",
			runId: "run-a",
			mode: "write",
			scope: { kind: "paths", paths: ["src/a.ts"] },
		});
		const b = await acquired({
			sessionDir: sessionDir("two"),
			sessionId: "two",
			runId: "run-b",
			mode: "write",
			scope: { kind: "paths", paths: ["src/b.ts"] },
		});
		const widened = await a.upgrade({ scope: { kind: "unbounded" } });
		expect(widened.ok).toBe(false);
		expect(a.paths).toEqual(["src/a.ts"]);
		await a.release();
		await b.release();
	});

	test("a lease cannot be released twice after its access was replaced", async () => {
		const first = await acquired({ sessionDir: sessionDir("one"), sessionId: "one", runId: "run-first" });
		await first.release();
		const second = await acquired({ sessionDir: sessionDir("one"), sessionId: "one", runId: "run-second" });
		await expect(first.release()).resolves.toBeUndefined();
		await second.release();
	});
});

describe("session-only lease for reset", () => {
	test("reset can run in one session while another session writes the same worktree", async () => {
		const writer = await acquired({
			sessionDir: sessionDir("writer"),
			sessionId: "writer",
			runId: "run-write",
			mode: "write",
			scope: { kind: "unbounded" },
		});
		const reset = await acquireSessionLease(
			{ sessionDir: sessionDir("reset"), sessionId: "reset", runId: "reset" },
			deps(),
		);
		expect(reset.ok).toBe(true);
		if (!reset.ok) return;
		expect(reset.lease.record.kind).toBe("session");
		expect(reset.lease.record.root).toBe("");
		await reset.lease.release();
		expect(existsSync(writer.path)).toBe(true);
		await writer.release();
	});

	test("reset refuses while this session owns a run", async () => {
		const run = await acquired({ sessionDir: sessionDir("one"), sessionId: "one", runId: "run-one" });
		const reset = await acquireSessionLease({ sessionDir: sessionDir("one"), sessionId: "one", runId: "reset" }, deps());
		expect(reset.ok).toBe(false);
		if (!reset.ok) expect(reset.reason).toContain("run-one");
		await run.release();
		const after = await acquireSessionLease({ sessionDir: sessionDir("one"), sessionId: "one", runId: "reset" }, deps());
		expect(after.ok).toBe(true);
		if (after.ok) await after.lease.release();
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
	const scope = process.env.LEASE_PATHS ? { kind: "paths", paths: JSON.parse(process.env.LEASE_PATHS) } : process.env.LEASE_UNBOUNDED ? { kind: "unbounded" } : undefined;
	const result = await mod.acquireRunLease(
		{
			sessionDir: process.env.LEASE_SESSION_DIR,
			sessionId: process.env.LEASE_SESSION,
			root: process.env.LEASE_ROOT,
			runId: process.env.LEASE_RUN,
			mode: process.env.LEASE_MODE,
			...(scope === undefined ? {} : { scope }),
		},
		{ dir: process.env.LEASE_DIR },
	);
	if (!result.ok) {
		await say({ ok: false, reason: result.reason });
		process.exit(0);
	}
	const hold = Promise.withResolvers();
	process.stdin.once("data", hold.resolve);
	await say({ ok: true, runId: result.lease.runId, token: result.lease.owner.token, pid: process.pid, mode: result.lease.mode });
	await hold.promise;
	await result.lease.release();
	process.exit(0);
})().catch(error => {
	process.stderr.write(String((error && error.stack) || error) + "\n");
	process.exit(1);
});
`;

type ChildResult =
	| { ok: true; runId: string; token: string; pid: number; mode: string }
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

function spawnRacer(n: number, over: { mode: "read" | "write"; session?: string; paths?: string[]; unbounded?: boolean }): Racer {
	const moduleUrl = new URL("../src/runtime/lease.ts", import.meta.url).href;
	const session = over.session ?? `racer-${n}`;
	const proc = spawn(process.execPath, ["-e", CHILD], {
		env: {
			...process.env,
			LEASE_MODULE: moduleUrl,
			LEASE_ROOT: root,
			LEASE_DIR: leases,
			LEASE_RUN: `run-racer-${n}`,
			LEASE_MODE: over.mode,
			LEASE_SESSION: session,
			LEASE_SESSION_DIR: sessionDir(session),
			...(over.paths !== undefined ? { LEASE_PATHS: JSON.stringify(over.paths) } : {}),
			...(over.unbounded ? { LEASE_UNBOUNDED: "1" } : {}),
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
		const result = await acquireRunLease(request({ runId, sessionDir: sessionDir("after-crash"), sessionId: "after-crash" }), deps());
		if (result.ok) return result.lease;
		last = result.reason;
		// Yield to the event loop so libuv can finish reaping the killed child; no wall-clock duration is assumed.
		const yielded = Promise.withResolvers<void>();
		setImmediate(() => yielded.resolve());
		await yielded.promise;
	}
	throw new Error(`slot did not open: ${last}`);
}

describe("multiple OS processes", () => {
	const racers: Racer[] = [];
	afterEach(async () => {
		for (const racer of racers.splice(0)) {
			stop(racer.proc);
			racer.rl.close();
		}
		await Promise.all(racers.map(racer => waitExit(racer.proc)));
	});

	test(
		"simultaneous unbounded writers: exactly one holds the worktree; a killed holder is reclaimed",
		async () => {
			for (let n = 0; n < 4; n++) racers.push(spawnRacer(n, { mode: "write", unbounded: true }));
			await Promise.all(racers.map(nextLine));
			for (const racer of racers) {
				const input = racer.proc.stdin;
				if (input?.writable) input.write("go\n");
			}

			const results = (await Promise.all(racers.map(nextLine))).map(line => JSON.parse(line) as ChildResult);
			const winners = results.flatMap((result, index) => (result.ok ? [index] : []));
			expect(winners.length).toBe(1);
			const winnerIndex = winners[0] ?? -1;
			const winner = racers[winnerIndex];
			if (!winner) throw new Error("winner disappeared");
			// Losers name the winner, never steal its lock.
			const winnerResult = results[winnerIndex] as Extract<ChildResult, { ok: true }>;
			for (const result of results) {
				if (result.ok) continue;
				expect(result.reason).toContain(winnerResult.runId);
			}

			winner.proc.kill("SIGKILL");
			await waitExit(winner.proc);
			const reclaimed = await acquireEventually("run-after-crash");
			expect(reclaimed.owner.pid).toBe(process.pid);
			await reclaimed.release();
		},
		20_000,
	);

	test(
		"shared readers coexist across processes; a writer process is refused until every reader exits",
		async () => {
			for (let n = 0; n < 3; n++) racers.push(spawnRacer(n, { mode: "read" }));
			await Promise.all(racers.map(nextLine));
			for (const racer of racers) {
				const input = racer.proc.stdin;
				if (input?.writable) input.write("go\n");
			}
			const readers = (await Promise.all(racers.map(nextLine))).map(line => JSON.parse(line) as ChildResult);
			expect(readers.every(result => result.ok && result.mode === "read")).toBe(true);

			const writer = spawnRacer(9, { mode: "write", unbounded: true, session: "writer-process" });
			racers.push(writer);
			await nextLine(writer);
			writer.proc.stdin?.write("go\n");
			const blocked = JSON.parse(await nextLine(writer)) as ChildResult;
			expect(blocked.ok).toBe(false);
			if (!blocked.ok) expect(blocked.reason).toContain("읽기 실행");

			for (const racer of racers.slice(0, 3)) racer.proc.stdin?.write("done\n");
			await Promise.all(racers.slice(0, 3).map(racer => waitExit(racer.proc)));
			// The same writer process retries after all readers exited.
			const retry = await acquireRunLease(
				request({
					sessionDir: sessionDir("writer-process"),
					sessionId: "writer-process",
					runId: "run-writer-retry",
					mode: "write",
					scope: { kind: "unbounded" },
				}),
				deps(),
			);
			expect(retry.ok).toBe(true);
			if (retry.ok) await retry.lease.release();
		},
		20_000,
	);
});

test("the record carries the exact owner, session and access identity", async () => {
	const holder = await acquired({
		runId: "run-record",
		sessionDir: sessionDir("session-a"),
		sessionId: "session-a",
		mode: "write",
		scope: { kind: "paths", paths: ["src/a.ts"] },
	});
	const raw = JSON.parse(await readFile(holder.path, "utf8")) as Record<string, unknown>;
	expect(raw.schema).toBe("storm.lease/v2");
	expect(raw.kind).toBe("write");
	expect(raw.runId).toBe("run-record");
	expect(raw.root).toBe(root);
	expect(raw.sessionId).toBe("session-a");
	expect(raw.sessionDir).toBe(sessionDir("session-a"));
	expect(raw.paths).toEqual(["src/a.ts"]);
	expect(raw.owner).toEqual(holder.owner);
	expect(holder.owner.pid).toBe(process.pid);
	expect(holder.owner.processStart).toBeGreaterThan(0);
	expect(holder.owner.token.length).toBeGreaterThan(0);
	await holder.release();
});
