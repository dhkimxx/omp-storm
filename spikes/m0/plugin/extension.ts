/**
 * OMP Storm M0 spike extension: drives omp's built-in session modes through `ctx.sessionModes` and
 * appends one JSON line per observed event to STORM_M0_LOG. It loads in every session omp creates
 * with the parent's extensions (subagents, vibe workers), so each line carries `ctx.agent`.
 *
 * Commands (payloads are base64 so the command line carries no directive text):
 *   /m0-set b64:<SessionModeRequest json>     ctx.sessionModes.set() from the command handler
 *   /m0-state                                 ctx.sessionModes.getState()
 *   /m0-send b64:<text>                       pi.sendUserMessage once idle
 *   /m0-arm b64:<SessionModeRequest json>     set() from the next terminal agent_end handler, then again once idle
 *   /m0-stop <n> b64:<context>                 the next n session_stop events request a continuation
 *   /m0-block <tool>                          tool_call handlers block that tool
 * Tool `m0_set { request }`: set() from inside a tool's execute.
 */
import { appendFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext, SessionModeRequest } from "@oh-my-pi/pi-coding-agent";

const LOG = process.env.STORM_M0_LOG ?? "/tmp/storm-m0/ext.jsonl";

function log(entry: Record<string, unknown>): void {
	appendFileSync(LOG, `${JSON.stringify({ ts: Date.now(), ...entry })}\n`);
}

const decode = (payload: string): string => (payload.startsWith("b64:") ? Buffer.from(payload.slice(4), "base64").toString("utf8") : payload);

const who = (ctx: ExtensionContext): string => `${ctx.agent.kind}:${ctx.agent.id}:${ctx.agent.name}:d${ctx.agent.depth}${ctx.agent.parentId ? `<${ctx.agent.parentId}` : ""}`;

/** `plan/vibe/goal/loop` statuses on one line; `none` when the host has no mode control. */
function modes(ctx: ExtensionContext): string {
	const state = ctx.sessionModes?.getState();
	return state ? `plan=${state.plan.status} vibe=${state.vibe.status} goal=${state.goal.status} loop=${state.loop.status}` : "none";
}

async function setMode(ctx: ExtensionContext, from: string, request: SessionModeRequest): Promise<string> {
	if (!ctx.sessionModes) {
		log({ kind: "set", from, request, result: "no ctx.sessionModes", idle: ctx.isIdle() });
		return "no ctx.sessionModes";
	}
	const idle = ctx.isIdle();
	try {
		const result = await ctx.sessionModes.set(request);
		const summary = result.ok ? `ok changed=${result.changed}` : `${result.code}: ${result.message}`;
		log({ kind: "set", from, request, result: summary, idle, modes: modes(ctx) });
		return summary;
	} catch (error) {
		log({ kind: "set", from, request, result: `threw ${String(error)}`, idle });
		return `threw ${String(error)}`;
	}
}

/** Tool execute() receives the context after the update callback; find it by shape. */
function contextOf(args: unknown[]): ExtensionContext | undefined {
	return args.find((arg): arg is ExtensionContext => !!arg && typeof arg === "object" && "ui" in arg && "hasUI" in arg);
}

