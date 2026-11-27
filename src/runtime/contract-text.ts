/**
 * The result contract a worker reads in its assignment: what Storm will judge it on, and how.
 *
 * Storm judges a worker by its lane's declared `results` (`result-evidence.ts`), but the assignment text never said
 * what those are, so workers reported in forms Storm then could not accept. This module renders one lane's contract as
 * one block of text for one task item. It is pure: it reads nothing, decides nothing about placement, and the
 * evaluator does not read the block back, so nothing here can change a verdict.
 *
 * Three rules shape every line:
 * - Least disclosure. No absolute host path is ever inserted. The literal an `answer` result must find in its cited
 *   source (`contains`) is never shown: a worker that sees it can copy the value and cite any line that holds it. The
 *   `contains` of a `change` or `artifact` is what the worker must produce, so it is shown, cut and labelled.
 * - Every inserted field is escaped, so a criterion that holds a newline, a control character or a fake `[storm:`
 *   header cannot imitate a header or an instruction. Fields are quoted with JSON rules plus the characters JSON leaves
 *   as they are, and the one header of the block is the only place `[storm:` appears raw.
 * - The acceptance rules say what `result-evidence.ts` really does, no more. Which results the machine can accept and
 *   which only a reviewer can decide is one function (`resultJudge`) that the tests run against the real evaluator on
 *   fixtures, so a line cannot drift from what the evaluator does.
 */
import { createHash } from "node:crypto";
import type { PlanLane, PlanLaneResult } from "../types.ts";

/** The one header of a block. A caller that looks for a delivered block looks for this word. */
export const CONTRACT_TAG = "[storm:계약]";
/** A citation the real parser (`answerCitations`) reads; a test pins that, so the hint cannot drift from the parser. */
export const CITATION_EXAMPLE = "src/a.ts:42";
/** The most UTF-8 bytes one block may hold. */
export const CONTRACT_MAX_BYTES = 2_400;
/** How much of a `contains` a worker sees; the judgement always uses the whole string. */
export const CONTAINS_SHOWN_CHARS = 120;
/** How much of a criterion a worker sees. The director wrote it for the plan; the block repeats it, never extends it. */
export const CRITERION_SHOWN_CHARS = 120;

/**
 * What one block may show of each field. A block that cannot fit even its first result with these is rendered again
 * with the compact set, so a worker is never handed a contract with no result in it unless nothing can fit.
 */
interface Caps {
	criterionChars: number;
	criterionBytes: number;
	containsChars: number;
	containsBytes: number;
	/** A path longer than this is not printed (a cut path would name a different file). */
	pathBytes: number;
	nameChars: number;
	scopeBytes: number;
}
const FULL_CAPS: Caps = { criterionChars: CRITERION_SHOWN_CHARS, criterionBytes: 400, containsChars: CONTAINS_SHOWN_CHARS, containsBytes: 400, pathBytes: 200, nameChars: 48, scopeBytes: 260 };
const COMPACT_CAPS: Caps = { criterionChars: 40, criterionBytes: 140, containsChars: 40, containsBytes: 140, pathBytes: 120, nameChars: 32, scopeBytes: 0 };

/** The opening sentence: the verdict is by the declared results, not by what the worker says. */
export const CONTRACT_HEADER = "Storm이 아래 결과로 완료를 판정합니다. 보고 문장은 근거가 아닙니다.";
/** Shown instead of the expected literal of an `answer` result. */
export const ANSWER_CONTAINS_NOTE = "근거 줄의 내용은 Storm이 직접 확인합니다.";
/** The scope line of an isolated item: the paths are relative to its own checkout. */
export const ISOLATED_SCOPE = "격리 체크아웃 안의 같은 상대 경로";

/** What a result's per-result line says about who decides it once its conditions are met. */
export const JUDGE_TEXT = {
	machine: "조건을 충족하면 Storm이 기계로 인정합니다",
	reviewer: "조건을 충족해도 리뷰어가 판정합니다",
	never: "경로가 없어 Storm이 인정하지 못합니다",
} as const;

const CHANGE_RULE =
	"change: 작업 시작 때 잡은 기준선과 비교해 대상 파일의 내용이 실제로 바뀌어야 합니다. 대상은 path가 있으면 그 파일, 없으면 레인의 파일 범위입니다. 요구 문자열이 있으면 바뀐 파일 안에 공백까지 그대로 있어야 합니다.";
