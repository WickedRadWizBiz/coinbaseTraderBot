import { useEffect, useMemo, useRef, useState } from 'react';
import { Maximize2, Minimize2, Network } from 'lucide-react';
import { Panel } from './Panel';
import { usePoll } from './usePoll';

interface MapBlock { id: string; label: string; short: string; cols: number; cells: number[]; score: number | null; activity: number; note: string }
interface MapLayer { id: string; label: string; blocks: MapBlock[] }
interface NeuralMap { ts: number; layers: MapLayer[]; links: Array<[string, string, number]> }

// Palettes (pixel colour = weight |value|, faint -> strong), switchable on the page:
//   blend  65% the scattered-pixel palette (teal, green, yellow, orange, red, pink, magenta) and 35% the neon
//          one (electric teal / cyan, neon green, acid yellow, amber, neon red, hot pink, magenta)
//   soft   electric teal as the base tone, then yellow-greens, soft yellow and orange, pinks and magenta
//   neon   full cyberpunk neon
type PaletteId = 'blend' | 'soft' | 'neon';
const PALETTES: Record<PaletteId, { label: string; stops: Array<[number, number, number]> }> = {
  blend: { label: 'Blend 65/35', stops: [[13, 141, 133], [29, 222, 180], [98, 210, 146], [183, 212, 68], [244, 184, 39], [247, 113, 53], [246, 74, 111], [243, 83, 186], [217, 46, 245]] },
  soft: { label: 'Teal + soft neon', stops: [[0, 58, 70], [0, 236, 214], [70, 238, 170], [160, 238, 80], [222, 240, 90], [255, 196, 92], [255, 128, 140], [255, 110, 196], [206, 72, 245]] },
  neon: { label: 'Full neon', stops: [[0, 60, 72], [0, 255, 225], [0, 214, 255], [57, 255, 136], [230, 255, 0], [255, 159, 28], [255, 42, 85], [255, 46, 166], [217, 0, 255]] },
};
let RAMP: Array<[number, number, number]> = PALETTES.blend.stops;
const TEAL = '0,255,225', MAGENTA = '255,0,170';
function ramp(x: number): [number, number, number] {
  const t = Math.max(0, Math.min(0.9999, x)) * (RAMP.length - 1);
  const i = Math.floor(t), f = t - i, a = RAMP[i], b = RAMP[i + 1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}
const scoreColor = (s: number | null) => (s === null ? 'rgba(150,160,175,0.65)' : s >= 0 ? `rgba(57,255,136,${0.55 + 0.45 * Math.min(1, s)})` : `rgba(255,42,85,${0.55 + 0.45 * Math.min(1, -s)})`);

// ---- Square layout -------------------------------------------------------------------------------
// The map is one square screen of N x N equal pixels. Tiers are horizontal bands, top to bottom in the
// order information flows (feeds -> indicator families -> TA network -> SNNs -> decision models -> MLP
// -> traders). A band's sections tile its full width; a tier with more than MAX_ACROSS blocks stacks
// into sub-rows (the 11 indicator families become 6 + 5). Each section's cells are resampled to fill
// its rectangle, so every pixel of the square belongs to some network, and the funnels (the TA network,
// the MLP) span the full width of their band.
const MAX_ACROSS = 6;
/** Relative band height per tier (per sub-row). */
const TIER_WEIGHT: Record<string, number> = { feeds: 1, families: 0.95, tanet: 1.25, snn: 1.1, models: 1, mlp: 1.45, bots: 1 };

interface Section { b: MapBlock; gx: number; gy: number; gw: number; gh: number }

/** Integer sizes that add up to `total` exactly, proportional to `weights`. */
function split(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  let acc = 0, prev = 0;
  return weights.map((w) => { acc += (w / sum) * total; const edge = Math.round(acc); const n = edge - prev; prev = edge; return n; });
}

function squareLayout(map: NeuralMap, N: number): Section[] {
  const rows: Array<{ layer: string; blocks: MapBlock[] }> = [];
  for (const L of map.layers) {
    if (!L.blocks.length) continue;
    const nRows = Math.ceil(L.blocks.length / MAX_ACROSS), per = Math.ceil(L.blocks.length / nRows);
    for (let r = 0; r < nRows; r++) rows.push({ layer: L.id, blocks: L.blocks.slice(r * per, (r + 1) * per) });
  }
  // No gutters: tiers and sections butt against each other, one continuous screen of pixels.
  const heights = split(N, rows.map((r) => TIER_WEIGHT[r.layer] ?? 1));
  const out: Section[] = [];
  let gy = 0;
  rows.forEach((r, ri) => {
    const widths = split(N, r.blocks.map(() => 1));
    let gx = 0;
    r.blocks.forEach((b, bi) => { out.push({ b, gx, gy, gw: widths[bi], gh: heights[ri] }); gx += widths[bi]; });
    gy += heights[ri];
  });
  return out;
}

const PALETTE_KEY = 'neural-map-palette';
function savedPalette(): PaletteId {
  try { const v = localStorage.getItem(PALETTE_KEY); return v && v in PALETTES ? (v as PaletteId) : 'blend'; } catch { return 'blend'; }
}

export function NeuralMapView() {
  const { data, error } = usePoll<NeuralMap>('/neural-map', 3000);
  const [palette, setPalette] = useState<PaletteId>(() => {
    const q = new URLSearchParams(window.location.search).get('palette');
    return q && q in PALETTES ? (q as PaletteId) : savedPalette();
  });
  RAMP = PALETTES[palette].stops;
  const choosePalette = (p: PaletteId) => { setPalette(p); try { localStorage.setItem(PALETTE_KEY, p); } catch { /* ignore */ } };
  const screenRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [side, setSide] = useState(600);
  const [full, setFull] = useState(false);
  const [hover, setHover] = useState<{ s: Section; x: number; y: number } | null>(null);
  // Displayed cell values ease toward each new poll.
  const shown = useRef(new Map<string, Float32Array>());

  // The square: as wide as the card allows and no taller than the screen (the whole screen when full-screen).
  useEffect(() => {
    const fit = () => {
      const el = wrapRef.current;
      if (!el) return;
      const fs = !!document.fullscreenElement;
      const w = fs ? window.innerWidth : el.clientWidth;
      const h = fs ? window.innerHeight : window.innerHeight - 110;
      setSide(Math.max(260, Math.floor(Math.min(w, h))));
    };
    fit();
    const ro = new ResizeObserver(fit);
    if (wrapRef.current) ro.observe(wrapRef.current);
    const onFs = () => { setFull(!!document.fullscreenElement); setTimeout(fit, 50); };
    window.addEventListener('resize', fit);
    document.addEventListener('fullscreenchange', onFs);
    return () => { ro.disconnect(); window.removeEventListener('resize', fit); document.removeEventListener('fullscreenchange', onFs); };
  }, []);

  // Pixel pitch around 6 px.
  const N = useMemo(() => Math.max(56, Math.min(160, Math.round(side / 6))), [side]);
  const sections = useMemo(() => (data ? squareLayout(data, N) : []), [data, N]);

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv || !data || !sections.length) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(side * dpr); cv.height = Math.round(side * dpr);
    cv.style.width = `${side}px`; cv.style.height = `${side}px`;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const pitch = side / N;
    // Whole-pixel edges so neighbouring pixels meet exactly (no seams between them).
    const edge = (k: number) => Math.round(k * pitch);
    const byId = new Map(sections.map((s) => [s.b.id, s]));
    let raf = 0;
    const t0 = performance.now();
    // Glitch bursts: every few seconds a few horizontal strips tear sideways for a moment.
    let glitchUntil = 0, nextGlitch = 1.5 + Math.random() * 2;
    let bands: Array<{ y: number; h: number; dx: number }> = [];
    const vignette = ctx.createRadialGradient(side / 2, side / 2, side * 0.3, side / 2, side / 2, side * 0.75);
    vignette.addColorStop(0, 'rgba(0,0,0,0)'); vignette.addColorStop(1, 'rgba(0,0,0,0.55)');
    const draw = (now: number) => {
      const t = (now - t0) / 1000;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = '#020306'; ctx.fillRect(0, 0, side, side);
      // A pulse sweeping down the tiers (grid rows): the logic flowing toward the traders.
      const wave = ((t % 5) / 5) * (N + 20) - 10;
      for (const s of sections) {
        const { b } = s;
        let cur = shown.current.get(b.id);
        if (!cur || cur.length !== b.cells.length) { cur = Float32Array.from(b.cells); shown.current.set(b.id, cur); }
        for (let i = 0; i < b.cells.length; i++) cur[i] += (b.cells[i] - cur[i]) * 0.06;
        // Every screen pixel gets its own value: the section reads the block's cells in order, wrapping
        // when it has more pixels than cells (no stretched pixels in the wide funnels).
        const n = b.cells.length;
        for (let gy = 0; gy < s.gh; gy++) {
          const dz = (s.gy + gy - wave) / 5;
          const pulse = Math.exp(-(dz * dz)) * (0.2 + 0.6 * b.activity);
          for (let gx = 0; gx < s.gw; gx++) {
            // Scattered (stable) reuse of the cells, so repeats don't line up into stripes.
            const i = n ? ((Math.imul(gy + 1, 73856093) ^ Math.imul(gx + 1, 19349663)) >>> 0) % n : 0;
            const shimmer = 1 + 0.2 * b.activity * Math.sin(t * 2.6 + (s.gx + gx) * 1.31 + (s.gy + gy) * 0.77);
            const m = Math.min(1, Math.abs(cur[i] ?? 0) * shimmer);
            const [r, g, bl] = ramp(m);
            const lum = 0.55 + 0.45 * Math.sqrt(m) + pulse;
            ctx.fillStyle = `rgba(${Math.min(255, r * lum) | 0},${Math.min(255, g * lum) | 0},${Math.min(255, bl * lum) | 0},${Math.min(1, 0.2 + 0.9 * Math.sqrt(m) + pulse * 0.5)})`;
            const X = s.gx + gx, Y = s.gy + gy;
            ctx.fillRect(edge(X), edge(Y), edge(X + 1) - edge(X), edge(Y + 1) - edge(Y));
          }
        }
      }
      // Signal packets travelling down each link (source section -> target section).
      const sz = Math.max(2, pitch * 0.9);
      for (const [a, c, st] of data.links) {
        const A = byId.get(a), B = byId.get(c);
        if (!A || !B) continue;
        const x1 = (A.gx + A.gw / 2) * pitch, y1 = (A.gy + A.gh * 0.7) * pitch, x2 = (B.gx + B.gw / 2) * pitch, y2 = (B.gy + B.gh * 0.3) * pitch;
        const k = st > 0.6 ? 2 : 1;
        for (let j = 0; j < k; j++) {
          const u = (t * (0.15 + 0.5 * st) + j / k + (a.length * 0.137 + c.length * 0.071)) % 1;
          const e = u * u * (3 - 2 * u);
          const [r, g, bl] = ramp(0.35 + 0.65 * st);
          ctx.fillStyle = `rgba(${r | 0},${g | 0},${bl | 0},${0.45 + 0.5 * st})`;
          ctx.fillRect(x1 + (x2 - x1) * e - sz / 2, y1 + (y2 - y1) * u - sz / 2, sz, sz);
        }
      }
      // ---- CRT and glitch pass ----
      // Scanlines.
      ctx.fillStyle = 'rgba(0,0,0,0.28)';
      for (let y = 0; y < side; y += 3) ctx.fillRect(0, y, side, 1);
      // A slow electric-teal refresh band rolling down the screen.
      const roll = ((t * 0.18) % 1.3 - 0.15) * side;
      const rg = ctx.createLinearGradient(0, roll - 40, 0, roll + 40);
      rg.addColorStop(0, `rgba(${TEAL},0)`); rg.addColorStop(0.5, `rgba(${TEAL},0.07)`); rg.addColorStop(1, `rgba(${TEAL},0)`);
      ctx.fillStyle = rg; ctx.fillRect(0, roll - 40, side, 80);
      // Stray pixels flashing.
      for (let k = 0; k < 6; k++) {
        if (Math.random() > 0.5) continue;
        const X = Math.floor(Math.random() * N), Y = Math.floor(Math.random() * N);
        ctx.fillStyle = Math.random() < 0.5 ? `rgba(${TEAL},0.95)` : 'rgba(255,255,255,0.9)';
        ctx.fillRect(edge(X), edge(Y), edge(X + 1) - edge(X), edge(Y + 1) - edge(Y));
      }
      // Tearing strips with cyan / magenta fringes.
      if (t > nextGlitch) {
        glitchUntil = t + 0.07 + Math.random() * 0.18; nextGlitch = t + 1.8 + Math.random() * 3.5;
        bands = Array.from({ length: 2 + Math.floor(Math.random() * 4) }, () => ({ y: Math.random() * side, h: 3 + Math.random() * side * 0.05, dx: (Math.random() < 0.5 ? -1 : 1) * (3 + Math.random() * 18) }));
      }
      if (t < glitchUntil) {
        for (const g of bands) {
          const sy = Math.max(0, Math.round(g.y * dpr)), sh = Math.max(1, Math.round(g.h * dpr));
          if (sy + sh > cv.height) continue;
          ctx.drawImage(cv, 0, sy, cv.width, sh, g.dx, g.y, side, g.h);
          ctx.fillStyle = `rgba(${TEAL},0.16)`; ctx.fillRect(g.dx > 0 ? 0 : side + g.dx, g.y, Math.abs(g.dx), g.h);
          ctx.fillStyle = `rgba(${MAGENTA},0.14)`; ctx.fillRect(0, g.y + g.h - 1, side, 1);
        }
      }
      ctx.fillStyle = vignette; ctx.fillRect(0, 0, side, side);

      // Labels overlaid on each section.
      const font = Math.max(8, Math.min(12, pitch * 1.8));
      ctx.font = `bold ${font}px monospace`; ctx.textBaseline = 'top'; ctx.textAlign = 'left';
      for (const s of sections) {
        const x = edge(s.gx), y = edge(s.gy), w = edge(s.gx + s.gw) - x, h = edge(s.gy + s.gh) - y;
        const sc = scoreColor(s.b.score);
        // No frames between sections; only the one under the pointer is outlined.
        if (hover?.s.b.id === s.b.id) { ctx.strokeStyle = `rgba(${TEAL},0.95)`; ctx.lineWidth = 2; ctx.strokeRect(x + 1, y + 1, w - 2, h - 2); }
        const long = s.b.label.toUpperCase();
        const text = ctx.measureText(long).width + 12 < w ? long : s.b.short;
        const scoreTxt = s.b.score === null ? '' : `${s.b.score >= 0 ? '+' : ''}${Math.round(s.b.score * 100)}`;
        const tw = Math.min(ctx.measureText(text).width, w - 12);
        const sw = scoreTxt ? ctx.measureText(scoreTxt).width : 0;
        const showScore = !!scoreTxt && tw + sw + 22 < w;
        // Label chip: a marker in the performance colour, the name, the score.
        const mk = font - 2;
        ctx.fillStyle = 'rgba(2,6,10,0.82)';
        ctx.fillRect(x + 3, y + 3, mk + 6 + tw + 8 + (showScore ? sw + 8 : 0), font + 5);
        ctx.fillStyle = sc;
        ctx.fillRect(x + 6, y + 6.5, mk, mk);
        // Chromatic label: magenta and cyan ghosts under teal-white text.
        ctx.fillStyle = `rgba(${MAGENTA},0.55)`; ctx.fillText(text, x + 9 + mk - 1, y + 5.5, w - 16 - mk);
        ctx.fillStyle = `rgba(${TEAL},0.55)`; ctx.fillText(text, x + 9 + mk + 1, y + 5.5, w - 16 - mk);
        ctx.fillStyle = 'rgba(214,255,250,0.96)';
        ctx.fillText(text, x + 9 + mk, y + 5.5, w - 16 - mk);
        if (showScore) { ctx.fillStyle = sc; ctx.fillText(scoreTxt, x + 9 + mk + tw + 8, y + 5.5); }
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [sections, data, side, N, hover]);

  const onMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top, pitch = side / N;
    const s = sections.find((q) => x >= q.gx * pitch && x < (q.gx + q.gw) * pitch && y >= q.gy * pitch && y < (q.gy + q.gh) * pitch);
    setHover(s ? { s, x: e.clientX - (screenRef.current?.getBoundingClientRect().left ?? 0), y: e.clientY - (screenRef.current?.getBoundingClientRect().top ?? 0) } : null);
  };

  const toggleFull = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void screenRef.current?.requestFullscreen?.().catch(() => {});
  };

  const ranked = useMemo(() => (data ? data.layers.flatMap((l) => l.blocks).filter((b) => b.score !== null).sort((a, b) => b.score! - a.score!) : []), [data]);

  return (
    <div className="flex flex-col gap-6 w-full max-w-7xl mx-auto pb-24 md:pb-6 relative z-10 text-crypto-primary font-mono text-sm tracking-wider">
      <Panel title={<span className="flex items-center gap-2"><Network className="w-5 h-5" /> Neural Map</span>}
        right={
          <button onClick={toggleFull} className="flex items-center gap-1.5 text-[10px] tracking-widest crt-border px-2 py-1 hover:bg-crypto-danger hover:text-white transition-colors">
            {full ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}{full ? 'EXIT' : 'FULL SCREEN'}
          </button>
        }>
        {error && <div className="text-crypto-danger text-xs mb-2">Link error: {error}</div>}
        <div ref={wrapRef} className="w-full flex justify-center">
          <div ref={screenRef} className="relative bg-[#020306] flex items-center justify-center" style={full ? { width: '100vw', height: '100vh' } : { width: side, height: side, boxShadow: '0 0 0 1px rgba(0,255,225,0.55), 0 0 24px rgba(0,255,225,0.25), 0 0 60px rgba(255,0,170,0.12)' }}>
            {!data ? <div className="text-center animate-pulse">MAPPING NETWORKS...</div> : (
              <canvas ref={canvasRef} onMouseMove={onMove} onMouseLeave={() => setHover(null)} onClick={onMove} className="block" />
            )}
            {hover && (
              <div className="absolute z-20 pointer-events-none crt-border bg-[#0a0204]/95 px-3 py-2 text-[11px] w-[240px] normal-case"
                style={{ left: Math.max(4, Math.min(hover.x + 12, (screenRef.current?.clientWidth ?? side) - 250)), top: Math.max(4, Math.min(hover.y + 14, (screenRef.current?.clientHeight ?? side) - 120)) }}>
                <div className="font-bold uppercase tracking-widest text-crypto-text">{hover.s.b.label}</div>
                <div className="mt-1" style={{ color: scoreColor(hover.s.b.score) }}>{hover.s.b.score === null ? 'no evidence yet' : `performance ${hover.s.b.score >= 0 ? '+' : ''}${(hover.s.b.score * 100).toFixed(0)}`}</div>
                <div className="opacity-80">activity {(hover.s.b.activity * 100).toFixed(0)}%</div>
                <div className="opacity-70 mt-1">{hover.s.b.note}</div>
              </div>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 mt-3 text-[10px] uppercase tracking-widest">
          <span className="opacity-70 mr-1">Palette</span>
          {(Object.keys(PALETTES) as PaletteId[]).map((id) => (
            <button key={id} onClick={() => choosePalette(id)}
              className={`crt-border px-2 py-1 flex items-center gap-2 ${palette === id ? 'bg-crypto-danger text-white' : 'hover:bg-[#1a0208]'}`}>
              <span className="inline-block h-2 w-10" style={{ background: `linear-gradient(90deg, ${PALETTES[id].stops.map((c) => `rgb(${c.join(',')})`).join(',')})` }} />
              {PALETTES[id].label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-4 mt-2 text-[10px] uppercase tracking-widest">
          <span className="flex items-center gap-2">weak
            <span className="inline-block h-2 w-40" style={{ background: `linear-gradient(90deg, ${RAMP.map((c) => `rgb(${c.join(',')})`).join(',')})` }} />strong</span>
          <span className="flex items-center gap-1"><span className="w-3 h-3 inline-block" style={{ background: scoreColor(0.8) }} />performing</span>
          <span className="flex items-center gap-1"><span className="w-3 h-3 inline-block" style={{ background: scoreColor(-0.8) }} />underperforming</span>
          <span className="flex items-center gap-1"><span className="w-3 h-3 inline-block" style={{ background: scoreColor(null) }} />no evidence</span>
          <span className="normal-case tracking-normal opacity-70">Top to bottom: feeds → indicator families → TA network → spiking networks → decision models → MLP → traders. Hover a section for details.</span>
        </div>
      </Panel>
      {ranked.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <Panel title="Leading" scroll="max-h-[260px]">
            {ranked.filter((b) => b.score! > 0).slice(0, 8).map((b) => <RankRow key={b.id} b={b} />)}
            {!ranked.some((b) => b.score! > 0) && <div className="opacity-60 text-xs">[NOTHING AHEAD YET]</div>}
          </Panel>
          <Panel title="Lagging" scroll="max-h-[260px]">
            {[...ranked].reverse().filter((b) => b.score! < 0).slice(0, 8).map((b) => <RankRow key={b.id} b={b} />)}
            {!ranked.some((b) => b.score! < 0) && <div className="opacity-60 text-xs">[NOTHING BEHIND]</div>}
          </Panel>
        </div>
      )}
    </div>
  );
}

function RankRow({ b }: { b: MapBlock }) {
  const s = b.score ?? 0;
  return (
    <div className="flex items-center gap-2 text-[11px] py-1 border-b border-crypto-primary/20">
      <span className="w-40 truncate text-crypto-text">{b.label}</span>
      <div className="relative flex-1 h-2 bg-black/40 crt-border overflow-hidden">
        <div className="absolute h-full" style={{ width: `${Math.min(100, Math.abs(s) * 100)}%`, background: scoreColor(s) }} />
      </div>
      <span className="w-10 text-right" style={{ color: scoreColor(s) }}>{s >= 0 ? '+' : ''}{(s * 100).toFixed(0)}</span>
    </div>
  );
}
