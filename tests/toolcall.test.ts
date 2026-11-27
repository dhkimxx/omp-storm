import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DIRECTOR_EDIT_LEAD } from "../src/policy/director.ts";
import { blockText } from "../src/policy/spawn.ts";
import { type DirectorPathCall, decideDirectorCall } from "../src/policy/toolcall.ts";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "storm-toolcall-")));
writeFileSync(join(dir, "notes.md"), "line\n".repeat(10_000));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("decideDirectorCall", () => {
	const decide = (toolName: string, input: unknown, over: Partial<DirectorPathCall> = {}) =>
		decideDirectorCall({ toolName, input, cwd: dir, root: dir, ...over });
	const edit = (p: string) => ({ path: p, old_string: "a", new_string: "b" });

	test("a path edit with exact targets in the run's tree is handed to the write table with those paths, not refused", () => {
		expect(decide("edit", edit("src/a.ts"))).toEqual({ kind: "director-path", paths: ["src/a.ts"] });
		expect(decide("write", { path: "notes.md", content: "x" })).toEqual({ kind: "director-path", paths: ["notes.md"] });
		expect(decide("ast_edit", { ops: [{ pat: "a", out: "b" }], paths: ["src"] })).toEqual({ kind: "director-path", paths: ["src"] });
	});

	test("a file change whose targets cannot be named is a director-edit block with the cause", () => {
		for (const [tool, input] of [
			["edit", edit("../outside.ts")],
			["edit", edit(".git/config")],
			["write", { path: "ssh://box/x", content: "x" }],
			["write", { path: "vault://x.md", content: "x" }],
			["edit", { input: "nothing a parser reads" }],
		] as const) {
			const decision = decide(tool, input);
			expect(decision.kind, `${tool} ${JSON.stringify(input)}`).toBe("block");
			if (decision.kind === "block") {
				expect(decision.block.code).toBe("director-edit");
				expect(blockText(decision.block).startsWith("[storm:director-edit] ")).toBe(true);
				expect(decision.block.reason).toContain(DIRECTOR_EDIT_LEAD);
			}
		}
	});

	test("a call another tool dispatched is blocked; a call that changes no file runs whoever dispatched it", () => {
		expect(decide("edit", edit("src/a.ts"), { parentToolCallId: "call-eval-1" }).kind).toBe("block");
		expect(decide("read", { path: "notes.md" }, { parentToolCallId: "call-eval-1" })).toEqual({ kind: "allow" });
	});

	test("notes, messages, control, searches, shell and spawns are allowed here; other rules decide them", () => {
		expect(decide("write", { path: "agent://Impl", content: "more" })).toEqual({ kind: "allow" });
		expect(decide("write", { path: "local://plan.md", content: "x" })).toEqual({ kind: "allow" });
		expect(decide("write", { path: "proc://bg_1/kill", content: "" })).toEqual({ kind: "allow" });
		for (const tool of ["grep", "glob", "bash", "eval", "task", "storm", "lsp", "read"]) expect(decide(tool, {}), tool).toEqual({ kind: "allow" });
	});

	test("a large read and a follow-up are no file change: context size is compacted and omp answers a follow-up itself", () => {
		for (const input of [{ path: "notes.md:1-5000" }, { path: "notes.md:1-401:raw" }, { path: "notes.md" }, { path: "agent://Impl" }, {}, { path: 7 }]) {
			expect(decide("read", input), JSON.stringify(input)).toEqual({ kind: "allow" });
		}
		for (const path of ["agent://Impl", "agent://Impl?progress"]) {
			expect(decide("write", { path, content: "more" }), path).toEqual({ kind: "allow" });
		}
	});

	test("the mode of the edit grammar and the real-path function reach the parser", () => {
		const magic = { input: "# src/a.ts\nrename foo to bar" };
		expect(decide("edit", magic, { editMode: "magic" })).toEqual({ kind: "director-path", paths: ["src/a.ts"] });
		expect(decide("edit", { input: "*** Begin Patch\n*** Add File: n.txt\n+hi\n*** End Patch" }, { editMode: "hashline" }).kind).toBe("block");
		// The caller's real-path function is the one asked: a file it places outside the tree is refused.
		expect(decide("edit", edit("a.ts"), { realpath: target => (target.endsWith("a.ts") ? "/elsewhere/a.ts" : realpathSync(target)) }).kind).toBe("block");
	});
});
