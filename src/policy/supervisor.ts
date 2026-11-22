/**
 * Strict supervisor policy for a main session that opted into automatic delegation.
 *
 * This is a behavior/context rule, not a security sandbox: it judges the main model's tool calls only. User shell
 * commands, host settings and tool-configuration authorization are outside it. The caller decides when it applies
 * (main versus subagent, active run, which tools the host enabled), so this module stays pure and always refuses
 * unknown tools by default, active run or not.
 *
 * Allowed: Storm's orchestration controls, delegation through `task`, the user question/todo/wait tools, and typed
 * agent or local messages. Everything else is refused, including every file tool, generic shell/eval, remote and
 * device paths, MCP tools and unknown names. A read of an agent handle is limited to its summary/artifact, a typed
 * JSON field, or an explicitly bounded line range; a transcript is not read. Malformed input fails closed.
 */
const CONTROL_TOOLS: Record<string, true> = { storm: true, task: true, ask: true, todo: true, wait: true };

/** Most lines one supervisor read of an agent handle may ask for, matching director-mode reads. */
const MAX_AGENT_READ_LINES = 400;
const MAX_JSON_PATH_SEGMENTS = 8;
const MAX_LOCAL_PATH_LENGTH = 180;
const MAX_LOCAL_PATH_SEGMENTS = 4;

const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const JSON_PATH_SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$/;
const LOCAL_PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const TOOL_NAME = /^[A-Za-z0-9_.-]{1,64}$/;

const READ_FILE_REASON =
	"감독 모드에서는 파일·원격·장치 경로를 직접 읽지 않습니다. 필요한 파일은 task 로 서브에이전트가 읽게 하고 근거 위치를 받으세요. 에이전트 결과는 read agent://<id> 산출물이나 read agent://<id>/<field> 로 확인하세요.";
const HISTORY_REASON =
	"history:// 는 에이전트 트랜스크립트라 감독 모드에서 읽지 않습니다. read agent://<id> 산출물이나 read agent://<id>/<field> 를 쓰고, 더 필요하면 task 로 요약을 맡기세요.";
const LOCAL_READ_REASON =
	"local:// 노트도 감독 모드에서는 직접 읽지 않습니다. 필요한 내용은 task 로 확인하게 하고, 새 메모는 write local://<name>.md 로 남기세요.";
const AGENT_PATH_REASON =
	"agent:// 경로가 올바르지 않습니다. agent://<id> 또는 agent://<id>/<field> 형태만 읽고, 핸들이 없으면 task 로 결과 요약을 받으세요.";
const AGENT_LIMIT_REASON = `agent:// 읽기는 한 번에 ${MAX_AGENT_READ_LINES}줄까지만 허용됩니다. agent://<id>:1-${MAX_AGENT_READ_LINES} 처럼 줄 범위를 좁히거나 agent://<id>/<field> 로 필요한 값만 읽으세요.`;
const WRITE_FILE_REASON =
	"감독 모드에서는 파일에 직접 쓰지 않습니다. 파일 변경은 task 로 구현 에이전트에 맡기고, 메모는 write local://<name>.md 로 남기세요.";
const WRITE_REMOTE_REASON =
	"감독 모드에서는 ssh://, xd://, proc://, MCP 같은 원격·장치·프로세스 경로에 쓰지 않습니다. 작업은 task 로 위임하세요.";
const AGENT_MESSAGE_REASON =
	"에이전트 메시지는 write agent://<id> 와 비어 있지 않은 content 가 필요합니다. agent://all 이나 파일 경로로 보내지 마세요.";
const LOCAL_NOTE_REASON =
	"local:// 메모는 .md 파일과 비어 있지 않은 문자열 content 가 필요합니다. 파일 변경은 task 로 맡기세요.";
const MALFORMED_READ_REASON =
	"read 입력은 path 문자열 하나여야 합니다. 파일은 읽지 말고, 에이전트 결과는 agent://<id> 또는 agent://<id>/<field> 로 확인하세요.";
