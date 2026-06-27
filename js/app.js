// ── Ryewired App Bootstrap ────────────────────────────────────────────────────

const APP_VERSION = '0.1.0';

// Zoom state — constrained to 10% increments
let _zoomLevel = 1.0;
const ZOOM_MIN  = 0.1;
const ZOOM_MAX  = 2.0;
const ZOOM_STEP = 0.1;

// Pan state (right-mouse drag)
let _panning    = false;
let _panStartX  = 0;
let _panStartY  = 0;
let _panScrollX = 0;
let _panScrollY = 0;

(async function initApp() {

  await ComponentRegistry.load();

  Board.init(document.getElementById('board-canvas'));
  Palette.init();
  Palette.populate(ComponentRegistry.getAll());
  PropertiesPanel.init();
  Oscilloscope.init(
    document.getElementById('scope-canvas'),
    document.getElementById('spectrum-canvas')
  );

  Board.onSelect(inst => PropertiesPanel.show(inst));

  Board.onPlace(inst => {
    Storage.markDirty();
    const label = ComponentRegistry.getById(inst.defId)?.label || inst.defId;
    setStatus(`Placed ${label} — select it to set properties`);
    updateComponentCount();
  });

  Simulation.onFailure(({ icon, title, message }) => {
    AudioEngine.stop();
    Oscilloscope.stop();
    setSimState('stopped');
    document.getElementById('failure-icon').textContent    = icon;
    document.getElementById('failure-title').textContent   = title;
    document.getElementById('failure-message').textContent = message;
    document.getElementById('failure-overlay').classList.remove('hidden');
  });

  document.getElementById('failure-dismiss').addEventListener('click', () => {
    document.getElementById('failure-overlay').classList.add('hidden');
    Simulation.reset();
    setStatus('Failures cleared — fix the circuit and try again');
  });

  document.getElementById('help-close').addEventListener('click',    () => closeHelp());
  document.getElementById('help-backdrop').addEventListener('click', () => closeHelp());
  document.getElementById('failure-backdrop').addEventListener('click', () => {
    document.getElementById('failure-overlay').classList.add('hidden');
    Simulation.reset();
  });

  bindActions();
  initMenubar();
  initScopeKnobs();
  initZoom();
  initPan();

  document.addEventListener('keydown', onKeyDown);

  setTimeout(fitBoard, 100);
  window.addEventListener('resize', Utils.debounce(fitBoard, 200));

  Storage.newLayout();
  setStatus('Drop a component to get started — press W to place jumper wires');

})();

// ── Action dispatcher ─────────────────────────────────────────────────────────

function handleAction(action) {
  switch (action) {
    case 'new':           newLayout();           break;
    case 'open':          openLayout();          break;
    case 'save':          saveLayout(false);     break;
    case 'save-as':       saveLayout(true);      break;
    case 'delete':
      Board.deleteSelected();
      PropertiesPanel.hide();
      updateComponentCount();
      Storage.markDirty();
      break;
    case 'clear':         confirmClear();        break;
    case 'sim-run':       runSim();              break;
    case 'sim-stop':      stopSim();             break;
    case 'sim-reset':
      Simulation.reset();
      setStatus('Failures cleared — components and wires unchanged');
      break;
    case 'toggle-scope':    togglePanel('scope-panel',    'btn-toggle-scope');    break;
    case 'toggle-spectrum': togglePanel('spectrum-panel', 'btn-toggle-spectrum'); break;
    case 'toggle-palette':  toggleSidebar('palette');                             break;
    case 'toggle-props':    toggleSidebar('props-panel');                         break;
    case 'wire-mode':       toggleJumperMode();                                   break;
    case 'zoom-in':         zoomIn();            break;
    case 'zoom-out':        zoomOut();           break;
    case 'zoom-fit':        fitBoard();          break;
    case 'help':            openHelp();          break;
  }
}

function bindActions() {
  document.addEventListener('click', e => {
    const btn = e.target.closest('[data-action]');
    if (btn) handleAction(btn.dataset.action);
  });
}

// ── Menubar ───────────────────────────────────────────────────────────────────

function initMenubar() {
  const menuItems = document.querySelectorAll('.menu-item');
  menuItems.forEach(item => {
    item.querySelector('span').addEventListener('click', e => {
      e.stopPropagation();
      const isOpen = item.classList.contains('open');
      menuItems.forEach(m => m.classList.remove('open'));
      if (!isOpen) item.classList.add('open');
    });
    item.addEventListener('mouseenter', () => {
      const anyOpen = document.querySelector('.menu-item.open');
      if (anyOpen && anyOpen !== item) {
        menuItems.forEach(m => m.classList.remove('open'));
        item.classList.add('open');
      }
    });
  });
  document.addEventListener('click', () => {
    menuItems.forEach(m => m.classList.remove('open'));
  });
}

