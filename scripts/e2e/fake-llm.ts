#!/usr/bin/env bun
/**
 * Scripted OpenAI-compatible chat-completions server for the OMP Storm E2E.
 *
 * omp talks to it as an `openai-completions` provider, so every request omp would send to a real model lands here:
 * no paid calls, deterministic replies, and one JSONL line per request for the drivers to inspect.
 *
 * A directive's payload is JSON, inline or as `b64:<base64>` (the TUI driver types the latter).
 *
 * Storm's request router (a side turn whose last user message holds `<storm-request>`):
 *   E2E-ROUTE {json}        reply with that JSON object
 *   E2E-ROUTE-BAD           reply with text that holds no JSON object
 * Main session, read from user text that arrived after the last assistant message:
 *   E2E-TOOL {json}         call the `storm` tool with these arguments
 *   E2E-TASK <agent...>     call `task` with one item per agent
 *   E2E-WRITE <path>        call `write` with that path
 * Main session, scripted:
 *   E2E-STEPS [step...]     the newest user message carrying it scripts the turn: one step per assistant tool call
 * Spawned children (assignment contains CHILD_MARK) finish through `yield` when offered. In a child's assignment:
 *   E2E-CHILD-READ <a,b>    call `read` on each path first
 *   E2E-CHILD-SEND <agent> <word>
 *                           call `write` on `agent://<agent>` with that one word first: a message to another agent
 *   E2E-WAKE-CLAIM <text>   when a message wakes this child after it already answered, its answer is that text, to the
 *                           end of the line (the first answer stays `E2E-CHILD-CLAIM`), so a scenario can tell the two
 *                           deliveries apart; put it on its own line when `E2E-CHILD-CLAIM` is in the same assignment
 *   E2E-CHILD-WRITE <path>  call `write` with that path first (before the yield)
 *   E2E-CHILD-BASH <path>   change that path with `bash` first, through no edit tool
 *   E2E-CHILD-SH <base64>   run that shell command with `bash` first, so the child can record its real cwd/files
 *   E2E-CHILD-BG <base64>   run that shell command with `bash` as a background job (`async: true`), once, before anything
 *                           else that uses `bash`; the child then goes on (a `E2E-CHILD-SH` after it is the next call)
 *   E2E-CHILD-EVAL <base64>  run that JavaScript with `eval` first (a cell that may ask a model through `completion()`)
 *   E2E-CHILD-SERVICE <base64>
 *                           ask `bash` to start that shell command as a named service (`name` + `ready`), once, before
 *                           anything else that uses `bash`; a `E2E-CHILD-SH` in the same assignment is the next call
 *   E2E-CHILD-COMMIT <path> do the same and commit every tracked change
 *   E2E-CHILD-VERDICT correct
 *                           yield a review verdict that passes, when its schema asks for one
 *   E2E-CHILD-ANSWER-VERDICT <correct|incorrect>
 *                           yield that review verdict plus `results: [{id, receipt, citation, verdict}]` copied from the
 *                           newest scoped answer-review template the child actually received (Storm's review packet or
 *                           round instruction); with no template in its context it yields no `results` at all, so a
 *                           missing packet shows up as an unsettled answer, never as a fabricated scope
 *   E2E-CHILD-ANSWER-VERDICT-ALL <correct|incorrect>
 *                           the same, but one `results` entry per distinct result id among every scoped template the
 *                           child received (the newest receipt per id), so one reviewer turn can judge a whole batch
 *   E2E-CHILD-YIELD {json}  yield that exact value as `data` when the child has an output schema (a strict schema
 *                           violation then fails the run in the host, not in the text)
 *   E2E-CHILD-YIELD-ERROR <text>
 *                           yield that failure reason instead of data
 *   E2E-CHILD-CLAIM <text>  final assistant text (the whole result without a schema; ignored by a yielding run)
 *   E2E-CHILD-BIG <chars>    final assistant text with that many varied characters, for spill/limit probes
 *   E2E-CHILD-PAD <chars>   that many characters of digit-free prose before the final claim, so the claim sits past
 *                           the host's inline preview of a long answer
 *   E2E-CHILD-429-ONCE <key>
 *                           fail this child's first provider request with a retryable 429, once per key, so a retry
 *                           can be watched without duplicating its native job/result
 *   E2E-CHILD-DELAY <ms>    wait that long before the first reply (bounded by HOLD_MAX_MS), so a live phase can be
 *                           observed deterministically while the child really runs
 *   E2E-CHILD-FINAL-PAUSE <ms> <marker>
 *                           when the child's request is the one that answers in text (its turn ends with this reply),
 *                           create the file `<marker>` and hold the reply that long: a message the parent writes to
 *                           the child meanwhile lands as the child's turn is ending
 *   E2E-CHILD-GATE <key>   mark this child as waiting and hold its first reply until a scripted wait releases it
 *   E2E-WAKE-GATE <key>    hold the first provider reply to a follow-up, including an already-used child
 *   E2E-CHILD-HOLD          hold the first reply until the parent's context has been compacted (a compaction request
 *                           answered), so the parent's turn ends and is compacted while the child still runs
 *   E2E-CHILD-HOLD-ONCE <key>
 *                           the same, but only the first child carrying that key: a resumed copy of the request runs on
 * A compaction request (one user message opening with `<conversation>`) gets a plain summary; the log keeps its
 * `<additional-context>` block (what extensions added through `session.compacting`).
 *
 * `GET /v1/models` answers the readiness probe. Env: FAKE_LLM_PORT, FAKE_LLM_LOG (both required).
 */
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isRecord } from "../../src/config/schema.ts";

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
interface ToolCall {
	function?: { name?: string; arguments?: string };
}
interface Message {
	role: string;
	content?: unknown;
	tool_calls?: ToolCall[];
}
/** One item of a scripted task batch: the exact name and assignment a probe needs, not a generated `W<n>`. */
export interface ScriptedTask {
	name?: string;
	agent: string;
	task?: string;
	/**
	 * The item's assignment as `steps` (omp takes them instead of `task` only when the user turned on `task.steps`). The child marker and
	 * `say` go on the first step, as Storm's own additions do.
	 */
	steps?: string[];
	/** Appended to this item's assignment, e.g. an E2E-CHILD directive. */
	say?: string;
	/**
	 * The director's own `effort` / `model` arguments of the item, as omp's task schema takes them (only when the user
	 * turned on `task.enableEffort` / `task.perCallModel`). The hardening scenarios pass them to prove they are not used.
	 */
	effort?: string;
	model?: string;
	solutionSpace?: string;
	isolated?: boolean;
	outputSchema?: unknown;
	schemaMode?: "permissive" | "strict";
}

