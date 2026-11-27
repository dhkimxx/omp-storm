/**
 * Follow-ups (`write agent://<id>`) from a directing session. Storm refuses none of them for the agent's state: an
 * agent whose omp records the run-end janitor removed fails in omp itself, and `followUpFailureNote` says why and
 * where to go on (a fresh agent reads the old one's `agent://<id>` result). Context size never refuses a follow-up:
 * omp compacts a subagent session itself.
 */
import { withJosa } from "../josa.ts";
import { ROLE_AGENT_PREFIX, roleTitle } from "../roles.ts";
import type { AgentEntry } from "../types.ts";
import { agentAddress, hasProgressFlag } from "./agent-address.ts";
import { pathOf } from "./director.ts";

/** The agent id a `write` call addresses (`agent://<id>`, in any spelling omp accepts), if any. */
export function followUpTarget(toolName: string, input: unknown): string | undefined {
	if (toolName !== "write") return undefined;
	const path = pathOf(input);
	const address = path === undefined ? undefined : agentAddress(path);
	return address === undefined || address.id === "" ? undefined : address.id;
}

/**
 * Which control of an agent a `write` addresses: `agent://<id>/model` or `agent://<id>/effort` (any id, any case, any
 * spelling omp accepts: the scheme in another case, percent-encoded segments, a hashline wrapper, with or without a query or
 * a trailing slash). omp lets an agent switch itself or a direct child through these paths; an ordinary message
 * (`agent://<id>`, `agent://parent`, `?progress`) is not one.
 */
export function agentControlTarget(toolName: string, input: unknown): "model" | "effort" | undefined {
	if (toolName !== "write") return undefined;
	const path = pathOf(input);
	const address = path === undefined ? undefined : agentAddress(path);
	const control = address?.segments[0]?.toLowerCase();
	return control === "model" || control === "effort" ? control : undefined;
}

/** The ledger entry a follow-up target names; omp resolves recipient ids ignoring case when no exact one exists. */
export function followUpAgent(agents: readonly AgentEntry[], id: string): AgentEntry | undefined {
	const lower = id.toLowerCase();
	return agents.find(a => a.id === id) ?? agents.find(a => a.id.toLowerCase() === lower);
}

/**
 * Why a `write agent://<id>` that omp just failed to deliver could not reach this agent, when the cause is Storm's own
 * cleanup: the run-end janitor removed the agent's omp records. Storm does not refuse such a write (omp answers it:
 * the recipient is unknown or cannot be revived); this adds the cause and the way on to omp's failure text. Undefined
 * when the target is not a cleaned agent of the ledger.
 */
export function followUpFailureNote(toolName: string, input: unknown, agents: readonly AgentEntry[]): string | undefined {
	const id = followUpTarget(toolName, input);
	const agent = id === undefined ? undefined : followUpAgent(agents, id);
	if (!agent || agent.cleanedAt === undefined) return undefined;
	const who = `${agent.id}(${agent.role === undefined ? agent.name : roleTitle(agent.role)}) 에이전트`;
	const fresh = agent.role === undefined ? agent.name : `${ROLE_AGENT_PREFIX}${agent.role}`;
	const next = `새 \`${fresh}\` 에이전트를 띄워 \`agent://${agent.id}\`의 결과를 읽고 이어 가게 하세요.`;
	return `${withJosa(who, "은/는")} 정리로 omp 기록이 지워져 후속 지시를 받을 수 없습니다. ${next}`;
}

/**
 * A native quiet `?progress` write. It can still wake an idle recipient, but it is not a requested result
 * and is not counted as a follow-up in the report.
 */
export function followUpProgress(toolName: string, input: unknown): boolean {
	if (toolName !== "write") return false;
	const path = pathOf(input);
	const address = path === undefined ? undefined : agentAddress(path);
	return address !== undefined && hasProgressFlag(address);
}

/**
 * The agent id a finished `write agent://<id>` reached, for the follow-up count: delivered (or queued for a starting
 * agent) means the tool did not fail. `?progress` notes are not follow-ups.
 */
export function deliveredFollowUp(toolName: string, input: unknown, isError: boolean): string | undefined {
	if (isError) return undefined;
	if (followUpProgress(toolName, input)) return undefined;
	return followUpTarget(toolName, input);
}

/**
 * Whether the receipt of an `agent://<id>` write says the message started a turn: omp answers with `details.message.receipts`,
 * one per recipient, each `injected` (taken into the turn that was open), `woken` (a new turn started) or `revived` (a parked
 * worker was restored for it). Anything that cannot be read says nothing was woken.
 */
export function deliveryWokeTurn(details: unknown): boolean {
	const outcome = deliveryOutcome(details);
	return outcome === "woken" || outcome === "revived";
}

/** What omp's receipt for an `agent://<id>` write says happened to its (first) recipient; undefined when it cannot be read. */
export function deliveryOutcome(details: unknown): "injected" | "woken" | "revived" | undefined {
	if (typeof details !== "object" || details === null) return undefined;
	const message = (details as { message?: unknown }).message;
	if (typeof message !== "object" || message === null) return undefined;
	const receipts = (message as { receipts?: unknown }).receipts;
	if (!Array.isArray(receipts)) return undefined;
	const outcomes = receipts.map(receipt => (typeof receipt === "object" && receipt !== null ? (receipt as { outcome?: unknown }).outcome : undefined));
	// A receipt that woke or revived the recipient says so even when another one beside it did not.
	for (const wake of ["woken", "revived"] as const) if (outcomes.includes(wake)) return wake;
	return outcomes.includes("injected") ? "injected" : undefined;
}