// ── Simulation ────────────────────────────────────────────────────────────────

function runSim() {
  if (Simulation.isRunning()) return;
  if (Board.getPlaced().length === 0) { setStatus('Place some components first'); return; }
  Simulation.start();
  AudioEngine.start();
  Oscilloscope.start();
  setSimState('running');
  setStatus('Simulation running');
}

function stopSim() {
  if (!Simulation.isRunning()) return;
  Simulation.stop();
  AudioEngine.stop();
  Oscilloscope.stop();
  setSimState('stopped');
  setStatus('Simulation stopped');
}

// ── Layout I/O ────────────────────────────────────────────────────────────────

async function newLayout() {
  if (Simulation.isRunning()) stopSim();
  if (Board.getPlaced().length > 0) {
    if (!confirm('Start a new layout? Unsaved changes will be lost.')) return;
  }
  Board.clear();
  PropertiesPanel.hide();
  Storage.newLayout();
  updateComponentCount();
  setStatus('New layout — drop components to get started');
}

async function openLayout() {
  if (Simulation.isRunning()) stopSim();
  const layout = await Storage.openLayout();
  if (!layout) return;
  Board.loadLayout(layout);
  PropertiesPanel.hide();
  updateComponentCount();
  setStatus(`Loaded — ${layout.components?.length || 0} components`);
}

async function saveLayout(forceDialog = false) {
  const data   = Board.getLayoutData();
  const result = await Storage.saveLayout(data, forceDialog);
  if (result?.saved) setStatus(`Saved: ${result.fileName}`);
}

// ── Jumper mode ───────────────────────────────────────────────────────────────

let _jumperActive = false;

function toggleJumperMode() {
  _jumperActive = !_jumperActive;
  const btn = document.getElementById('btn-wire-mode');
  if (_jumperActive) {
    Wire.enter();
    btn?.classList.add('active');
    document.getElementById('status-wire-mode').textContent = '⬡ JUMPER';
    setStatus('Jumper mode ON — click a hole to start a wire, click another hole to finish. Press W or Esc to exit.');
  } else {
    Wire.exit();
    btn?.classList.remove('active');
    document.getElementById('status-wire-mode').textContent = '';
    setStatus('Jumper mode off');
  }
}

function exitJumperMode() {
  if (!_jumperActive) return;
  _jumperActive = false;
  Wire.exit();
  document.getElementById('btn-wire-mode')?.classList.remove('active');
  document.getElementById('status-wire-mode').textContent = '';
}

// ── Zoom (10% increments, 10%–200%) ──────────────────────────────────────────

function initZoom() { applyZoom(1.0); }

function zoomIn()  { applyZoom(Math.min(ZOOM_MAX, snapZoom(_zoomLevel + ZOOM_STEP))); }
function zoomOut() { applyZoom(Math.max(ZOOM_MIN, snapZoom(_zoomLevel - ZOOM_STEP))); }

function snapZoom(v) {
  return Math.round(v / ZOOM_STEP) * ZOOM_STEP;
}

function fitBoard() {
  const scroll = document.getElementById('board-scroll');
  const canvas = document.getElementById('board-canvas');
  if (!scroll || !canvas) return;
  const availW = scroll.clientWidth  - 56;
  const availH = scroll.clientHeight - 56;
  const boardW = canvas.width;
  const boardH = canvas.height;
  if (!boardW || !boardH) return;
  const raw   = Math.min(availW / boardW, availH / boardH, 1.0);
  const snapped = Math.max(ZOOM_MIN, snapZoom(raw));
  applyZoom(snapped);
}

function applyZoom(level) {
  _zoomLevel = Math.round(level * 10) / 10; // ensure clean 10% values
  _zoomLevel = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, _zoomLevel));
  const t = document.getElementById('board-transform');
  if (t) t.style.transform = `scale(${_zoomLevel})`;
  const el = document.getElementById('zoom-level');
  if (el) el.textContent = Math.round(_zoomLevel * 100) + '%';
  // Notify board of current zoom so hit-testing stays correct
  Board.setZoom(_zoomLevel);
}

function getZoom() { return _zoomLevel; }

// ── Pan (right-mouse drag) ────────────────────────────────────────────────────

function initPan() {
  const scroll = document.getElementById('board-scroll');
  if (!scroll) return;

  scroll.addEventListener('mousedown', e => {
    if (e.button !== 2) return;
    e.preventDefault();
    _panning    = true;
    _panStartX  = e.clientX;
    _panStartY  = e.clientY;
    _panScrollX = scroll.scrollLeft;
    _panScrollY = scroll.scrollTop;
    scroll.style.cursor = 'grabbing';
  });

  window.addEventListener('mousemove', e => {
    if (!_panning) return;
    const dx = e.clientX - _panStartX;
    const dy = e.clientY - _panStartY;
    scroll.scrollLeft = _panScrollX - dx;
    scroll.scrollTop  = _panScrollY - dy;
  });

  window.addEventListener('mouseup', e => {
    if (e.button !== 2 || !_panning) return;
    _panning = false;
    scroll.style.cursor = '';
  });

  // Scroll wheel zooms (no modifier needed)
  scroll.addEventListener('wheel', e => {
    e.preventDefault();
    if (e.deltaY < 0) zoomIn(); else zoomOut();
  }, { passive: false });
}

