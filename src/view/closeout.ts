/**
 * The settled run's closeout as one structured transcript record.
 *
 * `renderCloseout` turns the code-built {@link CloseoutBrief} into plain list lines (the durable text every host and
 * the session file keep) plus one {@link InfoLine} per visible line. The text never repeats the record's title: the
 * frame heading carries it. On the TUI the persisted `details` are validated again before they may restyle anything,
 * and they can only restyle text the plain content already says — never add a word, a control or a button.
 */
import type { CloseoutBrief, CloseoutRecordStyle, InfoLine, InfoSpan, InfoTone } from "../types.ts";

/** Schema version of a closeout record's `details`; anything else is drawn as the plain frame. */
export const CLOSEOUT_DETAILS_VERSION = 1;
/** Where details live. Kept in this module so the writer and the renderer agree on one command. */
export const CLOSEOUT_STATUS_COMMAND = "/storm status";
/** Displayed only on a card whose actions were registered, and honest when the card is replayed later. */
export const CLOSEOUT_CHOICE_HINT = "이 카드 직후에만 번호로 선택 · 고르지 않으면 시작하지 않습니다";

/** Card bounds: a closeout is a few lines that also fit a 60-column terminal, not a report. */
const REQUEST_MAX = 120;
const TARGET_MAX = 60;
const OFFICIAL_LABEL_MAX = 80;
const PROSE_MAX = 240;
const ITEM_MAX = 160;
const RESIDUAL_MAX = 3;
const USER_ACTION_MAX = 2;
const ACTION_MAX = 3;

/** Bounds on persisted details read back from a session file. */
const DETAILS_LINES_MAX = 32;
const DETAILS_SPANS_MAX = 8;
const DETAILS_TEXT_MAX = 600;
const DETAILS_BODY_MAX = 8_000;
const RUN_ID_MAX = 200;
const TITLE_MAX = 120;

/** C0/C1 controls (ESC included), line separators and bidi overrides: none may reach a frame. */
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
const UNSAFE_ALL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

const OPEN_LABEL = {
	unsettled: "판정 전 종료",
	revoked: "수용 취소",
	blocked: "차단",
	retry: "재시도 소진",
	reviewable: "검토 가능",
	pending: "대기",
	unmet: "미충족",
} as const satisfies Record<keyof CloseoutBrief["official"]["open"], string>;

const TONE_ICON = {
	success: "status.success",
	warning: "status.warning",
	error: "status.error",
	accent: "status.info",
	muted: "status.info",
} as const satisfies Record<InfoTone, NonNullable<InfoLine["icon"]>>;

/** The only icons a closeout line may carry. */
const CLOSEOUT_ICONS: ReadonlySet<string> = new Set(["status.success", "status.warning", "status.error", "status.info", "status.pending"]);
const TONES: ReadonlySet<string> = new Set(["accent", "success", "warning", "error", "muted"]);

/** One safe line: controls become spaces, whitespace collapses, and long text ends in an ellipsis (by code point). */
function clean(value: string | undefined, max: number): string {
	if (typeof value !== "string") return "";
	const text = value.replace(UNSAFE_ALL, " ").replace(/\s+/g, " ").trim();
	const points = Array.from(text);
	return points.length > max ? `${points.slice(0, Math.max(1, max - 1)).join("")}…` : text;
}

/** `42분`, `1시간 5분`, `1분 미만`; undefined when either end is missing or unreadable. */
export function closeoutDuration(startedAt: string, endedAt: string | undefined): string | undefined {
	if (endedAt === undefined) return undefined;
	const ms = Date.parse(endedAt) - Date.parse(startedAt);
	if (!Number.isFinite(ms) || ms < 0) return undefined;
	const minutes = Math.floor(ms / 60_000);
	if (minutes < 1) return "1분 미만";
	if (minutes < 60) return `${minutes}분`;
	const hours = Math.floor(minutes / 60);
	const rest = minutes % 60;
	return rest === 0 ? `${hours}시간` : `${hours}시간 ${rest}분`;
}

/** The official tail after the status label: counts only, all from code. */
function officialCounts(official: CloseoutBrief["official"]): string[] {
	const parts: string[] = [];
	if (official.hasResults) parts.push(`수용 ${official.accepted}/${official.inScope}`);
	for (const key of Object.keys(OPEN_LABEL) as Array<keyof typeof OPEN_LABEL>) {
		const count = official.open[key];
		if (Number.isInteger(count) && count > 0) parts.push(`${OPEN_LABEL[key]} ${count}`);
	}
	if (official.excluded > 0) parts.push(`사용자 제외 ${official.excluded}`);
	return parts;
}

class Builder {
	readonly lines: string[] = [];
	readonly info: InfoLine[] = [];

	/** A `- ` list line whose visible text is exactly the spans; empty spans are dropped. */
	item(spans: readonly InfoSpan[], extra: Omit<InfoLine, "index" | "spans"> = {}): void {
		this.#push("- ", spans, extra);
	}

	/** A line drawn as is (a numbered action): the spans include the marker. */
	raw(spans: readonly InfoSpan[], extra: Omit<InfoLine, "index" | "spans"> = {}): void {
		this.#push("", spans, extra);
	}

