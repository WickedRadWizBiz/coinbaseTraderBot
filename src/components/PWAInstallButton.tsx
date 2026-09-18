import React, { useState } from 'react';
import { usePWAInstall } from './usePWAInstall';
import { Download } from 'lucide-react';

export const PWAInstallButton: React.FC = () => {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showIOSGuide, setShowIOSGuide] = useState(false);

  if (isInstalled) {
    return null;
  }

  if (isInstallable) {
    return (
      <button
        onClick={install}
        className="flex items-center justify-center gap-2 w-full rounded-none-lg bg-crypto-danger crt-border px-4 py-2 text-sm font-medium text-crypto-text uppercase tracking-widest font-bold shadow-sm hover:opacity-90 transition"
      >
        <Download className="w-4 h-4" />
        Install App
      </button>
    );
  }

  if (isIOS) {
    return (
      <>
        <button
          onClick={() => setShowIOSGuide(true)}
          className="flex items-center justify-center gap-2 w-full rounded-none-lg border border-gray-600 bg-crypto-card px-4 py-2 text-sm font-medium text-crypto-text uppercase tracking-widest font-bold hover:bg-gray-800 transition"
        >
          <Download className="w-4 h-4" />
          Install on iOS
        </button>

        {showIOSGuide && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
            <div className="w-full max-w-sm rounded-none-xl bg-crypto-card p-6 shadow-xl border border-gray-800">
              <h3 className="text-lg font-semibold text-crypto-text uppercase tracking-widest font-bold">Install on iPhone / iPad</h3>
              <p className="mt-2 text-sm text-gray-300">
                1. Tap the <strong>Share</strong> button in Safari toolbar.<br />
                2. Scroll down and tap <strong>Add to Home Screen</strong>.
              </p>
              <button
                onClick={() => setShowIOSGuide(false)}
                className="mt-6 w-full rounded-none-lg bg-gray-700 py-2 text-sm font-medium text-crypto-text uppercase tracking-widest font-bold hover:bg-gray-600 transition"
              >
                Close
              </button>
            </div>
          </div>
        )}
      </>
    );
  }

  return null;
};
