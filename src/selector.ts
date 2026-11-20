import { EFFORTS, type Effort } from "./types.ts";

/** One entry of a role's model list: "provider/id" plus an optional thinking effort, written "provider/id:<effort>" as omp model patterns take it. */
export interface ModelEntry {
	selector: string;
	effort?: Effort;
}

/** Splits a trailing ":<effort>" only when it is a known effort, so ids such as "x:thinking" stay intact. */
export function parseModelEntry(entry: string): ModelEntry {
	const colon = entry.lastIndexOf(":");
	if (colon > entry.lastIndexOf("/")) {
		const suffix = entry.slice(colon + 1);
		const effort = EFFORTS.find(level => level === suffix);
		if (effort) return { selector: entry.slice(0, colon), effort };
	}
	return { selector: entry };
}

export function formatModelEntry(entry: ModelEntry): string {
	return entry.effort ? `${entry.selector}:${entry.effort}` : entry.selector;
}

/** The effort an entry runs with: its own suffix, else the role default (configs written before per-model effort). */
export function entryEffort(entry: string, roleDefault: Effort | undefined): Effort | undefined {
	return parseModelEntry(entry).effort ?? roleDefault;
}
