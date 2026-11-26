/**
 * What both E2E entry points share: the environment (pinned omp, an isolated HOME and profile inside the work dir,
 * the fake LLM), the step runner, the RPC and pty drivers, and readers of what Storm writes.
 *
 * Env: OMP_BIN (default node_modules/.bin/omp), E2E_PORT, E2E_PROFILE (default storm-e2e), E2E_WORK (default
 * <tmp>/storm-e2e[-tui]), E2E_ONLY (run only scenarios whose name contains this text; a step marked `always` still
 * runs), E2E_KEEP=1 keeps the work dir after a green run (it is always kept after a failure).
 * omp runs with HOME inside the work dir, so nothing under the real ~/.omp is read or written.
 */
import type { BunFile, Subprocess } from "bun";
import { AsyncLocalStorage } from "node:async_hooks";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { APPROVE } from "../../src/proposals/present.ts";
import { CLOSEOUT_TITLE } from "../../src/runtime/closeout.ts";
import { sessionStoreDir } from "../../src/session-scope.ts";
import type { Effort, RunSummary, RunRecord, StormConfig } from "../../src/types.ts";
import { STORM_MARK } from "../../src/view/appearance.ts";
import { CLOSEOUT_CHOICE_HINT, CLOSEOUT_STATUS_COMMAND } from "../../src/view/closeout.ts";
import type { LlmEntry, ScriptedTask, Step } from "./fake-llm.ts";
import { Screen } from "./screen.ts";

export type { LlmEntry, ScriptedTask, Step };
/** A line of omp's RPC output; only the fields the drivers read are named. */
export interface Frame {
	type?: string;
	id?: string;
	method?: string;
	title?: string;
	options?: string[];
	/** A session message on message frames, the text on a notice. */
	message?: { customType?: string; content?: unknown; details?: unknown } | string;
	notifyType?: string;
	sessionSettled?: boolean;
	toolName?: string;
	toolCallId?: string;
	args?: { path?: string };
	result?: { details?: { action?: string; outcome?: string } };
	isError?: boolean;
	/** Response frames to a command Storm's driver sent; `get_state` carries `data.sessionId`. */
	command?: string;
	success?: boolean;
	data?: { sessionId?: string; sessionFile?: string; messageCount?: number; cancelled?: boolean; [key: string]: unknown };
	[key: string]: unknown;
}

/** The custom type of a finished session message (`storm-report`, `async-result`), else undefined. */
export function customMessage(frame: Frame): string | undefined {
	return frame.type === "message_end" && typeof frame.message === "object" ? frame.message.customType : undefined;
}

// ── settled-run records (the closeout) ─────────────────────────────────────────────────────

/** The title every settled-run record keeps, on the rich card and on its plain fallback alike. */
export const CLOSEOUT_HEADING = CLOSEOUT_TITLE;
/** The one pointer a closeout card leaves to the detail it no longer carries. */
export const CLOSEOUT_DETAIL = CLOSEOUT_STATUS_COMMAND;

/** A typed next action as the director submits it in `storm brief`; only `run` and `resume` ever receive a number. */
export type BriefNext = { kind: "run"; task: string; why?: string } | { kind: "resume" } | { kind: "user"; text: string };
export const runNext = (task: string, why?: string): BriefNext => (why === undefined ? { kind: "run", task } : { kind: "run", task, why });
export const RESUME_NEXT: BriefNext = { kind: "resume" };
export const userNext = (text: string): BriefNext => ({ kind: "user", text });

/** The text of a session message: a plain string, or the joined text parts. */
export function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map(part => (part && typeof part === "object" && "text" in part ? String((part as { text: unknown }).text) : "")).join("\n");
}

/** One `storm-report` transcript record as the RPC host delivered it. */
export interface StormRecord {
	text: string;
	details: Record<string, unknown> | undefined;
}

/** Every finished `storm-report` record after frame `from`, oldest first. */
export function stormRecords(frames: readonly Frame[], from = 0): StormRecord[] {
	return frames.slice(from).flatMap(frame => {
		if (customMessage(frame) !== "storm-report" || typeof frame.message !== "object") return [];
		const details = frame.message.details;
		return [{ text: messageText(frame.message.content), details: details !== null && typeof details === "object" && !Array.isArray(details) ? (details as Record<string, unknown>) : undefined }];
	});
}

/**
 * The settled-run record of `runId` after frame `from`: the newest record carrying the closeout title. A record with
 * presentation metadata must name this run; one without it (the plain fallback, or the one-line tier) is accepted by
 * its title alone, which is why callers anchor `from` at the prompt that started the run.
 */
export function closeoutOf(frames: readonly Frame[], runId: string, from = 0): StormRecord | undefined {
	return stormRecords(frames, from).findLast(record => {
		if (!record.text.includes(CLOSEOUT_HEADING)) return false;
		const id = record.details?.runId;
		return id === undefined || id === runId;
	});
}

/** The record's body: what follows its title, as non-empty trimmed lines. */
export function closeoutBody(text: string): string[] {
	const at = text.lastIndexOf(CLOSEOUT_HEADING);
	const body = at < 0 ? text : text.slice(at + CLOSEOUT_HEADING.length);
	return body.split("\n").map(line => line.trim()).filter(line => line !== "" && !/^#+$/.test(line));
}

/** Numbered offers (`1. …`, `- 2. …`) in a record body; the user-owned line is never numbered. */
export function numberedOffers(lines: readonly string[]): string[] {
	return lines.filter(line => /^(?:[-*]\s+)?[1-9][.)]\s/.test(line));
}

/**
 * The directions a card offers, numbered or not: a host that registered no choice lists them as unnumbered direction
 * lines instead of numbers, so a test asserts the order and kind of what is offered, not one surface's numbering.
 */
export function offeredDirections(lines: readonly string[]): string[] {
	return lines.filter(line => numberedOffers([line]).length === 1 || /^(?:[-*]\s+)?[^\s:]+ 방향:\s/.test(line));
}

/**
 * Whether a settled-run record is the compact one-line tier: one factual body line, no numbered offer, no choice
 * hint, no status pointer. A short clean run gets exactly this, and a card never does.
 */
