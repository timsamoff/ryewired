// ── Admin Tool JS ─────────────────────────────────────────────────────────────

(async function initAdmin() {

  let _components = [];   // [{ filename, def }]
  let _current    = null; // { filename, def } currently loaded in editor
  let _dirty      = false;

  // ── Load list ───────────────────────────────────────────────────────────────

  async function loadList() {
    _components = await window.admin.listComponents();
    renderList(_components);
    document.getElementById('comp-count').textContent = _components.length;
  }

  function renderList(list) {
    const el = document.getElementById('comp-list');
    el.innerHTML = '';
    for (const { filename, def } of list) {
      const item = document.createElement('div');
      item.className   = 'comp-item';
      item.dataset.filename = filename;
      item.innerHTML   = `
        <div class="comp-item-id">${def.label || def.id}</div>
        <div class="comp-item-cat">${def.category || '—'} · ${def.id}</div>`;
      item.addEventListener('click', () => openComponent(filename));
      el.appendChild(item);
    }
  }

  // ── Search ──────────────────────────────────────────────────────────────────

  document.getElementById('comp-search').addEventListener('input', e => {
    const q = e.target.value.toLowerCase().trim();
    const filtered = q
      ? _components.filter(({ filename, def }) =>
          def.id.toLowerCase().includes(q) ||
          (def.label || '').toLowerCase().includes(q) ||
          (def.category || '').toLowerCase().includes(q))
      : _components;
    renderList(filtered);
  });

  // ── Open component ──────────────────────────────────────────────────────────

  async function openComponent(filename) {
    // Highlight in list
    document.querySelectorAll('.comp-item').forEach(el => {
      el.classList.toggle('active', el.dataset.filename === filename);
    });

    const def = await window.admin.readComponent(filename);
    _current  = { filename, def: JSON.parse(JSON.stringify(def)) };
    _dirty    = false;

    showEditor();
    populateForm(_current.def, filename);
    syncJsonFromForm();
    updateTestPreview();
    document.getElementById('save-status').textContent = '';
  }

  // ── New component ───────────────────────────────────────────────────────────

  document.getElementById('btn-new-component').addEventListener('click', () => {
    const blank = {
      id: 'new_component',
      label: 'New Component',
      category: 'passive',
      symbol: 'X',
      description: '',
      legs: 2,
      leg_span: 2,
      properties: [],
      behavior: { type: 'passthrough' },
      failure_modes: {},
      visual: { body_color: '#888888', body_width: 28, body_height: 14, lead_length: 10 }
    };
    _current  = { filename: 'new_component.json', def: blank };
    _dirty    = true;

    document.querySelectorAll('.comp-item').forEach(el => el.classList.remove('active'));
    showEditor();
    populateForm(blank, 'new_component.json');
    syncJsonFromForm();
    updateTestPreview();
    document.getElementById('save-status').textContent = 'Unsaved';
  });

  // ── Show/hide editor ────────────────────────────────────────────────────────

  function showEditor() {
    document.getElementById('editor-empty').style.display = 'none';
    document.getElementById('editor-form').classList.remove('hidden');
  }

  // ── Populate form from def ──────────────────────────────────────────────────

  function populateForm(def, filename) {
    g('f-id').value          = def.id || '';
    g('f-label').value       = def.label || '';
    g('f-symbol').value      = def.symbol || '';
    g('f-category').value    = def.category || 'passive';
    g('f-description').value = def.description || '';
    g('f-legs').value        = def.legs || 2;
    g('f-leg-span').value    = def.leg_span || 2;
    g('f-behavior').value    = def.behavior?.type || 'passthrough';
    g('f-body-color').value  = def.visual?.body_color || '#888888';
    g('f-body-width').value  = def.visual?.body_width || 28;
    g('f-body-height').value = def.visual?.body_height || 14;

    renderPropsBuilder(def.properties || []);
    renderFailuresBuilder(def.failure_modes || {});
  }

  // ── Properties builder ──────────────────────────────────────────────────────

  function renderPropsBuilder(props) {
    const el = document.getElementById('props-builder');
    el.innerHTML = '';
    for (const prop of props) {
      el.appendChild(buildPropRow(prop));
    }
  }

  function buildPropRow(prop = {}) {
    const row = document.createElement('div');
    row.className = 'builder-row';
    row.innerHTML = `
      <span class="lbl">key</span>
      <input class="field" style="width:110px" placeholder="key" value="${prop.key || ''}" data-field="key">
      <span class="lbl">label</span>
      <input class="field" style="width:130px" placeholder="Label" value="${prop.label || ''}" data-field="label">
      <span class="lbl">type</span>
      <select class="field" style="width:100px" data-field="type">
        ${['number','select','boolean','range','audio_file'].map(t =>
          `<option value="${t}" ${prop.type === t ? 'selected' : ''}>${t}</option>`
        ).join('')}
      </select>
      <span class="lbl">default</span>
      <input class="field" style="width:90px" placeholder="default" value="${prop.default !== undefined ? prop.default : ''}" data-field="default">
      <span class="lbl">unit</span>
      <input class="field" style="width:60px" placeholder="Ω,F,V…" value="${prop.unit || ''}" data-field="unit">
      <button class="row-del" title="Remove">✕</button>`;

    row.querySelector('.row-del').addEventListener('click', () => {
      row.remove();
      markDirty();
    });
    row.querySelectorAll('input,select').forEach(el => el.addEventListener('input', markDirty));
    return row;
  }

  document.getElementById('btn-add-prop').addEventListener('click', () => {
    document.getElementById('props-builder').appendChild(buildPropRow());
    markDirty();
  });

  // ── Failure modes builder ───────────────────────────────────────────────────

  function renderFailuresBuilder(modes) {
    const el = document.getElementById('failures-builder');
    el.innerHTML = '';
    for (const [key, fm] of Object.entries(modes)) {
      el.appendChild(buildFailureRow(key, fm));
    }
  }

  function buildFailureRow(key = '', fm = {}) {
    const row = document.createElement('div');
    row.className = 'builder-row';
    row.innerHTML = `
      <span class="lbl">mode key</span>
      <input class="field" style="width:120px" placeholder="e.g. over_current" value="${key}" data-field="key">
      <span class="lbl">result</span>
      <select class="field" style="width:100px" data-field="result">
        ${['burn','explode','smoke','silent_fail'].map(r =>
          `<option value="${r}" ${fm.result === r ? 'selected' : ''}>${r}</option>`
        ).join('')}
      </select>
      <span class="lbl">threshold ×</span>
      <input class="field" style="width:60px" type="number" step="0.1" placeholder="1.5" value="${fm.threshold_multiplier || ''}" data-field="threshold_multiplier">
      <span class="lbl">message</span>
      <input class="field" style="flex:1;min-width:180px" placeholder="Explanation shown to user" value="${fm.message || ''}" data-field="message">
      <button class="row-del" title="Remove">✕</button>`;

    row.querySelector('.row-del').addEventListener('click', () => {
      row.remove();
      markDirty();
    });
    row.querySelectorAll('input,select').forEach(el => el.addEventListener('input', markDirty));
    return row;
  }

  document.getElementById('btn-add-failure').addEventListener('click', () => {
    document.getElementById('failures-builder').appendChild(buildFailureRow());
    markDirty();
  });

  // ── Read form → def object ──────────────────────────────────────────────────

  function readForm() {
    const def = {
      id:          g('f-id').value.trim().replace(/\s+/g, '_'),
      label:       g('f-label').value.trim(),
      category:    g('f-category').value,
      symbol:      g('f-symbol').value.trim(),
      description: g('f-description').value.trim(),
      legs:        parseInt(g('f-legs').value) || 2,
      leg_span:    parseInt(g('f-leg-span').value) || 2,
      properties:  readPropsRows(),
      behavior:    { type: g('f-behavior').value },
      failure_modes: readFailureRows(),
      visual: {
        body_color:  g('f-body-color').value,
        body_width:  parseInt(g('f-body-width').value) || 28,
        body_height: parseInt(g('f-body-height').value) || 14,
        lead_length: _current?.def?.visual?.lead_length || 10
      }
    };

    // Preserve any extra fields the maintainer added directly in JSON
    if (_current?.def) {
      const extra = ['color_map','model_params','footprint','spice_model','leg_labels','polarized'];
      for (const k of extra) {
        if (_current.def[k] !== undefined) def[k] = _current.def[k];
      }
    }

    return def;
  }

  function readPropsRows() {
    const rows = document.querySelectorAll('#props-builder .builder-row');
    return Array.from(rows).map(row => {
      const get = f => row.querySelector(`[data-field="${f}"]`)?.value || '';
      const def_ = get('default');
      let defaultVal = def_;
      if (!isNaN(def_) && def_ !== '') defaultVal = parseFloat(def_);
      else if (def_ === 'true') defaultVal = true;
      else if (def_ === 'false') defaultVal = false;
      const prop = {
        key:     get('key'),
        label:   get('label'),
        type:    get('type'),
        default: defaultVal
      };
      const unit = get('unit');
      if (unit) prop.unit = unit;
      return prop;
    }).filter(p => p.key);
  }

  function readFailureRows() {
    const rows = document.querySelectorAll('#failures-builder .builder-row');
    const modes = {};
    for (const row of rows) {
      const get = f => row.querySelector(`[data-field="${f}"]`)?.value || '';
      const key = get('key');
      if (!key) continue;
      const fm = { result: get('result'), message: get('message') };
      const thresh = get('threshold_multiplier');
      if (thresh) fm.threshold_multiplier = parseFloat(thresh);
      modes[key] = fm;
    }
    return modes;
  }

  // ── JSON tab ────────────────────────────────────────────────────────────────

  function syncJsonFromForm() {
    const def = readForm();
    g('json-editor').value = JSON.stringify(def, null, 2);
    g('json-status').textContent = '';
  }

  g('btn-format-json').addEventListener('click', () => {
    const raw = g('json-editor').value;
    const result = validateJson(raw);
    if (result.valid) {
      g('json-editor').value = JSON.stringify(JSON.parse(raw), null, 2);
      g('json-status').textContent = '';
    } else {
      g('json-status').textContent = result.error;
    }
  });

  g('btn-apply-json').addEventListener('click', () => {
    const raw = g('json-editor').value;
    const result = validateJson(raw);
    if (!result.valid) {
      g('json-status').textContent = '✕ ' + result.error;
      return;
    }
    const def = JSON.parse(raw);
    if (_current) _current.def = def;
    populateForm(def, _current?.filename || 'component.json');
    g('json-status').textContent = '✓ Applied';
    setTimeout(() => g('json-status').textContent = '', 2000);
    markDirty();
    updateTestPreview();
  });

  g('json-editor').addEventListener('input', () => {
    const raw = g('json-editor').value;
    const result = validateJson(raw);
    g('json-status').textContent = result.valid ? '' : '⚠ ' + result.error;
    markDirty();
  });

  function validateJson(str) {
    try { JSON.parse(str); return { valid: true }; }
    catch (e) { return { valid: false, error: e.message }; }
  }

  // ── Test preview ────────────────────────────────────────────────────────────

  function updateTestPreview() {
    const def = readForm();
    const summary = [
      `ID:          ${def.id}`,
      `Label:       ${def.label}`,
      `Category:    ${def.category}`,
      `Symbol:      ${def.symbol}`,
      `Behavior:    ${def.behavior.type}`,
      `Legs:        ${def.legs}  (span: ${def.leg_span})`,
      '',
      `Properties (${def.properties.length}):`,
      ...def.properties.map(p => `  · ${p.key} [${p.type}] default=${JSON.stringify(p.default)}${p.unit ? ' ' + p.unit : ''}`),
      '',
      `Failure modes (${Object.keys(def.failure_modes).length}):`,
      ...Object.entries(def.failure_modes).map(([k, v]) => `  · ${k} → ${v.result}: "${v.message?.slice(0, 60)}…"`),
      '',
      `Visual: ${def.visual.body_width}×${def.visual.body_height}px  color: ${def.visual.body_color}`,
    ].join('\n');

    g('test-preview').textContent = summary;
  }

  // ── Tabs ────────────────────────────────────────────────────────────────────

  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.add('hidden'));
      btn.classList.add('active');
      document.getElementById(`tab-${tab}`).classList.remove('hidden');

      if (tab === 'json')   syncJsonFromForm();
      if (tab === 'test')   updateTestPreview();
    });
  });

  // ── Form → dirty tracking ───────────────────────────────────────────────────

  function markDirty() {
    _dirty = true;
    g('save-status').textContent = 'Unsaved';
  }

  // Track changes on all core form fields
  ['f-id','f-label','f-symbol','f-category','f-description',
   'f-legs','f-leg-span','f-behavior','f-body-color','f-body-width','f-body-height'
  ].forEach(id => {
    g(id).addEventListener('input', markDirty);
    g(id).addEventListener('change', markDirty);
  });

  // ── Save ────────────────────────────────────────────────────────────────────

  g('btn-save-component').addEventListener('click', async () => {
    if (!_current) return;
    const def = readForm();

    // Derive filename from id
    const filename = def.id.replace(/\s+/g, '_').replace(/[^a-z0-9_]/gi, '') + '.json';
    const result   = await window.admin.saveComponent(filename, def);

    if (result.ok) {
      _current.filename = filename;
      _current.def      = def;
      _dirty            = false;
      g('save-status').textContent = '✓ Saved';
      setTimeout(() => g('save-status').textContent = '', 2500);
      await loadList();
      // Re-highlight
      document.querySelectorAll('.comp-item').forEach(el => {
        el.classList.toggle('active', el.dataset.filename === filename);
      });
    }
  });

  // ── Delete ──────────────────────────────────────────────────────────────────

  g('btn-delete-component').addEventListener('click', async () => {
    if (!_current) return;
    const result = await window.admin.deleteComponent(_current.filename);
    if (result.deleted) {
      _current = null;
      document.getElementById('editor-empty').style.display = '';
      document.getElementById('editor-form').classList.add('hidden');
      await loadList();
    }
  });

  // ── Helpers ─────────────────────────────────────────────────────────────────

  function g(id) { return document.getElementById(id); }

  // ── Boot ────────────────────────────────────────────────────────────────────
  await loadList();

})();
