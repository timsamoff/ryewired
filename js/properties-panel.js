// ── Properties Panel ──────────────────────────────────────────────────────────

const PropertiesPanel = (() => {
  let _content;
  let _currentInst = null;
  let _currentWire = null;

  function init() { _content = document.getElementById('props-content'); }

  function show(inst, wire) {
    _currentInst = inst;
    _currentWire = wire;
    if (wire && !inst) { showWire(wire); return; }
    if (!inst)         { hide();         return; }
    showComponent(inst);
  }

  // ── Wire ────────────────────────────────────────────────────────────────────
  function showWire(wire) {
    _content.innerHTML = `
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
      <button class="prop-delete-btn" id="prop-delete-btn">
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

    // ── Orientation controls ─────────────────────────────────────────────────
    // Rotate: for any 2+ leg component (not IC). This is now the only
    // reorientation control — Flip has been removed in favor of Rotate 90°.
    const canRotate = def.legs >= 2 && def.category !== 'ic';

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
      <button class="prop-delete-btn" id="prop-delete-btn">
        <i class="fa-solid fa-trash-can"></i> Remove Component
      </button>`;

    _content.innerHTML = html;

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

    // Get current outer leg pixels
    const L   = inst.legs;
    const a   = Board.holeToXY(L[0].row, L[0].col);
    const b   = Board.holeToXY(L[L.length-1].row, L[L.length-1].col);
    const cx  = (a.x + b.x) / 2;
    const cy  = (a.y + b.y) / 2;
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    const newAng = ang + dir * (Math.PI / 2);
    const halfLen = Math.hypot(b.x - a.x, b.y - a.y) / 2;

    // Compute new outer leg world positions
    const newAx = cx - Math.cos(newAng) * halfLen;
    const newAy = cy - Math.sin(newAng) * halfLen;
    const newBx = cx + Math.cos(newAng) * halfLen;
    const newBy = cy + Math.sin(newAng) * halfLen;

    // Snap to nearest holes
    const holeA = Board.xyToHole(newAx, newAy, 30);
    const holeB = Board.xyToHole(newBx, newBy, 30);
    if (!holeA || !holeB) return;

    inst.legs[0] = holeA;
    inst.legs[L.length-1] = holeB;

    // For 3-leg: recompute center
    if (L.length === 3) {
      const pa = Board.holeToXY(holeA.row, holeA.col);
      const pb = Board.holeToXY(holeB.row, holeB.col);
      const mid = Board.xyToHole((pa.x+pb.x)/2, (pa.y+pb.y)/2, 20);
      if (mid) inst.legs[1] = mid;
    }

    Board.redraw(); Storage.markDirty(); History.push();
  }

  // ── Field builders ───────────────────────────────────────────────────────────
  function formatCapacitance(v) {
    if (!v && v !== 0) return '';
    v = parseFloat(v);
    if (v >= 0.001)        return (v*1000).toPrecision(3).replace(/\.?0+$/,'') + ' mF';
    if (v >= 0.000001)     return (v*1e6).toPrecision(3).replace(/\.?0+$/,'') + ' µF';
    if (v >= 0.000000001)  return (v*1e9).toPrecision(3).replace(/\.?0+$/,'') + ' nF';
    return (v*1e12).toPrecision(3).replace(/\.?0+$/,'') + ' pF';
  }

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
    const def    = ComponentRegistry.getById(_currentInst.defId);
    const prop   = def?.properties?.find(p=>p.key===key);

    if (prop?.type==='number' || e.target.type==='range') {
      _currentInst.props[key] = parseFloat(rawVal);
    } else if (prop?.type==='boolean') {
      _currentInst.props[key] = rawVal==='true';
    } else {
      _currentInst.props[key] = rawVal;
    }

    if (key==='capacitance') {
      const u = document.getElementById('cap-unit-display');
      if (u) u.textContent = formatCapacitance(parseFloat(rawVal));
    }
    if (key==='wiper') {
      const v = document.getElementById(`rval-${key}`);
      if (v) v.textContent = Math.round(parseFloat(rawVal)*100)+'%';
      if (AudioEngine.isRunning()) AudioEngine.updatePotWiper(_currentInst);
    }

    Board.redraw(); Storage.markDirty(); History.pushDebounced();
  }

  function hide() {
    _currentInst = null; _currentWire = null;
    _content.innerHTML = `
      <div class="props-empty">
        <i class="fa-solid fa-arrow-pointer"></i>
        <p>Select a component or jumper wire to edit its properties</p>
      </div>`;
  }

  return { init, show, hide };
})();