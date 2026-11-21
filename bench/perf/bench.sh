#!/bin/bash
# Timed runs go one at a time, and alone: they share the CPU that SwiftShader renders on.
#  - /tmp/clay-perf-bench.lock queues benchmarks behind each other;
#  - /tmp/clay-bench.pending tells heavy jobs (heavy.sh) to hold back;
#  - /tmp/clay-cpu.lock, taken exclusively, waits for heavy jobs already running.
# run.mjs also measures CPU used outside the benchmark during each scene and flags the
# run as contaminated if it is significant.
# Usage: bench/perf/bench.sh <label> [run.mjs args...]
set -e
cd "$(dirname "$0")/../.."
exec flock /tmp/clay-perf-bench.lock bash -c '
  touch /tmp/clay-bench.pending
  trap "rm -f /tmp/clay-bench.pending" EXIT
  flock -x /tmp/clay-cpu.lock node bench/perf/run.mjs --label "$@"
' _ "$@"
