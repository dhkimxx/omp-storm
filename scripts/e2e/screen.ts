/**
 * A small terminal screen for the pty drivers: the rows a person sees, rebuilt from the bytes the host wrote.
 *
 * omp 19.2 paints by diff: after the first frame only the rows that changed are written, addressed with relative
 * cursor moves (CUU/CUD/CHA), so the byte stream alone no longer holds "the screen" (a row such as the composer is
 * drawn once and never again). The emulator replays the cursor moves, line edits and scrolling the renderer uses
 * (CUP/CUU/CUD/CUF/CUB/CHA/VPA, EL, ED, ECH, IL, DL, SU, DECSC/DECRC, CR/LF, auto-wrap) and ignores colours and
 * modes. It is incremental: `write` takes each chunk as it arrives, so asking for the screen costs one copy of the
 * grid, not a replay of the whole session, and an escape sequence split between two chunks is held until its end.
 *
 * Not a general terminal: no alternate screen, no scroll region, no tabs beyond a single cell, no mouse. What omp's
 * inline renderer needs, nothing else.
 */

const CSI_FINAL = /[@-~]/;

export class Screen {
	readonly columns: number;
	readonly rows: number;
	readonly #graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
	#grid: string[][];
	#scrollback: string[][] = [];
	#row = 0;
	#col = 0;
	#saved: [number, number] = [0, 0];
	/** An escape sequence the last chunk ended in the middle of. */
	#pending = "";

	constructor(columns: number, rows: number) {
		this.columns = columns;
		this.rows = rows;
		this.#grid = Array.from({ length: rows }, () => this.#blank());
	}

