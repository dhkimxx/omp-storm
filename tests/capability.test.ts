import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
	canonicalScope,
	effectiveAgentTools,
	lanePolicy,
	parseToolsFrontmatter,
	pathsOverlap,
	readOnlyTool,
	scopesOverlap,
	shellReviewer,
	targetWithinScope,
	toolCapability,
	toolWriteTargets,
	WHY_EXEC_WRITER,
	WHY_UNDECLARED_WRITER,
} from "../src/policy/capability.ts";
import type { PlanLane, ShadowInfo } from "../src/types.ts";

const lane = (over: Partial<PlanLane>): PlanLane => ({ name: "lane", kind: "code", role: "implementer", ...over });

describe("effective tool capability", () => {
	test("an absent list or an exec tool is never read-only", () => {
		expect(toolCapability(undefined)).toEqual({ readOnly: false, pathWrites: false, exec: true });
		expect(toolCapability(["read", "grep", "glob"])).toEqual({ readOnly: true, pathWrites: false, exec: false });
		expect(toolCapability(["read", "write"])).toEqual({ readOnly: false, pathWrites: true, exec: false });
		expect(toolCapability(["read", "bash"])).toEqual({ readOnly: false, pathWrites: false, exec: true });
		expect(toolCapability(["unknown-custom"])).toEqual({ readOnly: false, pathWrites: false, exec: true });
		expect(toolCapability([])).toEqual({ readOnly: true, pathWrites: false, exec: false });
		expect(readOnlyTool("bash")).toBe(false);
		expect(readOnlyTool("ast_grep")).toBe(true);
		expect(readOnlyTool("lsp")).toBe(false);
		expect(toolCapability(["read", "lsp"])).toEqual({ readOnly: false, pathWrites: false, exec: true });
	});

	test("frontmatter parsing keeps the declared list only", () => {
		expect(parseToolsFrontmatter("---\nname: x\ntools: read, grep\n---\nbody")).toEqual(["read", "grep"]);
		expect(parseToolsFrontmatter("---\ntools: [read, write]\n---\n")).toEqual(["read", "write"]);
		expect(parseToolsFrontmatter("---\ntools:\n  - read\n  - bash\n---\n")).toEqual(["read", "bash"]);
		expect(parseToolsFrontmatter("---\nname: x\n---\n")).toBeUndefined();
		expect(parseToolsFrontmatter("no frontmatter")).toBeUndefined();
	});
});