const MALFORMED_WRITE_REASON =
	"write 입력은 path 와 content 문자열만 있어야 합니다. write agent://<id> 또는 write local://<name>.md 만 허용됩니다.";
const MISSING_TOOL_REASON =
	"도구 이름이 없어 감독 모드에서 막았습니다. 작업은 task 로 위임하고, 진행·질문·대기는 todo·ask·wait, 실행 제어는 storm 으로 하세요.";

interface AgentTarget {
	/** The agent id, with no JSON path or selector. */
	id: string;
	/** `agent://<id>/<field>` segments after the id. */
	field: string[];
	/** A trailing `:1-40`-style selector, if the call has one. */
	selector: string | undefined;
}

/** A path exactly as the tool received it: no surrounding whitespace, no control characters. */
function isExactPath(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 512 &&
		value.trim() === value &&
		!CONTROL_CHARS.test(value)
	);
}

function exactReadPath(input: unknown): string | undefined {
	if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
	const record = input as Record<string, unknown>;
	if (Object.keys(record).length !== 1 || !Object.hasOwn(record, "path")) return undefined;
	const path = record.path;
	return isExactPath(path) ? path : undefined;
}

function exactWriteInput(input: unknown): { path: string; content: string } | undefined {
	if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
	const record = input as Record<string, unknown>;
	if (
		Object.keys(record).length !== 2 ||
		!Object.hasOwn(record, "path") ||
		!Object.hasOwn(record, "content")
	)
		return undefined;
	const path = record.path;
	const content = record.content;
	if (!isExactPath(path) || typeof content !== "string") return undefined;
	return { path, content };
}

/**
 * Parses `agent://<id>[/<field>[/…]][:<selector>]`. Ids are ASCII and bounded; `all`, `parent`, `peers` and numeric
 * ids are refused because the host treats them as broadcast, parent or cross-instance addresses. A JSON path and a
 * line selector cannot be combined (the host refuses that too). Existence, ownership and run membership are the
 * caller's verification; this grammar only decides which kinds of handle/path the policy can trust.
 */
function parseAgentTarget(rest: string): AgentTarget | undefined {
	if (rest.length === 0) return undefined;
	const colon = rest.indexOf(":");
	const selector = colon < 0 ? undefined : rest.slice(colon + 1);
	const base = colon < 0 ? rest : rest.slice(0, colon);
	if (selector !== undefined && (selector.length === 0 || selector.includes(":"))) return undefined;
	const parts = base.split("/");
	if (parts.length === 0 || parts.some(part => part.length === 0)) return undefined;
	const id = parts[0];
	if (!AGENT_ID.test(id)) return undefined;
	const lower = id.toLowerCase();
	if (lower === "all" || lower === "parent" || lower === "peers" || /^\d+$/.test(id)) return undefined;
	const field = parts.slice(1);
	if (field.length > MAX_JSON_PATH_SEGMENTS || !field.every(part => JSON_PATH_SEGMENT.test(part))) return undefined;
	return { id, field, selector };
}

/** A selector is bounded when every range is finite and the total is at most one director page. */
function boundedLineSelector(selector: string): boolean {
	if (selector.length === 0 || selector.length > 200) return false;
	let lines = 0;
	for (const part of selector.split(",")) {
		let count: number;
		const single = /^(\d+)$/.exec(part);
		const range = /^(\d+)-(\d+)$/.exec(part);
		const span = /^(\d+)\+(\d+)$/.exec(part);
		const tail = /^-(\d+)$/.exec(part);
		if (single) {
			const line = Number(single[1]);
			if (!Number.isSafeInteger(line) || line < 1) return false;
			count = 1;
		} else if (range) {
			const start = Number(range[1]);
			const end = Number(range[2]);
			if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) return false;
			count = end - start + 1;
		} else if (span) {
			const start = Number(span[1]);
			const amount = Number(span[2]);
			if (!Number.isSafeInteger(start) || !Number.isSafeInteger(amount) || start < 1 || amount < 1) return false;
			count = amount;
		} else if (tail) {
			const amount = Number(tail[1]);
			if (!Number.isSafeInteger(amount) || amount < 1) return false;
			count = amount;
		} else return false;
		lines += count;
		if (lines > MAX_AGENT_READ_LINES) return false;
	}
	return lines > 0;
}

