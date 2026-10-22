import { useCallback, useEffect, useRef, useState } from 'react';
import { api, Unauthorized } from '../api';

/** Run fn on wall-clock multiples of ms, so a page's polls go out together and a phone's radio wakes once per
 *  tick rather than once per request. Returns the cancel function. */
export function everyAligned(ms: number, fn: () => void): () => void {
  let timer: ReturnType<typeof setTimeout>;
  const next = () => {
    const now = Date.now();
    // The next multiple at least a tenth of a period away: a timer that fires a hair early or late never runs twice.
    timer = setTimeout(() => { fn(); next(); }, Math.ceil((now + ms / 10) / ms) * ms - now);
  };
  next();
  return () => clearTimeout(timer);
}

/** Poll an authenticated endpoint; pauses while the tab is hidden, and never stacks requests on a slow server. */
export function usePoll<T>(path: string | null, intervalMs = 2000): { data: T | undefined; error: string; refresh: () => Promise<void> } {
  const [data, setData] = useState<T>();
  const [error, setError] = useState('');
  const busy = useRef(false);
  const refresh = useCallback(async () => {
    if (!path || busy.current) return;
    busy.current = true;
    try {
      setData(await api<T>(path));
      setError('');
    } catch (e) {
      if (!(e instanceof Unauthorized)) setError((e as Error).message);
    } finally { busy.current = false; }
  }, [path]);
  useEffect(() => {
    if (!path) { setData(undefined); return; }
    void refresh();
    return everyAligned(intervalMs, () => { if (!document.hidden) void refresh(); });
  }, [path, intervalMs, refresh]);
  return { data, error, refresh };
}
