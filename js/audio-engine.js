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

  // ── Bundled sample clips ─────────────────────────────────────────────────
  // Fetched once (fire-and-forget, kicked off below) rather than per-panel-
  // open, since it's static and small. getCachedSamples() is synchronous —
  // by the time a user could plausibly open the Input panel, this has
  // almost always already resolved; listSamples() (promise-based) exists
  // as a fallback for the rare case a caller wants to wait on it instead.
  let _sampleManifest = [];
  let _sampleManifestPromise = null;
  function fetchSampleManifest() {
    if (_sampleManifestPromise) return _sampleManifestPromise;
    _sampleManifestPromise = fetch('vendor/audio/manifest.json')
      .then(res => res.ok ? res.json() : { samples: [] })
      .then(data => { _sampleManifest = data.samples || []; return _sampleManifest; })
      .catch(err => { console.error('[Audio] Sample manifest load error:', err); _sampleManifest = []; return _sampleManifest; });
    return _sampleManifestPromise;
  }
  function getCachedSamples() { return _sampleManifest; }
  function listSamples() { return fetchSampleManifest(); }

  // Fetches a bundled sample and decodes it through the exact same path an
  // uploaded file already uses — samples aren't a separate audio-loading
  // system, just a different source for the same "Audio File" playback.
  async function loadSampleClip(fileName, displayName) {
    try {
      const res = await fetch('vendor/audio/' + fileName);
      if (!res.ok) throw new Error('fetch failed: ' + res.status);
      const buffer = await res.arrayBuffer();
      return await loadAudioFile({ name: displayName, buffer });
    } catch (err) {
      console.error('[Audio] Sample clip load error:', err);
      return null;
    }
  }
  fetchSampleManifest(); // warm the cache at module load, well before the Input panel could realistically be opened

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

  // ── Real-topology signal walk (branch-aware) ────────────────────────────
  // BFS over the net graph from Input's net. Every net that gets reached
  // gets its own small GainNode "bus" (gain=1, a pure summing/passthrough
  // point) — that's what makes branching work: a net with two components
  // touching it (say a series resistor continuing on, and something else
  // shunting off it) just gets two things connected out of the same bus,
  // and Web Audio naturally sums whatever comes back together at a shared
  // destination bus. Each component is only ever built once (`used`),
  // however many nets reach it, so a loop in the wiring can't cause
  // infinite work — worst case is bounded by the number of parts on the
  // board (see MAX_STAGES).
  //
  // One honest limitation carried over from the single-path version: this
  // is a signal-level graph, not an impedance-aware one. A shunt-to-ground
  // capacitor next to a series resistor doesn't "steal" high frequencies
  // away from the series path the way it does on a real board — that
  // specific, common case (resistor + a capacitor sharing one of its nets)
  // is still special-cased in buildAudioStage as a combined lowpass, same
  // as before. What's new is that capacitor is now ALSO reachable as its
  // own independent branch (so probing past it, in whatever direction its
  // other leg goes, hears its own coupling-highpass stage) — a deliberate
  // small redundancy, not a bug: two valid, differently-useful ways to
  // listen to the same physical capacitor, rather than one gaining
  // "realism" at the cost of the other's probeability.
  function traceSignalPath(ctx, placed, wires, cp, source) {
    const nets = Simulation.buildNetMap(placed, wires);
    const inputNet  = nets.find(nets.key(cp.firstRow, cp.inputCol));
    const outputNet = nets.find(nets.key(cp.firstRow, cp.outputCol));

    // Ground is a fixed 0V reference, not an ordinary circuit node — real
    // audio never "appears" there (a shunt cap's job is to send unwanted
    // content OUT of the signal path to the reference, not to make it
    // newly audible AT the reference). Mirrors simulation.js's own
    // permPosNet/permNegNet polarity check.
    //
    // Uses the power block's REAL connection columns (from
    // getConnectionPoints, which reflects wherever it's actually snapped to
    // on the board) rather than a hardcoded column — the top rail has a
    // physical break partway across the board, splitting it into two
    // independent segments; hardcoding column 0 only identifies ONE of
    // those segments, silently missing ground entirely for any circuit
    // built on the other side of the break.
    const power    = (typeof WorkbenchStrip !== 'undefined') ? WorkbenchStrip.getPermanentState().power : null;
    const reversed = !!power?.reverse_polarity;
    const minusRow = reversed ? 'rtp' : 'rtm'; // reverse_polarity changes which physical rail row the minus LEAD lands on, not which lead is ground
    const groundNet = (cp.powerMinusCol!=null) ? nets.find(nets.key(minusRow, cp.powerMinusCol)) : null;

    const netTaps  = new Map(); // net -> bus GainNode, doubles as the Audio Probe tap
    const allNodes = [];
    const used      = new Set(); // instanceIds already built — each component gets exactly one stage, however many of its nets get reached
    const MAX_STAGES = 64;       // finitely many parts on a board — `used` already prevents true infinite loops, this is just a documented backstop

    function busFor(net) {
      if (!netTaps.has(net)) {
        const bus = ctx.createGain(); bus.gain.value = 1;
        netTaps.set(net, bus);
        allNodes.push(bus);
      }
      return netTaps.get(net);
    }

    source.connect(busFor(inputNet));

    const frontier = [inputNet];
    const visitedNets = new Set(frontier);
    let stageCount = 0;

    while (frontier.length && stageCount < MAX_STAGES) {
      const net = frontier.shift();
      if (net === groundNet) continue; // ground is a valid destination, never a valid source of further hops — see note above traceSignalPath
      const entryBus = busFor(net);

      for (const inst of placed) {
        if (inst.failed || used.has(inst.instanceId)) continue;
        const def = ComponentRegistry.getById(inst.defId);
        if (!def) continue;
        const pairs = signalLegPairs(inst, def);
        let entryNet = null, otherNet = null;
        for (const pair of pairs) {
          const netA = nets.find(nets.key(pair[0].row, pair[0].col));
          const netB = nets.find(nets.key(pair[1].row, pair[1].col));
          if (netA === net && netB !== net) { entryNet = netA; otherNet = netB; break; }
          if (netB === net && netA !== net) { entryNet = netB; otherNet = netA; break; }
        }
        if (otherNet == null) continue; // no matching pair touches the net we're expanding from

        used.add(inst.instanceId);
        stageCount++;

        const built = buildAudioStage(ctx, inst, def, nets, placed, entryNet, otherNet);
        const exitBus = busFor(otherNet);
        if (built) {
          entryBus.connect(built.in);
          allNodes.push(built.in); if (built.out !== built.in) allNodes.push(built.out);
          built.out.connect(exitBus);
        } else {
          // no audio-shaping effect (e.g. a lone series resistor, or an
          // LED) — signal passes through unchanged onto the far bus.
          entryBus.connect(exitBus);
        }

        if (otherNet !== groundNet && !visitedNets.has(otherNet)) { visitedNets.add(otherNet); frontier.push(otherNet); }
      }
    }

    // Ground still needed a real bus above (so shunt/coupling components had
    // something valid to connect into) but it should never read back as
    // audible — it's the reference, not a signal-carrying node. Overriding
    // the tap to null here means Probe correctly reports silence there,
    // without needing to special-case every place a component might route
    // to ground.
    if (groundNet != null) netTaps.set(groundNet, null);

    return { nets, netTaps, reachedOutput: netTaps.has(outputNet) && netTaps.get(outputNet)!=null, tail: netTaps.get(outputNet) || null, allNodes };
  }

  // Which leg-pair(s) can carry the traced signal, per component type.
  // 2-leg parts are unambiguous. 3-leg parts can have more than one valid
  // pair — a potentiometer's wiper might be wired to either outer leg
  // depending on which one the source actually lands on (both are
  // standard volume-pot wirings, just mirror images of each other), so
  // both are offered and whichever one's other leg matches the net being
  // expanded from wins. A transistor's real signal path for a common-
  // emitter stage is base-in / collector-out (not collector<->emitter,
  // which was the wrong assumption before this fix) — this assumes the
  // emitter is at AC ground; no emitter-degeneration modeling.
  function signalLegPairs(inst, def) {
    switch (def.behavior?.type) {
      case 'resistor': case 'capacitor': case 'diode': case 'led':
        return inst.legs.length >= 2 ? [[inst.legs[0], inst.legs[inst.legs.length-1]]] : [];
      case 'potentiometer':
        return inst.legs.length >= 3 ? [[inst.legs[1], inst.legs[0]], [inst.legs[1], inst.legs[2]]] : []; // wiper <-> either outer leg
      case 'bjt_npn': case 'bjt_pnp': {
        if (inst.legs.length < 3) return [];
        const eIdx = (inst.props.pinout === 'CBE') ? 2 : 0;
        const cIdx = eIdx === 0 ? 2 : 0;
        return [[inst.legs[1], inst.legs[cIdx]]]; // base -> collector
      }
      default: return [];
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
        const parsedWiper = parseFloat(inst.props.wiper);
        const wiper = Number.isNaN(parsedWiper) ? 0.5 : parsedWiper; // NOT `|| 0.5` — that treats a real, valid wiper of exactly 0 as missing and silently substitutes 0.5
        const pos   = (inst.props.taper||'').includes('Audio') ? Math.pow(wiper,2) : wiper;
        const g     = ctx.createGain(); g.gain.value = pos;
        inst._audioNode = g;
        return { in: g, out: g };
      }
      case 'bjt_npn': case 'bjt_pnp': {
        const mk  = inst.props.model || (def.behavior.type === 'bjt_pnp' ? '2N3906' : '2N3904');
        const pm  = def.model_params?.[mk] || {};

        // Real small-signal gain from the DC operating point the electrical
        // solver already computes (inst._current = Ic, set in
        // simulation.js's bjt_npn/bjt_pnp case) rather than a flat
        // hFE-only guess: gm = Ic/Vt (transconductance), and a bare
        // common-emitter stage's voltage gain is ~gm * Rc, where Rc is
        // whatever resistor is actually sitting on the collector's net —
        // its real load, not an assumed value. Emitter degeneration isn't
        // modeled (that would need a second resistor-on-emitter-net
        // lookup and a different gain formula) — this assumes a bare
        // common-emitter stage.
        const eIdx = (inst.props.pinout === 'CBE') ? 2 : 0;
        const cIdx = eIdx === 0 ? 2 : 0;
        const Ic = Math.max(inst._current || 0, 1e-6); // floor avoids a divide-by-near-zero cliff when barely biased
        const Vt = 0.026; // thermal voltage at room temperature
        const collectorLeg = inst.legs[cIdx];
        const collectorNet = nets.find(nets.key(collectorLeg.row, collectorLeg.col));
        const Rc = placed.find(p => p.defId==='resistor' && !p.failed &&
          p.legs.some(l => nets.find(nets.key(l.row, l.col)) === collectorNet));
        const RcValue = Rc ? (parseFloat(Rc.props.resistance) || 10000) : 10000; // no collector resistor found -> reasonable fallback load
        const gain = Utils.clamp((Ic / Vt) * RcValue, 0.5, 25);

        const g = ctx.createGain(); g.gain.value = gain;

        // Clip headroom now scales with how hard the stage is actually
        // biased (Ic against its rated max) instead of one fixed shape for
        // every transistor regardless of operating point — barely-biased
        // reads soft/clean, driven-hard reads compressed/clipped sooner.
        const IcMax = (pm.max_ic_ma || 200) / 1000;
        const headroom = Utils.clamp(1 - (Ic / IcMax), 0.15, 0.9);
        const sh = ctx.createWaveShaper(); sh.curve = makeClipCurve(headroom);
        g.connect(sh);
        return { in: g, out: sh };
      }
      case 'diode': {
        const mk  = inst.props.model || '1N4148';
        const pm  = def.model_params?.[mk] || {};
        const isGerman = pm.type === 'germanium';

        // Clip threshold now follows the diode's actual solved current
        // (inst._current, from the same DC pass simulation.js's diode case
        // now tracks) relative to its rated max, instead of one fixed
        // per-material guess — a diode barely conducting clips softer than
        // one being driven hard, same physical intuition as the
        // transistor headroom above.
        const ImA   = (pm.max_current_ma || (isGerman ? 75 : 200)) / 1000;
        const drive = Utils.clamp((inst._current || 0) / ImA, 0, 1);
        const base  = isGerman ? 0.3 : 0.65;
        const threshold = Utils.clamp(base - drive*0.15, 0.15, 0.9); // harder-driven diode clips a bit sooner
        const sh = ctx.createWaveShaper(); sh.curve = makeClipCurve(threshold);
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
    const parsedWiper = parseFloat(inst.props.wiper);
    const wiper = Number.isNaN(parsedWiper) ? 0.5 : parsedWiper; // see the same fix/comment in buildAudioStage's potentiometer case
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
    probeEnable, probeDisable, probeHover, probeIsAudible,
    getCachedSamples, listSamples, loadSampleClip
  };
})();