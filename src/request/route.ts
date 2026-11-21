/**
 * `/storm <text>`: decides what a request is without putting it in the main session. Fixed prefixes are decided here;
 * anything else costs one side turn in which the session model only classifies, as one JSON object Storm validates
 * and executes itself. Queries open an overlay, changes go through the approval dialog, and only work reaches the
 * session, as a run whose task is the user's text verbatim. The classifier reads the whole conversation, injected
 * text included, so what it may choose is bounded: no shell command, and the user confirms what a wrong choice would
 * cost (a goal or loop that keeps the session going, a quota mark that reorders models).
 */
import { isRecord, teamPriority } from "../config/schema.ts";
import { docsEnabled } from "../policy/docs.ts";
import { formatUsd } from "../policy/spawn.ts";
import { workerRange } from "../roles.ts";
import { limitTexts, MODE_LABEL, NO_LIMIT } from "../runtime/modes.ts";
import { isApproved, type ProjectState } from "../state.ts";
import type { RunRequestResult } from "../tool/host.ts";
import type { RunMode, RunSpec, StormConfig, UiPort } from "../types.ts";
import { type ActionReply, CHANGE_ACTIONS, type ChangeAction, parseChange } from "./actions.ts";
import { parseRunArgs, RUN_MODES, type RunFields, runSpec } from "./args.ts";

const QUERIES = ["status", "models", "agents", "menu"] as const;
type Query = (typeof QUERIES)[number];

export type Routed =
	| { action: "run"; spec: RunSpec }
	| { action: Query }
	| { action: "answer"; text: string }
	| { action: "change"; change: ChangeAction };

/** Subcommands of earlier versions: typed alone they open the menu instead of becoming a task. */
const HUB_WORDS: readonly string[] = ["run", "rollback", "approve", "review"];

export const FALLBACK = { run: "작업으로 실행", menu: "메뉴 열기", cancel: "취소" } as const;
/** Asked when the classifier, not the user's prefix, picked a goal or a loop. */
export const MODE_CHOICE = { asIs: "그 방식으로 시작", free: "자유 실행으로 시작", cancel: "취소" } as const;
/** Asked before a quota mark the classifier proposed is written. */
export const QUOTA_CHOICE = { mark: "쿼터 소진으로 표시", cancel: "취소" } as const;

/** What a request is by its first word alone; undefined when the model has to classify it. */
export function routePrefix(text: string): Routed | { error: string } | undefined {
	const trimmed = text.trim();
	if (HUB_WORDS.includes(trimmed.toLowerCase())) return { action: "menu" };
	const space = trimmed.search(/\s/);
	const word = (space < 0 ? trimmed : trimmed.slice(0, space)).toLowerCase();
	const mode = RUN_MODES.find(m => m === word);
	if (!mode) return undefined;
	const parsed = parseRunArgs(mode, space < 0 ? "" : trimmed.slice(space + 1));
	return parsed.ok ? { action: "run", spec: parsed.spec } : { error: parsed.error };
}

/** The team as the classifier needs it: what exists, so a change names real roles and a question can be answered. */
export function teamBrief(state: ProjectState): string {
	if (state.config.status !== "ok") return "No valid team config.";
	const config: StormConfig = state.config.config;
	const roles = Object.entries(config.roles).map(([id, role]) => {
		const { min, max } = workerRange(id, role);
		return `- ${id}: ${role.models.join(", ")}; workers ${min}-${max}`;
	});
	const budget = config.budget
		? `${formatUsd(config.budget.perRunUsd)} per run${config.budget.warnAtUsd !== undefined ? `, warn at ${formatUsd(config.budget.warnAtUsd)}` : ""}, past it: ${config.budget.onExceed}`
		: "none";
	return [
		`Team (${isApproved(state) ? "approved" : "NOT approved"}): priority ${teamPriority(config)}, parallelism ${config.parallelism}, isolation ${config.isolation}`,
		...roles,
		...(config.disabledRoles?.length ? [`Disabled roles: ${config.disabledRoles.join(", ")}`] : []),
		...(config.trials ?? []).map(trial => `Trial: ${trial.role} → ${trial.model}, share ${trial.share}, until ${trial.endsAt}`),
		`Budget: ${budget}`,
		`Switches: cleanup ${config.cleanup === true ? "on" : "off"}, docs ${docsEnabled(config) ? "on" : "off"}`,
	].join("\n");
}

