/** An in-memory project behind both hosts of the approval path: the storm tool's and the request actions'. */
import { ApprovalStore } from "../src/approval/store.ts";
import { configHash } from "../src/config/canonical.ts";
import type { ActionHost } from "../src/request/actions.ts";
import type { ProjectState } from "../src/state.ts";
import type { RunRequestResult, StormToolHost } from "../src/tool/host.ts";
import type { AgentEntry, ApprovalScope, QuotaMark, QuotaStatus, RepoIdentity, RunPlan, RunSpec, ShadowInfo, StormConfig } from "../src/types.ts";
import { type Answer, fakeCtx, scriptedUi, TEAM } from "./support.ts";

export const NOW = Date.parse("2026-11-20T09:00:00Z");
export const repo: RepoIdentity = { repoId: "dir-test-000000000000000000000000", kind: "dir", root: "/repo" };
/** An in-memory session store outside the target; the fake host never writes it. */
const sessionDir = "/profile/storm/sessions/fake-host";
const store = new ApprovalStore(sessionDir, repo);
/** What the fake `statusText` returns; the tool passes it through. */
export const STATUS_TEXT = "status-text";

interface Saved {
	config: StormConfig;
	scope: ApprovalScope;
	baseHash: string | null;
}

export interface FakeHostOptions {
	config?: StormConfig | null;
	approved?: boolean;
	answers?: Answer[];
	shadows?: ShadowInfo[];
	run?: RunRequestResult;
	agents?: AgentEntry[];
	runActive?: boolean;
	/** omp's quota view; reading it fails when absent. */
	quota?: QuotaStatus[];
}

/**
 * A host over an in-memory project. The config starts approved (with its shadows) unless `approved: false`;
 * `setConfig` / `setShadows` change it the way a hand edit does, without approving.
 */
export function fakeHost(opts: FakeHostOptions = {}) {
	let config: StormConfig | null = opts.config === undefined ? structuredClone(TEAM) : opts.config;
	let shadows = opts.shadows ?? [];
	let approval: { hash: string; shadows: ShadowInfo[] } | undefined =
		config && opts.approved !== false ? { hash: configHash(config), shadows: [...shadows] } : undefined;
	const f = scriptedUi(opts.answers ?? []);
	const saved: Saved[] = [];
	const plans: RunPlan[] = [];
	const marks: QuotaMark[] = [];
	const runs: RunSpec[] = [];
	const statusCalls: Array<{ quota: boolean }> = [];
	let prepares = 0;
	const state = (): ProjectState => {
		const hash = config ? configHash(config) : null;
		return {
			repo,
			sessionDir,
			config:
				config && hash
					? { status: "ok", path: `${sessionDir}/config.json`, config: structuredClone(config), hash, warnings: [] }
					: { status: "missing", path: `${sessionDir}/config.json` },
			approval:
				approval && approval.hash === hash
					? { schema: "storm.approval/v1", status: "active", repoId: repo.repoId, target: store.targetKey, configHash: approval.hash, approvedAt: "2026-11-20T00:00:00.000Z", scope: { shadowedAgents: approval.shadows } }
					: undefined,
			shadows: [...shadows],
			store,
		};
	};
	const host: StormToolHost & ActionHost = {
		ui: f.ui,
		now: () => NOW,
		loadState: async () => state(),
		prepare: async () => {
			prepares++;
			return fakeCtx(NOW);
		},
		approveAndSave: async (st, next, scope) => {
			saved.push({ config: next, scope, baseHash: st.config.status === "ok" ? st.config.hash : null });
			config = structuredClone(next);
			approval = { hash: configHash(next), shadows: scope.shadowedAgents };
			return configHash(next);
		},
		statusText: async statusOpts => {
			statusCalls.push(statusOpts);
			return STATUS_TEXT;
		},
		addQuotaMark: async mark => {
			marks.push(mark);
		},
		quota: async () => {
			if (!opts.quota) throw new Error("omp usage is not readable");
			return opts.quota;
		},
		runtime: {
			requestRun: spec => {
				if (opts.run && !opts.run.ok) return opts.run;
				runs.push(spec);
				return opts.run ?? { ok: true, runId: "run-1" };
			},
			setRunPlan: plan => {
				if (!opts.runActive) return { ok: false, reason: "no active run" };
				plans.push(plan);
				return { ok: true };
			},
			agents: () => structuredClone(opts.agents ?? []),
		},
	};
	return {
		host,
		selects: f.selects,
		notes: f.notes,
		reports: f.reports,
		saved,
		marks,
		runs,
		plans,
		statusCalls,
		prepares: () => prepares,
		config: () => config,
		setConfig: (c: StormConfig) => {
			config = c;
		},
		setShadows: (s: ShadowInfo[]) => {
			shadows = s;
		},
	};
}
