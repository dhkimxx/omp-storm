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

/** Shown with a choice while it is open (TUI: a panel above the selector, gone once it closes); other hosts get a transcript message. */
export interface UiContext {
	title: string;
	markdown: string;
}

/** The subset of omp's `ctx.ui` Storm uses, plus Storm's own views. */
export interface UiPort {
	/** Resolves to the chosen label, or undefined when cancelled or when no UI can answer. */
	select(title: string, options: UiSelectItem[], context?: UiContext): Promise<string | undefined>;
	/** Resolves to false when declined, cancelled, or when no UI can answer. */
	confirm(title: string, message: string): Promise<boolean>;
	input(title: string, placeholder?: string): Promise<string | undefined>;
	notify(message: string, level?: "info" | "warning" | "error"): void;
	/** A view to read and close. TUI: a scrollable overlay that leaves nothing in the transcript; other hosts: a transcript message. Resolves once closed. */
	report(title: string, markdown: string): Promise<void>;
	/** Kept in the transcript, never sent to the model: run results and other records. Keep it to a few lines. */
	record(title: string, markdown: string): void;
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
	/** `task.isolation.enabled`: whether the task tool accepts `isolated: true`. */
	isolationEnabled?: boolean;
	/** `task.maxConcurrency`: subagents omp runs at once. */
	maxConcurrency?: number;
	/** `task.showResolvedModelBadge`: the task widget shows each subagent's actual model. */
	showResolvedModelBadge?: boolean;
	/** `retry.modelFallback`: omp may switch to `retry.fallbackChains` models after provider errors. */
	modelFallback?: boolean;
	/** `retry.fallbackChains`: model role, selector or `provider/*` → ordered fallback selectors. */
	fallbackChains?: Record<string, string[]>;
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
	newer: NewerVersion[];
	/** Keyed by the base lineage's modelKey. */
	alternatives: Record<string, Alternative[]>;
	warnings: string[];
}

// ── Roles and recommendations (implemented in src/recommend) ────────────────────────────────

export type RoleId = "explorer" | "implementer" | "reviewer" | "quick" | "architect";

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
	/**
	 * Workers of this role in one Storm run. `min` is the count a run plan gets when it sets none for a role it uses;
	 * `max` caps the role's live agents (Storm refuses spawns past it) and bounds what a plan may ask for.
	 * A bare number n (configs before v0.8) means { min: n, max: n }; read it through `workerRange`.
	 */
	workers?: number | WorkerRange;
	/** Context ceiling in tokens for this role's agents; overrides `StormConfig.contextCap`. */
	contextCap?: number;
}

export interface WorkerRange {
	min: number;
	max: number;
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
	/**
	 * Roles the user chose not to use ("사용 안 함" in setup): their storm-* spawns are refused and the run contract
	 * leaves them out. Never "implementer" and never a key of `roles`. A role in neither list is missing: its spawns
	 * borrow the nearest configured stand-in's models (`ROLE_STAND_INS`).
	 */
	disabledRoles?: string[];
	/**
	 * Context ceiling in tokens for subagents (default `DEFAULT_CONTEXT_CAP`). An agent at or past
	 * min(this, 70% of its window) takes no follow-ups during a run: the director starts a fresh one with a summary.
	 */
	contextCap?: number;
	trials?: TrialConfig[];
	/** "실행이 끝나면 정리": the run-end janitor also removes omp records of older Storm runs' parked agents. Absent → off. */
	cleanup?: boolean;
	/** "문서 정합": doc rules in the run contract and Storm role prompts, doc checks in reviews. Absent → on; false → off. */
	docs?: boolean;
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
	disabledRoles?: string[];
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

// ── Setup detection (implemented in src/context.ts) ─────────────────────────────────────────

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

/** Everything the Storm status report shows. v0.2 runtime fields are optional; absent ones render as nothing. */
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
	/** omp settings that do not fit the approved team; shown, never changed. */
	ompAdvice?: OmpAdvice[];
	/** A newer Storm installed on disk than the one this process runs (`/restart` loads it). */
	newerVersion?: string;
}

/** An omp setting that does not fit the approved team. Storm shows it with a copy-ready command and never changes it. */
export interface OmpAdvice {
	/** Setting key, e.g. "task.maxConcurrency". */
	key: string;
	message: string;
	/** `omp config set …` that fixes it, when one does. */
	command?: string;
}

/** A previously approved config offered by rollback. */
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
	 * allowed: non-Storm agent kept its (approved) model · substituted: the agent got another role's models
	 * (`fallbackRole`, the role an omp built-in agent maps to, or a missing role's stand-in; `role` names it) ·
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
	/** List-price spend of the main session (the director) while the run was active. */
	mainCostUsd?: number;
	/** File changes the main session tried itself and director mode sent back to delegation. */
	blockedEdits?: number;
	/** The run plan in force when the run ended (the last one the director submitted). */
	plan?: RunPlan;
	/** Follow-ups to agents past their context ceiling that Storm sent back to a fresh agent. */
	blockedFollowUps?: number;
	/** ISO 8601 of the last write while the run was active. */
	updatedAt?: string;
	/** Artifacts dir of the main session that ran it (`<session>/`): where its subagents' records live. */
	artifactsDir?: string;
	/** "<pid>:<process start ms>" of the omp process that ran it; agents of another process are not live here. */
	process?: string;
	/** Director `read` calls during the run: all, those of a file a subagent of the run had read, and the ones Storm refused. */
	reads?: RunReads;
	/** Largest prompt (tokens) of a director request during the run. */
	maxMainContext?: number;
	/** Mid-run compactions of the director's context. */
	checkpoints?: RunCheckpoint[];
	/** What the run-end janitor removed. */
	cleanup?: CleanupResult;
}

