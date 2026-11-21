/**
 * Strict JSON parsing and RFC 8785 (JCS) canonicalization for config hashing.
 *
 * JSON.parse silently keeps the last of duplicate keys, so a config could hash the same while
 * meaning something different to a reader; the parser here rejects that instead.
 */

const MAX_SAFE = 2n ** 53n;

export type StrictJsonResult = { ok: true; value: unknown } | { ok: false; error: string };

class JsonError extends Error {}

class Parser {
	private pos = 0;
	constructor(private readonly text: string) {}

	parseDocument(): unknown {
		this.ws();
		const value = this.value("$");
		this.ws();
		if (this.pos < this.text.length) this.fail("JSON 뒤에 불필요한 내용이 있습니다");
		return value;
	}

	private fail(message: string): never {
		const before = this.text.slice(0, this.pos);
		const line = before.split("\n").length;
		const col = this.pos - before.lastIndexOf("\n");
		throw new JsonError(`${line}:${col}: ${message}`);
	}

	private ws(): void {
		while (this.pos < this.text.length) {
			const c = this.text.charCodeAt(this.pos);
			if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) this.pos++;
			else break;
		}
	}

	private value(path: string): unknown {
		const c = this.text[this.pos];
		switch (c) {
			case "{":
				return this.object(path);
			case "[":
				return this.array(path);
			case '"':
				return this.string();
			case "t":
				return this.literal("true", true);
			case "f":
				return this.literal("false", false);
			case "n":
				return this.literal("null", null);
			default:
				if (c === "-" || (c !== undefined && c >= "0" && c <= "9")) return this.number(path);
				return this.fail(c === undefined ? "JSON이 중간에 끝났습니다" : `예상하지 못한 문자 '${c}'`);
		}
	}

	private literal<T>(word: string, value: T): T {
		if (!this.text.startsWith(word, this.pos)) this.fail("잘못된 리터럴입니다");
		this.pos += word.length;
		return value;
	}

	private object(path: string): Record<string, unknown> {
		this.pos++;
		const out: Record<string, unknown> = {};
		const seen = new Set<string>();
		this.ws();
		if (this.text[this.pos] === "}") {
			this.pos++;
			return out;
		}
		for (;;) {
			this.ws();
			if (this.text[this.pos] !== '"') this.fail("객체 키는 문자열이어야 합니다");
			const key = this.string();
			if (seen.has(key)) this.fail(`${path}: 중복 키 "${key}"`);
			seen.add(key);
			this.ws();
			if (this.text[this.pos] !== ":") this.fail("':'가 필요합니다");
			this.pos++;
			this.ws();
			const v = this.value(`${path}.${key}`);
			// defineProperty keeps "__proto__" as an own data key instead of changing the prototype.
			Object.defineProperty(out, key, { value: v, enumerable: true, writable: true, configurable: true });
			this.ws();
			const c = this.text[this.pos];
			if (c === ",") {
				this.pos++;
				continue;
			}
			if (c === "}") {
				this.pos++;
				return out;
			}
			this.fail("',' 또는 '}'가 필요합니다");
		}
	}

	private array(path: string): unknown[] {
		this.pos++;
		const out: unknown[] = [];
		this.ws();
		if (this.text[this.pos] === "]") {
			this.pos++;
			return out;
		}
		for (;;) {
			this.ws();
			out.push(this.value(`${path}[${out.length}]`));
			this.ws();
			const c = this.text[this.pos];
			if (c === ",") {
				this.pos++;
				continue;
			}
			if (c === "]") {
				this.pos++;
				return out;
			}
			this.fail("',' 또는 ']'가 필요합니다");
		}
	}

	private string(): string {
		this.pos++;
		let out = "";
		let start = this.pos;
		for (;;) {
			if (this.pos >= this.text.length) this.fail("문자열이 닫히지 않았습니다");
			const code = this.text.charCodeAt(this.pos);
			if (code === 0x22) {
				out += this.text.slice(start, this.pos);
				this.pos++;
				return out;
			}
			if (code < 0x20) this.fail("문자열에 제어 문자가 있습니다");
			if (code === 0x5c) {
				out += this.text.slice(start, this.pos);
				const e = this.text[this.pos + 1];
				switch (e) {
					case '"':
						out += '"';
						break;
					case "\\":
						out += "\\";
						break;
					case "/":
						out += "/";
						break;
					case "b":
						out += "\b";
						break;
					case "f":
						out += "\f";
						break;
					case "n":
						out += "\n";
						break;
					case "r":
						out += "\r";
						break;
					case "t":
						out += "\t";
						break;
					case "u": {
						const hex = this.text.slice(this.pos + 2, this.pos + 6);
						if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.fail("잘못된 \\u 이스케이프입니다");
						out += String.fromCharCode(Number.parseInt(hex, 16));
						this.pos += 4;
						break;
					}
					default:
						this.fail("잘못된 이스케이프입니다");
				}
				this.pos += 2;
				start = this.pos;
				continue;
			}
			this.pos++;
		}
	}

	private number(path: string): number {
		const m = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(this.text.slice(this.pos));
		if (!m) this.fail("잘못된 숫자입니다");
		const token = m[0];
		const n = Number(token);
		if (!Number.isFinite(n)) this.fail(`${path}: 표현할 수 없는 숫자입니다`);
		if (Object.is(n, -0)) this.fail(`${path}: -0은 허용하지 않습니다`);
		// Number() rounds 2^53+1 down to 2^53, so check the token exactly when it is near the limit.
		if (Number.isInteger(n) && Math.abs(n) >= 2 ** 53) {
			const exact = /^-?[0-9]+$/.test(token) ? BigInt(token) : undefined;
			if (exact === undefined || exact > MAX_SAFE || exact < -MAX_SAFE) this.fail(`${path}: 정수가 2^53을 넘습니다`);
		}
		this.pos += token.length;
		return n;
	}
}

