import { realpathSync } from "node:fs";
import { mkdir, open, readdir, rm, rmdir, stat } from "node:fs/promises";
import * as path from "node:path";
import { sha256Hex } from "../config/canonical.ts";
import { assertSessionStoreSafe } from "../session-scope.ts";
import { serializeConfig } from "../config/store.ts";
import { readJson, writeJsonAtomic, writeTextAtomic } from "../fsutil.ts";
import type { ApprovalRecord, ApprovalScope, RepoIdentity, StormConfig } from "../types.ts";

const HASH_PREFIX = "jcs-sha256:";
const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_CODES: readonly unknown[] = ["EEXIST", "ENOENT", "EINVAL"];
const LOCK_TIMEOUT_MS = 10_000;
const HEX_FILE_RE = /^[0-9a-f]{64}\.json$/;
/** A target directory is named by the full hash of its canonical identity; a copied legacy directory cannot match. */
const TARGET_DIR_RE = /^[0-9a-f]{64}$/;

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

async function dirExists(dir: string): Promise<boolean> {
	try {
		await stat(dir);
		return true;
	} catch (e) {
		if (errCode(e) === "ENOENT") return false;
		throw e;
	}
}

async function removeIfEmpty(dir: string): Promise<void> {
	try {
		await rmdir(dir);
	} catch (e) {
		if (errCode(e) !== "ENOENT" && errCode(e) !== "ENOTEMPTY") throw e;
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
		typeof r.target === "string" &&
		typeof r.configHash === "string" &&
		typeof r.approvedAt === "string" &&
		Array.isArray(r.scope?.shadowedAgents)
	);
}

/**
 * Approvals of one native session for one canonical target: `<sessionDir>/approvals/<targetKey>/` holds
 * `approved/<hex>.json` (the record) and `snapshots/<hex>.json` (the approved config, for rollback and diffs).
 *
 * The target key is the full SHA-256 of the target's kind and canonical worktree root. Two linked worktrees of the
 * same repository therefore never see each other's approvals, and no approval, snapshot or shadow carries across a
 * target change. The store never reads or removes a pre-session layout under the profile: old approvals are neither
 * imported nor deleted, including by `clear()`.
 */
export class ApprovalStore {
	/** The profile-level session store this approval belongs to. */
	readonly sessionDir: string;
	/** Canonical target binding: `<kind>\0<resolved root>` hashed whole. */
	readonly targetKey: string;
	/** `<sessionDir>/approvals/<targetKey>`; only approvals for this session and this target. */
	readonly dir: string;
	private readonly approvalsRoot: string;
	private readonly targetRoot: string;

	constructor(sessionDir: string, repo: RepoIdentity) {
		if (typeof sessionDir !== "string" || sessionDir.trim() === "") throw new Error("세션 저장소 디렉터리가 없습니다");
		if (typeof repo?.root !== "string" || repo.root.trim() === "") throw new Error("승인 대상 작업 트리가 없습니다");
		this.sessionDir = sessionDir;
		let root: string;
		try {
			root = realpathSync(repo.root);
		} catch {
			root = path.resolve(repo.root);
		}
		this.targetKey = sha256Hex(`${repo.kind}\0${root}`);
		this.targetRoot = root;
		this.approvalsRoot = path.join(sessionDir, "approvals");
		this.dir = path.join(this.approvalsRoot, this.targetKey);
	}

	private approvedPath(hex: string): string {
		return path.join(this.dir, "approved", `${hex}.json`);
	}

	private snapshotPath(hex: string): string {
		return path.join(this.dir, "snapshots", `${hex}.json`);
	}

	/** Fails closed before any read or write if the physical store or this target moved outside its approved scope. */
	private async guard(): Promise<void> {
		await assertSessionStoreSafe(this.sessionDir, this.targetRoot, [
			this.dir,
			path.join(this.dir, "approved"),
			path.join(this.dir, "snapshots"),
		]);
	}

