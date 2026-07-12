// ── Trace Overlay ─────────────────────────────────────────────────────────────

const TraceOverlay = (() => {
  let canvas, ctx, _dpr = 1;

  const FIRST_ROW = 5;

  function init(canvasEl) {
    canvas = canvasEl;
    render();
  }

  function stripH() {
    return (typeof WorkbenchStrip !== 'undefined' && WorkbenchStrip.getVisualHeight) ? WorkbenchStrip.getVisualHeight() : 96;
  }
  function boardWidth() {
    return (typeof Board !== 'undefined' && Board.getBoardWidth) ? Board.getBoardWidth() : 800;
  }
  function points() {
    return (typeof WorkbenchStrip !== 'undefined' && WorkbenchStrip.getConnectionPoints)
      ? WorkbenchStrip.getConnectionPoints()
      : null;
  }

  function overlayHeight() {
    if (typeof Board === 'undefined' || !Board.holeToXY) return stripH() + 60;
    const firstRowY = Board.holeToXY(FIRST_ROW, 0).y;
    return stripH() + firstRowY + 12;
  }

  function render() {
    const pts = points();
    if (!canvas || !pts || typeof Board === 'undefined' || !Board.holeToXY) { requestAnimationFrame(render); return; }

    _dpr = window.devicePixelRatio || 1;
    const W = boardWidth(), H = overlayHeight(), sH = stripH();
    canvas.width = Math.round(W*_dpr); canvas.height = Math.round(H*_dpr);
    canvas.style.width = W+'px'; canvas.style.height = H+'px';
    ctx = canvas.getContext('2d');
    ctx.setTransform(_dpr,0,0,_dpr,0,0);
    ctx.clearRect(0,0,W,H);

    const inHole  = Board.holeToXY(FIRST_ROW, pts.inputCol);
    const outHole = Board.holeToXY(FIRST_ROW, pts.outputCol);
    drawBridge(pts.inputX,  sH, pts.inputX,  sH+inHole.y);
    drawBridge(pts.outputX, sH, pts.outputX, sH+outHole.y);

    // Power lands on the top rail's actual – and + rows.
    // When reverse polarity is on, the block's minus-side terminal is now
    // sourcing the rail's + row and vice versa — so the traces need to swap
    // which rail row they land on, matching drawPowerBlock's own top/bottom
    // swap in workbench-strip.js.
    const reversed = (typeof WorkbenchStrip !== 'undefined' && WorkbenchStrip.getPermanentState)
      ? !!WorkbenchStrip.getPermanentState().power.reverse_polarity : false;
    const minusHole = Board.holeToXY(reversed ? 'rtp' : 'rtm', pts.powerMinusCol);
    const plusHole  = Board.holeToXY(reversed ? 'rtm' : 'rtp', pts.powerPlusCol);
    drawBridge(pts.powerMinusX, sH, pts.powerMinusX, sH+minusHole.y, 'rgba(43,87,154,0.45)');
    drawBridge(pts.powerPlusX,  sH, pts.powerPlusX,  sH+plusHole.y,  'rgba(176,32,46,0.45)');
  }

  function drawBridge(x1,y1,x2,y2,tint){
    ctx.strokeStyle=tint||'rgba(90,70,55,0.35)'; ctx.lineWidth=3;
    ctx.beginPath();ctx.moveTo(x1,y1);ctx.lineTo(x2,y2);ctx.stroke();
    ctx.strokeStyle='rgba(255,255,255,0.15)'; ctx.lineWidth=1;
    ctx.beginPath();ctx.moveTo(x1,y1);ctx.lineTo(x2,y2);ctx.stroke();
  }

  return { init, render };
})();