import { useCallback, useEffect, useRef, useState } from 'react';
import { api, Unauthorized } from '../api';

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
    const id = setInterval(() => { if (!document.hidden) void refresh(); }, intervalMs);
    return () => clearInterval(id);
  }, [path, intervalMs, refresh]);
  return { data, error, refresh };
}
