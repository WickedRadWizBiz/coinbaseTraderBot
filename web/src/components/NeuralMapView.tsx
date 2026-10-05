import { useEffect, useMemo, useRef, useState } from 'react';
import { Maximize2, Minimize2, Network } from 'lucide-react';
import { Panel } from './Panel';
import { usePoll } from './usePoll';

interface MapBlock { id: string; label: string; short: string; cols: number; cells: number[]; score: number | null; activity: number; note: string }
interface MapLayer { id: string; label: string; blocks: MapBlock[] }
interface NeuralMap { ts: number; layers: MapLayer[]; links: Array<[string, string, number]> }

// Palette (pixel colour = weight |value|, faint -> strong): 65% "teal + soft neon" and 35% the 65/35 blend of
// the scattered-pixel and neon palettes. Deep teal, electric teal, mint, yellow-green, soft yellow, peach,
// coral pink, pink, magenta.
const RAMP: Array<[number, number, number]> = [
  [5, 87, 92], [10, 231, 202], [80, 228, 162], [168, 229, 76], [230, 220, 72], [252, 167, 78], [252, 109, 130], [251, 101, 192], [210, 63, 245],
];
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

// ---- Signal attraction ------------------------------------------------------------------------------
// Pixels stay scattered, but a block's "agreeing" pixels (same sign as the block's overall reading,
// strongest first) are pulled toward the edge point nearest the block it feeds, and the receiving
// block's agreeing pixels gather at the matching point on its top edge, so bright seams line up along the
// pipeline's real links. The pull is capped at PULL_CAP of the pixels right at the attractor (fading
// with distance) and scales with the link's activity, so most of each block stays scattered.
const PULL_CAP = 0.4;

const hash01 = (a: number, b: number) => (((Math.imul(a + 7, 2654435761) ^ Math.imul(b + 13, 40503)) >>> 0) % 10007) / 10007;
const scatterIndex = (gx: number, gy: number, n: number) => (n ? ((Math.imul(gy + 1, 73856093) ^ Math.imul(gx + 1, 19349663)) >>> 0) % n : 0);

/** Slot -> cell index for every section (recomputed when the data or layout changes). */
function attractionMaps(sections: Section[], links: NeuralMap['links']): Map<string, Int32Array> {
  const byId = new Map(sections.map((s) => [s.b.id, s]));
  const out = new Map<string, Int32Array>();
  for (const s of sections) {
    const n = s.b.cells.length, slots = s.gw * s.gh;
    const map = new Int32Array(slots);
    for (let gy = 0; gy < s.gh; gy++) for (let gx = 0; gx < s.gw; gx++) map[gy * s.gw + gx] = scatterIndex(gx, gy, n);
    // Attractor points: toward the strongest block it feeds (bottom edge) and from the strongest feeding it (top edge).
    const pts: Array<{ x: number; y: number; w: number }> = [];
    const best = (cands: Array<[Section, number]>) => cands.sort((a, b) => b[1] - a[1])[0];
    const down = best(links.filter(([a, c]) => a === s.b.id && (byId.get(c)?.gy ?? -1) > s.gy).map(([, c, w]) => [byId.get(c)!, w] as [Section, number]));
    const up = best(links.filter(([a, c]) => c === s.b.id && (byId.get(a)?.gy ?? 1e9) < s.gy).map(([a, , w]) => [byId.get(a)!, w] as [Section, number]));
    const at = (o: Section) => Math.max(0, Math.min(s.gw - 1, Math.round(o.gx + o.gw / 2 - s.gx)));
    if (down) pts.push({ x: at(down[0]), y: s.gh - 1, w: down[1] });
    if (up) pts.push({ x: at(up[0]), y: 0, w: up[1] });
    if (!pts.length || !n) { out.set(s.b.id, map); continue; }
    // Agreeing cells, strongest first.
    const mean = s.b.cells.reduce((a, v) => a + v, 0);
    const agree = s.b.cells.map((v, i) => [i, Math.sign(v) === Math.sign(mean) || mean === 0 ? Math.abs(v) : 0] as [number, number]).filter(([, a]) => a > 0.05).sort((a, b) => b[1] - a[1]);
    if (!agree.length) { out.set(s.b.id, map); continue; }
    const R = Math.max(4, Math.max(s.gw, s.gh) * 0.6);
    const slotInfo: Array<{ k: number; d: number; w: number }> = [];
    for (let gy = 0; gy < s.gh; gy++) for (let gx = 0; gx < s.gw; gx++) {
      let d = Infinity, w = 0;
      for (const p of pts) { const dd = Math.hypot(gx - p.x, (gy - p.y) * 1.4); if (dd < d) { d = dd; w = p.w; } }
      slotInfo.push({ k: gy * s.gw + gx, d, w });
    }
    slotInfo.sort((a, b) => a.d - b.d);
    slotInfo.forEach((si, rank) => {
      const p = PULL_CAP * Math.max(0.25, Math.min(1, si.w)) * Math.max(0, 1 - si.d / R);
      if (p > 0 && hash01(si.k, s.gx * 131 + s.gy) < p) map[si.k] = agree[rank % agree.length][0];
    });
    out.set(s.b.id, map);
  }
  return out;
}

