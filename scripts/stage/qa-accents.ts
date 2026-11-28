/**
 * Colour meanings: amber is waiting for the user, red is blocked, green is accepted (`docs/stage.md`), and an
 * individual is drawn in its lane's colour. This lists every lane colour slot's hue and how far it sits from each
 * meaning hue, so a lane that is merely working cannot be mistaken for a meaning by colour alone.
 *
 *   node_modules/.bin/bun scripts/stage/qa-accents.ts [--slots N] [--min DEGREES]
 *
 * A slot closer than `--min` (default 20 degrees) to a meaning hue is flagged; the exit code is 1 when any is.
 */
import { HUE_AMBER, HUE_GREEN, HUE_RED, laneHue } from "../../src/view/lane/colour.ts";

const MEANINGS = { red: HUE_RED, amber: HUE_AMBER, green: HUE_GREEN } as const;

function main(): void {
	const argv = process.argv.slice(2);
	const option = (flag: string, fallback: number): number => {
		const at = argv.indexOf(flag);
		const value = at >= 0 ? Number(argv[at + 1]) : Number.NaN;
		return Number.isFinite(value) ? value : fallback;
	};
	const slots = option("--slots", 12);
	const min = option("--min", 20);
	const rows: Record<string, string>[] = [];
	let flagged = 0;
	for (let slot = 0; slot < slots; slot++) {
		const hue = laneHue(slot);
		const row: Record<string, string> = { slot: String(slot), hue: hue.toFixed(1) };
		let near = "";
		for (const [name, meaning] of Object.entries(MEANINGS)) {
			const d = Math.abs(((hue - meaning + 540) % 360) - 180);
			row[name] = d.toFixed(1);
			if (d < min) near += `${near === "" ? "" : ", "}${name}`;
		}
		row["reads as"] = near === "" ? "-" : near;
		if (near !== "") flagged++;
		rows.push(row);
	}
	console.log(`lane colour slots against the meaning hues (degrees of OKLCH hue; flagged under ${min})`);
	console.table(rows);
	console.log(`${flagged} of ${slots} slots read as a meaning colour`);
	if (flagged > 0) process.exitCode = 1;
}

if (import.meta.main) main();
