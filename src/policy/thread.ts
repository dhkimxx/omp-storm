/**
 * Where a Storm worker actually runs, and the one sentence each stop reason means.
 *
 * omp 19.2.1 keeps up to eight concurrent subagent runs on the main thread and, with `task.workerThreads` above zero,
 * puts later runs on pooled worker threads. A pooled thread has its own `globalThis`: it shares no module state with
 * the director's Storm instance, so none of G2 (what really runs), G3 (every cost counted) or the record (a reviewer's
 * verdict bound to a tree) can be held there. A worker must therefore not run there at all (decision D5).
 *
 * The detection is positive: the worker's own instance checks its Bun thread and whether omp installed a remote
 * registry. "I found no run in memory" is not evidence of a pooled thread — on the main thread the same absence
 * means another build of Storm wrote the admission or the shared state is gone, and the worker stops with that
 * different cause. The spawn hook does not predict placement: it would both refuse main-thread runs and miss pooled
 * runs. The child is where the stop happens, so unlucky placement costs only that child's start (decision D7).
 */
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent";
import type { WorkerStopReason } from "../types.ts";

/**
 * Require the Bun main thread and the host's local registry. Pooled workers install a remote registry before
 * loading extensions. Unlike omp's private thread identity module, the registry is exported by standalone omp.
 */
export function onHostMainThread(): boolean {
	try {
		return Bun.isMainThread === true && AgentRegistry.global() instanceof AgentRegistry;
	} catch {
		return false;
	}
}

/**
 * The sentence the director reads for a stopped worker: the cause, the three promises this host cannot hold there, and
 * what the user can do. Fixed nouns follow inserted values so the particles are right for every agent id.
 */
export function workerStopNotice(agent: string, reason: WorkerStopReason): string {
	if (reason === "pooled-thread") {
		return `${agent} 워커를 멈췄습니다. omp가 이 워커를 감독 세션과 메모리를 공유하지 않는 풀 스레드에 배치해, Storm이 실제로 도는 모델과 지출, 리뷰 판정을 확인할 수 없습니다(G2·G3·기록). 지금 실행 중인 워커가 끝난 뒤 더 적은 수로 다시 스폰하거나, 사용자가 omp 설정 task.workerThreads를 0으로 두면(모든 서브에이전트가 같은 스레드에서 실행) 인원수와 상관없이 스폰됩니다.`;
	}
	return `${agent} 워커를 멈췄습니다. 이 워커는 감독과 같은 스레드에서 실행됐지만 Storm이 그 실행의 메모리 상태를 찾지 못했습니다. 다른 빌드의 Storm이 함께 로드됐거나 실행 상태가 사라진 경우이며, 이 상태에서는 실제로 도는 모델과 지출, 리뷰 판정을 확인할 수 없습니다(G2·G3·기록). 실행을 새로 시작한 뒤 다시 스폰하세요.`;
}

/** The pooled-thread sentence alone, for callers that already know the cause. */
export function pooledThreadNotice(agent: string): string {
	return workerStopNotice(agent, "pooled-thread");
}
