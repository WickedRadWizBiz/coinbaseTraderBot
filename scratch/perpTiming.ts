// Scratch, not for merging: times the perps step on the server's recorded days as the pipeline runs it (its models
// installed first), with the line filter ("filtered": train, then backtest the newest days held out) or without it
// ("all-lines": the promoted model's backtest over one held-out day, every line read); "kalshi": one Kalshi sweep
// evaluation (research/sweep.ts kalshiScore) on the newest complete day, recording its model-call tape, playing it
// back, and with none. Prints counts, minutes and $.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadConfig, paperEnv } from '../bot/config';
import { MODEL_FILES } from '../bot/autotrain';
import { linkDays, recordingFiles } from '../bot/marketdata/recordingFiles';
import { PerpModel } from '../bot/perps/perpSignal';
import { setCrossLeadPath } from '../bot/ta/crossLead';
import { setCrossGraphPath } from '../bot/ta/crossGraph';
import { setLibrarianPath } from '../bot/ta/librarian';
import { setTaNet, TaNet, taNetFileSchema, TANET_SCHEMA } from '../bot/ta/taNet';
import { runPerpBacktest } from '../research/perpBacktest';
import { kalshiScore } from '../research/sweep';
import { trainPerpMain } from '../research/trainPerpModel';
import { workerCount } from '../research/workerPool';

const min = (t: number) => ((Date.now() - t) / 60000).toFixed(1);

(async () => {
  const mode = process.argv[2] ?? 'filtered';
  const cfg = loadConfig(paperEnv(process.env));
  const A = cfg.autoTrain, T = cfg.taNet;
  const promoted = (k: keyof typeof MODEL_FILES) => path.join(A.dir, MODEL_FILES[k]);
  if (T.enabled) {
    const f = fs.existsSync(promoted('ta_net')) && taNetFileSchema(promoted('ta_net')) === TANET_SCHEMA ? promoted('ta_net') : fs.existsSync(T.modelPath) ? T.modelPath : undefined;
    setTaNet(f ? TaNet.load(f) : undefined, T.requireValidated);
    console.log(`TIMING TA network ${f ? 'loaded' : 'none'}`);
  }
  setLibrarianPath(T.enabled ? () => (fs.existsSync(promoted('librarian')) ? promoted('librarian') : T.librarianPath) : undefined);
  setCrossGraphPath(T.enabled ? () => (fs.existsSync(promoted('cross_graph')) ? promoted('cross_graph') : T.crossGraphPath) : undefined);
  setCrossLeadPath(() => (fs.existsSync(promoted('cross_lead')) ? promoted('cross_lead') : T.crossLeadPath));
  const files = recordingFiles(A.recordingsDir);
  if (mode === 'kalshi') {
    const today = new Date().toISOString().slice(0, 10);
    const done = files.filter((f) => f.day < today);
    const mlp = fs.existsSync(promoted('mlp')) ? promoted('mlp') : cfg.paramsPath;
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'kalshi-timing-'));
    linkDays(done.slice(-1), path.join(work, 'days'));
    console.log(`TIMING ${done.length} complete recorded day(s); one Kalshi sweep evaluation on the newest; model ${fs.existsSync(mlp) ? 'present' : 'missing'}; ${workerCount()} workers available`);
    const tape = { file: path.join(work, 'k.tape'), sig: 'timing' };
    for (const pass of ['recording the tape', 'playing the tape back', 'no tape']) {
      const t = Date.now();
      const f = await kalshiScore(path.join(work, 'days'), mlp, {}, pass === 'no tape' ? undefined : tape);
      console.log(`TIMING kalshi score, 1 day (${pass}): ${min(t)} min | windows traded ${f.n}, t ${Number.isFinite(f.score) ? f.score.toFixed(2) : 'n/a'}`);
    }
    return;
  }
  const testN = mode === 'filtered' ? Math.min(7, files.length - 1) : 1;
  const test = files.slice(-testN).map((f) => f.day);
  console.log(`TIMING ${files.length} recorded day(s); testing on the newest ${testN}, the day before warms up`);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'perp-timing-'));
  let model = PerpModel.load(promoted('perp'));
  if (mode === 'filtered') {
    const cand = path.join(work, 'cand.json');
    const args: Record<string, string> = { recordings: A.recordingsDir, out: cand, cache: path.join(work, 'cache'), workers: String(workerCount()), 'holdout-from': test[0] };
    const t = Date.now();
    const log = console.log;
    console.log = () => {};
    try { await trainPerpMain((k, d) => args[k] ?? d); } finally { console.log = log; }
    console.log(`TIMING train (line filter, ${workerCount()} workers, ${files.length - testN} days trained): ${min(t)} min`);
    model = PerpModel.load(cand);
  }
  const bt = path.join(work, 'bt');
  linkDays(files.slice(-testN - 1), bt);
  const t = Date.now();
  const r = await runPerpBacktest(bt, cfg.perps, model, { from: test[0], minDays: 5, ...(mode === 'filtered' ? {} : { keep: null }) });
  console.log(`TIMING backtest (${mode}) ${testN + 1} day(s) replayed, ${r.days.toFixed(2)} traded: ${min(t)} min | trades ${r.trades}, P&L $${r.pnlUsd.toFixed(2)}, fees $${r.fees.toFixed(2)}, ok ${r.ok}`);
})().catch((e) => { console.error(`TIMING failed: ${(e as Error).message}`); process.exitCode = 1; });
