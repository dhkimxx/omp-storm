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
import { STORM_VERSION } from "../../src/roles.ts";
import { parseModelEntry } from "../../src/selector.ts";

type Frame = { type?: string; [key: string]: unknown };
interface LlmEntry {
	model: string;
	effort: string | null;
	tools: string[];
	lastRole?: string;
	roles: string[];
	spike: string[];
	child: boolean;
	notices: { workflowz: string[]; orchestrate: string[] };
	users: string[];
	decision?: { tool?: string; args?: { action?: string } };
	/** An omp compaction request, and the `<additional-context>` block extensions added to it. */
	compaction: boolean;
	compactionContext: string;
	/** The system prompt carries Storm's doc rules section. */
	docRules: boolean;
	/** A user message carries `<storm-setup>`. */
	setup: boolean;
	/** The tool result this request answers (cut). */
	lastTool: string;
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
const MAIN_MODEL = "fake/general-b";
const baseArgs = (model = MAIN_MODEL): string[] => [
	"--profile",
	PROFILE,
	"--no-session",
	"--no-title",
	"--auto-approve",
	"--model",
	model,
	"--smol",
	"fake/cheap-a",
	"--slow",
	"fake/general-b",
	"--plan",
	"fake/general-b",
	"-e",
	ROOT,
];
/** Session flavor: the main model (one outside the approved team makes non-Storm agents ask for it) and extra flags. */
interface Flavor {
	model?: string;
	flags?: string[];
}

const MODELS = {
	fake: [
		["cheap-a", { input: 0.1, output: 0.4, cacheRead: 0.01, cacheWrite: 0.1 }],
		["general-b", { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }],
		["premium-c", { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }],
		// Below every role's minimum context, so no team ever approves it: the model outside the team. Priced like premium-c,
		// so one main request of a run already passes the budget step's cap.
		["outsider-z", { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, context: 60_000 }],
		// Reports a 35k prompt on a 60k window (fake-llm.ts): a heavy main session for the run-start check. Never in a team.
		["heavy-main", { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 1, context: 60_000 }],
	],
	fake2: [
		["cheap-d", { input: 0.15, output: 0.6, cacheRead: 0.015, cacheWrite: 0.2 }],
		["general-e", { input: 1.5, output: 8, cacheRead: 0.15, cacheWrite: 2 }],
	],
} as const;
/** A provider whose only model always answers 429 (fake-llm.ts); added only for the fallback step, so it never enters the team. */
const QUOTA_OUT = { fake3: [["quota-out", { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 1 }]] } as const;

function modelsYml(withQuotaOut = false): string {
	const lines = ["providers:"];
	for (const [provider, models] of Object.entries(withQuotaOut ? { ...MODELS, ...QUOTA_OUT } : MODELS)) {
		lines.push(`  ${provider}:`, `    baseUrl: http://127.0.0.1:${PORT}/v1`, "    apiKey: storm-e2e-dummy", "    api: openai-completions", "    models:");
		for (const [id, cost] of models) {
			lines.push(`      - id: ${id}`, `        contextWindow: ${"context" in cost ? cost.context : 200_000}`, "        maxTokens: 8192");
			lines.push(`        cost: { input: ${cost.input}, output: ${cost.output}, cacheRead: ${cost.cacheRead}, cacheWrite: ${cost.cacheWrite} }`);
		}
	}
	return `${lines.join("\n")}\n`;
}

const PROFILE_CONFIG = "setupVersion: 3\n";
/** No same-model retries, so omp walks the chain at once. */
const FALLBACK_CONFIG = `${PROFILE_CONFIG}retry:\n  maxRetries: 0\n  modelFallback: true\n  fallbackOn: any\n  fallbackChains:\n    fake3/quota-out:\n      - fake/general-b\n`;

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

	constructor(
		readonly answer: Answer,
		flavor: Flavor = {},
	) {
		this.#proc = Bun.spawn([OMP, "--mode", "rpc", ...baseArgs(flavor.model), ...(flavor.flags ?? [])], {
			cwd: PROJECT,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
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

async function session<T>(answer: Answer, body: (rpc: Rpc) => Promise<T>, flavor: Flavor = {}): Promise<T> {
	const rpc = new Rpc(answer, flavor);
	try {
		await until(() => rpc.find(frame => frame.type === "ready"), 30_000, "rpc ready");
		return await body(rpc);
	} finally {
		await rpc.close();
	}
}

const textOf = (frame: Frame): string => JSON.stringify(frame);
const noAnswer: Answer = () => undefined;
const choose =
	(label: string): Answer =>
	request =>
		((request.options as string[] | undefined) ?? []).includes(label) ? label : undefined;
const uiTitled = (frames: Frame[], title: string): boolean =>
	frames.some(frame => frame.type === "extension_ui_request" && String(frame.title).startsWith(title));

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
async function spawn(agents: string[], flavor: Flavor = {}): Promise<{ children: LlmEntry[]; main: LlmEntry[]; results: string }> {
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
		const fresh = readLlm().slice(before).filter(entry => entry.tools.length > 0);
		return { children: fresh.filter(entry => entry.child), main: fresh.filter(entry => !entry.child), results };
	}, flavor);
}

/** Waits until the session has settled and stayed quiet (handoffs start follow-up turns). */
async function settleQuietly(rpc: Rpc, from: number, label: string): Promise<void> {
	const deadline = Date.now() + 120_000;
	let seen = rpc.frames.length;
	let quietSince = Date.now();
	for (;;) {
		await Bun.sleep(200);
		if (rpc.frames.length !== seen) {
			seen = rpc.frames.length;
			quietSince = Date.now();
			continue;
		}
		const settled = rpc.find(frame => frame.type === "session_settled" || (frame.type === "prompt_result" && frame.sessionSettled === true), from);
		if (settled && Date.now() - quietSince >= 3_000) return;
		if (Date.now() > deadline) throw new Error(`timeout waiting for quiet: ${label}`);
	}
}

