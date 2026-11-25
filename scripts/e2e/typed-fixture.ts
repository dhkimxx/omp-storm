/**
 * A typed, source-backed answer fixture shared by the admission / routing / rework / closeout scenarios.
 *
 * Those scenarios test admission, rework, routing and closeout, not whether an answer is semantically right. A
 * tracked-line answer is only accepted by the official answer evidence when the answer and the cited source agree
 * mechanically: the same text, or the same typed `key: value` (a signed number, a boolean, null or a quoted string). The
 * old fixture line is untyped prose and a prose claim about it is `reviewable`, which needs an approved reviewer's
 * scoped verdict; that is correct product behavior and is covered by the qualitative review smoke, not here.
 *
 * So the fixture states one signed typed value on one real line of a committed file, and the claim restates exactly
 * that value and cites its real location. The sign is deliberate: `-7` must never pass for `7`.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

/** Same width as `e2e-tracked.txt`, so a result label naming it wraps exactly as before. */
export const FACT_FILE = "e2e-answers.txt";
export const FACT_LINE = "tracked_delta: -7";
export const FACT_TEXT = `${FACT_LINE}\n`;
/** The answer a worker submits: the typed value of the cited key, with its citation as the only trailing reference. */
export const FACT_CLAIM = `The tracked_delta is -7 (${FACT_FILE}:1)`;

/**
 * Write and commit the fixture before any run starts, so the parent tree is clean and every worker (shared or isolated)
 * sees the same committed line. The repository identity is already configured by `prepare`.
 */
export function seedFact(project: string): void {
	writeFileSync(join(project, FACT_FILE), FACT_TEXT);
	for (const args of [
		["add", "--", FACT_FILE],
		["commit", "-q", "-m", "e2e typed answer fixture"],
	]) {
		const step = Bun.spawnSync(["git", "-C", project, ...args]);
		if (step.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${step.stderr.toString()}`);
	}
}
