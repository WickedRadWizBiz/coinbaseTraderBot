import React, { useState, useEffect, useRef } from 'react';
import { AlertTriangle, ShieldAlert, CheckCircle2, Loader2, X, Lock, Flame } from 'lucide-react';

interface LiveTradingConfirmationModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirmSuccess: () => void;
  currentKalshiBalance: number;
}

export function LiveTradingConfirmationModal({
  isOpen,
  onClose,
  onConfirmSuccess,
  currentKalshiBalance
}: LiveTradingConfirmationModalProps) {
  const [step, setStep] = useState<'IDLE' | 'ARMED' | 'CONFIRMING' | 'SUCCESS'>('IDLE');
  const [countdown, setCountdown] = useState<number>(4);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  // Reset state when opening or closing
  useEffect(() => {
    if (isOpen) {
      setStep('IDLE');
      setCountdown(4);
      setError(null);
    } else {
      if (timerRef.current) clearInterval(timerRef.current);
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [isOpen]);

  // Countdown timer when ARMED
  useEffect(() => {
    if (step === 'ARMED') {
      setCountdown(4);
      timerRef.current = setInterval(() => {
        setCountdown((prev) => {
          if (prev <= 1) {
            clearInterval(timerRef.current!);
            setStep('IDLE');
            return 4;
          }
          return prev - 1;
        });
      }, 1000);
    } else {
      if (timerRef.current) clearInterval(timerRef.current);
    }

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [step]);

  if (!isOpen) return null;

  const handleConfirmClick = async () => {
    if (step === 'IDLE') {
      // First tap of double-tap sequence inside dialog
      setError(null);
      setStep('ARMED');
      return;
    }

    if (step === 'ARMED') {
      // Second tap confirmed!
      if (timerRef.current) clearInterval(timerRef.current);
      setStep('CONFIRMING');
      setError(null);

      try {
        const res = await fetch('/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            paperTrading: false,
            confirmLiveRisk: true,
            doubleConfirmedInDialog: true
          })
        });

        const data = await res.json();
        if (res.ok && data.success) {
          setStep('SUCCESS');
          setTimeout(() => {
            onConfirmSuccess();
            onClose();
          }, 1200);
        } else {
          setError(data?.message || 'Server rejected live trading authorization.');
          setStep('IDLE');
        }
      } catch (err: any) {
        setError(err?.message || 'Network error authorizing live trading.');
        setStep('IDLE');
      }
    }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/85 backdrop-blur-md animate-fade-in font-mono text-sm">
      <div className="crt-grid-panel relative max-w-lg w-full border-2 border-crypto-danger bg-black/95 p-6 flex flex-col gap-5 shadow-[0_0_40px_rgba(255,59,48,0.4)]">
        
        {/* Header */}
        <div className="flex items-center justify-between border-b border-crypto-danger/50 pb-3">
          <div className="flex items-center gap-2 text-crypto-danger font-bold text-base tracking-wider uppercase">
            <ShieldAlert className="w-6 h-6 shrink-0 animate-pulse text-crypto-danger" />
            <span>AUTHORIZE LIVE KALSHI TRADING</span>
          </div>
          <button 
            onClick={onClose}
            disabled={step === 'CONFIRMING'}
            className="p-1 border border-crypto-danger/40 text-crypto-danger hover:bg-crypto-danger hover:text-white transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        {step === 'SUCCESS' ? (
          <div className="flex flex-col items-center justify-center py-6 gap-3 text-center text-crypto-success">
            <CheckCircle2 className="w-12 h-12 animate-bounce" />
            <div className="font-bold text-base uppercase tracking-widest">LIVE KALSHI POOL AUTHORIZED</div>
            <div className="text-xs text-crypto-text">
              The engine is now operating in Live Mode with your real Kalshi Cash Pool. Real orders are armed for this active session.
            </div>
          </div>
        ) : (
          <>
            <div className="text-crypto-text text-xs leading-relaxed flex flex-col gap-3">
              <div className="bg-crypto-danger/10 border border-crypto-danger/50 p-3 flex items-start gap-2.5">
                <AlertTriangle className="w-5 h-5 text-crypto-danger shrink-0 mt-0.5" />
                <div className="flex flex-col gap-1">
                  <span className="font-bold text-crypto-danger uppercase tracking-wider text-xs">
                    REAL FINANCIAL CAPITAL WARNING
                  </span>
                  <span className="text-[11px] text-white/90 leading-normal">
                    You are switching from simulated Paper Trading to your real <strong>Kalshi USD Cash Pool</strong>. The trading bot will place live orders on the Kalshi prediction exchange with real money.
                  </span>
                </div>
              </div>

              {/* Current Kalshi Balance Callout */}
              <div className="flex items-center justify-between p-3 border border-crypto-primary/40 bg-black/60">
                <div className="flex flex-col">
                  <span className="text-[10px] text-[#808080] uppercase tracking-wider font-bold">
                    Available Kalshi Live Cash:
                  </span>
                  <span className="text-sm font-bold text-crypto-success">
                    ${currentKalshiBalance.toFixed(2)} USD
                  </span>
                </div>
                <div className="text-right flex flex-col">
                  <span className="text-[10px] text-[#808080] uppercase tracking-wider font-bold">
                    Default Policy:
                  </span>
                  <span className="text-[11px] font-bold text-crypto-primary">
                    Always Paper Mode on Reboot
                  </span>
                </div>
              </div>

              {/* Safety Rules Explainer */}
              <ul className="list-disc list-inside space-y-1.5 opacity-90 text-[11px] bg-black/50 p-3 border border-crypto-primary/30">
                <li>
                  <strong className="text-crypto-danger">Double-Tap Required:</strong> To prevent accidental activation, tap the confirmation button below twice within 4 seconds.
                </li>
                <li>
                  <strong className="text-white">Ephemeral Session:</strong> If the server restarts or reboots, live mode is automatically disarmed and reset to Paper Trading.
                </li>
                <li>
                  <strong className="text-crypto-success">Instant Disarm:</strong> You can return to safe Paper Mode at any time with a single tap on the Cash Pool indicator.
                </li>
              </ul>

              {error && (
                <div className="p-2.5 border border-crypto-danger bg-crypto-danger/20 text-crypto-danger text-xs font-bold">
                  {error}
                </div>
              )}
            </div>

            {/* Actions */}
            <div className="flex flex-col sm:flex-row justify-end gap-3 pt-3 border-t border-crypto-primary/30">
              <button
                type="button"
                onClick={onClose}
                disabled={step === 'CONFIRMING'}
                className="px-4 py-2.5 border border-crypto-primary/50 text-crypto-primary hover:bg-crypto-primary/20 text-xs font-bold uppercase tracking-wider transition-colors"
              >
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
                {step === 'CONFIRMING' ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>Engaging Live Trading...</span>
                  </>
                ) : step === 'ARMED' ? (
                  <>
                    <Flame className="w-4 h-4 animate-bounce" />
                    <span>🔴 TAP AGAIN TO CONFIRM LIVE TRADING (2/2) [{countdown}s]</span>
                  </>
                ) : (
                  <>
                    <Lock className="w-4 h-4" />
                    <span>⚠️ TAP TO ARM LIVE TRADING (1/2)</span>
                  </>
                )}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
