import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { childReaders, clearRunReads, directorRead, noteChildRead, openRunReads, readTarget } from "../src/policy/reads.ts";

const CWD = "/work/repo";
const file = (key: string, ranged = false) => ({ key, ranged, dir: false });

describe("readTarget", () => {
	test("local paths resolve against cwd and lose their selectors", () => {
		expect(readTarget("src/a.ts", CWD)).toEqual(file("/work/repo/src/a.ts"));
		expect(readTarget("./src/../src/a.ts:50-200", CWD)).toEqual(file("/work/repo/src/a.ts", true));
		expect(readTarget("/abs/b.ts:50", CWD)).toEqual(file("/abs/b.ts", true));
		expect(readTarget("~/no-such-storm-file.txt:-5", CWD)).toEqual(file(`${homedir()}/no-such-storm-file.txt`, true));
	});

	test("bounded selectors are ranged, open ends and raw alone are not", () => {
		const ranged = (p: string) => readTarget(p, CWD)?.ranged;
		expect(ranged("a.ts:50+150")).toBe(true);
		expect(ranged("a.ts:-60")).toBe(true);
		expect(ranged("a.ts:5-16,960-973")).toBe(true);
		expect(ranged("a.ts:2-4:raw")).toBe(true);
		expect(ranged("a.ts:raw:2-4")).toBe(true);
		expect(ranged("a.ts:50-")).toBe(false);
		expect(ranged("a.ts:5-16,960-")).toBe(false);
		expect(ranged("a.ts:raw")).toBe(false);
		expect(ranged("a.ts:50-:raw")).toBe(false);
		for (const p of ["a.ts:50+150", "a.ts:raw", "a.ts:2-4:raw", "a.ts:5-16,960-"]) {
			expect(readTarget(p, CWD)?.key).toBe("/work/repo/a.ts");
		}
	});

	test("colons that are not selectors stay in the path", () => {
		expect(readTarget("C:\\proj\\a.ts", CWD)?.key).toBe("/work/repo/C:\\proj\\a.ts");
		expect(readTarget("dir/a:b.ts", CWD)).toEqual(file("/work/repo/dir/a:b.ts"));
		expect(readTarget("a.ts:12abc", CWD)?.key).toBe("/work/repo/a.ts:12abc");
	});

	test("ssh paths keep host and port, the selector goes; a trailing slash is a directory", () => {
		expect(readTarget("ssh://box/etc/app.conf:10-20", CWD)).toEqual(file("ssh://box/etc/app.conf", true));
		expect(readTarget("ssh://box:2222/etc/app.conf", CWD)).toEqual(file("ssh://box:2222/etc/app.conf"));
		expect(readTarget("ssh://box:2222", CWD)?.dir).toBe(true);
		expect(readTarget("ssh://box/etc/", CWD)?.dir).toBe(true);
	});

	test("internal and remote schemes are exempt", () => {
		for (const p of [
			"agent://Impl",
			"agent://Impl/result:1-5",
			"history://Impl",
			"skill://orca-cli",
			"local://notes.md",
			"xd://lsp",
			"proc://bg_1",
			"cfg://x",
			"mcp://res",
			"omp://docs",
			"pr://12",
			"issue://3",
			"https://example.com:8443/a",
			"http://localhost:3000/",
		]) {
			expect(readTarget(p, CWD)).toBeUndefined();
		}
		expect(readTarget("  ", CWD)).toBeUndefined();
	});
});

