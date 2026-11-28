#!/usr/bin/env bun
/**
 * 0.30.0 isolated integration, real host: a disposable git checkout, an isolated HOME/profile, the pinned omp and the
 * local fake LLM. No paid model calls and nothing under the real user profile is read or written.
 *
 * Each named scenario starts and finishes independently (`E2E_ONLY=<part>`). It drives packaged Storm through its
 * public surfaces only: a planned isolated lane, the native carrier, `storm candidates`, `storm integrate`, the run
 * record, the target working tree/index/HEAD, and the native patch/branch artifacts. The captures are also checked in
 * the durable journal when it can be found; no private file name is assumed.
 *
 * Covered here:
 *   carrier: sync, wait, push, push then empty wait, mixed wait/push, empty, nested-only, root+nested, branch, cancel,
 *            failed yield, capture failure, native and Storm-copy tamper controls;
 *   policy:  apply-on refusal before a child, the unmanaged native apply-on control, the late-auto/ovnfs and
 *            apply-ABA windows through a test probe, exact Settings identity;
 *   write:   dirty touched preimage preserved with the index and unrelated WIP, clean delete, dirty/untracked delete
 *            refusal, unrelated moved HEAD, same-file and same-add conflict, binary modification, mode-only and rename
 *            refusal;
 *   judgment: an integrated change row through the existing evaluator, a strict integrated dependency before/after
 *            the receipt, and an outside equal postimage that is present but unattributed (no receipt, no acceptance).
 *
 * Not run by default: the managed-launch carrier/writer/judgment scenarios on stock 19.2.1 (`INTEGRATION_MANAGED_LAUNCH=1`
 * after the host seam), the 16-lane main-thread/pooled measurement and the 100-candidate scale case (`E2E_SCALE=1`).
 * The pin script and this file report them as blocked/not-run; no suite run is reported as a release proof.
 *
 * Usage:
 *   E2E_ONLY="carrier: sync" ./node_modules/.bin/bun scripts/e2e/integration.ts
 *   INTEGRATION_GROUP=write ./node_modules/.bin/bun scripts/e2e/integration.ts
 *   E2E_SCALE=1 ./node_modules/.bin/bun scripts/e2e/integration.ts
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { isRecord } from "../../src/config/schema.ts";
import type { RunRecord } from "../../src/types.ts";
import { contractPlan, requiredResult, type ContractLane } from "./contract-fixture.ts";
import { cancelAll, type Frame, LlmCursor, prepare, Rpc, type Step, StormFiles, Suite, startFakeLlm, until } from "./harness.ts";
import { nativeBackend, writeIsolationProfile } from "./integration-profile.ts";
import { installProfile, runRequest, Sessions } from "./phase1-kit.ts";
import { FACT_FILE, seedFact } from "./typed-fixture.ts";

const REASON = "통합 E2E: 부모 트리와 분리된 구현 체크아웃";
const GROUP = process.env.INTEGRATION_GROUP?.trim().toLowerCase();
const SCALE = process.env.E2E_SCALE === "1";
/** Stock 19.2.1 has no per-dispatch native backend proof; the carrier/writer scenarios stay unrun until the seam is real. */
const MANAGED_LAUNCH = process.env.INTEGRATION_MANAGED_LAUNCH === "1";

const env = prepare("storm-e2e-integration", 18831);
const suite = new Suite("E2E (0.30.0 isolated integration)", env);
const check = suite.check.bind(suite);
const sessions = new Sessions(env);

function include(group: string, name: string): boolean {
	return GROUP === undefined || GROUP === "" || GROUP === group || name.toLowerCase().includes(GROUP);
}

// ── target snapshots ─────────────────────────────────────────────────────────────────────────────────────────────

interface FileImage {
	kind: "absent" | "file" | "other";
	mode?: string;
	bytes?: number;
	sha256?: string;
}

interface ParentState {
	head: string;
	index: string;
	indexEntries: string;
	status: string;
	images: Record<string, FileImage>;
}

function gitAt(project: string, args: readonly string[]): string {
	const step = Bun.spawnSync(["git", "-C", project, ...args]);
	if (step.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${step.stderr.toString()}`);
	return step.stdout.toString();
}

function sha256(data: string | Uint8Array): string {
	return new Bun.CryptoHasher("sha256").update(data).digest("hex");
}

function imageAt(path: string): FileImage {
	if (!existsSync(path)) return { kind: "absent" };
	const stat = statSync(path);
	if (!stat.isFile()) return { kind: "other" };
	const mode = (stat.mode & 0o111) === 0 ? "100644" : "100755";
	const bytes = readFileSync(path);
	return { kind: "file", mode, bytes: bytes.length, sha256: sha256(bytes) };
}

function parentState(project: string, paths: readonly string[]): ParentState {
	const index = resolve(project, gitAt(project, ["rev-parse", "--git-path", "index"]).trim());
	const images: Record<string, FileImage> = {};
	for (const path of paths) images[path] = imageAt(join(project, path));
	return {
		head: gitAt(project, ["rev-parse", "HEAD"]).trim(),
		index: existsSync(index) ? sha256(readFileSync(index)) : "absent",
		indexEntries: gitAt(project, ["ls-files", "-s", "--", ...paths]),
		status: gitAt(project, ["status", "--porcelain=v2", "--", ...paths]),
		images,
	};
}

function sameParent(label: string, before: ParentState, after: ParentState, paths: readonly string[]): void {
	check(`${label}: HEAD did not move`, before.head === after.head, `${before.head} -> ${after.head}`);
	check(`${label}: the index bytes did not change`, before.index === after.index, `${before.index.slice(0, 16)} -> ${after.index.slice(0, 16)}`);
	check(`${label}: the index entries did not change`, before.indexEntries === after.indexEntries, after.indexEntries.slice(0, 400));
	check(`${label}: status did not change on the recorded paths`, before.status === after.status, `${before.status.trim()} -> ${after.status.trim()}`);
	for (const path of paths) {
		const a = before.images[path];
		const b = after.images[path];
		check(`${label}: ${path} is unchanged`, JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} -> ${JSON.stringify(b)}`);
	}
}

// ── durable journal and native artifacts ────────────────────────────────────────────────────────────────────────

function property(value: unknown, key: string): unknown {
	if (value === null || typeof value !== "object") return undefined;
	return key in value ? Reflect.get(value, key) : undefined;
}

function jsonObjects(text: string): Record<string, unknown>[] {
	try {
		const whole: unknown = JSON.parse(text);
		if (isRecord(whole)) return [whole];
	} catch {}
	return text.split("\n").flatMap(line => {
		if (line.trim() === "") return [];
		try {
			const value: unknown = JSON.parse(line);
			return isRecord(value) ? [value] : [];
		} catch {
			return [];
		}
	});
}

function journalAt(sessionDir: string, runId: string): Record<string, unknown>[] {
	const path = join(sessionDir, "state", "integration", "runs", runId, "journal.jsonl");
	return existsSync(path) ? jsonObjects(readFileSync(path, "utf8")).filter(row => row.schema === "storm.integration-journal/v1") : [];
}

function manifestOf(files: StormFiles, runId: string): Record<string, unknown> | undefined {
	return journalAt(files.sessionDir, runId)
		.filter(row => row.kind === "manifest")
		.map(row => property(row.payload, "manifest"))
		.find((value): value is Record<string, unknown> => isRecord(value) && value.schema === "storm.integration-capture/v1" &&
			property(property(value.admission, "key"), "runId") === runId);
}

function ownedCopyOf(hash: string): string | undefined {
	if (!/^[0-9a-f]{64}$/u.test(hash)) return undefined;
	const path = join(env.agentDir, "integration", "v1", "objects", hash);
	return existsSync(path) && sha256(readFileSync(path)) === hash ? path : undefined;
}

interface PatchInfo {
	path: string;
	name: string;
	bytes: number;
	sha256: string;
}