const CHANGE_ISOLATED_RULE =
	"격리 실행이라 Storm은 부모 작업 트리의 같은 경로를 읽습니다. 체크아웃 안에서만 바뀐 내용은 거기에 반영되기 전에는 보이지 않습니다.";
const ARTIFACT_SHARED_RULE =
	"artifact: 공유 작업 트리에서는 change와 같게 기준선과 비교해 판정하며 path가 있어야 합니다. path가 없으면 인정되지 않습니다.";
const ARTIFACT_ISOLATED_RULE =
	"artifact: 이 시도에 결속된 보존 산출물 안에서 path를 읽습니다(부모 작업 트리는 읽지 않습니다). 요구 문자열은 그 파일 내용에, 패치라면 추가된 줄에 있어야 합니다.";
const ANSWER_RULE = `answer: 답에 근거 위치를 path:line 형식으로 적으세요(예: ${CITATION_EXAMPLE}). Storm이 인용한 줄을 다시 읽고, 답 전체가 그 줄과 같거나 답이 값 하나(숫자, true/false, null, 따옴표 문자열, 키: 값)이고 그 줄의 값과 같을 때만 기계로 인정합니다. 서술형 답이나 기계로 확인하지 못하는 답은 리뷰어가 판정합니다. 읽을 수 없는 위치만 인용하면 인정되지 않고, 결과에 path가 있으면 그 경로를 인용해야 합니다. 요구 내용이 있는 결과는 인용한 줄에 그 내용이 있어야 하며, 답의 숫자·true/false 값이 어긋나면 인정되지 않습니다.`;
const CHECK_RULE =
	"검사: 이름이 붙은 승인된 검사를 Storm이 직접 실행해 통과해야 합니다. 통과하지 못했거나 아직 실행되지 못했으면 인정되지 않습니다.";

/** Who decides a result once its stated conditions are met; `cited` is an answer, which depends on the answer's form. */
export type ResultJudge = "machine" | "reviewer" | "never" | "cited";

/**
 * What `evaluateSettledResults` does with a result whose stated conditions are all met, derived from
 * `evaluateChange` (a shared change or artifact), `evaluateArtifact` (a retained artifact) and `evaluateAnswer`. The
 * test sweeps every combination against the real evaluator, so this function and the evaluator cannot disagree.
 *
 * - a change with no `path` in a lane with no `files`: never accepted (`evaluateChange` has no baseline to compare).
 * - change, and a shared artifact: with neither `contains` nor `check` the change is only observed and a reviewer
 *   decides (`reviewable`); with either, meeting it is `accepted`. A shared artifact without `path` is always unmet.
 * - an isolated artifact: only `contains` is a machine condition; a `check` is an additional condition that must
 *   pass but never accepts by itself. Without `path` the retained artifact is only observed (a reviewer decides), and a
 *   `contains` has no path to be read at, so it is never met.
 */
export function resultJudge(result: Pick<PlanLaneResult, "kind" | "path" | "contains" | "check">, options: { isolated: boolean; laneHasFiles: boolean }): ResultJudge {
	if (result.kind === "answer") return "cited";
	// A change with no path is judged on the lane's files; with none of those either there is nothing to compare to a baseline.
	if (result.kind === "change" && result.path === undefined && !options.laneHasFiles) return "never";
	if (result.kind === "artifact" && options.isolated) {
		if (result.path === undefined) return result.contains === undefined ? "reviewer" : "never";
		return result.contains === undefined ? "reviewer" : "machine";
	}
	if (result.kind === "artifact" && result.path === undefined) return "never";
	return result.contains !== undefined || result.check !== undefined ? "machine" : "reviewer";
}

/** The characters JSON.stringify leaves as they are but that can hide or fake structure in a line of text. */
const INVISIBLE_RANGES: ReadonlyArray<readonly [number, number]> = [[0x7f, 0x9f], [0xad, 0xad], [0x61c, 0x61c], [0x180e, 0x180e], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x206f], [0xfeff, 0xfeff], [0xfff9, 0xfffb]];
/** Brackets other than the ASCII one that a reader may take for the opening or closing of a `[storm:…]` header: all escaped, wherever they stand. */
const BRACKET_LOOKALIKES = new Set([0x2045, 0x2046, 0x27e6, 0x27e7, 0x3010, 0x3011, 0x3014, 0x3015, 0x301a, 0x301b, 0xfe5d, 0xfe5e, 0xff3b, 0xff3d]);

