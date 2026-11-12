'use strict';

/* =====================================================================
   BenchSteps – offline-first lab protocol runner. No build step, no deps.
   Data lives in localStorage; optional sync goes through a private GitHub Gist.
   ===================================================================== */

/* ---------- helpers ---------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const fmtDate = ts => new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const fmtDateTime = ts => new Date(ts).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
function fmtDur(ms) {
  const t = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  const pad = n => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
function minLabel(m) {
  if (m >= 60 && Number.isInteger(m / 60)) return `${m / 60} h`;
  return Number.isInteger(m) ? `${m} min` : `${Math.round(m * 60)} s`;
}
const CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 12.5l5 5 10-11"/></svg>';

/* ---------- master mix calculator ---------- */
// A step may carry  calc = { margin: 10, components: [{ name, vol, inMix }] }
//   vol   = µL per reaction
//   inMix = false for things added to each well separately (e.g. template) – listed per well, never scaled into the mix.
// At the bench the user enters samples / replicates / extra wells; mix volumes = vol × wells × (1 + margin/100).
const CALC_PRESETS = {
  sybr: { label: 'qPCR – SYBR, 20 µL', margin: 10, components: [
    { name: '2× SYBR Green master mix', vol: 10, inMix: true },
    { name: 'Forward primer (10 µM)', vol: 0.4, inMix: true },
    { name: 'Reverse primer (10 µM)', vol: 0.4, inMix: true },
    { name: 'Nuclease-free water', vol: 7.2, inMix: true },
    { name: 'Template (cDNA)', vol: 2, inMix: false }] },
  taqman: { label: 'qPCR – TaqMan, 20 µL', margin: 10, components: [
    { name: '2× TaqMan master mix', vol: 10, inMix: true },
    { name: '20× primer/probe assay', vol: 1, inMix: true },
    { name: 'Nuclease-free water', vol: 7, inMix: true },
    { name: 'Template (cDNA)', vol: 2, inMix: false }] },
  blank: { label: 'Blank', margin: 10, components: [{ name: '', vol: undefined, inMix: true }] }
};
const presetCalc = key => structuredClone({ margin: CALC_PRESETS[key].margin, components: CALC_PRESETS[key].components });

function sanitizeCalc(c) {
  if (!c || typeof c !== 'object') return undefined;
  const components = (Array.isArray(c.components) ? c.components : []).map(x => ({
    name: String(x?.name ?? '').trim().slice(0, 80), vol: Number(x?.vol), inMix: x?.inMix !== false
  })).filter(x => x.name && x.vol > 0);
  if (!components.length) return undefined;
  const m = Number(c.margin);
  return { margin: m >= 0 && m <= 1000 ? m : 10, components };
}

// Format a volume in µL (up to 2 d.p., trailing zeros trimmed; large values also shown in mL).
function fmtVol(v) {
  const r = +v.toFixed(2);
  return `${r} µL` + (r >= 1000 ? ` (${+(r / 1000).toFixed(3)} mL)` : '');
}
function calcCompute(calc, cs) {
  const int = (x, min) => Math.max(min, Math.floor(Number(x)) || min);
  const n = Math.max(0, Math.floor(Number(cs.n)) || 0), reps = int(cs.reps, 1), extra = Math.max(0, Math.floor(Number(cs.extra)) || 0);
  const mRaw = cs.margin === undefined || cs.margin === '' ? calc.margin : Number(cs.margin);
  const margin = Number.isFinite(mRaw) && mRaw >= 0 ? mRaw : calc.margin;
  const wells = n * reps + extra, eff = wells * (1 + margin / 100);
  const rows = calc.components.map((x, j) => ({ j, name: x.name, vol: x.vol, inMix: x.inMix, total: x.inMix ? x.vol * eff : null }));
  const perWell = calc.components.filter(x => x.inMix).reduce((a, x) => a + x.vol, 0);
  return { n, reps, extra, margin, wells, eff, rows, perWell, mixTotal: perWell * eff };
}
const calcState = (pid, sid) => ((getRun(pid).calc ||= {})[sid] ||= { n: '', reps: 1, extra: 0, open: false, done: {} });

function calcOutHTML(s, cs) {
  const r = calcCompute(s.calc, cs);
  if (!r.n) return '<p class="calc-hint">Enter the number of samples to see volumes.</p>';
  const mixRows = r.rows.filter(x => x.inMix), wellRows = r.rows.filter(x => !x.inMix);
  return `<p class="calc-sum">${r.n} sample${r.n === 1 ? '' : 's'}${r.reps > 1 ? ` × ${r.reps} replicates` : ''}${r.extra ? ` + ${r.extra} extra` : ''}
      = <b>${r.wells} wells</b> · mix made for <b>${+r.eff.toFixed(2)}</b> reactions (+${+r.margin.toFixed(2)}%)</p>
    <ul class="calc-rows">${mixRows.map(x => `
      <li class="${cs.done[x.j] ? 'done' : ''}" data-a="calcTick" data-sid="${s.id}" data-j="${x.j}">
        <span class="tick">${CHECK}</span><span class="cname">${esc(x.name)}</span>
        <span class="cper">${+x.vol.toFixed(3)} µL ×</span><span class="ctot">${fmtVol(x.total)}</span></li>`).join('')}
    </ul>
    <p class="calc-total">Master mix total <b>${fmtVol(r.mixTotal)}</b> → dispense <b>${fmtVol(r.perWell)}</b> per well</p>
    ${wellRows.map(x => `<p class="calc-well">Then add <b>${fmtVol(x.vol)}</b> ${esc(x.name)} to each well</p>`).join('')}`;
}
function calcHTML(pid, s, forceOpen) {
  if (!s.calc) return '';
  const cs = calcState(pid, s.id);
  if (!forceOpen && !cs.open) return `<button class="timer-btn calc-btn" data-a="calcToggle" data-sid="${s.id}">🧪 Master mix calculator</button>`;
  return `<div class="calc" data-sid="${s.id}">
    <div class="calc-head"><b>🧪 Master mix calculator</b>${forceOpen ? '' : `<button class="link" data-a="calcToggle" data-sid="${s.id}">Hide</button>`}</div>
    <div class="calc-inputs">
      <label>Samples<input type="number" inputmode="numeric" min="0" step="1" data-cf="n" value="${esc(cs.n)}" placeholder="0"></label>
      <label>Replicates<input type="number" inputmode="numeric" min="1" step="1" data-cf="reps" value="${esc(cs.reps)}"></label>
      <label>Extra wells<input type="number" inputmode="numeric" min="0" step="1" data-cf="extra" value="${esc(cs.extra)}" title="e.g. no-template control, standards"></label>
      <label>Margin %<input type="number" inputmode="decimal" min="0" step="any" data-cf="margin" value="${esc(cs.margin ?? s.calc.margin)}"></label>
    </div>
    <div class="calc-out">${calcOutHTML(s, cs)}</div></div>`;
}

