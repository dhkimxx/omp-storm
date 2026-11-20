#!/usr/bin/env bun
/**
 * OMP Storm P0 spike driver: runs omp in RPC mode against fake-llm.ts, one fresh session per
 * scenario, and prints one JSON line per scenario (also appended to $SPIKE_WORK/results.jsonl).
 *
 * Usage: bun run.ts setup | bun run.ts <scenario...> | bun run.ts all | bun run.ts cleanup
 * Needs fake-llm.ts running with FAKE_LLM_LOG=$SPIKE_WORK/llm.jsonl.
 * Env: OMP_BIN (~/.local/bin/omp), SPIKE_PROFILE (storm-p0), SPIKE_WORK (/tmp/storm-p0), FAKE_LLM_PORT (18555).
 */
import type { Subprocess } from "bun";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type Frame = { type?: string; [key: string]: unknown };
type ExtEntry = { kind: string; [key: string]: unknown };
interface LlmEntry {
	model: string;
	tools: string[];
	lastRole?: string;
	marks: Record<string, string[]>;
	notices: Record<string, string[]>;
	roles: string[];
	taskToolAgents: string[];
	/** SPIKE-* directives found anywhere in user-role text. */
	spike: string[];
	/** A spawned child's request (its assignment carries the child mark). */
	child: boolean;
	users: string[];
	decision: { tool?: string; text?: string; slow?: boolean };
}

const OMP = process.env.OMP_BIN ?? join(homedir(), ".local/bin/omp");
const PROFILE = process.env.SPIKE_PROFILE ?? "storm-p0";
const WORK = process.env.SPIKE_WORK ?? "/tmp/storm-p0";
const PORT = Number(process.env.FAKE_LLM_PORT ?? 18555);
const PLUGIN = join(import.meta.dir, "plugin");
const PROJECT = join(WORK, "project");
const LLM_LOG = join(WORK, "llm.jsonl");
const EXT_LOG = join(WORK, "ext.jsonl");
const POLICY = join(WORK, "policy.json");
const OVERLAY = join(WORK, "overlay.yml");
const RESULTS = join(WORK, "results.jsonl");
const PROFILE_ROOT = join(homedir(), ".omp", "profiles", PROFILE);
const FAKE = "fake/main";
const baseArgs = (model = FAKE) => ["--no-session", "--no-title", "--auto-approve", "--model", model, "--smol", model, "--slow", model, "--plan", model];
const ENV = { ...process.env, STORM_SPIKE_LOG: EXT_LOG, STORM_SPIKE_POLICY: POLICY };
const ROUTE_POLICY = {
	agents: {
		"storm-implementer": { model: ["fake/approved-a", "fake/approved-b"] },
		"storm-reviewer": { block: true, reason: "storm: storm-reviewer is not approved" },
	},
};
const MODELS_YML = `providers:
  fake:
    baseUrl: http://127.0.0.1:${PORT}/v1
    apiKey: storm-spike-dummy
    api: openai-completions
    models:
${["main", "approved-a", "approved-b", "override-x"].map(id => `      - id: ${id}\n        contextWindow: 128000\n        maxTokens: 4096`).join("\n")}
      - id: priced
        contextWindow: 128000
        maxTokens: 4096
        cost: { input: 1000, output: 1000, cacheRead: 0, cacheWrite: 0 }
`;

const readJsonl = <T>(path: string): T[] =>
	existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as T) : [];
const b64 = (text: string) => `b64:${Buffer.from(text).toString("base64")}`;

/** Log offsets taken when a scenario starts, so it only sees its own entries. */
class Cursor {
	readonly #llm = readJsonl(LLM_LOG).length;
	readonly #ext = readJsonl(EXT_LOG).length;
	llm(): LlmEntry[] {
		return readJsonl<LlmEntry>(LLM_LOG).slice(this.#llm);
	}
	ext(kind?: string): ExtEntry[] {
		const entries = readJsonl<ExtEntry>(EXT_LOG).slice(this.#ext);
		return kind ? entries.filter(entry => entry.kind === kind) : entries;
	}
}

async function until<T>(probe: () => T | undefined, timeoutMs: number, label: string): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = probe();
		if (value !== undefined) return value;
		if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
		await Bun.sleep(150);
	}
}

