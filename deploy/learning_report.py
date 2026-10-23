#!/usr/bin/env python3
"""Read-only learning + settlement report for the running bot (used by the Server diagnostics workflow).

Answers: which trained models are live (passed validation) vs not, what each recent training run
concluded, how the live pricing scores against the market on settled contracts, how the shadow
networks are doing, and which held contracts are still waiting for Kalshi's result."""
import glob, json, os, sys, time, urllib.request

API = 'http://localhost:3000/api'
DATA = os.path.expanduser(sys.argv[1] if len(sys.argv) > 1 else '~/bot/data')

def dashboard_password():
    # The dashboard API needs the dashboard password when one is set: read from bot.env on this server and only ever
    # sent to localhost in a header (never printed, never on a command line).
    pw = ''
    try:
        for line in open(os.path.expanduser('~/bot/bot.env'), encoding='utf8'):
            if line.startswith('DASHBOARD_PASSWORD='):
                pw = line.split('=', 1)[1].strip()  # the last one wins, as in the diagnostics script
    except OSError:
        return ''
    return pw[1:-1] if len(pw) >= 2 and pw[0] == pw[-1] and pw[0] in '"\'' else pw

PW = dashboard_password()

def get(path):
    try:
        req = urllib.request.Request(API + path, headers={'Authorization': 'Bearer ' + PW} if PW else {})
        return json.load(urllib.request.urlopen(req, timeout=20))
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
th = g.get('taHealth')
print('  TA network tilt vs math alone on settled windows (advantage > 0 = TA helps):', short(th, 300) if th else 'no settled windows yet')
mk = get('/markets') or []
mk = mk if isinstance(mk, list) else []
for x in mk[:12]:
    c = x.get('conviction') or {}
    if c: print(f"  {x.get('ticker')}: TA shift {x.get('taShift')}, taDir {c.get('taDir')}, breadth up/down {c.get('breadthUp')}/{c.get('breadthDown')}, drift {c.get('drift')}, alt {(c.get('alt') or {}).get('why')}")
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

print('== training run logs (newest last)')
logs = sorted(glob.glob(os.path.join(DATA, 'models', 'logs', 'pipeline-*.log')))
for lf in logs[-5:]:
    print(f"  {os.path.basename(lf)}  {os.path.getsize(lf) // 1024} KB")
if logs:
    try:
        tail = open(logs[-1], errors='replace').read().splitlines()[-15:]
        for line in tail: print('   |', line[:200])
    except Exception as e:  # noqa: BLE001
        print('  unreadable', e)
st_file = os.path.join(DATA, 'models', 'pipeline_state.json')
print('  pipeline state:', short(json.load(open(st_file)) if os.path.exists(st_file) else 'none yet', 500))

print('== what each book has learned from its results (files on disk: paper in data/, live in data/live/)')
def load(path):
    try:
        return json.load(open(path))
    except Exception:  # noqa: BLE001
        return None
for name, d in (('paper', DATA), ('live', os.path.join(DATA, 'live'))):
    if not os.path.isdir(d): print(f"  {name}: no book yet"); continue
    pr = load(os.path.join(d, 'probation.json')) or {}
    for book, b in sorted(pr.items()):
        r = b.get('results') or []
        bench = b.get('benched')
        print(f"  {name} probation {book:7s} {len(r)} results, net ${sum(r):.2f}" + (f" | BENCHED {time.strftime('%Y-%m-%d %H:%M', time.gmtime(bench['at'] / 1000))} UTC: {bench.get('reason')}" if bench else ' | open'))
    eg = load(os.path.join(d, 'equity_guard.json')) or {}
    h = eg.get('history') or []
    if eg.get('reference') is not None and h: print(f"  {name} size vs break-even: break-even ${eg['reference']:.2f}, last hourly equity ${h[-1]['equity']:.2f} ({time.strftime('%m-%d %H:%M', time.gmtime(h[-1]['ts'] / 1000))} UTC)")
    ce = load(os.path.join(d, 'curve-exit.json'))
    if ce: print(f"  {name} exit curve: {len(ce.get('results') or [])} held exits scored, net ${sum(ce.get('results') or []):.2f} | benched {short(ce.get('benched'), 160)}")
    fsch = load(os.path.join(d, 'fee_schedule.json'))
    if fsch:
        p, v, f = fsch.get('published') or {}, fsch.get('votes') or {}, fsch.get('fills') or {}
        read = time.strftime('%m-%d %H:%M', time.gmtime((p.get('checkedAt') or 0) / 1000)) if p else '-'
        print(f"  {name} fee schedule: published {p.get('effective')} (taker {p.get('takerRate')}, maker {p.get('makerRate')}, {len(p.get('nonStandard') or {})} series listed, read {read} UTC)"
              f" | rounding grid learned {fsch.get('learnedPrecision')} (votes direct {v.get('direct', 0)}, fcm {v.get('fcm', 0)})"
              f" | fills checked {f.get('checked', 0)}: exact {f.get('exact', 0)}, rebate {f.get('rebate', 0)}, mismatch {f.get('mismatch', 0)}" + (f" | last mismatch {short((f.get('last') or {}).get('note'), 300)}" if f.get('last') else ''))

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
