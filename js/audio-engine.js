// ── Audio Engine ──────────────────────────────────────────────────────────────
// Reads the permanent Input/Output device state (WorkbenchStrip) rather than
// a placed 'signal_generator' component — that component is retired in favor
// of the permanent Input, per the "Future Workbench Architecture" doc.
// Audio routing (bypass) is intentionally kept separate from electrical
// simulation: bypass only changes what buildChain() is asked to do here, it
// never touches Simulation.

const AudioEngine = (() => {
  let _ctx              = null;
  let _source           = null;   // node the rest of the graph connects FROM
  let _sourceStartable  = null;   // the actual OscillatorNode/BufferSource/ConstantSource(s) needing .start()
  let _chain            = [];
  let _analyser         = null;
  let _analyserSpectrum = null;
  let _gainOut          = null;
  let _running          = false;
  let _audioBuffer      = null;
  let _audioFileName    = null;

  function getContext() {
    if (!_ctx) {
      _ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 44100 });
    }
    return _ctx;
  }

  function inputState()  { return (typeof WorkbenchStrip !== 'undefined') ? WorkbenchStrip.getPermanentState().input  : {}; }
  function outputState() { return (typeof WorkbenchStrip !== 'undefined') ? WorkbenchStrip.getPermanentState().output : {}; }
  function bypassOn()    { return (typeof WorkbenchStrip !== 'undefined' && WorkbenchStrip.isBypassOn) ? WorkbenchStrip.isBypassOn() : false; }

  function start() {
    const placed = Board.getPlaced();
    try {
      const ctx = getContext();
      if (ctx.state === 'suspended') ctx.resume();

      const out = outputState();
      _gainOut = ctx.createGain();
      _gainOut.gain.value = out.mute ? 0 : Utils.clamp(out.volume ?? 0.7, 0, 1);

      _analyser = ctx.createAnalyser();
      // Sized to comfortably hold the full time window the scope can ever
      // request: 50ms/div (its slider max) × 10 divisions = 500ms, which at
      // 44100Hz is ~22k samples — 32768 (the API's max fftSize) covers that
      // with room to spare. The old 2048 (~46ms) couldn't support the ms/div
      // control at all past its lowest couple of settings.
      _analyser.fftSize = 32768;

      _analyserSpectrum = ctx.createAnalyser();
      _analyserSpectrum.fftSize = 2048;

      const built = buildSource(ctx, inputState());
      _source = built.output;
      _sourceStartable = built.startable;

      // Bypass OFF: Input -> Output directly (clean signal, no user circuit).
      // Bypass ON:  Input -> user circuit -> Output. This is audio routing
      // only — the electrical simulation (js/simulation.js) always runs the
      // full circuit regardless, per the doc.
      // Bypass ON needs an actual Input->Output path to pass anything —
      // matching a real pedal: engaging bypass with an open/incomplete
      // circuit gets you silence, not whatever components happen to be
      // sitting on the board. Reuses the real net graph (via Simulation),
      // not just "are there placed components" like buildChain alone would
      // imply.
      const wantsChain = bypassOn();
      let hasPath = true;
      if (wantsChain) {
        const cp = (typeof WorkbenchStrip !== 'undefined') ? WorkbenchStrip.getConnectionPoints() : null;
        hasPath = (cp && typeof Simulation !== 'undefined' && Simulation.hasElectricalPath)
          ? Simulation.hasElectricalPath(cp.firstRow, cp.inputCol, cp.firstRow, cp.outputCol)
          : true; // fail open if the check itself isn't available, rather than going silently mute
      }

      _chain = (wantsChain && hasPath) ? buildChain(ctx, placed) : [];

      if (wantsChain && !hasPath) {
        // Engaged but no complete path: leave the source disconnected from
        // everything downstream. Analysers stay connected but see nothing,
        // so the scope/spectrum correctly flatline too — same as probing
        // past a real open circuit.
      } else {
        let node = _source;
        for (const n of _chain) { node.connect(n); node = n; }
        node.connect(_analyser);
        node.connect(_analyserSpectrum);
      }
      _analyser.connect(_gainOut);
      _gainOut.connect(ctx.destination);

      for (const s of _sourceStartable) { if (s.start) s.start(s._startAt || 0); }
      _running = true;
    } catch (err) {
      console.error('[Audio] Start error:', err);
    }
  }

  function stop() {
    try {
      if (_sourceStartable) {
        for (const s of _sourceStartable) { try { if (s.stop) s.stop(); s.disconnect(); } catch(e){} }
      }
      _sourceStartable = null;
      if (_source) { _source.disconnect(); _source = null; }
      for (const n of _chain) { try { n.disconnect(); } catch(e){} }
      _chain = [];
      if (_analyser)         { _analyser.disconnect(); _analyser = null; }
      if (_analyserSpectrum) { _analyserSpectrum.disconnect(); _analyserSpectrum = null; }
      if (_gainOut)          { _gainOut.disconnect(); _gainOut = null; }
    } catch (err) { console.warn('[Audio] Stop error:', err); }
    _running = false;
  }

  // Live-updates Output's volume/mute while running, without rebuilding the
  // graph — called from properties-panel.js when those specific props change.
  function setOutputGain(volume, mute) {
    if (!_gainOut || !_ctx) return;
    const target = mute ? 0 : Utils.clamp(volume ?? 0.7, 0, 1);
    _gainOut.gain.setTargetAtTime(target, _ctx.currentTime, 0.01);
  }

  // Returns { startable: [...nodes needing .start()], output: nodeToConnectFrom }
  function buildSource(ctx, input) {
    const waveform = input.waveform || 'Sine';
    const freq     = parseFloat(input.frequency) || 440;
    const amp      = input.amplitude !== undefined && input.amplitude !== '' ? parseFloat(input.amplitude) : 1.0;
    const dcOffset = parseFloat(input.dc_offset) || 0;
    const loop     = input.looping !== false;

    let startable = [], wave;

    if (waveform === 'Audio File' && _audioBuffer) {
      const src = ctx.createBufferSource();
      src.buffer = _audioBuffer; src.loop = loop;
      const g = ctx.createGain(); g.gain.value = amp * 0.5;
      src.connect(g);
      startable.push(src); wave = g;
    } else if (waveform === 'White Noise' || waveform === 'Pink Noise') {
      const built = buildNoiseSource(ctx, waveform, amp, loop);
      startable = built.startable; wave = built.output;
    } else {
      const osc  = ctx.createOscillator();
      const map  = { 'Sine':'sine','Square':'square','Sawtooth':'sawtooth','Triangle':'triangle' };
      osc.type   = map[waveform] || 'sine';
      osc.frequency.value = freq;
      const g    = ctx.createGain(); g.gain.value = amp * 0.5;
      osc.connect(g);
      // Phase isn't a directly automatable AudioParam on OscillatorNode, so
      // it's approximated as a start-time delay — equivalent to a phase
      // shift once the periodic waveform is running.
      const phaseDeg   = parseFloat(input.phase) || 0;
      const phaseDelay = freq > 0 ? ((((phaseDeg % 360) + 360) % 360) / 360) * (1 / freq) : 0;
      osc._startAt = ctx.currentTime + phaseDelay;
      startable.push(osc); wave = g;
    }

    let output = wave;
    if (dcOffset) {
      const dc = ctx.createConstantSource();
      dc.offset.value = dcOffset;
      const sum = ctx.createGain(); // plain summing node
      wave.connect(sum); dc.connect(sum);
      startable.push(dc);
      output = sum;
    }

    return { startable, output };
  }

  function buildNoiseSource(ctx, type, amp, loop) {
    const sz  = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, sz, ctx.sampleRate);
    const d   = buf.getChannelData(0);
    if (type === 'White Noise') {
      for (let i = 0; i < sz; i++) d[i] = Math.random() * 2 - 1;
    } else {
      let b0=0,b1=0,b2=0,b3=0,b4=0,b5=0,b6=0;
      for (let i = 0; i < sz; i++) {
        const w = Math.random()*2-1;
        b0=0.99886*b0+w*0.0555179; b1=0.99332*b1+w*0.0750759;
        b2=0.96900*b2+w*0.1538520; b3=0.86650*b3+w*0.3104856;
        b4=0.55000*b4+w*0.5329522; b5=-0.7616*b5-w*0.0168980;
        d[i]=(b0+b1+b2+b3+b4+b5+b6+w*0.5362)*0.11; b6=w*0.115926;
      }
    }
    const src = ctx.createBufferSource();
    src.buffer = buf; src.loop = loop;
    const g = ctx.createGain(); g.gain.value = amp * 0.5;
    src.connect(g);
    return { startable: [src], output: g };
  }

  function buildChain(ctx, placed) {
    const nodes = [];
    for (const inst of placed) {
      if (inst.failed) continue;
      const def = ComponentRegistry.getById(inst.defId);
      if (!def) continue;
      let node = null;

      switch (def.behavior?.type) {
        case 'resistor': {
          const cap = placed.find(p => p.defId === 'capacitor' && !p.failed);
          if (cap) {
            const R = parseFloat(inst.props.resistance) || 10000;
            const C = parseFloat(cap.props.capacitance) || 0.000001;
            const fc = 1 / (2 * Math.PI * R * C);
            const f  = ctx.createBiquadFilter();
            f.type = 'lowpass'; f.frequency.value = Utils.clamp(fc, 10, 20000); f.Q.value = 0.707;
            node = f;
          }
          break;
        }
        case 'potentiometer': {
          const wiper = parseFloat(inst.props.wiper) || 0.5;
          const pos   = (inst.props.taper||'').includes('Audio') ? Math.pow(wiper,2) : wiper;
          const g     = ctx.createGain(); g.gain.value = pos;
          inst._audioNode = g; node = g;
          break;
        }
        case 'bjt_npn': {
          const mk  = inst.props.model || '2N3904';
          const hfe = parseFloat(inst.props.hfe) || def.model_params?.[mk]?.hfe || 100;
          const g   = ctx.createGain(); g.gain.value = Utils.clamp(hfe / 100, 0.5, 20);
          const sh  = ctx.createWaveShaper(); sh.curve = makeClipCurve(0.8);
          g.connect(sh); node = g;
          break;
        }
        case 'diode': {
          const mk       = inst.props.model || '1N4148';
          const isGerman = def.model_params?.[mk]?.type === 'germanium';
          const sh       = ctx.createWaveShaper(); sh.curve = makeClipCurve(isGerman ? 0.3 : 0.65);
          node = sh;
          break;
        }
        case 'capacitor': {
          const C  = parseFloat(inst.props.capacitance) || 0.000001;
          const fc = 1 / (2 * Math.PI * 10000 * C);
          const f  = ctx.createBiquadFilter();
          f.type = 'highpass'; f.frequency.value = Utils.clamp(fc, 10, 20000);
          node = f;
          break;
        }
        default: break;
      }

      if (node) nodes.push(node);
    }
    return nodes;
  }

  function makeClipCurve(threshold) {
    const n = 256, curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i * 2) / n - 1;
      curve[i] = Math.abs(x) < threshold
        ? x
        : Math.sign(x) * (threshold + (1-threshold) *
            Math.tanh((Math.abs(x)-threshold) / (1-threshold)));
    }
    return curve;
  }

  async function loadAudioFile(fileData) {
    const ctx = getContext();
    try {
      const buffer = await ctx.decodeAudioData(fileData.buffer.slice(0));
      _audioBuffer   = buffer;
      _audioFileName = fileData.name;
      return fileData.name;
    } catch (err) {
      console.error('[Audio] Decode error:', err);
      return null;
    }
  }

  function updatePotWiper(inst) {
    if (!inst._audioNode || !_ctx) return;
    const wiper = parseFloat(inst.props.wiper) || 0.5;
    const pos   = (inst.props.taper||'').includes('Audio') ? Math.pow(wiper,2) : wiper;
    inst._audioNode.gain.setTargetAtTime(pos, _ctx.currentTime, 0.01);
  }

  function getAnalyser()         { return _analyser; }
  function getSpectrumAnalyser() { return _analyserSpectrum; }
  function isRunning()           { return _running; }
  function getAudioFileName()    { return _audioFileName; }
  function getSampleRate()       { return _ctx ? _ctx.sampleRate : 44100; }

  return {
    start, stop, loadAudioFile,
    getAnalyser, getSpectrumAnalyser,
    isRunning, getAudioFileName, updatePotWiper, setOutputGain, getSampleRate
  };
})();