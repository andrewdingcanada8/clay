# Resume note (read this first after a stop; don't re-read source files)

Updated: 2026-11-22 (device fix 3 published)

## Incumbent (claude/sdf-perf-hillclimb, pushed)
- Still frame composite 934 ms headless (6.1x, strict images on 13/14 scenes; grazing passes with 1-px aliasing tolerance).
- Orbit ~46 ms; editing ~720 ms; bake 4.3 s headless. iPhone (older 8.7x build): still 18 ms, orbit 1-2 ms, bake 109 ms.
- Builds: bench/perf/ref/dist-near-kept is the incumbent build. Reference run: results/2026-11-20T20-31-52-668Z-full-baseline.

## In flight
- Bricks agent (id aacf436b21239f4a1, worktree .claude/worktrees/agent-aacf436b21239f4a1): bake size/time + strict gates on hard scenes. Last: composite settled 100 ms (57x), bake 27 s headless.
- Pruning agent (id ae40e736ec7aa49f4, worktree .claude/worktrees/agent-ae40e736ec7aa49f4): editing regime (cheap per-drag object lists).
- Both stopped at usage limit 18:40 UTC; resumed 21:10 UTC.

## Device
- 4-jug crash cause (v5 log): exact orbit frames before the bake finished piled up on the GPU. Fixed (fence-paced exact moving frames, bake paused while moving). Clay Preview v6 = bench/perf/ref/dist-device3. Awaiting user rerun.

## Agent progress (00:25 UTC)
- Bricks: cone pre-pass gives composite 51 ms but misses 2/3 of clay (cone step cap); being fixed.
- Editing: stale-bake reuse mid-drag, drag frames 2.5-3.9x faster, settled bit-identical (attempt e3). Not merged yet.

## Next
1. When bricks reports: merge its branch into claude/sdf-perf-hillclimb, full suite (bench/perf/bench.sh full-<name> --dist bench/perf/ref/dist-<name>), compare.py vs full-baseline, log, publish Clay Preview + dashboard, ask user for iPhone rerun.
2. When pruning reports: measure msEdit; integrate if it wins.
3. Heartbeat: send_later 60 min, re-armed every step.
