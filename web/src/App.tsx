import { useEffect, useState } from 'react';
import { Brain, LayoutDashboard, LogOut, Network, TerminalSquare } from 'lucide-react';
import { authRequired, getToken, setToken } from './api';
import { DashboardView } from './components/DashboardView';
import { MetalBackground } from './components/MetalBackground';
import { ModelView } from './components/ModelView';
import { NeuralMapView } from './components/NeuralMapView';
import { TelemetryView } from './components/TelemetryView';
import { useTradeShake } from './useTradeShake';

type ViewType = 'dashboard' | 'model' | 'map' | 'telemetry';

const SystemLEDs = () => {
  const [active, setActive] = useState(false);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const onTrade = () => {
      setActive(true);
      clearTimeout(timer);
      timer = setTimeout(() => setActive(false), 2000);
    };
    window.addEventListener('trade_executed', onTrade);
    return () => { window.removeEventListener('trade_executed', onTrade); clearTimeout(timer); };
  }, []);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout>;
    const id = setInterval(() => {
      if (Math.random() > 0.7) {
        setActive(true);
        clearTimeout(t);
        t = setTimeout(() => setActive(false), Math.random() * 500 + 200);
      }
    }, 3000);
    return () => { clearInterval(id); clearTimeout(t); };
  }, []);
  return (
    <div className="flex gap-2">
      <div className={`w-3 h-3 border border-[#6b7280] shadow-[inset_0_1px_2px_rgba(0,0,0,0.1),0_1px_1px_rgba(255,255,255,0.4)] ${active ? 'bg-crypto-primary shadow-[0_0_12px_var(--color-crypto-primary)] animate-[led-flicker_0.1s_infinite]' : 'bg-[#f3f4f6] opacity-80'}`}></div>
      <div className={`w-3 h-3 border border-[#6b7280] shadow-[inset_0_1px_2px_rgba(0,0,0,0.1),0_1px_1px_rgba(255,255,255,0.4)] ${active ? 'bg-crypto-danger shadow-[0_0_12px_var(--color-crypto-danger)] animate-[led-flicker_0.15s_infinite]' : 'bg-[#f3f4f6] opacity-80'}`}></div>
      <div className="w-3 h-3 border border-[#6b7280] shadow-[inset_0_1px_2px_rgba(0,0,0,0.1),0_1px_1px_rgba(255,255,255,0.4)] bg-crypto-success shadow-[0_0_8px_var(--color-crypto-success)] animate-[led-flicker_3s_infinite]"></div>
    </div>
  );
};

const NAV: Array<{ id: ViewType; label: string; short: string; Icon: typeof LayoutDashboard }> = [
  { id: 'dashboard', label: 'Dashboard', short: 'Dash', Icon: LayoutDashboard },
  { id: 'model', label: 'Strategy Brain', short: 'Brain', Icon: Brain },
  { id: 'map', label: 'Neural Map', short: 'Map', Icon: Network },
  { id: 'telemetry', label: 'Telemetry', short: 'Logs', Icon: TerminalSquare },
];

function Login() {
  const [draft, setDraft] = useState('');
  return (
    <div className="flex items-center justify-center min-h-[70vh] w-full">
      <form
        className="crt-grid-panel w-full max-w-md flex flex-col gap-4 p-6 text-crypto-primary font-mono text-sm tracking-wider"
        onSubmit={(e) => { e.preventDefault(); setToken(draft.trim()); }}
      >
        <div className="absolute inset-0 heavy-dither-overlay pointer-events-none" />
        <div className="relative z-10 flex flex-col gap-4">
          <h3 className="font-bold tracking-[0.2em] text-lg uppercase text-crypto-text border-b border-crypto-primary pb-2">&gt; Secure Access</h3>
          <p className="text-xs opacity-80 normal-case">Enter the dashboard password (DASHBOARD_PASSWORD). It is kept only for this browser tab.</p>
          <input
            type="password"
            autoComplete="off"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="PASSWORD"
            className="crt-border bg-black/50 px-3 py-2 text-crypto-text outline-none focus:border-crypto-danger"
          />
          <button type="submit" className="flat-btn self-start">Connect</button>
        </div>
      </form>
    </div>
  );
}

