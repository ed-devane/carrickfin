// mixer.js — the position-driven mix, shared by the editor's "listen" mode
// and (later) the phone player.
//
// Every zone's audio loops forever against a fixed clock (the piece's
// epoch), so two people standing in the same zone hear the same moment, and
// walking out and back in doesn't restart the sound.
//
// Level of each zone, from where the listener stands:
//   outside the zone            → silent
//   inside, near the edge       → fades up over `featherM` metres
//   further in                  → full
//   outside the perimeter       → everything silent
//
// Shapes use the editor's form, coordinates [lng, lat]:
//   { type: 'Polygon', ring: [[lng, lat], ...] }
//   { type: 'Circle', center: [lng, lat], radiusM }

import { makeLocalFrame, distToSegment } from './geo.js';

const RAMP_S = 0.25;   // how quickly levels follow the listener

// ---------- geometry (local metres) ----------
function insideRing([px, py], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Metres from the edge: positive inside, negative outside.
function ringDepth(p, ring) {
  let d = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) d = Math.min(d, distToSegment(p, ring[j], ring[i]));
  return insideRing(p, ring) ? d : -d;
}

// How deep the shape goes at its deepest point, so a small zone still
// reaches full level (the fade can't be longer than the zone is deep).
function maxRingDepth(ring) {
  const xs = ring.map(p => p[0]), ys = ring.map(p => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  let best = 0;
  const N = 30;
  for (let i = 0; i <= N; i++) for (let j = 0; j <= N; j++) {
    best = Math.max(best, ringDepth([x0 + (x1 - x0) * i / N, y0 + (y1 - y0) * j / N], ring));
  }
  return best;
}

const smoothstep = (t) => { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t); };

export class Mixer {
  constructor({ epochMs = 0, featherM = 10 } = {}) {
    this.epochMs = epochMs;
    this.featherM = featherM;
    this.ctx = null;
    this.master = null;
    this.zones = new Map();     // id → { shape, depthFn, maxDepth, audioKey, buffer, src, gain, level }
    this.perimeter = null;      // local ring or null
    this.frame = null;
    this.position = null;
  }

  // Call from a click/tap so browsers allow sound.
  async start() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.master = this.ctx.createGain();
      this.master.connect(this.ctx.destination);
    }
    // Don't wait on this: some browsers only settle it once sound is playing.
    this.ctx.resume();
  }

  async stop() {
    for (const z of this.zones.values()) this.stopSource(z);
    this.zones.clear();
    this.position = null;
    if (this.ctx) { await this.ctx.close(); this.ctx = null; }
  }

  // zones: [{ id, shape, audioKey, getBlob: async () => Blob|null }]
  // audioKey changes when the zone's sound is replaced. Returns names of
  // zones whose audio couldn't be loaded.
  async setPiece({ zones, perimeter }) {
    if (!this.frame) {
      const first = perimeter?.[0] || zones[0]?.shape.ring?.[0] || zones[0]?.shape.center || [0, 0];
      this.frame = makeLocalFrame(first[1], first[0]);
    }
    const xy = ([lng, lat]) => this.frame.toXY(lat, lng);
    this.perimeter = perimeter && perimeter.length > 2 ? perimeter.map(xy) : null;

    const failed = [];
    const keep = new Set();
    for (const zd of zones) {
      keep.add(zd.id);
      let z = this.zones.get(zd.id);
      if (!z) { z = { level: 0 }; this.zones.set(zd.id, z); }
      z.name = zd.name;
      // Shape
      if (zd.shape.type === 'Circle') {
        const c = xy(zd.shape.center), r = zd.shape.radiusM;
        z.depthFn = (p) => r - Math.hypot(p[0] - c[0], p[1] - c[1]);
        z.maxDepth = r;
      } else {
        const ring = zd.shape.ring.map(xy);
        z.depthFn = (p) => ringDepth(p, ring);
        z.maxDepth = maxRingDepth(ring);
      }
      // Audio
      if (z.audioKey !== zd.audioKey) {
        this.stopSource(z);
        z.audioKey = zd.audioKey;
        z.buffer = null;
        if (zd.audioKey) {
          try {
            const blob = await zd.getBlob();
            if (!blob) throw new Error('missing');
            z.buffer = await this.ctx.decodeAudioData(await blob.arrayBuffer());
            this.startSource(z);
          } catch (e) { failed.push(zd.name); }
        }
      }
    }
    for (const [id, z] of this.zones) if (!keep.has(id)) { this.stopSource(z); this.zones.delete(id); }
    if (this.position) this.setPosition(...this.position);
    return failed;
  }

  // Start the loop at the point the shared clock says it should be at.
  startSource(z) {
    if (!z.buffer || !this.ctx) return;
    const dur = z.buffer.duration;
    const offset = (((Date.now() - this.epochMs) / 1000) % dur + dur) % dur;
    z.gain = this.ctx.createGain();
    z.gain.gain.value = 0;
    z.gain.connect(this.master);
    z.src = this.ctx.createBufferSource();
    z.src.buffer = z.buffer;
    z.src.loop = true;
    z.src.connect(z.gain);
    z.src.start(0, offset);
  }

  stopSource(z) {
    try { z.src?.stop(); } catch (e) {}
    z.src?.disconnect(); z.gain?.disconnect();
    z.src = z.gain = null;
  }

  // Returns [{ id, name, level, depthM }] for every zone, loudest first.
  setPosition(lat, lng) {
    this.position = [lat, lng];
    if (!this.frame) return [];
    const p = this.frame.toXY(lat, lng);
    const inPerimeter = !this.perimeter || insideRing(p, this.perimeter);
    const now = this.ctx?.currentTime ?? 0;
    const out = [];
    for (const [id, z] of this.zones) {
      const depth = z.depthFn(p);
      const feather = Math.min(this.featherM, z.maxDepth);
      z.level = inPerimeter && depth > 0 ? smoothstep(depth / feather) : 0;
      z.gain?.gain.setTargetAtTime(z.level, now, RAMP_S / 3);
      out.push({ id, name: z.name, level: z.level, depthM: depth, hasAudio: !!z.buffer });
    }
    this.inPerimeter = inPerimeter;
    return out.sort((a, b) => b.level - a.level);
  }
}