/**
 * One step of a scripted main turn: a storm tool call, a task batch (`as` prefixes the children's names, `say` is
 * appended to each assignment, e.g. an E2E-CHILD directive; `tasks` gives every item its own name and assignment),
 * a file write, a shell command, a follow-up to a subagent, a read, a native `ask` form (`ask` is one HTML `<form>`),
 * `ifAskApproved` (run the shell command only when the previous ask's answer explicitly applies/approves it), or
 * `awaitChild`: a text reply (it ends the turn, so it belongs last) held until a child of the last task call has
 * made its first request, so the turn ends with that child known to be running. `isolated[i]` marks task item i
 * `isolated: true`; the host's native task isolation places that child, and only probes that deliberately bypass
 * Storm use it.
 * `after` holds the step until that text shows up in a later message: omp decides spawns in the background after
 * `task` returns, so a step that must follow a spawn decision waits for its outcome instead of racing it.
 * `afterResult` holds it until a later user message (an async result) carries that text.
 * A task step's `awaitChildren` waits for the listed gate keys to be held at the provider before sending the tool
 * call. A wait step's `releaseChildren` opens those gates once its own `after`/`afterResult` condition is met.
 * A task step's `reviewFor` (a result id) holds it until a later non-assistant message (a tool result or a user
 * message) carries Storm's scoped answer-review template for that id, then appends what Storm wrote to the
 * assignment: the whole answer-review packet when that message holds one, else the template line. Nothing is
 * composed here; a receipt the fake never saw cannot be forwarded.
 */
export type Step = (
	| { storm: Record<string, unknown> }
	| { task: string[]; as?: string; say?: string; isolated?: boolean[] }
	| { tasks: ScriptedTask[]; context?: string; awaitChildren?: string[] }
	| { edit: string; content?: string }
	| { bash: string; async?: boolean }
	| { followUp: string; content?: string }
	| { read: string }
	/** Any tool by name with these arguments (required ones the schema names are filled with defaults). */
	| { call: string; args: Record<string, unknown> }
	| { ask: string }
	| { ifAskApproved: string }
	| { wait: true; releaseChildren?: string[] }
	| { awaitChild: true }
	/**
	 * Several calls in ONE assistant message, in this order (each sub-step is a call step: `tasks`, `task`, `edit`, `bash`,
	 * `call`, `read`, `storm`, `wait`). The host prepares them in call order and runs them after the last hook returned. A
	 * script counts the message as one step, and every call's answer is in `LlmEntry.trailingResults` of the next request.
	 */
	| { calls: Step[] }
) & {
	after?: string;
	afterResult?: string;
	/** Task steps: wait for Storm's scoped answer-review template for this result id and forward it verbatim. */
	reviewFor?: string;
	/** After a host receipt, park an unmet `after` reply until the PTY driver signals release. */
	releaseFile?: { name: string; receipt: string };
	/**
	 * Hold this step's call until the file exists (at most `HOLD_MAX_MS`), so a director write lands at a moment a probe
	 * marks from the other side (a child's final pause, an extension's end-of-turn delay).
	 */
	holdUntilFile?: string;
	/**
	 * Sleep this long (at most `HOLD_MAX_MS`) before this step's call is issued, once its own conditions are met. It
	 * lets a scenario outlast a host timer (omp evicts a consumed job row 30 s after delivery) while the turn stays open.
	 */
	pauseMs?: number;
};
interface ChatRequest {
	model: string;
	messages: Message[];
	tools?: Tool[];
	stream?: boolean;
	/** OpenAI-compatible reasoning effort; omp sends it when a model pattern carries a `:level` suffix. */
	reasoning_effort?: string;
	reasoning?: { effort?: string };
}
type Decision = (
	| { kind: "text"; text: string; awaitChild?: boolean }
	| { kind: "tool"; name: string; args: Record<string, unknown>; more?: Array<{ kind: "tool"; name: string; args: Record<string, unknown> }> }
) & { awaitChildren?: string[]; releaseChildren?: string[]; releaseFile?: string; pauseMs?: number; waitFile?: string };
/** Who a request is from: the main session, a spawned child, Storm's router, a compaction, or omp's own auxiliary calls. */
export type Who = "main" | "child" | "route" | "compaction" | "side";

/**
 * One line of the request log. Every `*Bytes` field is UTF-8 at the provider endpoint, measured before parsing for
 * `bodyBytes`; these are bytes, never tokens and never an estimate of them.
 */
export interface LlmEntry {
	ts: number;
	who: Who;
	/**
	 * The `[storm:…]` lines this request carries as their own message (a developer message a host hook attached after a
	 * result; omp sends it as a user message to a provider without that role), in order, each cut to 1,200 chars.
	 */
	notes: string[];
	model: string;
	effort: string | null;
	tools: string[];
	/** The `storm` tool as offered: its actions and the size of its description; null when it is not offered. */
	stormTool: { actions: string[]; descriptionChars: number } | null;
	/** Messages besides the system prompt. */
	messageCount: number;
	/** The character size of non-system messages that actually reach this request. */
	historyChars: number;
	/** Every user message, cut to 300 chars. */
	users: string[];
	/** The newest user message, whole (cut at 8,000 chars). */
	lastUser: string;
	/** A user message carries one of omp's hidden keyword notices (workflowz, orchestrate). */
	keywordNotice: boolean;
	/** Storm's doc rules section of the system prompt: its size and a hash, to tell the role variants apart. */
	docRules: { chars: number; hash: string } | null;
	/** The system/developer text at the provider endpoint: UTF-8 bytes and a stable hash of the same bytes. */
	systemBytes: number;
	systemSha256: string;
	/** Storm's fixed bootstrap in the system prompt (`<storm-auto>`, `<storm-decision>`): UTF-8 bytes, 0 when absent. */
	stormBlockBytes: number;
	/** The offered tool catalog: UTF-8 bytes of the whole array, of the `storm` entry and of its parameters schema. */
	toolsBytes: number;
	stormToolBytes: number;
	stormSchemaBytes: number;
	/** UTF-8 bytes of the provider request body as received, before parsing. */
	bodyBytes: number;
	/** `STORM-ROLE <name>` markers in any message (a shadowing role definition carries one). */
	roles: string[];
	/** The tool result this request answers, cut. */
	lastTool: string;
	/** The last tool result in the request, wherever it sits (a note message may follow it), cut. */
	lastToolResult: string;
	/**
	 * Every tool result after the newest assistant message, in order, each cut to 1,000 chars: the answers to the calls of one
	 * assistant message that carried several (`calls` step), which `lastTool` and `lastToolResult` cannot tell apart.
	 */
	trailingResults: string[];
	/** What extensions added to a compaction request (`<additional-context>`), verbatim. */
	compactionContext: string;
	/**
	 * A child only, and only when its context holds one: the newest answer-review packet it received, parsed from
	 * Storm's own wording (`answerReviewPacket`), with the answer exactly as quoted between `<<<` and `>>>`.
	 */
	reviewPacket?: ReviewPacket;
	/** `all` lists every call of an assistant message that carried several (the first one is also `tool`/`args`). */
	decision: { tool?: string; args?: Record<string, unknown>; text?: string; all?: Array<{ tool: string; args: Record<string, unknown> }> };
}