/* ---------- store ---------- */
const KEY = 'benchsteps.v1';

function seedProtocols() {
  const s = (text, note, minutes, calc) => ({ id: uid(), text, note: note || '', minutes, calc });
  return [
    {
      id: 'seed-miniprep', title: 'Plasmid miniprep (spin column)', updatedAt: 0,
      description: 'Example protocol – edit or delete it. Always follow your own kit manual for volumes and buffers.',
      steps: [
        s('Pellet 1–5 mL overnight culture', 'Spin 3 min at 8,000 g, discard supernatant'),
        s('Resuspend pellet in 250 µL Buffer P1', 'Make sure RNase A has been added. Vortex until no clumps remain'),
        s('Add 250 µL Buffer P2 and mix by inverting 4–6 times', 'Do not vortex', 5),
        s('Add 350 µL Buffer N3 and invert immediately 4–6 times', 'Solution should turn cloudy/white'),
        s('Centrifuge 10 min at max speed', 'Bench-top microcentrifuge', 10),
        s('Apply supernatant to the spin column', 'Spin 30–60 s, discard flow-through'),
        s('Wash with 750 µL Buffer PE', 'Spin 30–60 s, discard flow-through'),
        s('Dry spin 1 min', 'Removes residual ethanol', 1),
        s('Elute DNA', 'Add 30–50 µL EB to the membrane, stand 1 min, spin 1 min. Label and store at −20 °C', 1)
      ]
    },
    {
      id: 'seed-pbs', title: 'Make 1 L of 1× PBS', updatedAt: 0,
      description: 'Example protocol – edit or delete it.',
      steps: [
        s('Weigh out 8 g NaCl, 0.2 g KCl, 1.44 g Na₂HPO₄, 0.24 g KH₂PO₄'),
        s('Dissolve in ~800 mL dH₂O', 'Stir bar on a stir plate'),
        s('Adjust pH to 7.4', 'Use HCl / NaOH'),
        s('Make up to 1 L with dH₂O'),
        s('Autoclave or filter-sterilise', 'Liquid cycle, 20 min'),
        s('Label bottle and store at room temperature', 'Name, date, initials')
      ]
    },
    {
      id: 'seed-qpcr', title: 'qPCR plate setup (SYBR)', updatedAt: 0,
      description: 'Example protocol with a master mix calculator – edit or delete it. Volumes are typical starting points; check your master mix and primer concentrations.',
      steps: [
        s('Thaw reagents and keep on ice, protected from light', 'Vortex and briefly spin primers and cDNA'),
        s('Prepare the master mix', 'Enter your sample count, replicates and any extra wells (e.g. no-template control)', undefined, presetCalc('sybr')),
        s('Dispense master mix into each well', 'Reverse-pipette to avoid bubbles'),
        s('Add template to each well', 'Use water for the no-template control'),
        s('Seal the plate and spin briefly', 'e.g. 1 min at 1,000 g', 1),
        s('Load the plate and start the run', 'Use the cycling program for your master mix', undefined)
      ]
    }
  ];
}

function load() {
  try {
    const d = JSON.parse(localStorage.getItem(KEY));
    if (d && Array.isArray(d.protocols)) {
      return {
        protocols: d.protocols, runs: d.runs || {}, history: d.history || [],
        deleted: d.deleted || {}, prefs: d.prefs || {}, sync: d.sync || {}
      };
    }
  } catch { /* fall through to seed */ }
  return { protocols: seedProtocols(), runs: {}, history: [], deleted: {}, prefs: {}, sync: {} };
}
let store = load();
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(store)); }
  catch { toast('Could not save – browser storage is full or blocked'); }
}
const getP = id => store.protocols.find(p => p.id === id);
function getRun(pid) { return store.runs[pid] ||= { checked: {}, timers: {}, current: 0 }; }
const sortedProtocols = () => [...store.protocols].sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
// Progress counts required steps only; optional steps never block finishing.
const reqCount = p => p.steps.filter(s => !s.optional).length;
const doneCount = p => { const r = store.runs[p.id]; return r ? p.steps.filter(s => !s.optional && r.checked[s.id]).length : 0; };
const tickedCount = p => { const r = store.runs[p.id]; return r ? p.steps.filter(s => r.checked[s.id]).length : 0; };
const OPT_TAG = '<span class="opt-tag">Optional</span>';
const totalMinutes = p => p.steps.reduce((a, s) => a + (s.minutes || 0), 0);

function sanitizeProtocol(p) {
  if (!p || typeof p !== 'object') return null;
  const steps = (Array.isArray(p.steps) ? p.steps : []).map(s => {
    if (typeof s === 'string') s = { text: s };
    const m = Number(s?.minutes);
    return { id: String(s?.id || uid()), text: String(s?.text ?? '').trim(), note: String(s?.note ?? '').trim(), minutes: m > 0 ? m : undefined, optional: s?.optional ? true : undefined, calc: sanitizeCalc(s?.calc) };
  }).filter(s => s.text);
  const title = String(p.title ?? '').trim();
  if (!title) return null;
  return {
    id: String(p.id || uid()), title: title.slice(0, 200),
    description: String(p.description ?? '').trim(), steps, updatedAt: Number(p.updatedAt) || Date.now()
  };
}

/* ---------- toast / banner ---------- */
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

/* ---------- audio / timers ---------- */
let actx;
function ensureAudio() {
  try {
    actx ||= new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === 'suspended') actx.resume();
  } catch { /* no audio */ }
}
function beep() {
  ensureAudio();
  if (actx) {
    const t0 = actx.currentTime;
    [0, 0.35, 0.7].forEach(d => {
      const o = actx.createOscillator(), g = actx.createGain();
      o.frequency.value = 880; o.connect(g); g.connect(actx.destination);
      g.gain.setValueAtTime(0.0001, t0 + d);
      g.gain.exponentialRampToValueAtTime(0.4, t0 + d + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + d + 0.25);
      o.start(t0 + d); o.stop(t0 + d + 0.3);
    });
  }
  try { navigator.vibrate?.([300, 150, 300, 150, 300]); } catch { /* ignore */ }
}

