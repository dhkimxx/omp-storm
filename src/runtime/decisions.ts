/**
 * The native `ask` contract for a Storm-managed main session.
 *
 * A managed director may ask the user only for a genuine decision: a scope change, an irreversible action, or a
 * choice that belongs to the user. The marker is coordination, not a safety sandbox and never an approval: this
 * module only reads the main form tag, declines routine or repeated questions, and keeps no answer state. The host
 * still owns form rendering, cancellation and the user's actual reply.
 */

/** The declared reason for a decision form. Exactly one token is valid; a literal pipe list is not. */
export const DECISION_REASONS = ["scope-change", "irreversible-action", "user-choice"] as const;
export type DecisionReason = (typeof DECISION_REASONS)[number];

/** The attributes a managed decision form must put on its main `<form>` tag. */
export interface DecisionAsk {
	/** Stable across replans and rounds of the same user request. */
	key: string;
	reason: DecisionReason;
}

export type DecisionAskCheck =
	| { ok: true; ask: DecisionAsk }
	| { ok: false; code: "contract" | "default"; detail: string };

const REASONS: Record<string, true> = { "scope-change": true, "irreversible-action": true, "user-choice": true };
/** A stable key is a bounded ASCII token, never free text or a path. */
const KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const HIGH_RISK: Record<string, true> = { "scope-change": true, "irreversible-action": true };
const MAX_HTML = 200_000;
const MAX_SESSIONS = 16;
const MAX_DECISIONS = 64;

/** Input types the host ignores when it builds fields; their values never reach form data. */
const IGNORED_INPUT_TYPES: Record<string, true> = {
	button: true,
	file: true,
	image: true,
	reset: true,
	submit: true,
};
/** Elements the host's form builder does not descend into, so a form or control inside them is not the main form. */
const IGNORED_ELEMENTS: Record<string, true> = {
	button: true,
	head: true,
	iframe: true,
	noscript: true,
	script: true,
	style: true,
	template: true,
	title: true,
};
const CONTROL: Record<string, "input" | "select" | "textarea"> = {
	input: "input",
	select: "select",
	textarea: "textarea",
};

interface ScannedControl {
	tag: "input" | "select" | "textarea";
	attributes: Map<string, string>;
	/** A textarea's text between its tags; absent for input and select. */
	content?: string;
}

interface ScannedForm {
	attributes: Map<string, string>;
	controls: ScannedControl[];
}

type FormScan = { ok: true; form: ScannedForm } | { ok: false; detail: string };

/**
 * One tag's attributes, lower-cased. Quoted `>` characters stay inside their value. Duplicate or malformed
 * attributes are not a contract this gate can trust.
 */
function tagAttributes(tag: string, start: number): Map<string, string> | undefined {
	const attributes = new Map<string, string>();
	let index = start;
	for (;;) {
		while (index < tag.length && /\s/u.test(tag[index] ?? "")) index++;
		if (index >= tag.length) return undefined;
		if (tag[index] === ">") return attributes;
		if (tag[index] === "/") {
			let next = index + 1;
			while (next < tag.length && /\s/u.test(tag[next] ?? "")) next++;
			if (tag[next] === ">") return attributes;
		}
		const nameStart = index;
		while (index < tag.length && !/[\s=/>]/u.test(tag[index] ?? "")) index++;
		if (index === nameStart) return undefined;
		const name = tag.slice(nameStart, index).toLowerCase();
		if (!/^[a-z_:][a-z0-9_.:-]*$/u.test(name)) return undefined;
		while (index < tag.length && /\s/u.test(tag[index] ?? "")) index++;
		let value = "";
		if (tag[index] === "=") {
			index++;
			while (index < tag.length && /\s/u.test(tag[index] ?? "")) index++;
			const quote = tag[index] === '"' || tag[index] === "'" ? tag[index] : undefined;
			if (quote !== undefined) {
				index++;
				const valueStart = index;
				while (index < tag.length && tag[index] !== quote) index++;
				if (index >= tag.length) return undefined;
				value = tag.slice(valueStart, index);
				index++;
			} else {
				const valueStart = index;
				while (index < tag.length && !/[\s>]/u.test(tag[index] ?? "")) index++;
				value = tag.slice(valueStart, index);
			}
		}
		if (attributes.has(name)) return undefined;
		attributes.set(name, value);
	}
}