/** One scoped answer-review subject as Storm spelled it: result id, receipt and citation anchor. */
export interface ReviewScope {
	id: string;
	receipt: string;
	citation: string;
}

/** A parsed answer-review packet: its scope and the answer text it quotes. */
export interface ReviewPacket extends ReviewScope {
	answer: string;
}

const PORT = Number(process.env.FAKE_LLM_PORT);
const LOG = process.env.FAKE_LLM_LOG ?? "";
if (!Number.isInteger(PORT) || PORT <= 0 || LOG === "") throw new Error("FAKE_LLM_PORT and FAKE_LLM_LOG are required");

const CHILD_MARK = "e2e child";
/** Opening sentences of omp's hidden keyword notices (prompts/system/*-notice.md). */
const NOTICES = ["deterministic multi-subagent workflow", "orchestration request"];
/** Model id that always fails with an out-of-quota 429. */
const QUOTA_OUT = "quota-out";
/** Model id whose requests report a large prompt (see `usageOf`). */
const HEAVY_MAIN = "heavy-main";
/**
 * A reviewer's verdict for agents whose yield schema asks for one (storm-reviewer): one P1 finding of kind
 * `doc_conflict`, so the run record has a finding and a doc finding to count.
 */
const REVIEW_VERDICT = {
	overall_correctness: "incorrect",
	explanation: "E2E verdict",
	confidence: 0.8,
	findings: [{ title: "E2E finding", body: "E2E", priority: 1, confidence: 0.8, file_path: "README.md", line_start: 1, line_end: 1, kind: "doc_conflict" }],
};
/** First text of omp's compaction requests: the conversation to summarize (pi-agent-core compaction.ts). */
const COMPACTION_OPEN = "<conversation>";
/** The tag Storm's router fences the user's request in (src/request/route.ts). */
const ROUTE_TAG = "<storm-request>";
/** Heading of Storm's doc rules section in a role agent's system prompt (src/policy/docs.ts). */
const DOC_RULES = "## Storm doc rules";
/** How long a held reply waits for its event; a missing event must not hang the suite. */
const HOLD_MAX_MS = 60_000;
/** What the server has seen so far: the events held replies wait for. */
const seen = { children: 0, childrenAtTask: 0, compactions: 0 };
/** Keys whose one-time hold is spent: a resumed request must not hold again or it could never finish. */
const heldOnce = new Set<string>();
/** Keys whose one-time retryable 429 is spent. */
const failedOnce = new Set<string>();
/** The named children whose first provider replies are parked until the director releases them. */
const waitingChildren = new Set<string>();
const seenWakeGates = new Set<string>();

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

/**
 * The JSON value after `marker` in `text`: `b64:<base64>` or the first balanced `{…}` / `[…]`. Undefined when the
 * marker is absent or nothing parseable follows it.
 */
function payload(text: string, marker: string): unknown {
	const at = text.indexOf(marker);
	if (at < 0) return undefined;
	const rest = text.slice(at + marker.length).trimStart();
	const encoded = /^b64:([A-Za-z0-9+/=_-]+)/.exec(rest)?.[1];
	try {
		if (encoded) return JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
		const open = rest[0];
		if (open !== "{" && open !== "[") return undefined;
		let depth = 0;
		let inString = false;
		for (let i = 0; i < rest.length; i++) {
			const ch = rest[i];
			if (inString) {
				if (ch === "\\") i++;
				else if (ch === '"') inString = false;
			} else if (ch === '"') inString = true;
			else if (ch === "{" || ch === "[") depth++;
			else if ((ch === "}" || ch === "]") && --depth === 0) return JSON.parse(rest.slice(0, i + 1));
		}
	} catch {
		// Not JSON: the directive is ignored.
	}
	return undefined;
}

/** The last instead of the first directive: a follow-up message overrides the assignment that started the child. */
function lastPayload(text: string, marker: string): unknown {
	const at = text.lastIndexOf(marker);
	return at < 0 ? undefined : payload(text.slice(at), marker);
}

/** Last capture of a scalar directive; see {@link lastPayload}. */
function lastCapture(text: string, pattern: RegExp): string | undefined {
	const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
	return [...text.matchAll(new RegExp(pattern.source, flags))].at(-1)?.[1];
}

/**
 * Storm's scoped answer-review template in either of its spellings: the packet's
 * `results: [{ "id": "…", "receipt": "…", "citation": "…", …` and the round instruction's `results: [{"id": "…", …`.
 */
