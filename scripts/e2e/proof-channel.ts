#!/usr/bin/env bun
/**
 * Native host result-channel proof, real omp: a disposable git checkout, an isolated HOME/profile and the local fake
 * LLM. It answers what a trusted parent extension can observe without polling a child or trusting its prose:
 *
 * - the synchronous `task` tool result (`SingleResult[]`) for a same-thread and a worker-homed child, including
 *   `exitCode`, `error`, `structuredOutput`, `outputPath` and an isolated child's `patchPath`;
 * - the asynchronous `async-result` custom message and its per-job `jobId`/`agentId`/`status`/`schema`, including a
 *   worker-homed batch;
 * - host failure even when the child's text claims success (a strict schema violation), and a task child's
 *   text-only result that is not verifiable by itself;
 * - artifact handles the parent process can open at the moment each native result arrives;
 * - job identity across a follow-up (new `jobId`, same `agentId`) and across a provider retry (one job, one delivery).
 *
 * The probe extension (`proof-plugin.ts`) records what the parent runtime saw. It makes no model call; every value
 * below comes from a host event or the process-global AgentRegistry, never from a model report.
 *
 * Usage: E2E_PORT=18784 ./node_modules/.bin/bun scripts/e2e/proof-channel.ts
 * The default work dir is <tmp>/storm-e2e-proof; E2E_WORK/E2E_PORT/E2E_KEEP apply as in the other E2E drivers.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	cancelAll,
	LlmCursor,
	modelsYml,
	prepare,
	PROFILE_CONFIG,
	readJsonl,
	Rpc,
	Suite,
	startFakeLlm,
	TEAM_PROVIDERS,
	until,
	type Frame,
	type LlmEntry,
} from "./harness.ts";

interface Schema {
	source?: string;
	mode?: string;
	status?: string;
	data?: unknown;
	error?: string;
}
interface Artifact {
	path?: string;
	exists?: boolean;
	bytes?: number;
	head?: string;
}
interface ResultInfo {
	id?: string;
	index?: number;
	agent?: string;
	exitCode?: number;
	error?: string;
	aborted?: boolean;
	isolated?: boolean;
	outputPath?: string;
	patchPath?: string;
	hasRootChanges?: boolean;
	outputArtifact?: Artifact;
	patchArtifact?: Artifact;
	structuredOutput?: Schema;
}
interface TaskDetails {
	async?: { state?: string; jobId?: string; type?: string };
	results?: ResultInfo[];
	progress?: Array<{ id?: string; index?: number; status?: string }>;
}
interface RegistryFact {
	id?: string;
	kind?: string;
	status?: string;
	parentId?: string;
	home?: string;
	history?: { outputPath?: string; patchPath?: string; nestedPatchPaths?: string[] };
	outputArtifact?: Artifact;
	patchArtifact?: Artifact;
}
interface ProofLine {
	type?: string;
	threadId?: number;
	eventType?: string;
	id?: string;
	status?: string;
	home?: string;
	history?: { outputPath?: string; patchPath?: string };
	outputArtifact?: Artifact;
	patchArtifact?: Artifact;
	toolName?: string;
	toolCallId?: string;
	customType?: string;
	content?: string;
	input?: { path?: string; tasks?: Array<{ name?: string }> };
	details?: TaskDetails;
	registry?: RegistryFact[];
	agent?: { id?: string; kind?: string; parentId?: string };
}
interface Job {
	frame: Frame;
	jobId: string;
	agentId?: string;
	status?: string;
	schema?: Schema;
	label?: string;
}

const env = prepare("storm-e2e-proof", 18784);
const suite = new Suite("E2E (native host result channel)", env);
const check = suite.check.bind(suite);
const plugin = join(import.meta.dir, "proof-plugin.ts");
const proofLog = join(env.work, "proof.jsonl");
env.childEnv.PROOF_CHANNEL_LOG = proofLog;

/** Both native result surfaces need structured task results; only the async scenarios need background jobs. */
function configure(asyncEnabled: boolean): void {
	const task = [
		"task:",
		"  batch: true",
		"  structured: true",
		"  workerThreads: 4",
		"  maxConcurrency: 12",
		"  isolation:",
		"    enabled: true",
		"    apply: false",
	];
	writeFileSync(join(env.agentDir, "config.yml"), `${PROFILE_CONFIG}${task.join("\n")}\nasync:\n  enabled: ${asyncEnabled}\n`);
}