function patchesOf(run: RunRecord): PatchInfo[] {
	const dir = run.artifactsDir;
	if (dir === undefined || !existsSync(dir)) return [];
	return readdirSync(dir)
		.filter(name => name.endsWith(".patch"))
		.sort()
		.map(name => {
			const path = join(dir, name);
			const bytes = readFileSync(path);
			return { path, name, bytes: bytes.length, sha256: sha256(bytes) };
		});
}

// ── tool text ───────────────────────────────────────────────────────────────────────────────────────────────────

function resultTextOf(frame: Frame): string {
	const result = frame.result;
	if (result === undefined || typeof result !== "object" || !("content" in result)) return "";
	const content = result.content;
	if (!Array.isArray(content)) return "";
	return content.map(part => (part !== null && typeof part === "object" && "text" in part ? String(part.text) : "")).join("\n");
}

function stormTexts(frames: readonly Frame[]): string[] {
	return frames.filter(frame => frame.type === "tool_execution_end" && frame.toolName === "storm").map(resultTextOf);
}

function candidateIds(text: string): string[] {
	return [...new Set([...text.matchAll(/\bc1_[0-9a-f]{64}\b/g)].map(match => match[0]))];
}

function waitJobCount(frame: Frame): number | undefined {
	const details = property(frame.result, "details");
	const jobs = property(details, "jobs");
	return Array.isArray(jobs) ? jobs.length : undefined;
}

function asyncJobId(frames: readonly Frame[]): string | undefined {
	for (const frame of [...frames].reverse()) {
		if (frame.type !== "tool_execution_end" || frame.toolName !== "task") continue;
		const async = property(property(frame.result, "details"), "async");
		const jobId = property(async, "jobId");
		if (typeof jobId === "string" && jobId !== "") return jobId;
	}
	return undefined;
}

// ── plan / run helpers ──────────────────────────────────────────────────────────────────────────────────────────

interface PlannedRun {
	run: RunRecord;
	frames: Frame[];
}

function laneFor(name: string, file: string, resultId: string, kind: "change" | "artifact" = "change"): ContractLane {
	return {
		name,
		kind: "code",
		files: [file],
		isolationReason: REASON,
		results: [requiredResult(resultId, kind, `the isolated lane wrote ${file}`, { path: file, contains: "storm child change" })],
	};
}

async function plannedRun(
	rpc: Rpc,
	files: StormFiles,
	lanes: readonly ContractLane[],
	steps: readonly Step[],
	workers: Record<string, number> | undefined,
	rounds = 1,
	timeoutMs = 300_000,
): Promise<PlannedRun> {
	const before = files.runIds();
	const beforeFrames = rpc.frames.length;
	const sequence: Step[] = [contractPlan(lanes, { contract: true, ...(workers === undefined ? {} : { workers }) }), ...steps];
	await rpc.prompt(runRequest(sequence, rounds), timeoutMs);
	const run = await files.finishedRun(before, timeoutMs);
	return { run, frames: rpc.frames.slice(beforeFrames) };
}

/** A candidates view outside any run: the most recent authorized record is the default, as the contract says. */
async function candidates(rpc: Rpc, extra: Record<string, unknown> = {}): Promise<{ text: string; frames: Frame[] }> {
	const from = rpc.frames.length;
	await rpc.turn(`E2E-TOOL ${JSON.stringify({ action: "candidates", ...extra })}`, 90_000);
	const frames = rpc.frames.slice(from);
	const text = stormTexts(frames).at(-1) ?? "";
	return { text, frames };
}

function childWrite(file: string, claim = "OK"): string {
	return `E2E-CHILD-WRITE ${file}\nE2E-CHILD-CLAIM ${claim}`;
}

function shellCommand(script: string): string {
	return `E2E-CHILD-SH ${Buffer.from(script, "utf8").toString("base64")}`;
}

