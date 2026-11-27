import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
	authorityCovers,
	canonicalScope,
	effectiveAgentTools,
	lanePolicy,
	parseToolsFrontmatter,
	pathsOverlap,
	readOnlyTool,
	scopesOverlap,
	shellReader,
	shellReaderWhy,
	targetWithinScope,
	toolCapability,
	toolWriteTargets,
	WHY_EXEC_WRITER,
	WHY_SHELL_READER,
	WHY_SHELL_REVIEWER,
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
		// A shell is not a read-only tool, but `read` plus the shell only is a shell reader (below); no list is still refused.
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

	test("a read-only intent whose only other tool is unknown to Storm is blocked rather than run blind", () => {
		expect(lanePolicy({ lane: lane({ kind: "explore", role: "explorer" }), tools: ["mcp_x"], isolated: false, auto: false })).toMatchObject({ kind: "blocked" });
	});

	test("a review lane may run commands: it is a read lane with a shell, ordered like a writer, never a path writer", () => {
		const review = lane({ kind: "review", role: "reviewer" });
		for (const auto of [false, true]) {
			const policy = lanePolicy({ lane: review, tools: ["read", "grep", "bash"], isolated: false, auto });
			expect(policy).toMatchObject({ kind: "read", shell: true });
			expect(shellReader(policy)).toBe(true);
		}
		// Reads only: no shell, nothing to order.
		expect(shellReader(lanePolicy({ lane: review, tools: ["read", "grep"], isolated: false, auto: false }))).toBe(false);
		// The shell is the one extra tool. Path-write tools, eval, lsp, MCP and an absent list stay refused to a review lane.
		for (const tools of [["read", "bash", "write"], ["read", "bash", "edit"], ["read", "bash", "eval"], ["read", "bash", "lsp"], ["read", "bash", "mcp_x"], undefined]) {
			expect(lanePolicy({ lane: review, tools, isolated: false, auto: false })).toMatchObject({ kind: "blocked" });
		}
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

describe("shell readers: any read-intent lane whose agent already lists a shell", () => {
	const answerOnly = { id: "a", kind: "answer" as const, criterion: "answer with evidence" };
	const readLanes: [string, PlanLane][] = [
		["explore", lane({ kind: "explore", role: "explorer" })],
		["design", lane({ kind: "design", role: "architect" })],
		["answer-only", lane({ kind: "explore", role: "explorer", results: [answerOnly] })],
		["review", lane({ kind: "review", role: "reviewer" })],
	];

	test("read tools plus the shell only is a read policy with the shell, on every read lane", () => {
		for (const [name, one] of readLanes) {
			for (const tools of [["read", "grep", "bash"], ["bash", "read"], ["read", " bash "]]) {
				const policy = lanePolicy({ lane: one, tools, isolated: false, auto: false });
				expect(policy, `${name} ${tools.join(",")}`).toMatchObject({ kind: "read", shell: true });
				expect(shellReader(policy)).toBe(true);
				expect(shellReader(policy)).toBe(true);
			}
			// No shell: a plain reader that reserves nothing.
			const plain = lanePolicy({ lane: one, tools: ["read", "grep"], isolated: false, auto: false });
			expect(plain).toEqual({ kind: "read", reason: expect.any(String) });
			expect(shellReader(plain)).toBe(false);
		}
	});

	test("any other non-read tool, or no tool list, still blocks the lane", () => {
		for (const [name, one] of readLanes) {
			for (const tools of [["read", "bash", "edit"], ["read", "bash", "write"], ["read", "bash", "eval"], ["read", "bash", "lsp"], ["read", "bash", "mcp_x"], ["read", "bash", "task"], ["bash", "apply_patch"], undefined]) {
				expect(lanePolicy({ lane: one, tools, isolated: false, auto: false }), `${name} ${tools?.join(",")}`).toMatchObject({ kind: "blocked" });
			}
		}
	});

	test("a shell alone with no read tool is still a shell reader, but an empty list is not a shell reader", () => {
		const explore = lane({ kind: "explore", role: "explorer" });
		expect(lanePolicy({ lane: explore, tools: ["bash"], isolated: false, auto: false })).toMatchObject({ kind: "read", shell: true });
		expect(shellReader(lanePolicy({ lane: explore, tools: [], isolated: false, auto: false }))).toBe(false);
	});

	test("the reason names a review lane differently from another read lane, and the why text follows it", () => {
		const review = lanePolicy({ lane: readLanes[3]![1], tools: ["read", "bash"], isolated: false, auto: false });
		const explore = lanePolicy({ lane: readLanes[0]![1], tools: ["read", "bash"], isolated: false, auto: false });
		expect(review.reason).not.toBe(explore.reason);
		expect(shellReaderWhy(readLanes[3]![1])).toBe(WHY_SHELL_REVIEWER);
		expect(shellReaderWhy(readLanes[0]![1])).toBe(WHY_SHELL_READER);
		expect(shellReaderWhy(lane({ kind: "explore", role: "reviewer" }))).toBe(WHY_SHELL_REVIEWER);
		expect(shellReaderWhy(undefined)).toBe(WHY_SHELL_READER);
	});

	test("isolation, a change obligation and an unplanned task keep their classification", () => {
		const explore = readLanes[0]![1];
		expect(lanePolicy({ lane: explore, tools: ["read", "bash"], isolated: true, auto: false })).toMatchObject({ kind: "private" });
		expect(lanePolicy({ lane: undefined, tools: ["read", "bash"], isolated: false, auto: false })).toMatchObject({ kind: "unknown" });
		// A lane that promises a change is a writer, and a shell makes it an unknown one.
		const change = lane({ kind: "explore", role: "explorer", files: ["a.md"], results: [{ id: "c", kind: "change", criterion: "x", path: "a.md" }] });
		expect(lanePolicy({ lane: change, tools: ["read", "bash"], isolated: false, auto: false })).toMatchObject({ kind: "unknown", reason: WHY_EXEC_WRITER });
	});

	test("an agent definition is read from its own file: the shipped explorer and architect stay plain, a definition that lists bash qualifies", async () => {
		const pluginAgents = path.join(import.meta.dir, "..", "agents");
		for (const [role, one] of [["storm-explorer", readLanes[0]![1]], ["storm-architect", readLanes[1]![1]]] as const) {
			const policy = lanePolicy({ lane: one, tools: effectiveAgentTools(role, [], pluginAgents), isolated: false, auto: false });
			expect(policy.kind).toBe("read");
			expect(shellReader(policy)).toBe(false);
		}
		const dir = await mkdtemp(path.join(tmpdir(), "storm-shell-reader-"));
		try {
			const shadowPath = path.join(dir, "explorer.md");
			await writeFile(shadowPath, "---\nname: storm-explorer\ntools: read, grep, find, bash\n---\nbody\n");
			const shadows: ShadowInfo[] = [{ agent: "storm-explorer", path: shadowPath, scope: "user", sha256: "0".repeat(64) }];
			const tools = effectiveAgentTools("storm-explorer", shadows, pluginAgents);
			expect(tools).toEqual(["read", "grep", "find", "bash"]);
			expect(lanePolicy({ lane: readLanes[0]![1], tools, isolated: false, auto: false })).toMatchObject({ kind: "read", shell: true });
			// The bundled explorer, with no shadow, did not gain it.
			expect(shellReader(lanePolicy({ lane: readLanes[0]![1], tools: effectiveAgentTools("storm-explorer", [], pluginAgents), isolated: false, auto: false }))).toBe(false);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
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

	test("RF2: caseless comparison does not depend on position in the word (final sigma) or on the sharp s, after normalisation; the exact target check stays exact", () => {
		expect(scopesOverlap(["src/Σ.ts"], ["src/ς.ts"])).toBe(true);
		expect(scopesOverlap(["src/ς.ts"], ["src/Σ.ts"])).toBe(true);
		expect(scopesOverlap(["src/ΟΣ.ts"], ["src/οσ.ts"])).toBe(true);
		expect(scopesOverlap(["src/ẞ.ts"], ["src/ß.ts"])).toBe(true);
		expect(scopesOverlap(["src/résumé"], ["src/re\u0301sume\u0301"])).toBe(true);
		// The authorization of a worker's own target is still exact, whatever the volume does.
		expect(pathsOverlap("src/Σ.ts", "src/ς.ts")).toBe(false);
		expect(targetWithinScope("src/Σ.ts", ["src/ς.ts"], ".")).toBe(false);
	});
});

describe("R3: a persisted policy may not be wider than the authority the placement froze", () => {
	const read = { kind: "read" as const, reason: "read" };
	const shell = { kind: "read" as const, reason: "shell", shell: true as const };
	const priv = { kind: "private" as const, reason: "private" };
	const unknown = { kind: "unknown" as const, reason: "unknown" };
	const paths = (values: string[]) => ({ kind: "paths" as const, reason: "paths", paths: values });

	test("an unknown reservation covers every shared writer; a paths reservation covers only the paths it holds", () => {
		for (const policy of [read, shell, priv, unknown, paths(["src/a.ts"])]) {
			// `private` is the exception: a private policy in a shared placement would write the parent root.
			expect(authorityCovers({ kind: "unknown" }, policy)).toBe(policy.kind !== "private");
		}
		expect(authorityCovers({ kind: "paths", paths: ["src"] }, read)).toBe(true);
		expect(authorityCovers({ kind: "paths", paths: ["src"] }, paths(["src/a.ts"]))).toBe(true);
		expect(authorityCovers({ kind: "paths", paths: ["src/a.ts"] }, paths(["src"]))).toBe(false);
		expect(authorityCovers({ kind: "paths", paths: ["src/a.ts"] }, paths(["src/b.ts"]))).toBe(false);
		expect(authorityCovers({ kind: "paths", paths: ["."] }, paths(["any/where.ts"]))).toBe(true);
		expect(authorityCovers({ kind: "paths", paths: ["src"] }, unknown)).toBe(false);
		expect(authorityCovers({ kind: "paths", paths: ["src"] }, shell)).toBe(false);
		expect(authorityCovers({ kind: "paths", paths: ["src"] }, paths(["../out.ts"]))).toBe(false);
	});

	test("a read reservation covers only itself; a private one covers a reader", () => {
		expect(authorityCovers({ kind: "read" }, read)).toBe(true);
		expect(authorityCovers({ kind: "read" }, shell)).toBe(false);
		expect(authorityCovers({ kind: "read" }, paths(["a.ts"]))).toBe(false);
		expect(authorityCovers({ kind: "read" }, unknown)).toBe(false);
		expect(authorityCovers({ kind: "private" }, read)).toBe(true);
		expect(authorityCovers({ kind: "private" }, priv)).toBe(true);
		expect(authorityCovers({ kind: "private" }, paths(["a.ts"]))).toBe(false);
		expect(authorityCovers({ kind: "private" }, unknown)).toBe(false);
		expect(authorityCovers({ kind: "private" }, shell)).toBe(false);
	});

	test("a blocked policy is never covered", () => {
		expect(authorityCovers({ kind: "unknown" }, { kind: "blocked", reason: "blocked" })).toBe(false);
	});
});
