import { describe, expect, test } from "bun:test";
import { pickEffort, recommend } from "../src/recommend/recommend.ts";
import type { QuotaStatus, RoleRecommendation, UsageRow } from "../src/types.ts";
import { COST, model, NOW, row, setup } from "./rank-fixture.ts";

const role = (recs: RoleRecommendation[], id: string): RoleRecommendation => {
	const r = recs.find(x => x.role.id === id);
	if (!r) throw new Error(`no recommendation for ${id}`);
	return r;
};
const ranked = (recs: RoleRecommendation[], id: string): string[] => role(recs, id).candidates.map(c => c.selector);
const pick = (recs: RoleRecommendation[], id: string): string | undefined => ranked(recs, id)[0];

describe("recommend constraints", () => {
	test("drops models that cannot run the role and records why; routes without credentials are not listed", () => {
		const catalog = [
			model("pa", "ok-flash-1", "cheap", { int: 30 }),
			model("pa", "notool-flash-1", "cheap", { int: 60, supportsTools: false }),
			model("pa", "small-flash-1", "cheap", { int: 60, contextWindow: 32_000 }),
			model("pz", "gone-flash-1", "cheap", { int: 60, available: false }),
		];
		const explorer = role(recommend(setup(catalog, { rows: [row("pz", "gone-flash-1", 50)] })), "explorer");
		expect(explorer.candidates.map(c => c.selector)).toEqual(["pa/ok-flash-1"]);
		expect(explorer.excluded.map(e => e.selector).sort()).toEqual(["pa/notool-flash-1", "pa/small-flash-1"]);
	});

	test("an unknown context window passes", () => {
		expect(pick(recommend(setup([model("pa", "a-flash-1", "cheap", { int: 30, contextWindow: null })])), "explorer")).toBe("pa/a-flash-1");
	});

	test("nothing usable gives an empty list, chosenIndex -1 and no fallback", () => {
		for (const r of recommend(setup([model("pa", "a-flash-1", "cheap", { supportsTools: false })]))) {
			expect(r.candidates).toEqual([]);
			expect(r.chosenIndex).toBe(-1);
			expect(r.fallback).toBeUndefined();
		}
	});

	test("one candidate per lineage, and its other routes are not reported as excluded", () => {
		const catalog = [model("pa", "a-pro-1", "general", { int: 40 }), model("pb", "a-pro-1", "general", { int: 40 })];
		const impl = role(recommend(setup(catalog)), "implementer");
		expect(impl.candidates.length).toBe(1);
		expect(impl.excluded).toEqual([]);
	});
});

describe("recommend route choice", () => {
	// pb lists the same model cheaper; a row on another lineage gives the user a token mix so route cost can decide.
	const catalog = [
		model("pa", "a-pro-1", "general", { int: 40 }),
		model("pb", "a-pro-1", "general", { int: 40, cost: { ...COST.general, output: 2 } }),
		model("pa", "other-pro-1", "general", { int: 10 }),
	];

	test("a never-used route wins on price only while no route of the lineage was used", () => {
		expect(pick(recommend(setup(catalog, { rows: [row("pa", "other-pro-1", 10)] })), "implementer")).toBe("pb/a-pro-1");
	});

	test("the route the user ran as a subagent beats an unused cheaper route of the same lineage", () => {
		const rows = [row("pa", "other-pro-1", 10), row("pa", "a-pro-1", 500)];
		expect(pick(recommend(setup(catalog, { rows })), "implementer")).toBe("pa/a-pro-1");
	});

	test("between two used routes the one with more requests wins", () => {
		const rows = [row("pa", "a-pro-1", 40), row("pb", "a-pro-1", 900)];
		expect(pick(recommend(setup(catalog, { rows })), "implementer")).toBe("pb/a-pro-1");
	});

	test("main-session use of a route counts when no route was used as a subagent", () => {
		const rows = [row("pa", "other-pro-1", 10), row("pa", "a-pro-1", 300, 0, 1, "main")];
		expect(pick(recommend(setup(catalog, { rows })), "implementer")).toBe("pa/a-pro-1");
	});
});

