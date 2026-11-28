/**
 * The live widget's metric facts. The controller's snapshot is shaped once here, then the ANSI row and the native
 * description read the same chips; only the layout decides which whole chips fit. Animation never reaches this file.
 */
import { formatUsd } from "../policy/spawn.ts";
import { INTEGRATION_CANDIDATES, NO_DECLARED_RESULTS, OUT_OF_PLAN_LABEL, TREE_CHANGE_LABEL, WORKER_CHANGE_LABEL, WORKER_LABEL, resultFacts, type ResultFactOptions, type ResultFacts } from "../runtime/result-facts.ts";
import type { InfoTone, RunRecord } from "../types.ts";
import { RUN_APPEARANCE, type RunPhase } from "./appearance.ts";
import { RETAINED_ACCEPTED, RETAINED_LABEL } from "./results.ts";

export type LiveMetricKey = "results" | "round" | "workers" | "cost" | "time";
export type LiveMetricIcon = "icon.goal" | "icon.loop" | "icon.agents" | "icon.cost" | "icon.time";
export type LiveMetricTone = InfoTone | "dim";
/** Spend only: the run crossed the approved warning line, or the approved hard limit. */
export type LiveSpendState = "warn" | "over";

/** One whole way to show a chip's value; the layout may pick a shorter form, never a clipped fragment. */
export interface LiveMetricForm {
	readonly value: string;
	/** Muted unit after the value, so the number keeps the focus ("라운드"). */
	readonly suffix?: string;
}

export interface LiveMetricChip {
	readonly key: LiveMetricKey;
	readonly icon: LiveMetricIcon;
	/** Longest first. */
	readonly forms: readonly LiveMetricForm[];
	/** One accessible sentence for native aria, independent of the form the layout chose. */
	readonly aria: string;
	readonly tone: LiveMetricTone;
	readonly state?: LiveSpendState;
}

export interface LiveMetricFacts {
	readonly phase: { readonly label: string; readonly tone: LiveMetricTone };
	/** In priority order: result progress first, then phase counters, optional spend, and elapsed last. */
	readonly chips: readonly LiveMetricChip[];
	/** The values the widget dedupes updates on; animation ticks never rebuild it. */
	readonly key: string;
}

export const LIVE_STATE_LABEL: Record<LiveSpendState, string> = { warn: "경고", over: "초과" };

/** At or past the warning threshold, or over the hard run budget: mirrors render.ts `spendTone`, adds no policy. */
function spendState(run: RunRecord): LiveSpendState | undefined {
	const budget = run.budget;
	if (!budget || !Number.isFinite(run.costUsd) || !Number.isFinite(budget.perRunUsd) || budget.perRunUsd <= 0) return undefined;
	if (run.costUsd > budget.perRunUsd) return "over";
	const warnAt = budget.warnAtUsd;
	if (warnAt != null && Number.isFinite(warnAt) && warnAt > 0 && run.costUsd >= warnAt) return "warn";
	return undefined;
}

function money(value: number, digits: number): string {
	return Number.isFinite(value) ? `$${value.toFixed(digits)}` : "$?";
}

/**
 * Official result progress, never a lane's model-supplied progress. The full form carries the focus criterion, its
 * state, and the accepted/in-scope count; narrower forms keep the count and the state word so a small terminal still
 * shows what is blocked rather than only worker telemetry.
 */
function resultChip(facts: ResultFacts): LiveMetricChip | undefined {
	const progress = facts.progress;
	if (!facts.hasDeclared) {
		if (!facts.noResultsNotice) return undefined;
		const workers = `${WORKER_LABEL} ${facts.activity.placed}`;
		const changed =
			facts.changedPaths === undefined
				? facts.activity.changed === 0
					? undefined
					: `${WORKER_CHANGE_LABEL} ${facts.activity.changed}`
				: `${TREE_CHANGE_LABEL} ${facts.changedPaths}`;
		const out = facts.outOfPlan === 0 ? undefined : `${OUT_OF_PLAN_LABEL} ${facts.outOfPlan}`;
		const integration =
			facts.integration?.kind === "recorded"
				? `${INTEGRATION_CANDIDATES} ${Math.max(0, Math.floor(facts.integration.candidates ?? 0))}`
				: undefined;
		const tail = [workers, changed, out, integration].filter((part): part is string => part !== undefined).join(" · ");
		const forms: LiveMetricForm[] =
			tail === workers
				? [{ value: NO_DECLARED_RESULTS, suffix: ` · ${workers}` }, { value: NO_DECLARED_RESULTS }]
				: [
						{ value: NO_DECLARED_RESULTS, suffix: ` · ${tail}` },
						{ value: NO_DECLARED_RESULTS, suffix: ` · ${workers}` },
						{ value: NO_DECLARED_RESULTS },
					];
		return {
			key: "results",
			icon: "icon.goal",
			forms,
			aria: `${NO_DECLARED_RESULTS}, ${tail}`,
			tone: "dim",
		};
	}
	const counts = progress.counts;
	const label = progress.focus?.label ?? "결과";
	const focusState = progress.focus?.state;
	const state = progress.focus?.excluded === true ? "사용자 제외" : (progress.focus?.stateLabel ?? "결과");
	const excluded = counts.excluded === 0 ? "" : ` · 제외 ${counts.excluded}`;
	const mixed = facts.outOfPlan === 0 ? "" : ` · ${OUT_OF_PLAN_LABEL} ${facts.outOfPlan}`;
	// Row 1: retained artifact acceptance is not tree work; the count carries that word instead of a bare `이행`.
	// Every narrower form keeps the word too: a compact `1/1` would read as integrated work (B7).
	const retainedOnly = facts.retained.count > 0 && facts.retained.count === counts.accepted;
	const retainedPart = facts.retained.count > 0 && !retainedOnly ? ` · ${RETAINED_LABEL} ${facts.retained.count}` : "";
	const retainedCount = `${RETAINED_ACCEPTED} ${counts.accepted}/${counts.inScope}`;
	const plainCount = `${counts.accepted}/${counts.inScope}`;
	const progressText = retainedOnly ? retainedCount : `이행 ${plainCount}${retainedPart}`;
	const integrationPart =
		facts.integration?.kind === "recorded"
			? ` · ${INTEGRATION_CANDIDATES} ${Math.max(0, Math.floor(facts.integration.candidates ?? 0))}`
			: "";
	const full = (focusState === "accepted" ? ` ${progressText}${excluded}` : ` ${state} · ${progressText}${excluded}`) + mixed + integrationPart;
	const forms: LiveMetricForm[] =
		counts.inScope > 0
			? retainedOnly
				? [
						{ value: label, suffix: full },
						{ value: retainedCount, suffix: `${excluded}${mixed}` },
						{ value: retainedCount },
					]
				: [
						{ value: label, suffix: full },
						{ value: plainCount, suffix: ` ${state}${retainedPart}${excluded}${mixed}` },
						facts.retained.count > 0
							? { value: plainCount, suffix: `${RETAINED_LABEL} ${facts.retained.count}` }
							: { value: plainCount },
					]
			: [
					{ value: label, suffix: ` 사용자 제외 ${counts.excluded}${mixed}` },
					{ value: `제외 ${counts.excluded}` },
				];
	const tone: LiveMetricTone = progress.tone === "muted" ? "dim" : progress.tone;
	return { key: "results", icon: "icon.goal", forms, aria: progress.aria, tone };
}

