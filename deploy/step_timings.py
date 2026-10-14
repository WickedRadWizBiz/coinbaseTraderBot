#!/usr/bin/env python3
"""Where training time goes: per-step minutes from the pipeline reports on the server (laptop rounds and remote runs
push theirs to models/reports). Read-only; prints step names, minutes and counts only (no settings, no paths).

    python3 deploy/step_timings.py ~/bot/data [reports=30]
"""
import glob
import json
import os
import statistics
import sys
import time

DATA = os.path.expanduser(sys.argv[1] if len(sys.argv) > 1 else '~/bot/data')
N = int(sys.argv[2]) if len(sys.argv) > 2 else 30
MODELS = os.path.join(DATA, 'models')


def source(rep):
    rec = str(rep.get('recordings') or '')
    if ':\\' in rec or 'trainer-data' in rec:
        return 'laptop'
    if '/runner/' in rec or '/home/runner' in rec:
        return 'remote'
    return 'server'


reports = []
for f in sorted(glob.glob(os.path.join(MODELS, 'reports', 'pipeline-*.json')))[-N:]:
    try:
        reports.append((f, json.load(open(f))))
    except Exception as e:  # noqa: BLE001
        print('unreadable', os.path.basename(f), type(e).__name__)

print(f'== the last {len(reports)} training run(s): total minutes, and the steps that took longest')
per_step = {}
for f, r in reports:
    steps = r.get('steps') or []
    ran = [s for s in steps if not s.get('skipped')]
    total = sum((s.get('ms') or 0) for s in steps) / 60000
    top = sorted(ran, key=lambda s: -(s.get('ms') or 0))[:6]
    tops = ', '.join(f"{s.get('step')} {(s.get('ms') or 0) / 60000:.1f}" + ('' if s.get('ok') else ' FAILED') for s in top)
    print(f"  {str(r.get('at'))[:16]}  {source(r):6s} complete={str(r.get('complete')):5s} {total:7.1f} min | {tops}")
    for s in ran:
        per_step.setdefault(s.get('step'), []).append((s.get('ms') or 0) / 60000)

print('\n== per step over those runs (runs where it ran, not skipped): median / max / total minutes')
rows = sorted(per_step.items(), key=lambda kv: -sum(kv[1]))
grand = sum(sum(v) for _, v in rows) or 1
for step, v in rows:
    print(f"  {step:22s} ran {len(v):3d}x  median {statistics.median(v):7.1f}  max {max(v):7.1f}  total {sum(v):8.1f}  ({100 * sum(v) / grand:4.1f}% of all)")

print('\n== tournaments (population size, rounds logged, last round)')
for st in sorted(glob.glob(os.path.join(MODELS, 'work', 'snnpbt', '*', 'state.json'))) + glob.glob(os.path.join(MODELS, 'work', 'tanet-population.json')):
    try:
        s = json.load(open(st))
    except Exception as e:  # noqa: BLE001
        print('  unreadable', st.split('models/')[-1], type(e).__name__); continue
    log = s.get('log') or []
    last = log[-1] if log else {}
    age = (time.time() - os.path.getmtime(st)) / 3600
    print(f"  {st.split('models/')[-1]:40s} members {len(s.get('members') or [])}  rounds {len(log)}  last eval {last.get('evalFrom')}..{last.get('evalTo')}  updated {age:.1f} h ago")

replay = os.path.join(DATA, 'history-replay')
if os.path.isdir(replay):
    days = [x for x in os.listdir(replay) if x.startswith('md-')]
    print(f'\n== history replay on the server: {len(days)} day file(s)')
