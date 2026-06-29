// ── Simulation Engine ─────────────────────────────────────────────────────────
// Proper net-tracing solver. Builds a net map, identifies supply/ground nets,
// then traces current paths through components to compute voltages/brightness.

const Simulation = (() => {
  let _running=false, _interval=null, _onFailure=null, _onUpdate=null;
  const TICK_MS=10;

  function start() { if(_running)return; _running=true; _interval=setInterval(tick,TICK_MS); }
  function stop()  { if(!_running)return; _running=false; clearInterval(_interval); _interval=null; }
  function reset() {
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
    if (!placed.length) return;

    // 1. Build union-find net map
    const nets = buildNetMap(placed, wires);

    // 2. Find supply voltage and which nets are VCC / GND
    const supplyInst = placed.find(p => p.defId === 'power_supply' && !p.failed);
    const Vsupply    = supplyInst ? (parseFloat(supplyInst.props.voltage) || 9) : 0;

    let vccNet = null, gndNet = null;
    if (supplyInst && supplyInst.legs.length >= 2) {
      // leg 0 = +, leg 1 = –
      const posLeg = supplyInst.legs[0];
      const negLeg = supplyInst.legs[1];
      vccNet = nets.find(nets.key(posLeg.row, posLeg.col));
      gndNet = nets.find(nets.key(negLeg.row, negLeg.col));
    } else {
      // No power supply placed — try to infer from rail connections
      // Top + rail and bottom – rail are common defaults
      vccNet = nets.find(nets.key('rtp', 0));
      gndNet = nets.find(nets.key('rbm', 0));
    }

    // 3. Assign net voltages: VCC net = Vsupply, GND net = 0
    const netVoltage = new Map();
    if (vccNet) netVoltage.set(vccNet, Vsupply);
    if (gndNet) netVoltage.set(gndNet, 0);

    // 4. Solve each component
    for (const inst of placed) {
      if (inst.failed) continue;
      const def = ComponentRegistry.getById(inst.defId);
      if (!def) continue;
      try { solveComponent(inst, def, Vsupply, nets, netVoltage, placed); }
      catch(e) { console.warn('[Sim]', e.message); }
    }

    if (_onUpdate) _onUpdate();
    Board.redraw();
  }

  // ── Component solver ─────────────────────────────────────────────────────────
  function solveComponent(inst, def, Vsupply, nets, netVoltage, placed) {
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

      case 'led': {
        const cm  = def.color_map?.[inst.props.color] || { vf: 2.0 };
        const Vf  = parseFloat(inst.props.forward_voltage) || cm.vf;
        const ImA = (parseFloat(inst.props.max_current_ma) || 20) / 1000;

        // Find the net this LED's anode (leg 0) and cathode (leg 1) are on
        const [vA, vB] = legVoltages(inst, nets, netVoltage);
        const vAnode   = vA ?? 0;
        const vCathode = vB ?? 0;

        if (inst.flipped) {
          // flipped = cathode is leg 0
          if (vCathode - vAnode > Vf * 0.5) {
            fail(inst, def, 'reverse_voltage'); return;
          }
        }

        const vAcross = vAnode - vCathode;
        if (vAcross < Vf * 0.7) {
          inst._brightness = 0; inst._current = 0; break;
        }

        // Find series resistance in the same path
        const R = findSeriesResistance(inst, nets, netVoltage, placed);
        const I = R > 0
          ? (vAcross - Vf) / R
          : ImA * 3; // no resistor = overcurrent

        inst._current    = Math.max(0, I);
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
        // Legs: 0=E, 1=B, 2=C (standard BJT ordering)
        const vB  = legVoltage(inst, 1, nets, netVoltage);
        const vE  = legVoltage(inst, 0, nets, netVoltage);
        const Vbe = (vB ?? 0) - (vE ?? 0);
        if (Vbe < vbe) { inst._current=0; break; }
        const Ib  = (Vbe - vbe) / 10000;
        const Ic  = hfe * Ib;
        const IcMax = (pm.max_ic_ma || 200) / 1000;
        inst._current = Ic;
        if (Ic > IcMax) fail(inst, def, 'over_current');
        break;
      }

      case 'switch_spst':
        inst._closed = inst._state || inst.props.state === 'Closed';
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

  // Find total series resistance in the path containing this component
  // Simple approach: sum all resistors whose both legs are on nets between VCC and GND
  function findSeriesResistance(inst, nets, netVoltage, placed) {
    const ledNet0 = nets.find(nets.key(inst.legs[0].row, inst.legs[0].col));
    const ledNet1 = nets.find(nets.key(inst.legs[inst.legs.length-1].row, inst.legs[inst.legs.length-1].col));

    let totalR = 0;
    for (const other of placed) {
      if (other === inst || other.failed) continue;
      const def = ComponentRegistry.getById(other.defId);
      if (def?.behavior?.type !== 'resistor') continue;

      const rNet0 = nets.find(nets.key(other.legs[0].row, other.legs[0].col));
      const rNet1 = nets.find(nets.key(other.legs[other.legs.length-1].row, other.legs[other.legs.length-1].col));

      // Resistor is in series if it shares a net with the LED path
      if (rNet0===ledNet0||rNet1===ledNet0||rNet0===ledNet1||rNet1===ledNet1) {
        totalR += parseFloat(other.props.resistance) || 1000;
      }
    }
    return totalR;
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

  function parseWatts(str) { return parseFloat(str)||0.25; }
  function notifyStateChange(inst) { if(_running) tick(); }
  function onFailure(fn) { _onFailure=fn; }
  function onUpdate(fn)  { _onUpdate=fn; }

  return { start,stop,reset,isRunning,tick,onFailure,onUpdate,notifyStateChange };
})();
