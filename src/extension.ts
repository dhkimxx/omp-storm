/**
 * OMP Storm extension: the /storm command and spawn-time enforcement of the approved team.
 */
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { type FlowEnv, reviewFlow, rollbackFlow, setupFlow, statusFlow } from "./flows.ts";
import { execPort, ompBinary } from "./omp.ts";
import { decideSpawn } from "./policy/spawn.ts";
import { ROLE_AGENT_PREFIX } from "./roles.ts";
import { createStateCache, loadProjectState, type ProjectEnv, type ProjectState } from "./state.ts";
import { createUiPort } from "./ui.ts";

const PLUGIN_AGENTS_DIR = fileURLToPath(new URL("../agents/", import.meta.url));
const SUBCOMMANDS = ["status", "setup", "review", "rollback"] as const;

function statusLabel(state: ProjectState): string | undefined {
	if (state.config.status === "missing") return undefined;
	if (state.config.status === "invalid") return "storm: 설정 오류";
	return state.approval ? "storm ✓" : "storm: 승인 필요";
}

export default function storm(pi: ExtensionAPI): void {
	const exec = execPort(pi);
	const stateCache = createStateCache();
	const projectEnv = (ctx: ExtensionContext): ProjectEnv => ({
		cwd: ctx.cwd,
		exec,
		agentDir: pi.pi.getAgentDir(),
		pluginAgentsDir: PLUGIN_AGENTS_DIR,
	});
	const flowEnv = (ctx: ExtensionContext): FlowEnv => ({
		...projectEnv(ctx),
		ompBin: ompBinary(),
		ompVersion: pi.pi.VERSION,
		mode: ctx.mode,
		registry: ctx.modelRegistry,
		activeTools: pi.getActiveTools(),
		now: Date.now,
	});

	pi.on("before_subagent_spawn", async (event, ctx) => {
		if (!event.agent.startsWith(ROLE_AGENT_PREFIX)) return undefined;
		const state = await stateCache.get(projectEnv(ctx));
		return decideSpawn(event, { config: state.config, approval: state.approval, shadows: state.shadows });
	});

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		try {
			ctx.ui.setStatus("storm", statusLabel(await loadProjectState(projectEnv(ctx))));
		} catch {
			// The status line is a hint; /storm status reports the actual error.
		}
	});

	pi.registerCommand("storm", {
		description: "Storm 멀티에이전트 팀 설정·현황·승인 (/storm [status|setup|review|rollback])",
		getArgumentCompletions: prefix =>
			SUBCOMMANDS.filter(name => name.startsWith(prefix)).map(name => ({ value: name, label: name })),
		handler: async (args, ctx) => {
			const ui = createUiPort(pi, ctx);
			const env = flowEnv(ctx);
			const sub = args.trim();
			try {
				if (sub === "status") {
					await statusFlow(env, ui);
					return;
				}
				if (!(SUBCOMMANDS as readonly string[]).includes(sub) && sub !== "") {
					ui.notify("자연어 요청은 v0.2에서 지원합니다. 지금은 /storm, /storm status·setup·review·rollback 을 쓰세요.", "warning");
					return;
				}
				if (!ctx.hasUI) {
					ui.notify("승인 창을 띄울 수 없는 모드라 아무것도 바꾸지 않습니다. /storm status 는 쓸 수 있습니다.", "warning");
					return;
				}
				if (sub === "setup") await setupFlow(env, ui);
				else if (sub === "review") await reviewFlow(env, ui);
				else if (sub === "rollback") await rollbackFlow(env, ui);
				else {
					const state = await loadProjectState(env);
					if (state.config.status === "missing" || state.config.status === "invalid") await setupFlow(env, ui);
					else if (!state.approval) await reviewFlow(env, ui);
					else await statusFlow(env, ui);
				}
			} catch (error) {
				ui.notify(`Storm 오류: ${error instanceof Error ? error.message : String(error)}`, "error");
			} finally {
				stateCache.clear();
				if (ctx.hasUI) {
					try {
						ctx.ui.setStatus("storm", statusLabel(await loadProjectState(projectEnv(ctx))));
					} catch {
						// Status refresh is best-effort.
					}
				}
			}
		},
	});
}
