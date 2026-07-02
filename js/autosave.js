// ── AutoSave Module ───────────────────────────────────────────────────────────
// Persists current board state to localStorage after every History.push().
// On app load, restores the last session automatically.

const AutoSave = (() => {
  const KEY         = 'ryewired_autosave';
  const META_KEY    = 'ryewired_autosave_meta';
  const DEBOUNCE_MS = 800;
  let _timer = null;

  // Called by History.push() — debounced so rapid changes don't thrash storage
  function save() {
    clearTimeout(_timer);
    _timer = setTimeout(_write, DEBOUNCE_MS);
  }

  function _write() {
    try {
      const data = Board.getLayoutData();
      if (!data.components.length && !data.wires.length) return; // don't save empty board
      localStorage.setItem(KEY, JSON.stringify(data));
      localStorage.setItem(META_KEY, JSON.stringify({
        savedAt:    new Date().toISOString(),
        components: data.components.length,
        wires:      data.wires.length,
      }));
    } catch(e) {
      console.warn('[AutoSave] Could not write to localStorage:', e.message);
    }
  }

  // Called on app init — restores last session if present
  function restore() {
    try {
      const raw  = localStorage.getItem(KEY);
      const meta = localStorage.getItem(META_KEY);
      if (!raw) return;

      const layout = JSON.parse(raw);
      if (!layout?.components?.length && !layout?.wires?.length) return;

      // Migrate if needed (same as Storage.migrateLayout)
      if (typeof Storage !== 'undefined' && Storage.migrateLayout) {
        Storage.migrateLayout(layout);
      } else {
        // Inline migration for autosave
        layout.components = (layout.components || []).map(inst => {
          if (inst.legs && inst.legs.length > 0) return inst;
          const row = inst.row ?? 3, col = inst.col ?? 10;
          inst.legs = [{row, col}, {row, col: Math.min(62, col+1)}];
          delete inst.row; delete inst.col; delete inst.orientation;
          return inst;
        });
      }

      Board.loadLayout(layout);
      PropertiesPanel.hide();

      const n = layout.components.length;
      const w = layout.wires.length;
      let msg = `Restored autosave — ${n} component${n!==1?'s':''}, ${w} wire${w!==1?'s':''}`;

      if (meta) {
        const m = JSON.parse(meta);
        const d = new Date(m.savedAt);
        const timeStr = d.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
        const dateStr = d.toLocaleDateString([], {month:'short', day:'numeric'});
        msg += ` (${dateStr} ${timeStr})`;
      }

      const statusEl = document.getElementById('status-msg');
      if (statusEl) statusEl.textContent = msg;

      // Update component count
      const countEl = document.getElementById('status-component-count');
      if (countEl) countEl.textContent = n ? `${n} component${n!==1?'s':''}` : '';

    } catch(e) {
      console.warn('[AutoSave] Could not restore:', e.message);
    }
  }

  // Called on New Layout / Open / Clear Board
  function clear() {
    try {
      localStorage.removeItem(KEY);
      localStorage.removeItem(META_KEY);
    } catch(e) {}
  }

  function hasAutosave() {
    try { return !!localStorage.getItem(KEY); }
    catch(e) { return false; }
  }

  return { save, restore, clear, hasAutosave };
})();
