# Clay — outstanding checklist

Status key: ✅ done · 🟡 partial / known issues · ⬜ not started

Last updated: 2026-10-27. Benchmark numbers come from `bench/REPORT.md`, which `npm run bench` regenerates.

## Core: shelling joined geometry

| | Item | Notes |
|---|---|---|
| ✅ | Groups, each object has a role: Shell / Solid / Subtract | Per group: (shell ∪ solid) − (cavity ∪ subtract ∪ pins). The cavity grows inward from the Shell objects' outer surface. Groups never cut each other. Wall thickness is per group. |
| ✅ | SDF kernel drawn by GPU raymarching (no triangles) | Exact outer surfaces and joins at any zoom. The inner wall comes from a cavity-depth texture: a smooth distance field, so walls thinner than a texel stay clean. Fixed data-driven shader, so edits never recompile. |
| ✅ | Real-time edits | Moving, resizing and wall thickness are uniform/data updates. Only the cavity texture rebuilds (in a worker, ~0.3–1 s) after shell geometry changes, with an analytic approximation in the meantime. Resolution drops while the camera moves. |
| 🟡 | Cavity approximation while dragging | It's a union of per-object depths, so walls look thicker at joins for a moment until the exact texture arrives. |

### Earlier items

| | Item | Notes |
|---|---|---|
| ✅ | Shell any union inward to a chosen wall thickness | SDF kernel: exact wall distance on the true union, including across joins. |
| ✅ | Arbitrary number of joined shapes (30-sphere chain) | One connected hollow. SDF ~0.7 s, mesh ~3.4 s. |
| ✅ | Whole-face openings ("face disappears") | Removed face; walls run full height to that face's plane with a flat rim. |
| ✅ | Only the exposed part of a face opens | Sphere+cube benchmark: the cube face buried in the sphere stays closed. |
| ✅ | Cavity too small for the wall → stays solid | Thick-wall benchmark: the capsule arm stays solid. |
| ✅ | Openings on curved faces (SDF kernel) | e.g. a sphere's whole surface. The mesh kernel only supports planar faces (it warns). |
| ✅ | Pin holes on flat or curved surfaces | Tap to drill. The pin is stored in the object's own frame, so it moves with the object. |
| ⬜ | Openings smaller than a face, drawn freely | Next step after pins: closed curves drawn on a surface, then oval or slot cutters. |
| ✅ | Hand-scale defaults and examples (pieces ~19–30 cm), hand silhouette on the ground for scale | Toggle under View; status chip shows the piece's size in cm. |
| ✅ | Walls down to 0.2 cm | Cell size is forced to ≤ wall/2.5. Thin vase and thin chain benchmarks are leak-free. |
| 🟡 | Very thin walls on large pieces (SDF) | A 0.08 cm wall on a 20 cm mug needs ~17M cells. The kernel now draws the thinnest wall it can resolve (~0.25 cm) and says so instead of tearing. The Mesh kernel gives the exact wall. Real fix: adaptive (octree) grid near the surface. |
| 🟡 | Mesh quality at sharp inner creases (SDF) | A few non-manifold edges, max ~60 per model, at sphere necks and rotated-box inner edges. They're invisible in renders; the fix would be manifold dual contouring. |
| 🟡 | Rim edges of rotated boxes (SDF) | Small zig-zag along an off-axis opening rim, at the ~1 grid-cell level. Could improve with sharper feature handling. |

## Two kernels, compared

| | SDF (distance fields) | Mesh (Manifold booleans) |
|---|---|---|
| Union of many shapes | ✅ exact | ✅ exact |
| Wall thickness at joins | ✅ exact | 🟡 "Fast offset" is thicker at joins, and narrow joins can stay sealed (chain-thin, thick-wall). "Exact (Minkowski)" is correct but 40 s for sphere+cube and >10 min for 30 spheres. |
| Openings on curved faces | ✅ | ⬜ planar faces only |
| Non-uniform scale | ✅ | 🟡 approximate when X≠Z scale on round shapes |
| Surface quality | 🟡 grid-limited (0.05–0.1 cm cells); sharp edges kept by dual contouring | ✅ exact flat faces; curves faceted by segment count |
| Speed (normal quality) | 0.6–1.8 s | 0.01–0.3 s typical, 3.4 s for the 30-sphere chain |

