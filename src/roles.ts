import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { LaneKind, RoleConfig, RoleId, RoleSpec, WorkerRange } from "./types.ts";

/** This plugin's package.json: the one source of the version, and after `omp plugin install` the place a newer one shows up. */
export const PACKAGE_JSON = fileURLToPath(new URL("../package.json", import.meta.url));

function packageVersion(): string {
	const pkg: unknown = JSON.parse(readFileSync(PACKAGE_JSON, "utf8"));
	if (typeof pkg === "object" && pkg !== null && "version" in pkg && typeof pkg.version === "string") return pkg.version;
	throw new Error(`${PACKAGE_JSON}: version is missing`);
}

/** The version this process loaded. */
export const STORM_VERSION = packageVersion();

/** Smallest context window a model needs to fill any role: one floor, since every role starts at 19k–40k tokens. */
const MIN_CONTEXT = 128_000;

/** Roles Storm ships. Each maps to an agent definition in agents/. */
export const ROLES: readonly RoleSpec[] = [
	{
		id: "explorer",
		agent: "storm-explorer",
		title: "탐색",
		description: "코드·문서를 읽고 범위와 근거를 모아 요약한다. 파일을 바꾸지 않는다.",
		preferredTier: "cheap",
		minContext: MIN_CONTEXT,
	},
	{
		id: "implementer",
		agent: "storm-implementer",
		title: "구현",
		description: "맡은 범위의 코드를 고치고 검증한다.",
		preferredTier: "general",
		minContext: MIN_CONTEXT,
	},
	{
		id: "reviewer",
		agent: "storm-reviewer",
		title: "리뷰",
		description: "구현 결과를 독립적으로 검증한다. 파일을 바꾸지 않는다.",
		preferredTier: "general",
		minContext: MIN_CONTEXT,
		diversityFrom: "implementer",
	},
	{
		id: "quick",
		agent: "storm-quick",
		title: "단순 작업",
		description: "이름 바꾸기, 버전 올리기, 반복 수정, 자료 모으기처럼 판단이 거의 필요 없는 일을 싸게 처리한다.",
		preferredTier: "cheap",
		minContext: MIN_CONTEXT,
	},
	{
		id: "architect",
		agent: "storm-architect",
		title: "설계·자문",
		description: "작업을 겹치지 않는 레인으로 나누고, 막힌 디버깅과 설계 판단을 맡는다. 파일을 바꾸지 않는다.",
		preferredTier: "premium",
		minContext: MIN_CONTEXT,
	},
];

/** A role's Korean title for user-facing text; an unknown id is shown as is. */
export function roleTitle(id: string): string {
	return ROLES.find(role => role.id === id)?.title ?? id;
}

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

/**
 * Worker ranges a new team starts from: explorers and quick workers fan out, the expensive roles stay narrow.
 * `min` is the setup suggestion, never a spawn floor: a plan that omits its worker count uses its actual worker
 * lanes (at least one, never past `max`). `max` is the role's approved concurrency ceiling.
 */
export const DEFAULT_WORKERS: Readonly<Record<RoleId, WorkerRange>> = {
	explorer: { min: 1, max: 4 },
	implementer: { min: 1, max: 4 },
	reviewer: { min: 1, max: 2 },
	quick: { min: 1, max: 3 },
	architect: { min: 1, max: 1 },
};

/** Highest `workers.max` a config may set. */
export const MAX_WORKERS = 16;

/**
 * Share of the main session's model window at which Storm compacts the director: at run start, and mid-run while it
 * waits on subagents (omp's own compaction gets close past the mid-run share). Only a share: a fixed token count
 * fits one window and not another.
 */
export const RUN_START_WINDOW_SHARE = 0.5;
export const MID_RUN_WINDOW_SHARE = 0.7;

/** Tokens at `share` of the window; undefined when the window is unknown, and Storm then starts no compaction. */
export function windowThreshold(share: number, contextWindow: number | undefined): number | undefined {
	return contextWindow !== undefined && contextWindow > 0 ? Math.floor(contextWindow * share) : undefined;
}

/** A role's worker range: a bare number n (pre-v0.8 configs) is { min: n, max: n }; absent → the role's default. */
export function workerRange(roleId: string, role: RoleConfig | undefined): WorkerRange {
	const w = role?.workers;
	if (typeof w === "number") return { min: w, max: w };
	if (w) return { min: w.min, max: w.max };
	return DEFAULT_WORKERS[roleId as RoleId] ?? { min: 1, max: 1 };
}

export const ROLE_AGENT_PREFIX = "storm-";
