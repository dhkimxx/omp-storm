/**
 * G2: the model and reasoning effort of a worker are the ones the user approved in the team. omp gives a caller's `effort`
 * precedence over the model and effort the spawn hook answers with, and a caller's per-call `model` over the agent's own
 * list for a native agent, so a director's `task` call may not carry either: placement removes them for every form of
 * the call and tells the director once, in that call's own result, why its value was not used.
 */
import { expect, test } from "bun:test";
import { PINNED_NOTE_TAG, RunLanes, TASK_PINNED_FIELDS } from "../src/runtime/lanes.ts";
import type { PlanLane, RunPlan } from "../src/types.ts";
import { teamOf } from "./fixtures.ts";

const team = teamOf({ implementer: "fake/dev", explorer: "fake/look" });
const lane = (name: string, role = "implementer"): PlanLane => ({ name, kind: role === "implementer" ? "code" : "explore", role, files: role === "implementer" ? [`${name}.ts`] : [], goal: name });
const plan = (...lanes: PlanLane[]): RunPlan => ({ lanes, workers: { implementer: 2, explorer: 2 }, submittedAt: "2026-01-01T00:00:00Z" });

const placed = (result: ReturnType<RunLanes["place"]>) => {
	if (!result.ok) throw new Error(`refused: ${result.reason}`);
	return result;
};
const pinNotes = (result: ReturnType<RunLanes["place"]>): string[] => (placed(result).notes ?? []).filter(note => note.includes(PINNED_NOTE_TAG));
const items = (result: ReturnType<RunLanes["place"]>): Array<Record<string, unknown>> => placed(result).input.tasks as Array<Record<string, unknown>>;

test("the pinned fields are exactly the two a caller can use to change a worker's reasoning", () => {
	expect([...TASK_PINNED_FIELDS].sort()).toEqual(["effort", "model"]);
});

for (const mode of ["place", "assign"] as const) {
	const run = (work: RunLanes, input: unknown, p: RunPlan | undefined) =>
		mode === "assign" && p !== undefined ? work.assign(input, p, team) : work.place(input, p, team);

	test(`${mode}: a batch item's effort and model are removed and the director is told once`, () => {
		const p = plan(lane("a"), lane("b"), lane("look", "explorer"));
		const result = run(new RunLanes(`batch-${mode}`), {
			context: "shared",
			tasks: [
				{ agent: "storm-implementer", name: "a", task: "A", effort: "hi", model: "fake/premium:xhigh" },
				{ agent: "storm-implementer", name: "b", task: "B", effort: "hi" },
				{ agent: "storm-explorer", name: "look", task: "L", model: "fake/premium" },
			],
		}, p);
		for (const item of items(result)) {
			expect(item).not.toHaveProperty("effort");
			expect(item).not.toHaveProperty("model");
		}
		expect(items(result).map(item => item.task)).toEqual(["A", "B", "L"]);
		// One note for the call, not one per item, naming both fields.
		const notes = pinNotes(result);
		expect(notes).toHaveLength(1);
		for (const field of TASK_PINNED_FIELDS) expect(notes[0]).toContain(field);
	});

	test(`${mode}: the flat form is covered the same way`, () => {
		const p = plan(lane("a"));
		const result = run(new RunLanes(`flat-${mode}`), { agent: "storm-implementer", name: "a", task: "A", effort: "lo", model: "fake/other" }, p);
		const input = placed(result).input;
		expect(input).not.toHaveProperty("effort");
		expect(input).not.toHaveProperty("model");
		expect(input.task).toBe("A");
		expect(pinNotes(result)).toHaveLength(1);
	});
}

test("a native agent outside the team is covered too, with and without a plan", () => {
	const withPlan = new RunLanes("native-planned").place({ agent: "task", name: "a", task: "A", effort: "hi", model: "fake/dev:xhigh" }, plan({ ...lane("a"), role: "implementer" }), team);
	// `task` has no team role, so the planned form may be refused for another reason; only a placed call is asserted here.
	if (withPlan.ok) {
		expect(withPlan.input).not.toHaveProperty("effort");
		expect(withPlan.input).not.toHaveProperty("model");
	}
	const planless = new RunLanes("native-planless").place({ agent: "task", name: "free", task: "A", effort: "hi", model: "fake/dev:xhigh" }, undefined, team);
	expect(planless.ok).toBe(true);
	if (planless.ok) {
		expect(planless.input).not.toHaveProperty("effort");
		expect(planless.input).not.toHaveProperty("model");
		expect(planless.notes?.some(note => note.includes(PINNED_NOTE_TAG))).toBe(true);
	}
	const batchPlanless = new RunLanes("native-batch").place({ tasks: [{ agent: "task", name: "free", task: "A", effort: "hi" }] }, undefined, team);
	expect(items(batchPlanless)[0]).not.toHaveProperty("effort");
});

test("top-level effort or model beside a batch is removed as well", () => {
	const p = plan(lane("a"));
	const result = new RunLanes("top-level").place({ effort: "hi", model: "fake/x", tasks: [{ agent: "storm-implementer", name: "a", task: "A" }] }, p, team);
	const input = placed(result).input;
	expect(input).not.toHaveProperty("effort");
	expect(input).not.toHaveProperty("model");
	expect(pinNotes(result)).toHaveLength(1);
});

test("a call that carries neither field is untouched and gets no note", () => {
	const p = plan(lane("a"));
	const result = new RunLanes("clean").place({ agent: "storm-implementer", name: "a", task: "A" }, p, team);
	expect(pinNotes(result)).toEqual([]);
	expect(placed(result).input).toMatchObject({ agent: "storm-implementer", task: "A" });
	expect(String(placed(result).input.name)).toMatch(/^clean-lane-\d+$/);
});

test("only the field the director passed is named", () => {
	const p = plan(lane("a"));
	const result = new RunLanes("one-field").place({ agent: "storm-implementer", name: "a", task: "A", effort: "hi" }, p, team);
	const [note] = pinNotes(result);
	expect(note).toContain("effort");
	expect(note).not.toContain("model");
});

test("a refused call reveals nothing and places nothing", () => {
	const p = plan(lane("a"));
	const work = new RunLanes("refused");
	const refused = work.place({ tasks: [{ agent: "storm-implementer", name: "a", task: "A", effort: "hi" }, { agent: "storm-implementer", name: "ghost", task: "G", effort: "hi" }] }, p, team);
	expect(refused.ok).toBe(false);
	// The same lane is still free for the next, valid call.
	expect(work.place({ agent: "storm-implementer", name: "a", task: "A" }, p, team).ok).toBe(true);
});
