# Benchmark report

Quality: normal. Images: `bench/out/<case>-<kernel>.png`.

| case | kernel | build ms | triangles | boundary edges | non-manifold | max interior white % | warnings |
|---|---|---:|---:|---:|---:|---:|---|
| open-box | sdf | 3913 | 368200 | 0 | 0 | 44.8 |  |
| open-box | mesh | 36 | 28 | 0 | 0 | 44.8 |  |
| sphere-cube | sdf | 2647 | 210824 | 0 | 0 | 72.9 |  |
| sphere-cube | mesh | 93 | 18414 | 0 | 0 | 72.9 |  |
| chain-30 | sdf | 6353 | 165124 | 0 | 65 | 10.9 |  |
| chain-30 | mesh | 5684 | 576744 | 0 | 0 | 10.8 |  |
| vase | sdf | 5786 | 189904 | 0 | 0 | 18.1 |  |
| vase | mesh | 59 | 21600 | 0 | 0 | 18.0 |  |
| bowl | sdf | 3696 | 153100 | 0 | 0 | 100.0 |  |
| bowl | mesh | 54 | 11664 | 0 | 0 | 100.0 |  |
| cylinder-pins | sdf | 3592 | 295456 | 0 | 0 | 25.0 |  |
| cylinder-pins | mesh | 25 | 1576 | 0 | 0 | 24.9 |  |
| cup-stick | sdf | 4464 | 169064 | 0 | 0 | 22.2 |  |
| cup-stick | mesh | 55 | 12716 | 0 | 0 | 22.1 |  |
| vase-sticks | sdf | 6956 | 206740 | 0 | 10 | 1.7 |  |
| vase-sticks | mesh | 319 | 25278 | 0 | 0 | 1.7 |  |
| vase-solid-sticks | sdf | 5885 | 198444 | 0 | 0 | 1.7 |  |
| vase-solid-sticks | mesh | 122 | 22920 | 0 | 0 | 1.7 |  |
| torus | sdf | 1054 | 208552 | 0 | 0 | 0.0 |  |
| torus | mesh | 137 | 41624 | 0 | 0 | 0.0 |  |
| lattice | sdf | 6418 | 254440 | 0 | 1 | 0.9 |  |
| lattice | mesh | 29 | 364 | 0 | 0 | 0.7 |  |
| vase-thin | sdf | 28841 | 1173532 | 0 | 1 | 24.1 | Mesh wall for Group 1 drawn at 0.21 cm, not 0.20 cm (grid too coarse at this size). |
| vase-thin | mesh | 105 | 21888 | 0 | 0 | 24.0 |  |
| chain-thin | sdf | 11206 | 609968 | 0 | 207 | 0.0 |  |
| chain-thin | mesh | 1478 | 223848 | 0 | 0 | 0.0 | Sphere 1: opening on curved face "surface" not supported by the mesh kernel |
| transformed | sdf | 2488 | 194812 | 0 | 48 | 68.7 |  |
| transformed | mesh | 84 | 14750 | 0 | 0 | 68.7 | Sphere: X/Z scale differs, wall thickness approximate |
| rotated-box | sdf | 2067 | 217984 | 0 | 79 | 50.6 |  |
| rotated-box | mesh | 15 | 28 | 0 | 0 | 50.5 |  |
| tower | sdf | 4774 | 142280 | 0 | 0 | 53.7 |  |
| tower | mesh | 22 | 378 | 0 | 0 | 53.3 |  |
| thick-wall | sdf | 1492 | 94984 | 0 | 0 | 0.9 |  |
| thick-wall | mesh | 116 | 24186 | 0 | 0 | 0.0 |  |
| cut-sphere | sdf | 3816 | 269300 | 0 | 5 | 5.1 |  |
| cut-sphere | mesh | 90 | 16590 | 0 | 0 | 5.0 |  |
| mug-stick | sdf | 4268 | 165512 | 0 | 128 | 17.1 |  |
| mug-stick | mesh | 140 | 26902 | 0 | 0 | 17.3 |  |
| mug-thin | sdf | 22923 | 925152 | 85 | 110 | 20.2 | Mesh wall for Group 1 drawn at 0.25 cm, not 0.08 cm (grid too coarse at this size).; 44 quads skipped at block borders |
| mug-thin | mesh | 202 | 26890 | 0 | 0 | 19.6 |  |
| two-groups | sdf | 4296 | 224816 | 0 | 0 | 33.4 |  |
| two-groups | mesh | 80 | 21024 | 0 | 0 | 33.3 |  |
| frustums | sdf | 4835 | 213536 | 0 | 0 | 53.6 |  |
| frustums | mesh | 14 | 68 | 0 | 0 | 51.9 |  |
| big-pins | sdf | 2914 | 271044 | 0 | 0 | 22.7 |  |
| big-pins | mesh | 25 | 976 | 0 | 0 | 22.7 |  |
| sdf-narrow-join | sdf | 1044 | 174300 | 0 | 0 | 1.9 |  |
| sdf-narrow-join | mesh | 140 | 39960 | 0 | 0 | 1.9 |  |
| sdf-pebble | sdf | 623 | 150660 | 0 | 0 | 0.0 |  |
| sdf-pebble | mesh | 58 | 20448 | 0 | 0 | 0.0 | Pebble: X/Z scale differs, wall thickness approximate |
| sdf-blend | sdf | 2939 | 158708 | 0 | 4 | 1.8 |  |
| sdf-blend | mesh | 275 | 52042 | 0 | 0 | 1.6 | Group 1: smooth blend needs the SDF kernel; shown as a sharp union |
| teapot | sdf | 5809 | 345160 | 0 | 18 | 25.7 |  |
| teapot | mesh | 161 | 36750 | 0 | 0 | 25.6 |  |
| sweep-mug | sdf | 7406 | 216992 | 0 | 1 | 26.0 |  |
| sweep-mug | mesh | 91 | 22670 | 0 | 0 | 26.0 |  |
| coil | sdf | 51622 | 592920 | 0 | 2 | 0.0 |  |
| coil | mesh | 231 | 74288 | 0 | 0 | 0.0 |  |
| sweep-frame | sdf | 7816 | 146960 | 0 | 0 | 0.0 |  |
| sweep-frame | mesh | 828 | 47198 | 0 | 0 | 0.0 |  |
| sweep-corners | sdf | 2751 | 79896 | 0 | 0 | 0.0 |  |
| sweep-corners | mesh | 201 | 24680 | 0 | 0 | 0.0 |  |
| flagged-pmvrzc7lj484po | sdf | 5797 | 151020 | 0 | 4 | 0.0 |  |
| flagged-pmvrzc7lj484po | mesh | 197 | 32526 | 0 | 0 | 0.0 |  |
| round-mirror | sdf | 9233 | 220392 | 0 | 10 | 30.6 |  |
| round-mirror | mesh | 200 | 40248 | 0 | 0 | 26.7 | Group 1: rounded cut rims need the SDF kernel; shown sharp |
| flagged-pmvthxhy99j3f9 | sdf | 9405 | 200720 | 0 | 0 | 0.0 |  |
| flagged-pmvthxhy99j3f9 | mesh | 157 | 43596 | 0 | 0 | 0.0 | Group 1: smooth blend needs the SDF kernel; shown as a sharp union |
