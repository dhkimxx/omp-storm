import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { writeConfig } from "../src/config/store.ts";
import { approveAndSave } from "../src/flows.ts";
import { createStateCache, isApproved, loadProjectState, type ProjectEnv } from "../src/state.ts";
import { makeProject, TEAM, type TestProject } from "./support.ts";

const T0 = Date.parse("2026-11-20T09:00:00Z");

let project: TestProject;
/** The project's env, counting the git calls a state load makes (one each). */
let env: ProjectEnv;
let loads: number;

beforeEach(async () => {
	project = await makeProject();
	loads = 0;
	env = {
		...project.env,
		exec: (command, args, options) => {
			loads++;
			return project.env.exec(command, args, options);
		},
	};
	setSystemTime(new Date(T0));
});

afterEach(async () => {
	setSystemTime();
	await project.remove();
});

describe("the spawn hook's state cache", () => {
	test("a batch of spawns shares one load", async () => {
		const cache = createStateCache();
		const [a, b, c] = await Promise.all([cache.get(env), cache.get(env), cache.get(env)]);
		expect(loads).toBe(1);
		expect(b).toBe(a);
		expect(c).toBe(a);
	});

	test("an approval, a hand edit or a withdrawn approval is seen 2 s after the cached read, not before", async () => {
		const cache = createStateCache();
		expect((await cache.get(env)).config.status).toBe("missing");
		await approveAndSave(await loadProjectState(project.env), TEAM, { shadowedAgents: [] });

		setSystemTime(new Date(T0 + 1_999));
		expect((await cache.get(env)).config.status).toBe("missing");
		expect(loads).toBe(1);
		setSystemTime(new Date(T0 + 2_000));
		expect(isApproved(await cache.get(env))).toBe(true);
		expect(loads).toBe(2);

		// A teammate's edit lands: the old approval answers for at most the same 2 s.
		await writeConfig(project.root, { ...TEAM, parallelism: 9 });
		setSystemTime(new Date(T0 + 3_999));
		expect(isApproved(await cache.get(env))).toBe(true);
		setSystemTime(new Date(T0 + 4_000));
		const edited = await cache.get(env);
		expect(edited.approval).toBeUndefined();
		expect(isApproved(edited)).toBe(false);
		expect(loads).toBe(3);
	});

	test("clear drops what is cached at once: the next read is fresh", async () => {
		const cache = createStateCache();
		await cache.get(env);
		await approveAndSave(await loadProjectState(project.env), TEAM, { shadowedAgents: [] });
		cache.clear();
		expect(isApproved(await cache.get(env))).toBe(true);
		expect(loads).toBe(2);
	});

	test("each working directory has its own entry, and the lifetime is the one given", async () => {
		const other = await makeProject();
		try {
			const cache = createStateCache(500);
			const mine = await cache.get(env);
			const theirs = await cache.get({ ...env, cwd: other.root });
			expect(theirs.repo.root).not.toBe(mine.repo.root);
			expect(loads).toBe(2);
			setSystemTime(new Date(T0 + 499));
			await cache.get(env);
			expect(loads).toBe(2);
			setSystemTime(new Date(T0 + 500));
			await cache.get(env);
			expect(loads).toBe(3);
		} finally {
			await other.remove();
		}
	});

	test("a load that fails is not kept: the next read tries again", async () => {
		const cache = createStateCache();
		let broken = true;
		const flaky: ProjectEnv = {
			...env,
			get agentDir(): string {
				if (broken) throw new Error("agent dir unavailable");
				return project.env.agentDir;
			},
		};
		await expect(cache.get(flaky)).rejects.toThrow("agent dir unavailable");
		broken = false;
		expect((await cache.get(flaky)).config.status).toBe("missing");
	});
});
