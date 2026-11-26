/**
 * Mounts what Storm hands the omp 19.2 host (a widget factory, an overlay factory, a message renderer) on pi-tui's own
 * test terminal, so a test can read the screen and press keys. It is the shared helper for every UI test; extend it
 * additively (a new option, a new method), never by changing what exists.
 *
 * What it reproduces of the host (`package/src/ui/extensions/render-output.tsx`, `modes/controllers/extension-ui-controller.ts`):
 * - the factory arguments: an `ExtensionUiHost` (`requestRender`, reactive `size`, `suspend`) and an `ExtensionTheme`
 *   (the theme plus `bold`/`italic`/…);
 * - a rows object (`{ render(width), handleInput?, dispose? }`) drawn as a `canvas` whose rows are cut to the width,
 *   repainted after `requestRender()`; in an overlay it also receives each key's raw bytes and pastes as bracketed paste;
 * - an overlay docked to the bottom at full width with no frame (`role="omp.sheet.bare"`), its view holding the keys;
 * - a message renderer's nodes inside the `col role="omp.custom"` the transcript wraps them in.
 *
 * Looks: omp's role painters for `omp.custom` and `omp.sheet.bare` are imported below, so those roles paint as in the
 * host. Every other role (`omp.report.body`, `omp.widget.line`, the composer, the dock…) is not loaded here and draws with
 * the generic painter of its kind; judge those in the real TUI (`scripts/e2e/tui.ts`). The tests run against the pi-tui copy in `node_modules`, a different instance
 * from the one inside omp: build nodes through `src/tui/kit.ts`, never mix nodes across the two.
 */
