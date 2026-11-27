/**
 * Strict supervisor policy for a main session that opted into automatic delegation.
 *
 * This is a behavior/context rule, not a security sandbox: it judges the main model's tool calls only. User shell
 * commands, host settings and tool-configuration authorization are outside it. The caller decides when it applies
 * (main versus subagent, active run, which tools the host enabled), so this module stays pure and always refuses
 * unknown tools by default, active run or not.
 *
 * Allowed: Storm's orchestration controls, delegation through `task`, the user question/todo/wait tools, omp's own
 * plan-mode exit (`propose`), every tool that only reads or searches (the worker gate's `READ_ONLY_TOOLS`, plus the
 * reading actions of `lsp`), reads of project files, web pages, `agent://` handles, `local://` notes, `skill://`,
 * `rule://`, `help://` and the transcripts (`history://`) of this run's own agents, and typed messages
 * (`write agent://<id>` with or without `?progress`, `write local://<name>.md`).
 * Refused, each with its cause: editing or writing project files, shell and eval, MCP and unknown tools, and any read
 * that is not a plain read (a remote host, another omp instance, another session's transcripts, a path that starts
 * a process). Context size is never a cause here: Storm compacts instead of refusing. Malformed input fails closed.
 */
import { type AgentAddress, agentAddress, handleAddress } from "./agent-address.ts";
import { PATH_WRITE_TOOLS, READ_ONLY_TOOLS } from "./capability.ts";

/** Tools that orchestrate the run or talk to the user; `propose` leaves omp's own plan mode and nothing else. */
export const CONTROL_TOOL_NAMES = ["storm", "task", "ask", "todo", "wait", "propose"] as const;
const CONTROL_TOOLS: Record<string, true> = Object.fromEntries(CONTROL_TOOL_NAMES.map(name => [name, true]));

/** `lsp` actions that only ask a language server a question. `rename*`, `code_actions`, `reload` and `request` are out. */
const LSP_READ_ACTIONS: Record<string, true> = {
	definition: true,
	references: true,
	hover: true,
	symbols: true,
	type_definition: true,
	implementation: true,
	status: true,
	capabilities: true,
	diagnostics: true,
};

/** URL schemes `read` may open besides plain paths: pages, the run's own handles, notes and documentation. */
const READ_SCHEMES: Record<string, true> = {
	http: true,
	https: true,
	agent: true,
	local: true,
	history: true,
	skill: true,
	rule: true,
	help: true,
};

const MAX_LOCAL_PATH_LENGTH = 180;
const MAX_LOCAL_PATH_SEGMENTS = 4;

const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const LOCAL_PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const TOOL_NAME = /^[A-Za-z0-9_.-]{1,64}$/;
/** A scheme at the start of a path: `x://`, omp's single-slash alias `x:/`, or an opaque `x:rest` (MCP resources). */
const LEADING_SCHEME = /^([a-z][a-z0-9+.-]*):(?:\/\/?|(?=.))/i;
/** omp opens a PDF page as an image (`doc.pdf:p1.png`) through a headless browser: that is a process, not a read. */
const PDF_PAGE_IMAGE = /\.pdf:(?:p|page[-_]?)\d+(?:[-_].*)?\.png$/i;
/** A read-tool selector tail (`Makefile:12`, `notes:raw`), which is not a scheme. */
const SELECTOR_CHAIN = /^(?:raw|conflicts|-?\d+(?:[-+]\d+)?(?:,\d+(?:[-+]\d+)?)*)(?::(?:raw|conflicts|-?\d+(?:[-+]\d+)?(?:,\d+(?:[-+]\d+)?)*))*(?:;|$)/i;

