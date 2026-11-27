/**
 * Why a Storm worker may not run on one of omp's pooled subagent threads, and the one refusal/notice that says it.
 *
 * omp 19.2.1 places subagent runs through `SubagentWorkerPool` (`thread/subagent-worker.ts`): it counts the runs in
 * flight, keeps up to {@link HOST_MAIN_THREAD_RUNS} of them on the main thread, and from the next one on puts runs on
 * a pool of workers that share no module state with the director's Storm instance. How many worker slots may be used
 * follows `allowedSubagentWorkers` (one at 9, one more per doubling, capped by `task.workerThreads`), and a new run
 * goes to the least loaded of the main thread and those slots, ties to a worker; `task.workerThreads: 0` keeps every
 * run on the main thread (`task/settings.ts`). Storm cannot read the pool's live counts for other sessions or native
 * subagents, so the spawn hook only refuses when it can prove the main thread is already full of its own workers, whose
 * first requests were checked in this process; otherwise the host may still pool the child and the child's own stop is
 * the guarantee.
 */

/** Concurrent subagent runs omp keeps on the main thread before it uses a pooled worker (`SUBAGENT_WORKER_THRESHOLD` in the host). */
export const HOST_MAIN_THREAD_RUNS = 8;

/**
 * Whether a fresh spawn is pooled on what Storm can prove: the user left `task.workerThreads` above zero, and this
 * parent already has {@link HOST_MAIN_THREAD_RUNS} live workers whose requests were checked on the director's thread
 * (a pooled worker would have stopped before its first request instead, so it cannot be one of them).
 */
export function placementWouldPool(input: { workerThreads: number | undefined; verifiedMainWorkers: number }): boolean {
	return input.workerThreads !== undefined && input.workerThreads > 0 && input.verifiedMainWorkers >= HOST_MAIN_THREAD_RUNS;
}

/**
 * The sentence the director reads when a worker was stopped (or its spawn refused) because omp would run it on a
 * pooled thread: the cause, the three promises this host cannot hold there (G2, G3 and the record's reviewer verdict),
 * and the two ways out. Fixed nouns follow inserted values so the particles are right for every agent id.
 */
export function pooledThreadNotice(agent: string): string {
	return `${agent} 워커를 멈췄습니다. omp가 이 워커를 감독 세션과 메모리를 공유하지 않는 풀 스레드에 배치해, Storm이 실제로 도는 모델과 지출, 리뷰 판정을 확인할 수 없습니다(G2·G3·기록). 지금 실행 중인 워커가 끝난 뒤 더 적은 수로 다시 스폰하거나, 사용자가 omp 설정 task.workerThreads를 0으로 두면(모든 서브에이전트가 같은 스레드에서 실행) 인원수와 상관없이 스폰됩니다.`;
}
