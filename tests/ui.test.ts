import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { type Component, stripTerminalSequences, theme, visibleWidth } from "@oh-my-pi/pi-tui";
import { defaultFormData } from "@oh-my-pi/pi-tui/html-form/data";
import { type HtmlForm, parseHtmlForm } from "@oh-my-pi/pi-tui/html-form/parse";
import type { NativeNode } from "@oh-my-pi/pi-tui/native/node";
import { ModelPickerComponent } from "@oh-my-pi/pi-tui/overlays/model-picker";
import { ensureThemeSync, getSymbolPresetOverride, setSymbolPreset } from "@oh-my-pi/pi-tui/theme/theme";
import { readAutoDelegation } from "../src/approval/auto.ts";
import { configHash } from "../src/config/canonical.ts";
import { configPath, serializeConfig } from "../src/config/store.ts";
import { approveAndSave, type FlowEnv, hubFlow, resetFlow, setupFlow } from "../src/flows.ts";
import { APPROVE } from "../src/proposals/present.ts";
import { ROLES } from "../src/roles.ts";
import { STORM_MARK } from "../src/view/appearance.ts";
import { RichFrame } from "../src/view/info.ts";
import { FIELD } from "../src/setup/form.ts";
import { loadProjectState } from "../src/state.ts";
import type { InfoLine, UiContext, UiPort } from "../src/types.ts";
import { createUiPort, registerReportRenderer } from "../src/ui.ts";
import { renderCloseout } from "../src/view/closeout.ts";
import { renderStatus } from "../src/view/render.ts";
import { makeProject, TEAM, type TestProject } from "./support.ts";

// Storm's frames are omp components; they draw with omp's theme.
ensureThemeSync();

const PICK_BY_ROLE = "역할별로 고르기";

interface FormAnswer {
	data: Record<string, string | number | string[]>;
	timedOut?: boolean;
}

interface FakeHost {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	/** Options of every selector omp was asked to open, with the panel rows above it at that moment. */
	selects: Array<{ options: string[]; panel: readonly string[] | undefined; panelNative: NativeNode | null | undefined }>;
	/** omp's own notifications. */
	notified: string[];
	/** Messages put in the transcript. */
	sent: Array<{ message: { content?: unknown; display?: boolean; excludeFromContext?: boolean }; options: { triggerTurn?: boolean } | undefined }>;
	/** Overlays opened (each is closed at once). */
	overlays: number;
	/** Whether a panel widget is still set. */
	panelSet(): boolean;
}

/** The describe inputs our components read; the terminal-specific fields are inert here. */
function describeContext(cols: number) {
	return { cols, dark: true, reduceMotion: true, supports: () => true, feature: () => false };
}

/** Visit visible native nodes, following component children through their own describe. */
function walkNative(node: NativeNode, visit: (node: NativeNode) => void): void {
	if (node.p?.hidden) return;
	visit(node);
	for (const child of node.c ?? []) {
		if ("k" in child) walkNative(child, visit);
		else {
			const described = child.describe?.(describeContext(80));
			if (described) walkNative(described, visit);
		}
	}
}

function nativeSpans(root: NativeNode | null | undefined): Array<{ t: string; s: string | undefined }> {
	const out: Array<{ t: string; s: string | undefined }> = [];
	if (!root) return out;
	walkNative(root, node => {
		if (node.k === "text") for (const run of node.p?.spans ?? []) out.push({ t: run.t, s: run.s });
	});
	return out;
}

function nativeTexts(root: NativeNode | null | undefined): string[] {
	const out: string[] = [];
	if (!root) return out;
	walkNative(root, node => {
		if (node.k === "text" && node.p?.text !== undefined) out.push(node.p.text);
		if (node.k === "md" && node.p?.text !== undefined) out.push(node.p.text);
	});
	for (const run of nativeSpans(root)) out.push(run.t);
	return out;
}

function nativeMds(root: NativeNode | null | undefined): string[] {
	const out: string[] = [];
	if (!root) return out;
	walkNative(root, node => {
		if (node.k === "md" && node.p?.text !== undefined) out.push(node.p.text);
	});
	return out;
}

function nativeProgress(root: NativeNode | null | undefined): Array<{ value: number | null; tone: string | undefined }> {
	const out: Array<{ value: number | null; tone: string | undefined }> = [];
	if (!root) return out;
	walkNative(root, node => {
		if (node.k === "progress") out.push({ value: node.p?.value ?? null, tone: node.p?.tone });
	});
	return out;
}

/**
 * The parts of omp's extension API and context `createUiPort` touches. `answers` are given to selectors in order; a
 * function gets the offered options. `formDialog: undefined` is a host without a form surface.
 */
