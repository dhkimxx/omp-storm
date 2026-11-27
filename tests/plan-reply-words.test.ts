/**
 * What the plan reply tells the director while it can still use it (the run of 2026-11-26): which writer lanes the
 * start will run one at a time and why, that a reader may ride along, and that isolated lanes cannot start while omp
 * isolation is off. The same text must stay away from lanes the plan already orders, from path-only workers whose files
 * do separate writers, and from a machine where isolation is on.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WHY_AUTO_WRITER, WHY_EXEC_WRITER, WHY_UNDECLARED_WRITER } from "../src/policy/capability.ts";
import type { StormToolHost } from "../src/tool/host.ts";
import { runStormTool, type StormToolInput } from "../src/tool/storm-tool.ts";
import type { ShadowInfo } from "../src/types.ts";
import { fakeHost } from "./fake-host.ts";

type PlanInput = NonNullable<StormToolInput["plan"]>;
type LaneInput = PlanInput["lanes"][number];

const DIR = (name: string) => `.local-ops/benchmarks/${name}`;
const writer = (name: string, files?: string[], extra: Partial<LaneInput> = {}): LaneInput => ({
	name,
	kind: "code",
	...(files === undefined ? {} : { files }),
	goal: `deliver ${name}`,
	results: [{ id: `${name}-change`, kind: "change", criterion: `${name} changes the tree`, path: files?.[0] ?? `src/${name}.ts` }],
	...extra,
});
const reader = (name: string, extra: Partial<LaneInput> = {}): LaneInput => ({
	name,
	kind: "explore",
	goal: `trace ${name}`,
	results: [{ id: `${name}-answer`, kind: "answer", criterion: `${name} reports what the tree contains` }],
	...extra,
});

const BODY = "GemmaQatBody";
const HEAD = "GemmaQatHead";
const RAM = "GemmaMemoryHandoff";
const SCOUT = "TraceClawQatProducer";

/** The plan at 14:16:51: three implementers, no files. */
const plan1: PlanInput = { lanes: [writer(BODY), writer(HEAD), writer(RAM)] };
/** The plan at 14:18:50: one directory per implementer, plus one explorer. */
const plan2: PlanInput = {
	lanes: [writer(BODY, [DIR("gemma4-body-qat")]), writer(HEAD, [DIR("gemma4-head-qat")]), writer(RAM, [DIR("gemma4-ram-handoff")]), reader(SCOUT)],
};

interface Options {
	auto?: boolean;
	isolation?: boolean | undefined;
	shadows?: ShadowInfo[];
}

async function reply(plan: PlanInput, options: Options = {}): Promise<string> {
	const f = fakeHost({ runActive: true, ...(options.shadows === undefined ? {} : { shadows: options.shadows }) });
	const host: StormToolHost = {
		...f.host,
		...(options.auto === true ? { auto: () => ({ enabled: true }) } : {}),
		isolationEnabled: () => options.isolation,
	};
	const r = await runStormTool(host, { action: "plan", plan });
	expect(r.outcome).toBe("ok");
	return r.text;
}

const line = (text: string, prefix: string) => text.split("\n").find(l => l.startsWith(prefix));

