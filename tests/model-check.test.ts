import { describe, expect, test } from "bun:test";
import {
	approvedEntries,
	checkChildModel,
	describeSpawnModels,
	entryPattern,
	hasCredentials,
	modelMismatchNotice,
	probeCredentials,
	probeCredentialsDetailed,
	roleOfAgent,
	teamSelectors,
	withinDeadline,
	withRan,
} from "../src/policy/model-check.ts";
import { CREDENTIAL_DROP_NOTE, decideSpawn, noCredentialsBlock } from "../src/policy/spawn.ts";
import type { ApprovalRecord, ConfigLoad, RunPlan, SpawnDecision, SpawnEvent, SpawnOutcome, SpawnRuntime, StormConfig } from "../src/types.ts";
import { approvalRecord, teamOf } from "./fixtures.ts";

const HASH = `jcs-sha256:${"cd34".repeat(16)}`;
const NOW = Date.parse("2026-11-20T12:00:00.000Z");

/** Implementer approved without an effort; explorer `a/x`, `b/z` at low; reviewer `b/r` at high. */
function team(over: Partial<StormConfig> = {}): StormConfig {
	return teamOf({ implementer: "a/i", explorer: { models: ["a/x", "b/z"], effort: "low" }, reviewer: { models: ["b/r"], effort: "high" } }, over);
}

const state = (config: StormConfig) => {
	const load: Extract<ConfigLoad, { status: "ok" }> = { status: "ok", path: "/r/.omp/storm/config.json", config, hash: HASH, warnings: [] };
	const approval: ApprovalRecord = approvalRecord(HASH, { repoId: "git-r-000000000000000000000000" }, []);
	return { config: load, approval, shadows: [] };
};
const PLAN: RunPlan = {
	lanes: [
		{ name: "look", kind: "explore", role: "explorer" },
		{ name: "build", kind: "code", role: "implementer" },
		{ name: "check", kind: "review", role: "reviewer" },
		{ name: "trial", kind: "run", role: "quick" },
	],
	workers: { explorer: 2, implementer: 2, reviewer: 2, quick: 1 },
	submittedAt: "2026-11-20T11:00:00.000Z",
};
const runtime = (): SpawnRuntime => ({ now: NOW, quotaMarks: [], trials: {}, run: { runId: "run-1", costUsd: 0, plan: PLAN } });
const ev = (agent: string, patterns: string[], spawnKey = "k"): SpawnEvent => ({ agent, invocationKind: "task", patterns, spawnKey });
const answered = (d: SpawnDecision): string[] | undefined => (d && "model" in d ? d.model : undefined);
const blockCode = (o: SpawnOutcome): string | undefined => (o.decision && "block" in o.decision ? o.record?.code : undefined);
const set = (...selectors: string[]): ReadonlySet<string> => new Set(selectors.map(s => s.toLowerCase()));
const ALL = set("a/i", "a/x", "b/z", "b/r");

