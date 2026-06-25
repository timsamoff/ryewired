// ── Properties Panel ──────────────────────────────────────────────────────────

const PropertiesPanel = (() => {
  let _content;
  let _currentInst = null;

  function init() {
    _content = document.getElementById('props-content');
  }

  function show(inst) {
    _currentInst = inst;
    if (!inst) { hide(); return; }

    const def = ComponentRegistry.getById(inst.defId);
    if (!def) return;

    let html = `
      <div class="prop-component-header">
        <div class="prop-component-symbol">${def.symbol || '?'}</div>
        <div class="prop-component-info">
          <div class="prop-component-label">${def.label}</div>
          <div class="prop-component-id">${inst.instanceId}</div>
        </div>
      </div>`;

    for (const prop of (def.properties || [])) {
      html += buildPropField(prop, inst.props[prop.key]);
    }

    if (def.orientation !== 'fixed') {
      html += `
        <div class="prop-section-div"></div>
        <div class="prop-group">
          <label class="prop-label">Orientation</label>
          <div class="prop-orientation-wrap">
            <button class="prop-orient-btn ${inst.orientation === 'horizontal' ? 'active' : ''}"
              data-orient="horizontal">Horizontal</button>
            <button class="prop-orient-btn ${inst.orientation === 'vertical' ? 'active' : ''}"
              data-orient="vertical">Vertical</button>
          </div>
        </div>`;
    }

    html += `
      <button class="prop-delete-btn" id="prop-delete-btn">
        <i class="fa-solid fa-trash-can"></i> Remove Component
      </button>`;

    _content.innerHTML = html;

    // Orientation buttons
    _content.querySelectorAll('.prop-orient-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        _currentInst.orientation = btn.dataset.orient;
        _content.querySelectorAll('.prop-orient-btn').forEach(b =>
          b.classList.toggle('active', b.dataset.orient === btn.dataset.orient));
        Board.redraw();
        Storage.markDirty();
      });
    });

    // Property field change handlers
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
      Board.deleteSelected();
      hide();
      Storage.markDirty();
    });
  }

  function buildPropField(prop, value) {
    switch (prop.type) {
      case 'number':
        return `
          <div class="prop-group">
            <label class="prop-label">${prop.label}</label>
            <input class="prop-input" type="number" data-key="${prop.key}"
              value="${value}"
              ${prop.min !== undefined ? `min="${prop.min}"` : ''}
              ${prop.max !== undefined ? `max="${prop.max}"` : ''}
              step="any">
          </div>`;

      case 'select': {
        const opts = prop.options.map(o =>
          `<option value="${o}" ${o === value ? 'selected' : ''}>${o}</option>`
        ).join('');
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
              <option value="true"  ${value ? 'selected' : ''}>Yes</option>
              <option value="false" ${!value ? 'selected' : ''}>No</option>
            </select>
          </div>`;

      case 'range':
        return `
          <div class="prop-group">
            <label class="prop-label">${prop.label}</label>
            <div class="prop-range-wrap">
              <input type="range" data-key="${prop.key}"
                min="${prop.min}" max="${prop.max}" step="${prop.step}" value="${value}">
              <span class="prop-range-value" id="rval-${prop.key}">${Math.round(value * 100)}%</span>
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
            <div class="prop-audio-name">${value || ''}</div>
          </div>`;

      default:
        return '';
    }
  }

  function onPropChange(e) {
    if (!_currentInst) return;
    const key   = e.target.dataset.key;
    if (!key) return;

    const rawVal = e.target.value;
    const def    = ComponentRegistry.getById(_currentInst.defId);
    const prop   = def?.properties?.find(p => p.key === key);

    if (prop?.type === 'number' || e.target.type === 'range') {
      _currentInst.props[key] = parseFloat(rawVal);
    } else if (prop?.type === 'boolean') {
      _currentInst.props[key] = rawVal === 'true';
    } else {
      _currentInst.props[key] = rawVal;
    }

    // Real-time pot wiper
    if (key === 'wiper' && AudioEngine.isRunning()) {
      AudioEngine.updatePotWiper(_currentInst);
      const valEl = document.getElementById(`rval-${key}`);
      if (valEl) valEl.textContent = Math.round(parseFloat(rawVal) * 100) + '%';
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
