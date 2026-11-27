/**
 * Calls that can change the shared work tree without naming a path, and the one way omp starts a process that outlives
 * its call: a service (`bash` with a `name`). Pure; the extension gathers the inputs and applies the answers.
 *
 * Two guarantees hold here. A command nobody can bound must not run beside another writer of the tree (G1), so the
 * director's own commands go through the same table as the workers' write reservations. And a process that omp keeps in
 * its daemon after the call is not one of the session's jobs and is not in the host's job rows: nothing can say when it
 * ends, so a writer that is ordered against others, and the director during a run, may not start one.
 */
import { pathWriteTool, readOnlyTool } from "./capability.ts";
import { CONTROL_TOOL_NAMES, isPlanProposal, lspReadsOnly } from "./supervisor.ts";

const CONTROL_TOOLS: ReadonlySet<string> = new Set(CONTROL_TOOL_NAMES);

/**
 * Whether the director's tool call can write the shared tree without naming where: a shell command, an `lsp` action that
 * edits or runs a build, omp's checkpoint or rewind tool, an MCP or any unknown tool. Reads and searches, path edits (the
 * director-edit rule decides those), Storm's own control tools and messages to agents do not. `planMode`: omp's plan mode is on,
 * so `bash propose <slug>` is its plan submission and no command (see `isPlanProposal`).
 */
export function directorNeedsTree(toolName: string, input: unknown, planMode = false): boolean {
	if (readOnlyTool(toolName) || pathWriteTool(toolName) || CONTROL_TOOLS.has(toolName) || (planMode && isPlanProposal(toolName, input))) return false;
	if (toolName === "lsp") return !lspReadsOnly(input);
	return true;
}

/**
 * Whether a `bash` call asks omp for a service: a non-blank `name`. omp reads the name trimmed, so a blank one is no
 * service. Only `bash` starts one.
 */
export function startsService(toolName: string, input: unknown): boolean {
	if (toolName !== "bash" || typeof input !== "object" || input === null) return false;
	const name = (input as { name?: unknown }).name;
	return typeof name === "string" && name.trim() !== "";
}

/** The refusal of a managed worker ordered like a writer that asks for a service. Names the guarantee and the way on. */
export const WORKER_SERVICE_REASON =
	"서비스(bash의 name 인자)는 omp 데몬이 이 워커의 턴과 따로 계속 실행하고 세션의 작업 목록에도 나타나지 않아, 워커가 끝난 뒤에도 파일을 계속 쓸 수 있습니다. 쓰기 순서를 보장할 수 없어 이 레인에서는 시작하지 않습니다. 명령은 name 없이 포그라운드로 실행해 끝날 때까지 기다리고(서버를 띄워 확인하는 일이면 짧은 명령 안에서 시작·확인·종료하세요), 서비스가 꼭 필요하면 감독에게 알리세요.";

/** The refusal of the director during a run that asks for a service. */
export const DIRECTOR_SERVICE_REASON =
	"서비스(bash의 name 인자)는 omp 데몬이 호출과 따로 계속 실행하고 세션의 작업 목록에도 나타나지 않아, 끝났는지 알 수 없는 채로 워커와 같은 작업 트리를 쓰게 됩니다. 실행 중에는 감독이 시작하지 않습니다. 명령은 name 없이 실행하거나 task로 워커에 맡기세요.";

/** The refusal of the director changing a worker's model or effort through its control paths. */
export const DIRECTOR_CONTROL_REASON =
	"에이전트의 모델과 추론 강도는 사용자가 승인한 팀 설정이라 감독이 바꾸지 않습니다. 워커가 지금 모델로 맡은 일을 하게 두고, 더 나은 모델이 필요하면 사용자에게 팀 설정을 바꿔 달라고 하세요.";