let alerts = [];
function raiseAlert(pid, sid) {
  alerts.push({ pid, sid });
  beep(); renderBanner();
}
function renderBanner() {
  $('#banner').innerHTML = alerts.map((a, i) => {
    const p = getP(a.pid); if (!p) return '';
    const idx = p.steps.findIndex(s => s.id === a.sid);
    return `<div class="alert"><span>⏰ Timer done – step ${idx + 1} · ${esc(p.title)}</span>
      <button data-a="alertGo" data-i="${i}">Show</button><button data-a="alertClose" data-i="${i}" aria-label="Dismiss">✕</button></div>`;
  }).join('');
}

function timerHTML(pid, s) {
  if (!s.minutes) return '';
  const t = getRun(pid).timers[s.id];
  const label = minLabel(s.minutes);
  if (!t) return `<button class="timer-btn" data-a="tstart" data-sid="${s.id}">▶ Start ${label} timer</button>`;
  if (t.fired) return `<span class="timer done">✔ ${label} timer done</span><button class="timer-btn ghost" data-a="tstart" data-sid="${s.id}">Restart</button>`;
  return `<span class="timer run" data-tt="${s.id}">${fmtDur(t.end - Date.now())}</span><button class="timer-btn ghost" data-a="tstop" data-sid="${s.id}">Stop</button>`;
}

function tick() {
  const now = Date.now(); let changed = false;
  for (const [pid, run] of Object.entries(store.runs)) {
    for (const [sid, t] of Object.entries(run.timers || {})) {
      if (!t.fired && now >= t.end) {
        t.fired = true; changed = true;
        if (now - t.end < 6 * 3600e3) raiseAlert(pid, sid); // don't beep for timers that ended long ago
      }
    }
  }
  if (changed) { save(); view.refresh?.(); }
  if (view.pid) {
    const run = store.runs[view.pid];
    $$('[data-tt]').forEach(el => {
      const t = run?.timers[el.dataset.tt];
      if (t && !t.fired) el.textContent = fmtDur(t.end - now);
    });
  }
}
setInterval(tick, 250);

