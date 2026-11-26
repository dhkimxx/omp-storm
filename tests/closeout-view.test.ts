import { describe, expect, test } from "bun:test";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";
import { currentTheme, setCurrentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import type { ExtensionAPI, MessageRenderer } from "@oh-my-pi/pi-coding-agent";
import { symbolOf, visibleWidth, type UiNode } from "../src/tui/kit.ts";
import { infoFrame, infoSymbol } from "../src/ui/info-node.ts";
import { registerReportRenderer } from "../src/ui.ts";
import type { CloseoutBrief, CloseoutRecordStyle, InfoLine } from "../src/types.ts";
import { CLOSEOUT_CHOICE_HINT, CLOSEOUT_STATUS_COMMAND, closeoutDetails, closeoutDuration, readCloseoutRecord, renderCloseout } from "../src/view/closeout.ts";
import { mountMessage, type TuiView } from "./tui-host.ts";

const TITLE = "Storm 실행 결과";
const NONE_OPEN = { unsettled: 0, revoked: 0, blocked: 0, retry: 0, reviewable: 0, pending: 0, unmet: 0 } as const;

const brief = (over: Partial<CloseoutBrief> = {}): CloseoutBrief => ({
	runId: "run-1",
	tier: "card",
	request: "결제 API 재시도 정책 정리",
	target: "omp-storm",
	startedAt: "2026-11-25T09:00:00Z",
	endedAt: "2026-11-25T09:42:00Z",
	official: { label: "완료 · 검증됨", tone: "success", hasResults: true, accepted: 2, inScope: 2, excluded: 0, open: NONE_OPEN },
	residual: [],
	userActions: [],
	actions: [],
	...over,
});

/** F2-shaped: round limit, 1/10 accepted, 8 unsettled, 1 unmet, stale director account, three actions. */
const F2 = brief({
	request: "실험 10개를 돌려 가장 좋은 설정을 고르기",
	official: {
		label: "완료 아님 · 라운드 한도 · 3/3라운드",
		tone: "warning",
		hasResults: true,
		accepted: 1,
		inScope: 10,
		excluded: 1,
		open: { ...NONE_OPEN, unsettled: 8, unmet: 1 },
	},
	residual: ["검증되지 않은 변경이 작업 트리에 남아 있습니다"],
	proof: "exp-3 · attempt a2 · results/exp-3.json",
	director: { result: "검증 완료. 설정 B가 가장 좋습니다.", remaining: "나머지 실험 재실행", stale: true },
	userActions: ["GPU 노드 접근 권한을 확인하세요"],
	actions: [
		{ kind: "resume", label: "이어 가기 — 수용 1건은 현재 증거로 다시 확인하고 나머지 9건을 다시 엽니다" },
		{ kind: "run", label: "실험 exp-4만 좁게 다시 돌리기", task: "exp-4 재실행" },
	],
});

const KOREAN = "가나다라마바사아자차카타파하".repeat(20);
/** The widest card the brief bounds allow: long Korean prose, three residuals, two user actions, three actions. */
const WORST = brief({
	request: KOREAN,
	target: KOREAN,
	official: { label: KOREAN, tone: "error", hasResults: true, accepted: 0, inScope: 99, excluded: 9, open: { unsettled: 1, revoked: 2, blocked: 3, retry: 4, reviewable: 5, pending: 6, unmet: 7 } },
	residual: [KOREAN, KOREAN, KOREAN],
	proof: KOREAN,
	director: { result: KOREAN, remaining: KOREAN, stale: true },
	userActions: [KOREAN, KOREAN],
	actions: [
		{ kind: "resume", label: KOREAN },
		{ kind: "run", label: KOREAN, task: "x" },
		{ kind: "run", label: `${KOREAN}2`, task: "y" },
	],
});

const style = (info: readonly InfoLine[], runId = "run-1"): CloseoutRecordStyle => ({ kind: "closeout", runId, info });
const content = (markdown: string): string => `### ${TITLE}\n\n${markdown}`;

const renderers = new Map<string, MessageRenderer>();
registerReportRenderer({
	registerMessageRenderer: (type: string, renderer: MessageRenderer) => renderers.set(type, renderer),
} as unknown as ExtensionAPI);
const reportRenderer = (): MessageRenderer => renderers.get("storm-report")!;

interface DrawOptions {
	readonly columns?: number;
	readonly rows?: number;
	readonly theme?: Theme | "plain";
	readonly native?: boolean;
}

/** The closeout record as the transcript stores it, drawn by Storm's registered renderer on the test terminal. */
function drawCloseout(markdown: string, info: readonly InfoLine[], options: DrawOptions = {}): TuiView {
	const details = closeoutDetails(markdown, style(info));
	expect(details).toBeDefined();
	return mountMessage(
		reportRenderer(),
		{ customType: "storm-report", content: content(markdown), details },
		{ columns: 80, rows: 160, theme: "plain", ...options },
	);
}

/** Every `text` span and `md` run under a node, in order. */
function nodeTexts(root: UiNode): string[] {
	const out: string[] = [];
	const walk = (node: UiNode): void => {
		const props = node.props() as { spans?: ReadonlyArray<{ t: string }>; text?: unknown };
		if (node.kind === "text") for (const run of props.spans ?? []) out.push(run.t);
		if (node.kind === "md") out.push(`MD:${String(props.text ?? "")}`);
		for (const child of node.children()) walk(child);
	};
	walk(root);
	return out;
}

/**
 * Runs `body` with `theme` as the host's active theme. Storm reads glyphs through the active theme (as it must, to
 * follow a switch), while `mountMessage` paints with the theme it is given: a test that mounts a non-default theme
 * makes both the same, as they are in omp.
 */
function withActiveTheme<T>(theme: Theme, body: () => T): T {
	const before = currentTheme();
	setCurrentTheme(theme as ReturnType<typeof currentTheme>);
	try {
		return body();
	} finally {
		setCurrentTheme(before);
	}
}

/** The card's text read back across wrapped rows: no border, no padding, no break position assumed. */
const flatten = (rows: readonly string[]): string => rows.join("").replace(/[\s\u2500-\u257f+|-]/g, "");

describe("closeout text", () => {
	test("a line brief is one factual line with no title, choices or prose", () => {
		const { markdown, info } = renderCloseout(
			brief({ tier: "line", endedAt: "2026-11-25T09:03:00Z", official: { ...brief().official, accepted: 1, inScope: 1 } }),
			true,
		);
		expect(markdown).toBe("- 완료 · 검증됨 · 수용 1/1 · 3분");
		expect(markdown).not.toContain(TITLE);
		expect(info).toEqual([
			{ index: 0, spans: [{ text: "완료 · 검증됨", tone: "success" }, { text: " · 수용 1/1 · 3분" }], icon: "status.success", emphasis: "title" },
		]);
	});

	test("a card leads with request, target and duration, then the official line, warnings, account, proof and actions", () => {
		const { markdown } = renderCloseout(F2, true);
		const lines = markdown.split("\n");
		expect(lines).toEqual([
			"- 요청: 실험 10개를 돌려 가장 좋은 설정을 고르기",
			"- 대상: omp-storm · 소요 42분",
			"- 완료 아님 · 라운드 한도 · 3/3라운드 · 수용 1/10 · 판정 전 종료 8 · 미충족 1 · 사용자 제외 1",
			"- 주의: 검증되지 않은 변경이 작업 트리에 남아 있습니다",
			"- 감독 설명(최종 판정 전 작성): 검증 완료. 설정 B가 가장 좋습니다.",
			"- 남은 일(감독 설명): 나머지 실험 재실행",
			"- 근거: exp-3 · attempt a2 · results/exp-3.json",
			"- 직접: GPU 노드 접근 권한을 확인하세요",
			"",
			"1. 추천 — 이어 가기 — 수용 1건은 현재 증거로 다시 확인하고 나머지 9건을 다시 엽니다",
			"2. 실험 exp-4만 좁게 다시 돌리기",
			`- ${CLOSEOUT_CHOICE_HINT}`,
			"- 상세: /storm status",
		]);
		expect(markdown).not.toContain(TITLE);
		expect(markdown).not.toContain("###");
	});

	test("the director's claim never precedes or replaces the official counts", () => {
		const lines = renderCloseout(F2, true).markdown.split("\n");
		const official = lines.findIndex(line => line.includes("수용 1/10"));
		const warning = lines.findIndex(line => line.startsWith("- 주의:"));
		const account = lines.findIndex(line => line.includes("검증 완료"));
		expect(official).toBeGreaterThan(-1);
		expect(official).toBeLessThan(warning);
		expect(warning).toBeLessThan(account);
	});

	test("without registered choices there is no number, no input instruction, and user actions stay", () => {
		const { markdown, info } = renderCloseout(F2, false);
		expect(markdown).not.toMatch(/^\d+\. /m);
		expect(markdown).not.toContain("번호");
		expect(markdown).not.toContain("입력");
		expect(markdown).toContain("- 직접: GPU 노드 접근 권한을 확인하세요");
		expect(markdown).toContain("- 추천 방향: 이어 가기");
		expect(markdown).toContain("- 다른 방향: 실험 exp-4만");
		expect(markdown.split("\n").at(-1)).toBe("- 상세: /storm status");
		expect(info.every(line => line.spans.every(span => !/[[\]]/.test(span.text)))).toBe(true);
	});

	test("no action means no choice block and no opt-in sentence", () => {
		const { markdown } = renderCloseout(brief(), true);
		expect(markdown).not.toContain("번호");
		expect(markdown).not.toMatch(/^\d+\. /m);
		expect(markdown.split("\n")).toEqual(["- 요청: 결제 API 재시도 정책 정리", "- 대상: omp-storm · 소요 42분", "- 완료 · 검증됨 · 수용 2/2", "- 상세: /storm status"]);
	});

	test("bounds: at most 3 actions, 3 warnings, 2 user actions; controls and escapes never survive", () => {
		const { markdown, info } = renderCloseout(
			brief({
				request: "요청\x1b[31m빨강\n둘째 줄‮",
				residual: ["a", "b", "c", "d"],
				userActions: ["u1", "u2", "u3"],
				actions: [1, 2, 3, 4].map(n => ({ kind: "run" as const, label: `작업 ${n}`, task: `t${n}` })),
			}),
			true,
		);
		expect(markdown).not.toContain("\x1b");
		expect(markdown).not.toContain("‮");
		expect(markdown).toContain("- 요청: 요청 [31m빨강 둘째 줄");
		expect(markdown.match(/^- 주의:/gm)).toHaveLength(3);
		expect(markdown.match(/^- 직접:/gm)).toHaveLength(2);
		expect(markdown.match(/^\d\. /gm)).toHaveLength(3);
		expect(markdown).not.toContain("작업 4");
		// Every visible line is annotated with exactly its own text.
		const lines = markdown.split("\n");
		for (const line of info) expect(line.spans.map(span => span.text).join("")).toBe(lines[line.index]!.replace(/^- /, ""));
		expect(lines.filter(line => line !== "")).toHaveLength(info.length);
	});

	test("durations", () => {
		expect(closeoutDuration("2026-11-25T09:00:00Z", "2026-11-25T09:00:30Z")).toBe("1분 미만");
		expect(closeoutDuration("2026-11-25T09:00:00Z", "2026-11-25T10:05:00Z")).toBe("1시간 5분");
		expect(closeoutDuration("2026-11-25T09:00:00Z", undefined)).toBeUndefined();
		expect(closeoutDuration("nope", "2026-11-25T09:00:00Z")).toBeUndefined();
	});
});

describe("goal totals on the card", () => {
	const GOAL = { runs: 3, usd: 7.25, ms: 95 * 60_000, turns: 41 };
	const withGoal = brief({ goal: GOAL });

	test("a card with a goal adds exactly one item and keeps the run's own duration; without one it is unchanged", () => {
		const plain = renderCloseout(brief(), true).markdown.split("\n");
		const goal = renderCloseout(withGoal, true).markdown.split("\n");
		const added = goal.filter(line => !plain.includes(line));
		expect(goal).toHaveLength(plain.length + 1);
		expect(added).toHaveLength(1);
		for (const figure of ["3", "$7.25", "41"]) expect(added[0]).toContain(figure);
		expect(added[0]).toContain("1시간 35분");
		expect(goal.filter(line => !added.includes(line))).toEqual(plain);
		expect(goal.join("\n")).toContain("42분");
	});

	test("a one-line closeout never shows the goal", () => {
		const line = brief({ tier: "line", endedAt: "2026-11-25T09:03:00Z" });
		expect(renderCloseout({ ...line, goal: GOAL }, true)).toEqual(renderCloseout(line, true));
	});

	test("an unreadable goal is not drawn", () => {
		const bad = { runs: Number.NaN, usd: -1, ms: Number.POSITIVE_INFINITY, turns: 1 };
		expect(renderCloseout(brief({ goal: bad }), true)).toEqual(renderCloseout(brief(), true));
	});

	test("the card fits 60 columns and survives the persisted-details round trip", () => {
		const { markdown, info } = renderCloseout({ ...F2, goal: { runs: 12, usd: 123.456, ms: 5_000 * 60_000, turns: 480 } }, true);
		const view = drawCloseout(markdown, info, { columns: 60 });
		for (const row of view.screen()) expect(visibleWidth(row)).toBeLessThanOrEqual(60);
		view.dispose();
		const details = closeoutDetails(markdown, style(info));
		expect(details).toBeDefined();
		expect(readCloseoutRecord(content(markdown), JSON.parse(JSON.stringify(details)))).toEqual({ title: TITLE, markdown, info });
	});

	test("a card persisted before the goal item existed still draws as a closeout", () => {
		const old = renderCloseout(brief(), true);
		expect(readCloseoutRecord(content(old.markdown), JSON.parse(JSON.stringify(closeoutDetails(old.markdown, style(old.info)))))).toEqual({
			title: TITLE,
			markdown: old.markdown,
			info: old.info,
		});
	});
});

describe("closeout frame", () => {
	/** The rows the card takes at `columns`, and the text it shows with the frame and padding removed. */
	function cardAt(markdown: string, info: readonly InfoLine[], columns: number, options: DrawOptions = {}) {
		const view = drawCloseout(markdown, info, { columns, ...options });
		const rows = view.screen();
		view.dispose();
		return { rows, text: rows.join("\n") };
	}

	test("the worst-case Korean card fits 60, 80 and 120 columns on every row, with the title once", () => {
		const { markdown, info } = renderCloseout(WORST, true);
		for (const width of [60, 80, 120]) {
			const { rows, text } = cardAt(markdown, info, width);
			for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
			expect(text.split(TITLE)).toHaveLength(2);
			expect(text).not.toContain("###");
		}
		// Every field is bounded, so even this worst case is a finite card (about 100 rows at 60 columns), never a wall
		// that grows with the run. Typical cards are a handful of rows.
		expect(cardAt(markdown, info, 60).rows.length).toBeLessThanOrEqual(120);
		const typical = renderCloseout(F2, true);
		expect(cardAt(typical.markdown, typical.info, 60).rows.length).toBeLessThanOrEqual(30);
	});

	test("the whole worst-case card survives the wrapping: every field's text is still there", () => {
		const { markdown, info } = renderCloseout(WORST, true);
		const { rows } = cardAt(markdown, info, 60);
		const flat = flatten(rows);
		// A field is bounded to its own maximum; the longest prefix of it that every field keeps is on screen.
		expect(flat).toContain(KOREAN.slice(0, 40));
		expect(flat).toContain("상세:/stormstatus");
	});

	test("an uncapped run's round count has no maximum and the card stays within 60 columns", () => {
		const open = brief({ official: { ...F2.official, label: "완료 아님 · 변경 없음 · 7라운드" } });
		const { markdown, info } = renderCloseout(open, true);
		const { rows, text } = cardAt(markdown, info, 60);
		for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(60);
		expect(text).toContain("7라운드");
		expect(text).not.toMatch(/\d\/\d라운드/);
	});

	test("the frame carries Storm's mark and the title in its head, once, and no heading mark-up", () => {
		const { markdown, info } = renderCloseout(F2, true);
		const { rows } = cardAt(markdown, info, 80);
		expect(rows[0]).toContain("🌀");
		expect(rows[0]).toContain(TITLE);
		expect(rows.slice(1).some(row => row.includes(TITLE))).toBe(false);
		// The first body row is the request line, not a repeated title or a blank.
		expect(rows[1]).toContain("요청:");
	});

	for (const name of ["dark", "light"]) {
		test(`ASCII preset on the ${name} theme keeps the width and paints with theme tokens, not hard-coded colours`, () => {
			const theme = loadThemeSync(name, { symbolPreset: "ascii" });
			const { markdown, info } = renderCloseout(F2, true);
			withActiveTheme(theme, () => {
				const view = drawCloseout(markdown, info, { columns: 60, theme });
				for (const row of view.screen()) expect(visibleWidth(row)).toBeLessThanOrEqual(60);
				const painted = view.rows().join("\n");
				// The official line is the title-emphasised line: warning tone, bold, exactly as the theme draws those tokens.
				expect(painted).toContain(theme.style("warning strong", "완료 아님 · 라운드 한도 · 3/3라운드"));
				// A run with no tone takes the custom message's body colour; its muted label keeps its own.
				expect(painted).toContain(theme.style("customMessageText", "실험 10개를 돌려 가장 좋은 설정을 고르기"));
				expect(view.text()).toContain("1. 추천");
				// The warning symbol is the preset's ASCII glyph, and the frame's border is the preset's too.
				const glyph = infoSymbol(theme, "status.warning");
				expect(glyph).toBe(symbolOf(theme, "status.warning"));
				expect(view.screen().some(row => row.includes(`${glyph} 완료 아님`))).toBe(true);
				expect(view.text()).not.toMatch(/[╭╮╰╯│─]/);
				view.dispose();
			});
		});
	}

	test("a theme switch repaints the icons of the lines that are already on screen", () => {
		const { markdown, info } = renderCloseout(F2, true);
		const unicode = loadThemeSync("dark", { symbolPreset: "unicode" });
		const ascii = loadThemeSync("dark", { symbolPreset: "ascii" });
		withActiveTheme(unicode, () => {
			const view = drawCloseout(markdown, info, { columns: 80, theme: unicode });
			expect(view.text()).toContain(`${infoSymbol(unicode, "status.warning")} 완료 아님`);
			setCurrentTheme(ascii as ReturnType<typeof currentTheme>);
			view.tick(0);
			expect(view.text()).toContain(`${infoSymbol(ascii, "status.warning")} 완료 아님`);
			view.dispose();
		});
	});

	test("the nodes carry the text as semantic spans, never ANSI and never Markdown", () => {
		const { markdown, info } = renderCloseout(F2, true);
		const view = drawCloseout(markdown, info, { columns: 60, native: true });
		const texts = nodeTexts(view.root);
		view.dispose();
		expect(texts.some(text => text.startsWith("MD:"))).toBe(false);
		expect(texts.every(text => !text.includes("\x1b"))).toBe(true);
		const joined = texts.join("");
		for (const piece of ["수용 1/10", "최종 판정 전 작성", "추천", CLOSEOUT_STATUS_COMMAND]) expect(joined).toContain(piece);
	});

	test("a card whose details are tampered or missing draws the plain frame, never a half-styled one", () => {
		const { markdown } = renderCloseout(F2, true);
		const view = mountMessage(
			reportRenderer(),
			{ customType: "storm-report", content: content(markdown), details: { v: 1, kind: "closeout", runId: "run-1", info: [] } },
			{ columns: 80, rows: 60, theme: "plain" },
		);
		const text = view.text();
		view.dispose();
		expect(text).toContain("🌀 Storm");
		expect(text).toContain("수용 1/10");
		expect(text).toContain(TITLE);
	});
});

describe("one fact", () => {
	const line = () => renderCloseout(brief({ tier: "line", endedAt: "2026-11-25T09:03:00Z", official: { ...brief().official, accepted: 1, inScope: 1 } }), true);

	test("a line brief is one row led by Storm's name, with no frame and no title", () => {
		const { markdown, info } = line();
		const view = mountMessage(
			reportRenderer(),
			{ customType: "storm-report", content: `### ${TITLE}\n\n${markdown}`, details: closeoutDetails(markdown, style(info)) },
			{ columns: 80, rows: 8, theme: "plain" },
		);
		const rows = view.screen();
		view.dispose();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toContain("Storm · ");
		expect(rows[0]).toContain("완료 · 검증됨 · 수용 1/1 · 3분");
		expect(rows[0]).not.toContain(TITLE);
		expect(rows[0]).not.toMatch(/[╭╮╰╯│─]/);
	});

	test("on a narrow terminal the fact wraps whole: no word is lost and no row passes the width", () => {
		const { markdown, info } = line();
		const view = mountMessage(
			reportRenderer(),
			{ customType: "storm-report", content: `### ${TITLE}\n\n${markdown}`, details: closeoutDetails(markdown, style(info)) },
			{ columns: 24, rows: 12, theme: "plain" },
		);
		const rows = view.screen();
		view.dispose();
		expect(rows.length).toBeGreaterThan(1);
		for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(24);
		const flat = flatten(rows);
		for (const word of ["Storm", "완료", "검증됨", "수용1/1", "3분"]) expect(flat).toContain(word);
	});

	test("a fact too long for 60 columns with the lead loses the lead and stays one row; a short one keeps it", () => {
		const draw = (text: string, columns: number): string[] => {
			const info: InfoLine[] = [{ index: 0, icon: "status.success", spans: [{ text, tone: "success" }] }];
			const view = drawCloseout(text, info, { columns, rows: 12, theme: "plain" });
			const rows = view.screen();
			view.dispose();
			return rows;
		};
		const long = "완료 · 필수 결과 이행 · 1라운드 · 수용 2/2 · 1분 미만";
		const narrow = draw(long, 60);
		expect(narrow).toHaveLength(1);
		expect(narrow[0]).toContain("1분 미만");
		expect(narrow[0]).not.toContain("Storm");
		const wide = draw(long, 120);
		expect(wide).toHaveLength(1);
		expect(wide[0]).not.toContain("Storm");
		const short = draw("완료 · 검증됨 · 수용 1/1 · 3분", 60);
		expect(short).toHaveLength(1);
		expect(short[0]).toContain("Storm · ");
	});

	test("the status icon follows the line's tone and the mark is muted", () => {
		const { markdown, info } = line();
		const theme = loadThemeSync("dark");
		const view = mountMessage(
			reportRenderer(),
			{ customType: "storm-report", content: `### ${TITLE}\n\n${markdown}`, details: closeoutDetails(markdown, style(info)) },
			{ columns: 80, rows: 8, theme },
		);
		const painted = view.rows().join("\n");
		view.dispose();
		const glyph = infoSymbol(theme, "status.success")!;
		expect(painted).toContain(theme.style("success", glyph));
		expect(painted).toContain(theme.style("muted strong", "Storm · "));
	});
});

describe("frame body", () => {
	const draw = (markdown: string, info: readonly InfoLine[], columns: number, options: DrawOptions = {}) => {
		const view = mountMessage(() => infoFrame("Storm · 점검", markdown, info, "🌀"), { customType: "storm-report", content: markdown }, { columns, rows: 40, theme: "plain", ...options });
		const rows = view.screen();
		view.dispose();
		return rows;
	};

	test("a meter is drawn directly under its own line, as one bar with its share beside it", () => {
		const markdown = ["## 진행", "예산 사용 40%", "다음은 검증입니다."].join("\n");
		const info: InfoLine[] = [{ index: 1, spans: [{ text: "예산 사용 40%", tone: "success" }], meter: { fraction: 0.4, tone: "success" } }];
		for (const columns of [40, 60, 120]) {
			const rows = draw(markdown, info, columns);
			const line = rows.findIndex(row => row.includes("예산 사용 40%"));
			expect(line).toBeGreaterThan(0);
			const bar = rows[line + 1]!;
			expect(bar).toMatch(/█+░*\s40%/);
			const cells = (bar.match(/[█░]/g) ?? []).length;
			expect(cells).toBeGreaterThanOrEqual(4);
			expect(cells).toBeLessThanOrEqual(24);
			expect(bar.match(/█/g)?.length).toBe(Math.round(0.4 * cells));
			// The prose around the annotated line stays Markdown: the heading drops its marker, the sentence is intact.
			expect(rows.join("\n")).not.toContain("##");
			expect(rows.join("\n")).toContain("다음은 검증입니다.");
			for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(columns);
		}
	});

	test("an unbroken token longer than the card wraps instead of running past the border or being cut", () => {
		const token = "x".repeat(90);
		const rows = draw(`${token}\n끝`, [{ index: 0, spans: [{ text: token, tone: "accent" }] }], 40);
		for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(40);
		expect(flatten(rows)).toContain(token);
	});

	test("a standing symbol leads its line and a frame without annotations is just the Markdown", () => {
		const markdown = "- 하나\n- 둘";
		const plain = draw(markdown, [], 60);
		expect(plain[0]).toContain("Storm · 점검");
		expect(plain.join("\n")).toContain("하나");
		expect(plain.join("\n")).toContain("둘");
	});

	test("a record without closeout details keeps its own text in a frame headed by Storm's mark", () => {
		const view = mountMessage(reportRenderer(), { customType: "storm-report", content: "### 알림\n\n본문 첫 줄\n\n- 항목" }, { columns: 60, rows: 12, theme: "plain" });
		const rows = view.screen();
		view.dispose();
		expect(rows[0]).toContain("🌀 Storm");
		const text = rows.join("\n");
		expect(text).toContain("알림");
		expect(text).toContain("본문 첫 줄");
		for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(60);
	});

	test("the title line moves into the frame's head instead of drawing its hashes", () => {
		const view = mountMessage(reportRenderer(), { customType: "storm-report", content: "### 알림\n\n본문 첫 줄\n\n- 항목" }, { columns: 60, rows: 12, theme: "plain" });
		const rows = view.screen();
		view.dispose();
		expect(rows[0]).toContain("Storm · 알림");
		expect(rows.some(row => row.includes("###"))).toBe(false);
		expect(rows[1]).toContain("본문 첫 줄");
		const named = mountMessage(reportRenderer(), { customType: "storm-report", content: "### Storm 팀 제안\n\n승인하면" }, { columns: 60, rows: 8, theme: "plain" });
		const namedRows = named.screen();
		named.dispose();
		expect(namedRows[0]).toContain("Storm 팀 제안");
		expect(namedRows[0]).not.toContain("Storm · Storm");
	});
});

describe("persisted details", () => {
	const { markdown, info } = renderCloseout(F2, true);

	test("round trip: valid details restyle exactly the plain body", () => {
		const details = closeoutDetails(markdown, style(info));
		expect(details).toEqual({ v: 1, kind: "closeout", runId: "run-1", info });
		expect(readCloseoutRecord(content(markdown), JSON.parse(JSON.stringify(details)))).toEqual({ title: TITLE, markdown, info });
	});

	test("records without details, other kinds and versions are not closeouts", () => {
		expect(readCloseoutRecord(content(markdown), undefined)).toBeUndefined();
		expect(readCloseoutRecord(content(markdown), { v: 2, kind: "closeout", runId: "run-1", info })).toBeUndefined();
		expect(readCloseoutRecord(content(markdown), { v: 1, kind: "report", runId: "run-1", info })).toBeUndefined();
		expect(readCloseoutRecord(content(markdown), { v: 1, kind: "closeout", runId: "", info })).toBeUndefined();
		expect(readCloseoutRecord(content(markdown), { v: 1, kind: "closeout", runId: "run-1" })).toBeUndefined();
		expect(readCloseoutRecord(markdown, { v: 1, kind: "closeout", runId: "run-1", info })).toBeUndefined();
		expect(readCloseoutRecord([{ type: "text", text: content(markdown) }], { v: 1, kind: "closeout", runId: "run-1", info })).toBeUndefined();
	});

	const tamper = (edit: (lines: InfoLine[]) => unknown[]) => ({ v: 1, kind: "closeout", runId: "run-1", info: edit(structuredClone(info)) });
	const malformed: Array<[string, ReturnType<typeof tamper>]> = [
		["a span adds a synthetic control", tamper(lines => [...lines.slice(0, -1), { ...lines.at(-1)!, spans: [{ text: "[ 실행 ] 상세: /storm status" }] }])],
		["a span carries ANSI", tamper(lines => [{ ...lines[0]!, spans: [{ text: "\x1b[31m요청: " }, ...lines[0]!.spans.slice(1)] }, ...lines.slice(1)])],
		["an unknown tone", tamper(lines => [{ ...lines[0]!, spans: [{ text: lines[0]!.spans.map(s => s.text).join(""), tone: "blink" }] }, ...lines.slice(1)])],
		["an untrusted icon", tamper(lines => [{ ...lines[0]!, icon: "status.evil" }, ...lines.slice(1)])],
		["a meter", tamper(lines => [{ ...lines[0]!, meter: { fraction: 1, tone: "success" } }, ...lines.slice(1)])],
		["a section", tamper(lines => [{ ...lines[0]!, section: "team" }, ...lines.slice(1)])],
		["an unannotated line", tamper(lines => lines.slice(1))],
		["a duplicate index", tamper(lines => [...lines, lines[0]!])],
		["an index outside the body", tamper(lines => [...lines.slice(0, -1), { ...lines.at(-1)!, index: 999 }])],
		["a non-array span list", tamper(lines => [{ ...lines[0]!, spans: "요청" }, ...lines.slice(1)])],
		["too many lines", tamper(lines => [...lines, ...Array.from({ length: 40 }, () => lines[0]!)])],
	];
	for (const [name, details] of malformed) {
		test(`malformed details fall back to the plain frame: ${name}`, () => {
			expect(readCloseoutRecord(content(markdown), details)).toBeUndefined();
			expect(closeoutDetails(markdown, style(details.info as InfoLine[]))).toBeUndefined();
		});
	}

	test("a body edited after the fact no longer matches its styling", () => {
		const forged = markdown.replace("수용 1/10", "수용 10/10");
		expect(readCloseoutRecord(content(forged), closeoutDetails(markdown, style(info)))).toBeUndefined();
	});

	test("a forged title with controls is not drawn as a closeout", () => {
		expect(readCloseoutRecord(`### Storm\x1b[2J\n\n${markdown}`, closeoutDetails(markdown, style(info)))).toBeUndefined();
	});
});
