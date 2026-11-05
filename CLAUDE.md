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

## Glaze prompts (src/app/refsheet.ts GLAZES; the Glaze Library artifact mirrors them)
When writing or revising a glaze description from a reference image:
1. Spatial color distribution: the dominant colors of the upper, middle and lower vessel, kept in place.
2. Coverage: roughly how much of the vessel each color or glaze region takes.
3. Layering: which colors sit above, below or over one another.
4. Transitions: where, which direction, how sharp or irregular; drip, bleed, feather or pool.
5. Color hierarchy: dominant base glaze vs secondary colors vs concentrated accents; match
   saturation, brightness and translucency.
6. Visual fidelity: describe what is seen, not an inferred technique; generic pottery terms
   must not override the reference.
Output: keep the prompt's structure, style and approximate length; change only what is
inaccurate or vague; keep shape, lighting, photography and background wording unless the
reference contradicts it; one compact continuous glaze description; nothing the reference
doesn't show. Bump the library's version tag when prompts change.