function markerDir(name: string): string {
	const dir = join(env.work, "integration-markers", name);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function real(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

function outsideProject(path: string): boolean {
	const project = real(env.project);
	const candidate = real(path);
	const relativePath = relative(project, candidate);
	return relativePath.startsWith("..");
}

// ── scenarios ──────────────────────────────────────────────────────────────────────────────────────────────────

async function carrierSync(): Promise<void> {
	writeIsolationProfile(env, { enabled: true, apply: false, merge: "patch", backend: nativeBackend(), async: false, workerThreads: 0 });
	const file = "e2e-integration-sync.txt";
	const before = parentState(env.project, [file]);
	await sessions.open(cancelAll, async (rpc, files) => {
		const lane = "carrier-sync";
		const { run } = await plannedRun(rpc, files, [laneFor(lane, file, "carrier-sync-change")], [
			{ tasks: [{ name: lane, agent: "storm-implementer", task: "Write one file", say: childWrite(file) }] },
			{ wait: true },
		], { implementer: 1 });
		const after = parentState(env.project, [file]);
		sameParent("carrier sync", before, after, [file]);
		const patches = patchesOf(run);
		check("carrier sync: the host emitted a root patch", patches.length > 0, JSON.stringify(patches.map(patch => [patch.name, patch.bytes])));
		const manifest = manifestOf(files, run.runId);
		check("carrier sync: a sealed manifest exists for the run", manifest !== undefined, JSON.stringify(journalAt(files.sessionDir, run.runId).map(row => row.kind)));
		if (manifest !== undefined) {
			const bundle = property(manifest, "bundle");
			const root = property(bundle, "root");
			const policy = property(property(manifest, "admission"), "policy");
			check("carrier sync: the bundle is root-only", property(bundle, "kind") === "root-only", String(property(bundle, "kind")));
			check("carrier sync: the root copy matches an emitted patch byte-for-byte", patches.some(patch => patch.bytes === property(root, "bytes") && patch.sha256 === property(root, "sha256")), JSON.stringify({ root: { bytes: property(root, "bytes"), sha: property(root, "sha256") }, patches }));
			check("carrier sync: the admission recorded apply off and patch mode", property(policy, "apply") === false && property(policy, "merge") === "patch", JSON.stringify({ apply: property(policy, "apply"), merge: property(policy, "merge") }));
			check("carrier sync: the admission names an explicit non-auto backend", typeof property(policy, "backendSetting") === "string" && property(policy, "backendSetting") !== "auto", String(property(policy, "backendSetting")));
			const claim = property(manifest, "childClaim");
			check("carrier sync: the child entry claim is known", property(claim, "kind") === "known", String(property(claim, "kind")));
			const checkout = property(property(claim, "value"), "checkout");
			const checkoutPath = property(checkout, "canonicalPath");
			check("carrier sync: the child claim is outside the parent checkout", typeof checkoutPath === "string" && outsideProject(checkoutPath), String(checkoutPath));
			const copyHash = property(property(manifest, "bundle"), "root");
			const hash = property(copyHash, "sha256");
			check("carrier sync: a Storm-owned copy of the root bytes exists", typeof hash === "string" && ownedCopyOf(hash) !== undefined, typeof hash === "string" ? hash : "no hash");
		}
		const view = await candidates(rpc);
		const ids = candidateIds(view.text);
		check("carrier sync: the candidates view names one exact ID", ids.length === 1, JSON.stringify({ ids, text: view.text.slice(0, 800) }));
		if (ids[0] !== undefined) {
			const detail = await candidates(rpc, { candidateId: ids[0] });
			check("carrier sync: exact detail names the candidate and a native patch", detail.text.includes(ids[0]) && detail.text.includes(".patch"), detail.text.slice(0, 800));
		}
	});
}

async function carrierWaitPush(): Promise<void> {
	writeIsolationProfile(env, { enabled: true, apply: false, merge: "patch", backend: nativeBackend(), async: true, workerThreads: 0 });
	await sessions.open(cancelAll, async (rpc, files) => {
		const waitFile = "e2e-integration-wait.txt";
		const waitLane = "carrier-wait";
		const waitRun = await plannedRun(rpc, files, [laneFor(waitLane, waitFile, "carrier-wait-change")], [
			{ tasks: [{ name: waitLane, agent: "storm-implementer", task: "Write one file", say: childWrite(waitFile) }] },
			{ wait: true },
		], { implementer: 1 });
		const waitView = await candidates(rpc);
		check("carrier wait: the run captured one candidate", candidateIds(waitView.text).length >= 1, waitView.text.slice(0, 600));
		check("carrier wait: the parent did not receive the file", !existsSync(join(env.project, waitFile)), waitFile);
		check("carrier wait: the native patch exists", patchesOf(waitRun.run).some(patch => patch.bytes > 0), JSON.stringify(patchesOf(waitRun.run).map(patch => patch.bytes)));

		const pushFile = "e2e-integration-push.txt";
		const pushLane = "carrier-push";
		const pushRun = await plannedRun(rpc, files, [laneFor(pushLane, pushFile, "carrier-push-change")], [
			{ tasks: [{ name: pushLane, agent: "storm-implementer", task: "Write one file", say: childWrite(pushFile, "PUSH-DONE") }] },
			{ read: FACT_FILE, afterResult: "PUSH-DONE" },
			{ wait: true },
			{ storm: { action: "candidates" } },
		], { implementer: 1 });
		const pushView = stormTexts(pushRun.frames).join("\n");
		check("carrier push: the pushed result produced a candidate", candidateIds(pushView).length >= 1, pushView.slice(0, 800));
		check("carrier push: the parent did not receive the file", !existsSync(join(env.project, pushFile)), pushFile);
		const lateWait = pushRun.frames.filter(frame => frame.type === "tool_execution_end" && frame.toolName === "wait").at(-1);
		check("carrier push then empty wait: the late wait returns no job", lateWait !== undefined && waitJobCount(lateWait) === 0, JSON.stringify(lateWait === undefined ? null : lateWait.result));
		check("carrier push then empty wait: the same candidate is not duplicated", candidateIds(pushView).length === 1, JSON.stringify(candidateIds(pushView)));
	});
}

async function carrierMixedBatch(): Promise<void> {
	writeIsolationProfile(env, { enabled: true, apply: false, merge: "patch", backend: nativeBackend(), async: true, workerThreads: 0 });
	await sessions.open(cancelAll, async (rpc, files) => {
		const quickFile = "e2e-integration-batch-quick.txt";
		const lateFile = "e2e-integration-batch-late.txt";
		const quick = "carrier-batch-quick";
		const late = "carrier-batch-late";
		const run = await plannedRun(rpc, files, [laneFor(quick, quickFile, "batch-quick-change"), laneFor(late, lateFile, "batch-late-change")], [
			{
				tasks: [
					{ name: quick, agent: "storm-implementer", task: "Write one file", say: childWrite(quickFile, "QUICK-DONE") },
					{ name: late, agent: "storm-implementer", task: "Write later", say: `${childWrite(lateFile, "LATE-DONE")}\nE2E-CHILD-DELAY 4000` },
				],
			},
			{ wait: true },
			{ read: FACT_FILE, afterResult: "LATE-DONE" },
			{ storm: { action: "candidates" } },
		], { implementer: 2 });
		const view = stormTexts(run.frames).join("\n");
		check("mixed batch: both carriers produced distinct candidates", candidateIds(view).length === 2, JSON.stringify({ ids: candidateIds(view), text: view.slice(0, 900) }));
		check("mixed batch: neither file landed in the parent", !existsSync(join(env.project, quickFile)) && !existsSync(join(env.project, lateFile)), `${quickFile},${lateFile}`);
	});
}

async function carrierEmpty(): Promise<void> {
	writeIsolationProfile(env, { enabled: true, apply: false, merge: "patch", backend: nativeBackend(), async: true, workerThreads: 0 });
	await sessions.open(cancelAll, async (rpc, files) => {
		const lane = "carrier-empty";
		const file = "e2e-integration-empty.txt";
		const before = parentState(env.project, [file]);
		const { run } = await plannedRun(rpc, files, [laneFor(lane, file, "carrier-empty-change")], [
			{ tasks: [{ name: lane, agent: "storm-implementer", task: "Change nothing", say: "E2E-CHILD-CLAIM EMPTY" }] },
			{ wait: true },
		], { implementer: 1 });
		const manifest = manifestOf(files, run.runId);
		check("empty: the sealed bundle is confirmed-empty, not a root-only success", manifest !== undefined && property(property(manifest, "bundle"), "kind") === "confirmed-empty", JSON.stringify(manifest === undefined ? null : property(property(manifest, "bundle"), "kind")));
		if (manifest !== undefined) {
			const root = property(property(manifest, "bundle"), "root");
			check("empty: the captured root is zero bytes", property(root, "bytes") === 0, String(property(root, "bytes")));
		}
		sameParent("empty", before, parentState(env.project, [file]), [file]);
	});
}

async function carrierNested(): Promise<void> {
	writeIsolationProfile(env, { enabled: true, apply: false, merge: "patch", backend: nativeBackend(), async: false, workerThreads: 0 });
	await sessions.open(cancelAll, async (rpc, files) => {
		const lane = "carrier-nested";
		const rootFile = "e2e-integration-nested-root.txt";
		const script = [
			"mkdir -p nested-repo",
			"cd nested-repo",
			"git init -q",
			"git config user.name 'Storm E2E'",
			"git config user.email 'storm-e2e@example.invalid'",
			"printf 'NESTED-BASE\\n' > nested.txt",
			"git add nested.txt",
			"git commit -qm nested-base",
			"printf 'NESTED-CHILD\\n' >> nested.txt",
			"cd ..",
			"printf 'ROOT-CHILD\\n' > " + rootFile,
		].join(" && ");
		const before = parentState(env.project, [rootFile, "nested-repo"]);
		const { run } = await plannedRun(rpc, files, [laneFor(lane, rootFile, "carrier-nested-change")], [
			{ tasks: [{ name: lane, agent: "storm-implementer", task: "Write root and nested", say: shellCommand(script) }] },
			{ wait: true },
		], { implementer: 1 });
		const manifest = manifestOf(files, run.runId);
		const nested = property(property(manifest, "recovery"), "nested");
		check("root+nested: the manifest keeps the nested parts as a known list", manifest !== undefined && property(nested, "kind") === "known" && Array.isArray(property(nested, "value")) && (property(nested, "value") as unknown[]).length > 0, JSON.stringify(nested));
		check("root+nested: the bundle is not eligible root-only", property(property(manifest, "bundle"), "kind") !== "root-only", String(property(property(manifest, "bundle"), "kind")));
		sameParent("root+nested", before, parentState(env.project, [rootFile, "nested-repo"]), [rootFile, "nested-repo"]);
	});
}

async function carrierBranch(): Promise<void> {
	writeIsolationProfile(env, { enabled: true, apply: false, merge: "branch", backend: nativeBackend(), async: false, workerThreads: 0 });
	await sessions.open(cancelAll, async (rpc, files) => {
		const lane = "carrier-branch";
		const file = "e2e-integration-branch.txt";
		const before = parentState(env.project, [file]);
		const { run } = await plannedRun(rpc, files, [laneFor(lane, file, "carrier-branch-change")], [
			{ tasks: [{ name: lane, agent: "storm-implementer", task: "Write one file", say: childWrite(file) }] },
			{ wait: true },
		], { implementer: 1 });
		const refs = gitAt(env.project, ["for-each-ref", "--format=%(refname)", "refs/heads/omp/task"]).split("\n").filter(Boolean);
		check("branch: the native branch ref exists independently", refs.length > 0, JSON.stringify(refs));
		check("branch: the parent did not move", sameParentable(before, parentState(env.project, [file]), [file]), file);
		const manifest = manifestOf(files, run.runId);
		const branch = property(property(manifest, "recovery"), "branch");
		check("branch: the sealed recovery names the branch", property(branch, "kind") === "known" && String(property(property(branch, "value"), "ref")).startsWith("refs/heads/omp/task/"), JSON.stringify(branch));
		check("branch: the bundle is kept-only, not root-only", property(property(manifest, "bundle"), "kind") !== "root-only", String(property(property(manifest, "bundle"), "kind")));
	});
}

function sameParentable(before: ParentState, after: ParentState, paths: readonly string[]): boolean {
	if (before.head !== after.head || before.index !== after.index || before.indexEntries !== after.indexEntries || before.status !== after.status) return false;
	return paths.every(path => JSON.stringify(before.images[path]) === JSON.stringify(after.images[path]));
}

async function carrierCancel(): Promise<void> {
	writeIsolationProfile(env, { enabled: true, apply: false, merge: "patch", backend: nativeBackend(), async: true, workerThreads: 0 });
	await sessions.open(cancelAll, async (rpc, files) => {
		const lane = "carrier-cancel";
		const file = "e2e-integration-cancel.txt";
		const marker = join(markerDir("cancel"), "final.marker");
		const before = parentState(env.project, [file]);
		const from = rpc.frames.length;
		const beforeRuns = files.runIds();
		await rpc.prompt(runRequest([contractPlan([laneFor(lane, file, "carrier-cancel-change")], { contract: true, workers: { implementer: 1 } }), { tasks: [{ name: lane, agent: "storm-implementer", task: "Write then pause", say: `${childWrite(file, "CANCEL-DONE")}\nE2E-CHILD-FINAL-PAUSE 30000 ${marker}` }] }], 1), 300_000);
		const settled = await until(() => (existsSync(marker) ? true : undefined), 60_000, "the cancelling child's final marker").catch(() => false);
		const childId = asyncJobId(rpc.frames.slice(from));
		check("cancel: the child reached its final pause", settled && childId !== undefined, `marker=${marker} child=${String(childId)}`);
		if (childId !== undefined) {
			const cancelled = await rpc.cancelSubagent(childId);
			check("cancel: the host confirmed the cancellation", cancelled, String(cancelled));
		}
		const run = await files.finishedRun(beforeRuns, 120_000);
		const patches = patchesOf(run);
		check("cancel: a captured patch survives the cancelled outcome", patches.some(patch => patch.bytes > 0), JSON.stringify(patches.map(patch => patch.bytes)));
		sameParent("cancel", before, parentState(env.project, [file]), [file]);
	});
}

async function carrierFailure(): Promise<void> {
	writeIsolationProfile(env, { enabled: true, apply: false, merge: "patch", backend: nativeBackend(), async: true, workerThreads: 0, structured: true });
	await sessions.open(cancelAll, async (rpc, files) => {
		const lane = "carrier-failure";
		const file = "e2e-integration-failure.txt";
		const before = parentState(env.project, [file]);
		const { run } = await plannedRun(rpc, files, [laneFor(lane, file, "carrier-failure-change")], [
			{ tasks: [{ name: lane, agent: "storm-implementer", task: "Write then fail", say: `${childWrite(file, "FAIL-DONE")}\nE2E-CHILD-YIELD-ERROR integration failure control` }] },
			{ wait: true },
		], { reviewer: 1 });
		const patches = patchesOf(run);
		check("failed yield: the native patch remains recoverable", patches.some(patch => patch.bytes > 0), JSON.stringify(patches.map(patch => patch.bytes)));
		const manifest = manifestOf(files, run.runId);
		const terminal = property(manifest, "terminal");
		const outcome = property(property(terminal, "value"), "outcome");
		check("failed yield: the manifest keeps the failure outcome separate from the capture", property(terminal, "kind") === "known" && property(outcome, "kind") === "known" && property(outcome, "value") !== "success", JSON.stringify(outcome));
		sameParent("failed yield", before, parentState(env.project, [file]), [file]);
	});
}

async function carrierCaptureFailure(): Promise<void> {
	writeIsolationProfile(env, { enabled: true, apply: false, merge: "patch", backend: nativeBackend(), async: true, workerThreads: 0 });
	await sessions.open(cancelAll, async (rpc, files) => {
		const lane = "carrier-capture-failure";
		const file = "e2e-integration-capture-failure.txt";
		const marker = join(markerDir("capture-failure"), "final.marker");
		const before = parentState(env.project, [file]);
		const from = rpc.frames.length;
		const beforeRuns = files.runIds();
		await rpc.prompt(runRequest([contractPlan([laneFor(lane, file, "carrier-capture-failure-change")], { contract: true, workers: { implementer: 1 } }), { tasks: [{ name: lane, agent: "storm-implementer", task: "Write then pause", say: `${childWrite(file, "CAPTURE-FAIL-DONE")}\nE2E-CHILD-FINAL-PAUSE 30000 ${marker}` }] }], 1), 300_000);
		const settled = await until(() => (existsSync(marker) ? true : undefined), 60_000, "the capture-failure child's marker").catch(() => false);
		const childId = asyncJobId(rpc.frames.slice(from));
		check("capture failure: the child reached its final pause", settled && childId !== undefined, `marker=${marker} child=${String(childId)}`);
		if (childId !== undefined && rpc.sessionFile !== undefined) {
			const artifacts = rpc.sessionFile.slice(0, -".jsonl".length);
			const blocked = join(artifacts, `${childId}.patch`);
			mkdirSync(blocked, { recursive: true });
			check("capture failure: the blocker directory replaced the native patch", statSync(blocked).isDirectory(), blocked);
		}
		const run = await files.finishedRun(beforeRuns, 120_000);
		const manifest = manifestOf(files, run.runId);
		check("capture failure: no root-only candidate is claimed", manifest === undefined || property(property(manifest, "bundle"), "kind") !== "root-only", String(property(property(manifest, "bundle"), "kind")));
		sameParent("capture failure", before, parentState(env.project, [file]), [file]);
	});
}

async function carrierTamper(): Promise<void> {
	writeIsolationProfile(env, { enabled: true, apply: false, merge: "patch", backend: nativeBackend(), async: false, workerThreads: 0 });
	await sessions.open(cancelAll, async (rpc, files) => {
		const lane = "carrier-tamper";
		const file = "e2e-integration-tamper.txt";
		const { run } = await plannedRun(rpc, files, [laneFor(lane, file, "carrier-tamper-change")], [
			{ tasks: [{ name: lane, agent: "storm-implementer", task: "Write one file", say: childWrite(file) }] },
			{ wait: true },
		], { implementer: 1 });
		const patches = patchesOf(run);
		const native = patches.find(patch => patch.bytes > 0);
		check("tamper: a real native patch exists first", native !== undefined, JSON.stringify(patches.map(patch => patch.name)));
		const manifest = manifestOf(files, run.runId);
		const hash = property(property(property(manifest, "bundle"), "root"), "sha256");
		check("tamper: the sealed copy has a digest", typeof hash === "string", String(hash));
		if (native !== undefined) {
			writeFileSync(native.path, "TAMPERED-NATIVE\n");
			const view = await candidates(rpc);
			check("tamper: deleting the native bytes does not remove the candidate", candidateIds(view.text).length === 1, view.text.slice(0, 700));
		}
		if (typeof hash === "string") {
			const copy = ownedCopyOf(hash);
			check("tamper: Storm owns a copy of the bytes", copy !== undefined, copy ?? "not found");
			if (copy !== undefined) {
				const bytes = readFileSync(copy);
				bytes[0] = bytes[0] === 0 ? 1 : 0;
				writeFileSync(copy, bytes);
				const view = await candidates(rpc);
				check("tamper: a changed Storm copy is not silently trusted", view.text.includes("unknown") || view.text.includes("알 수 없음") || !view.text.includes("written"), view.text.slice(0, 900));
			}
		}
	});
}

// ── policy ─────────────────────────────────────────────────────────────────────────────────────────────────────

async function policyApplyOn(): Promise<void> {
	writeIsolationProfile(env, { enabled: true, apply: true, merge: "patch", backend: nativeBackend(), async: false, workerThreads: 0 });
	await sessions.open(cancelAll, async (rpc, files) => {
		const lane = "policy-apply-on";
		const file = "e2e-integration-apply-on.txt";
		const llm = new LlmCursor(env);
		const { frames } = await plannedRun(rpc, files, [laneFor(lane, file, "policy-apply-on-change")], [
			{ tasks: [{ name: lane, agent: "storm-implementer", task: "Write one file", say: childWrite(file) }] },
			{ wait: true },
		], { implementer: 1 });
		check("apply on: no child ran under an auto-apply profile", llm.of("child").length === 0, `children=${llm.of("child").length}`);
		check("apply on: the parent did not receive the file", !existsSync(join(env.project, file)), file);
		const said = stormTexts(frames).join("\n");
		check("apply on: the refusal names the isolation cause", said.includes("격리") || said.includes("isolation") || said.includes("apply"), said.slice(0, 700));
		check("apply on: the run still ended", frames.some(frame => frame.type === "agent_end"), "");
	});
	// The unmanaged host control: apply=true really moves the parent when Storm is not loaded at all.
	await sessions.open(cancelAll, async rpc => {
		const file = "e2e-host-auto-applied.txt";
		await rpc.turn(`E2E-STEPS ${JSON.stringify([{ task: ["task"], as: "HostApply", isolated: [true], say: childWrite(file) }])}`, 120_000);
		await until(() => (existsSync(join(env.project, file)) ? true : undefined), 30_000, "the host auto-apply control file").catch(() => false);
		check("apply on control: an unmanaged native run really writes the parent", existsSync(join(env.project, file)), file);
	}, ["--no-extensions"]);
}

async function policyLateAuto(): Promise<void> {
	const plugin = join(import.meta.dir, "integration-policy-plugin.ts");
	const log = join(env.work, "logs", "policy-late-auto.jsonl");
	const fake = join(env.work, "fake-ovnfs");
	writeFileSync(fake, "#!/bin/sh\nexit 1\n");
	Bun.spawnSync(["chmod", "755", fake]);
	env.childEnv.INTEGRATION_POLICY_LOG = log;
	env.childEnv.INTEGRATION_POLICY_MODE = "late-auto";
	env.childEnv.INTEGRATION_FAKE_OVNFS = fake;
	try {
		writeIsolationProfile(env, { enabled: true, apply: false, merge: "patch", backend: nativeBackend(), async: false, workerThreads: 0 });
		await sessions.open(cancelAll, async (rpc, files) => {
			const lane = "policy-late-auto";
			const file = "e2e-integration-late-auto.txt";
			const llm = new LlmCursor(env);
			const { frames } = await plannedRun(rpc, files, [laneFor(lane, file, "policy-late-auto-change")], [
				{ tasks: [{ name: lane, agent: "storm-implementer", task: "Write one file", say: childWrite(file) }] },
				{ wait: true },
			], { implementer: 1 });
			check("late auto: no child ran from the late backend switch", llm.of("child").length === 0, `children=${llm.of("child").length}`);
			check("late auto: the parent did not receive the file", !existsSync(join(env.project, file)), file);
			const said = stormTexts(frames).join("\n");
			check("late auto: the failure names ovnfs or the isolation boundary", said.includes("ovnfs") || said.includes("격리") || said.includes("isolation"), said.slice(0, 900));
		}, ["-e", plugin]);
	} finally {
		delete env.childEnv.INTEGRATION_POLICY_LOG;
		delete env.childEnv.INTEGRATION_POLICY_MODE;
		delete env.childEnv.INTEGRATION_FAKE_OVNFS;
	}
	const lines = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>) : [];
	const hook = lines.find(line => line.event === "before_subagent_spawn");
	if (hook === undefined) console.log(`GATE policy-late-auto: the spawn was refused before the probe ran (expected on the blocked stock profile, log=${log})`);
	if (hook !== undefined) {
		const before = property(hook, "before");
		const after = property(hook, "after");
		check("late auto: the hook saw the explicit native backend", property(before, "backend") !== "auto", String(property(before, "backend")));
		check("late auto: the probe changed the backend after Storm's hook", property(after, "backend") === "auto", String(property(after, "backend")));
		check("late auto: the probe changed ovnfs.path after the same hook", property(after, "ovnfsPath") === fake, String(property(after, "ovnfsPath")));
		check("late auto: the scoped Settings identity is the director's live session scope", property(hook, "directorSettingsSame") === true && property(hook, "scopedIsGlobal") === false, JSON.stringify({ same: property(hook, "directorSettingsSame"), global: property(hook, "scopedIsGlobal") }));
	}
}

async function policyAba(): Promise<void> {
	const plugin = join(import.meta.dir, "integration-policy-plugin.ts");
	const log = join(env.work, "logs", "policy-aba.jsonl");
	env.childEnv.INTEGRATION_POLICY_LOG = log;
	env.childEnv.INTEGRATION_POLICY_MODE = "aba";
	try {
		writeIsolationProfile(env, { enabled: true, apply: false, merge: "patch", backend: nativeBackend(), async: false, workerThreads: 0 });
		await sessions.open(cancelAll, async (rpc, files) => {
			const lane = "policy-aba";
			const file = "e2e-integration-aba.txt";
			const llm = new LlmCursor(env);
			await plannedRun(rpc, files, [laneFor(lane, file, "policy-aba-change")], [
				{ tasks: [{ name: lane, agent: "storm-implementer", task: "Write one file", say: childWrite(file) }] },
				{ wait: true },
			], { implementer: 1 });
			check("apply ABA: the parent was not changed", !existsSync(join(env.project, file)), file);
			check("apply ABA: the live change was observed before the child was authorized", llm.of("child").length === 0, `children=${llm.of("child").length}`);
		}, ["-e", plugin]);
	} finally {
		delete env.childEnv.INTEGRATION_POLICY_LOG;
		delete env.childEnv.INTEGRATION_POLICY_MODE;
	}
	const lines = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>) : [];
	const hook = lines.find(line => line.event === "before_subagent_spawn");
	if (hook === undefined) console.log(`GATE policy-aba: the spawn was refused before the probe ran (log=${log})`);
	if (hook !== undefined) {
		check("apply ABA: the hook read apply off before and after the ABA", property(property(hook, "before"), "apply") === false && property(property(hook, "after"), "apply") === false, JSON.stringify({ before: property(property(hook, "before"), "apply"), after: property(property(hook, "after"), "apply") }));
	}
}

