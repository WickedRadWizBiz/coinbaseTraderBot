import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import { everyAligned } from './components/usePoll';

/** Shakes the panels and flashes the LEDs when a new fill lands. */
export function useTradeShake() {
  const [shake, setShake] = useState(false);
  const lastSeq = useRef<number | null>(null);

  useEffect(() => {
    let alive = true;
    const check = async () => {
      if (document.hidden) return;
      try {
        const rows = await api<Array<{ seq: number }>>('/audit?kind=fill&limit=5');
        const max = rows.reduce((m, r) => Math.max(m, r.seq), 0);
        if (lastSeq.current !== null && max > lastSeq.current && alive) {
          setShake(true);
          window.dispatchEvent(new Event('trade_executed'));
          setTimeout(() => alive && setShake(false), 250);
        }
        lastSeq.current = max;
      } catch { /* ignore */ }
    };
    void check();
    const stop = everyAligned(3000, () => void check());
    return () => { alive = false; stop(); };
  }, []);
  return shake;
}
