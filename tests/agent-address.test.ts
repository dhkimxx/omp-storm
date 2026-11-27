import { expect, test } from "bun:test";
import { agentAddress, handleAddress, hasProgressFlag } from "../src/policy/agent-address.ts";
import { agentControlTarget, followUpProgress, followUpTarget } from "../src/policy/followup.ts";

test("an agent address is read the way omp reads it: the scheme in any case, the single slash, a hashline wrapper, decoded segments", () => {
	expect(agentAddress("agent://A")).toEqual({ id: "A", segments: [], query: "" });
	expect(agentAddress("Agent://A/model")).toEqual({ id: "A", segments: ["model"], query: "" });
	expect(agentAddress("AGENT://A/%6Dodel?x=1")).toEqual({ id: "A", segments: ["model"], query: "x=1" });
	expect(agentAddress("agent://%41/%65ffort/")).toEqual({ id: "A", segments: ["effort"], query: "" });
	expect(agentAddress("agent:/A?progress")).toEqual({ id: "A", segments: [], query: "progress" });
	expect(agentAddress("[agent://A/model#ABCD]")).toEqual({ id: "A", segments: ["model"], query: "" });
	expect(agentAddress("agent://A/%E0%A4%A")?.segments).toEqual(["%E0%A4%A"]);
	expect(agentAddress("local://note.md")).toBeUndefined();
	expect(agentAddress("a.txt")).toBeUndefined();
	expect(agentAddress("xagent://A")).toBeUndefined();
	expect(hasProgressFlag(agentAddress("agent://A?progress")!)).toBe(true);
	expect(hasProgressFlag(agentAddress("agent://A?progress=1&x")!)).toBe(true);
	expect(hasProgressFlag(agentAddress("agent://A?noprogress")!)).toBe(false);
});

test("dot segments are resolved as omp's URL parser resolves them (R-final N1), and a path the parser rejects stays as typed", () => {
	expect(agentAddress("agent://A/./model")?.segments).toEqual(["model"]);
	expect(agentAddress("agent://A/x/../model")?.segments).toEqual(["model"]);
	expect(agentAddress("agent://A/%2e/effort")?.segments).toEqual(["effort"]);
	expect(agentAddress("agent://A/%2E%2e/model")?.segments).toEqual(["model"]);
	expect(agentAddress("agent://A/..")?.segments).toEqual([]);
	expect(agentAddress("agent://A/a/./b/../c?progress")).toEqual({ id: "A", segments: ["a", "c"], query: "progress" });
	// The parser throws on a space in the host: omp keeps the raw path then, and so does the reader.
	expect(agentAddress("agent://a b/./model")?.segments).toEqual([".", "model"]);
	// The history handle is read the same way.
	expect(handleAddress("History://Impl/./x", "history")).toEqual({ id: "Impl", segments: ["x"], query: "" });
	expect(handleAddress("agent://Impl", "history")).toBeUndefined();
});

test("the follow-up and control tests read every spelling the same way", () => {
	const write = (path: string) => ({ path, content: "x" });
	for (const path of ["agent://A/model", "Agent://A/Model", "agent://A/%6dodel", "agent://A/%45ffort?x=1", "[agent://A/effort#ZZ99]", "agent://A/./model", "agent://A/x/../effort", "agent://A/%2e/model"]) {
		expect(agentControlTarget("write", write(path))).toMatch(/^(model|effort)$/);
	}
	for (const path of ["agent://A", "AGENT://A?progress", "agent://A/other", "a/model"]) {
		expect(agentControlTarget("write", write(path))).toBeUndefined();
	}
	expect(followUpTarget("write", write("AGENT://%42"))).toBe("B");
	expect(followUpTarget("write", write("a.txt"))).toBeUndefined();
	expect(followUpTarget("read", write("agent://B"))).toBeUndefined();
	expect(followUpProgress("write", write("Agent://B?progress"))).toBe(true);
	expect(followUpProgress("write", write("agent://B"))).toBe(false);
});
