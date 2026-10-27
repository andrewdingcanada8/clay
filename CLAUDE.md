# Clay — working notes

## Interaction rule: heavy work only on release
Continuous interactions (dragging spline points, gizmo moves, slider drags, pinch, etc.)
must never trigger expensive computation per move. While the pointer is down, update only
cheap previews (the wireframe ghost, GPU uniforms). Do worker builds (cavity grids, mesh
booleans), profile texture rebuilds, history commits and anything else slow once, on release.
In code: `update(mut, interactive=true)` / `sync(true)` must stay cheap; the release path
calls `update(mut)` with `interactive=false`.

## Workflow
- Iterate via the published Artifact first (`npm run build:single` + `scripts/make-artifact.py`);
  commit/push in the background.
- Keep the app's own abstractions; don't port MVP-specific features (presets, rim/foot styles,
  point names, its styling) unless asked.
