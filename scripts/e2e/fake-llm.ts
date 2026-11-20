#!/usr/bin/env bun
/**
 * Scripted OpenAI-compatible chat-completions server for the OMP Storm P0 spike.
 *
 * omp talks to it as an `openai-completions` provider, so every request omp would send to a
 * real model lands here instead: no paid calls, deterministic replies, and a JSONL record of
 * each request (model id, tools, keyword notices, role markers) for the driver to inspect.
 *
 * Directives are read from user-role text that arrived after the last assistant message:
 *   <storm-setup>           call `storm` with action "propose", the <storm-recommended-config> JSON and rationale "E2E"
 *   SPIKE-TASK <agent...>   call `task` with one item per agent
 *   SPIKE-EVAL <agent...>   call `eval` (python) that spawns each agent through agent()
 *   SPIKE-APPROVE           call the spike extension's `storm_spike_approve` tool
 *   SPIKE-SLOW              stream a ~4 s text reply so messages can be queued mid-stream
 *   SPIKE-WRITE <path>      call `write` with that path (director mode blocks it inside a Storm run)
 * Spawned children (assignment contains CHILD_MARK) finish through `yield` when offered.
 *
 * Env: FAKE_LLM_PORT (default 18555), FAKE_LLM_LOG (default /tmp/storm-p0/llm.jsonl).
 */
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

interface JsonSchema {
	type?: string | string[];
	properties?: Record<string, JsonSchema>;
	required?: string[];
	enum?: unknown[];
	default?: unknown;
	anyOf?: JsonSchema[];
	oneOf?: JsonSchema[];
}
interface Tool {
	type: "function";
	function: { name: string; description?: string; parameters?: JsonSchema };
}
interface Message {
	role: string;
	content?: unknown;
}
interface ChatRequest {
	model: string;
	messages: Message[];
	tools?: Tool[];
	stream?: boolean;
	/** OpenAI-compatible reasoning effort; omp sends it when a model pattern carries a `:level` suffix. */
	reasoning_effort?: string;
	reasoning?: { effort?: string };
}
type Decision =
	| { kind: "text"; text: string; slow?: boolean }
	| { kind: "tool"; name: string; args: Record<string, unknown> };

const PORT = Number(process.env.FAKE_LLM_PORT ?? 18555);
const LOG = process.env.FAKE_LLM_LOG ?? "/tmp/storm-p0/llm.jsonl";
const TASK_TOOL_DUMP = join(dirname(LOG), "task-tool.txt");
const CHILD_MARK = "spike child";
/** Opening sentences of omp's hidden keyword notices (prompts/system/*-notice.md). */
const NOTICES = {
	workflowz: "deterministic multi-subagent workflow",
	orchestrate: "orchestration request",
} as const;
const STORM_AGENTS = ["storm-implementer", "storm-reviewer"];
/** Model id that always fails with an out-of-quota 429. */
const QUOTA_OUT = "quota-out";
/** A reviewer's verdict for agents whose yield schema asks for one (storm-reviewer): one P1 finding, so the run record has something to count. */
const REVIEW_VERDICT = {
	overall_correctness: "incorrect",
	explanation: "E2E verdict",
	confidence: 0.8,
	findings: [{ title: "E2E finding", body: "E2E", priority: 1, confidence: 0.8, file_path: "README.md", line_start: 1, line_end: 1 }],
};

mkdirSync(dirname(LOG), { recursive: true });

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map(part => (part && typeof part === "object" && "text" in part ? String(part.text) : ""))
		.join("\n");
}

function schemaOf(tools: Tool[] | undefined, name: string): JsonSchema | undefined {
	return tools?.find(tool => tool.function.name === name)?.function.parameters;
}

/** Smallest value that satisfies a JSON schema node. */
function sample(schema: JsonSchema | undefined): unknown {
	if (!schema) return "OK";
	if (schema.enum?.length) return schema.enum[0];
	if (schema.default !== undefined) return schema.default;
	const variant = schema.anyOf?.[0] ?? schema.oneOf?.[0];
	if (variant) return sample(variant);
	const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
	if (type === "object") return requiredArgs(schema);
	if (type === "array") return [];
	if (type === "boolean") return true;
	if (type === "number" || type === "integer") return 0;
	if (type === "null") return null;
	return "OK";
}

function requiredArgs(schema: JsonSchema | undefined): Record<string, unknown> {
	const args: Record<string, unknown> = {};
	for (const key of schema?.required ?? []) args[key] = sample(schema?.properties?.[key]);
	return args;
}