/** One quote-aware tag, ending at the first `>` outside a quoted value. Undefined means the tag never closes. */
function readTag(html: string, start: number): { tag: string; end: number } | undefined {
	let quote: string | undefined;
	for (let index = start + 1; index < html.length; index++) {
		const char = html[index];
		if (quote !== undefined) {
			if (char === quote) quote = undefined;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			continue;
		}
		if (char === ">") return { tag: html.slice(start, index + 1), end: index + 1 };
	}
	return undefined;
}

/** A tag's name, whether it closes, and the index just after the name. */
function tagName(tag: string): { name: string; closing: boolean; nameEnd: number } | undefined {
	let index = 1;
	const closing = tag[index] === "/";
	if (closing) index++;
	const start = index;
	while (index < tag.length && /[A-Za-z0-9:-]/u.test(tag[index] ?? "")) index++;
	if (index === start) return undefined;
	return { name: tag.slice(start, index).toLowerCase(), closing, nameEnd: index };
}

/** The first real `</name>` after `from`, ignoring the same name inside a quoted attribute of an ordinary tag. */
function findClosingTag(
	html: string,
	lower: string,
	from: number,
	name: string,
): { start: number; end: number } | undefined {
	const needle = `</${name}`;
	let index = from;
	for (;;) {
		const at = lower.indexOf(needle, index);
		if (at < 0) return undefined;
		const after = lower[at + needle.length];
		if (after === undefined || /[\s>]/u.test(after)) {
			const close = readTag(html, at);
			return close === undefined ? undefined : { start: at, end: close.end };
		}
		index = at + needle.length;
	}
}

/**
 * The one main `<form>` and the input/select/textarea tags inside it. HTML comments and quoted attribute values are
 * skipped as a whole, so a `>` in a placeholder, a `<form` in a title, or a commented-out control is never mistaken
 * for the main opening or a real field. Raw-text containers the host ignores are skipped the same way. This is
 * deliberately a small structural scan, not a full HTML parser: the native TUI parses the valid markup itself.
 */