/** Sends the prompts one after another in one session; returns every frame once each has settled. */
async function converse(messages: string | string[], answer: Answer, flavor: Flavor = {}): Promise<{ frames: Frame[]; llm: LlmEntry[] }> {
	const before = readLlm().length;
	return session(
		answer,
		async rpc => {
			const from = rpc.frames.length;
			for (const message of [messages].flat()) {
				const at = rpc.frames.length;
				rpc.send({ type: "prompt", message });
				await settleQuietly(rpc, at, message);
			}
			return { frames: rpc.frames.slice(from), llm: readLlm().slice(before) };
		},
		flavor,
	);
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

/** Starts the rpc setup dialog (0.9.0: it precedes the `<storm-setup>` message) and approves every approval dialog. */
const approveAnswers: Answer = request => {
	const options = (request.options as string[] | undefined) ?? [];
	if (request.title === "Storm 팀 설정을 시작할까요?" && options.includes("시작")) return "시작";
	return options.includes("승인") ? "승인" : undefined;
};

async function main(): Promise<void> {
	rmSync(WORK, { recursive: true, force: true });
	rmSync(PROFILE_ROOT, { recursive: true, force: true });
	mkdirSync(PROJECT, { recursive: true });
	mkdirSync(AGENT_DIR, { recursive: true });
	writeFileSync(join(AGENT_DIR, "models.yml"), modelsYml());
	writeFileSync(join(AGENT_DIR, "config.yml"), PROFILE_CONFIG);
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
		check(
			"도구: 설정 없는 프로젝트엔 storm 도구 없음",
			run.main.length > 0 && run.main.every(entry => !entry.tools.includes("storm")),
			`main=${run.main.length}`,
		);

		// C2: under rpc a dialog precedes the setup request, so a client that answers no dialog never gets the interview.
		const SETUP_DIALOG = "Storm 팀 설정을 시작할까요?";
		const declined = await converse("/storm", choose("취소"));
		check(
			"setup(rpc): 시작 확인 창에서 취소하면 설정 요청 없음",
			uiTitled(declined.frames, SETUP_DIALOG) && !declined.llm.some(entry => entry.setup) && !existsSync(CONFIG),
			`dialog=${uiTitled(declined.frames, SETUP_DIALOG)} setupRequests=${declined.llm.filter(entry => entry.setup).length}`,
		);

		// Setup is led by the session LLM: the fake model proposes Storm's recommendation, and only "승인" in Storm's dialog saves it.
		const setup = await converse("/storm", approveAnswers);
		let frames = setup.frames;
		check(
			"setup(rpc): 시작을 고르면 설정 요청(<storm-setup>)을 보냄",
			uiTitled(frames, SETUP_DIALOG) && setup.llm.some(entry => !entry.child && entry.setup),
		);
		const config = existsSync(CONFIG) ? (JSON.parse(readFileSync(CONFIG, "utf8")) as { roles: Record<string, { models: string[]; effort?: string }> }) : undefined;
		check(
			"setup: 세션 LLM이 팀 제안(propose)",
			setup.llm.some(entry => !entry.child && entry.decision?.tool === "storm" && entry.decision.args?.action === "propose"),
		);
		check("setup: 팀 제안 승인 창", uiTitled(frames, "이 변경을 승인할까요") && frames.some(frame => textOf(frame).includes("Storm 팀 제안")));
		check("setup: 설정 저장", config !== undefined);
		check("setup: 승인 기록", approvalFiles().length === 1, `approvals=${approvalFiles().length}`);
		check("setup: .gitignore", existsSync(join(PROJECT, ".omp", "storm", ".gitignore")));
		check(
			"setup: 새 역할(단순 작업·설계·자문)도 추천안에",
			config?.roles.quick !== undefined && config.roles.architect !== undefined,
			Object.keys(config?.roles ?? {}).join(","),
		);
		const implementer = config?.roles.implementer;
		const primaryEntry = implementer?.models[0] === undefined ? undefined : parseModelEntry(implementer.models[0]);
		const expectedModel = primaryEntry?.selector.split("/").slice(1).join("/");
		const expectedEffort = primaryEntry?.effort ?? implementer?.effort;

		run = await spawn(["storm-implementer"]);
		const child = run.children[0];
		check("승인 후: 승인 모델로 교체", child?.model === expectedModel, `child=${child?.model} expected=${expectedModel}`);
		check("승인 후: effort 전달", expectedEffort === undefined || child?.effort === expectedEffort, `effort=${child?.effort} expected=${expectedEffort}`);
		check("문서 정합(켬): storm 역할 시스템 프롬프트에 문서 규칙", child?.docRules === true, `docRules=${child?.docRules}`);
		check(
			"도구: 설정 있으면 메인 세션에만 storm 도구",
			run.main.length > 0 && run.main.every(entry => entry.tools.includes("storm")) && run.children.every(entry => !entry.tools.includes("storm")),
			`main=${run.main.map(entry => entry.tools.includes("storm")).join(",")} children=${run.children.map(entry => entry.tools.includes("storm")).join(",")}`,
		);
		run = await spawn(["storm-quick", "storm-architect"]);
		const newRoleModels = ["quick", "architect"].map(id => {
			const entry = config?.roles[id]?.models[0];
			return entry === undefined ? undefined : parseModelEntry(entry).selector.split("/").slice(1).join("/");
		});
		check(
			"새 역할: 단순 작업·설계·자문 스폰이 각자 승인 모델로",
			run.children.length === 2 && newRoleModels.every(model => run.children.some(child => child.model === model)),
			`children=${run.children.map(child => child.model).join(",")} expected=${newRoleModels.join(",")}`,
		);

		const edited = JSON.parse(readFileSync(CONFIG, "utf8")) as { parallelism: number };
		edited.parallelism = edited.parallelism === 3 ? 5 : 3;
		writeFileSync(CONFIG, `${JSON.stringify(edited, null, 2)}\n`);
		run = await spawn(["storm-implementer"]);
		check("직접 편집: 승인 전 차단", run.results.includes("승인되지 않은 Storm 설정") && run.children.length === 0);
		frames = await command("/storm", approveAnswers);
		check("허브: 미승인이면 승인 화면", uiTitled(frames, "이 설정을 승인할까요?") && !uiTitled(frames, "Storm 메뉴"));
		run = await spawn(["storm-implementer"]);
		check("리뷰 승인 후: 다시 허용", run.children.length === 1 && run.children[0]?.model === expectedModel);

		mkdirSync(join(PROJECT, ".omp", "agents"), { recursive: true });
		writeFileSync(SHADOW, "---\nname: storm-implementer\ndescription: shadow\n---\nSTORM-ROLE shadow. Reply with OK.\n");
		run = await spawn(["storm-implementer"]);
		check("역할 가림: 승인 전 차단", run.results.includes("승인되지 않은 역할 정의") && run.children.length === 0);
		frames = await command("/storm", approveAnswers);
		check("허브: 승인 안 된 가림 정의도 승인 화면", uiTitled(frames, "이 설정을 승인할까요?") && !uiTitled(frames, "Storm 메뉴"));
		run = await spawn(["storm-implementer"]);
		check("역할 가림: 승인 후 가림 정의로 실행", run.children[0]?.roles.includes("shadow") === true);
		rmSync(join(PROJECT, ".omp", "agents"), { recursive: true, force: true });

		const beforeRollback = configHashOnDisk();
		frames = await command("/storm", request => {
			const options = (request.options as string[] | undefined) ?? [];
			if (request.title === "Storm 메뉴") return "이전 설정으로 되돌리기";
			if (options.includes("승인 후 되돌리기")) return "승인 후 되돌리기";
			return options.find(option => option !== "취소");
		});
		check("롤백: 메뉴에서 설정 파일 변경", uiTitled(frames, "Storm 메뉴") && configHashOnDisk() !== beforeRollback);
		run = await spawn(["storm-implementer"]);
		check("롤백 후: 승인된 설정으로 허용", run.children.length === 1);

		const hashBefore = configHashOnDisk();
		const approvalsBefore = approvalFiles().length;
		const llmBefore = readLlm().length;
		const print = Bun.spawnSync([OMP, "-p", ...baseArgs(), "/storm setup"], { cwd: PROJECT, timeout: 120_000 });
		const printReset = Bun.spawnSync([OMP, "-p", ...baseArgs(), "/storm reset"], { cwd: PROJECT, timeout: 120_000 });
		const printHub = Bun.spawnSync([OMP, "-p", ...baseArgs(), "/storm"], { cwd: PROJECT, timeout: 120_000 });
		check(
			"print 모드: /storm·setup·reset 모두 변경 없음",
			configHashOnDisk() === hashBefore && approvalFiles().length === approvalsBefore,
			`exit=${print.exitCode},${printReset.exitCode},${printHub.exitCode}`,
		);
		check("print 모드: 모델 호출 없음", readLlm().length === llmBefore);

		frames = await command("/storm", noAnswer);
		check(
			"허브: 메뉴와 함께 짧은 현황",
			frames.some(frame => textOf(frame).includes("Storm 현황") && textOf(frame).includes(`- Storm ${STORM_VERSION}`) && textOf(frame).includes("/storm status")),
		);
		const menu = frames.find(frame => frame.type === "extension_ui_request" && frame.title === "Storm 메뉴")?.options as string[] | undefined;
		check(
			"허브: 해당하는 메뉴만",
			JSON.stringify(menu) === JSON.stringify(["팀 다시 설정", "모델 점검", "이전 설정으로 되돌리기", "초기화", "닫기"]),
			JSON.stringify(menu),
		);
		frames = await command("/storm status", noAnswer);
		check("현황: 수명 관리 경고", frames.some(frame => textOf(frame).includes("### 수명 관리")));
		check(
			"현황: omp 설정 점검(복사용 명령)",
			frames.some(frame => textOf(frame).includes("### omp 설정 점검") && textOf(frame).includes("omp config set")),
		);

		// ── v0.2: runs, natural-language changes, deferral, quota, trial, budget ──
		type StoredRole = { models: string[]; effort?: string; workers?: number | { min: number; max: number } };
		type StoredConfig = {
			priority: string;
			roles: Record<string, StoredRole>;
			trials?: unknown[];
			budget?: { perRunUsd: number };
			disabledRoles?: string[];
			contextCap?: number;
			cleanup?: boolean;
			docs?: boolean;
		};
		type StoredAgent = {
			id: string;
			role?: string;
			model?: string;
			contextTokens: number;
			state: string;
			followUps: number;
			review?: { reviews: number; passed: number; failed: number; findings: number[]; docFindings?: number };
			cleanedAt?: number;
		};
		type StoredRun = {
			runId: string;
			status: string;
			contract: string;
			spawns: Array<{ outcome: string; agent: string; spawnKey?: string; role?: string; reason?: string }>;
			agents?: StoredAgent[];
			mainCostUsd?: number;
			blockedEdits?: number;
			blockedFollowUps?: number;
			plan?: { lanes: unknown[]; workers: Record<string, number> };
			reads?: { director: number; duplicate: number; blocked: number };
			checkpoints?: Array<{ at: string; before: number; after?: number }>;
			cleanup?: { agents: number; files: number; bytes: number; stormFiles: number };
		};
		const readConfig = (): StoredConfig => JSON.parse(readFileSync(CONFIG, "utf8")) as StoredConfig;
		const idOf = (entry: string | undefined): string | undefined =>
			entry === undefined ? undefined : parseModelEntry(entry).selector.split("/").slice(1).join("/");
		const bare = (entry: string | undefined): string | undefined => (entry === undefined ? undefined : parseModelEntry(entry).selector);
		const providerOf = (selector: string | undefined): string | undefined => selector?.split("/")[0];
		const stateDir = join(PROJECT, ".omp", "storm", "state");
		const runFiles = (): StoredRun[] => {
			const dir = join(stateDir, "runs");
			if (!existsSync(dir)) return [];
			return readdirSync(dir)
				.filter(file => file.endsWith(".json"))
				.sort()
				.map(file => JSON.parse(readFileSync(join(dir, file), "utf8")) as StoredRun);
		};
		const proposalFiles = (): string[] => {
			const dir = join(stateDir, "proposals");
			return existsSync(dir) ? readdirSync(dir).filter(file => file.endsWith(".json")) : [];
		};
		type StoredSummary = {
			schema: string;
			runId: string;
			reads?: { director: number; duplicate: number; blocked: number };
			reviews?: { reviews: number; docFindings: number };
		};
		const runIndexFile = join(stateDir, "runs", "index.jsonl");
		const runIndex = (): StoredSummary[] =>
			existsSync(runIndexFile)
				? readFileSync(runIndexFile, "utf8")
						.split("\n")
						.filter(Boolean)
						.map(line => JSON.parse(line) as StoredSummary)
				: [];
		/** A main model outside the approved team: non-Storm agents ask for it unless Storm swaps it. */
		const OUTSIDER = "fake/outsider-z";
		/** A run whose director follows scripted steps (fake-llm.ts SPIKE-STEPS): plans, spawns and follow-ups in order. */
		const runTask = (steps: unknown[]): string => `/storm STORM-TOOL ${JSON.stringify({ action: "run", task: `SPIKE-STEPS ${JSON.stringify(steps)}` })}`;
		const planStep = (lanes: Array<{ name: string; kind: string }>, workers: Record<string, number> = {}) => ({
			storm: { action: "plan", plan: { lanes, workers } },
		});

		let team = readConfig();
		let primary = team.roles.implementer?.models[0];
		check(
			"v0.2 전제: 대체 확인용 모델은 승인 밖",
			!Object.values(team.roles).some(role => role.models.some(model => bare(model) === OUTSIDER)),
		);
		let talk = await converse(runTask([planStep([{ name: "impl", kind: "code" }]), { task: ["storm-implementer", "task"] }]), noAnswer, {
			model: OUTSIDER,
		});
		// The hidden notice is delivered with the handoff, so the logged (truncated) user text may not show the contract itself.
		const noticed = talk.llm.some(entry => !entry.child && entry.notices.workflowz.length > 0);
		check("실행: 인계에 workflowz 계약", noticed && runFiles().at(-1)?.contract === "workflowz", `contract=${runFiles().at(-1)?.contract} noticed=${noticed}`);
		const runChildren = talk.llm.filter(entry => entry.child && entry.tools.length > 0);
		check(
			"실행: storm 역할·승인 밖 요청 모두 승인 모델로",
			runChildren.length === 2 && runChildren.every(entry => entry.model === idOf(primary)),
			`children=${runChildren.map(entry => entry.model).join(",")} expected=${idOf(primary)}`,
		);
		const firstRun = runFiles().at(-1);
		check(
			"실행: 기록(완료, 교체·대체)",
			firstRun?.status === "done" && firstRun.spawns.some(s => s.outcome === "routed") && firstRun.spawns.some(s => s.outcome === "substituted"),
			`${firstRun?.status} ${firstRun?.spawns.map(s => s.outcome).join(",")}`,
		);
		check("실행: 결과 보고", talk.frames.some(frame => textOf(frame).includes("Storm 실행 결과")));
		const ledger = firstRun?.agents ?? [];
		check(
			"실행: 서브에이전트 장부(역할·모델·컨텍스트)",
			ledger.length === 2 && ledger.some(agent => agent.role === "implementer") && ledger.every(agent => agent.contextTokens > 0 && agent.model !== undefined),
			JSON.stringify(ledger.map(agent => [agent.id, agent.role, agent.model, agent.contextTokens, agent.state])),
		);
		const spawnKeys = (firstRun?.spawns ?? []).map(spawn => spawn.spawnKey);
		check(
			"실행: 스폰 기록이 에이전트 id로 이어짐",
			spawnKeys.length > 0 && spawnKeys.every(key => ledger.some(agent => agent.id === key)),
			`spawnKeys=${spawnKeys.join(",")} agents=${ledger.map(agent => agent.id).join(",")}`,
		);
		check("실행 계획: 실행 기록에 남음", firstRun?.plan?.lanes.length === 1 && firstRun.plan.workers.implementer === 1, JSON.stringify(firstRun?.plan));
		const firstSummary = runIndex().find(summary => summary.runId === firstRun?.runId);
		check(
			"실행 요약 색인: 끝난 실행이 index.jsonl 에 한 줄(storm.run-summary/v1)",
			firstSummary?.schema === "storm.run-summary/v1",
			`runId=${firstRun?.runId} lines=${runIndex().length} schema=${firstSummary?.schema}`,
		);
		// omp's built-in agents get their mapped role's models, and a reviewer's yielded verdict lands in the run record.
		const explorerPrimary = team.roles.explorer?.models[0];
		talk = await converse(
			runTask([
				planStep([
					{ name: "scope", kind: "explore" },
					{ name: "review", kind: "review" },
				]),
				{ task: ["scout", "storm-reviewer"] },
			]),
			noAnswer,
			{ model: OUTSIDER, flags: ["--smol", OUTSIDER] },
		);
		const reviewRun = runFiles().at(-1);
		const scoutSpawn = reviewRun?.spawns.find(spawn => spawn.agent === "scout");
		check(
			"기본 에이전트: 승인 밖 scout 는 탐색 역할 모델로",
			scoutSpawn?.outcome === "substituted" && scoutSpawn.role === "explorer" && talk.llm.some(entry => entry.child && entry.model === idOf(explorerPrimary)),
			`scout=${JSON.stringify(scoutSpawn)} expected=${idOf(explorerPrimary)}`,
		);
		const verdicts = (reviewRun?.agents ?? []).flatMap(agent => (agent.review ? [agent.review] : []));
		check(
			"리뷰 판정: 실행 기록과 결과 보고에 남음",
			verdicts.some(review => review.reviews === 1 && review.failed === 1 && review.findings[1] === 1) &&
				talk.frames.some(frame => textOf(frame).includes("리뷰 1회") && textOf(frame).includes("수정 필요 1 (P1 1)")),
			`verdicts=${JSON.stringify(verdicts)} agents=${JSON.stringify((reviewRun?.agents ?? []).map(agent => [agent.id, agent.role, agent.review]))}`,
		);
		// D2: the reviewer's finding carries `kind: "doc_conflict"`; omp's yield schema (agents/storm-reviewer.md) accepts it.
		const reviewSummary = runIndex().find(summary => summary.runId === reviewRun?.runId);
		check(
			"리뷰 문서 지적: doc_conflict 가 결과 보고·실행 기록·색인에 문서 상충으로",
			verdicts.some(review => review.docFindings === 1) &&
				talk.frames.some(frame => textOf(frame).includes("문서 상충 1건")) &&
				reviewSummary?.reviews?.docFindings === 1,
			`verdicts=${JSON.stringify(verdicts)} index=${JSON.stringify(reviewSummary?.reviews)}`,
		);

		// A run refuses spawns until the director submits a plan, each role stays within the plan's workers,
		// and a plan past the team's bounds needs an approved config change.
		const planHash = configHashOnDisk();
		talk = await converse(
			runTask([
				{ task: ["storm-explorer"] },
				// omp decides the spawn in the background after task returns: submit the plan only once it was refused.
				{ ...planStep([{ name: "scope", kind: "explore" }], { explorer: 1 }), after: "실행 계획이 없어" },
				{ task: ["storm-explorer", "storm-explorer"] },
				planStep([{ name: "scope", kind: "explore" }], { explorer: 9 }),
			]),
			choose("취소"),
		);
		const planRun = runFiles().at(-1);
		const explorerSpawns = (planRun?.spawns ?? []).filter(spawn => spawn.agent === "storm-explorer");
		check(
			"실행 계획: 계획 전 스폰은 막힘",
			explorerSpawns[0]?.outcome === "blocked" && (explorerSpawns[0].reason ?? "").includes("계획"),
			JSON.stringify((planRun?.spawns ?? []).map(spawn => [spawn.agent, spawn.outcome, spawn.spawnKey, (spawn.reason ?? "").slice(0, 40)])),
		);
		check(
			"실행 계획: 계획의 워커 수를 넘는 스폰은 막힘",
			explorerSpawns[1]?.outcome === "routed" && explorerSpawns[2]?.outcome === "blocked",
			JSON.stringify(explorerSpawns.slice(1).map(spawn => [spawn.outcome, spawn.reason?.slice(0, 60)])),
		);
		check(
			"실행 계획: 범위 밖 계획은 승인 창, 취소하면 그대로",
			uiTitled(talk.frames, "이 변경을 승인할까요") && configHashOnDisk() === planHash && planRun?.plan?.workers.explorer === 1,
			JSON.stringify(planRun?.plan?.workers),
		);
		talk = await converse(["SPIKE-TASK storm-implementer", '/storm STORM-TOOL {"action":"agents"}'], noAnswer);
		const agentsReply = talk.frames.map(textOf).find(text => text.includes("(implementer)") && text.includes("| 권장 |"));
		check("agents: 끝난 에이전트 재사용 권장", agentsReply?.includes("재사용") === true && agentsReply.includes("agent://"), agentsReply?.slice(0, 300) ?? "no table");
		const hubAgents = await session(
			request => (request.title === "Storm 메뉴" ? "서브에이전트 재사용 권장" : undefined),
			async rpc => {
				const first = rpc.frames.length;
				rpc.send({ type: "prompt", message: "SPIKE-TASK storm-implementer" });
				await settleQuietly(rpc, first, "spawn before /storm");
				const from = rpc.frames.length;
				const id = rpc.send({ type: "prompt", message: "/storm" });
				await until(() => rpc.find(frame => frame.type === "prompt_result" && frame.id === id, from), 120_000, "/storm");
				await Bun.sleep(300);
				return rpc.frames.slice(from);
			},
		);
		check(
			"허브: 서브에이전트가 있으면 재사용 권장 메뉴",
			hubAgents.some(frame => textOf(frame).includes("### 서브에이전트 재사용 권장") && textOf(frame).includes("| 권장 |")),
		);
		run = await spawn(["task"], { model: OUTSIDER });
		check("실행 밖: 일반 에이전트는 그대로", run.children[0]?.model === idOf(OUTSIDER), `child=${run.children[0]?.model}`);

		const directed = join(PROJECT, "director-check.txt");
		talk = await converse('/storm STORM-TOOL {"action":"run","task":"SPIKE-WRITE director-check.txt"}', noAnswer);
		const directorRun = runFiles().at(-1);
		check(
			"감독 모드: 실행 중 메인의 파일 쓰기는 막고 위임하라고 알림",
			!existsSync(directed) && directorRun?.blockedEdits === 1 && talk.frames.some(frame => textOf(frame).includes("Storm 감독 모드")),
			`exists=${existsSync(directed)} blocked=${directorRun?.blockedEdits}`,
		);
		check(
			"감독 모드: 실행 기록에 메인 비용",
			(directorRun?.mainCostUsd ?? 0) > 0 && talk.frames.some(frame => textOf(frame).includes("메인(감독): 비용")),
			`main=${directorRun?.mainCostUsd}`,
		);
		await converse("SPIKE-WRITE director-check.txt", noAnswer);
		check("감독 모드: 실행 밖에서는 메인이 그대로 씀", existsSync(directed));
		rmSync(directed, { force: true });

		// ── v0.9: director reads, run summary index, run-end cleanup, doc rules ──
		// A1: a storm-explorer reads the file; the director's whole-file read of it is refused, a bounded one passes.
		const EVIDENCE = "notes/evidence.txt";
		mkdirSync(join(PROJECT, "notes"), { recursive: true });
		writeFileSync(join(PROJECT, EVIDENCE), `${[1, 2, 3, 4, 5].map(n => `E2E-EVIDENCE-${n}`).join("\n")}\n`);
		talk = await converse(
			runTask([
				planStep([{ name: "scope", kind: "explore" }], { explorer: 1 }),
				{ task: ["storm-explorer"], say: `SPIKE-CHILD-READ ${EVIDENCE}` },
				{ read: EVIDENCE, afterResult: "Spike0" },
				{ read: `${EVIDENCE}:1-3` },
			]),
			noAnswer,
		);
		const readRun = runFiles().at(-1);
		const childReads = talk.llm.filter(entry => entry.child && entry.decision?.tool === "read").length;
		const directorResults = talk.llm.filter(entry => !entry.child && !entry.compaction && entry.lastTool !== "");
		const blockedRead = directorResults.find(entry => entry.lastTool.includes("통째로 읽기를 막았습니다"));
		const rangedRead = directorResults.find(entry => entry.lastTool.includes("E2E-EVIDENCE-2"));
		check(
			"감독 읽기: 하위가 읽은 파일 통째 읽기는 막고 읽은 에이전트(agent://)를 알려 줌",
			childReads >= 1 && blockedRead?.lastTool.includes("agent://Spike0") === true,
			`childReads=${childReads} reason=${blockedRead?.lastTool.slice(0, 200) ?? "none"}`,
		);
		check(
			"감독 읽기: 범위를 정한 읽기는 통과",
			rangedRead !== undefined && !rangedRead.lastTool.includes("막았습니다"),
			rangedRead?.lastTool.slice(0, 120) ?? directorResults.map(entry => entry.lastTool.slice(0, 80)).join(" | "),
		);
		const readSummary = runIndex().find(summary => summary.runId === readRun?.runId);
		check(
			"감독 읽기: 실행 기록·색인에 읽기 2·중복 2·막음 1",
			JSON.stringify(readRun?.reads) === JSON.stringify({ director: 2, duplicate: 2, blocked: 1 }) &&
				JSON.stringify(readSummary?.reads) === JSON.stringify(readRun?.reads),
			`run=${JSON.stringify(readRun?.reads)} index=${JSON.stringify(readSummary?.reads)}`,
		);
		rmSync(join(PROJECT, "notes"), { recursive: true, force: true });

		// B2: older runs whose omp process is gone. Their agents' records go only when the team approved cleanup, and
		// only for runs on this machine's trusted list (`<store.dir>/runs.jsonl`) whose artifacts dir sits under the
		// profile's sessions dir beside its `<dir>.jsonl`. Run records seeded only in the repo are never trusted.
		const SESSIONS = join(AGENT_DIR, "sessions");
		/** A pid above every pid_max: never alive (pid 1 is, and EPERM counts as alive). */
		const DEAD_PROCESS = "99999999:1";
		const approvalsBase = join(AGENT_DIR, "storm", "approvals");
		const storeDir = join(approvalsBase, readdirSync(approvalsBase)[0] ?? "missing");
		const trustedFile = join(storeDir, "runs.jsonl");
		type Seed = { runId: string; agent: string; at: number; dir: string };
		const seedOf = (group: string, runId: string, agent: string, at: number): Seed => ({ runId, agent, at, dir: join(SESSIONS, group, runId) });
		const seeds = [1, 2, 3, 4].map(n => seedOf("e2e-seed", `run-20000101-00000${n}-e2e0`, `Seed${n}`, Date.UTC(2000, 0, 1, 0, 0, n)));
		const rogues = [1, 2].map(n => seedOf("e2e-rogue", `run-19990101-00000${n}-e2e0`, `Rogue${n}`, Date.UTC(1999, 0, 1, 0, 0, n)));
		const seedRecords = (seed: Seed): string[] =>
			[`${seed.agent}.jsonl`, `${seed.agent}.json`, join(seed.agent, `${seed.agent}.Sub.jsonl`)].map(file => join(seed.dir, file));
		const seedOutputs = (seed: Seed): string[] => [`${seed.agent}.md`, join(seed.agent, `${seed.agent}.Sub.md`)].map(file => join(seed.dir, file));
		mkdirSync(join(stateDir, "runs"), { recursive: true });
		for (const seed of [...seeds, ...rogues]) {
			mkdirSync(join(seed.dir, seed.agent), { recursive: true });
			writeFileSync(`${seed.dir}.jsonl`, "{}\n");
			for (const file of [...seedRecords(seed), ...seedOutputs(seed)]) writeFileSync(file, "seed\n");
			const iso = new Date(seed.at).toISOString();
			const record = {
				schema: "storm.run/v1",
				runId: seed.runId,
				configHash: "jcs-sha256:e2e-seed",
				approvalId: "e2e-seed",
				startedAt: iso,
				endedAt: iso,
				status: "done",
				contract: "workflowz",
				task: "E2E seed",
				costUsd: 0,
				costByModel: {},
				spawns: [],
				artifactsDir: seed.dir,
				process: DEAD_PROCESS,
				agents: [
					{
						id: seed.agent,
						name: "storm-implementer",
						role: "implementer",
						runId: seed.runId,
						model: "fake/general-b",
						state: "parked",
						startedAt: seed.at,
						lastActivityAt: seed.at,
						contextTokens: 100,
						requests: 1,
						costUsd: 0,
						followUps: 0,
					},
				],
			};
			writeFileSync(join(stateDir, "runs", `${seed.runId}.json`), `${JSON.stringify(record, null, 2)}\n`);
		}
		// Trusted list: oldest first, so the seeds go before whatever the earlier runs recorded.
		const trustedSeeds = seeds.map(seed =>
			JSON.stringify({ runId: seed.runId, artifactsDir: seed.dir, process: DEAD_PROCESS, agents: [seed.agent], endedAt: new Date(seed.at).toISOString() }),
		);
		const trustedBefore = existsSync(trustedFile) ? readFileSync(trustedFile, "utf8").split("\n").filter(Boolean) : [];
		writeFileSync(trustedFile, `${[...trustedSeeds, ...trustedBefore].join("\n")}\n`);
		const seedRun = (runId: string): StoredRun | undefined => runFiles().find(stored => stored.runId === runId);
		const present = (files: string[]): boolean[] => files.map(file => existsSync(file));
		const cheapRun = runTask([planStep([{ name: "impl", kind: "code" }])]);
		const allSeedFiles = [...seeds, ...rogues].flatMap(seed => [...seedRecords(seed), ...seedOutputs(seed)]);
		const rogueFiles = rogues.flatMap(seed => [...seedRecords(seed), ...seedOutputs(seed)]);

		// Cleanup absent (and docs off, D1/D3): nothing of the seeded agents is removed.
		const keepAll = readConfig();
		delete keepAll.cleanup;
		keepAll.docs = false;
		await converse(`/storm STORM-TOOL ${JSON.stringify({ action: "propose", config: keepAll, rationale: "E2E" })}`, choose("승인"));
		team = readConfig();
		run = await spawn(["storm-implementer"]);
		check(
			"문서 정합(끔): docs:false 를 승인하면 storm 역할 시스템 프롬프트에 문서 규칙 없음",
			team.docs === false && run.children.length === 1 && run.children[0]?.docRules === false,
			`docs=${team.docs} children=${run.children.length} docRules=${run.children[0]?.docRules}`,
		);
		await converse(cheapRun, noAnswer);
		const keptRun = runFiles().at(-1);
		check(
			"실행 정리(끔): cleanup 이 없으면 이전 실행 하위 기록을 지우지 않음",
			team.cleanup === undefined &&
				present(allSeedFiles).every(Boolean) &&
				seeds.every(seed => seedRun(seed.runId)?.agents?.[0]?.cleanedAt === undefined) &&
				!keptRun?.cleanup?.agents,
			`cleanup=${team.cleanup} present=${present(allSeedFiles).filter(Boolean).length}/${allSeedFiles.length} live=${JSON.stringify(keptRun?.cleanup)}`,
		);

		// Cleanup approved (start and end config): the run end removes the trusted older runs' agents' records, keeps
		// every output (.md), and leaves runs that are only in the repo alone.
		const cleanAll = readConfig();
		cleanAll.cleanup = true;
		delete cleanAll.docs;
		await converse(`/storm STORM-TOOL ${JSON.stringify({ action: "propose", config: cleanAll, rationale: "E2E" })}`, choose("승인"));
		team = readConfig();
		talk = await converse(cheapRun, noAnswer);
		const cleanRun = runFiles().at(-1);
		const oldest = seeds[0];
		const oldestRun = oldest ? seedRun(oldest.runId) : undefined;
		check(
			"실행 정리(켬): 가장 오래된 신뢰 실행 에이전트의 기록(.jsonl·.json·하위 .jsonl)만 지우고 .md 는 남김",
			team.cleanup === true &&
				oldest !== undefined &&
				present(seedRecords(oldest)).every(exists => !exists) &&
				present(seedOutputs(oldest)).every(Boolean),
			oldest ? `records=${present(seedRecords(oldest)).join(",")} outputs=${present(seedOutputs(oldest)).join(",")}` : "no seed",
		);
		check(
			"실행 정리(켬): 저장소에만 있는 실행 기록은 신뢰하지 않아 아무것도 지우지 않음",
			present(rogueFiles).every(Boolean) && rogues.every(seed => seedRun(seed.runId)?.agents?.[0]?.cleanedAt === undefined),
			`present=${present(rogueFiles).filter(Boolean).length}/${rogueFiles.length}`,
		);
		const trustedOldest = (existsSync(trustedFile) ? readFileSync(trustedFile, "utf8").split("\n").filter(Boolean) : [])
			.map(line => JSON.parse(line) as { runId: string; cleaned?: string[] })
			.find(entry => entry.runId === oldest?.runId);
		check(
			"실행 정리(켬): 신뢰 목록·실행 기록에 정리 표시, 이번 실행 기록에 cleanup.agents",
			trustedOldest?.cleaned?.includes(oldest?.agent ?? "") === true &&
				oldestRun?.agents?.[0]?.cleanedAt !== undefined &&
				(cleanRun?.cleanup?.agents ?? 0) >= 1,
			`trusted=${JSON.stringify(trustedOldest?.cleaned)} cleanedAt=${oldestRun?.agents?.[0]?.cleanedAt} cleanup=${JSON.stringify(cleanRun?.cleanup)}`,
		);
		check("실행 정리(켬): 결과 보고에 정리 한 줄", talk.frames.some(frame => textOf(frame).includes("정리: 이전 실행 하위 기록")));
		// B3: the hub panel shows what Storm keeps on disk and the last cleanup.
		frames = await command("/storm", noAnswer);
		const storageLine = frames.map(textOf).find(text => text.includes("저장: Storm 데이터"));
		check(
			"허브: 저장 데이터 한 줄(Storm 데이터·남은 omp 기록·마지막 정리)",
			storageLine?.includes("남은 omp 기록") === true && storageLine.includes("마지막 정리"),
			storageLine?.match(/저장: Storm 데이터[^"\\]*/)?.[0] ?? "no storage line",
		);

		let hash = configHashOnDisk();
		let approvals = approvalFiles().length;
		const priorityRequest = '/storm STORM-TOOL {"action":"priority","priority":"cost"}';
		talk = await converse(priorityRequest, choose("취소"));
		check("자연어 변경: 승인 창 표시", uiTitled(talk.frames, "이 변경을 승인할까요"));
		check("자연어 변경: 취소하면 그대로", configHashOnDisk() === hash && approvalFiles().length === approvals && proposalFiles().length === 0);
		await converse(priorityRequest, choose("승인"));
		team = readConfig();
		check("자연어 변경: 승인하면 적용", team.priority === "cost" && approvalFiles().length === approvals + 1, `priority=${team.priority}`);

		hash = configHashOnDisk();
		approvals = approvalFiles().length;
		await converse('/storm STORM-TOOL {"action":"workers","role":"reviewer","min":1,"max":3}', noAnswer, { flags: ["--no-ui"] });
		check(
			"UI 없음: 제안만 보류",
			configHashOnDisk() === hash && approvalFiles().length === approvals && proposalFiles().length === 1,
			`proposals=${proposalFiles().length}`,
		);
		await command("/storm", request => {
			const options = (request.options as string[] | undefined) ?? [];
			if (request.title === "Storm 메뉴") return options.find(option => option.startsWith("보류 제안 승인"));
			if (String(request.title).startsWith("보류 중인 변경 제안")) return options[0];
			return options.includes("승인") ? "승인" : undefined;
		});
		team = readConfig();
		const reviewerWorkers = team.roles.reviewer?.workers;
		check(
			"메뉴: 보류 제안 승인",
			typeof reviewerWorkers === "object" && reviewerWorkers.min === 1 && reviewerWorkers.max === 3 && proposalFiles().length === 0,
			`workers=${JSON.stringify(reviewerWorkers)}`,
		);

		const implementerModels = team.roles.implementer?.models ?? [];
		const fallback = implementerModels.find(model => providerOf(model) !== providerOf(implementerModels[0]));
		if (fallback) {
			hash = configHashOnDisk();
			await converse(`/storm STORM-TOOL {"action":"quota","provider":"${providerOf(implementerModels[0])}"}`, noAnswer);
			check("쿼터 대응: 승인 없이 표시만", configHashOnDisk() === hash && existsSync(join(stateDir, "quota-marks.json")));
			run = await spawn(["storm-implementer"]);
			check("쿼터 대응: 다른 Provider 폴백으로", run.children[0]?.model === idOf(fallback), `child=${run.children[0]?.model} expected=${idOf(fallback)}`);
			rmSync(join(stateDir, "quota-marks.json"), { force: true });
		} else console.log(`SKIP 쿼터 대응: 구현 역할의 폴백이 다른 Provider에 없음 (${implementerModels.join(", ")})`);

		// omp itself leaves a model after provider errors: Storm marks that provider (source "fallback") and says so, with no approval.
		hash = configHashOnDisk();
		writeFileSync(join(AGENT_DIR, "models.yml"), modelsYml(true));
		writeFileSync(join(AGENT_DIR, "config.yml"), FALLBACK_CONFIG);
		try {
			talk = await converse("hello", noAnswer, { model: "fake3/quota-out" });
		} finally {
			writeFileSync(join(AGENT_DIR, "models.yml"), modelsYml());
			writeFileSync(join(AGENT_DIR, "config.yml"), PROFILE_CONFIG);
		}
		const marksFile = join(stateDir, "quota-marks.json");
		const marks = existsSync(marksFile) ? (JSON.parse(readFileSync(marksFile, "utf8")) as { marks: Array<{ provider: string; source: string }> }).marks : [];
		check(
			"자동 쿼터 표시: omp 폴백이면 Provider 표시(승인 없이)",
			marks.some(mark => mark.provider === "fake3" && mark.source === "fallback") && configHashOnDisk() === hash,
			JSON.stringify(marks),
		);
		check("자동 쿼터 표시: 알림", talk.frames.some(frame => textOf(frame).includes("fake3 를 5시간 동안 쿼터 소진으로 표시")));
		rmSync(marksFile, { force: true });

		primary = team.roles.implementer?.models[0];
		const candidate = ["fake/general-b", "fake2/general-e", "fake/cheap-a"].find(model => model !== bare(primary)) ?? "fake/general-b";
		await converse(
			`/storm STORM-TOOL {"action":"trial","role":"implementer","model":"${candidate}","share":0.5,"maxSpawns":1,"days":1,"budgetUsd":1}`,
			choose("승인"),
		);
		team = readConfig();
		check("시험 사용: 승인 후 설정에 추가", (team.trials?.length ?? 0) === 1);
		const routedTo: Array<string | undefined> = [];
		for (let i = 0; i < 3; i++) routedTo.push((await spawn(["storm-implementer"])).children[0]?.model);
		check(
			"시험 사용: 비율·횟수대로 라우팅",
			routedTo.join(",") === [idOf(primary), idOf(candidate), idOf(primary)].join(","),
			`${routedTo.join(",")} expected=${idOf(primary)},${idOf(candidate)},${idOf(primary)}`,
		);
		frames = await command("/storm", request => (String(request.title).startsWith("시험 사용이 끝났습니다") ? "나중에" : undefined));
		check("시험 사용: 끝나면 교체 여부 질문", uiTitled(frames, "시험 사용이 끝났습니다"));

		await converse('/storm STORM-TOOL {"action":"budget","budgetUsd":0.0005}', choose("승인"));
		team = readConfig();
		check("예산: 승인 후 설정", team.budget?.perRunUsd === 0.0005, JSON.stringify(team.budget));
		talk = await converse(runTask([planStep([{ name: "impl", kind: "code" }]), { task: ["storm-implementer"] }]), noAnswer, {
			model: OUTSIDER,
		});
		const budgetRun = runFiles().at(-1);
		check(
			"예산: 넘으면 새 스폰 차단",
			talk.frames.some(frame => textOf(frame).includes("Storm 실행 예산")) && !talk.llm.some(entry => entry.child),
			`children=${talk.llm.filter(entry => entry.child).length}`,
		);
		check("예산: 실행 기록", budgetRun?.status === "budget-exceeded", `status=${budgetRun?.status}`);

		// A role set to "사용 안 함" is refused; a role missing from the config borrows its nearest stand-in's models.
		const trimmed = readConfig();
		const implementerPrimary = trimmed.roles.implementer?.models[0];
		delete trimmed.roles.reviewer;
		delete trimmed.roles.quick;
		trimmed.disabledRoles = ["reviewer"];
		await converse(`/storm STORM-TOOL ${JSON.stringify({ action: "propose", config: trimmed, rationale: "E2E" })}`, choose("승인"));
		team = readConfig();
		check(
			"사용 안 함: 승인 후 설정",
			team.disabledRoles?.includes("reviewer") === true && team.roles.reviewer === undefined,
			JSON.stringify(team.disabledRoles),
		);
		run = await spawn(["storm-reviewer"]);
		check("사용 안 함: 그 역할 스폰은 막힘", run.results.includes("사용 안 함") && run.children.length === 0, run.results.slice(0, 200));
		run = await spawn(["storm-quick"]);
		check(
			"설정에 없는 역할: 가까운 역할(구현) 모델로",
			run.children[0]?.model === idOf(implementerPrimary),
			`child=${run.children[0]?.model} expected=${idOf(implementerPrimary)}`,
		);

		// An agent at or past its context cap takes no follow-ups during a run: the director must start a fresh one.
		const capped = readConfig();
		capped.contextCap = 50;
		delete capped.budget;
		await converse(`/storm STORM-TOOL ${JSON.stringify({ action: "propose", config: capped, rationale: "E2E" })}`, choose("승인"));

		// A2: past its cap, the director is compacted while it waits on an async child, and the compaction request carries
		// Storm's ledger. omp keeps the last 20k tokens verbatim by default, so this tiny session would have nothing to
		// summarize: the profile keeps almost nothing for this one run. The child's first reply waits so the turn ends first.
		writeFileSync(join(AGENT_DIR, "config.yml"), `${PROFILE_CONFIG}compaction:\n  keepRecentTokens: 100\n`);
		try {
			// `wait` holds the director's reply after the spawn ~1 s, as a real model's would take: by then the child has
			// started its first turn and Storm's ledger knows it.
			talk = await converse(
				runTask([planStep([{ name: "ckpt", kind: "code" }]), { task: ["storm-implementer"], say: "SPIKE-CHILD-SLOW" }, { wait: 1_000 }]),
				noAnswer,
			);
		} finally {
			writeFileSync(join(AGENT_DIR, "config.yml"), PROFILE_CONFIG);
		}
		const checkpointRun = runFiles().at(-1);
		const compactions = talk.llm.filter(entry => entry.compaction);
		const ledgerContext = compactions.find(
			entry => entry.compactionContext.includes("Storm 실행") && entry.compactionContext.includes("- ckpt (") && entry.compactionContext.includes("agent://Spike0 —"),
		);
		check(
			"감독 압축: 상한 넘은 감독이 하위를 기다릴 때 압축, 요청에 레인·agent:// 장부",
			ledgerContext !== undefined,
			`compactions=${compactions.length} context=${(compactions[0]?.compactionContext ?? "").slice(0, 400).replace(/\s+/g, " ")}`,
		);
		check(
			"감독 압축: 실행 기록에 압축 1회(시각·전후 토큰)",
			checkpointRun?.checkpoints?.length === 1 && checkpointRun.checkpoints[0]?.before !== undefined,
			JSON.stringify(checkpointRun?.checkpoints),
		);

		talk = await converse(runTask([planStep([{ name: "impl", kind: "code" }]), { task: ["storm-implementer"] }, { write: "agent://Spike0" }]), noAnswer);
		const capRun = runFiles().at(-1);
		check(
			"컨텍스트 상한: 넘은 에이전트로 가는 후속 지시는 막힘",
			readConfig().contextCap === 50 && talk.frames.some(frame => textOf(frame).includes("컨텍스트 상한")) && capRun?.blockedFollowUps === 1,
			`blockedFollowUps=${capRun?.blockedFollowUps}`,
		);
		// A3: the reason the director gets back names the capped agent's result to hand to a fresh agent.
		const capReason = talk.llm.find(entry => !entry.child && entry.lastTool.includes("후속 지시를 막았습니다"))?.lastTool;
		check(
			"컨텍스트 상한: 막힘 사유에 새 에이전트가 agent://<id> 를 읽고 이어 가라는 안내",
			capReason?.includes("새 storm-implementer 를 띄워") === true && capReason.includes("agent://Spike0 의 결과를 읽고 이어서 진행하라"),
			capReason?.slice(0, 300) ?? "no reason",
		);

		// A heavy main session is asked whether to compact before the run starts; cancelling starts nothing.
		const runsBefore = runFiles().length;
		talk = await converse(runTask([planStep([{ name: "impl", kind: "code" }])]), choose("취소"), { model: "fake/heavy-main" });
		check(
			"실행 전 점검: 메인 컨텍스트가 크면 묻고, 취소하면 시작 안 함",
			uiTitled(talk.frames, "메인 세션 컨텍스트가 큽니다") && runFiles().length === runsBefore,
			`runs=${runFiles().length}/${runsBefore}`,
		);

		const approvalsBeforeReset = approvalFiles().length;
		frames = await command("/storm", request => (request.title === "Storm 메뉴" ? "초기화" : choose("취소")(request)));
		check(
			"초기화: 메뉴에서 확인 한 번, 취소하면 그대로",
			uiTitled(frames, "Storm 설정과 기록을 모두 지울까요") && existsSync(CONFIG) && approvalFiles().length === approvalsBeforeReset,
		);
		// The reset shortcut opens the same confirmation directly; "초기화" keeps the run summary index (B4).
		const indexBeforeReset = runIndex().length;
		frames = await command("/storm reset", choose("초기화"));
		const leftAfterReset = existsSync(join(PROJECT, ".omp", "storm"))
			? readdirSync(join(PROJECT, ".omp", "storm"), { recursive: true, withFileTypes: true })
					.filter(entry => entry.isFile())
					.map(entry => join(entry.parentPath, entry.name))
			: [];
		check(
			"초기화: 설정과 승인 기록을 한 번에 삭제",
			frames.filter(frame => frame.type === "extension_ui_request" && frame.method === "select").length === 1 &&
				!existsSync(CONFIG) &&
				leftAfterReset.every(file => file === runIndexFile || file === join(PROJECT, ".omp", "storm", ".gitignore")) &&
				approvalsBeforeReset > 0 &&
				approvalFiles().length === 0,
			`approvals=${approvalFiles().length}/${approvalsBeforeReset} left=${leftAfterReset.join(",")}`,
		);
		const gitAfterReset = Bun.spawnSync(["git", "-C", PROJECT, "status", "--porcelain", "--untracked-files=all"]).stdout.toString().trim();
		check(
			"초기화: 기본(초기화) 선택이면 실행 요약 색인은 남김",
			indexBeforeReset > 0 && runIndex().length === indexBeforeReset && !gitAfterReset.includes("index.jsonl"),
			`index=${runIndex().length}/${indexBeforeReset} git=${gitAfterReset.replace(/\n/g, "; ") || "clean"}`,
		);
		run = await spawn(["storm-implementer", "task"]);
		check("초기화 후: storm 역할 차단", run.results.includes("Storm 설정이 없습니다"));
		check("초기화 후: 일반 에이전트 정상", run.children.length === 1);
		check("초기화 후: storm 도구 없음", run.main.length > 0 && run.main.every(entry => !entry.tools.includes("storm")));
	} finally {
		server.kill();
		await server.exited;
		// E2E_KEEP=1 leaves the project, the LLM log and the profile for a look after a failure.
		if (!process.env.E2E_KEEP) {
			rmSync(WORK, { recursive: true, force: true });
			rmSync(PROFILE_ROOT, { recursive: true, force: true });
		}
	}
	console.log(failures.length === 0 ? "\nE2E: all passed" : `\nE2E: ${failures.length} failed: ${failures.join(", ")}`);
	process.exit(failures.length === 0 ? 0 : 1);
}

await main();
