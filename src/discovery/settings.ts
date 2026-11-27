import { findScopedSettings, type Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgExtensionHandlersToolCallTimeoutMs } from "@oh-my-pi/pi-coding-agent/extensibility/settings";
import {
	cfgTaskIsolationApply,
	cfgTaskIsolationEnabled,
	cfgTaskMaxConcurrency,
	cfgTaskWorkerThreads,
} from "@oh-my-pi/pi-coding-agent/task/settings";
import type { Exec, ExplicitSettings } from "../types.ts";

type Rec = Record<string, unknown>;

/**
 * Two internal modules of the host that only the motion switch needs (`tui.motion`'s presets and the settings
 * registry). They are imported dynamically so a later omp that moves one costs the lane view its motion setting (motion
 * stays on, omp's default) and not the whole extension its load. Everything else in this file is static: a failure there
 * would degrade Storm's core, which a quiet fallback should not hide.
 */
type MotionPresets = typeof import("@oh-my-pi/pi-coding-agent/config/motion-presets");
type Registry = typeof import("@oh-my-pi/pi-coding-agent/config/registry");
const presets: MotionPresets | undefined = await import("@oh-my-pi/pi-coding-agent/config/motion-presets").catch(() => undefined);
const registry: Registry | undefined = await import("@oh-my-pi/pi-coding-agent/config/registry").catch(() => undefined);
const lookup = (id: string): ReturnType<Registry["lookup"]> | undefined => registry?.lookup(id);

function isRec(value: unknown): value is Rec {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parses `omp config list --json`: a flat map of dotted keys to `{ value?, type, description }`.
 * Only model preferences, isolation and retry fallback are read; other keys (auth.* included) are ignored.
 */
export function parseConfigList(text: string): ExplicitSettings {
	const settings: ExplicitSettings = { modelRoles: {} };
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return settings;
	}
	if (!isRec(parsed)) return settings;
	const valueOf = (key: string): unknown => {
		const entry = parsed[key];
		return isRec(entry) && "type" in entry ? entry.value : undefined;
	};

	const roles = valueOf("modelRoles");
	if (isRec(roles)) {
		for (const [role, model] of Object.entries(roles)) {
			if (typeof model === "string" && model) settings.modelRoles[role] = model;
		}
	}
	if (settings.modelRoles.default) settings.defaultModel = settings.modelRoles.default;
	const isolation = valueOf("task.isolation.enabled");
	if (typeof isolation === "boolean") settings.isolationEnabled = isolation;
	const apply = valueOf("task.isolation.apply");
	if (typeof apply === "boolean") settings.isolationApply = apply;
	const modelFallback = valueOf("retry.modelFallback");
	if (typeof modelFallback === "boolean") settings.modelFallback = modelFallback;
	// An entry counts only when it is a list of non-empty selectors; others are dropped whole.
	const chains = valueOf("retry.fallbackChains");
	if (isRec(chains)) {
		settings.fallbackChains = {};
		for (const [key, chain] of Object.entries(chains)) {
			if (!Array.isArray(chain)) continue;
			const list = chain.filter((s): s is string => typeof s === "string" && s.length > 0);
			if (list.length === chain.length) settings.fallbackChains[key] = list;
		}
	}
	return settings;
}

/**
 * omp's effective task-isolation values from the live host settings, without a CLI subprocess. Undefined fields mean
 * this host cannot prove them (for example a test host with no initialized settings), never that they are off.
 */
export function liveIsolationSettings(): Pick<ExplicitSettings, "isolationEnabled" | "isolationApply"> {
	try {
		const settings = findScopedSettings();
		if (settings === undefined) return {};
		return {
			isolationEnabled: cfgTaskIsolationEnabled.get(settings),
			isolationApply: cfgTaskIsolationApply.get(settings),
		};
	} catch {
		return {};
	}
}

/**
 * The effective OMP subagent ceiling (`task.maxConcurrency`) of one settings instance: 0 is unlimited, and an absent
 * instance is unknown, never a Storm-invented default. The getter's own registered default applies only to a real
 * instance, so this module does not restate it.
 */
