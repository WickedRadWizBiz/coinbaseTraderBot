#!/usr/bin/env python3
"""One-time repair of stored Kalshi history quotes (the same rule as repairLegacyCents in research/history/kalshiHistory.ts).

Until PR #217, markets from Kalshi's /historical endpoint (legacy price fields in dollars) were divided by 100 once more,
so their candles hold quotes like 0.0049 instead of 0.49. A real quote is never below a cent, so every price in (0, 0.01)
is multiplied by 100. Idempotent: a repaired file has nothing left in that range. Each file is rewritten through a temp
file and a rename. Prints counts only.

  python3 kalshi_cents_repair.py [--dry-run] DIR [DIR ...]
"""
import json
import os
import sys

PRICE_KEYS = ('bidO', 'bidH', 'bidL', 'bidC', 'askO', 'askH', 'askL', 'askC', 'last')


def fix_line(line):
    """Returns the repaired line, or None when the line needs nothing."""
    try:
        m = json.loads(line)
    except ValueError:
        return None
    candles = m.get('candles') if isinstance(m, dict) else None
    if not isinstance(candles, list):
        return None
    hit = False
    for c in candles:
        if not isinstance(c, dict):
            continue
        for k in PRICE_KEYS:
            v = c.get(k)
            if isinstance(v, (int, float)) and not isinstance(v, bool) and 0 < v < 0.01:
                c[k] = round(v * 1e6) / 1e4
                hit = True
    return json.dumps(m, separators=(',', ':'), ensure_ascii=False) if hit else None


def repair(root, dry):
    files = markets = scanned = 0
    for series in sorted(os.listdir(root)):
        sd = os.path.join(root, series)
        if not os.path.isdir(sd):
            continue
        for f in sorted(os.listdir(sd)):
            if not f.endswith('.jsonl'):
                continue
            scanned += 1
            path = os.path.join(sd, f)
            with open(path, encoding='utf-8') as fh:
                lines = fh.read().split('\n')
            changed = 0
            for i, line in enumerate(lines):
                if not line:
                    continue
                fixed = fix_line(line)
                if fixed is not None:
                    lines[i] = fixed
                    changed += 1
            if changed:
                files += 1
                markets += changed
                if not dry:
                    with open(path + '.tmp', 'w', encoding='utf-8') as fh:
                        fh.write('\n'.join(lines))
                    os.replace(path + '.tmp', path)
    return scanned, files, markets


def main(argv):
    dry = '--dry-run' in argv
    dirs = [a for a in argv if a != '--dry-run']
    for d in dirs:
        if not os.path.isdir(d):
            print(f'{d}: not present')
            continue
        scanned, files, markets = repair(d, dry)
        verb = 'would repair' if dry else 'repaired'
        print(f'{d}: {scanned} day file(s) scanned, {verb} {markets} market(s) in {files} file(s)')


if __name__ == '__main__':
    main(sys.argv[1:])
