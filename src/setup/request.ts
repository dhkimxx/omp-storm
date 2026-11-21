/**
 * The `<storm-setup>` request: the facts the session LLM needs to interview the user about the team,
 * Storm's own recommended config, and how to finish (the storm tool's `propose`). Storm still saves
 * only after the user picks "승인" in its approval dialog.
 */
import { effortsOf } from "../proposals/build.ts";
import { int, pct, priorityLabel, renderShadows, speedText, tierLabel, usd } from "../interview/render.ts";
import { recommendedConfig } from "../interview/setup.ts";
import { ROLE_EFFORT } from "../recommend/recommend.ts";
import { ROLES } from "../roles.ts";
import type { AnalysisContext, Candidate, ModelInfo, Priority, QuotaState, ShadowInfo, StormConfig } from "../types.ts";

export interface SetupRequestInput {
	ctx: AnalysisContext;
	priority: Priority;
	current?: { config: StormConfig; hash: string; approved: boolean };
	shadows: ShadowInfo[];
	activeTools: string[];
	warnings: string[];
}

/** Candidates listed per role; the recommender ranks at most five anyway. */
const CANDIDATES_PER_ROLE = 5;
/** Tool-capable model ids listed per provider, best scored first. */
const MODELS_PER_PROVIDER = 12;
/** why / whyNot lines kept per candidate. */
const REASONS = 3;
const EXCLUDED_SHOWN = 3;
const MODEL_ROLES_SHOWN = 8;

const QUOTA: Record<QuotaState, string> = {
	available: "여유",
	limited: "제한",
	exhausted: "소진",
	unknown: "알 수 없음",
	unavailable: "조회 불가",
};

interface Usage {
	/** modelKey → recent request share per seat. */
	share: Map<string, { subagent?: number; main?: number }>;
	/** selector → TTFT p50 in ms. */
	ttft: Map<string, number>;
}

function usageOf(ctx: AnalysisContext): Usage {
	const share: Usage["share"] = new Map();
	const ttft: Usage["ttft"] = new Map();
	for (const seat of ["subagent", "main"] as const) {
		for (const list of Object.values(ctx.analysis.preferences[seat])) {
			for (const l of list) {
				share.set(l.modelKey, { ...share.get(l.modelKey), [seat]: l.shareRecent });
				for (const r of l.routes) if (r.ttftP50 !== null && !ttft.has(r.selector)) ttft.set(r.selector, r.ttftP50);
			}
		}
	}
	return { share, ttft };
}

function candidateLines(c: Candidate, chosen: boolean, usage: Usage, model: ModelInfo | undefined): string[] {
	const share = usage.share.get(c.modelKey);
	const ttft = usage.ttft.get(c.selector);
	const parts = [
		`${chosen ? "★ " : ""}${c.label} (${c.selector})`,
		`계층 ${tierLabel(c.tier)}`,
		`참조 비용 ${usd(c.referenceUsd)}`,
		`속도 ${speedText(c.speed)}`,
		...(ttft !== undefined ? [`TTFT ${Math.round(ttft)}ms`] : []),
		`지능 ${int(c.int.value)}`,
		`최근 사용 비중 서브 ${pct(share?.subagent)} · 메인 ${pct(share?.main)}`,
		`effort ${model?.efforts.length ? model.efforts.join("/") : "없음"}`,
		`쿼터 ${QUOTA[c.quota]}`,
		...(model?.contextWindow ? [`컨텍스트 ${model.contextWindow.toLocaleString("en-US")}`] : []),
		...(c.validated ? ["사용 검증"] : []),
	];
	const out = [`- ${parts.join(" · ")}`];
	if (c.why.length) out.push(`  근거: ${c.why.slice(0, REASONS).join("; ")}`);
	if (c.whyNot.length) out.push(`  제외 이유: ${c.whyNot.slice(0, REASONS).join("; ")}`);
	return out;
}

