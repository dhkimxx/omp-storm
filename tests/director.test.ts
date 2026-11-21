import { describe, expect, test } from "bun:test";
import { directorEditBlock } from "../src/policy/director.ts";

describe("director mode", () => {
	test("file changes are blocked, whichever tool or device carries them", () => {
		for (const [tool, input] of [
			["edit", { path: "src/a.ts" }],
			["ast_edit", {}],
			["write", { path: "src/a.ts", content: "x" }],
			["write", { path: "/tmp/scratch.txt", content: "x" }],
			["write", { path: "xd://ast_edit", content: "{}" }],
			["write", { path: "ssh://host/etc/app.conf", content: "x" }],
		] as const) {
			expect(directorEditBlock(tool, input)?.code).toBe("director-edit");
		}
	});

	test("delegation, notes, control and reading stay open", () => {
		expect(directorEditBlock("write", { path: "agent://ResidencyImpl", content: "fix the review findings" })).toBeUndefined();
		expect(directorEditBlock("write", { path: "local://plan.md", content: "x" })).toBeUndefined();
		expect(directorEditBlock("write", { path: "proc://bg_1/kill", content: "" })).toBeUndefined();
		for (const tool of ["read", "grep", "glob", "lsp", "bash", "eval", "task", "storm", "constructor"]) {
			expect(directorEditBlock(tool, {})).toBeUndefined();
		}
	});
});
