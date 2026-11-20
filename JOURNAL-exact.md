# Journal: exact-field cost (branch claude/sdf-perf-exact)

Bench: `bench/perf/bench.sh <label> --scenes composite --frames 6` (SwiftShader, 4 cores shared with
other agents; untimed work by others leaks into timed runs: one run of a build gave 6619 and 7093 ms,
then 4850 / 4761 ms in a quiet minute; repeat a surprising result before believing it).
Baseline (070cbb8 + harness, my build): settled 5737 / 5729 / 5754 ms, moving ~1505 ms, maps/px 11.8,
objs/map 9.15 (reference noise1..5: 5552-5777 ms).
Images: compare.py against noise1; "identical" = diff>24 0.00 %, psnr 99, missed/extra 0, IoU 1.0000.

## Key finding: SwiftShader's cost model

Micro-benchmark (scratchpad exact/branch.mjs, a full-screen draw with a 400-op sin/cos block):
- block under an untaken uniform `if`: 862 ms vs 879 ms taken, vs 1 ms without the block.
  SwiftShader runs every branch's arithmetic for the whole quad, whether or not any lane takes it.
- a loop with 0 trips costs 1 body, 1 trip 2 bodies, 2 trips 3, 3 trips 4: loops pay trips + 1.
- with a block of 300 texelFetch instead: untaken 84 ms vs taken 723 ms. Masked fetches are cheap;
  masked ALU is not.
So on this harness, `if (need)`, `continue`, early `return` and gates save nothing; only fewer loop
trips and less arithmetic on the path save time. Laziness keyed on per-point tests (target 1) costs
here even when it evaluates fewer objects. On a real GPU (warp-uniform branches skipped) the
opposite holds; the harness can't show those wins.

## Attempts