describe("recommend quality", () => {
	test("a lineage whose routes carry conflicting scores gets one score on every route", () => {
		const catalog = [model("pa", "a-pro-1", "general", { int: 34.3 }), model("pb", "a-pro-1", "general", { int: 51.8 })];
		for (const used of ["pa", "pb"]) {
			const c = role(recommend(setup(catalog, { rows: [row(used, "a-pro-1", 100)] })), "implementer").candidates[0];
			expect(c?.selector).toBe(`${used}/a-pro-1`);
			expect(c?.int.value).toBeCloseTo(43.05);
			expect(c?.int.approx).toBe(true);
			expect(c?.int.spread).toBeCloseTo(17.5);
		}
	});

	test("a route's own higher score does not lift its lineage over a better one", () => {
		// a: 34.3 / 51.8 → 43.05 (tolerance 8.75); b: 53 on its only route. 53 − 43.05 > 8.75.
		const catalog = [
			model("pa", "a-pro-1", "general", { int: 34.3 }),
			model("pb", "a-pro-1", "general", { int: 51.8 }),
			model("pa", "b-pro-1", "general", { int: 53 }),
		];
		expect(pick(recommend(setup(catalog)), "implementer")).toBe("pa/b-pro-1");
	});

	test("a best score whose routes disagree cannot outrank a validated model just below it", () => {
		const validated = [row("pa", "a-pro-1", 100)];
		const certain = [model("pa", "a-pro-1", "general", { int: 50 }), model("pa", "b-pro-1", "general", { int: 58 })];
		expect(pick(recommend(setup(certain, { rows: validated, priority: "quality" })), "implementer")).toBe("pa/b-pro-1");
		// b: 48 / 68 → 58 with spread 20, so a lead under 10 is not a lead.
		const noisyBest = [
			model("pa", "a-pro-1", "general", { int: 50 }),
			model("pa", "b-pro-1", "general", { int: 48 }),
			model("pb", "b-pro-1", "general", { int: 68 }),
		];
		expect(pick(recommend(setup(noisyBest, { rows: validated, priority: "quality" })), "implementer")).toBe("pa/a-pro-1");
		// Usage below the validation bar is no proof: the scores keep their order.
		expect(pick(recommend(setup(noisyBest, { rows: [row("pa", "a-pro-1", 50)], priority: "quality" })), "implementer")).toBe("pa/b-pro-1");
	});

	test("a noisy leader does not pull a clearly lower model into its class, where one request would decide", () => {
		// a: 72 / 48 → 60 with tolerance 12; b: 59 exact; c: 49 exact with a single subagent request.
		const a = [model("pa", "a-pro-1", "general", { int: 72 }), model("pb", "a-pro-1", "general", { int: 48 })];
		const rest = [model("pa", "b-pro-1", "general", { int: 59 }), model("pa", "c-pro-1", "general", { int: 49 })];
		const rows = [row("pa", "c-pro-1", 1)];
		for (const priority of ["balanced", "quality", "cost"] as const) {
			const lineages = (catalog: typeof rest) => role(recommend(setup(catalog, { rows, priority })), "implementer").candidates.map(c => c.modelKey);
			expect(lineages([...a, ...rest])).toEqual(["a/pro@1", "b/pro@1", "c/pro@1"]);
			expect(lineages(rest)).toEqual(["b/pro@1", "c/pro@1"]);
		}
	});

	test("the ranking and the fallback do not depend on catalog order", () => {
		// u and w (58, never used) tie exactly with v (50, validated, +8); x is validated half a point below v.
		const catalog = [
			model("pa", "u-pro-1", "general", { int: 58 }),
			model("pb", "v-pro-1", "general", { int: 50 }),
			model("pc", "x-pro-1", "general", { int: 49.5 }),
			model("pa", "w-pro-1", "general", { int: 58 }),
			model("pb", "u-pro-1", "general", { int: 58 }),
			model("pc", "y-flash-1", "cheap", { int: 30 }),
			model("pa", "z-flash-1", "cheap", { int: 30 }),
		];
		const rows = [row("pb", "v-pro-1", 100), row("pc", "x-pro-1", 100)];
		const outcome = (order: typeof catalog) =>
			recommend(setup(order, { rows })).map(r => [r.role.id, r.candidates.map(c => c.selector), r.fallback?.selector]);
		const expected = outcome(catalog);
		for (let shift = 0; shift < catalog.length; shift++) {
			const rotated = [...catalog.slice(shift), ...catalog.slice(0, shift)];
			expect(outcome(rotated)).toEqual(expected);
			expect(outcome(rotated.reverse())).toEqual(expected);
		}
	});

	test("a lower score gains nothing from being uncertain", () => {
		// a: 40 / 60 → 50 with spread 20, used; b: 58 on its only route.
		const catalog = [
			model("pa", "a-pro-1", "general", { int: 40 }),
			model("pb", "a-pro-1", "general", { int: 60 }),
			model("pa", "b-pro-1", "general", { int: 58 }),
		];
		expect(pick(recommend(setup(catalog, { rows: [row("pa", "a-pro-1", 50)] })), "implementer")).toBe("pa/b-pro-1");
	});

	test("models a noisy best score could not separate keep their score order when nobody used them", () => {
		// best: 48 / 68 → 58; the cheaper 50 does not jump over 55.
		const catalog = [
			model("pa", "best-pro-1", "general", { int: 48 }),
			model("pb", "best-pro-1", "general", { int: 68 }),
			model("pa", "mid-pro-1", "general", { int: 55 }),
			model("pa", "low-pro-1", "general", { int: 50, cost: { ...COST.general, output: 2 } }),
		];
		expect(ranked(recommend(setup(catalog)), "implementer").map(s => s.split("/")[1])).toEqual(["best-pro-1", "mid-pro-1", "low-pro-1"]);
	});

	test("near-equal scores tie and the user's recent preference decides; a clear gap beats it", () => {
		const rows = [row("pa", "old-pro-1", 400, 0, 20), row("pb", "new-pro-1", 400, 0, 1)];
		const near = [model("pa", "old-pro-1", "general", { int: 54.6 }), model("pb", "new-pro-1", "general", { int: 54.5 })];
		expect(ranked(recommend(setup(near, { rows })), "implementer")).toEqual(["pb/new-pro-1", "pa/old-pro-1"]);
		const clear = [model("pa", "old-pro-1", "general", { int: 57 }), model("pb", "new-pro-1", "general", { int: 54.5 })];
		expect(pick(recommend(setup(clear, { rows })), "implementer")).toBe("pa/old-pro-1");
	});

	test("below the best model too, scores within a point of each other are one class and usage decides", () => {
		const catalog = [
			model("pa", "top-pro-1", "general", { int: 60 }),
			model("pa", "unused-pro-1", "general", { int: 55.4 }),
			model("pa", "used-pro-1", "general", { int: 54.6 }),
			model("pa", "worse-pro-1", "general", { int: 53 }),
		];
		expect(ranked(recommend(setup(catalog, { rows: [row("pa", "used-pro-1", 50)] })), "implementer")).toEqual([
			"pa/top-pro-1",
			"pa/used-pro-1",
			"pa/unused-pro-1",
			"pa/worse-pro-1",
		]);
	});
});