// ── write / preimage / conflict ───────────────────────────────────────────────────────────────────────────────

function seedCommitted(project: string, file: string, text: string): void {
	writeFileSync(join(project, file), text);
	gitAt(project, ["add", "--", file]);
	gitAt(project, ["commit", "-qm", `integration fixture ${file}`]);
}

async function writeDirtyPreimage(): Promise<void> {
	writeIsolationProfile(env, { enabled: true, apply: false, merge: "patch", backend: nativeBackend(), async: false, workerThreads: 0 });
	const file = "e2e-integration-dirty.txt";
	const staged = "e2e-integration-staged.txt";
	const untracked = "e2e-integration-untracked.txt";
	seedCommitted(env.project, file, "base line\n");
	seedCommitted(env.project, staged, "staged base\n");
	writeFileSync(join(env.project, file), "base line\nWIP line\n");
	writeFileSync(join(env.project, staged), "staged base\nSTAGED WIP\n");
	gitAt(env.project, ["add", "--", staged]);
	writeFileSync(join(env.project, untracked), "UNTRACKED WIP\n");
	const before = parentState(env.project, [file, staged, untracked]);
	await sessions.open(cancelAll, async (rpc, files) => {
		const lane = "write-dirty";
		const run = await plannedRun(rpc, files, [laneFor(lane, file, "write-dirty-change")], [
			{ tasks: [{ name: lane, agent: "storm-implementer", task: "Append one line", say: shellCommand(`printf 'CHILD LINE\\n' >> ${file}`) }] },
			{ wait: true },
			{ storm: { action: "candidates" } },
			{ storm: { action: "integrate", candidateIds: "$candidates" } },
		], { implementer: 1 });
		const after = parentState(env.project, [file, staged, untracked]);
		check("dirty preimage: the child's line was applied on top of the user's WIP", readFileSync(join(env.project, file), "utf8") === "base line\nWIP line\nCHILD LINE\n", JSON.stringify(readFileSync(join(env.project, file), "utf8")));
		check("dirty preimage: the staged bytes on another file are preserved", readFileSync(join(env.project, staged), "utf8") === "staged base\nSTAGED WIP\n", "staged");
		check("dirty preimage: the untracked file is preserved", readFileSync(join(env.project, untracked), "utf8") === "UNTRACKED WIP\n", "untracked");
		check("dirty preimage: the target status still records the touched WIP and the untouched entries", after.status.includes(file) && after.status.includes(staged) && after.status.includes(untracked), after.status);
		check("dirty preimage: HEAD did not move", before.head === after.head, `${before.head} -> ${after.head}`);
		check("dirty preimage: the index bytes are unchanged", before.index === after.index, "index");
		check("dirty preimage: the staged index entry is unchanged", before.indexEntries === after.indexEntries, after.indexEntries.slice(0, 300));
		const view = stormTexts(run.frames).join("\n");
		check("dirty preimage: the candidates view still names the exact candidate", candidateIds(view).length === 1, view.slice(0, 700));
	});
}

