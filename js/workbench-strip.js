// ── Workbench Strip ───────────────────────────────────────────────────────────
// Permanent hardware strip: logo, input/output jacks, power supply, and the
// bypass switch + status LED/CLR. Renders on its own canvas, stacked directly
// above the (unmodified) board canvas, sized to match its width exactly via
// Board.getBoardWidth() so the two always stay proportional to each other.
//
// This is visual only, matching the approved mockup pixel-for-pixel at the
// same unit scale as the real board (same HOLE_PITCH/margins) — none of it is
// wired into the simulation yet.

const WorkbenchStrip = (() => {
  let canvas, ctx, _dpr = 1;

  // Same unit scale as board.js (HOLE_PITCH=20, ML/MR=52, MT/MB=14) so this
  // strip is proportional to the real board without needing to duplicate its
  // full layout math — it only borrows the handful of constants relevant here.
  const HOLE_PITCH = 20;
  const STRIP_H = 96;
  const BYPASS_ON_DEFAULT = false;

  let bypassOn = BYPASS_ON_DEFAULT;

  function cv(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

  function init(canvasEl) {
    canvas = canvasEl;
    ctx = canvas.getContext('2d');
    canvas.addEventListener('click', onClick);
    render();
  }

  function boardWidth() {
    return (typeof Board !== 'undefined' && Board.getBoardWidth) ? Board.getBoardWidth() : 800;
  }

  function render() {
    _dpr = window.devicePixelRatio || 1;
    const W = boardWidth(), H = STRIP_H;
    canvas.width = Math.round(W*_dpr); canvas.height = Math.round(H*_dpr);
    canvas.style.width = W+'px'; canvas.style.height = H+'px';
    ctx.setTransform(_dpr,0,0,_dpr,0,0);
    ctx.clearRect(0,0,W,H);
    drawStrip(W,H);
  }

  // ── Shape helpers (mirrors Shapes.roundRect's approach) ──────────────────
  function roundRect(x,y,w,h,r){
    ctx.beginPath();ctx.moveTo(x+r,y);ctx.lineTo(x+w-r,y);ctx.quadraticCurveTo(x+w,y,x+w,y+r);
    ctx.lineTo(x+w,y+h-r);ctx.quadraticCurveTo(x+w,y+h,x+w-r,y+h);
    ctx.lineTo(x+r,y+h);ctx.quadraticCurveTo(x,y+h,x,y+h-r);
    ctx.lineTo(x,y+r);ctx.quadraticCurveTo(x,y,x+r,y);ctx.closePath();
  }
  // Only the top two corners rounded, so this strip meets the board flush
  // along the full seam (the board canvas below keeps its own corners as-is —
  // unchanged — so there's a small reveal at the two top board corners; see
  // note in the project docs/chat about squaring those off later if wanted).
  function roundRectTop(x,y,w,h,r){
    ctx.beginPath();ctx.moveTo(x+r,y);ctx.lineTo(x+w-r,y);ctx.quadraticCurveTo(x+w,y,x+w,y+r);
    ctx.lineTo(x+w,y+h);ctx.lineTo(x,y+h);
    ctx.lineTo(x,y+r);ctx.quadraticCurveTo(x,y,x+r,y);ctx.closePath();
  }

  function drawTrace(x1,y1,x2,y2,tint){
    ctx.strokeStyle=tint||'rgba(90,70,55,0.35)'; ctx.lineWidth=3;
    ctx.beginPath();ctx.moveTo(x1,y1);ctx.lineTo(x2,y2);ctx.stroke();
    ctx.strokeStyle='rgba(255,255,255,0.15)'; ctx.lineWidth=1;
    ctx.beginPath();ctx.moveTo(x1,y1);ctx.lineTo(x2,y2);ctx.stroke();
  }

  // Real board column positions (via Board's own holeToXY — same source of
  // truth the board itself uses, so these line up with actual holes once
  // wiring is added later). Falls back to a fraction of width if Board isn't
  // ready yet, so this never throws during early load.
  function colX(col, fallbackFrac) {
    if (typeof Board !== 'undefined' && Board.holeToXY) return Board.holeToXY(0, col).x;
    return boardWidth()*fallbackFrac;
  }
  function inputX(){ return colX(2, 0.06); }
  function outputX(){ return colX(59, 0.94); } // near the far right column on the real (63-col) board
  function powerMinusX(){ return colX(18, 0.29); }
  function powerPlusX(){ return colX(19, 0.31); }
  function powerX(){ return (powerMinusX()+powerPlusX())/2; }
  function switchX(){ return boardWidth()*0.66; }

  function drawStrip(w,h){
    ctx.save();
    const grad = ctx.createLinearGradient(0,0,0,h);
    grad.addColorStop(0,'#E4DED6'); grad.addColorStop(1,'#D9D2C8');
    ctx.fillStyle=grad;
    roundRectTop(0,0,w,h,10);
    ctx.fill();
    ctx.strokeStyle='rgba(0,0,0,0.12)'; ctx.lineWidth=1; ctx.stroke();

    drawLogo(30, h/2);
    drawJack(inputX(), h/2, 'IN');
    drawPowerBlock(powerX(), h/2);
    drawSwitchCluster(switchX(), h/2);
    drawJack(outputX(), h/2, 'OUT');

    // Traces terminate at the strip's own bottom edge (flush seam with the
    // board below) — they don't reach into specific board holes yet, since
    // that would mean drawing onto the (unmodified) board canvas itself.
    drawTrace(inputX(), h*0.8, inputX(), h);
    drawTrace(outputX(), h*0.8, outputX(), h);
    drawTrace(powerMinusX(), h*0.8, powerMinusX(), h, 'rgba(43,87,154,0.45)');
    drawTrace(powerPlusX(),  h*0.8, powerPlusX(),  h, 'rgba(176,32,46,0.45)');

    ctx.restore();
  }

  function drawLogo(cx,cy){
    ctx.save();ctx.translate(cx,cy);
    ctx.strokeStyle='rgba(92,64,51,0.55)'; ctx.lineWidth=2;
    ctx.beginPath();ctx.arc(0,0,13,0,Math.PI*2);ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(-5,7);ctx.lineTo(-5,-7);ctx.lineTo(3,-7);
    ctx.quadraticCurveTo(8,-7,8,-2);ctx.quadraticCurveTo(8,3,3,3);ctx.lineTo(-5,3);
    ctx.moveTo(1,3);ctx.lineTo(6,7);
    ctx.strokeStyle='rgba(92,64,51,0.75)'; ctx.lineWidth=1.6; ctx.stroke();
    ctx.restore();
  }

  function drawJack(cx,cy,label){
    ctx.save();ctx.translate(cx,cy);
    const hexR=19.965;
    ctx.beginPath();
    for(let i=0;i<6;i++){
      const a=Math.PI/6 + i*Math.PI/3;
      const px=Math.cos(a)*hexR, py=Math.sin(a)*hexR;
      i===0?ctx.moveTo(px,py):ctx.lineTo(px,py);
    }
    ctx.closePath();
    const gHex=ctx.createLinearGradient(-hexR,-hexR,hexR,hexR);
    gHex.addColorStop(0,'#c4c4cc');gHex.addColorStop(0.5,'#8a8a92');gHex.addColorStop(1,'#5c5c64');
    ctx.fillStyle=gHex; ctx.fill();
    ctx.strokeStyle='rgba(0,0,0,0.35)';ctx.lineWidth=1;ctx.stroke();

    const barrelR=13.31;
    ctx.beginPath();ctx.arc(0,0,barrelR,0,Math.PI*2);
    const g=ctx.createRadialGradient(-2,-2,barrelR*0.7,0,0,barrelR);
    g.addColorStop(0,'#9a9aa2');g.addColorStop(1,'#5c5c64');
    ctx.fillStyle=g;ctx.fill();
    ctx.strokeStyle='rgba(0,0,0,0.4)';ctx.lineWidth=1;ctx.stroke();
    ctx.beginPath();ctx.arc(0,0,barrelR*0.82,0,Math.PI*2);ctx.fillStyle='#141414';ctx.fill();

    ctx.font='bold 9px IBM Plex Mono, monospace'; ctx.textAlign='center'; ctx.fillStyle='rgba(92,64,51,0.8)';
    ctx.fillText(label,0,hexR+14);
    ctx.restore();
  }

  function drawPowerBlock(cx,cy){
    const bw=40,bh=44,hw=bw/2,hh=bh/2;
    ctx.save();ctx.translate(cx,cy);
    ctx.fillStyle='rgba(43,87,154,0.85)'; ctx.fillRect(-hw,-hh,bw,bh/2);
    ctx.fillStyle='rgba(176,32,46,0.85)'; ctx.fillRect(-hw,0,bw,bh/2);
    ctx.strokeStyle='rgba(255,255,255,0.25)';ctx.lineWidth=0.8;roundRect(-hw,-hh,bw,bh,3);ctx.stroke();
    ctx.fillStyle='#fff';ctx.font='bold 11px IBM Plex Mono, monospace';ctx.textAlign='center';
    ctx.fillText('9V',0,4);
    ctx.font='bold 8px monospace';
    ctx.fillStyle='rgba(255,255,255,0.85)';
    ctx.fillText('–',0,-hh+10);
    ctx.fillText('+',0,hh-4);
    ctx.font='bold 9px IBM Plex Mono, monospace'; ctx.fillStyle='rgba(92,64,51,0.8)'; ctx.textAlign='center';
    ctx.fillText('POWER', 0, hh+16);
    ctx.restore();
  }

  function drawSwitchCluster(cx,cy){
    ctx.save(); ctx.translate(cx,cy);

    const ledX=-58, ledY=-6;
    ctx.save();ctx.translate(ledX,ledY);
    const hex='#ff3b3b';
    if(bypassOn){
      const glow=ctx.createRadialGradient(0,0,0,0,0,14);
      glow.addColorStop(0, hex+'cc'); glow.addColorStop(1,'transparent');
      ctx.beginPath();ctx.arc(0,0,14,0,Math.PI*2);ctx.fillStyle=glow;ctx.fill();
    }
    ctx.beginPath();ctx.arc(0,0,5,0,Math.PI*2);
    ctx.fillStyle = bypassOn ? hex : '#7a3030';
    ctx.fill();
    ctx.strokeStyle='rgba(0,0,0,0.4)';ctx.lineWidth=0.8;ctx.stroke();
    ctx.restore();

    const clrX=-58, clrY=18;
    ctx.save();ctx.translate(clrX,clrY);
    const bw=26,bh=8;
    ctx.fillStyle='#d4b896';roundRect(-bw/2,-bh/2,bw,bh,2);ctx.fill();
    ctx.strokeStyle='#b09070';ctx.lineWidth=0.5;ctx.stroke();
    ['#8B4513','#000','#f00','#c8a000'].forEach((col,i)=>{ctx.fillStyle=col;ctx.fillRect(-bw/2+4+i*4,-(bh-2)/2,2.4,bh-2);});
    ctx.restore();
    ctx.font='8px IBM Plex Mono, monospace'; ctx.fillStyle='rgba(92,64,51,0.7)'; ctx.textAlign='left';
    ctx.fillText('CLR', clrX+16, clrY+3);

    const swX=26;
    ctx.save();ctx.translate(swX,0);
    const bzW=64, bzH=30;
    const gBz=ctx.createLinearGradient(0,-bzH/2,0,bzH/2);
    gBz.addColorStop(0,'#9a9aa2');gBz.addColorStop(1,'#6a6a72');
    roundRect(-bzW/2,-bzH/2,bzW,bzH,6); ctx.fillStyle=gBz; ctx.fill();
    ctx.strokeStyle='rgba(0,0,0,0.35)';ctx.lineWidth=1;ctx.stroke();

    const rW=56, rH=20, half=rW/2;
    roundRect(-half,-rH/2,rW,rH,4); ctx.save(); ctx.clip();

    const leftG = ctx.createLinearGradient(0,-rH/2,0,rH/2);
    if(bypassOn){ leftG.addColorStop(0,'#8a8a92'); leftG.addColorStop(1,'#6e6e76'); }
    else        { leftG.addColorStop(0,'#f2f2f5'); leftG.addColorStop(1,'#d4d4da'); }
    ctx.fillStyle=leftG; ctx.fillRect(-half,-rH/2,half,rH);

    const rightG = ctx.createLinearGradient(0,-rH/2,0,rH/2);
    if(bypassOn){ rightG.addColorStop(0,'#f2f2f5'); rightG.addColorStop(1,'#d4d4da'); }
    else        { rightG.addColorStop(0,'#8a8a92'); rightG.addColorStop(1,'#6e6e76'); }
    ctx.fillStyle=rightG; ctx.fillRect(0,-rH/2,half,rH);

    ctx.strokeStyle='rgba(0,0,0,0.3)'; ctx.lineWidth=1;
    ctx.beginPath();ctx.moveTo(0,-rH/2);ctx.lineTo(0,rH/2);ctx.stroke();
    ctx.strokeStyle='rgba(255,255,255,0.5)'; ctx.lineWidth=1;
    ctx.beginPath();
    if(bypassOn) ctx.moveTo(0,-rH/2+1),ctx.lineTo(half,-rH/2+1);
    else ctx.moveTo(-half,-rH/2+1),ctx.lineTo(0,-rH/2+1);
    ctx.stroke();
    ctx.restore();
    ctx.strokeStyle='rgba(0,0,0,0.4)'; ctx.lineWidth=1; roundRect(-half,-rH/2,rW,rH,4); ctx.stroke();
    ctx.restore();

    const labelY = bzH/2+14;
    ctx.font='bold 8px IBM Plex Mono, monospace'; ctx.fillStyle='rgba(92,64,51,0.8)';
    ctx.textAlign='center';
    ctx.fillText('BYPASS', swX-21, labelY);
    ctx.fillText('ENGAGE', swX+21, labelY);
    ctx.strokeStyle='rgba(92,64,51,0.5)'; ctx.lineWidth=1.5;
    ctx.beginPath();ctx.moveTo(swX,labelY-9);ctx.lineTo(swX,labelY+3);ctx.stroke();

    ctx.restore();
  }

  function onClick(e){
    const rect=canvas.getBoundingClientRect();
    const x=(e.clientX-rect.left)*(canvas.width/rect.width)/_dpr;
    const y=(e.clientY-rect.top)*(canvas.height/rect.height)/_dpr;
    const cx = switchX()+26, cy = STRIP_H/2;
    if(Math.abs(x-cx)<32 && Math.abs(y-cy)<15){ bypassOn=!bypassOn; render(); }
  }

  return { init, render };
})();