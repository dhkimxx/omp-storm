/**
 * Every fixed wait the runtime makes on the real clock, in one value.
 *
 * The defaults are what the product ships. A caller that is a test may supply shorter ones (see
 * `tests/timings.ts`) so a check does not sit through a production constant that the test is not about; production
 * callers never pass any, so the waits below are exactly the ones the end-to-end suites observe on the real host.
 *
 * A wait that a test itself proves (a process that must survive SIGTERM, a job queue's own timeout) is passed to the
 * call under test directly and never taken from here.
 */
export interface StormTimings {
	/**
	 * How often an active run's live record is rewritten at most. The live record is what remains of a run whose
	 * process dies: the next run's janitor marks it stopped and it shows up as the last run with what it had spent and
	 * spawned.
	 */
	liveFlushMs: number;
	/** How often a stopping run asks whether work it still owns has settled. */
	drainPollMs: number;
	/** How long a round look is deferred while omp holds the session (streaming, a queued message, a draft). */
	holdMs: number;
	/** How long after a round ends Storm looks whether to send the next. */
	roundDelayMs: number;
	/**
	 * How long a consumer's admission may wait for an already-started settlement of its prerequisite. A native delivery
	 * often lands just before the next tool call: without this barrier the consumer would read the previous pending row
	 * and be refused for a result that is being written in the same tick.
	 */
	settleWaitMs: number;
	/**
	 * How long one fresh item waits for a conflicting shared writer to settle before the admission is refused. It is a
	 * wait, not a queue: a long-running writer still leaves the call blocked, and no reservation leaks.
	 */
	writeWaitMs: number;
	/** How often that wait looks again. */
	writeWaitStepMs: number;
	/** Most the director's next request waits for a delivery's evaluation before it carries the notice. */
	noticeWaitMs: number;
	/** SIGTERM is followed by SIGKILL after this grace; the result settles even if the child cannot be reaped. */
	killGraceMs: number;
	/** A result without proof settles after the kill grace plus this; the `ended` promise stays until the OS proves it. */
	hardTeardownMs: number;
	/**
	 * After the leader closed, members still in its group get this long to finish on their own (a helper exiting in the
	 * same instant is not "left behind") before the group is stopped. The wait only delays the end; the fence is never
	 * released during it.
	 */
	groupSettleMs: number;
	/** Probe pace while a command's result is still open. */
	groupProbeMs: number;
	/** After the result settled without proof, the group is probed this often, unreferenced, to resolve `ended` later. */
	groupLateProbeMs: number;
}

export const DEFAULT_TIMINGS: StormTimings = Object.freeze({
	liveFlushMs: 2_000,
	drainPollMs: 1_000,
	holdMs: 5_000,
	roundDelayMs: 800,
	settleWaitMs: 1_000,
	writeWaitMs: 1_500,
	writeWaitStepMs: 50,
	noticeWaitMs: 1_500,
	killGraceMs: 1_000,
	hardTeardownMs: 3_000,
	groupSettleMs: 50,
	groupProbeMs: 25,
	groupLateProbeMs: 250,
});

/** The fields a caller may replace; every other one keeps the product's value. */
export type TimingOverrides = Partial<StormTimings>;

/** One complete set of waits: the product's, with `overrides` on top. */
export function timingsOf(overrides: TimingOverrides = {}): StormTimings {
	return { ...DEFAULT_TIMINGS, ...overrides };
}