export interface RunReads {
	director: number;
	duplicate: number;
	blocked: number;
}

export interface RunCheckpoint {
	/** ISO 8601. */
	at: string;
	/** Director context tokens when the compaction started, and after it when known. */
	before: number;
	after?: number;
}

export interface CleanupResult {
	/** Subagents whose omp records were removed (their outputs stay). */
	agents: number;
	/** omp record files removed and their bytes. */
	files: number;
	bytes: number;
	/** Storm's own files removed by its limits: run records, approval snapshots and evidence, trial counters, proposals. */
	stormFiles: number;
}

/** `<root>/.omp/storm/state/runs/index.jsonl`: one line per finished run, kept after the run record is pruned. */
export interface RunSummary {
	schema: "storm.run-summary/v1";
	runId: string;
	startedAt: string;
	endedAt?: string;
	status: RunStatus;
	task: string;
	costUsd: number;
	mainCostUsd?: number;
	maxMainContext?: number;
	/** Largest last-request context of any subagent of the run. */
	maxAgentContext?: number;
	agents: number;
	spawns: { total: number; blocked: number };
	reviews?: { reviews: number; passed: number; failed: number; docFindings: number };
	blockedFollowUps?: number;
	reads?: RunReads;
	checkpoints?: number;
	cleanup?: CleanupResult;
}

/** Kinds of work a run plan's lanes do; each defaults to a role (`LANE_ROLES`). */
export type LaneKind = "explore" | "code" | "run" | "review" | "design";

/** One lane of a run plan: a piece of work with its kind, the role that does it, and the files it may change. */
export interface PlanLane {
	name: string;
	kind: LaneKind;
	/** Role key; resolved from `kind` when the director names none. */
	role: string;
	/** Write scope; lanes that run at the same time should not share files. */
	files?: string[];
	goal?: string;
}

/**
 * The director's plan for one Storm run, validated against the approved team. Within the team's bounds it applies
 * at once; past them it needs an approved config change first. Storm refuses spawns during a run until one exists.
 */
export interface RunPlan {
	lanes: PlanLane[];
	/** Live agents allowed per role in this run (each ≤ the role's max); roles without lanes get none. */
	workers: Record<string, number>;
	/** ISO 8601. */
	submittedAt: string;
	note?: string;
}

/** A provider reported out of quota; approved fallbacks on other providers go first until `until`. */
export interface QuotaMark {
	provider: string;
	source: "user" | "usage" | "fallback";
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
	run?: {
		runId: string;
		costUsd: number;
		budget?: BudgetConfig;
		/** The run plan in force; spawns during a run are refused without one. */
		plan?: RunPlan;
		/** Agents of this run alive now (spawned and not yet settled), excluding the one being decided. */
		active?: { total: number; byRole: Record<string, number> };
	};
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

export type ProposalKind = "priority" | "workers" | "reselect" | "quota" | "trial" | "budget" | "settings" | "setup" | "plan";

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
	/** Why this team, as the session LLM explained it when it proposed a setup. */
	rationale?: string;
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
	/** Validates a selector the user named against the available catalog. */
	checkModel: (selector: string) => { ok: true; label: string; efforts: Effort[] } | { ok: false; reason: string };
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
	| "settings"
	| "run"
	| "plan"
	| "agents"
	| "propose";

/** A run plan as the director sends it; `validatePlan` checks it and resolves roles and workers. */
export interface PlanRequest {
	lanes: Array<{
		name: string;
		kind: LaneKind;
		role?: RoleId | undefined;
		files?: string[] | undefined;
		goal?: string | undefined;
	}>;
	workers?: Record<string, number> | undefined;
	note?: string | undefined;
}

/** Arguments the LLM passes; each action reads only its own fields. */
export interface StormToolParams {
	action: StormToolAction;
	/** priority */
	priority?: Priority;
	/** workers, reselect, trial */
	role?: RoleId;
	/** workers: the role's new worker range (either bound may be left out) */
	min?: number;
	max?: number;
	/** plan: the run plan */
	plan?: PlanRequest;
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
	/** settings: "실행이 끝나면 정리" and "문서 정합" switches */
	cleanup?: boolean;
	docs?: boolean;
	/** run */
	task?: string;
	/** propose: the whole team as a Storm config object (version, priority, roles, parallelism, isolation, contract, …). */
	config?: unknown;
	/** propose: why this team, in the user's language; stored with the evidence. */
	rationale?: string;
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
	/** Reviews it yielded (omp reviewer output schema), counted per verdict. */
	review?: ReviewTally;
	/** ms since epoch: the run-end janitor removed its omp records; its `agent://` output stays. */
	cleanedAt?: number;
}

/** A reviewer's yields counted as reviews: each final verdict payload is one review; findings add up across them. */
export interface ReviewTally {
	/** Verdict payloads received: passed + failed. */
	reviews: number;
	passed: number;
	failed: number;
	/** Findings by priority: [P0, P1, P2, P3]. */
	findings: [number, number, number, number];
	/** Findings about docs (kind doc_conflict or doc_copy); also counted in `findings`. */
	docFindings?: number;
	/** 0..1, from the latest verdict. */
	lastConfidence?: number;
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
