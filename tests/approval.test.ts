import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, rmdir, symlink, utimes, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolveRepo } from "../src/approval/repo.ts";
import { findShadows, unapprovedShadows } from "../src/approval/shadow.ts";
import { ApprovalStore } from "../src/approval/store.ts";
import { validateConfig } from "../src/config/schema.ts";
import { configPath } from "../src/config/store.ts";
import { isApproved, loadProjectState } from "../src/state.ts";
import type { ApprovalRecord, Exec, RepoIdentity, ShadowInfo, StormConfig } from "../src/types.ts";
import { DEAD_PROCESS, teamOf } from "./fixtures.ts";
import { exec, git } from "./support.ts";
import { TEAM_08, TEAM_08_HASH, writeStore08 } from "./team-08.ts";

const config: StormConfig = teamOf({ implementer: "a/b" }, { parallelism: 2, isolation: "isolated" });
/** The pid a lock file names: a process that cannot exist. */
const DEAD_PID = DEAD_PROCESS.split(":")[0];

const HASH_A = `jcs-sha256:${"a".repeat(64)}`;
const HASH_B = `jcs-sha256:${"b".repeat(64)}`;

function approveInput(configHash: string) {
	return { configHash, config, scope: { shadowedAgents: [] } };
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
		await loadProjectState({ cwd: repo, exec: spy, agentDir: path.join(tmp, "agent"), pluginAgentsDir: path.join(tmp, "plugin") });
		expect(calls).toHaveLength(2);
		for (const call of calls) {
			expect(call).toContain("rev-parse");
			expect(call).not.toContain("remote");
			expect(call).not.toContain("rev-list");
		}
	});
});