**Takeaway so far:** SDF is the robust, correct shelling kernel. Mesh is far faster and crisper, but its fast offset isn't correct at junctions. A possible future hybrid (not built): mesh output for display, SDF for walls.

## Modelling

| | Item | Notes |
|---|---|---|
| ✅ | Primitives: sphere, box, cylinder, cone, torus, capsule, n-gon prism | |
| ✅ | Revolve: 2D spline profile, full 360° | Centripetal Catmull–Rom with sharp/smooth points; editor zooms and pans (pinch, scroll, −/Fit/+) with a grid that follows the zoom. |
| ⬜ | Partial revolve (< 360°) | |
| ⬜ | Sweep a profile along a path | |
| ⬜ | Extrude an arbitrary 2D outline | |
| ✅ | Smooth blends between joined shapes (per-group Blend cm) | SDF only (smooth min); the Mesh kernel shows a sharp union and warns. |
| ✅ | SDF inner wall exact away from joins | Cavity grid stores only the correction to the analytic per-object depth (D = A + C), so rims and openings on large pieces stay round; the grid matters only at joins/blends. |
| ✅ | Examples where SDF beats Mesh | Narrow join (Mesh leaves a sealed wall), stretched pebble (Mesh walls 0.7–1.6× the set thickness), smooth blend (Mesh can't). |
| ✅ | Transform as sliders (move / rotate / scale per axis) | Ranges widen to fit the value; heavy rebuilds happen on release. |
| ✅ | Object modes: Join (shelled) / Solid (added after shelling) / Cut (carved before) | |
| ✅ | Move / rotate / scale gizmo; numeric fields | Scale runs along the object's local axes; uniform lock. |
| ✅ | Parametric: edit any object's parameters or profile later | Whole doc rebuilds; no undo needed. |
| ✅ | Undo / redo | JSON snapshots; Ctrl/Cmd+Z. |
| ✅ | Autosave in browser storage | |
| ⬜ | Multi-select, grouping, mirror/array tools | |
| ⬜ | Import meshes (STL/OBJ) and shell them | Possible in the SDF kernel via mesh → distance field. |
| ⬜ | Export (STL/OBJ) | Not needed yet. |

## App / UX

| | Item | Notes |
|---|---|---|
| ✅ | Mobile-first layout, desktop side panel ≥ 900 px | |
| ✅ | Tap to select; tap to open faces or drill pins | |
| ✅ | Section cut (X/Y/Z) to inspect walls | |
| ✅ | Kernel switch, quality levels, build stats | |
| ✅ | Builds in a Web Worker, cancelled on new edits; draft quality while dragging | Falls back to the main thread if workers are blocked. |
| 🟡 | Highlighting the tapped face before toggling | The ghost shows the selected object; there's no per-face highlight yet. |
| ⬜ | Snap / align tools, rulers | |

## Performance

| | Item | Notes |
|---|---|---|
| 🟡 | SDF build 0.6–1.8 s at normal quality on desktop (expect ~3× on phones) | Next: skip duplicate per-edge gradient work in dual contouring (vertices ≈ 30%); typed-array object evaluation; WASM/SIMD; GPU field sampling. |
| ⬜ | Incremental rebuilds (only blocks near the edited object) | |

## Benchmarks

| | Item | Notes |
|---|---|---|
| ✅ | 20 scenes (`src/examples.ts`), also in the app's Examples menu | open box, sphere+cube, 30-sphere chain, vase, bowl, cylinder pins, cup+stick, vase+sticks (joined / solid), torus, lattice, thin vase 0.2, thin chain 0.2, rotated+stretched, rotated box, tower, thick wall, cut sphere, mug + solid handle + stick at 0.25 and 0.08 cm |
| ✅ | Visual contact sheets per case × kernel (`bench/out/*.png`) | Exterior views, 3 sections, zoomed wall details, 360° interior camera (black on white: white = opening or leak). |
| ✅ | Programmatic: build time, triangles, open edges (must be 0), non-manifold edges, interior white % | |
| ⬜ | Expected-opening masks so the interior white % is checked automatically | |
