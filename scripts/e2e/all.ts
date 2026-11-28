#!/usr/bin/env bun
/**
 * Every end-to-end scenario, side by side: `npm run e2e:all [jobs]`, four at a time by default.
 *
 * Each suite is its own process with its own work folder under the system temp folder (`E2E_WORK_ROOT` overrides the
 * root; the CI jobs set it to the runner's temp so failures still upload), its own port (each script's default) and the
 * environment `scripts/e2e/suites.ts` names. A suite that fails beside others is rerun alone once before it counts.
 * The table at the end gives every result and time; the exit code is non-zero if any suite still failed.
 *
 * Usage:
 *   npm run e2e:all                # every suite, 4 at a time
 *   npm run e2e:all -- 8           # 8 at a time
 *   npm run e2e:all -- --group e2e # one CI job's group (also: e2e-guarantees, e2e-tui, qa)
 *   npm run e2e:all -- --only tui --jobs 1
 *   npm run e2e:all -- --port-offset 40  # a second checkout beside this one, with its own ports
 */
import { closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { E2E_GROUPS, E2E_SUITES, type E2eGroup, type E2eSuite } from "./suites.ts";

const ROOT = resolve(import.meta.dir, "../..");

interface RunResult {
	suite: E2eSuite;
	code: number;
	seconds: number;
	log: string;
	/** A pass on the rerun alone after failing beside others. */
	recovered?: boolean;
}

interface Options {
	jobs: number;
	groups: readonly E2eGroup[];
	only: readonly string[];
	rerun: boolean;
	list: boolean;
	/** Added to every suite's port, so two checkouts can run their suites at the same time. */
	portOffset: number;
}

function usage(problem: string): never {
	console.error(`e2e:all: ${problem}`);
	console.error("usage: bun scripts/e2e/all.ts [jobs] [--jobs N] [--group NAME]... [--only NAME]... [--no-rerun] [--list]");
	process.exit(2);
}

function parseArgs(argv: readonly string[]): Options {
	let jobs = 4;
	const groups: E2eGroup[] = [];
	const only: string[] = [];
	let rerun = true;
	let list = false;
	let portOffset = 0;
	for (let at = 0; at < argv.length; at++) {
		const arg = argv[at];
		if (arg === undefined) continue;
		if (arg === "--list") list = true;
		else if (arg === "--no-rerun") rerun = false;
		else if (arg === "--port-offset") {
			const value = argv[++at];
			if (value === undefined || !/^\d+$/.test(value)) usage(`--port-offset needs a non-negative number, got ${value ?? "nothing"}`);
			portOffset = Number(value);
		} else if (arg === "--jobs" || arg === "-j") {
			const value = argv[++at];
			if (value === undefined || !/^\d+$/.test(value)) usage(`--jobs needs a number, got ${value ?? "nothing"}`);
			jobs = Number(value);
		} else if (arg === "--group" || arg === "-g") {
			const value = argv[++at];
			if (value === undefined) usage("--group needs a name");
			if (value === "all") continue;
			if (!E2E_GROUPS.includes(value as E2eGroup)) usage(`unknown group ${value}`);
			groups.push(value as E2eGroup);
		} else if (arg === "--only") {
			const value = argv[++at];
			if (value === undefined) usage("--only needs a suite name");
			only.push(value);
		} else if (/^\d+$/.test(arg)) jobs = Number(arg);
		else usage(`unknown argument ${arg}`);
	}
	if (jobs < 1) usage("jobs must be at least 1");
	if (portOffset > 60_000) usage("port-offset must stay below 60000");
	return { jobs, groups: groups.length === 0 ? E2E_GROUPS : groups, only, rerun, list, portOffset };
}

function selected(options: Options): readonly E2eSuite[] {
	const byGroup = E2E_SUITES.filter(suite => options.groups.includes(suite.group));
	if (options.only.length === 0) return byGroup;
	for (const name of options.only) {
		if (!E2E_SUITES.some(suite => suite.name === name)) usage(`unknown suite ${name}`);
	}
	return byGroup.filter(suite => options.only.includes(suite.name));
}

/** Every work folder this run created (a rerun alone adds its own); the cleanup touches only these. */
const workDirs = new Set<string>();
/** Added to every suite's port; set from `--port-offset` before any suite starts. */
let portOffset = 0;

function runSuite(suite: E2eSuite, workRoot: string, suffix: string): Promise<RunResult> {
	// A nonzero offset is a second checkout on the same machine: its work folder and log must not be the first's.
	const tag = portOffset > 0 ? `-p${portOffset}` : "";
	const work = join(workRoot, `storm-e2e-${suite.name}${suffix}${tag}`);
	workDirs.add(work);
	const logDir = join(workRoot, "storm-e2e-logs");
	mkdirSync(logDir, { recursive: true });
	const log = join(logDir, `${suite.name}${suffix}${tag}.log`);
	const fd = openSync(log, "w");
	const began = performance.now();
	try {
		const child = Bun.spawn([process.execPath, join("scripts/e2e", suite.script)], {
			cwd: ROOT,
			env: { ...process.env, ...(suite.env ?? {}), E2E_WORK: work, E2E_PORT_OFFSET: String(portOffset) },
			stdout: fd,
			stderr: fd,
			stdin: "ignore",
		});
		return child.exited
			.then(code => ({ suite, code, seconds: (performance.now() - began) / 1000, log }))
			.finally(() => closeSync(fd));
	} catch (error) {
		closeSync(fd);
		return Promise.resolve({
			suite,
			code: 1,
			seconds: (performance.now() - began) / 1000,
			log: `${log} (could not start: ${error instanceof Error ? error.message : String(error)})`,
		});
	}
}

/** The last meaningful lines of a failed suite, so the output names the cause without opening the log. */
function failureTail(log: string): string {
	try {
		const lines = readFileSync(log, "utf8").split("\n").filter(line => line.trim() !== "");
		return lines.slice(-12).map(line => `    ${line}`).join("\n");
	} catch {
		return "    (no log)";
	}
}

/** Nothing of this run may outlive it: omp's pooled workers keep their cwd inside their suite's work folder. */
function stopLeftoverWorkers(workDirs: ReadonlySet<string>): void {
	if (workDirs.size === 0) return;
	const underWork = (cwd: string): boolean => {
		for (const dir of workDirs) {
			for (const root of [dir, join("/private", dir)]) {
				if (cwd === root || cwd.startsWith(`${root}/`)) return true;
			}
		}
		return false;
	};
	const pids = Bun.spawnSync(["pgrep", "-f", "__omp_worker_daemon"]).stdout.toString().split("\n").filter(Boolean);
	for (const pid of pids) {
		const cwd = Bun.spawnSync(["lsof", "-a", "-p", pid, "-d", "cwd"]).stdout.toString().trim().split("\n").at(-1)?.split(/\s+/).at(-1);
		if (cwd !== undefined && underWork(cwd)) {
			try {
				process.kill(Number(pid), "SIGTERM");
			} catch {
				// Already gone.
			}
		}
	}
}

function table(results: readonly RunResult[]): string {
	const width = Math.max(6, ...results.map(result => result.suite.name.length));
	const rows = results.map(result => {
		const state = result.code === 0 ? (result.recovered === true ? "pass (alone)" : "pass") : "FAIL";
		const seconds = `${result.seconds.toFixed(1)}s`.padStart(8);
		return `${result.suite.name.padEnd(width)}  ${state.padEnd(12)} ${seconds}  ${result.log}`;
	});
	return [`${"suite".padEnd(width)}  ${"result".padEnd(12)} ${"time".padStart(8)}  log`, ...rows].join("\n");
}

const options = parseArgs(process.argv.slice(2));
portOffset = options.portOffset;
const suites = selected(options);
if (options.list) {
	for (const suite of suites) console.log(`${suite.group}\t${suite.name}\t${suite.env === undefined ? "" : Object.entries(suite.env).map(([key, value]) => `${key}=${value}`).join(" ")}\t${suite.script}\t${suite.note}`);
	process.exit(0);
}
if (suites.length === 0) usage("no suite selected");

const workRoot = resolve(process.env.E2E_WORK_ROOT ?? tmpdir());
const results: RunResult[] = [];
const queue = [...suites];
const running = new Set<Promise<RunResult>>();
const began = performance.now();

console.log(`e2e:all: ${suites.length} suite(s), ${options.jobs} at a time, work under ${workRoot}`);

function launch(suite: E2eSuite, suffix = ""): void {
	const task = runSuite(suite, workRoot, suffix).then(result => {
		results.push(result);
		const state = result.code === 0 ? "pass" : "FAIL";
		console.log(`${state.padEnd(4)} ${result.suite.name.padEnd(24)} ${result.seconds.toFixed(1).padStart(7)}s`);
		return result;
	});
	task.then(() => running.delete(task));
	running.add(task);
}

while (queue.length > 0 || running.size > 0) {
	while (running.size < options.jobs && queue.length > 0) {
		const suite = queue.shift();
		if (suite !== undefined) launch(suite);
	}
	if (running.size === 0) break;
	void (await Promise.race(running));
}

/** One final result per suite: a pass alone after a failure beside others replaces that failure. */
const finals = new Map<string, RunResult>();
for (const result of results) finals.set(result.suite.name, result);
let failed = [...finals.values()].filter(result => result.code !== 0);
if (failed.length > 0 && options.rerun && options.jobs > 1) {
	console.log(`\ne2e:all: ${failed.length} suite(s) failed beside others; rerunning each alone once`);
	for (const result of failed) {
		const again = await runSuite(result.suite, workRoot, "-alone");
		if (again.code === 0) again.recovered = true;
		finals.set(again.suite.name, again);
		console.log(`${again.code === 0 ? "pass" : "FAIL"} ${again.suite.name} (alone) ${again.seconds.toFixed(1)}s`);
	}
	failed = [...finals.values()].filter(result => result.code !== 0);
}

const ordered = suites.map(suite => finals.get(suite.name)).filter((result): result is RunResult => result !== undefined);
console.log(`\n${table(ordered)}`);
const wall = ordered.reduce((sum, result) => sum + result.seconds, 0);
console.log(`\n${suites.length} suite(s), ${ordered.filter(result => result.code === 0).length} passed, ${failed.length} failed; ${wall.toFixed(1)}s of suite time, ${((performance.now() - began) / 1000).toFixed(1)}s wall`);
if (failed.length > 0) {
	for (const result of failed) {
		console.log(`\n${result.suite.name} failed (${result.log}):`);
		console.log(failureTail(result.log));
	}
}
stopLeftoverWorkers(workDirs);
process.exit(failed.length === 0 ? 0 : 1);