async function writeCleanDelete(): Promise<void> {
	writeIsolationProfile(env, { enabled: true, apply: false, merge: "patch", backend: nativeBackend(), async: false, workerThreads: 0 });
	const file = "e2e-integration-delete-clean.txt";
	seedCommitted(env.project, file, "delete me cleanly\n");
	const before = parentState(env.project, [file]);
	await sessions.open(cancelAll, async (rpc, files) => {
		const lane = "write-delete-clean";
		await plannedRun(rpc, files, [laneFor(lane, file, "write-delete-clean-change")], [
			{ tasks: [{ name: lane, agent: "storm-implementer", task: "Delete the clean file", say: shellCommand(`rm -f ${file}`) }] },
			{ wait: true },
			{ storm: { action: "candidates" } },
			{ storm: { action: "integrate", candidateIds: "$candidates" } },
		], { implementer: 1 });
		const after = parentState(env.project, [file]);
		check("clean delete: the tracked file is gone from the working tree", !existsSync(join(env.project, file)), file);
		check("clean delete: HEAD did not move", before.head === after.head, `${before.head} -> ${after.head}`);
		check("clean delete: the index bytes did not change", before.index === after.index, "index");
		check("clean delete: the index entry is still the committed one (no staging)", before.indexEntries === after.indexEntries, after.indexEntries.slice(0, 300));
		check("clean delete: the status records only the working-tree deletion", after.status.includes(file), after.status);
	});
}