// ── Panel toggles ─────────────────────────────────────────────────────────────

function togglePanel(panelId, btnId) {
  const panel  = document.getElementById(panelId);
  const btn    = document.getElementById(btnId);
  const hidden = panel.classList.toggle('hidden');
  btn?.classList.toggle('active', !hidden);
}

function toggleSidebar(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.style.display = el.style.display === 'none' ? '' : 'none';
}

// ── Help ──────────────────────────────────────────────────────────────────────

function openHelp()  { document.getElementById('help-overlay').classList.remove('hidden'); }
function closeHelp() { document.getElementById('help-overlay').classList.add('hidden'); }

// ── Scope knobs ───────────────────────────────────────────────────────────────

function initScopeKnobs() {
  [['scope-vdiv','scope-vdiv-val'], ['scope-tdiv','scope-tdiv-val']].forEach(([rid, vid]) => {
    const r = document.getElementById(rid), v = document.getElementById(vid);
    if (r && v) r.addEventListener('input', () => { v.textContent = parseFloat(r.value).toFixed(1); });
  });
}

// ── Keyboard shortcuts ────────────────────────────────────────────────────────

function onKeyDown(e) {
  const typing = ['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName);

  if (e.code === 'Escape') {
    if (!document.getElementById('help-overlay').classList.contains('hidden')) { closeHelp(); return; }
    if (document.querySelector('.menu-item.open')) {
      document.querySelectorAll('.menu-item').forEach(m => m.classList.remove('open')); return;
    }
    if (_jumperActive) { exitJumperMode(); return; }
    if (Wire.hasStart()) { Wire.cancelCurrent(); return; }
    if (Simulation.isRunning()) { stopSim(); return; }
  }

  if (typing) return;

  if (e.code === 'Space')  { e.preventDefault(); Simulation.isRunning() ? stopSim() : runSim(); }
  if (e.code === 'KeyW')   { toggleJumperMode(); }
  if (e.code === 'Delete' || e.code === 'Backspace') {
    Board.deleteSelected(); PropertiesPanel.hide(); updateComponentCount(); Storage.markDirty();
  }

  // Zoom with + / -
  if (e.key === '+' || e.key === '=') zoomIn();
  if (e.key === '-' || e.key === '_') zoomOut();

  if (e.ctrlKey || e.metaKey) {
    if (e.key === 'n') { e.preventDefault(); newLayout(); }
    if (e.key === 'o') { e.preventDefault(); openLayout(); }
    if (e.key === 's') { e.preventDefault(); saveLayout(e.shiftKey); }
    if (e.key === '0') { e.preventDefault(); fitBoard(); }
    if (e.key === 'd') { e.preventDefault(); togglePanel('scope-panel', 'btn-toggle-scope'); }
    if (e.key === 'D') { e.preventDefault(); togglePanel('spectrum-panel', 'btn-toggle-spectrum'); }
    if (e.key === 'f') { e.preventDefault(); document.getElementById('palette-search')?.focus(); }
  }
}

// ── Utility ───────────────────────────────────────────────────────────────────

function confirmClear() {
  if (Board.getPlaced().length === 0) return;
  if (confirm('Clear the board? This cannot be undone.')) {
    if (Simulation.isRunning()) stopSim();
    Board.clear(); PropertiesPanel.hide(); updateComponentCount();
    setStatus('Board cleared');
  }
}

function setSimState(state) {
  const indicator = document.getElementById('sim-indicator');
  const label     = document.getElementById('sim-indicator-label');
  const runBtn    = document.getElementById('btn-run');
  const stopBtn   = document.getElementById('btn-stop');
  if (state === 'running') {
    indicator?.classList.add('running');
    if (label)   label.textContent = 'Running';
    if (runBtn)  runBtn.disabled  = true;
    if (stopBtn) stopBtn.disabled = false;
  } else {
    indicator?.classList.remove('running');
    if (label)   label.textContent = 'Stopped';
    if (runBtn)  runBtn.disabled  = false;
    if (stopBtn) stopBtn.disabled = true;
  }
}

function setStatus(msg) {
  const el = document.getElementById('status-msg');
  if (el) el.textContent = msg;
}

function updateComponentCount() {
  const el    = document.getElementById('status-component-count');
  if (!el) return;
  const count = Board.getPlaced().length;
  el.textContent = count ? `${count} component${count !== 1 ? 's' : ''}` : '';
}
