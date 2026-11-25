# Resume note (read this first after a stop; don't re-read source files)

## Pinned (user, 2026-11-22): revisit later, don't build on as-is
- Variable resolution: the user isn't sure the current approach is the best one —
  moving levels (adaptMoving, MOVING_LEVELS, exact frames at reduced ratio before a bake),
  full-resolution orbit from the bake, coarse-to-fine drag frames. Re-examine the design
  before extending it.
- Quality levels: Draft is fine on the phone; Normal/Fine still crash the 4-jug scene
  (in the SDF view quality only changes the cavity/round grids: cavity.ts BUDGET,
  round.ts BUDGET). Investigate with a recording at Fine.

Updated: 2026-11-22 (device fix 3 published)

## Incumbent (claude/sdf-perf-hillclimb, pushed)
- Still frame composite 934 ms headless (6.1x, strict images on 13/14 scenes; grazing passes with 1-px aliasing tolerance).
- Orbit ~46 ms; editing ~720 ms; bake 4.3 s headless. iPhone (older 8.7x build): still 18 ms, orbit 1-2 ms, bake 109 ms.
- Builds: bench/perf/ref/dist-near-kept is the incumbent build. Reference run: results/2026-11-20T20-31-52-668Z-full-baseline.

## In flight
- Bricks agent (id aacf436b21239f4a1, worktree .claude/worktrees/agent-aacf436b21239f4a1): bake size/time + strict gates on hard scenes. Last: composite settled 100 ms (57x), bake 27 s headless.
- Pruning agent (id ae40e736ec7aa49f4, worktree .claude/worktrees/agent-ae40e736ec7aa49f4): editing regime (cheap per-drag object lists).
- Both stopped at usage limit 18:40 UTC; resumed 21:10 UTC.

## Device
- 4-jug crash cause (v5 log): exact orbit frames before the bake finished piled up on the GPU. Fixed (fence-paced exact moving frames, bake paused while moving). Clay Preview v6 = bench/perf/ref/dist-device3. Awaiting user rerun.

## Agent progress (00:25 UTC)
- Bricks: cone pre-pass gives composite 51 ms but misses 2/3 of clay (cone step cap); being fixed.
- Editing: stale-bake reuse mid-drag, drag frames 2.5-3.9x faster, settled bit-identical (attempt e3). Not merged yet.

## 02:35 UTC
- Agents stopped at limit ~01:00, reset 02:00; resumed 02:35.

## 03:00 UTC: bricks-11 (agent, branch claude/sdf-perf-bricks, not pushed)
- Settled composite 58 ms (~98x); strict on 10/14; fails: pieces-4 (IoU 0.9989), pieces-9, custom-section, grazing. Bake 4-10x longer (composite 19 s headless).
- Agent now: exact refinement pass for flagged pixels (separate draw), then bake size/pacing.
- Pivot proposed to user (cache-then-draw main line; mesh from cache as next step); awaiting answer. Also offered a baseline build with the benchmark button for an iPhone baseline.

## 03:10 UTC: merging editing lineage (84bbba3)
- Conflicts resolved in bake.ts (near approach folded into the START variant) and viewport.ts; build bench/perf/ref/dist-merge-edit; bench job merge-edit running (composite, custom-section, grazing, pieces-9, sweeps-64, csg-chain). If gates hold vs near0.5: commit merge, push, publish Clay Preview.
- Note: harness benchEdit is a no-op edit (best case); agent's real-drag numbers: composite tab 756->411 ms, sweeps-64 rib 1826->683.

## 03:40 UTC: editing lineage merged (d818aa7), gates identical, drag ~2x. Clay Preview republished from bench/perf/ref/dist-merge-edit.

## 08:00 UTC
- benchEdit now moves an object (committed). Real-drag msEdit: composite 414, sweeps-64 842, pieces-4 372, csg 257, blend 281.
- Bricks agent stopped at limit (reset 07:30), resumed 08:00 with the refinement-pass task.

## 08:30 UTC: bricks lineage merged (ebba7b3 into hill-climb), pushed
- Agent's full suite: composite 100 ms settled (57x), strict 13/14, grazing loose only (IoU 0.9983, aa 0.10%); bake ~2x main (composite 8.8 s).
- Running: bench job full-bricks on bench/perf/ref/dist-bricks-merged (all 14 scenes, three regimes). Then: compare, log as kept, publish Clay Preview + dashboard, ask user for iPhone rerun.
- Bricks agent finished (no further task assigned).

## 09:00 UTC: bricks merged and confirmed (full-bricks): composite 98 ms (57.9x), strict 13/14, grazing loose. Clay Preview v8 = bench/perf/ref/dist-bricks-merged. No agents running.

## 09:00 UTC
- Refine agent (id ab95c4ce12f2cf101, worktree branch claude/sdf-perf-refine): composite <=57 ms at strict gates, then grazing strict IoU. Journal: JOURNAL-refine.md in its worktree.

## 10:50 UTC: refine agent stopped at usage limit (reset 12:50 UTC); wake-up scheduled 12:55 to resume it. No new iPhone run yet.

## 16:00 UTC: refine lineage merged (d7b2b7b), pushed. Agent: composite 52 ms (109x), IoU>=0.999 on six scenes, grazing diff 2.35% (aa 0.36%).
- Running: bench job full-refine on bench/perf/ref/dist-refine-merged (confirmation, all 14). Then log kept, publish Clay Preview + dashboard.

