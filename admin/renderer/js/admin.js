// ── Ryewired Admin Tool ───────────────────────────────────────────────────────

(async function initAdmin() {

  let _components  = [];   // [{ filename, def }]
  let _current     = null; // { filename, def }
  let _dirty       = false;

  // ── Boot ────────────────────────────────────────────────────────────────────
  await loadList();
  initTabs();
  initFailureHelp();

  // ── Component list ──────────────────────────────────────────────────────────

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
      item.className = 'comp-item';
      item.dataset.filename = filename;
      item.innerHTML = `
        <div class="comp-item-id">${def.label || def.id}</div>
        <div class="comp-item-cat">${def.category || '—'} · ${def.id}</div>`;
      item.addEventListener('click', () => openComponent(filename));
      el.appendChild(item);
    }
  }

  document.getElementById('comp-search').addEventListener('input', e => {
    const q = e.target.value.toLowerCase().trim();
    const filtered = q
      ? _components.filter(({ filename, def }) =>
          def.id.toLowerCase().includes(q) ||
          (def.label||'').toLowerCase().includes(q) ||
          (def.category||'').toLowerCase().includes(q))
      : _components;
    renderList(filtered);
  });

  // ── Open component ──────────────────────────────────────────────────────────

  async function openComponent(filename) {
    document.querySelectorAll('.comp-item').forEach(el =>
      el.classList.toggle('active', el.dataset.filename === filename));

    const def = await window.admin.readComponent(filename);
    _current  = { filename, def: JSON.parse(JSON.stringify(def)) };
    _dirty    = false;

    showEditor();
    populateForm(_current.def);
    syncJsonFromForm();
    updateTestPreview();
    g('save-status').textContent = '';
  }

  // ── New component ───────────────────────────────────────────────────────────

  document.getElementById('btn-new-component').addEventListener('click', () => {
    const blank = {
      id: 'new_component', label: 'New Component', category: 'passive',
      symbol: 'X', description: '', legs: 2, leg_span: 2,
      properties: [], behavior: { type: 'passthrough' }, failure_modes: {},
      visual: { body_color: '#888888', body_width: 28, body_height: 14, lead_length: 10 }
    };
    _current = { filename: 'new_component.json', def: blank };
    _dirty   = true;
    document.querySelectorAll('.comp-item').forEach(el => el.classList.remove('active'));
    showEditor(); populateForm(blank); syncJsonFromForm(); updateTestPreview();
    g('save-status').textContent = 'Unsaved';
  });

  // ── Duplicate component ─────────────────────────────────────────────────────

  document.getElementById('btn-duplicate-component').addEventListener('click', async () => {
    if (!_current) return;
    // Read current form state into a def object
    const def    = readForm();
    const baseId = def.id.replace(/_copy\d*$/, '');
    def.id       = baseId + '_copy';
    def.label    = (def.label||def.id) + ' (Copy)';
    const filename = def.id.replace(/\s+/g,'_').replace(/[^a-z0-9_]/gi,'') + '.json';
    const result   = await window.admin.saveComponent(filename, def);
    if (result.ok) {
      g('save-status').textContent = `✓ Duplicated as ${filename}`;
      setTimeout(() => { g('save-status').textContent = ''; }, 2500);
      await loadList();
      await openComponent(filename);
    }
  });

  // ── Show / hide editor ──────────────────────────────────────────────────────

  function showEditor() {
    g('editor-empty').style.display = 'none';
    g('editor-form').classList.remove('hidden');
  }

  // ── Form population ─────────────────────────────────────────────────────────

  function populateForm(def) {
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
    const el = g('props-builder');
    el.innerHTML = '';
    for (const p of props) el.appendChild(buildPropRow(p));
  }

  function buildPropRow(prop = {}) {
    const row = document.createElement('div');
    row.className = 'builder-row';
    row.innerHTML = `
      <span class="lbl">key</span>
      <input class="field" style="width:110px" placeholder="key" value="${prop.key||''}" data-field="key">
      <span class="lbl">label</span>
      <input class="field" style="width:130px" placeholder="Label" value="${prop.label||''}" data-field="label">
      <span class="lbl">type</span>
      <select class="field" style="width:100px" data-field="type">
        ${['number','select','boolean','range','audio_file'].map(t =>
          `<option value="${t}" ${prop.type===t?'selected':''}>${t}</option>`).join('')}
      </select>
      <span class="lbl">default</span>
      <input class="field" style="width:90px" placeholder="default"
        value="${prop.default!==undefined?prop.default:''}" data-field="default">
      <span class="lbl">unit</span>
      <input class="field" style="width:60px" placeholder="Ω,F,V…" value="${prop.unit||''}" data-field="unit">
      <button class="row-del" title="Remove"><i class="fa-solid fa-xmark"></i></button>`;
    row.querySelector('.row-del').addEventListener('click', () => { row.remove(); markDirty(); });
    row.querySelectorAll('input,select').forEach(el => el.addEventListener('input', markDirty));
    return row;
  }

  g('btn-add-prop').addEventListener('click', () => {
    g('props-builder').appendChild(buildPropRow()); markDirty();
  });

  // ── Failure modes builder ───────────────────────────────────────────────────

  function renderFailuresBuilder(modes) {
    const el = g('failures-builder');
    el.innerHTML = '';
    for (const [key, fm] of Object.entries(modes)) el.appendChild(buildFailureRow(key, fm));
  }

  function buildFailureRow(key = '', fm = {}) {
    const row = document.createElement('div');
    row.className = 'builder-row';
    row.innerHTML = `
      <span class="lbl">key</span>
      <input class="field" style="width:130px" placeholder="e.g. over_current"
        value="${key}" data-field="key">
      <span class="lbl">result</span>
      <select class="field" style="width:100px" data-field="result">
        ${['burn','explode','smoke','silent_fail'].map(r =>
          `<option value="${r}" ${fm.result===r?'selected':''}>${r}</option>`).join('')}
      </select>
      <span class="lbl">threshold ×</span>
      <input class="field" style="width:60px" type="number" step="0.1" placeholder="1.5"
        value="${fm.threshold_multiplier||''}" data-field="threshold_multiplier">
      <span class="lbl">message</span>
      <input class="field" style="flex:1;min-width:180px" placeholder="Plain-English explanation"
        value="${fm.message||''}" data-field="message">
      <button class="row-del" title="Remove"><i class="fa-solid fa-xmark"></i></button>`;
    row.querySelector('.row-del').addEventListener('click', () => { row.remove(); markDirty(); });
    row.querySelectorAll('input,select').forEach(el => el.addEventListener('input', markDirty));
    return row;
  }

  g('btn-add-failure').addEventListener('click', () => {
    g('failures-builder').appendChild(buildFailureRow()); markDirty();
  });

  // ── Read form → def ─────────────────────────────────────────────────────────

  function readForm() {
    const def = {
      id:          g('f-id').value.trim().replace(/\s+/g,'_'),
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
    // Preserve extra fields from original JSON
    if (_current?.def) {
      for (const k of ['color_map','model_params','footprint','spice_model','leg_labels','polarized']) {
        if (_current.def[k] !== undefined) def[k] = _current.def[k];
      }
    }
    return def;
  }

  function readPropsRows() {
    return Array.from(g('props-builder').querySelectorAll('.builder-row')).map(row => {
      const get = f => row.querySelector(`[data-field="${f}"]`)?.value || '';
      const d   = get('default');
      let dv    = d;
      if (!isNaN(d) && d !== '') dv = parseFloat(d);
      else if (d==='true') dv=true;
      else if (d==='false') dv=false;
      const p = { key: get('key'), label: get('label'), type: get('type'), default: dv };
      const u = get('unit'); if (u) p.unit = u;
      return p;
    }).filter(p => p.key);
  }

  function readFailureRows() {
    const modes = {};
    for (const row of g('failures-builder').querySelectorAll('.builder-row')) {
      const get = f => row.querySelector(`[data-field="${f}"]`)?.value || '';
      const key = get('key'); if (!key) continue;
      const fm  = { result: get('result'), message: get('message') };
      const t   = get('threshold_multiplier'); if (t) fm.threshold_multiplier = parseFloat(t);
      modes[key] = fm;
    }
    return modes;
  }

  // ── JSON tab ────────────────────────────────────────────────────────────────

  function syncJsonFromForm() {
    g('json-editor').value = JSON.stringify(readForm(), null, 2);
    g('json-status').textContent = '';
  }

  g('btn-format-json').addEventListener('click', () => {
    const r = validateJson(g('json-editor').value);
    if (r.valid) { g('json-editor').value = JSON.stringify(JSON.parse(g('json-editor').value), null, 2); g('json-status').textContent=''; }
    else          g('json-status').textContent = '✕ ' + r.error;
  });

  g('btn-apply-json').addEventListener('click', () => {
    const r = validateJson(g('json-editor').value);
    if (!r.valid) { g('json-status').textContent = '✕ ' + r.error; return; }
    const def = JSON.parse(g('json-editor').value);
    if (_current) _current.def = def;
    populateForm(def);
    g('json-status').textContent = '✓ Applied';
    setTimeout(() => g('json-status').textContent='', 2000);
    markDirty(); updateTestPreview();
  });

  g('json-editor').addEventListener('input', () => {
    const r = validateJson(g('json-editor').value);
    g('json-status').textContent = r.valid ? '' : '⚠ ' + r.error;
    markDirty();
  });

  function validateJson(str) {
    try { JSON.parse(str); return { valid:true }; }
    catch(e) { return { valid:false, error:e.message }; }
  }

  // ── Preview tab ─────────────────────────────────────────────────────────────

  function updateTestPreview() {
    const def = readForm();
    const lines = [
      `ID:           ${def.id}`,
      `Label:        ${def.label}`,
      `Category:     ${def.category}`,
      `Symbol:       ${def.symbol}`,
      `Behavior:     ${def.behavior.type}`,
      `Legs:         ${def.legs}  (span: ${def.leg_span})`,
      '',
      `Properties (${def.properties.length}):`,
      ...def.properties.map(p =>
        `  · ${p.key} [${p.type}] default=${JSON.stringify(p.default)}${p.unit?' '+p.unit:''}`),
      '',
      `Failure modes (${Object.keys(def.failure_modes).length}):`,
      ...Object.entries(def.failure_modes).map(([k,v]) =>
        `  · ${k} → ${v.result}: "${(v.message||'').slice(0,60)}…"`),
      '',
      `Visual: ${def.visual.body_width}×${def.visual.body_height}px  color: ${def.visual.body_color}`,
    ];
    g('test-preview').textContent = lines.join('\n');
  }

  // ── Tabs ────────────────────────────────────────────────────────────────────

  function initTabs() {
    document.querySelectorAll('.tab').forEach(btn => {
      btn.addEventListener('click', () => {
        const tab = btn.dataset.tab;
        document.querySelectorAll('.tab').forEach(b=>b.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c=>c.classList.add('hidden'));
        btn.classList.add('active');
        g(`tab-${tab}`).classList.remove('hidden');
        if (tab==='json') syncJsonFromForm();
        if (tab==='test') updateTestPreview();
      });
    });
  }

  // ── Dirty tracking ──────────────────────────────────────────────────────────

  function markDirty() {
    _dirty = true;
    g('save-status').textContent = 'Unsaved';
  }

  ['f-id','f-label','f-symbol','f-category','f-description',
   'f-legs','f-leg-span','f-behavior','f-body-color','f-body-width','f-body-height'
  ].forEach(id => {
    const el = g(id);
    if (el) { el.addEventListener('input', markDirty); el.addEventListener('change', markDirty); }
  });

  // ── Save ────────────────────────────────────────────────────────────────────

  g('btn-save-component').addEventListener('click', async () => {
    if (!_current) return;
    const def      = readForm();
    const filename = def.id.replace(/\s+/g,'_').replace(/[^a-z0-9_]/gi,'') + '.json';
    const result   = await window.admin.saveComponent(filename, def);
    if (result.ok) {
      _current.filename = filename; _current.def = def; _dirty = false;
      g('save-status').textContent = '✓ Saved';
      setTimeout(() => g('save-status').textContent='', 2500);
      await loadList();
      document.querySelectorAll('.comp-item').forEach(el =>
        el.classList.toggle('active', el.dataset.filename===filename));
    }
  });

  // ── Delete ──────────────────────────────────────────────────────────────────

  g('btn-delete-component').addEventListener('click', async () => {
    if (!_current) return;
    const result = await window.admin.deleteComponent(_current.filename);
    if (result.deleted) {
      _current = null;
      g('editor-empty').style.display = '';
      g('editor-form').classList.add('hidden');
      await loadList();
    }
  });

  // ── Failure help toggle ─────────────────────────────────────────────────────

  function initFailureHelp() {
    const btn  = g('btn-failure-help');
    const body = g('failure-help-body');
    if (!btn || !body) return;
    btn.addEventListener('click', () => {
      body.classList.toggle('hidden');
      const icon = btn.querySelector('i');
      if (icon) icon.className = body.classList.contains('hidden')
        ? 'fa-solid fa-circle-question'
        : 'fa-solid fa-circle-chevron-up';
    });
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  function g(id) { return document.getElementById(id); }

})();
