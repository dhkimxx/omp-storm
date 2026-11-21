/**
 * Director context checkpoints. Past its context cap the director is compacted while it waits on subagents, keeping
 * decisions and evidence locations rather than raw contents; every compaction (omp's own included) also gets Storm's
 * ledger of the run, so lanes and each agent's `agent://` handle survive it.
 */
import { tokens } from "../report/agents.ts";
import type { AgentEntry, AgentLiveState, RunRecord } from "../types.ts";

/** Least time between two checkpoints of one director. */
export const CHECKPOINT_MIN_GAP_MS = 10 * 60_000;
/** Lanes and agents listed in the working state; the rest are counted. */
const MAX_LANES = 20;
const MAX_AGENTS = 24;
const MAX_NAME = 80;

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

/** Whether the director's context (`tokens`) is at or past `cap` and no checkpoint ran within `minGapMs`. */
export function shouldCheckpoint(input: { tokens: number; cap: number; lastAt?: number; now: number; minGapMs?: number }): boolean {
	if (input.tokens < input.cap) return false;
	if (input.lastAt === undefined) return true;
	return input.now - input.lastAt >= (input.minGapMs ?? CHECKPOINT_MIN_GAP_MS);
}

const STATE_LABEL: Record<AgentLiveState, string> = { running: "실행 중", idle: "유휴", parked: "보관됨" };

/**
 * Storm's ledger of a run for a compaction of its directing session: plan lanes, the run's agents with their
 * `agent://` handles, the review tally and what Storm blocked. Compact Korean lines, no file contents; long lists
 * are cut and counted. `agents` may hold other runs' agents; only those of `run` are listed.
 */
export function workingState(run: RunRecord, agents: readonly AgentEntry[]): string[] {
	const out = [`Storm 실행 ${run.runId} 장부 (압축 뒤에도 유지할 상태). 요청: ${run.task}`];

	const lanes = run.plan?.lanes ?? [];
	if (lanes.length === 0) out.push("계획: 아직 없음");
	else {
		out.push(`계획 레인 ${lanes.length}개:`);
		for (const l of lanes.slice(0, MAX_LANES)) {
			const name = l.name.length > MAX_NAME ? `${l.name.slice(0, MAX_NAME - 1)}…` : l.name;
			out.push(`- ${name} (${l.kind}, ${l.role})`);
		}
		if (lanes.length > MAX_LANES) out.push(`- 외 ${lanes.length - MAX_LANES}개`);
	}

	const mine = agents.filter(a => a.runId === run.runId);
	if (mine.length === 0) out.push("에이전트: 없음");
	else {
		// Running first, then the most recently active.
		const order = (a: AgentEntry) => (a.state === "running" ? 0 : 1);
		const sorted = [...mine].sort((a, b) => order(a) - order(b) || b.lastActivityAt - a.lastActivityAt);
		out.push(`에이전트 ${mine.length}개 (결과는 agent://<id> 로 다시 읽기):`);
		for (const a of sorted.slice(0, MAX_AGENTS)) {
			const cleaned = a.cleanedAt === undefined ? "" : ", 기록 정리됨(결과만 읽기, 후속 지시 불가)";
			out.push(
				`- agent://${a.id} — ${a.role ?? a.name}, ${STATE_LABEL[a.state]}, 컨텍스트 ${tokens(a.contextTokens)} 토큰${cleaned}`,
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

	let reviews = 0;
	let passed = 0;
	let failed = 0;
	let docs = 0;
	const findings = [0, 0, 0, 0];
	for (const a of mine) {
		if (!a.review) continue;
		reviews += a.review.reviews;
		passed += a.review.passed;
		failed += a.review.failed;
		docs += a.review.docFindings ?? 0;
		a.review.findings.forEach((n, i) => {
			findings[i] = (findings[i] ?? 0) + n;
		});
	}
	if (reviews > 0) {
		const doc = docs > 0 ? `, 문서 지적 ${docs}` : "";
		out.push(
			`리뷰 ${reviews}회: 통과 ${passed}, 실패 ${failed}; 지적 ${findings.map((n, i) => `P${i} ${n}`).join(" · ")}${doc}`,
		);
	}

	out.push(
		`Storm이 막은 일: 파일 수정 ${run.blockedEdits ?? 0}, 후속 지시 ${run.blockedFollowUps ?? 0}, 읽기 ${run.reads?.blocked ?? 0}`,
	);
	return out;
}
