// Sensor test page (milestone 1).
// Answers, on real phones on the real beach:
//   - how much does GPS actually drift standing still, raw vs smoothed?
//   - does the compass give a usable heading, flat in hand AND upright in a pocket?
//   - do GPS and audio keep running with the wake lock / pocket mode on?
//   - how far apart are phone clocks? how fast does the battery drop?

import { makeLocalFrame } from '../../shared/geo.js';
import { PositionSmoother, HeadingSmoother, angleDiff } from '../../shared/smoothing.js';
import { requestCompassPermission, startCompass } from '../../shared/compass.js';
import { WakeLock, PocketMode } from '../../shared/keepalive.js';

const $ = (id) => document.getElementById(id);
const fmt = (v, d = 1, unit = '') => (v === null || v === undefined || Number.isNaN(v)) ? '–' : v.toFixed(d) + unit;

// ---------- state ----------
let running = false;
let watchId = null;
let compass = null;
let frame = null;                 // local metres frame, origin = first fix
const posSmoother = new PositionSmoother(0.3);
const hdgSmoother = new HeadingSmoother(0.2);
let drift = [];                   // { x, y, sx, sy } in metres
let lastFixMs = null;
let fixIntervals = [];
let lastCompass = null;
let smoothedHeading = null;
let compassCount = 0, compassRate = 0;
let lastCompassLogMs = 0;
let targetHeading = null;
let startMs = null;
let gapCount = 0;
let battery = null;

const log = { fixes: [], compass: [], events: [] };

function event(msg) {
  const t = new Date();
  log.events.push({ t: t.toISOString(), msg });
  const li = document.createElement('li');
  li.textContent = `${t.toTimeString().slice(0, 8)}  ${msg}`;
  $('events').prepend(li);
}

// ---------- GPS ----------
function onFix(pos) {
  const c = pos.coords;
  const now = Date.now();
  if (!frame) frame = makeLocalFrame(c.latitude, c.longitude);

  if (lastFixMs !== null) {
    const dt = now - lastFixMs;
    fixIntervals.push(dt);
    if (fixIntervals.length > 10) fixIntervals.shift();
    if (dt > 5000) {
      gapCount++;
      $('gaps').textContent = gapCount;
      event(`GPS gap ${(dt / 1000).toFixed(1)} s (page ${document.visibilityState})`);
    }
  }
  lastFixMs = now;

  const [x, y] = frame.toXY(c.latitude, c.longitude);
  const [sx, sy] = posSmoother.push(x, y);
  const [slat, slng] = frame.toLatLng(sx, sy);
  drift.push({ x, y, sx, sy });

  log.fixes.push({
    t: new Date(pos.timestamp).toISOString(),
    lat: c.latitude, lng: c.longitude, acc: c.accuracy,
    alt: c.altitude, altAcc: c.altitudeAccuracy, speed: c.speed, course: c.heading,
    sLat: slat, sLng: slng,
    heading: lastCompass?.heading ?? null, headingSmoothed: smoothedHeading,
    visible: document.visibilityState === 'visible',
  });

  $('lat').textContent = c.latitude.toFixed(6);
  $('lng').textContent = c.longitude.toFixed(6);
  $('acc').textContent = fmt(c.accuracy, 1, ' m');
  $('alt').textContent = fmt(c.altitude, 1, ' m');
  $('spd').textContent = fmt(c.speed, 2, ' m/s');
  $('course').textContent = fmt(c.heading, 0, '°');
  $('nfix').textContent = log.fixes.length;
  const avg = fixIntervals.reduce((a, b) => a + b, 0) / (fixIntervals.length || 1);
  $('rate').textContent = fixIntervals.length ? fmt(avg / 1000, 2, ' s') : '–';

  updateDrift();
}

function onFixError(err) {
  event(`GPS error ${err.code}: ${err.message}`);
}

