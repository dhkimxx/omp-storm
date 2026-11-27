import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	DIRECTOR_EDIT_CAUSES,
	DIRECTOR_EDIT_LEAD,
	directorEditDecision,
	directorEditRefusal,
	directorFileChange,
} from "../src/policy/director.ts";
import type { TargetCause } from "../src/policy/director-targets.ts";
import { blockText } from "../src/policy/spawn.ts";

describe("director mode", () => {
	test("file changes are recognised, whichever tool or device carries them: a path tool or an address that lands in the tree", () => {
		for (const [tool, input, kind] of [
			["edit", { path: "src/a.ts" }, "path"],
			["ast_edit", {}, "path"],
			["write", { path: "src/a.ts", content: "x" }, "path"],
			["write", { path: "/tmp/scratch.txt", content: "x" }, "path"],
			["write", { path: "xd://ast_edit", content: "{}" }, "address"],
			["write", { path: "ssh://host/etc/app.conf", content: "x" }, "address"],
		] as const) {
			expect(directorFileChange(tool, input), `${tool} ${JSON.stringify(input)}`).toBe(kind);
		}
	});

	// R-final N5: every scheme whose write omp 19.2.1 lands in the work tree is a file change, whatever the case of its scheme. The
	// director's own write to one is still refused (it names no file the table can order), with the address cause.
	test("a scheme whose write lands in the work tree is a file change in every case and stays refused; the ones that write no file stay open", () => {
		const env = { root: "/nonexistent-tree", cwd: "/nonexistent-tree" };
		for (const path of ["conflict://1", "conflict://*", "Conflict://2", "CONFLICT://1", "vault://notes/x.md", "Vault://x.md", "XD://edit/a.txt", "xd://AST_edit", "SSH://h/x", "  conflict://1  "]) {
			expect(directorFileChange("write", { path, content: "x" }), path).toBe("address");
			expect(directorEditDecision("write", { path, content: "x" }, env), path).toEqual({ kind: "refuse", block: directorEditRefusal("address") });
		}
		// cfg:// asks the user before it changes a setting; proc:// kills a job; out:// and agent:// carry messages.
		for (const path of ["cfg://settings/task.maxConcurrency", "proc://bg_1/kill", "out://report.md", "agent://A?progress", "local://notes.md"]) {
			expect(directorFileChange("write", { path, content: "x" }), path).toBeUndefined();
			expect(directorEditDecision("write", { path, content: "x" }, env), path).toEqual({ kind: "none" });
		}
	});

	test("delegation, notes, control and reading stay open", () => {
		const env = { root: "/nonexistent-tree", cwd: "/nonexistent-tree" };
		for (const [tool, input] of [
			["write", { path: "agent://ResidencyImpl", content: "fix the review findings" }],
			["write", { path: "local://plan.md", content: "x" }],
			["write", { path: "proc://bg_1/kill", content: "" }],
		] as const) {
			expect(directorEditDecision(tool, input, env), tool).toEqual({ kind: "none" });
		}
		for (const tool of ["read", "grep", "glob", "lsp", "bash", "eval", "task", "storm", "constructor"]) {
			expect(directorFileChange(tool, {}), tool).toBeUndefined();
			expect(directorEditDecision(tool, {}, env), tool).toEqual({ kind: "none" });
		}
	});
});

