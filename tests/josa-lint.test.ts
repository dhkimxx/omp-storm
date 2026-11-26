/**
 * Stops the next wrong Korean particle: a value inserted into a sentence and a bare particle right behind it
 * (`${name}은`, `name + "를"`) is right for some names and wrong for the rest. The particle must come from `josa()` or
 * follow a fixed noun, which the scan below does not flag.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { ALLOW_MARK, findBareParticles } from "./josa-scan.ts";

const REPO = path.resolve(import.meta.dir, "..");

function advice(file: string, line: number, value: string, particle: string, spaced: boolean): string {
	return `${file}:${line}: the particle \`${particle}\`${spaced ? " (detached by a space)" : ""} follows the inserted value \`${value}\`.`;
}

describe("no bare particle after an inserted value in src/", () => {
	test("every particle after a value comes from josa() or follows a fixed noun", () => {
		const hits = findBareParticles(path.join(REPO, "src"), REPO);
		const message = hits.map(hit => advice(hit.file, hit.line, hit.value, hit.particle, hit.spaced)).join("\n");
		expect(
			message,
			[
				"A particle after an inserted value is wrong for some inputs (필수 결과을, 레인 이름가). Fix each site by one of:",
				"  1. put a fixed noun between the value and the particle:  '${name}' 레인은  /  ${path} 파일이  /  ${id} 결과를",
				'  2. let the helper choose:  ${withJosa(value, "은/는")} (import { withJosa } from "./josa.ts"), or ${josa(value, "을/를")} after the value',
				"  3. keep the value inside parentheses behind a fixed word:  실행(${runId})이  (the particle belongs to the word)",
				`  4. only if the value is provably a fixed phrase or a number: add a \`// ${ALLOW_MARK}: <why>\` comment on that line or the line above.`,
				"Never write 이(가), 은(는), 을(를) or a particle after a space.",
				"",
			].join("\n"),
		).toBe("");
	});

	test("the scan covers the four files once left out of it", () => {
		for (const file of ["src/extension.ts", "src/runtime/attempt-collector.ts", "src/runtime/attempt-report.ts", "src/runtime/controller.ts"]) {
			expect(fs.existsSync(path.join(REPO, file))).toBe(true);
		}
	});
});

describe("what the scan flags and what it lets through", () => {
	let dir = "";
	beforeAll(() => {
		dir = fs.mkdtempSync("/tmp/storm-josa-lint-");
	});
	afterAll(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	/** Scans one source text and returns the particles it flagged, in order. */
	const flagged = (source: string): string[] => {
		const file = path.join(dir, "sample.ts");
		fs.writeFileSync(file, source);
		return findBareParticles(dir, dir).map(hit => hit.particle);
	};

	test("flags a particle straight behind a template value, a quoted value, or a `+` operand", () => {
		expect(flagged("const a = `${name}은 없습니다`;")).toEqual(["은"]);
		expect(flagged("const a = `'${name}'을 찾지 못했습니다`;")).toEqual(["을"]);
		expect(flagged("const a = `결과 '${id}'(${why})는 없습니다`;")).toEqual(["는"]);
		expect(flagged("const a = `**${name}**가 없습니다`;")).toEqual(["가"]);
		expect(flagged('const a = name + "을 찾지 못했습니다";')).toEqual(["을"]);
		expect(flagged("const a = `${x}으로 보냅니다`;")).toEqual(["으로"]);
		expect(flagged("const a = `${x}로서 보냅니다`;")).toEqual(["로서"]);
		expect(flagged("const a = `${x}이라고 합니다`;")).toEqual(["이라고"]);
		expect(flagged("const a = `${x}이다.`;")).toEqual(["이다"]);
	});

	test("flags the parenthesised forms and a particle detached by a space", () => {
		expect(flagged("const a = `${x}이(가) 없습니다`;")).toEqual(["이(가)"]);
		expect(flagged("const a = `${x} 은(는) 없습니다`;")).toEqual(["은(는)"]);
		expect(flagged("const a = `${x} 를 쓰세요`;")).toEqual(["를"]);
		expect(flagged("const a = `${x} 로 보냅니다`;")).toEqual(["로"]);
	});

	test("lets through a fixed noun before the particle, the helper, and words that merely start with a particle letter", () => {
		expect(flagged("const a = `'${name}' 레인은 없습니다`;")).toEqual([]);
		expect(flagged("const a = `${path} 파일이 없습니다`;")).toEqual([]);
		expect(flagged('const a = `${withJosa(name, "은/는")} 없습니다`;')).toEqual([]);
		expect(flagged('const a = `${name}${josa(name, "은/는")} 없습니다`;')).toEqual([]);
		expect(flagged("const a = `${n}개가 있고 ${n}가지를 봅니다`;")).toEqual([]);
		expect(flagged("const a = `${x}이후에 ${x}나눠서 ${x}라벨을 ${x}로그에 ${x}이름을`;")).toEqual([]);
		expect(flagged("const a = `${x}에서 ${x}에게 ${x}의 ${x}도 ${x}만 ${x}부터`;")).toEqual([]);
		expect(flagged("const a = `이 ${x} 나 ${y}`;")).toEqual([]); // a demonstrative and a conjunction after a space
	});

	test("lets through a value inside parentheses that open behind a Hangul word", () => {
		expect(flagged("const a = `실행(${runId})이 진행 중입니다`;")).toEqual([]);
		expect(flagged("const a = `소유자(pid ${pid}, 호스트 ${host})가 종료됐습니다`;")).toEqual([]);
		expect(flagged("const a = `잠금 파일(${lock})을 지우세요`;")).toEqual([]);
		expect(flagged("const a = `실행(${a}/${b})은 같습니다`;")).toEqual([]);
		// ... but not behind a quote, a Latin word, or after the parenthesis has closed
		expect(flagged("const a = `'${key}'(${reason})은 안 됩니다`;")).toEqual(["은"]);
		expect(flagged("const a = `worktree(${root})를 읽습니다`;")).toEqual(["를"]);
		expect(flagged("const a = `실행(${a}) ${b})를 읽습니다`;")).toEqual(["를"]);
	});

	test("lets through a line marked with the allow comment, on the line or the line above", () => {
		expect(flagged(`const a = \`\${n}이\`; // ${ALLOW_MARK}: a closed set`)).toEqual([]);
		expect(flagged(`// ${ALLOW_MARK}: a closed set\nconst a = \`\${n}이\`;`)).toEqual([]);
		expect(flagged(`const a = \`\${n}이\`; // not marked`)).toEqual(["이"]);
	});

	test("reads only code: a comment or an ordinary string is not a sentence with a value", () => {
		expect(flagged("// `${name}은` is the mistake this test finds\nconst a = 1;")).toEqual([]);
		expect(flagged('const a = "${name}은";')).toEqual([]);
	});

	test("skips the files it is told to skip", () => {
		fs.writeFileSync(path.join(dir, "skipped.ts"), "const a = `${name}은 없습니다`;");
		const only = findBareParticles(dir, dir, ["skipped.ts"]).map(hit => hit.file);
		expect(only).not.toContain("skipped.ts");
	});
});
