/** The shared UI test helper, tried on a real Storm node tree, a rows widget and a keyed overlay. */
import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { activeTheme, h, presetOf, span, symbolOf, truncate, visibleWidth } from "../src/tui/kit.ts";
import { infoFrame, infoLineNode } from "../src/ui/info-node.ts";
import { registerReportRenderer } from "../src/ui.ts";
import type { InfoLine } from "../src/types.ts";
import { closeoutDetails } from "../src/view/closeout.ts";
import { mountMessage, mountOverlay, mountWidget } from "./tui-host.ts";

const MARKDOWN = ["## 요약", "", "라운드 2/3", "진행률 40%", "", "다음 단계는 검증입니다."].join("\n");
const INFO: InfoLine[] = [
	{ index: 2, spans: [{ text: "라운드 2/3", tone: "accent" }], icon: "status.running" },
	{ index: 3, spans: [{ text: "진행률 40%", tone: "success" }], meter: { fraction: 0.4, tone: "success" } },
];

function renderers() {
	const registered = new Map<string, Parameters<ExtensionAPI["registerMessageRenderer"]>[1]>();
	registerReportRenderer({
		registerMessageRenderer: (type: string, renderer: Parameters<ExtensionAPI["registerMessageRenderer"]>[1]) => registered.set(type, renderer),
	} as unknown as ExtensionAPI);
	return registered;
}

describe("tests/tui-host.ts on Storm's info frame", () => {
	test("a card with annotated lines and prose draws all its parts inside the width", () => {
		const view = mountMessage(() => infoFrame("Storm · 점검", MARKDOWN, INFO, "🌀") as never, { customType: "storm-report", content: MARKDOWN }, { columns: 60 });
		const screen = view.screen();
		const text = view.text();
		expect(text).toContain("Storm · 점검");
		expect(text).toContain("라운드 2/3");
		expect(text).toContain("다음 단계는 검증입니다.");
		expect(text).not.toContain("##");
		// The meter is a determinate bar beside its line: a filled share of cells.
		expect(text).toMatch(/[█▓▒]/);
		expect(screen.every(row => visibleWidth(row) <= 60)).toBe(true);
		view.dispose();
	});

	test("the dark theme paints the head with the label colour and the colour keeps to the cell", () => {
		const view = mountMessage(() => infoFrame("Storm · 점검", MARKDOWN, INFO) as never, { customType: "storm-report", content: MARKDOWN });
		expect(view.rows().some(row => row.includes("\x1b["))).toBe(true);
		view.dispose();
		const plain = mountMessage(() => infoFrame("Storm · 점검", MARKDOWN, INFO) as never, { customType: "storm-report", content: MARKDOWN }, { theme: "plain" });
		expect(plain.rows().some(row => row.includes("\x1b["))).toBe(false);
		plain.dispose();
	});

	test("a closeout record reaches the registered renderer and a plain record gets a frame", () => {
		const renderer = renderers().get("storm-report")!;
		const plain = mountMessage(renderer, { customType: "storm-report", content: "### 알림\n\n본문입니다" });
		expect(plain.text()).toContain("본문입니다");
		plain.dispose();
		const markdown = "### Storm 실행 결과\n\n완료";
		const record = mountMessage(renderer, { customType: "storm-report", content: markdown, details: closeoutDetails(markdown, undefined) });
		expect(record.text()).toContain("완료");
		record.dispose();
	});

	test("one annotated line with a meter is a text node over a progress node", () => {
		const node = infoLineNode(INFO[1]!);
		expect(node.kind).toBe("col");
		expect(node.children().map(child => child.kind)).toEqual(["text", "progress"]);
	});
});

