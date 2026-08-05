// ── Audio Engine ──────────────────────────────────────────────────────────────
// Reads the permanent Input/Output device state (WorkbenchStrip) rather than
// a placed 'signal_generator' component — that component is retired in favor
// of the permanent Input, per the "Future Workbench Architecture" doc.
//
// The audio chain is built by walking the REAL net graph (Simulation.buildNetMap)
// from the Input's net to the Output's net, hopping through whichever
// component actually has a leg on the current net — not by blindly chaining
// every placed component in board order. The walk is branch-aware: every
// reached net gets its own bus, so several components hanging off one net
// each get connected and Web Audio sums them (see traceSignalPath). 3-leg
// parts offer their signal-carrying leg pairs (potentiometer: wiper to
// either outer leg; transistor: base->collector), and whichever pair
// matches the net being expanded from wins.
//
// The remaining honest limitation is that this is a signal-level graph, not
// an impedance-aware one — see the note above traceSignalPath.
//
// Switches are not hops and have no case in signalLegPairs by design:
// buildNetMap already unions a CLOSED switch's two legs into one net, so a
// closed switch is transparent here for free, and an open one leaves the
// two sides on separate nets with nothing bridging them, which correctly
// stops the walk. Adding a leg pair for them would make an OPEN switch pass
// signal, since its legs are the only case where the two nets differ.
//
// Each net visited during the walk is recorded in a net->tap map, which is
// what makes Audio Probe possible: probing a hole looks up its net and plays
// whatever's actually there, instead of a fixed chain-order guess.

