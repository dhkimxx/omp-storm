import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
	clearRunReads,
	directorRead,
	PAGE_LINES,
	noteChildRead,
	openRunReads,
	readTarget,
} from "../src/policy/reads.ts";

const CWD = "/work/repo";

/** Real files of known sizes: the index stats what the director reads to tell a file from a directory. */
const dir = realpathSync(mkdtempSync(join(tmpdir(), "storm-reads-")));
const BIG = "x".repeat(79) + "\n";
const big = BIG.repeat(Math.ceil((16 * 1024 + 1) / BIG.length));
const files = {
	"big.ts": big,
	"big.md": big,
	"big.txt": big,
	"big.log": big,
	"big": big,
	"small.md": "short\n",
	"huge.ts": "z".repeat(2 * 1024 * 1024 + 1),
};
for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
mkdirSync(join(dir, "sub"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("readTarget", () => {
	test("local paths resolve against cwd and lose their selectors", () => {
		expect(readTarget("src/a.ts", CWD)?.key).toBe("/work/repo/src/a.ts");
		expect(readTarget("./src/../src/a.ts:50-200", CWD)?.key).toBe("/work/repo/src/a.ts");
		expect(readTarget("/abs/b.ts:50", CWD)?.key).toBe("/abs/b.ts");
		expect(readTarget("~/no-such-storm-file.txt:-5", CWD)?.key).toBe(`${homedir()}/no-such-storm-file.txt`);
		for (const p of ["a.ts:50+150", "a.ts:raw", "a.ts:2-4:raw", "a.ts:raw:2-4", "a.ts:5-16,960-"]) {
			expect(readTarget(p, CWD)?.key).toBe("/work/repo/a.ts");
		}
	});

	test("the selector's ranges add up to the lines it asks for; an open end and a read without ranges count one page", () => {
		const lines = (p: string) => readTarget(p, CWD)?.lines;
		expect(PAGE_LINES).toBe(300);
		expect(lines("a.ts")).toBe(PAGE_LINES);
		expect(lines("a.ts:raw")).toBe(PAGE_LINES);
		expect(lines("a.ts:50")).toBe(1);
		expect(lines("a.ts:50-200")).toBe(151);
		expect(lines("a.ts:50+150")).toBe(150);
		expect(lines("a.ts:-60")).toBe(60);
		expect(lines("a.ts:5-16,960-973")).toBe(26);
		expect(lines("a.ts:2-4:raw")).toBe(3);
		expect(lines("a.ts:raw:2-4")).toBe(3);
		expect(lines("a.ts:50-")).toBe(PAGE_LINES);
		expect(lines("a.ts:5-16,960-")).toBe(12 + PAGE_LINES);
	});

	test("`raw` is a selector in any case, as omp reads it", () => {
		for (const p of ["a.ts:RAW", "a.ts:Raw:1-5000", "a.ts:1-5000:rAw"]) expect(readTarget(p, CWD)?.key).toBe("/work/repo/a.ts");
		expect(readTarget("a.ts:Raw:1-5000", CWD)?.lines).toBe(5000);
	});

	test("colons that are not selectors stay in the path", () => {
		expect(readTarget("C:\\proj\\a.ts", CWD)?.key).toBe("/work/repo/C:\\proj\\a.ts");
		expect(readTarget("dir/a:b.ts", CWD)?.key).toBe("/work/repo/dir/a:b.ts");
		expect(readTarget("a.ts:12abc", CWD)?.key).toBe("/work/repo/a.ts:12abc");
	});

	test("ssh paths keep host and port; a trailing slash is a directory", () => {
		expect(readTarget("ssh://box/etc/app.conf:10-20", CWD)).toMatchObject({ key: "ssh://box/etc/app.conf", remote: true, lines: 11, dir: false });
		expect(readTarget("ssh://box:2222/etc/app.conf", CWD)?.key).toBe("ssh://box:2222/etc/app.conf");
		expect(readTarget("ssh://box:2222", CWD)?.dir).toBe(true);
		expect(readTarget("ssh://box/etc/", CWD)?.dir).toBe(true);
	});

	test("local files are files, directories are listings, missing files are neither", () => {
		expect(readTarget("small.md", dir)).toMatchObject({ dir: false, remote: false });
		expect(readTarget("sub", dir)?.dir).toBe(true);
		expect(readTarget("sub/", dir)?.dir).toBe(true);
		expect(readTarget("nope.ts", dir)).toMatchObject({ dir: false });
	});

	test("internal and remote schemes are exempt", () => {
		for (const p of ["agent://Impl", "agent://Impl/result:1-5", "history://Impl", "skill://x", "local://notes.md", "xd://lsp", "proc://bg_1", "https://example.com/a.ts", ""]) {
			expect(readTarget(p, CWD)).toBeUndefined();
		}
	});
});

describe("director reads are indexed, never refused", () => {
	const RUN = "run-reads";
	beforeEach(() => openRunReads(RUN));
	afterEach(() => clearRunReads(RUN));

	const childRead = (path: string, agent = "Scout") => noteChildRead(RUN, agent, path, dir);
	const read = (path: string) => directorRead({ runId: RUN, path, cwd: dir });

	test("a file no subagent of the run read is not indexed", () => {
		for (const p of ["big.md", "big.md:raw", "big.md:1-5000", "big.log", "ssh://box/var/log/app.log"]) {
			expect(read(p)).toEqual({ indexed: false });
		}
	});

	test("a wide read of a file a subagent read is classified, with no block: the old `read-large` refusal is gone", () => {
		childRead("big.md");
		childRead("big.ts");
		childRead("ssh://box/var/log/app.log:1-20");
		for (const p of ["big.md:1-401", "big.md:1-99999", "big.md:1+401:raw", "big.md:1-300,500-600", "big.ts:1-99999", "ssh://box/var/log/app.log:1-401"]) {
			const result = read(p);
			expect(result).toEqual({ indexed: true });
			expect(result).not.toHaveProperty("block");
		}
	});

	test("every subagent read indexes its file, ranged or not", () => {
		childRead("big.md:10-20");
		childRead("big.ts");
		childRead("big.log:raw");
		for (const p of ["big.md", "big.ts", "big.log"]) expect(read(`${p}:1-10`)).toEqual({ indexed: true });
	});

	test("a read without an end returns one page of omp's, so it passes at any file size: bare, :raw, open-ended", () => {
		for (const name of ["big.md", "big.txt", "big.log", "big", "big.ts", "huge.ts"]) {
			childRead(name);
			for (const selector of ["", ":raw", ":50-", ":RAW"]) expect(read(`${name}${selector}`)).toEqual({ indexed: true });
		}
	});

	test("the selector's case does not hide a file from the index", () => {
		childRead("big.md:Raw");
		expect(read("big.md:RAW:1-5000")).toEqual({ indexed: true });
		expect(read("big.md:RAW:1-10")).toEqual({ indexed: true });
	});

	test("another host's file of the same path is another file", () => {
		childRead("ssh://box/var/log/app.log:1-20");
		expect(read("ssh://box/var/log/app.log")).toEqual({ indexed: true });
		expect(read("ssh://other/var/log/app.log")).toEqual({ indexed: false });
	});

	test("a file that is gone, a directory and an exempt path are classified without a block", () => {
		childRead("gone.md");
		expect(read("gone.md")).toEqual({ indexed: true });
		childRead("sub");
		expect(read("sub")).toEqual({ indexed: false });
		childRead("agent://Impl");
		expect(read("agent://Scout")).toBeUndefined();
		expect(directorRead({ runId: RUN, path: 42, cwd: dir })).toBeUndefined();
		expect(directorRead({ runId: RUN, path: undefined, cwd: dir })).toBeUndefined();
	});

	test("the index is per run and closes with it", () => {
		childRead("big.md");
		expect(directorRead({ runId: "other-run", path: "big.md", cwd: dir })).toEqual({ indexed: false });
		clearRunReads(RUN);
		// A revived agent of the finished run reads again: nothing is indexed.
		childRead("big.md");
		noteChildRead("never-opened", "Scout", "big.md", dir);
		expect(read("big.md")).toEqual({ indexed: false });
		expect(directorRead({ runId: "never-opened", path: "big.md", cwd: dir })).toEqual({ indexed: false });
		// Reopening an open run keeps what it has.
		openRunReads(RUN);
		childRead("big.md");
		openRunReads(RUN);
		expect(read("big.md:1-5")).toEqual({ indexed: true });
	});
});