class Rpc {
	readonly frames: Frame[] = [];
	readonly stderr: string[] = [];
	readonly #proc: Subprocess<"pipe", "pipe", "pipe">;
	#seq = 0;

	constructor(
		args: string[],
		readonly answer: (request: Frame) => Frame | undefined,
		model = FAKE,
	) {
		this.#proc = Bun.spawn([OMP, "--profile", PROFILE, "--mode", "rpc", ...baseArgs(model), ...args], {
			cwd: PROJECT,
			env: ENV,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		void this.#pump();
		void (async () => {
			const decoder = new TextDecoder();
			for await (const chunk of this.#proc.stderr) this.stderr.push(decoder.decode(chunk));
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
				let frame: Frame;
				try {
					frame = JSON.parse(line) as Frame;
				} catch {
					continue;
				}
				this.frames.push(frame);
				if (frame.type === "extension_ui_request")
					this.send(this.answer(frame) ?? { type: "extension_ui_response", id: frame.id, cancelled: true });
			}
		}
	}

	send(command: Frame): void {
		const id = typeof command.id === "string" ? command.id : `c${++this.#seq}`;
		this.#proc.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
		this.#proc.stdin.flush();
	}

	find(match: (frame: Frame) => boolean, from = 0): Frame | undefined {
		return this.frames.slice(from).find(match);
	}

	settle(from: number, timeoutMs = 60_000): Promise<Frame> {
		return until(
			() => this.find(f => f.type === "session_settled" || (f.type === "prompt_result" && f.sessionSettled === true), from),
			timeoutMs,
			"session settle",
		);
	}

	async close(): Promise<void> {
		this.#proc.stdin.end();
		const exited = await Promise.race([this.#proc.exited.then(() => true), Bun.sleep(5_000).then(() => false)]);
		if (!exited) this.#proc.kill();
		await this.#proc.exited;
	}
}

const approveAll = (request: Frame): Frame | undefined => {
	if (request.method === "select") return { type: "extension_ui_response", id: request.id, value: "승인" };
	if (request.method === "confirm") return { type: "extension_ui_response", id: request.id, confirmed: true };
	return undefined;
};

async function session<T extends object>(args: string[], body: (rpc: Rpc) => Promise<T>, answer = approveAll, model = FAKE): Promise<T> {
	const rpc = new Rpc(args, answer, model);
	try {
		await until(() => rpc.find(f => f.type === "ready"), 30_000, "rpc ready");
		return await body(rpc);
	} catch (error) {
		throw new Error(`${String(error)} | stderr: ${rpc.stderr.join("").slice(-800)}`);
	} finally {
		await rpc.close();
	}
}

function resultText(frame: Frame): string {
	const result = frame.result as { content?: Array<{ text?: string }> } | undefined;
	return (result?.content ?? []).map(part => part.text ?? "").join("\n").slice(0, 600);
}

// ── Q1: does sendUserMessage carry magic keyword notices? ────────────────────────────────

async function q1Prompt(label: string, message: (mark: string) => string) {
	const cursor = new Cursor();
	const mark = `SPIKE-MARK ${label}`;
	return session(["-e", PLUGIN], async rpc => {
		const from = rpc.frames.length;
		rpc.send({ type: "prompt", message: message(mark) });
		const hit = await until(() => cursor.llm().find(entry => entry.marks[mark]), 30_000, mark);
		await rpc.settle(from);
		return { delivered: true, markAt: hit.marks[mark], notices: hit.notices };
	});
}

async function q1Streaming(mode: "auto" | "followUp" | "steer" | "deferred") {
	const cursor = new Cursor();
	const mark = `SPIKE-MARK q1-${mode}`;
	return session(["-e", PLUGIN], async rpc => {
		const from = rpc.frames.length;
		rpc.send({ type: "prompt", message: `/spike-arm ${mode} ${b64(`orchestrate ${mark}`)}` });
		await until(() => cursor.ext("arm")[0], 10_000, "arm");
		rpc.send({ type: "prompt", message: "SPIKE-SLOW warmup" });
		const fired = await until(() => cursor.ext("armed-fire")[0], 20_000, "armed fire");
		const hit = await until(() => cursor.llm().find(entry => entry.marks[mark]), 30_000, mark).catch(() => undefined);
		await rpc.settle(from).catch(() => undefined);
		await Bun.sleep(1_500);
		const entry = hit ?? cursor.llm().find(candidate => candidate.marks[mark]);
		return {
			armedFiredWhileIdle: fired.idle,
			sendIdle: cursor.ext("send")[0]?.idle ?? null,
			delivered: Boolean(entry),
			markAt: entry?.marks[mark] ?? null,
			notices: entry?.notices ?? null,
			sendErrors: cursor.ext("send-error"),
		};
	});
}

// ── Q2/Q3: spawn hook routing, blocking, precedence, discovery ───────────────────────────

async function spawnRun(policy: object, prompt: string, args: string[] = ["-e", PLUGIN]) {
	writeFileSync(POLICY, JSON.stringify(policy));
	const cursor = new Cursor();
	return session(args, async rpc => {
		const from = rpc.frames.length;
		rpc.send({ type: "prompt", message: prompt });
		const directive = prompt.split(" ")[0];
		await until(
			() => cursor.llm().find(entry => entry.lastRole === "tool" && entry.spike.includes(directive)),
			90_000,
			"main session tool result",
		);
		await rpc.settle(from).catch(() => undefined);
		await Bun.sleep(1_000);
		const llm = cursor.llm();
		const children = new Map<string, number>();
		for (const entry of llm.filter(candidate => candidate.child && candidate.tools.length > 0)) {
			const key = `${entry.model} roles=[${entry.roles.join(",")}]`;
			children.set(key, (children.get(key) ?? 0) + 1);
		}
		return {
			spawnEvents: cursor.ext("spawn").map(({ ts: _ts, kind: _kind, ...event }) => event),
			childRequests: Object.fromEntries(children),
			taskToolListsStormAgents: llm.find(entry => entry.taskToolAgents.length > 0)?.taskToolAgents ?? [],
			toolResults: rpc.frames
				.slice(from)
				.filter(frame => frame.type === "tool_execution_end" && (frame.toolName === "task" || frame.toolName === "eval"))
				.map(frame => ({ tool: frame.toolName, isError: frame.isError ?? false, text: resultText(frame) })),
		};
	});
}

function ompCli(args: string[]): { code: number; out: string } {
	const run = Bun.spawnSync([OMP, "--profile", PROFILE, ...args], { cwd: PROJECT, env: ENV });
	return { code: run.exitCode, out: `${run.stdout.toString()}${run.stderr.toString()}`.trim() };
}

const tail = ({ code, out }: { code: number; out: string }) => ({ code, out: out.slice(-700) });

async function q3Link() {
	const link = tail(ompCli(["plugin", "link", PLUGIN]));
	const list = ompCli(["plugin", "list", "--json"]);
	try {
		return { link, listed: list.out.includes("omp-storm-spike"), run: await spawnRun({}, "SPIKE-TASK storm-implementer", []) };
	} finally {
		const uninstall = tail(ompCli(["plugin", "uninstall", "omp-storm-spike"]));
		appendFileSync(RESULTS, `${JSON.stringify({ scenario: "q3-link-uninstall", ...uninstall })}\n`);
	}
}

async function q3Shadow() {
	const dir = join(PROJECT, ".omp", "agents");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "storm-implementer.md"), "---\nname: storm-implementer\ndescription: project shadow\n---\nSTORM-ROLE project-shadow. Reply with OK.\n");
	try {
		return await spawnRun({}, "SPIKE-TASK storm-implementer");
	} finally {
		rmSync(join(PROJECT, ".omp"), { recursive: true, force: true });
	}
}

// ── Q4: approval UI from inside tool execution ───────────────────────────────────────────

async function q4Rpc(extra: string[]) {
	const cursor = new Cursor();
	return session(["-e", PLUGIN, ...extra], async rpc => {
		const from = rpc.frames.length;
		rpc.send({ type: "prompt", message: "SPIKE-APPROVE" });
		await until(() => cursor.ext("ui")[0], 30_000, "ui probe");
		await rpc.settle(from).catch(() => undefined);
		return {
			uiRequests: rpc.frames.slice(from).filter(f => f.type === "extension_ui_request").map(f => f.method),
			probe: cursor.ext("ui")[0],
		};
	});
}

async function q4Print() {
	const cursor = new Cursor();
	const run = Bun.spawn([OMP, "--profile", PROFILE, "-p", ...baseArgs(), "-e", PLUGIN, "SPIKE-APPROVE"], {
		cwd: PROJECT,
		env: ENV,
		stdout: "pipe",
		stderr: "pipe",
	});
	const timer = setTimeout(() => run.kill(), 60_000);
	const code = await run.exited;
	clearTimeout(timer);
	return { exitCode: code, stdoutTail: (await new Response(run.stdout).text()).trim().slice(-300), probe: cursor.ext("ui")[0] ?? null };
}

/** Minimal ACP client (JSON-RPC 2.0 over stdio) that optionally advertises form elicitation. */
async function q4Acp(form: boolean) {
	const cursor = new Cursor();
	const proc = Bun.spawn([OMP, "--profile", PROFILE, "--mode", "acp", ...baseArgs(), "-e", PLUGIN], {
		cwd: PROJECT,
		env: ENV,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	type Message = { id?: number; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: unknown };
	const pending = new Map<number, (message: Message) => void>();
	const elicitations: unknown[] = [];
	const otherRequests: string[] = [];
	let nextId = 0;
	const write = (message: object) => {
		proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
		proc.stdin.flush();
	};
	const request = (method: string, params: object, timeoutMs = 30_000): Promise<Message> => {
		const id = ++nextId;
		write({ id, method, params });
		return Promise.race([
			new Promise<Message>(resolve => pending.set(id, resolve)),
			Bun.sleep(timeoutMs).then((): never => {
				throw new Error(`timeout waiting for ${method}`);
			}),
		]);
	};
	const answer = (message: Message) => {
		if (message.method === "elicitation/create") {
			const schema = message.params?.requestedSchema as { properties?: { value?: { type?: string } } } | undefined;
			const type = schema?.properties?.value?.type ?? null;
			elicitations.push({ message: message.params?.message, valueType: type });
			return { result: { action: "accept", content: { value: type === "boolean" ? true : "승인" } } };
		}
		otherRequests.push(String(message.method));
		if (message.method === "session/request_permission") {
			const options = (message.params?.options as Array<{ optionId: string; kind?: string }> | undefined) ?? [];
			const allow = options.find(option => option.kind?.startsWith("allow")) ?? options[0];
			return { result: { outcome: allow ? { outcome: "selected", optionId: allow.optionId } : { outcome: "cancelled" } } };
		}
		return { error: { code: -32601, message: "not supported by spike client" } };
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
				if (message.method && message.id !== undefined) write({ id: message.id, ...answer(message) });
				else if (message.id !== undefined) {
					pending.get(message.id)?.(message);
					pending.delete(message.id);
				}
			}
		}
	})();
	try {
		const init = await request("initialize", { protocolVersion: 1, clientCapabilities: form ? { elicitation: { form: {} } } : {} });
		const created = await request("session/new", { cwd: PROJECT, mcpServers: [] });
		const sessionId = created.result?.sessionId;
		const prompt = await request("session/prompt", { sessionId, prompt: [{ type: "text", text: "SPIKE-APPROVE" }] }, 60_000);
		return {
			initialized: Boolean(init.result),
			stopReason: prompt.result?.stopReason ?? prompt.error ?? null,
			elicitations,
			otherRequests,
			probe: cursor.ext("ui")[0] ?? null,
		};
	} finally {
		proc.stdin.end();
		const exited = await Promise.race([proc.exited.then(() => true), Bun.sleep(5_000).then(() => false)]);
		if (!exited) proc.kill();
	}
}

