#!/usr/bin/env bun
/**
 * Scripted OpenAI-compatible chat-completions server for the B0 spike (janitor deletion safety).
 *
 * Main agent: a fresh user message carrying `B0-DO {"tool":"<name>","args":{...}}` becomes exactly that
 * tool call (missing required args are filled from the tool schema); after the tool result it answers "done".
 * Children (offered `yield`, assignment carries CHILD_MARK): every fresh user turn ends with a `yield`.
 *
 * Env: FAKE_LLM_PORT (default 18557), FAKE_LLM_LOG (default /tmp/storm-b0/llm.jsonl).
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
	function: { name: string; parameters?: JsonSchema };
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

const PORT = Number(process.env.FAKE_LLM_PORT ?? 18557);
const LOG = process.env.FAKE_LLM_LOG ?? "/tmp/storm-b0/llm.jsonl";
export const CHILD_MARK = "b0 child";

mkdirSync(dirname(LOG), { recursive: true });

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map(part => (part && typeof part === "object" && "text" in part ? String(part.text) : "")).join("\n");
}

const schemaOf = (tools: Tool[] | undefined, name: string) => tools?.find(tool => tool.function.name === name)?.function.parameters;

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

function decide(request: ChatRequest): Decision {
	const messages = request.messages;
	const last = messages.at(-1)?.role;
	const lastAssistant = messages.findLastIndex(message => message.role === "assistant");
	const fresh = messages
		.slice(lastAssistant + 1)
		.filter(message => message.role === "user")
		.map(message => textOf(message.content))
		.join("\n");
	const yieldSchema = schemaOf(request.tools, "yield");
	const isChild = yieldSchema !== undefined && messages.some(m => m.role === "user" && textOf(m.content).includes(CHILD_MARK));
	if (isChild) return last === "tool" ? { kind: "text", text: "done" } : { kind: "tool", name: "yield", args: requiredArgs(yieldSchema) };
	if (last === "tool") return { kind: "text", text: "done" };
	const directive = fresh.match(/B0-DO[ \t]+(\{.*\})/);
	if (directive?.[1]) {
		const { tool, args } = JSON.parse(directive[1]) as { tool: string; args: Record<string, unknown> };
		return { kind: "tool", name: tool, args: { ...requiredArgs(schemaOf(request.tools, tool)), ...args } };
	}
	return { kind: "text", text: "OK" };
}

const encoder = new TextEncoder();
const usage = { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 };

function chunk(id: string, model: string, delta: Record<string, unknown>, finish: string | null): string {
	return `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
}

function toolCall(decision: Extract<Decision, { kind: "tool" }>) {
	return { id: `call_${crypto.randomUUID().slice(0, 8)}`, type: "function", function: { name: decision.name, arguments: JSON.stringify(decision.args) } };
}

function stream(model: string, decision: Decision): Response {
	const id = `chatcmpl-${crypto.randomUUID()}`;
	const parts =
		decision.kind === "text"
			? [chunk(id, model, { role: "assistant", content: decision.text }, null), chunk(id, model, {}, "stop")]
			: [chunk(id, model, { role: "assistant", content: null, tool_calls: [{ index: 0, ...toolCall(decision) }] }, null), chunk(id, model, {}, "tool_calls")];
	parts.push(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [], usage })}\n\n`, "data: [DONE]\n\n");
	return new Response(parts.join(""), { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
}

function completion(model: string, decision: Decision): Response {
	const message = decision.kind === "text" ? { role: "assistant", content: decision.text } : { role: "assistant", content: null, tool_calls: [toolCall(decision)] };
	return Response.json({
		id: `chatcmpl-${crypto.randomUUID()}`,
		object: "chat.completion",
		created: Math.floor(Date.now() / 1000),
		model,
		choices: [{ index: 0, message, finish_reason: decision.kind === "text" ? "stop" : "tool_calls" }],
		usage,
	});
}

Bun.serve({
	hostname: "127.0.0.1",
	port: PORT,
	async fetch(req) {
		const url = new URL(req.url);
		if (req.method === "GET" && url.pathname.endsWith("/models")) return Response.json({ object: "list", data: [{ id: "main", object: "model", owned_by: "b0" }] });
		if (req.method !== "POST" || !url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
		const request = (await req.json()) as ChatRequest;
		const decision = decide(request);
		appendFileSync(
			LOG,
			`${JSON.stringify({ ts: Date.now(), lastRole: request.messages.at(-1)?.role, child: decision.kind === "tool" && decision.name === "yield", decision })}\n`,
		);
		return request.stream ? stream(request.model, decision) : completion(request.model, decision);
	},
});
console.log(`fake-llm listening on http://127.0.0.1:${PORT}/v1, log ${LOG}`);
