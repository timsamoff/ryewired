// ── Board Canvas Renderer ─────────────────────────────────────────────────────

const Board = (() => {

  // ── Geometry ────────────────────────────────────────────────────────────────
  const COLS       = 63;
  const HOLE_PITCH = 20;
  const GROUP_GAP  = 6;
  const HOLE_R     = 3.2;
  const RAIL_BREAK = 31;

  const ROW_LABELS = ['a','b','c','d','e','f','g','h','i','j'];

  const MARGIN_LEFT   = 52;
  const MARGIN_RIGHT  = 52;
  const MARGIN_TOP    = 14;
  const MARGIN_BOTTOM = 14;

  const RAIL_ROWS    = 2;
  const RAIL_PAD_V   = 10;
  const RAIL_STRIP_H = RAIL_ROWS * HOLE_PITCH + RAIL_PAD_V * 2;
  const RAIL_TO_GRID = 10;
  const DIP_GAP      = 18;
  const LABEL_PAD    = 8;

  // ── CSS var helper ───────────────────────────────────────────────────────────
  function cv(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }
  function C() {
    return {
      boardBg:    cv('--board-bg'),    stripe:     cv('--board-stripe'),
      hole:       cv('--board-hole'),  holeShadow: cv('--board-hole-shadow'),
      railRedBg:  cv('--board-bus-r-bg'), railBlueBg: cv('--board-bus-b-bg'),
      railRed:    cv('--board-bus-r'), railBlue:   cv('--board-bus-b'),
      label:      cv('--board-label'),
      hover:      cv('--board-hover'), wireStart:  cv('--board-wire-start'),
      selected:   cv('--board-selected'),
      accent:     cv('--accent'),      warning:    cv('--warning'),
      alert:      cv('--alert'),       success:    cv('--success'),
      scopeTrace: cv('--scope-trace'),
    };
  }

  // ── State ────────────────────────────────────────────────────────────────────
  let canvas, ctx;
  let _placed      = [];
  let _wires       = [];
  let _selected    = null;
  let _hoverHole   = null;
  let _dragGhost   = null;
  let _wiringStart = null;
  let _wiringEnd   = null;
  let _onSelect    = null;
  let _onPlace     = null;
  let _mouseX = 0, _mouseY = 0;
  let _zoom   = 1.0;   // kept in sync by app.js → Board.setZoom()
  let _layout = null;

  // ── Geometry helpers ─────────────────────────────────────────────────────────
  function holeX(col) {
    const group = Math.floor(col / 5);
    return MARGIN_LEFT + col * HOLE_PITCH + group * GROUP_GAP + HOLE_PITCH / 2;
  }

  function buildLayout() {
    let y = MARGIN_TOP;
    const railTopY  = y + RAIL_PAD_V;
    const railTopPY = railTopY + HOLE_PITCH;
    y += RAIL_STRIP_H + RAIL_TO_GRID;
    const gridTopStartY = y;
    const rowY = {};
    for (let r = 5; r <= 9; r++) { rowY[r] = y + HOLE_PITCH / 2; y += HOLE_PITCH; }
    y += DIP_GAP;
    const gridBotStartY = y;
    for (let r = 4; r >= 0; r--) { rowY[r] = y + HOLE_PITCH / 2; y += HOLE_PITCH; }
    y += RAIL_TO_GRID;
    const railBotMY = y + RAIL_PAD_V;
    const railBotPY = railBotMY + HOLE_PITCH;
    y += RAIL_STRIP_H + MARGIN_BOTTOM;
    return {
      railTopMinusY: railTopY  + HOLE_PITCH / 2,
      railTopPlusY:  railTopPY + HOLE_PITCH / 2,
      railBotMinusY: railBotMY + HOLE_PITCH / 2,
      railBotPlusY:  railBotPY + HOLE_PITCH / 2,
      railTopStripTop: MARGIN_TOP,
      railTopStripBot: MARGIN_TOP + RAIL_STRIP_H,
      railBotStripTop: MARGIN_TOP + RAIL_STRIP_H + RAIL_TO_GRID + 10 * HOLE_PITCH + DIP_GAP + RAIL_TO_GRID,
      railBotStripBot: MARGIN_TOP + RAIL_STRIP_H + RAIL_TO_GRID + 10 * HOLE_PITCH + DIP_GAP + RAIL_TO_GRID + RAIL_STRIP_H,
      gridTopStartY, gridBotStartY,
      dipGapCenterY: gridBotStartY - DIP_GAP / 2,
      rowY, totalHeight: y,
    };
  }

  function boardWidth()  { return holeX(COLS - 1) + HOLE_PITCH / 2 + MARGIN_RIGHT; }
  function boardHeight() { return (_layout || buildLayout()).totalHeight; }

  function holeToXY(row, col) {
    const L = _layout;
    const x = holeX(col);
    let y;
    if      (row === 'rtp') y = L.railTopPlusY;
    else if (row === 'rtm') y = L.railTopMinusY;
    else if (row === 'rbp') y = L.railBotPlusY;
    else if (row === 'rbm') y = L.railBotMinusY;
    else                    y = L.rowY[row];
    return { x, y };
  }

  function xyToHole(px, py) {
    const snapR = HOLE_PITCH * 0.65;
    for (const row of ['rtp','rtm','rbp','rbm']) {
      const { y } = holeToXY(row, 0);
      if (Math.abs(py - y) < snapR) {
        for (let col = 0; col < COLS; col++) {
          if (Math.abs(px - holeX(col)) < snapR) return { row, col };
        }
      }
    }
    for (let r = 0; r <= 9; r++) {
      const { y } = holeToXY(r, 0);
      if (Math.abs(py - y) < snapR) {
        for (let col = 0; col < COLS; col++) {
          if (Math.abs(px - holeX(col)) < snapR) return { row: r, col };
        }
      }
    }
    return null;
  }

  // KEY FIX: divide by _zoom so coordinates stay correct at any scale
  function eventToCanvas(e) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left)  / _zoom,
      y: (e.clientY - rect.top)   / _zoom
    };
  }

  // ── Draw: board ──────────────────────────────────────────────────────────────
  function drawBoard(c) {
    const W = boardWidth(), H = boardHeight(), L = _layout;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = c.boardBg;
    roundRect(ctx, 0, 0, W, H, 10); ctx.fill();

    ctx.fillStyle = c.stripe;
    for (let g = 1; g < Math.ceil(COLS / 5); g++) {
      const gapX = holeX(g * 5) - HOLE_PITCH / 2 - GROUP_GAP / 2 - 0.5;
      ctx.fillRect(gapX, L.gridTopStartY, 1, 10 * HOLE_PITCH + DIP_GAP);
    }

    ctx.fillStyle = c.label;
    ctx.font = 'bold 9px IBM Plex Mono, monospace';
    ctx.textAlign = 'center';
    ctx.fillText('DIP', MARGIN_LEFT / 2, L.dipGapCenterY + 3);
    ctx.fillText('DIP', boardWidth() - MARGIN_RIGHT / 2, L.dipGapCenterY + 3);

    drawRailStrip(c, 'top');
    drawRailStrip(c, 'bot');
    drawMainGrid(c);
  }

  function drawRailStrip(c, side) {
    const W = boardWidth(), L = _layout, isTop = side === 'top';
    const stripTop = isTop ? L.railTopStripTop : L.railBotStripTop;
    const stripBot = isTop ? L.railTopStripBot : L.railBotStripBot;
    const stripH   = stripBot - stripTop;
    const minusY   = isTop ? L.railTopMinusY : L.railBotMinusY;
    const plusY    = isTop ? L.railTopPlusY  : L.railBotPlusY;
    const halfH    = stripH / 2;
    const rx = MARGIN_LEFT - 6, rw = W - MARGIN_LEFT - MARGIN_RIGHT + 12;

    ctx.fillStyle = c.railBlueBg; ctx.fillRect(rx, stripTop, rw, halfH);
    ctx.fillStyle = c.railRedBg;  ctx.fillRect(rx, stripTop + halfH, rw, halfH);

    const bx1 = holeX(RAIL_BREAK - 1) + HOLE_PITCH / 2 + 4;
    const bx2 = holeX(RAIL_BREAK)     - HOLE_PITCH / 2 - 4;
    const lx1 = holeX(0) - HOLE_PITCH / 2 + 2;
    const lx2 = holeX(COLS - 1) + HOLE_PITCH / 2 - 2;

    ctx.lineWidth = 1.5;
    ctx.strokeStyle = c.railBlue; drawBrokenLine(minusY, lx1, bx1, bx2, lx2);
    ctx.strokeStyle = c.railRed;  drawBrokenLine(plusY,  lx1, bx1, bx2, lx2);

    ctx.font = 'bold 11px IBM Plex Mono, monospace'; ctx.textAlign = 'center';
    ctx.fillStyle = c.railBlue;
    ctx.fillText('–', MARGIN_LEFT / 2, minusY + 4);
    ctx.fillText('–', W - MARGIN_RIGHT / 2, minusY + 4);
    ctx.fillStyle = c.railRed;
    ctx.fillText('+', MARGIN_LEFT / 2, plusY + 4);
    ctx.fillText('+', W - MARGIN_RIGHT / 2, plusY + 4);

    for (let col = 0; col < COLS; col++) {
      if (col === RAIL_BREAK) continue;
      drawRailHole(col, minusY, c, 'blue', isTop ? 'rtm' : 'rbm');
      drawRailHole(col, plusY,  c, 'red',  isTop ? 'rtp' : 'rbp');
    }
  }

  function drawBrokenLine(y, x1, bx1, bx2, x2) {
    ctx.beginPath(); ctx.moveTo(x1,  y); ctx.lineTo(bx1, y); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(bx2, y); ctx.lineTo(x2,  y); ctx.stroke();
  }

  function drawRailHole(col, y, c, color, railRow) {
    const x = holeX(col);
    const isHover     = _hoverHole?.row === railRow && _hoverHole?.col === col;
    const isWireStart = _wiringStart?.row === railRow && _wiringStart?.col === col;
    if (isHover || isWireStart) {
      ctx.beginPath(); ctx.arc(x, y, HOLE_R * 2.8, 0, Math.PI * 2);
      ctx.fillStyle = isWireStart ? c.wireStart : c.hover; ctx.fill();
    }
    ctx.beginPath(); ctx.arc(x + 0.5, y + 0.5, HOLE_R, 0, Math.PI * 2);
    ctx.fillStyle = c.holeShadow; ctx.fill();
    ctx.beginPath(); ctx.arc(x, y, HOLE_R, 0, Math.PI * 2);
    ctx.fillStyle = color === 'blue' ? 'rgba(43,87,154,0.35)' : 'rgba(176,32,46,0.35)'; ctx.fill();
    ctx.beginPath(); ctx.arc(x, y, HOLE_R - 1, 0, Math.PI * 2);
    ctx.fillStyle = c.hole; ctx.fill();
  }

  function drawMainGrid(c) {
    const L = _layout, W = boardWidth();
    ctx.font = '10px IBM Plex Mono, monospace'; ctx.fillStyle = c.label;
    for (let r = 0; r <= 9; r++) {
      const y = L.rowY[r];
      ctx.textAlign = 'right'; ctx.fillText(ROW_LABELS[r], MARGIN_LEFT - LABEL_PAD, y + 3.5);
      ctx.textAlign = 'left';  ctx.fillText(ROW_LABELS[r], W - MARGIN_RIGHT + LABEL_PAD, y + 3.5);
    }
    ctx.font = '8px IBM Plex Mono, monospace'; ctx.fillStyle = c.label; ctx.textAlign = 'center';
    for (let col = 0; col < COLS; col++) {
      if ((col + 1) % 5 !== 0 && col !== 0) continue;
      const x = holeX(col);
      // Numbers above row f (index 5) and below row a (index 0)
      ctx.fillText(col + 1, x, L.rowY[5] - HOLE_PITCH / 2 - 2);
      ctx.fillText(col + 1, x, L.rowY[0] + HOLE_PITCH / 2 + 9);
    }
    for (let r = 0; r <= 9; r++) {
      for (let col = 0; col < COLS; col++) drawMainHole(r, col, c);
    }
  }

  function drawMainHole(row, col, c) {
    const { x, y } = holeToXY(row, col);
    const isHover     = _hoverHole?.row === row && _hoverHole?.col === col;
    const isWireStart = _wiringStart?.row === row && _wiringStart?.col === col;
    if (isHover || isWireStart) {
      ctx.beginPath(); ctx.arc(x, y, HOLE_R * 2.8, 0, Math.PI * 2);
      ctx.fillStyle = isWireStart ? c.wireStart : c.hover; ctx.fill();
    }
    ctx.beginPath(); ctx.arc(x + 0.5, y + 0.5, HOLE_R, 0, Math.PI * 2);
    ctx.fillStyle = c.holeShadow; ctx.fill();
    ctx.beginPath(); ctx.arc(x, y, HOLE_R, 0, Math.PI * 2);
    ctx.fillStyle = c.hole; ctx.fill();
  }

  // ── Draw: wires ──────────────────────────────────────────────────────────────
  function drawWires(c) {
    for (const wire of _wires) {
      const a = holeToXY(wire.r1, wire.c1), b = holeToXY(wire.r2, wire.c2);
      ctx.lineWidth = 2.5; ctx.strokeStyle = wire.color || '#ff9900'; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(a.x, a.y);
      Math.abs(b.y - a.y) < 4
        ? ctx.lineTo(b.x, b.y)
        : ctx.bezierCurveTo(a.x, a.y - 18, b.x, b.y - 18, b.x, b.y);
      ctx.stroke();
      for (const pt of [a, b]) {
        ctx.beginPath(); ctx.arc(pt.x, pt.y, 3, 0, Math.PI * 2);
        ctx.fillStyle = wire.color || '#ff9900'; ctx.fill();
      }
    }
    if (_wiringStart && _wiringEnd) {
      const a = holeToXY(_wiringStart.row, _wiringStart.col);
      const b = holeToXY(_wiringEnd.row,   _wiringEnd.col);
      ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(200,120,32,0.65)';
      ctx.setLineDash([5,4]);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // ── Draw: components ─────────────────────────────────────────────────────────
  function drawComponents(c) {
    for (const inst of _placed) drawComponentInstance(inst, c);
  }

  function drawComponentInstance(inst, c) {
    const def = ComponentRegistry.getById(inst.defId);
    if (!def) return;
    const isSelected = inst.instanceId === _selected;
    const isFailed   = inst.failed;
    const rotation   = inst.rotation || 0; // 0, 90, 180, 270
    const span       = (def.leg_span || 2) - 1;
    const anchor     = holeToXY(inst.row, inst.col);
    const endHole    = holeToXY(inst.row, inst.col + span);
    const cx         = (anchor.x + endHole.x) / 2;
    const cy         = anchor.y;
    const halfSpan   = (endHole.x - anchor.x) / 2;
    const leadLen    = def.visual?.lead_length || 8;
    const bw         = def.visual?.body_width  || 28;
    const bh         = def.visual?.body_height || 14;

    ctx.save();
    ctx.translate(cx, cy);
    if (rotation) ctx.rotate(rotation * Math.PI / 180);
    if (isFailed) ctx.globalAlpha = 0.35;

    if (isSelected) {
      ctx.beginPath();
      ctx.ellipse(0, 0, bw / 2 + 9, bh / 2 + 9, 0, 0, Math.PI * 2);
      ctx.strokeStyle = c.warning; ctx.lineWidth = 2; ctx.stroke();
    }

    // Leads
    ctx.strokeStyle = '#aaaaaa'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(-halfSpan, 0); ctx.lineTo(-halfSpan + leadLen, 0); ctx.stroke();
    ctx.beginPath(); ctx.moveTo( halfSpan, 0); ctx.lineTo( halfSpan - leadLen, 0); ctx.stroke();

    drawComponentBody(def, inst, c, halfSpan, leadLen);

    if (isFailed) {
      ctx.globalAlpha = 1;
      ctx.font = 'bold 14px monospace'; ctx.textAlign = 'center';
      ctx.fillStyle = c.alert; ctx.fillText('✕', 0, -20);
    }
    ctx.restore();
  }

  function drawComponentBody(def, inst, c, halfSpan, leadLen) {
    const bw    = def.visual?.body_width  || 28;
    const bh    = def.visual?.body_height || 14;
    const color = def.visual?.body_color  || '#888888';

    switch (def.id) {
      case 'resistor':
        drawResistorBody(inst.props.resistance, bw, bh); break;
      case 'capacitor':
        drawCapacitorBody(color, bw, bh, inst.props.type, false); break;
      case 'capacitor_electrolytic':
        drawCapacitorBody(color, bw, bh, 'Electrolytic', true); break;
      case 'led': {
        const cm = def.color_map?.[inst.props.color] || {};
        drawLEDBody(cm.hex || '#ff2200', bw, bh, inst._brightness || 0); break;
      }
      case 'potentiometer':
        drawPotBody(color, bw, bh, inst.props.wiper || 0.5); break;
      case 'diode':
        drawDiodeBody(bw, bh); break;
      case 'transistor_npn':
        drawTransistorBody(color, bw, bh, inst.props.model, 'NPN'); break;
      case 'transistor_pnp':
        drawTransistorBody(color, bw, bh, inst.props.model, 'PNP'); break;
      case 'switch_spst':
        drawSwitchBody(bw, bh, c, inst._state || inst.props.state === 'Closed'); break;
      case 'power_supply':
        drawPowerBody(color, bw, bh, inst.props.voltage); break;
      case 'signal_generator':
        drawSignalGenBody(color, bw, bh, inst.props.waveform, c); break;
      default:
        ctx.fillStyle = color;
        roundRect(ctx, -bw/2, -bh/2, bw, bh, 3); ctx.fill();
        ctx.fillStyle = '#fff'; ctx.font = 'bold 9px IBM Plex Mono, monospace'; ctx.textAlign = 'center';
        ctx.fillText(def.symbol || def.id.slice(0,4).toUpperCase(), 0, 3);
    }
  }

  // ── Component painters ───────────────────────────────────────────────────────
  const BAND_COLORS = ['#000','#8B4513','#f00','#f80','#ff0','#0a0','#00f','#808','#999','#fff'];

  function resistorBands(ohms) {
    const m   = parseFloat(ohms.toPrecision(2));
    const str = m.toString().replace('.','').padStart(2,'0');
    const d   = str.split('').map(Number);
    const mul = Math.max(0, Math.floor(Math.log10(ohms) - 1));
    return [BAND_COLORS[d[0]%10], BAND_COLORS[d[1]%10], BAND_COLORS[mul%10], '#c8a000'];
  }

  function drawResistorBody(resistance, bw, bh) {
    ctx.fillStyle = '#d4b896';
    roundRect(ctx, -bw/2, -bh/2, bw, bh, 3); ctx.fill();
    ctx.strokeStyle = '#b09070'; ctx.lineWidth = 0.5; ctx.stroke();
    const bands = resistorBands(resistance || 10000);
    const bh2 = bh - 2, sx = -bw/2 + 6;
    bands.forEach((hex, i) => { ctx.fillStyle = hex; ctx.fillRect(sx + i*6, -bh2/2, 4, bh2); });
  }

  // Capacitor: electrolytic = tall cylinder, film/ceramic = flat horizontal rectangle
  function drawCapacitorBody(color, bw, bh, type, isElectrolytic) {
    if (isElectrolytic || type === 'Electrolytic') {
      // Tall cylindrical body
      ctx.fillStyle = color;
      roundRect(ctx, -bw/2, -bh/2, bw, bh, bw/2); ctx.fill();
      // Negative stripe on left
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.beginPath();
      ctx.arc(-bw/2 + bw*0.28/2, 0, bh/2, Math.PI/2, -Math.PI/2);
      ctx.rect(-bw/2, -bh/2, bw*0.28, bh);
      ctx.fill();
      // – symbol
      ctx.fillStyle = '#fff'; ctx.font = 'bold 9px monospace'; ctx.textAlign = 'center';
      ctx.fillText('–', -bw/2 + bw*0.14, 3);
    } else {
      // Film / ceramic: flat horizontal rectangle (like a resistor but plain)
      ctx.fillStyle = '#e8c860';
      roundRect(ctx, -bw/2, -bh/2, bw, bh, 2); ctx.fill();
      ctx.strokeStyle = '#c8a840'; ctx.lineWidth = 0.5; ctx.stroke();
    }
  }

  function drawLEDBody(colorHex, bw, bh, brightness) {
    if (brightness > 0.05) {
      const grd = ctx.createRadialGradient(0,0,0,0,0,bw*(1+brightness*1.5));
      grd.addColorStop(0, colorHex + Math.round(brightness*200).toString(16).padStart(2,'0'));
      grd.addColorStop(1, 'transparent');
      ctx.beginPath(); ctx.arc(0,0,bw*(1+brightness*1.5),0,Math.PI*2);
      ctx.fillStyle = grd; ctx.fill();
    }
    ctx.beginPath();
    ctx.arc(0,0,bw/2,Math.PI,0);
    ctx.lineTo(bw/2,bh/3); ctx.lineTo(-bw/2,bh/3); ctx.closePath();
    ctx.fillStyle = brightness > 0.05 ? colorHex : colorHex+'88'; ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.4)'; ctx.lineWidth = 0.8; ctx.stroke();
  }

  function drawPotBody(color, bw, bh, wiper) {
    ctx.fillStyle = color;
    roundRect(ctx,-bw/2,-bh/2,bw,bh,3); ctx.fill();
    ctx.beginPath(); ctx.arc(0,0,bw*0.28,0,Math.PI*2); ctx.fillStyle='#777'; ctx.fill();
    const angle = Utils.mapRange(wiper,0,1,-135,135)*(Math.PI/180);
    ctx.strokeStyle='#fff'; ctx.lineWidth=2;
    ctx.beginPath(); ctx.moveTo(0,0); ctx.lineTo(Math.cos(angle)*bw*0.22,Math.sin(angle)*bw*0.22); ctx.stroke();
  }

  function drawDiodeBody(bw, bh) {
    ctx.fillStyle = '#2a2a2a';
    ctx.beginPath();
    ctx.moveTo(-bw/2,-bh/2); ctx.lineTo(bw/2-4,0); ctx.lineTo(-bw/2,bh/2); ctx.closePath(); ctx.fill();
    ctx.fillStyle='#777'; ctx.fillRect(bw/2-5,-bh/2,4,bh);
  }

  // Transistor: D-shaped half-circle, flat side left, 3 legs: B (left), C (top-right), E (bottom-right)
  function drawTransistorBody(color, bw, bh, model, type) {
    const r = bw / 2;

    // Half-circle body (flat side facing left)
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(0, 0, r, -Math.PI/2, Math.PI/2); // right semicircle
    ctx.lineTo(0, r); ctx.lineTo(0, -r); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.15)'; ctx.lineWidth = 0.8; ctx.stroke();

    // Flat face line
    ctx.strokeStyle = 'rgba(255,255,255,0.3)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, -r); ctx.lineTo(0, r); ctx.stroke();

    // Internal lines: Base line (horizontal), Collector & Emitter diagonals
    ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.lineWidth = 1.2;
    // Base connects at center of flat face
    ctx.beginPath(); ctx.moveTo(-bw*0.6, 0); ctx.lineTo(0, 0); ctx.stroke();
    // Collector (top)
    ctx.beginPath(); ctx.moveTo(0, -r*0.4); ctx.lineTo(r*0.6, -r*0.7); ctx.stroke();
    // Emitter (bottom) with arrow
    ctx.beginPath(); ctx.moveTo(0, r*0.4); ctx.lineTo(r*0.6, r*0.7); ctx.stroke();

    // Arrow on emitter (NPN = pointing out, PNP = pointing in)
    const ax = r*0.6, ay = r*0.7;
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.beginPath();
    if (type === 'NPN') {
      ctx.moveTo(ax, ay); ctx.lineTo(ax-5, ay-3); ctx.lineTo(ax-5, ay+3);
    } else {
      ctx.moveTo(ax-5, ay); ctx.lineTo(ax, ay-3); ctx.lineTo(ax, ay+3);
    }
    ctx.closePath(); ctx.fill();

    // Model label
    ctx.fillStyle = '#fff'; ctx.font = 'bold 6px IBM Plex Mono, monospace'; ctx.textAlign = 'center';
    ctx.fillText(model || type, r*0.25, 3);
  }

  function drawSwitchBody(bw, bh, c, closed) {
    ctx.fillStyle = '#3a3a3a'; roundRect(ctx,-bw/2,-bh/2,bw,bh,3); ctx.fill();
    ctx.strokeStyle = closed ? c.success : c.alert; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.moveTo(-bw/2+6,0);
    ctx.lineTo(bw/2-6, closed ? 0 : -bh/2+4); ctx.stroke();
    ctx.fillStyle = closed ? c.success : c.alert;
    ctx.font='8px IBM Plex Mono, monospace'; ctx.textAlign='center';
    ctx.fillText(closed?'ON':'OFF', 0, bh/2-2);
  }

  function drawPowerBody(color, bw, bh, voltage) {
    ctx.fillStyle = color; roundRect(ctx,-bw/2,-bh/2,bw,bh,4); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.font='bold 10px IBM Plex Mono, monospace'; ctx.textAlign='center';
    ctx.fillText(`${voltage}V`, 0, 4);
  }

  function drawSignalGenBody(color, bw, bh, waveform, c) {
    ctx.fillStyle = color; roundRect(ctx,-bw/2,-bh/2,bw,bh,4); ctx.fill();
    ctx.strokeStyle = c.scopeTrace; ctx.lineWidth = 1.5;
    drawMiniWave(waveform, -bw/2+4, -3, bw-8, 8);
  }

  function drawMiniWave(type, x, y, w, h) {
    ctx.beginPath();
    for (let i = 0; i <= 40; i++) {
      const t=i/40, px=x+t*w, phase=t*Math.PI*4;
      let v;
      switch(type){
        case 'Sine':     v=Math.sin(phase); break;
        case 'Square':   v=Math.sign(Math.sin(phase)); break;
        case 'Sawtooth': v=((phase/(Math.PI*2))%1)*2-1; break;
        case 'Triangle': v=Math.asin(Math.sin(phase))*(2/Math.PI); break;
        default:         v=(Math.random()*2-1)*0.5;
      }
      i===0 ? ctx.moveTo(px,y-v*h/2) : ctx.lineTo(px,y-v*h/2);
    }
    ctx.stroke();
  }

  // ── Drag ghost ───────────────────────────────────────────────────────────────
  function drawDragGhost(mx, my) {
    if (!_dragGhost) return;
    const def = ComponentRegistry.getById(_dragGhost.defId);
    if (!def) return;
    const bw=def.visual?.body_width||32, bh=def.visual?.body_height||16;
    ctx.save(); ctx.translate(mx,my); ctx.globalAlpha=0.65;
    ctx.fillStyle=def.visual?.body_color||'#888';
    roundRect(ctx,-bw/2,-bh/2,bw,bh,4); ctx.fill();
    ctx.fillStyle='#fff'; ctx.font='bold 9px IBM Plex Mono, monospace'; ctx.textAlign='center';
    ctx.fillText(def.symbol||def.id,0,3);
    ctx.restore();
  }

  // ── Init & render ────────────────────────────────────────────────────────────
  function init(canvasEl) {
    canvas  = canvasEl;
    ctx     = canvas.getContext('2d');
    _layout = buildLayout();
    const W = boardWidth(), H = boardHeight();
    canvas.width=W; canvas.height=H;
    canvas.style.width=W+'px'; canvas.style.height=H+'px';
    attachEvents();
    render();
  }

  function render(ghostX, ghostY) {
    const c = C();
    ctx.clearRect(0,0,boardWidth(),boardHeight());
    drawBoard(c); drawWires(c); drawComponents(c);
    if (_dragGhost) drawDragGhost(ghostX??_mouseX, ghostY??_mouseY);
  }

  // ── Events ───────────────────────────────────────────────────────────────────
  function attachEvents() {
    canvas.addEventListener('mousemove',   onMouseMove);
    canvas.addEventListener('mousedown',   onMouseDown);
    canvas.addEventListener('click',       onClick);
    canvas.addEventListener('dragover',    e=>e.preventDefault());
    canvas.addEventListener('drop',        onDrop);
    canvas.addEventListener('contextmenu', e=>e.preventDefault());
  }

  function onMouseMove(e) {
    const {x,y} = eventToCanvas(e);
    _mouseX=x; _mouseY=y;
    _hoverHole = xyToHole(x,y);
    if (Wire.isWiring()) _wiringEnd = _hoverHole;
    const coordEl = document.getElementById('status-coords');
    if (coordEl) {
      coordEl.textContent = _hoverHole
        ? `${typeof _hoverHole.row==='number' ? ROW_LABELS[_hoverHole.row] : _hoverHole.row}${_hoverHole.col+1}`
        : '';
    }
    render(x,y);
  }

  function onMouseDown(e) {
    if (e.button !== 0) return;
    const {x,y} = eventToCanvas(e);
    const hole   = xyToHole(x,y);
    if (Wire.isWiring()) { if (hole) Wire.startOrFinish(hole); return; }
    const inst = hitTest(x,y);
    setSelected(inst ? inst.instanceId : null);
  }

  function onClick(e) {
    const {x,y} = eventToCanvas(e);
    const inst = hitTest(x,y);
    if (!inst) return;
    const def = ComponentRegistry.getById(inst.defId);
    if (def?.behavior?.type === 'switch_spst') {
      inst._state = !inst._state;
      Simulation.notifyStateChange(inst);
      Storage.markDirty(); render();
    }
  }

  function onDrop(e) {
    e.preventDefault();
    const defId = e.dataTransfer.getData('text/plain');
    if (!defId) return;
    const {x,y} = eventToCanvas(e);
    const hole   = xyToHole(x,y);
    if (!hole) return;
    const inst = ComponentRegistry.createInstance(defId, hole.row, hole.col);
    _placed.push(inst);
    setSelected(inst.instanceId);
    if (_onPlace) _onPlace(inst);
    render();
  }

  function hitTest(x,y) {
    for (let i=_placed.length-1; i>=0; i--) {
      const inst=_placed[i], def=ComponentRegistry.getById(inst.defId);
      if (!def) continue;
      const span=( def.leg_span||2)-1;
      const a=holeToXY(inst.row,inst.col), b=holeToXY(inst.row,inst.col+span);
      const cx=(a.x+b.x)/2, cy=a.y;
      const bw=(def.visual?.body_width||32)/2+10, bh=(def.visual?.body_height||16)/2+10;
      if (Math.abs(x-cx)<bw && Math.abs(y-cy)<bh) return inst;
    }
    return null;
  }

  // ── Selection ─────────────────────────────────────────────────────────────────
  function setSelected(id) {
    _selected=id;
    const inst=id?_placed.find(p=>p.instanceId===id):null;
    if (_onSelect) _onSelect(inst);
    render();
  }
  function getSelected() { return _placed.find(p=>p.instanceId===_selected)||null; }
  function deleteSelected() {
    if (!_selected) return;
    _placed=_placed.filter(p=>p.instanceId!==_selected); _selected=null;
    if (_onSelect) _onSelect(null); render();
  }

  // ── Wire helpers ─────────────────────────────────────────────────────────────
  function setStartWire(hole) { _wiringStart=hole; render(); }
  function clearWire()        { _wiringStart=null; _wiringEnd=null; render(); }
  function addWire(wire)      { _wires.push(wire); render(); }
  function getWires()         { return _wires; }

  // ── Public API ────────────────────────────────────────────────────────────────
  function setZoom(z)          { _zoom=z; }
  function getPlaced()         { return _placed; }
  function setDragGhost(defId) { _dragGhost=defId?{defId}:null; }
  function onSelect(fn)        { _onSelect=fn; }
  function onPlace(fn)         { _onPlace=fn; }
  function redraw()            { render(); }

  function clear() {
    _placed=[]; _wires=[]; _selected=null;
    if (_onSelect) _onSelect(null); render();
  }

  function loadLayout(layout) {
    _placed=layout.components||[]; _wires=layout.wires||[]; _selected=null;
    if (_onSelect) _onSelect(null); render();
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
    getPlaced, getWires, addWire,
    setDragGhost, setStartWire, clearWire,
    setSelected, getSelected, deleteSelected,
    onSelect, onPlace, holeToXY, xyToHole, redraw,
    setZoom
  };
})();
