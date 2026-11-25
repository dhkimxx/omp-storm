/**
 * The two `paint` functions a lane view can be given: one for a plain terminal (truecolor, 256 colours or none)
 * and one that maps every `Tone` to a token of an omp theme.
 */
import type { Theme, ThemeColor } from "@oh-my-pi/pi-tui";
import { agentPalette } from "@oh-my-pi/pi-tui/overlays/agent-identity";
import { FG_RESET } from "@oh-my-pi/pi-tui/theme/color";
import { getSessionAccentAnsi } from "@oh-my-pi/pi-tui/theme/session-color";
import type { FrameOptions, Tone } from "./model.ts";

export type Paint = FrameOptions["paint"];
export type ColorDepth = "truecolor" | "256" | "none";

const ESC = "\x1b[";
const RESET = `${ESC}0m`;

/** A dark-terminal palette in hex; the five role hues stay apart from success, warning and error. */
const HEX: Record<Tone, string> = {
	fg: "#d4d4d4",
	dim: "#5f6673",
	muted: "#8a909c",
	accent: "#febc38",
	bright: "#6cb6ff",
	success: "#89d281",
	warning: "#e4c00f",
	error: "#fc3a4b",
	role1: "#4aa3ff",
	role2: "#b281d6",
	role3: "#e8905a",
	role4: "#4ec9b0",
	role5: "#d787af",
};

/** The same tones deepened for a light terminal. */
const HEX_LIGHT: Record<Tone, string> = {
	fg: "#2b2f36",
	dim: "#a0a6b0",
	muted: "#6b7280",
	accent: "#b7791f",
	bright: "#0b6bcb",
	success: "#1e7e34",
	warning: "#9a6b00",
	error: "#c4162a",
	role1: "#1565c0",
	role2: "#7b3fa0",
	role3: "#c2571a",
	role4: "#0e8a73",
	role5: "#b03a78",
};

function rgb(hex: string): [number, number, number] {
	return [Number.parseInt(hex.slice(1, 3), 16), Number.parseInt(hex.slice(3, 5), 16), Number.parseInt(hex.slice(5, 7), 16)];
}

/** The nearest xterm 256-colour cube or grey-ramp index for an RGB colour. */
function xterm256([r, g, b]: [number, number, number]): number {
	const level = (v: number): number => (v < 48 ? 0 : v < 115 ? 1 : Math.min(5, Math.floor((v - 35) / 40)));
	const [lr, lg, lb] = [level(r), level(g), level(b)];
	const cube = 16 + 36 * lr + 6 * lg + lb;
	const grey = Math.max(0, Math.min(23, Math.round(((r + g + b) / 3 - 8) / 10)));
	const steps = [0, 95, 135, 175, 215, 255];
	const cubeDist = (r - steps[lr]!) ** 2 + (g - steps[lg]!) ** 2 + (b - steps[lb]!) ** 2;
	const greyValue = 8 + grey * 10;
	const greyDist = (r - greyValue) ** 2 + (g - greyValue) ** 2 + (b - greyValue) ** 2;
	return greyDist < cubeDist ? 232 + grey : cube;
}

/** `COLORTERM` says truecolor; `TERM` says 256 colours; `NO_COLOR` or a pipe says none. */
export function detectColorDepth(env: NodeJS.ProcessEnv = process.env, isTty: boolean = process.stdout.isTTY === true): ColorDepth {
	if (!isTty || (env.NO_COLOR !== undefined && env.NO_COLOR !== "")) return "none";
	const colorterm = (env.COLORTERM ?? "").toLowerCase();
	if (colorterm === "truecolor" || colorterm === "24bit") return "truecolor";
	if ((env.TERM ?? "").includes("256color")) return "256";
	// Other terminals: assume 256 colours rather than the 16 colours that would flatten the palette.
	return env.TERM === "dumb" || env.TERM === undefined ? "none" : "256";
}

export function plainPaint(depth: ColorDepth, dark: boolean = true): Paint {
	if (depth === "none") return (_tone, text) => text;
	const hex = dark ? HEX : HEX_LIGHT;
	const codes = new Map<Tone, string>();
	for (const tone of Object.keys(hex) as Tone[]) {
		const color = rgb(hex[tone]);
		codes.set(tone, depth === "truecolor" ? `${ESC}38;2;${color[0]};${color[1]};${color[2]}m` : `${ESC}38;5;${xterm256(color)}m`);
	}
	return (tone, text, bold) => `${bold === true ? `${ESC}1m` : ""}${codes.get(tone)}${text}${RESET}`;
}

/**
 * Role hues come from omp's own agent palette (`overlays/agent-identity.ts`): a `subagent1..6` token the theme declares
 * keeps its slot, and the free slots are filled with hues derived from the terminal's ANSI palette or the session accent,
 * at least 0.1 apart in OKLab and readable on the card backgrounds. No bundled theme declares `subagentN`, and the
 * obvious fallback tokens (`borderAccent`, `syntaxString`, ...) collapse into one hue in most of them (README, Colour).
 */
export function themePaint(theme: Theme): Paint {
	const roles = agentPalette(theme).subagents;
	const roleAnsi = (index: number): string => getSessionAccentAnsi(roles[index % roles.length]) ?? "";
	const token: Record<Exclude<Tone, `role${number}`>, ThemeColor> = {
		fg: "text",
		dim: "dim",
		muted: "muted",
		accent: "accent",
		bright: "mdLink",
		success: "success",
		warning: "warning",
		error: "error",
	};
	const role: Record<`role${number}`, string> = {
		role1: roleAnsi(0),
		role2: roleAnsi(1),
		role3: roleAnsi(2),
		role4: roleAnsi(3),
		role5: roleAnsi(4),
	};
	return (tone, text, bold) => {
		const ansi = tone.startsWith("role") ? role[tone as `role${number}`] : undefined;
		const colored = ansi !== undefined ? `${ansi}${text}${FG_RESET}` : theme.fg(token[tone as keyof typeof token], text);
		return bold === true ? theme.bold(colored) : colored;
	};
}
