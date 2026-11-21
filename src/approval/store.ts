import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { serializeConfig } from "../config/store.ts";
import { STORM_VERSION } from "../roles.ts";
import type {
	ApprovalLogEntry,
	ApprovalRecord,
	ApprovalScope,
	EvidenceRecord,
	RepoIdentity,
	StormConfig,
} from "../types.ts";

const HASH_PREFIX = "jcs-sha256:";
const LOCK_STALE_MS = 30_000;
const LOCK_TIMEOUT_MS = 10_000;

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
let lastUlidTime = -1;
const lastUlidRand = new Uint8Array(10);

/** Monotonic ULID: same-ms ids bump the previous randomness so creation order is kept. */
function ulid(): string {
	let now = Date.now();
	if (now <= lastUlidTime) {
		now = lastUlidTime;
		for (let i = lastUlidRand.length - 1; i >= 0; i--) {
			lastUlidRand[i] = ((lastUlidRand[i] ?? 0) + 1) & 0xff;
			if (lastUlidRand[i] !== 0) break;
		}
	} else {
		lastUlidTime = now;
		crypto.getRandomValues(lastUlidRand);
	}
	let time = "";
	let t = now;
	for (let i = 0; i < 10; i++) {
		time = CROCKFORD[t % 32] + time;
		t = Math.floor(t / 32);
	}
	let r = 0n;
	for (const b of lastUlidRand) r = (r << 8n) | BigInt(b);
	let rand = "";
	for (let i = 0; i < 16; i++) {
		rand = CROCKFORD[Number(r & 31n)] + rand;
		r >>= 5n;
	}
	return time + rand;
}

function hexOf(configHash: string): string {
	const hex = configHash.startsWith(HASH_PREFIX) ? configHash.slice(HASH_PREFIX.length) : "";
	if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error("잘못된 설정 해시입니다");
	return hex;
}

function errCode(e: unknown): unknown {
	return typeof e === "object" && e !== null && "code" in e ? e.code : undefined;
}

async function readText(file: string): Promise<string | undefined> {
	try {
		return await readFile(file, "utf8");
	} catch (e) {
		if (errCode(e) === "ENOENT") return undefined;
		throw e;
	}
}

