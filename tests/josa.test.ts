/** The particle helper: Hangul is exact, digits and Latin are read as a Korean reader reads them, the rest is hedged. */
import { describe, expect, test } from "bun:test";
import { endingOf, josa, type JosaPair, withJosa } from "../src/josa.ts";

const TOPIC: JosaPair = "은/는";
const SUBJECT: JosaPair = "이/가";
const OBJECT: JosaPair = "을/를";
const WITH: JosaPair = "과/와";
const VIA: JosaPair = "으로/로";

describe("Hangul is exact", () => {
	test("every syllable agrees with its decomposition (a trailing jamo means a final consonant, U+11AF means ㄹ)", () => {
		for (let code = 0xac00; code <= 0xd7a3; code++) {
			const syllable = String.fromCodePoint(code);
			const parts = syllable.normalize("NFD");
			const hasFinal = parts.length === 3;
			const isRieul = hasFinal && parts.codePointAt(2) === 0x11af;
			expect(josa(syllable, TOPIC)).toBe(hasFinal ? "은" : "는");
			expect(josa(syllable, SUBJECT)).toBe(hasFinal ? "이" : "가");
			expect(josa(syllable, OBJECT)).toBe(hasFinal ? "을" : "를");
			expect(josa(syllable, WITH)).toBe(hasFinal ? "과" : "와");
			expect(josa(syllable, VIA)).toBe(hasFinal && !isRieul ? "으로" : "로");
		}
	});

	test("words from the real texts", () => {
		expect(withJosa("필수 결과", OBJECT)).toBe("필수 결과를");
		expect(withJosa("통합 반영", OBJECT)).toBe("통합 반영을");
		expect(withJosa("검토 가능 제출", OBJECT)).toBe("검토 가능 제출을");
		expect(withJosa("쓰기 범위가 선언되지 않은 공유 작업", SUBJECT)).toBe("쓰기 범위가 선언되지 않은 공유 작업이");
		expect(withJosa("읽기 전용 작업", WITH)).toBe("읽기 전용 작업과");
		expect(withJosa("서울", VIA)).toBe("서울로"); // ㄹ takes 로, not 으로
		expect(withJosa("부산", VIA)).toBe("부산으로");
		expect(withJosa("제주", VIA)).toBe("제주로");
	});

	test("decomposed Hangul (macOS file names) reads like the composed form", () => {
		const decomposed = "작업".normalize("NFD");
		expect(decomposed).not.toBe("작업");
		expect(josa(decomposed, SUBJECT)).toBe("이");
		expect(josa("결과".normalize("NFD"), SUBJECT)).toBe("가");
	});

	test("all pairs, with and without a final consonant", () => {
		const pairs: [JosaPair, string, string][] = [
			["은/는", "은", "는"],
			["이/가", "이", "가"],
			["을/를", "을", "를"],
			["과/와", "과", "와"],
			["으로/로", "으로", "로"],
			["이라/라", "이라", "라"],
			["이나/나", "이나", "나"],
			["이랑/랑", "이랑", "랑"],
		];
		for (const [pair, withFinal, withoutFinal] of pairs) {
			expect(josa("밥", pair)).toBe(withFinal);
			expect(josa("나무", pair)).toBe(withoutFinal);
		}
	});
});

describe("closing marks, quotes and brackets are looked through", () => {
	test("the character before the mark decides", () => {
		expect(josa("'작업'", SUBJECT)).toBe("이");
		expect(josa('"결과"', SUBJECT)).toBe("가");
		expect(josa("`결과`", TOPIC)).toBe("는");
		expect(josa("「작업」", OBJECT)).toBe("을");
		expect(josa("『작업』", OBJECT)).toBe("을");
		expect(josa("“결과”", OBJECT)).toBe("를");
		expect(josa("(작업)", SUBJECT)).toBe("이");
		expect(josa("[결과]", SUBJECT)).toBe("가");
		expect(josa("{작업}", SUBJECT)).toBe("이");
		expect(josa("<작업>", SUBJECT)).toBe("이");
		expect(josa("구현(작업)", SUBJECT)).toBe("이");
		expect(josa("agent(구현)", TOPIC)).toBe("은");
		expect(josa("agent(리뷰)", TOPIC)).toBe("는");
	});

	test("trailing blanks and punctuation are skipped", () => {
		expect(josa("작업 ", SUBJECT)).toBe("이");
		expect(josa("작업\n", SUBJECT)).toBe("이");
		expect(josa("결과…", SUBJECT)).toBe("가");
		expect(josa("결과.", SUBJECT)).toBe("가");
		expect(josa("작업?!", SUBJECT)).toBe("이");
		expect(josa("docs/", SUBJECT)).toBe("가"); // docs: 독스
		expect(josa("'결과' ", SUBJECT)).toBe("가");
	});

	test("a pair of marks with nothing inside falls back to what precedes it", () => {
		expect(josa("작업()", SUBJECT)).toBe("이");
		expect(josa("결과''", SUBJECT)).toBe("가");
	});
});

