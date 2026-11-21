/**
 * Storm's doc-code consistency rules for the project a Storm run works on (team setting `docs`, default on).
 * Code and observed behavior are the facts; docs hold decisions, rationale, usage and results and point to code
 * instead of copying its state. Role agents get the rules as a system-prompt section, the director in the handoff.
 */
import type { StormConfig } from "../types.ts";

/** Whether the team keeps the doc rules and the reviewer's doc check: absent means on. */
export function docsEnabled(config: Pick<StormConfig, "docs">): boolean {
	return config.docs !== false;
}

const FACTS =
	"Code and observed behavior (tests, runs) are the facts. Docs hold decisions, rationale, usage and results, and point to code locations (`path:line`, symbol names) instead of copying code state: constants, file or function lists, fields, step sequences, progress status.";
const PROGRESS = "Progress lives in the Storm run record and `local://` notes, never in repo docs.";

/** Role ids whose agents do not modify files; they report doc problems instead of fixing them. */
const READ_ONLY_ROLES: Record<string, true> = { explorer: true, architect: true };

/**
 * The system-prompt section a Storm role agent gets when docs are on, or `undefined` when they are off or `role` is
 * not given. `role` is a Storm role id (`reviewer`) or its agent name (`storm-reviewer`).
 */
export function docPromptFor(role: string | undefined, config: Pick<StormConfig, "docs">): string | undefined {
	if (role === undefined || !docsEnabled(config)) return undefined;
	const id = role.replace(/^storm-/, "");
	const lines = ["## Storm doc rules", `- ${FACTS}`];
	if (id === "reviewer") {
		lines.push(
			"- Also review the docs: report docs that contradict the reviewed change as findings with `kind: \"doc_conflict\"`, and doc passages that copy code state as findings with `kind: \"doc_copy\"`. Give code findings `kind: \"code\"`. Cite the doc's `file_path` and lines like any finding.",
		);
	} else if (READ_ONLY_ROLES[id] === true) {
		lines.push(
			"- When a doc and the code disagree, check the facts and report which side is wrong with both locations; do not trust the doc over the code.",
		);
	} else {
		lines.push(
			"- When you change code, fix the docs that mention it in the same lane.",
			"- When a doc and the code disagree, check the facts and fix the wrong side: a wrong doc gets fixed; code that contradicts a current decision gets fixed, or returned to the director when the fix is outside your assignment.",
		);
	}
	lines.push(`- ${PROGRESS}`);
	return lines.join("\n");
}

/** Korean rule lines for the director's run handoff when docs are on; empty when off. */
export function docContractLines(config: Pick<StormConfig, "docs">): string[] {
	if (!docsEnabled(config)) return [];
	return [
		"- 문서 정합: 사실의 기준은 코드와 실제 동작(테스트, 실행 결과)입니다. 문서에는 결정·이유·사용법·결과만 쓰고, 코드 현황(상수, 파일·함수 목록, 필드, 단계 순서, 진행 상태)은 옮겨 적지 않고 위치만 가리킵니다.",
		"- 코드를 바꾸는 레인에 그 코드를 언급하는 문서도 같이 맞추게 합니다. 문서와 코드가 어긋나면 사실을 확인해 틀린 쪽을 고칩니다. 문서가 틀리면 문서를, 코드가 지금 유효한 결정과 다르면 코드를 고칩니다.",
		"- storm-reviewer 의 문서 지적(doc_conflict·doc_copy)도 코드 지적처럼 처리합니다. 진행 상황은 실행 기록과 local:// 에 두고 저장소 문서에 쓰지 않습니다.",
	];
}
