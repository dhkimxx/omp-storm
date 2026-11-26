/**
 * Finds the places in the source where a particle follows a value inserted into a sentence: a template substitution
 * (`${name}은`) or a `+` operand (`name + "은"`). The particle then depends on the value, so it must come from
 * `josa()`/`withJosa()` or follow a fixed noun in the sentence. Shared by the lint test and by anyone listing the sites.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import ts from "typescript";

export type BareParticle = { file: string; line: number; particle: string; value: string; spaced: boolean };

/** A closing mark may sit between the value and its particle: `'x'은`, `(x)을`, `` `x`를 ``, `"x"는`, `**x**는`. */
const CLOSERS = "['\"`)\\]”’」』>*]*";

/** The particles whose form depends on the word before them, longest first so that `이라고` is not read as `이`. */
const PARTICLES = [
	"은(는)", "는(은)", "이(가)", "가(이)", "을(를)", "를(을)", "와(과)", "과(와)", "으로(로)", "(으)로", "(이)라", "(이)다",
	"이라고", "이라서", "이라는", "이라며", "이라", "이라도", "이므로", "이지만", "이어서", "이었", "이에요", "이야", "이면", "이며", "이고", "이든", "이란", "이랑", "이나", "이다",
	"으로서", "으로써", "으로는", "으로도", "으로의", "으로", "로서", "로써", "로는", "로도", "로의",
	"은", "는", "이", "가", "을", "를", "와", "과", "로", "라", "나", "랑", "란",
];
/** Spelled-out forms mean the author knew the word was unknown; they are wrong for every input, so a space never hides them. */
const PLACEHOLDER = new Set(["은(는)", "는(은)", "이(가)", "가(이)", "을(를)", "를(을)", "와(과)", "과(와)", "으로(로)", "(으)로", "(이)라", "(이)다"]);
/** After a space these are particles that were detached by mistake; the others (`이 실행`, `나 ...`) are ordinary words. */
const SPACED = new Set([...PLACEHOLDER, "를", "로", "은", "는", "을"]);

const escape = (text: string): string => text.replace(/[()]/g, "\\$&");
const AFTER = new RegExp(`^${CLOSERS}( ?)(${PARTICLES.map(escape).join("|")})(?![가-힣])`);

function sourceFiles(dir: string): string[] {
	return fs
		.readdirSync(dir, { withFileTypes: true })
		.flatMap(entry => (entry.isDirectory() ? sourceFiles(path.join(dir, entry.name)) : entry.name.endsWith(".ts") ? [path.join(dir, entry.name)] : []))
		.sort();
}

export const ALLOW_MARK = "josa-ok";

/**
 * Allowed by construction: the value sits inside parentheses that open right behind a Hangul word, and the particle
 * follows the closing parenthesis (`실행(${runId})이`, `소유자(pid ${pid}, 호스트 ${host})가`). The particle then belongs
 * to that fixed word. `before` is the sentence so far, with a placeholder where earlier values were inserted.
 */
function belongsToWordBeforeParenthesis(before: string, following: string): boolean {
	if (!following.startsWith(")")) return false;
	const open: string[] = [];
	for (let i = 0; i < before.length; i++) {
		if (before[i] === "(") open.push(before[i - 1] ?? "");
		else if (before[i] === ")") open.pop();
	}
	return /[가-힣]/.test(open.at(-1) ?? "");
}

/**
 * Every bare particle after an inserted value under `root`, as paths relative to `base`. A site is allowed when the line
 * of the value, or the line above it, carries a `josa-ok: <reason>` comment (a value that is provably a number or a
 * fixed phrase). Files in `skip` (paths relative to `base`) are not looked at.
 */
export function findBareParticles(root: string, base: string, skip: readonly string[] = []): BareParticle[] {
	const hits: BareParticle[] = [];
	for (const file of sourceFiles(root)) {
		const relative = path.relative(base, file);
		if (skip.includes(relative)) continue;
		const text = fs.readFileSync(file, "utf8");
		const lines = text.split("\n");
		const source = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);
		const lineOf = (position: number): number => source.getLineAndCharacterOfPosition(position).line + 1;
		const check = (following: string, valueNode: ts.Node, literalPosition: number, before = ""): void => {
			const match = AFTER.exec(following);
			if (match === null) return;
			if (belongsToWordBeforeParenthesis(before, following)) return;
			const particle = match[2] ?? "";
			const spaced = match[1] === " ";
			if (spaced && !SPACED.has(particle)) return;
			const line = lineOf(literalPosition);
			const valueLine = lineOf(valueNode.getStart());
			const marked = [valueLine, valueLine - 1, line, line - 1].some(n => (lines[n - 1] ?? "").includes(`${ALLOW_MARK}:`));
			if (marked) return;
			hits.push({ file: relative, line, particle, value: valueNode.getText(source).replace(/\s+/g, " ").slice(0, 60), spaced });
		};
		const visit = (node: ts.Node): void => {
			if (ts.isTemplateExpression(node)) {
				let before = node.head.text;
				for (const span of node.templateSpans) {
					check(span.literal.text, span.expression, span.literal.getStart(), before);
					before += `\u0001${span.literal.text}`;
				}
			}
			if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
				const { left, right } = node;
				const isLiteral = (n: ts.Node): boolean => ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n);
				if (isLiteral(right) && !isLiteral(left)) check((right as ts.StringLiteral).text, left, right.getStart());
			}
			ts.forEachChild(node, visit);
		};
		visit(source);
	}
	return hits;
}