describe("digits are read the Sino-Korean way", () => {
	test("each digit", () => {
		const withFinal = ["0", "1", "3", "6", "7", "8"];
		const without = ["2", "4", "5", "9"];
		for (const digit of withFinal) expect(josa(`레인${digit}`, SUBJECT)).toBe("이");
		for (const digit of without) expect(josa(`레인${digit}`, SUBJECT)).toBe("가");
	});

	test("ㄹ digits take 로 (일, 칠, 팔) and the other final consonants take 으로 (영, 삼, 육)", () => {
		for (const digit of ["1", "7", "8"]) expect(josa(`step${digit}`, VIA)).toBe("로");
		for (const digit of ["0", "3", "6"]) expect(josa(`step${digit}`, VIA)).toBe("으로");
		for (const digit of ["2", "4", "5", "9"]) expect(josa(`step${digit}`, VIA)).toBe("로");
	});

	test("a number that ends in zeros ends in 십, 백, 천, 만 or 영: a final consonant, never ㄹ", () => {
		for (const text of ["10", "100", "1,000", "20", "4.50", "0", "30000"]) {
			expect(josa(text, OBJECT)).toBe("을");
			expect(josa(text, VIA)).toBe("으로");
		}
	});

	test("the number at the end of a path or id", () => {
		expect(josa("src/a.ts:13", OBJECT)).toBe("을"); // 십삼 ... 삼
		expect(josa("src/a.ts:14", OBJECT)).toBe("를"); // 십사
		expect(josa("knowledge/x.md:13", OBJECT)).toBe("을");
		expect(josa("gpt-6.2", SUBJECT)).toBe("가"); // 이
		expect(josa("claude-sonnet-5-5", SUBJECT)).toBe("가"); // 오
		expect(josa("qat-8", SUBJECT)).toBe("이"); // 팔
	});

	test("full-width digits are read the same", () => {
		expect(josa("작업３", SUBJECT)).toBe("이");
		expect(josa("작업２", SUBJECT)).toBe("가");
	});

	test("a dollar amount is read 달러 (and the cents 센트): no final consonant; a percentage is read 퍼센트", () => {
		for (const amount of ["$5.00", "$4.99", "$0.4250", "$12", "$1,000", "$ 3"]) expect(josa(amount, OBJECT)).toBe("를");
		for (const amount of ["50%", "100%", "3.5%"]) expect(josa(amount, SUBJECT)).toBe("가");
	});
});