/* ---------- wake lock (keep screen on at the bench) ---------- */
let wakeLock = null, wantWake = false;
async function setWake(on) {
  wantWake = on;
  try {
    if (on && 'wakeLock' in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch { /* not allowed – ignore */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    if (wantWake) setWake(true);
    scheduleSync(500);
  }
});

/* ---------- routing ---------- */
const app = $('#app');
let view = {};
let routeCount = 0;
let pendingScroll = null;

function nav(hash, replace) {
  if (replace) location.replace(hash); else location.hash = hash;
}
function route() {
  routeCount++;
  setWake(false);
  document.body.classList.remove('no-scroll');
  window.scrollTo(0, 0);
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  if (!parts.length) return homeView();
  if (parts[0] === 'settings') return settingsView();
  if (parts[0] === 'new') return editorView(null);
  if (parts[0] === 'p') {
    const p = getP(parts[1]);
    if (!p) { toast('Protocol not found'); return nav('#/', true); }
    if (parts[2] === 'edit') return editorView(p.id);
    if (parts[2] === 'focus') return focusView(p);
    return runView(p);
  }
  nav('#/', true);
}
window.addEventListener('hashchange', route);

/* ---------- home ---------- */
let homeQuery = '';
function homeView() {
  view = { name: 'home' };
  app.innerHTML = `<div class="page">
    <header class="bar"><h1>BenchSteps</h1>
      <a class="icon-btn" href="#/settings" aria-label="Settings & sync">⚙</a>
      <a class="btn primary" href="#/new">＋ New</a></header>
    <div class="search"><input id="q" type="search" placeholder="Search protocols" value="${esc(homeQuery)}" aria-label="Search protocols"></div>
    <div id="list" class="cards"></div>
  </div>`;
  renderList();
}
function renderList() {
  const q = homeQuery.trim().toLowerCase();
  const items = sortedProtocols().filter(p => !q || (p.title + ' ' + p.description + ' ' + p.steps.map(s => s.text).join(' ')).toLowerCase().includes(q));
  $('#list').innerHTML = items.length ? items.map(p => {
    const n = p.steps.length, rn = reqCount(p), c = doneCount(p), started = tickedCount(p) > 0, mins = totalMinutes(p);
    const opt = n - rn;
    return `<a class="card" href="#/p/${encodeURIComponent(p.id)}">
      <h2>${esc(p.title)}</h2>
      ${p.description ? `<p>${esc(p.description)}</p>` : ''}
      <div class="meta"><span>${plural(n, 'step')}${opt ? ` (${opt} optional)` : ''}</span>${mins ? `<span>⏱ ${minLabel(Math.round(mins * 10) / 10)} timed</span>` : ''}
        ${started ? `<span class="badge">In progress · ${c}/${rn}</span>` : ''}</div>
      ${started ? `<div class="progress"><div style="width:${rn ? (c / rn) * 100 : 100}%"></div></div>` : ''}
    </a>`;
  }).join('') : `<div class="empty">${q ? 'No protocols match your search.' : 'No protocols yet.<br>Tap <b>＋ New</b> to add one.'}</div>`;
}

/* ---------- protocol: checklist ---------- */
const awakeOn = () => store.prefs.keepAwake !== false; // default on
const awakeSupported = 'wakeLock' in navigator;
function awakeBtn() {
  if (!awakeSupported) return '';
  return `<button class="btn ghost awake" data-a="awake" aria-pressed="${awakeOn()}">${awakeOn() ? '☀ Screen stays on' : '☾ Screen may sleep'}</button>`;
}

function runView(p) {
  setWake(awakeOn());
  view = { name: 'run', pid: p.id, refresh: refreshRun };
  const done = store.history.filter(h => h.pid === p.id);
  const last = done.length ? `Completed ${done.length}× · last ${fmtDate(done[done.length - 1].at)}` : '';
  app.innerHTML = `<div class="page">
    <header class="bar"><a class="icon-btn" href="#/" aria-label="Back to protocols">←</a>
      <h1>${esc(p.title)}</h1>
      <a class="icon-btn" href="#/p/${encodeURIComponent(p.id)}/edit" aria-label="Edit protocol">✎</a></header>
    <section class="hero">
      ${p.description ? `<p class="desc">${esc(p.description)}</p>` : ''}
      ${last ? `<p class="muted" style="margin:0 0 10px">${last}</p>` : ''}
      <div class="prog-line"><span id="prog-text"></span><span>${totalMinutes(p) ? '⏱ ' + minLabel(Math.round(totalMinutes(p) * 10) / 10) + ' timed' : ''}</span></div>
      <div class="progress"><div id="prog-bar"></div></div>
      <div class="actions">
        <button class="btn primary" data-a="focus" ${p.steps.length ? '' : 'disabled'}>⛶ Focus mode</button>
        <button class="btn" data-a="reset">Reset</button>
      </div>
      <div class="awake-row">${awakeBtn()}</div>
    </section>
    ${p.steps.length ? `<ol class="steps">${p.steps.map((s, i) => `
      <li class="step${s.optional ? ' optional' : ''}" data-sid="${s.id}">
        <button class="check" data-a="toggle" data-sid="${s.id}" aria-label="Step ${i + 1}${s.optional ? ' (optional)' : ''} done">${CHECK}</button>
        <div>
          <div class="step-body" data-a="toggle" data-sid="${s.id}">
            <div class="step-text"><span class="num">${i + 1}</span>${s.optional ? OPT_TAG : ''}${esc(s.text)}</div>
            ${s.note ? `<div class="note">${esc(s.note)}</div>` : ''}
          </div>
          <div class="timer-slot"></div>
        </div>
        <button class="icon-btn sm" data-a="focusAt" data-i="${i}" aria-label="Focus on step ${i + 1}" title="Focus on this step">⛶</button>
        <div class="calc-slot" data-sid="${s.id}">${calcHTML(p.id, s)}</div>
      </li>`).join('')}</ol>`
      : `<div class="empty">This protocol has no steps yet.<br><a class="link" href="#/p/${encodeURIComponent(p.id)}/edit">Add some</a></div>`}
    <div id="finish" class="finish" hidden><p>All required steps ticked 🎉</p><button class="btn primary" data-a="finish">Finish &amp; log run</button></div>
  </div>`;
  refreshRun();
  if (pendingScroll) {
    const el = $(`.step[data-sid="${pendingScroll}"]`);
    el?.scrollIntoView({ block: 'center' }); pendingScroll = null;
  }
}
function refreshRun() {
  const p = getP(view.pid); if (!p) return;
  const run = getRun(p.id), n = p.steps.length, rn = reqCount(p), opt = n - rn;
  $$('.step').forEach(li => {
    const s = p.steps.find(x => x.id === li.dataset.sid); if (!s) return;
    const d = !!run.checked[s.id];
    li.classList.toggle('done', d);
    $('.check', li).setAttribute('aria-pressed', d);
    $('.timer-slot', li).innerHTML = timerHTML(p.id, s);
  });
  const c = doneCount(p), t = tickedCount(p);
  $('#prog-text').textContent = opt
    ? `${c} of ${rn} required done · ${opt} optional`
    : `${c} of ${plural(n, 'step')} done`;
  $('#prog-bar').style.width = rn ? `${(c / rn) * 100}%` : (t ? '100%' : '0');
  $('#finish').hidden = !(n && c === rn && t > 0);
}

/* ---------- focus mode ---------- */
function focusStart(p) {
  const run = getRun(p.id);
  const i = p.steps.findIndex(s => !s.optional && !run.checked[s.id]); // resume at first unticked required step
  run.current = i < 0 ? 0 : i; save();
}
function focusView(p) {
  setWake(awakeOn());
  document.body.classList.add('no-scroll');
  view = { name: 'focus', pid: p.id, refresh: renderFocus };
  renderFocus();
}
function renderFocus() {
  const p = getP(view.pid); if (!p) return;
  const run = getRun(p.id), n = p.steps.length;
  const scale = store.prefs.scale || 1;
  const top = `<header class="focus-top">
      <button class="icon-btn" data-a="exit" aria-label="Exit focus mode">✕</button>
      <div class="focus-title">${esc(p.title)}</div>
      <div class="textsize"><button class="icon-btn" data-a="smaller" aria-label="Smaller text">A−</button><button class="icon-btn" data-a="bigger" aria-label="Larger text">A+</button></div>
    </header>`;
  if (!n) {
    app.innerHTML = `<div class="focus" style="--scale:${scale}">${top}<main class="focus-main"><div class="focus-inner complete"><div class="big">No steps</div><a class="btn primary" href="#/p/${encodeURIComponent(p.id)}/edit">Edit protocol</a></div></main></div>`;
    return;
  }
  run.current = Math.min(Math.max(run.current || 0, 0), n);
  const i = run.current;
  const c = doneCount(p), rn = reqCount(p), skippedOpt = n - rn - (tickedCount(p) - c);
  if (i >= n) {
    const missing = rn - c;
    app.innerHTML = `<div class="focus" style="--scale:${scale}">${top}
      <div class="progress"><div style="width:100%"></div></div>
      <main class="focus-main"><div class="focus-inner complete">
        <div class="big">${missing ? 'End of protocol' : 'Protocol complete 🎉'}</div>
        <div class="focus-note">${missing ? `${plural(missing, 'required step')} not ticked.` : `All ${plural(rn, 'required step')} done.`}${skippedOpt > 0 ? ` ${plural(skippedOpt, 'optional step')} skipped.` : ''}</div>
        <div class="stack">
          <button class="btn primary" data-a="finish">Finish &amp; log run</button>
          ${missing ? '<button class="btn" data-a="firstMissing">Go to first unticked required step</button>' : ''}
          <button class="btn ghost" data-a="prev">‹ Back to last step</button>
          <button class="btn ghost" data-a="exit">Show checklist</button>
        </div></div></main></div>`;
    return;
  }
  const s = p.steps[i], done = !!run.checked[s.id], next = p.steps[i + 1];
  app.innerHTML = `<div class="focus${done ? ' is-done-step' : ''}" style="--scale:${scale}">${top}
    <div class="progress"><div style="width:${rn ? (c / rn) * 100 : 0}%"></div></div>
    <main class="focus-main"><div class="focus-inner">
      <div class="focus-count">Step ${i + 1} of ${n}${s.optional ? ' · Optional' : ''}${done ? ' · ✔ done' : ''}</div>
      <div class="focus-text">${esc(s.text)}</div>
      ${s.note ? `<div class="focus-note">${esc(s.note)}</div>` : ''}
      <div class="timer-slot">${timerHTML(p.id, s)}</div>
      <div class="calc-slot">${calcHTML(p.id, s, true)}</div>
      ${next ? `<div class="focus-next">Next: ${esc(next.text.length > 90 ? next.text.slice(0, 90) + '…' : next.text)}</div>` : ''}
    </div></main>
    <footer class="focus-nav">
      <button class="btn" data-a="prev" ${i === 0 ? 'disabled' : ''} aria-label="Previous step">‹ Back</button>
      ${done ? '<button class="btn primary" data-a="skip">Next ›</button>' : '<button class="btn primary" data-a="done">✓ Done · Next</button>'}
      ${done ? '<button class="btn ghost" data-a="undo">Untick</button>' : '<button class="btn ghost" data-a="skip">Skip ›</button>'}
    </footer></div>`;
  $('.focus-main').scrollTop = 0;
}

/* ---------- editor ---------- */
let draft = null, dirty = false;
const newStep = () => ({ id: uid(), text: '', note: '', minutes: undefined });

function editorView(id) {
  const existing = id ? getP(id) : null;
  draft = existing ? structuredClone(existing) : { id: uid(), title: '', description: '', steps: [newStep()] };
  dirty = false;
  view = { name: 'edit', pid: id, isNew: !existing };
  renderEditor();
  if (!existing) $('#e-title').focus();
}
function syncDraft() {
  if (view.name !== 'edit') return;
  draft.title = $('#e-title').value;
  draft.description = $('#e-desc').value;
  $$('.step-edit').forEach((li, i) => {
    const s = draft.steps[i]; if (!s) return;
    s.text = $('.se-text', li).value;
    s.note = $('.se-note', li).value;
    const m = parseFloat($('.se-minutes', li).value);
    s.minutes = m > 0 ? m : undefined;
    s.optional = $('.se-optional', li).checked || undefined;
    if (s.calc) {
      const mg = parseFloat($('.cc-margin', li).value);
      s.calc.margin = mg >= 0 ? mg : 10;
      s.calc.components = $$('.cc-row', li).map(row => {
        const v = parseFloat($('.cc-vol', row).value);
        return { name: $('.cc-name', row).value, vol: v > 0 ? v : undefined, inMix: $('.cc-mix', row).checked };
      });
    }
  });
}
function calcEditHTML(s, i) {
  if (!s.calc) {
    return `<div class="calc-add"><span class="muted">🧪 Master mix calculator:</span>
      <button class="timer-btn" data-a="calcAdd" data-i="${i}" data-preset="sybr">qPCR SYBR</button>
      <button class="timer-btn" data-a="calcAdd" data-i="${i}" data-preset="taqman">qPCR TaqMan</button>
      <button class="timer-btn ghost" data-a="calcAdd" data-i="${i}" data-preset="blank">Blank</button></div>`;
  }
  return `<div class="calc-edit">
    <div class="ce-head"><b>🧪 Master mix calculator</b><button class="link" data-a="calcRemove" data-i="${i}">Remove</button></div>
    <p class="muted ce-help">Volumes are µL <b>per reaction</b>. Untick “in mix” for anything added to each well separately (e.g. template).</p>
    ${s.calc.components.map((c, j) => `
      <div class="cc-row">
        <input class="cc-name" type="text" placeholder="Component" value="${esc(c.name)}" aria-label="Component name">
        <input class="cc-vol" type="number" min="0" step="any" inputmode="decimal" placeholder="µL" value="${c.vol ?? ''}" aria-label="Volume per reaction (µL)">
        <label class="cc-mixlbl"><input type="checkbox" class="cc-mix" ${c.inMix !== false ? 'checked' : ''}> in mix</label>
        <button class="icon-btn sm" data-a="ccDel" data-i="${i}" data-j="${j}" aria-label="Remove component">✕</button>
      </div>`).join('')}
    <div class="ce-foot"><button class="timer-btn ghost" data-a="ccAdd" data-i="${i}">＋ Component</button>
      <label class="ce-margin">Safety margin <input class="cc-margin" type="number" min="0" step="any" inputmode="decimal" value="${s.calc.margin ?? 10}"> %</label></div>
  </div>`;
}
function autosize(el) { el.style.height = 'auto'; el.style.height = el.scrollHeight + 4 + 'px'; }
function renderEditor() {
  const back = view.isNew ? '#/' : `#/p/${encodeURIComponent(draft.id)}`;
  app.innerHTML = `<div class="page">
    <header class="bar"><button class="icon-btn" data-a="cancel" aria-label="Cancel">←</button>
      <h1>${view.isNew ? 'New protocol' : 'Edit protocol'}</h1>
      <button class="btn primary" data-a="save">Save</button></header>
    <label class="field"><span>Title</span><input id="e-title" class="title-input" type="text" maxlength="200" placeholder="e.g. Western blot transfer" value="${esc(draft.title)}"></label>
    <label class="field"><span>Description (optional)</span><textarea id="e-desc" rows="2" placeholder="Purpose, reagents, safety notes…">${esc(draft.description)}</textarea></label>
    <div class="field"><span>Steps</span></div>
    <ol class="edit-steps">${draft.steps.map((s, i) => `
      <li class="step-edit">
        <div class="se-head"><span class="num">Step ${i + 1}</span>
          <label class="se-opt"><input type="checkbox" class="se-optional" ${s.optional ? 'checked' : ''}> Optional</label>
          <div class="se-tools">
            <button class="icon-btn sm" data-a="up" data-i="${i}" aria-label="Move up" ${i === 0 ? 'disabled' : ''}>↑</button>
            <button class="icon-btn sm" data-a="down" data-i="${i}" aria-label="Move down" ${i === draft.steps.length - 1 ? 'disabled' : ''}>↓</button>
            <button class="icon-btn sm" data-a="del" data-i="${i}" aria-label="Delete step">✕</button>
          </div></div>
        <textarea class="se-text" rows="2" placeholder="What to do">${esc(s.text)}</textarea>
        <div class="se-extra">
          <input class="se-note" type="text" placeholder="Note, volume, reagent… (optional)" value="${esc(s.note)}">
          <input class="se-minutes" type="number" min="0" step="any" inputmode="decimal" placeholder="⏱ min" value="${s.minutes ?? ''}" aria-label="Timer minutes">
        </div>
        ${calcEditHTML(s, i)}
      </li>`).join('')}</ol>
    <div class="add-row"><button class="btn" data-a="add">＋ Add step</button><button class="btn" data-a="paste">Paste steps…</button></div>
    ${view.isNew ? '' : `<div class="danger-zone"><button class="btn" data-a="duplicate">Duplicate</button><button class="btn danger" data-a="deleteP">Delete protocol</button></div>`}
  </div>`;
  $$('.se-text').forEach(autosize);
  app.dataset.back = back;
}

function saveDraft() {
  syncDraft();
  if (!draft.title.trim()) { toast('Give the protocol a title'); $('#e-title').focus(); return; }
  const p = sanitizeProtocol({ ...draft, updatedAt: Date.now() });
  const i = store.protocols.findIndex(x => x.id === p.id);
  if (i >= 0) store.protocols[i] = p; else store.protocols.push(p);
  delete store.deleted[p.id];
  touched(); dirty = false;
  nav(`#/p/${encodeURIComponent(p.id)}`, true);
}

/* ---------- settings / sync / backup ---------- */
let deferredInstall = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredInstall = e; if (view.name === 'settings') settingsView(); });

