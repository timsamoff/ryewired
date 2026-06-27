// ── Properties Panel ──────────────────────────────────────────────────────────

const PropertiesPanel = (() => {
  let _content;
  let _currentInst = null;

  function init() { _content = document.getElementById('props-content'); }

  function show(inst) {
    _currentInst = inst;
    if (!inst) { hide(); return; }
    const def = ComponentRegistry.getById(inst.defId);
    if (!def) return;

    let html = `
      <div class="prop-component-header">
        <div class="prop-component-symbol">${def.symbol||'?'}</div>
        <div class="prop-component-info">
          <div class="prop-component-label">${def.label}</div>
          <div class="prop-component-id">${inst.instanceId}</div>
        </div>
      </div>`;

    for (const prop of (def.properties||[])) {
      html += buildPropField(prop, inst.props[prop.key], inst, def);
    }

    // Rotation buttons (CW / CCW icons) — skip for ICs and pots
    const skipRotation = ['ic','potentiometer'].includes(def.category) ||
                         def.id === 'potentiometer';
    if (!skipRotation) {
      const rot = inst.rotation || 0;
      html += `
        <div class="prop-section-div"></div>
        <div class="prop-group">
          <label class="prop-label">Rotate</label>
          <div class="prop-rotate-wrap">
            <button class="prop-rotate-btn" id="prop-rotate-ccw" title="Rotate 90° counter-clockwise">
              <i class="fa-solid fa-rotate-left"></i>
            </button>
            <span class="prop-rotate-val">${rot}°</span>
            <button class="prop-rotate-btn" id="prop-rotate-cw" title="Rotate 90° clockwise">
              <i class="fa-solid fa-rotate-right"></i>
            </button>
          </div>
        </div>`;
    }

    html += `
      <button class="prop-delete-btn" id="prop-delete-btn">
        <i class="fa-solid fa-trash-can"></i> Remove Component
      </button>`;

    _content.innerHTML = html;

    // Rotation buttons
    _content.querySelector('#prop-rotate-cw')?.addEventListener('click', () => rotateCW());
    _content.querySelector('#prop-rotate-ccw')?.addEventListener('click', () => rotateCCW());

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
        Storage.markDirty();
      });
    }

    document.getElementById('prop-delete-btn')?.addEventListener('click', () => {
      Board.deleteSelected(); hide(); Storage.markDirty();
    });
  }

  function rotateCW() {
    if (!_currentInst) return;
    _currentInst.rotation = ((_currentInst.rotation || 0) + 90) % 360;
    refreshRotateDisplay();
    Board.redraw(); Storage.markDirty();
  }

  function rotateCCW() {
    if (!_currentInst) return;
    _currentInst.rotation = ((_currentInst.rotation || 0) + 270) % 360;
    refreshRotateDisplay();
    Board.redraw(); Storage.markDirty();
  }

  function refreshRotateDisplay() {
    const valEl = _content.querySelector('.prop-rotate-val');
    if (valEl) valEl.textContent = (_currentInst.rotation || 0) + '°';
  }

  // Format capacitance for display: F → pF/nF/µF/mF
  function formatCapacitance(farads) {
    if (!farads && farads !== 0) return '';
    const v = parseFloat(farads);
    if (v >= 0.001)       return (v * 1000).toPrecision(3).replace(/\.?0+$/, '') + ' mF';
    if (v >= 0.000001)    return (v * 1000000).toPrecision(3).replace(/\.?0+$/, '') + ' µF';
    if (v >= 0.000000001) return (v * 1000000000).toPrecision(3).replace(/\.?0+$/, '') + ' nF';
    return (v * 1000000000000).toPrecision(3).replace(/\.?0+$/, '') + ' pF';
  }

  function buildPropField(prop, value, inst, def) {
    const isCapacitance = prop.key === 'capacitance';

    switch (prop.type) {
      case 'number': {
        const unitDisplay = isCapacitance
          ? `<span class="prop-cap-unit" id="cap-unit-display">${formatCapacitance(value)}</span>`
          : '';
        return `
          <div class="prop-group">
            <label class="prop-label">${prop.label}${unitDisplay}</label>
            <input class="prop-input" type="number" data-key="${prop.key}"
              value="${value}"
              ${prop.min !== undefined ? `min="${prop.min}"` : ''}
              ${prop.max !== undefined ? `max="${prop.max}"` : ''}
              step="any">
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
        return `
          <div class="prop-group">
            <label class="prop-label">${prop.label}</label>
            <button class="prop-audio-btn">
              <i class="fa-solid fa-music"></i>
              ${value ? 'Change Audio File' : 'Load Audio File…'}
            </button>
            <div class="prop-audio-name">${value||''}</div>
          </div>`;

      default: return '';
    }
  }

  function onPropChange(e) {
    if (!_currentInst) return;
    const key    = e.target.dataset.key;
    if (!key) return;
    const rawVal = e.target.value;
    const def    = ComponentRegistry.getById(_currentInst.defId);
    const prop   = def?.properties?.find(p=>p.key===key);

    if (prop?.type === 'number' || e.target.type === 'range') {
      _currentInst.props[key] = parseFloat(rawVal);
    } else if (prop?.type === 'boolean') {
      _currentInst.props[key] = rawVal === 'true';
    } else {
      _currentInst.props[key] = rawVal;
    }

    // Update capacitance unit display live
    if (key === 'capacitance') {
      const unitEl = document.getElementById('cap-unit-display');
      if (unitEl) unitEl.textContent = formatCapacitance(parseFloat(rawVal));
    }

    // Real-time pot wiper
    if (key === 'wiper' && AudioEngine.isRunning()) {
      AudioEngine.updatePotWiper(_currentInst);
      const valEl = document.getElementById(`rval-${key}`);
      if (valEl) valEl.textContent = Math.round(parseFloat(rawVal)*100)+'%';
    }

    Board.redraw();
    Storage.markDirty();
  }

  function hide() {
    _currentInst = null;
    _content.innerHTML = `
      <div class="props-empty">
        <i class="fa-solid fa-arrow-pointer"></i>
        <p>Select a component to edit its properties</p>
      </div>`;
  }

  return { init, show, hide };
})();