/** Every refusal the supervisor gate can give, by cause. Tests import these instead of quoting sentences. */
export const SUPERVISOR_REASONS = {
	readMalformed: "read 입력은 path 문자열 하나여야 하는데 그렇지 않아 막았습니다.",
	readRemote:
		"ssh:// 읽기는 원격 호스트에 접속하는 프로세스를 띄우고, mcp:// 같은 외부 리소스는 읽기 전용인지 확인할 수 없어 감독이 직접 읽지 않습니다. 필요하면 task 로 워커에게 맡기세요.",
	readEmbedded:
		"경로 안에 scheme:// 주소가 섞여 있어 omp 가 어디를 읽을지(원격 호스트일 수도 있음) 확정할 수 없어 막았습니다. 파일 경로나 http(s):// 주소 하나만 쓰세요.",
	readProcess:
		"PDF 쪽 이미지(.pdf:p1.png)는 브라우저 프로세스를 띄워 만들어서 읽기로 보지 않습니다. 텍스트는 파일 경로 그대로 읽으세요.",
	readOtherInstance:
		"agent://peers 와 숫자 주소는 같은 프로젝트의 다른 omp 인스턴스 데이터를 읽는 경로라 이 세션의 실행으로 한정할 수 없어 읽지 않습니다. 이 실행 워커의 id 로 읽으세요.",
	readAgentPath: "agent:// 주소의 id 형식이 올바르지 않습니다. agent://<id> 또는 agent://<id>/<field> 로 읽으세요.",
	readAgentScope:
		"agent:// 는 이 프로세스의 다른 세션이 띄운 에이전트의 출력까지 읽을 수 있어, 이 세션의 실행에서 시작된 에이전트의 id 만 읽습니다. 이 실행의 워커 id 는 storm status/agents 로 확인하세요.",
	readHistoryScope:
		"history:// 는 이 세션 밖의 에이전트 기록과 디스크의 다른 세션 기록까지 열 수 있어, 이 실행에서 시작된 에이전트의 id 만 읽습니다. 이 실행의 워커 id 는 storm status/agents 로 확인하세요.",
	writeMalformed: "write 입력은 path 와 content 문자열만 있어야 하는데 그렇지 않아 막았습니다.",
	writeFiles:
		"감독이 쓴 파일은 어느 레인의 결과도 아니고 쓰는 워커와 순서가 보장되지 않아 막혀 있습니다. 파일 변경은 task 로 구현 워커에 맡기세요.",
	writeRemote:
		"ssh://, xd://, proc://, mcp:// 쓰기는 원격 파일을 바꾸거나 명령을 실행할 수 있어 감독이 직접 하지 않습니다. 작업은 task 로 맡기세요.",
	writeLocalNote: "local:// 메모는 .md 파일 이름(영문·숫자·._-, 4단계 이내)과 문자열 content 만 받아 이 쓰기를 막았습니다.",
	messageBroadcast:
		"agent://all 은 모든 워커를 한꺼번에 깨울 수 있어 보내지 않습니다. agent://<id> 로 워커 한 명에게 보내세요.",
	messageOtherAddress:
		"agent://parent, agent://peers, 숫자 주소는 이 실행의 워커가 아니라 부모나 다른 omp 인스턴스로 가는 주소라 막았습니다. 이 실행 워커의 id 로 보내세요.",
	messageControl:
		"에이전트의 모델·추론 강도는 사용자가 승인한 설정이라 감독이 바꾸지 않습니다. 본문만 agent://<id> 로 보내세요.",
	messageAddress: "agent:// 주소가 올바르지 않습니다. agent://<id> 또는 조용한 알림용 agent://<id>?progress 로 보내세요.",
	messageEmpty: "agent:// 메시지에 내용이 없어 보내지 않았습니다.",
	lspMutating:
		"이 lsp 동작은 이름 변경·코드 액션 적용·서버 재시작·원시 요청처럼 작업 트리를 바꾸거나 서버를 다시 띄울 수 있어 막았습니다. 정의·참조·hover·심볼·진단 같은 조회는 쓸 수 있습니다.",
	lspWorkspaceDiagnostics:
		"lsp diagnostics 의 file:\"*\" 는 프로젝트의 빌드 명령(cargo, tsc 등)을 실행해 막았습니다. 파일이나 글롭을 지정하세요.",
	lspMalformed: "lsp 입력에 action 문자열이 없어 막았습니다.",
	toolEdits: "파일을 바꾸므로 자동 위임 중 감독이 직접 쓰지 않습니다. 파일 변경은 task 로 구현 워커에 맡기세요.",
	toolRuns: "명령을 실행하므로 자동 위임 중 감독이 직접 쓰지 않습니다. 실행은 task 로 맡기거나 승인된 정형 작업을 storm execute 로 돌리세요.",
	toolUnknown: "읽기 전용인지 확인할 수 없어(MCP·확장 도구 포함) 자동 위임 중 감독이 직접 쓰지 않습니다.",
	toolMissing: "도구 이름이 없어 막았습니다.",
} as const;

