// ── Board Canvas Renderer ─────────────────────────────────────────────────────
//
// COMPONENT POSITION MODEL (new in rw5):
//   Each placed component stores leg positions as an array of { row, col } objects.
//   inst.legs = [{ row, col }, { row, col }, ...]   (one entry per physical leg)
//
//   The body center and rotation angle are DERIVED from leg[0] and leg[last]:
//     cx, cy  = midpoint of leg[0] and leg[last] pixel positions
//     angle   = Math.atan2(dy, dx) between those two points
//
//   Legacy format (inst.row/inst.col) is migrated by storage.js on load.

const Board = (() => {

  // ── Constants ────────────────────────────────────────────────────────────────
  const COLS        = 63;
  const HOLE_PITCH  = 20;
  const GROUP_GAP   = 6;
  const HOLE_R      = 3.2;
  const RAIL_BREAK  = 31;
  const ROW_LABELS  = ['a','b','c','d','e','f','g','h','i','j'];
  const ML = 52, MR = 52, MT = 14, MB = 14;
  const RAIL_PAD_V  = 10;
  const RAIL_STRIP_H = 2 * HOLE_PITCH + RAIL_PAD_V * 2;
  const RAIL_TO_GRID = 10;
  const DIP_GAP      = 18;
  const LABEL_PAD    = 8;
  const LEG_HIT_R    = 8;
  const WIRE_HIT_W   = 7;
  const DRAG_THRESHOLD = 4;

  // ── CSS vars ─────────────────────────────────────────────────────────────────
  const cv = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const C  = () => ({
    boardBg:   cv('--board-bg'),    stripe:     cv('--board-stripe'),
    hole:      cv('--board-hole'),  holeShadow: cv('--board-hole-shadow'),
    railRedBg: cv('--board-bus-r-bg'), railBlueBg: cv('--board-bus-b-bg'),
    railRed:   cv('--board-bus-r'), railBlue:   cv('--board-bus-b'),
    label:     cv('--board-label'),
    hover:     cv('--board-hover'), wireStart:  cv('--board-wire-start'),
    accent:    cv('--accent'),      warning:    cv('--warning'),
    alert:     cv('--alert'),       success:    cv('--success'),
    scopeTrace:cv('--scope-trace'),
  });

  // ── State ────────────────────────────────────────────────────────────────────
  let canvas, ctx, _layout = null;
  let _placed = [], _wires = [];
  let _selectedComp = null, _selectedWire = null;
  let _hoverHole = null;
  let _paletteGhost = null;
  let _wiringStart = null, _wiringEnd = null;
  let _zoom = 1.0;
  let _mouseX = 0, _mouseY = 0;

  // Interaction state machine
  let _dragMode  = 'idle'; // idle | comp-pending | comp-dragging | leg-dragging
  let _dragInst  = null;
  let _dragLegIdx = -1;    // which leg is being dragged
  let _dragAnchorLeg = null; // { row, col } — the OTHER leg that stays fixed
  let _dragStartX = 0, _dragStartY = 0;
  let _savedLegs  = null;  // for cancel on escape

  let _onSelect = null, _onPlace = null;

  // ── Layout geometry ──────────────────────────────────────────────────────────
  function holeX(col) {
    return ML + col * HOLE_PITCH + Math.floor(col / 5) * GROUP_GAP + HOLE_PITCH / 2;
  }

  function buildLayout() {
    let y = MT;
    const rtMin = y + RAIL_PAD_V + HOLE_PITCH / 2;
    const rtPlu = rtMin + HOLE_PITCH;
    y += RAIL_STRIP_H + RAIL_TO_GRID;
    const gridTopY = y;
    const rowY = {};
    for (let r = 5; r <= 9; r++) { rowY[r] = y + HOLE_PITCH / 2; y += HOLE_PITCH; }
    y += DIP_GAP;
    for (let r = 4; r >= 0; r--) { rowY[r] = y + HOLE_PITCH / 2; y += HOLE_PITCH; }
    y += RAIL_TO_GRID;
    const rbMin = y + RAIL_PAD_V + HOLE_PITCH / 2;
    const rbPlu = rbMin + HOLE_PITCH;
    y += RAIL_STRIP_H + MB;
    return {
      railTopMinusY: rtMin, railTopPlusY: rtPlu,
      railBotMinusY: rbMin, railBotPlusY: rbPlu,
      railTopStripTop: MT, railTopStripBot: MT + RAIL_STRIP_H,
      railBotStripTop: MT + RAIL_STRIP_H + RAIL_TO_GRID + 10*HOLE_PITCH + DIP_GAP + RAIL_TO_GRID,
      railBotStripBot: MT + RAIL_STRIP_H + RAIL_TO_GRID + 10*HOLE_PITCH + DIP_GAP + RAIL_TO_GRID + RAIL_STRIP_H,
      gridTopY, dipGapCenterY: MT + RAIL_STRIP_H + RAIL_TO_GRID + 5*HOLE_PITCH + DIP_GAP/2,
      rowY, totalHeight: y,
    };
  }

  const boardWidth  = () => holeX(COLS - 1) + HOLE_PITCH / 2 + MR;
  const boardHeight = () => (_layout || buildLayout()).totalHeight;

  function holeToXY(row, col) {
    const L = _layout, x = holeX(col);
    const y = row==='rtp'?L.railTopPlusY : row==='rtm'?L.railTopMinusY
            : row==='rbp'?L.railBotPlusY : row==='rbm'?L.railBotMinusY
            : L.rowY[row];
    return { x, y };
  }

  function xyToHole(px, py) {
    const snap = HOLE_PITCH * 0.65;
    for (const row of ['rtp','rtm','rbp','rbm']) {
      const { y } = holeToXY(row, 0);
      if (Math.abs(py - y) < snap)
        for (let c = 0; c < COLS; c++)
          if (Math.abs(px - holeX(c)) < snap) return { row, col: c };
    }
    for (let r = 0; r <= 9; r++) {
      const { y } = holeToXY(r, 0);
      if (Math.abs(py - y) < snap)
        for (let c = 0; c < COLS; c++)
          if (Math.abs(px - holeX(c)) < snap) return { row: r, col: c };
    }
    return null;
  }

  function eventToCanvas(e) {
    const r = canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) / _zoom, y: (e.clientY - r.top) / _zoom };
  }

  // ── Component geometry helpers ────────────────────────────────────────────────
  // Get pixel coords of each leg for an instance
  function instLegPixels(inst) {
    return inst.legs.map(l => holeToXY(l.row, l.col));
  }

  // Compute body center and rotation angle from legs[0] and legs[last]
  function instGeometry(inst) {
    const pts = instLegPixels(inst);
    const a   = pts[0], b = pts[pts.length - 1];
    const cx  = (a.x + b.x) / 2;
    const cy  = (a.y + b.y) / 2;
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    return { cx, cy, ang, len, a, b };
  }

  // Hit test: is (x,y) within the body bounding box (axis-aligned, generous)?
  function hitTestComp(x, y) {
    for (let i = _placed.length - 1; i >= 0; i--) {
      const inst = _placed[i];
      const { cx, cy } = instGeometry(inst);
      const def = ComponentRegistry.getById(inst.defId);
      if (!def) continue;
      const bw = (def.visual?.body_width  || 32) / 2 + 12;
      const bh = (def.visual?.body_height || 16) / 2 + 12;
      // Rotate test point into component-local space
      const { ang } = instGeometry(inst);
      const dx = x - cx, dy = y - cy;
      const lx = dx * Math.cos(-ang) - dy * Math.sin(-ang);
      const ly = dx * Math.sin(-ang) + dy * Math.cos(-ang);
      if (Math.abs(lx) < bw && Math.abs(ly) < bh) return inst;
    }
    return null;
  }

  // Hit test: is (x,y) near any leg of the selected component?
  // Returns { inst, legIdx } or null
  function hitTestLeg(x, y) {
    if (!_selectedComp) return null;
    const inst = _placed.find(p => p.instanceId === _selectedComp);
    if (!inst) return null;
    const def = ComponentRegistry.getById(inst.defId);
    if (def?.category === 'ic') return null;

    for (let i = 0; i < inst.legs.length; i++) {
      const { x: lx, y: ly } = holeToXY(inst.legs[i].row, inst.legs[i].col);
      if (Math.hypot(x - lx, y - ly) < LEG_HIT_R) return { inst, legIdx: i };
    }
    return null;
  }

  // Hit test wire
  function hitTestWire(x, y) {
    for (const w of _wires) {
      const a = holeToXY(w.r1, w.c1), b = holeToXY(w.r2, w.c2);
      if (distSeg(x, y, a.x, a.y, b.x, b.y) < WIRE_HIT_W) return w;
    }
    return null;
  }

  function distSeg(px, py, ax, ay, bx, by) {
    const dx = bx-ax, dy = by-ay, l2 = dx*dx+dy*dy;
    if (!l2) return Math.hypot(px-ax, py-ay);
    const t = Math.max(0, Math.min(1, ((px-ax)*dx+(py-ay)*dy)/l2));
    return Math.hypot(px-(ax+t*dx), py-(ay+t*dy));
  }

  // Given anchor hole (pixel) and a free-floating pixel endpoint,
  // find the nearest valid hole to the free end.
  function nearestHoleToPoint(px, py) {
    return xyToHole(px, py) || null;
  }

  // ── RENDER ───────────────────────────────────────────────────────────────────
  function render(ghostX, ghostY) {
    const c = C();
    ctx.clearRect(0, 0, boardWidth(), boardHeight());
    drawBoardSurface(c);
    drawWires(c);
    drawComponents(c);
    if (_paletteGhost) drawPaletteGhost(ghostX ?? _mouseX, ghostY ?? _mouseY);
  }

  // ── Board surface ─────────────────────────────────────────────────────────────
  function drawBoardSurface(c) {
    const W = boardWidth(), H = boardHeight(), L = _layout;
    ctx.fillStyle = c.boardBg; roundRect(ctx, 0, 0, W, H, 10); ctx.fill();
    ctx.fillStyle = c.stripe;
    for (let g = 1; g < Math.ceil(COLS / 5); g++) {
      const gx = holeX(g * 5) - HOLE_PITCH/2 - GROUP_GAP/2 - 0.5;
      ctx.fillRect(gx, L.gridTopY, 1, 10*HOLE_PITCH + DIP_GAP);
    }
    ctx.fillStyle = c.label; ctx.font = 'bold 9px IBM Plex Mono,monospace'; ctx.textAlign = 'center';
    ctx.fillText('DIP', ML/2, L.dipGapCenterY + 3);
    ctx.fillText('DIP', W - MR/2, L.dipGapCenterY + 3);
    drawRailStrip(c, 'top'); drawRailStrip(c, 'bot'); drawMainGrid(c);
  }

  function drawRailStrip(c, side) {
    const W = boardWidth(), L = _layout, isTop = side === 'top';
    const sT  = isTop ? L.railTopStripTop : L.railBotStripTop;
    const sB  = isTop ? L.railTopStripBot : L.railBotStripBot;
    const sH  = sB - sT;
    const mY  = isTop ? L.railTopMinusY : L.railBotMinusY;
    const pY  = isTop ? L.railTopPlusY  : L.railBotPlusY;
    const rx  = ML - 6, rw = W - ML - MR + 12;
    ctx.fillStyle = c.railBlueBg; ctx.fillRect(rx, sT, rw, sH/2);
    ctx.fillStyle = c.railRedBg;  ctx.fillRect(rx, sT + sH/2, rw, sH/2);
    const bx1 = holeX(RAIL_BREAK-1)+HOLE_PITCH/2+4, bx2 = holeX(RAIL_BREAK)-HOLE_PITCH/2-4;
    const lx1 = holeX(0)-HOLE_PITCH/2+2,             lx2 = holeX(COLS-1)+HOLE_PITCH/2-2;
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = c.railBlue; brokenLine(mY, lx1, bx1, bx2, lx2);
    ctx.strokeStyle = c.railRed;  brokenLine(pY, lx1, bx1, bx2, lx2);
    ctx.font = 'bold 11px IBM Plex Mono,monospace'; ctx.textAlign = 'center';
    ctx.fillStyle = c.railBlue;
    ctx.fillText('–', ML/2, mY+4); ctx.fillText('–', W-MR/2, mY+4);
    ctx.fillStyle = c.railRed;
    ctx.fillText('+', ML/2, pY+4); ctx.fillText('+', W-MR/2, pY+4);
    for (let col = 0; col < COLS; col++) {
      if (col === RAIL_BREAK) continue;
      drawRailHole(col, mY, c, 'blue', isTop ? 'rtm' : 'rbm');
      drawRailHole(col, pY, c, 'red',  isTop ? 'rtp' : 'rbp');
    }
  }

  function brokenLine(y, x1, bx1, bx2, x2) {
    ctx.beginPath(); ctx.moveTo(x1,y); ctx.lineTo(bx1,y); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(bx2,y); ctx.lineTo(x2,y); ctx.stroke();
  }

  function drawRailHole(col, y, c, color, railRow) {
    const x = holeX(col);
    const isHov = _hoverHole?.row === railRow && _hoverHole?.col === col;
    const isSrt = _wiringStart?.row === railRow && _wiringStart?.col === col;
    if (isHov || isSrt) {
      ctx.beginPath(); ctx.arc(x, y, HOLE_R*2.8, 0, Math.PI*2);
      ctx.fillStyle = isSrt ? c.wireStart : c.hover; ctx.fill();
    }
    ctx.beginPath(); ctx.arc(x+.5,y+.5,HOLE_R,0,Math.PI*2); ctx.fillStyle=c.holeShadow; ctx.fill();
    ctx.beginPath(); ctx.arc(x,y,HOLE_R,0,Math.PI*2);
    ctx.fillStyle = color==='blue'?'rgba(43,87,154,0.35)':'rgba(176,32,46,0.35)'; ctx.fill();
    ctx.beginPath(); ctx.arc(x,y,HOLE_R-1,0,Math.PI*2); ctx.fillStyle=c.hole; ctx.fill();
  }

  function drawMainGrid(c) {
    const L = _layout, W = boardWidth();
    ctx.font = '10px IBM Plex Mono,monospace'; ctx.fillStyle = c.label;
    for (let r = 0; r <= 9; r++) {
      const y = L.rowY[r];
      ctx.textAlign = 'right'; ctx.fillText(ROW_LABELS[r], ML-LABEL_PAD, y+3.5);
      ctx.textAlign = 'left';  ctx.fillText(ROW_LABELS[r], W-MR+LABEL_PAD, y+3.5);
    }
    ctx.font = '8px IBM Plex Mono,monospace'; ctx.textAlign = 'center';
    for (let col = 0; col < COLS; col++) {
      if ((col+1)%5!==0 && col!==0) continue;
      const x = holeX(col);
      ctx.fillText(col+1, x, L.rowY[5]-HOLE_PITCH/2-2);
      ctx.fillText(col+1, x, L.rowY[0]+HOLE_PITCH/2+9);
    }
    for (let r = 0; r <= 9; r++)
      for (let col = 0; col < COLS; col++) drawMainHole(r, col, c);
  }

  function drawMainHole(row, col, c) {
    const {x,y} = holeToXY(row, col);
    const isHov = _hoverHole?.row===row && _hoverHole?.col===col;
    const isSrt = _wiringStart?.row===row && _wiringStart?.col===col;
    if (isHov || isSrt) {
      ctx.beginPath(); ctx.arc(x,y,HOLE_R*2.8,0,Math.PI*2);
      ctx.fillStyle = isSrt ? c.wireStart : c.hover; ctx.fill();
    }
    ctx.beginPath(); ctx.arc(x+.5,y+.5,HOLE_R,0,Math.PI*2); ctx.fillStyle=c.holeShadow; ctx.fill();
    ctx.beginPath(); ctx.arc(x,y,HOLE_R,0,Math.PI*2); ctx.fillStyle=c.hole; ctx.fill();
  }

  // ── Wires ─────────────────────────────────────────────────────────────────────
  function drawWires(c) {
    for (const w of _wires) {
      const a = holeToXY(w.r1,w.c1), b = holeToXY(w.r2,w.c2);
      const isSel = w.id === _selectedWire;
      ctx.lineWidth = isSel ? 4 : 2.5; ctx.strokeStyle = w.color||'#ff9900'; ctx.lineCap = 'round';
      if (isSel) { ctx.shadowColor=c.warning; ctx.shadowBlur=6; }
      ctx.beginPath(); ctx.moveTo(a.x,a.y);
      Math.abs(b.y-a.y)<4 ? ctx.lineTo(b.x,b.y) : ctx.bezierCurveTo(a.x,a.y-18,b.x,b.y-18,b.x,b.y);
      ctx.stroke(); ctx.shadowBlur=0;
      for (const pt of [a,b]) {
        ctx.beginPath(); ctx.arc(pt.x,pt.y,3,0,Math.PI*2);
        ctx.fillStyle=w.color||'#ff9900'; ctx.fill();
      }
    }
    // In-progress jumper
    if (_wiringStart && _hoverHole) {
      const a=holeToXY(_wiringStart.row,_wiringStart.col), b=holeToXY(_hoverHole.row,_hoverHole.col);
      ctx.lineWidth=2; ctx.strokeStyle='rgba(200,120,32,0.65)';
      ctx.setLineDash([5,4]);
      ctx.beginPath(); ctx.moveTo(a.x,a.y); ctx.lineTo(b.x,b.y); ctx.stroke();
      ctx.setLineDash([]);
    }
    // Leg drag preview line
    if (_dragMode==='leg-dragging' && _dragAnchorLeg && _hoverHole) {
      const a=holeToXY(_dragAnchorLeg.row,_dragAnchorLeg.col), b=holeToXY(_hoverHole.row,_hoverHole.col);
      ctx.lineWidth=1.5; ctx.strokeStyle='rgba(43,87,154,0.5)';
      ctx.setLineDash([4,3]);
      ctx.beginPath(); ctx.moveTo(a.x,a.y); ctx.lineTo(b.x,b.y); ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // ── Components ────────────────────────────────────────────────────────────────
  function drawComponents(c) {
    for (const inst of _placed) drawInst(inst, c, false);
    // Leg targets on selected component
    if (_selectedComp) {
      const inst = _placed.find(p => p.instanceId===_selectedComp);
      if (inst) drawLegTargets(inst, c);
    }
  }

  function drawLegTargets(inst, c) {
    const def = ComponentRegistry.getById(inst.defId);
    if (def?.category==='ic') return;
    for (let i = 0; i < inst.legs.length; i++) {
      // Don't show drag target on center leg of transistors
      if (inst.legs.length===3 && i===1) continue;
      const {x,y} = holeToXY(inst.legs[i].row, inst.legs[i].col);
      ctx.beginPath(); ctx.arc(x,y,LEG_HIT_R,0,Math.PI*2);
      ctx.strokeStyle=c.accent; ctx.lineWidth=1.5;
      ctx.fillStyle='rgba(43,87,154,0.2)'; ctx.fill(); ctx.stroke();
      ctx.fillStyle=c.accent; ctx.font='bold 9px sans-serif'; ctx.textAlign='center';
      ctx.fillText('⟺',x,y+3);
    }
  }

  function drawInst(inst, c, isGhost) {
    const def = ComponentRegistry.getById(inst.defId);
    if (!def) return;
    const isSel  = inst.instanceId===_selectedComp;
    const isFail = inst.failed;
    const { cx, cy, ang, len } = instGeometry(inst);

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(ang);
    if (isGhost) ctx.globalAlpha = 0.45;
    if (isFail)  ctx.globalAlpha = (isGhost?0.45:1) * 0.35;

    const halfLen = len / 2;
    const bw = def.visual?.body_width  || 28;
    const bh = def.visual?.body_height || 14;
    const ll = def.visual?.lead_length || 8;

    // Selection halo
    if (isSel && !isGhost) {
      ctx.beginPath(); ctx.ellipse(0,0,bw/2+9,bh/2+9,0,0,Math.PI*2);
      ctx.strokeStyle=c.warning; ctx.lineWidth=2; ctx.stroke();
    }

    // Leads (from half-length outward)
    ctx.strokeStyle='#aaaaaa'; ctx.lineWidth=1.5;
    ctx.beginPath(); ctx.moveTo(-halfLen,0); ctx.lineTo(-halfLen+ll,0); ctx.stroke();
    ctx.beginPath(); ctx.moveTo( halfLen,0); ctx.lineTo( halfLen-ll,0); ctx.stroke();

    // For 3-leg components, draw a center lead too
    if (inst.legs.length===3) {
      // center leg pixel relative to center
      const pts = instLegPixels(inst);
      const cm  = pts[1];
      // project onto component axis
      const dx = Math.cos(ang), dy = Math.sin(ang);
      const pcx = (cm.x-cx)*dx+(cm.y-cy)*dy; // along-axis offset from center
      const pcy = (cm.x-cx)*(-dy)+(cm.y-cy)*dx; // perp offset
      ctx.beginPath(); ctx.moveTo(pcx,pcy); ctx.lineTo(pcx,pcy - ll*1.5); ctx.stroke();
    }

    // Flip if needed (mirrors the body marking, not the whole thing)
    if (inst.flipped) ctx.scale(-1,1);

    drawBody(def, inst, c, halfLen, ll);

    if (isFail && !isGhost) {
      ctx.globalAlpha=1;
      ctx.font='bold 14px monospace'; ctx.textAlign='center';
      ctx.fillStyle=c.alert; ctx.fillText('✕',0,-20);
    }
    ctx.restore();
  }

  // ── Body painters ─────────────────────────────────────────────────────────────
  function drawBody(def, inst, c, halfLen, ll) {
    const bw=def.visual?.body_width||28, bh=def.visual?.body_height||14, col=def.visual?.body_color||'#888';
    switch(def.id) {
      case 'resistor':              drawResistor(inst.props.resistance,bw,bh); break;
      case 'capacitor':             drawFilmCap(bw,bh); break;
      case 'capacitor_electrolytic':drawElectroCap(col,bw); break;
      case 'led': {
        const cm=def.color_map?.[inst.props.color]||{};
        drawLED(cm.hex||'#ff2200',bw,bh,inst._brightness||0); break;
      }
      case 'potentiometer':   drawPot(col,bw,bh,inst.props.wiper||0.5); break;
      case 'diode':           drawDiode(def,inst,bw,bh); break;
      case 'transistor_npn':
      case 'transistor_pnp':  drawTransistor(def,inst,col,bw,bh); break;
      case 'switch_spst':     drawSwitch(bw,bh,c,inst._state||inst.props.state==='Closed'); break;
      case 'power_supply':    drawPower(col,bw,bh,inst.props.voltage); break;
      case 'signal_generator':drawSigGen(col,bw,bh,inst.props.waveform,c); break;
      default:
        ctx.fillStyle=col; roundRect(ctx,-bw/2,-bh/2,bw,bh,3); ctx.fill();
        ctx.fillStyle='#fff'; ctx.font='bold 9px IBM Plex Mono,monospace'; ctx.textAlign='center';
        ctx.fillText(def.symbol||def.id.slice(0,4).toUpperCase(),0,3);
    }
  }

  // Resistor
  const BANDS=['#000','#8B4513','#f00','#f80','#ff0','#0a0','#00f','#808','#999','#fff'];
  function resBands(ohms) {
    const m=parseFloat(ohms.toPrecision(2));
    const s=m.toString().replace('.','').padStart(2,'0').split('').map(Number);
    const mul=Math.max(0,Math.floor(Math.log10(ohms)-1));
    return [BANDS[s[0]%10],BANDS[s[1]%10],BANDS[mul%10],'#c8a000'];
  }
  function drawResistor(res,bw,bh) {
    ctx.fillStyle='#d4b896'; roundRect(ctx,-bw/2,-bh/2,bw,bh,3); ctx.fill();
    ctx.strokeStyle='#b09070'; ctx.lineWidth=0.5; ctx.stroke();
    resBands(res||10000).forEach((h,i)=>{ ctx.fillStyle=h; ctx.fillRect(-bw/2+6+i*6,-(bh-2)/2,4,bh-2); });
  }

  // Film capacitor — flat horizontal rectangle
  function drawFilmCap(bw,bh) {
    ctx.fillStyle='#e8c860'; roundRect(ctx,-bw/2,-bh/2,bw,bh,2); ctx.fill();
    ctx.strokeStyle='#c8a840'; ctx.lineWidth=0.5; ctx.stroke();
  }

  // Electrolytic — perfect circle with negative stripe arc on left
  function drawElectroCap(color, bw) {
    const r = bw / 2;
    // Main circle body
    ctx.beginPath(); ctx.arc(0,0,r,0,Math.PI*2);
    ctx.fillStyle=color; ctx.fill();
    ctx.strokeStyle='rgba(255,255,255,0.15)'; ctx.lineWidth=0.8; ctx.stroke();
    // Negative stripe: filled wedge on left ~25% of circle
    ctx.beginPath();
    ctx.moveTo(0,0);
    ctx.arc(0,0,r, Math.PI*0.6, Math.PI*1.4);
    ctx.closePath();
    ctx.fillStyle='rgba(0,0,0,0.4)'; ctx.fill();
    // '–' label
    ctx.fillStyle='rgba(255,255,255,0.9)';
    ctx.font=`bold ${Math.max(8,r*0.65)}px monospace`; ctx.textAlign='center';
    ctx.fillText('–', -r*0.55, r*0.22);
  }

  // LED
  function drawLED(hex,bw,bh,brightness) {
    if (brightness>0.05) {
      const g=ctx.createRadialGradient(0,0,0,0,0,bw*(1+brightness*1.5));
      g.addColorStop(0,hex+Math.round(brightness*200).toString(16).padStart(2,'0'));
      g.addColorStop(1,'transparent');
      ctx.beginPath(); ctx.arc(0,0,bw*(1+brightness*1.5),0,Math.PI*2);
      ctx.fillStyle=g; ctx.fill();
    }
    ctx.beginPath(); ctx.arc(0,0,bw/2,Math.PI,0);
    ctx.lineTo(bw/2,bh/3); ctx.lineTo(-bw/2,bh/3); ctx.closePath();
    ctx.fillStyle=brightness>0.05?hex:hex+'88'; ctx.fill();
    ctx.strokeStyle='rgba(0,0,0,0.4)'; ctx.lineWidth=0.8; ctx.stroke();
  }

  // Potentiometer
  function drawPot(color,bw,bh,wiper) {
    ctx.fillStyle=color; roundRect(ctx,-bw/2,-bh/2,bw,bh,3); ctx.fill();
    ctx.beginPath(); ctx.arc(0,0,bw*0.28,0,Math.PI*2); ctx.fillStyle='#777'; ctx.fill();
    const a=Utils.mapRange(wiper,0,1,-135,135)*(Math.PI/180);
    ctx.strokeStyle='#fff'; ctx.lineWidth=2;
    ctx.beginPath(); ctx.moveTo(0,0); ctx.lineTo(Math.cos(a)*bw*0.22,Math.sin(a)*bw*0.22); ctx.stroke();
  }

  // Diode — silicon: black rect + white bar; germanium: glass rect + black bar
  function drawDiode(def, inst, bw, bh) {
    const model  = inst.props?.model || '1N4148';
    const params = def.model_params?.[model] || {};
    const isGerm = params.type === 'germanium';

    if (isGerm) {
      // Glass body
      ctx.fillStyle='rgba(220,230,240,0.35)';
      roundRect(ctx,-bw/2,-bh/2,bw,bh,2); ctx.fill();
      ctx.strokeStyle='rgba(80,80,80,0.7)'; ctx.lineWidth=1; ctx.stroke();
      // Black cathode bar on right
      ctx.fillStyle='rgba(30,30,30,0.85)';
      ctx.fillRect(bw/2-5,-bh/2,4,bh);
    } else {
      // Silicon: solid black body
      ctx.fillStyle='#1a1a1a';
      roundRect(ctx,-bw/2,-bh/2,bw,bh,2); ctx.fill();
      // White cathode bar on right
      ctx.fillStyle='#ffffff';
      ctx.fillRect(bw/2-5,-bh/2,3,bh);
    }
  }

  // Transistor — silicon: black D-shape; germanium: silver circle
  function drawTransistor(def, inst, color, bw, bh) {
    const model  = inst.props?.model || '';
    const params = def.model_params?.[model] || {};
    const isGerm = params.type === 'germanium';
    const r      = bw / 2;
    const type   = def.id==='transistor_pnp' ? 'PNP' : 'NPN';

    if (isGerm) {
      // Silver full circle (metal can)
      const grd = ctx.createRadialGradient(-r*0.3,-r*0.3,0,0,0,r);
      grd.addColorStop(0,'#e0e0e0'); grd.addColorStop(0.6,'#a0a0a0'); grd.addColorStop(1,'#606060');
      ctx.beginPath(); ctx.arc(0,0,r,0,Math.PI*2);
      ctx.fillStyle=grd; ctx.fill();
      ctx.strokeStyle='#888'; ctx.lineWidth=0.8; ctx.stroke();
      // Index notch at bottom
      ctx.beginPath(); ctx.arc(0,r*0.85,r*0.12,0,Math.PI*2);
      ctx.fillStyle='#555'; ctx.fill();
    } else {
      // Silicon: black D-shape (flat side left)
      ctx.fillStyle='#111';
      ctx.beginPath();
      ctx.arc(0,0,r,-Math.PI/2,Math.PI/2);
      ctx.lineTo(0,r); ctx.lineTo(0,-r); ctx.closePath(); ctx.fill();
      ctx.strokeStyle='rgba(255,255,255,0.12)'; ctx.lineWidth=0.8; ctx.stroke();
      // Flat face
      ctx.strokeStyle='rgba(255,255,255,0.25)'; ctx.lineWidth=1;
      ctx.beginPath(); ctx.moveTo(0,-r); ctx.lineTo(0,r); ctx.stroke();
    }

    // Internal lead lines (B horizontal, C upper-right, E lower-right with arrow)
    ctx.strokeStyle='rgba(255,255,255,0.55)'; ctx.lineWidth=1.3;
    ctx.beginPath(); ctx.moveTo(-r*0.65,0); ctx.lineTo(0,0); ctx.stroke();        // Base
    ctx.beginPath(); ctx.moveTo(0,-r*0.4); ctx.lineTo(r*0.6,-r*0.72); ctx.stroke(); // Collector
    ctx.beginPath(); ctx.moveTo(0, r*0.4); ctx.lineTo(r*0.6, r*0.72); ctx.stroke(); // Emitter

    // Arrow on emitter
    const ax=r*0.6, ay=r*0.72;
    ctx.fillStyle='rgba(255,255,255,0.55)'; ctx.beginPath();
    if (type==='NPN') { ctx.moveTo(ax,ay); ctx.lineTo(ax-5,ay-3); ctx.lineTo(ax-5,ay+3); }
    else               { ctx.moveTo(ax-5,ay); ctx.lineTo(ax,ay-3); ctx.lineTo(ax,ay+3); }
    ctx.closePath(); ctx.fill();

    // Model text
    ctx.fillStyle='rgba(255,255,255,0.6)';
    ctx.font=`bold ${Math.max(5,r*0.38)}px IBM Plex Mono,monospace`; ctx.textAlign='center';
    ctx.fillText(model||type, r*0.22, 3);
  }

  function drawSwitch(bw,bh,c,closed) {
    ctx.fillStyle='#3a3a3a'; roundRect(ctx,-bw/2,-bh/2,bw,bh,3); ctx.fill();
    ctx.strokeStyle=closed?c.success:c.alert; ctx.lineWidth=2.5;
    ctx.beginPath(); ctx.moveTo(-bw/2+6,0); ctx.lineTo(bw/2-6,closed?0:-bh/2+4); ctx.stroke();
    ctx.fillStyle=closed?c.success:c.alert;
    ctx.font='8px IBM Plex Mono,monospace'; ctx.textAlign='center'; ctx.fillText(closed?'ON':'OFF',0,bh/2-2);
  }

  function drawPower(color,bw,bh,v) {
    ctx.fillStyle=color; roundRect(ctx,-bw/2,-bh/2,bw,bh,4); ctx.fill();
    ctx.fillStyle='#fff'; ctx.font='bold 10px IBM Plex Mono,monospace'; ctx.textAlign='center';
    ctx.fillText(`${v}V`,0,4);
  }

  function drawSigGen(color,bw,bh,waveform,c) {
    ctx.fillStyle=color; roundRect(ctx,-bw/2,-bh/2,bw,bh,4); ctx.fill();
    ctx.strokeStyle=c.scopeTrace; ctx.lineWidth=1.5;
    miniWave(waveform,-bw/2+4,-3,bw-8,8);
  }

  function miniWave(type,x,y,w,h) {
    ctx.beginPath();
    for (let i=0;i<=40;i++) {
      const t=i/40,px=x+t*w,ph=t*Math.PI*4;
      let v;
      switch(type){
        case 'Sine':     v=Math.sin(ph); break;
        case 'Square':   v=Math.sign(Math.sin(ph)); break;
        case 'Sawtooth': v=((ph/(Math.PI*2))%1)*2-1; break;
        case 'Triangle': v=Math.asin(Math.sin(ph))*(2/Math.PI); break;
        default:         v=(Math.random()*2-1)*0.5;
      }
      i===0?ctx.moveTo(px,y-v*h/2):ctx.lineTo(px,y-v*h/2);
    }
    ctx.stroke();
  }

  function drawPaletteGhost(mx,my) {
    if (!_paletteGhost) return;
    const def=ComponentRegistry.getById(_paletteGhost.defId);
    if (!def) return;
    const bw=def.visual?.body_width||32, bh=def.visual?.body_height||16;
    ctx.save(); ctx.translate(mx,my); ctx.globalAlpha=0.6;
    ctx.fillStyle=def.visual?.body_color||'#888';
    roundRect(ctx,-bw/2,-bh/2,bw,bh,4); ctx.fill();
    ctx.fillStyle='#fff'; ctx.font='bold 9px IBM Plex Mono,monospace'; ctx.textAlign='center';
    ctx.fillText(def.symbol||def.id,0,3); ctx.restore();
  }

  // ── Events ────────────────────────────────────────────────────────────────────
  function init(canvasEl) {
    canvas=canvasEl; ctx=canvas.getContext('2d');
    _layout=buildLayout();
    const W=boardWidth(), H=boardHeight();
    canvas.width=W; canvas.height=H;
    canvas.style.width=W+'px'; canvas.style.height=H+'px';
    canvas.addEventListener('mousemove',   onMouseMove);
    canvas.addEventListener('mousedown',   onMouseDown);
    canvas.addEventListener('mouseup',     onMouseUp);
    canvas.addEventListener('click',       onClick);
    canvas.addEventListener('dragover',    e=>e.preventDefault());
    canvas.addEventListener('drop',        onDrop);
    canvas.addEventListener('contextmenu', e=>e.preventDefault());
    window.addEventListener('mouseup',     onWindowMouseUp);
    window.addEventListener('keydown',     onKeyDown);
    render();
  }

  function onMouseMove(e) {
    const {x,y}=eventToCanvas(e);
    _mouseX=x; _mouseY=y;
    _hoverHole=xyToHole(x,y);

    if (Wire.isWiring()) { _wiringEnd=_hoverHole; render(x,y); return; }

    if (_dragMode==='comp-pending') {
      if (Math.hypot(x-_dragStartX,y-_dragStartY)>DRAG_THRESHOLD) _dragMode='comp-dragging';
    }

    if (_dragMode==='comp-dragging' && _dragInst && _hoverHole) {
      // Move entire component: shift all legs so leg[0] is at hover hole
      const rowDelta = rowIndexOf(_hoverHole.row) - rowIndexOf(_dragInst.legs[0].row);
      const colDelta = _hoverHole.col - _dragInst.legs[0].col;
      _dragInst.legs = _savedLegs.map(l => ({
        row: shiftRow(l.row, rowDelta),
        col: Math.max(0, Math.min(COLS-1, l.col + colDelta))
      }));
    }

    if (_dragMode==='leg-dragging' && _dragInst && _hoverHole) {
      updateLegDrag(x, y);
    }

    const coordEl=document.getElementById('status-coords');
    if (coordEl) {
      coordEl.textContent = _hoverHole
        ? `${typeof _hoverHole.row==='number'?ROW_LABELS[_hoverHole.row]:_hoverHole.row}${_hoverHole.col+1}`
        : '';
    }
    render(x,y);
  }

  function updateLegDrag(x, y) {
    if (!_dragInst || !_dragAnchorLeg || _dragLegIdx<0) return;
    const dest = _hoverHole;
    if (!dest) return;
    // Don't allow dragged leg to land on anchor leg
    if (dest.row===_dragAnchorLeg.row && dest.col===_dragAnchorLeg.col) return;

    if (_dragInst.legs.length===2) {
      // anchor is the OTHER leg; dragged leg moves to dest
      const newLegs = [null, null];
      newLegs[_dragLegIdx===0?1:0] = _dragAnchorLeg;
      newLegs[_dragLegIdx]          = dest;
      _dragInst.legs = newLegs;
    } else if (_dragInst.legs.length===3) {
      // 3-leg (transistor): outer legs only; center stays midpoint
      if (_dragLegIdx===0) {
        _dragInst.legs[0] = dest;
      } else if (_dragLegIdx===2) {
        _dragInst.legs[2] = dest;
      }
      // Recompute center leg as midpoint hole
      const a=holeToXY(_dragInst.legs[0].row,_dragInst.legs[0].col);
      const b=holeToXY(_dragInst.legs[2].row,_dragInst.legs[2].col);
      const midX=(a.x+b.x)/2, midY=(a.y+b.y)/2;
      const midHole=xyToHole(midX,midY);
      if (midHole) _dragInst.legs[1]=midHole;
    }
  }

  function onMouseDown(e) {
    if (e.button!==0) return;
    const {x,y}=eventToCanvas(e);

    if (Wire.isWiring()) {
      const h=xyToHole(x,y); if (h) Wire.startOrFinish(h); return;
    }

    // Leg target check first (only if comp is selected)
    const legHit=hitTestLeg(x,y);
    if (legHit) {
      _dragMode    = 'leg-dragging';
      _dragInst    = legHit.inst;
      _dragLegIdx  = legHit.legIdx;
      _savedLegs   = legHit.inst.legs.map(l=>({...l}));
      // Anchor = the OTHER outer leg (or opposite end for 2-leg)
      if (legHit.inst.legs.length===2) {
        _dragAnchorLeg = legHit.inst.legs[legHit.legIdx===0?1:0];
      } else {
        // 3-leg: anchor is the opposite outer leg
        _dragAnchorLeg = legHit.inst.legs[legHit.legIdx===0?2:0];
      }
      return;
    }

    // Component body
    const inst=hitTestComp(x,y);
    if (inst) {
      _dragMode   = 'comp-pending';
      _dragInst   = inst;
      _dragStartX = x; _dragStartY = y;
      _savedLegs  = inst.legs.map(l=>({...l}));
      setSelected(inst.instanceId, null);
      return;
    }

    // Wire
    const wire=hitTestWire(x,y);
    if (wire) { setSelected(null,wire.id); return; }

    setSelected(null,null);
  }

  function onMouseUp(e) {
    if (e.button!==0) return;

    if (_dragMode==='leg-dragging') {
      _dragMode='idle'; _dragInst=null; _dragAnchorLeg=null; _dragLegIdx=-1;
      Storage.markDirty(); History.push(); render(); return;
    }

    if (_dragMode==='comp-dragging') {
      _dragMode='idle'; document.body.classList.remove('dragging');
      Storage.markDirty(); History.push(); _dragInst=null; render(); return;
    }

    if (_dragMode==='comp-pending') {
      _dragMode='idle'; _dragInst=null;
    }
  }

  function onWindowMouseUp() {
    if (_dragMode==='comp-dragging' || _dragMode==='leg-dragging') {
      // Restore original position on out-of-canvas release
      if (_dragInst && _savedLegs) _dragInst.legs=_savedLegs;
      _dragMode='idle'; document.body.classList.remove('dragging');
      _dragInst=null; _dragAnchorLeg=null; _dragLegIdx=-1; render();
    }
    if (_dragMode==='comp-pending') { _dragMode='idle'; _dragInst=null; }
  }

  function onKeyDown(e) {
    if (e.code==='Escape' && (_dragMode==='comp-dragging'||_dragMode==='leg-dragging')) {
      if (_dragInst && _savedLegs) _dragInst.legs=_savedLegs;
      _dragMode='idle'; document.body.classList.remove('dragging');
      _dragInst=null; _dragAnchorLeg=null; _dragLegIdx=-1; render();
    }
  }

  function onClick(e) {
    if (_dragMode!=='idle') return;
    const {x,y}=eventToCanvas(e);
    const inst=hitTestComp(x,y);
    if (!inst) return;
    const def=ComponentRegistry.getById(inst.defId);
    if (def?.behavior?.type==='switch_spst') {
      inst._state=!inst._state; Simulation.notifyStateChange(inst);
      Storage.markDirty(); History.push(); render();
    }
  }

  function onDrop(e) {
    e.preventDefault();
    const defId=e.dataTransfer.getData('text/plain'); if (!defId) return;
    const {x,y}=eventToCanvas(e);
    const hole=xyToHole(x,y); if (!hole) return;
    const inst=ComponentRegistry.createInstance(defId,hole.row,hole.col);
    _placed.push(inst);
    setSelected(inst.instanceId,null);
    if (_onPlace) _onPlace(inst);
    History.push(); render();
  }

  // ── Row helpers ───────────────────────────────────────────────────────────────
  const RAIL_ROWS_ORDER = ['rtm','rtp','rbm','rbp'];
  function rowIndexOf(row) {
    if (typeof row==='number') return row;
    return RAIL_ROWS_ORDER.indexOf(row) + 10;
  }
  function shiftRow(row, delta) {
    if (typeof row==='number') return Math.max(0,Math.min(9,row+delta));
    return row; // rail rows don't shift
  }

  // ── Wire helpers ──────────────────────────────────────────────────────────────
  const WIRE_COLORS=['#ff9900','#ff3333','#3399ff','#33cc66','#cc33ff','#ffee33','#ffffff','#ff6699'];
  let _wireColorIdx=0;

  function setStartWire(h) { _wiringStart=h; render(); }
  function clearWire()     { _wiringStart=null; _wiringEnd=null; render(); }
  function addWire(w)      { _wires.push(w); render(); }
  function getWires()      { return _wires; }
  function nextWireColor() { return WIRE_COLORS[(_wireColorIdx++)%WIRE_COLORS.length]; }

  // ── Selection ─────────────────────────────────────────────────────────────────
  function setSelected(compId,wireId) {
    _selectedComp=compId; _selectedWire=wireId;
    const inst=compId?_placed.find(p=>p.instanceId===compId):null;
    const wire=wireId?_wires.find(w=>w.id===wireId):null;
    if (_onSelect) _onSelect(inst,wire);
    document.body.classList.toggle('comp-selected',!!inst);
    render();
  }

  function getSelected() { return _placed.find(p=>p.instanceId===_selectedComp)||null; }

  function deleteSelected() {
    if (_selectedComp) {
      _placed=_placed.filter(p=>p.instanceId!==_selectedComp);
      setSelected(null,null); return;
    }
    if (_selectedWire) {
      _wires=_wires.filter(w=>w.id!==_selectedWire);
      setSelected(null,null); return;
    }
  }

  // ── Public API ────────────────────────────────────────────────────────────────
  function setZoom(z)           { _zoom=z; }
  function getPlaced()          { return _placed; }
  function setDragGhost(defId)  { _paletteGhost=defId?{defId}:null; }
  function onSelect(fn)         { _onSelect=fn; }
  function onPlace(fn)          { _onPlace=fn; }
  function redraw()             { render(); }

  function clear() {
    _placed=[]; _wires=[]; setSelected(null,null);
  }

  function loadLayout(layout) {
    _placed=layout.components||[]; _wires=layout.wires||[];
    setSelected(null,null); render();
  }

  function getLayoutData() {
    return {
      components: _placed.map(inst=>{
        const c=Utils.clone(inst);
        delete c._voltage; delete c._current; delete c._audioNode;
        delete c._brightness; delete c._state; return c;
      }),
      wires: _wires
    };
  }

  function roundRect(ctx,x,y,w,h,r) {
    ctx.beginPath();
    ctx.moveTo(x+r,y); ctx.lineTo(x+w-r,y); ctx.quadraticCurveTo(x+w,y,x+w,y+r);
    ctx.lineTo(x+w,y+h-r); ctx.quadraticCurveTo(x+w,y+h,x+w-r,y+h);
    ctx.lineTo(x+r,y+h); ctx.quadraticCurveTo(x,y+h,x,y+h-r);
    ctx.lineTo(x,y+r); ctx.quadraticCurveTo(x,y,x+r,y);
    ctx.closePath();
  }

  return {
    init, render, clear, loadLayout, getLayoutData,
    getPlaced, getWires, addWire, nextWireColor,
    setDragGhost, setStartWire, clearWire,
    setSelected, getSelected, deleteSelected,
    onSelect, onPlace, holeToXY, xyToHole, redraw,
    setZoom
  };
})();
