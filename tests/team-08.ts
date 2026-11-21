/**
 * Compatibility fixture: a real team written by Storm 0.8 and the approval record 0.8 put on disk for it.
 * Config files and approvals like these must keep loading, validating with the same hash and counting as approved.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

/** `.omp/storm/config.json` as 0.8 serialized it (one line here; the hash ignores formatting). */
export const TEAM_08 =
	'{"contextCap":200000,"contract":"workflowz","fallbackRole":"implementer","isolation":"shared","parallelism":4,"priority":"balanced","roles":{"architect":{"agent":"storm-architect","models":["openai-codex/gpt-6-astra:xhigh","anthropic/claude-fable-5-2:xhigh"],"workers":{"max":1,"min":1}},"explorer":{"agent":"storm-explorer","models":["mistral/deepseek-v4-1-flash-1017:low","anthropic/claude-haiku-5-5:low"],"workers":{"max":2,"min":1}},"implementer":{"agent":"storm-implementer","models":["openai-codex/gpt-6.2-sol:medium","anthropic/claude-sonnet-5-5:medium"],"workers":{"max":2,"min":1}},"quick":{"agent":"storm-quick","models":["anthropic/claude-haiku-5-5:low","mistral/deepseek-v4-1-flash-1017:low"],"workers":{"max":2,"min":1}},"reviewer":{"agent":"storm-reviewer","models":["anthropic/claude-sonnet-5-5:high","mistral/zai-glm-5:high"],"workers":{"max":1,"min":1}}},"runtime":"omp","version":1}';

/** Its config hash as 0.8 and 0.9 computed it. */
export const TEAM_08_HASH = "jcs-sha256:e4043125366bbca8ae36b34db9e333f3721a80aea7429c835f9d3e65240d7b4f";

/** Writes what 0.8/0.9 left in an approval store directory for that team: record, snapshot, evidence, log, repo and run list. */
export async function writeStore08(storeDir: string, repoId: string): Promise<void> {
	const hex = TEAM_08_HASH.slice("jcs-sha256:".length);
	const config = JSON.parse(TEAM_08);
	const record = {
		schema: "storm.approval/v1",
		approvalId: "apr_01KA7ZJ4W3Q8N6T5R2M9X0BCDE",
		status: "active",
		repoId,
		configHash: TEAM_08_HASH,
		rawSha256: "9f2c".padEnd(64, "0"),
		approvedAt: "2026-11-20T05:12:44.512Z",
		approvedVia: { mode: "tui" },
		versions: { omp: "19.0.1", storm: "0.8.0", configSchema: 1 },
		scope: { providers: ["anthropic", "mistral", "openai-codex"], roles: config.roles, runtime: "omp", shadowedAgents: [], fallbackRole: "implementer" },
		supersedes: null,
		expiresAt: null,
	};
	const files: Record<string, string> = {
		[`approved/${hex}.json`]: `${JSON.stringify(record, null, 2)}\n`,
		[`snapshots/${hex}.json`]: `${JSON.stringify(config, null, 2)}\n`,
		[`evidence/${hex}.json`]: `${JSON.stringify({ schema: "storm.evidence/v1", roles: {} })}\n`,
		"log.jsonl": `${JSON.stringify({ ts: record.approvedAt, event: "approved", approvalId: record.approvalId, configHash: TEAM_08_HASH })}\n`,
		"repo.json": `${JSON.stringify({ schema: "storm.repo/v1", repoId, kind: "dir" })}\n`,
		"runs.jsonl": `${JSON.stringify({ runId: "run-20261120-051500-ab12", artifactsDir: "/sessions/x", agents: ["a1"] })}\n`,
	};
	for (const [name, text] of Object.entries(files)) {
		await fs.mkdir(path.dirname(path.join(storeDir, name)), { recursive: true });
		await fs.writeFile(path.join(storeDir, name), text);
	}
}
