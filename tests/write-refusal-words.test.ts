/**
 * The words of a refused shared write, on the director's real plans (the run of 2026-11-26 14:18-14:22): a lane that
 * declared files is told so, the cause is the writer's tools or automatic delegation, and the next step is one that
 * works for this refusal. These tests check which lanes the text names, the causes it carries and the grammar around an
 * inserted name; not whole sentences.
 */
import { describe, expect, test } from "bun:test";
import { lanePolicy, type LanePolicy, shellReader, WHY_AUTO_WRITER, WHY_EXEC_WRITER, WHY_SHELL_REVIEWER } from "../src/policy/capability.ts";
import { batchWriteNeed, RunLanes, WRITE_ORDER_CHECK } from "../src/runtime/lanes.ts";
import type { PlanLane, RunPlan } from "../src/types.ts";
import { teamOf } from "./fixtures.ts";

const team = teamOf({ implementer: "fake/dev", explorer: "fake/look" });
const DIR = (name: string) => `.local-ops/benchmarks/${name}`;

/** The shape of the director's second plan (14:18:50): one directory per implementer, plus one explorer. */
const BODY = "BuildGemmaBodyQat";
const HEAD = "BuildGemmaQatHead";
const RAM = "TestGemmaRamHandoff";
const SCOUT = "TraceClawQatProducer";
const implementer = (name: string, files?: string[], extra: Partial<PlanLane> = {}): PlanLane => ({
	name,
	kind: "code",
	role: "implementer",
	...(files === undefined ? {} : { files }),
	goal: `deliver ${name}`,
	...extra,
});
const directorPlan = (): RunPlan => ({
	lanes: [
		implementer(BODY, [DIR("gemma4-body-qat")]),
		implementer(HEAD, [DIR("gemma4-head-qat")]),
		implementer(RAM, [DIR("gemma4-ram-handoff")]),
		{ name: SCOUT, kind: "explore", role: "explorer", goal: "trace the producer" },
	],
	workers: { implementer: 3, explorer: 1 },
	submittedAt: "2026-01-01T00:00:00Z",
});

const BASH_TOOLS = ["read", "write", "edit", "bash", "eval"];
const PATH_TOOLS = ["read", "write", "edit"];
const READ_TOOLS = ["read", "grep", "find"];

/** The policies the extension builds for a plan: one `lanePolicy` per lane, with the worker's tools and the mode. */
function policiesOf(plan: RunPlan, tools: readonly string[], auto: boolean): Map<string, LanePolicy> {
	return new Map(
		plan.lanes.map(lane => [
			lane.name,
			lanePolicy({ lane, tools: lane.role === "explorer" ? READ_TOOLS : tools, isolated: lane.isolationReason !== undefined, auto }),
		]),
	);
}

const call = (...names: string[]) => ({
	tasks: names.map(name => ({ agent: name === SCOUT ? "storm-explorer" : "storm-implementer", name, task: `do ${name}` })),
});

function refusal(placed: ReturnType<RunLanes["place"]>) {
	expect(placed.ok).toBe(false);
	if (placed.ok) throw new Error("expected a refusal");
	return placed;
}

describe("a batch of writers that cannot run together", () => {
	test("automatic delegation with bash-capable workers: the declared lane is told its files do not narrow it, and why (the tool)", () => {
		const plan = directorPlan();
		const work = new RunLanes("run-a");
		const placed = refusal(work.assign(call(BODY, HEAD, RAM, SCOUT), plan, team, { policies: policiesOf(plan, BASH_TOOLS, true) }));
		expect(placed.code).toBe("lane-write");
		expect(placed.reason).toContain(`'${BODY}' 레인`);
		expect(placed.reason).toContain(`'${HEAD}' 레인`);
		// The cause is the worker's shell, not the mode: automatic delegation is no longer a reason of its own.
		expect(placed.reason).toContain(WHY_EXEC_WRITER);
		expect(placed.reason).not.toContain(WHY_AUTO_WRITER);
		// The lane declared files: the old text called its scope undeclared.
		expect(placed.reason).not.toContain("선언되지 않은");
		expect(placed.reason).not.toContain("겹칩니다");
		// The next step names what works: one writer per call, and a reader may ride along. Not isolation.
		expect(placed.reason).toContain("읽기 전용");
		expect(placed.reason).not.toContain("isolationReason");
		expect(placed.reason).not.toContain("격리");
		// The explorer is not the cause: it is neither named as the other party nor held back.
		expect(placed.reason).not.toContain(SCOUT);
	});

	test("manual direction with a bash-capable worker says the tool, not the mode", () => {
		const plan = directorPlan();
		const work = new RunLanes("run-b");
		const placed = refusal(work.place(call(BODY, HEAD), plan, team, { policies: policiesOf(plan, BASH_TOOLS, false) }));
		expect(placed.reason).toContain(WHY_EXEC_WRITER);
		expect(placed.reason).not.toContain(WHY_AUTO_WRITER);
	});

	test("a writer and a reader in one call start; two writers do not", () => {
		const plan = directorPlan();
		const policies = policiesOf(plan, BASH_TOOLS, true);
		expect(new RunLanes("run-c").assign(call(BODY, SCOUT), plan, team, { policies }).ok).toBe(true);
		expect(new RunLanes("run-d").assign(call(BODY, HEAD), plan, team, { policies }).ok).toBe(false);
	});

	test("path-only workers on separate directories start together under automatic delegation too", () => {
		const plan = directorPlan();
		const placed = new RunLanes("run-e-auto").assign(call(BODY, HEAD, RAM, SCOUT), plan, team, { policies: policiesOf(plan, PATH_TOOLS, true) });
		expect(placed.ok).toBe(true);
	});

	test("path-only workers on separate directories still start together in manual direction", () => {
		const plan = directorPlan();
		const placed = new RunLanes("run-e").place(call(BODY, HEAD, RAM, SCOUT), plan, team, { policies: policiesOf(plan, PATH_TOOLS, false) });
		expect(placed.ok).toBe(true);
	});

	test("path-only workers whose files overlap name the paths, not an exclusive scope", () => {
		const plan: RunPlan = { ...directorPlan(), lanes: [implementer("A", ["src/x"]), implementer("B", ["src/x/y.ts"])] };
		const placed = refusal(new RunLanes("run-f").place(call("A", "B"), plan, team, { policies: policiesOf(plan, PATH_TOOLS, false) }));
		expect(placed.reason).toContain("src/x");
		expect(placed.reason).toContain("src/x/y.ts");
		expect(placed.reason).not.toContain(WHY_EXEC_WRITER);
	});
});

