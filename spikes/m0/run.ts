#!/usr/bin/env bun
/**
 * M0 spike: what do omp's built-in session modes (vibe, goal, loop) do, and how can an extension drive
 * them? Runs the real omp binary against fake-llm.ts with the probe extension in plugin/, in the
 * interactive TUI (through a pty), RPC, ACP and print hosts. One JSON line per scenario.
 *
 * Usage: PATH=$PWD/node_modules/.bin:$PATH bun spikes/m0/run.ts [scenario...]   (default: all)
 * Needs port 18558 free. Wipes and recreates the `storm-m0` profile (~/.omp/profiles/storm-m0) and
 * /tmp/storm-m0; never touches other profiles. The plugin is installed into that profile with
 * `omp plugin link`, as a released plugin would be; M0_PLUGIN=e loads it with `-e <dir>` instead.
 * Env: OMP_BIN (default node_modules/.bin/omp), M0_KEEP_PROFILE=1 keeps the profile afterwards.
 */
import type { Subprocess } from "bun";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

type Frame = { type?: string; [key: string]: unknown };
type ExtEntry = { kind: string; who?: string; [key: string]: unknown };
interface LlmEntry {
	who: "main" | "worker" | "leaf" | "side";
	model: string;
	tools: string[];
	systemChars: number;
	systemHasVibe: boolean;
	roles: string[];
	modeTexts: Record<string, string[]>;
	messages: string[];
	directive: string;
	step: number;
	decision: { tool?: string; text?: string };
}
type ModeRequest = Record<string, unknown>;

const REPO = resolve(import.meta.dir, "../..");
const OMP = process.env.OMP_BIN ?? join(REPO, "node_modules/.bin/omp");
const PROFILE = "storm-m0";
const PORT = 18558;
const WORK = "/tmp/storm-m0";
const PROJECT = join(WORK, "project");
const SESSIONS = join(WORK, "sessions");
const LLM_LOG = join(WORK, "llm.jsonl");
const EXT_LOG = join(WORK, "ext.jsonl");
const RESULTS = join(WORK, "results.jsonl");
const PLUGIN = join(import.meta.dir, "plugin");
const PROFILE_ROOT = join(homedir(), ".omp", "profiles", PROFILE);
const OVERLAYS = {
	modeControlOff: "extensionHandlers:\n  modeControl: false\n",
	workerOverrides: "task:\n  agentModelOverrides:\n    task: fake/override-x\n    sonic: fake/override-y\n",
	rpcGoal: "goal:\n  continuationModes:\n    - interactive\n    - rpc\n",
} as const;
const ENV = { ...process.env, PATH: `${join(REPO, "node_modules/.bin")}:${process.env.PATH ?? ""}`, STORM_M0_LOG: EXT_LOG };
const LINKED = process.env.M0_PLUGIN !== "e";
const baseArgs = ["--profile", PROFILE, "--no-title", "--auto-approve", "--model", "fake/main", "--smol", "fake/smol", "--slow", "fake/main", "--plan", "fake/main", ...(LINKED ? [] : ["-e", PLUGIN])];
const MODELS_YML = `providers:
  fake:
    baseUrl: http://127.0.0.1:${PORT}/v1
    apiKey: storm-spike-dummy
    api: openai-completions
    models:
${["main", "smol", "override-x", "override-y"].map(id => `      - id: ${id}\n        contextWindow: 128000\n        maxTokens: 4096`).join("\n")}
`;

const readJsonl = <T>(path: string): T[] =>
	existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as T) : [];
const b64 = (value: unknown) => `b64:${Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64")}`;
const overlay = (name: keyof typeof OVERLAYS) => ["--config", join(WORK, `${name}.yml`)];

/** Log offsets taken when a scenario starts, so it only sees its own entries. */
class Cursor {
	#llm = readJsonl(LLM_LOG).length;
	#ext = readJsonl(EXT_LOG).length;
	llm(): LlmEntry[] {
		// omp's own auxiliary calls (routing hints, composer predictions) are not session turns.
		return readJsonl<LlmEntry>(LLM_LOG).slice(this.#llm).filter(entry => entry.who !== "side");
	}
	ext(kind?: string): ExtEntry[] {
		const entries = readJsonl<ExtEntry>(EXT_LOG).slice(this.#ext);
		return kind ? entries.filter(entry => entry.kind === kind) : entries;
	}
	/** Drops everything seen so far. */
	reset(): void {
		this.#llm = readJsonl(LLM_LOG).length;
		this.#ext = readJsonl(EXT_LOG).length;
	}
}

async function until<T>(probe: () => T | undefined, timeoutMs: number, label: string): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = probe();
		if (value !== undefined) return value;
		if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
		await Bun.sleep(100);
	}
}

