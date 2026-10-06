// Adversarial evaluator: before an entry is placed, try to BREAK the case for it. Every attack asks "is
// there a plausible version of the facts under which this trade has no edge after fees?":
//
//  1. noise       the TA / confluence / macro inputs jittered (seeded Monte Carlo); broken if more than
//                 20% of the draws lose the edge. Only applies when the model actually reads those inputs.
//  2. leave-one   each TA / confluence input neutralised in turn; broken if any single indicator carries
//                 the whole edge (remove it and the edge is gone).
//  3. confluence  the signed confluence count must not point against the trade's direction (the side's
//                 exposure to the underlying, from dPdS).
//  4. stress      fair value re-priced with volatility x1.3 and x0.75 and the price moved against the side
//                 by 0.5 and 1 sigma over a minute; broken if any scenario loses the edge.
//  5. uncertainty the edge must exceed the model's own standard error (pStd), when the model reports one.
//  6. tape        no entry into a fast move, or against strongly one-sided order-book pressure.
//  7. ta-net      the TA network (years of historical candles; reliability-weighted, see
//                 bot/strategy/taConviction.ts) must not call the underlying against the trade.
//
// An entry nothing breaks, with real TA or confluence evidence behind it (attack 1, 2 or 3 applied and
// passed, or the TA network agreeing), earns a conviction multiplier in (1, maxBoost]:
// 1 + (maxBoost - 1) x (worst surviving edge / edge) x breadth, so a trade whose edge barely survives the
// attacks gets almost nothing extra, and the more TA / confluence signals agree with it (breadth, the
// net share agreeing) the closer it gets to the full boost. The engine then re-sizes the entry by Kelly with the multiplier (Kelly
// fraction and per-order caps scaled together), capped at maxBoost x the original size. A broken trade, or
// one with no TA / confluence evidence, keeps its normal size: never smaller (that would teach the bot to
// avoid trading), never larger.

export type Side = 'yes' | 'no';
export type AttackStatus = 'pass' | 'fail' | 'na';

export interface AttackResult { name: string; status: AttackStatus; detail: string; worstEdge?: number }

export interface AdversaryVerdict {
  broken: boolean;
  /** TA / confluence evidence was tested and held. */
  evidence: boolean;
  multiplier: number;
  edge: number;
  worstEdge: number;
  attacks: AttackResult[];
}

export interface AdversaryInput {
  side: Side;
  /** Price paid per contract for the side bought, and the fee per contract. */
  cost: number;
  fee: number;
  /** Decision probability of YES. */
  q: number;
  /** The model's features, and its P(YES) for a feature map (fair value held fixed). */
  features: Record<string, number>;
  predict: (f: Record<string, number>) => number;
  /** Feature names the attacks may perturb (TA, confluence, macro, momentum). */
  taFeatures: string[];
  /** +1 when YES gains as the underlying rises, -1 when it gains as it falls, 0 when unclear. */
  direction: number;
  /** Fair value of YES under stress: volatility multiplier, and price moved by `moveSigmas` 1-minute sigmas. */
  fairValue: number;
  stressFairValue: (volMult: number, moveSigmas: number) => number | undefined;
  pStd?: number;
  fastMove: boolean;
  /** Order-book imbalance, + = bid-heavy (pressure up for YES). */
  imbalance?: number;
  seed: number;
  maxBoost?: number;
  /** Net share of TA / confluence signals agreeing with the trade (0..1; default 1 = not used). */
  breadth?: number;
  /** TA network's reliability-weighted direction for the underlying (-1..1), when it has a usable call. */
  taDir?: number;
}

