// ── Properties Panel ──────────────────────────────────────────────────────────

const PropertiesPanel = (() => {
  let _content;
  let _currentInst = null;
  let _currentWire = null;
  let _currentPermanentKind = null; // 'power' | 'input' | 'output' | null

  // A range slider's live readout defaults to "value*100%", correct for a
  // 0-1 fraction like volume/battery_sag/wiper. A field with a real unit
  // (amplitude in V, phase in °) needs its own value and unit shown instead
  // — "35%" for a 0.35V amplitude reads as nonsense. `prop.unit` opts a
  // field into this; omitting it keeps the original percentage behavior for
  // every existing 0-1 range field unchanged.
  function formatRangeValue(prop, value) {
    if (prop?.unit) {
      const decimals = (prop.step && prop.step < 1) ? 2 : 0;
      return Number(value).toFixed(decimals) + prop.unit;
    }
    return Math.round(value * 100) + '%';
  }

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
      labelKey: 'app.permanent.power.label', symbol: '9V',
      properties: [
        { key:'power_on', labelKey:'app.permanent.power.power_on.label', type:'boolean', default:true,
          hintKey:'app.permanent.power.power_on.hint' },
        { key:'voltage', labelKey:'app.permanent.power.voltage.label', type:'number', default:9, min:1, max:24,
          hintKey:'app.permanent.power.voltage.hint' },
        { key:'current_limit_ma', labelKey:'app.permanent.power.current_limit_ma.label', type:'number', default:500,
          hintKey:'app.permanent.power.current_limit_ma.hint' },
        { key:'reverse_polarity', labelKey:'app.permanent.power.reverse_polarity.label', type:'boolean', default:false,
          hintKey:'app.permanent.power.reverse_polarity.hint' },
        { key:'battery_sag', labelKey:'app.permanent.power.battery_sag.label', type:'range', min:0, max:1, step:0.01, default:0,
          hintKey:'app.permanent.power.battery_sag.hint' },
        { key:'internal_resistance', labelKey:'app.permanent.power.internal_resistance.label', type:'number', default:1, min:0,
          hintKey:'app.permanent.power.internal_resistance.hint' },
      ]
    },
    input: {
      labelKey: 'app.permanent.input.label', symbol: 'IN',
      properties: [
        { key:'waveform', labelKey:'app.permanent.input.waveform.label', type:'select', default:'None',
          options:['None','Sine','Square','Triangle','Sawtooth','White Noise','Pink Noise','Audio File'],
          hintKey:'app.permanent.input.waveform.hint',
          _i18nNote: 'options ARE matched literally in audio-engine.js (waveform === \'Audio File\'/\'White Noise\'/\'Pink Noise\'/\'None\') — needs a stable non-text identifier before this can be localized.' },
        { key:'source_impedance', labelKey:'app.permanent.input.source_impedance.label', type:'number', default:10000, min:0, max:1000000,
          hintKey:'app.permanent.input.source_impedance.hint' },
        { key:'frequency', labelKey:'app.permanent.input.frequency.label', type:'number', default:440, min:1, max:20000,
          hintKey:'app.permanent.input.frequency.hint' },
        { key:'amplitude', labelKey:'app.permanent.input.amplitude.label', type:'range', min:0.01, max:12, step:0.01, default:0.35, unit:'V',
          hintKey:'app.permanent.input.amplitude.hint' },
        { key:'dc_offset', labelKey:'app.permanent.input.dc_offset.label', type:'number', default:0, min:-12, max:12,
          hintKey:'app.permanent.input.dc_offset.hint' },
        { key:'phase', labelKey:'app.permanent.input.phase.label', type:'range', min:0, max:360, step:1, default:0, unit:'°',
          hintKey:'app.permanent.input.phase.hint' },
        { key:'looping', labelKey:'app.permanent.input.looping.label', type:'boolean', default:true,
          hintKey:'app.permanent.input.looping.hint' },
        { key:'audio_file', labelKey:'app.permanent.input.audio_file.label', type:'permanent_audio_source', default:null,
          hintKey:'app.permanent.input.audio_file.hint' },
      ]
    },
    output: {
      labelKey: 'app.permanent.output.label', symbol: 'OUT',
      properties: [
        { key:'load_impedance', labelKey:'app.permanent.output.load_impedance.label', type:'number', default:1000000, min:1, max:10000000,
          hintKey:'app.permanent.output.load_impedance.hint' },
        { key:'volume', labelKey:'app.permanent.output.volume.label', type:'range', min:0, max:1, step:0.01, default:1.0,
          hintKey:'app.permanent.output.volume.hint' },
        { key:'mute', labelKey:'app.permanent.output.mute.label', type:'boolean', default:false,
          hintKey:'app.permanent.output.mute.hint' },
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

    // One delegated binding for every [data-hint] element's tooltip (field
    // labels AND the Rotate buttons below), rather than rebinding per-render
    // — _content's children get fully replaced on every showComponent()/
    // showPermanent() call, but the listener on _content itself doesn't
    // need to move.
    if (typeof Tooltip !== 'undefined') Tooltip.wireHintDelegate(_content, '[data-hint]', { wrap: true });
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
          <div class="prop-component-label">${I18n.t(def.labelKey)}</div>
          <div class="prop-component-id">${I18n.t('app.permanent.deviceTag')}</div>
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
      const msg = kind === 'input' ? I18n.t('app.permanent.lockedInput')
                                    : I18n.t('app.permanent.lockedPower');
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
          { title: I18n.t('app.properties.loadSampleAudio'), emptyLabel: I18n.t('app.properties.noSampleAudio') }
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
      if (v) v.textContent = formatRangeValue(prop, parseFloat(rawVal));
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
      ${engaged ? `<div class="prop-locked-note"><i class="fa-solid fa-lock"></i> ${I18n.t('app.properties.stopToEditWire')}</div>` : ''}
      <div class="prop-component-header">
        <div class="prop-component-symbol"
          style="background:${wire.color||'#ff9900'};border-color:${wire.color||'#ff9900'}">⌇</div>
        <div class="prop-component-info">
          <div class="prop-component-label">${I18n.t('app.properties.jumperWire')}</div>
          <div class="prop-component-id">${wire.id}</div>
        </div>
      </div>
      <div class="prop-group">
        <label class="prop-label">${I18n.t('app.properties.color')}</label>
        <input class="prop-input" type="color" id="wire-color-pick" value="${wire.color||'#ff9900'}">
      </div>
      <button class="prop-delete-btn" id="prop-delete-btn" ${engaged ? 'disabled' : ''}>
        <i class="fa-solid fa-trash-can"></i> ${I18n.t('app.properties.removeJumper')}
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
        ? I18n.t('app.properties.wiperStaysAdjustable')
        : I18n.t('app.properties.stopToEdit');
      html += `<div class="prop-locked-note"><i class="fa-solid fa-lock"></i> ${wiperNote}</div>`;
    }
    html += `
      <div class="prop-component-header">
        <div class="prop-component-symbol">${def.symbol||'?'}</div>
        <div class="prop-component-info">
          <div class="prop-component-label">${I18n.t(def.labelKey)}</div>
          <div class="prop-component-id">${inst.instanceId}</div>
        </div>
      </div>`;

    // ── Title (optional, all non-jumper/non-permanent components) ───────────
    // Purely optional metadata, not part of any component's behavior schema —
    // stored in inst.props.title only once the user actually types something
    // (see onPropChange), so old saved .rye files with no title never gain a
    // new key just from being opened and re-saved.
    html += `
      <div class="prop-group">
        <label class="prop-label">${I18n.t('app.properties.title')}</label>
        <input class="prop-input" type="text" data-key="title" data-meta="true"
          value="${(inst.props.title||'').replace(/"/g,'&quot;')}" placeholder="${escapeAttr(I18n.t('app.properties.optionalLabel'))}">
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
      if (prop.key==='idss') {
        const pm = def.model_params?.[inst.props.model];
        if (pm) placeholder = pm.idss_ma;
      }
      if (prop.key==='vgs_off') {
        const pm = def.model_params?.[inst.props.model];
        if (pm) placeholder = pm.vgs_off;
      }
      if (prop.key==='vgs_th') {
        const pm = def.model_params?.[inst.props.model];
        if (pm) placeholder = pm.vgs_th;
      }
      if (prop.key==='k' && def.behavior?.type==='mosfet_n') {
        const pm = def.model_params?.[inst.props.model];
        if (pm) placeholder = pm.k;
      }
      if (prop.key==='zener_voltage') {
        const pm = def.model_params?.[inst.props.model];
        if (pm) placeholder = pm.vz;
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
      // The On-On-On truth table only means anything once that throw type
      // is actually selected — hidden otherwise, same as how this app
      // generally avoids showing controls with no live effect.
      if (prop.key==='throw_table' && inst.props?.throw_type!=='On-On-On') continue;
      // Momentary has no coherent rest position for On-On-On's independent
      // per-pole throw_table — hidden there for the same "no live effect"
      // reason, mirroring the throw_table exclusion just above. (switch_mpdt
      // types other than DPDT never offer On-On-On at all, so this only
      // actually triggers for DPDT switches.)
      if (prop.key==='type' && def.behavior?.type==='switch_mpdt' && inst.props?.throw_type==='On-On-On') continue;
      if (prop.type==='throw_table') {
        html += buildThrowTableField(prop, inst.props[prop.key]||{}, def.behavior?.rows||1);
        continue;
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
    const canRotate = def.legs >= 2 && def.id !== 'power_supply';

    if (canRotate) {
      html += `<div class="prop-section-div"></div>`;
    }

    if (canRotate) {
      html += `
        <div class="prop-group">
          <label class="prop-label">${I18n.t('app.properties.rotate')}</label>
          <div class="prop-rotate-wrap">
            <button class="prop-rotate-btn" id="prop-rotate-ccw" data-hint="${escapeAttr(I18n.t('app.properties.rotateCcw'))}">
              <i class="fa-solid fa-rotate-left"></i>
            </button>
            <button class="prop-rotate-btn" id="prop-rotate-cw" data-hint="${escapeAttr(I18n.t('app.properties.rotateCw'))}">
              <i class="fa-solid fa-rotate-right"></i>
            </button>
          </div>
        </div>`;
    }

    html += `
      <div class="prop-group">
        <label class="prop-label">${I18n.t('app.properties.description')}</label>
        <textarea class="prop-input prop-textarea" data-key="description" data-meta="true"
          rows="4" placeholder="${escapeAttr(I18n.t('app.properties.optionalNotes'))}">${(inst.props.description||'').replace(/</g,'&lt;')}</textarea>
      </div>`;

    html += `
      <button class="prop-delete-btn" id="prop-delete-btn">
        <i class="fa-solid fa-trash-can"></i> ${I18n.t('app.properties.removeComponent')}
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

    // Property change listeners. Throw-table cells write into a NESTED
    // object (props.throw_table[pole-position]), not a flat props[key] the
    // way every other field does, so they're excluded here and get their
    // own listener below rather than teaching onPropChange a special case
    // for one property's internal shape.
    _content.querySelectorAll('.prop-input:not(.prop-throw-cell), input[type="range"]').forEach(el => {
      el.addEventListener('input',  onPropChange);
      el.addEventListener('change', onPropChange);
    });
    _content.querySelectorAll('.prop-throw-cell').forEach(el => {
      el.addEventListener('change', onThrowTableChange);
    });
    wireCustomSelects();

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
        audioBtn.innerHTML = `<i class="fa-solid fa-music"></i> ${I18n.t('app.properties.changeAudioFile')}`;
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

    const def = ComponentRegistry.getById(inst.defId);
    if (def?.category === 'ic') { rotateIc180(inst); return; }

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

  // DIP packages only ever sit in one of two real-world orientations on a
  // breadboard (pin 1 left or pin 1 right, always straddling the center
  // channel) — a true 90°-increment rotation has no physical equivalent for
  // a chip socketed this way, so this is a 180° flip, not a generalization
  // of rotateLeg90's per-90°-step math above.
  //
  // A 180° in-plane flip maps every pin to its DIAGONAL opposite corner of
  // the pin grid (row 4↔5 AND column mirrored about the grid's own center
  // simultaneously) — verified against a hand-derived case before writing
  // this: reversing the leg array (an earlier, simpler-looking approach)
  // is WRONG, it maps each pin to the hole directly across the channel
  // (same column, other row) rather than the true diagonal, which only
  // happens to look right for a single-column-wide part.
  function rotateIc180(inst) {
    if (!inst.legs || inst.legs.length < 2) return;
    const cols = inst.legs.map(l => l.col);
    const minCol = Math.min(...cols), maxCol = Math.max(...cols);
    const centerCol2 = minCol + maxCol; // 2x the center column, so the mirror math stays integer even when the span is odd
    const rows = [...new Set(inst.legs.map(l => l.row))];
    if (rows.length !== 2) return; // defensive — a DIP always spans exactly 2 rows (see buildDipLegs)
    const [rowA, rowB] = rows;
    inst.legs = inst.legs.map(l => ({
      row: l.row === rowA ? rowB : rowA,
      col: centerCol2 - l.col,
    }));
    Board.redraw(); Storage.markDirty(); History.push();
  }

  // ── Field builders ───────────────────────────────────────────────────────────
  // Component-JSON properties and PERMANENT_DEFS properties (Power/Input/
  // Output) both carry labelKey/hintKey now, but this stays in place as a
  // single choke point rather than assuming every future prop shape does —
  // resolves whichever shape `prop` actually has into a plain {label, hint}
  // once, so buildPropFieldInner's ~7 internal ${prop.label} sites never
  // need to know or care which source it came from.
  function resolvePropText(prop) {
    const label = prop.labelKey ? I18n.t(prop.labelKey) : (prop.label ?? '');
    const hint  = prop.hintKey  ? I18n.t(prop.hintKey)   : prop.hint;
    return (label === prop.label && hint === prop.hint) ? prop : { ...prop, label, hint };
  }

  function buildPropField(prop, value, placeholder, unitLabel) {
    const resolved = resolvePropText(prop);
    const html = buildPropFieldInner(resolved, value, placeholder, unitLabel);
    // Single choke point for the hover tooltip on every property's label,
    // rather than repeating this in each case below (which a future new
    // field type would have to remember to add too). No hint (resolved or
    // plain) renders exactly as before (no data-hint at all — an empty
    // tooltip would be worse than none).
    //
    // data-hint rather than title=: a native title tooltip can't be styled
    // (no max-width/word-wrap control, so a long hint renders as one huge
    // single-line strip) and can't be widened without the OS's own layout.
    // Routing through the same Tooltip module the board/workbench already
    // use gives every hint a real CSS max-width + word-wrap (see #hover-
    // tooltip.hint-wrap in app.css) and the same 500ms-show/instant-hide
    // behavior as everywhere else in the app, instead of a second,
    // inconsistent tooltip mechanism.
    if (!resolved.hint) return html;
    return html.replace('class="prop-label"', `class="prop-label" data-hint="${escapeAttr(resolved.hint)}"`);
  }

  // On-On-On throw table: one row per pole, one A/B/Open dropdown per
  // position (1/2/3). No default pattern is ever pre-filled here (see the
  // component JSON's own note — real on-on-on switches vary by
  // manufacturer, verified against multiple sources, so this app never
  // presumes a specific part's internal wiring). Each dropdown carries
  // data-pole/data-position instead of the generic data-key value-write
  // path, since the value lives in a nested object (props.throw_table),
  // not a flat prop — handled by its own change listener (see wireUp)
  // rather than onPropChange's generic props[key]=value.
  function buildThrowTableField(prop, table, poles) {
    const resolved = resolvePropText(prop);
    const posLabel = n => I18n.t('app.properties.throwTablePosition', { n });
    let rows = '';
    for (let p = 0; p < poles; p++) {
      let cells = '';
      for (let pos = 1; pos <= 3; pos++) {
        const cellKey = p+'-'+pos;
        const cur = table[cellKey] || '';
        cells += `
          <select class="prop-input prop-throw-cell" data-pole="${p}" data-position="${pos}">
            <option value="" ${cur===''?'selected':''}>${I18n.t('app.properties.throwTableOpen')}</option>
            <option value="A" ${cur==='A'?'selected':''}>A</option>
            <option value="B" ${cur==='B'?'selected':''}>B</option>
          </select>`;
      }
      rows += `<div class="prop-throw-row"><span class="prop-throw-pole-label">${I18n.t('app.properties.throwTablePole',{n:p+1})}</span>${cells}</div>`;
    }
    const header = `<div class="prop-throw-row prop-throw-header"><span class="prop-throw-pole-label"></span>`
      + [1,2,3].map(n=>`<span class="prop-throw-pos-label">${posLabel(n)}</span>`).join('') + `</div>`;
    const html = `
      <div class="prop-group prop-throw-table" data-key="${prop.key}">
        <label class="prop-label">${resolved.label}</label>
        ${header}${rows}
      </div>`;
    if (!resolved.hint) return html;
    return html.replace('class="prop-label"', `class="prop-label" data-hint="${escapeAttr(resolved.hint)}"`);
  }

  function escapeAttr(s) {
    return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');
  }

  function buildPropFieldInner(prop, value, placeholder, unitLabel) {
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

        // Short lists stay as a native select. Long ones (the transistor model
        // list is 18 entries) get a custom dropdown, because a native select's
        // popup is drawn by the OS and cannot be capped to N rows or given a
        // styled scrollbar from CSS.
        //
        // The real <select> is kept in the DOM, visually hidden, and remains
        // the source of truth: the custom UI writes to it and dispatches
        // 'change', so onPropChange and the engaged-lock's blanket
        // `querySelectorAll('input, select, textarea, button').disabled = true`
        // both keep working with no special cases.
        if (prop.options.length <= LONG_SELECT_THRESHOLD) {
          return `
          <div class="prop-group">
            <label class="prop-label">${prop.label}</label>
            <select class="prop-input" data-key="${prop.key}">${opts}</select>
          </div>`;
        }

        const items = prop.options.map(o =>
          `<button type="button" class="cs-item${o===value?' cs-selected':''}" data-value="${o}">${o}</button>`).join('');
        return `
          <div class="prop-group">
            <label class="prop-label">${prop.label}</label>
            <div class="custom-select" data-for="${prop.key}">
              <select class="prop-input cs-native" data-key="${prop.key}">${opts}</select>
              <button type="button" class="cs-trigger">
                <span class="cs-value">${value}</span>
                <i class="fa-solid fa-chevron-down"></i>
              </button>
              <div class="cs-menu">${items}</div>
            </div>
          </div>`;
      }
      case 'boolean':
        return `
          <div class="prop-group">
            <label class="prop-label">${prop.label}</label>
            <select class="prop-input" data-key="${prop.key}">
              <option value="true"  ${value?'selected':''}>${I18n.t('app.properties.yes')}</option>
              <option value="false" ${!value?'selected':''}>${I18n.t('app.properties.no')}</option>
            </select>
          </div>`;
      case 'range':
        return `
          <div class="prop-group">
            <label class="prop-label">${prop.label}</label>
            <div class="prop-range-wrap">
              <input type="range" data-key="${prop.key}"
                min="${prop.min}" max="${prop.max}" step="${prop.step}" value="${value}">
              <span class="prop-range-value" id="rval-${prop.key}">${formatRangeValue(prop, value)}</span>
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
              ${value?I18n.t('app.properties.changeAudioFile'):I18n.t('app.properties.loadAudioFile')}
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
            <label class="prop-label">${I18n.t('app.properties.audioFile')}</label>
            <div class="prop-audio-source-buttons">
              <button class="prop-audio-btn" data-role="load-sample-audio"><i class="fa-solid fa-list"></i> ${I18n.t('app.properties.loadSampleAudioBtn')}</button>
              <button class="prop-audio-btn" data-role="load-custom-audio"><i class="fa-solid fa-upload"></i> ${I18n.t('app.properties.loadCustomAudio')}</button>
            </div>
            ${currentLabel ? `<div class="prop-audio-name">${currentLabel}</div>` : ''}
          </div>`;
      }
      default: return '';
    }
  }

  // Option-count above which a select becomes a custom dropdown. Matches the
  // 8 rows the menu is capped at, so anything that fits without scrolling
  // stays a plain native select.
  const LONG_SELECT_THRESHOLD = 8;

  // Wires the custom dropdowns built above. The hidden native <select> stays
  // authoritative, so this only has to keep the two in sync and close itself.
  function wireCustomSelects() {
    for (const cs of _content.querySelectorAll('.custom-select')) {
      const native  = cs.querySelector('.cs-native');
      const trigger = cs.querySelector('.cs-trigger');
      const menu    = cs.querySelector('.cs-menu');
      const label   = cs.querySelector('.cs-value');

      trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        if (trigger.disabled) return;
        const wasOpen = cs.classList.contains('cs-open');
        closeAllCustomSelects();
        if (wasOpen) return;
        cs.classList.add('cs-open');
        // Scroll the current choice into view — with 18 models the selected
        // one is often below the fold.
        const sel = menu.querySelector('.cs-selected');
        if (sel) sel.scrollIntoView({ block: 'nearest' });
      });

      for (const item of menu.querySelectorAll('.cs-item')) {
        item.addEventListener('click', (e) => {
          e.stopPropagation();
          const v = item.dataset.value;
          native.value = v;
          label.textContent = v;
          menu.querySelectorAll('.cs-selected').forEach(n => n.classList.remove('cs-selected'));
          item.classList.add('cs-selected');
          cs.classList.remove('cs-open');
          // Drive the existing handler rather than duplicating its logic.
          native.dispatchEvent(new Event('change', { bubbles: true }));
        });
      }
    }
  }
  function closeAllCustomSelects() {
    document.querySelectorAll('.custom-select.cs-open').forEach(n => n.classList.remove('cs-open'));
  }
  document.addEventListener('click', closeAllCustomSelects);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAllCustomSelects(); });

  function onPropChange(e) {
    if (!_currentInst) return;
    const key = e.target.dataset.key;
    if (!key) return;
    const rawVal = e.target.value;

    if (e.target.dataset.meta === 'true') {
      // Title/Description are optional metadata, not part of any component's
      // behavior schema — only add the key when there's real content, and
      // remove it entirely when cleared, so the .rye format stays backward
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

    if (key==='color') {
      // Same reasoning as 'model' above, for LED's color_map -> forward_voltage
      // (see applyModelDefaults' own comment for why this matters — it was a
      // real bug, not a missing feature, since forward_voltage's flat schema
      // default previously made color_map's per-color Vf unreachable).
      ComponentRegistry.applyModelDefaults(_currentInst);
      show(_currentInst);
    }

    if (key==='throw_type') {
      // Momentary has no coherent rest position for On-On-On (see the
      // matching "hidden" check in the render loop above) — reset it back
      // to Latching rather than leaving a stale Momentary value sitting
      // hidden in props, which would silently resume momentary behavior if
      // the user later switches back to On-On/On-Off-On without having
      // touched Action again. Re-render since the Action field's visibility
      // (and the Position field's valid range) both depend on throw_type.
      if (_currentInst.props?.type==='Momentary' && rawVal==='On-On-On') {
        _currentInst.props.type = 'Latching';
      }
      show(_currentInst);
    }
  }

  // Writes one cell of props.throw_table (see buildThrowTableField) — a
  // nested object, not a flat prop, so it can't go through onPropChange's
  // generic props[key]=rawVal path. Deleting the key entirely for "Open"
  // (rather than storing an empty string) keeps a freshly-placed switch's
  // saved .rye lean and matches this app's existing convention for
  // optional metadata (see onPropChange's title/description handling).
  function onThrowTableChange(e) {
    if (!_currentInst) return;
    const pole = e.target.dataset.pole, position = e.target.dataset.position;
    if (pole==null || position==null) return;
    const cellKey = pole+'-'+position;
    if (!_currentInst.props.throw_table) _currentInst.props.throw_table = {};
    if (e.target.value === '') delete _currentInst.props.throw_table[cellKey];
    else _currentInst.props.throw_table[cellKey] = e.target.value;
    Board.redraw(); Storage.markDirty(); History.pushDebounced();
  }

  function hide() {
    _currentInst = null; _currentWire = null; _currentPermanentKind = null;
    _content.innerHTML = `
      <div class="props-empty">
        <i class="fa-solid fa-arrow-pointer"></i>
        <p>${I18n.t('app.properties.emptyState')}</p>
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