describe("recommend validation by use", () => {
	// Two generals, so the tier shift of quality/cost leaves both at the same distance.
	const order = (scores: { used: number; unused: number }, priority: "balanced" | "quality" | "cost", requests = 100) => {
		const catalog = [model("pa", "unused-pro-1", "general", { int: scores.unused }), model("pa", "used-pro-1", "general", { int: scores.used })];
		return ranked(recommend(setup(catalog, { rows: [row("pa", "used-pro-1", requests)], priority })), "implementer").map(s => s.split("/")[1]?.split("-")[0]);
	};

	test("a validated model outranks an unvalidated one that leads by a few points, except under the quality priority", () => {
		expect(order({ used: 55, unused: 60 }, "balanced")).toEqual(["used", "unused"]);
		expect(order({ used: 55, unused: 60 }, "cost")).toEqual(["used", "unused"]);
		expect(order({ used: 55, unused: 60 }, "quality")).toEqual(["unused", "used"]);
	});

	test("a large lead beats validation under every priority", () => {
		for (const priority of ["balanced", "quality", "cost"] as const) {
			expect(order({ used: 40, unused: 60 }, priority)).toEqual(["unused", "used"]);
		}
	});

	test("the lead must exceed 8 points", () => {
		expect(order({ used: 55, unused: 63 }, "balanced")).toEqual(["used", "unused"]);
		expect(order({ used: 55, unused: 63.5 }, "balanced")).toEqual(["unused", "used"]);
	});

	test("a noisy leader needs more than its own tolerance, not that tolerance on top of the 8 points", () => {
		// unused: 48 / 72 → 60 with spread 24, so its tolerance is 12.
		const pick = (used: number) => {
			const catalog = [
				model("pa", "unused-pro-1", "general", { int: 48 }),
				model("pb", "unused-pro-1", "general", { int: 72 }),
				model("pa", "used-pro-1", "general", { int: used }),
			];
			return role(recommend(setup(catalog, { rows: [row("pa", "used-pro-1", 100)] })), "implementer").candidates[0]?.modelKey;
		};
		expect(pick(45)).toBe("unused/pro@1");
		expect(pick(49)).toBe("used/pro@1");
	});

	test("among equal quality the validated lineage wins under every priority", () => {
		for (const priority of ["balanced", "quality", "cost"] as const) {
			expect(order({ used: 40, unused: 40 }, priority)).toEqual(["used", "unused"]);
		}
	});

	test("one Storm run's 30 requests do not validate: the higher score wins", () => {
		expect(order({ used: 55, unused: 60 }, "balanced", 30)).toEqual(["unused", "used"]);
		expect(order({ used: 55, unused: 60 }, "balanced", 99)).toEqual(["unused", "used"]);
	});

	test("validation needs 100 requests and at most 2% errors", () => {
		const catalog = [model("pa", "a-pro-1", "general", { int: 40 })];
		const validated = (rows: UsageRow[]) => role(recommend(setup(catalog, { rows })), "implementer").candidates[0]?.validated;
		expect(validated([row("pa", "a-pro-1", 30)])).toBe(false);
		expect(validated([row("pa", "a-pro-1", 99)])).toBe(false);
		expect(validated([row("pa", "a-pro-1", 100, 10)])).toBe(false);
		expect(validated([row("pa", "a-pro-1", 100, 2)])).toBe(true);
		// Requests through several providers add up.
		const routes = [model("pa", "a-pro-1", "general", { int: 40 }), model("pb", "a-pro-1", "general", { int: 40 })];
		expect(role(recommend(setup(routes, { rows: [row("pa", "a-pro-1", 60), row("pb", "a-pro-1", 40)] })), "implementer").candidates[0]?.validated).toBe(true);
	});
});

