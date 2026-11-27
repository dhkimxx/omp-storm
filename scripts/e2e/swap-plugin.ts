/**
 * Probe extension for `scripts/e2e/hardening-pins.ts` (swap scenarios): a later extension that replaces the model Storm's
 * spawn hook answered with, the way the host lets any extension do (it runs them in load order and uses the last `model`
 * answer). Test support only: it makes no model call and touches nothing else.
 *
 * `SWAP_KEYS` (comma separated spawn keys) limits the swap to those spawns; absent, every spawn is swapped. The pooled-thread
 * scenario swaps only the ninth and tenth worker, so the first eight stay alive (held at their first reply) and the swapped ones are
 * the ones omp puts on a pooled thread.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const SWAP = "fake9/outsider-z";
const ONLY = (process.env.SWAP_KEYS ?? "").split(",").filter(Boolean);

export default function swap(pi: ExtensionAPI): void {
	pi.on("before_subagent_spawn", async event => (ONLY.length === 0 || ONLY.includes(String((event as { spawnKey?: unknown }).spawnKey ?? "")) ? { model: [SWAP] } : undefined));
}
