/**
 * Live radar layout, structured metric chips, animation isolation, and native and plain terminal motion preferences.
 */
import { afterEach, describe, expect, test, vi } from "bun:test";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
	type Component,
	type DescribeContext,
	ensureThemeSync,
	isValidThemeColor,
	type NativeNode,
	setMotionEffects,
	setNativeRendering,
	setNativeSymbolPreset,
	setShimmerMode,
	theme as activeTheme,
	type TUI,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import { RUN_APPEARANCE, STORM_MARK, type RunPhase } from "../src/view/appearance.ts";
import { LIVE_WIDGET_KEY, LiveStatus } from "../src/view/live.ts";
import type { RunRecord, RunResult } from "../src/types.ts";
import { agentEntry, runRecord } from "./fixtures.ts";

ensureThemeSync();

const NOW = Date.parse("2026-11-20T09:03:00Z");
const RUN: RunRecord = runRecord({
	runId: "run-live",
	status: "running",
	startedAt: "2026-11-20T09:00:00.000Z",
	turns: 0,
	maxRounds: 4,
	costUsd: 0.12,
	budget: { perRunUsd: 5, onExceed: "block-spawns" },
	agents: [agentEntry({ id: "Impl", state: "running" }), agentEntry({ id: "Rev", state: "idle" })],
});
const COUNTERS = "↻ 1/4라운드 · 👥 1/2 · 💲 $0.1200/$5.00 · ⏱ 3분";
const ASCII_MARK = "~ STORM";
const ASCII_COUNTERS = "loop 1/4라운드 - AG 1/2 - $0.1200/$5.00 - t: 3분";

type Widget = Component & { dispose?(): void };
type WidgetFactory = (tui: TUI) => Widget;

interface WidgetHost {
	ctx: ExtensionContext;
	ui: { theme: typeof activeTheme };
	installs: Array<{ key: string; placement: string | undefined }>;
	statuses: Array<string | undefined>;
	widgets: Map<string, Widget>;
	requests: Component[];
}

/** The parts of a TUI host the widget touches: status writes, one widget slot, and component-render requests. */
function widgetHost(): WidgetHost {
	const statuses: Array<string | undefined> = [];
	const installs: Array<{ key: string; placement: string | undefined }> = [];
	const widgets = new Map<string, Widget>();
	const requests: Component[] = [];
	const tui = {
		requestComponentRender(component: Component) {
			requests.push(component);
		},
		requestRender() {},
	};
	const ui = {
		theme: activeTheme,
		setStatus(_key: string, text: string | undefined) {
			statuses.push(text);
		},
		setWidget(key: string, content: unknown, options?: { placement?: string }) {
			if (content === undefined) {
				widgets.get(key)?.dispose?.();
				widgets.delete(key);
				return;
			}
			if (Array.isArray(content)) return;
			widgets.set(key, (content as WidgetFactory)(tui as unknown as TUI));
			installs.push({ key, placement: options?.placement });
		},
	};
	return {
		ctx: { mode: "tui", hasUI: true, agent: { kind: "main", id: "main", name: "main" }, ui } as unknown as ExtensionContext,
		ui,
		installs,
		statuses,
		widgets,
		requests,
	};
}

function plain(rows: readonly string[]): string[] {
	return rows.map(row => Bun.stripANSI(row));
}

interface NativeTextProps {
	text?: string;
	spans?: readonly { t: string; s?: string }[];
	aria?: string;
	role?: string;
	palette?: Record<string, string>;
}

/** Test-only read of TSP's published props; the nodes inspected here are text and shimmer nodes. */
function nativeProps(node: NativeNode): NativeTextProps {
	// Test-only: the inspected nodes are text/shimmer, whose published props the test helper narrows here.
	const props = (node.p ?? {}) as NativeTextProps;
	return props;
}

function nodeText(node: NativeNode): string {
	const props = nativeProps(node);
	return props.text ?? (props.spans ?? []).map(part => part.t).join("");
}

function flatText(node: NativeNode): string {
	const own = nodeText(node);
	if (own.length > 0) return own;
	return (node.c ?? []).map(child => ("k" in child ? flatText(child) : "")).join("");
}