describe("recommend priority", () => {
	const catalog = [
		model("pa", "c-flash-1", "cheap", { int: 30 }),
		model("pa", "g-pro-1", "general", { int: 40 }),
		model("pa", "p-max-1", "premium", { int: 50 }),
	];
	test("balanced uses each role's tier; quality and cost shift one step", () => {
		const balanced = recommend(setup(catalog));
		expect(pick(balanced, "explorer")).toBe("pa/c-flash-1");
		expect(pick(balanced, "implementer")).toBe("pa/g-pro-1");
		const quality = recommend(setup(catalog, { priority: "quality" }));
		expect(pick(quality, "explorer")).toBe("pa/g-pro-1");
		expect(pick(quality, "implementer")).toBe("pa/p-max-1");
		const cost = recommend(setup(catalog, { priority: "cost" }));
		expect(pick(cost, "explorer")).toBe("pa/c-flash-1");
		expect(pick(cost, "implementer")).toBe("pa/c-flash-1");
	});

	test("cost puts the cheaper of two equal-quality validated models first even when the other is used more", () => {
		const two = [model("pa", "dear-flash-1", "cheap", { int: 30 }), model("pa", "low-flash-1", "cheap", { int: 30, cost: { ...COST.cheap, output: 0.2 } })];
		const rows = [row("pa", "dear-flash-1", 400), row("pa", "low-flash-1", 100)];
		expect(pick(recommend(setup(two, { rows })), "explorer")).toBe("pa/dear-flash-1");
		expect(pick(recommend(setup(two, { rows, priority: "cost" })), "explorer")).toBe("pa/low-flash-1");
		// Price does not buy its way past validation.
		expect(pick(recommend(setup(two, { rows: [row("pa", "dear-flash-1", 400)], priority: "cost" })), "explorer")).toBe("pa/dear-flash-1");
	});

	test("falls back to the nearest tier and puts unpriced models last", () => {
		// Implementer targets general; only premium and an unpriced (tier null) model exist.
		const input = setup([model("pa", "free-x-1", "cheap", { int: 90 }), model("pa", "p-max-1", "premium", { int: 50 })]);
		input.tiers.set("free/x@1", { tier: null, referenceUsd: null });
		expect(ranked(recommend(input), "implementer")).toEqual(["pa/p-max-1", "pa/free-x-1"]);
	});
});

