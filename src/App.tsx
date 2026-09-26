import React, { useState, useEffect, lazy, Suspense } from 'react';
import { LayoutDashboard, Settings, TerminalSquare, Maximize2, Brain, RotateCcw, Cpu } from 'lucide-react';
import { DashboardView } from './components/DashboardView';
import { useTradeShake } from './useTradeShake';
import { MetalBackground } from './components/MetalBackground';
import { RestartConfirmModal } from './components/RestartConfirmModal';
import { ErrorBoundary } from './components/ErrorBoundary';

// Robust lazy loading wrapper with automatic fallback reload to prevent client crashes during redeployments or server restarts
const lazyWithRetry = (componentImport: () => Promise<any>) => {
  return lazy(async () => {
    try {
      return await componentImport();
    } catch (error) {
      console.warn("Failed to load neural module chunk. Initiating soft reload to fetch fresh assets...", error);
      // Wait a brief moment to avoid infinite immediate reload loops on persistent offline states
      await new Promise(resolve => setTimeout(resolve, 800));
      window.location.reload();
      return new Promise(() => {}); // Return a pending promise to avoid broken UI state
    }
  });
};

const SettingsView = lazyWithRetry(() => import('./components/SettingsView').then(m => ({ default: m.SettingsView })));
const LogsView = lazyWithRetry(() => import('./components/LogsView').then(m => ({ default: m.LogsView })));
const PatternBrainView = lazyWithRetry(() => import('./components/PatternBrainView').then(m => ({ default: m.PatternBrainView })));
const RetrainingView = lazyWithRetry(() => import('./components/RetrainingView').then(m => ({ default: m.RetrainingView })));

const ViewLoader = () => (
  <div className="flex flex-col items-center justify-center p-12 min-h-[400px] gap-4">
    <div className="relative w-12 h-12">
      <div className="absolute inset-0 rounded-full border-4 border-crypto-danger/20 border-t-crypto-danger animate-spin" />
    </div>
    <div className="text-crypto-danger font-bold text-xs tracking-widest uppercase animate-pulse">
      Loading Neural Modules...
    </div>
  </div>
);

type ViewType = 'dashboard' | 'pattern-brain' | 'retraining' | 'logs' | 'settings';