describe("G2: a spawn Storm lets through during a run runs on an approved entry of the role it fills", () => {
	test("an id with a colon of its own still carries the approved effort, so the answer and the child's check agree (R-G234 M2)", () => {
		const colon = teamOf({ implementer: "a/i", explorer: { models: ["a/x:thinking"], effort: "low" } });
		const out = decideSpawn(ev("storm-explorer", []), state(colon), runtime(), { authenticated: set("a/x:thinking", "a/i") });
		expect(answered(out.decision)).toEqual(["a/x:thinking:low"]);
		// And the check, for a child that really runs at that level, agrees.
		expect(checkChildModel(colon, "storm-explorer", { provider: "a", id: "x:thinking", effort: "low" })).toMatchObject({ ok: true });
		// A model entry with its own effort keeps it; a plain id takes the role's.
		const own = teamOf({ implementer: "a/i", explorer: { models: ["a/x:high", "a/y"], effort: "low" } });
		expect(answered(decideSpawn(ev("storm-explorer", []), state(own), runtime(), { authenticated: set("a/x", "a/y", "a/i") }).decision)).toEqual(["a/x:high", "a/y:low"]);
	});

	test("an approved model with a higher effort than approved is not honoured (omp's bundled `task`)", () => {
		// `task` fills the implementer, approved on `a/i` with no effort. xhigh on the approved model is not that entry.
		const out = decideSpawn(ev("task", ["a/i:xhigh"]), state(team()), runtime(), { authenticated: ALL });
		expect(out.decision).toBeDefined();
		expect(answered(out.decision)).toEqual(["a/i"]);
		expect(out.record).toMatchObject({ outcome: "substituted", role: "implementer" });
	});

	test("patterns behind the first one never run: a list is honoured only when every pattern is exactly approved", () => {
		const out = decideSpawn(ev("scout", ["a/x:low", "evil/unapproved-model"]), state(team()), runtime(), { authenticated: ALL });
		expect(answered(out.decision)).toEqual(["a/x:low", "b/z:low"]);
		expect(out.record?.outcome).toBe("substituted");
		const exact = decideSpawn(ev("scout", ["b/z:low", "a/x:low"]), state(team()), runtime(), { authenticated: ALL });
		expect(answered(exact.decision)).toEqual(["b/z:low", "a/x:low"]);
		expect(exact.record?.outcome).toBe("allowed");
		// One approved entry is answered alone: the role's other entries are not appended to a request.
		expect(answered(decideSpawn(ev("scout", ["b/z:low"]), state(team()), runtime(), { authenticated: ALL }).decision)).toEqual(["b/z:low"]);
	});

	test("another role's approved model is not the role's entry", () => {
		// `a/x:low` is the explorer's entry, not the reviewer's.
		const out = decideSpawn(ev("reviewer", ["a/x:low"], "check"), state(team()), runtime(), { authenticated: ALL });
		expect(answered(out.decision)).toEqual(["b/r:high"]);
		expect(out.record).toMatchObject({ outcome: "substituted", role: "reviewer" });
	});

	test("a request without the approved effort is not the entry, so the answer carries the effort", () => {
		const out = decideSpawn(ev("scout", ["a/x"]), state(team()), runtime(), { authenticated: ALL });
		expect(answered(out.decision)).toEqual(["a/x:low", "b/z:low"]);
	});

	test("every answer to an agent of a run names its models: there is no spawn left to omp's patterns", () => {
		const asks = [[], ["a/x:low"], ["a/i:max"], ["nowhere/model"], ["a/x:low", "evil/m"]];
		for (const agent of ["scout", "task", "reviewer", "security-reviewer"]) {
			for (const patterns of asks) {
				const out = decideSpawn(ev(agent, patterns, agent === "scout" ? "look" : agent === "task" ? "build" : "check"), state(team()), runtime(), { authenticated: ALL });
				expect(answered(out.decision)).toBeDefined();
			}
		}
	});

	test("an agent that fills no bundled role takes the fallback role's list through the same rule", () => {
		const s = state(team({ fallbackRole: "explorer" }));
		expect(roleOfAgent(s.config.config, "custom")).toEqual({ key: "explorer", kind: "fallback" });
		expect(roleOfAgent(s.config.config, "scout")).toEqual({ key: "explorer", kind: "bundled" });
		expect(roleOfAgent(team(), "custom")).toBeUndefined();
		expect(approvedEntries(team({ fallbackRole: "explorer" }), "custom").map(entryPattern)).toEqual(["a/x:low", "b/z:low"]);
	});

	test("a role the team disabled is never used for an agent", () => {
		expect(roleOfAgent(team({ disabledRoles: ["explorer"] }), "scout")).toBeUndefined();
		expect(roleOfAgent(team({ fallbackRole: "explorer", disabledRoles: ["explorer"] }), "custom")).toBeUndefined();
	});
});

