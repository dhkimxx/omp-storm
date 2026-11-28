import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { configHash } from "../src/config/canonical.ts";
import { loadConfig, writeConfig } from "../src/config/store.ts";
import { movedSince } from "../src/proposals/decide.ts";
import { readTrustedRuns, recordTrustedRun } from "../src/runtime/janitor.ts";
import { appendRunIndex, readRunIndex } from "../src/runtime/run-index.ts";
import { noteResumePointer, trustedResume } from "../src/runtime/resume.ts";
import { readRun, runIds, writeRun } from "../src/runtime/run.ts";
import { addQuotaMark, readQuotaMarks, readTrialStates, updateTrialState } from "../src/runtime/state-files.ts";
import { assertSessionStoreSafe, sessionStateDir, sessionStoreDir } from "../src/session-scope.ts";
import type { LiveDiscovery } from "../src/approval/shadow.ts";
import { createStateCache, isApproved, liveDiscovery, loadProjectState, type ProjectEnv } from "../src/state.ts";
import type { RunSummary, StormConfig } from "../src/types.ts";
import { runRecord } from "./fixtures.ts";
import { makeProject, TEAM, type TestProject } from "./support.ts";

const T0 = Date.parse("2026-11-20T09:00:00Z");
const SESSION_A = "native-session-a";
const SESSION_B = "native-session-b";
/** A verified live handle whose extension roots are empty: known, and distinct from an unknown handle. */
const live: LiveDiscovery = {
	extensionRoots: { explicit: [], mode: "explicit-only", configured: [], configuredLevel: "user" },
	sessionAgents: [],
};

let project: TestProject;
/** The project's env, counting the git calls a state load makes (one each). */
let env: ProjectEnv;
let loads: number;

beforeEach(async () => {
	project = await makeProject();
	loads = 0;
	env = {
		...project.env,
		sessionId: SESSION_A,
		discovery: live,
		exec: (command, args, options) => {
			loads++;
			return project.env.exec(command, args, options);
		},
	};
	setSystemTime(new Date(T0));
});

afterEach(async () => {
	setSystemTime();
	await project.remove();
});

/** The same owner without the git-call counter, so writes do not look like cache reads. */
const baseEnv = (): ProjectEnv => ({ ...project.env, sessionId: SESSION_A, discovery: live });

/** Writes the approval first, then the session config: the order the real approval path uses. */
async function approveTeam(team: StormConfig, target: ProjectEnv = baseEnv()): Promise<void> {
	const state = await loadProjectState(target);
	await state.store.approve({ configHash: configHash(team), config: team, scope: { shadowedAgents: state.shadows } });
	await writeConfig(state.sessionDir, team);
}