	blank(): void {
		if (this.lines.length > 0 && this.lines.at(-1) !== "") this.lines.push("");
	}

	#push(marker: string, spans: readonly InfoSpan[], extra: Omit<InfoLine, "index" | "spans">): void {
		const kept = spans.filter(span => span.text.length > 0);
		if (kept.length === 0) return;
		this.info.push({ index: this.lines.length, spans: kept, ...extra });
		this.lines.push(`${marker}${kept.map(span => span.text).join("")}`);
	}

	result(): { markdown: string; info: InfoLine[] } {
		while (this.lines.at(-1) === "") this.lines.pop();
		return { markdown: this.lines.join("\n"), info: this.info };
	}
}

/** The one factual status line: status label in its tone, then counts and duration. */
function officialLine(brief: CloseoutBrief, duration: string | undefined, out: Builder): void {
	const official = brief.official;
	const tone: InfoTone = TONES.has(official.tone) ? official.tone : "muted";
	const label = clean(official.label, OFFICIAL_LABEL_MAX) || "상태 미상";
	const tail = [...officialCounts(official), ...(duration !== undefined && brief.tier !== "card" ? [duration] : [])];
	out.item([{ text: label, tone }, ...(tail.length > 0 ? [{ text: ` · ${tail.join(" · ")}` }] : [])], {
		icon: TONE_ICON[tone],
		emphasis: "title",
	});
}

/**
 * The plain text and its styling for one settled run. Neither contains the record's title. `showChoices` is true only
 * when numbered actions were actually registered for this session; otherwise actions are listed unnumbered and no
 * input instruction appears. A `line` (or `none`) brief is one factual line.
 */
export function renderCloseout(brief: CloseoutBrief, showChoices: boolean): { markdown: string; info: InfoLine[] } {
	const out = new Builder();
	const duration = closeoutDuration(brief.startedAt, brief.endedAt);
	if (brief.tier !== "card") {
		officialLine(brief, duration, out);
		return out.result();
	}

	const request = clean(brief.request, REQUEST_MAX);
	if (request !== "") out.item([{ text: "요청: ", tone: "muted" }, { text: request }]);
	const target = clean(brief.target, TARGET_MAX);
	const where: InfoSpan[] = [];
	if (target !== "") where.push({ text: "대상: ", tone: "muted" }, { text: target });
	if (duration !== undefined) where.push({ text: where.length > 0 ? " · 소요 " : "소요: ", tone: "muted" }, { text: duration });
	out.item(where);

	officialLine(brief, duration, out);

	// Known residual risk leads any prose, so no explanation can sit between the status and its warnings.
	for (const risk of brief.residual.slice(0, RESIDUAL_MAX)) {
		const text = clean(risk, ITEM_MAX);
		if (text !== "") out.item([{ text: "주의: ", tone: "warning" }, { text }], { icon: "status.warning", emphasis: "action" });
	}

	const director = brief.director;
	const result = clean(director?.result, PROSE_MAX);
	if (director !== undefined && result !== "") {
		out.item([
			{ text: "감독 설명", tone: "muted" },
			...(director.stale ? [{ text: "(최종 판정 전 작성)", tone: "warning" as const }] : []),
			{ text: ": ", tone: "muted" },
			{ text: result },
		]);
		const remaining = clean(director.remaining, PROSE_MAX);
		if (remaining !== "") out.item([{ text: "남은 일(감독 설명): ", tone: "muted" }, { text: remaining }]);
	}

	const proof = clean(brief.proof, ITEM_MAX);
	if (proof !== "") out.item([{ text: "근거: ", tone: "muted" }, { text: proof }]);

	for (const action of brief.userActions.slice(0, USER_ACTION_MAX)) {
		const text = clean(action, ITEM_MAX);
		if (text !== "") out.item([{ text: "직접: ", tone: "warning" }, { text }], { icon: "status.warning", emphasis: "action" });
	}

	const actions = brief.actions
		.slice(0, ACTION_MAX)
		.map(action => clean(action.label, ITEM_MAX))
		.filter(label => label !== "");
	if (actions.length > 0) {
		out.blank();
		if (showChoices) {
			actions.forEach((label, i) => {
				const number = { text: `${i + 1}. `, tone: "accent" as const };
				out.raw(i === 0 ? [number, { text: "추천", tone: "accent" }, { text: ` — ${label}` }] : [number, { text: label }]);
			});
			out.item([{ text: CLOSEOUT_CHOICE_HINT, tone: "muted" }]);
		} else {
			// Nothing to pick here: the directions stay readable, with no number or input instruction to act on.
			actions.forEach((label, i) =>
				out.item(i === 0 ? [{ text: "추천 방향: ", tone: "accent" }, { text: label }] : [{ text: "다른 방향: ", tone: "muted" }, { text: label }]),
			);
		}
	}

	out.item([{ text: `상세: ${CLOSEOUT_STATUS_COMMAND}`, tone: "muted" }]);
	return out.result();
}

