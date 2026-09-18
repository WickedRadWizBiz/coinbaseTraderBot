import { useEffect, useRef, useState } from 'react';

export function useTradeShake() {
  const [shake, setShake] = useState(false);
  const lastLogIdRef = useRef<number | null>(null);

  useEffect(() => {
    const checkLogs = async () => {
      try {
        const res = await fetch('/api/logs');
        if (!res.ok) return;
        const ct = res.headers.get('content-type');
        if (!ct || !ct.includes('application/json')) return;
        const data = await res.json().catch(() => null);
        if (!data || !Array.isArray(data.logs)) return;
        const logs = data.logs;
        
        if (logs.length > 0) {
          const validIds = logs.map((l: any) => l?.id).filter((id: any) => typeof id === 'number' && !isNaN(id));
          if (validIds.length === 0) return;
          const maxId = Math.max(...validIds);
          
          if (lastLogIdRef.current !== null && maxId > lastLogIdRef.current) {
             const newLogs = logs.filter((l: any) => typeof l?.id === 'number' && l.id > lastLogIdRef.current!);
             if (newLogs.some((l: any) => l.type === 'TRADE' || l.type === 'EXECUTE' || l.type === 'PROFIT')) {
                setShake(true);
                // Dispatch event so other components know a trade occurred
                window.dispatchEvent(new Event('trade_executed'));
                setTimeout(() => setShake(false), 250);
             }
          }
          lastLogIdRef.current = maxId;
        }
      } catch (e) {
         // ignore fetch errors
      }
    };
    
    checkLogs();
    const interval = setInterval(checkLogs, 2000);
    return () => clearInterval(interval);
  }, []);
  
  return shake;
}