const SCOPE_TEMPLATE = /"id":\s*"([A-Za-z0-9._:-]{1,64})",\s*"receipt":\s*"([0-9a-f]{32})",\s*"citation":\s*"([^"\n]{1,300})"/gu;
/** The packet `answerReviewPacket` writes (src/runtime/answer-review.ts), up to its closing template. */
const PACKET =
	/Answer review for result `([^`\n]{1,64})` \(receipt ([0-9a-f]{32})\)\.\n[^\n]*\nCited source: ([^\n]{1,300})\. Read it yourself[^\n]*\nAnswer as submitted:\n<<<\n([\s\S]*?)\n>>>\nIn your final yield add results: \[[^\n]*\]\./gu;

/** Every scoped template in `text`, oldest first. */
function scopesIn(text: string): ReviewScope[] {
	return [...text.matchAll(SCOPE_TEMPLATE)].map(match => ({ id: match[1] ?? "", receipt: match[2] ?? "", citation: match[3] ?? "" }));
}

/** Every whole review packet in `text`, oldest first, with the span it occupies. */
function packetsIn(text: string): Array<ReviewPacket & { block: string }> {
	return [...text.matchAll(PACKET)].map(match => ({
		id: match[1] ?? "",
		receipt: match[2] ?? "",
		citation: match[3] ?? "",
		answer: match[4] ?? "",
		block: match[0],
	}));
}

/** The text of every non-assistant, non-system message: what a model has been told by its user, host and tools. */
function heardText(messages: Message[]): string {
	return messages
		.filter(message => message.role === "user" || message.role === "tool")
		.map(message => textOf(message.content))
		.join("\n");
}

/**
 * What a director forwards for `id`: the newest message that carries Storm's scoped template for it, as the packet when
 * that message holds the whole packet for the same id, else as the template's own line. Undefined until Storm said it.
 */
function forwardedReview(later: Message[], id: string): string | undefined {
	for (let index = later.length - 1; index >= 0; index--) {
		const message = later[index];
		if (message === undefined || (message.role !== "user" && message.role !== "tool")) continue;
		const text = textOf(message.content);
		if (!scopesIn(text).some(scope => scope.id === id)) continue;
		const packet = packetsIn(text).findLast(entry => entry.id === id);
		if (packet !== undefined) return packet.block;
		return text.split("\n").filter(line => scopesIn(line).some(scope => scope.id === id)).join("\n");
	}
	return undefined;
}

function taskCall(tools: Tool[] | undefined, agents: string[], prefix = "W", say?: string, isolated?: boolean[]): Decision {
	const item = (agent: string, index: number) => ({
		name: `${prefix}${index}`,
		agent,
		task: `Reply with OK (${CHILD_MARK} ${index}).${say ? ` ${say}` : ""}`,
		solutionSpace: "e2e: fixed reply",
		...(isolated?.[index] === true ? { isolated: true } : {}),
	});
	const batch = Boolean(schemaOf(tools, "task")?.properties?.tasks);
	const args = batch ? { context: "OMP Storm E2E", tasks: agents.map(item) } : item(agents[0] ?? "task", 0);
	return { kind: "tool", name: "task", args };
}

/** A batch whose items carry their own names and assignments; the child marker keeps `classify` treating them as children. */
function taskItemsCall(tools: Tool[] | undefined, items: ScriptedTask[], context: string): Decision {
	const batch = Boolean(schemaOf(tools, "task")?.properties?.tasks);
	const item = (script: ScriptedTask, index: number) => {
		const marked = (text: string): string => `${text} (${CHILD_MARK} ${index})${script.say ? ` ${script.say}` : ""}`;
		const assignment = script.steps !== undefined && script.steps.length > 0 ? { steps: script.steps.map((step, at) => (at === 0 ? marked(step) : step)) } : { task: marked(script.task ?? "Reply with OK") };
		return {
			name: script.name ?? `W${index}`,
			agent: script.agent,
			...assignment,
			solutionSpace: script.solutionSpace ?? "e2e: fixed reply",
			...(script.isolated === true ? { isolated: true } : {}),
			...(script.effort !== undefined ? { effort: script.effort } : {}),
			...(script.model !== undefined ? { model: script.model } : {}),
			...(script.outputSchema !== undefined ? { outputSchema: script.outputSchema } : {}),
			...(script.schemaMode !== undefined ? { schemaMode: script.schemaMode } : {}),
		};
	};
	if (batch) return { kind: "tool", name: "task", args: { context, tasks: items.map(item) } };
	const single = items[0];
	return { kind: "tool", name: "task", args: single ? item(single, 0) : { name: "W0", agent: "task", task: "Reply with OK (e2e child 0)", solutionSpace: "e2e: fixed reply" } };
}

function readCall(tools: Tool[] | undefined, path: string): Decision {
	return { kind: "tool", name: "read", args: { ...requiredArgs(schemaOf(tools, "read")), path } };
}

function writeCall(path: string, content: string): Decision {
	return { kind: "tool", name: "write", args: { path, content } };
}

/** A `bash` call: a change made this way is invisible to the edit-tool counter. */
function bashCall(tools: Tool[] | undefined, command: string): Decision {
	return { kind: "tool", name: "bash", args: { ...requiredArgs(schemaOf(tools, "bash")), command } };
}

/** The `name` omp's `bash` takes to start a long-lived service under its daemon instead of running a finite command. This file starts a server when loaded, so scenarios repeat the word rather than import it. */
const SERVICE_NAME = "e2e-service";

/** A `bash` call that asks omp to start `command` as a named service (omp's `name` + `ready` form). */
function serviceCall(tools: Tool[] | undefined, command: string): Decision {
	return { kind: "tool", name: "bash", args: { ...requiredArgs(schemaOf(tools, "bash")), command, name: SERVICE_NAME, ready: { log: "ready", timeout: 5 } } };
}

/** A call of an extension tool: by name when omp offers it, else through its `xd://<tool>` device. */
function extensionCall(tools: Tool[] | undefined, name: string, args: Record<string, unknown>): Decision {
	if (tools?.some(tool => tool.function.name === name)) return { kind: "tool", name, args };
	return writeCall(`xd://${name}`, JSON.stringify(args));
}

function yieldCall(schema: JsonSchema, correct = false, scoped?: ReadonlyArray<ReviewScope & { verdict: "correct" | "incorrect" }>): Decision {
	const args = requiredArgs(schema);
	if (!JSON.stringify(schema).includes("overall_correctness")) return { kind: "tool", name: "yield", args };
	const data = {
		...REVIEW_VERDICT,
		overall_correctness: correct ? "correct" : "incorrect",
		...(scoped === undefined || scoped.length === 0
			? {}
			: { results: scoped.map(scope => ({ id: scope.id, receipt: scope.receipt, citation: scope.citation, verdict: scope.verdict })) }),
	};
	// Strict schemas make every key required but nullable: null out the others so `data` stands alone (data xor error).
	return { kind: "tool", name: "yield", args: { ...Object.fromEntries(Object.keys(args).map(key => [key, null])), data } };
}

const userText = (messages: Message[]): string =>
	messages
		.filter(message => message.role === "user")
		.map(message => textOf(message.content))
		.join("\n");
const hasCalls = (message: Message): boolean => message.role === "assistant" && (message.tool_calls?.length ?? 0) > 0;
const callNames = (messages: Message[]): string[] => messages.filter(hasCalls).flatMap(m => (m.tool_calls ?? []).map(call => call.function?.name ?? ""));

/** The tool result answering the newest `ask` call, if any: what an `ifAskApproved` step decides on. */
function lastAskResult(messages: Message[]): string | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role !== "tool") continue;
		for (let before = index - 1; before >= 0; before--) {
			const call = messages[before];
			if (!call || call.role !== "assistant" || !hasCalls(call)) continue;
			const asked = (call.tool_calls ?? []).some(item => item.function?.name === "ask");
			if (asked) return textOf(message.content);
			break;
		}
	}
	return undefined;
}

/** An ask answer that explicitly applies/approves the proposed effect. A cancel or deny is never approval. */
function approvedByAsk(answer: string): boolean {
	return /"(?:choice|decision|answer|approval)"\s*:\s*"(?:apply|approve|approved|yes)"/i.test(answer) ||
		/User answers:[\s\S]*\b(?:Apply|Approve|Approved|Yes)\b/i.test(answer);
}

const HANDOFF_REQUEST = "Write a handoff document for another instance of yourself.";

/** A soft summary wraps the transcript; a native handoff appends its own request to the live history. */
function isCompaction(messages: Message[]): boolean {
	const users = messages.filter(message => message.role === "user");
	const last = textOf(users.at(-1)?.content).trimStart();
	return (users.length === 1 && last.startsWith(COMPACTION_OPEN)) || (last.startsWith("<critical>") && last.includes(HANDOFF_REQUEST));
}

