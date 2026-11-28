import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ApprovalStore } from "../src/approval/store.ts";
import { canonicalJson, configHash, escapeUnsafe, parseStrictJson } from "../src/config/canonical.ts";
import { approvedRecordBytes, MAX_APPROVED_BYTES, MAX_JOB_TIMEOUT_MS, teamPriority, unknownFields, validateConfig } from "../src/config/schema.ts";
import { configPath, loadConfig, serializeConfig, writeConfig } from "../src/config/store.ts";
import type { StormConfig, TrialConfig } from "../src/types.ts";
import { teamOf } from "./fixtures.ts";
import { TEAM_08, TEAM_08_HASH } from "./team-08.ts";

const base: StormConfig = teamOf(
	{
		reviewer: { models: ["openai/gpt-5.2", "anthropic/claude-sonnet-4-5:high"], effort: "high" },
		explorer: "openrouter/deepseek/deepseek-v4",
		implementer: "openai/gpt-5.2:medium",
	},
	{ isolation: "isolated", budget: { perRunUsd: 2.5, warnAtUsd: 2, onExceed: "block-spawns" } },
);

/** The field path of each validation message ("roles.reviewer.agent"), which is what the tests pin. */
function paths(messages: string[]): string[] {
	return messages.map(m => m.slice(0, m.indexOf(":")));
}

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
		v.budget.note = true;
		const r = validateConfig(v);
		expect(r.errors).toEqual([]);
		expect(r.config).toBeDefined();
		expect(paths(r.warnings)).toEqual(["extra", "roles.reviewer.fallback", "budget.note"]);
		expect(unknownFields(v)).toEqual([
			{ path: "extra", value: 1 },
			{ path: "roles.reviewer.fallback", value: "x" },
			{ path: "budget.note", value: true },
		]);
	});

	test("the 0.8 team validates, warns only about the retired parallelism key, and keeps its hash", () => {
		const r = validateConfig(parsed(TEAM_08));
		expect(r.errors).toEqual([]);
		// `parallelism` is no longer a known field, so it follows the ordinary unknown-key policy: warned and hashed.
		expect(paths(r.warnings)).toEqual(["parallelism"]);
		expect(Object.keys(r.config?.roles ?? {})).toHaveLength(5);
		// The retired team cap is accepted and ignored, not stripped: it stays in the value the hash covers.
		expect((r.config as unknown as Record<string, unknown>).contextCap).toBe(200_000);
		// The hash covers the file's own content, deprecated fields included: an approval given by 0.8 still matches it.
		expect(configHash(parsed(TEAM_08))).toBe(TEAM_08_HASH);
		const { contract: _contract, ...withoutContract } = JSON.parse(TEAM_08);
		expect(configHash(withoutContract)).not.toBe(TEAM_08_HASH);
	});

	test("the retired parallelism key is an ordinary unknown field: no validation, warned and hashed", () => {
		for (const value of [99, 0, 1.5, "many", null]) {
			const c = clone();
			c.parallelism = value;
			const r = validateConfig(c);
			expect(r.errors).toEqual([]);
			expect(paths(r.warnings)).toEqual(["parallelism"]);
			expect(unknownFields(c)).toContainEqual({ path: "parallelism", value });
			expect(configHash(c)).not.toBe(configHash(base));
		}
	});

	test("rounds is a known field: an integer 0~10, and absent stays absent", () => {
		for (const rounds of [0, 3, 10]) {
			const c = clone();
			c.rounds = rounds;
			const r = validateConfig(c);
			expect(r.errors).toEqual([]);
			expect(r.warnings).toEqual([]);
			expect(r.config?.rounds).toBe(rounds);
		}
		for (const rounds of [-1, 11, 2.5, "3", null]) {
			const c = clone();
			c.rounds = rounds;
			expect(paths(validateConfig(c).errors)).toEqual(["rounds"]);
		}
		const absent = validateConfig(clone());
		expect(absent.config).not.toHaveProperty("rounds");
		expect(configHash(absent.config!)).toBe(configHash(base));
		const set = clone();
		set.rounds = 5;
		expect(configHash(set)).not.toBe(configHash(base));
	});

	test("deprecated fields are accepted silently: contract, runtime, old priorities, numeric workers", () => {
		for (const mutate of [
			(c: Record<string, any>) => (c.contract = "orchestrate"),
			(c: Record<string, any>) => (c.contract = "anything"),
			(c: Record<string, any>) => (c.runtime = "omp"),
			(c: Record<string, any>) => (c.priority = "speed"),
			(c: Record<string, any>) => (c.priority = "quota"),
			(c: Record<string, any>) => (c.roles.reviewer.workers = 3),
		]) {
			const c = clone();
			mutate(c);
			const r = validateConfig(c);
			expect(r.errors).toEqual([]);
			expect(r.warnings).toEqual([]);
		}
	});

	test("contextCap is retired: any value is accepted and stays in the hashed value", () => {
		for (const cap of [200_000, 0, -1, 1.5, 10_000_001, "large", null]) {
			const c = clone();
			c.contextCap = cap;
			c.roles.reviewer.contextCap = cap;
			const r = validateConfig(c);
			expect(r.errors).toEqual([]);
			expect(r.warnings).toEqual([]);
			const kept = r.config as unknown as Record<string, any>;
			expect(kept.contextCap).toEqual(cap);
			expect(kept.roles.reviewer.contextCap).toEqual(cap);
			// serializeConfig is what an approval snapshot stores; the key is not stripped from it.
			expect(configHash(parsed(serializeConfig(r.config!)))).toBe(configHash(c));
			expect(unknownFields(c)).toEqual([]);
		}
	});

	test("old priorities are read as balanced", () => {
		expect(teamPriority({ ...base, priority: "speed" })).toBe("balanced");
		expect(teamPriority({ ...base, priority: "quota" })).toBe("balanced");
		expect(teamPriority({ ...base, priority: "cost" })).toBe("cost");
	});

	const cases: Array<[string, (c: Record<string, any>) => void, string]> = [
		["version", c => (c.version = 2), "version:"],
		["priority", c => (c.priority = "fast"), "priority:"],
		["empty roles", c => (c.roles = {}), "roles:"],
		["roles array", c => (c.roles = []), "roles:"],
		["agent prefix", c => (c.roles.reviewer.agent = "reviewer"), "roles.reviewer.agent:"],
		["agent case", c => (c.roles.reviewer.agent = "storm-Reviewer"), "roles.reviewer.agent:"],
		["agent of another role", c => (c.roles.reviewer.agent = "storm-explorer"), "roles.reviewer.agent:"],
		["unknown role key", c => (c.roles.ghost = { agent: "storm-ghost", models: ["a/b"] }), "roles.ghost:"],
		["no implementer", c => delete c.roles.implementer, "roles.implementer:"],
		["empty models", c => (c.roles.reviewer.models = []), "roles.reviewer.models:"],
		["model no slash", c => (c.roles.reviewer.models = ["gpt-5"]), "roles.reviewer.models[0]:"],
		["model whitespace", c => (c.roles.explorer.models = ["a/b", "a/ b"]), "roles.explorer.models[1]:"],
		["model empty id", c => (c.roles.explorer.models = ["a/"]), "roles.explorer.models[0]:"],
		["model non-string", c => (c.roles.explorer.models = [1]), "roles.explorer.models[0]:"],
		["model bytes over the record budget", c => (c.roles.explorer.models = Array.from({ length: 4096 }, (_, index) => `a/${"m".repeat(1050)}-${index}`)), "roles.explorer.models:"],
		["effort", c => (c.roles.reviewer.effort = "huge"), "roles.reviewer.effort:"],
		["isolation", c => (c.isolation = "none"), "isolation:"],
		["runtime", c => (c.runtime = "orca"), "runtime:"],
		["contract object", c => (c.contract = { toString: 1 }), "contract:"],
		["contract number", c => (c.contract = 3), "contract:"],
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
		["fallbackRole unknown", c => (c.fallbackRole = "architect"), "fallbackRole:"],
		["fallbackRole non-string", c => (c.fallbackRole = 1), "fallbackRole:"],
		["fallbackRole prototype key", c => (c.fallbackRole = "toString"), "fallbackRole:"],
		["trials object", c => (c.trials = {}), "trials:"],
		["trial item", c => (c.trials = [1]), "trials[0]:"],
		["trial empty id", c => withTrial(c, { id: " " }), "trials[0].id:"],
		["trial duplicate id", c => (c.trials = [trial, { ...trial }]), "trials[1].id:"],
		["trial role", c => withTrial(c, { role: "architect" }), "trials[0].role:"],
		["trial model", c => withTrial(c, { model: "gpt-6" }), "trials[0].model:"],
		["trial effort", c => withTrial(c, { effort: "huge" }), "trials[0].effort:"],
		["trial share zero", c => withTrial(c, { share: 0 }), "trials[0].share:"],
		["trial share above one", c => withTrial(c, { share: 1.2 }), "trials[0].share:"],
		["trial maxSpawns zero", c => withTrial(c, { maxSpawns: 0 }), "trials[0].maxSpawns:"],
		["trial maxSpawns 1001", c => withTrial(c, { maxSpawns: 1001 }), "trials[0].maxSpawns:"],
		["trial maxSpawns fraction", c => withTrial(c, { maxSpawns: 2.5 }), "trials[0].maxSpawns:"],
		["trial startsAt garbage", c => withTrial(c, { startsAt: "tomorrow" }), "trials[0].startsAt:"],
		["trial startsAt without zone", c => withTrial(c, { startsAt: "2026-11-20T00:00:00" }), "trials[0].startsAt:"],
		["trial endsAt invalid date", c => withTrial(c, { endsAt: "2026-13-45T00:00:00Z" }), "trials[0].endsAt:"],
		["trial endsAt not after", c => withTrial(c, { endsAt: trial.startsAt }), "trials[0].endsAt:"],
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

	test("RF4-9: a role is bounded by the bytes its approval stores, not by a count of models", () => {
		const many = clone();
		many.roles.explorer!.models = Array.from({ length: 4097 }, (_, index) => `a/m${index}`);
		expect(validateConfig(many).config).toBeDefined();
		const wide = clone();
		wide.roles.explorer!.models = Array.from({ length: 4096 }, (_, index) => `a/${"m".repeat(1050)}-${index}`);
		const rejected = validateConfig(wide);
		expect(rejected.config).toBeUndefined();
		expect(rejected.errors.some(error => error.includes(`${MAX_APPROVED_BYTES}바이트`))).toBe(true);
	});

	test("RF6o case 6: the approval bound is measured in the record's own pretty encoding", () => {
		const c = clone();
		const models = Array.from({ length: 40_000 }, (_, index) => `a/${"m".repeat(30)}-${index}`);
		c.roles.explorer!.models = models;
		c.roles.explorer!.effort = "low";
		const entries = models.map(selector => ({ selector, effort: "low" }));
		// The compact list fits the old bound; the record's own encoding does not.
		expect(Buffer.byteLength(JSON.stringify(entries))).toBeLessThan(MAX_APPROVED_BYTES);
		expect(approvedRecordBytes(entries)).toBeGreaterThan(MAX_APPROVED_BYTES);
		const rejected = validateConfig(c);
		expect(rejected.config).toBeUndefined();
		expect(rejected.errors.some(error => error.includes(`${MAX_APPROVED_BYTES}바이트`))).toBe(true);
	});

	test("requiredChecks is a known ordered field; absent keeps the hash, present joins it", () => {
		const absent = validateConfig(clone());
		expect(absent.config).not.toHaveProperty("requiredChecks");
		expect(configHash(absent.config!)).toBe(configHash(base));

		const c = clone();
		c.requiredChecks = [
			{ name: "unit", argv: ["bun", "test"] },
			{ name: "types", argv: ["bunx", "tsc", "--noEmit"] },
		];
		const r = validateConfig(c);
		expect(r.errors).toEqual([]);
		expect(r.warnings).toEqual([]);
		expect(r.config?.requiredChecks).toEqual(c.requiredChecks);
		expect(configHash(r.config!)).not.toBe(configHash(base));
		expect(c.requiredChecks.map((check: { name: string }) => check.name)).toEqual(["unit", "types"]);

		// An empty list is a chosen (hash-covered) no-op, not an error.
		const empty = validateConfig({ ...clone(), requiredChecks: [] });
		expect(empty.errors).toEqual([]);
		expect(configHash(empty.config!)).not.toBe(configHash(base));
	});

	test("requiredChecks is bounded and unique", () => {
		const c = (requiredChecks: unknown) => ({ ...clone(), requiredChecks });
		const errorsOf = (requiredChecks: unknown) => validateConfig(c(requiredChecks)).errors;

		expect(paths(errorsOf({}))).toEqual(["requiredChecks"]);
		expect(paths(errorsOf([1]))).toEqual(["requiredChecks[0]"]);
		expect(paths(errorsOf([{ name: "", argv: ["x"] }]))).toEqual(["requiredChecks[0].name"]);
		expect(paths(errorsOf([{ name: " ", argv: ["x"] }]))).toEqual(["requiredChecks[0].name"]);
		expect(paths(errorsOf([{ name: " x", argv: ["x"] }]))).toEqual(["requiredChecks[0].name"]);
		expect(paths(errorsOf([{ name: "x".repeat(81), argv: ["x"] }]))).toEqual(["requiredChecks[0].name"]);
		expect(paths(errorsOf([{ name: "ok" }]))).toEqual(["requiredChecks[0].argv"]);
		expect(paths(errorsOf([{ name: "ok", argv: [] }]))).toEqual(["requiredChecks[0].argv"]);
		expect(paths(errorsOf([{ name: "ok", argv: [1] }]))).toEqual(["requiredChecks[0].argv[0]"]);
		expect(paths(errorsOf([{ name: "ok", argv: [""] }]))).toEqual(["requiredChecks[0].argv[0]"]);
		expect(paths(errorsOf([{ name: "ok", argv: [" "] }]))).toEqual(["requiredChecks[0].argv[0]"]);
		expect(paths(errorsOf([{ name: "ok", argv: ["x".repeat(1025)] }]))).toEqual(["requiredChecks[0].argv[0]"]);
		expect(paths(errorsOf([{ name: "ok", argv: Array.from({ length: 33 }, (_, i) => `a${i}`) }]))).toEqual(["requiredChecks[0].argv"]);
		expect(paths(errorsOf([{ name: "ok", argv: Array.from({ length: 5 }, () => "x".repeat(1020)) }]))).toEqual(["requiredChecks[0].argv"]);

		expect(paths(errorsOf([{ name: "a", argv: ["x"] }, { name: "a", argv: ["y"] }]))).toEqual(["requiredChecks[1].name"]);
		expect(paths(errorsOf([{ name: "a", argv: ["x"] }, { name: "b", argv: ["x"] }]))).toEqual(["requiredChecks[1].argv"]);
		expect(paths(errorsOf(Array.from({ length: 9 }, (_, i) => ({ name: `c${i}`, argv: [`v${i}`] }))))).toEqual(["requiredChecks"]);

		const valid = validateConfig(
			c([
				{ name: "unit", argv: ["bun", "test", "--", "some test"] },
				{ name: "lint", argv: ["bunx", "eslint", "."], note: true },
			]),
		);
		expect(valid.errors).toEqual([]);
		expect(paths(valid.warnings)).toEqual(["requiredChecks[1].note"]);
		expect(unknownFields(c([{ name: "unit", argv: ["bun"], extra: 1 }]))).toEqual([
			{ path: "requiredChecks[0].extra", value: 1 },
		]);
	});

	test("requiredChecks may set their own time limit, bounded like a job's", () => {
		const c = (requiredChecks: unknown) => ({ ...clone(), requiredChecks });
		const of = (timeoutMs: unknown) => validateConfig(c([{ name: "long", argv: ["bun", "test"], timeoutMs }]));

		const long = of(1_800_000);
		expect(long.errors).toEqual([]);
		expect(long.warnings).toEqual([]);
		expect(long.config?.requiredChecks?.[0]?.timeoutMs).toBe(1_800_000);
		expect(of(MAX_JOB_TIMEOUT_MS).errors).toEqual([]);
		// The key is known now, so it is not an unknown-field warning; it is still part of the hash.
		expect(unknownFields(c([{ name: "long", argv: ["bun", "test"], timeoutMs: 1_800_000 }]))).toEqual([]);

		for (const bad of [0, -1, 1.5, MAX_JOB_TIMEOUT_MS + 1, "60000", null]) {
			expect(paths(of(bad).errors)).toEqual(["requiredChecks[0].timeoutMs"]);
		}

		// A config stored before the field existed is unchanged by the new option: absent stays absent in the hash.
		const old = validateConfig(c([{ name: "unit", argv: ["bun", "test"] }]));
		expect(old.errors).toEqual([]);
		expect(old.config?.requiredChecks?.[0]).not.toHaveProperty("timeoutMs");
		expect(configHash(old.config!)).toBe(configHash(c([{ name: "unit", argv: ["bun", "test"] }])));
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
		expect(paths(r.warnings)).toEqual(["trials[1].note"]);
	});
});

