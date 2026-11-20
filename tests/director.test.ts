import { describe, expect, test } from "bun:test";
import { directorBlocks } from "../src/policy/director.ts";

describe("director mode", () => {
	test("file changes are blocked, whichever tool or device carries them", () => {
		expect(directorBlocks("edit", { path: "src/a.ts" })).toBe(true);
		expect(directorBlocks("ast_edit", {})).toBe(true);
		expect(directorBlocks("write", { path: "src/a.ts", content: "x" })).toBe(true);
		expect(directorBlocks("write", { path: "/tmp/scratch.txt", content: "x" })).toBe(true);
		expect(directorBlocks("write", { path: "xd://ast_edit", content: "{}" })).toBe(true);
		expect(directorBlocks("write", { path: "ssh://host/etc/app.conf", content: "x" })).toBe(true);
	});

	test("delegation, notes, control and reading stay open", () => {
		expect(directorBlocks("write", { path: "agent://ResidencyImpl", content: "fix the review findings" })).toBe(false);
		expect(directorBlocks("write", { path: "local://plan.md", content: "x" })).toBe(false);
		expect(directorBlocks("write", { path: "proc://bg_1/kill", content: "" })).toBe(false);
		for (const tool of ["read", "grep", "glob", "lsp", "bash", "eval", "task", "storm", "constructor"]) {
			expect(directorBlocks(tool, {})).toBe(false);
		}
	});
});
