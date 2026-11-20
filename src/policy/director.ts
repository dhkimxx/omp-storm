/**
 * Storm director mode: while a Storm run is active, the main session plans, delegates and verifies; it does not
 * change working-tree files itself, storm-implementer does. Mirrors omp's plan-mode guard: internal URLs that are
 * not files (agent:// follow-ups, local:// notes, proc:// control) stay writable.
 */

/** Tools that always change files. omp also reports a nested `write xd://<device>` call under the device's name. */
const EDIT_TOOLS: Record<string, true> = { edit: true, ast_edit: true };
/** Internal URLs whose `write` changes files: edits through a device, and files on SSH hosts. */
const FILE_URL_PREFIXES = ["xd://edit", "xd://ast_edit", "ssh://"];
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

export const DIRECTOR_BLOCK_REASON =
	"Storm 감독 모드: 이 실행에서 메인은 작업 트리 파일을 직접 고치지 않습니다. 수정은 storm-implementer에 맡기고(같은 영역 후속 지시는 write agent://<id>), 메모는 local:// 에 쓰세요.";

/** Whether the main session must not run this tool call while it directs a Storm run. */
export function directorBlocks(toolName: string, input: unknown): boolean {
	if (EDIT_TOOLS[toolName] === true) return true;
	if (toolName !== "write") return false;
	const target =
		typeof input === "object" && input !== null && "path" in input && typeof input.path === "string" ? input.path.trim() : "";
	// A plain path is a file on disk, inside the working tree or not.
	if (!URL_SCHEME.test(target)) return true;
	return FILE_URL_PREFIXES.some(prefix => target.startsWith(prefix));
}
