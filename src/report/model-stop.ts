/**
 * I3: a worker the pre-request model check stopped because it ran on a model or effort its role does not approve. The
 * usual cause is the user changing it in omp's hub (`/model`, `/effort` in the focused view); a later-loaded extension
 * can do the same. The /storm menu then offers to approve exactly what ran, through the ordinary approval dialog.
 * Read only from the run record (`SpawnRecord.ran`); nothing here approves anything.
 */
import { roleTitle } from "../roles.ts";
import { entryEffort, parseModelEntry } from "../selector.ts";
import { EFFORTS, type Effort, type RunRecord, type StormConfig } from "../types.ts";
import { readRun, runIds } from "../runtime/run.ts";

/** What a stopped worker ran on, and the role whose approval it fell outside of. */
export interface ModelStop {
	readonly roleId: string;
	/** "provider/id" the request used. */
	readonly model: string;
	readonly effort?: Effort;
}

/** The /storm menu item: `역할 구현자에 openai/x (high) 승인`. */
export function modelStopLabel(stop: ModelStop): string {
	return `역할 ${roleTitle(stop.roleId)}에 ${stop.model}${stop.effort === undefined ? "" : ` (${stop.effort})`} 승인`;
}

/**
 * The newest model-check stop of `run` that the team in `config` still does not approve: a role it names, a model (and
 * effort) none of that role's entries has. Undefined when there is none, or when the user has approved it since.
 */
export function latestModelStop(run: Pick<RunRecord, "spawns"> | undefined, config: StormConfig): ModelStop | undefined {
	for (let at = (run?.spawns.length ?? 0) - 1; at >= 0; at--) {
		const spawn = run!.spawns[at]!;
		const ran = spawn.ran;
		if (ran?.verdict !== "mismatch" || spawn.role === undefined) continue;
		const role = config.roles[spawn.role];
		if (role === undefined) continue;
		const effort = EFFORTS.find(level => level === ran.effort);
		const approved = role.models.some(entry => parseModelEntry(entry).selector === ran.model && (effort === undefined || entryEffort(entry, role.effort) === effort));
		if (approved) continue;
		return { roleId: spawn.role, model: ran.model, ...(effort === undefined ? {} : { effort }) };
	}
	return undefined;
}

/**
 * The stop of the session's newest run, live or finished. The stop usually happens while the run is still going (the user
 * changed the model in the hub mid-run), so the newest finished run alone would miss it.
 */
export async function newestModelStop(sessionDir: string, config: StormConfig): Promise<ModelStop | undefined> {
	const newest = (await runIds(sessionDir)).at(-1);
	return latestModelStop(newest === undefined ? undefined : await readRun(sessionDir, newest), config);
}