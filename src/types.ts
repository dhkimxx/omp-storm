/**
 * Shared contracts between OMP Storm modules.
 *
 * Modules depend on each other only through these types and injected functions, so each can be
 * built and tested on its own. Semantics that every module must keep:
 * - A missing metric is `value: null`, never 0.
 * - Account identifiers (email, accountId, orgId, orgName, identityKey, credentialId) and tokens
 *   are never stored, logged, rendered, or sent to a model.
 * - Nothing is approved unless the user picked the approve option in a dialog.
 */

// ── Primitives ─────────────────────────────────────────────────────────────────────────────

export type Effort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export const EFFORTS: readonly Effort[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

/** What a recommendation optimizes. `speed` and `quota` changed no team on real data and are no longer offered. */
export type Priority = "balanced" | "quality" | "cost";
export const PRIORITIES: readonly Priority[] = ["balanced", "quality", "cost"];

/** Price tier by reference request cost: cheap < $0.01 ≤ general < $0.06 ≤ premium. */
export type Tier = "cheap" | "general" | "premium";
export const TIERS: readonly Tier[] = ["cheap", "general", "premium"];

/** Where a request ran: the user's main session or a spawned subagent (stats.db `agent_type`). */
export type Seat = "main" | "subagent";

/** A metric with provenance. `value: null` means missing and must not be treated as 0. */
export interface MetricValue {
	value: number | null;
	/** "catalog", "catalog:sibling", "lineage", "measured", "prior:<id>", or "none". */
	source: string;
	/** Not the route's own figure, or the lineage's routes disagree: shown with "≈". */
	approx?: boolean;
	/** Quality only: max − min across the lineage's routes; widens the "same quality" tolerance (src/lineage/metrics.ts). */
	spread?: number;
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

/** A semantic highlight rendered with the active OMP theme, never as embedded ANSI in Markdown. */
export type InfoTone = "accent" | "success" | "warning" | "error" | "muted";
export interface InfoSpan {
	text: string;
	tone?: InfoTone;
}

/** A standalone Markdown line's richer TUI equivalent. Offsets count logical lines, not wrapped terminal rows. */
export interface InfoLine {
	index: number;
	spans: readonly InfoSpan[];
	/** Optional determinate meter; the spans always include the authoritative numeric value. */
	meter?: { fraction: number; tone: InfoTone };
}

/** Shown with a choice while it is open (TUI: a panel above the selector, gone once it closes); other hosts get a transcript message. */
export interface UiContext {
	title: string;
	markdown: string;
	info?: readonly InfoLine[];
	/**
	 * The options that accept what `markdown` shows (approve, roll back, delete). While part of it is hidden they are
	 * not offered: the user opens the whole content first, so nothing is accepted that was never displayed.
	 */
	consent?: readonly string[];
}

/** Answers of a form by control name: text, a number for number inputs, or a group's checked values. */
export type FormData = Record<string, string | number | string[]>;

/** The subset of omp's `ctx.ui` Storm uses, plus Storm's own views. */
export interface UiPort {
	/** Resolves to the chosen label, or undefined when cancelled or when no UI can answer. */
	select(title: string, options: string[], context?: UiContext): Promise<string | undefined>;
	/** An outcome notice. TUI: omp's notification line; other hosts: a transcript message (never sent to the model). */
	notify(message: string, level?: "info" | "warning" | "error"): void;
	/** A view to read and close. TUI: a scrollable overlay that leaves nothing in the transcript; other hosts: a transcript message. Resolves once closed. */
	report(title: string, markdown: string, info?: readonly InfoLine[]): Promise<void>;
	/** Kept in the transcript, never sent to the model: run results and other records. Keep it to a few lines. */
	record(title: string, markdown: string): void;
	/** Draws an HTML `<form>` and resolves to its answers, or undefined when cancelled or timed out. Absent when the host has no form surface. */
	form?(html: string): Promise<FormData | undefined>;
	/** Selects an available tool-capable chat model for a Storm role, without changing the session. TUI only; Esc cancels. */
	pickModel?(title: string): Promise<ModelInfo | undefined>;
}

// ── Catalog ─────────────────────────────────────────────────────────────────────────────────

export interface ModelIdentityInfo {
	class: string;
	revision?: string;
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
}

/** Model lineage key (docs/spikes.md, P0 Q9): `class/tier@revision`. */
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
	/** Rows that fed `decodeTps`. */
	decodeSamples: number;
	ttftP50: number | null;
	/** Local date "YYYY-MM-DD" → requests. */
	daily: Record<string, number>;
}

export interface UsageSnapshot {
	status: "ok" | "missing-db" | "unsupported-schema" | "error";
	/** Missing column names or an error message; never user data. */
	detail?: string;
	windowDays: number;
	/** MAX(timestamp) in the DB; null when empty. */
	dataAsOf: number | null;
	rows: UsageRow[];
}

// ── Quota and explicit settings (implemented in src/discovery) ──────────────────────────────

export type QuotaState = "available" | "limited" | "exhausted" | "unknown";

export interface QuotaStatus {
	provider: string;
	/** From the limits that cover the whole provider; a limit scoped to one model never sets it. */
	state: QuotaState;
	/** Highest used fraction across the provider-wide limits, 0..1; null when unknown. */
	usedFraction: number | null;
	/** Earliest reset among exhausted/limited provider-wide windows, ms since epoch. */
	resetsAt: number | null;
	/** Models with an exhausted limit of their own: model id (lowercase) → reset time (ms since epoch) or null. */
	exhaustedModels?: Record<string, number | null>;
	/** Exhausted limits scoped to a model tier ("opus"): tier (lowercase) → reset time or null. Matched against the lineage tier. */
	exhaustedTiers?: Record<string, number | null>;
}

/** Explicit model preferences from omp settings (`omp config list --json`). */
export interface ExplicitSettings {
	defaultModel?: string;
	modelRoles: Record<string, string>;
	/** `task.isolation.enabled`: whether the task tool accepts `isolated: true`. */
	isolationEnabled?: boolean;
	/** `task.maxConcurrency`: subagents omp runs at once. */
	maxConcurrency?: number;
	/** `retry.modelFallback`: omp may switch to `retry.fallbackChains` models after provider errors. */
	modelFallback?: boolean;
	/** `retry.fallbackChains`: model role, selector or `provider/*` → ordered fallback selectors. */
	fallbackChains?: Record<string, string[]>;
}

// ── Analysis (implemented in src/analysis) ──────────────────────────────────────────────────

export interface RouteStats {
	selector: string;
	requests: number;
	ttftP50: number | null;
}

/** Usage of one lineage in one seat. Shares are within that seat. */
export interface LineageUsage {
	modelKey: string;
	requests: number;
	/** Share of the seat's requests over the whole window. */
	share: number;
	/** Share weighted by recency (7-day half-life). */
	shareRecent: number;
	errorRate: number;
	/** Most requests first. */
	routes: RouteStats[];
}

export interface Analysis {
	windowDays: number;
	/** Lineages per seat, sorted by share desc. */
	preferences: Record<Seat, LineageUsage[]>;
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
	/** `exhausted` also when only this model's own limit is; such a candidate ranks after equal ones that can run now. */
	quota: QuotaState;
	/** When an exhausted limit resets, ms since epoch; absent when unknown or not exhausted. */
	quotaResetsAt?: number;
	/** Heavily used by this user with a low error rate. */
	validated: boolean;
	why: string[];
	/** Filled for candidates other than the chosen one. */
	whyNot: string[];
}

/** A newer revision of a model line ("class/tier") than the one in use. */
export interface NewerVersion {
	label: string;
	int: MetricValue;
	/** Routes usable now. */
	selectors: string[];
	/** Providers that list it but are not logged in; filled only when no route is usable now. */
	loginProviders: string[];
	/** The revision was read from a name, or every route is a preview: shown as "확인 필요". */
	needsCheck: boolean;
}

/** Where a role's current primary model stands in the ranking. */
export interface CurrentRank {
	/** Set when the model is not a candidate: not usable now, or dropped by the constraint filter. */
	excluded?: string;
	/** Candidates ranked above it, best first, each with the first ranking key it wins on. Empty for an excluded model. */
	above: Array<{ candidate: Candidate; reason: string }>;
	/** Newer revisions of its model line in the catalog, newest first. */
	newer: NewerVersion[];
}

export interface RoleRecommendation {
	role: RoleSpec;
	/** Ranked best first, one per lineage, at most 5. Empty when nothing passes the constraint filter. */
	candidates: Candidate[];
	/** Index into candidates of the default pick; -1 when candidates is empty. */
	chosenIndex: number;
	/**
	 * What the role falls back to when the chosen model fails: a route of another lineage on another provider that can
	 * run now, searched in the whole ranking (it may lie beyond `candidates`). Proven routes come first: one the user
	 * ran on a validated lineage, then one with any requests of its own, then the best-ranked one.
	 */
	fallback?: Candidate;
	/** Present when the caller named the role's current primary model. */
	current?: CurrentRank;
	/** Models dropped by the constraint filter, with the reason. */
	excluded: Array<{ selector: string; reason: string }>;
}

// ── Config (implemented in src/config) ──────────────────────────────────────────────────────

export interface RoleConfig {
	agent: string;
	/** Attempt order. Each entry is "provider/id" with an optional ":<effort>" suffix (omp pattern syntax); see src/selector.ts. */
	models: string[];
	/** Default effort for entries without their own suffix. Storm writes a suffix per model and leaves this unset. */
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

/** A bounded trial of a candidate model for one role. Part of the hashed config, so approving the config approves the trial. */
export interface TrialConfig {
	/** Unique within the config and per start, e.g. "implementer-gpt-6-2-sol-20261120T093000Z" (`trialId`). */
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

/** A config's stored priority: "speed" and "quota" were choices before 0.10 and are read as "balanced" (`teamPriority`). */
export type StoredPriority = Priority | "speed" | "quota";

/** `.omp/storm/config.json` (schema version 1). Unknown fields are kept and hashed. */
export interface StormConfig {
	version: 1;
	priority: StoredPriority;
	roles: Record<string, RoleConfig>;
	parallelism: number;
	isolation: "isolated" | "shared";
	/** Deprecated since 0.10: accepted and ignored; Storm no longer writes it. */
	contract?: string;
	/** Deprecated since 0.10: accepted (only "omp"); Storm no longer writes it. */
	runtime?: "omp";
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
	 * Context ceiling in tokens (default `DEFAULT_CONTEXT_CAP`): a subagent at or past it takes no follow-ups during
	 * a run (`followUpCap`), and the director is compacted at it or at 70% of its window (`directorCap`).
	 */
	contextCap?: number;
	trials?: TrialConfig[];
	/** "실행이 끝나면 정리": the run-end janitor also removes omp records of older Storm runs' parked agents. Absent → off. */
	cleanup?: boolean;
	/** "문서 정합": doc rules in the run contract and Storm role prompts, doc checks in reviews. Absent → on; false → off. */
	docs?: boolean;
	/** Extra rounds Storm may send a run back for when its changes are unverified (0..10); 3 when absent. */
	rounds?: number;
}

export type ConfigLoad =
	| { status: "missing"; path: string }
	/** `rawSha256`: of the file's bytes when it could be read; tells one invalid file from another (`movedSince`). */
	| { status: "invalid"; path: string; errors: string[]; rawSha256?: string }
	| {
			status: "ok";
			path: string;
			config: StormConfig;
			/** "jcs-sha256:<hex>" of the canonical JSON. */
			hash: string;
			warnings: string[];
	  };

// ── Approval (implemented in src/approval) ──────────────────────────────────────────────────

export interface RepoIdentity {
	/** "git-<slug>-<24 hex>" or "dir-<slug>-<24 hex>". */
	repoId: string;
	kind: "git-common-dir" | "dir";
	/** Worktree top level (or cwd outside git); `.omp/storm/` lives here. */
	root: string;
}

/** A `storm-*` agent definition outside the plugin that would shadow the plugin's definition. */
export interface ShadowInfo {
	agent: string;
	path: string;
	scope: "project" | "user";
	sha256: string;
}

/** What an approval covers besides the config itself. Records written before 0.10 carry more fields here; they are ignored. */
export interface ApprovalScope {
	/** Shadowing definitions the user saw and approved. */
	shadowedAgents: ShadowInfo[];
}

/** `approved/<hex>.json`: the user approved the config with this hash. The config itself is the snapshot beside it. */
export interface ApprovalRecord {
	schema: "storm.approval/v1";
	status: "active";
	/** Only on records written before 0.10; never read. */
	repoId?: string;
	configHash: string;
	/** ISO 8601. */
	approvedAt: string;
	scope: ApprovalScope;
	/** Only on records written before 0.10; never written. */
	approvalId?: string;
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

/** Why Storm refused a spawn; stable across versions (records and tests key on it). */
export type SpawnBlockCode =
	| "no-config"
	| "unapproved"
	| "shadow"
	| "disabled-role"
	| "no-plan"
	| "role-not-in-plan"
	| "role-cap"
	| "parallelism"
	| "budget"
	| "internal";

/** Why Storm refused a director's tool call during a run. */
export type ToolBlockCode = "director-edit" | "read-large" | "followup-cap" | "followup-cleaned";

/** A refusal: the stable code and the sentence that teaches the model what to do instead. */
export interface Block<Code extends string = SpawnBlockCode | ToolBlockCode> {
	code: Code;
	reason: string;
}

/** undefined = leave the spawn alone. A block's `reason` starts with `[storm:<code>] `. */
export type SpawnDecision = undefined | { block: true; reason: string } | { model: string[]; note: string };

// ── Setup detection (implemented in src/context.ts) ─────────────────────────────────────────

export interface DetectionSummary {
	providers: Array<{ provider: string; models: number; quota: QuotaState }>;
	tools: { task: boolean; eval: boolean };
	warnings: string[];
}

/** Everything the Storm status report shows. Absent optional fields render as nothing. */
export interface StatusView {
	config: ConfigLoad;
	/** Active approval for the current config hash, if any. */
	approval: ApprovalRecord | undefined;
	/** Shadowing definitions; a project one's `path` is relative to the project root here. */
	shadows: ShadowInfo[];
	/** Provider quota, when it was read (it takes about a second); absent → no quota section. */
	quota?: QuotaStatus[];
	/** Newest usage row (null: no rows), when the usage DB could be read; absent → no usage section. */
	dataAsOf?: number | null;
	/** The storage line (`formatStorage`), when storage was measured. */
	storage?: string;
	/** The Storm run active in this process for this project. */
	run?: RunRecord;
	/** The most recent finished run. */
	lastRun?: RunRecord;
	trials?: TrialView[];
	/** Active quota marks only. */
	quotaMarks?: QuotaMark[];
	/** Subagents of this session. */
	agents?: AgentEntry[];
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

export type RunStatus =
	/** Under way. */
	| "running"
	/** The team's changes were verified. */
	| "done"
	/** Ran to its end and nothing was verified. */
	| "ended"
	/** Passed its budget. */
	| "budget-exceeded"
	/** Cut short. */
	| "stopped";

/** Why a run ended, stated only as far as the evidence goes. */
export type RunEndReason =
	/** The team's changes were verified. */
	| "verified"
	/** The team changed no files. */
	| "no-changes"
	/** Only quick-role changes were made, which need no review. */
	| "unreviewed"
	/** Files changed but the team has no usable reviewer role. */
	| "no-reviewer"
	/** The user stopped the run. */
	| "interrupted"
	/** The run reached its round limit. */
	| "round-limit"
	/** A round added no tool changes, reviews or model requests. */
	| "no-progress"
	/** The run reached the user's time limit. */
	| "time-limit"
	/** The session closed. */
	| "shutdown"
	/** The run passed its budget. */
	| "budget"
	/** The handoff could not be sent. */
	| "start-failed";

/** A run as requested: the task verbatim and the limits the user stated, if any. */
export interface RunSpec {
	task: string;
	/** Most rounds (main turns) the run may take, when the user set one. */
	rounds?: number;
	/** Wall-time limit in minutes, when the user set one. */
	minutes?: number;
	/** The run this one continues. */
	resumeOf?: string;
	/** What the user said when asking to resume, shown to the director in the resume block. */
	resumeNote?: string;
}

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
	 * blocked: spawn refused (`code`, `reason`).
	 */
	outcome: "routed" | "trial" | "allowed" | "substituted" | "blocked";
	/** Models returned to omp, in attempt order (with effort suffix). */
	models?: string[];
	/** Blocked spawns only. */
	code?: SpawnBlockCode;
	/** What a block told the model, or how a substitution was chosen. */
	reason?: string;
	/** Role key (storm-* agents and substitutions). */
	role?: string;
	/** Set when a trial was active for the role; `outcome: "trial"` says this spawn was routed to it. */
	trialId?: string;
	/** The caller's per-spawn key (task item name or eval label); omp names the subagent and its transcript after it. */
	spawnKey?: string;
}

/** `<root>/.omp/storm/state/runs/<runId>.json`: what one Storm run did and under which approval. */
export interface RunRecord {
	schema: "storm.run/v1";
	runId: string;
	configHash: string;
	/** Written by 0.8/0.9; ignored. */
	approvalId?: string;
	/** ISO 8601. */
	startedAt: string;
	endedAt?: string;
	status: RunStatus;
	/** Written by 0.8/0.9 (the keyword the handoff carried); ignored. */
	contract?: string;
	/** The request, truncated to 200 characters. */
	task: string;
	/** The request in full, at most 20,000 characters: what a later run resumes from. */
	request?: string;
	/** The run this one continues. */
	resumeOf?: string;
	/** List-price spend of every assistant message in this process while the run was active. */
	costUsd: number;
	/** Spend by "provider/model". */
	costByModel: Record<string, number>;
	budget?: BudgetConfig;
	spawns: SpawnRecord[];
	/** Subagents seen during the run, from the agent ledger. */
	agents?: AgentEntry[];
	/** List-price spend of the main session (the director) while the run was active. */
	mainCostUsd?: number;
	/** File changes the main session tried itself and director mode sent back to delegation. */
	blockedEdits?: number;
	/** The run plan in force when the run ended (the last one the director submitted). */
	plan?: RunPlan;
	/** Follow-ups to agents past their context cap, or cleaned, that Storm sent back to a fresh agent. */
	blockedFollowUps?: number;
	/** ISO 8601 of the last write while the run was active: the end time of a run whose process died. */
	updatedAt?: string;
	/** Artifacts dir of the main session that ran it (`<session>/`): where its subagents' records live. */
	artifactsDir?: string;
	/** "<pid>:<process start ms>" of the omp process that ran it; agents of another process are not live here. */
	process?: string;
	/** What the director read during the run and how much of it a subagent of the run had read too. */
	reads?: RunReads;
	/** Largest prompt (tokens) of a director request during the run. */
	maxMainContext?: number;
	/** Mid-run compactions of the director's context. */
	checkpoints?: RunCheckpoint[];
	/** What the run-end janitor removed. */
	cleanup?: CleanupResult;
	/** Main-session turns that settled during the run. */
	turns?: number;
	/** Most rounds the run may take, fixed at its start. */
	maxRounds?: number;
	endReason?: RunEndReason;
	/** The limits the user stated with the request. */
	limits?: { rounds?: number; minutes?: number };
}

export interface RunReads {
	/** Director `read` calls of working files that returned. */
	director: number;
	/** Characters those reads returned. */
	directorChars: number;
	/** Of those, characters from files a subagent of the run also read. */
	duplicateChars: number;
	/** Reads Storm refused (`read-large`). */
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
	turns?: number;
	endReason?: RunEndReason;
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
	/** List-price spend of the subagents routed to the candidate, on the candidate model. */
	costUsd: number;
	/** ISO 8601 of the moment the trial first reached its spawn cap or budget; its comparison ends there. Absent while it routes, and in counters written before 0.10. */
	stoppedAt?: string;
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
	/** What ended it, for ended trials. */
	endReason?: "time" | "spawns" | "budget";
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

// ── Proposals (implemented in src/proposals) ──────────────────────────────────────────────────

export type ProposalKind = "priority" | "workers" | "reselect" | "quota" | "trial" | "budget" | "settings" | "setup" | "plan";

/** A config change waiting for the user's answer in the approval dialog; it lives in memory only. */
export interface Proposal {
	kind: ProposalKind;
	/** One line above the diff. */
	summary: string;
	config: StormConfig;
}

// ── Shared analysis context (implemented in src/context.ts) ──────────────────────────────────

/** Catalog, settings, usage and analysis read once; recommendations re-rank without re-reading. */
export interface AnalysisContext {
	now: number;
	catalog: ModelInfo[];
	available: ModelInfo[];
	explicit: ExplicitSettings;
	usage: UsageSnapshot;
	analysis: Analysis;
	/** `current`: role id → that role's primary selector now; fills `RoleRecommendation.current`. */
	recommend(priority: Priority, current?: Readonly<Record<string, string>>): RoleRecommendation[];
	/** Validates a selector the user named against the available catalog. */
	checkModel: (selector: string) => { ok: true; label: string; efforts: Effort[] } | { ok: false; reason: string };
	detection(activeTools: string[], extraWarnings?: string[]): DetectionSummary;
}

// ── storm tool (implemented in src/tool) ────────────────────────────────────────────────────

export type StormToolAction = "run" | "plan" | "status" | "agents";

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
	/** plan: the run plan */
	plan?: PlanRequest;
	/** run: the user's request, verbatim */
	task?: string;
}

// ── Agent ledger (implemented in src/runtime/agents.ts, src/report/agents.ts) ────────────────

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
	/** The Storm run active during its latest turn: an agent revived in a later run belongs to that run. */
	runId?: string;
	/** "provider/model" of its last assistant message. */
	model?: string;
	state: AgentLiveState;
	/** ms since epoch. */
	startedAt: number;
	lastActivityAt: number;
	/** Prompt tokens of its last request (input + cache read + cache write): roughly what a follow-up carries. */
	contextTokens: number;
	requests: number;
	/** List-price spend. */
	costUsd: number;
	/** Messages the director delivered to it with `write agent://<id>`. */
	followUps: number;
	/** Reviews it yielded (omp reviewer output schema), counted per verdict. */
	review?: ReviewTally;
	/** Successful file-changing tool results in this subagent. */
	changes?: number;
	/** ms since epoch of the last file-changing tool result. */
	lastChangeAt?: number;
	/** Its latest review verdict. */
	lastVerdict?: {
		at: number;
		correct: boolean;
		/** The `diff` and `files` hashes of the run's main work tree when the verdict was given, as `<diff>:<files>`. */
		tree?: string;
	};
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
}
