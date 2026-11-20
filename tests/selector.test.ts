import { describe, expect, test } from "bun:test";
import { entryEffort, formatModelEntry, parseModelEntry } from "../src/selector.ts";
import { EFFORTS } from "../src/types.ts";

describe("parseModelEntry", () => {
	test("splits a known effort suffix", () => {
		expect(parseModelEntry("deepseek/deepseek-v4.1-flash:max")).toEqual({ selector: "deepseek/deepseek-v4.1-flash", effort: "max" });
		expect(parseModelEntry("anthropic/claude-haiku-5-5:low")).toEqual({ selector: "anthropic/claude-haiku-5-5", effort: "low" });
		for (const effort of EFFORTS) expect(parseModelEntry(`a/x:${effort}`)).toEqual({ selector: "a/x", effort });
	});

	test("bare selectors and unknown suffixes stay whole", () => {
		expect(parseModelEntry("openai/gpt-6")).toEqual({ selector: "openai/gpt-6" });
		expect(parseModelEntry("anthropic/claude-x:thinking")).toEqual({ selector: "anthropic/claude-x:thinking" });
		expect(parseModelEntry("a/x:HIGH")).toEqual({ selector: "a/x:HIGH" });
		expect(parseModelEntry("a/x:")).toEqual({ selector: "a/x:" });
	});

	test("ids containing ':' or '/' keep everything but a trailing effort", () => {
		expect(parseModelEntry("openrouter/qwen/qwen3")).toEqual({ selector: "openrouter/qwen/qwen3" });
		expect(parseModelEntry("openrouter/qwen/qwen3:high")).toEqual({ selector: "openrouter/qwen/qwen3", effort: "high" });
		expect(parseModelEntry("anthropic/claude-x:thinking:max")).toEqual({ selector: "anthropic/claude-x:thinking", effort: "max" });
		expect(parseModelEntry("bedrock/us.anthropic.claude:v2:low")).toEqual({ selector: "bedrock/us.anthropic.claude:v2", effort: "low" });
		// A colon before the last slash belongs to the provider path, not an effort.
		expect(parseModelEntry("proxy:high/model")).toEqual({ selector: "proxy:high/model" });
	});
});

describe("formatModelEntry", () => {
	test("appends the effort only when present", () => {
		expect(formatModelEntry({ selector: "a/x", effort: "max" })).toBe("a/x:max");
		expect(formatModelEntry({ selector: "a/x" })).toBe("a/x");
		expect(formatModelEntry({ selector: "openrouter/qwen/qwen3", effort: "low" })).toBe("openrouter/qwen/qwen3:low");
	});

	test("round-trips through parse, including ids with ':' and '/'", () => {
		for (const entry of ["a/x", "a/x:minimal", "openrouter/qwen/qwen3:xhigh", "anthropic/claude-x:thinking", "anthropic/claude-x:thinking:medium"]) {
			expect(formatModelEntry(parseModelEntry(entry))).toBe(entry);
		}
	});
});

describe("entryEffort", () => {
	test("the entry's own suffix wins over the role default", () => {
		expect(entryEffort("a/x:max", "low")).toBe("max");
		expect(entryEffort("a/x", "low")).toBe("low");
		expect(entryEffort("a/x", undefined)).toBeUndefined();
		expect(entryEffort("anthropic/claude-x:thinking", "high")).toBe("high");
	});
});
