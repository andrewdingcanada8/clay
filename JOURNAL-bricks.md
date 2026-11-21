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
