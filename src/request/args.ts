/**
 * Run requests without a model call: the task of `/storm <text>` and the limits stated with it, checked once and
 * turned into a `RunSpec`.
 */
import type { RunSpec } from "../types.ts";

export type SpecResult = { ok: true; spec: RunSpec } | { ok: false; error: string };

const MAX_ROUNDS = 20;
const MAX_MINUTES = 1440;

/** A task and the limits stated with it. */
export function runSpec(taskText: string, limits?: { rounds?: number | undefined; minutes?: number | undefined }): SpecResult {
	const task = taskText.trim();
	if (!task) return { ok: false, error: "실행할 작업 내용이 비어 있습니다." };
	const { rounds, minutes } = limits ?? {};
	if (rounds !== undefined && !(Number.isInteger(rounds) && rounds >= 1 && rounds <= MAX_ROUNDS)) {
		return { ok: false, error: `라운드 수는 1 이상 ${MAX_ROUNDS} 이하의 정수여야 합니다.` };
	}
	if (minutes !== undefined && !(Number.isFinite(minutes) && minutes > 0 && minutes <= MAX_MINUTES)) {
		return { ok: false, error: `시간 한도는 0보다 크고 ${MAX_MINUTES}분 이하인 숫자여야 합니다.` };
	}
	return { ok: true, spec: { task, ...(rounds !== undefined ? { rounds } : {}), ...(minutes !== undefined ? { minutes } : {}) } };
}
