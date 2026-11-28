import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { discoverAgents } from "@oh-my-pi/pi-coding-agent/task/discovery";
import { resolveRepo } from "../src/approval/repo.ts";
import { findShadows, isRoutedAgentName, unattestedShadows, unapprovedShadows, type LiveDiscovery } from "../src/approval/shadow.ts";
import { ApprovalStore } from "../src/approval/store.ts";
import { effectiveAgentTools, lanePolicy, shellReader } from "../src/policy/capability.ts";
import { sessionStoreDir } from "../src/session-scope.ts";
import { loadProjectState } from "../src/state.ts";
import type { ApprovalRecord, Exec, PlanLane, RepoIdentity, ShadowInfo, StormConfig } from "../src/types.ts";
import { DEAD_PROCESS, teamOf } from "./fixtures.ts";
import { exec, git } from "./support.ts";
import { TEAM_08, TEAM_08_HASH, writeStore08 } from "./team-08.ts";

const config: StormConfig = teamOf({ implementer: "a/b" }, { rounds: 2, isolation: "isolated" });
/** The pid a lock file names: a process that cannot exist. */
const DEAD_PID = DEAD_PROCESS.split(":")[0];

const HASH_A = `jcs-sha256:${"a".repeat(64)}`;
const HASH_B = `jcs-sha256:${"b".repeat(64)}`;

function approveInput(configHash: string) {
	return { configHash, config, scope: { shadowedAgents: [] } };
}

/** A live-session discovery input with no ambient roots, so only the roots a test names contribute. */
function discovery(opts: {
	explicit?: readonly string[];
	mode?: "merge" | "explicit-only";
	configured?: readonly string[];
	configuredLevel?: "user" | "project";
	sessionAgents?: LiveDiscovery["sessionAgents"];
} = {}): LiveDiscovery {
	return {
		extensionRoots: {
			explicit: opts.explicit ?? [],
			mode: opts.mode ?? "explicit-only",
			configured: opts.configured ?? [],
			configuredLevel: opts.configuredLevel ?? "user",
		},
		sessionAgents: opts.sessionAgents ?? [],
	};
}

/** Shadows whose file is inside this test's temp tree, ignoring the runner's real user-level agents. */
function owned(shadows: readonly ShadowInfo[]): ShadowInfo[] {
	return shadows.filter(shadow => shadow.path.startsWith(tmp + path.sep));
}

/** Every file under `dir`, relative, sorted. */
async function tree(dir: string): Promise<string[]> {
	const names = await readdir(dir, { recursive: true, withFileTypes: true });
	return names
		.filter(entry => entry.isFile())
		.map(entry => path.relative(dir, path.join(entry.parentPath, entry.name)))
		.sort();
}

let tmp: string;

beforeEach(async () => {
	tmp = await realpath(await mkdtemp(path.join(os.tmpdir(), "storm-approval-")));
});

afterEach(async () => {
	await rm(tmp, { recursive: true, force: true });
});

describe("resolveRepo", () => {
	test("worktree shares repoId with its main checkout; clone and plain dir differ", async () => {
		const repo = path.join(tmp, "my repo");
		await mkdir(repo);
		await git(repo, "init", "-q");
		await git(repo, "commit", "-q", "--allow-empty", "-m", "init");
		const wt = path.join(tmp, "wt");
		await git(repo, "worktree", "add", "-q", "-b", "wt", wt);
		const clone = path.join(tmp, "clone");
		await git(tmp, "clone", "-q", repo, clone);
		const plain = path.join(tmp, "plain");
		await mkdir(plain);

		const main = await resolveRepo(repo, exec);
		const worktree = await resolveRepo(wt, exec);
		const cloned = await resolveRepo(clone, exec);
		const dir = await resolveRepo(plain, exec);

		expect(main.kind).toBe("git-common-dir");
		expect(main.repoId).toMatch(/^git-my-repo-[0-9a-f]{24}$/);
		expect(worktree.repoId).toBe(main.repoId);
		expect(main.root).toBe(await realpath(repo));
		expect(worktree.root).toBe(await realpath(wt));
		expect(cloned.repoId).not.toBe(main.repoId);
		expect(Object.keys(main).sort()).toEqual(["kind", "repoId", "root"]);
		expect(dir.kind).toBe("dir");
		expect(dir.repoId.startsWith("dir-plain-")).toBe(true);
		expect(dir.root).toBe(plain);
	});

	test("asks git one question: no remote and no root-commit lookup", async () => {
		const repo = path.join(tmp, "r");
		await mkdir(repo);
		await git(repo, "init", "-q");
		const calls: string[][] = [];
		const spy: Exec = (command, args, options) => {
			calls.push([command, ...args]);
			return exec(command, args, options);
		};
		await resolveRepo(repo, spy);
		await loadProjectState({
			cwd: repo,
			exec: spy,
			agentDir: path.join(tmp, "agent"),
			pluginAgentsDir: path.join(tmp, "plugin"),
			sessionId: "native-session",
		});
		expect(calls).toHaveLength(2);
		for (const call of calls) {
			expect(call).toContain("rev-parse");
			expect(call).not.toContain("remote");
			expect(call).not.toContain("rev-list");
		}
	});
});

