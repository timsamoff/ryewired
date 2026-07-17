// ── Workbench Strip ───────────────────────────────────────────────────────────

const WorkbenchStrip = (() => {
  let canvas, ctx, _dpr = 1;

  const HOLE_PITCH = 20;
  const STRIP_H = 96;
  const OVERLAP = 16;
  const BYPASS_ON_DEFAULT = false;

  let bypassOn = BYPASS_ON_DEFAULT;
  let logoImg = null, logoReady = false;
  let _hoverTarget = null; // 'input' | 'output' | 'power' | 'switch' | null — drives the hover highlight

  const DEFAULT_PERMANENT_STATE = {
    power:  { voltage: 9, reverse_polarity: false, power_on: true, battery_sag: 0, internal_resistance: 1 },
    input:  { waveform: 'None', frequency: 440, amplitude: 1.0, dc_offset: 0, phase: 0, looping: true, audio_file: null },
    output: { volume: 1.0, mute: false },
  };
  let permanentState = cloneState(DEFAULT_PERMANENT_STATE);
  function cloneState(s) { return JSON.parse(JSON.stringify(s)); }

  function getPermanentState() { return permanentState; }
  function setPermanentState(saved) {
    permanentState = {
      power:  Object.assign(cloneState(DEFAULT_PERMANENT_STATE).power,  saved?.power  || {}),
      input:  Object.assign(cloneState(DEFAULT_PERMANENT_STATE).input,  saved?.input  || {}),
      output: Object.assign(cloneState(DEFAULT_PERMANENT_STATE).output, saved?.output || {}),
    };
    // The decoded audio buffer only ever lives in memory (AudioEngine's
    // _audioBuffer) — it's never persisted. Only the filename string was
    // saved, so on reload it would otherwise show "Change Audio File" with
    // the old name even though nothing is actually loaded. Clear it so the
    // UI correctly says "Load Audio File..." again.
    if (permanentState.input.audio_file) permanentState.input.audio_file = null;
    render();
  }

  let _onSelectPermanent = null;
  function onSelectPermanent(fn) { _onSelectPermanent = fn; }

  // Used by Clear Board — resets just the Input device (waveform, and every
  // other Input property) back to its defaults, leaving Power/Output alone.
  function resetInput() {
    permanentState.input = cloneState(DEFAULT_PERMANENT_STATE).input;
    render();
  }

  function cv(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

  function init(canvasEl) {
    canvas = canvasEl;
    ctx = canvas.getContext('2d');
    canvas.addEventListener('click', onClick);
    canvas.addEventListener('mousemove', onMouseMove);
    canvas.addEventListener('mouseleave', onMouseLeave);
    logoImg = new Image();
    logoImg.onload = () => { logoReady = true; render(); };
    logoImg.src = './icon.png';
    render();
  }

  function boardWidth() {
    return (typeof Board !== 'undefined' && Board.getBoardWidth) ? Board.getBoardWidth() : 800;
  }

  function getVisualHeight() { return STRIP_H; }

  function render() {
    _dpr = window.devicePixelRatio || 1;
    const W = boardWidth(), H = STRIP_H + OVERLAP;
    canvas.width = Math.round(W*_dpr); canvas.height = Math.round(H*_dpr);
    canvas.style.width = W+'px'; canvas.style.height = H+'px';
    ctx.setTransform(_dpr,0,0,_dpr,0,0);
    ctx.clearRect(0,0,W,H);
    drawStrip(W,STRIP_H);
  }

  // ── Shape helpers (mirrors Shapes.roundRect's approach) ──────────────────
  function roundRect(x,y,w,h,r){
    ctx.beginPath();ctx.moveTo(x+r,y);ctx.lineTo(x+w-r,y);ctx.quadraticCurveTo(x+w,y,x+w,y+r);
    ctx.lineTo(x+w,y+h-r);ctx.quadraticCurveTo(x+w,y+h,x+w-r,y+h);
    ctx.lineTo(x+r,y+h);ctx.quadraticCurveTo(x,y+h,x,y+h-r);
    ctx.lineTo(x,y+r);ctx.quadraticCurveTo(x,y,x+r,y);ctx.closePath();
  }
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

  function labelBg(text, cx, cy, font){
    ctx.save();
    ctx.font = font;
    const w = ctx.measureText(text).width;
    const padX = 4, padY = 2, h = 8;
    ctx.fillStyle = '#DCD5CA'; // approximates the strip's own background gradient
    roundRect(cx - w/2 - padX, cy - h/2 - padY, w + padX*2, h + padY*2, 2);
    ctx.fill();
    ctx.restore();
  }

  function colX(col, fallbackFrac) {
    if (typeof Board !== 'undefined' && Board.holeToXY) return Board.holeToXY(0, col).x;
    return boardWidth()*fallbackFrac;
  }

  function inputX(){ return colX(55, 0.90); }  // In/Out swapped: IN now on the right
  function outputX(){ return colX(6, 0.10); }  // In/Out swapped: OUT now on the left

  // Bypass Switch/LED group and the permanent Power Source, centered as a
  // pair on the midpoint between Input and Output — computed from the live
  // inputX()/outputX() above, so this stays correct regardless of which
  // side either jack is on. The half-gap preserves the same relative
  // spacing between switch and power that existed before centering (just
  // measured once, from the layout's own column geometry, rather than
  // tied to specific fixed columns).
  const GROUP_HALF_GAP = (colX(55,0.90) - colX(18,0.29)) / 2;
  function groupCenterX(){ return (inputX()+outputX())/2; }
  function switchX(){ return groupCenterX() - GROUP_HALF_GAP; } // was the power block's position
  function powerX(){ return groupCenterX() + GROUP_HALF_GAP; }  // was the switch cluster's position
  function powerMinusX(){ return powerX() - HOLE_PITCH/2; }
  function powerPlusX(){ return powerX() + HOLE_PITCH/2; }

  function drawStrip(w,h){
    ctx.save();

    const grad = ctx.createLinearGradient(0,0,0,h);
    grad.addColorStop(0,'#E4DED6'); grad.addColorStop(1,'#D9D2C8');
    ctx.fillStyle=grad;
    roundRectTop(0,0,w,h+OVERLAP,10);
    ctx.fill();
    ctx.strokeStyle='rgba(0,0,0,0.12)'; ctx.lineWidth=1; ctx.stroke();

    const jackTraceStart  = h/2 + 22; // just below the jack's hex nut
    const powerTraceStart = h/2 + 24; // just below the power block
    drawTrace(inputX(), jackTraceStart, inputX(), h);
    drawTrace(outputX(), jackTraceStart, outputX(), h);
    drawTrace(powerMinusX(), powerTraceStart, powerMinusX(), h, 'rgba(43,87,154,0.45)');
    drawTrace(powerPlusX(),  powerTraceStart, powerPlusX(),  h, 'rgba(176,32,46,0.45)');

    drawLogo(48, h/2);
    drawJack(inputX(), h/2, 'IN');
    drawPowerBlock(powerX(), h/2);
    drawSwitchCluster(switchX(), h/2);
    drawJack(outputX(), h/2, 'OUT');
    drawHoverHighlight(h);

    ctx.restore();
  }

  // Reuses hitTest's own regions as the highlight bounds, so hover feedback
  // can never drift out of sync with what's actually clickable.
  function drawHoverHighlight(h) {
    if (!_hoverTarget) return;
    const cy = h/2;
    let cx, rx, ry;
    if (_hoverTarget === 'switch')      { cx = switchX()+80; rx = 48; ry = 23; }
    else if (_hoverTarget === 'power')  { cx = powerX();     rx = 22; ry = 24; }
    else if (_hoverTarget === 'input')  { cx = inputX();     rx = 22; ry = 24; }
    else if (_hoverTarget === 'output') { cx = outputX();    rx = 22; ry = 24; }
    else return;

    ctx.save();
    ctx.globalCompositeOperation = 'lighten';
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(rx, ry) * 1.15);
    g.addColorStop(0, 'rgba(255,255,255,0.30)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx * 1.15, ry * 1.15, 0, 0, Math.PI*2);
    ctx.fill();
    ctx.restore();
  }

function drawLogo(cx, cy) {
  const size = 42; // Size of logo in px
  if (logoReady) {
    ctx.save();
    
    // Set shadow properties for a soft drop shadow
    ctx.shadowColor = 'rgba(0, 0, 0, 0.3)';
    ctx.shadowBlur = 8;
    ctx.shadowOffsetY = 4;
    
    ctx.drawImage(logoImg, cx - size / 2, cy - size / 2, size, size);
    ctx.restore();
  } else {
 
    ctx.save();
    ctx.translate(cx, cy);
    ctx.strokeStyle = 'rgba(92, 64, 51, 0.3)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(0, 0, size / 2, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
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

    ctx.font='bold 9px IBM Plex Mono, monospace'; ctx.textAlign='center';
    labelBg(label, 0, hexR+11, ctx.font);
    ctx.fillStyle='rgba(92,64,51,0.8)';
    ctx.fillText(label,0,hexR+14);
    ctx.restore();
  }

  function drawPowerBlock(cx,cy){
    const p = permanentState.power;
    const bw=40,bh=44,hw=bw/2,hh=bh/2;
    ctx.save();ctx.translate(cx,cy);

    const minusFirst = !p.reverse_polarity;
    ctx.fillStyle='rgba(43,87,154,0.85)'; ctx.fillRect(-hw, minusFirst?-hh:0, bw, bh/2);
    ctx.fillStyle='rgba(176,32,46,0.85)'; ctx.fillRect(-hw, minusFirst?0:-hh, bw, bh/2);
    ctx.strokeStyle='rgba(255,255,255,0.25)';ctx.lineWidth=0.8;roundRect(-hw,-hh,bw,bh,3);ctx.stroke();
    ctx.fillStyle='#fff';ctx.font='bold 11px IBM Plex Mono, monospace';ctx.textAlign='center';
    const vLabel = Number.isFinite(p.voltage) ? (Math.round(p.voltage*10)/10)+'V' : '9V';
    ctx.fillText(vLabel,0,4);
    ctx.font='bold 8px monospace';
    ctx.fillStyle='rgba(255,255,255,0.85)';
    ctx.fillText(minusFirst?'–':'+',0,-hh+10);
    ctx.fillText(minusFirst?'+':'–',0,hh-4);
    ctx.globalAlpha = 1;
    ctx.font='bold 9px IBM Plex Mono, monospace'; ctx.textAlign='center';
    labelBg('POWER', 0, hh+13, ctx.font);
    ctx.fillStyle='rgba(92,64,51,0.8)';
    ctx.fillText('POWER', 0, hh+16);
    ctx.restore();
  }
  
function drawSwitchCluster(cx, cy) {
  ctx.save();
  ctx.translate(cx, cy);

  // --- LED and CLR code ---
  const ledX = -80, ledY = -6;
  ctx.save(); ctx.translate(ledX, ledY);
  const hex = '#00FF00';
  if (bypassOn) {
    const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, 14);
    glow.addColorStop(0, hex + 'cc'); glow.addColorStop(1, 'transparent');
    ctx.beginPath(); ctx.arc(0, 0, 14, 0, Math.PI * 2); ctx.fillStyle = glow; ctx.fill();
  }
  ctx.beginPath(); ctx.arc(0, 0, 5, 0, Math.PI * 2);
  ctx.fillStyle = bypassOn ? hex : '#7a3030';
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.4)'; ctx.lineWidth = 0.8; ctx.stroke();
  ctx.restore();

  const clrX = -80, clrY = 18;
  ctx.save(); ctx.translate(clrX, clrY);
  const bw = 28, bh = 12;
  ctx.fillStyle = '#d4b896'; roundRect(-bw / 2, -bh / 2, bw, bh, 3); ctx.fill();
  ctx.strokeStyle = '#b09070'; ctx.lineWidth = 0.5; ctx.stroke();
  ['#8B4513', '#000', '#f00', '#c8a000'].forEach((col, i) => { ctx.fillStyle = col; ctx.fillRect(-bw / 2 + 6 + i * 6, -(bh - 2) / 2, 4, bh - 2); });
  ctx.restore();
ctx.font = 'bold 8px IBM Plex Mono, monospace';
ctx.textAlign = 'left';
labelBg('CLR', clrX + bw/2 + 6 + 8, clrY + 2, ctx.font);
ctx.fillStyle = 'rgba(92,64,51,0.8)';
ctx.fillText('CLR', clrX + bw/2 + 6, clrY + 3);

  const swX = 80;
  ctx.save(); ctx.translate(swX, 0);
  const bzW = 96, bzH = 45;
  const gBz = ctx.createLinearGradient(0, -bzH / 2, 0, bzH / 2);
  gBz.addColorStop(0, '#9a9aa2'); gBz.addColorStop(1, '#6a6a72');
  roundRect(-bzW / 2, -bzH / 2, bzW, bzH, 9); ctx.fillStyle = gBz; ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = 1; ctx.stroke();

  const rW = 84, rH = 30, half = rW / 2;
  roundRect(-half, -rH / 2, rW, rH, 6); 
  ctx.save(); 
  ctx.clip();

function fillHalf(active, left) {
  ctx.save();
  
  // Create a clipping region for this half
  if (left) {
    ctx.beginPath();
    ctx.rect(-half, -rH / 2, half, rH);
  } else {
    ctx.beginPath();
    ctx.rect(0, -rH / 2, half, rH);
  }
  ctx.clip();
  
  if (active) {
    // Active side: dark at center, light at outer edge
    const grad = ctx.createLinearGradient(-half, 0, half, 0);
    if (left) {
      // Left half: dark at right (center), light at left (outer)
      grad.addColorStop(0.5, '#3d3d3d');
      grad.addColorStop(0.02, '#4a4a4a');
      grad.addColorStop(0, '#606060');
    } else {
      // Right half: dark at left (center), light at right (outer)
      grad.addColorStop(0.5, '#3d3d3d');
      grad.addColorStop(0.98, '#4a4a4a');
      grad.addColorStop(1, '#606060');
    }
    ctx.fillStyle = grad;
  } else {
    // Inactive side: light at outer edge, dark at center
    const grad = ctx.createLinearGradient(-half, 0, half, 0);
    if (left) {
      // Left half: dark at center, abruptly transitions to gray then white edge
      grad.addColorStop(0.5, '#4a4a4a');
      grad.addColorStop(0.03, '#909090');
      grad.addColorStop(0.005, '#ffffff');
    } else {
      // Right half: dark at center, abruptly transitions to gray then white edge
      grad.addColorStop(0.5, '#4a4a4a');
      grad.addColorStop(0.97, '#909090');
      grad.addColorStop(0.995, '#ffffff');
    }
    ctx.fillStyle = grad;
  }
  
  // Fill the appropriate half
  if (left) {
    ctx.fillRect(-half, -rH / 2, half, rH);
  } else {
    ctx.fillRect(0, -rH / 2, half, rH);
  }
  
  ctx.restore();
}

  fillHalf(!bypassOn, true);
  fillHalf(bypassOn, false);

  ctx.restore();

  // Divider line
  ctx.strokeStyle = 'rgba(0,0,0,0.3)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, -rH / 2); ctx.lineTo(0, rH / 2); ctx.stroke();

  // Outer border
  ctx.strokeStyle = 'rgba(0,0,0,0.4)'; ctx.lineWidth = 1; roundRect(-half, -rH / 2, rW, rH, 4); ctx.stroke();
  ctx.restore();

  // Labels — back below the switch (moving them above wasn't reading well)
  const labelY = bzH / 2 + 14;
  ctx.font = 'bold 8px IBM Plex Mono, monospace';
  ctx.textAlign = 'center';
  labelBg('BYPASS', swX - 32, labelY - 3, ctx.font);
  labelBg('ENGAGE', swX + 32, labelY - 3, ctx.font);
  ctx.fillStyle = 'rgba(92,64,51,0.8)';
  ctx.fillText('BYPASS', swX - 32, labelY);
  ctx.fillText('ENGAGE', swX + 32, labelY);
  ctx.strokeStyle = 'rgba(92,64,51,0.5)'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(swX, labelY - 9); ctx.lineTo(swX, labelY + 3); ctx.stroke();

  ctx.restore();
}

  // Shared by onClick and onMouseMove so the clickable area and the
  // pointer-cursor area can never drift apart from each other.
  function hitTest(x, y) {
    const cy = STRIP_H/2;
    const swX = switchX()+80;
    if (Math.abs(x-swX) < 48 && Math.abs(y-cy) < 23) return 'switch';
    if (Math.abs(x-powerX())  < 22 && Math.abs(y-cy) < 24) return 'power';
    if (Math.abs(x-inputX())  < 22 && Math.abs(y-cy) < 24) return 'input';
    if (Math.abs(x-outputX()) < 22 && Math.abs(y-cy) < 24) return 'output';
    return null;
  }

  function eventToCanvasXY(e) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (e.clientX-rect.left)*(canvas.width/rect.width)/_dpr,
      y: (e.clientY-rect.top)*(canvas.height/rect.height)/_dpr,
    };
  }

  function onClick(e){
    const {x,y} = eventToCanvasXY(e);
    const hit = hitTest(x,y);

    if (hit === 'switch') {
      bypassOn = !bypassOn; render();
      if (typeof Simulation !== 'undefined' && Simulation.isRunning() && typeof AudioEngine !== 'undefined') {
        AudioEngine.stop(); AudioEngine.start();
      }
      return;
    }
    // Power supply, Input, and Output open their properties — same pattern
    // as clicking a placed component. LED/CLR aren't included: per the doc
    // they're permanent visual indicators only, not editable.
    if (hit === 'power' || hit === 'input' || hit === 'output') { _onSelectPermanent?.(hit); return; }
  }

  function onMouseMove(e){
    const {x,y} = eventToCanvasXY(e);
    const hit = hitTest(x,y);
    canvas.style.cursor = hit ? 'pointer' : 'default';
    if (hit !== _hoverTarget) { _hoverTarget = hit; render(); }
  }

  function onMouseLeave(){
    if (_hoverTarget) { _hoverTarget = null; render(); }
    canvas.style.cursor = 'default';
  }

  return {
    init, render, getVisualHeight,
    getConnectionPoints: () => ({
      inputX: inputX(), outputX: outputX(),
      powerMinusX: powerMinusX(), powerPlusX: powerPlusX(),
      inputCol: 55, outputCol: 6, powerMinusCol: 18, powerPlusCol: 19,
      // Row index 5 (label 'f') is the row actually adjacent to the top
      // rail — board.js's row-index-to-y mapping is not straightforwardly
      // top-to-bottom (row index 0, label 'a', is near the BOTTOM rail).
      // Verified against board.js's own buildLayout() math.
      firstRow: 5,
    }),
    getPermanentState, setPermanentState, onSelectPermanent,
    isBypassOn: () => bypassOn,
  };
})();