describe("a single writer refused beside the one already running", () => {
	test("14:20:50: Head waits for Body, which is the lane the text names, and the call may be retried", () => {
		const plan = directorPlan();
		const work = new RunLanes("run-g");
		const policies = policiesOf(plan, BASH_TOOLS, true);
		expect(work.assign(call(BODY), plan, team, { policies }).ok).toBe(true);
		const placed = refusal(work.assign(call(HEAD), plan, team, { policies }));
		expect(placed.code).toBe("lane-write");
		expect(placed.retry).toBe(true);
		expect(placed.reason).toContain(`'${BODY}' 레인`);
		expect(placed.reason).toContain(`'${HEAD}' 레인`);
		expect(placed.reason).toContain(WHY_EXEC_WRITER);
		expect(placed.reason).not.toContain("선언되지 않은");
		expect(placed.reason).not.toContain("isolationReason");
		// What to check before the same call goes again: that the earlier writer has finished, not the call text.
		expect(placed.reason).toContain(WRITE_ORDER_CHECK);
	});

	test("a lane that declared nothing is still told the scope is unknown, without claiming files", () => {
		const plan: RunPlan = { ...directorPlan(), lanes: [implementer("A"), implementer("B")] };
		const placed = refusal(new RunLanes("run-h").place(call("A", "B"), plan, team, { policies: policiesOf(plan, BASH_TOOLS, false) }));
		expect(placed.reason).not.toContain("파일 목록을 선언했지만");
	});
});

test("an overlapping batch is refused before the director takes the write claim", () => {
	const plan: RunPlan = { ...directorPlan(), lanes: [implementer("A", ["src/a.ts"]), implementer("B", ["src/a.ts"])] };
	const policies = policiesOf(plan, PATH_TOOLS, false);
	expect(batchWriteNeed(call("A", "B"), plan, team, { policies })).toMatchObject({ ok: false, code: "lane-write" });
	expect(batchWriteNeed(call("A"), plan, team, { policies })).toMatchObject({ ok: true, writers: ["storm-implementer"] });
});

describe("grammar around an inserted lane name", () => {
	// A name's last sound decides 은/는, 이/가, 과/와; the text puts a fixed noun after the name, so none of them can be wrong.
	for (const name of ["Alpha", "Beta", "작업1", "구현", "lane7", "X"]) {
		test(`'${name}'`, () => {
			const other = `${name}Other`;
			const plan: RunPlan = { ...directorPlan(), lanes: [implementer(name, ["a"]), implementer(other, ["b"])] };
			const work = new RunLanes(`run-${name.length}`);
			const policies = policiesOf(plan, BASH_TOOLS, true);
			const batch = refusal(work.assign(call(name, other), plan, team, { policies }));
			expect(batch.reason).toContain(`'${name}' 레인은`);
			expect(batch.reason).toContain(`같은 호출의 '${other}' 레인과`);
			const later = new RunLanes(`run-later-${name.length}`);
			expect(later.assign(call(name), plan, team, { policies }).ok).toBe(true);
			const single = refusal(later.assign(call(other), plan, team, { policies }));
			expect(single.reason).toContain(`'${other}' 레인은`);
			expect(single.reason).toContain(`먼저 시작한 '${name}' 레인과`);
			expect(single.reason).toContain(`먼저 시작한 '${name}' 레인이 끝난 뒤`);
			// No literal alternation left in the sentence.
			expect(batch.reason).not.toMatch(/이\(가\)|은\(는\)|을\(를\)|과\(와\)/u);
		});
	}
});

