import { describe, expect, test } from "bun:test";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import { PLAIN_THEME } from "@oh-my-pi/pi-tui/theme/plain";
import { toModelInfo } from "../src/discovery/models.ts";
import {
	AUTO_STEP,
	EMPTY_CATALOG_TEXT,
	filterEntries,
	NO_MATCH_TEXT,
	OFF_STEP,
	pickStormModel,
	refusalText,
} from "../src/ui/model-picker.ts";
import type { Effort, StormModelPick } from "../src/types.ts";
import { type OverlayView, mountOverlay } from "./tui-host.ts";

/** A catalog row as omp hands it to the registry, with a real effort ladder so the level slider is live. */
const chatModel = (provider: string, id: string, efforts: readonly string[], extra: Record<string, unknown> = {}) => ({
	provider,
	id,
	name: `${id} display`,
	kind: "chat",
	reasoning: efforts.length > 0,
	input: ["text"],
	contextWindow: 200_000,
	...(efforts.length > 0 ? { thinking: { efforts, defaultLevel: efforts[0] } } : {}),
	supportsTools: true,
	cost: { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 1 },
	identity: { class: id.split("-")[0] },
	int: 50,
	tps: 70,
	...extra,
});

const INSIDE = chatModel("example", "inside", ["low", "medium", "high"]);
const OUTSIDE = chatModel("example", "outside", ["minimal", "low", "high"]);
const WIDE = chatModel("example", "wide", ["low", "medium", "high", "xhigh"]);
const FROZEN = chatModel("example", "frozen", []);
const WILD = chatModel("example", "wild", ["low", "turbo"]);
const OTHER = chatModel("other", "elsewhere", ["low", "high"]);

interface Opened {
	view: OverlayView<StormModelPick | undefined>;
	/** The options `ctx.ui.custom` was called with. */
	options: unknown;
	/** The picker node (the overlay's only view). */
	picker: ReturnType<OverlayView<unknown>["root"]["children"]>[number];
}

/** Opens `pickStormModel` on the test terminal over a registry that offers `models`. */
async function open(
	models: ReadonlyArray<Record<string, unknown>>,
	current?: { selector: string; effort?: Effort },
	view: { columns?: number; rows?: number; registryError?: unknown } = {},
): Promise<Opened> {
	let factory: Parameters<ExtensionContext["ui"]["custom"]>[0] | undefined;
	let options: unknown;
	const ctx = {
		modelRegistry: {
			getError: () => view.registryError,
			getAvailable: (kind: string) => models.filter(model => model.kind === kind),
		},
		ui: {
			custom: (make: Parameters<ExtensionContext["ui"]["custom"]>[0], opts: unknown) => {
				factory = make;
				options = opts;
				return new Promise(() => {});
			},
		},
	} as unknown as ExtensionContext;
	void pickStormModel(ctx, "탐색 · 주 모델", current);
	if (factory === undefined) throw new Error("the picker did not open a view");
	const mounted = await mountOverlay<StormModelPick | undefined>(factory as never, {
		columns: view.columns ?? 100,
		rows: view.rows ?? 30,
		theme: "plain",
	});
	// The overlay's root holds the picker as its one child.
	return { view: mounted, options, picker: mounted.root.children()[0]! };
}

const selectors = (screen: string): string[] => [...screen.matchAll(/\b(?:example|other)\/[a-z-]+/g)].map(match => match[0]);

/** What the host's picker node carries (a native host draws exactly this). */
const props = (opened: Opened) => opened.picker.props() as Record<string, unknown> & {
	order: string[];
	selected: string | null;
	level: { value: string; steps: Array<{ id: string }>; disabled?: unknown } | null;
	scopes?: Array<{ id: string; count: number }>;
	scope: string;
	query: string;
	items: Array<{ id: string }>;
};

