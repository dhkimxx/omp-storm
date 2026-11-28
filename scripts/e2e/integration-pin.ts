#!/usr/bin/env bun
/**
 * Release pin and effective profile check against stock omp — no model call.
 *
 * The release claims about isolated capture and parent writes rest on a pinned package, host build and disposable
 * profile. This script records that combination and cites the source review. Run real-host scenarios separately
 * with `scripts/e2e/integration.ts`.
 *
 * What is checked:
 *   - the frozen 0.29.0 commit `ca4c3b7` is an ancestor, the five type-only integration files are present, and the release
 *     package/lock/host versions are the pinned ones;
 *   - the disposable profile's effective settings (read back through `omp config list --json`, not from the YAML we wrote):
 *     isolation enabled, auto-apply off, patch merge, an explicit native backend (never `auto`), and the main-thread control.
 *
 * Source references below explain why the host is blocked. They are not runtime checks of the isolation boundary.
 *
 * What it deliberately does not claim: on host 19.2.1 the backend read after the hook can still select ovnfs if
 * `isolation.backend` becomes `auto` and `ovnfs.path` resolves in that window. That is reported as the
 * `backend-late-read` gate BLOCKED with the exact minimal host seam, never as a passing profile. A real-host carrier,
 * apply and write scenario must be run separately; its absence is `not-run`, not green.
 *
 * Usage:
 *   E2E_KEEP=1 ./node_modules/.bin/bun scripts/e2e/integration-pin.ts
 *   INTEGRATION_REQUIRE_GATES=1 ...    # exit 2 until the blocked release gates are proved or explicitly narrowed
 *
 * Evidence is written to `<work>/logs/integration-pin.json`; `E2E_KEEP=1` keeps the work directory.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { availableParallelism, homedir, release as osRelease, version as osVersion } from "node:os";
import { join } from "node:path";
import { type E2eEnv, prepare, ROOT, Suite } from "./harness.ts";

/** The frozen 0.29.0 release this phase starts from. */
const FROZEN_COMMIT = "ca4c3b7299c5d82961ab63fdbf18fc78bd915379";
/** The commit that installed the five type-only integration interfaces; the feature build must descend from it. */
const INTERFACE_COMMIT = "865f14393220857945a4ea7c45e990b517adccc9";
const RELEASE_VERSION = "0.31.0";
const HOST_VERSION = "19.2.1";
const INTERFACE_FILES = [
	"integration-admission.ts",
	"integration-capture.ts",
	"integration-controller-port.ts",
	"integration-delta.ts",
	"integration-record.ts",
] as const;

const env = prepare("storm-e2e-integration-pin", 18830);
const suite = new Suite(`E2E (${RELEASE_VERSION} integration pin and profile proof)`, env);
const check = suite.check.bind(suite);

type GateState = "source-reviewed" | "blocked" | "not-run";
interface Gate {
	id: string;
	state: GateState;
	evidence: string;
	next: string;
}
const gates: Gate[] = [];
const gate = (id: string, state: GateState, evidence: string, next: string): void => {
	gates.push({ id, state, evidence, next });
};

interface ConfigRow {
	value?: unknown;
	type?: string;
	description?: string;
}
type ConfigList = Record<string, ConfigRow>;

function run(args: string[], cwd: string, extraEnv: Record<string, string | undefined> = {}): string {
	const step = Bun.spawnSync(args, { cwd, env: { ...process.env, ...extraEnv } });
	if (step.exitCode !== 0) throw new Error(`${args.join(" ")} failed (${step.exitCode}): ${step.stderr.toString()}`);
	return step.stdout.toString();
}

function git(args: readonly string[]): string {
	return run(["git", "-C", ROOT, ...args], ROOT);
}

function sha256(data: string | Uint8Array): string {
	return new Bun.CryptoHasher("sha256").update(data).digest("hex");
}

/** Digest of the shipped plugin files: path and bytes, sorted, so a build can be named without an archive. */
function shippedDigest(): { files: number; digest: string } {
	const listed = git(["ls-files", "-z", "--", "src", "agents", "priors", "package.json", "tsconfig.json", "README.md"])
		.split("\0")
		.filter(Boolean)
		.sort();
	const hasher = new Bun.CryptoHasher("sha256");
	for (const file of listed) {
		hasher.update(file);
		hasher.update("\0");
		hasher.update(readFileSync(join(ROOT, file)));
		hasher.update("\0");
	}
	return { files: listed.length, digest: hasher.digest("hex") };
}