## 16:45 UTC: refine confirmed: composite 57 ms (99.5x, 52-60 across runs); IoU strict all 14; grazing diff 2.35%. Clay Preview v9 = bench/perf/ref/dist-refine-merged. Still-frame target reached -> next regime: editing.

- Editing agent launched (branch claude/sdf-perf-edit2, journal JOURNAL-edit2.md in its worktree): msEdit 3-5x target.

## 18:50 UTC: editing lineage 2 merged (c9657fa), tests 468 pass, pushed. Agent msEdit: composite 400->120, sweeps-64 857->187, pieces-4 388->32, csg 257->72, blend 287->112, custom 667->301.
- Running: bench job full-edit2 on bench/perf/ref/dist-edit2-merged. Then log, publish Clay Preview + dashboard.

## 19:40 UTC: full-edit2 confirmed: still 55 ms (103x), drag 117 ms (6.2x), images identical. Clay Preview v10 = bench/perf/ref/dist-edit2-merged. Next: bake time (time to sharp after edit).

- Bake agent launched (branch claude/sdf-perf-bake, journal JOURNAL-bake.md in its worktree): prepareMs 3-5x, incremental re-bake.

## 20:45 UTC: bake lineage merged (7f0c035), tests 546 pass, pushed. Agent: full bake -19..27%; incremental re-bake after a local edit 5-9x (composite 6.1 -> 1.1 s).
- Running: bench job full-bake on bench/perf/ref/dist-bake-merged. Then log, publish Clay Preview + dashboard.

## 21:40 UTC: bake lineage REVERTED (f29651a): full suite broke grazing (67% diff) and sweeps-16/32/64 (consecutive scenes reuse the previous field). Agent asked to fix and verify on the full suite. Clay Preview stays on dist-edit2-merged (v10).

## 22:30 UTC: bake fix merged (revert of revert + 0fc7356/e29fe2c; merge 12723e0), tests 546 pass, pushed. Cause: feedback loop in the half-res coarse pass. Running: full-bake-fixed (my confirmation). If it passes: log kept, publish Clay Preview from bench/perf/ref/dist-bake-fixed.

## 23:40 UTC: PAUSED climb on user's report. Fixed bake pacing (638a026), orbit glide freeze, added diagnostics screen + GPU alloc log (ca4d79b). Clay Preview v11 = bench/perf/ref/dist-diag. Waiting for user's phone diagnostics. Open: 4-jug crash; time-to-sharp (paced, live loop) as headline series.

## 22:20 UTC (user phone runs): composite on iPhone: time to sharp 1.0-1.5 s, still 4 ms, orbit 2 ms. Losses: diag load (batch doubling on late polls) and 4 jugs after grids (field change counted as drift -> whole exact frame). Fixed 22ddfbc, Clay Preview v12. Open: GPU memory (up to ~240 MB of brick atlases on Untitled 16).

## 23:00 UTC: diagnostics status UI, session recording + marks (recordings/<id>/chunks), bench/perf/replay.mjs, orbit damping 0.15 (ecead3b). Clay Preview v13 = bench/perf/ref/dist-rec. To replay a user recording: ArtifactData read recordings/<id> + recordings/<id>/chunks -> JSON {meta, events} -> node bench/perf/replay.mjs file --dist bench/perf/ref/dist-rec.

## 23:20 UTC: vanished-piece fix (80d4eff): canvas resizes no longer count as camera glide; glide capped 1.5 s; low image held through resizes while baking. Clay Preview v14 = bench/perf/ref/dist-fix3. Check: scratchpad perf/resizecheck.mjs.

## 23:45 UTC: mesh->SDF switch fix (no re-bake for identical doc/grids; pending bake keeps the shown image). Clay Preview v15 = bench/perf/ref/dist-fix4.

## 2026-11-24: 4-jug grain fix from the user's recording rmwv5vdu8 (11 marks, all 'sharp'): surface hits outside bricks / bricks > 4 px go exact; >25% flagged -> banded exact. Clay Preview v16 = bench/perf/ref/dist-fix6. Replay helper: scratchpad perf/jugsharp.mjs. Open: why only ~7k bricks on 4 jugs (brick band misses thin features in wide scenes) - per-piece bake boxes would fix at the root.

## 2026-11-25: 16-texture limit fix (1f0b340) confirmed on phone (no shader error). Crash after: grids at rest -> whole exact frame (drift from -0/0 sign flip in view keys). Fixed (this commit). Clay Preview v18 = bench/perf/ref/dist-fix8. Repro script: scratchpad perf/restexact.mjs.

## 2026-11-25 later: crash after orbit while refining. Finding: bricks cover only ~2/3 of the 4 jugs' surface (7152 bricks for a 169 cm scene; 36% of pixels flagged, mostly hits outside bricks), so every still uses the banded exact pass (the original crash path). Mitigation 16 ms bands, 2x growth, band log (Clay Preview v19 = bench/perf/ref/dist-fix9). ROOT FIX NEXT: per-piece bake boxes (each piece its own coarse grid + bricks, ~4x finer on the 4 jugs). The cpx (brick spacing > N px) rule is not the driver (cpx=0 gives the same flags).

1. When bricks reports: merge its branch into claude/sdf-perf-hillclimb, full suite (bench/perf/bench.sh full-<name> --dist bench/perf/ref/dist-<name>), compare.py vs full-baseline, log, publish Clay Preview + dashboard, ask user for iPhone rerun.
2. When pruning reports: measure msEdit; integrate if it wins.
3. Heartbeat: send_later 60 min, re-armed every step.
