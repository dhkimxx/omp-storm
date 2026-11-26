/**
 * Korean particles (josa) after a value the code cannot know in advance: a lane name, a result id, a path, an agent.
 *
 * The particle depends on how a Korean reader SAYS the last word of the text, not on how it is spelled: `필수 결과`
 * ends in a vowel (`를`), `src/a.ts:13` ends in 십삼 (`을`), `SQL` is read 에스큐엘 (`을`). `josa(value, "은/는")`
 * returns the particle alone, `withJosa` returns the value with it.
 *
 * Rules, in the order they are applied to the text (NFKC-normalised, so macOS decomposed Hangul and full-width forms
 * work):
 * 1. Trailing blanks, closing and opening marks (`)]}>'"` backtick `」』”’`) and punctuation (`.,:;!?…·/\-_~`) are
 *    skipped: `'name'`, `agent(구현)` and `docs/` are judged by the character before the mark.
 * 2. A Hangul syllable is exact: a final consonant is `(code - 0xAC00) % 28 !== 0`, and `ㄹ` is final consonant 8.
 * 3. A digit is read the Sino-Korean way: 0 영, 1 일, 3 삼, 6 육, 7 칠, 8 팔 take a final consonant (1, 7, 8 are `ㄹ`);
 *    2 이, 4 사, 5 오, 9 구 do not. A number that ends in zeros (10, 100, 1,000, 4.50) ends in 십/백/천/만/영: a final
 *    consonant, never `ㄹ`. A `$` amount (`$4.99`) is read as 달러, which has none; `%` is read 퍼센트, which has none.
 * 3. A Latin letter is read as a Korean reader reads it, best effort (see the limits below): the LAST word of a
 *    camelCase/PascalCase name decides; one letter, or an all-capitals run (`ID`, `SQL`, `PR`), is spelled out letter by
 *    letter (L, R are `ㄹ`; M, N take a final consonant, the rest do not); otherwise a final `ng`, `l`, `m`, `n`, `ic` or
 *    `ck` takes a final consonant, a silent `e` after `l`, `m` or `n` (`file`, `name`, `line`) is read through, and every
 *    other ending takes a vowel (`d t s k r p b g x` are read 드 트 스 크 리 프 브 그 스).
 *
 * What it cannot tell: text whose last character is none of the above (an emoji, `+`, `#`, Han characters, kana, a bare
 * jamo like `ㅋ`, an empty string). Then `josa` returns the pair spelled out, `은(는)`, and `endingOf` returns
 * `undefined`: a hedge that is readable and never wrong, instead of a particle that is wrong half of the time. Do not
 * choose it on purpose; if a sentence can end on such a value, put a fixed noun after the value instead.
 *
 * Known misses of the Latin rule, because English spelling does not fix the Korean reading: one-syllable words that
 * Korean writes with a final stop (`map` 맵, `app` 앱, `web` 웹, `git` 깃, `set` 셋, `job` 잡, `group` 그룹), `theme`
 * (테마), and acronyms that are words (`DONE` 던). A call site whose value is such free text should word the sentence so
 * that a fixed Korean noun stands between the value and the particle (`'${name}' 레인은`) rather than rely on this.
 *
 * A leaf module: no imports.
 */

export type JosaPair = "은/는" | "이/가" | "을/를" | "과/와" | "으로/로" | "이라/라" | "이나/나" | "이랑/랑";

/** How the last word of a value is said: with or without a final consonant, and whether that consonant is `ㄹ`. */
export type Ending = { readonly batchim: boolean; readonly rieul: boolean };

const PARTICLES: Record<JosaPair, readonly [withBatchim: string, withoutBatchim: string]> = {
	"은/는": ["은", "는"],
	"이/가": ["이", "가"],
	"을/를": ["을", "를"],
	"과/와": ["과", "와"],
	"으로/로": ["으로", "로"],
	"이라/라": ["이라", "라"],
	"이나/나": ["이나", "나"],
	"이랑/랑": ["이랑", "랑"],
};

