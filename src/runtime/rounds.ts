/**
 * Round rules: whether a run's latest round left anything to verify, when the run is over, and what Storm sends the
 * main session when it is not. Pure: no clock, no I/O, no controller state, so every rule is testable on its own.
 */
import { usableRole } from "../policy/spawn.ts";
import type { AgentEntry, RunEndReason, RunStatus, StormConfig } from "../types.ts";
import { reviewEvidenceOf, type ReviewEvidence } from "./review.ts";
import type { TreeState } from "./tree.ts";

export const DEFAULT_EXTRA_ROUNDS = 3;
export const MAX_EXTRA_ROUNDS = 10;
/** How long Storm waits before looking again while the session is held. */
export const HOLD_MS = 5_000;
/** How long after a round ends Storm looks whether to send the next: the session is still closing the turn before that; omp's own continuations wait as long. */
export const ROUND_DELAY_MS = 800;

/** Korean labels for the states a run record can be in. */
export const STATUS_LABEL: Record<RunStatus, string> = {
	running: "진행 중",
	done: "완료",
	ended: "끝남",
	"budget-exceeded": "예산 초과",
	stopped: "중단",
};

/** Korean labels for the reasons a run can end with. */
export const END_LABEL: Readonly<Record<RunEndReason, string>> = {
	verified: "리뷰 통과",
	"no-changes": "변경 없음",
	unreviewed: "리뷰 없이 끝남",
	"no-reviewer": "리뷰 역할 없음",
	interrupted: "사용자가 중단",
	"round-limit": "라운드 한도",
	"no-progress": "진전 없음",
	"time-limit": "시간 한도",
	shutdown: "세션 종료",
	budget: "실행 예산 초과",
	"start-failed": "실행 계약 전송 실패",
};

/** Only a verified run is done; a run that ended without verification is ended; one cut short is stopped. A run past its budget overrides both. */
export const END_STATUS: Readonly<Record<RunEndReason, RunStatus>> = {
	verified: "done",
	"no-changes": "ended",
	unreviewed: "ended",
	"no-reviewer": "ended",
	interrupted: "stopped",
	"round-limit": "stopped",
	"no-progress": "stopped",
	"time-limit": "stopped",
	shutdown: "stopped",
	budget: "stopped",
	"start-failed": "stopped",
};

/** The label of a reason; records written by 0.10 carry reasons that no longer exist, shown as they are. */
export function endLabel(reason: string): string {
	return (END_LABEL as Readonly<Record<string, string | undefined>>)[reason] ?? reason;
}

/** Why a required check is not proof: no entry, not passed, older than the change, or another tree. */
export type CoverageEvidence = "missing" | "failed" | "stale" | "mismatched";

/** The exact work-tree fingerprint a review verdict and a check report must both name: `<diff>:<files>`. */
export function treeFingerprint(tree: TreeState): string {
	return `${tree.diff}:${tree.files}`;
}

/**
 * A check's structured outcome. It maps directly from the check runner's evidence: only `passed` is proof, and a
 * report's `fingerprint`, `complete` and each entry's `finishedAt` are read without carrying any raw output.
 */
export interface CoverageCheck {
	/** Stable check name, e.g. `test` or `typecheck`. */
	name: string;
	/** Only `passed` is proof; every other status blocks. */
	status: string;
	/** `<diff>:<files>` of the tree this check ran against; `CoverageInput.fingerprint` when absent. */
	tree?: string;
	/** ms since epoch the check finished; `finishedAt` is read when this is absent. */
	at?: number;
	/** ISO 8601 completion time, as the check runner records it. */
	finishedAt?: string | null;
}

/** A plan lane and whether it is finished; a read-only lane's completion needs no change review of its own. */
export interface CoverageLane {
	name: string;
	state: "done" | "pending" | "running" | "failed";
	/** Whether the lane can change files. Defaults to read-only. */
	writes?: boolean;
}

/**
 * What a coordinator can prove about the run beyond its review: required checks and remaining lanes. Pure data, no
 * raw logs. Omitted, a positive review is unbound proof and cannot pass.
 */
