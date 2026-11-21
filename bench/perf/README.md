# bench/perf: the SDF view performance harness

The frozen evaluator of the SDF performance hill climb. The method is in
[docs/AUTORESEARCH.md](../../docs/AUTORESEARCH.md).

## Run

```sh
npm run build:single                                  # builds dist-single/
cp -r dist-single bench/perf/ref/dist-<name>          # keep the build being measured
bench/perf/bench.sh <label> --dist bench/perf/ref/dist-<name> [--scenes composite,sweeps-64] [--frames 8]
python3 bench/perf/compare.py bench/perf/results/<ref run> bench/perf/results/<candidate run>
```

- `bench.sh` takes a global lock, so timed runs never overlap. It also takes the CPU lock
  exclusively: run every heavy job through `bench/perf/heavy.sh <cmd>` (e.g.
  `bench/perf/heavy.sh npm run build:single`), and it pauses while a benchmark runs.
- A scene timed under foreign CPU load (another process using > 0.25 core) marks the
  run `contaminated`. Rerun it.
- `workObjEvals` / `workMaps` are the machine-independent work of one settled frame.
- Each run writes `results/<stamp>-<label>/result.json` and one PNG still per scene:
  - settled and moving frame ms per scene;
  - p95 and max;
  - bake ms (`prepareMs`);
  - map() calls per pixel and objects per call;
  - the headline (composite) fps and the geomean.
- `compare.py` prints, per scene: the share of clay pixels differing by more than
  24/255, PSNR, missed and extra pixels, and silhouette IoU. It writes `compare.json`
  into the candidate's directory.

## Scenes

`scenes/gen.ts` generates every scene and `index.json`. Never hand-edit the JSON:

```sh
npx esbuild bench/perf/scenes/gen.ts --bundle --platform=node --format=esm --outfile=.tmp/gen.mjs && node .tmp/gen.mjs bench/perf/scenes
```

## Record and dashboard

```sh
python3 bench/perf/state/log.py run <results-dir suffix> "<label>" kept|rejected|info "<note>"
python3 bench/perf/state/log.py journal kept|rejected|info "<title>" "<hypothesis>" "<change>" "<result>" [commit]
python3 bench/perf/state/log.py hyp <id> <status> "<evidence>"
python3 bench/perf/state/log.py status "<text>"
python3 bench/perf/dashboard/build.py   # writes dashboard/data.json and stills/
```

The dashboard (`dashboard/index.html` with `data.json` and `stills/`) is published as
an artifact after every attempt.
