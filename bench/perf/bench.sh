#!/bin/bash
# Timed runs go one at a time (they share the CPU that SwiftShader renders on).
# Usage: bench/perf/bench.sh <label> [run.mjs args...]
set -e
cd "$(dirname "$0")/../.."
exec flock /tmp/clay-perf-bench.lock node bench/perf/run.mjs --label "$@"
