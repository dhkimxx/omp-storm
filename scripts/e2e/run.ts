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
		check(
			"도구: 설정 없는 프로젝트엔 storm 도구 없음",
			run.main.length > 0 && run.main.every(entry => !entry.tools.includes("storm")),
			`main=${run.main.length}`,
		);

		let frames = await command("/storm", setupAnswers);
		const config = existsSync(CONFIG) ? (JSON.parse(readFileSync(CONFIG, "utf8")) as { roles: Record<string, { models: string[]; effort?: string }> }) : undefined;
		check("setup: 설정 저장", config !== undefined);
		check("setup: 승인 기록", approvalFiles().length === 1, `approvals=${approvalFiles().length}`);
		check("setup: .gitignore", existsSync(join(PROJECT, ".omp", "storm", ".gitignore")));
		check("setup: 현황 보고", frames.some(frame => textOf(frame).includes("Storm 현황")));
		const implementer = config?.roles.implementer;
		const primaryEntry = implementer?.models[0] === undefined ? undefined : parseModelEntry(implementer.models[0]);
		const expectedModel = primaryEntry?.selector.split("/").slice(1).join("/");
		const expectedEffort = primaryEntry?.effort ?? implementer?.effort;

		run = await spawn(["storm-implementer"]);
		const child = run.children[0];
		check("승인 후: 승인 모델로 교체", child?.model === expectedModel, `child=${child?.model} expected=${expectedModel}`);
		check("승인 후: effort 전달", expectedEffort === undefined || child?.effort === expectedEffort, `effort=${child?.effort} expected=${expectedEffort}`);
		check(
			"도구: 설정 있으면 메인 세션에만 storm 도구",
			run.main.length > 0 && run.main.every(entry => entry.tools.includes("storm")) && run.children.every(entry => !entry.tools.includes("storm")),
			`main=${run.main.map(entry => entry.tools.includes("storm")).join(",")} children=${run.children.map(entry => entry.tools.includes("storm")).join(",")}`,
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
		check("허브: 현황 보고", frames.some(frame => textOf(frame).includes("Storm 현황")));
		check("허브: Storm 버전", frames.some(frame => textOf(frame).includes(`- Storm ${STORM_VERSION}`)));
		check("허브: 수명 관리 경고", frames.some(frame => textOf(frame).includes("### 수명 관리")));
		const menu = frames.find(frame => frame.type === "extension_ui_request" && frame.title === "Storm 메뉴")?.options as string[] | undefined;
		check(
			"허브: 현황 뒤 메뉴(있는 것만)",
			JSON.stringify(menu) === JSON.stringify(["팀 다시 설정", "모델 점검", "이전 설정으로 되돌리기", "초기화", "닫기"]),
			JSON.stringify(menu),
		);

		// ── v0.2: runs, natural-language changes, deferral, quota, trial, budget ──
		type StoredRole = { models: string[]; effort?: string; workers?: number };
		type StoredConfig = { priority: string; roles: Record<string, StoredRole>; trials?: unknown[]; budget?: { perRunUsd: number } };
		type StoredAgent = { id: string; role?: string; model?: string; contextTokens: number; state: string; followUps: number };
		type StoredRun = {
			status: string;
			contract: string;
			spawns: Array<{ outcome: string; agent: string; spawnKey?: string }>;
			agents?: StoredAgent[];
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
		/** A main model outside the approved team: non-Storm agents ask for it unless Storm swaps it. */
		const OUTSIDER = "fake/premium-c";

		let team = readConfig();
		let primary = team.roles.implementer?.models[0];
		check(
			"v0.2 전제: 대체 확인용 모델은 승인 밖",
			!Object.values(team.roles).some(role => role.models.some(model => bare(model) === OUTSIDER)),
		);
		let talk = await converse('/storm STORM-TOOL {"action":"run","task":"SPIKE-TASK storm-implementer task"}', noAnswer, { model: OUTSIDER });
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
		await converse('/storm STORM-TOOL {"action":"workers","role":"reviewer","workers":3}', noAnswer, { flags: ["--no-ui"] });
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
		check("메뉴: 보류 제안 승인", team.roles.reviewer?.workers === 3 && proposalFiles().length === 0, `workers=${team.roles.reviewer?.workers}`);

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
		talk = await converse('/storm STORM-TOOL {"action":"run","task":"SPIKE-TASK storm-implementer"}', noAnswer, { model: OUTSIDER });
		const budgetRun = runFiles().at(-1);
		check(
			"예산: 넘으면 새 스폰 차단",
			talk.frames.some(frame => textOf(frame).includes("Storm 실행 예산")) && !talk.llm.some(entry => entry.child),
			`children=${talk.llm.filter(entry => entry.child).length}`,
		);
		check("예산: 실행 기록", budgetRun?.status === "budget-exceeded", `status=${budgetRun?.status}`);

		const approvalsBeforeReset = approvalFiles().length;
		frames = await command("/storm", request => (request.title === "Storm 메뉴" ? "초기화" : choose("취소")(request)));
		check(
			"초기화: 메뉴에서 확인 한 번, 취소하면 그대로",
			uiTitled(frames, "Storm 설정과 기록을 모두 지울까요") && existsSync(CONFIG) && approvalFiles().length === approvalsBeforeReset,
		);
		// The reset shortcut opens the same confirmation directly.
		frames = await command("/storm reset", choose("초기화"));
		check(
			"초기화: 설정과 승인 기록을 한 번에 삭제",
			frames.filter(frame => frame.type === "extension_ui_request" && frame.method === "select").length === 1 &&
				!existsSync(join(PROJECT, ".omp", "storm")) &&
				approvalsBeforeReset > 0 &&
				approvalFiles().length === 0,
			`approvals=${approvalFiles().length}/${approvalsBeforeReset}`,
		);
		run = await spawn(["storm-implementer", "task"]);
		check("초기화 후: storm 역할 차단", run.results.includes("Storm 설정이 없습니다"));
		check("초기화 후: 일반 에이전트 정상", run.children.length === 1);
		check("초기화 후: storm 도구 없음", run.main.length > 0 && run.main.every(entry => !entry.tools.includes("storm")));
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