function fakeHost(opts: {
	mode: ExtensionContext["mode"];
	hasUI: boolean;
	rows?: number;
	columns?: number;
	answers?: Array<string | undefined | ((options: string[]) => string | undefined)>;
	formDialog?: (html: string) => Promise<FormAnswer | undefined>;
	models?: Array<Record<string, unknown>>;
	driveOverlay?: (view: Component, rows: readonly string[]) => void;
}): FakeHost {
	const answers = [...(opts.answers ?? [])];
	const tui = { terminal: { rows: opts.rows ?? 50, columns: opts.columns ?? 100 }, requestRender() {} };
	let widget: Component | undefined;
	const host: FakeHost = {
		selects: [],
		notified: [],
		sent: [],
		overlays: 0,
		panelSet: () => widget !== undefined,
		pi: {
			sendMessage(message: FakeHost["sent"][number]["message"], options?: { triggerTurn?: boolean }) {
				host.sent.push({ message, options });
			},
		} as unknown as ExtensionAPI,
		ctx: {
			mode: opts.mode,
			hasUI: opts.hasUI,
			modelRegistry: {
				getError: () => undefined,
				getAvailable: (kind: string) => opts.models?.filter(model => model.kind === kind) ?? [],
			},
			ui: {
				async select(_title: string, options: string[]) {
					const panel = widget?.render(tui.terminal.columns);
					const panelNative = widget?.describe?.(describeContext(tui.terminal.columns));
					host.selects.push({ options: [...options], panel, panelNative });
					if (!answers.length) throw new Error("no scripted answer");
					const answer = answers.shift();
					return typeof answer === "function" ? answer(options) : answer;
				},
				notify(message: string) {
					host.notified.push(message);
				},
				setWidget(_key: string, factory: ((t: typeof tui) => Component) | undefined) {
					widget = factory?.(tui);
				},
				async custom<T>(factory: (t: typeof tui, theme: unknown, keys: unknown, done: (result: T) => void) => Component): Promise<T> {
					host.overlays++;
					const { promise, resolve } = Promise.withResolvers<T>();
					const view = factory(tui, undefined, undefined, resolve);
					const rows = view.render(tui.terminal.columns);
					if (opts.driveOverlay) opts.driveOverlay(view, rows);
					else view.handleInput?.("q");
					return promise;
				},
				...(opts.formDialog ? { formDialog: opts.formDialog } : {}),
			},
		} as unknown as ExtensionContext,
	};
	return host;
}

