// ── Board Canvas Renderer ─────────────────────────────────────────────────────
// Accurate 830-point breadboard geometry:
//   - Top rail strip:    blue(–) row, red(+) row
//   - Main grid top:     rows f–j (cols 1–63), connected vertically per column
//   - Center DIP gap
//   - Main grid bottom:  rows a–e (cols 1–63), connected vertically per column
//   - Bottom rail strip: blue(–) row, red(+) row
//   - Rails broken at center (cols 1–31 | cols 33–63)
//   - Holes grouped every 5 cols with visible spacing
//   - Row letters both sides, column numbers top + bottom of each half

const Board = (() => {

  // ── Geometry constants ──────────────────────────────────────────────────────
  const COLS          = 63;
  const HOLE_PITCH    = 20;      // px between hole centers
  const GROUP_GAP     = 6;       // extra px between groups of 5 cols
  const HOLE_R        = 3.2;
  const RAIL_BREAK    = 31;      // break after col index 30 (0-based), before 31

  // Row groups (0-based index into ROW_LABELS)
  // Physical layout top→bottom:
  //   rail+ (rp_top), rail- (rm_top)
  //   rows f,g,h,i,j  (indices 5-9)
  //   DIP gap
  //   rows e,d,c,b,a  (indices 4-0)  ← note: reversed so 'a' is nearest bottom rail
  //   rail- (rm_bot), rail+ (rp_bot)
  const ROW_LABELS    = ['a','b','c','d','e','f','g','h','i','j'];

  // Margin around the board surface
  const MARGIN_LEFT   = 52;
  const MARGIN_RIGHT  = 52;
  const MARGIN_TOP    = 14;
  const MARGIN_BOTTOM = 14;

  // Rail strip dimensions
  const RAIL_ROWS     = 2;       // + and – rows per strip
  const RAIL_PAD_V    = 10;      // vertical padding around rail holes within strip
  const RAIL_STRIP_H  = RAIL_ROWS * HOLE_PITCH + RAIL_PAD_V * 2;

  // Gap between rail strip and main grid
  const RAIL_TO_GRID  = 10;

  // DIP center gap
  const DIP_GAP       = 18;

  // Label padding
  const LABEL_PAD     = 8;

  // ── CSS variable helper ─────────────────────────────────────────────────────
  function cv(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function C() {
    return {
      boardBg:      cv('--board-bg'),
      stripe:       cv('--board-stripe'),
      hole:         cv('--board-hole'),
      holeShadow:   cv('--board-hole-shadow'),
      railRedBg:    cv('--board-bus-r-bg'),
      railBlueBg:   cv('--board-bus-b-bg'),
      railRed:      cv('--board-bus-r'),
      railBlue:     cv('--board-bus-b'),
      label:        cv('--board-label'),
      hover:        cv('--board-hover'),
      wireStart:    cv('--board-wire-start'),
      selected:     cv('--board-selected'),
      accent:       cv('--accent'),
      warning:      cv('--warning'),
      alert:        cv('--alert'),
      success:      cv('--success'),
      scopeTrace:   cv('--scope-trace'),
    };
  }

  // ── Coordinate system ───────────────────────────────────────────────────────
  // holeX(col): x center of hole at column col (0-based)
  // Each group of 5 cols gets an extra GROUP_GAP after it

  function holeX(col) {
    const group = Math.floor(col / 5);
    return MARGIN_LEFT + col * HOLE_PITCH + group * GROUP_GAP + HOLE_PITCH / 2;
  }

  // Y positions are computed from a layout object built once
  let _layout = null;

  function buildLayout() {
    let y = MARGIN_TOP;

    // Top rail strip
    const railTopY   = y + RAIL_PAD_V;              // y of first rail row (–)
    const railTopPY  = railTopY + HOLE_PITCH;        // y of second rail row (+)
    y += RAIL_STRIP_H + RAIL_TO_GRID;

    // Main grid top half: rows f(5) g(6) h(7) i(8) j(9)
    const gridTopStartY = y;
    const rowY = {};                                 // ROW_LABELS index → y
    for (let r = 5; r <= 9; r++) {                  // f..j top to bottom
      rowY[r] = y + HOLE_PITCH / 2;
      y += HOLE_PITCH;
    }
    y += DIP_GAP;

    // Main grid bottom half: rows e(4) d(3) c(2) b(1) a(0)
    const gridBotStartY = y;
    for (let r = 4; r >= 0; r--) {                  // e..a top to bottom
      rowY[r] = y + HOLE_PITCH / 2;
      y += HOLE_PITCH;
    }
    y += RAIL_TO_GRID;

    // Bottom rail strip
    const railBotMY  = y + RAIL_PAD_V;              // – row
    const railBotPY  = railBotMY + HOLE_PITCH;      // + row
    y += RAIL_STRIP_H;

    y += MARGIN_BOTTOM;

    return {
      railTopMinusY: railTopY  + HOLE_PITCH / 2,
      railTopPlusY:  railTopPY + HOLE_PITCH / 2,
      railBotMinusY: railBotMY + HOLE_PITCH / 2,
      railBotPlusY:  railBotPY + HOLE_PITCH / 2,
      railTopStripTop: MARGIN_TOP,
      railTopStripBot: MARGIN_TOP + RAIL_STRIP_H,
      railBotStripTop: MARGIN_TOP + RAIL_STRIP_H + RAIL_TO_GRID +
                       10 * HOLE_PITCH + DIP_GAP + RAIL_TO_GRID,
      railBotStripBot: MARGIN_TOP + RAIL_STRIP_H + RAIL_TO_GRID +
                       10 * HOLE_PITCH + DIP_GAP + RAIL_TO_GRID + RAIL_STRIP_H,
      gridTopStartY,
      gridBotStartY,
      dipGapCenterY: gridBotStartY - DIP_GAP / 2,
      rowY,
      totalHeight: y,
    };
  }

  function boardWidth() {
    const lastX = holeX(COLS - 1) + HOLE_PITCH / 2;
    return lastX + MARGIN_RIGHT;
  }

  function boardHeight() {
    return (_layout || buildLayout()).totalHeight;
  }

  // ── Hole → pixel ────────────────────────────────────────────────────────────
  // row encoding:
  //   0-9   → main grid rows a(0)..j(9)  using _layout.rowY[r]
  //   'rtp' → top rail + row
  //   'rtm' → top rail – row
  //   'rbp' → bottom rail + row
  //   'rbm' → bottom rail – row

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
    const L = _layout;
    const snapR = HOLE_PITCH * 0.65;

    // Check rail holes
    for (const row of ['rtp','rtm','rbp','rbm']) {
      const { y } = holeToXY(row, 0);
      if (Math.abs(py - y) < snapR) {
        for (let col = 0; col < COLS; col++) {
          const { x } = holeToXY(row, col);
          if (Math.abs(px - x) < snapR) return { row, col };
        }
      }
    }

    // Check main grid
    for (let r = 0; r <= 9; r++) {
      const { y } = holeToXY(r, 0);
      if (Math.abs(py - y) < snapR) {
        for (let col = 0; col < COLS; col++) {
          const { x } = holeToXY(r, col);
          if (Math.abs(px - x) < snapR) return { row: r, col };
        }
      }
    }
    return null;
  }

  function eventToCanvas(e) {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  // ── Draw: full board ────────────────────────────────────────────────────────

  function drawBoard(c) {
    const W = boardWidth(), H = boardHeight();
    const L = _layout;

    // Board body
    ctx.fillStyle = c.boardBg;
    roundRect(ctx, 0, 0, W, H, 10);
    ctx.fill();

    // Vertical group separators in main grid (every 5 cols, between groups)
    ctx.fillStyle = c.stripe;
    for (let g = 1; g < Math.ceil(COLS / 5); g++) {
      const col = g * 5;
      const gapX = holeX(col) - HOLE_PITCH / 2 - GROUP_GAP / 2 - 0.5;
      ctx.fillRect(gapX, L.gridTopStartY, 1, 10 * HOLE_PITCH + DIP_GAP);
    }

    // DIP gap label
    ctx.fillStyle = c.label;
    ctx.font      = 'bold 9px IBM Plex Mono, monospace';
    ctx.textAlign = 'center';
    ctx.fillText('DIP', MARGIN_LEFT / 2, L.dipGapCenterY + 3);
    ctx.fillText('DIP', boardWidth() - MARGIN_RIGHT / 2, L.dipGapCenterY + 3);

    drawRailStrip(c, 'top');
    drawRailStrip(c, 'bot');
    drawMainGrid(c);
  }

  // ── Draw: rail strip ────────────────────────────────────────────────────────

  function drawRailStrip(c, side) {
    const L   = _layout;
    const W   = boardWidth();
    const isTop = side === 'top';

    const stripTop = isTop ? L.railTopStripTop : L.railBotStripTop;
    const stripBot = isTop ? L.railTopStripBot : L.railBotStripBot;
    const stripH   = stripBot - stripTop;

    // Blue (–) is top row of each strip; Red (+) is bottom row
    const minusY = isTop ? L.railTopMinusY : L.railBotMinusY;
    const plusY  = isTop ? L.railTopPlusY  : L.railBotPlusY;

    // Strip backgrounds
    const halfH = stripH / 2;
    ctx.fillStyle = c.railBlueBg;
    ctx.fillRect(MARGIN_LEFT - 6, stripTop, W - MARGIN_LEFT - MARGIN_RIGHT + 12, halfH);
    ctx.fillStyle = c.railRedBg;
    ctx.fillRect(MARGIN_LEFT - 6, stripTop + halfH, W - MARGIN_LEFT - MARGIN_RIGHT + 12, halfH);

    // Trace lines (two segments with center break)
    const breakX1 = holeX(RAIL_BREAK - 1) + HOLE_PITCH / 2 + 4;
    const breakX2 = holeX(RAIL_BREAK)     - HOLE_PITCH / 2 - 4;
    const lineStartX = holeX(0) - HOLE_PITCH / 2 + 2;
    const lineEndX   = holeX(COLS - 1) + HOLE_PITCH / 2 - 2;

    ctx.lineWidth = 1.5;

    // Blue (–) trace
    ctx.strokeStyle = c.railBlue;
    drawBrokenLine(minusY, lineStartX, breakX1, breakX2, lineEndX);

    // Red (+) trace
    ctx.strokeStyle = c.railRed;
    drawBrokenLine(plusY, lineStartX, breakX1, breakX2, lineEndX);

    // +/– labels on both sides
    ctx.font      = 'bold 11px IBM Plex Mono, monospace';
    ctx.textAlign = 'center';

    ctx.fillStyle = c.railBlue;
    ctx.fillText('–', MARGIN_LEFT / 2, minusY + 4);
    ctx.fillText('–', W - MARGIN_RIGHT / 2, minusY + 4);

    ctx.fillStyle = c.railRed;
    ctx.fillText('+', MARGIN_LEFT / 2, plusY + 4);
    ctx.fillText('+', W - MARGIN_RIGHT / 2, plusY + 4);

    // Rail holes in groups of 5
    for (let col = 0; col < COLS; col++) {
      // Skip the break gap column
      if (col === RAIL_BREAK) continue;
      drawRailHole(col, minusY, c, 'blue');
      drawRailHole(col, plusY,  c, 'red');
    }
  }

  function drawBrokenLine(y, x1, bx1, bx2, x2) {
    ctx.beginPath(); ctx.moveTo(x1, y); ctx.lineTo(bx1, y); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(bx2, y); ctx.lineTo(x2, y); ctx.stroke();
  }

  function drawRailHole(col, y, c, color) {
    const x = holeX(col);
    // Shadow
    ctx.beginPath();
    ctx.arc(x + 0.5, y + 0.5, HOLE_R, 0, Math.PI * 2);
    ctx.fillStyle = c.holeShadow;
    ctx.fill();
    // Hole
    ctx.beginPath();
    ctx.arc(x, y, HOLE_R, 0, Math.PI * 2);
    ctx.fillStyle = color === 'blue'
      ? 'rgba(43,87,154,0.35)'
      : 'rgba(176,32,46,0.35)';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, y, HOLE_R - 1, 0, Math.PI * 2);
    ctx.fillStyle = c.hole;
    ctx.fill();
  }

  // ── Draw: main grid ─────────────────────────────────────────────────────────

  function drawMainGrid(c) {
    const L   = _layout;
    const W   = boardWidth();

    // Row labels — both sides, for rows 0-9
    ctx.font      = '10px IBM Plex Mono, monospace';
    ctx.fillStyle = c.label;

    for (let r = 0; r <= 9; r++) {
      const label = ROW_LABELS[r];
      const y     = L.rowY[r];
      ctx.textAlign = 'right';
      ctx.fillText(label, MARGIN_LEFT - LABEL_PAD, y + 3.5);
      ctx.textAlign = 'left';
      ctx.fillText(label, W - MARGIN_RIGHT + LABEL_PAD, y + 3.5);
    }

    // Column numbers — top of upper half (above row j=9) and bottom of lower half (below row a=0)
    ctx.font      = '8px IBM Plex Mono, monospace';
    ctx.fillStyle = c.label;
    ctx.textAlign = 'center';

    for (let col = 0; col < COLS; col++) {
      if ((col + 1) % 5 !== 0 && col !== 0) continue; // every 5th + col 1
      const num = col + 1;
      const x   = holeX(col);
      // Above row j (top of upper half)
      ctx.fillText(num, x, L.rowY[9] - HOLE_PITCH / 2 - 2);
      // Below row a (bottom of lower half)
      ctx.fillText(num, x, L.rowY[0] + HOLE_PITCH / 2 + 9);
    }

    // All main grid holes
    for (let r = 0; r <= 9; r++) {
      for (let col = 0; col < COLS; col++) {
        drawMainHole(r, col, c);
      }
    }
  }

  function drawMainHole(row, col, c) {
    const { x, y } = holeToXY(row, col);
    const isHover     = _hoverHole?.row === row && _hoverHole?.col === col;
    const isWireStart = _wiringStart?.row === row && _wiringStart?.col === col;

    if (isHover || isWireStart) {
      ctx.beginPath();
      ctx.arc(x, y, HOLE_R * 2.8, 0, Math.PI * 2);
      ctx.fillStyle = isWireStart ? c.wireStart : c.hover;
      ctx.fill();
    }

    // Shadow
    ctx.beginPath();
    ctx.arc(x + 0.5, y + 0.5, HOLE_R, 0, Math.PI * 2);
    ctx.fillStyle = c.holeShadow;
    ctx.fill();

    // Hole
    ctx.beginPath();
    ctx.arc(x, y, HOLE_R, 0, Math.PI * 2);
    ctx.fillStyle = c.hole;
    ctx.fill();
  }

  // ── Draw: wires ─────────────────────────────────────────────────────────────

  function drawWires(c) {
    for (const wire of _wires) {
      const a  = holeToXY(wire.r1, wire.c1);
      const b  = holeToXY(wire.r2, wire.c2);
      const dy = Math.abs(b.y - a.y);

      ctx.lineWidth   = 2.5;
      ctx.strokeStyle = wire.color || '#ff9900';
      ctx.lineCap     = 'round';
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      if (dy < 4) {
        ctx.lineTo(b.x, b.y);
      } else {
        ctx.bezierCurveTo(a.x, a.y - 18, b.x, b.y - 18, b.x, b.y);
      }
      ctx.stroke();

      for (const pt of [a, b]) {
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, 3, 0, Math.PI * 2);
        ctx.fillStyle = wire.color || '#ff9900';
        ctx.fill();
      }
    }

    // In-progress wire
    if (_wiringStart && _wiringEnd) {
      const a = holeToXY(_wiringStart.row, _wiringStart.col);
      const b = holeToXY(_wiringEnd.row,   _wiringEnd.col);
      ctx.lineWidth   = 2;
      ctx.strokeStyle = 'rgba(200,120,32,0.65)';
      ctx.setLineDash([5, 4]);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // ── Draw: components ────────────────────────────────────────────────────────

  function drawComponents(c) {
    for (const inst of _placed) drawComponentInstance(inst, c);
  }

  function drawComponentInstance(inst, c) {
    const def = ComponentRegistry.getById(inst.defId);
    if (!def) return;

    const isSelected = inst.instanceId === _selected;
    const isFailed   = inst.failed;

    // Anchor at (inst.row, inst.col); span rightward
    const span    = (def.leg_span || 2) - 1;
    const anchor  = holeToXY(inst.row, inst.col);
    const endHole = holeToXY(inst.row, inst.col + span);
    const cx      = (anchor.x + endHole.x) / 2;
    const cy      = anchor.y;
    const halfSpan = (endHole.x - anchor.x) / 2;
    const leadLen  = def.visual?.lead_length || 8;
    const bw       = def.visual?.body_width  || 28;
    const bh       = def.visual?.body_height || 14;

    ctx.save();
    ctx.translate(cx, cy);

    if (isFailed) ctx.globalAlpha = 0.35;

    // Selection halo
    if (isSelected) {
      ctx.beginPath();
      ctx.ellipse(0, 0, bw / 2 + 9, bh / 2 + 9, 0, 0, Math.PI * 2);
      ctx.strokeStyle = c.warning;
      ctx.lineWidth   = 2;
      ctx.stroke();
    }

    // Leads
    ctx.strokeStyle = '#aaaaaa';
    ctx.lineWidth   = 1.5;
    ctx.beginPath(); ctx.moveTo(-halfSpan, 0); ctx.lineTo(-halfSpan + leadLen, 0); ctx.stroke();
    ctx.beginPath(); ctx.moveTo( halfSpan, 0); ctx.lineTo( halfSpan - leadLen, 0); ctx.stroke();

    drawComponentBody(def, inst, c, halfSpan, leadLen);

    if (isFailed) {
      ctx.globalAlpha = 1;
      ctx.font        = 'bold 14px monospace';
      ctx.textAlign   = 'center';
      ctx.fillStyle   = c.alert;
      ctx.fillText('✕', 0, -20);
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
        drawCapacitorBody(color, bw, bh, inst.props.type); break;
      case 'led': {
        const cm = def.color_map?.[inst.props.color] || {};
        drawLEDBody(cm.hex || '#ff2200', bw, bh, inst._brightness || 0); break;
      }
      case 'potentiometer':
        drawPotBody(color, bw, bh, inst.props.wiper || 0.5); break;
      case 'diode':
        drawDiodeBody(bw, bh); break;
      case 'transistor_npn':
        drawTransistorBody(color, bw, bh, inst.props.model); break;
      case 'switch_spst':
        drawSwitchBody(bw, bh, c, inst._state || inst.props.state === 'Closed'); break;
      case 'power_supply':
        drawPowerBody(color, bw, bh, inst.props.voltage); break;
      case 'signal_generator':
        drawSignalGenBody(color, bw, bh, inst.props.waveform, c); break;
      default:
        ctx.fillStyle = color;
        roundRect(ctx, -bw/2, -bh/2, bw, bh, 3); ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 9px IBM Plex Mono, monospace';
        ctx.textAlign = 'center';
        ctx.fillText(def.symbol || def.id.slice(0,4).toUpperCase(), 0, 3);
    }
  }

  // ── Component body painters ─────────────────────────────────────────────────

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

  function drawCapacitorBody(color, bw, bh, type) {
    if (type === 'Electrolytic') {
      ctx.fillStyle = color;
      roundRect(ctx, -bw/2, -bh/2, bw, bh, bw/2); ctx.fill();
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.fillRect(-bw/2, -bh/2, bw*0.28, bh);
      ctx.fillStyle = '#fff'; ctx.font = 'bold 9px monospace'; ctx.textAlign = 'center';
      ctx.fillText('–', -bw/2 + bw*0.14, 3);
    } else {
      ctx.fillStyle = '#e8c860';
      roundRect(ctx, -bw/2, -bh/2, bw, bh, 2); ctx.fill();
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
    roundRect(ctx, -bw/2, -bh/2, bw, bh, 3); ctx.fill();
    ctx.beginPath(); ctx.arc(0,0,bw*0.28,0,Math.PI*2);
    ctx.fillStyle = '#777'; ctx.fill();
    const angle = Utils.mapRange(wiper, 0, 1, -135, 135) * (Math.PI/180);
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(0,0);
    ctx.lineTo(Math.cos(angle)*bw*0.22, Math.sin(angle)*bw*0.22); ctx.stroke();
  }

  function drawDiodeBody(bw, bh) {
    ctx.fillStyle = '#2a2a2a';
    ctx.beginPath();
    ctx.moveTo(-bw/2,-bh/2); ctx.lineTo(bw/2-4,0); ctx.lineTo(-bw/2,bh/2); ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#777'; ctx.fillRect(bw/2-5,-bh/2,4,bh);
  }

  function drawTransistorBody(color, bw, bh, model) {
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(0,0,bw/2,0,Math.PI*2); ctx.fill();
    ctx.fillStyle = '#ddd';
    ctx.font = 'bold 7px IBM Plex Mono, monospace'; ctx.textAlign = 'center';
    ctx.fillText(model||'NPN', 0, 2.5);
  }

  function drawSwitchBody(bw, bh, c, closed) {
    ctx.fillStyle = '#3a3a3a';
    roundRect(ctx,-bw/2,-bh/2,bw,bh,3); ctx.fill();
    ctx.strokeStyle = closed ? c.success : c.alert;
    ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.moveTo(-bw/2+6, 0);
    ctx.lineTo(bw/2-6, closed ? 0 : -bh/2+4); ctx.stroke();
    ctx.fillStyle = closed ? c.success : c.alert;
    ctx.font = '8px IBM Plex Mono, monospace'; ctx.textAlign = 'center';
    ctx.fillText(closed ? 'ON':'OFF', 0, bh/2-2);
  }

  function drawPowerBody(color, bw, bh, voltage) {
    ctx.fillStyle = color;
    roundRect(ctx,-bw/2,-bh/2,bw,bh,4); ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 10px IBM Plex Mono, monospace'; ctx.textAlign = 'center';
    ctx.fillText(`${voltage}V`, 0, 4);
  }

  function drawSignalGenBody(color, bw, bh, waveform, c) {
    ctx.fillStyle = color;
    roundRect(ctx,-bw/2,-bh/2,bw,bh,4); ctx.fill();
    ctx.strokeStyle = c.scopeTrace; ctx.lineWidth = 1.5;
    drawMiniWave(waveform, -bw/2+4, -3, bw-8, 8);
  }

  function drawMiniWave(type, x, y, w, h) {
    ctx.beginPath();
    for (let i = 0; i <= 40; i++) {
      const t = i/40, px = x+t*w, phase = t*Math.PI*4;
      let v;
      switch(type) {
        case 'Sine':     v = Math.sin(phase); break;
        case 'Square':   v = Math.sign(Math.sin(phase)); break;
        case 'Sawtooth': v = ((phase/(Math.PI*2))%1)*2-1; break;
        case 'Triangle': v = Math.asin(Math.sin(phase))*(2/Math.PI); break;
        default:         v = (Math.random()*2-1)*0.5;
      }
      i===0 ? ctx.moveTo(px, y-v*h/2) : ctx.lineTo(px, y-v*h/2);
    }
    ctx.stroke();
  }

  // ── Drag ghost ──────────────────────────────────────────────────────────────

  function drawDragGhost(mouseX, mouseY) {
    if (!_dragGhost) return;
    const def = ComponentRegistry.getById(_dragGhost.defId);
    if (!def) return;
    const bw = def.visual?.body_width||32, bh = def.visual?.body_height||16;
    ctx.save();
    ctx.translate(mouseX, mouseY);
    ctx.globalAlpha = 0.65;
    ctx.fillStyle = def.visual?.body_color||'#888';
    roundRect(ctx,-bw/2,-bh/2,bw,bh,4); ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 9px IBM Plex Mono, monospace'; ctx.textAlign = 'center';
    ctx.fillText(def.symbol||def.id, 0, 3);
    ctx.restore();
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

  // ── Init & render ────────────────────────────────────────────────────────────

  function init(canvasEl) {
    canvas  = canvasEl;
    ctx     = canvas.getContext('2d');
    _layout = buildLayout();

    const W = boardWidth(), H = boardHeight();
    canvas.width        = W;
    canvas.height       = H;
    canvas.style.width  = W + 'px';
    canvas.style.height = H + 'px';

    attachEvents();
    render();
  }

  function render(ghostX, ghostY) {
    const c = C();
    ctx.clearRect(0, 0, boardWidth(), boardHeight());
    drawBoard(c);
    drawWires(c);
    drawComponents(c);
    if (_dragGhost) drawDragGhost(ghostX ?? _mouseX, ghostY ?? _mouseY);
  }

  // ── Events ───────────────────────────────────────────────────────────────────

  function attachEvents() {
    canvas.addEventListener('mousemove',   onMouseMove);
    canvas.addEventListener('mousedown',   onMouseDown);
    canvas.addEventListener('click',       onClick);
    canvas.addEventListener('dragover',    e => e.preventDefault());
    canvas.addEventListener('drop',        onDrop);
    canvas.addEventListener('contextmenu', e => e.preventDefault());
  }

  function onMouseMove(e) {
    const { x, y } = eventToCanvas(e);
    _mouseX = x; _mouseY = y;
    _hoverHole = xyToHole(x, y);
    if (Wire.isWiring()) _wiringEnd = _hoverHole;

    const coordEl = document.getElementById('status-coords');
    if (coordEl && _hoverHole) {
      const { row, col } = _hoverHole;
      const rowLabel = typeof row === 'number' ? ROW_LABELS[row] : row;
      coordEl.textContent = `${rowLabel}${col + 1}`;
    } else if (coordEl) {
      coordEl.textContent = '';
    }
    render(x, y);
  }

  function onMouseDown(e) {
    if (e.button !== 0) return;
    const { x, y } = eventToCanvas(e);
    const hole = xyToHole(x, y);
    if (Wire.isWiring()) { if (hole) Wire.startOrFinish(hole); return; }
    const inst = hitTest(x, y);
    setSelected(inst ? inst.instanceId : null);
  }

  function onClick(e) {
    const { x, y } = eventToCanvas(e);
    const inst = hitTest(x, y);
    if (!inst) return;
    const def = ComponentRegistry.getById(inst.defId);
    if (def?.behavior?.type === 'switch_spst') {
      inst._state = !inst._state;
      Simulation.notifyStateChange(inst);
      Storage.markDirty();
      render();
    }
  }

  function onDrop(e) {
    e.preventDefault();
    const defId = e.dataTransfer.getData('text/plain');
    if (!defId) return;
    const { x, y } = eventToCanvas(e);
    const hole = xyToHole(x, y);
    if (!hole) return;
    const inst = ComponentRegistry.createInstance(defId, hole.row, hole.col);
    _placed.push(inst);
    setSelected(inst.instanceId);
    if (_onPlace) _onPlace(inst);
    render();
  }

  function hitTest(x, y) {
    for (let i = _placed.length - 1; i >= 0; i--) {
      const inst  = _placed[i];
      const def   = ComponentRegistry.getById(inst.defId);
      if (!def) continue;
      const span    = (def.leg_span || 2) - 1;
      const anchor  = holeToXY(inst.row, inst.col);
      const endHole = holeToXY(inst.row, inst.col + span);
      const cx  = (anchor.x + endHole.x) / 2;
      const cy  = anchor.y;
      const bw  = (def.visual?.body_width  || 32) / 2 + 10;
      const bh  = (def.visual?.body_height || 16) / 2 + 10;
      if (Math.abs(x - cx) < bw && Math.abs(y - cy) < bh) return inst;
    }
    return null;
  }

  // ── Selection ─────────────────────────────────────────────────────────────────

  function setSelected(id) {
    _selected = id;
    const inst = id ? _placed.find(p => p.instanceId === id) : null;
    if (_onSelect) _onSelect(inst);
    render();
  }

  function getSelected() { return _placed.find(p => p.instanceId === _selected) || null; }

  function deleteSelected() {
    if (!_selected) return;
    _placed   = _placed.filter(p => p.instanceId !== _selected);
    _selected = null;
    if (_onSelect) _onSelect(null);
    render();
  }

  // ── Wire helpers ──────────────────────────────────────────────────────────────

  function setStartWire(hole) { _wiringStart = hole; render(); }
  function clearWire()        { _wiringStart = null; _wiringEnd = null; render(); }
  function addWire(wire)      { _wires.push(wire); render(); }
  function getWires()         { return _wires; }

  // ── Public API ────────────────────────────────────────────────────────────────

  function getPlaced()           { return _placed; }
  function setDragGhost(defId)   { _dragGhost = defId ? { defId } : null; }
  function onSelect(fn)          { _onSelect = fn; }
  function onPlace(fn)           { _onPlace  = fn; }
  function redraw()              { render(); }

  function clear() {
    _placed = []; _wires = []; _selected = null;
    if (_onSelect) _onSelect(null);
    render();
  }

  function loadLayout(layout) {
    _placed   = layout.components || [];
    _wires    = layout.wires      || [];
    _selected = null;
    if (_onSelect) _onSelect(null);
    render();
  }

  function getLayoutData() {
    return {
      components: _placed.map(inst => {
        const clean = Utils.clone(inst);
        delete clean._voltage; delete clean._current;
        delete clean._audioNode; delete clean._brightness; delete clean._state;
        return clean;
      }),
      wires: _wires
    };
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x+r, y);
    ctx.lineTo(x+w-r, y); ctx.quadraticCurveTo(x+w, y, x+w, y+r);
    ctx.lineTo(x+w, y+h-r); ctx.quadraticCurveTo(x+w, y+h, x+w-r, y+h);
    ctx.lineTo(x+r, y+h); ctx.quadraticCurveTo(x, y+h, x, y+h-r);
    ctx.lineTo(x, y+r); ctx.quadraticCurveTo(x, y, x+r, y);
    ctx.closePath();
  }

  return {
    init, render, clear, loadLayout, getLayoutData,
    getPlaced, getWires, addWire,
    setDragGhost, setStartWire, clearWire,
    setSelected, getSelected, deleteSelected,
    onSelect, onPlace, holeToXY, xyToHole, redraw
  };
})();
