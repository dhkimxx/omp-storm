/**
 * Run requests without a model call: the arguments of `/storm vibe|goal|loop …` and the run fields the storm tool
 * and the request router carry, each turned into a `RunSpec`. The loop grammar mirrors omp's `/loop`, except that a
 * count is the total number of turns (omp counts repeats).
 */
import type { LoopCondition, LoopLimit, RunMode, RunSpec } from "../types.ts";

export type SpecResult = { ok: true; spec: RunSpec } | { ok: false; error: string };

export const RUN_MODES = ["vibe", "goal", "loop"] as const satisfies readonly RunMode[];

const USAGE: Record<RunMode, string> = {
	vibe: "/storm vibe <작업>",
	goal: "/storm goal <목표> [--budget <N|Nk|Nm>] (목표 없이 쓰면 멈춘 목표를 이어갑니다)",
	loop: "/storm loop [횟수|시간] [--while|--until '<명령>'] <프롬프트> (예: /storm loop 5 --until 'bun test' 실패하는 테스트를 고쳐)",
};

const fail = (mode: RunMode, problem: string): SpecResult => ({ ok: false, error: `${problem} 사용법: ${USAGE[mode]}` });

const UNIT_MS: Readonly<Record<string, number>> = {
	s: 1_000,
	sec: 1_000,
	secs: 1_000,
	second: 1_000,
	seconds: 1_000,
	m: 60_000,
	min: 60_000,
	mins: 60_000,
	minute: 60_000,
	minutes: 60_000,
	h: 3_600_000,
	hr: 3_600_000,
	hrs: 3_600_000,
	hour: 3_600_000,
	hours: 3_600_000,
};

const positiveInt = (n: number): boolean => Number.isSafeInteger(n) && n > 0;

/** `50000`, `200k`, `1.5m`: a token count. */
export function parseTokenBudget(text: string): number | undefined {
	const match = /^(\d+(?:\.\d+)?)([km])?$/i.exec(text.trim());
	if (!match) return undefined;
	const scale = match[2] === undefined ? 1 : match[2].toLowerCase() === "k" ? 1_000 : 1_000_000;
	const value = Math.round(Number(match[1]) * scale);
	return positiveInt(value) ? value : undefined;
}

/** One turn is no loop: a count of 1 is a plain vibe run. */
function loopSpec(task: string, limit: LoopLimit | undefined, condition: LoopCondition | undefined): RunSpec {
	if (limit?.kind === "turns" && limit.turns === 1) return { mode: "vibe", task };
	return { mode: "loop", task, ...(limit ? { limit } : {}), ...(condition ? { condition } : {}) };
}

function parseGoal(text: string): SpecResult {
	const flag = /(^|\s)--budget(?:(?:=|\s+)(\S+))?(?=\s|$)/.exec(text);
	if (!flag) return { ok: true, spec: text ? { mode: "goal", task: text } : { mode: "goal", resume: true } };
	const tokenBudget = flag[2] === undefined ? undefined : parseTokenBudget(flag[2]);
	if (tokenBudget === undefined) return fail("goal", "--budget 에는 토큰 수가 필요합니다(예: 500k).");
	const task = [text.slice(0, flag.index).trim(), text.slice(flag.index + flag[0].length).trim()].filter(Boolean).join(" ");
	if (!task) return fail("goal", "멈춘 목표를 이어갈 때는 예산을 바꿀 수 없습니다. 목표를 함께 적으세요.");
	return { ok: true, spec: { mode: "goal", task, tokenBudget } };
}

/** `1h30m`, `90s`: undefined when the token is not duration-shaped, "bad" when its unit or amount is not usable. */
function compoundDuration(token: string): number | "bad" | undefined {
	if (!/^(?:\d+[a-z]+)+$/.test(token)) return undefined;
	let total = 0;
	for (const [, amount, unit] of token.matchAll(/(\d+)([a-z]+)/g)) {
		const ms = UNIT_MS[unit ?? ""];
		if (ms === undefined || !positiveInt(Number(amount))) return "bad";
		total += Number(amount) * ms;
	}
	return total;
}

/** An optional leading count or duration. A token that looks like one but does not parse is an error, not prompt text. */
function takeLimit(input: string): { limit?: LoopLimit; rest: string } | undefined {
	const space = input.search(/\s/);
	const token = (space < 0 ? input : input.slice(0, space)).toLowerCase();
	const rest = space < 0 ? "" : input.slice(space + 1).trim();
	if (!/^[+-]?\d/.test(token)) return { rest: input };
	if (/^\d+$/.test(token)) {
		if (!positiveInt(Number(token))) return undefined;
		// "10 minutes": a bare number followed by a time unit is a duration.
		const unit = /^\S+/.exec(rest)?.[0] ?? "";
		const ms = UNIT_MS[unit.toLowerCase()];
		if (ms !== undefined) return { limit: { kind: "duration", durationMs: Number(token) * ms }, rest: rest.slice(unit.length).trim() };
		return { limit: { kind: "turns", turns: Number(token) }, rest };
	}
	const duration = compoundDuration(token);
	return typeof duration === "number" ? { limit: { kind: "duration", durationMs: duration }, rest } : undefined;
}

