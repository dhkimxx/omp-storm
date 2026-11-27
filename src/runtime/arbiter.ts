/**
 * The pure part of the run's write table: what a refusal says about the holder that caused it, and which director tool calls a
 * turn's or an agent's end proves are over. The table itself (`RunLanes` in lanes.ts) decides who conflicts; nothing here yields,
 * reads a clock or touches state.
 */
import { withJosa } from "../josa.ts";
import { pathWriteTool } from "../policy/capability.ts";
import type { Block, HolderKind } from "../types.ts";

/**
 * The noun phrase a worker's, a job's or a check's refusal names when a director path edit is what holds the files. It ends in a
 * fixed Korean noun so every particle after it is right whatever precedes it.
 */
export const DIRECTOR_EDITING = "감독이 직접 고치는 파일";

/** Lead of the refusal a director path edit gets when another writer holds the tree; the holder follows after a colon. */
export const DIRECTOR_WRITE_LEAD = "같은 트리에 쓰는 작업이 실행 중이라 감독의 편집을 하지 않았습니다";
/** The refusal when the run is already ending or is no longer this session's. */
export const DIRECTOR_WRITE_ENDING = "실행이 끝나는 중이라 편집하지 않았습니다.";
/** The refusal when the host's own limit for the hook was reached before the entry could be made. */
export const DIRECTOR_WRITE_LATE = "확인이 늦어져 편집하지 않았습니다. 같은 편집을 다시 하세요.";
/** The refusal when the host gave the call no id: the hold is keyed by it and only the end of its message can release it. */
export const DIRECTOR_WRITE_NO_CALL = "호출 id를 확인하지 못해 편집하지 않았습니다. 같은 편집을 다시 하세요.";
/** The refusal when the conversation changed while the call waited for the lease or for a worker's authority to be withdrawn. */
export const DIRECTOR_WRITE_MOVED = "대화가 바뀌어 이 편집을 적용하지 않았습니다. 새 대화에서 다시 시도하세요.";
/** The refusal when the call names no path Storm could bound. */
export const DIRECTOR_WRITE_NO_TARGET = "대상 경로를 확인할 수 없어 편집하지 않았습니다.";

/**
 * What the user is told when a run that is ending still waits for the director's own path edit: the host gives no receipt for it
 * after a switch of conversation (nothing of the old loop reaches an extension), so only the next completed assistant message of
 * the director, or a restart of omp, ends the wait. Said by the drain warning in place of its generic sentence.
 */
export const DIRECTOR_DRAIN_WARNING =
	"Storm 실행이 감독 자신의 파일 편집 호출이 끝나기를 기다립니다. 그 편집을 한 메시지에서 호출이 거절·실패·중단됐거나, 대화가 바뀐 뒤에는 호출의 끝 신호가 오지 않아, 감독의 다음 답변이 끝날 때까지(또는 omp를 다시 시작할 때까지) 실행 범위·잠금·회계를 유지한 채 기다립니다.";

/** The director's notice when another extension rewrote an edit's arguments after Storm's hook: the call writes more than Storm was shown. */
export const DIRECTOR_REWRITTEN =
	"다른 확장이 감독의 편집 호출 인자를 Storm이 확인한 뒤에 바꿔, 호출이 확인한 것과 다른 파일을 씁니다. Storm은 실제로 쓰는 파일을 그 메시지가 끝날 때까지 함께 잠갔습니다. 그 파일을 이미 다른 워커가 쓰고 있었다면 막지 못했습니다. 결과를 확인하세요.";

/** What the director is told to do when a worker (rather than a job, a check or a command) holds the tree. */
const WORKER_WAIT = "워커를 기다리는 중이면 턴을 끝내세요. 쓰기 자리가 비면 알림이 옵니다.";
const HOST_WAIT = "정형 작업과 검사는 Storm이 끝냅니다.";

/** The part of a write table entry a refusal reads. */
export interface HolderView {
	/** Absent for a worker. */
	kind?: HolderKind;
	lane?: string;
	/** The host id of the worker; absent while the placement has not been correlated to a spawn. */
	agentId?: string;
	/** A follow-up was admitted and its turn has not started. */
	awaiting?: boolean;
}

/** The holder as the director reads it: `'X' 레인 워커`, `정형 작업`, `감독의 셸 명령`... */
export function holderPhrase(view: HolderView): string {
	switch (view.kind) {
		case "job":
			return "정형 작업";
		case "check":
			return "필수 검사";
		case "fence":
			return "종료가 확인되지 않은 정형 작업";
		case "director-exec":
		case "director-bg":
			return "감독의 셸 명령";
		case "director-path":
			return DIRECTOR_EDITING;
		default: {
			const lane = view.lane === undefined ? "계획에 없는 워커" : `'${view.lane}' 레인`;
			if (view.awaiting === true) return `${lane} 후속 작업(시작 전)`;
			if (view.agentId === undefined) return `${lane} 배치(시작 전)`;
			return view.lane === undefined ? lane : `${lane} 워커`;
		}
	}
}

/** What a refusal of a director path edit tells the director to do next, by who holds the tree. */
function waitFor(view: HolderView): string {
	switch (view.kind) {
		case "job":
		case "check":
		case "fence":
			return HOST_WAIT;
		case "director-exec":
		case "director-bg":
		case "director-path":
			return "";
		default:
			return WORKER_WAIT;
	}
}

