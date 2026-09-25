import React, { useEffect, useState } from 'react';
import { Key, ShieldCheck, ShieldAlert, RefreshCw, CheckCircle2, AlertTriangle, Eye, EyeOff, Save, ExternalLink } from 'lucide-react';

interface DiagnosticData {
  hasKeyId: boolean;
  keyIdMasked: string;
  hasSecret: boolean;
  secretLength: number;
  privateKeyLoaded: boolean;
  initError: string | null;
  lastApiStatus: {
    success: boolean;
    statusText?: string;
    balance?: number;
    error?: string;
    timestamp?: number;
  } | null;
  isConfigured: boolean;
}

export function KalshiKeyConfigCard({ onBalanceUpdated }: { onBalanceUpdated?: () => void }) {
  const [diagnostic, setDiagnostic] = useState<DiagnosticData | null>(null);
  const [loading, setLoading] = useState(false);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showInputForm, setShowInputForm] = useState(false);
  const [inputKeyId, setInputKeyId] = useState('');
  const [inputSecret, setInputSecret] = useState('');
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [portfolioData, setPortfolioData] = useState<any>(null);
  const [syncing, setSyncing] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);

  const fetchDiagnostic = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/kalshi/diagnostic');
      if (res.ok) {
        const data = await res.json();
        if (data.diagnostic) {
          setDiagnostic(data.diagnostic);
        }
      }
    } catch (err) {
      console.error('Failed to fetch Kalshi diagnostic', err);
    } finally {
      setLoading(false);
    }
  };

  const fetchPortfolio = async () => {
    try {
      const res = await fetch('/api/kalshi/portfolio');
      if (res.ok) {
        const data = await res.json();
        setPortfolioData(data);
      }
    } catch (err) {
      console.error('Failed to fetch Kalshi portfolio', err);
    }
  };

  useEffect(() => {
    fetchDiagnostic();
    fetchPortfolio();
    const interval = setInterval(fetchPortfolio, 10000);
    return () => clearInterval(interval);
  }, []);

  const handleSyncPortfolio = async () => {
    setSyncing(true);
    setFeedback(null);
    try {
      const res = await fetch('/api/kalshi/sync-positions', { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        setFeedback({
          type: 'success',
          message: `Positions synced with Kalshi! Active contracts: ${data.activePositionsCount}, Live Cash: $${(data.liveKalshiCash || 0).toFixed(2)}`
        });
        fetchPortfolio();
        if (onBalanceUpdated) onBalanceUpdated();
      } else {
        setFeedback({ type: 'error', message: data.error || 'Failed to sync with Kalshi' });
      }
    } catch (err: any) {
      setFeedback({ type: 'error', message: err?.message || 'Sync error' });
    } finally {
      setSyncing(false);
    }
  };

  const handleCancelAllOrders = async () => {
    if (!window.confirm('Cancel all resting limit orders on Kalshi?')) return;
    setActionLoading(true);
    try {
      const res = await fetch('/api/kalshi/cancel-all-orders', { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        setFeedback({ type: 'success', message: `Successfully cancelled ${data.cancelledCount} resting orders on Kalshi.` });
        fetchPortfolio();
      } else {
        setFeedback({ type: 'error', message: data.error || 'Failed to cancel orders' });
      }
    } catch (err: any) {
      setFeedback({ type: 'error', message: err?.message || 'Failed to cancel orders' });
    } finally {
      setActionLoading(false);
    }
  };

  const handleCloseAllPositions = async () => {
    if (!window.confirm('Emergency: Dispatch close/sell orders on ALL open Kalshi positions?')) return;
    setActionLoading(true);
    try {
      const res = await fetch('/api/kalshi/close-all-positions', { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        setFeedback({ type: 'success', message: `Dispatched close orders for ${data.closedCount} positions.` });
        fetchPortfolio();
        if (onBalanceUpdated) onBalanceUpdated();
      } else {
        setFeedback({ type: 'error', message: data.error || 'Failed to close positions' });
      }
    } catch (err: any) {
      setFeedback({ type: 'error', message: err?.message || 'Failed to close positions' });
    } finally {
      setActionLoading(false);
    }
  };

  const handleCancelSingleOrder = async (orderId: string) => {
    try {
      const res = await fetch('/api/kalshi/cancel-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId })
      });
      const data = await res.json();
      if (data.success) {
        fetchPortfolio();
      } else {
        setFeedback({ type: 'error', message: data.error || 'Failed to cancel order' });
      }
    } catch (err: any) {
      setFeedback({ type: 'error', message: err?.message || 'Failed to cancel order' });
    }
  };

  const handleTestConnection = async () => {
    setTesting(true);
    setFeedback(null);
    try {
      const res = await fetch('/api/kalshi/test-connection', { method: 'POST' });
      const data = await res.json();
      if (data.diagnostic) {
        setDiagnostic(data.diagnostic);
      }
      if (data.success) {
        setFeedback({
          type: 'success',
          message: `Successfully connected to Kalshi! Real balance: $${(data.balance || 0).toFixed(2)}`
        });
        if (onBalanceUpdated) onBalanceUpdated();
      } else {
        setFeedback({
          type: 'error',
          message: data.error || 'Connection failed. Please check your Key ID and Private Key.'
        });
      }
    } catch (err: any) {
      setFeedback({ type: 'error', message: err?.message || 'Network error testing connection' });
    } finally {
      setTesting(false);
    }
  };

  const handleSaveCredentials = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputKeyId.trim() || !inputSecret.trim()) {
      setFeedback({ type: 'error', message: 'Please enter both the Key ID and the Private Key.' });
      return;
    }

    setSaving(true);
    setFeedback(null);
    try {
      const res = await fetch('/api/kalshi/credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keyId: inputKeyId, secret: inputSecret })
      });
      const data = await res.json();
      if (data.diagnostic) {
        setDiagnostic(data.diagnostic);
      }
      if (data.success) {
        setFeedback({
          type: 'success',
          message: `Saved & Verified! Kalshi Cash Balance: $${(data.balance || 0).toFixed(2)}`
        });
        setShowInputForm(false);
        setInputSecret('');
        if (onBalanceUpdated) onBalanceUpdated();
      } else {
        setFeedback({
          type: 'error',
          message: data.error || 'Saved to environment, but Kalshi authentication returned an error.'
        });
      }
    } catch (err: any) {
      setFeedback({ type: 'error', message: err?.message || 'Failed to save credentials' });
    } finally {
      setSaving(false);
    }
  };

  const isConnected = diagnostic?.lastApiStatus?.success;
  const isKeyLoaded = diagnostic?.privateKeyLoaded;

  return (
    <div className="crt-grid-panel p-4 flex flex-col gap-4 relative overflow-hidden border border-crypto-primary/40 bg-[#8f73ff0a]">
      <div className="absolute inset-0 heavy-dither-overlay pointer-events-none" />

      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 pb-3 border-b border-crypto-primary/30 relative z-10">
        <div className="flex items-center gap-2.5">
          <Key className="w-5 h-5 text-crypto-primary shrink-0" />
          <div>
            <h3 className="text-sm font-bold uppercase tracking-wider text-crypto-text flex items-center gap-2">
              Kalshi Live API Authentication
              {isConnected ? (
                <span className="px-2 py-0.5 text-[9px] bg-crypto-success/20 text-crypto-success border border-crypto-success font-mono font-bold">
                  CONNECTED
                </span>
              ) : isKeyLoaded ? (
                <span className="px-2 py-0.5 text-[9px] bg-yellow-500/20 text-yellow-400 border border-yellow-500/50 font-mono font-bold">
                  KEY LOADED (UNVERIFIED)
                </span>
              ) : (
                <span className="px-2 py-0.5 text-[9px] bg-crypto-danger/20 text-crypto-danger border border-crypto-danger font-mono font-bold">
                  NOT CONFIGURED
                </span>
              )}
            </h3>
            <p className="text-[11px] text-[#909090] mt-0.5">
              RSA-PSS credentials required for real USD predictions pool balance and live order routing.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 self-end sm:self-auto">
          <button
            type="button"
            onClick={handleTestConnection}
            disabled={testing}
            className="px-2.5 py-1.5 text-xs uppercase font-bold tracking-wider bg-crypto-primary text-black hover:bg-white transition-colors flex items-center gap-1.5 disabled:opacity-50"
          >
            {testing ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <ShieldCheck className="w-3.5 h-3.5" />}
            <span>Test Connection</span>
          </button>
        </div>
      </div>

      {/* Diagnostic Overview */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs relative z-10">
        <div className="p-2.5 bg-black/40 border border-crypto-primary/20 flex flex-col gap-1">
          <span className="text-[10px] uppercase text-[#808080] font-bold">Key ID</span>
          <span className="font-mono text-crypto-text font-bold break-all">
            {diagnostic?.hasKeyId ? diagnostic.keyIdMasked : 'MISSING (Not Found)'}
          </span>
        </div>

        <div className="p-2.5 bg-black/40 border border-crypto-primary/20 flex flex-col gap-1">
          <span className="text-[10px] uppercase text-[#808080] font-bold">Private Key Status</span>
          <span className={`font-mono font-bold ${isKeyLoaded ? 'text-crypto-success' : 'text-crypto-danger'}`}>
            {isKeyLoaded ? `Loaded (${diagnostic?.secretLength} bytes)` : 'Not Loaded / Invalid Format'}
          </span>
        </div>

        <div className="p-2.5 bg-black/40 border border-crypto-primary/20 flex flex-col gap-1">
          <span className="text-[10px] uppercase text-[#808080] font-bold">Kalshi Live Cash</span>
          <span className="font-mono text-crypto-text font-bold text-sm">
            {isConnected ? `$${(Number(diagnostic?.lastApiStatus?.balance) || 0).toFixed(2)}` : '$0.00 (Offline)'}
          </span>
        </div>
      </div>

      {/* Error or Diagnostic Message */}
      {(diagnostic?.initError || diagnostic?.lastApiStatus?.error) && (
        <div className="p-3 bg-crypto-danger/10 border border-crypto-danger/40 text-crypto-danger text-xs relative z-10 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <div className="flex flex-col gap-0.5">
            <span className="font-bold uppercase tracking-wider text-[10px]">Authentication Issue:</span>
            <span className="font-mono break-all">{diagnostic?.initError || diagnostic?.lastApiStatus?.error}</span>
          </div>
        </div>
      )}

      {feedback && (
        <div className={`p-3 border text-xs relative z-10 flex items-start gap-2 ${
          feedback.type === 'success' 
            ? 'bg-crypto-success/10 border-crypto-success text-crypto-success' 
            : 'bg-crypto-danger/10 border-crypto-danger text-crypto-danger'
        }`}>
          {feedback.type === 'success' ? <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" /> : <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />}
          <span className="font-mono">{feedback.message}</span>
        </div>
      )}

      {/* Manual Input Form Toggle */}
      <div className="relative z-10 pt-1 flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => setShowInputForm(!showInputForm)}
            className="text-xs uppercase font-bold tracking-wider text-crypto-primary hover:text-white flex items-center gap-1.5 transition-colors"
          >
            <span>{showInputForm ? '▼ Hide Key Entry Form' : '▶ Update / Enter Kalshi Keys in UI'}</span>
          </button>

          {isConnected && (
            <button
              type="button"
              onClick={handleSyncPortfolio}
              disabled={syncing}
              className="text-xs uppercase font-bold tracking-wider text-crypto-accent hover:text-white flex items-center gap-1.5 transition-colors disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${syncing ? 'animate-spin' : ''}`} />
              <span>Force Sync Live Positions & Orders</span>
            </button>
          )}
        </div>

        {/* Live Portfolio Table when connected */}
        {isConnected && portfolioData && (
          <div className="p-3 bg-black/60 border border-crypto-primary/30 flex flex-col gap-3 text-xs">
            <div className="flex items-center justify-between border-b border-crypto-primary/20 pb-2">
              <span className="font-bold uppercase tracking-wider text-crypto-text text-[11px]">
                Kalshi Exchange Live Portfolio
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleCancelAllOrders}
                  disabled={actionLoading}
                  className="px-2 py-1 text-[10px] uppercase font-bold bg-yellow-500/20 text-yellow-400 border border-yellow-500 hover:bg-yellow-500 hover:text-black transition-colors"
                >
                  Cancel All Resting Orders
                </button>
                <button
                  type="button"
                  onClick={handleCloseAllPositions}
                  disabled={actionLoading}
                  className="px-2 py-1 text-[10px] uppercase font-bold bg-crypto-danger/20 text-crypto-danger border border-crypto-danger hover:bg-crypto-danger hover:text-white transition-colors"
                >
                  Close All Open Positions
                </button>
              </div>
            </div>

            {/* Positions */}
            <div className="flex flex-col gap-1.5">
              <span className="text-[10px] uppercase text-[#808080] font-bold">
                Open Exchange Positions ({portfolioData.market_positions?.filter((p: any) => (p.position || p.position_fp) !== 0).length || 0})
              </span>
              {(!portfolioData.market_positions || portfolioData.market_positions.filter((p: any) => (p.position || p.position_fp) !== 0).length === 0) ? (
                <span className="text-[11px] text-[#606060] italic">No active positions open on Kalshi exchange.</span>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {portfolioData.market_positions.filter((p: any) => (p.position || p.position_fp) !== 0).map((p: any, idx: number) => {
                    const posCount = typeof p.position === 'number' ? p.position : (p.position_fp ? parseFloat(p.position_fp) : 0);
                    const side = posCount > 0 ? 'YES' : 'NO';
                    const rawExposure = typeof p.market_exposure_dollars === 'number' 
                      ? p.market_exposure_dollars 
                      : (p.market_exposure_dollars ? parseFloat(p.market_exposure_dollars) : 0);
                    const exposure = rawExposure || (Math.abs(posCount) * 0.50);

                    const rawRealized = typeof p.realized_pnl_dollars === 'number'
                      ? p.realized_pnl_dollars
                      : (p.realized_pnl_dollars ? parseFloat(p.realized_pnl_dollars) : (p.realized_pnl ? p.realized_pnl / 100 : 0));
                    const realized = isNaN(rawRealized) ? 0 : rawRealized;

                    return (
                      <div key={idx} className="p-2 bg-black/80 border border-crypto-primary/20 flex flex-col gap-1 font-mono text-[11px]">
                        <div className="flex items-center justify-between">
                          <span className="font-bold text-crypto-primary">{p.ticker}</span>
                          <span className={`px-1.5 py-0.5 text-[9px] font-bold ${side === 'YES' ? 'bg-crypto-success/20 text-crypto-success' : 'bg-crypto-danger/20 text-crypto-danger'}`}>
                            {side} x{Math.abs(posCount)}
                          </span>
                        </div>
                        <div className="flex items-center justify-between text-[10px] text-[#909090]">
                          <span>Exposure: ${(Number(exposure) || 0).toFixed(2)}</span>
                          <span className={realized >= 0 ? 'text-crypto-success' : 'text-crypto-danger'}>
                            PnL: {realized >= 0 ? '+' : ''}${(Number(realized) || 0).toFixed(2)}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Resting Orders */}
            <div className="flex flex-col gap-1.5 pt-1">
              <span className="text-[10px] uppercase text-[#808080] font-bold">
                Resting Limit Orders ({portfolioData.open_orders?.length || 0})
              </span>
              {(!portfolioData.open_orders || portfolioData.open_orders.length === 0) ? (
                <span className="text-[11px] text-[#606060] italic">No pending limit orders resting on Kalshi orderbook.</span>
              ) : (
                <div className="flex flex-col gap-1">
                  {portfolioData.open_orders.map((ord: any, idx: number) => (
                    <div key={idx} className="p-1.5 bg-black/80 border border-crypto-primary/20 flex items-center justify-between font-mono text-[11px]">
                      <div className="flex items-center gap-2">
                        <span className="text-crypto-primary">{ord.ticker}</span>
                        <span className="text-[10px] text-white uppercase">{ord.action} {ord.side} x{ord.count || ord.order_count}</span>
                        <span className="text-[10px] text-[#909090]">@ {ord.yes_price ? `${ord.yes_price}¢` : (ord.no_price ? `${ord.no_price}¢` : `$${ord.price}`)}</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleCancelSingleOrder(ord.order_id || ord.client_order_id)}
                        className="text-[10px] text-crypto-danger hover:underline font-bold"
                      >
                        Cancel
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {showInputForm && (
          <form onSubmit={handleSaveCredentials} className="p-3 bg-black/60 border border-crypto-primary/40 flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <label className="text-xs uppercase font-bold text-crypto-primary">
                Kalshi API Key ID
              </label>
              <input
                type="text"
                placeholder="e.g. 550e8400-e29b-41d4-a716-446655440000"
                value={inputKeyId}
                onChange={(e) => setInputKeyId(e.target.value)}
                className="w-full bg-black/80 border border-crypto-primary/50 text-crypto-text font-mono text-xs p-2 focus:border-crypto-primary focus:outline-none"
              />
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-xs uppercase font-bold text-crypto-primary">
                Kalshi RSA Private Key (.pem or text)
              </label>
              <textarea
                rows={5}
                placeholder="-----BEGIN RSA PRIVATE KEY-----&#10;MIIEowIBAAKCAQEA...&#10;-----END RSA PRIVATE KEY-----"
                value={inputSecret}
                onChange={(e) => setInputSecret(e.target.value)}
                className="w-full bg-black/80 border border-crypto-primary/50 text-crypto-text font-mono text-[11px] p-2 focus:border-crypto-primary focus:outline-none"
              />
              <span className="text-[10px] text-[#707070]">
                Paste your full RSA private key. The bot will automatically strip extra quotes or formatting issues and write it safely.
              </span>
            </div>

            <div className="flex items-center gap-3 pt-1">
              <button
                type="submit"
                disabled={saving}
                className="px-4 py-2 text-xs uppercase font-bold tracking-wider bg-crypto-success text-black hover:bg-white transition-colors flex items-center gap-1.5 disabled:opacity-50"
              >
                {saving ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                <span>Save & Test Key</span>
              </button>
              <button
                type="button"
                onClick={() => setShowInputForm(false)}
                className="px-3 py-2 text-xs uppercase font-bold tracking-wider bg-black/50 text-[#808080] hover:text-white border border-[#404040]"
              >
                Cancel
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