export function isOneLineCloseout(record: StormRecord): boolean {
	const body = closeoutBody(record.text);
	return body.length === 1 && offeredDirections(body).length === 0 && !record.text.includes(CLOSEOUT_CHOICE_HINT) && !record.text.includes(CLOSEOUT_DETAIL);
}

/** Every object in a parsed JSON value, depth first; a session file's entry shape is the host's, not Storm's. */
function* jsonObjects(value: unknown): Generator<Record<string, unknown>> {
	if (Array.isArray(value)) {
		for (const item of value) yield* jsonObjects(item);
	} else if (value !== null && typeof value === "object") {
		yield value as Record<string, unknown>;
		for (const item of Object.values(value)) yield* jsonObjects(item);
	}
}

/**
 * The `storm-report` messages a native session file saved, oldest first: what a restarted host replays. Read as
 * saved facts, independent of how a terminal happened to repaint them.
 */
export function persistedStormRecords(sessionFile: string): StormRecord[] {
	if (!existsSync(sessionFile)) return [];
	const out: StormRecord[] = [];
	for (const line of readFileSync(sessionFile, "utf8").split("\n")) {
		if (line.trim() === "") continue;
		let entry: unknown;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		for (const node of jsonObjects(entry)) {
			if (node.customType !== "storm-report") continue;
			const details = node.details;
			out.push({ text: messageText(node.content), details: details !== null && typeof details === "object" && !Array.isArray(details) ? (details as Record<string, unknown>) : undefined });
			break;
		}
	}
	return out;
}

/** The native session file of `sessionId` in a transcript directory; the host names it `<time>_<id>.jsonl`. */
export function sessionFileIn(dir: string, sessionId: string): string | undefined {
	if (!existsSync(dir)) return undefined;
	const name = readdirSync(dir).find(file => file.endsWith(`_${sessionId}.jsonl`));
	return name === undefined ? undefined : join(dir, name);
}

/**
 * Lanes a settled run left unfinished, from its final on-disk ledger (`closeoutFacts`, captured before the session's
 * team or target can change). The card no longer lists them; undefined means the record carries no such facts.
 */
export function pendingLanesOf(run: RunRecord): string[] | undefined {
	const lanes = run.closeoutFacts?.pendingLanes;
	return Array.isArray(lanes) ? [...lanes] : undefined;
}

export const ROOT = resolve(import.meta.dir, "..", "..");

export interface ModelSpec {
	id: string;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	/** Context window; 200k when absent. */
	context?: number;
	/** A custom reasoning ladder for this model; absent uses the fake provider's defaults. */
	efforts?: readonly Effort[];
}

export interface E2eEnv {
	omp: string;
	ompVersion: string;
	port: number;
	profile: string;
	work: string;
	project: string;
	home: string;
	agentDir: string;
	/** Native omp transcript root; each driver process gets its own directory below it. */
	sessionRoot: string;
	logs: string;
	llmLog: string;
	/** Environment of every omp process: isolated HOME, pinned binaries first on PATH. */
	childEnv: Record<string, string | undefined>;
}

/** The tracked files the project's one commit holds: scenarios change them to prove git sees a change made by a shell. */
export const TRACKED_FILE = "e2e-tracked.txt";
export const TRACKED_TEXT = "storm e2e tracked file\n";
export const COMMIT_FILE = "e2e-committed.txt";
export const COMMIT_TEXT = "storm e2e commit file\n";
export const REVIEW_FILE = "e2e-reviewed.txt";
export const REVIEW_TEXT = "storm e2e review file\n";

