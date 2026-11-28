import { parseModelEntry } from "../selector.ts";
import type { ExplicitSettings, OmpAdvice, StormConfig } from "../types.ts";

/** POSIX single-quote: safe for any text, including quotes inside JSON. */
export function shellQuote(text: string): string {
	return `'${text.replaceAll("'", `'\\''`)}'`;
}

/** Primary selector (effort dropped) → the role's other selectors, deduped; roles sharing a primary merge in role order. */
export function wantedFallbackChains(config: StormConfig): Record<string, string[]> {
	const chains: Record<string, string[]> = {};
	for (const role of Object.values(config.roles)) {
		const [primary, ...rest] = role.models.map((m) => parseModelEntry(m).selector);
		if (primary === undefined) continue;
		const chain = chains[primary] ?? [];
		for (const selector of rest) if (selector !== primary && !chain.includes(selector)) chain.push(selector);
		if (chain.length > 0) chains[primary] = chain;
	}
	return chains;
}

/**
 * omp retry settings that do not fit the approved team. Unknown settings give no advice. Isolation is the preflight
 * report's (`report/preflight.ts`), which reads the same checks the start refuses with.
 */
export function ompSettingsAdvice(config: StormConfig, settings: ExplicitSettings): OmpAdvice[] {
	const advice: OmpAdvice[] = [];
	const wanted = wantedFallbackChains(config);
	const primaries = Object.keys(wanted);
	if (primaries.length > 0) {
		const current = settings.fallbackChains;
		const differs = primaries.some((p) => {
			const have = current?.[p];
			const want = wanted[p] ?? [];
			return have === undefined || have.length !== want.length || have.some((v, i) => v !== want[i]);
		});
		if (current !== undefined && differs) {
			advice.push({
				key: "retry.fallbackChains",
				message: `오류가 나면 omp 가 턴 도중 승인된 대체 모델로 넘어가도록, 역할별 기본 모델의 대체 순서를 등록하세요 (${primaries.join(", ")}). 다른 키는 그대로 둡니다.`,
				command: `omp config set retry.fallbackChains ${shellQuote(JSON.stringify({ ...current, ...wanted }))}`,
			});
		}
		if (settings.modelFallback === false) {
			advice.push({
				key: "retry.modelFallback",
				message: "omp 의 모델 대체가 꺼져 있어 오류가 나도 승인된 대체 모델로 넘어가지 않습니다.",
				command: "omp config set retry.modelFallback true",
			});
		}
	}
	return advice;
}