const CONTEXT = { title: "title", markdown: "one\n\ntwo" };
const TALL = { title: "title", markdown: Array.from({ length: 80 }, (_, i) => `- line-${i}`).join("\n") };

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
	/** A catalog row as omp hands it to the registry: real ladders so the native thinking slider is live. */
	const chatModel = (provider: string, id: string, efforts: readonly string[]) => ({
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
	});
	const INSIDE = chatModel("example", "inside", ["low", "medium", "high"]);
	const OUTSIDE = chatModel("example", "outside", ["minimal", "low", "high"]);
	const XHIGH = chatModel("example", "wide", ["low", "medium", "high", "xhigh"]);
	const FROZEN = chatModel("example", "frozen", []);
	const WILD = chatModel("example", "wild", ["low", "turbo"]);

	test("the native picker exposes available chat models without switching the host session", async () => {
		for (const key of ["\r", "\x1b"]) {
			const host = fakeHost({
				mode: "tui",
				hasUI: true,
				models: [OUTSIDE, { ...OUTSIDE, id: "no-tools", name: "No tools", supportsTools: false }],
				driveOverlay(view, rows) {
					expect(view).toBeInstanceOf(ModelPickerComponent);
					const rendered = rows.join("\n");
					expect(rendered).toContain("탐색 · 주 모델");
					expect(rendered).toContain(OUTSIDE.name);
					expect(rendered).not.toContain("No tools");
					view.handleInput?.(key);
				},
			});
			const result = await createUiPort(host.pi, host.ctx).pickModel!("탐색 · 주 모델");
			if (key === "\r") {
				expect(result).toMatchObject({ model: expect.objectContaining({ selector: "example/outside", efforts: ["minimal", "low", "high"] }) });
				expect(result).not.toHaveProperty("effort");
			} else {
				expect(result).toBeUndefined();
			}
			expect(host.overlays).toBe(1);
			expect(host.selects).toEqual([]);
			expect(host.sent).toEqual([]);
		}
	});

	test("opens on the slot's effort first and updates it in place at 60 columns", async () => {
		const host = fakeHost({
			mode: "tui",
			hasUI: true,
			columns: 60,
			models: [XHIGH, OUTSIDE, FROZEN],
			driveOverlay(view, rows) {
				const status = stripTerminalSequences(rows[1] ?? "");
				expect(status).toContain("thinking XHigh · 이 역할에만 · 세션 유지 · Auto=기본값");
				const footer = stripTerminalSequences(rows.at(-2) ?? "");
				expect(footer).toContain("effort");
				expect(footer).toContain("공급자");
				expect(footer).toContain("취소");
				for (const line of rows) expect(visibleWidth(line)).toBeLessThanOrEqual(60);
				// XHigh → High: the selected level is what changes first in the status row.
				view.handleInput?.("\x1b[D");
				expect(stripTerminalSequences(view.render(60)[1] ?? "")).toContain("thinking High · 이 역할에만 · 세션 유지 · Auto=기본값");
				view.handleInput?.("\x1b[C");
				view.handleInput?.("\r");
			},
		});
		const result = await createUiPort(host.pi, host.ctx).pickModel!("탐색 · 주 모델", { selector: "example/wide", effort: "xhigh" });
		expect(result).toMatchObject({ model: expect.objectContaining({ selector: "example/wide" }), effort: "xhigh" });
		expect(host.overlays).toBe(1);
		expect(host.selects).toEqual([]);
	});

	test("the native sheet seeds the slot model and level, and keeps a refusal on screen", async () => {
		const host = fakeHost({
			mode: "tui",
			hasUI: true,
			models: [INSIDE, OUTSIDE],
			driveOverlay(view) {
				const opened = view.describe?.(describeContext(100));
				expect(opened?.k).toBe("picker");
				if (opened?.k !== "picker") return;
				expect(opened.p?.title).toBe("Storm 모델 선택 · 탐색 · 주 모델");
				expect(opened.p?.subtitle).toContain("Auto=기본값");
				expect(opened.p?.level?.value).toBe("high");
				expect(opened.p?.level?.steps.map(step => step.id)).toEqual(["auto", "off", "low", "medium", "high"]);

				// High → Medium → Low → Off: the native sheet stays open with the reason and the alternatives.
				for (let step = 0; step < 3; step++) view.handleInput?.("\x1b[D");
				const offSheet = view.describe?.(describeContext(100));
				expect(offSheet?.k === "picker" ? offSheet.p?.level?.value : undefined).toBe("off");
				view.handleInput?.("\r");
				const refused = view.describe?.(describeContext(100));
				expect(refused?.k === "picker" ? refused.p?.subtitle : undefined).toContain("Off는 Storm effort가 아닙니다");
				expect(refused?.k === "picker" ? refused.p?.subtitle : undefined).toContain("지원: low, medium, high");
				expect(refused?.k === "picker" ? refused.p?.level?.value : undefined).toBe("off");

				// The same sheet closes on a supported step.
				view.handleInput?.("\x1b[C");
				view.handleInput?.("\r");
			},
		});
		const result = await createUiPort(host.pi, host.ctx).pickModel!("탐색 · 주 모델", { selector: "example/inside", effort: "high" });
		expect(result).toMatchObject({ model: expect.objectContaining({ selector: "example/inside" }), effort: "low" });

		// Without picker support the card fallback still says what the keys do and what Auto means.
		const cardHost = fakeHost({
			mode: "tui",
			hasUI: true,
			models: [INSIDE],
			driveOverlay(view) {
				const cx = { ...describeContext(100), supports: () => false };
				const card = view.describe?.(cx);
				expect(card?.k).toBe("card");
				expect(nativeTexts(card).join("\n")).not.toContain("\u001b");
				const shown = stripTerminalSequences(nativeTexts(card).join("\n"));
				expect(shown).toContain("thinking High");
				expect(shown).toContain("Auto=기본값");
				expect(shown).toContain("effort");
				// The card has no level widget, so its status must follow the slider after a step.
				view.handleInput?.("\x1b[D");
				const stepped = view.describe?.(cx);
				expect(stripTerminalSequences(nativeTexts(stepped).join("\n"))).toContain("thinking Med");
				view.handleInput?.("\x1b[C");
				view.handleInput?.("\r");
			},
		});
		expect(await createUiPort(cardHost.pi, cardHost.ctx).pickModel!("탐색 · 주 모델", { selector: "example/inside", effort: "high" })).toMatchObject({
			effort: "high",
		});
	});

	test("a native close action cancels without a pick", async () => {
		const host = fakeHost({
			mode: "tui",
			hasUI: true,
			models: [INSIDE],
			driveOverlay(view) {
				view.handleNativeEvent?.({ type: "action", key: "", act: "close", mods: [] });
			},
		});
		expect(await createUiPort(host.pi, host.ctx).pickModel!("탐색 · 주 모델", { selector: "example/inside", effort: "high" })).toBeUndefined();
		expect(host.sent).toEqual([]);
	});

	test("same model plus untouched keeps its valid effort, or stays bare when it has none", async () => {
		const keep = async (current: { selector: string; effort?: "high" | "max" }) => {
			const host = fakeHost({
				mode: "tui",
				hasUI: true,
				models: [INSIDE, OUTSIDE],
				driveOverlay(view, rows) {
					expect(stripTerminalSequences(rows.join("\n"))).toContain(current.effort === "high" ? "thinking High" : "thinking Auto");
					view.handleInput?.("\r");
				},
			});
			return { host, result: await createUiPort(host.pi, host.ctx).pickModel!("탐색 · 주 모델", current) };
		};
		const withEffort = await keep({ selector: "example/inside", effort: "high" });
		expect(withEffort.result).toMatchObject({ model: expect.objectContaining({ selector: "example/inside" }), effort: "high" });
		const bare = await keep({ selector: "example/inside" });
		expect(bare.result).toMatchObject({ model: expect.objectContaining({ selector: "example/inside" }) });
		expect(bare.result).not.toHaveProperty("effort");
		// An effort the slot's model no longer supports is not carried silently; the model default shows instead.
		const stale = await keep({ selector: "example/inside", effort: "max" });
		expect(stale.result).not.toHaveProperty("effort");
	});

	test("cancelling after moving the slider applies nothing and leaves no session artifact", async () => {
		const host = fakeHost({
			mode: "tui",
			hasUI: true,
			models: [INSIDE, OUTSIDE],
			driveOverlay(view) {
				// High → Medium, then Esc: the pending effort is not a pick and no onKeepThinking path exists.
				view.handleInput?.("\x1b[D");
				expect(stripTerminalSequences(view.render(100).join("\n"))).toContain("thinking Med");
				view.handleInput?.("\x1b");
			},
		});
		expect(await createUiPort(host.pi, host.ctx).pickModel!("탐색 · 주 모델", { selector: "example/inside", effort: "high" })).toBeUndefined();
		expect(host.overlays).toBe(1);
		expect(host.selects).toEqual([]);
		expect(host.sent).toEqual([]);
	});

	test("steps a supported effort on the same model and picks model plus effort in one overlay", async () => {
		const host = fakeHost({
			mode: "tui",
			hasUI: true,
			models: [INSIDE, OUTSIDE],
			driveOverlay(view, rows) {
				// High → Medium on the current slot's own ladder.
				view.handleInput?.("\x1b[D");
				expect(stripTerminalSequences(view.render(100).join("\n"))).toContain("thinking Med");
				expect(rows.length).toBeGreaterThan(0);
				view.handleInput?.("\r");
			},
		});
		const result = await createUiPort(host.pi, host.ctx).pickModel!("탐색 · 주 모델", { selector: "example/inside", effort: "high" });
		expect(result).toMatchObject({ model: expect.objectContaining({ selector: "example/inside" }), effort: "medium" });
		expect(host.overlays).toBe(1);
		expect(host.selects).toEqual([]);
	});

	test("a fresh pick follows Auto → Off (refused) → Low → High without leaving the overlay", async () => {
		const host = fakeHost({
			mode: "tui",
			hasUI: true,
			models: [INSIDE],
			driveOverlay(view, rows) {
				const status = () => stripTerminalSequences(view.render(100)[1] ?? "");
				expect(stripTerminalSequences(rows[1] ?? "")).toContain("thinking Auto");
				view.handleInput?.("\x1b[C");
				expect(status()).toContain("thinking Off");
				view.handleInput?.("\r");
				expect(status()).toContain("Off는 Storm effort가 아닙니다");
				view.handleInput?.("\x1b[C");
				expect(status()).toContain("thinking Low");
				view.handleInput?.("\x1b[C");
				expect(status()).toContain("thinking Med");
				view.handleInput?.("\x1b[C");
				expect(status()).toContain("thinking High");
				view.handleInput?.("\r");
			},
		});
		expect(await createUiPort(host.pi, host.ctx).pickModel!("탐색 · 주 모델")).toMatchObject({
			effort: "high",
		});
	});

	test("an untouched new model starts at its own default instead of the slot's effort", async () => {
		const host = fakeHost({
			mode: "tui",
			hasUI: true,
			models: [INSIDE, OUTSIDE],
			driveOverlay(view) {
				view.handleInput?.("outside");
				const shown = stripTerminalSequences(view.render(100).join("\n"));
				expect(shown).toContain("outside display");
				expect(shown).toContain("thinking Auto");
				expect(shown).not.toContain("thinking High");
				view.handleInput?.("\r");
			},
		});
		const result = await createUiPort(host.pi, host.ctx).pickModel!("탐색 · 주 모델", { selector: "example/inside", effort: "high" });
		expect(result).toMatchObject({ model: expect.objectContaining({ selector: "example/outside" }) });
		expect(result).not.toHaveProperty("effort");
	});

	test("a carried slider step lands on the new model's exact supported effort, not the slot's", async () => {
		const host = fakeHost({
			mode: "tui",
			hasUI: true,
			models: [INSIDE, OUTSIDE],
			driveOverlay(view) {
				// High → Medium on the slot's ladder, then a model whose ladder has no medium.
				view.handleInput?.("\x1b[D");
				view.handleInput?.("outside");
				const shown = stripTerminalSequences(view.render(100).join("\n"));
				expect(shown).toContain("thinking Low");
				expect(shown).not.toContain("thinking Med");
				view.handleInput?.("\r");
			},
		});
		const result = await createUiPort(host.pi, host.ctx).pickModel!("탐색 · 주 모델", { selector: "example/inside", effort: "high" });
		expect(result).toMatchObject({ model: expect.objectContaining({ selector: "example/outside" }), effort: "low" });
	});

	test("Auto means the model default, explained on screen and stored as a bare pick", async () => {
		const host = fakeHost({
			mode: "tui",
			hasUI: true,
			models: [INSIDE],
			driveOverlay(view) {
				// High → Medium → Low → Off → Auto.
				for (let step = 0; step < 4; step++) view.handleInput?.("\x1b[D");
				const shown = stripTerminalSequences(view.render(100).join("\n"));
				expect(shown).toContain("thinking Auto");
				expect(shown).toContain("Auto=기본값");
				view.handleInput?.("\r");
			},
		});
		const result = await createUiPort(host.pi, host.ctx).pickModel!("탐색 · 주 모델", { selector: "example/inside", effort: "high" });
		expect(result).toMatchObject({ model: expect.objectContaining({ selector: "example/inside" }) });
		expect(result).not.toHaveProperty("effort");
	});

	test("Off and an unknown ladder entry keep the picker open with the supported efforts listed", async () => {
		const off = fakeHost({
			mode: "tui",
			hasUI: true,
			models: [INSIDE],
			driveOverlay(view) {
				// High → Medium → Low → Off; Off is not a Storm effort.
				for (let step = 0; step < 3; step++) view.handleInput?.("\x1b[D");
				view.handleInput?.("\r");
				const refused = stripTerminalSequences(view.render(100).join("\n"));
				expect(refused).toContain("Off는 Storm effort가 아닙니다");
				expect(refused).toContain("지원: low, medium, high");
				// Off → Low, then pick the supported effort.
				view.handleInput?.("\x1b[C");
				view.handleInput?.("\r");
			},
		});
		expect(await createUiPort(off.pi, off.ctx).pickModel!("탐색 · 주 모델", { selector: "example/inside", effort: "high" })).toMatchObject({
			effort: "low",
		});

		const unknown = fakeHost({
			mode: "tui",
			hasUI: true,
			models: [WILD],
			driveOverlay(view) {
				// Low → Turbo: the catalog declares it, Storm has no such effort.
				view.handleInput?.("\x1b[C");
				view.handleInput?.("\r");
				const refused = stripTerminalSequences(view.render(100).join("\n"));
				expect(refused).toContain("turbo는 이 모델에서 지원되지 않습니다");
				expect(refused).toContain("지원: low");
				view.handleInput?.("\x1b[D");
				view.handleInput?.("\r");
			},
		});
		expect(await createUiPort(unknown.pi, unknown.ctx).pickModel!("탐색 · 주 모델", { selector: "example/wild", effort: "low" })).toMatchObject({
			effort: "low",
		});
	});

	test("a model with no effort control picks bare and keeps the frozen reason visible", async () => {
		const host = fakeHost({
			mode: "tui",
			hasUI: true,
			models: [INSIDE, FROZEN],
			driveOverlay(view) {
				view.handleInput?.("frozen");
				const shown = stripTerminalSequences(view.render(100).join("\n"));
				expect(shown).toContain("frozen display");
				expect(shown).toContain("no thinking");
				view.handleInput?.("\x1b[C");
				view.handleInput?.("\r");
			},
		});
		const result = await createUiPort(host.pi, host.ctx).pickModel!("탐색 · 주 모델", { selector: "example/inside", effort: "high" });
		expect(result).toMatchObject({ model: expect.objectContaining({ selector: "example/frozen", efforts: [] }) });
		expect(result).not.toHaveProperty("effort");
	});

	test("an empty catalog still draws and Esc cancels without a pick", async () => {
		const host = fakeHost({
			mode: "tui",
			hasUI: true,
			columns: 60,
			models: [],
			driveOverlay(view, rows) {
				expect(stripTerminalSequences(rows.join("\n"))).toContain("No models available");
				view.handleInput?.("\x1b");
			},
		});
		expect(await createUiPort(host.pi, host.ctx).pickModel!("탐색 · 주 모델", { selector: "example/inside", effort: "high" })).toBeUndefined();
		expect(host.sent).toEqual([]);
	});

	test("a choice's context is a panel above the selector that leaves nothing behind", async () => {
		const host = fakeHost({ mode: "tui", hasUI: true, answers: ["b"] });
		const ui = createUiPort(host.pi, host.ctx);
		expect(await ui.select("pick", ["a", "b"], CONTEXT)).toBe("b");
		expect(host.selects).toHaveLength(1);
		expect(host.selects[0]?.options).toEqual(["a", "b"]);
		expect(host.selects[0]?.panel?.join("\n")).toContain("two");
		expect(host.panelSet()).toBe(false);
		expect(host.sent).toEqual([]);
	});

	test("a long report's scrollbar stays in one column as the thumb moves", async () => {
		const lines = Array.from({ length: 50 }, (_, i) => `- 기록 ${i}: ${"비용 ".repeat(i % 6)}`);
		const thumb = theme.bold(theme.fg("accent", "|"));
		const track = theme.fg("dim", "|");
		const host = fakeHost({
			mode: "tui",
			hasUI: true,
			rows: 24,
			driveOverlay(view, top) {
				view.handleInput?.("\x1b[F"); // End
				const bottom = view.render(100);
				for (const frame of [top, bottom]) {
					const rail = frame.slice(0, -1);
					expect(rail.every(row => stripTerminalSequences(row).endsWith("|") && visibleWidth(row) === 100)).toBe(true);
					expect(rail.some(row => row.endsWith(thumb))).toBe(true);
					expect(rail.some(row => row.endsWith(track))).toBe(true);
				}
				expect(top.findIndex(row => row.endsWith(thumb))).toBe(0);
				expect(bottom.findIndex(row => row.endsWith(thumb))).toBeGreaterThan(0);
				expect(stripTerminalSequences(bottom.join("\n"))).toContain("기록 49");
				view.handleInput?.("q");
			},
		});
		await createUiPort(host.pi, host.ctx).report("스크롤 검증", lines.join("\n"), [
			{ index: 0, spans: [{ text: "• 기록 0", tone: "accent" }] },
		]);
	});

	test("real status tabs show and scroll the selected section in both renderers at 60 columns", async () => {
		const info: InfoLine[] = [];
		const markdown = renderStatus(
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
		// The centered overlay occupies 90% of the terminal's 60 columns.
		const width = 54;
		const cx = describeContext(width);
		const host = fakeHost({
			mode: "tui",
			hasUI: true,
			rows: 24,
			columns: width,
			driveOverlay(view, top) {
				const labels = [
					{ id: "overview", label: "1 개요", icon: "status.info" },
					{ id: "team", label: "2 팀", icon: "status.enabled" },
					{ id: "runtime", label: "3 런타임", icon: "status.running" },
					{ id: "storage", label: "4 저장 공간", icon: "context.content" },
				] as const;
				const tabLabel = (id: string): string => {
					const tab = labels.find(tab => tab.id === id)!;
					return `${theme.symbol(tab.icon)}${tab.label}`;
				};
				const tabRow = stripTerminalSequences(top[0]!);
				for (const tab of labels) expect(tabRow).toContain(tabLabel(tab.id));
				expect(stripTerminalSequences(top.at(-1)!)).toContain("←→·Tab");
				const selected = (id: string, shown: string, absent: string) => {
					const rows = view.render(width);
					expect(rows.length).toBeLessThanOrEqual(20);
					expect(rows.every(row => visibleWidth(row) <= width)).toBe(true);
					expect(rows[0]).toContain(theme.bold(theme.bg("selectedBg", theme.fg("text", ` ${tabLabel(id)} `))));
					for (const tab of labels) {
						if (tab.id !== id) expect(rows[0]).toContain(theme.fg("muted", ` ${tabLabel(tab.id)} `));
					}
					const ansi = stripTerminalSequences(rows.join("\n"));
					const tree = view.describe?.(cx);
					expect(tree?.c?.[0]).toMatchObject({ k: "tabs", p: { active: id } });
					const native = nativeTexts(tree).join("\n");
					for (const output of [ansi, native]) {
						expect(output).toContain(shown);
						expect(output).not.toContain(absent);
					}
					return tree;
				};
				const overview = selected("overview", "/storm에서 팀 승인", "팀 설정");
				expect(top.join("\n")).toContain(theme.fg("accent", theme.bold(STORM_MARK)));
				expect(top.join("\n")).toContain(theme.fg("warning", theme.bold("- 다음: ")));
				expect(nativeSpans(overview)).toContainEqual({ t: STORM_MARK, s: "accent strong" });
				expect(nativeSpans(overview)).toContainEqual({ t: "- 다음: ", s: "warning strong" });

				view.handleInput?.("\x1b[C"); // Right
				const team = selected("team", "역할별 모델", "status-provider");
				expect(nativeSpans(team)).toContainEqual({ t: theme.symbol("status.enabled"), s: "accent" });
				expect(nativeSpans(team)).toContainEqual({ t: "팀 설정", s: "customMessageText strong" });
				expect(stripTerminalSequences(view.render(width).join("\n"))).toContain(theme.symbol("status.enabled"));
				view.handleInput?.("\x1b[F"); // End
				const tail = view.render(width);
				expect(stripTerminalSequences(tail.join("\n"))).toContain("필수 검사");
				expect(tail.slice(1, -1).every(row => stripTerminalSequences(row).endsWith("|") && visibleWidth(row) === width)).toBe(true);
				const teamBody = () => view.describe?.(cx)?.c?.find(child => "k" in child && child.key === "body-team");
				expect(teamBody()).toMatchObject({ key: "body-team", p: { max: { h: "18lines" } }, scroll: { by: "end", n: 1 } });

				view.handleInput?.("3");
				const runtime = selected("runtime", "status-provider", "status-store");
				// These runtime slices straddle Storage in the Markdown but share a single tab.
				expect(nativeTexts(runtime)).toContain("하드 예산 상한");
				expect(stripTerminalSequences(view.render(width).join("\n"))).toContain("하드 예산 상한");
				expect(teamBody()).toMatchObject({ key: "body-team", p: { hidden: true }, scroll: { by: "end", n: 1 } });
				view.handleInput?.("\t");
				selected("storage", "status-store", "status-provider");
				view.handleInput?.("\x1b[Z"); // Shift+Tab
				selected("runtime", "status-provider", "status-store");

				view.handleInput?.("2");
				expect(view.render(width)).toEqual(tail);
				expect(teamBody()).toMatchObject({ key: "body-team", scroll: { by: "end", n: 1 } });
				view.handleInput?.("\x1b[H"); // Home
				selected("team", "팀 설정", "status-provider");
				view.handleInput?.("\x1b[D"); // Left
				selected("overview", STORM_MARK, "status-provider");
				view.handleInput?.("4");
				selected("storage", "status-store", "status-provider");
				view.handleNativeEvent?.({ type: "select", key: "tabs", item: "team" });
				selected("team", "팀 설정", "status-provider");
				view.handleInput?.("1");
				selected("overview", STORM_MARK, "status-provider");
				view.handleInput?.("\x1b"); // Esc
			},
		});
		// A different title still produces tabs: only the annotations opt a report in.
		await createUiPort(host.pi, host.ctx).report("프로젝트 진단", markdown, info);
		expect(host.sent).toEqual([]);
	});

	test("the ASCII preset keeps the 60-column tabs icon-led on one row", async () => {
		const previous = getSymbolPresetOverride();
		await setSymbolPreset("ascii");
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
			const width = 54;
			const cx = describeContext(width);
			const host = fakeHost({
				mode: "tui",
				hasUI: true,
				rows: 24,
				columns: width,
				driveOverlay(view, top) {
					const tabs = ["[i]1 개요", "[x]2 팀", "[~]3 런타임", "#4 저장 공간"];
					const row = stripTerminalSequences(top[0]!);
					for (const label of tabs) expect(row).toContain(label);
					expect(stripTerminalSequences(top[1]!)).not.toContain("4 저장 공간");
					expect(visibleWidth(top[0]!)).toBe(width);
					expect(view.describe?.(cx)?.c?.[0]).toMatchObject({
						k: "tabs",
						p: { active: "overview", items: tabs.map(label => ({ label })) },
					});
					view.handleInput?.("2");
					const team = view.describe?.(cx);
					expect(nativeSpans(team)).toContainEqual({ t: "[x]", s: "accent" });
					expect(nativeSpans(team)).toContainEqual({ t: "팀 설정", s: "customMessageText strong" });
					expect(stripTerminalSequences(view.render(width)[0]!)).toContain("[x]2 팀");
					view.handleInput?.("q");
				},
			});
			await createUiPort(host.pi, host.ctx).report("Storm 현황", markdown, info);
			expect(host.sent).toEqual([]);
		} finally {
			await setSymbolPreset(previous ?? "unicode");
		}
	});

	test("a context that does not fit adds one option that opens it whole, then the selector comes back", async () => {
		const host = fakeHost({ mode: "tui", hasUI: true, rows: 30, answers: [options => options.at(-1), "a"] });
		const ui = createUiPort(host.pi, host.ctx);
		expect(await ui.select("pick", ["a", "b"], TALL)).toBe("a");
		expect(host.selects.map(s => s.options.length)).toEqual([3, 3]);
		expect(host.selects[0]?.options.slice(0, 2)).toEqual(["a", "b"]);
		expect(host.overlays).toBe(1);
		// The cut panel fits the rows the selector leaves and shows the head, not the tail.
		const panel = host.selects[0]!.panel!;
		expect(panel.length).toBeLessThanOrEqual(30);
		expect(panel.join("\n")).toContain("line-0");
		expect(panel.join("\n")).not.toContain("line-79");
		expect(host.panelSet()).toBe(false);
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
		expect(host.selects[0]!.options).toEqual([
			"탐색 · 폴백 — b/z · low",
			"탐색 · 주 모델 — a/x · low",
			"탐색 · 폴백 — b/z · low (2)",
		]);
		expect(host.sent).toHaveLength(1);
		expect(String(host.sent[0]!.message.content)).toContain("two");
		expect(host.panelSet()).toBe(false);
	});

	test("the TUI rows overlay chooses by value and Esc cancels", async () => {
		for (const key of ["\r", "\x1b"]) {
			const host = fakeHost({
				mode: "tui",
				hasUI: true,
				rows: 24,
				driveOverlay(view, lines) {
					const text = stripTerminalSequences(lines.join("\n"));
					expect(text).toContain("a/x · low");
					expect(text).toContain("b/z · low");
					view.handleInput?.(key);
				},
			});
			const ui = createUiPort(host.pi, host.ctx);
			expect(await ui.selectRows?.("고르기", ROWS)).toBe(key === "\r" ? "explorer:1" : undefined);
			expect(host.sent).toEqual([]);
		}
	});

	test("a narrow terminal wraps the focused row's complete detail instead of dropping it", async () => {
		const host = fakeHost({
			mode: "tui",
			hasUI: true,
			rows: 16,
			columns: 30,
			driveOverlay(view, lines) {
				const text = stripTerminalSequences(lines.join("\n"));
				expect(text).toContain("example/");
				expect(text).toContain("xhigh");
				view.handleInput?.("\x1b");
			},
		});
		const ui = createUiPort(host.pi, host.ctx);
		const rows = [{ value: "explorer:0", label: "탐색 · 주 모델", description: "example/very-long-model · xhigh" }];
		expect(await ui.selectRows?.("고르기", rows)).toBeUndefined();
	});

	test("a compact context sits once above the same rows", async () => {
		const host = fakeHost({
			mode: "tui",
			hasUI: true,
			rows: 30,
			driveOverlay(view, lines) {
				const text = stripTerminalSequences(lines.join("\n"));
				expect(text).toContain("two");
				expect(text).toContain("a/x · low");
				view.handleInput?.("\x1b");
			},
		});
		const ui = createUiPort(host.pi, host.ctx);
		expect(await ui.selectRows?.("고르기", ROWS, CONTEXT)).toBeUndefined();
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

	test("ANSI and native show the same visible content with theme tones and a static meter", async () => {
		let rendered = "";
		let native: NativeNode | null | undefined;
		const host = fakeHost({
			mode: "tui",
			hasUI: true,
			rows: 40,
			driveOverlay(view, rows) {
				rendered = rows.join("\n");
				native = view.describe?.(describeContext(100));
				expect(native?.c?.[0]).toMatchObject({ k: "col", key: "body" });
				view.handleInput?.("q");
			},
		});
		await createUiPort(host.pi, host.ctx).report("Storm 현황", MARKDOWN, INFO);
		const visible = stripTerminalSequences(rendered);
		expect(visible).toContain("대기 중: 3개");
		expect(visible).toContain("$0.42");
		expect(visible).toContain("Storm 현황");
		expect(visible).not.toContain("Storm · Storm 현황");
		expect(visible).not.toContain("1 개요");
		expect(visible).toContain("일반 문단");
		expect(rendered).toContain(theme.fg("accent", "대기 중: "));
		expect(rendered).toContain(theme.fg("warning", "3개"));
		expect(rendered).toContain(theme.fg("success", "$0.42"));
		// A static track, never shimmered text.
		expect(visible).toContain("█");
		expect(visible).toContain("░");
		expect(native).not.toBeNull();
		expect(native).not.toBeUndefined();
		const spans = nativeSpans(native);
		expect(spans).toContainEqual({ t: "$0.42", s: "success" });
		expect(spans).toContainEqual({ t: "3개", s: "warning" });
		expect(spans.every(run => !run.t.includes("\x1b"))).toBe(true);
		expect(nativeProgress(native)).toEqual([{ value: 0.42, tone: "success" }]);
		expect(nativeTexts(native).join("\n")).toContain("$0.42");
		// Unannotated prose still goes through the existing Markdown path.
		expect(nativeMds(native)).toContain("일반 문단 **강조**");
	});

	test("an untrusted icon key is dropped from both renderers, not drawn or echoed", async () => {
		const info: InfoLine[] = [{ index: 0, icon: "status.evil\u001b[31m" as NonNullable<InfoLine["icon"]>, spans: [{ text: "본문" }] }];
		let rendered = "";
		let native: NativeNode | null | undefined;
		const host = fakeHost({
			mode: "tui",
			hasUI: true,
			rows: 30,
			driveOverlay(view, rows) {
				rendered = rows.join("\n");
				native = view.describe?.(describeContext(100));
				view.handleInput?.("q");
			},
		});
		await createUiPort(host.pi, host.ctx).report("제목", "본문", info);
		expect(stripTerminalSequences(rendered)).toContain("본문");
		expect(rendered).not.toContain("evil");
		expect(nativeTexts(native).join("\n")).toContain("본문");
		expect(nativeSpans(native).every(run => !run.t.includes("evil") && !run.t.includes("\x1b"))).toBe(true);
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
		let reportNative: NativeNode | null | undefined;
		const host = fakeHost({
			mode: "tui",
			hasUI: true,
			rows: 30,
			answers: [options => options[0], APPROVE],
			driveOverlay(view, top) {
				reportNative = view.describe?.(describeContext(100));
				expect(reportNative?.c?.[0]).toMatchObject({ k: "col", key: "body" });
				view.handleInput?.("2");
				view.handleInput?.("\t");
				expect(view.render(100)).toEqual(top);
				view.handleInput?.("\x1b[F");
				expect(stripTerminalSequences(view.render(100).join("\n"))).toContain("마지막 줄");
				view.handleInput?.("q");
			},
		});
		const ui = createUiPort(host.pi, host.ctx);
		expect(await ui.select("승인할까요", [APPROVE, "취소"], { title: "승인", markdown, info, consent: [APPROVE] })).toBe(APPROVE);
		const [first, second] = host.selects;
		expect(first!.options).not.toContain(APPROVE);
		const panel = first!.panel!.join("\n");
		expect(panel).toContain(theme.fg("accent", "승인 요약"));
		expect(panel).not.toContain("마지막 줄");
		const clipped = nativeTexts(first!.panelNative).join("\n");
		expect(clipped).toContain("승인 요약");
		expect(clipped).not.toContain("마지막 줄");
		expect(second!.options).toContain(APPROVE);
		expect(second!.options).toHaveLength(3);
		expect(host.overlays).toBe(1);
		const full = nativeTexts(reportNative).join("\n");
		expect(full).toContain("마지막 줄");
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

	/** The renderer Storm registers for its transcript type, as omp would call it. */
	function renderer() {
		let draw: ((message: Record<string, unknown>) => Component | undefined) | undefined;
		registerReportRenderer({
			registerMessageRenderer(_type: string, fn: (message: Record<string, unknown>) => Component | undefined) {
				draw = fn;
			},
		} as unknown as ExtensionAPI);
		return (message: Record<string, unknown>) => draw!({ role: "custom", customType: "storm-report", display: true, timestamp: 0, ...message })!;
	}

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

	test("a short settled run draws one inline fact, not a second frame under the answer", () => {
		const { markdown: body, info: spans } = renderCloseout({
			...BRIEF, tier: "line", official: { ...BRIEF.official, label: "완료", tone: "success", accepted: 1, inScope: 1,
				open: { ...BRIEF.official.open, unsettled: 0 } },
		}, false);
		const host = fakeHost({ mode: "tui", hasUI: true });
		createUiPort(host.pi, host.ctx).record(TITLE, body, { ...style, info: spans });
		const component = renderer()(JSON.parse(JSON.stringify(host.sent[0]!.message)));
		const rows = component.render(60).map(stripTerminalSequences);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toContain("Storm · 완료 · 수용 1/1");
		expect(rows[0]).not.toMatch(/[│╭╰]/u);
		expect(component.describe?.(describeContext(60))).toMatchObject({ k: "text" });
	});

	test("a settled fact too long for the row with Storm's mark drops the mark instead of wrapping, and keeps it where it fits", () => {
		const { markdown: body, info: spans } = renderCloseout({
			...BRIEF, tier: "line", official: { ...BRIEF.official, label: "완료 · 필수 결과 이행 · 1/4라운드", tone: "success", accepted: 2, inScope: 2,
				open: { ...BRIEF.official.open, unsettled: 0 } },
		}, false);
		const host = fakeHost({ mode: "tui", hasUI: true });
		createUiPort(host.pi, host.ctx).record(TITLE, body, { ...style, info: spans });
		const component = renderer()(JSON.parse(JSON.stringify(host.sent[0]!.message)));
		const fact = stripTerminalSequences(component.render(200)[0]!);
		expect(fact).toContain("Storm · ");
		// Exactly as wide as the line with the mark needs: at 60 columns the mark would push the last word to a second row.
		const tight = Bun.stringWidth(fact) - 1;
		const rows = component.render(tight).map(stripTerminalSequences);
		expect(rows).toHaveLength(1);
		expect(rows[0]).not.toContain("Storm");
		expect(rows[0]).toContain("수용 2/2");
		expect(Bun.stringWidth(rows[0]!)).toBeLessThanOrEqual(tight);
		expect(rows[0]).not.toMatch(/[│╭╰]/u);
		// A width no single row can hold still wraps, keeping the whole fact and the mark.
		expect(component.render(20).length).toBeGreaterThan(1);
	});

	test("a closeout draws its title once as the frame heading, styled from details, with a native card free of ANSI", () => {
		const host = fakeHost({ mode: "tui", hasUI: true });
		createUiPort(host.pi, host.ctx).record(TITLE, markdown, style);
		const component = renderer()(JSON.parse(JSON.stringify(host.sent[0]!.message)));
		for (const width of [60, 100]) {
			const rows = component.render(width);
			for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
			const visible = stripTerminalSequences(rows.join("\n"));
			expect(visible.split(TITLE)).toHaveLength(2);
			expect(visible).not.toContain("###");
			expect(visible).toContain("수용 1/3");
		}
		const wide = component.render(100).join("\n");
		expect(stripTerminalSequences(wide)).toContain("수용 1/3 · 판정 전 종료 2");
		expect(stripTerminalSequences(wide)).toContain("감독 설명(최종 판정 전 작성): 핵심 경로를 고쳤습니다.");
		expect(wide).toContain(theme.fg("warning", theme.bold("완료 아님 · 라운드 한도")));
		const native = component.describe?.(describeContext(60));
		expect(native).toMatchObject({ k: "card" });
		const spans = nativeSpans(native);
		expect(spans).toContainEqual({ t: "완료 아님 · 라운드 한도", s: "warning strong" });
		expect(spans.every(run => !run.t.includes("\x1b"))).toBe(true);
		expect(nativeMds(native)).toEqual([]);
	});

	test("older records and malformed details keep the existing plain frame with their raw content", () => {
		const draw = renderer();
		const content = `### ${TITLE}\n\n${markdown}`;
		const cases: unknown[] = [
			undefined,
			{ v: 2, kind: "closeout", runId: "run-7", info },
			{ v: 1, kind: "closeout", runId: "run-7", info: "nope" },
			{ v: 1, kind: "closeout", runId: "run-7", info: [{ ...info[0]!, spans: [{ text: "\x1b[2J가짜" }] }, ...info.slice(1)] },
			{ v: 1, kind: "closeout", runId: "run-7", info: [{ ...info[0]!, meter: { fraction: 1, tone: "success" } }, ...info.slice(1)] },
		];
		for (const details of cases) {
			const component = draw({ content, ...(details === undefined ? {} : { details }) });
			expect(component).not.toBeInstanceOf(RichFrame);
			const visible = stripTerminalSequences(component.render(100).join("\n"));
			expect(visible).toContain("Storm");
			expect(visible).toContain("결제 API 재시도 정책 정리");
			expect(visible).not.toContain("가짜");
		}
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
		expect(panel.length).toBeLessThanOrEqual(30 - dialog.options.length);
		expect(panel.join("\n")).toContain("승인하면 이 세션의 자동 위임이 켜집니다");
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
