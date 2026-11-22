#!/usr/bin/env python3
"""Assemble the SDF Hill Climb dashboard's data.json from the run results and the
state files (bench/perf/state/*.json), and copy the reference and latest stills.

state/runs.json lists the runs that count, in order: {dir, label, kept, note, device?}.
The first entry is the baseline. Scaling rows come from runs whose result.json holds
sweeps-N / pieces-N scenes.
Usage: build.py  (writes bench/perf/dashboard/data.json and stills/)
"""
import json, math, os, shutil, time

HERE = os.path.dirname(os.path.abspath(__file__))
PERF = os.path.dirname(HERE)
STATE = os.path.join(PERF, 'state')
RES = os.path.join(PERF, 'results')

def load(name, default):
    p = os.path.join(STATE, name)
    return json.load(open(p)) if os.path.exists(p) else default

runs_meta = load('runs.json', [])
runs = []
for m in runs_meta:
    p = os.path.join(RES, m['dir'], 'result.json')
    if not os.path.exists(p):
        continue
    r = json.load(open(p))
    runs.append({'label': m.get('label', r['label']), 'dir': m['dir'], 'kept': m.get('kept', False), 'device': m.get('device', False), 'note': m.get('note', ''),
                 'git': r.get('git'), 'stamp': r.get('stamp'), 'headlineFps': r.get('headlineFps'), 'contaminated': r.get('contaminated'),
                 'scenes': {k: {kk: v[kk] for kk in ('fps', 'msMean', 'msP95', 'msMax', 'mapsPerPx', 'objsPerMap', 'objsPerPx', 'workObjEvals', 'workMaps', 'foreignCores', 'prepareMs', 'msMove', 'msEdit', 'sharpAfterEditMs') if kk in v} for k, v in r['scenes'].items()}})

def fit(points):
    """Least squares on log-log: T = a·N^b. Returns b."""
    pts = [(math.log(n), math.log(t)) for n, t in points if n > 0 and t > 0]
    if len(pts) < 2:
        return None
    mx = sum(p[0] for p in pts) / len(pts); my = sum(p[1] for p in pts) / len(pts)
    den = sum((p[0] - mx) ** 2 for p in pts)
    return sum((p[0] - mx) * (p[1] - my) for p in pts) / den if den else None

scaling = []
for r in runs:
    sw = sorted([(int(k.split('-')[1]), v['msMean']) for k, v in r['scenes'].items() if k.startswith('sweeps-')])
    pc = sorted([(int(k.split('-')[1]), v['msMean']) for k, v in r['scenes'].items() if k.startswith('pieces-')])
    if len(sw) < 2 and len(pc) < 2:
        continue
    b = fit(sw)
    nmax = None
    if b and sw:
        a = math.exp(sum(math.log(t) - b * math.log(n) for n, t in sw) / len(sw))
        nmax = (1000 / a) ** (1 / b) if b > 0 else None
    scaling.append({'label': r['label'], 'sweeps': sw, 'pieces': pc, 'bSweeps': b, 'bPieces': fit(pc), 'nmaxSweeps': nmax})

baseline = runs[0] if runs else None
latest = next((r for r in reversed(runs) if r['kept']), None)
stills = {}
os.makedirs(os.path.join(HERE, 'stills'), exist_ok=True)
compare = {}
if baseline and latest:
    # the current still of each scene: the latest counted run that isn't a rejected attempt
    cur_dir = {}
    for r in runs:
        if r['kept'] or 'rejected' not in r.get('note', '') and r['label'].startswith(('merge', 'merged', 'full')):
            for f in os.listdir(os.path.join(RES, r['dir'])):
                if f.endswith('.png'):
                    cur_dir[f] = r['dir']
    for f, d in cur_dir.items():
        name = f[:-4]
        # the reference still: the first counted run that has this scene
        src_ref = next((os.path.join(RES, r['dir'], f) for r in runs if os.path.exists(os.path.join(RES, r['dir'], f))), None)
        if not src_ref:
            continue
        shutil.copy(src_ref, os.path.join(HERE, 'stills', f'{name}-ref.png'))
        shutil.copy(os.path.join(RES, d, f), os.path.join(HERE, 'stills', f'{name}-cur.png'))
        stills[name] = {'ref': f'stills/{name}-ref.png', 'cur': f'stills/{name}-cur.png'}
    cp = max((os.path.join(RES, d, 'compare.json') for d in set(cur_dir.values()) if os.path.exists(os.path.join(RES, d, 'compare.json'))), key=lambda x: len(json.load(open(x))), default='')
    if os.path.exists(cp):
        compare = json.load(open(cp))

scene_list = json.load(open(os.path.join(PERF, 'scenes', 'index.json')))
data = {
    'updated': int(time.time() * 1000), 'branch': 'claude/sdf-perf-hillclimb',
    'status': load('status.json', {}).get('text', ''), 'now': load('status.json', {}).get('now'), 'noise': load('status.json', {}).get('noise', ''),
    'baseline': baseline, 'runs': runs, 'scaling': scaling, 'sceneList': scene_list, 'stills': stills, 'compare': compare,
    'journal': load('journal.json', []), 'device': load('device.json', []), 'hypotheses': load('hypotheses.json', []), 'research': load('research.json', []),
}
json.dump(data, open(os.path.join(HERE, 'data.json'), 'w'))
print(f"data.json: {len(runs)} runs, {len(scaling)} scaling rows, {len(stills)} stills")