function settingsView() {
  view = { name: 'settings', refresh: settingsView };
  const sy = store.sync, on = !!sy.token;
  app.innerHTML = `<div class="page">
    <header class="bar"><a class="icon-btn" href="#/" aria-label="Back">←</a><h1>Settings &amp; sync</h1></header>

    <section class="hero"><h2>Sync between devices</h2>
      <p class="muted">Protocols are synced through a <b>private GitHub Gist</b> in your own account – no other server involved. Newest edit wins per protocol. Checklist progress stays on each device.</p>
      ${on ? `
        <p><b>Connected.</b> ${sy.syncing ? 'Syncing…' : sy.last ? 'Last synced ' + fmtDateTime(sy.last) : 'Not synced yet'}
          ${sy.error ? `<br><span style="color:var(--danger)">⚠ ${esc(sy.error)}</span>` : ''}</p>
        <p class="muted">Gist ID (enter this on your other devices):<br><code>${esc(sy.gistId || '— created on first sync —')}</code></p>
        <div class="actions"><button class="btn primary" data-a="syncNow">Sync now</button><button class="btn danger" data-a="disconnect">Disconnect</button></div>
      ` : `
        <label class="field"><span>GitHub token (classic, “gist” scope only)</span><input id="s-token" type="password" autocomplete="off" spellcheck="false" placeholder="ghp_…"></label>
        <label class="field"><span>Gist ID (leave empty on your first device)</span><input id="s-gist" type="text" autocomplete="off" spellcheck="false" placeholder="e.g. 8f2c…"></label>
        <button class="btn primary block" data-a="connect">Connect &amp; sync</button>
        <details style="margin-top:14px"><summary class="link">How do I get a token?</summary>
          <ol class="muted"><li>On GitHub: Settings → Developer settings → Personal access tokens → <i>Tokens (classic)</i> → Generate new token (classic).</li>
          <li>Tick only <b>gist</b>, set an expiry, generate and copy it.</li>
          <li>Paste it above. On the first device leave Gist ID empty; the app creates a private gist and shows its ID.</li>
          <li>On each other device, paste the same token <i>and</i> the Gist ID.</li></ol>
          <p class="muted">The token is stored only in this browser on this device. Anyone with it can read/write your gists, so use a short expiry.</p>
        </details>`}
    </section>

    <section class="hero"><h2>Display</h2>
      <p class="muted">Keep the screen on while a protocol is open (checklist and focus mode), so it doesn't dim mid-experiment.</p>
      ${awakeSupported ? awakeBtn() : '<p class="muted">Not supported by this browser.</p>'}
    </section>

    <section class="hero"><h2>Backup</h2>
      <p class="muted">Export protocols to a JSON file or import one (also a way to share protocols with colleagues).</p>
      <div class="actions"><button class="btn" data-a="export">Export</button><button class="btn" data-a="import">Import…</button></div>
      <input type="file" id="file" accept=".json,application/json" hidden>
    </section>

    ${deferredInstall ? `<section class="hero"><h2>Install</h2><button class="btn primary" data-a="install">Install BenchSteps on this device</button></section>` : ''}
  </div>`;
}

