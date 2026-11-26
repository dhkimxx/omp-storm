/**
 * What omp loads (`package.json` → `omp.extensions`). Storm's screens are built on the UI library of omp 19.2, and
 * `tui/kit.ts` is the one file that imports it. A host whose library lacks those names fails that import with an error
 * about a missing export, which a user cannot act on. This file imports nothing that depends on the library: it loads
 * `kit.ts` first, and loads the extension only when that works. Otherwise it registers `/storm` with one message.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

/** Said to a user whose omp cannot load Storm's screen layer. */
export const NEEDS_NEWER_OMP =
	"이 Storm(0.25 이상)은 OMP 19.2 이상용입니다. 지금 OMP에서는 화면 라이브러리를 불러오지 못해 동작하지 않습니다. OMP를 올리거나, OMP 19.0·19.1에서는 Storm 0.24.0(`release/omp-19.0`)을 쓰세요.";

/** Whether the host can load Storm's screen layer. */
async function screenLayerLoads(): Promise<boolean> {
	try {
		await import("./tui/kit.ts");
		return true;
	} catch {
		return false;
	}
}

export default async function storm(pi: ExtensionAPI, loads: () => Promise<boolean> = screenLayerLoads): Promise<void> {
	if (!(await loads())) {
		pi.registerCommand("storm", {
			description: "Storm은 이 OMP에서 쓸 수 없습니다 (OMP 19.2 이상 필요)",
			handler: async (_args, ctx) => {
				ctx.ui.notify(NEEDS_NEWER_OMP, "error");
			},
		});
		return;
	}
	const { default: load } = await import("./extension.ts");
	load(pi);
}
