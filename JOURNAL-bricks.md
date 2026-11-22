# Journal: fine sparse bricks for the settled frame (branch claude/sdf-perf-bricks)

Base: 849405b (merge-smoke: composite settled 680 ms, moving 41 ms, prepare 4627 ms, maps/px 6.54).
Reference images: bench/perf/results/2026-11-20T20-31-52-668Z-full-baseline.
Strict gate: diff>24 <= 0.5 % of clay, IoU >= 0.999, missed ~ as now (composite 29).
Loose floor: diff>24 <= 2 %, IoU >= 0.995.

## Design (bricks.ts, bake.ts)
- After the coarse 192³ bake: a classify pass (one fragment per column of 2×2×2-voxel cells,
  bits packed in RGBA32UI, read back) flags cells whose nearest corner is within
  THR voxels of the surface. CPU lists them: slot table (RGBA32F, 4096 wide) and an
  indirection 3D texture (R32F, cell → slot + 1).
- Bricks: (N+1)³ samples of the exact map() per cell (spacing B/N voxels), baked with the
  FRAG shader's SDF_BRICK path into an R16F 3D atlas (40×40×az slots), fence-paced.
- Settled pass (SETTLED, new shader, own samplers): one sphere-trace loop over
  field() = brick (hardware trilinear) where the cell has one, else the coarse field;
  the clip plane added analytically; same eps / grazing rule as the exact pass; normals by
  central differences on the brick field (cap: the plane normal); AO from the coarse field.

## Attempts