describe("ApprovalStore", () => {
	const repo: RepoIdentity = { repoId: `git-test-${"0".repeat(24)}`, kind: "git-common-dir", root: "/nowhere/root" };
	const repoDir = () => path.join(tmp, "approvals", repo.repoId);
	/** Approves the hashes in order, one minute apart (the store stamps wall-clock time, which may tie). */
	const approveInOrder = async (store: ApprovalStore, hashes: string[]): Promise<void> => {
		for (const [i, hash] of hashes.entries()) {
			await store.approve(approveInput(hash));
			const file = path.join(repoDir(), "approved", `${hash.slice(11)}.json`);
			const record = JSON.parse(await readFile(file, "utf8"));
			await writeFile(file, JSON.stringify({ ...record, approvedAt: new Date(Date.UTC(2026, 10, 21, 0, i)).toISOString() }));
		}
	};

	test("approve writes the record and the snapshot, and nothing else", async () => {
		const store = new ApprovalStore(tmp, repo);
		const rec = await store.approve(approveInput(HASH_A));
		expect(Object.keys(rec).sort()).toEqual(["approvedAt", "configHash", "schema", "scope", "status"]);
		expect(rec.scope).toEqual({ shadowedAgents: [] });
		expect(await store.active(HASH_A)).toEqual(rec);
		expect(await store.active(HASH_B)).toBeUndefined();
		expect(await store.snapshot(HASH_A)).toEqual(config);
		await store.approve(approveInput(HASH_B));
		expect(await tree(repoDir())).toEqual([
			`approved/${"a".repeat(64)}.json`,
			`approved/${"b".repeat(64)}.json`,
			`snapshots/${"a".repeat(64)}.json`,
			`snapshots/${"b".repeat(64)}.json`,
		]);
	});

	test("list is newest first", async () => {
		const store = new ApprovalStore(tmp, repo);
		const hashes = ["2", "1", "3"].map((c) => `jcs-sha256:${c.repeat(64)}`);
		await approveInOrder(store, hashes);
		expect((await store.list()).map((r) => r.configHash)).toEqual([...hashes].reverse());
	});

	test("a record copied under another hash's file name approves nothing", async () => {
		const store = new ApprovalStore(tmp, repo);
		await store.approve(approveInput(HASH_A));
		const text = await readFile(path.join(repoDir(), "approved", `${"a".repeat(64)}.json`), "utf8");
		await writeFile(path.join(repoDir(), "approved", `${"b".repeat(64)}.json`), text);
		expect(await store.active(HASH_B)).toBeUndefined();
	});

	test("rejects hashes that could escape the store", async () => {
		const store = new ApprovalStore(tmp, repo);
		await expect(store.active("jcs-sha256:../x")).rejects.toThrow();
		await expect(store.approve(approveInput("jcs-sha256:../x"))).rejects.toThrow();
		await expect(store.snapshot("jcs-sha256:../x")).rejects.toThrow();
	});

	test("concurrent approves both land with a clean directory", async () => {
		const store = new ApprovalStore(tmp, repo);
		await Promise.all([store.approve(approveInput(HASH_A)), store.approve(approveInput(HASH_B))]);
		expect(await store.active(HASH_A)).toBeDefined();
		expect(await store.active(HASH_B)).toBeDefined();
		expect((await tree(repoDir())).filter((f) => f.endsWith(".tmp") || path.basename(f) === ".lock")).toEqual([]);
	});

	test("stale lock does not block", async () => {
		const store = new ApprovalStore(tmp, repo);
		await mkdir(repoDir(), { recursive: true });
		const lock = path.join(repoDir(), ".lock");
		await writeFile(lock, `${DEAD_PID} old\n`);
		const old = new Date(Date.now() - 60_000);
		await utimes(lock, old, old);
		const started = Date.now();
		await store.approve(approveInput(HASH_A));
		expect(Date.now() - started).toBeLessThan(5_000);
		expect(await store.active(HASH_A)).toBeDefined();
	});

	test("a failed snapshot write leaves no approval", async () => {
		const store = new ApprovalStore(tmp, repo);
		// A file where the snapshot directory should be makes the first write fail.
		await mkdir(repoDir(), { recursive: true });
		await writeFile(path.join(repoDir(), "snapshots"), "");
		await expect(store.approve(approveInput(HASH_A))).rejects.toThrow();
		expect(await store.active(HASH_A)).toBeUndefined();
	});

	test("a damaged record without its scope is no approval, and readers do not throw on it", async () => {
		const store = new ApprovalStore(tmp, repo);
		const rec = await store.approve(approveInput(HASH_A));
		const file = path.join(repoDir(), "approved", `${"a".repeat(64)}.json`);
		const seen: ShadowInfo = { agent: "storm-reviewer", path: "/p/a.md", scope: "project", sha256: "1".repeat(64) };
		for (const damaged of [{ ...rec, scope: undefined }, { ...rec, scope: {} }, { ...rec, scope: { shadowedAgents: "x" } }]) {
			await writeFile(file, JSON.stringify(damaged));
			expect(await store.active(HASH_A)).toBeUndefined();
			expect(await store.list()).toEqual([]);
			expect(unapprovedShadows(await store.active(HASH_A), [seen])).toEqual([seen]);
		}
	});

	test("a waiter whose directory is removed under it (clear in another process) still gets the lock", async () => {
		const store = new ApprovalStore(tmp, repo);
		// Another process holds the lock.
		await mkdir(repoDir(), { recursive: true });
		await writeFile(path.join(repoDir(), ".lock"), `${DEAD_PID} held\n`);
		const waiting = store.approve(approveInput(HASH_A));
		// What clear() in that process does next: it releases the lock, then removes the directory if nothing is left in it.
		await rm(path.join(repoDir(), ".lock"));
		await rmdir(repoDir()).catch(() => undefined);
		await waiting;
		expect(await store.active(HASH_A)).toBeDefined();
		expect(await tree(repoDir())).toEqual([`approved/${"a".repeat(64)}.json`, `snapshots/${"a".repeat(64)}.json`]);
	});

	test("prune keeps the current hash and the newest others, and removes what 0.8/0.9 wrote and nobody read", async () => {
		const store = new ApprovalStore(tmp, repo);
		await writeStore08(repoDir(), repo.repoId);
		const hashes = ["1", "2", "3"].map((c) => `jcs-sha256:${c.repeat(64)}`);
		await approveInOrder(store, hashes);
		// Keep the 0.8 team (oldest) and one other: hashes 1 and 2 go (2 files each), plus evidence, log and repo.
		expect(await store.prune(TEAM_08_HASH, 1)).toBe(7);
		expect(await tree(repoDir())).toEqual(
			[
				`approved/${"3".repeat(64)}.json`,
				`approved/${TEAM_08_HASH.slice(11)}.json`,
				"runs.jsonl",
				`snapshots/${"3".repeat(64)}.json`,
				`snapshots/${TEAM_08_HASH.slice(11)}.json`,
			].sort(),
		);
		expect(await store.prune(TEAM_08_HASH, 1)).toBe(0);
	});

	test("prune leaves a repo without approvals without a directory", async () => {
		const store = new ApprovalStore(tmp, repo);
		expect(await store.prune(null)).toBe(0);
		expect(await readdir(tmp)).toEqual([]);
	});

	test("clear removes approvals, snapshots and the legacy files but keeps the run list", async () => {
		const store = new ApprovalStore(tmp, repo);
		await writeStore08(repoDir(), repo.repoId);
		await store.approve(approveInput(HASH_A));
		const runs = await readFile(path.join(repoDir(), "runs.jsonl"), "utf8");
		expect(await store.clear()).toBe(2);
		expect(await tree(repoDir())).toEqual(["runs.jsonl"]);
		expect(await readFile(path.join(repoDir(), "runs.jsonl"), "utf8")).toBe(runs);
		expect(await store.list()).toEqual([]);
	});

	test("clear leaves no empty directory when there is no run list", async () => {
		const store = new ApprovalStore(tmp, repo);
		await store.approve(approveInput(HASH_A));
		expect(await store.clear()).toBe(1);
		expect(await readdir(path.join(tmp, "approvals"))).toEqual([]);
		expect(await store.clear()).toBe(0);
	});
});