export default function stormM0(pi: ExtensionAPI): void {
	let armed: SessionModeRequest | undefined;
	let stops = 0;
	let stopContext = "M0-STOP-CONTINUE";
	let blockedTool: string | undefined;

	pi.on("session_start", (_event, ctx) => {
		log({ kind: "session_start", who: who(ctx), host: ctx.mode, hasUI: ctx.hasUI, sessionModes: typeof ctx.sessionModes, modes: modes(ctx), activeTools: pi.getActiveTools() });
		if (ctx.agent.kind === "main" && process.env.STORM_M0_SET_AT_START) {
			void setMode(ctx, "session_start", { mode: "loop", action: "enter" }).then(() => setMode(ctx, "session_start", { mode: "loop", action: "exit" }));
		}
	});

	pi.on("mode_changed", (event, ctx) => {
		const line = (state: typeof event.state) => `plan=${state.plan.status} vibe=${state.vibe.status} goal=${state.goal.status} loop=${state.loop.status}`;
		log({ kind: "mode_changed", who: who(ctx), previous: line(event.previous), state: line(event.state), goal: event.state.goal, idle: ctx.isIdle(), activeTools: pi.getActiveTools() });
	});

	pi.on("goal_updated", (event, ctx) => {
		const goal = event.goal;
		log({
			kind: "goal_updated",
			who: who(ctx),
			goal: goal ? { status: goal.status, tokensUsed: goal.tokensUsed, tokenBudget: goal.tokenBudget ?? null, timeUsedSeconds: goal.timeUsedSeconds } : null,
			state: event.state ? { enabled: event.state.enabled, mode: event.state.mode, reason: event.state.reason ?? null } : null,
		});
	});

	pi.on("input", (event, ctx) => {
		log({ kind: "input", who: who(ctx), source: event.source, text: event.text.slice(0, 60) });
	});

	pi.on("agent_start", (_event, ctx) => {
		log({ kind: "agent_start", who: who(ctx), modes: modes(ctx) });
	});

	pi.on("agent_end", (event, ctx) => {
		const last = event.messages.findLast(message => message.role === "assistant");
		log({
			kind: "agent_end",
			who: who(ctx),
			willContinue: event.willContinue ?? false,
			awaitingAsyncWork: event.awaitingAsyncWork ?? false,
			modes: modes(ctx),
			idle: ctx.isIdle(),
			lastStop: last && "stopReason" in last ? last.stopReason : null,
		});
		if (!armed || event.willContinue) return;
		const request = armed;
		armed = undefined;
		void (async () => {
			await setMode(ctx, "agent_end", request);
			for (let attempt = 0; attempt < 100 && !ctx.isIdle(); attempt++) await Bun.sleep(50);
			await setMode(ctx, "agent_end+idle", request);
		})();
	});

	pi.on("session_stop", (event, ctx) => {
		const willAsk = stops > 0;
		log({ kind: "session_stop", who: who(ctx), turnId: event.turn_id, stopHookActive: event.stop_hook_active, modes: modes(ctx), continue: willAsk });
		if (!willAsk) return undefined;
		stops--;
		return { continue: true, additionalContext: stopContext };
	});

	pi.on("before_subagent_spawn", (event, ctx) => {
		log({ kind: "spawn", who: who(ctx), agent: event.agent, invocationKind: event.invocationKind, modelRole: event.modelRole ?? null, patterns: event.patterns, spawnKey: event.spawnKey ?? null });
		return undefined;
	});

	pi.on("tool_call", (event, ctx) => {
		const block = blockedTool === event.toolName;
		log({ kind: "tool_call", who: who(ctx), tool: event.toolName, modes: modes(ctx), block });
		return block ? { block: true, reason: `[m0] ${event.toolName} is blocked by the spike extension` } : undefined;
	});

	pi.registerCommand("m0-set", {
		description: "M0 spike: ctx.sessionModes.set(b64:<json>)",
		handler: async (args, ctx) => {
			await setMode(ctx, "command", JSON.parse(decode(args.trim())) as SessionModeRequest);
		},
	});

	pi.registerCommand("m0-state", {
		description: "M0 spike: log ctx.sessionModes.getState()",
		handler: async (_args, ctx) => {
			log({ kind: "state", who: who(ctx), host: ctx.mode, sessionModes: typeof ctx.sessionModes, state: ctx.sessionModes?.getState() ?? null, activeTools: pi.getActiveTools() });
		},
	});

	pi.registerCommand("m0-send", {
		description: "M0 spike: pi.sendUserMessage(b64:<text>) once idle",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			const text = decode(args.trim());
			log({ kind: "send", text, modes: modes(ctx) });
			Promise.resolve(pi.sendUserMessage(text)).catch(error => log({ kind: "send-error", error: String(error) }));
		},
	});

	pi.registerCommand("m0-arm", {
		description: "M0 spike: set(b64:<json>) from the next terminal agent_end",
		handler: async args => {
			armed = JSON.parse(decode(args.trim())) as SessionModeRequest;
			log({ kind: "arm", request: armed });
		},
	});

	pi.registerCommand("m0-stop", {
		description: "M0 spike: the next <n> session_stop events request a continuation",
		handler: async args => {
			const [count = "1", context] = args.trim().split(/\s+/, 2);
			stops = Number(count) || 0;
			if (context) stopContext = decode(context);
			log({ kind: "stop-armed", stops, stopContext });
		},
	});

	pi.registerCommand("m0-block", {
		description: "M0 spike: block a tool from tool_call",
		handler: async args => {
			blockedTool = args.trim() || undefined;
			log({ kind: "block-armed", tool: blockedTool ?? null });
		},
	});

	pi.registerTool({
		name: "m0_set",
		label: "M0 set mode",
		description: "M0 spike: call ctx.sessionModes.set with the JSON request from inside a tool.",
		parameters: pi.zod.object({ request: pi.zod.string() }),
		async execute(...args: unknown[]) {
			const ctx = contextOf(args);
			const params = args[1] as { request: string };
			const result = ctx ? await setMode(ctx, "tool", JSON.parse(params.request) as SessionModeRequest) : "no context";
			return { content: [{ type: "text", text: result }] };
		},
	});
}