/** The described (non-component) children of a node, in sibling order. */
function children(node: NativeNode): NativeNode[] {
	const out: NativeNode[] = [];
	for (const child of node.c ?? []) if ("k" in child) out.push(child);
	return out;
}

function styles(node: NativeNode): string[] {
	return (nativeProps(node).spans ?? []).map(part => part.s ?? "");
}

function metricChips(row: NativeNode): NativeNode[] {
	return children(row).filter(node => nativeProps(node).role?.startsWith("omp.storm.live.") === true);
}

const liveHeader = (phase: RunPhase): string => `${STORM_MARK} · ${RUN_APPEARANCE[phase].label}`;
const radar = /\[[\u2801-\u28ff]{18}\]$/;

const describeContext = {
	cols: 100,
	reduceMotion: false,
	dark: true,
	supports: (kind: string) => kind === "shimmer",
} as unknown as DescribeContext;

const activeWidgets: LiveStatus[] = [];

function liveForTest(): LiveStatus {
	const live = new LiveStatus({ now: () => NOW });
	activeWidgets.push(live);
	return live;
}

afterEach(() => {
	for (const live of activeWidgets.splice(0)) live.clear();
	vi.useRealTimers();
	setMotionEffects(true);
	setShimmerMode("classic");
	setNativeRendering(false);
	setNativeSymbolPreset(undefined);
});

