# Benchmark report

Quality: normal. Images: `bench/out/<case>-<kernel>.png`.

| case | kernel | build ms | triangles | boundary edges | non-manifold | max interior white % | warnings |
|---|---|---:|---:|---:|---:|---:|---|
| open-box | sdf | 3396 | 368200 | 0 | 0 | 44.8 |  |
| open-box | mesh | 20 | 28 | 0 | 0 | 44.8 |  |
| sphere-cube | sdf | 2817 | 210864 | 0 | 0 | 72.9 |  |
| sphere-cube | mesh | 73 | 18414 | 0 | 0 | 72.9 |  |
| chain-30 | sdf | 7311 | 164812 | 0 | 66 | 0.0 |  |
| chain-30 | mesh | 9413 | 577032 | 0 | 0 | 10.9 |  |
| vase | sdf | 3811 | 189916 | 0 | 0 | 18.1 |  |
| vase | mesh | 67 | 21600 | 0 | 0 | 18.0 |  |
| bowl | sdf | 2556 | 153092 | 0 | 0 | 100.0 |  |
| bowl | mesh | 62 | 11664 | 0 | 0 | 100.0 |  |
| cylinder-pins | sdf | 3858 | 295416 | 0 | 0 | 23.2 |  |
| cylinder-pins | mesh | 52 | 2440 | 0 | 0 | 24.9 |  |
| cup-stick | sdf | 4619 | 169068 | 0 | 0 | 22.2 |  |
| cup-stick | mesh | 83 | 12716 | 0 | 0 | 22.1 |  |
| vase-sticks | sdf | 7022 | 206664 | 0 | 8 | 1.7 |  |
| vase-sticks | mesh | 323 | 25278 | 0 | 0 | 1.7 |  |
| vase-solid-sticks | sdf | 4323 | 198440 | 0 | 0 | 1.7 |  |
| vase-solid-sticks | mesh | 80 | 22920 | 0 | 0 | 1.7 |  |
| torus | sdf | 830 | 208552 | 0 | 0 | 0.0 |  |
| torus | mesh | 139 | 41764 | 0 | 0 | 0.0 |  |
| lattice | sdf | 6542 | 254440 | 0 | 1 | 0.7 |  |
| lattice | mesh | 32 | 364 | 0 | 0 | 0.7 |  |
| vase-thin | sdf | 21075 | 1173592 | 0 | 0 | 24.1 | Mesh wall for Group 1 drawn at 0.21 cm, not 0.20 cm (grid too coarse at this size). |
| vase-thin | mesh | 115 | 21888 | 0 | 0 | 24.0 |  |
| chain-thin | sdf | 12418 | 609968 | 0 | 207 | 0.0 |  |
| chain-thin | mesh | 1381 | 223848 | 0 | 0 | 0.0 | Sphere 1: opening on curved face "surface" not supported by the mesh kernel |
| transformed | sdf | 2522 | 193000 | 0 | 51 | 68.7 |  |
| transformed | mesh | 82 | 14750 | 0 | 0 | 68.7 | Sphere: X/Z scale differs, wall thickness approximate |
| rotated-box | sdf | 1824 | 217944 | 0 | 79 | 50.5 |  |
| rotated-box | mesh | 19 | 28 | 0 | 0 | 50.5 |  |
| tower | sdf | 4889 | 142276 | 0 | 1 | 53.3 |  |
| tower | mesh | 22 | 378 | 0 | 0 | 53.3 |  |
| thick-wall | sdf | 1591 | 96152 | 0 | 3 | 0.2 |  |
| thick-wall | mesh | 126 | 24186 | 0 | 0 | 0.0 |  |
| cut-sphere | sdf | 3871 | 269280 | 0 | 5 | 5.0 |  |
| cut-sphere | mesh | 161 | 16590 | 0 | 0 | 5.0 |  |
| mug-stick | sdf | 4404 | 165500 | 0 | 125 | 17.0 |  |
| mug-stick | mesh | 179 | 26902 | 0 | 0 | 17.3 |  |
| mug-thin | sdf | 22429 | 923868 | 87 | 105 | 20.1 | Mesh wall for Group 1 drawn at 0.25 cm, not 0.08 cm (grid too coarse at this size).; 37 quads skipped at block borders |
| mug-thin | mesh | 201 | 26890 | 0 | 0 | 19.6 |  |
| two-groups | sdf | 3462 | 224824 | 0 | 0 | 33.4 |  |
| two-groups | mesh | 106 | 21024 | 0 | 0 | 33.3 |  |
| frustums | sdf | 5344 | 236292 | 0 | 3 | 51.9 |  |
| frustums | mesh | 23 | 68 | 0 | 0 | 51.9 |  |
| big-pins | sdf | 2502 | 270976 | 0 | 0 | 19.1 |  |
| big-pins | mesh | 45 | 1264 | 0 | 0 | 22.7 |  |
| sdf-narrow-join | sdf | 1221 | 174312 | 0 | 3 | 0.0 |  |
| sdf-narrow-join | mesh | 155 | 39960 | 0 | 0 | 1.9 |  |
| sdf-pebble | sdf | 654 | 144976 | 0 | 0 | 0.0 |  |
| sdf-pebble | mesh | 57 | 20448 | 0 | 0 | 0.0 | Pebble: X/Z scale differs, wall thickness approximate |
| sdf-blend | sdf | 3163 | 158648 | 0 | 4 | 1.9 |  |
| sdf-blend | mesh | 321 | 52042 | 0 | 0 | 1.6 | Smooth blends need the SDF kernel; shown as sharp joins and cuts |
| teapot | sdf | 5929 | 345112 | 0 | 18 | 0.0 |  |
| teapot | mesh | 218 | 36750 | 0 | 0 | 25.6 |  |
| sweep-mug | sdf | 5392 | 216992 | 0 | 1 | 26.0 |  |
| sweep-mug | mesh | 130 | 22670 | 0 | 0 | 26.0 |  |
| coil | sdf | 39916 | 592744 | 0 | 2 | 0.0 |  |
| coil | mesh | 320 | 74288 | 0 | 0 | 0.0 |  |
| sweep-frame | sdf | 7848 | 146904 | 0 | 0 | 0.0 |  |
| sweep-frame | mesh | 609 | 47198 | 0 | 0 | 0.0 |  |
| sweep-corners | sdf | 2681 | 79824 | 0 | 0 | 0.0 |  |
| sweep-corners | mesh | 204 | 24680 | 0 | 0 | 0.0 |  |
| flagged-pmvrzc7lj484po | sdf | 4276 | 151008 | 0 | 4 | 0.0 |  |
| flagged-pmvrzc7lj484po | mesh | 244 | 32526 | 0 | 0 | 0.0 |  |
| round-mirror | sdf | 6369 | 222688 | 0 | 6 | 33.0 |  |
| round-mirror | mesh | 183 | 22422 | 0 | 0 | 32.9 |  |
| flagged-pmvthxhy99j3f9 | sdf | 9051 | 200384 | 0 | 0 | 0.0 |  |
| flagged-pmvthxhy99j3f9 | mesh | 204 | 43596 | 0 | 0 | 0.0 | Smooth blends need the SDF kernel; shown as sharp joins and cuts |
