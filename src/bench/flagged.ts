// Pieces flagged as problems in the published app, pulled from its database into
// bench/flagged/<id>.json (see bench/flagged/README.md). Each becomes a bench case
// `flagged-<id>`, rendered from the camera and settings saved with the flag.

import { normalizeDoc } from '../engine/document';
import type { Example } from '../examples';
import type { Piece } from '../app/pieces';

const files = import.meta.glob('../../bench/flagged/*.json', { eager: true, import: 'default' }) as Record<string, Piece>;

export function flaggedCases(): (Example & { piece: Piece })[] {
  return Object.values(files).map((p) => ({
    id: `flagged-${p.id}`,
    title: p.name,
    notes: p.flag ? `${p.flag.kernels.join(' + ') || 'unspecified'}: ${p.flag.note || '(no note)'}` : '',
    doc: normalizeDoc(p.doc),
    probes: [],
    piece: p,
  }));
}
