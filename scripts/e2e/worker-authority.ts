#!/usr/bin/env bun
/**
 * Real-host proof that a persisted lane admission enforces path scope on the workers Storm lets run.
 *
 * Run twice with PROBE_MODE=authorized and PROBE_MODE=unauthorized on disposable dirs/ports. A Storm worker on a pooled
 * thread stops before its first request (0.28.0, decisions D5/D7), so this suite takes the documented way out —
 * `task.workerThreads: 0` — and all nine path-only children run on the director's thread. The pooled stop itself is
 * proved by `hardening-pins`; here the script checks the resulting files and the child transcripts and that no child was
 * placed on a pooled thread.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { APPROVE } from "../../src/proposals/present.ts";
import { cancelAll, choose, modelsYml, prepare, ROOT, Rpc, StormFiles, Suite, startFakeLlm, TEAM_PROVIDERS, until } from "./harness.ts";

const MODE = process.env.PROBE_MODE === "unauthorized" ? "unauthorized" : "authorized";
const COUNT = Number(process.env.PROBE_COUNT ?? "9");
const env = prepare(`storm-worker-authority-${MODE}`, Number(process.env.E2E_PORT ?? (MODE === "authorized" ? "18920" : "18921")));
const suite = new Suite(`E2E (worker authority, ${MODE})`, env);
const check = suite.check.bind(suite);
const MAIN = "fake/general-b";

const lanes = Array.from({ length: COUNT }, (_, i) => ({
	name: `L${i}`,
	kind: "code",
	role: "implementer",
	files: [`declared-${i}.txt`],
	results: [{ id: `L${i}-result`, kind: "change", criterion: `declared-${i}.txt carries the child write`, path: `declared-${i}.txt` }],
}));
const tasks = Array.from({ length: COUNT }, (_, i) => ({
	name: `L${i}`,
	agent: "storm-implementer",
	task: `Write ${MODE === "authorized" ? `declared-${i}.txt` : `outside-${i}.txt`}`,
	say: `E2E-CHILD-DELAY 5000 E2E-CHILD-WRITE ${MODE === "authorized" ? `declared-${i}.txt` : `outside-${i}.txt`}`,
}));
const request = `/storm E2E-ROUTE ${JSON.stringify({ action: "run" })} E2E-STEPS ${JSON.stringify([
	{ storm: { action: "plan", plan: { lanes, workers: { implementer: COUNT } } } },
	{ tasks },
])}`;

function logRecords(): Array<Record<string, unknown>> {
	const dir = join(dirname(env.agentDir), "logs");
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter(file => file.startsWith("omp.") && file.endsWith(".log"))
		.flatMap(file =>
			readFileSync(join(dir, file), "utf8")
				.split("\n")
				.filter(Boolean)
				.flatMap(line => {
					try {
						const value: unknown = JSON.parse(line);
						return value !== null && typeof value === "object" ? [value as Record<string, unknown>] : [];
					} catch {
						return [];
					}
				}),
		);
}

/** The host's own worker tag for a child, if this child ran on a pooled thread. */
function workerSession(agentId: string): { thread: string; evidence: string } | undefined {
	const records = logRecords();
	const launched = records.find(record => typeof record.thread === "string" && /^w\d+$/.test(record.thread) && record.id === agentId);
	if (launched !== undefined) return { thread: String(launched.thread), evidence: "subagent launch timing" };
	const sessionId = records.find(record => typeof record.sessionFile === "string" && basename(record.sessionFile) === `${agentId}.jsonl`)?.sessionId;
	for (const record of records) {
		if (typeof record.thread !== "string" || !/^w\d+$/.test(record.thread)) continue;
		if (sessionId !== undefined && record.sessionId === sessionId) return { thread: record.thread, evidence: "session id" };
		if (typeof record.sessionFile === "string" && basename(record.sessionFile) === `${agentId}.jsonl`) return { thread: record.thread, evidence: "session file" };
	}
	return undefined;
}

/** The child transcript the host wrote, by its child id. */
function childTranscript(agentId: string): string | undefined {
	const stack = [env.sessionRoot];
	while (stack.length > 0) {
		const dir = stack.pop() as string;
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const file = join(dir, entry.name);
			if (entry.isDirectory()) stack.push(file);
			else if (entry.name === `${agentId}.jsonl`) return readFileSync(file, "utf8");
		}
	}
	return undefined;
}