describe("G2: credentials", () => {
	test("approved models that cannot authenticate are not answered, and the record says what was left out", () => {
		const out = decideSpawn(ev("storm-explorer", []), state(team()), runtime(), { authenticated: set("b/z") });
		expect(answered(out.decision)).toEqual(["b/z:low"]);
		expect(out.record?.models).toEqual(["b/z:low"]);
		expect(out.record?.reason).toContain(CREDENTIAL_DROP_NOTE);
		// A request for a model without a credential falls to the role's list, still without it.
		const task = decideSpawn(ev("scout", ["a/x:low"]), state(team()), runtime(), { authenticated: set("b/z") });
		expect(answered(task.decision)).toEqual(["b/z:low"]);
		expect(task.record?.reason).toContain(CREDENTIAL_DROP_NOTE);
	});

	test("with no approved model able to authenticate the spawn is refused: omp would run the parent's model", () => {
		for (const [agent, key] of [["storm-explorer", "k"], ["scout", "look"], ["task", "build"]] as const) {
			const out = decideSpawn(ev(agent, ["a/x:low"], key), state(team()), runtime(), { authenticated: set() });
			expect(out.decision).toMatchObject({ block: true });
			expect(blockCode(out)).toBe("unapproved");
		}
		const out = decideSpawn(ev("storm-explorer", []), state(team()), runtime(), { authenticated: set("b/r") });
		expect(out.decision).toMatchObject({ block: true, reason: expect.stringContaining(noCredentialsBlock("storm-explorer", "explorer", ["a/x", "b/z"]).reason) });
	});

	test("a stand-in role and a trial candidate are held to the same credentials", () => {
		const noQuick = state(team());
		// storm-quick has no role in this team: it borrows the implementer, which has no credential here.
		expect(blockCode(decideSpawn(ev("storm-quick", []), noQuick, runtime(), { authenticated: set("a/x") }))).toBe("unapproved");
		expect(answered(decideSpawn(ev("storm-quick", []), noQuick, runtime(), { authenticated: set("a/i") }).decision)).toEqual(["a/i"]);
		const withTrial = state(
			team({ trials: [{ id: "t1", role: "explorer", model: "t/cand", share: 1, maxSpawns: 5, startsAt: "2026-11-20T00:00:00.000Z", endsAt: "2026-11-27T00:00:00.000Z", budgetUsd: 1 }] }),
		);
		const routed = decideSpawn(ev("storm-explorer", []), withTrial, runtime(), { authenticated: set("a/x", "b/z", "t/cand") });
		expect(routed.record?.outcome).toBe("trial");
		expect(answered(routed.decision)?.[0]).toBe("t/cand:low");
		const noCandidate = decideSpawn(ev("storm-explorer", []), withTrial, runtime(), { authenticated: set("a/x", "b/z") });
		expect(noCandidate.record?.outcome).toBe("routed");
		expect(answered(noCandidate.decision)).toEqual(["a/x:low", "b/z:low"]);
	});

	test("callers that pass no credentials keep the earlier answer", () => {
		expect(answered(decideSpawn(ev("storm-explorer", []), state(team()), runtime()).decision)).toEqual(["a/x:low", "b/z:low"]);
	});

	test("probeCredentials leaves out whatever throws, answers false or hangs, and compares without case", async () => {
		const seen: string[] = [];
		const found = await probeCredentials(
			["A/X", "b/z", "c/slow", "d/boom", "e/no"],
			async selector => {
				seen.push(selector);
				if (selector === "c/slow") return new Promise<boolean>(() => undefined);
				if (selector === "d/boom") throw new Error("keychain locked");
				return selector !== "e/no";
			},
			20,
		);
		expect([...found].sort()).toEqual(["a/x", "b/z"]);
		expect(hasCredentials(found, "A/x")).toBe(true);
		expect(hasCredentials(found, "c/slow")).toBe(false);
		expect(seen).toHaveLength(5);
	});

	test("teamSelectors lists each model of the team once, trial candidates included", () => {
		const trial = { role: "explorer", share: 1, maxSpawns: 1, startsAt: "2026-11-20T00:00:00.000Z", endsAt: "2026-11-27T00:00:00.000Z", budgetUsd: 1 };
		const config = team({ trials: [{ id: "t1", model: "A/X:high", ...trial }, { id: "t2", model: "t/cand", ...trial }] });
		expect(teamSelectors(config).sort()).toEqual(["a/i", "a/x", "b/r", "b/z", "t/cand"]);
	});
});

