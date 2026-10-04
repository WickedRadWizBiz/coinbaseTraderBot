// Session edges: the first/last 40 minutes of the Asia, London and New York sessions. No new entries
// there; with AUTO_TRAIN=windows the training pipeline runs only there (frozen the rest of the time).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Alerter } from '../bot/alerts/alerter';
import { AutoTrainer } from '../bot/autotrain';
import { loadConfig } from '../bot/config';
import { Engine } from '../bot/engine';
import { nextSessionEdge, nextWeekendMidnight, sessionEdge, weekendTraining } from '../bot/model/sessions';
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

test('AUTO_TRAIN=windows (default): starts in the first window once a day is due, paused outside windows, resumed inside', async () => {
  const dir = tmpDir();
  const cfg = loadConfig({ DATA_DIR: dir });
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

test('weekends: training starts at midnight New York time on Saturday and Sunday and runs until Tokyo opens Monday', async () => {
  const sat = (h: number, m = 0) => Date.UTC(2026, 9, 10, h, m);     // Saturday; New York = UTC-4
  assert.deepEqual(weekendTraining(sat(4, 30)), { free: true, start: true }, 'Saturday 00:30 New York');
  assert.deepEqual(weekendTraining(sat(12)), { free: true, start: false });
  assert.equal(weekendTraining(Date.UTC(2026, 9, 11, 23)).free, true, 'Sunday 19:00 New York');
  assert.equal(weekendTraining(Date.UTC(2026, 9, 12, 0, 30)).free, false, 'Sunday 20:30 New York = Monday in Tokyo: trading again');
  assert.equal(nextWeekendMidnight(Date.UTC(2026, 9, 9, 21)), sat(4), 'Friday evening -> Saturday midnight');
  assert.equal(nextWeekendMidnight(sat(5)), Date.UTC(2026, 9, 11, 4), 'past Saturday\'s start hour -> Sunday midnight');

  const dir = tmpDir();
  const cfg = loadConfig({ DATA_DIR: dir });
  const audit = tmpAudit();
  let now = Date.UTC(2026, 9, 9, 22);
  const engine = { model: { id: 'm' } } as unknown as Engine;
  const t = new AutoTrainer({ cfg, engine, audit, alerter: new Alerter([], audit), now: () => now, command: { cmd: process.execPath, args: ['-e', 'setTimeout(()=>{}, 4000)'] } });
  assert.equal(t.nextRun(), sat(4), 'due on Friday night: Saturday midnight comes before Monday\'s Tokyo open');
  now = sat(4, 10);
  await t.tick();
  assert.equal(t.status().running, true, 'started at Saturday midnight');
  now = sat(15);
  await t.tick();
  assert.equal(t.status().paused, false, 'weekend: runs unpaused');
  now = Date.UTC(2026, 9, 12, 1);
  await t.tick();
  assert.equal(t.status().paused, true, 'Monday Asia session (outside a session edge): frozen');
  t.stop();
  await new Promise((r) => setTimeout(r, 200));
});
