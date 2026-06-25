// ── Ryewired App Bootstrap ────────────────────────────────────────────────────

(async function initApp() {

  // ── 1. Load component definitions ──────────────────────────────────────────
  await ComponentRegistry.load();

  // ── 2. Init modules ─────────────────────────────────────────────────────────
  Board.init(document.getElementById('board-canvas'));
  Palette.init();
  Palette.populate(ComponentRegistry.getAll());
  PropertiesPanel.init();
  Oscilloscope.init(
    document.getElementById('scope-canvas'),
    document.getElementById('spectrum-canvas')
  );

  // ── 3. Board callbacks ──────────────────────────────────────────────────────
  Board.onSelect(inst => PropertiesPanel.show(inst));

  Board.onPlace(inst => {
    Storage.markDirty();
    const label = ComponentRegistry.getById(inst.defId)?.label || inst.defId;
    setStatus(`Placed ${label} — select it to set properties`);
    updateComponentCount();
  });

  // ── 4. Simulation callbacks ─────────────────────────────────────────────────
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
    setStatus('Board reset — fix the circuit and try again');
  });

  // ── 5. Toolbar + menubar actions ────────────────────────────────────────────
  bindActions();

  // ── 6. Menubar dropdowns ────────────────────────────────────────────────────
  initMenubar();

  // ── 7. Scope knob labels ────────────────────────────────────────────────────
  initScopeKnobs();

  // ── 8. Keyboard shortcuts ───────────────────────────────────────────────────
  document.addEventListener('keydown', onKeyDown);

  // ── 9. Initial state ────────────────────────────────────────────────────────
  Storage.newLayout();
  setStatus('Drop a component to get started — press W to enter wiring mode');

})();

// ── Action dispatcher ─────────────────────────────────────────────────────────
// All buttons and menu items use data-action attributes routed here.

function handleAction(action) {
  switch (action) {
    case 'new':            newLayout();             break;
    case 'open':           openLayout();            break;
    case 'save':           saveLayout(false);       break;
    case 'save-as':        saveLayout(true);        break;
    case 'import-audio':   importAudio();           break;
    case 'undo':           /* TODO */               break;
    case 'redo':           /* TODO */               break;
    case 'delete':
      Board.deleteSelected();
      PropertiesPanel.hide();
      updateComponentCount();
      break;
    case 'clear':          confirmClear();          break;
    case 'sim-run':        runSim();                break;
    case 'sim-stop':       stopSim();               break;
    case 'sim-reset':
      Simulation.reset();
      setStatus('Board reset');
      break;
    case 'toggle-scope':     togglePanel('scope-panel',    'btn-toggle-scope');    break;
    case 'toggle-spectrum':  togglePanel('spectrum-panel', 'btn-toggle-spectrum'); break;
    case 'toggle-palette':   toggleSidebar('palette');                             break;
    case 'toggle-props':     toggleSidebar('props-panel');                         break;
    case 'wire-mode':        toggleWireMode();                                     break;
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
      // Close all
      menuItems.forEach(m => m.classList.remove('open'));
      if (!isOpen) item.classList.add('open');
    });

    // Hover to switch menus if one is already open
    item.addEventListener('mouseenter', () => {
      const anyOpen = document.querySelector('.menu-item.open');
      if (anyOpen && anyOpen !== item) {
        menuItems.forEach(m => m.classList.remove('open'));
        item.classList.add('open');
      }
    });
  });

  // Close on outside click
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
  if (result?.saved) {
    setStatus(`Saved: ${result.fileName}`);
  }
}

async function importAudio() {
  const fileData = await Storage.openAudioFile();
  if (!fileData) return;

  const name   = await AudioEngine.loadAudioFile(fileData);
  if (!name) { setStatus('Could not decode audio file'); return; }

  const placed = Board.getPlaced();
  const sigGen = placed.find(p => p.defId === 'signal_generator');
  if (sigGen) {
    sigGen.props.waveform   = 'Audio File';
    sigGen.props.audio_file = name;
    PropertiesPanel.show(Board.getSelected() || sigGen);
  }
  setStatus(`Audio loaded: ${name}`);
}

