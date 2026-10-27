// Kernel dispatch.

import type { Quality, SceneDoc } from './document';
import type { BuildResult } from './kernel';
import { buildMeshKernel } from './meshKernel';
import { buildSDF } from './sdfKernel';

export async function buildMesh(doc: SceneDoc, quality: Quality): Promise<BuildResult> {
  if (doc.kernel === 'mesh') return buildMeshKernel(doc, quality);
  return buildSDF(doc, quality);
}
