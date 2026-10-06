// Session edges: the first/last 40 minutes of the Asia, London and New York sessions. No new entries
// there; with AUTO_TRAIN=windows the training pipeline runs only there (frozen the rest of the time).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { Alerter } from '../bot/alerts/alerter';
import { AutoTrainer } from '../bot/autotrain';
import { loadConfig } from '../bot/config';
import { Engine } from '../bot/engine';
import { nextSessionEdge, nextWeekendMidnight, sessionEdge, sessionAt, weekendTraining } from '../bot/model/sessions';
import { SystemPressure } from '../bot/util/systemPressure';
import { tmpAudit, tmpDir } from './helpers';

// Wednesday 7 October 2026 (UK on BST = UTC+1, New York on EDT = UTC-4).
const at = (h: number, m = 0) => Date.UTC(2026, 9, 7, h, m);

test('sessionEdge: first and last 40 minutes of Asia, London and New York (local hours, DST-correct)', () => {
  assert.equal(sessionEdge(at(0, 10)), 'Asia open');            // Tokyo 09:10 JST
  assert.equal(sessionEdge(at(7, 10)), 'London open');          // London 08:10 BST
  assert.equal(sessionEdge(at(7, 30)), 'Asia close');           // London open and Asia close overlap here
  assert.equal(sessionEdge(at(7, 50)), 'Asia close');           // Hong Kong 15:50 HKT
  assert.equal(sessionEdge(at(8, 0)), undefined);
  assert.equal(sessionEdge(at(13, 30)), 'New York open');       // 09:30 EDT
  assert.equal(sessionEdge(at(14, 10)), undefined);             // 40 minutes later
  assert.equal(sessionEdge(at(14, 55)), 'London close');        // 15:55 BST
  assert.equal(sessionEdge(at(19, 30)), 'New York close');      // 15:30 EDT
  assert.equal(sessionEdge(at(20, 0)), undefined);
  assert.equal(sessionEdge(Date.UTC(2026, 9, 10, 13, 40)), undefined, 'Saturday: no sessions');
  assert.equal(sessionEdge(at(14, 0), 30), undefined, 'SESSION_EDGE_MIN=30 narrows the window');
});

test('nextSessionEdge: the current or next window with its start and end', () => {
  const w = nextSessionEdge(at(2))!;
  assert.equal(w.start, at(7));
  assert.equal(w.end, at(8), 'London open and Asia close windows run together 07:00-08:00 UTC');
  assert.equal(w.label, 'London open');
  const inside = nextSessionEdge(at(13, 45))!;
  assert.deepEqual([inside.start, inside.end], [at(13, 30), at(14, 10)]);
  const fri = nextSessionEdge(Date.UTC(2026, 9, 9, 21))!;
  assert.equal(fri.start, Date.UTC(2026, 9, 12, 0), 'Friday night -> Monday Tokyo open');
});

test('entry guard: no new entries at a session edge (SESSION_EDGE_NO_ENTRY=false turns it off)', () => {
  const block = (env: Record<string, string>, ts: number) => Engine.prototype.sessionEdgeBlock.call({ d: { cfg: loadConfig(env) } } as never, ts);
  assert.match(block({}, at(13, 40))!, /New York open/);
  assert.equal(block({}, at(12)), undefined);
  assert.equal(block({ SESSION_EDGE_NO_ENTRY: 'false' }, at(13, 40)), undefined);
});

test('AUTO_TRAIN=windows: starts in the first window once a day is due, paused outside windows, resumed inside', async () => {
  const dir = tmpDir();
  const cfg = loadConfig({ DATA_DIR: dir, AUTO_TRAIN: 'windows', AUTO_TRAIN_ON_MODEL_CHANGE: 'false' });
  assert.equal(cfg.autoTrain.mode, 'windows');
  const audit = tmpAudit();
  let now = at(2);
  const engine = { model: { id: 'm' } } as unknown as Engine;
  const t = new AutoTrainer({ cfg, engine, audit, alerter: new Alerter([], audit), now: () => now, command: { cmd: process.execPath, args: ['-e', 'setTimeout(()=>{}, 4000)'] } });
  assert.equal(t.nextRun(), at(7), 'never ran: the next window');
  await t.tick();
  assert.equal(t.status().running, false, 'not inside a window: does not start');
  now = at(7, 5);
  await t.tick();
  assert.equal(t.status().running, true, 'inside a window: started');
  assert.equal(t.status().paused, false);
  now = at(9);
  await t.tick();
  assert.equal(t.status().paused, true, 'window over: frozen');
  now = at(13, 31);
  await t.tick();
  assert.equal(t.status().paused, false, 'next window: resumed');
  assert.equal(t.status().window!.inside, 'New York open');
  t.stop();
  await new Promise((r) => setTimeout(r, 200));
});