const AudioEngine = (() => {
  // Diode thresholds are in VOLTS; a WaveShaper curve works on the signal's
  // [-1,1] range, and this graph is normalized with no volts mapping anywhere
  // in it. This is that mapping: 1.0 of signal treated as 1.0 volt, so a
  // silicon diode's 0.7V clamp lands at 0.7 of full scale.
  //
  // PROVISIONAL, same status as the gain-knee constants. It's analytically
  // motivated (buildSource emits amp*0.5, and a guitar's output is order-of-
  // magnitude 1V peak) but it has NOT had an ear-tuning pass. Getting the
  // curve's SHAPE right — asymmetric, correct thresholds relative to each
  // other — is what determines character; this single number sets how hard
  // the clipping bites, and is the one knob to turn if it sounds wrong.
  const VOLTS_PER_SIGNAL_UNIT = 1.0;

  let _ctx              = null;
  let _source           = null;   // node the rest of the graph connects FROM
  let _sourceStartable  = null;   // the actual OscillatorNode/BufferSource/ConstantSource(s) needing .start()
  let _allChainNodes    = [];     // every raw AudioNode created while walking, for disconnect-on-stop
  let _analyser         = null;
  let _analyserSpectrum = null;
  let _inputAnalyser    = null; // tapped on raw input, for signal-driven battery sag
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

  // Remembered from the last start()'s walk, so toggling bypass can
  // recompute _chainTail (see _refreshBypassRouting below) without
  // re-walking the net graph or rebuilding _source.
  let _walkReachedOutput = false;
  // Built once per Play (alongside the audio graph itself) by buildAudioStage's
  // BJT case, one entry per transistor stage — walked every Simulation tick
  // (via updateLiveGains, wired to Simulation.onUpdate) to push a fresh gain
  // and clip curve as the DC operating point moves (battery sag, etc.)
  // without ever re-running the netlist walk or rebuilding any node.
  let _liveGainStages = [];
  let _walkTail          = null;

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

      // Tapped on the RAW input, before the circuit and independent of
      // bypass — sag should respond to how hard the player is actually
      // driving the circuit, not to whatever the circuit's already done to
      // the signal (which would create a weird self-referential relationship
      // once clipping is involved). Separate from _analyser/_analyserSpectrum
      // above, which are tapped post-routing for the scope/spectrum display.
      _inputAnalyser = ctx.createAnalyser();
      _inputAnalyser.fftSize = 2048;
      _source.connect(_inputAnalyser);

      _rebuildWalk(ctx, placed, wires);

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
      if (_inputAnalyser)    { _inputAnalyser.disconnect(); _inputAnalyser = null; }
      if (_gainOut)          { _gainOut.disconnect(); _gainOut = null; }
    } catch (err) { console.warn('[Audio] Stop error:', err); }
    _running = false;
    _routedNode = null; _chainTail = null; _probeNets = null; _netTaps = null;
    _walkReachedOutput = false; _walkTail = null;
    _liveGainStages = [];
  }

  // Live-updates Output's volume/mute while running, without rebuilding the
  // graph — called from properties-panel.js when those specific props change.
  function setOutputGain(volume, mute) {
    if (!_gainOut || !_ctx) return;
    const target = mute ? 0 : Utils.clamp(volume ?? 0.7, 0, 1);
    _gainOut.gain.setTargetAtTime(target, _ctx.currentTime, 0.01);
  }

  // Called when the bypass footswitch toggles. The walked chain (built in
  // start(), regardless of bypass state — see the comment there) and _source
  // itself are both already live; only which one feeds the analyser/speaker
  // needs to change. Reuses the exact same _chainTail logic as start(), just
  // without rebuilding _source/_sourceStartable — so playback (an oscillator
  // or a playing sample) is never interrupted by flipping the switch.
  function refreshBypassRouting() {
    if (!_running) return;
    _chainTail = bypassOn() ? (_walkReachedOutput ? _walkTail : null) : _source;
    _routeToOutput(_probeActive ? null : _chainTail);
  }

  // The net-graph walk plus the routing decision that follows it. Shared by
  // start() and refreshTopology() rather than duplicated, for the same reason
  // computeBjtGainAndHeadroom is shared by buildAudioStage and
  // updateLiveGains: one copy can't quietly drift from the other.
  //
  // Reads _source but never rebuilds it, so a playing sample or oscillator
  // survives a rebuild untouched.
  //
  // Walks the real net graph regardless of bypass — Audio Probe needs to be
  // able to bench-probe the circuit even with the footswitch disengaged, same
  // as a real pedal. Bypass only decides what feeds the actual Output.
  function _rebuildWalk(ctx, placed, wires) {
    // Reset BEFORE the walk: buildAudioStage's BJT case pushes onto this, so
    // without the reset every rebuild appends a duplicate set and
    // updateLiveGains starts writing gain values to disconnected dead nodes
    // on every tick, forever.
    _liveGainStages = [];

    const cp = (typeof WorkbenchStrip !== 'undefined') ? WorkbenchStrip.getConnectionPoints() : null;
    const walk = (cp && typeof Simulation !== 'undefined' && Simulation.buildNetMap)
      ? traceSignalPath(ctx, placed, wires, cp, _source)
      : { nets:null, netTaps:new Map(), reachedOutput:false, tail:null, allNodes:[] };

    _probeNets      = walk.nets;
    _netTaps        = walk.netTaps;
    _allChainNodes  = walk.allNodes;
    _walkReachedOutput = walk.reachedOutput;
    _walkTail          = walk.tail;

    // Bypass OFF: Input -> Output directly (clean signal, no user circuit).
    // Bypass ON:  Input -> user circuit -> Output, using the walk above —
    // reachedOutput means a real, component-mediated path exists (not just
    // "some components happen to be on the board").
    _chainTail = bypassOn() ? (walk.reachedOutput ? walk.tail : null) : _source;
    _routeToOutput(_probeActive ? null : _chainTail);
  }

  // Called when the board's TOPOLOGY changes while running. Currently that's
  // only a switch toggle, which is the one control deliberately exempt from
  // the engaged-lock (a switch is a runtime control, not an edit — see
  // board.js's onClick and its momentary-press handling). Everything else
  // that can change while playing is a VALUE change, pushed onto the existing
  // graph by updateLiveGains/updatePotWiper without any rewalk.
  //
  // MUST run AFTER the DC re-solve (Simulation.notifyStateChange calls tick()
  // first, then fires this): buildAudioStage's BJT case reads inst._current
  // and inst._vceHeadroom from that solve to compute stage gain, so rebuilding
  // first would build every transistor stage from the PRE-toggle operating
  // point. Don't reorder these.
  //
  // _source/_sourceStartable are deliberately not rebuilt, so flipping a
  // switch doesn't restart an audio file mid-playback — the same property
  // refreshBypassRouting preserves, and the reason both exist instead of just
  // calling stop()/start().
  function refreshTopology() {
    if (!_running || !_ctx) return;

    // Detach the speaker feed before tearing down the nodes it points at.
    _routeToOutput(null);

    // Only the walk's own nodes. _source and the analysers are not in here.
    for (const n of _allChainNodes) { try { n.disconnect(); } catch(e){} }
    _allChainNodes = [];

    _rebuildWalk(_ctx, Board.getPlaced(), Board.getWires());
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
    // on the board) rather than a hardcoded column. The rails span the full
    // board width now (see simulation.js's buildNetMap), so this no longer
    // guards against missing one segment of a split rail — that break is
    // gone. Kept because reading the block's actual position is still
    // correct regardless, and mirrors what simulation.js does.
    const power    = (typeof WorkbenchStrip !== 'undefined') ? WorkbenchStrip.getPermanentState().power : null;
    const reversed = !!power?.reverse_polarity;
    const minusRow = reversed ? 'rtp' : 'rtm'; // reverse_polarity changes which physical rail row the minus LEAD lands on, not which lead is ground
    const groundNet = (cp.powerMinusCol!=null) ? nets.find(nets.key(minusRow, cp.powerMinusCol)) : null;

    const netTaps  = new Map(); // net -> node to connect OUT FROM; also the Audio Probe tap (post-clamp)
    const netIns   = new Map(); // net -> node to connect INTO; same object as the tap unless a clamp sits on the net
    const allNodes = [];
    const used      = new Set(); // instanceIds already built — each component gets exactly one stage, however many of its nets get reached
    const MAX_STAGES = 64;       // finitely many parts on a board — `used` already prevents true infinite loops, this is just a documented backstop

    // ── Shunt clippers ────────────────────────────────────────────────────
    // A diode or LED from a net to ground does NOT sit in the signal path, it
    // CLAMPS the net: everything downstream sees the limited waveform. The
    // walk's normal treatment (net -> stage -> ground bus) is wrong twice over
    // for a shunt part — the ground bus's tap is nulled so the stage feeds
    // nothing, and the through-signal bypasses it entirely. Measured on the
    // Electra Distortion: both clipping diodes were built, were fed by the
    // source, and were completely inaudible, which is most of that pedal.
    //
    // Anti-parallel pairs clip ASYMMETRICALLY, and that asymmetry is the whole
    // character of such circuits. A diode with its ANODE on the net conducts
    // on the positive swing and so clamps the POSITIVE half at its Vf; one
    // with its CATHODE on the net clamps the NEGATIVE half. An Electra's
    // silicon/germanium pair therefore clips at ~0.7V one way and ~0.25V the
    // other, from the real per-model vf rather than a hand-tuned curve shape.
    //
    // Where several diodes share a half, the LOWEST Vf wins: it starts
    // conducting first and holds the node before the others can.
    const clampsByNet = new Map(); // net -> { pos, neg } thresholds in volts
    if (groundNet != null) {
      for (const inst of placed) {
        if (inst.failed || inst.legs.length < 2) continue;
        const def = ComponentRegistry.getById(inst.defId);
        const bt  = def?.behavior?.type;
        if (bt !== 'diode' && bt !== 'led') continue;
        const anodeNet   = nets.find(nets.key(inst.legs[0].row, inst.legs[0].col));
        const cathodeNet = nets.find(nets.key(inst.legs[inst.legs.length-1].row, inst.legs[inst.legs.length-1].col));
        let net = null, half = null;
        if (cathodeNet === groundNet && anodeNet !== groundNet) { net = anodeNet;   half = 'pos'; }
        else if (anodeNet === groundNet && cathodeNet !== groundNet) { net = cathodeNet; half = 'neg'; }
        else continue; // not a shunt-to-ground clipper; leave it to the walk as a series hop

        const entry = clampsByNet.get(net) || { pos: Infinity, neg: Infinity };
        entry[half] = Math.min(entry[half], forwardVoltage(inst, def));
        clampsByNet.set(net, entry);
        used.add(inst.instanceId); // handled as a clamp, so never also built as a series stage
      }
    }

    // A net needs two nodes only when something clamps it. Without a clamp the
    // in and out nodes are literally the same object, so every circuit with no
    // shunt clipper produces exactly the graph it did before.
    function ensureBus(net) {
      if (netIns.has(net)) return;
      const inBus = ctx.createGain(); inBus.gain.value = 1;
      allNodes.push(inBus);
      netIns.set(net, inBus);

      const clamp = clampsByNet.get(net);
      if (!clamp) { netTaps.set(net, inBus); return; }

      const toUnits = v => Utils.clamp(Number.isFinite(v) ? v / VOLTS_PER_SIGNAL_UNIT : 0.99, 0.01, 0.99);
      const sh = ctx.createWaveShaper();
      sh.curve = makeClipCurve(toUnits(clamp.pos), toUnits(clamp.neg));
      inBus.connect(sh);
      allNodes.push(sh);
      netTaps.set(net, sh); // downstream, and the probe, hear the CLAMPED signal
    }
    function busIn(net)  { ensureBus(net); return netIns.get(net); }  // things arriving at the net
    function busOut(net) { ensureBus(net); return netTaps.get(net); } // things leaving it, and the probe tap

    source.connect(busIn(inputNet));

    const frontier = [inputNet];
    const visitedNets = new Set(frontier);
    let stageCount = 0;

    while (frontier.length && stageCount < MAX_STAGES) {
      const net = frontier.shift();
      if (net === groundNet) continue; // ground is a valid destination, never a valid source of further hops — see note above traceSignalPath
      const entryBus = busOut(net); // leaving this net, so post-clamp

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

        const built = buildAudioStage(ctx, inst, def, nets, placed, entryNet, otherNet, groundNet);
        const exitBus = busIn(otherNet); // arriving at the far net, so pre-clamp
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
  // Finds the real, effective (AC) resistance between a transistor's
  // emitter net and ground, for the gain formula's emitter-degeneration
  // term. Returns 0 (no degeneration, same as the old gm*Rc-only formula)
  // if nothing recognizable is on the emitter net — a bare grounded
  // emitter (no resistor at all) is the common case and correctly falls
  // through to that same 0.
  //
  // Two shapes are handled, the ones that actually show up in pedal
  // circuits:
  //  1. A plain resistor from the emitter net to groundNet. If a
  //     capacitor bridges the SAME two nets (a bypass cap in parallel
  //     with the whole resistor), it's fully AC-shorted -> Re=0.
  //     Otherwise the full resistor value degenerates the stage.
  //  2. A potentiometer with one outer leg on the emitter net and the
  //     OTHER outer leg on groundNet (e.g. a "fuzz" control wired as a
  //     rheostat so DC bias stays fixed regardless of wiper position).
  //     If a capacitor bridges the wiper net to groundNet, only the
  //     emitter-to-wiper segment stays unbypassed at AC — that's the
  //     part that actually degenerates the stage, and is what makes the
  //     knob audible. No such cap -> the whole pot body is in series,
  //     unbypassed, regardless of wiper (matches real breadboard
  //     behavior for that wiring).
  // Prefers a component's tolerance-resolved actual value over its nominal
  // one — same helper/reasoning as simulation.js's resolvedValue (duplicated
  // here rather than shared, since this codebase has no module system).
  function resolvedValue(inst, key, fallback) {
    const actual = parseFloat(inst.props[key+'_actual']);
    if (Number.isFinite(actual)) return actual;
    const nominal = parseFloat(inst.props[key]);
    return Number.isFinite(nominal) ? nominal : fallback;
  }

  function findEmitterResistance(emitterNet, groundNet, nets, placed) {
    if (emitterNet == null || groundNet == null) return 0;

    const netOf = (row, col) => nets.find(nets.key(row, col));
    const bridgesNets = (capInst, netX, netY) => {
      if (capInst.legs.length < 2) return false;
      const a = netOf(capInst.legs[0].row, capInst.legs[0].col);
      const b = netOf(capInst.legs[capInst.legs.length-1].row, capInst.legs[capInst.legs.length-1].col);
      return (a===netX && b===netY) || (a===netY && b===netX);
    };
    const findBypassCap = (netX, netY) => placed.find(p =>
      (p.defId==='capacitor' || p.defId==='capacitor_electrolytic') && !p.failed && bridgesNets(p, netX, netY));

    for (const p of placed) {
      if (p.failed) continue;

      if (p.defId === 'resistor' && p.legs.length >= 2) {
        const a = netOf(p.legs[0].row, p.legs[0].col);
        const b = netOf(p.legs[p.legs.length-1].row, p.legs[p.legs.length-1].col);
        const onEmitter = (a===emitterNet) ? b : (b===emitterNet) ? a : null;
        if (onEmitter === groundNet) {
          const R = resolvedValue(p, 'resistance', 0);
          return findBypassCap(emitterNet, groundNet) ? 0 : R;
        }
      }

      if (p.defId === 'potentiometer' && p.legs.length >= 3) {
        const ccwNet = netOf(p.legs[0].row, p.legs[0].col);
        const wprNet = netOf(p.legs[1].row, p.legs[1].col);
        const cwNet  = netOf(p.legs[2].row, p.legs[2].col);
        const onEmitter = (ccwNet===emitterNet) ? 'ccw' : (cwNet===emitterNet) ? 'cw' : null;
        if (!onEmitter) continue;
        const farNet = onEmitter==='ccw' ? cwNet : ccwNet;
        if (farNet !== groundNet) continue; // not the "outer leg to ground" shape we model

        const Rt  = parseFloat(p.props.resistance) || 0;
        const parsedW = parseFloat(p.props.wiper);
        const w   = Number.isNaN(parsedW) ? 0.5 : parsedW;
        const pos = (p.props.taper||'').includes('Audio') ? Math.pow(w,2) : w;
        const unbypassedR = onEmitter==='ccw' ? Rt*pos : Rt*(1-pos); // emitter-net-to-wiper segment

        return findBypassCap(wprNet, groundNet) ? unbypassedR : Rt;
      }
    }
    return 0;
  }

  // Real small-signal gain from the DC operating point the electrical
  // solver already computes (inst._current = Ic, set in simulation.js's
  // bjt_npn/bjt_pnp case) rather than a flat hFE-only guess: gm = Ic/Vt
  // (transconductance), and a bare common-emitter stage's voltage gain is
  // ~gm * Rc, where Rc is whatever resistor is actually sitting on the
  // collector's net — its real load, not an assumed value. Emitter
  // degeneration (see findEmitterResistance) is folded in as the standard
  // Rc / (re + Re) form, where re=1/gm — Re=0 collapses back to the
  // original gm*Rc, so a bare grounded-emitter stage is unaffected.
  //
  // Shared by buildAudioStage (once, at Play) and updateLiveGains (every
  // Simulation tick) — one formula, read fresh from inst._current/
  // inst._vceHeadroom each time it's called, rather than two copies that
  // could quietly drift apart.
  function computeBjtGainAndHeadroom(inst, def, nets, placed, groundNet) {
    const eIdx = (inst.props.pinout === 'CBE') ? 2 : 0;
    const cIdx = eIdx === 0 ? 2 : 0;
    const Ic = Math.max(inst._current || 0, 1e-6); // floor avoids a divide-by-near-zero cliff when barely biased
    const Vt = 0.026; // thermal voltage at room temperature
    const emitterLeg = inst.legs[eIdx];
    const emitterNet = nets.find(nets.key(emitterLeg.row, emitterLeg.col));
    const Re = findEmitterResistance(emitterNet, groundNet, nets, placed);
    const collectorLeg = inst.legs[cIdx];
    const collectorNet = nets.find(nets.key(collectorLeg.row, collectorLeg.col));
    const Rc = placed.find(p => p.defId==='resistor' && !p.failed &&
      p.legs.some(l => nets.find(nets.key(l.row, l.col)) === collectorNet));
    const RcValue = Rc ? resolvedValue(Rc, 'resistance', 10000) : 10000; // no collector resistor found -> reasonable fallback load
    const gm = Ic / Vt;
    const re = 1 / gm; // transistor's own intrinsic emitter resistance
    const rawGain = RcValue / (re + Re); // Re=0 (no emitter resistor found) reduces this to the original gm*Rc

    // A bare common-emitter stage's raw gm*Rc easily lands in the tens to
    // hundreds for realistic bias points and Rc values — a hard clamp made
    // every model whose raw gain cleared ~25 sound identical, which in
    // practice was most of them. A soft knee keeps the range differentiated
    // instead of flatlining past one threshold.
    //
    // kneePoint recalibrated from 80 to 400: this circuit's actual measured
    // rawGain range is roughly 200-800 (a real ~4x spread from genuine
    // transistor/bias differences) — at kneePoint=80, that whole range sat
    // deep in the knee's asymptotically-flat region (200->~24x, 800->~32x,
    // under 2.5dB of difference for a real 4x underlying swing), which is
    // why transistor substitutions and supply voltage changes were barely
    // audible: the knee was erasing the very differentiation those changes
    // produced, before it ever reached the WaveShaper. At kneePoint=400,
    // the same 200-800 range spans roughly 12x-23x (~5.7dB) — a real,
    // audible difference for the same underlying variation. Still
    // provisional and still needs a genuine ear-tuning pass once this is
    // testable end-to-end; this recalibration is analytical (matching the
    // knee to the circuit's actual measured range), not a substitute for
    // actually listening to it.
    const maxGain = 35, kneePoint = 400;
    const gain = maxGain * rawGain / (rawGain + kneePoint);

    // Clip headroom follows how close the actual DC operating point sits to
    // saturation (inst._vceHeadroom, from simulation.js — 0 at the
    // saturation floor, 1 comfortably clear of it), a real, model- and
    // bias-sensitive quantity: a higher-hFE model (or heavier sag) pulls
    // more Ic for the same Ib, sagging Vce further toward the floor through
    // the same Rc.
    const vceHeadroom = inst._vceHeadroom ?? 1;
    const headroom = Utils.clamp(0.15 + (0.9 - 0.15) * vceHeadroom, 0.15, 0.9);

    return { gain, headroom };
  }

  function buildAudioStage(ctx, inst, def, nets, placed, entryNet, exitNet, groundNet) {
    switch (def.behavior?.type) {
      case 'resistor': {
        // Net-based RC pairing: a capacitor shunting one of this resistor's
        // own two nets AND going to ground on its other leg forms a real
        // lowpass. Requiring the ground leg specifically (not just "touches
        // either net") matters on a busy hub node — e.g. a bias-divider
        // junction with several other things attached — where an unrelated
        // capacitor (an input-coupling cap serving a completely different
        // purpose) could otherwise get mistaken for this resistor's shunt
        // partner just for sharing that node.
        const cap = groundNet==null ? null : placed.find(p => {
          if (p.defId !== 'capacitor' || p.failed || p.legs.length < 2) return false;
          const a = nets.find(nets.key(p.legs[0].row, p.legs[0].col));
          const b = nets.find(nets.key(p.legs[p.legs.length-1].row, p.legs[p.legs.length-1].col));
          const aTouches = (a===entryNet || a===exitNet), bTouches = (b===entryNet || b===exitNet);
          return (aTouches && b===groundNet) || (bTouches && a===groundNet);
        });
        if (!cap) return null; // lone series resistor: no filtering effect, transparent
        const R = resolvedValue(inst, 'resistance', 10000);
        const C = resolvedValue(cap, 'capacitance', 0.000001);
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
        const { gain, headroom } = computeBjtGainAndHeadroom(inst, def, nets, placed, groundNet);
        const g = ctx.createGain(); g.gain.value = gain;
        const sh = ctx.createWaveShaper(); sh.curve = makeClipCurve(headroom);
        g.connect(sh);
        _liveGainStages.push({ inst, g, sh, nets, placed, groundNet });
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
        const C  = resolvedValue(inst, 'capacitance', 0.000001);
        const fc = 1 / (2 * Math.PI * 10000 * C);
        const f  = ctx.createBiquadFilter();
        f.type = 'highpass'; f.frequency.value = Utils.clamp(fc, 10, 20000);
        return { in: f, out: f };
      }
      default: return null; // e.g. LED — traversable as a hop, but no audio shaping (unchanged from before)
    }
  }

  // Soft-knee clipping curve. Takes a separate threshold per half so an
  // anti-parallel diode pair clips asymmetrically — silicon at ~0.7 one way,
  // germanium at ~0.25 the other — which is where even-harmonic warmth comes
  // from and is the whole point of circuits like the Electra. Omitting the
  // second argument gives the symmetric curve this used to produce, which is
  // still correct for a transistor stage's own headroom.
  function makeClipCurve(posThreshold, negThreshold = posThreshold) {
    const n = 256, curve = new Float32Array(n);
    const shape = (mag, t) => mag < t ? mag : t + (1-t) * Math.tanh((mag - t) / (1-t));
    for (let i = 0; i < n; i++) {
      const x = (i * 2) / n - 1;
      const t = Utils.clamp(x >= 0 ? posThreshold : negThreshold, 0.01, 0.99);
      curve[i] = Math.sign(x) * shape(Math.abs(x), t);
    }
    return curve;
  }

  // Same resolution order simulation.js uses, so the audio model and the
  // solver can never disagree about a diode's forward voltage.
  function forwardVoltage(inst, def) {
    const typed = parseFloat(inst.props.forward_voltage);
    if (Number.isFinite(typed)) return typed;
    if (def.behavior?.type === 'led') return def.color_map?.[inst.props.color]?.vf ?? 2.0;
    return def.model_params?.[inst.props.model]?.vf ?? 0.7;
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

  // Called after every Simulation tick (wired via Simulation.onUpdate in
  // app.js) — walks the stages recorded at Play time and pushes a fresh
  // gain/clip curve for each from the just-completed DC solve. No netlist
  // walk, no node creation — topology doesn't change while playing (the
  // engaged-lock already guarantees that), only values do, so this is
  // proportional to how many transistor stages exist, not how big the
  // circuit is.
  function updateLiveGains() {
    if (!_running || !_ctx) return;
    for (const stage of _liveGainStages) {
      const { inst, g, sh, nets, placed, groundNet } = stage;
      const def = (typeof ComponentRegistry !== 'undefined') ? ComponentRegistry.getById(inst.defId) : null;
      if (!def) continue;
      const { gain, headroom } = computeBjtGainAndHeadroom(inst, def, nets, placed, groundNet);
      // Ramp, don't jump — a hard .value= would click on every 10ms update.
      g.gain.setTargetAtTime(gain, _ctx.currentTime, 0.01);
      sh.curve = makeClipCurve(headroom);
    }
  }

  function getAnalyser()         { return _analyser; }
  function getSpectrumAnalyser() { return _analyserSpectrum; }
  function isRunning()           { return _running; }
  function getAudioFileName()    { return _audioFileName; }
  function getSampleRate()       { return _ctx ? _ctx.sampleRate : 44100; }

  let _rmsScratch = null; // reused buffer, avoids a fresh allocation every 10ms tick
  function getInputRMS() {
    if (!_inputAnalyser) return 0;
    if (!_rmsScratch || _rmsScratch.length !== _inputAnalyser.fftSize) {
      _rmsScratch = new Float32Array(_inputAnalyser.fftSize);
    }
    _inputAnalyser.getFloatTimeDomainData(_rmsScratch);
    let sumSq = 0;
    for (let i = 0; i < _rmsScratch.length; i++) sumSq += _rmsScratch[i] * _rmsScratch[i];
    return Math.sqrt(sumSq / _rmsScratch.length);
  }

  return {
    start, stop, loadAudioFile,
    getAnalyser, getSpectrumAnalyser, getInputRMS,
    isRunning, getAudioFileName, updatePotWiper, updateLiveGains, setOutputGain, getSampleRate,
    probeEnable, probeDisable, probeHover, probeIsAudible,
    getCachedSamples, listSamples, loadSampleClip,
    refreshBypassRouting, refreshTopology
  };
})();