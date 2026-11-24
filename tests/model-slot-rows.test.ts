import { describe, expect, test } from "bun:test";
import { modelSlotRows } from "../src/setup/model-draft.ts";

describe("model slot rows", () => {
	test("each configured entry keeps its role and original index, labels as before, and names its current model and effort", () => {
		const rows = modelSlotRows({
			roles: {
				explorer: { agent: "storm-explorer", models: ["a/x:high", "b/z"], effort: "low" },
				implementer: { agent: "storm-implementer", models: ["a/i"] },
				reviewer: { agent: "storm-reviewer", models: ["b/r"], effort: "high" },
			},
		});
		expect(rows).toEqual([
			{ roleId: "explorer", index: 0, label: "탐색 · 주 모델", value: "explorer:0", description: "a/x · high" },
			{ roleId: "explorer", index: 1, label: "탐색 · 폴백", value: "explorer:1", description: "b/z · low" },
			{ roleId: "implementer", index: 0, label: "구현 · 주 모델", value: "implementer:0", description: "a/i · 기본 effort" },
			{ roleId: "reviewer", index: 0, label: "리뷰 · 주 모델", value: "reviewer:0", description: "b/r · high" },
		]);
	});

	test("multiple fallbacks are numbered, and the values still point at the original entries", () => {
		const rows = modelSlotRows({
			roles: {
				explorer: { agent: "storm-explorer", models: ["a/one", "b/two", "c/three"] },
			},
		});
		expect(rows.map((row) => row.label)).toEqual(["탐색 · 주 모델", "탐색 · 폴백 1", "탐색 · 폴백 2"]);
		expect(rows.map((row) => row.value)).toEqual(["explorer:0", "explorer:1", "explorer:2"]);
		expect(rows.map((row) => row.description)).toEqual([
			"a/one · 기본 effort",
			"b/two · 기본 effort",
			"c/three · 기본 effort",
		]);
	});
});
