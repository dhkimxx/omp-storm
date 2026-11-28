/**
 * The parent-side attempt collector: host envelope → exact attempt → one controller settlement.
 *
 * These tests drive the same order the extension hooks use: admission, sync `task` result, async `async-result`,
 * registry history, same-agent follow-up. They do not claim product/E2E PASS; the controller write and T01/T06 belong
 * to S1.4.
 */
import { afterEach, describe, expect, test, vi } from "bun:test";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { PlanLane, PlanLaneResult } from "../src/types.ts";
import type { AttemptAdmission, AttemptPreparation, AttemptSettlement } from "../src/runtime/attempt-bridge.ts";
import {
	AttemptCollector,
	ATTEMPT_PROGRESS_TTL_MS,
	answerCitations,
	normalizeAnswerText,
	type AttemptRegistry,
	type AttemptRegistryEvent,
	type AttemptRegistryRef,
	type AttemptSettlementPort,
} from "../src/runtime/attempt-collector.ts";

const dirs: string[] = [];

afterEach(async () => {
	for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function tempDir(label: string): Promise<string> {
	const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `storm-collector-${label}-`)));
	dirs.push(dir);
	return dir;
}

class FakeRegistry implements AttemptRegistry {
	readonly refs = new Map<string, AttemptRegistryRef>();
	readonly listeners = new Set<(event: AttemptRegistryEvent) => void>();

	get(id: string): AttemptRegistryRef | undefined {
		return this.refs.get(id);
	}

