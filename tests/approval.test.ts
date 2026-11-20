import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { normalizeRemote, resolveRepo } from "../src/approval/repo.ts";
import { findShadows } from "../src/approval/shadow.ts";
import { ApprovalStore } from "../src/approval/store.ts";
import type { ApprovalScope, EvidenceRecord, Exec, RepoIdentity, StormConfig } from "../src/types.ts";

const exec: Exec = async (command, args, options) => {
	const p = Bun.spawn([command, ...args], {
		...(options?.cwd !== undefined ? { cwd: options.cwd } : {}),
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(p.stdout).text(),
		new Response(p.stderr).text(),
		p.exited,
	]);
	return { stdout, stderr, code };
};

async function git(...args: string[]): Promise<string> {
	const res = await exec("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args]);
	if (res.code !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr}`);
	return res.stdout;
}

const config: StormConfig = {
	version: 1,
	priority: "balanced",
	roles: { reviewer: { agent: "storm-reviewer", models: ["a/b"] } },
	parallelism: 2,
	isolation: "isolated",
	contract: "workflowz",
	runtime: "omp",
};

const scope: ApprovalScope = { providers: ["a"], roles: config.roles, runtime: "omp", shadowedAgents: [] };

const HASH_A = `jcs-sha256:${"a".repeat(64)}`;
const HASH_B = `jcs-sha256:${"b".repeat(64)}`;

function approveInput(configHash: string) {
	return { configHash, rawSha256: "c".repeat(64), config, scope, via: "dialog", ompVersion: "19.0.1", supersedes: null };
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
		await git("-C", repo, "init", "-q");
		await git("-C", repo, "commit", "-q", "--allow-empty", "-m", "init");
		const wt = path.join(tmp, "wt");
		await git("-C", repo, "worktree", "add", "-q", "-b", "wt", wt);
		const clone = path.join(tmp, "clone");
		await git("clone", "-q", repo, clone);
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
		expect(main.rootCommits?.length).toBe(1);
		expect(cloned.rootCommits).toEqual(main.rootCommits);
		expect(dir.kind).toBe("dir");
		expect(dir.repoId.startsWith("dir-plain-")).toBe(true);
		expect(dir.root).toBe(plain);
		expect(dir.commonDir).toBeUndefined();
	});

	test("remotes never carry credentials", async () => {
		const repo = path.join(tmp, "r");
		await mkdir(repo);
		await git("-C", repo, "init", "-q");
		await git("-C", repo, "remote", "add", "origin", "https://user:tok@GitHub.com/o/r.git");
		const id = await resolveRepo(repo, exec);
		expect(id.remotes).toEqual({ origin: "github.com/o/r" });
		expect(id.rootCommits).toBeUndefined();
		expect(JSON.stringify(id)).not.toContain("tok");
	});
});

describe("normalizeRemote", () => {
	test("normalizes URL and scp forms without credentials", () => {
		const cases: Array<[string, string]> = [
			["https://user:tok@GitHub.com/o/r.git/", "github.com/o/r"],
			["git@github.com:o/r.git", "github.com/o/r"],
			["ssh://git@host:2222/o/r.git", "host:2222/o/r"],
			["https://tok@github.com/o/r?x=1#frag", "github.com/o/r"],
		];
		for (const [input, expected] of cases) {
			const out = normalizeRemote(input);
			expect(out).toBe(expected);
			expect(out).not.toContain("tok");
			expect(out).not.toContain("@");
		}
		expect(normalizeRemote("/srv/git/proj.git/")).toBe("/srv/git/proj");
	});
});

describe("ApprovalStore", () => {
	const repo: RepoIdentity = {
		repoId: `git-test-${"0".repeat(24)}`,
		kind: "git-common-dir",
		root: "/nowhere/root",
		commonDir: "/nowhere/root/.git",
	};
	const repoDir = () => path.join(tmp, "approvals", repo.repoId);

	test("approve, read back, revoke", async () => {
		const store = new ApprovalStore(tmp, repo);
		const rec = await store.approve(approveInput(HASH_A));
		expect(rec.approvalId).toMatch(/^apr_[0-9A-HJKMNP-TV-Z]{26}$/);
		expect(await store.active(HASH_A)).toEqual(rec);
		expect(await store.snapshot(HASH_A)).toEqual(config);
		expect(await store.log()).toMatchObject([{ event: "approved", approvalId: rec.approvalId, configHash: HASH_A }]);

		const repoFile = path.join(repoDir(), "repo.json");
		const repoJson = JSON.parse(await readFile(repoFile, "utf8"));
		expect(repoJson.schema).toBe("storm.repo/v1");
		expect(repoJson.root).toBeUndefined();
		const old = "2000-01-01T00:00:00.000Z";
		await writeFile(repoFile, JSON.stringify({ ...repoJson, firstSeenAt: old, lastSeenAt: old }));
		await store.approve(approveInput(HASH_B));
		const repoJson2 = JSON.parse(await readFile(repoFile, "utf8"));
		expect(repoJson2.firstSeenAt).toBe(old);
		expect(repoJson2.lastSeenAt > old).toBe(true);

		expect(await store.revoke(HASH_A)).toBe(true);
		expect(await store.active(HASH_A)).toBeUndefined();
		expect(await store.revoke(HASH_A)).toBe(false);
		const log = await store.log();
		expect(log.map((e) => e.event)).toEqual(["approved", "approved", "revoked"]);
		expect((await store.list()).map((r) => r.configHash)).toEqual([HASH_B]);
	});

	test("list is newest first even within the same millisecond", async () => {
		const store = new ApprovalStore(tmp, repo);
		const hashes = ["1", "2", "3"].map((c) => `jcs-sha256:${c.repeat(64)}`);
		for (const h of hashes) await store.approve(approveInput(h));
		expect((await store.list()).map((r) => r.configHash)).toEqual([...hashes].reverse());
	});

	test("expired approval is not active", async () => {
		const store = new ApprovalStore(tmp, repo);
		await store.approve(approveInput(HASH_A));
		const file = path.join(repoDir(), "approved", `${"a".repeat(64)}.json`);
		const rec = JSON.parse(await readFile(file, "utf8"));
		rec.expiresAt = new Date(Date.now() - 60_000).toISOString();
		await writeFile(file, JSON.stringify(rec));
		expect(await store.active(HASH_A)).toBeUndefined();
		expect(await store.list()).toEqual([]);
	});

	test("rejects hashes that could escape the store", async () => {
		const store = new ApprovalStore(tmp, repo);
		await expect(store.active("jcs-sha256:../x")).rejects.toThrow();
		await expect(store.approve(approveInput("jcs-sha256:../x"))).rejects.toThrow();
	});

	test("concurrent approves both land with a clean directory", async () => {
		const store = new ApprovalStore(tmp, repo);
		await Promise.all([store.approve(approveInput(HASH_A)), store.approve(approveInput(HASH_B))]);
		expect(await store.active(HASH_A)).toBeDefined();
		expect(await store.active(HASH_B)).toBeDefined();
		const lines = (await readFile(path.join(repoDir(), "log.jsonl"), "utf8")).split("\n").filter((l) => l !== "");
		expect(lines.length).toBe(2);
		for (const l of lines) expect(() => JSON.parse(l)).not.toThrow();
		const files = await readdir(repoDir(), { recursive: true });
		expect(files.filter((f) => f.endsWith(".tmp") || path.basename(f) === ".lock")).toEqual([]);
	});

	test("stale lock does not block", async () => {
		const store = new ApprovalStore(tmp, repo);
		await mkdir(repoDir(), { recursive: true });
		const lock = path.join(repoDir(), ".lock");
		await writeFile(lock, "999999 old\n");
		const old = new Date(Date.now() - 60_000);
		await utimes(lock, old, old);
		const started = Date.now();
		await store.approve(approveInput(HASH_A));
		expect(Date.now() - started).toBeLessThan(5_000);
		expect(await store.active(HASH_A)).toBeDefined();
	});

	test("torn log line is skipped and does not merge with the next entry", async () => {
		const store = new ApprovalStore(tmp, repo);
		await mkdir(repoDir(), { recursive: true });
		await writeFile(path.join(repoDir(), "log.jsonl"), '{"ts":"x","event":"appr');
		await store.approve(approveInput(HASH_A));
		expect((await store.log()).map((e) => e.event)).toEqual(["approved"]);
	});

	test("recordRollback appends rolled_back with prevHash", async () => {
		const store = new ApprovalStore(tmp, repo);
		const rec = await store.approve(approveInput(HASH_A));
		await store.recordRollback(HASH_A, HASH_B);
		const last = (await store.log()).at(-1);
		expect(last).toMatchObject({ event: "rolled_back", approvalId: rec.approvalId, configHash: HASH_A, prevHash: HASH_B });
	});

	test("evidence is written per hash before the approval and read back", async () => {
		const store = new ApprovalStore(tmp, repo);
		const evidence = (chosen: string): EvidenceRecord => ({
			schema: "storm.evidence/v1",
			createdAt: "2026-11-20T00:00:00.000Z",
			source: "setup",
			priority: "balanced",
			dataAsOf: null,
			roles: {
				reviewer: {
					chosen,
					candidates: [{ selector: chosen, label: "B", validated: true, int: null, speed: 40, referenceUsd: null, why: ["좋음"], whyNot: [] }],
				},
			},
		});
		await store.approve({ ...approveInput(HASH_A), evidence: evidence("a/b") });
		await store.approve({ ...approveInput(HASH_B), evidence: evidence("a/c") });
		expect(await store.evidence(HASH_A)).toEqual(evidence("a/b"));
		expect(await store.evidence(HASH_B)).toEqual(evidence("a/c"));
		expect((await readdir(path.join(repoDir(), "evidence"))).sort()).toEqual([`${"a".repeat(64)}.json`, `${"b".repeat(64)}.json`]);

		const HASH_C = `jcs-sha256:${"c".repeat(64)}`;
		await store.approve(approveInput(HASH_C));
		expect(await store.evidence(HASH_C)).toBeUndefined();
		await writeFile(path.join(repoDir(), "evidence", `${"c".repeat(64)}.json`), '{"schema":"other"}');
		expect(await store.evidence(HASH_C)).toBeUndefined();
		await expect(store.evidence("jcs-sha256:../x")).rejects.toThrow();
	});

	test("a failed evidence write leaves no approval", async () => {
		const store = new ApprovalStore(tmp, repo);
		// A file where the evidence directory should be makes the evidence write fail.
		await mkdir(repoDir(), { recursive: true });
		await writeFile(path.join(repoDir(), "evidence"), "");
		const evidence: EvidenceRecord = { schema: "storm.evidence/v1", createdAt: "x", source: "setup", priority: "balanced", dataAsOf: null, roles: {} };
		await expect(store.approve({ ...approveInput(HASH_A), evidence })).rejects.toThrow();
		expect(await store.active(HASH_A)).toBeUndefined();
		expect(await store.snapshot(HASH_A)).toEqual(config);
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
