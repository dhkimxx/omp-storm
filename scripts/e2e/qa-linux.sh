#!/usr/bin/env bash
# Final Linux QA for the per-native-session Storm store. Every driver creates its own temporary HOME/profile and
# work directory, links the plugin there and talks to the scripted local provider: no real profile, credentials,
# network provider, deploy, or shared state is touched. Run from the repository root.
#
# Usage: bash scripts/e2e/qa-linux.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
export PATH="$ROOT/node_modules/.bin:$PATH"

run() {
	echo "=== $*"
	"$@"
}

# Native session ownership first: distinct ids in one checkout, resume by id from another transcript dir, forked
# conversation with no inherited team/approvals/history, old .omp/storm and profile approvals untouchable.
run bun scripts/e2e/session-scope.ts

# RPC consumer paths and the native run lifecycle in per-session stores.
run bun scripts/e2e/run.ts
run bun scripts/e2e/checkpoint-resume.ts

# Interactive host: setup, approvals, runs, ask/resume and shutdown/resume.
run bun scripts/e2e/tui.ts

# Automatic-delegation consent, lease safety for concurrent readers vs writers.
run bun scripts/e2e/auto.ts

# Routine decisions: a bounds refusal without a dialog, a worker ask, one marked irreversible decision, closeout.
run bun scripts/e2e/decisions.ts

# Selective lane isolation and host settings.
run bun scripts/e2e/isolation.ts

# Contract modes are the implementation acceptance pass; the baseline modes are historical reproduction only.
echo "=== E2E_CONTRACT=1 admission"
E2E_CONTRACT=1 bun scripts/e2e/admission.ts
echo "=== E2E_CONTRACT=1 acceptance"
E2E_CONTRACT=1 bun scripts/e2e/acceptance.ts
echo "=== E2E_REWORK_MODE=accept rework"
E2E_REWORK_MODE=accept bun scripts/e2e/rework.ts

# Native wait delivery and the parent-observed result channel.
run bun scripts/e2e/wait-evidence.ts
run bun scripts/e2e/proof-channel.ts