function taskCall(tools: Tool[] | undefined, agents: string[]): Decision {
	const item = (agent: string, index: number) => ({
		name: `Spike${index}`,
		agent,
		task: `Reply with OK (${CHILD_MARK} ${index}).`,
		solutionSpace: "spike: fixed reply",
	});
	const batch = Boolean(schemaOf(tools, "task")?.properties?.tasks);
	const args = batch ? { context: "OMP Storm P0 spike", tasks: agents.map(item) } : item(agents[0] ?? "task", 0);
	return { kind: "tool", name: "task", args };
}

function evalCall(tools: Tool[] | undefined, agents: string[]): Decision {
	const code = [
		"out = []",
		"handles = []",
		`for name in ${JSON.stringify(agents)}:`,
		"    try:",
		`        handles.append(agent("Reply with OK (${CHILD_MARK} eval).", agent=name))`,
		"        out.append([name, 'spawned'])",
		"    except Exception as error:",
		"        out.append([name, 'error: ' + str(error)[:300]])",
		"if handles:",
		"    try:",
		"        out.append(['wait', str(wait(handles, raise_errors=False))[:800]])",
		"    except Exception as error:",
		"        out.append(['wait error', str(error)[:300]])",
		"print(out)",
	].join("\n");
	return { kind: "tool", name: "eval", args: { ...requiredArgs(schemaOf(tools, "eval")), language: "py", code } };
}

function decide(request: ChatRequest): Decision {
	const messages = request.messages;
	if (messages.at(-1)?.role === "tool") return { kind: "text", text: "done" };
	const lastAssistant = messages.findLastIndex(message => message.role === "assistant");
	const fresh = messages
		.slice(lastAssistant + 1)
		.filter(message => message.role === "user")
		.map(message => textOf(message.content))
		.join("\n");
	// Checked first: a setup request carries candidate text that must not trigger other directives.
	if (fresh.includes("<storm-setup>")) {
		const config = fresh.match(/<storm-recommended-config>([\s\S]*?)<\/storm-recommended-config>/)?.[1];
		if (config) return { kind: "tool", name: "storm", args: { action: "propose", config: JSON.parse(config) as unknown, rationale: "E2E" } };
	}
	// A storm-tool argument (e.g. a run's task) may itself carry a SPIKE directive.
	const stormTool = fresh.match(/STORM-TOOL[ \t]+(\{.*\})/);
	if (stormTool?.[1]) return { kind: "tool", name: "storm", args: JSON.parse(stormTool[1]) as Record<string, unknown> };
	const spawn = fresh.match(/SPIKE-(TASK|EVAL)((?:[ \t]+[\w.-]+)+)/);
	if (spawn) {
		const agents = spawn[2].trim().split(/\s+/);
		return spawn[1] === "TASK" ? taskCall(request.tools, agents) : evalCall(request.tools, agents);
	}
	if (fresh.includes("SPIKE-APPROVE")) return { kind: "tool", name: "storm_spike_approve", args: {} };
	if (fresh.includes("SPIKE-SLOW")) return { kind: "text", text: "slow reply ".repeat(8).trim(), slow: true };
	const write = fresh.match(/SPIKE-WRITE[ \t]+(\S+)/);
	if (write?.[1]) return { kind: "tool", name: "write", args: { path: write[1], content: "storm director check\n" } };
	const yieldSchema = schemaOf(request.tools, "yield");
	if (fresh.includes(CHILD_MARK) && yieldSchema) {
		const args = requiredArgs(yieldSchema);
		if (!JSON.stringify(yieldSchema).includes("overall_correctness")) return { kind: "tool", name: "yield", args };
		// Strict schemas make every key required but nullable: null out the others so `data` stands alone (data xor error).
		return { kind: "tool", name: "yield", args: { ...Object.fromEntries(Object.keys(args).map(key => [key, null])), data: REVIEW_VERDICT } };
	}
	return { kind: "text", text: "OK" };
}

