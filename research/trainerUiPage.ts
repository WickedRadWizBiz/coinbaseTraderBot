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
  .update { border: 1px solid var(--warn); color: #ffe0b8; border-radius: 6px; padding: 12px 14px; margin-bottom: 16px; font-size: 13px; line-height: 1.5; box-shadow: 0 0 12px rgba(255,179,92,.3); }
  .update .btns { margin-top: 10px; }
  .board { font-size: 12px; line-height: 1.6; white-space: pre-wrap; color: var(--text); }
  details summary { cursor: pointer; font-size: 11px; letter-spacing: .18em; text-transform: uppercase; color: var(--dim); margin-top: 16px; }
  .hidden { display: none !important; }
  .muted { color: var(--dim); font-size: 12px; }
  .err { color: var(--danger); font-size: 12px; margin-top: 8px; }
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
  $('title').textContent = s.phase === 'running' ? 'Training' : s.phase === 'stopping' ? 'Stopping...' : s.lastStop ? 'Stopped: ' + s.lastStop : 'Ready';
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
tick(); setInterval(tick, 1000);
</script>
</body>
</html>`;