function exportJSON() {
  const data = { app: 'benchsteps', version: 1, protocols: store.protocols };
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  a.download = `benchsteps-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
async function importFile(file) {
  try {
    const d = JSON.parse(await file.text());
    const list = (Array.isArray(d) ? d : d.protocols || []).map(sanitizeProtocol).filter(Boolean);
    if (!list.length) return toast('No protocols found in that file');
    list.forEach(p => {
      p.updatedAt = Date.now();
      const i = store.protocols.findIndex(x => x.id === p.id);
      if (i >= 0) store.protocols[i] = p; else store.protocols.push(p);
      delete store.deleted[p.id];
    });
    touched(); toast(`Imported ${plural(list.length, 'protocol')}`);
  } catch { toast('That file could not be read'); }
}

/* ---------- sync (private Gist, last-write-wins per protocol) ---------- */
const GIST_FILE = 'benchsteps.json';
let syncing = false, syncAgain = false, syncTimer;

function merge(localP, localDel, remoteP, remoteDel) {
  const deleted = { ...remoteDel };
  for (const [id, t] of Object.entries(localDel)) deleted[id] = Math.max(deleted[id] || 0, t);
  const map = new Map();
  for (const p of [...remoteP, ...localP]) {
    const cur = map.get(p.id);
    if (!cur || (p.updatedAt || 0) > (cur.updatedAt || 0)) map.set(p.id, p);
  }
  for (const [id, t] of Object.entries(deleted)) {
    const p = map.get(id);
    if (p && (p.updatedAt || 0) <= t) map.delete(id);
  }
  return { protocols: [...map.values()], deleted };
}
function sameData(aP, aDel, bP, bDel) {
  if (aP.length !== bP.length) return false;
  const m = new Map(bP.map(p => [p.id, p.updatedAt || 0]));
  if (!aP.every(p => m.get(p.id) === (p.updatedAt || 0))) return false;
  const ka = Object.keys(aDel), kb = Object.keys(bDel);
  return ka.length === kb.length && ka.every(k => bDel[k] === aDel[k]);
}
async function gh(path, opts = {}) {
  const r = await fetch('https://api.github.com' + path, {
    cache: 'no-store', ...opts,
    headers: { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + store.sync.token, 'Content-Type': 'application/json' }
  });
  if (r.status === 401) throw new Error('GitHub rejected the token (expired or wrong).');
  if (r.status === 404) throw new Error('Gist not found – check the Gist ID and that the token belongs to the same account.');
  if (!r.ok) throw new Error(`GitHub error ${r.status}`);
  return r.json();
}
function scheduleSync(delay = 2000) {
  if (!store.sync.token) return;
  clearTimeout(syncTimer); syncTimer = setTimeout(syncNow, delay);
}
function touched() { save(); scheduleSync(); }

async function syncNow(manual) {
  const sy = store.sync;
  if (!sy.token) return;
  if (!navigator.onLine) { if (manual === true) toast('Offline – will sync later'); return; }
  if (syncing) { syncAgain = true; return; }
  syncing = true; sy.syncing = true; sy.error = '';
  if (view.name === 'settings') settingsView();
  try {
    let remote = null;
    if (sy.gistId) {
      const g = await gh(`/gists/${encodeURIComponent(sy.gistId)}`);
      const f = g.files?.[GIST_FILE];
      if (f) {
        const text = f.truncated ? await (await fetch(f.raw_url, { cache: 'no-store' })).text() : f.content;
        const d = JSON.parse(text);
        remote = { protocols: (d.protocols || []).map(sanitizeProtocol).filter(Boolean), deleted: d.deleted || {} };
      }
    }
    const m = remote ? merge(store.protocols, store.deleted, remote.protocols, remote.deleted) : { protocols: store.protocols, deleted: store.deleted };
    const localChanged = remote && !sameData(m.protocols, m.deleted, store.protocols, store.deleted);
    store.protocols = m.protocols; store.deleted = m.deleted;
    const remoteStale = !remote || !sameData(m.protocols, m.deleted, remote.protocols, remote.deleted);
    if (remoteStale) {
      const files = { [GIST_FILE]: { content: JSON.stringify({ app: 'benchsteps', version: 1, protocols: m.protocols, deleted: m.deleted }, null, 1) } };
      if (!sy.gistId) {
        const g = await gh('/gists', { method: 'POST', body: JSON.stringify({ description: 'BenchSteps protocols (sync)', public: false, files }) });
        sy.gistId = g.id;
      } else {
        await gh(`/gists/${encodeURIComponent(sy.gistId)}`, { method: 'PATCH', body: JSON.stringify({ files }) });
      }
    }
    sy.last = Date.now();
    if (localChanged) toast('Synced – updates received');
    else if (manual === true) toast('Synced');
  } catch (e) {
    sy.error = e.message === 'Failed to fetch' ? 'Could not reach GitHub.' : e.message;
    if (manual === true) toast(sy.error);
  } finally {
    syncing = false; sy.syncing = false; save();
    if (view.name === 'settings') settingsView();
    else if (view.name === 'home') renderList();
    if (syncAgain) { syncAgain = false; scheduleSync(300); }
  }
}

/* ---------- actions ---------- */
const A = {
  /* checklist */
  toggle(el) {
    const run = getRun(view.pid), sid = el.dataset.sid;
    if (run.checked[sid]) delete run.checked[sid]; else run.checked[sid] = true;
    save(); view.refresh();
  },
  focus() { focusStart(getP(view.pid)); nav(`#/p/${encodeURIComponent(view.pid)}/focus`); },
  focusAt(el) { getRun(view.pid).current = +el.dataset.i; save(); nav(`#/p/${encodeURIComponent(view.pid)}/focus`); },
  reset() {
    const run = getRun(view.pid);
    if (Object.keys(run.checked).length || Object.keys(run.timers).length) {
      if (!confirm('Reset progress and timers for this protocol?')) return;
    }
    store.runs[view.pid] = { checked: {}, timers: {}, current: 0 }; save(); view.refresh();
  },
  finish() {
    const p = getP(view.pid);
    store.history.push({ pid: p.id, title: p.title, at: Date.now(), steps: p.steps.length, done: doneCount(p) });
    store.runs[p.id] = { checked: {}, timers: {}, current: 0 }; save();
    toast('Run logged – checklist reset');
    nav(`#/p/${encodeURIComponent(p.id)}`, true);
  },

  /* timers */
  tstart(el) {
    ensureAudio();
    const p = getP(view.pid), s = p.steps.find(x => x.id === el.dataset.sid);
    getRun(p.id).timers[s.id] = { end: Date.now() + s.minutes * 60000 };
    save(); view.refresh();
  },
  tstop(el) { delete getRun(view.pid).timers[el.dataset.sid]; save(); view.refresh(); },
  alertGo(el) {
    const a = alerts[+el.dataset.i]; if (!a) return;
    alerts.splice(+el.dataset.i, 1); renderBanner();
    pendingScroll = a.sid;
    const hash = `#/p/${encodeURIComponent(a.pid)}`;
    if (location.hash === hash) runView(getP(a.pid)); else nav(hash);
  },
  alertClose(el) { alerts.splice(+el.dataset.i, 1); renderBanner(); },

  /* focus mode */
  exit() { if (routeCount > 1) history.back(); else nav(`#/p/${encodeURIComponent(view.pid)}`, true); },
  done() {
    const p = getP(view.pid), run = getRun(p.id), s = p.steps[run.current];
    if (s) run.checked[s.id] = true;
    run.current = Math.min(run.current + 1, p.steps.length); save(); renderFocus();
  },
  skip() { const p = getP(view.pid), run = getRun(p.id); run.current = Math.min(run.current + 1, p.steps.length); save(); renderFocus(); },
  prev() { const run = getRun(view.pid), n = getP(view.pid).steps.length; run.current = Math.max(0, Math.min(run.current, n) - 1); save(); renderFocus(); },
  undo() { const p = getP(view.pid), run = getRun(p.id), s = p.steps[run.current]; if (s) delete run.checked[s.id]; save(); renderFocus(); },
  firstMissing() { const p = getP(view.pid), run = getRun(p.id); run.current = Math.max(0, p.steps.findIndex(s => !s.optional && !run.checked[s.id])); save(); renderFocus(); },
  bigger() { store.prefs.scale = Math.min(1.9, +((store.prefs.scale || 1) + 0.15).toFixed(2)); save(); renderFocus(); },
  smaller() { store.prefs.scale = Math.max(0.7, +((store.prefs.scale || 1) - 0.15).toFixed(2)); save(); renderFocus(); },

  /* editor */
  add() { syncDraft(); draft.steps.push(newStep()); dirty = true; renderEditor(); const t = $$('.se-text'); t[t.length - 1].focus(); },
  del(el) {
    syncDraft(); draft.steps.splice(+el.dataset.i, 1);
    if (!draft.steps.length) draft.steps.push(newStep());
    dirty = true; renderEditor();
  },
  up(el) { move(+el.dataset.i, -1); },
  down(el) { move(+el.dataset.i, 1); },
  calcAdd(el) { syncDraft(); draft.steps[+el.dataset.i].calc = presetCalc(el.dataset.preset); dirty = true; renderEditor(); },
  calcRemove(el) {
    syncDraft(); const s = draft.steps[+el.dataset.i];
    if (s.calc.components.some(c => c.name || c.vol) && !confirm('Remove the calculator from this step?')) return;
    delete s.calc; dirty = true; renderEditor();
  },
  ccAdd(el) { syncDraft(); draft.steps[+el.dataset.i].calc.components.push({ name: '', vol: undefined, inMix: true }); dirty = true; renderEditor(); const n = $$('.step-edit')[+el.dataset.i].querySelectorAll('.cc-name'); n[n.length - 1].focus(); },
  ccDel(el) {
    syncDraft(); const c = draft.steps[+el.dataset.i].calc.components; c.splice(+el.dataset.j, 1);
    if (!c.length) c.push({ name: '', vol: undefined, inMix: true });
    dirty = true; renderEditor();
  },

  /* run-time calculator */
  calcToggle(el) {
    const cs = calcState(view.pid, el.dataset.sid); cs.open = !cs.open; save();
    const slot = $(`.calc-slot[data-sid="${el.dataset.sid}"]`);
    if (slot) slot.innerHTML = calcHTML(view.pid, getP(view.pid).steps.find(x => x.id === el.dataset.sid));
  },
  calcTick(el) {
    const cs = calcState(view.pid, el.dataset.sid), j = el.dataset.j;
    if (cs.done[j]) delete cs.done[j]; else cs.done[j] = true;
    save(); el.classList.toggle('done', !!cs.done[j]);
  },
  paste() { $('#pasteText').value = ''; $('#pasteDlg').showModal(); $('#pasteText').focus(); },
  save: saveDraft,
  cancel() {
    syncDraft();
    if (dirty && !confirm('Discard your changes?')) return;
    dirty = false;
    nav(view.isNew ? '#/' : `#/p/${encodeURIComponent(draft.id)}`, true);
  },
  duplicate() {
    syncDraft();
    const c = sanitizeProtocol({ ...draft, id: uid(), title: draft.title + ' (copy)', steps: draft.steps.map(s => ({ ...s, id: uid() })), updatedAt: Date.now() });
    if (!c) return toast('Give the protocol a title first');
    store.protocols.push(c); touched(); dirty = false; toast('Duplicated');
    nav(`#/p/${encodeURIComponent(c.id)}/edit`, true);
  },
  deleteP() {
    if (!confirm(`Delete “${draft.title || 'this protocol'}”? This also removes it from synced devices and can't be undone.`)) return;
    store.protocols = store.protocols.filter(p => p.id !== draft.id);
    store.deleted[draft.id] = Date.now(); delete store.runs[draft.id];
    touched(); dirty = false; nav('#/', true);
  },

  /* settings */
  connect() {
    const token = $('#s-token').value.trim(), gist = $('#s-gist').value.trim();
    if (!token) return toast('Paste a GitHub token first');
    store.sync = { token, gistId: gist || '' }; save(); syncNow(true);
  },
  awake() {
    store.prefs.keepAwake = !awakeOn(); save();
    if (view.name === 'run' || view.name === 'focus') setWake(awakeOn());
    $$('.awake').forEach(b => { b.setAttribute('aria-pressed', awakeOn()); b.textContent = awakeOn() ? '☀ Screen stays on' : '☾ Screen may sleep'; });
    toast(awakeOn() ? 'Screen will stay on' : 'Screen may sleep normally');
  },
  syncNow() { syncNow(true); },
  disconnect() { if (confirm('Disconnect sync on this device? Your local protocols are kept.')) { store.sync = {}; save(); settingsView(); } },
  export: exportJSON,
  import() { $('#file').click(); },
  async install() { deferredInstall?.prompt(); await deferredInstall?.userChoice; deferredInstall = null; settingsView(); }
};
function move(i, d) {
  syncDraft(); const j = i + d;
  if (j < 0 || j >= draft.steps.length) return;
  [draft.steps[i], draft.steps[j]] = [draft.steps[j], draft.steps[i]];
  dirty = true; renderEditor();
  $$('.step-edit')[j]?.scrollIntoView({ block: 'nearest' });
}

