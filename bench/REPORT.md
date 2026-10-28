# Benchmark report

Quality: normal. Images: `bench/out/<case>-<kernel>.png`.

| case | kernel | build ms | triangles | boundary edges | non-manifold | max interior white % | warnings |
|---|---|---:|---:|---:|---:|---:|---|
| open-box | sdf | 4089 | 368200 | 0 | 0 | 44.8 |  |
| open-box | mesh | 27 | 42 | 0 | 0 | 44.8 |  |
| sphere-cube | sdf | 2721 | 210824 | 0 | 0 | 72.9 |  |
| sphere-cube | mesh | 103 | 18434 | 0 | 0 | 72.9 |  |
| chain-30 | sdf | 6422 | 165124 | 0 | 65 | 10.9 |  |
| chain-30 | mesh | 2749 | 576744 | 0 | 0 | 10.8 |  |
| vase | sdf | 5433 | 189904 | 0 | 0 | 18.1 |  |
| vase | mesh | 123 | 21612 | 0 | 0 | 17.3 |  |
| bowl | sdf | 3630 | 153100 | 0 | 0 | 100.0 |  |
| bowl | mesh | 94 | 11088 | 0 | 0 | 100.0 |  |
| cylinder-pins | sdf | 3339 | 295456 | 0 | 0 | 25.0 |  |
| cylinder-pins | mesh | 70 | 1972 | 0 | 0 | 24.9 |  |
| cup-stick | sdf | 4406 | 169064 | 0 | 0 | 22.2 |  |
| cup-stick | mesh | 99 | 12636 | 0 | 0 | 21.9 |  |
| vase-sticks | sdf | 7199 | 206740 | 0 | 10 | 1.7 |  |
| vase-sticks | mesh | 383 | 25290 | 0 | 0 | 1.7 |  |
| vase-solid-sticks | sdf | 5917 | 198444 | 0 | 0 | 1.7 |  |
| vase-solid-sticks | mesh | 169 | 22932 | 0 | 0 | 1.7 |  |
| torus | sdf | 1152 | 208552 | 0 | 0 | 0.0 |  |
| torus | mesh | 149 | 41624 | 0 | 0 | 0.0 |  |
| lattice | sdf | 6285 | 254440 | 0 | 1 | 0.9 |  |
| lattice | mesh | 17 | 376 | 0 | 0 | 0.7 |  |
| vase-thin | sdf | 29259 | 1173532 | 0 | 1 | 24.1 | Mesh wall for Group 1 drawn at 0.21 cm, not 0.20 cm (grid too coarse at this size). |
| vase-thin | mesh | 156 | 22064 | 0 | 0 | 24.0 |  |
| chain-thin | sdf | 11853 | 609968 | 0 | 207 | 0.0 |  |
| chain-thin | mesh | — | — | — | — | — | ERROR: Error: Error creating WebGL context. |
| transformed | sdf | 2612 | 194812 | 0 | 48 | 68.7 |  |
| transformed | mesh | — | — | — | — | — | ERROR: Error: Error creating WebGL context. |
| rotated-box | sdf | 2132 | 217984 | 0 | 79 | 50.6 |  |
| rotated-box | mesh | — | — | — | — | — | ERROR: Error: Error creating WebGL context. |
| tower | sdf | 4998 | 142280 | 0 | 0 | 53.7 |  |
| tower | mesh | 35 | 408 | 0 | 0 | 53.3 |  |
| thick-wall | sdf | 1550 | 94984 | 0 | 0 | 0.9 |  |
| thick-wall | mesh | — | — | — | — | — | ERROR: Error: Error creating WebGL context. |
| cut-sphere | sdf | 3508 | 269300 | 0 | 5 | 5.1 |  |
| cut-sphere | mesh | 186 | 16936 | 0 | 0 | 5.0 |  |
| mug-stick | sdf | 4147 | 165512 | 0 | 128 | 17.1 |  |
| mug-stick | mesh | — | — | — | — | — | ERROR: Error: Error creating WebGL context. |
| mug-thin | sdf | 21422 | 925152 | 85 | 110 | 20.2 | Mesh wall for Group 1 drawn at 0.25 cm, not 0.08 cm (grid too coarse at this size).; 44 quads skipped at block borders |
| mug-thin | mesh | — | — | — | — | — | ERROR: Error: Error creating WebGL context. |
| two-groups | sdf | 4291 | 224816 | 0 | 0 | 33.4 |  |
| two-groups | mesh | — | — | — | — | — | ERROR: Error: Error creating WebGL context. |
| frustums | sdf | 4800 | 213536 | 0 | 0 | 53.6 |  |
| frustums | mesh | 30 | 76 | 0 | 0 | 58.5 |  |
| big-pins | sdf | 2656 | 271044 | 0 | 0 | 22.7 |  |
| sdf-narrow-join | sdf | 1160 | 174300 | 0 | 0 | 1.9 |  |
| sdf-pebble | sdf | 614 | 150660 | 0 | 0 | 0.0 |  |
| sdf-blend | sdf | 2987 | 158708 | 0 | 4 | 1.8 |  |
| teapot | sdf | 6004 | 345160 | 0 | 18 | 25.7 |  |
| teapot | mesh | 236 | 36750 | 0 | 0 | 25.6 |  |
| sweep-mug | sdf | 7254 | 209296 | 0 | 1 | 26.0 |  |
| sweep-mug | mesh | 153 | 22590 | 0 | 0 | 25.7 |  |
| coil | sdf | 47144 | 509948 | 42 | 3 | 0.0 | 12 quads skipped at block borders |
| coil | mesh | 306 | 74296 | 0 | 0 | 0.0 |  |
| sweep-frame | sdf | 7797 | 149220 | 0 | 0 | 0.0 |  |
| sweep-frame | mesh | 114 | 16642 | 0 | 0 | 0.0 |  |
