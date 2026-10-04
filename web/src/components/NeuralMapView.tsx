import { useEffect, useMemo, useRef, useState } from 'react';
import { Network } from 'lucide-react';
import { Panel } from './Panel';
import { usePoll } from './usePoll';

interface MapBlock { id: string; label: string; short: string; cols: number; cells: number[]; score: number | null; activity: number; note: string }
interface MapLayer { id: string; label: string; blocks: MapBlock[] }
interface NeuralMap { ts: number; layers: MapLayer[]; links: Array<[string, string, number]> }

// Pixel colour = weight (|value|): teal (faint) -> green -> yellow -> orange -> red -> pink -> magenta (strongest).
const RAMP: Array<[number, number, number]> = [
  [20, 184, 166], [52, 211, 153], [250, 204, 21], [251, 146, 60], [239, 68, 68], [244, 114, 182], [217, 70, 239],
];
function ramp(x: number): [number, number, number] {
  const t = Math.max(0, Math.min(0.9999, x)) * (RAMP.length - 1);
  const i = Math.floor(t), f = t - i, a = RAMP[i], b = RAMP[i + 1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}
const scoreColor = (s: number | null) => (s === null ? 'rgba(160,160,170,0.55)' : s >= 0 ? `rgba(52,211,153,${0.45 + 0.55 * Math.min(1, s)})` : `rgba(239,68,68,${0.45 + 0.55 * Math.min(1, -s)})`);

interface Placed { b: MapBlock; layer: string; x: number; y: number; px: number; rows: number; w: number; h: number }

const PAD = 12, GAP = 10, MIN_BLOCK = 50, LAYER_GAP = 30, LABEL_H = 14;

/** Positions of every block for a canvas width (rows wrap when a layer has too many blocks to fit). */
function layout(map: NeuralMap, W: number): { placed: Placed[]; height: number; rowsY: Array<{ label: string; y: number }> } {
  const placed: Placed[] = [];
  const rowsY: Array<{ label: string; y: number }> = [];
  let y = PAD;
  const perRow = Math.max(1, Math.floor((W - 2 * PAD + GAP) / (MIN_BLOCK + GAP)));
  for (const L of map.layers) {
    rowsY.push({ label: L.label, y });
    y += LABEL_H;
    // One block size per layer (a wrapped remainder row keeps the size of the full rows).
    const across = Math.min(L.blocks.length, perRow);
    const wide = L.blocks.some((b) => b.cols > 16);
    const bw = Math.min(wide ? 230 : 112, (W - 2 * PAD - GAP * (across - 1)) / across);
    for (let s = 0; s < L.blocks.length; s += perRow) {
      const chunk = L.blocks.slice(s, s + perRow);
      let rowH = 0;
      const sized = chunk.map((b) => {
        const rows = Math.ceil(b.cells.length / b.cols);
        const px = Math.max(2, Math.floor(bw / b.cols));
        const w = px * b.cols, h = px * rows;
        rowH = Math.max(rowH, h);
        return { b, rows, px, w, h };
      });
      const total = sized.reduce((a, z) => a + z.w, 0) + GAP * (sized.length - 1);
      let x = (W - total) / 2;
      for (const z of sized) { placed.push({ ...z, layer: L.id, x, y }); x += z.w + GAP; }
      y += rowH + 18;
    }
    y += LAYER_GAP - 18;
  }
  return { placed, height: y + PAD, rowsY };
}

export function NeuralMapView() {
  const { data, error } = usePoll<NeuralMap>('/neural-map', 3000);
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(800);
  const [hover, setHover] = useState<{ p: Placed; x: number; y: number } | null>(null);
  // Displayed cell values ease toward each new poll.
  const shown = useRef(new Map<string, Float32Array>());

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.max(280, el.clientWidth)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const geo = useMemo(() => (data ? layout(data, width) : null), [data, width]);

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv || !geo || !data) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(width * dpr); cv.height = Math.round(geo.height * dpr);
    cv.style.width = `${width}px`; cv.style.height = `${geo.height}px`;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const byId = new Map(geo.placed.map((p) => [p.b.id, p]));
    let raf = 0;
    const t0 = performance.now();
    const draw = (now: number) => {
      const t = (now - t0) / 1000;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, geo.height);
      // Scanlines.
      ctx.fillStyle = 'rgba(255,255,255,0.025)';
      for (let y = 0; y < geo.height; y += 3) ctx.fillRect(0, y, width, 1);
      // Layer labels.
      ctx.font = '9px monospace'; ctx.textAlign = 'left'; ctx.fillStyle = 'rgba(155,124,255,0.75)';
      for (const r of geo.rowsY) ctx.fillText(`> ${r.label.toUpperCase()}`, PAD, r.y + 9);
      // Links with packets travelling down them.
      for (const [a, b, s] of data.links) {
        const A = byId.get(a), B = byId.get(b);
        if (!A || !B) continue;
        const x1 = A.x + A.w / 2, y1 = A.y + A.h + 2, x2 = B.x + B.w / 2, y2 = B.y - 2, my = (y1 + y2) / 2;
        ctx.strokeStyle = `rgba(155,124,255,${0.06 + 0.22 * s})`; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.bezierCurveTo(x1, my, x2, my, x2, y2); ctx.stroke();
        const k = s > 0.6 ? 3 : s > 0.25 ? 2 : 1;
        for (let j = 0; j < k; j++) {
          const u = ((t * (0.12 + 0.45 * s)) + j / k + (a.length * 0.137 + b.length * 0.071)) % 1;
          const v = 1 - u;
          const px = v ** 3 * x1 + 3 * v * v * u * x1 + 3 * v * u * u * x2 + u ** 3 * x2;
          const py = v ** 3 * y1 + 3 * v * v * u * my + 3 * v * u * u * my + u ** 3 * y2;
          const [r, g, bl] = ramp(0.25 + 0.75 * s);
          ctx.fillStyle = `rgba(${r | 0},${g | 0},${bl | 0},${0.35 + 0.6 * s})`;
          ctx.fillRect(px - 1.5, py - 1.5, 3, 3);
        }
      }
      // A pulse sweeping down the layers: the logic flowing toward the traders.
      const wave = ((t % 5) / 5) * geo.height;
      for (const p of geo.placed) {
        const { b } = p;
        let cur = shown.current.get(b.id);
        if (!cur || cur.length !== b.cells.length) { cur = Float32Array.from(b.cells); shown.current.set(b.id, cur); }
        const dz = ((p.y + p.h / 2) - wave) / 60;
        const pulse = Math.exp(-(dz * dz)) * (0.25 + 0.6 * b.activity);
        for (let i = 0; i < b.cells.length; i++) {
          cur[i] += (b.cells[i] - cur[i]) * 0.06;
          const shimmer = 1 + 0.18 * b.activity * Math.sin(t * 2.6 + i * 1.73 + p.x * 0.01);
          const m = Math.min(1, Math.abs(cur[i]) * shimmer);
          const [r, g, bl] = ramp(m);
          // Faint weights stay dim teal; strong ones glow. The passing pulse lifts everything it crosses.
          const lum = 0.55 + 0.45 * Math.sqrt(m) + pulse;
          ctx.fillStyle = `rgba(${Math.min(255, r * lum) | 0},${Math.min(255, g * lum) | 0},${Math.min(255, bl * lum) | 0},${Math.min(1, 0.22 + 0.9 * Math.sqrt(m) + pulse * 0.5)})`;
          const cx = p.x + (i % b.cols) * p.px, cy = p.y + Math.floor(i / b.cols) * p.px;
          ctx.fillRect(cx, cy, Math.max(1, p.px - (p.px > 4 ? 1 : 0)), Math.max(1, p.px - (p.px > 4 ? 1 : 0)));
        }
        // Frame (performance), score bar and label.
        const sc = scoreColor(b.score);
        ctx.strokeStyle = sc; ctx.lineWidth = hover?.p.b.id === b.id ? 2 : 1;
        ctx.shadowColor = sc; ctx.shadowBlur = b.score === null ? 0 : 6 * Math.abs(b.score);
        ctx.strokeRect(p.x - 1.5, p.y - 1.5, p.w + 3, p.h + 3);
        ctx.shadowBlur = 0;
        ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(p.x, p.y + p.h + 3, p.w, 3);
        if (b.score !== null) { ctx.fillStyle = sc; const bw = (p.w / 2) * Math.min(1, Math.abs(b.score)); ctx.fillRect(b.score >= 0 ? p.x + p.w / 2 : p.x + p.w / 2 - bw, p.y + p.h + 3, bw, 3); }
        ctx.fillStyle = 'rgba(230,224,255,0.85)'; ctx.font = `${p.w >= 70 ? 9 : 8}px monospace`; ctx.textAlign = 'center';
        const text = p.w >= 90 ? b.label.toUpperCase() : b.short;
        ctx.fillText(text.length * 5.5 > p.w + 10 ? b.short : text, p.x + p.w / 2, p.y + p.h + 15);
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [geo, data, width, hover]);

  const onMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!geo) return;
    const r = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const p = geo.placed.find((q) => x >= q.x - 3 && x <= q.x + q.w + 3 && y >= q.y - 3 && y <= q.y + q.h + 18);
    setHover(p ? { p, x, y } : null);
  };

  const ranked = useMemo(() => (data ? data.layers.flatMap((l) => l.blocks).filter((b) => b.score !== null).sort((a, b) => b.score! - a.score!) : []), [data]);

  return (
    <div className="flex flex-col gap-6 w-full max-w-7xl mx-auto pb-24 md:pb-6 relative z-10 text-crypto-primary font-mono text-sm tracking-wider">
      <Panel title={<span className="flex items-center gap-2"><Network className="w-5 h-5" /> Neural Map</span>}
        right={<span className="text-[10px] tracking-widest opacity-70 normal-case">{data ? `updated ${new Date(data.ts).toLocaleTimeString()}` : ''}</span>}>
        <p className="text-xs opacity-80 normal-case leading-relaxed mb-3">
          Every network in the bot, top to bottom in the order information flows down to the meta-model and the traders. Each pixel is a live input or a trained weight;
          its colour is its strength. The frame and the bar under each block show how that piece is doing: <span className="text-emerald-400">green</span> performing,
          <span className="text-red-400"> red</span> underperforming, grey no evidence yet. Hover a block for details.
        </p>
        {error && <div className="text-crypto-danger text-xs mb-2">Link error: {error}</div>}
        <div ref={wrapRef} className="relative w-full crt-border bg-black/60 overflow-hidden">
          {!data ? <div className="p-10 text-center animate-pulse">MAPPING NETWORKS...</div> : (
            <canvas ref={canvasRef} onMouseMove={onMove} onMouseLeave={() => setHover(null)} onClick={onMove} className="block" />
          )}
          {hover && (
            <div className="absolute z-20 pointer-events-none crt-border bg-[#0a0204]/95 px-3 py-2 text-[11px] max-w-[260px] normal-case"
              style={{ left: Math.min(hover.x + 12, width - 270), top: hover.y + 14 }}>
              <div className="font-bold uppercase tracking-widest text-crypto-text">{hover.p.b.label}</div>
              <div className="mt-1" style={{ color: scoreColor(hover.p.b.score) }}>{hover.p.b.score === null ? 'no evidence yet' : `performance ${hover.p.b.score >= 0 ? '+' : ''}${(hover.p.b.score * 100).toFixed(0)}`}</div>
              <div className="opacity-80">activity {(hover.p.b.activity * 100).toFixed(0)}%</div>
              <div className="opacity-70 mt-1">{hover.p.b.note}</div>
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-4 mt-3 text-[10px] uppercase tracking-widest">
          <span className="flex items-center gap-2">weak
            <span className="inline-block h-2 w-40" style={{ background: `linear-gradient(90deg, ${RAMP.map((c) => `rgb(${c.join(',')})`).join(',')})` }} />strong</span>
          <span className="flex items-center gap-1"><span className="w-3 h-3 inline-block border-2" style={{ borderColor: scoreColor(0.8) }} />performing</span>
          <span className="flex items-center gap-1"><span className="w-3 h-3 inline-block border-2" style={{ borderColor: scoreColor(-0.8) }} />underperforming</span>
          <span className="flex items-center gap-1"><span className="w-3 h-3 inline-block border-2" style={{ borderColor: scoreColor(null) }} />no evidence</span>
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
