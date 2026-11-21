import type { LaneKind, RoleConfig, RoleId, RoleSpec, StormConfig, WorkerRange } from "./types.ts";

export const STORM_VERSION = "0.8.0";

/** Roles Storm ships. Each maps to an agent definition in agents/. */
export const ROLES: readonly RoleSpec[] = [
	{
		id: "explorer",
		agent: "storm-explorer",
		title: "탐색",
		description: "코드·문서를 읽고 범위와 근거를 모아 요약한다. 파일을 바꾸지 않는다.",
		preferredTier: "cheap",
		minContext: 64_000,
	},
	{
		id: "implementer",
		agent: "storm-implementer",
		title: "구현",
		description: "맡은 범위의 코드를 고치고 검증한다.",
		preferredTier: "general",
		minContext: 128_000,
	},
	{
		id: "reviewer",
		agent: "storm-reviewer",
		title: "리뷰",
		description: "구현 결과를 독립적으로 검증한다. 파일을 바꾸지 않는다.",
		preferredTier: "general",
		minContext: 128_000,
		diversityFrom: "implementer",
	},
	{
		id: "quick",
		agent: "storm-quick",
		title: "단순 작업",
		description: "이름 바꾸기, 버전 올리기, 반복 수정, 자료 모으기처럼 판단이 거의 필요 없는 일을 싸게 처리한다.",
		preferredTier: "cheap",
		minContext: 64_000,
	},
	{
		id: "architect",
		agent: "storm-architect",
		title: "설계·자문",
		description: "작업을 겹치지 않는 레인으로 나누고, 막힌 디버깅과 설계 판단을 맡는다. 파일을 바꾸지 않는다.",
		preferredTier: "premium",
		minContext: 128_000,
	},
];

/** Roles whose models a missing role's spawns borrow, nearest first (only configured, enabled ones count). */
export const ROLE_STAND_INS: Readonly<Record<RoleId, readonly RoleId[]>> = {
	explorer: ["quick", "implementer"],
	implementer: [],
	reviewer: ["architect", "implementer"],
	quick: ["implementer"],
	architect: ["reviewer", "implementer"],
};

/** omp's bundled agents and the role whose models they get during a run when they ask for an unapproved model. */
export const BUILTIN_AGENT_ROLES: Readonly<Record<string, RoleId>> = {
	scout: "explorer",
	reviewer: "reviewer",
	"security-reviewer": "reviewer",
	task: "implementer",
};

/** Roles a team cannot go without: the director never edits files, so someone must. */
export const REQUIRED_ROLES: readonly RoleId[] = ["implementer"];

/** The role a run plan's lane goes to when the director names none (falls back along `ROLE_STAND_INS`). */
export const LANE_ROLES: Readonly<Record<LaneKind, RoleId>> = {
	explore: "explorer",
	code: "implementer",
	run: "quick",
	review: "reviewer",
	design: "architect",
};

/** Worker ranges a new team starts from: explorers and quick workers fan out, the expensive roles stay narrow. */
export const DEFAULT_WORKERS: Readonly<Record<RoleId, WorkerRange>> = {
	explorer: { min: 2, max: 4 },
	implementer: { min: 1, max: 2 },
	reviewer: { min: 1, max: 2 },
	quick: { min: 1, max: 3 },
	architect: { min: 1, max: 1 },
};

/** Highest `workers.max` a config may set (parallelism shares the bound). */
export const MAX_WORKERS = 16;

/** Default context ceiling for subagents, in tokens. */
export const DEFAULT_CONTEXT_CAP = 200_000;
/** Share of a model's context window that also caps an agent: compaction gets close past it. */
export const CONTEXT_CAP_SHARE = 0.7;

/** The main session counts as heavy at run start from this many context tokens or this share of its window. */
export const PREFLIGHT_TOKENS = 150_000;
export const PREFLIGHT_SHARE = 0.5;

/** A role's worker range: a bare number n (pre-v0.8 configs) is { min: n, max: n }; absent → the role's default. */
export function workerRange(roleId: string, role: RoleConfig | undefined): WorkerRange {
	const w = role?.workers;
	if (typeof w === "number") return { min: w, max: w };
	if (w) return { min: w.min, max: w.max };
	return DEFAULT_WORKERS[roleId as RoleId] ?? { min: 1, max: 1 };
}

/** Tokens past which an agent of `roleId` takes no follow-ups: the role's or team's cap, and 70% of its window when known. */
export function contextCapFor(config: StormConfig, roleId: string | undefined, contextWindow: number | undefined): number {
	const cap = (roleId === undefined ? undefined : config.roles[roleId]?.contextCap) ?? config.contextCap ?? DEFAULT_CONTEXT_CAP;
	return contextWindow ? Math.min(cap, Math.floor(contextWindow * CONTEXT_CAP_SHARE)) : cap;
}

export const ROLE_AGENT_PREFIX = "storm-";
