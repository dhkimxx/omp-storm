import { describe, expect, test } from "bun:test";
import { decideSpawn } from "../src/policy/spawn.ts";
import type { ApprovalRecord, ConfigLoad, ShadowInfo, SpawnDecision, SpawnEvent, SpawnState, StormConfig } from "../src/types.ts";

const HASH = `jcs-sha256:${"ab12".repeat(16)}`;

const config: StormConfig = {
	version: 1,
	priority: "balanced",
	roles: {
		reviewer: { agent: "storm-reviewer", models: ["openai/gpt-5.2", "anthropic/claude-x:low", "openrouter/qwen/qwen3"], effort: "high" },
		explorer: { agent: "storm-explorer", models: ["google/gemini-flash"] },
	},
	parallelism: 2,
	isolation: "isolated",
	contract: "workflowz",
	runtime: "omp",
};

const ok: ConfigLoad = { status: "ok", path: "/r/.omp/storm/config.json", config, hash: HASH, rawSha256: "0".repeat(64), warnings: [] };

const shadow: ShadowInfo = { agent: "storm-reviewer", path: "/r/.omp/agents/rev.md", scope: "project", sha256: "1".repeat(64) };

function approval(overrides: Partial<ApprovalRecord> = {}, shadowedAgents: ShadowInfo[] = []): ApprovalRecord {
	return {
		schema: "storm.approval/v1",
		approvalId: "apr_01JZ0000000000000000000000",
		status: "active",
		repoId: "git-r-000000000000000000000000",
		configHash: HASH,
		rawSha256: "0".repeat(64),
		approvedAt: "2026-11-20T00:00:00.000Z",
		approvedVia: { mode: "dialog" },
		versions: { omp: "19.0.1", storm: "0.1.0", configSchema: 1 },
		scope: { providers: ["openai"], roles: config.roles, runtime: "omp", shadowedAgents },
		supersedes: null,
		expiresAt: null,
		...overrides,
	};
}

const ev = (agent: string): SpawnEvent => ({ agent, invocationKind: "task", patterns: [] });
const state = (over: Partial<SpawnState> = {}): SpawnState => ({ config: ok, approval: approval(), shadows: [], ...over });
const reason = (d: SpawnDecision): string | undefined => (d && "block" in d ? d.reason : undefined);

describe("decideSpawn", () => {
	test("leaves non-storm agents alone even when nothing is approved", () => {
		expect(decideSpawn(ev("task"), state({ config: { status: "missing", path: "x" }, approval: undefined }))).toBeUndefined();
	});

	test("blocks when config is missing or invalid", () => {
		expect(reason(decideSpawn(ev("storm-reviewer"), state({ config: { status: "missing", path: "x" } })))).toBe(
			"Storm 설정이 없습니다. /storm 으로 팀을 설정하세요.",
		);
		const invalid: ConfigLoad = { status: "invalid", path: "x", errors: ["version: 1이어야 합니다", "b"] };
		expect(reason(decideSpawn(ev("storm-reviewer"), state({ config: invalid })))).toBe("Storm 설정 오류: version: 1이어야 합니다");
	});

	test("blocks without an active approval for this exact hash", () => {
		const expected = "승인되지 않은 Storm 설정입니다(ab12ab12ab12). /storm review 로 승인하세요.";
		expect(reason(decideSpawn(ev("storm-reviewer"), state({ approval: undefined })))).toBe(expected);
		expect(reason(decideSpawn(ev("storm-reviewer"), state({ approval: approval({ status: "revoked" }) })))).toBe(expected);
		const other = approval({ configHash: `jcs-sha256:${"f".repeat(64)}` });
		expect(reason(decideSpawn(ev("storm-reviewer"), state({ approval: other })))).toBe(expected);
	});

	test("blocks a storm agent the config has no role for", () => {
		expect(reason(decideSpawn(ev("storm-implementer"), state()))).toBe("Storm 설정에 storm-implementer 역할이 없습니다.");
	});

	test("blocks unapproved shadow definitions of the spawned role only", () => {
		const blocked = "승인되지 않은 역할 정의가 있습니다: /r/.omp/agents/rev.md. /storm review 로 확인하세요.";
		expect(reason(decideSpawn(ev("storm-reviewer"), state({ shadows: [shadow] })))).toBe(blocked);
		// Same agent approved with different content is still unapproved.
		const stale = approval({}, [{ ...shadow, sha256: "2".repeat(64) }]);
		expect(reason(decideSpawn(ev("storm-reviewer"), state({ shadows: [shadow], approval: stale })))).toBe(blocked);
		// A shadow of another role does not block this one.
		expect(reason(decideSpawn(ev("storm-explorer"), state({ shadows: [shadow] })))).toBeUndefined();
		// Approved (agent, sha256) pair passes.
		const d = decideSpawn(ev("storm-reviewer"), state({ shadows: [shadow], approval: approval({}, [shadow]) }));
		expect(d && "model" in d).toBe(true);
	});

	test("routes to approved models with effort applied only where no suffix exists", () => {
		expect(decideSpawn(ev("storm-reviewer"), state())).toEqual({
			model: ["openai/gpt-5.2:high", "anthropic/claude-x:low", "openrouter/qwen/qwen3:high"],
			note: "storm: storm-reviewer → openai/gpt-5.2:high",
		});
		expect(decideSpawn(ev("storm-explorer"), state())).toEqual({
			model: ["google/gemini-flash"],
			note: "storm: storm-explorer → google/gemini-flash",
		});
	});

	test("blocks a role with no models", () => {
		const empty: ConfigLoad = { ...ok, config: { ...config, roles: { r: { agent: "storm-reviewer", models: [] } } } };
		expect(reason(decideSpawn(ev("storm-reviewer"), state({ config: empty })))).toBeDefined();
	});
});