describe("an isolated lane while omp isolation is off (14:22:17)", () => {
	const isolated: RunPlan = {
		...directorPlan(),
		lanes: [implementer(BODY, [DIR("a")]), implementer(HEAD, [DIR("b")], { isolationReason: "independent trial" })],
	};

	test("says what is off, that turning it on is the user's, and the way that works now", () => {
		const policies = policiesOf(isolated, BASH_TOOLS, true);
		const placed = refusal(new RunLanes("run-i").assign(call(HEAD), isolated, team, { policies, host: { enabled: false, apply: false } }));
		expect(placed.reason).toContain("task.isolation.enabled=false");
		expect(placed.reason).toContain("omp config set task.isolation.enabled true");
		expect(placed.reason).toContain("사용자");
		expect(placed.reason).toContain("isolationReason");
		// The old closing advice made a file list read as the basis of sequencing.
		expect(placed.reason).not.toContain("파일 범위를 나눈");
	});
});

describe("a reviewer that may run commands is ordered like a writer", () => {
	const REVIEW = "FinalReview";
	const reviewPlan = (): RunPlan => ({
		lanes: [
			implementer(BODY, [DIR("gemma4-body-qat")]),
			implementer(HEAD, [DIR("gemma4-head-qat")]),
			{ name: SCOUT, kind: "explore", role: "explorer", goal: "trace the producer" },
			{ name: REVIEW, kind: "review", role: "reviewer", goal: "review the integrated change" },
		],
		workers: { implementer: 2, explorer: 1, reviewer: 1 },
		submittedAt: "2026-01-01T00:00:00Z",
	});
	const reviewTeam = teamOf({ implementer: "fake/dev", explorer: "fake/look", reviewer: "fake/rev" });
	const policies = (plan: RunPlan, reviewerTools: readonly string[], auto: boolean): Map<string, LanePolicy> =>
		new Map(
			plan.lanes.map(lane => [
				lane.name,
				lanePolicy({
					lane,
					tools: lane.role === "explorer" ? READ_TOOLS : lane.role === "reviewer" ? reviewerTools : PATH_TOOLS,
					isolated: false,
					auto,
				}),
			]),
		);
	const review = () => ({ tasks: [{ agent: "storm-reviewer", name: REVIEW, task: "review" }] });

	for (const auto of [false, true]) {
		const place = (work: RunLanes, input: unknown, plan: RunPlan, map: Map<string, LanePolicy>) =>
			auto ? work.assign(input, plan, reviewTeam, { policies: map }) : work.place(input, plan, reviewTeam, { policies: map });

		test(`${auto ? "automatic" : "manual"}: a live shell reviewer holds back a writer, and a live writer holds back the reviewer`, () => {
			const plan = reviewPlan();
			const map = policies(plan, ["read", "grep", "bash"], auto);
			expect(shellReader(map.get(REVIEW))).toBe(true);
			// A writer starts beside nothing; the reviewer is refused while it runs, and says why.
			const writer = new RunLanes(`run-rw-${auto}`);
			expect(place(writer, call(BODY), plan, map).ok).toBe(true);
			const refused = refusal(place(writer, review(), plan, map) as ReturnType<RunLanes["place"]>);
			expect(refused.code).toBe("lane-write");
			expect(refused.reason).toContain(WHY_SHELL_REVIEWER);
			expect(refused.reason).toContain(`'${BODY}' 레인`);
			expect(refused.reason).toContain(WRITE_ORDER_CHECK);
			// The other way round: a live reviewer holds back even a path-only writer on files it never names.
			const reviewer = new RunLanes(`run-wr-${auto}`);
			expect(place(reviewer, review(), plan, map).ok).toBe(true);
			const held = refusal(place(reviewer, call(HEAD), plan, map) as ReturnType<RunLanes["place"]>);
			expect(held.code).toBe("lane-write");
			expect(held.reason).toContain(`'${REVIEW}' 레인`);
			expect(held.retry).toBe(true);
			// An explorer has no shell: it runs beside the reviewer.
			expect(place(reviewer, call(SCOUT), plan, map).ok).toBe(true);
		});

		test(`${auto ? "automatic" : "manual"}: a reviewer without a shell reserves nothing and starts beside a writer`, () => {
			const plan = reviewPlan();
			const map = policies(plan, ["read", "grep"], auto);
			expect(shellReader(map.get(REVIEW))).toBe(false);
			const work = new RunLanes(`run-plain-${auto}`);
			expect(place(work, call(BODY), plan, map).ok).toBe(true);
			expect(place(work, review(), plan, map).ok).toBe(true);
		});
	}
});