/** One extension log entry as a short line; the timeline of a scenario is a list of these. */
function brief(entry: ExtEntry): string {
	const who = entry.who ? `[${entry.who}]` : "";
	switch (entry.kind) {
		case "agent_end":
			return `agent_end${who} willContinue=${entry.willContinue} awaitingAsyncWork=${entry.awaitingAsyncWork} idle=${entry.idle} stop=${entry.lastStop} | ${entry.modes}`;
		case "agent_start":
			return `agent_start${who}`;
		case "mode_changed":
			return `mode_changed${who} ${entry.previous} -> ${entry.state} idle=${entry.idle}`;
		case "goal_updated":
			return `goal_updated${who} ${JSON.stringify(entry.goal)} ${JSON.stringify(entry.state)}`;
		case "session_stop":
			return `session_stop${who} turn=${entry.turnId} hookActive=${entry.stopHookActive} continue=${entry.continue}`;
		case "spawn":
			return `before_subagent_spawn${who} agent=${entry.agent} kind=${entry.invocationKind} role=${entry.modelRole} patterns=${JSON.stringify(entry.patterns)}`;
		case "tool_call":
			return `tool_call${who} ${entry.tool}${entry.block ? " BLOCKED" : ""}`;
		case "input":
			return `input${who} source=${entry.source} "${entry.text}"`;
		case "set":
			return `set(${JSON.stringify(entry.request)}) from ${entry.from} idle=${entry.idle} => ${entry.result}${entry.modes ? ` | ${entry.modes}` : ""}`;
		case "session_start":
			return `session_start${who} host=${entry.host} hasUI=${entry.hasUI} sessionModes=${entry.sessionModes} | ${entry.modes}`;
		default:
			return `${entry.kind} ${JSON.stringify({ ...entry, ts: undefined, kind: undefined })}`;
	}
}

/** One model request as a short line: who asked, which model, how many tools, which mode texts, the reply. */
function briefLlm(entry: LlmEntry): string {
	const texts = Object.entries(entry.modeTexts).map(([key, hits]) => `${key}@${hits.join(",")}`).join(" ");
	const reply = entry.decision.tool ? `-> ${entry.decision.tool}` : `-> "${entry.decision.text}"`;
	return `${entry.who} ${entry.model} tools=${entry.tools.length} msgs=${entry.messages.length} last=${entry.messages.at(-1)?.slice(0, 60)} ${texts} ${reply}`;
}

const timeline = (cursor: Cursor, skip: string[] = []) => cursor.ext().filter(entry => !skip.includes(entry.kind)).map(brief);

// ── hosts ───────────────────────────────────────────────────────────────────────────────

const ANSI = /\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[PX^_][^\x1b]*\x1b\\|\x1b[@-Z\\-_]/g;

/** The interactive TUI on a pty. Answers the terminal queries (DA1, OSC 11) the TUI waits for before it renders. */
class Tui {
	raw = "";
	readonly #proc: Subprocess;
	readonly cursor = new Cursor();

