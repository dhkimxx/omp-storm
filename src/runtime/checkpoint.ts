/**
 * Director context checkpoints. Past its context cap the director is compacted — in the background for automatic runs
 * at their first plan and sync-wait boundaries, and at an async wait for manual runs — keeping decisions and evidence
 * locations rather than raw contents; every compaction (omp's own included) also gets Storm's ledger of the run, so
 * lanes and each agent's `agent://` handle survive it.
 */
import { tokens } from "../report/agents.ts";
import { roleTitle } from "../roles.ts";
import type { AgentEntry, AgentLiveState, RunRecord } from "../types.ts";
import { reviewTotals } from "./review.ts";
import { runRecordRef } from "./run.ts";

/** Least time between two checkpoints of one director. */
export const CHECKPOINT_MIN_GAP_MS = 10 * 60_000;
/** Lanes and agents listed in the working state; the rest are counted. */
const MAX_LANES = 20;
const MAX_AGENTS = 24;
const MAX_NAME = 80;
const MAX_TASK = 200;
/** The request beyond its banner: the user's constraints live here, not in the first 200 characters. */
const MAX_REQUEST_BYTES = 3_200;
/** Kept from the end when the request is cut: constraints often sit last. */
const REQUEST_TAIL_BYTES = 512;
/** One lane goal is a constraint too; the plan's note may carry the remaining decisions. */
const MAX_LANE_GOAL = 120;
const MAX_PLAN_NOTE = 300;
/** Hard cap on the whole ledger; longer text points at the run record instead of replaying it. */
const MAX_STATE_BYTES = 6_000;

/** Focus for a director checkpoint compaction. */
export const CHECKPOINT_INSTRUCTIONS = [
	"Storm 감독 맥락 압축입니다. 다음을 남기세요:",
	"- 내린 결정과 그 이유",
	"- 바뀐 파일(경로)과 맡은 레인·에이전트",
	"- 검증한 것과 실패한 것, 각각의 근거 위치(파일과 줄 범위, 명령과 종료 코드, 로그 경로, agent://<id>)",
	"- 남은 문제",
	"- 다음 행동",
	"파일 원문, 명령 출력, 로그 본문은 버리세요. 근거 위치로 다시 읽을 수 있습니다.",
].join("\n");

/**
 * Whether the director's context (`tokens`) is at or past `cap` and no checkpoint ran within `minGapMs`. A checkpoint
 * in flight excludes another, and a host rejection holds the next try off for the same gap: a host that refuses
 * (already compacting, nothing to compact, a session change) is never asked at every boundary.
 */
export function shouldCheckpoint(input: {
	tokens: number;
	cap: number;
	lastAt?: number;
	lastRejectedAt?: number;
	inFlight?: boolean;
	now: number;
	minGapMs?: number;
}): boolean {
	if (input.inFlight === true) return false;
	if (input.tokens < input.cap) return false;
	const gap = input.minGapMs ?? CHECKPOINT_MIN_GAP_MS;
	if (input.lastAt !== undefined && input.now - input.lastAt < gap) return false;
	if (input.lastRejectedAt !== undefined && input.now - input.lastRejectedAt < gap) return false;
	return true;
}

const STATE_LABEL: Record<AgentLiveState, string> = { running: "실행 중", idle: "유휴", parked: "보관" };