/** One shell word: bare, or quoted with ' or " (a quoted word may hold spaces). */
function readWord(text: string): { value: string; rest: string } | "unterminated" | undefined {
	const input = text.trimStart();
	if (!input) return undefined;
	let value = "";
	let quote: string | undefined;
	let i = 0;
	for (; i < input.length; i++) {
		const ch = input[i]!;
		if (quote) {
			if (ch === quote) quote = undefined;
			else if (quote === '"' && ch === "\\" && i + 1 < input.length && '"\\$`'.includes(input[i + 1]!)) value += input[++i];
			else value += ch;
		} else if (ch === "'" || ch === '"') quote = ch;
		else if (/\s/.test(ch)) break;
		else value += ch;
	}
	return quote ? "unterminated" : { value, rest: input.slice(i).trim() };
}

const CONDITION_FLAGS: Readonly<Record<string, boolean>> = { "--while": false, "--until": true };

function parseLoop(text: string): SpecResult {
	const limited = takeLimit(text);
	if (!limited) return fail("loop", "횟수는 양의 정수, 시간은 10m·2h·30s 꼴이어야 합니다.");
	let rest = limited.rest.trim();
	let condition: LoopCondition | undefined;
	while (rest.startsWith("--")) {
		const name = /^--[a-z][a-z-]*(?=[\s=]|$)/.exec(rest)?.[0];
		const until = name === undefined ? undefined : CONDITION_FLAGS[name];
		if (name === undefined || until === undefined) return fail("loop", `알 수 없는 옵션입니다: ${rest.split(/\s+/, 1)[0]}.`);
		if (condition) return fail("loop", "--while 과 --until 은 하나만 쓸 수 있습니다.");
		const after = rest.slice(name.length);
		const word = readWord(after.startsWith("=") ? after.slice(1) : after);
		if (word === "unterminated") return fail("loop", `${name} 의 따옴표가 닫히지 않았습니다.`);
		if (!word?.value.trim() || word.value.startsWith("-")) return fail("loop", `${name} 에는 셸 명령이 필요합니다. 공백이 있으면 따옴표로 감싸세요.`);
		condition = { command: word.value.trim(), until };
		rest = word.rest;
	}
	if (!rest) return fail("loop", "반복할 프롬프트가 필요합니다.");
	return { ok: true, spec: loopSpec(rest, limited.limit, condition) };
}

/** The text after `/storm vibe|goal|loop`. */
export function parseRunArgs(mode: RunMode, args: string): SpecResult {
	const text = args.trim();
	if (mode === "goal") return parseGoal(text);
	if (mode === "loop") return parseLoop(text);
	return text ? { ok: true, spec: { mode: "vibe", task: text } } : fail("vibe", "맡길 작업이 필요합니다.");
}

/**
 * The run options as the storm tool and the router's side turn name them. There is no shell condition among them:
 * omp runs a loop condition outside the bash tool's approval, so one comes only from what the user typed
 * (`/storm loop --until|--while`).
 */
export interface RunFields {
	mode?: RunMode | undefined;
	/** loop: turns in total. */
	iterations?: number | undefined;
	/** loop: wall time. */
	minutes?: number | undefined;
	/** goal: main-session token budget. */
	tokenBudget?: number | undefined;
}

const reject = (error: string): SpecResult => ({ ok: false, error });

/** A task and its run fields. Fields of another mode are an error rather than silently dropped. */
export function runSpec(taskText: string, fields: RunFields = {}): SpecResult {
	const task = taskText.trim();
	if (!task) return reject("실행할 작업 내용이 비어 있습니다.");
	const mode = fields.mode ?? "vibe";
	if (mode !== "loop" && (fields.iterations !== undefined || fields.minutes !== undefined)) {
		return reject("iterations, minutes 는 mode가 loop일 때만 씁니다.");
	}
	if (mode !== "goal" && fields.tokenBudget !== undefined) return reject("tokenBudget 은 mode가 goal일 때만 씁니다.");
	if (mode === "vibe") return { ok: true, spec: { mode, task } };
	if (mode === "goal") {
		if (fields.tokenBudget !== undefined && !positiveInt(fields.tokenBudget)) return reject("tokenBudget 은 양의 정수여야 합니다.");
		return { ok: true, spec: { mode, task, ...(fields.tokenBudget !== undefined ? { tokenBudget: fields.tokenBudget } : {}) } };
	}
	if (fields.iterations !== undefined && fields.minutes !== undefined) return reject("iterations 와 minutes 는 하나만 쓸 수 있습니다.");
	let limit: LoopLimit | undefined;
	if (fields.iterations !== undefined) {
		if (!positiveInt(fields.iterations)) return reject("iterations 는 양의 정수여야 합니다.");
		limit = { kind: "turns", turns: fields.iterations };
	} else if (fields.minutes !== undefined) {
		if (!Number.isFinite(fields.minutes) || fields.minutes <= 0) return reject("minutes 는 0보다 커야 합니다.");
		limit = { kind: "duration", durationMs: Math.round(fields.minutes * 60_000) };
	}
	return { ok: true, spec: loopSpec(task, limit, undefined) };
}