describe("recommend diversity and effort", () => {
	test("reviewer prefers a different model class than the implementer", () => {
		const catalog = [model("pa", "alpha-pro-1", "general", { int: 50 }), model("pa", "alpha-pro-2", "general", { int: 48 }), model("pb", "beta-pro-1", "general", { int: 40 })];
		const recs = recommend(setup(catalog));
		expect(pick(recs, "implementer")).toBe("pa/alpha-pro-1");
		expect(pick(recs, "reviewer")).toBe("pb/beta-pro-1");
	});

	test("with the team given, the reviewer avoids the class of the team's implementer, not of the recommended one", () => {
		// The recommender would pick aaa as implementer; the team has bbb there and aaa as reviewer.
		const catalog = [model("pa", "aaa-pro-1", "general", { int: 60 }), model("pb", "bbb-pro-1", "general", { int: 50 })];
		const team = recommend(setup(catalog, { current: { implementer: "pb/bbb-pro-1", reviewer: "pa/aaa-pro-1" } }));
		expect(pick(team, "reviewer")).toBe("pa/aaa-pro-1");
		expect(role(team, "reviewer").current?.above).toEqual([]);
		// Only the reviewer named: it is still compared with the recommended implementer.
		const alone = recommend(setup(catalog, { current: { reviewer: "pa/aaa-pro-1" } }));
		expect(role(alone, "reviewer").current?.above.map(a => a.candidate.selector)).toEqual(["pb/bbb-pro-1"]);
	});

	test("uses the role effort, else the nearest supported one", () => {
		const catalog = [model("pa", "g-pro-1", "general", { int: 40, efforts: ["minimal", "medium", "xhigh"] }), model("pa", "c-flash-1", "cheap", { int: 20, efforts: [] })];
		const recs = recommend(setup(catalog));
		// implementer wants high: medium and xhigh are equally near, and ties go up.
		expect(role(recs, "implementer").candidates[0]?.effort).toBe("xhigh");
		expect(role(recs, "explorer").candidates[0]?.effort).toBeNull();
		expect(pickEffort("low", ["minimal", "medium"])).toBe("medium");
		expect(pickEffort("high", ["low"])).toBe("low");
	});
});

