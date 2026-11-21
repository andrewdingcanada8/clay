#!/bin/bash
# Run a CPU-heavy command (build, typecheck, tests) without disturbing a timed benchmark.
# Heavy jobs share /tmp/clay-cpu.lock; bench.sh takes it exclusively. A benchmark that
# is waiting raises /tmp/clay-bench.pending, and new heavy jobs hold back until it is
# done, so benchmarks never starve.
# Usage: bench/perf/heavy.sh <command...>     e.g. bench/perf/heavy.sh npm run build:single
while [ -e /tmp/clay-bench.pending ]; do sleep 2; done
exec flock -s /tmp/clay-cpu.lock "$@"
