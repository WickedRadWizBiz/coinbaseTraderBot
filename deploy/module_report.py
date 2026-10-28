#!/usr/bin/env python3
"""Read-only daily module report (used by the Server diagnostics workflow): the bot's module ledger now (/api/modules)
and over the last 24 hours (the hourly 'modules' audit records): per module, the hours it spent on / shadow / off /
benched, its latest score, and every flag it raised. Prints aggregates only."""
import calendar, collections, glob, json, os, sys, time, urllib.request

API = 'http://localhost:3000/api'
DATA = os.path.expanduser(sys.argv[1] if len(sys.argv) > 1 else '~/bot/data')
HOURS = float(sys.argv[2]) if len(sys.argv) > 2 else 24.0


def dashboard_password():
    # Read from bot.env on this server and only ever sent to localhost in a header (never printed).
    pw = ''
    try:
        for line in open(os.path.expanduser('~/bot/bot.env'), encoding='utf8'):
            if line.startswith('DASHBOARD_PASSWORD='):
                pw = line.split('=', 1)[1].strip()
    except OSError:
        return ''
    return pw[1:-1] if len(pw) >= 2 and pw[0] == pw[-1] and pw[0] in '"\'' else pw


def get(path):
    try:
        pw = dashboard_password()
        req = urllib.request.Request(API + path, headers={'Authorization': 'Bearer ' + pw} if pw else {})
        return json.load(urllib.request.urlopen(req, timeout=20))
    except Exception as e:  # noqa: BLE001
        return {'_error': str(e)}


def line(r):
    sc = r.get('score') or {}
    s = f" | {sc.get('label')}: {sc.get('value')}{' (n=%s)' % sc['n'] if sc.get('n') else ''}" if sc else ''
    v = '' if r.get('validated') is None else (' | validated' if r['validated'] else ' | not validated')
    f = f" | {'; '.join(r['flags'])}" if r.get('flags') else ''
    return f"{r['area']:<7} {r['module']:<26} {r['state']:<7}{v}{s}{f}"


print('== modules now')
now = get('/modules')
if '_error' in now:
    print('(no /api/modules yet: ships with this release)', now['_error'][:120])
else:
    for r in now.get('rows', []):
        print('  ' + line(r))

print(f'\n== modules over the last {HOURS:g} h (hourly ledger in the audit log)')
cutoff = time.time() - HOURS * 3600
since_day = time.strftime('%Y-%m-%d', time.gmtime(cutoff))
files = sorted(f for f in glob.glob(os.path.join(DATA, 'audit', 'audit-*.jsonl')) if os.path.basename(f)[6:16] >= since_day)
hours = collections.defaultdict(collections.Counter)
flags = collections.defaultdict(collections.Counter)
last = {}
n = 0
for fn in files:
    with open(fn, encoding='utf8') as fh:
        for l in fh:
            if '"kind":"modules"' not in l:
                continue
            rec = json.loads(l)
            ts = calendar.timegm(time.strptime(rec['ts'][:19], '%Y-%m-%dT%H:%M:%S'))
            if ts < cutoff:
                continue
            n += 1
            for r in (rec.get('data') or {}).get('rows', []):
                hours[r['module']][r['state']] += 1
                for f in r.get('flags') or []:
                    flags[r['module']][f] += 1
                last[r['module']] = r
print(f'{n} hourly snapshots')
for m in sorted(hours, key=lambda k: (last[k]['area'], k)):
    h = ' '.join(f'{s} {c}h' for s, c in hours[m].most_common())
    sc = (last[m].get('score') or {})
    print(f"  {last[m]['area']:<7} {m:<26} {h:<28} latest {sc.get('value')}{' n=%s' % sc['n'] if sc.get('n') else ''}")
    for f, c in flags[m].most_common(3):
        print(f'      flag {c}h: {f}')
