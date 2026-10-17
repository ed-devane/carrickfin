// smoothing.js — simple exponential smoothing for position and heading.
//
// factor 0 = no smoothing (follow raw input), towards 1 = heavier smoothing
// (slower to respond). Each new sample moves the smoothed value by (1 − factor)
// of the way towards it. Kept adjustable so it can be tuned on the beach.

export class PositionSmoother {
  constructor(factor = 0.3) { this.factor = factor; this.x = null; this.y = null; }
  reset() { this.x = this.y = null; }
  push(x, y) {
    if (this.x === null) { this.x = x; this.y = y; }
    else {
      const k = 1 - this.factor;
      this.x += (x - this.x) * k;
      this.y += (y - this.y) * k;
    }
    return [this.x, this.y];
  }
}

// Headings wrap at 360°, so averaging 350° and 10° must give 0°, not 180°.
// We smooth the unit vector (sin, cos) instead of the angle itself.
export class HeadingSmoother {
  constructor(factor = 0.2) { this.factor = factor; this.s = null; this.c = null; }
  reset() { this.s = this.c = null; }
  push(deg) {
    const r = deg * Math.PI / 180;
    const s = Math.sin(r), c = Math.cos(r);
    if (this.s === null) { this.s = s; this.c = c; }
    else {
      const k = 1 - this.factor;
      this.s += (s - this.s) * k;
      this.c += (c - this.c) * k;
    }
    return (Math.atan2(this.s, this.c) * 180 / Math.PI + 360) % 360;
  }
}

// Smallest signed difference a − b in degrees, in the range −180..180.
export function angleDiff(a, b) {
  return ((a - b + 540) % 360) - 180;
}
