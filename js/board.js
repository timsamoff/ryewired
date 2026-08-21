// ── Board Canvas Renderer ─────────────────────────────────────────────────────
// Key model: inst.legs[] = [{row,col},...] per physical leg.
// instGeometry() derives center, angle, and length from legs[0] and legs[last].
// Leads ALWAYS stretch from body edge to actual leg hole — no fixed length gap.

const Board = (() => {

  const COLS         = 63;
  const HOLE_PITCH   = 20;
  const GROUP_GAP    = 6;
  const HOLE_R       = 3.2;
  const ROW_LABELS   = ['a','b','c','d','e','f','g','h','i','j'];
  const ROW_LABELS_DISPLAY = [...ROW_LABELS].reverse(); // bottom-half (rows 0-4) display order, top-to-bottom: f,g,h,i,j — cosmetic only, internal row indices are untouched
  // Top half (rows 5-9) reads top-to-bottom as row index increases (row5 is
  // physically topmost, row9 sits just above the center gap — see rowY()),
  // so it needs a-e in that same increasing direction, NOT the reversed
  // array used for the bottom half.
  function rowDisplayLabel(r){ return r>=5 ? ROW_LABELS[r-5] : ROW_LABELS_DISPLAY[r]; }
  const ML=52, MR=52, MT=14, MB=14;
  const RAIL_PAD_V   = 10;
  const RAIL_STRIP_H = 2*HOLE_PITCH+RAIL_PAD_V*2;
  const RAIL_TO_GRID = 10;
  const DIP_GAP      = 18;
  // External Switches panel — a genuinely SEPARATE surface in the dark
  // canvas background below the board, not an extension of the board's own
  // hole grid (an earlier version of this tried that; it read as "more
  // board," not as an external/off-board area, and per direct feedback that
  // was the wrong metaphor entirely). No board coordinates apply here at
  // all: switches snap to an INVISIBLE uniform grid of slots (one switch
  // per slot, sized to fit the largest switch — a 3PDT — so every slot is
  // the same size regardless of which switch occupies it), and each
  // switch's own body renders its real pins as the actual wire-snap points,
  // not board holes underneath it.
  const EXT_GAP_ABOVE  = 5;  // true empty gap between the board's bottom edge and the panel's top edge
  // How far the panel's FILL (not its layout — panelTop/label position are
  // untouched) extends upward, drawn behind the board so no seam or rounded
  // corner shows at the top — same idea as workbench-strip.js's OVERLAP=16
  // at the board's other edge. Generous margin past EXT_GAP_ABOVE (5) so
  // the extension is safely tucked behind the board's own rounded bottom
  // corners at every board width, not just barely covering the gap.
  const EXT_EXTEND_UP = 24;
  const EXT_SLOT_ROWS  = 3;  // how many slot-rows tall the panel starts at (tune after seeing it, per direct instruction)
  const EXT_PANEL_PAD  = 12; // inner padding between the panel's rounded edge and the first/last slot
  const EXT_LABEL_H    = 20; // space reserved for the "External Switches" heading inside the panel
  // A switch's own pin pitch reuses HOLE_PITCH so a jumper from a board hole
  // to a switch pin doesn't visually change scale mid-run. Every switch
  // renders its OWN body sized to its real (rows,cols) pin-grid shape (see
  // switchShape/drawSwitchInst) — SW_BODY_W/SW_BODY_H below are ONLY the
  // largest possible shape (3PDT, 3x3), used purely to size the uniform
  // slot grid every switch snaps into (per direct instruction: every switch
  // gets a slot this size regardless of its own real footprint, so smaller
  // switches sit centered with breathing room rather than the grid
  // resizing per switch) — they are NOT what gets drawn for a smaller
  // switch, which computes its own bodyW/bodyH from its own shape instead.
  const SW_PIN_PITCH   = HOLE_PITCH;
  const SW_BODY_MARGIN = 10; // body edge past the outermost pin, each side
  const SW_TOGGLE_H    = 16; // height of the position-toggle strip drawn below the pin grid
  const SW_TOGGLE_BOTTOM_PAD = 6; // extra room below the toggle pill itself, before the switch's own bottom edge — does NOT move the pill (toggleY is unchanged), just extends the body/slot centering to make room under it, per direct instruction
  // The toggle itself: a thin HORIZONTAL rounded-rect "pill" track
  // (web-toggle style) spanning the switch's own body width (minus a little
  // padding each side), with a round knob that slides left/center/right
  // between its 2 or 3 stops — wide and thin, not a tall narrow bar, per
  // direct instruction. Track width is derived per-switch from bodyW (each
  // switch has a different real body width), so only the height/padding/
  // knob radius are fixed constants here.
  const SW_TOGGLE_PAD_X  = 6; // gap between the pill's ends and the body's own edges
  const SW_TOGGLE_TRACK_H = SW_TOGGLE_H - 8; // pill height, thin relative to the strip (2px shorter than before)
  const SW_TOGGLE_KNOB_R  = SW_TOGGLE_TRACK_H/2 - 1;
  const SW_MAX_ROWS    = 4; // 4PDT is currently the widest-pole switch this app supports — bump this (and add the matching component) if a wider one is ever needed
  const SW_MAX_COLS    = 3;
  const SW_BODY_W      = (SW_MAX_COLS-1)*SW_PIN_PITCH + SW_BODY_MARGIN*2;
  const SW_BODY_H      = (SW_MAX_ROWS-1)*SW_PIN_PITCH + SW_BODY_MARGIN*2 + SW_TOGGLE_H + SW_TOGGLE_BOTTOM_PAD;
  const EXT_SLOT_W     = SW_BODY_W + 16; // breathing room around the largest switch body
  const EXT_SLOT_H     = SW_BODY_H + 16;
  const LABEL_PAD    = 8;
  const LEG_HIT_R    = 10;
  const LEG_DOT_R    = 6;
  const WIRE_HIT_W   = 7;
  const DRAG_THRESHOLD   = 6;
  const DROP_SNAP_RADIUS = 40;

  // Lead style — darker so they're visible against the cream board
  const LEAD_COLOR = '#555555';
  const LEAD_WIDTH = 2.0;
  const LEAD_CAP_R = 3.0;
  const STAND_GAP  = 14; // visible lead length between a standing 3-leg body and the hole row
  // Length of a DIP body's pin tab: the distance from the body edge to
  // the CENTER of the hole it reaches (not to the hole's near edge) — a
  // real tab visibly overlaps into the hole dot, it doesn't stop at its
  // rim. Extracted via direct pixel measurement of a reference image
  // (screenshots/my_comp.png), re-derived after an earlier pass
  // mismeasured this: naive color-run detection along a tab's own column
  // misclassified the hole dot's own pixels as "tab" (both land in a
  // similar gray/dark range at this image's anti-aliased edges), which
  // undercounted body height and overcounted a separate "tab-color-run"
  // quantity that wasn't actually the tab. Re-measured by reading the raw
  // per-pixel column trace directly: the real tab is a single antialiased
  // pixel immediately adjacent to both the body and the hole dot's own
  // rim, i.e. body edge sits (hole radius + ~1px) from the hole CENTER,
  // measuring 0.1405× hole-pitch in the reference image — consistent with
  // (not contradicting) the earlier ≈0.13× estimate; tightened here using
  // the more careful raw-column measurement.
  const IC_TAB_LEN = HOLE_PITCH*0.1405 + 2; // +2px per direct feedback, on top of the measured base length
  const IC_STUB_COLOR = '#8a8a8a'; // lighter than LEAD_COLOR — a DIP's own metal pins read lighter/more silver than a 2-leg part's wire lead
  const IC_BODY_MARGIN = 4; // body extends this far past the outermost pin COLUMN on each side (left/right)

  // 3-leg parts (transistor, potentiometer) stand above the hole row with
  // parallel legs; 2-leg parts lie flat directly on the hole row.
  function bodyOffsetY(inst,bh){
    return inst.legs.length===3 ? -(bh/2+STAND_GAP) : 0;
  }

  const cv = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const C  = () => ({
    boardBg:   cv('--board-bg'),    stripe:    cv('--board-stripe'),
    extPanelBg: cv('--board-ext-panel-bg'), extPanelLabel: cv('--text-dim'),
    hole:      cv('--board-hole'),  holeShadow:cv('--board-hole-shadow'),
    railRedBg: cv('--board-bus-r-bg'), railBlueBg:cv('--board-bus-b-bg'),
    railRed:   cv('--board-bus-r'), railBlue:  cv('--board-bus-b'),
    label:     cv('--board-label'),
    hover:     cv('--board-hover'), wireStart: cv('--board-wire-start'),
    accent:    cv('--accent'),      warning:   cv('--warning'),
    alert:     cv('--alert'),       success:   cv('--success'),
    scopeTrace:cv('--scope-trace'),
  });

  let canvas, ctx, _layout=null, _dpr=1;
  let _placed=[], _wires=[];
  let _selectedComp=null, _selectedWire=null;
  let _hoverHole=null, _paletteGhost=null, _wiringStart=null;
  let _zoom=1.0;
  let _mouseX=0, _mouseY=0;

  let _dragMode='idle';
  let _dragInst=null, _dragLegIdx=-1, _dragAnchorLeg=null;
  let _pressedSwitchInst=null; // momentary switch currently held down, if any
  let _dragWire=null, _dragWireEnd=-1, _savedWireEnds=null; // wire endpoint currently being dragged, if any
  // Whole-wire body drag (Select tool, click-drag the wire's body rather than
  // an endpoint) — free 2D movement, same technique as whole-component
  // dragging: track a raw pixel offset while dragging (pure visual, no
  // snapping), then on release snap one endpoint to its nearest hole, work
  // out the exact pixel correction that snap introduced, and apply that same
  // correction to the other endpoint (independently snapped too). xyToHole
  // doesn't care whether a hole is a numeric row or a rail, so this needs no
  // special-casing for the row/rail-key duality that motivated an earlier,
  // more conservative column-only version of this.
  let _dragWireMove=null, _savedWireMoveEnds=null;
  let _dragStartX=0, _dragStartY=0, _dragOffsetX=0, _dragOffsetY=0;
  let _savedLegs=null;

  let _onSelect=null, _onPlace=null;

  // ── Geometry ──────────────────────────────────────────────────────────────────
  // Group-gap boundaries count from the RIGHT edge, not the left — this
  // puts the short, 3-hole partial group on the left (cols 0-2) and lets
  // the full 5-hole groups end cleanly at the right edge (col 62), matching
  // both the requested layout and the numbering direction above. Boundary
  // columns are 3,8,13,...,58 (12 of them); extraGroups(col) counts how
  // many of those a given column sits at-or-past, same total gap count and
  // board width as the original left-counting version, just repositioned.
  function extraGroups(col) {
    return col < 3 ? 0 : Math.floor((col-3)/5) + 1;
  }

  // Best (most-centered) extraGroups() span any perSide-column-wide pin row
  // can ever achieve, found by scanning real anchor columns rather than
  // computing it from the board's group width directly — so it stays
  // correct even if extraGroups' own math ever changes, with no second
  // constant to keep in sync. Memoized since legSpanValid calls this on
  // every placement/drag check and perSide only takes a few small values.
  const _minSpanCache = new Map();
  function minAchievableSpanFor(perSide) {
    if (_minSpanCache.has(perSide)) return _minSpanCache.get(perSide);
    let best = Infinity;
    for (let anchor = perSide - 1; anchor <= 62; anchor++) {
      const groups = [];
      for (let i = 0; i < perSide; i++) groups.push(extraGroups(anchor - i));
      const span = Math.max(...groups) - Math.min(...groups);
      if (span < best) best = span;
    }
    _minSpanCache.set(perSide, best);
    return best;
  }

  // Placement-span validation: on a real breadboard, a part's legs only
  // land in useful holes when they don't stretch across gaps that don't
  // exist on the physical part. Two different rules, per component kind:
  //   - Transistors (3-leg): the two OUTER legs may span at most ONE
  //     5-hole-group boundary (extraGroups' gap columns) — allows the
  //     common "leg happens to straddle one gap" case a real transistor's
  //     bent leads can do, but not two-plus gaps at once, which nothing
  //     shaped like a real TO-92 body could reach.
  //   - Op-amps / DIP-8 (8-leg, category 'ic'): ALWAYS straddles the one
  //     center channel by construction (buildDipLegs), which is allowed —
  //     it's the one gap on the board a real DIP is designed to straddle.
  //     What's NOT allowed is a placement whose 4-pin row additionally
  //     crosses a column-group boundary, since nothing about a real DIP's
  //     rigid pin spacing lets it also span a completely different gap.
  // Both are checked the same way: do the part's occupied columns span more
  // than one extraGroups() value?
  function legSpanValid(defCategory, legCount, cols) {
    if (legCount === 3) {
      // Group INDEX distance, not just "are the two groups different" — two
      // groups five apart (e.g. dragged clear across the board) would
      // wrongly pass a same-vs-different check but must fail here, since
      // that's many boundaries crossed, not one.
      const gA = extraGroups(Math.min(...cols)), gB = extraGroups(Math.max(...cols));
      return Math.abs(gB - gA) <= 1;
    }
    if (defCategory === 'ic') {
      const groups = cols.map(extraGroups);
      const actualSpan = Math.max(...groups) - Math.min(...groups);
      // DIP-8's 4-pin row fits inside one 5-hole group by construction, so
      // "0 extra groups" was a correct hardcoded threshold — but only
      // BECAUSE 4 columns fit in one group. A wider package (a 16-pin part
      // like the PT2399, 8 pins per row) physically cannot fit inside one
      // group no matter where it's centered, so a fixed "0 extra" threshold
      // would make every possible placement invalid. minAchievableSpanFor
      // finds the best any placement of this pin-row width can ever do, by
      // scanning real anchor columns through the SAME extraGroups() this
      // function already uses — so it can never drift out of sync with the
      // board's actual group geometry, unlike a second hardcoded group-width
      // constant would. The check then requires the ACTUAL span not exceed
      // that minimum — still "as tight as physically possible for this
      // package," just no longer assuming every package fits in one group
      // the way DIP-8 happens to.
      const perSideIc = legCount / 2;
      return actualSpan <= minAchievableSpanFor(perSideIc);
    }
    return true; // 2-leg parts are the "stretch it like real lead wire" case, no span limit
  }

  // Only 2 of every 5 columns are valid DIP anchors (the pin row must stay
  // within one 5-hole group), so a user dropping by eye lands in an invalid
  // dead zone more often than not. Rather than reject those drops outright,
  // search outward from the requested anchor column for the nearest column
  // that IS valid — same spirit as xyToHole's own snap-to-nearest-hole
  // behavior, just one level up (snap to nearest valid PLACEMENT, not just
  // nearest hole). Returns null only if nothing valid exists within the
  // search radius (shouldn't happen in practice, since valid columns repeat
  // every 5). `perSide` is the pin-row width (4 for DIP-8, 8 for a 16-pin
  // part like the PT2399) — generalized from a hardcoded 4-column window so
  // any DIP leg count works, not just the original 8-leg case.
  function nearestValidDipAnchor(col, perSide) {
    const colsN = c => Array.from({length: perSide}, (_, i) => c - i);
    const legCount = perSide * 2;
    if (col >= perSide-1 && legSpanValid('ic', legCount, colsN(col))) return col;
    for (let d = 1; d <= 5; d++) {
      if (col+d <= 62 && col+d >= perSide-1 && legSpanValid('ic', legCount, colsN(col+d))) return col+d;
      if (col-d >= perSide-1 && legSpanValid('ic', legCount, colsN(col-d))) return col-d;
    }
    return null;
  }

  function holeX(col) {
    return ML + col*HOLE_PITCH + extraGroups(col)*GROUP_GAP + HOLE_PITCH/2;
  }


  function buildLayout() {
    let y=MT;
    const rtMin=y+RAIL_PAD_V+HOLE_PITCH/2, rtPlu=rtMin+HOLE_PITCH;
    y+=RAIL_STRIP_H+RAIL_TO_GRID;
    const gridTopY=y, rowY={};
    for(let r=5;r<=9;r++){rowY[r]=y+HOLE_PITCH/2;y+=HOLE_PITCH;}
    y+=DIP_GAP;
    for(let r=4;r>=0;r--){rowY[r]=y+HOLE_PITCH/2;y+=HOLE_PITCH;}
    y+=RAIL_TO_GRID;
    const rbMin=y+RAIL_PAD_V+HOLE_PITCH/2, rbPlu=rbMin+HOLE_PITCH;
    y+=RAIL_STRIP_H+MB;
    const boardBottomY=y; // the board CARD's own bottom edge — external panel geometry is computed from this, in buildExtPanelLayout, but stays a fully separate rect (no shared coordinate system)
    return {
      railTopMinusY:rtMin, railTopPlusY:rtPlu,
      railBotMinusY:rbMin, railBotPlusY:rbPlu,
      railTopStripTop:MT, railTopStripBot:MT+RAIL_STRIP_H,
      railBotStripTop:MT+RAIL_STRIP_H+RAIL_TO_GRID+10*HOLE_PITCH+DIP_GAP+RAIL_TO_GRID,
      railBotStripBot:MT+RAIL_STRIP_H+RAIL_TO_GRID+10*HOLE_PITCH+DIP_GAP+RAIL_TO_GRID+RAIL_STRIP_H,
      gridTopY, dipGapCenterY:MT+RAIL_STRIP_H+RAIL_TO_GRID+5*HOLE_PITCH+DIP_GAP/2,
      rowY, boardBottomY,
      totalHeight:y,
    };
  }

  // The External Switches panel's own geometry — a genuinely separate rect
  // (own rounded outline, own background fill, own coordinate space for
  // switch slots) sitting in the canvas below the board CARD, not part of
  // buildLayout's board-hole coordinate system at all. Kept as its own
  // function (not folded into buildLayout) specifically so nothing here can
  // accidentally leak into holeToXY/xyToHole, which must stay board-hole-
  // only. `slotRows` is mutable at runtime (see setExtSlotRows) since it's
  // the one dimension expected to need tuning by eye.
  let _extSlotRows = EXT_SLOT_ROWS;
  function setExtSlotRows(n){ _extSlotRows = Math.max(1, n|0); }
  function extSlotCols(){ return Math.max(1, Math.floor((boardWidth()-EXT_PANEL_PAD*2) / EXT_SLOT_W)); }
  function buildExtPanelLayout() {
    const L=_layout;
    const panelTop = L.boardBottomY + EXT_GAP_ABOVE;
    const cols = extSlotCols();
    const gridW = cols*EXT_SLOT_W;
    const gridLeft = (boardWidth()-gridW)/2; // centered — panel is full board width, slots may not fill it exactly
    const gridTop = panelTop+EXT_LABEL_H;
    const panelH = EXT_LABEL_H + _extSlotRows*EXT_SLOT_H + EXT_PANEL_PAD;
    return { panelTop, panelH, panelBot:panelTop+panelH, cols, rows:_extSlotRows, gridLeft, gridTop };
  }

  // Pixel center of a given (row,col) slot — the ONLY thing switch
  // placement/rendering ever needs from this panel; nothing else here
  // pretends to be board-hole-compatible.
  function extSlotCenter(row,col) {
    const EL=buildExtPanelLayout();
    return { x: EL.gridLeft+col*EXT_SLOT_W+EXT_SLOT_W/2, y: EL.gridTop+row*EXT_SLOT_H+EXT_SLOT_H/2 };
  }

  // First empty slot, row-major (fills the top row left-to-right before
  // moving down) — "new switches stack under the first" falls out of this
  // ordering for free, no special-cased stacking logic needed. Grows the
  // panel by one more row (via setExtSlotRows) rather than rejecting the
  // drop once every currently-visible slot is full, since there's no real
  // reason to cap how many switches a user can add.
  function findFreeExtSlot() {
    const EL=buildExtPanelLayout();
    const occupied = new Set();
    for (const p of _placed) {
      if (p.extSlot) occupied.add(p.extSlot.row+','+p.extSlot.col);
    }
    for (let r=0; r<EL.rows; r++) {
      for (let cc=0; cc<EL.cols; cc++) {
        if (!occupied.has(r+','+cc)) return { row:r, col:cc };
      }
    }
    setExtSlotRows(EL.rows+1);
    return { row: EL.rows, col: 0 };
  }

  const boardWidth  = () => holeX(COLS-1)+HOLE_PITCH/2+MR;
  const boardHeight = () => (_layout||buildLayout()).totalHeight;
  // Full canvas height: the board card PLUS the true gap PLUS the External
  // Switches panel — used for canvas sizing/clearing, never for the board
  // card's own rounded-rect fill (that stays boardHeight(), so the board's
  // own silhouette doesn't stretch to include the panel — they are two
  // separate rounded shapes, not one continuous card, per direct feedback
  // that the earlier hole-grid version reading as "more board" was wrong).
  const canvasHeight = () => buildExtPanelLayout().panelBot;

  function holeToXY(row,col) {
    // Switch pins ('sw:<instanceId>:<poleIdx>' virtual rows — see
    // buildSwitchLegs in components-registry.js) don't live in the board's
    // hole grid at all, so they need their own resolution path here rather
    // than falling through to L.rowY[row] (undefined for a string this
    // function was never taught about). This is the single choke point
    // EVERY wire endpoint, hit-test, and drag operation already calls
    // through — found missing only by a real click-to-toggle test that
    // silently failed (holeToXY returned {x, y:undefined} with no error),
    // exactly the kind of failure this project's own verification
    // philosophy (extract and run the real function against real data,
    // don't just read the code) exists to catch. switchPinXY needs the
    // owning INSTANCE (for its extSlot), not just the row string, so the
    // instanceId is parsed back out of the virtual row and looked up in
    // _placed.
    if (typeof row==='string' && row.startsWith('sw:')) {
      const parts=row.split(':'); // ['sw', instanceId, poleIdx]
      const inst=_placed.find(p=>p.instanceId===parts[1]);
      if (inst) return switchPinXY(inst, parseInt(parts[2],10)||0, col);
      return {x:0,y:0}; // instance not found (stale wire after deletion) — same "don't crash" spirit as every other fallback here
    }
    const L=_layout, x=holeX(col);
    const y=row==='rtp'?L.railTopPlusY:row==='rtm'?L.railTopMinusY
           :row==='rbp'?L.railBotPlusY:row==='rbm'?L.railBotMinusY
           :L.rowY[row];
    return {x,y};
  }

  function xyToHole(px,py,radius) {
    const snap=radius??HOLE_PITCH*0.65;
    let best=null, bestD=snap;
    const check=(row,col)=>{const {x,y}=holeToXY(row,col);const d=Math.hypot(px-x,py-y);if(d<bestD){bestD=d;best={row,col};}};
    for(const row of ['rtp','rtm','rbp','rbm']){const {y}=holeToXY(row,0);if(Math.abs(py-y)<snap*1.5) for(let c=0;c<COLS;c++) check(row,c);}
    for(let r=0;r<=9;r++){const {y}=holeToXY(r,0);if(Math.abs(py-y)<snap*1.5) for(let c=0;c<COLS;c++) check(r,c);}
    // Switch pins (External Switches panel): these live on virtual
    // 'sw:<instanceId>:<rowIdx>' rows that holeToXY already resolves (see
    // its own switch-pin branch above), but this is the SEARCH side —
    // finding which pin, if any, is near a click point — so it needs its
    // own scan rather than falling out of holeToXY's dispatch for free.
    // Board-hole rows/rails are cheap to bound-check by Y-band first (a
    // whole row shares one Y); switch pins don't share that structure since
    // each switch instance has its own slot position, so this just checks
    // every pin of every placed switch directly — the panel realistically
    // holds a handful of switches at a time, not hundreds, so an unbounded
    // scan here is not a real cost.
    for(const inst of _placed){
      const def=ComponentRegistry.getById(inst.defId);
      if(def?.behavior?.type!=='switch_mpdt' && def?.behavior?.type!=='switch_spst') continue;
      const {rows,cols}=switchShape(def);
      for(let r=0;r<rows;r++){
        for(let cc=0;cc<cols;cc++){
          const {x,y}=switchPinXY(inst,r,cc);
          const d=Math.hypot(px-x,py-y);
          if(d<bestD){bestD=d;best={row:'sw:'+inst.instanceId+':'+r,col:cc};}
        }
      }
    }
    return best;
  }

  function eventToCanvas(e) {
    const r=canvas.getBoundingClientRect();
    return {x:(e.clientX-r.left)/_zoom, y:(e.clientY-r.top)/_zoom};
  }

  // Real (rows,cols) pin-grid shape for a switch def — every switch type
  // living in the External Switches panel declares this on its own
  // behavior block (SPST: 1x2, the two real terminals; SPDT/DPDT/3PDT:
  // rows=poles, cols=3 for throw-A/common/throw-B). Centralized here so
  // every switch-aware function reads it the same way.
  function switchShape(def) {
    return { rows: def?.behavior?.rows||1, cols: def?.behavior?.cols||2 };
  }

  // Real pixel position of one pin on a placed switch, derived from its
  // slot center (extSlot) and the switch's OWN real pin-grid shape (not a
  // shared max-size box — a 1x2 SPST centers 2 pins, a 3x3 3PDT centers 9,
  // each sized/centered to its own real footprint, per direct feedback that
  // stretching every switch to the largest one's body looked wrong). The
  // External Switches panel has no hole grid for holeToXY to consult, so
  // switch instances need this parallel path instead. `rowIdx` is which
  // row of pins (0-based, top row first), `colIdx` is 0..cols-1 — matches
  // buildSwitchLegs' leg order exactly (leg i belongs to row
  // floor(i/cols), col i%cols), so callers can derive one from the other
  // consistently.
  function switchPinXY(inst,rowIdx,colIdx) {
    const def=ComponentRegistry.getById(inst.defId);
    const {rows,cols}=switchShape(def);
    const slot=inst.extSlot||{row:0,col:0};
    const {x:cx,y:cy}=extSlotCenter(slot.row,slot.col);
    // Pin grid center stays anchored at the same offset above the slot
    // center regardless of SW_TOGGLE_BOTTOM_PAD — that constant only adds
    // room below the toggle pill, it does not re-center the pin+pill
    // assembly within the (now slightly taller) body. See drawSwitchInst's
    // matching comment for why.
    const gridCx=cx, gridCy=cy-SW_TOGGLE_H/2;
    const px=gridCx + (colIdx-(cols-1)/2)*SW_PIN_PITCH;
    const py=gridCy + (rowIdx-(rows-1)/2)*SW_PIN_PITCH;
    return {x:px,y:py};
  }

  // World-space hit rect for a placed switch's toggle pill, used both by the
  // renderer (drawSwitchInst) and by onClick's toggle-only hit test — a
  // single source of geometry so the clickable area always matches exactly
  // what's drawn, per direct instruction that clicking must only work when
  // clicking the toggle itself, not anywhere on the switch body.
  function switchToggleRect(inst) {
    const def=ComponentRegistry.getById(inst.defId);
    const {rows,cols}=switchShape(def);
    const bodyW=(cols-1)*SW_PIN_PITCH + SW_BODY_MARGIN*2;
    const slot=inst.extSlot||{row:0,col:0};
    const {x:cx,y:cy}=extSlotCenter(slot.row,slot.col);
    const gridCy=cy-SW_TOGGLE_H/2;
    const gridH=(rows-1)*SW_PIN_PITCH;
    // Matches drawSwitchInst's toggleY formula exactly — the original,
    // already-liked vertical placement (see that function's comment). Not
    // affected by SW_TOGGLE_BOTTOM_PAD — that only extends the body further
    // below the pill, it doesn't move the pill itself.
    const toggleY=gridCy+gridH/2+SW_BODY_MARGIN+SW_TOGGLE_H/2;
    // Matches drawSwitchInst's trackHalfW/trackHalfH exactly (bodyW-derived
    // width, thin height), plus a little slack beyond the pill's own drawn
    // size so it's comfortably clickable without spilling into the pin grid.
    const hw=(bodyW/2-SW_TOGGLE_PAD_X)+4, hh=SW_TOGGLE_TRACK_H/2+3;
    return {cx, cy:toggleY, left:cx-hw, right:cx+hw, top:toggleY-hh, bottom:toggleY+hh};
  }

  // ── Component geometry ────────────────────────────────────────────────────────
  function instLegPixels(inst,useOffset) {
    const def=ComponentRegistry.getById(inst.defId);
    if(def?.behavior?.type==='switch_mpdt'||def?.behavior?.type==='switch_spst'){
      const {cols}=switchShape(def);
      return inst.legs.map((l,i)=>{
        const {x,y}=switchPinXY(inst,Math.floor(i/cols),i%cols);
        if(useOffset) return {x:x+_dragOffsetX,y:y+_dragOffsetY};
        return {x,y};
      });
    }
    return inst.legs.map(l=>{
      const {x,y}=holeToXY(l.row,l.col);
      if(useOffset) return {x:x+_dragOffsetX,y:y+_dragOffsetY};
      return {x,y};
    });
  }

  function instGeometry(inst,useOffset) {
    const pts=useOffset?instLegPixels(inst,true):instLegPixels(inst,false);
    const def=ComponentRegistry.getById(inst.defId);
    if(def?.category==='ic') return icGeometry(inst,pts);
    if(def?.behavior?.type==='switch_mpdt'||def?.behavior?.type==='switch_spst') return switchGeometry(inst,pts,useOffset);
    const a=pts[0], b=pts[pts.length-1];
    const cx=(a.x+b.x)/2, cy=(a.y+b.y)/2;
    const ang=Math.atan2(b.y-a.y,b.x-a.x);
    const len=Math.hypot(b.x-a.x,b.y-a.y);
    return {cx,cy,ang,len,pts};
  }

  // IC packages (DIP-N) don't fit the 2/3-leg "line between first and last
  // leg" model above — an 8-leg DIP-8 is a 2xN pin GRID straddling the
  // center channel, not two ends of one line, so its center is the
  // bounding-box midpoint of every leg, not the midpoint of legs[0]/
  // legs[last] (which for a DIP-8 built per the pin-1/pin-N ordering in
  // buildLegs would land off-center, diagonally between two corner pins).
  // `ang` here is a discrete 0/90/180/270deg rotation the user sets via the
  // same Rotate control 2-leg parts use (see rotateLeg90's IC branch below),
  // stored as `inst._icAngle` rather than derived from leg geometry — an IC
  // has no natural "angle between two legs" the way a resistor does. `len`
  // is unused for ICs (nothing here draws a lead the way a 2-leg part
  // does) but kept in the returned shape so any caller destructuring
  // {cx,cy,ang,len,pts} from either branch doesn't need an IC-specific
  // special case downstream.
  function icGeometry(inst,pts){
    const minX=Math.min(...pts.map(p=>p.x)), maxX=Math.max(...pts.map(p=>p.x));
    const minY=Math.min(...pts.map(p=>p.y)), maxY=Math.max(...pts.map(p=>p.y));
    const cx=(minX+maxX)/2, cy=(minY+maxY)/2;
    const ang=((inst._icAngle||0)*Math.PI)/180;
    return {cx,cy,ang,len:maxX-minX,pts};
  }

  // Multi-pole switches always render upright in their panel slot (no
  // rotate control — the slot grid has no meaningful orientation to rotate
  // INTO), so center is just the slot center directly rather than derived
  // from pin positions, and ang is always 0.
  function switchGeometry(inst,pts,useOffset){
    const slot=inst.extSlot||{row:0,col:0};
    const {x:cx,y:cy}=extSlotCenter(slot.row,slot.col);
    const off=useOffset?{x:_dragOffsetX,y:_dragOffsetY}:{x:0,y:0};
    return {cx:cx+off.x,cy:cy+off.y,ang:0,len:SW_BODY_W,pts};
  }

  function hitTestComp(x,y) {
    for(let i=_placed.length-1;i>=0;i--) {
      const inst=_placed[i], def=ComponentRegistry.getById(inst.defId);
      if(!def) continue;
      const geo=instGeometry(inst);
      if(def.category==='ic'){
        // Bounding box of the pin grid itself (already computed by
        // icGeometry as geo.cx/cy, half-extents derivable from geo.len and
        // the leg pixel spread) plus a small package-body margin — a real
        // DIP's plastic body overhangs its pins slightly on every side.
        const pinHalfW=geo.len/2, pinHalfH=HOLE_PITCH/2+DIP_GAP/2;
        const margin=10;
        const dx=x-geo.cx, dy=y-geo.cy;
        const lx=dx*Math.cos(-geo.ang)-dy*Math.sin(-geo.ang);
        const ly=dx*Math.sin(-geo.ang)+dy*Math.cos(-geo.ang);
        if(Math.abs(lx)<pinHalfW+margin&&Math.abs(ly)<pinHalfH+margin) return inst;
        continue;
      }
      if(def.behavior?.type==='switch_mpdt'||def.behavior?.type==='switch_spst'){
        // Real per-switch body size (matches drawSwitchInst exactly, NOT
        // the schema's static visual.body_width/height — those are unused
        // for these parts, since every switch draws its own body sized to
        // its real (rows,cols) pin-grid shape, see switchShape). Without
        // this branch, hit-testing fell through to the generic 2-leg body
        // box using the static visual size, which doesn't match ANY
        // switch's real rendered footprint — found by a real click-to-
        // toggle test that silently never registered a hit.
        const {rows,cols}=switchShape(def);
        const bw2=((cols-1)*SW_PIN_PITCH + SW_BODY_MARGIN*2)/2+6;
        // Body is NOT symmetric around geo.cy (the slot center) once
        // SW_TOGGLE_BOTTOM_PAD is nonzero — it extends further below cy than
        // above, since gridCy (the pin grid's own center) stays anchored at
        // its original offset rather than being re-derived to re-center the
        // taller body (see drawSwitchInst's comment on why). True top/bottom
        // extents, relative to geo.cy, mirror drawSwitchInst's own bodyTop/
        // bodyH math exactly rather than assuming a single symmetric half-height.
        const gridH2=(rows-1)*SW_PIN_PITCH;
        const gridCyLocal=-SW_TOGGLE_H/2;
        const bodyTop2=gridCyLocal-gridH2/2-SW_BODY_MARGIN-6;
        const bodyH2=gridH2+SW_BODY_MARGIN*2+SW_TOGGLE_H+SW_TOGGLE_BOTTOM_PAD+12;
        const dx2=x-geo.cx, dy2=y-geo.cy;
        if(Math.abs(dx2)<bw2 && dy2>bodyTop2 && dy2<bodyTop2+bodyH2) return inst;
        continue;
      }
      const bh0=def.visual?.body_height||16;
      const isGerm=(def.id==='transistor_npn'||def.id==='transistor_pnp')
        && def.model_params?.[inst.props?.model]?.type==='germanium';
      let bw,bh,offY;
      if(isGerm){
        const {r,cy}=Shapes.germCircleGeom(bh0);
        bw=r+12; bh=r+12; offY=bodyOffsetY(inst,bh0)+cy; // circle's true center, relative to the leg row
      }else{
        bw=(def.visual?.body_width||32)/2+12; bh=bh0/2+12;
        offY=bodyOffsetY(inst,bh0);
      }
      const dx=x-geo.cx, dy=y-geo.cy;
      const lx=dx*Math.cos(-geo.ang)-dy*Math.sin(-geo.ang);
      const ly=dx*Math.sin(-geo.ang)+dy*Math.cos(-geo.ang)-offY;
      if(Math.abs(lx)<bw&&Math.abs(ly)<bh) return inst;
    }
    return null;
  }

  function hitTestLeg(x,y) {
    if(!_selectedComp) return null;
    const inst=_placed.find(p=>p.instanceId===_selectedComp);
    if(!inst) return null;
    const def=ComponentRegistry.getById(inst.defId);
    if(def?.category==='ic') return null;
    if(inst.legs.length===3) return null; // 3-leg parts: fixed layout, reposition via Rotate only
    for(let i=0;i<inst.legs.length;i++) {
      const {x:lx,y:ly}=holeToXY(inst.legs[i].row,inst.legs[i].col);
      if(Math.hypot(x-lx,y-ly)<LEG_HIT_R) return {inst,legIdx:i};
    }
    return null;
  }

  function hitTestWireEnd(x,y) {
    for(const w of _wires) {
      const a=holeToXY(w.r1,w.c1), b=holeToXY(w.r2,w.c2);
      if(Math.hypot(x-a.x,y-a.y)<LEG_HIT_R) return {wire:w,end:1};
      if(Math.hypot(x-b.x,y-b.y)<LEG_HIT_R) return {wire:w,end:2};
    }
    return null;
  }

  function hitTestWire(x,y) {
    for(const w of _wires) {
      const a=holeToXY(w.r1,w.c1),b=holeToXY(w.r2,w.c2);
      if(distToWirePath(x,y,a.x,a.y,b.x,b.y)<WIRE_HIT_W) return w;
    }
    return null;
  }

  function distSeg(px,py,ax,ay,bx,by) {
    const dx=bx-ax,dy=by-ay,l2=dx*dx+dy*dy;
    if(!l2) return Math.hypot(px-ax,py-ay);
    const t=Math.max(0,Math.min(1,((px-ax)*dx+(py-ay)*dy)/l2));
    return Math.hypot(px-(ax+t*dx),py-(ay+t*dy));
  }

  // Curved wires (endpoints on different rows) are rendered by drawWires as
  // a cubic bezier bulging up to 18px away from the straight a->b line — see
  // drawWires' bezierCurveTo(a.x,a.y-18, b.x,b.y-18, b.x,b.y) — so a plain
  // straight-segment distance check misses clicks on the visible curve body
  // almost everywhere except right at the endpoints. This mirrors that exact
  // curve (same control points, same <4px straight-line threshold) and
  // measures distance to the nearest sampled point on it instead.
  function distToWirePath(px,py,ax,ay,bx,by) {
    if (Math.abs(by-ay) < 4) return distSeg(px,py,ax,ay,bx,by);
    const c1x=ax, c1y=ay-18, c2x=bx, c2y=by-18;
    const STEPS=16;
    let prevX=ax, prevY=ay, best=Infinity;
    for (let i=1; i<=STEPS; i++) {
      const t=i/STEPS, mt=1-t;
      const x = mt*mt*mt*ax + 3*mt*mt*t*c1x + 3*mt*t*t*c2x + t*t*t*bx;
      const y = mt*mt*mt*ay + 3*mt*mt*t*c1y + 3*mt*t*t*c2y + t*t*t*by;
      const d = distSeg(px,py,prevX,prevY,x,y);
      if (d<best) best=d;
      prevX=x; prevY=y;
    }
    return best;
  }

  // ── Canvas init (DPR-aware) ───────────────────────────────────────────────────
  function initCanvas() {
    _dpr=window.devicePixelRatio||1;
    const W=boardWidth(), H=canvasHeight();
    canvas.width=Math.round(W*_dpr); canvas.height=Math.round(H*_dpr);
    canvas.style.width=W+'px'; canvas.style.height=H+'px';
    ctx.setTransform(_dpr,0,0,_dpr,0,0);
  }

  // ── Render ────────────────────────────────────────────────────────────────────
  function render(ghostX,ghostY) {
    const c=C();
    ctx.setTransform(_dpr,0,0,_dpr,0,0);
    ctx.clearRect(0,0,boardWidth(),canvasHeight());
    // Wires draw AFTER components (not before) so every jumper sits above
    // every component, at all times — not just while dragging. Newest-
    // wire-on-top falls out for free within drawWires itself: addWire()
    // appends to the end of _wires, and a canvas paints array entries in
    // order, so a later wire is always painted over an earlier one without
    // needing any separate z-index concept.
    // Extension fill drawn FIRST (see its own comment) so the board's
    // opaque surface, drawn right after, paints over the part that's meant
    // to hide behind it. The label-only drawExternalSwitchPanel keeps its
    // original position in this order, after components/wires.
    drawExternalSwitchPanelExtension(c);
    drawBoardSurface(c); drawExternalSwitchPanel(c); drawComponents(c); drawWires(c);
    if(_paletteGhost) drawPaletteGhost(ghostX??_mouseX,ghostY??_mouseY,c);
    drawMeasurementReadout();
  }

  // Voltage Meter / Audio Probe hover tag. Piggybacks on render() so it
  // refreshes both on mousemove and on Simulation's own per-tick redraw —
  // no separate timer needed. Audio Probe's value is a placeholder until
  // the audio chain is topology-aware (Phase 2); it still shows the tool
  // is live and hovering correctly.
  function drawMeasurementReadout() {
    if (!_hoverHole || typeof currentTool!=='function') return;
    const tool = currentTool();
    if (tool!=='voltmeter' && tool!=='probe') return;

    let text, tint;
    if (tool==='voltmeter') {
      const v = (typeof Simulation!=='undefined' && Simulation.getVoltageAt) ? Simulation.getVoltageAt(_hoverHole.row,_hoverHole.col) : 0;
      text = (Math.round(v*100)/100) + 'V';
      tint = '#2B579A';
    } else {
      const audible = (typeof AudioEngine!=='undefined' && AudioEngine.probeIsAudible) ? AudioEngine.probeIsAudible(_hoverHole.row,_hoverHole.col) : false;
      text = audible ? '🔊 audible' : 'silent';
      tint = '#2A7A4A';
    }

    const {x,y} = holeToXY(_hoverHole.row,_hoverHole.col);
    ctx.save();
    ctx.font = 'bold 11px IBM Plex Mono, monospace';
    const w = ctx.measureText(text).width;
    const padX=6, tagH=18, tagY = y - HOLE_R - 12 - tagH;
    Shapes.roundRect(ctx, x-w/2-padX, tagY, w+padX*2, tagH, 4);
    ctx.fillStyle='rgba(20,16,12,0.9)'; ctx.fill();
    ctx.strokeStyle=tint; ctx.lineWidth=1.2; ctx.stroke();
    ctx.fillStyle='#fff'; ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.fillText(text, x, tagY+tagH/2+1);
    ctx.restore();
  }

  // ── Board surface ─────────────────────────────────────────────────────────────
  function drawBoardSurface(c) {
    const W=boardWidth(),H=boardHeight(),L=_layout;
    ctx.fillStyle=c.boardBg; Shapes.roundRect(ctx,0,0,W,H,10); ctx.fill();
    ctx.fillStyle=c.stripe;
    const BOUNDARY_COLS = [3,8,13,18,23,28,33,38,43,48,53,58]; // must match holeX()'s extraGroups() boundaries
    for (const bc of BOUNDARY_COLS) ctx.fillRect(holeX(bc)-HOLE_PITCH/2-GROUP_GAP/2-0.5,L.gridTopY,1,10*HOLE_PITCH+DIP_GAP);
    ctx.fillStyle=c.label; ctx.font='bold 9px IBM Plex Mono,monospace'; ctx.textAlign='center';
    ctx.fillText('DIP',ML/2,L.dipGapCenterY+3); ctx.fillText('DIP',W-MR/2,L.dipGapCenterY+3);
    drawRailStrip(c,'top'); drawRailStrip(c,'bot'); drawMainGrid(c);
  }

  // A genuinely SEPARATE surface for multi-pole switches (SPDT/DPDT/3PDT),
  // sitting in the dark canvas background below the board — its own rounded
  // rect, its own (slightly-lighter-than-canvas, not lighter-than-board)
  // fill, a true gap above it, and NO visible holes: the grid inside it is
  // invisible, switches snap to uniform slots by center point only (see
  // extSlotCenter), and a placed switch draws its own real pins as the
  // actual wire-connection points. This replaced an earlier version that
  // extended the board's own hole grid downward — per direct feedback that
  // read as "more board," not as a separate off-board area, which is the
  // whole point of a panel meant to represent point-to-point wiring to a
  // physically separate part.
  // Draws ONLY the panel's fill, extended upward past its own panelTop so it
  // continues behind the board canvas above it — same illusion as
  // workbench-strip.js's OVERLAP trick at the board's TOP edge (draw taller
  // than the visible area, let the neighboring opaque surface painted
  // afterward cover the extension), just mirrored to the board's BOTTOM
  // edge and achieved by DRAW ORDER instead of a separate canvas/negative
  // margin, since the board and this panel share one canvas here. Must be
  // called BEFORE drawBoardSurface (see render()) so the board's own
  // opaque, rounded rect paints over this extension and hides the seam —
  // calling it after would draw the extension ON TOP of the board instead.
  // Square top corners (roundRectBottom, not roundRect) since that edge is
  // now meant to disappear behind the board, not read as a rounded edge of
  // its own — per direct instruction: no rounded corners or gap on top,
  // matching the workbench strip's own top-of-board treatment.
  function drawExternalSwitchPanelExtension(c){
    const W=boardWidth(), EL=buildExtPanelLayout();
    const extendedTop=EL.panelTop-EXT_EXTEND_UP;
    ctx.fillStyle=c.extPanelBg;
    Shapes.roundRectBottom(ctx,0,extendedTop,W,EL.panelH+EXT_EXTEND_UP,10);
    ctx.fill();
  }

  // Label only — drawn in its own normal position (EL.panelTop, unchanged)
  // AFTER drawComponents/drawWires in render()'s existing order, same as
  // before this change. The panel's fill itself is now handled entirely by
  // drawExternalSwitchPanelExtension above; this function no longer paints
  // any background of its own.
  function drawExternalSwitchPanel(c){
    const W=boardWidth(), EL=buildExtPanelLayout();
    ctx.fillStyle=c.extPanelLabel; ctx.font='bold 9px IBM Plex Mono,monospace'; ctx.textAlign='center';
    ctx.fillText(I18n.t('app.board.externalSwitchesLabel'),W/2,EL.panelTop+14);
  }

  function drawRailStrip(c,side) {
    const W=boardWidth(),L=_layout,isTop=side==='top';
    const sT=isTop?L.railTopStripTop:L.railBotStripTop, sB=isTop?L.railTopStripBot:L.railBotStripBot, sH=sB-sT;
    const mY=isTop?L.railTopMinusY:L.railBotMinusY, pY=isTop?L.railTopPlusY:L.railBotPlusY;
    const rx=ML-6, rw=W-ML-MR+12;
    ctx.fillStyle=c.railBlueBg; ctx.fillRect(rx,sT,rw,sH/2);
    ctx.fillStyle=c.railRedBg;  ctx.fillRect(rx,sT+sH/2,rw,sH/2);
    const lx1=holeX(0)-HOLE_PITCH/2+2, lx2=holeX(COLS-1)+HOLE_PITCH/2-2;
    ctx.lineWidth=1.5;
    // Only the top rail is fed by the permanent supply — the bottom rail
    // stays user-controlled (per the workbench doc) and is never dimmed
    // here, regardless of the permanent supply's state.
    //
    // The rails are fixed hardware: minus is ALWAYS the upper row and plus
    // ALWAYS the lower one, whatever reverse_polarity says. What reverses is
    // which rail each supply LEAD reaches — see trace-overlay.js.
    const permOff = isTop && typeof WorkbenchStrip!=='undefined' && WorkbenchStrip.getPermanentState().power.power_on===false;
    const traceBlue = permOff ? 'rgba(130,130,120,0.45)' : c.railBlue;
    const traceRed  = permOff ? 'rgba(130,130,120,0.45)' : c.railRed;
    ctx.strokeStyle=traceBlue; ctx.beginPath(); ctx.moveTo(lx1,mY); ctx.lineTo(lx2,mY); ctx.stroke();
    ctx.strokeStyle=traceRed;  ctx.beginPath(); ctx.moveTo(lx1,pY); ctx.lineTo(lx2,pY); ctx.stroke();
    ctx.font='bold 11px IBM Plex Mono,monospace'; ctx.textAlign='center';
    ctx.fillStyle=traceBlue; ctx.fillText('–',ML/2,mY+4); ctx.fillText('–',W-MR/2,mY+4);
    ctx.fillStyle=traceRed;  ctx.fillText('+',ML/2,pY+4); ctx.fillText('+',W-MR/2,pY+4);
    for(let col=0;col<COLS;col++) {
      drawRailHole(col,mY,c,'blue',isTop?'rtm':'rbm');
      drawRailHole(col,pY,c,'red', isTop?'rtp':'rbp');
    }
  }

  function drawRailHole(col,y,c,color,railRow){
    const x=holeX(col);
    const isHov=_hoverHole?.row===railRow&&_hoverHole?.col===col;
    const isSrt=_wiringStart?.row===railRow&&_wiringStart?.col===col;
    if(isHov||isSrt){ctx.beginPath();ctx.arc(x,y,HOLE_R*2.8,0,Math.PI*2);ctx.fillStyle=isSrt?c.wireStart:c.hover;ctx.fill();}
    ctx.beginPath();ctx.arc(x+.5,y+.5,HOLE_R,0,Math.PI*2);ctx.fillStyle=c.holeShadow;ctx.fill();
    ctx.beginPath();ctx.arc(x,y,HOLE_R,0,Math.PI*2);ctx.fillStyle=color==='blue'?'rgba(43,87,154,0.35)':'rgba(176,32,46,0.35)';ctx.fill();
    ctx.beginPath();ctx.arc(x,y,HOLE_R-1,0,Math.PI*2);ctx.fillStyle=c.hole;ctx.fill();
  }

  function drawMainGrid(c){
    const L=_layout,W=boardWidth();
    ctx.font='10px IBM Plex Mono,monospace';ctx.fillStyle=c.label;
    for(let r=0;r<=9;r++){const y=L.rowY[r];const lbl=rowDisplayLabel(r);ctx.textAlign='right';ctx.fillText(lbl,ML-LABEL_PAD,y+3.5);ctx.textAlign='left';ctx.fillText(lbl,W-MR+LABEL_PAD,y+3.5);}
    ctx.font='10px IBM Plex Mono,monospace';ctx.textAlign='center'; // same size as the row letters (was 8px)
    // Vertically centered in the true gap between the nearest hole row's own
    // VISIBLE edge and the colored rail band's own edge. An earlier version
    // used `rowY[5]-HOLE_PITCH/2` as the hole row's "top edge", which is
    // wrong — that's the midpoint toward the NEXT row, not the hole's own
    // drawn boundary. drawMainHole's real hole radius is HOLE_R (plus its
    // +0.5 shadow offset), so the hole's true visible edge is
    // rowY-（HOLE_R+0.5), not rowY-HOLE_PITCH/2 — confirmed against a real
    // pixel-measured screenshot (measured hole edge ~89.5 vs the old
    // formula's assumed 84, a real ~5.5px error that visibly pulled the
    // label toward the band). The +3 baseline correction (canvas fillText's
    // default 'alphabetic' baseline sits below the glyph's visual center,
    // not previously ctx.textBaseline='middle') was also re-measured
    // directly (glyph center vs baseline-y passed) rather than reused
    // as-is from the row-letter code, which is a different font weight/size
    // pairing and isn't guaranteed to share the same correction.
    const HOLE_EDGE=HOLE_R+0.5, BASELINE_CORRECTION=3;
    const topLabelY=(L.railTopStripBot+(L.rowY[5]-HOLE_EDGE))/2+BASELINE_CORRECTION;
    const botLabelY=(L.railBotStripTop+(L.rowY[0]+HOLE_EDGE))/2+BASELINE_CORRECTION;
    for(let col=0;col<COLS;col++){
      // Labels ascend right-to-left (hole 1 sits at the right edge, up to
      // 63 at the left) — every column now gets its own number rather than
      // only every-5 landmarks, per direct request for continuous numbering.
      const x=holeX(col);
      const displayNum = COLS - col;
      ctx.fillText(displayNum,x,topLabelY);
      ctx.fillText(displayNum,x,botLabelY);
    }
    for(let r=0;r<=9;r++) for(let col=0;col<COLS;col++) drawMainHole(r,col,c);
  }

  function drawMainHole(row,col,c){
    const {x,y}=holeToXY(row,col);
    const isHov=_hoverHole?.row===row&&_hoverHole?.col===col;
    const isSrt=_wiringStart?.row===row&&_wiringStart?.col===col;
    if(isHov||isSrt){ctx.beginPath();ctx.arc(x,y,HOLE_R*2.8,0,Math.PI*2);ctx.fillStyle=isSrt?c.wireStart:c.hover;ctx.fill();}
    ctx.beginPath();ctx.arc(x+.5,y+.5,HOLE_R,0,Math.PI*2);ctx.fillStyle=c.holeShadow;ctx.fill();
    ctx.beginPath();ctx.arc(x,y,HOLE_R,0,Math.PI*2);ctx.fillStyle=c.hole;ctx.fill();
  }

  // ── Wires ─────────────────────────────────────────────────────────────────────
  function strokeWirePath(ax,ay,bx,by){
    ctx.beginPath();ctx.moveTo(ax,ay);
    Math.abs(by-ay)<4?ctx.lineTo(bx,by):ctx.bezierCurveTo(ax,ay-18,bx,by-18,bx,by);
    ctx.stroke();
  }

  function drawWires(c){
    for(const w of _wires){
      const isDragging=(_dragMode==='wire-moving'&&w===_dragWireMove);
      let a=holeToXY(w.r1,w.c1),b=holeToXY(w.r2,w.c2);
      if(isDragging){ a={x:a.x+_dragOffsetX,y:a.y+_dragOffsetY}; b={x:b.x+_dragOffsetX,y:b.y+_dragOffsetY}; }
      const isSel=w.id===_selectedWire;
      ctx.lineWidth=isSel?4:2.5;ctx.strokeStyle=w.color||'#ff9900';ctx.lineCap='round';
      if(isSel){ctx.shadowColor=c.warning;ctx.shadowBlur=6;}
      if(isDragging) ctx.globalAlpha=0.45;
      strokeWirePath(a.x,a.y,b.x,b.y);
      ctx.shadowBlur=0;
      for(const pt of [a,b]){ctx.beginPath();ctx.arc(pt.x,pt.y,3,0,Math.PI*2);ctx.fillStyle=w.color||'#ff9900';ctx.fill();}
      if(isDragging) ctx.globalAlpha=1;
    }
    if(_wiringStart&&_hoverHole){
      const a=holeToXY(_wiringStart.row,_wiringStart.col),b=holeToXY(_hoverHole.row,_hoverHole.col);
      ctx.lineWidth=2;ctx.strokeStyle='rgba(200,120,32,0.65)';
      ctx.setLineDash([5,4]);ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke();ctx.setLineDash([]);
    }
    if(_dragMode==='leg-dragging'&&_dragAnchorLeg&&_hoverHole){
      const a=holeToXY(_dragAnchorLeg.row,_dragAnchorLeg.col),b=holeToXY(_hoverHole.row,_hoverHole.col);
      ctx.lineWidth=1.5;ctx.strokeStyle='rgba(43,87,154,0.45)';
      ctx.setLineDash([4,3]);ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke();ctx.setLineDash([]);
    }
    if(_pasteWireActive&&_pasteWireData){
      // Cursor is the shape's midpoint, same anchor convention as the
      // component ghost fix (drawPaletteGhost centers on the cursor too).
      const a={x:_mouseX+_pasteWireData.dxA,y:_mouseY+_pasteWireData.dyA};
      const b={x:_mouseX+_pasteWireData.dxB,y:_mouseY+_pasteWireData.dyB};
      ctx.globalAlpha=0.65;ctx.lineWidth=2.5;ctx.strokeStyle=_pasteWireData.color||'#ff9900';ctx.lineCap='round';
      strokeWirePath(a.x,a.y,b.x,b.y);
      ctx.globalAlpha=1;
    }
  }

  // ── Components ────────────────────────────────────────────────────────────────
  function drawComponents(c){
    for(const inst of _placed){
      const isDragging=(_dragMode==='comp-dragging'&&inst===_dragInst);
      drawInst(inst,c,isDragging?0.45:1.0,isDragging);
    }
    if(_selectedComp){const inst=_placed.find(p=>p.instanceId===_selectedComp);if(inst) drawLegTargets(inst,c);}
  }

  function drawLegTargets(inst,c){
    const def=ComponentRegistry.getById(inst.defId);
    if(def?.category==='ic') return;
    if(inst.legs.length===3) return; // fixed layout, no drag handles — use Rotate instead
    for(let i=0;i<inst.legs.length;i++){
      const {x,y}=holeToXY(inst.legs[i].row,inst.legs[i].col);
      ctx.beginPath();ctx.arc(x,y,LEG_DOT_R+4,0,Math.PI*2);ctx.fillStyle='rgba(43,87,154,0.2)';ctx.fill();
      ctx.beginPath();ctx.arc(x,y,LEG_DOT_R,0,Math.PI*2);ctx.fillStyle=c.accent;ctx.fill();
      ctx.beginPath();ctx.arc(x,y,LEG_DOT_R,0,Math.PI*2);ctx.strokeStyle='rgba(255,255,255,0.7)';ctx.lineWidth=1.5;ctx.stroke();
      const ar=LEG_DOT_R-2;
      ctx.strokeStyle='#ffffff';ctx.lineWidth=1.5;ctx.lineCap='round';
      ctx.beginPath();ctx.moveTo(x-ar,y);ctx.lineTo(x-ar+3,y-2);ctx.moveTo(x-ar,y);ctx.lineTo(x-ar+3,y+2);ctx.stroke();
      ctx.beginPath();ctx.moveTo(x+ar,y);ctx.lineTo(x+ar-3,y-2);ctx.moveTo(x+ar,y);ctx.lineTo(x+ar-3,y+2);ctx.stroke();
    }
  }

  // ── Draw instance ─────────────────────────────────────────────────────────────
  // Leads ALWAYS stretch from the body edge to the actual leg hole pixel.
  function drawInst(inst,c,alpha,useOffset){
    const def=ComponentRegistry.getById(inst.defId);
    if(!def) return;
    const isSel=inst.instanceId===_selectedComp, isFail=inst.failed;
    const geo=instGeometry(inst,useOffset&&_dragMode==='comp-dragging');
    const {cx,cy,ang,len,pts}=geo;

    ctx.save();
    ctx.translate(cx,cy);
    ctx.rotate(ang);
    if(alpha<1) ctx.globalAlpha=alpha;
    if(isFail)  ctx.globalAlpha=(alpha||1)*0.35;

    // IC packages (DIP-N) are structurally different enough from every 2/3-
    // leg part (rectangular pin grid + body spanning the channel, no
    // germanium-can/pot/power-supply special cases to weave through) that
    // they get their own complete draw path rather than threading an extra
    // branch through the 2-leg/3-leg logic below.
    if(def.category==='ic'){ drawIcInst(inst,def,c,isSel,isFail,alpha,geo); ctx.restore(); return; }
    // Switches living in the External Switches panel (SPST/SPDT/DPDT/3PDT):
    // no stretchy leads at all — a real switch's pins ARE the body, wires
    // connect directly to them, not through a drawn lead to a board hole.
    // Own complete draw path, same "structurally different enough to not
    // thread through the 2/3-leg logic below" reasoning as the IC branch
    // above.
    if(def.behavior?.type==='switch_mpdt'||def.behavior?.type==='switch_spst'){ drawSwitchInst(inst,def,c,isSel,isFail,alpha); ctx.restore(); return; }

    const halfLen=len/2;
    const bw=def.visual?.body_width||28, bh=def.visual?.body_height||14;
    const isGermTransistor = (def.id==='transistor_npn'||def.id==='transistor_pnp')
      && def.model_params?.[inst.props?.model]?.type==='germanium';

    // ── Draw stretchy leads ───────────────────────────────────────────────────
    ctx.strokeStyle=LEAD_COLOR;ctx.lineWidth=LEAD_WIDTH;ctx.lineCap='round';
    ctx.fillStyle=LEAD_COLOR;

    const offY=bodyOffsetY(inst,bh);

    if(inst.legs.length===2){
      // Left lead: body edge (-bw/2) → left hole pixel (-halfLen)
      const leftEdge=-bw/2, rightEdge=bw/2;
      if(halfLen>bw/2){
        ctx.beginPath();ctx.moveTo(leftEdge,0);ctx.lineTo(-halfLen,0);ctx.stroke();
        ctx.beginPath();ctx.moveTo(rightEdge,0);ctx.lineTo(halfLen,0);ctx.stroke();
      }
      // Hole-end caps
      ctx.beginPath();ctx.arc(-halfLen,0,LEAD_CAP_R,0,Math.PI*2);ctx.fill();
      ctx.beginPath();ctx.arc(halfLen,0,LEAD_CAP_R,0,Math.PI*2);ctx.fill();

      // Power supply polarity labels — leg 0/1 by default show '–'/'+',
      // swapped if reverse_polarity is checked. Orientation can additionally
      // be changed via Rotate, which swaps which world-space hole each leg
      // index lands in. Text is counter-rotated to always read upright.
      if(def.id==='power_supply'){
        const rev=!!inst.props?.reverse_polarity;
        const rightSym = rev ? '–' : '+', leftSym = rev ? '+' : '–';
        ctx.font='bold 8px IBM Plex Mono,monospace';ctx.textAlign='center';
        ctx.save();ctx.translate(halfLen,-8);ctx.rotate(-ang);
        ctx.fillStyle = rightSym==='+' ? c.railRed : c.railBlue; ctx.fillText(rightSym,0,0);
        ctx.restore();
        ctx.save();ctx.translate(-halfLen,-8);ctx.rotate(-ang);
        ctx.fillStyle = leftSym==='+'  ? c.railRed : c.railBlue; ctx.fillText(leftSym,0,0);
        ctx.restore();
      }

    } else if(inst.legs.length===3&&pts.length===3){
      // Three legs, all on the same physical row (transistor, potentiometer).
      const wPt=pts[1];
      const dx=wPt.x-cx, dy=wPt.y-cy;
      const cosA=Math.cos(-ang), sinA=Math.sin(-ang);
      const xMid = dx*cosA - dy*sinA; // local x of the center leg's actual hole

      const bodyBottom = offY + bh/2;

      // Center (base) leg — always straight, lands at the bottom-most point
      // of the body regardless of body shape.
      ctx.beginPath();ctx.moveTo(xMid,bodyBottom);ctx.lineTo(xMid,0);ctx.stroke();
      ctx.beginPath();ctx.arc(xMid,0,LEAD_CAP_R,0,Math.PI*2);ctx.fill();

      if(isGermTransistor){
        // Round metal-can body is narrower than the leg span, so the two
        // outer legs travel diagonally inward to meet the circle's edge
        // instead of running straight up like a flat-bodied part. Uses the
        // same geometry Shapes.drawTransistor uses for the body itself, so
        // the two can never drift out of sync.
        const {r,cy}=Shapes.germCircleGeom(bh);
        const ax=r*0.574, ay=offY+cy+r*0.819;
        for(const side of [-1,1]){
          const hx=side*halfLen;
          ctx.beginPath();ctx.moveTo(hx,0);ctx.lineTo(side*ax,ay);ctx.stroke();
          ctx.beginPath();ctx.arc(hx,0,LEAD_CAP_R,0,Math.PI*2);ctx.fill();
        }
      }else{
        // Straight parallel legs — flat-bottomed body (transistor D-shape,
        // pot bracket) spans the full leg width, so no diagonal needed.
        for(const lx of [-halfLen, halfLen]){
          ctx.beginPath();ctx.moveTo(lx,bodyBottom);ctx.lineTo(lx,0);ctx.stroke();
          ctx.beginPath();ctx.arc(lx,0,LEAD_CAP_R,0,Math.PI*2);ctx.fill();
        }
      }
    }

    ctx.translate(0,offY);
    if(isSel&&alpha>=1){
      ctx.beginPath();
      if(isGermTransistor){
        const {r,cy:germCy}=Shapes.germCircleGeom(bh);
        ctx.ellipse(0,germCy,r+9,r+9,0,0,Math.PI*2);
      }else{
        ctx.ellipse(0,0,bw/2+9,bh/2+9,0,0,Math.PI*2);
      }
      ctx.strokeStyle=c.warning;ctx.lineWidth=2;ctx.stroke();
    }
    Shapes.drawBody(ctx,def,inst,c,halfLen,ang);

    if(isFail&&alpha>=1){
      ctx.globalAlpha=1;ctx.font='bold 14px monospace';ctx.textAlign='center';ctx.fillStyle=c.alert;
      let failY=-20;
      if(isGermTransistor){const g=Shapes.germCircleGeom(bh);failY=g.cy-g.r-10;}
      ctx.fillText('✕',0,failY);
    }
    ctx.restore();
  }

  // Draws a multi-pole switch (SPDT/DPDT/3PDT): the real pin grid on top
  // (one row per pole, 3 columns for throw-A/common/throw-B — the ACTUAL
  // wire-connection points, not board holes) and a position-toggle strip
  // below it, matching the real-hardware look a plain SPST already had via
  // Shapes.drawSwitch, just generalized to however many rows/cols this
  // part's real pin grid has. Sized to THIS switch's own real (rows,cols)
  // shape (switchShape), not a fixed max-size box shared by every switch
  // type — per direct feedback that stretching every switch to the largest
  // one's body looked wrong, and every switch should be proportioned to
  // its own real footprint. ctx is already translated/rotated to the
  // switch's own center (ang is always 0 for these — see switchGeometry),
  // so pin positions here are LOCAL offsets from switchPinXY's world
  // coordinates, same "subtract cx/cy" pattern drawIcInst uses just below.
  function drawSwitchInst(inst,def,c,isSel,isFail,alpha){
    const {rows,cols}=switchShape(def);
    const bodyW=(cols-1)*SW_PIN_PITCH + SW_BODY_MARGIN*2;
    const gridH=(rows-1)*SW_PIN_PITCH;
    const bodyH=gridH + SW_BODY_MARGIN*2 + SW_TOGGLE_H + SW_TOGGLE_BOTTOM_PAD;
    // gridCy stays anchored to the pins' ORIGINAL offset (-SW_TOGGLE_H/2, not
    // re-derived from the padded total) — SW_TOGGLE_BOTTOM_PAD only grows the
    // body/slot downward from here, it deliberately does not re-center the
    // pin grid+pill assembly within the taller body, since that would shift
    // the pins and the already-correctly-placed pill up along with it. A
    // switch with bottom pad therefore sits very slightly high within its
    // slot rather than dead-center — an accepted, purely cosmetic tradeoff
    // for keeping the liked pin/pill placement completely untouched.
    const gridCy=-SW_TOGGLE_H/2; // local-space grid center, matches switchPinXY's world-space offset (ctx is already translated to the switch's own center by drawInst)

    ctx.fillStyle='#3a3a3a';
    Shapes.roundRect(ctx,-bodyW/2,gridCy-gridH/2-SW_BODY_MARGIN,bodyW,bodyH,4);
    ctx.fill();
    if(isSel){ctx.strokeStyle=c.warning;ctx.lineWidth=2;ctx.stroke();}

    // Real pins: same visual weight as an IC's pin stubs (lighter than a
    // plain lead), since these ARE the connection points a wire snaps to.
    ctx.fillStyle=IC_STUB_COLOR;
    for(let r=0;r<rows;r++){
      for(let cc=0;cc<cols;cc++){
        const px=(cc-(cols-1)/2)*SW_PIN_PITCH, py=gridCy+(r-(rows-1)/2)*SW_PIN_PITCH;
        ctx.beginPath();ctx.arc(px,py,LEG_DOT_R*0.6,0,Math.PI*2);ctx.fill();
      }
    }

    // Position toggle: a thin vertical rounded-rect "pill" track (web-toggle
    // style) with a round knob sliding between its 2 or 3 stops, positioned
    // in the reserved strip below the pin grid rather than filling the whole
    // body (a multi-pole switch's body is dominated by its pin grid, not the
    // toggle itself). This geometry MIRRORS switchToggleRect's world-space
    // math (same toggleY formula) so the clickable area onClick tests
    // against lines up exactly with what's drawn here — don't let the two
    // drift apart. SPST keeps its own real open/closed semantics (2 stops,
    // ON/OFF) — everything else is the throw-select family with 2 or 3 stops
    // reading real 1/2/3 position (the pin LABELS stay A/B, since those are
    // the real terminal names; the physical knob position is what encodes
    // which throw is active, not a text label alone).
    // toggleY keeps the original, already-liked vertical placement (offset
    // SW_BODY_MARGIN+SW_TOGGLE_H/2 below the bottom pin row's center) — an
    // attempt earlier this session to recenter this against the strip's
    // true midpoint moved it up and was explicitly reverted per direct
    // feedback ("I liked the original spacing"). Only the pill's HEIGHT
    // (SW_TOGGLE_TRACK_H) shrank by 2px; its vertical position did not move.
    const toggleY=gridCy+gridH/2+SW_BODY_MARGIN+SW_TOGGLE_H/2;
    const isSpst=def.behavior?.type==='switch_spst';
    const onColor=c.success||'#33cc66', offColor=c.label;
    // Track spans the switch's own body width, minus padding each side —
    // wide and thin, filling the toggle strip horizontally rather than
    // standing as a tall narrow bar.
    const trackHalfW=bodyW/2-SW_TOGGLE_PAD_X, trackHalfH=SW_TOGGLE_TRACK_H/2;
    const knobTravel=trackHalfW-SW_TOGGLE_KNOB_R-1.5;

    function drawPill(active,knobFrac){
      // knobFrac: -1 (left stop) .. 0 (middle) .. +1 (right stop)
      ctx.fillStyle=active?'rgba(51,204,102,0.18)':'rgba(255,255,255,0.06)';
      Shapes.roundRect(ctx,-trackHalfW,toggleY-trackHalfH,trackHalfW*2,SW_TOGGLE_TRACK_H,trackHalfH);
      ctx.fill();
      ctx.strokeStyle=active?onColor:offColor;ctx.lineWidth=1.25;
      Shapes.roundRect(ctx,-trackHalfW,toggleY-trackHalfH,trackHalfW*2,SW_TOGGLE_TRACK_H,trackHalfH);
      ctx.stroke();
      ctx.fillStyle=active?onColor:offColor;
      ctx.beginPath();ctx.arc(knobFrac*knobTravel,toggleY,SW_TOGGLE_KNOB_R,0,Math.PI*2);ctx.fill();
    }

    if(isSpst){
      const active=Utils.isSwitchClosed(inst);
      drawPill(active, active?1:-1);
    } else {
      const maxPos = inst.props?.throw_type==='On-On' ? 2 : 3;
      const position = Utils.clamp(parseInt(inst.props?.position,10)||1, 1, maxPos);
      // Knob position: -1 at position 1, 0 at the middle (only reachable
      // when maxPos===3), +1 at the last position — an On-On switch has no
      // real middle, so its 2 positions map to the two extremes directly.
      const knobFrac = maxPos===2 ? (position===1?-1:1) : (position-2);
      const active = !(maxPos===3 && position===2 && inst.props?.throw_type==='On-Off-On'); // true neutral middle only for On-Off-On
      drawPill(active, knobFrac);
    }

    if(isFail){
      ctx.globalAlpha=1;ctx.font='bold 14px monospace';ctx.textAlign='center';ctx.fillStyle=c.alert;
      ctx.fillText('✕',0,gridCy);
    }
  }

  // Lets palette.js's OS drag-image canvas (a completely separate <canvas>
  // from the board's own, built fresh per dragstart) render a real switch
  // body via drawSwitchInst, instead of duplicating its pin-grid/toggle-pill
  // geometry a second time. drawSwitchInst draws through this module's
  // private `ctx` closure variable (not a parameter — same as every other
  // draw* function here), so this swaps it to the caller's context for the
  // one call and restores it immediately after, translated so (0,0) in the
  // caller's canvas is the switch's own local origin, matching how drawInst
  // sets up drawSwitchInst normally (see drawInst's ctx.translate(cx,cy)).
  function drawSwitchGhost(targetCtx, def, colors){
    const prevCtx=ctx;
    ctx=targetCtx;
    try{
      const fakeInst={defId:def.id,legs:[],props:{},failed:false,_brightness:0,_state:false};
      for(const p of(def.properties||[])) fakeInst.props[p.key]=p.default;
      drawSwitchInst(fakeInst,def,colors,false,false,1);
    } finally {
      ctx=prevCtx;
    }
  }

  // Draws an IC (DIP-N package): 8 (or however many) straight leads from
  // each pin's actual hole position up/down to the package body edge, then
  // the body itself via Shapes.drawBody. Called with the same rotate/
  // translate context drawInst already set up (origin at geo.cx/cy, rotated
  // by geo.ang), so every coordinate here is in that same local space —
  // geo.pts are WORLD pixel positions and need the same local-space
  // transform drawInst's 3-leg branch already uses (rotate by -ang, offset
  // by cx/cy) to place each lead correctly relative to that origin.
  function drawIcInst(inst,def,c,isSel,isFail,alpha,geo){
    const {cx,cy,ang,pts}=geo;
    const cosA=Math.cos(-ang), sinA=Math.sin(-ang);
    const localPts=pts.map(p=>{
      const dx=p.x-cx, dy=p.y-cy;
      return {x:dx*cosA-dy*sinA, y:dx*sinA+dy*cosA};
    });
    const halfRowGap=HOLE_PITCH/2+DIP_GAP/2; // distance from IC center to the actual hole row (row 4/9, the two rows flanking the DIP gap) — used for hit-testing/selection, which should reach the real pin position
    // Body edge sits IC_TAB_LEN short of halfRowGap, and the tab fills
    // that exact remaining distance — so the tab reaches all the way to
    // the first hole row above/below the DIP gap (visibly overlapping the
    // hole's own center, per the measured reference), with no floating
    // gap before it and no overshoot past it.
    const bodyHalfH=halfRowGap-IC_TAB_LEN;
    const STUB_W=HOLE_PITCH*0.4;

    ctx.fillStyle=IC_STUB_COLOR;
    for(const p of localPts){
      const bodyEdgeY = p.y<0 ? -bodyHalfH : bodyHalfH;
      const top = Math.min(bodyEdgeY, p.y), h = Math.abs(p.y-bodyEdgeY);
      ctx.fillRect(p.x-STUB_W/2, top, STUB_W, h);
    }

    if(isSel&&alpha>=1){
      const pinHalfW=(Math.max(...localPts.map(p=>p.x))-Math.min(...localPts.map(p=>p.x)))/2;
      ctx.beginPath();ctx.ellipse(0,0,pinHalfW+10,halfRowGap+10,0,0,Math.PI*2);
      ctx.strokeStyle=c.warning;ctx.lineWidth=2;ctx.stroke();
    }

    // Real body size, not a static def.visual guess: as wide as the pin
    // span (however many hole-columns this package's legs actually occupy)
    // plus IC_BODY_MARGIN on each side — a real DIP's plastic body
    // overhangs its outermost pin columns slightly, it doesn't end exactly
    // at them — and as tall as bodyHalfH*2 (reaching the hole row). Passed
    // through drawBody's otherwise-unused halfLen/ang slots for
    // IC-category parts specifically.
    const pinSpanW=Math.max(...localPts.map(p=>p.x))-Math.min(...localPts.map(p=>p.x));
    Shapes.drawBody(ctx,def,inst,c,pinSpanW+IC_BODY_MARGIN*2,bodyHalfH*2);

    if(isFail&&alpha>=1){
      ctx.globalAlpha=1;ctx.font='bold 14px monospace';ctx.textAlign='center';ctx.fillStyle=c.alert;
      ctx.fillText('✕',0,0);
    }
  }

  // ── Body painters ─────────────────────────────────────────────────────────────
  // All actual shape-drawing now lives in Shapes (shapes.js), shared with
  // palette.js's drag-cursor image so the two can never drift out of sync
  // again.

  // ── Palette ghost ─────────────────────────────────────────────────────────────
  function drawPaletteGhost(mx,my,c){
    if(!_paletteGhost) return;
    const def=ComponentRegistry.getById(_paletteGhost.defId);
    if(!def) return;
    const bw=def.visual?.body_width||28,bh=def.visual?.body_height||14;
    const legCount=def.legs||2;
    const isDip=def.category==='ic' && legCount>=8;
    const isSwitch=def.behavior?.type==='switch_mpdt'||def.behavior?.type==='switch_spst';

    if(isSwitch){
      // Ghosts should look like the real thing being dropped, not a generic
      // leaded body — per direct instruction. drawSwitchInst already draws
      // purely in local ctx space (no dependency on inst.extSlot), so it's
      // reused as-is here, just translated to the cursor instead of a real
      // slot center.
      const fakeInst={defId:def.id,legs:[],props:{},failed:false,_brightness:0,_state:false};
      for(const p of(def.properties||[])) fakeInst.props[p.key]=p.default;
      ctx.save();
      ctx.translate(mx,my);
      ctx.globalAlpha=0.72;
      drawSwitchInst(fakeInst,def,c,false,false,0.72);
      ctx.restore();
      return;
    }

    if(isDip){
      // Mirrors drawIcInst's real DIP geometry exactly (same constants, same
      // tab/body math) rather than the generic 2/3-leg ghost shape below,
      // which collapses a leg_span:0 part to zero width. perSide generalizes
      // this from the original hardcoded 4-pin-per-row (DIP-8) shape to any
      // DIP leg count (8 for a 16-pin part like the PT2399): pinXs spaces
      // perSide columns evenly around center (same [-1.5,-0.5,0.5,1.5]
      // pattern for perSide=4, extending to [-3.5..3.5] for perSide=8), and
      // the body width covers perSide-1 hole-gaps instead of the DIP-8-only
      // literal 3.
      const perSide=legCount/2;
      const halfRowGap=HOLE_PITCH/2+DIP_GAP/2;
      const bodyHalfH=halfRowGap-IC_TAB_LEN;
      const STUB_W=HOLE_PITCH*0.4;
      const pinXs=Array.from({length:perSide},(_,i)=>(i-(perSide-1)/2)*HOLE_PITCH);
      const fakeInst={defId:def.id,legs:[],props:{},failed:false,_brightness:0,_state:false};
      for(const p of(def.properties||[])) fakeInst.props[p.key]=p.default;

      ctx.save();ctx.translate(mx,my);
      ctx.globalAlpha=0.72;
      ctx.fillStyle=IC_STUB_COLOR;
      for(const px of pinXs){
        for(const sign of [-1,1]){
          const bodyEdgeY=sign*bodyHalfH, holeY=sign*halfRowGap;
          const top=Math.min(bodyEdgeY,holeY), h=Math.abs(holeY-bodyEdgeY);
          ctx.fillRect(px-STUB_W/2,top,STUB_W,h);
        }
      }
      Shapes.drawBody(ctx,def,fakeInst,c,(perSide-1)*HOLE_PITCH+IC_BODY_MARGIN*2,bodyHalfH*2);
      ctx.restore();
      return;
    }

    // Match buildLegs() in components-registry.js exactly: leg_span IS the
    // hole-column distance between the two outer legs, no -1.
    const span=def.leg_span||2;
    const halfLen=span*HOLE_PITCH/2;
    const mid=Math.round(span/2);
    const legs = legCount===3
      ? [{row:3,col:5},{row:3,col:5+mid},{row:3,col:5+span}]
      : [{row:3,col:5},{row:3,col:5+span}];
    const fakeInst={defId:def.id,legs,props:{},failed:false,_brightness:0,_state:false};
    for(const p of(def.properties||[])) fakeInst.props[p.key]=p.default;

    const offY=bodyOffsetY(fakeInst,bh);

    // Keep the ghost fully on-canvas: hovering near the top rows of the
    // board (a very common case) would otherwise push a standing 3-leg
    // body's dome/circle above the canvas's own top edge, where it's
    // silently clipped by the canvas boundary itself.
    let gy=my;
    if(legCount===3){
      const bodyHalf=Math.max(bh/2,bw/2);
      const bodyTop=offY-bodyHalf;
      const minMargin=6;
      if(my+bodyTop<minMargin) gy=minMargin-bodyTop;
    }

    ctx.save();ctx.translate(mx,gy);
    const ang = def.id==='power_supply' ? Math.PI/2 : 0;
    ctx.rotate(ang);
    ctx.globalAlpha=0.72;
    ctx.strokeStyle=LEAD_COLOR;ctx.lineWidth=LEAD_WIDTH;ctx.lineCap='round';ctx.fillStyle=LEAD_COLOR;

    if(legCount===3){
      // Same standing style as the real placed instance: body above the hole
      // row, three parallel legs straight down into their actual x positions.
      const xMid=Utils.mapRange(mid,0,span,-halfLen,halfLen);
      const bodyBottom=offY+bh/2;
      for(const lx of [-halfLen, xMid, halfLen]){
        ctx.beginPath();ctx.moveTo(lx,bodyBottom);ctx.lineTo(lx,0);ctx.stroke();
        ctx.beginPath();ctx.arc(lx,0,LEAD_CAP_R,0,Math.PI*2);ctx.fill();
      }
    } else {
      if(halfLen>bw/2){ctx.beginPath();ctx.moveTo(-bw/2,0);ctx.lineTo(-halfLen,0);ctx.stroke();ctx.beginPath();ctx.moveTo(bw/2,0);ctx.lineTo(halfLen,0);ctx.stroke();}
      ctx.beginPath();ctx.arc(-halfLen,0,LEAD_CAP_R,0,Math.PI*2);ctx.fill();
      ctx.beginPath();ctx.arc(halfLen,0,LEAD_CAP_R,0,Math.PI*2);ctx.fill();
    }

    ctx.translate(0,offY);
    Shapes.drawBody(ctx,def,fakeInst,c,halfLen,ang);
    ctx.restore();
  }

  // ── Events ────────────────────────────────────────────────────────────────────
  function init(canvasEl){
    canvas=canvasEl;ctx=canvas.getContext('2d');
    _layout=buildLayout();initCanvas();
    canvas.addEventListener('mousemove',onMouseMove);
    canvas.addEventListener('mouseleave',()=>{ if(typeof Tooltip!=='undefined') Tooltip.hide(); });
    canvas.addEventListener('mousedown',onMouseDown);
    canvas.addEventListener('mouseup',onMouseUp);
    canvas.addEventListener('click',onClick);
    canvas.addEventListener('dragover',e=>e.preventDefault());
    canvas.addEventListener('drop',onDrop);
    canvas.addEventListener('contextmenu',e=>e.preventDefault());
    window.addEventListener('mouseup',onWindowMouseUp);
    window.addEventListener('keydown',onBoardKeyDown);
    render();
  }

  function onMouseMove(e){
    const {x,y}=eventToCanvas(e);
    _mouseX=x;_mouseY=y;
    _hoverHole=xyToHole(x,y);
    if(typeof currentTool==='function' && currentTool()==='probe' && typeof AudioEngine!=='undefined'){
      AudioEngine.probeHover(_hoverHole?_hoverHole.row:null, _hoverHole?_hoverHole.col:null);
    }
    // Hover tooltip: only while idle (not dragging/wiring — a tooltip during
    // a drag would just be clutter following the dragged part around), and
    // only the topmost hit component under the cursor, matching what a
    // click there would actually select.
    if (typeof Tooltip !== 'undefined') {
      const idle = !Wire.isWiring() && _dragMode === 'idle';
      const hovered = idle ? hitTestComp(x,y) : null;
      if (hovered) {
        const def = ComponentRegistry.getById(hovered.defId);
        const title = hovered.props?.title, model = hovered.props?.model;
        // A named part still shows its model alongside the name ("Q1
        // (2N5088)") — a title alone doesn't say WHICH transistor/diode/JFET
        // it is, and that's often the thing worth knowing at a glance. Any
        // component with a model prop gets this, not just transistors —
        // diodes, JFETs and MOSFETs all have one too, and the rule "model
        // exists -> show it" doesn't need a hardcoded type list that has to
        // be remembered every time a new model-bearing part is added.
        const base = title
          ? (model ? `${title} (${model})` : title)
          : (model || (def?.labelKey ? I18n.t(def.labelKey) : null) || def?.id || '');
        // Value-bearing passives get their actual value prefixed ("2.2µF
        // Capacitor (Electrolytic)", "1kΩ R4") — the tooltip's whole point
        // is a fast at-a-glance read, and "what's it called" alone leaves
        // out the one fact that's usually most useful. Only resistor/
        // capacitor/potentiometer have one obvious "the value" prop; every
        // other type (transistors, diodes, switches...) falls through
        // unchanged, same as before.
        const text = prefixWithValue(hovered, def, base);
        Tooltip.show(hovered.instanceId, text, e.clientX, e.clientY);
      } else {
        Tooltip.hide();
      }
    }
    if(Wire.isWiring()){render(x,y);return;}
    if(_dragMode==='comp-pending'){if(Math.hypot(x-_dragStartX,y-_dragStartY)>DRAG_THRESHOLD){_dragMode='comp-dragging';document.body.classList.add('dragging');}}
    if(_dragMode==='comp-dragging'){_dragOffsetX=x-_dragStartX;_dragOffsetY=y-_dragStartY;}
    if(_dragMode==='wire-pending'){if(Math.hypot(x-_dragStartX,y-_dragStartY)>DRAG_THRESHOLD){_dragMode='wire-moving';document.body.classList.add('dragging');}}
    if(_dragMode==='wire-moving'){_dragOffsetX=x-_dragStartX;_dragOffsetY=y-_dragStartY;}
    if(_dragMode==='leg-dragging'&&_dragInst&&_hoverHole) updateLegDrag();
    if(_dragMode==='wire-dragging'&&_dragWire&&_hoverHole) updateWireDrag();
    const coordEl=document.getElementById('status-coords');
    if(coordEl) coordEl.textContent=_hoverHole?(typeof _hoverHole.row==='number'?rowDisplayLabel(_hoverHole.row):_hoverHole.row)+(COLS-_hoverHole.col):'';
    render(x,y);
  }

  // Prefixes a tooltip label with the component's real value ("2.2µF
  // Capacitor (Electrolytic)", "1kΩ R4") for the three passive types where
  // there's one unambiguous "the value" prop. Reads the NOMINAL value the
  // user actually set (props[key]), not the tolerance-rolled *_actual —
  // this is "what did I set this to", a quick-glance readout, not a
  // simulation input, so the user's own chosen number is more useful here
  // than a randomized real-world variance.
  const VALUE_PROP_BY_BEHAVIOR = { resistor: 'resistance', capacitor: 'capacitance', potentiometer: 'resistance', zener_diode: 'zener_voltage' };
  function prefixWithValue(inst, def, label) {
    const behaviorType = def?.behavior?.type;
    const key = VALUE_PROP_BY_BEHAVIOR[behaviorType];
    if (!key) return label;
    let raw = parseFloat(inst.props?.[key]);
    // zener_voltage is normally left blank (the model's rated Vz applies) —
    // unlike resistance/capacitance, which are always a real typed-in
    // value, so falling back to model_params here is what makes this
    // prefix show up for the common case instead of only the rare
    // manually-overridden one.
    if (!Number.isFinite(raw) && behaviorType === 'zener_diode') {
      raw = def.model_params?.[inst.props?.model]?.vz;
    }
    if (!Number.isFinite(raw)) return label;
    const formatted = key === 'capacitance' ? Utils.formatCapacitance(raw)
                     : key === 'zener_voltage' ? `${(Math.round(raw*10)/10)}V`
                     : Utils.formatResistance(raw);
    return `${formatted} ${label}`;
  }

  function updateLegDrag(){
    if(!_dragInst||!_dragAnchorLeg||_dragLegIdx<0||!_hoverHole) return;
    if(_hoverHole.row===_dragAnchorLeg.row&&_hoverHole.col===_dragAnchorLeg.col) return;
    if(_dragInst.legs.length===2){
      _dragInst.legs[_dragLegIdx]=_hoverHole;
    }else if(_dragInst.legs.length===3){
      if(_dragLegIdx===0) _dragInst.legs[0]=_hoverHole;
      else if(_dragLegIdx===2) _dragInst.legs[2]=_hoverHole;
      const a=holeToXY(_dragInst.legs[0].row,_dragInst.legs[0].col);
      const b=holeToXY(_dragInst.legs[2].row,_dragInst.legs[2].col);
      const mid=xyToHole((a.x+b.x)/2,(a.y+b.y)/2,HOLE_PITCH);
      if(mid) _dragInst.legs[1]=mid;
    }
  }

  function updateWireDrag(){
    if(!_dragWire||_dragWireEnd<0||!_hoverHole) return;
    const other = _dragWireEnd===1 ? {row:_dragWire.r2,col:_dragWire.c2} : {row:_dragWire.r1,col:_dragWire.c1};
    if(_hoverHole.row===other.row&&_hoverHole.col===other.col) return; // don't collapse to zero length
    if(_dragWireEnd===1){_dragWire.r1=_hoverHole.row;_dragWire.c1=_hoverHole.col;}
    else{_dragWire.r2=_hoverHole.row;_dragWire.c2=_hoverHole.col;}
  }

  function onMouseDown(e){
    if(e.button!==0) return;
    const {x,y}=eventToCanvas(e);
    const engaged = typeof isCircuitEngaged==='function' && isCircuitEngaged();
    if(Wire.isWiring()){
      if(engaged) return; // can't start/finish a wire while the circuit's actually engaged
      const h=xyToHole(x,y);if(h) Wire.startOrFinish(h);return;
    }
    if(_pasteActive){if(!engaged) confirmPaste(x,y);return;}
    if(_pasteWireActive){if(!engaged) confirmPasteWire(x,y);return;}
    if(typeof isMeasuring==='function' && isMeasuring()) return; // Voltmeter/Probe are hover-only, per the doc
    const legHit=hitTestLeg(x,y);
    if(legHit){
      if(engaged) return; // dragging a leg is a rewiring action, locked while engaged
      _dragMode='leg-dragging';_dragInst=legHit.inst;_dragLegIdx=legHit.legIdx;
      _savedLegs=legHit.inst.legs.map(l=>({...l}));
      _dragAnchorLeg=legHit.inst.legs.length===2?legHit.inst.legs[legHit.legIdx===0?1:0]:legHit.inst.legs[legHit.legIdx===0?2:0];
      return;
    }
    const wireEndHit=hitTestWireEnd(x,y);
    if(wireEndHit){
      if(!engaged){
        _dragMode='wire-dragging';_dragWire=wireEndHit.wire;_dragWireEnd=wireEndHit.end;
        _savedWireEnds={r1:wireEndHit.wire.r1,c1:wireEndHit.wire.c1,r2:wireEndHit.wire.r2,c2:wireEndHit.wire.c2};
      }
      setSelected(null,wireEndHit.wire.id);return; // selecting/viewing stays available while engaged, only the drag is locked
    }
    const inst=hitTestComp(x,y);
    if(inst){
      const def=ComponentRegistry.getById(inst.defId);
      if(def?.behavior?.type==='switch_spst' && (inst.props.type==='Momentary (NO)'||inst.props.type==='Momentary (NC)')){
        // A momentary footswitch is a real-time stompbox press, not a
        // component swap — stays live regardless of engaged state.
        _pressedSwitchInst=inst;inst._pressed=true;Simulation.notifyStateChange(inst);render();
      }
      if(def?.behavior?.type==='switch_mpdt' && inst.props?.type==='Momentary'
         && (inst.props?.throw_type==='On-On'||inst.props?.throw_type==='On-Off-On')){
        // Real (ON)-(ON) / (ON)-OFF-(ON) hardware: press-and-hold moves to
        // the held position, release springs back to rest. Scoped to the
        // toggle pill (like Latching's click-to-cycle), not the whole body —
        // a real center-off paddle has two distinct physical push
        // directions, and a single "press anywhere" can't tell which one
        // was meant. Splitting the pill in half (left = push toward
        // position 1, right = push toward position 3) is what actually
        // recovers that distinction — mirrors the pill's own visual lean.
        // A first version of this used the switch's PRIOR position to guess
        // press direction, which was wrong: a momentary switch always sits
        // at rest between presses, so that guess degenerated to always
        // resolving the same direction, making the other position
        // unreachable. Left/right click position is real, unambiguous
        // input; whatever the switch happened to be sitting at is not.
        const r=switchToggleRect(inst);
        if(x>=r.left&&x<=r.right&&y>=r.top&&y<=r.bottom){
          const restPos = inst.props.throw_type==='On-On' ? 1 : 2;
          const heldPos = inst.props.throw_type==='On-On' ? 2 : (x<r.cx ? 1 : 3);
          inst._mpdtRestPos = restPos;
          inst.props.position = String(heldPos);
          _pressedSwitchInst=inst;inst._pressed=true;
          Simulation.notifyStateChange(inst);render();
        }
      }
      if(!engaged){
        _dragMode='comp-pending';_dragInst=inst;
        _dragStartX=x;_dragStartY=y;_dragOffsetX=0;_dragOffsetY=0;
        _savedLegs=inst.legs.map(l=>({...l}));
      }
      setSelected(inst.instanceId,null);return;
    }
    const wire=hitTestWire(x,y);
    if(wire){
      if(!engaged && typeof currentTool==='function' && currentTool()==='select'){
        _dragMode='wire-pending';_dragWireMove=wire;
        _savedWireMoveEnds={r1:wire.r1,c1:wire.c1,r2:wire.r2,c2:wire.c2};
        _dragStartX=x;_dragStartY=y;_dragOffsetX=0;_dragOffsetY=0;
      }
      setSelected(null,wire.id);return;
    }
    setSelected(null,null);
  }

  // Shared release path for a currently-held momentary switch, used by both
  // onMouseUp (release inside the canvas) and onWindowMouseUp (release
  // anywhere else — the mouse can leave the canvas while still held down).
  // For switch_mpdt, springs the position back to whatever rest position was
  // recorded at press time (_mpdtRestPos, set in onMouseDown) rather than
  // just clearing a flag the way SPST's open/closed state does — a
  // throw-select switch's "released" state IS a specific position, not a
  // separate boolean.
  function releasePressedSwitch(){
    if(!_pressedSwitchInst) return;
    const inst=_pressedSwitchInst;
    inst._pressed=false;
    if(inst._mpdtRestPos!=null){ inst.props.position=String(inst._mpdtRestPos); inst._mpdtRestPos=null; }
    Simulation.notifyStateChange(inst);render();
    _pressedSwitchInst=null;
  }

  function onMouseUp(e){
    if(e.button!==0) return;
    releasePressedSwitch();
    if(_dragMode==='leg-dragging'){
      if(_dragInst){
        const legDef=ComponentRegistry.getById(_dragInst.defId);
        if(legDef && !legSpanValid(legDef.category, _dragInst.legs.length, _dragInst.legs.map(l=>l.col))){
          if(_savedLegs) _dragInst.legs=_savedLegs.map(l=>({...l}));
          if(typeof setStatus==='function') setStatus(I18n.t('app.board.legSpanInvalid'));
        }
      }
      _dragMode='idle';_dragInst=null;_dragAnchorLeg=null;_dragLegIdx=-1;Storage.markDirty();History.push();render();return;
    }
    if(_dragMode==='wire-dragging'){_dragMode='idle';_dragWire=null;_dragWireEnd=-1;_savedWireEnds=null;Storage.markDirty();History.push();render();return;}
    if(_dragMode==='wire-moving'){
      if(_dragWireMove&&_savedWireMoveEnds){
        const a0=holeToXY(_savedWireMoveEnds.r1,_savedWireMoveEnds.c1);
        const snappedA=xyToHole(a0.x+_dragOffsetX, a0.y+_dragOffsetY, DROP_SNAP_RADIUS);
        if(snappedA){
          const aNew=holeToXY(snappedA.row,snappedA.col);
          const pdx=aNew.x-a0.x, pdy=aNew.y-a0.y;
          const b0=holeToXY(_savedWireMoveEnds.r2,_savedWireMoveEnds.c2);
          const snappedB=xyToHole(b0.x+pdx, b0.y+pdy, DROP_SNAP_RADIUS);
          const wouldCollapse = snappedB && snappedB.row===snappedA.row && snappedB.col===snappedA.col;
          const wouldOverlap  = snappedB && !wouldCollapse &&
            (holeOccupied(snappedA.row,snappedA.col,null,_dragWireMove) || holeOccupied(snappedB.row,snappedB.col,null,_dragWireMove));
          if(snappedB && !wouldCollapse && !wouldOverlap){
            _dragWireMove.r1=snappedA.row; _dragWireMove.c1=snappedA.col;
            _dragWireMove.r2=snappedB.row; _dragWireMove.c2=snappedB.col;
          } else if(wouldOverlap && typeof setStatus==='function') {
            setStatus(I18n.t('app.board.holeOccupied'));
          } // else: no valid spot for the other end, or it'd collapse to zero length — leave the wire at its original position
        } // no hole nearby the reference endpoint: leave the wire at its original position
      }
      _dragMode='idle';_dragWireMove=null;_savedWireMoveEnds=null;_dragOffsetX=0;_dragOffsetY=0;
      document.body.classList.remove('dragging');
      Storage.markDirty();History.push();render();return;
    }
    if(_dragMode==='wire-pending'){_dragMode='idle';_dragWireMove=null;_savedWireMoveEnds=null;}
    if(_dragMode==='comp-dragging'){
      if(_dragInst&&_savedLegs){
        const ref=_savedLegs[0];
        const {x:rx,y:ry}=holeToXY(ref.row,ref.col);
        const snapped=xyToHole(rx+_dragOffsetX, ry+_dragOffsetY, DROP_SNAP_RADIUS);
        if(snapped){
          const refNew=holeToXY(snapped.row,snapped.col);
          const pdx=refNew.x-rx, pdy=refNew.y-ry;
          const newLegs=[snapped];
          let ok=true;
          for(let i=1;i<_savedLegs.length;i++){
            const l=_savedLegs[i];
            const {x:lx,y:ly}=holeToXY(l.row,l.col);
            const h=xyToHole(lx+pdx,ly+pdy,DROP_SNAP_RADIUS);
            if(!h){ok=false;break;}
            newLegs.push(h);
          }
          if(ok && newLegs.some(l => holeOccupied(l.row,l.col,_dragInst.instanceId,null))){
            ok=false;
            if (typeof setStatus==='function') setStatus(I18n.t('app.board.holeOccupied'));
          }
          if(ok) _dragInst.legs=newLegs;
        } // no hole nearby the reference leg: leave the part at its original position
      }
      _dragMode='idle';_dragOffsetX=0;_dragOffsetY=0;
      document.body.classList.remove('dragging');
      Storage.markDirty();History.push();_dragInst=null;render();return;
    }
    if(_dragMode==='comp-pending'){_dragMode='idle';_dragInst=null;}
  }

  function onWindowMouseUp(){
    releasePressedSwitch();
    if(_dragMode==='comp-dragging'||_dragMode==='leg-dragging'){
      if(_dragInst&&_savedLegs) _dragInst.legs=_savedLegs.map(l=>({...l}));
      _dragMode='idle';_dragOffsetX=0;_dragOffsetY=0;
      document.body.classList.remove('dragging');
      _dragInst=null;_dragAnchorLeg=null;_dragLegIdx=-1;render();
    }
    if(_dragMode==='wire-dragging'){
      if(_dragWire&&_savedWireEnds) Object.assign(_dragWire,_savedWireEnds);
      _dragMode='idle';_dragWire=null;_dragWireEnd=-1;_savedWireEnds=null;render();
    }
    if(_dragMode==='wire-moving'){
      if(_dragWireMove&&_savedWireMoveEnds) Object.assign(_dragWireMove,_savedWireMoveEnds);
      _dragMode='idle';document.body.classList.remove('dragging');_dragWireMove=null;_savedWireMoveEnds=null;render();
    }
    if(_dragMode==='wire-pending'){_dragMode='idle';_dragWireMove=null;_savedWireMoveEnds=null;}
    if(_dragMode==='comp-pending'){_dragMode='idle';_dragInst=null;}
  }

  function onBoardKeyDown(e){
    if(e.code==='Escape'&&(_dragMode==='comp-dragging'||_dragMode==='leg-dragging')){
      if(_dragInst&&_savedLegs) _dragInst.legs=_savedLegs.map(l=>({...l}));
      _dragMode='idle';_dragOffsetX=0;_dragOffsetY=0;
      document.body.classList.remove('dragging');
      _dragInst=null;_dragAnchorLeg=null;_dragLegIdx=-1;render();
    }
    if(e.code==='Escape'&&_dragMode==='wire-dragging'){
      if(_dragWire&&_savedWireEnds) Object.assign(_dragWire,_savedWireEnds);
      _dragMode='idle';_dragWire=null;_dragWireEnd=-1;_savedWireEnds=null;render();
    }
    if(e.code==='Escape'&&_dragMode==='wire-moving'){
      if(_dragWireMove&&_savedWireMoveEnds) Object.assign(_dragWireMove,_savedWireMoveEnds);
      _dragMode='idle';document.body.classList.remove('dragging');_dragWireMove=null;_savedWireMoveEnds=null;render();
    }
  }

  function onClick(e){
    if(_dragMode!=='idle') return;
    const {x,y}=eventToCanvas(e);
    const inst=hitTestComp(x,y);if(!inst) return;
    const def=ComponentRegistry.getById(inst.defId);
    // Toggling only fires when the click actually lands on the toggle pill
    // itself, not anywhere on the switch's body/pin grid — per direct
    // instruction. hitTestComp still selects/drags on the whole body (that's
    // unrelated and unchanged); this is an extra, narrower gate specific to
    // the toggle action.
    if((def?.behavior?.type==='switch_spst'||def?.behavior?.type==='switch_mpdt')){
      const r=switchToggleRect(inst);
      if(x<r.left||x>r.right||y<r.top||y>r.bottom) return;
    }
    if(def?.behavior?.type==='switch_spst'){
      const t=inst.props.type;
      if(t!=='Momentary (NO)' && t!=='Momentary (NC)'){
        // Writes props.state, not a separate _state flag — props is what
        // getLayoutData serializes, so the toggle now survives save/reload
        // and is captured by History.push() below. See Utils.isSwitchClosed.
        inst.props.state=(inst.props.state==='Closed')?'Open':'Closed';Simulation.notifyStateChange(inst);Storage.markDirty();History.push();render();
      }
    }
    // Momentary mpdt switches are driven entirely by press/release
    // (onMouseDown/releasePressedSwitch) — a click is just the mousedown+
    // mouseup pair that already ran that logic, so the latching cycle below
    // must not ALSO fire and move the position a second time. Same
    // exclusion shape as SPST's Momentary (NO)/(NC) check just above.
    const mpdtIsMomentary = def?.behavior?.type==='switch_mpdt' && inst.props?.type==='Momentary'
      && (inst.props?.throw_type==='On-On'||inst.props?.throw_type==='On-Off-On');
    if(def?.behavior?.type==='switch_mpdt' && !mpdtIsMomentary){
      // A real mechanical toggle can't skip a position — clicking always
      // advances in the CURRENT direction of travel and reverses at either
      // end (1->2->3->2->1...), not a plain wrap-around cycle. Direction is
      // tracked in _mpdtDir (runtime only, not serialized — a fresh load
      // always starts as if just having arrived from below, matching how a
      // freshly-placed switch has no prior click history).
      const maxPos = inst.props?.throw_type==='On-On' ? 2 : 3;
      const cur = Utils.clamp(parseInt(inst.props?.position,10)||1, 1, maxPos);
      let dir = inst._mpdtDir || 1;
      let next = cur + dir;
      if (next > maxPos) { dir = -1; next = cur + dir; }
      else if (next < 1)  { dir = 1;  next = cur + dir; }
      inst._mpdtDir = dir;
      inst.props.position = String(Utils.clamp(next, 1, maxPos));
      Simulation.notifyStateChange(inst);Storage.markDirty();History.push();render();
    }
  }

  function onDrop(e){
    e.preventDefault();
    const defId=e.dataTransfer.getData('text/plain');if(!defId) return;
    if(typeof isCircuitEngaged==='function' && isCircuitEngaged()){
      if(typeof setStatus==='function') setStatus(I18n.t('app.board.stopToAdd'));
      return;
    }
    // Every switch (SPST/SPDT/DPDT/3PDT) always routes into the External
    // Switches panel regardless of where the user actually drops it — they
    // can't physically exist anywhere else on this board (no board-hole
    // coordinates apply to any of them). Bypasses the whole xyToHole/DIP-
    // anchor snap path below entirely, since that machinery is board-hole-
    // specific and doesn't apply here.
    const dropDefEarly=ComponentRegistry.getById(defId);
    if(dropDefEarly?.behavior?.type==='switch_mpdt'||dropDefEarly?.behavior?.type==='switch_spst'){
      finalizePlacement(defId, findFreeExtSlot(), null);
      return;
    }
    const {x,y}=eventToCanvas(e);
    // The ghost (drawPaletteGhost) renders centered on the cursor — legs at
    // -halfLen/+halfLen either side of (mx,gy) — but createInstance()/
    // buildLegs() always anchors leg[0] (the left-most leg) at whatever hole
    // is passed in. Snapping directly on the raw cursor position therefore
    // places leg[0] under the cursor instead of the component's center,
    // shifting the whole part right by halfLen from where the ghost showed
    // it. Snap from a point shifted left by halfLen instead, so the final
    // placement matches the ghost's visual center. power_supply is excluded:
    // its own leg-reassignment logic below already re-anchors to whichever
    // leg lands on a rail, independent of this offset.
    let snapX=x;
    if(defId!=='power_supply'){
      const def=ComponentRegistry.getById(defId);
      if(def){
        if(def.category==='ic' && (def.legs||0)>=8){
          // DIP package: the ghost is centered on the cursor (pins span
          // -(perSide/2-0.5)..+(perSide/2-0.5) * HOLE_PITCH), but
          // buildDipLegs anchors pin 1 (the rightmost pin) at the passed
          // column, not the center — so the snap offset has to match that
          // half-span, not the generic 2/3-leg span/2 math below (which for
          // this part's leg_span:0 would wrongly fall back to a single
          // HOLE_PITCH/2 offset and land the real part shifted from where
          // the ghost showed it). 1.5 for DIP-8 (perSide=4), 3.5 for a
          // 16-pin part like the PT2399 (perSide=8) — generalized from the
          // original hardcoded 1.5 so any DIP leg count lands correctly.
          const perSide=(def.legs||8)/2;
          snapX=x-((perSide/2-0.5)*HOLE_PITCH);
        } else {
          const span=def.leg_span||1;
          snapX=x-(span*HOLE_PITCH/2);
        }
      }
    }
    const hole=xyToHole(snapX,y,DROP_SNAP_RADIUS);if(!hole) return;
    if(typeof hole.row==='number'){
      const dropDef=ComponentRegistry.getById(defId);
      if(dropDef?.category==='ic' && (dropDef.legs||0)>=8){
        // Only 2 of every 5 columns are valid DIP anchors, so a drop aimed
        // by eye lands in the invalid dead zone more often than not — snap
        // to the nearest valid anchor instead of rejecting, the same way
        // xyToHole already snaps to the nearest hole rather than requiring
        // pixel-perfect aim.
        const snapped=nearestValidDipAnchor(hole.col, (dropDef.legs||8)/2);
        if(snapped!=null) hole.col=snapped;
      }
    }
    finalizePlacement(defId, hole, null);
  }

  // Shared by drag-and-drop placement (onDrop) and Paste's click-to-confirm
  // placement (confirmPaste) — both end up creating one new instance at a
  // hole, with the same power_supply rail-orientation snapping either way.
  // `overrideProps`, when given (Paste), replaces the definition's defaults
  // with the copied component's actual values.
  function finalizePlacement(defId, hole, overrideProps){
    const inst=ComponentRegistry.createInstance(defId,hole.row,hole.col);
    if (overrideProps) inst.props = {...overrideProps};

    if (defId==='power_supply' && inst.legs.length===2) {
      const def  = ComponentRegistry.getById(defId);
      const span = def.leg_span || 2;
      const orig = inst.legs[0];
      const {x:x0,y:y0} = holeToXY(orig.row, orig.col);
      const other = xyToHole(x0, y0 - span*HOLE_PITCH, DROP_SNAP_RADIUS)
                 || xyToHole(x0, y0 + span*HOLE_PITCH, DROP_SNAP_RADIUS);
      if (other) {
        const railPol = row => (row==='rtp'||row==='rbp') ? '+' : (row==='rtm'||row==='rbm') ? '-' : null;
        const origPol = railPol(orig.row), otherPol = railPol(other.row);
        if (origPol!=null || otherPol!=null) {
          // Only reassign legs when this placement is actually near a rail —
          // otherwise `other` is just some hole two rows away in the same
          // ordinary row-group, which is already one net on a real
          // breadboard. Reassigning legs there would put both of the
          // supply's own terminals on the same net — a self-short, not a
          // conflict with anything else on the board.
          if (origPol==='+' || otherPol==='-') {
            inst.legs = [other, orig]; // orig is the + one -> leg 1
          } else if (origPol==='-' || otherPol==='+') {
            inst.legs = [orig, other]; // orig is the – one -> leg 0
          } else {
            const {y:oy} = holeToXY(other.row, other.col);
            inst.legs = (oy < y0) ? [other, orig] : [orig, other];
          }
        }
        // else: not near a rail — keep createInstance's default horizontal
        // 2-hole layout (already two genuinely distinct nets/columns).
      }
      // else: leave the default horizontal 2-hole layout — better than an
      // invalid placement.
    }

    if (inst.legs.some(l => holeOccupied(l.row, l.col, null, null))) {
      if (typeof setStatus==='function') setStatus(I18n.t('app.board.holeOccupied'));
      return null;
    }

    {
      const legDef = ComponentRegistry.getById(defId);
      if (legDef && !legSpanValid(legDef.category, inst.legs.length, inst.legs.map(l=>l.col))) {
        if (typeof setStatus==='function') setStatus(I18n.t('app.board.legSpanInvalid'));
        return null;
      }
    }

    _placed.push(inst);setSelected(inst.instanceId,null);
    if(_onPlace) _onPlace(inst);
    History.push();render();
    return inst;
  }

  // ── Paste ────────────────────────────────────────────────────────────────
  // Ghost rendering reuses _paletteGhost/drawPaletteGhost (already generic —
  // render() draws it on every mousemove regardless of what triggered it);
  // this just adds a click-to-confirm placement path distinct from the
  // drag-and-drop one, since Paste has no drag gesture to hook a 'drop'
  // event off of.
  let _pasteActive=false;

  function beginPaste(defId, props){
    _pasteActive=true;
    _paletteGhost={defId, clipboardProps:props};
    render(_mouseX,_mouseY);
  }
  function cancelPaste(){
    if(!_pasteActive) return;
    _pasteActive=false;
    _paletteGhost=null;
    render();
  }
  function confirmPaste(x,y){
    // Same cursor-is-center vs leg[0]-is-anchor mismatch as onDrop — see the
    // comment there. clipboardProps has no bearing on leg_span, so this
    // looks up the definition the same way.
    const {defId, clipboardProps} = _paletteGhost;
    let snapX=x;
    if(defId!=='power_supply'){
      const def=ComponentRegistry.getById(defId);
      if(def){
        if(def.category==='ic' && (def.legs||0)>=8){
          const perSide=(def.legs||8)/2; // see onDrop's matching comment
          snapX=x-((perSide/2-0.5)*HOLE_PITCH);
        } else {
          const span=def.leg_span||1;
          snapX=x-(span*HOLE_PITCH/2);
        }
      }
    }
    const hole=xyToHole(snapX,y,DROP_SNAP_RADIUS);
    if(!hole) return; // missed a valid hole — stay in paste mode, let them try again
    {
      const pasteDef=ComponentRegistry.getById(defId);
      if(pasteDef?.category==='ic' && (pasteDef.legs||0)>=8){
        const snapped=nearestValidDipAnchor(hole.col, (pasteDef.legs||8)/2);
        if(snapped!=null) hole.col=snapped;
      }
    }
    const placed=finalizePlacement(defId, hole, clipboardProps);
    if(!placed) return; // collided with an existing component — stay in paste mode, let them try elsewhere
    _pasteActive=false;
    _paletteGhost=null;
    if (typeof exitToolToSelect==='function') exitToolToSelect(); // one paste, then back to Select — same as a normal placement
  }

  // ── Wire copy/paste ─────────────────────────────────────────────────────
  // Same column-only philosophy as whole-wire dragging (see the note by
  // _dragWireMove above): a pasted wire keeps its exact original shape (both
  // endpoints' relative position, in pixels, from the shape's own midpoint —
  // same idea as a component's legs being fixed relative to its body) and
  // is positioned freely, cursor-as-midpoint (matching the component ghost's
  // cursor-is-center convention). Each endpoint snaps independently via
  // xyToHole on confirm, so numeric rows and rail-keys both fall out
  // naturally with no special-casing.
  let _pasteWireActive=false, _pasteWireData=null;

  function beginPasteWire(wire){
    _pasteWireActive=true;
    const a=holeToXY(wire.r1,wire.c1), b=holeToXY(wire.r2,wire.c2);
    const midX=(a.x+b.x)/2, midY=(a.y+b.y)/2;
    _pasteWireData={dxA:a.x-midX,dyA:a.y-midY,dxB:b.x-midX,dyB:b.y-midY,color:wire.color};
    render(_mouseX,_mouseY);
  }
  function cancelPasteWire(){
    if(!_pasteWireActive) return;
    _pasteWireActive=false;
    _pasteWireData=null;
    render();
  }
  function confirmPasteWire(x,y){
    if(!_pasteWireData) return;
    const holeA=xyToHole(x+_pasteWireData.dxA,y+_pasteWireData.dyA,DROP_SNAP_RADIUS);
    const holeB=xyToHole(x+_pasteWireData.dxB,y+_pasteWireData.dyB,DROP_SNAP_RADIUS);
    if(!holeA||!holeB) return; // missed a valid hole for one end — stay in paste mode, let them try again
    if(holeA.row===holeB.row&&holeA.col===holeB.col) return; // would collapse to zero length — same, try again
    if(holeOccupied(holeA.row,holeA.col,null,null) || holeOccupied(holeB.row,holeB.col,null,null)){
      if (typeof setStatus==='function') setStatus(I18n.t('app.board.holeOccupied'));
      return; // stay in paste mode, let them try elsewhere
    }
    addWire({id:Utils.uid('W'), r1:holeA.row, c1:holeA.col, r2:holeB.row, c2:holeB.col, color:_pasteWireData.color});
    _pasteWireActive=false;
    _pasteWireData=null;
    Storage.markDirty();History.push();
    if (typeof exitToolToSelect==='function') exitToolToSelect(); // one paste, then back to Select — same as a normal placement
  }
  function isPastingWire(){ return _pasteWireActive; }

  // Called from app.js's Escape handling — cancels whichever paste mode (if
  // any) is currently active, returning true if it did so, so the caller
  // knows not to fall through to other Escape behaviors.
  function cancelActivePaste(){
    if(_pasteActive){cancelPaste();return true;}
    if(_pasteWireActive){cancelPasteWire();return true;}
    return false;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────
  const WIRE_COLORS=['#ff9900','#ff3333','#3399ff','#33cc66','#cc33ff','#ffee33','#ffffff','#ff6699'];
  let _wireColorIdx=0;

  function setStartWire(h){_wiringStart=h;render();}
  function clearWire(){_wiringStart=null;render();}
  function addWire(w){_wires.push(w);render();}
  function getWires(){return _wires;}
  function nextWireColor(){return WIRE_COLORS[(_wireColorIdx++)%WIRE_COLORS.length];}

  function setSelected(compId,wireId){
    _selectedComp=compId;_selectedWire=wireId;
    const inst=compId?_placed.find(p=>p.instanceId===compId):null;
    const wire=wireId?_wires.find(w=>w.id===wireId):null;
    if(_onSelect) _onSelect(inst,wire);
    document.body.classList.toggle('comp-selected',!!inst);
    render();
  }
  function getSelected(){return _placed.find(p=>p.instanceId===_selectedComp)||null;}
  function getSelectedWireObj(){return _wires.find(w=>w.id===_selectedWire)||null;}

  // ── Overlap prevention ──────────────────────────────────────────────────
  // No component leg or wire endpoint may land on a hole already occupied by
  // any other leg/endpoint (component or wire) — flat rule, no exceptions.
  // This costs nothing electrically: same-column holes are already bonded
  // (see buildNetMap in simulation.js), so connecting to an occupied node
  // just means using a different, free hole in that same column — exactly
  // how this works on a real breadboard.
  //
  // EXCEPTION: a switch pin ('sw:<instanceId>:<rowIdx>' virtual rows, see
  // holeToXY/xyToHole/switchPinXY) is exempt from the "leg already there"
  // half of this rule when the leg belongs to the switch pin's OWN row/col —
  // i.e. it's still blocked from having a SECOND switch's leg land there
  // (can't happen structurally, each instanceId's rows are private) or a
  // wire already terminating there (that part of the rule still applies
  // unchanged below), but a wire IS allowed to terminate at the exact same
  // point the switch's own leg occupies. The "just use a different hole in
  // the same bonded column" escape hatch the flat rule relies on does not
  // exist for switches: each pin is a private, isolated point in the
  // External Switches panel with no other empty hole sharing its net, unlike
  // a real board's 5-hole strip where a component leg always leaves 4 spare
  // holes on the same net. Without this exception, no switch pin could ever
  // be wired to anything at all — confirmed as a real, reproduced bug where
  // every click on a switch pin in Jumper mode silently exited to Select.
  function holeOccupied(row,col,excludeInstanceId,excludeWire){
    const isSwitchPin = typeof row==='string' && row.startsWith('sw:');
    for(const p of _placed){
      if(p.instanceId===excludeInstanceId) continue;
      for(const l of p.legs){
        if(l.row!==row||l.col!==col) continue;
        if(isSwitchPin) continue; // this IS the switch's own leg at its own pin — not a collision, see comment above
        return true;
      }
    }
    for(const w of _wires){
      if(w===excludeWire) continue;
      if((w.r1===row&&w.c1===col)||(w.r2===row&&w.c2===col)) return true;
    }
    return false;
  }
  function deleteSelected(){
    if(typeof isCircuitEngaged==='function' && isCircuitEngaged()){
      if(typeof setStatus==='function') setStatus(I18n.t('app.board.stopToRemove'));
      return;
    }
    if(_selectedComp){_placed=_placed.filter(p=>p.instanceId!==_selectedComp);setSelected(null,null);return;}
    if(_selectedWire){_wires=_wires.filter(w=>w.id!==_selectedWire);setSelected(null,null);return;}
  }

  function setZoom(z){_zoom=z;}
  function getPlaced(){return _placed;}
  function setDragGhost(defId){_paletteGhost=defId?{defId}:null;}
  function onSelect(fn){_onSelect=fn;}
  function onPlace(fn){_onPlace=fn;}
  function redraw(){render();}

  function clear(){_placed=[];_wires=[];setSelected(null,null);}
  function loadLayout(layout){
    _placed=layout.components||[];_wires=layout.wires||[];setSelected(null,null);
    if (typeof WorkbenchStrip !== 'undefined' && WorkbenchStrip.setPermanentState) {
      WorkbenchStrip.setPermanentState(layout.permanentDevices);
    }
    render();
    // The power leads spanning the strip and the board are drawn by
    // TraceOverlay, on its own canvas above both — and which rail each one
    // lands on depends on the reverse_polarity we just loaded. Editing that
    // property re-renders the overlay (see properties-panel.js), but loading
    // a file did not, so a saved positive-ground circuit came up showing
    // normal-polarity leads until something else happened to repaint.
    if (typeof TraceOverlay !== 'undefined' && TraceOverlay.render) TraceOverlay.render();
  }
  function getLayoutData(){
    const permanentDevices = (typeof WorkbenchStrip !== 'undefined' && WorkbenchStrip.getPermanentState)
      ? WorkbenchStrip.getPermanentState() : undefined;
    // Strip ALL runtime state rather than an explicit list. The list version
    // kept falling behind: it named _voltage/_current/_state/etc but not
    // _vceHeadroom, _saturated, _rLow, _rHigh, so solver output was written
    // into saved .rye files and reloaded as if it were user data. Every new
    // per-tick field silently joined the leak (_swingUp/_swingDown were the
    // most recent). Convention: anything the solver writes onto an instance
    // is prefixed with _, and nothing prefixed with _ is ever saved.
    return{components:_placed.map(inst=>{
      const c=Utils.clone(inst);
      for(const k of Object.keys(c)) if(k.charCodeAt(0)===95) delete c[k]; // '_'
      delete c.failed; delete c.failureType;
      return c;
    }),wires:_wires,permanentDevices};
  }

  return{init,render,clear,loadLayout,getLayoutData,getPlaced,getWires,addWire,nextWireColor,
    setDragGhost,setStartWire,clearWire,setSelected,getSelected,getSelectedWireObj,deleteSelected,
    onSelect,onPlace,holeToXY,xyToHole,redraw,setZoom,getZoom:()=>_zoom,getBoardWidth:boardWidth,
    beginPaste,cancelPaste,beginPasteWire,cancelPasteWire,isPastingWire,cancelActivePaste,
    holeOccupied,rowDisplayLabel,drawSwitchGhost,switchShape,getColors:C,
    SW_PIN_PITCH,SW_BODY_MARGIN,SW_TOGGLE_H,SW_TOGGLE_BOTTOM_PAD};
})();