describe("ApprovalStore", () => {
	/** The session store and target a test approval belongs to. */
	const profile = (name = "profile") => path.join(tmp, name);
	const sessionDir = (id = "native-session") => sessionStoreDir(profile(), id);
	const target = (name = "target"): RepoIdentity => ({
		repoId: `git-test-${"0".repeat(24)}`,
		kind: "git-common-dir",
		root: path.join(tmp, name),
	});
	const makeStore = (repo = target(), session = sessionDir()) => new ApprovalStore(session, repo);

	/** Approves the hashes in order, one minute apart (the store stamps wall-clock time, which may tie). */
	const approveInOrder = async (store: ApprovalStore, hashes: string[]): Promise<void> => {
		for (const [i, hash] of hashes.entries()) {
			await store.approve(approveInput(hash));
			const file = path.join(store.dir, "approved", `${hash.slice(11)}.json`);
			const record = JSON.parse(await readFile(file, "utf8"));
			await writeFile(file, JSON.stringify({ ...record, approvedAt: new Date(Date.UTC(2026, 10, 21, 0, i)).toISOString() }));
		}
	};

	test("approve writes the target-bound record and snapshot, and nothing else", async () => {
		const store = makeStore();
		const rec = await store.approve(approveInput(HASH_A));
		expect(Object.keys(rec).sort()).toEqual(["approvedAt", "configHash", "schema", "scope", "status", "target"]);
		expect(rec.target).toBe(store.targetKey);
		expect(rec.scope).toEqual({ shadowedAgents: [] });
		expect(store.dir).toBe(path.join(sessionDir(), "approvals", store.targetKey));
		expect(await store.active(HASH_A)).toEqual(rec);
		expect(await store.active(HASH_B)).toBeUndefined();
		expect(await store.snapshot(HASH_A)).toEqual(config);
		await store.approve(approveInput(HASH_B));
		expect(await tree(store.dir)).toEqual([
			`approved/${"a".repeat(64)}.json`,
			`approved/${"b".repeat(64)}.json`,
			`snapshots/${"a".repeat(64)}.json`,
			`snapshots/${"b".repeat(64)}.json`,
		]);
		expect(await readdir(sessionDir())).toEqual(["approvals"]);
	});

	test("list is newest first", async () => {
		const store = makeStore();
		const hashes = ["2", "1", "3"].map((c) => `jcs-sha256:${c.repeat(64)}`);
		await approveInOrder(store, hashes);
		expect((await store.list()).map((r) => r.configHash)).toEqual([...hashes].reverse());
	});

	test("a record copied under another hash's file name approves nothing", async () => {
		const store = makeStore();
		await store.approve(approveInput(HASH_A));
		const text = await readFile(path.join(store.dir, "approved", `${"a".repeat(64)}.json`), "utf8");
		await writeFile(path.join(store.dir, "approved", `${"b".repeat(64)}.json`), text);
		expect(await store.active(HASH_B)).toBeUndefined();
		expect((await store.list()).map((r) => r.configHash)).toEqual([HASH_A]);
	});

	test("linked worktrees of one repo, and copies of a record, never grant each other approval", async () => {
		const main = makeStore(target("main"));
		const worktree = makeStore(target("worktree"));
		expect(worktree.targetKey).not.toBe(main.targetKey);
		await main.approve(approveInput(HASH_A));
		expect(await worktree.active(HASH_A)).toBeUndefined();
		expect(await worktree.list()).toEqual([]);

		// Even a record copied into the other target's directory is not approval for that target.
		await mkdir(path.join(worktree.dir, "approved"), { recursive: true });
		const text = await readFile(path.join(main.dir, "approved", `${"a".repeat(64)}.json`), "utf8");
		await writeFile(path.join(worktree.dir, "approved", `${"a".repeat(64)}.json`), text);
		expect(await worktree.active(HASH_A)).toBeUndefined();
		expect(await worktree.list()).toEqual([]);
	});

	test("two sessions in one profile never share approvals", async () => {
		const one = makeStore(target(), sessionDir("session-one"));
		const two = makeStore(target(), sessionDir("session-two"));
		await one.approve(approveInput(HASH_A));
		expect(await two.active(HASH_A)).toBeUndefined();
		expect(await two.clear()).toBe(0);
		expect(await one.active(HASH_A)).toBeDefined();
	});

	test("rejects hashes that could escape the store", async () => {
		const store = makeStore();
		await expect(store.active("jcs-sha256:../x")).rejects.toThrow();
		await expect(store.approve(approveInput("jcs-sha256:../x"))).rejects.toThrow();
		await expect(store.snapshot("jcs-sha256:../x")).rejects.toThrow();
	});

	test("concurrent approves both land with a clean directory", async () => {
		const store = makeStore();
		await Promise.all([store.approve(approveInput(HASH_A)), store.approve(approveInput(HASH_B))]);
		expect(await store.active(HASH_A)).toBeDefined();
		expect(await store.active(HASH_B)).toBeDefined();
		expect((await tree(store.dir)).filter((f) => f.endsWith(".tmp") || path.basename(f) === ".lock")).toEqual([]);
	});

	test("stale lock does not block", async () => {
		const store = makeStore();
		const approvals = path.join(sessionDir(), "approvals");
		await mkdir(approvals, { recursive: true });
		const lock = path.join(approvals, ".lock");
		await writeFile(lock, `${DEAD_PID} old\n`);
		const old = new Date(Date.now() - 60_000);
		await utimes(lock, old, old);
		const started = Date.now();
		await store.approve(approveInput(HASH_A));
		expect(Date.now() - started).toBeLessThan(5_000);
		expect(await store.active(HASH_A)).toBeDefined();
	});

	test("a failed snapshot write leaves no approval", async () => {
		const store = makeStore();
		// A file where the snapshot directory should be makes the first write fail.
		await mkdir(store.dir, { recursive: true });
		await writeFile(path.join(store.dir, "snapshots"), "");
		await expect(store.approve(approveInput(HASH_A))).rejects.toThrow();
		expect(await store.active(HASH_A)).toBeUndefined();
	});

	test("a damaged record without its scope or target is no approval, and readers do not throw on it", async () => {
		const store = makeStore();
		const rec = await store.approve(approveInput(HASH_A));
		const file = path.join(store.dir, "approved", `${"a".repeat(64)}.json`);
		const seen: ShadowInfo = { agent: "storm-reviewer", path: "/p/a.md", scope: "project", sha256: "1".repeat(64) };
		for (const damaged of [
			{ ...rec, scope: undefined },
			{ ...rec, scope: {} },
			{ ...rec, scope: { shadowedAgents: "x" } },
			{ ...rec, target: undefined },
			{ ...rec, target: "other-target" },
		]) {
			await writeFile(file, JSON.stringify(damaged));
			expect(await store.active(HASH_A)).toBeUndefined();
			expect(await store.list()).toEqual([]);
			expect(unapprovedShadows(await store.active(HASH_A), [seen])).toEqual([seen]);
		}
	});

	test("a waiter whose target directory is removed under it (clear in another process) still gets the lock", async () => {
		const store = makeStore();
		// Another process holds the lock.
		const approvals = path.join(sessionDir(), "approvals");
		await mkdir(approvals, { recursive: true });
		const lock = path.join(approvals, ".lock");
		await writeFile(lock, `${DEAD_PID} held\n`);
		const waiting = store.approve(approveInput(HASH_A));
		// What clear() in that process does next: it releases the lock, then removes the emptied directories.
		await rm(lock);
		await rm(store.dir, { recursive: true, force: true });
		await waiting;
		expect(await store.active(HASH_A)).toBeDefined();
		expect(await tree(store.dir)).toEqual([`approved/${"a".repeat(64)}.json`, `snapshots/${"a".repeat(64)}.json`]);
	});

	test("prune keeps the current hash and the newest others, and never touches old stores", async () => {
		const store = makeStore();
		const legacy = path.join(tmp, "agent", "storm", "approvals", `git-old-${"0".repeat(24)}`);
		await writeStore08(legacy, "git-old");
		const legacyBefore = await tree(legacy);
		const legacyBytes = await readFile(path.join(legacy, "log.jsonl"));
		const hashes = ["1", "2", "3"].map((c) => `jcs-sha256:${c.repeat(64)}`);
		await approveInOrder(store, [TEAM_08_HASH, ...hashes]);
		// Keep the oldest (the fixture) and one other: hashes 1 and 2 go (2 files each), nothing else is touched.
		expect(await store.prune(TEAM_08_HASH, 1)).toBe(4);
		expect(await tree(store.dir)).toEqual(
			[
				`approved/${"3".repeat(64)}.json`,
				`approved/${TEAM_08_HASH.slice(11)}.json`,
				`snapshots/${"3".repeat(64)}.json`,
				`snapshots/${TEAM_08_HASH.slice(11)}.json`,
			].sort(),
		);
		expect(await store.prune(TEAM_08_HASH, 1)).toBe(0);
		expect(await tree(legacy)).toEqual(legacyBefore);
		expect(await readFile(path.join(legacy, "log.jsonl"))).toEqual(legacyBytes);
	});

	test("prune leaves a session without approvals without a directory", async () => {
		const store = makeStore();
		expect(await store.prune(null)).toBe(0);
		expect(existsSync(sessionDir())).toBe(false);
	});

	test("clear removes every approval of this session across targets but keeps runs and other sessions", async () => {
		const main = makeStore(target("main"));
		const worktree = makeStore(target("worktree"));
		const foreign = makeStore(target("main"), sessionStoreDir(profile("foreign-profile"), "native-session"));
		await main.approve(approveInput(HASH_A));
		await worktree.approve(approveInput(HASH_A));
		await foreign.approve(approveInput(HASH_A));
		await writeFile(path.join(main.dir, "runs.jsonl"), "keep\n");
		const runs = await readFile(path.join(main.dir, "runs.jsonl"), "utf8");

		expect(await main.clear()).toBe(2);
		expect(existsSync(path.join(main.dir, "approved"))).toBe(false);
		expect(existsSync(path.join(main.dir, "snapshots"))).toBe(false);
		expect(await readFile(path.join(main.dir, "runs.jsonl"), "utf8")).toBe(runs);
		expect(existsSync(worktree.dir)).toBe(false);
		expect(await foreign.active(HASH_A)).toBeDefined();
		expect(await main.list()).toEqual([]);
	});

	test("clear leaves no empty directory when there is no run list", async () => {
		const store = makeStore();
		await store.approve(approveInput(HASH_A));
		expect(await store.clear()).toBe(1);
		expect(existsSync(path.join(sessionDir(), "approvals"))).toBe(false);
		expect(await store.clear()).toBe(0);
	});
});