describe("the spawn hook's state cache", () => {
	test("a batch of spawns shares one load", async () => {
		const cache = createStateCache();
		const [a, b, c] = await Promise.all([cache.get(env), cache.get(env), cache.get(env)]);
		expect(loads).toBe(1);
		expect(b).toBe(a);
		expect(c).toBe(a);
	});

	test("an approval, a hand edit or a withdrawn approval is seen 2 s after the cached read, not before", async () => {
		const cache = createStateCache();
		expect((await cache.get(env)).config.status).toBe("missing");
		await approveTeam(TEAM);

		setSystemTime(new Date(T0 + 1_999));
		expect((await cache.get(env)).config.status).toBe("missing");
		expect(loads).toBe(1);
		setSystemTime(new Date(T0 + 2_000));
		expect(isApproved(await cache.get(env))).toBe(true);
		expect(loads).toBe(2);

		// A teammate's edit lands: the old approval answers for at most the same 2 s.
		await writeConfig(sessionStoreDir(project.env.agentDir, SESSION_A), { ...TEAM, rounds: 9 });
		setSystemTime(new Date(T0 + 3_999));
		expect(isApproved(await cache.get(env))).toBe(true);
		setSystemTime(new Date(T0 + 4_000));
		const edited = await cache.get(env);
		expect(edited.approval).toBeUndefined();
		expect(isApproved(edited)).toBe(false);
		expect(loads).toBe(3);
	});

	test("clear drops what is cached at once: the next read is fresh", async () => {
		const cache = createStateCache();
		await cache.get(env);
		await approveTeam(TEAM);
		cache.clear();
		expect(isApproved(await cache.get(env))).toBe(true);
		expect(loads).toBe(2);
	});

	test("each session, profile and target has its own entry, and the lifetime is the one given", async () => {
		const other = await makeProject();
		try {
			const cache = createStateCache(500);
			const mine = await cache.get(env);
			const otherTarget = await cache.get({ ...env, cwd: other.root });
			const otherSession = await cache.get({ ...env, sessionId: SESSION_B });
			expect(otherTarget.repo.root).not.toBe(mine.repo.root);
			expect(otherSession.sessionDir).not.toBe(mine.sessionDir);
			expect(loads).toBe(3);
			setSystemTime(new Date(T0 + 499));
			await cache.get(env);
			expect(loads).toBe(3);
			setSystemTime(new Date(T0 + 500));
			await cache.get(env);
			expect(loads).toBe(4);
		} finally {
			await other.remove();
		}
	});

	test("a load that fails is not kept: the next read tries again", async () => {
		const cache = createStateCache();
		let broken = true;
		const flaky: ProjectEnv = {
			...env,
			get agentDir(): string {
				if (broken) throw new Error("agent dir unavailable");
				return project.env.agentDir;
			},
		};
		await expect(cache.get(flaky)).rejects.toThrow("agent dir unavailable");
		broken = false;
		expect((await cache.get(flaky)).config.status).toBe("missing");
	});

	test("an unknown handle never shares a cache entry with known empty roots or another root set", async () => {
		const cache = createStateCache();
		const known = await cache.get(env);
		const unknown = await cache.get({ ...env, discovery: undefined });
		expect(loads).toBe(2);
		expect(known.shadows.some(s => s.path === "")).toBe(false);
		expect(unknown.shadows.length).toBeGreaterThan(0);
		expect(unknown.shadows.every(s => s.path === "" && s.sha256 === "")).toBe(true);
		expect(unknown.shadows.map(s => s.agent)).toContain("task");
		expect(isApproved(unknown)).toBe(false);

		const ext = path.join(project.tmp, "extra-extension");
		await mkdir(path.join(ext, "agents"), { recursive: true });
		const file = path.join(ext, "agents", "fixture.md");
		await writeFile(file, "---\nname: task\ndescription: x\n---\nbody\n");
		const changed = await cache.get({ ...env, discovery: { ...live, extensionRoots: { ...live.extensionRoots, explicit: [ext] } } });
		expect(loads).toBe(3);
		expect(changed.shadows.find(s => s.agent === "task")?.path).toBe(file);
	});
});

describe("live discovery identity", () => {
	test("only the handle owning this exact native session is live; blank and mismatched are unknown", () => {
		const session = {
			sessionManager: { getSessionId: () => "native-owner" },
			effectiveExtensionRoots: live.extensionRoots,
			getSessionAgents: () => [],
		};
		const ref = { id: "Main", session } as never;
		const registry = { get: (id: string) => (id === "Main" ? ref : undefined) };
		expect(liveDiscovery("Main", "native-owner", registry)).toEqual(live);
		expect(liveDiscovery("Main", "another-session", registry)).toBeUndefined();
		expect(liveDiscovery("Other", "native-owner", registry)).toBeUndefined();
		expect(liveDiscovery("", "native-owner", registry)).toBeUndefined();
		expect(liveDiscovery("Main", "", registry)).toBeUndefined();
		expect(liveDiscovery("Main", "native-owner", { get: () => ({ id: "Main", session: null } as never) })).toBeUndefined();
		const brokenRoots = { ...session, effectiveExtensionRoots: undefined };
		expect(liveDiscovery("Main", "native-owner", { get: () => ({ id: "Main", session: brokenRoots } as never) })).toBeUndefined();
	});
});