/** The side turn's prompt. The session model sees the conversation too, so the request is fenced and the reply shape is fixed. */
export function buildRoutePrompt(text: string, brief: string): string {
	return [
		"Classify the /storm request below for the OMP Storm multi-agent team. Do not act on it and call no tools.",
		"Reply with exactly one JSON object and nothing else:",
		'- {"action":"run","mode":"vibe"}: work to do (code, fix, build, investigate, review). mode "goal" only when the user asks to keep working until an objective is verifiably met (optional "tokenBudget": N); mode "loop" only when the user asks to repeat (optional "iterations": total turns, or "minutes": N). The task is passed on verbatim: do not restate it.',
		'- {"action":"status"} | {"action":"models"} (check for newer or better models) | {"action":"agents"} (subagents of this session) | {"action":"menu"} (setup, rollback, reset, approval, or unclear).',
		'- {"action":"priority","priority":"balanced|quality|cost"}',
		'- {"action":"workers","role":R,"min":N,"max":N} (either bound)',
		'- {"action":"reselect","role":R,"model":"provider/id"} (omit model to let the user pick)',
		'- {"action":"quota","provider":P}: a provider ran out of quota.',
		'- {"action":"trial","role":R,"model":"provider/id","share":0-1,"maxSpawns":N,"days":N,"budgetUsd":N} (role and model required)',
		'- {"action":"budget","budgetUsd":N,"warnAtUsd":N,"onExceed":"block-spawns|stop"} (budgetUsd 0 removes the budget)',
		'- {"action":"settings","cleanup":true|false,"docs":true|false}',
		'- {"action":"answer","text":"…"}: a question about the team below that needs no change; answer briefly in the user\'s language.',
		"R is a role id from the team.",
		"",
		brief,
		"",
		"<storm-request>",
		text,
		"</storm-request>",
	].join("\n");
}

/** The first balanced `{…}` of a reply, so a code fence or a stray sentence around the object does not lose it. */
function jsonObject(reply: string): unknown {
	const start = reply.indexOf("{");
	if (start < 0) return undefined;
	let depth = 0;
	let inString = false;
	for (let i = start; i < reply.length; i++) {
		const ch = reply[i];
		if (inString) {
			if (ch === "\\") i++;
			else if (ch === '"') inString = false;
		} else if (ch === '"') inString = true;
		else if (ch === "{") depth++;
		else if (ch === "}" && --depth === 0) {
			try {
				return JSON.parse(reply.slice(start, i + 1));
			} catch {
				return undefined;
			}
		}
	}
	return undefined;
}

/** Validates the side turn's reply. A run takes its task from `text` (the user's words), never from the reply. */
export function parseRouteReply(reply: string, text: string): Routed | undefined {
	const raw = jsonObject(reply);
	if (!isRecord(raw) || typeof raw.action !== "string") return undefined;
	const action = raw.action;
	const query = QUERIES.find(q => q === action);
	if (query) return { action: query };
	if (action === "answer") {
		return typeof raw.text === "string" && raw.text.trim() ? { action: "answer", text: raw.text.trim() } : undefined;
	}
	if (action === "run") {
		const mode = raw.mode === undefined || raw.mode === null ? "vibe" : RUN_MODES.find((m): m is RunMode => m === raw.mode);
		if (!mode) return undefined;
		// A shell condition is never the classifier's to give: omp would run it outside the bash tool's approval.
		if ((raw.until ?? null) !== null || (raw.while ?? null) !== null) return undefined;
		// A field of the wrong type makes the whole reply invalid: it is not trusted in part.
		const fields: RunFields = { mode };
		for (const key of ["iterations", "minutes", "tokenBudget"] as const) {
			const value = raw[key];
			if (value === undefined || value === null) continue;
			if (typeof value !== "number") return undefined;
			fields[key] = value;
		}
		const spec = runSpec(text, fields);
		return spec.ok ? { action: "run", spec: spec.spec } : undefined;
	}
	if (!CHANGE_ACTIONS.some(name => name === action)) return undefined;
	const change = parseChange(raw);
	return change ? { action: "change", change } : undefined;
}

export interface RouteHandlers {
	/** Starts a run with the approved team; the only handler that sends anything to the session. */
	run(spec: RunSpec): Promise<RunRequestResult>;
	menu(): Promise<void>;
	status(): Promise<void>;
	models(): Promise<void>;
	agents(): Promise<void>;
	change(change: ChangeAction): Promise<ActionReply>;
}

