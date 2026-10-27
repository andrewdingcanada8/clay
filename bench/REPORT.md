# Benchmark report

Quality: normal. Images: `bench/out/<case>-<kernel>.png`.

| case | kernel | build ms | triangles | boundary edges | non-manifold | max interior white % | warnings |
|---|---|---:|---:|---:|---:|---:|---|
| open-box | sdf | 3551 | 368224 | 0 | 0 | 45.6 |  |
| open-box | mesh | 27 | 42 | 0 | 0 | 44.8 |  |
| sphere-cube | sdf | 1668 | 210848 | 0 | 0 | 79.3 |  |
| sphere-cube | mesh | 103 | 18434 | 0 | 0 | 72.9 |  |
| chain-30 | sdf | 6924 | 165124 | 0 | 65 | 10.9 |  |
| chain-30 | mesh | 2749 | 576744 | 0 | 0 | 10.8 |  |
| vase | sdf | 4224 | 189904 | 0 | 0 | 17.7 |  |
| vase | mesh | 123 | 21612 | 0 | 0 | 17.3 |  |
| bowl | sdf | 2932 | 153100 | 0 | 0 | 92.8 |  |
| bowl | mesh | 94 | 11088 | 0 | 0 | 100.0 |  |
| cylinder-pins | sdf | 2268 | 195568 | 0 | 0 | 0.2 |  |
| cylinder-pins | mesh | 70 | 1972 | 0 | 0 | 24.9 |  |
| cup-stick | sdf | 4039 | 169088 | 0 | 0 | 23.1 |  |
| cup-stick | mesh | 99 | 12636 | 0 | 0 | 21.9 |  |
| vase-sticks | sdf | 6413 | 206656 | 0 | 6 | 2.1 |  |
| vase-sticks | mesh | 383 | 25290 | 0 | 0 | 1.7 |  |
| vase-solid-sticks | sdf | 4721 | 198444 | 0 | 0 | 1.7 |  |
| vase-solid-sticks | mesh | 169 | 22932 | 0 | 0 | 1.7 |  |
| torus | sdf | 1167 | 208552 | 0 | 0 | 0.0 |  |
| torus | mesh | 149 | 41624 | 0 | 0 | 0.0 |  |
| lattice | sdf | 4973 | 254464 | 0 | 0 | 0.8 |  |
| lattice | mesh | 17 | 376 | 0 | 0 | 0.7 |  |
| vase-thin | sdf | 22686 | 1173448 | 0 | 0 | 24.1 | Mesh wall for Group 1 drawn at 0.21 cm, not 0.20 cm (grid too coarse at this size). |
| vase-thin | mesh | 156 | 22064 | 0 | 0 | 24.0 |  |
| chain-thin | sdf | 10521 | 611428 | 12 | 134 | 0.0 |  |
| chain-thin | mesh | — | — | — | — | — | ERROR: Error: Error creating WebGL context. |
| transformed | sdf | 1786 | 194212 | 0 | 43 | 69.8 |  |
| transformed | mesh | — | — | — | — | — | ERROR: Error: Error creating WebGL context. |
| rotated-box | sdf | 1749 | 217420 | 0 | 73 | 51.6 |  |
| rotated-box | mesh | — | — | — | — | — | ERROR: Error: Error creating WebGL context. |
| tower | sdf | 3386 | 126660 | 0 | 0 | 58.0 |  |
| tower | mesh | 35 | 408 | 0 | 0 | 53.3 |  |
| thick-wall | sdf | 762 | 94984 | 0 | 0 | 0.8 |  |
| thick-wall | mesh | — | — | — | — | — | ERROR: Error: Error creating WebGL context. |
| cut-sphere | sdf | 2033 | 236992 | 0 | 5 | 18.3 |  |
| cut-sphere | mesh | — | — | — | — | — | ERROR: Error: Error creating WebGL context. |
| mug-stick | sdf | 4001 | 164944 | 0 | 4 | 16.9 |  |
| mug-stick | mesh | — | — | — | — | — | ERROR: Error: Error creating WebGL context. |
| mug-thin | sdf | 16567 | 877360 | 674 | 31 | 18.0 | Mesh wall for Group 1 drawn at 0.24 cm, not 0.08 cm (grid too coarse at this size).; 266 quads skipped at block borders |
| mug-thin | mesh | — | — | — | — | — | ERROR: Error: Error creating WebGL context. |
| two-groups | sdf | 3497 | 224836 | 0 | 0 | 34.4 |  |
| two-groups | mesh | — | — | — | — | — | ERROR: Error: Error creating WebGL context. |
| frustums | sdf | 4356 | 213280 | 0 | 0 | 59.6 |  |
| frustums | mesh | 30 | 76 | 0 | 0 | 58.5 |  |
| big-pins | sdf | 1719 | 179276 | 0 | 0 | 2.5 |  |
| sdf-narrow-join | sdf | 1160 | 174300 | 0 | 0 | 1.9 |  |
| sdf-pebble | sdf | 751 | 150660 | 0 | 0 | 0.0 |  |
| sdf-blend | sdf | 2270 | 159660 | 0 | 0 | 1.2 |  |
| teapot | sdf | 6567 | 345184 | 0 | 18 | 25.7 |  |