/**
 * Reads are allowed only from an agent handle: the bare handle is the published summary/artifact (one omp page), a
 * JSON path extracts one value, and a line selector is allowed up to one director page. Transcripts, local notes and
 * every other path are refused.
 */
function readBlock(input: unknown): string | undefined {
	const path = exactReadPath(input);
	if (path === undefined) return MALFORMED_READ_REASON;
	if (path.startsWith("agent://")) {
		const target = parseAgentTarget(path.slice("agent://".length));
		if (target === undefined) return AGENT_PATH_REASON;
		if (target.field.length > 0 && target.selector !== undefined) return AGENT_PATH_REASON;
		if (target.selector !== undefined && !boundedLineSelector(target.selector)) return AGENT_LIMIT_REASON;
		return undefined;
	}
	if (path.startsWith("history://")) return HISTORY_REASON;
	if (path.startsWith("local://")) return LOCAL_READ_REASON;
	return READ_FILE_REASON;
}

function writeBlock(input: unknown): string | undefined {
	const parsed = exactWriteInput(input);
	if (parsed === undefined) return MALFORMED_WRITE_REASON;
	if (parsed.path.startsWith("agent://")) {
		const target = parseAgentTarget(parsed.path.slice("agent://".length));
		if (target === undefined || target.field.length > 0 || target.selector !== undefined) return AGENT_MESSAGE_REASON;
		return parsed.content.trim() === "" ? AGENT_MESSAGE_REASON : undefined;
	}
	if (parsed.path.startsWith("local://")) {
		const rest = parsed.path.slice("local://".length);
		const segments = rest.split("/");
		const last = segments.at(-1);
		const valid =
			rest.length > 0 &&
			rest.length <= MAX_LOCAL_PATH_LENGTH &&
			segments.length <= MAX_LOCAL_PATH_SEGMENTS &&
			segments.every(segment => LOCAL_PATH_SEGMENT.test(segment)) &&
			last !== undefined &&
			/\.md$/i.test(last);
		if (!valid) return LOCAL_NOTE_REASON;
		return undefined;
	}
	if (
		parsed.path.startsWith("ssh://") ||
		parsed.path.startsWith("xd://") ||
		parsed.path.startsWith("proc://") ||
		parsed.path.startsWith("mcp://")
	) {
		return WRITE_REMOTE_REASON;
	}
	return WRITE_FILE_REASON;
}

/**
 * The refusal for a main-session tool call under automatic supervision, or undefined to let it run. Exact tool
 * names only: no prefix matching, no prototype names, no fallback for malformed input. `storm`, `task`, `ask`,
 * `todo` and `wait` are controls; `read` and `write` are admitted only for the typed agent/local paths above.
 */
export function supervisorToolBlock(toolName: string, input: unknown): string | undefined {
	if (typeof toolName !== "string" || toolName.length === 0) return MISSING_TOOL_REASON;
	if (Object.hasOwn(CONTROL_TOOLS, toolName)) return undefined;
	if (toolName === "read") return readBlock(input);
	if (toolName === "write") return writeBlock(input);
	const shown = TOOL_NAME.test(toolName) ? toolName : "알 수 없는";
	return `${shown} 도구는 감독 모드에서 허용되지 않습니다. 작업은 task 로 위임하고, 진행·질문·대기는 todo·ask·wait, 실행 제어는 storm 으로 하세요.`;
}