function providerLines(ctx: AnalysisContext, activeTools: string[], warnings: string[]): { lines: string[]; warnings: string[] } {
	const d = ctx.detection(activeTools, warnings);
	const lines: string[] = [];
	for (const p of d.providers) {
		const models = ctx.available
			.filter((m) => m.provider === p.provider && m.supportsTools)
			.sort((a, b) => (b.int ?? -1) - (a.int ?? -1) || a.id.localeCompare(b.id));
		const shown = models.slice(0, MODELS_PER_PROVIDER).map((m) => m.id);
		const more = models.length > shown.length ? ` 외 ${models.length - shown.length}개` : "";
		lines.push(`- ${p.provider} (쿼터 ${QUOTA[p.quota]}, 모델 ${p.models}개): ${shown.join(", ") || "도구 호출 가능 모델 없음"}${more}`);
	}
	if (!lines.length) lines.push("- 지금 쓸 수 있는 Provider가 없습니다");
	lines.push(`- 도구: task ${d.tools.task ? "있음" : "없음"}, eval ${d.tools.eval ? "있음" : "없음"}`);
	lines.push(`- 실행 계약 키워드: workflowz ${d.keywords.workflowz ? "사용 가능" : "없음"}, orchestrate ${d.keywords.orchestrate ? "사용 가능" : "없음"}`);
	const ex = ctx.explicit;
	const settings = [
		...(ex.defaultModel ? [`기본 모델 ${ex.defaultModel}`] : []),
		...Object.entries(ex.modelRoles)
			.slice(0, MODEL_ROLES_SHOWN)
			.map(([role, model]) => `modelRoles.${role}=${model}`),
		...(ex.isolationEnabled !== undefined ? [`task.isolation.enabled=${ex.isolationEnabled ? "on" : "off"}`] : []),
		...(ex.maxConcurrency !== undefined ? [`task.maxConcurrency=${ex.maxConcurrency}`] : []),
	];
	if (settings.length) lines.push(`- omp 설정: ${settings.join(", ")}`);
	return { lines, warnings: [...d.warnings, ...ctx.analysis.warnings] };
}

function dataAge(ctx: AnalysisContext): string {
	const at = ctx.usage.dataAsOf;
	if (at === null) return "사용 기록 없음";
	const h = Math.max(0, Math.round((ctx.now - at) / 3_600_000));
	return `최근 ${ctx.usage.windowDays}일 사용 기록, 마지막 기록 ${h < 48 ? `${h}시간` : `${Math.round(h / 24)}일`} 전`;
}

/** The user message that hands team setup to the session LLM. */
export function buildSetupRequest(input: SetupRequestInput): string {
	const { ctx, priority, current } = input;
	const recs = ctx.recommend(priority);
	const usage = usageOf(ctx);
	const recommended = recommendedConfig(recs, (s) => effortsOf(ctx.checkModel, s), priority, current?.config);
	const providers = providerLines(ctx, input.activeTools, input.warnings);

	const out = [
		"<storm-setup>",
		`요청: ${current ? "Storm 팀 다시 설정" : "Storm 팀 처음 설정"} · 우선순위 ${priority} (${priorityLabel(priority)}) · ${dataAge(ctx)}`,
		"<providers>",
		...providers.lines,
		"</providers>",
		"<roles>",
	];
	for (const spec of ROLES) {
		const rec = recs.find((r) => r.role.id === spec.id);
		out.push(
			`## ${spec.id} (${spec.title}, ${spec.agent}): ${spec.description} 최소 컨텍스트 ${spec.minContext.toLocaleString("en-US")} · 기본 effort ${ROLE_EFFORT[spec.id]}`,
		);
		const candidates = rec?.candidates.slice(0, CANDIDATES_PER_ROLE) ?? [];
		if (!candidates.length) out.push("- 조건을 만족하는 후보가 없습니다");
		candidates.forEach((c, i) =>
			out.push(...candidateLines(c, i === rec?.chosenIndex, usage, ctx.available.find((m) => m.selector === c.selector))),
		);
		const excluded = rec?.excluded ?? [];
		if (excluded.length) {
			const shown = excluded.slice(0, EXCLUDED_SHOWN).map((e) => `${e.selector} (${e.reason})`);
			out.push(`- 제외된 모델 ${excluded.length}개: ${shown.join(", ")}${excluded.length > shown.length ? " 등" : ""}`);
		}
	}
	out.push("</roles>", "<storm-recommended-config>", JSON.stringify(recommended, null, 2), "</storm-recommended-config>");
	if (current) {
		out.push(
			`<current-config approved="${current.approved}" hash="${current.hash}">`,
			JSON.stringify(current.config, null, 2),
			"</current-config>",
		);
	}
	const shadows = renderShadows(input.shadows).trim();
	if (shadows) out.push("<shadows>", shadows, "</shadows>");
	if (providers.warnings.length) out.push("<warnings>", ...providers.warnings.map((w) => `- ${w}`), "</warnings>");
	out.push("</storm-setup>", "", INSTRUCTIONS);
	return out.join("\n");
}