describe("recommend fallback", () => {
	const onOneProvider = ["a", "b", "c", "d", "e"].map(cls => model("pa", `${cls}-pro-1`, "general", { int: 50 }));

	test("five candidates on one provider still yield the fallback from another provider further down", () => {
		const impl = role(recommend(setup([...onOneProvider, model("pb", "z-pro-1", "general", { int: 30, efforts: ["low"] })])), "implementer");
		expect(impl.candidates.length).toBe(5);
		expect(impl.candidates.every(c => c.selector.startsWith("pa/"))).toBe(true);
		expect(impl.fallback?.selector).toBe("pb/z-pro-1");
		// The fallback carries the effort picked for the role.
		expect(impl.fallback?.effort).toBe("low");
	});

	test("the fallback is the best-ranked candidate off the chosen provider; none when there is no other provider", () => {
		const catalog = [model("pa", "a-pro-1", "general", { int: 50 }), model("pb", "b-pro-1", "general", { int: 45 }), model("pc", "c-pro-1", "general", { int: 40 })];
		expect(role(recommend(setup(catalog)), "implementer").fallback?.selector).toBe("pb/b-pro-1");
		expect(role(recommend(setup(onOneProvider)), "implementer").fallback).toBeUndefined();
	});

	test("the fallback may be a route that is not its lineage's best one", () => {
		// l2's used route is on p1, like the chosen l1; only its other route is on another provider.
		const catalog = [
			model("p1", "l1-pro-1", "general", { int: 60 }),
			model("p1", "l2-pro-1", "general", { int: 50 }),
			model("p2", "l2-pro-1", "general", { int: 50 }),
		];
		const impl = role(recommend(setup(catalog, { rows: [row("p1", "l2-pro-1", 50)] })), "implementer");
		expect(impl.candidates.map(c => c.selector)).toEqual(["p1/l1-pro-1", "p1/l2-pro-1"]);
		expect(impl.fallback?.selector).toBe("p2/l2-pro-1");
	});

	test("the fallback is never the chosen model on another provider", () => {
		const catalog = [model("p1", "l1-pro-1", "general", { int: 60 }), model("p2", "l1-pro-1", "general", { int: 60 })];
		expect(role(recommend(setup(catalog)), "implementer").fallback).toBeUndefined();
	});

	describe("prefers a proven route", () => {
		// The chosen model is far ahead, so usage of the others never changes the primary.
		const catalog = [
			model("p1", "top-pro-1", "general", { int: 80 }),
			model("p2", "a-pro-1", "general", { int: 60 }),
			model("p3", "b-pro-1", "general", { int: 55 }),
			model("p4", "c-pro-1", "general", { int: 50 }),
			model("p1", "c-pro-1", "general", { int: 50 }),
		];
		const fallback = (rows: UsageRow[], exhaustedProviders: string[] = []) => {
			const quota: QuotaStatus[] = exhaustedProviders.map(provider => ({ provider, state: "exhausted", usedFraction: 1, resetsAt: null }));
			const impl = role(recommend(setup(catalog, { rows, quota })), "implementer");
			expect(impl.candidates[0]?.selector).toBe("p1/top-pro-1");
			return impl.fallback?.selector;
		};
		const someUse = row("p3", "b-pro-1", 5);
		const validatedUse = row("p4", "c-pro-1", 100);

		test("first a route the user ran on a validated lineage", () => {
			expect(fallback([someUse, validatedUse])).toBe("p4/c-pro-1");
		});

		test("a validated lineage does not vouch for a route of it that was never run", () => {
			// c is validated through its p1 route; its p4 route has no requests.
			expect(fallback([someUse, row("p1", "c-pro-1", 100)])).toBe("p3/b-pro-1");
		});

		test("then a route with any requests of its own, main session included", () => {
			expect(fallback([someUse])).toBe("p3/b-pro-1");
			expect(fallback([row("p3", "b-pro-1", 5, 0, 1, "main")])).toBe("p3/b-pro-1");
		});

		test("then the best-ranked route", () => {
			expect(fallback([])).toBe("p2/a-pro-1");
		});

		test("a route that cannot run now is passed over at every step; when none can run the best-ranked one stands in", () => {
			expect(fallback([someUse, validatedUse], ["p4"])).toBe("p3/b-pro-1");
			expect(fallback([someUse, validatedUse], ["p4", "p3"])).toBe("p2/a-pro-1");
			expect(fallback([someUse, validatedUse], ["p4", "p3", "p2"])).toBe("p2/a-pro-1");
		});
	});
});

