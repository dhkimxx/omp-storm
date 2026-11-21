import { mkdir, open, readdir, rm, rmdir, stat } from "node:fs/promises";
import * as path from "node:path";
import { serializeConfig } from "../config/store.ts";
import { readJson, writeJsonAtomic, writeTextAtomic } from "../fsutil.ts";
import type { ApprovalRecord, ApprovalScope, RepoIdentity, StormConfig } from "../types.ts";

const HASH_PREFIX = "jcs-sha256:";
const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_CODES: readonly unknown[] = ["EEXIST", "ENOENT", "EINVAL"];
const LOCK_TIMEOUT_MS = 10_000;
const HEX_FILE_RE = /^[0-9a-f]{64}\.json$/;
/** Written by Storm before 0.10 and read by nothing; `prune` and `clear` remove them. */
const LEGACY = ["evidence", "log.jsonl", "repo.json"] as const;

function hexOf(configHash: string): string {
	const hex = configHash.startsWith(HASH_PREFIX) ? configHash.slice(HASH_PREFIX.length) : "";
	if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error("잘못된 설정 해시입니다");
	return hex;
}

function errCode(e: unknown): unknown {
	return typeof e === "object" && e !== null && "code" in e ? e.code : undefined;
}

/** `*.json` names of a store subdirectory named by a config hash; none when the directory is missing. */
async function hexFiles(dir: string): Promise<string[]> {
	try {
		return (await readdir(dir)).filter(name => HEX_FILE_RE.test(name));
	} catch (e) {
		if (errCode(e) === "ENOENT") return [];
		throw e;
	}
}

/**
 * Records of every Storm version: 0.8/0.9 wrote more fields (approvalId, repoId, versions, expiresAt: null, ...), which
 * are ignored. A damaged record (no scope) is no approval, so its readers never meet a half-shaped one.
 */
function isApproval(value: unknown): value is ApprovalRecord {
	if (typeof value !== "object" || value === null) return false;
	const r = value as Partial<ApprovalRecord>;
	return (
		r.schema === "storm.approval/v1" &&
		r.status === "active" &&
		typeof r.configHash === "string" &&
		typeof r.approvedAt === "string" &&
		Array.isArray(r.scope?.shadowedAgents)
	);
}

/** Files under a legacy path (a file or a directory), removed; returns how many files went. */
async function removeLegacy(target: string): Promise<number> {
	let count: number;
	try {
		count = (await stat(target)).isDirectory() ? (await readdir(target)).length : 1;
	} catch (e) {
		if (errCode(e) === "ENOENT") return 0;
		throw e;
	}
	await rm(target, { recursive: true, force: true });
	return count;
}

/**
 * Approvals of one repo under `<baseDir>/approvals/<repoId>/`: `approved/<hex>.json` (the record) and
 * `snapshots/<hex>.json` (the approved config, for rollback and diffs). The run janitor keeps its `runs.jsonl`
 * in the same directory; this class never touches it.
 */
export class ApprovalStore {
	readonly dir: string;

	constructor(baseDir: string, repo: RepoIdentity) {
		this.dir = path.join(baseDir, "approvals", repo.repoId);
	}

	private approvedPath(hex: string): string {
		return path.join(this.dir, "approved", `${hex}.json`);
	}

	private snapshotPath(hex: string): string {
		return path.join(this.dir, "snapshots", `${hex}.json`);
	}

	private async exists(): Promise<boolean> {
		try {
			await stat(this.dir);
			return true;
		} catch (e) {
			if (errCode(e) === "ENOENT") return false;
			throw e;
		}
	}

