import React, { useEffect, useState } from 'react';
import { ComposedChart, Line, Area, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

interface OrderBookMonitorProps {
  marketContext: any;
}

export function OrderBookMonitor({ marketContext }: OrderBookMonitorProps) {
  const activePositions: any[] = Array.isArray(marketContext?.activePositions) 
    ? marketContext.activePositions 
    : [];

  const availableContracts = activePositions.map((pos: any, idx: number) => ({
    id: pos.symbol || `pos-${idx}`,
    symbol: pos.symbol,
    label: pos.label || pos.symbol,
    side: pos.side || 'YES',
    entryPrice: pos.entryPrice || 0.50,
    size: pos.size || 10,
    pnlRatio: typeof pos.pnlRatio === 'number' ? pos.pnlRatio : 0,
    category: pos.category || 'crypto',
    reason: pos.reason || '',
    isPerpetual: Boolean(pos.isPerpetual || pos.symbol?.endsWith('PERP')),
    smartTrailing: pos.smartTrailing,
    analysisMeta: pos.analysisMeta
  }));

  const [activeTab, setActiveTab] = useState<any>(null);
  const [orderBook, setOrderBook] = useState<any[]>([]);
  const [spotBookBids, setSpotBookBids] = useState<any[]>([]);
  const [spotBookAsks, setSpotBookAsks] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (availableContracts.length > 0) {
      const exists = availableContracts.find(c => c.symbol === activeTab?.symbol);
      if (!activeTab || !exists) {
        setActiveTab(availableContracts[0]);
      } else {
        // Update activeTab properties (like pnlRatio) from fresh marketContext
        const fresh = availableContracts.find(c => c.symbol === activeTab.symbol);
        if (fresh) setActiveTab(fresh);
      }
    } else {
      setActiveTab(null);
    }
  }, [marketContext]);

  const fetchOrderBook = async () => {
    if (!activeTab) {
      setOrderBook([]);
      setSpotBookBids([]);
      setSpotBookAsks([]);
      setLoading(false);
      return;
    }

    try {
      const res = await fetch(`/api/order-book/${encodeURIComponent(activeTab.symbol)}`);
      if (!res.ok) throw new Error('No order book data');
      const ct = res.headers.get('content-type');
      if (!ct || !ct.includes('application/json')) throw new Error('Invalid JSON response');
      const data = await res.json();
      
      let cBid = 0;
      const bidData = (data.bids || [])
        .sort((a: any, b: any) => b.price - a.price)
        .map((b: any) => { cBid += b.size; return { price: b.price, bidVol: cBid, askVol: null }; })
        .sort((a: any, b: any) => a.price - b.price);

      let cAsk = 0;
      const askData = (data.asks || [])
        .sort((a: any, b: any) => a.price - b.price)
        .map((a: any) => { cAsk += a.size; return { price: a.price, bidVol: null, askVol: cAsk }; });

      setOrderBook([...bidData, ...askData]);
      
      // Fetch Spot Book if Crypto
      if (activeTab.category === 'crypto' || activeTab.symbol?.includes('ETH') || activeTab.symbol?.includes('BTC') || activeTab.symbol?.includes('SOL')) {
         try {
           const spotRes = await fetch(`/api/spot-book/${encodeURIComponent(activeTab.symbol)}`);
           const spotCt = spotRes.headers.get('content-type');
           if (spotRes.ok && spotCt && spotCt.includes('application/json')) {
              const spotData = await spotRes.json();
              let cSpotBid = 0;
              const sBids = (spotData.bids || []).sort((a:any, b:any) => b.price - a.price).map((b:any) => { cSpotBid += b.size; return { price: b.price, cumSize: cSpotBid }; }).sort((a:any, b:any) => a.price - b.price);
              let cSpotAsk = 0;
              const sAsks = (spotData.asks || []).sort((a:any, b:any) => a.price - b.price).map((a:any) => { cSpotAsk += a.size; return { price: a.price, cumSize: cSpotAsk }; });
              setSpotBookBids(sBids);
              setSpotBookAsks(sAsks);
           }
         } catch(se) { }
      } else {
         setSpotBookBids([]);
         setSpotBookAsks([]);
      }
      
    } catch (e: any) {
      setOrderBook([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchOrderBook();
    const interval = setInterval(fetchOrderBook, 3000);
    return () => clearInterval(interval);
  }, [activeTab?.symbol]);

  const totalBidVol = orderBook.filter(i => i.bidVol !== null).reduce((acc, i) => Math.max(acc, i.bidVol || 0), 0);
  const totalAskVol = orderBook.filter(i => i.askVol !== null).reduce((acc, i) => Math.max(acc, i.askVol || 0), 0);
  const totalVol = totalBidVol + totalAskVol;
  const cumulativeImbalance = totalVol > 0 ? Number((((totalBidVol - totalAskVol) / totalVol) * 100).toFixed(1)) : 0;

  return (
    <div className="crt-grid-panel !p-0 flex flex-col overflow-hidden relative z-10 mt-2">
      <div className="absolute inset-0 heavy-dither-overlay pointer-events-none" />
      
      {/* Active Position Tabs */}
      <div className="flex overflow-x-auto whitespace-nowrap scrollbar-hide crt-border-b bg-black/40 relative z-20">
        {availableContracts.length === 0 ? (
          <div className="px-4 py-3 text-xs font-bold tracking-widest uppercase text-crypto-primary/70 flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-crypto-danger animate-pulse" />
            <span>[NO ACTIVE POSITIONS - AWAITING OPEN TRADES]</span>
          </div>
        ) : (
          availableContracts.map((contract, idx) => {
            const isActive = activeTab?.symbol === contract.symbol;
            return (
              <button
                key={`active-pos-${contract.id}-${idx}`}
                onClick={() => { setActiveTab(contract); setLoading(true); }}
                className={`px-4 py-3 text-xs font-bold tracking-widest uppercase transition-colors flex flex-shrink-0 items-center gap-2.5 crt-border-r max-w-[280px] truncate ${
                  isActive ? 'bg-crypto-danger text-crypto-text shadow-[0_0_12px_rgba(194,59,90,0.4)]' : 'text-crypto-primary opacity-70 hover:opacity-100 hover:bg-[#1a0208]'
                }`}
                title={`${contract.label} (${contract.side} @ $${(contract.entryPrice ?? 0).toFixed(contract.isPerpetual ? (contract.entryPrice < 10 ? 4 : 2) : 2)})`}
              >
                <span className={`px-1.5 py-0.5 text-[10px] font-black crt-border ${
                  contract.side === 'YES' ? 'bg-crypto-success/30 text-crypto-success' : 'bg-crypto-danger/30 text-crypto-danger'
                }`}>
                  {contract.side}
                </span>
                <span className="truncate">[{contract.label || contract.symbol}]</span>
                {contract.isPerpetual && (
                  <span className="px-1 py-0.2 text-[9px] font-black crt-border bg-[#8f73ff30] text-[#e2d5ed]">
                    PERP
                  </span>
                )}
                <span className={`text-[10px] ${contract.pnlRatio >= 0 ? 'text-crypto-success' : 'text-crypto-danger'}`}>
                  {(contract.pnlRatio * 100).toFixed(1)}%
                </span>
                {contract.smartTrailing?.isActive && (
                  <span className="px-1 py-0.2 text-[9px] font-black crt-border bg-crypto-success/20 text-crypto-success animate-pulse" title={`Smart Trail Tier ${contract.smartTrailing.tier} Active`}>
                    T{contract.smartTrailing.tier}
                  </span>
                )}
              </button>
            );
          })
        )}
      </div>

      <div className="p-6 flex flex-col gap-6 relative z-20">
        {!activeTab ? (
          <div className="h-64 flex flex-col items-center justify-center gap-3 border border-crypto-primary/30 bg-black/40 p-6 text-center">
            <div className="w-3 h-3 bg-crypto-danger rounded-full animate-ping" />
            <span className="text-crypto-danger font-mono tracking-widest text-sm font-bold uppercase">
              [NO ACTIVE POSITIONS TO MONITOR]
            </span>
            <span className="text-xs text-crypto-primary opacity-70 max-w-md">
              Orderbook depth monitoring automatically binds to open positions when algorithmic strategy execution places a trade.
            </span>
          </div>
        ) : loading && orderBook.length === 0 ? (
          <div className="h-64 flex items-center justify-center">
            <span className="text-crypto-primary animate-pulse font-mono tracking-widest text-sm">
              INITIATING POSITION DEPTH STREAM...
            </span>
          </div>
        ) : (
          <>
            <div className="flex justify-between items-center flex-wrap gap-2">
              <div className="max-w-full overflow-hidden flex items-center gap-3 flex-wrap">
                <h3 className="font-bold tracking-[0.2em] text-lg flex items-center gap-2 text-crypto-text uppercase">
                  <span>&gt; DEPTH MONITOR</span>
                </h3>
                {activeTab && (
                  <div className="flex items-center gap-2 flex-wrap text-xs">
                    <span className={`px-2 py-0.5 crt-border font-black uppercase ${
                      activeTab.side === 'YES' ? 'bg-crypto-success/20 text-crypto-success' : 'bg-crypto-danger/20 text-crypto-danger'
                    }`}>
                      {activeTab.side}
                    </span>
                    <span className="px-2 py-0.5 crt-border bg-black/40 font-bold text-crypto-primary max-w-full md:max-w-xl truncate">
                      {activeTab.label || activeTab.symbol} @ ${(activeTab.entryPrice ?? 0).toFixed(2)}
                    </span>
                    <span className="px-2 py-0.5 crt-border bg-[#8f73ff15] text-[#e2d5ed] font-mono text-[11px]" title="Capital placed sized to achieve >= $10 profit at expected TP">
                      CAPITAL: ${(activeTab.capitalPlacedUsd || (activeTab.size * (activeTab.entryPrice || 0.5))).toFixed(2)} ({activeTab.size || 0}x)
                    </span>
                    <span className="px-2 py-0.5 crt-border bg-[#8f73ff15] text-crypto-primary font-mono text-[11px]" title="Expected TP target">
                      TARGET: +{((activeTab.expectedTP || activeTab.params?.dynamicTP || 0.10) * 100).toFixed(1)}% (GOAL ${Math.max(10, Math.round(activeTab.targetDollarGoal || activeTab.projectedProfitAtTP || 10)).toFixed(0)})
                    </span>
                    <span className={`px-2 py-0.5 crt-border font-bold ${
                      (activeTab.pnlRatio ?? 0) >= 0 ? 'text-crypto-success bg-crypto-success/10' : 'text-crypto-danger bg-crypto-danger/10'
                    }`}>
                      PnL: {((activeTab.pnlRatio ?? 0) * 100).toFixed(1)}%
                    </span>
                    {activeTab.analysisMeta?.isInverseMetaFlip && (
                      <span className="px-2 py-0.5 crt-border bg-cyan-500/20 text-cyan-400 font-bold flex items-center gap-1 text-[11px]" title={`Meta-model investigated & approved inverse trade: original ${activeTab.analysisMeta.originalSide} win probability was only ${(activeTab.analysisMeta.originalProba * 100).toFixed(0)}%, inverted to ${activeTab.side} with ${(activeTab.analysisMeta.inverseProba * 100).toFixed(0)}% probability`}>
                        <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse" />
                        <span>⚡ INVERSE FLIP</span>
                        <span className="text-white/70 font-mono">({activeTab.analysisMeta.originalSide} {(activeTab.analysisMeta.originalProba * 100).toFixed(0)}% &rarr; {activeTab.side} {(activeTab.analysisMeta.inverseProba * 100).toFixed(0)}%)</span>
                      </span>
                    )}
                    {activeTab.smartTrailing?.isActive ? (
                      <span className="px-2 py-0.5 crt-border bg-crypto-success/20 text-crypto-success font-bold flex items-center gap-1.5" title={activeTab.smartTrailing.statusMessage}>
                        <span className="w-1.5 h-1.5 rounded-full bg-crypto-success animate-pulse" />
                        <span>SMART TRAIL TIER {activeTab.smartTrailing.tier}:</span>
                        <span>LOCKED FLOOR +{((activeTab.smartTrailing.trailingFloorRatio ?? 0) * 100).toFixed(1)}% (+${(activeTab.smartTrailing.lockedProfitUsd ?? 0).toFixed(2)})</span>
                        <span className="text-[#808080]">|</span>
                        <span className="text-crypto-primary">TARGET +{((activeTab.smartTrailing.dynamicTargetRatio ?? 0) * 100).toFixed(1)}% (${(activeTab.smartTrailing.targetDollarGoal ?? 0).toFixed(0)} GOAL)</span>
                      </span>
                    ) : (
                      <span className="px-2 py-0.5 crt-border bg-black/50 text-[#808080] text-[10px]">
                        SMART TRAIL: STANDBY (ACTIVATES @ +10% / $10)
                      </span>
                    )}
                  </div>
                )}
              </div>
            </div>

            <div className="h-[250px] w-full crt-border bg-black/30 p-4 relative">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart margin={{ top: 10, right: 0, left: -20, bottom: 0 }}>
                  <defs>
                    <pattern id="ditherBid" x="0" y="0" width="4" height="4" patternUnits="userSpaceOnUse">
                      <circle cx="1" cy="1" r="1" fill="#e2d5ed" opacity="0.6"/>
                      <circle cx="3" cy="3" r="1" fill="#e2d5ed" opacity="0.6"/>
                    </pattern>
                    <pattern id="ditherAsk" x="0" y="0" width="4" height="4" patternUnits="userSpaceOnUse">
                      <circle cx="1" cy="1" r="1" fill="#c23b5a" opacity="0.6"/>
                      <circle cx="3" cy="3" r="1" fill="#c23b5a" opacity="0.6"/>
                    </pattern>
                  </defs>
                  <CartesianGrid strokeDasharray="2 4" stroke="#c23b5a" strokeOpacity={0.4} vertical={true} horizontal={true} />
                  <XAxis xAxisId="contract" dataKey="price" 
                    stroke="#c23b5a" 
                    tick={{ fill: '#c23b5a', fontSize: 10, fontFamily: 'monospace' }} 
                    tickLine={false} 
                    axisLine={false} 
                    tickFormatter={(val) => val <= 1 ? val.toFixed(2) : val.toFixed(0)} 
                    type="number"
                    domain={['dataMin', 'dataMax']}
                  />
                  <YAxis yAxisId="contract" stroke="#c23b5a" 
                    tick={{ fill: '#c23b5a', fontSize: 10, fontFamily: 'monospace' }} 
                    tickLine={false} 
                    axisLine={false} 
                  />
                  <Tooltip 
                    contentStyle={{ backgroundColor: '#0a0204', border: '1px solid #c23b5a', color: '#e2d5ed', fontSize: '12px', fontFamily: 'monospace' }}
                    labelFormatter={(val: number) => `Price: ${val <= 1 ? '$' + val.toFixed(2) : '$' + val.toFixed(2)}`}
                  />
                  <Area data={orderBook} xAxisId="contract" yAxisId="contract" type="stepAfter" dataKey="bidVol" stroke="#e2d5ed" strokeWidth={2} fillOpacity={1} fill="url(#ditherBid)" />
                  <Area data={orderBook} xAxisId="contract" yAxisId="contract" type="stepAfter" dataKey="askVol" stroke="#c23b5a" strokeWidth={2} fillOpacity={1} fill="url(#ditherAsk)" />
                  <XAxis xAxisId="spot" dataKey="price" type="number" domain={['dataMin', 'dataMax']} hide />
                  <YAxis yAxisId="spot" hide />
                  <Line data={spotBookBids} xAxisId="spot" yAxisId="spot" type="stepAfter" dataKey="cumSize" stroke="#f59e0b" strokeWidth={2} strokeDasharray="4 4" dot={false} fill="none" />
                  <Line data={spotBookAsks} xAxisId="spot" yAxisId="spot" type="stepAfter" dataKey="cumSize" stroke="#f59e0b" strokeWidth={2} strokeDasharray="4 4" dot={false} fill="none" />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
            
            {activeTab && (
              <div className="flex flex-col gap-3 crt-border-t pt-6">
                <div className="flex justify-between items-center text-xs font-bold tracking-widest uppercase">
                  <span className="text-crypto-danger">Sell Wall (-100) [{Math.min(0, cumulativeImbalance).toFixed(1)}]</span>
                  <span className="text-crypto-text">Neutral (0) [Imbalance: {cumulativeImbalance > 0 ? `+${cumulativeImbalance}` : cumulativeImbalance}]</span>
                  <span className="text-crypto-primary">Buy Wall (+100) [{Math.max(0, cumulativeImbalance).toFixed(1)}]</span>
                </div>
                
                <div className="relative w-full h-6 crt-border bg-black/30 flex overflow-hidden">
                  <div className="absolute left-1/2 top-0 bottom-0 w-px bg-crypto-primary z-10" />
                  {cumulativeImbalance > 0 ? (
                    <div 
                      className="absolute left-1/2 h-full dither-bg-light transition-all duration-500 bg-crypto-primary/60" 
                      style={{ width: `${Math.min(50, (cumulativeImbalance / 100) * 50)}%` }}
                    />
                  ) : (
                    <div 
                      className="absolute right-1/2 h-full dither-bg-dark transition-all duration-500 bg-crypto-danger/60" 
                      style={{ width: `${Math.min(50, (Math.abs(cumulativeImbalance) / 100) * 50)}%` }}
                    />
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
