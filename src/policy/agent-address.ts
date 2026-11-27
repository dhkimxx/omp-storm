/**
 * One reading of an agent address the way omp reads it, used everywhere Storm decides something from `agent://…`: who a
 * message is for, whether it is a quiet note, whether it is a write to a worker's model or effort, whether a read is held to
 * this session's agents. omp 19.2.1 matches the scheme without case, accepts the single-slash spelling and a hashline
 * wrapper (`[path#TAG]`), and decodes the host and every path segment before it compares them (`internal-urls/parse.ts`,
 * `router.ts`, `agent-protocol.ts`). A literal `startsWith("agent://")` and an undecoded comparison are bypassed by
 * `Agent://A/model` and `agent://A/%6Dodel`, which omp resolves to the same control write.
 */

export interface AgentAddress {
	/** The recipient or handle: the host part, percent-decoded, in the spelling the caller typed. */
	id: string;
	/** The path segments after the id, empty ones dropped, each percent-decoded. */
	segments: string[];
	/** The query without its `?`. */
	query: string;
}

const HASHLINE_WRAPPER = /^\[(.*?)(?:#[A-Za-z0-9]*)?\]$/;
const AGENT_PREFIX = /^agent:(?:\/\/|\/)/i;
const HISTORY_PREFIX = /^history:(?:\/\/|\/)/i;

const decode = (text: string): string => {
	try {
		return decodeURIComponent(text);
	} catch {
		// omp leaves a segment it cannot decode as it is.
		return text;
	}
};

/** The address `path` names, or undefined when it is not an `agent:` address in any spelling omp accepts. */
export function agentAddress(path: string): AgentAddress | undefined {
	return handleAddress(path, "agent");
}

/**
 * The same reading for the other handle scheme the director may read, `history://<id>` (omp parses every internal URL
 * with the one function). `scheme` is lower case.
 */
export function handleAddress(path: string, scheme: "agent" | "history"): AgentAddress | undefined {
	let text = path.trim();
	const wrapped = HASHLINE_WRAPPER.exec(text);
	if (wrapped !== null) text = (wrapped[1] ?? "").trim();
	const prefix = (scheme === "agent" ? AGENT_PREFIX : HISTORY_PREFIX).exec(text);
	if (prefix === null) return undefined;
	let rest = text.slice(prefix[0].length);
	const hash = rest.indexOf("#");
	if (hash >= 0) rest = rest.slice(0, hash);
	const queryAt = rest.indexOf("?");
	const base = queryAt < 0 ? rest : rest.slice(0, queryAt);
	const query = queryAt < 0 ? "" : rest.slice(queryAt + 1);
	const [host = "", ...tail] = base.split("/");
	return { id: decode(host), segments: pathSegments(rest, tail).filter(segment => segment !== "").map(decode), query };
}

/**
 * The path segments after the host, as omp takes them. omp parses the address with `new URL()` and splits `pathname`
 * (`internal-urls/parse.ts`, `agent-protocol.ts`), and the WHATWG parser resolves `.` and `..` segments, also their
 * percent-encoded spellings (`%2e`), before omp looks at them: `agent://A/./model` and `agent://A/x/../model` are the
 * control write `agent://A/model`. When the parser throws, omp keeps the raw path (its regex fallback), so the raw split
 * stays the reading then.
 */
function pathSegments(rest: string, rawTail: string[]): string[] {
	try {
		return new URL(`agent://${rest}`).pathname.split("/");
	} catch {
		return rawTail;
	}
}

/** Whether the address's query carries omp's `progress` flag (omp asks `searchParams.has("progress")`). */
export function hasProgressFlag(address: AgentAddress): boolean {
	return new URLSearchParams(address.query).has("progress");
}
