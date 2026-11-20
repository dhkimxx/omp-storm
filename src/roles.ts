import type { RoleId, RoleSpec } from "./types.ts";

export const STORM_VERSION = "0.7.1";

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

export const ROLE_AGENT_PREFIX = "storm-";