// ── Q5: does --max-cost include subagent spend? (fake/priced costs $0.11 per request) ──────

async function q5MaxCost() {
	writeFileSync(POLICY, "{}");
	const cursor = new Cursor();
	return session(
		["-e", PLUGIN, "--max-cost", "0.2"],
		async rpc => {
			const from = rpc.frames.length;
			rpc.send({ type: "prompt", message: "SPIKE-TASK storm-implementer storm-implementer" });
			const result = await until(() => rpc.find(f => f.type === "prompt_result", from), 90_000, "prompt result");
			await rpc.settle(from, 20_000).catch(() => undefined);
			await Bun.sleep(1_000);
			rpc.send({ type: "get_session_stats", id: "stats" });
			const stats = await until(() => rpc.find(f => f.type === "response" && f.id === "stats", from), 10_000, "session stats").catch(() => undefined);
			return {
				requests: cursor.llm().map(entry => `${entry.model}/${entry.tools.length === 0 ? "side" : entry.child ? "child" : "main"}/${entry.lastRole}`),
				promptResult: { status: result.status, error: result.error ?? null },
				toolResults: rpc.frames
					.slice(from)
					.filter(f => f.type === "tool_execution_end")
					.map(f => ({ tool: f.toolName, isError: f.isError ?? false, text: resultText(f).slice(0, 300) })),
				costFrames: rpc.frames
					.slice(from)
					.filter(f => f.type !== "message_update" && /max.?cost|cost limit|spend/i.test(JSON.stringify(f)))
					.map(f => JSON.stringify(f).slice(0, 300))
					.slice(0, 6),
				stats: stats?.data ?? null,
			};
		},
		approveAll,
		"fake/priced",
	);
}

