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

import type { SymbolKey } from "@oh-my-pi/pi-tui";
import type { CloseoutDraft } from "./runtime/closeout.ts";
import type { ResultProof } from "./runtime/checkpoint-import.ts";
import type { ReviewEvidence } from "./runtime/review.ts";
import type { RunPhase } from "./view/appearance.ts";

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
	/** An OMP theme symbol led in by the renderer; unknown keys are dropped at render. */
	icon?: SymbolKey;
	/** Starts a status section on this line; unmarked lines belong to the preceding section (initially overview). */
	section?: "overview" | "team" | "runtime" | "storage";
	/** Emphasizes the existing text without changing the Markdown or adding another row. */
	emphasis?: "title" | "action";
}

/** One row of a rich choice list: a stable value, the human label, and the detail a person chooses by. */
export interface UiChoiceRow {
	/** Returned as-is when this row is chosen; never shown. */
	value: string;
	label: string;
	description?: string;
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

/** One Storm role slot's model choice, made in a single picker. An absent `effort` means the model's own default. */
export interface StormModelPick {
	model: ModelInfo;
	effort?: Effort;
}

/** Presentation metadata for a persisted closeout; its plain text remains the fallback on every host. */
export interface CloseoutRecordStyle {
	readonly kind: "closeout";
	readonly runId: string;
	readonly info: readonly InfoLine[];
}

/** The subset of omp's `ctx.ui` Storm uses, plus Storm's own views. */
export interface UiPort {
	/** Resolves to the chosen label, or undefined when cancelled or when no UI can answer. */
	select(title: string, options: string[], context?: UiContext): Promise<string | undefined>;
	/**
	 * Selects one row and resolves to its stable `value`, never its label. TUI: omp's own list overlay with each row's
	 * description (the focused row wraps its detail on a narrow terminal); other hosts: one `ctx.ui.select` over
	 * unique human labels that include the descriptions. `context` is shown as the same panel a select shows; it is
	 * for compact hub menus only and never carries consent. Optional so a test or alternate UI can fall back to
	 * {@link select}; `createUiPort` always provides it.
	 */
	selectRows?(
		title: string,
		rows: readonly UiChoiceRow[],
		context?: Omit<UiContext, "consent">,
	): Promise<string | undefined>;
	/** An outcome notice. TUI: omp's notification line; other hosts: a transcript message (never sent to the model). */
	notify(message: string, level?: "info" | "warning" | "error"): void;
	/** A view to read and close. TUI: a scrollable overlay that leaves nothing in the transcript; other hosts: a transcript message. Resolves once closed. */
	report(title: string, markdown: string, info?: readonly InfoLine[]): Promise<void>;
	/** Kept in the transcript, never sent to the model: run results and other records. Keep it to a few lines. */
	record(title: string, markdown: string, style?: CloseoutRecordStyle): void;
	/** Draws an HTML `<form>` and resolves to its answers, or undefined when cancelled or timed out. Absent when the host has no form surface. */
	form?(html: string): Promise<FormData | undefined>;
	/**
	 * Selects an available tool-capable chat model and its supported effort for one Storm role slot, without changing
	 * the omp session or its settings. `current` is this slot's canonical selector and known effort (not the session's
	 * model state): the picker opens on it and shows its effort. Resolves undefined on cancel; a pick without `effort`
	 * means the model default (a bare selector). TUI only; Esc cancels.
	 */
	pickModel?(title: string, current?: { selector: string; effort?: Effort }): Promise<StormModelPick | undefined>;
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
	/** `task.isolation.apply`: omp applies an isolated subagent's changes to the parent checkout when it settles (omp's default). */
	isolationApply?: boolean;
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
	 * Workers of this role in one Storm run. `min` is only the setup recommendation, not a spawn floor: a run plan
	 * that sets no count gets its actual worker lanes (at least one). `max` caps the role's live agents (Storm refuses
	 * spawns past it) and bounds what a plan may ask for.
	 * A bare number n (configs before v0.8) means { min: n, max: n }; read it through `workerRange`.
	 */
	workers?: number | WorkerRange;
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

/**
 * One verification command an approved config obliges a run to pass. `argv` is executed directly, first element as
 * the executable and the rest as its arguments: no shell, interpolation or generated script.
 */
export interface RequiredCheck {
	/** Unique, non-blank label; shown with the exact command in the approval dialog and in run evidence. */
	name: string;
	/** Executable first, then its arguments, in order. */
	argv: string[];
	/** Time limit of this check in milliseconds; absent → the runner's default. Covered by the config hash. */
	timeoutMs?: number;
}

/**
 * One named command an approved config lets a run start without a new approval. `argv` is executed directly, first
 * element as the executable and the rest as its arguments: no shell, interpolation, generated script or model-chosen
 * argument. The name is the selection key; the same job name always means the same approved argv.
 *
 * `resources` are opaque canonical keys the scheduler makes mutually exclusive across every Storm session and process
 * on this host. Omitting them (or an empty list) declares nothing: the caller must treat such a job as exclusive on
 * its target tree, because its writes are unknown. Resource keys never convey authority; they only serialize work.
 */
export interface ConfiguredJob {
	/** Unique within the config; shown with the exact command in the approval dialog. */
	name: string;
	/** Executable first, then its arguments, in order. */
	argv: readonly string[];
	/**
	 * Canonical resource keys this job needs exclusively, e.g. "gpu:0" or "repo:shared". Sorted and deduplicated by the
	 * runner. Absent/empty means the job's target-tree footprint is undeclared; the caller must add an exclusive key.
	 */
	resources?: readonly string[];
	/** Wall-clock limit in ms; the runner terminates the job's process group at it. */
	timeoutMs?: number;
}

/** `.omp/storm/config.json` (schema version 1). Unknown fields are kept and hashed. */
export interface StormConfig {
	version: 1;
	priority: StoredPriority;
	roles: Record<string, RoleConfig>;
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
	trials?: TrialConfig[];
	/** "실행이 끝나면 정리": the run-end janitor also removes omp records of older Storm runs' parked agents. Absent → off. */
	cleanup?: boolean;
	/** "문서 정합": doc rules in the run contract and Storm role prompts, doc checks in reviews. Absent → on; false → off. */
	docs?: boolean;
	/** Extra rounds Storm may send a run back for when its changes are unverified (0..10); 3 when absent. */
	rounds?: number;
	/**
	 * Verification commands the approved config obliges a run to pass, in order, in the run's target tree. Run only
	 * under an approved config whose hash the user approved; absent → no checks and the config hash is unchanged.
	 */
	requiredChecks?: RequiredCheck[];
	/**
	 * Named commands the approved config lets a run start without another approval. Exact argv only: selection binds a
	 * plan lane to an approved name, never to model-supplied text. Absent → no jobs and the config hash is unchanged.
	 */
	jobs?: readonly ConfiguredJob[];
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
	/**
	 * Canonical target binding of a session-scoped store: full sha256 hex of `<kind>\0<resolved root>`. A record
	 * without the exact binding of the store reading it is not an approval, so copying one between worktrees cannot
	 * carry commands or shadow coverage. Required for every record this version writes or accepts; pre-session
	 * records lack it and are never read.
	 */
	target: string;
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
	| "unmapped-agent"
	| "unassigned-lane"
	| "role-cap"
	| "parallelism"
	| "budget"
	| "internal";

/** Why Storm refused a director's tool call during a run. */
export type ToolBlockCode = "director-edit" | "read-large" | "followup-cleaned";

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

/** One storage inventory row; `warning` is set where the walk actually missed data or ownership is unknown. */
export interface StorageDetailLine {
	text: string;
	warning?: true;
}

/** Everything the Storm status report shows. Absent optional fields render as nothing. */
export interface StatusView {
	config: ConfigLoad;
	/** Active approval for the current config hash, if any. */
	approval: ApprovalRecord | undefined;
	/** Personal consent, separate from approval of the team's configuration. */
	autoDelegation?: "off" | "on" | "blocked";
	/** OMP session mode preventing a new automatic run despite team approval; user views only. */
	autoModeProblem?: string;
	/** Shadowing definitions; a project one's `path` is relative to the project root here. */
	shadows: ShadowInfo[];
	/** Provider quota, when it was read (it takes about a second); absent → no quota section. */
	quota?: QuotaStatus[];
	/** Newest usage row (null: no rows), when the usage DB could be read; absent → no usage section. */
	dataAsOf?: number | null;
	/** The concise storage line (`formatStorage`) for the hub, when storage was measured. */
	storage?: string;
	/** The full read-only inventory (`storageDetailLines`), one line per group, for the user's full status. */
	storageDetail?: readonly StorageDetailLine[];
	/** The Storm run active in this process for this project. */
	run?: RunRecord;
	/** Live phase of `run`, view-only; absent when the controller cannot say, so no phase is claimed. */
	runPhase?: RunPhase;
	/** The most recent finished run. */
	lastRun?: RunRecord;
	/** Bounded final facts, supplied only after the model status caller validates the run's native session and target. */
	lastHandoff?: string;
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
	/** Setting key, e.g. "retry.fallbackChains". */
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
	/** Previous settled run explicitly selected as background for a new scope; never restores its state. */
	followUpOf?: string;
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
	/** Director plan lane this admitted spawn was assigned to, when it came through the task tool. */
	lane?: string;
}

/** Execution evidence for one approved command: raw output is not part of the run record. */
export interface RunCheckEvidence {
	name: string;
	status: string;
	exitCode: number | null;
	tree: string;
}

/**
 * How far one required result got. `reviewable` means a submission can be judged, not that a qualitative review
 * passed; `accepted` means this requirement alone was met, never that the run is `done/verified`.
 */
export type RunResultState = "pending" | "unmet" | "reviewable" | "accepted";

/**
 * One prerequisite result version a consuming attempt started from. `version` is the producer's content-only version
 * when it has one, else its host attempt id, and `missing` when no usable submission existed at attempt start. A new
 * attempt that produces unchanged content keeps the same version, so a status-only replan reopens nothing.
 */
export interface ResultInputVersion {
	/** Producer result id. */
	id: string;
	version: string;
}

/**
 * One requirement of a run, keyed by the plan's stable result id. The id survives reassignment and lane renames; the
 * lane is only where it is currently assigned. `attemptId` is the host's reference to an observed attempt, never a
 * worker-provided claim; `reason` explains an unmet/pending state in a short line. This ledger is not evidence itself.
 */
export interface RunResult {
	/** Plan result id; run + id is the requirement's identity. */
	id: string;
	/** Assigned lane when one exists; changing it does not create a new requirement. */
	lane?: string;
	state: RunResultState;
	/**
	 * Orthogonal operator scope marker; never a state, evidence, or proof. `excluded-by-user` means the user directly
	 * removed this requirement from the live run. The row keeps the state it had, never becomes accepted, and is
	 * excluded from proof obligations and coverage once excluded. Absent means in scope.
	 */
	scope?: "excluded-by-user";
	/** Short reason anchored in the current attempt when the requirement is pending or unmet. */
	reason?: string;
	/** How finalization changed this row, separate from its evidence state. Never carried into a continuation. */
	finalized?: "unsettled" | "revoked";
	/** Host-bound attempt this state was observed in; absent until an attempt is bound. */
	attemptId?: string;
	/** Content identity of the contract this row was observed for; a changed contract invalidates the row. */
	identity?: string;
	/**
	 * Bounded copy of the contract this id was first observed for. It survives the producing lane leaving the plan, so
	 * an accepted row can still be re-located at its current source; a changed contract under the same id replaces it
	 * together with every piece of old evidence. Never reconstructed from plan or model text after the fact.
	 */
	contract?: PlanLaneResult;
	/** Content-only version of the observed evidence, stable across a new attempt while the content is unchanged. */
	contentVersion?: string;
	/** Producer result versions this evidence was observed against; absent when the lane declared no prerequisites. */
	consumed?: ResultInputVersion[];
	/**
	 * Trusted next action for a non-accepted row: a native terminal retry/fallback (the host already exhausted its
	 * configured path), a missing producer, ordinary work, a submitted review, or a known structured refusal. Absent
	 * keeps the round's normal derivation from state and `blockedBy`; never inferred from error text.
	 */
	remedy?: "work" | "producer" | "review" | "retry" | "blocked";
	/** What must change outside the team before a `blocked` row continues; only from a known structured refusal. */
	unblock?: string;
	/** Fingerprint of the lane route whose native retry was exhausted; a same-route respawn stays blocked. */
	retryRoute?: string;
	/** Which authority last set `state`: the plan alone, the lane's attempt evidence, or an independent review. */
	origin?: "plan" | "attempt" | "review";
	/** Tree fingerprint an `origin: "review"` state was bound to; another tree makes that review state stale. */
	reviewTree?: string;
	/** Bounded, host-observed proof; on resume the current source must confirm it. */
	proof?: ResultProof;
	/** The earlier run whose accepted proof was revalidated, never a new attempt. */
	restoredFrom?: string;
}

/** One direct user steering action the runtime applied to a live run. Audit/ack only: no model tool creates one, and a
 * later run never restores a pending retry from it. */
export interface RunAdjustment {
	kind: "exclude" | "retry";
	/** Plan result id the action addressed. */
	id: string;
	/** Lane the result was assigned to when the action was applied. */
	lane?: string;
	/** ISO 8601 of the acknowledgement. */
	at: string;
	/** For a retry: ISO 8601 when a prepared attempt consumed the one-shot grant. */
	takenAt?: string;
}

/** `<sessionDir>/state/runs/<runId>.json`: what one Storm run did and under which approval. */
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
	/** Target-checked context source for a new scoped follow-up, not a continuation. */
	followUpOf?: string;
	/** The goal this run continues and what its earlier runs already used. Written once at start, never updated. */
	goal?: { firstRunId: string; runs: number; usd: number; ms: number; turns: number };
	/** List-price spend of every assistant message in this process while the run was active. */
	costUsd: number;
	/** Spend by "provider/model". */
	costByModel: Record<string, number>;
	budget?: BudgetConfig;
	checks?: RunCheckEvidence[];
	/** Host-observed execution of a named project job, keyed by its plan lane. */
	jobs?: RunJob[];
	/** One row per required result, keyed by the plan's stable id; written by the runtime, never by this schema. */
	results?: RunResult[];
	/** Direct user scope/retry actions this run acknowledged, oldest first. Never replayed on resume. */
	adjustments?: RunAdjustment[];
	spawns: SpawnRecord[];
	/** Subagents seen during the run, from the agent ledger. */
	agents?: AgentEntry[];
	/** List-price spend of the main session (the director) while the run was active. */
	mainCostUsd?: number;
	/** File changes the main session tried itself and director mode sent back to delegation. */
	blockedEdits?: number;
	/** The run plan in force when the run ended (the last one the director submitted). */
	plan?: RunPlan;
	/** Follow-ups to cleaned agents that Storm sent back to a fresh agent. */
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
	/** Most rounds the run may take, fixed at its start; written only for a run with an explicit request or config cap. */
	maxRounds?: number;
	endReason?: RunEndReason;
	/** The director's bounded, evidence-based briefing for this run; not approval or verification evidence. */
	closeout?: CloseoutDraft;
	/** Facts captured at finish, before the session's team or target can change. */
	closeoutFacts?: CloseoutFacts;
	/** The limits the user stated with the request. */
	limits?: { rounds?: number; minutes?: number };
}

/** Facts that cannot be faithfully rebuilt from today's session settings. */
export interface CloseoutFacts {
	readonly target: string;
	readonly pendingLanes: readonly string[];
	readonly requiredChecks: readonly string[];
}

/** Only these actions receive a number. User-owned work is prose, never dispatched. */
export type CloseoutAction =
	| { readonly kind: "resume"; readonly label: string }
	| { readonly kind: "run"; readonly label: string; readonly task: string };

export interface CloseoutBrief {
	readonly runId: string;
	readonly tier: "none" | "line" | "card";
	readonly request: string;
	readonly target?: string;
	readonly startedAt: string;
	readonly endedAt?: string;
	readonly official: {
		readonly label: string;
		readonly tone: NonNullable<InfoSpan["tone"]>;
		readonly hasResults: boolean;
		readonly accepted: number;
		readonly inScope: number;
		readonly excluded: number;
		readonly open: Readonly<Record<"unsettled" | "revoked" | "blocked" | "retry" | "reviewable" | "pending" | "unmet", number>>;
	};
	readonly residual: readonly string[];
	readonly proof?: string;
	readonly director?: { readonly result: string; readonly remaining?: string; readonly stale: boolean };
	readonly userActions: readonly string[];
	readonly actions: readonly CloseoutAction[];
	/** The whole goal's use when this run continues an earlier one, this run included. */
	readonly goal?: { runs: number; usd: number; ms: number; turns: number };
}

export interface RunJob {
	lane: string;
	name: string;
	status: "started" | "unknown" | "passed" | "failed" | "timed-out" | "cancelled" | "spawn-error" | "unrun";
	exitCode: number | null;
	startedAt: string | null;
	finishedAt: string | null;
	/** Fixed runtime explanation, never process output. */
	detail?: string;
	attemptId?: string;
	/** Digest of the approved definition, not model-supplied text. */
	jobSha256?: string;
	/** Digest of observed, bounded stdout, not stdout itself. */
	stdoutSha256?: string;
	fence?: { cause: "process-unproven" | "lock-unreleased"; paths: readonly string[] };
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

/** `<sessionDir>/state/runs/index.jsonl`: one line per finished run, kept after the run record is pruned. */
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

/**
 * What a lane's required result is observed in: a change to the shared tree, an artifact of an isolated attempt, or
 * an answer to a question. Plan input only: a result states what an attempt must show, never that it did.
 */
export type LaneResultKind = "change" | "artifact" | "answer";

/**
 * One required, observable result of a lane. Its `id` is the requirement's stable identity across replans; `criterion`
 * says what to check and the optional fields narrow how. None of it is evidence or proof until a run observes an
 * attempt; a plan alone never satisfies a result.
 */
export interface PlanLaneResult {
	/** Stable plan-wide id; same id on a replan keeps the same requirement. */
	id: string;
	kind: LaneResultKind;
	/** What must be shown, as one visible line. Never proof by itself. */
	criterion: string;
	/**
	 * Workspace-relative path the result is observed at. Optional: a change without a path relies on the lane's
	 * authorized `files`, and an artifact without one only on evidence bound to the observed attempt. On `answer`, a
	 * source file the answer must cite. Never absolute or outside the tree.
	 */
	path?: string | undefined;
	/**
	 * Exact content the result must exhibit, whitespace included; optional on every kind. For `change`/`artifact` it
	 * is matched in the observed content; for `answer` it is matched in the cited source, not in the answer's wording.
	 */
	contains?: string | undefined;
	/** Name of a check in the approved config's `requiredChecks`; never a command line or an unreviewed check. */
	check?: string | undefined;
}

/** What a dependent lane waits for from its prerequisite: its required result, the integrated tree, or a submission to review. */
export type LaneNeed = "result" | "integrated" | "reviewable";

/**
 * One prerequisite edge of a lane. `lane` names another lane of the same plan by its validated name; `need` says which
 * state of that lane must hold before this lane may start. Plan input only: never evidence that the need was met.
 */
export interface PlanLaneDependency {
	lane: string;
	need: LaneNeed;
}

/** One lane of a run plan: a piece of work with its kind, the role that does it, and the files it may change. */
export interface PlanLane {
	name: string;
	kind: LaneKind;
	/** Role key; resolved from `kind` when the director names none. */
	role: string;
	/** Approved deterministic job used instead of a subagent for this run lane. */
	job?: string | undefined;
	/** Write scope; lanes that run at the same time should not share files. */
	files?: string[];
	/** What the lane delivers: stable identity. Changing it for the same name on replan is a conflict. */
	goal?: string;
	/**
	 * Why this lane is an independent experiment whose result stays outside the parent tree. Omitted means the lane
	 * shares the parent worktree; a team configured as `isolated` still isolates every lane without one.
	 */
	isolationReason?: string;
	/** The lane's status as the director reports it. Never evidence, proof, write scope, or part of its evidence key. */
	progress?: string;
	/** Required results the lane must show; absent on plans written before the contract and never synthesized. */
	results?: PlanLaneResult[] | undefined;
	/**
	 * Prerequisite lanes this lane waits for; absent on plans written before dependencies and never synthesized.
	 * A dependency is plan input, not proof that the prerequisite submitted or that its change was integrated.
	 */
	dependsOn?: PlanLaneDependency[] | undefined;
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

/** Counters of one trial, kept in `<sessionDir>/state/trials.json` by trial id. */
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
	/**
	 * Live effective OMP `task.maxConcurrency`, never a Storm config value: 0 means unlimited, absent means OMP's
	 * effective value is unavailable. The runtime repurposes `SpawnBlockCode` "parallelism" against this host cap.
	 */
	maxConcurrency?: number;
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

export type ProposalKind = "priority" | "workers" | "reselect" | "quota" | "trial" | "budget" | "settings" | "setup";

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

export type StormToolAction = "run" | "plan" | "execute" | "brief" | "status" | "agents";

/** A run plan as the director sends it; `validatePlan` checks it and resolves roles and workers. */
export interface PlanRequest {
	lanes: Array<{
		name: string;
		kind: LaneKind;
		job?: string | undefined;
		role?: RoleId | undefined;
		files?: string[] | undefined;
		goal?: string | undefined;
		/** Only for an independent experiment kept outside the parent tree; omitted lanes share the tree. */
		isolationReason?: string | undefined;
		progress?: string | undefined;
		results?: PlanLaneResult[] | undefined;
		/** Prerequisite lanes by name and the state of each that must hold; omitted keeps the lane unconstrained. */
		dependsOn?: PlanLaneDependency[] | undefined;
	}>;
	workers?: Record<string, number> | undefined;
	note?: string | undefined;
}

/** Arguments the LLM passes; each action reads only its own fields. */
export interface StormToolParams {
	action: StormToolAction;
	/** plan: the run plan */
	plan?: PlanRequest;
	/** execute: exact lane names from the active plan; no model-supplied commands. */
	lanes?: string[];
	/** brief: results and the next directions for the current run, held until it actually settles. */
	brief?: CloseoutDraft;
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
	/** The host's most recent settled turn reported an error, abort, or output limit. */
	lastWorkFailed?: true;
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
	/** Bounded structured evidence, not the reviewer's commentary or raw output. */
	reviewLog?: ReviewEvidence[];
	/** Evidence may no longer rule out an open P0 because a record was dropped. */
	reviewLogOverflow?: true;
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
