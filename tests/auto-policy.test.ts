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
import { supervisorToolBlock } from "../src/policy/supervisor.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "storm-auto-policy-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));

async function store(name: string): Promise<string> {
	const dir = join(root, name);
	await mkdir(dir, { recursive: true });
	return dir;
}

describe("auto delegation consent", () => {
	test("missing, malformed, wrong-version and non-boolean states are off", async () => {
		expect(await readAutoDelegation(join(root, "missing"))).toBe(false);

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
		expect(await readAutoDelegationChoice(join(root, "choice-missing"))).toBe("unset");
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

		const dir = join(root, "init-nested", "store");
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
	test("only the orchestration controls are admitted, by exact name", () => {
		for (const tool of ["storm", "task", "ask", "todo", "wait"]) {
			expect(supervisorToolBlock(tool, {})).toBeUndefined();
		}
		expect(supervisorToolBlock("task", { task: "implement", agent: "storm-implementer" })).toBeUndefined();

		for (const tool of [
			"stormx",
			"task2",
			"yield",
			"goal",
			"think",
			"bash",
			"eval",
			"grep",
			"glob",
			"find",
			"lsp",
			"web_search",
			"fetch",
			"debug",
			"github",
			"mcp__filesystem_read",
			"__proto__",
			"constructor",
			"toString",
			"READ",
			" task",
		]) {
			expect(typeof supervisorToolBlock(tool, {})).toBe("string");
		}
		expect(typeof supervisorToolBlock("", {})).toBe("string");
	});

	test("file, shell, remote, MCP and transcript reads are refused", () => {
		const calls = [
			["read", { path: "src/a.ts" }],
			["read", { path: "/etc/passwd" }],
			["read", { path: "ssh://host/etc/passwd" }],
			["read", { path: "local://plan.md" }],
			["read", { path: "history://Impl" }],
			["read", { path: "history://current/full" }],
			["read", { path: "history://Impl:1-40" }],
			["grep", { pattern: "secret" }],
			["glob", { pattern: "**/*" }],
			["bash", { command: "cat /etc/passwd" }],
			["eval", { code: "await tool.bash({})" }],
			["web_search", { query: "x" }],
			["mcp__filesystem_read", { path: "/etc/passwd" }],
		] as const;
		for (const [tool, input] of calls) {
			expect(typeof supervisorToolBlock(tool, input)).toBe("string");
		}
		const transcript = supervisorToolBlock("read", { path: "history://Impl" });
		expect(transcript).toContain("agent://");
		expect(transcript).toContain("task");
	});

	test("an agent handle read is a summary/artifact or explicitly bounded", () => {
		expect(supervisorToolBlock("read", { path: "agent://Impl" })).toBeUndefined();
		expect(supervisorToolBlock("read", { path: "agent://Impl/result/0" })).toBeUndefined();
		expect(supervisorToolBlock("read", { path: "agent://Impl:1-40" })).toBeUndefined();
		expect(supervisorToolBlock("read", { path: "agent://Impl:-40" })).toBeUndefined();
		expect(supervisorToolBlock("read", { path: "agent://Impl:1-200,201-400" })).toBeUndefined();

		for (const path of [
			"agent://",
			"agent://all",
			"agent://parent",
			"agent://peers",
			"agent://123",
			"agent://../etc/passwd",
			"agent://Impl/../../etc/passwd",
			"agent://Impl/",
			"agent://Impl//result",
			"agent://Impl?progress",
			"agent://Impl#frag",
			"agent://Impl:1-401",
			"agent://Impl:1-",
			"agent://Impl:raw",
			"agent://Impl:1-40:raw",
			"agent://Impl/result:1-40",
		]) {
			expect(typeof supervisorToolBlock("read", { path })).toBe("string");
		}
	});

	test("writes are only typed agent messages or local Markdown notes", () => {
		expect(supervisorToolBlock("write", { path: "agent://Impl", content: "review src/a.ts" })).toBeUndefined();
		expect(supervisorToolBlock("write", { path: "local://plan.md", content: "- step" })).toBeUndefined();
		expect(supervisorToolBlock("write", { path: "local://notes/plan.md", content: "- step" })).toBeUndefined();
		expect(supervisorToolBlock("write", { path: "local://plan.md", content: "" })).toBeUndefined();

		const calls = [
			["src/a.ts", "x"],
			["/tmp/x", "x"],
			["ssh://host/etc/app.conf", "x"],
			["xd://edit", "x"],
			["proc://bg_1/kill", ""],
			["mcp://server/tool", "x"],
			["out://report.md", "x"],
			["agent://all", "broadcast"],
			["agent://parent", "x"],
			["agent://123", "x"],
			["agent://Impl?progress", "x"],
			["agent://Impl/field", "x"],
			["agent://Impl:1-40", "x"],
			["agent://", "x"],
			["local://../secret.md", "x"],
			["local:///plan.md", "x"],
			["local://plan", "x"],
			["local://plan.txt", "x"],
			["local://plan.md?x=1", "x"],
			["local://plan.md:1-20", "x"],
		] as const;
		for (const [path, content] of calls) {
			expect(typeof supervisorToolBlock("write", { path, content })).toBe("string");
		}
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
		for (const path of [" agent://Impl", "agent://Impl ", "Agent://Impl", "agent:/Impl", "agent://Impl\n", "local://plan.md\n"]) {
			expect(typeof supervisorToolBlock("read", { path })).toBe("string");
		}
	});
});
