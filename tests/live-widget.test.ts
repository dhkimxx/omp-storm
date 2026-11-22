/**
 * The live run widget's lifecycle: one below-editor component per run, a phase header that alone may shimmer,
 * static counters from the same formatter as `runStatusText`, a terminal-clocked Tern description, and no timer
 * after a still phase, the run ends, the host replaces it or the session switches. A fake host renders the
 * component the way omp's TUI does; no real terminal is needed.
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
	setShimmerMode,
	theme as activeTheme,
	type TUI,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import { RUN_APPEARANCE, STORM_MARK, type RunPhase } from "../src/view/appearance.ts";
import { LIVE_WIDGET_KEY, LiveStatus } from "../src/view/live.ts";
import { runStatusCounters } from "../src/view/render.ts";
import type { RunRecord } from "../src/types.ts";
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
const COUNTERS = "1/4라운드 · 서브에이전트 2(실행 중 1) · $0.1200/$5.00 · 3분";

type Widget = Component & { dispose?(): void };
type WidgetFactory = (tui: TUI) => Widget;

interface WidgetHost {
	ctx: ExtensionContext;
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
		installs,
		statuses,
		widgets,
		requests,
	};
}

function plain(rows: readonly string[]): string[] {
	return rows.map(row => Bun.stripANSI(row));
}

function nodeText(node: NativeNode): string {
	// Test-only read of TSP's published text/shimmer prop shape.
	const props = node.p as { text?: string; spans?: readonly { t: string }[] } | undefined;
	return props?.text ?? (props?.spans ?? []).map(part => part.t).join("");
}

/** The described (non-component) children of a node, in sibling order. */
function children(node: NativeNode): NativeNode[] {
	const out: NativeNode[] = [];
	for (const child of node.c ?? []) if ("k" in child) out.push(child);
	return out;
}

const liveHeader = (phase: RunPhase): string => `${STORM_MARK} · ${RUN_APPEARANCE[phase].label}`;
const fullLine = (phase: RunPhase = "working", run: RunRecord = RUN, now = NOW): string => `${liveHeader(phase)} · ${runStatusCounters(run, now)}`;

const describeContext = {
	cols: 100,
	reduceMotion: false,
	dark: true,
	supports: (kind: string) => kind === "shimmer",
} as unknown as DescribeContext;

afterEach(() => {
	vi.useRealTimers();
	setMotionEffects(true);
	setShimmerMode("classic");
	setNativeRendering(false);
});

