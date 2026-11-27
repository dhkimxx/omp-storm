import { describe, expect, test } from "bun:test";
import { ROLES } from "../src/roles.ts";
import { buildHandoff, DECIDE_BEFORE_STOP, DIRECTOR_EDIT_RULE, routineEditRule } from "../src/runtime/run.ts";
import type { RoleConfig, StormConfig } from "../src/types.ts";
import { teamOf } from "./fixtures.ts";

/** The words of the run contract's rules about the director's own edits and about routine work. */
const base = { runId: "run-20261120-153012-a1b2", hash: `jcs-sha256:${"ab12".repeat(16)}`, task: "T", maxRounds: 4 };
const five: StormConfig = {
	...teamOf({}),
	isolation: "shared",
	roles: Object.fromEntries(ROLES.map((role): [string, RoleConfig] => [role.id, { agent: role.agent, models: [`p/${role.id}`] }])),
};
const rules = (text: string): string[] => {
	const lines = text.split("\n");
	return lines.slice(lines.indexOf("Rules:") + 1, -1);
};
const withRole = (id: string, role: RoleConfig | undefined): StormConfig => {
	const roles = { ...five.roles };
	if (role === undefined) delete roles[id];
	else roles[id] = role;
	return { ...five, roles };
};

describe("run contract: the director's own edits", () => {
	test("the rule that said the director's edits are blocked is replaced by one that says it may edit, once", () => {
		for (const isolation of ["shared", "isolated"] as const) {
			const text = buildHandoff({ ...base, config: { ...five, isolation } });
			expect(rules(text).filter(line => line === DIRECTOR_EDIT_RULE)).toHaveLength(1);
			expect(text).not.toMatch(/edits? (are |is )?blocked|Delegate all changes/iu);
		}
		expect(DIRECTOR_EDIT_RULE).toMatch(/edit\/write/u);
		expect(DIRECTOR_EDIT_RULE.startsWith("- ")).toBe(true);
	});

	test("it holds for a team of two roles and for a resumed run alike", () => {
		expect(rules(buildHandoff({ ...base, config: teamOf({ implementer: "a/i", explorer: "a/e" }) }))).toContain(DIRECTOR_EDIT_RULE);
		expect(rules(buildHandoff({ ...base, config: five, resume: { runId: "run-20261119-090000-0ld0", endReason: "interrupted", turns: 2 } }))).toContain(DIRECTOR_EDIT_RULE);
	});

	test("it makes no promise the table does not keep: no word that edits are always allowed, none about shell or eval being the team's", () => {
		expect(DIRECTOR_EDIT_RULE).not.toMatch(/always|any time|anything/iu);
	});
});

describe("run contract: routine work and the cheaper role", () => {
	test("a team with a usable quick role gets the line, naming that role's agent", () => {
		const text = buildHandoff({ ...base, config: five });
		expect(rules(text).filter(line => line === routineEditRule("storm-quick"))).toHaveLength(1);
		expect(routineEditRule("storm-quick")).toMatch(/routine/iu);
		expect(routineEditRule("storm-quick")).toMatch(/well-specified/iu);
		const renamed = buildHandoff({ ...base, config: withRole("quick", { agent: "my-quick", models: ["p/q"] }) });
		expect(rules(renamed)).toContain(routineEditRule("my-quick"));
		expect(renamed).not.toContain(routineEditRule("storm-quick"));
	});

	test("without a usable quick role there is no such line: absent, disabled, or no model", () => {
		const absent = buildHandoff({ ...base, config: withRole("quick", undefined) });
		const noModel = buildHandoff({ ...base, config: withRole("quick", { agent: "storm-quick", models: [] }) });
		const disabled = buildHandoff({ ...base, config: { ...five, disabledRoles: ["quick"] } });
		for (const text of [absent, noModel, disabled]) {
			expect(text).not.toMatch(/Routine, well-specified/u);
			expect(rules(text).some(line => line.includes("storm-quick") && line.startsWith("- Routine"))).toBe(false);
		}
		expect(buildHandoff({ ...base, config: teamOf({ implementer: "a/i", explorer: "a/e" }) })).not.toMatch(/Routine, well-specified/u);
	});

	test("the line is the only difference a quick role makes to the rules, apart from the plan rule that maps lane kinds to agents", () => {
		const isPlan = (line: string): boolean => line.startsWith("- Before spawning");
		const withQuick = rules(buildHandoff({ ...base, config: five })).filter(line => !isPlan(line));
		const without = rules(buildHandoff({ ...base, config: withRole("quick", undefined) })).filter(line => !isPlan(line));
		expect(withQuick.filter(line => !without.includes(line))).toEqual([routineEditRule("storm-quick")]);
		expect(without.filter(line => !withQuick.includes(line))).toEqual([]);
	});
});

describe("run contract: size", () => {
	test("the five-role contract with a budget and both isolation modes stays within the bound the other contract tests hold", () => {
		for (const isolation of ["shared", "isolated"] as const) {
			const text = buildHandoff({ ...base, config: { ...five, isolation, budget: { perRunUsd: 5, onExceed: "block-spawns" } } });
			expect(text.length, isolation).toBeLessThanOrEqual(1_400);
			expect(text).toContain(DECIDE_BEFORE_STOP);
		}
	});
});
