// ── Simulation Engine ─────────────────────────────────────────────────────────
// Proper net-tracing solver. Builds a net map, identifies supply/ground nets,
// then traces current paths through components to compute voltages/brightness.

const Simulation = (() => {
  let _running=false, _interval=null, _onFailure=null, _onUpdate=null;
  const TICK_MS=10;

  // Latest solved net map + per-net voltages, cached from the most recent
  // tick() so the Voltage Meter tool can query "what's the voltage under
  // the cursor" on demand (mousemove) without re-running the solver.
  let _lastNets = null, _lastNetVoltage = null;

  // Permanent power supply's battery-sag state (Phase 3). Persists across
  // ticks (sag is inherently a running-average effect), but resets whenever
  // the sim starts fresh or Reset Failures is used, so a stopped/restarted
  // run doesn't inherit sag from a previous one.
  let _battery = { effectiveV: null, lastCurrent: 0, posNet: null, virtualPos: null, Rint: 0 };

  function start() { if(_running)return; _running=true; _battery={effectiveV:null,lastCurrent:0,posNet:null,virtualPos:null,Rint:0}; _interval=setInterval(tick,TICK_MS); }
  function stop()  { if(!_running)return; _running=false; clearInterval(_interval); _interval=null; _lastNets=null; _lastNetVoltage=null; }
  function reset() {
    _battery = { effectiveV: null, lastCurrent: 0, posNet: null, virtualPos: null, Rint: 0 };
    _lastNets = null; _lastNetVoltage = null;
    for (const inst of Board.getPlaced()) {
      inst.failed=false; inst.failureType=null;
      inst._voltage=0; inst._current=0; inst._brightness=0;
    }
    Board.redraw();
  }
  function isRunning() { return _running; }

  // ── Main tick ───────────────────────────────────────────────────────────────
  function tick() {
    const placed = Board.getPlaced();
    const wires  = Board.getWires();
    // No "nothing placed" bail-out here: the permanent power supply still
    // needs to solve the rail's voltage on a completely empty board (same
    // reasoning as the Input->Output audio passthrough) — everything below
    // already handles empty placed/wires arrays fine on its own.

    const nets = buildNetMap(placed, wires);

    // ── Permanent power supply (Phase 3): feeds the TOP rail only. The
    // bottom rail is deliberately left untouched here — it's electrically
    // isolated unless the user jumpers it to the top rail or places their
    // own power_supply component there (handled separately below).
    //
    // intendedFixed tracks what each source is TRYING to assign, at its true
    // voltage, before any internal-resistance virtual-node substitution —
    // this is checked for conflicts first, so a short can't be silently
    // absorbed into "well, current just flows through the internal
    // resistance" and go unreported. Two sources (or two rails via a
    // wrong-rail jumper) landing on the same net at different voltages is a
    // wiring mistake, not something to solve around.
    const intendedFixed = [];
    const power = (typeof WorkbenchStrip !== 'undefined') ? WorkbenchStrip.getPermanentState().power : null;

    let permPosNet = null, permNegNet = null, permEmf = 0;
    if (power && power.power_on) {
      const nominalV = parseFloat(power.voltage) || 9;
      const reversed = !!power.reverse_polarity;
      const topPlusNet  = nets.find(nets.key('rtp', 0));
      const topMinusNet = nets.find(nets.key('rtm', 0));
      permPosNet = reversed ? topMinusNet : topPlusNet;
      permNegNet = reversed ? topPlusNet : topMinusNet;

      const sag  = Utils.clamp(parseFloat(power.battery_sag) || 0, 0, 1);
      if (sag > 0) {
        if (_battery.effectiveV == null) _battery.effectiveV = nominalV;
        const sagVolts = sag * nominalV * Utils.clamp(_battery.lastCurrent / 0.5, 0, 1);
        const target = nominalV - sagVolts;
        _battery.effectiveV += (target - _battery.effectiveV) * 0.05;
        permEmf = _battery.effectiveV;
      } else {
        _battery.effectiveV = nominalV;
        permEmf = nominalV;
      }

      if (permPosNet && permNegNet) {
        intendedFixed.push({ net: permPosNet, voltage: permEmf });
        intendedFixed.push({ net: permNegNet, voltage: 0 });
      }
    } else {
      _battery.effectiveV = null; _battery.lastCurrent = 0; _battery.virtualPos = null;
    }

    // Any placed power_supply component(s) contribute their own independent
    // fixed nets too — e.g. one sitting on the bottom rail, powering it
    // separately from the permanent supply above.
    const placedSupplies = [];
    for (const inst of placed) {
      if (inst.failed || inst.defId !== 'power_supply' || inst.legs.length < 2) continue;
      const v = parseFloat(inst.props.voltage) || 9;
      const reversed = !!inst.props.reverse_polarity;
      const posLeg = reversed ? inst.legs[0] : inst.legs[1];
      const negLeg = reversed ? inst.legs[1] : inst.legs[0];
      const pNet = nets.find(nets.key(posLeg.row, posLeg.col));
      const nNet = nets.find(nets.key(negLeg.row, negLeg.col));
      placedSupplies.push({ pNet, nNet, v });
      if (pNet) intendedFixed.push({ net: pNet, voltage: v });
      if (nNet) intendedFixed.push({ net: nNet, voltage: 0 });
    }

    const conflict = detectSupplyConflict(intendedFixed);
    if (conflict) {
      failBoard('⚡', 'Power Supply Conflict',
        `Two different voltages are connected to the same point (${conflict.vA}V and ${conflict.vB}V). ` +
        `That's a short between mismatched supplies — check for a jumper crossing between + and – rails, ` +
        `or two power supplies wired to the same point.`);
      return;
    }

    // No conflict — now build what the solver actually uses, substituting
    // the permanent supply's positive terminal for a virtual EMF node when
    // it has internal resistance (so current through it can be measured for
    // next tick's sag, and the drop under load is real, not assumed).
    const fixedNodes = [];
    const extraResistorEdges = [];

    if (permPosNet && permNegNet) {
      const Rint = Math.max(0, parseFloat(power.internal_resistance) || 0);
      const sag  = Utils.clamp(parseFloat(power.battery_sag) || 0, 0, 1);
      // Sag needs *some* internal resistance to actually manifest as a
      // voltage drop under load — if the user hasn't set one, use a small
      // floor rather than requiring them to configure two properties just
      // to see one of them do anything.
      const effectiveRint = sag > 0 ? Math.max(Rint, 0.1) : Rint;

      fixedNodes.push({ net: permNegNet, voltage: 0 });
      if (effectiveRint > 0) {
        const virtualPos = '__perm_supply_pos__';
        fixedNodes.push({ net: virtualPos, voltage: permEmf });
        extraResistorEdges.push({ a: virtualPos, b: permPosNet, R: effectiveRint });
        _battery.posNet = permPosNet; _battery.virtualPos = virtualPos; _battery.Rint = effectiveRint;
      } else {
        fixedNodes.push({ net: permPosNet, voltage: permEmf });
        _battery.posNet = null; _battery.virtualPos = null;
      }
    }
    for (const { pNet, nNet, v } of placedSupplies) {
      if (pNet) fixedNodes.push({ net: pNet, voltage: v });
      if (nNet) fixedNodes.push({ net: nNet, voltage: 0 });
    }

    const { netVoltage, diodeCurrents } = solveNetVoltages(placed, nets, fixedNodes, extraResistorEdges);
    _lastNets = nets; _lastNetVoltage = netVoltage;

    // Current actually drawn from the permanent supply, remembered for next
    // tick's sag calculation.
    if (_battery.virtualPos) {
      const vVirt = netVoltage.get(_battery.virtualPos);
      const vReal = netVoltage.get(_battery.posNet);
      _battery.lastCurrent = (vVirt != null && vReal != null) ? Math.abs(vVirt - vReal) / _battery.Rint : 0;
    } else {
      _battery.lastCurrent = 0;
    }

    // 4. Solve each component
    for (const inst of placed) {
      if (inst.failed) continue;
      const def = ComponentRegistry.getById(inst.defId);
      if (!def) continue;
      try { solveComponent(inst, def, nets, netVoltage, placed, diodeCurrents); }
      catch(e) { console.warn('[Sim]', e.message); }
    }

    if (_onUpdate) _onUpdate();
    Board.redraw();
  }

  // ── Component solver ─────────────────────────────────────────────────────────
  function solveComponent(inst, def, nets, netVoltage, placed, diodeCurrents) {
    const btype = def.behavior?.type;

    switch(btype) {

      case 'dc_supply':
        inst._voltage = parseFloat(inst.props.voltage) || 9;
        break;

      case 'resistor': {
        const R = parseFloat(inst.props.resistance) || 1000;
        const rating = parseWatts(inst.props.power_rating || '0.25W');
        const [vA, vB] = legVoltages(inst, nets, netVoltage);
        const vDrop = Math.abs((vA ?? 0) - (vB ?? 0));
        inst._voltage = vDrop;
        inst._current = R > 0 ? vDrop / R : 0;
        const P = inst._current * inst._current * R;
        if (P > rating * (def.failure_modes?.over_power?.threshold_multiplier || 2))
          fail(inst, def, 'over_power');
        break;
      }

      case 'diode': {
        const mk  = inst.props.model || '1N4148';
        const pm  = def.model_params?.[mk] || {};
        const Vf  = parseFloat(inst.props.forward_voltage) || pm.vf || 0.7;
        const ImA = (pm.max_current_ma || 200) / 1000;

        const [vA, vB] = legVoltages(inst, nets, netVoltage);
        const vAnode   = vA ?? 0;
        const vCathode = vB ?? 0;
        const I = diodeCurrents?.get(inst) ?? 0;

        if (I <= 0 && vCathode - vAnode > Vf * 0.5) {
          fail(inst, def, 'reverse_voltage'); return;
        }

        if (I <= 0) { inst._current = 0; break; }

        inst._current = I;
        // diode.json's over_current mode has no threshold_multiplier (unlike
        // the LED's 1.5x headroom) — it fires right at the rated max.
        const threshold = ImA * (def.failure_modes?.over_current?.threshold_multiplier || 1);
        if (I > threshold) fail(inst, def, 'over_current');
        break;
      }

      case 'led': {
        const cm  = def.color_map?.[inst.props.color] || { vf: 2.0 };
        const Vf  = parseFloat(inst.props.forward_voltage) || cm.vf;
        const ImA = (parseFloat(inst.props.max_current_ma) || 20) / 1000;

        // Find the net this LED's anode (leg 0) and cathode (leg 1) are on
        const [vA, vB] = legVoltages(inst, nets, netVoltage);
        const vAnode   = vA ?? 0;
        const vCathode = vB ?? 0;
        const vAcross  = vAnode - vCathode;
        const I = diodeCurrents?.get(inst) ?? 0;

        if (I <= 0 && vCathode - vAnode > Vf * 0.5) {
          fail(inst, def, 'reverse_voltage'); return;
        }

        if (I <= 0) {
          inst._brightness = 0; inst._current = 0; break;
        }

        inst._current    = I;
        inst._brightness = Utils.clamp(I / ImA, 0, 1);

        const threshold = ImA * (def.failure_modes?.over_current?.threshold_multiplier || 1.5);
        if (I > threshold) fail(inst, def, 'over_current');
        break;
      }

      case 'capacitor': {
        const [vA, vB] = legVoltages(inst, nets, netVoltage);
        const vr = parseFloat(inst.props.voltage_rating) || 25;
        const vAcross = Math.abs((vA??0) - (vB??0));
        inst._voltage = vAcross;
        if (vAcross > vr * 1.1) fail(inst, def, 'over_voltage');
        break;
      }

      case 'potentiometer': {
        const Rt  = parseFloat(inst.props.resistance) || 100000;
        const w   = parseFloat(inst.props.wiper) || 0.5;
        const pos = (inst.props.taper||'').includes('Audio') ? Math.pow(w,2) : w;
        inst._rLow=Rt*pos; inst._rHigh=Rt*(1-pos);
        const [vA] = legVoltages(inst, nets, netVoltage);
        inst._voltage = (vA ?? 0) * pos;
        break;
      }

      case 'bjt_npn': {
        const mk  = inst.props.model || '2N3904';
        const pm  = def.model_params?.[mk] || {};
        const hfe = parseFloat(inst.props.hfe) || pm.hfe || 100;
        const vbe = pm.vbe || 0.65;
        const eIdx = (inst.props.pinout === 'CBE') ? 2 : 0;
        const vB  = legVoltage(inst, 1, nets, netVoltage);
        const vE  = legVoltage(inst, eIdx, nets, netVoltage);
        const Vbe = (vB ?? 0) - (vE ?? 0);
        if (Vbe < vbe) { inst._current=0; break; }
        const Ib  = (Vbe - vbe) / 10000;
        const Ic  = hfe * Ib;
        const IcMax = (pm.max_ic_ma || 200) / 1000;
        inst._current = Ic;
        if (Ic > IcMax) fail(inst, def, 'over_current');
        break;
      }

      case 'bjt_pnp': {
        const mk  = inst.props.model || '2N3906';
        const pm  = def.model_params?.[mk] || {};
        const hfe = parseFloat(inst.props.hfe) || pm.hfe || 100;
        const vbe = pm.vbe || 0.65; // magnitude of the Veb turn-on threshold
        const eIdx = (inst.props.pinout === 'CBE') ? 2 : 0;
        const vB  = legVoltage(inst, 1, nets, netVoltage);
        const vE  = legVoltage(inst, eIdx, nets, netVoltage);
        const Veb = (vE ?? 0) - (vB ?? 0);
        if (Veb < vbe) { inst._current=0; break; }
        const Ib  = (Veb - vbe) / 10000;
        const Ic  = hfe * Ib;
        const IcMax = (pm.max_ic_ma || 200) / 1000;
        inst._current = Ic;
        if (Ic > IcMax) fail(inst, def, 'over_current');
        break;
      }

      case 'switch_spst':
        inst._closed = Utils.isSwitchClosed(inst);
        break;

      default:
        break;
    }
  }

  // ── Net voltage helpers ───────────────────────────────────────────────────────

  // Get voltage at a specific leg index
  function legVoltage(inst, legIdx, nets, netVoltage) {
    if (!inst.legs[legIdx]) return null;
    const {row,col} = inst.legs[legIdx];
    const net = nets.find(nets.key(row, col));
    return netVoltage.get(net) ?? null;
  }

  // Get voltages at leg[0] and leg[last]
  function legVoltages(inst, nets, netVoltage) {
    const vA = legVoltage(inst, 0, nets, netVoltage);
    const vB = legVoltage(inst, inst.legs.length-1, nets, netVoltage);
    return [vA, vB];
  }

  // ── Resistive network solver ──────────────────────────────────────────────────
  // Solves for the voltage at every net in the circuit (not just the two nets
  // touching the power supply), plus the current through every diode/LED.
  //
  // Method: nodal analysis (conductance matrix) over resistors and
  // potentiometer segments, with diodes/LEDs modeled as a small "on"
  // resistance plus a compensating current source once forward-biased past
  // Vf (a standard piecewise-linear diode companion model), or a very large
  // "off" resistance otherwise. Diode on/off states are guessed, solved,
  // checked against the result, and re-solved until stable (a handful of
  // iterations is always enough for the size of circuits this board can
  // hold). Transistors and capacitors are intentionally not added as edges
  // here — transistor legs still just read the voltages this solve produces
  // for them, same as before, and capacitors correctly stay isolated from
  // each other in this DC-only model (a cap really does block DC).
  const RON  = 1;     // ohms — small "on" resistance for a conducting diode/LED
  const ROFF = 1e9;   // ohms — effectively open for a non-conducting diode/LED
  const EPS  = 1e-12; // tiny leak-to-ground on every net so isolated islands don't produce a singular matrix

  function solveNetVoltages(placed, nets, fixedNodes, extraResistorEdges) {
    extraResistorEdges = extraResistorEdges || [];
    const fixed = new Map();
    for (const { net, voltage } of fixedNodes) { if (net != null) fixed.set(net, voltage); }

    function netOf(row, col) { return nets.find(nets.key(row, col)); }

    const resistorEdges = [...extraResistorEdges]; // {a,b,R}
    const diodeEdges    = []; // {a,b,Vf,inst}  a=anode net, b=cathode net

    for (const inst of placed) {
      if (inst.failed) continue;
      const def = ComponentRegistry.getById(inst.defId);
      const btype = def?.behavior?.type;

      if (btype === 'resistor') {
        const R = parseFloat(inst.props.resistance) || 1000;
        const a = netOf(inst.legs[0].row, inst.legs[0].col);
        const b = netOf(inst.legs[inst.legs.length-1].row, inst.legs[inst.legs.length-1].col);
        resistorEdges.push({ a, b, R });

      } else if (btype === 'potentiometer' && inst.legs.length >= 3) {
        const Rt  = parseFloat(inst.props.resistance) || 100000;
        const w   = parseFloat(inst.props.wiper) ?? 0.5;
        const pos = (inst.props.taper||'').includes('Audio') ? Math.pow(w,2) : w;
        const ccw = netOf(inst.legs[0].row, inst.legs[0].col);
        const wpr = netOf(inst.legs[1].row, inst.legs[1].col);
        const cw  = netOf(inst.legs[2].row, inst.legs[2].col);
        resistorEdges.push({ a: ccw, b: wpr, R: Math.max(Rt*pos, 1) });
        resistorEdges.push({ a: wpr, b: cw,  R: Math.max(Rt*(1-pos), 1) });

      } else if (btype === 'led' || btype === 'diode') {
        const cm = def.color_map?.[inst.props.color];
        const Vf = parseFloat(inst.props.forward_voltage) || cm?.vf || 0.7;
        const a  = netOf(inst.legs[0].row, inst.legs[0].col);              // anode
        const b  = netOf(inst.legs[inst.legs.length-1].row, inst.legs[inst.legs.length-1].col); // cathode
        diodeEdges.push({ a, b, Vf, inst });
      }
    }

    const netIndex = new Map();
    const register = net => { if (net!=null && !fixed.has(net) && !netIndex.has(net)) netIndex.set(net, netIndex.size); };
    resistorEdges.forEach(e => { register(e.a); register(e.b); });
    diodeEdges.forEach(e => { register(e.a); register(e.b); });

    const N = netIndex.size;
    const netVoltage = new Map(fixed);
    const diodeCurrents = new Map();
    if (N === 0) return { netVoltage, diodeCurrents };

    function stampConductance(G, I, a, b, g) {
      const ai = netIndex.has(a) ? netIndex.get(a) : -1;
      const bi = netIndex.has(b) ? netIndex.get(b) : -1;
      if (ai>=0) G[ai][ai]+=g;
      if (bi>=0) G[bi][bi]+=g;
      if (ai>=0 && bi>=0) { G[ai][bi]-=g; G[bi][ai]-=g; }
      else if (ai>=0 && fixed.has(b)) I[ai] += g*fixed.get(b);
      else if (bi>=0 && fixed.has(a)) I[bi] += g*fixed.get(a);
    }
    function stampCurrentSource(I, a, b, amount) {
      const ai = netIndex.has(a) ? netIndex.get(a) : -1;
      const bi = netIndex.has(b) ? netIndex.get(b) : -1;
      if (ai>=0) I[ai]+=amount;
      if (bi>=0) I[bi]-=amount;
    }

    let states = diodeEdges.map(() => false);
    let V = new Array(N).fill(0);

    for (let iter=0; iter<8; iter++) {
      const G = Array.from({length:N}, () => new Array(N).fill(0));
      const I = new Array(N).fill(0);
      for (let i=0;i<N;i++) G[i][i]+=EPS;

      for (const e of resistorEdges) {
        if (e.a==null || e.b==null || e.a===e.b) continue;
        stampConductance(G, I, e.a, e.b, 1/(e.R||1e-6));
      }
      diodeEdges.forEach((e, idx) => {
        if (e.a==null || e.b==null || e.a===e.b) return;
        const on = states[idx];
        const g = 1/(on ? RON : ROFF);
        stampConductance(G, I, e.a, e.b, g);
        if (on) stampCurrentSource(I, e.a, e.b, g*e.Vf);
      });

      V = gaussianSolve(G, I);

      let changed = false;
      diodeEdges.forEach((e, idx) => {
        if (e.a==null || e.b==null) return;
        const va = netIndex.has(e.a) ? V[netIndex.get(e.a)] : fixed.get(e.a);
        const vb = netIndex.has(e.b) ? V[netIndex.get(e.b)] : fixed.get(e.b);
        const shouldBeOn = (va - vb) > e.Vf * 0.5;
        if (shouldBeOn !== states[idx]) { states[idx] = shouldBeOn; changed = true; }
      });
      if (!changed) break;
    }

    for (const [net, idx] of netIndex) netVoltage.set(net, V[idx]);
    diodeEdges.forEach((e, idx) => {
      if (e.a==null || e.b==null) { diodeCurrents.set(e.inst, 0); return; }
      const va = netIndex.has(e.a) ? V[netIndex.get(e.a)] : fixed.get(e.a);
      const vb = netIndex.has(e.b) ? V[netIndex.get(e.b)] : fixed.get(e.b);
      const on = states[idx];
      const g = 1/(on ? RON : ROFF);
      diodeCurrents.set(e.inst, on ? Math.max(0, g*((va-vb) - e.Vf)) : 0);
    });

    return { netVoltage, diodeCurrents };
  }

  // Small Gaussian-elimination solver for G·V = I (dense, fine at breadboard scale)
  function gaussianSolve(G, I) {
    const n = I.length;
    if (n === 0) return [];
    const A = G.map(row => row.slice());
    const b = I.slice();
    for (let col=0; col<n; col++) {
      let piv = col;
      for (let r=col+1; r<n; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
      if (Math.abs(A[piv][col]) < 1e-15) continue;
      [A[col], A[piv]] = [A[piv], A[col]];
      [b[col], b[piv]] = [b[piv], b[col]];
      for (let r=0; r<n; r++) {
        if (r===col) continue;
        const f = A[r][col] / A[col][col];
        if (f===0) continue;
        for (let c=col; c<n; c++) A[r][c] -= f*A[col][c];
        b[r] -= f*b[col];
      }
    }
    const x = new Array(n).fill(0);
    for (let i=0;i<n;i++) x[i] = Math.abs(A[i][i]) > 1e-15 ? b[i]/A[i][i] : 0;
    return x;
  }

  // ── Net map (union-find) ──────────────────────────────────────────────────────
  function buildNetMap(placed, wires) {
    const parent = {};

    function key(row, col) { return `${row},${col}`; }

    function find(k) {
      if (!parent[k]) parent[k] = k;
      if (parent[k] !== k) parent[k] = find(parent[k]);
      return parent[k];
    }

    function union(k1, k2) {
      const r1=find(k1), r2=find(k2);
      if (r1!==r2) parent[r1]=r2;
    }

    // Internal breadboard connections
    // Rows 0-4 (a-e): each column is internally connected vertically
    for (let col=0; col<63; col++)
      for (let r=1; r<=4; r++) union(key(0,col), key(r,col));
    // Rows 5-9 (f-j): each column internally connected
    for (let col=0; col<63; col++)
      for (let r=6; r<=9; r++) union(key(5,col), key(r,col));

    // Power rail connections (broken at col 31)
    for (const rr of ['rtp','rtm','rbp','rbm']) {
      for (let col=1; col<=30; col++) union(key(rr,0), key(rr,col));
      for (let col=32; col<=62; col++) union(key(rr,31), key(rr,col));
    }

    // Wire connections
    for (const w of wires) {
      const k1=key(w.r1,w.c1), k2=key(w.r2,w.c2);
      if (!parent[k1]) parent[k1]=k1;
      if (!parent[k2]) parent[k2]=k2;
      union(k1, k2);
    }

    for (const inst of placed) {
      const def = ComponentRegistry.getById(inst.defId);
      if (def?.behavior?.type !== 'switch_spst') continue;
      const closed = Utils.isSwitchClosed(inst);
      if (!closed || inst.legs.length < 2) continue;
      const k1=key(inst.legs[0].row, inst.legs[0].col);
      const k2=key(inst.legs[inst.legs.length-1].row, inst.legs[inst.legs.length-1].col);
      if (!parent[k1]) parent[k1]=k1;
      if (!parent[k2]) parent[k2]=k2;
      union(k1, k2);
    }

    return { find, key };
  }

  function fail(inst, def, mode) {
    inst.failed=true; inst.failureType=mode; inst._brightness=0;
    const fm=def.failure_modes?.[mode];
    const icons={burn:'🔥',explode:'💥',smoke:'💨',silent_fail:'⚫'};
    if (_onFailure) _onFailure({
      icon: icons[fm?.result]||'💥',
      title: `${def.label} Failed`,
      message: fm?.message||`Component failure: ${mode}`
    });
    stop(); Board.redraw();
  }

  // Two fixed-voltage assignments landing on the same net at different
  // voltages — two supplies wired together, or a jumper crossing between
  // mismatched-polarity rails. Returns the first conflict found, or null.
  function detectSupplyConflict(intendedFixed) {
    const seen = new Map();
    for (const { net, voltage } of intendedFixed) {
      if (net == null) continue;
      if (seen.has(net)) {
        const prev = seen.get(net);
        if (Math.abs(prev - voltage) > 1e-6) return { net, vA: prev, vB: voltage };
      } else {
        seen.set(net, voltage);
      }
    }
    return null;
  }

  // Board-level failure — a wiring/topology fault with no single
  // responsible component instance, so nothing gets marked .failed the way
  // fail() marks a specific inst. Same user-facing treatment otherwise:
  // reported through the same onFailure channel, and stops the sim.
  function failBoard(icon, title, message) {
    if (_onFailure) _onFailure({ icon, title, message });
    stop(); Board.redraw();
  }

  function parseWatts(str) { return parseFloat(str)||0.25; }
  function notifyStateChange(inst) { if(_running) tick(); }
  function onFailure(fn) { _onFailure=fn; }
  function onUpdate(fn)  { _onUpdate=fn; }

  // Whether two specific holes are on the same electrical net right now —
  // reuses buildNetMap() exactly as tick() does (same wires, same closed-
  // switch handling), so this always matches what the simulation itself
  // would consider connected. Used by AudioEngine to decide whether an
  // engaged bypass actually has a complete Input->Output path, rather than
  // just assuming one exists because components happen to be placed.
  function hasElectricalPath(rowA, colA, rowB, colB) {
    const placed = Board.getPlaced();
    const wires  = Board.getWires();
    const nets   = buildNetMap(placed, wires);
    return nets.find(nets.key(rowA, colA)) === nets.find(nets.key(rowB, colB));
  }

  // Voltage at a given hole, from the most recent tick's solve. Per the
  // doc, empty/no-voltage nodes (including "sim hasn't ticked yet") read
  // as 0V rather than null/blank — matches probing an unpowered real board.
  function getVoltageAt(row, col) {
    if (!_lastNets || !_lastNetVoltage) return 0;
    const net = _lastNets.find(_lastNets.key(row, col));
    const v = _lastNetVoltage.get(net);
    return typeof v === 'number' ? v : 0;
  }

  return { start,stop,reset,isRunning,tick,onFailure,onUpdate,notifyStateChange,hasElectricalPath,getVoltageAt,buildNetMap };
})();