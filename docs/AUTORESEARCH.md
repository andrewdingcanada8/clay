# Autoresearch: how the SDF performance hill climb is run

This page describes the method behind the SDF view performance work on branch
`claude/sdf-perf-hillclimb`. The goal is a 100× faster settled SDF frame than the
baseline, on a phone, without visibly changing the image. The harness is described in
[bench/perf/README.md](../bench/perf/README.md).

The method follows the "agentic hill climbing" pattern: an agent proposes one change at
a time against a frozen evaluator, keeps it only if it measurably wins, and records
everything, including failures. It borrows from autoresearch-style loops, FrameForge and
AlphaEvolve: a ratchet, a fixed scorer, and populations of lineages when one stalls.

## The loop

```
measure → hypothesise → experiment → keep / reset → reflect ─┐
   ▲                                                         │
   └──────── research (online + code + profiles) ◄───────────┘
```

1. **Measure:** attribute the current cost (cost view: map() calls per pixel, objects
   per call; stage-disabling variants) to find what dominates now.
2. **Hypothesise:** one change, with an expected gain, written on the hypothesis board
   (`bench/perf/state/hypotheses.json`).
3. **Experiment:** build the variant (one diff) and run the frozen evaluator.
4. **Keep or reset, mechanically:** keep only if it beats the incumbent by more than the
   noise band, a confirmation run agrees, and every image gate passes. Kept changes are
   committed with their score in the message; anything else is reset.
5. **Reflect:** a failure is a finding. Ask what was missing, and research it: papers,
   forum threads, other modellers' source, or new profiling. New hypotheses go on the board.
   When the climb stalls, a broader research round comes before more local tweaks.

## The metric

- **Headline:** settled frame time (and fps) of the *composite* scene, a deliberately
  dense scene with a bit of everything: hollow revolve, radial sweeps, custom sections,
  blends, nested shells, cuts, masks, nested symmetry, and a second piece.
- **Second series:** the moving (orbit) frame, and the bake time after an edit
  (`prepareMs`, "time to sharp").
- **Diagnostics:** stress scenes, one bottleneck each (sweeps-8…64, pieces-1/4/9,
  blend-heavy, shell-heavy, csg-chain, custom-section, grazing, close-up), and the geomean
  over all scenes.
- **Scaling:** time against N for sweeps-N and pieces-N, fitted to T = a·N^b. Lowering
  *a* is a constant-factor win; lowering *b* is a complexity win. N_max is the largest N
  inside the frame budget.
- The two drivers of sphere tracing, map() calls per pixel and objects per call, are
  reported separately so a blended number can't hide which one moved.

## Three regimes, never mixed

| Regime | When | Series |
|---|---|---|
| Orbit | camera moving, geometry unchanged | `msMove` |
| Still | view at rest, refining to sharp (the headline) | `msMean` |
| Editing | a drag, scale or slider: the field changes every frame | `msEdit` |

- **Time to sharp after an edit** is the bake plus one settled frame (`sharpAfterEditMs`).
- Each optimisation is judged in the regime it targets and also checked in the other two.
  Examples:
  - a baked field speeds up orbit and still, but does nothing mid-drag and adds bake
    time after every release;
  - a cheaper exact field helps all three.
- Heavy work happens only on release, so editing frames can only get cheaper through a
  cheaper exact field or fewer pixels.

## The gates (anti-cheat)

A timing only counts if the stills pass, against the baseline renderer's stills:

| Gate | Strict (settled frames) | Loose (fallback) |
|---|---|---|
| Pixels differing by > 24/255 | ≤ 0.5% of clay pixels | ≤ 2% |
| Silhouette IoU | ≥ 0.999 | ≥ 0.995 |
| Missed pixels (holes) | ≈ the reference | ≈ the reference |

**Aliasing tolerance (reported beside the strict number, never instead):**
- `diff24aa` counts a pixel as matching if any reference pixel within 1 px of it
  matches.
