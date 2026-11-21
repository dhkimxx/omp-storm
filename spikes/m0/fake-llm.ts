#!/usr/bin/env bun
/**
 * Scripted OpenAI-compatible chat-completions server for the M0 spike (omp session modes).
 *
 * Every request is classified by its first user messages: `c0 leaf` (a `task` child), `w0 child`
 * (a vibe worker) or main; requests with at most one tool and composer predictions are omp's own
 * auxiliary calls (`side`). The reply follows a fixed script chosen by the last directive in the
 * request's user messages; the step is the number of assistant messages after that directive.
 *
 *   main:    M0-STEPS read | task | vibe | mset:<b64 request>     (anything else: "done")
 *            `vibe` spawns a slow `good` worker and a `fast` worker, then ends the turn without waiting.
 *            a goal continuation ("Continue active goal.") counts as a directive: 1st → read,
 *            2nd → task storm-implementer, end the turn, read once the child's result arrives,
 *            3rd → goal({op:"complete"}). An objective containing G0-STALL skips that last read.
 *   worker:  W0-TASK <agent> | W0-READ, then `yield` when offered, else "OK"; `w0 slow` delays each reply 3 s
 *   leaf:    `yield` when offered, else "OK"
 *
 * Each request is appended to FAKE_LLM_LOG as one JSON line: who, model, tools, system prompt size,
 * every message's role/size/head, and where omp's mode texts sit.
 *
 * Env: FAKE_LLM_PORT (18558), FAKE_LLM_LOG (/tmp/storm-m0/llm.jsonl).
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

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
}
type Decision = { kind: "text"; text: string } | { kind: "tool"; name: string; args: Record<string, unknown> };
type Who = "main" | "worker" | "leaf" | "side";
/** The reply chosen for a request, with the directive and step that selected it. */
interface Picked {
	decision: Decision;
	directive: string;
	step: number;
}

const PORT = Number(process.env.FAKE_LLM_PORT ?? 18558);
const LOG = process.env.FAKE_LLM_LOG ?? "/tmp/storm-m0/llm.jsonl";
const WORKER_MARK = "w0 child";
const SLOW_MARK = "w0 slow";
const LEAF_MARK = "c0 leaf";
const CONTINUATION = "Continue active goal.";
/** Opening words of the texts omp injects per mode (prompts/system/vibe-mode-active.md, prompts/goals/*.md). */
const MODE_TEXTS = {
	vibe: "<vibe-mode>",
	goalContext: "<goal_context>",
	goalTodo: "<todo_context>",
	goalContinuation: CONTINUATION,
	goalBudgetLimit: "Active goal token budget reached.",
	stopContinuation: "M0-STOP-CONTINUE",
} as const;

mkdirSync(dirname(LOG), { recursive: true });

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map(part => (part && typeof part === "object" && "text" in part ? String(part.text) : "")).join("\n");
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

function tool(request: ChatRequest, name: string, args: Record<string, unknown>): Decision {
	if (!request.tools?.some(candidate => candidate.function.name === name)) return { kind: "text", text: `no ${name} tool offered` };
	return { kind: "tool", name, args: { ...requiredArgs(schemaOf(request.tools, name)), ...args } };
}

function taskCall(request: ChatRequest, agent: string): Decision {
	const item = { name: "M0Leaf", agent, task: `Reply with OK (${LEAF_MARK}).`, solutionSpace: "spike: fixed reply" };
	const batch = Boolean(schemaOf(request.tools, "task")?.properties?.tasks);
	return tool(request, "task", batch ? { context: "OMP Storm M0 spike", tasks: [item] } : item);
}

const readCall = (request: ChatRequest, path: string): Decision => tool(request, "read", { path });

/** The reply script for a directive: one decision per assistant step. */
function script(request: ChatRequest, who: Who, name: string, arg: string): Decision[] {
	if (who === "worker") {
		if (name === "W0-TASK") return [taskCall(request, arg || "task")];
		if (name === "W0-READ") return [readCall(request, "note.txt")];
		return [];
	}
	if (name === "goal-continuation") {
		const [turn, stall] = arg.split(":");
		if (turn === "1") return [readCall(request, "note.txt")];
		if (turn === "2") {
			const spawn = taskCall(request, "storm-implementer");
			// A different file than turn 1: omp stops continuing when two continuation turns show the same tool activity.
			return stall ? [spawn] : [spawn, { kind: "text", text: "waiting for the child" }, readCall(request, "note2.txt")];
		}
		return [tool(request, "goal", { op: "complete" })];
	}
	if (name !== "M0-STEPS") return [];
	if (arg === "read") return [readCall(request, "note.txt")];
	if (arg === "task") return [taskCall(request, "storm-implementer")];
	if (arg === "vibe") {
		return [
			tool(request, "vibe_spawn", { cli: "good", name: "M0Good", prompt: `Do the work (${WORKER_MARK}, ${SLOW_MARK}). W0-TASK storm-implementer` }),
			tool(request, "vibe_spawn", { cli: "fast", name: "M0Fast", prompt: `Do the work (${WORKER_MARK}). W0-TASK task` }),
		];
	}
	if (arg.startsWith("mset:")) {
		// omp 19 offers extension tools as devices: the model writes the JSON arguments to xd://<tool>.
		const args = { request: Buffer.from(arg.slice(5), "base64").toString("utf8") };
		return [request.tools?.some(candidate => candidate.function.name === "m0_set") ? tool(request, "m0_set", args) : tool(request, "write", { path: "xd://m0_set", content: JSON.stringify(args) })];
	}
	return [];
}

