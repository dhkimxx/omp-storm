#!/usr/bin/env bun
/**
 * The release gate of decision D3 (0.28.0): Storm loaded from a folder that has no `node_modules` of its own, on a real omp, with a
 * director edit that really goes through the target reader. Real host, isolated HOME/profile, the local fake LLM. No paid calls.
 *
 * 0.28.0's reader of an edit call's targets (`src/policy/director-targets.ts`) imports host packages that Storm did not import
 * before: `@oh-my-pi/pi-natives` (the native `editInspect`, the parser omp itself reads an edit payload with) and four internal
 * subpaths of `@oh-my-pi/pi-coding-agent` (`edit/magic`, `tools/hashline-header-path`, `tools/path-utils`, `extensibility/settings`).
 * The tests run from the repository, where `node_modules` has all of them; an installed plugin has none. How omp resolves a plugin's
 * `@oh-my-pi/*` imports: it rewrites each one to the host's own copy at load time (`legacy-pi-compat.ts`: a Bun resolve hook for the
 * canonical scope, backed in a compiled binary by the modules bundled into it), so the question is whether each name is among the
 * ones that mapping reaches in this binary. Static imports fail the whole extension at load when one is not, so "Storm loads" is the
 * first check; what the reader then does with real calls is the second:
 *
 *   - a hashline payload, an apply_patch payload and a magic-mode payload that name `.git/config` are refused with the internal cause
 *     (only possible if the native parser and the magic reader returned the real path from the payload);
 *   - an `ast_edit` whose scope is under `.git` is refused (the host's own search-path parser);
 *   - a `write` of a plain in-tree file passes, and the tree has it.
 *
 * Usage (the plugin copy lives under E2E_WORK, which must be a literal /tmp path or any folder with no `node_modules` above it):
 *   E2E_PORT=18832 E2E_WORK=/tmp/storm-e2e-plugin-layout ./node_modules/.bin/bun scripts/e2e/plugin-layout.ts
 *   OMP_BIN=/Users/me/.local/bin/omp E2E_PORT=18832 E2E_WORK=/tmp/storm-e2e-plugin-layout-user ./node_modules/.bin/bun scripts/e2e/plugin-layout.ts
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DIRECTOR_EDIT_CAUSES } from "../../src/policy/director.ts";
import { contractPlan, requiredResult } from "./contract-fixture.ts";
import { cancelAll, LlmCursor, type LlmEntry, prepare, ROOT, startFakeLlm, type Step, Suite } from "./harness.ts";
import { installProfile, runRequest, Sessions, setOmpSettings } from "./phase1-kit.ts";

const env = prepare("storm-e2e-plugin-layout", 18832);
const suite = new Suite(`E2E (Storm installed with no node_modules: ${env.omp})`, env);
const check = suite.check.bind(suite);
const sessions = new Sessions(env);

/** The plugin as an install puts it: the files `package.json` ships, and no dependency folder anywhere above or inside them. */
function installPlugin(): string {
	const target = join(env.work, "installed", "omp-storm");
	mkdirSync(target, { recursive: true });
	for (const name of ["src", "agents", "priors", "package.json"]) cpSync(join(ROOT, name), join(target, name), { recursive: true });
	return target;
}

function nodeModulesAbove(folder: string): string | undefined {
	for (let at = folder; ; at = dirname(at)) {
		if (existsSync(join(at, "node_modules"))) return join(at, "node_modules");
		if (dirname(at) === at) return undefined;
	}
}

const answerTo = (main: readonly LlmEntry[], needle: string): string => {
	const at = main.findIndex(entry => entry.decision.tool !== undefined && JSON.stringify(entry.decision.all ?? [entry.decision]).includes(needle));
	return at < 0 ? "" : (main[at + 1]?.trailingResults[0] ?? "");
};