	#blank(): string[] {
		return Array.from({ length: this.columns }, () => " ");
	}

	#scrollUp(): void {
		this.#scrollback.push(this.#grid.shift() ?? this.#blank());
		this.#grid.push(this.#blank());
	}

	#lineFeed(): void {
		if (this.#row === this.rows - 1) this.#scrollUp();
		else this.#row++;
	}

	#put(grapheme: string): void {
		const width = Bun.stringWidth(grapheme);
		if (width === 0) return;
		if (this.#col + width > this.columns) {
			this.#col = 0;
			this.#lineFeed();
		}
		const row = this.#grid[this.#row]!;
		row[this.#col] = grapheme;
		for (let at = 1; at < width; at++) row[this.#col + at] = "";
		this.#col += width;
	}

	#clamp(value: number, max: number): number {
		return Math.min(max, Math.max(0, value));
	}

	/** Feeds the bytes the host wrote. */
	write(chunk: string): void {
		const raw = this.#pending + chunk;
		this.#pending = "";
		let at = 0;
		while (at < raw.length) {
			const char = raw[at]!;
			if (char === "\x1b") {
				const used = this.#escape(raw, at);
				if (used < 0) {
					this.#pending = raw.slice(at);
					return;
				}
				at += used;
				continue;
			}
			if (char === "\r") this.#col = 0;
			else if (char === "\n") this.#lineFeed();
			if (char < " ") {
				at++;
				continue;
			}
			const stop = raw.slice(at).search(/[\x00-\x1f]/);
			const text = stop < 0 ? raw.slice(at) : raw.slice(at, at + stop);
			for (const { segment } of this.#graphemes.segment(text)) this.#put(segment);
			at += text.length;
		}
	}

	/** Applies the escape sequence at `at`; its length, or -1 when the chunk ends inside it. */
	#escape(raw: string, at: number): number {
		const kind = raw[at + 1];
		if (kind === undefined) return -1;
		if (kind === "[") {
			let end = at + 2;
			while (end < raw.length && !CSI_FINAL.test(raw[end]!)) end++;
			if (end >= raw.length) return -1;
			this.#csi(raw.slice(at + 2, end), raw[end]!);
			return end + 1 - at;
		}
		if (kind === "]" || kind === "_" || kind === "P" || kind === "^" || kind === "X") {
			// A string sequence ends at BEL or ST; OMP's marks (OSC 7501, APC) are ignored wholesale.
			const bell = raw.indexOf("\x07", at + 2);
			const terminator = raw.indexOf("\x1b\\", at + 2);
			const ends = [bell < 0 ? Number.POSITIVE_INFINITY : bell + 1, terminator < 0 ? Number.POSITIVE_INFINITY : terminator + 2];
			const end = Math.min(...ends);
			return Number.isFinite(end) ? end - at : -1;
		}
		if (kind === "7") this.#saved = [this.#row, this.#col];
		if (kind === "8") [this.#row, this.#col] = this.#saved;
		return 2;
	}

	#csi(params: string, final: string): void {
		const args = params.replace(/^[?<>=]/, "").split(/[;:]/).map(part => (part === "" ? 0 : Number(part)));
		if (/^[?<>=]/.test(params) && final !== "J") return; // private modes: nothing of ours
		const count = Math.max(1, args[0] ?? 0);
		const { rows, columns } = this;
		switch (final) {
			case "H":
			case "f":
				this.#row = this.#clamp((args[0] || 1) - 1, rows - 1);
				this.#col = this.#clamp((args[1] || 1) - 1, columns - 1);
				break;
			case "A": this.#row = this.#clamp(this.#row - count, rows - 1); break;
			case "B": this.#row = this.#clamp(this.#row + count, rows - 1); break;
			case "E": this.#row = this.#clamp(this.#row + count, rows - 1); this.#col = 0; break;
			case "F": this.#row = this.#clamp(this.#row - count, rows - 1); this.#col = 0; break;
			case "C": this.#col = this.#clamp(this.#col + count, columns - 1); break;
			case "D": this.#col = this.#clamp(this.#col - count, columns - 1); break;
			case "G": this.#col = this.#clamp((args[0] || 1) - 1, columns - 1); break;
			case "d": this.#row = this.#clamp((args[0] || 1) - 1, rows - 1); break;
			case "K": {
				const mode = args[0] ?? 0;
				const row = this.#grid[this.#row]!;
				for (let cell = mode === 0 ? this.#col : 0; cell < (mode === 1 ? this.#col + 1 : columns); cell++) row[cell] = " ";
				break;
			}
			case "X": {
				const row = this.#grid[this.#row]!;
				for (let cell = this.#col; cell < Math.min(columns, this.#col + count); cell++) row[cell] = " ";
				break;
			}
			case "J": {
				const mode = args[0] ?? 0;
				if (mode === 3) {
					this.#scrollback = [];
					break;
				}
				for (let line = 0; line < rows; line++) {
					if (mode === 2 || (mode === 0 && line > this.#row) || (mode === 1 && line < this.#row)) this.#grid[line] = this.#blank();
				}
				const row = this.#grid[this.#row]!;
				if (mode === 0) for (let cell = this.#col; cell < columns; cell++) row[cell] = " ";
				if (mode === 1) for (let cell = 0; cell <= this.#col; cell++) row[cell] = " ";
				break;
			}
			case "L":
				for (let n = 0; n < count; n++) {
					this.#grid.splice(rows - 1, 1);
					this.#grid.splice(this.#row, 0, this.#blank());
				}
				break;
			case "M":
				for (let n = 0; n < count; n++) {
					this.#grid.splice(this.#row, 1);
					this.#grid.push(this.#blank());
				}
				break;
			case "S":
				for (let n = 0; n < count; n++) this.#scrollUp();
				break;
			default:
				break;
		}
	}

	/** Rows scrolled off the top, then the screen: everything a person could see by scrolling. */
	all(): string[] {
		return [...this.scrollback(), ...this.viewport()];
	}

	/** The visible rows, top to bottom, trailing blanks cut. */
	viewport(): string[] {
		return this.#grid.map(cells => cells.join("").replace(/\s+$/, ""));
	}

	/** Rows scrolled off the top. */
	scrollback(): string[] {
		return this.#scrollback.map(cells => cells.join("").replace(/\s+$/, ""));
	}

	/** The screen as one text: the visible rows without the empty rows at the bottom. */
	text(): string {
		const rows = this.viewport();
		while (rows.length > 0 && rows.at(-1) === "") rows.pop();
		return rows.join("\n");
	}
}

/** The terminal a byte log paints, replayed from nothing: `scrollback` (scrolled off the top) then `viewport`. */
export function replayScreen(raw: string, columns: number, rows: number): { scrollback: string[]; viewport: string[] } {
	const screen = new Screen(columns, rows);
	screen.write(raw);
	return { scrollback: screen.scrollback(), viewport: screen.viewport() };
}
