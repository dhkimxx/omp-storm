import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { canonicalJson, configHash, parseStrictJson } from "../src/config/canonical.ts";
import { validateConfig } from "../src/config/schema.ts";
import { configPath, loadConfig, serializeConfig, writeConfig } from "../src/config/store.ts";
import type { StormConfig, TrialConfig } from "../src/types.ts";

const base: StormConfig = {
	version: 1,
	priority: "balanced",
	roles: {
		reviewer: { agent: "storm-reviewer", models: ["openai/gpt-5.2", "anthropic/claude-sonnet-4-5:high"], effort: "high" },
		explorer: { agent: "storm-explorer", models: ["openrouter/deepseek/deepseek-v4"] },
	},
	parallelism: 4,
	isolation: "isolated",
	contract: "workflowz",
	runtime: "omp",
	budget: { perRunUsd: 2.5, warnAtUsd: 2, onExceed: "block-spawns" },
};

function clone(): Record<string, any> {
	return structuredClone(base) as Record<string, any>;
}

const trial: TrialConfig = {
	id: "reviewer-c-20261120",
	role: "reviewer",
	model: "openai/gpt-6",
	share: 0.25,
	maxSpawns: 10,
	startsAt: "2026-11-20T00:00:00.000Z",
	endsAt: "2026-11-27T00:00:00.000Z",
	budgetUsd: 5,
};

function withTrial(c: Record<string, any>, over: Record<string, unknown>): void {
	c.trials = [{ ...trial, ...over }];
}

function parsed(text: string): unknown {
	const r = parseStrictJson(text);
	if (!r.ok) throw new Error(r.error);
	return r.value;
}

const dirs: string[] = [];
async function tempRoot(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "storm-config-"));
	dirs.push(dir);
	return dir;
}
afterEach(async () => {
	for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
});

describe("parseStrictJson", () => {
	test("rejects duplicate keys that JSON.parse would silently merge", () => {
		const r = parseStrictJson('{"a":1,"b":{"x":1,"x":2}}');
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain('"x"');
	});

	test("rejects non-object roots, -0, unsafe integers, trailing garbage", () => {
		for (const text of ["[1]", '"s"', "1", "null", '{"a":-0}', '{"a":-0.0}', '{"a":9007199254740993}', '{"a":1e400}', "{} x", '{"a":01}', '{"a":"\n"}']) {
			expect(parseStrictJson(text).ok).toBe(false);
		}
		expect(parseStrictJson('{"a":9007199254740992,"b":0.5,"c":-1}').ok).toBe(true);
	});

	test("strips exactly one leading BOM", () => {
		expect(parsed('\uFEFF{"a":1}')).toEqual({ a: 1 });
		expect(parseStrictJson('\uFEFF\uFEFF{"a":1}').ok).toBe(false);
	});

	test("keeps __proto__ as data instead of changing the prototype", () => {
		const v = parsed('{"__proto__":{"polluted":true}}') as Record<string, unknown>;
		expect(Object.getPrototypeOf(v)).toBe(Object.prototype);
		expect(Object.keys(v)).toEqual(["__proto__"]);
		expect(canonicalJson(v)).toBe('{"__proto__":{"polluted":true}}');
	});

	test("decodes escapes and surrogate pairs", () => {
		expect(parsed('{"s":"\\u00e9\\n\\ud83d\\ude00\\/"}')).toEqual({ s: "é\n😀/" });
	});
});

describe("canonicalJson / configHash", () => {
	test("matches RFC 8785 for sorting, numbers and escapes", () => {
		expect(canonicalJson({ b: [3, { z: 1, a: 2 }], a: "\u2028\"", "10": 1, "9": 2 })).toBe('{"10":1,"9":2,"a":"\u2028\\"","b":[3,{"a":2,"z":1}]}');
		expect(canonicalJson({ n: [1e21, 1e-7, 0.1, 100, 1.5e300] })).toBe('{"n":[1e+21,1e-7,0.1,100,1.5e+300]}');
		// UTF-16 code unit order, not code point order: U+1F600 (D83D DE00) sorts before U+E000.
		expect(canonicalJson({ "\uE000": 2, "\u{1F600}": 1 })).toBe('{"\u{1F600}":1,"\uE000":2}');
	});

	test("hash ignores whitespace, indentation and key order but not model order", () => {
		const a = configHash(parsed(JSON.stringify(base)));
		const b = configHash(parsed(`\uFEFF${JSON.stringify(base, null, 4).replaceAll("\n", "\r\n")}`));
		const shuffled = clone();
		const { version, ...rest } = shuffled;
		const c = configHash(parsed(JSON.stringify({ ...rest, version })));
		expect(b).toBe(a);
		expect(c).toBe(a);
		expect(a).toMatch(/^jcs-sha256:[0-9a-f]{64}$/);

		const swapped = clone();
		swapped.roles.reviewer.models.reverse();
		expect(configHash(swapped)).not.toBe(a);
	});
});

