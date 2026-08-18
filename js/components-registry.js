// ── Component Registry ────────────────────────────────────────────────────────

const ComponentRegistry = (() => {
  let _defs = [];

  const CATEGORY_ORDER  = ['power','source','passive','semiconductor','switch','ic'];
  // Resolved through I18n on read (categoryLabel below), not stored
  // pre-translated — these are static app-chrome keys, not component data,
  // so they live under the "app." namespace rather than "component.".
  const CATEGORY_LABEL_KEYS = {
    power:'app.category.power', source:'app.category.source', passive:'app.category.passive',
    semiconductor:'app.category.semiconductor', switch:'app.category.switch', ic:'app.category.ic'
  };
  function categoryLabel(cat) { return I18n.t(CATEGORY_LABEL_KEYS[cat] || cat); }

  // Second-level grouping within a category — currently only "ic" uses this
  // (linear/timer/logic), since it's the one category expected to hold
  // behaviorally distinct component families. Falls back to the raw
  // subcategory string if no key is registered, same pattern as categoryLabel.
  const SUBCATEGORY_LABEL_KEYS = {
    linear:'app.subcategory.linear', timer:'app.subcategory.timer', logic:'app.subcategory.logic'
  };
  function subcategoryLabel(sub) { return I18n.t(SUBCATEGORY_LABEL_KEYS[sub] || sub); }

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
    // Searches against the RESOLVED (translated) text, not the labelKey/
    // descriptionKey — a user typing "resistor" needs to find it regardless
    // of what internal key backs that string. I18n.t() is cheap (a Map
    // lookup) so resolving per search call rather than caching is fine at
    // this component count.
    return _defs.filter(d =>
      I18n.t(d.labelKey).toLowerCase().includes(q) ||
      I18n.t(d.descriptionKey).toLowerCase().includes(q) ||
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
    // Note: power_supply's default vertical orientation is applied in
    // board.js's onDrop, not here — that needs real pixel/hole math
    // (to correctly handle drops directly onto a rail) that this module,
    // which only deals in row/col numbers, doesn't have access to.

    const inst = {
      instanceId:  Utils.uid(def.symbol||'C'),
      defId,
      legs,
      props,
      failed:      false,
      failureType: null,
      _voltage:    0, _current: 0, _audioNode: null
    };
    applyModelDefaults(inst);
    applyToleranceRoll(inst, def);
    return inst;
  }

  // Syncs the model-derived fields (hfe, leakage) to whichever model is
  // currently selected on this instance — called once at placement (so a
  // freshly-dropped part starts with its actual rated values, not a generic
  // schema default) and again whenever the model dropdown changes (so
  // switching models always shows and uses that model's real numbers,
  // overwriting any prior custom value — a custom hfe/leakage belongs to the
  // model it was set under, not to whatever gets picked next).
  function applyModelDefaults(inst) {
    const def = getById(inst.defId);
    const pm  = def?.model_params?.[inst.props.model];
    if (!pm) return;
    if ((def.properties||[]).some(p => p.key==='hfe') && pm.hfe != null) {
      inst.props.hfe = pm.hfe;
    }
    if ((def.properties||[]).some(p => p.key==='leakage')) {
      const leak = pm.icbo_na ?? pm.leakage_ua;
      if (leak != null) {
        inst.props.leakage = leak;
        // Silicon's leakage is naturally tiny (tens of nA) and reads fine
        // in nA; germanium's is orders of magnitude larger and is what
        // pedal builders actually discuss in µA — default the display
        // unit to whichever keeps the number in a sane, familiar range.
        inst.props.leakage__unit = leak >= 1000 ? 'µA' : 'nA';
      }
    }
    if ((def.properties||[]).some(p => p.key==='zener_voltage') && pm.vz != null) {
      inst.props.zener_voltage = pm.vz;
    }
  }

  // Resolves a component's real, simulated value from its nominal value +
  // tolerance class, once, the same way a real part's actual value is fixed
  // the moment it's manufactured — not re-rolled every time the circuit is
  // powered on. Generalizes to any component whose schema has both a
  // 'tolerance' select and a value_unit property (currently resistor,
  // capacitor, capacitor_electrolytic) rather than hardcoding those keys by
  // name, so a future tolerant part type just needs the same two fields.
  //
  // The resolved value is stored as `<key>_actual` — a plain prop, NOT
  // listed in the component's own `properties` schema, so the properties
  // panel never renders an input for it (kept deliberately hidden — real
  // component tolerance means you'd need a multimeter to know the true
  // value, you don't get to just read it off the part) but still an
  // ordinary part of inst.props, so it saves/loads with the rest of the
  // circuit like any other value — a saved build stays the same build.
  //
  // v1 uses a uniform random distribution within ±tolerance% (matches what
  // the spec literally promises); real parts cluster nearer nominal than a
  // uniform draw would, a bell-curve distribution is a reasonable future
  // refinement, not needed to be right immediately.
  function applyToleranceRoll(inst, def) {
    if (!(def.properties||[]).some(p => p.key==='tolerance')) return;
    const valueProp = (def.properties||[]).find(p => p.type==='value_unit' && p.key!=='tolerance');
    if (!valueProp) return;
    const nominal = parseFloat(inst.props[valueProp.key]);
    if (!Number.isFinite(nominal)) return;
    const tolPct = parseFloat(inst.props.tolerance) || 5;
    const factor = 1 + (Math.random()*2 - 1) * (tolPct/100);
    inst.props[valueProp.key+'_actual'] = nominal * factor;
  }

  // Re-rolls a component's resolved value against its CURRENT nominal value
  // and tolerance class — the "swap this part for another one out of the
  // same batch" action, exposed as a small reroll control in the properties
  // panel next to the Tolerance field.
  function rerollTolerance(inst) {
    const def = getById(inst.defId);
    if (def) applyToleranceRoll(inst, def);
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
    if (count === 8) return buildDipLegs(row, col, 4); // DIP-8 dual-op-amp package — see buildDipLegs
    if (count === 16) return buildDipLegs(row, col, 8); // DIP-16 (PT2399) — same real-DIP pin geometry, doubled
    // Generic: spread evenly
    const legs = [];
    for (let i = 0; i < count; i++) {
      legs.push({ row, col: clampCol(col + Math.round(i * span / (count-1))) });
    }
    return legs;
  }

  // DIP-8 package leg layout, straddling the center channel exactly like a
  // real chip does on a physical breadboard. `row` is the anchor (pin 1's
  // row, always in the bottom half 0-4 — rows 5-9 is the other half); `col`
  // is pin 1's column.
  //
  // Real DIP-8 pin order (verified against IC pin-numbering convention,
  // notch-left): pins 1-4 run left-to-right along the bottom row, pin 5
  // continues at top-right, pins 5-8 run right-to-left along the top row
  // (pin 8 sits directly above pin 1). This board's columns ascend LEFT TO
  // RIGHT on screen (verified directly against board.js's holeX(col), which
  // increases with col), so "left-to-right" for the pin sequence maps to
  // ASCENDING column number as pin number increases. legs[0..3] are pins
  // 1-4 at col, col-1, col-2, col-3 — i.e. anchored with pin 1 at the
  // HIGHEST column of the four (the rightmost on screen) and descending
  // from there, matching the code below (col-i, not col+i) regardless of
  // which screen direction "ascending column" turned out to mean; pin 1's
  // exact screen position doesn't matter for correctness, only that every
  // pin's column-to-pin-number mapping stays internally consistent, which
  // this does. legs[4] (pin 5) sits directly above legs[3] (pin 4), and
  // legs[4..7] continue back to directly above legs[0] (pin 8 above pin 1).
  function buildDipLegs(row, col, perSide) {
    // Always straddles the board's one and only center channel — rows 4 and
    // 9 are the two rows flanking it, NOT 4 and 5. Verified directly
    // against board.js's buildLayout(): row 5's y is assigned FIRST in the
    // r=5..9 loop (so row 5 sits nearest the TOP RAIL, farthest from the
    // channel) and row 9 is assigned LAST in that same loop (nearest the
    // channel, right where DIP_GAP begins) — row 5 is the top half's row
    // "a" in board-display terms (rowDisplayLabel), not the one adjacent
    // to the gap. An earlier version of this function used topRow=5, which
    // is wrong: it made a placed DIP-8's leads stretch the FULL height of
    // both half-grids (row 5 down through row 9's channel edge on top,
    // row 4 down through row 0 on the bottom) instead of one row on each
    // side of the gap, caught by comparing a live screenshot against the
    // intended one-row-of-leads look.
    const bottomRow = 4, topRow = 9;
    const legs = [];
    for (let i = 0; i < perSide; i++) legs.push({ row: bottomRow, col: clampCol(col - i) }); // pins 1..perSide
    for (let i = 0; i < perSide; i++) legs.push({ row: topRow, col: clampCol(col - (perSide - 1 - i)) }); // pins perSide+1..2*perSide, mirrored back over the same columns
    return legs;
  }

  function clampCol(col) { return Math.max(0, Math.min(62, col)); }

  return { load, getAll, getById, search, createInstance, applyModelDefaults, rerollTolerance, categoryLabel, subcategoryLabel };
})();