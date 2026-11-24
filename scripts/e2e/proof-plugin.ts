/**
 * Probe extension for `scripts/e2e/proof-channel.ts`: records the native host events a trusted parent runtime can
 * see, plus the process-global AgentRegistry facts that correlate them, as JSONL. Test support only.
 */
import { appendFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { threadId } from "node:worker_threads";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent";

const LOG = process.env.PROOF_CHANNEL_LOG ?? "";
if (LOG === "") throw new Error("PROOF_CHANNEL_LOG is required");

interface ProbeAgent {
	id?: string;
	name?: string;
	kind?: string;
	parentId?: string;
	depth?: number;
}
interface ProbeContext {
	agent?: ProbeAgent;
	sessionManager?: { getHeader?: () => unknown };
}
interface ProbeEvent {
	[key: string]: unknown;
	message?: unknown;
	toolName?: string;
	toolCallId?: string;
	isError?: boolean;
	details?: unknown;
	input?: unknown;
	content?: unknown;
	willContinue?: boolean;
	awaitingAsyncWork?: boolean;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map(part => (part && typeof part === "object" && "text" in part ? String(part.text) : "")).join("\n");
}

/** What the parent process can read at a native handle right now: existence, size and the first bytes. */
function artifactOf(path: unknown): unknown {
	if (typeof path !== "string" || path === "") return undefined;
	if (!existsSync(path)) return { path, exists: false };
	const info = statSync(path);
	return { path, exists: true, bytes: info.size, head: info.isFile() ? readFileSync(path).subarray(0, 240).toString("utf8") : undefined };
}

function summarizeResult(result: Record<string, unknown>): Record<string, unknown> {
	const structured = result.structuredOutput as Record<string, unknown> | undefined;
	return {
		index: result.index,
		id: result.id,
		agent: result.agent,
		task: result.task,
		assignment: result.assignment,
		exitCode: result.exitCode,
		output: typeof result.output === "string" ? result.output.slice(0, 500) : result.output,
		outputChars: typeof result.output === "string" ? result.output.length : undefined,
		stderr: typeof result.stderr === "string" ? result.stderr.slice(0, 300) : result.stderr,
		error: result.error,
		aborted: result.aborted,
		abortReason: result.abortReason,
		isolated: result.isolated,
		outputPath: result.outputPath,
		outputArtifact: artifactOf(result.outputPath),
		patchPath: result.patchPath,
		patchArtifact: artifactOf(result.patchPath),
		hasRootChanges: result.hasRootChanges,
		branchName: result.branchName,
		nestedPatchPaths: result.nestedPatchPaths,
		structured: structured
			? { source: structured.source, mode: structured.mode, status: structured.status, data: structured.data, error: structured.error }
			: undefined,
	};
}

function summarizeDetails(details: unknown): unknown {
	if (details === null || typeof details !== "object") return details;
	const value = details as Record<string, unknown>;
	const results = Array.isArray(value.results) ? value.results.filter(item => item && typeof item === "object").map(item => summarizeResult(item as Record<string, unknown>)) : undefined;
	const progress = Array.isArray(value.progress)
		? value.progress.map(item => {
				const p = (item ?? {}) as Record<string, unknown>;
				return { index: p.index, id: p.id, agent: p.agent, status: p.status, task: p.task, requests: p.requests, retryFailure: p.retryFailure };
			})
		: undefined;
	return { async: value.async, results, progress, outputPaths: value.outputPaths, projectAgentsDir: value.projectAgentsDir, totalDurationMs: value.totalDurationMs };
}

/** Parent-side view of every child ref, including the thread that owns its session. */
function registrySnapshot(): unknown[] {
	try {
		return AgentRegistry.global().list().map(ref => ({
			id: ref.id,
			kind: ref.kind,
			status: ref.status,
			parentId: ref.parentId,
			lifecycle: ref.lifecycle,
			instanceKey: ref.session?.instanceKey,
			home: ref.session?.instanceKey?.split(":")[0],
			history: ref.history,
			outputArtifact: artifactOf(ref.history?.outputPath),
			patchArtifact: artifactOf(ref.history?.patchPath),
			sessionFile: ref.sessionFile,
		}));
	} catch (error) {
		return [{ error: error instanceof Error ? error.message : String(error) }];
	}
}

function log(event: Record<string, unknown>): void {
	appendFileSync(LOG, `${JSON.stringify({ at: Date.now(), threadId, ...event })}\n`);
}


export default function probe(pi: {
	on(name: string, handler: (event: ProbeEvent, ctx: ProbeContext) => unknown): void;
}): void {
	let subscribed = false;
	pi.on("session_start", (_event, ctx) => {
		log({ type: "session_start", agent: ctx.agent, home: ctx.sessionManager?.getHeader?.() });
		// The main thread's registry is the process-global mirror: a worker child's status/history changes arrive here.
		if (subscribed || ctx.agent?.kind !== "main") return;
		subscribed = true;
		AgentRegistry.global().onChange(event => {
			const ref = event.ref;
			log({
				type: "registry_event",
				eventType: event.type,
				id: ref.id,
				status: ref.status,
				parentId: ref.parentId,
				home: ref.session?.instanceKey?.split(":")[0],
				history: ref.history,
				outputArtifact: artifactOf(ref.history?.outputPath),
				patchArtifact: artifactOf(ref.history?.patchPath),
			});
		});
	});
	pi.on("before_subagent_spawn", (event, ctx) => {
		log({ type: "before_subagent_spawn", agent: ctx.agent, event });
	});
	pi.on("tool_result", (event, ctx) => {
		if (ctx.agent?.kind !== "main") return;
		log({
			type: "tool_result",
			toolName: event.toolName,
			toolCallId: event.toolCallId,
			isError: event.isError,
			input: event.toolName === "task" || event.toolName === "write" ? event.input : undefined,
			content: textOf(event.content).slice(0, 4_000),
			details: summarizeDetails(event.details),
			registry: registrySnapshot(),
		});
	});
	pi.on("message_end", (event, ctx) => {
		const message = recordOf(event.message);
		if (message?.role !== "custom") return;
		log({
			type: "custom_message",
			agent: ctx.agent,
			customType: message.customType,
			content: textOf(message.content).slice(0, 8_000),
			details: message.details,
			registry: registrySnapshot(),
		});
	});
	pi.on("agent_start", (_event, ctx) => {
		log({ type: "agent_start", agent: ctx.agent });
	});
	pi.on("agent_end", (event, ctx) => {
		log({
			type: "agent_end",
			agent: ctx.agent,
			willContinue: event.willContinue,
			awaitingAsyncWork: event.awaitingAsyncWork,
			registry: registrySnapshot(),
		});
	});
}
