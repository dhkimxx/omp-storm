#!/usr/bin/env bash
# Final Linux QA. Every driver creates its own temporary HOME/profile and work directory, links the plugin there and
# talks to the scripted local provider: no real profile, credentials, network provider, deploy, or shared state is
# touched. Run from the repository root.
#
# The scenario list, each one's environment and its group live in scripts/e2e/suites.ts, which `npm run e2e:all`, this
# script and .github/workflows/ci.yml all read. This pass is sequential (one suite at a time) and runs every group.
#
# Usage: bash scripts/e2e/qa-linux.sh [jobs]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
export PATH="$ROOT/node_modules/.bin:$PATH"

exec bun scripts/e2e/all.ts --jobs "${1:-1}"
