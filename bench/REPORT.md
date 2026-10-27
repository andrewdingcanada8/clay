# Benchmark report

Quality: normal. Images: `bench/out/<case>-<kernel>.png`.

| case | kernel | build ms | triangles | boundary edges | non-manifold | max interior white % | warnings |
|---|---|---:|---:|---:|---:|---:|---|
| open-box | sdf | 3409 | 368224 | 0 | 0 | 45.6 |  |
| open-box | mesh | 27 | 42 | 0 | 0 | 44.8 |  |
| sphere-cube | sdf | 1849 | 210848 | 0 | 0 | 79.3 |  |
| sphere-cube | mesh | 103 | 18434 | 0 | 0 | 72.9 |  |
| chain-30 | sdf | 6476 | 165124 | 0 | 65 | 10.9 |  |
| chain-30 | mesh | 2749 | 576744 | 0 | 0 | 10.8 |  |
| vase | sdf | 4992 | 189904 | 0 | 0 | 17.7 |  |
| vase | mesh | 123 | 21612 | 0 | 0 | 17.3 |  |
| bowl | sdf | 3417 | 153100 | 0 | 0 | 92.8 |  |
| bowl | mesh | 94 | 11088 | 0 | 0 | 100.0 |  |
| cylinder-pins | sdf | 3047 | 295440 | 0 | 0 | 25.5 |  |
| cylinder-pins | mesh | 70 | 1972 | 0 | 0 | 24.9 |  |
| cup-stick | sdf | 4188 | 169088 | 0 | 0 | 23.1 |  |
| cup-stick | mesh | 99 | 12636 | 0 | 0 | 21.9 |  |
| vase-sticks | sdf | 6397 | 206788 | 0 | 11 | 1.7 |  |
| vase-sticks | mesh | 383 | 25290 | 0 | 0 | 1.7 |  |
| vase-solid-sticks | sdf | 5302 | 198444 | 0 | 0 | 1.7 |  |
| vase-solid-sticks | mesh | 169 | 22932 | 0 | 0 | 1.7 |  |
| torus | sdf | 1233 | 208552 | 0 | 0 | 0.0 |  |
| torus | mesh | 149 | 41624 | 0 | 0 | 0.0 |  |
| lattice | sdf | 5616 | 254460 | 0 | 1 | 0.8 |  |
| lattice | mesh | 17 | 376 | 0 | 0 | 0.7 |  |
| vase-thin | sdf | 26456 | 1173448 | 0 | 0 | 24.1 | Mesh wall for Group 1 drawn at 0.21 cm, not 0.20 cm (grid too coarse at this size). |
| vase-thin | mesh | 156 | 22064 | 0 | 0 | 24.0 |  |
| chain-thin | sdf | 11894 | 611428 | 12 | 134 | 0.0 |  |
| chain-thin | mesh | — | — | — | — | — | ERROR: Error: Error creating WebGL context. |
| transformed | sdf | 1909 | 194212 | 0 | 43 | 69.8 |  |
| transformed | mesh | — | — | — | — | — | ERROR: Error: Error creating WebGL context. |
| rotated-box | sdf | 1847 | 217420 | 0 | 73 | 51.6 |  |
| rotated-box | mesh | — | — | — | — | — | ERROR: Error: Error creating WebGL context. |
| tower | sdf | 4026 | 142296 | 0 | 0 | 58.0 |  |
| tower | mesh | 35 | 408 | 0 | 0 | 53.3 |  |
| thick-wall | sdf | 960 | 94984 | 0 | 0 | 0.8 |  |
| thick-wall | mesh | — | — | — | — | — | ERROR: Error: Error creating WebGL context. |
| cut-sphere | sdf | 2069 | 236992 | 0 | 5 | 18.3 |  |
| cut-sphere | mesh | — | — | — | — | — | ERROR: Error: Error creating WebGL context. |
| mug-stick | sdf | 3929 | 164796 | 0 | 4 | 15.7 |  |
| mug-stick | mesh | — | — | — | — | — | ERROR: Error: Error creating WebGL context. |
| mug-thin | sdf | 20017 | 923602 | 254 | 10 | 19.5 | Mesh wall for Group 1 drawn at 0.25 cm, not 0.08 cm (grid too coarse at this size).; 121 quads skipped at block borders |
| mug-thin | mesh | — | — | — | — | — | ERROR: Error: Error creating WebGL context. |
| two-groups | sdf | 3979 | 224836 | 0 | 0 | 34.4 |  |
| two-groups | mesh | — | — | — | — | — | ERROR: Error: Error creating WebGL context. |
| frustums | sdf | 4928 | 213280 | 0 | 0 | 59.6 |  |
| frustums | mesh | 30 | 76 | 0 | 0 | 58.5 |  |
| big-pins | sdf | 2571 | 271036 | 0 | 0 | 23.1 |  |
| sdf-narrow-join | sdf | 1368 | 174300 | 0 | 0 | 1.9 |  |
| sdf-pebble | sdf | 795 | 150660 | 0 | 0 | 0.0 |  |
| sdf-blend | sdf | 2440 | 159660 | 0 | 0 | 1.2 |  |
| teapot | sdf | 7960 | 345184 | 0 | 18 | 25.7 |  |