/** The session store this test profile would derive for one native session. */
const sessionOf = (root: string) => path.join(root, "profile", "storm", "sessions", "a".repeat(64));

describe("config store", () => {
	test("write → load round-trips with the same hash and writes only this session's config.json", async () => {
		const root = await tempRoot();
		const session = sessionOf(root);
		const written = await writeConfig(session, base);
		expect(written.path).toBe(configPath(session));
		const loaded = await loadConfig(session);
		expect(loaded.status).toBe("ok");
		if (loaded.status !== "ok") return;
		expect(loaded.hash).toBe(written.hash);
		expect(loaded.hash).toBe(configHash(base));
		expect(loaded.config).toEqual(base);
		expect(await fs.readdir(session)).toEqual(["config.json"]);
		// Nothing in the target: no .omp/storm, no .gitignore, no config.
		expect(await fs.readdir(root)).toEqual(["profile"]);
		const leftovers = (await fs.readdir(session)).filter(f => f.endsWith(".tmp"));
		expect(leftovers).toEqual([]);
	});

	test("requiredChecks round-trips in order with the same hash, ready for snapshots and rollback", async () => {
		const session = sessionOf(await tempRoot());
		const config: StormConfig = {
			...base,
			requiredChecks: [
				{ name: "unit", argv: ["bun", "test", "--", "some test"] },
				{ name: "types", argv: ["bunx", "tsc", "--noEmit"] },
			],
		};
		const written = await writeConfig(session, config);
		expect(written.hash).toBe(configHash(config));
		const loaded = await loadConfig(session);
		expect(loaded.status).toBe("ok");
		if (loaded.status !== "ok") return;
		expect(loaded.hash).toBe(written.hash);
		expect(loaded.config.requiredChecks).toEqual(config.requiredChecks);
		expect(serializeConfig(loaded.config)).toBe(serializeConfig(config));
	});

	test("the 0.8 team with its retired contextCap loads approved under its recorded hash", async () => {
		const root = await tempRoot();
		const session = sessionOf(root);
		await fs.mkdir(session, { recursive: true });
		await fs.writeFile(configPath(session), TEAM_08);
		const loaded = await loadConfig(session);
		expect(loaded.status).toBe("ok");
		if (loaded.status !== "ok") return;
		expect(loaded.hash).toBe(TEAM_08_HASH);
		expect(paths(loaded.warnings)).toEqual(["parallelism"]);
		const store = new ApprovalStore(session, { repoId: "dir-legacy", kind: "dir", root: path.join(root, "target") });
		await store.approve({ configHash: loaded.hash, config: loaded.config, scope: { shadowedAgents: [] } });
		expect((await store.active(TEAM_08_HASH))?.status).toBe("active");
		// The snapshot keeps the retired key, so rollback and the approval diff see what was approved.
		const snapshot = await store.snapshot(TEAM_08_HASH);
		expect(snapshot).toMatchObject({ contextCap: 200_000 });
		expect(configHash(snapshot)).toBe(TEAM_08_HASH);
	});

	test("an absurd contextCap still loads with the hash of its exact bytes", async () => {
		for (const cap of [0, 1.5, 10_000_001]) {
			const session = sessionOf(await tempRoot());
			const text = JSON.stringify({ ...base, contextCap: cap });
			await fs.mkdir(session, { recursive: true });
			await fs.writeFile(configPath(session), text);
			const loaded = await loadConfig(session);
			expect(loaded.status).toBe("ok");
			if (loaded.status !== "ok") continue;
			expect(loaded.hash).toBe(configHash(parsed(text)));
			expect((loaded.config as unknown as Record<string, unknown>).contextCap).toBe(cap);
		}
	});

	test("never writes into the target and leaves an old .omp/storm byte-untouched", async () => {
		const root = await tempRoot();
		const old = path.join(root, ".omp", "storm");
		await fs.mkdir(old, { recursive: true });
		const legacyConfig = path.join(old, "config.json");
		const legacyIgnore = path.join(old, ".gitignore");
		await fs.writeFile(legacyConfig, '{"legacy":true}\n');
		await fs.writeFile(legacyIgnore, "custom\n");
		await writeConfig(sessionOf(root), base);
		expect(await Bun.file(legacyConfig).text()).toBe('{"legacy":true}\n');
		expect(await Bun.file(legacyIgnore).text()).toBe("custom\n");
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
		const session = sessionOf(await tempRoot());
		const { hash } = await writeConfig(session, base);
		await fs.writeFile(configPath(session), `\uFEFF${JSON.stringify(base, null, "\t")}`);
		const reformatted = await loadConfig(session);
		expect(reformatted.status === "ok" && reformatted.hash).toBe(hash);

		await fs.writeFile(configPath(session), JSON.stringify({ ...base, note: "x" }));
		const extra = await loadConfig(session);
		expect(extra.status).toBe("ok");
		if (extra.status !== "ok") return;
		expect(extra.hash).not.toBe(hash);
		expect(paths(extra.warnings)).toEqual(["note"]);
	});

	test("missing and invalid files", async () => {
		const session = sessionOf(await tempRoot());
		expect((await loadConfig(session)).status).toBe("missing");

		await fs.mkdir(path.dirname(configPath(session)), { recursive: true });
		await fs.writeFile(configPath(session), '{"version":1,"version":1}');
		const dup = await loadConfig(session);
		expect(dup.status).toBe("invalid");
		if (dup.status === "invalid") {
			expect(dup.errors).toHaveLength(1);
			expect(dup.rawSha256).toMatch(/^[0-9a-f]{64}$/);
		}

		await fs.writeFile(configPath(session), JSON.stringify({ ...base, rounds: 99 }));
		const bad = await loadConfig(session);
		expect(bad.status === "invalid" && paths(bad.errors)).toEqual(["rounds"]);

		await fs.writeFile(configPath(session), new Uint8Array([0x7b, 0xff, 0x7d]));
		expect((await loadConfig(session)).status).toBe("invalid");
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
		expect(paths(check("quick").errors)).toEqual(["disabledRoles"]);
		expect(paths(check(["ghost"]).errors)).toEqual(["disabledRoles[0]"]);
		expect(paths(check([3]).errors)).toEqual(["disabledRoles[0]"]);
		expect(paths(check(["quick", "quick"]).errors)).toEqual(["disabledRoles[1]"]);
		expect(paths(check(["implementer"]).errors)).toEqual(["disabledRoles[0]"]);
		expect(paths(check(["reviewer"]).errors)).toEqual(["disabledRoles[0]"]);
	});
});