export interface CoverageInput {
	/** Names the contract requires; a name with no check is missing evidence. */
	requiredChecks?: readonly string[];
	/** Check evidence; every entry must have passed on the current tree after the last change. */
	checks?: readonly CoverageCheck[];
	/** The tree the whole check report ran against, for checks without their own `tree`. */
	fingerprint?: string;
	/** Whether the runner started every required check; false means a check is unrun and cannot be proof. */
	complete?: boolean;
	/** Whether the check run was cancelled; an aborted report is not proof even when its started checks passed. */
	aborted?: boolean;
	/**
	 * Plan lanes and their state: any state other than `done` blocks success. An empty list says none remain; absent
	 * means the caller has no plan lane state (a caller with a plan must pass it).
	 */
	lanes?: readonly CoverageLane[];
}

export type Gate =
	| { state: "none"; why: "no-changes" | "quick-only" | "no-reviewer" }
	| { state: "passed" }
	| {
			state: "unverified";
			cause: "no-review" | "stale-review" | "incorrect" | "unbound" | "no-proof" | "p0" | "coverage" | "lanes";
			changes: number;
			reviews: number;
			requests: number;
			/** Set when the only reason for `stale-review` is a tree that moved since the verdict. */
			by?: "tree";
			/** Set when a tree that could not be read is why the proof is missing. */
			unread?: true;
			/** The one tree-only re-review was already used: another round cannot prove this tree. */
			exhausted?: true;
			/** Why check evidence is not proof; set with `cause: "coverage"`. */
			evidence?: CoverageEvidence;
			/** The first unfinished lane; set with `cause: "lanes"`. */
			lane?: string;
	  };

/** The gate's unverified shape, the only one a round message is built from. */
type Unverified = Extract<Gate, { state: "unverified" }>;
type UnverifiedCause = Unverified["cause"];
type UnverifiedExtra = { by?: "tree"; unread?: true; exhausted?: true; evidence?: CoverageEvidence; lane?: string };

/**
 * A P0 is cleared only by a later review that passed on the exact current tree and raised no P0. The clearing review
 * must be independent of the one that raised it: another reviewer on the same tree, or a review of the replacement
 * tree after the change. A newer verdict on some other tree clears nothing.
 */
function p0Remains(agents: readonly AgentEntry[], treeNow: string): boolean {
	const reviews: { author: AgentEntry; record: ReviewEvidence }[] = [];
	for (const agent of agents) {
		const ledger = reviewEvidenceOf(agent);
		// A log that cannot be read or was truncated cannot rule out an unresolved P0.
		if (!ledger.complete) return true;
		// The structured log is the evidence: a tally with more P0s than the log holds cannot prove any of them cleared.
		const loggedP0 = ledger.records.reduce((count, record) => count + record.findings.filter(finding => finding.priority === 0).length, 0);
		if (loggedP0 < (agent.review?.findings[0] ?? 0)) return true;
		for (const record of ledger.records) reviews.push({ author: agent, record });
	}
	return reviews.some(({ author, record }) => {
		if (!record.findings.some(finding => finding.priority === 0)) return false;
		return !reviews.some(
			({ author: clearingAuthor, record: clearing }) =>
				clearing.correct === true &&
				clearing.at > record.at &&
				clearing.tree === treeNow &&
				!clearing.findings.some(finding => finding.priority === 0) &&
				// Same reviewer is independent only when the tree is a new replacement diff.
				(clearingAuthor.id !== author.id || (record.tree !== undefined && clearing.tree !== record.tree)),
		);
	});
}

/**
 * The first reason check evidence is not proof. Required names come from the approved config as well as the payload,
 * so a configured check that was never run is missing even when the payload omitted its name. A check must have
 * passed, name the tree Storm sees now, and finish after the last file change.
 */
function checkProblem(
	coverage: CoverageInput | undefined,
	required: readonly string[],
	treeNow: string | undefined,
	lastChangeAt: number | undefined,
): CoverageEvidence | undefined {
	if (coverage === undefined) return required.length > 0 ? "missing" : undefined;
	if (coverage.complete === false || coverage.aborted === true) return "missing";
	const checks = coverage.checks ?? [];
	for (const name of required) {
		if (!checks.some(check => check.name === name)) return "missing";
	}
	// Required names were checked above, so an empty check list now means no check was configured or observed.
	if (checks.length === 0) return undefined;
	if (treeNow === undefined) return "missing";
	for (const check of checks) {
		if (check.status !== "passed") return "failed";
		const tree = check.tree ?? coverage.fingerprint;
		if (tree === undefined || tree !== treeNow) return "mismatched";
		const at = check.at ?? (check.finishedAt === undefined || check.finishedAt === null ? undefined : Date.parse(check.finishedAt));
		if (at === undefined || !Number.isFinite(at)) return "missing";
		if (lastChangeAt !== undefined && at <= lastChangeAt) return "stale";
	}
	return undefined;
}

