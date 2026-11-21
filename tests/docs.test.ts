import { describe, expect, test } from "bun:test";
import { docPromptFor, docsEnabled } from "../src/policy/docs.ts";

describe("doc rules", () => {
	test("docs are on unless the team set docs: false", () => {
		expect(docsEnabled({})).toBe(true);
		expect(docsEnabled({ docs: true })).toBe(true);
		expect(docsEnabled({ docs: false })).toBe(false);
	});

	test("nothing when docs are off, without a role, or for a name that is no Storm role", () => {
		for (const role of ["storm-implementer", "storm-reviewer", "storm-explorer"]) {
			expect(docPromptFor(role, { docs: false })).toBeUndefined();
		}
		expect(docPromptFor(undefined, {})).toBeUndefined();
		expect(docPromptFor("scout", {})).toBeUndefined();
		expect(docPromptFor("constructor", {})).toBeUndefined();
	});

	test("each role gets the variant it can act on; an id and its agent name are the same role", () => {
		const writer = docPromptFor("storm-implementer", {});
		const reviewer = docPromptFor("storm-reviewer", {});
		const readOnly = docPromptFor("storm-explorer", {});
		expect(docPromptFor("implementer", {})).toBe(writer);
		// Writers share one section, read-only roles another, the reviewer has its own.
		expect(docPromptFor("storm-quick", {})).toBe(writer);
		expect(docPromptFor("storm-architect", {})).toBe(readOnly);
		expect(new Set([writer, reviewer, readOnly]).size).toBe(3);
		// Only the reviewer is asked for the finding kinds the review tally counts.
		expect(reviewer).toContain("doc_conflict");
		expect(reviewer).toContain("doc_copy");
		expect(writer).not.toContain("doc_conflict");
		expect(readOnly).not.toContain("doc_conflict");
	});

	test("a read-only role gets one rule line, far shorter than the writers' section", () => {
		const readOnly = docPromptFor("storm-explorer", {}) ?? "";
		const writer = docPromptFor("storm-implementer", {}) ?? "";
		expect(readOnly.split("\n").filter(line => line.startsWith("- "))).toHaveLength(1);
		expect(readOnly.length).toBeLessThanOrEqual(250);
		expect(writer.length).toBeGreaterThan(readOnly.length * 2);
	});
});