function classify(request: ChatRequest): Who {
	const messages = request.messages;
	if (isCompaction(messages)) return "compaction";
	const users = messages.filter(message => message.role === "user").map(message => textOf(message.content));
	if (users.at(-1)?.includes(ROUTE_TAG)) return "route";
	// omp's own auxiliary calls (titles, composer predictions) carry no tool catalog.
	if ((request.tools?.length ?? 0) <= 1 || users.at(-1)?.includes("<composer-prediction>")) return "side";
	return users.some(text => text.includes(CHILD_MARK)) ? "child" : "main";
}

/** A child told to hold makes its first reply wait until its parent has been compacted. */
function holdsForCompaction(who: Who, messages: Message[]): boolean {
	return who === "child" && /E2E-CHILD-HOLD(?!-)/.test(userText(messages)) && !messages.some(m => m.role === "assistant");
}

/** A child told to hold once does so only while its key is unspent; the copy a resumed run starts replies at once. */
function holdsOnce(who: Who, messages: Message[]): boolean {
	if (who !== "child" || messages.some(m => m.role === "assistant")) return false;
	const key = /E2E-CHILD-HOLD-ONCE[ \t]+(\S+)/.exec(userText(messages))?.[1];
	if (key === undefined || heldOnce.has(key)) return false;
	heldOnce.add(key);
	return true;
}

/** A child's first reply can be held for a bounded time, so a caller can watch the phase while the child runs. */
function childDelayMs(who: Who, messages: Message[]): number {
	if (who !== "child" || messages.some(m => m.role === "assistant")) return 0;
	const raw = /E2E-CHILD-DELAY[ \t]+(\d+)/.exec(userText(messages))?.[1];
	if (raw === undefined) return 0;
	return Math.min(Number(raw), HOLD_MAX_MS);
}

/** Waits until `open` holds, for `HOLD_MAX_MS` at most; false means the event never arrived. */
async function hold(open: () => boolean): Promise<boolean> {
	const deadline = Date.now() + HOLD_MAX_MS;
	while (!open()) {
		if (Date.now() >= deadline) return false;
		await Bun.sleep(20);
	}
	return true;
}

function stepCall(step: Step, tools: Tool[] | undefined): Decision {
	if ("calls" in step) {
		const decisions = step.calls.map(sub => stepCall(sub, tools));
		const first = decisions[0];
		const tools_ = decisions.filter((decision): decision is Extract<Decision, { kind: "tool" }> => decision.kind === "tool");
		if (first === undefined || first.kind !== "tool" || tools_.length !== decisions.length) throw new Error("a `calls` step holds only call steps");
		return { ...first, more: tools_.slice(1).map(({ kind, name, args }) => ({ kind, name, args })) };
	}
	if ("storm" in step) return extensionCall(tools, "storm", step.storm);
	if ("task" in step) return taskCall(tools, step.task, step.as, step.say, step.isolated);
	if ("tasks" in step) {
		const decision = taskItemsCall(tools, step.tasks, step.context ?? "OMP Storm E2E");
		return step.awaitChildren === undefined ? decision : { ...decision, awaitChildren: step.awaitChildren };
	}
	if ("read" in step) return readCall(tools, step.read);
	if ("call" in step) return { kind: "tool", name: step.call, args: { ...requiredArgs(schemaOf(tools, step.call)), ...step.args } };
	if ("edit" in step) return writeCall(step.edit, step.content ?? "storm director check\n");
	if ("bash" in step) return step.async === true ? { kind: "tool", name: "bash", args: { ...requiredArgs(schemaOf(tools, "bash")), command: step.bash, async: true } } : bashCall(tools, step.bash);
	if ("followUp" in step) return writeCall(step.followUp, step.content ?? "follow-up");
	if ("ask" in step) return extensionCall(tools, "ask", { html: step.ask });
	if ("wait" in step) {
		const decision = extensionCall(tools, "wait", {});
		return step.releaseChildren === undefined ? decision : { ...decision, releaseChildren: step.releaseChildren };
	}
	return { kind: "text", text: "waiting", awaitChild: true };
}