describe("session store location", () => {
	test("is the full sha256 of the exact utf8 native id under the profile, with no caller-supplied path", () => {
		const agentDir = "/profile/agent";
		for (const id of ["session-1", "세션-1", "../escape"]) {
			const expected = createHash("sha256").update(id, "utf8").digest("hex");
			expect(sessionStoreDir(agentDir, id)).toBe(path.join(agentDir, "storm", "sessions", expected));
			expect(expected).toHaveLength(64);
		}
		expect(sessionStoreDir(agentDir, "../escape")).not.toContain("..");
		expect(sessionStateDir("/profile/agent/storm/sessions/x")).toBe(path.join("/profile/agent/storm/sessions/x", "state"));
	});

	test("rejects blank or invalid identities and directories", () => {
		for (const id of ["", "   ", "bad\u0000id", "bad\nid"]) {
			expect(() => sessionStoreDir("/profile/agent", id)).toThrow();
		}
		expect(() => sessionStoreDir("", "session-1")).toThrow();
		expect(() => sessionStateDir("")).toThrow();
	});
});

describe("session-scoped project state", () => {
	test("two sessions in one profile and cwd are independent; resuming the same native id returns its own data", async () => {
		const otherSession: ProjectEnv = { ...env, sessionId: SESSION_B };
		await approveTeam(TEAM);

		const a = await loadProjectState(env);
		const b = await loadProjectState(otherSession);
		expect(a.sessionDir).toBe(sessionStoreDir(project.env.agentDir, SESSION_A));
		expect(a.sessionDir).not.toBe(b.sessionDir);
		expect(isApproved(a)).toBe(true);
		expect(isApproved({ ...a, approval: { ...a.approval!, target: "another-target" } })).toBe(false);
		expect(isApproved({ ...a, approval: { ...a.approval!, target: undefined as unknown as string } })).toBe(false);
		expect(b.config.status).toBe("missing");
		expect(isApproved(b)).toBe(false);

		// Resuming the exact same native session opens the same store, not a copy keyed by cwd.
		const resumed = await loadProjectState(env);
		expect(resumed.sessionDir).toBe(a.sessionDir);
		expect(isApproved(resumed)).toBe(true);
		expect((await loadProjectState(otherSession)).config.status).toBe("missing");
	});

	test("a stale dialog is bound to its own session as well as its target, hash and shadows", async () => {
		const before = await loadProjectState(env);
		expect(movedSince(before, await loadProjectState(env))).toBe(false);
		expect(movedSince(before, await loadProjectState({ ...env, sessionId: SESSION_B }))).toBe(true);
	});

	test("a changed target keeps the session team but never reuses its approval", async () => {
		const other = await makeProject();
		try {
			await approveTeam(TEAM);
			const before = await loadProjectState(env);
			const moved = await loadProjectState({ ...env, cwd: other.root });
			expect(moved.sessionDir).toBe(before.sessionDir);
			expect(moved.repo.root).toBe(other.root);
			expect(moved.config.status).toBe("ok");
			expect(moved.approval).toBeUndefined();
			expect(isApproved(moved)).toBe(false);
			expect(movedSince(before, moved)).toBe(true);
		} finally {
			await other.remove();
		}
	});

	test("an ordinary query creates nothing and an invalid identity fails before writing", async () => {
		const state = await loadProjectState(env);
		expect(state.config.status).toBe("missing");
		await expect(readdir(path.join(env.agentDir, "storm"))).rejects.toThrow();

		for (const sessionId of ["", "   ", "bad\u0000id"]) {
			await expect(loadProjectState({ ...env, sessionId })).rejects.toThrow();
		}
		await expect(readdir(path.join(env.agentDir, "storm"))).rejects.toThrow();
	});

	test("old target config and pre-session approvals stay byte-untouched while a new session works and resets", async () => {
		const legacyConfig = path.join(project.root, ".omp", "storm", "config.json");
		const legacyIgnore = path.join(project.root, ".omp", "storm", ".gitignore");
		const legacyApproval = path.join(env.agentDir, "storm", "approvals", "git-old-000000000000000000000000", "approved", "x.json");
		for (const file of [legacyConfig, legacyIgnore, legacyApproval]) await mkdir(path.dirname(file), { recursive: true });
		await writeFile(legacyConfig, '{"legacy":true}\n');
		await writeFile(legacyIgnore, "/state/\n");
		await writeFile(legacyApproval, '{"schema":"storm.approval/v1"}\n');
		const files = [legacyConfig, legacyIgnore, legacyApproval];
		const before = await Promise.all(files.map(file => readFile(file)));

		const legacy = await loadProjectState(env);
		expect(legacy.config.status).toBe("missing");
		expect(legacy.approval).toBeUndefined();
		await approveTeam(TEAM);
		expect(await (await loadProjectState(env)).store.clear()).toBe(1);

		for (const [i, file] of files.entries()) expect(await readFile(file)).toEqual(before[i]!);
	});
});