describe("approvals written before session stores (principle 6: no implicit import or cleanup)", () => {
	test("old config and approvals are neither read nor removed, even by reset", async () => {
		const root = path.join(tmp, "project");
		const agentDir = path.join(tmp, "agent");
		const oldConfig = path.join(root, ".omp", "storm", "config.json");
		const oldStore = path.join(agentDir, "storm", "approvals", `git-old-${"0".repeat(24)}`);
		await mkdir(path.dirname(oldConfig), { recursive: true });
		await writeFile(oldConfig, TEAM_08);
		await writeStore08(oldStore, "git-old");
		const beforeTree = await tree(oldStore);
		const beforeLog = await readFile(path.join(oldStore, "log.jsonl"));

		const env = { cwd: root, exec, agentDir, pluginAgentsDir: path.join(tmp, "plugin"), sessionId: "native-session" };
		const state = await loadProjectState(env);
		expect(state.config.status).toBe("missing");
		expect(state.approval).toBeUndefined();
		expect(await state.store.list()).toEqual([]);
		expect(await readFile(oldConfig, "utf8")).toBe(TEAM_08);

		expect(await state.store.clear()).toBe(0);
		expect(await tree(oldStore)).toEqual(beforeTree);
		expect(await readFile(path.join(oldStore, "log.jsonl"))).toEqual(beforeLog);
		expect(await readFile(oldConfig, "utf8")).toBe(TEAM_08);
	});

	test("a shadowing definition the approval did not cover makes it unapproved", () => {
		const seen: ShadowInfo = { agent: "storm-reviewer", path: "/p/a.md", scope: "project", sha256: "1".repeat(64) };
		const approval: ApprovalRecord = { schema: "storm.approval/v1", status: "active", repoId: "r", target: "t", configHash: HASH_A, approvedAt: "x", scope: { shadowedAgents: [seen] } };
		expect(unapprovedShadows(approval, [seen])).toEqual([]);
		expect(unapprovedShadows(approval, [{ ...seen, sha256: "2".repeat(64) }])).toHaveLength(1);
		expect(unapprovedShadows(undefined, [seen])).toEqual([seen]);
	});
});

