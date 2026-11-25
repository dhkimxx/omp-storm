/**
 * The parent-session → RunController port for one native attempt.
 *
 * The extension adapter (`attempt-report.ts`) owns host envelopes; the controller owns the run, its plan contract,
 * the pre-attempt baseline and `RunRecord.results`. This module is the narrow type-only seam between them, so neither
 * imports the other's runtime state. Every field is host-derived: `spawnKey` is what OMP admitted, `parentId` the
 * calling parent, and `report` only the adapter's bound capture. Model text never chooses a lane, attempt or path.
 */
import type { AttemptReport, HostArtifactCapture } from "./attempt-report.ts";
import type { AnswerCitation } from "./result-evidence.ts";

/** Where a lane's artifact result is observed: an ordinary shared output or a retained isolated artifact. */
export type AttemptArtifactMode = "shared" | "isolated";

/** One accepted dispatch, prepared immediately before the child runs or the follow-up write executes. */
export interface AttemptPreparation {
	runId: string;
	/** Planned lane the host admitted; the controller resolves its current result contract. */
	lane: string;
	/** `before_subagent_spawn.spawnKey` or the follow-up agent id the parent actually admitted. */
	spawnKey: string;
	/** `ctx.agent.id` of the parent session at admission. */
	parentId: string;
	/** Stable bridge handle for this spawn/follow-up turn; the controller keys the baseline by it. */
	dispatch: string;
	/** False for a fresh `task` child, true for a `write agent://<id>` turn on a reused agent. */
	followUp: boolean;
	/** The plan's isolation placement for this lane; never guessed from model text. */
	artifactMode: AttemptArtifactMode;
	/** Epoch ms of admission: earlier host captures are stale. */
	startedAt: number;
	/** Parent capture of `ref.history.patchPath` at admission; `null` when the registry had no patch. */
	admissionPatch?: HostArtifactCapture | null;
}

/** A refused baseline must stop the spawn/write before work: the run would otherwise have no before state. */
export type AttemptAdmission = { ok: true } | { ok: false; reason: string };

/**
 * Exactly one settlement per dispatch, from the exact native attempt or a bounded missing/stale report.
 * `reportText`/`citations` are host-authored candidates only: the evaluator re-reads every cited source.
 */
export interface AttemptSettlement {
	runId: string;
	lane: string;
	spawnKey: string;
	parentId: string;
	dispatch: string;
	startedAt: number;
	observedAt: number;
	report: AttemptReport;
	/** The host-authored output/content, whole: answer evidence digests and checks the full text. */
	reportText?: string;
	/**
	 * The host delivered only part of the output (a preview or a tail) and the whole could not be read safely from its
	 * output file: `reportText` is that part, judged only by review with the agent's handle.
	 */
	reportPartial?: true;
	citations: readonly AnswerCitation[];
}
