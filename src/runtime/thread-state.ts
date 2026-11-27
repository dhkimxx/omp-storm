/**
 * A map shared by every Storm module instance on this host thread.
 *
 * Storm's module-level state is shared by every session in a process because the extension is normally one module
 * instance. omp does not always keep that: an isolated subagent is prepared with its extension paths cleared, so its
 * session can load a second instance of this plugin on the same thread with its own module state. The run's ledger,
 * spawn records, agent rows and write table are facts about the process, not about one instance of the module, so
 * they live on `globalThis` (which is per thread). A pooled subagent worker has its own `globalThis` and so sees none
 * of them, which is what makes a worker there find no run and stop (decision D5).
 */
export function sharedMap<K, V>(name: string): Map<K, V> {
	const root = globalThis as { __stormSharedMaps?: Map<string, Map<unknown, unknown>> };
	root.__stormSharedMaps ??= new Map();
	let map = root.__stormSharedMaps.get(name);
	if (map === undefined) {
		map = new Map();
		root.__stormSharedMaps.set(name, map);
	}
	return map as Map<K, V>;
}