describe("validateConfig", () => {
	test("accepts the base config and warns on unknown fields without erroring", () => {
		const v = clone();
		v.extra = 1;
		v.roles.reviewer.fallback = "x";
		const r = validateConfig(v);
		expect(r.errors).toEqual([]);
		expect(r.config).toBeDefined();
		expect(r.warnings).toEqual(["roles.reviewer.fallback: 알 수 없는 필드입니다", "extra: 알 수 없는 필드입니다"]);
	});

	const cases: Array<[string, (c: Record<string, any>) => void, string]> = [
		["version", c => (c.version = 2), "version:"],
		["priority", c => (c.priority = "fast"), "priority:"],
		["empty roles", c => (c.roles = {}), "roles:"],
		["roles array", c => (c.roles = []), "roles:"],
		["agent prefix", c => (c.roles.reviewer.agent = "reviewer"), "roles.reviewer.agent:"],
		["agent case", c => (c.roles.reviewer.agent = "storm-Reviewer"), "roles.reviewer.agent:"],
		["empty models", c => (c.roles.reviewer.models = []), "roles.reviewer.models:"],
		["model no slash", c => (c.roles.reviewer.models = ["gpt-5"]), "roles.reviewer.models[0]: provider/id 형식이 아닙니다"],
		["model whitespace", c => (c.roles.explorer.models = ["a/b", "a/ b"]), "roles.explorer.models[1]:"],
		["model empty id", c => (c.roles.explorer.models = ["a/"]), "roles.explorer.models[0]:"],
		["model non-string", c => (c.roles.explorer.models = [1]), "roles.explorer.models[0]:"],
		["effort", c => (c.roles.reviewer.effort = "huge"), "roles.reviewer.effort:"],
		["parallelism zero", c => (c.parallelism = 0), "parallelism:"],
		["parallelism 17", c => (c.parallelism = 17), "parallelism:"],
		["parallelism fraction", c => (c.parallelism = 1.5), "parallelism:"],
		["isolation", c => (c.isolation = "none"), "isolation:"],
		["contract", c => (c.contract = "swarm"), "contract:"],
		["runtime", c => (c.runtime = "orca"), "runtime:"],
		["budget zero", c => (c.budget.perRunUsd = 0), "budget.perRunUsd:"],
		["warn above limit", c => (c.budget.warnAtUsd = 3), "budget.warnAtUsd:"],
		["warn zero", c => (c.budget.warnAtUsd = 0), "budget.warnAtUsd:"],
		["onExceed", c => (c.budget.onExceed = "ignore"), "budget.onExceed:"],
		["workers zero", c => (c.roles.reviewer.workers = 0), "roles.reviewer.workers:"],
		["workers 17", c => (c.roles.reviewer.workers = 17), "roles.reviewer.workers:"],
		["workers fraction", c => (c.roles.reviewer.workers = 1.5), "roles.reviewer.workers:"],
		["workers string", c => (c.roles.reviewer.workers = "2"), "roles.reviewer.workers:"],
		["workers min above max", c => (c.roles.reviewer.workers = { min: 3, max: 2 }), "roles.reviewer.workers:"],
		["workers max 17", c => (c.roles.reviewer.workers = { min: 1, max: 17 }), "roles.reviewer.workers:"],
		["workers min zero", c => (c.roles.reviewer.workers = { min: 0, max: 2 }), "roles.reviewer.workers:"],
		["workers range missing max", c => (c.roles.reviewer.workers = { min: 1 }), "roles.reviewer.workers:"],
		["team contextCap zero", c => (c.contextCap = 0), "contextCap:"],
		["team contextCap fraction", c => (c.contextCap = 1.5), "contextCap:"],
		["role contextCap too big", c => (c.roles.reviewer.contextCap = 10_000_001), "roles.reviewer.contextCap:"],
		["fallbackRole unknown", c => (c.fallbackRole = "implementer"), "fallbackRole: roles에 있는 역할이어야 합니다"],
		["fallbackRole non-string", c => (c.fallbackRole = 1), "fallbackRole:"],
		["fallbackRole prototype key", c => (c.fallbackRole = "toString"), "fallbackRole:"],
		["trials object", c => (c.trials = {}), "trials: 배열이어야 합니다"],
		["trial item", c => (c.trials = [1]), "trials[0]: 객체여야 합니다"],
		["trial empty id", c => withTrial(c, { id: " " }), "trials[0].id:"],
		["trial duplicate id", c => (c.trials = [trial, { ...trial }]), "trials[1].id: 중복된 id입니다"],
		["trial role", c => withTrial(c, { role: "implementer" }), "trials[0].role:"],
		["trial model", c => withTrial(c, { model: "gpt-6" }), "trials[0].model: provider/id 형식이 아닙니다"],
		["trial effort", c => withTrial(c, { effort: "huge" }), "trials[0].effort:"],
		["trial share zero", c => withTrial(c, { share: 0 }), "trials[0].share:"],
		["trial share above one", c => withTrial(c, { share: 1.2 }), "trials[0].share:"],
		["trial maxSpawns zero", c => withTrial(c, { maxSpawns: 0 }), "trials[0].maxSpawns:"],
		["trial maxSpawns 1001", c => withTrial(c, { maxSpawns: 1001 }), "trials[0].maxSpawns:"],
		["trial maxSpawns fraction", c => withTrial(c, { maxSpawns: 2.5 }), "trials[0].maxSpawns:"],
		["trial startsAt garbage", c => withTrial(c, { startsAt: "tomorrow" }), "trials[0].startsAt:"],
		["trial startsAt without zone", c => withTrial(c, { startsAt: "2026-11-20T00:00:00" }), "trials[0].startsAt:"],
		["trial endsAt invalid date", c => withTrial(c, { endsAt: "2026-13-45T00:00:00Z" }), "trials[0].endsAt:"],
		["trial endsAt not after", c => withTrial(c, { endsAt: trial.startsAt }), "trials[0].endsAt: startsAt보다 뒤여야 합니다"],
		["trial budget zero", c => withTrial(c, { budgetUsd: 0 }), "trials[0].budgetUsd:"],
		["trial budget missing", c => withTrial(c, { budgetUsd: undefined }), "trials[0].budgetUsd:"],
	];
	for (const [name, mutate, expected] of cases) {
		test(`rejects ${name}`, () => {
			const c = clone();
			mutate(c);
			const r = validateConfig(c);
			expect(r.config).toBeUndefined();
			expect(r.errors.some(e => e.startsWith(expected))).toBe(true);
		});
	}

	test("budget and effort are optional", () => {
		const c = clone();
		delete c.budget;
		delete c.roles.reviewer.effort;
		expect(validateConfig(c).errors).toEqual([]);
	});

	test("accepts workers, fallbackRole and trials, and warns on unknown trial fields", () => {
		const c = clone();
		c.roles.reviewer.workers = 16;
		c.roles.explorer.workers = { min: 1, max: 16 };
		c.roles.explorer.contextCap = 10_000_000;
		c.contextCap = 1;
		c.fallbackRole = "reviewer";
		c.trials = [trial, { ...trial, id: "t2", effort: "high", share: 1, maxSpawns: 1000, endsAt: "2026-11-27T09:00:00.5+09:00", note: 1 }];
		const r = validateConfig(c);
		expect(r.errors).toEqual([]);
		expect(r.config?.trials).toHaveLength(2);
		expect(r.warnings).toEqual(["trials[1].note: 알 수 없는 필드입니다"]);
	});
});

