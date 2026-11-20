import { parseModelEntry } from "./selector.ts";
import type { EvidenceRecord, Priority, RoleRecommendation, StormConfig } from "./types.ts";

/** Snapshot of the recommendation behind an approved config: what was chosen per role and why the rest lost. */
export function buildEvidence(input: {
	source: EvidenceRecord["source"];
	priority: Priority;
	dataAsOf: number | null;
	recommendations: RoleRecommendation[];
	config: StormConfig;
	now: number;
}): EvidenceRecord {
	const roles: EvidenceRecord["roles"] = {};
	for (const rec of input.recommendations) {
		const first = input.config.roles[rec.role.id]?.models[0];
		roles[rec.role.id] = {
			chosen: first === undefined ? null : parseModelEntry(first).selector,
			candidates: rec.candidates.map(c => ({
				selector: c.selector,
				label: c.label,
				validated: c.validated,
				int: c.int.value,
				speed: c.speed.value,
				referenceUsd: c.referenceUsd,
				why: [...c.why],
				whyNot: [...c.whyNot],
			})),
		};
	}
	return {
		schema: "storm.evidence/v1",
		createdAt: new Date(input.now).toISOString(),
		source: input.source,
		priority: input.priority,
		dataAsOf: input.dataAsOf,
		roles,
	};
}