// ---------- drift stats ----------
function percentile(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

function updateDrift() {
  const n = drift.length;
  $('d-n').textContent = n;
  if (n < 2) return;
  // Mean of raw positions = best guess at where the phone really is.
  const mx = drift.reduce((a, d) => a + d.x, 0) / n;
  const my = drift.reduce((a, d) => a + d.y, 0) / n;
  const raw = drift.map(d => Math.hypot(d.x - mx, d.y - my)).sort((a, b) => a - b);
  const sm = drift.map(d => Math.hypot(d.sx - mx, d.sy - my)).sort((a, b) => a - b);
  $('d-50').textContent = fmt(percentile(raw, 0.5), 1, ' m');
  $('d-95').textContent = fmt(percentile(raw, 0.95), 1, ' m');
  $('d-max').textContent = fmt(raw[raw.length - 1], 1, ' m');
  $('d-s95').textContent = fmt(percentile(sm, 0.95), 1, ' m');
  drawScatter(mx, my, raw[raw.length - 1]);
}

function drawScatter(mx, my, maxD) {
  const cv = $('scatter'), g = cv.getContext('2d');
  const W = cv.width, mid = W / 2;
  const range = Math.max(12, maxD * 1.15);     // metres from centre to edge
  const s = mid / range;
  g.clearRect(0, 0, W, W);
  g.strokeStyle = '#2a3139'; g.fillStyle = '#5c6670'; g.font = '20px system-ui';
  for (const r of [3, 5, 10, 20, 50]) {
    if (r > range * 1.4) break;
    g.beginPath(); g.arc(mid, mid, r * s, 0, Math.PI * 2); g.stroke();
    g.fillText(r + ' m', mid + r * s * 0.71 + 4, mid - r * s * 0.71);
  }
  g.beginPath(); g.moveTo(mid, 0); g.lineTo(mid, W); g.moveTo(0, mid); g.lineTo(W, mid); g.stroke();
  // raw fixes
  g.fillStyle = 'rgba(180,190,200,0.45)';
  for (const d of drift) {
    g.beginPath(); g.arc(mid + (d.x - mx) * s, mid - (d.y - my) * s, 3, 0, Math.PI * 2); g.fill();
  }
  // smoothed track
  g.strokeStyle = '#4aa3ff'; g.lineWidth = 2; g.beginPath();
  drift.forEach((d, i) => {
    const px = mid + (d.sx - mx) * s, py = mid - (d.sy - my) * s;
    i ? g.lineTo(px, py) : g.moveTo(px, py);
  });
  g.stroke(); g.lineWidth = 1;
}

// ---------- compass ----------
function onCompass(r) {
  compassCount++;
  lastCompass = r;
  smoothedHeading = hdgSmoother.push(r.heading);
  const now = performance.now();
  // Keep the log small: at most 4 compass samples per second.
  if (now - lastCompassLogMs > 250) {
    lastCompassLogMs = now;
    log.compass.push({
      t: new Date().toISOString(), heading: r.heading, smoothed: smoothedHeading,
      top: r.topHeading, cam: r.cameraHeading, mode: r.mode ?? null, acc: r.accuracy,
      a: r.raw.alpha, b: r.raw.beta, g: r.raw.gamma,
    });
  }
  updateToneGain();
}

function renderCompass() {
  const r = lastCompass;
  if (!r) return;
  $('hdg').textContent = fmt(r.heading, 0, '°');
  $('hdg-s').textContent = fmt(smoothedHeading, 0, '°');
  $('hdg-top').textContent = fmt(r.topHeading, 0, '°');
  $('hdg-cam').textContent = fmt(r.cameraHeading, 0, '°');
  $('hdg-mode').textContent = r.mode ?? (r.source.startsWith('ios') ? 'iOS (auto)' : '–');
  $('hdg-acc').textContent = (r.accuracy === null || r.accuracy === undefined) ? 'n/a' : fmt(r.accuracy, 0, '°');
  $('hdg-src').textContent = r.source;
  $('hdg-raw').textContent = `${fmt(r.raw.alpha, 0)} / ${fmt(r.raw.beta, 0)} / ${fmt(r.raw.gamma, 0)}`;
  $('calib').hidden = !(typeof r.accuracy === 'number' && (r.accuracy < 0 || r.accuracy > 25));
  drawDial();
}

function drawDial() {
  const cv = $('dial'), g = cv.getContext('2d');
  const W = cv.width, c = W / 2, R = c - 20;
  g.clearRect(0, 0, W, W);
  g.strokeStyle = '#2a3139'; g.lineWidth = 3;
  g.beginPath(); g.arc(c, c, R, 0, Math.PI * 2); g.stroke();
  g.fillStyle = '#8b95a1'; g.font = 'bold 28px system-ui'; g.textAlign = 'center'; g.textBaseline = 'middle';
  [['N', 0], ['E', 90], ['S', 180], ['W', 270]].forEach(([l, a]) => {
    const r = a * Math.PI / 180;
    g.fillText(l, c + Math.sin(r) * (R - 26), c - Math.cos(r) * (R - 26));
  });
  const arrow = (deg, color, len, width) => {
    if (deg === null || deg === undefined) return;
    const r = deg * Math.PI / 180;
    g.strokeStyle = color; g.lineWidth = width; g.lineCap = 'round';
    g.beginPath(); g.moveTo(c, c); g.lineTo(c + Math.sin(r) * len, c - Math.cos(r) * len); g.stroke();
  };
  if (targetHeading !== null) arrow(targetHeading, '#ffb547', R, 4);
  arrow(lastCompass?.heading, '#5c6670', R - 50, 6);
  arrow(smoothedHeading, '#4aa3ff', R - 50, 10);
}

// ---------- test tone ----------
let ctx = null, toneGain = null, lastCtxTime = null, lastPerf = null;

function startTone() {
  ctx = new (window.AudioContext || window.webkitAudioContext)();
  toneGain = ctx.createGain();
  toneGain.gain.value = 0.04;
  toneGain.connect(ctx.destination);
  // Two slightly detuned sines: a soft, steady sound that makes dropouts obvious.
  for (const f of [220, 220.7]) {
    const o = ctx.createOscillator(); o.frequency.value = f; o.connect(toneGain); o.start();
  }
  ctx.onstatechange = () => { event(`audio ${ctx.state}`); $('audio').textContent = ctx.state; };
  ctx.resume();
  $('audio').textContent = ctx.state;
}

// With a target bearing set: full volume facing it, fading to 15% beyond ±90°.
function updateToneGain() {
  if (!toneGain || smoothedHeading === null) return;
  let level = 1;
  if (targetHeading !== null) {
    const off = Math.abs(angleDiff(smoothedHeading, targetHeading));       // 0..180
    const facing = off >= 90 ? 0 : 0.5 + 0.5 * Math.cos(off / 90 * Math.PI); // 1 → 0
    level = 0.15 + 0.85 * facing;
  }
  toneGain.gain.setTargetAtTime(0.04 * level, ctx.currentTime, 0.1);
}

// Is the audio clock actually advancing? (If iOS suspends audio while the
// page still runs, ctx.currentTime stops.)
function checkAudioClock() {
  if (!ctx) return;
  const p = performance.now();
  if (lastCtxTime !== null && ctx.state === 'running') {
    const wall = (p - lastPerf) / 1000, audio = ctx.currentTime - lastCtxTime;
    if (wall > 0.5 && audio < wall * 0.5) event(`audio clock stalled (${audio.toFixed(2)} s in ${wall.toFixed(2)} s)`);
  }
  lastCtxTime = ctx.currentTime; lastPerf = p;
}

// ---------- keep-alive ----------
const wake = new WakeLock((state) => {
  $('wake').textContent = state;
  $('wake').className = state === 'active' ? 'ok' : (state.startsWith('released (by app)') ? '' : 'bad');
  event(`wake lock ${state}`);
});
const pocket = new PocketMode({ onExit: () => event('pocket mode off') });

document.addEventListener('visibilitychange', () => {
  $('vis').textContent = document.visibilityState;
  if (running) event(`page ${document.visibilityState}`);
  if (document.visibilityState === 'visible' && ctx && ctx.state !== 'running' && running) ctx.resume();
});

// ---------- clock offset ----------
// Compare phone clock with the web server's Date header. That header only has
// 1-second resolution, so the result is ±0.5 s — enough to spot a phone that
// is badly off, which is what matters for the shared clock.
async function checkClock() {
  try {
    const t0 = Date.now();
    const res = await fetch(location.href, { method: 'HEAD', cache: 'no-store' });
    const t1 = Date.now();
    const d = res.headers.get('date');
    if (!d) throw new Error('no Date header');
    const server = new Date(d).getTime() + 500;  // centre of that second
    const offset = (t0 + t1) / 2 - server;        // + = phone ahead
    const txt = `${offset >= 0 ? '+' : ''}${(offset / 1000).toFixed(1)} s ±0.5 (rtt ${t1 - t0} ms)`;
    $('clock').textContent = txt;
    event(`clock offset ${txt}`);
    log.clockOffsetMs = offset;
  } catch (e) {
    $('clock').textContent = 'offline / failed';
    event(`clock check failed: ${e.message}`);
  }
}

// ---------- battery (Android Chrome only; iOS doesn't expose it) ----------
async function startBattery() {
  if (!navigator.getBattery) { $('bat').textContent = 'n/a on this browser'; return; }
  battery = await navigator.getBattery();
  const show = () => {
    $('bat').textContent = `${Math.round(battery.level * 100)}%${battery.charging ? ' (charging)' : ''}`;
  };
  show();
  event(`battery ${Math.round(battery.level * 100)}%`);
  battery.addEventListener('levelchange', () => { show(); event(`battery ${Math.round(battery.level * 100)}%`); });
}

// ---------- start / stop ----------
$('btn-start').addEventListener('click', () => {
  if (running) return stop();

  // iOS: these must be kicked off synchronously inside the tap.
  const compassPerm = requestCompassPermission();
  if ($('opt-tone').checked) startTone();

  running = true;
  startMs = Date.now();
  $('btn-start').textContent = 'Stop';
  $('btn-start').classList.add('stop');
  log.meta = { startedAt: new Date().toISOString(), userAgent: navigator.userAgent };
  event('started');

  watchId = navigator.geolocation.watchPosition(onFix, onFixError, {
    enableHighAccuracy: true, maximumAge: 0, timeout: 30000,
  });

  compassPerm.then((state) => {
    event(`motion permission: ${state}`);
    // Listen even if "denied": some browsers report that but still send events.
    compass = startCompass(onCompass);
    setTimeout(() => { if (!lastCompass) event('no compass events after 3 s'); }, 3000);
  });

  if ($('opt-wake').checked) wake.enable();
  startBattery();
  checkClock();
});

function stop() {
  running = false;
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
  compass?.stop(); compass = null;
  if (ctx) { ctx.close(); ctx = null; toneGain = null; lastCtxTime = null; }
  wake.disable();
  $('btn-start').textContent = 'Start';
  $('btn-start').classList.remove('stop');
  $('audio').textContent = 'stopped';
  event('stopped');
}

// ---------- controls ----------
$('pos-smooth').addEventListener('input', (e) => {
  posSmoother.factor = +e.target.value;
  $('pos-smooth-v').textContent = (+e.target.value).toFixed(2);
});
$('hdg-smooth').addEventListener('input', (e) => {
  hdgSmoother.factor = +e.target.value;
  $('hdg-smooth-v').textContent = (+e.target.value).toFixed(2);
});
$('btn-drift-reset').addEventListener('click', () => {
  drift = []; frame = null; posSmoother.reset();
  $('scatter').getContext('2d').clearRect(0, 0, 600, 600);
  for (const id of ['d-50', 'd-95', 'd-max', 'd-s95']) $(id).textContent = '–';
  $('d-n').textContent = 0;
  event('drift reset');
});
$('btn-target').addEventListener('click', () => {
  if (smoothedHeading === null) return;
  targetHeading = smoothedHeading;
  $('target').textContent = targetHeading.toFixed(0) + '°';
  event(`target heading ${targetHeading.toFixed(0)}°`);
});
$('btn-pocket').addEventListener('click', () => { pocket.enter(); event('pocket mode on'); });
$('btn-clock').addEventListener('click', checkClock);
$('btn-clear').addEventListener('click', () => {
  log.fixes = []; log.compass = []; log.events = [];
  $('events').innerHTML = '';
  event('log cleared');
});

// ---------- export ----------
function fileStem() {
  const label = $('label').value.trim().replace(/[^\w-]+/g, '-') || 'walk';
  return `${label}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}`;
}
function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

$('btn-json').addEventListener('click', () => {
  const out = { ...log, meta: { ...log.meta, label: $('label').value, exportedAt: new Date().toISOString(),
    positionSmoothing: posSmoother.factor, headingSmoothing: hdgSmoother.factor } };
  download(fileStem() + '.json', JSON.stringify(out, null, 1), 'application/json');
});

$('btn-gpx').addEventListener('click', () => {
  const pts = log.fixes.map(f => {
    let p = `<trkpt lat="${f.lat}" lon="${f.lng}">`;
    if (f.alt !== null) p += `<ele>${f.alt.toFixed(1)}</ele>`;
    p += `<time>${f.t}</time><extensions>`;
    p += `<sw:acc>${f.acc.toFixed(1)}</sw:acc>`;
    if (f.heading !== null) p += `<sw:heading>${f.heading.toFixed(0)}</sw:heading>`;
    p += `</extensions></trkpt>`;
    return p;
  }).join('\n');
  const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Carrickfin sensor test" xmlns="http://www.topografix.com/GPX/1/1" xmlns:sw="https://ed-devane.github.io/carrickfin/ns">
<trk><name>${esc($('label').value || 'sensor test')}</name><trkseg>
${pts}
</trkseg></trk>
</gpx>`;
  download(fileStem() + '.gpx', gpx, 'application/gpx+xml');
});

// ---------- 1 s UI tick ----------
setInterval(() => {
  $('vis').textContent = document.visibilityState;
  if (lastFixMs) $('age').textContent = fmt((Date.now() - lastFixMs) / 1000, 0, ' s');
  if (startMs && running) {
    const s = Math.floor((Date.now() - startMs) / 1000);
    $('uptime').textContent = `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  }
  compassRate = compassCount; compassCount = 0;
  $('hdg-rate').textContent = compassRate;
  checkAudioClock();
}, 1000);

// Redraw the compass at screen rate rather than per event (events can be 60/s).
(function frameLoop() { renderCompass(); requestAnimationFrame(frameLoop); })();