/**
 * Drives the interactive TUI through expect: answer the TUI's terminal queries (DA1, OSC 11) so it
 * renders, skip the fresh profile's provider sign-in picker, submit SPIKE-APPROVE, take the first
 * option, confirm. Expect blocks stay multi-line: a one-line braced block is read as one pattern.
 */
async function q4Tui() {
	const cursor = new Cursor();
	const command = [OMP, "--profile", PROFILE, ...baseArgs(), "-e", PLUGIN].map(arg => `{${arg}}`).join(" ");
	const script = `
log_user 0
set env(TERM) xterm-256color
set env(STORM_SPIKE_LOG) {${EXT_LOG}}
set env(STORM_SPIKE_POLICY) {${POLICY}}
cd {${PROJECT}}
spawn -noecho ${command}
stty rows 40 columns 140 < $spawn_out(slave,name)
expect_after {
	-re {\\x1b\\[c} { send -- "\\033\\[?62;22c"; exp_continue }
	-re {\\x1b\\]11;\\?} { send -- "\\033\\]11;rgb:1e1e/1e1e/1e1e\\033\\\\"; exp_continue }
}
set timeout 4
set picker 0
expect {
	-re {Select provider to login} { set picker 1; exp_continue -continue_timer }
	timeout {}
	eof { puts "eof-at-start"; exit 4 }
}
if {$picker} {
	puts "picker-shown"
	send -- "\\033"
	expect {
		timeout {}
		eof { puts "eof-after-escape"; exit 4 }
	}
}
set timeout 20
send -- "SPIKE-APPROVE"
sleep 0.5
send -- "\\r"
expect {
	-re {dlg-select} { puts "select-shown" }
	timeout { puts "no-select"; exit 2 }
	eof { puts "eof"; exit 4 }
}
sleep 1
send -- "\\r"
expect {
	-re {dlg-confirm} { puts "confirm-shown" }
	timeout { puts "no-confirm"; exit 3 }
	eof { puts "eof"; exit 4 }
}
sleep 1
send -- "y"
sleep 0.5
send -- "\\r"
sleep 3
send -- "\\003"
sleep 1
send -- "\\003"
sleep 1
catch {close}
catch {wait}
exit 0
`;
	const run = Bun.spawnSync(["expect", "-c", script], { env: ENV, timeout: 120_000 });
	return { exitCode: run.exitCode, markers: run.stdout.toString().trim().split("\n"), probe: cursor.ext("ui")[0] ?? null };
}