function parseJson(text: string | undefined): unknown {
	if (text === undefined) return undefined;
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

function isValidActive(value: unknown, now: number): value is ApprovalRecord {
	if (typeof value !== "object" || value === null) return false;
	const r = value as Partial<ApprovalRecord>;
	if (r.schema !== "storm.approval/v1" || r.status !== "active") return false;
	if (typeof r.approvalId !== "string" || typeof r.configHash !== "string" || typeof r.approvedAt !== "string") return false;
	if (r.expiresAt === null) return true;
	if (typeof r.expiresAt !== "string") return false;
	const exp = Date.parse(r.expiresAt);
	return Number.isFinite(exp) && exp > now;
}

async function writeAtomic(file: string, content: string): Promise<void> {
	const dir = path.dirname(file);
	await mkdir(dir, { recursive: true });
	const rand = Math.random().toString(36).slice(2, 10);
	const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${rand}.tmp`);
	try {
		await writeFile(tmp, content);
		await rename(tmp, file);
	} catch (e) {
		await rm(tmp, { force: true });
		throw e;
	}
}

function toJson(value: unknown): string {
	return `${JSON.stringify(value, null, 2)}\n`;
}

export class ApprovalStore {
	readonly dir: string;

	constructor(
		baseDir: string,
		private readonly repo: RepoIdentity,
	) {
		this.dir = path.join(baseDir, "approvals", repo.repoId);
	}

	private approvedPath(hex: string): string {
		return path.join(this.dir, "approved", `${hex}.json`);
	}

	private snapshotPath(hex: string): string {
		return path.join(this.dir, "snapshots", `${hex}.json`);
	}

	private evidencePath(hex: string): string {
		return path.join(this.dir, "evidence", `${hex}.json`);
	}

	private async withLock<T>(fn: () => Promise<T>): Promise<T> {
		await mkdir(this.dir, { recursive: true });
		const lockPath = path.join(this.dir, ".lock");
		const deadline = Date.now() + LOCK_TIMEOUT_MS;
		for (;;) {
			try {
				const fh = await open(lockPath, "wx");
				try {
					await fh.writeFile(`${process.pid} ${new Date().toISOString()}\n`);
				} finally {
					await fh.close();
				}
				break;
			} catch (e) {
				if (errCode(e) !== "EEXIST") throw e;
			}
			try {
				const st = await stat(lockPath);
				if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
					await rm(lockPath, { force: true });
					continue;
				}
			} catch (e) {
				// Holder released between open and stat; retry right away.
				if (errCode(e) === "ENOENT") continue;
				throw e;
			}
			if (Date.now() >= deadline) throw new Error("승인 저장소 잠금을 얻지 못했습니다");
			await Bun.sleep(10 + Math.floor(Math.random() * 15));
		}
		try {
			return await fn();
		} finally {
			await rm(lockPath, { force: true });
		}
	}

	private async appendLog(entry: ApprovalLogEntry): Promise<void> {
		const file = path.join(this.dir, "log.jsonl");
		let existing = (await readText(file)) ?? "";
		// A torn last line must not swallow the next entry.
		if (existing.length > 0 && !existing.endsWith("\n")) existing += "\n";
		await writeAtomic(file, `${existing}${JSON.stringify(entry)}\n`);
	}

	private async readActive(hex: string): Promise<ApprovalRecord | undefined> {
		const value = parseJson(await readText(this.approvedPath(hex)));
		return isValidActive(value, Date.now()) ? value : undefined;
	}

	private async upsertRepo(now: string): Promise<void> {
		const file = path.join(this.dir, "repo.json");
		const prev = parseJson(await readText(file));
		const prevFirst = typeof prev === "object" && prev !== null && "firstSeenAt" in prev ? prev.firstSeenAt : undefined;
		const firstSeenAt = typeof prevFirst === "string" ? prevFirst : now;
		const out: Record<string, unknown> = { schema: "storm.repo/v1", repoId: this.repo.repoId, kind: this.repo.kind };
		if (this.repo.commonDir !== undefined) out["commonDir"] = this.repo.commonDir;
		if (this.repo.remotes !== undefined) out["remotes"] = this.repo.remotes;
		if (this.repo.rootCommits !== undefined) out["rootCommits"] = this.repo.rootCommits;
		out["firstSeenAt"] = firstSeenAt;
		out["lastSeenAt"] = now;
		await writeAtomic(file, toJson(out));
	}

	async active(configHash: string): Promise<ApprovalRecord | undefined> {
		return this.readActive(hexOf(configHash));
	}

	async approve(input: {
		configHash: string;
		rawSha256: string;
		config: StormConfig;
		scope: ApprovalScope;
		via: string;
		ompVersion: string;
		supersedes: string | null;
		/** Why these models were chosen; stored per hash before the approval record. */
		evidence?: EvidenceRecord;
	}): Promise<ApprovalRecord> {
		const hex = hexOf(input.configHash);
		return this.withLock(async () => {
			const approvedAt = new Date().toISOString();
			const record: ApprovalRecord = {
				schema: "storm.approval/v1",
				approvalId: `apr_${ulid()}`,
				status: "active",
				repoId: this.repo.repoId,
				configHash: input.configHash,
				rawSha256: input.rawSha256,
				approvedAt,
				approvedVia: { mode: input.via },
				versions: { omp: input.ompVersion, storm: STORM_VERSION, configSchema: 1 },
				scope: input.scope,
				supersedes: input.supersedes,
				expiresAt: null,
			};
			await writeAtomic(this.snapshotPath(hex), serializeConfig(input.config));
			if (input.evidence) await writeAtomic(this.evidencePath(hex), toJson(input.evidence));
			await writeAtomic(this.approvedPath(hex), toJson(record));
			await this.appendLog({
				ts: approvedAt,
				event: "approved",
				approvalId: record.approvalId,
				configHash: input.configHash,
			});
			await this.upsertRepo(approvedAt);
			return record;
		});
	}

	async revoke(configHash: string): Promise<boolean> {
		const hex = hexOf(configHash);
		return this.withLock(async () => {
			const record = await this.readActive(hex);
			if (!record) return false;
			await writeAtomic(this.approvedPath(hex), toJson({ ...record, status: "revoked" }));
			await this.appendLog({
				ts: new Date().toISOString(),
				event: "revoked",
				approvalId: record.approvalId,
				configHash: record.configHash,
			});
			return true;
		});
	}

	async list(): Promise<ApprovalRecord[]> {
		let names: string[];
		try {
			names = await readdir(path.join(this.dir, "approved"));
		} catch (e) {
			if (errCode(e) === "ENOENT") return [];
			throw e;
		}
		const now = Date.now();
		const out: ApprovalRecord[] = [];
		for (const name of names) {
			if (!/^[0-9a-f]{64}\.json$/.test(name)) continue;
			const value = parseJson(await readText(path.join(this.dir, "approved", name)));
			if (isValidActive(value, now)) out.push(value);
		}
		return out.sort((a, b) => {
			if (a.approvedAt !== b.approvedAt) return a.approvedAt < b.approvedAt ? 1 : -1;
			return a.approvalId < b.approvalId ? 1 : a.approvalId > b.approvalId ? -1 : 0;
		});
	}

	async snapshot(configHash: string): Promise<StormConfig | undefined> {
		const value = parseJson(await readText(this.snapshotPath(hexOf(configHash))));
		return typeof value === "object" && value !== null ? (value as StormConfig) : undefined;
	}

	async evidence(configHash: string): Promise<EvidenceRecord | undefined> {
		const value = parseJson(await readText(this.evidencePath(hexOf(configHash))));
		// Written only by approve; the schema check filters foreign or torn files.
		return typeof value === "object" && value !== null && "schema" in value && value.schema === "storm.evidence/v1"
			? (value as EvidenceRecord)
			: undefined;
	}

	async log(): Promise<ApprovalLogEntry[]> {
		const text = await readText(path.join(this.dir, "log.jsonl"));
		if (text === undefined) return [];
		const out: ApprovalLogEntry[] = [];
		for (const line of text.split("\n")) {
			if (line.trim() === "") continue;
			const value = parseJson(line);
			if (typeof value === "object" && value !== null && "event" in value && typeof value.event === "string") {
				// Lines are written only by appendLog; the event check filters foreign/torn JSON.
				out.push(value as ApprovalLogEntry);
			}
		}
		return out;
	}

	async recordRollback(configHash: string, prevHash: string | null): Promise<void> {
		const hex = hexOf(configHash);
		await this.withLock(async () => {
			const record = await this.readActive(hex);
			await this.appendLog({
				ts: new Date().toISOString(),
				event: "rolled_back",
				approvalId: record?.approvalId ?? "",
				configHash,
				prevHash,
			});
		});
	}

	/**
	 * Storm limits: keeps the approved record, snapshot and evidence of `keepHash` plus the newest `keep` other hashes
	 * (by approval time, file time for hashes without a record) and the newest `logLines` log lines.
	 * Returns how many files it removed.
	 */
	async prune(keepHash: string | null, keep = 20, logLines = 2000): Promise<number> {
		const keepHex = keepHash === null ? undefined : hexOf(keepHash);
		// withLock creates the dir; a repo without approvals must stay without one.
		try {
			await stat(this.dir);
		} catch (e) {
			if (errCode(e) === "ENOENT") return 0;
			throw e;
		}
		return this.withLock(async () => {
			const kinds = ["approved", "snapshots", "evidence"] as const;
			const rank = new Map<string, number>();
			for (const kind of kinds) {
				let names: string[];
				try {
					names = await readdir(path.join(this.dir, kind));
				} catch (e) {
					if (errCode(e) === "ENOENT") continue;
					throw e;
				}
				for (const name of names) {
					if (!/^[0-9a-f]{64}\.json$/.test(name)) continue;
					const hex = name.slice(0, -5);
					const file = path.join(this.dir, kind, name);
					let at = (await stat(file)).mtimeMs;
					if (kind === "approved") {
						const value = parseJson(await readText(file));
						const approvedAt =
							typeof value === "object" && value !== null && "approvedAt" in value && typeof value.approvedAt === "string"
								? Date.parse(value.approvedAt)
								: Number.NaN;
						if (Number.isFinite(approvedAt)) at = approvedAt;
					}
					// The approval time wins over file times; otherwise the newest file of the hash.
					const prev = rank.get(hex);
					if (kind === "approved" || prev === undefined || at > prev) rank.set(hex, at);
				}
			}
			const stale = [...rank.entries()]
				.filter(([hex]) => hex !== keepHex)
				.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? 1 : -1))
				.slice(Math.max(0, keep))
				.map(([hex]) => hex);
			let removed = 0;
			for (const hex of stale) {
				for (const file of [this.approvedPath(hex), this.snapshotPath(hex), this.evidencePath(hex)]) {
					try {
						await rm(file);
						removed++;
					} catch (e) {
						if (errCode(e) !== "ENOENT") throw e;
					}
				}
			}
			const logFile = path.join(this.dir, "log.jsonl");
			const text = await readText(logFile);
			if (text !== undefined) {
				const lines = text.split("\n").filter(line => line.trim() !== "");
				if (lines.length > logLines) await writeAtomic(logFile, `${lines.slice(lines.length - Math.max(0, logLines)).join("\n")}\n`);
			}
			return removed;
		});
	}

	/** Deletes this repo's approvals, snapshots, evidence and log (`/storm reset`); returns how many approvals there were. */
	async clear(): Promise<number> {
		return this.withLock(async () => {
			const count = (await this.list()).length;
			await rm(this.dir, { recursive: true, force: true });
			return count;
		});
	}
}