describe("text that could forge or hide rows in the approval dialog", () => {
	// ESC, newline, DEL, a C1 control, zero-width space, right-to-left override, an isolate, BOM, line separator.
	const HOSTILE = ["\u001b[2K", "a\nb", "\u007f", "\u009b", "\u200b", "\u202e", "\u2066", "\ufeff", "\u2028"];
	const fields: Array<[string, (c: Record<string, any>, bad: string) => void, string]> = [
		["model entry", (c, bad) => (c.roles.reviewer.models = [`openai/gpt${bad}`]), "roles.reviewer.models[0]"],
		["role agent", (c, bad) => (c.roles.reviewer.agent = `storm-reviewer${bad}`), "roles.reviewer.agent"],
		["role effort", (c, bad) => (c.roles.reviewer.effort = `high${bad}`), "roles.reviewer.effort"],
		["priority", (c, bad) => (c.priority = `balanced${bad}`), "priority"],
		["isolation", (c, bad) => (c.isolation = `shared${bad}`), "isolation"],
		["contract", (c, bad) => (c.contract = `workflowz${bad}`), "contract"],
		["fallbackRole", (c, bad) => (c.fallbackRole = `reviewer${bad}`), "fallbackRole"],
		["disabled role", (c, bad) => (c.disabledRoles = [`quick${bad}`]), "disabledRoles[0]"],
		["budget action", (c, bad) => (c.budget.onExceed = `stop${bad}`), "budget.onExceed"],
		["trial id", (c, bad) => withTrial(c, { id: `t${bad}` }), "trials[0].id"],
		["trial model", (c, bad) => withTrial(c, { model: `openai/gpt${bad}` }), "trials[0].model"],
		["trial role", (c, bad) => withTrial(c, { role: `reviewer${bad}` }), "trials[0].role"],
		["check name", (c, bad) => (c.requiredChecks = [{ name: `x${bad}`, argv: ["x"] }]), "requiredChecks[0].name"],
		["check argument", (c, bad) => (c.requiredChecks = [{ name: "x", argv: ["x", bad] }]), "requiredChecks[0].argv[1]"],
		["unknown field value", (c, bad) => (c.note = `x${bad}`), "note"],
		["unknown nested value", (c, bad) => (c.extra = { list: [1, { deep: `x${bad}` }] }), "extra.list[1].deep"],
		["unknown role field value", (c, bad) => (c.roles.reviewer.note = bad), "roles.reviewer.note"],
	];
	/** No message may carry a raw unsafe character: the invalid-config dialog prints them. */
	const clean = (messages: string[]) => messages.every(m => escapeUnsafe(m) === m);

	for (const [name, mutate, at] of fields) {
		test(`rejects a hostile ${name}`, () => {
			for (const bad of HOSTILE) {
				const c = clone();
				mutate(c, bad);
				const r = validateConfig(c);
				expect(r.config).toBeUndefined();
				expect(paths(r.errors)).toContain(at);
				expect(clean([...r.errors, ...r.warnings])).toBe(true);
			}
		});
	}

	test("rejects hostile keys (a role id, an unknown field name) and reports them escaped", () => {
		for (const bad of HOSTILE) {
			for (const mutate of [
				(c: Record<string, any>) => (c.roles[`reviewer${bad}`] = c.roles.reviewer),
				(c: Record<string, any>) => (c[`note${bad}`] = 1),
				(c: Record<string, any>) => (c.roles.reviewer[`x${bad}`] = 1),
				(c: Record<string, any>) => (c.budget[`x${bad}`] = 1),
				(c: Record<string, any>) => withTrial(c, { [`x${bad}`]: 1 }),
			]) {
				const c = clone();
				mutate(c);
				const r = validateConfig(c);
				expect(r.config).toBeUndefined();
				expect(clean([...r.errors, ...r.warnings])).toBe(true);
				expect(clean(unknownFields(c).map(f => f.path))).toBe(true);
			}
		}
	});

	test("a key that is not a plain name is quoted in paths; ordinary text, Korean included, stays valid", () => {
		const c = clone();
		c["a, 병렬도: 1"] = true;
		c.contract = "실행 계약 v2 — workflowz";
		const r = validateConfig(c);
		expect(r.errors).toEqual([]);
		expect(unknownFields(c)).toEqual([{ path: '["a, 병렬도: 1"]', value: true }]);
		expect(escapeUnsafe("가나다 abc — ✓ 🌀")).toBe("가나다 abc — ✓ 🌀");
		expect(escapeUnsafe("a\u202eb\u001b")).toBe("a\\u{202e}b\\u{1b}");
	});

	test("a config file with escaped controls loads as invalid, and JSON errors quote the file escaped", async () => {
		const session = sessionOf(await tempRoot());
		await fs.mkdir(path.dirname(configPath(session)), { recursive: true });
		// Valid JSON whose strings decode to ESC and a right-to-left override.
		await fs.writeFile(configPath(session), JSON.stringify({ ...base, contract: "x" }).replace('"x"', '"\\u001b[2Kok\\u202e"'));
		const hostile = await loadConfig(session);
		expect(hostile.status).toBe("invalid");
		expect(hostile.status === "invalid" && paths(hostile.errors)).toEqual(["contract"]);

		for (const text of ['{"a\u202e":1,"a\u202e":2}', "{\u202e}"]) {
			await fs.writeFile(configPath(session), text);
			const broken = await loadConfig(session);
			expect(broken.status).toBe("invalid");
			expect(broken.status === "invalid" && clean(broken.errors)).toBe(true);
		}
	});
});
