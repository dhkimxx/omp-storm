/**
 * Every end-to-end scenario, in the one place that `e2e:all`, `qa-linux.sh` and the CI jobs read.
 *
 * A suite is one script under `scripts/e2e` that drives a real omp with the offline scripted model. Helpers
 * (`harness.ts`, `fake-llm.ts`, `phase1-kit.ts`, `contract-fixture.ts`, `screen.ts`, `swap-plugin.ts`,
 * `edit-probe-plugin.ts`, `proof-plugin.ts`, `typed-fixture.ts`) are imported by the suites and are not listed here.
 *
 * `group` says which CI job runs a suite; `qa` holds the release-QA scenarios that no CI job runs (the Linux QA pass
 * runs every group in order).
 */
export type E2eGroup = "e2e" | "e2e-guarantees" | "e2e-tui" | "qa";

export interface E2eSuite {
	/** The name in the result table and in its work folder (`<tmp>/storm-e2e-<name>`). */
	name: string;
	/** The script under `scripts/e2e`. */
	script: string;
	/** Extra environment this scenario needs; everything else is inherited. */
	env?: Readonly<Record<string, string>>;
	group: E2eGroup;
	/** One line for the plan and the report. */
	note: string;
}

export const E2E_GROUPS: readonly E2eGroup[] = ["e2e", "e2e-guarantees", "e2e-tui", "qa"];

/**
 * Roughly longest first, from the durations measured for the CI notes, so a pool of a few workers drains evenly and
 * the tail is short. A `--group` run keeps this order within its group.
 */
export const E2E_SUITES: readonly E2eSuite[] = [
	{ name: "tui", script: "tui.ts", group: "e2e-tui", note: "the interactive host: setup, approvals, ask, resume" },
	{ name: "host-facts", script: "host-facts.ts", group: "e2e-guarantees", note: "host facts the write order leans on" },
	{ name: "run", script: "run.ts", group: "e2e", note: "RPC consumer paths and the native run lifecycle" },
	{ name: "follow-up-job-snapshot", script: "follow-up-job-snapshot.ts", group: "e2e", note: "omp's job rows at a follow-up write" },
	{ name: "director-edit", script: "director-edit.ts", group: "e2e-guarantees", note: "the director edits files itself" },
	{ name: "acceptance", script: "acceptance.ts", env: { E2E_CONTRACT: "1" }, group: "qa", note: "implementation acceptance: the contract modes" },
	{ name: "admission", script: "admission.ts", env: { E2E_CONTRACT: "1" }, group: "qa", note: "implementation acceptance: admission" },
	{ name: "follow-up-ledger", script: "follow-up-ledger.ts", group: "e2e", note: "a follow-up's result reaches the ledger" },
	{ name: "hardening-writers", script: "hardening-writers.ts", group: "e2e-guarantees", note: "two writers never share a work tree unbounded" },
	{ name: "auto", script: "auto.ts", group: "e2e", note: "automatic-delegation consent and worktree ownership" },
	{ name: "session-scope", script: "session-scope.ts", group: "qa", note: "native session ownership and per-session stores" },
	{ name: "decisions", script: "decisions.ts", group: "qa", note: "routine decisions without a dialog" },
	{ name: "isolation", script: "isolation.ts", group: "qa", note: "selective lane isolation and host settings" },
	{ name: "hardening-pins", script: "hardening-pins.ts", group: "e2e-guarantees", note: "the approved model and effort are what runs" },
	{ name: "read-shell", script: "read-shell.ts", group: "e2e-guarantees", note: "a read lane with a shell runs like a writer" },
	{ name: "wait-evidence", script: "wait-evidence.ts", group: "qa", note: "native wait delivery and the result channel" },
	{ name: "result-direction", script: "result-direction.ts", group: "qa", note: "the result direction the plan approved" },
	{ name: "proof-channel", script: "proof-channel.ts", group: "qa", note: "the parent-observed proof channel" },
	{ name: "rework", script: "rework.ts", env: { E2E_REWORK_MODE: "accept" }, group: "qa", note: "a reviewable result that must be reworked" },
	{ name: "unplanned", script: "unplanned.ts", group: "e2e-guarantees", note: "a woken worker's answer is recorded" },
	{ name: "plan-mode", script: "plan-mode.ts", group: "e2e-tui", note: "plan mode refuses a manual start" },
	{ name: "checkpoint-resume", script: "checkpoint-resume.ts", group: "e2e", note: "a checkpoint across a native omp restart" },
	{ name: "continue", script: "continue.ts", group: "e2e", note: "the director continues a run the host cut off" },
	{ name: "early-start", script: "early-start.ts", group: "e2e-guarantees", note: "a lane starts before its prerequisite is accepted" },
	{ name: "director-reads", script: "director-reads.ts", group: "e2e-guarantees", note: "the director reads under automatic delegation" },
	{ name: "plugin-layout", script: "plugin-layout.ts", group: "e2e-guarantees", note: "Storm installed with no node_modules" },
	{ name: "worker-authority", script: "worker-authority.ts", group: "qa", note: "the worker's own write authority" },
	{
		name: "worker-authority-unauth",
		script: "worker-authority.ts",
		env: { PROBE_MODE: "unauthorized" },
		group: "qa",
		note: "the same authority when its admission cannot be read",
	},
];
