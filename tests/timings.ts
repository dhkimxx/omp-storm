/**
 * The waits a test run uses instead of the product's (see `src/runtime/timings.ts`).
 *
 * The fields that only delay a check are shorter than the shipped values — long enough for a file write, a process
 * exit or a group probe to land, short enough that a check does not sit through a constant it is not about. The round
 * and hold delays keep the shipped values: a look that fires early would send a message a test did not ask for. A test
 * that proves a wait itself (a member that must survive SIGTERM, a job's own queue timeout) passes its own value
 * instead of this one, so the shipped default stays observable in the end-to-end suites.
 */
import { timingsOf } from "../src/runtime/timings.ts";

export const TEST_TIMINGS = timingsOf({
	liveFlushMs: 1,
	drainPollMs: 5,
	holdMs: 5_000,
	roundDelayMs: 800,
	settleWaitMs: 20,
	writeWaitMs: 100,
	writeWaitStepMs: 10,
	noticeWaitMs: 100,
	killGraceMs: 100,
	hardTeardownMs: 200,
	groupSettleMs: 25,
	groupProbeMs: 10,
	groupLateProbeMs: 25,
});