describe("model picker", () => {
	test("opens as an overlay over the available tool-capable chat models; Enter picks one bare, Esc cancels", async () => {
		const models = [OUTSIDE, { ...OUTSIDE, id: "no-tools", name: "No tools", supportsTools: false }, { ...OUTSIDE, id: "embed", kind: "embedding" }];
		const picked = await open(models);
		expect(picked.options).toEqual({ overlay: true });
		expect(selectors(picked.view.text())).toEqual(["example/outside"]);
		expect(picked.view.text()).toContain("탐색 · 주 모델");
		picked.view.press("enter");
		const result = await picked.view.result;
		expect(result).toMatchObject({ model: expect.objectContaining({ selector: "example/outside", efforts: ["minimal", "low", "high"] }) });
		expect(result).not.toHaveProperty("effort");
		picked.view.dispose();

		const cancelled = await open(models);
		cancelled.view.press("escape");
		expect(await cancelled.view.result).toBeUndefined();
		expect(cancelled.view.closed()).toBe(true);
		cancelled.view.dispose();
	});

	test("duplicate selectors are offered once", async () => {
		const opened = await open([INSIDE, { ...INSIDE }]);
		expect(props(opened).order).toEqual(["example/inside"]);
		opened.view.dispose();
	});

	describe("search", () => {
		test("typing filters the list live, best match first, and the highlight follows", async () => {
			const opened = await open([INSIDE, OUTSIDE, WIDE, OTHER]);
			expect(props(opened).order).toEqual(["example/inside", "example/outside", "example/wide", "other/elsewhere"]);
			opened.view.type("out");
			expect(props(opened).query).toBe("out");
			expect(props(opened).order).toEqual(["example/outside"]);
			expect(props(opened).selected).toBe("example/outside");
			expect(selectors(opened.view.text())).toEqual(["example/outside"]);
			opened.view.press("backspace");
			expect(props(opened).query).toBe("ou");
			// "ou" is in the middle of outside, and a subsequence of nothing else.
			expect(props(opened).order).toEqual(["example/outside"]);
			opened.view.press("ctrl+u");
			expect(props(opened).query).toBe("");
			expect(props(opened).order).toHaveLength(4);
			opened.view.dispose();
		});

		test("a token matches the provider, the id or the display name; every token has to match", async () => {
			const opened = await open([INSIDE, OUTSIDE, WIDE, OTHER]);
			opened.view.type("other");
			expect(props(opened).order).toEqual(["other/elsewhere"]);
			opened.view.press("ctrl+u");
			opened.view.type("example wide");
			expect(props(opened).order).toEqual(["example/wide"]);
			opened.view.press("ctrl+u");
			// A subsequence of the selector still finds the model when no substring does.
			opened.view.type("exmplwd");
			expect(props(opened).order).toEqual(["example/wide"]);
			opened.view.dispose();
		});

		test("a segment start ranks above a match in the middle", () => {
			const entries = [chatModel("p", "xopus-1", []), chatModel("p", "opus-2", [])].map(model => ({
				info: toModelInfo(model, true)!,
				ladder: [],
			}));
			expect(filterEntries(entries, "opus").map(match => match.entry.info.id)).toEqual(["opus-2", "xopus-1"]);
			// The matched characters of the label are reported for the host to mark.
			expect(filterEntries(entries, "opus")[0]!.hits).toEqual([[2, 6]]);
		});

		test("no match says so and Enter on an empty list does nothing", async () => {
			const opened = await open([INSIDE]);
			opened.view.type("zzzz");
			expect(props(opened).order).toEqual([]);
			expect(opened.view.text()).toContain(NO_MATCH_TEXT);
			opened.view.press("enter");
			expect(opened.view.closed()).toBe(false);
			opened.view.press("escape");
			expect(await opened.view.result).toBeUndefined();
			opened.view.dispose();
		});

		test("the caret moves through the text: backspace and delete work at it, words jump", async () => {
			const opened = await open([INSIDE]);
			const query = () => props(opened).query;
			const caret = () => props(opened).cursor;
			opened.view.type("alpha beta");
			expect(caret()).toBe(10);
			opened.view.press("alt+left");
			expect(caret()).toBe(6);
			opened.view.press("ctrl+left");
			expect(caret()).toBe(0);
			opened.view.press("alt+right");
			expect(caret()).toBe(5);
			opened.view.press("delete");
			expect(query()).toBe("alphabeta");
			opened.view.press("backspace");
			expect(query()).toBe("alphbeta");
			expect(caret()).toBe(4);
			opened.view.press("ctrl+e");
			opened.view.type(" zed");
			opened.view.press("ctrl+w");
			expect(query()).toBe("alphbeta ");
			opened.view.press("ctrl+a");
			opened.view.type("x");
			expect(query()).toBe("xalphbeta ");
			opened.view.dispose();
		});

		test("a paste lands in the query as one line; Korean text and wide characters are kept", async () => {
			const opened = await open([INSIDE]);
			opened.view.paste("ins\nide");
			expect(props(opened).query).toBe("ins ide");
			opened.view.press("ctrl+u");
			opened.view.type("모델");
			expect(props(opened).query).toBe("모델");
			opened.view.press("backspace");
			expect(props(opened).query).toBe("모");
			opened.view.dispose();
		});

		test("the query shows in the sheet with the matched characters of the row marked", async () => {
			const opened = await open([INSIDE, OUTSIDE]);
			opened.view.type("sid");
			expect(opened.view.text()).toContain("> sid");
			expect(props(opened).hits).toEqual({ "example/inside": [[10, 13]], "example/outside": [[11, 14]] });
			opened.view.dispose();
		});
	});

	describe("provider scopes", () => {
		test("Tab steps through the providers and back to all; the list keeps to the active one", async () => {
			const opened = await open([INSIDE, OUTSIDE, OTHER]);
			expect(props(opened).scopes?.map(scope => [scope.id, scope.count])).toEqual([
				["provider:example", 2],
				["provider:other", 1],
			]);
			expect(props(opened).scope).toBe("all");
			opened.view.press("tab");
			expect(props(opened).scope).toBe("provider:example");
			expect(props(opened).order).toEqual(["example/inside", "example/outside"]);
			opened.view.press("tab");
			expect(props(opened).scope).toBe("provider:other");
			expect(props(opened).order).toEqual(["other/elsewhere"]);
			// The highlight moved with the list: it left the old scope.
			expect(props(opened).selected).toBe("other/elsewhere");
			opened.view.press("tab");
			expect(props(opened).scope).toBe("all");
			opened.view.press("shift+tab");
			expect(props(opened).scope).toBe("provider:other");
			opened.view.dispose();
		});

		test("a scope and a query narrow together; the provider chips show in the sheet", async () => {
			const opened = await open([INSIDE, OUTSIDE, OTHER]);
			expect(opened.view.text()).toContain("example");
			expect(opened.view.text()).toContain("other");
			opened.view.press("tab");
			opened.view.type("i");
			// "inside" starts a segment on the match, "outside" has it in the middle.
			expect(props(opened).order).toEqual(["example/inside", "example/outside"]);
			opened.view.dispose();
		});

		test("one provider offers no scopes; a native scope action picks one and the active one again goes back to all", async () => {
			const single = await open([INSIDE, OUTSIDE]);
			expect(props(single).scopes).toBeUndefined();
			single.view.press("tab");
			expect(props(single).scope).toBe("all");
			single.view.dispose();

			const opened = await open([INSIDE, OTHER]);
			const act = (value: string) => opened.picker.handlers.onAction?.("scope", { type: "action", key: "", act: "scope", value, mods: [] });
			act("provider:other");
			expect(props(opened).scope).toBe("provider:other");
			act("provider:other");
			expect(props(opened).scope).toBe("all");
			// An id nobody offers is ignored.
			act("provider:ghost");
			expect(props(opened).scope).toBe("all");
			opened.view.dispose();
		});

		test("a long provider row keeps the active chip in view and every row within the width", async () => {
			const many = Array.from({ length: 12 }, (_, index) => chatModel(`provider-number-${index}`, `m${index}`, ["low"]));
			const opened = await open(many, undefined, { columns: 60 });
			for (let step = 0; step < 9; step++) opened.view.press("tab");
			expect(props(opened).scope).toBe("provider:provider-number-6");
			expect(opened.view.text()).toContain("provider-number-6");
			for (const row of opened.view.screen()) expect(visibleWidth(row)).toBeLessThanOrEqual(60);
			opened.view.dispose();
		});
	});

	describe("effort level", () => {
		test("opens on the slot's model and its effort; ←/→ step the level, which the sheet shows", async () => {
			const opened = await open([WIDE, OUTSIDE, FROZEN], { selector: "example/wide", effort: "xhigh" }, { columns: 60 });
			expect(props(opened).selected).toBe("example/wide");
			expect(props(opened).current).toEqual(["example/wide"]);
			expect(props(opened).level).toMatchObject({ value: "xhigh", steps: [{ id: "auto" }, { id: "off" }, { id: "low" }, { id: "medium" }, { id: "high" }, { id: "xhigh" }] });
			expect(opened.view.text()).toContain("thinking XHigh");
			for (const row of opened.view.screen()) expect(visibleWidth(row)).toBeLessThanOrEqual(60);
			opened.view.press("left");
			expect(opened.view.text()).toContain("thinking High");
			expect(props(opened).level?.value).toBe("high");
			opened.view.press("right");
			opened.view.press("enter");
			expect(await opened.view.result).toMatchObject({ model: expect.objectContaining({ selector: "example/wide" }), effort: "xhigh" });
			opened.view.dispose();
		});

		test("steps to a supported effort on the same model and picks both in one overlay", async () => {
			const opened = await open([INSIDE, OUTSIDE], { selector: "example/inside", effort: "high" });
			opened.view.press("left");
			expect(opened.view.text()).toContain("thinking Med");
			opened.view.press("enter");
			expect(await opened.view.result).toMatchObject({ model: expect.objectContaining({ selector: "example/inside" }), effort: "medium" });
			opened.view.dispose();
		});

		test("a fresh pick follows Auto, Off (refused), Low, Med, High without leaving the overlay", async () => {
			const opened = await open([INSIDE]);
			expect(opened.view.text()).toContain("thinking Auto");
			opened.view.press("right");
			expect(opened.view.text()).toContain("thinking Off");
			opened.view.press("enter");
			expect(opened.view.closed()).toBe(false);
			expect(opened.view.text()).toContain(refusalText(OFF_STEP, ["low", "medium", "high"]));
			// Any key makes the refusal moot.
			opened.view.press("right");
			expect(opened.view.text()).not.toContain(refusalText(OFF_STEP, ["low", "medium", "high"]));
			expect(opened.view.text()).toContain("thinking Low");
			opened.view.press("right");
			opened.view.press("right");
			expect(opened.view.text()).toContain("thinking High");
			opened.view.press("enter");
			expect(await opened.view.result).toMatchObject({ effort: "high" });
			opened.view.dispose();
		});

		test("Off and a ladder entry Storm has no name for keep the picker open with the supported efforts listed", async () => {
			const off = await open([INSIDE], { selector: "example/inside", effort: "high" });
			for (let step = 0; step < 3; step++) off.view.press("left");
			expect(props(off).level?.value).toBe(OFF_STEP);
			off.view.press("enter");
			expect(off.view.closed()).toBe(false);
			expect(off.view.text()).toContain(refusalText(OFF_STEP, ["low", "medium", "high"]));
			// The slider stays where it was while the reason shows.
			expect(props(off).level?.value).toBe(OFF_STEP);
			expect(props(off).subtitle).toEqual([expect.objectContaining({ t: refusalText(OFF_STEP, ["low", "medium", "high"]) })]);
			off.view.press("right");
			off.view.press("enter");
			expect(await off.view.result).toMatchObject({ effort: "low" });
			off.view.dispose();

			const unknown = await open([WILD], { selector: "example/wild", effort: "low" });
			expect(props(unknown).level?.steps.map(step => step.id)).toEqual(["auto", "off", "low", "turbo"]);
			unknown.view.press("right");
			expect(unknown.view.text()).toContain("thinking Turbo");
			unknown.view.press("enter");
			expect(unknown.view.closed()).toBe(false);
			expect(unknown.view.text()).toContain(refusalText("turbo", ["low"]));
			unknown.view.press("left");
			unknown.view.press("enter");
			expect(await unknown.view.result).toMatchObject({ effort: "low" });
			unknown.view.dispose();
		});

		test("Auto means the model default: shown as such and stored as a bare pick", async () => {
			const opened = await open([INSIDE], { selector: "example/inside", effort: "high" });
			// High, Medium, Low, Off, Auto.
			for (let step = 0; step < 4; step++) opened.view.press("left");
			expect(props(opened).level?.value).toBe(AUTO_STEP);
			expect(opened.view.text()).toContain("thinking Auto");
			opened.view.press("enter");
			const result = await opened.view.result;
			expect(result).toMatchObject({ model: expect.objectContaining({ selector: "example/inside" }) });
			expect(result).not.toHaveProperty("effort");
			opened.view.dispose();
		});

		test("an untouched pick on the same model keeps its effort, or stays bare, or drops one the model no longer has", async () => {
			const keep = async (current: { selector: string; effort?: Effort }) => {
				const opened = await open([INSIDE, OUTSIDE], current);
				opened.view.press("enter");
				const result = await opened.view.result;
				opened.view.dispose();
				return result;
			};
			expect(await keep({ selector: "example/inside", effort: "high" })).toMatchObject({ model: expect.objectContaining({ selector: "example/inside" }), effort: "high" });
			expect(await keep({ selector: "example/inside" })).not.toHaveProperty("effort");
			// An effort the slot's model no longer supports is not carried silently; the model default shows instead.
			const stale = await open([INSIDE], { selector: "example/inside", effort: "max" });
			expect(props(stale).level?.value).toBe(AUTO_STEP);
			stale.view.press("enter");
			expect(await stale.view.result).not.toHaveProperty("effort");
			stale.view.dispose();
		});

		test("an untouched new model starts at its own default, not at the slot's effort", async () => {
			const opened = await open([INSIDE, OUTSIDE], { selector: "example/inside", effort: "high" });
			opened.view.type("outside");
			expect(props(opened).level?.value).toBe(AUTO_STEP);
			expect(opened.view.text()).toContain("thinking Auto");
			opened.view.press("enter");
			const result = await opened.view.result;
			expect(result).toMatchObject({ model: expect.objectContaining({ selector: "example/outside" }) });
			expect(result).not.toHaveProperty("effort");
			opened.view.dispose();
		});

		test("a carried step lands on the new model's nearest supported effort", async () => {
			const opened = await open([INSIDE, OUTSIDE], { selector: "example/inside", effort: "high" });
			// High to Medium on the slot's ladder, then a model whose ladder has no medium.
			opened.view.press("left");
			opened.view.type("outside");
			expect(props(opened).level?.value).toBe("low");
			expect(opened.view.text()).toContain("thinking Low");
			opened.view.press("enter");
			expect(await opened.view.result).toMatchObject({ model: expect.objectContaining({ selector: "example/outside" }), effort: "low" });
			opened.view.dispose();
		});

		test("a model with no effort control freezes the level, keeps ←/→ harmless and picks bare", async () => {
			const opened = await open([INSIDE, FROZEN], { selector: "example/inside", effort: "high" });
			opened.view.press("left");
			opened.view.type("frozen");
			expect(props(opened).level?.disabled).toBeTruthy();
			expect(opened.view.text()).toContain("no thinking");
			opened.view.press("right");
			opened.view.press("enter");
			const result = await opened.view.result;
			expect(result).toMatchObject({ model: expect.objectContaining({ selector: "example/frozen", efforts: [] }) });
			expect(result).not.toHaveProperty("effort");
			opened.view.dispose();
		});

		test("a native level action sets the step; a step the model lacks or a frozen level is ignored", async () => {
			const opened = await open([INSIDE, FROZEN], { selector: "example/inside", effort: "high" });
			const act = (value: string) => opened.picker.handlers.onAction?.("level", { type: "action", key: "", act: "level", value, mods: [] });
			act("low");
			expect(props(opened).level?.value).toBe("low");
			act("xhigh");
			expect(props(opened).level?.value).toBe("low");
			opened.view.type("frozen");
			act("low");
			expect(props(opened).level?.disabled).toBeTruthy();
			opened.view.dispose();
		});

		test("cancelling after moving the slider applies nothing", async () => {
			const opened = await open([INSIDE, OUTSIDE], { selector: "example/inside", effort: "high" });
			opened.view.press("left");
			expect(opened.view.text()).toContain("thinking Med");
			opened.view.press("escape");
			expect(await opened.view.result).toBeUndefined();
			opened.view.dispose();
		});
	});

	describe("list and keys", () => {
		test("↑/↓ move the highlight, Enter picks it, a native close action cancels", async () => {
			const opened = await open([INSIDE, OUTSIDE, WIDE]);
			expect(props(opened).selected).toBe("example/inside");
			opened.view.press("down");
			opened.view.press("down");
			expect(props(opened).selected).toBe("example/wide");
			opened.view.press("up");
			expect(props(opened).selected).toBe("example/outside");
			opened.view.press("enter");
			expect(await opened.view.result).toMatchObject({ model: expect.objectContaining({ selector: "example/outside" }) });
			opened.view.dispose();

			const closing = await open([INSIDE]);
			closing.picker.handlers.onAction?.("close", { type: "action", key: "", act: "close", mods: [] });
			expect(await closing.view.result).toBeUndefined();
			closing.view.dispose();
		});

		test("Ctrl+C cancels", async () => {
			const opened = await open([INSIDE]);
			opened.view.press("ctrl+c");
			expect(await opened.view.result).toBeUndefined();
			opened.view.dispose();
		});

		test("a long catalog scrolls within the rows the terminal leaves and every row fits the width", async () => {
			const many = Array.from({ length: 60 }, (_, index) => chatModel("example", `model-${String(index).padStart(2, "0")}`, ["low", "high"]));
			const opened = await open(many, undefined, { columns: 60, rows: 24 });
			for (let step = 0; step < 30; step++) opened.view.press("down");
			expect(props(opened).selected).toBe("example/model-30");
			expect(opened.view.text()).toContain("example/model-30");
			expect(opened.view.screen().length).toBeLessThanOrEqual(24);
			for (const row of opened.view.screen()) expect(visibleWidth(row)).toBeLessThanOrEqual(60);
			opened.view.dispose();
		});

		test("the sheet lists its keys in the hint row at 60 columns", async () => {
			const opened = await open([INSIDE, OTHER], undefined, { columns: 60 });
			const text = opened.view.text();
			expect(text).toContain("↑/↓");
			expect(text).toContain("⏎");
			expect(text).toContain("⇥");
			expect(text).toContain("←/→");
			expect(text).toContain("⎋");
			opened.view.dispose();
		});
	});

	describe("empty and failing catalogs", () => {
		test("an empty catalog still draws and Esc cancels without a pick", async () => {
			const opened = await open([], { selector: "example/inside", effort: "high" }, { columns: 60 });
			expect(opened.view.text()).toContain(EMPTY_CATALOG_TEXT);
			expect(props(opened).level).toBeNull();
			opened.view.press("enter");
			expect(opened.view.closed()).toBe(false);
			opened.view.press("escape");
			expect(await opened.view.result).toBeUndefined();
			opened.view.dispose();
		});

		test("a registry that reports an error shows it on the sheet", async () => {
			const opened = await open([INSIDE], undefined, { registryError: new Error("catalog broke") });
			expect(opened.view.text()).toContain("catalog broke");
			expect(opened.view.text()).toContain("example/inside");
			opened.view.dispose();
		});

		test("a registry that throws is an empty catalog", async () => {
			let factory: Parameters<ExtensionContext["ui"]["custom"]>[0] | undefined;
			const ctx = {
				modelRegistry: {
					getError: () => undefined,
					getAvailable: () => {
						throw new Error("boom");
					},
				},
				ui: { custom: (make: typeof factory) => ((factory = make), new Promise(() => {})) },
			} as unknown as ExtensionContext;
			void pickStormModel(ctx, "탐색 · 주 모델");
			const view = await mountOverlay<StormModelPick | undefined>(factory as never, { theme: "plain" });
			expect(view.text()).toContain(EMPTY_CATALOG_TEXT);
			view.dispose();
		});
	});

	describe("what a native host receives", () => {
		test("the picker carries data, not rows: items once, order for the filter, selection and the level", async () => {
			const opened = await open([INSIDE, OTHER], { selector: "example/inside", effort: "high" });
			const node = props(opened);
			expect(node.items.map(item => item.id)).toEqual(["example/inside", "other/elsewhere"]);
			expect(node.total).toBe(2);
			opened.view.type("elsew");
			// Typing never rebuilds the catalogue; it narrows `order`.
			expect(props(opened).items.map(item => item.id)).toEqual(["example/inside", "other/elsewhere"]);
			expect(props(opened).order).toEqual(["other/elsewhere"]);
			expect(props(opened).level).toMatchObject({ value: "auto", detail: "other", keys: ["left", "right"] });
			expect(props(opened).actions).toEqual(expect.arrayContaining([expect.objectContaining({ id: "close", keys: ["esc"] })]));
			opened.view.dispose();
		});

		test("it draws in a native host too, and a native select/activate event moves and picks", async () => {
			let factory: Parameters<ExtensionContext["ui"]["custom"]>[0] | undefined;
			const ctx = {
				modelRegistry: { getError: () => undefined, getAvailable: () => [INSIDE, OUTSIDE] },
				ui: { custom: (make: typeof factory) => ((factory = make), new Promise(() => {})) },
			} as unknown as ExtensionContext;
			void pickStormModel(ctx, "탐색 · 주 모델", { selector: "example/inside", effort: "high" });
			const view = await mountOverlay<StormModelPick | undefined>(factory as never, { native: true, theme: PLAIN_THEME });
			const picker = view.root.children()[0]!;
			picker.handlers.onSelect?.("example/outside", { type: "select", key: "", item: "example/outside" });
			expect((picker.props() as { selected: string }).selected).toBe("example/outside");
			// A select of an id the list does not hold is ignored.
			picker.handlers.onSelect?.("example/ghost", { type: "select", key: "", item: "example/ghost" });
			expect((picker.props() as { selected: string }).selected).toBe("example/outside");
			picker.handlers.onActivate?.("example/outside", { type: "activate", key: "", item: "example/outside" });
			expect(await view.result).toMatchObject({ model: expect.objectContaining({ selector: "example/outside" }) });
			view.dispose();
		});
	});
});
