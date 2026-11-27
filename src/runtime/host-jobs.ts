import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { HostJobRow } from "./lanes.ts";

/**
 * The running async jobs the director session owns, from omp's own snapshot of them. A job omp moved to the background
 * (a long command, `async`, a `notify` pattern) is a `bash` or `eval` row; a subagent's task job is a `task` row with the
 * subagent's id. `undefined` when the host cannot show them (an older host, no job manager, a snapshot that throws): the
 * caller must not read that as "no jobs". A service omp keeps in its daemon is not a job and is not here, which is why a
 * service is never started during a run.
 */
export function hostJobRows(ctx: Pick<ExtensionContext, "getAsyncJobSnapshot">): readonly HostJobRow[] | undefined {
	try {
		const snapshot = ctx.getAsyncJobSnapshot?.();
		if (snapshot === null || snapshot === undefined || !Array.isArray(snapshot.running)) return undefined;
		const rows: HostJobRow[] = [];
		for (const job of snapshot.running as readonly unknown[]) {
			if (typeof job !== "object" || job === null) continue;
			const row = job as { id?: unknown; type?: unknown; status?: unknown; agentId?: unknown };
			if (typeof row.id !== "string") continue;
			rows.push({
				id: row.id,
				// An unreadable type is treated as a command: the cautious reading for a holder.
				type: typeof row.type === "string" ? row.type : "bash",
				status: typeof row.status === "string" ? row.status : "running",
				...(typeof row.agentId === "string" ? { agentId: row.agentId } : {}),
			});
		}
		return rows;
	} catch {
		return undefined;
	}
}
