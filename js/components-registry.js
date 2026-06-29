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
   * Create a placed instance. Builds the `legs` array from the drop position.
   * leg_span tells us how many holes apart the outer legs are.
   * legs array: one entry per physical leg, each { row, col }.
   */
  function createInstance(defId, row, col) {
    const def = getById(defId);
    if (!def) throw new Error(`Unknown component: ${defId}`);

    const props = {};
    for (const p of (def.properties||[])) props[p.key] = p.default;

    const span = (def.leg_span||2) - 1;
    const legs = buildLegs(def, row, col, span);

    return {
      instanceId: Utils.uid(def.symbol||'C'),
      defId,
      legs,
      flipped:   false,
      props,
      failed:    false,
      failureType: null,
      _voltage:  0, _current: 0, _audioNode: null
    };
  }

  function buildLegs(def, row, col, span) {
    const legCount = def.legs || 2;
    if (legCount === 2) {
      return [
        { row, col },
        { row, col: Math.min(62, col + span) }
      ];
    }
    if (legCount === 3) {
      // e.g. transistor: leg0=left, leg1=center, leg2=right
      const mid = Math.min(62, col + Math.floor(span / 2));
      const end = Math.min(62, col + span);
      return [
        { row, col },
        { row, col: mid },
        { row, col: end }
      ];
    }
    // Generic: spread legs evenly across span
    const legs = [];
    for (let i = 0; i < legCount; i++) {
      legs.push({ row, col: Math.min(62, col + Math.round(i * span / (legCount-1))) });
    }
    return legs;
  }

  return { load, getAll, getById, search, createInstance, CATEGORY_LABELS };
})();
