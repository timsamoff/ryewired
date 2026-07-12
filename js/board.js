// ── Board Canvas Renderer ─────────────────────────────────────────────────────
// Key model: inst.legs[] = [{row,col},...] per physical leg.
// instGeometry() derives center, angle, and length from legs[0] and legs[last].
// Leads ALWAYS stretch from body edge to actual leg hole — no fixed length gap.

const Board = (() => {

  const COLS         = 63;
  const HOLE_PITCH   = 20;
  const GROUP_GAP    = 6;
  const HOLE_R       = 3.2;
  const RAIL_BREAK   = 31;
  const ROW_LABELS   = ['a','b','c','d','e','f','g','h','i','j'];
  const ML=52, MR=52, MT=14, MB=14;
  const RAIL_PAD_V   = 10;
  const RAIL_STRIP_H = 2*HOLE_PITCH+RAIL_PAD_V*2;
  const RAIL_TO_GRID = 10;
  const DIP_GAP      = 18;
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

  // 3-leg parts (transistor, potentiometer) stand above the hole row with
  // parallel legs; 2-leg parts lie flat directly on the hole row.
  function bodyOffsetY(inst,bh){
    return inst.legs.length===3 ? -(bh/2+STAND_GAP) : 0;
  }

  const cv = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const C  = () => ({
    boardBg:   cv('--board-bg'),    stripe:    cv('--board-stripe'),
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
  let _dragStartX=0, _dragStartY=0, _dragOffsetX=0, _dragOffsetY=0;
  let _savedLegs=null;

  let _onSelect=null, _onPlace=null;

  // ── Geometry ──────────────────────────────────────────────────────────────────
  function holeX(col) {
    return ML + col*HOLE_PITCH + Math.floor(col/5)*GROUP_GAP + HOLE_PITCH/2;
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
    return {
      railTopMinusY:rtMin, railTopPlusY:rtPlu,
      railBotMinusY:rbMin, railBotPlusY:rbPlu,
      railTopStripTop:MT, railTopStripBot:MT+RAIL_STRIP_H,
      railBotStripTop:MT+RAIL_STRIP_H+RAIL_TO_GRID+10*HOLE_PITCH+DIP_GAP+RAIL_TO_GRID,
      railBotStripBot:MT+RAIL_STRIP_H+RAIL_TO_GRID+10*HOLE_PITCH+DIP_GAP+RAIL_TO_GRID+RAIL_STRIP_H,
      gridTopY, dipGapCenterY:MT+RAIL_STRIP_H+RAIL_TO_GRID+5*HOLE_PITCH+DIP_GAP/2,
      rowY, totalHeight:y,
    };
  }

  const boardWidth  = () => holeX(COLS-1)+HOLE_PITCH/2+MR;
  const boardHeight = () => (_layout||buildLayout()).totalHeight;

  function holeToXY(row,col) {
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
    return best;
  }

  function eventToCanvas(e) {
    const r=canvas.getBoundingClientRect();
    return {x:(e.clientX-r.left)/_zoom, y:(e.clientY-r.top)/_zoom};
  }

  // ── Component geometry ────────────────────────────────────────────────────────
  function instLegPixels(inst,useOffset) {
    return inst.legs.map(l=>{
      const {x,y}=holeToXY(l.row,l.col);
      if(useOffset) return {x:x+_dragOffsetX,y:y+_dragOffsetY};
      return {x,y};
    });
  }

  function instGeometry(inst,useOffset) {
    const pts=useOffset?instLegPixels(inst,true):instLegPixels(inst,false);
    const a=pts[0], b=pts[pts.length-1];
    const cx=(a.x+b.x)/2, cy=(a.y+b.y)/2;
    const ang=Math.atan2(b.y-a.y,b.x-a.x);
    const len=Math.hypot(b.x-a.x,b.y-a.y);
    return {cx,cy,ang,len,pts};
  }

  function hitTestComp(x,y) {
    for(let i=_placed.length-1;i>=0;i--) {
      const inst=_placed[i], def=ComponentRegistry.getById(inst.defId);
      if(!def) continue;
      const geo=instGeometry(inst);
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
      if(distSeg(x,y,a.x,a.y,b.x,b.y)<WIRE_HIT_W) return w;
    }
    return null;
  }

  function distSeg(px,py,ax,ay,bx,by) {
    const dx=bx-ax,dy=by-ay,l2=dx*dx+dy*dy;
    if(!l2) return Math.hypot(px-ax,py-ay);
    const t=Math.max(0,Math.min(1,((px-ax)*dx+(py-ay)*dy)/l2));
    return Math.hypot(px-(ax+t*dx),py-(ay+t*dy));
  }

  // ── Canvas init (DPR-aware) ───────────────────────────────────────────────────
  function initCanvas() {
    _dpr=window.devicePixelRatio||1;
    const W=boardWidth(), H=boardHeight();
    canvas.width=Math.round(W*_dpr); canvas.height=Math.round(H*_dpr);
    canvas.style.width=W+'px'; canvas.style.height=H+'px';
    ctx.setTransform(_dpr,0,0,_dpr,0,0);
  }

  // ── Render ────────────────────────────────────────────────────────────────────
  function render(ghostX,ghostY) {
    const c=C();
    ctx.setTransform(_dpr,0,0,_dpr,0,0);
    ctx.clearRect(0,0,boardWidth(),boardHeight());
    drawBoardSurface(c); drawWires(c); drawComponents(c);
    if(_paletteGhost) drawPaletteGhost(ghostX??_mouseX,ghostY??_mouseY,c);
  }

  // ── Board surface ─────────────────────────────────────────────────────────────
  function drawBoardSurface(c) {
    const W=boardWidth(),H=boardHeight(),L=_layout;
    ctx.fillStyle=c.boardBg; Shapes.roundRect(ctx,0,0,W,H,10); ctx.fill();
    ctx.fillStyle=c.stripe;
    for(let g=1;g<Math.ceil(COLS/5);g++) ctx.fillRect(holeX(g*5)-HOLE_PITCH/2-GROUP_GAP/2-0.5,L.gridTopY,1,10*HOLE_PITCH+DIP_GAP);
    ctx.fillStyle=c.label; ctx.font='bold 9px IBM Plex Mono,monospace'; ctx.textAlign='center';
    ctx.fillText('DIP',ML/2,L.dipGapCenterY+3); ctx.fillText('DIP',W-MR/2,L.dipGapCenterY+3);
    drawRailStrip(c,'top'); drawRailStrip(c,'bot'); drawMainGrid(c);
  }

  function drawRailStrip(c,side) {
    const W=boardWidth(),L=_layout,isTop=side==='top';
    const sT=isTop?L.railTopStripTop:L.railBotStripTop, sB=isTop?L.railTopStripBot:L.railBotStripBot, sH=sB-sT;
    const mY=isTop?L.railTopMinusY:L.railBotMinusY, pY=isTop?L.railTopPlusY:L.railBotPlusY;
    const rx=ML-6, rw=W-ML-MR+12;
    ctx.fillStyle=c.railBlueBg; ctx.fillRect(rx,sT,rw,sH/2);
    ctx.fillStyle=c.railRedBg;  ctx.fillRect(rx,sT+sH/2,rw,sH/2);
    const bx1=holeX(RAIL_BREAK-1)+HOLE_PITCH/2+4, bx2=holeX(RAIL_BREAK)-HOLE_PITCH/2-4;
    const lx1=holeX(0)-HOLE_PITCH/2+2, lx2=holeX(COLS-1)+HOLE_PITCH/2-2;
    ctx.lineWidth=1.5;
    ctx.strokeStyle=c.railBlue; brokenLine(mY,lx1,bx1,bx2,lx2);
    ctx.strokeStyle=c.railRed;  brokenLine(pY,lx1,bx1,bx2,lx2);
    ctx.font='bold 11px IBM Plex Mono,monospace'; ctx.textAlign='center';
    ctx.fillStyle=c.railBlue; ctx.fillText('–',ML/2,mY+4); ctx.fillText('–',W-MR/2,mY+4);
    ctx.fillStyle=c.railRed;  ctx.fillText('+',ML/2,pY+4); ctx.fillText('+',W-MR/2,pY+4);
    for(let col=0;col<COLS;col++) {
      if(col===RAIL_BREAK) continue;
      drawRailHole(col,mY,c,'blue',isTop?'rtm':'rbm');
      drawRailHole(col,pY,c,'red', isTop?'rtp':'rbp');
    }
  }

  function brokenLine(y,x1,bx1,bx2,x2){ctx.beginPath();ctx.moveTo(x1,y);ctx.lineTo(bx1,y);ctx.stroke();ctx.beginPath();ctx.moveTo(bx2,y);ctx.lineTo(x2,y);ctx.stroke();}

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
    for(let r=0;r<=9;r++){const y=L.rowY[r];ctx.textAlign='right';ctx.fillText(ROW_LABELS[r],ML-LABEL_PAD,y+3.5);ctx.textAlign='left';ctx.fillText(ROW_LABELS[r],W-MR+LABEL_PAD,y+3.5);}
    ctx.font='8px IBM Plex Mono,monospace';ctx.textAlign='center';
    for(let col=0;col<COLS;col++){
      if((col+1)%5!==0&&col!==0) continue;
      const x=holeX(col);
      ctx.fillText(col+1,x,L.rowY[5]-HOLE_PITCH/2-2);
      ctx.fillText(col+1,x,L.rowY[0]+HOLE_PITCH/2+9);
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
  function drawWires(c){
    for(const w of _wires){
      const a=holeToXY(w.r1,w.c1),b=holeToXY(w.r2,w.c2);
      const isSel=w.id===_selectedWire;
      ctx.lineWidth=isSel?4:2.5;ctx.strokeStyle=w.color||'#ff9900';ctx.lineCap='round';
      if(isSel){ctx.shadowColor=c.warning;ctx.shadowBlur=6;}
      ctx.beginPath();ctx.moveTo(a.x,a.y);
      Math.abs(b.y-a.y)<4?ctx.lineTo(b.x,b.y):ctx.bezierCurveTo(a.x,a.y-18,b.x,b.y-18,b.x,b.y);
      ctx.stroke();ctx.shadowBlur=0;
      for(const pt of [a,b]){ctx.beginPath();ctx.arc(pt.x,pt.y,3,0,Math.PI*2);ctx.fillStyle=w.color||'#ff9900';ctx.fill();}
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
    if(Wire.isWiring()){render(x,y);return;}
    if(_dragMode==='comp-pending'){if(Math.hypot(x-_dragStartX,y-_dragStartY)>DRAG_THRESHOLD){_dragMode='comp-dragging';document.body.classList.add('dragging');}}
    if(_dragMode==='comp-dragging'){_dragOffsetX=x-_dragStartX;_dragOffsetY=y-_dragStartY;}
    if(_dragMode==='leg-dragging'&&_dragInst&&_hoverHole) updateLegDrag();
    if(_dragMode==='wire-dragging'&&_dragWire&&_hoverHole) updateWireDrag();
    const coordEl=document.getElementById('status-coords');
    if(coordEl) coordEl.textContent=_hoverHole?(typeof _hoverHole.row==='number'?ROW_LABELS[_hoverHole.row]:_hoverHole.row)+(_hoverHole.col+1):'';
    render(x,y);
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
    if(Wire.isWiring()){const h=xyToHole(x,y);if(h) Wire.startOrFinish(h);return;}
    const legHit=hitTestLeg(x,y);
    if(legHit){
      _dragMode='leg-dragging';_dragInst=legHit.inst;_dragLegIdx=legHit.legIdx;
      _savedLegs=legHit.inst.legs.map(l=>({...l}));
      _dragAnchorLeg=legHit.inst.legs.length===2?legHit.inst.legs[legHit.legIdx===0?1:0]:legHit.inst.legs[legHit.legIdx===0?2:0];
      return;
    }
    const wireEndHit=hitTestWireEnd(x,y);
    if(wireEndHit){
      _dragMode='wire-dragging';_dragWire=wireEndHit.wire;_dragWireEnd=wireEndHit.end;
      _savedWireEnds={r1:wireEndHit.wire.r1,c1:wireEndHit.wire.c1,r2:wireEndHit.wire.r2,c2:wireEndHit.wire.c2};
      setSelected(null,wireEndHit.wire.id);return;
    }
    const inst=hitTestComp(x,y);
    if(inst){
      const def=ComponentRegistry.getById(inst.defId);
      if(def?.behavior?.type==='switch_spst' && (inst.props.type==='Momentary (NO)'||inst.props.type==='Momentary (NC)')){
        _pressedSwitchInst=inst;inst._pressed=true;Simulation.notifyStateChange(inst);render();
      }
      _dragMode='comp-pending';_dragInst=inst;
      _dragStartX=x;_dragStartY=y;_dragOffsetX=0;_dragOffsetY=0;
      _savedLegs=inst.legs.map(l=>({...l}));
      setSelected(inst.instanceId,null);return;
    }
    const wire=hitTestWire(x,y);
    if(wire){setSelected(null,wire.id);return;}
    setSelected(null,null);
  }

  function onMouseUp(e){
    if(e.button!==0) return;
    if(_pressedSwitchInst){_pressedSwitchInst._pressed=false;Simulation.notifyStateChange(_pressedSwitchInst);render();_pressedSwitchInst=null;}
    if(_dragMode==='leg-dragging'){_dragMode='idle';_dragInst=null;_dragAnchorLeg=null;_dragLegIdx=-1;Storage.markDirty();History.push();render();return;}
    if(_dragMode==='wire-dragging'){_dragMode='idle';_dragWire=null;_dragWireEnd=-1;_savedWireEnds=null;Storage.markDirty();History.push();render();return;}
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
    if(_pressedSwitchInst){_pressedSwitchInst._pressed=false;Simulation.notifyStateChange(_pressedSwitchInst);render();_pressedSwitchInst=null;}
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
  }

  function onClick(e){
    if(_dragMode!=='idle') return;
    const {x,y}=eventToCanvas(e);
    const inst=hitTestComp(x,y);if(!inst) return;
    const def=ComponentRegistry.getById(inst.defId);
    if(def?.behavior?.type==='switch_spst'){
      const t=inst.props.type;
      if(t!=='Momentary (NO)' && t!=='Momentary (NC)'){
        inst._state=!inst._state;Simulation.notifyStateChange(inst);Storage.markDirty();History.push();render();
      }
    }
  }

  function onDrop(e){
    e.preventDefault();
    const defId=e.dataTransfer.getData('text/plain');if(!defId) return;
    const {x,y}=eventToCanvas(e);
    const hole=xyToHole(x,y,DROP_SNAP_RADIUS);if(!hole) return;
    const inst=ComponentRegistry.createInstance(defId,hole.row,hole.col);

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
        if (origPol==='+' || otherPol==='-') {
          inst.legs = [other, orig]; // orig is the + one -> leg 1
        } else if (origPol==='-' || otherPol==='+') {
          inst.legs = [orig, other]; // orig is the – one -> leg 0
        } else {
          const {y:oy} = holeToXY(other.row, other.col);
          inst.legs = (oy < y0) ? [other, orig] : [orig, other];
        }
      }
      // else: leave the default horizontal 2-hole layout — better than an
      // invalid placement.
    }

    _placed.push(inst);setSelected(inst.instanceId,null);
    if(_onPlace) _onPlace(inst);
    History.push();render();
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
  function deleteSelected(){
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
  }
  function getLayoutData(){
    const permanentDevices = (typeof WorkbenchStrip !== 'undefined' && WorkbenchStrip.getPermanentState)
      ? WorkbenchStrip.getPermanentState() : undefined;
    return{components:_placed.map(inst=>{const c=Utils.clone(inst);delete c._voltage;delete c._current;delete c._audioNode;delete c._brightness;delete c._state;delete c._pressed;return c;}),wires:_wires,permanentDevices};
  }

  return{init,render,clear,loadLayout,getLayoutData,getPlaced,getWires,addWire,nextWireColor,
    setDragGhost,setStartWire,clearWire,setSelected,getSelected,deleteSelected,
    onSelect,onPlace,holeToXY,xyToHole,redraw,setZoom,getBoardWidth:boardWidth};
})();