# Journal: per-cell pruning (branch claude/sdf-perf-prune, from 849405b)

Bench: `bench/perf/bench.sh prune-<n> --dist bench/perf/ref/dist-prune-<n> --scenes composite,sweeps-64,pieces-9,close-up`
(frames 8, SwiftShader, CPU shared via the global lock). Gates vs full-baseline: diff>24 <= 0.5 %, missed ~29 on
composite, IoU >= 0.999.

## Design (attempt 1)
- Where: after the field bake (same job, extra "layers"; benchPrepare bakes both). A 3D RGBA32UI grid of cells of
  CELL = 2 voxels. The cell shader (FRAG with SDF_CELLS) runs the layer program exactly at the cell centre (every
  object evaluated, sweeps exactly) and keeps an object's bit only when it can change the fold somewhere within
  R of the centre: v - R < g|f + R + k (adds), v - R < k - g + R (cuts), masks and objects with openings always;
  at a hollow body's end where f - R < OPENING_EPS (the hollow depth may run): shells within kS (+2R) of the
  deepest shell term, and every cut of the body. R = 1.15 * half-diagonal of the cell box grown by the
  window's sample spacing and the normal taps' reach. Cells far from the baked surface get every bit.
- Exactness: a pruned step is a smooth min/max with h = 0 (returns g and f unchanged) at every point of the ball,
  so the settled field is unchanged; the 1.15 slack covers fields that are only near-1-Lipschitz (tables, grids).
- Application: no free sampler in the settled shader, so the start pass (march mode 1) now writes an RGBA32UI
  texture: x = the hit distance (float bits, rounded to half as before), yzw = OR of the cell masks at 3 samples
  along the settled window [ts - 0.1h, ts + 2.9h] (objects 0-95; 96+ always on). The settled pass ANDs it into
  gMask once per ray (not per map call). The past-the-window fallback recomputes the ray mask without it.

## Attempts

| # | attempt | composite ms | sweeps-64 | pieces-9 | close-up | objs/map (comp) | gates | verdict |
|---|---|---|---|---|---|---|---|---|
| 0 | reference: 849405b as is | 707 | 1284 | 665 | 1301 | 6.19 | (merge build) | - |
| 1 | cells as designed (CELL 2, NS 3, LIP 1.15, ne 0.25h) | 661 | 1280 | 659 | 1273 | 6.06 | bit-identical to #0 (diff 0, IoU 1) | partial: the first object of every group is always kept (the fold starts at 1e5) |
| 2 | + a group whose whole fold is a no-op over the cell drops its objects; openings follow the fold test unless the hollow depth may run | (probe only) | | | | cell avg 10.4 -> 7.1 bits | | -> |
| 3 | + absorption: an add k below g and f over the cell (no cut/mask before it in its group) drops the group's earlier steps (monotone smin: dropping adds only raises what it absorbs) | 646 | 1295 | 672 | 1309 | 5.52 | bit-identical | yes; sweeps-64 unchanged: probe showed its pixels got all-ones (pixel footprint > the 0.25h normal reach the cells allowed) |
| 4 | ne 0.5h (pixels get masks everywhere) | 670 | 1295 | 674 | 1312 | 5.61 | bit-identical | sweeps-64 objs/map 9.43 -> 9.40 only: its 64 ribs are 0.88 apart with 0.6 radius, they overlap; every nearby rib really matters |
| 5 | NS 6, LIP 1.1, ne 0.3h, far cut sqrt3/2 H + 4.5h (R composite 1.04 -> 0.77) | 660 | 1296 | 691 | 1270 | 5.42 | bit-identical | kept as the base; within noise of #3 |