describe("config store", () => {
	test("write → load round-trips with the same hash and creates the storm .gitignore only", async () => {
		const root = await tempRoot();
		const written = await writeConfig(root, base);
		expect(written.path).toBe(configPath(root));
		const loaded = await loadConfig(root);
		expect(loaded.status).toBe("ok");
		if (loaded.status !== "ok") return;
		expect(loaded.hash).toBe(written.hash);
		expect(loaded.hash).toBe(configHash(base));
		expect(loaded.rawSha256).toBe(written.rawSha256);
		expect(loaded.config).toEqual(base);
		expect(await Bun.file(path.join(root, ".omp/storm/.gitignore")).text()).toBe("/state/\n");
		expect(await Bun.file(path.join(root, ".gitignore")).exists()).toBe(false);
		const leftovers = (await fs.readdir(path.join(root, ".omp/storm"))).filter(f => f.endsWith(".tmp"));
		expect(leftovers).toEqual([]);
	});

	test("does not overwrite an existing storm .gitignore", async () => {
		const root = await tempRoot();
		await fs.mkdir(path.join(root, ".omp/storm"), { recursive: true });
		await fs.writeFile(path.join(root, ".omp/storm/.gitignore"), "custom\n");
		await writeConfig(root, base);
		expect(await Bun.file(path.join(root, ".omp/storm/.gitignore")).text()).toBe("custom\n");
	});

	test("serializeConfig output is stable regardless of input key order", () => {
		const { version, ...rest } = clone();
		const text = serializeConfig({ ...rest, version } as StormConfig);
		expect(text).toBe(serializeConfig(base));
		expect(text.endsWith("}\n")).toBe(true);
		expect(text).not.toContain("\r");
		expect(text.split("\n")[1]).toBe('  "budget": {');
	});

	test("reformatting the file keeps the hash; unknown fields change it", async () => {
		const root = await tempRoot();
		const { hash } = await writeConfig(root, base);
		await fs.writeFile(configPath(root), `\uFEFF${JSON.stringify(base, null, "\t")}`);
		const reformatted = await loadConfig(root);
		expect(reformatted.status === "ok" && reformatted.hash).toBe(hash);

		await fs.writeFile(configPath(root), JSON.stringify({ ...base, note: "x" }));
		const extra = await loadConfig(root);
		expect(extra.status).toBe("ok");
		if (extra.status !== "ok") return;
		expect(extra.hash).not.toBe(hash);
		expect(extra.warnings).toEqual(["note: 알 수 없는 필드입니다"]);
	});

	test("missing and invalid files", async () => {
		const root = await tempRoot();
		expect((await loadConfig(root)).status).toBe("missing");

		await fs.mkdir(path.dirname(configPath(root)), { recursive: true });
		await fs.writeFile(configPath(root), '{"version":1,"version":1}');
		const dup = await loadConfig(root);
		expect(dup.status).toBe("invalid");
		if (dup.status === "invalid") {
			expect(dup.errors[0]).toContain("JSON 오류");
			expect(dup.rawSha256).toMatch(/^[0-9a-f]{64}$/);
		}

		await fs.writeFile(configPath(root), JSON.stringify({ ...base, parallelism: 99 }));
		const bad = await loadConfig(root);
		expect(bad.status === "invalid" && bad.errors).toEqual(["parallelism: 1~16 사이 정수여야 합니다"]);

		await fs.writeFile(configPath(root), new Uint8Array([0x7b, 0xff, 0x7d]));
		expect((await loadConfig(root)).status).toBe("invalid");
	});
});

