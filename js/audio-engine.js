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

  // Last-resort reference impedance for a coupling cap whose real load can't
  // be derived from the netlist (see acLoadResistance). Only reached when
  // nothing recognisable sits on either side of the cap, and it warns when it
  // is, because a silent fallback here is what made every coupling cap in the
  // app filter an order of magnitude too high for a long time.
  const CAP_REFERENCE_FALLBACK_R = 10000;

  // Every clipping stage runs its WaveShaper oversampled. A hard nonlinearity
  // generates harmonics far above the audio band; at 1x they fold back down as
  // inharmonic content, which is the metallic "digital fizz" that reads as
  // harsh and thin. WaveShaperNode.oversample defaults to 'none', so this was
  // happening everywhere.
  //
  // Measured on the Fuzz Face by driving a high sine into the clippers and
  // looking for energy BELOW the fundamental (a memoryless nonlinearity can
  // only produce harmonics ABOVE it, so anything below is folded): 4x removes
  // 16-21dB of it. -16.5dB of garbage at 7kHz became -33.9dB.
  //
  // '4x' rather than '2x' because the measured difference was large and the
  // cost is browser-side resampling on a handful of nodes, not per-sample JS.
  const CLIP_OVERSAMPLE = '4x';

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
  // Pot stages, refreshed from the small-signal solve on the same tick loop.
  let _livePotStages  = [];
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
    _livePotStages  = [];

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
    // The supply rail is AC ground too: a supply is a low impedance at signal
    // frequencies, so a collector resistor to V+ loads a node exactly as one
    // to ground would. Needed to get coupling-cap corner frequencies right.
    const plusRow   = reversed ? 'rtm' : 'rtp';
    const supplyNet = (cp.powerPlusCol!=null) ? nets.find(nets.key(plusRow, cp.powerPlusCol)) : null;
    // BOTH rails are AC ground, and the walk has to honour that or it will
    // route audio THROUGH a rail. groundNet is whichever net the minus LEAD
    // lands on, which is not the same thing as the circuit's signal
    // reference: in a positive-ground PNP build (reverse_polarity), the minus
    // lead is the -9V supply and the rail every ground symbol returns to is
    // the PLUS one. Treating only groundNet as ground there left the real
    // ground looking like an ordinary signal net, and a Fuzz Face PNP built a
    // path of Input Cap -> Fuzz pot -> 22uF -> Volume that bypassed both
    // transistors: two clipping stages built, fed, and completely off the
    // path. Measured as neutral on the NPN Fuzz Face and the Electra, which
    // build exactly the graph they did before.
    const isAcGround = net => net != null && (net === groundNet || net === supplyNet);

    // Item 6/8 plumbing: the real source/load impedance, so findAcCorner can
    // solve the ACTUAL network (including Input's Thevenin resistance and
    // Output's load) instead of acLoadResistance's blind spot at those two
    // points. 0 reproduces the old ideal-source/no-load behavior exactly —
    // see solveAcNetwork's default parameters.
    const input  = (typeof WorkbenchStrip !== 'undefined') ? WorkbenchStrip.getPermanentState().input  : null;
    const output = (typeof WorkbenchStrip !== 'undefined') ? WorkbenchStrip.getPermanentState().output : null;
    const sourceImpedance = Math.max(0, parseFloat(input?.source_impedance) || 0);
    const loadImpedance   = Math.max(0, parseFloat(output?.load_impedance) || 0);

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
    const clampsByNet = new Map(); // net -> { pos, neg, posSoftness, negSoftness } — thresholds in volts, softness 0-1 (see knee softness note below)
    if (groundNet != null) {
      for (const inst of placed) {
        if (inst.failed || inst.legs.length < 2) continue;
        const def = ComponentRegistry.getById(inst.defId);
        const bt  = def?.behavior?.type;
        if (bt !== 'diode' && bt !== 'led' && bt !== 'zener_diode') continue;
        const anodeNet   = nets.find(nets.key(inst.legs[0].row, inst.legs[0].col));
        const cathodeNet = nets.find(nets.key(inst.legs[inst.legs.length-1].row, inst.legs[inst.legs.length-1].col));
        let net = null, half = null;
        if (cathodeNet === groundNet && anodeNet !== groundNet) { net = anodeNet;   half = 'pos'; }
        else if (anodeNet === groundNet && cathodeNet !== groundNet) { net = cathodeNet; half = 'neg'; }
        else continue; // not a shunt-to-ground clipper; leave it to the walk as a series hop

        const entry = clampsByNet.get(net) || { pos: Infinity, neg: Infinity, posSoftness: 0, negSoftness: 0 };
        // Softness travels WITH the threshold it belongs to — "lowest Vf
        // wins" (the comment above) means the winning component is also the
        // one whose knee shape should be heard, not some other instance
        // sharing the net. led.json's color_map.knee_softness is the only
        // current source (see its own comment for the ideality-factor
        // physics and why it's deliberately modest); a plain diode/Zener
        // contributes 0 (sharp knee), matching this app's existing
        // silicon/germanium/Zener clip behavior exactly as it was before
        // this change — this only ever SOFTENS an LED's own clamp, it never
        // changes anything about a circuit with no LEDs in it.
        const softness = (bt === 'led') ? (def.color_map?.[inst.props.color]?.knee_softness || 0) : 0;
        if (bt === 'zener_diode') {
          // Unlike a plain diode/LED (which only ever conducts, and so only
          // ever clamps, ONE direction), a single Zener clamps BOTH halves
          // asymmetrically: it hard-limits at Vz on whichever half puts it
          // into reverse breakdown, and soft-limits at its own forward drop
          // on the other half — the same junction-orientation logic as the
          // diode case above, just contributing to both `entry.pos` and
          // `entry.neg` from one instance instead of only one of them. This
          // is a real, common circuit (a single-Zener asymmetric clipper),
          // not a hypothetical — worth getting right rather than only
          // modeling the breakdown side.
          const vz = zenerVoltage(inst, def);
          if (half === 'pos') { entry.pos = Math.min(entry.pos, ZENER_VF); entry.neg = Math.min(entry.neg, vz); }
          else                { entry.neg = Math.min(entry.neg, ZENER_VF); entry.pos = Math.min(entry.pos, vz); }
        } else {
          const vf = forwardVoltage(inst, def);
          if (vf < entry[half]) { entry[half] = vf; entry[half+'Softness'] = softness; }
        }
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
      sh.oversample = CLIP_OVERSAMPLE;
      sh.curve = makeClipCurve(toUnits(clamp.pos), toUnits(clamp.neg), clamp.posSoftness, clamp.negSoftness);
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
    // Tracks which of an instance's signalLegPairs indices have ALREADY been
    // built, across different frontier-net passes — an instance only joins
    // `used` once every pair it offers has been built, not after the FIRST
    // pass that matches any one of them. Needed for any component whose two
    // pairs can be reached from two genuinely different, independently-
    // arriving nets (a two-source blend pot: dry reaches CCW on one pass,
    // wet reaches CW on a LATER pass, once something upstream of it has
    // built that far). Marking `used` after the dry-only pass, as this loop
    // used to, permanently discarded the wet hop the moment its net became
    // reachable — found on a real PT2399 mix-pot circuit where the wet path
    // was built, fed, and never reached the output, the same "stage exists
    // but isn't reachable" failure class as the Electra Distortion bug this
    // file's own history already documents, just via a different mechanism.
    const builtPairIdx = new Map(); // instanceId -> Set of pair indices already built

    while (frontier.length && stageCount < MAX_STAGES) {
      const net = frontier.shift();
      if (isAcGround(net)) continue; // an AC ground is a valid destination, never a valid source of further hops — see note above traceSignalPath
      const entryBus = busOut(net); // leaving this net, so post-clamp

      for (const inst of placed) {
        if (inst.failed || used.has(inst.instanceId)) continue;
        const def = ComponentRegistry.getById(inst.defId);
        if (!def) continue;
        const pairs = signalLegPairs(inst, def);
        const doneIdx = builtPairIdx.get(inst.instanceId) || new Set();
        // Every pair that touches the net being expanded gets its own
        // stage, not just the first match. A potentiometer's wiper
        // genuinely feeds BOTH outer legs at once in a real circuit; a
        // JFET/MOSFET's gate genuinely controls current at BOTH the source
        // AND the drain simultaneously (Id modulates both terminals, that's
        // what "3-terminal device" means electrically). Taking only the
        // first match and marking the instance used stalled the walk one
        // hop short of the output on a real common-source stage (Tillman
        // Boost): signalLegPairs offers gate->source before gate->drain,
        // the walk expanded from the gate, matched gate->source first,
        // and Q1 was marked used before gate->drain ever got a chance —
        // so the amplified drain signal, the actual output, was never
        // built at all. Building every match fixes that without needing
        // to guess a "right" pair order per topology.
        // A two-source blend pot's wiper net is always a SINK for this
        // component (both outer arms conduct TOWARD the wiper), never a
        // source to hop back out through — unlike a normal volume/tone/fuzz
        // pot, where the wiper net becoming a frontier item is exactly how
        // its output correctly continues to the next stage. Detected the
        // same structural way buildAudioStage does (the pot's OTHER outer
        // leg, from whichever leg the wiper reached, is neither AC ground
        // nor the supply rail — a real single-source pot always grounds or
        // biases its unused outer leg). Computed once per instance per pass,
        // from the pot's own real leg nets, not from entryNet/exitNet (which
        // are hop-direction-dependent and would beg the question).
        // Without this, the wiper net entering the frontier (correctly, from
        // the FIRST arm reaching it) let the walk treat the wiper as a new
        // expansion point and hop BACKWARD through the second arm (wiper->
        // CW instead of the real wet-signal CW->wiper direction) — found on
        // a real PT2399 mix-pot circuit, where this backward hop silently
        // consumed the pair slot the genuine wet->wiper hop needed, so the
        // delayed signal never reached Output at all despite the graph
        // otherwise looking complete.
        let wiperIsSinkOnly = false;
        if (def.behavior?.type === 'potentiometer' && inst.legs.length >= 3) {
          const ccwNetChk = nets.find(nets.key(inst.legs[0].row, inst.legs[0].col));
          const wprNetChk = nets.find(nets.key(inst.legs[1].row, inst.legs[1].col));
          const cwNetChk  = nets.find(nets.key(inst.legs[2].row, inst.legs[2].col));
          if (net === wprNetChk) {
            const ccwIsAcGround = ccwNetChk === groundNet || ccwNetChk === supplyNet;
            const cwIsAcGround  = cwNetChk === groundNet || cwNetChk === supplyNet;
            wiperIsSinkOnly = !ccwIsAcGround && !cwIsAcGround;
          }
        }
        for (let pi = 0; pi < pairs.length; pi++) {
          if (doneIdx.has(pi)) continue; // this pair already built on an earlier pass
          const pair = pairs[pi];
          const netA = nets.find(nets.key(pair[0].row, pair[0].col));
          const netB = nets.find(nets.key(pair[1].row, pair[1].col));
          let entryNet = null, otherNet = null;
          if (netA === net && netB !== net) { entryNet = netA; otherNet = netB; }
          else if (netB === net && netA !== net) { entryNet = netB; otherNet = netA; }
          else continue; // this pair doesn't touch the net we're expanding from
          if (wiperIsSinkOnly) continue; // see the wiperIsSinkOnly comment above — don't hop backward out through a blend pot's wiper
          doneIdx.add(pi);

          const built = buildAudioStage(ctx, inst, def, nets, placed, entryNet, otherNet, groundNet, supplyNet,
            inputNet, outputNet, sourceImpedance, loadImpedance);
          const exitBus = busIn(otherNet); // arriving at the far net, so pre-clamp
          if (built) {
            entryBus.connect(built.in);
            // A stage may be more than two nodes (a transistor is pre-gain,
            // shaper, post-gain), and every one of them has to be tracked or
            // stop()/refreshTopology leaks it.
            if (built.nodes) allNodes.push(...built.nodes);
            else { allNodes.push(built.in); if (built.out !== built.in) allNodes.push(built.out); }
            built.out.connect(exitBus);
          } else {
            // no audio-shaping effect (e.g. a lone series resistor, or an
            // LED) — signal passes through unchanged onto the far bus.
            entryBus.connect(exitBus);
          }

          if (!isAcGround(otherNet) && !visitedNets.has(otherNet)) { visitedNets.add(otherNet); frontier.push(otherNet); }
        }
        if (doneIdx.size) {
          builtPairIdx.set(inst.instanceId, doneIdx);
          if (doneIdx.size >= pairs.length) { used.add(inst.instanceId); stageCount++; }
        }
      }
    }

    // Ground still needed a real bus above (so shunt/coupling components had
    // something valid to connect into) but it should never read back as
    // audible — it's the reference, not a signal-carrying node. Overriding
    // the tap to null here means Probe correctly reports silence there,
    // without needing to special-case every place a component might route
    // to ground.
    if (groundNet != null) netTaps.set(groundNet, null);
    if (supplyNet != null) netTaps.set(supplyNet, null);

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
      case 'resistor': case 'capacitor': case 'diode': case 'led': case 'zener_diode':
        return inst.legs.length >= 2 ? [[inst.legs[0], inst.legs[inst.legs.length-1]]] : [];
      case 'potentiometer':
        return inst.legs.length >= 3 ? [[inst.legs[1], inst.legs[0]], [inst.legs[1], inst.legs[2]]] : []; // wiper <-> either outer leg
      case 'bjt_npn': case 'bjt_pnp': {
        if (inst.legs.length < 3) return [];
        const eIdx = (inst.props.pinout === 'CBE') ? 2 : 0;
        const cIdx = eIdx === 0 ? 2 : 0;
        return [[inst.legs[1], inst.legs[cIdx]]]; // base -> collector
      }
      case 'jfet_n': case 'mosfet_n': {
        // Gate draws no DC current, so unlike a BJT the gate itself never
        // carries the traced signal onward on its own — the walk has to
        // hop gate->source (a follower) or gate->drain (common-source).
        // Offering BOTH pairs and letting the walk's own net-matching pick
        // whichever one actually touches the net being expanded from is
        // the same pattern the potentiometer case already uses (wiper <->
        // either outer leg): the walk tries each pair, keeps the one whose
        // entryNet matches, and buildAudioStage below reads the real
        // gain/orientation off the small-signal solve rather than assuming
        // which topology this device is wired as.
        if (inst.legs.length < 3) return [];
        const PINOUTS = def.behavior.type === 'jfet_n'
          ? { SGD: [0,1,2], DGS: [2,1,0], GSD: [1,0,2] }   // [sourceIdx, gateIdx, drainIdx]
          : { DGS: [2,1,0], SGD: [0,1,2] };
        const fallback = def.behavior.type === 'jfet_n' ? 'SGD' : 'DGS';
        const [sIdx, gIdx, dIdx] = PINOUTS[inst.props.pinout] || PINOUTS[fallback];
        return [[inst.legs[gIdx], inst.legs[sIdx]], [inst.legs[gIdx], inst.legs[dIdx]]];
      }
      case 'opamp_dual': {
        // Same "offer every hop this device could plausibly be wired as,
        // let the walk's own net-matching pick whichever one actually
        // touches the expanding net" pattern as the JFET/MOSFET case above.
        // Legs per opamp.json: [1OUT,1IN-,1IN+,VCC-,2IN+,2IN-,2OUT,VCC+].
        // Both inputs of both units are offered — a real circuit only ever
        // has ONE of these four actually wired into the signal path (the
        // other input goes to a bias/feedback network instead), and the
        // walk's existing net-matching already handles that ambiguity for
        // JFET/MOSFET without needing to know which topology it is ahead of
        // time.
        if (inst.legs.length < 8) return [];
        return [
          [inst.legs[2], inst.legs[0]], // unit 0: 1IN+ -> 1OUT
          [inst.legs[1], inst.legs[0]], // unit 0: 1IN- -> 1OUT
          [inst.legs[4], inst.legs[6]], // unit 1: 2IN+ -> 2OUT
          [inst.legs[5], inst.legs[6]], // unit 1: 2IN- -> 2OUT
        ];
      }
      case 'pt2399_delay': {
        // One hop, OP1-IN -> OP2-OUT: a real PT2399 pedal circuit's signal
        // enters at OP1's input (leg 9) and the delayed/dry-mixed result
        // exits at OP2's output (leg 11) — see pt2399.json's leg_labels for
        // the full real pinout. Unlike opamp_dual, there's only one real
        // signal path through this chip (no separate inverting/non-inverting
        // ambiguity to offer both sides of), since OP1/OP2 aren't a matched
        // differential pair the user wires arbitrarily — they're the fixed
        // input/output stages of one internal delay line.
        if (inst.legs.length < 16) return [];
        return [[inst.legs[9], inst.legs[11]]]; // OP1-IN -> OP2-OUT
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

  // Real resistance wired to a specific net, from a plain resistor or a
  // potentiometer — used for the PT2399's VCO pin, where the delay time is
  // set by whatever the user actually wired there, not a hardcoded knob
  // value. Unlike acLoadResistance, this does NOT require the far leg to
  // reach AC ground: VCO's timing resistor is read for its own value, not as
  // a loading term on some other net.
  //
  // A pot's EFFECTIVE resistance depends on how it's wired, and getting this
  // wrong makes the knob silently inert — a real bug caught while laying out
  // the PT2399 demo circuit, not a hypothetical: the first version of this
  // function always returned the pot's full nameplate value no matter the
  // wiper position, which is only correct for the "used as a plain 2-
  // terminal resistor" case (CCW-to-CW, wiper unused). The standard way to
  // make a TIMING pot sweepable is a rheostat: the wiper shorted to one
  // outer leg, so only the wiper-to-far-end track segment is actually in
  // circuit, and that segment's length genuinely depends on wiper position.
  // Three real wiring shapes, distinguished by which legs touch `net`:
  //  - wiper AND one outer leg both touch net (rheostat) -> the effective
  //    resistance is the OTHER (non-shorted) segment: Rt*(1-wiper) if CCW is
  //    shorted to the wiper, Rt*wiper if CW is shorted to the wiper.
  //  - only ONE outer leg touches net, wiper does not -> plain 2-terminal
  //    use, full Rt (matches a plain resistor's behavior).
  //  - only the wiper touches net (no outer leg) -> genuinely ambiguous
  //    without a second net reference, same convention as the full Rt case.
  // Returns null (not 0) when nothing recognizable is found, so callers can
  // tell "no timing component wired" apart from "wired at zero ohms."
  function resistorOnNet(net, nets, placed, skipInstanceId) {
    if (net == null) return null;
    const netOf = (row, col) => nets.find(nets.key(row, col));
    for (const p of placed) {
      if (p.failed || p.instanceId === skipInstanceId) continue;
      const def = ComponentRegistry.getById(p.defId);
      const bt = def?.behavior?.type;
      if (bt === 'resistor' && p.legs.length >= 2) {
        const a = netOf(p.legs[0].row, p.legs[0].col);
        const b = netOf(p.legs[p.legs.length-1].row, p.legs[p.legs.length-1].col);
        if (a === net || b === net) {
          const R = resolvedValue(p, 'resistance', 0);
          if (R > 0) return R;
        }
      } else if (bt === 'potentiometer' && p.legs.length >= 3) {
        const ccw = netOf(p.legs[0].row, p.legs[0].col);
        const wpr = netOf(p.legs[1].row, p.legs[1].col);
        const cw  = netOf(p.legs[2].row, p.legs[2].col);
        const ccwOnNet = ccw === net, cwOnNet = cw === net, wprOnNet = wpr === net;
        if (!ccwOnNet && !cwOnNet && !wprOnNet) continue;
        const Rt = resolvedValue(p, 'resistance', 0);
        if (Rt <= 0) continue;
        const parsedWiper = parseFloat(p.props.wiper);
        const wiper = Number.isNaN(parsedWiper) ? 0.5 : parsedWiper;
        if (wprOnNet && ccwOnNet && !cwOnNet) return Rt * (1 - wiper); // rheostat, CCW shorted to wiper
        if (wprOnNet && cwOnNet && !ccwOnNet) return Rt * wiper;       // rheostat, CW shorted to wiper
        return Rt; // plain 2-terminal use, or wiper-only with no outer-leg reference
      }
    }
    return null;
  }

  // A repeats/feedback knob is a potentiometer wired as a variable divider:
  // one outer leg on the wet (delayed) net, the other reaching back toward
  // the dry input net, wiper fraction sets how much returns. Finds that pot
  // and returns its real solved wiper fraction (0-1) directly — same "the
  // pot IS the control, modelled once" philosophy as every other pot in this
  // app, deliberately not a resistance-derived formula (a repeats pot's
  // RESISTANCE isn't what sets the amount, its wiper POSITION is). Depth-1
  // only: the far outer leg either lands directly on toNet, or reaches it
  // through exactly one more resistor — covers the common "pot output ->
  // series resistor -> op-amp input" shape without open-ended recursion for
  // a control this simple. Returns null when nothing recognizable is wired,
  // so "no feedback pot" reads as null (zero repeats), not a guessed default.
  function feedbackWiperFraction(fromNet, toNet, nets, placed, skipInstanceId) {
    if (fromNet == null || toNet == null) return null;
    const netOf = (row, col) => nets.find(nets.key(row, col));
    const reachesToNet = net => {
      if (net === toNet) return true;
      for (const p of placed) {
        if (p.failed || p.instanceId === skipInstanceId) continue;
        const def = ComponentRegistry.getById(p.defId);
        if (def?.behavior?.type !== 'resistor' || p.legs.length < 2) continue;
        const a = netOf(p.legs[0].row, p.legs[0].col);
        const b = netOf(p.legs[p.legs.length-1].row, p.legs[p.legs.length-1].col);
        if ((a === net && b === toNet) || (b === net && a === toNet)) return true;
      }
      return false;
    };
    for (const p of placed) {
      if (p.failed || p.instanceId === skipInstanceId || p.legs.length < 3) continue;
      const def = ComponentRegistry.getById(p.defId);
      if (def?.behavior?.type !== 'potentiometer') continue;
      const ccw = netOf(p.legs[0].row, p.legs[0].col);
      const cw  = netOf(p.legs[2].row, p.legs[2].col);
      const farLeg = (ccw === fromNet) ? cw : (cw === fromNet) ? ccw : null;
      if (farLeg == null || !reachesToNet(farLeg)) continue;
      const parsedWiper = parseFloat(p.props.wiper);
      return Number.isNaN(parsedWiper) ? 0.5 : parsedWiper;
    }
    return null;
  }

  // Resistance from a net to AC ground, used to give a coupling capacitor its
  // REAL corner frequency instead of a hardcoded guess.
  //
  // "AC ground" is the ground rail OR the supply rail, because a supply is a
  // low impedance at signal frequencies: a collector resistor to V+ loads a
  // node exactly as one to ground would.
  //
  // Handles the shapes that actually set a coupling cap's load in pedal
  // circuits, combined in parallel:
  //   - a resistor from the net to AC ground
  //   - a pot with one outer leg on the net and the other on AC ground (a
  //     volume or tone pot presents its whole track to whatever feeds it)
  //   - a transistor base on the net, input impedance ~ hFE*(re + Re)
  //
  // Returns null when it recognises nothing, so the caller can fall back
  // VISIBLY rather than silently pretending it knew. That distinction matters:
  // findEmitterResistance's silent zero for unrecognised topologies cost a
  // full debugging session on a real circuit.
  function acLoadResistance(net, nets, placed, groundNet, supplyNet, skipInstanceId, depth = 0) {
    if (net == null) return null;
    const acGrounds = new Set([groundNet, supplyNet].filter(n => n != null));
    if (!acGrounds.size) return null;
    const netOf = (row, col) => nets.find(nets.key(row, col));
    const conductances = [];

    for (const p of placed) {
      if (p.failed || p.instanceId === skipInstanceId) continue;
      const def = ComponentRegistry.getById(p.defId);
      const bt  = def?.behavior?.type;

      if (bt === 'resistor' && p.legs.length >= 2) {
        const a = netOf(p.legs[0].row, p.legs[0].col);
        const b = netOf(p.legs[p.legs.length-1].row, p.legs[p.legs.length-1].col);
        const far = (a === net) ? b : (b === net) ? a : null;
        if (far != null && acGrounds.has(far)) {
          const R = resolvedValue(p, 'resistance', 0);
          if (R > 0) conductances.push(1 / R);
        }

      } else if (bt === 'potentiometer' && p.legs.length >= 3) {
        const ccw = netOf(p.legs[0].row, p.legs[0].col);
        const cw  = netOf(p.legs[2].row, p.legs[2].col);
        const far = (ccw === net) ? cw : (cw === net) ? ccw : null;
        if (far != null && acGrounds.has(far)) {
          const Rt = resolvedValue(p, 'resistance', 0);
          if (Rt > 0) conductances.push(1 / Rt);
        }

      } else if ((bt === 'bjt_npn' || bt === 'bjt_pnp') && p.legs.length >= 3) {
        const baseNet = netOf(p.legs[1].row, p.legs[1].col);
        if (baseNet !== net) continue;
        const eIdx = (p.props.pinout === 'CBE') ? 2 : 0;
        const emitterNet = netOf(p.legs[eIdx].row, p.legs[eIdx].col);
        // Emitter impedance via the same general lookup rather than a
        // separate pattern-matcher: whatever resistors or pot tracks actually
        // run from the emitter to AC ground. Depth-guarded because a base can
        // in principle sit on another transistor's emitter net.
        const Re  = depth < 2
          ? (acLoadResistance(emitterNet, nets, placed, groundNet, supplyNet, p.instanceId, depth+1) || 0)
          : 0;
        const Ic  = Math.max(p._current || 0, 1e-6); // same floor as the gain formula
        const re  = 0.026 / Ic;
        const pm  = def.model_params?.[p.props.model] || {};
        const hfe = parseFloat(p.props.hfe) || pm.hfe || 100;
        const Rin = hfe * (re + Re);
        if (Rin > 0) conductances.push(1 / Rin);
      }
    }

    if (!conductances.length) return null;
    return 1 / conductances.reduce((sum, g) => sum + g, 0);
  }

  // findEmitterResistance used to live here. It pattern-matched exactly two
  // emitter topologies and returned 0 for everything else, which was
  // indistinguishable from "this stage genuinely has no emitter resistance"
  // and silently made a real Fuzz Face's Fuzz knob inert. Emitter degeneration
  // now falls out of the small-signal network solve instead, so there is
  // nothing left to pattern-match. Don't reintroduce it.

  // Finds the real -3dB corner frequency of a single-pole coupling/shunt
  // stage by actually solving the network (Simulation.solveAcNetwork, item 8)
  // at a handful of frequencies and bisecting toward the point where the
  // magnitude has genuinely dropped 3dB from its passband value — rather
  // than acLoadResistance's pattern-matched R feeding fc=1/(2piRC). This is
  // additive infrastructure: NOT wired into buildAudioStage yet (see
  // CLAUDE.md Open work item 8 for the current status and what remains).
  //
  // isHighpass tells the search which direction is "passband": true means
  // low frequencies are attenuated and the reference point is taken HIGH
  // (a coupling cap); false means high frequencies are attenuated and the
  // reference is taken LOW (a resistor's shunt cap to ground).
  //
  // Bisects in LOG frequency space (corners can span 1Hz-20kHz, four
  // decades, so a linear search would need an impractically fine step or
  // miss the corner entirely) between the passband reference and a point far
  // on the attenuated side, stopping once the bracket is tight enough that
  // the reported fc is accurate to about 1%.
  function findAcCorner(placed, nets, inputNet, acGroundNets, sourceImpedance, outputNet, loadImpedance, measureNet, isHighpass) {
    if (typeof Simulation === 'undefined' || !Simulation.solveAcNetwork) return null;
    const magAt = (freqHz) => {
      const res = Simulation.solveAcNetwork(placed, nets, inputNet, acGroundNets, freqHz, sourceImpedance, outputNet, loadImpedance);
      if (!res) return null;
      const v = res.get(measureNet);
      if (!v || !Number.isFinite(v.re) || !Number.isFinite(v.im)) return null;
      return Math.hypot(v.re, v.im);
    };

    // Passband reference: far enough from any plausible corner (four
    // decades either side of the audio band) that a single-pole response is
    // essentially flat there.
    const passbandFreq = isHighpass ? 200000 : 0.02;
    const passbandMag = magAt(passbandFreq);
    if (passbandMag == null || passbandMag < 1e-9) return null; // no signal reaches this net at all — not this function's problem to diagnose

    const target = passbandMag / Math.SQRT2; // -3dB point

    // Bracket: passband side vs. a point far on the attenuated side. If even
    // the far point hasn't dropped below target, the corner (if any) sits
    // outside the audio-relevant range — not an error, just nothing to find.
    let lo = isHighpass ? 0.02 : passbandFreq === 0.02 ? 200000 : 200000; // lo = attenuated-side bound
    let hi = passbandFreq;
    if (isHighpass) { lo = 0.02; hi = passbandFreq; } else { lo = passbandFreq; hi = 200000; }
    const loMag = magAt(lo);
    if (loMag == null) return null;
    // Normalize so `hi` is always the passband side and `lo` the attenuated
    // side for the bisection below, regardless of highpass/lowpass.
    let attenuatedFreq = isHighpass ? lo : hi;
    let passFreq = isHighpass ? hi : lo;
    const attenuatedMag = isHighpass ? loMag : magAt(hi);
    if (attenuatedMag == null || attenuatedMag >= target) return null; // never actually crosses -3dB in range

    // Bisect in log space for ~24 iterations — more than enough for four
    // decades of range to converge to well under 1% of the true corner.
    let a = Math.log10(Math.min(attenuatedFreq, passFreq));
    let b = Math.log10(Math.max(attenuatedFreq, passFreq));
    // a is always the attenuated side, b the passband side, in log space
    // ordered so `attenuatedMag < target < passbandMag`.
    if (attenuatedFreq > passFreq) { const t = a; a = b; b = t; }
    for (let i = 0; i < 24; i++) {
      const mid = (a + b) / 2;
      const midMag = magAt(Math.pow(10, mid));
      if (midMag == null) return null;
      if (midMag < target) a = mid; else b = mid; // move the attenuated-side bound toward the crossing
    }
    return Math.pow(10, (a + b) / 2);
  }

  // Voltage gain between two nets, taken straight from simulation.js's
  // small-signal solve. Every node in that solve carries its gain relative to
  // a 1V input drive, so the ratio between two nodes IS the gain of whatever
  // sits between them, INCLUDING the effect of feedback, loading, and every
  // surrounding component. Returns null when the solve isn't available or the
  // input node carries no signal, so callers fall back visibly.
  //
  // This replaces a family of per-component formulas (gm*Rc with an emitter
  // term found by pattern-matching, a pot's gain assumed to be its wiper
  // fraction) with one network-derived number. A potentiometer in particular
  // is now modelled exactly once, in the solver, as two resistors and a tap —
  // whether it behaves as a volume, tone or fuzz control is decided by what
  // it's wired to, not by a rule keyed on its use case.
  function netGain(fromNet, toNet) {
    if (typeof Simulation === 'undefined' || !Simulation.getSmallSignalV) return null;
    const ss = Simulation.getSmallSignalV();
    if (!ss) return null;
    const vFrom = ss.get(fromNet), vTo = ss.get(toNet);
    if (!Number.isFinite(vFrom) || !Number.isFinite(vTo)) return null;
    if (Math.abs(vFrom) < 1e-12) return null; // nothing arriving here to amplify
    return Math.abs(vTo / vFrom);
  }

  // Small-signal gain for a transistor stage, plus its clipping headroom.
  //
  // The gain comes from the network solve (see netGain), so emitter
  // degeneration, collector loading and any feedback loop around the stage are
  // all included automatically rather than being reconstructed here. The
  // fallback is the old gm*Rc estimate, used only when the solve is
  // unavailable, and it warns rather than substituting silently.
  //
  // Shared by buildAudioStage (once, at Play) and updateLiveGains (every
  // Simulation tick), so the two can't drift apart.
  let _warnedNoSmallSignal = false;
  function computeBjtGainAndHeadroom(inst, def, nets, placed, groundNet) {
    const eIdx = (inst.props.pinout === 'CBE') ? 2 : 0;
    const cIdx = eIdx === 0 ? 2 : 0;
    const Ic = Math.max(inst._current || 0, 1e-6); // floor avoids a divide-by-near-zero cliff when barely biased
    const Vt = 0.026; // thermal voltage at room temperature
    const emitterLeg = inst.legs[eIdx];
    const emitterNet = nets.find(nets.key(emitterLeg.row, emitterLeg.col));
    const collectorLeg = inst.legs[cIdx];
    const collectorNet = nets.find(nets.key(collectorLeg.row, collectorLeg.col));
    const baseNet = nets.find(nets.key(inst.legs[1].row, inst.legs[1].col));

    const solved = netGain(baseNet, collectorNet);
    if (solved != null) return finishBjt(solved, inst);

    if (!_warnedNoSmallSignal) {
      _warnedNoSmallSignal = true;
      console.warn('[Audio] Small-signal solve unavailable; transistor gains are falling back ' +
                   'to a gm*Rc estimate that ignores feedback and loading.');
    }
    const Rc = placed.find(p => p.defId==='resistor' && !p.failed &&
      p.legs.some(l => nets.find(nets.key(l.row, l.col)) === collectorNet));
    const RcValue = Rc ? resolvedValue(Rc, 'resistance', 10000) : 10000; // no collector resistor found -> reasonable fallback load
    const gm = Ic / Vt;
    const re = 1 / gm; // transistor's own intrinsic emitter resistance
    return finishBjt(RcValue / re, inst); // no emitter term available in the fallback
  }

  // Knee + headroom, shared by both paths above so they can't diverge.
  function finishBjt(rawGain, inst) {
    // A bare common-emitter stage's raw gm*Rc easily lands in the tens to
    // hundreds for realistic bias points and Rc values, and a hard clamp made
    // every model whose raw gain cleared ~25 sound identical. A soft knee
    // keeps the range differentiated instead of flatlining past a threshold.
    //
    // kneePoint MUST equal maxGain. `M*raw/(raw+K)` reduces to `(M/K)*raw` for
    // small raw, so any K != M applies a CONSTANT SCALING ERROR to every
    // stage's true gain. This sat at K=400 for a long time, an M/K of 0.0875,
    // meaning an 11.4x attenuation of every circuit in the app: an Electra
    // Distortion stage with a genuine voltage gain of 52 arrived as 4.06, so
    // its clipping diodes saw 22dB less drive than the real circuit delivers
    // and the pedal barely distorted at normal playing levels (measured: 0.4%
    // THD at an input amplitude of 0.05, against 8.5% once corrected).
    //
    // K=400 was originally chosen to spread a Fuzz Face's 200-800 raw range
    // across ~6dB of differentiation, which K=maxGain narrows to ~1dB. That
    // differentiation was being bought by attenuating every circuit 11x, and
    // measurement showed it is largely erased by saturation anyway: THD lands
    // at ~41% at normal input levels under every candidate formula.
    //
    // The real cost is the Fuzz Face's cleanup — with accurate gain it
    // saturates at essentially any input level. That is correct for the
    // circuit. A real Fuzz Face's cleanup comes from rolling the guitar
    // volume, which raises source impedance and reduces gain through input
    // loading: an IMPEDANCE effect (open items 4 and 5), not something this
    // curve should be faking by attenuating everything.
    const maxGain = 35;
    const kneePoint = maxGain;
    const gain = maxGain * rawGain / (rawGain + kneePoint);

    // Clip thresholds are the stage's REAL output swing in each direction, in
    // volts, from simulation.js's setOutputSwing. The two differ, often by a
    // lot: a starved-bias germanium stage sitting at Vc=0.77V on a 9V supply
    // can only fall ~0.67V before saturating but can rise ~8.2V before hitting
    // the rail, and clipping one way long before the other is where a fuzz's
    // even-harmonic character actually comes from.
    //
    // A common-emitter stage inverts, and netGain returns a magnitude, so our
    // signal is upside down relative to the real collector: OUR positive half
    // corresponds to the collector falling, hence swingDown.
    const V = VOLTS_PER_SIGNAL_UNIT;
    const swingDown = Number.isFinite(inst._swingDown) ? inst._swingDown / V : null;
    const swingUp   = Number.isFinite(inst._swingUp)   ? inst._swingUp   / V : null;
    // Fall back to the old normalized estimate only if the solve didn't run.
    const legacy = Utils.clamp(0.15 + (0.9 - 0.15) * (inst._vceHeadroom ?? 1), 0.15, 0.9);
    const clipPos = swingDown != null ? Math.max(swingDown, 1e-4) : legacy;
    const clipNeg = swingUp   != null ? Math.max(swingUp,   1e-4) : legacy;

    return { gain, clipPos, clipNeg };
  }

  function buildAudioStage(ctx, inst, def, nets, placed, entryNet, exitNet, groundNet, supplyNet,
      inputNet, outputNet, sourceImpedance, loadImpedance) {
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
        // Real fc from the actual network (item 8: findAcCorner solves at
        // several frequencies and bisects to the true -3dB point, feedback
        // and loading included), falling back to the plain RC formula only
        // when the AC solve genuinely can't find a corner (e.g. this stage
        // sits outside the traced path from Input, or the solve is
        // unavailable) — same "derive, warn, fall back" shape the coupling
        // cap case below has used since the acLoadResistance fix.
        const acFc = (inputNet != null)
          ? findAcCorner(placed, nets, inputNet, [groundNet, supplyNet].filter(n=>n!=null),
              sourceImpedance, outputNet, loadImpedance, exitNet, false)
          : null;
        const R = resolvedValue(inst, 'resistance', 10000);
        const C = resolvedValue(cap, 'capacitance', 0.000001);
        const fc = acFc != null ? acFc : 1 / (2 * Math.PI * R * C);
        const f = ctx.createBiquadFilter();
        f.type = 'lowpass'; f.frequency.value = Utils.clamp(fc, 10, 20000); f.Q.value = 0.707;
        return { in: f, out: f };
      }
      case 'potentiometer': {
        // A pot is a pot. Its ratio comes from the network solve, so the same
        // model serves a volume, tone, fuzz, time or repeats control, and its
        // RESISTANCE finally matters (a 10k and a 1M volume pot used to
        // attenuate identically, because this was `gain = wiper fraction` with
        // no resistance term and no knowledge of what the third leg touched).
        //
        // Falls back to the wiper fraction only when the solve is unavailable,
        // which is the classic divider-into-a-high-impedance-load answer and
        // therefore right for a plain volume pot and wrong for everything else.
        const parsedWiper = parseFloat(inst.props.wiper);
        const wiper = Number.isNaN(parsedWiper) ? 0.5 : parsedWiper; // NOT `|| 0.5` — that treats a real, valid wiper of exactly 0 as missing and silently substitutes 0.5
        const pos   = (inst.props.taper||'').includes('Audio') ? Math.pow(wiper,2) : wiper;

        // Two-source blend pot (a dry/wet mix control): BOTH outer legs are
        // independently signal-carrying nets, not "signal in, ground/bias
        // out" like every volume/tone/fuzz pot this model was built around.
        // netGain only ever injects ONE 1V source (Input) into the AC solve,
        // so it has no way to represent a second independent source driving
        // the far outer leg — measured directly on this circuit's Mix pot:
        // both outer legs came back reading ~1.0 relative to Input (no real
        // attenuation, no blend), because the wet/delayed branch simply
        // isn't part of what the AC solve was ever asked to drive.
        //
        // signalLegPairs offers [wiper,CCW] and [wiper,CW] — the walk's own
        // net-matching decides which of entryNet/exitNet ends up being the
        // wiper vs. the outer leg per hop (it's whichever one matches the
        // net currently being expanded from), so this can't assume a fixed
        // role for either parameter; it has to identify the wiper net and
        // the OUTER leg THIS hop is carrying, whichever param each landed in.
        const ccwNet = nets.find(nets.key(inst.legs[0].row, inst.legs[0].col));
        const wprNet = nets.find(nets.key(inst.legs[1].row, inst.legs[1].col));
        const cwNet  = nets.find(nets.key(inst.legs[2].row, inst.legs[2].col));
        const thisOuterNet = (entryNet === ccwNet || exitNet === ccwNet) ? ccwNet
                            : (entryNet === cwNet  || exitNet === cwNet)  ? cwNet : null;
        const otherOuterNet = (thisOuterNet === ccwNet) ? cwNet : (thisOuterNet === cwNet) ? ccwNet : null;
        // Detected structurally: the OTHER outer leg (not this hop's own)
        // is neither AC ground nor the supply rail — a real volume/tone/
        // fuzz pot always grounds or biases its unused outer leg, so a real
        // signal net there is the one thing a two-source blend pot always
        // shows and a normal pot never does.
        const otherIsAcGround = otherOuterNet != null && (otherOuterNet === groundNet || otherOuterNet === supplyNet);
        const isTwoSourceBlend = otherOuterNet != null && !otherIsAcGround;

        let gainValue;
        if (isTwoSourceBlend) {
          // Crossfade weight for THIS hop's own outer leg — (1-pos) for the
          // CCW/dry side, pos for the CW/wet side (matches a real linear-
          // taper pot's physical wiring: wiper position 0 = fully CCW output,
          // 1 = fully CW). Both hops share the SAME wiper net bus (ensureBus
          // is memoized per net), so their two gain-scaled contributions
          // genuinely sum there — no separate merge step needed.
          gainValue = (thisOuterNet === ccwNet) ? (1 - pos) : pos;
        } else {
          const solved = netGain(entryNet, exitNet);
          gainValue = solved != null ? solved : pos;
        }
        const g = ctx.createGain();
        g.gain.value = gainValue;
        inst._audioNode = g;
        // Refreshed from the solve every tick, same as transistor stages, so
        // turning the knob moves the real network ratio rather than a
        // fraction — updatePotWiper (see below) needs to know which branch
        // this stage used, so a live wiper change re-derives correctly
        // rather than always re-reading netGain.
        _livePotStages.push({ inst, g, entryNet, exitNet, isTwoSourceBlend, blendIsCcw: thisOuterNet === ccwNet });
        return { in: g, out: g };
      }
      case 'bjt_npn': case 'bjt_pnp': {
        // A WaveShaper's curve only spans [-1,1], but a stage's real swing can
        // be several volts, so the signal is scaled DOWN into the curve's
        // domain and back UP afterwards. `scale` is chosen so the larger of the
        // two thresholds lands at 0.9, which keeps both inside the domain and
        // leaves the linear region intact (the pre- and post-scaling cancel for
        // signals below the knee).
        const { gain, clipPos, clipNeg } = computeBjtGainAndHeadroom(inst, def, nets, placed, groundNet);
        const scale = Math.max(clipPos, clipNeg, 1e-3) / 0.9;
        const pre  = ctx.createGain(); pre.gain.value  = gain / scale;
        const sh   = ctx.createWaveShaper(); sh.oversample = CLIP_OVERSAMPLE;
        sh.curve   = makeClipCurve(clipPos / scale, clipNeg / scale);
        const post = ctx.createGain(); post.gain.value = scale;
        pre.connect(sh); sh.connect(post);
        _liveGainStages.push({ inst, g: pre, sh, post, nets, placed, groundNet });
        return { in: pre, out: post, nodes: [pre, sh, post] };
      }
      case 'jfet_n': case 'mosfet_n': {
        // entryNet is always the gate here (signalLegPairs only offers
        // gate->source and gate->drain pairs), exitNet is whichever of
        // source/drain the walk actually matched — so gain is simply
        // netGain(gate, exit), no need to re-derive source/drain identity
        // from the pinout here.
        const gain = netGain(entryNet, exitNet);
        // No per-device swing tracking exists yet for JFET/MOSFET (unlike
        // BJT's setOutputSwing) — that's real, unbuilt scope, not something
        // to fake here. Falls back to a simple, SYMMETRIC estimate: how far
        // the exit net's actual DC voltage sits from the nearer of 0V or
        // the supply rail, which at least keeps clipping in the right
        // ballpark instead of clipping at an arbitrary fixed threshold.
        // Found by matching exitNet back to whichever of this instance's
        // OWN legs sits on it — Simulation only exposes voltage by
        // row/col, not by net, so there's no direct net->voltage lookup.
        const exitLeg = inst.legs.find(l => nets.find(nets.key(l.row, l.col)) === exitNet);
        const vExit = (exitLeg && typeof Simulation !== 'undefined' && Simulation.getVoltageAt)
          ? Simulation.getVoltageAt(exitLeg.row, exitLeg.col) : null;
        const supply = (typeof WorkbenchStrip !== 'undefined')
          ? parseFloat(WorkbenchStrip.getPermanentState()?.power?.voltage) : NaN;
        let clip = 1;
        if (Number.isFinite(vExit) && Number.isFinite(supply) && supply > 0) {
          clip = Math.max(Math.min(vExit, supply - vExit), 1e-3);
        }
        const scale = Math.max(clip, 1e-3) / 0.9;
        const g  = Number.isFinite(gain) ? gain : 1;
        const pre  = ctx.createGain(); pre.gain.value  = g / scale;
        const sh   = ctx.createWaveShaper(); sh.oversample = CLIP_OVERSAMPLE;
        sh.curve   = makeClipCurve(clip / scale);
        const post = ctx.createGain(); post.gain.value = scale;
        pre.connect(sh); sh.connect(post);
        return { in: pre, out: post, nodes: [pre, sh, post] };
      }
      case 'opamp_dual': {
        // Same net-gain-from-the-real-solve pattern as potentiometer/JFET/
        // MOSFET above — entryNet is whichever input (IN+ or IN-) the walk
        // actually matched, exitNet is that unit's OUT net, so netGain()
        // already returns the real solved gain (verified against the AC
        // solve in simulation.js) without needing to know inverting vs
        // non-inverting here.
        const gain = netGain(entryNet, exitNet);
        // Real asymmetric rail distance, the same idea as a BJT's
        // setOutputSwing (real volts to each rail, not a symmetric guess),
        // computed here rather than read from the DC solve because
        // audio-engine has no access to simulation.js's per-unit clamp
        // state beyond inst._opampState (which unit is saturated), not the
        // actual swing-to-rail distance in volts.
        const exitLeg = inst.legs.find(l => nets.find(nets.key(l.row, l.col)) === exitNet);
        const vOut = (exitLeg && typeof Simulation !== 'undefined' && Simulation.getVoltageAt)
          ? Simulation.getVoltageAt(exitLeg.row, exitLeg.col) : null;
        const supplyV = (typeof WorkbenchStrip !== 'undefined')
          ? parseFloat(WorkbenchStrip.getPermanentState()?.power?.voltage) : NaN;
        const mk = inst.props.model || 'JRC4558';
        const pm = def.model_params?.[mk] || {};
        // See simulation.js's matching split for why low/high headroom differ
        // (e.g. LM358 swings near ground but not near V+) — same fallback
        // shape here so JRC4558/TL072 clip identically to before the split.
        const headroomLo = pm.output_swing_headroom_lo ?? pm.output_swing_headroom ?? 1.5;
        const headroomHi = pm.output_swing_headroom_hi ?? pm.output_swing_headroom ?? 1.5;
        let clipUp = 1, clipDown = 1;
        if (Number.isFinite(vOut) && Number.isFinite(supplyV) && supplyV > 0) {
          clipUp   = Math.max((supplyV - headroomHi) - vOut, 1e-3);
          clipDown = Math.max(vOut - headroomLo, 1e-3);
        }
        const scale = Math.max(clipUp, clipDown, 1e-3) / 0.9;
        const g = Number.isFinite(gain) ? gain : 1;
        const pre  = ctx.createGain(); pre.gain.value  = g / scale;
        const sh   = ctx.createWaveShaper(); sh.oversample = CLIP_OVERSAMPLE;
        sh.curve   = makeClipCurve(clipUp / scale, clipDown / scale);
        const post = ctx.createGain(); post.gain.value = scale;
        pre.connect(sh); sh.connect(post);
        return { in: pre, out: post, nodes: [pre, sh, post] };
      }
      case 'pt2399_delay': {
        // Real Web Audio delay line + feedback loop, not a gain/clip stage —
        // this chip's whole job is a time-domain effect the existing
        // gain-node/WaveShaper vocabulary can't express (see CLAUDE.md's
        // scoping note on this component). Delay TIME comes from the VCO
        // pin's real wired resistance (pin 6, leg index 5), same "read the
        // actual netlist, don't hardcode a knob value" philosophy as every
        // other derived parameter in this engine. Repeats/feedback amount
        // comes from whatever resistor or pot the user wires from OP2-OUT
        // back toward OP1-IN — a real PT2399 pedal has no dedicated feedback
        // pin, that mixing is always external, so reading it from the real
        // wiring (or getting zero repeats if nothing is wired that way) is
        // the electrically honest choice, not a fixed default.
        const vcoNet = nets.find(nets.key(inst.legs[5].row, inst.legs[5].col));
        const vcoR = resistorOnNet(vcoNet, nets, placed, inst.instanceId);
        // Linear map through the one real datasheet anchor (20k ohm =~
        // 270ms) — flagged as a calibration approximation, same honesty
        // standard as VOLTS_PER_SIGNAL_UNIT elsewhere in this file, since
        // the datasheet gives one point, not a curve. Clamped to a sane
        // range so a missing/zero-ohm VCO net (nothing wired, or a dead
        // short) doesn't produce a broken or silent delay time.
        const PT2399_MS_PER_OHM = 270 / 20000;
        const delayMs = vcoR != null ? Utils.clamp(vcoR * PT2399_MS_PER_OHM, 20, 800) : 270;
        const delaySec = delayMs / 1000;

        const delay = ctx.createDelay(1); // 1s max — comfortably above the 800ms clamp above
        delay.delayTime.value = delaySec;

        // Feedback: a real repeats knob is a pot wired as a variable
        // divider (its WIPER position sets how much wet signal returns to
        // the input), not a fixed resistor whose raw value alone would set
        // it — same "read the network's real solved position" philosophy
        // every other pot in this app already uses (volume/tone/fuzz all
        // work this way; a resistance-to-gain formula would have been the
        // one exception with no real basis). If a pot has one outer leg on
        // OP2-OUT's net (this stage's own exit net) and the other outer leg
        // reaches back toward OP1-IN's net (entryNet), its real wiper
        // fraction (0-1) IS the feedback amount. Clamped below 1 so a pot
        // run to its extreme can't create true runaway self-oscillation in
        // the audio graph (a real PT2399 repeat-to-infinity does self-
        // oscillate, but an uncapped feedback>=1 DelayNode loop grows
        // without bound in Web Audio, which is a rendering hazard, not a
        // faithful "it squeals" — 0.92 leaves genuine near-infinite-repeat
        // territory audible without divergence).
        const fbWiper = feedbackWiperFraction(exitNet, entryNet, nets, placed, inst.instanceId);
        const feedbackGain = ctx.createGain();
        // No wired feedback pot -> genuinely zero repeats, not a guessed
        // default: a real PT2399 with nothing feeding OP2 back to OP1 just
        // plays the single delayed copy once.
        feedbackGain.gain.value = fbWiper != null ? Utils.clamp(fbWiper, 0, 0.92) : 0;

        delay.connect(feedbackGain);
        feedbackGain.connect(delay);

        return { in: delay, out: delay, nodes: [delay, feedbackGain] };
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
        const sh = ctx.createWaveShaper(); sh.oversample = CLIP_OVERSAMPLE;
        sh.curve = makeClipCurve(threshold);
        return { in: sh, out: sh };
      }
      case 'zener_diode': {
        // Unusual wiring (a Zener's normal role is the shunt-clamp case
        // above, handled entirely separately before the graph walk even
        // reaches here) but not invalid — if one ends up traced as an
        // in-series stage, it should still clip at whatever its actual
        // solved operating point says rather than silently falling through
        // to buildAudioStage's generic default case (no clipping at all).
        // `_zenerState`/`_current` are set by the same DC pass as every
        // other component here (see simulation.js's zener_diode case).
        const mk = inst.props.model || '1N4742A';
        const pm = def.model_params?.[mk] || {};
        const vz = zenerVoltage(inst, def);
        const izmA = (pm.izm_ma || 150) / 1000;
        const drive = Utils.clamp((inst._current || 0) / izmA, 0, 1);
        // Clamped: threshold is Vz itself (scaled into the shaper's usable
        // range below), same "harder-driven clips a bit sooner" softening
        // as the plain diode case. Forward/off: same representative
        // forward-drop threshold used throughout the zener_diode model.
        const threshold = inst._zenerState === 'clamped'
          ? Math.max(vz * (1 - drive*0.1), 0.5)
          : Utils.clamp(ZENER_VF - drive*0.15, 0.15, ZENER_VF);
        // A signal-diode threshold fits directly in the WaveShaper's [-1,1]
        // domain (fractions of a volt), but Vz can be several volts (up to
        // 12V for the parts this app ships) — same pre/post-scale pattern
        // the transistor case above uses for exactly this reason.
        const scale = Math.max(threshold, 1e-3) / 0.9;
        const pre  = ctx.createGain(); pre.gain.value = 1 / scale;
        const sh   = ctx.createWaveShaper(); sh.oversample = CLIP_OVERSAMPLE;
        sh.curve   = makeClipCurve(threshold / scale);
        const post = ctx.createGain(); post.gain.value = scale;
        pre.connect(sh); sh.connect(post);
        return { in: pre, out: post, nodes: [pre, sh, post] };
      }
      case 'capacitor': {
        // A capacitor actually IN the traced series path (as opposed to
        // shunting to ground off a resistor, handled above) is a coupling
        // cap: a highpass whose corner is set by C and the total series
        // resistance around it, which is the source impedance on one side
        // plus the load impedance on the other.
        //
        // Both are now derived from the netlist. This used to use a hardcoded
        // 10k, which was wrong by up to 50x on real circuits: a Fuzz Face's
        // 10nF into its 500k volume pot was modelled at 1592Hz when the real
        // corner is ~32Hz, so the filter was removing every fundamental a
        // guitar produces (open low E is 82Hz) and passing only harmonics.
        // That is almost certainly the long-standing "lacks low-end
        // heaviness" complaint, which had been attributed to unmodelled
        // input/output impedance instead.
        const C = resolvedValue(inst, 'capacitance', 0.000001);
        // Real fc from the actual network (item 8), same as the lowpass
        // case above — findAcCorner solves the whole traced circuit
        // (feedback, loading, AND now Input's source impedance / Output's
        // load impedance, which acLoadResistance structurally can't see at
        // all) and bisects to the true -3dB point, rather than
        // acLoadResistance's 3-shape pattern match. Falls back to the old
        // path only when the AC solve can't find a corner in-band.
        const acFc = (inputNet != null)
          ? findAcCorner(placed, nets, inputNet, [groundNet, supplyNet].filter(n=>n!=null),
              sourceImpedance, outputNet, loadImpedance, exitNet, true)
          : null;

        let fc;
        if (acFc != null) {
          fc = acFc;
        } else {
          const rSrc  = acLoadResistance(entryNet, nets, placed, groundNet, supplyNet, inst.instanceId);
          const rLoad = acLoadResistance(exitNet,  nets, placed, groundNet, supplyNet, inst.instanceId);
          let R;
          if (rSrc == null && rLoad == null) {
            // Nothing recognisable on either side, and the real AC solve
            // couldn't find a corner either. Warn rather than silently
            // substituting a number and presenting the result as if it
            // meant something.
            R = CAP_REFERENCE_FALLBACK_R;
            console.warn(`[Audio] Coupling cap ${inst.props?.title || inst.instanceId}: ` +
              `couldn't derive a load impedance from the netlist, falling back to ` +
              `${CAP_REFERENCE_FALLBACK_R}Ω — its corner frequency is a guess.`);
          } else {
            R = (rSrc || 0) + (rLoad || 0);
          }
          fc = 1 / (2 * Math.PI * Math.max(R, 1) * C);
        }

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
  // The curve now ASYMPTOTES TO THE THRESHOLD. The previous shape was
  // `t + (1-t)*tanh(...)`, which saturates at 1.0 whatever t is, so t only
  // decided where the knee began and not what the output was limited to. Now
  // that thresholds carry a real voltage meaning (a stage's actual output
  // swing, a diode's actual Vf) the curve has to genuinely limit to them.
  //
  // 4096 points rather than 256: a stage whose swing is several volts needs
  // the pre/post scaling below, and at 256 points a quiet signal would be
  // quantized into a handful of steps.
  // posSoftness/negSoftness (0-1, default 0): widens the tanh transition
  // region without changing what the curve ultimately asymptotes to —
  // dividing the input by (1+softness) before the tanh stretches OUT the
  // knee (reaches the same threshold, just more gradually), which is the
  // standard soft-knee-widening technique and matches what a higher diode
  // "ideality factor" physically does (see led.json's color_map comment for
  // the real semiconductor-physics grounding). Only ever sourced from an
  // LED's per-color knee_softness today (see ensureBus's shunt-clipper
  // code) — every other caller omits these and gets the exact original
  // sharp-tanh shape, so this is additive, not a change to existing
  // circuits with no LEDs in them.
  function makeClipCurve(posThreshold, negThreshold = posThreshold, posSoftness = 0, negSoftness = 0) {
    const n = 4096, curve = new Float32Array(n);
    const shape = (mag, t, softness) => {
      const k = 1 + Math.max(0, softness);
      return t * Math.tanh(mag / (t * k));
    };
    for (let i = 0; i < n; i++) {
      const x = (i * 2) / (n - 1) - 1; // spec's index->x mapping, spans exactly [-1,1]
      const t = Math.max(x >= 0 ? posThreshold : negThreshold, 1e-4);
      const softness = x >= 0 ? posSoftness : negSoftness;
      curve[i] = Math.sign(x) * shape(Math.abs(x), t, softness);
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

  // A Zener's forward drop — used for the SOFT-clamp half of a shunt-Zener's
  // asymmetric clamp (see the shunt-clipper loop). Not per-model in
  // zener_diode.json (see simulation.js's zener_diode case for why: every
  // part in this family sits close to the same ~0.9-1V forward drop, and
  // these parts are essentially never run forward-biased in practice).
  const ZENER_VF = 0.9;

  function zenerVoltage(inst, def) {
    const typed = parseFloat(inst.props.zener_voltage);
    if (Number.isFinite(typed)) return typed;
    return def.model_params?.[inst.props.model]?.vz ?? 12;
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
      const { inst, g, sh, post, nets, placed, groundNet } = stage;
      const def = (typeof ComponentRegistry !== 'undefined') ? ComponentRegistry.getById(inst.defId) : null;
      if (!def) continue;
      const { gain, clipPos, clipNeg } = computeBjtGainAndHeadroom(inst, def, nets, placed, groundNet);
      const scale = Math.max(clipPos, clipNeg, 1e-3) / 0.9;
      // Ramp, don't jump — a hard .value= would click on every 10ms update.
      g.gain.setTargetAtTime(gain / scale, _ctx.currentTime, 0.01);
      if (post) post.gain.setTargetAtTime(scale, _ctx.currentTime, 0.01);
      sh.curve = makeClipCurve(clipPos / scale, clipNeg / scale);
    }
    // Pots too: their ratio is network-derived, so it moves when the knob
    // moves AND when anything around them changes (another pot loading them,
    // a transistor's bias shifting its input impedance, and so on).
    for (const { inst, g, entryNet, exitNet, isTwoSourceBlend, blendIsCcw } of _livePotStages) {
      if (isTwoSourceBlend) {
        // See buildAudioStage's matching comment: netGain can't represent a
        // second independent source, so a live wiper move re-derives the
        // same crossfade-weight formula build time used, not netGain.
        const parsedWiper = parseFloat(inst.props.wiper);
        const wiper = Number.isNaN(parsedWiper) ? 0.5 : parsedWiper;
        const pos = (inst.props.taper||'').includes('Audio') ? Math.pow(wiper,2) : wiper;
        g.gain.setTargetAtTime(blendIsCcw ? (1 - pos) : pos, _ctx.currentTime, 0.01);
        continue;
      }
      const solved = netGain(entryNet, exitNet);
      if (solved == null) continue; // leave the build-time value in place
      g.gain.setTargetAtTime(solved, _ctx.currentTime, 0.01);
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