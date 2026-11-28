#!/usr/bin/env bun
/**
 * 0.30.0 scale E2E: exactly N=4, 8 and 16 isolated implementers on the pinned omp, twice: the main-thread control
 * (`task.workerThreads: 0`) and omp's default pooled profile (no `task.workerThreads` override). Disposable HOME,
 * profile, Git repo, work dir and loopback port per mode/size; the scripted loopback provider is the only model.
 *
 * What this proof is allowed to claim:
 *   - configured concurrency is read back through `omp config list --json` (`task.maxConcurrency`,
 *     `task.workerThreads`) and the plan's declared workers; it is never used as the observed overlap;
 *   - actual overlap is measured from real child provider request intervals (the first request is held for
 *     `E2E-CHILD-DELAY`) and from real shell windows whose start/end milliseconds are written from inside each
 *     checkout;
 *   - every checkout claim is a durable `ChildEntryClaim` under
 *     `<profile>/agent/integration/v1/claims/<candidateId>.json`, is mapped to the worker admission claim
 *     (`<profile>/agent/storm/admissions/<key>.<attempt>.claim`), and the distinct `(device, inode)` pairs are counted
 *     while the checkouts still exist;
 *   - results are verified from the exact durable journal
 *     `<session>/state/integration/runs/<runId>/journal.jsonl`: every record is re-hashed and chained, every
 *     `payload.manifest` is re-digested with the product's canonical digest, its prepared admission and child claim
 *     must be byte-identical to their durable files, and every `bundle.root` / delta root object must exist at
 *     `<profile>/agent/integration/<objectKey>` with the exact byte count and SHA-256;
 *   - the parent HEAD, index, status and every lane path must be unchanged, and the journal must contain no selection,
 *     intent, step, receipt or fence-clear, because no `storm integrate` is run;
 *   - every worker admission is accounted for by a terminal `endedAt` and its worker claim, or by an exact recorded
 *     stop (`stop.reason`, `stop.at`) and no provider request, or (a failure) by a withdrawal with neither. The default
 *     pooled profile must show the actual `pooled-thread` stop; it is not inferred from `task.workerThreads`.
 *
 * Seam status at this commit: the combined private host binary built on 2026-11-28 (`/tmp/storm-host/omp-isolation-async`)
 * still needs X's exact native-slot fix. Its real sync run failed at child entry with
 * `SubagentEntryError: [storm:integration] 자식 작업 디렉터리나 슬롯 마운트를 확인하지 못했습니다`; the prepared
 * admission was rolled back and no claim, journal or object was written. This script therefore refuses to start a real
 * run unless `E2E_SCALE=1` **and** `E2E_SCALE_HOST=1` are both set, the second only after that fix is proved. It never
 * runs the slow baseline binary and never treats a stock-19.2.1 run (no guarded isolation) as a positive.
 *
 * Usage:
 *   ./node_modules/.bin/bun scripts/e2e/integration-scale.ts --self-check
 *   ./node_modules/.bin/bun scripts/e2e/integration-scale.ts          # prints gates; no omp, no model
 *   E2E_SCALE=1 E2E_SCALE_HOST=1 OMP_BIN=/absolute/fixed-omp ./node_modules/.bin/bun scripts/e2e/integration-scale.ts
 *
 * Selection and repeatable work dirs:
 *   E2E_SCALE_NS=4,16            subset of {4,8,16}; default all three
 *   E2E_SCALE_MODES=main,pool    subset of {main,pool}; default both
 *   E2E_SCALE_WORK_ROOT=<dir>    default `<tmp>/storm-e2e-scale`; the script always appends `<mode>-<n>`, so one gate
 *                                never overwrites another gate's logs. E2E_WORK itself is set per run, never shared.
 *   E2E_SCALE_PORT_BASE=21940    default; main uses +n, pool uses +100+n, so the six runs never share a port.
 *
 * `INTEGRATION_REQUIRE_GATES=1` exits 2 while the real-host scale gates remain NOT-RUN/BLOCKED (the F/pin convention).
 * A green run is only a green run for the gate that ran; no unrun mode is reported as passing.
 */