// ── setup / cleanup ───────────────────────────────────────────────────────────────────────

function setup() {
	mkdirSync(join(PROFILE_ROOT, "agent"), { recursive: true });
	mkdirSync(PROJECT, { recursive: true });
	writeFileSync(join(PROFILE_ROOT, "agent", "models.yml"), MODELS_YML);
	// setupVersion >= CURRENT_SETUP_VERSION (3) keeps the TUI's first-run wizard and its sign-in picker away.
	writeFileSync(join(PROFILE_ROOT, "agent", "config.yml"), "setupVersion: 3\n");
	writeFileSync(OVERLAY, "task:\n  agentModelOverrides:\n    storm-implementer: fake/override-x\n");
	writeFileSync(POLICY, "{}");
	const listed = ompCli(["models", "--json"]);
	let models: string[] = [];
	try {
		models = (JSON.parse(listed.out) as { models: Array<{ provider: string; id: string }> }).models.map(m => `${m.provider}/${m.id}`);
	} catch {
		return { error: "omp models --json failed", out: listed.out };
	}
	return { profile: PROFILE_ROOT, models };
}

function cleanup() {
	rmSync(PROFILE_ROOT, { recursive: true, force: true });
	return { removedProfile: !existsSync(PROFILE_ROOT) };
}

