/**
 * Storm director mode: while a Storm run is active, the main session plans, delegates and verifies; it does not
 * change working-tree files itself, the team does. Mirrors omp's plan-mode guard: internal URLs that are not files
 * (agent:// follow-ups, local:// notes, proc:// control) stay writable.
 */
import type { Block } from "../types.ts";

/** Tools that always change files. omp also reports a nested `write xd://<device>` call under the device's name. */
const EDIT_TOOLS: Record<string, true> = { edit: true, ast_edit: true };
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

/** Whether a tool call would change a working-tree file: `edit`, `ast_edit`, or `write` to a file path. */
export function changesFiles(toolName: string, input: unknown): boolean {
	if (EDIT_TOOLS[toolName] === true) return true;
	if (toolName !== "write") return false;
	const target = pathOf(input)?.trim() ?? "";
	// A plain path is a file on disk, inside the working tree or not.
	if (!URL_SCHEME.test(target)) return true;
	const lower = target.toLowerCase();
	return FILE_URL_PREFIXES.some(prefix => lower.startsWith(prefix));
}

/** The refusal for a file change the main session tries itself while it directs a Storm run. */
export function directorEditBlock(toolName: string, input: unknown): Block<"director-edit"> | undefined {
	if (!changesFiles(toolName, input)) return undefined;
	return {
		code: "director-edit",
		reason: "감독이 고친 파일은 어느 레인의 결과도 아니고 쓰는 워커와 순서가 보장되지 않아 막습니다. 수정은 팀의 서브에이전트에 맡기고, 메모는 local:// 에 쓰세요.",
	};
}