	constructor(args: string[], env: Record<string, string | undefined> = {}) {
		const decoder = new TextDecoder();
		this.#proc = Bun.spawn([OMP, ...baseArgs, ...args], {
			cwd: PROJECT,
			env: { ...ENV, ...env, TERM: "xterm-256color" },
			terminal: {
				cols: 160,
				rows: 50,
				data: (terminal, data) => {
					const text = decoder.decode(data, { stream: true });
					this.raw += text;
					if (text.includes("\x1b[c")) terminal.write("\x1b[?62;22c");
					if (text.includes("\x1b]11;?")) terminal.write("\x1b]11;rgb:1e1e/1e1e/1e1e\x1b\\");
				},
			},
		});
	}

	/** Everything printed so far without escape sequences. */
	text(): string {
		return this.raw.replace(ANSI, "").replace(/\r/g, "\n");
	}

	async ready(): Promise<void> {
		await until(() => this.cursor.ext("session_start").find(entry => String(entry.who).startsWith("main:")), 40_000, "tui session_start");
		// A fresh profile may open the provider sign-in picker; Enter there would start a real login.
		await Bun.sleep(1_500);
		if (this.text().includes("Select provider to login")) {
			this.#proc.terminal?.write("\x1b");
			await Bun.sleep(500);
		}
	}

	async submit(text: string): Promise<void> {
		this.#proc.terminal?.write(text);
		await Bun.sleep(350);
		this.#proc.terminal?.write("\r");
	}

	/** Runs an extension command and waits for the log line it writes. */
	async command(text: string, kind: string, count = 1, timeoutMs = 20_000): Promise<ExtEntry[]> {
		const before = this.cursor.ext(kind).length;
		await this.submit(text);
		await until(() => (this.cursor.ext(kind).length >= before + count ? true : undefined), timeoutMs, `${kind} after ${text.slice(0, 30)}`);
		return this.cursor.ext(kind).slice(before);
	}

	/** `ctx.sessionModes.set()` for each request in turn, from one command handler each. */
	async set(...requests: ModeRequest[]): Promise<string[]> {
		const lines: string[] = [];
		for (const request of requests) {
			const [entry] = await this.command(`/m0-set ${b64(request)}`, "set");
			lines.push(`${JSON.stringify(request)} => ${entry.result} | ${entry.modes ?? ""}`);
		}
		return lines;
	}

	send(text: string): Promise<ExtEntry[]> {
		return this.command(`/m0-send ${b64(text)}`, "send");
	}

	async close(): Promise<void> {
		this.#proc.terminal?.write("\x03");
		await Bun.sleep(700);
		this.#proc.terminal?.write("\x03");
		const exited = await Promise.race([this.#proc.exited.then(() => true), Bun.sleep(6_000).then(() => false)]);
		if (!exited) this.#proc.kill();
		await this.#proc.exited;
	}
}

async function tui<T extends object>(args: string[], body: (session: Tui) => Promise<T>, env: Record<string, string | undefined> = {}): Promise<T> {
	const session = new Tui(args, env);
	try {
		await session.ready();
		return await body(session);
	} catch (error) {
		throw new Error(`${String(error)} | timeline: ${JSON.stringify(timeline(session.cursor).slice(-12))} | screen: ${session.text().slice(-600)}`);
	} finally {
		await session.close();
	}
}

class Rpc {
	readonly frames: Frame[] = [];
	readonly stderr: string[] = [];
	readonly cursor = new Cursor();
	readonly #proc: Subprocess<"pipe", "pipe", "pipe">;
	#seq = 0;

	constructor(args: string[]) {
		const proc = Bun.spawn([OMP, "--mode", "rpc", "--no-session", ...baseArgs, ...args], { cwd: PROJECT, env: ENV, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
		this.#proc = proc;
		void this.#pump();
		void (async () => {
			const decoder = new TextDecoder();
			for await (const chunk of proc.stderr) this.stderr.push(decoder.decode(chunk));
		})();
	}

	async #pump(): Promise<void> {
		const decoder = new TextDecoder();
		let buffer = "";
		for await (const chunk of this.#proc.stdout) {
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
		this.#proc.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
		this.#proc.stdin.flush();
		return id;
	}

	async request(command: Frame): Promise<Frame> {
		const at = this.frames.length;
		const id = this.send(command);
		return until(() => this.frames.slice(at).find(frame => frame.type === "response" && frame.id === id), 20_000, `${command.type} response`);
	}

	/** Waits until the session reported settled after `from` and no frame has arrived for `quietMs`. */
	async quiet(from: number, label: string, quietMs = 2_500): Promise<void> {
		const deadline = Date.now() + 90_000;
		let seen = this.frames.length;
		let since = Date.now();
		for (;;) {
			await Bun.sleep(200);
			if (this.frames.length !== seen) {
				seen = this.frames.length;
				since = Date.now();
				continue;
			}
			const settled = this.frames.slice(from).find(frame => frame.type === "session_settled" || (frame.type === "prompt_result" && frame.sessionSettled === true));
			if (settled && Date.now() - since >= quietMs) return;
			if (Date.now() > deadline) throw new Error(`timeout waiting for quiet: ${label}`);
		}
	}

	async prompt(message: string, label = message): Promise<void> {
		const from = this.frames.length;
		this.send({ type: "prompt", message });
		await this.quiet(from, label);
	}

	/** Frame types that mark run boundaries, in order, from `from`. */
	marks(from: number): string[] {
		return this.frames
			.slice(from)
			.filter(frame => ["agent_start", "agent_end", "agent_pause", "session_settled", "prompt_result", "run_state"].includes(String(frame.type)))
			.map(frame => `${frame.type}${frame.sessionSettled !== undefined ? ` settled=${frame.sessionSettled}` : ""}${frame.state !== undefined ? ` ${JSON.stringify(frame.state)}` : ""}`);
	}

	async close(): Promise<void> {
		this.#proc.stdin.end();
		const exited = await Promise.race([this.#proc.exited.then(() => true), Bun.sleep(6_000).then(() => false)]);
		if (!exited) this.#proc.kill();
		await this.#proc.exited;
	}
}

async function rpc<T extends object>(args: string[], body: (session: Rpc) => Promise<T>): Promise<T> {
	const session = new Rpc(args);
	try {
		await until(() => session.frames.find(frame => frame.type === "ready"), 40_000, "rpc ready");
		return await body(session);
	} catch (error) {
		throw new Error(`${String(error)} | timeline: ${JSON.stringify(timeline(session.cursor).slice(-12))} | stderr: ${session.stderr.join("").slice(-600)}`);
	} finally {
		await session.close();
	}
}

// ── TUI scenarios ───────────────────────────────────────────────────────────────────────

const GOAL = { mode: "goal", action: "enter", objective: "M0 objective: finish the spike", tokenBudget: 100_000 };

/** Q5: which modes hold together, and what `set()` answers for each request. No model call is made. */
function tuiMatrix() {
	return tui(["--no-session"], async session => {
		const start = session.cursor.ext("session_start")[0];
		const results = await session.set(
			{ mode: "vibe", action: "enter" },
			{ mode: "vibe", action: "enter" },
			GOAL,
			{ mode: "plan", action: "enter" },
			{ mode: "loop", action: "enter", limit: { kind: "iterations", iterations: 3 } },
			{ mode: "loop", action: "enter", prompt: "repeat me" },
			{ mode: "loop", action: "enter", limit: { kind: "duration", durationMs: 60_000 } },
			{ mode: "loop", action: "exit" },
			{ mode: "vibe", action: "exit" },
			GOAL,
			GOAL,
			{ ...GOAL, objective: "another objective" },
			{ mode: "vibe", action: "enter" },
			{ mode: "plan", action: "enter" },
			{ mode: "loop", action: "enter", prompt: "repeat me", condition: { command: "test -f stop.flag", until: true } },
			{ mode: "goal", action: "pause" },
			{ mode: "vibe", action: "enter" },
			{ mode: "goal", action: "resume" },
			{ mode: "goal", action: "drop" },
			{ mode: "loop", action: "exit" },
			{ mode: "plan", action: "enter" },
			{ mode: "vibe", action: "enter" },
			GOAL,
			{ mode: "loop", action: "enter" },
			{ mode: "loop", action: "exit" },
			{ mode: "plan", action: "exit" },
			{ mode: "vibe", action: "toggle" },
			{ mode: "loop", action: "enter", limit: { kind: "iterations", iterations: 0 } },
			{ mode: "goal", action: "enter", objective: " " },
		);
		const [state] = await session.command("/m0-state", "state");
		const toolsByMode = session.cursor.ext("mode_changed").map(entry => `${entry.state}: ${(entry.activeTools as string[]).join(",")}`);
		return {
			sessionStart: brief(start),
			results,
			finalState: state.state,
			toolsAtStart: start.activeTools,
			toolsByMode: [...new Set(toolsByMode)],
			modelRequests: session.cursor.llm().length,
		};
	});
}

/**
 * Q1/Q2: a vibe run. The director spawns a slow `good` worker (which spawns a Storm role agent) and a
 * `fast` worker (which spawns `task`), then ends its turn while both are still working.
 */
function tuiVibe(extraArgs: string[] = []) {
	return tui(["--no-session", ...extraArgs], async session => {
		const cursor = session.cursor;
		const mainSettled = (after: number) => {
			const last = cursor.ext("agent_end").at(-1);
			return cursor.ext().length > after && last && String(last.who).startsWith("main:") && last.willContinue === false ? true : undefined;
		};
		const entered = await session.set({ mode: "vibe", action: "enter" });
		await session.send("M0-STEPS vibe");
		const workerEnded = (id: string) => cursor.ext("agent_end").some(entry => String(entry.who).startsWith(`sub:${id}:`));
		await until(() => (workerEnded("M0Good") && workerEnded("M0Fast") ? true : undefined), 90_000, "both workers finished a turn");
		await until(() => mainSettled(0), 60_000, "director settled");
		await Bun.sleep(3_000);
		const firstRun = timeline(cursor, ["send", "set"]);
		const llm = cursor.llm();
		const director = llm.find(entry => entry.who === "main");
		const others = [...new Map(llm.filter(entry => entry.who !== "main").map(entry => [`${entry.who} ${entry.model} ${entry.roles.join()}`, entry])).values()];
		const [stateInVibe] = await session.command("/m0-state", "state");

		// Director-side tool_call handlers: observe `read`, block `vibe_spawn`.
		let mark = cursor.ext().length;
		await session.send("M0-STEPS read");
		await until(() => mainSettled(mark + 2), 40_000, "read turn settled");
		const readRun = cursor.ext().slice(mark).filter(entry => !["send", "input"].includes(entry.kind)).map(brief);
		await session.command("/m0-block vibe_spawn", "block-armed");
		mark = cursor.ext().length;
		const llmMark = cursor.llm().length;
		await session.send("M0-STEPS vibe");
		await until(() => (cursor.ext("tool_call").filter(entry => entry.block === true).length >= 2 ? true : undefined), 30_000, "blocked vibe_spawn");
		await until(() => mainSettled(mark + 3), 40_000, "blocked run settled");
		const blockedRun = cursor.ext().slice(mark).filter(entry => !["send", "set", "state"].includes(entry.kind)).map(brief);
		const exited = await session.set({ mode: "vibe", action: "exit" });
		const [stateAfter] = await session.command("/m0-state", "state");
		return {
			entered,
			directorTools: director?.tools,
			directorSystemChars: director?.systemChars,
			directorSystemHasVibeText: director?.systemHasVibe,
			directorMessages: llm.findLast(entry => entry.who === "main")?.messages,
			others: others.map(entry => ({ who: entry.who, model: entry.model, systemChars: entry.systemChars, roles: entry.roles, firstMessages: entry.messages.slice(0, 4), tools: entry.tools.join(",") })),
			requests: llm.map(briefLlm),
			firstRun,
			toolsInVibe: stateInVibe.activeTools,
			readRun,
			blockedRun,
			blockedRunRequests: cursor.llm().slice(llmMark).filter(entry => entry.who === "main").map(briefLlm),
			exited,
			toolsAfterExit: stateAfter.activeTools,
			screen: session.text().match(/Vibe mode[^\n]{0,120}/g)?.slice(-3).map(line => line.trim()),
		};
	});
}

/** Q1/Q3: a goal run to completion: read, then a `task` subagent, then goal({op:"complete"}). */
function tuiGoal() {
	return tui(["--no-session"], async session => {
		const cursor = session.cursor;
		const entered = await session.set(GOAL);
		await Bun.sleep(2_500);
		const idleAfterEnter = { modelRequests: cursor.llm().length, note: "no prompt is submitted by set(); nothing runs until one is sent" };
		await session.send("M0-STEPS read");
		await until(() => cursor.ext("mode_changed").find(entry => String(entry.state).includes("goal=inactive") && String(entry.previous).includes("goal=active")), 120_000, "goal completed");
		await Bun.sleep(3_000);
		const llm = cursor.llm();
		const main = llm.filter(entry => entry.who === "main");
		const [state] = await session.command("/m0-state", "state");
		return {
			entered,
			idleAfterEnter,
			timeline: timeline(cursor, ["send", "set", "state"]),
			mainRequests: main.map(briefLlm),
			mainToolsDuringGoal: main[0]?.tools,
			lastMainMessages: main.at(-1)?.messages,
			children: llm.filter(entry => entry.who !== "main").map(briefLlm),
			toolsAfter: state.activeTools,
			screen: session.text().match(/Goal [^\n]{0,80}/g)?.slice(-4),
		};
	});
}

/**
 * Q3: a goal whose continuation turn ends, after its subagent reported, with a reply that calls no tool.
 * omp reads that as "no progress" and stops continuing; the goal stays active.
 */
function tuiGoalStall() {
	return tui(["--no-session"], async session => {
		const cursor = session.cursor;
		await session.set({ ...GOAL, objective: "M0 objective G0-STALL: finish the spike" });
		await session.send("M0-STEPS read");
		await until(() => cursor.ext("agent_end").find(entry => String(entry.who).startsWith("sub:")), 90_000, "subagent finished");
		await Bun.sleep(8_000);
		const [state] = await session.command("/m0-state", "state");
		const quiet = cursor.ext().length;
		await session.send("a new user prompt re-arms continuation");
		await until(() => cursor.ext("mode_changed").find(entry => String(entry.state).includes("goal=inactive")), 60_000, "goal completed after the nudge");
		return {
			timelineUntilStall: cursor.ext().slice(0, quiet).filter(entry => !["send", "set", "state", "input", "goal_updated"].includes(entry.kind)).map(brief),
			stateWhileStalled: state.state,
			afterNudge: cursor.ext().slice(quiet).filter(entry => !["send", "goal_updated", "tool_call"].includes(entry.kind)).map(brief),
		};
	});
}

/** Q3: a token budget that the first turn exhausts; then pause and drop from the extension. */
function tuiGoalBudget() {
	return tui(["--no-session"], async session => {
		const cursor = session.cursor;
		const entered = await session.set({ ...GOAL, tokenBudget: 150 });
		await session.send("M0-STEPS read");
		await until(() => cursor.ext("goal_updated").find(entry => (entry.goal as { status?: string } | null)?.status === "budget-limited"), 60_000, "budget-limited");
		await Bun.sleep(6_000);
		const run = timeline(cursor, ["send", "set"]);
		const requests = cursor.llm().map(briefLlm);
		cursor.reset();
		const after = await session.set({ mode: "goal", action: "pause" }, { mode: "goal", action: "resume" }, { mode: "goal", action: "drop" });
		await Bun.sleep(1_000);
		return { entered, run, requests, after, afterTimeline: timeline(cursor, ["set"]) };
	});
}

/** Q4: loop with an iteration limit, with an `until` condition, and without a prompt. */
function tuiLoop() {
	return tui(["--no-session"], async session => {
		const cursor = session.cursor;
		const loopEnded = () => cursor.ext("mode_changed").find(entry => String(entry.state).includes("loop=inactive") && !String(entry.previous).includes("loop=inactive"));
		const limited = await session.set({ mode: "loop", action: "enter", prompt: "M0-STEPS read (loop body)", limit: { kind: "iterations", iterations: 2 } });
		await Bun.sleep(2_500);
		const requestsBeforeFirstPrompt = cursor.llm().length;
		await session.send("first prompt, sent by the extension");
		await until(loopEnded, 90_000, "iteration limit reached");
		await Bun.sleep(1_500);
		const limitedRun = { timeline: timeline(cursor, ["send", "set", "tool_call"]), requests: cursor.llm().map(briefLlm), screen: session.text().match(/Loop [^\n]{0,110}/g)?.slice(-3) };

		cursor.reset();
		rmSync(join(PROJECT, "stop.flag"), { force: true });
		const conditional = await session.set({ mode: "loop", action: "enter", prompt: "M0-STEPS read (until body)", condition: { command: "test -f stop.flag", until: true } });
		await session.send("first prompt of the conditional loop");
		await until(() => (cursor.ext("agent_end").length >= 3 ? true : undefined), 90_000, "three conditional turns");
		writeFileSync(join(PROJECT, "stop.flag"), "");
		await until(loopEnded, 60_000, "condition satisfied");
		await Bun.sleep(1_500);
		const conditionalRun = { timeline: timeline(cursor, ["send", "set", "tool_call"]), screen: session.text().match(/Loop condition[^\n]{0,110}/g)?.slice(-2) };

		cursor.reset();
		const bare = await session.set({ mode: "loop", action: "enter", limit: { kind: "iterations", iterations: 2 } });
		await session.send("a prompt sent by the extension while the loop waits for one");
		await until(() => cursor.ext("agent_end")[0], 60_000, "turn after bare loop");
		await Bun.sleep(4_000);
		const bareRun = { timeline: timeline(cursor, ["send", "set", "tool_call"]), modelRequests: cursor.llm().length };
		const exited = await session.set({ mode: "loop", action: "exit" });
		return { limited, requestsBeforeFirstPrompt, limitedRun, conditional, conditionalRun, bare, bareRun, exited };
	});
}

/** Q5: goal and loop together: which one drives the next turn, and what is left when the loop ends. */
function tuiGoalLoop() {
	return tui(["--no-session"], async session => {
		const cursor = session.cursor;
		const entered = await session.set(GOAL, { mode: "loop", action: "enter", prompt: "M0-STEPS read (goal+loop body)", limit: { kind: "iterations", iterations: 2 } });
		await session.send("first prompt under goal+loop");
		await until(() => cursor.ext("mode_changed").find(entry => String(entry.state).includes("loop=inactive") && String(entry.previous).includes("loop=active")), 90_000, "loop limit reached");
		await Bun.sleep(5_000);
		const afterLoop = cursor.llm().filter(entry => entry.who === "main").map(briefLlm);
		const [state] = await session.command("/m0-state", "state");
		const dropped = await session.set({ mode: "goal", action: "drop" });
		return { entered, timeline: timeline(cursor, ["send", "set", "tool_call", "state"]), mainRequests: afterLoop, stateAfterLoop: state.state, dropped };
	});
}

/** Q5: `set()` from session_start, from a terminal agent_end handler, and from inside a tool's execute. */
function tuiSetFrom() {
	return tui(
		["--no-session"],
		async session => {
			const cursor = session.cursor;
			await until(() => (cursor.ext("set").filter(entry => entry.from === "session_start").length >= 2 ? true : undefined), 20_000, "set from session_start");
			await session.command(`/m0-arm ${b64({ mode: "loop", action: "enter", limit: { kind: "iterations", iterations: 1 } })}`, "arm");
			await session.send("M0-STEPS read");
			await until(() => cursor.ext("set").find(entry => entry.from === "agent_end+idle"), 60_000, "set from agent_end");
			await Bun.sleep(1_000);
			await session.set({ mode: "loop", action: "exit" });
			await session.send(`M0-STEPS mset:${Buffer.from(JSON.stringify({ mode: "vibe", action: "enter" })).toString("base64")}`);
			await until(() => cursor.ext("set").find(entry => entry.from === "tool"), 60_000, "set from tool");
			await Bun.sleep(2_000);
			return { sets: cursor.ext("set").map(brief), timeline: timeline(cursor, ["send", "set", "arm", "input"]) };
		},
		{ STORM_M0_SET_AT_START: "1" },
	);
}

/** Q5: `extensionHandlers.modeControl: false`. */
function tuiModeControlOff() {
	return tui(["--no-session", ...overlay("modeControlOff")], async session => {
		const before = session.text().length;
		const results = await session.set({ mode: "vibe", action: "enter" }, GOAL, { mode: "loop", action: "enter" }, { mode: "loop", action: "exit" });
		const [state] = await session.command("/m0-state", "state");
		await Bun.sleep(800);
		const printed = session.text().slice(before);
		return {
			results,
			getState: state.state,
			screenMentions: printed.match(/[^\n]*(?:disabled|mode control|modeControl)[^\n]*/gi)?.map(line => line.trim().slice(0, 160)) ?? [],
		};
	});
}

/** Q1: what a restart restores. Sessions are written under /tmp/storm-m0/sessions. */
async function tuiPersist() {
	const args = ["--session-dir", SESSIONS];
	const first = await tui(args, async session => {
		const results = await session.set(GOAL, { mode: "loop", action: "enter", limit: { kind: "iterations", iterations: 5 } });
		await session.send("M0-STEPS read");
		await until(() => session.cursor.ext("agent_end")[0], 60_000, "one goal turn");
		return { results };
	});
	const second = await tui([...args, "--continue"], async session => {
		await Bun.sleep(1_500);
		const [state] = await session.command("/m0-state", "state");
		const restored = timeline(session.cursor, ["state", "input"]);
		const results = await session.set({ mode: "goal", action: "resume" }, { mode: "goal", action: "drop" }, { mode: "vibe", action: "enter" });
		return { restored, state: state.state, results };
	});
	const third = await tui([...args, "--continue"], async session => {
		await Bun.sleep(1_500);
		const [state] = await session.command("/m0-state", "state");
		const restored = timeline(session.cursor, ["state", "input"]);
		const results = await session.set({ mode: "vibe", action: "exit" });
		return { restored, state: state.state, tools: state.activeTools, results };
	});
	return { first, afterGoalAndLoop: second, afterVibe: third };
}

// ── RPC / ACP / print scenarios ─────────────────────────────────────────────────────────

/** Q1/Q6: no `ctx.sessionModes` outside the TUI; what the mode slash commands and the RPC `goal` command do there. */
function rpcProbe() {
	return rpc([], async session => {
		const cursor = session.cursor;
		await session.prompt(`/m0-set ${b64({ mode: "vibe", action: "enter" })}`, "m0-set");
		await session.prompt("/m0-state", "m0-state");
		const commands = await session.request({ type: "get_available_commands" });
		const names = JSON.stringify(commands.data ?? commands).match(/"name":"(vibe|goal|loop|plan|guided-goal)"/g) ?? [];
		const slash: Record<string, string[]> = {};
		for (const text of ["/vibe", "/loop 2 hello", "/goal set M0 objective"]) {
			const at = cursor.llm().length;
			const from = session.frames.length;
			await session.prompt(text);
			slash[text] = [
				`model requests: ${cursor.llm().length - at}`,
				...session.frames.slice(from).filter(frame => frame.type === "response" || frame.type === "error" || frame.type === "prompt_result").map(frame => JSON.stringify(frame).slice(0, 220)),
			];
		}
		const goalGet = await session.request({ type: "goal", op: "get" });
		const beforeCreate = cursor.llm().length;
		const goalCreate = await session.request({ type: "goal", op: "create", objective: "M0 objective", token_budget: 100_000 });
		await Bun.sleep(2_500);
		const llmAt = cursor.llm().length;
		const from = session.frames.length;
		await session.prompt("M0-STEPS read");
		const goalDrop = await session.request({ type: "goal", op: "drop" });
		return {
			sessionStart: cursor.ext("session_start").map(brief),
			set: cursor.ext("set").map(brief),
			state: cursor.ext("state")[0],
			modeCommandsListed: names,
			slash,
			goalGet: JSON.stringify(goalGet).slice(0, 200),
			goalCreate: JSON.stringify(goalCreate).slice(0, 320),
			modelRequestsRightAfterCreate: llmAt - beforeCreate,
			promptUnderGoal: { marks: session.marks(from), requests: cursor.llm().slice(llmAt).map(briefLlm), tools: cursor.llm().at(-1)?.tools.filter(name => name === "goal") },
			goalDrop: JSON.stringify(goalDrop).slice(0, 200),
			timeline: timeline(cursor, ["set", "state", "session_start"]),
		};
	});
}

/** Q3/Q6: goal continuation in RPC once `goal.continuationModes` includes "rpc". */
function rpcGoal() {
	return rpc(overlay("rpcGoal"), async session => {
		const cursor = session.cursor;
		const from = session.frames.length;
		const created = await session.request({ type: "goal", op: "create", objective: "M0 objective", token_budget: 100_000 });
		await until(() => cursor.ext("goal_updated").find(entry => (entry.goal as { status?: string } | null)?.status === "complete"), 120_000, "goal complete");
		await session.quiet(from, "goal run");
		const get = await session.request({ type: "goal", op: "get" });
		return {
			created: JSON.stringify(created.data ?? created).slice(0, 240),
			marks: session.marks(from),
			timeline: timeline(cursor, ["session_start"]),
			mainRequests: cursor.llm().filter(entry => entry.who === "main").map(briefLlm),
			goalAfter: JSON.stringify(get.data ?? get).slice(0, 200),
		};
	});
}

/** Q6: goal/loop semantics without mode control: `session_stop` asking for continuation turns. */
function rpcStop() {
	return rpc([], async session => {
		const cursor = session.cursor;
		await session.prompt(`/m0-stop 3 ${b64("M0-STOP-CONTINUE keep going. M0-STEPS read")}`, "m0-stop");
		const from = session.frames.length;
		await session.prompt("start");
		const few = { marks: session.marks(from), timeline: timeline(cursor, ["session_start", "stop-armed", "tool_call"]), requests: cursor.llm().map(briefLlm), lastMessages: cursor.llm().at(-1)?.messages };
		cursor.reset();
		await session.prompt(`/m0-stop 12 ${b64("M0-STOP-CONTINUE keep going")}`, "m0-stop");
		await session.prompt("start again");
		const capped = { stopEvents: cursor.ext("session_stop").map(brief), agentEnds: cursor.ext("agent_end").length, continuations: cursor.ext("agent_end").filter(entry => entry.willContinue === true).length };
		return { few, capped };
	});
}

async function printProbe() {
	const cursor = new Cursor();
	const run = Bun.spawn([OMP, "-p", "--no-session", ...baseArgs, "hello"], { cwd: PROJECT, env: ENV, stdout: "pipe", stderr: "pipe" });
	const timer = setTimeout(() => run.kill(), 60_000);
	const exitCode = await run.exited;
	clearTimeout(timer);
	return { exitCode, stdout: (await new Response(run.stdout).text()).trim().slice(-120), timeline: timeline(cursor) };
}

/** ACP: session_start of a new session, the modes the host advertises, and a mode slash command. */
async function acpProbe() {
	const cursor = new Cursor();
	const proc = Bun.spawn([OMP, "--mode", "acp", "--no-session", ...baseArgs], { cwd: PROJECT, env: ENV, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
	type Message = { id?: number; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: unknown };
	const pending = new Map<number, (message: Message) => void>();
	const updates: string[] = [];
	let nextId = 0;
	const write = (message: object) => {
		proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
		proc.stdin.flush();
	};
	const request = (method: string, params: object, timeoutMs = 40_000): Promise<Message> => {
		const id = ++nextId;
		const { promise, resolve: resolvePending } = Promise.withResolvers<Message>();
		pending.set(id, resolvePending);
		write({ id, method, params });
		return Promise.race([
			promise,
			Bun.sleep(timeoutMs).then((): never => {
				throw new Error(`timeout waiting for ${method}`);
			}),
		]);
	};
	void (async () => {
		const decoder = new TextDecoder();
		let buffer = "";
		for await (const chunk of proc.stdout) {
			buffer += decoder.decode(chunk, { stream: true });
			for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
				const line = buffer.slice(0, newline).trim();
				buffer = buffer.slice(newline + 1);
				if (!line.startsWith("{")) continue;
				const message = JSON.parse(line) as Message;
				if (message.method && message.id !== undefined) write({ id: message.id, error: { code: -32601, message: "not supported by spike client" } });
				else if (message.id !== undefined) {
					pending.get(message.id)?.(message);
					pending.delete(message.id);
				} else if (message.method === "session/update") {
					const update = message.params?.update as { sessionUpdate?: string; availableCommands?: Array<{ name: string }> } | undefined;
					if (update?.availableCommands) updates.push(`commands: ${update.availableCommands.map(command => command.name).filter(name => /^(vibe|goal|loop|plan|m0-)/.test(name)).join(",")}`);
				}
			}
		}
	})();
	try {
		await request("initialize", { protocolVersion: 1, clientCapabilities: {} });
		const created = await request("session/new", { cwd: PROJECT, mcpServers: [] });
		const sessionId = created.result?.sessionId;
		const modes = created.result?.modes as { availableModes?: Array<{ id: string }>; currentModeId?: string } | undefined;
		const set = await request("session/prompt", { sessionId, prompt: [{ type: "text", text: `/m0-set ${b64({ mode: "vibe", action: "enter" })}` }] });
		const at = cursor.llm().length;
		const vibe = await request("session/prompt", { sessionId, prompt: [{ type: "text", text: "/vibe" }] });
		await Bun.sleep(1_000);
		return {
			advertisedModes: modes?.availableModes?.map(mode => mode.id),
			updates,
			setStop: set.result?.stopReason ?? set.error,
			slashVibe: { stop: vibe.result?.stopReason ?? vibe.error, modelRequests: cursor.llm().length - at },
			timeline: timeline(cursor),
		};
	} finally {
		proc.stdin.end();
		const exited = await Promise.race([proc.exited.then(() => true), Bun.sleep(5_000).then(() => false)]);
		if (!exited) proc.kill();
	}
}

// ── setup and driver ────────────────────────────────────────────────────────────────────

function setup(): void {
	rmSync(PROFILE_ROOT, { recursive: true, force: true });
	rmSync(WORK, { recursive: true, force: true });
	mkdirSync(join(PROFILE_ROOT, "agent"), { recursive: true });
	mkdirSync(PROJECT, { recursive: true });
	mkdirSync(SESSIONS, { recursive: true });
	writeFileSync(join(PROFILE_ROOT, "agent", "models.yml"), MODELS_YML);
	// setupVersion >= 3 keeps the TUI's first-run wizard (and its real sign-in flow) away.
	writeFileSync(join(PROFILE_ROOT, "agent", "config.yml"), "setupVersion: 3\n");
	writeFileSync(join(PROJECT, "note.txt"), "m0 spike note\n");
	writeFileSync(join(PROJECT, "note2.txt"), "m0 spike second note\n");
	for (const [name, content] of Object.entries(OVERLAYS)) writeFileSync(join(WORK, `${name}.yml`), content);
	if (!LINKED) return;
	const link = Bun.spawnSync([OMP, "--profile", PROFILE, "plugin", "link", PLUGIN], { cwd: PROJECT, env: ENV });
	if (link.exitCode !== 0) throw new Error(`omp plugin link failed: ${link.stdout.toString()}${link.stderr.toString()}`);
}

const SCENARIOS: Record<string, () => Promise<object>> = {
	"tui-matrix": tuiMatrix,
	"tui-vibe": () => tuiVibe(),
	"tui-vibe-overrides": () => tuiVibe(overlay("workerOverrides")),
	"tui-goal": tuiGoal,
	"tui-goal-stall": tuiGoalStall,
	"tui-goal-budget": tuiGoalBudget,
	"tui-loop": tuiLoop,
	"tui-goal-loop": tuiGoalLoop,
	"tui-set-from": tuiSetFrom,
	"tui-modecontrol-off": tuiModeControlOff,
	"tui-persist": tuiPersist,
	"rpc-probe": rpcProbe,
	"rpc-goal": rpcGoal,
	"rpc-stop": rpcStop,
	"print-probe": printProbe,
	"acp-probe": acpProbe,
};

setup();
const llm = Bun.spawn([process.execPath, join(import.meta.dir, "fake-llm.ts")], {
	env: { ...process.env, FAKE_LLM_PORT: String(PORT), FAKE_LLM_LOG: LLM_LOG },
	stdout: "ignore",
	stderr: "inherit",
});
try {
	await until(
		() => (Bun.spawnSync(["nc", "-z", "127.0.0.1", String(PORT)]).exitCode === 0 ? true : undefined),
		10_000,
		"fake-llm port",
	);
	const requested = process.argv.slice(2);
	const names = requested.length > 0 ? requested : Object.keys(SCENARIOS);
	for (const name of names) {
		const scenario = SCENARIOS[name];
		const started = Date.now();
		let result: object;
		try {
			result = scenario ? await scenario() : { error: "unknown scenario" };
		} catch (error) {
			result = { error: String(error) };
		}
		const line = JSON.stringify({ scenario: name, ms: Date.now() - started, ...result });
		appendFileSync(RESULTS, `${line}\n`);
		console.log(line);
	}
} finally {
	llm.kill();
	if (!process.env.M0_KEEP_PROFILE) rmSync(PROFILE_ROOT, { recursive: true, force: true });
}
