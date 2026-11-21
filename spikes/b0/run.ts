#!/usr/bin/env bun
/**
 * B0 spike: does omp tolerate deleting a finished subagent's records (`<id>.jsonl`, `<id>.md`, `<id>/`)
 * while the parent session lives on, after it parks the child, and across a resume? No plugins loaded.
 *
 * Usage: PATH=$PWD/node_modules/.bin:$PATH bun spikes/b0/run.ts
 * (pinned omp, or OMP_BIN; port 18557 free; profile storm-b0 is wiped and recreated)
 */
import { Database } from "bun:sqlite";
import type { Subprocess } from "bun";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type Frame = { type?: string; [key: string]: unknown };

const OMP = process.env.OMP_BIN ?? join(import.meta.dir, "..", "..", "node_modules", ".bin", "omp");
const PROFILE = "storm-b0";
const PORT = 18557;
const WORK = "/tmp/storm-b0";
const PROJECT = join(WORK, "project");
const PROFILE_ROOT = join(homedir(), ".omp", "profiles", PROFILE);
const STATS_DB = join(PROFILE_ROOT, "stats.db");
const PARK_OVERLAY = join(WORK, "park.yml");
const PARK_TTL_MS = 2_000;
const CHILD_MARK = "b0 child";
const MODEL = "fake/main";
const baseArgs = ["--profile", PROFILE, "--no-title", "--auto-approve", "--model", MODEL, "--smol", MODEL, "--slow", MODEL, "--plan", MODEL];

const short = (text: string, max = 400) => (text.length > max ? `${text.slice(0, max)}…` : text);

async function until<T>(probe: () => T | undefined | Promise<T | undefined>, timeoutMs: number, label: string): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await probe();
		if (value !== undefined) return value;
		if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
		await Bun.sleep(150);
	}
}

function ompCli(args: string[]): { code: number; out: string } {
	const proc = Bun.spawnSync([OMP, "--profile", PROFILE, ...args], { cwd: PROJECT, stdout: "pipe", stderr: "pipe" });
	return { code: proc.exitCode ?? -1, out: `${proc.stdout.toString()}${proc.stderr.toString()}` };
}

class Rpc {
	readonly frames: Frame[] = [];
	readonly stderr: string[] = [];
	readonly proc: Subprocess<"pipe", "pipe", "pipe">;
	#seq = 0;

	constructor(args: string[]) {
		const proc = Bun.spawn([OMP, "--mode", "rpc", ...baseArgs, ...args], { cwd: PROJECT, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
		this.proc = proc;
		void this.#pump();
		void (async () => {
			const decoder = new TextDecoder();
			for await (const chunk of proc.stderr) this.stderr.push(decoder.decode(chunk));
		})();
	}

	async #pump(): Promise<void> {
		const decoder = new TextDecoder();
		let buffer = "";
		for await (const chunk of this.proc.stdout) {
			buffer += decoder.decode(chunk, { stream: true });
			for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
				const line = buffer.slice(0, newline).trim();
				buffer = buffer.slice(newline + 1);
				if (!line.startsWith("{")) continue;
				try {
					const frame = JSON.parse(line) as Frame;
					this.frames.push(frame);
					if (frame.type === "extension_ui_request") this.send({ type: "extension_ui_response", id: frame.id, cancelled: true });
				} catch {}
			}
		}
	}

	send(command: Frame): string {
		const id = typeof command.id === "string" ? command.id : `c${++this.#seq}`;
		this.proc.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
		this.proc.stdin.flush();
		return id;
	}

	find(match: (frame: Frame) => boolean, from = 0): Frame | undefined {
		return this.frames.slice(from).find(match);
	}

	async request(command: Frame): Promise<Frame> {
		const at = this.frames.length;
		const id = this.send(command);
		return until(() => this.find(f => f.type === "response" && f.id === id, at), 20_000, `${command.type} response`);
	}

	/** Waits until the session reports settled and no frame has arrived for `quietMs`. */
	async quiet(from: number, label: string, quietMs = 2_000): Promise<void> {
		const deadline = Date.now() + 120_000;
		let seen = this.frames.length;
		let since = Date.now();
		for (;;) {
			await Bun.sleep(200);
			if (this.frames.length !== seen) {
				seen = this.frames.length;
				since = Date.now();
				continue;
			}
			const settled = this.find(f => f.type === "session_settled" || (f.type === "prompt_result" && f.sessionSettled === true), from);
			if (settled && Date.now() - since >= quietMs) return;
			if (Date.now() > deadline) throw new Error(`timeout waiting for quiet: ${label}`);
		}
	}

