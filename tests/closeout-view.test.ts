import { afterEach, describe, expect, test } from "bun:test";
import { stripTerminalSequences, theme, visibleWidth } from "@oh-my-pi/pi-tui";
import type { NativeNode } from "@oh-my-pi/pi-tui/native/node";
import { ensureThemeSync, getCurrentThemeName, getSymbolPresetOverride, setSymbolPreset, setTheme } from "@oh-my-pi/pi-tui/theme/theme";
import type { CloseoutBrief, CloseoutRecordStyle, InfoLine } from "../src/types.ts";
import { CLOSEOUT_CHOICE_HINT, CLOSEOUT_STATUS_COMMAND, closeoutDetails, closeoutDuration, readCloseoutRecord, renderCloseout } from "../src/view/closeout.ts";
import { RichFrame } from "../src/view/info.ts";

ensureThemeSync();

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

function describeContext(cols: number) {
	return { cols, dark: true, reduceMotion: true, supports: () => true, feature: () => false };
}

function nativeTexts(root: NativeNode): string[] {
	const out: string[] = [];
	const walk = (node: NativeNode): void => {
		if (node.k === "text") for (const run of node.p?.spans ?? []) out.push(run.t);
		if (node.k === "md") out.push(`MD:${String(node.p?.text ?? "")}`);
		for (const child of node.c ?? []) if ("k" in child) walk(child);
	};
	walk(root);
	return out;
}

function frameOf(markdown: string, info: readonly InfoLine[]): RichFrame {
	return new RichFrame(TITLE, markdown, info, "🌀");
}

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

describe("closeout frame", () => {
	let restoreTheme: string | undefined;
	let restorePreset: Parameters<typeof setSymbolPreset>[0] | undefined;
	afterEach(async () => {
		if (restoreTheme !== undefined) await setTheme(restoreTheme);
		if (restorePreset !== undefined) await setSymbolPreset(restorePreset);
		restoreTheme = undefined;
		restorePreset = undefined;
	});

	test("the worst-case Korean card fits 60, 80 and 120 columns on every row, with the title once", () => {
		const { markdown, info } = renderCloseout(WORST, true);
		for (const width of [60, 80, 120]) {
			const rows = frameOf(markdown, info).render(width);
			for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
			const visible = stripTerminalSequences(rows.join("\n"));
			expect(visible.split(TITLE)).toHaveLength(2);
			expect(visible).not.toContain("###");
		}
		// Every field is bounded, so even this worst case is a finite card (about 100 rows at 60 columns), never a wall
		// that grows with the run. Typical cards are a handful of rows.
		expect(frameOf(markdown, info).render(60).length).toBeLessThanOrEqual(120);
		expect(frameOf(renderCloseout(F2, true).markdown, renderCloseout(F2, true).info).render(60).length).toBeLessThanOrEqual(30);
	});

	test("ASCII preset and light theme keep the width and use theme tokens, not hard-coded colors", async () => {
		restorePreset = getSymbolPresetOverride() ?? "unicode";
		restoreTheme = getCurrentThemeName() ?? "dark";
		const { markdown, info } = renderCloseout(F2, true);
		await setSymbolPreset("ascii");
		for (const name of ["dark", "light"]) {
			expect((await setTheme(name)).success).toBe(true);
			const rows = frameOf(markdown, info).render(60);
			for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(60);
			const joined = rows.join("\n");
			expect(joined).toContain(theme.fg("warning", theme.bold("완료 아님 · 라운드 한도 · 3/3라운드")));
			expect(stripTerminalSequences(joined)).toContain("1. 추천");
		}
	});

	test("the native card carries the same text as semantic spans, never ANSI and never Markdown", () => {
		const { markdown, info } = renderCloseout(F2, true);
		const native = frameOf(markdown, info).describe(describeContext(60));
		const texts = nativeTexts(native);
		expect(texts.some(text => text.startsWith("MD:"))).toBe(false);
		expect(texts.every(text => !text.includes("\x1b"))).toBe(true);
		const joined = texts.join("");
		for (const piece of ["수용 1/10", "최종 판정 전 작성", "추천", CLOSEOUT_STATUS_COMMAND]) expect(joined).toContain(piece);
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
