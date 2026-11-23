/**
 * Pure one-slot model edits for the native picker. A pick replaces one entry of one role's model list; every other
 * role, fallback, field and policy stays as it was, and no recommendation runs here. A legacy role-level `effort`
 * stays in place for explicit picks; a pick without an effort needs the model's own default, so that role's effective
 * efforts are then spelled per entry and the legacy field is removed, keeping every untouched model on the same effort.
 */
import { roleTitle } from "../roles.ts";
import { entryEffort, formatModelEntry, type ModelEntry, parseModelEntry } from "../selector.ts";
import type { Effort, RoleConfig, StormConfig, StormModelPick } from "../types.ts";

/** One editable position of the current draft: any configured model entry of a role. */
export interface ModelSlot {
	roleId: string;
	/** Index in `roles[roleId].models`; 0 is the primary and 1..n are the fallbacks. */
	index: number;
	/** `<role title> · 주 모델`, `<role title> · 폴백`, or `<role title> · 폴백 1`, `폴백 2`, … when there are several. */
	label: string;
}

const PRIMARY = "주 모델";
const FALLBACK = "폴백";

/**
 * The slots of a draft: the primary and every configured fallback, in their order. A role with exactly one fallback
 * keeps the plain `폴백` label; several are numbered so each remains unambiguous. This only edits entries that exist:
 * adding or removing a fallback stays in the role-by-role setup.
 */
export function modelSlots(config: Pick<StormConfig, "roles">): ModelSlot[] {
	const slots: ModelSlot[] = [];
	for (const [roleId, role] of Object.entries(config.roles)) {
		const title = roleTitle(roleId);
		for (let index = 0; index < role.models.length; index++) {
			const suffix = index === 0 ? PRIMARY : role.models.length === 2 ? FALLBACK : `${FALLBACK} ${index}`;
			slots.push({ roleId, index, label: `${title} · ${suffix}` });
		}
	}
	return slots;
}

/** A slot's current selector and effective effort, for the picker's current selection. */
export function slotCurrent(role: RoleConfig | undefined, index: number): { selector: string; effort?: Effort } | undefined {
	const entry = role?.models[index];
	if (entry === undefined) return undefined;
	const { selector } = parseModelEntry(entry);
	const effort = entryEffort(entry, role?.effort);
	return effort ? { selector, effort } : { selector };
}

/**
 * A pick as a model entry, checked against what the picker promises: usable now, tool-capable, and an effort the
 * model supports. Nothing is substituted; a pick that does not fit is explained instead.
 */
export function entryForPick(picked: StormModelPick, where: string): { entry: ModelEntry } | { error: string } {
	const { model } = picked;
	const selector = model.selector;
	if (!model.available) return { error: `${where}: ${selector} 모델은 지금 쓸 수 없습니다. 다른 모델을 고르세요.` };
	if (!model.supportsTools) return { error: `${where}: ${selector} 모델은 도구 호출을 지원하지 않습니다. 다른 모델을 고르세요.` };
	if (picked.effort !== undefined && !model.efforts.includes(picked.effort)) {
		const supported = model.efforts.length ? model.efforts.join("|") : "없음";
		return { error: `${where}: ${selector} 모델은 ${picked.effort} effort를 지원하지 않습니다(지원: ${supported}). 다른 effort나 모델을 고르세요.` };
	}
	return { entry: picked.effort ? { selector, effort: picked.effort } : { selector } };
}

/**
 * Replaces one slot without mutating the draft: only the config, its roles map, the changed role and that role's model
 * list are new. The role's other entries keep their order and effective effort, and a selector already in another
 * slot of the same role is rejected rather than quietly moving or dropping a slot.
 */
export function applySlotPick(config: StormConfig, slot: ModelSlot, picked: StormModelPick): { config: StormConfig } | { error: string } {
	const role = config.roles[slot.roleId];
	if (!role) return { error: `${roleTitle(slot.roleId)}: 팀 설정에 없는 역할입니다.` };
	if (!Number.isInteger(slot.index) || slot.index < 0 || slot.index >= role.models.length) {
		return { error: `${slot.label}: 팀 설정에 없는 모델 슬롯입니다.` };
	}
	const made = entryForPick(picked, slot.label);
	if ("error" in made) return made;
	const { selector } = made.entry;
	const duplicate = role.models.some((entry, index) => index !== slot.index && parseModelEntry(entry).selector === selector);
	if (duplicate) {
		return { error: `${roleTitle(slot.roleId)} 역할에 ${selector} 모델이 이미 있어 같은 모델을 두 번 둘 수 없습니다. 다른 모델을 고르세요.` };
	}
	const before = slotCurrent(role, slot.index);
	if (before?.selector === selector && before.effort === picked.effort) return { config };

	// Only the changed role and its model list are copied; every other role object stays shared with the draft.
	const nextRole: RoleConfig = { ...role };
	const materialize = picked.effort === undefined && nextRole.effort !== undefined;
	const models = materialize
		? nextRole.models.map((entry) => {
				const { selector: current } = parseModelEntry(entry);
				const effort = entryEffort(entry, nextRole.effort);
				return formatModelEntry(effort ? { selector: current, effort } : { selector: current });
			})
		: [...nextRole.models];
	// A bare pick means the model's own default, but in a legacy team the role-level effort would fill it in.
	// Only then the role's effective efforts are spelled per entry so untouched models keep running as before.
	if (materialize) delete nextRole.effort;
	models[slot.index] = formatModelEntry(made.entry);
	nextRole.models = models;
	return { config: { ...config, roles: { ...config.roles, [slot.roleId]: nextRole } } };
}
