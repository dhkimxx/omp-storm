/**
 * The live widget's metric facts. The controller's snapshot is shaped once here, then the ANSI row and the native
 * description read the same chips; only the layout decides which whole chips fit. Animation never reaches this file.
 */
import { formatUsd } from "../policy/spawn.ts";
import type { InfoTone, RunRecord } from "../types.ts";
import { RUN_APPEARANCE, type RunPhase } from "./appearance.ts";

export type LiveMetricKey = "round" | "workers" | "cost" | "time";
export type LiveMetricIcon = "icon.loop" | "icon.agents" | "icon.cost" | "icon.time";
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
	/** In priority order: phase counters first, optional spend and elapsed last. */
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
export function liveMetricFacts(run: RunRecord, phase: RunPhase, now: number): LiveMetricFacts {
	const look = RUN_APPEARANCE[phase];
	const chips = [roundChip(run), workersChip(run), costChip(run), timeChip(run, now)];
	return {
		phase: { label: look.label, tone: look.tone },
		chips,
		key: JSON.stringify([phase, chips.map(chip => [chip.key, chip.forms, chip.tone, chip.state, chip.aria])]),
	};
}