async function main(): Promise<void> {
	const plugin = installPlugin();
	process.env.E2E_PLUGIN_ROOT = plugin;
	setOmpSettings(env, "");
	installProfile(env);
	console.log(`HOST-FACT layout: ${JSON.stringify({ omp: env.omp, version: env.ompVersion, plugin, nodeModulesInside: existsSync(join(plugin, "node_modules")), nodeModulesAbove: nodeModulesAbove(plugin) ?? null })}`);
	check("the installed copy has no node_modules of its own, and none sits above it", !existsSync(join(plugin, "node_modules")) && nodeModulesAbove(plugin) === undefined, `above=${nodeModulesAbove(plugin) ?? "none"}`);

	await suite.step("Storm loads from that folder: the profile has the plugin and the team is approved", async () => {
		const { teams } = await sessions.approve("off");
		check("the team was approved: /storm ran, so the extension (and every static import of the reader) loaded", teams === 1, `approvals=${teams}`);
	}, 120_000, { always: true });

	await suite.step("a director edit goes through the reader of the installed Storm", async () => {
		await sessions.open(cancelAll, async (rpc, files) => {
			const steps: Step[] = [
				contractPlan([{ name: "A", kind: "code", role: "implementer", files: ["a.txt"], goal: "write a.txt", results: [requiredResult("a-change", "change", "a.txt is the worker's change", { path: "a.txt", contains: "storm child change" })] }], { contract: true, workers: { implementer: 1 } }),
				{ call: "edit", args: { input: "[.git/config#ABCD]\n1:x=1\n" } },
				{ call: "edit", args: { input: "*** Begin Patch\n*** Update File: .git/HEAD\n@@\n-a\n+b\n*** End Patch" } },
				{ call: "edit", args: { input: "# .git/config\nrename foo to bar" } },
				{ call: "ast_edit", args: { paths: [".git"], ops: [{ pat: "a", out: "b" }] } },
				{ call: "write", args: { path: "layout-ok.txt", content: "written through the installed Storm\n" } },
			];
			const llm = new LlmCursor(env);
			const before = files.runIds();
			await rpc.prompt(runRequest(steps), 120_000);
			await files.finishedRun(before, 90_000);
			const main = llm.of("main");
			const internal = (needle: string): boolean => {
				const text = answerTo(main, needle);
				return text.includes("[storm:director-edit]") && text.includes(DIRECTOR_EDIT_CAUSES.internal);
			};
			const tail = (needle: string): string => answerTo(main, needle).slice(0, 300);
			check("a hashline payload naming .git/config is refused with the internal cause: the native parser read the real path", internal("ABCD"), tail("ABCD"));
			check("an apply_patch payload naming .git/HEAD is refused with the internal cause", internal("*** Begin Patch"), tail("*** Begin Patch"));
			check("a magic-mode style payload naming .git/config is refused with the internal cause (the union of every parser's reading)", internal("# .git/config"), tail("# .git/config"));
			const ast = answerTo(main, '".git"');
			check("an ast_edit scoped under .git is refused with the internal cause (the host's search-path parser)", ast.includes("[storm:director-edit]") && ast.includes(DIRECTOR_EDIT_CAUSES.internal), ast.slice(0, 300));
			const ok = answerTo(main, "layout-ok.txt");
			check("a write of a plain in-tree file passes and the tree has it", !ok.includes("[storm:") && existsSync(join(env.project, "layout-ok.txt")) && readFileSync(join(env.project, "layout-ok.txt"), "utf8").includes("installed Storm"), ok.slice(0, 300));
		});
	}, 240_000);

	await suite.step("nothing was written to the installed folder and omp printed nothing about a missing module", async () => {
		const fresh = readdirSync(plugin).sort().join(",");
		check("the installed folder still holds only what was copied", fresh === ["agents", "package.json", "priors", "src"].sort().join(","), fresh);
		const logs = readdirSync(env.logs).filter(name => name.endsWith(".stderr.log"));
		const noisy = logs.filter(name => /Cannot find|not found|Unresolvable|resolve/i.test(readFileSync(join(env.logs, name), "utf8")));
		check("no omp process complained of an import it could not resolve", noisy.length === 0, noisy.join(", "));
		check("every OMP session exited cleanly", sessions.exitCodes.length > 0 && sessions.exitCodes.every(code => code === 0), `exit=${sessions.exitCodes.join(",")}`);
	}, 60_000, { always: true });
}

let code = 1;
const server = await startFakeLlm(env);
try {
	await main();
} catch (error) {
	suite.check("harness", false, error instanceof Error ? (error.stack ?? error.message) : String(error));
} finally {
	server.kill();
	await server.exited;
	code = suite.finish();
}
process.exit(code);