const INSTRUCTIONS = `사용자가 /storm 에서 Storm 팀 설정을 요청했습니다. 위 storm-setup의 사실만으로 다음 순서대로 진행하세요.

먼저: 이 세션에 이미 작업 계획이 있으면(사용자가 언급한 계획 문서, \`local://\` 계획 노트, 대화 속 계획) 인터뷰 전에 읽으세요. 그 계획의 레인 종류(탐색 explore → explorer, 코드 code → implementer, 빌드·기기 실행·대기·로그 수집 run → quick, 리뷰 review → reviewer, 설계 design → architect)와 동시에 돌릴 수를 보고, 계획에 필요 없는 역할은 "사용 안 함"을, 쓰는 역할은 워커 최소~최대를 추천하세요. 이 추천은 storm-recommended-config에 반영해 보여 주고, 계획에서 왔다고 밝히세요. 계획이 없으면 이 단계는 건너뜁니다.

1. \`ask\` 도구로 사용자와 인터뷰하세요. 질문마다 ask 를 따로 부르지 말고, 아래 단계마다 ask 한 번(form 하나)에 그 단계의 질문을 모두 넣으세요(질문마다 fieldset 하나, 폼이 길어도 됩니다). 추천하는 선택지는 label 끝에 " (추천)"을 붙이고 checked 로 미리 골라 두세요. ask 도구의 \`recommended\` 필드는 쓰지 마세요.
2. 첫 form: storm-recommended-config 의 팀(역할별 주 모델 → 폴백과 effort, 워커 최소~최대, 컨텍스트 상한, 실행 설정)을 표로 보여 주고, 질문 하나의 선택지는 정확히 "Storm 추천안 그대로 (추천)", "역할별로 고르기", "취소" 세 개입니다.
   - Storm 추천안 그대로: storm-recommended-config를 그대로 제안합니다.
   - 역할별로 고르기: form 두 개로 묻습니다. 선택지는 위 후보에서 만들고, storm-recommended-config에 있는 값에 (추천)을 붙이세요.
     - 모델 form: 역할마다 주 모델 질문과 폴백 질문 두 개씩. 후보의 가격·속도·점수를 form 안에 표로 함께 보여 주세요. 폴백 질문에는 "폴백 없음"을 둡니다. 주 모델과 같은 모델을 폴백으로 고르면 폴백 없음으로 봅니다.
     - implementer를 뺀 모든 역할의 주 모델 질문은 마지막 선택지로 "사용 안 함"을 둡니다. 이를 고르면 그 역할의 폴백 답은 버리고, 설정 form에서 그 역할을 빼고, 그 역할을 \`roles\`에서 빼고 id를 \`disabledRoles\`에 넣으세요.
     - implementer는 필수 역할이라 "사용 안 함" 선택지가 없습니다.
     - 설정 form: 모델 form 에서 쓰기로 한 역할마다 effort 질문(그 역할의 주 모델이 지원하는 단계만), 워커 최소 질문과 워커 최대 질문(1~16, 최소 ≤ 최대, storm-recommended-config의 \`workers\` {min, max}에 (추천)), 이어서 병렬도, 팀 컨텍스트 상한("20만 (추천)", "10만", "40만" 토큰, \`contextCap\`에 200000/100000/400000으로), 실행 계약, 실행당 예산.
   - 취소하거나 답이 없으면 아무것도 호출하지 말고, 바뀐 것이 없다고만 짧게 알리세요.
3. 사용자가 위 사실에 없는 모델을 물을 때만 웹 검색을 하고, 출처를 밝히세요.
4. 마지막으로 \`storm\` 도구를 action "propose"로 호출하세요. \`config\`에는 팀 전체 설정 객체(storm-recommended-config와 같은 형식, 모델 항목은 "provider/id:effort", 쓰지 않는 역할은 \`disabledRoles\` 배열)를, \`rationale\`에는 왜 이 팀인지 한국어 2~4문장을 넣으세요. 도구가 설정 오류를 돌려주면 고쳐서 다시 호출하세요.
5. 저장은 사용자가 Storm 승인 창에서 "승인"을 골라야만 됩니다. 도구 결과를 그대로 전하고, 저장했다고 먼저 말하지 마세요.`;
