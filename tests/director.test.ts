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

	// R-final N5: every scheme whose write omp 19.2.1 lands in the work tree is a file change, whatever the case of its scheme.
	test("a scheme whose write lands in the work tree is a file change in every case; the ones that write no file stay open", () => {
		for (const path of ["conflict://1", "conflict://*", "Conflict://2", "CONFLICT://1", "vault://notes/x.md", "Vault://x.md", "XD://edit/a.txt", "xd://AST_edit", "SSH://h/x", "  conflict://1  "]) {
			expect(directorEditBlock("write", { path, content: "x" })?.code, path).toBe("director-edit");
		}
		// cfg:// asks the user before it changes a setting; proc:// kills a job; out:// and agent:// carry messages.
		for (const path of ["cfg://settings/task.maxConcurrency", "proc://bg_1/kill", "out://report.md", "agent://A?progress", "local://notes.md"]) {
			expect(directorEditBlock("write", { path, content: "x" }), path).toBeUndefined();
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
