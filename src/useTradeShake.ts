import { useEffect, useRef, useState } from 'react';

export function useTradeShake() {
  const [shake, setShake] = useState(false);
  const lastLogIdRef = useRef<number | null>(null);

  useEffect(() => {
    let isMounted = true;
    const checkLogs = async () => {
      if (document.hidden) return;
      try {
        const res = await fetch('/api/logs').catch(() => null);
        if (!res || !res.ok) return;
        const ct = res.headers.get('content-type');
        if (!ct || !ct.includes('application/json')) return;
        const data = await res.json().catch(() => null);
        if (!data || !Array.isArray(data.logs) || !isMounted) return;
        const logs = data.logs;
        
        if (logs.length > 0) {
          const validIds = logs.map((l: any) => l?.id).filter((id: any) => typeof id === 'number' && !isNaN(id));
          if (validIds.length === 0) return;
          const maxId = Math.max(...validIds);
          
          if (lastLogIdRef.current !== null && maxId > lastLogIdRef.current) {
             const newLogs = logs.filter((l: any) => typeof l?.id === 'number' && l.id > lastLogIdRef.current!);
             if (newLogs.some((l: any) => l.type === 'TRADE' || l.type === 'EXECUTE' || l.type === 'PROFIT')) {
                setShake(true);
                window.dispatchEvent(new Event('trade_executed'));
                setTimeout(() => { if (isMounted) setShake(false); }, 250);
             }
          }
          lastLogIdRef.current = maxId;
        }
      } catch (e) {
         // ignore fetch errors
      }
    };
    
    checkLogs();
    const interval = setInterval(checkLogs, 5000);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, []);
  
  return shake;
}