import { createHash } from "node:crypto";
import { createReadStream, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { Subprocess } from "bun";
import { canonicalJson, integrationCandidateId } from "../../src/runtime/integration-artifacts.ts";
import type { SealedCaptureManifest } from "../../src/runtime/integration-capture.ts";
import { captureManifestDigest } from "../../src/runtime/isolation-capture.ts";
import type { AdmissionKey } from "../../src/runtime/integration-admission.ts";
import type { RunRecord, RunResult } from "../../src/types.ts";
import { type E2eEnv, type Frame, type LlmEntry, LlmCursor, prepare, type Step, Suite, startFakeLlm } from "./harness.ts";
import { effectiveSettings, isolationProfileYaml, nativeBackend, type IsolationProfile } from "./integration-profile.ts";
import { installProfile, runRequest, Sessions } from "./phase1-kit.ts";

const NS = [4, 8, 16] as const;
type ScaleN = (typeof NS)[number];
const MODES = ["main", "pool"] as const;
type Mode = (typeof MODES)[number];

const LANE_REASON = "E2E 규모: 부모 작업 트리와 분리된 구현 체크아웃";
const FIRST_DELAY_MS = 10_000;
const SHELL_HOLD_MS = 5_000;
const RUN_TIMEOUT_MS = 420_000;
const JOURNAL_SCHEMA = "storm.integration-journal/v1";
const CANDIDATE = /^c1_[0-9a-f]{64}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const OBJECT_KEY = /^v1\/objects\/([0-9a-f]{64})$/u;
const KEY = /^[0-9a-f]{64}$/u;
const ATTEMPT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

const SCALE = process.env.E2E_SCALE === "1";
const HOST_READY = process.env.E2E_SCALE_HOST === "1";
const REQUIRE_GATES = process.env.INTEGRATION_REQUIRE_GATES === "1";
const SELF_CHECK_ONLY = process.argv.includes("--self-check") || (!SCALE && process.env.E2E_SCALE_SELFCHECK !== "0");

const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
const shq = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const stringOf = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const numberOf = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
const readJson = (file: string): unknown => {
	try {
		return JSON.parse(readFileSync(file, "utf8")) as unknown;
	} catch {
		return undefined;
	}
};
const textOf = (file: string): string => {
	try {
		return readFileSync(file, "utf8");
	} catch {
		return "";
	}
};
const realOr = (path: string): string => {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
};
const outside = (path: string, root: string): boolean => {
	const child = realOr(path);
	const parent = realOr(root);
	return child !== parent && !child.startsWith(`${parent}${sep}`);
};

// ── pure checks: intervals, inodes, work/port uniqueness ─────────────────────────────────────────

export interface Interval {
	readonly key: string;
	readonly start: number;
	readonly end: number;
}
export interface OverlapResult {
	readonly max: number;
	readonly at?: number;
	readonly keys: readonly string[];
}

/** Maximum number of intervals open at one instant; an end at t is processed before a start at t. */
export function maxOverlap(intervals: readonly Interval[]): OverlapResult {
	const events: Array<{ t: number; delta: 1 | -1; key: string }> = [];
	for (const interval of intervals) {
		if (!Number.isFinite(interval.start) || !Number.isFinite(interval.end) || interval.end <= interval.start) continue;
		events.push({ t: interval.start, delta: 1, key: interval.key }, { t: interval.end, delta: -1, key: interval.key });
	}
	events.sort((a, b) => a.t - b.t || a.delta - b.delta);
	const active = new Set<string>();
	let max = 0;
	let at: number | undefined;
	let keys: string[] = [];
	for (const event of events) {
		if (event.delta === 1) active.add(event.key);
		else active.delete(event.key);
		if (active.size > max) {
			max = active.size;
			at = event.t;
			keys = [...active].sort();
		}
	}
	return { max, ...(at === undefined ? {} : { at }), keys };
}

export interface CheckoutClaim {
	readonly path: string;
	readonly device: string;
	readonly inode: string;
	/** Where the claim was read: `worker-claim`, `entry-claim`, or `live`. */
	readonly source: string;
	readonly observedAt?: number;
}
export interface InodeAudit {
	readonly total: number;
	readonly distinct: number;
	readonly duplicates: ReadonlyArray<{ device: string; inode: string; paths: readonly string[] }>;
	readonly paths: readonly string[];
}
export function auditInodes(claims: readonly CheckoutClaim[]): InodeAudit {
	const byInode = new Map<string, CheckoutClaim[]>();
	for (const claim of claims) {
		if (!DIGIT.test(claim.device) || !DIGIT.test(claim.inode)) continue;
		const key = `${claim.device}:${claim.inode}`;
		byInode.set(key, [...(byInode.get(key) ?? []), claim]);
	}
	const duplicates = [...byInode.entries()]
		.filter(([, values]) => values.length > 1)
		.map(([key, values]) => {
			const [device, inode] = key.split(":");
			return { device: device ?? "", inode: inode ?? "", paths: [...new Set(values.map(value => value.path))].sort() };
		});
	return {
		total: claims.length,
		distinct: byInode.size,
		duplicates,
		paths: [...new Set(claims.map(claim => claim.path))].sort(),
	};
}
const DIGIT = /^\d+$/u;

export interface Combo {
	readonly mode: Mode;
	readonly n: ScaleN;
	readonly work: string;
	readonly port: number;
}
export function plannedCombos(root: string, portBase: number, modes: readonly Mode[] = MODES, ns: readonly ScaleN[] = NS): Combo[] {
	const combos: Combo[] = [];
	for (const mode of modes) {
		for (const n of ns) {
			combos.push({
				mode,
				n,
				work: join(resolve(root), `${mode}-${n}`),
				port: portBase + (mode === "pool" ? 100 : 0) + n,
			});
		}
	}
	return combos;
}
function parseSelection<T extends string | number>(raw: string | undefined, allowed: readonly T[], name: string): T[] {
	if (raw === undefined || raw.trim() === "") return [...allowed];
	const values: T[] = [];
	for (const piece of raw.split(",")) {
		const text = piece.trim();
		if (text === "") continue;
		const value = (typeof allowed[0] === "number" ? Number(text) : text) as T;
		if (!allowed.includes(value)) throw new Error(`${name}: ${text} is not one of ${allowed.join(",")}`);
		if (!values.includes(value)) values.push(value);
	}
	return values;
}

// ── parent snapshot (HEAD, index, status, lane images) ──────────────────────────────────────────

interface FileImage {
	readonly kind: "absent" | "file" | "other";
	readonly bytes?: number;
	readonly sha256?: string;
}
interface ParentSnapshot {
	readonly head: string;
	readonly index: string;
	readonly status: string;
	readonly images: Readonly<Record<string, FileImage>>;
}
function git(project: string, args: readonly string[]): string {
	const step = Bun.spawnSync(["git", "-C", project, ...args], { stdout: "pipe", stderr: "pipe" });
	if (step.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed (${step.exitCode}): ${step.stderr.toString()}`);
	return step.stdout.toString();
}
function imageOf(file: string): FileImage {
	try {
		const stat = lstatSync(file, { bigint: true });
		if (!stat.isFile() || stat.isSymbolicLink()) return { kind: "other" };
		const bytes = readFileSync(file);
		return { kind: "file", bytes: bytes.byteLength, sha256: sha256(bytes) };
	} catch {
		return { kind: "absent" };
	}
}
export function snapshotParent(project: string, files: readonly string[]): ParentSnapshot {
	return {
		head: git(project, ["rev-parse", "HEAD"]).trim(),
		index: git(project, ["ls-files", "-s"]),
		status: git(project, ["status", "--porcelain=v2", "--branch", "--untracked-files=all"]),
		images: Object.fromEntries(files.map(file => [file, imageOf(join(project, file))])),
	};
}
export function parentProblems(before: ParentSnapshot, after: ParentSnapshot): string[] {
	const problems: string[] = [];
	if (before.head !== after.head) problems.push(`HEAD moved ${before.head.slice(0, 12)} -> ${after.head.slice(0, 12)}`);
	if (before.index !== after.index) problems.push("index entries changed");
	if (before.status !== after.status) problems.push(`git status changed: ${after.status.trim().slice(0, 400)}`);
	for (const [file, image] of Object.entries(before.images)) {
		if (canonicalJson(image) !== canonicalJson(after.images[file])) problems.push(`${file} changed in the parent`);
	}
	return problems;
}

// ── exact object store and journal ──────────────────────────────────────────────────────────────

interface ObjectAudit {
	readonly refs: number;
	readonly digests: readonly string[];
	readonly problems: readonly string[];
}
function verifyObjects(agentDir: string, refs: readonly unknown[]): ObjectAudit {
	const store = join(agentDir, "integration");
	const objects = join(store, "v1", "objects");
	const problems: string[] = [];
	const seen = new Set<string>();
	let realObjects: string | undefined;
	try {
		realObjects = realpathSync(objects);
	} catch {
		problems.push("profile agent/integration/v1/objects is missing");
	}
	for (const raw of refs) {
		if (!isObject(raw)) {
			problems.push("an object reference is not an object");
			continue;
		}
		const schema = stringOf(raw.schema);
		const objectKey = stringOf(raw.objectKey);
		const digest = stringOf(raw.sha256);
		const bytes = numberOf(raw.bytes);
		if (schema !== "storm.integration-patch/v1") problems.push(`object schema ${String(schema)}`);
		if (digest === undefined || !DIGEST.test(digest)) {
			problems.push("object sha256 is not 64 lowercase hex");
			continue;
		}
		if (objectKey === undefined) {
			problems.push(`object reference ${digest} has no objectKey`);
			continue;
		}
		const match = OBJECT_KEY.exec(objectKey);
		if (match === null || match[1] !== digest) {
			problems.push(`objectKey ${objectKey} does not name ${digest}`);
			continue;
		}
		if (bytes === undefined || !Number.isSafeInteger(bytes) || bytes < 0) problems.push(`object ${digest} has no bounded byte count`);
		if (seen.has(digest)) continue;
		seen.add(digest);
		const file = join(store, objectKey);
		let stat;
		try {
			stat = lstatSync(file, { bigint: true });
		} catch {
			problems.push(`profile agent/integration/${objectKey} is missing`);
			continue;
		}
		if (!stat.isFile() || stat.isSymbolicLink()) {
			problems.push(`profile agent/integration/${objectKey} is not a regular file`);
			continue;
		}
		if (realObjects !== undefined && realOr(file) !== join(realObjects, digest)) {
			problems.push(`profile agent/integration/${objectKey} resolves outside the owned object store`);
			continue;
		}
		let content: Buffer;
		try {
			content = readFileSync(file);
		} catch {
			problems.push(`profile agent/integration/${objectKey} cannot be read`);
			continue;
		}
		if (bytes !== undefined && content.byteLength !== bytes) problems.push(`object ${digest} byte count ${content.byteLength} != ${bytes}`);
		if (sha256(content) !== digest) problems.push(`object ${digest} content digest differs`);
	}
	return { refs: refs.length, digests: [...seen].sort(), problems };
}

interface ManifestAudit {
	readonly candidateId: string;
	readonly lane: string;
	readonly childHandle: string;
	readonly digest: string;
	readonly objectKeys: readonly string[];
	readonly entries: number;
	readonly carrier: string;
	readonly problems: readonly string[];
}
interface JournalAudit {
	readonly file: string;
	readonly exists: boolean;
	readonly records: number;
	readonly kinds: Readonly<Record<string, number>>;
	readonly manifests: readonly ManifestAudit[];
	readonly problems: readonly string[];
	readonly objects: ObjectAudit;
}
function journalFileOf(sessionDir: string, runId: string): string {
	return join(sessionDir, "state", "integration", "runs", runId, "journal.jsonl");
}
function objectRefsOf(manifest: Record<string, unknown>): Array<Record<string, unknown>> {
	const refs: Array<Record<string, unknown>> = [];
	const bundle = isObject(manifest.bundle) ? manifest.bundle : undefined;
	if (bundle !== undefined && isObject(bundle.root)) refs.push(bundle.root);
	const recovery = isObject(manifest.recovery) ? manifest.recovery : undefined;
	const root = recovery !== undefined && isObject(recovery.root) ? recovery.root : undefined;
	const rootValue = root !== undefined && isObject(root.value) ? root.value : undefined;
	const rootCopy = rootValue !== undefined && isObject(rootValue.copy) ? rootValue.copy : undefined;
	if (rootCopy?.kind === "known" && isObject(rootCopy.value)) refs.push(rootCopy.value);
	const nested = recovery !== undefined && isObject(recovery.nested) ? recovery.nested : undefined;
	if (nested?.kind === "known" && Array.isArray(nested.value)) {
		for (const part of nested.value) {
			const copy = isObject(part) && isObject(part.copy) ? part.copy : undefined;
			if (copy?.kind === "known" && isObject(copy.value)) refs.push(copy.value);
		}
	}
	const delta = isObject(manifest.delta) ? manifest.delta : undefined;
	const deltaValue = delta?.kind === "known" && isObject(delta.value) ? delta.value : undefined;
	if (deltaValue !== undefined && isObject(deltaValue.root)) refs.push(deltaValue.root);
	const unique = new Map<string, Record<string, unknown>>();
	for (const ref of refs) {
		const key = stringOf(ref.objectKey);
		if (key !== undefined) unique.set(key, ref);
	}
	return [...unique.values()];
}

/**
 * Re-read the one durable journal and prove its chain, every manifest digest, the prepared admission and child claim
 * bytes, and every owned object. `expectedLanes` maps lane name -> lane-relative path. This never trusts a rendered
 * message, a path from prose, or a filename alone.
 */
export function verifyJournal(file: string, agentDir: string, runId: string, expectedLanes: ReadonlyMap<string, string>, projectRoot: string): JournalAudit {
	const problems: string[] = [];
	const kinds: Record<string, number> = {};
	const manifests: ManifestAudit[] = [];
	const allRefs: unknown[] = [];
	const exists = existsSync(file);
	if (!exists) {
		return { file, exists, records: 0, kinds, manifests, problems: [`journal does not exist at ${file}`], objects: verifyObjects(agentDir, []) };
	}
	const text = textOf(file);
	if (text === "") problems.push("journal is empty");
	const lines = text.split("\n");
	if (lines.at(-1) === "") lines.pop();
	let expectedSeq = 1;
	let expectedPrev = "";
	const candidates = new Set<string>();
	const lanes = new Set<string>();
	for (const [index, line] of lines.entries()) {
		if (line.trim() === "") {
			problems.push(`journal line ${index + 1} is blank`);
			continue;
		}
		let value: unknown;
		try {
			value = JSON.parse(line) as unknown;
		} catch {
			problems.push(`journal line ${index + 1} is not JSON`);
			continue;
		}
		if (!isObject(value) || value.schema !== JOURNAL_SCHEMA) {
			problems.push(`journal line ${index + 1} has a foreign schema`);
			continue;
		}
		if (value.seq !== expectedSeq) problems.push(`journal seq ${String(value.seq)} at line ${index + 1}, expected ${expectedSeq}`);
		if (value.prev !== expectedPrev) problems.push(`journal prev at seq ${String(value.seq)} does not match the prior record hash`);
		if (typeof value.at !== "number" || !Number.isFinite(value.at)) problems.push(`journal seq ${String(value.seq)} has no time`);
		const kind = stringOf(value.kind) ?? "(missing)";
		kinds[kind] = (kinds[kind] ?? 0) + 1;
		const base = { schema: value.schema, seq: value.seq, prev: value.prev, at: value.at, kind: value.kind, payload: value.payload };
		const hash = sha256(JSON.stringify(base));
		if (value.hash !== hash) problems.push(`journal seq ${String(value.seq)} hash does not match its payload`);
		expectedPrev = typeof value.hash === "string" ? value.hash : "";
		expectedSeq = (typeof value.seq === "number" ? value.seq : expectedSeq) + 1;
		if (kind !== "manifest") continue;
		const payload = isObject(value.payload) ? value.payload : undefined;
		const manifest = payload !== undefined && isObject(payload.manifest) ? payload.manifest : undefined;
		if (manifest === undefined) {
			problems.push(`journal seq ${String(value.seq)} is a manifest without payload.manifest`);
			continue;
		}
		const local: string[] = [];
		if (manifest.schema !== "storm.integration-capture/v1") local.push("manifest schema");
		const admission = isObject(manifest.admission) ? manifest.admission : undefined;
		const key = admission !== undefined && isObject(admission.key) ? admission.key : undefined;
		const candidateId = admission !== undefined ? stringOf(admission.candidateId) : undefined;
		const dispatch = key !== undefined ? stringOf(key.dispatch) : undefined;
		const keyRun = key !== undefined ? stringOf(key.runId) : undefined;
		if (key === undefined || key.schema !== "storm.integration-admission/v1" || dispatch === undefined || keyRun === undefined) {
			local.push("admission key");
		} else if (keyRun !== runId) {
			local.push(`admission run ${keyRun} != ${runId}`);
		}
		if (candidateId === undefined || !CANDIDATE.test(candidateId)) {
			local.push("candidate id");
		} else {
			if (candidates.has(candidateId)) local.push(`candidate ${candidateId} appears twice`);
			candidates.add(candidateId);
			if (key !== undefined && dispatch !== undefined && keyRun !== undefined) {
				const expected = integrationCandidateId(key as unknown as AdmissionKey);
				if (expected !== candidateId) local.push(`candidate id is not derived from its admission key (${expected})`);
			}
		}
		const subject = admission !== undefined && isObject(admission.subject) ? admission.subject : undefined;
		const lane = subject?.kind === "planned" ? stringOf(subject.lane) : undefined;
		if (lane === undefined || !expectedLanes.has(lane)) local.push(`manifest lane ${String(lane)} is not an expected plan lane`);
		else if (lanes.has(lane)) local.push(`lane ${lane} has more than one manifest`);
		else lanes.add(lane);
		const policy = admission !== undefined && isObject(admission.policy) ? admission.policy : undefined;
		if (policy?.apply !== false || policy?.merge !== "patch" || typeof policy?.backendSetting !== "string" || policy.backendSetting === "auto") {
			local.push("admission policy is not explicit-native / apply-off / patch");
		}
		const target = admission !== undefined && isObject(admission.target) ? admission.target : undefined;
		const authorized = target !== undefined && isObject(target.authorizedRoot) ? target.authorizedRoot : undefined;
		if (authorized === undefined || typeof authorized.canonicalPath !== "string") local.push("admission target root");
		else if (realOr(authorized.canonicalPath) !== realOr(projectRoot)) local.push(`admission target ${authorized.canonicalPath} is not the disposable project`);
		const item = admission !== undefined && isObject(admission.item) ? admission.item : undefined;
		const childHandle = item !== undefined ? stringOf(item.handle) : undefined;
		if (childHandle === undefined || childHandle === "") local.push("admission task item handle");
		const workerAdmission = admission !== undefined && isObject(admission.workerAdmission) ? admission.workerAdmission : undefined;
		const workerKey = workerAdmission !== undefined ? stringOf(workerAdmission.key) : undefined;
		const workerAttempt = workerAdmission !== undefined ? stringOf(workerAdmission.attempt) : undefined;
		if (workerKey === undefined || !KEY.test(workerKey) || workerAttempt === undefined || !ATTEMPT.test(workerAttempt)) {
			local.push("admission worker key/attempt");
		} else {
			const preparedFile = join(agentDir, "integration", "v1", "prepared", workerKey, `${workerAttempt}.json`);
			const prepared = readJson(preparedFile);
			if (prepared === undefined) local.push(`prepared admission ${preparedFile} is missing`);
			else if (canonicalJson(prepared) !== canonicalJson(admission)) local.push("prepared admission differs from payload.manifest.admission");
		}
		const childClaim = isObject(manifest.childClaim) ? manifest.childClaim : undefined;
		const claimValue = childClaim?.kind === "known" && isObject(childClaim.value) ? childClaim.value : undefined;
		if (claimValue === undefined) local.push("manifest childClaim is not a known claim");
		else {
			if (candidateId !== undefined) {
				const claimFile = join(agentDir, "integration", "v1", "claims", `${candidateId}.json`);
				const claim = readJson(claimFile);
				if (claim === undefined) local.push(`entry claim ${claimFile} is missing`);
				else if (canonicalJson(claim) !== canonicalJson(claimValue)) local.push("entry claim differs from payload.manifest.childClaim");
			}
			if (claimValue.candidateId !== candidateId) local.push("entry claim candidate id differs from the admission");
			if (workerAttempt !== undefined && claimValue.workerAttempt !== workerAttempt) local.push("entry claim worker attempt differs from the admission");
			if (childHandle !== undefined && claimValue.childHandle !== childHandle) local.push("entry claim child handle differs from the admission item");
			if (key !== undefined && canonicalJson(claimValue.key) !== canonicalJson(key)) local.push("entry claim admission key differs from the manifest key");
			const checkout = isObject(claimValue.checkout) ? claimValue.checkout : undefined;
			if (checkout === undefined || typeof checkout.canonicalPath !== "string" || !DIGIT.test(String(checkout.device)) || !DIGIT.test(String(checkout.inode))) {
				local.push("entry claim checkout identity");
			}
		}
		const terminal = isObject(manifest.terminal) ? manifest.terminal : undefined;
		const terminalValue = terminal?.kind === "known" && isObject(terminal.value) ? terminal.value : undefined;
		const outcome = terminalValue !== undefined && isObject(terminalValue.outcome) ? terminalValue.outcome : undefined;
		if (terminalValue === undefined || outcome?.kind !== "known" || outcome.value !== "success") local.push("terminal is not a known success");
		const carrier = terminalValue !== undefined ? stringOf(terminalValue.carrier) : undefined;
		if (carrier !== "sync") local.push(`terminal carrier ${String(carrier)} is not sync`);
		const bundle = isObject(manifest.bundle) ? manifest.bundle : undefined;
		const delta = isObject(manifest.delta) ? manifest.delta : undefined;
		const deltaValue = delta?.kind === "known" && isObject(delta.value) ? delta.value : undefined;
		if (bundle?.kind !== "root-only") local.push(`bundle ${String(bundle?.kind)} is not root-only`);
		if (bundle !== undefined && isObject(bundle.root) && isObject(deltaValue) && isObject(deltaValue.root)) {
			if (stringOf(bundle.root.sha256) !== stringOf(deltaValue.root.sha256)) local.push("bundle root and delta root are different copies");
		}
		const refs = objectRefsOf(manifest);
		if (refs.length === 0) local.push("manifest names no owned object");
		allRefs.push(...refs);
		let entries: number | undefined;
		if (deltaValue === undefined) {
			local.push("delta is not known");
		} else if (!Array.isArray(deltaValue.entries)) {
			local.push("delta entries are not an array");
		} else {
			entries = deltaValue.entries.length;
			if (entries < 1) local.push("delta has no entries");
			const expected = lane === undefined ? undefined : expectedLanes.get(lane);
			if (expected !== undefined) {
				const found = deltaValue.entries.some(entry => isObject(entry) && stringOf(entry.targetPath) === expected);
				if (!found) local.push(`delta does not name ${expected}`);
			}
		}
		const digest = stringOf(manifest.digest);
		if (digest === undefined || !DIGEST.test(digest)) {
			local.push("manifest digest is not 64 lowercase hex");
		} else {
			const without = { ...manifest };
			delete without.digest;
			const recomputed = captureManifestDigest(without as unknown as Omit<SealedCaptureManifest, "digest">);
			if (recomputed !== digest) local.push(`manifest digest ${digest} does not re-digest to ${recomputed}`);
		}
		manifests.push({
			candidateId: candidateId ?? "",
			lane: lane ?? "",
			childHandle: childHandle ?? "",
			digest: digest ?? "",
			objectKeys: refs.map(ref => stringOf(ref.objectKey) ?? ""),
			entries: entries ?? 0,
			carrier: carrier ?? "",
			problems: local,
		});
		problems.push(...local.map(problem => `candidate ${candidateId ?? "?"}: ${problem}`));
	}
	const objects = verifyObjects(agentDir, allRefs);
	problems.push(...objects.problems);
	return { file, exists, records: lines.length, kinds, manifests, problems, objects };
}

// ── worker admissions, stops and checkout claims ───────────────────────────────────────────────

interface LiveCheckout {
	readonly path: string;
	readonly device: string;
	readonly inode: string;
	readonly observedAt: number;
}
interface LiveObservation {
	readonly checkouts: ReadonlyMap<string, LiveCheckout>;
}
interface LaneAdmission {
	readonly childId: string;
	readonly lane: string;
	readonly attempt: string;
	readonly key: string;
	readonly state: "terminal" | "stopped" | "withdrawn" | "unknown";
	readonly stopReason?: string;
	readonly stopAt?: number;
	readonly workerClaim?: string;
	readonly integrationClaim?: string;
	readonly integrationCheckout?: LiveCheckout;
	readonly problems: readonly string[];
}
interface AdmissionAudit {
	readonly admitted: number;
	readonly terminal: number;
	readonly stopped: number;
	readonly withdrawn: number;
	readonly unknown: number;
	readonly workerClaims: number;
	readonly integrationClaims: number;
	readonly stops: readonly LaneAdmission[];
	readonly lanes: readonly LaneAdmission[];
	/** Distinct checkouts across durable entry claims; one entry claim per worker attempt. */
	readonly inodes: InodeAudit;
	/** Distinct checkouts across worker admission claims; one claim per worker attempt. */
	readonly workerInodes: InodeAudit;
	readonly problems: readonly string[];
}
function identityOf(path: string, now: number): LiveCheckout | undefined {
	try {
		const canonical = realpathSync(path);
		const stat = statSync(canonical, { bigint: true });
		if (!stat.isDirectory()) return undefined;
		return { path: canonical, device: stat.dev.toString(), inode: stat.ino.toString(), observedAt: now };
	} catch {
		return undefined;
	}
}
function verifyAdmissions(input: { readonly agentDir: string; readonly project: string }, runId: string, live: LiveObservation): AdmissionAudit {
	const env = input;
	const problems: string[] = [];
	const admissionsDir = join(env.agentDir, "storm", "admissions");
	const claimsDir = join(env.agentDir, "integration", "v1", "claims");
	const records: Array<Record<string, unknown>> = [];
	for (const name of readdirIf(admissionsDir)) {
		if (!name.endsWith(".json")) continue;
		const value = readJson(join(admissionsDir, name));
		if (!isObject(value) || value.schema !== "storm.worker-admission/v2" || value.runId !== runId) continue;
		records.push(value);
	}
	const entryClaims = new Map<string, { candidateId: string; checkout?: LiveCheckout; live?: LiveCheckout }>();
	for (const name of readdirIf(claimsDir)) {
		if (!name.endsWith(".json")) continue;
		const value = readJson(join(claimsDir, name));
		if (!isObject(value) || !CANDIDATE.test(name.slice(0, -5))) continue;
		const candidateId = name.slice(0, -5);
		const attempt = stringOf(value.workerAttempt);
		const handle = stringOf(value.childHandle);
		if (attempt === undefined || handle === undefined) continue;
		const checkoutRaw = isObject(value.checkout) ? value.checkout : undefined;
		const checkoutPath = checkoutRaw !== undefined ? stringOf(checkoutRaw.canonicalPath) : undefined;
		const claimCheckout =
			checkoutPath !== undefined && checkoutRaw !== undefined && DIGIT.test(String(checkoutRaw.device)) && DIGIT.test(String(checkoutRaw.inode))
				? { path: realOr(checkoutPath), device: String(checkoutRaw.device), inode: String(checkoutRaw.inode), observedAt: Date.now() }
				: undefined;
		const liveCheckout = checkoutPath === undefined ? undefined : live.checkouts.get(realOr(checkoutPath)) ?? identityOf(checkoutPath, Date.now());
		entryClaims.set(`${handle}\0${attempt}`, {
			candidateId,
			...(claimCheckout === undefined ? {} : { checkout: claimCheckout }),
			...(liveCheckout === undefined ? {} : { live: liveCheckout }),
		});
	}
	const lanes: LaneAdmission[] = [];
	const entryInodeClaims: CheckoutClaim[] = [];
	const workerInodeClaims: CheckoutClaim[] = [];
	for (const record of records) {
		const local: string[] = [];
		const key = stringOf(record.key) ?? "";
		const attempt = stringOf(record.attempt) ?? "";
		const childId = stringOf(record.childId) ?? "";
		const lane = stringOf(record.lane) ?? "";
		const policy = isObject(record.policy) ? record.policy : undefined;
		if (key === "" || !KEY.test(key)) local.push("worker key");
		if (attempt === "" || !ATTEMPT.test(attempt)) local.push("attempt");
		if (childId === "") local.push("child id");
		if (lane === "") local.push("lane");
		if (policy?.kind !== "private") local.push("policy is not private");
		const stop = isObject(record.stop) ? record.stop : undefined;
		const stopReason = stop !== undefined ? stringOf(stop.reason) : undefined;
		const stopAt = stop !== undefined ? numberOf(stop.at) : undefined;
		const endedAt = numberOf(record.endedAt);
		const revokedAt = numberOf(record.revokedAt);
		const state: LaneAdmission["state"] = stop !== undefined ? "stopped" : endedAt !== undefined ? "terminal" : revokedAt !== undefined ? "withdrawn" : "unknown";
		if (state === "unknown") local.push("no endedAt, stop or revokedAt");
		if (state === "withdrawn") local.push("revoked without a terminal turn or a recorded stop");
		let workerClaim: LiveCheckout | undefined;
		const claimFile = join(admissionsDir, `${key}.${attempt}.claim`);
		const claim = readJson(claimFile);
		if (claim === undefined) {
			if (state === "terminal") local.push("worker admission claim is missing");
		} else if (!isObject(claim) || claim.schema !== "storm.worker-claim/v1" || typeof claim.checkout !== "string") {
			local.push("worker admission claim is malformed");
		} else {
			workerClaim = live.checkouts.get(realOr(claim.checkout)) ?? identityOf(claim.checkout, Date.now());
			if (workerClaim === undefined) local.push("worker claim checkout cannot be read");
			else if (!outside(workerClaim.path, env.project)) local.push("worker claim checkout is the parent tree");
			if (workerClaim !== undefined) workerInodeClaims.push({ ...workerClaim, source: "worker-claim" });
		}
		const entry = entryClaims.get(`${childId}\0${attempt}`);
		if (entry === undefined) {
			if (state === "terminal") local.push("no durable integration entry claim");
		} else {
			if (entry.checkout === undefined) local.push("entry claim has no readable checkout");
			else {
				if (!outside(entry.checkout.path, env.project)) local.push("entry claim checkout is the parent tree");
				entryInodeClaims.push({ ...entry.checkout, source: "entry-claim" });
			}
			if (entry.live !== undefined && entry.checkout !== undefined &&
				(entry.live.device !== entry.checkout.device || entry.live.inode !== entry.checkout.inode)) {
				local.push("entry claim inode changed since it was written");
			}
			if (workerClaim !== undefined && entry.checkout !== undefined && workerClaim.device !== entry.checkout.device &&
				workerClaim.inode !== entry.checkout.inode) {
				local.push("worker claim and entry claim name different checkouts");
			}
		}
		lanes.push({
			childId,
			lane,
			attempt,
			key,
			state,
			...(stopReason === undefined ? {} : { stopReason }),
			...(stopAt === undefined ? {} : { stopAt }),
			...(workerClaim === undefined ? {} : { workerClaim: workerClaim.path }),
			...(entry === undefined ? {} : { integrationClaim: entry.candidateId }),
			...(entry?.checkout === undefined ? {} : { integrationCheckout: entry.checkout }),
			problems: local,
		});
		problems.push(...local.map(problem => `${lane || childId || "?"}: ${problem}`));
	}
	const unique = new Map<string, LaneAdmission>();
	for (const lane of lanes) unique.set(`${lane.lane}\0${lane.childId}`, lane);
	const final = [...unique.values()];
	const inodes = auditInodes(entryInodeClaims);
	const workerInodes = auditInodes(workerInodeClaims);
	const integrationClaims = final.filter(lane => lane.integrationClaim !== undefined).length;
	const workerClaims = final.filter(lane => lane.workerClaim !== undefined).length;
	return {
		admitted: records.length,
		terminal: final.filter(lane => lane.state === "terminal").length,
		stopped: final.filter(lane => lane.state === "stopped").length,
		withdrawn: final.filter(lane => lane.state === "withdrawn").length,
		unknown: final.filter(lane => lane.state === "unknown").length,
		workerClaims,
		integrationClaims,
		stops: final.filter(lane => lane.state === "stopped"),
		lanes: final,
		inodes,
		workerInodes,
		problems,
	};
}
function readdirIf(dir: string): string[] {
	try {
		return readdirSync(dir);
	} catch {
		return [];
	}
}

// ── observed intervals ─────────────────────────────────────────────────────────────────────────

interface ProviderMeasurement {
	readonly lanes: readonly string[];
	readonly missing: readonly string[];
	readonly ambiguous: readonly string[];
	readonly intervals: readonly Interval[];
	readonly spread: number;
	readonly overlap: OverlapResult;
}
/**
 * The exact lane marker has no terminator of its own: `scale-main-16-1` is a prefix of `scale-main-16-10`.
 * A plain `includes` therefore attributes one child's first request to a shorter lane and later finds its second
 * request at the 15 s shell completion, which is not a provider interval at all. Require the marker to end at a
 * non-digit (or the string end), and take the earliest matching request per lane.
 */
function laneOfChildRequest(text: string, lanes: readonly string[]): string | undefined {
	const found: string[] = [];
	for (const lane of lanes) {
		const marker = `E2E-SCALE-LANE:${lane}`;
		for (let at = text.indexOf(marker); at >= 0; at = text.indexOf(marker, at + marker.length)) {
			const next = text[at + marker.length];
			if (next === undefined || !DIGIT.test(next)) {
				found.push(lane);
				break;
			}
		}
	}
	return found.length === 1 ? found[0] : undefined;
}
function providerMeasurement(entries: readonly LlmEntry[], lanes: readonly string[], delayMs: number): ProviderMeasurement {
	const first = new Map<string, number>();
	const ambiguous = new Set<string>();
	for (const entry of entries) {
		if (entry.who !== "child") continue;
		const lane = laneOfChildRequest(entry.lastUser, lanes);
		if (lane === undefined) {
			const candidates = lanes.filter(candidate => entry.lastUser.includes(`E2E-SCALE-LANE:${candidate}`));
			if (candidates.length > 1) for (const candidate of candidates) ambiguous.add(candidate);
			continue;
		}
		const known = first.get(lane);
		if (known === undefined || entry.ts < known) first.set(lane, entry.ts);
	}
	const starts = [...first.values()].sort((a, b) => a - b);
	const intervals = [...first.entries()].sort((a, b) => a[1] - b[1]).map(([key, start]) => ({ key, start, end: start + delayMs }));
	return {
		lanes: [...first.keys()].sort(),
		missing: lanes.filter(lane => !first.has(lane)),
		ambiguous: [...ambiguous].sort(),
		intervals,
		spread: starts.length < 2 ? 0 : (starts.at(-1) ?? 0) - (starts[0] ?? 0),
		overlap: maxOverlap(intervals),
	};
}
interface ShellMeasurement {
	readonly lanes: readonly string[];
	readonly missing: readonly string[];
	readonly cwds: readonly string[];
	readonly intervals: readonly Interval[];
	readonly overlap: OverlapResult;
}
function shellMeasurement(dir: string, lanes: readonly string[]): ShellMeasurement {
	const intervals: Interval[] = [];
	const cwds: string[] = [];
	const missing: string[] = [];
	for (const lane of lanes) {
		const start = Number(textOf(join(dir, `start-${lane}`)).trim());
		const end = Number(textOf(join(dir, `end-${lane}`)).trim());
		const cwd = textOf(join(dir, `cwd-${lane}`)).trim();
		if (!Number.isFinite(start) || !Number.isFinite(end) || start <= 0 || end <= start) {
			missing.push(lane);
			continue;
		}
		intervals.push({ key: lane, start, end });
		if (cwd !== "") cwds.push(realOr(cwd));
	}
	return { lanes: intervals.map(interval => interval.key), missing, cwds, intervals, overlap: maxOverlap(intervals) };
}

// ── e2e meter: actual home of each child ────────────────────────────────────────────────────────

interface MeterAudit {
	readonly present: boolean;
	readonly threads: Readonly<Record<string, "main" | "pooled">>;
	readonly children: Readonly<Record<string, readonly string[]>>;
	readonly mainChildren: readonly string[];
	readonly pooledChildren: readonly string[];
	readonly unknownChildren: readonly string[];
}
function meterAudit(dir: string, childIds: readonly string[]): MeterAudit {
	const threads: Record<string, "main" | "pooled"> = {};
	for (const name of readdirIf(dir)) {
		if (!name.startsWith("boot-") || !name.endsWith(".json")) continue;
		const value = readJson(join(dir, name));
		if (!isObject(value) || typeof value.pid !== "number" || typeof value.threadId !== "number") continue;
		threads[`${value.pid}:${value.threadId}`] = value.main === true ? "main" : "pooled";
	}
	const children: Record<string, Set<string>> = {};
	const present = Object.keys(threads).length > 0;
	for (const name of readdirIf(dir)) {
		if (!name.startsWith("hooks-") || !name.endsWith(".jsonl")) continue;
		const match = /^hooks-(\d+)-(\d+)-/u.exec(name);
		if (match === null) continue;
		const thread = `${match[1]}:${match[2]}`;
		for (const line of textOf(join(dir, name)).split("\n")) {
			if (!line.startsWith("{")) continue;
			let value: unknown;
			try {
				value = JSON.parse(line) as unknown;
			} catch {
				continue;
			}
			if (!isObject(value) || typeof value.a !== "string" || value.a === "") continue;
			if (!childIds.includes(value.a)) continue;
			(children[value.a] ??= new Set()).add(thread);
		}
	}
	const result: Record<string, string[]> = {};
	const mainChildren: string[] = [];
	const pooledChildren: string[] = [];
	const unknownChildren: string[] = [];
	for (const id of childIds) {
		const set = children[id];
		if (set === undefined || set.size === 0) {
			unknownChildren.push(id);
			continue;
		}
		const list = [...set].sort();
		result[id] = list;
		for (const thread of list) {
			if (threads[thread] === "pooled" && !pooledChildren.includes(id)) pooledChildren.push(id);
			if (threads[thread] === "main" && !mainChildren.includes(id)) mainChildren.push(id);
		}
	}
	return { present, threads, children: result, mainChildren, pooledChildren, unknownChildren };
}

// ── live observation while the run is open ─────────────────────────────────────────────────────

function snapshotLive(env: E2eEnv, checkouts: Map<string, LiveCheckout>): void {
	const now = Date.now();
	const admissionsDir = join(env.agentDir, "storm", "admissions");
	for (const name of readdirIf(admissionsDir)) {
		if (!name.endsWith(".claim")) continue;
		const value = readJson(join(admissionsDir, name));
		if (!isObject(value) || typeof value.checkout !== "string") continue;
		const identity = identityOf(value.checkout, now);
		if (identity !== undefined) checkouts.set(identity.path, identity);
	}
	const claimsDir = join(env.agentDir, "integration", "v1", "claims");
	for (const name of readdirIf(claimsDir)) {
		if (!name.endsWith(".json")) continue;
		const value = readJson(join(claimsDir, name));
		const checkout = isObject(value) && isObject(value.checkout) ? value.checkout : undefined;
		const path = checkout !== undefined ? stringOf(checkout.canonicalPath) : undefined;
		if (path === undefined) continue;
		const identity = identityOf(path, now);
		if (identity !== undefined) checkouts.set(identity.path, identity);
	}
}
/** Poll the durable claims while the run is open, so a checkout reclaimed at session close still has a live inode. */
async function observeDuring(turn: Promise<unknown>, env: E2eEnv, maxMs: number): Promise<LiveObservation> {
	const checkouts = new Map<string, LiveCheckout>();
	let done = false;
	void turn.then(() => { done = true; }, () => { done = true; });
	const deadline = Date.now() + maxMs;
	while (!done && Date.now() < deadline) {
		snapshotLive(env, checkouts);
		await Bun.sleep(100);
	}
	snapshotLive(env, checkouts);
	return { checkouts };
}

// ── scenario ──────────────────────────────────────────────────────────────────────────────────

function nowMsCommand(): string {
	return `perl -MTime::HiRes=time -e 'printf("%d\\n", time*1000)'`;
}
function probeCommand(markerDir: string, lane: string, file: string, literal: string): string {
	return [
		`pwd -P > ${shq(join(markerDir, `cwd-${lane}`))}`,
		`${nowMsCommand()} > ${shq(join(markerDir, `start-${lane}`))}`,
		`sleep ${SHELL_HOLD_MS / 1000}`,
		`printf '%s\\n' ${shq(literal)} > ${shq(file)}`,
		`${nowMsCommand()} > ${shq(join(markerDir, `end-${lane}`))}`,
	].join("; ");
}
function frameText(frame: Frame): string {
	if (!isObject(frame.result) || !("content" in frame.result)) return "";
	const content = frame.result.content;
	return Array.isArray(content) ? content.map(part => (isObject(part) && typeof part.text === "string" ? part.text : "")).join("\n") : "";
}
async function sha256File(file: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
	return hash.digest("hex");
}
function setting(settings: Record<string, { value?: unknown }>, key: string): unknown {
	return settings[key]?.value;
}
function resultProblems(results: readonly RunResult[] | undefined, lanes: readonly string[]): string[] {
	const problems: string[] = [];
	const rows = results ?? [];
	for (const lane of lanes) {
		const id = `${lane}-artifact`;
		if (!rows.some(row => row.id === id && row.lane === lane)) problems.push(`${id} is not a row of lane ${lane}`);
	}
	for (const row of rows) {
		if (row.id.endsWith("-artifact") && row.state === "accepted" && row.contract?.kind === "change") {
			problems.push(`${row.id} was accepted as a parent-tree change`);
		}
	}
	return problems;
}

interface ScaleFacts {
	readonly mode: Mode;
	readonly n: ScaleN;
	readonly work: string;
	readonly port: number;
	readonly omp: string;
	readonly ompVersion: string;
	readonly binarySha256: string;
	readonly host: string;
	readonly profile: IsolationProfile;
	readonly configured: Readonly<Record<string, unknown>>;
	readonly runId?: string;
	readonly planWorkers?: number;
	readonly admitted?: number;
	readonly terminal?: number;
	readonly stopped?: number;
	readonly withdrawn?: number;
	readonly workerClaims?: number;
	readonly integrationClaims?: number;
	readonly distinctCheckoutInodes?: number;
	readonly providerChildren?: number;
	readonly providerOverlap?: number;
	readonly providerSpreadMs?: number;
	readonly shellOverlap?: number;
	readonly manifests?: number;
	readonly objectDigests?: readonly string[];
	readonly parentProblems?: readonly string[];
	readonly meter?: MeterAudit;
	readonly problems: readonly string[];
}

async function scenario(
	env: E2eEnv,
	combo: Combo,
	suite: Suite,
	settings: Record<string, { value?: unknown }>,
	profile: IsolationProfile,
	sessions: Sessions,
	facts: { current: ScaleFacts },
): Promise<void> {
	const check = suite.check.bind(suite);
	const n = combo.n;
	const lanes = Array.from({ length: n }, (_, index) => `scale-${combo.mode}-${n}-${index}`);
	const laneFiles = new Map(lanes.map(lane => [lane, `${lane}.txt`] as const));
	const markerDir = join(env.work, "markers", `${combo.mode}-${n}`);
	rmSync(markerDir, { recursive: true, force: true });
	mkdirSync(markerDir, { recursive: true });
	const beforeParent = snapshotParent(env.project, [...laneFiles.values()]);
	const configured = {
		requestedWorkers: n,
		planWorkers: undefined as number | undefined,
		taskMaxConcurrency: setting(settings, "task.maxConcurrency"),
		taskWorkerThreads: setting(settings, "task.workerThreads"),
		async: setting(settings, "async.enabled"),
		backend: setting(settings, "isolation.backend"),
	};
	check(
		"the configured profile enables isolation with auto-apply off and patch merge",
		setting(settings, "task.isolation.enabled") === true &&
			setting(settings, "task.isolation.apply") === false &&
			setting(settings, "task.isolation.merge") === "patch",
		JSON.stringify({
			enabled: setting(settings, "task.isolation.enabled"),
			apply: setting(settings, "task.isolation.apply"),
			merge: setting(settings, "task.isolation.merge"),
		}),
	);
	check(
		"the configured backend is explicit, never auto, and ovnfs.path is unset",
		typeof configured.backend === "string" && configured.backend !== "auto" && setting(settings, "ovnfs.path") === undefined,
		JSON.stringify({ backend: configured.backend, ovnfs: setting(settings, "ovnfs.path") }),
	);
	check(
		combo.mode === "main" ? "the main-thread control reports task.workerThreads 0" : "the default pooled profile reports task.workerThreads 4",
		setting(settings, "task.workerThreads") === (combo.mode === "main" ? 0 : 4),
		`workerThreads=${String(setting(settings, "task.workerThreads"))}`,
	);
	check("sync delivery is off, so the only carrier is the typed sync result", setting(settings, "async.enabled") === false, `async=${String(setting(settings, "async.enabled"))}`);
	check(
		"the model endpoint is the loopback fake and not a real provider",
		readFileSync(join(env.agentDir, "models.yml"), "utf8").includes(`http://127.0.0.1:${env.port}/v1`),
		`port=${env.port}`,
	);
	check("the project has no git remote and the disposable HOME is below the work dir", env.home.startsWith(env.work) && git(env.project, ["remote"]).trim() === "", `home=${env.home}`);

	await sessions.open(() => undefined, async (rpc, files) => {
		const before = files.runIds();
		const llm = new LlmCursor(env);
		const steps: Step[] = [
			{
				storm: {
					action: "plan",
					plan: {
						lanes: lanes.map((lane, index) => ({
							name: lane,
							kind: "code",
							role: "implementer",
							files: [laneFiles.get(lane)!],
							isolationReason: LANE_REASON,
							results: [{ id: `${lane}-artifact`, kind: "artifact", criterion: `${laneFiles.get(lane)} is in the retained patch`, path: laneFiles.get(lane), contains: `LANE-${index}` }],
						})),
					},
				},
			},
			{
				tasks: lanes.map((lane, index) => ({
					name: lane,
					agent: "storm-implementer",
					task: `Implement ${lane} independently E2E-SCALE-LANE:${lane}`,
					say: `E2E-CHILD-DELAY ${FIRST_DELAY_MS} E2E-CHILD-SH ${Buffer.from(probeCommand(markerDir, lane, laneFiles.get(lane)!, `LANE-${index}`), "utf8").toString("base64")} E2E-CHILD-CLAIM ${lane}-done`,
				})),
			},
			{ wait: true },
		];
		const turn = rpc.turn(runRequest(steps, 1), RUN_TIMEOUT_MS);
		const live = await observeDuring(turn, env, RUN_TIMEOUT_MS);
		await turn;
		const run: RunRecord = await files.finishedRun(before, 240_000);
		const afterParent = snapshotParent(env.project, [...laneFiles.values()]);
		const admissionAudit = verifyAdmissions({ agentDir: env.agentDir, project: env.project }, run.runId, live);
		const journal = verifyJournal(journalFileOf(files.sessionDir, run.runId), env.agentDir, run.runId, laneFiles, env.project);
		const provider = providerMeasurement(llm.of("child"), lanes, FIRST_DELAY_MS);
		const shell = shellMeasurement(markerDir, lanes);
		const meter = meterAudit(join(env.work, "meter"), admissionAudit.lanes.map(lane => lane.childId));
		const parentIssue = parentProblems(beforeParent, afterParent);
		const resultIssue = resultProblems(run.results, lanes);
		const planWorkers = typeof run.plan?.workers?.implementer === "number" ? run.plan.workers.implementer : undefined;
		const planLanes = run.plan?.lanes.map(lane => lane.name) ?? [];
		const spawns = run.spawns.filter(spawn => spawn.lane !== undefined && lanes.includes(spawn.lane));
		const routed = spawns.filter(spawn => spawn.outcome !== "blocked");
		const spawnStops = spawns.filter(spawn => spawn.stop?.reason === "pooled-thread");
		const entryErrors = [...rpc.frames.filter(frame => frame.type === "tool_execution_end" && frame.toolName === "task").map(frameText).join("\n").matchAll(/SubagentEntryError:[^\n]*/gu)].map(match => match[0]);
		const problems: string[] = [];
		problems.push(...admissionAudit.problems, ...journal.problems, ...parentIssue, ...resultIssue);
		configured.planWorkers = planWorkers;

		check("the plan has exactly the requested lanes", planLanes.length === n && lanes.every(lane => planLanes.includes(lane)), `plan=${JSON.stringify(planLanes)}`);
		check("every requested lane was placed by Storm", routed.length === n && lanes.every(lane => routed.some(spawn => spawn.lane === lane)), JSON.stringify(routed.map(spawn => [spawn.spawnKey, spawn.lane, spawn.outcome, spawn.stop?.reason])));
		check("the parent HEAD, index, status and every lane path are unchanged without selection", parentIssue.length === 0, parentIssue.join("; "));
		check("no lane file exists in the parent tree", [...laneFiles.values()].every(file => !existsSync(join(env.project, file))), [...laneFiles.values()].join(","));
		check("the journal is at the exact run path and every record re-hashes in chain", journal.exists && journal.problems.length === 0 && journal.records > 0, journal.problems.join("; ") || journal.file);
		check(
			"the journal contains no selection, intent, step, receipt or fence-clear record",
			["selection", "intent", "step", "receipt", "fence-clear"].every(kind => journal.kinds[kind] === undefined),
			JSON.stringify(journal.kinds),
		);
		check(
			"every worker admission is accounted for by a terminal turn, a recorded stop, or a withdrawal",
			admissionAudit.admitted === n && admissionAudit.terminal + admissionAudit.stopped + admissionAudit.withdrawn + admissionAudit.unknown === n,
			`admitted=${admissionAudit.admitted} terminal=${admissionAudit.terminal} stopped=${admissionAudit.stopped} withdrawn=${admissionAudit.withdrawn} unknown=${admissionAudit.unknown}`,
		);
		check(
			"no worker admission was withdrawn without a terminal turn or a recorded stop",
			admissionAudit.withdrawn === 0 && admissionAudit.unknown === 0,
			admissionAudit.lanes.filter(lane => lane.state === "withdrawn" || lane.state === "unknown").map(lane => `${lane.lane}:${lane.state}:${lane.problems.join(",")}`).join(" | ") + (entryErrors[0] === undefined ? "" : `; ${entryErrors[0]}`),
		);
		check(
			"every recorded stop has the pooled-thread cause and is mirrored on the director's spawn row",
			admissionAudit.stops.every(lane => lane.stopReason === "pooled-thread" && lane.stopAt !== undefined) &&
				spawnStops.length === admissionAudit.stopped,
			`admission=${JSON.stringify(admissionAudit.stops.map(lane => [lane.lane, lane.stopReason, lane.stopAt]))} spawn=${JSON.stringify(spawnStops.map(spawn => [spawn.lane, spawn.stop?.reason, spawn.stop?.at]))}`,
		);
		const terminalLanes = admissionAudit.lanes.filter(lane => lane.state === "terminal");
		const expectedRunning = admissionAudit.stopped === 0 ? n : admissionAudit.terminal;
		check(
			"each terminal worker has a durable entry claim and a worker admission claim",
			terminalLanes.length === admissionAudit.terminal && terminalLanes.every(lane => lane.integrationClaim !== undefined && lane.workerClaim !== undefined),
			`terminal=${admissionAudit.terminal} missing=${JSON.stringify(terminalLanes.filter(lane => lane.integrationClaim === undefined || lane.workerClaim === undefined).map(lane => lane.lane))}`,
		);
		const admissionByLane = new Map(terminalLanes.map(lane => [lane.lane, lane] as const));
		check(
			"each manifest is bound to its lane's durable admission and exact candidate",
			journal.manifests.length === terminalLanes.length &&
				journal.manifests.every(manifest => {
					const lane = admissionByLane.get(manifest.lane);
					return lane !== undefined && lane.integrationClaim === manifest.candidateId && lane.childId === manifest.childHandle;
				}),
			JSON.stringify(journal.manifests.map(manifest => [manifest.lane, manifest.candidateId, manifest.childHandle])),
		);
		check(
			"every terminal worker's checkout claim names a distinct real (device, inode) outside the parent",
			admissionAudit.inodes.total === admissionAudit.integrationClaims &&
				admissionAudit.inodes.duplicates.length === 0 &&
				admissionAudit.inodes.distinct === admissionAudit.inodes.total &&
				admissionAudit.inodes.paths.every(path => path !== "" && outside(path, env.project)),
			`entry=${admissionAudit.inodes.total}/${admissionAudit.inodes.distinct} worker=${admissionAudit.workerInodes.total}/${admissionAudit.workerInodes.distinct} duplicates=${JSON.stringify([...admissionAudit.inodes.duplicates, ...admissionAudit.workerInodes.duplicates])}`,
		);
		check(
			"every worker admission claim names a distinct real checkout",
			admissionAudit.workerInodes.total === admissionAudit.workerClaims &&
				admissionAudit.workerInodes.distinct === admissionAudit.workerInodes.total &&
				admissionAudit.workerInodes.duplicates.length === 0,
			`worker=${admissionAudit.workerInodes.total}/${admissionAudit.workerInodes.distinct} entry=${admissionAudit.inodes.total}/${admissionAudit.inodes.distinct}`,
		);
		check(
			"each terminal worker has exactly one root-only manifest whose delta names its lane file",
			journal.manifests.length === admissionAudit.terminal &&
				journal.manifests.every(manifest => manifest.problems.length === 0 && manifest.entries >= 1 && manifest.carrier === "sync"),
			`manifests=${journal.manifests.length} terminal=${admissionAudit.terminal} problems=${JSON.stringify(journal.manifests.map(manifest => [manifest.lane, manifest.problems]))}`,
		);
		check(
			"every manifest's owned object exists at the profile agent/integration/v1/objects/<sha256> with exact bytes",
			journal.objects.refs > 0 && journal.objects.digests.length > 0 && journal.objects.problems.length === 0,
			`refs=${journal.objects.refs} objects=${journal.objects.digests.length} problems=${journal.objects.problems.join("; ")}`,
		);
		const claimedCheckouts = terminalLanes.map(lane => lane.integrationCheckout?.path).filter((path): path is string => path !== undefined);
		check(
			"each terminal worker's shell ran in its claimed checkout",
			claimedCheckouts.length === expectedRunning && shell.cwds.length === expectedRunning && shell.cwds.every(cwd => claimedCheckouts.includes(cwd)),
			`claims=${JSON.stringify(claimedCheckouts)} shell=${JSON.stringify(shell.cwds)}`,
		);
		check(
			"the observed provider requests hold the running workers as simultaneous intervals on the offline endpoint",
			provider.overlap.max === expectedRunning && provider.lanes.length === expectedRunning && provider.missing.length === n - expectedRunning &&
				provider.ambiguous.length === 0 && (expectedRunning < 2 || provider.spread <= FIRST_DELAY_MS),
			`max=${provider.overlap.max} expected=${expectedRunning} lanes=${provider.lanes.length} spread=${provider.spread} hold=${FIRST_DELAY_MS} missing=${JSON.stringify(provider.missing)} ambiguous=${JSON.stringify(provider.ambiguous)} starts=${JSON.stringify(provider.intervals.map(interval => interval.start - (provider.intervals[0]?.start ?? 0)))}`,
		);
		check(
			"the observed shell windows physically overlap the running workers in distinct checkouts",
			shell.overlap.max === expectedRunning && shell.lanes.length === expectedRunning && shell.missing.length === n - expectedRunning &&
				new Set(shell.cwds).size === expectedRunning && shell.cwds.every(cwd => outside(cwd, env.project)),
			`max=${shell.overlap.max} expected=${expectedRunning} missing=${JSON.stringify(shell.missing)} cwds=${shell.cwds.length} distinct=${new Set(shell.cwds).size}`,
		);
		check(
			"the meter observed every child in a live Storm hook on a known thread",
			meter.present && meter.unknownChildren.length === 0,
			`present=${meter.present} main=${meter.mainChildren.length} pooled=${meter.pooledChildren.length} unknown=${JSON.stringify(meter.unknownChildren)}`,
		);
		if (combo.mode === "main") {
			check(
				"the main-thread control has N terminal admissions, N worker claims and no stop",
				admissionAudit.terminal === n && admissionAudit.workerClaims === n && admissionAudit.stopped === 0,
				`terminal=${admissionAudit.terminal} claims=${admissionAudit.workerClaims} stopped=${admissionAudit.stopped}`,
			);
			check("all N children were observed on the host main thread", meter.mainChildren.length === n && meter.pooledChildren.length === 0, `main=${meter.mainChildren.length} pooled=${JSON.stringify(meter.pooledChildren)}`);
		} else if (admissionAudit.stopped === 0) {
			check(
				"the default pool had no stop at this size: all N workers terminated and were claimed",
				admissionAudit.terminal === n && admissionAudit.workerClaims === n && admissionAudit.integrationClaims === n,
				`terminal=${admissionAudit.terminal} worker=${admissionAudit.workerClaims} entry=${admissionAudit.integrationClaims}`,
			);
			check("all N children were observed on the host main thread", meter.mainChildren.length === n && meter.pooledChildren.length === 0, `main=${meter.mainChildren.length} pooled=${JSON.stringify(meter.pooledChildren)}`);
		} else {
			check(
				"the default pool actually stopped workers at the observed pooled home, not by inference",
				admissionAudit.stopped > 0 && spawnStops.length === admissionAudit.stopped && meter.pooledChildren.length > 0,
				`stops=${admissionAudit.stopped} spawnStops=${spawnStops.length} pooledObserved=${JSON.stringify(meter.pooledChildren)} unknown=${JSON.stringify(meter.unknownChildren)}`,
			);
			check(
				"the stopped workers made no provider request and hold no entry claim",
				admissionAudit.stops.every(lane => lane.integrationClaim === undefined && lane.workerClaim === undefined) &&
					provider.missing.length >= admissionAudit.stopped,
				`stopClaims=${JSON.stringify(admissionAudit.stops.map(lane => [lane.lane, lane.integrationClaim ?? null, lane.workerClaim ?? null]))} providerMissing=${JSON.stringify(provider.missing)}`,
			);
			check(
				"actual overlap is below the requested N in the stopped pooled run",
				shell.overlap.max < n && provider.overlap.max < n,
				`requested=${n} shell=${shell.overlap.max} provider=${provider.overlap.max}`,
			);
		}
		check(
			"the measured overlap is distinguished from configured task.maxConcurrency/task.workerThreads/plan workers",
			provider.overlap.max > 0 && shell.overlap.max > 0,
			JSON.stringify({ configured, observed: { provider: provider.overlap.max, shell: shell.overlap.max } }),
		);
		facts.current = {
			mode: combo.mode,
			n,
			work: env.work,
			port: env.port,
			omp: env.omp,
			ompVersion: env.ompVersion,
			binarySha256: facts.current.binarySha256,
			host: process.platform,
			profile,
			configured,
			runId: run.runId,
			...(planWorkers === undefined ? {} : { planWorkers }),
			admitted: admissionAudit.admitted,
			terminal: admissionAudit.terminal,
			stopped: admissionAudit.stopped,
			withdrawn: admissionAudit.withdrawn,
			workerClaims: admissionAudit.workerClaims,
			integrationClaims: admissionAudit.integrationClaims,
			distinctCheckoutInodes: admissionAudit.inodes.distinct,
			providerChildren: provider.lanes.length,
			providerOverlap: provider.overlap.max,
			providerSpreadMs: provider.spread,
			shellOverlap: shell.overlap.max,
			manifests: journal.manifests.length,
			objectDigests: journal.objects.digests,
			parentProblems: parentIssue,
			meter,
			problems,
		};
	});
}

// ── one combo: disposable root, profile, fake provider, suite ─────────────────────────────────

async function runCombo(combo: Combo, root: string, portBase: number): Promise<number> {
	process.env.E2E_WORK = combo.work;
	process.env.E2E_PORT = String(combo.port);
	delete process.env.E2E_PORT_OFFSET;
	delete process.env.E2E_ONLY;
	process.env.E2E_KEEP ??= "1";
	const env = prepare(`storm-e2e-scale-${combo.mode}-${combo.n}`, combo.port);
	env.childEnv.STORM_E2E_METER = join(env.work, "meter");
	const suite = new Suite(`E2E scale ${combo.mode} N=${combo.n}`, env);
	const check = suite.check.bind(suite);
	const profile: IsolationProfile = {
		enabled: true,
		apply: false,
		merge: "patch",
		backend: nativeBackend(),
		async: false,
		...(combo.mode === "main" ? { workerThreads: 0 } : {}),
	};
	const facts: { current: ScaleFacts } = {
		current: {
			mode: combo.mode,
			n: combo.n,
			work: env.work,
			port: env.port,
			omp: env.omp,
			ompVersion: env.ompVersion,
			binarySha256: "",
			host: process.platform,
			profile,
			configured: {},
			problems: [],
		},
	};
	let server: Subprocess | undefined;
	try {
		installProfile(env, isolationProfileYaml(profile));
		const settings = effectiveSettings(env);
		facts.current = { ...facts.current, binarySha256: await sha256File(env.omp) };
		server = await startFakeLlm(env);
		const sessions = new Sessions(env);
		let approved = false;
		await suite.step(
			"fixture: approve the recommended team and switch automatic delegation off",
			async () => {
				const { teams } = await sessions.approve("off");
				approved = teams === 1;
				check("the disposable profile holds one approved team", approved, `approvals=${teams}`);
			},
			120_000,
			{ always: true },
		);
		if (!approved) throw new Error("the team was not approved; the scale scenario cannot place workers");
		await suite.step(`scale ${combo.mode} N=${combo.n}: ${combo.n} isolated implementers`, () => scenario(env, combo, suite, settings, profile, sessions, facts), RUN_TIMEOUT_MS + 120_000);
		await suite.step(
			"omp exit codes",
			async () => {
				check("every omp session exited 0", sessions.exitCodes.length > 0 && sessions.exitCodes.every(code => code === 0), `exit=${sessions.exitCodes.join(",")}`);
			},
			20_000,
		);
	} catch (error) {
		check("harness", false, error instanceof Error ? (error.stack ?? error.message) : String(error));
	} finally {
		server?.kill();
		await server?.exited;
	}
	const code = suite.finish();
	const evidence = {
		schema: "storm.integration-scale/v1",
		generatedAt: new Date().toISOString(),
		root,
		portBase,
		facts: facts.current,
		gates: {
			[`scale-${combo.mode}-${combo.n}`]: code === 0 ? "PASS" : "FAIL",
		},
	};
	mkdirSync(env.logs, { recursive: true });
	writeFileSync(join(env.logs, `integration-scale-${combo.mode}-${combo.n}.json`), `${JSON.stringify(evidence, null, 2)}\n`);
	console.log(
		`SCALE ${combo.mode} N=${combo.n} configured=${JSON.stringify(facts.current.configured)} ` +
			`admitted=${facts.current.admitted ?? "-"} terminal=${facts.current.terminal ?? "-"} stopped=${facts.current.stopped ?? "-"} ` +
			`claims=${facts.current.workerClaims ?? "-"}/${facts.current.integrationClaims ?? "-"} inodes=${facts.current.distinctCheckoutInodes ?? "-"} ` +
			`provider=${facts.current.providerChildren ?? "-"} overlap=${facts.current.providerOverlap ?? "-"}/${facts.current.shellOverlap ?? "-"} spread=${facts.current.providerSpreadMs ?? "-"} ` +
			`manifests=${facts.current.manifests ?? "-"} objects=${facts.current.objectDigests?.length ?? "-"} work=${env.work}`,
	);
	return code;
}

// ── self-check: pure deterministic pieces, no omp, no model ───────────────────────────────────

function selfCheck(): number {
	const root = mkdtempSync(join(tmpdir(), "storm-e2e-scale-selfcheck-"));
	const failures: string[] = [];
	const ok = (name: string, condition: boolean, detail = ""): void => {
		if (!condition) failures.push(`${name}${detail === "" ? "" : `: ${detail}`}`);
		console.log(`${condition ? "PASS" : "FAIL"} self-check › ${name}${detail === "" ? "" : ` — ${detail}`}`);
	};
	try {
		const overlap = maxOverlap([
			{ key: "a", start: 0, end: 10 },
			{ key: "b", start: 1, end: 11 },
			{ key: "c", start: 2, end: 12 },
			{ key: "d", start: 3, end: 13 },
		]);
		ok("four overlapping intervals measure four", overlap.max === 4 && overlap.keys.length === 4, JSON.stringify(overlap));
		ok("touching intervals do not count as overlap", maxOverlap([{ key: "a", start: 0, end: 5 }, { key: "b", start: 5, end: 9 }]).max === 1);
		ok("an empty interval set measures zero", maxOverlap([]).max === 0);
		const inodes = auditInodes([
			{ path: "/a", device: "1", inode: "10", source: "entry-claim" },
			{ path: "/b", device: "1", inode: "11", source: "entry-claim" },
			{ path: "/a", device: "1", inode: "10", source: "worker-claim" },
		]);
		ok("duplicate (device, inode) claims are detected", inodes.distinct === 2 && inodes.duplicates.length === 1, JSON.stringify(inodes));
		const combos = plannedCombos(join(root, "work"), 21940);
		ok("exactly six mode/size combos are planned", combos.length === 6 && combos.map(combo => `${combo.mode}-${combo.n}`).join(",") === "main-4,main-8,main-16,pool-4,pool-8,pool-16", JSON.stringify(combos));
		ok("work dirs and ports are unique per mode and size", new Set(combos.map(combo => combo.work)).size === 6 && new Set(combos.map(combo => combo.port)).size === 6);
		const prefixRequests = [
			{ who: "child", ts: 0, lastUser: "assignment E2E-SCALE-LANE:scale-main-16-1 (e2e child 1)" },
			{ who: "child", ts: 10, lastUser: "assignment E2E-SCALE-LANE:scale-main-16-10 (e2e child 10)" },
			{ who: "child", ts: 15_180, lastUser: "assignment E2E-SCALE-LANE:scale-main-16-10 (e2e child 10)" },
		] as unknown as LlmEntry[];
		const prefixMeasured = providerMeasurement(prefixRequests, ["scale-main-16-1", "scale-main-16-10"], 10_000);
		ok(
			"a short lane marker does not capture a longer lane's later request",
			prefixMeasured.lanes.length === 2 && prefixMeasured.overlap.max === 2 && prefixMeasured.missing.length === 0 &&
				prefixMeasured.ambiguous.length === 0 && prefixMeasured.spread === 10,
			JSON.stringify(prefixMeasured),
		);

		const project = join(root, "project");
		const agentDir = join(root, "agent");
		const checkout = join(root, "checkout");
		mkdirSync(project, { recursive: true });
		mkdirSync(checkout, { recursive: true });
		mkdirSync(join(agentDir, "integration", "v1", "objects"), { recursive: true });
		mkdirSync(join(agentDir, "integration", "v1", "prepared", "a".repeat(64)), { recursive: true });
		mkdirSync(join(agentDir, "integration", "v1", "claims"), { recursive: true });
		mkdirSync(join(agentDir, "storm", "admissions"), { recursive: true });
		for (const args of [["init", "-q"], ["config", "user.name", "Scale Self Check"], ["config", "user.email", "scale@example.invalid"]]) {
			const step = Bun.spawnSync(["git", "-C", project, ...args], { stdout: "pipe", stderr: "pipe" });
			if (step.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${step.stderr.toString()}`);
		}
		writeFileSync(join(project, "e2e-tracked.txt"), "tracked\n");
		Bun.spawnSync(["git", "-C", project, "add", "e2e-tracked.txt"]);
		Bun.spawnSync(["git", "-C", project, "commit", "-q", "-m", "self-check"]);
		const runId = "run-20260101-000000-selfcheck";
		const lane = "scale-main-4-0";
		const laneFile = `${lane}.txt`;
		const workerKey = "a".repeat(64);
		const attempt = "01234567-89ab-cdef-0123-456789abcdef";
		const childId = `${runId}-lane-1`;
		const key = { schema: "storm.integration-admission/v1" as const, runId, dispatch: "dispatch-1" };
		const candidateId = integrationCandidateId(key);
		const patch = `diff --git a/${laneFile} b/${laneFile}\nnew file mode 100644\nindex 0000000..1111111\n--- /dev/null\n+++ b/${laneFile}\n@@ -0,0 +1 @@\n+LANE-0\n`;
		const digest = sha256(patch);
		writeFileSync(join(agentDir, "integration", "v1", "objects", digest), patch);
		const projectIdentity = identityOf(project, 1)!;
		const checkoutIdentity = identityOf(checkout, 1)!;
		const target = {
			leaseKey: "lease-1",
			authorizedRoot: { canonicalPath: projectIdentity.path, device: projectIdentity.device, inode: projectIdentity.inode },
			gitRoot: { canonicalPath: projectIdentity.path, device: projectIdentity.device, inode: projectIdentity.inode },
			gitDir: { canonicalPath: join(projectIdentity.path, ".git"), device: "1", inode: "2" },
			sourceOdb: {
				commonDir: { canonicalPath: join(projectIdentity.path, ".git"), device: "1", inode: "2" },
				objects: { canonicalPath: join(projectIdentity.path, ".git", "objects"), device: "1", inode: "3" },
				objectFormat: "sha1" as const,
			},
			targetPrefix: "",
		};
		const objectRef = { schema: "storm.integration-patch/v1", key, objectKey: `v1/objects/${digest}`, bytes: Buffer.byteLength(patch), sha256: digest };
		const admission = {
			key,
			candidateId,
			director: { sessionId: "s", sessionDir: join(agentDir, "storm", "sessions", "s"), parentId: "Main", sessionInstance: "i" },
			target,
			artifactRoot: { canonicalPath: join(agentDir, "artifacts"), device: "1", inode: "4" },
			item: { toolCallId: "call_1", itemIndex: 0, handle: childId },
			placementOrdinal: 0,
			approvedDefinitionDigest: `sha256:${"b".repeat(64)}`,
			approvalDigest: "c".repeat(64),
			workerAdmission: { key: workerKey, attempt, approved: [] },
			scope: { kind: "unbounded" as const },
			subject: { kind: "planned" as const, lane, epoch: 1, contractDigest: "d".repeat(64), results: [], consumed: [] },
			policy: {
				id: "policy-1", host: "19.2.1" as const, settingsInstance: "settings-1", relevantEpoch: 1, directorInstance: "i",
				toolCallId: "call_1", enabled: true as const, backendProofId: "dispatch-1", apply: false as const, merge: "patch" as const,
				captureContract: "native-git-synthetic-tree" as const, backendSetting: "apfs",
			},
			slot: { key, profile: "storm-e2e", slotPath: join(root, "slot"), ownerToken: "owner-1" },
			startedAt: 1,
		};
		const claimValue = {
			key,
			candidateId,
			entry: { registryInstance: "i", generation: 2, childSessionFile: { canonicalPath: join(root, "child.jsonl"), device: "1", inode: "5" } },
			childHandle: childId,
			policyProofId: "policy-1",
			workerAttempt: attempt,
			slotOwnerToken: "owner-1",
			hostOwner: { pid: 1, processStart: 1, host: "19.2.1" },
			checkout: { canonicalPath: checkoutIdentity.path, device: checkoutIdentity.device, inode: checkoutIdentity.inode },
			checkoutGitDir: { canonicalPath: join(checkoutIdentity.path, ".git"), device: "1", inode: "6" },
			checkoutIndexPath: join(checkoutIdentity.path, ".git", "index"),
			checkoutTargetPrefix: "",
			sourceOdb: target.sourceOdb,
			guardBuild: "guard-1",
			preWorkHead: null,
			checkedAt: 1,
		};
		const manifestBase = {
			schema: "storm.integration-capture/v1" as const,
			admission,
			childClaim: { kind: "known" as const, value: claimValue },
			terminal: {
				kind: "known" as const,
				value: {
					observedAt: 1, outcome: { kind: "known" as const, value: "success" as const }, structured: "not-requested" as const,
					stopCause: { kind: "unknown" as const, problem: { code: "none", reason: "none" } }, cancelRequested: false,
					nativeLink: "sync", carrier: "sync" as const, item: { toolCallId: "call_1", itemIndex: 0, handle: childId }, exitCode: 0, aborted: false,
				},
			},
			bundle: { kind: "root-only" as const, basis: "sync-explicit" as const, root: objectRef },
			delta: {
				kind: "known" as const,
				value: {
					schema: "storm.integration-delta/v1", digest: "e".repeat(64), key, candidateId, target, scope: { kind: "unbounded" as const },
					sourceOdb: target.sourceOdb, root: objectRef,
					entries: [{ gitPath: laneFile, targetPath: laneFile, encoding: "text" as const, before: { state: "absent" as const }, after: { state: "file" as const, mode: "100644" as const, bytes: 7, sha256: "f".repeat(64) } }],
					expandedBytes: 7,
				},
			},
			recovery: {
				root: { kind: "known" as const, value: { nativePath: "/native/patch", copy: { kind: "known" as const, value: objectRef } } },
				nested: { kind: "known" as const, value: [] },
				branch: { kind: "unknown" as const, problem: { code: "no-branch", reason: "none" } },
				checkout: { kind: "present" as const, checkedAt: 1 },
				nativeLink: { kind: "unknown" as const, problem: { code: "none", reason: "none" } },
			},
		};
		const manifest = { ...manifestBase, digest: captureManifestDigest(manifestBase as unknown as Omit<SealedCaptureManifest, "digest">) };
		const baseRecord = { schema: JOURNAL_SCHEMA, seq: 1, prev: "", at: 1, kind: "manifest", payload: { manifest } };
		const record = { ...baseRecord, hash: sha256(JSON.stringify(baseRecord)) };
		const journal = journalFileOf(join(agentDir, "storm", "sessions", "s"), runId);
		mkdirSync(join(journal, ".."), { recursive: true });
		writeFileSync(journal, `${JSON.stringify(record)}\n`);
		writeFileSync(join(agentDir, "integration", "v1", "prepared", workerKey, `${attempt}.json`), canonicalJson(admission));
		writeFileSync(join(agentDir, "integration", "v1", "claims", `${candidateId}.json`), canonicalJson(claimValue));
		writeFileSync(
			join(agentDir, "storm", "admissions", `${workerKey}.json`),
			`${JSON.stringify({ schema: "storm.worker-admission/v2", runId, key: workerKey, attempt, childId, lane, policy: { kind: "private" }, endedAt: 2 })}\n`,
		);
		writeFileSync(
			join(agentDir, "storm", "admissions", `${workerKey}.${attempt}.claim`),
			`${JSON.stringify({ schema: "storm.worker-claim/v1", session: "0".repeat(64), checkout: checkoutIdentity.path })}\n`,
		);
		const live: LiveObservation = { checkouts: new Map([[checkoutIdentity.path, checkoutIdentity]]) };
		const journalAudit = verifyJournal(journal, agentDir, runId, new Map([[lane, laneFile]]), project);
		ok("the exact journal chain and manifest verify", journalAudit.exists && journalAudit.problems.length === 0 && journalAudit.manifests.length === 1, journalAudit.problems.join("; "));
		ok("the manifest's owned object is found at the exact profile path", journalAudit.objects.digests.length === 1 && journalAudit.objects.problems.length === 0, journalAudit.objects.problems.join("; "));
		const admissionAudit = verifyAdmissions({ agentDir, project }, runId, live);
		ok(
			"terminal admission, worker claim and entry claim account for one lane",
			admissionAudit.admitted === 1 && admissionAudit.terminal === 1 && admissionAudit.stopped === 0 && admissionAudit.workerClaims === 1 &&
				admissionAudit.integrationClaims === 1 && admissionAudit.inodes.total === 1 && admissionAudit.inodes.distinct === 1 &&
				admissionAudit.workerInodes.total === 1 && admissionAudit.workerInodes.distinct === 1,
			JSON.stringify(admissionAudit),
		);
		const before = snapshotParent(project, [laneFile]);
		const after = snapshotParent(project, [laneFile]);
		ok("an unchanged parent compares equal", parentProblems(before, after).length === 0, parentProblems(before, after).join("; "));
		writeFileSync(join(project, "untracked.txt"), "x\n");
		ok("an untracked parent write is detected", parentProblems(before, snapshotParent(project, [laneFile])).length > 0);
		rmSync(join(project, "untracked.txt"), { force: true });
		rmSync(join(agentDir, "integration", "v1", "objects", digest), { force: true });
		const missingObject = verifyJournal(journal, agentDir, runId, new Map([[lane, laneFile]]), project);
		ok("a missing owned object fails the journal verification", missingObject.problems.some(problem => problem.includes("objects") || problem.includes("missing")), missingObject.problems.join("; "));
		const broken = textOf(journal).replace('"seq":1', '"seq":2');
		writeFileSync(journal, broken);
		const brokenAudit = verifyJournal(journal, agentDir, runId, new Map([[lane, laneFile]]), project);
		ok("a broken journal sequence fails", brokenAudit.problems.length > 0, brokenAudit.problems.join("; "));
	} catch (error) {
		failures.push(error instanceof Error ? (error.stack ?? error.message) : String(error));
		console.log(`FAIL self-check › harness — ${error instanceof Error ? error.message : String(error)}`);
	}
	if (failures.length === 0) rmSync(root, { recursive: true, force: true });
	else console.log(`self-check work kept: ${root}`);
	console.log(`\nSELF-CHECK: ${failures.length === 0 ? "PASS" : "FAIL"} (${failures.length} failures)`);
	return failures.length === 0 ? 0 : 1;
}

// ── gates and main ────────────────────────────────────────────────────────────────────────────

function printGates(real: boolean, passed: Readonly<Record<string, "PASS" | "FAIL" | "NOT-RUN">>, noRunLine = true): void {
	if (real) {
		console.log("GATE scale-host-seam: CHECKED-BY-RUN — each scale gate requires observed claims, captures and exact policy checks.");
	} else {
		console.log("GATE scale-host-seam: NOT-RUN — real scale measurement requires OMP_BIN with the guarded native slot and child-entry capability.");
	}
	for (const combo of plannedCombos(process.env.E2E_SCALE_WORK_ROOT ?? join(tmpdir(), "storm-e2e-scale"), Number(process.env.E2E_SCALE_PORT_BASE ?? 21940))) {
		const id = `scale-${combo.mode}-${combo.n}`;
		const state = passed[id] ?? "NOT-RUN";
		console.log(`GATE ${id}: ${state} — ${state === "PASS" ? `observed ${combo.mode === "main" ? "main-thread" : "default pooled"} N=${combo.n}` : `requires E2E_SCALE=1 E2E_SCALE_HOST=1 against a host with the exact slot fix; work ${combo.work}, port ${combo.port}`}`);
	}
	if (!real && noRunLine) console.log("GATE scale-real-host: NOT-RUN — no omp process was started; only the deterministic self-check above ran in this invocation.");
}

async function main(): Promise<void> {
	const selfCheckCode = selfCheck();
	const workRoot = process.env.E2E_SCALE_WORK_ROOT ?? join(tmpdir(), "storm-e2e-scale");
	const portBase = Number(process.env.E2E_SCALE_PORT_BASE ?? 21940);
	const modes = parseSelection(process.env.E2E_SCALE_MODES, MODES, "E2E_SCALE_MODES");
	const ns = parseSelection(process.env.E2E_SCALE_NS, NS, "E2E_SCALE_NS");
	if (selfCheckCode !== 0) {
		printGates(false, {});
		process.exit(1);
	}
	if (SELF_CHECK_ONLY) {
		printGates(false, {});
		process.exit(REQUIRE_GATES ? 2 : 0);
	}
	if (!SCALE) {
		printGates(false, {});
		process.exit(REQUIRE_GATES ? 2 : 0);
	}
	if (!HOST_READY) {
		console.log("GATE scale-real-host: BLOCKED — set E2E_SCALE_HOST=1 only with an OMP_BIN that has the guarded native slot and child-entry capability.");
		printGates(false, {}, false);
		process.exit(2);
	}
	const combos = plannedCombos(workRoot, portBase, modes, ns);
	const gates: Record<string, "PASS" | "FAIL" | "NOT-RUN"> = {};
	let failed = 0;
	for (const combo of combos) {
		try {
			const code = await runCombo(combo, workRoot, portBase);
			gates[`scale-${combo.mode}-${combo.n}`] = code === 0 ? "PASS" : "FAIL";
			if (code !== 0) failed++;
		} catch (error) {
			console.log(`FAIL scale-${combo.mode}-${combo.n} harness — ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
			gates[`scale-${combo.mode}-${combo.n}`] = "FAIL";
			failed++;
		}
	}
	printGates(true, gates);
	process.exit(failed === 0 ? 0 : 1);
}

await main();
