/**
 * Storm's one door to the host's UI library. This is the only file in `src/` that imports `@oh-my-pi/pi-tui`; every
 * surface builds nodes through `h` and reads width, glyphs and theme facts through the helpers here, so a host change
 * touches one file.
 *
 * Why no JSX: the host serves extensions its bundled copy of the library and does not rewrite the runtime import the
 * JSX transform injects, so a `@jsxImportSource` file fails to load. `h` calls the same `jsx` factory by hand.
 *
 * Everything here is pure or reactive-read; nothing starts a timer or touches the terminal.
 */
import {
	type Accessor,
	batch,
	computed,
	jsx,
	type JSXNode,
	type KeyEvent,
	type KindAttributes,
	nativeRendering,
	type ScrollRequest,
	signal,
	type Signal,
	type UiEvent,
	type UiKind,
	type UiNode,
	type UiProps,
} from "@oh-my-pi/pi-tui";
import { singleLine } from "@oh-my-pi/pi-tui/text/sanitize";
import { truncate, visibleWidth, wrap } from "@oh-my-pi/pi-tui/text/width";
import type { Block, Hit, PaintContext, Painter } from "@oh-my-pi/pi-tui/term/paint";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";

export type { Accessor, Block, Hit, JSXNode, KeyEvent, PaintContext, Painter, ScrollRequest, Signal, Theme, UiEvent, UiNode };
/** Whether this process draws natively (Tern) right now; reactive when read inside a node prop. */
export { batch, computed, nativeRendering, signal, singleLine, truncate, visibleWidth, wrap };

/** One styled run of a `text` node; `s` holds space-separated theme tokens (`accent strong`, `dim`, `warning`). */
export interface Span {
	t: string;
	s?: string;
}

/** A run of text with optional style tokens; an absent style leaves the key out (exact optional properties). */
export const span = (t: string, s?: string): Span => (s === undefined ? { t } : { t, s });

/** Attributes of a node of kind `K`: its props (each possibly an accessor) plus handlers (`onKey`, `onSelect`, …). */
export type NodeAttrs<K extends UiKind> = KindAttributes<UiProps<K>>;

/**
 * Builds one node: `h("card", { head: "title" }, h("md", { text }))`. Children go after the props; one child or a
 * list. Props may be accessors, so a node reads signals and repaints when they change.
 */
export function h<K extends UiKind>(kind: K, attrs?: NodeAttrs<K>, ...children: JSXNode[]): UiNode<K> {
	const props: Record<string, unknown> = { ...attrs };
	if (children.length === 1) props.children = children[0];
	else if (children.length > 1) props.children = children;
	return jsx(kind, props) as UiNode<K>;
}

/** The active theme right now (a signal: reading it inside a node prop repaints on a theme switch). */
export const activeTheme = (): Theme => currentTheme();

/** The glyph of a theme symbol key such as `status.success`; "" when the theme does not know it. */
export const symbolOf = (theme: Theme, key: string): string => theme.symbols.symbol(key);

/** The symbol preset the theme draws with. */
export const presetOf = (theme: Theme): "unicode" | "nerd" | "ascii" => theme.symbols.preset;

/** The colour depth the theme's escapes target. */
export const depthOf = (theme: Theme): "truecolor" | "256" | "16" => theme.depth;

/** Whether the theme is a dark one. */
export const isDark = (theme: Theme): boolean => theme.dark;

type PaintModule = {
	defineRolePainter(kind: UiNode["kind"], role: string, painter: Painter): void;
	rolePainterRegistrations(): ReadonlyMap<string, number>;
};

/**
 * Registers terminal role painters with the host and says whether it worked. `@oh-my-pi/pi-tui/term/paint` is an
 * internal subpath of the host library: a static import that fails takes the whole extension down, so it is imported
 * here dynamically and a failure only returns false (the caller degrades). Registering a role again only overwrites, but
 * the host's registry is checked first so a second load of the extension adds nothing.
 */
export async function registerRolePainters(
	roles: ReadonlyArray<readonly [UiNode["kind"], string, Painter]>,
): Promise<boolean> {
	try {
		const paint = (await import("@oh-my-pi/pi-tui/term/paint")) as unknown as PaintModule;
		const known = paint.rolePainterRegistrations();
		for (const [kind, role, painter] of roles) if (!known.has(`${kind}|${role}`)) paint.defineRolePainter(kind, role, painter);
		return true;
	} catch {
		return false;
	}
}