	private async withLock<T>(fn: () => Promise<T>): Promise<T> {
		// One lock for the whole session store: reset must not interleave with an approval of another target in the
		// same session, and the lock outlives the target directories it may remove.
		const lockPath = path.join(this.approvalsRoot, ".lock");
		const deadline = Date.now() + LOCK_TIMEOUT_MS;
		for (;;) {
			if (Date.now() >= deadline) throw new Error("승인 저장소 잠금을 얻지 못했습니다");
			try {
				// Inside the loop: `clear()` in another process removes the directory once it is empty, also while this one waits.
				await mkdir(this.approvalsRoot, { recursive: true });
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

	/** The approval of exactly this config hash for this session and target, if the user gave one. */
	async active(configHash: string): Promise<ApprovalRecord | undefined> {
		await this.guard();
		const value = await readJson(this.approvedPath(hexOf(configHash)));
		// A record copied under another hash's name or another target's file must not approve this target.
		return isApproval(value) && value.target === this.targetKey && value.configHash === configHash ? value : undefined;
	}

	async approve(input: { configHash: string; config: StormConfig; scope: ApprovalScope }): Promise<ApprovalRecord> {
		const hex = hexOf(input.configHash);
		await this.guard();
		return this.withLock(async () => {
			const record: ApprovalRecord = {
				schema: "storm.approval/v1",
				status: "active",
				target: this.targetKey,
				configHash: input.configHash,
				approvedAt: new Date().toISOString(),
				scope: { shadowedAgents: input.scope.shadowedAgents },
			};
			await writeTextAtomic(this.snapshotPath(hex), serializeConfig(input.config));
			await writeJsonAtomic(this.approvedPath(hex), record);
			return record;
		});
	}

	/** Every approval of this session and target, newest first. */
	async list(): Promise<ApprovalRecord[]> {
		await this.guard();
		const dir = path.join(this.dir, "approved");
		const out: ApprovalRecord[] = [];
		for (const name of await hexFiles(dir)) {
			const value = await readJson(path.join(dir, name));
			const hash = `${HASH_PREFIX}${name.slice(0, -5)}`;
			if (isApproval(value) && value.target === this.targetKey && value.configHash === hash) out.push(value);
		}
		return out.sort((a, b) => {
			if (a.approvedAt !== b.approvedAt) return a.approvedAt < b.approvedAt ? 1 : -1;
			return a.configHash < b.configHash ? 1 : a.configHash > b.configHash ? -1 : 0;
		});
	}

	async snapshot(configHash: string): Promise<StormConfig | undefined> {
		await this.guard();
		const value = await readJson(this.snapshotPath(hexOf(configHash)));
		return typeof value === "object" && value !== null ? (value as StormConfig) : undefined;
	}

	/**
	 * Keeps the record and snapshot of `keepHash` plus the newest `keep` other hashes for this target, and removes
	 * Storm's empty target directories. It never reads or removes a pre-session layout and never touches files it did
	 * not write itself. Returns how many files it removed.
	 */
	async prune(keepHash: string | null, keep = 20): Promise<number> {
		const keepHex = keepHash === null ? undefined : hexOf(keepHash);
		await this.guard();
		// withLock creates the root; a session without approvals must stay without one.
		if (!(await dirExists(this.dir))) return 0;
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
			for (const kind of ["approved", "snapshots"] as const) await removeIfEmpty(path.join(this.dir, kind));
			await removeIfEmpty(this.dir);
			return removed;
		});
	}

	/**
	 * `/storm reset`: deletes every approval and snapshot of THIS session, across its targets, and returns how many
	 * approvals there were. Other sessions, session state/history (`<sessionDir>/state`), unknown files and every
	 * pre-session approval directory stay byte-untouched: old data is never read, imported or deleted.
	 */
	async clear(): Promise<number> {
		await this.guard();
		if (!(await dirExists(this.approvalsRoot))) return 0;
		const count = await this.withLock(async () => {
			let approvals = 0;
			for (const entry of await readdir(this.approvalsRoot, { withFileTypes: true })) {
				if (!entry.isDirectory() || !TARGET_DIR_RE.test(entry.name)) continue;
				const dir = path.join(this.approvalsRoot, entry.name);
				for (const name of await hexFiles(path.join(dir, "approved"))) {
					const record = await readJson(path.join(dir, "approved", name));
					const hash = `${HASH_PREFIX}${name.slice(0, -5)}`;
					if (isApproval(record) && record.target === entry.name && record.configHash === hash) approvals++;
				}
				for (const kind of ["approved", "snapshots"] as const) await rm(path.join(dir, kind), { recursive: true, force: true });
				await removeIfEmpty(dir);
			}
			return approvals;
		});
		// Nothing left to keep: leave no empty directory behind.
		await removeIfEmpty(this.approvalsRoot);
		return count;
	}
}