function classify(request: ChatRequest): Who {
	const users = request.messages.filter(message => message.role === "user").map(message => textOf(message.content));
	if ((request.tools?.length ?? 0) <= 1 || users.at(-1)?.includes("<composer-prediction>")) return "side";
	const first = users.slice(0, 3).join("\n");
	if (first.includes(LEAF_MARK)) return "leaf";
	return first.includes(WORKER_MARK) ? "worker" : "main";
}

function decide(request: ChatRequest, who: Who): Picked {
	if (who === "side") return { decision: { kind: "text", text: "done" }, directive: "", step: 0 };
	const messages = request.messages;
	const done = (): Decision => {
		const yieldSchema = who === "main" ? undefined : schemaOf(request.tools, "yield");
		return yieldSchema ? { kind: "tool", name: "yield", args: requiredArgs(yieldSchema) } : { kind: "text", text: who === "main" ? "done" : "OK" };
	};
	let at = -1;
	let name = "";
	let arg = "";
	let continuations = 0;
	messages.forEach((message, index) => {
		if (message.role !== "user") return;
		const text = textOf(message.content);
		if (who === "main" && text.includes(CONTINUATION)) {
			continuations++;
			at = index;
			name = "goal-continuation";
			arg = `${continuations}${text.includes("G0-STALL") ? ":stall" : ""}`;
		}
		const match = [...text.matchAll(who === "worker" ? /(W0-[A-Z]+)(?:[ \t]+([\w.:=+/-]+))?/g : /(M0-STEPS)[ \t]+([\w.:=+/-]+)/g)].at(-1);
		if (match && who !== "leaf") {
			at = index;
			name = match[1];
			arg = match[2] ?? "";
		}
	});
	if (at < 0) return { decision: done(), directive: "", step: 0 };
	const step = messages.slice(at + 1).filter(message => message.role === "assistant").length;
	const steps = script(request, who, name, arg);
	return { decision: steps[step] ?? done(), directive: `${name} ${arg}`.trim(), step };
}

function record(request: ChatRequest, who: Who, picked: Picked): void {
	const messages = request.messages.map((message, index) => ({ index, role: message.role, text: textOf(message.content) }));
	const modeTexts: Record<string, string[]> = {};
	for (const [key, needle] of Object.entries(MODE_TEXTS)) {
		const hits = messages.filter(entry => entry.role !== "system" && entry.text.includes(needle)).map(entry => `${entry.index}:${entry.role}:${entry.text.length}`);
		if (hits.length > 0) modeTexts[key] = hits;
	}
	const { decision } = picked;
	appendFileSync(
		LOG,
		`${JSON.stringify({
			ts: Date.now(),
			who,
			model: request.model,
			tools: request.tools?.map(candidate => candidate.function.name) ?? [],
			systemChars: messages.filter(entry => entry.role === "system" || entry.role === "developer").reduce((sum, entry) => sum + entry.text.length, 0),
			systemHasVibe: messages.some(entry => (entry.role === "system" || entry.role === "developer") && entry.text.includes(MODE_TEXTS.vibe)),
			roles: [...new Set(messages.flatMap(entry => [...entry.text.matchAll(/STORM-ROLE ([\w-]+)/g)].map(match => match[1])))],
			modeTexts,
			messages: messages.filter(entry => entry.role !== "system" && entry.role !== "developer").map(entry => `${entry.index}:${entry.role}:${entry.text.length}:${entry.text.slice(0, 70).replace(/\s+/g, " ")}`),
			directive: picked.directive,
			step: picked.step,
			decision: decision.kind === "tool" ? { tool: decision.name, args: decision.args } : { text: decision.text },
		})}\n`,
	);
}

const encoder = new TextEncoder();
const USAGE = { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 };

function chunk(id: string, model: string, delta: Record<string, unknown>, finish: string | null): string {
	const created = Math.floor(Date.now() / 1000);
	return `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
}

function stream(model: string, decision: Decision): Response {
	const id = `chatcmpl-${crypto.randomUUID()}`;
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			const send = (text: string) => controller.enqueue(encoder.encode(text));
			if (decision.kind === "text") {
				send(chunk(id, model, { role: "assistant", content: "" }, null));
				send(chunk(id, model, { content: decision.text }, null));
				send(chunk(id, model, {}, "stop"));
			} else {
				const call = { index: 0, id: `call_${crypto.randomUUID().slice(0, 8)}`, type: "function", function: { name: decision.name, arguments: JSON.stringify(decision.args) } };
				send(chunk(id, model, { role: "assistant", content: null, tool_calls: [call] }, null));
				send(chunk(id, model, {}, "tool_calls"));
			}
			send(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [], usage: USAGE })}\n\n`);
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
		usage: USAGE,
	});
}

Bun.serve({
	hostname: "127.0.0.1",
	port: PORT,
	async fetch(req) {
		const url = new URL(req.url);
		if (req.method === "GET" && url.pathname.endsWith("/models")) {
			return Response.json({ object: "list", data: ["main", "smol", "override-x", "override-y"].map(id => ({ id, object: "model", owned_by: "storm-spike" })) });
		}
		if (req.method !== "POST" || !url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
		const request = (await req.json()) as ChatRequest;
		const who = classify(request);
		const picked = decide(request, who);
		record(request, who, picked);
		if (who === "worker" && request.messages.some(message => message.role === "user" && textOf(message.content).includes(SLOW_MARK))) await Bun.sleep(3_000);
		return request.stream ? stream(request.model, picked.decision) : completion(request.model, picked.decision);
	},
});
console.log(`fake-llm listening on http://127.0.0.1:${PORT}/v1, log ${LOG}`);
