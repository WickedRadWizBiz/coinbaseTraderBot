import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, CheckCircle2, Flame, Loader2, Lock, ShieldAlert, X } from 'lucide-react';
import { api } from '../api';

/**
 * Live trading authorisation (restored from the previous bot): the confirm button must be tapped twice
 * within 4 seconds. On success the server rewrites TRADING_MODE=live in bot.env and restarts the bot; it
 * refuses (and says why) when the live settings would not start, e.g. Kalshi keys missing.
 */
export function LiveTradingConfirmationModal({ isOpen, onClose, onConfirmSuccess, currentKalshiBalance, overrideOn }: {
  isOpen: boolean; onClose: () => void; onConfirmSuccess: () => void; currentKalshiBalance: number | null;
  /** Kill-switch override state (it carries over into live). */
  overrideOn?: boolean;
}) {
  const [step, setStep] = useState<'IDLE' | 'ARMED' | 'CONFIRMING' | 'SUCCESS'>('IDLE');
  const [countdown, setCountdown] = useState(4);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (isOpen) { setStep('IDLE'); setCountdown(4); setError(null); }
    else if (timerRef.current) clearInterval(timerRef.current);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [isOpen]);

  useEffect(() => {
    if (step === 'ARMED') {
      setCountdown(4);
      timerRef.current = setInterval(() => {
        setCountdown((prev) => {
          if (prev <= 1) { clearInterval(timerRef.current!); setStep('IDLE'); return 4; }
          return prev - 1;
        });
      }, 1000);
    } else if (timerRef.current) clearInterval(timerRef.current);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [step]);

  if (!isOpen) return null;

  const handleConfirmClick = async () => {
    if (step === 'IDLE') { setError(null); setStep('ARMED'); return; }
    if (step !== 'ARMED') return;
    if (timerRef.current) clearInterval(timerRef.current);
    setStep('CONFIRMING');
    setError(null);
    try {
      await api('/mode', { method: 'POST', body: JSON.stringify({ mode: 'live', confirm: 'LIVE' }) });
      setStep('SUCCESS');
      setTimeout(() => { onConfirmSuccess(); onClose(); }, 1500);
    } catch (e) {
      setError((e as Error).message || 'Server rejected live trading authorization.');
      setStep('IDLE');
    }
  };

  // Portal to <body>: the CRT cards' flicker animation would otherwise trap a fixed overlay inside the card.
  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/85 backdrop-blur-md font-mono text-sm">
      <div className="crt-grid-panel relative max-w-lg w-full border-2 border-crypto-danger bg-black/95 p-6 flex flex-col gap-5 shadow-[0_0_40px_rgba(255,59,48,0.4)]">
        <div className="absolute inset-0 heavy-dither-overlay pointer-events-none" />
        <div className="relative z-10 flex flex-col gap-5">
          <div className="flex items-center justify-between border-b border-crypto-danger/50 pb-3">
            <div className="flex items-center gap-2 text-crypto-danger font-bold text-base tracking-wider uppercase">
              <ShieldAlert className="w-6 h-6 shrink-0 animate-pulse text-crypto-danger" />
              <span>AUTHORIZE LIVE KALSHI TRADING</span>
            </div>
            <button onClick={onClose} disabled={step === 'CONFIRMING'} className="p-1 border border-crypto-danger/40 text-crypto-danger hover:bg-crypto-danger hover:text-white transition-colors">
              <X className="w-4 h-4" />
            </button>
          </div>

          {step === 'SUCCESS' ? (
            <div className="flex flex-col items-center justify-center py-6 gap-3 text-center text-crypto-success">
              <CheckCircle2 className="w-12 h-12 animate-bounce" />
              <div className="font-bold text-base uppercase tracking-widest">LIVE KALSHI POOL AUTHORIZED</div>
              <div className="text-xs text-crypto-text">The bot is restarting in Live Mode with your real Kalshi Cash Pool. The dashboard reconnects in a few seconds.</div>
            </div>
          ) : (
            <>
              <div className="text-crypto-text text-xs leading-relaxed flex flex-col gap-3">
                <div className="bg-crypto-danger/10 border border-crypto-danger/50 p-3 flex items-start gap-2.5">
                  <AlertTriangle className="w-5 h-5 text-crypto-danger shrink-0 mt-0.5" />
                  <div className="flex flex-col gap-1">
                    <span className="font-bold text-crypto-danger uppercase tracking-wider text-xs">REAL FINANCIAL CAPITAL WARNING</span>
                    <span className="text-[11px] text-white/90 leading-normal">
                      You are switching from simulated Paper Trading to your real <strong>Kalshi USD Cash Pool</strong>. The bot will place live orders on Kalshi (and on perpetuals and tennis where those are enabled) with real money.
                    </span>
                  </div>
                </div>
                <div className="flex items-center justify-between p-3 border border-crypto-primary/40 bg-black/60">
                  <div className="flex flex-col">
                    <span className="text-[10px] text-[#808080] uppercase tracking-wider font-bold">Available Kalshi Cash:</span>
                    <span className="text-sm font-bold text-crypto-success">{currentKalshiBalance === null ? '—' : `$${currentKalshiBalance.toFixed(2)} USD`}</span>
                  </div>
                  <div className="text-right flex flex-col">
                    <span className="text-[10px] text-[#808080] uppercase tracking-wider font-bold">Persistence:</span>
                    <span className="text-[11px] font-bold text-crypto-primary">Stays live across restarts</span>
                  </div>
                </div>
                <ul className="list-disc list-inside space-y-1.5 opacity-90 text-[11px] bg-black/50 p-3 border border-crypto-primary/30">
                  <li><strong className="text-crypto-danger">Double-Tap Required:</strong> tap the confirmation button below twice within 4 seconds.</li>
                  <li><strong className="text-white">Restart:</strong> the bot restarts into live mode (resting paper orders are cancelled first). It needs Kalshi API keys in bot.env; if anything is missing it stays in paper and tells you what.</li>
                  <li><strong className="text-crypto-success">Instant Disarm:</strong> one tap on the cash pool button returns to Paper Mode at any time.</li>
                  <li>
                    <strong className={overrideOn ? 'text-amber-300' : 'text-white'}>Kill-switch override is {overrideOn ? 'ON' : 'OFF'}:</strong>{' '}
                    {overrideOn
                      ? 'the daily loss limit and loss pauses will not stop live trading (size still shrinks with net losses). Flip the chassis switch off first if you want the hard stop.'
                      : 'the daily loss limit stops live trading for the day.'}
                  </li>
                </ul>
                {error && <div className="p-2.5 border border-crypto-danger bg-crypto-danger/20 text-crypto-danger text-xs font-bold normal-case">{error}</div>}
              </div>
              <div className="flex flex-col sm:flex-row justify-end gap-3 pt-3 border-t border-crypto-primary/30">
                <button type="button" onClick={onClose} disabled={step === 'CONFIRMING'} className="px-4 py-2.5 border border-crypto-primary/50 text-crypto-primary hover:bg-crypto-primary/20 text-xs font-bold uppercase tracking-wider transition-colors">
                  Cancel (Remain in Safe Paper Mode)
                </button>
                <button
                  type="button"
                  onClick={handleConfirmClick}
                  disabled={step === 'CONFIRMING'}
                  className={`px-5 py-2.5 border text-xs font-bold uppercase tracking-wider transition-all flex items-center justify-center gap-2 select-none cursor-pointer ${
                    step === 'ARMED'
                      ? 'border-crypto-danger bg-crypto-danger text-white shadow-[0_0_20px_rgba(255,59,48,0.7)] animate-pulse'
                      : 'border-amber-400 bg-amber-400/20 text-amber-300 hover:bg-amber-400 hover:text-black shadow-[0_0_12px_rgba(251,191,36,0.3)]'
                  }`}
                >
                  {step === 'CONFIRMING' ? (<><Loader2 className="w-4 h-4 animate-spin" /><span>Engaging Live Trading...</span></>)
                    : step === 'ARMED' ? (<><Flame className="w-4 h-4 animate-bounce" /><span>🔴 TAP AGAIN TO CONFIRM LIVE TRADING (2/2) [{countdown}s]</span></>)
                    : (<><Lock className="w-4 h-4" /><span>⚠️ TAP TO ARM LIVE TRADING (1/2)</span></>)}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