async function writeDirtyDeleteRefusal(): Promise<void> {
	writeIsolationProfile(env, { enabled: true, apply: false, merge: "patch", backend: nativeBackend(), async: false, workerThreads: 0 });
	const dirty = "e2e-integration-delete-dirty.txt";
	const untracked = "e2e-integration-delete-untracked.txt";
	seedCommitted(env.project, dirty, "delete me\n");
	writeFileSync(join(env.project, dirty), "delete me\nWIP KEEP\n");
	writeFileSync(join(env.project, untracked), "UNTRACKED KEEP\n");
	const before = parentState(env.project, [dirty, untracked]);
	await sessions.open(cancelAll, async (rpc, files) => {
		const lane = "write-delete-dirty";
		const run = await plannedRun(rpc, files, [laneFor(lane, dirty, "write-delete-dirty-change")], [
			{ tasks: [{ name: lane, agent: "storm-implementer", task: "Delete touched files", say: shellCommand(`rm -f ${dirty} ${untracked}`) }] },
			{ wait: true },
			{ storm: { action: "candidates" } },
			{ storm: { action: "integrate", candidateIds: "$candidates" } },
		], { implementer: 1 });
		const after = parentState(env.project, [dirty, untracked]);
		check("dirty delete: the dirty tracked file was not deleted", existsSync(join(env.project, dirty)) && readFileSync(join(env.project, dirty), "utf8") === "delete me\nWIP KEEP\n", "dirty");
		check("dirty delete: the untracked file was not deleted", existsSync(join(env.project, untracked)) && readFileSync(join(env.project, untracked), "utf8") === "UNTRACKED KEEP\n", "untracked");
		sameParent("dirty delete", before, after, [dirty, untracked]);
		const view = stormTexts(run.frames).join("\n");
		check("dirty delete: the refusal is not reported as written", !/written/i.test(view), view.slice(0, 700));
	});
}

async function writeModeOnly(): Promise<void> {
	writeIsolationProfile(env, { enabled: true, apply: false, merge: "patch", backend: nativeBackend(), async: false, workerThreads: 0 });
	const file = "e2e-integration-mode.sh";
	seedCommitted(env.project, file, "echo mode\n");
	const before = statSync(join(env.project, file)).mode;
	await sessions.open(cancelAll, async (rpc, files) => {
		const lane = "write-mode";
		const run = await plannedRun(rpc, files, [laneFor(lane, file, "write-mode-change")], [
			{ tasks: [{ name: lane, agent: "storm-implementer", task: "Change only the mode", say: shellCommand(`chmod +x ${file}`) }] },
			{ wait: true },
			{ storm: { action: "candidates" } },
			{ storm: { action: "integrate", candidateIds: "$candidates" } },
		], { implementer: 1 });
		const after = statSync(join(env.project, file)).mode;
		check("mode only: the executable bit was not changed", (before & 0o111) === (after & 0o111), `${before.toString(8)} -> ${after.toString(8)}`);
		check("mode only: the bytes are unchanged", readFileSync(join(env.project, file), "utf8") === "echo mode\n", "file");
		const view = stormTexts(run.frames).join("\n");
		check("mode only: the unsupported entry is not reported as written", !/written/i.test(view), view.slice(0, 700));
	});
}

async function writeMovedHead(): Promise<void> {
	writeIsolationProfile(env, { enabled: true, apply: false, merge: "patch", backend: nativeBackend(), async: false, workerThreads: 0 });
	const target = "e2e-integration-moved-head-target.txt";
	const unrelated = "e2e-integration-moved-head-unrelated.txt";
	seedCommitted(env.project, target, "target base\n");
	seedCommitted(env.project, unrelated, "unrelated base\n");
	const before = parentState(env.project, [target, unrelated]);
	await sessions.open(cancelAll, async (rpc, files) => {
		const lane = "write-moved-head";
		await plannedRun(rpc, files, [laneFor(lane, target, "write-moved-head-change")], [
			{ tasks: [{ name: lane, agent: "storm-implementer", task: "Append to the target", say: shellCommand(`printf 'CHILD TARGET\\n' >> ${target}`) }] },
			{ wait: true },
			// An unrelated parent commit after the child captured: not a touched-path drift.
			{ bash: `printf 'UNRELATED MOVED\\n' >> ${unrelated} && git add -- ${unrelated} && git commit -qm 'integration unrelated head move'` },
			{ storm: { action: "candidates" } },
			{ storm: { action: "integrate", candidateIds: "$candidates" } },
		], { implementer: 1 });
		const after = parentState(env.project, [target, unrelated]);
		check("moved HEAD: the unrelated parent commit landed", after.head !== before.head && readFileSync(join(env.project, unrelated), "utf8").includes("UNRELATED MOVED"), `${before.head} -> ${after.head}`);
		check("moved HEAD: the touched file still received the candidate change", readFileSync(join(env.project, target), "utf8") === "target base\nCHILD TARGET\n", JSON.stringify(readFileSync(join(env.project, target), "utf8")));
		check("moved HEAD: the candidate did not rewrite the unrelated file", readFileSync(join(env.project, unrelated), "utf8") === "unrelated base\nUNRELATED MOVED\n", "unrelated");
	});
}