/** The decision for `step`, or a text reply that ends the turn while its `after` condition is not met yet. */
function gatedStep(step: Step | undefined, later: Message[], tools: Tool[] | undefined): Decision {
	if (!step) return { kind: "text", text: "done" };
	const seen = (text: string, from: (role: string) => boolean) => later.some(m => from(m.role) && textOf(m.content).includes(text));
	if (step.afterResult !== undefined && !seen(step.afterResult, role => role === "user")) return { kind: "text", text: "waiting" };
	if (step.after !== undefined && !seen(step.after, role => role !== "assistant")) {
		const gate = step.releaseFile;
		return gate !== undefined && seen(gate.receipt, role => role === "user" || role === "tool")
			? { kind: "text", text: "waiting", releaseFile: gate.name }
			: { kind: "text", text: "waiting" };
	}
	// A follow-up waits for its target's async result (a user message), so the target's usage is on the ledger by then.
	if ("followUp" in step && !seen(step.followUp.replace(/^agent:\/\//, ""), role => role === "user")) return { kind: "text", text: "waiting" };
	if ("ifAskApproved" in step) {
		// The step still consumes its slot on a denial, so the script proceeds without applying the proposed effect.
		return approvedByAsk(lastAskResult(later) ?? "") ? bashCall(tools, step.ifAskApproved) : extensionCall(tools, "storm", { action: "status" });
	}
	if (step.reviewFor !== undefined && "task" in step) {
		const forwarded = forwardedReview(later, step.reviewFor);
		if (forwarded === undefined) return { kind: "text", text: "waiting" };
		return stepCall({ ...step, say: `${step.say ?? ""}\n${forwarded}` }, tools);
	}
	const call = stepCall(step, tools);
	const paused = step.pauseMs === undefined ? call : { ...call, pauseMs: step.pauseMs };
	return step.holdUntilFile === undefined ? paused : { ...paused, waitFile: step.holdUntilFile };
}

/**
 * `E2E-STEPS`: the newest user message carrying it scripts what follows; each assistant tool call since is one step
 * done. A message that asks for a storm tool call (E2E-TOOL) only quotes the script as that call's task.
 */
function scriptedSteps(messages: Message[], tools: Tool[] | undefined): Decision | undefined {
	const at = messages.findLastIndex(m => m.role === "user" && textOf(m.content).includes("E2E-STEPS") && !textOf(m.content).includes("E2E-TOOL"));
	if (at < 0) return undefined;
	const steps = payload(textOf(messages[at]?.content), "E2E-STEPS");
	if (!Array.isArray(steps)) return undefined;
	const later = messages.slice(at + 1);
	return gatedStep((steps as Step[])[later.filter(hasCalls).length], later, tools);
}

/** A child does what its assignment tells it — reads, then a write — and yields; a follow-up message makes it yield again. */
function childDecision(request: ChatRequest): Decision {
	const messages = request.messages;
	const text = userText(messages);
	const reads = (lastCapture(text, /E2E-CHILD-READ[ \t]+(\S+)/) ?? "").split(",").filter(Boolean);
	const write = lastCapture(text, /E2E-CHILD-WRITE[ \t]+(\S+)/);
	const send = /E2E-CHILD-SEND[ \t]+(\S+)[ \t]+(\S+)/.exec(text) ?? undefined;
	const wakeClaim = lastCapture(text, /E2E-WAKE-CLAIM[ \t]+([^\n]+)/);
	const bash =lastCapture(text, /E2E-CHILD-BASH[ \t]+(\S+)/);
	const sh = lastCapture(text, /E2E-CHILD-SH[ \t]+(\S+)/);
	const service = lastCapture(text, /E2E-CHILD-SERVICE[ \t]+(\S+)/);
	const background = lastCapture(text, /E2E-CHILD-BG[ \t]+(\S+)/);
	const evalCode = lastCapture(text, /E2E-CHILD-EVAL[ \t]+(\S+)/);
	const commit = lastCapture(text, /E2E-CHILD-COMMIT[ \t]+(\S+)/);
	const answerVerdict = lastCapture(text, /E2E-CHILD-ANSWER-VERDICT[ \t]+(correct|incorrect)\b/) as "correct" | "incorrect" | undefined;
	const allVerdict = lastCapture(text, /E2E-CHILD-ANSWER-VERDICT-ALL[ \t]+(correct|incorrect)\b/) as "correct" | "incorrect" | undefined;
	const correct = lastCapture(text, /E2E-CHILD-VERDICT[ \t]+(correct)\b/) === "correct" || answerVerdict === "correct" || allVerdict === "correct";
	const report = lastPayload(text, "E2E-CHILD-YIELD");
	const yieldError = lastCapture(text, /E2E-CHILD-YIELD-ERROR[ \t]+([^\n]+)/);
	const claim = lastCapture(text, /E2E-CHILD-CLAIM[ \t]+([^\n]+)/);
	const big = Number(lastCapture(text, /E2E-CHILD-BIG[ \t]+(\d+)/) ?? 0);
	const pad = Number(lastCapture(text, /E2E-CHILD-PAD[ \t]+(\d+)/) ?? 0);
	const calls = callNames(messages);
	const done = calls.filter(name => name === "read").length;
	const last = messages.at(-1);
	// An explicit report repeats until the host accepts or gives up; a rejected yield must not turn into text.
	if (report === undefined && yieldError === undefined && last?.role === "tool" && calls.at(-1) === "yield") return { kind: "text", text: claim ?? "done" };
	if (done < reads.length) return readCall(request.tools, reads[done] ?? "");
	if (evalCode !== undefined && !calls.includes("eval")) return { kind: "tool", name: "eval", args: { ...requiredArgs(schemaOf(request.tools, "eval")), language: "js", code: Buffer.from(evalCode, "base64").toString("utf8") } };
	if (commit !== undefined && !calls.includes("bash")) return bashCall(request.tools, `printf '%s\\n' storm-child-bash >> ${commit} && git commit -qam storm-e2e-commit`);
	// The service request comes first and is made once, whatever answer it gets; a `E2E-CHILD-SH` after it is the next bash call.
	const shells = calls.filter(name => name === "bash").length;
	if (service !== undefined && shells === 0) return serviceCall(request.tools, Buffer.from(service, "base64").toString("utf8"));
	const before = (service === undefined ? 0 : 1) + (background === undefined ? 0 : 1);
	if (background !== undefined && shells === (service === undefined ? 0 : 1)) return { kind: "tool", name: "bash", args: { ...requiredArgs(schemaOf(request.tools, "bash")), command: Buffer.from(background, "base64").toString("utf8"), async: true } };
	if (sh !== undefined && shells === before) return bashCall(request.tools, Buffer.from(sh, "base64").toString("utf8"));
	if (bash !== undefined && !calls.includes("bash")) return bashCall(request.tools, `printf '%s\\n' storm-child-bash >> ${bash}`);
	const writes = calls.filter(name => name === "write").length;
	if (send !== undefined && writes === 0) return writeCall(`agent://${send[1]}`, send[2] ?? "hello");
	if (write !== undefined && writes < (send === undefined ? 1 : 2)) return writeCall(write, "storm child change\n");
	// Woken after it already answered (a text reply, then a new user message): the answer is the scenario's own word.
	const answeredAt = messages.findIndex(message => message.role === "assistant" && !hasCalls(message) && textOf(message.content) !== "");
	if (wakeClaim !== undefined && answeredAt >= 0 && messages.slice(answeredAt + 1).some(message => message.role === "user")) return { kind: "text", text: wakeClaim };
	const yieldSchema = schemaOf(request.tools, "yield");
	if (yieldSchema) {
		if (yieldError !== undefined) return { kind: "tool", name: "yield", args: { error: yieldError } };
		if (report !== undefined) return { kind: "tool", name: "yield", args: { data: report } };
	}
	if (yieldSchema && allVerdict !== undefined) {
		// Every scope Storm wrote into this child's context, one entry per result id; a newer receipt replaces an older one.
		const latest = new Map<string, ReviewScope>();
		for (const scope of scopesIn(heardText(messages))) latest.set(scope.id, scope);
		return yieldCall(yieldSchema, correct, [...latest.values()].map(scope => ({ ...scope, verdict: allVerdict })));
	}
	if (yieldSchema && answerVerdict !== undefined) {
		// Only a scope Storm actually wrote into this child's context; the newest one wins, as a re-sent packet would.
		const scope = scopesIn(heardText(messages)).at(-1);
		return yieldCall(yieldSchema, correct, scope === undefined ? undefined : [{ ...scope, verdict: answerVerdict }]);
	}
	if (yieldSchema) return yieldCall(yieldSchema, correct);
	if (big > 0) {
		const lines: string[] = [];
		for (let at = 0, index = 0; at < big; index++) {
			const line = `E2E child line ${String(index).padStart(6, "0")} ${"x".repeat(index % 23)}`;
			lines.push(line);
			at += line.length + 1;
		}
		return { kind: "text", text: lines.join("\n").slice(0, big) };
	}
	if (pad > 0) {
		// No digits: a padded answer must not state numbers beyond its claim.
		const filler = "This padding line only lengthens the answer past the host preview.\n";
		return { kind: "text", text: `${filler.repeat(Math.ceil(pad / filler.length)).slice(0, pad)}\n${claim ?? "OK"}` };
	}
	return { kind: "text", text: claim ?? "OK" };
}

function decide(request: ChatRequest, who: Who): Decision {
	const messages = request.messages;
	if (who === "compaction") return { kind: "text", text: "## Goal\nE2E compaction summary" };
	if (who === "side") return { kind: "text", text: "OK" };
	if (who === "route") {
		const asked = textOf(messages.findLast(message => message.role === "user")?.content);
		const fenced = asked.slice(asked.lastIndexOf(ROUTE_TAG));
		if (fenced.includes("E2E-ROUTE-BAD")) return { kind: "text", text: "I cannot classify this." };
		const reply = payload(fenced, "E2E-ROUTE");
		return { kind: "text", text: JSON.stringify(isRecord(reply) ? reply : { action: "menu" }) };
	}
	if (who === "child") return childDecision(request);
	const scripted = scriptedSteps(messages, request.tools);
	if (scripted) return scripted;
	if (messages.at(-1)?.role === "tool") return { kind: "text", text: "done" };
	const lastAssistant = messages.findLastIndex(message => message.role === "assistant");
	const fresh = userText(messages.slice(lastAssistant + 1));
	const stormArgs = payload(fresh, "E2E-TOOL");
	if (isRecord(stormArgs)) return extensionCall(request.tools, "storm", stormArgs);
	const spawn = /E2E-TASK((?:[ \t]+[\w.-]+)+)/.exec(fresh)?.[1];
	if (spawn) return taskCall(request.tools, spawn.trim().split(/\s+/));
	const write = /E2E-WRITE[ \t]+(\S+)/.exec(fresh)?.[1];
	if (write) return writeCall(write, "storm director check\n");
	return { kind: "text", text: "OK" };
}

function docRulesOf(system: string): LlmEntry["docRules"] {
	const at = system.indexOf(DOC_RULES);
	if (at < 0) return null;
	const next = system.indexOf("\n#", at + DOC_RULES.length);
	const section = system.slice(at, next < 0 ? undefined : next).trim();
	return { chars: section.length, hash: new Bun.CryptoHasher("sha256").update(section).digest("hex").slice(0, 12) };
}

function record(request: ChatRequest, who: Who, decision: Decision, bodyBytes: number): void {
	const messages = request.messages.map(message => ({ role: message.role, text: textOf(message.content) }));
	const users = messages.filter(entry => entry.role === "user");
	const last = messages.at(-1);
	// The system/developer text as the provider sees it; omp sends one system message, joined here when it sends more.
	const system = request.messages.filter(message => message.role === "system" || message.role === "developer").map(message => textOf(message.content)).join("\n");
	const stormTool = request.tools?.find(tool => tool.function.name === "storm");
	const storm = stormTool?.function;
	const packet = who === "child" ? packetsIn(heardText(request.messages)).at(-1) : undefined;
	const entry: LlmEntry = {
		ts: Date.now(),
		who,
		notes: request.messages
			.filter(message => message.role === "developer" || message.role === "user")
			.map(message => textOf(message.content))
			.filter(text => text.startsWith("[storm:") || text.startsWith("[storm]"))
			.map(text => text.slice(0, 1_200)),
		model: request.model,
		effort: request.reasoning_effort ?? request.reasoning?.effort ?? null,
		tools: request.tools?.map(tool => tool.function.name) ?? [],
		stormTool: storm ? { actions: (storm.parameters?.properties?.action?.enum ?? []).map(String), descriptionChars: storm.description?.length ?? 0 } : null,
		messageCount: messages.filter(entry => entry.role !== "system" && entry.role !== "developer").length,
		historyChars: messages.reduce((count, entry) => count + (entry.role === "system" || entry.role === "developer" ? 0 : entry.text.length), 0),
		users: users.map(entry => entry.text.slice(0, 300)),
		lastUser: (users.at(-1)?.text ?? "").slice(0, 8_000),
		keywordNotice: users.some(entry => NOTICES.some(notice => entry.text.includes(notice))),
		docRules: docRulesOf(system),
		systemBytes: Buffer.byteLength(system, "utf8"),
		systemSha256: new Bun.CryptoHasher("sha256").update(system).digest("hex").slice(0, 12),
		stormBlockBytes: Buffer.byteLength(
			[...system.matchAll(/<(storm-(?:auto|decision))>[\s\S]*?<\/\1>/g)].map(match => match[0]).join("\n"),
			"utf8",
		),
		toolsBytes: Buffer.byteLength(JSON.stringify(request.tools ?? []), "utf8"),
		stormToolBytes: stormTool === undefined ? 0 : Buffer.byteLength(JSON.stringify(stormTool), "utf8"),
		stormSchemaBytes: storm === undefined ? 0 : Buffer.byteLength(JSON.stringify(storm.parameters ?? {}), "utf8"),
		bodyBytes,
		roles: [...new Set(messages.flatMap(entry => [...entry.text.matchAll(/STORM-ROLE ([\w-]+)/g)].map(match => match[1] ?? "")))],
		lastTool: last?.role === "tool" ? last.text.slice(0, 1_000) : "",
		// omp adds a tool's `additionalContext` as a user message after the result, so the result is not always last.
		lastToolResult: messages.findLast(entry => entry.role === "tool")?.text.slice(0, 1_000) ?? "",
		trailingResults: messages.slice(messages.findLastIndex(entry => entry.role === "assistant") + 1).filter(entry => entry.role === "tool").map(entry => entry.text.slice(0, 1_000)),
		compactionContext: who === "compaction"
			? (users.at(-1)?.text.match(/<additional-context>[\s\S]*?<\/additional-context>/)?.[0] ??
				users.at(-1)?.text.match(/Additional focus: ([\s\S]*?)<\/instruction>/)?.[1] ?? "")
			: "",
		...(packet === undefined ? {} : { reviewPacket: { id: packet.id, receipt: packet.receipt, citation: packet.citation, answer: packet.answer } }),
		decision:
			decision.kind === "tool"
				? { tool: decision.name, args: decision.args, ...(decision.more === undefined ? {} : { all: [decision, ...decision.more].map(call => ({ tool: call.name, args: call.args })) }) }
				: { text: decision.text.slice(0, 200) },
	};
	appendFileSync(LOG, `${JSON.stringify(entry)}\n`);
}

const encoder = new TextEncoder();

function chunk(id: string, model: string, delta: Record<string, unknown>, finish: string | null): string {
	const created = Math.floor(Date.now() / 1000);
	return `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
}

/**
 * Prompt tokens a model claims, so Storm's context checks see a known size without a real history that large. The
 * window each one is measured against is the drivers' `models.yml`: `heavy-main` 35k on 60k (past half at run start),
 * `tight-main` 75k on 100k (past 70% mid-run), `wide-main` 150k on 1M (the old fixed run-start number, 15% of its
 * window), `wide-worker` 250k on 1M (a worker past the retired 200k follow-up cap).
 */
const CLAIMED_PROMPT: Record<string, number> = { [HEAVY_MAIN]: 35_000, "tight-main": 75_000, "wide-main": 150_000, "wide-worker": 250_000 };

function usageOf(model: string): { prompt_tokens: number; completion_tokens: number; total_tokens: number } {
	const prompt = CLAIMED_PROMPT[model] ?? 100;
	return { prompt_tokens: prompt, completion_tokens: 10, total_tokens: prompt + 10 };
}

function toolCallOf(decision: { name: string; args: Record<string, unknown> }): Record<string, unknown> {
	return { id: `call_${crypto.randomUUID().slice(0, 8)}`, type: "function", function: { name: decision.name, arguments: JSON.stringify(decision.args) } };
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
				const calls = [decision, ...(decision.more ?? [])];
				send(chunk(id, model, { role: "assistant", content: null, tool_calls: calls.map((call, index) => ({ index, ...toolCallOf(call) })) }, null));
				send(chunk(id, model, {}, "tool_calls"));
			}
			send(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [], usage: usageOf(model) })}\n\n`);
			send("data: [DONE]\n\n");
			controller.close();
		},
	});
	return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
}

