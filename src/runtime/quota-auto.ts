import type { QuotaMark } from "../types.ts";

/** How long an automatic mark keeps the provider behind approved fallbacks. */
export const FALLBACK_MARK_MS = 5 * 60 * 60 * 1000;

/** omp switched away from `fromModel` ("provider/id") after errors: mark its provider for 5 hours. No provider → no mark. */
export function fallbackQuotaMark(fromModel: string, now: number): QuotaMark | undefined {
	const slash = fromModel.indexOf("/");
	if (slash <= 0) return undefined;
	return {
		provider: fromModel.slice(0, slash),
		source: "fallback",
		markedAt: new Date(now).toISOString(),
		until: new Date(now + FALLBACK_MARK_MS).toISOString(),
	};
}

/** Notice for `retry_fallback_applied`; `provider` is the marked provider, absent when nothing was marked. */
export function quotaNotice(from: string, to: string, provider?: string): string {
	const switched = `omp 가 오류로 ${from} 에서 ${to} 로 모델을 바꿨습니다.`;
	return provider === undefined
		? switched
		: `${switched} ${provider} 를 5시간 동안 쿼터 소진으로 표시해 승인된 다른 provider 모델을 먼저 씁니다.`;
}

/** Notice for `credential_disabled`: shown only, nothing is marked. */
export function credentialNotice(provider: string): string {
	return `omp 가 ${provider} 인증 정보를 비활성화했습니다. 다시 로그인하기 전까지 이 provider 모델은 실패할 수 있습니다.`;
}
