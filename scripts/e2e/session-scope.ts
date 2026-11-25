#!/usr/bin/env bun
/**
 * Native-session ownership proof, real host: a disposable git checkout, an isolated HOME/profile, the pinned omp and
 * the local fake LLM. No paid model calls and nothing under the real user profile is read or written.
 *
 * What it proves, all through the public RPC host and the files Storm really writes:
 * - two native sessions started in the same checkout/profile have different ids and different Storm stores; each one's
 *   team, approvals, automatic-delegation choice and run history are its own, and read-only commands running at the
 *   same time never see the other's;
 * - resuming the exact native id returns that session's data, even when the host transcript is opened from a different
 *   session directory: the store is keyed by the id, never by cwd, worktree or session-file path;
 * - a new or forked native session starts clean: copied conversation, no team, no approvals, no run history;
 * - concurrent conflicting writes (a reset in one session, an approval in another) change only their own store;
 * - old `.omp/storm` files and old profile-level approvals are never read, imported, rewritten or deleted, including by
 *   reset; Storm writes no `.gitignore` and nothing below the target;
 * - `sessionStoreDir` rejects an empty/invalid identity and hashes any other opaque id inside the profile.
 *
 * Usage:
 *   ./node_modules/.bin/bun scripts/e2e/session-scope.ts
 * Env from harness.ts (E2E_WORK, E2E_PORT, E2E_KEEP) applies; a green run deletes its temp work dir.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { readAutoDelegationChoice } from "../../src/approval/auto.ts";
import { resolveRepo } from "../../src/approval/repo.ts";
import { configHash, shortHash } from "../../src/config/canonical.ts";
import { APPROVE, CANCEL } from "../../src/proposals/present.ts";
import { sessionStoreDir } from "../../src/session-scope.ts";
import type { Exec } from "../../src/types.ts";
import {
	AUTO_OFF_LABEL,
	AUTO_ON_LABEL,
	type Answer,
	approveTeam,
	cancelAll,
	choose,
	type Frame,
	linkPlugin,
	modelsYml,
	prepare,
	Rpc,
	StormFiles,
	Suite,
	startFakeLlm,
	TEAM_PROVIDERS,
	until,
} from "./harness.ts";

const env = prepare("storm-e2e-session-scope", 18787);
const suite = new Suite("E2E (session ownership)", env);
const check = suite.check.bind(suite);
const MAIN = "fake/general-b";
const exitCodes: number[] = [];

/** One native RPC session and the reader bound to its Storm store. */
interface Owned {
	rpc: Rpc;
	files: StormFiles;
}

async function open(answer: Answer = cancelAll, options: { resume?: string; sessionDir?: string } = {}): Promise<Owned> {
	const rpc = new Rpc(env, answer, { model: MAIN, ...options });
	await rpc.ready();
	return { rpc, files: new StormFiles(env, rpc.sessionId) };
}

async function close(owned: Owned): Promise<void> {
	exitCodes.push(await owned.rpc.close());
}

/** A native session's transcript must be on disk before another process can resume it. */
async function persistedFile(owned: Owned): Promise<string> {
	await owned.rpc.identify();
	const file = owned.rpc.sessionFile;
	if (file === undefined || !existsSync(file)) throw new Error(`the native session ${owned.rpc.sessionId} wrote no transcript`);
	return file;
}

/** Every file below `root` and its SHA-256, for byte-untouched checks. */
function treeHashes(root: string): Map<string, string> {
	const hashes = new Map<string, string>();
	if (!existsSync(root)) return hashes;
	for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
		if (!entry.isFile()) continue;
		const file = join(entry.parentPath, entry.name);
		hashes.set(file, new Bun.CryptoHasher("sha256").update(readFileSync(file)).digest("hex"));
	}
	return hashes;
}

const sameHashes = (before: Map<string, string>, after: Map<string, string>): boolean =>
	before.size === after.size && [...before].every(([file, hash]) => after.get(file) === hash);

/** A real git call for the repo identity the old layout used; keeps the fixture independent of Storm internals. */
const exec: Exec = async (command, args) => {
	const result = Bun.spawnSync([command, ...args]);
	return { stdout: result.stdout.toString(), stderr: result.stderr.toString(), code: result.exitCode ?? 1 };
};