	onChange(listener: (event: AttemptRegistryEvent) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	set(ref: AttemptRegistryRef): void {
		this.refs.set(ref.id, ref);
	}

	emit(event: AttemptRegistryEvent): void {
		for (const listener of [...this.listeners]) listener(event);
	}
}

interface Recorded {
	preparations: AttemptPreparation[];
	settlements: AttemptSettlement[];
	port: AttemptSettlementPort;
	refuse(value: AttemptAdmission): void;
	/** Resolves after the next controller settlement; pair with fake timers for bounded waits. */
	nextSettlement(): Promise<void>;
}

function recordingPort(): Recorded {
	const preparations: AttemptPreparation[] = [];
	const settlements: AttemptSettlement[] = [];
	let refusal: AttemptAdmission | undefined;
	let notify: (() => void) | undefined;
	const settled = (): void => {
		const resolve = notify;
		notify = undefined;
		resolve?.();
	};
	return {
		preparations,
		settlements,
		refuse: value => {
			refusal = value;
		},
		nextSettlement: () => {
			const { promise, resolve } = Promise.withResolvers<void>();
			notify = resolve;
			return promise;
		},
		port: {
			prepare: async input => {
				preparations.push(input);
				return refusal ?? { ok: true };
			},
			settle: async input => {
				settlements.push(input);
				settled();
			},
		},
	};
}

function lane(results?: PlanLaneResult[], overrides: Partial<PlanLane> = {}): PlanLane {
	return { name: "impl", kind: "code", role: "implementer", ...(results === undefined ? {} : { results }), ...overrides };
}

interface Harness {
	collector: AttemptCollector;
	registry: FakeRegistry;
	setNow(value: number): void;
}

function harness(port: AttemptSettlementPort, waitMs = 30): Harness {
	const registry = new FakeRegistry();
	let now = 1_000;
	const collector = new AttemptCollector({ port, registry: () => registry, now: () => now, registryWaitMs: waitMs });
	return {
		collector,
		registry,
		setNow: value => {
			now = value;
		},
	};
}

const artifactResult = (): PlanLaneResult => ({ id: "patch", kind: "artifact", criterion: "the isolated patch changes a.ts", path: "a.ts" });

describe("sync task results", () => {
	test("binds the admitted child, captures its exact patch and settles once", async () => {
		const dir = await tempDir("sync");
		const patch = path.join(dir, "Impl.patch");
		const output = path.join(dir, "Impl.md");
		await fs.writeFile(patch, "diff --git a/a.ts b/a.ts\n+changed\n");
		await fs.writeFile(output, "done at src/a.ts:2");
		const recorded = recordingPort();
		const h = harness(recorded.port);
		h.setNow(1_000);
		h.collector.observeTaskCall({ runId: "run-1", parentId: "Main", toolCallId: "call_1", startedAt: 990 });

		expect(await h.collector.admitSpawn({
			runId: "run-1",
			parentId: "Main",
			spawnKey: "Impl",
			lane: lane([artifactResult()]),
			artifactMode: "isolated",
			startedAt: 1_000,
		})).toEqual({ ok: true });
		expect(recorded.preparations).toHaveLength(1);
		expect(recorded.preparations[0]).toMatchObject({
			runId: "run-1",
			lane: "impl",
			spawnKey: "Impl",
			parentId: "Main",
			followUp: false,
			artifactMode: "isolated",
			admissionPatch: null,
		});

		h.setNow(1_100);
		await h.collector.observeTaskResult({
			runId: "run-1",
			parentId: "Main",
			toolCallId: "call_1",
			observedAt: 1_100,
			details: { results: [{
				id: "Impl",
				exitCode: 0,
				output: "done at src/a.ts:2",
				outputPath: output,
				patchPath: patch,
				structuredOutput: {
					status: "valid",
					data: { summary: "done", citations: [{ path: "src/a.ts", line: 2, quote: "done" }] },
				},
			}] },
		});

		expect(recorded.settlements).toHaveLength(1);
		const settlement = recorded.settlements[0]!;
		expect(settlement.report).toMatchObject({
			schema: "storm.attempt-report/v1",
			attemptId: "task:call_1:Impl",
			outcome: "success",
			capture: "observed",
			spawnKey: "Impl",
			parentId: "Main",
		});
		expect(settlement.report.artifacts.find(artifact => artifact.kind === "patch")).toMatchObject({
			path: patch,
			source: "task-result",
		});
		expect(settlement.report.artifacts.find(artifact => artifact.kind === "patch")?.digest).toMatch(/^[0-9a-f]{64}$/);
		expect(settlement.reportText).toContain("done at src/a.ts");
		expect(settlement.citations).toContainEqual(expect.objectContaining({ path: "src/a.ts", line: 2 }));
		expect(settlement.citations.length).toBeLessThanOrEqual(8);
		h.collector.stop();
	});

	test("B5: the settlement reads an absolute citation with the root of the attempt's own run", async () => {
		const dir = await tempDir("root");
		const tree = path.join(dir, "tree");
		await fs.mkdir(path.join(tree, "src"), { recursive: true });
		await fs.writeFile(path.join(tree, "src", "a.ts"), "// header\nlimit: 42\n");
		const seen: Array<{ runId: string; parentId: string; spawnKey: string }> = [];
		const registry = new FakeRegistry();
		let now = 1_000;
		const recorded = recordingPort();
		const collector = new AttemptCollector({
			port: recorded.port,
			registry: () => registry,
			now: () => now,
			targetRoot: attempt => {
				seen.push(attempt);
				return tree;
			},
		});
		collector.observeTaskCall({ runId: "run-1", parentId: "Main", toolCallId: "call_1", startedAt: 990 });
		await collector.admitSpawn({
			runId: "run-1",
			parentId: "Main",
			spawnKey: "Impl",
			lane: lane([{ id: "answer", kind: "answer", criterion: "the limit", path: "src/a.ts", contains: "limit: 42" }]),
			artifactMode: "shared",
			startedAt: 1_000,
		});
		now = 1_100;
		await collector.observeTaskResult({
			runId: "run-1",
			parentId: "Main",
			toolCallId: "call_1",
			observedAt: 1_100,
			details: { results: [{ id: "Impl", exitCode: 0, output: `limit: 42 (${tree}/src/a.ts#L2)` }] },
		});
		expect(recorded.settlements).toHaveLength(1);
		// The caller can name the run that spawned this worker, not whichever run is current after an await.
		expect(seen).toEqual([{ runId: "run-1", parentId: "Main", spawnKey: "Impl" }]);
		expect(recorded.settlements[0]?.citations).toEqual([{ path: "src/a.ts", line: 2 }]);
		collector.stop();
	});

	test("a result without the admitted child is a missing report, never silence", async () => {
		const recorded = recordingPort();
		const h = harness(recorded.port);
		h.setNow(1_000);
		h.collector.observeTaskCall({ runId: "run-1", parentId: "Main", toolCallId: "call_1", startedAt: 990 });
		await h.collector.admitSpawn({
			runId: "run-1",
			parentId: "Main",
			spawnKey: "Impl",
			lane: lane([{ id: "change", kind: "change", criterion: "a.ts changed", path: "a.ts" }]),
			artifactMode: "shared",
			startedAt: 1_000,
		});
		h.setNow(1_100);
		await h.collector.observeTaskResult({
			runId: "run-1",
			parentId: "Main",
			toolCallId: "call_1",
			details: {},
			observedAt: 1_100,
		});
		expect(recorded.settlements).toHaveLength(1);
		expect(recorded.settlements[0]?.report).toMatchObject({
			capture: "missing",
			captureError: "native-result-missing",
			outcome: "failure",
		});
		expect(recorded.settlements[0]?.report.attemptId).toBeUndefined();
		h.collector.stop();
	});

	test("a duplicate delivery after settlement never settles a second time", async () => {
		const recorded = recordingPort();
		const h = harness(recorded.port);
		h.setNow(1_000);
		h.collector.observeTaskCall({ runId: "run-1", parentId: "Main", toolCallId: "call_1", startedAt: 990 });
		await h.collector.admitSpawn({
			runId: "run-1",
			parentId: "Main",
			spawnKey: "Impl",
			lane: lane([{ id: "change", kind: "change", criterion: "a.ts changed", path: "a.ts" }]),
			artifactMode: "shared",
			startedAt: 1_000,
		});
		const result = { id: "Impl", exitCode: 0, output: "changed" };
		h.setNow(1_100);
		await h.collector.observeTaskResult({ runId: "run-1", parentId: "Main", toolCallId: "call_1", details: { results: [result] }, observedAt: 1_100 });
		await h.collector.observeTaskResult({ runId: "run-1", parentId: "Main", toolCallId: "call_1", details: { results: [result] }, observedAt: 1_150 });
		expect(recorded.settlements).toHaveLength(1);
		h.collector.stop();
	});

	test("host failure and schema errors are preserved, never turned into success", async () => {
		const recorded = recordingPort();
		const h = harness(recorded.port);
		h.setNow(1_000);
		h.collector.observeTaskCall({ runId: "run-1", parentId: "Main", toolCallId: "call_1", startedAt: 990 });
		await h.collector.admitSpawn({
			runId: "run-1",
			parentId: "Main",
			spawnKey: "Impl",
			lane: lane([{ id: "change", kind: "change", criterion: "a.ts changed", path: "a.ts" }]),
			artifactMode: "shared",
			startedAt: 1_000,
		});
		h.setNow(1_100);
		await h.collector.observeTaskResult({
			runId: "run-1",
			parentId: "Main",
			toolCallId: "call_1",
			details: {
				results: [{
					id: "Impl",
					exitCode: 1,
					error: "schema_violation: missing required fields: ok",
					output: "the worker claimed success",
					structuredOutput: { status: "invalid", error: "ok: is required" },
				}],
			},
			observedAt: 1_100,
		});
		expect(recorded.settlements).toHaveLength(1);
		expect(recorded.settlements[0]?.report).toMatchObject({
			attemptId: "task:call_1:Impl",
			outcome: "failure",
			exitCode: 1,
			error: "schema_violation: missing required fields: ok",
			schemaStatus: "invalid",
			schemaError: "ok: is required",
		});
		h.collector.stop();
	});

	test("a symlinked patch path is not a retained artifact", async () => {
		const dir = await tempDir("symlink");
		const target = path.join(dir, "target.patch");
		const link = path.join(dir, "Impl.patch");
		await fs.writeFile(target, "diff --git a/a.ts b/a.ts\n+linked\n");
		await fs.symlink(target, link);
		const recorded = recordingPort();
		const h = harness(recorded.port);
		h.setNow(1_000);
		h.collector.observeTaskCall({ runId: "run-1", parentId: "Main", toolCallId: "call_1", startedAt: 990 });
		await h.collector.admitSpawn({
			runId: "run-1",
			parentId: "Main",
			spawnKey: "Impl",
			lane: lane([artifactResult()], { isolationReason: "independent experiment" }),
			artifactMode: "isolated",
			startedAt: 1_000,
		});
		h.setNow(1_100);
		await h.collector.observeTaskResult({
			runId: "run-1",
			parentId: "Main",
			toolCallId: "call_1",
			details: { results: [{ id: "Impl", exitCode: 0, patchPath: link }] },
			observedAt: 1_100,
		});
		expect(recorded.settlements).toHaveLength(1);
		expect(recorded.settlements[0]?.report).toMatchObject({ attemptId: "task:call_1:Impl", captureError: "patch-artifact-missing" });
		expect(recorded.settlements[0]?.report.capture).not.toBe("observed");
		h.collector.stop();
	});

	test("an async spawn acknowledgment is not a missing result", async () => {
		const recorded = recordingPort();
		const h = harness(recorded.port);
		h.setNow(1_000);
		h.collector.observeTaskCall({ runId: "run-1", parentId: "Main", toolCallId: "call_1", startedAt: 990 });
		await h.collector.admitSpawn({
			runId: "run-1",
			parentId: "Main",
			spawnKey: "Impl",
			lane: lane([{ id: "change", kind: "change", criterion: "a.ts changed", path: "a.ts" }]),
			artifactMode: "shared",
			startedAt: 1_000,
		});
		h.setNow(1_100);
		await h.collector.observeTaskResult({
			runId: "run-1",
			parentId: "Main",
			toolCallId: "call_1",
			details: {
				results: [],
				progress: [{ id: "Impl", status: "pending" }],
				async: { state: "running", jobId: "job_1", type: "task" },
				totalDurationMs: 0,
			},
			observedAt: 1_100,
		});
		// This is the exact T05 shape: the preliminary result must not consume the dispatch.
		expect(recorded.settlements).toHaveLength(0);
		h.setNow(1_200);
		await h.collector.observeMessage({
			runId: "run-1",
			parentId: "Main",
			observedAt: 1_200,
			message: { customType: "async-result", content: "done", details: { jobs: [{ jobId: "job_1", agentId: "Impl", status: "completed" }] } },
		});
		expect(recorded.settlements).toHaveLength(1);
		expect(recorded.settlements[0]?.report).toMatchObject({
			attemptId: "job:job_1:Impl",
			capture: "observed",
			outcome: "success",
		});
		h.collector.stop();
	});

	test("the acknowledged job id is exact; another first delivery stays stale", async () => {
		const recorded = recordingPort();
		const h = harness(recorded.port);
		h.setNow(1_000);
		h.collector.observeTaskCall({ runId: "run-1", parentId: "Main", toolCallId: "call_1", startedAt: 990 });
		await h.collector.admitSpawn({
			runId: "run-1",
			parentId: "Main",
			spawnKey: "Impl",
			lane: lane([{ id: "change", kind: "change", criterion: "a.ts changed", path: "a.ts" }]),
			artifactMode: "shared",
			startedAt: 1_000,
		});
		h.setNow(1_100);
		await h.collector.observeTaskResult({
			runId: "run-1",
			parentId: "Main",
			toolCallId: "call_1",
			details: {
				results: [],
				progress: [{ id: "Impl", status: "running" }],
				async: { state: "running", jobId: "job_1", type: "task" },
			},
			observedAt: 1_100,
		});
		await h.collector.observeMessage({
			runId: "run-1",
			parentId: "Main",
			observedAt: 1_150,
			message: { customType: "async-result", content: "old", details: { jobs: [{ jobId: "old", agentId: "Impl", status: "completed" }] } },
		});
		expect(recorded.settlements).toHaveLength(0);
		await h.collector.observeMessage({
			runId: "run-1",
			parentId: "Main",
			observedAt: 1_200,
			message: { customType: "async-result", content: "new", details: { jobs: [{ jobId: "job_1", agentId: "Impl", status: "completed" }] } },
		});
		expect(recorded.settlements).toHaveLength(1);
		expect(recorded.settlements[0]?.report.attemptId).toBe("job:job_1:Impl");
		h.collector.stop();
	});

	test("a failed async spawn marker still fails closed as missing", async () => {
		const recorded = recordingPort();
		const h = harness(recorded.port);
		h.setNow(1_000);
		h.collector.observeTaskCall({ runId: "run-1", parentId: "Main", toolCallId: "call_1", startedAt: 990 });
		await h.collector.admitSpawn({
			runId: "run-1",
			parentId: "Main",
			spawnKey: "Impl",
			lane: lane([{ id: "change", kind: "change", criterion: "a.ts changed", path: "a.ts" }]),
			artifactMode: "shared",
			startedAt: 1_000,
		});
		h.setNow(1_100);
		await h.collector.observeTaskResult({
			runId: "run-1",
			parentId: "Main",
			toolCallId: "call_1",
			details: {
				results: [],
				progress: [{ id: "Impl", status: "failed" }],
				async: { state: "failed", jobId: "job_1", type: "task" },
			},
			observedAt: 1_100,
		});
		expect(recorded.settlements).toHaveLength(1);
		expect(recorded.settlements[0]?.report).toMatchObject({ capture: "missing", captureError: "native-result-missing" });
		h.collector.stop();
	});

	test("a refused pre-write baseline blocks before the child is tracked", async () => {
		const recorded = recordingPort();
		recorded.refuse({ ok: false, reason: "baseline unavailable" });
		const h = harness(recorded.port);
		h.setNow(1_000);
		expect(await h.collector.admitSpawn({
			runId: "run-1",
			parentId: "Main",
			spawnKey: "Impl",
			lane: lane([{ id: "change", kind: "change", criterion: "a.ts changed", path: "a.ts" }]),
			artifactMode: "shared",
			startedAt: 1_000,
		})).toEqual({ ok: false, reason: "baseline unavailable" });
		h.setNow(1_100);
		await h.collector.observeTaskResult({ runId: "run-1", parentId: "Main", toolCallId: "call_1", details: { results: [{ id: "Impl", exitCode: 0 }] }, observedAt: 1_100 });
		expect(recorded.settlements).toHaveLength(0);
		h.collector.stop();
	});
});

describe("async deliveries", () => {
	test("a non-isolated job settles from its own envelope and keeps bounded answer candidates", async () => {
		const recorded = recordingPort();
		const h = harness(recorded.port);
		h.setNow(1_000);
		await h.collector.admitSpawn({
			runId: "run-1",
			parentId: "Main",
			spawnKey: "Impl",
			lane: lane([{ id: "answer", kind: "answer", criterion: "the total", path: "src/a.ts", contains: "42" }]),
			artifactMode: "shared",
			startedAt: 1_000,
		});
		h.setNow(1_100);
		await h.collector.observeMessage({
			runId: "run-1",
			parentId: "Main",
			observedAt: 1_100,
			message: {
				customType: "async-result",
				content: "the total is 42, see src/a.ts:2",
				details: {
					jobs: [{
						jobId: "job_1",
						agentId: "Impl",
						status: "completed",
						schema: { status: "valid", data: { citations: [{ path: "src/a.ts", line: 2, quote: "total" }] } },
					}],
				},
			},
		});
		expect(recorded.settlements).toHaveLength(1);
		const settlement = recorded.settlements[0]!;
		expect(settlement.report).toMatchObject({ attemptId: "job:job_1:Impl", outcome: "success", capture: "observed" });
		expect(settlement.reportText).toContain("the total is 42");
		expect(settlement.citations).toContainEqual(expect.objectContaining({ path: "src/a.ts", line: 2 }));
		h.collector.stop();
	});

	test("concurrent task calls correlate by the exact item name", async () => {
		const recorded = recordingPort();
		const h = harness(recorded.port);
		h.setNow(1_000);
		h.collector.observeTaskCall({ runId: "run-1", parentId: "Main", toolCallId: "call_other", input: { name: "Other" }, startedAt: 990 });
		h.collector.observeTaskCall({ runId: "run-1", parentId: "Main", toolCallId: "call_impl", input: { name: "Impl" }, startedAt: 991 });
		await h.collector.admitSpawn({
			runId: "run-1",
			parentId: "Main",
			spawnKey: "Impl",
			lane: lane([{ id: "change", kind: "change", criterion: "a.ts changed", path: "a.ts" }]),
			artifactMode: "shared",
			startedAt: 1_000,
		});
		h.setNow(1_100);
		h.collector.observeProgress({
			runId: "run-1",
			parentId: "Main",
			toolCallId: "call_impl",
			observedAt: 1_100,
			partialResult: { details: { progress: [{ id: "Impl", status: "running", retryFailure: { attempt: 2 } }] } },
		});
		await h.collector.observeMessage({
			runId: "run-1",
			parentId: "Main",
			observedAt: 1_150,
			message: { customType: "async-result", content: "failed", details: { jobs: [{ jobId: "job_1", agentId: "Impl", status: "failed" }] } },
		});
		expect(recorded.settlements).toHaveLength(1);
		expect(recorded.settlements[0]?.report).toMatchObject({ outcome: "failure", retry: { attempt: 2 } });
		h.collector.stop();
	});

	test("the async acknowledgment binds the exact call when parallel calls left it ambiguous", async () => {
		const recorded = recordingPort();
		const h = harness(recorded.port);
		h.setNow(1_000);
		// Two calls are open at admission and neither tells the collector which one owns this spawn.
		h.collector.observeTaskCall({ runId: "run-1", parentId: "Main", toolCallId: "call_other", startedAt: 990 });
		h.collector.observeTaskCall({ runId: "run-1", parentId: "Main", toolCallId: "call_impl", startedAt: 991 });
		await h.collector.admitSpawn({
			runId: "run-1",
			parentId: "Main",
			spawnKey: "Impl",
			lane: lane([{ id: "change", kind: "change", criterion: "a.ts changed", path: "a.ts" }]),
			artifactMode: "shared",
			startedAt: 1_000,
		});
		h.setNow(1_100);
		// The host acknowledgment names the child in its own progress row; it binds the exact call after the fact.
		await h.collector.observeTaskResult({
			runId: "run-1",
			parentId: "Main",
			toolCallId: "call_impl",
			details: {
				results: [],
				progress: [{ id: "Impl", status: "pending" }],
				async: { state: "running", jobId: "job_1", type: "task" },
			},
			observedAt: 1_100,
		});
		h.setNow(1_150);
		h.collector.observeProgress({
			runId: "run-1",
			parentId: "Main",
			toolCallId: "call_impl",
			observedAt: 1_150,
			partialResult: { details: { progress: [{ id: "Impl", status: "running", retryFailure: { attempt: 1 } }] } },
		});
		h.setNow(1_200);
		await h.collector.observeMessage({
			runId: "run-1",
			parentId: "Main",
			observedAt: 1_200,
			message: { customType: "async-result", content: "failed", details: { jobs: [{ jobId: "job_1", agentId: "Impl", status: "failed" }] } },
		});
		expect(recorded.settlements).toHaveLength(1);
		expect(recorded.settlements[0]?.report).toMatchObject({ outcome: "failure", retry: { attempt: 1 }, attemptId: "job:job_1:Impl" });
		h.collector.stop();
	});

	test("an acknowledgment that arrives before admission is consumed at the spawn event", async () => {
		const recorded = recordingPort();
		const h = harness(recorded.port);
		h.setNow(1_000);
		h.collector.observeTaskCall({ runId: "run-1", parentId: "Main", toolCallId: "call_impl", startedAt: 990 });
		// The real host order: the task tool_result is emitted before before_subagent_spawn admits the child.
		await h.collector.observeTaskResult({
			runId: "run-1",
			parentId: "Main",
			toolCallId: "call_impl",
			details: {
				results: [],
				progress: [{ id: "Impl", status: "pending" }],
				async: { state: "running", jobId: "job_1", type: "task" },
			},
			observedAt: 1_050,
		});
		h.setNow(1_100);
		await h.collector.admitSpawn({
			runId: "run-1",
			parentId: "Main",
			spawnKey: "Impl",
			lane: lane([{ id: "change", kind: "change", criterion: "a.ts changed", path: "a.ts" }]),
			artifactMode: "shared",
			startedAt: 1_100,
		});
		h.setNow(1_150);
		h.collector.observeProgress({
			runId: "run-1",
			parentId: "Main",
			toolCallId: "call_impl",
			observedAt: 1_150,
			partialResult: { details: { progress: [{ id: "Impl", status: "running", retryFailure: { attempt: 1 } }] } },
		});
		h.setNow(1_200);
		await h.collector.observeMessage({
			runId: "run-1",
			parentId: "Main",
			observedAt: 1_200,
			message: { customType: "async-result", content: "failed", details: { jobs: [{ jobId: "job_1", agentId: "Impl", status: "failed" }] } },
		});
		expect(recorded.settlements).toHaveLength(1);
		expect(recorded.settlements[0]?.report).toMatchObject({ outcome: "failure", retry: { attempt: 1 }, attemptId: "job:job_1:Impl" });
		h.collector.stop();
	});

	test("a bound native retry fact attaches to the current failed async delivery", async () => {
		const recorded = recordingPort();
		const h = harness(recorded.port);
		h.setNow(1_000);
		h.collector.observeTaskCall({ runId: "run-1", parentId: "Main", toolCallId: "call_1", startedAt: 990 });
		await h.collector.admitSpawn({
			runId: "run-1",
			parentId: "Main",
			spawnKey: "Impl",
			lane: lane([{ id: "change", kind: "change", criterion: "a.ts changed", path: "a.ts" }]),
			artifactMode: "shared",
			startedAt: 1_000,
		});
		h.setNow(1_100);
		h.collector.observeProgress({
			runId: "run-1",
			parentId: "Main",
			toolCallId: "call_1",
			observedAt: 1_100,
			partialResult: { details: { progress: [{ id: "Impl", status: "running", retryFailure: { attempt: 2, errorMessage: "SECRET QUOTA TEXT" } }] } },
		});
		await h.collector.observeMessage({
			runId: "run-1",
			parentId: "Main",
			observedAt: 1_150,
			message: { customType: "async-result", content: "failed", details: { jobs: [{ jobId: "job_1", agentId: "Impl", status: "failed" }] } },
		});
		expect(recorded.settlements).toHaveLength(1);
		expect(recorded.settlements[0]?.report).toMatchObject({ outcome: "failure", retry: { attempt: 2 }, attemptId: "job:job_1:Impl" });
		expect(recorded.settlements[0]?.report.error).toBeUndefined();
		h.collector.stop();
	});

	test("progress from another run, tool call or child never attaches", async () => {
		const recorded = recordingPort();
		const h = harness(recorded.port);
		h.setNow(1_000);
		h.collector.observeTaskCall({ runId: "run-1", parentId: "Main", toolCallId: "call_1", startedAt: 990 });
		await h.collector.admitSpawn({
			runId: "run-1",
			parentId: "Main",
			spawnKey: "Impl",
			lane: lane([{ id: "change", kind: "change", criterion: "a.ts changed", path: "a.ts" }]),
			artifactMode: "shared",
			startedAt: 1_000,
		});
		h.setNow(1_100);
		h.collector.observeProgress({
			runId: "run-1",
			parentId: "Main",
			toolCallId: "other_call",
			observedAt: 1_100,
			partialResult: { details: { progress: [{ id: "Impl", status: "running", retryFailure: { attempt: 2 } }] } },
		});
		h.collector.observeProgress({
			runId: "run-1",
			parentId: "Main",
			toolCallId: "call_1",
			observedAt: 1_100,
			partialResult: { details: { progress: [{ id: "Other", status: "running", retryFailure: { attempt: 2 } }] } },
		});
		await h.collector.observeMessage({
			runId: "run-1",
			parentId: "Main",
			observedAt: 1_150,
			message: { customType: "async-result", content: "failed", details: { jobs: [{ jobId: "job_1", agentId: "Impl", status: "failed" }] } },
		});
		expect(recorded.settlements).toHaveLength(1);
		expect(recorded.settlements[0]?.report.retry).toBeUndefined();
		h.collector.stop();
	});

	test("a success after a retry stays success with no retry fact", async () => {
		const recorded = recordingPort();
		const h = harness(recorded.port);
		h.setNow(1_000);
		h.collector.observeTaskCall({ runId: "run-1", parentId: "Main", toolCallId: "call_1", startedAt: 990 });
		await h.collector.admitSpawn({
			runId: "run-1",
			parentId: "Main",
			spawnKey: "Impl",
			lane: lane([{ id: "change", kind: "change", criterion: "a.ts changed", path: "a.ts" }]),
			artifactMode: "shared",
			startedAt: 1_000,
		});
		h.setNow(1_100);
		h.collector.observeProgress({
			runId: "run-1",
			parentId: "Main",
			toolCallId: "call_1",
			observedAt: 1_100,
			partialResult: { details: { progress: [{ id: "Impl", status: "running", retryFailure: { attempt: 2 } }] } },
		});
		await h.collector.observeMessage({
			runId: "run-1",
			parentId: "Main",
			observedAt: 1_150,
			message: { customType: "async-result", content: "ok", details: { jobs: [{ jobId: "job_1", agentId: "Impl", status: "completed", schema: { status: "valid" } }] } },
		});
		expect(recorded.settlements).toHaveLength(1);
		expect(recorded.settlements[0]?.report).toMatchObject({ outcome: "success" });
		expect(recorded.settlements[0]?.report.retry).toBeUndefined();
		h.collector.stop();
	});

	test("a stale progress retry fact expires before the delivery", async () => {
		const recorded = recordingPort();
		const h = harness(recorded.port);
		h.setNow(1_000);
		h.collector.observeTaskCall({ runId: "run-1", parentId: "Main", toolCallId: "call_1", startedAt: 990 });
		await h.collector.admitSpawn({
			runId: "run-1",
			parentId: "Main",
			spawnKey: "Impl",
			lane: lane([{ id: "change", kind: "change", criterion: "a.ts changed", path: "a.ts" }]),
			artifactMode: "shared",
			startedAt: 1_000,
		});
		h.setNow(1_100);
		h.collector.observeProgress({
			runId: "run-1",
			parentId: "Main",
			toolCallId: "call_1",
			observedAt: 1_100,
			partialResult: { details: { progress: [{ id: "Impl", status: "running", retryFailure: { attempt: 2 } }] } },
		});
		h.setNow(1_100 + ATTEMPT_PROGRESS_TTL_MS + 1);
		await h.collector.observeMessage({
			runId: "run-1",
			parentId: "Main",
			observedAt: 1_100 + ATTEMPT_PROGRESS_TTL_MS + 1,
			message: { customType: "async-result", content: "failed", details: { jobs: [{ jobId: "job_1", agentId: "Impl", status: "failed" }] } },
		});
		expect(recorded.settlements).toHaveLength(1);
		expect(recorded.settlements[0]?.report.retry).toBeUndefined();
		h.collector.stop();
	});

	test("an isolated job waits for a fresh registry patch and binds parent, home and digest", async () => {
		// The bounded wait for a registry patch is a real timer; the harness shortens it to 30 ms. Without fake timers
		// the machine's scheduling between the delivery and the registry event decides this test's outcome.
		vi.useFakeTimers();
		try {
		const dir = await tempDir("isolated");
		const patch = path.join(dir, "Impl.patch");
		const recorded = recordingPort();
		const h = harness(recorded.port);
		h.setNow(1_000);
		h.collector.observeTaskCall({ runId: "run-1", parentId: "Main", toolCallId: "call_1", startedAt: 990 });
		await h.collector.admitSpawn({
			runId: "run-1",
			parentId: "Main",
			spawnKey: "Impl",
			lane: lane([artifactResult()], { isolationReason: "independent experiment" }),
			artifactMode: "isolated",
			startedAt: 1_000,
		});
		// The real host first returns a preliminary async acknowledgment (empty results, job running); it is not the
		// isolated attempt's result and must not consume the dispatch before the registry patch arrives.
		await h.collector.observeTaskResult({
			runId: "run-1",
			parentId: "Main",
			toolCallId: "call_1",
			details: {
				results: [],
				progress: [{ id: "Impl", status: "pending" }],
				async: { state: "running", jobId: "job_1", type: "task" },
			},
			observedAt: 1_050,
		});
		expect(recorded.settlements).toHaveLength(0);
		h.setNow(1_100);
		await h.collector.observeMessage({
			runId: "run-1",
			parentId: "Main",
			observedAt: 1_100,
			message: {
				customType: "async-result",
				content: "captured at a patch",
				details: { jobs: [{ jobId: "job_1", agentId: "Impl", status: "completed", schema: { status: "valid" } }] },
			},
		});
		expect(recorded.settlements).toHaveLength(0);

		await fs.writeFile(patch, "diff --git a/a.ts b/a.ts\n+worker\n");
		h.setNow(1_200);
		await h.collector.observeRegistry({
			type: "metadata_changed",
			ref: { id: "Impl", parentId: "Main", session: { instanceKey: "w1:abc" }, history: { patchPath: patch } },
		});
		expect(recorded.settlements).toHaveLength(1);
		const settlement = recorded.settlements[0]!;
		expect(settlement.report).toMatchObject({ attemptId: "job:job_1:Impl", outcome: "success", capture: "observed" });
		expect(settlement.report.artifacts.find(artifact => artifact.kind === "patch")).toMatchObject({
			path: patch,
			source: "registry",
		});
		expect(settlement.report.artifacts.find(artifact => artifact.kind === "patch")?.digest).toMatch(/^[0-9a-f]{64}$/);
		expect(settlement.report.observations).toContainEqual(expect.objectContaining({ facet: "artifact" }));
		h.collector.stop();
		} finally {
			vi.useRealTimers();
		}
	});

	test("an unchanged registry patch is not new authority; the bounded wait fails it closed", async () => {
		vi.useFakeTimers();
		try {
			const dir = await tempDir("unchanged");
			const patch = path.join(dir, "Impl.patch");
			await fs.writeFile(patch, "diff --git a/a.ts b/a.ts\n+old\n");
			const recorded = recordingPort();
			const h = harness(recorded.port, 20);
			h.setNow(1_000);
			h.registry.set({ id: "Impl", parentId: "Main", session: { instanceKey: "main" }, history: { patchPath: patch } });
			await h.collector.admitSpawn({
				runId: "run-1",
				parentId: "Main",
				spawnKey: "Impl",
				lane: lane([artifactResult()], { isolationReason: "independent experiment" }),
				artifactMode: "isolated",
				startedAt: 1_000,
			});
			expect(recorded.preparations[0]?.admissionPatch).toMatchObject({ path: patch });
			h.setNow(1_100);
			await h.collector.observeMessage({
				runId: "run-1",
				parentId: "Main",
				observedAt: 1_100,
				message: {
					customType: "async-result",
					content: "no new patch",
					details: { jobs: [{ jobId: "job_1", agentId: "Impl", status: "completed" }] },
				},
			});
			h.setNow(1_200);
			await h.collector.observeRegistry({
				type: "metadata_changed",
				ref: { id: "Impl", parentId: "Main", session: { instanceKey: "w1:abc" }, history: { patchPath: patch } },
			});
			expect(recorded.settlements).toHaveLength(0);
			const settledOnce = recorded.nextSettlement();
			vi.advanceTimersByTime(30);
			await settledOnce;
			expect(recorded.settlements).toHaveLength(1);
			expect(recorded.settlements[0]?.report).toMatchObject({ attemptId: "job:job_1:Impl", captureError: "patch-artifact-unchanged" });
			expect(recorded.settlements[0]?.report.capture).not.toBe("observed");
			h.collector.stop();
		} finally {
			vi.useRealTimers();
		}
	});

	test("a registry patch under another parent fails closed instead of becoming evidence", async () => {
		// Same bounded wait as above: with a real 30 ms timer the timeout can win before the registry event is processed.
		vi.useFakeTimers();
		try {
		const dir = await tempDir("parent");
		const patch = path.join(dir, "Impl.patch");
		await fs.writeFile(patch, "diff --git a/a.ts b/a.ts\n+wrong\n");
		const recorded = recordingPort();
		const h = harness(recorded.port);
		h.setNow(1_000);
		await h.collector.admitSpawn({
			runId: "run-1",
			parentId: "Main",
			spawnKey: "Impl",
			lane: lane([artifactResult()], { isolationReason: "independent experiment" }),
			artifactMode: "isolated",
			startedAt: 1_000,
		});
		h.setNow(1_100);
		await h.collector.observeMessage({
			runId: "run-1",
			parentId: "Main",
			observedAt: 1_100,
			message: {
				customType: "async-result",
				content: "patch claimed",
				details: { jobs: [{ jobId: "job_1", agentId: "Impl", status: "completed" }] },
			},
		});
		h.setNow(1_200);
		await h.collector.observeRegistry({
			type: "metadata_changed",
			ref: { id: "Impl", parentId: "Other", session: { instanceKey: "w1:abc" }, history: { patchPath: patch } },
		});
		expect(recorded.settlements).toHaveLength(1);
		expect(recorded.settlements[0]?.report).toMatchObject({ attemptId: "job:job_1:Impl", captureError: "parent-mismatch" });
		h.collector.stop();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("native wait deliveries", () => {
	const waitRow = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
		id: "Impl",
		type: "task",
		status: "completed",
		agentUrlId: "Impl",
		settledAtMs: 1_150,
		durationMs: 100,
		resultText: "storm e2e tracked file is line 1 of e2e-tracked.txt (e2e-tracked.txt:1)",
		...over,
	});
	const waitInput = (jobs: readonly Record<string, unknown>[], over: Partial<{ runId: string; parentId: string; observedAt: number }> = {}) => ({
		runId: "run-1",
		parentId: "Main",
		observedAt: 1_200,
		details: { op: "wait", meta: { source: { type: "report", value: "background jobs snapshot" } }, jobs },
		...over,
	});

	test("a consumed task row settles the exact admitted answer attempt with its cited text", async () => {
		const recorded = recordingPort();
		const h = harness(recorded.port);
		h.setNow(1_000);
		h.collector.observeTaskCall({ runId: "run-1", parentId: "Main", toolCallId: "call_1", startedAt: 990 });
		await h.collector.admitSpawn({
			runId: "run-1",
			parentId: "Main",
			spawnKey: "Impl",
			lane: lane([{ id: "answer", kind: "answer", criterion: "tracked line", path: "e2e-tracked.txt", contains: "storm e2e tracked file" }]),
			artifactMode: "shared",
			startedAt: 1_000,
		});
		// The host's async spawn acknowledgment names the exact job before wait consumes it.
		await h.collector.observeTaskResult({
			runId: "run-1",
			parentId: "Main",
			toolCallId: "call_1",
			details: {
				results: [],
				progress: [{ id: "Impl", status: "pending" }],
				async: { state: "running", jobId: "job_1", type: "task" },
			},
			observedAt: 1_050,
		});
		await h.collector.observeWaitResult(waitInput([waitRow({ id: "job_1" })]));
		expect(recorded.settlements).toHaveLength(1);
		const settlement = recorded.settlements[0]!;
		expect(settlement.report).toMatchObject({
			attemptId: "job:job_1:Impl",
			outcome: "success",
			capture: "observed",
			spawnKey: "Impl",
			parentId: "Main",
		});
		expect(settlement.report.observations.find(row => row.facet === "outcome")?.source.channel).toBe("wait-result");
		expect(settlement.reportText).toContain("storm e2e tracked file");
		expect(settlement.citations).toContainEqual({ path: "e2e-tracked.txt", line: 1 });
		h.collector.stop();
	});

	test("a batch row without a previously named job binds by its host agent id after admission", async () => {
		const recorded = recordingPort();
		const h = harness(recorded.port);
		h.setNow(1_000);
		await h.collector.admitSpawn({
			runId: "run-1",
			parentId: "Main",
			spawnKey: "W0",
			lane: lane([{ id: "answer", kind: "answer", criterion: "tracked line", path: "e2e-tracked.txt", contains: "storm e2e tracked file" }]),
			artifactMode: "shared",
			startedAt: 1_000,
		});
		await h.collector.observeWaitResult(waitInput([waitRow({ id: "W0", agentUrlId: "W0", settledAtMs: 1_100 })]));
		expect(recorded.settlements).toHaveLength(1);
		expect(recorded.settlements[0]?.report).toMatchObject({ attemptId: "job:W0:W0", outcome: "success", capture: "observed" });
		h.collector.stop();
	});

	test("a wrong run, parent, child, job type or pre-admission row never settles", async () => {
		const recorded = recordingPort();
		const h = harness(recorded.port);
		h.setNow(1_000);
		await h.collector.admitSpawn({
			runId: "run-1",
			parentId: "Main",
			spawnKey: "Impl",
			lane: lane([{ id: "answer", kind: "answer", criterion: "tracked line", path: "e2e-tracked.txt", contains: "storm e2e tracked file" }]),
			artifactMode: "shared",
			startedAt: 1_000,
		});
		await h.collector.observeWaitResult(waitInput([waitRow()], { runId: "run-2" }));
		await h.collector.observeWaitResult(waitInput([waitRow()], { parentId: "Other" }));
		await h.collector.observeWaitResult(waitInput([waitRow({ id: "Other", agentUrlId: "Other" })]));
		await h.collector.observeWaitResult(waitInput([waitRow({ settledAtMs: 999 })]));
		await h.collector.observeWaitResult(waitInput([waitRow({ type: "bash" })]));
		await h.collector.observeWaitResult({
			...waitInput([waitRow()]),
			details: { op: "jobs", jobs: [waitRow()] },
		});
		expect(recorded.settlements).toHaveLength(0);
		h.collector.stop();
	});

	test("a replayed snapshot settles once, and a non-deliverable aggregate never overrides an independent completion", async () => {
		const recorded = recordingPort();
		const h = harness(recorded.port);
		h.setNow(1_000);
		await h.collector.admitSpawn({
			runId: "run-1",
			parentId: "Main",
			spawnKey: "Impl",
			lane: lane([{ id: "answer", kind: "answer", criterion: "tracked line", path: "e2e-tracked.txt", contains: "storm e2e tracked file" }]),
			artifactMode: "shared",
			startedAt: 1_000,
		});
		// A completed row the host already consumed has no resultText/structured: it is a snapshot, not a delivery.
		await h.collector.observeWaitResult(waitInput([waitRow({ resultText: undefined })]));
		expect(recorded.settlements).toHaveLength(0);
		// The independent native delivery settles; two later aggregate wait snapshots cannot replace it.
		await h.collector.observeMessage({
			runId: "run-1",
			parentId: "Main",
			observedAt: 1_150,
			message: { customType: "async-result", content: "done (e2e-tracked.txt:1)", details: { jobs: [{ jobId: "Impl", agentId: "Impl", status: "completed" }] } },
		});
		expect(recorded.settlements).toHaveLength(1);
		await h.collector.observeWaitResult(waitInput([waitRow({ resultText: undefined })], { observedAt: 1_250 }));
		await h.collector.observeWaitResult(waitInput([waitRow()], { observedAt: 1_300 }));
		expect(recorded.settlements).toHaveLength(1);
		expect(recorded.settlements[0]?.report).toMatchObject({ attemptId: "job:Impl:Impl", outcome: "success" });
		expect(recorded.settlements[0]?.reportText).toContain("e2e-tracked.txt:1");
		h.collector.stop();
	});

	test("a failed row stays an observed failure, never a successful answer", async () => {
		const recorded = recordingPort();
		const h = harness(recorded.port);
		h.setNow(1_000);
		await h.collector.admitSpawn({
			runId: "run-1",
			parentId: "Main",
			spawnKey: "Impl",
			lane: lane([{ id: "answer", kind: "answer", criterion: "tracked line", path: "e2e-tracked.txt", contains: "storm e2e tracked file" }]),
			artifactMode: "shared",
			startedAt: 1_000,
		});
		await h.collector.observeWaitResult(waitInput([waitRow({ status: "failed", errorText: "child failed", resultText: "a claim" })]));
		expect(recorded.settlements).toHaveLength(1);
		expect(recorded.settlements[0]?.report).toMatchObject({ attemptId: "job:Impl:Impl", outcome: "failure", capture: "observed" });
		h.collector.stop();
	});

	test("a reused child's old row cannot settle the follow-up; only its exact bound job can", async () => {
		const recorded = recordingPort();
		const h = harness(recorded.port);
		h.setNow(1_000);
		h.collector.observeTaskCall({ runId: "run-1", parentId: "Main", toolCallId: "call_1", startedAt: 990 });
		await h.collector.admitSpawn({
			runId: "run-1",
			parentId: "Main",
			spawnKey: "Impl",
			lane: lane([{ id: "answer", kind: "answer", criterion: "tracked line", path: "e2e-tracked.txt", contains: "storm e2e tracked file" }]),
			artifactMode: "shared",
			startedAt: 1_000,
		});
		await h.collector.observeTaskResult({
			runId: "run-1",
			parentId: "Main",
			toolCallId: "call_1",
			details: { results: [{ id: "Impl", exitCode: 0, output: "first" }] },
			observedAt: 1_100,
		});
		expect(recorded.settlements).toHaveLength(1);
		h.setNow(2_000);
		await h.collector.admitFollowUp({
			runId: "run-1",
			parentId: "Main",
			spawnKey: "Impl",
			lane: lane([{ id: "answer", kind: "answer", criterion: "tracked line", path: "e2e-tracked.txt", contains: "storm e2e tracked file" }]),
			artifactMode: "shared",
			toolCallId: "write_1",
			startedAt: 2_000,
		});
		// No bound new job id: a row that merely shares the agent id must not resurrect the old completion.
		// (Its own start, settled minus duration, is 600: before this follow-up was admitted.)
		await h.collector.observeWaitResult(waitInput([waitRow({ id: "Impl", settledAtMs: 2_100, durationMs: 1_500 })], { observedAt: 2_200 }));
		expect(recorded.settlements).toHaveLength(1);
		// The host's own new job id, bound to this turn, is the only row that may settle it.
		h.collector.bindFollowUpJobs({ runId: "run-1", spawnKey: "Impl", jobs: [{ id: "Impl-2", agentId: "Impl", startTime: 2_001, status: "running" }] });
		await h.collector.observeWaitResult(waitInput([waitRow({ id: "Impl-2", settledAtMs: 2_200 })], { observedAt: 2_300 }));
		expect(recorded.settlements).toHaveLength(2);
		expect(recorded.settlements[1]?.report).toMatchObject({ attemptId: "job:Impl-2:Impl", outcome: "success" });
		h.collector.stop();
	});
});

describe("same-agent follow-ups", () => {
	async function settledSpawn(recorded: Recorded, h: Harness): Promise<void> {
		h.setNow(1_000);
		h.collector.observeTaskCall({ runId: "run-1", parentId: "Main", toolCallId: "call_1", startedAt: 990 });
		await h.collector.admitSpawn({
			runId: "run-1",
			parentId: "Main",
			spawnKey: "Impl",
			lane: lane([{ id: "change", kind: "change", criterion: "a.ts changed", path: "a.ts" }]),
			artifactMode: "shared",
			startedAt: 1_000,
		});
		h.setNow(1_100);
		await h.collector.observeTaskResult({
			runId: "run-1",
			parentId: "Main",
			toolCallId: "call_1",
			details: { results: [{ id: "Impl", exitCode: 0, output: "first" }] },
			observedAt: 1_100,
		});
		expect(recorded.settlements).toHaveLength(1);
	}

	test("the exact new job id binds; an old delivery cannot become the follow-up result", async () => {
		const recorded = recordingPort();
		const h = harness(recorded.port);
		await settledSpawn(recorded, h);
		h.setNow(2_000);
		expect(await h.collector.admitFollowUp({
			runId: "run-1",
			parentId: "Main",
			spawnKey: "Impl",
			lane: lane([{ id: "change", kind: "change", criterion: "a.ts changed", path: "a.ts" }]),
			artifactMode: "shared",
			startedAt: 2_000,
		})).toEqual({ ok: true });
		expect(recorded.preparations).toHaveLength(2);
		expect(recorded.preparations[1]).toMatchObject({ followUp: true, dispatch: expect.stringContaining("Impl:2000") });
		h.collector.bindFollowUpJobs({
			runId: "run-1",
			spawnKey: "Impl",
			jobs: [{ id: "Impl-2", agentId: "Impl", startTime: 2_001, status: "running" }],
		});
		h.setNow(2_100);
		await h.collector.observeMessage({
			runId: "run-1",
			parentId: "Main",
			observedAt: 2_100,
			message: { customType: "async-result", content: "second", details: { jobs: [{ jobId: "Impl-2", agentId: "Impl", status: "completed" }] } },
		});
		expect(recorded.settlements).toHaveLength(2);
		expect(recorded.settlements[1]?.report).toMatchObject({ attemptId: "job:Impl-2:Impl", outcome: "success" });
		await h.collector.observeMessage({
			runId: "run-1",
			parentId: "Main",
			observedAt: 2_150,
			message: { customType: "async-result", content: "old", details: { jobs: [{ jobId: "Old", agentId: "Impl", status: "completed" }] } },
		});
		expect(recorded.settlements).toHaveLength(2);
		h.collector.stop();
	});

	test("without an exact new job id a same-agent delivery does not bind", async () => {
		const recorded = recordingPort();
		const h = harness(recorded.port);
		await settledSpawn(recorded, h);
		h.setNow(2_000);
		await h.collector.admitFollowUp({
			runId: "run-1",
			parentId: "Main",
			spawnKey: "Impl",
			lane: lane([{ id: "change", kind: "change", criterion: "a.ts changed", path: "a.ts" }]),
			artifactMode: "shared",
			startedAt: 2_000,
		});
		h.setNow(2_100);
		await h.collector.observeMessage({
			runId: "run-1",
			parentId: "Main",
			observedAt: 2_100,
			message: { customType: "async-result", content: "guess", details: { jobs: [{ jobId: "Impl-2", agentId: "Impl", status: "completed" }] } },
		});
		expect(recorded.settlements).toHaveLength(1);
		h.collector.stop();
	});

	describe("omp reuses the agent id as the follow-up's job id (the earlier job row was evicted)", () => {
		const L = lane([{ id: "change", kind: "change", criterion: "a.ts changed", path: "a.ts" }]);
		const job = (over: Record<string, unknown> = {}) => ({ id: "Impl", agentId: "Impl", startTime: 2_100, status: "running", ...over });
		const waitRow = (over: Record<string, unknown> = {}) => ({
			id: "Impl", type: "task", status: "completed", agentUrlId: "Impl", settledAtMs: 2_600, durationMs: 500, resultText: "second", ...over,
		});
		const waitOf = (jobs: readonly Record<string, unknown>[], observedAt = 2_700) => ({
			runId: "run-1", parentId: "Main", observedAt, details: { op: "wait", jobs },
		});

		/** The first turn delivered as the bare job `Impl`, then a follow-up admitted at 2 000. */
		async function afterFirstJob(recorded: Recorded, h: Harness): Promise<void> {
			h.setNow(1_000);
			await h.collector.admitSpawn({ runId: "run-1", parentId: "Main", spawnKey: "Impl", lane: L, artifactMode: "shared", startedAt: 1_000 });
			h.setNow(1_100);
			await h.collector.observeMessage({
				runId: "run-1", parentId: "Main", observedAt: 1_100,
				message: { customType: "async-result", content: "first", details: { jobs: [{ jobId: "Impl", agentId: "Impl", status: "completed" }] } },
			});
			expect(recorded.settlements.map(settlement => settlement.report.attemptId)).toEqual(["job:Impl:Impl"]);
			h.setNow(2_000);
			await h.collector.admitFollowUp({ runId: "run-1", parentId: "Main", spawnKey: "Impl", lane: L, artifactMode: "shared", toolCallId: "write_1", startedAt: 2_000 });
		}

		test("the job bound at the write settles by wait under an id that carries its start", async () => {
			const recorded = recordingPort();
			const h = harness(recorded.port);
			await afterFirstJob(recorded, h);
			h.collector.bindFollowUpJobs({ runId: "run-1", spawnKey: "Impl", jobs: [job()] });
			await h.collector.observeWaitResult(waitOf([waitRow()]));
			expect(recorded.settlements.map(settlement => settlement.report.attemptId)).toEqual(["job:Impl:Impl", "job:Impl.t2100:Impl"]);
			expect(recorded.settlements[1]?.report).toMatchObject({ outcome: "success", capture: "observed" });
			h.collector.stop();
		});

		test("pushed, it settles with or without the parent's rows, and a replay of the first job is refused", async () => {
			for (const rows of [undefined, [job({ status: "completed" })]]) {
				const recorded = recordingPort();
				const h = harness(recorded.port);
				await afterFirstJob(recorded, h);
				h.collector.bindFollowUpJobs({ runId: "run-1", spawnKey: "Impl", jobs: [job()] });
				// The first job's own row (before the write) cannot become the follow-up's result.
				h.setNow(2_050);
				await h.collector.observeMessage({
					runId: "run-1", parentId: "Main", observedAt: 2_050,
					message: { customType: "async-result", content: "first again", details: { jobs: [{ jobId: "Impl", agentId: "Impl", status: "completed" }] } },
					jobs: [job({ startTime: 1_000, status: "completed" })],
				});
				expect(recorded.settlements).toHaveLength(1);
				h.setNow(2_650);
				await h.collector.observeMessage({
					runId: "run-1", parentId: "Main", observedAt: 2_650,
					message: { customType: "async-result", content: "second", details: { jobs: [{ jobId: "Impl", agentId: "Impl", status: "completed" }] } },
					...(rows === undefined ? {} : { jobs: rows }),
				});
				expect(recorded.settlements.map(settlement => settlement.report.attemptId)).toEqual(["job:Impl:Impl", "job:Impl.t2100:Impl"]);
				h.collector.stop();
			}
		});

		test("not bound at the write, the delivery's own start proves it (a wait row's settled time minus its duration)", async () => {
			const recorded = recordingPort();
			const h = harness(recorded.port);
			await afterFirstJob(recorded, h);
			// The first job again: started at 1 000, before the write.
			await h.collector.observeWaitResult(waitOf([waitRow({ settledAtMs: 1_900, durationMs: 900 })], 2_050));
			expect(recorded.settlements).toHaveLength(1);
			await h.collector.observeWaitResult(waitOf([waitRow()]));
			expect(recorded.settlements.map(settlement => settlement.report.attemptId)).toEqual(["job:Impl:Impl", "job:Impl.t2100:Impl"]);
			h.collector.stop();
		});

		test("a row without a duration or a pushed result without the parent's rows proves nothing, unbound", async () => {
			const recorded = recordingPort();
			const h = harness(recorded.port);
			await afterFirstJob(recorded, h);
			await h.collector.observeWaitResult(waitOf([{ ...waitRow(), durationMs: undefined }]));
			h.setNow(2_650);
			await h.collector.observeMessage({
				runId: "run-1", parentId: "Main", observedAt: 2_650,
				message: { customType: "async-result", content: "second", details: { jobs: [{ jobId: "Impl", agentId: "Impl", status: "completed" }] } },
			});
			expect(recorded.settlements).toHaveLength(1);
			h.collector.stop();
		});

		test("a message that joined an open turn binds the running job and settles with its completion", async () => {
			const recorded = recordingPort();
			const h = harness(recorded.port);
			h.setNow(1_000);
			await h.collector.admitSpawn({ runId: "run-1", parentId: "Main", spawnKey: "Impl", lane: L, artifactMode: "shared", startedAt: 1_000 });
			h.setNow(2_000);
			await h.collector.admitFollowUp({ runId: "run-1", parentId: "Main", spawnKey: "Impl", lane: L, artifactMode: "shared", toolCallId: "write_1", startedAt: 2_000 });
			// The only job of the agent is the first turn's, still running: it started before this write.
			h.collector.bindFollowUpJobs({ runId: "run-1", spawnKey: "Impl", jobs: [job({ startTime: 1_010 })] });
			h.setNow(3_000);
			await h.collector.observeWaitResult(waitOf([waitRow({ settledAtMs: 3_000, durationMs: 1_990 })], 3_010));
			expect(recorded.settlements.map(settlement => settlement.report.attemptId)).toEqual(["job:Impl:Impl"]);
			expect(recorded.settlements[0]?.report).toMatchObject({ outcome: "success" });
			h.collector.stop();
		});
	});

	test("a retry fact is scoped to the follow-up turn and expired by settlement", async () => {
		const recorded = recordingPort();
		const h = harness(recorded.port);
		await settledSpawn(recorded, h);
		h.setNow(2_000);
		await h.collector.admitFollowUp({
			runId: "run-1",
			parentId: "Main",
			spawnKey: "Impl",
			lane: lane([{ id: "change", kind: "change", criterion: "a.ts changed", path: "a.ts" }]),
			artifactMode: "shared",
			toolCallId: "write_1",
			startedAt: 2_000,
		});
		h.collector.bindFollowUpJobs({ runId: "run-1", spawnKey: "Impl", jobs: [{ id: "Impl-2", agentId: "Impl", startTime: 2_001, status: "running" }] });
		h.setNow(2_100);
		await h.collector.observeMessage({
			runId: "run-1",
			parentId: "Main",
			observedAt: 2_100,
			message: { customType: "async-result", content: "failed", details: { jobs: [{ jobId: "Impl-2", agentId: "Impl", status: "failed" }] } },
		});
		expect(recorded.settlements).toHaveLength(2);
		expect(recorded.settlements[1]?.report.retry).toBeUndefined();

		h.setNow(3_000);
		await h.collector.admitFollowUp({
			runId: "run-1",
			parentId: "Main",
			spawnKey: "Impl",
			lane: lane([{ id: "change", kind: "change", criterion: "a.ts changed", path: "a.ts" }]),
			artifactMode: "shared",
			toolCallId: "write_2",
			startedAt: 3_000,
		});
		h.collector.bindFollowUpJobs({ runId: "run-1", spawnKey: "Impl", jobs: [{ id: "Impl-3", agentId: "Impl", startTime: 3_001, status: "running" }] });
		h.setNow(3_100);
		h.collector.observeProgress({
			runId: "run-1",
			parentId: "Main",
			toolCallId: "write_1",
			observedAt: 3_100,
			partialResult: { details: { progress: [{ id: "Impl", retryFailure: { attempt: 4 } }] } },
		});
		await h.collector.observeMessage({
			runId: "run-1",
			parentId: "Main",
			observedAt: 3_150,
			message: { customType: "async-result", content: "failed", details: { jobs: [{ jobId: "Impl-3", agentId: "Impl", status: "failed" }] } },
		});
		expect(recorded.settlements).toHaveLength(3);
		expect(recorded.settlements[2]?.report.retry).toBeUndefined();

		// A new turn gets its own tool call and can bind its own progress.
		h.setNow(4_000);
		await h.collector.admitFollowUp({
			runId: "run-1",
			parentId: "Main",
			spawnKey: "Impl",
			lane: lane([{ id: "change", kind: "change", criterion: "a.ts changed", path: "a.ts" }]),
			artifactMode: "shared",
			toolCallId: "write_3",
			startedAt: 4_000,
		});
		h.collector.bindFollowUpJobs({ runId: "run-1", spawnKey: "Impl", jobs: [{ id: "Impl-4", agentId: "Impl", startTime: 4_001, status: "running" }] });
		h.collector.observeProgress({
			runId: "run-1",
			parentId: "Main",
			toolCallId: "write_3",
			observedAt: 4_100,
			partialResult: { details: { progress: [{ id: "Impl", retryFailure: { attempt: 3 } }] } },
		});
		await h.collector.observeMessage({
			runId: "run-1",
			parentId: "Main",
			observedAt: 4_150,
			message: { customType: "async-result", content: "failed", details: { jobs: [{ jobId: "Impl-4", agentId: "Impl", status: "failed" }] } },
		});
		expect(recorded.settlements).toHaveLength(4);
		expect(recorded.settlements[3]?.report.retry).toEqual({ attempt: 3 });
		h.collector.stop();
	});
});

describe("scope and subscription", () => {
	test("a lane without results keeps the old path: no baseline, no settlement", async () => {
		const recorded = recordingPort();
		const h = harness(recorded.port);
		h.setNow(1_000);
		expect(await h.collector.admitSpawn({
			runId: "run-1",
			parentId: "Main",
			spawnKey: "Impl",
			lane: lane(),
			artifactMode: "shared",
			startedAt: 1_000,
		})).toEqual({ ok: true });
		expect(recorded.preparations).toHaveLength(0);
		h.setNow(1_100);
		await h.collector.observeTaskResult({
			runId: "run-1",
			parentId: "Main",
			toolCallId: "call_1",
			details: { results: [{ id: "Impl", exitCode: 0 }] },
			observedAt: 1_100,
		});
		expect(recorded.settlements).toHaveLength(0);
		h.collector.stop();
	});

	test("the registry subscription is created once and removed by stop", async () => {
		const recorded = recordingPort();
		const h = harness(recorded.port);
		h.setNow(1_000);
		const input = {
			runId: "run-1",
			parentId: "Main",
			spawnKey: "Impl",
			lane: lane([{ id: "change", kind: "change", criterion: "a.ts changed", path: "a.ts" }]),
			artifactMode: "shared" as const,
			startedAt: 1_000,
		};
		await h.collector.admitSpawn(input);
		await h.collector.admitSpawn({ ...input, spawnKey: "Impl2" });
		expect(h.registry.listeners.size).toBe(1);
		h.collector.stop();
		expect(h.registry.listeners.size).toBe(0);
	});
});

describe("citation candidates", () => {
	test("bounded to the evaluator's limits; unsafe paths and URLs are never candidates", () => {
		const structured = {
			citations: [
				{ path: "src/a.ts", line: 2 },
				{ path: "../secret.txt", line: 1 },
				{ path: "/etc/passwd", line: 1 },
				{ path: "https://example.test/x.ts", line: 2 },
				...Array.from({ length: 12 }, (_, index) => ({ path: `src/f${index}.ts`, line: index + 1 })),
			],
		};
		const citations = answerCitations(structured, "see src/a.ts:2 and src/b.ts:3-4, not https://example.test/x.ts:9");
		expect(citations.length).toBe(8);
		expect(citations).toContainEqual({ path: "src/a.ts", line: 2 });
		expect(citations.some(citation => citation.path.startsWith("..") || citation.path.startsWith("/"))).toBe(false);
		expect(citations.some(citation => citation.path.includes("://"))).toBe(false);

		const fromText = answerCitations(undefined, "see src/a.ts:2 and src/b.ts:3-4, not https://example.test/x.ts:9");
		expect(fromText).toEqual([
			{ path: "src/a.ts", line: 2 },
			{ path: "src/b.ts", line: 3 },
		]);
	});

	test("every alias form becomes the same path and first line as path:line", () => {
		const canonical = [{ path: "src/a.ts", line: 12 }];
		for (const text of [
			"src/a.ts:12",
			"src/a.ts:12-20",
			"src/a.ts:12:5",
			"src/a.ts:12:limit: 42",
			"src/a.ts#L12",
			"src/a.ts#L12-L20",
			"src/a.ts#L12-20",
			"[the line](src/a.ts#L12)",
			"[the line](<src/a.ts#L12>)",
		]) {
			expect(answerCitations(undefined, `see ${text} for it`)).toEqual(canonical);
		}
		// A sentence period after a valid coordinate is punctuation, not a partial decimal coordinate (B6).
		expect(answerCitations(undefined, "The source of the offset is src/a.ts:12.")).toEqual(canonical);
		expect(answerCitations(undefined, "The source of the offset is src/a.ts#L12.")).toEqual(canonical);
		// A structured candidate keeps the path-only form only when it carries no coordinate at all.
		expect(answerCitations({ citations: [{ path: "src/a.ts" }] }, undefined)).toEqual([{ path: "src/a.ts" }]);
	});

	test("an invalid coordinate is not a citation and never falls back to the path alone", () => {
		for (const text of [
			"src/a.ts:0",
			"src/a.ts#L0",
			"src/a.ts#Lx",
			"src/a.ts#L9-L3",
			"src/a.ts:9-3",
			"[the line](src/a.ts#L0)",
			// A malformed suffix must not leave its valid prefix as a citation (B6).
			"src/a.ts#L2-Lx",
			"src/a.ts#L2-L99999999",
			"src/a.ts#L2:0",
			"src/a.ts#L2.5",
			"src/a.ts#L2-L3.5",
			"src/a.ts:2x",
			"src/a.ts:2-",
			"src/a.ts:2-3:4",
		]) {
			expect(answerCitations(undefined, `see ${text}`)).toEqual([]);
		}
		// The same applies to a structured candidate that names a coordinate it cannot have.
		for (const line of [0, -1, 1.5, 10_000_001]) {
			expect(answerCitations({ citations: [{ path: "src/a.ts", line }] }, undefined)).toEqual([]);
		}
	});

	test("the answer text is rewritten to path:line, and an unreadable form is left alone", () => {
		expect(normalizeAnswerText("limit: 42 (src/a.ts#L2-L3)")).toBe("limit: 42 (src/a.ts:2)");
		expect(normalizeAnswerText("[the line](src/a.ts#L2)")).toBe("[the line](src/a.ts:2)");
		expect(normalizeAnswerText("see src/a.ts:12 and src/b.ts:3-4")).toBe("see src/a.ts:12 and src/b.ts:3");
		const root = "/tmp/storm-citation-root";
		expect(normalizeAnswerText(`see ${root}/src/a.ts#L2`, { root })).toBe("see src/a.ts:2");
		expect(normalizeAnswerText(`42 (${root}/src/a.ts:2:5)`, { root })).toBe("42 (src/a.ts:2)");
		expect(normalizeAnswerText(`${root}/src/a.ts:2:limit: 42`, { root })).toBe("src/a.ts:2:limit: 42");
		// Nothing the parser does not read is rewritten into a citation.
		for (const text of ["bad src/a.ts#L0", "bad src/a.ts#L9-L3", "bad /etc/passwd:12", "local://doc.md#L3", "https://example.test/x.ts#L9"]) {
			expect(normalizeAnswerText(text, { root })).toBe(text);
		}
	});

	test("an absolute path is read only inside the canonical root, and never guessed from the cwd", () => {
		const root = "/tmp/storm-citation-root";
		expect(answerCitations(undefined, `see ${root}/src/a.ts#L12`)).toEqual([]);
		expect(answerCitations(undefined, `see ${root}/src/a.ts:12`, { root })).toEqual([{ path: "src/a.ts", line: 12 }]);
		expect(answerCitations(undefined, `see ${root}/src/a.ts#L12-L20`, { root })).toEqual([{ path: "src/a.ts", line: 12 }]);
		expect(answerCitations(undefined, `see ${root}/src/a.ts:12:5`, { root })).toEqual([{ path: "src/a.ts", line: 12 }]);
		expect(answerCitations({ citations: [{ path: `${root}/src/a.ts`, line: 12 }] }, undefined, { root })).toEqual([
			{ path: "src/a.ts", line: 12 },
		]);
		// Outside the root, and every non-project scheme, is not a citation.
		for (const text of [
			"/etc/passwd:12", `${root}/../secret.ts:12`, `${root}/src/a.ts#L2:1`,
			"local://doc.md:3", "agent://worker:3", "https://example.test/x.ts:9",
		]) {
			expect(answerCitations(undefined, `see ${text}`, { root })).toEqual([]);
		}
	});
});