describe("the live run widget", () => {
	test("whole metric chips fit at 60, while narrow hosts keep the phase and then phase counters", () => {
		vi.useFakeTimers();
		const host = widgetHost();
		const live = liveForTest();
		expect(live.show(host.ctx, RUN)).toBe(true);
		expect(host.statuses).toEqual([undefined]);
		const component = host.widgets.get(LIVE_WIDGET_KEY)!;
		const header = liveHeader("working");
		for (const width of [120, 80, 60, 52]) {
			const rows = component.render(width);
			const [title, metrics] = plain(rows);
			expect(rows).toHaveLength(2);
			expect(rows.every(line => visibleWidth(line) <= width)).toBe(true);
			expect(title).toStartWith(header);
			expect(title).toMatch(radar);
			expect(metrics).toBe(`› ${COUNTERS}`);
		}
		// 49 cells of whole chips, including emoji widths, fit inside the 60-cell acceptance width.
		expect(visibleWidth(component.render(60)[1]!)).toBe(49);

		const narrow: Array<[number, string]> = [
			// Elapsed is dropped before the Storm mark or a counter; at 51 the mark keeps the compact cost.
			[51, `${header} · ↻ 1/4라운드 · 👥 1/2 · 💲 $0.12`],
			[45, `${header} · ↻ 1/4 · 👥 1/2 · 💲 $0.12`],
			[40, `${header} · ↻ 1/4라운드 · 👥 1/2`],
			[39, `${header} · ↻ 1/4 · 👥 1/2`],
			[30, "진행 중 · ↻ 1/4라운드 · 👥 1/2"],
			[25, "진행 중 · ↻ 1/4 · 👥 1/2"],
			[24, "진행 중 · ↻ 1/4 · 👥 1/2"],
			[21, "진행 중 · ↻ 1/4라운드"],
			[20, "진행 중 · ↻ 1/4"],
			[17, "진행 중 · ↻ 1/4"],
			[14, "진행 중"],
			[8, "진행 중"],
		];
		for (const [width, expected] of narrow) {
			const rows = component.render(width);
			expect(rows).toHaveLength(1);
			expect(plain(rows)[0]).toBe(expected);
			expect(visibleWidth(rows[0]!)).toBeLessThanOrEqual(width);
			expect(plain(rows)[0]).not.toMatch(radar);
			expect(vi.getTimerCount()).toBe(0);
		}
		// Below the phase word itself only the phase may truncate; no chip or separator is ever clipped.
		const clipped = component.render(6);
		expect(clipped).toHaveLength(1);
		expect(plain(clipped)[0]).toBe("진행 …");
		expect(visibleWidth(clipped[0]!)).toBeLessThanOrEqual(6);
		expect(component.render(0)).toEqual([]);
		expect(vi.getTimerCount()).toBe(0);

		// Waiting and stopping are not displaced by counters when the width cannot hold both.
		for (const phase of ["waiting-user", "stopping"] as const) {
			live.show(host.ctx, RUN, phase);
			expect(plain(component.render(12))[0]).toBe(RUN_APPEARANCE[phase].label);
			expect(plain(component.render(8))[0]).toEndWith("…");
			expect(plain(component.render(6))[0]).toEndWith("…");
		}

		const radarOf = (phase: RunPhase): string => {
			live.show(host.ctx, RUN, phase);
			return plain(component.render(120))[0]!.match(radar)![0];
		};
		expect(new Set([radarOf("working"), radarOf("waiting-user"), radarOf("stopping")]).size).toBe(3);

		// The running/total pair is explicit even when the ledger has no agents left.
		live.show(host.ctx, { ...RUN, agents: [] });
		expect(plain(component.render(60))[1]).toBe("› ↻ 1/4라운드 · 👥 0/0 · 💲 $0.1200/$5.00 · ⏱ 3분");
		live.clear();
	});

	test("a still phase stops the one timer immediately and snaps to still; resuming and ending leave no extra", () => {
		vi.useFakeTimers();
		const host = widgetHost();
		const live = liveForTest();
		live.show(host.ctx, RUN);
		const component = host.widgets.get(LIVE_WIDGET_KEY)!;
		expect(vi.getTimerCount()).toBe(0);
		const first = component.render(120);
		expect(vi.getTimerCount()).toBe(1);
		const ticking = host.requests.length;
		vi.advanceTimersByTime(100);
		const next = component.render(120);
		expect(host.requests.length).toBeGreaterThan(ticking);
		expect(plain(next)[0]).toStartWith(liveHeader("working"));
		expect(plain(next)[0]!.match(radar)?.[0]).not.toBe(plain(first)[0]!.match(radar)?.[0]);
		expect(next[1]).toBe(first[1]);

		for (const phase of ["waiting-user", "between-rounds", "stopping"] as const) {
			live.show(host.ctx, RUN, phase);
			expect(vi.getTimerCount()).toBe(0);
			const requests = host.requests.length;
			vi.advanceTimersByTime(1_000);
			expect(host.requests.length).toBe(requests);
			const [title, metrics] = plain(component.render(120));
			expect(title).toStartWith(liveHeader(phase));
			expect(title).toMatch(radar);
			expect(metrics).toBe(`› ${COUNTERS}`);
			expect(vi.getTimerCount()).toBe(0);
		}

		// Resume an active phase: one interval, not one more per pause.
		live.show(host.ctx, RUN, "verifying");
		expect(vi.getTimerCount()).toBe(1);
		live.show(host.ctx, RUN, "verifying");
		expect(vi.getTimerCount()).toBe(1);
		const resumed = host.requests.length;
		vi.advanceTimersByTime(100);
		expect(host.requests.length).toBeGreaterThan(resumed);

		live.clear();
		expect(vi.getTimerCount()).toBe(0);
		const ended = host.requests.length;
		vi.advanceTimersByTime(1_000);
		expect(host.requests.length).toBe(ended);
		expect(host.statuses).toEqual([undefined]);
	});

	test("native metrics carry whole labels and aria; a narrow host gets one compact line", () => {
		vi.useFakeTimers();
		const host = widgetHost();
		const live = liveForTest();
		live.show(host.ctx, RUN);
		const component = host.widgets.get(LIVE_WIDGET_KEY)!;
		const native = component.describe!(describeContext)!;
		const [, metrics] = children(native);
		const chips = metricChips(metrics!);
		expect(chips.map(nodeText)).toEqual(["↻ 1/4라운드", "👥 1/2", "💲 $0.1200/$5.00", "⏱ 3분"]);
		expect(chips.map(chip => nativeProps(chip).aria)).toEqual([
			"라운드 1/4",
			"워커 실행 중 1/2",
			"비용 $0.1200 / 예산 $5.00",
			"경과 3분",
		]);
		expect(flatText(metrics!)).toBe(`› ${COUNTERS}`);

		const narrow = component.describe!({ ...describeContext, cols: 38 })!;
		expect(flatText(narrow)).toBe("≋ STORM · 진행 중 · ↻ 1/4 · 👥 1/2");
		expect(nativeProps(narrow).aria).toBe("≋ STORM · 진행 중: 라운드 1/4 · 워커 실행 중 1/2");
		live.clear();
	});

	test("only the approved budget thresholds tint spend; the state word carries it too", () => {
		vi.useFakeTimers();
		const host = widgetHost();
		const live = liveForTest();
		const budget = { perRunUsd: 5, warnAtUsd: 4, onExceed: "block-spawns" as const };
		live.show(host.ctx, { ...RUN, costUsd: 3.5, budget });
		const component = host.widgets.get(LIVE_WIDGET_KEY)!;
		expect(plain(component.render(120))[1]).toBe("› ↻ 1/4라운드 · 👥 1/2 · 💲 $3.50/$5.00 · ⏱ 3분");

		const costChip = () => {
			const metrics = children(component.describe!(describeContext)!)[1]!;
			return metricChips(metrics).find(chip => nativeProps(chip).role === "omp.storm.live.cost")!;
		};
		expect(styles(costChip()).some(style => style.includes("warning") || style.includes("error"))).toBe(false);

		live.show(host.ctx, { ...RUN, costUsd: 4, budget });
		expect(plain(component.render(120))[1]).toBe("› ↻ 1/4라운드 · 👥 1/2 · 💲 $4.00/$5.00 경고 · ⏱ 3분");
		const warned = styles(costChip());
		expect(warned).toContain("warning strong");
		expect(warned).toContain("warning");
		expect(nativeProps(costChip()).aria).toBe("비용 $4.00 / 예산 $5.00, 예산 경고");

		live.show(host.ctx, { ...RUN, costUsd: 5.5, budget });
		expect(plain(component.render(120))[1]).toBe("› ↻ 1/4라운드 · 👥 1/2 · 💲 $5.50/$5.00 초과 · ⏱ 3분");
		const over = styles(costChip());
		expect(over).toContain("error strong");
		expect(over).toContain("error");

		// No approved budget means no warning/overage policy to apply, even at a large spend.
		const unbudgeted: RunRecord = { ...RUN, costUsd: 99 };
		delete unbudgeted.budget;
		live.show(host.ctx, unbudgeted);
		expect(plain(component.render(120))[1]).toBe("› ↻ 1/4라운드 · 👥 1/2 · 💲 $99.00 · ⏱ 3분");
		expect(styles(costChip()).some(style => style.includes("warning") || style.includes("error"))).toBe(false);
		live.clear();
	});

	test("Tern animates only the radar and keeps it still in compact mode, under reduced motion, or without support", () => {
		vi.useFakeTimers();
		const host = widgetHost();
		const live = liveForTest();
		live.show(host.ctx, RUN);
		const component = host.widgets.get(LIVE_WIDGET_KEY)!;
		component.render(120);
		expect(vi.getTimerCount()).toBe(1);

		const parts = (native: NativeNode) => {
			const [header, metrics] = children(native);
			const [label, , , field] = children(header!);
			return { label: label!, field: field!, metrics: metrics! };
		};
		const native = component.describe!(describeContext)!;
		const { label, field, metrics } = parts(native);
		expect(nodeText(label)).toBe(liveHeader("working"));
		expect(field.k).toBe("shimmer");
		expect(`[${nodeText(field)}]`).toMatch(radar);
		expect(flatText(metrics)).toBe(`› ${COUNTERS}`);
		const palette = nativeProps(field).palette;
		expect(Object.values(palette ?? {}).every(isValidThemeColor)).toBe(true);
		expect(vi.getTimerCount()).toBe(0); // the host owns this animation
		const narrow = component.describe!({ ...describeContext, cols: 38 })!;
		expect(flatText(narrow)).toBe("≋ STORM · 진행 중 · ↻ 1/4 · 👥 1/2");
		for (const cx of [{ ...describeContext, reduceMotion: true }, { ...describeContext, supports: () => false }]) {
			const still = parts(component.describe!(cx)!);
			expect(still.field.k).toBe("text");
			expect(nodeText(still.field)).toBe(nodeText(field));
		}
		setShimmerMode("disabled");
		expect(parts(component.describe!(describeContext)!).field.k).toBe("text");
		const disabled = component.render(120);
		vi.advanceTimersByTime(500);
		expect(component.render(120)).toEqual(disabled);
		expect(vi.getTimerCount()).toBe(0);

		setShimmerMode("classic");
		setMotionEffects(false);
		expect(parts(component.describe!(describeContext)!).field.k).toBe("text");
		component.render(120);
		expect(vi.getTimerCount()).toBe(0);

		setMotionEffects(true);
		live.show(host.ctx, RUN, "waiting-user");
		const waiting = parts(component.describe!(describeContext)!);
		expect(waiting.field.k).toBe("text");
		const waitingSpans = nativeProps(waiting.label).spans ?? [];
		expect(waitingSpans.map(part => part.s)).toEqual(["accent", "dim", "warning"]);
		expect(vi.getTimerCount()).toBe(0);

		// A native surface never runs the ANSI timer; Tern still receives the described sheen.
		live.show(host.ctx, RUN, "working");
		expect(vi.getTimerCount()).toBe(1);
		setNativeRendering(true);
		expect(vi.getTimerCount()).toBe(0);
		component.render(120);
		expect(vi.getTimerCount()).toBe(0);
		const nativeRequests = host.requests.length;
		vi.advanceTimersByTime(500);
		expect(host.requests.length).toBe(nativeRequests);
		expect(parts(component.describe!(describeContext)!).field.k).toBe("shimmer");
		expect(vi.getTimerCount()).toBe(0);

		setNativeRendering(false);
		expect(vi.getTimerCount()).toBe(1);
		component.render(120);
		expect(vi.getTimerCount()).toBe(1);
		live.clear();
		expect(vi.getTimerCount()).toBe(0);
	});

	test("the ASCII preset rebuilds the mark, radar and chips without braille; phases stay distinct", () => {
		expect(setNativeSymbolPreset("ascii")).toBe(true);
		expect(activeTheme.getSymbolPreset()).toBe("ascii");
		const host = widgetHost();
		const live = liveForTest();
		live.show(host.ctx, RUN);
		const component = host.widgets.get(LIVE_WIDGET_KEY)!;
		const rows = component.render(60);
		expect(rows).toHaveLength(2);
		expect(plain(rows)[0]).toStartWith(`${ASCII_MARK} - 진행 중`);
		expect(plain(rows)[1]).toBe(`> ${ASCII_COUNTERS}`);
		expect(plain(rows)[1]).not.toContain("$ $");
		expect(visibleWidth(rows[1]!)).toBe(50);
		expect(rows.every(row => visibleWidth(row) <= 60)).toBe(true);
		expect(plain(rows).join("\n")).not.toMatch(/[\u2801-\u28ff≋↻👥💲⏱›·…]/);

		const fieldOf = (phase: RunPhase): string => {
			live.show(host.ctx, RUN, phase);
			const title = plain(component.render(60))[0]!;
			return title.slice(title.lastIndexOf("[") + 1, -1);
		};
		const working = fieldOf("working");
		const waiting = fieldOf("waiting-user");
		const stopping = fieldOf("stopping");
		expect(working).toBe("~-~-~-~-~-~-~-~-~-");
		expect(waiting).toBe("= = = = = = = = = ");
		expect(stopping).toBe("|/|/|/|/|/|/|/|/|/");
		expect(new Set([working, waiting, stopping]).size).toBe(3);

		live.show(host.ctx, RUN, "working");
		const native = component.describe!(describeContext)!;
		const [headerRow, metrics] = children(native);
		expect(nodeText(children(headerRow!)[0]!)).toStartWith(`${ASCII_MARK} - `);
		expect(`[${nodeText(children(headerRow!)[3]!)}]`).toMatch(/^\[[ -~]{18}\]$/);
		expect(flatText(metrics!)).toBe(`> ${ASCII_COUNTERS}`);
		const asciiCost = metricChips(metrics!).find(chip => nativeProps(chip).role === "omp.storm.live.cost")!;
		expect(nodeText(asciiCost)).toBe("$0.1200/$5.00");
		expect(nativeProps(asciiCost).aria).toBe("비용 $0.1200 / 예산 $5.00");
		const narrow = component.describe!({ ...describeContext, cols: 38 })!;
		expect(flatText(narrow)).toBe(`${ASCII_MARK} - 진행 중 - loop 1/4 - AG 1/2`);
		live.clear();
	});

	test("ASCII width pressure keeps cost plus limit intact and drops elapsed first", () => {
		expect(setNativeSymbolPreset("ascii")).toBe(true);
		const host = widgetHost();
		const live = liveForTest();
		live.show(host.ctx, { ...RUN, costUsd: 4, budget: { perRunUsd: 5, warnAtUsd: 4, onExceed: "block-spawns" } });
		const component = host.widgets.get(LIVE_WIDGET_KEY)!;
		const rows = component.render(52);
		expect(plain(rows)[1]).toBe("> loop 1/4라운드 - AG 1/2 - $4.00/$5.00 경고");
		expect(plain(rows)[1]).not.toContain("t:");
		expect(plain(rows)[1]).not.toContain("$ $");
		expect(visibleWidth(rows[1]!)).toBeLessThanOrEqual(52);
		live.clear();
	});

	test("a runtime theme change invalidates cached ANSI and native shaping", () => {
		vi.useFakeTimers();
		const host = widgetHost();
		const live = liveForTest();
		live.show(host.ctx, RUN);
		const component = host.widgets.get(LIVE_WIDGET_KEY)!;
		expect(plain(component.render(60))[1]).toBe(`› ${COUNTERS}`);
		expect(flatText(component.describe!(describeContext)!)).toContain("≋ STORM");

		expect(setNativeSymbolPreset("ascii")).toBe(true);
		host.ui.theme = activeTheme;
		expect(plain(component.render(60))[1]).toBe(`> ${ASCII_COUNTERS}`);
		expect(plain(component.render(60))[0]).toStartWith(`${ASCII_MARK} - 진행 중`);
		expect(flatText(component.describe!(describeContext)!)).toContain(`${ASCII_MARK} - 진행 중`);
		live.clear();
	});

	test("a live update reuses the component and redraws the new phase, round and spend", () => {
		vi.useFakeTimers();
		const host = widgetHost();
		const live = liveForTest();
		live.show(host.ctx, RUN);
		const component = host.widgets.get(LIVE_WIDGET_KEY)!;
		component.render(120);
		const installs = host.installs.length;
		expect(vi.getTimerCount()).toBe(1);

		const next = { ...RUN, turns: 1, costUsd: 0.2 };
		expect(live.show(host.ctx, next, "verifying")).toBe(true);
		expect(host.installs).toHaveLength(installs);
		expect(vi.getTimerCount()).toBe(1);
		const [heading, metrics] = plain(component.render(220));
		expect(heading).toStartWith(liveHeader("verifying"));
		expect(metrics).toContain("2/4라운드");
		expect(metrics).toContain("$0.2000/$5.00");
		expect(host.statuses).toEqual([undefined]);

		live.clear();
	});

	test("result progress leads worker chips and repaints when only the ledger changes", () => {
		vi.useFakeTimers();
		const host = widgetHost();
		const live = liveForTest();
		const run: RunRecord = {
			...RUN,
			plan: {
				lanes: [
					{
						name: "api",
						kind: "code",
						role: "implementer",
						results: [{ id: "api", kind: "change", criterion: "API 검증" }],
					},
				],
				workers: { implementer: 1 },
				submittedAt: "2026-11-20T09:00:00.000Z",
			},
			results: [
				{ id: "api", lane: "api", state: "unmet", reason: "응답 계약이 다릅니다." },
				{ id: "docs", lane: "api", state: "accepted", reason: "문서 갱신을 확인했습니다." },
			],
		};
		live.show(host.ctx, run);
		const component = host.widgets.get(LIVE_WIDGET_KEY)!;
		for (const width of [200, 120]) {
			const row = plain(component.render(width))[1]!;
			expect(row).toContain("API 검증");
			expect(row).toContain("미충족");
			expect(row.indexOf("API 검증")).toBeLessThan(row.indexOf("↻"));
			expect(visibleWidth(component.render(width)[1]!)).toBeLessThanOrEqual(width);
		}
		const compact = plain(component.render(60))[1]!;
		expect(compact).toContain("미충족");
		if (compact.includes("↻")) expect(compact.indexOf("미충족")).toBeLessThan(compact.indexOf("↻"));
		expect(visibleWidth(component.render(60)[1]!)).toBeLessThanOrEqual(60);
		const metrics = plain(component.render(200))[1]!;
		expect(metrics).toStartWith("› 🎯 API 검증 미충족 · 이행 1/2");
		const narrow = plain(component.render(30))[0]!;
		expect(narrow).toContain("미충족");
		expect(visibleWidth(component.render(30)[0]!)).toBeLessThanOrEqual(30);

		const nativeChips = metricChips(children(component.describe!(describeContext)!)[1]!);
		expect(nativeProps(nativeChips[0]!).role).toBe("omp.storm.live.results");
		expect(nativeProps(nativeChips[0]!).aria).toBe("결과 API 검증 (api) · 이행 1/2 · 미충족 1");

		// The counters stay identical; only the ledger settles. The key must still repaint the widget.
		const requests = host.requests.length;
		live.show(host.ctx, {
			...run,
			results: [
				{ id: "api", lane: "api", state: "accepted", reason: "응답 계약을 확인했습니다." },
				{ id: "docs", lane: "api", state: "accepted", reason: "문서 갱신을 확인했습니다." },
			],
		});
		expect(host.requests.length).toBeGreaterThan(requests);
		expect(plain(component.render(200))[1]).toContain("API 검증 이행 2/2");
		expect(plain(component.render(200))[1]).not.toContain("미충족");
		live.clear();
	});

	test("an operator-excluded result is visibly listed but never counted in scope", () => {
		vi.useFakeTimers();
		const host = widgetHost();
		const live = liveForTest();
		const excluded = { id: "skip", state: "accepted", scope: "excluded-by-user" } as unknown as RunResult;
		live.show(host.ctx, {
			...RUN,
			results: [{ id: "blocked", lane: "api", state: "unmet", reason: "검증이 막혔습니다." }, excluded],
		});
		const component = host.widgets.get(LIVE_WIDGET_KEY)!;
		const metrics = plain(component.render(200))[1]!;
		expect(metrics).toContain("이행 0/1");
		expect(metrics).toContain("제외 1");
		expect(metrics).not.toContain("0/2");
		const nativeChips = metricChips(children(component.describe!(describeContext)!)[1]!);
		expect(nativeProps(nativeChips[0]!).aria).toBe("결과 blocked · 이행 0/1 · 미충족 1 · 사용자 제외 1");
		live.clear();
	});

	test("dispose or a replaced host stops the old component; the next show installs a fresh one", () => {
		vi.useFakeTimers();
		const host = widgetHost();
		const live = liveForTest();
		live.show(host.ctx, RUN);
		const first = host.widgets.get(LIVE_WIDGET_KEY)!;
		first.render(120);
		expect(vi.getTimerCount()).toBe(1);

		first.dispose?.();
		expect(vi.getTimerCount()).toBe(0);
		expect(first.render(120)).toEqual([]);

		live.show(host.ctx, { ...RUN, turns: 1 });
		expect(host.installs).toHaveLength(2);
		const second = host.widgets.get(LIVE_WIDGET_KEY)!;
		expect(second).not.toBe(first);
		second.render(120);
		expect(vi.getTimerCount()).toBe(1);

		// A new host object replaces the widget in place of the old session's component.
		const replacement = widgetHost();
		live.show(replacement.ctx, RUN, "waiting-user");
		expect(vi.getTimerCount()).toBe(0);
		const third = replacement.widgets.get(LIVE_WIDGET_KEY)!;
		expect(third).not.toBe(second);
		expect(plain(third.render(120))[0]).toStartWith(liveHeader("waiting-user"));

		live.clear();
		expect(vi.getTimerCount()).toBe(0);
		expect(replacement.widgets.size).toBe(0);
	});

	test("only the main TUI gets a widget; RPC keeps the plain path and a switch invalidates old work", () => {
		const host = widgetHost();
		const live = liveForTest();
		expect(live.show({ ...host.ctx, mode: "rpc" } as ExtensionContext, RUN, "working")).toBe(false);
		expect(host.installs).toHaveLength(0);
		expect(host.statuses).toEqual([]);
		expect(live.show({ ...host.ctx, agent: { kind: "sub" } } as ExtensionContext, RUN)).toBe(false);

		expect(live.show(host.ctx, RUN, "waiting-user")).toBe(true);
		const epoch = live.epoch();
		const next = live.beginSession();
		expect(next).not.toBe(epoch);
		expect(live.isCurrent(epoch)).toBe(false);
		expect(live.isCurrent(next)).toBe(true);
		expect(host.widgets.size).toBe(0);
	});
});