/** The first reason coverage is not proof: unfinished planned work first, then check evidence. */
function coverageProblem(
	coverage: CoverageInput | undefined,
	required: readonly string[],
	treeNow: string | undefined,
	lastChangeAt: number | undefined,
): { evidence: CoverageEvidence } | { lane: string } | undefined {
	const lane = coverage?.lanes?.find(entry => entry.state !== "done");
	if (lane) return { lane: lane.name };
	const evidence = checkProblem(coverage, required, treeNow, lastChangeAt);
	return evidence === undefined ? undefined : { evidence };
}

/** What the run's file changes, the work tree and review verdicts amount to: nothing to verify, verified, or unverified with why. */
export function reviewGate(
	agents: readonly AgentEntry[],
	config: StormConfig,
	tree?: { start?: TreeState; now?: TreeState; rereviewedAt?: number },
	coverage?: CoverageInput,
): Gate {
	const writers = agents.filter(agent => (agent.changes ?? 0) > 0 && agent.role !== "quick");
	const changes = agents.reduce((sum, agent) => sum + (agent.changes ?? 0), 0);
	const requests = agents.reduce((sum, agent) => sum + agent.requests, 0);
	// A read that fails after a known start is a change Storm cannot rule out; a run without a start tree has no tree evidence.
	const treeChanged = tree?.start !== undefined && (tree.now === undefined || tree.start.diff !== tree.now.diff || tree.start.files !== tree.now.files);
	// A change the team can put down to the quick role alone needs no reviewer: quick agents do small, self-contained work.
	const quickOnly = agents.some(agent => agent.role === "quick") && !agents.some(agent => agent.role === "implementer" || agent.role === undefined);
	const treeNow = tree?.now === undefined || tree.now.incomplete ? undefined : treeFingerprint(tree.now);
	const lastChangeAt = writers.length ? Math.max(...writers.map(agent => agent.lastChangeAt ?? 0)) : undefined;
	// A lane or quick-only state needs no reviewer; the approved reviewer is authority only for a change review.
	const reviewer = usableRole(config, "reviewer");
	const reviewerName = reviewer?.agent;
	// Only the approved reviewer role that did not write counts: a scout, explorer, implementer or quick verdict is not a review.
	const verdicts = reviewerName === undefined ? [] : agents.filter(agent => agent.role === "reviewer" && agent.name === reviewerName && (agent.changes ?? 0) === 0);
	const reviews = verdicts.reduce((sum, agent) => sum + (agent.review?.reviews ?? 0), 0);
	const unverified = (cause: UnverifiedCause, extra: UnverifiedExtra = {}): Unverified => {
		const gate: Unverified = { state: "unverified", cause, changes, reviews, requests };
		if (extra.by !== undefined) gate.by = extra.by;
		if (extra.unread) gate.unread = true;
		if (extra.exhausted) gate.exhausted = true;
		if (extra.evidence !== undefined) gate.evidence = extra.evidence;
		if (extra.lane !== undefined) gate.lane = extra.lane;
		return gate;
	};
	const pendingLane = coverage?.lanes?.find(lane => lane.state !== "done");
	if (writers.length === 0 && !treeChanged && changes === 0) {
		// An unchanged tree is not success when planned work never ran; continue the lane, without a reviewer.
		if (pendingLane) return unverified("lanes", { lane: pendingLane.name });
		return { state: "none", why: "no-changes" };
	}
	// Configured names are authority even when the payload omitted them: a quick-only state must not hide one.
	const requiredChecks = [...new Set([...(config.requiredChecks ?? []).map(check => check.name), ...(coverage?.requiredChecks ?? [])])];
	if (writers.length === 0 && !(treeChanged && !quickOnly)) {
		// Planned work that never ran is the first continuation reason; checks are evaluated once that work exists.
		if (pendingLane) return unverified("lanes", { lane: pendingLane.name });
		// Quick work stays unreviewed only when no configured check is failed or missing.
		// No coverage payload yet: a configured check's missing evidence is for the check runner to gather, not a
		// quick-only success.
		if (coverage === undefined && requiredChecks.length > 0) return unverified("no-proof");
		const evidence = checkProblem(coverage, requiredChecks, treeNow, lastChangeAt);
		if (evidence !== undefined) return unverified("coverage", { evidence });
		return { state: "none", why: "quick-only" };
	}
	if (!reviewer) return { state: "none", why: "no-reviewer" };
	let latest: { author: AgentEntry; verdict: NonNullable<AgentEntry["lastVerdict"]> } | undefined;
	for (const agent of verdicts) {
		const verdict = agent.lastVerdict;
		if (!verdict) continue;
		// Same-millisecond verdicts that contradict each other fail closed: correctness never wins a tie.
		if (latest === undefined || verdict.at > latest.verdict.at || (verdict.at === latest.verdict.at && !verdict.correct && latest.verdict.correct)) {
			latest = { author: agent, verdict };
		}
	}
	if (latest === undefined) {
		// A review needed only because the tree read failed says so: there may be no change at all.
		const unread = writers.length === 0 && tree?.start !== undefined && tree.now === undefined;
		return unverified("no-review", unread ? { unread: true } : {});
	}
	const chosen = latest;
	if (lastChangeAt !== undefined && chosen.verdict.at <= lastChangeAt) return unverified("stale-review");
	// An incorrect verdict is incorrect whatever the tree did: only a correct one can be merely outdated.
	if (!chosen.verdict.correct) return unverified("incorrect");
	// A positive verdict is proof only when Storm can bind it to the exact tree it sees now.
	if (treeNow === undefined) return unverified("unbound", { unread: true });
	if (chosen.verdict.tree === undefined) return unverified("unbound");
	if (chosen.verdict.tree !== treeNow) {
		// Another agent moving after the verdict means the team may have changed files; only an outside change is
		// tree-only, and that one buys one re-review round.
		const teamActive = agents.some(agent => agent.id !== chosen.author.id && agent.lastActivityAt > chosen.verdict.at);
		if (teamActive) return unverified("stale-review");
		if (tree?.rereviewedAt === undefined) return unverified("stale-review", { by: "tree" });
		// The one tree-only re-review was already used and the tree moved again: stop instead of re-reviewing forever.
		return unverified("stale-review", { by: "tree", exhausted: true });
	}
	// The verdict must come with the structured review the ledger recorded, bound to the same tree. A legacy verdict
	// without it is readable history, never current pass authority.
	const ledger = reviewEvidenceOf(chosen.author);
	if (!ledger.complete) return unverified("no-proof");
	const record = ledger.records.findLast(entry => entry.correct !== undefined && entry.at === chosen.verdict.at);
	if (!record || record.correct !== chosen.verdict.correct || record.tree !== treeNow) return unverified("no-proof");
	if (p0Remains(verdicts, treeNow)) return unverified("p0");
	if (coverage === undefined) return unverified("no-proof");
	const problem = coverageProblem(coverage, requiredChecks, treeNow, lastChangeAt);
	if (problem) return "lane" in problem ? unverified("lanes", { lane: problem.lane }) : unverified("coverage", { evidence: problem.evidence });
	return { state: "passed" };
}

