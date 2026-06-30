// ── Component Registry ────────────────────────────────────────────────────────

const ComponentRegistry = (() => {
  let _defs = [];

  const CATEGORY_ORDER  = ['power','source','passive','semiconductor','switch','ic'];
  const CATEGORY_LABELS = {
    power:'Power', source:'Signal Sources', passive:'Passives',
    semiconductor:'Semiconductors', switch:'Switches', ic:'ICs'
  };

  async function load() {
    _defs = await Storage.loadAllComponents();
    _defs.sort((a,b) => {
      const ai=CATEGORY_ORDER.indexOf(a.category), bi=CATEGORY_ORDER.indexOf(b.category);
      return (ai===-1?99:ai)-(bi===-1?99:bi);
    });
    console.log(`[Registry] Loaded ${_defs.length} components`);
  }

  function getAll()    { return _defs; }
  function getById(id) { return _defs.find(d=>d.id===id)||null; }

  function search(q) {
    q = q.toLowerCase().trim();
    if (!q) return _defs;
    return _defs.filter(d =>
      d.label.toLowerCase().includes(q) ||
      d.description.toLowerCase().includes(q) ||
      d.id.toLowerCase().includes(q) ||
      (d.symbol||'').toLowerCase().includes(q));
  }

  /**
   * Create a placed instance.
   * inst.legs = array of { row, col } — one per physical leg.
   *
   * For 2-leg components: legs span `leg_span` holes horizontally.
   * For 3-leg components: outer legs at 0 and leg_span, center leg at midpoint.
   *   e.g. transistor: leg_span=2 → legs at col, col+1, col+2
   *   e.g. potentiometer: leg_span=4 → legs at col, col+2, col+4
   */
  function createInstance(defId, row, col) {
    const def = getById(defId);
    if (!def) throw new Error(`Unknown component: ${defId}`);

    const props = {};
    for (const p of (def.properties||[])) props[p.key] = p.default;

    const span     = def.leg_span || 1;
    const legCount = def.legs     || 2;
    const legs     = buildLegs(legCount, span, row, col);

    return {
      instanceId:  Utils.uid(def.symbol||'C'),
      defId,
      legs,
      flipped:     false,
      props,
      failed:      false,
      failureType: null,
      _voltage:    0, _current: 0, _audioNode: null
    };
  }

  function buildLegs(count, span, row, col) {
    if (count === 2) {
      return [
        { row, col },
        { row, col: clampCol(col + span) }
      ];
    }
    if (count === 3) {
      // Left outer, center, right outer
      // Center is at the midpoint of the span
      const mid = Math.round(span / 2);
      return [
        { row, col: clampCol(col) },
        { row, col: clampCol(col + mid) },
        { row, col: clampCol(col + span) }
      ];
    }
    // Generic: spread evenly
    const legs = [];
    for (let i = 0; i < count; i++) {
      legs.push({ row, col: clampCol(col + Math.round(i * span / (count-1))) });
    }
    return legs;
  }

  function clampCol(col) { return Math.max(0, Math.min(62, col)); }

  return { load, getAll, getById, search, createInstance, CATEGORY_LABELS };
})();