function proof(): ProofLine[] {
	return readJsonl<ProofLine>(proofLog);
}

function messageOf(frame: Frame): { customType?: string; content?: unknown; details?: unknown } | undefined {
	return frame.message !== null && typeof frame.message === "object" ? frame.message : undefined;
}

/** The delivered text of a custom message; the native result body, not its JSON wrapper. */
function textOf(frame: Frame | undefined): string {
	const content = frame === undefined ? undefined : messageOf(frame)?.content;
	return typeof content === "string" ? content : "";
}

/** Delivered background jobs, in delivery order: one `async-result` may batch several `.md` sections. */
function asyncJobs(frames: readonly Frame[]): Job[] {
	const jobs: Job[] = [];
	for (const frame of frames) {
		// message_start carries the same custom message before delivery; only message_end is the delivered result.
		if (frame.type !== "message_end") continue;
		const message = messageOf(frame);
		if (message?.customType !== "async-result") continue;
		const details = message.details;
		if (details === null || typeof details !== "object" || !("jobs" in details) || !Array.isArray(details.jobs)) continue;
		for (const value of details.jobs) {
			if (value === null || typeof value !== "object") continue;
			const job = value as Record<string, unknown>;
			if (typeof job.jobId !== "string") continue;
			const entry: Job = { frame, jobId: job.jobId };
			if (typeof job.agentId === "string") entry.agentId = job.agentId;
			if (typeof job.status === "string") entry.status = job.status;
			if (typeof job.label === "string") entry.label = job.label;
			if (job.schema !== null && typeof job.schema === "object") entry.schema = job.schema as Schema;
			jobs.push(entry);
		}
	}
	return jobs;
}

/** The latest registry snapshot naming `id`; the parent-side mirror includes a worker-homed child's home. */
function factOf(id: string): RegistryFact | undefined {
	return proof()
		.flatMap(line => line.registry ?? [])
		.filter(fact => fact.id === id)
		.at(-1);
}

function resultOf(details: TaskDetails | undefined, id: string): ResultInfo | undefined {
	return details?.results?.find(result => result.id === id);
}

function artifactReport(artifact: Artifact | undefined): string {
	return artifact === undefined ? "missing" : `exists=${artifact.exists} bytes=${artifact.bytes ?? "?"} head=${JSON.stringify((artifact.head ?? "").slice(0, 80))}`;
}

async function session<T>(body: (rpc: Rpc) => Promise<T>): Promise<T> {
	const rpc = new Rpc(env, cancelAll, { model: "fake/general-b", flags: ["-e", plugin], ephemeral: true });
	try {
		await rpc.ready();
		return await body(rpc);
	} finally {
		await rpc.close();
	}
}

const start = (steps: unknown[]): string => `E2E-STEPS ${JSON.stringify(steps)}`;
const REPORT_SCHEMA = {
	type: "object",
	properties: { summary: { type: "string" }, ok: { type: "boolean" } },
	required: ["summary", "ok"],
	additionalProperties: false,
};

