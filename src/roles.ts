import type { RoleSpec } from "./types.ts";

export const STORM_VERSION = "0.2.0";

/** Roles shipped in v0.1. Each maps to an agent definition in agents/. */
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
];

export const ROLE_AGENT_PREFIX = "storm-";
