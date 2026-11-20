#!/usr/bin/env python3
"""Image check for the SDF hill climb: compare a run's stills with a reference run's.

For each scene present in both: share of pixels differing by more than 24/255 in any
channel, PSNR, missed pixels (clay in the reference, background in the candidate),
extra pixels (the reverse) and the silhouette IoU. Clay = any channel above 8 (stills
are drawn on black). Writes compare.json into the candidate run and prints a table.
Usage: compare.py <reference run dir> <candidate run dir>
"""
import json, math, os, sys
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
    out[f[:-4]] = {
        'diff24': round(diff24 / max(1, clay), 5), 'psnr': round(psnr, 2), 'missed': missed, 'extra': extra,
        'iou': round(inter / union, 5) if union else 1.0, 'clayPx': clay,
    }
json.dump(out, open(os.path.join(cand, 'compare.json'), 'w'), indent=1)
for k, v in out.items():
    if 'error' in v:
        print(f'{k:16} {v["error"]}')
    else:
        print(f'{k:16} diff>24 {v["diff24"]*100:6.2f}% of clay  psnr {v["psnr"]:6.2f}  missed {v["missed"]:5d}  extra {v["extra"]:5d}  iou {v["iou"]:.4f}')