async function writeSameFileConflict(): Promise<void> {
	writeIsolationProfile(env, { enabled: true, apply: false, merge: "patch", backend: nativeBackend(), async: false, workerThreads: 0 });
	const file = "e2e-integration-conflict.txt";
	seedCommitted(env.project, file, "line one\nline two\nline three\n");
	await sessions.open(cancelAll, async (rpc, files) => {
		const lanes = ["write-conflict-a", "write-conflict-b"];
		const run = await plannedRun(rpc, files, lanes.map((lane, index) => laneFor(lane, file, `write-conflict-${index}`)), [
			{
				tasks: lanes.map((lane, index) => ({
					name: lane,
					agent: "storm-implementer",
					task: "Append a distinct line",
					say: shellCommand(`printf '${index === 0 ? "A" : "B"} LINE\\\\n' >> ${file}`),
				})),
			},
			{ wait: true },
			{ storm: { action: "candidates" } },
			{ storm: { action: "integrate", candidateIds: "$candidates" } },
		], { implementer: 2 });
		const content = readFileSync(join(env.project, file), "utf8");
		check("same-file conflict: at most one candidate changed the file", content.includes("A LINE") !== content.includes("B LINE"), JSON.stringify(content));
		check("same-file conflict: the file still has its committed lines", content.startsWith("line one\nline two\nline three\n"), JSON.stringify(content));
		const view = stormTexts(run.frames).join("\n");
		check("same-file conflict: the candidates view keeps both IDs", candidateIds(view).length === 2, view.slice(0, 700));
	});
}

async function writeSameAddConflict(): Promise<void> {
	writeIsolationProfile(env, { enabled: true, apply: false, merge: "patch", backend: nativeBackend(), async: false, workerThreads: 0 });
	const file = "e2e-integration-same-add.txt";
	await sessions.open(cancelAll, async (rpc, files) => {
		const lanes = ["write-add-a", "write-add-b"];
		const run = await plannedRun(rpc, files, lanes.map((lane, index) => laneFor(lane, file, `write-add-${index}`)), [
			{
				tasks: lanes.map((lane, index) => ({
					name: lane,
					agent: "storm-implementer",
					task: "Add the same file",
					say: shellCommand(`printf '${index === 0 ? "A" : "B"} ADD\\\\n' > ${file}`),
				})),
			},
			{ wait: true },
			{ storm: { action: "candidates" } },
			{ storm: { action: "integrate", candidateIds: "$candidates" } },
		], { implementer: 2 });
		const content = existsSync(join(env.project, file)) ? readFileSync(join(env.project, file), "utf8") : "";
		check("same add: exactly one candidate's postimage is present", content === "A ADD\n" || content === "B ADD\n", JSON.stringify(content));
		const view = stormTexts(run.frames).join("\n");
		check("same add: the candidates view still names both", candidateIds(view).length === 2, view.slice(0, 700));
	});
}

async function writeBinary(): Promise<void> {
	writeIsolationProfile(env, { enabled: true, apply: false, merge: "patch", backend: nativeBackend(), async: false, workerThreads: 0 });
	const file = "e2e-integration-bin.dat";
	seedCommitted(env.project, file, "BINARY BASE\n");
	const expected = Buffer.from([0, 1, 2, 255, 66, 73, 78, 65, 82, 89, 10]);
	const encoded = expected.toString("base64");
	await sessions.open(cancelAll, async (rpc, files) => {
		const lane = "write-binary";
		await plannedRun(rpc, files, [laneFor(lane, file, "write-binary-change")], [
			{ tasks: [{ name: lane, agent: "storm-implementer", task: "Replace binary", say: shellCommand(`printf '${encoded}' | base64 -d > ${file}`) }] },
			{ wait: true },
			{ storm: { action: "candidates" } },
			{ storm: { action: "integrate", candidateIds: "$candidates" } },
		], { implementer: 1 });
		const actual = readFileSync(join(env.project, file));
		check("binary modification: the exact full-index bytes landed", actual.equals(expected), `${actual.toString("hex")} != ${expected.toString("hex")}`);
	});
}

async function writeUnsupported(): Promise<void> {
	writeIsolationProfile(env, { enabled: true, apply: false, merge: "patch", backend: nativeBackend(), async: false, workerThreads: 0 });
	const oldFile = "e2e-integration-rename-old.txt";
	const newFile = "e2e-integration-rename-new.txt";
	seedCommitted(env.project, oldFile, "rename me\n");
	await sessions.open(cancelAll, async (rpc, files) => {
		const lane = "write-rename";
		const run = await plannedRun(rpc, files, [laneFor(lane, oldFile, "write-rename-change")], [
			{ tasks: [{ name: lane, agent: "storm-implementer", task: "Rename a file", say: shellCommand(`git mv ${oldFile} ${newFile}`) }] },
			{ wait: true },
			{ storm: { action: "candidates" } },
			{ storm: { action: "integrate", candidateIds: "$candidates" } },
		], { implementer: 1 });
		check("rename: the old path is untouched", existsSync(join(env.project, oldFile)) && readFileSync(join(env.project, oldFile), "utf8") === "rename me\n", "old");
		check("rename: the new path was not created", !existsSync(join(env.project, newFile)), "new");
		const view = stormTexts(run.frames).join("\n");
		check("rename: the unsupported entry is not reported as written", !/written/i.test(view), view.slice(0, 700));
	});
}

// ── judgment ───────────────────────────────────────────────────────────────────────────────────────────────────

async function judgmentNeedIntegrated(): Promise<void> {
	writeIsolationProfile(env, { enabled: true, apply: false, merge: "patch", backend: nativeBackend(), async: false, workerThreads: 0 });
	const producerFile = "e2e-integration-need-producer.txt";
	const preFile = "e2e-integration-need-pre.txt";
	const postFile = "e2e-integration-need-post.txt";
	const producer = "need-producer";
	const pre = "need-consumer-pre";
	const post = "need-consumer-post";
	await sessions.open(cancelAll, async (rpc, files) => {
		const lanes: ContractLane[] = [
			{ name: producer, kind: "code", files: [producerFile], isolationReason: REASON, results: [requiredResult("need-producer-change", "change", `producer wrote ${producerFile}`, { path: producerFile, contains: "storm child change" })] },
			{ name: pre, kind: "code", files: [preFile], dependsOn: [{ lane: producer, need: "integrated" }], results: [requiredResult("need-pre-change", "change", `pre consumer wrote ${preFile}`, { path: preFile, contains: "storm child change" })] },
			{ name: post, kind: "code", files: [postFile], dependsOn: [{ lane: producer, need: "integrated" }], results: [requiredResult("need-post-change", "change", `post consumer wrote ${postFile}`, { path: postFile, contains: "storm child change" })] },
		];
		const run = await plannedRun(rpc, files, lanes, [
			{ tasks: [{ name: producer, agent: "storm-implementer", task: "Write the producer file", say: childWrite(producerFile) }] },
			{ wait: true },
			{ tasks: [{ name: pre, agent: "storm-implementer", task: "Read the producer", say: childWrite(preFile) }] },
			{ storm: { action: "candidates" } },
			{ storm: { action: "integrate", candidateIds: "$candidates" } },
			{ tasks: [{ name: post, agent: "storm-implementer", task: "Read the integrated producer", say: childWrite(postFile) }] },
			{ wait: true },
		], { implementer: 3 });
		check("need integrated: the pre-integration consumer did not run", !existsSync(join(env.project, preFile)), preFile);
		check("need integrated: the producer landed", readFileSync(join(env.project, producerFile), "utf8") === "storm child change\n", "producer");
		check("need integrated: the post-integration consumer ran and wrote its file", existsSync(join(env.project, postFile)), postFile);
		const spawned = (run.run.spawns ?? []).filter(spawn => spawn.lane === post && spawn.outcome !== "blocked");
		check("need integrated: the post consumer has a recorded spawn", spawned.length === 1, JSON.stringify((run.run.spawns ?? []).map(spawn => [spawn.lane, spawn.outcome])));
	});
}

async function judgmentAccepted(): Promise<void> {
	writeIsolationProfile(env, { enabled: true, apply: false, merge: "patch", backend: nativeBackend(), async: false, workerThreads: 0 });
	const file = "e2e-integration-judged.txt";
	await sessions.open(cancelAll, async (rpc, files) => {
		const lane = "judgment-change";
		const result = requiredResult("judgment-change-result", "change", `the isolated lane wrote ${file}`, { path: file, contains: "storm child change" });
		const run = await plannedRun(rpc, files, [{ name: lane, kind: "code", files: [file], isolationReason: REASON, results: [result] }], [
			{ tasks: [{ name: lane, agent: "storm-implementer", task: "Write one file", say: childWrite(file) }] },
			{ wait: true },
			{ storm: { action: "candidates" } },
			{ storm: { action: "integrate", candidateIds: "$candidates" } },
		], { implementer: 1 });
		const row = (run.run.results ?? []).find(candidate => candidate.id === "judgment-change-result");
		check("judgment: the row was accepted only after the exact write", row?.state === "accepted", JSON.stringify(row ?? null));
		check("judgment: the target holds the reviewed bytes", readFileSync(join(env.project, file), "utf8") === "storm child change\n", "file");
	});
}