describe("G2: the child's own check", () => {
	const config = team();

	test("a model of the role at its approved effort, or below it, is what was approved", () => {
		expect(checkChildModel(config, "storm-explorer", { provider: "a", id: "x", effort: "low" })).toMatchObject({ ok: true, effortUnverified: false });
		expect(checkChildModel(config, "storm-explorer", { provider: "b", id: "z", effort: "minimal" })).toMatchObject({ ok: true });
		expect(checkChildModel(config, "storm-reviewer", { provider: "B", id: "R", effort: "high" })).toMatchObject({ ok: true });
	});

	test("the parent's model, which omp falls back to, is stopped", () => {
		const check = checkChildModel(config, "storm-explorer", { provider: "fake9", id: "outsider-z", effort: "high" });
		expect(check).toMatchObject({ ok: false, reason: "model", observed: "fake9/outsider-z:high" });
		// A model approved for another role is not approved for this one.
		expect(checkChildModel(config, "storm-explorer", { provider: "b", id: "r", effort: "low" })).toMatchObject({ ok: false, reason: "model" });
	});

	test("an effort above the approved one is stopped, an unknown level is stopped, and so is one the host did not report (a role with an approved effort)", () => {
		expect(checkChildModel(config, "storm-explorer", { provider: "a", id: "x", effort: "xhigh" })).toMatchObject({ ok: false, reason: "effort" });
		expect(checkChildModel(config, "storm-explorer", { provider: "a", id: "x", effort: "turbo" })).toMatchObject({ ok: false, reason: "effort" });
		// R-G234 M1: that the level is at or below the approved one is not established, so the worker is stopped.
		const unread = checkChildModel(config, "storm-explorer", { provider: "a", id: "x" });
		expect(unread).toMatchObject({ ok: false, reason: "effort-unread" });
		if (!unread.ok) expect(modelMismatchNotice("storm-explorer", unread, "explorer")).toContain("추론 강도를 알려 주지 않아");
	});

	test("a role with no approved effort has no effort promise: an unread level is fine, and only the model is held", () => {
		expect(checkChildModel(config, "storm-implementer", { provider: "a", id: "i" })).toMatchObject({ ok: true, effortUnverified: true });
	});

	test("the check and the answer agree on the model, not its spelling: what the host resolves a selector to is the same model (R-G234 M2)", () => {
		// The team wrote an alias; omp's registry resolves it to the canonical model the child really runs on.
		const aliased = teamOf({ implementer: "a/i", explorer: { models: ["a/x-alias"], effort: "low" } });
		const resolve = (selector: string): string | undefined => (selector === "a/x-alias" ? "a/x" : undefined);
		expect(checkChildModel(aliased, "storm-explorer", { provider: "a", id: "x", effort: "low", resolve })).toMatchObject({ ok: true });
		expect(checkChildModel(aliased, "storm-explorer", { provider: "a", id: "x", effort: "low" })).toMatchObject({ ok: false, reason: "model" });
		expect(checkChildModel(aliased, "storm-explorer", { provider: "a", id: "other", effort: "low", resolve })).toMatchObject({ ok: false, reason: "model" });
		// Case is not a difference either.
		expect(checkChildModel(aliased, "storm-explorer", { provider: "A", id: "X", effort: "low", resolve })).toMatchObject({ ok: true });
	});

	test("a role with no approved effort bounds the model only", () => {
		expect(checkChildModel(config, "storm-implementer", { provider: "a", id: "i", effort: "max" })).toMatchObject({ ok: true, effortUnverified: false });
	});

	test("bundled and fallback agents are held to the role they fill; an agent with no role is stopped", () => {
		expect(checkChildModel(config, "scout", { provider: "a", id: "x", effort: "low" })).toMatchObject({ ok: true });
		expect(checkChildModel(config, "scout", { provider: "a", id: "i", effort: "low" })).toMatchObject({ ok: false, reason: "model" });
		expect(checkChildModel(config, "custom", { provider: "a", id: "x", effort: "low" })).toMatchObject({ ok: false, reason: "no-role" });
		expect(checkChildModel(team({ fallbackRole: "explorer" }), "custom", { provider: "a", id: "x", effort: "low" })).toMatchObject({ ok: true });
	});

	test("a trial candidate is approved for a child only when its spawn was routed to the trial", () => {
		const candidate = { provider: "t", id: "cand", effort: "low" };
		expect(checkChildModel(config, "storm-explorer", candidate)).toMatchObject({ ok: false });
		expect(checkChildModel(config, "storm-explorer", candidate, { model: "t/cand" })).toMatchObject({ ok: true });
	});

	test("what the hook answers is always what the child's check accepts", () => {
		const s = state(team({ fallbackRole: "explorer" }));
		const asks = [[], ["a/x:low"], ["a/i:max"], ["z/unknown"]];
		for (const agent of ["storm-explorer", "storm-reviewer", "storm-implementer", "scout", "task", "reviewer"]) {
			for (const patterns of asks) {
				const key = agent === "scout" || agent === "storm-explorer" ? "look" : agent === "task" || agent === "storm-implementer" ? "build" : "check";
				const out = decideSpawn(ev(agent, patterns, key), s, runtime(), { authenticated: ALL });
				for (const pattern of answered(out.decision) ?? []) {
					const [selector, effort] = pattern.split(":");
					const [provider, ...id] = (selector ?? "").split("/");
					const observed = { provider: provider ?? "", id: id.join("/"), ...(effort === undefined ? {} : { effort }) };
					expect(checkChildModel(s.config.config, agent, observed).ok).toBe(true);
				}
			}
		}
	});

	// R-final N6: a check that could not be made is not told as "the team has no role for this worker".
	test("a check that could not be made says so, and says nothing about the worker's role", () => {
		const unchecked = modelMismatchNotice("storm-explorer", { ok: false, reason: "unchecked", observed: "a/x:low", approved: [] });
		const noRole = modelMismatchNotice("storm-explorer", { ok: false, reason: "no-role", observed: "a/x:low", approved: [] });
		expect(unchecked).toContain("storm-explorer");
		expect(unchecked).toContain("a/x:low");
		expect(unchecked).not.toBe(noRole);
		expect(unchecked).not.toContain("역할이 없");
		expect(unchecked).toContain("/storm");
	});

	test("the notice names the agent, the model that ran and the approved list", () => {
		const check = checkChildModel(config, "storm-explorer", { provider: "fake9", id: "outsider-z", effort: "high" });
		if (check.ok) throw new Error("expected a mismatch");
		const text = modelMismatchNotice("storm-explorer", check, "explorer");
		expect(text).toContain("storm-explorer");
		expect(text).toContain("fake9/outsider-z:high");
		expect(text).toContain("a/x:low");
	});
});

