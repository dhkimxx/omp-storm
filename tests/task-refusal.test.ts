import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import type { ToolBlock as ToolBlockView, ToolCall as ToolCallModel } from "@oh-my-pi/pi-coding-agent/ui/transcript/tool-block";
import { refusalCode, REFUSAL_FIELD, REFUSAL_MARK, REFUSAL_WINDOW_MS, RefusedCalls, refusedCodeOf, refusedTaskInput, refusedTaskResult } from "../src/runtime/task-refusal.ts";
import { mountMessage } from "./tui-host.ts";

const REASON = "[storm:lane-write] 레인 'X0'이 레인 'W0'과 겹칩니다.";

describe("task refusal", () => {
	test("a refused input keeps everything the director sent and adds the field omp's task tool rejects", () => {
		const sent = { context: "c", tasks: [{ name: "X0", agent: "storm-implementer", task: "t" }] };
		const refused = refusedTaskInput(sent, REASON);
		expect(refused).toMatchObject(sent);
		expect(refused[REFUSAL_FIELD]).toBe(`${REFUSAL_MARK}:lane-write`);
		expect(refusedCodeOf(refused)).toBe("lane-write");
		// The director's own object is not touched, and a call that sent no object is still marked.
		expect(sent).not.toHaveProperty(REFUSAL_FIELD);
		expect(refusedCodeOf(refusedTaskInput(undefined, REASON))).toBe("lane-write");
		expect(refusedCodeOf(refusedTaskInput(["x"], REASON))).toBe("lane-write");
	});

	test("only a marked input counts as refused", () => {
		expect(refusedCodeOf({ tasks: [] })).toBeUndefined();
		expect(refusedCodeOf({ [REFUSAL_FIELD]: "outputSchema" })).toBeUndefined();
		expect(refusedCodeOf(undefined)).toBeUndefined();
		expect(refusedCodeOf("storm-refused:x")).toBeUndefined();
	});

	test("the code is the tag the reason starts with", () => {
		expect(refusalCode("[storm:auto] x")).toBe("auto");
		expect(refusalCode("[storm:lane-dependency] x")).toBe("lane-dependency");
		expect(refusalCode("no tag")).toBe("refused");
		expect(refusalCode(" [storm:auto] not first")).toBe("refused");
	});

	test("the result is the reason as an error text with a task record that has a results list", () => {
		const result = refusedTaskResult(REASON);
		expect(result.isError).toBe(true);
		expect(result.content).toEqual([{ type: "text", text: REASON }]);
		expect(Array.isArray(result.details.results)).toBe(true);
		// A fresh record each time: nothing is shared between two results.
		expect(refusedTaskResult(REASON).details).not.toBe(result.details);
	});

	test("a reason is handed back once, and the remembered calls are bounded", () => {
		const calls = new RefusedCalls();
		calls.remember("a", REASON);
		expect(calls.take("a")).toBe(REASON);
		expect(calls.take("a")).toBeUndefined();
		for (let i = 0; i < 1_000; i++) calls.remember(`call-${i}`, REASON);
		expect(calls.size).toBeLessThanOrEqual(256);
		expect(calls.take("call-0")).toBeUndefined();
		expect(calls.take("call-999")).toBe(REASON);
	});
	test("an unsettled refused call is reported until it settles, is forgotten, or outlives its window", () => {
		const calls = new RefusedCalls();
		expect(calls.unsettled()).toBeUndefined();
		calls.remember("a", REASON, 1_000);
		expect(calls.unsettled(1_000)).toBe(REASON);
		// Its result settles it.
		expect(calls.take("a")).toBe(REASON);
		expect(calls.unsettled(1_000)).toBeUndefined();
		// A call that ended without a result is forgotten at once.
		calls.remember("b", REASON, 1_000);
		calls.forget("b");
		expect(calls.unsettled(1_000)).toBeUndefined();
		// A call the host never settles stops counting after its window, and a newer one still does.
		calls.remember("c", REASON, 1_000);
		expect(calls.unsettled(1_000 + REFUSAL_WINDOW_MS - 1)).toBe(REASON);
		expect(calls.unsettled(1_000 + REFUSAL_WINDOW_MS)).toBeUndefined();
		calls.remember("d", "[storm:auto] newer", 1_000 + REFUSAL_WINDOW_MS);
		expect(calls.unsettled(1_000 + REFUSAL_WINDOW_MS)).toBe("[storm:auto] newer");
	});
});

