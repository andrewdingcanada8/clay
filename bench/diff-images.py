# Compare the a/b renders from same-image.mjs: per view, the share of pixels that
# differ by more than 8/255 in any channel, and the largest difference.
import sys, glob, os
from PIL import Image, ImageChops
d = sys.argv[1]
worst = 0
for a in sorted(glob.glob(os.path.join(d, '*-a.png'))):
    b = a[:-6] + '-b.png'
    if not os.path.exists(b): continue
    A, B = Image.open(a).convert('RGB'), Image.open(b).convert('RGB')
    diff = ImageChops.difference(A, B).convert('L')
    hist = diff.histogram()
    n = sum(hist); big = sum(hist[9:])
    mx = max(i for i, c in enumerate(hist) if c) if any(hist) else 0
    frac = big / n
    worst = max(worst, frac)
    flag = '  <-- differs' if frac > 0.0005 else ''
    print(f"{os.path.basename(a)[:-6]:28s} differing {100*frac:6.3f}%  max {mx:3d}{flag}")
print(f"worst {100*worst:.3f}%")