export function taskMaxConcurrencyOf(settings: Settings | undefined): number | undefined {
	if (settings === undefined) return undefined;
	try {
		const value = cfgTaskMaxConcurrency.get(settings);
		return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The live session's effective OMP subagent ceiling, read without a subprocess. The host wraps extension handlers in
 * the active session's settings scope, so a session/project overlay is honored; an uninitialized host is unknown.
 */
export function liveTaskMaxConcurrency(): number | undefined {
	try {
		return taskMaxConcurrencyOf(findScopedSettings());
	} catch {
		return undefined;
	}
}

/**
 * The live session's effective `task.workerThreads` (`0` keeps every subagent on the main thread), read the same way as
 * the subagent ceiling. An uninitialised host is unknown, never a Storm-invented default; the caller must not refuse a
 * spawn on an unknown value (the child's own stop is the guarantee).
 */
export function liveTaskWorkerThreads(): number | undefined {
	try {
		const settings = findScopedSettings();
		if (settings === undefined) return undefined;
		const value = cfgTaskWorkerThreads.get(settings);
		return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
	} catch {
		return undefined;
	}
}

/** What omp uses when the setting is missing or not a positive finite number (its own `EXTENSION_HANDLER_TIMEOUT_MS`). */
export const HOST_HANDLER_TIMEOUT_MS = 30_000;

/**
 * The time omp gives one extension `tool_call` handler before it blocks the call, as the host computes it: the setting
 * `extensionHandlers.toolCallTimeoutMs` of the live session's settings when it is a positive finite number, else 30 s. The
 * host's own handler keeps running after it blocks, so the director's path edit takes this as its deadline: a continuation
 * that reaches the commit after the host already blocked the call must not leave a hold for a call that never ran. An
 * uninitialised host reads as the default.
 */
export function liveToolCallTimeoutMs(): number {
	try {
		const settings = findScopedSettings();
		const value = settings === undefined ? undefined : cfgExtensionHandlersToolCallTimeoutMs.get(settings);
		return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : HOST_HANDLER_TIMEOUT_MS;
	} catch {
		return HOST_HANDLER_TIMEOUT_MS;
	}
}

export async function readExplicitSettings(exec: Exec, ompBin: string): Promise<ExplicitSettings> {
	try {
		const result = await exec(ompBin, ["config", "list", "--json"], { timeout: 30_000 });
		if (result.code !== 0 || result.killed) return { modelRoles: {} };
		return parseConfigList(result.stdout);
	} catch {
		return { modelRoles: {} };
	}
}

/** The settings instance the current extension scope sees (the active session's), or undefined in a bare host. */
export function scopedSettings(): Settings | undefined {
	try {
		return findScopedSettings();
	} catch {
		return undefined;
	}
}

/**
 * Whether omp's decorative motion may run: `tui.motion` is `full` and `display.shimmer` is not `disabled`. This is the
 * switch Storm's animated pictures (the lane view, the radar) obey, the same one omp's own shimmer obeys. A settings
 * instance that cannot be read means motion on: omp's default, never a Storm-invented "off".
 */
export function motionEffectsEnabled(settings: Settings | undefined): boolean {
	if (settings === undefined) return true;
	try {
		const mode = lookup("tui.motion")?.get(settings);
		const preset = typeof mode === "string" ? presets?.MOTION_PRESETS[mode as keyof MotionPresets["MOTION_PRESETS"]] : undefined;
		if (preset !== undefined && !preset.effects) return false;
		return lookup("display.shimmer")?.get(settings) !== "disabled";
	} catch {
		return true;
	}
}

/**
 * Calls `onChange` after `tui.motion` or `display.shimmer` changed in `settings` (omp coalesces a burst into one call per
 * microtask). Returns the unsubscribe; a no-op when there is no instance or the settings do not exist in this host.
 */
export function onMotionChange(settings: Settings | undefined, onChange: () => void): () => void {
	if (settings === undefined) return () => {};
	const stops: Array<() => void> = [];
	try {
		for (const id of ["tui.motion", "display.shimmer"]) {
			const setting = lookup(id);
			if (setting !== undefined) stops.push(setting.listen(settings, onChange));
		}
	} catch {
		// A host without the setting keeps the widget's current pace; nothing to follow.
	}
	return () => {
		for (const stop of stops.splice(0)) stop();
	};
}