| # | change | settled ms | prepare ms | bricks | gates (composite) | verdict |
|---|---|---|---|---|---|---|
| 0 | probe: one level, B=2, N=8 (9³/brick), THR 2.49 voxels (corners) | ~75 (probe, contended) | 92900 (probe) | 46k | 0.27 % / missed 25 / IoU 0.9992 | gates pass; bake far too big (34M samples) |
| 0b | THR 1.6 (any of the 27 cell samples), N = 8 / 4 / 2 | 70 / 64 / 66 | 58000 / 14800 / 7500 | 38k | N8 0.27 %, 25, 0.9992; N4 0.74 %, 67, 0.9980; N2 2.15 %, 207, 0.9938 | N=4 fails at thin rims (lip of pot and cup): trilinear rounds sharp edges |
| 0c | two levels: N=4 smooth, N=8 where a coarse second difference > bs·h; bs 0.15 / 0.3 / 0.6 | ~95-100 | 49000 / 70000 / 33600 (contended) | 12k+26k / 19k+19k / 25k+13k | 0.27 %/25 for 0.15 and 0.3; 0.31 %/33/0.9990 for 0.6 | bs 0.6 kept (fewest N=8 bricks that pass) |
| 0d | + per-brick object/cluster masks (rayMask at the cell centre, reach half-diagonal + 3 voxels) for the brick bake | - | - | same | identical image | kept (exact within the band); no measurable bake gain on composite |
| 1 | bench bricks-1 (dade4ae): 2 levels, bs 0.6, masks | composite 100, sweeps-64 108, pieces-9 81, close-up 147, grazing 235, custom-section 108 (base 691 / 1297 / 662 / 1320 / 1733 / 684) | 27384 / 95374 / 16294 / 50454 / 82262 / 38789 (base 4586 / 23847 / 7073 / 9756 / 2661 / 8792) | composite 25k+13k (12.9M samples) | composite 0.31 % / 33 / 0.9990; sweeps-64 0.08 / 6 / 0.9999; close-up 0.15 / 33 / 0.9997; pieces-9 0.79 / 53 / 0.9959; custom-section 1.07 / 127 / 0.9966; grazing 3.81 / 57 / 0.9988 (current build: pieces-9 0.97 / 0.9972, custom-section 1.86 / 0.9963, grazing 3.48 / 0.9992) | kept: 6-12x faster settled; strict on composite, sweeps-64, close-up; the 3 hard scenes at parity with the current build; bake 4-30x too big |
| 2 | apron-free bake: each brick bakes its own N³ samples (core atlas); a copy pass (no map()) fills the +1 faces from the neighbour's core (other level: interpolated; none: extrapolated) | ~same | composite samples 12.9M -> 8.5M (-34 %) | same | composite 0.34 % / 33 / 0.9989; custom-section 8.8 % (a slab of garbage) | bug: the copy pass read cores with filtered texture() and SwiftShader's filter weights land on the next slot; fixed with exact texelFetch + trilinear by hand -> custom-section 1.10 % (parity with no-copy 1.07 %). Kept |
| 3 | knobs, probes (contended, quality only): THR 1.2 (vs 1.6) | - | composite samples 8.1M | 21k+13k | identical gates on composite, pieces-9 | THR 1.2 is free |
| 3b | sharp level N=6 instead of 8 | - | composite samples 4.5M | | composite 0.46 % / 43; pieces-9 1.16 % / 0.9944 | no |
| 3c | normal taps 0.25 / 0.5 fine spacings (vs 1) | - | - | | custom-section 1.06 / 1.00 %; pieces-9 0.79 / 0.72 %; grazing 3.41 / 3.40 % (vs 3.81); missed unchanged | small; the misses are the field, not the normals |
| 3d | occlusion taps read the bricks (ao=1) | - | - | | grazing 3.40 %; custom-section worse | no |
| 3e | brick reads by hand in fp32 (8 texelFetch) instead of the hardware filter | - | - | | identical gates | the settled reads' filter weights are fine |
| 4 | curvature correction: trilinear minus ½Σ w(1-w)·Δ²_axis (second differences from 6 more texel reads): trilinear of a convex field overestimates, so silhouettes lost pixels | bench bricks-2: composite 231, sweeps-64 211, pieces-9 194, close-up 315, grazing 564, custom-section 242 | 21098 / 68263 / 13267 / 37497 / 69372 / 30719 | 2 levels, THR 1.6 | composite 0.27 % (aa 0.08) / missed 8 / 0.9995; pieces-9 0.64 / 23 / 0.9977; custom-section 0.86 / 84 / 0.9976; grazing 3.54 (aa 0.42) / 0.9987; close-up 0.13 / 0.9998; sweeps-64 0.07 / 0.9999. Single level N=4 + correction: composite 0.58 % / 29 / 0.9989 at 2.4M samples | quality kept (07ce03b), but 2.3x the settled cost (28 texel reads per step) |
| 5 | two-stage march: filtered reads until within eps + 0.25 fine spacing, then the corrected reads (<=16 + 12 steps) | bench bricks-3: composite 193, pieces-9 170, custom-section 208 | same | | composite 0.64 % / 40 missed / 68 extra / 0.9968; pieces-9 1.17 % / 0.9930 | no: little faster, worse (rays switching fields mid-approach) |
| 6 | curvature baked: a pass after the copy writes RGBA (d, Δ²x, Δ²y, Δ²z) per sample from the value atlas (inside the brick; faces use the next sample in); the settled read is one filtered RGBA fetch minus ½Σw(1-w)Δ² | bench bricks-4: composite 124, pieces-9 101, custom-section 154 | 20907 / 13477 / 30156 | same | composite 0.24 % (aa 0.05) / 11 / 0.9994; pieces-9 0.64 % / 22 / 0.9974; custom-section 0.83 % / 85 / 0.9976 | kept (22df45b): quality of #4 at about the cost of #1 |
| 7 | one read atlas (RGBA16F, both levels stacked in z, 360 wide) + an RGBA32F per-cell indirection (brick texel start, N): per step 1 indirection fetch + 1 RGBA fetch + coarse, no integer slot math | bench bricks-5: composite 80, pieces-9 68, custom-section 97 | 21283 / 13624 / 30267 | same | identical to #6 | kept |
| 8 | tetrahedral 4-tap normals (vs 6-tap central) + coarse read without the outside term, precomputed texture scales | bench bricks-6: composite 79, pieces-9 66, custom-section 91 | same | same | composite 0.54 % (aa 0.20); pieces-9 1.19 %; custom-section 1.14 %; silhouettes unchanged | tetra normals no (worse diff, no speed); the read micro-opts kept (neutral) |
| 9 | bake-size knobs on the #8 build (tetra normals, so diff is offset; silhouettes comparable), composite / pieces-9 / custom-section: bn2=6 | - | fewer samples | | 0.75/13/0.9994; 1.78/38/0.9964; 1.71/105/0.9971 | no (silhouettes worse) |
| 9b | bs=1.0 (fewer sharp cells) | | | | 0.86/19/0.9992; 2.19/38/0.9963; 2.16/135/0.9963 | no |
| 9c | bl=1 (second differences only on sample lines within 1 voxel of the surface) | | | | 0.53/11/0.9995; 1.19/22/0.9974; 1.15/86/0.9976 (= base) | neutral on quality; sample count to check |
| 9d | bl=1 & bs=0.4 | | | | 0.46/9/0.9994; 0.98/22/0.9973; 0.78/69/0.9980 | best quality so far; sample count to check |
| 9e | bt=1.2 | | | | identical to base | free |
| 10 | cone pre-pass (one ray per 4×4 block, coarse field, cone radius 3.5 px + 2 voxels): rays start where their block's cone came near | bench bricks-7: composite 51, pieces-9 43, custom-section 59 | | | 2/3 of clay missed | bug: a cone approaching the surface takes ever smaller steps and ran out of steps -> "no hit"; fixed: stop within 0.25 voxel, and any stop but leaving the box is a safe start |
| 10b | cone pre-pass fixed | bench bricks-9: composite 62, pieces-9 54, custom-section 76 (from 80 / 68 / 97) | same | same | composite 0.23 / 11 / 0.9994; pieces-9 0.65 / 22 / 0.9974; custom-section 0.84 / 86 / 0.9976 (same as #7) | kept |
| 11 | cone block 8×8 (vs 4×4) | bench bricks-10: composite 65, pieces-9 57, custom-section 74 | | | same | no |
| 12 | probes (quality on the cone build; samples from probe.log), composite / pieces-9 / custom-section: bt=1.2 | | samples 8.14M / 3.41M / 10.7M (base 8.49 / 3.66 / 12.2) | | identical | kept as default |
| 12b | bt=1.2 & bl=1 | | 7.40M / 3.21M / 9.48M (-13 % / -12 % / -22 %) | | 0.22/11/0.9995; 0.66/22/0.9974; 0.85/87/0.9976 | kept as default |
| 12c | + bs=0.4 / bs=0.3 | | 8.86M / 10.1M (composite) | | best: bs 0.3: pieces-9 0.53/21/0.9981, custom-section 0.63/69/0.9981 | more N=8 bricks buy a little; still not strict on the hard scenes (silhouette at sharp edges) |
| 13 | merge main (near-approach start depths etc.), full suite bench bricks-11-full (not contaminated) | composite 58, sweeps-8 75, -16 76, -32 83, -64 77, pieces-1 63, -4 61, -9 53, blend-heavy 60, shell-heavy 67, csg-chain 47, custom-section 76, grazing 227, close-up 92 | 18984 / 16938 / 22349 / 32223 / 47366 / 30677 / 17482 / 12920 / 5706 / 11400 / 2839 / 25864 / 72156 / 33929 (current main about 2.7-24 s) | | strict pass: composite 0.22 % / 0.9995, close-up, blend-heavy, pieces-1, shell-heavy 0.9991, csg-chain 0.9990, sweeps-8/16/32/64. Fail strict: pieces-4 IoU 0.9989 (diff 0.37), pieces-9 0.66 % / 0.9974, custom-section 0.85 % / 0.9976 (loose pass), grazing 3.53 % (aa 0.50 %) / 0.9981 (loose IoU pass) | kept |

## Where it stands (after #13)
- Settled: composite 58 ms (base 691 ms; original baseline ~5800 ms); 47-92 ms on every scene but grazing
  (227 ms: large thin slabs, ~245k bricks, long grazing rays).
- Strict gates fail only where trilinear bricks round sharp silhouettes (pieces-4/9, custom-section) and on grazing.
  Next: flag cells where the bricks disagree with exact (bake a few exact check points per sharp brick and
  compare), mark pixels whose ray passed such a cell near eps, and resolve only those pixels with the exact
  pass in a separate draw (points or small scissors: on SwiftShader an exact map() inside the bricks shader
  costs every pixel, taken or not).
- Bake: 4-10x the coarse bake (composite ~7.4M brick samples; N=8 sharp bricks are ~75 % of them).
  Next: a cheaper sharp level (N=8 only where a crease lies within a fine voxel of the surface, judged on the
  N=4 samples), per-sample object culling that pays (cell masks were neutral here), and cells fully inside
  thin slabs (grazing).
| 14 | exact refinement: the bricks pass flags pixels (alpha 128, start distance in rgb) whose hit lies where a brick second difference > fc=0.3 fine spacings, or whose ray came within eps + 1 fine spacing of such a place without touching; CPU reads the frame back, lists them (256-wide RGBA32F), the exact settled shader (FRAG, SDF_LIST: one fragment per listed pixel, start from the list, colour packed in one float + depth) resolves them into a list target, points scatter them back | bench bricks-12: composite 149, pieces-9 144, custom-section 244, pieces-4 152, grazing 678, csg-chain 100 | same | flagged (probe): composite 1415 px (4.4 % of clay), pieces-9 1470 (11 %), custom-section 3660 (10 %) | composite 0.07 % / IoU 0.9999; pieces-9 0.15 / 0.9998; custom-section 0.28 / 0.9997; pieces-4 0.08 / 0.9999; csg-chain 0.03 / 1.0000; grazing 2.00 % (aa 0.13 %) / 0.9990 — strict everywhere (grazing aa-tolerant) | quality goal met; too slow: near-miss pixels that miss in the window marched the exact field to the box exit |
| 14b | fc=0.15 (probe) | | | flagged composite 6365, pieces-9 5420, custom-section 5020 | 0.04/1.0000; 0.08/0.9999; 0.18/0.9998 | more than needed |
| 14c | flag also rays that passed near a crease and hit further on (start at the near point, exact may continue); near-misses with no brick hit: exact looks only in the window | bench bricks-13: composite 326, pieces-9 257, custom-section 341, pieces-4 335, grazing 2550, csg-chain 168 | | many more flagged | composite 0.03 % / 0.9999; custom-section 0.20 / 0.9996; grazing 0.99 % (aa 0.04) / 0.9996 strict; pieces-4 0.03; pieces-9 0.10; csg-chain 0.02 | no: best images, but far too slow |
| 15 | refinement tuned: fc 0.45, fn 0.5, exact window [start - 1, start + 1.5] voxels for listed pixels | bench bricks-17: composite 115, pieces-9 106, custom-section 128, pieces-4 112, grazing 684, csg-chain 74 | same | flagged (probe): composite 690 (2.1 %), pieces-9 731 (5.9 %), custom-section 2197 (6.3 %) | composite 0.10 % / 0.9999; pieces-9 0.22 / 0.9996; custom-section 0.45 / 0.9991; pieces-4 0.16 / 0.9997; csg-chain 0.11 / 0.9998; grazing 2.17 % (aa 0.16) / 0.9988 | kept: strict on all six (grazing aa-tolerant); the exact pass costs ~80 µs per listed composite pixel |
| 15b | probes (contended): fc 0.6: composite 386 px, custom-section 1451 px but custom-section 0.61 % / 0.9987 (fails); only near-misses (fh=0) or only crease hits (fm=0) each fail custom-section | | | | | fc 0.45 is about the edge |
