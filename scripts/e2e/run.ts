#!/usr/bin/env bun
/**
 * OMP Storm end-to-end check: the real plugin inside omp (RPC and print modes) against the scripted
 * fake LLM, in an isolated profile and a throwaway git project. No paid model calls.
 *
 * Usage: bun scripts/e2e/run.ts   (needs omp on ~/.local/bin or OMP_BIN; port 18556 free)
 */
import type { Subprocess } from "bun";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type Frame = { type?: string; [key: string]: unknown };
interface LlmEntry {
	model: string;
	effort: string | null;
	tools: string[];
	lastRole?: string;
	roles: string[];
	spike: string[];
	child: boolean;
}

const ROOT = join(import.meta.dir, "..", "..");
const OMP = process.env.OMP_BIN ?? join(homedir(), ".local/bin/omp");
const BUN = process.execPath;
const PROFILE = "storm-e2e";
const PORT = 18556;
const WORK = "/tmp/storm-e2e";
const PROJECT = join(WORK, "project");
const LLM_LOG = join(WORK, "llm.jsonl");
const PROFILE_ROOT = join(homedir(), ".omp", "profiles", PROFILE);
const AGENT_DIR = join(PROFILE_ROOT, "agent");
const CONFIG = join(PROJECT, ".omp", "storm", "config.json");
const SHADOW = join(PROJECT, ".omp", "agents", "storm-implementer.md");
const MODEL_ARGS = ["--model", "fake/general-b", "--smol", "fake/cheap-a", "--slow", "fake/general-b", "--plan", "fake/general-b"];
const BASE_ARGS = ["--profile", PROFILE, "--no-session", "--no-title", "--auto-approve", ...MODEL_ARGS, "-e", ROOT];

const MODELS = {
	fake: [
		["cheap-a", { input: 0.1, output: 0.4, cacheRead: 0.01, cacheWrite: 0.1 }],
		["general-b", { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }],
		["premium-c", { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }],
	],
	fake2: [
		["cheap-d", { input: 0.15, output: 0.6, cacheRead: 0.015, cacheWrite: 0.2 }],
		["general-e", { input: 1.5, output: 8, cacheRead: 0.15, cacheWrite: 2 }],
	],
} as const;

function modelsYml(): string {
	const lines = ["providers:"];
	for (const [provider, models] of Object.entries(MODELS)) {
		lines.push(`  ${provider}:`, `    baseUrl: http://127.0.0.1:${PORT}/v1`, "    apiKey: storm-e2e-dummy", "    api: openai-completions", "    models:");
		for (const [id, cost] of models) {
			lines.push(`      - id: ${id}`, "        contextWindow: 200000", "        maxTokens: 8192");
			lines.push(`        cost: { input: ${cost.input}, output: ${cost.output}, cacheRead: ${cost.cacheRead}, cacheWrite: ${cost.cacheWrite} }`);
		}
	}
	return `${lines.join("\n")}\n`;
}

const readLlm = (): LlmEntry[] =>
	existsSync(LLM_LOG) ? readFileSync(LLM_LOG, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as LlmEntry) : [];

async function until<T>(probe: () => T | undefined, timeoutMs: number, label: string): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = probe();
		if (value !== undefined) return value;
		if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
		await Bun.sleep(150);
	}
}

type Answer = (request: Frame) => string | undefined;

class Rpc {
	readonly frames: Frame[] = [];
	readonly #proc: Subprocess<"pipe", "pipe", "pipe">;
	#seq = 0;