/**
 * Characters that can forge or hide what a terminal shows: control characters (ESC among them), format controls
 * (bidi overrides and isolates, zero-width marks, BOM) and line/paragraph separators.
 */
const UNSAFE_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/** `text` with each such character as a visible `\u{…}` escape; unchanged when it has none. */
export function escapeUnsafe(text: string): string {
	return text.replace(UNSAFE_CHARS, (c) => `\\u{${c.codePointAt(0)!.toString(16)}}`);
}

/** Parses config JSON strictly: one leading BOM stripped, duplicate keys, non-object roots, -0 and unsafe integers rejected. */
export function parseStrictJson(text: string): StrictJsonResult {
	const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
	try {
		const value = new Parser(body).parseDocument();
		if (value === null || typeof value !== "object" || Array.isArray(value)) {
			return { ok: false, error: "최상위 값은 JSON 객체여야 합니다" };
		}
		return { ok: true, value };
	} catch (error) {
		// The message quotes the file (a key, a character); it is shown to the user, so it must not carry raw controls.
		if (error instanceof JsonError) return { ok: false, error: escapeUnsafe(error.message) };
		throw error;
	}
}

function serializeNumber(n: number): string {
	if (!Number.isFinite(n)) throw new TypeError("JSON에 표현할 수 없는 숫자입니다");
	// ECMAScript Number-to-string is exactly the JCS number form; -0 becomes "0".
	return JSON.stringify(n);
}

/**
 * Serializes with keys sorted by UTF-16 code units (JCS order). `indent` null gives the compact JCS
 * form; a string gives pretty output. Our own writer is needed because JSON.stringify puts
 * integer-like keys first regardless of order.
 */
export function formatJson(value: unknown, indent: string | null): string {
	const nl = indent === null ? "" : "\n";
	const colon = indent === null ? ":" : ": ";
	const write = (v: unknown, depth: string): string | undefined => {
		if (v === null) return "null";
		switch (typeof v) {
			case "string":
				return JSON.stringify(v);
			case "number":
				return serializeNumber(v);
			case "boolean":
				return v ? "true" : "false";
			case "undefined":
			case "function":
			case "symbol":
				return undefined;
			case "bigint":
				throw new TypeError("bigint는 JSON으로 직렬화할 수 없습니다");
		}
		const inner = indent === null ? "" : depth + indent;
		if (Array.isArray(v)) {
			if (v.length === 0) return "[]";
			const items = v.map(item => inner + (write(item, inner) ?? "null"));
			return `[${nl}${items.join(`,${nl}`)}${nl}${depth}]`;
		}
		const obj = v as Record<string, unknown>;
		const keys = Object.keys(obj).sort();
		const parts: string[] = [];
		for (const key of keys) {
			const s = write(obj[key], inner);
			if (s !== undefined) parts.push(`${inner}${JSON.stringify(key)}${colon}${s}`);
		}
		if (parts.length === 0) return "{}";
		return `{${nl}${parts.join(`,${nl}`)}${nl}${depth}}`;
	};
	return write(value, "") ?? "null";
}

/** RFC 8785 JCS canonical form. */
export function canonicalJson(value: unknown): string {
	return formatJson(value, null);
}

export function sha256Hex(data: string | Uint8Array): string {
	return new Bun.CryptoHasher("sha256").update(data).digest("hex");
}

/** "jcs-sha256:<hex>" of the canonical JSON; formatting and key order do not change it. */
export function configHash(value: unknown): string {
	return `jcs-sha256:${sha256Hex(canonicalJson(value))}`;
}

/** The first 12 hex characters of a config hash, as shown to the user. */
export function shortHash(hash: string): string {
	return hash.replace(/^jcs-sha256:/, "").slice(0, 12);
}