/** Whether the text after an ASCII `[` reads as `storm` once width forms, case and spaces are folded away. */
function opensStormHeader(rest: string): boolean {
	return rest.slice(0, 24).normalize("NFKC").toLowerCase().replace(/\s+/gu, "").startsWith("storm");
}

/** One field as a JSON string literal that cannot carry a newline, a control character or a raw `[storm` header (in any bracket or width form). */
function quote(value: string): string {
	const escaped = Array.from(JSON.stringify(value), char => {
		const code = char.codePointAt(0) ?? 0;
		return INVISIBLE_RANGES.some(([from, to]) => code >= from && code <= to) || BRACKET_LOOKALIKES.has(code) ? `\\u${code.toString(16).padStart(4, "0")}` : char;
	}).join("");
	let out = "";
	for (let at = 0; at < escaped.length; at++) {
		out += escaped[at] === "[" && opensStormHeader(escaped.slice(at + 1)) ? "\\u005b" : escaped[at];
	}
	return out;
}

const byteLength = (text: string): number => Buffer.byteLength(text, "utf8");

/** A quoted field cut on whole characters to a character and a byte bound; `cut` says whether anything was dropped. */
function shown(value: string, maxChars: number, maxBytes: number): { text: string; cut: boolean } {
	const points = Array.from(value);
	const original = points.length;
	if (points.length > maxChars) points.length = maxChars;
	let text = quote(points.join(""));
	while (points.length > 0 && byteLength(text) > maxBytes) {
		points.pop();
		text = quote(points.join(""));
	}
	return { text, cut: points.length < original };
}

/** A workspace-relative path Storm may print: never absolute, never leaving the tree, no control characters. */
function relativePath(value: unknown): string | undefined {
	if (typeof value !== "string" || value === "" || value.trim() !== value) return undefined;
	if (/[\u0000-\u001f\u007f-\u009f]/u.test(value)) return undefined;
	if (value.startsWith("/") || value.startsWith("~") || value.startsWith("\\") || /^[A-Za-z]:/u.test(value) || value.includes("\\")) return undefined;
	if (value.split("/").some(segment => segment === ".." || segment === "")) return undefined;
	return value;
}

/** A path as a quoted value, or a fixed phrase when it is too long to show whole: a cut path would name another file. */
function pathValue(path: string, caps: Caps): string {
	const text = quote(path);
	return byteLength(text) <= caps.pathBytes ? text : "(너무 길어 생략)";
}

/** The lane's file scope as quoted workspace-relative paths, cut to a byte bound; unsafe entries are never printed. */
function scopeText(files: readonly string[] | undefined, caps: Caps): string | undefined {
	const safe = [...new Set((files ?? []).flatMap(file => relativePath(file) ?? []))].filter(file => byteLength(quote(file)) <= caps.pathBytes);
	if (safe.length === 0 || caps.scopeBytes <= 0) return undefined;
	const parts: string[] = [];
	let bytes = 0;
	for (const file of safe) {
		const part = quote(file);
		if (parts.length > 0 && bytes + byteLength(part) + 2 > caps.scopeBytes) break;
		parts.push(part);
		bytes += byteLength(part) + 2;
	}
	const rest = safe.length - parts.length;
	return `${parts.join(", ")}${rest > 0 ? ` (외 ${rest}개)` : ""}`;
}

