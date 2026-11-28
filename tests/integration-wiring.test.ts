/**
 * E's host wiring, without a real omp: the exact scoped Settings identity, ABA detection, the fail-closed
 * private-launch gate, the bounded candidate/integrate adapter and the target-fence refusal.
 *
 * These are deterministic unit cases. The real-host release matrix, the native checkout and the Resolved
 * backend/factory seam belong to F; no test here claims a positive managed private launch.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent";
import { Settings, withActiveSettings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { AgentSessionHandle } from "@oh-my-pi/pi-coding-agent/session/agent-session-handle";
import { cfgTaskIsolationApply, cfgTaskIsolationEnabled } from "@oh-my-pi/pi-coding-agent/task/settings";
import {
	INTEGRATION_GUARD_BUILD,
	ISOLATION_BACKEND_UNPROVEN,
	ISOLATION_POLICY_CHANGED,
	ISOLATION_SCOPE_UNKNOWN,
	directorIdentityFor,
	integrationApplyPolicy,
	isolationLaunchProblem,
	observeDirectorIsolation,
	type DirectorIsolationObservation,
} from "../src/discovery/settings.ts";
import type { ApplyPolicyProofRef, IntegrationProblem, NativeTaskItem } from "../src/runtime/integration-admission.ts";
import { fenceRefusal, INTEGRATION_FENCE_REFUSAL } from "../src/policy/toolcall.ts";
import { integrationIdListProblem, type StormToolHost } from "../src/tool/host.ts";
import { runStormTool } from "../src/tool/storm-tool.ts";

const SESSION_ID = "main:integration-wiring";
const SESSION_INSTANCE = "main:integration-wiring-instance";
const SESSION_DIR = "/tmp/storm-p4/E/profile/session";
const DIRECTOR = { sessionId: SESSION_ID, sessionInstance: SESSION_INSTANCE, sessionDir: SESSION_DIR, parentId: "" };
const CANDIDATE = `c1_${"a".repeat(64)}`;
const CANDIDATE_2 = `c1_${"b".repeat(64)}`;

function isolated(overrides: Record<string, unknown> = {}): Settings {
	return Settings.isolated({
		"task.isolation.enabled": true,
		"task.isolation.apply": false,
		"task.isolation.merge": "patch",
		"task.isolation.commits": "generic",
		"isolation.backend": "apfs",
		...overrides,
	});
}

function registerDirector(settings: Settings): void {
	AgentRegistry.global().register({
		id: SESSION_ID,
		displayName: "Main",
		kind: "main",
		status: "idle",
		sessionFile: null,
		createdAt: 1,
		lastActivity: 1,
		session: { instanceKey: SESSION_INSTANCE, settings } as unknown as AgentSessionHandle,
	});
}

function observe(settings: Settings, toolCallId = "call-1"): DirectorIsolationObservation {
	registerDirector(settings);
	const read = withActiveSettings(settings, () => observeDirectorIsolation({ director: DIRECTOR, toolCallId }));
	if (read.kind !== "known") throw new Error(`expected an observation, got ${read.problem.code}`);
	return read.value;
}

function problemOf(observation: DirectorIsolationObservation): IntegrationProblem {
	return isolationLaunchProblem(observation);
}

afterEach(() => {
	AgentRegistry.resetGlobalForTests();
});

describe("the exact director isolation observation", () => {
	test("reads the registered live session's Settings instance and the pinned isolation values", () => {
		const settings = isolated();
		const observation = observe(settings);
		expect(observation.settings).toBe(settings);
		expect(observation.settingsInstance).toBe(`${SESSION_INSTANCE}#${SESSION_ID}`);
		expect(observation.snapshot).toEqual({
			enabled: true,
			apply: false,
			merge: "patch",
			backend: "apfs",
			commits: "generic",
			ovnfsPath: undefined,
		});
		expect(withActiveSettings(settings, () => observation.check())).toEqual({ ok: true });
		observation.stop();
	});

	test("refuses a non-live session instance as unknown scope, never falling back to global settings", () => {
		const settings = isolated();
		registerDirector(settings);
		const read = withActiveSettings(settings, () =>
			observeDirectorIsolation({ director: { ...DIRECTOR, sessionInstance: "main:another-instance" }, toolCallId: "call-1" }),
		);
		expect(read.kind).toBe("unknown");
		if (read.kind === "unknown") expect(read.problem.code).toBe(ISOLATION_SCOPE_UNKNOWN);
	});

	test("refuses when the handler is outside the director session's Settings scope", () => {
		const settings = isolated();
		registerDirector(settings);
		const read = observeDirectorIsolation({ director: DIRECTOR, toolCallId: "call-1" });
		expect(read.kind).toBe("unknown");
		if (read.kind === "unknown") expect(read.problem.code).toBe(ISOLATION_SCOPE_UNKNOWN);
	});

	test("catches effective ABA between the task call and the spawn hook", () => {
		const settings = isolated();
		const observation = observe(settings);
		cfgTaskIsolationApply.override(settings, true);
		cfgTaskIsolationApply.override(settings, false);
		expect(observation.changed).toBe(true);
		const check = withActiveSettings(settings, () => observation.check());
		expect(check.ok).toBe(false);
		if (!check.ok) expect(check.problem.code).toBe(ISOLATION_POLICY_CHANGED);
		observation.stop();
	});

	test("catches an effective change of the backend even when enabled/apply are restored", () => {
		const settings = isolated();
		const observation = observe(settings);
		// Through the public handle API: a false→true→false on the enabled switch is one relevant ABA.
		cfgTaskIsolationEnabled.override(settings, false);
		cfgTaskIsolationEnabled.override(settings, true);
		expect(withActiveSettings(settings, () => observation.check()).ok).toBe(false);
		observation.stop();
	});
});

describe("the fail-closed managed private-launch gate", () => {
	test("an otherwise stable policy still refuses because no per-dispatch backend proof exists", () => {
		const settings = isolated();
		registerDirector(settings);
		const read = withActiveSettings(settings, () => integrationApplyPolicy.arm({ director: DIRECTOR, toolCallId: "item-1" }));
		expect(read.kind).toBe("unknown");
		if (read.kind === "unknown") {
			expect(read.problem.code).toBe(ISOLATION_BACKEND_UNPROVEN);
			expect(read.problem.reason.length).toBeGreaterThan(0);
		}
	});

	test("auto backend and an explicit native backend are both refused; apply/merge are checked first", () => {
		const auto = observe(isolated({ "isolation.backend": "auto" }));
		expect(problemOf(auto).code).toBe(ISOLATION_BACKEND_UNPROVEN);
		auto.stop();
		const native = observe(isolated());
		expect(problemOf(native).code).toBe(ISOLATION_BACKEND_UNPROVEN);
		native.stop();
		const applyOn = observe(isolated({ "task.isolation.apply": true }));
		expect(problemOf(applyOn).code).toBe("isolation-apply-on");
		applyOn.stop();
		const branch = observe(isolated({ "task.isolation.merge": "branch" }));
		expect(problemOf(branch).code).toBe("isolation-merge-not-patch");
		branch.stop();
		const ai = observe(isolated({ "task.isolation.commits": "ai" }));
		expect(problemOf(ai).code).toBe("isolation-ai-commit-helper");
		ai.stop();
	});

	test("checkBeforeGrant cannot pass a proof this build did not mint, and binds the exact item", () => {
		const proof: ApplyPolicyProofRef = {
			id: "policy-test",
			host: "19.2.1",
			settingsInstance: SESSION_INSTANCE,
			relevantEpoch: 0,
			directorInstance: SESSION_INSTANCE,
			toolCallId: "item-1",
			enabled: true,
			backendProofId: "backend-test",
			apply: false,
			merge: "patch",
			captureContract: "native-git-synthetic-tree",
			backendSetting: "apfs",
			profile: SESSION_DIR,
			guardBuild: INTEGRATION_GUARD_BUILD,
		};
		const item: NativeTaskItem = { toolCallId: "item-1", itemIndex: 0, handle: "handle-1" };
		const refused = integrationApplyPolicy.checkBeforeGrant(proof, item);
		expect(refused.ok).toBe(false);
		if (!refused.ok) expect(refused.problem.code).toBe(ISOLATION_BACKEND_UNPROVEN);
		const other: NativeTaskItem = { ...item, toolCallId: "item-2" };
		const mismatch = integrationApplyPolicy.checkBeforeGrant(proof, other);
		expect(mismatch.ok).toBe(false);
		if (!mismatch.ok) expect(mismatch.problem.code).toBe(ISOLATION_SCOPE_UNKNOWN);
	});

	test("the loaded guard tag is a stable build token, not a settings value", () => {
		expect(INTEGRATION_GUARD_BUILD).toContain("storm-integration-guard/");
	});

	test("a director identity needs the live local session; another id is unknown", () => {
		const settings = isolated();
		registerDirector(settings);
		const known = directorIdentityFor({ sessionId: SESSION_ID, sessionDir: SESSION_DIR, parentId: "" });
		expect(known.kind).toBe("known");
		const unknown = directorIdentityFor({ sessionId: "main:missing", sessionDir: SESSION_DIR, parentId: "" });
		expect(unknown.kind).toBe("unknown");
		if (unknown.kind === "unknown") expect(unknown.problem.code).toBe(ISOLATION_SCOPE_UNKNOWN);
	});
});

describe("the target fence refuses every managed parent write unless it is clear", () => {
	test("clear is the only allow; fenced and unreadable are refusals with the exact cause", () => {
		expect(fenceRefusal({ kind: "clear" })).toBeUndefined();
		expect(fenceRefusal({ kind: "fenced", fence: { leaseKey: "k", root: "/repo", runId: "r", intentSequence: 1, effectToken: "e" } })).toBe(INTEGRATION_FENCE_REFUSAL);
		const unknown = fenceRefusal({ kind: "unknown", problem: { code: "io", reason: "torn record" } });
		expect(unknown).toContain(INTEGRATION_FENCE_REFUSAL);
		expect(unknown).toContain("torn record");
	});
});

describe("the bounded candidates/integrate adapter", () => {
	type Call = { kind: "candidates"; input: unknown } | { kind: "integrate"; ids: readonly string[] };
	const hostWith = (calls: Call[], picks: { candidates?: string; integrate?: string } = {}): StormToolHost => {
		const integration: NonNullable<StormToolHost["integration"]> = {
			candidates: async input => {
				calls.push({ kind: "candidates", input });
				return { outcome: "ok", text: picks.candidates ?? "candidates-view" };
			},
			integrate: async ids => {
				calls.push({ kind: "integrate", ids });
				return { outcome: "ok", text: picks.integrate ?? "selection-view" };
			},
		};
		return { integration } as StormToolHost;
	};

	test("candidates passes exact fields and no implicit run or authority", async () => {
		const calls: Call[] = [];
		const reply = await runStormTool(hostWith(calls), { action: "candidates", candidateAfter: CANDIDATE, candidateRunId: "run-1" });
		expect(reply.outcome).toBe("ok");
		expect(reply.text).toBe("candidates-view");
		expect(calls).toEqual([{ kind: "candidates", input: { candidateAfter: CANDIDATE, candidateRunId: "run-1" } }]);
	});

	test("a candidate and a cursor together are refused before the runtime", async () => {
		const calls: Call[] = [];
		const reply = await runStormTool(hostWith(calls), { action: "candidates", candidateId: CANDIDATE, candidateAfter: CANDIDATE_2 });
		expect(reply.outcome).toBe("rejected");
		expect(calls.length).toBe(0);
	});

	test("an unbound runtime refuses both read and write actions", async () => {
		const host = {} as StormToolHost;
		expect((await runStormTool(host, { action: "candidates" })).outcome).toBe("rejected");
		expect((await runStormTool(host, { action: "integrate", candidateIds: [CANDIDATE] })).outcome).toBe("rejected");
	});

	test("malformed, duplicate and empty selections refuse the whole request before any writer", async () => {
		const calls: Call[] = [];
		const host = hostWith(calls);
		for (const ids of [[], [CANDIDATE, CANDIDATE], ["c1_short"], ["c1_" + "A".repeat(64)]]) {
			const reply = await runStormTool(host, { action: "integrate", candidateIds: ids });
			expect(reply.outcome).toBe("rejected");
		}
		expect(calls.length).toBe(0);
	});

	test("integrate refuses read-only detail fields before the runtime", async () => {
		const calls: Call[] = [];
		const reply = await runStormTool(hostWith(calls), { action: "integrate", candidateIds: [CANDIDATE], candidateId: CANDIDATE_2 });
		expect(reply.outcome).toBe("rejected");
		expect(calls.length).toBe(0);
	});

	test("a valid list reaches the runtime once, in order", async () => {
		const calls: Call[] = [];
		const reply = await runStormTool(hostWith(calls), { action: "integrate", candidateIds: [CANDIDATE, CANDIDATE_2] });
		expect(reply.outcome).toBe("ok");
		expect(calls).toEqual([{ kind: "integrate", ids: [CANDIDATE, CANDIDATE_2] }]);
	});

	test("the id list helper enforces the wire format and distinctness", () => {
		expect(integrationIdListProblem([CANDIDATE])).toBeUndefined();
		expect(integrationIdListProblem([])).toBeDefined();
		expect(integrationIdListProblem([CANDIDATE, CANDIDATE])).toBeDefined();
		expect(integrationIdListProblem(["all"])).toBeDefined();
		expect(integrationIdListProblem([CANDIDATE, "c1_" + "g".repeat(64)])).toBeDefined();
	});
});
