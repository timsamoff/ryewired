// ── Board Canvas Renderer ─────────────────────────────────────────────────────
// DPR-aware canvas for crisp rendering at any zoom level.
// Component legs: darker, wider, with hole-end caps.
// Power source: polarity indicators at leg ends.
// 3-leg components: correct local-space center-lead projection.
// Drop: generous nearest-hole snapping.

const Board = (() => {

  // ── Constants ────────────────────────────────────────────────────────────────
  const COLS         = 63;
  const HOLE_PITCH   = 20;
  const GROUP_GAP    = 6;
  const HOLE_R       = 3.2;
  const RAIL_BREAK   = 31;
  const ROW_LABELS   = ['a','b','c','d','e','f','g','h','i','j'];
  const ML=52, MR=52, MT=14, MB=14;
  const RAIL_PAD_V   = 10;
  const RAIL_STRIP_H = 2*HOLE_PITCH + RAIL_PAD_V*2;
  const RAIL_TO_GRID = 10;
  const DIP_GAP      = 18;
  const LABEL_PAD    = 8;
  const LEG_HIT_R    = 10;
  const LEG_DOT_R    = 6;
  const WIRE_HIT_W   = 7;
  const DRAG_THRESHOLD   = 6;
  const DROP_SNAP_RADIUS = 40;  // generous drop snap in CSS px

  // Lead visual style
  const LEAD_COLOR   = '#555555';
  const LEAD_WIDTH   = 2.0;
  const LEAD_CAP_R   = 3.0;     // filled circle at hole end of each lead

  // ── CSS vars ──────────────────────────────────────────────────────────────────
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

  // ── State ─────────────────────────────────────────────────────────────────────
  let canvas, ctx, _layout=null;
  let _dpr = 1;
  let _placed=[], _wires=[];
  let _selectedComp=null, _selectedWire=null;
  let _hoverHole=null;
  let _paletteGhost=null;
  let _wiringStart=null;
  let _zoom=1.0;
  let _mouseX=0, _mouseY=0;

  let _dragMode='idle'; // idle|comp-pending|comp-dragging|leg-dragging
  let _dragInst=null, _dragLegIdx=-1, _dragAnchorLeg=null;
  let _dragStartX=0, _dragStartY=0;
  let _dragOffsetX=0, _dragOffsetY=0;
  let _savedLegs=null;

  let _onSelect=null, _onPlace=null;

  // ── Layout ────────────────────────────────────────────────────────────────────
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

  // Find nearest hole within DROP_SNAP_RADIUS px (canvas coords)
  function xyToHole(px,py,radius) {
    const snap = radius ?? HOLE_PITCH*0.65;
    let best=null, bestD=snap;
    const check=(row,col)=>{
      const {x,y}=holeToXY(row,col);
      const d=Math.hypot(px-x,py-y);
      if(d<bestD){bestD=d;best={row,col};}
    };
    for(const row of ['rtp','rtm','rbp','rbm']){
      const {y}=holeToXY(row,0);
      if(Math.abs(py-y)<snap) for(let c=0;c<COLS;c++) check(row,c);
    }
    for(let r=0;r<=9;r++){
      const {y}=holeToXY(r,0);
      if(Math.abs(py-y)<snap) for(let c=0;c<COLS;c++) check(r,c);
    }
    return best;
  }

  // eventToCanvas: returns logical (un-DPR-scaled) canvas coordinates
  function eventToCanvas(e) {
    const r=canvas.getBoundingClientRect();
    return {x:(e.clientX-r.left)/_zoom, y:(e.clientY-r.top)/_zoom};
  }

  // ── Component geometry ────────────────────────────────────────────────────────
  function instLegPixels(inst) { return inst.legs.map(l=>holeToXY(l.row,l.col)); }

  function instGeometry(inst) {
    const pts=instLegPixels(inst);
    const a=pts[0], b=pts[pts.length-1];
    const cx=(a.x+b.x)/2, cy=(a.y+b.y)/2;
    const ang=Math.atan2(b.y-a.y,b.x-a.x);
    const len=Math.hypot(b.x-a.x,b.y-a.y);
    return {cx,cy,ang,len,a,b,pts};
  }

  function instGeometryDrag(inst) {
    const pts=_savedLegs.map(l=>holeToXY(l.row,l.col));
    const a=pts[0], b=pts[pts.length-1];
    const baseCx=(a.x+b.x)/2, baseCy=(a.y+b.y)/2;
    const cx=baseCx+_dragOffsetX, cy=baseCy+_dragOffsetY;
    const ang=Math.atan2(b.y-a.y,b.x-a.x);
    const len=Math.hypot(b.x-a.x,b.y-a.y);
    const shiftedPts=pts.map(p=>({x:p.x+_dragOffsetX,y:p.y+_dragOffsetY}));
    return {cx,cy,ang,len,a:shiftedPts[0],b:shiftedPts[shiftedPts.length-1],pts:shiftedPts};
  }

  function hitTestComp(x,y) {
    for(let i=_placed.length-1;i>=0;i--){
      const inst=_placed[i];
      const def=ComponentRegistry.getById(inst.defId);
      if(!def) continue;
      const geo=instGeometry(inst);
      const bw=(def.visual?.body_width||32)/2+12;
      const bh=(def.visual?.body_height||16)/2+12;
      const dx=x-geo.cx,dy=y-geo.cy;
      const lx=dx*Math.cos(-geo.ang)-dy*Math.sin(-geo.ang);
      const ly=dx*Math.sin(-geo.ang)+dy*Math.cos(-geo.ang);
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
    for(let i=0;i<inst.legs.length;i++){
      if(inst.legs.length===3&&i===1) continue; // skip center leg
      const {x:lx,y:ly}=holeToXY(inst.legs[i].row,inst.legs[i].col);
      if(Math.hypot(x-lx,y-ly)<LEG_HIT_R) return {inst,legIdx:i};
    }
    return null;
  }

  function hitTestWire(x,y) {
    for(const w of _wires){
      const a=holeToXY(w.r1,w.c1),b=holeToXY(w.r2,w.c2);
      if(distSeg(x,y,a.x,a.y,b.x,b.y)<WIRE_HIT_W) return w;
    }
    return null;
  }

  function distSeg(px,py,ax,ay,bx,by){
    const dx=bx-ax,dy=by-ay,l2=dx*dx+dy*dy;
    if(!l2) return Math.hypot(px-ax,py-ay);
    const t=Math.max(0,Math.min(1,((px-ax)*dx+(py-ay)*dy)/l2));
    return Math.hypot(px-(ax+t*dx),py-(ay+t*dy));
  }

  // ── DPR-aware init ────────────────────────────────────────────────────────────
  function initCanvas() {
    _dpr = window.devicePixelRatio || 1;
    const W=boardWidth(), H=boardHeight();
    canvas.width  = Math.round(W*_dpr);
    canvas.height = Math.round(H*_dpr);
    canvas.style.width  = W+'px';
    canvas.style.height = H+'px';
    ctx.setTransform(_dpr,0,0,_dpr,0,0);
  }

  // ── RENDER ────────────────────────────────────────────────────────────────────
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
    ctx.fillStyle=c.boardBg; roundRect(ctx,0,0,W,H,10); ctx.fill();
    ctx.fillStyle=c.stripe;
    for(let g=1;g<Math.ceil(COLS/5);g++){
      ctx.fillRect(holeX(g*5)-HOLE_PITCH/2-GROUP_GAP/2-0.5,L.gridTopY,1,10*HOLE_PITCH+DIP_GAP);
    }
    ctx.fillStyle=c.label; ctx.font='bold 9px IBM Plex Mono,monospace'; ctx.textAlign='center';
    ctx.fillText('DIP',ML/2,L.dipGapCenterY+3);
    ctx.fillText('DIP',W-MR/2,L.dipGapCenterY+3);
    drawRailStrip(c,'top'); drawRailStrip(c,'bot'); drawMainGrid(c);
  }

  function drawRailStrip(c,side) {
    const W=boardWidth(),L=_layout,isTop=side==='top';
    const sT=isTop?L.railTopStripTop:L.railBotStripTop;
    const sB=isTop?L.railTopStripBot:L.railBotStripBot;
    const sH=sB-sT;
    const mY=isTop?L.railTopMinusY:L.railBotMinusY;
    const pY=isTop?L.railTopPlusY:L.railBotPlusY;
    const rx=ML-6,rw=W-ML-MR+12;
    ctx.fillStyle=c.railBlueBg; ctx.fillRect(rx,sT,rw,sH/2);
    ctx.fillStyle=c.railRedBg;  ctx.fillRect(rx,sT+sH/2,rw,sH/2);
    const bx1=holeX(RAIL_BREAK-1)+HOLE_PITCH/2+4,bx2=holeX(RAIL_BREAK)-HOLE_PITCH/2-4;
    const lx1=holeX(0)-HOLE_PITCH/2+2,lx2=holeX(COLS-1)+HOLE_PITCH/2-2;
    ctx.lineWidth=1.5;
    ctx.strokeStyle=c.railBlue; brokenLine(mY,lx1,bx1,bx2,lx2);
    ctx.strokeStyle=c.railRed;  brokenLine(pY,lx1,bx1,bx2,lx2);
    ctx.font='bold 11px IBM Plex Mono,monospace'; ctx.textAlign='center';
    ctx.fillStyle=c.railBlue;
    ctx.fillText('–',ML/2,mY+4); ctx.fillText('–',W-MR/2,mY+4);
    ctx.fillStyle=c.railRed;
    ctx.fillText('+',ML/2,pY+4); ctx.fillText('+',W-MR/2,pY+4);
    for(let col=0;col<COLS;col++){
      if(col===RAIL_BREAK) continue;
      drawRailHole(col,mY,c,'blue',isTop?'rtm':'rbm');
      drawRailHole(col,pY,c,'red', isTop?'rtp':'rbp');
    }
  }

  function brokenLine(y,x1,bx1,bx2,x2){
    ctx.beginPath();ctx.moveTo(x1,y);ctx.lineTo(bx1,y);ctx.stroke();
    ctx.beginPath();ctx.moveTo(bx2,y);ctx.lineTo(x2,y);ctx.stroke();
  }

  function drawRailHole(col,y,c,color,railRow){
    const x=holeX(col);
    const isHov=_hoverHole?.row===railRow&&_hoverHole?.col===col;
    const isSrt=_wiringStart?.row===railRow&&_wiringStart?.col===col;
    if(isHov||isSrt){ctx.beginPath();ctx.arc(x,y,HOLE_R*2.8,0,Math.PI*2);ctx.fillStyle=isSrt?c.wireStart:c.hover;ctx.fill();}
    ctx.beginPath();ctx.arc(x+.5,y+.5,HOLE_R,0,Math.PI*2);ctx.fillStyle=c.holeShadow;ctx.fill();
    ctx.beginPath();ctx.arc(x,y,HOLE_R,0,Math.PI*2);
    ctx.fillStyle=color==='blue'?'rgba(43,87,154,0.35)':'rgba(176,32,46,0.35)';ctx.fill();
    ctx.beginPath();ctx.arc(x,y,HOLE_R-1,0,Math.PI*2);ctx.fillStyle=c.hole;ctx.fill();
  }

  function drawMainGrid(c){
    const L=_layout,W=boardWidth();
    ctx.font='10px IBM Plex Mono,monospace';ctx.fillStyle=c.label;
    for(let r=0;r<=9;r++){
      const y=L.rowY[r];
      ctx.textAlign='right';ctx.fillText(ROW_LABELS[r],ML-LABEL_PAD,y+3.5);
      ctx.textAlign='left'; ctx.fillText(ROW_LABELS[r],W-MR+LABEL_PAD,y+3.5);
    }
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
      const isBodyDrag=(_dragMode==='comp-dragging'&&inst===_dragInst);
      drawInst(inst,c,isBodyDrag?0.45:1.0,isBodyDrag);
    }
    if(_selectedComp){
      const inst=_placed.find(p=>p.instanceId===_selectedComp);
      if(inst) drawLegTargets(inst,c);
    }
  }

  function drawLegTargets(inst,c){
    const def=ComponentRegistry.getById(inst.defId);
    if(def?.category==='ic') return;
    for(let i=0;i<inst.legs.length;i++){
      if(inst.legs.length===3&&i===1) continue;
      const {x,y}=holeToXY(inst.legs[i].row,inst.legs[i].col);
      ctx.beginPath();ctx.arc(x,y,LEG_DOT_R+4,0,Math.PI*2);
      ctx.fillStyle='rgba(43,87,154,0.2)';ctx.fill();
      ctx.beginPath();ctx.arc(x,y,LEG_DOT_R,0,Math.PI*2);
      ctx.fillStyle=c.accent;ctx.fill();
      ctx.beginPath();ctx.arc(x,y,LEG_DOT_R,0,Math.PI*2);
      ctx.strokeStyle='rgba(255,255,255,0.7)';ctx.lineWidth=1.5;ctx.stroke();
      const ar=LEG_DOT_R-2;
      ctx.strokeStyle='#ffffff';ctx.lineWidth=1.5;ctx.lineCap='round';
      ctx.beginPath();ctx.moveTo(x-ar,y);ctx.lineTo(x-ar+3,y-2);ctx.moveTo(x-ar,y);ctx.lineTo(x-ar+3,y+2);ctx.stroke();
      ctx.beginPath();ctx.moveTo(x+ar,y);ctx.lineTo(x+ar-3,y-2);ctx.moveTo(x+ar,y);ctx.lineTo(x+ar-3,y+2);ctx.stroke();
    }
  }

  // ── Draw instance ─────────────────────────────────────────────────────────────
  function drawInst(inst,c,alpha,useOffset){
    const def=ComponentRegistry.getById(inst.defId);
    if(!def) return;
    const isSel=inst.instanceId===_selectedComp;
    const isFail=inst.failed;
    const geo=(useOffset&&_dragMode==='comp-dragging')?instGeometryDrag(inst):instGeometry(inst);
    const {cx,cy,ang,len,pts}=geo;

    ctx.save();
    ctx.translate(cx,cy);
    ctx.rotate(ang);
    if(alpha<1) ctx.globalAlpha=alpha;
    if(isFail)  ctx.globalAlpha=(alpha||1)*0.35;

    const halfLen=len/2;
    const bw=def.visual?.body_width||28, bh=def.visual?.body_height||14;
    const ll=def.visual?.lead_length||8;

    if(isSel&&alpha>=1){
      ctx.beginPath();ctx.ellipse(0,0,bw/2+9,bh/2+9,0,0,Math.PI*2);
      ctx.strokeStyle=c.warning;ctx.lineWidth=2;ctx.stroke();
    }

    // ── Leads: darker, wider, with hole-end caps ──────────────────────────────
    ctx.strokeStyle=LEAD_COLOR; ctx.lineWidth=LEAD_WIDTH; ctx.lineCap='round';

    if(inst.legs.length===2){
      // Left lead (leg 0)
      ctx.beginPath();ctx.moveTo(-halfLen,0);ctx.lineTo(-halfLen+ll,0);ctx.stroke();
      // Right lead (leg last)
      ctx.beginPath();ctx.moveTo(halfLen,0);ctx.lineTo(halfLen-ll,0);ctx.stroke();
      // Hole-end caps
      ctx.fillStyle=LEAD_COLOR;
      ctx.beginPath();ctx.arc(-halfLen,0,LEAD_CAP_R,0,Math.PI*2);ctx.fill();
      ctx.beginPath();ctx.arc(halfLen,0,LEAD_CAP_R,0,Math.PI*2);ctx.fill();

      // Power supply: polarity labels at lead ends
      if(def.id==='power_supply'){
        const isFlipped=inst.flipped;
        // + label near positive leg end (right if not flipped, left if flipped)
        ctx.font='bold 8px IBM Plex Mono,monospace';ctx.textAlign='center';
        ctx.fillStyle=c.railRed;
        ctx.fillText(isFlipped?'–':'+', isFlipped?-halfLen+4:halfLen-4, -6);
        ctx.fillStyle=c.railBlue;
        ctx.fillText(isFlipped?'+':'–', isFlipped?halfLen-4:-halfLen+4, -6);
      }

    } else if(inst.legs.length>=3){
      // 3-leg component: left outer (leg 0), right outer (leg last), center (leg 1)
      // Outer leads
      ctx.beginPath();ctx.moveTo(-halfLen,0);ctx.lineTo(-halfLen+ll,0);ctx.stroke();
      ctx.beginPath();ctx.moveTo(halfLen,0);ctx.lineTo(halfLen-ll,0);ctx.stroke();
      // Hole-end caps for outer legs
      ctx.fillStyle=LEAD_COLOR;
      ctx.beginPath();ctx.arc(-halfLen,0,LEAD_CAP_R,0,Math.PI*2);ctx.fill();
      ctx.beginPath();ctx.arc(halfLen,0,LEAD_CAP_R,0,Math.PI*2);ctx.fill();

      // Center leg (leg[1]): project world-space pixel into rotated local space
      // geo.pts[1] is the world pixel of the center leg (already shifted if dragging)
      if(pts&&pts[1]){
        const wPt=pts[1];
        // Transform world point into component-local space:
        // local = rotate(worldPt - center, -ang)
        const dx=wPt.x-cx, dy=wPt.y-cy;
        const cosA=Math.cos(-ang), sinA=Math.sin(-ang);
        const lx=dx*cosA-dy*sinA; // along component axis
        const ly=dx*sinA+dy*cosA; // perpendicular

        // Draw center lead from local point toward body
        // The lead goes from the leg hole (lx,ly) toward the body center
        const bodyEdge=ly>0?bh/2+ll:-bh/2-ll;
        ctx.beginPath();ctx.moveTo(lx,ly);ctx.lineTo(lx,ly>0?ll:-ll);ctx.stroke();
        ctx.fillStyle=LEAD_COLOR;
        ctx.beginPath();ctx.arc(lx,ly,LEAD_CAP_R,0,Math.PI*2);ctx.fill();
      }
    }

    if(inst.flipped) ctx.scale(-1,1);
    drawBody(def,inst,c,halfLen,ll);

    if(isFail&&alpha>=1){
      ctx.globalAlpha=1;
      ctx.font='bold 14px monospace';ctx.textAlign='center';
      ctx.fillStyle=c.alert;ctx.fillText('✕',0,-20);
    }
    ctx.restore();
  }

  // ── Body painters ─────────────────────────────────────────────────────────────
  function drawBody(def,inst,c,halfLen,ll){
    const bw=def.visual?.body_width||28,bh=def.visual?.body_height||14,col=def.visual?.body_color||'#888';
    switch(def.id){
      case 'resistor':              drawResistor(inst.props.resistance,bw,bh); break;
      case 'capacitor':             drawFilmCap(bw,bh); break;
      case 'capacitor_electrolytic':drawElectroCap(col,bw); break;
      case 'led':{const cm=def.color_map?.[inst.props.color]||{};drawLED(cm.hex||'#ff2200',bw,bh,inst._brightness||0);break;}
      case 'potentiometer':  drawPot(col,bw,bh,inst.props.wiper||0.5); break;
      case 'diode':          drawDiode(def,inst,bw,bh); break;
      case 'transistor_npn':
      case 'transistor_pnp': drawTransistor(def,inst,col,bw,bh); break;
      case 'switch_spst':    drawSwitch(bw,bh,c,inst._state||inst.props.state==='Closed'); break;
      case 'power_supply':   drawPower(col,bw,bh,inst.props.voltage); break;
      case 'signal_generator':drawSigGen(col,bw,bh,inst.props.waveform,c); break;
      default:
        ctx.fillStyle=col;roundRect(ctx,-bw/2,-bh/2,bw,bh,3);ctx.fill();
        ctx.fillStyle='#fff';ctx.font='bold 9px IBM Plex Mono,monospace';ctx.textAlign='center';
        ctx.fillText(def.symbol||def.id.slice(0,4).toUpperCase(),0,3);
    }
  }

  const BANDS=['#000','#8B4513','#f00','#f80','#ff0','#0a0','#00f','#808','#999','#fff'];
  function resBands(ohms){
    const m=parseFloat(ohms.toPrecision(2)),s=m.toString().replace('.','').padStart(2,'0').split('').map(Number);
    return[BANDS[s[0]%10],BANDS[s[1]%10],BANDS[Math.max(0,Math.floor(Math.log10(ohms)-1))%10],'#c8a000'];
  }
  function drawResistor(res,bw,bh){
    ctx.fillStyle='#d4b896';roundRect(ctx,-bw/2,-bh/2,bw,bh,3);ctx.fill();
    ctx.strokeStyle='#b09070';ctx.lineWidth=0.5;ctx.stroke();
    resBands(res||10000).forEach((h,i)=>{ctx.fillStyle=h;ctx.fillRect(-bw/2+6+i*6,-(bh-2)/2,4,bh-2);});
  }
  function drawFilmCap(bw,bh){
    ctx.fillStyle='#e8c860';roundRect(ctx,-bw/2,-bh/2,bw,bh,2);ctx.fill();
    ctx.strokeStyle='#c8a840';ctx.lineWidth=0.5;ctx.stroke();
  }
  function drawElectroCap(color,bw){
    const r=bw/2;
    ctx.beginPath();ctx.arc(0,0,r,0,Math.PI*2);ctx.fillStyle=color;ctx.fill();
    ctx.strokeStyle='rgba(255,255,255,0.15)';ctx.lineWidth=0.8;ctx.stroke();
    ctx.beginPath();ctx.moveTo(0,0);ctx.arc(0,0,r,Math.PI*0.6,Math.PI*1.4);ctx.closePath();
    ctx.fillStyle='rgba(255,255,255,0.55)';ctx.fill();
    ctx.fillStyle='rgba(20,20,40,0.9)';
    ctx.font=`bold ${Math.max(8,r*0.65)}px monospace`;ctx.textAlign='center';
    ctx.fillText('–',-r*0.55,r*0.22);
  }
  function drawLED(hex,bw,bh,brightness){
    if(brightness>0.05){
      const g=ctx.createRadialGradient(0,0,0,0,0,bw*(1+brightness*1.5));
      g.addColorStop(0,hex+Math.round(brightness*200).toString(16).padStart(2,'0'));
      g.addColorStop(1,'transparent');
      ctx.beginPath();ctx.arc(0,0,bw*(1+brightness*1.5),0,Math.PI*2);ctx.fillStyle=g;ctx.fill();
    }
    const r=bw/2,h=bh/2;
    ctx.beginPath();
    ctx.moveTo(-r,-h);ctx.lineTo(-r,h);ctx.lineTo(r*0.3,h);
    ctx.arc(0,0,r,Math.PI*0.5,-Math.PI*0.5,true);ctx.lineTo(r*0.3,-h);ctx.closePath();
    ctx.fillStyle=brightness>0.05?hex:hex+'88';ctx.fill();
    ctx.strokeStyle='rgba(0,0,0,0.4)';ctx.lineWidth=0.8;ctx.stroke();
    ctx.strokeStyle='rgba(255,255,255,0.6)';ctx.lineWidth=1.5;
    ctx.beginPath();ctx.moveTo(-r,-h);ctx.lineTo(-r,h);ctx.stroke();
    ctx.font='bold 7px monospace';ctx.textAlign='center';
    ctx.fillStyle='rgba(255,255,255,0.7)';ctx.fillText('+',r*0.35,3);
    ctx.fillStyle='rgba(255,255,255,0.5)';ctx.fillText('–',-r*0.5,3);
  }
  function drawPot(color,bw,bh,wiper){
    ctx.fillStyle=color;roundRect(ctx,-bw/2,-bh/2,bw,bh,3);ctx.fill();
    ctx.beginPath();ctx.arc(0,0,bw*0.28,0,Math.PI*2);ctx.fillStyle='#777';ctx.fill();
    const a=Utils.mapRange(wiper,0,1,-135,135)*(Math.PI/180);
    ctx.strokeStyle='#fff';ctx.lineWidth=2;
    ctx.beginPath();ctx.moveTo(0,0);ctx.lineTo(Math.cos(a)*bw*0.22,Math.sin(a)*bw*0.22);ctx.stroke();
  }
  function drawDiode(def,inst,bw,bh){
    const model=inst.props?.model||'1N4148';
    const isGerm=(def.model_params?.[model]?.type)==='germanium';
    if(isGerm){
      ctx.fillStyle='rgba(220,230,240,0.35)';roundRect(ctx,-bw/2,-bh/2,bw,bh,2);ctx.fill();
      ctx.strokeStyle='rgba(80,80,80,0.7)';ctx.lineWidth=1;ctx.stroke();
      ctx.fillStyle='rgba(30,30,30,0.85)';ctx.fillRect(bw/2-5,-bh/2,4,bh);
    }else{
      ctx.fillStyle='#1a1a1a';roundRect(ctx,-bw/2,-bh/2,bw,bh,2);ctx.fill();
      ctx.fillStyle='#ffffff';ctx.fillRect(bw/2-5,-bh/2,3,bh);
    }
  }
  function drawTransistor(def,inst,color,bw,bh){
    const model=inst.props?.model||'';
    const isGerm=(def.model_params?.[model]?.type)==='germanium';
    const r=bw/2,type=def.id==='transistor_pnp'?'PNP':'NPN';
    if(isGerm){
      const grd=ctx.createRadialGradient(-r*0.3,-r*0.3,0,0,0,r);
      grd.addColorStop(0,'#e0e0e0');grd.addColorStop(0.6,'#a0a0a0');grd.addColorStop(1,'#606060');
      ctx.beginPath();ctx.arc(0,0,r,0,Math.PI*2);ctx.fillStyle=grd;ctx.fill();
      ctx.strokeStyle='#888';ctx.lineWidth=0.8;ctx.stroke();
      ctx.beginPath();ctx.arc(0,r*0.85,r*0.12,0,Math.PI*2);ctx.fillStyle='#555';ctx.fill();
    }else{
      ctx.fillStyle='#111';ctx.beginPath();
      ctx.arc(0,0,r,-Math.PI/2,Math.PI/2);ctx.lineTo(0,r);ctx.lineTo(0,-r);ctx.closePath();ctx.fill();
      ctx.strokeStyle='rgba(255,255,255,0.12)';ctx.lineWidth=0.8;ctx.stroke();
      ctx.strokeStyle='rgba(255,255,255,0.25)';ctx.lineWidth=1;
      ctx.beginPath();ctx.moveTo(0,-r);ctx.lineTo(0,r);ctx.stroke();
    }
    ctx.strokeStyle='rgba(255,255,255,0.55)';ctx.lineWidth=1.3;
    ctx.beginPath();ctx.moveTo(-r*0.65,0);ctx.lineTo(0,0);ctx.stroke();
    ctx.beginPath();ctx.moveTo(0,-r*0.4);ctx.lineTo(r*0.6,-r*0.72);ctx.stroke();
    ctx.beginPath();ctx.moveTo(0,r*0.4); ctx.lineTo(r*0.6,r*0.72); ctx.stroke();
    const ax=r*0.6,ay=r*0.72;
    ctx.fillStyle='rgba(255,255,255,0.55)';ctx.beginPath();
    if(type==='NPN'){ctx.moveTo(ax,ay);ctx.lineTo(ax-5,ay-3);ctx.lineTo(ax-5,ay+3);}
    else{ctx.moveTo(ax-5,ay);ctx.lineTo(ax,ay-3);ctx.lineTo(ax,ay+3);}
    ctx.closePath();ctx.fill();
    ctx.fillStyle='rgba(255,255,255,0.6)';
    ctx.font=`bold ${Math.max(5,r*0.38)}px IBM Plex Mono,monospace`;ctx.textAlign='center';
    ctx.fillText(model||type,r*0.22,3);
  }
  function drawSwitch(bw,bh,c,closed){
    ctx.fillStyle='#3a3a3a';roundRect(ctx,-bw/2,-bh/2,bw,bh,3);ctx.fill();
    ctx.strokeStyle=closed?c.success:c.alert;ctx.lineWidth=2.5;
    ctx.beginPath();ctx.moveTo(-bw/2+6,0);ctx.lineTo(bw/2-6,closed?0:-bh/2+4);ctx.stroke();
    ctx.fillStyle=closed?c.success:c.alert;
    ctx.font='8px IBM Plex Mono,monospace';ctx.textAlign='center';ctx.fillText(closed?'ON':'OFF',0,bh/2-2);
  }
  function drawPower(color,bw,bh,v){
    // Two-tone body: left half blue (–), right half red (+)
    const hw=bw/2,hh=bh/2;
    // Left (–) half
    ctx.fillStyle='rgba(43,87,154,0.85)';
    ctx.beginPath();ctx.moveTo(-hw,hh);ctx.lineTo(0,hh);ctx.lineTo(0,-hh);ctx.lineTo(-hw,-hh);
    ctx.quadraticCurveTo(-hw-2,-hh,-hw-2,hh-4);ctx.quadraticCurveTo(-hw-2,hh,-hw,hh);ctx.closePath();ctx.fill();
    // Right (+) half
    ctx.fillStyle='rgba(176,32,46,0.85)';
    ctx.beginPath();ctx.moveTo(0,hh);ctx.lineTo(hw,hh);ctx.quadraticCurveTo(hw+2,hh,hw+2,hh-4);
    ctx.quadraticCurveTo(hw+2,-hh,hw,-hh);ctx.lineTo(0,-hh);ctx.closePath();ctx.fill();
    // Border
    ctx.strokeStyle='rgba(255,255,255,0.2)';ctx.lineWidth=0.8;
    roundRect(ctx,-hw,-hh,bw,bh,3);ctx.stroke();
    // Voltage label
    ctx.fillStyle='#fff';ctx.font=`bold ${Math.max(7,bh*0.45)}px IBM Plex Mono,monospace`;ctx.textAlign='center';
    ctx.fillText(`${v}V`,0,3);
    // + and – inside halves
    ctx.font='bold 8px monospace';
    ctx.fillStyle='rgba(255,255,255,0.8)';
    ctx.fillText('+',hw*0.6,-hh+9);
    ctx.fillText('–',-hw*0.6,-hh+9);
  }
  function drawSigGen(color,bw,bh,waveform,c){
    ctx.fillStyle=color;roundRect(ctx,-bw/2,-bh/2,bw,bh,4);ctx.fill();
    ctx.strokeStyle=c.scopeTrace;ctx.lineWidth=1.5;
    miniWave(waveform,-bw/2+4,-3,bw-8,8);
  }
  function miniWave(type,x,y,w,h){
    ctx.beginPath();
    for(let i=0;i<=40;i++){
      const t=i/40,px=x+t*w,ph=t*Math.PI*4;
      let v;
      switch(type){case'Sine':v=Math.sin(ph);break;case'Square':v=Math.sign(Math.sin(ph));break;
        case'Sawtooth':v=((ph/(Math.PI*2))%1)*2-1;break;case'Triangle':v=Math.asin(Math.sin(ph))*(2/Math.PI);break;
        default:v=(Math.random()*2-1)*0.5;}
      i===0?ctx.moveTo(px,y-v*h/2):ctx.lineTo(px,y-v*h/2);
    }
    ctx.stroke();
  }

  // ── Palette ghost ─────────────────────────────────────────────────────────────
  function drawPaletteGhost(mx,my,c){
    if(!_paletteGhost) return;
    const def=ComponentRegistry.getById(_paletteGhost.defId);
    if(!def) return;
    const bw=def.visual?.body_width||28,bh=def.visual?.body_height||14;
    const span=(def.leg_span||2)-1;
    const halfLen=span*HOLE_PITCH/2;
    const ll=def.visual?.lead_length||8;
    const fakeInst={defId:def.id,legs:[{row:3,col:5},{row:3,col:5+span}],flipped:false,props:{},failed:false,_brightness:0,_state:false};
    for(const p of (def.properties||[])) fakeInst.props[p.key]=p.default;
    ctx.save();ctx.translate(mx,my);ctx.globalAlpha=0.72;
    ctx.strokeStyle=LEAD_COLOR;ctx.lineWidth=LEAD_WIDTH;
    ctx.beginPath();ctx.moveTo(-halfLen,0);ctx.lineTo(-halfLen+ll,0);ctx.stroke();
    ctx.beginPath();ctx.moveTo(halfLen,0);ctx.lineTo(halfLen-ll,0);ctx.stroke();
    ctx.fillStyle=LEAD_COLOR;
    ctx.beginPath();ctx.arc(-halfLen,0,LEAD_CAP_R,0,Math.PI*2);ctx.fill();
    ctx.beginPath();ctx.arc(halfLen,0,LEAD_CAP_R,0,Math.PI*2);ctx.fill();
    drawBody(def,fakeInst,c,halfLen,ll);
    ctx.restore();
  }

  // ── Events ────────────────────────────────────────────────────────────────────
  function init(canvasEl){
    canvas=canvasEl;ctx=canvas.getContext('2d');
    _layout=buildLayout(); initCanvas();
    canvas.addEventListener('mousemove',   onMouseMove);
    canvas.addEventListener('mousedown',   onMouseDown);
    canvas.addEventListener('mouseup',     onMouseUp);
    canvas.addEventListener('click',       onClick);
    canvas.addEventListener('dragover',    e=>e.preventDefault());
    canvas.addEventListener('drop',        onDrop);
    canvas.addEventListener('contextmenu', e=>e.preventDefault());
    window.addEventListener('mouseup',     onWindowMouseUp);
    window.addEventListener('keydown',     onBoardKeyDown);
    render();
  }

  function onMouseMove(e){
    const {x,y}=eventToCanvas(e);
    _mouseX=x;_mouseY=y;
    _hoverHole=xyToHole(x,y);
    if(Wire.isWiring()){render(x,y);return;}
    if(_dragMode==='comp-pending'){
      if(Math.hypot(x-_dragStartX,y-_dragStartY)>DRAG_THRESHOLD){
        _dragMode='comp-dragging';document.body.classList.add('dragging');
      }
    }
    if(_dragMode==='comp-dragging'){_dragOffsetX=x-_dragStartX;_dragOffsetY=y-_dragStartY;}
    if(_dragMode==='leg-dragging'&&_dragInst&&_hoverHole) updateLegDrag();
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

  function onMouseDown(e){
    if(e.button!==0) return;
    const {x,y}=eventToCanvas(e);
    if(Wire.isWiring()){const h=xyToHole(x,y);if(h) Wire.startOrFinish(h);return;}
    const legHit=hitTestLeg(x,y);
    if(legHit){
      _dragMode='leg-dragging';_dragInst=legHit.inst;_dragLegIdx=legHit.legIdx;
      _savedLegs=legHit.inst.legs.map(l=>({...l}));
      _dragAnchorLeg=legHit.inst.legs.length===2
        ?legHit.inst.legs[legHit.legIdx===0?1:0]
        :legHit.inst.legs[legHit.legIdx===0?2:0];
      return;
    }
    const inst=hitTestComp(x,y);
    if(inst){
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
    const {x,y}=eventToCanvas(e);
    if(_dragMode==='leg-dragging'){
      _dragMode='idle';_dragInst=null;_dragAnchorLeg=null;_dragLegIdx=-1;
      Storage.markDirty();History.push();render();return;
    }
    if(_dragMode==='comp-dragging'){
      if(_dragInst&&_savedLegs){
        _dragInst.legs=_savedLegs.map(l=>{
          const {x:lx,y:ly}=holeToXY(l.row,l.col);
          return xyToHole(lx+_dragOffsetX,ly+_dragOffsetY,DROP_SNAP_RADIUS)||l;
        });
      }
      _dragMode='idle';_dragOffsetX=0;_dragOffsetY=0;
      document.body.classList.remove('dragging');
      Storage.markDirty();History.push();_dragInst=null;render();return;
    }
    if(_dragMode==='comp-pending'){_dragMode='idle';_dragInst=null;}
  }

  function onWindowMouseUp(){
    if(_dragMode==='comp-dragging'||_dragMode==='leg-dragging'){
      if(_dragInst&&_savedLegs) _dragInst.legs=_savedLegs.map(l=>({...l}));
      _dragMode='idle';_dragOffsetX=0;_dragOffsetY=0;
      document.body.classList.remove('dragging');
      _dragInst=null;_dragAnchorLeg=null;_dragLegIdx=-1;render();
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
  }

  function onClick(e){
    if(_dragMode!=='idle') return;
    const {x,y}=eventToCanvas(e);
    const inst=hitTestComp(x,y);if(!inst) return;
    const def=ComponentRegistry.getById(inst.defId);
    if(def?.behavior?.type==='switch_spst'){
      inst._state=!inst._state;Simulation.notifyStateChange(inst);
      Storage.markDirty();History.push();render();
    }
  }

  function onDrop(e){
    e.preventDefault();
    const defId=e.dataTransfer.getData('text/plain');if(!defId) return;
    const {x,y}=eventToCanvas(e);
    // Generous snap: find nearest hole within DROP_SNAP_RADIUS
    const hole=xyToHole(x,y,DROP_SNAP_RADIUS);
    if(!hole) return;
    const inst=ComponentRegistry.createInstance(defId,hole.row,hole.col);
    _placed.push(inst);setSelected(inst.instanceId,null);
    if(_onPlace) _onPlace(inst);
    History.push();render();
  }

  // ── Wire helpers ──────────────────────────────────────────────────────────────
  const WIRE_COLORS=['#ff9900','#ff3333','#3399ff','#33cc66','#cc33ff','#ffee33','#ffffff','#ff6699'];
  let _wireColorIdx=0;
  function setStartWire(h){_wiringStart=h;render();}
  function clearWire(){_wiringStart=null;render();}
  function addWire(w){_wires.push(w);render();}
  function getWires(){return _wires;}
  function nextWireColor(){return WIRE_COLORS[(_wireColorIdx++)%WIRE_COLORS.length];}

  // ── Selection ─────────────────────────────────────────────────────────────────
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

  // ── Public API ────────────────────────────────────────────────────────────────
  function setZoom(z){_zoom=z;}
  function getPlaced(){return _placed;}
  function setDragGhost(defId){_paletteGhost=defId?{defId}:null;}
  function onSelect(fn){_onSelect=fn;}
  function onPlace(fn){_onPlace=fn;}
  function redraw(){render();}
  function clear(){_placed=[];_wires=[];setSelected(null,null);}
  function loadLayout(layout){_placed=layout.components||[];_wires=layout.wires||[];setSelected(null,null);render();}
  function getLayoutData(){
    return{components:_placed.map(inst=>{const c=Utils.clone(inst);delete c._voltage;delete c._current;delete c._audioNode;delete c._brightness;delete c._state;return c;}),wires:_wires};
  }

  function roundRect(ctx,x,y,w,h,r){
    ctx.beginPath();
    ctx.moveTo(x+r,y);ctx.lineTo(x+w-r,y);ctx.quadraticCurveTo(x+w,y,x+w,y+r);
    ctx.lineTo(x+w,y+h-r);ctx.quadraticCurveTo(x+w,y+h,x+w-r,y+h);
    ctx.lineTo(x+r,y+h);ctx.quadraticCurveTo(x,y+h,x,y+h-r);
    ctx.lineTo(x,y+r);ctx.quadraticCurveTo(x,y,x+r,y);
    ctx.closePath();
  }

  return{
    init,render,clear,loadLayout,getLayoutData,
    getPlaced,getWires,addWire,nextWireColor,
    setDragGhost,setStartWire,clearWire,
    setSelected,getSelected,deleteSelected,
    onSelect,onPlace,holeToXY,xyToHole,redraw,setZoom
  };
})();