describe("the live run widget", () => {
	test("one row: the wind marker and working state, then static counters; width clips the numbers first", () => {
		const host = widgetHost();
		const live = new LiveStatus({ now: () => NOW });
		expect(live.show(host.ctx, RUN)).toBe(true);
		expect(host.installs).toEqual([{ key: LIVE_WIDGET_KEY, placement: "belowEditor" }]);
		// The run's label moved into the widget; the footer is never a second, shimmering live status.
		expect(host.statuses).toEqual([undefined]);

		const component = host.widgets.get(LIVE_WIDGET_KEY)!;
		expect(plain(component.render(220))).toEqual([fullLine()]);
		expect(component.render(0)).toEqual([]);

		const header = liveHeader("working");
		const headerWidth = visibleWidth(header);
		for (const width of [120, 80, 60, 40, 30, 20, headerWidth + 2, headerWidth + 1, headerWidth]) {
			const rows = component.render(width);
			expect(rows).toHaveLength(1);
			expect(visibleWidth(rows[0]!)).toBeLessThanOrEqual(width);
			expect(plain(rows)[0]!.startsWith(header)).toBe(true);
		}
		// The header survives; the expendable numbers take the ellipsis.
		const clippedTail = plain(component.render(40))[0]!;
		expect(clippedTail).not.toBe(fullLine());
		expect(clippedTail).toEndWith("…");

		// Below the header's own width there is nothing else to protect, so the header truncates last.
		for (const width of [headerWidth - 1, Math.max(1, headerWidth - 5), 1]) {
			const rows = component.render(width);
			expect(rows).toHaveLength(1);
			expect(visibleWidth(rows[0]!)).toBeLessThanOrEqual(width);
			expect(plain(rows)[0]!).toEndWith("…");
		}
		// A resize back to a wide host must repaint the full line, not reuse a narrow cached row.
		expect(plain(component.render(220))).toEqual([fullLine()]);
		live.clear();
	});

	test("a still phase stops the one timer immediately and snaps to still; resuming and ending leave no extra", () => {
		vi.useFakeTimers();
		const host = widgetHost();
		const live = new LiveStatus({ now: () => NOW });
		live.show(host.ctx, RUN);
		const component = host.widgets.get(LIVE_WIDGET_KEY)!;
		expect(vi.getTimerCount()).toBe(0);
		expect(plain(component.render(120))).toEqual([fullLine("working")]);
		expect(vi.getTimerCount()).toBe(1);
		const ticking = host.requests.length;
		vi.advanceTimersByTime(100);
		expect(host.requests.length).toBeGreaterThan(ticking);

		// The counters stay put within a phase: only the one header span moves.
		const frozen = plain(component.render(120))[0]!;
		vi.advanceTimersByTime(2_000);
		expect(plain(component.render(120))[0]!).toBe(frozen);

		for (const phase of ["waiting-user", "between-rounds", "stopping"] as const) {
			live.show(host.ctx, RUN, phase);
			expect(vi.getTimerCount()).toBe(0);
			const requests = host.requests.length;
			vi.advanceTimersByTime(1_000);
			expect(host.requests.length).toBe(requests);
			expect(plain(component.render(120))).toEqual([fullLine(phase)]);
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

	test("Tern shimmers only the active header and stills it for reduced motion, capability or either switch", () => {
		vi.useFakeTimers();
		const host = widgetHost();
		const live = new LiveStatus({ now: () => NOW });
		live.show(host.ctx, RUN);
		const component = host.widgets.get(LIVE_WIDGET_KEY)!;
		component.render(120);
		expect(vi.getTimerCount()).toBe(1);

		const described = component.describe!(describeContext)!;
		expect(described.k).toBe("row");
		const [shimmerHeader, tail] = children(described);
		expect(shimmerHeader!.k).toBe("shimmer");
		expect(nodeText(shimmerHeader!)).toBe(liveHeader("working"));
		expect(nodeText(tail!)).toBe(` · ${COUNTERS}`);
		// Only the header is shimmer; the phase's numbers remain a static tail.
		// The node kind is checked above, so this reads TSP's published shimmer props.
		const shimmerProps = shimmerHeader!.p as {
			spans?: readonly { t: string; s?: string }[];
			palette?: { low?: string; mid?: string; high?: string };
		};
		expect(shimmerProps.spans).toEqual([{ t: liveHeader("working"), s: "borderAccent" }]);
		expect(shimmerProps.palette).toEqual({ low: "dim", mid: "borderAccent", high: "mdLink" });
		for (const tier of Object.values(shimmerProps.palette ?? {})) {
			expect(tier).not.toMatch(/^#[0-9a-f]{3,8}$/i);
			expect(isValidThemeColor(tier)).toBe(true);
		}
		// Tern clocks the sheen itself: describing stopped the ANSI interval.
		expect(vi.getTimerCount()).toBe(0);

		const reduced = component.describe!({ ...describeContext, reduceMotion: true })!;
		const reducedHeader = children(reduced)[0]!;
		expect(reducedHeader.k).toBe("text");
		expect(nodeText(reducedHeader)).toBe(liveHeader("working"));

		const unsupported = component.describe!({ ...describeContext, supports: () => false })!;
		expect(children(unsupported)[0]!.k).toBe("text");

		setShimmerMode("disabled");
		const disabled = component.describe!(describeContext)!;
		expect(children(disabled)[0]!.k).toBe("text");
		component.render(120);
		expect(vi.getTimerCount()).toBe(0);

		setShimmerMode("classic");
		setMotionEffects(false);
		const motionOff = component.describe!(describeContext)!;
		expect(children(motionOff)[0]!.k).toBe("text");
		component.render(120);
		expect(vi.getTimerCount()).toBe(0);

		// OMP's switches being on does not make a waiting phase move.
		setMotionEffects(true);
		live.show(host.ctx, RUN, "waiting-user");
		const waiting = component.describe!(describeContext)!;
		const waitingHeader = children(waiting)[0]!;
		expect(waitingHeader.k).toBe("text");
		// The kind is checked above, so this reads TSP's published text props.
		const waitingProps = waitingHeader.p as { spans?: readonly { t: string; s?: string }[] };
		const waitingSpans = waitingProps.spans ?? [];
		expect(waitingSpans.map(part => part.s)).toEqual(["accent", "warning"]);
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
		const native = component.describe!(describeContext)!;
		expect(children(native)[0]!.k).toBe("shimmer");
		expect(vi.getTimerCount()).toBe(0);

		setNativeRendering(false);
		expect(vi.getTimerCount()).toBe(1);
		component.render(120);
		expect(vi.getTimerCount()).toBe(1);
		live.clear();
		expect(vi.getTimerCount()).toBe(0);
	});

	test("a live update reuses the component and redraws the new phase, round and spend", () => {
		vi.useFakeTimers();
		const host = widgetHost();
		const live = new LiveStatus({ now: () => NOW });
		live.show(host.ctx, RUN);
		const component = host.widgets.get(LIVE_WIDGET_KEY)!;
		component.render(120);
		const installs = host.installs.length;
		expect(vi.getTimerCount()).toBe(1);

		const next = { ...RUN, turns: 1, costUsd: 0.2 };
		expect(live.show(host.ctx, next, "verifying")).toBe(true);
		expect(host.installs).toHaveLength(installs);
		expect(vi.getTimerCount()).toBe(1);
		const line = plain(component.render(220))[0]!;
		expect(line).toBe(fullLine("verifying", next));
		expect(line).toContain("2/4라운드");
		expect(line).toContain("$0.2000/$5.00");
		expect(host.statuses).toEqual([undefined]);

		live.clear();
	});

	test("dispose or a replaced host stops the old component; the next show installs a fresh one", () => {
		vi.useFakeTimers();
		const host = widgetHost();
		const live = new LiveStatus({ now: () => NOW });
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
		expect(plain(third.render(120))).toEqual([fullLine("waiting-user")]);

		live.clear();
		expect(vi.getTimerCount()).toBe(0);
		expect(replacement.widgets.size).toBe(0);
	});

	test("only the main TUI gets a widget; RPC keeps the plain path and a switch invalidates old work", () => {
		const host = widgetHost();
		const live = new LiveStatus({ now: () => NOW });
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

	test("every phase names its state and only the three active phases carry motion", () => {
		const active: RunPhase[] = ["working", "workers", "verifying"];
		const still: RunPhase[] = ["waiting-user", "between-rounds", "stopping"];
		for (const phase of active) {
			expect(RUN_APPEARANCE[phase].motion).toBe(true);
			expect(liveHeader(phase)).toBe(`${STORM_MARK} · ${RUN_APPEARANCE[phase].label}`);
		}
		for (const phase of still) {
			expect(RUN_APPEARANCE[phase].motion).toBe(false);
			expect(liveHeader(phase)).toBe(`${STORM_MARK} · ${RUN_APPEARANCE[phase].label}`);
		}
	});
});
