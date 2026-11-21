import { shortHash } from "../config/canonical.ts";
import { roleTitle } from "../roles.ts";
import type { RollbackOption, StormConfig, UiPort } from "../types.ts";
import { CANCEL } from "../proposals/present.ts";
import { changedFields, isoText, renderConfigDiff, visible } from "./render.ts";

const ROLL_BACK = "되돌리기";
/** Changed fields named in a rollback label; the rest are counted. */
const FIELDS_SHOWN = 4;

/**
 * One label per earlier approval: when it was approved and what going back to it changes against the current
 * config (its main models when there is no readable current config). Equal labels get the short hash to stay distinct.
 */
export function rollbackLabels(options: readonly RollbackOption[], current: StormConfig | undefined): string[] {
	const labels = options.map((o) => {
		let what: string;
		if (current) {
			const fields = changedFields(current, o.config);
			const rest = fields.length - FIELDS_SHOWN;
			what = fields.length ? `바뀌는 것: ${fields.slice(0, FIELDS_SHOWN).join(", ")}${rest > 0 ? ` 외 ${rest}개` : ""}` : "지금과 같음";
		} else {
			what = Object.entries(o.config.roles)
				.map(([id, r]) => visible(`${roleTitle(id)} ${r.models[0] ?? "—"}`))
				.join(", ");
		}
		return `${isoText(o.approvedAt)} 승인 · ${what}`;
	});
	return labels.map((label, i) => (labels.indexOf(label) === labels.lastIndexOf(label) ? label : `${label} · ${shortHash(options[i]!.hash)}`));
}

/** Picks an earlier approval and confirms it with the full diff in view; undefined when the user backs out. */
export async function runRollback(
	ui: UiPort,
	input: { options: readonly RollbackOption[]; current?: StormConfig },
): Promise<RollbackOption | undefined> {
	const labels = rollbackLabels(input.options, input.current);
	const picked = await ui.select("되돌릴 팀 설정", [...labels, CANCEL]);
	const option = picked === undefined ? undefined : input.options[labels.indexOf(picked)];
	if (!option) return undefined;
	const answer = await ui.select("이 팀 설정으로 되돌릴까요?", [ROLL_BACK, CANCEL], {
		title: "되돌릴 팀 설정",
		consent: [ROLL_BACK],
		markdown: renderConfigDiff(input.current, option.config),
	});
	return answer === ROLL_BACK ? option : undefined;
}