describe("the record claims no more than Storm knows", () => {
	const record = decideSpawn(ev("storm-explorer", []), state(team()), runtime(), { authenticated: ALL }).record;

	test("before a child's check has read the worker, the models are what Storm answered", () => {
		if (!record) throw new Error("no record");
		expect(withRan(record, undefined)).toBe(record);
		expect(describeSpawnModels(record)).toContain("a/x:low → b/z:low");
		expect(describeSpawnModels(record)).not.toContain("실행 확인");
		expect(record).not.toHaveProperty("ran");
	});

	test("a verified child and a stopped one are recorded as what the check read", () => {
		if (!record) throw new Error("no record");
		const verified = withRan(record, { model: "b/z", effort: "low", verdict: "verified" });
		expect(describeSpawnModels(verified)).toContain("실행 확인 b/z:low");
		const stopped = withRan(record, { model: "fake9/outsider-z", effort: "high", verdict: "mismatch" });
		expect(describeSpawnModels(stopped)).toContain("fake9/outsider-z:high");
		expect(describeSpawnModels(stopped)).not.toContain("실행 확인");
		// Records written before this field exist still read: `ran` is optional.
		expect(describeSpawnModels(record)).toBeTruthy();
	});
});

describe("the check of a request has a deadline (R-G234 M3)", () => {
	test("a value in time is returned; a slow or failing load is undefined, so the caller stops the worker instead of sending the request unchecked", async () => {
		expect(await withinDeadline(Promise.resolve("state"), 50)).toBe("state");
		const started = Date.now();
		expect(await withinDeadline(new Promise<string>(resolve => setTimeout(() => resolve("late"), 500)), 30)).toBeUndefined();
		expect(Date.now() - started).toBeLessThan(400);
		expect(await withinDeadline(Promise.reject(new Error("boom")), 50)).toBeUndefined();
	});
});

describe("a credential lookup that is late is told apart from one that said no (R-G234 L4)", () => {
	test("a slow lookup is named; a refusal where every model is only slow says the check was late and may be retried", async () => {
		const probed = await probeCredentialsDetailed(["a/x", "b/z", "c/slow", "d/thrown"], selector => {
			if (selector === "c/slow") return new Promise<boolean>(resolve => setTimeout(() => resolve(true), 300));
			if (selector === "d/thrown") throw new Error("no key");
			return selector === "a/x";
		}, 20);
		expect([...probed.ok]).toEqual(["a/x"]);
		expect([...probed.slow]).toEqual(["c/slow"]);
		expect([...(await probeCredentials(["a/x", "c/slow"], selector => (selector === "a/x" ? true : new Promise<boolean>(() => undefined)), 20))]).toEqual(["a/x"]);
		const late = noCredentialsBlock("storm-explorer", "explorer", ["c/slow"], new Set(["c/slow"]));
		expect(late.code).toBe("unapproved");
		expect(late.reason).toContain("늦어");
		expect(late.reason).not.toContain("모두 인증되지 않아");
		// One model that really said no keeps the sentence that only the user can restore it.
		expect(noCredentialsBlock("storm-explorer", "explorer", ["c/slow", "b/z"], new Set(["c/slow"])).reason).toContain("모두 인증되지 않아");
		expect(noCredentialsBlock("storm-explorer", "explorer", ["b/z"]).reason).toContain("모두 인증되지 않아");
	});
});
