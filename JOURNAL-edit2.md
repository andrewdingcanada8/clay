# Journal: editing frames, round 2 (branch claude/sdf-perf-edit2, from claude/sdf-perf-hillclimb 96d24f1)

Bench: `bench/perf/bench.sh edit2-<n> --dist bench/perf/ref/dist-edit2-<n> --scenes composite,sweeps-64,pieces-4,csg-chain,blend-heavy,custom-section`
(msEdit = the harness's real drag: middle object +0.05/frame, camera on the orbit). Quality: scratchpad editq.mjs renders
edit frames (steps 1, 8, 20) and the exact frame (drawSdf, plain shader) into the same low target (200x193) and diffs them
(gate: diff>24 <= 2 %, IoU >= 0.995).

Reference (refine-final2 / prune numbers): msEdit composite 400-427, sweeps-64 857-886, pieces-4 388, csg 257-269,
blend 287, custom-section 667.

## Findings
- SwiftShader: a full-screen pass of the exact shader costs ~120-200 ms at 200x193 even when every fragment discards at
  the top (`discard; return;` does not help). The old edit frame paid that for every pixel, clean or not. Exact work
  only pays off as a compact list (one fragment per wanted pixel), like the settled pass's refine.
- Per dirty pixel that hits, the exact march costs ~20-30 us (SwiftShader); misses are cheap.

## Attempts

| # | attempt | msEdit comp / sw64 / p4 / csg / blend / cs | edit-frame quality (worst of steps) | verdict |
|---|---|---|---|---|
| 1 | stale bricks + full-screen DIRTY_ONLY pass: the settled bricks pass (stale bricks stay valid until a bake starts; brickSnap) draws the frame, then the exact SDF_DIRTY shader over it, clean rays discard | probe: comp 250-357, sw64 610-850 | diff 0.34 %, IoU 0.9987 | partial: the full-screen pass costs ~200 ms even with 0 dirty pixels (pieces-4) |
| 2 | dirty pixels as a list: stale start pass read back (float), the dirty test on the CPU (same rule as the shader: ray meets a changed box before stale hit + 3h), list -> exact pass (SDF_DIRTY + DIRTY_ONLY, list entry = x, y, start, window end) -> scatter | probe: comp ~270, p4 62, blend 260, cs 576 | same | partial: per-pixel exact cost is what's left |
| 3 | + occlusion from the stale bake for listed pixels (DIRTY_AO, no 4 exact taps, no wider mask) | exact part -25 % | same (no extra diff>24 px) | yes |
| 4 | + half resolution first: pixels at even (x, y) exactly; the others take the mean of their 2/4 samples if all hit with colour spread <= 12 and depth spread <= 3 %, or all missed at >= 3 px from any surface (misses report how near they came; early outs check a 3x-grown mask); the rest exactly. Dirty list program compiled at rest (bricks done) | bench edit2-7: 224 / 196 / 41 / 79 / 111 / 302 (settled 55 / 78 / 59 / 59 / 44 / 124: images identical to full-refine) | comp 0.31 % / 0.9987 (same as the old path: 9 missed px at step 1 are the old path's too), sw64 0.09 % / 0.9999, cs 0.16 % / 0.9997, blend 0.02 % / 0.9999 | kept |
| 5 | coarse to fine, 3 levels (spacing 4, 2, 1), one exact pass per level, all results scattered at once; misses report nearness in shader pixel units, converted to this frame's pixels (a miss interpolates only if all samples stayed >= 1.5 sp px away: the earlier "3" was in uPixelAngle units, ~1 real px, unsafe); early outs (no object near the ray) report 24 units if a 24x-grown mask is empty too | probe: exact pixels -30 %, time ~same (passes cost ~8 ms fixed + ~33 us/px) | same | kept (smaller lists), but not the win hoped for |
| 6 | the warm-up compile was `renderer.compile`: ANGLE/SwiftShader still built the program at the first drag frame (~850 ms, inside the harness's 8-frame mean). Now a real draw of one empty list entry when the bricks complete | composite -100 ms in the harness mean | - | yes |
| 7 | dirty rect: the changed boxes' screen rect bounds the start pass (scissor), its readback and the CPU test (typed box arrays, no per-pixel allocation) | ~-10 ms | same | yes |
| 8 | probes: step cap 64 for listed rays (time same, IoU 0.9968 on custom-section: no); finest-level colour spread 24 (-5 %, noise) | - | - | no |
| 9 | bench edit2-9 (#5-7): msEdit 120 / 187 / 32 / 72 / 112 / 301 (settled 60 / 77 / 65 / 56 / 48 / 125, moving 46 / 46 / 48 / 32 / 52 / 51: noise vs full-refine 60 / 78 / 56 / 59 / 47 / 125; images identical) | composite 3.3x, sweeps-64 4.6x, pieces-4 12x, csg 3.6x, blend 2.6x, custom-section 2.2x | worst over steps 1/8/20, six scenes: diff 0.36 %, IoU 0.9989 (composite step 1: its 7 missed px are the old path's too) | kept |