	errors(from = 0): string[] {
		return [
			...this.frames.slice(from).filter(f => f.type === "error" || (f.type === "response" && f.success === false)).map(f => short(JSON.stringify(f), 300)),
			...this.stderr.join("").split("\n").filter(line => /error|exception|ENOENT|unhandled/i.test(line)).map(line => short(line, 300)),
		];
	}

	async close(): Promise<number> {
		this.proc.stdin.end();
		const exited = await Promise.race([this.proc.exited.then(() => true), Bun.sleep(8_000).then(() => false)]);
		if (!exited) this.proc.kill();
		return this.proc.exited;
	}
}

async function open(args: string[] = []): Promise<Rpc> {
	const rpc = new Rpc(args);
	await until(() => rpc.find(f => f.type === "ready"), 30_000, `rpc ready | stderr: ${rpc.stderr.join("").slice(-600)}`);
	return rpc;
}

interface ToolOutcome {
	tool: string;
	isError: boolean;
	text: string;
}

/** Makes the main agent run one tool call; returns its result once the session is quiet again. */
async function act(rpc: Rpc, tool: string, args: Record<string, unknown>): Promise<ToolOutcome> {
	const from = rpc.frames.length;
	rpc.send({ type: "prompt", message: `B0-DO ${JSON.stringify({ tool, args })}` });
	const end = await until(() => rpc.find(f => f.type === "tool_execution_end" && f.toolName === tool, from), 60_000, `${tool} result`);
	await rpc.quiet(from, tool);
	const result = end.result as { content?: Array<{ text?: string }> } | undefined;
	return { tool, isError: end.isError === true, text: short((result?.content ?? []).map(part => part.text ?? "").join("\n"), 600) };
}

const read = (rpc: Rpc, path: string) => act(rpc, "read", { path });

async function prompt(rpc: Rpc, message: string): Promise<{ reply: string; errors: string[] }> {
	const from = rpc.frames.length;
	rpc.send({ type: "prompt", message });
	await rpc.quiet(from, message);
	const reply = rpc.frames
		.slice(from)
		.filter(f => f.type === "message_end" && (f.message as { role?: string } | undefined)?.role === "assistant")
		.map(f => JSON.stringify((f.message as { content?: unknown }).content))
		.join(" ");
	return { reply: short(reply, 200), errors: rpc.errors(from) };
}

async function sessionFile(rpc: Rpc): Promise<string> {
	const state = await rpc.request({ type: "get_state" });
	return (state.data as { sessionFile: string }).sessionFile;
}

const artifactsOf = (session: string) => session.replace(/\.jsonl$/, "");

/** Files named after the agent id inside the session's artifacts dir (transcript, output, nested dir, sidecars). */
function recordsOf(artifacts: string, id: string): string[] {
	if (!existsSync(artifacts)) return [];
	return readdirSync(artifacts)
		.filter(name => name === id || name.startsWith(`${id}.`))
		.map(name => (statSync(join(artifacts, name)).isDirectory() ? `${name}/ [${readdirSync(join(artifacts, name)).join(",")}]` : name))
		.sort();
}

