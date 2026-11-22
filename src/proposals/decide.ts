/**
 * The one path from a proposed config to a saved, approved one, shared by the /storm flows and the storm tool:
 * gate, validate, show, and write only on the exact approval label and only if nothing moved underneath.
 */
import { configHash } from "../config/canonical.ts";
import { validateConfig } from "../config/schema.ts";
import { isApproved, type ProjectState } from "../state.ts";
import type { ApprovalScope, InfoLine, Proposal, StormConfig, UiPort } from "../types.ts";
import { presentProposal } from "./present.ts";

export interface DecideHost {
	ui: UiPort;
	/** Project state read fresh (no cache). */
	loadState(): Promise<ProjectState>;
	/** Writes the approval first, then the config; returns the new config hash. */
	approveAndSave(state: ProjectState, config: StormConfig, scope: ApprovalScope): Promise<string>;
}

export type Decision =
	| { outcome: "approved"; hash: string }
	| { outcome: "cancelled" }
	/** The proposal equals the approved current config. */
	| { outcome: "unchanged" }
	| { outcome: "rejected"; reason: string }
	/** The user picked one of the caller's extra options. */
	| { outcome: "extra"; extra: string };

export const NEEDS_APPROVAL =
	"지금 팀 설정이 승인되지 않아 바꾸지 않았습니다. 사용자가 /storm 에서 먼저 승인(또는 이전 승인으로 되돌리기)해야 합니다.";

/**
 * Whether the config file or the shadowing definitions changed between two reads (while a dialog was open).
 * A valid file is known by its config hash; a missing or invalid one by its status and bytes, so a file that
 * appears or is edited while still invalid counts too and is not overwritten.
 */
export function movedSince(before: ProjectState, now: ProjectState): boolean {
	const file = ({ config }: ProjectState) =>
		config.status === "ok" ? config.hash : config.status === "invalid" ? `invalid:${config.rawSha256 ?? ""}` : "missing";
	const shadows = (s: ProjectState) =>
		s.shadows
			.map((x) => `${x.path}\n${x.sha256}`)
			.sort()
			.join("\n");
	return file(before) !== file(now) || shadows(before) !== shadows(now);
}

export async function decideProposal(
	host: DecideHost,
	state: ProjectState,
	proposal: Proposal,
	opts: { warnings?: readonly string[]; context?: string; notes?: string; notesInfo?: readonly InfoLine[]; extraOptions?: readonly string[] } = {},
): Promise<Decision> {
	const approved = isApproved(state);
	// A change is shown as a diff against the current config, so that config must be one the user approved:
	// otherwise "승인" on a small diff would approve the whole unseen file. Only a setup shows the whole team.
	if (proposal.kind !== "setup" && !approved) return { outcome: "rejected", reason: NEEDS_APPROVAL };
	const checked = validateConfig(proposal.config);
	if (!checked.config) return { outcome: "rejected", reason: `제안한 팀 설정이 올바르지 않습니다: ${checked.errors.join("; ")}` };
	const baseHash = state.config.status === "ok" ? state.config.hash : null;
	if (approved && configHash(proposal.config) === baseHash) return { outcome: "unchanged" };

	const answer = await presentProposal(host.ui, proposal, approved && state.config.status === "ok" ? state.config.config : undefined, {
		shadows: state.shadows,
		warnings: [...checked.warnings, ...(opts.warnings ?? [])],
		...(opts.context ? { context: opts.context } : {}),
		...(opts.notes ? { notes: opts.notes } : {}),
		...(opts.notesInfo ? { notesInfo: opts.notesInfo } : {}),
		...(opts.extraOptions ? { extraOptions: opts.extraOptions } : {}),
	});
	if (answer === "cancelled") return { outcome: "cancelled" };
	if (answer !== "approved") return { outcome: "extra", extra: answer.extra };

	const fresh = await host.loadState();
	if (movedSince(state, fresh)) {
		return { outcome: "rejected", reason: "승인하는 사이 팀 설정이나 가림 정의가 바뀌어 적용하지 않았습니다. 다시 요청하세요." };
	}
	const hash = await host.approveAndSave(fresh, proposal.config, { shadowedAgents: fresh.shadows });
	return { outcome: "approved", hash };
}
