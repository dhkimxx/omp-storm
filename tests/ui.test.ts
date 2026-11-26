import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext, ExtensionUiFactory } from "@oh-my-pi/pi-coding-agent";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";
import { defaultFormData } from "@oh-my-pi/pi-coding-agent/tools/html-form/data";
import { type HtmlForm, parseHtmlForm } from "@oh-my-pi/pi-coding-agent/tools/html-form/parse";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import { currentTheme, setCurrentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { readAutoDelegation } from "../src/approval/auto.ts";
import { configHash } from "../src/config/canonical.ts";
import { configPath, serializeConfig } from "../src/config/store.ts";
import { approveAndSave, type FlowEnv, hubFlow, resetFlow, setupFlow } from "../src/flows.ts";
import { APPROVE } from "../src/proposals/present.ts";
import { ROLES } from "../src/roles.ts";
import { STORM_MARK } from "../src/view/appearance.ts";
import { FIELD } from "../src/setup/form.ts";
import { loadProjectState } from "../src/state.ts";
import { FULL_VIEW } from "../src/ui/common.ts";
import { offeredRowLabels } from "../src/ui/rows-select.ts";
import { forceWindowing, windowingAvailable } from "../src/ui/window.ts";
import type { InfoLine, UiContext, UiPort } from "../src/types.ts";
import { createUiPort } from "../src/ui.ts";
import { renderCloseout } from "../src/view/closeout.ts";
import { renderStatus } from "../src/view/render.ts";
import { LiveStatus, liveWidgetRows } from "../src/view/live.ts";
import { runRecord } from "./fixtures.ts";
import { makeProject, TEAM, type TestProject } from "./support.ts";
import { mountOverlay, mountWidget, type OverlayView, type TuiView } from "./tui-host.ts";

const PICK_BY_ROLE = "역할별로 고르기";

interface FormAnswer {
	data: Record<string, string | number | string[]>;
	timedOut?: boolean;
}

interface FakeHost {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	/** Options of every selector omp was asked to open, with the text of the panel above it at that moment. */
	selects: Array<{ options: string[]; panel: string | undefined }>;
	/** omp's own notifications. */
	notified: string[];
	/** Messages put in the transcript. */
	sent: Array<{ message: { content?: unknown; display?: boolean; excludeFromContext?: boolean }; options: { triggerTurn?: boolean } | undefined }>;
	/** Overlays opened (each is driven by `driveOverlay`, or closed with Esc). */
	overlays: number;
	/** What each overlay drew first. */
	opened: string[];
	/** Whether a panel widget is still set. */
	panelSet(): boolean;
}

/**
 * The parts of omp's extension API and context `createUiPort` touches, with the host's real drawing: a widget set with
 * `setWidget` and an overlay opened with `custom` are mounted on pi-tui's test terminal at `rows` x `columns`. `answers`
 * are given to selectors in order; a function gets the offered options. `formDialog: undefined` is a host without a form
 * surface.
 */
function fakeHost(opts: {
	mode: ExtensionContext["mode"];
	hasUI: boolean;
	rows?: number;
	columns?: number;
	answers?: Array<string | undefined | ((options: string[]) => string | undefined)>;
	formDialog?: (html: string) => Promise<FormAnswer | undefined>;
	theme?: Theme;
	native?: boolean;
	/** Drives an opened overlay; without it Esc closes it. */
	driveOverlay?: (view: OverlayView<never>) => void | Promise<void>;
}): FakeHost {
	const answers = [...(opts.answers ?? [])];
	const size = { columns: opts.columns ?? 100, rows: opts.rows ?? 50 };
	const mount = { ...size, ...(opts.theme === undefined ? {} : { theme: opts.theme }), ...(opts.native === undefined ? {} : { native: opts.native }) };
	let widget: TuiView | undefined;
	const host: FakeHost = {
		selects: [],
		notified: [],
		sent: [],
		overlays: 0,
		opened: [],
		panelSet: () => widget !== undefined,
		pi: {
			sendMessage(message: FakeHost["sent"][number]["message"], options?: { triggerTurn?: boolean }) {
				host.sent.push({ message, options });
			},
		} as unknown as ExtensionAPI,
		ctx: {
			mode: opts.mode,
			hasUI: opts.hasUI,
			ui: {
				async select(_title: string, options: string[]) {
					host.selects.push({ options: [...options], panel: widget?.text() });
					if (!answers.length) throw new Error("no scripted answer");
					const answer = answers.shift();
					return typeof answer === "function" ? answer(options) : answer;
				},
				notify(message: string) {
					host.notified.push(message);
				},
				setWidget(_key: string, content: ExtensionUiFactory | undefined) {
					widget?.dispose();
					widget = content === undefined ? undefined : mountWidget(content, mount);
				},
				async custom<T>(factory: never): Promise<T> {
					host.overlays++;
					const view = await mountOverlay<T>(factory, mount);
					host.opened.push(view.text());
					if (opts.driveOverlay) await opts.driveOverlay(view as unknown as OverlayView<never>);
					else view.press("escape");
					const result = await view.result;
					view.dispose();
					return result;
				},
				...(opts.formDialog ? { formDialog: opts.formDialog } : {}),
			},
		} as unknown as ExtensionContext,
	};
	return host;
}

const CONTEXT = { title: "title", markdown: "one\n\ntwo" };
const TALL = { title: "title", markdown: Array.from({ length: 80 }, (_, i) => `- line-${i}`).join("\n") };

/** Lets a painter's deferred report reach the view that reads it. */
const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

describe("form surface per host", () => {
	const answer = async (): Promise<FormAnswer> => ({ data: { a: 1 } });

	test("the TUI and a host with formDialog get a form; a host without the method, or without a UI, gets none", () => {
		expect(createUiPort(fakeHost({ mode: "tui", hasUI: true, formDialog: answer }).pi, fakeHost({ mode: "tui", hasUI: true, formDialog: answer }).ctx).form).toBeDefined();
		const acp = fakeHost({ mode: "rpc", hasUI: true, formDialog: answer });
		expect(createUiPort(acp.pi, acp.ctx).form).toBeDefined();
		const rpc = fakeHost({ mode: "rpc", hasUI: true });
		expect(createUiPort(rpc.pi, rpc.ctx).form).toBeUndefined();
		const headless = fakeHost({ mode: "print", hasUI: false, formDialog: answer });
		expect(createUiPort(headless.pi, headless.ctx).form).toBeUndefined();
	});

	test("answers come back as data; a cancelled form, a client that cannot answer and a timed-out form are all no answer", async () => {
		const open = (formDialog: (html: string) => Promise<FormAnswer | undefined>) => {
			const host = fakeHost({ mode: "rpc", hasUI: true, formDialog });
			return createUiPort(host.pi, host.ctx).form?.("<form></form>");
		};
		expect(await open(answer)).toEqual({ a: 1 });
		expect(await open(async () => undefined)).toBeUndefined();
		expect(await open(async () => ({ data: { a: 1 }, timedOut: true }))).toBeUndefined();
	});
});

describe("TUI", () => {
	test("a choice's context is a panel above the selector that leaves nothing behind", async () => {
		const host = fakeHost({ mode: "tui", hasUI: true, answers: ["b"] });
		const ui = createUiPort(host.pi, host.ctx);
		expect(await ui.select("pick", ["a", "b"], CONTEXT)).toBe("b");
		expect(host.selects).toHaveLength(1);
		expect(host.selects[0]?.options).toEqual(["a", "b"]);
		expect(host.selects[0]?.panel).toContain("two");
		expect(host.panelSet()).toBe(false);
		expect(host.sent).toEqual([]);
	});

	test("the terminal looks load: a host whose paint module moved would fall back to the transcript", () => {
		expect(windowingAvailable()).toBe(true);
	});

	test("a long report's scrollbar stays in one column as the thumb moves", async () => {
		const lines = Array.from({ length: 50 }, (_, i) => `- 기록 ${i}: ${"비용 ".repeat(i % 6)}`);
		const host = fakeHost({
			mode: "tui",
			hasUI: true,
			rows: 24,
			columns: 100,
			async driveOverlay(view) {
				const body = (): string[] => view.screen().filter(row => row.length > 0);
				const bar = (rows: string[]): string[] => rows.slice(0, -1).map(row => [...row].at(-1)!);
				const top = body();
				// Body rows share one bar column: a thumb and a track, never a shifted frame.
				expect(top.length).toBeLessThanOrEqual(Math.floor(24 * 0.85));
				expect(bar(top).every(glyph => glyph === "┃" || glyph === "│")).toBe(true);
				expect(bar(top).includes("┃")).toBe(true);
				expect(bar(top).includes("│")).toBe(true);
				expect(bar(top).indexOf("┃")).toBe(0);
				view.press("end");
				const bottom = body();
				expect(bar(bottom).every(glyph => glyph === "┃" || glyph === "│")).toBe(true);
				expect(bar(bottom).indexOf("┃")).toBeGreaterThan(0);
				expect(bottom.join("\n")).toContain("기록 49");
				expect(top.join("\n")).not.toContain("기록 49");
				view.press("q");
			},
		});
		await createUiPort(host.pi, host.ctx).report("스크롤 검증", lines.join("\n"), [{ index: 0, spans: [{ text: "• 기록 0", tone: "accent" }] }]);
	});

	test("paging, lines, Home and End move the window and never past its ends", async () => {
		const lines = Array.from({ length: 60 }, (_, i) => `- 행 ${String(i).padStart(2, "0")}`);
		const host = fakeHost({
			mode: "tui",
			hasUI: true,
			rows: 20,
			columns: 80,
			async driveOverlay(view) {
				// The first content row shown: the frame's top edge counts as row 0 until it scrolls away.
				const first = (): number => Number(/행 (\d\d)/.exec(view.text())![1]) + (view.text().startsWith("╭") ? -1 : 0) + 1;
				const page = Math.floor(20 * 0.85) - 1 - 1; // the viewport minus the hint row, minus one row of overlap
				const before = first();
				view.press("down");
				expect(first()).toBe(before + 1);
				view.press("up");
				expect(first()).toBe(before);
				view.press("up");
				expect(first()).toBe(before);
				view.press("shift+down");
				expect(first()).toBe(before + 5);
				view.press("pageDown");
				expect(first()).toBe(before + 5 + page);
				view.press("pageUp");
				expect(first()).toBe(before + 5);
				view.press("end");
				expect(view.text()).toContain("행 59");
				const last = first();
				view.press("pageDown");
				expect(first()).toBe(last);
				// Page up from the very end moves by one page, however far End asked for.
				view.press("pageUp");
				expect(first()).toBe(last - page);
				view.press("home");
				expect(view.text()).toContain("행 00");
				view.press("enter");
			},
		});
		await createUiPort(host.pi, host.ctx).report("긴 보고서", lines.join("\n"));
		expect(host.overlays).toBe(1);
	});

	const statusMarkdown = (info: InfoLine[]): string =>
		renderStatus(
			{
				config: { status: "ok", config: TEAM, path: "/repo/.omp/storm/config.json", hash: configHash(TEAM), warnings: [] },
				approval: undefined,
				shadows: [],
				quota: [{ provider: "status-provider", state: "limited", usedFraction: 0.42, resetsAt: null }],
				storageDetail: [{ text: "status-store · 18 KiB" }],
			},
			Date.parse("2026-11-20T09:30:00Z"),
			"user",
			info,
		);

	test("real status tabs show and scroll the selected section at 60 columns", async () => {
		const info: InfoLine[] = [];
		const markdown = statusMarkdown(info);
		const labels = [
			{ id: "overview", label: "1 개요" },
			{ id: "team", label: "2 팀" },
			{ id: "runtime", label: "3 런타임" },
			{ id: "storage", label: "4 저장 공간" },
		] as const;
		const host = fakeHost({
			mode: "tui",
			hasUI: true,
			rows: 24,
			columns: 60,
			async driveOverlay(view) {
				const screen = (): string[] => view.screen().filter(row => row.length > 0);
				const fits = (): void => {
					const rows = screen();
					expect(rows.length).toBeLessThanOrEqual(Math.floor(24 * 0.85));
					expect(rows.every(row => Bun.stringWidth(row) <= 60)).toBe(true);
				};
				// One strip on the first row with every tab, and the key hint last.
				for (const tab of labels) expect(screen()[0]).toContain(tab.label);
				expect(screen().at(-1)).toContain("←→·Tab");
				const shows = (shown: string, absent: string): void => {
					fits();
					expect(view.text()).toContain(shown);
					expect(view.text()).not.toContain(absent);
				};
				shows("/storm에서 팀 승인", "팀 설정");
				expect(view.text()).toContain(STORM_MARK);
				view.press("right");
				shows("역할별 모델", "status-provider");
				view.press("end");
				expect(view.text()).toContain("필수 검사");
				fits();
				view.press("3");
				// The runtime slices straddle Storage in the Markdown but share one tab.
				shows("status-provider", "status-store");
				expect(view.text()).toContain("하드 예산 상한");
				view.press("tab");
				shows("status-store", "status-provider");
				view.press("shift+tab");
				shows("status-provider", "status-store");
				// A tab keeps its own place: Team is still at its end.
				view.press("2");
				expect(view.text()).toContain("필수 검사");
				view.press("home");
				shows("팀 설정", "status-provider");
				view.press("left");
				shows(STORM_MARK, "status-provider");
				view.press("4");
				shows("status-store", "status-provider");
				view.press("1");
				shows(STORM_MARK, "status-provider");
				view.press("escape");
			},
		});
		// A different title still produces tabs: only the annotations opt a report in.
		await createUiPort(host.pi, host.ctx).report("프로젝트 진단", markdown, info);
		expect(host.sent).toEqual([]);
	});

	test("a native host gets a capped scroller per tab: max height, a scroll request, the other tabs hidden", async () => {
		const info: InfoLine[] = [];
		const markdown = statusMarkdown(info);
		const host = fakeHost({
			mode: "tui",
			hasUI: true,
			rows: 24,
			columns: 60,
			native: true,
			async driveOverlay(view) {
				const [sheet] = view.root.children();
				const bodies = sheet!.children().filter(node => node.key()?.startsWith("body-"));
				const body = (id: string) => bodies.find(node => node.key() === `body-${id}`)!;
				expect(bodies.map(node => node.key())).toEqual(["body-overview", "body-team", "body-runtime", "body-storage"]);
				expect(body("overview").props().hidden).toBe(false);
				expect(body("team").props().hidden).toBe(true);
				expect(body("team").props().max).toEqual({ h: `${Math.floor(24 * 0.85) - 2}lines` });
				view.press("2");
				view.press("end");
				expect(body("team").props().hidden).toBe(false);
				expect(body("overview").props().hidden).toBe(true);
				expect(body("team").scroll()).toMatchObject({ by: "end" });
				// Another tab's scroller keeps the request it had.
				view.press("3");
				expect(body("team").scroll()).toMatchObject({ by: "end" });
				expect(body("runtime").scroll()).toBeUndefined();
				view.press("escape");
			},
		});
		await createUiPort(host.pi, host.ctx).report("프로젝트 진단", markdown, info);
	});

	test("the ASCII preset keeps the 60-column tabs icon-led on one row", async () => {
		const ascii = loadThemeSync("dark", { symbolPreset: "ascii" });
		const previous = currentTheme();
		setCurrentTheme(ascii as ReturnType<typeof currentTheme>);
		try {
			const info: InfoLine[] = [];
			const markdown = renderStatus(
				{
					config: { status: "ok", config: TEAM, path: "/repo/.omp/storm/config.json", hash: configHash(TEAM), warnings: [] },
					approval: undefined,
					shadows: [],
					storageDetail: [{ text: "store" }],
				},
				Date.parse("2026-11-20T09:30:00Z"),
				"user",
				info,
			);
			const host = fakeHost({
				mode: "tui",
				hasUI: true,
				rows: 24,
				columns: 60,
				theme: ascii,
				async driveOverlay(view) {
					const rows = view.screen().filter(row => row.length > 0);
					for (const label of ["[i]1 개요", "[x]2 팀", "[~]3 런타임", "#4 저장 공간"]) expect(rows[0]).toContain(label);
					expect(rows[1]).not.toContain("4 저장 공간");
					view.press("2");
					expect(view.screen().filter(row => row.length > 0)[0]).toContain("[x]2 팀");
					view.press("escape");
				},
			});
			await createUiPort(host.pi, host.ctx).report("Storm 현황", markdown, info);
			expect(host.sent).toEqual([]);
		} finally {
			setCurrentTheme(previous);
		}
	});

	test("a context that does not fit adds one option that opens it whole, then the selector comes back", async () => {
		const host = fakeHost({ mode: "tui", hasUI: true, rows: 30, answers: [options => options.at(-1), "a"] });
		const ui = createUiPort(host.pi, host.ctx);
		expect(await ui.select("pick", ["a", "b"], TALL)).toBe("a");
		expect(host.selects.map(s => s.options.length)).toEqual([3, 3]);
		expect(host.selects[0]?.options.slice(0, 2)).toEqual(["a", "b"]);
		expect(host.selects[0]?.options.at(-1)).toBe(FULL_VIEW);
		expect(host.overlays).toBe(1);
		// The cut panel fits the rows the selector leaves, shows the head, not the tail, and says what is left out.
		const panel = host.selects[0]!.panel!;
		expect(panel.split("\n").length).toBeLessThanOrEqual(30 - 2 - 11);
		expect(panel).toContain("line-0");
		expect(panel).not.toContain("line-79");
		expect(panel).toContain(FULL_VIEW);
		// The frame still closes under the cut.
		expect(panel).toContain("╰");
		expect(host.panelSet()).toBe(false);
		// The overlay it opened is the whole content, from the top.
		expect(host.opened[0]).toContain("line-0");
	});

	test("the panel follows the terminal it is shown in: the same context fits a taller one", async () => {
		const host = fakeHost({ mode: "tui", hasUI: true, rows: 120, answers: ["a"] });
		await createUiPort(host.pi, host.ctx).select("pick", ["a", "b"], TALL);
		expect(host.selects[0]?.options).toEqual(["a", "b"]);
		expect(host.selects[0]?.panel).toContain("line-79");
		expect(host.overlays).toBe(0);
	});

	test("a lane view on screen takes its rows from the panel: the panel head stays, the cut grows, consent waits", async () => {
		const panelRows = async (withLaneView: boolean): Promise<{ rows: number; offered: string[] }> => {
			const live = new LiveStatus({ now: () => Date.now(), laneView: () => true });
			let mounted: TuiView | undefined;
			if (withLaneView) {
				const liveCtx = {
					mode: "tui",
					hasUI: true,
					agent: { kind: "main", id: "main", name: "main" },
					ui: {
						setStatus() {},
						setWidget(_key: string, content: ExtensionUiFactory | undefined) {
							mounted?.dispose();
							mounted = content === undefined ? undefined : mountWidget(content, { columns: 100, rows: 30 });
						},
					},
				} as unknown as ExtensionContext;
				live.show(liveCtx, runRecord({ runId: "run-dock", status: "running" }), "working");
				mounted?.text();
				expect(liveWidgetRows()).toBeGreaterThan(0);
			}
			try {
				const host = fakeHost({ mode: "tui", hasUI: true, rows: 30, answers: [options => options.at(-1), "a"] });
				await createUiPort(host.pi, host.ctx).select("pick", ["a", "b"], { ...TALL, consent: ["a"] });
				return { rows: host.selects[0]!.panel!.split("\n").length, offered: host.selects[0]!.options };
			} finally {
				live.clear();
				mounted?.dispose();
			}
		};
		const alone = await panelRows(false);
		const docked = await panelRows(true);
		expect(liveWidgetRows()).toBe(0);
		expect(docked.rows).toBeLessThan(alone.rows);
		expect(docked.offered).not.toContain("a");
		expect(docked.offered).toContain(FULL_VIEW);
	});

	test("notices are omp's notifications and reports are overlays: nothing enters the transcript", async () => {
		const host = fakeHost({ mode: "tui", hasUI: true });
		const ui = createUiPort(host.pi, host.ctx);
		ui.notify("saved");
		await ui.report("title", "body");
		expect(host.notified).toEqual(["saved"]);
		expect(host.overlays).toBe(1);
		expect(host.sent).toEqual([]);
	});
});

describe("rich rows", () => {
	const ROWS = [
		{ value: "explorer:1", label: "탐색 · 폴백", description: "b/z · low" },
		{ value: "explorer:0", label: "탐색 · 주 모델", description: "a/x · low" },
	];

	test("other hosts get unique labels that carry the detail, and the stable value comes back", async () => {
		const host = fakeHost({ mode: "rpc", hasUI: true, answers: [options => options[1]] });
		const ui = createUiPort(host.pi, host.ctx);
		const rows = [...ROWS, { value: "explorer:2", label: "탐색 · 폴백", description: "b/z · low" }];
		expect(await ui.selectRows?.("고르기", rows, CONTEXT)).toBe("explorer:0");
		expect(host.selects).toHaveLength(1);
		expect(host.selects[0]!.options).toEqual(offeredRowLabels(rows).labels);
		expect(new Set(host.selects[0]!.options).size).toBe(3);
		expect(host.sent).toHaveLength(1);
		expect(String(host.sent[0]!.message.content)).toContain("two");
		expect(host.panelSet()).toBe(false);
	});

	test("the TUI rows overlay chooses by value, Enter on the focused row and Esc cancels", async () => {
		for (const key of ["enter", "escape", "down+enter"]) {
			const host = fakeHost({
				mode: "tui",
				hasUI: true,
				rows: 24,
				async driveOverlay(view) {
					expect(view.text()).toContain("a/x · low");
					expect(view.text()).toContain("b/z · low");
					for (const press of key.split("+")) view.press(press);
				},
			});
			const ui = createUiPort(host.pi, host.ctx);
			expect(await ui.selectRows?.("고르기", ROWS)).toBe(key === "enter" ? "explorer:1" : key === "escape" ? undefined : "explorer:0");
			expect(host.sent).toEqual([]);
		}
	});

	test("the cursor wraps, Home and End jump, and the focused row is the marked one", async () => {
		const rows = Array.from({ length: 5 }, (_, i) => ({ value: `v${i}`, label: `항목 ${i}`, description: `설명 ${i}` }));
		const marked = (view: TuiView): string => view.screen().find(row => row.includes("❯"))!;
		const host = fakeHost({
			mode: "tui",
			hasUI: true,
			rows: 24,
			async driveOverlay(view) {
				expect(marked(view)).toContain("항목 0");
				view.press("up");
				expect(marked(view)).toContain("항목 4");
				view.press("down");
				expect(marked(view)).toContain("항목 0");
				view.press("end");
				expect(marked(view)).toContain("항목 4");
				view.press("home");
				expect(marked(view)).toContain("항목 0");
				view.press("pageDown");
				expect(marked(view)).not.toContain("항목 0");
				view.press("enter");
			},
		});
		expect(await createUiPort(host.pi, host.ctx).selectRows?.("고르기", rows)).toBe("v4");
	});

	test("a list taller than the terminal keeps the focused row in view", async () => {
		const rows = Array.from({ length: 40 }, (_, i) => ({ value: `v${i}`, label: `항목 ${String(i).padStart(2, "0")}`, description: `설명 ${i}` }));
		const host = fakeHost({
			mode: "tui",
			hasUI: true,
			rows: 16,
			async driveOverlay(view) {
				expect(view.text()).toContain("항목 00");
				expect(view.text()).not.toContain("항목 39");
				expect(view.screen().filter(row => row.length > 0).length).toBeLessThanOrEqual(Math.floor(16 * 0.85));
				view.press("end");
				expect(view.text()).toContain("항목 39");
				expect(view.screen().find(row => row.includes("❯"))).toContain("항목 39");
				for (let i = 0; i < 20; i++) view.press("up");
				expect(view.screen().find(row => row.includes("❯"))).toContain("항목 19");
				view.press("enter");
			},
		});
		expect(await createUiPort(host.pi, host.ctx).selectRows?.("고르기", rows)).toBe("v19");
	});

	test("a narrow terminal wraps the focused row's complete detail instead of dropping it", async () => {
		const host = fakeHost({
			mode: "tui",
			hasUI: true,
			rows: 16,
			columns: 30,
			async driveOverlay(view) {
				expect(view.text()).toContain("example/");
				expect(view.text()).toContain("xhigh");
				view.press("escape");
			},
		});
		const rows = [{ value: "explorer:0", label: "탐색 · 주 모델", description: "example/very-long-model · xhigh" }];
		expect(await createUiPort(host.pi, host.ctx).selectRows?.("고르기", rows)).toBeUndefined();
	});

	test("a compact context sits once above the same rows", async () => {
		const host = fakeHost({
			mode: "tui",
			hasUI: true,
			rows: 30,
			async driveOverlay(view) {
				expect(view.text()).toContain("two");
				expect(view.text()).toContain("a/x · low");
				expect(view.text().split("two")).toHaveLength(2);
				// It fits, so there is no row that opens it whole.
				expect(view.text()).not.toContain(FULL_VIEW);
				view.press("escape");
			},
		});
		expect(await createUiPort(host.pi, host.ctx).selectRows?.("고르기", ROWS, CONTEXT)).toBeUndefined();
		expect(host.sent).toEqual([]);
	});

	test("a cut context adds the full-view row, opens the whole content, then the list comes back", async () => {
		let opened = 0;
		const host = fakeHost({
			mode: "tui",
			hasUI: true,
			rows: 30,
			async driveOverlay(view) {
				opened++;
				if (opened === 1) {
					await settle();
					expect(view.text()).toContain("line-0");
					expect(view.text()).not.toContain("line-79");
					expect(view.text()).toContain(FULL_VIEW);
					view.press("end");
					view.press("enter");
				} else if (opened === 2) {
					// The whole content, linear, from the top.
					expect(view.text()).toContain("line-0");
					view.press("end");
					expect(view.text()).toContain("line-79");
					view.press("q");
				} else {
					expect(view.text()).not.toContain("line-79");
					view.press("enter");
				}
			},
		});
		expect(await createUiPort(host.pi, host.ctx).selectRows?.("고르기", ROWS, TALL)).toBe("explorer:1");
		expect(host.overlays).toBe(3);
		expect(host.sent).toEqual([]);
	});
});

describe("rich metadata", () => {
	const MARKDOWN = ["### 요약", "- 대기 중: 3개", "", "- 지출: $0.42 (예산 $5.00)", "일반 문단 **강조**"].join("\n");
	const INFO: InfoLine[] = [
		{ index: 0, spans: [{ text: "요약", tone: "muted" }] },
		{
			index: 1,
			spans: [
				{ text: "• ", tone: "muted" },
				{ text: "대기 중: ", tone: "accent" },
				{ text: "3개", tone: "warning" },
			],
		},
		{
			index: 3,
			spans: [
				{ text: "• ", tone: "muted" },
				{ text: "지출: ", tone: "accent" },
				{ text: "$0.42", tone: "success" },
				{ text: " (예산 $5.00)", tone: "muted" },
			],
			meter: { fraction: 0.42, tone: "success" },
		},
	];

	test("the report overlay shows the annotated lines with theme tones and a static meter", async () => {
		let visible = "";
		let styled = "";
		const host = fakeHost({
			mode: "tui",
			hasUI: true,
			rows: 40,
			async driveOverlay(view) {
				visible = view.text();
				styled = view.rows().join("\n");
				view.press("q");
			},
		});
		await createUiPort(host.pi, host.ctx).report("Storm 현황", MARKDOWN, INFO);
		expect(visible).toContain("대기 중: 3개");
		expect(visible).toContain("$0.42");
		expect(visible).toContain("Storm 현황");
		expect(visible).not.toContain("Storm · Storm 현황");
		expect(visible).not.toContain("1 개요");
		expect(visible).toContain("일반 문단");
		// Tones are the theme's colours, not text.
		expect(styled).toContain("\x1b[");
		expect(styled).not.toContain("\x1b]");
		// A static track, never shimmered text.
		expect(visible).toMatch(/[█▓▒░━]/u);
	});

	test("an untrusted icon key is dropped, not drawn or echoed", async () => {
		const info: InfoLine[] = [{ index: 0, icon: "status.evil\u001b[31m" as NonNullable<InfoLine["icon"]>, spans: [{ text: "본문" }] }];
		let rendered = "";
		let styled = "";
		const host = fakeHost({
			mode: "tui",
			hasUI: true,
			rows: 30,
			async driveOverlay(view) {
				rendered = view.text();
				styled = view.rows().join("\n");
				view.press("q");
			},
		});
		await createUiPort(host.pi, host.ctx).report("제목", "본문", info);
		expect(rendered).toContain("본문");
		expect(rendered).not.toContain("evil");
		expect(styled).not.toContain("evil");
	});

	test("a cut rich panel withholds consent until the full rich report was shown", async () => {
		const lines = ["### 승인 요약", ...Array.from({ length: 60 }, (_, i) => `- 항목 ${i}`), "- 승인 대상: 마지막 줄"];
		const markdown = lines.join("\n");
		const info: InfoLine[] = lines.map((line, index) => {
			const spans: InfoLine["spans"] =
				index === 0
					? [{ text: "승인 요약", tone: "accent" }]
					: [{ text: line.replace(/^- /, "• "), tone: index === lines.length - 1 ? "warning" : "muted" }];
			// Even if approval context is mistakenly annotated, the full view must be linear.
			return { index, spans, ...(index === 0 ? { section: "overview" } : index === lines.length - 1 ? { section: "team" } : {}) };
		});
		const host = fakeHost({
			mode: "tui",
			hasUI: true,
			rows: 30,
			answers: [options => options[0], APPROVE],
			async driveOverlay(view) {
				// No tab strip: the approval's whole content is one linear page, so the second tab key and Tab change nothing.
				const top = view.text();
				view.press("2");
				view.press("tab");
				expect(view.text()).toBe(top);
				view.press("end");
				expect(view.text()).toContain("마지막 줄");
				view.press("q");
			},
		});
		const ui = createUiPort(host.pi, host.ctx);
		expect(await ui.select("승인할까요", [APPROVE, "취소"], { title: "승인", markdown, info, consent: [APPROVE] })).toBe(APPROVE);
		const [first, second] = host.selects;
		expect(first!.options).not.toContain(APPROVE);
		expect(first!.panel).toContain("승인 요약");
		expect(first!.panel).not.toContain("마지막 줄");
		expect(second!.options).toContain(APPROVE);
		expect(second!.options).toHaveLength(3);
		expect(host.overlays).toBe(1);
	});
});

describe("hosts that draw no components", () => {
	test("context, reports, records and notices are transcript messages kept out of the model's context, without a turn", async () => {
		const host = fakeHost({ mode: "rpc", hasUI: true, answers: ["a"] });
		const ui = createUiPort(host.pi, host.ctx);
		expect(await ui.select("pick", ["a", "b"], CONTEXT)).toBe("a");
		await ui.report("report-title", "report-body");
		ui.record("record-title", "record-body");
		ui.notify("notice-text", "warning");
		expect(host.selects[0]?.options).toEqual(["a", "b"]);
		expect(host.sent).toHaveLength(4);
		for (const { message, options } of host.sent) {
			expect(message.excludeFromContext).toBe(true);
			expect(message.display).toBe(true);
			expect(options?.triggerTurn).toBe(false);
		}
		const text = host.sent.map(s => String(s.message.content));
		for (const [i, part] of ["two", "report-body", "record-body", "notice-text"].entries()) expect(text[i]).toContain(part);
		// ACP only logs a notification, so the notice must not depend on it.
		expect(host.notified).toEqual([]);
		expect(host.overlays).toBe(0);
	});

	test("rich metadata never reaches the transcript as ANSI and never hides a consent option", async () => {
		const markdown = "### 승인\n\n- 승인 대상: 마지막 줄";
		const info: InfoLine[] = [
			{ index: 0, spans: [{ text: "승인", tone: "accent" }] },
			{ index: 2, spans: [{ text: "• 승인 대상: 마지막 줄", tone: "warning" }] },
		];
		const host = fakeHost({ mode: "rpc", hasUI: true, answers: [APPROVE] });
		const ui = createUiPort(host.pi, host.ctx);
		expect(await ui.select("승인할까요", [APPROVE, "취소"], { title: "승인", markdown, info, consent: [APPROVE] })).toBe(APPROVE);
		// The whole context is in the transcript, so nothing is withheld here.
		expect(host.selects[0]!.options).toEqual([APPROVE, "취소"]);
		await ui.report("보고서", markdown, info);
		expect(host.sent).toHaveLength(2);
		for (const { message } of host.sent) {
			const content = String(message.content);
			expect(content).toContain("마지막 줄");
			expect(content).not.toContain("\x1b");
		}
		expect(host.overlays).toBe(0);
	});
});

describe("closeout records", () => {
	const TITLE = "Storm 실행 결과";
	const BRIEF = {
		runId: "run-7",
		tier: "card",
		request: "결제 API 재시도 정책 정리",
		target: "omp-storm",
		startedAt: "2026-11-25T09:00:00Z",
		endedAt: "2026-11-25T09:42:00Z",
		official: {
			label: "완료 아님 · 라운드 한도",
			tone: "warning",
			hasResults: true,
			accepted: 1,
			inScope: 3,
			excluded: 0,
			open: { unsettled: 2, revoked: 0, blocked: 0, retry: 0, reviewable: 0, pending: 0, unmet: 0 },
		},
		residual: ["검증되지 않은 변경이 작업 트리에 남아 있습니다"],
		director: { result: "핵심 경로를 고쳤습니다.", stale: true },
		userActions: [],
		actions: [{ kind: "resume", label: "이어 가기" }],
	} as const;
	const { markdown, info } = renderCloseout(BRIEF, true);
	const style = { kind: "closeout", runId: "run-7", info } as const;

	for (const mode of ["tui", "rpc"] as const) {
		test(`${mode}: the record keeps its plain text, carries validated details, and never enters the model's context`, () => {
			const host = fakeHost({ mode, hasUI: true });
			createUiPort(host.pi, host.ctx).record(TITLE, markdown, style);
			expect(host.sent).toHaveLength(1);
			const [{ message, options }] = host.sent as [FakeHost["sent"][number]];
			expect(message.content).toBe(`### ${TITLE}\n\n${markdown}`);
			expect(message.excludeFromContext).toBe(true);
			expect(message.display).toBe(true);
			expect(options?.triggerTurn).toBe(false);
			expect((message as { details?: unknown }).details).toEqual({ v: 1, kind: "closeout", runId: "run-7", info });
			expect(String(message.content)).not.toContain("\x1b");
			expect(host.overlays).toBe(0);
		});
	}

	test("plain records and styling that does not match its text persist no details", () => {
		const host = fakeHost({ mode: "tui", hasUI: true });
		const ui = createUiPort(host.pi, host.ctx);
		ui.record("record-title", "record-body");
		ui.record(TITLE, `${markdown}\n- 덧붙인 줄`, style);
		ui.record(TITLE, markdown, { ...style, info: [{ index: 0, spans: [{ text: "[실행]" }] }] });
		expect(host.sent).toHaveLength(3);
		for (const { message } of host.sent) {
			expect("details" in message).toBe(false);
			expect(message.excludeFromContext).toBe(true);
		}
	});
});

describe("a host whose terminal looks cannot load", () => {
	// A later omp may move the module the looks come from; Storm must still load and decide nothing unseen.
	beforeEach(() => forceWindowing(false));
	afterEach(() => forceWindowing(undefined));

	test("a report goes to the transcript", async () => {
		const host = fakeHost({ mode: "tui", hasUI: true });
		await createUiPort(host.pi, host.ctx).report("보고서", "본문");
		expect(host.overlays).toBe(0);
		expect(host.sent).toHaveLength(1);
		expect(String(host.sent[0]!.message.content)).toContain("본문");
	});

	test("an approval's context is held in the transcript before consent is offered", async () => {
		const host = fakeHost({ mode: "tui", hasUI: true, answers: [options => options[0], APPROVE] });
		const context = { title: "승인", markdown: "### 승인\n\n- 대상: 전부", consent: [APPROVE] };
		expect(await createUiPort(host.pi, host.ctx).select("승인할까요", [APPROVE, "취소"], context)).toBe(APPROVE);
		expect(host.selects[0]!.options).not.toContain(APPROVE);
		expect(host.selects[0]!.options[0]).toBe(FULL_VIEW);
		expect(host.selects[1]!.options).toContain(APPROVE);
		expect(host.overlays).toBe(0);
		expect(String(host.sent[0]!.message.content)).toContain("대상: 전부");
		expect(host.panelSet()).toBe(false);
	});

	test("rows are one plain select that carries the detail", async () => {
		const host = fakeHost({ mode: "tui", hasUI: true, answers: [options => options[1]] });
		const rows = [
			{ value: "a", label: "하나", description: "설명 1" },
			{ value: "b", label: "둘", description: "설명 2" },
		];
		expect(await createUiPort(host.pi, host.ctx).selectRows?.("고르기", rows)).toBe("b");
		expect(host.selects[0]!.options).toEqual(offeredRowLabels(rows).labels);
		expect(host.overlays).toBe(0);
	});
});

describe("accepting on a small terminal", () => {
	const row = (provider: string, id: string, input: number, int: number) => ({
		provider,
		id,
		name: id,
		kind: "chat",
		cost: { input, output: input * 4, cacheRead: input / 10, cacheWrite: input },
		contextWindow: 200_000,
		thinking: { efforts: ["low", "medium", "high"] },
		supportsTools: true,
		int,
		tps: 80,
		identity: { class: id.split("-")[0] },
	});
	const CATALOG = [row("pa", "alpha-big", 5, 70), row("pb", "beta-mid", 1, 55), row("pc", "gamma-small", 0.2, 40), row("pa", "alpha-mini", 0.3, 42)];
	let project: TestProject;
	let env: FlowEnv;

	beforeEach(async () => {
		project = await makeProject(() => Date.parse("2026-11-20T09:30:00Z"));
		env = { ...project.env, registry: { getAll: () => CATALOG, getAvailable: () => CATALOG } };
		const agents = path.join(project.root, ".omp", "agents");
		await mkdir(agents, { recursive: true });
		await writeFile(path.join(agents, "shadow-file.md"), "---\nname: storm-reviewer\n---\nbody\n");
	});
	afterEach(() => project.remove());

	interface Dialog {
		title: string;
		options: string[];
		context: UiContext;
	}

	/** Records dialogs and answers each by exact label or position; none left means no answer. */
	function recordingUi(answers: Array<number | string> = []): { ui: UiPort; dialogs: Dialog[] } {
		const dialogs: Dialog[] = [];
		const queue = [...answers];
		const ui: UiPort = {
			async select(title, options, context) {
				if (context) dialogs.push({ title, options: [...options], context });
				const at = queue.shift();
				return typeof at === "number" ? options.at(at) : at !== undefined && options.includes(at) ? at : undefined;
			},
			notify() {},
			async report() {},
			record() {},
			form: async () => undefined,
		};
		return { ui, dialogs };
	}

	/**
	 * The approval dialog of a five-role first setup exactly as the flow opens it, with the project under a short fixed
	 * root: how many rows the panel takes must not depend on where the test's temp directory is.
	 */
	async function setupDialog(): Promise<Dialog> {
		const recorded = recordingUi();
		await setupFlow(env, recorded.ui);
		const dialog = recorded.dialogs[0]!;
		const info = dialog.context.info?.map((line): InfoLine => ({
			...line,
			spans: line.spans.map(span => {
				const text = span.text.replaceAll(project.root, "/repo");
				return span.tone === undefined ? { text } : { text, tone: span.tone };
			}),
		}));
		return {
			...dialog,
			context: {
				...dialog.context,
				markdown: dialog.context.markdown.replaceAll(project.root, "/repo"),
				...(info === undefined ? {} : { info }),
			},
		};
	}

	test("a cut panel holds the approval back until the whole content was opened", async () => {
		const dialog = await setupDialog();
		expect(dialog.options[0]).toBe(APPROVE);
		expect(dialog.context.consent).toEqual([APPROVE]);
		for (const rows of [24, 30]) {
			const host = fakeHost({ mode: "tui", hasUI: true, rows, answers: [options => options[0], APPROVE] });
			const answer = await createUiPort(host.pi, host.ctx).select(dialog.title, dialog.options, dialog.context);
			const [first, second] = host.selects;
			// Before: the full view, the option that approves nothing and the cancel. No approval.
			expect(first!.options).not.toContain(APPROVE);
			expect(first!.options.slice(1)).toEqual(dialog.options.slice(1));
			expect(first!.options).toHaveLength(dialog.options.length);
			expect(host.overlays).toBe(1);
			// After: everything, with the full view still on offer.
			expect(second!.options.slice(0, dialog.options.length)).toEqual(dialog.options);
			expect(second!.options).toHaveLength(dialog.options.length + 1);
			expect(answer).toBe(APPROVE);
		}
	});

	test("cancelling there needs no full view", async () => {
		const dialog = await setupDialog();
		const host = fakeHost({ mode: "tui", hasUI: true, rows: 24, answers: [options => options.at(-1)] });
		expect(await createUiPort(host.pi, host.ctx).select(dialog.title, dialog.options, dialog.context)).toBe(dialog.options.at(-1));
		expect(host.selects).toHaveLength(1);
		expect(host.overlays).toBe(0);
	});

	test("nothing changes where the panel fits", async () => {
		const dialog = await setupDialog();
		const host = fakeHost({ mode: "tui", hasUI: true, rows: 90, answers: [APPROVE] });
		expect(await createUiPort(host.pi, host.ctx).select(dialog.title, dialog.options, dialog.context)).toBe(APPROVE);
		expect(host.selects).toHaveLength(1);
		expect(host.selects[0]?.options).toEqual(dialog.options);
		expect(host.overlays).toBe(0);
	});

	test("on 30 rows the approval starts with the auto default; clipped details still require the full view", async () => {
		const dialog = await setupDialog();
		const host = fakeHost({ mode: "tui", hasUI: true, rows: 30, answers: [undefined] });
		await createUiPort(host.pi, host.ctx).select(dialog.title, dialog.options, dialog.context);
		const panel = host.selects[0]!.panel!;
		expect(panel.split("\n").length).toBeLessThanOrEqual(30 - dialog.options.length);
		expect(panel).toContain("승인하면 이 세션의 자동 위임이 켜집니다");
		expect(dialog.context.markdown).toContain("실행이 끝나면 정리");
		expect(dialog.context.markdown).toContain("/repo/.omp/agents/shadow-file.md");
		// One brand heading, after the first-approval default and the shadow warning; the narrow consent is unchanged.
		const markAt = dialog.context.markdown.indexOf(STORM_MARK);
		expect(dialog.context.markdown.split(STORM_MARK)).toHaveLength(2);
		expect(markAt).toBeGreaterThan(dialog.context.markdown.indexOf("승인하면 이 세션의 자동 위임이 켜집니다"));
		expect(markAt).toBeGreaterThan(dialog.context.markdown.indexOf("가림 정의"));
		expect(dialog.context.consent).toEqual([APPROVE]);
		expect(host.selects[0]?.options).not.toContain(APPROVE);
	});

	test("the whole role interview on 24 rows: approval only after the full view", async () => {
		const forms: HtmlForm[] = [];
		const formDialog = async (html: string): Promise<FormAnswer> => {
			const form = parseHtmlForm(html);
			forms.push(form);
			const data = defaultFormData(form);
			if (Object.hasOwn(data, FIELD.rounds)) data[FIELD.rounds] = 4;
			return { data };
		};
		const refused = fakeHost({
			mode: "tui",
			hasUI: true,
			rows: 24,
			answers: [PICK_BY_ROLE, options => (options.includes(APPROVE) ? APPROVE : undefined)],
			formDialog,
		});
		await setupFlow(env, createUiPort(refused.pi, refused.ctx));
		expect(refused.selects).toHaveLength(2);
		expect(refused.selects[1]?.options).not.toContain(APPROVE);
		expect((await loadProjectState(env)).config.status).toBe("missing");

		forms.length = 0;
		const host = fakeHost({
			mode: "tui",
			hasUI: true,
			rows: 24,
			answers: [PICK_BY_ROLE, options => options[0], APPROVE],
			formDialog,
		});
		await setupFlow(env, createUiPort(host.pi, host.ctx));
		const names = forms.map(form => form.fields.map(field => field.name));
		expect(names.flatMap(fields => fields.filter(name => ROLES.some(role => name === FIELD.primary(role.id))))).toEqual(
			ROLES.map(role => FIELD.primary(role.id)),
		);
		expect(names.some(fields => fields.includes(FIELD.effort))).toBe(true);
		expect(names.at(-1)).toContain(FIELD.rounds);
		const state = await loadProjectState(env);
		const saved = state.config.status === "ok" ? state.config.config : undefined;
		expect(Object.keys(saved?.roles ?? {})).toHaveLength(5);
		expect(saved?.cleanup).toBe(true);
		expect(saved?.rounds).toBe(4);
		expect(host.overlays).toBe(1);
		expect(host.selects).toHaveLength(3);
		expect(host.selects.at(-1)?.options).toContain(APPROVE);
		expect(await readAutoDelegation(state.sessionDir)).toBe(true);
	});

	test("every dialog that approves, restores or deletes names the options that do", async () => {
		// Unapproved session config: only the approval.
		const seeded = await loadProjectState(env);
		await Bun.write(configPath(seeded.sessionDir), serializeConfig(TEAM));
		const unapproved = recordingUi();
		await hubFlow(env, unapproved.ui);
		expect(unapproved.dialogs[0]?.context.consent).toEqual([APPROVE]);

		// The ordinary rollback item needs consent on the next screen; the menu itself changes nothing.
		const state = await loadProjectState(env);
		await approveAndSave(state, TEAM, { shadowedAgents: state.shadows });
		await approveAndSave(await loadProjectState(env), { ...TEAM, rounds: 2 }, { shadowedAgents: state.shadows });
		const rollback = recordingUi(["이전 승인으로 되돌리기", 0]);
		await hubFlow(env, rollback.ui);
		const [menu, confirm] = rollback.dialogs;
		expect(menu?.context.consent).toBeUndefined();
		expect(confirm?.context.consent).toEqual([confirm!.options[0]!]);

		// Reset: everything but the cancel deletes.
		const reset = recordingUi();
		await resetFlow(env, reset.ui);
		expect(reset.dialogs[0]?.context.consent).toEqual(expect.arrayContaining(reset.dialogs[0]!.options.slice(0, -1)));
	});
});
