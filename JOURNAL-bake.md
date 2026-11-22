# Journal: time to sharp after an edit — the bake (branch claude/sdf-perf-bake, from claude/sdf-perf-hillclimb 0753a56)

Start (full-edit2): prepareMs (bakeNow) composite 10.6 s, sweeps-64 43.5 s, close-up 20.0 s, custom-section 17.3 s,
grazing 22.0 s, csg-chain 1.9 s. Gates vs bench/perf/results/2026-11-20T20-31-52-668Z-full-baseline (strict; grazing 2.35 % / 0.9992).
Probe: scratchpad/bake/probe.mjs (`?rt=1`: bakeNow split by phase, synced), err.mjs (coarse field vs a one-level exact bake).

Split at the start (probe, composite / sweeps-64): coarse 192³ 4.4 / 23.6 s (2.8M / 6.0M voxels, all map()), classify ~0.2 / 0.4,
masks 0.1 / 0.3, brick samples 3.9 / 17.3 s (2.2M / 7.7M samples), copy 0.5 / 1.8, curvature + shading 0.6 / 2.0.

| # | attempt | prepareMs comp / sw64 / close / cs / csg / grazing | gates | verdict |
|---|---|---|---|---|
| 1 | two-level coarse: a half-resolution field (every voxel), then the fine field = its upsample wherever \|low\| > band (5 h), map() only nearer. First per voxel in one fine pass (branch) | probe composite coarse 4.4 -> 2.7 s; the cheap branch alone still cost 0.9 s (SwiftShader runs the big shader's setup per fragment) | - | -> tiles |
| 1b | the low field read back; fine = a tiny upsample pass everywhere + the bake shader only over band tiles (4×4 voxels of a layer whose low voxels come within the band or change sign; per voxel test kept inside), quads per layer, paced by tile count. err.mjs: fine field identical to the exact one wherever \|d\| < 3 h (band 5); 1 voxel off at 3-6 h; up to 6.9 voxels over at 6-12 h (the far field is not 1-Lipschitz) | bench bake-2: 8754 / 37272 / 15166 / 12907 / 1984 / 23381 (-18 / -14 / -24 / -26 / +6 / +6 %) | identical to full-edit2 (composite 0.07 % / 0.9999, grazing 2.35 % / 0.9992, custom-section 0.38 / 0.9994) | kept; the near-surface voxels dominate (band tiles 21 % composite, 38 % sweeps-64, cost 2.7 µs per texel), so the coarse bake only halves. Settled/moving ms read ~5-10 % higher on all scenes this run (machine noise or the far field: to watch) |
