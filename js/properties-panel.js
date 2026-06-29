// ── Properties Panel ──────────────────────────────────────────────────────────

const PropertiesPanel = (() => {
  let _content;
  let _currentInst = null;
  let _currentWire = null;

  function init() { _content = document.getElementById('props-content'); }

  // Called by Board.onSelect(inst, wire)
  function show(inst, wire) {
    _currentInst = inst;
    _currentWire = wire;

    if (wire && !inst) { showWire(wire); return; }
    if (!inst)         { hide();         return; }
    showComponent(inst);
  }

  // ── Wire selected ───────────────────────────────────────────────────────────
  function showWire(wire) {
    _content.innerHTML = `
      <div class="prop-component-header">
        <div class="prop-component-symbol" style="background:${wire.color||'#ff9900'};border-color:${wire.color||'#ff9900'}">⌇</div>
        <div class="prop-component-info">
          <div class="prop-component-label">Jumper Wire</div>
          <div class="prop-component-id">${wire.id}</div>
        </div>
      </div>
      <div class="prop-group">
        <label class="prop-label">Color</label>
        <input class="prop-input" type="color" id="wire-color-pick" value="${wire.color||'#ff9900'}">
      </div>
      <button class="prop-delete-btn" id="prop-delete-btn">
        <i class="fa-solid fa-trash-can"></i> Remove Jumper
      </button>`;

    document.getElementById('wire-color-pick')?.addEventListener('input', e => {
      wire.color = e.target.value;
      Board.redraw(); Storage.markDirty(); History.pushDebounced();
    });

    document.getElementById('prop-delete-btn')?.addEventListener('click', () => {
      Board.deleteSelected(); hide(); Storage.markDirty();
    });
  }

  // ── Component selected ──────────────────────────────────────────────────────
  function showComponent(inst) {
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
      html += buildPropField(prop, inst.props[prop.key]);
    }

    // Flip button — shown for 2-leg polarized/asymmetric components
    const showFlip = !['ic','potentiometer'].includes(def.category) &&
                     def.id !== 'potentiometer' &&
                     (def.polarized || def.id==='diode' || def.id==='transistor_npn' || def.id==='transistor_pnp');
    if (showFlip) {
      const flipped = !!inst.flipped;
      html += `
        <div class="prop-section-div"></div>
        <div class="prop-group">
          <label class="prop-label">Orientation</label>
          <div class="prop-flip-wrap">
            <button class="prop-flip-btn ${!flipped?'active':''}" data-flip="false" title="Normal orientation">
              <i class="fa-solid fa-arrow-right-long"></i> Normal
            </button>
            <button class="prop-flip-btn ${flipped?'active':''}" data-flip="true" title="Flipped orientation">
              <i class="fa-solid fa-arrow-left-long"></i> Flipped
            </button>
          </div>
        </div>`;
    }

    html += `
      <button class="prop-delete-btn" id="prop-delete-btn">
        <i class="fa-solid fa-trash-can"></i> Remove Component
      </button>`;

    _content.innerHTML = html;

    // Flip buttons
    _content.querySelectorAll('.prop-flip-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        inst.flipped = btn.dataset.flip === 'true';
        _content.querySelectorAll('.prop-flip-btn').forEach(b =>
          b.classList.toggle('active', b.dataset.flip === String(inst.flipped)));
        Board.redraw(); Storage.markDirty(); History.push();
      });
    });

    // Property field listeners
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

  // ── Capacitance unit display ────────────────────────────────────────────────
  function formatCapacitance(v) {
    if (!v && v!==0) return '';
    v = parseFloat(v);
    if (v >= 0.001)       return (v*1000).toPrecision(3).replace(/\.?0+$/,'') + ' mF';
    if (v >= 0.000001)    return (v*1e6).toPrecision(3).replace(/\.?0+$/,'') + ' µF';
    if (v >= 0.000000001) return (v*1e9).toPrecision(3).replace(/\.?0+$/,'') + ' nF';
    return (v*1e12).toPrecision(3).replace(/\.?0+$/,'') + ' pF';
  }

  // ── Field builders ──────────────────────────────────────────────────────────
  function buildPropField(prop, value) {
    const isCap = prop.key === 'capacitance';
    switch (prop.type) {
      case 'number': {
        const badge = isCap
          ? `<span class="prop-cap-unit" id="cap-unit-display">${formatCapacitance(value)}</span>`
          : '';
        return `
          <div class="prop-group">
            <label class="prop-label">${prop.label}${badge}</label>
            <input class="prop-input" type="number" data-key="${prop.key}"
              value="${value}"
              ${prop.min!==undefined?`min="${prop.min}"`:''}
              ${prop.max!==undefined?`max="${prop.max}"`:''}
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
              ${value?'Change Audio File':'Load Audio File…'}
            </button>
            <div class="prop-audio-name">${value||''}</div>
          </div>`;
      default: return '';
    }
  }

  function onPropChange(e) {
    if (!_currentInst) return;
    const key = e.target.dataset.key;
    if (!key) return;
    const rawVal = e.target.value;
    const def  = ComponentRegistry.getById(_currentInst.defId);
    const prop = def?.properties?.find(p=>p.key===key);

    if (prop?.type==='number'||e.target.type==='range') {
      _currentInst.props[key] = parseFloat(rawVal);
    } else if (prop?.type==='boolean') {
      _currentInst.props[key] = rawVal==='true';
    } else {
      _currentInst.props[key] = rawVal;
    }

    if (key==='capacitance') {
      const u=document.getElementById('cap-unit-display');
      if (u) u.textContent=formatCapacitance(parseFloat(rawVal));
    }
    if (key==='wiper'&&AudioEngine.isRunning()) {
      AudioEngine.updatePotWiper(_currentInst);
      const v=document.getElementById(`rval-${key}`);
      if (v) v.textContent=Math.round(parseFloat(rawVal)*100)+'%';
    }

    Board.redraw(); Storage.markDirty(); History.pushDebounced();
  }

  function hide() {
    _currentInst=null; _currentWire=null;
    _content.innerHTML=`
      <div class="props-empty">
        <i class="fa-solid fa-arrow-pointer"></i>
        <p>Select a component or jumper wire to edit its properties</p>
      </div>`;
  }

  return { init, show, hide };
})();
