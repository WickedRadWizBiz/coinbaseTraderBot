#!/usr/bin/env python3
"""Read-only learning + settlement report for the running bot (used by the Server diagnostics workflow).

Answers: which trained models are live (passed validation) vs not, what each recent training run
concluded, how the live pricing scores against the market on settled contracts, how the shadow
networks are doing, and which held contracts are still waiting for Kalshi's result."""
import glob, json, os, sys, time, urllib.request

API = 'http://localhost:3000/api'
DATA = os.path.expanduser(sys.argv[1] if len(sys.argv) > 1 else '~/bot/data')

def get(path):
    try:
        return json.load(urllib.request.urlopen(API + path, timeout=20))
    except Exception as e:  # noqa: BLE001
        return {'_error': str(e)}

def short(v, n=220):
    s = json.dumps(v, default=str) if not isinstance(v, str) else v
    return s if len(s) <= n else s[:n] + '...'

now = time.time() * 1000
s = get('/status')

print('== live model')
m = s.get('model') or {}
print('  id', m.get('id'), '| kind', m.get('kind'), '| live blockers', m.get('liveBlockers'))
print('  validation', short(m.get('validation'), 400))
g = s.get('guards') or {}
mh = g.get('modelHealth') or g.get('health')
if mh: print('  live pricing vs market on settled windows:', short(mh, 300))
print('  tree models', short(s.get('treeModels'), 300))
print('  snn', short(s.get('snn'), 400))

print('== trained model files (data/models)')
a = get('/autotrain')
for k, v in sorted((a.get('models') or {}).items()):
    age = f"{(now - v['mtime']) / 3.6e6:.1f} h old" if v.get('mtime') else 'missing'
    print(f"  {k:12s} {age:14s} {v.get('id') or ''}  {v.get('path')}")
print('  last run exit', a.get('lastExit'), '| running', a.get('running'), '| swaps', short(a.get('swaps'), 300))

print('== recent training runs (what each step concluded)')
for rep in sorted(glob.glob(os.path.join(DATA, 'models', 'reports', 'pipeline-*.json')))[-3:]:
    try:
        r = json.load(open(rep))
    except Exception as e:  # noqa: BLE001
        print('  unreadable', rep, e); continue
    print(f"  -- {r.get('at')}  days of recordings: {r.get('days')}  promote: {r.get('promote')}")
    for st in r.get('steps') or []:
        d = st.get('detail')
        verdict = 'skipped: ' + str(st.get('skipped')) if st.get('skipped') else ('FAILED: ' + str(st.get('error'))[:160] if not st.get('ok') else short(d, 260))
        print(f"     {st.get('step'):14s} {verdict}")
    print('     readiness', short(r.get('readiness'), 300))

print('== settlement')
st = s.get('settlement')
if st: print('  sweeper', short(st, 600))
pos = get('/positions')
if isinstance(pos, list):
    open_ = [p for p in pos if not p.get('settled') and abs(p.get('yes') or 0) > 1e-9]
    for p in open_:
        close = p.get('closeTs') or 0
        past = f"{(now - close) / 6e4:.0f} min past close" if close and now > close else ('open' if close else 'close unknown')
        print(f"  held {p.get('ticker')} yes={p.get('yes')} {past}")
        if close and now - close > 30 * 60_000:
            try:
                k = json.load(urllib.request.urlopen('https://api.elections.kalshi.com/trade-api/v2/markets/' + p['ticker'], timeout=15)).get('market', {})
                print(f"     kalshi: status={k.get('status')} result={k.get('result')!r} close_time={k.get('close_time')}")
            except Exception as e:  # noqa: BLE001
                print('     kalshi lookup failed:', e)
    print(f"  settled positions on record: {sum(1 for p in pos if p.get('settled'))}")