/** What the gate may know beyond one call: the ids of the agents this session's runs started. */
export interface SupervisorScope {
	/** `history://<id>` is read only for these ids (compared without case). Absent: no transcript is read. */
	agentIds?: readonly string[];
	/**
	 * The ids of every agent the host's registry lists, of any session. `history://current` is the caller's own branch
	 * only while none of them is named `current`; absent, none is known to be.
	 */
	hostAgentIds?: readonly string[];
}

/** The scope itself, or a function that builds it when a transcript read needs it. */
export type SupervisorScopeSource = SupervisorScope | (() => SupervisorScope);

/** A path exactly as the tool received it: no surrounding whitespace, no control characters. */
function isExactPath(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 2048 &&
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

/** The scheme omp would route this path to, or undefined for a plain file path. */
function leadingScheme(path: string): string | undefined {
	const match = LEADING_SCHEME.exec(path);
	if (match === null) return undefined;
	const scheme = match[1].toLowerCase();
	// A drive letter (`C:/x`) is a path.
	if (scheme.length === 1) return undefined;
	if (path.startsWith(`${match[1]}:/`)) return scheme;
	// An opaque `scheme:rest` is an MCP resource, unless it is a file name with an extension or a selector tail.
	const rest = path.slice(match[1].length + 1);
	if (scheme.includes(".") || SELECTOR_CHAIN.test(rest)) return undefined;
	return scheme;
}

/**
 * `<id>` of `<scheme>://<id>[/…][?…][:…]`, read by the one function that reads every agent address (decoded, as omp
 * does); a read-tool selector after the id (`agent://<id>:1-40`) is not part of it.
 */
function handleId(path: string, scheme: "agent" | "history"): string {
	return (handleAddress(path, scheme)?.id ?? "").split(":", 1)[0] ?? "";
}

function isOtherInstanceId(id: string): boolean {
	const lower = id.toLowerCase();
	return lower === "peers" || /^\d+$/.test(id);
}

function readHistory(path: string, scope: SupervisorScopeSource | undefined): string | undefined {
	const id = handleId(path, "history");
	const lower = id.toLowerCase();
	// With no scope at all (a caller that does not hold reads to a session) the session's own branch is let through.
	if (lower === "current" && scope === undefined) return undefined;
	// A getter is called only for a transcript read, so a caller can look the ledger up lazily.
	const given = typeof scope === "function" ? scope() : scope;
	const known = given?.agentIds ?? [];
	if (lower === "current" && !known.some(candidate => candidate.toLowerCase() === lower)) {
		// omp serves `history://current` from the caller's own branch only while no agent of the process is named
		// `current`; one that is not this session's would be read instead (`internal-urls/history-protocol.ts`).
		const named = given?.hostAgentIds?.some(candidate => candidate.toLowerCase() === lower) ?? false;
		return named ? SUPERVISOR_REASONS.readHistoryScope : undefined;
	}
	return id !== "" && known.some(candidate => candidate.toLowerCase() === lower)
		? undefined
		: SUPERVISOR_REASONS.readHistoryScope;
}

/**
 * Reads are plain reads: project files and directories, web pages, the run's own `agent://` handles, `local://` notes,
 * documentation schemes and this run's own transcripts. A path that reaches a remote host, another omp instance or
 * another session, or that makes omp start a process, is refused with that cause. How much a read returns is the
 * host's paging and Storm's compaction, not a refusal.
 */
function readBlock(input: unknown, scope: SupervisorScopeSource | undefined): string | undefined {
	const path = exactReadPath(input);
	if (path === undefined) return SUPERVISOR_REASONS.readMalformed;
	const scheme = leadingScheme(path);
	if (scheme === undefined) {
		// omp also routes a scheme written in the middle of a path (`/repo/ssh://host/x`): none may appear in a plain path.
		if (/[a-z][a-z0-9+.-]*:\/\//i.test(path)) return SUPERVISOR_REASONS.readEmbedded;
		return PDF_PAGE_IMAGE.test(path) ? SUPERVISOR_REASONS.readProcess : undefined;
	}
	if (READ_SCHEMES[scheme] !== true) return SUPERVISOR_REASONS.readRemote;
	// The handle schemes are judged by their id: only the hierarchical spelling puts it where `handleId` looks.
	if ((scheme === "agent" || scheme === "history") && path.slice(scheme.length, scheme.length + 3) !== "://") {
		return SUPERVISOR_REASONS.readAgentPath;
	}
	if (scheme === "agent") {
		// The id is read the way omp reads it (decoded): omp resolves `agent://<id>` across every active session of the process,
		// so with a scope given the handle must be an agent of this session's runs, like a transcript.
		const id = handleId(path, "agent");
		if (!AGENT_ID.test(id)) return SUPERVISOR_REASONS.readAgentPath;
		if (isOtherInstanceId(id)) return SUPERVISOR_REASONS.readOtherInstance;
		if (scope !== undefined) {
			const known = (typeof scope === "function" ? scope() : scope).agentIds;
			if (known !== undefined && !known.some(candidate => candidate.toLowerCase() === id.toLowerCase())) return SUPERVISOR_REASONS.readAgentScope;
		}
		return undefined;
	}
	if (scheme === "history") return readHistory(path, scope);
	return undefined;
}

/** `agent://<id>` or `agent://<id>?progress`, nothing else: no JSON path, selector, model/effort control or other query. */
function messageBlock(address: AgentAddress, content: string): string | undefined {
	const id = address.id;
	if (!AGENT_ID.test(id)) return SUPERVISOR_REASONS.messageAddress;
	const lower = id.toLowerCase();
	if (lower === "all") return SUPERVISOR_REASONS.messageBroadcast;
	if (lower === "parent" || isOtherInstanceId(id)) return SUPERVISOR_REASONS.messageOtherAddress;
	if (address.segments.length > 0) {
		const field = address.segments[0]?.toLowerCase();
		return address.segments.length === 1 && (field === "model" || field === "effort")
			? SUPERVISOR_REASONS.messageControl
			: SUPERVISOR_REASONS.messageAddress;
	}
	if (address.query !== "" && address.query !== "progress") return SUPERVISOR_REASONS.messageAddress;
	return content.trim() === "" ? SUPERVISOR_REASONS.messageEmpty : undefined;
}

function writeBlock(input: unknown): string | undefined {
	const parsed = exactWriteInput(input);
	if (parsed === undefined) return SUPERVISOR_REASONS.writeMalformed;
	const address = agentAddress(parsed.path);
	if (address !== undefined) return messageBlock(address, parsed.content);
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
		return valid ? undefined : SUPERVISOR_REASONS.writeLocalNote;
	}
	if (
		parsed.path.startsWith("ssh://") ||
		parsed.path.startsWith("xd://") ||
		parsed.path.startsWith("proc://") ||
		parsed.path.startsWith("mcp://")
	) {
		return SUPERVISOR_REASONS.writeRemote;
	}
	return SUPERVISOR_REASONS.writeFiles;
}

function lspBlock(input: unknown): string | undefined {
	if (typeof input !== "object" || input === null || Array.isArray(input)) return SUPERVISOR_REASONS.lspMalformed;
	const record = input as Record<string, unknown>;
	const action = record.action;
	if (typeof action !== "string") return SUPERVISOR_REASONS.lspMalformed;
	if (!Object.hasOwn(LSP_READ_ACTIONS, action) || LSP_READ_ACTIONS[action] !== true) return SUPERVISOR_REASONS.lspMutating;
	if (action === "diagnostics" && typeof record.file === "string" && record.file.trim() === "*") {
		return SUPERVISOR_REASONS.lspWorkspaceDiagnostics;
	}
	return undefined;
}

/** Whether an `lsp` call only asks a language server a question (workspace diagnostics runs the project's build command). */
export function lspReadsOnly(input: unknown): boolean {
	return lspBlock(input) === undefined;
}

/**
 * Whether a call has the shape of omp's plan submission in the form omp 19.2.1 gives the model while `bash` is enabled: the
 * tool `propose` is then not on the list and the model runs the command `propose <slug>` with `bash` (seen on the real host:
 * a direct `propose` call answers "Tool propose not found"). omp's tool-command host runs it as the tool, in no shell and no
 * process, but only while omp's plan mode is on (`specialToolApplies`, `tools/index.ts`); with it off the same line goes to
 * the shell like any command, and a program named `propose` on the PATH would run. So the shape is no proof by itself: the
 * caller lets it through only when it also knows plan mode is on. Only this exact shape qualifies (one word, one slug of
 * omp's own slug characters, no other argument).
 */
export function isPlanProposal(toolName: string, input: unknown): boolean {
	if (toolName !== "bash" || typeof input !== "object" || input === null || Array.isArray(input)) return false;
	const record = input as Record<string, unknown>;
	return Object.keys(record).length === 1 && typeof record.command === "string" && /^propose[ \t]+[A-Za-z0-9_-]{1,80}$/.test(record.command);
}

/**
 * The same gate during a run: the director may also change project files itself with a path tool (`edit`, `ast_edit`,
 * `write` to a plain path, or another tool of `PATH_WRITE_TOOLS`), so those pass here and go on to the run's write
 * table, which orders them against every other writer (`decideDirectorCall` names the files, or refuses). Everything
 * else is judged as `supervisorToolBlock` does; before a plan the caller keeps using that one, so an automatic
 * director still changes no file before a run exists. A `write` whose path is an address (`vault://`, `conflict://`,
 * `ssh://`, `xd://`, any scheme, one embedded in the path) stays refused.
 */
export function supervisorRunToolBlock(
	toolName: string,
	input: unknown,
	scope?: SupervisorScopeSource,
	planMode = false,
): string | undefined {
	if (typeof toolName !== "string" || !Object.hasOwn(PATH_WRITE_TOOLS, toolName)) {
		return supervisorToolBlock(toolName, input, scope, planMode);
	}
	if (toolName !== "write") return undefined;
	const detail = writeBlock(input);
	if (detail !== SUPERVISOR_REASONS.writeFiles) return detail;
	// `writeBlock` answers `writeFiles` for every path it does not recognise as a message or a note: only a plain path is a project file.
	const parsed = exactWriteInput(input);
	const plain = parsed !== undefined && leadingScheme(parsed.path) === undefined && !/[a-z][a-z0-9+.-]*:\/\//i.test(parsed.path);
	return plain ? undefined : detail;
}

/**
 * The refusal for a main-session tool call under automatic supervision, or undefined to let it run. Exact tool
 * names only: no prefix matching, no prototype names, no fallback for malformed input. `scope` names the agents of
 * this session's runs, so a transcript read stays inside them; without it no transcript is read.
 */
export function supervisorToolBlock(
	toolName: string,
	input: unknown,
	scope?: SupervisorScopeSource,
	/** omp's plan mode is on right now: only then is `bash propose <slug>` omp's plan submission and not a shell command. */
	planMode = false,
): string | undefined {
	if (typeof toolName !== "string" || toolName.length === 0) return SUPERVISOR_REASONS.toolMissing;
	if (Object.hasOwn(CONTROL_TOOLS, toolName)) return undefined;
	if (toolName === "read") return readBlock(input, scope);
	if (toolName === "write") return writeBlock(input);
	if (toolName === "lsp") return lspBlock(input);
	if (Object.hasOwn(READ_ONLY_TOOLS, toolName) && READ_ONLY_TOOLS[toolName] === true) return undefined;
	const shown = TOOL_NAME.test(toolName) ? toolName : "알 수 없는";
	if (planMode && isPlanProposal(toolName, input)) return undefined;
	if (toolName === "bash" || toolName === "eval") return `${shown} 도구는 ${SUPERVISOR_REASONS.toolRuns}`;
	if (Object.hasOwn(PATH_WRITE_TOOLS, toolName)) return `${shown} 도구는 ${SUPERVISOR_REASONS.toolEdits}`;
	return `${shown} 도구는 ${SUPERVISOR_REASONS.toolUnknown}`;
}
