#!/usr/bin/env bun
/**
 * The evidence for the flat spawn handler: readers and isolated implementers at 16 and 64 on the real pinned host,
 * with the host's thread pool off. It records, per role and size, the `before_subagent_spawn` wall time of the first
 * eight and the last eight calls and the mean of the whole batch. The numbers are evidence, not a gate: the host's
 * event loop and other work on the same machine move a ratio of two small means, so this scenario asserts only that
 * every asked worker was spawned and measured, and writes the numbers for the report.
 *
 * The recorder is `src/e2e-meter.ts` (env `STORM_E2E_METER`), inert unless this scenario switches it on. Both sizes
 * run in one process, each with its own work dir and fake provider; the `task` config keeps `workerThreads: 0` and the
 * host's default `maxConcurrency: 32`.
 *
 * Env: E2E_PORT (this scenario's default 18909 + 2000), E2E_PLUGIN_ROOT (the checkout omp loads; default this one),
 * SPAWN_COST_RESULTS (where the JSON evidence goes), SPAWN_COST_HOLD (the per-child first reply hold, default 2500 ms).
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "../../src/config/schema.ts";
import type { RunRecord } from "../../src/types.ts";
import { prepare, startFakeLlm, Suite, type Rpc, type StormFiles } from "./harness.ts";
import { installProfile, Sessions } from "./phase1-kit.ts";

const SIZES = [16, 64] as const;
const HOLD = Number(process.env.SPAWN_COST_HOLD ?? "2500");
const HOST_MAX = 32;
const RESULTS = process.env.SPAWN_COST_RESULTS ?? "/tmp/storm-spawn-cost/results";
mkdirSync(RESULTS, { recursive: true });

interface Item {
	name: string;
	agent: string;
	task: string;
	isolated?: boolean;
	say: string;
}

const readerItems = (n: number): Item[] =>
	Array.from({ length: n }, (_, index) => ({
		name: `R${index}`,
		agent: "storm-explorer",
		task: `Read the repository and report ${index}`,
		say: `E2E-CHILD-DELAY ${HOLD} E2E-CHILD-CLAIM R${index}-ok`,
	}));

const implementerItems = (n: number): Item[] =>
	Array.from({ length: n }, (_, index) => ({
		name: `I${index}`,
		agent: "storm-implementer",
		task: `Implement lane ${index}`,
		isolated: true,
		say: `E2E-CHILD-DELAY ${HOLD} E2E-CHILD-WRITE lane-${index}.txt E2E-CHILD-CLAIM I${index}-ok`,
	}));

/** One `before_subagent_spawn` call's start time and wall time, from the meter's per-instance hook log. */
interface SpawnHookLine {
	t: number;
	ms: number;
}

function spawnHookLines(root: string, from: number, to: number): SpawnHookLine[] {
	const out: SpawnHookLine[] = [];
	let names: string[];
	try {
		names = readdirSync(root).filter(name => name.startsWith("hooks-") && name.endsWith(".jsonl"));
	} catch {
		return out;
	}
	for (const name of names.sort()) {
		let raw: string;
		try {
			raw = readFileSync(join(root, name), "utf8");
		} catch {
			continue;
		}
		for (const line of raw.split("\n")) {
			if (line === "") continue;
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				continue;
			}
			if (!isRecord(parsed) || parsed.e !== "before_subagent_spawn" || parsed.k !== "main") continue;
			if (typeof parsed.t !== "number" || typeof parsed.ms !== "number") continue;
			if (parsed.t < from || parsed.t > to) continue;
			out.push({ t: parsed.t, ms: parsed.ms });
		}
	}
	return out.sort((left, right) => left.t - right.t);
}

const mean = (values: readonly number[]): number | null =>
	values.length === 0 ? null : Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 100) / 100;

interface BatchCost {
	first8Ms: number | null;
	last8Ms: number | null;
	meanMs: number | null;
	maxMs: number | null;
	ratio: number | null;
	n: number;
	values: number[];
}

const costOf = (values: readonly number[]): BatchCost => {
	const first = mean(values.slice(0, 8));
	const last = mean(values.slice(-8));
	return {
		first8Ms: first,
		last8Ms: last,
		meanMs: mean(values),
		maxMs: values.length === 0 ? null : Math.round(Math.max(...values) * 100) / 100,
		ratio: first === null || last === null || first === 0 ? null : Math.round((last / first) * 100) / 100,
		n: values.length,
		values: values.map(value => Math.round(value * 100) / 100),
	};
};