const VOWEL: Ending = { batchim: false, rieul: false };
const FINAL: Ending = { batchim: true, rieul: false };
const RIEUL: Ending = { batchim: true, rieul: true };

/** Closing and opening marks, quotes, blanks and punctuation that carry no sound of their own. */
const SILENT_TAIL = /[\s)\]}>(\[{<'"`”’“‘」』「『.,:;!?…·/\\\-_~]+$/u;

/** Sino-Korean readings of the digits 1 to 9 (0 is handled with the number it ends). */
const DIGIT_ENDING: Readonly<Record<string, Ending>> = {
	"1": RIEUL, // 일
	"2": VOWEL, // 이
	"3": FINAL, // 삼
	"4": VOWEL, // 사
	"5": VOWEL, // 오
	"6": FINAL, // 육
	"7": RIEUL, // 칠
	"8": RIEUL, // 팔
	"9": VOWEL, // 구
};

/** The Korean names of the letters, by the final consonant of the name: 엘 알 / 엠 엔; every other name ends in a vowel. */
const LETTER_ENDING: Readonly<Record<string, Ending>> = { l: RIEUL, r: RIEUL, m: FINAL, n: FINAL };

/** The last word of a camelCase, PascalCase, snake_case or kebab-case token: `parseHTML` gives `HTML`, `HeadShared` gives `Shared`. */
const LAST_WORD = /[A-Z]{2,}$|[A-Z]?[a-z]+$|[A-Za-z]$/;

function latinEnding(token: string): Ending {
	const word = LAST_WORD.exec(token)?.[0] ?? token;
	if (word.length === 1 || word === word.toUpperCase()) {
		// A single letter or an all-capitals run is spelled out (PR is 피알, SQL is 에스큐엘): the last letter decides.
		return LETTER_ENDING[word.slice(-1).toLowerCase()] ?? VOWEL;
	}
	const w = word.toLowerCase();
	if (w.endsWith("ng")) return FINAL;
	if (w.length >= 3 && /[lmn]e$/.test(w)) return /le$/.test(w) ? RIEUL : FINAL;
	if (w.endsWith("l")) return RIEUL;
	if (/[mn]$/.test(w)) return FINAL;
	if (/(ic|ick)$/.test(w) || (w.endsWith("ck") && !w.endsWith("heck"))) return FINAL;
	return VOWEL;
}

/** How a Korean reader ends the last word of `value`; `undefined` when that cannot be told (see the module comment). */
export function endingOf(value: string): Ending | undefined {
	const text = value.normalize("NFKC").replace(SILENT_TAIL, "");
	const last = text.codePointAt(text.length - 1);
	if (last === undefined) return undefined;
	if (last >= 0xac00 && last <= 0xd7a3) {
		const jongseong = (last - 0xac00) % 28;
		return jongseong === 0 ? VOWEL : jongseong === 8 ? RIEUL : FINAL;
	}
	const tail = text.slice(-1);
	if (tail === "%") return VOWEL; // 퍼센트
	if (tail >= "0" && tail <= "9") {
		if (/\$\s*\d[\d,]*(\.\d+)?$/.test(text)) return VOWEL; // $4.99 is read 4달러 99센트
		return tail === "0" ? FINAL : DIGIT_ENDING[tail];
	}
	if (/[A-Za-z]/.test(tail)) return latinEnding(/[A-Za-z]+$/.exec(text)?.[0] ?? tail);
	return undefined;
}

/** The particle alone for the text before it. `은(는)`-style when the ending cannot be told. */
export function josa(value: string, pair: JosaPair): string {
	const [withBatchim, withoutBatchim] = PARTICLES[pair];
	const ending = endingOf(value);
	if (ending === undefined) return `${withBatchim}(${withoutBatchim})`;
	if (pair === "으로/로") return ending.batchim && !ending.rieul ? withBatchim : withoutBatchim;
	return ending.batchim ? withBatchim : withoutBatchim;
}

/** `value` followed by the particle that fits it: `withJosa("필수 결과", "을/를")` is `필수 결과를`. */
export function withJosa(value: string, pair: JosaPair): string {
	return `${value}${josa(value, pair)}`;
}
