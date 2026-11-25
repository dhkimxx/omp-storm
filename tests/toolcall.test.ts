import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearRunReads, noteChildRead, openRunReads } from "../src/policy/reads.ts";
import { blockText } from "../src/policy/spawn.ts";
import { type DirectorToolCall, decideToolCall } from "../src/policy/toolcall.ts";
import type { AgentEntry, StormConfig } from "../src/types.ts";
import { agentEntry, teamOf } from "./fixtures.ts";

const RUN = "run-toolcall";
const dir = realpathSync(mkdtempSync(join(tmpdir(), "storm-toolcall-")));
writeFileSync(join(dir, "notes.md"), "line\n".repeat(10_000));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const config: StormConfig = teamOf({ implementer: "a/i" });

const agent = (over: Partial<AgentEntry> = {}): AgentEntry => agentEntry({ runId: RUN, ...over });

const call = (toolName: string, input: unknown, agents: AgentEntry[] = []): DirectorToolCall => ({
	toolName,
	input,
	cwd: dir,
	runId: RUN,
	config,
	agents,
});
const code = (toolName: string, input: unknown, agents: AgentEntry[] = []) => decideToolCall(call(toolName, input, agents))?.code;

beforeEach(() => {
	openRunReads(RUN);
	noteChildRead(RUN, "Impl", "notes.md", dir);
});
afterEach(() => clearRunReads(RUN));

describe("decideToolCall", () => {
	const big = [agent({ contextTokens: 500_000 })];
	const cleaned = [agent({ cleanedAt: 1 })];

	test("each rule answers with its own code", () => {
		expect(code("edit", { path: "src/a.ts" })).toBe("director-edit");
		expect(code("write", { path: "src/a.ts", content: "x" })).toBe("director-edit");
		expect(code("read", { path: "notes.md:1-5000" })).toBe("read-large");
		expect(code("write", { path: "agent://Impl", content: "more" }, big)).toBeUndefined();
		expect(code("write", { path: "agent://Impl", content: "more" }, cleaned)).toBe("followup-cleaned");
	});

	test("the edit rule comes first: a file write is an edit even when a cleaned agent and an indexed file are in play", () => {
		// Writing the very file a subagent read, with a cleaned agent in the ledger: still the edit rule.
		expect(code("write", { path: "notes.md", content: "x" }, cleaned)).toBe("director-edit");
		expect(code("write", { path: "ssh://box/agent://Impl", content: "x" }, cleaned)).toBe("director-edit");
		expect(code("edit", { path: "agent://Impl" }, cleaned)).toBe("director-edit");
	});

	test("the read rule comes before the follow-up rule and never sees writes", () => {
		// A read of an agent handle is no file read and no follow-up, cleaned agent or not.
		expect(code("read", { path: "agent://Impl" }, cleaned)).toBeUndefined();
		// A read of the indexed file is judged by the read rule only.
		expect(code("read", { path: "notes.md:1-50" }, cleaned)).toBeUndefined();
		// One page of omp's, whatever the file's size.
		expect(code("read", { path: "notes.md:raw" }, cleaned)).toBeUndefined();
		expect(code("read", { path: "notes.md:1-401:raw" }, cleaned)).toBe("read-large");
	});

	test("the read rule's reason follows the team's isolation", () => {
		const reason = (isolation: StormConfig["isolation"]) =>
			decideToolCall({ ...call("read", { path: "notes.md:1-5000" }), config: { ...config, isolation } })?.reason ?? "";
		expect(reason("shared")).toContain("write agent://");
		expect(reason("isolated")).not.toContain("write agent://");
	});

	test("the follow-up rule sees every ledger agent, whichever run started it", () => {
		expect(code("write", { path: "agent://Impl", content: "more" }, [agent({ runId: "run-earlier", cleanedAt: 1 })])).toBe("followup-cleaned");
		expect(code("write", { path: "agent://Impl", content: "more" }, [agent()])).toBeUndefined();
		expect(code("write", { path: "agent://Unknown", content: "more" }, cleaned)).toBeUndefined();
	});

	test("everything else runs: notes, control, searches, shell, spawns", () => {
		expect(code("write", { path: "local://plan.md", content: "x" }, cleaned)).toBeUndefined();
		expect(code("write", { path: "proc://bg_1/kill", content: "" }, cleaned)).toBeUndefined();
		for (const tool of ["grep", "glob", "bash", "eval", "task", "storm", "lsp"]) expect(code(tool, {}, cleaned)).toBeUndefined();
		expect(code("read", {}, cleaned)).toBeUndefined();
		expect(code("read", { path: 7 }, cleaned)).toBeUndefined();
	});

	test("the text for the model starts with the code", () => {
		const block = decideToolCall(call("edit", { path: "src/a.ts" }));
		expect(block && blockText(block).startsWith("[storm:director-edit] ")).toBe(true);
	});
});
