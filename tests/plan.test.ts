import { describe, expect, test } from "bun:test";
import { planChange } from "../src/plan/change.ts";
import {
	MAX_LANE_DEPENDENCIES,
	MAX_LANE_RESULTS,
	MAX_LANE_TEXT,
	MAX_RESULT_CONTAINS,
	MAX_RESULT_CRITERION,
	MAX_RESULT_ID,
	MAX_RESULT_PATH,
	parseLaneDependencies,
	parseLaneResults,
	validatePlan,
} from "../src/plan/validate.ts";
import { ROLES } from "../src/roles.ts";
import type { Candidate, RoleRecommendation, StormConfig } from "../src/types.ts";
import { teamOf } from "./fixtures.ts";
import { cand as candidate } from "./support.ts";

const NOW = Date.parse("2026-11-21T00:00:00Z");
/** A minimal observable contract for a fresh lane: answer lanes report, change lanes deliver a tree change. */
const contract = (id: string, kind: "explore" | "code" | "run" | "design" = "code") => [
	{ id, kind: kind === "explore" || kind === "design" ? ("answer" as const) : ("change" as const), criterion: "the lane delivered what its goal names" },
];
const config: StormConfig = teamOf(
	{ implementer: { models: ["a/i"], workers: { min: 1, max: 3 } }, reviewer: "b/r", quick: { models: ["a/q"], workers: 2 } },
	{ disabledRoles: ["architect"] },
);

