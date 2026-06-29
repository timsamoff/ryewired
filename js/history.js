// ── History Module ────────────────────────────────────────────────────────────
// Undo/redo via snapshots of board layout state.
// Max 50 entries. Each entry is a JSON string of Board.getLayoutData().

const History = (() => {
  const MAX   = 50;
  let _past   = [];   // stack of JSON strings (oldest first)
  let _future = [];   // stack for redo
  let _debounceTimer = null;

  // Push current board state. Call AFTER an action is committed.
  function push() {
    const snap = JSON.stringify(Board.getLayoutData());
    // Don't push duplicate states
    if (_past.length && _past[_past.length - 1] === snap) return;
    _past.push(snap);
    if (_past.length > MAX) _past.shift();
    _future = [];   // any new action clears redo stack
    updateButtons();
  }

  // Debounced push — for rapid changes like property sliders
  function pushDebounced(ms = 400) {
    clearTimeout(_debounceTimer);
    _debounceTimer = setTimeout(push, ms);
  }

  function undo() {
    if (_past.length < 2) return;      // need at least current + one previous
    _future.push(_past.pop());          // move current to redo stack
    const snap = _past[_past.length - 1];
    restoreSnapshot(snap);
    updateButtons();
  }

  function redo() {
    if (!_future.length) return;
    const snap = _future.pop();
    _past.push(snap);
    restoreSnapshot(snap);
    updateButtons();
  }

  function restoreSnapshot(snap) {
    const layout = JSON.parse(snap);
    Board.loadLayout(layout);
    PropertiesPanel.hide();
    // Update component count in status bar
    const el = document.getElementById('status-component-count');
    if (el) {
      const n = layout.components?.length || 0;
      el.textContent = n ? `${n} component${n !== 1 ? 's' : ''}` : '';
    }
  }

  function canUndo() { return _past.length >= 2; }
  function canRedo() { return _future.length > 0; }

  function clear() { _past = []; _future = []; updateButtons(); }

  // Push the initial empty-board state so first undo goes back to blank
  function init() {
    _past   = [];
    _future = [];
    push();   // snapshot of empty board
    updateButtons();
  }

  function updateButtons() {
    const undoBtn = document.getElementById('btn-undo');
    const redoBtn = document.getElementById('btn-redo');
    if (undoBtn) undoBtn.disabled = !canUndo();
    if (redoBtn) redoBtn.disabled = !canRedo();

    // Also update menu items (they don't have disabled state natively,
    // but we can add a CSS class)
    document.querySelectorAll('[data-action="undo"]').forEach(el => {
      el.classList.toggle('dd-disabled', !canUndo());
    });
    document.querySelectorAll('[data-action="redo"]').forEach(el => {
      el.classList.toggle('dd-disabled', !canRedo());
    });
  }

  return { push, pushDebounced, undo, redo, canUndo, canRedo, clear, init };
})();