document.addEventListener('click', e => {
  const el = e.target.closest('[data-a]');
  if (el && A[el.dataset.a]) A[el.dataset.a](el, e);
});
document.addEventListener('input', e => {
  if (e.target.id === 'q') { homeQuery = e.target.value; renderList(); }
  else if (e.target.dataset.cf) { // calculator inputs: update results in place so typing isn't interrupted
    const box = e.target.closest('.calc'), s = getP(view.pid)?.steps.find(x => x.id === box?.dataset.sid);
    if (!s) return;
    const cs = calcState(view.pid, s.id); cs[e.target.dataset.cf] = e.target.value; save();
    $('.calc-out', box).innerHTML = calcOutHTML(s, cs);
  }
  else if (view.name === 'edit') { dirty = true; if (e.target.classList.contains('se-text')) autosize(e.target); }
});
document.addEventListener('change', e => {
  if (e.target.id === 'file' && e.target.files[0]) importFile(e.target.files[0]).then(() => { e.target.value = ''; });
});
$('#pasteDlg').addEventListener('close', () => {
  if ($('#pasteDlg').returnValue !== 'add') return;
  const lines = $('#pasteText').value.split(/\r?\n/).map(l => l.replace(/^\s*(?:\d+[.)]|[-*•])\s+/, '').trim()).filter(Boolean);
  if (!lines.length) return;
  syncDraft();
  if (draft.steps.length === 1 && !draft.steps[0].text.trim() && !draft.steps[0].note.trim()) draft.steps = [];
  lines.forEach(text => draft.steps.push({ ...newStep(), text }));
  dirty = true; renderEditor();
});
window.addEventListener('beforeunload', e => { if (view.name === 'edit' && dirty) { e.preventDefault(); e.returnValue = ''; } });

