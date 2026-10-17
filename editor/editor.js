// editor.js — the main page: satellite plan of the beach with the walked
// perimeter, pins and zones on top. Works on the phone (record a walk, drop
// pins where you stand) and on the desktop (draw zones, attach audio).

import { makeLocalFrame, simplify, pathLengthM, polygonAreaM2, haversineM } from '../shared/geo.js';
import { WakeLock, PocketMode } from '../shared/keepalive.js';
import { store, audioStore, newId } from './store.js';
import { importTrackFile, savePiece, openPiece, trackToGpx, download } from './io.js';

const $ = (id) => document.getElementById(id);

// ---------- map ----------
// Carrickfin Atlantic strand, west of (and parallel to) the airport runway.
//
// The map is turned so the runway runs left–right along the bottom of the
// screen, with the sea at the top: south rocks on the left, the north end of
// the runway on the right. The runway's true bearing is ~20°, so "up" on
// screen is 20° − 90° = 290° (WNW, out to sea).
const RUNWAY_BEARING = 20;
const VIEW_UP = (RUNWAY_BEARING + 270) % 360;
const HOME = {
  west: [55.0381, -8.3502],   // rocks at the south end of the strand
  east: [55.0505, -8.3431],   // beach level with the north end of the runway
};

const map = L.map('map', {
  zoomControl: false, maxZoom: 21, zoomSnap: 0.25, tap: false,
  rotate: true, bearing: 360 - VIEW_UP, touchRotate: false, shiftKeyRotate: false, rotateControl: false,
});

// Fit the strand across the full width of the screen (fitBounds doesn't
// understand a rotated map, so we work out the zoom from metres per pixel).
function goHome() {
  const [a, b] = [L.latLng(HOME.west), L.latLng(HOME.east)];
  const centre = L.latLng((a.lat + b.lat) / 2, (a.lng + b.lng) / 2);
  const lengthM = a.distanceTo(b) * 1.08;                       // a little margin
  const widthPx = map.getSize().x;
  const mPerPxAtZ0 = 156543.03 * Math.cos(centre.lat * Math.PI / 180);
  map.setView(centre, Math.log2(mPerPxAtZ0 * widthPx / lengthM));
}

// Satellite imagery: Esri's current mosaic mixes captures from different
// tides along the strand, so we use dated versions from the Esri Wayback
// archive. Capture dates checked at the middle of the strand.
const IMAGERY = [
  { rel: 34007, label: '31 Aug 2020 · 31 cm · ±5 m' },
  { rel: 18358, label: '7 Nov 2011 · low tide · 30 cm · ±5 m' },
  { rel: 11351, label: '3 May 2011 · 46 cm · ±10 m' },
  { rel: 64001, label: '9 Apr 2024 · 50 cm · ±5 m' },
  { rel: 63116, label: 'May 2025 (current, has a tide seam)' },
];
const imageryLayer = (rel) => L.tileLayer(
  `https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/WMTS/1.0.0/default028mm/MapServer/tile/${rel}/{z}/{y}/{x}`,
  { maxNativeZoom: 19, maxZoom: 21, attribution: 'Imagery © Esri World Imagery (Wayback), Maxar' });
let imageryRel = IMAGERY[0].rel;
try { imageryRel = +localStorage.getItem('imagery') || imageryRel; } catch (e) {}
let satellite = imageryLayer(imageryRel);
const streets = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  { maxNativeZoom: 19, maxZoom: 21, attribution: '© OpenStreetMap contributors' });
let basemap = satellite.addTo(map);

function setImagery(rel) {
  imageryRel = rel;
  try { localStorage.setItem('imagery', rel); } catch (e) {}
  const next = imageryLayer(rel);
  if (basemap === satellite) { map.removeLayer(satellite); next.addTo(map); basemap = next; }
  satellite = next;
}
L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map);
map.pm.setGlobalOptions({ snappable: false, allowSelfIntersection: false });

const overlays = L.featureGroup().addTo(map);
const layerById = new Map();
let selectedId = null;

const toLL = ([lng, lat]) => [lat, lng];
const fromLL = (ll) => [ll.lng, ll.lat];