async function main(): Promise<void> {
	writeFileSync(join(env.agentDir, "models.yml"), modelsYml(env.port, TEAM_PROVIDERS));
	writeFileSync(join(env.agentDir, "config.yml"), "setupVersion: 3\n");
	linkPlugin(env);

	/** The first session, its own team and the native transcript the resume step copies. */
	let a: { id: string; dir: string; sessionDir: string; file: string; config: string; hash: string } | undefined;
	let b: { id: string; dir: string; sessionDir: string } | undefined;
	/** Old-format files seeded once the fixture has a real approval to copy into them. */
	let legacy = new Map<string, string>();

	await suite.step("distinct native sessions in one checkout own separate stores", async () => {
		const first = await open();
		const second = await open();
		try {
			check("the host minted two different session ids", first.rpc.sessionId !== second.rpc.sessionId, `${first.rpc.sessionId} vs ${second.rpc.sessionId}`);
			check("the two stores are different directories", first.files.sessionDir !== second.files.sessionDir, `${first.files.sessionDir} vs ${second.files.sessionDir}`);
			check(
				"the store is below the profile's storm/sessions, not the target",
				first.files.sessionDir.startsWith(join(env.agentDir, "storm", "sessions")) && !first.files.sessionDir.startsWith(realpathSync(env.project)),
				first.files.sessionDir,
			);
			check("sessionStoreDir hashes an opaque id under the profile", sessionStoreDir(env.agentDir, first.rpc.sessionId) === first.files.sessionDir);
			check("a traversal-shaped id stays a hash below sessions", !sessionStoreDir(env.agentDir, "../../escape").includes("..") && sessionStoreDir(env.agentDir, "../../escape").startsWith(join(env.agentDir, "storm", "sessions")));
			check("an empty id is rejected", (() => { try { sessionStoreDir(env.agentDir, " "); return false; } catch { return true; } })());
			check("the second session starts with no config, approval or run", second.files.configBytes() === null && second.files.approvals().length === 0 && second.files.runs().length === 0);

			// The first session: its own team (a distinct round limit) and automatic delegation off.
			await approveTeam(first.rpc, "on");
			first.files.editConfig(config => {
				config.rounds = 7;
			});
			first.rpc.answer = choose(APPROVE);
			await first.rpc.prompt("/storm");
			first.rpc.answer = choose(AUTO_OFF_LABEL);
			await first.rpc.prompt("/storm auto");
			check("the first session's edited team is approved in its own store", first.files.approvals().length === 2 && first.files.config().rounds === 7, `approvals=${first.files.approvals().length}`);
			check("the first session's automatic delegation is off", (await readAutoDelegationChoice(first.files.sessionDir)) === "off");

			// A real run, so history is not just an empty state directory.
			const before = first.files.runIds();
			const request = `/storm E2E-ROUTE ${JSON.stringify({ action: "run" })} E2E-STEPS []`;
			await first.rpc.prompt(request);
			const run = await first.files.finishedRun(before);
			check("the first session owns the run record and its index line", first.files.runs().some(record => record.runId === run.runId) && first.files.index().some(line => line.runId === run.runId), run.runId);

			// The second session: recommended team, automatic delegation on. A real turn materializes its transcript so a
			// later `--resume` can open it.
			await approveTeam(second.rpc, "on");
			second.rpc.answer = choose(AUTO_OFF_LABEL);
			await second.rpc.prompt("/storm auto");
			await second.rpc.turn("hello");
			second.rpc.answer = choose(AUTO_ON_LABEL);
			await second.rpc.prompt("/storm auto");
			check("the second session approved its own team", second.files.approvals().length === 1, `approvals=${second.files.approvals().length}`);
			check("the second session's team differs from the first", second.files.config().rounds !== first.files.config().rounds, `${second.files.config().rounds} vs ${first.files.config().rounds}`);
			check("automatic delegation is per session", (await readAutoDelegationChoice(second.files.sessionDir)) === "on" && (await readAutoDelegationChoice(first.files.sessionDir)) === "off");
			check("the second session has no run history", second.files.runs().length === 0 && second.files.index().length === 0);

			// Two read-only commands at once, each reporting only its own team.
			const [firstStatus, secondStatus] = await Promise.all([first.rpc.prompt("/storm status"), second.rpc.prompt("/storm status")]);
			const said = (frames: Frame[]): string => frames.filter(frame => frame.type === "message_end").map(frame => JSON.stringify(frame)).join("\n");
			const firstTeam = shortHash(configHash(first.files.config()));
			const secondTeam = shortHash(configHash(second.files.config()));
			check(
				"concurrent status reads see separate approvals",
				said(firstStatus).includes(firstTeam) && said(secondStatus).includes(secondTeam) && !said(firstStatus).includes(secondTeam) && !said(secondStatus).includes(firstTeam),
				`first=${said(firstStatus).includes(firstTeam)} second=${said(secondStatus).includes(secondTeam)}`,
			);

			const file = await persistedFile(first);
			a = { id: first.rpc.sessionId, dir: first.rpc.sessionDir, sessionDir: first.files.sessionDir, file, config: readFileSync(first.files.configFile, "utf8"), hash: firstTeam };
			b = { id: second.rpc.sessionId, dir: second.rpc.sessionDir, sessionDir: second.files.sessionDir };

			// Old-format sentinels: the same config and approval copied into `.omp/storm` and the pre-session profile
			// approvals, plus an old .gitignore. No current or future session may read, rewrite or delete them.
			const repo = await resolveRepo(env.project, exec);
			const oldProject = join(env.project, ".omp", "storm");
			const oldProfile = join(env.agentDir, "storm", "approvals", repo.repoId);
			mkdirSync(join(oldProject, "state", "runs"), { recursive: true });
			mkdirSync(join(oldProfile, "approved"), { recursive: true });
			mkdirSync(join(oldProfile, "snapshots"), { recursive: true });
			writeFileSync(join(oldProject, "config.json"), a.config);
			writeFileSync(join(oldProject, ".gitignore"), "old storm ignore, never rewritten\n");
			writeFileSync(join(oldProject, "state", "runs", "run-20000101-000000-0ld0.json"), '{"schema":"storm.run/v1"}\n');
			const store = first.files.storeDir();
			if (store === undefined) throw new Error("the fixture approved no team");
			const [approval] = readdirSync(join(store, "approved"));
			if (approval === undefined) throw new Error("the fixture wrote no approval record");
			copyFileSync(join(store, "approved", approval), join(oldProfile, "approved", approval));
			const [snapshot] = readdirSync(join(store, "snapshots"));
			if (snapshot !== undefined) copyFileSync(join(store, "snapshots", snapshot), join(oldProfile, "snapshots", snapshot));
			writeFileSync(join(oldProfile, "runs.jsonl"), '{"runId":"run-20000101-000000-0ld0","artifactsDir":"/old","agents":[]}\n');
			legacy = new Map([...treeHashes(oldProject), ...treeHashes(join(env.agentDir, "storm", "approvals", repo.repoId))]);
			check("the old sentinels were seeded", legacy.size >= 5, `files=${legacy.size}`);
		} finally {
			await close(first);
			await close(second);
		}
	});

	await suite.step("old project and profile data is ignored, not imported or deleted", async () => {
		const c = await open();
		try {
			check("the old files are still byte-identical before a new session", sameHashes(legacy, new Map([...treeHashes(join(env.project, ".omp", "storm")), ...treeHashes(join(env.agentDir, "storm", "approvals", (await resolveRepo(env.project, exec)).repoId))])), `files=${legacy.size}`);
			check("a new session reads no old team", c.files.configBytes() === null && c.files.approvals().length === 0);
			const status = await c.rpc.prompt("/storm status");
			const text = status.filter(frame => frame.type === "message_end").map(frame => JSON.stringify(frame)).join("\n");
			check("the status report names no approved old team", !text.includes("승인됨") || text.includes("없"), text.slice(0, 300));
			const frames = await c.rpc.turn("E2E-TASK storm-implementer");
			check("old profile approvals grant no spawn", frames.map(frame => JSON.stringify(frame)).join("\n").includes("[storm:no-config]"));
			c.rpc.answer = choose(CANCEL);
			await c.rpc.prompt("/storm");
			check("the setup dialog is still offered (nothing imported)", c.rpc.dialogs.at(-1)?.options[0] === APPROVE, JSON.stringify(c.rpc.dialogs.at(-1)?.options));
			check("old bytes stay identical after reading a new session", sameHashes(legacy, new Map([...treeHashes(join(env.project, ".omp", "storm")), ...treeHashes(join(env.agentDir, "storm", "approvals", (await resolveRepo(env.project, exec)).repoId))])), `files=${legacy.size}`);
			check("Storm wrote no .gitignore in the target", !existsSync(join(env.project, ".gitignore")));
		} finally {
			await close(c);
		}
	});

	await suite.step("resuming the exact id returns its data from any session directory", async () => {
		if (a === undefined || b === undefined) throw new Error("the fixture sessions are missing");
		const copyDir = join(env.sessionRoot, "resume-a-elsewhere");
		mkdirSync(copyDir, { recursive: true });
		copyFileSync(a.file, join(copyDir, basename(a.file)));
		const resumed = await open(cancelAll, { resume: a.id, sessionDir: copyDir });
		try {
			check("the resumed process reports the same native id", resumed.rpc.sessionId === a.id, `${resumed.rpc.sessionId} vs ${a.id}`);
			check("the id, not the transcript path, picks the store", resumed.files.sessionDir === a.sessionDir, resumed.files.sessionDir);
			check("the team is the session's own", readFileSync(resumed.files.configFile, "utf8") === a.config && resumed.files.config().rounds === 7);
			check("approvals and automatic delegation survived", resumed.files.approvals().length === 2 && (await readAutoDelegationChoice(resumed.files.sessionDir)) === "off");
			check("run history survived", resumed.files.runs().length === 1 && resumed.files.index().length === 1, `runs=${resumed.files.runs().length}`);
			const status = await resumed.rpc.prompt("/storm status");
			check("the resumed session reports its approved team", status.filter(frame => frame.type === "message_end").map(frame => JSON.stringify(frame)).join("\n").includes(a.hash));
			check("the other session's store is not reachable through this id", resumed.files.sessionDir !== b.sessionDir);
		} finally {
			await close(resumed);
		}
	});

	await suite.step("a new or forked native session starts without Storm data", async () => {
		if (a === undefined) throw new Error("the fixture session is missing");
		const c = await open();
		try {
			await c.rpc.turn("hello");
			const beforeConfig = c.files.configBytes();
			check("the fresh session has no team before the fork", beforeConfig === null && c.files.approvals().length === 0);
			const treeId = c.rpc.send({ type: "get_tree" });
			const tree = await until(() => c.rpc.frames.find(frame => frame.id === treeId && frame.command === "get_tree"), 20_000, "the session tree");
			const leafId = tree.data?.leafId;
			if (typeof leafId !== "string") throw new Error("the session tree gave no leaf to fork");
			const forkId = c.rpc.send({ type: "fork", entryId: leafId });
			await until(() => c.rpc.frames.find(frame => frame.id === forkId), 30_000, "the fork");
			const forked = await c.rpc.identify();
			const forkedFiles = new StormFiles(env, forked.sessionId);
			check("the fork has its own native id", forked.sessionId !== a.id && forked.sessionId !== c.files.sessionId, forked.sessionId);
			check("the fork copied the conversation", (forked.messageCount ?? 0) > 0, `messages=${forked.messageCount}`);
			check("the fork inherits no team, approval or history", forkedFiles.configBytes() === null && forkedFiles.approvals().length === 0 && forkedFiles.runs().length === 0);
			check("the original session's store is unchanged by the fork", readFileSync(join(a.sessionDir, "config.json"), "utf8") === a.config);
			c.rpc.answer = choose(APPROVE);
			await c.rpc.prompt("/storm");
			check("the fork can approve its own team", forkedFiles.approvals().length === 1 && existsSync(forkedFiles.configFile));
		} finally {
			await close(c);
		}
	});

	await suite.step("concurrent conflicting writes stay inside their session", async () => {
		if (a === undefined || b === undefined) throw new Error("the fixture sessions are missing");
		const first = await open(cancelAll, { resume: a.id, sessionDir: a.dir });
		const second = await open(cancelAll, { resume: b.id, sessionDir: b.dir });
		try {
			check("both resumed sessions read their own approved team", first.files.approvals().length === 2 && second.files.approvals().length === 1);
			first.rpc.answer = choose("초기화");
			second.files.editConfig(config => {
				config.rounds = 9;
			});
			second.rpc.answer = choose(APPROVE);
			await Promise.all([first.rpc.prompt("/storm reset"), second.rpc.prompt("/storm")]);
			check("the reset deleted only its own session store", !existsSync(first.files.sessionDir) && first.files.approvals().length === 0 && first.files.configBytes() === null);
			check("the approving session kept its new approved team", second.files.config().rounds === 9 && second.files.approvals().length === 2, `approvals=${second.files.approvals().length}`);
			check(
				"neither concurrent write touched the old sentinels",
				sameHashes(legacy, new Map([...treeHashes(join(env.project, ".omp", "storm")), ...treeHashes(join(env.agentDir, "storm", "approvals", (await resolveRepo(env.project, exec)).repoId))])),
				`files=${legacy.size}`,
			);
			check("the other session's run history stayed its own", second.files.runs().length === 0);
		} finally {
			await close(first);
			await close(second);
		}
	});

	await suite.step("no normal flow writes below the target or creates a .gitignore", async () => {
		const target = treeHashes(join(env.project, ".omp"));
		const seeded = new Map([...legacy].filter(([file]) => file.startsWith(join(env.project, ".omp"))));
		const status = Bun.spawnSync(["git", "-C", env.project, "status", "--porcelain", "--untracked-files=all"]);
		check("git still answers in the target", status.exitCode === 0);
		check("no .gitignore was created in the target", !existsSync(join(env.project, ".gitignore")));
		check("only the seeded old files exist below .omp/storm and they are unchanged", sameHashes(seeded, target), `files=${[...target.keys()].join(",")}`);
		check("every omp session exited 0", exitCodes.length > 0 && exitCodes.every(code => code === 0), `exit=${exitCodes.join(",")}`);
	});
}

const server = await startFakeLlm(env);
let code = 1;
try {
	await main();
} finally {
	server.kill();
	code = suite.finish();
}
process.exit(code);
