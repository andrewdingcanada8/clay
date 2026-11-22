# Journal: refine the settled frame (branch claude/sdf-perf-refine, from claude/sdf-perf-hillclimb 7f4d0e9)

Start: composite settled 98 ms (bench full-bricks): bricks pass ~58 ms + exact list pass ~45 ms (1033 px).
Gates vs bench/perf/results/2026-11-20T20-31-52-668Z-full-baseline. Probe: scratchpad/refine/probe.mjs (Q='?rt=1' gives
refine timings: readMs = cone + bricks pass + readback sync, exactMs = list pass).

| # | hypothesis / change | ms | gates | verdict |
|---|---|---|---|---|
| 1 | SwiftShader splits a draw by interleaved quad rows over its threads (4 cores); the 256-wide list was 6 rows = 3 quad rows, so the exact pass ran on <= 3 threads. List width LIST_W (?lq=): 256 / 32 / 8 | probe exactMs 40.6 / 22.5 / 24.7; frame ~110 / ~82 / ~81 | identical image (composite 0.09 % / 0.9999) | kept, LIST_W = 32 |
| 2 | SwiftShader skips a branch no lane of a quad takes: read the coarse field only when the cell has no brick (if, not a select), and normal taps read the brick alone (fieldB: no coarse read, no crease; coarse only off-brick). Knob xs (bits 1, 2) | bench refine-lw (#1) vs refine-xs3: composite 82 -> 72, custom-section 136 -> 125, grazing 363 -> 337, pieces-9 126 -> 108, csg-chain 91 -> 82, sweeps-64 117 -> 108; moving/edit unchanged | identical gates on all six | kept |
