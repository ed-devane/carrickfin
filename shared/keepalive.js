// keepalive.js — keep the screen (and so GPS + audio) alive during a walk.
//
// Wake Lock API is supported on both target phones (Chrome Android, iOS
// Safari 16.4+). The browser drops the lock whenever the page is hidden, so we
// re-acquire it on `visibilitychange` — same pattern as SoniCraft / BLE-MIDI.
// TODO (milestone 4): fallback for browsers with no Wake Lock API.

export class WakeLock {
  constructor(onChange = () => {}) {
    this.lock = null;
    this.wanted = false;
    this.onChange = onChange;
    this.supported = 'wakeLock' in navigator;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.wanted && !this.lock) this._acquire();
    });
  }
  get active() { return !!this.lock; }

  async enable() { this.wanted = true; await this._acquire(); }
  async disable() {
    this.wanted = false;
    if (this.lock) { try { await this.lock.release(); } catch (e) {} }
    this.lock = null;
    this.onChange('released (by app)');
  }

  async _acquire() {
    if (!this.supported) { this.onChange('unsupported'); return; }
    try {
      this.lock = await navigator.wakeLock.request('screen');
      this.onChange('active');
      this.lock.addEventListener('release', () => {
        this.lock = null;
        if (this.wanted) this.onChange('released (by browser)');
      });
    } catch (e) {
      this.onChange('failed: ' + e.message);
    }
  }
}

// Pocket mode: a black full-screen layer that swallows every touch, so a lit
// screen in a pocket can't press anything. Exit = hold TWO fingers on the
// screen for 2 seconds (very unlikely to happen by accident in a pocket).
export class PocketMode {
  constructor({ holdMs = 2000, onExit = () => {} } = {}) {
    this.holdMs = holdMs;
    this.onExit = onExit;
    this.el = document.createElement('div');
    this.el.className = 'pocket-overlay';
    this.el.innerHTML = '<div class="pocket-hint">Hold two fingers for 2 s to exit</div>';
    this.timer = null;

    const swallow = (e) => { e.preventDefault(); e.stopPropagation(); };
    for (const ev of ['click', 'mousedown', 'mouseup', 'contextmenu']) {
      this.el.addEventListener(ev, swallow);
    }
    this.el.addEventListener('touchstart', (e) => {
      swallow(e);
      if (e.touches.length >= 2 && !this.timer) {
        this.timer = setTimeout(() => this.exit(), this.holdMs);
      }
    }, { passive: false });
    const cancel = (e) => {
      swallow(e);
      if (e.touches.length < 2) { clearTimeout(this.timer); this.timer = null; }
    };
    this.el.addEventListener('touchend', cancel, { passive: false });
    this.el.addEventListener('touchcancel', cancel, { passive: false });
    this.el.addEventListener('touchmove', swallow, { passive: false });
    // Desktop testing: double-click exits.
    this.el.addEventListener('dblclick', () => this.exit());
  }
  enter() {
    document.body.appendChild(this.el);
    // Fade the hint out so the screen is fully black.
    this.el.classList.remove('settled');
    setTimeout(() => this.el.classList.add('settled'), 3000);
  }
  exit() {
    clearTimeout(this.timer); this.timer = null;
    this.el.remove();
    this.onExit();
  }
  get on() { return this.el.isConnected; }
}