describe("approvals written by 0.8/0.9 (principle 6)", () => {
	test("the record still loads, lists and makes the 0.8 config approved", async () => {
		const root = path.join(tmp, "project");
		const agentDir = path.join(tmp, "agent");
		await mkdir(path.dirname(configPath(root)), { recursive: true });
		await writeFile(configPath(root), TEAM_08);
		const env = { cwd: root, exec, agentDir, pluginAgentsDir: path.join(tmp, "plugin") };
		const before = await loadProjectState(env);
		expect(before.config.status === "ok" && before.config.hash).toBe(TEAM_08_HASH);
		expect(isApproved(before)).toBe(false);

		await writeStore08(before.store.dir, before.repo.repoId);
		const state = await loadProjectState(env);
		expect(state.approval?.configHash).toBe(TEAM_08_HASH);
		expect(state.approval?.approvalId).toBe("apr_01KA7ZJ4W3Q8N6T5R2M9X0BCDE");
		expect(isApproved(state)).toBe(true);
		expect((await state.store.list()).map((r) => r.configHash)).toEqual([TEAM_08_HASH]);
		expect(validateConfig(await state.store.snapshot(TEAM_08_HASH)).errors).toEqual([]);
		// Reading changes nothing on disk: the user's file and the old record stay byte for byte.
		expect(await readFile(configPath(root), "utf8")).toBe(TEAM_08);
		expect(await tree(state.store.dir)).toContain("log.jsonl");
	});

	test("a shadowing definition the approval did not cover makes it unapproved", () => {
		const seen: ShadowInfo = { agent: "storm-reviewer", path: "/p/a.md", scope: "project", sha256: "1".repeat(64) };
		const approval: ApprovalRecord = { schema: "storm.approval/v1", status: "active", repoId: "r", configHash: HASH_A, approvedAt: "x", scope: { shadowedAgents: [seen] } };
		expect(unapprovedShadows(approval, [seen])).toEqual([]);
		expect(unapprovedShadows(approval, [{ ...seen, sha256: "2".repeat(64) }])).toHaveLength(1);
		expect(unapprovedShadows(undefined, [seen])).toEqual([seen]);
	});
});

describe("findShadows", () => {
	const agent = (name: string) => `---\nname: ${name}\ndescription: x\n---\nbody\n`;

	test("scans only the nearest project dir and keys on frontmatter name", async () => {
		const outer = path.join(tmp, "proj", ".omp", "agents");
		const inner = path.join(tmp, "proj", "sub", ".omp", "agents");
		const cwd = path.join(tmp, "proj", "sub", "deep");
		const user = path.join(tmp, "user-agents");
		const plugin = path.join(tmp, "plugin", "agents");
		for (const d of [outer, inner, cwd, user, plugin]) await mkdir(d, { recursive: true });
		await writeFile(path.join(outer, "storm-outer.md"), agent("storm-outer"));
		await writeFile(path.join(inner, "storm-inner.md"), agent("storm-inner"));
		await writeFile(path.join(inner, "helper.md"), agent("helper"));
		await writeFile(path.join(user, "storm-x.md"), agent("other"));
		await writeFile(path.join(user, "foo.md"), agent("storm-reviewer"));
		await writeFile(path.join(user, "bad.md"), "---\nname: [unclosed\n---\n");

		const shadows = await findShadows({ cwd, userAgentsDir: user, pluginAgentsDir: plugin });
		expect(shadows.map((s) => [s.scope, s.agent, s.path])).toEqual([
			["project", "storm-inner", path.join(inner, "storm-inner.md")],
			["user", "storm-reviewer", path.join(user, "foo.md")],
		]);
		expect(shadows[1]?.sha256).toBe(new Bun.CryptoHasher("sha256").update(agent("storm-reviewer")).digest("hex"));
	});

	test("plugin's own definitions are never shadows", async () => {
		const plugin = path.join(tmp, "plugin", "agents");
		await mkdir(plugin, { recursive: true });
		await writeFile(path.join(plugin, "storm-reviewer.md"), agent("storm-reviewer"));
		const link = path.join(tmp, "user-link");
		await symlink(plugin, link);
		const cwd = path.join(tmp, "empty");
		await mkdir(cwd);
		expect(await findShadows({ cwd, userAgentsDir: link, pluginAgentsDir: plugin })).toEqual([]);
		expect(await findShadows({ cwd, userAgentsDir: plugin, pluginAgentsDir: plugin })).toEqual([]);
	});

	test("missing dirs yield nothing", async () => {
		const cwd = path.join(tmp, "none");
		await mkdir(cwd);
		const shadows = await findShadows({
			cwd,
			userAgentsDir: path.join(tmp, "missing-user"),
			pluginAgentsDir: path.join(tmp, "missing-plugin"),
		});
		expect(shadows).toEqual([]);
	});
});
