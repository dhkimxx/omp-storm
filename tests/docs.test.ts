import { describe, expect, test } from "bun:test";
import { docContractLines, docPromptFor, docsEnabled } from "../src/policy/docs.ts";

describe("doc rules", () => {
	test("docs are on unless the team set docs: false", () => {
		expect(docsEnabled({})).toBe(true);
		expect(docsEnabled({ docs: true })).toBe(true);
		expect(docsEnabled({ docs: false })).toBe(false);
	});

	test("role prompt: facts rule for every role, nothing when off or without a role", () => {
		const impl = docPromptFor("storm-implementer", {});
		expect(impl).toContain("Code and observed behavior");
		expect(impl).toContain("fix the docs that mention it");
		expect(impl).toContain("local://");
		expect(impl).not.toContain("doc_conflict");
		expect(docPromptFor("implementer", {})).toBe(impl);
		expect(docPromptFor("storm-implementer", { docs: false })).toBeUndefined();
		expect(docPromptFor("storm-reviewer", { docs: false })).toBeUndefined();
		expect(docPromptFor(undefined, {})).toBeUndefined();
	});

	test("reviewer variant asks for doc findings with kinds; read-only roles report instead of fixing", () => {
		const rev = docPromptFor("storm-reviewer", {});
		expect(rev).toContain('kind: "doc_conflict"');
		expect(rev).toContain('kind: "doc_copy"');
		expect(rev).not.toContain("fix the docs that mention it");
		const explorer = docPromptFor("storm-explorer", {});
		expect(explorer).toContain("report which side is wrong");
		expect(explorer).not.toContain("fix the docs that mention it");
	});

	test("director contract lines exist only while docs are on", () => {
		expect(docContractLines({}).length).toBeGreaterThan(0);
		expect(docContractLines({}).join("\n")).toContain("코드 현황");
		expect(docContractLines({ docs: false })).toEqual([]);
	});
});
