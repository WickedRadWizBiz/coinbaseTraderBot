// The trainer window (served by research/trainerUi.ts): one self-contained page in the bot dashboard's look,
// a CRT screen of purple phosphor set in brushed chassis metal (web/src/index.css: crt-grid-panel, halation,
// JetBrains Mono). It polls /api/state every second; every action posts with the window's token.

export const TRAINER_PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Kalshi Trainer</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&display=swap" rel="stylesheet" />
<style>
  :root {
    --bg: #05040a; --primary: #9b7cff; --text: #e6e0ff; --dim: #a99fd6; --success: #b59eff; --danger: #ff549a; --warn: #ffb35c;
    --halation: -0.6px 0 0 rgba(255,0,170,.25), .6px 0 0 rgba(0,255,225,.2), 0 0 2px color-mix(in srgb, currentColor 75%, transparent),
      0 0 7px color-mix(in srgb, currentColor 50%, transparent), 0 0 16px color-mix(in srgb, currentColor 30%, transparent);
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; min-height: 100vh; }
  body {
    font-family: 'JetBrains Mono', ui-monospace, Consolas, monospace; letter-spacing: -0.02em; color: var(--text);
    background-color: #a8aeb8;
    background-image:
      repeating-linear-gradient(90deg, rgba(255,255,255,.06) 0 1px, transparent 1px 3px),
      repeating-linear-gradient(90deg, rgba(0,0,0,.05) 0 2px, transparent 2px 7px),
      linear-gradient(180deg, #b9bec7 0%, #a3a9b3 45%, #969ca6 100%);
    display: flex; justify-content: center; padding: 28px 16px;
  }
  .chassis { width: 100%; max-width: 860px; }
  .plate { display: flex; align-items: center; justify-content: space-between; margin: 0 6px 12px; color: #2b2d33; text-shadow: 0 1px 0 rgba(255,255,255,.55); }
  .plate b { font-size: 15px; letter-spacing: .32em; }
  .plate span { font-size: 11px; letter-spacing: .12em; }
  .screen {
    position: relative; overflow: hidden; border-radius: 14px; padding: 22px 24px 26px;
    background: rgba(2,2,4,.92);
    border-top: 2px solid #555; border-left: 2px solid #555; border-bottom: 2px solid #ccc; border-right: 2px solid #ccc;
    box-shadow: inset 0 10px 24px rgba(0,0,0,.9), inset 0 2px 10px rgba(0,0,0,.8), 0 0 16px rgba(155,124,255,.3), 0 6px 18px rgba(0,0,0,.35);
    text-shadow: var(--halation);
  }
  .screen::before { content: ""; position: absolute; inset: 0; pointer-events: none; z-index: 5; border-radius: inherit;
    background: radial-gradient(ellipse 80% 55% at 30% 6%, rgba(255,255,255,.10), transparent 70%), radial-gradient(ellipse 105% 105% at 50% 50%, transparent 58%, rgba(0,0,0,.35) 100%); }
  .screen::after { content: ""; position: absolute; inset: 0; pointer-events: none; z-index: 6; opacity: .55; mix-blend-mode: multiply;
    background: linear-gradient(rgba(18,16,16,0) 50%, rgba(0,0,0,.35) 50%), linear-gradient(90deg, rgba(255,0,0,.06), rgba(0,255,0,.02), rgba(0,0,255,.06));
    background-size: 100% 4px, 3px 100%; animation: flicker 6s infinite; }
  @keyframes flicker { 0%,100% { opacity: .55 } 48% { opacity: .5 } 50% { opacity: .62 } }
  .screen > * { position: relative; z-index: 2; }
  h2 { margin: 0 0 14px; font-size: 15px; letter-spacing: .2em; text-transform: uppercase; border-bottom: 1px solid var(--primary); padding-bottom: 8px; display: flex; justify-content: space-between; align-items: center; gap: 8px; }
  .led { display: inline-block; width: 9px; height: 9px; border-radius: 50%; background: #555; margin-right: 8px; vertical-align: middle; }
  .led.on { background: var(--success); box-shadow: 0 0 8px var(--success); animation: pulse 1.6s infinite; }
  .led.warn { background: var(--warn); box-shadow: 0 0 8px var(--warn); }
  .led.err { background: var(--danger); box-shadow: 0 0 8px var(--danger); }
  @keyframes pulse { 50% { opacity: .45 } }
  .section { margin-top: 18px; }
  .label { font-size: 11px; letter-spacing: .18em; text-transform: uppercase; color: var(--dim); margin-bottom: 6px; display: flex; justify-content: space-between; gap: 10px; }
  .bar { height: 22px; border: 1px solid var(--primary); border-radius: 3px; background: rgba(155,124,255,.06); box-shadow: inset 0 0 10px rgba(0,0,0,.8), 0 0 8px rgba(155,124,255,.25); overflow: hidden; }
  .fill { height: 100%; width: 0%; transition: width .8s ease;
    background: repeating-linear-gradient(90deg, var(--primary) 0 9px, transparent 9px 12px); box-shadow: 0 0 12px var(--primary); }
  .fill.dl { background: repeating-linear-gradient(90deg, #7fd8ff 0 9px, transparent 9px 12px); box-shadow: 0 0 12px #7fd8ff; }
  .fill.cur { background: repeating-linear-gradient(90deg, var(--success) 0 5px, transparent 5px 8px); }
  .row { display: flex; justify-content: space-between; font-size: 12px; margin-top: 5px; color: var(--text); gap: 10px; }
  .row .eta { color: var(--success); }
  .explain { margin-top: 16px; padding: 12px 14px; border: 1px dashed rgba(155,124,255,.55); border-radius: 4px; font-size: 13px; line-height: 1.55; background: rgba(155,124,255,.05); }
  .explain b { color: #fff; letter-spacing: .08em; }
  .log { margin-top: 14px; font-size: 11px; line-height: 1.5; color: var(--dim); max-height: 170px; overflow: auto; white-space: pre-wrap; word-break: break-word; text-shadow: none; opacity: .85; }
  .choice { display: grid; gap: 10px; grid-template-columns: 1fr 1fr; }
  @media (max-width: 640px) { .choice { grid-template-columns: 1fr; } }
  .opt { border: 1px solid rgba(155,124,255,.45); border-radius: 6px; padding: 12px; cursor: pointer; font-size: 12px; line-height: 1.5; color: var(--dim); }
  .opt input { display: none; }
  .opt b { display: block; color: var(--text); font-size: 13px; letter-spacing: .08em; text-transform: uppercase; margin-bottom: 4px; }
  .opt.sel { border-color: var(--primary); background: rgba(155,124,255,.12); box-shadow: 0 0 12px rgba(155,124,255,.35); color: var(--text); }
  .fields { display: grid; gap: 10px; grid-template-columns: 1fr 1fr; margin-top: 10px; }
  @media (max-width: 640px) { .fields { grid-template-columns: 1fr; } }
  .field label { display: block; font-size: 11px; letter-spacing: .14em; text-transform: uppercase; color: var(--dim); margin-bottom: 4px; }
  input[type=text], input[type=number] { width: 100%; background: rgba(0,0,0,.6); border: 1px solid rgba(155,124,255,.5); color: var(--text); font: inherit; font-size: 13px; padding: 8px 10px; border-radius: 4px; text-shadow: var(--halation); }
  input:focus { outline: none; border-color: var(--primary); box-shadow: 0 0 10px rgba(155,124,255,.45); }
  .btns { display: flex; gap: 10px; margin-top: 18px; flex-wrap: wrap; }
  button { font: inherit; font-weight: 700; font-size: 13px; letter-spacing: .18em; text-transform: uppercase; padding: 10px 20px; border-radius: 4px; cursor: pointer;
    color: var(--bg); background: var(--primary); border: 1px solid var(--primary); box-shadow: 0 0 14px rgba(155,124,255,.55); text-shadow: none; }
  button.ghost { background: transparent; color: var(--text); box-shadow: none; text-shadow: var(--halation); }
  button.danger { background: transparent; color: var(--danger); border-color: var(--danger); box-shadow: 0 0 10px rgba(255,84,154,.35); }
  button:disabled { opacity: .45; cursor: default; }
  button.soft { opacity: .45; }
  .update { border: 1px solid var(--warn); color: #ffe0b8; border-radius: 6px; padding: 12px 14px; margin-bottom: 16px; font-size: 13px; line-height: 1.5; box-shadow: 0 0 12px rgba(255,179,92,.3); }
  .update .btns { margin-top: 10px; }
  .board { font-size: 12px; line-height: 1.6; white-space: pre-wrap; color: var(--text); }
  details summary { cursor: pointer; font-size: 11px; letter-spacing: .18em; text-transform: uppercase; color: var(--dim); margin-top: 16px; }
  .hidden { display: none !important; }
  .muted { color: var(--dim); font-size: 12px; }
  .err { color: var(--danger); font-size: 12px; margin-top: 8px; }
  /* Champions: every tournament as a bracket narrowing to its champion. The canvas is laid out wide and scaled
     down to the window's width; the list scrolls vertically. */
  .chassis.wide { max-width: 1240px; }
  .lb-view { max-height: 72vh; overflow-y: auto; overflow-x: hidden; margin-top: 8px; padding-right: 4px; }
  .lb-sizer { position: relative; }
  .lb-canvas { width: 1180px; transform-origin: 0 0; position: absolute; top: 0; left: 0; }
  .bk { border: 1px solid rgba(155,124,255,.35); border-radius: 8px; padding: 12px 14px 14px; margin-bottom: 14px; background: rgba(155,124,255,.035); }
  .bk-head { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; margin-bottom: 10px; }
  .bk-head b { font-size: 14px; letter-spacing: .14em; text-transform: uppercase; }
  .bk-head span { font-size: 11px; color: var(--dim); }
  .bk-rank { color: var(--warn); margin-right: 10px; }
  .bk-grid { display: flex; align-items: stretch; gap: 0; }
  .bk-col { width: 150px; display: flex; flex-direction: column; }
  .bk-lab { font-size: 10px; letter-spacing: .16em; text-transform: uppercase; color: var(--dim); height: 18px; }
  .bk-slots { height: 296px; display: flex; flex-direction: column; justify-content: space-around; }
  .bk-pair { flex: 1; display: flex; flex-direction: column; justify-content: space-around; position: relative; margin-right: 22px; }
  .bk-pair.joined::after { content: ""; position: absolute; right: -12px; top: 25%; bottom: 25%; border: 1px solid rgba(155,124,255,.55); border-left: none; }
  .bk-pair.joined::before { content: ""; position: absolute; right: -22px; top: 50%; width: 10px; border-top: 1px solid rgba(155,124,255,.55); }
  .bk-slot { position: relative; height: 26px; display: flex; align-items: center; justify-content: space-between; gap: 6px; padding: 0 8px; font-size: 11px;
    border: 1px solid rgba(155,124,255,.35); border-radius: 3px; background: rgba(0,0,0,.45); color: var(--dim); }
  .bk-slot::after { content: ""; position: absolute; right: -13px; top: 50%; width: 12px; border-top: 1px solid rgba(155,124,255,.4); }
  .bk-slot.won { border-color: var(--primary); color: var(--text); background: rgba(155,124,255,.16); box-shadow: 0 0 8px rgba(155,124,255,.35); }
  .bk-slot.empty { opacity: .25; }
  .bk-champ { flex: 1; margin-left: 6px; border: 1px solid var(--primary); border-radius: 6px; padding: 10px 12px; background: rgba(155,124,255,.10); box-shadow: 0 0 16px rgba(155,124,255,.35); align-self: center; }
  .bk-champ.ok { border-color: var(--success); }
  .bk-champ .crown { font-size: 10px; letter-spacing: .2em; color: var(--warn); text-transform: uppercase; }
  .bk-champ h4 { margin: 2px 0 2px; font-size: 18px; letter-spacing: .1em; }
  .bk-champ .hl { font-size: 11px; color: var(--success); margin-bottom: 8px; }
  .bk-attrs { display: grid; grid-template-columns: auto 1fr; gap: 3px 12px; font-size: 11px; }
  .bk-attrs dt { color: var(--dim); white-space: nowrap; }
  .bk-attrs dd { margin: 0; color: var(--text); word-break: break-word; }
  .cond { margin-top: 18px; border-top: 1px solid rgba(255,255,255,0.08); padding-top: 12px; }
  .cond .muted { line-height: 1.45; }
</style>
</head>
<body>
<div class="chassis">
  <div class="plate"><b>KALSHI TRAINER</b><span id="ver">--</span></div>
  <div class="screen">
    <div id="update" class="update hidden"></div>
    <h2><span><span id="led" class="led"></span><span id="title">Connecting...</span></span><span id="clock" class="muted"></span></h2>

    <div id="idle" class="hidden">
      <div class="label">How should this run train?</div>
      <div class="choice">
        <label class="opt sel" id="opt-continue"><input type="radio" name="mode" value="continue" checked />
          <b>Continue where it left off</b>Downloads only what is new, then carries on the tournaments and retrains what is due. The normal choice.</label>
        <label class="opt" id="opt-full"><input type="radio" name="mode" value="full" />
          <b>Sweep everything again</b>The first round runs every step now, even the weekly ones: studies, tournaments, ablations, sweeps. Your models and history are kept. Takes much longer.</label>
      </div>
      <div class="fields">
        <div class="field"><label for="hours">Hours to train (0 = until it stops by itself)</label><input id="hours" type="number" min="0" step="0.5" value="0" /></div>
        <div class="field"><label>&nbsp;</label><div class="muted" id="stopsby">It stops when the bot reaches your target or stops improving.</div></div>
      </div>
      <details id="srv"><summary>Server (optional): copy recordings in, send better models back</summary>
        <div class="fields">
          <div class="field"><label for="host">Server address</label><input id="host" type="text" placeholder="leave empty to train on history only" /></div>
          <div class="field"><label for="user">SSH user</label><input id="user" type="text" placeholder="ubuntu" /></div>
          <div class="field" style="grid-column: 1 / -1"><label for="key">SSH key file (.pem)</label><input id="key" type="text" placeholder="C:\Users\you\Downloads\lightsail.pem" /></div>
        </div>
      </details>
      <div class="btns"><button id="start">Start training</button></div>
      <div id="startErr" class="err"></div>

      <div class="section cond" id="condBox">
        <div class="label"><span>Conditioning mode</span><span id="condState" class="muted"></span></div>
        <div class="muted">A pressure test of the freshly trained bot on days it has never seen, as live. Many instances trade the
          same windows: Tier 1 with $1000, Tier 2 $500, Tier 3 $200, then $100 on calm, trending, coin-volatile and market-wide
          volatile days (Tiers C, B, A, S), each 3 days, 2 days, 1 day. A window passes with $100 of profit still held at its
          end, never 35% down; the rest are culled. One that passes all 21 and beats the live settings is the Elite Champion
          and replaces them on the bot (the previous settings are kept for rollback). Up to 3 retrials on new days.</div>
        <div class="btns"><button id="condStart" disabled>Start conditioning</button></div>
        <div id="condWhy" class="muted"></div>
        <div id="condLast" class="muted"></div>
      </div>
    </div>

    <div id="run" class="hidden">
      <div class="section">
        <div class="label"><span>Downloads</span><span id="dlPct">0%</span></div>
        <div class="bar"><div id="dlFill" class="fill dl"></div></div>
        <div class="row"><span id="dlNote"></span><span class="eta" id="dlEta"></span></div>
      </div>
      <div class="section">
        <div class="label"><span>Training</span><span id="trPct">0%</span></div>
        <div class="bar"><div id="trFill" class="fill"></div></div>
        <div class="row"><span id="trNote"></span><span class="eta" id="trEta"></span></div>
      </div>
      <div class="section">
        <div class="label"><span id="curName">Current step</span><span id="curPct"></span></div>
        <div class="bar" style="height: 12px"><div id="curFill" class="fill cur"></div></div>
        <div class="row"><span id="curTask" class="muted"></span><span class="eta" id="curEta"></span></div>
      </div>
      <div class="explain" id="explain"></div>
      <div class="btns"><button id="stop" class="danger">Stop</button></div>
      <details><summary>Pipeline output</summary><div class="log" id="log"></div></details>
    </div>

    <div id="lbBox" class="section hidden">
      <div class="label"><span>Champions leaderboard</span><span id="lbNote"></span></div>
      <div class="lb-view" id="lbView"><div class="lb-sizer" id="lbSizer"><div class="lb-canvas" id="lbCanvas"></div></div></div>
    </div>

    <div id="boardBox" class="section hidden">
      <div class="label"><span>Last round</span></div>
      <div class="board" id="board"></div>
    </div>
  </div>
</div>
<script>
const token = new URLSearchParams(location.search).get('t') || '';
const $ = (id) => document.getElementById(id);
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Trainer-Token': token }, body: JSON.stringify(body || {}) }).then((r) => r.json());
const eta = (s) => s === null || s === undefined ? 'estimating...' : s <= 0 ? 'done' : s < 60 ? 'under a minute left' : (s < 3600 ? Math.round(s / 60) + ' min' : Math.floor(s / 3600) + ' h ' + (Math.round(s / 60) % 60) + ' min') + ' left';
const at = (s) => s > 0 ? ' · around ' + new Date(Date.now() + s * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
let filled = false;
for (const m of ['continue', 'full']) $('opt-' + m).addEventListener('click', () => { for (const n of ['continue', 'full']) $('opt-' + n).classList.toggle('sel', n === m); $('opt-' + m).querySelector('input').checked = true; });
$('hours').addEventListener('input', () => { const h = Number($('hours').value); $('stopsby').textContent = h > 0 ? 'It stops after ' + h + ' h, or earlier if the bot reaches your target or stops improving.' : 'It stops when the bot reaches your target or stops improving.'; });
$('start').addEventListener('click', async () => {
  $('startErr').textContent = '';
  const mode = document.querySelector('input[name=mode]:checked').value;
  const r = await post('/api/start', { mode, hours: Number($('hours').value) || 0, host: $('host').value.trim(), user: $('user').value.trim(), key: $('key').value.trim() });
  if (!r.ok) $('startErr').textContent = r.error || 'could not start';
});
let lastCond = null;
$('condStart').addEventListener('click', async () => {
  $('startErr').textContent = '';
  // Greyed out = not recommended (the bot wasn't freshly trained since the last conditioning run), not locked.
  const c = lastCond || { ready: false, why: '' };
  if (!c.ready && !confirm('Conditioning is not recommended right now: ' + (c.why || 'the bot was not freshly trained') + '.\n\nAre you sure you want to start it anyway?')) return;
  if (!confirm('Start conditioning mode? It runs until a champion is found or the trials are used up (hours on most computers).')) return;
  const r = await post('/api/start', { mode: 'conditioning', hours: 0, force: !c.ready, host: $('host').value.trim(), user: $('user').value.trim(), key: $('key').value.trim() });
  if (!r.ok) $('startErr').textContent = r.error || 'could not start';
});
$('stop').addEventListener('click', async () => { if (confirm('Stop training now? Finished steps and tournament rounds are kept; the step in progress starts again next time.')) await post('/api/stop'); });
function setBar(p, b, cls) {
  $(p + 'Fill').style.width = Math.max(0, Math.min(100, b.pct)).toFixed(1) + '%';
  $(p + 'Pct').textContent = Math.round(b.pct) + '%';
  $(p + 'Eta').textContent = eta(b.etaSec) + (b.etaSec > 0 ? at(b.etaSec) : '');
}
function renderUpdate(u, phase) {
  const el = $('update');
  if (!u || !u.available || u.dismissed) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  const when = u.publishedAt ? ' (built ' + new Date(u.publishedAt).toLocaleString() + ')' : '';
  if (u.installing) { el.innerHTML = '<b>Updating...</b> ' + (u.installing || ''); return; }
  if (!u.canInstall) { el.innerHTML = '<b>A new version of the trainer is available' + when + '.</b><br/>Download it from <a style="color:#ffe0b8" href="' + u.page + '" target="_blank">the release page</a> and unzip it over this folder (keep trainer-data).'; return; }
  el.innerHTML = '<b>A new version of the trainer is available' + when + '.</b><br/>Install it now? ' + (phase === 'running' ? 'Training stops first (finished steps are kept) and ' : '') + 'the trainer restarts by itself; your data and models are kept.<div class="btns"><button id="upYes">Install update</button><button id="upNo" class="ghost">Not now</button></div>';
  $('upYes').onclick = async () => { const r = await post('/api/update/install'); if (!r.ok) alert(r.error); };
  $('upNo').onclick = () => post('/api/update/later');
}
async function tick() {
  let s;
  try { s = await fetch('/api/state', { headers: { 'X-Trainer-Token': token } }).then((r) => r.json()); }
  catch { $('title').textContent = 'Trainer closed'; $('led').className = 'led err'; return; }
  if (s.error === 'token') { $('title').textContent = 'Open the trainer from its own window (Train.cmd)'; return; }
  $('ver').textContent = s.version ? 'build ' + s.version.slice(0, 7) : 'development build';
  $('clock').textContent = s.round ? 'round ' + s.round + (s.mode === 'full' && s.round === 1 ? ' · full sweep' : '') : '';
  const running = s.phase === 'running' || s.phase === 'stopping';
  $('idle').classList.toggle('hidden', running);
  $('run').classList.toggle('hidden', !running);
  $('led').className = 'led ' + (s.phase === 'running' ? 'on' : s.phase === 'stopping' ? 'warn' : s.lastError ? 'err' : '');
  const c = s.conditioning || { ready: false, why: '', last: null };
  lastCond = c;
  $('condStart').disabled = running;
  $('condStart').classList.toggle('soft', !c.ready);
  $('condStart').title = c.ready ? '' : 'Not recommended yet (you will be asked to confirm)';
  $('condState').textContent = c.ready ? 'ready' : 'not yet';
  $('condWhy').textContent = c.why || '';
  $('condLast').textContent = c.last ? 'Last run ' + new Date(c.last.at).toLocaleString() + ': ' + (c.last.elite ? 'Elite Champion ' + c.last.elite : 'no Elite; best ' + (c.last.best || 'none') + ', ' + c.last.bestPassed + ' of ' + c.last.windows + ' windows') : '';
  $('title').textContent = s.phase === 'running' ? (s.mode === 'conditioning' ? 'Conditioning' : 'Training') : s.phase === 'stopping' ? 'Stopping...' : s.lastStop ? 'Stopped: ' + s.lastStop : 'Ready';
  if (!filled && s.settings) { $('host').value = s.settings.host || ''; $('user').value = s.settings.user || ''; $('key').value = s.settings.key || ''; if (s.settings.host) $('srv').open = false; filled = true; }
  if (running && s.progress) {
    const p = s.progress;
    setBar('dl', p.downloads); setBar('tr', p.training);
    $('dlNote').textContent = p.downloads.pct >= 100 ? 'all data up to date' : 'only what is missing is downloaded';
    $('trNote').textContent = 'this round' + (s.hours ? ' · ' + s.hours + ' h budget' : ' · runs until it stops by itself');
    $('curName').textContent = p.step ? 'Now: ' + p.step : 'Now: ' + p.phase;
    $('curFill').style.width = (p.current.pct || 0).toFixed(1) + '%';
    $('curPct').textContent = p.current.pct ? Math.round(p.current.pct) + '%' : '';
    $('curTask').textContent = p.current.task || '';
    $('curEta').textContent = p.step ? eta(p.current.etaSec) : '';
    $('explain').innerHTML = '<b>What it is doing:</b> ' + p.explanation.replace(/</g, '&lt;');
    const log = $('log'); const atEnd = log.scrollTop + log.clientHeight >= log.scrollHeight - 8;
    log.textContent = p.log.join('\n'); if (atEnd) log.scrollTop = log.scrollHeight;
    $('stop').disabled = s.phase === 'stopping';
  }
  $('boardBox').classList.toggle('hidden', !(s.board && s.board.length));
  $('board').textContent = (s.board || []).join('\n');
  renderUpdate(s.update, s.phase);
}
const esc = (x) => String(x == null ? '' : x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const sc = (x) => x == null || !isFinite(x) ? '' : Math.abs(x) >= 100 ? x.toFixed(0) : x.toFixed(3);
function fitBoard() {
  const view = $('lbView'), canvas = $('lbCanvas');
  const s = Math.min(1, (view.clientWidth - 6) / canvas.offsetWidth);
  canvas.style.transform = 'scale(' + s + ')';
  $('lbSizer').style.height = Math.ceil(canvas.offsetHeight * s) + 'px';
}
function renderBoard(list) {
  $('lbBox').classList.toggle('hidden', !list.length);
  document.querySelector('.chassis').classList.toggle('wide', list.length > 0);
  if (!list.length) return;
  $('lbNote').textContent = list.length + ' champion' + (list.length > 1 ? 's' : '') + ' · each column: that round\'s best, narrowing to the champion';
  $('lbCanvas').innerHTML = list.map((b, bi) => {
    const cols = b.columns.map((c, ci) => {
      const per = c.entrants.length >= 2 ? 2 : 1;
      let pairs = '';
      for (let i = 0; i < Math.max(1, c.entrants.length); i += per) {
        const slots = c.entrants.slice(i, i + per).map((e) => '<div class="bk-slot' + (e.won ? ' won' : '') + (!e.name ? ' empty' : '') + '"><span>' + esc(e.name || '-') + '</span><span>' + sc(e.score) + '</span></div>').join('');
        pairs += '<div class="bk-pair' + (per === 2 ? ' joined' : '') + '">' + slots + '</div>';
      }
      return '<div class="bk-col"><div class="bk-lab">' + esc(c.label) + '</div><div class="bk-slots">' + pairs + '</div></div>';
    }).join('');
    const ch = b.champion;
    const attrs = ch.attrs.map((a) => '<dt>' + esc(a[0]) + '</dt><dd>' + esc(a[1]) + '</dd>').join('');
    return '<div class="bk"><div class="bk-head"><b><span class="bk-rank">#' + (bi + 1) + '</span>' + esc(b.title) + '</b><span>' + esc(b.subtitle) + '</span></div>'
      + '<div class="bk-grid">' + cols + '<div class="bk-champ' + (ch.validated ? ' ok' : '') + '"><div class="crown">Champion</div><h4>' + esc(ch.name) + '</h4><div class="hl">' + esc(ch.headline) + '</div><dl class="bk-attrs">' + attrs + '</dl></div></div></div>';
  }).join('');
  fitBoard();
}
async function loadBoard() { try { renderBoard(await fetch('/api/leaderboard', { headers: { 'X-Trainer-Token': token } }).then((r) => r.json())); } catch { /* trainer closed */ } }
window.addEventListener('resize', fitBoard);
tick(); setInterval(tick, 1000);
loadBoard(); setInterval(loadBoard, 30000);
</script>
</body>
</html>`;
