#!/usr/bin/env bun
/**
 * Citation aliases on the real host (R13): an answer citing `notes.txt#L12`, `notes.txt#L12-L20`, a Markdown link
 * `[source](notes.txt#L12)` and the plain `notes.txt:12` is accepted exactly as `path:12` is; an invalid coordinate
 * (`notes.txt#L99`, past the file) is never read as a path-only citation, so its answer stays unmet.
 *
 * The evaluator is the product's own: the assertions read the official result rows, not the fake model's text.
 *
 * Usage:
 *   E2E_PORT=18907 E2E_WORK=/tmp/storm-e2e-citation-aliases ./node_modules/.bin/bun scripts/e2e/citation-aliases.ts
 */
import { FACT_CLAIM, FACT_FILE, FACT_LINE, seedFact } from "./typed-fixture.ts";
import { APPROVE } from "../../src/proposals/present.ts";
import { choose, LlmCursor, prepare, startFakeLlm, Suite, type Step } from "./harness.ts";
import { installProfile, Sessions } from "./phase1-kit.ts";

const env = prepare("storm-e2e-citation-aliases", 18907);
const suite = new Suite("E2E (citation aliases)", env);
const check = suite.check.bind(suite);
const sessions = new Sessions(env);
const FILE = FACT_FILE;
const LITERAL = FACT_LINE;
const BASE = FACT_CLAIM.slice(0, FACT_CLAIM.lastIndexOf("(")).trim();

const answer = (id: string) => ({ id, kind: "answer" as const, criterion: "the answer states the cited line and cites its source", path: FILE, contains: LITERAL });
const cases = [
	{ lane: "alias-hash", claim: `${BASE} (${FILE}#L1)` },
	{ lane: "alias-range", claim: `${BASE} (${FILE}#L1-L20)` },
	{ lane: "alias-markdown", claim: `${BASE} ([source](${FILE}#L1))` },
	{ lane: "alias-plain", claim: `${BASE} (${FILE}:1)` },
	{ lane: "alias-invalid", claim: `${BASE} (${FILE}#L99)` },
] as const;

async function main(): Promise<void> {
	seedFact(env.project);
	installProfile(env);
	await suite.step("approved team with a team that allows five explorers, automatic delegation on", async () => {
		await sessions.open(() => undefined, async (rpc, files) => {
			await rpc.prompt("/storm");
			rpc.answer = choose(APPROVE);
			await rpc.prompt("/storm");
			files.editConfig(config => {
				(config.roles.explorer as unknown as Record<string, unknown>).workers = { min: 1, max: 6 };
			});
			await rpc.prompt("/storm");
			rpc.answer = () => undefined;
			// A real turn materializes the native transcript so the next scenario can resume this exact session.
			await rpc.turn("hello");
			check("the team was approved with five explorers allowed", files.config().roles.explorer?.workers !== undefined && files.approvals().length >= 2, `approvals=${files.approvals().length}`);
		});
	}, 180_000, { always: true });

	await suite.step("each alias is read as its path:line, and an invalid coordinate is not a citation", async () => {
		const llm = new LlmCursor(env);
		await sessions.open(() => undefined, async (rpc, files) => {
			const before = files.runIds();
			const steps: Step[] = [
				{
					storm: {
						action: "plan",
						plan: { lanes: cases.map(item => ({ name: item.lane, kind: "explore", role: "explorer", results: [answer(`${item.lane}-answer`)] })) },
					},
				},
				{
					tasks: cases.map(item => ({
						name: item.lane,
						agent: "storm-explorer",
						task: "Read the cited line from source",
						say: `E2E-CHILD-READ ${FILE} E2E-CHILD-CLAIM ${item.claim}`,
					})),
				},
				{ wait: true },
			];
			await rpc.turn(`E2E-STEPS ${JSON.stringify(steps)}`, 240_000);
			const run = await files.finishedRun(before, 240_000);
			const row = (id: string) => (run.results ?? []).find(result => result.id === id);
			const accepted = cases.filter(item => item.lane !== "alias-invalid").map(item => row(`${item.lane}-answer`)?.state);
			check(
				"all five items were placed on their lanes and reached the provider",
				cases.every(item => (run.spawns ?? []).some(spawn => spawn.lane === item.lane && spawn.outcome !== "blocked")) && llm.of("child").length >= cases.length,
				JSON.stringify(run.spawns.map(spawn => [spawn.spawnKey, spawn.lane, spawn.outcome])),
			);
			check(
				"`path#L12`, the range, the Markdown link and `path:12` are all accepted exactly alike",
				accepted.every(state => state === "accepted"),
				JSON.stringify(cases.map(item => [item.lane, row(`${item.lane}-answer`)?.state, row(`${item.lane}-answer`)?.reason ?? ""])),
			);
			const invalid = row("alias-invalid-answer");
			check(
				"an invalid coordinate is not a citation: the answer is unmet, never accepted on its path alone",
				invalid?.state !== "accepted" && (invalid?.reason ?? "").trim() !== "",
				JSON.stringify(invalid ?? null),
			);
		});
	}, 400_000);

	await suite.step("every omp session exited cleanly", async () => {
		check("no session exited non-zero", sessions.exitCodes.length > 0 && sessions.exitCodes.every(code => code === 0), `exit=${sessions.exitCodes.join(",")}`);
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
