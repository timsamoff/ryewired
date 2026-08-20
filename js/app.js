// ── Ryewired App Bootstrap ────────────────────────────────────────────────────

const APP_VERSION = '0.1.0';

let _zoomLevel = 1.0;
const ZOOM_MIN  = 0.1;
const ZOOM_MAX  = 2.0;
const ZOOM_STEP = 0.1;

let _panning=false, _panStartX=0, _panStartY=0, _panScrollX=0, _panScrollY=0;
let _statusGen = 0;

(async function initApp() {

  let savedLang;
  try { savedLang = localStorage.getItem('ryewired_lang') || undefined; }
  catch (e) { savedLang = undefined; } // private browsing / storage disabled — fall back to the default language rather than fail boot
  await I18n.load(savedLang);
  I18n.applyStaticMarkup();
  await ComponentRegistry.load();

  Board.init(document.getElementById('board-canvas'));
  WorkbenchStrip.init(document.getElementById('workbench-strip-canvas'));
  TraceOverlay.init(document.getElementById('trace-overlay-canvas'));
  Palette.init();
  Palette.populate(ComponentRegistry.getAll());
  PropertiesPanel.init();
  Modal.init();
  // Toolbar buttons carry data-hint (converted from native title= so every
  // tooltip in the app goes through the one Tooltip mechanism) — one
  // delegated binding covers all of them, same pattern as PropertiesPanel.
  if (typeof Tooltip !== 'undefined') Tooltip.wireHintDelegate(document.getElementById('toolbar'), '[data-hint]');
  Oscilloscope.init(
    document.getElementById('scope-canvas'),
    document.getElementById('spectrum-canvas')
  );
  updateSelectButton();

  // Board callbacks
  Board.onSelect((inst, wire) => {
    PropertiesPanel.show(inst, wire);
    document.body.classList.toggle('comp-selected', !!inst);
  });

  // Permanent workbench device clicks (Power Supply / Input / Output)
  WorkbenchStrip.onSelectPermanent(kind => {
    PropertiesPanel.showPermanent(kind);
    document.body.classList.add('comp-selected');
  });

  Board.onPlace(inst => {
    Storage.markDirty();
    const def = ComponentRegistry.getById(inst.defId);
    const label = (def?.labelKey ? I18n.t(def.labelKey) : null) || inst.defId;
    setStatus(I18n.t('app.status.placed', { label }));
    updateComponentCount();
    // History already pushed by board.js onDrop
  });

  // Simulation callbacks
  Simulation.onFailure(({ icon, title, message }) => {
    AudioEngine.stop(); Oscilloscope.stop(); setSimState('stopped');
    document.getElementById('failure-icon').textContent    = icon;
    document.getElementById('failure-title').textContent   = title;
    document.getElementById('failure-message').textContent = message;
    document.getElementById('failure-overlay').classList.remove('hidden');
  });
  // Dynamic re-linearization: every tick recomputes the DC operating point
  // (battery sag, etc.) — this is what actually pushes those fresh values
  // onto the live audio graph. Without this, sag/leakage/anything else that
  // moves Ic while playing would update the model but never be audible
  // until a fresh Stop/Play.
  Simulation.onUpdate(() => { if (typeof AudioEngine !== 'undefined' && AudioEngine.updateLiveGains) AudioEngine.updateLiveGains(); });
  // Topology (not value) changes: a switch toggling while engaged actually
  // rewires the net graph, which the per-tick value push above can't express —
  // it only updates existing nodes. Without this, flipping a switch mid-play
  // updates the DC solve and the visuals but the sound keeps whatever
  // topology existed when Play was pressed, until a fresh Stop/Play.
  Simulation.onTopologyChange(() => { if (typeof AudioEngine !== 'undefined' && AudioEngine.refreshTopology) AudioEngine.refreshTopology(); });

  document.getElementById('failure-dismiss').addEventListener('click', () => {
    document.getElementById('failure-overlay').classList.add('hidden');
    Simulation.reset();
    setStatus(I18n.t('app.status.failuresCleared'));
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
  document.addEventListener('click', scheduleStatusClear, true);
  document.addEventListener('keydown', scheduleStatusClear, true);

  // History — init AFTER board is ready
  History.init();

  // Restore autosave if no file is being opened fresh
  AutoSave.restore();

  setTimeout(fitBoard, 100);
  window.addEventListener('resize', Utils.debounce(fitBoard, 200));

  Storage.newLayout();
  setStatus(I18n.t('app.status.dropToStart'));

})();

// ── Action dispatcher ─────────────────────────────────────────────────────────

function handleAction(action) {
  switch (action) {
    case 'new':      newLayout();           break;
    case 'open':     openLayout();          break;
    case 'load-sample-circuit': loadSampleCircuit(); break;
    case 'save':     saveLayout(false);     break;
    case 'save-as':  saveLayout(true);      break;
    case 'undo':     History.undo();        break;
    case 'redo':     History.redo();        break;
    case 'delete':
      Board.deleteSelected();
      PropertiesPanel.hide();
      updateComponentCount();
      Storage.markDirty();
      document.body.classList.remove('comp-selected');
      History.push();
      break;
    case 'clear':           confirmClear();    break;
    case 'copy':            copySelected();    break;
    case 'paste':           pasteFromClipboard(); break;
    case 'sim-run':         runSim();          break;
    case 'sim-stop':        stopSim();         break;
    case 'sim-reset':
      Simulation.reset();
      setStatus(I18n.t('app.status.failuresClearedUnchanged'));
      break;
    case 'toggle-scope':    togglePanel('scope-panel',    'btn-toggle-scope');    break;
    case 'toggle-spectrum': togglePanel('spectrum-panel', 'btn-toggle-spectrum'); break;
    case 'toggle-palette':  toggleSidebar('palette');                             break;
    case 'toggle-props':    toggleSidebar('props-panel');                         break;
    case 'wire-mode':       setTool('jumper');                                   break;
    case 'tool-select':     setTool('select');                                   break;
    case 'tool-voltmeter':  setTool('voltmeter');                                break;
    case 'tool-probe':      setTool('probe');                                    break;
    case 'zoom-in':         zoomIn();          break;
    case 'zoom-out':        zoomOut();         break;
    case 'zoom-fit':        fitBoard();        break;
    case 'change-language': changeLanguage();  break;
    case 'help':            openHelp();        break;
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
  const items = document.querySelectorAll('.menu-item');
  items.forEach(item => {
    item.querySelector('span').addEventListener('click', e => {
      e.stopPropagation();
      const isOpen = item.classList.contains('open');
      items.forEach(m => m.classList.remove('open'));
      if (!isOpen) item.classList.add('open');
    });
    item.addEventListener('mouseenter', () => {
      const any = document.querySelector('.menu-item.open');
      if (any && any !== item) { items.forEach(m=>m.classList.remove('open')); item.classList.add('open'); }
    });
  });
  document.addEventListener('click', () => items.forEach(m=>m.classList.remove('open')));
}

// ── Simulation ────────────────────────────────────────────────────────────────

function runSim() {
  if (Simulation.isRunning()) return;
  // No "board must have components" guard here on purpose: the workbench's
  // permanent Input/Output form a clean passthrough (AudioEngine.start()
  // handles bypass-off/no-circuit on its own), so Run must always be able
  // to start — an empty board is a valid, fully-functional state.
  Simulation.start();
  Simulation.tick(); // force one synchronous DC solve NOW — start() only schedules future ticks (setInterval), so without this, anything AudioEngine reads that depends on a completed solve (e.g. a transistor's inst._current, driving its gain) would still hold a stale/zero value from before this Play press, for the entire session, since the audio graph is only built once here
  // That forced tick can itself trigger a failure (fail() calls
  // Simulation.stop() + the onFailure handler's AudioEngine.stop()/
  // setSimState('stopped') — but AudioEngine hasn't started yet at that
  // point, so its stop() is a no-op). Without this check, the code below
  // would start AudioEngine anyway and setSimState('running') would
  // overwrite the correct 'stopped' state — leaving a genuinely playing,
  // orphaned audio graph that nothing can ever reach again, since
  // Simulation already (correctly) reports not running and every Stop/
  // Reset path is guarded on that.
  if (!Simulation.isRunning()) return;
  AudioEngine.start(); Oscilloscope.start();
  setSimState('running'); setStatus(I18n.t('app.status.simRunning'));
}

function stopSim() {
  if (!Simulation.isRunning()) return;
  Simulation.stop(); AudioEngine.stop(); Oscilloscope.stop();
  setSimState('stopped'); setStatus(I18n.t('app.status.simStopped'));
  if (_currentTool !== 'select') exitToolToSelect();
}

// ── Layout I/O ────────────────────────────────────────────────────────────────

async function newLayout() {
  if (Simulation.isRunning()) stopSim();
  if (Board.getPlaced().length>0 || Board.getWires().length>0) {
    const ok = await Modal.confirm(I18n.t('app.confirm.newLayout.message'), {title:I18n.t('app.confirm.newLayout.title'), okLabel:I18n.t('app.confirm.newLayout.okLabel'), danger:true});
    if (!ok) return;
  }
  Board.clear(); PropertiesPanel.hide(); Storage.newLayout();
  if (typeof WorkbenchStrip!=='undefined' && WorkbenchStrip.resetInput) WorkbenchStrip.resetInput();
  if (typeof WorkbenchStrip!=='undefined' && WorkbenchStrip.resetOutput) WorkbenchStrip.resetOutput();
  History.clear(); History.init(); AutoSave.clear();
  updateComponentCount(); setStatus(I18n.t('app.status.newLayout'));
}

async function openLayout() {
  if (Simulation.isRunning()) stopSim();
  const layout = await Storage.openLayout();
  if (!layout) return;
  Board.loadLayout(layout); PropertiesPanel.hide();
  History.clear(); History.init(); AutoSave.clear();
  updateComponentCount(); setStatus(I18n.t('app.status.loaded', { count: layout.components?.length||0 }));
}

// Reloads the page after switching, rather than trying to re-render live.
// The i18n conversion is in progress (see CLAUDE.md) — large parts of the
// app still read hardcoded English strings directly rather than through
// I18n.t(), so a live re-render right now would leave the UI in a
// confusing half-translated state. A reload guarantees everything that HAS
// been converted picks up the new language correctly, and is a completely
// safe/correct behavior regardless of how much of the conversion is done
// at any given point — this call site doesn't need to change again as more
// of the app gets converted.
async function changeLanguage() {
  const languages = await I18n.listLanguages();
  const current = I18n.currentLanguage();
  const picked = await Modal.pickList(
    languages.map(l => ({ label: l.code === current ? `${l.label} ✓` : l.label, value: l.code })),
    { title: I18n.t('app.modal.language') }
  );
  if (!picked || picked === current) return;

  try { localStorage.setItem('ryewired_lang', picked); }
  catch (e) { /* private browsing / storage disabled — language just won't persist across reloads */ }

  location.reload();
}

async function loadSampleCircuit() {
  const circuits = await Storage.listCircuits();
  const picked = await Modal.pickList(
    circuits.map(c => ({ label: c.name, value: c })),
    { title: I18n.t('app.modal.loadSampleCircuit'), emptyLabel: I18n.t('app.modal.noSampleCircuits') }
  );
  if (!picked) return;

  if (Board.getPlaced().length>0 || Board.getWires().length>0) {
    const ok = await Modal.confirm(I18n.t('app.confirm.loadSample.message', { name: picked.name }), {title:I18n.t('app.modal.loadSampleCircuit'), okLabel:I18n.t('app.confirm.loadSample.okLabel'), danger:true});
    if (!ok) return;
  }
  if (Simulation.isRunning()) stopSim();

  setStatus(I18n.t('app.status.loading', { name: picked.name }));
  const layout = await Storage.loadBundledCircuit(picked.file, picked.name);
  if (!layout) { setStatus(I18n.t('app.status.loadFailed', { name: picked.name })); return; }
  Board.loadLayout(layout); PropertiesPanel.hide();
  History.clear(); History.init(); AutoSave.clear();
  updateComponentCount(); setStatus(I18n.t('app.status.loadedNamed', { name: picked.name, count: layout.components?.length||0 }));
}

async function saveLayout(forceDialog=false) {
  const data=Board.getLayoutData(), result=await Storage.saveLayout(data,forceDialog);
  if (result?.saved) setStatus(I18n.t('app.status.saved', { fileName: result.fileName }));
}

// ── Tools ─────────────────────────────────────────────────────────────────────
// Single active tool at a time, per the workbench doc. 'select' is the
// implicit default (no dedicated button, same as before) — Jumper,
// Voltmeter, and Probe are mutually exclusive modes sharing one dispatch
// point, so a future tool only ever needs an entry here instead of another
// one-off boolean+enter/exit pair.

let _currentTool = 'select';

const TOOL_CONFIG = {
  jumper:    { btnId:'btn-wire-mode',      bodyClass:'wire-mode',      label:'⬡ JUMPER',      onMsgKey:'app.tool.jumper.on',    offMsgKey:'app.tool.jumper.off' },
  voltmeter: { btnId:'btn-tool-voltmeter', bodyClass:'voltmeter-mode', label:'⬡ VOLTMETER',   onMsgKey:'app.tool.voltmeter.on', offMsgKey:'app.tool.voltmeter.off' },
  probe:     { btnId:'btn-tool-probe',     bodyClass:'probe-mode',     label:'⬡ AUDIO PROBE', onMsgKey:'app.tool.probe.on',     offMsgKey:'app.tool.probe.off' },
};

function setTool(tool) {
  if (tool === 'select') { exitToolToSelect(); return; }
  if (_currentTool === tool) { exitToolToSelect(); return; } // re-clicking the active tool returns to Selection
  if (_currentTool !== 'select') deactivateTool(_currentTool);
  _currentTool = tool;
  activateTool(tool);
  updateSelectButton();
}

// Whether the circuit is physically "patched in" right now — i.e. the
// bypass switch is in the engaged (LED-lit) position. This is the single
// lock condition for anything that represents physically swapping/
// rewiring a part — you can't do that on a real breadboard while it's
// engaged either. Pot wiper turns and momentary-footswitch presses are
// real-time on a real pedal too, so they're deliberately NOT gated by
// this.
//
// DELIBERATELY NOT GATED ON Simulation.isRunning(): the switch's position
// is what matters, not the transport. Stopping playback doesn't un-flip
// a real footswitch, so leaving the LED lit keeps editing locked even
// with Play stopped — flip the switch if you want to edit. This also
// keeps the lock decoupled from playback state, which matters once
// dynamic re-linearization (block-rate re-solving while playing) lands —
// "engaged" shouldn't need to be redefined when "playing" stops being a
// single simple state.
//
// NOTE ON POLARITY: despite its name, WorkbenchStrip.isBypassOn() returns
// TRUE when the effect is engaged (processing) and FALSE when bypassed —
// confirmed against audio-engine.js's own routing (it uses the processed
// circuit's tail when isBypassOn() is true, and falls back to the raw dry
// source when false). An earlier version of this function trusted the name
// at face value and inverted this, which unlocked editing exactly when the
// pedal was engaged and locked it exactly when bypassed — backwards. Do not
// add a "!" here without re-checking that routing code first.
function isCircuitEngaged() {
  return typeof WorkbenchStrip !== 'undefined' && WorkbenchStrip.isBypassOn && WorkbenchStrip.isBypassOn();
}

function activateTool(tool) {
  const cfg = TOOL_CONFIG[tool];
  if (tool === 'jumper') Wire.enter();
  if (tool === 'probe' && typeof AudioEngine !== 'undefined') AudioEngine.probeEnable();
  document.body.classList.add(cfg.bodyClass);
  document.getElementById(cfg.btnId)?.classList.add('active');
  document.getElementById('status-wire-mode').textContent = cfg.label;
  setStatus(I18n.t(cfg.onMsgKey));
}

function deactivateTool(tool) {
  const cfg = TOOL_CONFIG[tool];
  if (tool === 'jumper') Wire.exit();
  if (tool === 'probe' && typeof AudioEngine !== 'undefined') AudioEngine.probeDisable();
  document.body.classList.remove(cfg.bodyClass);
  document.getElementById(cfg.btnId)?.classList.remove('active');
}

function exitToolToSelect() {
  if (_currentTool === 'select') { updateSelectButton(); return; }
  const cfg = TOOL_CONFIG[_currentTool];
  deactivateTool(_currentTool);
  _currentTool = 'select';
  document.getElementById('status-wire-mode').textContent = '';
  setStatus(I18n.t(cfg.offMsgKey));
  updateSelectButton();
}

function updateSelectButton() {
  document.getElementById('btn-tool-select')?.classList.toggle('active', _currentTool==='select');
}

function currentTool()  { return _currentTool; }
function isMeasuring()  { return _currentTool === 'voltmeter' || _currentTool === 'probe'; }

// ── Copy / Paste ─────────────────────────────────────────────────────────────
// Clipboard holds defId + a snapshot of props only — legs/position are
// re-derived at paste time from wherever the user clicks (same as a fresh
// placement), and runtime sim state (_voltage/_current/failed/etc.) is
// deliberately left out, same reasoning as the doc's duplication spec: a
// paste should start clean, not carry over what the original happened to
// be doing mid-simulation.
let _clipboard = null;

function copySelected() {
  const inst = Board.getSelected();
  if (inst) {
    _clipboard = { kind:'component', defId: inst.defId, props: {...inst.props} };
    const def = ComponentRegistry.getById(inst.defId);
    const label = (def?.labelKey ? I18n.t(def.labelKey) : null) || inst.defId;
    setStatus(I18n.t('app.status.copied', { label }));
    return;
  }
  const wire = Board.getSelectedWireObj ? Board.getSelectedWireObj() : null;
  if (wire) {
    _clipboard = { kind:'wire', r1:wire.r1, c1:wire.c1, r2:wire.r2, c2:wire.c2, color:wire.color };
    setStatus(I18n.t('app.status.copiedWire'));
    return;
  }
  setStatus(I18n.t('app.status.nothingToCopy'));
}

function pasteFromClipboard() {
  if (!_clipboard) { setStatus(I18n.t('app.status.nothingToPaste')); return; }
  if (_currentTool !== 'select') exitToolToSelect(); // pasting wants normal board interaction, same as picking from the palette
  if (_clipboard.kind === 'wire') {
    Board.beginPasteWire(_clipboard);
    setStatus(I18n.t('app.status.clickToPlaceWire'));
    return;
  }
  Board.beginPaste(_clipboard.defId, _clipboard.props);
  setStatus(I18n.t('app.status.clickToPlace'));
}

// ── Zoom ──────────────────────────────────────────────────────────────────────

// Fits immediately rather than painting at 100% first — an unscaled first
// paint reliably overflows #board-scroll and forces a scrollbar to appear,
// which then silently shrinks clientWidth/clientHeight for whatever measures
// them next. The deferred setTimeout(fitBoard,100) in initApp() re-fits
// after other layout (fonts, sidebar) has settled, but if that first fit
// already measured a scrollbar-narrowed container, its result permanently
// disagreed with a later manual "Fit to Window" click (which always measures
// a scrollbar-free container, since the board is already fitted by then) —
// found as a real, reproducible 65% vs 66% mismatch between page-load and
// the Fit to Window button on the same window size.
function initZoom()  { fitBoard(); }
function zoomIn()    { applyZoom(Math.min(ZOOM_MAX, snapZoom(_zoomLevel + ZOOM_STEP))); }
function zoomOut()   { applyZoom(Math.max(ZOOM_MIN, snapZoom(_zoomLevel - ZOOM_STEP))); }
function snapZoom(v) { return Math.round(v / ZOOM_STEP) * ZOOM_STEP; }

// Real UNSCALED board size (CSS/logical pixels, not canvas.width which is
// DPR-inflated) — the board canvas's own width/height plus the workbench
// strip's height stacked above it, since #board-transform wraps both
// canvases as one block. Shared by fitBoard (what needs to shrink to fit)
// and applyZoom (what #board-zoom-box needs to be explicitly sized to at
// the chosen zoom level — see that function's own comment for why).
function boardUnscaledSize() {
  const canvas = document.getElementById('board-canvas');
  if (!canvas) return null;
  const bW = parseFloat(canvas.style.width)  || canvas.clientWidth;
  const stripH = (typeof WorkbenchStrip !== 'undefined' && WorkbenchStrip.getVisualHeight) ? WorkbenchStrip.getVisualHeight() : 0;
  const bH = (parseFloat(canvas.style.height) || canvas.clientHeight) + stripH;
  if (!bW || !bH) return null;
  return { bW, bH };
}

function fitBoard() {
  const scroll = document.getElementById('board-scroll');
  if (!scroll) return;
  const size = boardUnscaledSize();
  if (!size) return;
  const aW = scroll.clientWidth  - 56;
  const aH = scroll.clientHeight - 56;
  // With BOTH side panels open, fit by min(width,height) as before — the
  // whole board (including the External Switches panel below it) stays
  // visible with no scrolling, even if that means a smaller zoom%. With
  // either panel closed, the user explicitly wants the freed-up space to
  // grow the board's WIDTH rather than being capped by whatever the height
  // ratio allows — on a short/wide screen (e.g. a 1536x864 effective
  // viewport from a 250%-scaled 4K display), height is very often the
  // tighter constraint, and closing a panel to free horizontal space was
  // producing NO visible zoom change at all, which read as "the fix doesn't
  // work" — it wasn't broken, height was just still binding. Fitting to
  // width alone once a panel is closed accepts a vertical scrollbar as the
  // tradeoff, which is exactly what was asked for.
  const palette = document.getElementById('palette');
  const props   = document.getElementById('props-panel');
  const bothPanelsOpen = palette && props
    && palette.style.display  !== 'none'
    && props.style.display    !== 'none';
  const raw = bothPanelsOpen
    ? Math.min(aW / size.bW, aH / size.bH, 1.0)
    : Math.min(aW / size.bW, 1.0);
  // Round DOWN, not to nearest (snapZoom's usual Math.round) — this is
  // specifically "fit," where the result must never exceed the space
  // actually available. Rounding to nearest could snap UP past the true
  // fit ratio (e.g. a true fit of 0.267 rounds to 0.3, which is too large),
  // reintroducing exactly the scrollbar this function exists to avoid —
  // found by a real narrow-viewport test that still showed a horizontal
  // scrollbar immediately after auto-fit, with no zooming-in involved.
  //
  // Floors to a 1% grid (FIT_STEP), not the 10% ZOOM_STEP the manual zoom
  // buttons use — flooring a real fit ratio like 0.6156 to the coarse 10%
  // grid gives 0.6 and visibly wastes usable space (confirmed: a real
  // 1400x900 window's true fit was 61.56%, and the old 10%-floor showed
  // 60% when 61% was still comfortably available).
  const FIT_STEP = 0.01;
  const floored = Math.floor(raw / FIT_STEP) * FIT_STEP;
  applyZoom(Math.max(ZOOM_MIN, floored), FIT_STEP);
}

// `granularity` defaults to ZOOM_STEP (10%) for the manual zoom in/out
// buttons — clean, predictable steps. fitBoard() passes a finer 1% step
// instead, since snapping a fit ratio to 10% can waste up to ~10% of the
// space that was actually available (a real fit of 61.56% would floor to
// 60% on the coarse grid) — see fitBoard's own comment for the numbers
// that surfaced this.
function applyZoom(level, granularity) {
  const step = granularity || ZOOM_STEP;
  _zoomLevel = Math.round(Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, level)) / step) * step;
  _zoomLevel = Math.round(_zoomLevel * 100) / 100; // clean up float drift (e.g. 0.6099999999999999)
  const t=document.getElementById('board-transform');
  if (t) t.style.transform=`scale(${_zoomLevel})`;
  // #board-zoom-box is sized to the SCALED footprint explicitly (not left
  // to inherit #board-transform's unscaled size) — see the CSS comment on
  // #board-zoom-box for why this is what actually fixes scrollbars showing
  // when the zoomed-out board visibly fits: a CSS transform never shrinks
  // what a scrolling ancestor measures for overflow, only this element's
  // own explicit width/height does.
  const box = document.getElementById('board-zoom-box');
  const size = boardUnscaledSize();
  if (box && size) {
    box.style.width  = (size.bW * _zoomLevel) + 'px';
    box.style.height = (size.bH * _zoomLevel) + 'px';
  }
  const el=document.getElementById('zoom-level');
  if (el) el.textContent=Math.round(_zoomLevel*100)+'%';
  Board.setZoom(_zoomLevel);
}

// ── Pan ───────────────────────────────────────────────────────────────────────

function initPan() {
  const scroll=document.getElementById('board-scroll');
  if (!scroll) return;

  scroll.addEventListener('mousedown', e => {
    if (e.button!==2) return;
    e.preventDefault();
    _panning=true; _panStartX=e.clientX; _panStartY=e.clientY;
    _panScrollX=scroll.scrollLeft; _panScrollY=scroll.scrollTop;
    scroll.style.cursor='grabbing';
  });

  window.addEventListener('mousemove', e => {
    if (!_panning) return;
    scroll.scrollLeft=_panScrollX-(e.clientX-_panStartX);
    scroll.scrollTop =_panScrollY-(e.clientY-_panStartY);
  });

  window.addEventListener('mouseup', e => {
    if (e.button!==2||!_panning) return;
    _panning=false; scroll.style.cursor='';
  });

  scroll.addEventListener('wheel', e => {
    e.preventDefault();
    const rect=scroll.getBoundingClientRect();
    const mX=e.clientX-rect.left, mY=e.clientY-rect.top;
    const oldZ=_zoomLevel;
    if (e.deltaY<0) zoomIn(); else zoomOut();
    const newZ=_zoomLevel;
    if (newZ===oldZ) return;
    scroll.scrollLeft=(scroll.scrollLeft+mX)*(newZ/oldZ)-mX;
    scroll.scrollTop =(scroll.scrollTop +mY)*(newZ/oldZ)-mY;
  }, { passive:false });
}

// ── Panel toggles ─────────────────────────────────────────────────────────────

function togglePanel(panelId, btnId) {
  const p=document.getElementById(panelId), b=document.getElementById(btnId);
  p.classList.toggle('hidden'); b?.classList.toggle('active', !p.classList.contains('hidden'));
}

function toggleSidebar(id) {
  const el=document.getElementById(id);
  if (!el) return;
  el.style.display=el.style.display==='none'?'':'none';
  // Collapsing/restoring a sidebar changes how much width #board-scroll
  // actually has, same as a window resize — refit so the board grows back
  // up to fill the newly available space instead of staying at whatever
  // zoom% fit the OLD (narrower) layout. A single requestAnimationFrame
  // here previously worked in automated (Playwright/Chromium) testing but
  // was reported as unreliable in real-world use on at least one real
  // machine/browser — the board resize logic only kicked in once something
  // else (e.g. opening devtools, which itself triggers window's 'resize'
  // event) forced a reflow through a different path. requestAnimationFrame
  // only guarantees "before the next paint," not that a full layout pass
  // has actually run — so on some browsers/GPU-compositing paths a single
  // rAF can still read stale clientWidth/clientHeight. Matching the
  // window-resize handler's own timing model (a real setTimeout delay, not
  // a single animation frame) is what that path already relies on and is
  // proven reliable — so this uses the same approach instead of trusting rAF.
  setTimeout(fitBoard, 50);
}

// ── Help ──────────────────────────────────────────────────────────────────────

function openHelp()  { document.getElementById('help-overlay').classList.remove('hidden'); }
function closeHelp() { document.getElementById('help-overlay').classList.add('hidden'); }

// ── Scope knobs ───────────────────────────────────────────────────────────────

function initScopeKnobs() {
  [['scope-vdiv','scope-vdiv-val'],['scope-tdiv','scope-tdiv-val']].forEach(([rid,vid])=>{
    const r=document.getElementById(rid), v=document.getElementById(vid);
    if (r&&v) r.addEventListener('input',()=>{ v.textContent=parseFloat(r.value).toFixed(1); });
  });
}

// ── Keyboard shortcuts ────────────────────────────────────────────────────────

function onKeyDown(e) {
  const typing=['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName);

  if (e.code==='Escape') {
    if (Modal.handleEscape()) return;
    if (!document.getElementById('help-overlay').classList.contains('hidden')) { closeHelp(); return; }
    if (document.querySelector('.menu-item.open')) {
      document.querySelectorAll('.menu-item').forEach(m=>m.classList.remove('open')); return;
    }
    if (Board.cancelActivePaste && Board.cancelActivePaste()) { setStatus(I18n.t('app.status.pasteCancelled')); return; }
    if (_currentTool !== 'select') { exitToolToSelect(); return; }
    if (Wire.hasStart()) { Wire.cancelCurrent(); return; }
    if (Simulation.isRunning()) { stopSim(); return; }
  }

  if (typing) return;

  if (e.code==='Space') { e.preventDefault(); Simulation.isRunning()?stopSim():runSim(); }
  if (e.code==='KeyJ')  { setTool('jumper'); }
  if (e.code==='KeyV')  { setTool('select'); }
  if (e.code==='KeyM')  { setTool('voltmeter'); }
  if (e.code==='KeyP')  { setTool('probe'); }
  if (e.code==='Delete'||e.code==='Backspace') {
    Board.deleteSelected(); PropertiesPanel.hide();
    updateComponentCount(); Storage.markDirty();
    document.body.classList.remove('comp-selected');
    History.push();
  }
  if (e.key==='+'||e.key==='=') zoomIn();
  if (e.key==='-'||e.key==='_') zoomOut();

  if (e.ctrlKey||e.metaKey) {
    if (e.key==='z'&&!e.shiftKey) { e.preventDefault(); History.undo(); }
    if (e.code==='KeyZ'&&e.shiftKey)  { e.preventDefault(); History.redo(); }
    if (e.key==='y')               { e.preventDefault(); History.redo(); }
    if (e.key==='n') { e.preventDefault(); newLayout(); }
    if (e.key==='o') { e.preventDefault(); openLayout(); }
    if (e.key==='s') { e.preventDefault(); saveLayout(e.shiftKey); }
    if (e.key==='0') { e.preventDefault(); fitBoard(); }
    if (e.key==='d') { e.preventDefault(); togglePanel('scope-panel','btn-toggle-scope'); }
    if (e.key==='D') { e.preventDefault(); togglePanel('spectrum-panel','btn-toggle-spectrum'); }
    if (e.key==='f') { e.preventDefault(); document.getElementById('palette-search')?.focus(); }
    if (e.key==='c') { e.preventDefault(); copySelected(); }
    if (e.key==='v') { e.preventDefault(); pasteFromClipboard(); }
  }
}

// ── Utility ───────────────────────────────────────────────────────────────────

async function confirmClear() {
  if (Board.getPlaced().length===0 && Board.getWires().length===0) return;
  const ok = await Modal.confirm(I18n.t('app.confirm.clearBoard.message'), {title:I18n.t('app.confirm.clearBoard.title'), okLabel:I18n.t('app.confirm.clearBoard.okLabel'), danger:true});
  if (ok) {
    if (Simulation.isRunning()) stopSim();
    Board.clear(); PropertiesPanel.hide(); updateComponentCount();
    if (typeof WorkbenchStrip!=='undefined' && WorkbenchStrip.resetInput) WorkbenchStrip.resetInput();
    if (typeof WorkbenchStrip!=='undefined' && WorkbenchStrip.resetOutput) WorkbenchStrip.resetOutput();
    History.clear(); History.init(); AutoSave.clear();
    setStatus(I18n.t('app.status.boardCleared'));
  }
}

function setSimState(state) {
  const ind=document.getElementById('sim-indicator');
  const lbl=document.getElementById('sim-indicator-label');
  const run=document.getElementById('btn-run');
  const stp=document.getElementById('btn-stop');
  if (state==='running') {
    ind?.classList.add('running'); if(lbl)lbl.textContent=I18n.t('app.sim.running');
    if(run)run.disabled=true; if(stp)stp.disabled=false;
  } else {
    ind?.classList.remove('running'); if(lbl)lbl.textContent=I18n.t('app.sim.stopped');
    if(run)run.disabled=false; if(stp)stp.disabled=true;
  }
  PropertiesPanel.refresh();
}

function setStatus(msg) {
  _statusGen++;
  const el=document.getElementById('status-msg'); if(el) el.textContent=msg;
}

// Status messages are one-off notices ("Copied", "Board cleared", "Wire
// started at f12 — click another hole to finish", etc.) describing what
// JUST happened or the current mode. Once the user does something else,
// the old message stops making sense and should clear rather than linger.
// Capturing every click/keydown and checking on the next animation frame
// means: if that same interaction already called setStatus() with a fresh
// message (bumping _statusGen synchronously, before this check runs), we
// leave it alone; otherwise the stale message clears.
function scheduleStatusClear() {
  const gen = _statusGen;
  requestAnimationFrame(() => { if (_statusGen === gen) setStatus(''); });
}

function updateComponentCount() {
  const el = document.getElementById('status-component-count');
  if (!el) return;
  const n = Board.getPlaced().length;
  el.textContent = n ? I18n.t(n !== 1 ? 'app.status.componentCountPlural' : 'app.status.componentCount', { count: n }) : '';
}