test('weekend: training starts at Friday midnight New York, holds entries until done; weekend and pre-week are their own sessions', async () => {
  const sat = (h: number, m = 0) => Date.UTC(2026, 9, 10, h, m);     // Saturday; New York = UTC-4
  // Friday 16:00 ET (US close) -> Sunday 18:00 ET is the weekend market; then the pre-week until Monday 09:30 ET.
  assert.equal(sessionAt(Date.UTC(2026, 9, 9, 19, 59)), 'new_york', 'Friday 15:59 New York');
  assert.equal(sessionAt(Date.UTC(2026, 9, 9, 20)), 'weekend', 'Friday 16:00 New York');
  assert.equal(sessionAt(Date.UTC(2026, 9, 11, 21, 59)), 'weekend', 'Sunday 17:59 New York');
  assert.equal(sessionAt(Date.UTC(2026, 9, 11, 22)), 'pre_week', 'Sunday 18:00 New York');
  assert.equal(sessionAt(Date.UTC(2026, 9, 12, 8)), 'pre_week', 'Monday 04:00 New York (London open)');
  assert.equal(sessionAt(Date.UTC(2026, 9, 12, 13, 30)), 'london_ny_overlap', 'Monday 09:30 New York: the week starts');
  assert.deepEqual(weekendTraining(sat(4, 30)), { free: true, start: true }, 'Friday midnight (Saturday 00:30 New York)');
  assert.deepEqual(weekendTraining(sat(12)), { free: true, start: false });
  assert.equal(weekendTraining(Date.UTC(2026, 9, 11, 4, 30)).start, false, 'Sunday midnight is not a start any more');
  assert.equal(weekendTraining(Date.UTC(2026, 9, 11, 23)).free, false, 'Sunday 19:00 New York: pre-week, trading');
  assert.equal(nextWeekendMidnight(Date.UTC(2026, 9, 9, 21)), sat(4), 'Friday evening -> Friday midnight');
  assert.equal(nextWeekendMidnight(sat(5)), Date.UTC(2026, 9, 17, 4), 'past the start hour -> next Friday midnight');

  const dir = tmpDir();
  const cfg = loadConfig({ DATA_DIR: dir, AUTO_TRAIN: 'windows', AUTO_TRAIN_ON_MODEL_CHANGE: 'false' });
  const audit = tmpAudit();
  let now = Date.UTC(2026, 9, 9, 22);
  const engine = { model: { id: 'm' } } as unknown as Engine;
  const t = new AutoTrainer({ cfg, engine, audit, alerter: new Alerter([], audit), now: () => now, command: { cmd: process.execPath, args: ['-e', 'setTimeout(()=>{}, 4000)'] } });
  t.start();
  assert.equal(t.nextRun(), sat(4), 'due on Friday night: Friday midnight comes before Monday\'s Tokyo open');
  now = sat(4, 10);
  await t.tick();
  assert.equal(t.status().running, true, 'started at Friday midnight');
  assert.match(engine.trainingGuard?.() ?? '', /weekend training run in progress/, 'no new entries while it runs');
  now = sat(15);
  await t.tick();
  assert.equal(t.status().paused, false, 'weekend: runs unpaused');
  now = Date.UTC(2026, 9, 12, 1);
  await t.tick();
  assert.equal(t.status().paused, true, 'pre-week (outside a session edge): frozen');
  assert.equal(engine.trainingGuard?.(), undefined, 'outside the weekend the run no longer holds entries');
  t.stop();
  await new Promise((r) => setTimeout(r, 200));
});