const SCENARIOS: Record<string, () => Promise<object> | object> = {
	setup,
	"q1-typed": () => q1Prompt("q1-typed", mark => `workflowz ${mark}`),
	"q1-idle": () => q1Prompt("q1-idle", mark => `/spike-send idle ${b64(`workflowz ${mark}`)}`),
	"q1-auto": () => q1Streaming("auto"),
	"q1-followUp": () => q1Streaming("followUp"),
	"q1-steer": () => q1Streaming("steer"),
	"q1-deferred": () => q1Streaming("deferred"),
	"q2-task": () => spawnRun(ROUTE_POLICY, "SPIKE-TASK storm-implementer storm-reviewer"),
	"q2-eval": () => spawnRun(ROUTE_POLICY, "SPIKE-EVAL storm-implementer storm-reviewer"),
	"q2-override-observe": () => spawnRun({}, "SPIKE-TASK storm-implementer", ["-e", PLUGIN, "--config", OVERLAY]),
	"q2-override-route": () => spawnRun(ROUTE_POLICY, "SPIKE-TASK storm-implementer", ["-e", PLUGIN, "--config", OVERLAY]),
	"q2-builtin": () => spawnRun({}, "SPIKE-TASK task scout"),
	"q3-link": q3Link,
	"q3-shadow": q3Shadow,
	"q4-rpc": () => q4Rpc([]),
	"q4-rpc-noui": () => q4Rpc(["--no-ui"]),
	"q4-print": q4Print,
	"q4-acp-form": () => q4Acp(true),
	"q4-acp-noform": () => q4Acp(false),
	"q4-tui": q4Tui,
	"q5-maxcost": q5MaxCost,
	cleanup,
};

const requested = process.argv.slice(2);
const names = requested.includes("all") ? Object.keys(SCENARIOS).filter(name => name !== "setup" && name !== "cleanup") : requested;
mkdirSync(WORK, { recursive: true });
for (const name of names) {
	const scenario = SCENARIOS[name];
	if (!scenario) {
		console.log(JSON.stringify({ scenario: name, error: "unknown scenario" }));
		continue;
	}
	const started = Date.now();
	let result: object;
	try {
		result = await scenario();
	} catch (error) {
		result = { error: String(error) };
	}
	const line = JSON.stringify({ scenario: name, ms: Date.now() - started, ...result });
	appendFileSync(RESULTS, `${line}\n`);
	console.log(line);
}
