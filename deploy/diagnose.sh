#!/usr/bin/env bash
# One-shot health report for the running bot (run on the server: bash ~/bot/current/deploy/diagnose.sh).
python3 - <<'PY'
import json, time, urllib.request
g = lambda p: json.load(urllib.request.urlopen('http://localhost:3000/api' + p, timeout=20))
s = g('/status'); now = time.time() * 1000
c = s.get('catalog') or {}
print('HALT      ', s.get('haltReasons'))
print('ENTRIES   ', json.dumps(s.get('entryDiagnosis')))
print('CATALOG    age %ss, took %sms, tracked %s, open %s, failed %s' % (round((now - c.get('ts', 0)) / 1000), c.get('durationMs'), c.get('tracked'), c.get('open'), c.get('failed')))
print('CLOCK     ', json.dumps((s.get('guards') or {}).get('clock')))
print('BANKROLL  ', s.get('balance'), s.get('bankroll'), 'daily pnl', s.get('dailyPnl'), 'run', s.get('run'))
t = s.get('tennis') or {}
print('TENNIS     enabled', t.get('enabled'), 'trading', t.get('trading'), 'matches', len(t.get('matches') or []), [ (m.get('event'), m.get('phase')) for m in (t.get('matches') or [])[:6] ])
p = s.get('perps') or {}
print('PERPS     ', s.get('perpsMode'), {k: p.get(k) for k in list(p)[:8]})
o = g('/orders?limit=300'); live = g('/orders?live=1')
from collections import Counter
print('ORDERS     live', len(live), 'recent', Counter(x.get('status') for x in o), 'by purpose', Counter(x.get('purpose') for x in o))
pos = [x for x in g('/positions') if not x.get('settled')]
print('POSITIONS  open', len(pos), [x.get('ticker') for x in pos[:8]])
a = g('/autotrain')
print('TRAINING   running', a.get('running'), 'paused', a.get('paused'), 'window', json.dumps(a.get('window')), 'last exit', a.get('lastExit'))
PY
journalctl -u kalshi-bot --since "20 min ago" --no-pager | grep -E "ERROR|WARN" | sed -E 's/.*(WARN|ERROR)/\1/' | sort | uniq -c | sort -rn | head -12
