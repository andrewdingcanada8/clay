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