describe("which director calls change files, and which of those Storm can name", () => {
	let base = "";
	let root = "";
	beforeAll(() => {
		base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "storm-director-")));
		root = path.join(base, "tree");
		fs.mkdirSync(path.join(root, "src"), { recursive: true });
		fs.mkdirSync(path.join(root, ".git"), { recursive: true });
		fs.mkdirSync(path.join(base, "other"), { recursive: true });
		fs.writeFileSync(path.join(root, "src/a.ts"), "a\n");
	});
	afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

	const decide = (tool: string, input: unknown, parentToolCallId?: string) =>
		directorEditDecision(tool, input, { root, cwd: root, ...(parentToolCallId === undefined ? {} : { parentToolCallId }) });

	test("a path tool is a path call, an address that lands in the tree is an address change, and notes and messages are neither", () => {
		for (const tool of ["edit", "ast_edit", "apply_patch", "multi_edit", "notebook_edit"]) expect(directorFileChange(tool, {}), tool).toBe("path");
		for (const target of ["src/a.ts", "/tmp/x", "[a.ts#ABCD]", ""]) expect(directorFileChange("write", { path: target, content: "x" }), target).toBe("path");
		for (const target of ["ssh://host/x", "xd://edit/a.txt", "XD://ast_edit", "conflict://1", "Conflict://2", "vault://x.md", "  conflict://1  "]) {
			expect(directorFileChange("write", { path: target, content: "x" }), target).toBe("address");
		}
		for (const target of ["agent://Impl", "agent://A?progress", "local://notes.md", "proc://bg_1/kill", "cfg://settings/x", "out://report.md"]) {
			expect(directorFileChange("write", { path: target, content: "x" }), target).toBeUndefined();
		}
		for (const tool of ["read", "grep", "glob", "lsp", "bash", "eval", "task", "storm", "constructor"]) expect(directorFileChange(tool, {}), tool).toBeUndefined();
	});

	test("a path call whose targets are exact is handed on with them, so the table can order it", () => {
		expect(decide("edit", { path: "src/a.ts", old_string: "a", new_string: "b" })).toEqual({ kind: "path", paths: ["src/a.ts"] });
		expect(decide("write", { path: "src/new.ts", content: "x" })).toEqual({ kind: "path", paths: ["src/new.ts"] });
		expect(decide("ast_edit", { ops: [{ pat: "a", out: "b" }], paths: ["src/**/*.ts"] })).toEqual({ kind: "path", paths: ["src"] });
		expect(decide("edit", { input: "[src/a.ts#ABCD]\nREM\n" })).toEqual({ kind: "path", paths: ["src/a.ts"] });
	});

	test("what is no file change is left to the other rules", () => {
		for (const [tool, input] of [["write", { path: "agent://Impl", content: "go" }], ["write", { path: "local://plan.md", content: "x" }], ["bash", { command: "ls" }], ["read", { path: "src/a.ts" }]] as const) {
			expect(decide(tool, input), tool).toEqual({ kind: "none" });
		}
		// A call another tool dispatched that changes no file is not this rule's business either.
		expect(decide("read", { path: "src/a.ts" }, "call-1")).toEqual({ kind: "none" });
	});

	test("a call whose files cannot be named is refused, each with its own cause", () => {
		const cases: Array<[string, unknown, TargetCause, string?]> = [
			["edit", { input: "no section here" }, "unknown"],
			["multi_edit", { edits: [{ path: "src/a.ts" }] }, "unknown"],
			["write", { path: "~/x", content: "x" }, "unknown"],
			["edit", { path: "../other/x.ts", old_string: "a", new_string: "b" }, "outside", "../other/x.ts"],
			["write", { path: "/etc/hosts", content: "x" }, "outside", "/etc/hosts"],
			["write", { path: ".git/config", content: "x" }, "internal"],
			["edit", { path: ".omp/x", old_string: "a", new_string: "b" }, "internal"],
			["write", { path: "ssh://host/etc/app.conf", content: "x" }, "address"],
			["write", { path: "xd://edit/a.txt", content: "x" }, "address"],
			["write", { path: "vault://notes/x.md", content: "x" }, "address"],
		];
		const reasons = new Set<string>();
		for (const [tool, input, cause, shown] of cases) {
			const decision = decide(tool, input);
			expect(decision.kind, `${tool} ${JSON.stringify(input)}`).toBe("refuse");
			if (decision.kind !== "refuse") continue;
			expect(decision.block.code).toBe("director-edit");
			expect(decision.block.reason.startsWith(DIRECTOR_EDIT_LEAD)).toBe(true);
			expect(decision.block).toEqual(directorEditRefusal(cause, shown));
			if (shown !== undefined) expect(decision.block.reason).toContain(shown);
			reasons.add(decision.block.reason);
		}
		// Five causes, five different things for the director to do.
		expect(new Set([...Object.keys(DIRECTOR_EDIT_CAUSES)]).size).toBe(5);
		expect(reasons.size).toBeGreaterThanOrEqual(5);
	});

	test("a call another tool dispatched is refused even for a path that is fine", () => {
		const decision = decide("edit", { path: "src/a.ts", old_string: "a", new_string: "b" }, "call-eval-1");
		expect(decision.kind).toBe("refuse");
		if (decision.kind === "refuse") expect(decision.block).toEqual(directorEditRefusal("dispatched"));
	});

	test("the text for the model starts with the code and its lead, keeps a long or odd path on one line, and does not repeat a path unasked", () => {
		const block = directorEditRefusal("outside", `/x/${"y".repeat(400)}\nnext line`);
		expect(blockText(block).startsWith(`[storm:director-edit] ${DIRECTOR_EDIT_LEAD}`)).toBe(true);
		expect(block.reason).not.toContain("\n");
		expect(block.reason.length).toBeLessThan(DIRECTOR_EDIT_LEAD.length + 400);
		expect(directorEditRefusal("internal").reason).not.toContain("undefined");
	});
});
