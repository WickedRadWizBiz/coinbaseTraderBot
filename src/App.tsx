import React, { useState, useEffect } from 'react';
import { LayoutDashboard, Settings, TerminalSquare, Maximize2, Brain, RotateCcw, Cpu } from 'lucide-react';
import { DashboardView } from './components/DashboardView';
import { SettingsView } from './components/SettingsView';
import { LogsView } from './components/LogsView';
import { PatternBrainView } from './components/PatternBrainView';
import { RetrainingView } from './components/RetrainingView';
import { useTradeShake } from './useTradeShake';
import { MetalBackground } from './components/MetalBackground';
import { RestartConfirmModal } from './components/RestartConfirmModal';
import { ErrorBoundary } from './components/ErrorBoundary';

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
          className="flex-1 p-4 md:p-8 pb-32 md:pb-8 relative z-10"
          
        >
          <header className="md:hidden flex justify-between items-start gap-2 mb-2 px-2 relative z-10">
            <div className="flex flex-col gap-2">
              <div className="inline-block transform -rotate-1 w-[50vw] md:w-[50%]">
                <img src="/nostratech.png?v=transparent" alt="NOSTRATECH" className="w-full h-auto object-contain" />
              </div>
              <p className="text-crypto-danger text-[9px] font-bold tracking-widest leading-tight uppercase pl-1 no-glow">
                Ultra-Intelligent Qualitative Predictions Runner
              </p>
            </div>
            <SystemLEDs />
          </header>

          <ErrorBoundary>
            {currentView === 'dashboard' && <DashboardView />}
            {currentView === 'pattern-brain' && <PatternBrainView />}
            {currentView === 'retraining' && <RetrainingView />}
            {currentView === 'logs' && <LogsView />}
            {currentView === 'settings' && <SettingsView />}
          </ErrorBoundary>
              
        </main>
      </div>

      {/* Mobile Bottom Navigation (Mechanical Keyboard Tray) */}
      <div 
        className={`md:hidden fixed z-50 transition-all duration-500 ease-[cubic-bezier(0.175,0.885,0.32,1.275)] origin-top-left ${
          isKeyboardExpanded 
            ? 'bottom-6 right-4' 
            : 'bottom-4 right-4 translate-y-[calc(100%-40px)] translate-x-[calc(100%-40px)] rotate-[22deg]'
        }`}
      >
        <div className="bg-[#9ca3af] border-t-2 border-l-2 border-gray-300 border-b-8 border-r-4 border-gray-600 rounded-xl p-2 pt-12 pb-3 shadow-[0_10px_25px_rgba(0,0,0,0.9)] relative flex gap-2">
          
          {/* Toggle Button */}
          <button
            id="mobile-nav-toggle"
            onClick={() => setIsKeyboardExpanded(true)}
            className={`absolute top-2 left-4 w-10 h-10 flex items-center justify-center text-[#6b7280] transition-all duration-500 hover:text-[#4b5563] ${isKeyboardExpanded ? 'opacity-0 pointer-events-none' : 'opacity-100'}`}
            style={{ 
              transform: 'rotate(-22deg)',
              filter: 'drop-shadow(0px 1px 1px rgba(255,255,255,0.8))'
            }}
          >
            <Maximize2 className="w-7 h-7" strokeWidth={2.5} />
          </button>

          <button 
            id="mobile-nav-dashboard"
            onClick={() => setCurrentView('dashboard')}
            className={`mech-key !px-2.5 !py-1.5 !min-w-[55px] ${currentView === 'dashboard' ? 'is-active' : ''}`}
          >
            <LayoutDashboard className="w-5 h-5" />
            <span className="text-[9px] tracking-wider font-black uppercase">Dash</span>
          </button>

          <button 
            id="mobile-nav-brain"
            onClick={() => setCurrentView('pattern-brain')}
            className={`mech-key !px-2.5 !py-1.5 !min-w-[55px] ${currentView === 'pattern-brain' ? 'is-active' : ''}`}
          >
            <Brain className="w-5 h-5" />
            <span className="text-[9px] tracking-wider font-black uppercase">Brain</span>
          </button>

          <button 
            id="mobile-nav-retraining"
            onClick={() => setCurrentView('retraining')}
            className={`mech-key !px-2.5 !py-1.5 !min-w-[55px] ${currentView === 'retraining' ? 'is-active' : ''}`}
          >
            <Cpu className="w-5 h-5" />
            <span className="text-[9px] tracking-wider font-black uppercase">Train</span>
          </button>
          
          <button 
            id="mobile-nav-logs"
            onClick={() => setCurrentView('logs')}
            className={`mech-key !px-2.5 !py-1.5 !min-w-[55px] ${currentView === 'logs' ? 'is-active' : ''}`}
          >
            <TerminalSquare className="w-5 h-5" />
            <span className="text-[9px] tracking-wider font-black uppercase">Logs</span>
          </button>
          
          <button 
            id="mobile-nav-settings"
            onClick={() => setCurrentView('settings')}
            className={`mech-key !px-2.5 !py-1.5 !min-w-[55px] ${currentView === 'settings' ? 'is-active' : ''}`}
          >
            <Settings className="w-5 h-5" />
            <span className="text-[9px] tracking-wider font-black uppercase">Cfg</span>
          </button>
        </div>
      </div>

      <RestartConfirmModal
        isOpen={showRestartModal}
        onClose={() => setShowRestartModal(false)}
      />
    </div>
  );
}
