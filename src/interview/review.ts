import type { RollbackOption, ShadowInfo, StormConfig, UiPort } from "../types.ts";
import { renderConfigDiff, renderShadows } from "./render.ts";

export async function runReview(
	ui: UiPort,
	input: { config: StormConfig; hash: string; previous?: StormConfig; shadows: ShadowInfo[] },
): Promise<"approved" | "cancelled"> {
	const short = input.hash.replace(/^jcs-sha256:/, "").slice(0, 12);
	const context = { title: `승인할 설정 · ${short}`, markdown: renderConfigDiff(input.previous, input.config) + renderShadows(input.shadows) };
	return (await ui.select("이 설정을 승인할까요?", ["승인", "취소"], context)) === "승인" ? "approved" : "cancelled";
}

function optionLabel(o: RollbackOption): string {
	const d = new Date(o.approvedAt);
	const p = (n: number) => String(n).padStart(2, "0");
	const when = Number.isNaN(d.getTime())
		? o.approvedAt
		: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
	const roles = Object.entries(o.config.roles)
		.map(([id, r]) => `${id}=${r.models[0] ?? "—"}`)
		.join(", ");
	return `${when} · ${o.hash.replace(/^jcs-sha256:/, "").slice(0, 12)} · ${roles || "—"}`;
}

export async function runRollback(
	ui: UiPort,
	input: { options: RollbackOption[]; current?: StormConfig },
): Promise<{ status: "approved"; option: RollbackOption } | { status: "cancelled" }> {
	const labels = input.options.map(optionLabel);
	const a = await ui.select("되돌릴 구성", [...labels, "취소"]);
	const i = a === undefined ? -1 : labels.indexOf(a);
	const option = input.options[i];
	if (!option) return { status: "cancelled" };
	const context = { title: "되돌릴 구성", markdown: renderConfigDiff(input.current, option.config) };
	const ok = await ui.select("이 구성으로 되돌릴까요?", ["승인 후 되돌리기", "취소"], context);
	return ok === "승인 후 되돌리기" ? { status: "approved", option } : { status: "cancelled" };
}
