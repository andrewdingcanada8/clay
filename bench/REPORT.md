# Benchmark report

Quality: normal. Images: `bench/out/<case>-<kernel>.png`.

| case | kernel | build ms | triangles | boundary edges | non-manifold | max interior white % | warnings |
|---|---|---:|---:|---:|---:|---:|---|
| open-box | sdf | 1155 | 265984 | 0 | 0 | 42.2 |  |
| open-box | mesh | 26 | 40 | 0 | 0 | 41.8 |  |
| open-box | mesh-mk | 116 | 44 | 0 | 0 | 41.8 |  |
| sphere-cube | sdf | 1022 | 152324 | 0 | 0 | 66.2 |  |
| sphere-cube | mesh | 111 | 18516 | 0 | 0 | 66.5 |  |
| sphere-cube | mesh-mk | 39756 | 28082 | 0 | 0 | 66.5 |  |
| chain-30 | sdf | 669 | 100960 | 0 | 60 | 12.0 |  |
| chain-30 | mesh | 3350 | 577264 | 0 | 0 | 10.8 |  |
| vase | sdf | 1241 | 137516 | 0 | 0 | 16.2 |  |
| vase | mesh | 98 | 21168 | 0 | 0 | 14.9 |  |
| bowl | sdf | 997 | 110616 | 0 | 0 | 100.0 |  |
| bowl | mesh | 53 | 11110 | 0 | 0 | 100.0 |  |
| cylinder-pins | sdf | 1811 | 212832 | 0 | 0 | 22.9 |  |
| cylinder-pins | mesh | 25 | 1982 | 0 | 0 | 22.8 |  |
| cup-stick | sdf | 1173 | 121924 | 0 | 0 | 21.4 |  |
| cup-stick | mesh | 64 | 12424 | 0 | 0 | 21.1 |  |
| cup-stick | mesh-mk | 28647 | 22546 | 0 | 0 | 21.1 |  |
| vase-sticks | sdf | 1424 | 149156 | 0 | 4 | 1.5 |  |
| vase-sticks | mesh | 336 | 24698 | 0 | 0 | 1.5 |  |
| vase-solid-sticks | sdf | 1285 | 154524 | 0 | 3 | 1.5 |  |
| vase-solid-sticks | mesh | 109 | 22948 | 0 | 0 | 1.5 |  |
| torus | sdf | 931 | 148152 | 0 | 0 | 0.0 |  |
| torus | mesh | 124 | 41620 | 0 | 0 | 0.0 |  |
| lattice | sdf | 853 | 178020 | 0 | 0 | 0.6 |  |
| lattice | mesh | 15 | 372 | 0 | 0 | 0.6 |  |
| vase-thin | sdf | 1751 | 221940 | 0 | 0 | 20.3 |  |
| vase-thin | mesh | 97 | 21938 | 0 | 0 | 20.2 |  |
| chain-thin | sdf | 588 | 90800 | 0 | 39 | 0.0 |  |
| chain-thin | mesh | 951 | 230292 | 0 | 0 | 0.0 | Sphere 1: opening on curved face "surface" not supported by the mesh kernel |
| transformed | sdf | 1138 | 140952 | 0 | 53 | 67.7 |  |
| transformed | mesh | 96 | 14970 | 0 | 0 | 67.7 | Sphere: X/Z scale differs, wall thickness approximate |
| rotated-box | sdf | 861 | 157816 | 0 | 59 | 49.4 |  |
| rotated-box | mesh | 8 | 50 | 0 | 0 | 49.4 |  |
| rotated-box | mesh-mk | 97 | 66 | 0 | 0 | 49.5 |  |
| tower | sdf | 779 | 103040 | 0 | 0 | 51.1 |  |
| tower | mesh | 26 | 408 | 0 | 0 | 50.5 |  |
| tower | mesh-mk | 1761 | 1194 | 0 | 0 | 50.5 |  |
| thick-wall | sdf | 725 | 65916 | 0 | 4 | 0.3 |  |
| thick-wall | mesh | 100 | 24202 | 0 | 0 | 0.0 |  |
| thick-wall | mesh-mk | 70776 | 27454 | 0 | 0 | 0.3 |  |
| cut-sphere | sdf | 1495 | 193732 | 0 | 3 | 4.2 |  |
| cut-sphere | mesh | 98 | 16788 | 0 | 0 | 4.1 |  |
