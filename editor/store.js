// store.js — the editor's working state, autosaved in this browser.
//
// Everything lives in IndexedDB so a closed tab or a phone crash mid-walk
// loses nothing. Audio files are stored as blobs, keyed by id. "Save piece"
// (io.js) is what produces the files that go into the repo.
//
// State shape:
//   title       string
//   perimeter   [[lng, lat], ...] ring, or null
//   tracks      [{ id, name, points: [[lng, lat, tMs, accM], ...] }]
//   pins        [{ id, name, lng, lat, accM, t }]
//   zones       [{ id, name, shape, audio: { id, name, durationSec } | null }]
//               shape = { type: 'Polygon', ring: [[lng, lat], ...] }
//                     | { type: 'Circle', center: [lng, lat], radiusM }

const DB_NAME = 'soundwalk-editor'; // internal; renaming would lose saved work
let dbp = null;

function db() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore('kv');
        req.result.createObjectStore('audio');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbp;
}

async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
  });
}

export const audioStore = {
  put: (id, rec) => tx('audio', 'readwrite', s => s.put(rec, id)),
  get: (id) => tx('audio', 'readonly', s => s.get(id)),
  clear: () => tx('audio', 'readwrite', s => s.clear()),
};

export function emptyState() {
  return { title: 'Untitled piece', perimeter: null, tracks: [], pins: [], zones: [] };
}

export function newId(prefix) {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// ---------- state + undo ----------
export const store = {
  state: emptyState(),
  undoStack: [],
  listeners: new Set(),

  async load() {
    try {
      const s = await tx('kv', 'readonly', st => st.get('state'));
      if (s) this.state = { ...emptyState(), ...s };
    } catch (e) { console.warn('Could not load saved state', e); }
  },

  // Every change goes through here: snapshot for undo, apply, save, notify.
  change(fn, { undoable = true } = {}) {
    if (undoable) {
      this.undoStack.push(JSON.stringify(this.state));
      if (this.undoStack.length > 50) this.undoStack.shift();
    }
    fn(this.state);
    this.save();
    this.listeners.forEach(l => l());
  },

  undo() {
    const prev = this.undoStack.pop();
    if (!prev) return false;
    this.state = JSON.parse(prev);
    this.save();
    this.listeners.forEach(l => l());
    return true;
  },

  replace(newState) {
    this.undoStack.push(JSON.stringify(this.state));
    this.state = { ...emptyState(), ...newState };
    this.save();
    this.listeners.forEach(l => l());
  },

  // Debounced so a recording walk (1 fix/s) doesn't hammer the disk.
  _saveTimer: null,
  save() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.saveNow(), 1000);
  },
  saveNow() {
    clearTimeout(this._saveTimer);
    return tx('kv', 'readwrite', st => st.put(this.state, 'state'))
      .catch(e => console.warn('Autosave failed', e));
  },

  onChange(fn) { this.listeners.add(fn); },

  find(id) {
    const s = this.state;
    if (id === 'perimeter') return s.perimeter ? { kind: 'perimeter' } : null;
    for (const kind of ['tracks', 'pins', 'zones']) {
      const item = s[kind].find(x => x.id === id);
      if (item) return { kind: kind.slice(0, -1), item };
    }
    return null;
  },
};
