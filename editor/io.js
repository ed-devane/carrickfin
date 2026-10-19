// io.js — files in and out of the editor.
//
//   importTrackFile(file)  GPX / KML (e.g. from GPSLogger) → { tracks, pins }
//   savePiece(state)       → .zip with piece.json + audio/  (goes in the repo)
//   openPiece(file)        .zip or piece.json → state (audio into IndexedDB)
//   trackToGpx(track)      → GPX text
//
// piece.json uses GeoJSON conventions: coordinates are [lng, lat].

import { audioStore, newId } from './store.js';

// ---------- GPX / KML import ----------
export async function importTrackFile(file) {
  const text = await file.text();
  const xml = new DOMParser().parseFromString(text, 'application/xml');
  if (xml.querySelector('parsererror')) throw new Error('Not a valid GPX/KML file');
  const base = file.name.replace(/\.(gpx|kml)$/i, '');
  return /\.kml$/i.test(file.name) || xml.documentElement.nodeName === 'kml'
    ? parseKml(xml, base) : parseGpx(xml, base);
}

const num = (el, sel) => { const n = el.querySelector(sel); return n ? parseFloat(n.textContent) : null; };
const txt = (el, sel) => el.querySelector(sel)?.textContent.trim() || '';

function parseGpx(xml, base) {
  const tracks = [], pins = [];
  const segs = [...xml.querySelectorAll('trkseg'), ...xml.querySelectorAll('rte')];
  segs.forEach((seg, i) => {
    const pts = [...seg.querySelectorAll('trkpt, rtept')].map(p => {
      const time = txt(p, 'time');
      // GPSLogger writes accuracy as <hdop>-ish extensions; take what's there.
      const acc = num(p, 'acc') ?? num(p, 'accuracy') ?? null;
      return [parseFloat(p.getAttribute('lon')), parseFloat(p.getAttribute('lat')), time ? Date.parse(time) : null, acc];
    });
    if (pts.length > 1) tracks.push({ id: newId('t'), name: segs.length > 1 ? `${base} ${i + 1}` : base, points: pts });
  });
  xml.querySelectorAll('wpt').forEach((w, i) => {
    pins.push({
      id: newId('p'), name: txt(w, 'name') || `Pin ${i + 1}`,
      lng: parseFloat(w.getAttribute('lon')), lat: parseFloat(w.getAttribute('lat')),
      accM: null, t: txt(w, 'time') || null,
    });
  });
  return { tracks, pins };
}

function kmlCoords(s) {
  return s.trim().split(/\s+/).map(c => c.split(',').map(Number)).filter(c => c.length >= 2 && !isNaN(c[0]));
}

function parseKml(xml, base) {
  const tracks = [], pins = [];
  xml.querySelectorAll('Placemark').forEach((pm, i) => {
    const name = txt(pm, 'name') || `${base} ${i + 1}`;
    const line = pm.querySelector('LineString coordinates, LinearRing coordinates');
    const pt = pm.querySelector('Point coordinates');
    const gx = pm.getElementsByTagName('gx:coord');
    if (line) {
      tracks.push({ id: newId('t'), name, points: kmlCoords(line.textContent).map(([lng, lat]) => [lng, lat, null, null]) });
    } else if (gx.length) {
      // Google-style <gx:Track> with <when> times
      const whens = pm.getElementsByTagName('when');
      const points = [...gx].map((c, k) => {
        const [lng, lat] = c.textContent.trim().split(/\s+/).map(Number);
        return [lng, lat, whens[k] ? Date.parse(whens[k].textContent) : null, null];
      });
      tracks.push({ id: newId('t'), name, points });
    } else if (pt) {
      const [lng, lat] = kmlCoords(pt.textContent)[0];
      pins.push({ id: newId('p'), name, lng, lat, accM: null, t: null });
    }
  });
  return { tracks, pins };
}

// ---------- GPX export of one recorded walk ----------
const esc = (s) => String(s).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

