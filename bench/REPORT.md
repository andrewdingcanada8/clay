# Benchmark report

Quality: normal. Images: `bench/out/<case>-<kernel>.png`.

| case | kernel | build ms | triangles | boundary edges | non-manifold | max interior white % | warnings |
|---|---|---:|---:|---:|---:|---:|---|
| open-box | sdf | 1099 | 270384 | 0 | 0 | 44.8 |  |
| open-box | mesh | 33 | 40 | 0 | 0 | 44.8 |  |
| sphere-cube | sdf | 832 | 155056 | 0 | 0 | 72.2 |  |
| sphere-cube | mesh | 108 | 18428 | 0 | 0 | 72.9 |  |
| chain-30 | sdf | 920 | 166140 | 0 | 72 | 11.8 |  |
| chain-30 | mesh | 4701 | 576744 | 0 | 0 | 10.8 |  |
| vase | sdf | 1163 | 139324 | 0 | 0 | 18.1 |  |
| vase | mesh | 92 | 21612 | 0 | 0 | 17.3 |  |
| bowl | sdf | 971 | 111672 | 0 | 0 | 100.0 |  |
| bowl | mesh | 48 | 11088 | 0 | 0 | 100.0 |  |
| cylinder-pins | sdf | 1817 | 216400 | 0 | 0 | 25.0 |  |
| cylinder-pins | mesh | 25 | 1980 | 0 | 0 | 24.9 |  |
| cup-stick | sdf | 1006 | 123996 | 0 | 2 | 22.2 |  |
| cup-stick | mesh | 67 | 12640 | 0 | 0 | 21.9 |  |
| vase-sticks | sdf | 1402 | 164952 | 0 | 7 | 1.7 |  |
| vase-sticks | mesh | 353 | 25296 | 0 | 0 | 1.7 |  |
| vase-solid-sticks | sdf | 1330 | 169628 | 0 | 2 | 1.7 |  |
| vase-solid-sticks | mesh | 141 | 23544 | 0 | 0 | 1.7 |  |
| torus | sdf | 929 | 152436 | 0 | 0 | 0.0 |  |
| torus | mesh | 132 | 41624 | 0 | 0 | 0.0 |  |
| lattice | sdf | 868 | 187752 | 0 | 2 | 0.7 |  |
| lattice | mesh | 15 | 372 | 0 | 0 | 0.7 |  |
| vase-thin | sdf | 8466 | 1189248 | 0 | 0 | 23.9 | Wall drawn at 0.21 cm, not 0.20 cm: the SDF grid can't resolve it at this size. Use Fine quality, or the Mesh kernel for the exact wall. |
| vase-thin | mesh | 163 | 22070 | 0 | 0 | 24.0 |  |
| chain-thin | sdf | 3385 | 616112 | 0 | 88 | 0.0 |  |
| chain-thin | mesh | 968 | 223848 | 0 | 0 | 0.0 | Sphere 1: opening on curved face "surface" not supported by the mesh kernel |
| transformed | sdf | 1036 | 143172 | 0 | 51 | 68.8 |  |
| transformed | mesh | 110 | 14782 | 0 | 0 | 68.7 | Sphere: X/Z scale differs, wall thickness approximate |
| rotated-box | sdf | 825 | 160040 | 0 | 61 | 50.6 |  |
| rotated-box | mesh | 10 | 42 | 0 | 0 | 50.5 |  |
| tower | sdf | 711 | 104728 | 0 | 1 | 53.4 |  |
| tower | mesh | 26 | 402 | 0 | 0 | 53.3 |  |
| thick-wall | sdf | 744 | 69376 | 0 | 2 | 0.9 |  |
| thick-wall | mesh | 92 | 24198 | 0 | 0 | 0.0 |  |
| cut-sphere | sdf | 1478 | 197836 | 0 | 5 | 5.0 |  |
| cut-sphere | mesh | 109 | 16938 | 0 | 0 | 5.0 |  |
| mug-stick | sdf | 1246 | 171136 | 0 | 1 | 15.1 |  |
| mug-stick | mesh | 147 | 35158 | 0 | 0 | 15.8 |  |
| mug-thin | sdf | 7030 | 927328 | 0 | 6 | 16.7 | Wall drawn at 0.25 cm, not 0.08 cm: the SDF grid can't resolve it at this size. Use Fine quality, or the Mesh kernel for the exact wall. |
| mug-thin | mesh | 216 | 35900 | 0 | 0 | 17.6 |  |