/** Model text becomes one ledger line: whitespace collapsed, bounded, with an ellipsis when cut. */
function oneLine(text: string, max: number): string {
	const clean = text.replace(/\s+/g, " ").trim();
	return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

/**
 * The request beyond its 200-character banner. The whole request is at most 20,000 characters; a shorter one is kept
 * as one line, and a longer one keeps a byte-bounded head and tail (where constraints often sit) plus the run-record
 * reference, so a compaction can reread it without this ledger replaying it.
 */
function requestText(run: RunRecord): string | undefined {
	const text = (run.request ?? "").trim();
	if (!text || (text === run.task && text.length <= MAX_TASK)) return undefined;
	const clean = text.replace(/\r?\n+/g, " / ");
	if (Buffer.byteLength(clean, "utf8") <= MAX_REQUEST_BYTES) return clean;
	const chars = Array.from(clean);
	let headEnd = 0;
	let headBytes = 0;
	while (headEnd < chars.length) {
		const width = Buffer.byteLength(chars[headEnd]!, "utf8");
		if (headBytes + width > MAX_REQUEST_BYTES - REQUEST_TAIL_BYTES) break;
		headBytes += width;
		headEnd++;
	}
	let tailStart = chars.length;
	let tailBytes = 0;
	while (tailStart > headEnd) {
		const width = Buffer.byteLength(chars[tailStart - 1]!, "utf8");
		if (tailBytes + width > REQUEST_TAIL_BYTES) break;
		tailBytes += width;
		tailStart--;
	}
	const head = chars.slice(0, headEnd).join("").trimEnd();
	const tail = chars.slice(tailStart).join("").trimStart();
	const ref = runRecordRef(run.runId);
	return `${head} … ${tail}${ref ? ` (전문 ${text.length}자: ${ref})` : ""}`;
}

/** Keeps the whole ledger under one byte cap; the caller's tail becomes a count, never an unbounded replay. */
function boundedState(lines: string[]): string[] {
	const out: string[] = [];
	let used = 0;
	for (const line of lines) {
		const width = Buffer.byteLength(line, "utf8") + 1;
		if (used + width > MAX_STATE_BYTES) {
			out.push(`- … 압축 한도 ${MAX_STATE_BYTES}바이트에서 나머지 줄 생략`);
			break;
		}
		out.push(line);
		used += width;
	}
	return out;
}

/**
 * Storm's ledger of a run for a compaction of its directing session: the request's constraints, plan lanes and their
 * goals, the run's agents with their `agent://` handles, the review tally and what Storm blocked. Compact Korean
 * lines from record metadata only; no file contents, command output or logs. Long lists and text are cut, counted or
 * pointed to by `runRecordRef`. `agents` may hold other runs' agents; only those of `run` are listed.
 */
export function workingState(run: RunRecord, agents: readonly AgentEntry[]): string[] {
	const out = [`Storm 실행 ${run.runId} 장부 (압축 뒤에도 유지할 상태). 요청: ${oneLine(run.task, MAX_TASK)}`];
	const request = requestText(run);
	if (request) out.push(`요청 발췌(앞 200자 밖 제약 포함): ${request}`);

	const plan = run.plan;
	const note = plan?.note;
	if (typeof note === "string" && note.trim()) out.push(`계획 메모(남은 결정 포함): ${oneLine(note, MAX_PLAN_NOTE)}`);

	const lanes = plan && Array.isArray(plan.lanes) ? plan.lanes : [];
	if (lanes.length === 0) out.push("계획: 아직 없음");
	else {
		out.push(`계획 레인 ${lanes.length}개:`);
		for (const l of lanes.slice(0, MAX_LANES)) {
			const goal = l.goal?.trim() ? `: ${oneLine(l.goal, MAX_LANE_GOAL)}` : "";
			out.push(`- ${oneLine(l.name, MAX_NAME)} (${l.kind}, ${roleTitle(l.role)})${goal}`);
		}
		if (lanes.length > MAX_LANES) out.push(`- 외 ${lanes.length - MAX_LANES}개`);
	}

	const mine = agents.filter(a => a.runId === run.runId);
	if (mine.length === 0) out.push("서브에이전트: 없음");
	else {
		// Running first, then the most recently active.
		const order = (a: AgentEntry) => (a.state === "running" ? 0 : 1);
		const sorted = [...mine].sort((a, b) => order(a) - order(b) || b.lastActivityAt - a.lastActivityAt);
		out.push(`서브에이전트 ${mine.length}개 (결과는 agent://<id> 로 다시 읽기):`);
		for (const a of sorted.slice(0, MAX_AGENTS)) {
			const cleaned = a.cleanedAt === undefined ? "" : ", 정리됨(결과만 읽기, 후속 지시 불가)";
			const name = a.role === undefined ? oneLine(a.name, MAX_NAME) : roleTitle(a.role);
			out.push(
				`- agent://${oneLine(a.id, MAX_NAME)} — ${name}, ${STATE_LABEL[a.state]}, 컨텍스트 ${tokens(a.contextTokens)} 토큰${cleaned}`,
			);
		}
		const rest = sorted.slice(MAX_AGENTS);
		if (rest.length > 0) {
			const byState = (Object.keys(STATE_LABEL) as AgentLiveState[])
				.map(s => [STATE_LABEL[s], rest.filter(a => a.state === s).length] as const)
				.filter(([, n]) => n > 0)
				.map(([label, n]) => `${label} ${n}`)
				.join(", ");
			out.push(`- 외 ${rest.length}개 (${byState})`);
		}
	}

	const review = reviewTotals(mine);
	if (review.reviews > 0) {
		const doc = review.docFindings > 0 ? `, 문서 지적 ${review.docFindings}` : "";
		out.push(
			`리뷰 ${review.reviews}회: 통과 ${review.passed}, 실패 ${review.failed}; 지적 ${review.findings.map((n, i) => `P${i} ${n}`).join(" · ")}${doc}`,
		);
	}

	out.push(
		`Storm이 막은 일: 파일 수정 ${run.blockedEdits ?? 0}, 후속 지시 ${run.blockedFollowUps ?? 0}, 읽기 ${run.reads?.blocked ?? 0}`,
	);
	return boundedState(out);
}

/**
 * Guidance for a handoff checkpoint. omp's background handoff summarizer receives only this text as its focus (the
 * `session.compacting` hook context is not part of a handoff request), so the run ledger rides here: the request and
 * its constraints, the plan and lane goals, the agents' handles, and what Storm blocked survive the compaction.
 */
export function checkpointGuidance(run: RunRecord, agents: readonly AgentEntry[]): string {
	return `${CHECKPOINT_INSTRUCTIONS}\n\nStorm 장부(압축 뒤에도 유지):\n${workingState(run, agents).join("\n")}`;
}