export function trackToGpx(track, pins = []) {
  const pts = track.points.map(([lng, lat, t, acc]) =>
    `<trkpt lat="${lat}" lon="${lng}">${t ? `<time>${new Date(t).toISOString()}</time>` : ''}` +
    `${acc !== null && acc !== undefined ? `<extensions><sw:acc>${acc.toFixed(1)}</sw:acc></extensions>` : ''}</trkpt>`).join('\n');
  const wpts = pins.map(p =>
    `<wpt lat="${p.lat}" lon="${p.lng}"><name>${esc(p.name)}</name>${p.t ? `<time>${p.t}</time>` : ''}</wpt>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Carrickfin editor" xmlns="http://www.topografix.com/GPX/1/1" xmlns:sw="https://ed-devane.github.io/carrickfin/ns">
${wpts}
<trk><name>${esc(track.name)}</name><trkseg>
${pts}
</trkseg></trk>
</gpx>`;
}

// ---------- piece save / open ----------
const close = (ring) => {
  const a = ring[0], b = ring[ring.length - 1];
  return (a[0] === b[0] && a[1] === b[1]) ? ring : [...ring, a];
};
const open = (ring) => {
  const a = ring[0], b = ring[ring.length - 1];
  return (ring.length > 1 && a[0] === b[0] && a[1] === b[1]) ? ring.slice(0, -1) : ring;
};
const boundaryOf = (ring) => ring ? { type: 'Polygon', coordinates: [close(ring)] } : null;
const ringOf = (b) => b ? open(b.coordinates[0]) : null;
const safeName = (s) => s.replace(/[^\w.-]+/g, '_');

export function stateToPiece(state) {
  return {
    title: { en: state.title, ga: '' },
    epoch: '2026-01-01T00:00:00Z',
    // `boundary` is the outer (low-tide) line; `tideBoundaries` has both.
    boundary: boundaryOf(state.perimeters.low || state.perimeters.high),
    tideBoundaries: { low: boundaryOf(state.perimeters.low), high: boundaryOf(state.perimeters.high) },
    settings: { positionSmoothing: 0.3, headingSmoothing: 0.2 },
    zones: state.zones.map(z => ({
      id: z.id,
      name: z.name,
      shape: z.shape.type === 'Circle'
        ? { type: 'Point', coordinates: z.shape.center, radiusM: z.shape.radiusM }
        : { type: 'Polygon', coordinates: [close(z.shape.ring)] },
      audio: z.audio ? { src: `audio/${z.id}-${safeName(z.audio.name)}`, loopLengthSec: z.audio.durationSec } : null,
      // Mixing parameters come in milestone 3; defaults for now.
      gain: { max: 1.0, curve: 's-curve', edgeFeatherM: 10 },
      orientation: { enabled: false },
    })),
    // Reference layers: only the editor uses these.
    editor: { tracks: state.tracks, pins: state.pins },
  };
}

export function pieceToState(piece) {
  return {
    title: piece.title?.en || 'Untitled piece',
    perimeters: piece.tideBoundaries
      ? { low: ringOf(piece.tideBoundaries.low), high: ringOf(piece.tideBoundaries.high) }
      : { low: ringOf(piece.boundary), high: null },
    tracks: piece.editor?.tracks || [],
    pins: piece.editor?.pins || [],
    zones: (piece.zones || []).map(z => ({
      id: z.id,
      name: z.name,
      shape: z.shape.type === 'Point'
        ? { type: 'Circle', center: z.shape.coordinates, radiusM: z.shape.radiusM }
        : { type: 'Polygon', ring: open(z.shape.coordinates[0]) },
      audio: z.audio ? { id: z.id, name: z.audio.src.split('/').pop().replace(`${z.id}-`, ''), durationSec: z.audio.loopLengthSec, src: z.audio.src } : null,
    })),
  };
}

export async function savePiece(state) {
  const zip = new JSZip();
  zip.file('piece.json', JSON.stringify(stateToPiece(state), null, 2));
  const missing = [];
  for (const z of state.zones) {
    if (!z.audio) continue;
    const rec = await audioStore.get(z.audio.id);
    if (rec) zip.file(`audio/${z.id}-${safeName(z.audio.name)}`, rec.blob);
    else missing.push(z.name);
  }
  const blob = await zip.generateAsync({ type: 'blob' });
  return { blob, missing };
}

export async function openPiece(file) {
  if (/\.json$/i.test(file.name)) return { state: pieceToState(JSON.parse(await file.text())), missing: [] };
  const zip = await JSZip.loadAsync(file);
  const pj = zip.file('piece.json');
  if (!pj) throw new Error('No piece.json in this zip');
  const state = pieceToState(JSON.parse(await pj.async('string')));
  const missing = [];
  for (const z of state.zones) {
    if (!z.audio) continue;
    const f = zip.file(z.audio.src);
    if (!f) { missing.push(z.name); continue; }
    const blob = await f.async('blob');
    await audioStore.put(z.audio.id, { name: z.audio.name, blob });
    delete z.audio.src;
  }
  return { state, missing };
}

export function download(name, blobOrText, type = 'application/octet-stream') {
  const blob = blobOrText instanceof Blob ? blobOrText : new Blob([blobOrText], { type });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