// ---------- rendering ----------
function render() {
  overlays.clearLayers();
  layerById.clear();
  const s = store.state;

  for (const t of s.tracks) {
    const line = L.polyline(t.points.map(toLL), { color: getVar('--track'), weight: 2, opacity: 0.8 });
    add(t.id, line, t.name);
  }
  if (s.perimeter) {
    const poly = L.polygon(s.perimeter.map(toLL), {
      color: getVar('--perimeter'), weight: 3, dashArray: '8 6', fillOpacity: 0.04,
    });
    add('perimeter', poly, null);
  }
  for (const z of s.zones) {
    const style = { color: getVar('--zone'), weight: 2, fillOpacity: 0.2 };
    const layer = z.shape.type === 'Circle'
      ? L.circle(toLL(z.shape.center), { ...style, radius: z.shape.radiusM })
      : L.polygon(z.shape.ring.map(toLL), style);
    add(z.id, layer, z.name + (z.audio ? ' ♪' : ''));
  }
  for (const p of s.pins) {
    const m = L.marker([p.lat, p.lng], {
      icon: L.divIcon({ className: '', html: '<div class="pin-icon"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }),
    });
    add(p.id, m, p.name);
  }
  applySelection();
}

function add(id, layer, label) {
  if (label) layer.bindTooltip(label, { permanent: true, direction: 'top', className: 'map-label', offset: [0, -8] });
  layer.on('click', (e) => { L.DomEvent.stopPropagation(e); if (!drawing && !placingPin) select(id); });
  layer.addTo(overlays);
  layerById.set(id, layer);
}

function getVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

store.onChange(render);

// ---------- selection + editing on the map ----------
function select(id) {
  selectedId = id;
  applySelection();
  renderSheet();
}

function deselect() {
  selectedId = null;
  applySelection();
  $('sheet').hidden = true;
}

// Make the selected shape editable (drag corners / move); everything else locked.
function applySelection() {
  for (const [id, layer] of layerById) {
    const on = id === selectedId;
    if (layer instanceof L.Marker) {
      layer.getElement()?.firstChild?.classList.toggle('selected', on);
      on ? layer.dragging?.enable() : layer.dragging?.disable();
      layer.off('dragend');
      if (on) layer.on('dragend', () => updatePin(id, layer.getLatLng()));
    } else if (layer.pm) {
      if (on && (id === 'perimeter' || id.startsWith('z'))) {
        layer.pm.enable({ draggable: true, allowSelfIntersection: false });
        layer.off('pm:edit pm:dragend');
        layer.on('pm:edit pm:dragend', () => updateShape(id, layer));
      } else if (layer.pm.enabled()) {
        layer.pm.disable();
      }
      if (layer.setStyle && !(layer instanceof L.Marker)) layer.setStyle({ weight: on ? 4 : (id === 'perimeter' ? 3 : 2) });
    }
  }
  if (selectedId && !layerById.has(selectedId)) { selectedId = null; $('sheet').hidden = true; }
}

function updatePin(id, ll) {
  store.change(s => { const p = s.pins.find(x => x.id === id); p.lat = ll.lat; p.lng = ll.lng; });
}

function updateShape(id, layer) {
  store.change(s => {
    if (id === 'perimeter') { s.perimeter = layer.getLatLngs()[0].map(fromLL); return; }
    const z = s.zones.find(x => x.id === id);
    if (layer instanceof L.Circle) z.shape = { type: 'Circle', center: fromLL(layer.getLatLng()), radiusM: layer.getRadius() };
    else z.shape = { type: 'Polygon', ring: layer.getLatLngs()[0].map(fromLL) };
  });
}

map.on('click', (e) => {
  if (placingPin) { placingPin = false; addPin(e.latlng.lat, e.latlng.lng, null); return; }
  if (!drawing) deselect();
  closePopovers();
});

// ---------- drawing zones / perimeter ----------
let drawing = null; // 'zone' | 'perimeter' | null

function startDraw(shape, purpose) {
  closePopovers();
  deselect();
  drawing = purpose;
  map.pm.enableDraw(shape, { snappable: false, templineStyle: { color: '#fff' }, hintlineStyle: { color: '#fff', dashArray: '4 4' } });
  toast(shape === 'Circle' ? 'Tap the centre, then tap again to set the size' : 'Tap each corner. Tap the first corner to finish.');
}

map.on('pm:create', (e) => {
  const layer = e.layer;
  map.removeLayer(layer);
  const purpose = drawing;
  drawing = null;
  hideToast();
  if (purpose === 'perimeter') {
    store.change(s => { s.perimeter = layer.getLatLngs()[0].map(fromLL); });
    select('perimeter');
    return;
  }
  const id = newId('z');
  const n = store.state.zones.length + 1;
  const shape = e.shape === 'Circle'
    ? { type: 'Circle', center: fromLL(layer.getLatLng()), radiusM: layer.getRadius() }
    : { type: 'Polygon', ring: layer.getLatLngs()[0].map(fromLL) };
  store.change(s => s.zones.push({ id, name: `Zone ${n}`, shape, audio: null }));
  select(id);
});

map.on('pm:drawend', () => { if (drawing) { drawing = null; hideToast(); } });

// ---------- GPS ----------
let watchId = null;
let lastFix = null;
const recentFixes = [];        // last ~15 s, for averaging pins
let meMarker = null, meAccuracy = null;
let followMe = false;

function startGps() {
  if (watchId !== null) return;
  if (!navigator.geolocation) { toast('This browser has no GPS access'); return; }
  watchId = navigator.geolocation.watchPosition(onFix, (err) => toast('GPS: ' + err.message),
    { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
}

function onFix(pos) {
  const c = pos.coords;
  lastFix = { lat: c.latitude, lng: c.longitude, acc: c.accuracy, t: pos.timestamp };
  recentFixes.push(lastFix);
  while (recentFixes.length && lastFix.t - recentFixes[0].t > 15000) recentFixes.shift();

  const ll = [c.latitude, c.longitude];
  if (!meMarker) {
    meAccuracy = L.circle(ll, { radius: c.accuracy, color: '#4aa3ff', weight: 1, fillOpacity: 0.12, interactive: false }).addTo(map);
    meMarker = L.marker(ll, { interactive: false, zIndexOffset: 1000,
      icon: L.divIcon({ className: '', html: '<div class="me-dot"></div>', iconSize: [16, 16], iconAnchor: [8, 8] }) }).addTo(map);
  } else {
    meMarker.setLatLng(ll); meAccuracy.setLatLng(ll); meAccuracy.setRadius(c.accuracy);
  }
  if (followMe) { map.panTo(ll); followMe = false; }
  if (recording) onRecordFix(lastFix);
}

$('btn-locate').addEventListener('click', () => {
  startGps();
  if (lastFix) map.panTo([lastFix.lat, lastFix.lng]);
  else { followMe = true; toast('Finding your position…'); }
});

// ---------- recording a walk ----------
let recording = null;          // { track, startMs, line }
const wake = new WakeLock(() => {});
const pocket = new PocketMode();

function startRecording() {
  startGps();
  const id = newId('t');
  const name = 'Walk ' + new Date().toLocaleString('en-IE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  store.change(s => s.tracks.push({ id, name, points: [] }));
  recording = { id, startMs: Date.now(), line: L.polyline([], { color: getVar('--rec'), weight: 3 }).addTo(map) };
  wake.enable();
  $('recbar').hidden = false;
  $('btn-record').classList.add('on');
  followMe = true;
  updateRecStats();
}

// Points with poor accuracy are skipped so a bad fix doesn't spike the outline.
function onRecordFix(f) {
  if (f.acc > 30) return;
  const track = store.state.tracks.find(t => t.id === recording.id);
  if (!track) return;
  track.points.push([f.lng, f.lat, f.t, Math.round(f.acc * 10) / 10]);
  recording.line.addLatLng([f.lat, f.lng]);
  store.save();               // autosave without re-rendering the whole map
  updateRecStats();
}

function updateRecStats() {
  if (!recording) return;
  const track = store.state.tracks.find(t => t.id === recording.id);
  const s = Math.floor((Date.now() - recording.startMs) / 1000);
  const len = track ? trackLengthM(track) : 0;
  const acc = lastFix ? ` · ±${Math.round(lastFix.acc)} m` : ' · waiting for GPS';
  $('rec-stats').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} · ${Math.round(len)} m${acc}`;
}
setInterval(updateRecStats, 1000);

function stopRecording() {
  if (!recording) return;
  const id = recording.id;
  map.removeLayer(recording.line);
  recording = null;
  wake.disable();
  $('recbar').hidden = true;
  $('btn-record').classList.remove('on');
  const track = store.state.tracks.find(t => t.id === id);
  if (track && track.points.length < 2) {
    store.change(s => { s.tracks = s.tracks.filter(t => t.id !== id); }, { undoable: false });
    toast('Walk discarded (too few GPS points)');
    return;
  }
  store.saveNow();
  render();
  select(id);
}

$('btn-record').addEventListener('click', () => recording ? stopRecording() : startRecording());
$('rec-stop').addEventListener('click', stopRecording);
$('rec-pocket').addEventListener('click', () => pocket.enter());
$('rec-pin').addEventListener('click', () => dropPinHere());

// ---------- pins ----------
let placingPin = false;

// Average the last 10 s of fixes. Standing still while this happens gives a
// steadier position than any single fix.
function dropPinHere() {
  const now = lastFix?.t;
  const fixes = recentFixes.filter(f => now - f.t <= 10000 && f.acc <= 30);
  if (!fixes.length) return false;
  const lat = fixes.reduce((a, f) => a + f.lat, 0) / fixes.length;
  const lng = fixes.reduce((a, f) => a + f.lng, 0) / fixes.length;
  const meanAcc = fixes.reduce((a, f) => a + f.acc, 0) / fixes.length;
  addPin(lat, lng, meanAcc, fixes.length);
  return true;
}

function addPin(lat, lng, accM, nFixes) {
  const id = newId('p');
  const name = `Pin ${store.state.pins.length + 1}`;
  store.change(s => s.pins.push({ id, name, lat, lng, accM: accM ?? null, t: new Date().toISOString() }));
  select(id);
  if (nFixes) toast(`Pin from ${nFixes} GPS fixes`);
  setTimeout(() => $('sheet').querySelector('input')?.select(), 50);
}

$('btn-pin').addEventListener('click', () => {
  closePopovers();
  if (recording && dropPinHere()) return;
  if (lastFix && Date.now() - lastFix.t < 10000 && dropPinHere()) return;
  placingPin = true;
  toast('Tap the map to place a pin', { action: 'Cancel', onAction: () => { placingPin = false; } });
});

// ---------- sheet (details of the selected item) ----------
const esc = (s) => String(s).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
const fmtM = (m) => m >= 1000 ? (m / 1000).toFixed(2) + ' km' : Math.round(m) + ' m';
const fmtArea = (a) => a >= 10000 ? (a / 10000).toFixed(2) + ' ha' : Math.round(a) + ' m²';
const fmtDur = (sec) => sec >= 60 ? `${Math.floor(sec / 60)} min ${Math.round(sec % 60)} s` : `${Math.round(sec)} s`;

function localXY(lnglats) {
  const f = makeLocalFrame(lnglats[0][1], lnglats[0][0]);
  return lnglats.map(([lng, lat]) => f.toXY(lat, lng));
}
function trackLengthM(t) { return t.points.length > 1 ? pathLengthM(localXY(t.points)) : 0; }

function renderSheet() {
  const sheet = $('sheet');
  const found = store.find(selectedId);
  if (!found) { sheet.hidden = true; return; }
  const { kind, item } = found;
  let html = '';
  const head = (label) => `<header><span class="kind">${label}</span><button class="close" data-a="close" aria-label="Close">×</button></header>`;
  const nameField = (v) => `<input type="text" data-a="name" value="${esc(v)}" placeholder="Name">`;

  if (kind === 'perimeter') {
    const ring = store.state.perimeter;
    html = head('Perimeter') +
      `<div class="info">${fmtArea(polygonAreaM2(localXY(ring)))} · ${ring.length} corners<br>
       Outside this line the piece is silent. Drag corners to adjust.</div>
       <div class="actions"><button data-a="delete" class="danger">Delete</button></div>`;
  } else if (kind === 'track') {
    const t = item;
    const dur = t.points.length > 1 && t.points[0][2] ? (t.points.at(-1)[2] - t.points[0][2]) / 1000 : null;
    const accs = t.points.map(p => p[3]).filter(a => a != null);
    const medAcc = accs.length ? accs.sort((a, b) => a - b)[Math.floor(accs.length / 2)] : null;
    html = head('Walk') + nameField(t.name) +
      `<div class="info">${fmtM(trackLengthM(t))}${dur ? ' · ' + fmtDur(dur) : ''} · ${t.points.length} points${medAcc != null ? ` · typical ±${medAcc.toFixed(0)} m` : ''}</div>
       <div class="actions">
         <button data-a="to-perimeter" class="primary">Use as perimeter</button>
         <button data-a="gpx">Export GPX</button>
         <button data-a="delete" class="danger">Delete</button>
       </div>`;
  } else if (kind === 'pin') {
    const p = item;
    html = head('Pin') + nameField(p.name) +
      `<div class="info">${p.lat.toFixed(6)}, ${p.lng.toFixed(6)}${p.accM ? ` · ±${p.accM.toFixed(0)} m` : ''}</div>
       <div class="actions"><button data-a="delete" class="danger">Delete</button></div>`;
  } else if (kind === 'zone') {
    const z = item;
    const size = z.shape.type === 'Circle' ? `circle, ${Math.round(z.shape.radiusM * 2)} m across`
      : `${fmtArea(polygonAreaM2(localXY(z.shape.ring)))}`;
    const audio = z.audio
      ? `<div class="name">${esc(z.audio.name)}</div><div class="info">${z.audio.durationSec ? fmtDur(z.audio.durationSec) : ''}</div>
         <div class="actions"><button data-a="play">${previewing === z.id ? 'Stop' : 'Play'}</button><button data-a="audio">Replace…</button><button data-a="audio-remove">Remove</button></div>`
      : `<div class="actions"><button data-a="audio" class="primary">Add audio…</button></div>`;
    html = head('Zone') + nameField(z.name) +
      `<div class="info">${size}</div>
       <div class="audio">${audio}</div>
       <div class="actions"><button data-a="delete" class="danger">Delete zone</button></div>`;
  }
  sheet.innerHTML = html;
  sheet.hidden = false;
}

$('sheet').addEventListener('change', (e) => {
  if (e.target.dataset.a !== 'name') return;
  const v = e.target.value.trim();
  if (!v) return;
  store.change(s => { const f = store.find(selectedId); if (f?.item) f.item.name = v; });
});
$('sheet').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.dataset.a === 'name') e.target.blur(); });

$('sheet').addEventListener('click', async (e) => {
  const a = e.target.closest('[data-a]')?.dataset.a;
  if (!a || a === 'name') return;
  const found = store.find(selectedId);
  if (!found && a !== 'close') return;

  if (a === 'close') deselect();
  else if (a === 'delete') deleteSelected();
  else if (a === 'to-perimeter') trackToPerimeter(found.item);
  else if (a === 'gpx') download(found.item.name.replace(/[^\w-]+/g, '_') + '.gpx', trackToGpx(found.item, store.state.pins), 'application/gpx+xml');
  else if (a === 'audio') $('file-audio').click();
  else if (a === 'audio-remove') { stopPreview(); store.change(s => { found.item.audio = null; }); renderSheet(); }
  else if (a === 'play') togglePreview(found.item);
});

function deleteSelected() {
  const found = store.find(selectedId);
  if (!found) return;
  const id = selectedId;
  store.change(s => {
    if (found.kind === 'perimeter') s.perimeter = null;
    else s[found.kind + 's'] = s[found.kind + 's'].filter(x => x.id !== id);
  });
  deselect();
  toast('Deleted', { action: 'Undo', onAction: () => store.undo() });
}

// Turn a walked track into the perimeter: drop poor fixes, average each
// point with its neighbours (±3 points ≈ ±3 s of walking) to take out GPS
// wobble, then remove points within 4 m of a straight line, close the loop.
function trackToPerimeter(track) {
  const pts = track.points.filter(p => p[3] == null || p[3] <= 20);
  if (pts.length < 4) { toast('Not enough good GPS points for a perimeter'); return; }
  const frame = makeLocalFrame(pts[0][1], pts[0][0]);
  const raw = pts.map(([lng, lat]) => frame.toXY(lat, lng));
  const W = 3;
  const xy = raw.map((_, i) => {
    const win = raw.slice(Math.max(0, i - W), i + W + 1);
    return [win.reduce((a, p) => a + p[0], 0) / win.length, win.reduce((a, p) => a + p[1], 0) / win.length];
  });
  const simple = simplify(xy, 4);
  if (simple.length < 3) { toast('Walk is too straight to make an area'); return; }
  const ring = simple.map(([x, y]) => { const [lat, lng] = frame.toLatLng(x, y); return [lng, lat]; });
  const gap = haversineM(pts[0][1], pts[0][0], pts.at(-1)[1], pts.at(-1)[0]);
  const hadOne = !!store.state.perimeter;
  store.change(s => { s.perimeter = ring; });
  select('perimeter');
  const msg = `Perimeter made from ${pts.length} points → ${ring.length} corners` +
    (gap > 30 ? ` (start and end were ${Math.round(gap)} m apart, joined)` : '') + (hadOne ? '. Replaced the old one.' : '');
  toast(msg, { action: 'Undo', onAction: () => store.undo() });
}

// ---------- audio ----------
$('file-audio').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  const found = store.find(selectedId);
  if (!file || found?.kind !== 'zone') return;
  const zone = found.item;
  const audioId = 'a' + zone.id + Date.now().toString(36);
  await audioStore.put(audioId, { name: file.name, blob: file });
  const durationSec = await audioDuration(file);
  stopPreview();
  store.change(s => { s.zones.find(z => z.id === zone.id).audio = { id: audioId, name: file.name, durationSec }; });
  renderSheet();
});

function audioDuration(blob) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const el = new Audio();
    el.preload = 'metadata';
    el.onloadedmetadata = () => { resolve(isFinite(el.duration) ? Math.round(el.duration * 100) / 100 : null); URL.revokeObjectURL(url); };
    el.onerror = () => { resolve(null); URL.revokeObjectURL(url); };
    el.src = url;
  });
}

// Simple preview only — the real position-based mix comes in milestone 3.
let previewing = null, previewEl = null;
async function togglePreview(zone) {
  if (previewing === zone.id) { stopPreview(); renderSheet(); return; }
  stopPreview();
  const rec = await audioStore.get(zone.audio.id);
  if (!rec) { toast('Audio file missing from this browser. Add it again.'); return; }
  previewEl = new Audio(URL.createObjectURL(rec.blob));
  previewEl.loop = true;
  previewEl.play();
  previewing = zone.id;
  renderSheet();
}
function stopPreview() {
  if (previewEl) { previewEl.pause(); URL.revokeObjectURL(previewEl.src); previewEl = null; }
  previewing = null;
}

// ---------- menus ----------
function closePopovers() { $('main-menu').hidden = true; $('zone-menu').hidden = true; $('imagery-menu').hidden = true; }

function openImageryMenu() {
  const m = $('imagery-menu');
  m.innerHTML = IMAGERY.map(i =>
    `<button data-rel="${i.rel}">${i.rel === imageryRel ? '● ' : '○ '}${esc(i.label)}</button>`).join('');
  m.hidden = false;
}
$('imagery-menu').addEventListener('click', (e) => {
  const rel = +e.target.closest('[data-rel]')?.dataset.rel;
  if (!rel) return;
  setImagery(rel);
  openImageryMenu();   // stay open so versions can be flicked through
});

$('btn-menu').addEventListener('click', (e) => {
  e.stopPropagation();
  const open = $('main-menu').hidden;
  closePopovers();
  $('main-menu').hidden = !open;
  newArmed = false;
  $('main-menu').querySelector('[data-act=new]').textContent = 'New empty piece';
});
$('btn-zone').addEventListener('click', (e) => {
  e.stopPropagation();
  const open = $('zone-menu').hidden;
  closePopovers();
  $('zone-menu').hidden = !open;
});
$('zone-menu').addEventListener('click', (e) => {
  const shape = e.target.dataset.shape;
  if (shape) startDraw(shape, 'zone');
});

let newArmed = false;
$('main-menu').addEventListener('click', async (e) => {
  const act = e.target.dataset.act;
  if (!act) return;
  if (act !== 'new') closePopovers();

  if (act === 'import') $('file-import').click();
  else if (act === 'open') $('file-open').click();
  else if (act === 'save') {
    await store.saveNow();
    const { blob, missing } = await savePiece(store.state);
    download((store.state.title || 'piece').replace(/[^\w-]+/g, '_') + '.zip', blob);
    toast(missing.length ? `Saved. Missing audio for: ${missing.join(', ')}` : 'Saved piece.json + audio as .zip');
  }
  else if (act === 'home') goHome();
  else if (act === 'imagery') {
    if (basemap !== satellite) $('main-menu').querySelector('[data-act=basemap]').click();
    openImageryMenu();
  }
  else if (act === 'basemap') {
    map.removeLayer(basemap);
    basemap = basemap === satellite ? streets : satellite;
    basemap.addTo(map);
    e.target.textContent = basemap === satellite ? 'Switch to street map' : 'Switch to satellite';
  }
  else if (act === 'draw-perimeter') startDraw('Polygon', 'perimeter');
  else if (act === 'undo') { if (!store.undo()) toast('Nothing to undo'); }
  else if (act === 'new') {
    // Two taps, so it can't happen by accident.
    if (!newArmed) { newArmed = true; e.target.textContent = 'Tap again to clear everything'; return; }
    closePopovers();
    stopPreview();
    store.replace({});
    deselect();
    toast('Started a new piece', { action: 'Undo', onAction: () => store.undo() });
  }
});

$('file-import').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  let nT = 0, nP = 0;
  const all = [];
  for (const f of files) {
    try {
      const { tracks, pins } = await importTrackFile(f);
      nT += tracks.length; nP += pins.length;
      all.push({ tracks, pins });
    } catch (err) { toast(`${f.name}: ${err.message}`); return; }
  }
  store.change(s => { for (const r of all) { s.tracks.push(...r.tracks); s.pins.push(...r.pins); } });
  const first = all.find(r => r.tracks.length)?.tracks[0];
  if (first) select(first.id);
  toast(`Imported ${nT} walk${nT === 1 ? '' : 's'}, ${nP} pin${nP === 1 ? '' : 's'}`);
});

$('file-open').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const { state, missing } = await openPiece(file);
    stopPreview();
    store.replace(state);
    deselect();
    fitAll();
    toast(missing.length ? `Opened. Missing audio for: ${missing.join(', ')}` : 'Opened piece');
  } catch (err) { toast('Could not open: ' + err.message); }
});

// ---------- toast ----------
let toastTimer = null;
function toast(msg, { action, onAction } = {}) {
  const t = $('toast');
  t.innerHTML = `<span>${esc(msg)}</span>${action ? `<button>${esc(action)}</button>` : ''}`;
  if (action) t.querySelector('button').onclick = () => { hideToast(); onAction(); };
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, action ? 6000 : 3500);
}
function hideToast() { $('toast').hidden = true; }

// ---------- keyboard (desktop) ----------
document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea')) return;
  if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); store.undo(); }
  else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) { e.preventDefault(); deleteSelected(); }
  else if (e.key === 'Escape') {
    if (drawing) { map.pm.disableDraw(); drawing = null; hideToast(); }
    placingPin = false; closePopovers(); deselect();
  }
});

// ---------- start ----------
// Always open on the framed strand; the perimeter sits inside it.
function fitAll() { goHome(); }

await store.load();
render();
fitAll();
// Make sure a walk in progress is on disk if the page is about to go away.
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') store.saveNow(); });