function completion(model: string, decision: Decision): Response {
	const message = decision.kind === "text" ? { role: "assistant", content: decision.text } : { role: "assistant", content: null, tool_calls: [decision, ...(decision.more ?? [])].map(toolCallOf) };
	return Response.json({
		id: `chatcmpl-${crypto.randomUUID()}`,
		object: "chat.completion",
		created: Math.floor(Date.now() / 1000),
		model,
		choices: [{ index: 0, message, finish_reason: decision.kind === "text" ? "stop" : "tool_calls" }],
		usage: usageOf(model),
	});
}

function gateError(message: string): Response {
	return Response.json({ error: { message } }, { status: 400 });
}

Bun.serve({
	hostname: "127.0.0.1",
	port: PORT,
	async fetch(req) {
		const url = new URL(req.url);
		if (req.method === "GET" && url.pathname.endsWith("/models")) return Response.json({ object: "list", data: [] });
		if (req.method !== "POST" || !url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
		// The bytes as they arrived at the endpoint, before any parse or re-serialization: the honest size baseline.
		const raw = await req.text();
		const bodyBytes = Buffer.byteLength(raw, "utf8");
		const request = JSON.parse(raw) as ChatRequest;
		const who = classify(request);
		// A provider out of quota: omp falls back along retry.fallbackChains and emits retry_fallback_applied.
		// `x-should-retry` keeps the provider client from backing off for 15 s before omp sees the error.
		if (request.model === QUOTA_OUT) {
			record(request, who, { kind: "text", text: "429 insufficient_quota" }, bodyBytes);
			const error = { message: "You exceeded your current quota, please check your plan and billing details.", type: "insufficient_quota", code: "insufficient_quota" };
			return Response.json({ error }, { status: 429, headers: { "x-should-retry": "false" } });
		}
		// A child's first request fails retryably once, so a retry can be watched on the same native job.
		const retryKey = who === "child" ? /E2E-CHILD-429-ONCE[ \t]+(\S+)/.exec(userText(request.messages))?.[1] : undefined;
		if (retryKey !== undefined && !failedOnce.has(retryKey) && !request.messages.some(message => message.role === "assistant")) {
			failedOnce.add(retryKey);
			record(request, who, { kind: "text", text: "429 retry once" }, bodyBytes);
			const error = { message: "Temporary rate limit.", type: "rate_limit_error", code: "rate_limit" };
			return Response.json({ error }, { status: 429, headers: { "x-should-retry": "true", "retry-after-ms": "1" } });
		}
		const compactionsBefore = seen.compactions;
		if (who === "child") seen.children++;
		const decision = decide(request, who);
		const { awaitChildren, releaseChildren } = decision;
		if (awaitChildren && !(await hold(() => awaitChildren.every(key => waitingChildren.has(key))))) {
			return gateError(`Children never reached their gates: ${awaitChildren.filter(key => !waitingChildren.has(key)).join(", ")}`);
		}
		record(request, who, decision, bodyBytes);
		const releaseFile = decision.releaseFile;
		if (releaseFile !== undefined && (!/^[a-z][a-z0-9-]*$/u.test(releaseFile) ||
			!(await hold(() => existsSync(join(dirname(LOG), releaseFile)))))) {
			return gateError(`Director reply was never released: ${releaseFile}`);
		}
		if (releaseChildren) {
			const missing = releaseChildren.filter(key => !waitingChildren.has(key));
			if (missing.length > 0) return gateError(`Cannot release children not at their gates: ${missing.join(", ")}`);
			for (const key of releaseChildren) waitingChildren.delete(key);
		}
		const wakeGate = who === "child"
			? /E2E-WAKE-GATE[ \t]+(\S+)/.exec(textOf(request.messages.findLast(message => message.role === "user")?.content))?.[1]
			: undefined;
		const gate = wakeGate !== undefined && !seenWakeGates.has(wakeGate)
			? wakeGate
			: who === "child" && !request.messages.some(message => message.role === "assistant")
				? /E2E-CHILD-GATE[ \t]+(\S+)/.exec(userText(request.messages))?.[1]
				: undefined;
		if (gate !== undefined) {
			if (wakeGate !== undefined) seenWakeGates.add(wakeGate);
			waitingChildren.add(gate);
			if (!(await hold(() => !waitingChildren.has(gate)))) {
				waitingChildren.delete(gate);
				return gateError(`Child gate was never released: ${gate}`);
			}
		}
		if (decision.kind === "tool" && decision.name === "task") seen.childrenAtTask = seen.children;
		if (decision.waitFile !== undefined && !(await hold(() => existsSync(decision.waitFile as string)))) {
			return gateError(`The marker file never appeared: ${decision.waitFile}`);
		}
		if (decision.pauseMs !== undefined) await Bun.sleep(Math.min(decision.pauseMs, HOLD_MAX_MS));
		const finalPause = who === "child" && decision.kind === "text" ? /E2E-CHILD-FINAL-PAUSE[ \t]+(\d+)[ \t]+(\S+)/.exec(userText(request.messages)) : null;
		if (finalPause?.[1] !== undefined && finalPause[2] !== undefined) {
			writeFileSync(finalPause[2], String(Date.now()));
			await Bun.sleep(Math.min(Number(finalPause[1]), HOLD_MAX_MS));
		}
		const delay = childDelayMs(who, request.messages);
		if (delay > 0) await Bun.sleep(delay);
		if (decision.kind === "text" && decision.awaitChild) await hold(() => seen.children > seen.childrenAtTask);
		if (holdsForCompaction(who, request.messages) || holdsOnce(who, request.messages)) await hold(() => seen.compactions > compactionsBefore);
		if (who === "compaction") seen.compactions++;
		return request.stream ? stream(request.model, decision) : completion(request.model, decision);
	},
});
console.log(`fake-llm listening on http://127.0.0.1:${PORT}/v1, log ${LOG}`);
