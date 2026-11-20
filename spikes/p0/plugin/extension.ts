/**
 * OMP Storm P0 spike extension. Every probe appends one JSON line to STORM_SPIKE_LOG.
 *
 * - before_subagent_spawn: applies the rule for the spawned agent from the JSON file at
 *   STORM_SPIKE_POLICY ({ agents: { <name>: { model?, block?, reason? } }, default? }).
 * - /spike-send <idle|auto|followUp|steer> b64:<text>: pi.sendUserMessage now.
 * - /spike-arm <auto|followUp|steer> b64:<text>: pi.sendUserMessage when the next assistant
 *   message starts streaming. Text travels base64-encoded so the command line itself never
 *   carries a magic keyword.
 * - storm_spike_approve tool: ctx.ui.select + ctx.ui.confirm from inside tool execution.
 */
import { appendFileSync, readFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

interface Rule {
	model?: string[];
	block?: boolean;
	reason?: string;
}
interface Policy {
	agents?: Record<string, Rule>;
	default?: Rule;
}
type Mode = "idle" | "auto" | "followUp" | "steer" | "deferred";

const LOG = process.env.STORM_SPIKE_LOG ?? "/tmp/storm-p0/ext.jsonl";
const POLICY = process.env.STORM_SPIKE_POLICY;

function log(entry: Record<string, unknown>): void {
	appendFileSync(LOG, `${JSON.stringify({ ts: Date.now(), ...entry })}\n`);
}

function readPolicy(): Policy {
	if (!POLICY) return {};
	try {
		return JSON.parse(readFileSync(POLICY, "utf8")) as Policy;
	} catch (error) {
		log({ kind: "policy-error", error: String(error) });
		return {};
	}
}

function parseSend(args: string): { mode: Mode; text: string } {
	const [mode = "auto", payload = ""] = args.trim().split(/\s+/, 2);
	const text = payload.startsWith("b64:") ? Buffer.from(payload.slice(4), "base64").toString("utf8") : payload;
	return { mode: mode as Mode, text };
}

/** Tool execute() argument order differs between docs and types; find the context by shape. */
function contextOf(args: unknown[]): ExtensionContext | undefined {
	return args.find((arg): arg is ExtensionContext => !!arg && typeof arg === "object" && "ui" in arg && "hasUI" in arg);
}

export default function stormSpike(pi: ExtensionAPI): void {
	let armed: { mode: Mode; text: string } | undefined;

	function deliver(mode: Mode, text: string, ctx: ExtensionContext): void {
		log({ kind: "send", mode, idle: ctx.isIdle(), text });
		const options = mode === "followUp" || mode === "steer" ? { deliverAs: mode } : undefined;
		Promise.resolve(pi.sendUserMessage(text, options)).catch(error => log({ kind: "send-error", mode, error: String(error) }));
	}

	pi.on("session_start", (_event, ctx) => {
		log({ kind: "session_start", mode: ctx.mode, hasUI: ctx.hasUI, activeTools: pi.getActiveTools() });
	});

	pi.on("before_subagent_spawn", event => {
		const policy = readPolicy();
		const rule = policy.agents?.[event.agent] ?? policy.default;
		log({
			kind: "spawn",
			agent: event.agent,
			invocationKind: event.invocationKind,
			modelRole: event.modelRole ?? null,
			patterns: event.patterns,
			spawnKey: event.spawnKey ?? null,
			rule: rule ?? null,
		});
		if (rule?.block) return { block: true, reason: rule.reason ?? `storm: ${event.agent} is not approved` };
		if (rule?.model) return { model: rule.model, note: `storm spike route for ${event.agent}` };
		return undefined;
	});

	pi.on("message_start", (event, ctx) => {
		if (!armed || armed.mode === "deferred" || event.message.role !== "assistant") return;
		const { mode, text } = armed;
		armed = undefined;
		log({ kind: "armed-fire", mode, idle: ctx.isIdle() });
		deliver(mode, text, ctx);
	});

	// Deferred: hand off after the run ends, through the idle path (no deliverAs), once idle.
	pi.on("agent_end", (_event, ctx) => {
		if (armed?.mode !== "deferred") return;
		const { text } = armed;
		armed = undefined;
		log({ kind: "armed-fire", mode: "deferred", idle: ctx.isIdle() });
		void (async () => {
			for (let attempt = 0; attempt < 100 && !ctx.isIdle(); attempt++) await Bun.sleep(50);
			deliver("auto", text, ctx);
		})();
	});

	pi.registerCommand("spike-send", {
		description: "P0 spike: pi.sendUserMessage now (idle|auto|followUp|steer b64:<text>)",
		handler: async (args, ctx) => {
			const { mode, text } = parseSend(args);
			if (mode === "idle") await ctx.waitForIdle();
			deliver(mode, text, ctx);
		},
	});

	pi.registerCommand("spike-arm", {
		description: "P0 spike: pi.sendUserMessage when the next assistant message streams",
		handler: async args => {
			armed = parseSend(args);
			log({ kind: "arm", mode: armed.mode, text: armed.text });
		},
	});

	pi.registerTool({
		name: "storm_spike_approve",
		label: "Storm spike approve",
		description: "P0 spike: ask the user to approve through ctx.ui.select and ctx.ui.confirm.",
		parameters: pi.zod.object({}),
		async execute(...args: unknown[]) {
			const ctx = contextOf(args);
			const info: Record<string, unknown> = { hasUI: ctx?.hasUI ?? null, mode: ctx?.mode ?? null };
			try {
				info.select = (await ctx?.ui.select("Storm 승인? [dlg-select]", ["승인", "취소"])) ?? null;
			} catch (error) {
				info.selectError = String(error);
			}
			try {
				info.confirm = (await ctx?.ui.confirm("Storm 확인 [dlg-confirm]", "이 구성을 적용할까요?")) ?? null;
			} catch (error) {
				info.confirmError = String(error);
			}
			log({ kind: "ui", ...info });
			return { content: [{ type: "text", text: JSON.stringify(info) }] };
		},
	});
}
