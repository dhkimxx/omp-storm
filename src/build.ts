/**
 * Identity of this build of Storm.
 *
 * Two copies of Storm can be loaded into one host thread (an isolated subagent loads its own copy of the plugin) and
 * two different builds can be loaded together. In-memory state and persisted worker admissions are facts about one
 * build's protocol: a copy of another build must find nothing it can read and fail closed, while two copies of the same
 * build must keep sharing them (a separately loaded reviewer keeps its tree proof across a follow-up). The identity is
 * therefore a digest of the plugin's own source and agent definitions plus the package version, not a constant someone
 * has to bump. A tree that cannot be read gets a unique identity: sharing state with an unreadable build is not a fact
 * Storm can establish.
 */
import { createHash, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { STORM_VERSION } from "./roles.ts";

/** Bumped only when the on-disk or in-memory protocol changes shape in a way the source digest cannot see. */
const PROTOCOL = "storm-shared-state/v3";
const ROOT = fileURLToPath(new URL("../", import.meta.url));

function filesUnder(dir: string): string[] {
	const out: string[] = [];
	const walk = (current: string): void => {
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const full = join(current, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.isFile()) out.push(full);
		}
	};
	walk(join(ROOT, dir));
	return out;
}

function fingerprint(): string {
	try {
		const files = [...filesUnder("src"), ...filesUnder("agents")]
			.map(file => relative(ROOT, file).split(sep).join("/"))
			.sort();
		const hash = createHash("sha256");
		hash.update(`${STORM_VERSION}\u0000${PROTOCOL}\u0000`);
		for (const file of files) {
			hash.update(file);
			hash.update("\u0000");
			hash.update(readFileSync(join(ROOT, file)));
			hash.update("\u0000");
		}
		return `${STORM_VERSION}:${hash.digest("hex").slice(0, 32)}`;
	} catch {
		// A build whose own files cannot be read is not a build another copy may share state with.
		return `${STORM_VERSION}:${PROTOCOL}:${randomUUID()}`;
	}
}

/** This build's identity, the same for two loaded copies of the same tree and different for any other tree. */
export const STORM_BUILD = fingerprint();

/** Read at every use so a test can stand in another build without reloading the module. */
export function buildId(): string {
	return STORM_BUILD;
}