import type {
	ExtensionCustomFactory,
	ExtensionRender,
	ExtensionRows,
	ExtensionTheme,
	ExtensionUiFactory,
	ExtensionUiHost,
	MessageRenderer,
} from "@oh-my-pi/pi-coding-agent";
import { isUiNode, setNativeRenderingForTest, type JSXNode, type KeyEvent, type UiNode } from "@oh-my-pi/pi-tui";
import type { MouseEvent } from "@oh-my-pi/pi-tui/driver/contract";
import { createTestTerminal, type TestTerminal } from "@oh-my-pi/pi-tui/testing/terminal";
import { truncate } from "@oh-my-pi/pi-tui/text/width";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import { PLAIN_THEME } from "@oh-my-pi/pi-tui/theme/plain";
import { currentTheme, setCurrentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { bold, inverse, italic, strikethrough, underline } from "@oh-my-pi/pi-tui/theme/theme";
import { h, signal } from "../src/tui/kit.ts";
// omp registers its role painters (the message frame, the bare sheet) when its shell starts. Load the two an extension
// view meets so this terminal paints them as the host does.
import "@oh-my-pi/pi-coding-agent/ui/styles/messages/frame";
import "@oh-my-pi/pi-coding-agent/ui/styles/overlays/bare-sheet";

export interface MountOptions {
	/** Terminal width in cells (default 80). */
	columns?: number;
	/** Terminal height in rows (default 24). */
	rows?: number;
	/**
	 * The theme the factory receives and the terminal paints with: a theme object, `"plain"` (no colours, unicode
	 * glyphs) or omitted for omp's default dark theme at true colour.
	 */
	theme?: Theme | "plain";
	/**
	 * Make `theme` the active theme (`currentTheme()`, what `activeTheme()` in the kit reads) for the lifetime of the
	 * view, and restore the previous one on `dispose()`. Without it only the factory argument and the terminal take the
	 * theme, while code that reads the active signal (glyphs through `symbolOf(activeTheme(), …)`) sees omp's default.
	 */
	activate?: boolean;
	/** Draw as a native (Tern) host would: `nativeRendering()` answers true while the view is mounted. */
	native?: boolean;
}

/** A mounted view. Everything reads the last painted frame; input paints. */
export interface TuiView {
	/** The viewport as plain text, trailing blanks trimmed. */
	screen(): string[];
	/** The viewport with its escape sequences, for colour assertions. */
	rows(): readonly string[];
	/** The screen's non-empty rows joined with newlines: for `toContain` checks that ignore layout. */
	text(): string;
	/** Press a key by id: `enter`, `escape`, `up`, `pageDown`, `ctrl+c`, `shift+tab`, or a printable character. */
	press(id: string, options?: { text?: string; kind?: KeyEvent["kind"] }): void;
	/** Type text one key per grapheme. */
	type(text: string): void;
	paste(text: string): void;
	mouse(event: MouseEvent): void;
	/** Advance the terminal clock by `ms` and paint (shimmer, spinners and the like read it). */
	tick(ms: number): void;
	resize(columns: number, rows: number): void;
	/** How many times the view called `ui.requestRender()`. */
	readonly renderRequests: () => number;
	/** The root node of the mounted view, for asserting on props. */
	readonly root: UiNode;
	/** Tear the view down: disposes nodes and a rows object, and clears the native-rendering switch. */
	dispose(): void;
}

/** A mounted overlay: `done` of the factory settles `result` and closes it. */
export interface OverlayView<T> extends TuiView {
	/** The value the factory passed to `done`. Never settles if the view is never closed. */
	readonly result: Promise<T>;
	/** Whether `done` ran. */
	closed(): boolean;
}

const THEME_HELPERS = { bold, italic, underline, strikethrough, inverse } as const;

/** `theme` as extensions receive it: the same theme with methods bound to it, plus the attribute helpers. */
export function extensionTheme(theme: Theme): ExtensionTheme {
	return new Proxy(theme, {
		get(target, prop) {
			if (prop in THEME_HELPERS) return THEME_HELPERS[prop as keyof typeof THEME_HELPERS];
			const value = Reflect.get(target, prop, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
		has: (target, prop) => prop in THEME_HELPERS || Reflect.has(target, prop),
	}) as ExtensionTheme;
}

const resolveTheme = (theme: MountOptions["theme"]): Theme =>
	theme === "plain" ? PLAIN_THEME : (theme ?? currentTheme());

/** Makes the option's theme the active one when asked; returns what puts the previous one back. */
function activateTheme(options: MountOptions): () => void {
	if (options.activate !== true) return () => {};
	const before = currentTheme();
	setCurrentTheme(resolveTheme(options.theme) as typeof before);
	return () => setCurrentTheme(before);
}

/**
 * The bytes a terminal sends for a key id. The test terminal hands a node's `onKey` the id but leaves `raw` empty for
 * keys that print nothing; a real terminal's `raw` is these bytes, and a rows object's `handleInput` gets exactly them.
 */
const KEY_BYTES: Readonly<Record<string, string>> = {
	enter: "\r",
	escape: "\x1b",
	tab: "\t",
	"shift+tab": "\x1b[Z",
	backspace: "\x7f",
	delete: "\x1b[3~",
	space: " ",
	up: "\x1b[A",
	down: "\x1b[B",
	right: "\x1b[C",
	left: "\x1b[D",
	"shift+up": "\x1b[1;2A",
	"shift+down": "\x1b[1;2B",
	"shift+right": "\x1b[1;2C",
	"shift+left": "\x1b[1;2D",
	home: "\x1b[H",
	end: "\x1b[F",
	pageUp: "\x1b[5~",
	pageDown: "\x1b[6~",
};

/** `key`'s raw bytes: its own when the terminal gave them, else the usual sequence of its id. */
export function rawOf(key: Pick<KeyEvent, "id" | "raw" | "text">): string {
	if (key.raw !== "") return key.raw;
	const known = KEY_BYTES[key.id];
	if (known !== undefined) return known;
	const ctrl = /^ctrl\+([a-z])$/.exec(key.id);
	if (ctrl !== null) return String.fromCharCode(ctrl[1]!.charCodeAt(0) - 96);
	return key.text ?? "";
}

function isRows(output: unknown): output is ExtensionRows {
	return typeof output === "object" && output !== null && !Array.isArray(output) && !isUiNode(output) && "render" in output;
}

interface Hosted {
	readonly ui: ExtensionUiHost;
	readonly renderRequests: () => number;
	readonly resizeTo: (columns: number, rows: number) => void;
	readonly revision: () => unknown;
}

function hostOf(options: MountOptions): Hosted {
	const revision = signal(0);
	const size = signal({ columns: options.columns ?? 80, rows: options.rows ?? 24 });
	let requests = 0;
	return {
		ui: {
			requestRender() {
				requests++;
				revision.set(revision.peek() + 1);
			},
			size: () => size(),
			suspend: run => run(),
		},
		renderRequests: () => requests,
		resizeTo: (columns, rows) => size.set({ columns, rows }),
		revision,
	};
}

/** The host's `extensionOutput`: nodes pass through, a rows object becomes a canvas. */
function nodeOf(output: ExtensionRender | undefined, host: Hosted, input: boolean, disposers: Array<() => void>): JSXNode {
	if (output === undefined || output === null) return undefined;
	if (!isRows(output)) return output as JSXNode;
	const rows = output;
	disposers.push(() => rows.dispose?.());
	const local = signal(0);
	const paint = (width: number): readonly string[] => {
		host.revision();
		local();
		return rows.render(width).map(row => truncate(row, width, ""));
	};
	if (!input || typeof rows.handleInput !== "function") return h("canvas", { paint });
	const deliver = (data: string): boolean => {
		rows.handleInput?.(data);
		local.set(local.peek() + 1);
		return true;
	};
	return h("canvas", {
		paint,
		onKey: (key: KeyEvent) => key.kind !== "release" && deliver(rawOf(key)),
		onPaste: paste => deliver(`\x1b[200~${paste.text}\x1b[201~`),
	});
}

function viewOf(term: TestTerminal, host: Hosted, root: UiNode, finish: () => void): TuiView {
	return {
		screen: () => term.screen(),
		rows: () => term.rows(),
		text: () =>
			term
				.screen()
				.filter(row => row.length > 0)
				.join("\n"),
		press: (id, options) => term.press(id, options),
		type: text => term.type(text),
		paste: text => term.paste(text),
		mouse: event => term.mouse(event),
		tick: ms => term.tick(ms),
		resize(columns, rows) {
			host.resizeTo(columns, rows);
			term.resize(columns, rows);
		},
		renderRequests: host.renderRequests,
		root,
		dispose: finish,
	};
}

function mount(
	build: (host: Hosted, theme: ExtensionTheme, disposers: Array<() => void>) => { region: "dock" | "main" | "layer"; node: UiNode },
	options: MountOptions,
	host: Hosted = hostOf(options),
	restoreTheme: () => void = activateTheme(options),
): { view: TuiView; term: TestTerminal; node: UiNode } {
	const theme = resolveTheme(options.theme);
	const disposers: Array<() => void> = [];
	if (options.native === true) setNativeRenderingForTest(true);
	let built: { region: "dock" | "main" | "layer"; node: UiNode } | undefined;
	let term: TestTerminal;
	try {
		term = createTestTerminal(
			() => {
				built = build(host, extensionTheme(theme), disposers);
				return { [built.region]: built.node };
			},
			{ columns: options.columns ?? 80, rows: options.rows ?? 24, theme },
		);
	} catch (error) {
		restoreTheme();
		throw error;
	}
	const node = built!.node;
	let finished = false;
	const view = viewOf(term, host, node, () => {
		if (finished) return;
		finished = true;
		for (const dispose of disposers) dispose();
		term.dispose();
		if (options.native === true) setNativeRenderingForTest(false);
		restoreTheme();
	});
	return { view, term, node };
}

/** `node`, or a `col` around whatever else the output is: a view always has exactly one root. */
const singleNode = (output: JSXNode): UiNode => (isUiNode(output) ? output : h("col", {}, output));

/** Mounts a widget factory (`ctx.ui.setWidget(key, factory)`) in the dock, as the host's widget slot does. */
export function mountWidget(factory: ExtensionUiFactory, options: MountOptions = {}): TuiView {
	return mount(
		(host, theme, disposers) => ({
			region: "dock",
			node: singleNode(nodeOf(factory(host.ui, theme), host, false, disposers)),
		}),
		options,
	).view;
}

/**
 * Mounts an overlay factory (`ctx.ui.custom(factory, { overlay: true })`): docked to the bottom at full width, the view
 * focused. `done` settles `result`. Async because the factory may return a promise.
 */
export async function mountOverlay<T>(factory: ExtensionCustomFactory<T>, options: MountOptions = {}): Promise<OverlayView<T>> {
	const { promise, resolve } = Promise.withResolvers<T>();
	let closed = false;
	const host = hostOf(options);
	const restoreTheme = activateTheme(options);
	let output: Awaited<ReturnType<typeof factory>>;
	try {
		output = await factory(host.ui, extensionTheme(resolveTheme(options.theme)), {} as never, value => {
			closed = true;
			resolve(value);
		});
	} catch (error) {
		restoreTheme();
		throw error;
	}
	const mounted = mount(
		(_host, _theme, disposers) => {
			const view = singleNode(nodeOf(output, host, true, disposers));
			return {
				region: "layer",
				node: h("overlay", { anchor: "bottom", role: "omp.sheet.bare", term: { width: "full" } }, view),
			};
		},
		options,
		host,
		restoreTheme,
	);
	// Keys go to the view inside the sheet, as the host focuses it.
	const inner = mounted.node.children()[0];
	if (inner !== undefined) mounted.term.focus(inner);
	return Object.assign(mounted.view, { result: promise, closed: () => closed });
}

/** The message a renderer draws, as the session stores it. */
export interface TestMessage {
	customType: string;
	content: string;
	details?: unknown;
}

/**
 * Mounts what a registered message renderer returns for `message`, inside the `col role="omp.custom"` the transcript
 * wraps extension output in. A renderer that returns undefined shows omp's default card (head: the type, body: the text).
 */
export function mountMessage(
	renderer: MessageRenderer,
	message: TestMessage,
	options: MountOptions & { expanded?: boolean } = {},
): TuiView {
	return mount(
		(host, theme, disposers) => {
			const output = renderer(
				{
					role: "custom",
					customType: message.customType,
					content: message.content,
					display: true,
					timestamp: 0,
					...(message.details !== undefined && { details: message.details }),
				},
				{ expanded: options.expanded ?? false },
				theme,
			);
			const drawn =
				output === undefined
					? h("card", { head: message.customType }, h("md", { text: message.content }))
					: nodeOf(output, host, false, disposers);
			return { region: "main", node: h("col", { role: "omp.custom" }, drawn) };
		},
		options,
	).view;
}
