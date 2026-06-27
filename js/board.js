// ── Board Canvas Renderer ─────────────────────────────────────────────────────
// Handles: board drawing, component placement & dragging, leg-drag to wire,
// wire selection & deletion, flip rendering, zoom-aware coordinates.

const Board = (() => {

  // ── Geometry constants ──────────────────────────────────────────────────────
  const COLS        = 63;
  const HOLE_PITCH  = 20;
  const GROUP_GAP   = 6;
  const HOLE_R      = 3.2;
  const RAIL_BREAK  = 31;
  const ROW_LABELS  = ['a','b','c','d','e','f','g','h','i','j'];
  const MARGIN_L    = 52, MARGIN_R = 52, MARGIN_T = 14, MARGIN_B = 14;
  const RAIL_PAD_V  = 10;
  const RAIL_STRIP_H = 2 * HOLE_PITCH + RAIL_PAD_V * 2;
  const RAIL_TO_GRID = 10;
  const DIP_GAP     = 18;
  const LABEL_PAD   = 8;
  const LEG_HIT_R   = 7;   // radius of leg drag target
  const DRAG_THRESHOLD = 5; // px movement before body-drag activates
  const WIRE_HIT_W  = 7;   // half-width for wire hit detection

  // ── CSS var helper ──────────────────────────────────────────────────────────
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
    scopeTrace:cv('--scope-trace'), textDim:    cv('--text-dim'),
  });

  // ── State ───────────────────────────────────────────────────────────────────
  let canvas, ctx, _layout = null;
  let _placed = [], _wires = [];
  let _selectedComp = null;   // instanceId
  let _selectedWire = null;   // wire id
  let _hoverHole    = null;
  let _dragGhost    = null;   // palette ghost { defId }
  let _wiringStart  = null;
  let _wiringEnd    = null;
  let _zoom         = 1.0;
  let _mouseX = 0, _mouseY = 0;

  // Body-drag state
  let _dragState    = 'idle'; // idle | pending | dragging
  let _dragInst     = null;
  let _dragStartX   = 0, _dragStartY = 0;
  let _dragOrigRow, _dragOrigCol;

  // Leg-drag state (initiates a wire)
  let _legDragActive = false;
  let _legDragStart  = null; // { row, col }

  let _onSelect = null, _onPlace = null, _onWireSelect = null;

  // ── Layout ──────────────────────────────────────────────────────────────────
  function holeX(col) {
    return MARGIN_L + col * HOLE_PITCH + Math.floor(col / 5) * GROUP_GAP + HOLE_PITCH / 2;
  }

  function buildLayout() {
    let y = MARGIN_T;
    const rtMinY = y + RAIL_PAD_V + HOLE_PITCH / 2;
    const rtPluY = rtMinY + HOLE_PITCH;
    y += RAIL_STRIP_H + RAIL_TO_GRID;
    const gridTopY = y;
    const rowY = {};
    for (let r = 5; r <= 9; r++) { rowY[r] = y + HOLE_PITCH / 2; y += HOLE_PITCH; }
    y += DIP_GAP;
    const gridBotY = y;
    for (let r = 4; r >= 0; r--) { rowY[r] = y + HOLE_PITCH / 2; y += HOLE_PITCH; }
    y += RAIL_TO_GRID;
    const rbMinY = y + RAIL_PAD_V + HOLE_PITCH / 2;
    const rbPluY = rbMinY + HOLE_PITCH;
    y += RAIL_STRIP_H + MARGIN_B;
    return {
      railTopMinusY: rtMinY, railTopPlusY: rtPluY,
      railBotMinusY: rbMinY, railBotPlusY: rbPluY,
      railTopStripTop: MARGIN_T,
      railTopStripBot: MARGIN_T + RAIL_STRIP_H,
      railBotStripTop: MARGIN_T + RAIL_STRIP_H + RAIL_TO_GRID + 10*HOLE_PITCH + DIP_GAP + RAIL_TO_GRID,
      railBotStripBot: MARGIN_T + RAIL_STRIP_H + RAIL_TO_GRID + 10*HOLE_PITCH + DIP_GAP + RAIL_TO_GRID + RAIL_STRIP_H,
      gridTopY, gridBotY,
      dipGapCenterY: gridBotY - DIP_GAP / 2,
      rowY, totalHeight: y,
    };
  }

  const boardWidth  = () => holeX(COLS-1) + HOLE_PITCH/2 + MARGIN_R;
  const boardHeight = () => (_layout || buildLayout()).totalHeight;

  function holeToXY(row, col) {
    const L = _layout, x = holeX(col);
    const y = row==='rtp' ? L.railTopPlusY  : row==='rtm' ? L.railTopMinusY
            : row==='rbp' ? L.railBotPlusY  : row==='rbm' ? L.railBotMinusY
            : L.rowY[row];
    return { x, y };
  }

  function xyToHole(px, py) {
    const snap = HOLE_PITCH * 0.65;
    for (const row of ['rtp','rtm','rbp','rbm']) {
      const { y } = holeToXY(row, 0);
      if (Math.abs(py-y) < snap) {
        for (let c=0; c<COLS; c++) if (Math.abs(px-holeX(c)) < snap) return { row, col:c };
      }
    }
    for (let r=0; r<=9; r++) {
      const { y } = holeToXY(r, 0);
      if (Math.abs(py-y) < snap) {
        for (let c=0; c<COLS; c++) if (Math.abs(px-holeX(c)) < snap) return { row:r, col:c };
      }
    }
    return null;
  }

  // KEY: divide by _zoom so hit-testing is correct at any scale
  function eventToCanvas(e) {
    const r = canvas.getBoundingClientRect();
    return { x: (e.clientX-r.left)/_zoom, y: (e.clientY-r.top)/_zoom };
  }

  // ── Component helpers ────────────────────────────────────────────────────────
  function getCompCenter(inst) {
    const def   = ComponentRegistry.getById(inst.defId);
    const span  = (def?.leg_span||2) - 1;
    const a     = holeToXY(inst.row, inst.col);
    const b     = holeToXY(inst.row, inst.col + span);
    return { cx:(a.x+b.x)/2, cy:a.y, halfSpan:(b.x-a.x)/2 };
  }

  function getCompLegs(inst) {
    const def = ComponentRegistry.getById(inst.defId);
    if (!def) return [];
    const span = (def.leg_span||2) - 1;
    const legs = [];
    for (let i=0; i<=span; i++) {
      legs.push({ row: inst.row, col: inst.col+i, legIdx: i });
    }
    return legs;
  }

  function hitTestComp(x, y) {
    for (let i=_placed.length-1; i>=0; i--) {
      const inst = _placed[i];
      const def  = ComponentRegistry.getById(inst.defId);
      if (!def) continue;
      const { cx, cy } = getCompCenter(inst);
      const bw = (def.visual?.body_width||32)/2+10;
      const bh = (def.visual?.body_height||16)/2+10;
      if (Math.abs(x-cx)<bw && Math.abs(y-cy)<bh) return inst;
    }
    return null;
  }

  // Returns { inst, legIdx, row, col } if pointer is on a leg target of selected comp
  function hitTestLeg(x, y) {
    if (!_selectedComp) return null;
    const inst = _placed.find(p=>p.instanceId===_selectedComp);
    if (!inst) return null;
    const legs = getCompLegs(inst);
    for (const leg of legs) {
      const { x:lx, y:ly } = holeToXY(leg.row, leg.col);
      if (Math.hypot(x-lx, y-ly) < LEG_HIT_R) return { inst, ...leg };
    }
    return null;
  }

  // Returns wire if pointer is near it
  function hitTestWire(x, y) {
    for (const wire of _wires) {
      const a = holeToXY(wire.r1, wire.c1);
      const b = holeToXY(wire.r2, wire.c2);
      if (distToSegment(x, y, a.x, a.y, b.x, b.y) < WIRE_HIT_W) return wire;
    }
    return null;
  }

  function distToSegment(px, py, ax, ay, bx, by) {
    const dx=bx-ax, dy=by-ay, lenSq=dx*dx+dy*dy;
    if (lenSq===0) return Math.hypot(px-ax, py-ay);
    const t = Math.max(0, Math.min(1, ((px-ax)*dx+(py-ay)*dy)/lenSq));
    return Math.hypot(px-(ax+t*dx), py-(ay+t*dy));
  }

  // ── DRAW ────────────────────────────────────────────────────────────────────
  function render(ghostX, ghostY) {
    const c = C();
    ctx.clearRect(0,0,boardWidth(),boardHeight());
    drawBoard(c); drawWires(c); drawComponents(c);
    if (_dragGhost) drawPaletteGhost(ghostX??_mouseX, ghostY??_mouseY);
    if (_dragState==='dragging' && _dragInst) drawDragComponentGhost(c);
    if (_legDragActive && _legDragStart && _hoverHole) drawLegDragWire();
  }

  // ── Board background ─────────────────────────────────────────────────────────
  function drawBoard(c) {
    const W=boardWidth(), H=boardHeight(), L=_layout;
    ctx.fillStyle=c.boardBg; roundRect(ctx,0,0,W,H,10); ctx.fill();
    ctx.fillStyle=c.stripe;
    for (let g=1; g<Math.ceil(COLS/5); g++) {
      const gx=holeX(g*5)-HOLE_PITCH/2-GROUP_GAP/2-0.5;
      ctx.fillRect(gx,L.gridTopY,1,10*HOLE_PITCH+DIP_GAP);
    }
    ctx.fillStyle=c.label; ctx.font='bold 9px IBM Plex Mono, monospace'; ctx.textAlign='center';
    ctx.fillText('DIP',MARGIN_L/2,L.dipGapCenterY+3);
    ctx.fillText('DIP',W-MARGIN_R/2,L.dipGapCenterY+3);
    drawRailStrip(c,'top'); drawRailStrip(c,'bot'); drawMainGrid(c);
  }

  function drawRailStrip(c, side) {
    const W=boardWidth(), L=_layout, isTop=side==='top';
    const sTop=isTop?L.railTopStripTop:L.railBotStripTop;
    const sBot=isTop?L.railTopStripBot:L.railBotStripBot;
    const sH=sBot-sTop;
    const minY=isTop?L.railTopMinusY:L.railBotMinusY;
    const plusY=isTop?L.railTopPlusY:L.railBotPlusY;
    const rx=MARGIN_L-6, rw=W-MARGIN_L-MARGIN_R+12;
    ctx.fillStyle=c.railBlueBg; ctx.fillRect(rx,sTop,rw,sH/2);
    ctx.fillStyle=c.railRedBg;  ctx.fillRect(rx,sTop+sH/2,rw,sH/2);
    const bx1=holeX(RAIL_BREAK-1)+HOLE_PITCH/2+4, bx2=holeX(RAIL_BREAK)-HOLE_PITCH/2-4;
    const lx1=holeX(0)-HOLE_PITCH/2+2, lx2=holeX(COLS-1)+HOLE_PITCH/2-2;
    ctx.lineWidth=1.5;
    ctx.strokeStyle=c.railBlue; brokenLine(minY,lx1,bx1,bx2,lx2);
    ctx.strokeStyle=c.railRed;  brokenLine(plusY,lx1,bx1,bx2,lx2);
    ctx.font='bold 11px IBM Plex Mono, monospace'; ctx.textAlign='center';
    ctx.fillStyle=c.railBlue;
    ctx.fillText('–',MARGIN_L/2,minY+4); ctx.fillText('–',W-MARGIN_R/2,minY+4);
    ctx.fillStyle=c.railRed;
    ctx.fillText('+',MARGIN_L/2,plusY+4); ctx.fillText('+',W-MARGIN_R/2,plusY+4);
    for (let col=0; col<COLS; col++) {
      if (col===RAIL_BREAK) continue;
      drawRailHole(col,minY,c,'blue',isTop?'rtm':'rbm');
      drawRailHole(col,plusY,c,'red', isTop?'rtp':'rbp');
    }
  }

  function brokenLine(y,x1,bx1,bx2,x2) {
    ctx.beginPath(); ctx.moveTo(x1,y); ctx.lineTo(bx1,y); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(bx2,y); ctx.lineTo(x2,y); ctx.stroke();
  }

  function drawRailHole(col, y, c, color, railRow) {
    const x=holeX(col);
    const isHover=_hoverHole?.row===railRow&&_hoverHole?.col===col;
    const isStart=_wiringStart?.row===railRow&&_wiringStart?.col===col;
    if (isHover||isStart) {
      ctx.beginPath(); ctx.arc(x,y,HOLE_R*2.8,0,Math.PI*2);
      ctx.fillStyle=isStart?c.wireStart:c.hover; ctx.fill();
    }
    ctx.beginPath(); ctx.arc(x+.5,y+.5,HOLE_R,0,Math.PI*2); ctx.fillStyle=c.holeShadow; ctx.fill();
    ctx.beginPath(); ctx.arc(x,y,HOLE_R,0,Math.PI*2);
    ctx.fillStyle=color==='blue'?'rgba(43,87,154,0.35)':'rgba(176,32,46,0.35)'; ctx.fill();
    ctx.beginPath(); ctx.arc(x,y,HOLE_R-1,0,Math.PI*2); ctx.fillStyle=c.hole; ctx.fill();
  }

  function drawMainGrid(c) {
    const L=_layout, W=boardWidth();
    ctx.font='10px IBM Plex Mono, monospace'; ctx.fillStyle=c.label;
    for (let r=0;r<=9;r++) {
      const y=L.rowY[r];
      ctx.textAlign='right'; ctx.fillText(ROW_LABELS[r],MARGIN_L-LABEL_PAD,y+3.5);
      ctx.textAlign='left';  ctx.fillText(ROW_LABELS[r],W-MARGIN_R+LABEL_PAD,y+3.5);
    }
    ctx.font='8px IBM Plex Mono, monospace'; ctx.fillStyle=c.label; ctx.textAlign='center';
    for (let col=0;col<COLS;col++) {
      if ((col+1)%5!==0&&col!==0) continue;
      const x=holeX(col);
      ctx.fillText(col+1,x,L.rowY[5]-HOLE_PITCH/2-2);
      ctx.fillText(col+1,x,L.rowY[0]+HOLE_PITCH/2+9);
    }
    for (let r=0;r<=9;r++) for (let col=0;col<COLS;col++) drawMainHole(r,col,c);
  }

  function drawMainHole(row, col, c) {
    const {x,y}=holeToXY(row,col);
    const isHover=_hoverHole?.row===row&&_hoverHole?.col===col;
    const isStart=_wiringStart?.row===row&&_wiringStart?.col===col;
    if (isHover||isStart) {
      ctx.beginPath(); ctx.arc(x,y,HOLE_R*2.8,0,Math.PI*2);
      ctx.fillStyle=isStart?c.wireStart:c.hover; ctx.fill();
    }
    ctx.beginPath(); ctx.arc(x+.5,y+.5,HOLE_R,0,Math.PI*2); ctx.fillStyle=c.holeShadow; ctx.fill();
    ctx.beginPath(); ctx.arc(x,y,HOLE_R,0,Math.PI*2); ctx.fillStyle=c.hole; ctx.fill();
  }

  // ── Wires ───────────────────────────────────────────────────────────────────
  function drawWires(c) {
    for (const wire of _wires) {
      const a=holeToXY(wire.r1,wire.c1), b=holeToXY(wire.r2,wire.c2);
      const isSelW = wire.id===_selectedWire;
      ctx.lineWidth=isSelW?4:2.5;
      ctx.strokeStyle=wire.color||'#ff9900'; ctx.lineCap='round';
      if (isSelW) { ctx.shadowColor=c.warning; ctx.shadowBlur=6; }
      ctx.beginPath(); ctx.moveTo(a.x,a.y);
      Math.abs(b.y-a.y)<4 ? ctx.lineTo(b.x,b.y)
        : ctx.bezierCurveTo(a.x,a.y-18,b.x,b.y-18,b.x,b.y);
      ctx.stroke();
      ctx.shadowBlur=0;
      for (const pt of [a,b]) {
        ctx.beginPath(); ctx.arc(pt.x,pt.y,3,0,Math.PI*2);
        ctx.fillStyle=wire.color||'#ff9900'; ctx.fill();
      }
    }
    // In-progress jumper wire (from jumper mode or leg drag)
    const wStart = _legDragStart||_wiringStart;
    const wEnd   = _hoverHole;
    if (wStart && wEnd) {
      const a=holeToXY(wStart.row,wStart.col), b=holeToXY(wEnd.row,wEnd.col);
      ctx.lineWidth=2; ctx.strokeStyle='rgba(200,120,32,0.65)';
      ctx.setLineDash([5,4]);
      ctx.beginPath(); ctx.moveTo(a.x,a.y); ctx.lineTo(b.x,b.y); ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  function drawLegDragWire() { /* handled in drawWires via _legDragStart */ }

  // ── Components ───────────────────────────────────────────────────────────────
  function drawComponents(c) {
    for (const inst of _placed) {
      if (_dragState==='dragging' && inst===_dragInst) continue; // drawn separately as ghost
      drawComponentInstance(inst, c);
    }
    // Draw leg targets on selected component
    if (_selectedComp) {
      const inst=_placed.find(p=>p.instanceId===_selectedComp);
      if (inst) drawLegTargets(inst, c);
    }
  }

  function drawLegTargets(inst, c) {
    const def=ComponentRegistry.getById(inst.defId);
    if (!def) return;
    // Skip leg targets for ICs
    if (def.category==='ic') return;
    const legs=getCompLegs(inst);
    for (const leg of legs) {
      const {x,y}=holeToXY(leg.row,leg.col);
      ctx.beginPath(); ctx.arc(x,y,LEG_HIT_R,0,Math.PI*2);
      ctx.strokeStyle=c.accent; ctx.lineWidth=1.5;
      ctx.fillStyle='rgba(43,87,154,0.18)';
      ctx.fill(); ctx.stroke();
      // Tiny drag arrow hint
      ctx.fillStyle=c.accent; ctx.font='8px sans-serif'; ctx.textAlign='center';
      ctx.fillText('⇄',x,y+3);
    }
  }

  function drawComponentInstance(inst, c, alpha) {
    const def=ComponentRegistry.getById(inst.defId);
    if (!def) return;
    const isSel=inst.instanceId===_selectedComp;
    const isFail=inst.failed;
    const span=(def.leg_span||2)-1;
    const a=holeToXY(inst.row,inst.col), b=holeToXY(inst.row,inst.col+span);
    const cx=(a.x+b.x)/2, cy=a.y, halfSpan=(b.x-a.x)/2;
    const bw=def.visual?.body_width||28, bh=def.visual?.body_height||14;

    ctx.save();
    ctx.translate(cx,cy);
    if (inst.flipped) ctx.scale(-1,1); // flip = mirror body only
    if (alpha) ctx.globalAlpha=alpha;
    if (isFail) ctx.globalAlpha=(alpha||1)*0.35;

    if (isSel) {
      ctx.beginPath(); ctx.ellipse(0,0,bw/2+9,bh/2+9,0,0,Math.PI*2);
      ctx.strokeStyle=c.warning; ctx.lineWidth=2; ctx.stroke();
    }

    // Leads
    ctx.strokeStyle='#aaaaaa'; ctx.lineWidth=1.5;
    const ll=def.visual?.lead_length||8;
    ctx.beginPath(); ctx.moveTo(-halfSpan,0); ctx.lineTo(-halfSpan+ll,0); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(halfSpan,0);  ctx.lineTo(halfSpan-ll,0); ctx.stroke();

    drawBody(def, inst, c, halfSpan);

    if (isFail) {
      ctx.globalAlpha=1;
      ctx.font='bold 14px monospace'; ctx.textAlign='center';
      ctx.fillStyle=c.alert; ctx.fillText('✕',0,-20);
    }
    ctx.restore();
  }

  function drawDragComponentGhost(c) {
    if (!_dragInst) return;
    const def=ComponentRegistry.getById(_dragInst.defId);
    if (!def) return;
    // Draw at _mouseX/_mouseY (canvas coords)
    const span=(def.leg_span||2)-1;
    const ghostCol=_dragInst.col, ghostRow=_dragInst.row;
    // Snap ghost to current hover hole if available
    const gh = _hoverHole ? holeToXY(_hoverHole.row, _hoverHole.col) : {x:_mouseX,y:_mouseY};
    const bw=def.visual?.body_width||28;
    ctx.save();
    ctx.translate(gh.x,gh.y);
    ctx.globalAlpha=0.55;
    ctx.fillStyle=def.visual?.body_color||'#888';
    roundRect(ctx,-bw/2,-8,bw,16,4); ctx.fill();
    ctx.fillStyle='#fff'; ctx.font='bold 9px IBM Plex Mono,monospace'; ctx.textAlign='center';
    ctx.fillText(def.symbol||def.id.slice(0,4),0,3);
    ctx.restore();
  }

  // ── Body painters ────────────────────────────────────────────────────────────
  function drawBody(def, inst, c, halfSpan) {
    const bw=def.visual?.body_width||28, bh=def.visual?.body_height||14;
    const color=def.visual?.body_color||'#888';
    switch(def.id) {
      case 'resistor':              drawResistor(inst.props.resistance,bw,bh); break;
      case 'capacitor':             drawCap(color,bw,bh,false); break;
      case 'capacitor_electrolytic':drawCap(color,bw,bh,true);  break;
      case 'led': {
        const cm=def.color_map?.[inst.props.color]||{};
        drawLED(cm.hex||'#ff2200',bw,bh,inst._brightness||0); break;
      }
      case 'potentiometer':   drawPot(color,bw,bh,inst.props.wiper||0.5); break;
      case 'diode':           drawDiode(bw,bh); break;
      case 'transistor_npn':  drawTransistor(color,bw,bh,inst.props.model,'NPN'); break;
      case 'transistor_pnp':  drawTransistor(color,bw,bh,inst.props.model,'PNP'); break;
      case 'switch_spst':     drawSwitch(bw,bh,c,inst._state||inst.props.state==='Closed'); break;
      case 'power_supply':    drawPower(color,bw,bh,inst.props.voltage); break;
      case 'signal_generator':drawSigGen(color,bw,bh,inst.props.waveform,c); break;
      default:
        ctx.fillStyle=color; roundRect(ctx,-bw/2,-bh/2,bw,bh,3); ctx.fill();
        ctx.fillStyle='#fff'; ctx.font='bold 9px IBM Plex Mono,monospace'; ctx.textAlign='center';
        ctx.fillText(def.symbol||def.id.slice(0,4).toUpperCase(),0,3);
    }
  }

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
    const bands=resBands(res||10000), bh2=bh-2, sx=-bw/2+6;
    bands.forEach((h,i)=>{ ctx.fillStyle=h; ctx.fillRect(sx+i*6,-bh2/2,4,bh2); });
  }

  function drawCap(color,bw,bh,electro) {
    if (electro) {
      ctx.fillStyle=color; roundRect(ctx,-bw/2,-bh/2,bw,bh,bw/2); ctx.fill();
      ctx.fillStyle='rgba(0,0,0,0.35)'; ctx.fillRect(-bw/2,-bh/2,bw*0.28,bh);
      ctx.fillStyle='#fff'; ctx.font='bold 9px monospace'; ctx.textAlign='center';
      ctx.fillText('–',-bw/2+bw*0.14,3);
    } else {
      ctx.fillStyle='#e8c860'; roundRect(ctx,-bw/2,-bh/2,bw,bh,2); ctx.fill();
      ctx.strokeStyle='#c8a840'; ctx.lineWidth=0.5; ctx.stroke();
    }
  }

  function drawLED(hex,bw,bh,brightness) {
    if (brightness>0.05) {
      const g=ctx.createRadialGradient(0,0,0,0,0,bw*(1+brightness*1.5));
      g.addColorStop(0,hex+Math.round(brightness*200).toString(16).padStart(2,'0'));
      g.addColorStop(1,'transparent');
      ctx.beginPath(); ctx.arc(0,0,bw*(1+brightness*1.5),0,Math.PI*2); ctx.fillStyle=g; ctx.fill();
    }
    ctx.beginPath(); ctx.arc(0,0,bw/2,Math.PI,0);
    ctx.lineTo(bw/2,bh/3); ctx.lineTo(-bw/2,bh/3); ctx.closePath();
    ctx.fillStyle=brightness>0.05?hex:hex+'88'; ctx.fill();
    ctx.strokeStyle='rgba(0,0,0,0.4)'; ctx.lineWidth=0.8; ctx.stroke();
  }

  function drawPot(color,bw,bh,wiper) {
    ctx.fillStyle=color; roundRect(ctx,-bw/2,-bh/2,bw,bh,3); ctx.fill();
    ctx.beginPath(); ctx.arc(0,0,bw*0.28,0,Math.PI*2); ctx.fillStyle='#777'; ctx.fill();
    const a=Utils.mapRange(wiper,0,1,-135,135)*(Math.PI/180);
    ctx.strokeStyle='#fff'; ctx.lineWidth=2;
    ctx.beginPath(); ctx.moveTo(0,0); ctx.lineTo(Math.cos(a)*bw*0.22,Math.sin(a)*bw*0.22); ctx.stroke();
  }

  function drawDiode(bw,bh) {
    ctx.fillStyle='#2a2a2a'; ctx.beginPath();
    ctx.moveTo(-bw/2,-bh/2); ctx.lineTo(bw/2-4,0); ctx.lineTo(-bw/2,bh/2); ctx.closePath(); ctx.fill();
    ctx.fillStyle='#777'; ctx.fillRect(bw/2-5,-bh/2,4,bh);
  }

  function drawTransistor(color,bw,bh,model,type) {
    const r=bw/2;
    ctx.fillStyle=color; ctx.beginPath();
    ctx.arc(0,0,r,-Math.PI/2,Math.PI/2); ctx.lineTo(0,r); ctx.lineTo(0,-r); ctx.closePath(); ctx.fill();
    ctx.strokeStyle='rgba(255,255,255,0.15)'; ctx.lineWidth=0.8; ctx.stroke();
    ctx.strokeStyle='rgba(255,255,255,0.3)'; ctx.lineWidth=1;
    ctx.beginPath(); ctx.moveTo(0,-r); ctx.lineTo(0,r); ctx.stroke();
    ctx.strokeStyle='rgba(255,255,255,0.5)'; ctx.lineWidth=1.2;
    ctx.beginPath(); ctx.moveTo(-bw*0.6,0); ctx.lineTo(0,0); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0,-r*0.4); ctx.lineTo(r*0.6,-r*0.7); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, r*0.4); ctx.lineTo(r*0.6, r*0.7); ctx.stroke();
    const ax=r*0.6, ay=r*0.7;
    ctx.fillStyle='rgba(255,255,255,0.5)'; ctx.beginPath();
    if (type==='NPN') { ctx.moveTo(ax,ay); ctx.lineTo(ax-5,ay-3); ctx.lineTo(ax-5,ay+3); }
    else              { ctx.moveTo(ax-5,ay); ctx.lineTo(ax,ay-3); ctx.lineTo(ax,ay+3); }
    ctx.closePath(); ctx.fill();
    ctx.fillStyle='#fff'; ctx.font='bold 6px IBM Plex Mono,monospace'; ctx.textAlign='center';
    ctx.fillText(model||type,r*0.25,3);
  }

  function drawSwitch(bw,bh,c,closed) {
    ctx.fillStyle='#3a3a3a'; roundRect(ctx,-bw/2,-bh/2,bw,bh,3); ctx.fill();
    ctx.strokeStyle=closed?c.success:c.alert; ctx.lineWidth=2.5;
    ctx.beginPath(); ctx.moveTo(-bw/2+6,0); ctx.lineTo(bw/2-6,closed?0:-bh/2+4); ctx.stroke();
    ctx.fillStyle=closed?c.success:c.alert;
    ctx.font='8px IBM Plex Mono,monospace'; ctx.textAlign='center';
    ctx.fillText(closed?'ON':'OFF',0,bh/2-2);
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
    if (!_dragGhost) return;
    const def=ComponentRegistry.getById(_dragGhost.defId);
    if (!def) return;
    const bw=def.visual?.body_width||32, bh=def.visual?.body_height||16;
    ctx.save(); ctx.translate(mx,my); ctx.globalAlpha=0.65;
    ctx.fillStyle=def.visual?.body_color||'#888';
    roundRect(ctx,-bw/2,-bh/2,bw,bh,4); ctx.fill();
    ctx.fillStyle='#fff'; ctx.font='bold 9px IBM Plex Mono,monospace'; ctx.textAlign='center';
    ctx.fillText(def.symbol||def.id,0,3);
    ctx.restore();
  }

  // ── Events ───────────────────────────────────────────────────────────────────
  function init(canvasEl) {
    canvas=canvasEl; ctx=canvas.getContext('2d');
    _layout=buildLayout();
    const W=boardWidth(), H=boardHeight();
    canvas.width=W; canvas.height=H;
    canvas.style.width=W+'px'; canvas.style.height=H+'px';
    attachEvents(); render();
  }

  function attachEvents() {
    canvas.addEventListener('mousemove',   onMouseMove);
    canvas.addEventListener('mousedown',   onMouseDown);
    canvas.addEventListener('mouseup',     onMouseUp);
    canvas.addEventListener('click',       onClick);
    canvas.addEventListener('dragover',    e=>e.preventDefault());
    canvas.addEventListener('drop',        onDrop);
    canvas.addEventListener('contextmenu', e=>e.preventDefault());
    window.addEventListener('mouseup',     onWindowMouseUp);
  }

  function onMouseMove(e) {
    const {x,y}=eventToCanvas(e);
    _mouseX=x; _mouseY=y;
    _hoverHole=xyToHole(x,y);
    if (Wire.isWiring()) _wiringEnd=_hoverHole;

    // Body drag: update position
    if (_dragState==='pending') {
      const dx=Math.abs(x-_dragStartX), dy=Math.abs(y-_dragStartY);
      if (dx>DRAG_THRESHOLD||dy>DRAG_THRESHOLD) {
        _dragState='dragging';
        document.body.classList.add('dragging');
      }
    }
    if (_dragState==='dragging' && _dragInst && _hoverHole) {
      _dragInst.row=_hoverHole.row;
      _dragInst.col=_hoverHole.col;
    }

    const coordEl=document.getElementById('status-coords');
    if (coordEl && _hoverHole) {
      const {row,col}=_hoverHole;
      coordEl.textContent=`${typeof row==='number'?ROW_LABELS[row]:row}${col+1}`;
    } else if (coordEl) coordEl.textContent='';

    render(x,y);
  }

  function onMouseDown(e) {
    if (e.button!==0) return;
    const {x,y}=eventToCanvas(e);

    // Jumper mode: holes
    if (Wire.isWiring()) {
      const hole=xyToHole(x,y);
      if (hole) Wire.startOrFinish(hole);
      return;
    }

    // Leg drag check (must be before component body check)
    const legHit=hitTestLeg(x,y);
    if (legHit) {
      _legDragActive=true;
      _legDragStart={row:legHit.row, col:legHit.col};
      return;
    }

    // Component body: pending drag or select
    const inst=hitTestComp(x,y);
    if (inst) {
      _dragState='pending';
      _dragInst=inst;
      _dragStartX=x; _dragStartY=y;
      _dragOrigRow=inst.row; _dragOrigCol=inst.col;
      setSelected(inst.instanceId, null);
      return;
    }

    // Wire selection
    const wire=hitTestWire(x,y);
    if (wire) {
      setSelected(null, wire.id);
      return;
    }

    // Click on empty space — deselect
    setSelected(null, null);
  }

  function onMouseUp(e) {
    if (e.button!==0) return;
    const {x,y}=eventToCanvas(e);

    // Finish leg drag → place wire
    if (_legDragActive) {
      _legDragActive=false;
      const dest=xyToHole(x,y);
      if (dest && _legDragStart &&
          !(dest.row===_legDragStart.row && dest.col===_legDragStart.col)) {
        Board.addWire({
          id: Utils.uid('W'),
          r1:_legDragStart.row, c1:_legDragStart.col,
          r2:dest.row, c2:dest.col,
          color: randomWireColor()
        });
        Storage.markDirty();
      }
      _legDragStart=null;
      render(); return;
    }

    // End body drag
    if (_dragState==='dragging') {
      _dragState='idle';
      document.body.classList.remove('dragging');
      Storage.markDirty();
      _dragInst=null;
      render(); return;
    }

    // Was pending but no movement → treat as click (already handled by onClick)
    if (_dragState==='pending') {
      _dragState='idle';
      _dragInst=null;
    }
  }

  function onWindowMouseUp() {
    // Cancel drag if mouse released outside canvas
    if (_dragState==='dragging') {
      _dragInst.row=_dragOrigRow; _dragInst.col=_dragOrigCol;
      _dragState='idle'; document.body.classList.remove('dragging');
      _dragInst=null; render();
    }
    if (_legDragActive) {
      _legDragActive=false; _legDragStart=null; render();
    }
  }

  function onClick(e) {
    if (_dragState!=='idle' && _dragState!=='pending') return;
    const {x,y}=eventToCanvas(e);
    const inst=hitTestComp(x,y);
    if (!inst) return;
    const def=ComponentRegistry.getById(inst.defId);
    if (def?.behavior?.type==='switch_spst') {
      inst._state=!inst._state;
      Simulation.notifyStateChange(inst);
      Storage.markDirty(); render();
    }
  }

  function onDrop(e) {
    e.preventDefault();
    const defId=e.dataTransfer.getData('text/plain');
    if (!defId) return;
    const {x,y}=eventToCanvas(e);
    const hole=xyToHole(x,y);
    if (!hole) return;
    const inst=ComponentRegistry.createInstance(defId,hole.row,hole.col);
    _placed.push(inst);
    setSelected(inst.instanceId, null);
    if (_onPlace) _onPlace(inst);
    render();
  }

  const WIRE_COLORS=['#ff9900','#ff3333','#3399ff','#33cc66','#cc33ff','#ffee33','#ffffff','#ff6699'];
  let _wireColorIdx=0;
  function randomWireColor() { return WIRE_COLORS[(_wireColorIdx++)%WIRE_COLORS.length]; }

  // ── Selection ─────────────────────────────────────────────────────────────────
  function setSelected(compId, wireId) {
    _selectedComp=compId; _selectedWire=wireId;
    const inst=compId?_placed.find(p=>p.instanceId===compId):null;
    const wire=wireId?_wires.find(w=>w.id===wireId):null;
    if (_onSelect) _onSelect(inst, wire);
    render();
  }

  function getSelected()  { return _placed.find(p=>p.instanceId===_selectedComp)||null; }

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

  // ── Wire helpers ──────────────────────────────────────────────────────────────
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
  function onWireSelect(fn)    { _onWireSelect=fn; }
  function redraw()            { render(); }

  function clear() {
    _placed=[];_wires=[];
    setSelected(null,null);
  }

  function loadLayout(layout) {
    _placed=layout.components||[];
    _wires=layout.wires||[];
    setSelected(null,null);
  }

  function getLayoutData() {
    return {
      components: _placed.map(inst=>{
        const c=Utils.clone(inst);
        delete c._voltage;delete c._current;delete c._audioNode;
        delete c._brightness;delete c._state; return c;
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
    onSelect, onPlace, onWireSelect, holeToXY, xyToHole, redraw,
    setZoom
  };
})();
