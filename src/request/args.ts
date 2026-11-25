/**
 * Run requests without a model call: the task of `/storm <text>` and the limits stated with it, checked once and
 * turned into a `RunSpec`.
 */
import type { RunSpec } from "../types.ts";

export type SpecResult = { ok: true; spec: RunSpec } | { ok: false; error: string };

/**
 * A task and the limits stated with it; `resumeOf` when the request continues an earlier run. A stated limit has no
 * upper bound: the run takes as many rounds or minutes as the user says.
 */
export function runSpec(
	taskText: string,
	limits?: { rounds?: number | undefined; minutes?: number | undefined },
	resumeOf?: string,
): SpecResult {
	const task = taskText.trim();
	if (!task) return { ok: false, error: "실행할 작업 내용이 비어 있습니다." };
	const { rounds, minutes } = limits ?? {};
	if (rounds !== undefined && !(Number.isInteger(rounds) && rounds >= 1)) {
		return { ok: false, error: "라운드 수는 1 이상의 정수여야 합니다." };
	}
	if (minutes !== undefined && !(Number.isFinite(minutes) && minutes > 0)) {
		return { ok: false, error: "시간 한도는 0보다 큰 숫자여야 합니다." };
	}
	const resumed = resumeOf?.trim();
	return {
		ok: true,
		spec: {
			task,
			...(rounds !== undefined ? { rounds } : {}),
			...(minutes !== undefined ? { minutes } : {}),
			...(resumed ? { resumeOf: resumed } : {}),
		},
	};
}