function roundChip(run: RunRecord): LiveMetricChip {
	const turns = run.turns ?? 0;
	const current = run.maxRounds === undefined ? turns + 1 : Math.min(turns + 1, run.maxRounds);
	const value = run.maxRounds === undefined ? `${current}` : `${current}/${run.maxRounds}`;
	return {
		key: "round",
		icon: "icon.loop",
		forms: [{ value, suffix: "라운드" }, { value }],
		aria: `라운드 ${value}`,
		tone: "accent",
	};
}

/** Running over total, explicit even for 0/0; the total counts every agent still in the ledger. */
function workersChip(run: RunRecord): LiveMetricChip {
	const agents = run.agents ?? [];
	const running = agents.filter(agent => agent.state === "running").length;
	const value = `${running}/${agents.length}`;
	return {
		key: "workers",
		icon: "icon.agents",
		forms: [{ value }],
		aria: `워커 실행 중 ${value}`,
		tone: "accent",
	};
}

function costChip(run: RunRecord): LiveMetricChip {
	const state = spendState(run);
	const budget = run.budget;
	const limit = budget && Number.isFinite(budget.perRunUsd) && budget.perRunUsd > 0 ? formatUsd(budget.perRunUsd) : undefined;
	const spent = Number.isFinite(run.costUsd) ? formatUsd(run.costUsd) : "$?";
	const full = `${spent}${limit ? `/${limit}` : ""}`;
	const compact = limit ? `${money(run.costUsd, 2)}/${limit}` : money(run.costUsd, 2);
	const minimal = money(run.costUsd, 2);
	const forms = limit ? [{ value: full }, { value: compact }, { value: minimal }] : [{ value: full }, { value: minimal }];
	const tone: LiveMetricTone = state === "over" ? "error" : state === "warn" ? "warning" : "accent";
	const stateText = state === undefined ? "" : `, 예산 ${LIVE_STATE_LABEL[state]}`;
	return {
		key: "cost",
		icon: "icon.cost",
		forms,
		aria: `비용 ${spent}${limit ? ` / 예산 ${limit}` : ""}${stateText}`,
		tone,
		...(state === undefined ? {} : { state }),
	};
}

function timeChip(run: RunRecord, now: number): LiveMetricChip {
	const started = Date.parse(run.startedAt);
	const minutes = Number.isFinite(started) ? Math.max(0, Math.floor((now - started) / 60_000)) : 0;
	const value = `${minutes}분`;
	return {
		key: "time",
		icon: "icon.time",
		forms: [{ value }],
		aria: `경과 ${value}`,
		tone: "dim",
	};
}

/** Shape the snapshot once per controller update; the same facts feed ANSI and native output. */
export function liveMetricFacts(run: RunRecord, phase: RunPhase, now: number, options: ResultFactOptions = {}): LiveMetricFacts {
	const look = RUN_APPEARANCE[phase];
	const facts = resultFacts(run, options);
	const results = resultChip(facts);
	const chips = [results, roundChip(run), workersChip(run), costChip(run), timeChip(run, now)].filter(
		(chip): chip is LiveMetricChip => chip !== undefined,
	);
	return {
		phase: { label: look.label, tone: look.tone },
		chips,
		// The ledger key includes the displayed result label/state/count: settlement repaints even if counters are stable.
		key: JSON.stringify([phase, facts.key, chips.map(chip => [chip.key, chip.forms, chip.tone, chip.state, chip.aria])]),
	};
}
