/**
 * B4 preview: `scripts/lane-preview.ts` can show every species, every handoff of the plan's species-change table and
 * the tour. Each scenario is cut the way the player cuts it and read through the real sequencer.
 */
import { describe, expect, test } from "bun:test";
import { laneViewFrame } from "../src/view/lane/frame.ts";
import type { Species } from "../src/view/stage/cast.ts";
import { changeStyle } from "../src/view/stage/scene.ts";
import { stageAt, stagePlan } from "../src/view/stage/sequencer.ts";
import { type ScenarioName, scenarioMs, snapshotAt } from "../scripts/lane-preview-scenario.ts";

/** The species a scenario shows over one loop, sampled at the player's tick. */
function speciesOver(name: ScenarioName): Set<Species> {
	const seen = new Set<Species>();
	for (let t = 0; t < scenarioMs(name); t += 85) seen.add(stageAt(snapshotAt(t, name)).species);
	return seen;
}

describe("the preview scenarios", () => {
	test("each species scenario shows its species after the starlings gather", () => {
		for (const species of ["octopus", "bee", "ant", "orca", "owl"] as const) {
			expect(stageAt(snapshotAt(14_000, species)).species, species).toBe(species);
		}
	});

	test("the handoffs scenario plays every handoff of the species-change table in full", () => {
		const last = snapshotAt(scenarioMs("handoffs") - 1, "handoffs");
		const transitions = stagePlan(last).transitions.filter(item => item.from !== "starling");
		const pairs = transitions.map(item => `${item.from}>${item.to}:${item.kind}:${changeStyle(item.from, item.to)}`);
		expect(pairs).toEqual([
			"bee>octopus:handoff:rise",
			"octopus>ant:handoff:sink",
			"ant>orca:handoff:rise",
			"orca>octopus:handoff:sweep",
			"octopus>owl:handoff:dim",
			"owl>bee:handoff:radial",
		]);
	});

	test("the tour shows every species, and the player draws every scenario in both text tiers", () => {
		expect([...speciesOver("tour")].sort()).toEqual(["ant", "bee", "octopus", "orca", "owl", "starling"]);
		for (const name of ["octopus", "bee", "ant", "orca", "owl", "tour", "handoffs"] as const) {
			for (const tier of ["t2", "t3"] as const) {
				const rows = laneViewFrame(snapshotAt(12_000, name), 140, 12_000, { motion: true, maxRows: 10, colour: "truecolor", dark: true }, tier);
				expect(rows.length, `${name} ${tier}`).toBeGreaterThanOrEqual(5);
			}
		}
	});
});
