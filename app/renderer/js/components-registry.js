// ── Component Registry ────────────────────────────────────────────────────────

const ComponentRegistry = (() => {
  let _definitions = [];

  const CATEGORY_ORDER = ['power', 'source', 'passive', 'semiconductor', 'switch', 'ic'];
  const CATEGORY_LABELS = {
    power:         'Power',
    source:        'Signal Sources',
    passive:       'Passives',
    semiconductor: 'Semiconductors',
    switch:        'Switches',
    ic:            'ICs'
  };

  async function load() {
    _definitions = await Storage.loadAllComponents();
    _definitions.sort((a, b) => {
      const ai = CATEGORY_ORDER.indexOf(a.category);
      const bi = CATEGORY_ORDER.indexOf(b.category);
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    });
    console.log(`[Registry] Loaded ${_definitions.length} component definitions`);
  }

  function getAll()    { return _definitions; }
  function getById(id) { return _definitions.find(d => d.id === id) || null; }

  function search(query) {
    const q = query.toLowerCase().trim();
    if (!q) return _definitions;
    return _definitions.filter(d =>
      d.label.toLowerCase().includes(q) ||
      d.description.toLowerCase().includes(q) ||
      d.id.toLowerCase().includes(q) ||
      (d.symbol || '').toLowerCase().includes(q)
    );
  }

  function createInstance(defId, row, col) {
    const def = getById(defId);
    if (!def) throw new Error(`Unknown component: ${defId}`);
    const props = {};
    for (const p of (def.properties || [])) props[p.key] = p.default;
    return {
      instanceId:  Utils.uid(def.symbol || 'C'),
      defId,
      row,
      col,
      orientation: def.orientation || 'horizontal',
      props,
      failed:      false,
      failureType: null,
      _voltage:    0,
      _current:    0,
      _audioNode:  null
    };
  }

  return { load, getAll, getById, search, createInstance, CATEGORY_LABELS };
})();