describe("recommend quota", () => {
	const reset = NOW + 3_600_000;
	const exhausted: QuotaStatus[] = [{ provider: "pq", state: "exhausted", usedFraction: 1, resetsAt: reset }];

	test("an exhausted provider stays a candidate, after an equal one that can run, with its reset time", () => {
		const catalog = [model("pq", "a-pro-1", "general", { int: 40 }), model("pz", "b-pro-1", "general", { int: 40 })];
		const impl = role(recommend(setup(catalog, { quota: exhausted })), "implementer");
		expect(impl.candidates.map(c => [c.selector, c.quota, c.quotaResetsAt])).toEqual([
			["pz/b-pro-1", "unknown", undefined],
			["pq/a-pro-1", "exhausted", reset],
		]);
		expect(impl.excluded).toEqual([]);
	});

	test("a transient quota state does not outrank quality or the user's own usage", () => {
		const better = [model("pq", "a-pro-1", "general", { int: 50 }), model("pz", "b-pro-1", "general", { int: 40 })];
		expect(pick(recommend(setup(better, { quota: exhausted })), "implementer")).toBe("pq/a-pro-1");
		const equal = [model("pq", "a-pro-1", "general", { int: 40 }), model("pz", "b-pro-1", "general", { int: 40 })];
		expect(pick(recommend(setup(equal, { quota: exhausted, rows: [row("pq", "a-pro-1", 200)] })), "implementer")).toBe("pq/a-pro-1");
	});

	test("the used route of a model steps behind a route of it that can run now", () => {
		const catalog = [model("pq", "a-pro-1", "general", { int: 40 }), model("pz", "a-pro-1", "general", { int: 40 })];
		const rows = [row("pq", "a-pro-1", 500)];
		expect(pick(recommend(setup(catalog, { rows })), "implementer")).toBe("pq/a-pro-1");
		expect(pick(recommend(setup(catalog, { rows, quota: exhausted })), "implementer")).toBe("pz/a-pro-1");
	});

	test("primary and fallback are not both exhausted while another candidate can run", () => {
		const catalog = [
			model("pq", "a-pro-1", "general", { int: 60 }),
			model("pr", "b-pro-1", "general", { int: 50 }),
			model("pz", "c-pro-1", "general", { int: 40 }),
		];
		const both: QuotaStatus[] = [...exhausted, { provider: "pr", state: "exhausted", usedFraction: 1, resetsAt: null }];
		const stalled = role(recommend(setup(catalog, { quota: both })), "implementer");
		expect([stalled.candidates[0]?.selector, stalled.fallback?.selector]).toEqual(["pq/a-pro-1", "pz/c-pro-1"]);
		// A fallback has to be able to run whether or not the primary can.
		const running = role(recommend(setup(catalog, { quota: [{ provider: "pr", state: "exhausted", usedFraction: 1, resetsAt: null }] })), "implementer");
		expect([running.candidates[0]?.selector, running.fallback?.selector]).toEqual(["pq/a-pro-1", "pz/c-pro-1"]);
	});

	test("a limit scoped to one model or one model tier leaves the provider's other models untouched", () => {
		const quota: QuotaStatus[] = [
			{ provider: "pq", state: "available", usedFraction: 0.2, resetsAt: null, exhaustedTiers: { opus: reset }, exhaustedModels: { "c-haiku-1": null } },
		];
		// Fixture ids are "<class>-<tier>-<revision>".
		const catalog = ["a-opus-1", "b-sonnet-1", "c-haiku-1", "opus-pro-1"].map(id => model("pq", id, "general", { int: 40 }));
		const state = Object.fromEntries(role(recommend(setup(catalog, { quota })), "implementer").candidates.map(c => [c.selector, [c.quota, c.quotaResetsAt]]));
		expect(state).toEqual({
			"pq/a-opus-1": ["exhausted", reset],
			"pq/b-sonnet-1": ["available", undefined],
			"pq/c-haiku-1": ["exhausted", undefined],
			// "opus" is a word of this id but not its tier.
			"pq/opus-pro-1": ["available", undefined],
		});
	});
});