const SystemLEDs = () => {
  const [active, setActive] = useState(false);

  useEffect(() => {
    let timer: NodeJS.Timeout;
    const handleTrade = () => {
      setActive(true);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setActive(false), 2000);
    };
    window.addEventListener('trade_executed', handleTrade);
    return () => {
      window.removeEventListener('trade_executed', handleTrade);
      if (timer) clearTimeout(timer);
    };
  }, []);
  
  // Random flickering for baseline activity
  useEffect(() => {
    let timeoutId: NodeJS.Timeout;
    const interval = setInterval(() => {
      if (Math.random() > 0.7) {
        setActive(true);
        if (timeoutId) clearTimeout(timeoutId);
        timeoutId = setTimeout(() => setActive(false), Math.random() * 500 + 200);
      }
    }, 3000);
    return () => {
      clearInterval(interval);
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, []);

  return (
    <div className="flex gap-2">
      <div className={`w-3 h-3 border border-[#6b7280] shadow-[inset_0_1px_2px_rgba(0,0,0,0.1),0_1px_1px_rgba(255,255,255,0.4)] ${active ? 'bg-crypto-primary shadow-[0_0_12px_var(--color-crypto-primary)] animate-[led-flicker_0.1s_infinite]' : 'bg-[#f3f4f6] opacity-80'}`}></div>
      <div className={`w-3 h-3 border border-[#6b7280] shadow-[inset_0_1px_2px_rgba(0,0,0,0.1),0_1px_1px_rgba(255,255,255,0.4)] ${active ? 'bg-crypto-danger shadow-[0_0_12px_var(--color-crypto-danger)] animate-[led-flicker_0.15s_infinite]' : 'bg-[#f3f4f6] opacity-80'}`}></div>
      <div className="w-3 h-3 border border-[#6b7280] shadow-[inset_0_1px_2px_rgba(0,0,0,0.1),0_1px_1px_rgba(255,255,255,0.4)] bg-crypto-success shadow-[0_0_8px_var(--color-crypto-success)] animate-[led-flicker_3s_infinite]"></div>
    </div>
  );
};

export default function App() {
  const [currentView, setCurrentView] = useState<ViewType>('dashboard');
  const [isKeyboardExpanded, setIsKeyboardExpanded] = useState(false);
  const [showRestartModal, setShowRestartModal] = useState(false);
  const isShaking = useTradeShake();

  // Background pre-fetch of lazy-loaded secondary modules during system idle time to make tab transitions instantaneous
  useEffect(() => {
    const prefetchModules = () => {
      const triggerPrefetch = () => {
        console.log("[PREFETCH] System idle. Pre-loading secondary neural views in the background...");
        import('./components/SettingsView').catch(() => {});
        import('./components/LogsView').catch(() => {});
        import('./components/PatternBrainView').catch(() => {});
        import('./components/RetrainingView').catch(() => {});
      };

      if ('requestIdleCallback' in window) {
        (window as any).requestIdleCallback(triggerPrefetch);
      } else {
        setTimeout(triggerPrefetch, 2500);
      }
    };

    prefetchModules();
  }, []);

  const handleRestartInstance = () => {
    setShowRestartModal(true);
  };

  useEffect(() => {
    let lastScrollY = window.scrollY;
    const handleScroll = () => {
      const currentScrollY = window.scrollY || document.documentElement.scrollTop || (document.scrollingElement ? document.scrollingElement.scrollTop : 0);
      if (Math.abs(currentScrollY - lastScrollY) > 10) {
        setIsKeyboardExpanded(false); // any scroll -> hide
      }
      lastScrollY = currentScrollY;
    };
    
    // Add multiple listeners to catch all scrolling environments
    window.addEventListener('scroll', handleScroll, { passive: true });
    document.addEventListener('scroll', handleScroll, { passive: true, capture: true });
    return () => {
      window.removeEventListener('scroll', handleScroll);
      document.removeEventListener('scroll', handleScroll, { capture: true });
    };

  }, []);

  return (
    <div className="relative min-h-screen w-full flex flex-col md:flex-row text-crypto-text overflow-x-hidden bg-[#111]">
      <MetalBackground />
      
      <div className={`flex-1 flex flex-col md:flex-row w-full relative z-10 ${isShaking ? "is-shaking" : ""}`}>
        {/* Desktop Sidebar */}
        <aside className="hidden md:flex flex-col w-64 shrink-0 h-screen sticky top-0 border-r-2 border-[#1f2937]/30 shadow-[4px_0_12px_rgba(0,0,0,0.5)] p-4 bg-transparent z-20">
          <div className="flex justify-between items-start mb-4 px-2 relative z-10 w-full">
            <div className="flex flex-col gap-4">
              <div className="inline-block transform -rotate-1 w-[50vw] md:w-[50%]">
                <img src="/nostratech.png?v=transparent" alt="NOSTRATECH" className="w-full h-auto object-contain" />
              </div>
              <p className="text-crypto-danger text-[9px] font-bold tracking-widest leading-tight uppercase pl-1 no-glow">
                Ultra-Intelligent<br/>Qualitative<br/>Predictions Runner
              </p>
            </div>
            <SystemLEDs />
          </div>

          <nav className="flex flex-col gap-4 flex-1 mt-4" id="main-nav">
            <button 
              id="nav-btn-dashboard"
              onClick={() => setCurrentView('dashboard')}
              className={`flex items-center gap-3 px-4 py-3 transition font-medium crt-border ${currentView === 'dashboard' ? 'bg-crypto-danger text-crypto-text' : 'text-crypto-primary hover:bg-[#1a0208]'}`}
            >
              <LayoutDashboard className="w-5 h-5" />
              <span className="tracking-widest text-sm uppercase">Dashboard</span>
            </button>

            <button 
              id="nav-btn-brain"
              onClick={() => setCurrentView('pattern-brain')}
              className={`flex items-center gap-3 px-4 py-3 transition font-medium crt-border ${currentView === 'pattern-brain' ? 'bg-crypto-danger text-crypto-text' : 'text-crypto-primary hover:bg-[#1a0208]'}`}
            >
              <Brain className="w-5 h-5" />
              <span className="tracking-widest text-sm uppercase">Strategy Brain</span>
            </button>

            <button 
              id="nav-btn-retraining"
              onClick={() => setCurrentView('retraining')}
              className={`flex items-center gap-3 px-4 py-3 transition font-medium crt-border ${currentView === 'retraining' ? 'bg-crypto-danger text-crypto-text' : 'text-crypto-primary hover:bg-[#1a0208]'}`}
            >
              <Cpu className="w-5 h-5" />
              <span className="tracking-widest text-sm uppercase">Retraining</span>
            </button>
            
            <button 
              id="nav-btn-logs"
              onClick={() => setCurrentView('logs')}
              className={`flex items-center gap-3 px-4 py-3 transition font-medium crt-border ${currentView === 'logs' ? 'bg-crypto-danger text-crypto-text' : 'text-crypto-primary hover:bg-[#1a0208]'}`}
            >
              <TerminalSquare className="w-5 h-5" />
              <span className="tracking-widest text-sm uppercase">Telemetry</span>
            </button>
            
            <button 
              id="nav-btn-settings"
              onClick={() => setCurrentView('settings')}
              className={`flex items-center gap-3 px-4 py-3 transition font-medium crt-border ${currentView === 'settings' ? 'bg-crypto-danger text-crypto-text' : 'text-crypto-primary hover:bg-[#1a0208]'}`}
            >
              <Settings className="w-5 h-5" />
              <span className="tracking-widest text-sm uppercase">Config</span>
            </button>

            <button 
              id="nav-btn-restart"
              onClick={handleRestartInstance}
              className="flex items-center gap-3 px-4 py-3 transition font-medium crt-border border border-crypto-danger/50 text-crypto-danger hover:bg-crypto-danger hover:text-white mt-auto font-bold uppercase tracking-widest text-xs"
              title="Clear instance and start fresh"
            >
              <RotateCcw className="w-4 h-4 animate-pulse" />
              <span>Restart Fresh</span>
            </button>
          </nav>
        </aside>

        {/* Main Content Area */}
        <main 
          className="flex-1 p-3 sm:p-4 md:p-8 pb-28 md:pb-8 relative z-10 w-full max-w-full overflow-x-hidden"
        >
          <header className="md:hidden flex justify-between items-start gap-2 mb-3 px-1 relative z-10">
            <div className="flex flex-col gap-1">
              <div className="inline-block transform -rotate-1 w-[45vw] max-w-[180px]">
                <img src="/nostratech.png?v=transparent" alt="NOSTRATECH" className="w-full h-auto object-contain" />
              </div>
              <p className="text-crypto-danger text-[8px] font-bold tracking-widest leading-tight uppercase pl-0.5 no-glow">
                Ultra-Intelligent Qualitative Predictions Runner
              </p>
            </div>
            <div className="flex items-center gap-2">
              <SystemLEDs />
            </div>
          </header>

          <ErrorBoundary>
            <Suspense fallback={<ViewLoader />}>
              {currentView === 'dashboard' && <DashboardView />}
              {currentView === 'pattern-brain' && <PatternBrainView />}
              {currentView === 'retraining' && <RetrainingView />}
              {currentView === 'logs' && <LogsView />}
              {currentView === 'settings' && <SettingsView />}
            </Suspense>
          </ErrorBoundary>
              
        </main>
      </div>

      {/* Mobile Fixed Bottom Navigation Bar */}
      <nav 
        id="mobile-bottom-nav"
        className="md:hidden fixed bottom-0 left-0 right-0 z-50 bg-[#121212]/95 backdrop-blur-md border-t border-crypto-primary/50 px-2 py-1.5 flex items-center justify-around shadow-[0_-4px_20px_rgba(0,0,0,0.9)]"
      >
        <button 
          id="mobile-nav-dashboard"
          onClick={() => setCurrentView('dashboard')}
          className={`flex flex-col items-center justify-center py-1 px-2.5 rounded transition-all min-w-[56px] min-h-[44px] ${
            currentView === 'dashboard' 
              ? 'text-white bg-crypto-danger/30 border border-crypto-danger shadow-[0_0_10px_rgba(255,59,48,0.3)]' 
              : 'text-crypto-primary/70 hover:text-crypto-primary'
          }`}
        >
          <LayoutDashboard className="w-5 h-5 mb-0.5" />
          <span className="text-[10px] tracking-wider font-bold uppercase">Dash</span>
        </button>

        <button 
          id="mobile-nav-brain"
          onClick={() => setCurrentView('pattern-brain')}
          className={`flex flex-col items-center justify-center py-1 px-2.5 rounded transition-all min-w-[56px] min-h-[44px] ${
            currentView === 'pattern-brain' 
              ? 'text-white bg-crypto-danger/30 border border-crypto-danger shadow-[0_0_10px_rgba(255,59,48,0.3)]' 
              : 'text-crypto-primary/70 hover:text-crypto-primary'
          }`}
        >
          <Brain className="w-5 h-5 mb-0.5" />
          <span className="text-[10px] tracking-wider font-bold uppercase">Brain</span>
        </button>

        <button 
          id="mobile-nav-retraining"
          onClick={() => setCurrentView('retraining')}
          className={`flex flex-col items-center justify-center py-1 px-2.5 rounded transition-all min-w-[56px] min-h-[44px] ${
            currentView === 'retraining' 
              ? 'text-white bg-crypto-danger/30 border border-crypto-danger shadow-[0_0_10px_rgba(255,59,48,0.3)]' 
              : 'text-crypto-primary/70 hover:text-crypto-primary'
          }`}
        >
          <Cpu className="w-5 h-5 mb-0.5" />
          <span className="text-[10px] tracking-wider font-bold uppercase">Train</span>
        </button>
        
        <button 
          id="mobile-nav-logs"
          onClick={() => setCurrentView('logs')}
          className={`flex flex-col items-center justify-center py-1 px-2.5 rounded transition-all min-w-[56px] min-h-[44px] ${
            currentView === 'logs' 
              ? 'text-white bg-crypto-danger/30 border border-crypto-danger shadow-[0_0_10px_rgba(255,59,48,0.3)]' 
              : 'text-crypto-primary/70 hover:text-crypto-primary'
          }`}
        >
          <TerminalSquare className="w-5 h-5 mb-0.5" />
          <span className="text-[10px] tracking-wider font-bold uppercase">Logs</span>
        </button>
        
        <button 
          id="mobile-nav-settings"
          onClick={() => setCurrentView('settings')}
          className={`flex flex-col items-center justify-center py-1 px-2.5 rounded transition-all min-w-[56px] min-h-[44px] ${
            currentView === 'settings' 
              ? 'text-white bg-crypto-danger/30 border border-crypto-danger shadow-[0_0_10px_rgba(255,59,48,0.3)]' 
              : 'text-crypto-primary/70 hover:text-crypto-primary'
          }`}
        >
          <Settings className="w-5 h-5 mb-0.5" />
          <span className="text-[10px] tracking-wider font-bold uppercase">Config</span>
        </button>
      </nav>

      <RestartConfirmModal
        isOpen={showRestartModal}
        onClose={() => setShowRestartModal(false)}
        onSuccess={() => window.location.reload()}
      />
    </div>
  );
}
