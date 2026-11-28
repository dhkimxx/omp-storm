/**
 * `bake.ts --check`, CI's guard that the baked stage art matches its sources. Each case runs the check on a copy of the
 * bake script and `assets/stage` in a temp folder: it passes as baked, and names the sequence whose sources changed,
 * appeared or went away, a missing sheet, and a changed bake tool.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, copyFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..");
const copies: string[] = [];

/** A temp folder holding the bake script, its encoder and `assets/stage`, with the repo's node_modules linked in. */
function copy(): string {
	const dir = mkdtempSync(join(tmpdir(), "storm-bake-check-"));
	copies.push(dir);
	mkdirSync(join(dir, "scripts/stage"), { recursive: true });
	for (const name of ["bake.ts", "png.ts"]) copyFileSync(join(REPO, "scripts/stage", name), join(dir, "scripts/stage", name));
	cpSync(join(REPO, "assets/stage"), join(dir, "assets/stage"), { recursive: true });
	symlinkSync(join(REPO, "node_modules"), join(dir, "node_modules"));
	return dir;
}

function check(dir: string): { code: number; out: string } {
	const run = Bun.spawnSync([process.execPath, "scripts/stage/bake.ts", "--check"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
	return { code: run.exitCode, out: `${run.stdout.toString()}${run.stderr.toString()}` };
}

afterEach(() => {
	for (const dir of copies.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("bake --check", () => {
	test("passes when index.json matches the sources", () => {
		const result = check(copy());
		expect(result.out).toContain("stage assets match their sources");
		expect(result.code).toBe(0);
	});

	test("names a sequence whose key SVG changed", () => {
		const dir = copy();
		appendFileSync(join(dir, "assets/stage/src/octopus/worker/rest.a.svg"), "<!-- moved -->\n");
		const result = check(dir);
		expect(result.code).toBe(1);
		expect(result.out).toContain("octopus/worker/rest: sources changed since the last bake");
	});

	test("names a sequence with sources but no bake, and a bake whose sources are gone", () => {
		const dir = copy();
		const src = join(dir, "assets/stage/src/octopus/worker");
		copyFileSync(join(src, "rest.json"), join(src, "rest-again.json"));
		rmSync(join(src, "quiet.json"));
		const result = check(dir);
		expect(result.code).toBe(1);
		expect(result.out).toContain("octopus/worker/rest-again: has sources but is not baked");
		expect(result.out).toContain("octopus/worker/quiet: baked, but its sources are gone");
	});

	test("names a missing sheet", () => {
		const dir = copy();
		rmSync(join(dir, "assets/stage/octopus/worker/rest.t2.png"));
		const result = check(dir);
		expect(result.code).toBe(1);
		expect(result.out).toContain("octopus/worker/rest: octopus/worker/rest.t2.png is missing");
	});

	test("asks for a rebake when the bake tool changed", () => {
		const dir = copy();
		appendFileSync(join(dir, "scripts/stage/png.ts"), "\n// changed\n");
		const result = check(dir);
		expect(result.code).toBe(1);
		expect(result.out).toContain("rebake needed");
	});
});
