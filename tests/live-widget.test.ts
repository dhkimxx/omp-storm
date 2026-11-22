/**
 * The live run widget's lifecycle: one below-editor component per run, static counters from `runStatusText`, a
 * terminal-clocked Tern description, and no timer after the run ends, the host replaces it or the session switches.
 * A fake host renders the component the way omp's TUI does; no real terminal is needed.
 */
import { afterEach, describe, expect, test, vi } from "bun:test";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
	type Component,
	type DescribeContext,
	ensureThemeSync,
	type NativeNode,
	setMotionEffects,
	setNativeRendering,
	setShimmerMode,
	theme as activeTheme,
	type TUI,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import { LIVE_LABEL, LIVE_WIDGET_KEY, LiveStatus, liveCounters } from "../src/view/live.ts";
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
	const props = node.p as { text?: string; spans?: readonly { t: string }[] } | undefined;
	return props?.text ?? (props?.spans ?? []).map(part => part.t).join("");
}

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
	test("one below-editor line: a short label, then runStatusText's counters; a narrow host gets an ellipsis", () => {
		const host = widgetHost();
		const live = new LiveStatus({ now: () => NOW });
		expect(live.show(host.ctx, RUN)).toBe(true);
		expect(host.installs).toEqual([{ key: LIVE_WIDGET_KEY, placement: "belowEditor" }]);
		// The live status text moved into the widget, so no duplicate remains on the status row.
		expect(host.statuses).toEqual([undefined]);

		const component = host.widgets.get(LIVE_WIDGET_KEY);
		expect(component).toBeDefined();
		expect(plain(component!.render(200))).toEqual([`${LIVE_LABEL} · ${COUNTERS}`]);

		const narrow = component!.render(12);
		expect(narrow).toHaveLength(1);
		expect(visibleWidth(narrow[0]!)).toBeLessThanOrEqual(12);
		expect(Bun.stripANSI(narrow[0]!)).toEndWith("…");
		live.clear();
	});

	test("a live update reuses the component; ending the run clears it once and stops its repaint timer", () => {
		vi.useFakeTimers();
		const host = widgetHost();
		const live = new LiveStatus({ now: () => NOW });
		live.show(host.ctx, RUN);
		const component = host.widgets.get(LIVE_WIDGET_KEY)!;
		component.render(100);
		const installs = host.installs.length;
		const beforeTicks = host.requests.length;
		vi.advanceTimersByTime(100);
		expect(host.requests.length).toBeGreaterThan(beforeTicks);

		expect(live.show(host.ctx, { ...RUN, turns: 1, costUsd: 0.2 })).toBe(true);
		expect(host.installs).toHaveLength(installs);
		const line = plain(component.render(100))[0]!;
		expect(line).toContain("2/4라운드");
		expect(line).toContain("$0.2000/$5.00");

		live.clear();
		expect(host.widgets.size).toBe(0);
		expect(host.statuses).toEqual([undefined]);
		const atEnd = host.requests.length;
		vi.advanceTimersByTime(1000);
		expect(host.requests.length).toBe(atEnd);
	});

	test("Tern describes only the label as shimmer; motion off gives plain text and no ANSI timer", () => {
		const host = widgetHost();
		const live = new LiveStatus({ now: () => NOW });
		live.show(host.ctx, RUN);
		const component = host.widgets.get(LIVE_WIDGET_KEY)!;
		const described = component.describe!(describeContext)!;
		expect(described.k).toBe("row");
		const [label, tail] = described.c ?? [];
		const labelNode = label as NativeNode | undefined;
		const tailNode = tail as NativeNode | undefined;
		expect(labelNode?.k).toBe("shimmer");
		expect(nodeText(labelNode!)).toBe(LIVE_LABEL);
		expect(nodeText(tailNode!)).toBe(` · ${liveCounters(RUN, NOW)}`);

		// The terminal's own reduced-motion preference stills the sheen even when OMP's switches are on.
		const reduced = component.describe!({ ...describeContext, reduceMotion: true })!;
		const [reducedLabel] = reduced.c ?? [];
		const reducedNode = reducedLabel as NativeNode | undefined;
		expect(reducedNode?.k).toBe("text");

		vi.useFakeTimers();
		setMotionEffects(false);
		const still = component.describe!(describeContext)!;
		const [stillLabel] = still.c ?? [];
		const stillNode = stillLabel as NativeNode | undefined;
		expect(stillNode?.k).toBe("text");
		const stillProps = stillNode?.p as { spans?: readonly { s?: string }[] } | undefined;
		expect(stillProps?.spans?.[0]?.s).toBe("muted");
		const before = host.requests.length;
		component.render(100);
		vi.advanceTimersByTime(500);
		expect(host.requests.length).toBe(before);
		live.clear();
	});

	test("a native surface or a host replacement stops the timer; the next update installs a fresh component", () => {
		vi.useFakeTimers();
		const host = widgetHost();
		const live = new LiveStatus({ now: () => NOW });
		live.show(host.ctx, RUN);
		const first = host.widgets.get(LIVE_WIDGET_KEY)!;
		first.render(100);
		vi.advanceTimersByTime(100);

		// Tern clocks the sheen itself: the ANSI timer must go quiet while the native surface is live.
		setNativeRendering(true);
		const native = host.requests.length;
		vi.advanceTimersByTime(500);
		expect(host.requests.length).toBe(native);
		setNativeRendering(false);
		vi.advanceTimersByTime(100);
		expect(host.requests.length).toBeGreaterThan(native);

		// The host removed the widget: the next live record must install again, not update a dead component.
		first.dispose?.();
		live.show(host.ctx, { ...RUN, turns: 1 });
		expect(host.installs).toHaveLength(2);
		const second = host.widgets.get(LIVE_WIDGET_KEY)!;
		expect(second).not.toBe(first);
		second.render(100);
		const afterInstall = host.requests.length;
		vi.advanceTimersByTime(100);
		expect(host.requests.length).toBeGreaterThan(afterInstall);
		live.clear();
	});

	test("only the main TUI gets a widget; RPC keeps the plain status path, and a switch invalidates old work", () => {
		const host = widgetHost();
		const live = new LiveStatus({ now: () => NOW });
		expect(live.show({ ...host.ctx, mode: "rpc" } as ExtensionContext, RUN)).toBe(false);
		expect(host.installs).toHaveLength(0);
		expect(host.statuses).toEqual([]);

		expect(live.show(host.ctx, RUN)).toBe(true);
		const epoch = live.epoch();
		const next = live.beginSession();
		expect(next).not.toBe(epoch);
		expect(live.isCurrent(epoch)).toBe(false);
		expect(live.isCurrent(next)).toBe(true);
		expect(host.widgets.size).toBe(0);
	});
});