/** The refusal of a director path edit that meets a writer already holding the tree (no `[storm:director-write]` tag: see `directorWriteBlock`). */
export function directorWriteConflict(view: HolderView): string {
	const next = waitFor(view);
	return `${DIRECTOR_WRITE_LEAD}: ${holderPhrase(view)}. 그 작업이 끝난 뒤 다시 하세요.${next === "" ? "" : ` ${next}`}`;
}

/** A refused director commit as the block the tool-call hook returns. */
export function directorWriteBlock(reason: string): Block<"director-write"> {
	return { code: "director-write", reason };
}

/**
 * What a worker's, a job's or a check's refusal says when the files it wanted are held by the director's own path edit: the
 * director is editing files itself, and that hold ends with the message that made the call, not with a worker's end.
 * `next` is what the caller may do afterwards, in its own words. It names failure too: a call can end in an error while its
 * file was still changed, and the same message's hooks run before its `message_end`, so the retry waits for the next answer
 * to finish, not just the next message.
 */
export const DIRECTOR_EDIT_ENDS = "감독의 편집은 그 편집을 한 메시지의 호출이 모두 잘 끝나면 풀립니다. 호출 하나라도 거절·실패·중단됐으면 감독의 다음 답변이 끝날 때 풀립니다.";

/** The refusal of something Storm starts (a job, a check, a command of the director) while the director is editing files. */
export function directorEditWait(what: string): string {
	return `감독이 파일을 직접 고치는 중이라 ${withJosa(what, "을/를")} 시작하지 않았습니다. ${DIRECTOR_EDIT_ENDS} 그 뒤에 다시 시도하세요.`;
}

/** The refusal of a worker placement or follow-up that meets the director's path edit: what the retry waits for. */
export const DIRECTOR_EDIT_RETRY = `${DIRECTOR_EDIT_ENDS} 같은 메시지에서 곧바로 다시 보내면 그 답변의 호출 검사가 끝나기 전이라 아직 잠겨 있으니, 다음 답변이 끝난 뒤에 같은 호출을 다시 보내세요.`;

interface ContentBlock {
	type?: unknown;
	id?: unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** The tool call ids one agent message carries (an assistant message's `toolCall` blocks, or a tool result's own id). */
function messageCallIds(message: unknown, into: Set<string>): void {
	if (!isObject(message)) return;
	if (message.role === "toolResult" && typeof message.toolCallId === "string") into.add(message.toolCallId);
	const content = message.content;
	if (!Array.isArray(content)) return;
	for (const block of content as ContentBlock[]) {
		if (isObject(block) && block.type === "toolCall" && typeof block.id === "string") into.add(block.id);
	}
}

/**
 * The tool call ids a `turn_end` or an `agent_end` event proves finished: the calls of the turn's assistant message and its
 * tool results, or every call in the messages of the agent's run. The caller passes the event's own payload, so an old loop's
 * late end can only name the calls of its own turns. An unreadable payload names nothing, and nothing is released.
 */
export function directorCallIds(event: unknown): ReadonlySet<string> {
	const ids = new Set<string>();
	if (!isObject(event)) return ids;
	messageCallIds(event.message, ids);
	if (Array.isArray(event.toolResults)) for (const result of event.toolResults) messageCallIds(result, ids);
	if (Array.isArray(event.messages)) for (const message of event.messages) messageCallIds(message, ids);
	return ids;
}

/**
 * Whether every file-writing call of one assistant message (a path tool: `edit`, `write`, `ast_edit`...) ended without an error, read
 * from a `turn_end` event's own payload: the message's tool calls and the turn's tool results. A call whose result is missing, or
 * is not plainly `isError: false`, is an error (a refused or blocked call, a failure, an abort): the turn is then not clean. A
 * message with no path call, or an unreadable payload with none to find, is clean for the calls it names; the caller releases only
 * ids the event names, so an unreadable payload releases nothing.
 */
export function directorTurnClean(event: unknown): boolean {
	if (!isObject(event) || !isObject(event.message)) return false;
	const content = event.message.content;
	if (!Array.isArray(content)) return false;
	const results = new Map<string, boolean>();
	if (Array.isArray(event.toolResults)) {
		for (const result of event.toolResults) {
			if (isObject(result) && typeof result.toolCallId === "string") results.set(result.toolCallId, result.isError === false);
		}
	}
	for (const block of content as Array<ContentBlock & { name?: unknown }>) {
		if (!isObject(block) || block.type !== "toolCall" || typeof block.id !== "string" || typeof block.name !== "string") continue;
		if (!pathWriteTool(block.name)) continue;
		if (results.get(block.id) !== true) return false;
	}
	return true;
}

/**
 * Whether an assistant message is one whose request completed: its stop reason is neither `aborted` nor `error`. The loop makes
 * another request only after the tool batch of the message before it is over, so such a message proves every call of the earlier
 * messages has ended. Other roles are never one.
 */
export function completedAssistantMessage(message: unknown): boolean {
	if (!isAssistantMessage(message)) return false;
	return message.stopReason !== "aborted" && message.stopReason !== "error";
}

/** Whether a message is the assistant's (whatever it ended with). */
export function isAssistantMessage(message: unknown): message is Record<string, unknown> {
	return isObject(message) && message.role === "assistant";
}
