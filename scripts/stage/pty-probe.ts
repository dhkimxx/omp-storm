/**
 * B0 probe: runs the installed omp binary in a pseudo-terminal with each terminal's environment, loads
 * `pty-probe-extension.ts` (an animated stage widget below the editor) and records every byte omp writes. It answers
 * the startup probes a terminal would (cursor position, DA1, cell size, background colour) and reports, for the
 * steady state after the first seconds, image commands and bytes per second.
 *
 *   node_modules/.bin/bun scripts/stage/pty-probe.ts [--seconds N] [--keep DIR]
 *
 * `--keep DIR` writes each raw capture (`<case>.bin`) and the extension's log (`<case>.log`) there.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

interface Case {
	readonly name: string;
	readonly env: Record<string, string>;
}

const CASES: readonly Case[] = [
	{ name: "wezterm", env: { TERM_PROGRAM: "WezTerm", TERM: "xterm-256color" } },
	{ name: "kitty", env: { KITTY_WINDOW_ID: "1", TERM: "xterm-kitty" } },
	{ name: "iterm2", env: { TERM_PROGRAM: "iTerm.app", TERM: "xterm-256color" } },
	{ name: "apple-terminal", env: { TERM_PROGRAM: "Apple_Terminal", TERM: "xterm-256color" } },
];

/** Variables that name the terminal the probe itself runs in; dropped so only the case's environment speaks. */
const TERMINAL_VARS = /^(TERM|TERM_PROGRAM|TERM_PROGRAM_VERSION|COLORTERM|KITTY_.*|ITERM_.*|LC_TERMINAL.*|WEZTERM_.*|GHOSTTY_.*|TMUX.*|STY|WT_SESSION|VTE_VERSION|ALACRITTY_.*|PI_FORCE_.*|ORCA_.*|TERN_.*|HERDR_.*)$/;

const COLS = 120;
const ROWS = 36;

function answers(out: string): string {
	let reply = "";
	if (out.includes("\x1b[6n")) reply += "\x1b[30;1R";
	if (out.includes("\x1b[16t")) reply += "\x1b[6;18;9t";
	if (out.includes("\x1b[14t")) reply += `\x1b[4;${ROWS * 18};${COLS * 9}t`;
	if (out.includes("\x1b]11;?")) reply += "\x1b]11;rgb:1010/1818/2020\x1b\\";
	if (/\x1b\[0?c/.test(out)) reply += "\x1b[?62;22c";
	return reply;
}

async function capture(test: Case, seconds: number, dir: string): Promise<{ bytes: Uint8Array; marks: number[] }> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !TERMINAL_VARS.test(key)) env[key] = value;
	Object.assign(env, test.env, { STORM_PTY_PROBE_LOG: join(dir, `${test.name}.log`) });
	const chunks: Uint8Array[] = [];
	const marks: number[] = [];
	let total = 0;
	const started = performance.now();
	const terminal = new Bun.Terminal({
		cols: COLS,
		rows: ROWS,
		data(term, data) {
			chunks.push(data);
			total += data.length;
			marks.push(performance.now() - started, total);
			const reply = answers(new TextDecoder().decode(data));
			if (reply) term.write(reply);
		},
	});
	const extension = resolve(import.meta.dir, "pty-probe-extension.ts");
	const child = Bun.spawn(
		["omp", "--no-extensions", "-e", extension, "--no-session", "--no-skills", "--no-rules", "--no-context-files", "--no-lsp", "--no-title"],
		{ env, terminal },
	);
	await Bun.sleep(seconds * 1000);
	child.kill("SIGTERM");
	await Promise.race([child.exited, Bun.sleep(3000)]);
	if (child.exitCode === null) child.kill("SIGKILL");
	terminal.close();
	const bytes = new Uint8Array(total);
	let at = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, at);
		at += chunk.length;
	}
	return { bytes, marks };
}

function report(test: Case, bytes: Uint8Array, marks: number[], seconds: number, dir: string): void {
	const text = new TextDecoder().decode(bytes);
	const from = (seconds - 4) * 1000;
	let startBytes = 0;
	for (let i = 0; i < marks.length; i += 2) if (marks[i]! <= from) startBytes = marks[i + 1]!;
	const steady = new TextDecoder().decode(bytes.subarray(startBytes));
	const count = (s: string, re: RegExp): number => s.match(re)?.length ?? 0;
	let log = "";
	try {
		log = readFileSync(join(dir, `${test.name}.log`), "utf8");
	} catch {
		log = "(no log: the extension did not paint)";
	}
	console.log(`\n### ${test.name}: ${(bytes.length / 1024).toFixed(0)}K in total`);
	console.log(log.trim().split("\n").slice(0, 4).map(line => `  painter: ${line}`).join("\n"));
	console.log(
		`  whole run: kitty transmits ${count(text, /\x1b_Ga=t/g)}, kitty places ${count(text, /\x1b_Ga=p,q=2,C=1/g)}, kitty virtual ${count(text, /\x1b_Ga=p,U=1/g)}, kitty deletes ${count(text, /\x1b_Ga=d/g)}, iTerm2 images ${count(text, /\x1b\]1337;File=/g)}`,
	);
	console.log(
		`  last 4 s: ${(Buffer.byteLength(steady) / 1024 / 4).toFixed(1)} KiB/s, kitty transmits ${count(steady, /\x1b_Ga=t/g)}, iTerm2 images ${count(steady, /\x1b\]1337;File=/g)}, synchronized updates ${count(steady, /\x1b\[\?2026h/g)}`,
	);
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const seconds = Number(args[args.indexOf("--seconds") + 1]) || 10;
	const keep = args.includes("--keep") ? args[args.indexOf("--keep") + 1] : undefined;
	const dir = keep ?? mkdtempSync(join(tmpdir(), "storm-stage-pty-"));
	for (const test of CASES) {
		const { bytes, marks } = await capture(test, seconds, dir);
		if (keep) writeFileSync(join(dir, `${test.name}.bin`), bytes);
		report(test, bytes, marks, seconds, dir);
	}
	if (!keep) rmSync(dir, { recursive: true, force: true });
}

await main();