/** Resolves the environment and recreates the work dir: a git project with one commit, an isolated HOME and logs. */
export function prepare(name: string, defaultPort: number): E2eEnv {
	const omp = process.env.OMP_BIN ? resolve(process.env.OMP_BIN) : join(ROOT, "node_modules", ".bin", "omp");
	const port = Number(process.env.E2E_PORT ?? defaultPort);
	const profile = process.env.E2E_PROFILE ?? "storm-e2e";
	const work = resolve(process.env.E2E_WORK ?? join(tmpdir(), name));
	const home = join(work, "home");
	const project = join(work, "project");
	const logs = join(work, "logs");
	const sessionRoot = join(work, "sessions");
	const agentDir = join(home, ".omp", "profiles", profile, "agent");
	// Storm calls `omp` by name for its own subcommands: the binary under test must be the first one on PATH, and
	// the pinned bun runs it.
	const path = [dirname(omp), join(ROOT, "node_modules", ".bin"), process.env.PATH ?? ""].join(delimiter);
	// A test profile must only discover the loopback models we register. An isolated HOME is not enough: inherited
	// provider credentials and native EC2 metadata discovery can still make real models look available.
	const childEnv: Record<string, string | undefined> = {
		HOME: home,
		PATH: path,
		TERM: "xterm-256color",
		LANG: process.env.LANG,
		LC_ALL: process.env.LC_ALL,
		AWS_EC2_METADATA_DISABLED: "true",
	};
	rmSync(work, { recursive: true, force: true });
	for (const dir of [project, logs, sessionRoot, agentDir]) mkdirSync(dir, { recursive: true });
	const git = Bun.spawnSync(["git", "init", "-q", project]);
	if (git.exitCode !== 0) throw new Error(`git init failed: ${git.stderr.toString()}`);
	// The tree gate reads the commit a run started on: without a commit every tree read is undefined and git changes
	// stay invisible. The scenarios commit from inside the run, so the repo carries its own identity.
	for (const [file, text] of [
		[TRACKED_FILE, TRACKED_TEXT],
		[COMMIT_FILE, COMMIT_TEXT],
		[REVIEW_FILE, REVIEW_TEXT],
	]) {
		writeFileSync(join(project, file), text);
	}
	for (const args of [
		["config", "--local", "user.name", "Storm E2E"],
		["config", "--local", "user.email", "storm-e2e@example.invalid"],
		["add", "--", TRACKED_FILE, COMMIT_FILE, REVIEW_FILE],
		["commit", "-q", "-m", "e2e initial commit"],
	]) {
		const step = Bun.spawnSync(["git", "-C", project, ...args]);
		if (step.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${step.stderr.toString()}`);
	}
	const version = Bun.spawnSync([omp, "--version"], { env: childEnv });
	if (version.exitCode !== 0) throw new Error(`${omp} --version failed (${version.exitCode}): ${version.stderr.toString()}`);
	const ompVersion = version.stdout.toString().trim();
	console.log(`omp ${ompVersion} (${omp}) · bun ${Bun.version} · port ${port} · profile ${profile} · work ${work}`);
	return { omp, ompVersion, port, profile, work, project, home, agentDir, sessionRoot, logs, llmLog: join(work, "llm.jsonl"), childEnv };
}

export function modelsYml(port: number, providers: Record<string, readonly ModelSpec[]>): string {
	const lines = ["providers:"];
	for (const [provider, models] of Object.entries(providers)) {
		lines.push(`  ${provider}:`, `    baseUrl: http://127.0.0.1:${port}/v1`, "    apiKey: storm-e2e-dummy", "    api: openai-completions", "    models:");
		for (const { id, cost, context, efforts } of models) {
			lines.push(`      - id: ${id}`, `        contextWindow: ${context ?? 200_000}`, "        maxTokens: 8192");
			if (efforts) lines.push("        reasoning: true", `        thinking: { mode: effort, efforts: [${efforts.join(", ")}] }`);
			lines.push(`        cost: { input: ${cost.input}, output: ${cost.output}, cacheRead: ${cost.cacheRead}, cacheWrite: ${cost.cacheWrite} }`);
		}
	}
	return `${lines.join("\n")}\n`;
}

/** A model's list prices per million tokens; cache prices follow the input price. */
export function price(input: number, output: number): ModelSpec["cost"] {
	return { input, output, cacheRead: input / 10, cacheWrite: input * 1.25 };
}

/** The fake models a team is recommended from: two providers, three price tiers. */
export const TEAM_PROVIDERS = {
	fake: [
		{ id: "cheap-a", cost: price(0.1, 0.4) },
		{ id: "general-b", cost: price(2, 10) },
		{ id: "premium-c", cost: price(5, 25) },
	],
	fake2: [
		{ id: "cheap-d", cost: price(0.15, 0.6) },
		{ id: "general-e", cost: price(1.5, 8) },
	],
} satisfies Record<string, ModelSpec[]>;

/** `setupVersion` 3 keeps the TUI's first-run wizard (and its real sign-in flow) away. */
export const PROFILE_CONFIG = "setupVersion: 3\n";

/** Installs Storm into the profile the way a user does, so every session (subagents included) loads it as a plugin. */
export function linkPlugin(env: E2eEnv): void {
	const link = Bun.spawnSync([env.omp, "--profile", env.profile, "plugin", "link", ROOT], { cwd: env.project, env: env.childEnv });
	if (link.exitCode !== 0) throw new Error(`omp plugin link failed (${link.exitCode}): ${link.stdout.toString()}${link.stderr.toString()}`);
}

/** The step a piece of driver code runs in. Once the step timed out, every wait in it throws `aborted`. */
interface StepScope {
	name: string;
	aborted?: Error;
}
const scope = new AsyncLocalStorage<StepScope>();

/**
 * Polls `probe` until it gives a value: the one way the drivers wait, always for a state, never for an amount of
 * time. Throws on timeout, and as soon as the step it runs in has timed out, so that step's body unwinds.
 */
export async function until<T>(probe: () => T | undefined, timeoutMs: number, label: string): Promise<T> {
	const step = scope.getStore();
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (step?.aborted) throw step.aborted;
		const value = probe();
		if (value !== undefined) return value;
		if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
		await Bun.sleep(50);
	}
}

/** Starts the fake LLM and waits until it answers; its output goes to `logs/fake-llm.log`. */
export async function startFakeLlm(env: E2eEnv): Promise<Subprocess> {
	const server = Bun.spawn([process.execPath, join(import.meta.dir, "fake-llm.ts")], {
		env: { ...process.env, FAKE_LLM_PORT: String(env.port), FAKE_LLM_LOG: env.llmLog },
		stdout: Bun.file(join(env.logs, "fake-llm.log")),
		stderr: Bun.file(join(env.logs, "fake-llm.err.log")),
	});
	const deadline = Date.now() + 15_000;
	for (;;) {
		if (server.exitCode !== null) throw new Error(`fake LLM exited (${server.exitCode}); is port ${env.port} in use? See ${env.logs}/fake-llm.err.log`);
		const up = await fetch(`http://127.0.0.1:${env.port}/v1/models`).then(
			response => response.ok,
			() => false,
		);
		if (up) return server;
		if (Date.now() > deadline) throw new Error(`fake LLM did not answer on port ${env.port} within 15 s`);
		await Bun.sleep(50);
	}
}

// ── steps and checks ────────────────────────────────────────────────────────────────────

/** omp processes a step started and has not closed; a step that times out or throws leaves none behind. */
const open = new Set<{ stop(): Promise<void> }>();
/** How long a timed-out step's body gets to unwind after its processes were killed. */
const UNWIND_MS = 20_000;

export class Suite {
	readonly #started = Date.now();
	readonly #failed: string[] = [];
	readonly #steps: string[] = [];
	/** `E2E_ONLY`: run only scenarios whose name contains this text; a focused scenario still runs the whole fixture. */
	readonly #only = process.env.E2E_ONLY?.trim().toLowerCase() || undefined;
	#checks = 0;

	constructor(
		private readonly name: string,
		private readonly env: E2eEnv,
	) {}

	/**
	 * One scenario. A throw or a timeout is recorded as a failure of the step and the next step still runs, but only
	 * once this one is over: on a timeout its omp processes are killed and its body, whose waits now throw, is
	 * awaited before the step returns.
	 */
	async step(name: string, body: () => Promise<void>, timeoutMs = 120_000, options: { always?: boolean } = {}): Promise<void> {
		if (!options.always && this.#only !== undefined && !name.toLowerCase().includes(this.#only)) {
			console.log(`     (${name}: skipped by E2E_ONLY=${process.env.E2E_ONLY})`);
			return;
		}
		const step: StepScope = { name };
		this.#steps.push(name);
		const started = Date.now();
		const run = scope.run(step, body).then(
			() => undefined,
			(error: unknown) => (error instanceof Error ? error : new Error(String(error))),
		);
		const timeout = Promise.withResolvers<"timeout">();
		const timer = setTimeout(() => timeout.resolve("timeout"), timeoutMs);
		let failure = await Promise.race([run, timeout.promise]);
		clearTimeout(timer);
		if (failure === "timeout") {
			step.aborted = new Error(`step timed out after ${timeoutMs / 1000} s`);
			await Promise.all([...open].map(session => session.stop()));
			const unwound = await Promise.race([run.then(() => true), Bun.sleep(UNWIND_MS).then(() => false)]);
			failure = unwound ? step.aborted : new Error(`${step.aborted.message}; its body did not stop within ${UNWIND_MS / 1000} s more`);
		}
		await Promise.all([...open].map(session => session.stop()));
		open.clear();
		if (failure) this.#record(name, "step completed", false, failure.message);
		console.log(`     (${name}: ${((Date.now() - started) / 1000).toFixed(1)} s)`);
	}