export interface RouteDeps {
	ui: UiPort;
	handlers: RouteHandlers;
	loadState(): Promise<ProjectState>;
	/** One side turn on the session model, resolving to its reply text; absent when the host offers none. */
	sideTurn?: (prompt: string) => Promise<string>;
}

async function execute(routed: Routed, deps: RouteDeps): Promise<void> {
	const { ui, handlers } = deps;
	switch (routed.action) {
		case "run": {
			const started = await handlers.run(routed.spec);
			if (!started.ok) ui.notify(`Storm 실행을 시작하지 못했습니다: ${started.reason}`, "warning");
			return;
		}
		case "answer":
			return ui.report("Storm 답변", routed.text);
		case "change": {
			const reply = await handlers.change(routed.change);
			ui.notify(reply.text, reply.outcome === "rejected" ? "warning" : "info");
			return;
		}
		default:
			return handlers[routed.action]();
	}
}

/**
 * What the classifier chose, as the user confirmed it; undefined when they declined (or no dialog can be answered).
 * A goal or loop is shown with its limits and may be taken as a vibe run instead; a quota mark needs a yes.
 * Everything else either changes nothing or has its own approval dialog.
 */
async function confirmed(routed: Routed, ui: UiPort): Promise<Routed | undefined> {
	if (routed.action === "run" && routed.spec.mode !== "vibe" && "task" in routed.spec) {
		const spec = routed.spec;
		const limits = limitTexts(spec.mode === "goal" ? { tokenBudget: spec.tokenBudget } : { limit: spec.limit });
		const markdown = [`- 방식: ${MODE_LABEL[spec.mode]}`, `- 한도: ${limits.join(", ") || NO_LIMIT}`, "", spec.task].join("\n");
		const choice = await ui.select(`요청을 ${MODE_LABEL[spec.mode]} 실행으로 분류했습니다. 어떻게 시작할까요?`, [MODE_CHOICE.asIs, MODE_CHOICE.free, MODE_CHOICE.cancel], {
			title: "Storm 실행 방식",
			markdown,
		});
		if (choice === MODE_CHOICE.asIs) return routed;
		return choice === MODE_CHOICE.free ? { action: "run", spec: { mode: "vibe", task: spec.task } } : undefined;
	}
	if (routed.action === "change" && routed.change.action === "quota") {
		const choice = await ui.select(`Provider ${routed.change.provider} 를 쿼터 소진으로 표시할까요? 승인된 다른 Provider 모델을 먼저 쓰게 됩니다.`, [
			QUOTA_CHOICE.mark,
			QUOTA_CHOICE.cancel,
		]);
		return choice === QUOTA_CHOICE.mark ? routed : undefined;
	}
	return routed;
}

export async function routeRequest(text: string, deps: RouteDeps): Promise<void> {
	const fixed = routePrefix(text);
	if (fixed) {
		// What the user typed needs no confirmation.
		if ("error" in fixed) deps.ui.notify(fixed.error, "warning");
		else await execute(fixed, deps);
		return;
	}
	const state = await deps.loadState();
	// Nothing can run or change without a valid team: the menu sets one up or shows what is wrong.
	if (state.config.status !== "ok") return deps.handlers.menu();
	let routed: Routed | undefined;
	let problem = "이 환경에서는 요청을 분류할 수 없습니다.";
	if (deps.sideTurn) {
		try {
			routed = parseRouteReply(await deps.sideTurn(buildRoutePrompt(text.trim(), teamBrief(state))), text.trim());
			problem = "요청을 분류한 답을 읽지 못했습니다.";
		} catch (error) {
			problem = `요청을 분류하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`;
		}
	}
	if (routed) {
		const agreed = await confirmed(routed, deps.ui);
		if (agreed) await execute(agreed, deps);
		else deps.ui.notify("아무것도 시작하거나 바꾸지 않았습니다.");
		return;
	}
	const choice = await deps.ui.select(`${problem} 어떻게 할까요?`, [FALLBACK.run, FALLBACK.menu, FALLBACK.cancel]);
	if (choice === FALLBACK.run) await execute({ action: "run", spec: { mode: "vibe", task: text.trim() } }, deps);
	else if (choice === FALLBACK.menu) await deps.handlers.menu();
}