/** The `details` a closeout record persists beside its plain content. */
export interface CloseoutDetails {
	readonly v: typeof CLOSEOUT_DETAILS_VERSION;
	readonly kind: "closeout";
	readonly runId: string;
	readonly info: readonly InfoLine[];
}

function plainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A styled line may only restyle what the plain line says, after its list marker. */
function visibleText(line: string): string {
	return line.startsWith("- ") ? line.slice(2) : line;
}

/**
 * One persisted annotation, rebuilt from known fields only. Undefined for anything the closeout writer never makes:
 * meters, sections, unknown icons or tones, empty or oversized spans, or text that differs from the plain line.
 */
function closeoutLine(value: unknown, lines: readonly string[]): InfoLine | undefined {
	if (!plainRecord(value)) return undefined;
	const { index, spans, icon, emphasis } = value;
	if (value.meter !== undefined || value.section !== undefined) return undefined;
	if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= lines.length) return undefined;
	if (!Array.isArray(spans) || spans.length === 0 || spans.length > DETAILS_SPANS_MAX) return undefined;
	const kept: InfoSpan[] = [];
	for (const span of spans) {
		if (!plainRecord(span) || typeof span.text !== "string") return undefined;
		const text = span.text;
		if (text.length === 0 || text.length > DETAILS_TEXT_MAX || UNSAFE.test(text)) return undefined;
		if (span.tone !== undefined && !(typeof span.tone === "string" && TONES.has(span.tone))) return undefined;
		kept.push(span.tone === undefined ? { text } : { text, tone: span.tone as InfoTone });
	}
	if (kept.map(span => span.text).join("") !== visibleText(lines[index]!)) return undefined;
	if (icon !== undefined && !(typeof icon === "string" && CLOSEOUT_ICONS.has(icon))) return undefined;
	const emphasized = emphasis === "title" || emphasis === "action" ? emphasis : undefined;
	if (emphasis !== undefined && emphasized === undefined) return undefined;
	return {
		index,
		spans: kept,
		...(icon !== undefined && { icon: icon as NonNullable<InfoLine["icon"]> }),
		...(emphasized !== undefined && { emphasis: emphasized }),
	};
}

/**
 * Validates styling against the plain text it annotates. Every non-blank line must be annotated exactly once, so the
 * rich path never falls back to parsing Markdown for part of a card. Undefined means: draw the plain frame.
 */
export function closeoutInfo(markdown: string, info: unknown): InfoLine[] | undefined {
	if (markdown.length === 0 || markdown.length > DETAILS_BODY_MAX) return undefined;
	if (!Array.isArray(info) || info.length === 0 || info.length > DETAILS_LINES_MAX) return undefined;
	const lines = markdown.split("\n");
	if (lines.length > DETAILS_LINES_MAX * 2 || lines.some(line => line.length > DETAILS_TEXT_MAX || UNSAFE.test(line))) return undefined;
	const out: InfoLine[] = [];
	const seen = new Set<number>();
	for (const raw of info) {
		const line = closeoutLine(raw, lines);
		if (line === undefined || seen.has(line.index)) return undefined;
		seen.add(line.index);
		out.push(line);
	}
	for (const [index, line] of lines.entries()) {
		if (line.trim() !== "" && !seen.has(index)) return undefined;
	}
	return out.sort((a, b) => a.index - b.index);
}

function runIdOk(runId: unknown): runId is string {
	return typeof runId === "string" && runId.trim() !== "" && runId.length <= RUN_ID_MAX && !UNSAFE.test(runId);
}

/** The details to persist for a closeout record, or undefined when the style does not match its text. */
export function closeoutDetails(markdown: string, style: CloseoutRecordStyle | undefined): CloseoutDetails | undefined {
	if (style === undefined || style.kind !== "closeout" || !runIdOk(style.runId)) return undefined;
	const info = closeoutInfo(markdown, style.info);
	if (info === undefined) return undefined;
	return { v: CLOSEOUT_DETAILS_VERSION, kind: "closeout", runId: style.runId, info };
}

/** `### <title>\n\n<body>`: the transcript record's plain shape, shared with every non-TUI host. */
const RECORD_HEAD = /^### ([^\n]+)\n\n/;

/**
 * A persisted record that may be drawn as a structured closeout: version-1 details whose styling matches the record's
 * own plain body. Old records without details, other kinds, and any malformed or mismatched metadata return undefined.
 */
export function readCloseoutRecord(content: unknown, details: unknown): { title: string; markdown: string; info: InfoLine[] } | undefined {
	if (!plainRecord(details) || details.v !== CLOSEOUT_DETAILS_VERSION || details.kind !== "closeout" || !runIdOk(details.runId)) {
		return undefined;
	}
	if (typeof content !== "string") return undefined;
	const head = RECORD_HEAD.exec(content);
	if (head === null) return undefined;
	const title = head[1]!;
	if (title.length > TITLE_MAX || UNSAFE.test(title) || title.trim() === "") return undefined;
	const markdown = content.slice(head[0].length);
	const info = closeoutInfo(markdown, details.info);
	return info === undefined ? undefined : { title: title.trim(), markdown, info };
}
