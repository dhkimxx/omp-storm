/**
 * Shared contracts between OMP Storm modules (v0.1).
 *
 * Modules depend on each other only through these types and injected functions, so each can be
 * built and tested on its own. Semantics that every module must keep:
 * - A missing metric is `value: null` with a `missingReason`, never 0.
 * - Account identifiers (email, accountId, orgId, orgName, identityKey, credentialId) and tokens
 *   are never stored, logged, rendered, or sent to a model.
 * - Nothing is approved unless the user picked the approve option in a dialog.
 */

// ── Primitives ─────────────────────────────────────────────────────────────────────────────

export type Effort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export const EFFORTS: readonly Effort[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

export type Priority = "balanced" | "quality" | "cost" | "speed" | "quota";
export const PRIORITIES: readonly Priority[] = ["balanced", "quality", "cost", "speed", "quota"];

/** Price tier by reference request cost (plan 9.2): cheap < $0.01 ≤ general < $0.06 ≤ premium. */
export type Tier = "cheap" | "general" | "premium";
export const TIERS: readonly Tier[] = ["cheap", "general", "premium"];

/** Where a request ran: the user's main session or a spawned subagent (stats.db `agent_type`). */
export type Seat = "main" | "subagent";

export type Confidence = "high" | "medium" | "low";

/** A metric with provenance. `value: null` means missing and must not be treated as 0. */
export interface MetricValue {
	value: number | null;
	/** "catalog", "catalog:sibling(<n providers>)", "measured", "prior:<id>", or "none". */
	source: string;
	confidence: Confidence;
	sampleSize?: number;
	/** ms since epoch. */
	observedAt?: number;
	/** Sibling routes disagreed; `value` is the chosen one. */
	conflict?: boolean;
	/** Set when `value` is null: "catalog_no_score", "unmeasured", "no_pricing", ... */
	missingReason?: string;
}

// ── Ports (injected so modules stay testable outside omp) ───────────────────────────────────

export interface ExecResult {
	stdout: string;
	stderr: string;
	code: number;
	killed?: boolean;
}

/** Same shape as `pi.exec`. */
export type Exec = (
	command: string,
	args: string[],
	options?: { cwd?: string; timeout?: number },
) => Promise<ExecResult>;

export type UiSelectItem = string | { label: string; description?: string };

/** The subset of omp's `ctx.ui` Storm uses, plus a transcript report channel. */
export interface UiPort {
	/** Resolves to the chosen label, or undefined when cancelled or when no UI can answer. */
	select(title: string, options: UiSelectItem[]): Promise<string | undefined>;
	/** Resolves to false when declined, cancelled, or when no UI can answer. */
	confirm(title: string, message: string): Promise<boolean>;
	input(title: string, placeholder?: string): Promise<string | undefined>;
	notify(message: string, level?: "info" | "warning" | "error"): void;
	/** Show multi-line markdown in the transcript without sending it to the model. */
	report(title: string, markdown: string): void;
}

// ── Catalog ─────────────────────────────────────────────────────────────────────────────────

export interface ModelIdentityInfo {
	class: string;
	family?: string;
	revision?: string;
	effort?: string;
	thinkingVariant?: boolean;
	logicalId?: string;
}

/** USD per 1M tokens. */
export interface ModelCost {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

/** omp catalog `Model` (chat kind) normalized for Storm. */
export interface ModelInfo {
	provider: string;
	/** Wire id as omp knows it. */
	id: string;
	/** "provider/id", the form spawn patterns and config use. */
	selector: string;
	name: string;
	identity: ModelIdentityInfo;
	cost: ModelCost;
	/** False when the catalog has no price (all rates 0 or pricing unknown). */
	pricingKnown: boolean;
	contextWindow: number | null;
	maxTokens: number | null;
	reasoning: boolean;
	/** Supported thinking efforts, least to most; [] when the model has no effort control. */
	efforts: Effort[];
	supportsTools: boolean;
	int: number | null;
	tps: number | null;
	/** Authenticated and usable now (`ctx.modelRegistry.getAvailable()`). */
	available: boolean;
}

// ── Lineage, price tier, metric fill (implemented in src/lineage) ───────────────────────────

export interface LineageVariant {
	/** Route variant: fast, ultrafast, highspeed, preview, free, contributor, ... */
	route?: string;
	/** Dated snapshot suffix such as "1017". */
	snapshot?: string;
	/** `:thinking` mode toggle. */
	think?: boolean;
	/** `:low`-style effort suffix. */
	effort?: string;
}

/** Model lineage key (plan 9.2, p0-results Q9): `class/tier@revision`. */
export interface Lineage {
	/** "class/tier@revision"; revision is "?" when unknown. Unit for merging usage across hosts. */
	modelKey: string;
	/** "class/tier". Unit for "same line, newer revision". */
	lineKey: string;
	cls: string;
	/** Name tier left after removing brand words, version numbers and route words; "-" when empty. */
	tier: string;
	/** "major.minor.patch" or null. */
	revision: string | null;
	revisionSource: "identity" | "name" | null;
	classSource: "identity" | "stem" | "unknown";
	/** Revision looked compressed or odd ("56.0.0"); excluded from newer-version detection. */
	suspect: boolean;
	variant: LineageVariant;
}

/** Built once per catalog snapshot by `createLineage(catalog, priors)`. */
export type LineageFn = (provider: string, wireId: string, identity: ModelIdentityInfo | undefined) => Lineage;

export interface PriceTierInfo {
	tier: Tier | null;
	/** Reference request cost in USD (4 rates × reference token mix); null without pricing. */
	referenceUsd: number | null;
	/** cacheRead price was missing and estimated from the input price. */
	estimated: boolean;
	/** Selector of the route the tier was taken from. */
	basis: string | null;
}

// ── Usage history (implemented in src/history) ──────────────────────────────────────────────

/** Aggregates for one (provider, model, seat) over the window; `purpose IS NULL` rows only. */
export interface UsageRow {
	provider: string;
	model: string;
	seat: Seat;
	requests: number;
	/** stop_reason = 'error' (omp's definition). */
	errors: number;
	/** stop_reason = 'aborted'. */
	aborted: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	/** Sum of cost_total (list-price estimate; not money actually paid on subscriptions). */
	costTotal: number;
	unpricedRequests: number;
	/** omp's tok/s: mean of output_tokens*1000/duration over rows with duration>0 and output>0. */
	ompTps: number | null;
	/** Generation tok/s: sum(output_tokens)*1000 / sum(duration-ttft) over rows with duration>ttft. */
	decodeTps: number | null;
	ttftP50: number | null;
	ttftP90: number | null;
	ttftSamples: number;
	durationP50: number | null;
	durationP90: number | null;
	durationSamples: number;
	/** ms since epoch. */
	firstTs: number;
	lastTs: number;
	/** Local date "YYYY-MM-DD" → requests / errors. */
	daily: Record<string, number>;
	dailyErrors: Record<string, number>;
}

export interface UsageSnapshot {
	status: "ok" | "missing-db" | "unsupported-schema" | "error";
	/** Missing column names or an error message; never user data. */
	detail?: string;
	dbPath: string;
	windowDays: number;
	/** ms since epoch the window ends at. */
	now: number;
	/** MAX(timestamp) in the DB; null when empty. */
	dataAsOf: number | null;
	rows: UsageRow[];
}

// ── Quota and explicit settings (implemented in src/discovery) ──────────────────────────────

export type QuotaState = "available" | "limited" | "exhausted" | "unknown" | "unavailable";

export interface QuotaStatus {
	provider: string;
	state: QuotaState;
	/** Highest used fraction across the provider's limits, 0..1; null when unknown. */
	usedFraction: number | null;
	/** Earliest reset among exhausted/limited windows, ms since epoch. */
	resetsAt: number | null;
	observedAt: number;
}

/** Explicit model preferences from omp settings (`omp config list --json`). */
export interface ExplicitSettings {
	defaultModel?: string;
	modelRoles: Record<string, string>;
	agentModelOverrides: Record<string, string | string[]>;
	/** `magicKeywords.*` toggles; undefined when the settings could not be read. */
	magicKeywords?: { enabled: boolean; workflowz: boolean; orchestrate: boolean };
	/** `task.agentIdleTtlMs`: how long a finished subagent stays live before omp parks it (0 = never); undefined when unreadable. */
	agentIdleTtlMs?: number;
	/** `providers.cacheRetention` (`auto|short|long|none`); undefined when unreadable. */
	cacheRetention?: string;
}

// ── Analysis (implemented in src/analysis) ──────────────────────────────────────────────────

export interface RouteStats {
	selector: string;
	provider: string;
	id: string;
	requests: number;
	errors: number;
	lastTs: number;
	ompTps: number | null;
	decodeTps: number | null;
	ttftP50: number | null;
	ttftP90: number | null;
	/** costTotal / requests on this route (list-price estimate). */
	costPerRequest: number | null;
	available: boolean;
	variant: LineageVariant;
}

/** Usage of one lineage in one seat. Shares are within that seat. */
export interface LineageUsage {
	modelKey: string;
	lineKey: string;
	/** Display label, e.g. "DeepSeek V4.1 Flash". */
	label: string;
	tier: Tier | null;
	seat: Seat;
	requests: number;
	/** Share of the seat's requests over the whole window. */
	share: number;
	/** Share weighted by recency (7-day half-life). */
	shareRecent: number;
	errorRate: number;
	lastTs: number;
	routes: RouteStats[];
}

export interface StoppedLineage {
	modelKey: string;
	label: string;
	seat: Seat;
	requests: number;
	lastTs: number;
	/** Confirmed reasons only: "route-unavailable:<selector>", "quota-exhausted:<provider>", "error-rate-up". */
	reasons: string[];
	/** Selectors of the same lineage usable now. */
	currentRoutes: string[];
}

export interface NewerVersion {
	/** modelKey in use. */
	from: string;
	/** Newer modelKey on the same lineKey. */
	to: string;
	/** Available selectors of the newer key. */
	selectors: string[];
	/** Revision from the name, suspect, or preview-only: show as "확인 필요". */
	needsCheck: boolean;
	int: MetricValue;
}

export interface Alternative {
	selector: string;
	modelKey: string;
	label: string;
	tier: Tier | null;
	/** better: higher quality at ≤ cost; cheaper: same quality, lower cost; faster: same quality and cost band, faster;
	 *  validated: heavily used with a low error rate but no catalog score; upgrade: higher quality in a pricier tier. */
	kind: "better" | "cheaper" | "faster" | "validated" | "upgrade";
	int: MetricValue;
	speed: MetricValue;
	/** Candidate cost / base cost on the base lineage's own token mix; null without pricing. */
	costRatio: number | null;
	why: string;
}

export interface Analysis {
	status: UsageSnapshot["status"];
	windowDays: number;
	dataAsOf: number | null;
	/** Preferences per seat and tier, each list sorted by share desc. */
	preferences: Record<Seat, Record<Tier | "unknown", LineageUsage[]>>;
	stopped: StoppedLineage[];
	newer: NewerVersion[];
	/** Keyed by the base lineage's modelKey. */
	alternatives: Record<string, Alternative[]>;
	warnings: string[];
}

// ── Roles and recommendations (implemented in src/recommend) ────────────────────────────────

export type RoleId = "explorer" | "implementer" | "reviewer";

export interface RoleSpec {
	id: RoleId;
	/** Agent definition name shipped in agents/. */
	agent: `storm-${string}`;
	title: string;
	description: string;
	/** Tier under "balanced" priority. */
	preferredTier: Tier;
	/** Minimum context window in tokens. */
	minContext: number;
	/** Prefer a different model class than this role (independent review). */
	diversityFrom?: RoleId;
}

export interface Candidate {
	selector: string;
	modelKey: string;
	label: string;
	/** Recommended effort; null when the model has no effort control. */
	effort: Effort | null;
	tier: Tier | null;
	int: MetricValue;
	speed: MetricValue;
	referenceUsd: number | null;
	/** Estimated cost per request on the user's own token mix for subagent work; null without data. */
	userMixUsd: number | null;
	quota: QuotaState;
	confidence: Confidence;
	/** Heavily used by this user with a low error rate. */
	validated: boolean;
	why: string[];
	/** Filled for candidates other than the chosen one. */
	whyNot: string[];
}

export interface RoleRecommendation {
	role: RoleSpec;
	/** Ranked best first, at most 5. Empty when nothing passes the constraint filter. */
	candidates: Candidate[];
	/** Index into candidates of the default pick; -1 when candidates is empty. */
	chosenIndex: number;
	/** Models dropped by the constraint filter, with the reason. */
	excluded: Array<{ selector: string; reason: string }>;
}

// ── Config (implemented in src/config) ──────────────────────────────────────────────────────

export interface RoleConfig {
	agent: string;
	/** Attempt order. Each entry is "provider/id" with an optional ":<effort>" suffix (omp pattern syntax); see src/selector.ts. */
	models: string[];
	/** Default effort for entries without their own suffix. The interview writes a suffix per model and leaves this unset. */
	effort?: Effort;
	/** Workers of this role one Storm run may keep busy at once (default 1); stated in the run contract. */
	workers?: number;
}

/** A bounded trial of a candidate model for one role (plan 9.3). Part of the hashed config, so approving the config approves the trial. */
export interface TrialConfig {
	/** Unique within the config, e.g. "implementer-gpt-6-2-sol-20261120". */
	id: string;
	/** Key into `roles`. */
	role: string;
	/** Candidate "provider/id". */
	model: string;
	effort?: Effort;
	/** Fraction of the role's spawns routed to the candidate, 0 < share ≤ 1. */
	share: number;
	/** At most this many spawns go to the candidate (integer ≥ 1). */
	maxSpawns: number;
	/** ISO 8601; nothing is routed outside [startsAt, endsAt). */
	startsAt: string;
	endsAt: string;
	/** List-price spend cap for the candidate's requests during the trial (USD > 0). */
	budgetUsd: number;
}

export interface BudgetConfig {
	perRunUsd: number;
	warnAtUsd?: number;
	onExceed: "block-spawns" | "stop";
}

/** `.omp/storm/config.json` (schema version 1). Unknown fields are kept and hashed. */
export interface StormConfig {
	version: 1;
	priority: Priority;
	roles: Record<string, RoleConfig>;
	parallelism: number;
	isolation: "isolated" | "shared";
	contract: "workflowz" | "orchestrate";
	runtime: "omp";
	budget?: BudgetConfig;
	/** Key into `roles`. During a Storm run, a non-Storm agent asking for an unapproved model gets this role's models; absent → blocked. */
	fallbackRole?: string;
	trials?: TrialConfig[];
}

export type ConfigLoad =
	| { status: "missing"; path: string }
	| { status: "invalid"; path: string; errors: string[]; rawSha256?: string }
	| {
			status: "ok";
			path: string;
			config: StormConfig;
			/** "jcs-sha256:<hex>" of the canonical JSON. */
			hash: string;
			rawSha256: string;
			warnings: string[];
	  };

// ── Approval (implemented in src/approval) ──────────────────────────────────────────────────

export interface RepoIdentity {
	/** "git-<slug>-<24 hex>" or "dir-<slug>-<24 hex>". */
	repoId: string;
	kind: "git-common-dir" | "dir";
	/** Worktree top level (or cwd outside git); `.omp/storm/` lives here. */
	root: string;
	commonDir?: string;
	/** Normalized remotes with credentials stripped (hints only, never the key). */
	remotes?: Record<string, string>;
	rootCommits?: string[];
}

/** A `storm-*` agent definition outside the plugin that would shadow the plugin's definition. */
export interface ShadowInfo {
	agent: string;
	path: string;
	scope: "project" | "user";
	sha256: string;
}

export interface ApprovalScope {
	providers: string[];
	roles: Record<string, RoleConfig>;
	budget?: BudgetConfig;
	runtime: "omp";
	/** Shadowing definitions the user saw and approved. */
	shadowedAgents: ShadowInfo[];
	fallbackRole?: string;
	trials?: TrialConfig[];
}

export interface ApprovalRecord {
	schema: "storm.approval/v1";
	approvalId: string;
	status: "active" | "revoked";
	repoId: string;
	configHash: string;
	rawSha256: string;
	/** ISO 8601. */
	approvedAt: string;
	approvedVia: { mode: string };
	versions: { omp: string; storm: string; configSchema: 1 };
	scope: ApprovalScope;
	supersedes: string | null;
	expiresAt: string | null;
}

export interface ApprovalLogEntry {
	ts: string;
	event: "approved" | "revoked" | "rolled_back" | "inherited";
	approvalId: string;
	configHash: string;
	prevHash?: string | null;
}

// ── Spawn policy (implemented in src/policy) ────────────────────────────────────────────────

export interface SpawnEvent {
	agent: string;
	invocationKind: "task" | "eval";
	modelRole?: string;
	patterns: string[];
	spawnKey?: string;
}

export interface SpawnState {
	config: ConfigLoad;
	/** Active approval for the current config hash, if any. */
	approval: ApprovalRecord | undefined;
	/** Shadowing definitions found now. */
	shadows: ShadowInfo[];
}

/** undefined = leave the spawn alone. */
export type SpawnDecision = undefined | { block: true; reason: string } | { model: string[]; note: string };

// ── Setup interview (implemented in src/interview) ──────────────────────────────────────────

export interface DetectionSummary {
	providers: Array<{ provider: string; models: number; quota: QuotaState }>;
	tools: { task: boolean; eval: boolean };
	keywords: { workflowz: boolean; orchestrate: boolean };
	/** Model preferences written in omp settings, shown next to actual usage. */
	explicit?: ExplicitSettings;
	/** Usage data age relative to now; null when there is no data. */
	dataAsOf: number | null;
	stale: boolean;
	warnings: string[];
}

export interface InterviewInput {
	detection: DetectionSummary;
	analysis: Analysis;
	recommendations: RoleRecommendation[];
	/** The current config and whether its hash is approved, when one exists. */
	current?: { config: StormConfig; hash: string; approved: boolean };
	shadows: ShadowInfo[];
	/** Re-rank for another priority without re-reading data. */
	rerecommend: (priority: Priority) => RoleRecommendation[];
	/** Validates a selector the user typed against the available catalog. */
	checkModel: (selector: string) => { ok: true; label: string; efforts: Effort[] } | { ok: false; reason: string };
	defaults: { parallelism: number; isolation: StormConfig["isolation"]; contract: StormConfig["contract"] };
	priority: Priority;
}

export type InterviewResult =
	| { status: "approved"; config: StormConfig; scope: ApprovalScope }
	| { status: "cancelled"; at: string }
	| { status: "no-ui" };

/** Everything `/storm status` shows. v0.2 runtime fields are optional; absent ones render as nothing. */
export interface StatusView {
	repo: RepoIdentity;
	config: ConfigLoad;
	/** Active approval for the current config hash, if any. */
	approval: ApprovalRecord | undefined;
	shadows: ShadowInfo[];
	quota: QuotaStatus[];
	dataAsOf: number | null;
	/** The Storm run active in this process for this project. */
	run?: RunRecord;
	/** The most recent finished run. */
	lastRun?: RunRecord;
	trials?: TrialView[];
	/** Active quota marks only. */
	quotaMarks?: QuotaMark[];
	/** Proposals still waiting for approval (built on the current config). */
	pending?: Proposal[];
	/** Subagents of this session with lifecycle advice. */
	agents?: Array<{ entry: AgentEntry; advice: AgentAdvice }>;
	/** omp settings that decide what reusing a subagent costs; drives lifecycle warnings. */
	lifecycle?: LifecycleSettings;
}

/** A previously approved config offered by `/storm rollback`. */
export interface RollbackOption {
	hash: string;
	approvedAt: string;
	config: StormConfig;
}

// ── Runtime: runs, cost ledger, quota marks, trials (implemented in src/runtime) ──────────────

export type RunStatus = "running" | "done" | "budget-exceeded" | "stopped";

/** One spawn Storm decided: every storm-* spawn, and non-Storm spawns during a run. */
export interface SpawnRecord {
	/** ISO 8601. */
	ts: string;
	agent: string;
	invocationKind: "task" | "eval";
	/** Patterns core would have used, as received. */
	requested: string[];
	/**
	 * routed: storm-* agent got its approved models · trial: routed to a trial candidate ·
	 * allowed: non-Storm agent kept its (approved) model · substituted: non-Storm agent got `fallbackRole`'s models ·
	 * blocked: spawn refused (`reason`).
	 */
	outcome: "routed" | "trial" | "allowed" | "substituted" | "blocked";
	/** Models returned to omp, in attempt order (with effort suffix). */
	models?: string[];
	reason?: string;
	/** Role key (storm-* agents and substitutions). */
	role?: string;
	/** Set when a trial was active for the role, whether or not this spawn was routed to it. */
	trialId?: string;
	/** The caller's per-spawn key (task item name or eval label); omp names the subagent and its transcript after it. */
	spawnKey?: string;
}

/** `<root>/.omp/storm/state/runs/<runId>.json`: what one Storm run did and under which approval. */
export interface RunRecord {
	schema: "storm.run/v1";
	runId: string;
	configHash: string;
	approvalId: string;
	/** ISO 8601. */
	startedAt: string;
	endedAt?: string;
	status: RunStatus;
	/** Keyword the handoff carried; "none" when neither keyword was usable. */
	contract: StormConfig["contract"] | "none";
	/** The request, truncated to 200 characters. */
	task: string;
	/** List-price spend of every assistant message in this process while the run was active. */
	costUsd: number;
	/** Spend by "provider/model". */
	costByModel: Record<string, number>;
	budget?: BudgetConfig;
	warnedAt?: string;
	exceededAt?: string;
	spawns: SpawnRecord[];
	/** Subagents seen during the run, from the agent ledger. */
	agents?: AgentEntry[];
	/** ISO 8601 of the last write while the run was active. */
	updatedAt?: string;
}

/** A provider reported out of quota; approved fallbacks on other providers go first until `until`. */
export interface QuotaMark {
	provider: string;
	source: "user" | "usage";
	/** ISO 8601. */
	markedAt: string;
	until: string;
}

/** Counters of one trial, kept in `<root>/.omp/storm/state/trials.json` by trial id. */
export interface TrialState {
	id: string;
	/** Spawns of the trial's role decided while the trial was active. */
	seen: number;
	/** Of those, routed to the candidate. */
	routed: number;
	/** Candidate's list-price spend while the trial was active. */
	costUsd: number;
	/** ISO 8601, set once the trial stops routing. */
	endedAt?: string;
	endReason?: "time" | "spawns" | "budget";
}

/** Measured comparison of a trial candidate with the role's primary model since the trial started (stats DB, subagent seat). */
export interface TrialSide {
	selector: string;
	requests: number;
	errorRate: number | null;
	ompTps: number | null;
	decodeTps: number | null;
	ttftP50: number | null;
	costPerRequest: number | null;
}

export interface TrialComparison {
	candidate: TrialSide;
	current: TrialSide;
	dataAsOf: number | null;
}

export interface TrialView {
	trial: TrialConfig;
	state: TrialState | undefined;
	/** "pending" before startsAt, "active" while it may still route, "ended" once time, spawns or budget ran out. */
	phase: "pending" | "active" | "ended";
	comparison?: TrialComparison;
}

/** Spawn-time runtime facts beyond the v0.1 SpawnState. */
export interface SpawnRuntime {
	now: number;
	/** The run active in this process for this project, if any. */
	run?: { runId: string; costUsd: number; budget?: BudgetConfig };
	/** Active marks only. */
	quotaMarks: QuotaMark[];
	/** Trial counters by trial id. */
	trials: Record<string, TrialState>;
}

export interface SpawnOutcome {
	decision: SpawnDecision;
	/** Undefined when Storm stays out (non-Storm agent outside a run). */
	record?: SpawnRecord;
}

// ── Proposals and evidence (implemented in src/proposals) ─────────────────────────────────────

export type ProposalKind = "priority" | "workers" | "reselect" | "quota" | "trial" | "budget";

/** Why the approved models were chosen, stored per config hash next to the approval. */
export interface EvidenceRecord {
	schema: "storm.evidence/v1";
	/** ISO 8601. */
	createdAt: string;
	source: "setup" | ProposalKind;
	priority: Priority;
	dataAsOf: number | null;
	roles: Record<
		string,
		{
			chosen: string | null;
			candidates: Array<{
				selector: string;
				label: string;
				validated: boolean;
				int: number | null;
				speed: number | null;
				referenceUsd: number | null;
				why: string[];
				whyNot: string[];
			}>;
		}
	>;
}

/** A config change the storm tool proposed; nothing changes until the user approves it. */
export interface Proposal {
	schema: "storm.proposal/v1";
	id: string;
	kind: ProposalKind;
	/** ISO 8601. */
	createdAt: string;
	/** One line for lists. */
	summary: string;
	/** Hash of the config the proposal was built on; stale once the config moves on. */
	baseHash: string;
	config: StormConfig;
	evidence?: EvidenceRecord;
}

// ── Shared analysis context (implemented in src/context.ts) ──────────────────────────────────

/** Catalog, quota, usage and analysis read once; recommendations re-rank without re-reading. */
export interface AnalysisContext {
	now: number;
	catalog: ModelInfo[];
	available: ModelInfo[];
	quota: QuotaStatus[];
	explicit: ExplicitSettings;
	usage: UsageSnapshot;
	analysis: Analysis;
	lineage: LineageFn;
	/** Keyed by modelKey. */
	tiers: Map<string, PriceTierInfo>;
	/** Priors and data warnings. */
	warnings: string[];
	recommend(priority: Priority): RoleRecommendation[];
	checkModel: InterviewInput["checkModel"];
	detection(activeTools: string[], extraWarnings?: string[]): DetectionSummary;
}

// ── storm tool (implemented in src/tool) ────────────────────────────────────────────────────

export type StormToolAction =
	| "status"
	| "models"
	| "priority"
	| "workers"
	| "reselect"
	| "quota"
	| "trial"
	| "budget"
	| "run"
	| "agents";

/** Arguments the LLM passes; each action reads only its own fields. */
export interface StormToolParams {
	action: StormToolAction;
	/** priority */
	priority?: Priority;
	/** workers, reselect, trial */
	role?: RoleId;
	/** workers: absolute count for the role */
	workers?: number;
	/** reselect: the model the user named; trial: the candidate */
	model?: string;
	/** quota */
	provider?: string;
	/** trial */
	share?: number;
	maxSpawns?: number;
	days?: number;
	/** trial budget, or budget.perRunUsd */
	budgetUsd?: number;
	/** budget */
	warnAtUsd?: number;
	onExceed?: BudgetConfig["onExceed"];
	/** run */
	task?: string;
}

// ── Agent ledger and lifecycle advice (implemented in src/runtime/agents.ts, src/report/agents.ts) ─

export type AgentLiveState = "running" | "idle" | "parked";

/** A subagent of this process as Storm observed it from inside the child session. */
export interface AgentEntry {
	/** omp agent id (`ctx.agent.id`); also its `agent://<id>` handle. */
	id: string;
	/** Agent definition name (`ctx.agent.name`), e.g. "storm-implementer". */
	name: string;
	parentId?: string;
	/** Storm role key for storm-* agents. */
	role?: string;
	/** The Storm run active when the agent started. */
	runId?: string;
	/** "provider/model" of its last assistant message. */
	model?: string;
	state: AgentLiveState;
	/** ms since epoch. */
	startedAt: number;
	lastActivityAt: number;
	/** Prompt tokens of its last request (input + cache read + cache write): roughly what a follow-up carries. */
	contextTokens: number;
	contextWindow?: number;
	requests: number;
	/** List-price spend. */
	costUsd: number;
	/** Turns after its first one: follow-ups by message, wake or revive. */
	followUps: number;
	/** Cache-read share of the last request's prompt, 0..1. */
	lastCacheReadShare?: number;
}

export interface AgentAdvice {
	id: string;
	/** reuse: send follow-ups to it · fresh: give new work to a new agent with a summary · cleanup: nothing left to gain from keeping it. */
	action: "reuse" | "fresh" | "cleanup" | "busy";
	reason: string;
	/** "agent://<id>" when reuse is advised. */
	handle?: string;
}

/** The omp settings that decide what reusing a subagent costs. Storm only reads them. */
export interface LifecycleSettings {
	agentIdleTtlMs?: number;
	cacheRetention?: string;
}
