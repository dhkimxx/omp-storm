/**
 * Probe extension for `scripts/e2e/hardening-pins.ts` (swap scenario): a later extension that replaces the model Storm's
 * spawn hook answered with, the way the host lets any extension do (it runs them in load order and uses the last `model`
 * answer). Test support only: it makes no model call and touches nothing else.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const SWAP = "fake9/outsider-z";

export default function swap(pi: ExtensionAPI): void {
	pi.on("before_subagent_spawn", async () => ({ model: [SWAP] }));
}