| # | attempt | settled ms | moving ms | objs/map | images | kept |
|---|---|---|---|---|---|---|
| 1 | lazy sweeps: sdSweep inside sdObj (gate kept, shell cache carries the open-end distance), sweepAll/gSw removed | 11180 | 2937 | 6.04 | - | no: 2x slower. sdSweep inlined 9x (3 sdObj sites x 3 map sites), and its ALU now runs at every program step (see finding) |
| 2 | one map() call site: march + 4 normal + 4 AO taps in one phased loop | 5632 (base 5737) | 1488 | 9.15 | identical | yes (d63fb38), structural (requested target 2); within noise on SwiftShader. Compile (link + first draw, fresh browser): base 2.7-3.4 s, single 2.0-3.3 s: too noisy to call |
| 3 | lazy sweeps by request: the program step breaks out, the pass loop evaluates the one sweep, the step reruns (single sdSweep site per map; on top of #2) | 7257 | 2091 | 6.04 | - | no: +29%. Each request is an extra pass; every pass runs unitDepth's and the sweep's ALU masked |
| - | probe: never-taken `if` around a 3-trip sdSweep loop in map | 5805 | 1582 | | | (inconclusive: a loop; led to the micro-benchmark) |
| 4 | profile(): coordinates once, only the texture fetch picked by slot (uniform arrays for lo/hi/size) | 4761 / 4850 (A/B base 5754) | 1268 | 9.15 | identical | yes (23626e9), -17% |
| 5 | gridDepth/cubic: same hoist for the 4 grid samplers; dead roundCorr + uUseRound/uRoundR removed | 4753 (vs 4761) | 1258 | 9.15 | - | no: no gain (saved as scratchpad exact/grid-hoist.ts; shrinks the shader a lot, worth it for GPUs/compile) |
| 6 | sweepAll: bounds pass marks the sweeps within the gate (64-bit set), a second loop evaluates only those | 4179 | 1091 | 9.15 | identical | yes (ac03281), -12% |
| 7 | sdSweep: candidate loop visits only the applicable candidates (bit set) | 4142 | 1089 | 9.15 | - | no: -1% on composite (few sweeps, mostly far). Saved as exact/cand.ts |
| - | ablation: prism type drawn as a box (no frustum code at all) | 3742 | 1003 | 9.19 | changed | (frustum ALU ~10% of the frame) |
| 8 | frustum constants (cos/tan(pi/n), 1/slant) precomputed in row 7; atan/mod shared by both prism paths | 4088 | 1147 | 9.15 | | no: -2%. Saved as exact/frustum-const.ts |
| - | ablation: sdLocal replaced by a sphere (whole body removed) | 2754 | 740 | 10.92 | changed (maps/px 9.8) | (per map-pixel ~20% below #6) |
| 9 | skip loop: a tight inner loop advances past object steps that are off the ray or fail `need` (exact no-ops: smin/smax with h = 0 returns g, f unchanged; g <= f invariant covers the shell test), so the long step body runs only for steps that matter | 3155 (A/B 3182, 3220) | 899 | 9.15 | identical | yes (751b653), -24% |
| 10 | per-step trims: #8 frustum constants + length(q.xz) once + ROWS 16 (program fetch by shifts) | 3033 / 3030 / 3089 vs 3155 / 3182 / 3220 interleaved | 816-844 | 9.15 | identical | not alone: consistent -4% |
| 11 | #10 + one shared fold for op0/op2 (mask/cut/add as one smin with exact negations; 2 smin on the path instead of 12) | 2939 | 802 | 9.15 | identical (psnr 99) | yes (3cad6ac), -8% vs #9 |
| 12 | lazy sweeps by request again, on top of #11 (gSw removed; unitDepth's sdObj copies evaluate sweeps inline) | 4381 | 1208 | 6.04 | - | no: +49%. unitDepth runs (masked) every pass and now carries two sdSweep copies |
| - | ablation: unitDepth replaced by a constant (on #11) | 2398 | 651 | 9.08 | changed (maps 11.4) | (unitDepth ~18% of the frame) |
| 13 | unitDepth: shell and cut loops run past skipped objects in tight inner loops (cut: a bound past D + 0.5 leaves D exact), constant loop bounds; holeDepth reuses d for sphere/torus/capsule | 2872 (vs 2939) | 789 | 9.15 | identical | no: -2% |
| 14 | #13 + gridDepth hoist (#5) | 2881 | 807 | 9.15 | identical | no |
| 15 | the tight step loop also runs group opens (push / cluster jump) and group ends that hollow nothing (pop + fold); the long body only sees needed objects and hollow ends | 2710 (vs 2939) | 763 | 9.15 | identical | yes (6d0c3fe), -8% |
| 16 | #7 again (sdSweep candidate bit set) on top of #15 | 2516 (A/B 2481, 2537) | 706 | 9.15 | identical | yes (3f9fbce), -7% |
| - | ablation: no sweep evaluation (gSw = box bound) | 2197 | 614 | 8.77 | changed (maps 13.0) | (sweeps ~21% of a map) |
| 17 | rayMask x2 merged into one pass computing both masks | 2421, then A/B 2491 / 2463 vs 2481 / 2537 | 672-691 | 9.15 | identical | no: -2% |
| 18 | #17 + #13 | 2437 | 661 | 9.15 | identical | no |
| - | ablation: MAX_DEPTH 12 -> 4 (stack arrays smaller) | 2532 | 685 | 9.15 | identical | (the G/F/K arrays cost nothing measurable here) |
| 19 | sweeps evaluated one per pass of map()'s outer loop instead of a loop of their own (no masked extra sdSweep when none is in the gate) | 3082 | 860 | 9.15 | - | no: +23%; every sweep pass also runs the program loop and unitDepth masked |
| 20 | sdSweep chunk search: visit only the chunks that can hold a nearer segment than the nearest chunk's best (a bit set; superset of the running-best pruning, same winner) | 2481 (vs 2511) | 672 | 9.15 | - | no: -1% (few chunks on composite; may matter on sweeps-32/64) |
| 21 | cleanup: dead uniforms (uPins, uPinRange, uGroupC/E, uSweepCount, uUseRound, uRoundR) and functions (sdPin, roundCorr); run-time-bounded loops (sweep ranges, unitDepth) get constant bounds + break | 2499 (vs 2511) | 689 | 9.15 | identical | yes (6c80a92): neutral, kept as requested (GPU robustness / uniform budget). Compile + first draw: base 1650-1704 ms, branch 938-1062 ms |
| 22 | #13 + #17 + #20 together on top of #21 (scratchpad exact/combo.ts) | A/B 2415 / 2435 vs 2538 / 2534 (-4.4%); sweeps-64 6263 vs 6718 (-7%); custom-section 2534 vs 2628 (-4%) | 668-673 vs 693 | 9.15 | identical | no: under 5% on composite. A candidate if the bar moves |

## Full scene set (frames 2) vs the reference full-baseline run (2026-11-20T20-31-52-668Z, dist-baseline)

All 14 scenes bit-identical (diff>24 0.00 %, psnr 99, missed/extra 0, IoU 1.0000).

| scene | baseline ms | branch ms | speed-up | moving ms |
|---|---|---|---|---|
| composite | 5812 | 2981 | 1.95x | 1507 -> 814 |
| sweeps-8 | 2892 | 1653 | 1.75x | 773 -> 452 |
| sweeps-16 | 4362 | 2380 | 1.83x | 1222 -> 634 |
| sweeps-32 | 7962 | 3839 | 2.07x | 2153 -> 1057 |
| sweeps-64 | 13889 | 6580 | 2.11x | 3780 -> 1815 |
| pieces-1 | 5824 | 2623 | 2.22x | 1545 -> 727 |
| pieces-4 | 7220 | 3000 | 2.41x | 1982 -> 812 |
| pieces-9 | 5510 | 2203 | 2.50x | 1494 -> 610 |
| blend-heavy | 2001 | 1152 | 1.74x | 618 -> 304 |
| shell-heavy | 3038 | 1774 | 1.71x | 796 -> 481 |
| csg-chain | 2188 | 1103 | 1.98x | 590 -> 316 |
| custom-section | 3834 | 2702 | 1.42x | 1013 -> 700 |
| grazing | 6380 | 4220 | 1.51x | 1458 -> 1064 |
| close-up | 11368 | 5351 | 2.12x | 2995 -> 1507 |

(Composite at frames 6: 5737 -> ~2500 ms settled, 1504 -> ~690 ms moving.)

## Where a map() goes now (composite, ablations on the kept state)
- sweeps (sweepAll + sdSweep): ~21 % of a map
- unitDepth (hollow depth, incl. grids): ~18 % of the frame
- the rest: the program's tight step loop (~all steps per map) and the long step body for needed objects
  (sdLocal of every type runs on SwiftShader for each one; the prism's atan/sin/cos dominate it)
