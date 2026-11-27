/**
 * Probe extension for `scripts/e2e/director-edit.ts` and `host-facts.ts`. Test support only: it makes no model call.
 *
 * It is loaded after Storm (`-e`), so for every call Storm's `tool_call` hook answers first. What it does, by the first word of
 * the call's own path (it never touches a call that does not carry one):
 *
 *   - `hook-delay-…`  a `write` whose hook is held for `HOOK_DELAY_MS`: the call is already entered in Storm's table when it waits,
 *                     so a user abort or a switch during it ends a call that Storm holds and the host never ran.
 *   - `slow-…`        the `write` TOOL is this probe's: it takes `SLOW_MS` and then writes the file. A call of the real tool that takes
 *                     seconds cannot be made on the fake model, and "a call has started and has no result yet" is what a switch of
 *                     conversation needs to meet. Any other path is written at once.
 *   - tools `multi_edit` and `notebook_edit`: stand-ins for the plugin tools of those names, which write the file their `path` names.
 *
 * It also records every `tool_call` and `turn_end` of the main session (ids only) to `EDIT_PROBE_LOG` when that variable names a file,
 * the way the host-facts scenario compares the id the hook saw with the ids the turn's end carries.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export const HOOK_DELAY_MS = 8_000;
export const SLOW_MS = 6_000;

const LOG = process.env.EDIT_PROBE_LOG ?? "";
const log = (entry: Record<string, unknown>): void => {
	if (LOG !== "") appendFileSync(LOG, `${JSON.stringify({ t: Date.now(), ...entry })}\n`);
};

function pathOf(input: unknown): string {
	return typeof input === "object" && input !== null && typeof (input as { path?: unknown }).path === "string" ? (input as { path: string }).path : "";
}
const leaf = (path: string): string => path.split("/").at(-1) ?? "";

/** Every tool call id in a message's content. */
function callIds(message: unknown): string[] {
	const content = typeof message === "object" && message !== null ? (message as { content?: unknown }).content : undefined;
	return Array.isArray(content) ? content.flatMap(block => (typeof block === "object" && block !== null && (block as { type?: unknown }).type === "toolCall" && typeof (block as { id?: unknown }).id === "string" ? [(block as { id: string }).id] : [])) : [];
}

export default function probe(pi: ExtensionAPI): void {
	const z = pi.zod;
	const stand = (name: string) =>
		pi.registerTool({
			name,
			label: name,
			description: `probe stand-in for a plugin tool named ${name}: writes the file its path names`,
			parameters: z.object({ path: z.string() }),
			async execute(_id, params) {
				const target = resolve(process.cwd(), (params as { path: string }).path);
				mkdirSync(dirname(target), { recursive: true });
				writeFileSync(target, `${name} wrote this\n`);
				return { content: [{ type: "text", text: `${name} wrote ${target}` }], details: {} };
			},
		});
	if (process.env.EDIT_PROBE_TOOLS === "1") {
		stand("multi_edit");
		stand("notebook_edit");
	}
	if (process.env.EDIT_PROBE_SLOW === "1") {
		pi.registerTool({
			name: "write",
			label: "write",
			description: "Writes a file (probe: a path that starts with `slow-` takes a while).",
			parameters: z.object({ path: z.string(), content: z.string() }),
			async execute(_id, params) {
				const { path, content } = params as { path: string; content: string };
				if (leaf(path).startsWith("slow-")) await Bun.sleep(SLOW_MS);
				const target = resolve(process.cwd(), path);
				mkdirSync(dirname(target), { recursive: true });
				writeFileSync(target, content);
				return { content: [{ type: "text", text: `Successfully wrote ${content.length} bytes to ${path}` }], details: {} };
			},
		});
	}
	pi.on("tool_call", async (event, ctx) => {
		if (ctx.agent.kind === "main") log({ ev: "tool_call", tool: event.toolName, id: event.toolCallId, path: pathOf(event.input) });
		if (event.toolName === "write" && leaf(pathOf(event.input)).startsWith("hook-delay-")) await Bun.sleep(HOOK_DELAY_MS);
		return undefined;
	});
	pi.on("message_end", async (event, ctx) => {
		if (ctx.agent.kind !== "main") return;
		const message = (event as { message?: unknown }).message;
		if (typeof message === "object" && message !== null && (message as { role?: unknown }).role === "assistant") log({ ev: "message_end", ids: callIds(message), stop: (message as { stopReason?: unknown }).stopReason });
	});
	pi.on("tool_execution_start", async (event, ctx) => {
		if (ctx.agent.kind === "main") log({ ev: "tool_execution_start", id: (event as { toolCallId?: unknown }).toolCallId });
	});
	pi.on("turn_end", async (event, ctx) => {
		if (ctx.agent.kind !== "main") return;
		const results = (event as { toolResults?: unknown[] }).toolResults ?? [];
		log({ ev: "turn_end", ids: callIds((event as { message?: unknown }).message), resultIds: results.flatMap(result => (typeof result === "object" && result !== null && typeof (result as { toolCallId?: unknown }).toolCallId === "string" ? [(result as { toolCallId: string }).toolCallId] : [])) });
	});
}