/** Most rounds the run may take: the user's limit when stated, else the config's extra rounds on top of the first. */
export function maxRounds(spec: { rounds?: number }, config: StormConfig): number {
	const asked = spec.rounds;
	if (typeof asked === "number" && Number.isInteger(asked)) return Math.max(1, asked);
	const extra = config.rounds;
	const valid = typeof extra === "number" && Number.isInteger(extra) && extra >= 0 && extra <= MAX_EXTRA_ROUNDS;
	return 1 + (valid ? extra : DEFAULT_EXTRA_ROUNDS);
}

export type RoundDecision =
	| { action: "end"; reason: RunEndReason }
	| { action: "continue"; gate: Unverified; round: number; maxRounds: number };

/** The one decision after a round, in the order the contract fixes: interruption first, then the gate, then limits. */
export function decideRound(input: {
	gate: Gate;
	/** Rounds finished so far, the one that just ended included. */
	turns: number;
	maxRounds: number;
	aborted: boolean;
	/** The run has passed its team budget. */
	overBudget: boolean;
	elapsedMs: number;
	minutes?: number;
	/** The team's activity when Storm sent its last round message; absent before the first one. */
	progressSince?: { changes: number; reviews: number; requests: number };
}): RoundDecision {
	if (input.aborted) return { action: "end", reason: "interrupted" };
	const gate = input.gate;
	if (gate.state === "none") return { action: "end", reason: gate.why === "quick-only" ? "unreviewed" : gate.why };
	if (gate.state === "passed") return { action: "end", reason: "verified" };
	if (input.overBudget) return { action: "end", reason: "budget" };
	// The one tree-only re-review is spent and the tree moved again. Another round cannot bind a verdict to it, so the
	// honest end is no-progress (stopped), not verified and not another re-review.
	if (gate.exhausted) return { action: "end", reason: "no-progress" };
	if (input.turns >= input.maxRounds) return { action: "end", reason: "round-limit" };
	if (input.minutes !== undefined && input.elapsedMs >= input.minutes * 60_000) return { action: "end", reason: "time-limit" };
	const since = input.progressSince;
	if (since && since.changes === gate.changes && since.reviews === gate.reviews && since.requests === gate.requests) {
		return { action: "end", reason: "no-progress" };
	}
	return { action: "continue", gate, round: input.turns + 1, maxRounds: input.maxRounds };
}

