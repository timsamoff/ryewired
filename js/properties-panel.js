// ── Properties Panel ──────────────────────────────────────────────────────────

const PropertiesPanel = (() => {
  let _content;
  let _currentInst = null;
  let _currentWire = null;
  let _currentPermanentKind = null; // 'power' | 'input' | 'output' | null

  // Property schemas for the permanent workbench devices (Phase 1 of the
  // "Future Workbench Architecture" doc). These mirror the same `properties`
  // array shape used by component JSON files, specifically so buildPropField()
  // below can render them with zero special-casing. State itself lives in
  // WorkbenchStrip, not here — this table is just "what fields to show."
  // Anything the doc marks "(future)" (max current/current limiting, battery
  // health, Output Device, Record Audio, Live Audio Input) is intentionally
  // left out for now.
  const PERMANENT_DEFS = {
    power: {
      label: 'Power Supply', symbol: '9V',
      properties: [
        { key:'voltage', label:'Voltage (V)', type:'number', default:9, min:1, max:24 },
        { key:'current_limit_ma', label:'Current Limit (mA)', type:'number', default:500 },
        { key:'reverse_polarity', label:'Reverse Polarity', type:'boolean', default:false },
        { key:'power_on', label:'Power On', type:'boolean', default:true },
        { key:'battery_sag', label:'Battery Sag', type:'range', min:0, max:1, step:0.01, default:0 },
        { key:'internal_resistance', label:'Internal Resistance (Ω)', type:'number', default:1, min:0 },
      ]
    },
    input: {
      label: 'Input', symbol: 'IN',
      properties: [
        { key:'waveform', label:'Audio Source', type:'select', default:'None',
          options:['None','Sine','Square','Triangle','Sawtooth','White Noise','Pink Noise','Audio File'] },
        { key:'frequency', label:'Frequency (Hz)', type:'number', default:440, min:1, max:20000 },
        { key:'amplitude', label:'Amplitude (V)', type:'number', default:1.0, min:0.01, max:12 },
        { key:'dc_offset', label:'DC Offset (V)', type:'number', default:0, min:-12, max:12 },
        { key:'phase', label:'Phase (°)', type:'number', default:0, min:0, max:360 },
        { key:'looping', label:'Loop Audio File', type:'boolean', default:true },
        { key:'audio_file', label:'Audio File', type:'permanent_audio_source', default:null },
      ]
    },
    output: {
      label: 'Output', symbol: 'OUT',
      properties: [
        { key:'volume', label:'Master Volume', type:'range', min:0, max:1, step:0.01, default:1.0 },
        { key:'mute', label:'Mute', type:'boolean', default:false },
      ]
    }
  };

  function init() {
    _content = document.getElementById('props-content');
    if (typeof AudioEngine !== 'undefined' && AudioEngine.listSamples) {
      AudioEngine.listSamples().then(() => {
        if (_currentPermanentKind === 'input') showPermanent('input'); // refresh only if still on the Input panel
      });
    }
  }

  function show(inst, wire) {
    _currentInst = inst;
    _currentWire = wire;
    _currentPermanentKind = null;
    if (wire && !inst) { showWire(wire); return; }
    if (!inst)         { hide();         return; }
    showComponent(inst);
  }

  // ── Permanent workbench devices (Power Supply, Input, Output) ────────────────
  function showPermanent(kind) {
    const def = PERMANENT_DEFS[kind];
    if (!def || typeof WorkbenchStrip === 'undefined') return;
    _currentInst = null; _currentWire = null;
    _currentPermanentKind = kind;

    const state = WorkbenchStrip.getPermanentState()[kind];

    let html = `
      <div class="prop-component-header">
        <div class="prop-component-symbol">${def.symbol}</div>
        <div class="prop-component-info">
          <div class="prop-component-label">${def.label}</div>
          <div class="prop-component-id">Permanent Workbench Device</div>
        </div>
      </div>`;

    for (const prop of def.properties) {
      html += buildPropField(prop, state[prop.key], undefined, undefined);
    }
    // No Rotate section (nothing to rotate) and no Remove button — permanent
    // devices are fixed, non-draggable parts of the workbench, per the doc.

    // Input's properties don't take effect live (unlike Output's volume/mute,
    // which do), and Power Supply represents the physical battery/voltage —
    // neither is a "turn the knob" action, so both lock while the circuit is
    // actually engaged (running and not bypassed), same condition as regular
    // components.
    const isLocked = (kind === 'input' || kind === 'power') &&
      typeof isCircuitEngaged === 'function' && isCircuitEngaged();
    if (isLocked) {
      const msg = kind === 'input' ? 'Stop the simulation or bypass the pedal to change Input settings'
                                    : 'Stop the simulation or bypass the pedal to change Power settings';
      html = `<div class="prop-locked-note"><i class="fa-solid fa-lock"></i> ${msg}</div>` + html;
    }

    _content.innerHTML = html;

    if (isLocked) {
      _content.querySelectorAll('input, select, button').forEach(el => { el.disabled = true; });
    }

    _content.querySelectorAll('.prop-input, input[type="range"]').forEach(el => {
      el.addEventListener('input',  onPermanentPropChange);
      el.addEventListener('change', onPermanentPropChange);
    });

    const loadSampleBtn = _content.querySelector('[data-role="load-sample-audio"]');
    if (loadSampleBtn) {
      loadSampleBtn.addEventListener('click', async () => {
        const samples = (typeof AudioEngine!=='undefined' && AudioEngine.getCachedSamples) ? AudioEngine.getCachedSamples() : [];
        const picked = await Modal.pickList(
          samples.map(s => ({ label: s.name, value: s })),
          { title: 'Load Sample Audio', emptyLabel: 'No sample audio available' }
        );
        if (!picked) return;
        const name = await AudioEngine.loadSampleClip(picked.file, picked.name);
        if (!name) return;
        state.audio_source = picked.file;
        state.audio_file = name;
        if (state.waveform !== 'Audio File') state.waveform = 'Audio File'; // loading only makes sense as a prelude to playing it
        showPermanent('input');
        Storage.markDirty(); History.pushDebounced();
      });
    }

    const loadCustomBtn = _content.querySelector('[data-role="load-custom-audio"]');
    if (loadCustomBtn) {
      loadCustomBtn.addEventListener('click', async () => {
        const fileData = await Storage.openAudioFile();
        if (!fileData) return; // cancelled
        const name = await AudioEngine.loadAudioFile(fileData);
        if (!name) return;
        state.audio_source = 'upload';
        state.audio_file = name; // same "currently loaded" field bundled samples use — keeps display/save logic uniform
        if (state.waveform !== 'Audio File') state.waveform = 'Audio File';
        showPermanent('input');
        Storage.markDirty(); History.pushDebounced();
      });
    }
  }

  function onPermanentPropChange(e) {
    const kind = _currentPermanentKind;
    if (!kind) return;
    const key = e.target.dataset.key;
    if (!key) return;
    const def   = PERMANENT_DEFS[kind];
    const prop  = def.properties.find(p=>p.key===key);
    const state = WorkbenchStrip.getPermanentState()[kind];
    const rawVal = e.target.value;

    if (prop?.type==='number' || e.target.type==='range') {
      state[key] = rawVal==='' ? '' : parseFloat(rawVal);
    } else if (prop?.type==='boolean') {
      state[key] = rawVal==='true';
    } else {
      state[key] = rawVal;
    }

    if (prop?.type==='range') {
      const v = document.getElementById(`rval-${key}`);
      if (v) v.textContent = Math.round(parseFloat(rawVal)*100)+'%';
    }

    WorkbenchStrip.render();
    if (typeof TraceOverlay !== 'undefined') TraceOverlay.render();
    if (kind === 'output' && (key === 'volume' || key === 'mute') && typeof AudioEngine !== 'undefined') {
      AudioEngine.setOutputGain(state.volume, state.mute);
    }
    Storage.markDirty(); History.pushDebounced();
  }

  // ── Wire ────────────────────────────────────────────────────────────────────
  function showWire(wire) {
    const engaged = typeof isCircuitEngaged === 'function' && isCircuitEngaged();
    _content.innerHTML = `
      ${engaged ? '<div class="prop-locked-note"><i class="fa-solid fa-lock"></i> Stop the simulation or bypass the pedal to remove a jumper.</div>' : ''}
      <div class="prop-component-header">
        <div class="prop-component-symbol"
          style="background:${wire.color||'#ff9900'};border-color:${wire.color||'#ff9900'}">⌇</div>
        <div class="prop-component-info">
          <div class="prop-component-label">Jumper Wire</div>
          <div class="prop-component-id">${wire.id}</div>
        </div>
      </div>
      <div class="prop-group">
        <label class="prop-label">Color</label>
        <input class="prop-input" type="color" id="wire-color-pick" value="${wire.color||'#ff9900'}">
      </div>
      <button class="prop-delete-btn" id="prop-delete-btn" ${engaged ? 'disabled' : ''}>
        <i class="fa-solid fa-trash-can"></i> Remove Jumper
      </button>`;

    document.getElementById('wire-color-pick')?.addEventListener('input', e => {
      wire.color = e.target.value;
      Board.redraw(); Storage.markDirty(); History.pushDebounced();
    });
    document.getElementById('prop-delete-btn')?.addEventListener('click', () => {
      Board.deleteSelected(); hide(); Storage.markDirty(); History.push();
    });
  }

  // ── Component ───────────────────────────────────────────────────────────────
  function showComponent(inst) {
    const def = ComponentRegistry.getById(inst.defId);
    if (!def) return;

    const engaged = typeof isCircuitEngaged === 'function' && isCircuitEngaged();

    let html = ``;
    if (engaged) {
      const wiperNote = def.behavior?.type === 'potentiometer'
        ? 'Wiper stays adjustable while engaged — everything else is locked.'
        : 'Stop the simulation or bypass the pedal to edit this component.';
      html += `<div class="prop-locked-note"><i class="fa-solid fa-lock"></i> ${wiperNote}</div>`;
    }
    html += `
      <div class="prop-component-header">
        <div class="prop-component-symbol">${def.symbol||'?'}</div>
        <div class="prop-component-info">
          <div class="prop-component-label">${def.label}</div>
          <div class="prop-component-id">${inst.instanceId}</div>
        </div>
      </div>`;

    // ── Title (optional, all non-jumper/non-permanent components) ───────────
    // Purely optional metadata, not part of any component's behavior schema —
    // stored in inst.props.title only once the user actually types something
    // (see onPropChange), so old saved .rw files with no title never gain a
    // new key just from being opened and re-saved.
    html += `
      <div class="prop-group">
        <label class="prop-label">Title</label>
        <input class="prop-input" type="text" data-key="title" data-meta="true"
          value="${(inst.props.title||'').replace(/"/g,'&quot;')}" placeholder="Optional label">
      </div>`;

    for (const prop of (def.properties||[])) {
      let placeholder, unitLabel;
      if (prop.key==='leakage') {
        const pm = def.model_params?.[inst.props.model];
        if (pm) placeholder = pm.icbo_na ?? pm.leakage_ua;
      }
      if (prop.key==='hfe') {
        const pm = def.model_params?.[inst.props.model];
        if (pm) placeholder = pm.hfe;
      }
      if (prop.type==='value_unit') {
        unitLabel = inst.props[prop.key+'__unit'] || prop.default_unit || (prop.units&&prop.units[0]?.label);
        // Older saved circuits may have a leakage value (or just a model
        // hint) but never ran through applyModelDefaults' unit selection —
        // fall back to the same magnitude heuristic so the display is still
        // sensible rather than defaulting to nA for a germanium part.
        if (prop.key==='leakage' && !inst.props[prop.key+'__unit']) {
          const magnitude = parseFloat(inst.props.leakage) || placeholder;
          if (magnitude >= 1000) unitLabel = 'µA';
        }
      }
      html += buildPropField(prop, inst.props[prop.key], placeholder, unitLabel);
    }

    // ── Orientation controls ─────────────────────────────────────────────────
    // Rotate: for any 2+ leg component (not IC, not the power supply). This is
    // now the only reorientation control — Flip has been removed in favor of
    // Rotate 90°. The power supply is excluded: it's meant to bridge the rails
    // in one fixed orientation, and reverse_polarity already covers swapping
    // + and – electrically, so rotating it has no legitimate use and only
    // risks landing it off the rails.
    const canRotate = def.legs >= 2 && def.category !== 'ic' && def.id !== 'power_supply';

    if (canRotate) {
      html += `<div class="prop-section-div"></div>`;
    }

    if (canRotate) {
      html += `
        <div class="prop-group">
          <label class="prop-label">Rotate</label>
          <div class="prop-rotate-wrap">
            <button class="prop-rotate-btn" id="prop-rotate-ccw" title="Rotate 90° counter-clockwise">
              <i class="fa-solid fa-rotate-left"></i>
            </button>
            <button class="prop-rotate-btn" id="prop-rotate-cw" title="Rotate 90° clockwise">
              <i class="fa-solid fa-rotate-right"></i>
            </button>
          </div>
        </div>`;
    }

    html += `
      <div class="prop-group">
        <label class="prop-label">Description</label>
        <textarea class="prop-input prop-textarea" data-key="description" data-meta="true"
          rows="4" placeholder="Optional notes">${(inst.props.description||'').replace(/</g,'&lt;')}</textarea>
      </div>`;

    html += `
      <button class="prop-delete-btn" id="prop-delete-btn">
        <i class="fa-solid fa-trash-can"></i> Remove Component
      </button>`;

    _content.innerHTML = html;

    if (engaged) {
      _content.querySelectorAll('input, select, textarea, button').forEach(el => {
        const key = el.dataset.key;
        const prop = key ? def.properties?.find(p => p.key === key) : null;
        const isLive = prop?.live === true || el.dataset.meta === 'true';
        if (!isLive) el.disabled = true;
      });
      // Rotate/Remove are structural (repositioning or pulling the part
      // entirely) — always locked while engaged, no live exception even for
      // a potentiometer's own buttons.
      document.getElementById('prop-rotate-cw')?.setAttribute('disabled', 'true');
      document.getElementById('prop-rotate-ccw')?.setAttribute('disabled', 'true');
      document.getElementById('prop-delete-btn')?.setAttribute('disabled', 'true');
    }

    // Rotate CW/CCW — moves outer leg positions by 90° around the body center
    document.getElementById('prop-rotate-cw')?.addEventListener('click', () => {
      rotateLeg90(inst, 1); // clockwise = +90°
    });
    document.getElementById('prop-rotate-ccw')?.addEventListener('click', () => {
      rotateLeg90(inst, -1); // counter-clockwise = -90°
    });

    // Property change listeners
    _content.querySelectorAll('.prop-input, input[type="range"]').forEach(el => {
      el.addEventListener('input',  onPropChange);
      el.addEventListener('change', onPropChange);
    });

    // Audio file button
    const audioBtn = _content.querySelector('.prop-audio-btn');
    if (audioBtn) {
      audioBtn.addEventListener('click', async () => {
        const fileData = await Storage.openAudioFile();
        if (!fileData) return;
        const name = await AudioEngine.loadAudioFile(fileData);
        if (!name) return;
        inst.props.audio_file = name;
        const nameEl = _content.querySelector('.prop-audio-name');
        if (nameEl) nameEl.textContent = name;
        audioBtn.innerHTML = '<i class="fa-solid fa-music"></i> Change Audio File';
        Storage.markDirty(); History.pushDebounced();
      });
    }

    document.getElementById('prop-delete-btn')?.addEventListener('click', () => {
      Board.deleteSelected(); hide(); Storage.markDirty(); History.push();
    });
  }

  // ── Rotate legs 90° around component center ──────────────────────────────────
  // dir: +1 = CW, -1 = CCW
  function rotateLeg90(inst, dir) {
    if (!inst.legs || inst.legs.length < 2) return;

    const L = inst.legs;
    const a = L[0], b = L[L.length-1];
    // Rail-anchored legs (rtp/rtm/rbp/rbm row strings) aren't part of the
    // numeric row/col grid this rotation works in — bail rather than rotate
    // garbage (canRotate already excludes power_supply, but stay defensive).
    if (typeof a.row !== 'number' || typeof b.row !== 'number') return;

    // Rotate the OUTER-LEG OFFSET in integer row/col grid space, pivoting on
    // leg[0], rather than in pixel space. Row pitch isn't visually uniform
    // with column pitch (the center gap between top/bottom halves and the
    // rail strips break that), so the old approach — rotate a pixel angle,
    // then snap each new position to its nearest hole — introduced a small
    // rounding error nearly every time, which compounded across repeated
    // rotations into the component visibly walking across the board instead
    // of spinning in place, eventually running out of room. Integer grid
    // rotation has no such error: it's exact by construction, every time.
    const dr = b.row - a.row, dc = b.col - a.col;
    const [ndr, ndc] = dir > 0 ? [dc, -dr] : [-dc, dr]; // CW: (dr,dc)->(dc,-dr); CCW is the inverse

    const newB = { row: a.row + ndr, col: a.col + ndc };
    if (newB.row < 0 || newB.row > 9 || newB.col < 0 || newB.col > 62) return; // would land off-board

    inst.legs[L.length-1] = newB;

    // 3-leg parts (potentiometers, transistors): the middle leg is always
    // evenly spaced between the outer two on real hardware, so the new
    // midpoint lands exactly on a hole here too — no snapping needed.
    if (L.length === 3) {
      const midRow = a.row + ndr/2, midCol = a.col + ndc/2;
      if (Number.isInteger(midRow) && Number.isInteger(midCol)) {
        inst.legs[1] = { row: midRow, col: midCol };
      }
    }

    Board.redraw(); Storage.markDirty(); History.push();
  }

  // ── Field builders ───────────────────────────────────────────────────────────
  function buildPropField(prop, value, placeholder, unitLabel) {
    switch (prop.type) {
      case 'number': {
        return `
          <div class="prop-group">
            <label class="prop-label">${prop.label}</label>
            <input class="prop-input" type="number" data-key="${prop.key}"
              value="${value===''||value===undefined||value===null?'':value}"
              ${placeholder!==undefined?`placeholder="${placeholder}"`:''}
              ${prop.min!==undefined?`min="${prop.min}"`:''}
              ${prop.max!==undefined?`max="${prop.max}"`:''}
              step="any">
          </div>`;
      }
      case 'value_unit': {
        const units = prop.units||[];
        const unit = units.find(u=>u.label===unitLabel) || units[0] || {label:'',factor:1};
        const raw = parseFloat(value);
        const displayVal = Number.isFinite(raw) ? +(raw/unit.factor).toPrecision(6) : '';
        const rawPlaceholder = parseFloat(placeholder);
        const displayPlaceholder = Number.isFinite(rawPlaceholder) ? +(rawPlaceholder/unit.factor).toPrecision(6) : undefined;
        const opts = units.map(u=>`<option value="${u.label}" ${u.label===unit.label?'selected':''}>${u.label}</option>`).join('');
        return `
          <div class="prop-group">
            <label class="prop-label">${prop.label}</label>
            <div class="prop-value-unit-wrap">
              <input class="prop-input prop-vu-value" type="number" data-key="${prop.key}" data-role="vu-value" value="${displayVal}"
                ${displayPlaceholder!==undefined?`placeholder="${displayPlaceholder}"`:''} step="any">
              <select class="prop-input prop-vu-unit" data-key="${prop.key}" data-role="vu-unit">${opts}</select>
            </div>
          </div>`;
      }
      case 'select': {
        const opts = prop.options.map(o =>
          `<option value="${o}" ${o===value?'selected':''}>${o}</option>`).join('');
        return `
          <div class="prop-group">
            <label class="prop-label">${prop.label}</label>
            <select class="prop-input" data-key="${prop.key}">${opts}</select>
          </div>`;
      }
      case 'boolean':
        return `
          <div class="prop-group">
            <label class="prop-label">${prop.label}</label>
            <select class="prop-input" data-key="${prop.key}">
              <option value="true"  ${value?'selected':''}>Yes</option>
              <option value="false" ${!value?'selected':''}>No</option>
            </select>
          </div>`;
      case 'range':
        return `
          <div class="prop-group">
            <label class="prop-label">${prop.label}</label>
            <div class="prop-range-wrap">
              <input type="range" data-key="${prop.key}"
                min="${prop.min}" max="${prop.max}" step="${prop.step}" value="${value}">
              <span class="prop-range-value" id="rval-${prop.key}">${Math.round(value*100)}%</span>
            </div>
          </div>`;
      case 'audio_file':
        // Legacy path — used only by the retired Signal Generator component
        // for any already-placed instance from an older saved project.
        // Unrelated to the permanent Input's audio source below; kept as
        // its original simple button, not the sample dropdown.
        return `
          <div class="prop-group">
            <label class="prop-label">${prop.label}</label>
            <button class="prop-audio-btn">
              <i class="fa-solid fa-music"></i>
              ${value?'Change Audio File':'Load Audio File…'}
            </button>
            <div class="prop-audio-name">${value||''}</div>
          </div>`;
      case 'permanent_audio_source': {
        const audioSource = (typeof WorkbenchStrip!=='undefined') ? (WorkbenchStrip.getPermanentState().input.audio_source || 'upload') : 'upload';
        const isUpload = audioSource === 'upload';
        const samples = (typeof AudioEngine!=='undefined' && AudioEngine.getCachedSamples) ? AudioEngine.getCachedSamples() : [];
        // value is audio_file's current display name; when source isn't
        // 'upload' it's a bundled sample, so look up its own name rather
        // than trusting value (kept in sync anyway, but this is the source
        // of truth for what's actually loaded).
        const currentLabel = !value ? null : (isUpload ? value : (samples.find(s => s.file === audioSource)?.name || value));

        return `
          <div class="prop-group">
            <label class="prop-label">Audio File</label>
            <div class="prop-audio-source-buttons">
              <button class="prop-audio-btn" data-role="load-sample-audio"><i class="fa-solid fa-list"></i> Load Sample Audio</button>
              <button class="prop-audio-btn" data-role="load-custom-audio"><i class="fa-solid fa-upload"></i> Load Custom Audio</button>
            </div>
            ${currentLabel ? `<div class="prop-audio-name">${currentLabel}</div>` : ''}
          </div>`;
      }
      default: return '';
    }
  }

  function onPropChange(e) {
    if (!_currentInst) return;
    const key = e.target.dataset.key;
    if (!key) return;
    const rawVal = e.target.value;

    if (e.target.dataset.meta === 'true') {
      // Title/Description are optional metadata, not part of any component's
      // behavior schema — only add the key when there's real content, and
      // remove it entirely when cleared, so the .rw format stays backward
      // compatible (old files never gain a key just from being reopened).
      if (rawVal.trim() === '') delete _currentInst.props[key];
      else _currentInst.props[key] = rawVal;
      Board.redraw(); Storage.markDirty(); History.pushDebounced();
      return;
    }

    const def    = ComponentRegistry.getById(_currentInst.defId);
    const prop   = def?.properties?.find(p=>p.key===key);

    if (prop?.type==='value_unit') {
      const role = e.target.dataset.role;
      const wrap = e.target.closest('.prop-value-unit-wrap');
      const valueEl = wrap.querySelector('[data-role="vu-value"]');
      const unitEl  = wrap.querySelector('[data-role="vu-unit"]');
      const unit = (prop.units||[]).find(u=>u.label===unitEl.value) || (prop.units||[])[0] || {label:'',factor:1};

      if (role==='vu-unit') {
        // Switching units re-expresses the same physical quantity — it
        // must not silently change the underlying value.
        _currentInst.props[key+'__unit'] = unit.label;
        const canonical = parseFloat(_currentInst.props[key]);
        valueEl.value = Number.isFinite(canonical) ? +(canonical/unit.factor).toPrecision(6) : '';
      } else {
        const typed = parseFloat(valueEl.value);
        _currentInst.props[key] = Number.isFinite(typed) ? typed*unit.factor : '';
        _currentInst.props[key+'__unit'] = unit.label;
      }
      Board.redraw(); Storage.markDirty(); History.pushDebounced();
      return;
    }

    if (prop?.type==='number' || e.target.type==='range') {
      _currentInst.props[key] = rawVal==='' ? '' : parseFloat(rawVal);
    } else if (prop?.type==='boolean') {
      _currentInst.props[key] = rawVal==='true';
    } else {
      _currentInst.props[key] = rawVal;
    }

    if (key==='wiper') {
      const v = document.getElementById(`rval-${key}`);
      if (v) v.textContent = Math.round(parseFloat(rawVal)*100)+'%';
      if (AudioEngine.isRunning()) AudioEngine.updatePotWiper(_currentInst);
    }

    Board.redraw(); Storage.markDirty(); History.pushDebounced();

    if (key==='model') {
      // A custom hfe/leakage belongs to the model it was set under — switching
      // models resets both to the newly-selected model's real rated values.
      ComponentRegistry.applyModelDefaults(_currentInst);
      // Re-render so the now-updated hfe/leakage fields (and any placeholder
      // depending on them) show immediately, rather than staying stale until
      // the panel is closed and reopened.
      show(_currentInst);
    }
  }

  function hide() {
    _currentInst = null; _currentWire = null; _currentPermanentKind = null;
    _content.innerHTML = `
      <div class="props-empty">
        <i class="fa-solid fa-arrow-pointer"></i>
        <p>Select a component or jumper wire to edit its properties</p>
      </div>`;
  }

  // Re-renders whatever's currently shown — used when simulation state
  // changes (run/stop) or bypass toggles, so an already-open panel
  // grays out/unlocks immediately, instead of only updating the next
  // time it's opened (previously this only handled the permanent-device
  // case, so a component/wire panel left open across Play/Stop/bypass
  // stayed stale and editable when it should have locked).
  function refresh() {
    if (_currentPermanentKind) showPermanent(_currentPermanentKind);
    else if (_currentInst) show(_currentInst, null);
    else if (_currentWire) show(null, _currentWire);
  }

  return { init, show, hide, showPermanent, refresh };
})();