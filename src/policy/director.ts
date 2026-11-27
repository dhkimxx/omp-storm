/**
 * Storm director mode: while a Storm run is active, the main session plans, delegates and verifies. It may change a
 * project file itself only with a path tool whose exact targets Storm can name (`directorEditDecision`), because the run's
 * write table orders writers by the files they hold; a file change Storm cannot name is refused with its cause. Mirrors
 * omp's plan-mode guard: internal URLs that are not files (agent:// follow-ups, local:// notes, proc:// control) stay
 * writable.
 */
import type { Block } from "../types.ts";
import { pathWriteTool } from "./capability.ts";
import { directorTargets, type TargetCause, type TargetEnv } from "./director-targets.ts";

/**
 * Internal URLs whose `write` changes files, matched without case (omp reads the scheme without case): edits through a
 * device, files on SSH hosts, and every scheme omp 19.2.1 gives a file-writing handler in the workspace without a prompt
 * to the user: `conflict://<n>` splices its replacement into the tracked file that holds the conflict block
 * (`internal-urls/conflict-protocol.ts`, scope `workspace`, tier `write`) and `vault://` writes a file of the vault the host
 * resolves, which may be the project (`vault-protocol.ts`, scope `workspace`, `via: "file"`). Not in the list, and why:
 * `cfg://` changes omp settings and asks the user first, `proc://` kills a background job, `local://` is the session's
 * sandbox, `agent://` and `out://` carry messages, and every other scheme omp registers rejects a write.
 */
const FILE_URL_PREFIXES = ["xd://edit", "xd://ast_edit", "ssh://", "conflict://", "vault://"];
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/** The `path` of a tool call's input when it is a string. */
export function pathOf(input: unknown): string | undefined {
	return typeof input === "object" && input !== null && "path" in input && typeof input.path === "string" ? input.path : undefined;
}

/**
 * How a tool call changes files, when it does (the director's, and a worker's for the review gate). `path`: a path tool (`edit`, `ast_edit`, `write` to a plain path,
 * or another tool of `PATH_WRITE_TOOLS`); the table can order it once `directorTargets` names the files. `address`: a
 * `write` to an address that lands in the work tree or on another host (`ssh://`, `xd://`, `conflict://`, `vault://`):
 * a file change with no path to name, so it stays refused. Undefined: no file change (messages, scratch notes, reads,
 * commands, which other rules judge).
 */
export function directorFileChange(toolName: string, input: unknown): "path" | "address" | undefined {
	if (toolName !== "write") return pathWriteTool(toolName) ? "path" : undefined;
	const target = pathOf(input)?.trim() ?? "";
	if (!URL_SCHEME.test(target)) return "path";
	const lower = target.toLowerCase();
	return FILE_URL_PREFIXES.some(prefix => lower.startsWith(prefix)) ? "address" : undefined;
}

/** The lead of every refusal of a director path call that cannot be ordered; tests and the wiring import it instead of quoting. */
export const DIRECTOR_EDIT_LEAD = "실행 중 감독은 대상 파일을 정확히 알 수 있는 경로 편집만 직접 할 수 있습니다";

/** What each cause says and what the director can do next. `outside` names the path, so it is a function. */
export const DIRECTOR_EDIT_CAUSES = {
	unknown: "대상 경로를 확인할 수 없음. 파일 경로 하나를 정확히 적어(주소, 선택자, ~, 한 항목에 여러 경로를 넣지 말고) 다시 호출하거나 task로 워커에 맡기세요",
	outside: (target: string): string => `작업 트리 밖 경로(${shownPath(target)}). 프로젝트 안의 파일만 직접 고칠 수 있으니 task로 워커에 맡기세요`,
	internal: ".git이나 .omp 아래 경로. 이 폴더는 git과 omp의 상태라 직접 고치지 않습니다",
	dispatched: "다른 도구가 대신 실행한 편집. edit/write를 eval 안이 아니라 직접 호출하세요",
	address: "프로젝트 경로가 아닌 주소(ssh://, xd://, conflict://, vault:// 등). 파일 변경은 task로 워커에 맡기고, 메모는 local:// 에 쓰세요",
} as const;

/** A path as it is shown in a refusal: one line, bounded. */
function shownPath(target: string): string {
	const clean = target.replace(/[\u0000-\u001f\u007f]/gu, " ");
	return clean.length > 120 ? `${clean.slice(0, 117)}...` : clean;
}

/** The refusal of a director path call whose files cannot be named, by cause. */
export function directorEditRefusal(cause: TargetCause, target?: string): Block<"director-edit"> {
	const text = cause === "outside" ? DIRECTOR_EDIT_CAUSES.outside(target ?? "") : DIRECTOR_EDIT_CAUSES[cause];
	return { code: "director-edit", reason: `${DIRECTOR_EDIT_LEAD}: ${text}.` };
}

/**
 * What the extension does with one director tool call during a run. `none`: not a file change, other rules decide.
 * `path`: a path call whose targets are exactly `paths`; the caller commits them to the run's write table and lets the
 * call run, or refuses it when the table does. `refuse`: a file change Storm cannot name or does not open.
 */
export type DirectorEditDecision =
	| { kind: "none" }
	| { kind: "path"; paths: string[] }
	| { kind: "refuse"; block: Block<"director-edit"> };

export function directorEditDecision(toolName: string, input: unknown, env: TargetEnv): DirectorEditDecision {
	const change = directorFileChange(toolName, input);
	if (change === undefined) return { kind: "none" };
	if (change === "address") return { kind: "refuse", block: directorEditRefusal("address") };
	const targets = directorTargets(toolName, input, env);
	return targets.ok ? { kind: "path", paths: targets.paths } : { kind: "refuse", block: directorEditRefusal(targets.cause, targets.path) };
}
