// ── Audio Engine ──────────────────────────────────────────────────────────────

const AudioEngine = (() => {
  let _ctx              = null;
  let _source           = null;
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

  function start() {
    const placed = Board.getPlaced();
    const sigGen = placed.find(p => p.defId === 'signal_generator');
    try {
      const ctx = getContext();
      if (ctx.state === 'suspended') ctx.resume();

      _gainOut = ctx.createGain();
      _gainOut.gain.value = 0.7;

      _analyser = ctx.createAnalyser();
      _analyser.fftSize = 2048;

      _analyserSpectrum = ctx.createAnalyser();
      _analyserSpectrum.fftSize = 2048;

      _source = buildSource(ctx, sigGen);
      _chain  = buildChain(ctx, placed);

      let node = _source;
      for (const n of _chain) { node.connect(n); node = n; }
      node.connect(_analyser);
      node.connect(_analyserSpectrum);
      _analyser.connect(_gainOut);
      _gainOut.connect(ctx.destination);

      if (_source.start) _source.start();
      _running = true;
    } catch (err) {
      console.error('[Audio] Start error:', err);
    }
  }

  function stop() {
    try {
      if (_source) { if (_source.stop) _source.stop(); _source.disconnect(); _source = null; }
      for (const n of _chain) { try { n.disconnect(); } catch(e){} }
      _chain = [];
      if (_analyser)         { _analyser.disconnect(); _analyser = null; }
      if (_analyserSpectrum) { _analyserSpectrum.disconnect(); _analyserSpectrum = null; }
      if (_gainOut)          { _gainOut.disconnect(); _gainOut = null; }
    } catch (err) { console.warn('[Audio] Stop error:', err); }
    _running = false;
  }

  function buildSource(ctx, sigGen) {
    if (!sigGen) {
      const osc = ctx.createOscillator();
      osc.frequency.value = 440;
      const g = ctx.createGain(); g.gain.value = 0;
      osc.connect(g); return g;
    }

    const waveform = sigGen.props.waveform || 'Sine';
    const freq     = parseFloat(sigGen.props.frequency) || 440;
    const amp      = parseFloat(sigGen.props.amplitude) || 1.0;

    if (waveform === 'Audio File' && _audioBuffer) {
      const src = ctx.createBufferSource();
      src.buffer = _audioBuffer; src.loop = true;
      const g = ctx.createGain(); g.gain.value = amp * 0.5;
      src.connect(g); return g;
    }

    if (waveform === 'White Noise' || waveform === 'Pink Noise') {
      return buildNoiseSource(ctx, waveform, amp);
    }

    const osc  = ctx.createOscillator();
    const map  = { 'Sine':'sine','Square':'square','Sawtooth':'sawtooth','Triangle':'triangle' };
    osc.type   = map[waveform] || 'sine';
    osc.frequency.value = freq;
    const g    = ctx.createGain(); g.gain.value = amp * 0.5;
    osc.connect(g); return g;
  }

  function buildNoiseSource(ctx, type, amp) {
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
    src.buffer = buf; src.loop = true;
    const g = ctx.createGain(); g.gain.value = amp * 0.5;
    src.connect(g); return g;
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

  return {
    start, stop, loadAudioFile,
    getAnalyser, getSpectrumAnalyser,
    isRunning, getAudioFileName, updatePotWiper
  };
})();