function scanForm(html: string): FormScan {
	const lower = html.toLowerCase();
	let main: ScannedForm | undefined;
	let inside = false;
	let index = 0;
	while (index < html.length) {
		const tagStart = html.indexOf("<", index);
		if (tagStart < 0) break;
		if (html.startsWith("<!--", tagStart)) {
			const commentEnd = html.indexOf("-->", tagStart + 4);
			if (commentEnd < 0) {
				if (main !== undefined) break;
				return { ok: false, detail: "HTML 주석이 닫히지 않았습니다." };
			}
			index = commentEnd + 3;
			continue;
		}
		const next = html[tagStart + 1] ?? "";
		if (!/[A-Za-z!/?]/u.test(next)) {
			index = tagStart + 1;
			continue;
		}
		const read = readTag(html, tagStart);
		if (read === undefined) {
			const prefix = html.slice(tagStart, Math.min(html.length, tagStart + 24)).toLowerCase();
			if (inside || /<\/?(?:form|input|select|textarea)\b/u.test(prefix)) {
				return { ok: false, detail: "폼이나 제어 태그가 닫히지 않았습니다(따옴표 포함)." };
			}
			break;
		}
		const info = tagName(read.tag);
		if (info === undefined) {
			index = read.end;
			continue;
		}
		if (info.closing) {
			if (info.name === "form" && inside) inside = false;
			index = read.end;
			continue;
		}
		if (info.name === "form") {
			if (main !== undefined) return { ok: false, detail: "MAIN <form> 태그가 하나여야 합니다." };
			const attributes = tagAttributes(read.tag, info.nameEnd);
			if (attributes === undefined) return { ok: false, detail: "MAIN <form> 태그의 속성을 읽지 못했습니다." };
			main = { attributes, controls: [] };
			inside = true;
			index = read.end;
			continue;
		}
		if (IGNORED_ELEMENTS[info.name] === true) {
			const close = findClosingTag(html, lower, read.end, info.name);
			index = close === undefined ? html.length : close.end;
			continue;
		}
		if (info.name === "textarea") {
			const attributes = tagAttributes(read.tag, info.nameEnd);
			if (attributes === undefined) return { ok: false, detail: "<textarea> 태그의 속성을 읽지 못했습니다." };
			const close = findClosingTag(html, lower, read.end, "textarea");
			if (inside && main !== undefined) {
				main.controls.push({ tag: "textarea", attributes, content: html.slice(read.end, close?.start ?? html.length) });
			}
			index = close === undefined ? html.length : close.end;
			continue;
		}
		if (!inside || main === undefined) {
			index = read.end;
			continue;
		}
		const control = CONTROL[info.name];
		if (control !== undefined) {
			const attributes = tagAttributes(read.tag, info.nameEnd);
			if (attributes === undefined) return { ok: false, detail: `<${info.name}> 태그의 속성을 읽지 못했습니다.` };
			main.controls.push({ tag: control, attributes });
		}
		index = read.end;
	}
	if (main === undefined) return { ok: false, detail: "MAIN <form> 태그를 찾지 못했습니다." };
	return { ok: true, form: main };
}

/** How the host treats a control: a field, a choice, a hidden value, or an ignored input type. */
function controlKind(control: ScannedControl): "field" | "choice" | "hidden" | "ignored" {
	if (control.tag === "select" || control.tag === "textarea") return "field";
	const type = (control.attributes.get("type") ?? "text").toLowerCase();
	if (type === "hidden") return "hidden";
	if (IGNORED_INPUT_TYPES[type] === true) return "ignored";
	return type === "radio" || type === "checkbox" ? "choice" : "field";
}

/** A named control the host can actually turn into a field; hidden and ignored inputs cannot be answered. */
function actionableControl(control: ScannedControl): boolean {
	if ((control.attributes.get("name") ?? "").trim() === "") return false;
	const kind = controlKind(control);
	return kind === "field" || kind === "choice";
}

/**
 * A high-risk form must not carry a value the host would submit on a timeout or an explicit cancel: a checked or
 * selected control, a select (the host starts on its first enabled option), a non-empty input default, or filled
 * textarea. This is a small structural contract for declared high-risk categories, not keyword classification.
 */
function defaultProblem(controls: readonly ScannedControl[]): string | undefined {
	for (const control of controls) {
		if ((control.attributes.get("name") ?? "").trim() === "") continue;
		const kind = controlKind(control);
		if (kind === "ignored") continue;
		if (control.tag === "select") return "select는 첫 옵션이 기본 선택됩니다";
		if (control.tag === "textarea") {
			if ((control.content ?? "").trim() !== "") return "textarea에 기본 내용이 있습니다";
			continue;
		}
		if (kind === "choice") {
			if (control.attributes.has("checked")) return "input이 checked로 미리 선택되어 있습니다";
			continue;
		}
		const value = control.attributes.get("value");
		if (value !== undefined && value.trim() !== "") return "input에 기본 value가 있습니다";
	}
	return undefined;
}

/**
 * Reads the one main `<form>` tag in the host's documented ask shapes. The older bare string and `questions` list
 * carry no marker and are refused for a managed director; outside Storm the host handles them as before. A form
 * without a named field is refused before it can consume a stable key: the host would show no answerable field.
 */
