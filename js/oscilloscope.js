// ── Oscilloscope + Spectrum Analyzer ─────────────────────────────────────────

const Oscilloscope = (() => {
  let _scopeCanvas, _scopeCtx;
  let _specCanvas,  _specCtx;
  let _animFrame = null;
  let _running   = false;

  function cv(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function init(scopeEl, specEl) {
    _scopeCanvas = scopeEl;
    _scopeCtx    = scopeEl.getContext('2d');
    _specCanvas  = specEl;
    _specCtx     = specEl.getContext('2d');
  }

  function start() { _running = true; loop(); }

  function stop() {
    _running = false;
    if (_animFrame) { cancelAnimationFrame(_animFrame); _animFrame = null; }
    drawFlatline();
  }

  function loop() {
    if (!_running) return;
    drawScope();
    drawSpectrum();
    _animFrame = requestAnimationFrame(loop);
  }

  // ── Oscilloscope ────────────────────────────────────────────────────────────

  function drawScope() {
    const canvas = _scopeCanvas, ctx = _scopeCtx;
    const W = canvas.parentElement?.clientWidth  || canvas.clientWidth  || 600;
    const H = canvas.parentElement?.clientHeight || canvas.clientHeight || 130;
    if (!W || !H) return;
    canvas.width = W; canvas.height = H;

    const scopeBg    = cv('--scope-bg');
    const scopeGrid  = cv('--scope-grid');
    const scopeTrace = cv('--scope-trace');
    const gridCenter = cv('--scope-grid-center');

    ctx.fillStyle = scopeBg;
    ctx.fillRect(0, 0, W, H);
    drawGrid(ctx, W, H, scopeGrid, gridCenter);

    const analyser = AudioEngine.getAnalyser();
    if (!analyser) return;

    const buf = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(buf);

    // Find trigger (zero crossing, positive slope)
    let trigIdx = 0;
    for (let i = 1; i < buf.length - W; i++) {
      if (buf[i-1] < 0 && buf[i] >= 0) { trigIdx = i; break; }
    }

    const vdiv  = parseFloat(document.getElementById('scope-vdiv')?.value || 1);
    const scale = (H / 2) / (vdiv * 5);

    ctx.beginPath();
    ctx.strokeStyle = scopeTrace;
    ctx.lineWidth   = 1.5;
    ctx.shadowColor = scopeTrace;
    ctx.shadowBlur  = 4;

    for (let i = 0; i < W; i++) {
      const s = buf[trigIdx + i] || 0;
      const y = H / 2 - s * scale * 80;
      i === 0 ? ctx.moveTo(i, y) : ctx.lineTo(i, y);
    }
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Voltage label
    ctx.fillStyle = scopeTrace;
    ctx.font      = '9px IBM Plex Mono, monospace';
    ctx.textAlign = 'left';
    ctx.globalAlpha = 0.6;
    ctx.fillText(`${vdiv}V/div`, 6, 12);
    ctx.globalAlpha = 1;
  }

  // ── Spectrum analyzer ───────────────────────────────────────────────────────

  function drawSpectrum() {
    const canvas = _specCanvas, ctx = _specCtx;
    const W = canvas.parentElement?.clientWidth  || canvas.clientWidth  || 600;
    const H = canvas.parentElement?.clientHeight || canvas.clientHeight || 110;
    if (!W || !H) return;
    canvas.width = W; canvas.height = H;

    const scopeBg    = cv('--scope-bg');
    const scopeGrid  = cv('--scope-grid');
    const gridCenter = cv('--scope-grid-center');
    const scopeTrace = cv('--scope-trace');

    ctx.fillStyle = scopeBg;
    ctx.fillRect(0, 0, W, H);
    drawGrid(ctx, W, H, scopeGrid, gridCenter);

    const analyser = AudioEngine.getSpectrumAnalyser();
    if (!analyser) return;

    const buf  = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(buf);
    const step = Math.floor(buf.length / W);

    for (let i = 0; i < W; i++) {
      const val  = buf[i * step] / 255;
      const barH = val * (H - 2);
      const hue  = Utils.mapRange(i / W, 0, 1, 200, 80); // blue→green→yellow
      ctx.fillStyle = `hsl(${hue}, 75%, ${40 + val * 25}%)`;
      ctx.fillRect(i, H - barH, 1, barH);
    }

    // Frequency labels
    const freqLabels = [
      { label: '20Hz',  x: 0.01 },
      { label: '100Hz', x: 0.08 },
      { label: '1kHz',  x: 0.35 },
      { label: '5kHz',  x: 0.65 },
      { label: '10kHz', x: 0.80 },
      { label: '20kHz', x: 0.99 },
    ];
    ctx.font      = '8px IBM Plex Mono, monospace';
    ctx.fillStyle = scopeTrace;
    ctx.globalAlpha = 0.45;
    freqLabels.forEach(({ label, x }) => {
      ctx.textAlign = x < 0.1 ? 'left' : x > 0.9 ? 'right' : 'center';
      ctx.fillText(label, x * W, H - 3);
    });
    ctx.globalAlpha = 1;
  }

  // ── Shared grid ─────────────────────────────────────────────────────────────

  function drawGrid(ctx, W, H, gridColor, centerColor) {
    const cols = 10, rows = 8;
    ctx.lineWidth   = 0.5;
    ctx.strokeStyle = gridColor;
    for (let i = 0; i <= cols; i++) {
      const x = (i / cols) * W;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    }
    for (let i = 0; i <= rows; i++) {
      const y = (i / rows) * H;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }
    // Brighter center lines
    ctx.strokeStyle = centerColor;
    ctx.lineWidth   = 1;
    ctx.beginPath(); ctx.moveTo(W/2, 0); ctx.lineTo(W/2, H); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, H/2); ctx.lineTo(W, H/2); ctx.stroke();
  }

  // ── Flatline (stopped state) ────────────────────────────────────────────────

  function drawFlatline() {
    for (const [canvas, ctx] of [[_scopeCanvas, _scopeCtx], [_specCanvas, _specCtx]]) {
      if (!canvas || !ctx) continue;
      const W = canvas.parentElement?.clientWidth  || 600;
      const H = canvas.parentElement?.clientHeight || 130;
      if (!W || !H) continue;
      canvas.width = W; canvas.height = H;

      const scopeBg    = cv('--scope-bg');
      const scopeGrid  = cv('--scope-grid');
      const scopeTrace = cv('--scope-trace');
      const gridCenter = cv('--scope-grid-center');

      ctx.fillStyle = scopeBg;
      ctx.fillRect(0, 0, W, H);
      drawGrid(ctx, W, H, scopeGrid, gridCenter);

      ctx.strokeStyle = scopeTrace;
      ctx.lineWidth   = 1;
      ctx.globalAlpha = 0.25;
      ctx.beginPath();
      ctx.moveTo(0, H / 2);
      ctx.lineTo(W, H / 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  return { init, start, stop };
})();