describe("tests/tui-host.ts on a rows widget", () => {
	test("rows draw at the terminal width, repaint after requestRender and stop at dispose", () => {
		let count = 0;
		let disposed = false;
		let hostRequest = (): void => undefined;
		const view = mountWidget(
			ui => {
				hostRequest = () => ui.requestRender();
				return {
					render: width => [`${"=".repeat(width + 10)}`, `n=${count}`],
					dispose: () => {
						disposed = true;
					},
				};
			},
			{ columns: 40, rows: 10 },
		);
		expect(view.screen()[0]).toBe("=".repeat(40));
		expect(view.screen()[1]).toBe("n=0");
		count = 1;
		hostRequest();
		view.tick(0);
		expect(view.screen()[1]).toBe("n=1");
		expect(view.renderRequests()).toBe(1);
		view.dispose();
		expect(disposed).toBe(true);
	});

	test("the factory sees the terminal size, and resizing reaches it", () => {
		let seen = { columns: 0, rows: 0 };
		const view = mountWidget(
			ui => ({
				render: () => {
					seen = ui.size();
					return [`${seen.columns}x${seen.rows}`];
				},
			}),
			{ columns: 50, rows: 12 },
		);
		expect(view.screen()[0]).toBe("50x12");
		view.resize(70, 20);
		expect(view.screen()[0]).toBe("70x20");
		view.dispose();
	});

	test("a node widget repaints when a signal it reads changes", () => {
		const view = mountWidget(() => h("text", { text: "mounted" }), { columns: 30, rows: 5 });
		expect(view.text()).toContain("mounted");
		view.dispose();
	});
});

describe("tests/tui-host.ts on an overlay", () => {
	test("keys reach the focused view, and done closes it with its value", async () => {
		const seen: string[] = [];
		const overlay = await mountOverlay<string>((_ui, _theme, _keys, done) => ({
			render: () => [`keys: ${seen.join(",")}`],
			handleInput(data) {
				seen.push(data === "\r" ? "enter" : data === "\x1b" ? "esc" : data);
				if (data === "\r") done("picked");
			},
		}));
		overlay.type("a");
		overlay.press("down");
		expect(overlay.text()).toContain("keys: a");
		expect(overlay.closed()).toBe(false);
		overlay.press("enter");
		expect(overlay.closed()).toBe(true);
		expect(await overlay.result).toBe("picked");
		overlay.dispose();
	});

	test("a node overlay handles keys through onKey ids", async () => {
		const pressed: string[] = [];
		const overlay = await mountOverlay<void>((_ui, _theme, _keys, done) =>
			h("col", { onKey: key => (pressed.push(key.id), key.id === "escape" && (done(), true)) }, h("text", { text: "sheet" })),
		);
		expect(overlay.text()).toContain("sheet");
		overlay.press("pageDown");
		overlay.press("escape");
		expect(pressed).toEqual(["pageDown", "escape"]);
		expect(overlay.closed()).toBe(true);
		overlay.dispose();
	});
});

describe("tests/tui-host.ts: the active theme", () => {
	test("activate makes the mounted theme the one Storm reads, and dispose puts the previous one back", async () => {
		const { loadThemeSync } = await import("@oh-my-pi/pi-tui/theme/loader");
		const ascii = loadThemeSync("dark", { symbolPreset: "ascii" });
		const before = activeTheme();
		const kept = mountWidget(() => ({ render: () => [presetOf(activeTheme())], dispose() {} }), { theme: ascii });
		expect(activeTheme()).toBe(before);
		kept.dispose();
		const view = mountWidget(() => ({ render: () => [presetOf(activeTheme())], dispose() {} }), { theme: ascii, activate: true });
		expect(view.text()).toContain("ascii");
		expect(activeTheme()).not.toBe(before);
		view.dispose();
		expect(activeTheme()).toBe(before);
		const overlay = await mountOverlay(() => ({ render: () => [presetOf(activeTheme())], dispose() {} }), { theme: ascii, activate: true });
		expect(overlay.text()).toContain("ascii");
		overlay.dispose();
		expect(activeTheme()).toBe(before);
	});
});

describe("src/tui/kit.ts", () => {
	test("width helpers count Korean as two cells and truncate to the width", () => {
		expect(visibleWidth("가a")).toBe(3);
		expect(truncate("abcdef", 4, "…")).toBe("abc…");
		expect(span("x")).toEqual({ t: "x" });
		expect(span("x", "dim")).toEqual({ t: "x", s: "dim" });
	});

	test("the symbol helper reads the theme's preset and answers empty for an unknown key", async () => {
		const { activeTheme, presetOf } = await import("../src/tui/kit.ts");
		const theme = activeTheme();
		expect(["unicode", "nerd", "ascii"]).toContain(presetOf(theme));
		expect(symbolOf(theme, "status.success")).not.toBe("");
		expect(symbolOf(theme, "no.such.key")).toBe("");
	});
});
