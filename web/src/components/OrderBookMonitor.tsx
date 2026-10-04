import { useEffect, useMemo, useState } from 'react';
import { Area, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api, pct, px } from '../api';

interface MarketRow {
  ticker: string;
  asset: string;
  closeTs: number;
  position: number;
  fairValue?: number;
  pYes?: number;
  bestBid?: number;
  bestAsk?: number;
  strike?: number;
  spot?: number;
  exitMode?: 'fair_value' | 'hunt';
  huntTarget?: number;
  huntStop?: number;
}

interface Level { price: number; size: number }

/**
 * Depth monitor: the contract's YES order book (cumulative depth areas) with
 * the matching spot USD pair's order book overlaid (dashed amber lines on
 * their own axes), plus the book imbalance meter. Only the contracts the
 * bot is trading appear: an open position or a working order (positions first).
 */
const WORKING = new Set(['PENDING_NEW', 'UNKNOWN', 'ACKED', 'PARTIALLY_FILLED', 'CANCEL_PENDING']);

export function OrderBookMonitor({ markets, orders = [] }: { markets: MarketRow[]; orders?: Array<{ ticker: string; state: string }> }) {
  const tabs = useMemo(() => {
    const working = new Set(orders.filter((o) => WORKING.has(o.state)).map((o) => o.ticker));
    return markets
      .filter((m) => Math.abs(m.position) > 0 || working.has(m.ticker))
      .sort((a, b) => Number(Math.abs(b.position) > 0) - Number(Math.abs(a.position) > 0) || a.closeTs - b.closeTs);
  }, [markets, orders]);
  const [active, setActive] = useState<string | null>(null);
  const [book, setBook] = useState<{ bids: Level[]; asks: Level[]; usable: boolean } | null>(null);
  const [spot, setSpot] = useState<{ product: string; bids: Level[]; asks: Level[]; index: number | null; strike: number | null; error?: string } | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!tabs.length) { setActive(null); return; }
    if (!active || !tabs.some((t) => t.ticker === active)) setActive(tabs[0].ticker);
  }, [tabs, active]);

  const tab = tabs.find((t) => t.ticker === active);

  useEffect(() => {
    if (!active) { setBook(null); setSpot(null); return; }
    let alive = true;
    setLoading(true);
    const load = async () => {
      if (document.hidden) return;
      try {
        const b = await api<any>(`/order-book/${encodeURIComponent(active)}`);
        if (alive) setBook({ bids: b.bids ?? [], asks: b.asks ?? [], usable: Boolean(b.usable) });
      } catch { if (alive) setBook(null); }
      try {
        const s = await api<any>(`/spot-book/${encodeURIComponent(active)}`);
        if (alive) setSpot(s);
      } catch (e) {
        if (alive) setSpot((prev) => ({ product: prev?.product ?? '', bids: [], asks: [], index: prev?.index ?? null, strike: prev?.strike ?? null, error: (e as Error).message }));
      }
      if (alive) setLoading(false);
    };
    void load();
    const id = setInterval(load, 3000);
    return () => { alive = false; clearInterval(id); };
  }, [active]);

  // Cumulative contract depth (same construction as the original monitor).
  const orderBook = useMemo(() => {
    if (!book) return [];
    let cBid = 0;
    const bidData = [...book.bids].sort((a, b) => b.price - a.price)
      .map((b) => { cBid += b.size; return { price: b.price, bidVol: cBid, askVol: null as number | null }; })
      .sort((a, b) => a.price - b.price);
    let cAsk = 0;
    const askData = [...book.asks].sort((a, b) => a.price - b.price)
      .map((a) => { cAsk += a.size; return { price: a.price, bidVol: null as number | null, askVol: cAsk }; });
    return [...bidData, ...askData];
  }, [book]);

  const [spotBookBids, spotBookAsks] = useMemo(() => {
    if (!spot) return [[], []];
    let cb = 0;
    const sb = [...spot.bids].sort((a, b) => b.price - a.price).map((b) => { cb += b.size; return { price: b.price, cumSize: cb }; }).sort((a, b) => a.price - b.price);
    let ca = 0;
    const sa = [...spot.asks].sort((a, b) => a.price - b.price).map((a) => { ca += a.size; return { price: a.price, cumSize: ca }; });
    return [sb, sa];
  }, [spot]);

  const totalBidVol = orderBook.reduce((m, i) => Math.max(m, i.bidVol ?? 0), 0);
  const totalAskVol = orderBook.reduce((m, i) => Math.max(m, i.askVol ?? 0), 0);
  const totalVol = totalBidVol + totalAskVol;
  const cumulativeImbalance = totalVol > 0 ? Number((((totalBidVol - totalAskVol) / totalVol) * 100).toFixed(1)) : 0;

  const spotBid = spotBookBids.length ? spotBookBids[spotBookBids.length - 1].price : undefined;
  const spotAsk = spotBookAsks.length ? spotBookAsks[0].price : undefined;
  const spotMid = spotBid !== undefined && spotAsk !== undefined ? (spotBid + spotAsk) / 2 : undefined;
  const fmtSpot = (v: number | null | undefined) => (v === null || v === undefined ? '—' : v < 10 ? v.toFixed(4) : v.toFixed(2));

  return (
    <div className="crt-grid-panel crt-glass !p-0 flex flex-col overflow-hidden relative z-10 mt-2">
      <div className="absolute inset-0 heavy-dither-overlay pointer-events-none" />

      {/* Market tabs (positions first) */}
      <div className="flex overflow-x-auto whitespace-nowrap scrollbar-hide crt-border-b bg-black/40 relative z-20">
        {tabs.length === 0 ? (
          <div className="px-4 py-3 text-xs font-bold tracking-widest uppercase text-crypto-primary/70 flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-crypto-danger animate-pulse" />
            <span>[NO CONTRACTS IN PLAY]</span>
          </div>
        ) : (
          tabs.map((t) => {
            const isActive = t.ticker === active;
            const side = t.position > 0 ? 'YES' : t.position < 0 ? 'NO' : null;
            return (
              <button
                key={t.ticker}
                onClick={() => { setActive(t.ticker); setLoading(true); }}
                className={`px-4 py-3 text-xs font-bold tracking-widest uppercase transition-colors flex flex-shrink-0 items-center gap-2.5 crt-border-r max-w-[300px] truncate ${
                  isActive ? 'bg-crypto-danger text-crypto-text shadow-[0_0_12px_rgba(194,59,90,0.4)]' : 'text-crypto-primary opacity-70 hover:opacity-100 hover:bg-[#1a0208]'
                }`}
              >
                {side && (
                  <span className={`px-1.5 py-0.5 text-[10px] font-black crt-border ${side === 'YES' ? 'bg-crypto-success/30 text-crypto-success' : 'bg-crypto-danger/30 text-crypto-danger'}`}>
                    {side} {Math.abs(t.position)}
                  </span>
                )}
                <span className="truncate">[{t.ticker}]</span>
                <span className="text-[10px] text-crypto-success">{pct(t.pYes)}</span>
              </button>
            );
          })
        )}
      </div>

      {/* Fixed screen: the same size empty, loading or charting. */}
      <div className="p-6 flex flex-col gap-6 relative z-20 h-[600px] sm:h-[480px] crt-scroll">
        {!tab ? (
          <div className="h-full flex flex-col items-center justify-center gap-3 border border-crypto-primary/30 bg-black/40 p-6 text-center">
            <div className="w-3 h-3 bg-crypto-danger rounded-full animate-ping" />
            <span className="text-crypto-danger font-mono tracking-widest text-sm font-bold uppercase">[NOT TRADING ANY CONTRACT]</span>
            <span className="text-xs text-crypto-primary opacity-70 max-w-md">The depth monitor shows only contracts the bot holds or has an order working in. It fills in as soon as the bot trades.</span>
          </div>
        ) : loading && orderBook.length === 0 ? (
          <div className="h-full flex items-center justify-center">
            <span className="text-crypto-primary animate-pulse font-mono tracking-widest text-sm">INITIATING DEPTH STREAM...</span>
          </div>
        ) : (
          <>
            <div className="flex justify-between items-center flex-wrap gap-2">
              <div className="max-w-full overflow-hidden flex items-center gap-3 flex-wrap">
                <h3 className="font-bold tracking-[0.2em] text-lg flex items-center gap-2 text-crypto-text uppercase">
                  <span>&gt; DEPTH MONITOR</span>
                </h3>
                <div className="flex items-center gap-2 flex-wrap text-xs">
                  {tab.position !== 0 && (
                    <span className={`px-2 py-0.5 crt-border font-black uppercase ${tab.position > 0 ? 'bg-crypto-success/20 text-crypto-success' : 'bg-crypto-danger/20 text-crypto-danger'}`}>
                      {tab.position > 0 ? 'YES' : 'NO'} ×{Math.abs(tab.position)}
                    </span>
                  )}
                  <span className="px-2 py-0.5 crt-border bg-black/40 font-bold text-crypto-primary max-w-full md:max-w-xl truncate">
                    {tab.ticker} · BID {px(tab.bestBid)} / ASK {px(tab.bestAsk)}
                  </span>
                  <span className="px-2 py-0.5 crt-border bg-[#8f73ff15] text-[#e2d5ed] font-mono text-[11px]">
                    FAIR {pct(tab.fairValue)} · MODEL {pct(tab.pYes)}
                  </span>
                  <span className="px-2 py-0.5 crt-border bg-[#f59e0b15] text-[#f59e0b] font-mono text-[11px]">
                    {spot?.product || `${tab.asset}-USD`} {fmtSpot(spotMid)} · INDEX {fmtSpot(spot?.index ?? tab.spot)} · STRIKE {fmtSpot(spot?.strike ?? tab.strike)}
                  </span>
                  {tab.exitMode === 'hunt' && (
                    <span className="px-2 py-0.5 crt-border bg-crypto-success/20 text-crypto-success font-bold flex items-center gap-1.5 text-[11px]">
                      <span className="w-1.5 h-1.5 rounded-full bg-crypto-success animate-pulse" />
                      HUNTING · TARGET {px(tab.huntTarget)} · STOP {tab.huntStop !== undefined ? px(tab.huntStop) : 'FORMING'}
                    </span>
                  )}
                  {book && !book.usable && (
                    <span className="px-2 py-0.5 crt-border bg-crypto-danger/20 text-crypto-danger font-bold text-[11px]">BOOK STALE</span>
                  )}
                  {spot?.error && (
                    <span className="px-2 py-0.5 crt-border bg-black/50 text-[#808080] text-[10px]" title={spot.error}>SPOT BOOK UNAVAILABLE</span>
                  )}
                </div>
              </div>
            </div>

            <div className="h-[250px] w-full crt-border bg-black/30 p-4 relative">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart margin={{ top: 10, right: 0, left: -20, bottom: 0 }}>
                  <defs>
                    <pattern id="ditherBid" x="0" y="0" width="4" height="4" patternUnits="userSpaceOnUse">
                      <circle cx="1" cy="1" r="1" fill="#e2d5ed" opacity="0.6" />
                      <circle cx="3" cy="3" r="1" fill="#e2d5ed" opacity="0.6" />
                    </pattern>
                    <pattern id="ditherAsk" x="0" y="0" width="4" height="4" patternUnits="userSpaceOnUse">
                      <circle cx="1" cy="1" r="1" fill="#c23b5a" opacity="0.6" />
                      <circle cx="3" cy="3" r="1" fill="#c23b5a" opacity="0.6" />
                    </pattern>
                  </defs>
                  <CartesianGrid strokeDasharray="2 4" stroke="#c23b5a" strokeOpacity={0.4} vertical={true} horizontal={true} />
                  <XAxis xAxisId="contract" dataKey="price" stroke="#c23b5a" tick={{ fill: '#c23b5a', fontSize: 10, fontFamily: 'monospace' }} tickLine={false} axisLine={false}
                    tickFormatter={(v: number) => (v <= 1 ? v.toFixed(2) : v.toFixed(0))} type="number" domain={['dataMin', 'dataMax']} />
                  <YAxis yAxisId="contract" stroke="#c23b5a" tick={{ fill: '#c23b5a', fontSize: 10, fontFamily: 'monospace' }} tickLine={false} axisLine={false} />
                  <Tooltip
                    contentStyle={{ backgroundColor: '#0a0204', border: '1px solid #c23b5a', color: '#e2d5ed', fontSize: '12px', fontFamily: 'monospace' }}
                    labelFormatter={(v) => `Price: $${Number(v) <= 1 ? Number(v).toFixed(2) : Number(v).toFixed(2)}`}
                  />
                  <Area data={orderBook} xAxisId="contract" yAxisId="contract" type="stepAfter" dataKey="bidVol" name="YES bids" stroke="#e2d5ed" strokeWidth={2} fillOpacity={1} fill="url(#ditherBid)" isAnimationActive={false} />
                  <Area data={orderBook} xAxisId="contract" yAxisId="contract" type="stepAfter" dataKey="askVol" name="YES asks" stroke="#c23b5a" strokeWidth={2} fillOpacity={1} fill="url(#ditherAsk)" isAnimationActive={false} />
                  <XAxis xAxisId="spot" dataKey="price" type="number" domain={['dataMin', 'dataMax']} hide />
                  <YAxis yAxisId="spot" hide />
                  <Line data={spotBookBids} xAxisId="spot" yAxisId="spot" type="stepAfter" dataKey="cumSize" name="Spot bids" stroke="#f59e0b" strokeWidth={2} strokeDasharray="4 4" dot={false} isAnimationActive={false} />
                  <Line data={spotBookAsks} xAxisId="spot" yAxisId="spot" type="stepAfter" dataKey="cumSize" name="Spot asks" stroke="#f59e0b" strokeWidth={2} strokeDasharray="4 4" dot={false} isAnimationActive={false} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>

            <div className="flex flex-col gap-3 crt-border-t pt-6">
              <div className="flex justify-between items-center text-xs font-bold tracking-widest uppercase gap-2 flex-wrap">
                <span className="text-crypto-danger">Sell Wall (-100) [{Math.min(0, cumulativeImbalance).toFixed(1)}]</span>
                <span className="text-crypto-text">Neutral (0) [Imbalance: {cumulativeImbalance > 0 ? `+${cumulativeImbalance}` : cumulativeImbalance}]</span>
                <span className="text-crypto-primary">Buy Wall (+100) [{Math.max(0, cumulativeImbalance).toFixed(1)}]</span>
              </div>
              <div className="relative w-full h-6 crt-border bg-black/30 flex overflow-hidden">
                <div className="absolute left-1/2 top-0 bottom-0 w-px bg-crypto-primary z-10" />
                {cumulativeImbalance > 0 ? (
                  <div className="absolute left-1/2 h-full dither-bg-light transition-all duration-500 bg-crypto-primary/60" style={{ width: `${Math.min(50, (cumulativeImbalance / 100) * 50)}%` }} />
                ) : (
                  <div className="absolute right-1/2 h-full dither-bg-dark transition-all duration-500 bg-crypto-danger/60" style={{ width: `${Math.min(50, (Math.abs(cumulativeImbalance) / 100) * 50)}%` }} />
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
