import React, { useState } from 'react';
import { RotateCcw, AlertTriangle, CheckCircle2, Loader2, X } from 'lucide-react';

interface RestartConfirmModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: () => void;
}

export function RestartConfirmModal({ isOpen, onClose, onSuccess }: RestartConfirmModalProps) {
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);

  if (!isOpen) return null;

  const handleConfirmRestart = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/restart', { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        setSuccess(true);
        setTimeout(() => {
          setSuccess(false);
          setLoading(false);
          onClose();
          window.dispatchEvent(new CustomEvent('trade_executed'));
          if (onSuccess) onSuccess();
        }, 1200);
      } else {
        setLoading(false);
      }
    } catch (err) {
      console.error('Restart failed:', err);
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/80 backdrop-blur-md animate-fade-in font-mono text-sm">
      <div className="crt-grid-panel relative max-w-md w-full border-2 border-crypto-danger bg-black/95 p-6 flex flex-col gap-5 shadow-[0_0_30px_rgba(255,50,50,0.3)]">
        
        {/* Header */}
        <div className="flex items-center justify-between border-b border-crypto-danger/50 pb-3">
          <div className="flex items-center gap-2 text-crypto-danger font-bold text-base tracking-wider uppercase">
            <AlertTriangle className="w-5 h-5 shrink-0 animate-pulse" />
            <span>RESTART FRESH INSTANCE</span>
          </div>
          <button 
            onClick={onClose}
            disabled={loading}
            className="p-1 border border-crypto-danger/40 text-crypto-danger hover:bg-crypto-danger hover:text-white transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        {success ? (
          <div className="flex flex-col items-center justify-center py-6 gap-3 text-center text-crypto-success">
            <CheckCircle2 className="w-12 h-12 animate-bounce" />
            <div className="font-bold text-base uppercase tracking-widest">BANKROLL & P/L REBOOTED</div>
            <div className="text-xs text-crypto-text">Bankroll reset to $200.00, P/L & positions cleared. Memory & logs preserved.</div>
          </div>
        ) : (
          <>
            <div className="text-crypto-text text-xs leading-relaxed flex flex-col gap-3">
              <p className="font-bold text-crypto-danger uppercase tracking-wider">
                This action will reset financial metrics & active positions:
              </p>
              <ul className="list-disc list-inside space-y-1 opacity-90 text-[11px] bg-black/50 p-3 border border-crypto-primary/30">
                <li>Reset working bankroll to <strong className="text-crypto-success">$200.00 USD</strong></li>
                <li>Reset <strong className="text-crypto-text">P/L & total equity tracking</strong></li>
                <li>Close & clear all <strong className="text-crypto-text">active paper positions</strong></li>
                <li>Stand down <strong className="text-crypto-text">Capital Preservation Protocol</strong></li>
                <li className="text-crypto-success font-semibold">Preserves <strong className="text-crypto-success">strategy brain memory & historical logs</strong></li>
              </ul>
            </div>

            {/* Actions */}
            <div className="flex justify-end gap-3 pt-2 border-t border-crypto-primary/30">
              <button
                onClick={onClose}
                disabled={loading}
                className="px-4 py-2 border border-crypto-primary/50 text-crypto-primary hover:bg-crypto-primary/20 text-xs font-bold uppercase tracking-wider transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmRestart}
                disabled={loading}
                className="px-4 py-2 border border-crypto-danger bg-crypto-danger text-white hover:bg-crypto-danger/80 text-xs font-bold uppercase tracking-wider transition-colors flex items-center gap-2"
              >
                {loading ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>Resetting Bankroll...</span>
                  </>
                ) : (
                  <>
                    <RotateCcw className="w-4 h-4" />
                    <span>Confirm Fresh Reset</span>
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