describe("Latin text is read the way a Korean reader reads it", () => {
	test("a vowel ending, or a stop or fricative read with 으, takes the vowel form", () => {
		// bash 배시, write 라이트, edit 에디트, task 태스크, explorer 익스플로러, claude 클로드, deepseek 딥시크, max 맥스
		const values = ["bash", "write", "edit", "task", "implementer", "explorer", "BuildGemmaQatHeadShared", "GemmaQatBody", "high", "max", "claude", "deepseek", "openai", "code"];
		for (const value of values) expect(josa(value, TOPIC)).toBe("는");
	});

	test("a final l, m, n or ng takes the final consonant", () => {
		expect(josa("eval", TOPIC)).toBe("은"); // 이밸
		expect(josa("mistral", OBJECT)).toBe("을"); // 미스트랄
		expect(josa("medium", TOPIC)).toBe("은"); // 미디엄
		expect(josa("minimal", TOPIC)).toBe("은"); // 미니멀
		expect(josa("plan", OBJECT)).toBe("을"); // 플랜
		expect(josa("qat-whole-generation", SUBJECT)).toBe("이"); // 제너레이션
		expect(josa("string", OBJECT)).toBe("을"); // 스트링
		expect(josa("matched-december-comparison", TOPIC)).toBe("은"); // 컴패리슨
	});

	test("ㄹ takes 로 and the other final consonants 으로", () => {
		expect(josa("eval", VIA)).toBe("로");
		expect(josa("devstral-medium", VIA)).toBe("으로"); // 미디엄
		expect(josa("gpt-6.2-sol", VIA)).toBe("로"); // 솔
		expect(josa("plan", VIA)).toBe("으로");
		expect(josa("bash", VIA)).toBe("로");
	});

	test("ic and ck are read 익 and 크: anthropic, topic, block, stack", () => {
		expect(josa("anthropic", OBJECT)).toBe("을"); // 앤트로픽
		expect(josa("topic", SUBJECT)).toBe("이");
		expect(josa("quick", SUBJECT)).toBe("이"); // 퀵
		expect(josa("block", SUBJECT)).toBe("이");
		expect(josa("stack", SUBJECT)).toBe("이");
		expect(josa("check", SUBJECT)).toBe("가"); // 체크 is the one common word that does not follow the ck rule
	});

	test("a silent e after l, m or n is read through: file, name, line, rule, role, home", () => {
		for (const word of ["file", "rule", "role", "table", "module"]) expect(josa(word, SUBJECT)).toBe("이"); // 파일 룰 롤 테이블 모듈
		for (const word of ["name", "time", "home", "frame"]) expect(josa(word, SUBJECT)).toBe("이"); // 네임 타임 홈 프레임
		for (const word of ["line", "phone", "engine", "pipeline"]) expect(josa(word, SUBJECT)).toBe("이"); // 라인 폰 엔진
		for (const word of ["code", "type", "scope", "message", "route", "state", "case", "save"]) expect(josa(word, SUBJECT)).toBe("가");
		expect(josa("file", VIA)).toBe("로");
		expect(josa("name", VIA)).toBe("으로");
		expect(josa("me", SUBJECT)).toBe("가"); // two letters are not a silent e
	});

	test("camelCase, PascalCase, snake_case and kebab-case are judged by the last word", () => {
		expect(josa("parseHTML", SUBJECT)).toBe("이"); // 에이치티엠엘 ㄹ
		expect(josa("runID", SUBJECT)).toBe("가"); // 아이디
		expect(josa("HTTPServer", SUBJECT)).toBe("가"); // 서버
		expect(josa("headShared", SUBJECT)).toBe("가");
		expect(josa("build_model", SUBJECT)).toBe("이");
		expect(josa("lane-name", SUBJECT)).toBe("이");
		expect(josa("iPhone", SUBJECT)).toBe("이"); // 폰
	});

	test("one letter or an all-capitals run is spelled out letter by letter", () => {
		expect(josa("SQL", OBJECT)).toBe("을"); // 에스큐엘
		expect(josa("PR", OBJECT)).toBe("을"); // 피알
		expect(josa("RAM", OBJECT)).toBe("을"); // 램... 알에이엠
		expect(josa("JSON", OBJECT)).toBe("을"); // 제이슨
		expect(josa("ID", OBJECT)).toBe("를"); // 아이디
		expect(josa("API", OBJECT)).toBe("를"); // 에이피아이
		expect(josa("CLI", OBJECT)).toBe("를");
		expect(josa("URL", OBJECT)).toBe("을");
		expect(josa("A", SUBJECT)).toBe("가"); // 에이
		expect(josa("x", SUBJECT)).toBe("가"); // 엑스
		expect(josa("L", VIA)).toBe("로"); // 엘
		expect(josa("M", VIA)).toBe("으로"); // 엠
		expect(josa("N", SUBJECT)).toBe("이"); // 엔
	});

	test("a path or file name is read by its last word and extension", () => {
		expect(josa("docs/report.json", SUBJECT)).toBe("이"); // 제이슨
		expect(josa("src/a.ts", SUBJECT)).toBe("가"); // 티에스
		expect(josa("src/index.md", SUBJECT)).toBe("가"); // 엠디: 디
		expect(josa("README.md", SUBJECT)).toBe("가");
	});
});

describe("what it cannot tell", () => {
	test("returns the pair spelled out, and endingOf returns undefined", () => {
		for (const value of ["", " ", "...", "🙂", "+", "#", "漢字", "ひらがな", "ㅋㅋ", "()", "'"]) {
			expect(endingOf(value)).toBeUndefined();
			expect(josa(value, TOPIC)).toBe("은(는)");
			expect(josa(value, SUBJECT)).toBe("이(가)");
			expect(josa(value, OBJECT)).toBe("을(를)");
			expect(josa(value, VIA)).toBe("으로(로)");
		}
		expect(withJosa("🙂", TOPIC)).toBe("🙂은(는)");
	});

	test("a value that merely contains such characters is still judged by its last readable character", () => {
		expect(josa("작업 🙂", TOPIC)).toBe("은(는)"); // the emoji is last: cannot tell
		expect(josa("🙂 작업", TOPIC)).toBe("은");
		expect(josa("漢字 결과", TOPIC)).toBe("는");
	});
});

describe("endingOf", () => {
	test("reports the final consonant and whether it is ㄹ", () => {
		expect(endingOf("서울")).toEqual({ batchim: true, rieul: true });
		expect(endingOf("작업")).toEqual({ batchim: true, rieul: false });
		expect(endingOf("결과")).toEqual({ batchim: false, rieul: false });
	});
});
