// Topology checks. A correct closed shell has no boundary edges even when it has
// openings: the rim around an opening is itself part of the closed surface.

export function edgeStats(indices: Uint32Array, vertexCount: number): { boundary: number; nonManifold: number } {
  const counts = new Map<number, number>();
  const n = vertexCount;
  for (let t = 0; t < indices.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = indices[t + e], b = indices[t + ((e + 1) % 3)];
      const key = a < b ? a * n + b : b * n + a;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  let boundary = 0, nonManifold = 0;
  for (const c of counts.values()) {
    if (c === 1) boundary++;
    else if (c > 2) nonManifold++;
  }
  return { boundary, nonManifold };
}

/** Merge vertices that share exact positions (mesh kernel output is split per face). */
export function weldVertices(positions: Float32Array, indices: Uint32Array, eps = 1e-5): { positions: Float32Array; indices: Uint32Array } {
  const map = new Map<string, number>();
  const remap = new Uint32Array(positions.length / 3);
  const out: number[] = [];
  const q = 1 / eps;
  for (let i = 0; i < positions.length / 3; i++) {
    const x = positions[3 * i], y = positions[3 * i + 1], z = positions[3 * i + 2];
    const key = `${Math.round(x * q)},${Math.round(y * q)},${Math.round(z * q)}`;
    let id = map.get(key);
    if (id === undefined) {
      id = out.length / 3;
      map.set(key, id);
      out.push(x, y, z);
    }
    remap[i] = id;
  }
  const idx = new Uint32Array(indices.length);
  for (let i = 0; i < indices.length; i++) idx[i] = remap[indices[i]];
  return { positions: new Float32Array(out), indices: idx };
}