	constructor(readonly answer: Answer) {
		this.#proc = Bun.spawn([OMP, "--mode", "rpc", ...BASE_ARGS], { cwd: PROJECT, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
		void this.#pump();
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
				if (frame.type !== "extension_ui_request") continue;
				const value = frame.method === "select" ? this.answer(frame) : undefined;
				this.send(
					value === undefined
						? { type: "extension_ui_response", id: frame.id, cancelled: true }
						: { type: "extension_ui_response", id: frame.id, value },
				);
			}
		}
	}

	send(command: Frame): string {
		const id = typeof command.id === "string" ? command.id : `c${++this.#seq}`;
		this.#proc.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
		this.#proc.stdin.flush();
		return id;
	}

	find(match: (frame: Frame) => boolean, from = 0): Frame | undefined {
		return this.frames.slice(from).find(match);
	}

	async close(): Promise<void> {
		this.#proc.stdin.end();
		const exited = await Promise.race([this.#proc.exited.then(() => true), Bun.sleep(5_000).then(() => false)]);
		if (!exited) this.#proc.kill();
		await this.#proc.exited;
	}
}

async function session<T>(answer: Answer, body: (rpc: Rpc) => Promise<T>): Promise<T> {
	const rpc = new Rpc(answer);
	try {
		await until(() => rpc.find(frame => frame.type === "ready"), 30_000, "rpc ready");
		return await body(rpc);
	} finally {
		await rpc.close();
	}
}

const textOf = (frame: Frame): string => JSON.stringify(frame);
const noAnswer: Answer = () => undefined;

/** Runs a slash command and returns its frames once it has completed and the session is quiet. */
async function command(line: string, answer: Answer): Promise<Frame[]> {
	return session(answer, async rpc => {
		const from = rpc.frames.length;
		const id = rpc.send({ type: "prompt", message: line });
		await until(() => rpc.find(frame => frame.type === "prompt_result" && frame.id === id, from), 120_000, line);
		await Bun.sleep(300);
		return rpc.frames.slice(from);
	});
}

/** Asks the fake model to spawn the agents; returns child requests and async results. */
async function spawn(agents: string[]): Promise<{ children: LlmEntry[]; results: string }> {
	const before = readLlm().length;
	return session(noAnswer, async rpc => {
		const from = rpc.frames.length;
		rpc.send({ type: "prompt", message: `SPIKE-TASK ${agents.join(" ")}` });
		await until(
			() => rpc.find(frame => frame.type === "session_settled" || (frame.type === "prompt_result" && frame.sessionSettled === true), from),
			120_000,
			"spawn settle",
		);
		await Bun.sleep(500);
		const results = rpc.frames
			.slice(from)
			.filter(frame => frame.type === "message_start" && textOf(frame).includes("async-result"))
			.map(textOf)
			.join("\n");
		return { children: readLlm().slice(before).filter(entry => entry.child && entry.tools.length > 0), results };
	});
}

const failures: string[] = [];
function check(name: string, ok: boolean, detail = ""): void {
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failures.push(name);
}

function configHashOnDisk(): string | null {
	if (!existsSync(CONFIG)) return null;
	return new Bun.CryptoHasher("sha256").update(readFileSync(CONFIG)).digest("hex");
}

function approvalFiles(): string[] {
	const base = join(AGENT_DIR, "storm", "approvals");
	if (!existsSync(base)) return [];
	return readdirSync(base).flatMap(repo => {
		const dir = join(base, repo, "approved");
		return existsSync(dir) ? readdirSync(dir) : [];
	});
}

const setupAnswers: Answer = request => {
	const options = (request.options as string[] | undefined) ?? [];
	if (options.includes("계속")) return "계속";
	if (String(request.title).startsWith("최적화 우선순위")) return "균형";
	if (options.includes("전체 수락")) return "전체 수락";
	if (options.includes("승인 후 저장")) return "승인 후 저장";
	return undefined;
};
const approveAnswers: Answer = request => {
	const options = (request.options as string[] | undefined) ?? [];
	return options.includes("승인") ? "승인" : undefined;
};

async function main(): Promise<void> {
	rmSync(WORK, { recursive: true, force: true });
	rmSync(PROFILE_ROOT, { recursive: true, force: true });
	mkdirSync(PROJECT, { recursive: true });
	mkdirSync(AGENT_DIR, { recursive: true });
	writeFileSync(join(AGENT_DIR, "models.yml"), modelsYml());
	writeFileSync(join(AGENT_DIR, "config.yml"), "setupVersion: 3\n");
	Bun.spawnSync(["git", "init", "-q", PROJECT]);
	const server = Bun.spawn([BUN, join(import.meta.dir, "fake-llm.ts")], {
		env: { ...process.env, FAKE_LLM_PORT: String(PORT), FAKE_LLM_LOG: LLM_LOG },
		stdout: "pipe",
		stderr: "pipe",
	});
	try {
		await Bun.sleep(800);

		let run = await spawn(["storm-implementer", "task"]);
		check("설정 없음: storm 역할 차단", run.results.includes("Storm 설정이 없습니다") && run.children.every(c => !c.roles.length));
		check("설정 없음: 일반 에이전트는 영향 없음", run.children.length === 1, `children=${run.children.length}`);

		let frames = await command("/storm setup", setupAnswers);
		const config = existsSync(CONFIG) ? (JSON.parse(readFileSync(CONFIG, "utf8")) as { roles: Record<string, { models: string[]; effort?: string }> }) : undefined;
		check("setup: 설정 저장", config !== undefined);
		check("setup: 승인 기록", approvalFiles().length === 1, `approvals=${approvalFiles().length}`);
		check("setup: .gitignore", existsSync(join(PROJECT, ".omp", "storm", ".gitignore")));
		check("setup: 현황 보고", frames.some(frame => textOf(frame).includes("Storm 현황")));
		const implementer = config?.roles.implementer;
		const expectedModel = implementer?.models[0]?.split("/").slice(1).join("/");

		run = await spawn(["storm-implementer"]);
		const child = run.children[0];
		check("승인 후: 승인 모델로 교체", child?.model === expectedModel, `child=${child?.model} expected=${expectedModel}`);
		check("승인 후: effort 전달", implementer?.effort === undefined || child?.effort === implementer.effort, `effort=${child?.effort} expected=${implementer?.effort}`);

		const edited = JSON.parse(readFileSync(CONFIG, "utf8")) as { parallelism: number };
		edited.parallelism = edited.parallelism === 3 ? 5 : 3;
		writeFileSync(CONFIG, `${JSON.stringify(edited, null, 2)}\n`);
		run = await spawn(["storm-implementer"]);
		check("직접 편집: 승인 전 차단", run.results.includes("승인되지 않은 Storm 설정") && run.children.length === 0);
		await command("/storm review", approveAnswers);
		run = await spawn(["storm-implementer"]);
		check("리뷰 승인 후: 다시 허용", run.children.length === 1 && run.children[0]?.model === expectedModel);

		mkdirSync(join(PROJECT, ".omp", "agents"), { recursive: true });
		writeFileSync(SHADOW, "---\nname: storm-implementer\ndescription: shadow\n---\nSTORM-ROLE shadow. Reply with OK.\n");
		run = await spawn(["storm-implementer"]);
		check("역할 가림: 승인 전 차단", run.results.includes("승인되지 않은 역할 정의") && run.children.length === 0);
		await command("/storm review", approveAnswers);
		run = await spawn(["storm-implementer"]);
		check("역할 가림: 승인 후 가림 정의로 실행", run.children[0]?.roles.includes("shadow") === true);
		rmSync(join(PROJECT, ".omp", "agents"), { recursive: true, force: true });

		const beforeRollback = configHashOnDisk();
		await command("/storm rollback", request => {
			const options = (request.options as string[] | undefined) ?? [];
			if (options.includes("승인 후 되돌리기")) return "승인 후 되돌리기";
			return options.find(option => option !== "취소");
		});
		check("롤백: 설정 파일 변경", configHashOnDisk() !== beforeRollback);
		run = await spawn(["storm-implementer"]);
		check("롤백 후: 승인된 설정으로 허용", run.children.length === 1);

		const hashBefore = configHashOnDisk();
		const approvalsBefore = approvalFiles().length;
		const llmBefore = readLlm().length;
		const print = Bun.spawnSync([OMP, "-p", ...BASE_ARGS, "/storm setup"], { cwd: PROJECT, timeout: 120_000 });
		check("print 모드: 변경 없음", configHashOnDisk() === hashBefore && approvalFiles().length === approvalsBefore, `exit=${print.exitCode}`);
		check("print 모드: 모델 호출 없음", readLlm().length === llmBefore);

		frames = await command("/storm status", noAnswer);
		check("status: 보고", frames.some(frame => textOf(frame).includes("Storm 현황")));

		rmSync(join(PROJECT, ".omp", "storm"), { recursive: true, force: true });
		run = await spawn(["storm-implementer", "task"]);
		check("설정 삭제: storm 역할 차단", run.results.includes("Storm 설정이 없습니다"));
		check("설정 삭제: 일반 에이전트 정상", run.children.length === 1);
	} finally {
		server.kill();
		await server.exited;
		rmSync(WORK, { recursive: true, force: true });
		rmSync(PROFILE_ROOT, { recursive: true, force: true });
	}
	console.log(failures.length === 0 ? "\nE2E: all passed" : `\nE2E: ${failures.length} failed: ${failures.join(", ")}`);
	process.exit(failures.length === 0 ? 0 : 1);
}

await main();