	check(name: string, ok: boolean, detail = ""): void {
		const step = scope.getStore();
		// A body that outlived its step must not report into the next one.
		if (step?.aborted) throw step.aborted;
		this.#record(step?.name ?? "harness", name, ok, detail);
	}

	/**
	 * A check of a state something asynchronous brings about (a file omp writes after the frame that announced it):
	 * waits for it up to `timeoutMs` and records whether it came.
	 */
	async eventually(name: string, holds: () => boolean, detail: () => string = () => "", timeoutMs = 20_000): Promise<void> {
		const ok = await until(() => (holds() ? true : undefined), timeoutMs, name).catch((error: unknown) => {
			if (scope.getStore()?.aborted) throw error;
			return false;
		});
		this.check(name, ok, detail());
	}

	#record(step: string, name: string, ok: boolean, detail: string): void {
		this.#checks++;
		const full = `${step} › ${name}`;
		console.log(`${ok ? "PASS" : "FAIL"} ${full}${detail ? ` — ${detail}` : ""}`);
		if (!ok) this.#failed.push(full);
	}

	/** A check that could not run counts as a failure: a green run means every check ran. */
	skip(name: string, why: string): void {
		this.check(name, false, `SKIP: ${why}`);
	}

	/** Prints the summary, removes the work dir after a green run and returns the exit code. */
	finish(): number {
		const failed = this.#failed.length;
		const seconds = ((Date.now() - this.#started) / 1000).toFixed(1);
		console.log(`\n${this.name}: ${this.#steps.length} scenarios, ${this.#checks} checks, ${this.#checks - failed} passed, ${failed} failed, ${seconds} s`);
		for (const name of this.#failed) console.log(`  FAILED ${name}`);
		if (failed > 0 || process.env.E2E_KEEP) console.log(`work dir kept: ${this.env.work} (omp stderr and frames in logs/, model requests in llm.jsonl)`);
		else rmSync(this.env.work, { recursive: true, force: true });
		return failed === 0 ? 0 : 1;
	}
}

// ── model request log ───────────────────────────────────────────────────────────────────

export function readJsonl<T>(file: string): T[] {
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf8")
		.split("\n")
		.filter(Boolean)
		.map(line => JSON.parse(line) as T);
}

/** The model requests made since the cursor was taken. */
export class LlmCursor {
	readonly #from: number;
	constructor(private readonly env: E2eEnv) {
		this.#from = readJsonl(env.llmLog).length;
	}
	all(): LlmEntry[] {
		return readJsonl<LlmEntry>(this.env.llmLog).slice(this.#from);
	}
	of(who: LlmEntry["who"]): LlmEntry[] {
		return this.all().filter(entry => entry.who === who);
	}
}

// ── RPC driver ──────────────────────────────────────────────────────────────────────────

/** A select dialog Storm opened, and what the driver answered (undefined: cancelled). */
export interface Dialog {
	title: string;
	options: string[];
	answer: string | undefined;
}
export type Answer = (dialog: { title: string; options: string[] }) => string | undefined;

export const cancelAll: Answer = () => undefined;
/** Rich hub rows carry a description in RPC labels; the RPC reply must use the exact offered option. */
export function hubLabel(option: string | undefined, label: string): boolean {
	return option === label || option?.startsWith(`${label} — `) === true;
}

/** Picks the first matching label and cancels every other dialog. */
export const choose =
	(...labels: string[]): Answer =>
	dialog => {
		for (const label of labels) {
			const option = dialog.options.find(value => dialog.title === "Storm 메뉴" ? hubLabel(value, label) : value === label);
			if (option !== undefined) return option;
		}
		return undefined;
	};

/** The native `/storm auto` switch labels; a scenario counting dialogs must not count a fixture's own approvals. */
export const AUTO_ON_LABEL = "자동 위임 켜기";
export const AUTO_OFF_LABEL = "자동 위임 끄기";

/**
 * Deliberate per-session fixture: approves the recommended team in THIS native session, so a scenario that needs an
 * approved team does not depend on another session's files. Returns the dialogs it answered and removes them from
 * `rpc.dialogs`, which then holds only what the scenario itself asked. Automatic delegation starts on with the first
 * approval, so `auto: "off"` switches it off through the real command.
 */
export async function approveTeam(rpc: Rpc, auto: "on" | "off" = "off"): Promise<Dialog[]> {
	const from = rpc.dialogs.length;
	const answer = rpc.answer;
	try {
		rpc.answer = choose(APPROVE);
		await rpc.prompt("/storm");
		if (auto === "off") {
			rpc.answer = choose(AUTO_OFF_LABEL);
			await rpc.prompt("/storm auto");
		}
		return rpc.dialogs.slice(from);
	} finally {
		rpc.dialogs.splice(from);
		rpc.answer = answer;
	}
}

let launches = 0;

export interface SessionOptions {
	model: string;
	/** Extra omp flags. */
	flags?: string[];
	/** Native session id to open; absent starts a new session. */
	resume?: string;
	/** Native transcript directory; absent uses a fresh one below the work dir. */
	sessionDir?: string;
	/** Host-only probes: keep the session in memory (`--no-session`), so ephemeral artifact lifetime is unchanged. */
	ephemeral?: boolean;
	/** PTY columns; only the interactive driver reads it. */
	columns?: number;
	/** PTY rows; only the interactive driver reads it. */
	rows?: number;
	/** Terminal background the PTY reports in its OSC 11 reply; default dark, as the harness always did. */
	background?: "dark" | "light";
}

const isSettled = (frame: Frame): boolean => frame.type === "session_settled" || (frame.type === "prompt_result" && frame.sessionSettled === true);

/** What `get_state` says about the native session this process owns. */
export interface HostSession {
	sessionId: string;
	sessionFile?: string;
	messageCount?: number;
}

export class Rpc {
	readonly frames: Frame[] = [];
	readonly dialogs: Dialog[] = [];
	/** The native transcript directory this process was started with; a resume needs the same one. */
	readonly sessionDir: string;
	readonly #proc: Subprocess<"pipe", "pipe", BunFile>;
	readonly #log: string;
	#seq = 0;
	#session: HostSession | undefined;

	/** Answers the select dialogs; replace it between prompts to answer the next ones differently. */
	answer: Answer;

	constructor(env: E2eEnv, answer: Answer, options: SessionOptions) {
		this.answer = answer;
		const tag = `rpc-${String(++launches).padStart(3, "0")}`;
		this.#log = join(env.logs, `${tag}.frames.jsonl`);
		this.sessionDir = options.sessionDir ?? join(env.sessionRoot, tag);
		mkdirSync(this.sessionDir, { recursive: true });
		const args = [env.omp, "--mode", "rpc", ...sessionArgs(env, options, this.sessionDir)];
		appendFileSync(join(env.logs, "launches.log"), `${tag} ${args.slice(1).join(" ")}\n`);
		this.#proc = Bun.spawn(args, { cwd: env.project, env: env.childEnv, stdin: "pipe", stdout: "pipe", stderr: Bun.file(join(env.logs, `${tag}.stderr.log`)) });
		open.add(this);
		void this.#pump();
	}

	/** The host's own id for this process's session; available after `ready()`. */
	get sessionId(): string {
		if (this.#session === undefined) throw new Error("the rpc session has not been identified: await ready() first");
		return this.#session.sessionId;
	}

	get sessionFile(): string | undefined {
		return this.#session?.sessionFile;
	}

	/** The omp process id: what its profile log records carry as `pid`. */
	get pid(): number {
		return this.#proc.pid;
	}

	/** Reads the native session identity through the host's public `get_state`, never by guessing a file name. */
	async identify(): Promise<HostSession> {
		const from = this.frames.length;
		const id = this.send({ type: "get_state" });
		const frame = await until(
			() => this.frames.slice(from).find(candidate => candidate.type === "response" && candidate.id === id && candidate.command === "get_state"),
			20_000,
			"get_state",
		);
		const sessionId = frame.data?.sessionId;
		if (frame.success !== true || typeof sessionId !== "string" || sessionId.trim() === "") throw new Error(`get_state gave no session id: ${JSON.stringify(frame).slice(0, 300)}`);
		const session: HostSession = { sessionId };
		if (typeof frame.data?.sessionFile === "string") session.sessionFile = frame.data.sessionFile;
		if (typeof frame.data?.messageCount === "number") session.messageCount = frame.data.messageCount;
		this.#session = session;
		return session;
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
				let frame: Frame;
				try {
					frame = JSON.parse(line) as Frame;
				} catch {
					continue;
				}
				this.frames.push(frame);
				appendFileSync(this.#log, `${line}\n`);
				if (frame.type !== "extension_ui_request") continue;
				// Only dialogs wait for an answer; notices and status updates do not.
				if (!["select", "confirm", "input", "editor", "ask"].includes(String(frame.method))) continue;
				let value: string | undefined;
				if (frame.method === "select") {
					const dialog = { title: String(frame.title), options: frame.options ?? [] };
					value = this.answer(dialog);
					this.dialogs.push({ ...dialog, answer: value });
				}
				this.send(value === undefined ? { type: "extension_ui_response", id: frame.id, cancelled: true } : { type: "extension_ui_response", id: frame.id, value });
			}
		}
	}

	send(command: Record<string, unknown>): string {
		const id = typeof command.id === "string" ? command.id : `c${++this.#seq}`;
		this.#proc.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
		this.#proc.stdin.flush();
		return id;
	}

	async ready(): Promise<void> {
		await until(() => this.frames.find(frame => frame.type === "ready"), 40_000, "rpc ready");
		await this.identify();
	}

	/** Sends a prompt and waits until omp has handled it (a slash command has run; a model turn has been accepted). */
	async prompt(message: string, timeoutMs = 60_000): Promise<Frame[]> {
		const from = this.frames.length;
		const id = this.send({ type: "prompt", message });
		await until(() => this.frames.slice(from).find(frame => frame.type === "prompt_result" && frame.id === id), timeoutMs, `prompt_result of ${message.slice(0, 40)}`);
		return this.frames.slice(from);
	}

	/** Sends a prompt and waits until omp reports the session settled: the turn and what it started asynchronously are over. */
	async turn(message: string, timeoutMs = 90_000): Promise<Frame[]> {
		const from = this.frames.length;
		this.send({ type: "prompt", message });
		await until(() => (this.frames.slice(from).some(isSettled) ? true : undefined), timeoutMs, `the session to settle after ${message.slice(0, 40)}`);
		return this.frames.slice(from);
	}

	/** Notices Storm showed since `from`, as `[level, message]`. */
	notices(from = 0): Array<[string, string]> {
		return this.frames
			.slice(from)
			.filter(frame => frame.type === "extension_ui_request" && frame.method === "notify")
			.map(frame => [String(frame.notifyType ?? "info"), String(frame.message)]);
	}

	async stop(): Promise<void> {
		open.delete(this);
		this.#proc.kill("SIGKILL");
		await this.#proc.exited;
	}

	async close(): Promise<number> {
		open.delete(this);
		this.#proc.stdin.end();
		const exited = await Promise.race([this.#proc.exited.then(() => true), Bun.sleep(5_000).then(() => false)]);
		if (!exited) this.#proc.kill();
		return this.#proc.exited;
	}
}

/** Role models every session starts with: the fake provider only, so no agent ever asks for a real model. */
function sessionArgs(env: E2eEnv, options: SessionOptions, sessionDir: string): string[] {
	return [
		"--profile",
		env.profile,
		"--session-dir",
		sessionDir,
		...(options.ephemeral ? ["--no-session"] : []),
		...(options.resume === undefined ? [] : ["--resume", options.resume]),
		"--no-title",
		"--auto-approve",
		"--model",
		options.model,
		"--smol",
		"fake/cheap-a",
		"--slow",
		"fake/general-b",
		"--plan",
		"fake/general-b",
		...(options.flags ?? []),
	];
}

// ── pty driver ──────────────────────────────────────────────────────────────────────────

const ANSI = /\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[PX^_][^\x1b]*\x1b\\|\x1b[@-Z\\-_]/g;

export const KEY = { enter: "\r", down: "\x1b[B", right: "\x1b[C", tab: "\t", killLine: "\x0b" } as const;
/** Key hints under omp's selector, first and last; the box above them holds one option per row. */
const SELECTOR_HINT = "navigate  ⏎ select";
const SELECTOR_HINT_END = "cancel";
/** The marker in front of the row that has the focus, in selectors and forms. */
const FOCUS = "❯";
/** The provider sign-in picker of a profile without `setupVersion`; Enter there would start a real login. */
const SIGN_IN = "Select provider to login";

/** Screen rows without box edges and runs of spaces. */
function rows(text: string): string[] {
	return text.split("\n").map(row => row.replace(/[│█]/g, " ").replace(/\s+/g, " ").trim());
}

/** The label of the row that got the focus in `text` (what a key repainted), if any. */
export function focused(text: string): string | undefined {
	return rows(text)
		.findLast(row => row.startsWith(`${FOCUS} `))
		?.slice(FOCUS.length + 1);
}

/**
 * Storm's status row as the screen shows it now: the lowest row of the visible screen that begins with Storm's mark
 * (`≋ STORM`, `~ STORM` in an ASCII preset). Idle it is the footer, in a run the live widget's first row. Read from the
 * screen because omp 19.2 paints by diff: the row is written when it changes and not again, so no later byte
 * stream holds it. Report headings (`≋ STORM · 대기 · v0.25.0` at the top of a report) are not the footer.
 */
export function statusLine(tui: Pick<Tui, "screen">): string | undefined {
	return tui
		.screen()
		.viewport.map(row => row.trim())
		.findLast(row => (row.startsWith("storm") || row.startsWith(STORM_MARK) || row.startsWith(STORM_MARK_ASCII)) && !/ · v\d+\.\d+\.\d+/.test(row));
}

const STORM_MARK_ASCII = "~ STORM";

/** A selector box found on a screen: its title row and its options, top to bottom, the focus marker removed. */
export interface SelectorBox {
	title: string;
	options: string[];
}

/**
 * omp's selector on `viewport`: a box (`╭─ title ──╮` … `╰──╯`) whose last row before the bottom edge is the key hint
 * (`↑/↓ navigate  ⏎ select  ⎋ cancel`). The lowest such box is the one that takes keys. `accept` can refuse a title.
 */
export function selectorOn(viewport: readonly string[], accept: (title: string) => boolean = () => true): SelectorBox | undefined {
	const hint = viewport.findLastIndex(row => row.includes(SELECTOR_HINT) && row.includes(SELECTOR_HINT_END));
	if (hint < 0) return undefined;
	const top = viewport.slice(0, hint).findLastIndex(row => row.startsWith("╭─"));
	if (top < 0) return undefined;
	const title = (/^╭─\s*(.*?)\s*─+╮?\s*$/u.exec(viewport[top]!)?.[1] ?? "").trim();
	if (!accept(title)) return undefined;
	const options = rows(viewport.slice(top + 1, hint).join("\n"))
		.map(row => row.replace(FOCUS, "").trim())
		.filter(Boolean);
	return options.length > 0 ? { title, options } : undefined;
}

/** The interactive TUI on a pty. Answers the terminal queries (DA1, OSC 11) the TUI waits for before it renders. */
export class Tui {
	raw = "";
	columns: number;
	rows: number;
	/** The background this PTY reports over OSC 11; omp maps it to its light or dark theme. */
	readonly background: "dark" | "light";
	readonly #proc: Subprocess;
	readonly #log: string;
	/** Native transcript directory: unique per interactive process unless the caller resumes one. */
	readonly sessionDir: string;
	#sessionId: string | undefined;
	readonly #agentDir: string;
	/** The terminal as a person sees it now, kept up to date with every chunk the host writes. */
	#screen: Screen;

	constructor(env: E2eEnv, options: SessionOptions) {
		const tag = `tui-${String(++launches).padStart(3, "0")}`;
		this.#log = join(env.logs, `${tag}.screen.log`);
		this.#agentDir = env.agentDir;
		this.sessionDir = options.sessionDir ?? join(env.sessionRoot, tag);
		mkdirSync(this.sessionDir, { recursive: true });
		this.columns = options.columns ?? 160;
		this.rows = options.rows ?? 50;
		this.background = options.background ?? "dark";
		this.#screen = new Screen(this.columns, this.rows);
		const decoder = new TextDecoder();
		const args = [env.omp, ...sessionArgs(env, options, this.sessionDir)];
		appendFileSync(join(env.logs, "launches.log"), `${tag} ${args.slice(1).join(" ")}\n`);
		this.#proc = Bun.spawn(args, {
			cwd: env.project,
			env: env.childEnv,
			terminal: {
				cols: this.columns,
				rows: this.rows,
				data: (terminal, data) => {
					const text = decoder.decode(data, { stream: true });
					this.raw += text;
					this.#screen.write(text);
					appendFileSync(this.#log, text);
					if (text.includes("\x1b[c")) terminal.write("\x1b[?62;22c");
					if (text.includes("\x1b]11;?")) terminal.write(`\x1b]11;${this.background === "light" ? "rgb:ffff/ffff/ffff" : "rgb:1e1e/1e1e/1e1e"}\x1b\\`);
				},
			},
		});
		open.add(this);
	}

	/**
	 * Resizes the pty. The host answers the signal with a full repaint, which the emulator must see from a blank grid, so
	 * the screen starts over at the new size (what scrolled off before is not kept).
	 */
	resize(columns: number, rows: number): void {
		this.columns = columns;
		this.rows = rows;
		this.#screen = new Screen(columns, rows);
		this.#proc.terminal?.resize(columns, rows);
	}

	/** What was printed after raw offset `from`, without escape sequences: the rows the TUI repainted since. */
	text(from = 0): string {
		// OMP also rings the bell (BEL) when it wants attention (a finished turn, an ask); it is not a painted cell.
		return this.raw.slice(from).replace(ANSI, "").replace(/\x07/g, "").replace(/\r/g, "\n");
	}

	/**
	 * The terminal as a person sees it now: `viewport` is the screen, `scrollback` the rows that scrolled off its top.
	 * omp 19.2 paints by diff, so a row that did not change is never written again: whatever must be judged as "on the
	 * screen" (the composer, an open dialog, a form's focus, a live widget) is read here, not from `text()`.
	 * `text(from)` stays the answer to "what was painted since".
	 */
	screen(): { viewport: string[]; scrollback: string[] } {
		return { viewport: this.#screen.viewport(), scrollback: this.#screen.scrollback() };
	}

	/** Every row a person could read by scrolling: the scrollback, then the screen. */
	history(): string[] {
		return this.#screen.all();
	}

	/** The visible screen as one text, empty rows at the bottom cut. */
	screenText(): string {
		return this.#screen.text();
	}

	/** Waits until what was printed after raw offset `from` satisfies `probe`, and returns what it gave. */
	seen<T>(from: number, probe: (text: string) => T | undefined, label: string, timeoutMs = 60_000): Promise<T> {
		return until(() => probe(this.text(from)), timeoutMs, label);
	}

	/** Waits until `needle` has been printed after raw offset `from`. */
	async shows(needle: string | RegExp, from = 0, timeoutMs = 60_000): Promise<void> {
		// `search` ignores a global pattern's position, `test` would not.
		await this.seen(from, text => ((typeof needle === "string" ? text.includes(needle) : text.search(needle) >= 0) ? true : undefined), `the screen to show ${String(needle)}`, timeoutMs);
	}

	/** The host's own id, learned from the session path it registered for this terminal; available after `ready()`. */
	get sessionId(): string {
		if (this.#sessionId === undefined) throw new Error("the TUI session has not been identified: await ready() first");
		return this.#sessionId;
	}

	/**
	 * The interactive host has no `get_state` line, so its native session is identified by the file it registers for
	 * this terminal (the explicit `--session-dir` makes the directory ours). A process that has already written its
	 * JSONL is read from there as well; both paths carry the host-minted id in the file name.
	 */
	async #identifySession(): Promise<string> {
		return until(
			() => {
				const registry = join(this.#agentDir, "terminal-sessions");
				if (existsSync(registry)) {
					for (const name of readdirSync(registry)) {
						const registered = readFileSync(join(registry, name), "utf8")
							.split("\n")
							.find(line => line.startsWith(this.sessionDir));
						const id = registered === undefined ? undefined : /_([A-Za-z0-9_-]+)\.jsonl$/.exec(basename(registered))?.[1];
						if (id !== undefined) return id;
					}
				}
				for (const name of existsSync(this.sessionDir) ? readdirSync(this.sessionDir) : []) {
					const id = /_([A-Za-z0-9_-]+)\.jsonl$/.exec(name)?.[1];
					if (id !== undefined) return id;
				}
				return undefined;
			},
			40_000,
			"the host to register this TUI session",
		);
	}

	/**
	 * The interactive terminal is ready when the composer is on the screen: a row that begins with its box bottom
	 * (`╰─`, `+-` in an ASCII preset). It is read from the screen, not the byte stream: omp paints by diff, so the
	 * row is written once, with the key hint behind it, and never alone. The next typed command still has to prove
	 * itself on screen: every caller waits for the actual dialog or report.
	 */
	async ready(): Promise<void> {
		await until(() => (this.#screen.viewport().some(row => row.startsWith("╰─") || row.startsWith("+-")) ? true : undefined), 90_000, "the interactive composer");
		this.#sessionId = await this.#identifySession();
	}

	/**
	 * Writes one key and waits for the repaint it must cause (`effect`, over what was printed after the key), so the
	 * next key is never sent before omp took this one. Returns the raw offset at the key.
	 */
	async press(key: string, effect: (text: string) => boolean, label: string, timeoutMs = 60_000): Promise<number> {
		const mark = this.raw.length;
		this.#proc.terminal?.write(key);
		await this.seen(mark, text => (effect(text) ? true : undefined), label, timeoutMs);
		return mark;
	}

	/** Writes a key whose effect the caller waits for (a dialog opening, a file); returns the raw offset at the key. */
	send(key: string): number {
		const mark = this.raw.length;
		this.#proc.terminal?.write(key);
		return mark;
	}

	/** The composer's text as drawn now: its box row (`╰─ …`) and the continuation rows indented under it. */
	composerText(): string {
		const viewport = this.#screen.viewport();
		const at = viewport.findLastIndex(row => row.startsWith("╰─") || row.startsWith("+-"));
		if (at < 0) return "";
		const rows = [viewport[at]!.slice(2)];
		for (let next = at + 1; next < viewport.length && viewport[next]!.startsWith("   "); next++) rows.push(viewport[next]!);
		return rows.join("").replace(/\s+/g, "");
	}

	/**
	 * Types a line into the composer, waits until the composer shows it, and submits it; returns the raw offset at the
	 * Enter. A long line arrives as a paste, and omp 19.2 may take an Enter that follows a paste at once as part of it,
	 * so the line is let settle first, and an Enter that left the line in the composer is sent once more.
	 */
	async submit(line: string): Promise<number> {
		const squash = (text: string): string => text.replace(/[\s│╭╮╰╯─]/g, "");
		// A long line wraps, so its end is what to look for.
		const end = squash(line).slice(-12);
		await this.press(line, text => squash(text).includes(end), `the composer to show ${line.slice(0, 30)}`);
		if (this.text().includes(SIGN_IN)) throw new Error("the provider sign-in picker is open: refusing to press Enter");
		// A long line is a paste: let it settle (nothing written for a moment; a live widget keeps painting, so bounded).
		let quiet = this.raw.length;
		let since = Date.now();
		const give = Date.now() + (line.length > 200 ? 1_500 : 0);
		while (Date.now() - since < 250 && Date.now() < give) {
			await Bun.sleep(50);
			if (this.raw.length !== quiet) {
				quiet = this.raw.length;
				since = Date.now();
			}
		}
		const mark = this.send(KEY.enter);
		// The line left the composer, or Enter was taken as part of the paste: then once more.
		if (line.length > 200) {
			const left = (): boolean => !this.composerText().includes(end);
			const deadline = Date.now() + 3_000;
			while (!left() && Date.now() < deadline) await Bun.sleep(50);
			if (!left()) this.send(KEY.enter);
		}
		return mark;
	}

	/**
	 * The options of omp's selector on the screen, top to bottom, once its box is drawn down to the key hints. The
	 * first option has the focus, and a selector that is drawn takes keys. Only a selector whose title was painted
	 * after raw offset `from` counts, so the dialog a key just closed is never mistaken for the next one.
	 */
	selector(from: number, timeoutMs = 90_000): Promise<string[]> {
		return until(
			() => {
				const painted = this.text(from);
				return selectorOn(this.#screen.viewport(), title => painted.includes(title))?.options;
			},
			timeoutMs,
			"a selector",
		);
	}

	/**
	 * Moves the focus of a just-opened selector from its first option down to `label`, one key per repaint, and
	 * confirms; returns the raw offset at the Enter.
	 */
	async pick(options: readonly string[], label: string): Promise<number> {
		const at = options.indexOf(label);
		if (at < 0) throw new Error(`the selector does not offer ${label}: ${options.join(", ")}`);
		for (let i = 1; i <= at; i++) {
			await this.press(KEY.down, text => focused(text) === options[i], `the selector's focus to reach ${options[i]}`);
		}
		return this.send(KEY.enter);
	}

	async stop(): Promise<void> {
		this.#proc.kill("SIGKILL");
		await this.#proc.exited;
	}

	/** Ends the session: omp exits on SIGTERM. */
	async close(): Promise<void> {
		open.delete(this);
		this.#proc.kill();
		const exited = await Promise.race([this.#proc.exited.then(() => true), Bun.sleep(10_000).then(() => false)]);
		if (!exited) await this.stop();
	}
}

// ── what Storm writes ───────────────────────────────────────────────────────────────────

/**
 * Readers of what one native session owns. Everything Storm persists lives under
 * `<agentDir>/storm/sessions/<sha256(sessionId)>`: config at the top, run state under `state/`, automatic delegation
 * beside the config, approvals under `approvals/<targetKey>/`. Nothing here is read from or written to the target
 * worktree, and two sessions in the same checkout have unrelated readers.
 */
export class StormFiles {
	readonly sessionId: string;
	/** `<agentDir>/storm/sessions/<full sha256 id>`, the one Storm-owned directory for this session. */
	readonly sessionDir: string;
	readonly configFile: string;
	/** `join(sessionDir, "auto-delegation.json")`, not inside a target's approval directory. */
	readonly autoFile: string;
	readonly stateDir: string;
	readonly indexFile: string;
	readonly approvalsRoot: string;

	constructor(env: E2eEnv, sessionId: string) {
		this.sessionId = sessionId;
		this.sessionDir = sessionStoreDir(env.agentDir, sessionId);
		this.configFile = join(this.sessionDir, "config.json");
		this.autoFile = join(this.sessionDir, "auto-delegation.json");
		this.stateDir = join(this.sessionDir, "state");
		this.indexFile = join(this.stateDir, "runs", "index.jsonl");
		this.approvalsRoot = join(this.sessionDir, "approvals");
	}

	config(): StormConfig {
		return JSON.parse(readFileSync(this.configFile, "utf8")) as StormConfig;
	}

	/** Rewrites this session's config by hand: the result is unapproved until Storm is asked again. */
	editConfig(change: (config: StormConfig) => void): void {
		const config = this.config();
		change(config);
		writeFileSync(this.configFile, `${JSON.stringify(config, null, 2)}\n`);
	}

	configBytes(): string | null {
		return existsSync(this.configFile) ? new Bun.CryptoHasher("sha256").update(readFileSync(this.configFile)).digest("hex") : null;
	}

	/** Every canonical target this session approved something for; normally exactly one. */
	storeDirs(): string[] {
		return existsSync(this.approvalsRoot) ? readdirSync(this.approvalsRoot, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => join(this.approvalsRoot, entry.name)) : [];
	}

	/** This session's approval store for the current target; undefined before the first approval. */
	storeDir(): string | undefined {
		return this.storeDirs()[0];
	}

	approvals(): string[] {
		const dir = this.storeDir();
		return dir && existsSync(join(dir, "approved")) ? readdirSync(join(dir, "approved")) : [];
	}

	/** `<sessionDir>/state/runs.jsonl`: the trusted run list the janitor reads. */
	trustedFile(): string {
		return join(this.stateDir, "runs.jsonl");
	}

	/** Run records, oldest first (run ids sort by start time). */
	runs(): RunRecord[] {
		const dir = join(this.stateDir, "runs");
		if (!existsSync(dir)) return [];
		return readdirSync(dir)
			.filter(file => file.startsWith("run-") && file.endsWith(".json"))
			.sort()
			.map(file => JSON.parse(readFileSync(join(dir, file), "utf8")) as RunRecord);
	}

	run(runId: string): RunRecord | undefined {
		return this.runs().find(run => run.runId === runId);
	}

	index(): RunSummary[] {
		return readJsonl<RunSummary>(this.indexFile);
	}

	/**
	 * Waits for a run that is not in `before` to end, and returns its final record. Storm writes the index line last
	 * (after the trusted list, the cleanup and the record), so with it everything a run end writes is on disk.
	 */
	finishedRun(before: ReadonlySet<string>, timeoutMs = 120_000): Promise<RunRecord> {
		return until(
			() => {
				const run = this.runs().find(candidate => !before.has(candidate.runId) && candidate.status !== "running" && candidate.endedAt !== undefined);
				return run && this.index().some(line => line.runId === run.runId) ? run : undefined;
			},
			timeoutMs,
			"a new run to end",
		);
	}

	runIds(): Set<string> {
		return new Set(this.runs().map(run => run.runId));
	}
}

/** `provider/id[:effort]` → the id the provider is asked for. */
export function modelId(entry: string | undefined): string | undefined {
	if (entry === undefined) return undefined;
	const selector = entry.replace(/:(?:minimal|low|medium|high|xhigh|max)$/, "");
	return selector.slice(selector.indexOf("/") + 1);
}