/** The cause sentence of each unverified gate; the instruction depends on the cause in `buildRoundMessage`. */
const CAUSE: Record<UnverifiedCause, string> = {
	"no-review": "Files changed during the run and no review verdict was given.",
	"stale-review": "Files changed after the last review verdict.",
	incorrect: "The last review verdict was `incorrect`.",
	unbound: "The last review verdict is not bound to the exact work tree Storm sees now.",
	"no-proof": "The run has no current proof: a structured review bound to this tree and the run's completed checks are missing.",
	p0: "A P0 finding from a review is still unresolved.",
	coverage: "A required check is not proof: it is missing, failed, older than the last change, or from another tree.",
	lanes: "The run plan still has an unfinished lane.",
};

/** The one-line reason a check entry is not proof; no command output or log text is carried. */
const CHECK_PROBLEM: Record<CoverageEvidence, string> = {
	missing: "A required check was never recorded.",
	failed: "A required check did not pass.",
	stale: "A required check finished before the last file change.",
	mismatched: "A required check ran against another tree.",
};

/** What the gate asks the main session to do; the cause decides, and the tree is always the one Storm sees now. */
function roundInstruction(gate: Unverified, reviewer?: string): string {
	switch (gate.cause) {
		case "incorrect":
			return `Fix its findings through the team, then have \`${reviewer}\` verify again; stop only after a \`correct\` verdict.`;
		case "p0":
			return `Re-check each open P0 on the current tree, fix it through the team, then have \`${reviewer}\` verify that exact tree again; only a later independent review of the same or replacement diff can clear it.`;
		case "coverage":
			return "Use the planned worker to fix what made the required check fail; Storm runs the approved check on the new tree. Re-review only if the change requires it.";
		case "lanes":
			return "Finish the remaining plan lane through the team and let the lane's own role complete it. A review cannot stand in for a lane that never ran.";
		case "unbound":
			return `Have \`${reviewer}\` verify the exact current tree; Storm can count only a verdict it binds to that tree.`;
		case "no-proof":
			return `Have \`${reviewer}\` verify the exact current tree and make the run's required checks pass; a verdict without current tree and check evidence is not proof.`;
		default:
			return `Have \`${reviewer}\` verify the current state against the task, fix what it finds through the team, and stop only after a \`correct\` verdict.`;
	}
}

/** The model-facing section that starts a round: why Storm sent it, what to do, and whether another round follows. */
export function buildRoundMessage(input: {
	runId: string;
	/** The round this message starts (2 for the first one Storm sends). */
	round: number;
	maxRounds: number;
	gate: Unverified;
	/** The reviewer agent's name, e.g. `storm-reviewer`. */
	reviewer?: string | undefined;
}): string {
	const why = input.gate.unread ? "The work tree could not be read, so Storm cannot bind a verdict to it." : CAUSE[input.gate.cause];
	const details: string[] = [];
	if (input.gate.cause === "coverage" && input.gate.evidence !== undefined) details.push(CHECK_PROBLEM[input.gate.evidence]);
	if (input.gate.cause === "lanes" && input.gate.lane !== undefined) details.push(`Unfinished lane: \`${input.gate.lane}\`.`);
	if (input.gate.exhausted) details.push("The one tree-only re-review was already used; no further round can prove this tree.");
	const lines = [
		`<storm-run id="${input.runId}" round="${input.round}/${input.maxRounds}">`,
		`Storm checked the run when you stopped: it is not done. ${why}`,
		...details,
		roundInstruction(input.gate, input.reviewer),
	];
	if (input.round === input.maxRounds) lines.push("This is the last round.");
	lines.push("</storm-run>");
	return lines.join("\n");
}