const NOISE_DRAWS = 32;
const NOISE_FAIL_FRAC = 0.2;
const MAX_LEAVE_ONE = 40;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(rand: () => number): number {
  const u = Math.max(1e-12, rand()), v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Seed from a string (ticker + time bucket), so the same decision always gets the same draws. */
export function seedOf(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export function evaluateEntry(x: AdversaryInput): AdversaryVerdict {
  const maxBoost = Math.max(1, Math.min(2, x.maxBoost ?? 2));
  const edgeAt = (qYes: number) => (x.side === 'yes' ? qYes : 1 - qYes) - x.cost - x.fee;
  const edge = edgeAt(x.q);
  const attacks: AttackResult[] = [];
  const sideDir = (x.side === 'yes' ? 1 : -1) * x.direction;
  const base = x.predict(x.features);
  // A change in the model's output carries straight through to the decision probability.
  const qWith = (f: Record<string, number>) => x.q + (x.predict(f) - base);
  const ta = x.taFeatures.filter((k) => Number.isFinite(x.features[k]));

  // 1. Noise.
  {
    const rand = mulberry32(x.seed);
    const edges: number[] = [];
    let moved = 0;
    for (let d = 0; d < NOISE_DRAWS && ta.length; d++) {
      const f = { ...x.features };
      for (const k of ta) { const v = f[k]; f[k] = v + gauss(rand) * (0.5 + 0.25 * Math.abs(v)); }
      const q = qWith(f);
      moved = Math.max(moved, Math.abs(q - x.q));
      edges.push(edgeAt(q));
    }
    if (!ta.length || moved < 1e-4) attacks.push({ name: 'noise', status: 'na', detail: ta.length ? 'model does not read the TA inputs' : 'no TA inputs' });
    else {
      edges.sort((a, b) => a - b);
      const lost = edges.filter((e) => e <= 0).length / edges.length;
      const p10 = edges[Math.floor(edges.length * 0.1)];
      attacks.push({ name: 'noise', status: lost > NOISE_FAIL_FRAC ? 'fail' : 'pass', detail: `${(lost * 100).toFixed(0)}% of ${edges.length} jittered draws lose the edge`, worstEdge: p10 });
    }
  }

  // 2. Leave one out.
  {
    let worst = Infinity, worstK = '', moved = 0;
    for (const k of ta.slice(0, MAX_LEAVE_ONE)) {
      const q = qWith({ ...x.features, [k]: 0 });
      moved = Math.max(moved, Math.abs(q - x.q));
      const e = edgeAt(q);
      if (e < worst) { worst = e; worstK = k; }
    }
    if (!ta.length || moved < 1e-4) attacks.push({ name: 'leave-one', status: 'na', detail: ta.length ? 'model does not read the TA inputs' : 'no TA inputs' });
    else attacks.push({ name: 'leave-one', status: worst <= 0 ? 'fail' : 'pass', detail: worst <= 0 ? `edge rests on ${worstK} alone` : `no single input carries the edge (weakest without ${worstK})`, worstEdge: worst });
  }

  // 3. Confluence direction.
  {
    const c = x.features.conf_count;
    if (!Number.isFinite(c) || c === 0 || sideDir === 0) attacks.push({ name: 'confluence', status: 'na', detail: !Number.isFinite(c) ? 'no confluence reading' : c === 0 ? 'confluence neutral' : 'contract direction unclear' });
    else attacks.push({ name: 'confluence', status: Math.sign(c) === Math.sign(sideDir) ? 'pass' : 'fail', detail: `confluence ${c > 0 ? '+' : ''}${c} ${Math.sign(c) === Math.sign(sideDir) ? 'agrees with' : 'opposes'} the ${x.side.toUpperCase()} side` });
  }

  // 4. Volatility / price stress.
  {
    const adverse = sideDir === 0 ? -1 : -sideDir;
    const scen: [number, number][] = [[1.3, 0], [0.75, 0], [1, 0.5 * adverse], [1, adverse], [1.3, 0.5 * adverse]];
    let worst = Infinity, worstS = '', n = 0;
    for (const [vm, mv] of scen) {
      const fv = x.stressFairValue(vm, sideDir === 0 ? 0 : mv);
      if (fv === undefined || !Number.isFinite(fv)) continue;
      n++;
      const e = edgeAt(x.q + (fv - x.fairValue));
      if (e < worst) { worst = e; worstS = `vol x${vm}${mv ? `, price ${mv > 0 ? '+' : ''}${mv} sigma` : ''}`; }
    }
    if (!n) attacks.push({ name: 'stress', status: 'na', detail: 'could not re-price' });
    else attacks.push({ name: 'stress', status: worst <= 0 ? 'fail' : 'pass', detail: `worst scenario (${worstS}) edge ${worst.toFixed(3)}`, worstEdge: worst });
  }

  // 5. Model uncertainty.
  if (x.pStd !== undefined && Number.isFinite(x.pStd) && x.pStd > 0) attacks.push({ name: 'uncertainty', status: edge > x.pStd ? 'pass' : 'fail', detail: `edge ${edge.toFixed(3)} vs model std ${x.pStd.toFixed(3)}`, worstEdge: edge - x.pStd });
  else attacks.push({ name: 'uncertainty', status: 'na', detail: 'model reports no uncertainty' });

  // 6. Tape.
  {
    const imb = x.imbalance !== undefined && Number.isFinite(x.imbalance) ? x.imbalance * (x.side === 'yes' ? 1 : -1) : undefined;
    const fail = x.fastMove ? 'entering a fast move' : imb !== undefined && imb < -0.5 ? 'order book leans hard against the side' : undefined;
    attacks.push({ name: 'tape', status: fail ? 'fail' : 'pass', detail: fail ?? 'no adverse tape' });
  }

  // 7. TA network.
  {
    const t = x.taDir;
    if (t === undefined || !Number.isFinite(t) || Math.abs(t) < 0.05 || sideDir === 0) attacks.push({ name: 'ta-net', status: 'na', detail: t === undefined ? 'no usable TA network call' : sideDir === 0 ? 'contract direction unclear' : 'TA network neutral' });
    else {
      const agrees = Math.sign(t) === Math.sign(sideDir);
      attacks.push({ name: 'ta-net', status: agrees || Math.abs(t) < 0.2 ? 'pass' : 'fail', detail: `TA network ${t > 0 ? 'bullish' : 'bearish'} (${t.toFixed(2)}) ${agrees ? 'agrees with' : 'against'} the ${x.side.toUpperCase()} side` });
    }
  }

  const broken = edge <= 0 || attacks.some((a) => a.status === 'fail');
  const evidence = attacks.some((a) => (a.name === 'noise' || a.name === 'leave-one' || a.name === 'confluence' || (a.name === 'ta-net' && a.detail.includes('agrees'))) && a.status === 'pass');
  const worsts = attacks.filter((a) => a.status === 'pass' && a.worstEdge !== undefined).map((a) => a.worstEdge!);
  const worstEdge = worsts.length ? Math.min(edge, ...worsts) : edge;
  const breadth = x.breadth === undefined || !Number.isFinite(x.breadth) ? 1 : Math.max(0, Math.min(1, x.breadth));
  const multiplier = !broken && evidence && edge > 0 ? 1 + (maxBoost - 1) * Math.max(0, Math.min(1, worstEdge / edge)) * breadth : 1;
  return { broken, evidence, multiplier: +multiplier.toFixed(3), edge, worstEdge, attacks };
}

/** Feature groups the adversary attacks: the TA library, confluence, macro and momentum readings. */
export const ADVERSARY_GROUPS = new Set(['ta', 'taconf', 'tanet', 'confluence', 'macro', 'momentum']);
