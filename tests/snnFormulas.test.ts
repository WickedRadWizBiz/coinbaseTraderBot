// Every SNN equation from the design review, asserted (a) against hand-computed values and
// (b) against the independent stdlib-Python reference (research/snn_reference.py) at 1e-5.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import * as f from '../bot/snn/formulas';
import { Xoshiro128 } from '../bot/snn/rng';

const G = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'snn_golden.json'), 'utf8'));
const TOL = 1e-5;
const close = (a: number, b: number, msg = '', tol = TOL) => assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${msg}: ${a} vs ${b}`);

test('golden: LIF exact update and the full ALIF step sequence', () => {
  for (const [v, I, want] of G.lif) close(f.lifStep(v, I, { EL: -0.2, R: 1.5, tauM: 10 }), want, 'lif');
  let st = { v: G.alif.p.EL, a: 0 };
  G.alif.I.forEach((I: number, t: number) => {
    const o = f.alifStep(st, I, G.alif.p);
    const [v, a, s] = G.alif.out[t];
    close(o.v, v, `alif v@${t}`); close(o.a, a, `alif a@${t}`); assert.equal(o.s, s);
    st = o;
  });
  assert.ok(G.alif.out.some((r: number[]) => r[2] === 1), 'fixture must spike');
});

test('golden: Izhikevich RS/FS/CH with two half-steps of v', () => {
  for (const k of ['RS', 'FS', 'CH'] as const) {
    const p = f.IZH[k];
    let v = -65, u = p.b * -65;
    G.izh[k].forEach((row: number[], t: number) => {
      const o = f.izhikevichStep(v, u, 10, p);
      close(o.v, row[0], `${k} v@${t}`, 1e-4); close(o.u, row[1], `${k} u@${t}`, 1e-4); assert.equal(o.spike ? 1 : 0, row[2]);
      v = o.v; u = o.u;
    });
  }
  assert.deepEqual(f.IZH.CH, { a: 0.02, b: 0.2, c: -50, d: 2 });
});

test('golden: corrected HH beta_n / alpha_n, Nernst-Planck, Einstein, cable lambda', () => {
  for (const [V, a, b] of G.hh) { close(f.hhAlphaN(V), a, 'alpha_n'); close(f.hhBetaN(V), b, 'beta_n'); }
  // The PDF's garbled beta_n = 0.125 exp(-0.01125(V+55)) is NOT what we compute.
  assert.ok(Math.abs(f.hhBetaN(-40) - 0.125 * Math.exp(-0.01125 * 15)) > 1e-3);
  close(f.hhBetaN(-65), 0.125, 'beta_n at rest');
  for (const [D, dC, z, T, C, dV, want] of G.np) close(f.nernstPlanckFlux(D, dC, z, T, C, dV), want, 'NP');
  // Drift term proportional to C: doubling C (with dC/dx = 0) doubles the flux.
  close(f.nernstPlanckFlux(1, 0, 1, 300, 2, 1), 2 * f.nernstPlanckFlux(1, 0, 1, 300, 1, 1), 'NP drift ~ C');
  for (const [mu, T, q, want] of G.einstein) close(f.einsteinD(mu, T, q) * 1e9, want, 'Einstein');
  for (const [d, Rm, Ri, want] of G.lambda) close(f.cableLambda(d, Rm, Ri), want, 'lambda');
  // Steady state V = V0 e^{-x/lambda} satisfies lambda^2 V'' = V.
  const lam = 0.3, x = 0.2, V = Math.exp(-x / lam);
  close(f.cableResidual(lam, V / (lam * lam), 10, 0, V), 0, 'cable residual');
});

test('golden: Poirazi subunit, dCaAP bump, double exponential, NMDA gate', () => {
  const P = G.poirazi;
  close(f.poirazi(P.W.map((w: number[], j: number) => ({ w, x: P.X[j], theta: P.theta[j] })), P.alpha), P.y, 'poirazi');
  for (const [x, th, w, want] of G.dcaap) close(f.dcaap(x, th, w), want, 'dcaap');
  assert.ok(f.dcaap(1, 1, 0.4) > f.dcaap(2, 1, 0.4), 'non-monotonic: dampened for stronger input');
  for (const [tr, td, tpk, K, kern, t] of G.dexp) {
    close(f.dexpPeakTime(tr, td), tpk, 'tpk'); close(f.dexpNorm(tr, td), K, 'K'); close(f.dexpKernel(t, 0.7, tr, td), kern, 'kernel');
    close(f.dexpKernel(tpk, 1, tr, td), 1, 'kernel peaks at gbar');
  }
  for (const [V, mg, want] of G.nmda) close(f.nmdaGate(V, mg), want, 'nmda');
  close(f.nmdaGate(0, 3.57), 0.5, 'G(0) with [Mg] = 3.57 is 1/2');
  close(f.toMvEquivalent(0.25, 0, 0.25), -50, 'threshold -> -50 mV'); close(f.toMvEquivalent(0, 0, 0.25), -65, 'rest -> -65 mV');
});

test('clocked double-exponential traces reproduce the analytic kernel exactly', () => {
  const { tauR, tauD } = f.SYN_CLASSES.nmda;
  let s = { xr: 0, xd: 0 };
  const K = f.dexpNorm(tauR, tauD);
  s = f.dexpTraceStep(s.xr, s.xd, 1, tauR, tauD); // spike at t = 0
  for (let t = 1; t <= 40; t++) {
    s = f.dexpTraceStep(s.xr, s.xd, 0, tauR, tauD);
    close(K * (s.xd - s.xr), f.dexpKernel(t, 1, tauR, tauD), `t=${t}`, 1e-9);
  }
});

test('golden: gap junction and Postnov currents', () => {
  close(f.gapCurrent(0.2, -60, -65), 1, 'I = g_j (V1 - V2)');
  close(f.couplingCoefficientR(100, 300), 0.25, 'CC from R'); close(f.couplingCoefficientG(1 / 300, 1 / 100), 0.25, 'CC from g (same value)');
  close(f.postnovISyn(1, 0.5, 0.4, 2, 0.5), (1 - 0.2) * 1.5, 'I_syn'); close(f.postnovIAst(0.3, 0.4), 0.12, 'I_ast');
});

test('golden: governor low-pass, effects are one-directional', () => {
  const g = G.governor;
  let Gv = 0;
  g.drives.forEach((d: number[], t: number) => {
    Gv = f.governorStep(Gv, { rhoHat: d[0], zE: d[1], fSat: d[2], dBrier: d[3] }, { k1: g.k[0], k2: g.k[1], k3: g.k[2], k4: g.k[3] }, g.tauG);
    close(Gv, g.out[t], `G@${t}`);
    assert.ok(Gv >= 0 && Gv <= 1);
  });
  for (const G2 of [0, 0.3, 1]) { assert.ok(f.etaEff(1e-3, 0.8, G2) <= 1e-3); assert.ok(f.columnGain(0.5, G2) <= 1); }
  close(f.etaEff(1e-3, 0.8, 1), 2e-4, 'eta (1 - delta G)');
});

test('golden: minimal triplet STDP with BCM slide, gated and clipped; BCM thresholds', () => {
  const T = G.triplet;
  let r1 = 0, o1 = 0, o2 = 0, w = T.w0;
  T.pre.forEach((sp: number, t: number) => {
    const so = T.post[t];
    const d = f.tripletTraces(r1, o1, o2, sp, 0, T.P); // decay all; add only the pre spike now
    const dw = f.tripletDw(sp, so, d.r1, d.o1, d.o2, T.rhoBar, T.P);
    w = f.gatedUpdate(w, dw.plus, dw.minus, T.eta, T.gate, T.kappa, T.wmin, T.wmax);
    r1 = d.r1; o1 = d.o1 + so; o2 = d.o2 + so;
    const [ww, rr, oo1, oo2] = T.out[t];
    close(w, ww, `w@${t}`); close(r1, rr, `r1@${t}`); close(o1, oo1, `o1@${t}`); close(o2, oo2, `o2@${t}`);
  });
  close(f.a2MinusSlide(0.01, 0.1, 0.05, 2), 0.04, 'A2-(rho) = A2- (rho/rho0)^p');
  for (const [mY2, rho0, yb, y0, p, eta, x, y, tIC, t82, dw] of G.bcm) {
    close(f.bcmThetaIC(mY2, rho0), tIC, 'theta IC'); close(f.bcmTheta1982(yb, y0, p), t82, 'theta 1982'); close(f.bcmDw(eta, x, y, t82), dw, 'bcm dw');
  }
  assert.ok(f.bcmDw(1, 1, 0.5, 1) < 0 && f.bcmDw(1, 1, 2, 1) > 0, 'LTD below theta, LTP above');
  assert.equal(f.gatedUpdate(0.5, 10, 0, 1, 1, 0.01, 0, 1), 0.51, 'per-update cap kappa');
});

test('golden: two-speed weights (exact), half-life', () => {
  const t = G.two_speed;
  let s = { wf: t.wf, ws: t.ws };
  t.out.forEach((row: number[], i: number) => { s = f.twoSpeedStep(s.wf, s.ws, t.tauC, t.eps); close(s.wf, row[0], `wf@${i}`, 1e-9); close(s.ws, row[1], `ws@${i}`, 1e-9); });
  // Conservation: w_f + w_s/(eps tau_c) is invariant of the linear system.
  const inv = (a: { wf: number; ws: number }) => a.wf + a.ws / (0.001 * 100);
  close(inv(f.twoSpeedStep(1, 0.2, 100, 0.001, 50)), inv({ wf: 1, ws: 0.2 }), 'invariant', 1e-9);
  close(f.twoSpeedHalfLife(3600, 0), 3600 * Math.LN2, 'half-life');
});

test('golden: Rao-Ballard predictive coding step (precision divides), U update, clipping', () => {
  const P = G.pc;
  const U = Float64Array.from(P.U), r = Float64Array.from(P.r);
  P.out.forEach((o: { r: number[]; norm: number; U0: number; Ulast: number }, t: number) => {
    const res = f.pcStep(U, r, P.xs[t % P.xs.length], P.rtd, P.P);
    close(res.norm, o.norm, `norm@${t}`);
    o.r.forEach((v: number, j: number) => close(r[j], v, `r[${j}]@${t}`));
    close(U[0], o.U0, `U0@${t}`); close(U[U.length - 1], o.Ulast, `Ulast@${t}`);
  });
  // Higher precision (smaller sigma^2) => bigger representation step: k1/sigma^2, not k1 sigma^2.
  const step = (s2: number) => { const rr = new Float64Array([0]); f.pcStep(new Float64Array([1]), rr, [0.5], undefined, { ...P.P, sigma2: s2, priorL2: 0 }, false); return rr[0]; };
  assert.ok(step(0.1) > step(1));
  const e = new Float64Array([3, 4]); assert.equal(f.clipNorm(e, 1), 5); close(Math.hypot(e[0], e[1]), 1, 'clipped');
  assert.ok(f.pcLambdaMax(new Float64Array([2, 0, 0, 1]), 2, 2) - 4 < 1e-6, 'lambda_max(U^T U) = 4');
});

test('golden: Wilson-Cowan RK2 with dt <= tau/10; reference parameters', () => {
  for (const [E, I, P, Q, dt, wantE, wantI] of G.wc) { const o = f.wcStepRk2(E, I, P, Q, dt); close(o.E, wantE, 'E'); close(o.I, wantI, 'I'); }
  assert.equal(f.WC_PARAMS.kE, 0.97); assert.equal(f.WC_PARAMS.kI, 0.98); assert.equal(f.WC_PARAMS.c1, 12);
});

test('golden: isotonic projection, divisive normalisation, RPS, surrogate, blend', () => {
  for (const c of G.isotonic) f.isotonic(c.y).forEach((v, i) => close(v, c.out[i], 'iso'));
  const iso = f.isotonic([0.9, 0.7, 0.75, 0.4]);
  for (let i = 1; i < iso.length; i++) assert.ok(iso[i] <= iso[i - 1] + 1e-12, 'non-increasing across strikes');
  for (const c of G.divnorm) f.divisiveNormalization(c.r, c.n, c.sigma).forEach((v, i) => close(v, c.out[i], 'divnorm'));
  assert.ok(f.divisiveNormalization([1, 2, 3], 2, 0.5).reduce((a, b) => a + b) < 1, 'soft: sums below 1');
  for (const [cdf, out, want] of G.rps) close(f.rankedProbabilityScore(cdf, out), want, 'rps');
  for (const [U, want] of G.fastsig) close(f.fastSigmoidSurrogate(U), want, 'fast sigmoid');
  for (const [pm, ps, a, c, want] of G.blend) close(f.blend(pm, ps, a, c), want, 'blend');
  close(f.blend(0.5, 1, 0.9, 1), 0.625, 'alpha capped at 0.25');
  close(f.surpriseConfidence(0.8, 1, 2), 0.4, 'surprise halves c'); close(f.surpriseConfidence(0.8, 1, 0.5), 0.8, 'low surprise never raises c');
});

test('golden: xoshiro128** matches the reference bit for bit and restores from state', () => {
  const r = new Xoshiro128(G.xoshiro.seed);
  assert.deepEqual(r.state(), G.xoshiro.state0);
  for (const want of G.xoshiro.out) assert.equal(r.nextU32(), want);
  const a = new Xoshiro128(5); a.next(); a.next();
  const b = new Xoshiro128(a.state());
  for (let i = 0; i < 10; i++) assert.equal(a.next(), b.next());
});

test('helpers: calibration slope, correlation, population code, send-on-delta, ewma', () => {
  const p: number[] = [], y: number[] = [];
  const r = new Xoshiro128(3);
  for (let i = 0; i < 4000; i++) { const q = 0.05 + 0.9 * r.next(); p.push(q); y.push(r.next() < q ? 1 : 0); }
  const b = f.calibrationSlope(p, y);
  assert.ok(b > 0.9 && b < 1.1, `calibrated slope ${b}`);
  const over = p.map((q) => f.sigmoid(2 * f.logit(q)));
  assert.ok(f.calibrationSlope(over, y) < 0.6, 'overconfident forecasts have slope < 1');
  close(f.correlation([1, 2, 3], [2, 4, 6]), 1, 'corr');
  const pc = f.populationCode(0.5, 0, 1);
  assert.equal(pc.length, 8); assert.ok(pc[3] > 0.5 && pc[4] > 0.5 && pc[0] < 0.01);
  let d = f.deltaEncode(0, 7.5, 3); assert.deepEqual([d.up, d.down], [2, 0]); close(d.acc, 1.5, 'remainder');
  d = f.deltaEncode(d.acc, -5, 3); assert.deepEqual([d.up, d.down], [0, 1]); close(d.acc, -0.5, 'remainder');
  close(f.ewma(0, 1, 1e9), 0, 'slow ewma'); close(f.ewma(0, 1, 1e-9), 1, 'fast ewma');
  const dw = f.readoutDelta([1, -2, 100], 1, 0.25, 1e-2, 0.5);
  close(dw[0], 0.0075, 'eta (y - p) phi'); close(dw[1], -0.015, 'delta'); close(dw[2], 0.5, 'capped');
});
