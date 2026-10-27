# Benchmark report

Quality: normal. Images: `bench/out/<case>-<kernel>.png`.

| case | kernel | build ms | triangles | boundary edges | non-manifold | max interior white % | warnings |
|---|---|---:|---:|---:|---:|---:|---|
| open-box | sdf | 1032 | 368184 | 0 | 0 | 44.8 |  |
| open-box | mesh | 27 | 42 | 0 | 0 | 44.8 |  |
| sphere-cube | sdf | 650 | 210932 | 0 | 0 | 72.9 |  |
| sphere-cube | mesh | 103 | 18434 | 0 | 0 | 72.9 |  |
| chain-30 | sdf | 2632 | 165436 | 0 | 63 | 10.9 |  |
| chain-30 | mesh | 2749 | 576744 | 0 | 0 | 10.8 |  |
| vase | sdf | 1666 | 189884 | 0 | 0 | 18.1 |  |
| vase | mesh | 123 | 21612 | 0 | 0 | 17.3 |  |
| bowl | sdf | 1130 | 153100 | 0 | 0 | 100.0 |  |
| bowl | mesh | 94 | 11088 | 0 | 0 | 100.0 |  |
| cylinder-pins | sdf | 1612 | 295396 | 0 | 0 | 25.0 |  |
| cylinder-pins | mesh | 70 | 1972 | 0 | 0 | 24.9 |  |
| cup-stick | sdf | 1165 | 169044 | 0 | 1 | 22.3 |  |
| cup-stick | mesh | 99 | 12636 | 0 | 0 | 21.9 |  |
| vase-sticks | sdf | 1803 | 206596 | 0 | 7 | 1.7 |  |
| vase-sticks | mesh | 383 | 25290 | 0 | 0 | 1.7 |  |
| vase-solid-sticks | sdf | 1758 | 198432 | 0 | 0 | 1.7 |  |
| vase-solid-sticks | mesh | 169 | 22932 | 0 | 0 | 1.7 |  |
| torus | sdf | 1274 | 208552 | 0 | 0 | 0.0 |  |
| torus | mesh | 149 | 41624 | 0 | 0 | 0.0 |  |
| lattice | sdf | 3310 | 256308 | 0 | 0 | 0.0 |  |
| lattice | mesh | 17 | 376 | 0 | 0 | 0.7 |  |
| vase-thin | sdf | — | — | — | — | — | ERROR: timeout (> 300 s) |
| vase-thin | mesh | 156 | 22064 | 0 | 0 | 24.0 |  |
| chain-thin | sdf | 6548 | 654448 | 650 | 490 | 0.0 | 243 quads skipped at block borders |
| chain-thin | mesh | — | — | — | — | — | ERROR: Error: Error creating WebGL context. |
| transformed | sdf | — | — | — | — | — | ERROR: Error: Error creating WebGL context. |
| transformed | mesh | — | — | — | — | — | ERROR: Error: Error creating WebGL context. |
| rotated-box | sdf | — | — | — | — | — | ERROR: Error: Error creating WebGL context. |
| rotated-box | mesh | — | — | — | — | — | ERROR: Error: Error creating WebGL context. |
| tower | sdf | — | — | — | — | — | ERROR: Error: Error creating WebGL context. |
| tower | mesh | — | — | — | — | — | ERROR: Error: Error creating WebGL context. |
| thick-wall | sdf | — | — | — | — | — | ERROR: Error: Error creating WebGL context. |
| thick-wall | mesh | — | — | — | — | — | ERROR: Error: Error creating WebGL context. |
| cut-sphere | sdf | — | — | — | — | — | ERROR: Error: Error creating WebGL context. |
| cut-sphere | mesh | — | — | — | — | — | ERROR: Error: Error creating WebGL context. |
| mug-stick | sdf | — | — | — | — | — | ERROR: Error: Error creating WebGL context. |
| mug-stick | mesh | — | — | — | — | — | ERROR: Error: Error creating WebGL context. |
| mug-thin | sdf | — | — | — | — | — | ERROR: Error: Error creating WebGL context. |
| mug-thin | mesh | — | — | — | — | — | ERROR: Error: Error creating WebGL context. |
| two-groups | sdf | — | — | — | — | — | ERROR: Error: Error creating WebGL context. |
| two-groups | mesh | — | — | — | — | — | ERROR: Error: Error creating WebGL context. |
