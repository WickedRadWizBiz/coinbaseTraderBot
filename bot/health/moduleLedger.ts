// Module ledger: one row per adaptive part of the bot (pricing models, regime weights, gates, sizing, exits, feeds), so
// what is on, what is only watched, what has passed its validation, what it has earned and what is stale reads in one
// place instead of across the whole /api/status body (phase 0 of the dynamic-scaling plan, Oct 28).
//
// Each row:
//   state      on (it changes prices, sizes or orders now) | shadow (scored, changes nothing) | off | benched (it was
//              on and its results took it out)
//   validated  passed its own held-out check (null: the part has none)
//   score      the part's own running measure, labelled with what it measures (log loss saved a contract against the
//              price without it, dollars against holding to settlement, size multiplier ...), and how many results
//   flags      what keeps the part from doing its job: stale data, a paper-only setting live would not have, a
//              setting that bypasses it
//
// It only reads statuses the modules already keep; it never changes anything.

export type ModuleState = 'on' | 'shadow' | 'off' | 'benched';

export interface ModuleScore {
  /** What the number measures, in words. */
  label: string;
  value: number | null;
  n: number;
}

export interface ModuleRow {
  module: string;
  area: 'pricing' | 'regime' | 'gates' | 'sizing' | 'exits' | 'data';
  state: ModuleState;
  validated: boolean | null;
  score: ModuleScore | null;
  flags: string[];
  note?: string;
}

export interface TrialReading { state: 'testing' | 'on' | 'off'; applied: boolean; windows: number; advantage: number | null; pWorse: number | null }
export interface HealthReading { windows: number; advantage: number | null; pWorse: number | null }

/** What the ledger reads, gathered by the engine from the modules' own statuses (missing = the part is not loaded). */
export interface LedgerInput {
  /** paper | live | shadow (TradingMode). */
  mode: string;
  /** The trained Kalshi model: live blockers (empty = passed its go-live gates). */
  model: { id: string; liveBlockers: string[] };
  /** The model against the calibrated market, settled windows (bot/model/modelHealth.ts). */
  modelHealth?: HealthReading | null;
  /** The TA network's drift with vs without it (same scorer). */
  taHealth?: HealthReading | null;
  /** Component trials (bot/strategy/componentTrials.ts): mlp, snn, ta, rules; applied in paper only. */
  trials?: Partial<Record<'mlp' | 'snn' | 'ta' | 'rules', TrialReading>> | null;
  snn?: { mode: string; alpha: number | null } | null;
  taNet?: { version: string; activeHeads: number } | null;
  ruleBook?: { passed: number } | null;
  volModel?: { validated: boolean; applied: boolean; improvement: number | null } | null;
  fillModel?: { validated: boolean; active: boolean } | null;
  playbook?: { enabled: boolean; validated: boolean } | null;
  compensator?: { enabled: boolean; validated: boolean } | null;
  characterStandAside: boolean;
  accuracyGate?: { enabled: boolean; blocked: number; buckets: number } | null;
  sessionRisk: { keys: number };
  sizing: {
    /** PAPER_ORDER_FRAC / PAPER_ORDER_USD in dollars an order (0 = paper sizes like live). */
    paperOrderUsd: number;
    tier: string;
    /** EquityGuard's loss-aware size scale (1 = full size). */
    sizeScale: number | null;
    /** Optimal f cap as a fraction of the bankroll (null = not enough trades yet). */
    optimalF: { cap: number | null; trades: number } | null;
    portfolioKelly: boolean;
  };
  exitPolicy: string;
  takeProfitBench?: { scored: number; netUsd: number; benched: boolean; enforce: boolean } | null;
  probation?: Record<string, { trades: number; netUsd: number; benched: boolean }> | null;
  /** Index age per asset (ms; null = never seen). */
  indexAgeMs: Record<string, number | null>;
  maxIndexAgeMs: number;
}

const r4 = (x: number | null | undefined): number | null => (x === null || x === undefined || !Number.isFinite(x) ? null : +x.toFixed(4));

