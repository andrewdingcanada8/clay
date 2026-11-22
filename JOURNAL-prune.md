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

Per-cell pruning parked on branch claude/sdf-perf-prune-cells (cba5358): exact (bit-identical on all four scenes)
but only ~5-8 % on the still frame (objs/map 6.19 -> 5.42), and it cannot help editing frames (cells are baked).
Its window assumptions (0.1h back-off, 3 forward normal taps) also no longer match the hill-climb branch's settled
pass (0.5-voxel back-off, tetrahedral taps), so it is reverted here before merging that branch.

# Part 2: editing frames (msEdit)

Harness: `bench.sh edit-<n> --scenes composite,sweeps-64,blend-heavy,csg-chain,pieces-4` (msMean settled, msEdit).
NOTE: the harness' benchEdit re-sends the *same* doc (setDoc(doc, true)), so it measures a no-op edit. For real
drags I use scratchpad drag.mjs (run under the bench lock): it moves one object 0.05 per frame through
setSdfDoc(interactive) + setSdfGrids (grids of the bodies around it dropped, as main.sync does), times the edit
frame (drawLow at the moving resolution, 200x193), and compares the last frame with the full exact path
(msExact = the old edit frame, same doc).

Edit frame before: setDoc(interactive) + the whole exact field at the moving resolution (full march from the box,
4 normal taps, 4 exact occlusion taps): ~3.3x the per-pixel cost of a settled pixel with a bake.

| # | attempt | settled ms (comp / sw64 / blend / csg / p4) | harness msEdit (no-op edit) | real drag msEdit vs msExact (drag.mjs) | edit image vs exact | verdict |
|---|---|---|---|---|---|---|
| e0 | reference (merge of hill-climb c369965) | 827 / 1647 / 479 / 573 / 858 | 687 / 1816 / 315 / 321 / 812 | - | - | - |
| e1 | stale-bake reuse mid-drag: FieldSnapshot at bake start (program shape, per-object key + world box grown by rayMask's reach + 2.1 for taps, per-body key incl. grid identity + box); dirtyBoxes = boxes of changed objects/bodies (old and new), merged to <= 8; drawLow with a stale bake: start pass from it, rays clear of dirty boxes take the settled window path (baked AO), others march exactly from their first dirty box | - | - | comp tab og 366 vs 765; cup ol 565 vs 776; body torus o5 745 vs 767 (body grid dropped: whole body dirty); sw64 rib 585 vs 1867; blend 221 vs 333; csg 244 vs 323; p4 tab 351 vs 773 | diff>24 <= 0.024 %, missed <= 6 px of ~8300 | -> |
| e2 | + dirty rays end at max(last dirty exit, baked hit) + 3h (the stale field holds past the boxes) | 1028 / 1720 / 630 / 743 / 1072 (A/B 994 vs 795) | 293 / 499 / 178 / 203 / 288 | about the same as e1 | same, csg missed 12 / 8483 | no: settled +25 %; the per-pixel `useStart` replacing uniform `uStartOn == 1` slows the settled shader on SwiftShader |
| e3 | the per-pixel choice only in a shader variant (SDF_DIRTY, second material swapped in by setDirty); the settled shader is unchanged | 801 / 1656 / 470 / 578 / 881 (bit-identical images) | 272 / 471 / 163 / 193 / 280 | comp og 355 vs 744; ol 537 vs 779; o5 737 vs 716; sw64 591 vs 1765; blend 226 vs 333; csg 228 vs 325; p4 og 368 vs 798 | as e2 | yes |
| e4 | cavity-only dirt: a body whose grid changed (dropped mid-drag, not compound) dirties only its cavity box (bounds + taps' reach, not the opening-grown box); first try: the bake gets a green "cavity" channel and the start pass flags rays that met it | settled same; moving 45 -> 50 ms (RG bake texture costs the shading march even with a START-only fetch) | - | comp torus o5 517 vs 726 (was 737) | missed 18 / 8345 at first: dirty rays were cut at max(tDx, ts) + 3h with no fallback past it; fixed by treating that end like a window (rest-of-ray fallback): missed <= 3 everywhere | the RG channel: no |
| e5 | cavity check without a bake channel: a ray through a cavity-only box keeps the window path, and restarts exactly from that box if its window hit is a cavity wall (gKind 2) or its first sample is already inside (a moved inner wall); also near misses of the stale march (closest approach < 1.5h, written by the start pass) march exactly round it; dirty rays fall back past their end | 868 / 1615 / 464 / 585 / 844 (bit-identical to e0; moving 46 / 48 / 43 / 34 / 42) | 343 / 583 / 207 / 234 / 352 | comp o5 480 vs 760; og 404 vs 755; body revolve o3 773 vs 729; p4 o5 403 vs 749; sw64 rib 683 vs 1797; csg 276 vs 327 | missed <= 2 px, diff>24 <= 0.05 % | yes. Not proven exact in one case: a ray that enters a cavity through an opening and leaves it again without meeting a wall (grazing an opening), then hits an outer surface |
| e6 | translation bound: when every change is an object moving without turning or changing shape (and no body setting changes), the field moved by at most shift = the largest move; the start pass first marches by d - shift and writes tS, where that bound first allows a surface; changed rays start no earlier than tS, and a stale miss whose shifted march never came near is dropped (settled start unchanged: 160 steps, shift 0) | 842 / 1628 / 457 / 569 / 851 (bit-identical to e0; moving 45 / 49 / 44 / 32 / 41) | 335 / 571 / 196 / 255 / 345 | comp body revolve o3 699 vs 744 (was 773); torus o5 463 vs 766; og 411 vs 756; p4 o5 392 vs 757; sw64 683 vs 1826; csg 264 vs 327; blend 243 vs 314 | missed 0 on composite, <= 2 elsewhere | kept: -10 % on whole-body drags, neutral elsewhere |

## Where it stands (editing)
- Real drags at the moving resolution (drag.mjs, 7 frames of 0.05 moves, under the bench lock), exact path -> now:
  composite tab 756 -> 411 ms, cup 776 -> ~550, torus 766 -> 463, body revolve 744 -> 699; pieces-4 tab 798 -> 368,
  torus 757 -> 392; sweeps-64 rib 1826 -> 683; csg-chain 327 -> 264; blend-heavy 314 -> 243.
- Harness msEdit (no-op edit: benchEdit re-sends the same doc, so nothing is dirty and every ray takes the window):
  687 / 1816 / 315 / 321 / 812 -> 335 / 571 / 196 / 255 / 345. This overstates real drags; consider making benchEdit
  move an object.
- Settled shader and settled images untouched (bit-identical to e0); moving frames unchanged.
- Edit frames vs the exact edit frame: diff>24 <= 0.05 %, missed <= 2 px of ~8000.
- Limits: a whole-body change (the body's main revolve) stays ~ the exact cost; a rotation or reshape falls back to
  boxes without the shift bound; ray entering and leaving a cavity through an opening without meeting a wall, then
  hitting an outer surface, is the one case the cavity-only rule does not cover exactly.