// ── Wiring mode ───────────────────────────────────────────────────────────────

function toggleWireMode() {
  const btn = document.getElementById('btn-wire-mode');
  if (Wire.isWiring()) {
    Wire.exit();
    btn.classList.remove('active');
    document.getElementById('status-wire-mode').textContent = '';
    setStatus('Wiring mode off');
  } else {
    Wire.enter();
    btn.classList.add('active');
    document.getElementById('status-wire-mode').textContent = '⬡ WIRING';
    setStatus('Wiring mode — click a hole to start, click another to connect');
  }
}

// ── Panel toggles ─────────────────────────────────────────────────────────────

function togglePanel(panelId, btnId) {
  const panel   = document.getElementById(panelId);
  const btn     = document.getElementById(btnId);
  const hidden  = panel.classList.toggle('hidden');
  btn?.classList.toggle('active', !hidden);
}

function toggleSidebar(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.style.display = el.style.display === 'none' ? '' : 'none';
}

// ── Scope knob labels ─────────────────────────────────────────────────────────

function initScopeKnobs() {
  const vdiv = document.getElementById('scope-vdiv');
  const tdiv = document.getElementById('scope-tdiv');
  const vval = document.getElementById('scope-vdiv-val');
  const tval = document.getElementById('scope-tdiv-val');

  if (vdiv && vval) {
    vdiv.addEventListener('input', () => {
      vval.textContent = parseFloat(vdiv.value).toFixed(1);
    });
  }
  if (tdiv && tval) {
    tdiv.addEventListener('input', () => {
      tval.textContent = parseFloat(tdiv.value).toFixed(1);
    });
  }
}

// ── Keyboard shortcuts ────────────────────────────────────────────────────────

function onKeyDown(e) {
  const target = e.target;
  const typing = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT';

  if (e.code === 'Space' && !typing) {
    e.preventDefault();
    Simulation.isRunning() ? stopSim() : runSim();
  }

  if (e.code === 'Escape') {
    if (Wire.isWiring()) {
      Wire.exit();
      document.getElementById('btn-wire-mode')?.classList.remove('active');
      document.getElementById('status-wire-mode').textContent = '';
      setStatus('Wiring cancelled');
    } else if (Simulation.isRunning()) {
      stopSim();
    }
    document.querySelectorAll('.menu-item').forEach(m => m.classList.remove('open'));
  }

  if ((e.code === 'Delete' || e.code === 'Backspace') && !typing) {
    Board.deleteSelected();
    PropertiesPanel.hide();
    updateComponentCount();
    Storage.markDirty();
  }

  if (e.code === 'KeyW' && !typing) {
    toggleWireMode();
  }

  if ((e.metaKey || e.ctrlKey) && !typing) {
    if (e.key === 'n') { e.preventDefault(); newLayout(); }
    if (e.key === 'o') { e.preventDefault(); openLayout(); }
    if (e.key === 's') {
      e.preventDefault();
      saveLayout(e.shiftKey);
    }
    if (e.key === 'd') { e.preventDefault(); togglePanel('scope-panel', 'btn-toggle-scope'); }
    if (e.key === 'D') { e.preventDefault(); togglePanel('spectrum-panel', 'btn-toggle-spectrum'); }
    if (e.key === 'f') {
      e.preventDefault();
      document.getElementById('palette-search')?.focus();
    }
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
    if (label) label.textContent = 'Running';
    if (runBtn)  runBtn.disabled  = true;
    if (stopBtn) stopBtn.disabled = false;
  } else {
    indicator?.classList.remove('running');
    if (label) label.textContent = 'Stopped';
    if (runBtn)  runBtn.disabled  = false;
    if (stopBtn) stopBtn.disabled = true;
  }
}

function setStatus(msg) {
  const el = document.getElementById('status-msg');
  if (el) el.textContent = msg;
}

function updateComponentCount() {
  const el = document.getElementById('status-component-count');
  if (!el) return;
  const count = Board.getPlaced().length;
  el.textContent = count ? `${count} component${count !== 1 ? 's' : ''}` : '';
}