interface BatchRecord {
	label: string;
	asked: number;
	routed: number;
	blocked: number;
	stopped: number;
	spawnHook: BatchCost;
}

async function batch(meter: string, rpc: Rpc, files: StormFiles, label: string, items: readonly Item[]): Promise<BatchRecord> {
	const before = files.runIds();
	const from = Date.now();
	const steps = [{ tasks: [...items] }, { wait: true }];
	await rpc.turn(`E2E-STEPS ${JSON.stringify(steps)}`, 900_000);
	const to = Date.now();
	const run: RunRecord = await files.finishedRun(before, 300_000);
	// The meter flushes every five ticks and on every slow call; one short settle window is not the measurement.
	await Bun.sleep(250);
	const spawns = run.spawns ?? [];
	const values = spawnHookLines(meter, from, to).map(line => line.ms);
	return {
		label,
		asked: items.length,
		routed: spawns.filter(spawn => spawn.outcome !== "blocked").length,
		blocked: spawns.filter(spawn => spawn.outcome === "blocked").length,
		stopped: spawns.filter(spawn => spawn.stop !== undefined).length,
		spawnHook: costOf(values),
	};
}

const prepared = SIZES.map(size => prepare(`storm-e2e-spawn-cost-${size}`, 18909));
const suite = new Suite(`E2E spawn cost ${new Date().toISOString()}`, prepared[0]);
const evidence: Array<Record<string, unknown>> = [];

for (const [index, size] of SIZES.entries()) {
	// One work dir, profile and provider per size, so the admission store and the registry of one size never colour the
	// other.
	const env = prepared[index];
	const meter = join(RESULTS, "meter", `size${size}`);
	mkdirSync(meter, { recursive: true });
	// The recorder inside the plugin (src/e2e-meter.ts) is inert without this; the scenario is the only thing that sets it.
	env.childEnv.STORM_E2E_METER = meter;
	const config = ["task:", "  isolation:", "    enabled: true", "    apply: false", `  maxConcurrency: ${HOST_MAX}`, "  workerThreads: 0"].join("\n") + "\n";
	installProfile(env, config);
	const server = await startFakeLlm(env);
	const sessions = new Sessions(env);
	const batches: BatchRecord[] = [];
	try {
		await sessions.approve("on");
		await suite.step(`spawn cost ${size}: readers then isolated implementers`, async () => {
			await sessions.open(
				() => undefined,
				async (rpc, files) => {
					batches.push(await batch(meter, rpc, files, "readers", readerItems(size)));
					batches.push(await batch(meter, rpc, files, "implementers", implementerItems(size)));
				},
				[],
			);
		}, 1_500_000);
		suite.check(`size ${size}: every asked worker was spawned and none was stopped`, batches.length === 2 && batches.every(item => item.routed === item.asked && item.blocked === 0 && item.stopped === 0), JSON.stringify(batches.map(item => ({ label: item.label, asked: item.asked, routed: item.routed, blocked: item.blocked, stopped: item.stopped }))));
		suite.check(`size ${size}: the handler was measured for every asked worker`, batches.length === 2 && batches.every(item => item.spawnHook.n === item.asked), JSON.stringify(batches.map(item => ({ label: item.label, n: item.spawnHook.n, asked: item.asked }))));
		suite.check(`size ${size}: the session exited cleanly`, sessions.exitCodes.length > 0 && sessions.exitCodes.every(code => code === 0), `exit=${sessions.exitCodes.join(",")}`);
		for (const item of batches) {
			// Evidence only: the host's event loop and other work on this machine move a ratio of two small means.
			console.log(`spawn-cost ${size} ${item.label}: n=${item.spawnHook.n} first8=${item.spawnHook.first8Ms} last8=${item.spawnHook.last8Ms} ratio=${item.spawnHook.ratio} mean=${item.spawnHook.meanMs} max=${item.spawnHook.maxMs}`);
		}
		evidence.push({ size, holdMs: HOLD, hostMaxConcurrency: HOST_MAX, workerThreads: 0, batches, exitCodes: [...sessions.exitCodes], work: env.work, meter });
		writeFileSync(join(RESULTS, `size${size}.json`), `${JSON.stringify(evidence.at(-1), null, 2)}\n`);
	} finally {
		server.kill();
		await server.exited;
	}
}

writeFileSync(join(RESULTS, "spawn-cost.json"), `${JSON.stringify({ at: new Date().toISOString(), holdMs: HOLD, sizes: SIZES, evidence }, null, 2)}\n`);
console.log(`spawn-cost evidence: ${join(RESULTS, "spawn-cost.json")}`);
process.exit(suite.finish());