function trialRow(module: string, area: ModuleRow['area'], t: TrialReading | undefined, base: Omit<ModuleRow, 'module' | 'area' | 'score' | 'flags' | 'state'> & { state: ModuleState; flags?: string[] }, mode: LedgerInput['mode']): ModuleRow {
  const flags = [...(base.flags ?? [])];
  let state = base.state;
  if (t && state !== 'off') {
    // The trials put a part into paper's prices (applied) or take it out; live's prices never follow them.
    if (mode === 'paper') state = t.applied ? 'on' : t.state === 'off' ? 'benched' : 'shadow';
    if (t.state === 'off') flags.push('trial: priced worse with it');
    if (mode === 'live' && t.applied) flags.push('trial result applies in paper only');
  }
  const score = t ? { label: 'log loss saved a contract vs the price without it', value: r4(t.advantage), n: t.windows } : null;
  return { module, area, state, validated: base.validated, score, flags, ...(base.note ? { note: base.note } : {}) };
}

export function buildLedger(x: LedgerInput): ModuleRow[] {
  const rows: ModuleRow[] = [];
  const tr = x.trials ?? {};
  const paperSized = x.mode === 'paper' && x.sizing.paperOrderUsd > 0;

  // Pricing.
  const mlpValid = x.model.liveBlockers.length === 0;
  rows.push(trialRow('meta model', 'pricing', tr.mlp, { state: 'on', validated: mlpValid, note: x.model.id, flags: mlpValid ? [] : [`go-live gates: ${x.model.liveBlockers.slice(0, 2).join('; ')}`] }, x.mode));
  if (x.modelHealth) {
    const h = x.modelHealth;
    const worse = h.pWorse !== null && h.pWorse < 0.05;
    rows.push({ module: 'pricing vs market', area: 'pricing', state: 'on', validated: null, score: { label: 'log loss better than the calibrated market a window', value: r4(h.advantage), n: h.windows }, flags: worse ? ['significantly worse than the market price'] : [] });
  }
  const snnOn = x.snn && x.snn.mode !== 'off';
  rows.push(trialRow('SNN', 'pricing', tr.snn, { state: !snnOn ? 'off' : x.snn!.mode === 'blend' && (x.snn!.alpha ?? 0) > 0 ? 'on' : 'shadow', validated: null, note: snnOn ? `mode ${x.snn!.mode}, alpha ${x.snn!.alpha ?? 0}` : undefined }, x.mode));
  const ta = trialRow('TA network', 'pricing', tr.ta, { state: x.taNet ? (x.taNet.activeHeads > 0 ? 'on' : 'shadow') : 'off', validated: x.taNet ? x.taNet.activeHeads > 0 : null, note: x.taNet ? `${x.taNet.version}, ${x.taNet.activeHeads} validated heads` : undefined }, x.mode);
  if (x.taHealth && x.taHealth.pWorse !== null && x.taHealth.pWorse < 0.05) ta.flags.push('its drift makes prices significantly worse');
  rows.push(ta);
  rows.push(trialRow('rule book', 'pricing', tr.rules, { state: x.ruleBook && x.ruleBook.passed > 0 ? 'on' : 'off', validated: x.ruleBook ? x.ruleBook.passed > 0 : null }, x.mode));
  if (x.volModel) rows.push({ module: 'volatility forecast', area: 'pricing', state: x.volModel.applied ? 'on' : x.volModel.validated ? 'off' : 'shadow', validated: x.volModel.validated, score: { label: 'held-out QLIKE improvement', value: r4(x.volModel.improvement), n: 0 }, flags: [] });
  else rows.push({ module: 'volatility forecast', area: 'pricing', state: 'off', validated: null, score: null, flags: ['no model file: pricing uses the flat sigma multiplier'] });
  if (x.fillModel) rows.push({ module: 'fill model', area: 'pricing', state: x.fillModel.active ? 'on' : 'shadow', validated: x.fillModel.validated, score: null, flags: [] });

  // Regime weights.
  for (const [name, r] of [['playbook', x.playbook], ['compensator', x.compensator]] as const) {
    const flags: string[] = [];
    if (paperSized) flags.push('size weight bypassed by the paper order size');
    rows.push({ module: name, area: 'regime', state: r?.enabled && r.validated ? 'on' : r ? 'shadow' : 'off', validated: r ? r.validated : null, score: null, flags });
  }
  rows.push({ module: 'character stand-aside', area: 'regime', state: x.characterStandAside ? 'on' : 'off', validated: null, score: null, flags: [] });

  // Gates.
  if (x.accuracyGate) {
    const g = x.accuracyGate;
    const flags = x.mode === 'paper' ? ['paper only: live never blocks on it'] : [];
    rows.push({ module: 'accuracy gate', area: 'gates', state: !g.enabled ? 'off' : x.mode === 'paper' ? 'on' : 'shadow', validated: null, score: { label: 'time-to-close buckets blocked', value: g.blocked, n: g.buckets }, flags });
  }
  for (const [book, p] of Object.entries(x.probation ?? {})) {
    rows.push({ module: `probation: ${book}`, area: 'gates', state: p.benched ? 'benched' : 'on', validated: null, score: { label: 'net dollars on probation', value: +p.netUsd.toFixed(2), n: p.trades }, flags: [] });
  }

  // Sizing.
  const sizingFlags = paperSized ? [`bypassed in paper: every order is $${x.sizing.paperOrderUsd.toFixed(2)} (PAPER_ORDER_FRAC/USD)`] : [];
  rows.push({ module: 'sizing tier', area: 'sizing', state: paperSized ? 'shadow' : 'on', validated: null, score: null, flags: [...sizingFlags], note: x.sizing.tier });
  rows.push({ module: 'loss-aware size scale', area: 'sizing', state: paperSized ? 'shadow' : 'on', validated: null, score: { label: 'size multiplier', value: r4(x.sizing.sizeScale), n: 0 }, flags: [...sizingFlags] });
  const of = x.sizing.optimalF;
  rows.push({ module: 'optimal f cap', area: 'sizing', state: paperSized ? 'shadow' : of && of.cap !== null ? 'on' : 'off', validated: null, score: of ? { label: 'cap as a share of the bankroll', value: r4(of.cap), n: of.trades } : null, flags: [...sizingFlags] });
  rows.push({ module: 'portfolio Kelly cap', area: 'sizing', state: !x.sizing.portfolioKelly ? 'off' : paperSized ? 'shadow' : 'on', validated: null, score: null, flags: [...sizingFlags] });
  rows.push({ module: 'session risk', area: 'sizing', state: x.sessionRisk.keys > 0 && !paperSized ? 'on' : 'off', validated: null, score: null, flags: x.sessionRisk.keys === 0 ? ['neutral: SESSION_RISK is not set'] : [...sizingFlags] });

  // Exits. The per-kind scores against holding (ratchet stop, model exit) join here from their benches.
  rows.push({ module: `exit policy: ${x.exitPolicy}`, area: 'exits', state: 'on', validated: null, score: null, flags: [] });
  if (x.takeProfitBench) {
    const b = x.takeProfitBench;
    rows.push({ module: 'take-profit', area: 'exits', state: b.benched ? 'benched' : 'on', validated: null, score: { label: 'dollars vs holding to settlement', value: +b.netUsd.toFixed(2), n: b.scored }, flags: b.enforce ? [] : ['scored only: never benched'] });
  }

  // Data.
  for (const [asset, age] of Object.entries(x.indexAgeMs).sort(([a], [b]) => a.localeCompare(b))) {
    const stale = age === null || age > x.maxIndexAgeMs;
    rows.push({ module: `index ${asset}`, area: 'data', state: stale ? 'off' : 'on', validated: null, score: { label: 'seconds since the last index value', value: age === null ? null : +(age / 1000).toFixed(1), n: 0 }, flags: stale ? ['stale: blocks new orders on it'] : [] });
  }
  return rows;
}

/** One line per row for logs and the daily report. */
export function ledgerLine(r: ModuleRow): string {
  const s = r.score ? ` | ${r.score.label}: ${r.score.value ?? '-'}${r.score.n ? ` (n=${r.score.n})` : ''}` : '';
  const v = r.validated === null ? '' : r.validated ? ' | validated' : ' | not validated';
  return `${r.area.padEnd(7)} ${r.module.padEnd(26)} ${r.state.padEnd(7)}${v}${s}${r.flags.length ? ` | ${r.flags.join('; ')}` : ''}`;
}