/* keyboard (desktop) in focus mode */
document.addEventListener('keydown', e => {
  if (view.name !== 'focus' || e.ctrlKey || e.metaKey || e.altKey) return;
  const inField = e.target.closest('button, input, textarea, a');
  if (e.key === 'ArrowRight') A.skip();
  else if (e.key === 'ArrowLeft') A.prev();
  else if (e.key === 'Escape') A.exit();
  else if ((e.key === 'Enter' || e.key === ' ') && !inField) {
    e.preventDefault();
    const p = getP(view.pid), run = getRun(p.id);
    if (run.current >= p.steps.length) return;
    run.checked[p.steps[run.current].id] ? A.skip() : A.done();
  }
});
/* swipe (phone) in focus mode */
let touch0 = null;
document.addEventListener('touchstart', e => { touch0 = view.name === 'focus' && e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null; }, { passive: true });
document.addEventListener('touchend', e => {
  if (!touch0 || view.name !== 'focus') return;
  const dx = e.changedTouches[0].clientX - touch0.x, dy = e.changedTouches[0].clientY - touch0.y;
  touch0 = null;
  if (Math.abs(dx) > 70 && Math.abs(dy) < 60) dx < 0 ? A.skip() : A.prev();
}, { passive: true });

/* ---------- boot ---------- */
route();
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => { /* offline support optional */ });
}
scheduleSync(800);