describe("session store safety", () => {
	const id = "safe-session";
	const profile = (name = "profile") => path.join(project.tmp, name);
	const target = (name = "target") => path.join(project.tmp, name);

	test("relative profile and session dirs are refused instead of becoming cwd-relative stores", () => {
		for (const dir of [".", "./profile", "profile/storm/sessions/x", ""]) {
			expect(() => sessionStoreDir(dir, id)).toThrow();
		}
		expect(() => sessionStoreDir(".", id)).toThrow(/절대 경로/);
		expect(() => sessionStateDir("profile/storm/sessions/x")).toThrow(/절대 경로/);
	});

	test("an unconfigured, correctly placed store is allowed and reads create nothing", async () => {
		const dir = sessionStoreDir(profile("unused"), id);
		await assertSessionStoreSafe(dir, target("unused-target"));
		await expect(readdir(profile("unused"))).rejects.toThrow();
		expect(existsSync(target("unused-target"))).toBe(false);
	});

	test("a store inside the target, redirected to another session, or outside its profile is refused", async () => {
		const checkout = target("checkout");
		await mkdir(checkout, { recursive: true });
		await expect(assertSessionStoreSafe(sessionStoreDir(checkout, id), checkout)).rejects.toThrow(/작업 트리/);

		const real = profile("other-session-profile");
		const other = sessionStoreDir(real, "other-session");
		const redirected = sessionStoreDir(real, id);
		await mkdir(other, { recursive: true });
		await mkdir(path.dirname(redirected), { recursive: true });
		await symlink(other, redirected);
		await expect(assertSessionStoreSafe(redirected, checkout)).rejects.toThrow(/프로필|세션/);

		const outside = profile("outside");
		const escaped = sessionStoreDir(profile("escape-profile"), id);
		await mkdir(outside, { recursive: true });
		await mkdir(path.dirname(escaped), { recursive: true });
		await symlink(outside, escaped);
		await expect(assertSessionStoreSafe(escaped, checkout)).rejects.toThrow(/프로필|세션/);
	});

	test("a managed child symlink that leaves the session is refused before reading", async () => {
		const dir = sessionStoreDir(profile("child-profile"), id);
		await mkdir(dir, { recursive: true });
		const outside = path.join(project.tmp, "outside-config.json");
		await writeFile(outside, "keep\n");
		await symlink(outside, path.join(dir, "config.json"));
		await expect(assertSessionStoreSafe(dir, target("child-target"))).rejects.toThrow(/관리 파일/);
		await expect(loadConfig(dir, target("child-target"))).rejects.toThrow(/관리 파일/);
		expect(await readFile(outside, "utf8")).toBe("keep\n");
	});

	test("a legacy profile path aliasing the target is refused and leaves the old state byte-untouched", async () => {
		const checkout = target("legacy-target");
		const legacy = path.join(checkout, ".omp", "storm");
		await mkdir(legacy, { recursive: true });
		const legacyConfig = path.join(legacy, "config.json");
		const legacyApproval = path.join(legacy, "approvals", "old", "approved", "x.json");
		await mkdir(path.dirname(legacyApproval), { recursive: true });
		await writeFile(legacyConfig, '{"legacy":true}\n');
		await writeFile(legacyApproval, '{"schema":"storm.approval/v1"}\n');

		const checkoutAlias = target("legacy-target-link");
		await symlink(checkout, checkoutAlias);
		const agentDir = profile("legacy-agent");
		await mkdir(agentDir, { recursive: true });
		await symlink(legacy, path.join(agentDir, "storm"));
		const env: ProjectEnv = {
			...project.env,
			cwd: checkout,
			agentDir,
			pluginAgentsDir: path.join(project.tmp, "plugin-agents-safety"),
			sessionId: id,
		};
		const dir = sessionStoreDir(agentDir, id);
		await expect(loadProjectState(env)).rejects.toThrow(/프로필|세션|작업 트리/);
		await expect(assertSessionStoreSafe(dir, checkout)).rejects.toThrow(/프로필|세션|작업 트리/);
		await expect(assertSessionStoreSafe(dir, checkoutAlias)).rejects.toThrow(/프로필|세션|작업 트리/);
		await expect(loadConfig(dir, checkout)).rejects.toThrow(/프로필|세션|작업 트리/);
		await expect(writeConfig(dir, TEAM, checkoutAlias)).rejects.toThrow(/프로필|세션|작업 트리/);

		expect(await readFile(legacyConfig, "utf8")).toBe('{"legacy":true}\n');
		expect(await readFile(legacyApproval, "utf8")).toBe('{"schema":"storm.approval/v1"}\n');
		expect(existsSync(path.join(legacy, "sessions"))).toBe(false);
	});

	test("a correctly placed profile symlink is allowed and writes stay under its real profile", async () => {
		const realProfile = profile("real-profile");
		const linkedProfile = profile("linked-profile");
		const checkout = target("linked-target");
		await mkdir(realProfile, { recursive: true });
		await mkdir(checkout, { recursive: true });
		await symlink(realProfile, linkedProfile);

		const state = await loadProjectState({ ...project.env, cwd: checkout, agentDir: linkedProfile, sessionId: id });
		expect(state.config.status).toBe("missing");
		await writeConfig(state.sessionDir, TEAM, checkout);
		const written = path.join(realProfile, "storm", "sessions", path.basename(state.sessionDir), "config.json");
		expect(existsSync(written)).toBe(true);
		expect(existsSync(path.join(checkout, ".omp"))).toBe(false);
	});

	test("nested state/runs links to an old worktree are refused and leave its sentinels untouched", async () => {
		const legacy = target("legacy-runtime-tree");
		const legacyRuns = path.join(legacy, "runs");
		await mkdir(legacyRuns, { recursive: true });
		const legacyRun = path.join(legacyRuns, "run-20260101-000000-old1.json");
		const legacyIndex = path.join(legacyRuns, "index.jsonl");
		await writeFile(legacyRun, '{"legacy":"run"}\n');
		await writeFile(legacyIndex, '{"legacy":"index"}\n');

		const dir = sessionStoreDir(profile("nested-old-profile"), id);
		await mkdir(path.join(dir, "state"), { recursive: true });
		await symlink(legacyRuns, path.join(dir, "state", "runs"));
		const before = [await readFile(legacyRun), await readFile(legacyIndex)];

		await expect(writeRun(dir, runRecord({ runId: "run-20261123-120000-new1" }))).rejects.toThrow(/세션|작업 트리/);
		await expect(readRun(dir, "run-20260101-000000-old1")).rejects.toThrow(/세션|작업 트리/);
		await expect(runIds(dir)).rejects.toThrow(/세션|작업 트리/);
		await expect(
			appendRunIndex(dir, { schema: "storm.run-summary/v1", runId: "run-new", startedAt: "2026-11-23T00:00:00.000Z", status: "done", task: "t", costUsd: 0, agents: 0, spawns: { total: 0, blocked: 0 } }),
		).rejects.toThrow(/세션|작업 트리/);

		expect(await readFile(legacyRun)).toEqual(before[0]!);
		expect(await readFile(legacyIndex)).toEqual(before[1]!);
		expect((await readdir(legacyRuns)).sort()).toEqual(["index.jsonl", "run-20260101-000000-old1.json"]);
	});

	test("nested record links to another session are refused and leave that session untouched", async () => {
		const other = sessionStoreDir(profile("other-runtime-profile"), "other-session");
		const otherRuns = path.join(other, "state", "runs");
		await mkdir(otherRuns, { recursive: true });
		const otherSentinel = path.join(otherRuns, "run-20260101-000000-oth1.json");
		await writeFile(otherSentinel, '{"other":"run"}\n');

		const dir = sessionStoreDir(profile("nested-other-profile"), id);
		await mkdir(path.join(dir, "state"), { recursive: true });
		await symlink(otherRuns, path.join(dir, "state", "runs"));
		await expect(writeRun(dir, runRecord({ runId: "run-20261123-120000-new2" }))).rejects.toThrow(/세션|작업 트리/);
		await expect(readRun(dir, "run-20260101-000000-oth1")).rejects.toThrow(/세션|작업 트리/);
		expect(await readFile(otherSentinel, "utf8")).toBe('{"other":"run"}\n');
	});

	test("file-level state links to an old tree are refused for counters, resume and trusted runs", async () => {
		const legacy = target("legacy-file-tree");
		await mkdir(legacy, { recursive: true });
		const session = sessionStoreDir(profile("file-link-profile"), id);
		await mkdir(path.join(session, "state"), { recursive: true });
		const files = {
			quota: path.join(legacy, "quota-marks.json"),
			trials: path.join(legacy, "trials.json"),
			resume: path.join(legacy, "resume.json"),
			trusted: path.join(legacy, "runs.jsonl"),
		};
		for (const file of Object.values(files)) await writeFile(file, "sentinel\n");
		await symlink(files.quota, path.join(session, "state", "quota-marks.json"));
		await symlink(files.trials, path.join(session, "state", "trials.json"));
		await symlink(files.resume, path.join(session, "state", "resume.json"));
		await symlink(files.trusted, path.join(session, "state", "runs.jsonl"));

		await expect(readQuotaMarks(session, 0)).rejects.toThrow(/세션|작업 트리/);
		await expect(readTrialStates(session)).rejects.toThrow(/세션|작업 트리/);
		await expect(readTrustedRuns(session)).rejects.toThrow(/세션|작업 트리/);
		await expect(noteResumePointer(session, { repoId: "r", root: legacy }, runRecord({ runId: "run-20261123-120000-new3" }))).rejects.toThrow(/세션|작업 트리/);
		await expect(trustedResume(session, { repoId: "r", root: legacy }, runRecord({ runId: "run-20261123-120000-new3" }))).rejects.toThrow(/세션|작업 트리/);
		await expect(updateTrialState(session, "trial", current => ({ ...current, seen: 1 }))).rejects.toThrow(/세션|작업 트리/);
		await expect(
			recordTrustedRun(session, { runId: "run-x", artifactsDir: legacy, process: "1:1", agents: [], endedAt: "2026-11-23T00:00:00.000Z" }),
		).rejects.toThrow(/세션|작업 트리/);
		for (const file of Object.values(files)) expect(await readFile(file, "utf8")).toBe("sentinel\n");
	});

	test("ordinary private-profile runtime writes still work and create nothing in the target", async () => {
		const checkout = target("runtime-positive-target");
		await mkdir(checkout, { recursive: true });
		const session = sessionStoreDir(profile("runtime-positive-profile"), id);
		const run = runRecord({
			runId: "run-20261123-120000-ok1",
			status: "stopped",
			startedAt: "2026-11-23T00:00:00.000Z",
			request: "continue the work",
		});
		const summary: RunSummary = {
			schema: "storm.run-summary/v1",
			runId: run.runId,
			startedAt: run.startedAt,
			status: run.status,
			task: run.task,
			costUsd: 0,
			agents: 0,
			spawns: { total: 0, blocked: 0 },
		};

		await writeRun(session, run);
		expect((await readRun(session, run.runId))?.runId).toBe(run.runId);
		expect(await runIds(session)).toContain(run.runId);
		await appendRunIndex(session, summary);
		expect((await readRunIndex(session)).map(item => item.runId)).toEqual([run.runId]);
		await noteResumePointer(session, { repoId: "repo", root: checkout }, run);
		await addQuotaMark(session, { provider: "p", source: "user", markedAt: "2026-11-23T00:00:00.000Z", until: "2099-01-01T00:00:00.000Z" });
		expect(await readQuotaMarks(session, Date.parse("2026-11-23T00:00:00.000Z"))).toHaveLength(1);
		await updateTrialState(session, "trial", current => ({ ...current, seen: 2 }));
		expect((await readTrialStates(session)).trial?.seen).toBe(2);
		await recordTrustedRun(session, { runId: run.runId, artifactsDir: checkout, process: "1:1", agents: [], endedAt: "2026-11-23T00:00:00.000Z" });
		expect((await readTrustedRuns(session)).map(item => item.runId)).toEqual([run.runId]);

		expect(existsSync(path.join(checkout, ".omp"))).toBe(false);
		expect(existsSync(path.join(checkout, "runs"))).toBe(false);
		expect((await readdir(path.join(session, "state", "runs"))).sort()).toEqual(["index.jsonl", `${run.runId}.json`]);
	});
});
