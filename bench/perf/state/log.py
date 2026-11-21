#!/usr/bin/env python3
"""Append to the hill climb's record (bench/perf/state).

  log.py run <label-suffix of a results dir> <shown label> <kept|rejected|info> [note]
  log.py journal <kept|rejected|info> <title> <hypothesis> <change> <result> [commit]
  log.py hyp <id> <status> <evidence>
  log.py status <text>
  log.py now <current> [--agent a]... [--next q]...
"""
import glob, json, os, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
RES = os.path.join(os.path.dirname(HERE), 'results')
load = lambda n, d: json.load(open(os.path.join(HERE, n))) if os.path.exists(os.path.join(HERE, n)) else d
save = lambda n, v: json.dump(v, open(os.path.join(HERE, n), 'w'), indent=1)

cmd, args = sys.argv[1], sys.argv[2:]
if cmd == 'run':
    dirs = sorted(d for d in glob.glob(os.path.join(RES, f'*-{args[0]}')) if os.path.isdir(d))
    if not dirs:
        sys.exit(f'no results dir ending in -{args[0]}')
    runs = load('runs.json', [])
    runs.append({'dir': os.path.basename(dirs[-1]), 'label': args[1], 'kept': args[2] == 'kept', 'note': args[3] if len(args) > 3 else ''})
    save('runs.json', runs)
elif cmd == 'journal':
    j = load('journal.json', [])
    verdict, title, hyp, change, result = args[:5]
    j.append({'id': len(j) + 1, 't': int(time.time() * 1000), 'title': title, 'hyp': hyp, 'change': change, 'result': result, 'verdict': verdict, 'commit': args[5] if len(args) > 5 else ''})
    save('journal.json', j)
elif cmd == 'hyp':
    h = load('hypotheses.json', [])
    for x in h:
        if x['id'] == args[0]:
            x['status'], x['evidence'] = args[1], args[2]
            break
    else:
        h.append({'id': args[0], 'title': args[2], 'area': '', 'expect': '', 'status': args[1], 'evidence': ''})
    save('hypotheses.json', h)
elif cmd == 'status':
    s = load('status.json', {})
    s['text'] = args[0]
    save('status.json', s)
elif cmd == 'now':
    s = load('status.json', {})
    n = {'current': args[0], 'agents': [], 'queue': [], 'updated': int(time.time() * 1000)}
    it = iter(args[1:])
    for k in it:
        n['agents' if k == '--agent' else 'queue'].append(next(it))
    s['now'] = n
    save('status.json', s)
print('ok')
