import { describe, expect, test } from "bun:test";
import { planChange } from "../src/plan/change.ts";
import { validatePlan } from "../src/plan/validate.ts";
import { ROLES } from "../src/roles.ts";
import type { Candidate, MetricValue, RoleRecommendation, StormConfig } from "../src/types.ts";

const NOW = Date.parse("2026-11-21T00:00:00Z");
const config: StormConfig = {
	version: 1,
	priority: "balanced",
	roles: {
		implementer: { agent: "storm-implementer", models: ["a/i"], workers: { min: 1, max: 3 } },
		reviewer: { agent: "storm-reviewer", models: ["b/r"] },
		quick: { agent: "storm-quick", models: ["a/q"], workers: 2 },
	},
	parallelism: 4,
	isolation: "shared",
	contract: "workflowz",
	runtime: "omp",
	disabledRoles: ["architect"],
};

describe("validatePlan", () => {
	test("roles resolve from kind along the stand-ins; workers default to each role's min", () => {
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
		expect(r.plan!.workers).toEqual({ implementer: 1, quick: 2, reviewer: 1 });
		expect(r.plan!.submittedAt).toBe("2026-11-21T00:00:00.000Z");
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

	test("errors: lane count, names, kind, files, role id, workers values and roles without lanes", () => {
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
		expect(r.errors).toHaveLength(7);
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

const mv = (value: number): MetricValue => ({ value, source: "catalog", confidence: "medium" });
const cand = (selector: string): Candidate => ({
	selector,
	modelKey: selector,
	label: selector,
	effort: "medium",
	tier: "general",
	int: mv(50),
	speed: mv(100),
	referenceUsd: 0.02,
	userMixUsd: null,
	quota: "available",
	confidence: "medium",
	validated: false,
	why: [],
	whyNot: [],
});

describe("planChange", () => {
	const recs: RoleRecommendation[] = ROLES.map((role) => ({ role, candidates: [cand(`a/${role.id}`), cand(`b/${role.id}`)], chosenIndex: 0, excluded: [] }));
	const efforts = () => ["low", "medium", "high"] as const;

	test("raises max keeping min, and adds a disabled role with recommended models and default range", () => {
		const r = planChange(
			config,
			[
				{ kind: "role", role: "architect", state: "disabled" },
				{ kind: "workers", role: "implementer", want: 5, max: 3 },
				{ kind: "workers", role: "quick", want: 4, max: 2 },
			],
			{ recs, efforts },
		);
		if ("error" in r) throw new Error(r.error);
		expect(r.config.roles.implementer!.workers).toEqual({ min: 1, max: 5 });
		expect(r.config.roles.quick!.workers).toEqual({ min: 2, max: 4 });
		expect(r.config.roles.architect).toEqual({ agent: "storm-architect", models: ["a/architect:high", "b/architect:high"], workers: { min: 1, max: 1 } });
		expect(r.config.disabledRoles).toBeUndefined();
	});

	test("a role to add needs recommendations; a want past 16 fails validation", () => {
		expect(planChange(config, [{ kind: "role", role: "explorer", state: "missing" }])).toHaveProperty("error");
		expect(planChange(config, [{ kind: "workers", role: "implementer", want: 17, max: 3 }])).toHaveProperty("error");
	});
});
