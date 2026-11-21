/**
 * Storm director mode: while a Storm run is active, the main session plans, delegates and verifies; it does not
 * change working-tree files itself, the team does. Mirrors omp's plan-mode guard: internal URLs that are not files
 * (agent:// follow-ups, local:// notes, proc:// control) stay writable.
 */
import type { Block } from "../types.ts";

/** Tools that always change files. omp also reports a nested `write xd://<device>` call under the device's name. */
const EDIT_TOOLS: Record<string, true> = { edit: true, ast_edit: true };
/** Internal URLs whose `write` changes files: edits through a device, and files on SSH hosts. */
const FILE_URL_PREFIXES = ["xd://edit", "xd://ast_edit", "ssh://"];
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/** The `path` of a tool call's input when it is a string. */
export function pathOf(input: unknown): string | undefined {
	return typeof input === "object" && input !== null && "path" in input && typeof input.path === "string" ? input.path : undefined;
}

function changesFiles(toolName: string, input: unknown): boolean {
	if (EDIT_TOOLS[toolName] === true) return true;
	if (toolName !== "write") return false;
	const target = pathOf(input)?.trim() ?? "";
	// A plain path is a file on disk, inside the working tree or not.
	if (!URL_SCHEME.test(target)) return true;
	return FILE_URL_PREFIXES.some(prefix => target.startsWith(prefix));
}

/** The refusal for a file change the main session tries itself while it directs a Storm run. */
export function directorEditBlock(toolName: string, input: unknown): Block<"director-edit"> | undefined {
	if (!changesFiles(toolName, input)) return undefined;
	return {
		code: "director-edit",
		reason: "이 실행에서 감독은 파일을 직접 고치지 않습니다. 수정은 팀의 서브에이전트에 맡기고, 메모는 local:// 에 쓰세요.",
	};
}