async function main(): Promise<void> {
	writeFileSync(join(env.agentDir, "models.yml"), modelsYml(env.port, TEAM_PROVIDERS));
	writeFileSync(join(env.agentDir, "config.yml"), `setupVersion: 3\ntask:\n  workerThreads: 0\n  maxConcurrency: ${COUNT}\n`);
	const shadowDir = join(env.project, ".omp", "agents");
	Bun.spawnSync(["mkdir", "-p", shadowDir]);
	writeFileSync(join(shadowDir, "storm-implementer.md"), "---\nname: storm-implementer\ndescription: path-only worker authority\ntools: read, write, edit\n---\nPath-only worker.\n");
	const link = Bun.spawnSync([env.omp, "--profile", env.profile, "plugin", "link", ROOT], { cwd: env.project, env: env.childEnv });
	if (link.exitCode !== 0) throw new Error(`plugin link failed: ${link.stdout}${link.stderr}`);

	await suite.step(`nine concurrent path-only children: ${MODE} writes`, async () => {
		const rpc = new Rpc(env, cancelAll, { model: MAIN });
		await rpc.ready();
		const files = new StormFiles(env, rpc.sessionId);
		rpc.answer = choose(APPROVE);
		await rpc.prompt("/storm");
		files.editConfig(config => {
			(config.roles.implementer as unknown as Record<string, unknown>).workers = { min: COUNT, max: COUNT };
		});
		rpc.answer = choose(APPROVE);
		await rpc.prompt("/storm");
		check("the nine-wide path-only team is approved", files.approvals().length >= 1, `approvals=${files.approvals().length}`);
		rpc.answer = choose("자동 위임 끄기");
		await rpc.prompt("/storm auto");
		await rpc.turn("hello");
		await rpc.prompt(request);
		const running = files.runs().find(run => run.status === "running");
		check("the run opened", running !== undefined);
		if (running === undefined) return;
		await until(() => {
			const run = files.run(running.runId);
			return run !== undefined && run.spawns.filter(spawn => spawn.outcome === "routed").length >= COUNT ? run : undefined;
		}, 60_000, "nine routed children");
		// The children hold their first reply five seconds; wait for the writes and for the host to flush the transcripts.
		const expected = Array.from({ length: COUNT }, (_, i) => `${MODE === "authorized" ? "declared" : "outside"}-${i}.txt`);
		await until(() => {
			const present = expected.filter(name => existsSync(join(env.project, name)));
			return MODE === "authorized" ? (present.length === COUNT ? present : undefined) : (present.length > 0 ? present : undefined);
		}, 30_000, MODE === "authorized" ? "all authorized writes" : "an unauthorized write").catch(() => undefined);
		const present = expected.filter(name => existsSync(join(env.project, name)));
		if (MODE === "authorized") {
			check("all nine authorized path writes landed in the shared tree", present.length === COUNT, `present=${present.join(",") || "none"}`);
		} else {
			check("no path-only child wrote outside its lane", present.length === 0, `outside=${present.join(",") || "none"}`);
		}
		// A child's transcript is flushed when the host records its session exit, slightly after the file lands.
		await until(() => {
			const text = childTranscript(`L${COUNT - 1}`);
			return text !== undefined && (MODE === "authorized" ? text.includes("storm child change") : text.includes("lane-scope")) ? text : undefined;
		}, 20_000, "the last child's transcript").catch(() => undefined);
		const pooledChildren = Array.from({ length: COUNT }, (_, i) => ({ id: `L${i}`, worker: workerSession(`L${i}`) })).filter(item => item.worker !== undefined);
		check("no child was placed on a pooled worker thread", pooledChildren.length === 0, JSON.stringify(pooledChildren));
		// The first and the last child: both sides of the host's eight-main-thread threshold, now all on the director's thread.
		for (const id of ["L0", `L${COUNT - 1}`]) {
			const text = childTranscript(id) ?? "";
			if (MODE === "authorized") {
				check(`${id}: its authorized write is in the transcript as a success`, text.includes("storm child change") && !text.includes("lane-scope"), text.slice(-800));
				check(`${id}: its authorized file exists`, existsSync(join(env.project, `declared-${id.slice(1)}.txt`)), "");
			} else {
				check(`${id}: its unauthorized write is blocked with lane-scope`, text.includes("lane-scope"), text.slice(-800));
				check(`${id}: no unauthorized file exists`, !existsSync(join(env.project, `outside-${id.slice(1)}.txt`)), "");
			}
		}
		await rpc.close();
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
