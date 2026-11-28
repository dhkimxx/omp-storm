import { findScopedSettings, type Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgExtensionHandlersToolCallTimeoutMs } from "@oh-my-pi/pi-coding-agent/extensibility/settings";
import {
	cfgTaskIsolationApply,
	cfgTaskIsolationEnabled,
	cfgTaskMaxConcurrency,
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

// ── Isolated integration: exact director-scoped isolation policy ───────────────────────────────
//
// The spawn hook must compare the Settings instance the host resolved policy from, not whichever
// instance a cwd/agent-dir lookup happens to find: `findScopedSettings()` returns the active scope
// inside an extension handler but falls back to the global singleton outside one (host
// `config/settings.ts:4521-4523`). The exact session handle is available from the process registry;
// its `settings` is the same object the session uses at dispatch.
//
// On 19.2.1 an honest proof cannot be finished. `task.isolation.enabled`, `apply` and `merge` are
// captured by `resolveEffectiveSubagentPolicy` before `before_subagent_spawn`, and the captured
// values are what dispatch uses after the child ends. The backend is different: `openIsolatedWorkspace`
// reads `isolation.backend` again after several awaits (`task/structured-subagent.ts:1047` and
// `:852-855`), so a setting change between the hook and that read can switch a native clone to an
// ovnfs checkout. A Settings revision or an `onEffectiveChange` subscription held through the hook
// cannot observe that later read. The port therefore stays `unknown` for every managed private launch
// until the host exposes one captured backend/factory token (see the slice report for the exact seam).
// The observation below is still exact for arm/ABA checks and is what the seam will reuse.

import { AgentRegistry } from "@oh-my-pi/pi-coding-agent";
import { isLocalAgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session-handle";
import {
	cfgIsolationBackend,
	cfgOvnfsPath,
	cfgTaskIsolationCommits,
	cfgTaskIsolationMerge,
} from "@oh-my-pi/pi-coding-agent/task/settings";
import { buildId } from "../build.ts";
import type {
	ApplyPolicyPort,
	DirectorIdentity,
	IntegrationCheck,
	IntegrationProblem,
	IntegrationRead,
} from "../runtime/integration-admission.ts";

/** The loaded child guard's build tag. A child entry claim must echo this exact string. */
export const INTEGRATION_GUARD_BUILD = `storm-integration-guard/${buildId()}`;

/** Stable diagnostic code: the host pin has no per-dispatch backend/factory token. */
export const ISOLATION_BACKEND_UNPROVEN = "isolation-backend-unproven";
/** Stable diagnostic code: the relevant isolation settings changed before the grant (ABA included). */
export const ISOLATION_POLICY_CHANGED = "isolation-policy-changed";
/** Stable diagnostic code: the live settings instance is not the exact handler-scoped one. */
export const ISOLATION_SCOPE_UNKNOWN = "isolation-scope-unknown";
/** Stable diagnostic code: a private launch is refused while the backend proof is missing. */
export const ISOLATION_BACKEND_SEAM_MISSING =
	"이 호스트에는 격리 백엔드를 스폰 시점에 한 번 정하고 그대로 디스패치하는 값이 없습니다. 스폰 훅 뒤 openIsolatedWorkspace가 설정을 다시 읽어 native 클론이 ovnfs 체크아웃으로 바뀔 수 있으므로, 관리 격리 실행을 시작하지 않았습니다. 호스트가 해결된 백엔드/워크스페이스 팩토리와 불투명 토큰을 스폰 이벤트로 넘기기 전에는 같은 호출을 다시 보내도 시작하지 않습니다.";

export type IsolationMerge = "patch" | "branch";
export type IsolationCommitStyle = "generic" | "ai";
export type IsolationNativeBackend =
	| "apfs"
	| "btrfs"
	| "zfs"
	| "reflink"
	| "overlayfs"
	| "projfs"
	| "block-clone"
	| "rcopy";
export type IsolationBackend = "auto" | IsolationNativeBackend;

/** The exact isolation-relevant values of one Settings instance at one observation. */
export interface IsolationPolicySnapshot {
	readonly enabled: boolean | undefined;
	readonly apply: boolean | undefined;
	readonly merge: IsolationMerge | undefined;
	readonly backend: IsolationBackend | undefined;
	readonly commits: IsolationCommitStyle | undefined;
	readonly ovnfsPath: string | undefined;
}

/**
 * One exact observation of the director session's Settings instance. `changed` is monotonic: any
 * effective change of a relevant setting after arming sets it, so a false→true→false sequence is
 * refused instead of looking unchanged at the end. `check` compares the live instance identity too.
 */
export interface DirectorIsolationObservation {
	readonly settings: Settings;
	readonly settingsInstance: string;
	readonly sessionInstance: string;
	readonly relevantEpoch: number;
	readonly snapshot: IsolationPolicySnapshot;
	/** True once a relevant effective change was seen after this observation was armed. */
	readonly changed: boolean;
	/** Re-read the exact instance, identity and the monotonic change flag. Never yields. */
	check(): IntegrationCheck;
	stop(): void;
}

function isolationProblem(code: string, reason: string): IntegrationProblem {
	return { code, reason };
}

function backendProblem(): IntegrationProblem {
	return isolationProblem(ISOLATION_BACKEND_UNPROVEN, ISOLATION_BACKEND_SEAM_MISSING);
}

function snapshotOf(settings: Settings): IsolationPolicySnapshot {
	return {
		enabled: cfgTaskIsolationEnabled.get(settings),
		apply: cfgTaskIsolationApply.get(settings),
		merge: cfgTaskIsolationMerge.get(settings),
		backend: cfgIsolationBackend.get(settings) as IsolationBackend,
		commits: cfgTaskIsolationCommits.get(settings),
		ovnfsPath: cfgOvnfsPath.get(settings),
	};
}

/**
 * Resolve the exact registry parent and verify its native session identity. They are different namespaces.
 * A remote handle or a parked ref carries no local Settings and cannot authorize a launch.
 */
function liveSessionHandle(sessionId: string, parentId: string): { settings: Settings; instanceKey: string } | undefined {
	try {
		const ref = AgentRegistry.global().get(parentId);
		const handle = ref?.session;
		if (ref?.kind !== "main" || handle == null || !isLocalAgentSession(handle) ||
			handle.sessionManager.getSessionId() !== sessionId || handle.settings === undefined) return undefined;
		return { settings: handle.settings, instanceKey: handle.instanceKey };
	} catch {
		return undefined;
	}
}

/**
 * Arm one exact observation of the director session's isolation policy. The caller must be inside
 * the host's session-settings scope (the extension handler is); `scopedSettings()` then returns that
 * exact instance, and comparing it to the registered session's `settings` proves the identity.
 */
export function observeDirectorIsolation(input: {
	readonly director: DirectorIdentity;
	readonly toolCallId: string;
}): IntegrationRead<DirectorIsolationObservation> {
	const { director } = input;
	if (input.toolCallId.trim() === "") {
		return { kind: "unknown", problem: isolationProblem(ISOLATION_SCOPE_UNKNOWN, "스폰 항목의 호출 키가 비어 있어 격리 정책의 범위를 확인하지 못했습니다.") };
	}
	const live = liveSessionHandle(director.sessionId, director.parentId);
	if (live === undefined) {
		return { kind: "unknown", problem: isolationProblem(ISOLATION_SCOPE_UNKNOWN, "감독 세션의 실제 Settings 인스턴스를 확인하지 못했습니다(등록된 로컬 세션이 아니거나 설정을 읽을 수 없음).") };
	}
	if (director.sessionInstance !== live.instanceKey) {
		return { kind: "unknown", problem: isolationProblem(ISOLATION_SCOPE_UNKNOWN, "감독 세션 인스턴스가 배치 시점과 다릅니다.") };
	}
	const scoped = scopedSettings();
	if (scoped === undefined || scoped !== live.settings) {
		return { kind: "unknown", problem: isolationProblem(ISOLATION_SCOPE_UNKNOWN, "핸들러의 Settings 범위가 감독 세션의 인스턴스와 같지 않습니다. 전역 설정으로 추정하지 않았습니다.") };
	}
	const settings = live.settings;
	let snapshot: IsolationPolicySnapshot;
	try {
		snapshot = snapshotOf(settings);
	} catch {
		return { kind: "unknown", problem: isolationProblem(ISOLATION_SCOPE_UNKNOWN, "격리 설정 값을 읽지 못했습니다.") };
	}
	let epoch = 0;
	let changed = false;
	let stopped = false;
	let unsubscribe: (() => void) | undefined;
	try {
		unsubscribe = settings.onEffectiveChange(
			[cfgTaskIsolationEnabled, cfgTaskIsolationApply, cfgTaskIsolationMerge, cfgIsolationBackend, cfgTaskIsolationCommits, cfgOvnfsPath],
			() => {
				epoch += 1;
				changed = true;
			},
		);
	} catch {
		return { kind: "unknown", problem: isolationProblem(ISOLATION_SCOPE_UNKNOWN, "격리 설정 변경을 관찰하지 못했습니다.") };
	}
	const observation: DirectorIsolationObservation = {
		settings,
		settingsInstance: `${live.instanceKey}#${director.sessionId}`,
		sessionInstance: live.instanceKey,
		get relevantEpoch(): number {
			return epoch;
		},
		snapshot,
		get changed(): boolean {
			return changed;
		},
		check: () => {
			if (stopped) return { ok: false, problem: isolationProblem(ISOLATION_SCOPE_UNKNOWN, "격리 정책 관찰이 이미 끝났습니다.") };
			const now = liveSessionHandle(director.sessionId, director.parentId);
			if (now === undefined || now.settings !== settings || now.instanceKey !== director.sessionInstance) {
				return { ok: false, problem: isolationProblem(ISOLATION_SCOPE_UNKNOWN, "감독 세션의 Settings 인스턴스가 바뀌었습니다.") };
			}
			if (scopedSettings() !== settings) {
				return { ok: false, problem: isolationProblem(ISOLATION_SCOPE_UNKNOWN, "핸들러 범위가 감독 세션의 Settings 인스턴스와 같지 않습니다.") };
			}
			if (changed) return { ok: false, problem: isolationProblem(ISOLATION_POLICY_CHANGED, "배치 뒤 격리 설정이 실제로 바뀌었습니다(원래 값으로 돌아온 경우 포함). 포착된 apply/merge가 이번 디스패치의 값과 같다는 보장이 없어 시작하지 않습니다.") };
			return { ok: true };
		},
		stop: () => {
			if (stopped) return;
			stopped = true;
			unsubscribe?.();
		},
	};
	return { kind: "known", value: observation };
}

/**
 * The proof a later host seam would mint once it can carry the resolved backend/factory token. This
 * pin cannot: it returns the fail-closed problem instead of fabricating a `backendProofId`. Kept as
 * one function so the seam changes only here.
 */
function proofProblem(observation: DirectorIsolationObservation): IntegrationProblem {
	const { snapshot } = observation;
	if (snapshot.enabled !== true) return isolationProblem("isolation-disabled", "task.isolation.enabled가 true가 아닙니다.");
	if (snapshot.apply !== false) return isolationProblem("isolation-apply-on", "task.isolation.apply가 false가 아닙니다.");
	if (snapshot.merge !== "patch") return isolationProblem("isolation-merge-not-patch", "task.isolation.merge가 patch가 아닙니다.");
	if (snapshot.commits === "ai") return isolationProblem("isolation-ai-commit-helper", "task.isolation.commits=ai는 실행 예산 밖의 커밋 도우미를 시작할 수 있습니다.");
	if (snapshot.backend === undefined || snapshot.backend === "auto") {
		return isolationProblem(ISOLATION_BACKEND_UNPROVEN, "isolation.backend가 auto이거나 읽히지 않아 ovnfs 경로를 배제하지 못했습니다.");
	}
	return backendProblem();
}

/** The launch problem for one armed observation, without minting a proof or a new listener. */
export function isolationLaunchProblem(observation: DirectorIsolationObservation): IntegrationProblem {
	return proofProblem(observation);
}

/** E's apply-policy port. Every managed private launch is refused on 19.2.1: no later-read proof exists. */
export const integrationApplyPolicy: ApplyPolicyPort = {
	arm(input) {
		const observed = observeDirectorIsolation(input);
		if (observed.kind === "unknown") return observed;
		const observation = observed.value;
		const problem = proofProblem(observation);
		// The observation is only useful to the seam. Do not leave a listener behind for a proof that was never minted.
		observation.stop();
		return { kind: "unknown", problem };
	},
	checkBeforeGrant(proof, item) {
		// No proof can be minted on this pin; a proof reaching here is not this build's. The item check keeps the
		// contract explicit for the host seam that will mint one.
		if (proof.toolCallId !== item.toolCallId || proof.backendProofId.trim() === "") {
			return { ok: false, problem: isolationProblem(ISOLATION_SCOPE_UNKNOWN, "격리 증명이 이 스폰 항목과 결속되지 않았습니다.") };
		}
		return { ok: false, problem: backendProblem() };
	},
};


/**
 * The exact director identity for one main session, from the live local session handle. Never substitutes
 * the global instance or another session's dir; an unknown handle is a refusal for the caller.
 */
export function directorIdentityFor(input: {
	readonly sessionId: string;
	readonly sessionDir: string;
	readonly parentId: string;
}): IntegrationRead<DirectorIdentity> {
	const live = liveSessionHandle(input.sessionId, input.parentId);
	if (live === undefined) {
		return { kind: "unknown", problem: isolationProblem(ISOLATION_SCOPE_UNKNOWN, "감독 세션의 실제 인스턴스를 확인하지 못했습니다.") };
	}
	return {
		kind: "known",
		value: {
			sessionId: input.sessionId,
			sessionInstance: live.instanceKey,
			sessionDir: input.sessionDir,
			parentId: input.parentId,
		},
	};
}
