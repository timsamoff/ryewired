// ── Audio Engine ──────────────────────────────────────────────────────────────
// Reads the permanent Input/Output device state (WorkbenchStrip) rather than
// a placed 'signal_generator' component — that component is retired in favor
// of the permanent Input, per the "Future Workbench Architecture" doc.
//
// The audio chain is built by walking the REAL net graph (Simulation.buildNetMap)
// from the Input's net to the Output's net, hopping through whichever
// component actually has a leg on the current net — not by blindly chaining
// every placed component in board order. This is deliberately a single
// primary-path walk (no parallel/branch modeling yet): 3-leg parts pick one
// default signal-carrying leg pair (potentiometer: wiper->ccw leg;
// transistor: collector->emitter), everything else is treated as off the
// traced path.
//
// Each net visited during the walk is recorded in a net->tap map, which is
// what makes Audio Probe possible: probing a hole looks up its net and plays
// whatever's actually there, instead of a fixed chain-order guess.

const AudioEngine = (() => {
  let _ctx              = null;
  let _source           = null;   // node the rest of the graph connects FROM
  let _sourceStartable  = null;   // the actual OscillatorNode/BufferSource/ConstantSource(s) needing .start()
  let _allChainNodes    = [];     // every raw AudioNode created while walking, for disconnect-on-stop
  let _analyser         = null;
  let _analyserSpectrum = null;
  let _gainOut          = null;
  let _running          = false;
  let _audioBuffer      = null;
  let _audioFileName    = null;

  // What's currently feeding the analyser/spectrum (and, through the
  // analyser, the speaker) — the normal chain tail, or (while probing) a
  // probe tap, or null (silence). Only one thing is ever routed at a time.
  let _routedNode = null;
  let _chainTail  = null; // the NORMAL routing target, remembered so probe-off can restore it

  // Net map + net->tap built fresh each start(), used for Audio Probe lookups.
  let _probeNets = null;
  let _netTaps   = null;
  let _probeActive = false;

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
    const wires  = Board.getWires();
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
      _analyser.connect(_gainOut);
      _gainOut.connect(ctx.destination);

      const built = buildSource(ctx, inputState());
      _source = built.output;
      _sourceStartable = built.startable;

      // Walk the real net graph regardless of bypass — Audio Probe needs to
      // be able to bench-probe the circuit even with the footswitch
      // disengaged, same as a real pedal. Bypass only decides what feeds
      // the actual Output below.
      const cp = (typeof WorkbenchStrip !== 'undefined') ? WorkbenchStrip.getConnectionPoints() : null;
      const walk = (cp && typeof Simulation !== 'undefined' && Simulation.buildNetMap)
        ? traceSignalPath(ctx, placed, wires, cp, _source)
        : { nets:null, netTaps:new Map(), reachedOutput:false, tail:null, allNodes:[] };

      _probeNets      = walk.nets;
      _netTaps        = walk.netTaps;
      _allChainNodes  = walk.allNodes;

      // Bypass OFF: Input -> Output directly (clean signal, no user circuit).
      // Bypass ON:  Input -> user circuit -> Output, using the same walk
      // above — reachedOutput means a real, component-mediated path exists
      // (not just "some components happen to be on the board").
      _chainTail = bypassOn() ? (walk.reachedOutput ? walk.tail : null) : _source;

      _routeToOutput(_probeActive ? null : _chainTail);

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
      if (_source) { try { _source.disconnect(); } catch(e){} _source = null; }
      for (const n of _allChainNodes) { try { n.disconnect(); } catch(e){} }
      _allChainNodes = [];
      if (_analyser)         { _analyser.disconnect(); _analyser = null; }
      if (_analyserSpectrum) { _analyserSpectrum.disconnect(); _analyserSpectrum = null; }
      if (_gainOut)          { _gainOut.disconnect(); _gainOut = null; }
    } catch (err) { console.warn('[Audio] Stop error:', err); }
    _running = false;
    _routedNode = null; _chainTail = null; _probeNets = null; _netTaps = null;
  }

  // Live-updates Output's volume/mute while running, without rebuilding the
  // graph — called from properties-panel.js when those specific props change.
  function setOutputGain(volume, mute) {
    if (!_gainOut || !_ctx) return;
    const target = mute ? 0 : Utils.clamp(volume ?? 0.7, 0, 1);
    _gainOut.gain.setTargetAtTime(target, _ctx.currentTime, 0.01);
  }

  // ── Routing ───────────────────────────────────────────────────────────────
  // Only one thing ever feeds the analyser/spectrum/speaker at a time —
  // the normal chain tail, a probe tap, or nothing (silence). Swapping
  // detaches the previous source from just these two destinations, leaving
  // any of its OTHER real connections (e.g. to the next stage in the actual
  // chain) untouched.
  function _routeToOutput(node) {
    if (_routedNode) {
      try { _routedNode.disconnect(_analyser); } catch(e){}
      try { _routedNode.disconnect(_analyserSpectrum); } catch(e){}
    }
    _routedNode = node;
    if (node) { node.connect(_analyser); node.connect(_analyserSpectrum); }
  }

  // ── Audio Probe ──────────────────────────────────────────────────────────
  // While active, the normal Output is muted (nothing routes to the
  // analyser/speaker) and replaced by whatever the cursor is hovering —
  // silence on a hole that isn't part of the traced signal path, the real
  // tap otherwise. Also feeds the scope/spectrum, so probing moves those
  // too, same as touching a real oscilloscope probe to different points.
  function probeEnable() {
    _probeActive = true;
    if (_running) _routeToOutput(null);
  }
  function probeDisable() {
    _probeActive = false;
    if (_running) _routeToOutput(_chainTail);
  }
  function probeHover(row, col) {
    if (!_probeActive || !_running) return;
    _routeToOutput(_tapAt(row, col));
  }
  function probeIsAudible(row, col) {
    return !!_tapAt(row, col);
  }
  function _tapAt(row, col) {
    if (row == null || !_probeNets || !_netTaps) return null;
    const net = _probeNets.find(_probeNets.key(row, col));
    return _netTaps.get(net) || null;
  }

  // Returns { startable: [...nodes needing .start()], output: nodeToConnectFrom }
  function buildSource(ctx, input) {
    const waveform = input.waveform || 'None';
    const freq     = parseFloat(input.frequency) || 440;
    const amp      = input.amplitude !== undefined && input.amplitude !== '' ? parseFloat(input.amplitude) : 1.0;
    const dcOffset = parseFloat(input.dc_offset) || 0;
    const loop     = input.looping !== false;

    let startable = [], wave;

    if (waveform === 'None') {
      ({ startable, output: wave } = buildSilentSource(ctx));
    } else if (waveform === 'Audio File') {
      if (_audioBuffer) {
        const src = ctx.createBufferSource();
        src.buffer = _audioBuffer; src.loop = loop;
        const g = ctx.createGain(); g.gain.value = amp * 0.5;
        src.connect(g);
        startable.push(src); wave = g;
      } else {
        // 'Audio File' selected but nothing actually loaded (e.g. right
        // after reopening a saved project — the file name persists but the
        // decoded buffer doesn't). Previously this fell through to the
        // oscillator branch below, which defaulted to an audible sine wave
        // since 'Audio File' isn't in its waveform map. Should be silent.
        ({ startable, output: wave } = buildSilentSource(ctx));
      }
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

  // Genuine silence: a zero-offset ConstantSourceNode through a zero-gain
  // node. Used for waveform 'None' and as the fallback when 'Audio File' is
  // selected but nothing is actually loaded — both need to produce nothing,
  // not just very quietly play some other default waveform.
  function buildSilentSource(ctx) {
    const src = ctx.createConstantSource();
    src.offset.value = 0;
    const g = ctx.createGain();
    g.gain.value = 0;
    src.connect(g);
    return { startable: [src], output: g };
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

  // ── Real-topology signal walk ───────────────────────────────────────────
  // Walks the net graph from Input's net to Output's net, hopping through
  // whichever placed component actually has a leg on the current net.
  // Single primary path only (see file header) — components not reachable
  // this way just aren't part of the returned taps.
  function traceSignalPath(ctx, placed, wires, cp, source) {
    const nets = Simulation.buildNetMap(placed, wires);
    const inputNet  = nets.find(nets.key(cp.firstRow, cp.inputCol));
    const outputNet = nets.find(nets.key(cp.firstRow, cp.outputCol));

    const netTaps  = new Map();
    const allNodes = [];
    netTaps.set(inputNet, source);

    let currentNet = inputNet, tail = source;
    const used = new Set();
    const MAX_HOPS = 64; // finitely many parts on a board — more hops than that means a wiring loop, not a real path

    for (let hop = 0; hop < MAX_HOPS && currentNet !== outputNet; hop++) {
      const next = findNextHop(placed, nets, currentNet, used);
      if (!next) break; // dead end — primary path doesn't (yet) reach Output
      used.add(next.inst.instanceId);

      const built = buildAudioStage(ctx, next.inst, next.def, nets, placed, next.entryNet, next.exitNet);
      if (built) {
        tail.connect(built.in);
        allNodes.push(built.in); if (built.out !== built.in) allNodes.push(built.out);
        tail = built.out;
      }
      // else: this hop's component contributes no audio shaping (e.g. a
      // resistor with no paired shunt cap) — signal passes through
      // unchanged, `tail` stays what it was.
      netTaps.set(next.exitNet, tail);
      currentNet = next.exitNet;
    }

    return { nets, netTaps, reachedOutput: currentNet === outputNet, tail, allNodes };
  }

  // Finds a not-yet-used component with one leg on `fromNet` and the other
  // on a different net, per its type's canonical signal-leg pair. First
  // match wins — see the "single primary path" note above for why this
  // doesn't try to resolve branches.
  function findNextHop(placed, nets, fromNet, used) {
    for (const inst of placed) {
      if (inst.failed || used.has(inst.instanceId)) continue;
      const def = ComponentRegistry.getById(inst.defId);
      if (!def) continue;
      const pair = signalLegPair(inst, def);
      if (!pair) continue;
      const netA = nets.find(nets.key(pair[0].row, pair[0].col));
      const netB = nets.find(nets.key(pair[1].row, pair[1].col));
      if (netA === fromNet && netB !== fromNet) return { inst, def, entryNet: netA, exitNet: netB };
      if (netB === fromNet && netA !== fromNet) return { inst, def, entryNet: netB, exitNet: netA };
    }
    return null;
  }

  // Which two legs carry the traced signal, per component type. 2-leg parts
  // are unambiguous; 3-leg parts pick one default pair (see file header).
  function signalLegPair(inst, def) {
    switch (def.behavior?.type) {
      case 'resistor': case 'capacitor': case 'diode': case 'led':
        return inst.legs.length >= 2 ? [inst.legs[0], inst.legs[inst.legs.length-1]] : null;
      case 'potentiometer':
        return inst.legs.length >= 3 ? [inst.legs[1], inst.legs[0]] : null; // wiper -> ccw leg
      case 'bjt_npn': case 'bjt_pnp': {
        if (inst.legs.length < 3) return null;
        const eIdx = (inst.props.pinout === 'CBE') ? 2 : 0;
        const cIdx = eIdx === 0 ? 2 : 0;
        return [inst.legs[cIdx], inst.legs[eIdx]]; // collector -> emitter
      }
      default: return null;
    }
  }

  // Builds the actual Web Audio node(s) for one hop. Returns {in, out} —
  // the same node for single-stage parts, different nodes for multi-stage
  // ones (e.g. transistor gain->clip), so the walk can chain the *output*
  // of a multi-stage part forward rather than its input.
  function buildAudioStage(ctx, inst, def, nets, placed, entryNet, exitNet) {
    switch (def.behavior?.type) {
      case 'resistor': {
        // Net-based RC pairing now, not "any capacitor anywhere on the
        // board": a capacitor shunting either of this resistor's own two
        // nets forms a real lowpass; anything else isn't this resistor's
        // partner.
        const cap = placed.find(p => {
          if (p.defId !== 'capacitor' || p.failed || p.legs.length < 2) return false;
          const a = nets.find(nets.key(p.legs[0].row, p.legs[0].col));
          const b = nets.find(nets.key(p.legs[p.legs.length-1].row, p.legs[p.legs.length-1].col));
          return a===entryNet || a===exitNet || b===entryNet || b===exitNet;
        });
        if (!cap) return null; // lone series resistor: no filtering effect, transparent
        const R = parseFloat(inst.props.resistance) || 10000;
        const C = parseFloat(cap.props.capacitance) || 0.000001;
        const fc = 1 / (2 * Math.PI * R * C);
        const f = ctx.createBiquadFilter();
        f.type = 'lowpass'; f.frequency.value = Utils.clamp(fc, 10, 20000); f.Q.value = 0.707;
        return { in: f, out: f };
      }
      case 'potentiometer': {
        const wiper = parseFloat(inst.props.wiper) || 0.5;
        const pos   = (inst.props.taper||'').includes('Audio') ? Math.pow(wiper,2) : wiper;
        const g     = ctx.createGain(); g.gain.value = pos;
        inst._audioNode = g;
        return { in: g, out: g };
      }
      case 'bjt_npn': case 'bjt_pnp': {
        const mk  = inst.props.model || (def.behavior.type === 'bjt_pnp' ? '2N3906' : '2N3904');
        const hfe = parseFloat(inst.props.hfe) || def.model_params?.[mk]?.hfe || 100;
        const g   = ctx.createGain(); g.gain.value = Utils.clamp(hfe / 100, 0.5, 20);
        const sh  = ctx.createWaveShaper(); sh.curve = makeClipCurve(0.8);
        g.connect(sh);
        return { in: g, out: sh };
      }
      case 'diode': {
        const mk       = inst.props.model || '1N4148';
        const isGerman = def.model_params?.[mk]?.type === 'germanium';
        const sh       = ctx.createWaveShaper(); sh.curve = makeClipCurve(isGerman ? 0.3 : 0.65);
        return { in: sh, out: sh };
      }
      case 'capacitor': {
        // A capacitor actually IN the traced series path (as opposed to
        // shunting to ground off a resistor, handled above) is a coupling
        // cap — a standalone highpass, no partner needed.
        const C  = parseFloat(inst.props.capacitance) || 0.000001;
        const fc = 1 / (2 * Math.PI * 10000 * C);
        const f  = ctx.createBiquadFilter();
        f.type = 'highpass'; f.frequency.value = Utils.clamp(fc, 10, 20000);
        return { in: f, out: f };
      }
      default: return null; // e.g. LED — traversable as a hop, but no audio shaping (unchanged from before)
    }
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
    isRunning, getAudioFileName, updatePotWiper, setOutputGain, getSampleRate,
    probeEnable, probeDisable, probeHover, probeIsAudible
  };
})();