describe("lane policy", () => {
	test("a read-only intent needs actual read-only tools; a role label never substitutes", () => {
		const policy = lanePolicy({ lane: lane({ kind: "review", role: "reviewer" }), tools: ["read", "grep"], isolated: false, auto: false });
		expect(policy.kind).toBe("read");
		// A shell is not a read-only tool: outside the review lane it is still refused (the review lane's shell is below).
		expect(lanePolicy({ lane: lane({ kind: "design", role: "architect" }), tools: ["read", "bash"], isolated: false, auto: false })).toMatchObject({ kind: "blocked" });
		expect(lanePolicy({ lane: lane({ kind: "design", role: "architect" }), tools: undefined, isolated: false, auto: false })).toMatchObject({ kind: "blocked" });
		expect(lanePolicy({ lane: lane({ kind: "design", role: "architect" }), tools: ["read", "lsp"], isolated: false, auto: false })).toMatchObject({ kind: "blocked" });
		expect(lanePolicy({ lane: lane({ kind: "design", role: "architect" }), tools: ["read", "grep"], isolated: false, auto: false }).kind).toBe("read");
		// A review lane with a real change obligation is a writer, not a read-only reviewer.
		expect(
			lanePolicy({
				lane: lane({
					kind: "review",
					role: "reviewer",
					files: ["a.md"],
					results: [{ id: "change", kind: "change", criterion: "a.md changes", path: "a.md" }],
				}),
				tools: ["read", "write"],
				isolated: false,
				auto: false,
			}),
		).toMatchObject({ kind: "paths", paths: ["a.md"] });
		// `files` on an answer-only read lane is a source/scope declaration, not writable intent.
		expect(
			lanePolicy({
				lane: lane({ kind: "explore", role: "explorer", files: ["notes.md"], results: [{ id: "a", kind: "answer", criterion: "read" }] }),
				tools: ["read", "grep"],
				isolated: false,
				auto: false,
			}),
		).toMatchObject({ kind: "read" });
	});

	test("path-only writers are scoped in every mode; exec-capable writers are unknown in every mode; private is private", () => {
		const scoped = lane({ files: ["src/a.ts"], kind: "code" });
		for (const auto of [false, true]) {
			expect(lanePolicy({ lane: scoped, tools: ["read", "write", "edit"], isolated: false, auto })).toMatchObject({ kind: "paths", paths: ["src/a.ts"] });
			// A worker with a shell or eval is an unbounded writer whatever the mode and whatever files it declared (G1).
			expect(lanePolicy({ lane: scoped, tools: ["read", "bash"], isolated: false, auto })).toMatchObject({ kind: "unknown", reason: WHY_EXEC_WRITER });
			expect(lanePolicy({ lane: scoped, tools: ["read", "write", "eval"], isolated: false, auto })).toMatchObject({ kind: "unknown", reason: WHY_EXEC_WRITER });
		}
		// A path-only agent that declared no files cannot be bounded either, in every mode.
		expect(lanePolicy({ lane: lane({ kind: "code" }), tools: ["read", "write"], isolated: false, auto: true })).toMatchObject({ kind: "unknown", reason: WHY_UNDECLARED_WRITER });
		expect(lanePolicy({ lane: scoped, tools: ["read", "bash"], isolated: false, auto: false })).toMatchObject({ kind: "unknown" });
		expect(lanePolicy({ lane: scoped, tools: undefined, isolated: false, auto: false })).toMatchObject({ kind: "unknown" });
		expect(lanePolicy({ lane: scoped, tools: ["read", "grep"], isolated: false, auto: false })).toMatchObject({ kind: "blocked" });
		expect(lanePolicy({ lane: scoped, tools: ["read", "bash"], isolated: true, auto: false })).toMatchObject({ kind: "private" });
		expect(lanePolicy({ lane: undefined, tools: ["read", "bash"], isolated: false, auto: false })).toMatchObject({ kind: "unknown" });
	});

	test("a read-only intent with no read tools is blocked rather than run blind", () => {
		expect(lanePolicy({ lane: lane({ kind: "explore", role: "explorer" }), tools: ["bash"], isolated: false, auto: false })).toMatchObject({ kind: "blocked" });
	});

	test("a review lane may run commands: it is a read lane with a shell, ordered like a writer, never a path writer", () => {
		const review = lane({ kind: "review", role: "reviewer" });
		for (const auto of [false, true]) {
			const policy = lanePolicy({ lane: review, tools: ["read", "grep", "bash"], isolated: false, auto });
			expect(policy).toMatchObject({ kind: "read", shell: true });
			expect(shellReviewer(policy)).toBe(true);
		}
		// Reads only: no shell, nothing to order.
		expect(shellReviewer(lanePolicy({ lane: review, tools: ["read", "grep"], isolated: false, auto: false }))).toBe(false);
		// The shell is the one extra tool. Path-write tools, eval, lsp, MCP and an absent list stay refused to a review lane.
		for (const tools of [["read", "bash", "write"], ["read", "bash", "edit"], ["read", "bash", "eval"], ["read", "bash", "lsp"], ["read", "bash", "mcp_x"], undefined]) {
			expect(lanePolicy({ lane: review, tools, isolated: false, auto: false })).toMatchObject({ kind: "blocked" });
		}
		// Only the review lane gets it: an explorer, an architect and a code lane keep today's classification.
		expect(lanePolicy({ lane: lane({ kind: "explore", role: "explorer" }), tools: ["read", "bash"], isolated: false, auto: false })).toMatchObject({ kind: "blocked" });
		expect(lanePolicy({ lane: lane({ kind: "design", role: "architect" }), tools: ["read", "bash"], isolated: false, auto: false })).toMatchObject({ kind: "blocked" });
		// An isolated reviewer is a private checkout, as before.
		expect(lanePolicy({ lane: review, tools: ["read", "bash"], isolated: true, auto: false })).toMatchObject({ kind: "private" });
		// A change obligation makes it a writer like any lane (WK11 keeps judging a reviewer that changed files).
		expect(
			lanePolicy({
				lane: lane({ kind: "review", role: "reviewer", files: ["a.md"], results: [{ id: "c", kind: "change", criterion: "x", path: "a.md" }] }),
				tools: ["read", "bash"],
				isolated: false,
				auto: false,
			}),
		).toMatchObject({ kind: "unknown", reason: WHY_EXEC_WRITER });
	});
});

