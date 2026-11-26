import { describe, expect, test } from "bun:test";
import * as zod from "@oh-my-pi/omptype/zod";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import storm, { NEEDS_NEWER_OMP } from "../src/entry.ts";

describe("the entry the host loads", () => {
	test("a host that cannot load the screen layer gets /storm with one message, and nothing else is loaded", async () => {
		const commands: Array<{ name: string; handler: (args: string, ctx: unknown) => Promise<void> }> = [];
		const pi = { registerCommand: (name: string, definition: { handler: (args: string, ctx: unknown) => Promise<void> }) => void commands.push({ name, handler: definition.handler }) } as unknown as ExtensionAPI;
		await storm(pi, async () => false);
		expect(commands.map(command => command.name)).toEqual(["storm"]);
		const notices: Array<[string, string]> = [];
		await commands[0]!.handler("", { ui: { notify: (message: string, level: string) => void notices.push([message, level]) } });
		expect(notices).toEqual([[NEEDS_NEWER_OMP, "error"]]);
	});

	test("on a host with the library it loads the extension: /storm and the rest are registered by it", async () => {
		const commands: string[] = [];
		const pi = {
			exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
			pi: { getAgentDir: () => "/tmp/storm-entry-test-agent" },
			zod,
			on: () => undefined,
			registerTool: () => undefined,
			registerMessageRenderer: () => undefined,
			registerCommand: (name: string) => void commands.push(name),
		} as unknown as ExtensionAPI;
		await storm(pi);
		expect(commands).toContain("storm");
	});

	test("the message for an old host says what is needed", () => {
		expect(NEEDS_NEWER_OMP).toContain("19.2");
		expect(NEEDS_NEWER_OMP).toContain("release/omp-19.0");
	});
});