async function main(): Promise<void> {
	writeFileSync(join(env.agentDir, "models.yml"), modelsYml(env.port, { fake: TEAM_PROVIDERS.fake }));
	const server = await startFakeLlm(env);
	try {
		await suite.step(
			"sync envelope: same-thread and worker-homed results carry exit status, structured output and artifacts",
			async () => {
				configure(false);
				await session(async rpc => {
					const tasks = [
						{
							name: "SyncGood",
							agent: "task",
							task: "sync proof",
							outputSchema: REPORT_SCHEMA,
							schemaMode: "strict",
							say: `E2E-CHILD-DELAY 600 E2E-CHILD-YIELD ${JSON.stringify({ summary: "sync done", ok: true })}`,
						},
						{
							name: "SyncBad",
							agent: "task",
							task: "sync proof",
							outputSchema: REPORT_SCHEMA,
							schemaMode: "strict",
							say: `E2E-CHILD-DELAY 600 E2E-CHILD-YIELD ${JSON.stringify({ summary: "SYNC CLAIMED SUCCESS" })}`,
						},
						{
							name: "SyncIsolated",
							agent: "task",
							task: "sync isolated proof",
							isolated: true,
							say: "E2E-CHILD-DELAY 600 E2E-CHILD-WRITE sync-isolated.txt",
						},
						...Array.from({ length: 6 }, (_, index) => ({
							name: `Sync${index}`,
							agent: "task",
							task: "sync proof",
							say: `E2E-CHILD-DELAY 600 E2E-CHILD-WRITE sync-${index}.txt`,
						})),
					];
					const frames = await rpc.turn(start([{ tasks }]), 120_000);
					const frame = frames.find(candidate => candidate.type === "tool_execution_end" && candidate.toolName === "task");
					const raw = frame?.result;
					const details =
						raw !== null && raw !== undefined && typeof raw === "object" && "details" in raw
							? (raw.details as TaskDetails)
							: undefined;
					const results = details?.results ?? [];
					const detailsText = JSON.stringify(results.map(result => [result.id, result.exitCode, result.structuredOutput?.status]));
					check("the sync task result lists all nine children", results.length === 9, detailsText);
					check("the task tool call has a native toolCallId", typeof frame?.toolCallId === "string" && frame.toolCallId !== "", `toolCallId=${frame?.toolCallId}`);
					const good = resultOf(details, "SyncGood");
					check(
						"a strict valid child is exit 0 with schema-valid data",
						good?.exitCode === 0 && good.structuredOutput?.status === "valid" && JSON.stringify(good.structuredOutput.data) === JSON.stringify({ summary: "sync done", ok: true }),
						JSON.stringify(good),
					);
					const bad = resultOf(details, "SyncBad");
					check(
						"a claiming child is exit 1 when its strict schema is invalid",
						bad?.exitCode === 1 && bad.structuredOutput?.status === "invalid" && bad.error?.includes("ok") === true,
						JSON.stringify({ exitCode: bad?.exitCode, error: bad?.error, schema: bad?.structuredOutput }),
					);
					const isolated = resultOf(details, "SyncIsolated");
					check(
						"an isolated child returns its own patch handle and root-change fact",
						isolated?.isolated === true && isolated.hasRootChanges === true && typeof isolated.patchPath === "string",
						JSON.stringify({ isolated: isolated?.isolated, patchPath: isolated?.patchPath, hasRootChanges: isolated?.hasRootChanges }),
					);
					check(
						"the parent process can read the isolated patch at tool-result time",
						isolated?.patchPath !== undefined && existsSync(isolated.patchPath) && readFileSync(isolated.patchPath, "utf8").includes("sync-isolated.txt"),
						`${isolated?.patchPath}`,
					);
					check(
						"the isolated change is not in the parent checkout",
						!existsSync(join(env.project, "sync-isolated.txt")),
						`parentFile=${existsSync(join(env.project, "sync-isolated.txt"))}`,
					);
					const lined = proof().filter(line => line.type === "tool_result" && line.toolName === "task");
					const recorded = lined.at(-1)?.details;
					const homes = (lined.at(-1)?.registry ?? []).filter(fact => fact.kind === "sub");
					const worker = homes.filter(fact => typeof fact.home === "string" && fact.home !== "main");
					check("the parent-side registry names at least one worker-homed child", worker.length > 0, JSON.stringify(homes.map(fact => [fact.id, fact.home])));
					check(
						"the sync result carries a worker-homed child with an artifact the parent can open",
						worker.every(fact => {
							const result = recorded?.results?.find(candidate => candidate.id === fact.id);
							return result !== undefined && result.outputArtifact?.exists === true;
						}),
						JSON.stringify(worker.map(fact => [fact.id, fact.home, recorded?.results?.find(result => result.id === fact.id)?.outputArtifact])),
					);
					check(
						"the input names, result ids and registry parent tie the same scope",
						tasks.every(task => results.some(result => result.id === task.name)) &&
							homes.every(fact => fact.parentId === "Main"),
						JSON.stringify({ input: tasks.map(task => task.name), results: results.map(result => result.id) }),
					);
					const artifacts = results.map(result => [result.id, recorded?.results?.find(candidate => candidate.id === result.id)?.outputArtifact] as const);
					const durable = artifacts.filter(([, artifact]) => artifact?.exists === true).map(([id]) => id);
					check(
						"the sync envelope reports an outputPath for every child",
						results.every(result => typeof result.outputPath === "string" && result.outputPath !== ""),
						JSON.stringify(results.map(result => [result.id, result.outputPath])),
					);
					// Baseline 19.0.1, and the check below passes on 19.2.1: a sync child's temp .md is removed before tool_result for non-isolated runs; the
					// isolated child keeps its output and patch. A caller must not treat every outputPath as durable.
					check(
						"only the isolated sync child's reported artifacts are readable at tool-result time",
						durable.length === 1 && durable[0] === "SyncIsolated",
						JSON.stringify({ durable, artifacts: artifacts.map(([id, artifact]) => [id, artifact?.exists]) }),
					);
				});
			},
			180_000,
		);

		await suite.step(
			"async envelope: a same-thread child reports status and schema in the delivered async-result",
			async () => {
				configure(true);
				await session(async rpc => {
					const tasks = [
						{
							name: "AsyncGood",
							agent: "task",
							task: "async proof",
							outputSchema: REPORT_SCHEMA,
							schemaMode: "strict",
							say: `E2E-CHILD-YIELD ${JSON.stringify({ summary: "async done", ok: true })}`,
						},
						{
							name: "AsyncBad",
							agent: "task",
							task: "async proof",
							outputSchema: REPORT_SCHEMA,
							schemaMode: "strict",
							say: `E2E-CHILD-YIELD ${JSON.stringify({ summary: "ASYNC CLAIMED SUCCESS" })}`,
						},
						{ name: "AsyncLarge", agent: "task", task: "async spill proof", say: "E2E-CHILD-BIG 13000" },
					];
					await rpc.prompt(start([{ tasks }]));
					await until(() => (asyncJobs(rpc.frames).length >= 3 ? true : undefined), 40_000, "three async results");
					const jobs = asyncJobs(rpc.frames);
					const good = jobs.find(job => job.agentId === "AsyncGood");
					const bad = jobs.find(job => job.agentId === "AsyncBad");
					const large = jobs.find(job => job.agentId === "AsyncLarge");
					check("all async jobs are delivered", good !== undefined && bad !== undefined && large !== undefined, JSON.stringify(jobs.map(job => [job.jobId, job.agentId, job.status])));
					check("the async job id identifies the same agent", good?.jobId === "AsyncGood" && bad?.jobId === "AsyncBad" && large?.jobId === "AsyncLarge", JSON.stringify(jobs.map(job => [job.jobId, job.agentId])));
					check(
						"the async job status is host authority, not the child's claim",
						good?.status === "completed" && good.schema?.status === "valid" && bad?.status === "failed" && bad.schema?.status === "invalid",
						JSON.stringify(jobs.map(job => [job.jobId, job.status, job.schema?.status, job.schema?.error])),
					);
					check(
						"the same-thread child's session identity says main",
						["AsyncGood", "AsyncBad", "AsyncLarge"].every(id => factOf(id)?.home === "main"),
						JSON.stringify(["AsyncGood", "AsyncBad", "AsyncLarge"].map(id => [id, factOf(id)?.home])),
					);
					check(
						"the delivered async result carries a readable output artifact in the parent",
						["AsyncGood", "AsyncBad", "AsyncLarge"].every(id => factOf(id)?.outputArtifact?.exists === true),
						JSON.stringify(["AsyncGood", "AsyncBad", "AsyncLarge"].map(id => [id, factOf(id)?.outputArtifact])),
					);
					const largeContent = textOf(large?.frame);
					const full = factOf("AsyncLarge")?.history?.outputPath;
					check(
						"a large child result is previewed with a native full-output handle, not pasted",
						largeContent.includes('<preview full-output="agent://AsyncLarge">') &&
							full !== undefined &&
							readFileSync(full, "utf8").length >= 12_000,
						`contentChars=${largeContent.length} full=${full === undefined ? "missing" : readFileSync(full, "utf8").length}`,
					);
					check("each job id is delivered once", new Set(jobs.map(job => job.jobId)).size === jobs.length, JSON.stringify(jobs.map(job => job.jobId)));
				});
			},
			120_000,
		);

		await suite.step(
			"worker envelope: a worker-homed batch reaches the parent, with isolated artifacts and a single retry delivery",
			async () => {
				configure(true);
				await session(async rpc => {
					const llm = new LlmCursor(env);
					const tasks = [
						{
							name: "WorkerGood",
							agent: "task",
							task: "worker proof",
							outputSchema: REPORT_SCHEMA,
							schemaMode: "strict",
							say: `E2E-CHILD-DELAY 700 E2E-CHILD-YIELD ${JSON.stringify({ summary: "worker done", ok: true })}`,
						},
						{
							name: "WorkerBad",
							agent: "task",
							task: "worker proof",
							outputSchema: REPORT_SCHEMA,
							schemaMode: "strict",
							say: `E2E-CHILD-DELAY 700 E2E-CHILD-YIELD ${JSON.stringify({ summary: "WORKER CLAIMED SUCCESS" })}`,
						},
						{
							name: "WorkerIsolated",
							agent: "task",
							task: "worker isolated proof",
							isolated: true,
							say: "E2E-CHILD-DELAY 700 E2E-CHILD-WRITE worker-isolated.txt",
						},
						{
							name: "WorkerRetry",
							agent: "task",
							task: "worker retry proof",
							say: "E2E-CHILD-DELAY 700 E2E-CHILD-429-ONCE retryWorker E2E-CHILD-CLAIM retried",
						},
						...Array.from({ length: 5 }, (_, index) => ({
							name: `Worker${index}`,
							agent: "task",
							task: "worker proof",
							say: `E2E-CHILD-DELAY 700 E2E-CHILD-WRITE worker-${index}.txt`,
						})),
					];
					await rpc.prompt(start([{ tasks }]));
					await until(() => (new Set(asyncJobs(rpc.frames).map(job => job.jobId)).size >= 9 ? true : undefined), 90_000, "nine async results");
					const jobs = asyncJobs(rpc.frames);
					// The isolated patch is a host fact on the registry, populated when the run finalizes; wait for it
					// instead of assuming the async-result message already carries the path.
					await until(
						() => {
							const fact = factOf("WorkerIsolated");
							return fact?.patchArtifact?.exists === true ? true : undefined;
						},
						20_000,
						"the isolated child's registry patch handle",
					);
					const facts = tasks
						.map(task => factOf(task.name))
						.filter((fact): fact is RegistryFact => fact !== undefined && fact.kind === "sub");
					const workers = facts.filter(fact => typeof fact.home === "string" && /^w[0-9]+$/.test(fact.home));
					check("the parent receives all nine worker-batch results", jobs.length === 9, `jobs=${jobs.length}`);
					check("at least one child ran on a host worker thread", workers.length > 0, JSON.stringify(facts.map(fact => [fact.id, fact.home])));
					check(
						"every worker-homed child still has a parent-observed job and readable output artifact",
						workers.every(fact => {
							const job = jobs.find(candidate => candidate.agentId === fact.id);
							return job !== undefined && job.status === "completed" && fact.outputArtifact?.exists === true;
						}),
						JSON.stringify(workers.map(fact => [fact.id, fact.home, jobs.find(job => job.agentId === fact.id)?.jobId, fact.outputArtifact])),
					);
					const isolated = factOf("WorkerIsolated");
					const isolatedEvent = proof().find(
						line =>
							line.type === "registry_event" &&
							line.id === "WorkerIsolated" &&
							line.eventType === "metadata_changed" &&
							line.patchArtifact?.exists === true,
					);
					check(
						"a worker-homed child keeps its parent-visible home in the registry",
						isolated?.home !== "main" && /^w\d+$/.test(isolated?.home ?? ""),
						JSON.stringify({ id: isolated?.id, home: isolated?.home, status: isolated?.status }),
					);
					check(
						"the worker child's durable patch arrives as a parent-side registry change event",
						isolatedEvent !== undefined,
						JSON.stringify({ eventType: isolatedEvent?.eventType, patch: isolatedEvent?.patchArtifact?.path, bytes: isolatedEvent?.patchArtifact?.bytes }),
					);
					const good = jobs.find(job => job.agentId === "WorkerGood");
					const bad = jobs.find(job => job.agentId === "WorkerBad");
					check(
						"worker batch host status separates valid and invalid structured children",
						good?.status === "completed" && good.schema?.status === "valid" && bad?.status === "failed" && bad.schema?.status === "invalid",
						JSON.stringify([good, bad].map(job => [job?.agentId, job?.status, job?.schema?.status, job?.schema?.error])),
					);
					check(
						"a worker-delivered isolated child leaves a readable patch outside the parent checkout",
						isolated?.patchArtifact?.exists === true &&
							(isolated.patchArtifact.head ?? "").includes("worker-isolated.txt") &&
							!existsSync(join(env.project, "worker-isolated.txt")),
						`${artifactReport(isolated?.patchArtifact)} parent=${existsSync(join(env.project, "worker-isolated.txt"))}`,
					);
					const retryJobs = jobs.filter(job => job.agentId === "WorkerRetry");
					const retryRequests = llm.of("child").filter(entry => entry.lastUser.includes("E2E-CHILD-429-ONCE retryWorker"));
					check(
						"a provider retry does not duplicate the native job or delivery",
						retryRequests.length >= 2 && retryJobs.length === 1 && retryJobs[0]?.status === "completed",
						`childRequests=${retryRequests.length} jobs=${JSON.stringify(retryJobs.map(job => [job.jobId, job.status]))}`,
					);
					check("worker batch job ids are unique", new Set(jobs.map(job => job.jobId)).size === jobs.length, JSON.stringify(jobs.map(job => job.jobId)));
				});
			},
			180_000,
		);

		await suite.step(
			"follow-up identity: a new turn has a new job id and does not replay the first result",
			async () => {
				configure(true);
				await session(async rpc => {
					const steps = [
						{ tasks: [{ name: "Follow", agent: "task", task: "first turn", say: "E2E-CHILD-CLAIM first" }] },
						{ followUp: "agent://Follow", content: "second turn E2E-CHILD-CLAIM second" },
					];
					await rpc.prompt(start(steps));
					await until(() => (asyncJobs(rpc.frames).length >= 2 ? true : undefined), 40_000, "two follow-up results");
					const jobs = asyncJobs(rpc.frames);
					const writes = proof().filter(line => line.type === "tool_result" && line.toolName === "write");
					check("both results name the same agent", jobs.length === 2 && jobs.every(job => job.agentId === "Follow"), JSON.stringify(jobs.map(job => [job.jobId, job.agentId])));
					check(
						"the follow-up has a distinct native job id and a distinct result body",
						jobs[0]?.jobId !== jobs[1]?.jobId &&
							JSON.stringify(jobs[0]?.frame).includes("first") &&
							JSON.stringify(jobs[1]?.frame).includes("second") &&
							!JSON.stringify(jobs[1]?.frame).includes("first"),
						JSON.stringify(jobs.map(job => [job.jobId, JSON.stringify(job.frame).slice(0, 160)])),
					);
					check("the follow-up was delivered through agent://", writes.length === 1 && writes[0]?.input?.path === "agent://Follow", JSON.stringify(writes.map(line => line.input)));
					check("the old result is not redelivered as a third job", jobs.length === 2, `jobs=${jobs.length}`);
				});
			},
			120_000,
		);

		await suite.step(
			"no router or budget side effect: the observation path makes no provider request",
			async () => {
				const entries = readJsonl<LlmEntry>(env.llmLog);
				const route = entries.filter(entry => entry.who === "route");
				const compaction = entries.filter(entry => entry.who === "compaction");
				check("the probe never triggered a Storm router request", route.length === 0, `route=${route.length}`);
				check("the probe never triggered a compaction request", compaction.length === 0, `compaction=${compaction.length}`);
				check(
					"every recorded request belongs to the main or a scripted child (no observer call)",
					entries.every(entry => entry.who === "main" || entry.who === "child" || entry.who === "side"),
					JSON.stringify([...new Set(entries.map(entry => entry.who))]),
				);
			},
			20_000,
		);
	} finally {
		server.kill();
	}
	process.exitCode = suite.finish();
}

await main();
