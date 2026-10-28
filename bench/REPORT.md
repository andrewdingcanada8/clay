# Benchmark report

Quality: normal. Images: `bench/out/<case>-<kernel>.png`.

| case | kernel | build ms | triangles | boundary edges | non-manifold | max interior white % | warnings |
|---|---|---:|---:|---:|---:|---:|---|
| open-box | sdf | 4162 | 368200 | 0 | 0 | 44.8 |  |
| open-box | mesh | 36 | 42 | 0 | 0 | 44.8 |  |
| sphere-cube | sdf | 2766 | 210824 | 0 | 0 | 72.9 |  |
| sphere-cube | mesh | 112 | 18434 | 0 | 0 | 72.9 |  |
| chain-30 | sdf | 6839 | 165124 | 0 | 65 | 10.9 |  |
| chain-30 | mesh | 2671 | 576744 | 0 | 0 | 10.8 |  |
| vase | sdf | 5549 | 189904 | 0 | 0 | 18.1 |  |
| vase | mesh | 99 | 21612 | 0 | 0 | 17.3 |  |
| bowl | sdf | 3654 | 153100 | 0 | 0 | 100.0 |  |
| bowl | mesh | 59 | 11088 | 0 | 0 | 100.0 |  |
| cylinder-pins | sdf | 3319 | 295456 | 0 | 0 | 25.0 |  |
| cylinder-pins | mesh | 51 | 1972 | 0 | 0 | 24.9 |  |
| cup-stick | sdf | 4502 | 169064 | 0 | 0 | 22.2 |  |
| cup-stick | mesh | 106 | 12636 | 0 | 0 | 21.9 |  |
| vase-sticks | sdf | 7029 | 206740 | 0 | 10 | 1.7 |  |
| vase-sticks | mesh | 377 | 25290 | 0 | 0 | 1.7 |  |
| vase-solid-sticks | sdf | 5865 | 198444 | 0 | 0 | 1.7 |  |
| vase-solid-sticks | mesh | 157 | 22932 | 0 | 0 | 1.7 |  |
| torus | sdf | 1118 | 208552 | 0 | 0 | 0.0 |  |
| torus | mesh | 121 | 41624 | 0 | 0 | 0.0 |  |
| lattice | sdf | 6268 | 254440 | 0 | 1 | 0.9 |  |
| lattice | mesh | 31 | 376 | 0 | 0 | 0.7 |  |
| vase-thin | sdf | 28505 | 1173532 | 0 | 1 | 24.1 | Mesh wall for Group 1 drawn at 0.21 cm, not 0.20 cm (grid too coarse at this size). |
| vase-thin | mesh | 160 | 22064 | 0 | 0 | 24.0 |  |
| chain-thin | sdf | 11668 | 609968 | 0 | 207 | 0.0 |  |
| chain-thin | mesh | 1004 | 223848 | 0 | 0 | 0.0 | Sphere 1: opening on curved face "surface" not supported by the mesh kernel |
| transformed | sdf | 2518 | 194812 | 0 | 48 | 68.7 |  |
| transformed | mesh | 125 | 14782 | 0 | 0 | 68.7 | Sphere: X/Z scale differs, wall thickness approximate |
| rotated-box | sdf | 2127 | 217984 | 0 | 79 | 50.6 |  |
| rotated-box | mesh | 32 | 40 | 0 | 0 | 50.5 |  |
| tower | sdf | 4976 | 142280 | 0 | 0 | 53.7 |  |
| tower | mesh | 34 | 408 | 0 | 0 | 53.3 |  |
| thick-wall | sdf | 1513 | 94984 | 0 | 0 | 0.9 |  |
| thick-wall | mesh | 134 | 24198 | 0 | 0 | 0.0 |  |
| cut-sphere | sdf | 3757 | 269300 | 0 | 5 | 5.1 |  |
| cut-sphere | mesh | 148 | 16936 | 0 | 0 | 5.0 |  |
| mug-stick | sdf | 4226 | 165512 | 0 | 128 | 17.1 |  |
| mug-stick | mesh | 146 | 27088 | 0 | 0 | 17.3 |  |
| mug-thin | sdf | 21680 | 925152 | 85 | 110 | 20.2 | Mesh wall for Group 1 drawn at 0.25 cm, not 0.08 cm (grid too coarse at this size).; 44 quads skipped at block borders |
| mug-thin | mesh | 210 | 27122 | 0 | 0 | 19.6 |  |
| two-groups | sdf | 4263 | 224816 | 0 | 0 | 33.4 |  |
| two-groups | mesh | 113 | 21032 | 0 | 0 | 33.0 |  |
| frustums | sdf | 5009 | 213536 | 0 | 0 | 53.6 |  |
| frustums | mesh | 21 | 76 | 0 | 0 | 58.5 |  |
| big-pins | sdf | 2613 | 271044 | 0 | 0 | 22.7 |  |
| big-pins | mesh | 32 | 1392 | 0 | 0 | 22.7 |  |
| sdf-narrow-join | sdf | 1041 | 174300 | 0 | 0 | 1.9 |  |
| sdf-narrow-join | mesh | 175 | 39960 | 0 | 0 | 1.9 |  |
| sdf-pebble | sdf | 619 | 150660 | 0 | 0 | 0.0 |  |
| sdf-pebble | mesh | 91 | 20448 | 0 | 0 | 0.0 | Pebble: X/Z scale differs, wall thickness approximate |
| sdf-blend | sdf | 2848 | 158708 | 0 | 4 | 1.8 |  |
| sdf-blend | mesh | 349 | 52490 | 0 | 0 | 1.6 | Group 1: smooth blend needs the SDF kernel; shown as a sharp union |
| teapot | sdf | 5874 | 345160 | 0 | 18 | 25.7 |  |
| teapot | mesh | 208 | 36750 | 0 | 0 | 25.6 |  |
| sweep-mug | sdf | 7152 | 209296 | 0 | 1 | 26.0 |  |
| sweep-mug | mesh | 133 | 22590 | 0 | 0 | 25.7 |  |
| coil | sdf | 47844 | 509948 | 42 | 3 | 0.0 | 12 quads skipped at block borders |
| coil | mesh | 282 | 74286 | 0 | 0 | 0.0 |  |
| sweep-frame | sdf | 8042 | 149220 | 0 | 0 | 0.0 |  |
| sweep-frame | mesh | 104 | 16642 | 0 | 0 | 0.0 |  |
