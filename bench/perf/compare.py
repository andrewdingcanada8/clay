#!/usr/bin/env python3
"""Image check for the SDF hill climb: compare a run's stills with a reference run's.

For each scene present in both: share of pixels differing by more than 24/255 in any
channel, PSNR, missed pixels (clay in the reference, background in the candidate),
extra pixels (the reverse) and the silhouette IoU.
Also diff24aa: the same share with a 1-pixel aliasing tolerance (a candidate pixel
matches if any reference pixel within 1 px of it matches within 24/255), for detail
thinner than a pixel, where the reference's own aliasing makes exact pixel positions
arbitrary. The strict gate is diff24; diff24aa is reported beside it, never instead. Clay = any channel above 8 (stills
are drawn on black). Writes compare.json into the candidate run and prints a table.
Usage: compare.py <reference run dir> <candidate run dir>
"""
import json, math, os, sys
import numpy as np
from PIL import Image, ImageChops

ref, cand = sys.argv[1], sys.argv[2]
out = {}
for f in sorted(os.listdir(cand)):
    if not f.endswith('.png') or not os.path.exists(os.path.join(ref, f)):
        continue
    A = Image.open(os.path.join(ref, f)).convert('RGB')
    B = Image.open(os.path.join(cand, f)).convert('RGB')
    if A.size != B.size:
        out[f[:-4]] = {'error': f'size {A.size} vs {B.size}'}
        continue
    d = ImageChops.difference(A, B)
    dmax = Image.eval(d.split()[0], lambda v: v)
    r, g, b = d.split()
    big = ImageChops.lighter(ImageChops.lighter(r, g), b)
    hist = big.histogram()
    n = A.size[0] * A.size[1]
    diff24 = sum(hist[25:])
    mse = sum(v * v * c for v, c in enumerate(ImageChops.difference(A.convert('L'), B.convert('L')).histogram())) / n
    psnr = 99.0 if mse == 0 else 10 * math.log10(255 * 255 / mse)
    ma = A.convert('L').point(lambda v: 255 if v > 8 else 0)
    mb = B.convert('L').point(lambda v: 255 if v > 8 else 0)
    inter = ImageChops.multiply(ma, mb).histogram()[255]
    union = ImageChops.lighter(ma, mb).histogram()[255]
    missed = ImageChops.subtract(ma, mb).histogram()[255]
    extra = ImageChops.subtract(mb, ma).histogram()[255]
    clay = ma.histogram()[255]
    a = np.asarray(A).astype(np.int16); b = np.asarray(B).astype(np.int16)
    H, W = a.shape[:2]
    pa = np.pad(a, ((1, 1), (1, 1), (0, 0)), mode='edge')
    ok = np.zeros((H, W), bool)
    for dy in (0, 1, 2):
        for dx in (0, 1, 2):
            ok |= np.abs(pa[dy:dy + H, dx:dx + W] - b).max(2) <= 24
    diff24aa = int((~ok).sum())
    out[f[:-4]] = {
        'diff24': round(diff24 / max(1, clay), 5), 'diff24aa': round(diff24aa / max(1, clay), 5), 'psnr': round(psnr, 2), 'missed': missed, 'extra': extra,
        'iou': round(inter / union, 5) if union else 1.0, 'clayPx': clay,
    }
json.dump(out, open(os.path.join(cand, 'compare.json'), 'w'), indent=1)
for k, v in out.items():
    if 'error' in v:
        print(f'{k:16} {v["error"]}')
    else:
        print(f'{k:16} diff>24 {v["diff24"]*100:6.2f}% of clay (1px aa {v["diff24aa"]*100:5.2f}%)  psnr {v["psnr"]:6.2f}  missed {v["missed"]:5d}  extra {v["extra"]:5d}  iou {v["iou"]:.4f}')
