import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	initializeAutoDelegation,
	readAutoDelegation,
	readAutoDelegationChoice,
	writeAutoDelegation,
} from "../src/approval/auto.ts";
import { READ_ONLY_TOOLS } from "../src/policy/capability.ts";
import { CONTROL_TOOL_NAMES, isPlanProposal, SUPERVISOR_REASONS, type SupervisorScope, supervisorToolBlock } from "../src/policy/supervisor.ts";
import { sessionStoreDir } from "../src/session-scope.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "storm-auto-policy-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** One valid session store of an ephemeral profile; the auto file lives directly inside it. */
const session = (profileName: string, id = "native-session"): string =>
	sessionStoreDir(join(root, "profiles", profileName), id);

async function store(name: string): Promise<string> {
	const dir = session(name);
	await mkdir(dir, { recursive: true });
	return dir;
}

describe("auto delegation consent", () => {
	test("missing, malformed, wrong-version and non-boolean states are off", async () => {
		expect(await readAutoDelegation(session("missing"))).toBe(false);

		const dir = await store("invalid");
		const file = join(dir, "auto-delegation.json");
		await writeFile(file, "{not json");
		expect(await readAutoDelegation(dir)).toBe(false);
		await writeFile(file, JSON.stringify({ schema: "storm.auto-delegation/v2", enabled: true }));
		expect(await readAutoDelegation(dir)).toBe(false);
		await writeFile(file, JSON.stringify({ schema: "storm.auto-delegation/v1", enabled: "true" }));
		expect(await readAutoDelegation(dir)).toBe(false);
		await writeFile(file, JSON.stringify(["enabled"]));
		expect(await readAutoDelegation(dir)).toBe(false);
		await writeFile(file, "null");
		expect(await readAutoDelegation(dir)).toBe(false);
	});

	test("explicit true and false survive reload", async () => {
		const dir = await store("reload");
		await writeAutoDelegation(dir, true);
		expect(await readAutoDelegation(dir)).toBe(true);
		expect(await readAutoDelegation(dir)).toBe(true);

		await writeAutoDelegation(dir, false);
		expect(await readAutoDelegation(dir)).toBe(false);
		expect(await readAutoDelegation(dir)).toBe(false);
		const persisted = JSON.parse(await readFile(join(dir, "auto-delegation.json"), "utf8")) as Record<string, unknown>;
		expect(persisted).toMatchObject({ schema: "storm.auto-delegation/v1", enabled: false });
	});

	test("disabling keeps unrelated state and a team approval never implies consent", async () => {
		const dir = await store("durable");
		const approval = `${"a".repeat(64)}.json`;
		await mkdir(join(dir, "approved"), { recursive: true });
		await writeFile(join(dir, "approved", approval), JSON.stringify({ schema: "storm.approval/v1", status: "active" }));
		await writeFile(join(dir, "runs.jsonl"), "keep\n");

		expect(await readAutoDelegation(dir)).toBe(false);
		await writeAutoDelegation(dir, true);
		await writeAutoDelegation(dir, false);
		expect(await readAutoDelegation(dir)).toBe(false);
		expect(await readFile(join(dir, "runs.jsonl"), "utf8")).toBe("keep\n");
		expect(await readdir(join(dir, "approved"))).toEqual([approval]);
	});

	test("a fresh opt-in writes only its own state file", async () => {
		const dir = await store("fresh");
		await writeAutoDelegation(dir, true);
		expect(await readdir(dir)).toEqual(["auto-delegation.json"]);
	});

	test("an unusable store dir fails closed", async () => {
		expect(await readAutoDelegation("")).toBe(false);
		await expect(writeAutoDelegation("", true)).rejects.toThrow();
	});

	test("the choice separates unset, explicit off, on and invalid content", async () => {
		expect(await readAutoDelegationChoice(session("choice-missing"))).toBe("unset");
		expect(await readAutoDelegationChoice("")).toBe("invalid");
		expect(await readAutoDelegationChoice("   ")).toBe("invalid");

		const dir = await store("choice");
		expect(await readAutoDelegationChoice(dir)).toBe("unset");
		await writeAutoDelegation(dir, false);
		expect(await readAutoDelegationChoice(dir)).toBe("off");
		expect(await readAutoDelegation(dir)).toBe(false);
		await writeAutoDelegation(dir, true);
		expect(await readAutoDelegationChoice(dir)).toBe("on");
		expect(await readAutoDelegation(dir)).toBe(true);

		const file = join(dir, "auto-delegation.json");
		for (const text of [
			"{not json",
			JSON.stringify({ schema: "storm.auto-delegation/v2", enabled: true }),
			JSON.stringify({ schema: "storm.auto-delegation/v1", enabled: "true" }),
			JSON.stringify(["enabled"]),
			"null",
		]) {
			await writeFile(file, text);
			expect(await readAutoDelegationChoice(dir)).toBe("invalid");
			expect(await readAutoDelegation(dir)).toBe(false);
		}
	});

	test("only absence is unset; other read failures are surfaced", async () => {
		const dir = await store("choice-io-error");
		await symlink("auto-delegation.json", join(dir, "auto-delegation.json"));
		await expect(readAutoDelegationChoice(dir)).rejects.toThrow();
		await expect(readAutoDelegation(dir)).rejects.toThrow();
	});

	test("initialization publishes a complete v1 state once", async () => {
		const reference = await store("init-reference");
		await writeAutoDelegation(reference, true);
		const published = await readFile(join(reference, "auto-delegation.json"), "utf8");

		const dir = session("init-nested");
		expect(await initializeAutoDelegation(dir, true)).toBe(true);
		expect(await readAutoDelegationChoice(dir)).toBe("on");
		expect(await readFile(join(dir, "auto-delegation.json"), "utf8")).toBe(published);
		expect(await readdir(dir)).toEqual(["auto-delegation.json"]);

		expect(await initializeAutoDelegation(dir, false)).toBe(false);
		expect(await readAutoDelegationChoice(dir)).toBe("on");
		expect(await readFile(join(dir, "auto-delegation.json"), "utf8")).toBe(published);
		expect(await readdir(dir)).toEqual(["auto-delegation.json"]);
	});

	test("initialization never replaces an explicit off, an invalid file or an existing v1 state", async () => {
		const off = await store("init-off");
		await writeAutoDelegation(off, false);
		const offText = await readFile(join(off, "auto-delegation.json"), "utf8");
		expect(await initializeAutoDelegation(off, true)).toBe(false);
		expect(await readAutoDelegationChoice(off)).toBe("off");
		expect(await readFile(join(off, "auto-delegation.json"), "utf8")).toBe(offText);

		const invalid = await store("init-invalid");
		await writeFile(join(invalid, "auto-delegation.json"), "{broken");
		expect(await initializeAutoDelegation(invalid, true)).toBe(false);
		expect(await readAutoDelegationChoice(invalid)).toBe("invalid");
		expect(await readFile(join(invalid, "auto-delegation.json"), "utf8")).toBe("{broken");

		const v1 = await store("init-v1");
		const v1Text = JSON.stringify({ schema: "storm.auto-delegation/v1", enabled: true, extra: 1 });
		await writeFile(join(v1, "auto-delegation.json"), v1Text);
		expect(await initializeAutoDelegation(v1, false)).toBe(false);
		expect(await readAutoDelegationChoice(v1)).toBe("on");
		expect(await readFile(join(v1, "auto-delegation.json"), "utf8")).toBe(v1Text);

		const occupied = await store("init-occupied");
		await mkdir(join(occupied, "auto-delegation.json"));
		expect(await initializeAutoDelegation(occupied, true)).toBe(false);

		for (const dir of [off, invalid, v1]) expect(await readdir(dir)).toEqual(["auto-delegation.json"]);
	});

	test("competing initializers publish exactly one complete state", async () => {
		const dir = await store("init-race");
		const outcomes = await Promise.all(
			Array.from({ length: 24 }, (_, index) => initializeAutoDelegation(dir, index % 2 === 0)),
		);
		expect(outcomes.filter(Boolean)).toHaveLength(1);
		const choice = await readAutoDelegationChoice(dir);
		expect(["on", "off"]).toContain(choice);
		const text = await readFile(join(dir, "auto-delegation.json"), "utf8");
		expect(JSON.parse(text)).toEqual({ schema: "storm.auto-delegation/v1", enabled: choice === "on" });
		expect(await readAutoDelegation(dir)).toBe(choice === "on");
		expect(await readdir(dir)).toEqual(["auto-delegation.json"]);
	});

	test("an explicit off racing initialization is never clobbered", async () => {
		const dir = await store("init-race-off");
		await Promise.all([
			...Array.from({ length: 8 }, () => writeAutoDelegation(dir, false)),
			...Array.from({ length: 8 }, () => initializeAutoDelegation(dir, true)),
		]);
		expect(await readAutoDelegationChoice(dir)).toBe("off");
		expect(await readAutoDelegation(dir)).toBe(false);
		expect(await readdir(dir)).toEqual(["auto-delegation.json"]);
	});

	test("a failed initialization publishes nothing", async () => {
		const parent = await store("init-failed");
		const block = join(parent, "block");
		await writeFile(block, "keep\n");
		await expect(initializeAutoDelegation(block, true)).rejects.toThrow();
		expect(await readFile(block, "utf8")).toBe("keep\n");
		expect(await readdir(parent)).toEqual(["block"]);
		await expect(initializeAutoDelegation("", true)).rejects.toThrow();
	});
});