/** Spawns one child through `task` and waits for a fresh output file (the child has yielded). */
async function spawnChild(rpc: Rpc, name: string): Promise<{ id: string; artifacts: string; taskResult: ToolOutcome }> {
	const started = Date.now();
	const taskResult = await act(rpc, "task", {
		context: "B0 spike",
		tasks: [{ name, agent: "task", task: `Reply with OK (${CHILD_MARK}).`, solutionSpace: "spike: fixed reply" }],
	});
	const id = taskResult.text.match(/Spawned agent `([^`]+)`/)?.[1];
	if (!id) throw new Error(`no spawned id in task result: ${taskResult.text}`);
	const artifacts = artifactsOf(await sessionFile(rpc));
	const output = join(artifacts, `${id}.md`);
	await until(() => (existsSync(output) && statSync(output).mtimeMs >= started - 1_000) || undefined, 60_000, `${id} output`);
	await rpc.quiet(0, `${id} finish`);
	return { id, artifacts, taskResult };
}

/** The janitor's full file set for agent id X under the artifacts dir; `partial` keeps `X.md`. */
const RECORD_SUFFIXES = [".jsonl", ".md", ".json", ".jsonl.tombstone", ""];

function remove(artifacts: string, id: string, partial = false): { removed: string[]; errors: string[] } {
	const removed: string[] = [];
	const errors: string[] = [];
	for (const name of RECORD_SUFFIXES.filter(suffix => !(partial && suffix === ".md")).map(suffix => `${id}${suffix}`)) {
		const path = join(artifacts, name);
		if (!existsSync(path)) continue;
		try {
			rmSync(path, { recursive: true });
			removed.push(name);
		} catch (error) {
			errors.push(`${name}: ${String(error)}`);
		}
	}
	return { removed, errors };
}

/** Open handles and lock-like files the omp process tree holds under the artifacts dir. */
function locks(rpc: Rpc, artifacts: string): { lsof: string[]; lockFiles: string[] } {
	const pids = [String(rpc.proc.pid), ...Bun.spawnSync(["pgrep", "-P", String(rpc.proc.pid)]).stdout.toString().split("\n").filter(Boolean)];
	const lsof = Bun.spawnSync(["lsof", "-n", "-p", pids.join(",")])
		.stdout.toString()
		.split("\n")
		.filter(line => line.includes(artifacts) || /\.lock|lease/i.test(line))
		.map(line => short(line.replace(/\s+/g, " "), 220));
	const lockFiles = Bun.spawnSync(["find", artifacts, join(artifacts, ".."), "-maxdepth", "2", "(", "-name", "*.lock", "-o", "-name", "*lease*", "-o", "-name", "*.tombstone", ")"])
		.stdout.toString()
		.split("\n")
		.filter(Boolean);
	return { lsof, lockFiles };
}

/** Read-only row counts per table for one session_file (or `%` LIKE pattern). */
function statsRows(sessionFileOrPattern: string): Record<string, number> | string {
	if (!existsSync(STATS_DB)) return `no stats.db at ${STATS_DB}`;
	const db = new Database(STATS_DB, { readonly: true });
	try {
		const counts: Record<string, number> = {};
		const tables = db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
		for (const { name } of tables) {
			const columns = db.query(`PRAGMA table_info(${name})`).all() as Array<{ name: string }>;
			if (!columns.some(column => column.name === "session_file")) continue;
			const row = db.query(`SELECT COUNT(*) AS n FROM ${name} WHERE session_file LIKE ?`).get(sessionFileOrPattern) as { n: number };
			if (row.n > 0) counts[name] = row.n;
		}
		return counts;
	} finally {
		db.close();
	}
}

/** Status column of the history:// index row for `id`, or "absent". */
const indexRow = (index: string, id: string) => index.split("\n").find(line => line.includes(`| ${id} |`)) ?? "absent";

/** Probe on one finished child: agent:// before and after a follow-up, history://<id>, history://, then a plain prompt. */
async function probe(rpc: Rpc, id: string) {
	const agentRead = await read(rpc, `agent://${id}`);
	const followUp = await act(rpc, "write", { path: `agent://${id}`, content: "follow-up from parent" });
	await Bun.sleep(1_500);
	await rpc.quiet(0, "follow-up settle");
	const agentReadAfterFollowUp = await read(rpc, `agent://${id}`);
	const history = await read(rpc, `history://${id}`);
	const index = await read(rpc, "history://");
	const next = await prompt(rpc, "plain prompt after probe");
	return {
		agentRead,
		followUp,
		agentReadAfterFollowUp,
		history,
		indexRow: indexRow(index.text, id),
		indexError: index.isError ? index.text : undefined,
		nextPrompt: next,
	};
}

function print(scenario: string, data: unknown): void {
	console.log(`\n=== ${scenario} ===\n${JSON.stringify(data, null, 2)}`);
}

// ── setup ────────────────────────────────────────────────────────────────────────────────

rmSync(PROFILE_ROOT, { recursive: true, force: true });
rmSync(WORK, { recursive: true, force: true });
mkdirSync(join(PROFILE_ROOT, "agent"), { recursive: true });
mkdirSync(PROJECT, { recursive: true });
writeFileSync(
	join(PROFILE_ROOT, "agent", "models.yml"),
	`providers:\n  fake:\n    baseUrl: http://127.0.0.1:${PORT}/v1\n    apiKey: b0-dummy\n    api: openai-completions\n    models:\n      - id: main\n        contextWindow: 128000\n        maxTokens: 4096\n        cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }\n`,
);
// Background task spawns (the interactive default) and no TTL parking unless the park overlay is loaded.
writeFileSync(join(PROFILE_ROOT, "agent", "config.yml"), "setupVersion: 3\nasync:\n  enabled: true\ntask:\n  agentIdleTtlMs: 0\n");
writeFileSync(PARK_OVERLAY, `task:\n  agentIdleTtlMs: ${PARK_TTL_MS}\n`);
writeFileSync(join(PROJECT, "README.md"), "b0\n");
Bun.spawnSync(["git", "init", "-q"], { cwd: PROJECT });
Bun.spawnSync(["git", "-c", "user.email=b0@x", "-c", "user.name=b0", "commit", "-qam", "init", "--allow-empty"], { cwd: PROJECT });
Bun.spawnSync(["git", "add", "."], { cwd: PROJECT });