function rowOf(list: ConfigList, key: string): ConfigRow | undefined {
	return list[key];
}

function valueOf(list: ConfigList, key: string): unknown {
	return rowOf(list, key)?.value;
}

function effective(env: E2eEnv, profile: string): ConfigList {
	const out = run([env.omp, "--profile", profile, "config", "list", "--json"], env.project, env.childEnv);
	return JSON.parse(out) as ConfigList;
}

/** The profile form the release uses: explicit native backend, patch mode, auto-apply off, main-thread control. */
function writeProfile(env: E2eEnv, profile: string, backend: string, workerThreads: number | undefined): string {
	const dir = join(env.home, ".omp", "profiles", profile, "agent");
	mkdirSync(dir, { recursive: true });
	const lines = [
		"setupVersion: 3",
		"task:",
		"  isolation:",
		"    enabled: true",
		"    apply: false",
		"    merge: patch",
	];
	if (workerThreads !== undefined) lines.push(`  workerThreads: ${workerThreads}`);
	lines.push("isolation:", `  backend: ${backend}`, "async:", "  enabled: true");
	const file = join(dir, "config.yml");
	writeFileSync(file, `${lines.join("\n")}\n`);
	return file;
}

function nativeBackend(): string {
	const requested = process.env.E2E_NATIVE_BACKEND?.trim();
	if (requested !== undefined && requested !== "" && requested !== "auto") return requested;
	switch (process.platform) {
		case "darwin":
			return "apfs";
		case "linux":
			return "reflink";
		default:
			return "rcopy";
	}
}