describe("writers that will start one at a time", () => {
	test("14:16:51 and 14:18:50 under automatic delegation: the three lanes and the cause (the tool, not the mode) are named, files or not", async () => {
		for (const plan of [plan1, plan2]) {
			const text = await reply(plan, { auto: true });
			const order = line(text, "- 쓰기 순서");
			expect(order).toBeDefined();
			for (const name of [BODY, HEAD, RAM]) expect(order).toContain(name);
			expect(order).not.toContain(SCOUT);
			// The bundled implementer has bash and eval: that is why it is unbounded, and the mode is no part of it.
			expect(order).toContain(WHY_EXEC_WRITER);
			expect(order).not.toContain(WHY_AUTO_WRITER);
			// The files the director split are said to change nothing, and a reader may share the call.
			expect(order).toContain("파일 목록과 무관");
			expect(order).toContain("읽기 전용");
			expect(order).not.toContain("격리");
		}
	});

	test("manual direction with the bundled implementer (bash, eval): the cause is the tool", async () => {
		const order = line(await reply(plan2), "- 쓰기 순서");
		expect(order).toBeDefined();
		expect(order).toContain(WHY_EXEC_WRITER);
		expect(order).not.toContain(WHY_AUTO_WRITER);
	});

	test("the plan line is one line and stays short", async () => {
		const text = await reply(plan2, { auto: true });
		const order = line(text, "- 쓰기 순서")!;
		expect(order.length).toBeLessThan(170);
		expect(text.split("\n").filter(l => l.startsWith("- 쓰기 순서"))).toHaveLength(1);
	});

	test("lanes the plan already orders through dependsOn get no line", async () => {
		const chained: PlanInput = {
			lanes: [
				writer(BODY, [DIR("a")]),
				writer(HEAD, [DIR("b")], { dependsOn: [{ lane: BODY, need: "result" }] }),
				writer(RAM, [DIR("c")], { dependsOn: [{ lane: HEAD, need: "result" }] }),
			],
		};
		expect(line(await reply(chained, { auto: true }), "- 쓰기 순서")).toBeUndefined();
	});

	test("only the unordered writers are named when part of the plan is ordered", async () => {
		const partial: PlanInput = {
			lanes: [writer(BODY, [DIR("a")]), writer(HEAD, [DIR("b")], { dependsOn: [{ lane: BODY, need: "result" }] }), writer(RAM, [DIR("c")])],
		};
		const order = line(await reply(partial, { auto: true }), "- 쓰기 순서")!;
		// RAM runs beside BODY or HEAD's turn, so it and the writer it is unordered with are named; BODY and HEAD are ordered with each other.
		expect(order).toContain(RAM);
		expect(order).toContain(BODY);
		expect(order).toContain(HEAD);
	});

	test("a single writer, or a writer with readers only, gets no line", async () => {
		expect(line(await reply({ lanes: [writer(BODY, [DIR("a")]), reader(SCOUT)] }, { auto: true }), "- 쓰기 순서")).toBeUndefined();
		expect(line(await reply({ lanes: [reader(SCOUT), reader("Other")] }, { auto: true }), "- 쓰기 순서")).toBeUndefined();
	});

	describe("a path-only worker in manual direction", () => {
		let dir: string | undefined;
		afterEach(() => {
			if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
			dir = undefined;
		});
		const shadow = (): ShadowInfo[] => {
			dir = mkdtempSync(join(tmpdir(), "storm-f2-plan-"));
			const file = join(dir, "storm-implementer.md");
			writeFileSync(file, "---\nname: storm-implementer\ntools: read, write, edit\n---\nbody\n");
			return [{ agent: "storm-implementer", path: file, scope: "project", sha256: "0".repeat(64) }];
		};

		test("whose files do separate writers gets no line", async () => {
			expect(line(await reply(plan2, { shadows: shadow() }), "- 쓰기 순서")).toBeUndefined();
		});

		test("the same worker under automatic delegation gets none either: the mode no longer makes a writer unbounded", async () => {
			expect(line(await reply(plan2, { auto: true, shadows: shadow() }), "- 쓰기 순서")).toBeUndefined();
		});

		test("without declared files it is unbounded in either mode, and the line names that", async () => {
			for (const auto of [false, true]) {
				const order = line(await reply(plan1, { auto, shadows: shadow() }), "- 쓰기 순서");
				expect(order, `auto=${auto}`).toBeDefined();
				for (const name of [BODY, HEAD, RAM]) expect(order).toContain(name);
				expect(order).toContain(WHY_UNDECLARED_WRITER);
				expect(order).not.toContain(WHY_AUTO_WRITER);
			}
		});
	});

	test("lanes that are isolated are not exclusive writers", async () => {
		const isolated: PlanInput = {
			lanes: [writer(BODY, [DIR("a")], { isolationReason: "independent trial" }), writer(HEAD, [DIR("b")], { isolationReason: "independent trial" })],
		};
		expect(line(await reply(isolated, { auto: true, isolation: true }), "- 쓰기 순서")).toBeUndefined();
	});
});

describe("isolated lanes while omp isolation is off", () => {
	/** The plan at 14:21:38: Head and RamHandoff carry an isolationReason; Body stays shared. */
	const plan3: PlanInput = {
		lanes: [
			writer(BODY, [DIR("gemma4-body-qat")]),
			writer(HEAD, [DIR("gemma4-head-qat")], { isolationReason: "independent head trial" }),
			writer(RAM, [DIR("gemma4-ram-handoff")], { isolationReason: "independent handoff trial" }),
		],
	};

	test("14:21:38 with isolation off: the lanes are named, with who turns it on and the way that works now", async () => {
		const off = line(await reply(plan3, { auto: true, isolation: false }), "- 격리 불가");
		expect(off).toBeDefined();
		expect(off).toContain(HEAD);
		expect(off).toContain(RAM);
		expect(off).not.toContain(BODY);
		expect(off).toContain("task.isolation.enabled");
		expect(off).toContain("사용자");
		expect(off).toContain("isolationReason");
	});

	test("with isolation on, or not known, there is no such line", async () => {
		expect(line(await reply(plan3, { auto: true, isolation: true }), "- 격리 불가")).toBeUndefined();
		expect(line(await reply(plan3, { auto: true, isolation: undefined }), "- 격리 불가")).toBeUndefined();
	});

	test("a plan with no isolated lane never gets it", async () => {
		expect(line(await reply(plan2, { auto: true, isolation: false }), "- 격리 불가")).toBeUndefined();
	});

	test("with isolation on, the isolated lanes are not told to run one at a time", async () => {
		const text = await reply(plan3, { auto: true, isolation: true });
		const order = line(text, "- 쓰기 순서");
		// Only Body is a shared writer left: nothing to order.
		expect(order).toBeUndefined();
	});
});

describe("the plan reply keeps to the size it had", () => {
	test("the extra lines of the real plan add under 600 characters", async () => {
		const plain = await reply({ lanes: [writer(BODY, [DIR("a")]), reader(SCOUT)] }, { auto: true });
		const full = await reply(plan2, { auto: true });
		expect(full.length - plain.length).toBeLessThan(220);
	});
});