const llm = Bun.spawn([process.execPath, join(import.meta.dir, "fake-llm.ts")], {
	env: { ...process.env, FAKE_LLM_PORT: String(PORT), FAKE_LLM_LOG: join(WORK, "llm.jsonl") },
	stdout: "pipe",
	stderr: "inherit",
});
await until(async () => (await fetch(`http://127.0.0.1:${PORT}/v1/models`).catch(() => undefined))?.ok || undefined, 10_000, "fake llm");

try {
	// ── 0 + 1 + 4 + 5: one live parent session, TTL parking off ─────────────────────────────
	const a = await open();
	const sessionA = await sessionFile(a);
	print("setup", { profileRoot: PROFILE_ROOT, sessionA, statsDb: STATS_DB });

	const keep = await spawnChild(a, "B0Keep");
	print("0-control spawn", { id: keep.id, task: keep.taskResult, records: recordsOf(keep.artifacts, keep.id) });
	print("0-control probe", { ...(await probe(a, keep.id)), recordsAfter: recordsOf(keep.artifacts, keep.id) });

	const live = await spawnChild(a, "B0Live");
	const liveFile = join(live.artifacts, `${live.id}.jsonl`);
	const before = { records: recordsOf(live.artifacts, live.id), subagents: (await a.request({ type: "get_subagents" })).data };
	print("5-locks (idle live child, before delete)", locks(a, live.artifacts));
	const sync1 = ompCli(["stats", "--summary"]);
	const statsBefore = statsRows(liveFile);
	const deletion = remove(live.artifacts, live.id);
	const statsAfterDelete = statsRows(liveFile);
	print("1-idle delete", { id: live.id, before, deletion, recordsRightAfter: recordsOf(live.artifacts, live.id) });
	print("1-idle probe", { ...(await probe(a, live.id)), recordsAfterProbe: recordsOf(live.artifacts, live.id) });
	print("5-locks (after deleting live child + follow-up)", locks(a, live.artifacts));

	const partLive = await spawnChild(a, "B0PartLive");
	print("6-partial idle delete", {
		id: partLive.id,
		before: recordsOf(partLive.artifacts, partLive.id),
		deletion: remove(partLive.artifacts, partLive.id, true),
		after: recordsOf(partLive.artifacts, partLive.id),
	});
	print("6-partial idle probe", { ...(await probe(a, partLive.id)), recordsAfterProbe: recordsOf(partLive.artifacts, partLive.id) });
	const reuseA = await spawnChild(a, "B0Live");
	print("7-id reuse in same live session (full delete)", { requested: "B0Live", got: reuseA.id });
	const sync2 = ompCli(["stats", "--summary"]);
	print("4-stats", {
		statsDb: STATS_DB,
		childSessionFile: liveFile,
		syncBefore: { code: sync1.code, tail: short(sync1.out.slice(-300)) },
		rowsBeforeDelete: statsBefore,
		rowsAfterDelete: statsAfterDelete,
		syncAfter: { code: sync2.code, tail: short(sync2.out.slice(-300)) },
		rowsAfterSync: statsRows(liveFile),
		parentRows: statsRows(sessionA),
	});
	const aErrors = a.errors();
	const aExit = await a.close();
	print("A exit", { exitCode: aExit, errors: aErrors, stderrTail: short(a.stderr.join("").slice(-500)) });

	// ── 2: parked child (TTL parking on) ──────────────────────────────────────────────────
	const b = await open(["--config", PARK_OVERLAY]);
	const sessionB = await sessionFile(b);
	const keepB = await spawnChild(b, "B0ParkKeep");
	const parked = await spawnChild(b, "B0Parked");
	const partParked = await spawnChild(b, "B0PartParked");
	const waitParked = (id: string) =>
		until(
			async () => {
				const row = indexRow((await read(b, "history://")).text, id);
				return /parked/i.test(row) ? row : undefined;
			},
			30_000,
			`${id} parked`,
		).catch(error => `not observed: ${String(error)}`);
	print("2-parked before delete", {
		id: parked.id,
		indexRow: await waitParked(parked.id),
		records: recordsOf(parked.artifacts, parked.id),
		locks: locks(b, parked.artifacts),
	});
	const deletionB = remove(parked.artifacts, parked.id);
	print("2-parked delete", { deletion: deletionB, recordsRightAfter: recordsOf(parked.artifacts, parked.id) });
	print("2-parked probe", { ...(await probe(b, parked.id)), recordsAfterProbe: recordsOf(parked.artifacts, parked.id) });
	print("2-parked kept sibling", { id: keepB.id, ...(await probe(b, keepB.id)) });
	print("6-partial parked delete", {
		id: partParked.id,
		indexRow: await waitParked(partParked.id),
		before: recordsOf(partParked.artifacts, partParked.id),
		deletion: remove(partParked.artifacts, partParked.id, true),
		after: recordsOf(partParked.artifacts, partParked.id),
	});
	print("6-partial parked probe", { ...(await probe(b, partParked.id)), recordsAfterProbe: recordsOf(partParked.artifacts, partParked.id) });
	const reuseB = await spawnChild(b, "B0Parked");
	print("7-id reuse in same live session (full delete, parked)", { requested: "B0Parked", got: reuseB.id });
	const bErrors = b.errors();
	const bExit = await b.close();
	print("B exit", { exitCode: bExit, errors: bErrors, stderrTail: short(b.stderr.join("").slice(-500)) });

	// ── 3 + 7: resume both sessions, then respawn the deleted names ─────────────────────────
	// Follow-ups above may have recreated files, and the in-session respawns left `<name>-2` records: delete again
	// so the resumed sessions start from exactly the janitor's end state (full for B0Live/B0Parked, partial for B0Part*).
	const redelete = {
		full: [remove(live.artifacts, live.id), remove(parked.artifacts, parked.id), remove(reuseA.artifacts, reuseA.id), remove(reuseB.artifacts, reuseB.id)],
		partial: [remove(partLive.artifacts, partLive.id, true), remove(partParked.artifacts, partParked.id, true)],
	};
	print("3-pre-resume re-delete", redelete);
	for (const [label, file, kept, full, partial] of [
		["A", sessionA, keep.id, live.id, partLive.id],
		["B", sessionB, keepB.id, parked.id, partParked.id],
	] as const) {
		const r = await open(["--resume", file]);
		const resumed = await sessionFile(r);
		const index = await read(r, "history://");
		const gone = {
			full: { history: await read(r, `history://${full}`), agent: await read(r, `agent://${full}`) },
			partial: { history: await read(r, `history://${partial}`), agent: await read(r, `agent://${partial}`) },
			partialFollowUp: await act(r, "write", { path: `agent://${partial}`, content: "follow-up after resume" }),
		};
		const keptFollowUp = await act(r, "write", { path: `agent://${kept}`, content: "follow-up after resume" });
		await Bun.sleep(1_500);
		await r.quiet(0, "resume follow-up");
		const next = await prompt(r, "plain prompt after resume");
		const reuseFull = await spawnChild(r, full);
		const reusePartial = await spawnChild(r, partial);
		const errors = r.errors();
		const exit = await r.close();
		print(`3-resume ${label}`, {
			resumedSameFile: resumed === file,
			keptRow: indexRow(index.text, kept),
			fullDeletedRow: indexRow(index.text, full),
			partialDeletedRow: indexRow(index.text, partial),
			index: index.text,
			gone,
			keptFollowUp,
			nextPrompt: next,
			exitCode: exit,
			errors,
		});
		print(`7-id reuse after resume ${label}`, {
			fullDeleted: { requested: full, got: reuseFull.id },
			partialDeleted: { requested: partial, got: reusePartial.id },
		});
	}

	// ── 4b: stats after the deleted id was reused for a new transcript at the same path ───────
	const sync3 = ompCli(["stats", "--summary"]);
	const statsDb = new Database(STATS_DB, { readonly: true });
	const fileOffset = statsDb.query("SELECT offset, last_modified, substr(parser_state, 1, 160) AS parser FROM file_offsets WHERE session_file = ?").get(liveFile);
	statsDb.close();
	print("4b-stats after id reuse", {
		reusedFile: liveFile,
		reusedFileSize: existsSync(liveFile) ? statSync(liveFile).size : "missing",
		sync: { code: sync3.code, tail: short(sync3.out.slice(-160)) },
		rows: statsRows(liveFile),
		fileOffset,
	});
} finally {
	llm.kill();
}