function record(request: ChatRequest, decision: Decision): void {
	const messages = request.messages.map((message, index) => ({ index, role: message.role, text: textOf(message.content) }));
	const where = (needle: string) => messages.filter(entry => entry.text.includes(needle)).map(entry => `${entry.index}:${entry.role}`);
	const marks: Record<string, string[]> = {};
	for (const entry of messages)
		for (const mark of entry.text.match(/SPIKE-MARK [\w-]+/g) ?? []) (marks[mark] ??= []).push(`${entry.index}:${entry.role}`);
	const taskTool = request.tools?.find(tool => tool.function.name === "task")?.function;
	if (taskTool && !existsSync(TASK_TOOL_DUMP)) writeFileSync(TASK_TOOL_DUMP, `${taskTool.description ?? ""}\n\n${JSON.stringify(taskTool.parameters, null, 2)}`);
	const entry = {
		ts: Date.now(),
		model: request.model,
		stream: request.stream === true,
		effort: request.reasoning_effort ?? request.reasoning?.effort ?? null,
		tools: request.tools?.map(tool => tool.function.name) ?? [],
		lastRole: request.messages.at(-1)?.role,
		marks,
		notices: { workflowz: where(NOTICES.workflowz), orchestrate: where(NOTICES.orchestrate) },
		roles: [...new Set(messages.flatMap(entry => [...entry.text.matchAll(/STORM-ROLE ([\w-]+)/g)].map(match => match[1])))],
		spike: [...new Set(messages.filter(entry => entry.role === "user").flatMap(entry => entry.text.match(/SPIKE-[A-Z]+/g) ?? []))],
		child: messages.some(entry => entry.role === "user" && entry.text.includes(CHILD_MARK)),
		taskToolAgents: STORM_AGENTS.filter(name => taskTool?.description?.includes(name) || JSON.stringify(taskTool?.parameters ?? {}).includes(name)),
		users: messages.filter(entry => entry.role === "user").map(entry => `${entry.index}: ${entry.text.slice(0, 120).replace(/\s+/g, " ")}`),
		decision: decision.kind === "tool" ? { tool: decision.name, args: decision.args } : { text: decision.text.slice(0, 40), slow: decision.slow === true },
	};
	appendFileSync(LOG, `${JSON.stringify(entry)}\n`);
}

const encoder = new TextEncoder();

function chunk(id: string, model: string, delta: Record<string, unknown>, finish: string | null): string {
	const created = Math.floor(Date.now() / 1000);
	return `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
}

function stream(model: string, decision: Decision): Response {
	const id = `chatcmpl-${crypto.randomUUID()}`;
	const usage = { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 };
	const body = new ReadableStream<Uint8Array>({
		async start(controller) {
			const send = (text: string) => controller.enqueue(encoder.encode(text));
			if (decision.kind === "text") {
				send(chunk(id, model, { role: "assistant", content: "" }, null));
				const words = decision.slow ? decision.text.split(" ") : [decision.text];
				for (const word of words) {
					send(chunk(id, model, { content: decision.slow ? `${word} ` : word }, null));
					if (decision.slow) await Bun.sleep(500);
				}
				send(chunk(id, model, {}, "stop"));
			} else {
				const call = { index: 0, id: `call_${crypto.randomUUID().slice(0, 8)}`, type: "function", function: { name: decision.name, arguments: JSON.stringify(decision.args) } };
				send(chunk(id, model, { role: "assistant", content: null, tool_calls: [call] }, null));
				send(chunk(id, model, {}, "tool_calls"));
			}
			send(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [], usage })}\n\n`);
			send("data: [DONE]\n\n");
			controller.close();
		},
	});
	return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
}

function completion(model: string, decision: Decision): Response {
	const message =
		decision.kind === "text"
			? { role: "assistant", content: decision.text }
			: { role: "assistant", content: null, tool_calls: [{ id: `call_${crypto.randomUUID().slice(0, 8)}`, type: "function", function: { name: decision.name, arguments: JSON.stringify(decision.args) } }] };
	return Response.json({
		id: `chatcmpl-${crypto.randomUUID()}`,
		object: "chat.completion",
		created: Math.floor(Date.now() / 1000),
		model,
		choices: [{ index: 0, message, finish_reason: decision.kind === "text" ? "stop" : "tool_calls" }],
		usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
	});
}

Bun.serve({
	hostname: "127.0.0.1",
	port: PORT,
	async fetch(req) {
		const url = new URL(req.url);
		if (req.method === "GET" && url.pathname.endsWith("/models")) {
			const data = ["main", "approved-a", "approved-b", "override-x"].map(id => ({ id, object: "model", owned_by: "storm-spike" }));
			return Response.json({ object: "list", data });
		}
		if (req.method !== "POST" || !url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
		const request = (await req.json()) as ChatRequest;
		// A provider out of quota: omp falls back along retry.fallbackChains and emits retry_fallback_applied.
		if (request.model === QUOTA_OUT) {
			record(request, { kind: "text", text: "429 insufficient_quota" });
			const error = { message: "You exceeded your current quota, please check your plan and billing details.", type: "insufficient_quota", code: "insufficient_quota" };
			return Response.json({ error }, { status: 429 });
		}
		const decision = decide(request);
		record(request, decision);
		return request.stream ? stream(request.model, decision) : completion(request.model, decision);
	},
});
console.log(`fake-llm listening on http://127.0.0.1:${PORT}/v1, log ${LOG}`);
