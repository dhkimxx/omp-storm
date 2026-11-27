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
	const cleaned = [agent({ cleanedAt: 1 })];

	test("a file change by the director is the one thing it refuses", () => {
		expect(code("edit", { path: "src/a.ts" })).toBe("director-edit");
		expect(code("write", { path: "src/a.ts", content: "x" })).toBe("director-edit");
		// A file write is an edit even when the file is one a subagent read and the agent is cleaned.
		expect(code("write", { path: "notes.md", content: "x" }, cleaned)).toBe("director-edit");
		expect(code("write", { path: "ssh://box/agent://Impl", content: "x" }, cleaned)).toBe("director-edit");
		expect(code("edit", { path: "agent://Impl" }, cleaned)).toBe("director-edit");
	});

	test("a large read of a file a subagent of the run read runs: context size is compacted, not refused", () => {
		// The same call the old read rule refused with `read-large`.
		expect(code("read", { path: "notes.md:1-5000" })).toBeUndefined();
		expect(code("read", { path: "notes.md:1-401:raw" })).toBeUndefined();
		expect(code("read", { path: "notes.md" })).toBeUndefined();
		expect(code("read", { path: "agent://Impl" }, cleaned)).toBeUndefined();
		expect(code("read", {}, cleaned)).toBeUndefined();
		expect(code("read", { path: 7 }, cleaned)).toBeUndefined();
	});

	test("a follow-up to a cleaned agent runs, whichever run started it: omp answers it", () => {
		// The same calls the old follow-up rule refused with `followup-cleaned`.
		expect(code("write", { path: "agent://Impl", content: "more" }, cleaned)).toBeUndefined();
		expect(code("write", { path: "agent://Impl", content: "more" }, [agent({ runId: "run-earlier", cleanedAt: 1 })])).toBeUndefined();
		expect(code("write", { path: "agent://Impl?progress", content: "more" }, cleaned)).toBeUndefined();
		expect(code("write", { path: "agent://Impl", content: "more" }, [agent({ contextTokens: 500_000 })])).toBeUndefined();
	});

	test("everything else runs: notes, control, searches, shell, spawns", () => {
		expect(code("write", { path: "local://plan.md", content: "x" }, cleaned)).toBeUndefined();
		expect(code("write", { path: "proc://bg_1/kill", content: "" }, cleaned)).toBeUndefined();
		for (const tool of ["grep", "glob", "bash", "eval", "task", "storm", "lsp"]) expect(code(tool, {}, cleaned)).toBeUndefined();
	});

	test("the text for the model starts with the code and names the cause", () => {
		const block = decideToolCall(call("edit", { path: "src/a.ts" }));
		expect(block && blockText(block).startsWith("[storm:director-edit] ")).toBe(true);
		expect(block?.reason).toContain("레인");
	});
});