export default function App() {
  const [view, setView] = useState<ViewType>('dashboard');
  const [token, setTok] = useState(getToken());
  // null while checking; false = the bot has no password, so there is no login screen.
  const [needLogin, setNeedLogin] = useState<boolean | null>(null);
  const isShaking = useTradeShake();
  useEffect(() => { void authRequired().then(setNeedLogin); }, []);
  const unlocked = needLogin === false || (needLogin === true && !!token);

  useEffect(() => {
    // A rejected request clears the token: re-check (a password may have been set since the page loaded).
    const onChange = () => { setTok(getToken()); void authRequired().then(setNeedLogin); };
    window.addEventListener('token_changed', onChange);
    return () => window.removeEventListener('token_changed', onChange);
  }, []);

  const navBtn = (id: ViewType, label: string, Icon: typeof LayoutDashboard) => (
    <button
      key={id}
      onClick={() => setView(id)}
      className={`flex items-center gap-3 px-4 py-3 transition font-medium crt-border ${view === id ? 'bg-crypto-danger text-crypto-text' : 'text-crypto-primary hover:bg-[#1a0208]'}`}
    >
      <Icon className="w-5 h-5" />
      <span className="tracking-widest text-sm uppercase">{label}</span>
    </button>
  );

  return (
    <div className="relative min-h-screen w-full flex flex-col md:flex-row text-crypto-text overflow-x-hidden bg-[#111]">
      <MetalBackground />

      <div className={`flex-1 flex flex-col md:flex-row w-full relative z-10 ${isShaking ? 'is-shaking' : ''}`}>
        <aside className="hidden md:flex flex-col w-64 shrink-0 h-screen sticky top-0 border-r-2 border-[#1f2937]/30 shadow-[4px_0_12px_rgba(0,0,0,0.5)] p-4 bg-transparent z-20">
          <div className="flex justify-between items-start mb-4 px-2 relative z-10 w-full">
            <div className="flex flex-col gap-4">
              <div className="inline-block transform -rotate-1 w-[50vw] md:w-[50%]">
                <img src="/nostratech.png?v=transparent" alt="NOSTRATECH" className="w-full h-auto object-contain" />
              </div>
              <p className="text-crypto-danger text-[9px] font-bold tracking-widest leading-tight uppercase pl-1 no-glow">
                Ultra-Intelligent<br />Qualitative<br />Predictions Runner
              </p>
            </div>
            <SystemLEDs />
          </div>
          <nav className="flex flex-col gap-4 flex-1 mt-4" id="main-nav">
            {NAV.map((n) => navBtn(n.id, n.label, n.Icon))}
            {needLogin && token && (
              <button
                onClick={() => setToken('')}
                className="flex items-center gap-3 px-4 py-3 transition font-medium crt-border border border-crypto-danger/50 text-crypto-danger hover:bg-crypto-danger hover:text-white mt-auto font-bold uppercase tracking-widest text-xs"
              >
                <LogOut className="w-4 h-4" />
                <span>Lock Console</span>
              </button>
            )}
          </nav>
        </aside>

        <main className="flex-1 p-3 sm:p-4 md:p-8 pb-28 md:pb-8 relative z-10 w-full max-w-full overflow-x-hidden">
          <header className="md:hidden flex justify-between items-start gap-2 mb-3 px-1 relative z-10">
            <div className="flex flex-col gap-1">
              <div className="inline-block transform -rotate-1 w-[45vw] max-w-[180px]">
                <img src="/nostratech.png?v=transparent" alt="NOSTRATECH" className="w-full h-auto object-contain" />
              </div>
              <p className="text-crypto-danger text-[8px] font-bold tracking-widest leading-tight uppercase pl-0.5 no-glow">
                Ultra-Intelligent Qualitative Predictions Runner
              </p>
            </div>
            <SystemLEDs />
          </header>

          {needLogin === null ? null : !unlocked ? <Login /> : (
            <>
              {view === 'dashboard' && <DashboardView />}
              {view === 'model' && <ModelView />}
              {view === 'map' && <NeuralMapView />}
              {view === 'telemetry' && <TelemetryView />}
            </>
          )}
        </main>
      </div>

      {unlocked && (
        <nav className="md:hidden fixed bottom-0 left-0 right-0 z-50 bg-[#121212]/95 backdrop-blur-md border-t border-crypto-primary/50 px-2 py-1.5 flex items-center justify-around shadow-[0_-4px_20px_rgba(0,0,0,0.9)]">
          {NAV.map(({ id, short, Icon }) => (
            <button
              key={id}
              onClick={() => setView(id)}
              className={`flex flex-col items-center justify-center py-1 px-2.5 rounded transition-all min-w-[56px] min-h-[44px] ${
                view === id ? 'text-white bg-crypto-danger/30 border border-crypto-danger shadow-[0_0_10px_rgba(255,59,48,0.3)]' : 'text-crypto-primary/70 hover:text-crypto-primary'
              }`}
            >
              <Icon className="w-5 h-5 mb-0.5" />
              <span className="text-[10px] tracking-wider font-bold uppercase">{short}</span>
            </button>
          ))}
        </nav>
      )}
    </div>
  );
}