describe("write paths", () => {
	test("declared roots and directory prefixes overlap, unrelated siblings do not", () => {
		expect(pathsOverlap("src", "src/a.ts")).toBe(true);
		expect(pathsOverlap("./src/a.ts", "src/a.ts")).toBe(true);
		expect(pathsOverlap("src/a.ts", "src/b.ts")).toBe(false);
		expect(pathsOverlap("other", "src/a.ts")).toBe(false);
		expect(scopesOverlap(["src"], ["other", "src/a.ts"])).toBe(true);
		expect(scopesOverlap(["src/a.ts"], ["src/b.ts"])).toBe(false);
		expect(pathsOverlap("../x", "x")).toBe(false);
	});

	test("only path-named write tools yield targets; unknown targets stay unknown", () => {
		expect(toolWriteTargets("write", { path: "a.ts" })).toEqual(["a.ts"]);
		expect(toolWriteTargets("multi_edit", { edits: [{ path: "a.ts" }, { file_path: "b.ts" }] })).toEqual(["a.ts", "b.ts"]);
		expect(toolWriteTargets("apply_patch", { patch: "***" })).toEqual([]);
		expect(toolWriteTargets("read", { path: "a.ts" })).toEqual([]);
		expect(toolWriteTargets("bash", { command: "x" })).toEqual([]);
	});

	test("a target is inside only its declared canonical scope and workspace", () => {
		const root = "/tmp/root";
		expect(targetWithinScope("src/a.ts", ["src"], root)).toBe(true);
		expect(targetWithinScope("src/deep/a.ts", ["src"], root)).toBe(true);
		expect(targetWithinScope("other/a.ts", ["src"], root)).toBe(false);
		expect(targetWithinScope("/tmp/root/src/a.ts", ["src"], root)).toBe(true);
		expect(targetWithinScope("/tmp/elsewhere/a.ts", ["src"], root)).toBe(false);
		expect(targetWithinScope("../outside.ts", ["src"], root)).toBe(false);
	});
});

describe("effective definitions and symlink aliases", () => {
	let dir = "";
	beforeAll(async () => {
		dir = await mkdtemp(path.join(tmpdir(), "storm-capability-"));
		await mkdir(path.join(dir, "agents"), { recursive: true });
		await mkdir(path.join(dir, "root", "real"), { recursive: true });
		await writeFile(path.join(dir, "agents", "storm-reviewer.md"), "---\nname: storm-reviewer\ntools: read, bash\n---\nbody\n");
		await writeFile(path.join(dir, "root", "real", "a.ts"), "a\n");
		await symlink("real", path.join(dir, "root", "alias"));
	});
	afterAll(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	test("a shadow definition wins over the plugin file", async () => {
		const shadowPath = path.join(dir, "agents", "shadow.md");
		await writeFile(shadowPath, "---\nname: storm-reviewer\ntools: [read, grep]\n---\n");
		const shadows: ShadowInfo[] = [{ agent: "storm-reviewer", path: shadowPath, scope: "project", sha256: "0".repeat(64) }];
		expect(effectiveAgentTools("storm-reviewer", shadows, path.join(dir, "agents"))).toEqual(["read", "grep"]);
		expect(effectiveAgentTools("storm-reviewer", [], path.join(dir, "agents"))).toEqual(["read", "bash"]);
		expect(effectiveAgentTools("missing", [], path.join(dir, "agents"))).toBeUndefined();
	});

	test("the shipped definitions: explorer and architect are read-only, the reviewer may add a shell, task stays out of worker roles", () => {
		const pluginAgents = path.join(import.meta.dir, "..", "agents");
		for (const role of ["storm-explorer", "storm-architect"]) {
			const tools = effectiveAgentTools(role, [], pluginAgents);
			expect(tools).toBeDefined();
			expect(toolCapability(tools).readOnly).toBe(true);
		}
		// The reviewer carries read tools, optionally `bash`, and no path-write tool, whichever way the definition is written.
		const reviewer = effectiveAgentTools("storm-reviewer", [], pluginAgents);
		expect(reviewer).toBeDefined();
		expect(toolCapability(reviewer).pathWrites).toBe(false);
		expect(lanePolicy({ lane: lane({ kind: "review", role: "reviewer" }), tools: reviewer, isolated: false, auto: false }).kind).toBe("read");
		for (const role of ["storm-implementer", "storm-quick"]) {
			const tools = effectiveAgentTools(role, [], pluginAgents);
			expect(tools).toBeDefined();
			expect(tools).toContain("bash");
			expect(tools).not.toContain("task");
		}
	});

	test("a symlink alias resolves to the same scope and an escape is refused", async () => {
		const root = path.join(dir, "root");
		expect(await canonicalScope(root, ["alias/a.ts"])).toEqual(["real/a.ts"]);
		expect(await canonicalScope(root, ["./real/../real/a.ts"])).toEqual(["real/a.ts"]);
		expect(await canonicalScope(root, ["../outside.ts"])).toBeUndefined();
		expect(scopesOverlap(await canonicalScope(root, ["alias"]) as string[], await canonicalScope(root, ["real/a.ts"]) as string[])).toBe(true);
	});
});