test('AUTO_TRAIN=background (default): trains beside trading once warmed up, frozen only under pressure, resumed after a calm minute', async () => {
  const dir = tmpDir();
  const cfg = loadConfig({ DATA_DIR: dir, AUTO_TRAIN_ON_MODEL_CHANGE: 'false' });
  assert.equal(cfg.autoTrain.mode, 'background');
  const audit = tmpAudit();
  let now = at(2);
  let busy: string | undefined;
  const engine = { model: { id: 'm' } } as unknown as Engine;
  const t = new AutoTrainer({ cfg, engine, audit, alerter: new Alerter([], audit), now: () => now, pressure: () => busy, command: { cmd: process.execPath, args: ['-e', 'setTimeout(()=>{}, 4000)'] } });
  t.start();
  assert.equal(t.nextRun(), at(2), 'never completed a run: due now (no window needed)');
  now = at(2, 5);
  await t.tick();
  assert.equal(t.status().running, false, 'waits for trading to warm up after a start');
  now = at(2, 11);
  await t.tick();
  assert.equal(t.status().running, true, 'started outside any session window');
  now = at(3);
  await t.tick();
  assert.equal(t.status().paused, false, 'not frozen while the machine is calm');
  busy = 'trading loop lagging (p99 900 ms)';
  await t.tick();
  assert.equal(t.status().paused, true, 'frozen under pressure');
  assert.match(String(t.status().pausedFor), /lagging/);
  busy = undefined;
  now = at(3, 0) + 30_000;
  await t.tick();
  assert.equal(t.status().paused, true, 'calm for 30 s: still frozen');
  now = at(3, 0) + 95_000;
  await t.tick();
  assert.equal(t.status().paused, false, 'calm for a minute: resumed');
  // After a completed run the next one is due AUTO_TRAIN_EVERY_HOURS later.
  fs.mkdirSync(cfg.autoTrain.dir, { recursive: true });
  fs.writeFileSync(path.join(cfg.autoTrain.dir, 'pipeline_state.json'), JSON.stringify({ lastRun: at(4) }));
  assert.equal(t.nextRun(at(5)), at(10));
  t.stop();
  await new Promise((r) => setTimeout(r, 200));
});

test('background: Friday midnight during a run queues the weekend run behind it and holds new entries until it ends', async () => {
  const sat = (h: number, m = 0) => Date.UTC(2026, 9, 10, h, m);
  const dir = tmpDir();
  const cfg = loadConfig({ DATA_DIR: dir, AUTO_TRAIN_ON_MODEL_CHANGE: 'false', AUTO_TRAIN_START_DELAY_MIN: '0' });
  const audit = tmpAudit();
  let now = sat(3, 30); // Friday 23:30 New York
  const engine = { model: { id: 'm' } } as unknown as Engine;
  const t = new AutoTrainer({ cfg, engine, audit, alerter: new Alerter([], audit), now: () => now, pressure: () => undefined, command: { cmd: process.execPath, args: ['-e', 'setTimeout(()=>{}, 600)'] } });
  t.start();
  await t.tick();
  assert.equal(t.status().running, true, 'a background run is going');
  assert.equal(engine.trainingGuard?.(), undefined, 'a weekday-style run does not hold entries');
  now = sat(4, 10); // Friday midnight New York
  await t.tick();
  assert.match(engine.trainingGuard?.() ?? '', /weekend training run in progress/, 'entries held from Friday midnight');
  // The first run ends and the weekend run starts right behind it (in the exit handler).
  for (let i = 0; i < 100 && !t.status().lastExit; i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(t.status().lastExit, 'first run ended');
  assert.equal(t.status().running, true, 'weekend run started behind it');
  assert.match(engine.trainingGuard?.() ?? '', /weekend training run in progress/);
  t.stop();
  await new Promise((r) => setTimeout(r, 200));
});

test('system pressure: memory and CPU steal from /proc, loop lag from the event loop', () => {
  let stat = 'cpu  100 0 100 800 0 0 0 0 0 0';
  const files: Record<string, string> = { '/proc/meminfo': 'MemTotal: 2000000 kB\nMemAvailable:  204800 kB\n' };
  const sp = new SystemPressure({ maxLoopLagMs: 60_000, minAvailableMb: 300, maxStealFrac: 0.15 }, (p) => (p === '/proc/stat' ? stat : files[p]));
  assert.equal(sp.availableMb(), 200);
  assert.match(sp.check() ?? '', /low memory \(200 MB/);
  files['/proc/meminfo'] = 'MemAvailable: 1048576 kB\n';
  stat = 'cpu  150 0 150 850 0 0 0 50 0 0'; // 200 more jiffies, 50 of them stolen
  assert.match(sp.check() ?? '', /CPU throttled by the host \(steal 25%\)/);
  stat = 'cpu  250 0 250 950 0 0 0 52 0 0';
  assert.equal(sp.check(), undefined, 'calm');
  assert.equal(sp.last.availableMb, 1024);
  sp.stop();
});