- Detail thinner than a pixel (a rim seen edge-on) aliases in the reference itself,
  so exact pixel positions there are arbitrary.
- A scene that fails `diff24` but passes `diff24aa` is labelled "passes with a 1-px
  aliasing tolerance" in the journal, with the evidence: the diff map, and the
  tolerant number next to the strict one.

Resolution, step cap and hit epsilon are frozen: a win that exists only at a lower cap
is a quality cut, not an optimisation.

**Progressive quality** (Blender-style): moving frames may use a lower-fidelity field
(the baked texture), while the settled frame refines to the strict floor. The loose floor
is used only if strict can't get near the target, and that is recorded.

## Noise

Before climbing, the incumbent was run 5 times: composite 5552–5777 ms, σ ≈ 1.5%. A
candidate must beat the incumbent by more than 3% and hold on a confirmation run.
### Isolation from parallel work

The VM has 4 cores and SwiftShader uses about 2.3 of them, so reserving cores would
starve the benchmark itself. Three layers keep timings honest while agents work:

1. **A CPU mutex.**
   - `bench/perf/bench.sh` queues benchmarks behind each other and takes
     `/tmp/clay-cpu.lock` exclusively.
   - Every heavy job (builds, typecheck, tests, other headless renders) runs through
     `bench/perf/heavy.sh`, which takes the same lock shared.
   - A waiting benchmark raises `/tmp/clay-bench.pending`, so new heavy jobs hold back
     and benchmarks never starve.
2. **Contamination check.**
   - While each scene is timed, `run.mjs` measures machine-wide busy CPU minus its own
     process tree (`foreignCores`).
   - Above 0.25 of a core, the run is marked `contaminated` and is rerun before it
     counts.
3. **Work counts.**
   - Next to the ms, every scene reports machine-independent work per settled frame:
     `workObjEvals` (object evaluations) and `workMaps` (field evaluations), from the
     cost view.
   - These can't be disturbed by load. Time stays the headline, because the cost of
     an evaluation depends on code shape, but work must agree with a claimed win from
     a fewer-evaluations change.

## Frozen evaluator

`bench/perf/` (the scenes, `run.mjs`, `compare.py`) does not change during the climb.
A change to it is its own announced commit that re-baselines every series. Scenes are
generated by a script (`scenes/gen.ts`), never hand-edited. The user's own pieces are
held out as validation, against overfitting the scenes.

## Proxy vs device

The climb runs headless (Chromium with SwiftShader, a CPU GL). It is reliable for
relative numbers but code-shape sensitive: fewer evaluations is not always faster there.
The real check is an iPhone run through the in-app "Run the benchmark scene" button,
done at the end and never as a gate during the climb.

## Parallelism: lineages and agents

- **Lineages:** architectural directions evolve in separate worktrees and exchange
  winners, e.g. the bake lineage (baked start depths), the exact-field lineage (cheaper
  map()), pruning, and sparse fine bricks.
- **Agents:** research agents (online and code reading) and prototype agents run in
  parallel. All score against the same frozen harness, queued through the lock.
- **Never blocked:** while a benchmark runs, the next hypothesis, the docs or the
  dashboard move forward.

## Record and observability

- `bench/perf/state/journal.json`: every attempt (hypothesis, change, result, verdict, commit).
- `bench/perf/state/runs.json`: the runs that count, in order (the first is the baseline).
- `bench/perf/state/hypotheses.json` and `research.json`: the board and the sources.
- `bench/perf/state/status.json`: the "Now" panel (current experiment, queue, agents).
- `bench/perf/dashboard/`: the "SDF Hill Climb" dashboard, rebuilt by `build.py` and
  republished after each attempt. Tabs: Overview, Graph, Scaling, Scenes, Journal,
  Hypotheses, Research, Method.
- `JOURNAL-*.md`: lineage journals written by prototype agents.
