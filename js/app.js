// ── Ryewired App Bootstrap ────────────────────────────────────────────────────

const APP_VERSION = '0.1.0';

// Zoom state
let _zoomLevel = 1.0;
const ZOOM_MIN  = 0.3;
const ZOOM_MAX  = 2.0;
const ZOOM_STEP = 0.15;

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

  // Board callbacks
  Board.onSelect(inst => PropertiesPanel.show(inst));

  Board.onPlace(inst => {
    Storage.markDirty();
    const label = ComponentRegistry.getById(inst.defId)?.label || inst.defId;
    setStatus(`Placed ${label} — select it to set properties`);
    updateComponentCount();
  });

  // Simulation callbacks
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

  // Help modal
  document.getElementById('help-close').addEventListener('click', () => closeHelp());
  document.getElementById('help-backdrop').addEventListener('click', () => closeHelp());
  document.getElementById('help-version').textContent = 'Version ' + APP_VERSION;

  // Failure backdrop
  document.getElementById('failure-backdrop').addEventListener('click', () => {
    document.getElementById('failure-overlay').classList.add('hidden');
    Simulation.reset();
  });

  // Bind all data-action buttons and menu items
  bindActions();
  initMenubar();
  initScopeKnobs();
  initZoom();

  // Keyboard shortcuts
  document.addEventListener('keydown', onKeyDown);

  // Ctrl+scroll to zoom
  document.getElementById('board-scroll').addEventListener('wheel', e => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      e.deltaY < 0 ? zoomIn() : zoomOut();
    }
  }, { passive: false });

  // Fit board on load after a short delay to let layout settle
  setTimeout(fitBoard, 100);

  // Refit on window resize
  window.addEventListener('resize', Utils.debounce(fitBoard, 200));

  Storage.newLayout();
  setStatus('Drop a component to get started — press W to wire holes together');

})();

// ── Action dispatcher ─────────────────────────────────────────────────────────

