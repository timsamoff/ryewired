// ── Workbench Strip ───────────────────────────────────────────────────────────
// Permanent hardware strip: logo, input/output jacks, power supply, and the
// bypass switch + status LED/CLR. Renders on its own canvas, stacked directly
// above the (unmodified) board canvas, sized to match its width exactly via
// Board.getBoardWidth() so the two always stay proportional to each other.
//
// Phase 1 of the "future workbench" architecture: the Power Supply, Input,
// and Output devices now have real, editable, persisted state — clicking one
// opens it in the Properties panel, same as any placed component. None of
// this is wired into the net/simulation graph yet (that's Phase 2+); this is
// purely the data model and UI groundwork everything else builds on.

const WorkbenchStrip = (() => {
  let canvas, ctx, _dpr = 1;

  const HOLE_PITCH = 20;
  const STRIP_H = 96;
  const OVERLAP = 16;
  const BYPASS_ON_DEFAULT = false;

  let bypassOn = BYPASS_ON_DEFAULT;
  let logoImg = null, logoReady = false;

  // Defaults mirror the property list in the "Future Workbench Architecture"
  // doc for each device. Anything explicitly marked "(future)" there
  // (max current/current limiting, battery health, Output Device, Record
  // Audio, Live Audio Input) is intentionally left out for now.
  const DEFAULT_PERMANENT_STATE = {
    power:  { voltage: 9, reverse_polarity: false, power_on: true, battery_sag: 0, internal_resistance: 1 },
    input:  { waveform: 'Sine', frequency: 440, amplitude: 1.0, dc_offset: 0, phase: 0, looping: true, audio_file: null },
    output: { volume: 1.0, mute: false },
  };
  let permanentState = cloneState(DEFAULT_PERMANENT_STATE);
  function cloneState(s) { return JSON.parse(JSON.stringify(s)); }

  function getPermanentState() { return permanentState; }
  // Merges saved state over defaults, key by key, so older save files (or a
  // missing/partial permanentDevices block) still load fine with sensible
  // defaults for anything they don't have.
  function setPermanentState(saved) {
    permanentState = {
      power:  Object.assign(cloneState(DEFAULT_PERMANENT_STATE).power,  saved?.power  || {}),
      input:  Object.assign(cloneState(DEFAULT_PERMANENT_STATE).input,  saved?.input  || {}),
      output: Object.assign(cloneState(DEFAULT_PERMANENT_STATE).output, saved?.output || {}),
    };
    render();
  }

  let _onSelectPermanent = null;
  function onSelectPermanent(fn) { _onSelectPermanent = fn; }

  function cv(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

  function init(canvasEl) {
    canvas = canvasEl;
    ctx = canvas.getContext('2d');
    canvas.addEventListener('click', onClick);
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

  function inputX(){ return colX(6, 0.10); }
  function outputX(){ return colX(55, 0.90); }
  function powerMinusX(){ return colX(18, 0.29); }
  function powerPlusX(){ return colX(19, 0.31); }
  function powerX(){ return (powerMinusX()+powerPlusX())/2; }
  function switchX(){ return (powerX()+outputX())/2; }

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
    if (!p.power_on) ctx.globalAlpha = 0.45; // visually dimmed while off
    // reverse_polarity swaps which half is drawn – / + (matches the doc's
    // "expose reverse polarity" property; purely visual for now — Phase 2
    // is what actually feeds this into the top rail's net voltages).
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

  function onClick(e){
    const rect=canvas.getBoundingClientRect();
    const x=(e.clientX-rect.left)*(canvas.width/rect.width)/_dpr;
    const y=(e.clientY-rect.top)*(canvas.height/rect.height)/_dpr;
    const cy = STRIP_H/2;

    // Bypass toggle (direct action, not a Properties-panel target)
    const swX = switchX()+80;
    if (Math.abs(x-swX) < 48 && Math.abs(y-cy) < 23) { bypassOn = !bypassOn; render(); return; }

    // Power supply, Input, and Output open their properties — same pattern
    // as clicking a placed component. LED/CLR aren't included: per the doc
    // they're permanent visual indicators only, not editable.
    if (Math.abs(x-powerX()) < 22 && Math.abs(y-cy) < 24) { _onSelectPermanent?.('power'); return; }
    if (Math.abs(x-inputX()) < 22 && Math.abs(y-cy) < 24) { _onSelectPermanent?.('input'); return; }
    if (Math.abs(x-outputX()) < 22 && Math.abs(y-cy) < 24) { _onSelectPermanent?.('output'); return; }
  }

  return {
    init, render, getVisualHeight,
    getConnectionPoints: () => ({
      inputX: inputX(), outputX: outputX(),
      powerMinusX: powerMinusX(), powerPlusX: powerPlusX(),
      inputCol: 6, outputCol: 55, powerMinusCol: 18, powerPlusCol: 19
    }),
    getPermanentState, setPermanentState, onSelectPermanent,
  };
})();