/**
 * Probe extension for `scripts/e2e/integration.ts` policy scenarios. Test support only: it makes no model call and
 * does not replace Storm's handlers.
 *
 * It is loaded after Storm (`-e`), so Storm's `before_subagent_spawn` handler has already run when this one does. It
 * records the exact Settings identity and values the hook can see, and, when asked, mutates the live instance in the
 * window after Storm's hook:
 *
 *   - `identity`: only record scoped/global/session Settings identity and the isolation values.
 *   - `aba`:      set `task.isolation.apply` true then false; record the intervening read as proof it changed.
 *   - `late-auto`: set `isolation.backend` to `auto` and `ovnfs.path` to a fake executable after the grant.
 *                  A compatible host must use the native factory it already froze for this dispatch.
 *
 * The log is JSONL at `INTEGRATION_POLICY_LOG`; no path is read from the model.
 */
import { appendFileSync } from "node:fs";
import { AgentRegistry, Settings, type ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { findScopedSettings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgIsolationBackend, cfgOvnfsPath, cfgTaskIsolationApply, cfgTaskIsolationEnabled } from "@oh-my-pi/pi-coding-agent/task/settings";

const LOG = process.env.INTEGRATION_POLICY_LOG ?? "";
const MODE = process.env.INTEGRATION_POLICY_MODE ?? "identity";
const FAKE_OVNFS = process.env.INTEGRATION_FAKE_OVNFS ?? "";

const log = (entry: Record<string, unknown>): void => {
	if (LOG !== "") appendFileSync(LOG, `${JSON.stringify({ t: Date.now(), mode: MODE, ...entry })}\n`);
};

function globalIdentity(): Settings | undefined {
	try {
		return Settings.instance;
	} catch {
		return undefined;
	}
}

export default function probe(pi: ExtensionAPI): void {
	pi.on("before_subagent_spawn", async (event, ctx) => {
		const scoped = findScopedSettings();
		if (scoped === undefined) {
			log({ event: "before_subagent_spawn", agent: event.agent, scoped: "missing", cwd: ctx.cwd });
			return undefined;
		}
		const directory = AgentRegistry.global().get("Main")?.session;
		const directorSettings = directory !== null && directory !== undefined && "settings" in directory && directory.settings instanceof Settings ? directory.settings : undefined;
		const before = {
			enabled: cfgTaskIsolationEnabled.get(scoped),
			apply: cfgTaskIsolationApply.get(scoped),
			backend: cfgIsolationBackend.get(scoped),
			ovnfsPath: cfgOvnfsPath.get(scoped) ?? null,
		};
		let duringApply: boolean | undefined;
		if (MODE === "aba") {
			cfgTaskIsolationApply.set(scoped, true);
			duringApply = cfgTaskIsolationApply.get(scoped);
			cfgTaskIsolationApply.set(scoped, false);
		}
		if (MODE === "late-auto") {
			cfgIsolationBackend.set(scoped, "auto");
			if (FAKE_OVNFS !== "") cfgOvnfsPath.set(scoped, FAKE_OVNFS);
		}
		const after = {
			apply: cfgTaskIsolationApply.get(scoped),
			backend: cfgIsolationBackend.get(scoped),
			ovnfsPath: cfgOvnfsPath.get(scoped) ?? null,
		};
		log({
			event: "before_subagent_spawn",
			agent: event.agent,
			invocationKind: event.invocationKind,
			spawnKey: event.spawnKey ?? null,
			cwd: ctx.cwd,
			scopedIsGlobal: scoped === globalIdentity(),
			directorSettingsSame: directorSettings === undefined ? "no-local-session-settings" : directorSettings === scoped,
			before,
			duringApply,
			after,
		});
		return undefined;
	});
	pi.on("session_start", async (_event, ctx) => {
		log({ event: "session_start", kind: ctx.agent.kind, id: ctx.agent.id ?? null, cwd: ctx.cwd, processCwd: process.cwd() });
	});
	pi.on("agent_start", async (_event, ctx) => {
		if (ctx.agent.kind === "sub") log({ event: "agent_start", kind: ctx.agent.kind, id: ctx.agent.id ?? null, cwd: ctx.cwd, processCwd: process.cwd() });
	});
}
