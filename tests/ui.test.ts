import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { type Component, stripTerminalSequences, theme, visibleWidth } from "@oh-my-pi/pi-tui";
import { defaultFormData } from "@oh-my-pi/pi-tui/html-form/data";
import { type HtmlForm, parseHtmlForm } from "@oh-my-pi/pi-tui/html-form/parse";
import type { NativeNode } from "@oh-my-pi/pi-tui/native/node";
import { ModelPickerComponent } from "@oh-my-pi/pi-tui/overlays/model-picker";
import { ensureThemeSync } from "@oh-my-pi/pi-tui/theme/theme";
import { readAutoDelegation } from "../src/approval/auto.ts";
import { serializeConfig } from "../src/config/store.ts";
import { approveAndSave, type FlowEnv, hubFlow, resetFlow, setupFlow } from "../src/flows.ts";
import { APPROVE } from "../src/proposals/present.ts";
import { ROLES } from "../src/roles.ts";
import { FIELD } from "../src/setup/form.ts";
import { loadProjectState } from "../src/state.ts";
import type { InfoLine, UiContext, UiPort } from "../src/types.ts";
import { createUiPort } from "../src/ui.ts";
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

/** Visit a native tree, following component children through their own describe. */
function walkNative(node: NativeNode, visit: (node: NativeNode) => void): void {
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
	answers?: Array<string | undefined | ((options: string[]) => string | undefined)>;
	formDialog?: (html: string) => Promise<FormAnswer | undefined>;
	models?: Array<Record<string, unknown>>;
	driveOverlay?: (view: Component, rows: readonly string[]) => void;
}): FakeHost {
	const answers = [...(opts.answers ?? [])];
	const tui = { terminal: { rows: opts.rows ?? 50, columns: 100 }, requestRender() {} };
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
	test("the native picker exposes available chat models without switching the host session", async () => {
		const picked = {
			provider: "example",
			id: "outside",
			name: "Outside recommendation",
			kind: "chat",
			input: ["text"],
			contextWindow: 64_000,
			thinking: { efforts: ["low", "high"] },
			supportsTools: true,
		};
		for (const key of ["\r", "\x1b"]) {
			const host = fakeHost({
				mode: "tui",
				hasUI: true,
				models: [picked, { ...picked, id: "no-tools", name: "No tools", supportsTools: false }],
				driveOverlay(view, rows) {
					expect(view).toBeInstanceOf(ModelPickerComponent);
					const rendered = rows.join("\n");
					expect(rendered).toContain("탐색 · 주 모델");
					expect(rendered).toContain(picked.name);
					expect(rendered).not.toContain("No tools");
					view.handleInput?.(key);
				},
			});
			const result = await createUiPort(host.pi, host.ctx).pickModel!("탐색 · 주 모델");
			if (key === "\r") expect(result).toMatchObject({ selector: "example/outside", efforts: ["low", "high"] });
			else expect(result).toBeUndefined();
			expect(host.overlays).toBe(1);
			expect(host.selects).toEqual([]);
			expect(host.sent).toEqual([]);
		}
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
				view.handleInput?.("q");
			},
		});
		await createUiPort(host.pi, host.ctx).report("회계", MARKDOWN, INFO);
		const visible = stripTerminalSequences(rendered);
		expect(visible).toContain("대기 중: 3개");
		expect(visible).toContain("$0.42");
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

	test("a cut rich panel withholds consent until the full rich report was shown", async () => {
		const lines = ["### 승인 요약", ...Array.from({ length: 60 }, (_, i) => `- 항목 ${i}`), "- 승인 대상: 마지막 줄"];
		const markdown = lines.join("\n");
		const info: InfoLine[] = lines.map((line, index) => {
			const spans: InfoLine["spans"] =
				index === 0
					? [{ text: "승인 요약", tone: "accent" }]
					: [{ text: line.replace(/^- /, "• "), tone: index === lines.length - 1 ? "warning" : "muted" }];
			return { index, spans };
		});
		let reportNative: NativeNode | null | undefined;
		const host = fakeHost({
			mode: "tui",
			hasUI: true,
			rows: 30,
			answers: [options => options[0], APPROVE],
			driveOverlay(view) {
				reportNative = view.describe?.(describeContext(100));
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
		expect(panel.join("\n")).toContain("승인하면 자동 위임이 켜집니다");
		expect(dialog.context.markdown).toContain("실행이 끝나면 정리");
		expect(dialog.context.markdown).toContain("/repo/.omp/agents/shadow-file.md");
		expect(host.selects[0]?.options).not.toContain(APPROVE);
	});

	test("the whole role interview on 24 rows: approval only after the full view", async () => {
		const forms: HtmlForm[] = [];
		const formDialog = async (html: string): Promise<FormAnswer> => {
			const form = parseHtmlForm(html);
			forms.push(form);
			const data = defaultFormData(form);
			if (Object.hasOwn(data, FIELD.parallelism)) data[FIELD.parallelism] = 3;
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
		expect(names.at(-1)).toContain(FIELD.parallelism);
		const state = await loadProjectState(env);
		const saved = state.config.status === "ok" ? state.config.config : undefined;
		expect(Object.keys(saved?.roles ?? {})).toHaveLength(5);
		expect(saved?.cleanup).toBe(true);
		expect(saved?.parallelism).toBe(3);
		expect(host.overlays).toBe(1);
		expect(host.selects).toHaveLength(3);
		expect(host.selects.at(-1)?.options).toContain(APPROVE);
		expect(await readAutoDelegation(state.store.dir)).toBe(true);
	});

	test("every dialog that approves, restores or deletes names the options that do", async () => {
		// Unapproved config: only the approval.
		await Bun.write(path.join(project.root, ".omp", "storm", "config.json"), serializeConfig(TEAM));
		const unapproved = recordingUi();
		await hubFlow(env, unapproved.ui);
		expect(unapproved.dialogs[0]?.context.consent).toEqual([APPROVE]);

		// The legacy hub marks switching on as consent. Its ordinary rollback item needs consent on the next screen.
		const state = await loadProjectState(env);
		await approveAndSave(state, TEAM, { shadowedAgents: state.shadows });
		await approveAndSave(await loadProjectState(env), { ...TEAM, parallelism: 2 }, { shadowedAgents: state.shadows });
		const rollback = recordingUi(["이전 승인으로 되돌리기", 0]);
		await hubFlow(env, rollback.ui);
		const [menu, confirm] = rollback.dialogs;
		expect(menu?.context.consent).toEqual(["자동 위임으로 전환"]);
		expect(confirm?.context.consent).toEqual([confirm!.options[0]!]);

		// Reset: everything but the cancel deletes.
		const reset = recordingUi();
		await resetFlow(env, reset.ui);
		expect(reset.dialogs[0]?.context.consent).toEqual(expect.arrayContaining(reset.dialogs[0]!.options.slice(0, -1)));
	});
});