/**
 * The host side of the same contract, against the pinned omp's own transcript block and presenters. omp reaches them
 * only by file (its `.tsx` sources are not in the package's exports), so a host without that source skips this part.
 */
const SOURCE = new URL("../node_modules/@oh-my-pi/pi-coding-agent/src/ui/", import.meta.url);
const hostHasView = existsSync(new URL("transcript/tool-block.tsx", SOURCE));

interface HostView {
	ToolCall: typeof ToolCallModel;
	ToolBlock: typeof ToolBlockView;
	names: () => string[];
}

async function hostView(): Promise<HostView> {
	await import(new URL("tools/index.ts", SOURCE).href);
	const registry = (await import(new URL("tools/registry.ts", SOURCE).href)) as { toolPresenterNames: () => string[] };
	const block = (await import(new URL("transcript/tool-block.tsx", SOURCE).href)) as Pick<HostView, "ToolCall" | "ToolBlock">;
	return { ...block, names: registry.toolPresenterNames };
}

/** What a call that ended without running leaves in the transcript: the loop's blocked result, or a result Storm shaped. */
function paint(host: HostView, name: string, args: unknown, details: unknown): string[] {
	const call = new host.ToolCall({ id: "c1", name, args });
	call.updateResult({ content: [{ type: "text", text: REASON }], details, isError: true } as never, false);
	// Reading the view is where omp's task presenter builds the agent rows; mounting is where the card is painted.
	call.view();
	const view = mountMessage(() => host.ToolBlock({ call }) as never, { customType: "t", content: "" }, { columns: 100, rows: 12 });
	try {
		return view.screen();
	} finally {
		view.dispose();
	}
}

describe.skipIf(!hostHasView)("omp's transcript view of a call that did not run", () => {
	test("a refused task call is drawn as a failed card, and drawing it again after an expand or a collapse does not throw", async () => {
		const host = await hostView();
		const args = { context: "c", tasks: [{ name: "X0", agent: "storm-implementer", task: "t" }] };
		for (const expanded of [false, true]) {
			const call = new host.ToolCall({ id: "c1", name: "task", args });
			call.setExpanded(expanded);
			call.updateResult({ ...refusedTaskResult(REASON) } as never, false);
			expect(() => call.view()).not.toThrow();
			const view = mountMessage(() => host.ToolBlock({ call }) as never, { customType: "t", content: "" }, { columns: 100, rows: 12 });
			expect(view.text()).toContain("Task");
			expect(call.status()).toBe("error");
			call.setExpanded(!expanded);
			expect(() => call.view()).not.toThrow();
			view.dispose();
		}
	});

	// omp 19.2.1 reads any truthy `details` of a task result as a full task record. When this stops throwing, the host
	// draws the block a plain `block: true` leaves and task-refusal.ts can go.
	test("a task result with details {} still throws in omp's view: the shape a plain block leaves", async () => {
		const host = await hostView();
		expect(() => paint(host, "task", { context: "c", tasks: [{ name: "X0", agent: "storm-implementer", task: "t" }] }, {})).toThrow();
	});

	// Storm refuses these with a plain block (details {}); every built-in tool's view must draw that. `bash` is left out:
	// its shell painter is registered by the host's shell, which a test terminal does not load.
	test("every other built-in tool's view draws the result of a blocked call", async () => {
		const host = await hostView();
		const names = host.names().filter(name => name !== "task" && name !== "bash");
		expect(names).toContain("read");
		expect(names).toContain("write");
		expect(names).toContain("ask");
		expect(names).toContain("eval");
		const failed: string[] = [];
		for (const name of [...names, "mcp_server_tool", "a_tool_without_a_presenter"]) {
			for (const expanded of [false, true]) {
				try {
					const call = new host.ToolCall({ id: "c1", name, args: {} });
					call.setExpanded(expanded);
					call.updateResult({ content: [{ type: "text", text: REASON }], details: {}, isError: true } as never, false);
					call.view();
					const view = mountMessage(() => host.ToolBlock({ call }) as never, { customType: "t", content: "" }, { columns: 100, rows: 12 });
					view.dispose();
				} catch (error) {
					failed.push(`${name}: ${(error as Error).message}`);
				}
			}
		}
		expect(failed).toEqual([]);
	});
});