	private async withLock<T>(fn: () => Promise<T>): Promise<T> {
		const lockPath = path.join(this.dir, ".lock");
		const deadline = Date.now() + LOCK_TIMEOUT_MS;
		for (;;) {
			if (Date.now() >= deadline) throw new Error("승인 저장소 잠금을 얻지 못했습니다");
			try {
				// Inside the loop: `clear()` in another process removes the directory once it is empty, also while this one waits.
				await mkdir(this.dir, { recursive: true });
				const fh = await open(lockPath, "wx");
				try {
					await fh.writeFile(`${process.pid} ${new Date().toISOString()}\n`);
				} finally {
					await fh.close();
				}
				break;
			} catch (e) {
				// EEXIST: the lock is held. While another process's `clear()` removes the emptied directory, mkdir and open
				// also fail with EEXIST, ENOENT or, on macOS (create in a directory being removed), EINVAL: all mean "try again".
				if (!LOCK_RETRY_CODES.includes(errCode(e))) throw e;
			}
			try {
				const st = await stat(lockPath);
				if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
					await rm(lockPath, { force: true });
					continue;
				}
			} catch (e) {
				// ENOENT: released, or removed with the directory, since the attempt.
				if (errCode(e) !== "ENOENT") throw e;
			}
			await Bun.sleep(10 + Math.floor(Math.random() * 15));
		}
		try {
			return await fn();
		} finally {
			await rm(lockPath, { force: true });
		}
	}

	/** The approval of exactly this config hash, if the user gave one. */
	async active(configHash: string): Promise<ApprovalRecord | undefined> {
		const value = await readJson(this.approvedPath(hexOf(configHash)));
		// A record copied under another hash's name must not approve that hash.
		return isApproval(value) && value.configHash === configHash ? value : undefined;
	}

	async approve(input: { configHash: string; config: StormConfig; scope: ApprovalScope }): Promise<ApprovalRecord> {
		const hex = hexOf(input.configHash);
		return this.withLock(async () => {
			const record: ApprovalRecord = {
				schema: "storm.approval/v1",
				status: "active",
				configHash: input.configHash,
				approvedAt: new Date().toISOString(),
				scope: { shadowedAgents: input.scope.shadowedAgents },
			};
			await writeTextAtomic(this.snapshotPath(hex), serializeConfig(input.config));
			await writeJsonAtomic(this.approvedPath(hex), record);
			return record;
		});
	}

	/** Every approval, newest first. */
	async list(): Promise<ApprovalRecord[]> {
		const dir = path.join(this.dir, "approved");
		const out: ApprovalRecord[] = [];
		for (const name of await hexFiles(dir)) {
			const value = await readJson(path.join(dir, name));
			if (isApproval(value)) out.push(value);
		}
		return out.sort((a, b) => {
			if (a.approvedAt !== b.approvedAt) return a.approvedAt < b.approvedAt ? 1 : -1;
			return a.configHash < b.configHash ? 1 : a.configHash > b.configHash ? -1 : 0;
		});
	}

	async snapshot(configHash: string): Promise<StormConfig | undefined> {
		const value = await readJson(this.snapshotPath(hexOf(configHash)));
		return typeof value === "object" && value !== null ? (value as StormConfig) : undefined;
	}

	/**
	 * Storm limits: keeps the record and snapshot of `keepHash` plus the newest `keep` other hashes (by approval time,
	 * file time for a snapshot without a record), and removes what Storm wrote here before 0.10 and never read.
	 * Returns how many files it removed.
	 */
	async prune(keepHash: string | null, keep = 20): Promise<number> {
		const keepHex = keepHash === null ? undefined : hexOf(keepHash);
		// withLock creates the dir; a repo without approvals must stay without one.
		if (!(await this.exists())) return 0;
		return this.withLock(async () => {
			const rank = new Map<string, number>();
			for (const kind of ["approved", "snapshots"] as const) {
				for (const name of await hexFiles(path.join(this.dir, kind))) {
					const hex = name.slice(0, -5);
					const file = path.join(this.dir, kind, name);
					let at = (await stat(file)).mtimeMs;
					if (kind === "approved") {
						const value = await readJson(file);
						const approvedAt = isApproval(value) ? Date.parse(value.approvedAt) : Number.NaN;
						if (Number.isFinite(approvedAt)) at = approvedAt;
					}
					// The approval time wins over file times.
					if (kind === "approved" || !rank.has(hex)) rank.set(hex, at);
				}
			}
			const stale = [...rank.entries()]
				.filter(([hex]) => hex !== keepHex)
				.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? 1 : -1))
				.slice(Math.max(0, keep))
				.map(([hex]) => hex);
			let removed = 0;
			for (const hex of stale) {
				for (const file of [this.approvedPath(hex), this.snapshotPath(hex)]) {
					try {
						await rm(file);
						removed++;
					} catch (e) {
						if (errCode(e) !== "ENOENT") throw e;
					}
				}
			}
			for (const name of LEGACY) removed += await removeLegacy(path.join(this.dir, name));
			return removed;
		});
	}

	/**
	 * `/storm reset`: deletes this repo's approvals and snapshots and returns how many approvals there were.
	 * `runs.jsonl` stays: it is the janitor's only proof of which omp records belong to Storm runs.
	 */
	async clear(): Promise<number> {
		if (!(await this.exists())) return 0;
		const count = await this.withLock(async () => {
			const approvals = (await this.list()).length;
			for (const name of ["approved", "snapshots", ...LEGACY]) await rm(path.join(this.dir, name), { recursive: true, force: true });
			return approvals;
		});
		// Nothing left to keep: leave no empty directory behind.
		await rmdir(this.dir).catch(() => undefined);
		return count;
	}
}