async function main(): Promise<void> {
	const host = join(ROOT, "node_modules", "@oh-my-pi", "pi-coding-agent");
	const hostSource = join(host, "src");
	const hostPackage = JSON.parse(readFileSync(join(host, "package.json"), "utf8")) as { version?: unknown };
	const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version?: unknown; devDependencies?: Record<string, unknown> };
	const lock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8")) as {
		version?: unknown;
		lockfileVersion?: unknown;
		packages?: Record<string, { version?: unknown }>;
	};
	const lockVersion = (name: string): unknown => lock.packages?.[`node_modules/${name}`]?.version;

	check(`the release package version is ${RELEASE_VERSION}`, pkg.version === RELEASE_VERSION, `package.json=${String(pkg.version)}`);
	check("the lockfile records the release version", lock.version === RELEASE_VERSION && lock.packages?.[""]?.version === RELEASE_VERSION, String(lock.version));
	check("the lockfile is lockfileVersion 3", lock.lockfileVersion === 3, `lockfileVersion=${String(lock.lockfileVersion)}`);
	for (const name of ["@oh-my-pi/pi-ai", "@oh-my-pi/pi-catalog", "@oh-my-pi/pi-coding-agent", "@oh-my-pi/pi-natives", "@oh-my-pi/pi-tui", "@oh-my-pi/pi-utils"]) {
		check(`${name} is pinned to ${HOST_VERSION} in package.json and the lock`, pkg.devDependencies?.[name] === HOST_VERSION && lockVersion(name) === HOST_VERSION, `lock=${String(lockVersion(name))}`);
	}
	check(`the installed host package is ${HOST_VERSION}`, hostPackage.version === HOST_VERSION, `host package=${String(hostPackage.version)}`);
	check(`omp --version reports ${HOST_VERSION}`, env.ompVersion === `omp/${HOST_VERSION}`, env.ompVersion);

	check(`HEAD descends from the frozen 0.29.0 commit ${FROZEN_COMMIT.slice(0, 9)}`, (() => {
		try {
			git(["merge-base", "--is-ancestor", FROZEN_COMMIT, "HEAD"]);
			return true;
		} catch {
			return false;
		}
	})(), `HEAD=${git(["rev-parse", "HEAD"]).trim()}`);
	check(`the five integration interfaces exist in this build (${INTERFACE_COMMIT.slice(0, 9)})`, INTERFACE_FILES.every(file => existsSync(join(ROOT, "src", "runtime", file))), INTERFACE_FILES.filter(file => !existsSync(join(ROOT, "src", "runtime", file))).join(", ") || "all present");
	const interfaceDigest = sha256(INTERFACE_FILES.map(file => `${file}\n${sha256(readFileSync(join(ROOT, "src", "runtime", file)))}`).join("\n"));

	const shipped = shippedDigest();
	check("the shipped file set is non-empty", shipped.files > 0, `files=${shipped.files}`);
	check("the plugin entry exists", existsSync(join(ROOT, "src", "entry.ts")), join(ROOT, "src", "entry.ts"));

	// ── profile: write it through the same settings file omp reads, then read the effective values back ─────────────
	const backend = nativeBackend();
	const profileFile = writeProfile(env, env.profile, backend, 0);
	const profile = effective(env, env.profile);
	check("the disposable HOME is not the user's home", env.home !== homedir() && env.home.startsWith(env.work), `home=${env.home}`);
	check("the effective profile enables task isolation", valueOf(profile, "task.isolation.enabled") === true, JSON.stringify(valueOf(profile, "task.isolation.enabled")));
	check("the effective profile disables auto-apply", valueOf(profile, "task.isolation.apply") === false, JSON.stringify(valueOf(profile, "task.isolation.apply")));
	check("the effective profile merges as a patch", valueOf(profile, "task.isolation.merge") === "patch", JSON.stringify(valueOf(profile, "task.isolation.merge")));
	check("the effective isolation backend is an explicit native backend, never auto", valueOf(profile, "isolation.backend") === backend && backend !== "auto", JSON.stringify(valueOf(profile, "isolation.backend")));
	check("the effective profile keeps every subagent on the main thread (the 16 control)", valueOf(profile, "task.workerThreads") === 0, JSON.stringify(valueOf(profile, "task.workerThreads")));
	check("async delivery is on for the wait/push profile", valueOf(profile, "async.enabled") === true, JSON.stringify(valueOf(profile, "async.enabled")));
	check("ovnfs.path is not configured in the explicit-native profile", rowOf(profile, "ovnfs.path")?.value === undefined, JSON.stringify(rowOf(profile, "ovnfs.path")?.value));

	const pooledProfile = env.profile.replace(/[^a-z0-9-]+/gi, "-") + "-pooled";
	const pooledFile = writeProfile(env, pooledProfile, backend, undefined);
	const pooled = effective(env, pooledProfile);
	check("the default pooled profile really reports task.workerThreads 4", valueOf(pooled, "task.workerThreads") === 4, JSON.stringify(valueOf(pooled, "task.workerThreads")));

	// Source-reviewed on this host pin. String matches cannot establish the live settings or dispatch decision.
	gate("task-isolation-payload", "source-reviewed", "task/index.ts:1006,1895 pass only { requested } for task isolation.", "the hook cannot set apply, merge or backend");
	gate("apply-before-hook", "source-reviewed", "structured-subagent.ts:499 reloads, :599-626 captures apply/merge, :643-655 fires the hook.", "the captured decision is not in the event; the exact session settings epoch still matters");
	gate("backend-late-read", "blocked", "structured-subagent.ts:987 runs the hook; :1047 calls openIsolatedWorkspace; :853-854 reads isolation.backend and then ovnfs.path in auto mode. The hook cannot prove the later native route.", "resolve and freeze the workspace factory before the spawn hook, expose its decision and a token at the hook, then reuse the same factory and echo the token at child entry");
	gate("settings-scope", "not-run", "runner.ts:2120 uses withActiveSettings; config/settings.ts:4521-4527 may fall back to global outside scope.", "compare exact live session Settings identity and epoch at arm and final grant");
	gate("native-slot-stability", "not-run", "taskIsolationBaseDir is deterministic per repo+id; ensureIsolation removes the slot and writes the owner marker before isoStart. A same-slot reservation across managed sessions has to be proved by A/E and observed at child entry; the pin source alone proves only the shape.", "real-host scenario must reserve a slot, start a replacement attempt, and show the first owner marker/checkout is not silently reused");
	gate("carrier-sync-wait-push", "not-run", "The sync, wait and push carriers are implemented as scripts/e2e/integration.ts scenarios but were not run in this pin (no model call, no omp session).", "run each carrier scenario independently after the host seam; any unproved route blocks normal release");
	gate("installer-and-receipt", "not-run", "The fixed installer, synced intent/fence, exact readback and durable receipt are write/judgment scenarios, not a pin source fact.", "run the write and judgment scenarios against a real target in a disposable repo; keep launch refusal and installer effect proofs separate");
	gate("pooled-default-stop", "not-run", "The default pooled profile reports task.workerThreads 4; the pin does not start workers, so the actual stop is not observed.", "run the default pooled profile with more than 9 workers and record the actual home and stop cause; never infer it from the requested setting");
	gate("scale-16-and-100", "not-run", "No 16-lane physical overlap or 100-candidate fixture was run.", "run the main-thread control and the default pooled profile at 16, and the approved 100-candidate fixture plus a real subset");

	// ── record what this machine actually is, not what the release assumes ──────────────────────────────────────
	const version = run(["git", "--version"], ROOT).trim();
	const status = git(["status", "--porcelain=v1"]).trim();
	const evidence = {
		schema: "storm.integration-pin/v1",
		generatedAt: new Date().toISOString(),
		release: { package: pkg.version, expected: RELEASE_VERSION, frozenCommit: FROZEN_COMMIT, interfaceCommit: INTERFACE_COMMIT, interfaceDigest, shipped },
		host: {
			version: env.ompVersion,
			package: hostPackage.version,
			binary: env.omp,
			binaryBytes: statSync(env.omp).size,
			binarySha256: sha256(readFileSync(env.omp)),
			distSha256: sha256(readFileSync(join(host, "dist", "cli.js"))),
		},
		hostSource: { root: hostSource, anchors: { structured: 987, backendRead: 853, workspaceCall: 1047, ovnfsPath: 197, handlerScope: 2120, findScopedSettings: 4521 } },
		system: {
			platform: process.platform,
			arch: process.arch,
			osRelease: osRelease(),
			osVersion: osVersion(),
			bun: Bun.version,
			runtime: process.execPath,
			pid: process.pid,
			home: process.env.HOME ?? null,
			disposableHome: env.home,
			parallelism: availableParallelism(),
			git: version,
		},
		profile: {
			file: profileFile,
			effective: {
				"task.isolation.enabled": valueOf(profile, "task.isolation.enabled"),
				"task.isolation.apply": valueOf(profile, "task.isolation.apply"),
				"task.isolation.merge": valueOf(profile, "task.isolation.merge"),
				"isolation.backend": valueOf(profile, "isolation.backend"),
				"task.workerThreads": valueOf(profile, "task.workerThreads"),
				"async.enabled": valueOf(profile, "async.enabled"),
				"ovnfs.path": rowOf(profile, "ovnfs.path")?.value ?? null,
			},
			pooledFile,
			pooled: { "task.workerThreads": valueOf(pooled, "task.workerThreads") },
			backend,
		},
		git: { head: git(["rev-parse", "HEAD"]).trim(), frozen: git(["rev-parse", FROZEN_COMMIT]).trim(), status },
		gates,
	};

	// One JSON file holds the evidence; the stdout lines stay short enough to read in a terminal.
	const evidenceFile = join(env.logs, "integration-pin.json");
	writeFileSync(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`);
	check("the pin evidence file was written", existsSync(evidenceFile) && statSync(evidenceFile).size > 0, evidenceFile);
	check("the built host file is present and non-empty", statSync(join(host, "dist", "cli.js")).size > 0, `bytes=${statSync(join(host, "dist", "cli.js")).size}`);
	console.log(`PIN worktree dirty paths: ${status.split("\n").slice(0, 8).join(" | ") || "clean"}`);

	console.log(`PIN release=${String(pkg.version)} frozen=${FROZEN_COMMIT.slice(0, 9)} head=${evidence.git.head.slice(0, 9)} host=${env.ompVersion} backend=${backend}`);
	console.log(`PIN shipped=${shipped.files} files sha256=${shipped.digest} interfaces=${interfaceDigest.slice(0, 16)}`);
	console.log(`PIN profile=${profileFile}`);
	console.log(`PIN evidence=${evidenceFile}`);
	for (const item of gates) console.log(`GATE ${item.id}: ${item.state.toUpperCase()} — ${item.evidence}`);
	const failed = suite.finish();
	const blocked = gates.some(item => item.state === "blocked");
	if (process.env.INTEGRATION_REQUIRE_GATES === "1" && blocked && failed === 0) process.exitCode = 2;
	else process.exitCode = failed;
}

await main().catch((error: unknown) => {
	suite.check("pin proof completed", false, error instanceof Error ? (error.stack ?? error.message) : String(error));
	suite.finish();
	process.exitCode = 1;
});