describe("supervisor policy", () => {
	const R = SUPERVISOR_REASONS;
	const readPath = (path: string, scope?: SupervisorScope) => supervisorToolBlock("read", { path }, scope);
	const writeTo = (path: string, content = "x") => supervisorToolBlock("write", { path, content });

	test("the controls, plan mode's exit and every read-only tool are admitted, by exact name", () => {
		for (const tool of CONTROL_TOOL_NAMES) expect(supervisorToolBlock(tool, {})).toBeUndefined();
		expect(supervisorToolBlock("task", { task: "implement", agent: "storm-implementer" })).toBeUndefined();
		// The same definition the worker gate uses for a read-only worker: nothing in it is refused here.
		for (const tool of Object.keys(READ_ONLY_TOOLS).filter(name => name !== "read")) {
			expect(supervisorToolBlock(tool, {})).toBeUndefined();
		}
		// omp's plan mode leaves through `propose`; refusing it would strand a session that entered plan mode.
		expect(CONTROL_TOOL_NAMES).toContain("propose");
	});

	test("plan mode's exit is a bash command on omp 19.2.1 (`propose <slug>`, seen on the real host): that exact shape passes, nothing else with bash does", () => {
		expect(supervisorToolBlock("bash", { command: "propose my-plan_2" }, undefined, true)).toBeUndefined();
		// R-final N8: with plan mode off the same line goes to the shell like any command, so it is not let through.
		expect(supervisorToolBlock("bash", { command: "propose my-plan_2" })).toContain(R.toolRuns);
		expect(supervisorToolBlock("bash", { command: "propose my-plan_2" }, undefined, false)).toContain(R.toolRuns);
		expect(isPlanProposal("bash", { command: "propose\tmy-plan" })).toBe(true);
		for (const command of ["propose", "propose a b", "propose a; rm -rf x", "propose $(id)", "propose a && ls", "propose a\\nls", "propose 'a'", "propose ../a", " propose a", "propose a "]) {
			expect(supervisorToolBlock("bash", { command }, undefined, true)).toContain(R.toolRuns);
		}
		// One key only: a service name, a working directory or a timeout is more than the plain submission.
		for (const extra of [{ name: "svc" }, { cwd: "/tmp" }, { timeout: 5 }, { async: true }]) {
			expect(supervisorToolBlock("bash", { command: "propose a", ...extra }, undefined, true)).toContain(R.toolRuns);
		}
		expect(supervisorToolBlock("eval", { command: "propose a" }, undefined, true)).toContain(R.toolRuns);
	});

	test("tools that edit, run commands or have unknown effects are refused, each with its own cause", () => {
		for (const tool of ["edit", "ast_edit", "multi_edit", "apply_patch", "notebook_edit"]) {
			expect(supervisorToolBlock(tool, {})).toContain(R.toolEdits);
		}
		for (const tool of ["bash", "eval"]) expect(supervisorToolBlock(tool, {})).toContain(R.toolRuns);
		for (const tool of ["stormx", "task2", "goal", "think", "fetch", "debug", "github", "mcp__filesystem_read", "READ", " task", "propose2"]) {
			expect(supervisorToolBlock(tool, {})).toContain(R.toolUnknown);
		}
		// Prototype names are not tools.
		for (const tool of ["__proto__", "constructor", "toString"]) expect(typeof supervisorToolBlock(tool, {})).toBe("string");
		expect(supervisorToolBlock("", {})).toBe(R.toolMissing);
	});

	test("file reads, searches, web reads and the run's own notes and handles are admitted", () => {
		for (const path of [
			"src/a.ts",
			"/etc/hosts",
			"src/a.ts:1-5000",
			"src/a.ts:raw",
			"src/",
			"README.md:12",
			"C:/proj/a.ts",
			"https://example.com/doc",
			"http://localhost:3000/x",
			"local://plan.md",
			"local://notes/plan.md:1-20",
			"skill://review",
			"rule://style",
			"help://read/urls",
			"history://current",
			"history://current/full",
			"agent://Impl",
			"agent://Impl/result/0",
			"agent://Impl:1-5000",
			"agent://Impl:raw",
			"agent://Impl:1-",
		]) {
			expect(readPath(path)).toBeUndefined();
		}
		for (const [tool, input] of [
			["grep", { pattern: "secret" }],
			["glob", { pattern: "**/*" }],
			["find", { query: "where plans are stored" }],
			["ast_grep", { pat: ["foo($A)"] }],
			["web_search", { query: "x" }],
		] as const) {
			expect(supervisorToolBlock(tool, input)).toBeUndefined();
		}
	});

	test("a read that is not a plain read is refused with its cause", () => {
		// A remote host, an MCP resource or any other scheme.
		for (const path of ["ssh://host/etc/passwd", "ssh:/host/etc/passwd", "mcp://server/resource", "urn:example:doc", "proc://bg_1", "xd://edit", "memory://x"]) {
			expect(readPath(path)).toBe(R.readRemote);
		}
		// A scheme hidden in the middle of a path (omp routes it).
		expect(readPath("/repo/ssh://host/x")).toBe(R.readEmbedded);
		// A PDF page rendered as an image starts a browser.
		expect(readPath("doc.pdf:p1.png")).toBe(R.readProcess);
		// Other omp instances.
		for (const path of ["agent://peers", "agent://123", "agent://4242/Impl"]) expect(readPath(path)).toBe(R.readOtherInstance);
		for (const path of ["agent://", "agent://../etc/passwd"]) expect(readPath(path)).toBe(R.readAgentPath);
	});

	test("a transcript is read only for an agent this session's runs started", () => {
		const scope: SupervisorScope = { agentIds: ["Impl", "Rev"] };
		expect(readPath("history://Impl", scope)).toBeUndefined();
		expect(readPath("history://impl:1-40", scope)).toBeUndefined();
		expect(readPath("history://Rev?detail=brief", scope)).toBeUndefined();
		// Another session's agent, the index (it lists every session's agents) and a call with no scope at all.
		expect(readPath("history://Other", scope)).toBe(R.readHistoryScope);
		expect(readPath("history://", scope)).toBe(R.readHistoryScope);
		expect(readPath("history://Impl")).toBe(R.readHistoryScope);
		expect(readPath("history://Impl", {})).toBe(R.readHistoryScope);
		// The session's own branch needs no id.
		expect(readPath("history://current/full")).toBeUndefined();
		// A getter is called for a transcript read and for nothing else.
		let calls = 0;
		const lazy = (): SupervisorScope => {
			calls += 1;
			return scope;
		};
		expect(supervisorToolBlock("read", { path: "src/a.ts" }, lazy)).toBeUndefined();
		expect(calls).toBe(0);
		// An agent handle is held to this session's agents (R-G234 L1), like a transcript: the getter is called for those two only.
		expect(supervisorToolBlock("read", { path: "agent://Impl" }, lazy)).toBeUndefined();
		expect(supervisorToolBlock("read", { path: "agent://Other" }, lazy)).toBe(R.readAgentScope);
		expect(supervisorToolBlock("read", { path: "Agent://%49mpl/result/0" }, lazy)).toBeUndefined();
		expect(supervisorToolBlock("read", { path: "agent://Impl:1-5000" }, lazy)).toBeUndefined();
		expect(calls).toBe(4);
		expect(supervisorToolBlock("read", { path: "history://Impl" }, lazy)).toBeUndefined();
		expect(calls).toBe(5);
		// The handle is read as omp reads an address (R-final N1): the one function decodes and resolves dot segments.
		expect(readPath("agent://%4Fther/./x", scope)).toBe(R.readAgentScope);
		expect(readPath("history://%4Fther", scope)).toBe(R.readHistoryScope);
		expect(readPath("History://%49mpl/./x", scope)).toBeUndefined();
		// `history://current` is the session's own branch only while no agent of the process is named so (R-G234 L1).
		const hostWithCurrent: SupervisorScope = { agentIds: ["Impl"], hostAgentIds: ["Impl", "Current"] };
		expect(readPath("history://current", scope)).toBeUndefined();
		expect(readPath("history://current/full", { agentIds: ["Impl"], hostAgentIds: ["Impl"] })).toBeUndefined();
		expect(readPath("history://current", hostWithCurrent)).toBe(R.readHistoryScope);
		expect(readPath("History://CURRENT/full", hostWithCurrent)).toBe(R.readHistoryScope);
		// An agent of this session's own named `current` is read like any of them.
		expect(readPath("history://current", { agentIds: ["current"], hostAgentIds: ["current"] })).toBeUndefined();
		// Without a scope given nothing is held to it (the extension always gives one).
		expect(supervisorToolBlock("read", { path: "agent://Anything" })).toBeUndefined();
	});

	test("context size is never a cause: a wide read of a file or a handle is admitted", () => {
		expect(readPath("agent://Impl:1-401")).toBeUndefined();
		expect(readPath("agent://Impl:1-100000")).toBeUndefined();
		expect(readPath("big.md:1-100000")).toBeUndefined();
	});

	test("lsp may ask a language server questions and nothing that changes the tree or starts a build", () => {
		for (const action of ["definition", "references", "hover", "symbols", "type_definition", "implementation", "status", "capabilities", "diagnostics"]) {
			expect(supervisorToolBlock("lsp", { action, file: "src/a.ts", line: 3 })).toBeUndefined();
		}
		for (const action of ["rename", "rename_file", "code_actions", "reload", "request", "unknown"]) {
			expect(supervisorToolBlock("lsp", { action, file: "src/a.ts" })).toBe(R.lspMutating);
		}
		expect(supervisorToolBlock("lsp", { action: "diagnostics", file: "*" })).toBe(R.lspWorkspaceDiagnostics);
		expect(supervisorToolBlock("lsp", { action: "diagnostics", file: " * " })).toBe(R.lspWorkspaceDiagnostics);
		expect(supervisorToolBlock("lsp", { action: "constructor" })).toBe(R.lspMutating);
		for (const input of [undefined, null, [], "x", {}, { action: 7 }]) expect(supervisorToolBlock("lsp", input)).toBe(R.lspMalformed);
	});

	test("writes are only typed agent messages or local Markdown notes", () => {
		expect(writeTo("agent://Impl", "review src/a.ts")).toBeUndefined();
		expect(writeTo("local://plan.md", "- step")).toBeUndefined();
		expect(writeTo("local://notes/plan.md", "- step")).toBeUndefined();
		expect(writeTo("local://plan.md", "")).toBeUndefined();

		for (const path of ["local://../secret.md", "local:///plan.md", "local://plan", "local://plan.txt", "local://plan.md?x=1", "local://plan.md:1-20"]) {
			expect(writeTo(path)).toBe(R.writeLocalNote);
		}
		for (const path of ["src/a.ts", "/tmp/x", "out://report.md"]) expect(writeTo(path)).toBe(R.writeFiles);
		for (const path of ["ssh://host/etc/app.conf", "xd://edit", "proc://bg_1/kill", "mcp://server/tool"]) {
			expect(writeTo(path)).toBe(R.writeRemote);
		}
	});

	test("a quiet progress note to one worker is a message like any other", () => {
		expect(writeTo("agent://Impl?progress", "halfway through the parser")).toBeUndefined();
		expect(writeTo("agent://Impl/?progress", "x")).toBeUndefined();
		expect(writeTo("agent://Impl/", "x")).toBeUndefined();
		// Its cause when refused is the real one, not the broadcast text it used to get.
		expect(writeTo("agent://Impl?progress", " ")).toBe(R.messageEmpty);
		expect(writeTo("agent://all?progress")).toBe(R.messageBroadcast);
		expect(writeTo("agent://Impl?x=1")).toBe(R.messageAddress);
		expect(writeTo("agent://Impl?progress&x=1")).toBe(R.messageAddress);
	});

	test("messages never reach everyone, a parent, another omp instance or a worker's model settings", () => {
		expect(writeTo("agent://all", "broadcast")).toBe(R.messageBroadcast);
		expect(writeTo("agent://ALL")).toBe(R.messageBroadcast);
		for (const path of ["agent://parent", "agent://Parent", "agent://peers", "agent://123"]) {
			expect(writeTo(path)).toBe(R.messageOtherAddress);
		}
		for (const path of ["agent://Impl/model", "agent://Impl/Effort", "agent://Impl/model?progress"]) {
			expect(writeTo(path)).toBe(R.messageControl);
		}
		for (const path of ["agent://Impl/field", "agent://Impl/model/x", "agent://Impl:1-40", "agent://", "agent://../x"]) {
			expect(writeTo(path)).toBe(R.messageAddress);
		}
		expect(writeTo("agent://Impl", "")).toBe(R.messageEmpty);
	});

	test("malformed input fails closed and paths are matched exactly", () => {
		for (const input of [undefined, null, [], "agent://Impl", 7, { path: 7 }, { path: "agent://Impl", extra: true }, { content: "x" }]) {
			expect(typeof supervisorToolBlock("read", input)).toBe("string");
		}
		for (const input of [
			undefined,
			null,
			[],
			"x",
			{ path: "agent://Impl" },
			{ path: "agent://Impl", content: 7 },
			{ path: "agent://Impl", content: "x", extra: true },
			{ path: "local://plan.md" },
		]) {
			expect(typeof supervisorToolBlock("write", input)).toBe("string");
		}
		for (const path of [" agent://Impl", "agent://Impl ", "agent:/Impl", "history:/Impl", "agent://Impl\n", "local://plan.md\n"]) {
			expect(typeof supervisorToolBlock("read", { path })).toBe("string");
		}
		// omp matches a scheme without case, so the spelling is the same handle.
		expect(readPath("Agent://Impl")).toBeUndefined();
	});
});