describe("validatePlan", () => {
	test("roles resolve from kind along the stand-ins; a role's default workers are its lanes, clamped to its range", () => {
		const r = validatePlan(
			config,
			{
				lanes: [
					{ name: "a", kind: "code", results: contract("a") },
					{ name: "b", kind: "explore", results: contract("b", "explore") },
					{ name: "c", kind: "design", results: contract("c", "design") },
					{ name: "d", kind: "run", results: contract("d", "run") },
					{ name: "e", kind: "review" },
				],
			},
			NOW,
		);
		expect(r.errors).toEqual([]);
		expect(r.outOfBounds).toEqual([]);
		// explorer missing → quick; architect disabled → reviewer.
		expect(r.plan!.lanes.map((l) => l.role)).toEqual(["implementer", "quick", "reviewer", "quick", "reviewer"]);
		// implementer 1 lane in 1..3 → 1; quick 2 lanes in 2..2 → 2; reviewer 2 lanes in 1..2 → 2.
		expect(r.plan!.workers).toEqual({ implementer: 1, quick: 2, reviewer: 2 });
	});

	test("default workers follow the lane count up to the role's max and never go below its min", () => {
		const lanes = (n: number, kind: "code" | "run") =>
			Array.from({ length: n }, (_, i) => ({ name: `${kind}${i}`, kind, results: contract(`${kind}-${i}`, kind) }));
		const workers = (input: unknown) => validatePlan(config, input, NOW).plan?.workers;
		expect(workers({ lanes: lanes(2, "code") })).toEqual({ implementer: 2 });
		expect(workers({ lanes: lanes(5, "code") })).toEqual({ implementer: 3 });
		expect(workers({ lanes: lanes(1, "run") })).toEqual({ quick: 2 });
		// An explicit count wins over the default.
		expect(workers({ lanes: lanes(3, "code"), workers: { implementer: 1 } })).toEqual({ implementer: 1 });
		expect(validatePlan(config, { lanes: lanes(5, "code") }, NOW).outOfBounds).toEqual([]);
	});

	test("workers for a role without lanes, or for no role at all, are ignored with a warning; that role gets no workers", () => {
		const r = validatePlan(
			config,
			{ lanes: [{ name: "a", kind: "code", results: contract("a") }], workers: { implementer: 2, reviewer: 1, boss: 3 } },
			NOW,
		);
		expect(r.errors).toEqual([]);
		expect(r.plan?.workers).toEqual({ implementer: 2 });
		expect(r.warnings).toHaveLength(2);
		expect(r.warnings.some((w) => w.includes("reviewer"))).toBe(true);
		expect(r.warnings.some((w) => w.includes("boss"))).toBe(true);
	});

	test("workers past max and explicit disabled/missing roles are gaps, the plan still returns", () => {
		const r = validatePlan(
			config,
			{
				lanes: [
					{ name: "a", kind: "code", results: contract("a") },
					{ name: "b", kind: "design", role: "architect", results: contract("b", "design") },
					{ name: "c", kind: "explore", role: "explorer", results: contract("c", "explore") },
				],
				workers: { implementer: 4 },
			},
			NOW,
		);
		expect(r.errors).toEqual([]);
		expect(r.outOfBounds).toEqual([
			{ kind: "role", role: "architect", state: "disabled" },
			{ kind: "role", role: "explorer", state: "missing" },
			{ kind: "workers", role: "implementer", want: 4, max: 3 },
		]);
		expect(r.plan?.workers).toEqual({ implementer: 4, architect: 1, explorer: 2 });
	});

	test("goal and progress trim, stay optional, and share one bound; progress adds no write scope", () => {
		const r = validatePlan(
			config,
			{
				lanes: [
					{ name: "a", kind: "code", goal: "  Deliver A  ", progress: "  (완료) A16  ", results: contract("a") },
					{ name: "b", kind: "code", goal: "   ", progress: "", results: contract("b") },
					{ name: "c", kind: "code", goal: "x".repeat(MAX_LANE_TEXT), progress: "y".repeat(MAX_LANE_TEXT), results: contract("c") },
				],
			},
			NOW,
		);
		expect(r.errors).toEqual([]);
		expect(r.plan!.lanes[0]).toMatchObject({ goal: "Deliver A", progress: "(완료) A16" });
		expect(r.plan!.lanes[0]!.files).toBeUndefined();
		expect(r.plan!.lanes[1]).not.toHaveProperty("goal");
		expect(r.plan!.lanes[1]).not.toHaveProperty("progress");
		expect(r.plan!.lanes[2]).toMatchObject({
			goal: "x".repeat(MAX_LANE_TEXT),
			progress: "y".repeat(MAX_LANE_TEXT),
		});
		const tooLong = validatePlan(
			config,
			{
				lanes: [
					{
						name: "a",
						kind: "code",
						goal: "x".repeat(MAX_LANE_TEXT + 1),
						progress: "y".repeat(MAX_LANE_TEXT + 1),
						results: contract("a"),
					},
				],
			},
			NOW,
		);
		expect(tooLong.plan).toBeUndefined();
		expect(tooLong.errors).toHaveLength(2);
		expect(tooLong.errors[0]).toContain("goal");
		expect(tooLong.errors[1]).toContain("progress");
	});

	test("isolationReason is opt-in: omitted lanes share the tree, a present one trims and persists as one bounded line", () => {
		const r = validatePlan(
			config,
			{
				lanes: [
					{ name: "shared", kind: "code", results: contract("shared") },
					{ name: "probe", kind: "run", isolationReason: "  compare parser backends  ", results: contract("probe", "run") },
					{ name: "bench", kind: "code", isolationReason: "x".repeat(MAX_LANE_TEXT), results: contract("bench") },
				],
			},
			NOW,
		);
		expect(r.errors).toEqual([]);
		expect(r.plan!.lanes[0]).not.toHaveProperty("isolationReason");
		expect(r.plan!.lanes[1]!.isolationReason).toBe("compare parser backends");
		expect(r.plan!.lanes[2]!.isolationReason).toHaveLength(MAX_LANE_TEXT);
	});

	test("a present isolationReason must be an actual single safe line; a boolean or a blank is rejected", () => {
		const check = (reason: unknown) =>
			validatePlan(config, { lanes: [{ name: "probe", kind: "code", isolationReason: reason, results: contract("probe") }] }, NOW);
		for (const reason of [
			true,
			false,
			"",
			"   ",
			"line one\nline two",
			"tab\there",
			"bell\u0007",
			"separator\u2028here",
			"x".repeat(MAX_LANE_TEXT + 1),
		]) {
			const r = check(reason);
			expect(r.plan).toBeUndefined();
			expect(r.errors).toHaveLength(1);
			expect(r.errors[0]).toContain("isolationReason");
		}
	});

	test("selective isolation is refused on the final review role or kind; legacy isolated teams still plan", () => {
		const reason = "compare independent implementations";
		for (const lane of [
			{ name: "check", kind: "review", isolationReason: reason },
			{ name: "check", kind: "code", role: "reviewer", isolationReason: reason, results: contract("check") },
		]) {
			const r = validatePlan(config, { lanes: [lane] }, NOW);
			expect(r.plan).toBeUndefined();
			expect(r.errors).toHaveLength(1);
			expect(r.errors[0]).toContain("통합 트리");
			expect(r.errors[0]).toContain("code/run");
		}
		const legacy = validatePlan(
			{ ...config, isolation: "isolated" },
			{
				lanes: [
					{ name: "a", kind: "code", results: contract("a") },
					{ name: "b", kind: "run", isolationReason: reason, results: contract("b", "run") },
				],
			},
			NOW,
		);
		expect(legacy.errors).toEqual([]);
		expect(legacy.plan!.lanes[0]).not.toHaveProperty("isolationReason");
		expect(legacy.plan!.lanes[1]!.isolationReason).toBe(reason);
	});

	test("a file overlap stays a warning and never isolates the other lane", () => {
		const r = validatePlan(
			config,
			{
				lanes: [
					{ name: "a", kind: "code", files: ["x.ts"], isolationReason: "independent experiment", results: contract("a") },
					{ name: "b", kind: "run", files: ["x.ts"], results: contract("b", "run") },
				],
			},
			NOW,
		);
		expect(r.errors).toEqual([]);
		const overlap = r.warnings;
		expect(overlap).toHaveLength(1);
		expect(overlap[0]).toContain("순서");
		expect(r.plan!.lanes[1]).not.toHaveProperty("isolationReason");
	});

	test("errors: lane count, names, kind, files, role id and worker values", () => {
		const bad = (input: unknown) => validatePlan(config, input, NOW);
		expect(bad({ lanes: [] }).errors).toHaveLength(1);
		expect(
			bad({ lanes: Array.from({ length: 51 }, (_, i) => ({ name: `l${i}`, kind: "code", results: contract(`l${i}`) })) }).errors,
		).toHaveLength(1);
		const r = bad({
			lanes: [
				{ name: "a", kind: "code", results: contract("a1") },
				{ name: "a", kind: "code", results: contract("a2") },
				{ name: " ", kind: "code", results: contract("blank") },
				{ name: "k", kind: "deploy", results: contract("k") },
				{ name: "f", kind: "code", files: "src", results: contract("f") },
				{ name: "r", kind: "code", role: "boss", results: contract("r") },
			],
			workers: { implementer: 0, reviewer: 1 },
		});
		expect(r.plan).toBeUndefined();
		expect(r.errors).toHaveLength(6);
		expect(bad({ lanes: [{ name: "a", kind: "code", results: contract("a") }], workers: { implementer: 1.5 } }).errors).toHaveLength(1);
	});

	test("no configured role for a kind is an error", () => {
		const only: StormConfig = { ...config, roles: { reviewer: config.roles.reviewer! } };
		expect(validatePlan(only, { lanes: [{ name: "a", kind: "code", results: contract("a") }] }, NOW).errors).toHaveLength(1);
	});

	test("two code/run lanes sharing a file warn; explore lanes do not", () => {
		const r = validatePlan(
			config,
			{
				lanes: [
					{ name: "a", kind: "code", files: ["x.ts"], results: contract("a") },
					{ name: "b", kind: "run", files: ["x.ts"], results: contract("b", "run") },
					{ name: "c", kind: "explore", files: ["y.ts"], results: contract("c", "explore") },
					{ name: "d", kind: "code", files: ["y.ts"], results: contract("d") },
				],
			},
			NOW,
		);
		expect(r.warnings.filter((w) => w.includes("x.ts"))).toHaveLength(1);
		expect(r.warnings.filter((w) => w.includes("x.ts"))[0]).toContain("순서");
	});

	describe("required results", () => {
		const checked: StormConfig = {
			...config,
			requiredChecks: [
				{ name: "test", argv: ["bun", "test"] },
				{ name: "lint", argv: ["bun", "run", "lint"] },
			],
		};
		const one = (results: unknown) => validatePlan(checked, { lanes: [{ name: "a", kind: "code", results }] }, NOW);
		const result = (over: Record<string, unknown> = {}) => ({ id: "r1", kind: "change", criterion: "the file changed", path: "a.ts", ...over });

		test("results trim criterion but keep contains exact, preserve order, and add no proof field", () => {
			const r = one([
				{ id: "report-json", kind: "change", criterion: "  report.json changes  ", path: "out/report.json", contains: "  ok  ", check: "test" },
				{ id: "probe", kind: "artifact", criterion: "patch exists", path: "patches/a.patch" },
				{ id: "answer", kind: "answer", criterion: "cite parser", path: "src/parser.ts", contains: "parse()\nreturns" },
			]);
			expect(r.errors).toEqual([]);
			expect(r.plan!.lanes[0]!.results).toEqual([
				{ id: "report-json", kind: "change", criterion: "report.json changes", path: "out/report.json", contains: "  ok  ", check: "test" },
				{ id: "probe", kind: "artifact", criterion: "patch exists", path: "patches/a.patch" },
				{ id: "answer", kind: "answer", criterion: "cite parser", path: "src/parser.ts", contains: "parse()\nreturns" },
			]);
			// The plan only records obligations: no attempt, state, evidence or reason enters here.
			expect(r.plan!.lanes[0]!.results!.every((item) => !Object.hasOwn(item, "state") && !Object.hasOwn(item, "attemptId"))).toBe(true);
		});

		test("ids are bounded, stable tokens and unique across the whole plan", () => {
			for (const id of ["", "has space", "a/b", "-lead", "x".repeat(MAX_RESULT_ID + 1), "a.b-c_d9"]) {
				const r = one([result({ id })]);
				if (id === "a.b-c_d9") expect(r.errors).toEqual([]);
				else expect(r.errors.some((error) => error.includes(".id:"))).toBe(true);
			}
			const sameLane = one([result({ id: "r1" }), result({ id: "r1", path: "b.ts" })]);
			expect(sameLane.errors.some((error) => error.includes("중복된 결과 id"))).toBe(true);
			const acrossLanes = validatePlan(
				checked,
				{
					lanes: [
						{ name: "a", kind: "code", results: [result()] },
						{ name: "b", kind: "code", results: [result({ id: "r1", path: "b.ts" })] },
					],
				},
				NOW,
			);
			expect(acrossLanes.errors.some((error) => error.includes("plan.lanes[1].results[0].id"))).toBe(true);
		});

		test("every kind requires a criterion; path and contains stay optional, and no kind gets guessed fields", () => {
			const bad = (over: Record<string, unknown>) => one([result(over)]).errors;
			expect(bad({ kind: "deploy" }).some((error) => error.includes(".kind:"))).toBe(true);
			for (const kind of ["change", "artifact", "answer"]) {
				expect(bad({ kind, criterion: undefined }).some((error) => error.includes("criterion"))).toBe(true);
				expect(bad({ kind, path: undefined, contains: undefined })).toEqual([]);
			}
			// A path may cite an answer's source (T01b) and narrow a change; a check still cannot observe an answer.
			expect(bad({ kind: "answer", path: "src/parser.ts", contains: "parse()" })).toEqual([]);
			expect(bad({ kind: "answer", path: undefined, contains: undefined, check: "test" }).some((error) => error.includes("check"))).toBe(true);
		});

		test("paths must be relative, normalized and inside the tree as written", () => {
			const bad = (path: string) => one([result({ path })]).errors.some((error) => error.includes(".path:"));
			for (const path of [
				"/etc/passwd",
				"C:/x",
				"C:x",
				"~/x",
				"a/../b",
				"a/./b",
				"a//b",
				"a/",
				"\\x",
				"a\\b",
				"a:b",
				".git/config",
				"a/.omp/state",
				" a.ts",
				"a.ts ",
				"a\nb",
				"x".repeat(MAX_RESULT_PATH + 1),
			]) {
				expect(bad(path)).toBe(true);
			}
			for (const path of ["src/a.ts", "patches/a.patch", "docs/한글.md", "a/b-c_d.e", ".gitignore"]) {
				expect(one([result({ path })]).errors).toEqual([]);
			}
		});

		test("a check reference is exactly a named approved requiredCheck, never a command", () => {
			expect(one([result({ check: "bun test" })]).errors.some((error) => error.includes("requiredChecks"))).toBe(true);
			const none = validatePlan(config, { lanes: [{ name: "a", kind: "code", results: [result({ check: "test" })] }] }, NOW);
			expect(none.errors.some((error) => error.includes("승인된 requiredChecks가 없습니다"))).toBe(true);
			expect(one([result({ check: "lint" })]).errors).toEqual([]);
			expect(one([result({ check: " Test " })]).errors.some((error) => error.includes("requiredChecks"))).toBe(true);
		});

		test("text and array bounds are enforced before an oversized plan can apply", () => {
			expect(one([result({ criterion: "x".repeat(MAX_RESULT_CRITERION + 1) })]).errors.some((error) => error.includes("criterion"))).toBe(true);
			expect(one([result({ contains: "x".repeat(MAX_RESULT_CONTAINS + 1) })]).errors.some((error) => error.includes("contains"))).toBe(true);
			expect(one([result({ criterion: "   " })]).errors.some((error) => error.includes("criterion"))).toBe(true);
			expect(one([result({ contains: "   " })]).errors.some((error) => error.includes("contains"))).toBe(true);
			expect(one([]).errors.some((error) => error.includes("1~8"))).toBe(true);
			expect(one(Array.from({ length: MAX_LANE_RESULTS + 1 }, (_, i) => result({ id: `r${i}` }))).errors.some((error) => error.includes("1~8"))).toBe(true);
			expect(one(Array.from({ length: MAX_LANE_RESULTS }, (_, i) => result({ id: `r${i}` }))).errors).toEqual([]);
		});

		test("unknown result fields are refused instead of being read as a weaker result", () => {
			const r = one([{ ...result(), contians: "typo" }]);
			expect(r.errors.some((error) => error.includes("알 수 없는 필드") && error.includes("contians"))).toBe(true);
		});

		test("a pathless change or artifact is a qualitative obligation, never an empty pass", () => {
			const r = one([
				{ id: "c", kind: "change", criterion: "the report is regenerated" },
				{ id: "p", kind: "artifact", criterion: "the comparison patch exists" },
			]);
			expect(r.errors).toEqual([]);
			expect(r.plan!.lanes[0]!.results).toEqual([
				{ id: "c", kind: "change", criterion: "the report is regenerated" },
				{ id: "p", kind: "artifact", criterion: "the comparison patch exists" },
			]);
		});

		test("a fresh plan refuses an omitted contract on every deliverable lane; a review gate may omit it", () => {
			const partial = validatePlan(
				config,
				{
					lanes: [
						{ name: "producer", kind: "code", results: [{ id: "p1", kind: "change", criterion: "produced" }] },
						{ name: "coder", kind: "code" },
						{ name: "writer", kind: "run" },
						{ name: "answer", kind: "explore" },
						{ name: "design", kind: "design" },
						{ name: "gate", kind: "review" },
					],
				},
				NOW,
			);
			expect(partial.plan).toBeUndefined();
			expect(partial.errors.some((error) => error.includes("plan.lanes[1].results") && error.includes("'coder'"))).toBe(true);
			expect(partial.errors.some((error) => error.includes("plan.lanes[2].results") && error.includes("'writer'"))).toBe(true);
			expect(partial.errors.some((error) => error.includes("plan.lanes[3].results") && error.includes("'answer'"))).toBe(true);
			expect(partial.errors.some((error) => error.includes("plan.lanes[4].results") && error.includes("'design'"))).toBe(true);
			expect(partial.errors.some((error) => error.includes("'gate'"))).toBe(false);
			expect(partial.warnings).toEqual([]);

			const gate = validatePlan(config, { lanes: [{ name: "gate", kind: "review" }] }, NOW);
			expect(gate.errors).toEqual([]);
			expect(gate.plan!.lanes[0]).not.toHaveProperty("results");
		});

		test("the exported parser is the one wire reader; absent input yields no results", () => {
			expect(parseLaneResults(undefined)).toEqual({ ok: true, results: [] });
			const parsed = parseLaneResults([{ id: "a", kind: "answer", criterion: "answer", contains: "  spaced  " }]);
			if (!parsed.ok) throw new Error(parsed.errors.join("\n"));
			expect(parsed.results).toEqual([{ id: "a", kind: "answer", criterion: "answer", contains: "  spaced  " }]);
			const bad = parseLaneResults([{ id: "a", kind: "change", criterion: "c", check: "test" }]);
			expect(bad.ok).toBe(false);
		});

		test("a stored legacy lane stays readable, while the fresh submit boundary refuses the same omitted contract", () => {
			// The pre-S1 wire in the shape real old plans used: name/kind/files/goal, no results or dependsOn.
			const legacy: { name: string; kind: "code"; files: string[]; goal: string; results?: unknown; dependsOn?: unknown } = {
				name: "legacy",
				kind: "code",
				files: ["a.ts"],
				goal: "ship the old plan",
			};
			expect(parseLaneResults(legacy.results)).toEqual({ ok: true, results: [] });
			expect(parseLaneDependencies(legacy.dependsOn)).toEqual({ ok: true, dependsOn: [] });

			const fresh = validatePlan(config, { lanes: [legacy] }, NOW);
			expect(fresh.plan).toBeUndefined();
			expect(fresh.errors.some((error) => error.includes("plan.lanes[0].results") && error.includes("'legacy'"))).toBe(true);
		});
	});

	describe("lane dependencies", () => {
		const producer = (over: Record<string, unknown> = {}) => ({
			name: "produce",
			kind: "code",
			files: ["a.ts"],
			results: [{ id: "a", kind: "change", criterion: "a.ts changes", path: "a.ts" }],
			...over,
		});
		const consumer = (dependsOn: unknown, over: Record<string, unknown> = {}) => ({
			name: "consume",
			kind: "explore",
			dependsOn,
			results: contract("consume", "explore"),
			...over,
		});
		const plan = (lanes: unknown[]) => validatePlan(config, { lanes }, NOW);

		test("a well-formed edge is kept and normalized; absent edges stay absent, so legacy plans gain nothing", () => {
			const r = plan([
				consumer([{ lane: " produce ", need: "result" }, { lane: "scan", need: "reviewable" }]),
				producer(),
				{ name: "scan", kind: "explore", results: contract("scan", "explore") },
			]);
			expect(r.errors).toEqual([]);
			// Reference order does not matter, and the consumer trims exactly like a lane name.
			expect(r.plan!.lanes[0]!.dependsOn).toEqual([
				{ lane: "produce", need: "result" },
				{ lane: "scan", need: "reviewable" },
			]);
			expect(r.plan!.lanes[1]).not.toHaveProperty("dependsOn");
			expect(r.plan!.lanes[2]).not.toHaveProperty("dependsOn");
		});

		test("unknown, self and repeated prerequisites are rejected before a plan exists", () => {
			const unknown = plan([consumer([{ lane: "missing", need: "reviewable" }]), producer()]);
			expect(unknown.plan).toBeUndefined();
			expect(unknown.errors.some((error) => error.includes("없는 레인") && error.includes("missing"))).toBe(true);
			const self = plan([consumer([{ lane: "consume", need: "reviewable" }]), producer()]);
			expect(self.plan).toBeUndefined();
			expect(self.errors.some((error) => error.includes("자기 자신") && error.includes("consume"))).toBe(true);
			const repeated = plan([
				consumer([{ lane: "produce", need: "result" }, { lane: "produce", need: "reviewable" }]),
				producer(),
			]);
			expect(repeated.plan).toBeUndefined();
			expect(repeated.errors.some((error) => error.includes("중복") && error.includes("produce"))).toBe(true);
		});

		test("cycles are rejected once with their path; a diamond and a forward reference are not", () => {
			const cycle = plan([
				{ name: "a", kind: "explore", results: contract("a", "explore"), dependsOn: [{ lane: "b", need: "reviewable" }] },
				{ name: "b", kind: "explore", results: contract("b", "explore"), dependsOn: [{ lane: "a", need: "reviewable" }] },
			]);
			expect(cycle.plan).toBeUndefined();
			expect(cycle.errors).toHaveLength(1);
			expect(cycle.errors[0]).toContain("순환");
			expect(cycle.errors[0]).toContain("a → b → a");
			const longer = plan([
				{ name: "a", kind: "explore", results: contract("a", "explore"), dependsOn: [{ lane: "b", need: "reviewable" }] },
				{ name: "b", kind: "explore", results: contract("b", "explore"), dependsOn: [{ lane: "c", need: "reviewable" }] },
				{ name: "c", kind: "explore", results: contract("c", "explore"), dependsOn: [{ lane: "a", need: "reviewable" }] },
			]);
			expect(longer.errors.some((error) => error.includes("a → b → c → a"))).toBe(true);
			const diamond = plan([
				consumer([{ lane: "produce", need: "result" }, { lane: "scan", need: "reviewable" }]),
				producer(),
				{ name: "scan", kind: "explore", results: contract("scan", "explore"), dependsOn: [{ lane: "produce", need: "result" }] },
			]);
			expect(diamond.errors).toEqual([]);
			expect(diamond.plan!.lanes[2]!.dependsOn).toEqual([{ lane: "produce", need: "result" }]);
		});

		test("malformed edges, unknown fields and repeated edges are refused; the list is bounded", () => {
			const bad = (dependsOn: unknown) => plan([consumer(dependsOn), producer()]);
			for (const value of [
				[],
				Array.from({ length: MAX_LANE_DEPENDENCIES + 1 }, (_, i) => ({ lane: `p${i}`, need: "reviewable" })),
				[null],
				["produce"],
				[{ lane: "", need: "result" }],
				[{ lane: "produce" }],
				[{ lane: "produce", need: "done" }],
				[{ lane: "produce", need: true }],
				[{ lane: "produce", need: "result", optional: true }],
				[{ lane: "x".repeat(MAX_LANE_TEXT + 1), need: "result" }],
				[{ lane: "pro\nduce", need: "result" }],
			]) {
				const r = bad(value);
				expect(r.plan).toBeUndefined();
				expect(r.errors.length).toBeGreaterThan(0);
			}
			const most = Array.from({ length: MAX_LANE_DEPENDENCIES }, (_, i) => ({ lane: `p${i}`, need: "reviewable" }));
			expect(bad(most).errors.some((error) => error.includes("없는 레인"))).toBe(true);
		});

		test("a result edge needs a prerequisite lane that promises results; reviewable and integrated need none", () => {
			// Only a review gate may omit results on a fresh plan, so it is the remaining prerequisite without a
			// promised result; reviewable/integrated edges need no promise and stay valid.
			const noResults = { name: "scan", kind: "review" };
			const resultEdge = plan([consumer([{ lane: "scan", need: "result" }]), noResults]);
			expect(resultEdge.plan).toBeUndefined();
			expect(resultEdge.errors.some((error) => error.includes("results") && error.includes("scan"))).toBe(true);
			for (const need of ["reviewable", "integrated"]) {
				expect(plan([consumer([{ lane: "scan", need }]), noResults]).errors).toEqual([]);
			}
			expect(plan([consumer([{ lane: "produce", need: "result" }]), producer()]).errors).toEqual([]);
		});

		test("validation copies the wire and applies no partial plan", () => {
			const dependsOn = [{ lane: "produce", need: "result" }];
			const input = { lanes: [consumer(dependsOn), producer()] };
			const snapshot = structuredClone(input);
			const applied = plan(input.lanes);
			expect(applied.errors).toEqual([]);
			expect(input).toEqual(snapshot);
			expect(applied.plan!.lanes[0]!.dependsOn).not.toBe(dependsOn);
			applied.plan!.lanes[0]!.dependsOn![0]!.lane = "changed";
			expect(dependsOn[0]!.lane).toBe("produce");
			const rejected = plan([
				consumer([{ lane: "produce", need: "result" }]),
				producer(),
				{ name: "broken", kind: "explore", results: contract("broken", "explore"), dependsOn: [{ lane: "produce", need: "done" }] },
			]);
			expect(rejected.plan).toBeUndefined();
			expect(input).toEqual(snapshot);
		});

		test("the exported dependency parser reads entry shape only; name resolution stays in validatePlan", () => {
			expect(parseLaneDependencies(undefined)).toEqual({ ok: true, dependsOn: [] });
			expect(parseLaneDependencies([{ lane: " produce ", need: "integrated" }])).toEqual({
				ok: true,
				dependsOn: [{ lane: "produce", need: "integrated" }],
			});
			expect(parseLaneDependencies([{ lane: "missing", need: "reviewable" }])).toEqual({
				ok: true,
				dependsOn: [{ lane: "missing", need: "reviewable" }],
			});
			const bad = parseLaneDependencies([{ lane: "produce", need: "done" }]);
			expect(bad.ok).toBe(false);
		});
	});
});

