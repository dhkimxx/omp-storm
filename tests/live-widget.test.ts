/**
 * Live widget: the single status line with its radar (layout, metric chips, animation isolation, native and plain
 * terminal motion preferences) and the lane view above it (rows, height, timer, switch).
 *
 * `describe("the live run widget")` tests the single line on purpose: its `LiveStatus` has the lane view switched
 * off, so a tall terminal in the test host cannot turn it into the lane view by accident. The lane view has its own
 * `describe` below.
 */
import { afterEach, describe, expect, spyOn, test, vi } from "bun:test";
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
import * as frameModule from "../src/view/lane/frame.ts";
import { LANE_MIN_ROWS, LIVE_WIDGET_KEY, LiveStatus } from "../src/view/live.ts";
import type { RunRecord, RunResult } from "../src/types.ts";
import { agentEntry, runRecord, spawnRecord } from "./fixtures.ts";

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
	/** The terminal the widget asks for its height; change `rows` to resize the window under a mounted widget. */
	terminal: { rows: number };
	installs: Array<{ key: string; placement: string | undefined }>;
	statuses: Array<string | undefined>;
	widgets: Map<string, Widget>;
	requests: Component[];
}

/** The parts of a TUI host the widget touches: status writes, one widget slot, render requests, terminal height. */
function widgetHost(rows = 40): WidgetHost {
	const statuses: Array<string | undefined> = [];
	const installs: Array<{ key: string; placement: string | undefined }> = [];
	const widgets = new Map<string, Widget>();
	const requests: Component[] = [];
	const terminal = { rows };
	const tui = {
		terminal,
		requestComponentRender(component: Component) {
			requests.push(component);
		},
		requestRender() {},
	};
	const ui = {
		// Read through the module binding: a preset change after the host exists is what the widget must see.
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
		terminal,
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
const realLaneFrame = frameModule.laneFrame;
const SSH_VARIABLES = ["SSH_CONNECTION", "SSH_TTY"] as const;
const savedEnv = new Map<string, string | undefined>(SSH_VARIABLES.map(name => [name, process.env[name]]));

function restoreEnv(): void {
	for (const [name, value] of savedEnv) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
}

/** The single status line: the lane view is switched off, whatever the terminal's size. */
function liveForTest(): LiveStatus {
	const live = new LiveStatus({ now: () => NOW, laneView: () => false });
	activeWidgets.push(live);
	return live;
}

afterEach(() => {
	for (const live of activeWidgets.splice(0)) live.clear();
	restoreEnv();
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

	test("an uncapped run shows the round without a maximum, at 60 cells and in the native chips", () => {
		vi.useFakeTimers();
		const host = widgetHost();
		const live = liveForTest();
		const { maxRounds: _capped, ...open } = RUN;
		live.show(host.ctx, { ...open, turns: 2 });
		const component = host.widgets.get(LIVE_WIDGET_KEY)!;
		const rows = component.render(60);
		expect(rows.every(line => visibleWidth(line) <= 60)).toBe(true);
		expect(plain(rows)[1]).toBe("› ↻ 3라운드 · 👥 1/2 · 💲 $0.1200/$5.00 · ⏱ 3분");
		const [, metrics] = children(component.describe!(describeContext)!);
		expect(metricChips(metrics!).map(chip => nativeProps(chip).aria)[0]).toBe("라운드 3");
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

	test("a long result criterion leads at 60 and leaves whole lower-priority chips to roomier rows", () => {
		vi.useFakeTimers();
		const host = widgetHost();
		const live = liveForTest();
		// The real acceptance criterion is long enough that its full result form owns a 60-column metrics row.
		const criterion = "report what e2e-tracked.txt line 1 says";
		const run: RunRecord = {
			...RUN,
			agents: [agentEntry({ id: "Impl", state: "running" })],
			plan: {
				lanes: [
					{
						name: "impl",
						kind: "code",
						role: "implementer",
						results: [{ id: "impl-answer", kind: "answer", criterion }],
					},
				],
				workers: { implementer: 1 },
				submittedAt: "2026-11-20T09:00:00.000Z",
			},
			results: [{ id: "impl-answer", lane: "impl", state: "pending" }],
		};
		live.show(host.ctx, run, "workers");
		const component = host.widgets.get(LIVE_WIDGET_KEY)!;

		// Result-first is the whole row here: a shorter result form would fit more chips, but the criterion wins.
		const compact = plain(component.render(60));
		expect(compact).toHaveLength(2);
		expect(compact[0]).toStartWith(`${STORM_MARK} · ${RUN_APPEARANCE.workers.label}`);
		expect(compact[1]).toBe(`› 🎯 ${criterion} 대기 · 이행 0/1`);
		expect(visibleWidth(component.render(60)[1]!)).toBeLessThanOrEqual(60);
		const compactChips = metricChips(children(component.describe!({ ...describeContext, cols: 60 })!)[1]!);
		expect(compactChips.map(chip => nativeProps(chip).role)).toEqual(["omp.storm.live.results"]);
		expect(nativeProps(compactChips[0]!).aria).toBe(`결과 ${criterion} (impl-answer) · 이행 0/1 · 대기 1`);

		// With room, the same result still leads; the round, active worker, spend and elapsed chips follow whole.
		const wide = plain(component.render(120))[1]!;
		expect(wide).toBe(`› 🎯 ${criterion} 대기 · 이행 0/1 · ↻ 1/4라운드 · 👥 1/1 · 💲 $0.1200/$5.00 · ⏱ 3분`);
		expect(visibleWidth(component.render(120)[1]!)).toBeLessThanOrEqual(120);
		const wideChips = metricChips(children(component.describe!({ ...describeContext, cols: 120 })!)[1]!);
		expect(wideChips.map(chip => nativeProps(chip).role)).toEqual([
			"omp.storm.live.results",
			"omp.storm.live.round",
			"omp.storm.live.workers",
			"omp.storm.live.cost",
			"omp.storm.live.time",
		]);

		// The ASCII preset keeps the same result-first row and readable ASCII cost; no Unicode fallback returns.
		expect(setNativeSymbolPreset("ascii")).toBe(true);
		host.ui.theme = activeTheme;
		expect(plain(component.render(60))[1]).toBe(`> ${criterion} 대기 · 이행 0/1`);
		const asciiWide = plain(component.render(120))[1]!;
		expect(asciiWide).toBe(`> ${criterion} 대기 · 이행 0/1 - loop 1/4라운드 - AG 1/1 - $0.1200/$5.00 - t: 3분`);
		expect(asciiWide).not.toMatch(/[\u2801-\u28ff≋↻👥💲⏱›]/u);
		expect(asciiWide).not.toContain("$ $");
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

// ---- The lane view ----------------------------------------------------------------------------------------------

const LONG_LANE = "아주긴한글레인이름아주긴한글레인이름아주긴한글레인이름";
const iso = (ms: number): string => new Date(ms).toISOString();
/** The contract's height for a terminal of this many rows, written out again so a drifting constant is caught. */
const heightFor = (rows: number): number => Math.min(12, Math.max(6, Math.floor(rows / 3)));

/** A run with a plan: two workers running, a reviewer lane that waits for one of them, and a lane with a very long name. */
function laneRun(over: Partial<RunRecord> = {}, now = NOW): RunRecord {
	const worker = (id: string) => agentEntry({ id, state: "running", startedAt: now - 120_000, lastActivityAt: now - 1_000 });
	return runRecord({
		runId: "run-lane",
		status: "running",
		startedAt: iso(now - 180_000),
		turns: 1,
		maxRounds: 4,
		plan: {
			submittedAt: iso(now - 170_000),
			workers: { implementer: 3, reviewer: 1 },
			lanes: [
				{ name: "Api", kind: "code", role: "implementer" },
				{ name: "Ui", kind: "code", role: "implementer" },
				{ name: LONG_LANE, kind: "code", role: "implementer" },
				{ name: "Check", kind: "review", role: "reviewer", dependsOn: [{ lane: "Api", need: "reviewable" }] },
			],
		},
		agents: [worker("Api"), worker("Ui"), worker("Long")],
		spawns: [
			spawnRecord({ spawnKey: "Api", lane: "Api" }),
			spawnRecord({ spawnKey: "Ui", lane: "Ui" }),
			spawnRecord({ spawnKey: "Long", lane: LONG_LANE }),
		],
		...over,
	});
}

/** The same plan with every worker settled: the lanes idle and the picture has nothing running. */
function settledRun(over: Partial<RunRecord> = {}): RunRecord {
	const run = laneRun(over);
	return { ...run, agents: (run.agents ?? []).map(agent => ({ ...agent, state: "idle" })) };
}

interface LaneSetup {
	live: LiveStatus;
	clock: { now: number };
	host: WidgetHost;
	component: () => Widget;
	/** Shows the run through the status and returns nothing; the host's widget is `component()`. */
	show: (run: RunRecord, phase?: RunPhase) => void;
}

/** A status with the lane view on (or following `switch`), on a host with a `rows` tall terminal and a movable clock. */
function laneSetup(options: { rows?: number; switch?: () => boolean } = {}): LaneSetup {
	const clock = { now: NOW };
	const live = new LiveStatus({ now: () => clock.now, laneView: options.switch ?? (() => true) });
	activeWidgets.push(live);
	const host = widgetHost(options.rows ?? 40);
	return {
		live,
		clock,
		host,
		component: () => host.widgets.get(LIVE_WIDGET_KEY)!,
		show: (run, phase = "working") => void live.show(host.ctx, run, phase),
	};
}

/** A waiting or between-rounds picture first lets its last events play out; this is the clock step that ends that. */
const SETTLE_MS = 3_000;
const RADAR_ROW = /\[[⠁-⣿]{18}\]$/;
const blank = (rows: readonly string[]): boolean => rows.every(row => row === "");

describe("the live run widget in lane mode", () => {
	test("draws the status row without the radar, then the picture, at the height the terminal decides", () => {
		vi.useFakeTimers();
		for (const rows of [18, 21, 30, 40, 90]) {
			for (const columns of [60, 61, 100, 200]) {
				const lane = laneSetup({ rows });
				lane.show(laneRun());
				const drawn = lane.component().render(columns);
				const text = plain(drawn);
				expect(drawn).toHaveLength(heightFor(rows));
				expect(drawn.every(row => visibleWidth(row) <= columns)).toBe(true);
				expect(text[0]).toStartWith(STORM_MARK);
				expect(text[0]).not.toMatch(RADAR_ROW);
				expect(text[0]!.includes("[")).toBe(false);
				// The trunk and at least one lane have something on them; nothing below the picture is invented.
				expect(text[1]!.trim()).not.toBe("");
				expect(text[2]!.trim()).not.toBe("");
				lane.live.clear();
			}
		}
	});

	test("row 0 is today's status line: mark, phase and the same chips", () => {
		const lane = laneSetup();
		lane.show(RUN);
		expect(plain(lane.component().render(120))[0]).toBe(`${liveHeader("working")} · ${COUNTERS}`);
		// At the contract's smallest width the chips shrink exactly as they do in the single line.
		const narrow = plain(lane.component().render(60))[0]!;
		expect(visibleWidth(narrow)).toBeLessThanOrEqual(60);
		expect(narrow).toStartWith(STORM_MARK);
	});

	test("the boundary values: 18 rows and 60 columns are lane mode, one less is the single line", () => {
		const check = (rows: number, columns: number): readonly string[] => {
			const lane = laneSetup({ rows });
			lane.show(laneRun());
			const drawn = lane.component().render(columns);
			lane.live.clear();
			return drawn;
		};
		expect(check(18, 60)).toHaveLength(6);
		expect(check(17, 60).length).toBeLessThanOrEqual(2);
		expect(check(18, 59).length).toBeLessThanOrEqual(2);
		// The constants the widget exports are the same numbers.
		expect([LANE_MIN_ROWS, frameModule.LANE_MIN_COLUMNS]).toEqual([18, 60]);
	});

	test("a short or narrow terminal, the ASCII preset or an unknown height keeps the single line with its radar, exactly", () => {
		const lineOf = (host: WidgetHost, columns: number, phase: RunPhase = "working"): readonly string[] => {
			const live = liveForTest();
			live.show(host.ctx, RUN, phase);
			return host.widgets.get(LIVE_WIDGET_KEY)!.render(columns);
		};
		const laneOf = (host: WidgetHost, columns: number): readonly string[] => {
			const live = new LiveStatus({ now: () => NOW });
			activeWidgets.push(live);
			live.show(host.ctx, RUN, "working");
			return host.widgets.get(LIVE_WIDGET_KEY)!.render(columns);
		};
		const sameAsLine = (rows: number, columns: number): void => {
			const lineHost = widgetHost(rows);
			const laneHost = widgetHost(rows);
			const expected = lineOf(lineHost, columns);
			const actual = laneOf(laneHost, columns);
			expect(actual).toEqual(expected);
			expect(actual.length).toBeLessThanOrEqual(2);
		};
		sameAsLine(17, 120);
		sameAsLine(10, 120);
		sameAsLine(40, 59);
		sameAsLine(40, 52);
		sameAsLine(40, 30);
		// A host that cannot say how tall the terminal is gets the line too.
		const unknown = widgetHost();
		(unknown as unknown as { terminal: { rows: number | undefined } }).terminal.rows = undefined;
		expect(laneOf(unknown, 120).length).toBeLessThanOrEqual(2);
		expect(plain(laneOf(unknown, 120))[0]).toMatch(RADAR_ROW);

		expect(setNativeSymbolPreset("ascii")).toBe(true);
		sameAsLine(40, 120);
		expect(plain(laneOf(widgetHost(40), 120))[0]).toStartWith(ASCII_MARK);
	});

	test("native rendering keeps describing the line and runs no timer", () => {
		vi.useFakeTimers();
		setNativeRendering(true);
		const lane = laneSetup();
		lane.show(RUN);
		const node = lane.component().describe?.(describeContext);
		expect(node).not.toBeNull();
		expect(flatText(node!)).toContain(RUN_APPEARANCE.working.label);
		expect(vi.getTimerCount()).toBe(0);
		// A host that still calls render keeps the single line.
		expect(lane.component().render(120).length).toBeLessThanOrEqual(2);
		expect(vi.getTimerCount()).toBe(0);
	});

	test("the height is fixed for the run: resizing, narrowing, the preset or the switch never change the row count", () => {
		vi.useFakeTimers();
		let on = true;
		const lane = laneSetup({ rows: 40, switch: () => on });
		lane.show(laneRun());
		const counts = new Set<number>();
		const draw = (columns: number): readonly string[] => {
			const rows = lane.component().render(columns);
			counts.add(rows.length);
			expect(rows.every(row => visibleWidth(row) <= columns)).toBe(true);
			return rows;
		};
		expect(draw(120)).toHaveLength(12);
		// Shorter window, still tall enough: the picture, the same 12 rows.
		lane.host.terminal.rows = 24;
		expect(plain(draw(120))[1]!.trim()).not.toBe("");
		// Too short for lane mode: the single line at the top of the same 12 rows, the rest blank.
		lane.host.terminal.rows = 12;
		const short = draw(120);
		expect(plain(short)[0]).toMatch(RADAR_ROW);
		expect(plain(short)[1]).toStartWith("›");
		expect(blank(short.slice(2))).toBe(true);
		lane.host.terminal.rows = 40;
		// Narrow: the compact line, padded.
		const narrow = draw(50);
		expect(plain(narrow)[0]).toStartWith(STORM_MARK);
		expect(blank(narrow.slice(1))).toBe(true);
		draw(0);
		expect(draw(0).every(row => row === "")).toBe(true);
		// The switch off mid-run, then on again.
		on = false;
		lane.show(laneRun());
		const off = draw(120);
		expect(plain(off)[0]).toMatch(RADAR_ROW);
		expect(blank(off.slice(2))).toBe(true);
		on = true;
		lane.show(laneRun());
		expect(plain(draw(120))[0]).not.toMatch(RADAR_ROW);
		// The ASCII preset mid-run: the line without braille, the height unchanged.
		expect(setNativeSymbolPreset("ascii")).toBe(true);
		lane.host.ui.theme = activeTheme;
		const ascii = draw(120);
		expect(plain(ascii)[0]).toStartWith(ASCII_MARK);
		expect(plain(ascii).join("\n")).not.toMatch(/[⠁-⣿]/);
		expect(blank(ascii.slice(2))).toBe(true);
		setNativeSymbolPreset(undefined);
		lane.host.ui.theme = activeTheme;
		draw(100);
		expect([...counts]).toEqual([12]);
	});

	test("a run that starts in the single line decides its height once, the first time the view fits", () => {
		const lane = laneSetup({ rows: 40 });
		lane.show(laneRun());
		const narrow = lane.component().render(50);
		expect(narrow.length).toBeLessThanOrEqual(2);
		const wide = lane.component().render(120);
		expect(wide).toHaveLength(12);
		expect(lane.component().render(50)).toHaveLength(12);
		lane.host.terminal.rows = 90;
		expect(lane.component().render(120)).toHaveLength(12);
	});

	test("one row of the picture is never wider than the terminal, with wide characters, in both colour modes", () => {
		for (const columns of [60, 63, 80, 117]) {
			const lane = laneSetup({ rows: 60 });
			lane.show(laneRun());
			const rows = lane.component().render(columns);
			expect(rows).toHaveLength(12);
			expect(rows.every(row => visibleWidth(row) <= columns)).toBe(true);
			lane.live.clear();
		}
	});

	test("the animation ticks at 85 ms, 120 ms over SSH, and about four frames a second while it only breathes", () => {
		vi.useFakeTimers();
		delete process.env.SSH_CONNECTION;
		delete process.env.SSH_TTY;
		const ticks = (phase: RunPhase, ms: number, env?: string): number => {
			if (env !== undefined) process.env[env] = "1";
			const lane = laneSetup();
			lane.show(laneRun(), phase);
			if (phase === "waiting-user") lane.clock.now += SETTLE_MS;
			lane.component().render(120);
			expect(vi.getTimerCount()).toBe(1);
			const before = lane.host.requests.length;
			vi.advanceTimersByTime(ms);
			const seen = lane.host.requests.length - before;
			lane.live.clear();
			expect(vi.getTimerCount()).toBe(0);
			if (env !== undefined) delete process.env[env];
			return seen;
		};
		expect(ticks("working", 1_020)).toBe(12);
		expect(ticks("working", 1_020, "SSH_CONNECTION")).toBe(8);
		expect(ticks("working", 1_020, "SSH_TTY")).toBe(8);
		const slow = ticks("waiting-user", 1_000);
		expect(slow).toBeGreaterThanOrEqual(3);
		expect(slow).toBeLessThanOrEqual(5);
	});

	test("a picture that does not move has no timer; an update that makes it lively starts one, and never a second", () => {
		vi.useFakeTimers();
		const lane = laneSetup();
		lane.show(settledRun(), "between-rounds");
		lane.component().render(120);
		expect(vi.getTimerCount()).toBe(0);
		const quiet = lane.host.requests.length;
		vi.advanceTimersByTime(5_000);
		expect(lane.host.requests.length).toBe(quiet);

		lane.show(laneRun(), "working");
		expect(vi.getTimerCount()).toBe(1);
		lane.component().render(120);
		lane.show(laneRun({ turns: 2 }), "working");
		lane.component().render(120);
		expect(vi.getTimerCount()).toBe(1);

		// Waiting for the user slows it down but keeps the one timer.
		lane.show(laneRun(), "waiting-user");
		// The events of the moment before the wait play out at full pace first.
		expect(vi.getTimerCount()).toBe(1);
		lane.clock.now += SETTLE_MS;
		lane.component().render(120);
		expect(vi.getTimerCount()).toBe(1);
		const slowFrom = lane.host.requests.length;
		vi.advanceTimersByTime(1_000);
		expect(lane.host.requests.length - slowFrom).toBeLessThanOrEqual(6);

		// And back to the full pace.
		lane.show(laneRun(), "working");
		lane.component().render(120);
		const fullFrom = lane.host.requests.length;
		vi.advanceTimersByTime(1_000);
		expect(lane.host.requests.length - fullFrom).toBeGreaterThanOrEqual(10);

		lane.show(settledRun(), "between-rounds");
		expect(vi.getTimerCount()).toBe(1);
		lane.clock.now += SETTLE_MS;
		lane.component().render(120);
		expect(vi.getTimerCount()).toBe(0);
		const stopped = lane.host.requests.length;
		vi.advanceTimersByTime(5_000);
		expect(lane.host.requests.length).toBe(stopped);
	});

	test("with motion off there is no timer and the picture is still, with its colours", () => {
		vi.useFakeTimers();
		setMotionEffects(false);
		const lane = laneSetup();
		lane.show(laneRun());
		const first = lane.component().render(120);
		expect(vi.getTimerCount()).toBe(0);
		const requests = lane.host.requests.length;
		vi.advanceTimersByTime(5_000);
		expect(lane.host.requests.length).toBe(requests);
		expect(lane.component().render(120)).toEqual(first);
		expect(first.some(row => row.includes("\x1b["))).toBe(true);
		expect(vi.getTimerCount()).toBe(0);

		// Motion back on: the timer comes back without another update.
		setMotionEffects(true);
		expect(vi.getTimerCount()).toBe(1);
		setMotionEffects(false);
		expect(vi.getTimerCount()).toBe(0);
	});

	test("no timer survives dispose, a replaced host, the end of the run or a switch to the single line's still phases", () => {
		vi.useFakeTimers();
		const lane = laneSetup();
		lane.show(laneRun());
		const first = lane.component();
		first.render(120);
		expect(vi.getTimerCount()).toBe(1);
		first.dispose?.();
		expect(vi.getTimerCount()).toBe(0);
		expect(first.render(120)).toEqual([]);
		const requests = lane.host.requests.length;
		vi.advanceTimersByTime(2_000);
		expect(lane.host.requests.length).toBe(requests);

		// The host removed the widget: the next show installs a fresh one, with one timer.
		lane.show(laneRun());
		const second = lane.component();
		expect(second).not.toBe(first);
		second.render(120);
		expect(vi.getTimerCount()).toBe(1);

		const replacement = widgetHost();
		lane.live.show(replacement.ctx, laneRun(), "working");
		expect(vi.getTimerCount()).toBe(0);
		const third = replacement.widgets.get(LIVE_WIDGET_KEY)!;
		third.render(120);
		expect(vi.getTimerCount()).toBe(1);
		const before = lane.host.requests.length + replacement.requests.length;
		lane.live.clear();
		expect(vi.getTimerCount()).toBe(0);
		vi.advanceTimersByTime(2_000);
		expect(lane.host.requests.length + replacement.requests.length).toBe(before);
		expect(replacement.widgets.size).toBe(0);
	});

	test("animation time continues where it stopped when the timer restarts; it never jumps by the idle gap", () => {
		vi.useFakeTimers();
		const lane = laneSetup();
		const times: number[] = [];
		const spy = spyOn(frameModule, "laneFrame").mockImplementation((snapshot, cols, t, options) => {
			times.push(t);
			return realLaneFrame(snapshot, cols, t, options);
		});
		try {
			lane.show(laneRun());
			const component = lane.component();
			component.render(120);
			for (const step of [85, 85, 85]) {
				lane.clock.now += step;
				vi.advanceTimersByTime(step);
				component.render(120);
			}
			const reached = times.at(-1)!;
			expect(times[0]).toBe(0);
			expect(reached).toBe(255);

			// Everything settles: a still picture, no timer, the clock runs on for ten minutes.
			lane.show(settledRun(), "between-rounds");
			lane.clock.now += SETTLE_MS;
			component.render(120);
			expect(vi.getTimerCount()).toBe(0);
			expect(times.at(-1)).toBe(reached);
			lane.clock.now += 600_000;
			component.render(120);
			lane.show(laneRun({}, lane.clock.now), "working");
			expect(vi.getTimerCount()).toBe(1);
			times.length = 0;
			component.render(120);
			expect(times.at(-1)).toBe(reached);
			lane.clock.now += 85;
			vi.advanceTimersByTime(85);
			component.render(120);
			expect(times.at(-1)).toBe(reached + 85);
		} finally {
			spy.mockRestore();
		}
	});

	test("a stalled event loop moves the animation by a bounded step, not by the whole stall", () => {
		vi.useFakeTimers();
		const lane = laneSetup();
		const times: number[] = [];
		const spy = spyOn(frameModule, "laneFrame").mockImplementation((snapshot, cols, t, options) => {
			times.push(t);
			return realLaneFrame(snapshot, cols, t, options);
		});
		try {
			lane.show(laneRun());
			lane.component().render(120);
			lane.clock.now += 30_000;
			lane.component().render(120);
			expect(times.at(-1)!).toBeLessThanOrEqual(1_000);
		} finally {
			spy.mockRestore();
		}
	});

	test("the switch changes the drawing at once, in both directions, and repaints", () => {
		vi.useFakeTimers();
		let on = true;
		const lane = laneSetup({ switch: () => on });
		lane.show(laneRun());
		expect(plain(lane.component().render(120))[0]).not.toMatch(RADAR_ROW);
		const requests = lane.host.requests.length;

		on = false;
		lane.show(laneRun());
		expect(lane.host.requests.length).toBeGreaterThan(requests);
		const line = lane.component().render(120);
		expect(plain(line)[0]).toStartWith(liveHeader("working"));
		expect(plain(line)[0]).toMatch(RADAR_ROW);
		expect(line).toHaveLength(12);
		expect(vi.getTimerCount()).toBe(1);

		on = true;
		lane.show(laneRun());
		const again = lane.component().render(120);
		expect(plain(again)[0]).not.toMatch(RADAR_ROW);
		expect(plain(again)[1]!.trim()).not.toBe("");
		expect(vi.getTimerCount()).toBe(1);
	});

	test("turning the view on mid-run draws the lanes from what the timeline recorded, as if it had been on all along", () => {
		setMotionEffects(false);
		/** The record at a moment: both workers run, then `Api` settles and `Ui` keeps going. */
		const recordAt = (moment: number): RunRecord => {
			const run = laneRun({}, moment);
			if (moment === NOW) return run;
			return { ...run, agents: (run.agents ?? []).map(agent => (agent.id === "Api" ? { ...agent, state: "idle" } : agent)) };
		};
		const play = (on: () => boolean, turnOn: () => void): readonly string[] => {
			const lane = laneSetup({ switch: on });
			lane.show(recordAt(NOW));
			lane.component().render(120);
			lane.clock.now = NOW + 40_000;
			lane.show(recordAt(lane.clock.now));
			lane.clock.now = NOW + 80_000;
			turnOn();
			lane.show(recordAt(lane.clock.now));
			return lane.component().render(120);
		};
		let late = false;
		const mid = play(() => late, () => {
			late = true;
		});
		const always = play(() => true, () => undefined);
		expect(mid).toHaveLength(12);
		expect(plain(mid).join("\n")).toContain("Api");
		expect(mid).toEqual(always);
	});

	test("a new run gets a new timeline: nothing of the earlier run's history reaches its picture", () => {
		setMotionEffects(false);
		const second = (): RunRecord =>
			laneRun({
				runId: "run-second",
				startedAt: iso(NOW - 10_000),
				plan: { submittedAt: iso(NOW - 9_000), workers: { implementer: 1 }, lanes: [{ name: "Zed", kind: "code", role: "implementer" }] },
				agents: [agentEntry({ id: "Zed", state: "running", startedAt: NOW - 5_000, lastActivityAt: NOW - 500 })],
				spawns: [spawnRecord({ spawnKey: "Zed", lane: "Zed" })],
			});
		const reused = laneSetup();
		reused.show(laneRun());
		reused.component().render(120);
		reused.clock.now += 20_000;
		reused.show(second());
		const fresh = laneSetup();
		fresh.clock.now = reused.clock.now;
		fresh.show(second());
		const rows = reused.component().render(120);
		expect(plain(rows).join("\n")).toContain("Zed");
		expect(plain(rows).join("\n")).not.toContain("Api");
		expect(rows).toEqual(fresh.component().render(120));
	});
});
