# Clay

A web 3D modeler for clay forms: pottery and architectural pieces. Its core feature is **shelling joined geometry**: join any number of forms, pick faces to remove (or drill pin holes), and hollow everything else inward to any wall thickness.

- `npm install`, then `npm run dev` to work on the app (mobile-first; open on a phone on the same network with `--host`).
- `npm test` runs the unit tests (vitest).
- `npm run bench` renders the visual benchmark sheets into `bench/out/` and writes `bench/REPORT.md`.
  - Options: `--kernel sdf,mesh,mesh-mk`, `--case id1,id2`, `--quality draft|normal|fine`, `--timeout s`, `--no-build`.
- `npm run build:single` builds one self-contained HTML file in `dist-single/`.

The status of everything planned is in [CHECKLIST.md](CHECKLIST.md).

## How shelling works

Both kernels read the same parametric document (`src/engine/document.ts`). Each object has a mode:
- **Join**: part of the form; it gets shelled.
- **Solid**: added after shelling, e.g. a solid stick.
- **Cut**: carved out before shelling.

**SDF kernel** (`src/engine/sdfKernel.ts`), the default:
1. The joined form is a signed distance field (union = min, cut = max with the negation).
2. The field is sampled on a sparse grid. 8³ blocks that provably can't contain surface are skipped.
3. Zero crossings of the field become surface seeds. Seeds lying on faces marked as openings are dropped. Closest-seed propagation gives each grid point its exact distance `d` to the remaining surface.
4. Wall = inside the form and within `t` of a non-opening surface: `S = max(F, d − t)`. A region too narrow for a cavity stays solid by construction.
5. Dual contouring with a QEF per cell turns `S` into triangles while keeping sharp edges.

The SDF kernel stores real distances, not inside/outside voxels. Cells are never larger than wall/2.5, and every build counts open edges (always 0 so far).

**Mesh kernel** (`src/engine/meshKernel.ts`) uses exact mesh booleans via manifold-3d:
- **Fast offset:** each primitive's inward offset is built exactly from its 2D profile. It isn't exact where forms join.
- **Exact (Minkowski):** erodes the whole union. Correct, but very slow.

## Layout

- `src/engine/`: kernels, primitives, profiles, document model. No DOM, so it runs in Node tests and the worker.
- `src/app/`: three.js viewport, UI, profile editor, worker scheduling.
- `src/examples.ts`: benchmark scenes.
- `src/bench/`, `bench/run.mjs`: benchmark renderer and driver (Playwright + Chromium).
