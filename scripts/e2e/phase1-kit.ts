/**
 * What the phase-1 scenarios (unplanned.ts, early-start.ts, director-reads.ts, plan-mode.ts) and the hardening ones
 * (hardening-pins.ts, hardening-writers.ts) share: one native session that every scenario of a script resumes, so the
 * approved team and the automatic-delegation choice persist, the request that opens a manual run with a scripted
 * director, and a way to change omp's own settings between two sessions of one script.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	type Answer,
	approveTeam,
	type E2eEnv,
	linkPlugin,
	modelsYml,
	PROFILE_CONFIG,
	Rpc,
	type Step,
	StormFiles,
	TEAM_PROVIDERS,
} from "./harness.ts";

/** The main model of every scenario: the fake provider only. */
export const MAIN = "fake/general-b";

/** One native session, opened again by each scenario, and the exit code of every process that served it. */
export class Sessions {
	owned: { id: string; dir: string } | undefined;
	readonly exitCodes: number[] = [];

	/** `main` is the model the session itself runs on: the fake provider's by default, another one when a scenario needs a model outside the team. */
	constructor(
		private readonly env: E2eEnv,
		private readonly main: string = MAIN,
	) {}

	/** Opens (or resumes) the session, runs `body`, and closes the process; its exit code is recorded. */
	async open<T>(answer: Answer, body: (rpc: Rpc, files: StormFiles) => Promise<T>, flags: string[] = []): Promise<T> {
		const rpc = new Rpc(this.env, answer, { model: this.main, ...(flags.length === 0 ? {} : { flags }), ...(this.owned === undefined ? {} : { resume: this.owned.id, sessionDir: this.owned.dir }) });
		try {
			await rpc.ready();
			return await body(rpc, new StormFiles(this.env, rpc.sessionId));
		} finally {
			this.exitCodes.push(await rpc.close());
			if (this.owned === undefined) this.owned = { id: rpc.sessionId, dir: rpc.sessionDir };
		}
	}

	/** The first scenario: approves the recommended team in this session and turns automatic delegation on or off. */
	async approve(auto: "on" | "off"): Promise<{ teams: number }> {
		return this.open(() => undefined, async (rpc, files) => {
			await approveTeam(rpc, auto);
			// A real turn materializes the native transcript so later scenarios can resume this exact session.
			await rpc.turn("hello");
			return { teams: files.approvals().length };
		});
	}
}

/** Writes the fake provider's models and the profile config, and links the plugin under test. */
export function installProfile(env: E2eEnv, extraConfig = ""): void {
	writeFileSync(join(env.agentDir, "models.yml"), modelsYml(env.port, TEAM_PROVIDERS));
	setOmpSettings(env, extraConfig);
	linkPlugin(env);
}

/**
 * Rewrites the profile's omp settings (the YAML after `setupVersion`) between two sessions of one script: omp reads them
 * when a process starts, and the team's approval does not depend on them, so a scenario can change `task.*` without
 * approving again.
 */
export function setOmpSettings(env: E2eEnv, extraConfig = ""): void {
	writeFileSync(join(env.agentDir, "config.yml"), `${PROFILE_CONFIG}${extraConfig}`);
}

/**
 * The request that opens a manual run with a scripted director. `rounds: 1` (the default): the run ends when the director's
 * turn ends, whatever is still open. A scenario whose last delivery comes after that turn gives more rounds and keeps one
 * result open until then.
 */
export const runRequest = (steps: Step[], rounds = 1): string => `/storm E2E-ROUTE ${JSON.stringify({ action: "run", rounds })} E2E-STEPS ${JSON.stringify(steps)}`;