/** The lines of one declared result. Always whole lines, so a cut never splits one. */
function resultLines(result: PlanLaneResult, options: LaneContractOptions, caps: Caps, laneHasFiles: boolean): string[] {
	const path = relativePath(result.path);
	const judge = resultJudge(result, { isolated: options.isolated, laneHasFiles });
	const head = [`- id: ${quote(result.id)}`, `종류: ${result.kind}`];
	if (path !== undefined) head.push(`경로: ${pathValue(path, caps)}`);
	if (result.check !== undefined) head.push(`검사: ${shown(result.check, caps.nameChars, 160).text}`);
	if (judge !== "cited") head.push(`판정: ${JUDGE_TEXT[judge]}`);
	const lines = [head.join(", ")];
	const criterion = shown(result.criterion, caps.criterionChars, caps.criterionBytes);
	lines.push(`  기준: ${criterion.text}${criterion.cut ? ` (앞 ${caps.criterionChars}자 표시)` : ""}`);
	if (result.contains !== undefined) {
		if (result.kind === "answer") {
			lines.push(`  ${ANSWER_CONTAINS_NOTE}`);
		} else {
			const contains = shown(result.contains, caps.containsChars, caps.containsBytes);
			lines.push(`  요구 문자열${contains.cut ? `(앞 ${caps.containsChars}자 표시, 판정은 전체 문자열)` : ""}: ${contains.text}`);
		}
	}
	return lines;
}

/** The acceptance rules for exactly the kinds (and the check) among the shown results. */
function ruleLines(results: readonly PlanLaneResult[], options: { isolated: boolean }): string[] {
	const kinds = new Set(results.map(result => result.kind));
	const lines: string[] = [];
	if (kinds.has("change")) {
		lines.push(CHANGE_RULE);
		if (options.isolated) lines.push(CHANGE_ISOLATED_RULE);
	}
	if (kinds.has("artifact")) lines.push(options.isolated ? ARTIFACT_ISOLATED_RULE : ARTIFACT_SHARED_RULE);
	if (kinds.has("answer")) lines.push(ANSWER_RULE);
	if (results.some(result => result.check !== undefined)) lines.push(CHECK_RULE);
	return lines;
}

export interface LaneContractOptions {
	/** Whether this task item runs in its own checkout. Per item (from placement), never a global flag. */
	isolated: boolean;
}

/**
 * The block for one lane and one task item, or undefined when the lane declares no results (nothing is judged by
 * them). At most `CONTRACT_MAX_BYTES` UTF-8 bytes, cut after a whole result; a cut block ends with a line that says how
 * many results it shows.
 */
export function laneContractText(lane: PlanLane, options: LaneContractOptions): string | undefined {
	const results = lane.results ?? [];
	if (results.length === 0) return undefined;
	const full = render(lane, results, options, FULL_CAPS);
	if (full.shownCount > 0) return full.text;
	// Not even one result fits with the usual caps: a contract without a result is no contract, so show less of each field.
	const compact = render(lane, results, options, COMPACT_CAPS);
	return compact.shownCount > 0 ? compact.text : full.text;
}

/** One rendering with one set of caps: the most results, counted from the first, that fit the bound. */
function render(lane: PlanLane, results: readonly PlanLaneResult[], options: LaneContractOptions, caps: Caps): { text: string; shownCount: number } {
	const head = [`${CONTRACT_TAG} ${CONTRACT_HEADER}`, `레인: ${shown(lane.name, caps.nameChars, 160).text}, 종류: ${shown(lane.kind, caps.nameChars, 160).text}`];
	const scope = scopeText(lane.files, caps);
	if (scope !== undefined) head.push(`쓰기 범위: ${options.isolated ? `${ISOLATED_SCOPE} ` : ""}${scope}`);
	else if (options.isolated) head.push(`쓰기 범위: ${ISOLATED_SCOPE}`);
	const units = results.map(result => resultLines(result, options, caps, (lane.files ?? []).length > 0));
	let text = "";
	for (let shownCount = results.length; shownCount >= 0; shownCount--) {
		const lines = [...head, ...ruleLines(results.slice(0, shownCount), options), ...units.slice(0, shownCount).flat()];
		if (shownCount < results.length) lines.push(`…(결과 ${results.length}개 중 ${shownCount}개 표시)`);
		text = lines.join("\n");
		if (byteLength(text) <= CONTRACT_MAX_BYTES) return { text, shownCount };
	}
	return { text, shownCount: 0 };
}

/** A stable digest of a block, so a caller can tell whether a worker already has the current one. */
export function contractDigest(text: string): string {
	return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

/** The block and its digest, or undefined for a lane with no declared results. */
export function laneContract(lane: PlanLane, options: LaneContractOptions): { text: string; digest: string } | undefined {
	const text = laneContractText(lane, options);
	return text === undefined ? undefined : { text, digest: contractDigest(text) };
}