describe("recommend current model", () => {
	const catalog = [
		model("pa", "a-pro-1", "general", { int: 50 }),
		model("pb", "b-pro-1", "general", { int: 45 }),
		model("pa", "c-pro-1", "general", { int: 40 }),
		model("pa", "notool-pro-1", "general", { supportsTools: false }),
		model("pz", "gone-pro-1", "general", { available: false }),
	];
	const current = (selector: string) => role(recommend(setup(catalog, { current: { implementer: selector } })), "implementer").current;

	test("lists the candidates ranked above the current model, best first, each with a reason", () => {
		const third = current("pa/c-pro-1");
		expect(third?.excluded).toBeUndefined();
		expect(third?.above.map(a => a.candidate.selector)).toEqual(["pa/a-pro-1", "pb/b-pro-1"]);
		expect(third?.above.every(a => a.reason.length > 0)).toBe(true);
		expect(current("pa/a-pro-1")?.above).toEqual([]);
	});

	test("a better route of the current model's own lineage is listed above it", () => {
		const routes = [model("pa", "a-pro-1", "general", { int: 50 }), model("pb", "a-pro-1", "general", { int: 50 })];
		const rec = role(recommend(setup(routes, { rows: [row("pa", "a-pro-1", 100)], current: { implementer: "pb/a-pro-1" } })), "implementer");
		expect(rec.current?.above.map(a => a.candidate.selector)).toEqual(["pa/a-pro-1"]);
	});

	test("a model that is filtered out, not usable now or not in the catalog is reported as excluded", () => {
		for (const selector of ["pa/notool-pro-1", "pz/gone-pro-1", "pa/unheard-of-9"]) {
			const rank = current(selector);
			expect(rank?.excluded).toBeTruthy();
			expect(rank?.above).toEqual([]);
		}
	});

	test("roles the caller did not name get no current rank", () => {
		expect(role(recommend(setup(catalog, { current: { implementer: "pa/c-pro-1" } })), "reviewer").current).toBeUndefined();
	});

	test("newer versions of the current model line: usable routes, or the providers that need a login", () => {
		const versions = [
			model("pa", "a-pro-1", "general", { int: 40 }),
			model("pa", "a-pro-2", "general", { int: 45 }),
			model("pz", "a-pro-3", "general", { int: 50, available: false }),
			model("pa", "a-max-9", "general", { int: 60 }),
		];
		const rec = role(recommend(setup(versions, { current: { implementer: "pa/a-pro-1" } })), "implementer");
		expect(rec.current?.newer).toEqual([
			{ label: "a-pro-3", int: { value: 50, source: "lineage" }, selectors: [], loginProviders: ["pz"], needsCheck: false },
			{ label: "a-pro-2", int: { value: 45, source: "lineage" }, selectors: ["pa/a-pro-2"], loginProviders: [], needsCheck: false },
		]);
		expect(role(recommend(setup(versions, { current: { implementer: "pa/a-pro-2" } })), "implementer").current?.newer.map(n => n.label)).toEqual(["a-pro-3"]);
	});
});