async function judgmentOutside(): Promise<void> {
	writeIsolationProfile(env, { enabled: true, apply: false, merge: "patch", backend: nativeBackend(), async: false, workerThreads: 0 });
	const file = "e2e-integration-outside.txt";
	seedCommitted(env.project, file, "outside base\n");
	const before = parentState(env.project, [file]);
	await sessions.open(cancelAll, async (rpc, files) => {
		const lane = "judgment-outside";
		const result = requiredResult("judgment-outside-result", "change", `the isolated lane wrote ${file}`, { path: file, contains: "storm child change" });
		const run = await plannedRun(rpc, files, [{ name: lane, kind: "code", files: [file], isolationReason: REASON, results: [result] }], [
			{ tasks: [{ name: lane, agent: "storm-implementer", task: "Write one file", say: childWrite(file) }] },
			{ wait: true },
			// The director's own write is the P7-style outside postimage: the candidate is not its origin.
			{ edit: file, content: "storm child change\n" },
			{ storm: { action: "candidates" } },
			{ storm: { action: "integrate", candidateIds: "$candidates" } },
		], { implementer: 1 });
		const after = parentState(env.project, [file]);
		check("judgment outside: the manual postimage is still present", readFileSync(join(env.project, file), "utf8") === "storm child change\n", "file");
		check("judgment outside: HEAD and the index did not move", before.head === after.head && before.index === after.index, `${before.head} -> ${after.head}`);
		const row = (run.run.results ?? []).find(candidate => candidate.id === "judgment-outside-result");
		check("judgment outside: a manually equal postimage is not an isolated acceptance", row?.state !== "accepted", JSON.stringify(row ?? null));
		const records = journalAt(files.sessionDir, run.run.runId);
		check("judgment outside: a manifest exists but the write is not claimed as a receipt",
			manifestOf(files, run.run.runId) !== undefined && !records.some(row => row.kind === "receipt"),
			JSON.stringify(records.map(row => row.kind)));
	});
}

// ── main ─────────────────────────────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
	console.log(`GATE managed-private-launch: ${MANAGED_LAUNCH ? "enabled for this run" : "BLOCKED — stock 19.2.1 has no per-dispatch native backend proof; the carrier/writer/judgment scenarios are implemented but not run"}`);
	if (process.env.INTEGRATION_REQUIRE_GATES === "1" && !MANAGED_LAUNCH) check("managed-private-launch gate is cleared", false, "BLOCKED: no per-dispatch native backend proof on 19.2.1; enable only after the host seam");
	installProfile(env);
	seedFact(env.project);
	await suite.step(
		"fixture: approved team, automatic delegation off",
		async () => {
			const { teams } = await sessions.approve("off");
			check("the isolated profile has one approved team", teams === 1, `approvals=${teams}`);
		},
		120_000,
		{ always: true },
	);

	if (MANAGED_LAUNCH) {
	if (include("carrier", "carrier: sync root-only")) await suite.step("carrier: sync root-only", carrierSync, 300_000);
	if (include("carrier", "carrier: wait and push")) await suite.step("carrier: wait, push and push-then-empty-wait", carrierWaitPush, 420_000);
	if (include("carrier", "carrier: mixed batch")) await suite.step("carrier: mixed wait/push batch", carrierMixedBatch, 420_000);
	if (include("carrier", "carrier: empty")) await suite.step("carrier: confirmed empty is not root-only", carrierEmpty, 300_000);
	if (include("carrier", "carrier: nested")) await suite.step("carrier: root plus nested is kept only", carrierNested, 360_000);
	if (include("carrier", "carrier: branch")) await suite.step("carrier: branch is recovery, not a landing", carrierBranch, 300_000);
	if (include("carrier", "carrier: cancel")) await suite.step("carrier: cancel with a real patch", carrierCancel, 360_000);
	if (include("carrier", "carrier: failed yield")) await suite.step("carrier: failed yield keeps the captured patch", carrierFailure, 300_000);
	if (include("carrier", "carrier: capture failure")) await suite.step("carrier: capture failure keeps recovery only", carrierCaptureFailure, 360_000);
	if (include("carrier", "carrier: tamper")) await suite.step("carrier: native and Storm-copy tamper controls", carrierTamper, 300_000);
	if (include("policy", "policy: apply on")) await suite.step("policy: apply-on refusal and the unmanaged host control", policyApplyOn, 360_000);
	if (include("policy", "policy: late auto")) await suite.step("policy: backend read after the hook", policyLateAuto, 300_000);
	if (include("policy", "policy: aba")) await suite.step("policy: a relevant setting ABA is observed", policyAba, 300_000);
	if (include("write", "write: dirty preimage")) await suite.step("write: dirty touched preimage and preserved index", writeDirtyPreimage, 300_000);
	if (include("write", "write: dirty delete")) await suite.step("write: dirty and untracked delete refusal", writeDirtyDeleteRefusal, 300_000);
	if (include("write", "write: clean delete")) await suite.step("write: clean delete succeeds without staging", writeCleanDelete, 300_000);
	if (include("write", "write: mode only")) await suite.step("write: mode-only change is refused", writeModeOnly, 300_000);
	if (include("write", "write: moved head")) await suite.step("write: unrelated moved HEAD does not conflict", writeMovedHead, 360_000);
	if (include("write", "write: same-file conflict")) await suite.step("write: same-file disjoint hunk conflicts", writeSameFileConflict, 360_000);
	if (include("write", "write: same add")) await suite.step("write: same-name add conflicts", writeSameAddConflict, 360_000);
	if (include("write", "write: binary")) await suite.step("write: full-index binary modification", writeBinary, 300_000);
	if (include("write", "write: unsupported")) await suite.step("write: rename is refused whole", writeUnsupported, 300_000);
	if (include("judgment", "judgment: accepted")) await suite.step("judgment: an integrated change can be accepted", judgmentAccepted, 300_000);
	if (include("judgment", "judgment: need integrated")) await suite.step("judgment: a strict integrated consumer waits for the receipt", judgmentNeedIntegrated, 420_000);
	if (include("judgment", "judgment: outside")) await suite.step("judgment: an outside equal postimage is unattributed", judgmentOutside, 300_000);
	} else {
		console.log("GATE carrier/write/judgment: BLOCKED — stock 19.2.1 has no per-dispatch native backend proof; set INTEGRATION_MANAGED_LAUNCH=1 only after the host seam. The policy refusal controls below still run.");
	}

	if (SCALE) {
		console.log("GATE scale-16: not-run — E2E_SCALE=1 was set, but the real 16-lane/pooled measurement is still a coordinator release decision; run it separately with the main-thread control profile.");
		console.log("GATE scale-100: not-run — no deterministic 100-candidate fixture is wired into this run; use the approved host-event fixture plus the real subset.");
	} else {
		console.log("GATE scale-16: not-run — set E2E_SCALE=1 to run the 16-lane main-thread control and the default pooled stop.");
		console.log("GATE scale-100: not-run — set E2E_SCALE=1 with the approved 100-candidate fixture.");
	}
	await suite.step("omp exit codes", async () => {
		check("every omp session exited 0", sessions.exitCodes.length > 0 && sessions.exitCodes.every(code => code === 0), `exit=${sessions.exitCodes.join(",")}`);
	});
}

const server = await startFakeLlm(env);
let code = 1;
try {
	await main();
} catch (error) {
	check("harness", false, error instanceof Error ? (error.stack ?? error.message) : String(error));
} finally {
	server.kill();
	await server.exited;
	code = suite.finish();
}
process.exit(code);