describe("disabledRoles", () => {
	const check = (disabled: unknown) => {
		const c = clone();
		c.disabledRoles = disabled;
		return validateConfig(c);
	};
	test("accepts unique known roles that are not configured and not required", () => {
		const v = check(["quick", "architect"]);
		expect(v.errors).toEqual([]);
		expect(v.warnings).toEqual([]);
		expect(v.config?.disabledRoles).toEqual(["quick", "architect"]);
	});
	test("rejects non-arrays, unknown ids, duplicates, implementer and configured roles", () => {
		expect(check("quick").errors).toEqual(["disabledRoles: 배열이어야 합니다"]);
		expect(check(["ghost"]).errors).toEqual(["disabledRoles[0]: Storm 역할 id여야 합니다"]);
		expect(check([3]).errors).toEqual(["disabledRoles[0]: Storm 역할 id여야 합니다"]);
		expect(check(["quick", "quick"]).errors).toEqual(["disabledRoles[1]: 중복된 역할입니다 (quick)"]);
		expect(check(["implementer"]).errors).toEqual(["disabledRoles[0]: implementer 역할은 끌 수 없습니다"]);
		expect(check(["reviewer"]).errors).toEqual(["disabledRoles[0]: roles에 있는 역할은 끌 수 없습니다 (reviewer)"]);
	});
});