describe("directorRead", () => {
	const repo = mkdtempSync(join(tmpdir(), "storm-reads-"));
	mkdirSync(join(repo, "src"));
	writeFileSync(join(repo, "src", "a.ts"), "x");

	beforeEach(() => {
		openRunReads("r1");
		openRunReads("r2");
	});
	afterEach(() => {
		clearRunReads("r1");
		clearRunReads("r2");
	});
	afterAll(() => rmSync(repo, { recursive: true, force: true }));

	test("plain when no subagent of the run read the file", () => {
		noteChildRead("r2", "Other", "src/a.ts", CWD);
		expect(directorRead({ runId: "r1", path: "src/a.ts", cwd: CWD })).toEqual({ kind: "plain" });
	});

	test("a whole-file read of a file a subagent read is blocked; a bounded one is a duplicate", () => {
		// The child ran in another cwd; keys are absolute.
		noteChildRead("r1", "Scout", "repo/src/a.ts", "/work");
		noteChildRead("r1", "Impl", "/work/repo/src/a.ts:raw", "/");
		noteChildRead("r1", "Scout", "src/a.ts", CWD);
		expect(childReaders("r1", "/work/repo/src/a.ts")).toEqual(["Scout", "Impl"]);

		const blocked = directorRead({ runId: "r1", path: "src/a.ts", cwd: CWD });
		expect(blocked?.kind).toBe("blocked");
		expect(blocked?.reason).toContain("agent://Scout, agent://Impl");
		expect(blocked?.reason).toContain("src/a.ts:120-180");
		expect(blocked?.reason).toContain("write agent://<id>");
		expect(directorRead({ runId: "r1", path: "src/a.ts:50-", cwd: CWD })?.kind).toBe("blocked");
		expect(directorRead({ runId: "r1", path: "src/a.ts:raw", cwd: CWD })?.kind).toBe("blocked");
		expect(directorRead({ runId: "r1", path: "src/a.ts:10-30", cwd: CWD })).toEqual({ kind: "duplicate" });
		expect(directorRead({ runId: "r1", path: "/work/repo/src/a.ts:-20", cwd: CWD })).toEqual({ kind: "duplicate" });
	});

	test("a child's ranged read does not mark the file", () => {
		noteChildRead("r1", "Scout", "src/a.ts:1-20", CWD);
		noteChildRead("r1", "Scout", "src/a.ts:-5", CWD);
		expect(directorRead({ runId: "r1", path: "src/a.ts", cwd: CWD })).toEqual({ kind: "plain" });
		noteChildRead("r1", "Scout", "src/a.ts:30-", CWD);
		expect(directorRead({ runId: "r1", path: "src/a.ts", cwd: CWD })?.kind).toBe("blocked");
	});

	test("directory listings are neither noted nor blocked", () => {
		noteChildRead("r1", "Explorer", ".", repo);
		noteChildRead("r1", "Explorer", "src", repo);
		noteChildRead("r1", "Explorer", "lib/", repo);
		expect(directorRead({ runId: "r1", path: repo, cwd: "/" })).toEqual({ kind: "plain" });
		expect(directorRead({ runId: "r1", path: "src", cwd: repo })).toEqual({ kind: "plain" });
		expect(directorRead({ runId: "r1", path: "lib/", cwd: repo })).toEqual({ kind: "plain" });
		// Even if a key were noted, the director's directory read passes.
		noteChildRead("r1", "Explorer", "src/a.ts", repo);
		expect(directorRead({ runId: "r1", path: "src/a.ts", cwd: repo })?.kind).toBe("blocked");
		expect(directorRead({ runId: "r1", path: `${repo}/src`, cwd: "/" })).toEqual({ kind: "plain" });
		noteChildRead("r1", "Ssh", "ssh://box/etc/", CWD);
		expect(directorRead({ runId: "r1", path: "ssh://box/etc/", cwd: CWD })).toEqual({ kind: "plain" });
	});

	test("many readers are cut and counted", () => {
		for (const id of ["A", "B", "C", "D", "E"]) noteChildRead("r1", id, "x.ts", CWD);
		const why = directorRead({ runId: "r1", path: "x.ts", cwd: CWD })?.reason ?? "";
		expect(why).toContain("agent://A, agent://B, agent://C 외 2개");
		expect(why).not.toContain("agent://D");
	});

	test("exempt or non-string paths are not classified or noted", () => {
		noteChildRead("r1", "Scout", "agent://Impl", CWD);
		noteChildRead("r1", "Scout", 42, CWD);
		expect(directorRead({ runId: "r1", path: "agent://Scout", cwd: CWD })).toBeUndefined();
		expect(directorRead({ runId: "r1", path: 42, cwd: CWD })).toBeUndefined();
		expect(directorRead({ runId: "r1", path: undefined, cwd: CWD })).toBeUndefined();
	});

	test("reads of runs that are not open are ignored; clearing closes the run", () => {
		noteChildRead("r1", "Scout", "src/a.ts", CWD);
		clearRunReads("r1");
		expect(childReaders("r1", "/work/repo/src/a.ts")).toEqual([]);
		// A revived agent of the finished run reads again: nothing comes back.
		noteChildRead("r1", "Scout", "src/a.ts", CWD);
		noteChildRead("never-opened", "Scout", "src/a.ts", CWD);
		expect(childReaders("r1", "/work/repo/src/a.ts")).toEqual([]);
		expect(childReaders("never-opened", "/work/repo/src/a.ts")).toEqual([]);
		expect(directorRead({ runId: "r1", path: "src/a.ts", cwd: CWD })).toEqual({ kind: "plain" });
		// Reopening an open run keeps what it has.
		openRunReads("r2");
		noteChildRead("r2", "Scout", "src/a.ts", CWD);
		openRunReads("r2");
		expect(childReaders("r2", "/work/repo/src/a.ts")).toEqual(["Scout"]);
	});
});