/** Margin between the heat map and the screen's edge (clears the 12 px rounded corners). */
const SCREEN_INSET = 10;

export function NeuralMapView() {
  const { data, error } = usePoll<NeuralMap>('/neural-map', 3000);
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
      // Inset from the screen's rounded corners by SCREEN_INSET on every side.
      setSide(Math.max(260, Math.floor(Math.min(w, h)) - (fs ? 0 : 4) - 2 * SCREEN_INSET));
    };
    fit();
    const ro = new ResizeObserver(fit);
    if (wrapRef.current) ro.observe(wrapRef.current);
    const onFs = () => { setFull(!!document.fullscreenElement); setTimeout(fit, 50); };
    window.addEventListener('resize', fit);
    document.addEventListener('fullscreenchange', onFs);
    return () => { ro.disconnect(); window.removeEventListener('resize', fit); document.removeEventListener('fullscreenchange', onFs); };
  }, []);

  // The same pixel grid on every screen: the pixels scale with the square (about 6 px on a desktop
  // square, under 3 px on a phone).
  const N = 128;
  const sections = useMemo(() => (data ? squareLayout(data, N) : []), [data, N]);
  const pull = useMemo(() => (data ? attractionMaps(sections, data.links) : new Map<string, Int32Array>()), [sections, data]);
  // Displayed value per screen pixel, eased, so pixels that move under the attraction fade rather than jump.
  const slotShown = useRef(new Map<string, Float32Array>());

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv || !data || !sections.length) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(side * dpr); cv.height = Math.round(side * dpr);
    cv.style.width = `${side}px`; cv.style.height = `${side}px`;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const pitch = side / N, pitchD = pitch * dpr;
    // Pixel edges on whole DEVICE pixels, so neighbouring pixels meet exactly (no seams) at any size.
    const edgeD = (k: number) => Math.round(k * pitchD);
    const edge = (k: number) => edgeD(k) / dpr;
    let raf = 0;
    const t0 = performance.now();
    // Glitch bursts: every few seconds a few horizontal strips tear sideways for a moment.
    let glitchUntil = 0, nextGlitch = 1.5 + Math.random() * 2;
    let bands: Array<{ y: number; h: number; dx: number }> = [];
    const vignette = ctx.createRadialGradient(side / 2, side / 2, side * 0.3, side / 2, side / 2, side * 0.75);
    vignette.addColorStop(0, 'rgba(0,0,0,0)'); vignette.addColorStop(1, 'rgba(0,0,0,0.55)');
    // Halation (thick glass): the frame is shrunk onto two small canvases and laid back over itself with a
    // 'screen' blend, which blurs it on the way up; every pixel's haze is proportional to its own brightness,
    // so white labels bloom most and dark pixels barely.
    const glowA = document.createElement('canvas'), glowB = document.createElement('canvas');
    glowA.width = Math.max(1, Math.round(cv.width / 5)); glowA.height = Math.max(1, Math.round(cv.height / 5));
    glowB.width = Math.max(1, Math.round(cv.width / 14)); glowB.height = Math.max(1, Math.round(cv.height / 14));
    const ga = glowA.getContext('2d')!, gb = glowB.getContext('2d')!;
    ga.imageSmoothingQuality = 'high'; gb.imageSmoothingQuality = 'high';
    const draw = (now: number) => {
      const t = (now - t0) / 1000;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = '#020306'; ctx.fillRect(0, 0, side, side);
      // A pulse sweeping down the tiers (grid rows): the logic flowing toward the traders.
      const wave = ((t % 5) / 5) * (N + 20) - 10;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      for (const s of sections) {
        const { b } = s;
        let cur = shown.current.get(b.id);
        if (!cur || cur.length !== b.cells.length) { cur = Float32Array.from(b.cells); shown.current.set(b.id, cur); }
        for (let i = 0; i < b.cells.length; i++) cur[i] += (b.cells[i] - cur[i]) * 0.06;
        // Every screen pixel gets its own value: the section reads the block's cells in order, wrapping
        // when it has more pixels than cells (no stretched pixels in the wide funnels).
        const n = b.cells.length;
        const map = pull.get(b.id);
        let ss = slotShown.current.get(b.id);
        if (!ss || ss.length !== s.gw * s.gh) { ss = new Float32Array(s.gw * s.gh).fill(-1); slotShown.current.set(b.id, ss); }
        for (let gy = 0; gy < s.gh; gy++) {
          const pulse = 0;
          for (let gx = 0; gx < s.gw; gx++) {
            // Scattered (stable) reuse of the cells, with the signal attraction mixed in (see attractionMaps).
            const k = gy * s.gw + gx;
            const i = map ? map[k] : scatterIndex(gx, gy, n);
            const shimmer = 1 + 0.2 * b.activity * Math.sin(t * 2.6 + (s.gx + gx) * 1.31 + (s.gy + gy) * 0.77);
            const target = Math.min(1, Math.abs(cur[i] ?? 0) * shimmer);
            ss[k] = ss[k] < 0 ? target : ss[k] + (target - ss[k]) * 0.08;
            const m = ss[k];
            const [r, g, bl] = ramp(m);
            const lum = 0.55 + 0.45 * Math.sqrt(m) + pulse;
            ctx.fillStyle = `rgba(${Math.min(255, r * lum) | 0},${Math.min(255, g * lum) | 0},${Math.min(255, bl * lum) | 0},${Math.min(1, 0.2 + 0.9 * Math.sqrt(m) + pulse * 0.5)})`;
            const X = s.gx + gx, Y = s.gy + gy;
            ctx.fillRect(edgeD(X), edgeD(Y), edgeD(X + 1) - edgeD(X), edgeD(Y + 1) - edgeD(Y));
          }
        }
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // ---- CRT and glitch pass ----
      // Scanlines.
      ctx.fillStyle = `rgba(0,0,0,${pitch < 4 ? 0.14 : 0.28})`;
      for (let y = 0; y < side; y += 3) ctx.fillRect(0, y, side, 1);
      // A slow electric-teal refresh band rolling down the screen.
      const roll = ((t * 0.18) % 1.3 - 0.15) * side;
      // Rolling bands (the slow refresh roll and the faster pulse flowing down the tiers), about 10% opacity:
      // a colour-burn layer across the whole band, and a colour-dodge layer masked to the centre of the
      // gradient, so the middle of the band lifts the pixels while its edges deepen them.
      const band = (y: number, half: number) => {
        const burn = ctx.createLinearGradient(0, y - half, 0, y + half);
        burn.addColorStop(0, `rgba(${TEAL},0)`); burn.addColorStop(0.5, `rgba(${TEAL},0.10)`); burn.addColorStop(1, `rgba(${TEAL},0)`);
        ctx.globalCompositeOperation = 'color-burn';
        ctx.fillStyle = burn; ctx.fillRect(0, y - half, side, 2 * half);
        const dodge = ctx.createLinearGradient(0, y - half, 0, y + half);
        dodge.addColorStop(0.32, `rgba(${TEAL},0)`); dodge.addColorStop(0.5, `rgba(${TEAL},0.10)`); dodge.addColorStop(0.68, `rgba(${TEAL},0)`);
        ctx.globalCompositeOperation = 'color-dodge';
        ctx.fillStyle = dodge; ctx.fillRect(0, y - half, side, 2 * half);
        ctx.globalCompositeOperation = 'source-over';
      };
      band(roll, 40);
      band((wave / N) * side, Math.max(18, side * 0.035));
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
      // Halation, then the glass vignette.
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ga.clearRect(0, 0, glowA.width, glowA.height); ga.drawImage(cv, 0, 0, glowA.width, glowA.height);
      gb.clearRect(0, 0, glowB.width, glowB.height); gb.drawImage(glowA, 0, 0, glowB.width, glowB.height);
      ctx.globalCompositeOperation = 'screen';
      ctx.globalAlpha = 0.26; ctx.drawImage(glowA, 0, 0, cv.width, cv.height);
      ctx.globalAlpha = 0.16; ctx.drawImage(glowB, 0, 0, cv.width, cv.height);
      ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = vignette; ctx.fillRect(0, 0, side, side);
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
    <div className="flex flex-col gap-3 w-full max-w-7xl mx-auto pb-24 md:pb-6 relative z-10 text-crypto-primary font-mono text-sm tracking-wider">
      {/* Printed on the chassis above the screen: the label, and the full-screen key. */}
      <div className="flex items-center justify-between gap-3">
        <span className="chassis-label"><Network className="w-4 h-4" /><span className="chassis-print text-sm">Neural Map</span></span>
        <button onClick={toggleFull} className="chassis-key !min-w-0 !flex-row !gap-1.5 !py-1.5 !px-2.5" title={full ? 'Exit full screen' : 'Full screen'}>
          {full ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}<span>{full ? 'Exit' : 'Full'}</span>
        </button>
      </div>
      {/* The screen: the heat map sits inside it with an equal margin on every side, clear of the rounded corners. */}
      <div ref={wrapRef} className="w-full flex justify-center">
        <div ref={screenRef} className="crt-grid-panel !p-0 relative bg-[#020306] flex items-center justify-center" style={full ? { width: '100vw', height: '100vh' } : { width: side + 4 + 2 * SCREEN_INSET, height: side + 4 + 2 * SCREEN_INSET }}>
          {!data ? <div className="text-center animate-pulse">{error ? `LINK ERROR: ${error}` : 'MAPPING NETWORKS...'}</div> : (
            <canvas ref={canvasRef} onMouseMove={onMove} onMouseLeave={() => setHover(null)} onClick={onMove} className="block relative z-10" />
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
      {/* Legend: a screen-printed plastic sticker on the chassis below the screen. */}
      <div className="chassis-sticker flex flex-wrap items-center gap-x-5 gap-y-2 text-[10px] uppercase tracking-widest">
        <span className="flex items-center gap-2">weak
          <span className="inline-block h-2 w-40" style={{ background: `linear-gradient(90deg, ${RAMP.map((c) => `rgb(${c.join(',')})`).join(',')})` }} />strong</span>
        <span className="flex items-center gap-1.5"><span className="w-3 h-3 inline-block" style={{ background: scoreColor(0.8) }} />performing</span>
        <span className="flex items-center gap-1.5"><span className="w-3 h-3 inline-block" style={{ background: scoreColor(-0.8) }} />underperforming</span>
        <span className="flex items-center gap-1.5"><span className="w-3 h-3 inline-block" style={{ background: scoreColor(null) }} />no evidence</span>
        <span className="normal-case tracking-normal opacity-75">Top to bottom: feeds → indicator families → TA network → spiking networks → decision models → MLP → traders. Hover a section for details.</span>
      </div>
      <Panel title="Leading · Lagging">
        <div className="grid grid-cols-2 h-[260px]">
          <div className="crt-scroll pr-3 flex flex-col">
            <div className="text-[10px] uppercase tracking-widest mb-1" style={{ color: scoreColor(0.8) }}>Leading</div>
            {ranked.filter((b) => b.score! > 0).slice(0, 10).map((b) => <RankRow key={b.id} b={b} />)}
            {!ranked.some((b) => b.score! > 0) && <div className="opacity-60 text-xs">[NOTHING AHEAD YET]</div>}
          </div>
          <div className="crt-scroll pl-3 border-l border-crypto-primary/60 flex flex-col">
            <div className="text-[10px] uppercase tracking-widest mb-1" style={{ color: scoreColor(-0.8) }}>Lagging</div>
            {[...ranked].reverse().filter((b) => b.score! < 0).slice(0, 10).map((b) => <RankRow key={b.id} b={b} />)}
            {!ranked.some((b) => b.score! < 0) && <div className="opacity-60 text-xs">[NOTHING BEHIND]</div>}
          </div>
        </div>
      </Panel>
    </div>
  );
}

function RankRow({ b }: { b: MapBlock }) {
  const s = b.score ?? 0;
  return (
    <div className="flex items-center gap-2 text-[11px] py-1 border-b border-crypto-primary/20">
      <span className="flex-1 min-w-0 truncate text-crypto-text">{b.label}</span>
      <div className="relative w-12 sm:w-24 shrink-0 h-2 bg-black/40 crt-border overflow-hidden">
        <div className="absolute h-full" style={{ width: `${Math.min(100, Math.abs(s) * 100)}%`, background: scoreColor(s) }} />
      </div>
      <span className="w-9 shrink-0 text-right" style={{ color: scoreColor(s) }}>{s >= 0 ? '+' : ''}{(s * 100).toFixed(0)}</span>
    </div>
  );
}
