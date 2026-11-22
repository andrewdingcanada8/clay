# Resume note (read this first after a stop; don't re-read source files)

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

## Next
1. When bricks reports: merge its branch into claude/sdf-perf-hillclimb, full suite (bench/perf/bench.sh full-<name> --dist bench/perf/ref/dist-<name>), compare.py vs full-baseline, log, publish Clay Preview + dashboard, ask user for iPhone rerun.
2. When pruning reports: measure msEdit; integrate if it wins.
3. Heartbeat: send_later 60 min, re-armed every step.