export function decisionAsk(args: unknown): DecisionAskCheck {
	const html =
		typeof args === "string"
			? args
			: typeof args === "object" && args !== null && "html" in args && typeof args.html === "string"
				? args.html
				: undefined;
	if (html === undefined) {
		return { ok: false, code: "contract", detail: "ask 입력은 html 폼이어야 합니다." };
	}
	if (html.length > MAX_HTML) {
		return { ok: false, code: "contract", detail: "ask 폼이 너무 큽니다." };
	}
	const scan = scanForm(html);
	if (!scan.ok) return { ok: false, code: "contract", detail: scan.detail };
	const key = scan.form.attributes.get("data-storm-decision");
	if (key === undefined || !KEY.test(key)) {
		return { ok: false, code: "contract", detail: "data-storm-decision에 안정적인 키(영문·숫자·. _ : -, 1~64자)를 넣으세요." };
	}
	const reason = scan.form.attributes.get("data-storm-reason");
	if (reason === undefined || REASONS[reason] !== true) {
		return {
			ok: false,
			code: "contract",
			detail: "data-storm-reason은 scope-change, irreversible-action, user-choice 중 정확히 하나여야 합니다.",
		};
	}
	if (!scan.form.controls.some(actionableControl)) {
		return {
			ok: false,
			code: "contract",
			detail: "MAIN <form>에 이름이 있는 input, select 또는 textarea가 하나 이상 필요합니다. 이름 없는 폼은 호스트가 답을 만들 수 없습니다.",
		};
	}
	if (HIGH_RISK[reason] === true) {
		const problem = defaultProblem(scan.form.controls);
		if (problem !== undefined) {
			return {
				ok: false,
				code: "default",
				detail: `'${key}'(${reason})은 범위 변경이나 되돌릴 수 없는 작업입니다. ${problem}; 타임아웃·취소가 승인으로 제출되지 않도록 기본 선택 없이 사용자가 직접 고르게 하세요.`,
			};
		}
	}
	return { ok: true, ask: { key, reason: reason as DecisionReason } };
}

export type DecisionRemember =
	| { status: "recorded" }
	| { status: "repeat"; reason: DecisionReason }
	| { status: "full" };

interface DecisionRequest {
	/** The native conversation generation this entry belongs to. */
	generation: number;
	/** Keys already put to the user for the current user request. */
	asked: Map<string, DecisionReason>;
}

/**
 * Bounded in-memory record of the decisions already asked in each session's current user request. It stores only
 * keys, never answers, approvals or form values: a timeout or cancel leaves no grant behind. A new prompt or a new
 * user-started run starts a new request; a session switch drops the old generation. At the per-request cap the old
 * keys stay and new questions are refused, so a repeat can never slip through by evicting history.
 */
export class DecisionRequests {
	readonly #sessions = new Map<string, DecisionRequest>();

	#entry(sessionId: string, generation: number): DecisionRequest {
		const hit = this.#sessions.get(sessionId);
		if (hit !== undefined && hit.generation === generation) return hit;
		const next: DecisionRequest = { generation, asked: new Map() };
		this.#sessions.delete(sessionId);
		this.#sessions.set(sessionId, next);
		while (this.#sessions.size > MAX_SESSIONS) {
			const oldest = this.#sessions.keys().next().value;
			if (oldest === undefined) break;
			this.#sessions.delete(oldest);
		}
		return next;
	}

	/** A new user request in this session and generation: the same question may be asked again. */
	nextRequest(sessionId: string, generation: number): void {
		this.#entry(sessionId, generation).asked.clear();
	}

	/** Records a question for this request; a repeated key returns its first reason, and a full request records none. */
	remember(sessionId: string, generation: number, key: string, reason: DecisionReason): DecisionRemember {
		const entry = this.#entry(sessionId, generation);
		const prior = entry.asked.get(key);
		if (prior !== undefined) return { status: "repeat", reason: prior };
		if (entry.asked.size >= MAX_DECISIONS) return { status: "full" };
		entry.asked.set(key, reason);
		return { status: "recorded" };
	}

	forget(sessionId: string): void {
		this.#sessions.delete(sessionId);
	}
}