const cand = (selector: string): Candidate => candidate(selector, { label: selector });

describe("planChange", () => {
	const recs: RoleRecommendation[] = ROLES.map((role) => ({
		role,
		candidates: [cand(`a/${role.id}`), cand(`b/${role.id}`)],
		chosenIndex: 0,
		fallback: cand(`b/${role.id}`),
		excluded: [],
	}));

	test("raises max keeping min, and adds a disabled role with recommended models and default range", () => {
		const r = planChange(
			config,
			[
				{ kind: "role", role: "architect", state: "disabled" },
				{ kind: "workers", role: "implementer", want: 5, max: 3 },
				{ kind: "workers", role: "quick", want: 4, max: 2 },
			],
			{ recs },
		);
		if ("error" in r) throw new Error(r.error);
		expect(r.config.roles.implementer!.workers).toEqual({ min: 1, max: 5 });
		expect(r.config.roles.quick!.workers).toEqual({ min: 2, max: 4 });
		// The role is built the way setup builds it: the recommendation's pick, then its fallback, the default worker range.
		expect(r.config.roles.architect).toMatchObject({ agent: "storm-architect", workers: { min: 1, max: 1 } });
		expect(r.config.roles.architect?.models.map((m) => m.split(":")[0])).toEqual(["a/architect", "b/architect"]);
		expect(r.config.disabledRoles).toBeUndefined();
	});

	test("a role to add needs recommendations; a want past 16 fails validation", () => {
		expect(planChange(config, [{ kind: "role", role: "explorer", state: "missing" }])).toHaveProperty("error");
		expect(planChange(config, [{ kind: "workers", role: "implementer", want: 17, max: 3 }])).toHaveProperty("error");
	});
});
