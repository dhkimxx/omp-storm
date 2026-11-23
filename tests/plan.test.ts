import { describe, expect, test } from "bun:test";
import { planChange } from "../src/plan/change.ts";
import { MAX_LANE_TEXT, validatePlan } from "../src/plan/validate.ts";
import { ROLES } from "../src/roles.ts";
import type { Candidate, RoleRecommendation, StormConfig } from "../src/types.ts";
import { teamOf } from "./fixtures.ts";
import { cand as candidate } from "./support.ts";

const NOW = Date.parse("2026-11-21T00:00:00Z");
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
					{ name: "a", kind: "code" },
					{ name: "b", kind: "explore" },
					{ name: "c", kind: "design" },
					{ name: "d", kind: "run" },
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
		const lanes = (n: number, kind: string) => Array.from({ length: n }, (_, i) => ({ name: `${kind}${i}`, kind }));
		const workers = (input: unknown) => validatePlan(config, input, NOW).plan?.workers;
		expect(workers({ lanes: lanes(2, "code") })).toEqual({ implementer: 2 });
		expect(workers({ lanes: lanes(5, "code") })).toEqual({ implementer: 3 });
		expect(workers({ lanes: lanes(1, "run") })).toEqual({ quick: 2 });
		// An explicit count wins over the default.
		expect(workers({ lanes: lanes(3, "code"), workers: { implementer: 1 } })).toEqual({ implementer: 1 });
		expect(validatePlan(config, { lanes: lanes(5, "code") }, NOW).outOfBounds).toEqual([]);
	});

	test("workers for a role without lanes, or for no role at all, are ignored with a warning; that role gets no workers", () => {
		const r = validatePlan(config, { lanes: [{ name: "a", kind: "code" }], workers: { implementer: 2, reviewer: 1, boss: 3 } }, NOW);
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
					{ name: "a", kind: "code" },
					{ name: "b", kind: "design", role: "architect" },
					{ name: "c", kind: "explore", role: "explorer" },
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
					{ name: "a", kind: "code", goal: "  Deliver A  ", progress: "  (완료) A16  " },
					{ name: "b", kind: "code", goal: "   ", progress: "" },
					{ name: "c", kind: "code", goal: "x".repeat(MAX_LANE_TEXT), progress: "y".repeat(MAX_LANE_TEXT) },
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
			{ lanes: [{ name: "a", kind: "code", goal: "x".repeat(MAX_LANE_TEXT + 1), progress: "y".repeat(MAX_LANE_TEXT + 1) }] },
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
					{ name: "shared", kind: "code" },
					{ name: "probe", kind: "run", isolationReason: "  compare parser backends  " },
					{ name: "bench", kind: "code", isolationReason: "x".repeat(MAX_LANE_TEXT) },
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
		const check = (reason: unknown) => validatePlan(config, { lanes: [{ name: "probe", kind: "code", isolationReason: reason }] }, NOW);
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
			{ name: "check", kind: "code", role: "reviewer", isolationReason: reason },
		]) {
			const r = validatePlan(config, { lanes: [lane] }, NOW);
			expect(r.plan).toBeUndefined();
			expect(r.errors).toHaveLength(1);
			expect(r.errors[0]).toContain("통합 트리");
			expect(r.errors[0]).toContain("code/run");
		}
		const legacy = validatePlan(
			{ ...config, isolation: "isolated" },
			{ lanes: [{ name: "a", kind: "code" }, { name: "b", kind: "run", isolationReason: reason }] },
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
					{ name: "a", kind: "code", files: ["x.ts"], isolationReason: "independent experiment" },
					{ name: "b", kind: "run", files: ["x.ts"] },
				],
			},
			NOW,
		);
		expect(r.errors).toEqual([]);
		expect(r.warnings).toHaveLength(1);
		expect(r.warnings[0]).toContain("순서");
		expect(r.plan!.lanes[1]).not.toHaveProperty("isolationReason");
	});

	test("errors: lane count, names, kind, files, role id and worker values", () => {
		const bad = (input: unknown) => validatePlan(config, input, NOW);
		expect(bad({ lanes: [] }).errors).toHaveLength(1);
		expect(bad({ lanes: Array.from({ length: 51 }, (_, i) => ({ name: `l${i}`, kind: "code" })) }).errors).toHaveLength(1);
		const r = bad({
			lanes: [
				{ name: "a", kind: "code" },
				{ name: "a", kind: "code" },
				{ name: " ", kind: "code" },
				{ name: "k", kind: "deploy" },
				{ name: "f", kind: "code", files: "src" },
				{ name: "r", kind: "code", role: "boss" },
			],
			workers: { implementer: 0, reviewer: 1 },
		});
		expect(r.plan).toBeUndefined();
		expect(r.errors).toHaveLength(6);
		expect(bad({ lanes: [{ name: "a", kind: "code" }], workers: { implementer: 1.5 } }).errors).toHaveLength(1);
	});

	test("no configured role for a kind is an error", () => {
		const only: StormConfig = { ...config, roles: { reviewer: config.roles.reviewer! } };
		expect(validatePlan(only, { lanes: [{ name: "a", kind: "code" }] }, NOW).errors).toHaveLength(1);
	});

	test("two code/run lanes sharing a file warn; explore lanes do not", () => {
		const r = validatePlan(
			config,
			{
				lanes: [
					{ name: "a", kind: "code", files: ["x.ts"] },
					{ name: "b", kind: "run", files: ["x.ts"] },
					{ name: "c", kind: "explore", files: ["y.ts"] },
					{ name: "d", kind: "code", files: ["y.ts"] },
				],
			},
			NOW,
		);
		expect(r.warnings).toHaveLength(1);
		expect(r.warnings[0]).toContain("x.ts");
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
