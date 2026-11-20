/**
 * Deferred proposals under `<root>/.omp/storm/state/proposals/<id>.json`. A proposal is only
 * offered while the config it was built on is current; stale ones are deleted on listing.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { StormToolHost } from "../tool/host.ts";
import type { Proposal } from "../types.ts";

const ID_RE = /^[A-Za-z0-9._-]+$/;

function isProposal(v: unknown): v is Proposal {
	if (typeof v !== "object" || v === null) return false;
	const p = v as Record<string, unknown>;
	return (
		p.schema === "storm.proposal/v1" &&
		typeof p.id === "string" &&
		ID_RE.test(p.id) &&
		typeof p.kind === "string" &&
		typeof p.createdAt === "string" &&
		typeof p.summary === "string" &&
		typeof p.baseHash === "string" &&
		typeof p.config === "object" &&
		p.config !== null
	);
}

export function createProposalStore(root: string, currentHash: () => Promise<string | null>): StormToolHost["proposals"] {
	const dir = path.join(root, ".omp", "storm", "state", "proposals");
	const fileOf = (id: string): string => {
		if (!ID_RE.test(id)) throw new Error(`잘못된 제안 ID: ${id}`);
		return path.join(dir, `${id}.json`);
	};
	return {
		async list() {
			let names: string[];
			try {
				names = await fs.readdir(dir);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
				throw error;
			}
			const hash = await currentHash();
			const out: Proposal[] = [];
			for (const name of names) {
				if (!name.endsWith(".json")) continue;
				const file = path.join(dir, name);
				let parsed: unknown;
				try {
					parsed = JSON.parse(await fs.readFile(file, "utf8"));
				} catch {
					continue;
				}
				if (!isProposal(parsed)) continue;
				if (parsed.baseHash !== hash) await fs.rm(file, { force: true });
				else out.push(parsed);
			}
			return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
		},
		async save(proposal) {
			const file = fileOf(proposal.id);
			await fs.mkdir(dir, { recursive: true });
			const tmp = path.join(dir, `.${proposal.id}.${process.pid}.${crypto.randomUUID()}.tmp`);
			try {
				await fs.writeFile(tmp, `${JSON.stringify(proposal, null, 2)}\n`);
				await fs.rename(tmp, file);
			} catch (error) {
				await fs.rm(tmp, { force: true });
				throw error;
			}
		},
		async remove(id) {
			await fs.rm(fileOf(id), { force: true });
		},
	};
}