function handleAction(action) {
  switch (action) {
    case 'new':           newLayout();           break;
    case 'open':          openLayout();          break;
    case 'save':          saveLayout(false);     break;
    case 'save-as':       saveLayout(true);      break;
    case 'import-audio':  importAudio();         break;
    case 'undo':          /* TODO */             break;
    case 'redo':          /* TODO */             break;
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
    case 'toggle-scope':    togglePanel('scope-panel', 'btn-toggle-scope');       break;
    case 'toggle-spectrum': togglePanel('spectrum-panel', 'btn-toggle-spectrum'); break;
    case 'toggle-palette':  toggleSidebar('palette');                             break;
    case 'toggle-props':    toggleSidebar('props-panel');                         break;
    case 'wire-mode':       toggleWireMode();                                     break;
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
  if (Board.getPlaced().length === 0) {
    setStatus('Place some components first');
    return;
  }
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

async function importAudio() {
  const fileData = await Storage.openAudioFile();
  if (!fileData) return;
  const name = await AudioEngine.loadAudioFile(fileData);
  if (!name) { setStatus('Could not decode audio file'); return; }
  const sigGen = Board.getPlaced().find(p => p.defId === 'signal_generator');
  if (sigGen) {
    sigGen.props.waveform   = 'Audio File';
    sigGen.props.audio_file = name;
    PropertiesPanel.show(Board.getSelected() || sigGen);
  }
  setStatus(`Audio loaded: ${name}`);
}

// ── Wiring mode ───────────────────────────────────────────────────────────────

let _wiringActive = false;

function toggleWireMode() {
  _wiringActive = !_wiringActive;
  const btn = document.getElementById('btn-wire-mode');

  if (_wiringActive) {
    Wire.enter();
    btn?.classList.add('active');
    document.getElementById('status-wire-mode').textContent = '⬡ WIRING';
    setStatus('Wiring mode ON — click a hole to start a wire, click another hole to finish. Press W or Esc to cancel.');
  } else {
    Wire.exit();
    btn?.classList.remove('active');
    document.getElementById('status-wire-mode').textContent = '';
    setStatus('Wiring mode off');
  }
}

function exitWireMode() {
  if (!_wiringActive) return;
  _wiringActive = false;
  Wire.exit();
  document.getElementById('btn-wire-mode')?.classList.remove('active');
  document.getElementById('status-wire-mode').textContent = '';
}

// ── Zoom ──────────────────────────────────────────────────────────────────────

function initZoom() {
  applyZoom(_zoomLevel);
}

function zoomIn() {
  applyZoom(Math.min(ZOOM_MAX, _zoomLevel + ZOOM_STEP));
}

function zoomOut() {
  applyZoom(Math.max(ZOOM_MIN, _zoomLevel - ZOOM_STEP));
}

function fitBoard() {
  const scroll  = document.getElementById('board-scroll');
  const canvas  = document.getElementById('board-canvas');
  if (!scroll || !canvas) return;

  const availW  = scroll.clientWidth  - 56;  // padding
  const availH  = scroll.clientHeight - 56;
  const boardW  = canvas.width;
  const boardH  = canvas.height;

  if (!boardW || !boardH) return;

  const scale = Math.min(availW / boardW, availH / boardH, 1.0);
  applyZoom(Math.max(ZOOM_MIN, scale));
}

function applyZoom(level) {
  _zoomLevel = level;
  const t = document.getElementById('board-transform');
  if (t) t.style.transform = `scale(${level})`;

  const el = document.getElementById('zoom-level');
  if (el) el.textContent = Math.round(level * 100) + '%';
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

// ── Help modal ────────────────────────────────────────────────────────────────

function openHelp() {
  document.getElementById('help-overlay').classList.remove('hidden');
}

function closeHelp() {
  document.getElementById('help-overlay').classList.add('hidden');
}

// ── Scope knob labels ─────────────────────────────────────────────────────────

function initScopeKnobs() {
  const pairs = [['scope-vdiv','scope-vdiv-val'], ['scope-tdiv','scope-tdiv-val']];
  pairs.forEach(([rangeId, valId]) => {
    const range = document.getElementById(rangeId);
    const val   = document.getElementById(valId);
    if (range && val) {
      range.addEventListener('input', () => {
        val.textContent = parseFloat(range.value).toFixed(1);
      });
    }
  });
}

// ── Keyboard shortcuts ────────────────────────────────────────────────────────

function onKeyDown(e) {
  const target = e.target;
  const typing = ['INPUT','TEXTAREA','SELECT'].includes(target.tagName);

  // Escape — multipurpose close/cancel
  if (e.code === 'Escape') {
    if (document.getElementById('help-overlay')?.classList.contains('hidden') === false) {
      closeHelp(); return;
    }
    if (document.querySelector('.menu-item.open')) {
      document.querySelectorAll('.menu-item').forEach(m => m.classList.remove('open')); return;
    }
    if (_wiringActive) { exitWireMode(); return; }
    if (Simulation.isRunning()) { stopSim(); return; }
  }

  if (typing) return;

  // Space = run/stop
  if (e.code === 'Space') {
    e.preventDefault();
    Simulation.isRunning() ? stopSim() : runSim();
  }

  // W = wiring mode toggle
  if (e.code === 'KeyW') toggleWireMode();

  // Delete / Backspace = remove selected
  if (e.code === 'Delete' || e.code === 'Backspace') {
    Board.deleteSelected();
    PropertiesPanel.hide();
    updateComponentCount();
    Storage.markDirty();
  }

  // + / – zoom
  if (e.key === '+' || e.key === '=') zoomIn();
  if (e.key === '-' || e.key === '_') zoomOut();

  // Ctrl shortcuts
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
    Board.clear();
    PropertiesPanel.hide();
    updateComponentCount();
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
    if (label)   label.textContent   = 'Running';
    if (runBtn)  runBtn.disabled  = true;
    if (stopBtn) stopBtn.disabled = false;
  } else {
    indicator?.classList.remove('running');
    if (label)   label.textContent   = 'Stopped';
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
