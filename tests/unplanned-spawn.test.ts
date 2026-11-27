import { expect, test } from "bun:test";
import { WHY_EXEC_WRITER, WHY_TOOLS_UNKNOWN, WHY_UNDECLARED_WRITER } from "../src/policy/capability.ts";
import {
	carriesEvalTools,
	classifyUnplannedItem,
	isolatedToolsReason,
	unplannedBatchFacts,
	unplannedBatchGate,
	WHY_ITEM_TOOLS,
	type UnplannedItemFacts,
} from "../src/policy/unplanned-spawn.ts";

const facts = (over: Partial<UnplannedItemFacts> = {}): UnplannedItemFacts => ({
	agent: "storm-implementer",
	tools: ["read", "grep"],
	toolsCarried: false,
	isolated: false,
	...over,
});

test("a read-only definition is a reader; a shell alone is a shell reader; everything else is a shared writer", () => {
	expect(classifyUnplannedItem(facts())).toMatchObject({ ok: true, item: { policy: { kind: "read" }, authority: { kind: "read" } } });
	const shell = classifyUnplannedItem(facts({ tools: ["read", "bash"] }));
	expect(shell).toMatchObject({ ok: true, item: { policy: { kind: "read", shell: true }, authority: { kind: "unknown" } } });
	// A path tool without declared files cannot be bounded; an unreadable list is every tool.
	for (const [tools, why] of [
		[["read", "write"], WHY_UNDECLARED_WRITER],
		[["read", "eval"], WHY_EXEC_WRITER],
		[undefined, WHY_TOOLS_UNKNOWN],
	] as const) {
		const writer = classifyUnplannedItem(facts({ tools }));
		expect(writer).toMatchObject({ ok: true, item: { policy: { kind: "unknown", reason: why }, authority: { kind: "unknown" } } });
	}
});

test("eval-defined tools make an item a shared writer, never a reader or a private one", () => {
	for (const tools of [["read", "grep"], ["read", "bash"], undefined]) {
		const carried = classifyUnplannedItem(facts({ tools, toolsCarried: true }));
		expect(carried).toMatchObject({ ok: true, item: { policy: { kind: "unknown", reason: WHY_ITEM_TOOLS }, authority: { kind: "unknown" } } });
	}
	// Its tools run in the director's work folder, outside any checkout (HF-3/D7): isolation is refused outright.
	const refused = classifyUnplannedItem(facts({ toolsCarried: true, isolated: true }));
	expect(refused).toMatchObject({ ok: false, code: "isolation" });
	if (!refused.ok) expect(refused.reason).toBe(isolatedToolsReason("storm-implementer"));
});

test("an isolated item is private whatever its tools, a shell included (D10)", () => {
	for (const tools of [["read", "grep"], ["read", "bash"], ["read", "write"], undefined]) {
		expect(classifyUnplannedItem(facts({ tools, isolated: true }))).toMatchObject({
			ok: true,
			item: { policy: { kind: "private" }, authority: { kind: "private" } },
		});
	}
});

test("the tools field counts as carried when it holds anything, and an empty list does not", () => {
	expect(carriesEvalTools({})).toBe(false);
	expect(carriesEvalTools({ tools: [] })).toBe(false);
	expect(carriesEvalTools({ tools: ["marker"] })).toBe(true);
	// A malformed value is not proof that nothing will run: fail closed.
	expect(carriesEvalTools({ tools: "marker" })).toBe(true);
	expect(carriesEvalTools({ tools: [""] })).toBe(true);
});

test("the plan-less batch check refuses two shared writers against an empty table", () => {
	const writer = facts({ tools: ["read", "bash"] });
	const two = unplannedBatchGate([writer, facts({ agent: "storm-quick", tools: ["read", "bash"] })]);
	expect(two).toMatchObject({ ok: false, code: "lane-write" });
	// A reader beside one writer passes and needs the shared order once.
	const mixed = unplannedBatchGate([writer, facts({ agent: "storm-explorer", tools: ["read", "grep"] })]);
	expect(mixed).toMatchObject({ ok: true, writers: 1 });
	if (mixed.ok) expect(mixed.items.map(item => item.authority.kind)).toEqual(["unknown", "read"]);
	const one = unplannedBatchGate([writer]);
	expect(one).toMatchObject({ ok: true, writers: 1 });
	const readers = unplannedBatchGate([facts(), facts({ agent: "storm-explorer", tools: ["read"] })]);
	expect(readers).toMatchObject({ ok: true, writers: 0 });
	// An empty batch has nothing to refuse; the caller refuses it elsewhere.
	expect(unplannedBatchGate([])).toMatchObject({ ok: true, writers: 0 });
});

test("an isolated batch needs omp isolation on and apply off, and two private workers may run together", () => {
	const isolated: UnplannedItemFacts[] = [facts({ isolated: true, tools: ["read", "bash"] }), facts({ agent: "storm-quick", isolated: true })];
	for (const host of [undefined, { enabled: false, apply: false }, { enabled: true }, { enabled: true, apply: true }]) {
		const refused = unplannedBatchGate(isolated, host);
		expect(refused).toMatchObject({ ok: false, code: "isolation" });
		if (!refused.ok) expect(refused.reason).toContain("task.isolation");
	}
	expect(unplannedBatchGate(isolated, { enabled: true, apply: false })).toMatchObject({ ok: true, writers: 0 });
});

test("the batch facts read the call without placing or naming anything", () => {
	const tools: Record<string, readonly string[]> = { "storm-implementer": ["read", "bash"], "storm-explorer": ["read"] };
	const call = { tasks: [{ agent: "storm-implementer", name: "api", task: "A" }, { task: "B", isolated: true }] };
	const read = unplannedBatchFacts(call, false, agent => tools[agent]);
	expect(read.ok).toBe(true);
	if (read.ok) {
		expect(read.items.map(item => item.agent)).toEqual(["storm-implementer", "task"]);
		expect(read.items[0]).toMatchObject({ name: "api", toolsCarried: false, isolated: false });
		expect(read.items[1]).toMatchObject({ isolated: true, tools: undefined });
	}
	// A team that isolates every worker makes every item isolated, whatever its own flag.
	const teamIsolated = unplannedBatchFacts(call, true, agent => tools[agent]);
	if (teamIsolated.ok) expect(teamIsolated.items.every(item => item.isolated)).toBe(true);
	expect(unplannedBatchFacts({ tasks: [] }, false, () => undefined)).toMatchObject({ ok: false });
	expect(unplannedBatchFacts({ tasks: [42] }, false, () => undefined)).toMatchObject({ ok: false });
	expect(unplannedBatchFacts("nope", false, () => undefined)).toMatchObject({ ok: false });
});