describe("findShadows", () => {
	const agent = (name: string) => `---\nname: ${name}\ndescription: x\n---\nbody\n`;

	test("uses native discovery: nearest project dir, extension roots, declared name", async () => {
		const outer = path.join(tmp, "proj", ".omp", "agents");
		const inner = path.join(tmp, "proj", "sub", ".omp", "agents");
		const cwd = path.join(tmp, "proj", "sub", "deep");
		const ext = path.join(tmp, "pkg");
		const extAgents = path.join(ext, "agents");
		const plugin = path.join(tmp, "plugin", "agents");
		for (const d of [outer, inner, cwd, extAgents, plugin]) await mkdir(d, { recursive: true });
		await writeFile(path.join(outer, "storm-architect.md"), agent("storm-architect"));
		await writeFile(path.join(inner, "storm-quick.md"), agent("storm-quick"));
		await writeFile(path.join(inner, "helper.md"), agent("helper"));
		await writeFile(path.join(extAgents, "storm-x.md"), agent("other"));
		const declared = path.join(extAgents, "foo.md");
		const declaredText = agent("storm-reviewer");
		await writeFile(declared, declaredText);
		await writeFile(path.join(extAgents, "bad.md"), "---\nname: [unclosed\n---\n");

		const shadows = owned(await findShadows({ cwd, pluginAgentsDir: plugin, discovery: discovery({ explicit: [ext] }), home: tmp }));
		expect(shadows.map(s => [s.scope, s.agent, s.path])).toEqual([
			["user", "storm-reviewer", declared],
			["project", "storm-quick", path.join(inner, "storm-quick.md")],
		]);
		expect(shadows[0]?.sha256).toBe(new Bun.CryptoHasher("sha256").update(declaredText).digest("hex"));
	});

	test("adding the shell to an approved definition changes its hash, so the approval no longer covers it and the lane policy changes with it", async () => {
		const ext = path.join(tmp, "pkg");
		const agents = path.join(ext, "agents");
		const plugin = path.join(tmp, "plugin", "agents");
		const cwd = path.join(tmp, "work");
		for (const d of [agents, plugin, cwd]) await mkdir(d, { recursive: true });
		const file = path.join(agents, "explorer.md");
		const body = (tools: string) => `---\nname: storm-explorer\ndescription: x\ntools: ${tools}\n---\nbody\n`;
		const opts = { cwd, pluginAgentsDir: plugin, discovery: discovery({ explicit: [ext] }), home: tmp };
		await writeFile(file, body("read, grep, find"));
		const before = owned(await findShadows(opts));
		expect(before).toHaveLength(1);
		const approval: ApprovalRecord = { schema: "storm.approval/v1", status: "active", repoId: "r", target: "t", configHash: HASH_A, approvedAt: "x", scope: { shadowedAgents: before } };
		expect(unapprovedShadows(approval, before)).toEqual([]);
		const explore: PlanLane = { name: "scout", kind: "explore", role: "explorer" };
		const plain = lanePolicy({ lane: explore, tools: effectiveAgentTools("storm-explorer", before, plugin), isolated: false, auto: false });
		expect(shellReader(plain)).toBe(false);

		// The user adds the shell: the same file now hashes differently and is no longer covered by the approval.
		await writeFile(file, body("read, grep, find, bash"));
		const after = owned(await findShadows(opts));
		expect(after[0]?.sha256).not.toBe(before[0]?.sha256);
		expect(unapprovedShadows(approval, after)).toHaveLength(1);
		// Storm reads the tool list from the file; with the shell it is a shell reader, which only an approved file may be.
		const shell = lanePolicy({ lane: explore, tools: effectiveAgentTools("storm-explorer", after, plugin), isolated: false, auto: false });
		expect(shell).toMatchObject({ kind: "read", shell: true });

		// Approving the new content covers it again; taking the shell out again returns to the first hash.
		const reapproved: ApprovalRecord = { ...approval, scope: { shadowedAgents: after } };
		expect(unapprovedShadows(reapproved, after)).toEqual([]);
		await writeFile(file, body("read, grep, find"));
		const back = owned(await findShadows(opts));
		expect(back[0]?.sha256).toBe(before[0]?.sha256);
		expect(unapprovedShadows(reapproved, back)).toHaveLength(1);
	});

	test("plugin's own definitions are never shadows, even mounted as an extension root", async () => {
		const plugin = path.join(tmp, "plugin", "agents");
		await mkdir(plugin, { recursive: true });
		await writeFile(path.join(plugin, "storm-reviewer.md"), agent("storm-reviewer"));
		const ext = path.join(tmp, "pkg");
		await mkdir(ext, { recursive: true });
		await symlink(plugin, path.join(ext, "agents"));
		const cwd = path.join(tmp, "empty");
		await mkdir(cwd);
		const shadows = await findShadows({ cwd, pluginAgentsDir: plugin, discovery: discovery({ explicit: [ext] }), home: tmp });
		expect(owned(shadows)).toEqual([]);
	});

	test("a project definition under a bundled agent's name is a shadow the approval must cover (B1)", async () => {
		const cwd = path.join(tmp, "b1", "work");
		const agents = path.join(tmp, "b1", ".omp", "agents");
		const plugin = path.join(tmp, "b1-plugin");
		for (const d of [cwd, agents, plugin]) await mkdir(d, { recursive: true });
		const file = path.join(agents, "task.md");
		await writeFile(file, agent("task"));
		const opts = { cwd, pluginAgentsDir: plugin, discovery: discovery(), home: tmp };
		const shadows = owned(await findShadows(opts));
		expect(shadows.map(s => [s.agent, s.path])).toEqual([["task", file]]);
		// Renaming the declared agent removes the shadow even if the file is still named task.md.
		await writeFile(file, agent("something-else"));
		expect(owned(await findShadows(opts))).toEqual([]);
	});

	test("an explicit extension definition ahead of bundled task is caught and approved by exactly its selected digest (B1)", async () => {
		const cwd = path.join(tmp, "b1-ext", "work");
		const ext = path.join(tmp, "b1-ext", "pkg");
		const agents = path.join(ext, "agents");
		const plugin = path.join(tmp, "b1-ext-plugin");
		for (const d of [cwd, agents, plugin]) await mkdir(d, { recursive: true });
		const file = path.join(agents, "fixture.md");
		const text = "---\nname: task\ndescription: An ordinary local task definition\n---\nOnly return the fixture note.\n";
		await writeFile(file, text);
		const roots: LiveDiscovery["extensionRoots"] = { explicit: [ext], mode: "explicit-only", configured: [], configuredLevel: "user" };
		const native = await discoverAgents(cwd, tmp, roots);
		expect(native.agents.find(a => a.name === "task")?.filePath).toBe(file);

		const shadows = await findShadows({ cwd, pluginAgentsDir: plugin, discovery: { extensionRoots: roots, sessionAgents: [] }, home: tmp });
		const task = shadows.filter(s => s.agent === "task");
		expect(task).toEqual([{ agent: "task", path: file, scope: "user", sha256: new Bun.CryptoHasher("sha256").update(text).digest("hex") }]);
		const approval: ApprovalRecord = { schema: "storm.approval/v1", status: "active", repoId: "r", target: "t", configHash: HASH_A, approvedAt: "x", scope: { shadowedAgents: task } };
		expect(unapprovedShadows(approval, task)).toEqual([]);
		const other = { ...task[0]!, sha256: "0".repeat(64) };
		expect(unapprovedShadows({ ...approval, scope: { shadowedAgents: [other] } }, task)).toHaveLength(1);
	});

	test("a session agent appended by the host under a routed name is unattested when it has no file", async () => {
		const cwd = path.join(tmp, "session-agent", "work");
		const plugin = path.join(tmp, "session-agent-plugin");
		await mkdir(cwd, { recursive: true });
		await mkdir(plugin, { recursive: true });
		const sessionAgent: LiveDiscovery["sessionAgents"][number] = { name: "storm-quick", description: "", systemPrompt: "", source: "user" };
		const shadows = await findShadows({ cwd, pluginAgentsDir: plugin, discovery: discovery({ sessionAgents: [sessionAgent] }), home: tmp });
		expect(shadows.find(s => s.agent === "storm-quick")).toEqual({ agent: "storm-quick", path: "", scope: "user", sha256: "" });
	});

	test("a file native discovery cannot read is not selected by the host, so it is not an approved shadow", async () => {
		if (process.getuid?.() === 0) return;
		const cwd = path.join(tmp, "b1-unreadable", "work");
		const agents = path.join(tmp, "b1-unreadable", ".omp", "agents");
		const plugin = path.join(tmp, "b1-unreadable-plugin");
		for (const d of [cwd, agents, plugin]) await mkdir(d, { recursive: true });
		const file = path.join(agents, "task.md");
		await writeFile(file, agent("task"));
		await chmod(file, 0o000);
		try {
			expect(owned(await findShadows({ cwd, pluginAgentsDir: plugin, discovery: discovery(), home: tmp }))).toEqual([]);
		} finally {
			await chmod(file, 0o600);
		}
	});

	test("unknown discovery is unattested per routed name, and empty roots are not unknown", async () => {
		const cwd = path.join(tmp, "known-empty");
		const plugin = path.join(tmp, "known-empty-plugin");
		await mkdir(cwd, { recursive: true });
		await mkdir(plugin, { recursive: true });
		const known = await findShadows({ cwd, pluginAgentsDir: plugin, discovery: discovery(), home: tmp });
		expect(known.some(s => s.path === "")).toBe(false);
		const unknown = unattestedShadows();
		expect(unknown.length).toBeGreaterThan(0);
		expect(unknown.every(s => s.path === "" && s.sha256 === "" && isRoutedAgentName(s.agent))).toBe(true);
		expect(unknown.map(s => s.agent)).toContain("task");
		const approval: ApprovalRecord = { schema: "storm.approval/v1", status: "active", repoId: "r", target: "t", configHash: HASH_A, approvedAt: "x", scope: { shadowedAgents: unknown } };
		expect(unapprovedShadows(approval, unknown)).toEqual(unknown);
	});

	test("missing dirs yield nothing", async () => {
		const cwd = path.join(tmp, "none");
		await mkdir(cwd);
		const shadows = await findShadows({
			cwd,
			pluginAgentsDir: path.join(tmp, "missing-plugin"),
			discovery: discovery(),
			home: tmp,
		});
		expect(owned(shadows)).toEqual([]);
	});
});
