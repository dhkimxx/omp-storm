/**
 * A map shared by every Storm module instance of one build on this host thread.
 *
 * Storm's module-level state is shared by every session in a process because the extension is normally one module
 * instance. omp does not always keep that: an isolated subagent is prepared with its extension paths cleared, so its
 * session can load a second instance of this plugin on the same thread with its own module state. The run's ledger,
 * spawn records, agent rows and write table are facts about the process, not about one instance of the module, so
 * they live on `globalThis` (which is per thread) under this build's identity. A pooled subagent worker has its own
 * `globalThis` and so sees none of them, which is what makes a worker there find no run and stop (decision D5); a copy
 * of another build is a different namespace, so the two never read each other's state (decision D7).
 */
import * as build from "../build.ts";

export function sharedMap<K, V>(name: string): Map<K, V> {
	const key = `${build.buildId()}\u0000${name}`;
	const root = globalThis as { __stormSharedMaps?: Map<string, Map<unknown, unknown>> };
	root.__stormSharedMaps ??= new Map();
	let map = root.__stormSharedMaps.get(key);
	if (map === undefined) {
		map = new Map();
		root.__stormSharedMaps.set(key, map);
	}
	return map as Map<K, V>;
}
