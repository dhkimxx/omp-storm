import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { Component } from "@oh-my-pi/pi-tui";
import { ensureThemeSync } from "@oh-my-pi/pi-tui/theme/theme";
import { serializeConfig } from "../src/config/store.ts";
import { approveAndSave, type FlowEnv, hubFlow, resetFlow, setupFlow } from "../src/flows.ts";
import { APPROVE } from "../src/proposals/present.ts";
import { loadProjectState } from "../src/state.ts";
import type { UiContext, UiPort } from "../src/types.ts";
import { createUiPort } from "../src/ui.ts";
import { makeProject, TEAM, type TestProject } from "./support.ts";

// Storm's frames are omp components; they draw with omp's theme.
ensureThemeSync();

interface FormAnswer {
	data: Record<string, string | number | string[]>;
	timedOut?: boolean;
}

interface FakeHost {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	/** Options of every selector omp was asked to open, with the panel rows above it at that moment. */
	selects: Array<{ options: string[]; panel: readonly string[] | undefined }>;
	/** omp's own notifications. */
	notified: string[];
	/** Messages put in the transcript. */
	sent: Array<{ message: { content?: unknown; display?: boolean; excludeFromContext?: boolean }; options: { triggerTurn?: boolean } | undefined }>;
	/** Overlays opened (each is closed at once). */
	overlays: number;
	/** Whether a panel widget is still set. */
	panelSet(): boolean;
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
			ui: {
				async select(_title: string, options: string[]) {
					host.selects.push({ options: [...options], panel: widget?.render(tui.terminal.columns) });
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
				async custom(factory: (t: typeof tui, theme: unknown, keys: unknown, done: () => void) => Component) {
					host.overlays++;
					const { promise, resolve } = Promise.withResolvers<void>();
					const view = factory(tui, undefined, undefined, resolve);
					view.render(tui.terminal.columns);
					view.handleInput?.("q");
					await promise;
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

	/** A port that records every dialog with its context and answers from `answers` (by position; none left → no answer). */
	function recordingUi(answers: number[] = []): { ui: UiPort; dialogs: Dialog[] } {
		const dialogs: Dialog[] = [];
		const queue = [...answers];
		const ui: UiPort = {
			async select(title, options, context) {
				if (context) dialogs.push({ title, options: [...options], context });
				const at = queue.shift();
				return at === undefined ? undefined : options.at(at);
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
		return { ...dialog, context: { ...dialog.context, markdown: dialog.context.markdown.replaceAll(project.root, "/repo") } };
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

	test("on 30 rows the panel still shows what approval switches on: the cleanup notice and the shadowing definition", async () => {
		const dialog = await setupDialog();
		const host = fakeHost({ mode: "tui", hasUI: true, rows: 30, answers: [undefined] });
		await createUiPort(host.pi, host.ctx).select(dialog.title, dialog.options, dialog.context);
		const panel = host.selects[0]!.panel!;
		expect(panel.length).toBeLessThanOrEqual(30 - dialog.options.length);
		// The notice is the dialog's first line; the shadow row names the file.
		const lead = dialog.context.markdown.split("\n")[0]!;
		expect(panel.join("\n")).toContain(lead.slice(0, 12));
		expect(panel.some(line => line.includes("/repo/.omp/agents/shadow-file.md"))).toBe(true);
	});

	test("the whole setup on 24 rows: approval only after the full view, and then the five-role team is saved", async () => {
		const refused = fakeHost({ mode: "tui", hasUI: true, rows: 24, answers: [options => (options.includes(APPROVE) ? APPROVE : undefined)], formDialog: async () => undefined });
		await setupFlow(env, createUiPort(refused.pi, refused.ctx));
		expect((await loadProjectState(env)).config.status).toBe("missing");

		const host = fakeHost({ mode: "tui", hasUI: true, rows: 24, answers: [options => options[0], APPROVE], formDialog: async () => undefined });
		await setupFlow(env, createUiPort(host.pi, host.ctx));
		const state = await loadProjectState(env);
		const saved = state.config.status === "ok" ? state.config.config : undefined;
		expect(Object.keys(saved?.roles ?? {})).toHaveLength(5);
		expect(saved?.cleanup).toBe(true);
		expect(host.overlays).toBe(1);
		expect(host.notified).toHaveLength(1);
	});

	test("every dialog that approves, restores or deletes names the options that do", async () => {
		// Unapproved config: only the approval.
		await Bun.write(path.join(project.root, ".omp", "storm", "config.json"), serializeConfig(TEAM));
		const unapproved = recordingUi();
		await hubFlow(env, unapproved.ui);
		expect(unapproved.dialogs[0]?.context.consent).toEqual([APPROVE]);

		// Rollback: the confirmation, not the menu before it.
		const state = await loadProjectState(env);
		await approveAndSave(state, TEAM, { shadowedAgents: state.shadows });
		await approveAndSave(await loadProjectState(env), { ...TEAM, parallelism: 2 }, { shadowedAgents: state.shadows });
		const rollback = recordingUi([2, 0]);
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
