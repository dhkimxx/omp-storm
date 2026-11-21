/**
 * Resuming is offered only for a run this machine started. Run records live in the repository and can be committed
 * or rewritten by anyone; the pointer beside the repo's approvals is outside it, so a planted record is not a run.
 */
import * as path from "node:path";
import { sha256Hex } from "../config/canonical.ts";
import { readJson, writeJsonAtomic } from "../fsutil.ts";
import { runSpec, type SpecResult } from "../request/args.ts";
import type { RunRecord } from "../types.ts";
import { resumableRun } from "./run.ts";

/**
 * `<storeDir>/resume-<16 hex>.json` of the run this machine last started in `root`. The store is shared by every work
 * tree of the repository, so the name carries a short hash of the work tree's root path.
 */
export function resumePointerFile(storeDir: string, root: string): string {
	return path.join(storeDir, `resume-${sha256Hex(root).slice(0, 16)}.json`);
}

interface ResumePointer {
	runId: string;
	requestSha256: string;
}

function isPointer(value: unknown): value is ResumePointer {
	if (typeof value !== "object" || value === null) return false;
	const v = value as Record<string, unknown>;
	return typeof v.runId === "string" && typeof v.requestSha256 === "string";
}

/** Records the run this machine started in `root`, with the request the resume block will send. */
export function noteResumePointer(storeDir: string, root: string, run: RunRecord): Promise<void> {
	return writeJsonAtomic(resumePointerFile(storeDir, root), {
		runId: run.runId,
		requestSha256: sha256Hex(run.request ?? ""),
	} satisfies ResumePointer);
}

/** The pointer names this run and its request is byte-for-byte the one the machine started it with. */
export async function trustedResume(storeDir: string, root: string, run: RunRecord): Promise<boolean> {
	const pointer = await readJson(resumePointerFile(storeDir, root));
	return isPointer(pointer) && pointer.runId === run.runId && pointer.requestSha256 === sha256Hex(run.request ?? "");
}

/** The last run when it stopped unfinished and this machine can prove it started it in `root`; otherwise nothing to offer. */
export async function resumeCandidate(
	storeDir: string,
	root: string,
	run: RunRecord | undefined,
): Promise<(RunRecord & { request: string }) | undefined> {
	if (!resumableRun(run)) return undefined;
	return (await trustedResume(storeDir, root, run)) ? run : undefined;
}

/** A resume spec goes through `runSpec` like a typed request, so its limits are checked the same way. */
export function resumeSpec(run: RunRecord & { request: string }, said?: string): SpecResult {
	const result = runSpec(run.request, run.limits, run.runId);
	if (!result.ok) return result;
	return { ok: true, spec: { ...result.spec, ...(said ? { resumeNote: said } : {}) } };
}
