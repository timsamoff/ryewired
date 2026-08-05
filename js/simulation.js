// ── Simulation Engine ─────────────────────────────────────────────────────────
// Proper net-tracing solver. Builds a net map, identifies supply/ground nets,
// then traces current paths through components to compute voltages/brightness.

const Simulation = (() => {
  let _running=false, _interval=null, _onFailure=null, _onUpdate=null, _onTopologyChange=null;
  const TICK_MS=10;

  // Latest solved net map + per-net voltages, cached from the most recent
  // tick() so the Voltage Meter tool can query "what's the voltage under
  // the cursor" on demand (mousemove) without re-running the solver.
  let _lastNets = null, _lastNetVoltage = null;

  // Last small-signal solve: net -> voltage gain relative to a 1V input drive.
  // Recomputed every tick from the just-solved DC operating point, so the audio
  // engine can read real, network-derived stage gains instead of per-component
  // formulas. null when there's no input connection point or the solve failed.
  let _lastSmallSignal = null;

  // Whichever supply is actually contributing this tick. Module-scope, not a
  // tick()-local, because solveComponent() reads it and is a SIBLING function,
  // not nested inside tick() — as a local it was an unresolved identifier
  // there, and the ReferenceError got silently swallowed by the try/catch
  // around the solveComponent call, freezing _vceHeadroom permanently
  // undefined and disabling the BJT over-current check entirely.
  // Reset at the top of every tick, and only ever read from within the same
  // tick's solveComponent pass, so it can never be read stale.
  let _activeSupplyV = null;

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

    // Tracks whichever supply is actually contributing this tick — used
    // below to scale BJT headroom against the real active voltage instead
    // of a flat assumption, so changing the supply voltage actually moves
    // where clipping kicks in. Declared at module scope (see above).
    _activeSupplyV = null;

    const nets = buildNetMap(placed, wires);

    // Structural check: a semiconductor terminal that is the ONLY thing on
    // its net isn't connected to anything — on a real board that leg is
    // sitting in an empty row, and nothing about the solve downstream will
    // mean anything.
    //
    // Checked structurally rather than by symptom, because the symptom is not
    // stable. A floating collector used to blow its node up to ~1e9 volts
    // (the range check further down catches that), but once the part
    // saturates, the saturation clamp ties the collector to the emitter
    // through RSAT and the voltage reads perfectly ordinary while current is
    // still reported flowing through a leg that goes nowhere. Structure
    // doesn't lie the way a solved number can.
    const floating = findFloatingTerminal(placed, nets);
    if (floating) {
      failBoard('🔌', 'Disconnected Leg',
        `${floating.who}'s ${floating.leg} isn't connected to anything — it's the only thing on ` +
        `its row. A ${floating.label} with a floating leg can't do anything on a real board, and ` +
        `the voltages here won't mean much until it's wired up.`);
      return;
    }

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
      // Use the power block's REAL connection columns (dynamically
      // hole-snapped, from WorkbenchStrip.getConnectionPoints) instead of
      // hardcoded column 0. The rails span the full board width now (see
      // buildNetMap), so column choice no longer changes WHICH segment gets
      // powered — this originally fixed a rail-break bug that no longer
      // exists. It's kept because reading the block's actual position is
      // still the correct thing to do: it stays right if the rails are ever
      // segmented again, and it doesn't depend on the supply happening to
      // sit at column 0.
      const cp = (typeof WorkbenchStrip !== 'undefined' && WorkbenchStrip.getConnectionPoints) ? WorkbenchStrip.getConnectionPoints() : null;
      const plusCol  = cp?.powerPlusCol  ?? 0;
      const minusCol = cp?.powerMinusCol ?? 0;
      const topPlusNet  = nets.find(nets.key('rtp', plusCol));
      const topMinusNet = nets.find(nets.key('rtm', minusCol));
      permPosNet = reversed ? topMinusNet : topPlusNet;
      permNegNet = reversed ? topPlusNet : topMinusNet;

      const sag  = Utils.clamp(parseFloat(power.battery_sag) || 0, 0, 1);
      if (sag > 0) {
        if (_battery.effectiveV == null) _battery.effectiveV = nominalV;
        // 0.01A (10mA) is the "heavy draw" reference for a pedal circuit —
        // this used to be 0.5A (amp-scale current), which no pedal ever
        // gets remotely close to (this app's own circuits typically draw
        // well under 5mA total), making the DC-current term contribute a
        // few hundredths of a volt even at max slider — effectively
        // invisible regardless of the sag setting.
        const sagFactor = Utils.clamp(Utils.clamp(_battery.lastCurrent / 0.01, 0, 1) + signalSagFactor(), 0, 1);
        const sagVolts = sag * nominalV * sagFactor;
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
        _activeSupplyV = permEmf;
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
      if (inst.props.power_on === false) continue; // off — contributes nothing, same gate as the permanent supply

      if (!inst._battery) inst._battery = { effectiveV: null, lastCurrent: 0, posNet: null, virtualPos: null, Rint: 0 };
      const nominalV = parseFloat(inst.props.voltage) || 9;
      const reversed = !!inst.props.reverse_polarity;
      const posLeg = reversed ? inst.legs[0] : inst.legs[1];
      const negLeg = reversed ? inst.legs[1] : inst.legs[0];
      const pNet = nets.find(nets.key(posLeg.row, posLeg.col));
      const nNet = nets.find(nets.key(negLeg.row, negLeg.col));

      const sag = Utils.clamp(parseFloat(inst.props.battery_sag) || 0, 0, 1);
      let v;
      if (sag > 0) {
        if (inst._battery.effectiveV == null) inst._battery.effectiveV = nominalV;
        const sagFactor = Utils.clamp(Utils.clamp(inst._battery.lastCurrent / 0.01, 0, 1) + signalSagFactor(), 0, 1);
        const sagVolts = sag * nominalV * sagFactor;
        const target = nominalV - sagVolts;
        inst._battery.effectiveV += (target - inst._battery.effectiveV) * 0.05;
        v = inst._battery.effectiveV;
      } else {
        inst._battery.effectiveV = nominalV;
        v = nominalV;
      }

      const Rint = Math.max(0, parseFloat(inst.props.internal_resistance) || 0);
      const effectiveRint = sag > 0 ? Math.max(Rint, 0.1) : Rint; // same floor reasoning as the permanent supply — sag needs some Rint to actually show up as a drop

      placedSupplies.push({ inst, pNet, nNet, v, effectiveRint });
      if (pNet) intendedFixed.push({ net: pNet, voltage: v });
      if (nNet) intendedFixed.push({ net: nNet, voltage: 0 });
      if (_activeSupplyV == null) _activeSupplyV = v;
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
    for (const { inst, pNet, nNet, v, effectiveRint } of placedSupplies) {
      if (nNet) fixedNodes.push({ net: nNet, voltage: 0 });
      if (pNet && effectiveRint > 0) {
        const virtualPos = '__dc_supply_pos_' + inst.instanceId + '__';
        fixedNodes.push({ net: virtualPos, voltage: v });
        extraResistorEdges.push({ a: virtualPos, b: pNet, R: effectiveRint });
        inst._battery.posNet = pNet; inst._battery.virtualPos = virtualPos; inst._battery.Rint = effectiveRint;
      } else {
        if (pNet) fixedNodes.push({ net: pNet, voltage: v });
        inst._battery.posNet = null; inst._battery.virtualPos = null;
      }
    }

    const { netVoltage, diodeCurrents, bjtCurrents } = solveNetVoltages(placed, nets, fixedNodes, extraResistorEdges);
    _lastNets = nets; _lastNetVoltage = netVoltage;

    // Sanity check: in this DC-only model (no inductors, and caps correctly
    // block DC) no node can legitimately sit outside the supply rails — a
    // resistive network's node voltages are bounded by its sources. A node
    // that lands far outside means the netlist is broken, and by far the most
    // common cause is a semiconductor terminal connected to nothing: the
    // solver's tiny EPS leak-to-ground is then the only path to ground, so
    // V = I/EPS explodes to ~1e9.
    //
    // Worth catching loudly. A real board just wouldn't work; before this
    // check the app instead solved a floating collector to -9.7 GIGAvolts,
    // reported no problem at all, and fed that straight into the audio model,
    // which cost a long debugging session chasing the sound rather than the
    // wiring.
    const supplyHigh = Math.max(0, ...fixedNodes.map(f => f.voltage));
    const RANGE_SLACK = 1.0; // volts, comfortably past solver noise
    let worstNode = null;
    for (const [net, v] of netVoltage) {
      if (Number.isFinite(v) && v >= -RANGE_SLACK && v <= supplyHigh + RANGE_SLACK) continue;
      if (!worstNode || !Number.isFinite(v) || Math.abs(v) > Math.abs(worstNode.v)) worstNode = { net, v };
    }
    if (worstNode) {
      failBoard('⚡', 'Impossible Voltage',
        `${describeNet(worstNode.net, placed, nets)} solved to ${formatVolts(worstNode.v)}, ` +
        `which can't happen on a ${supplyHigh}V supply. Something is wired wrong — most often a ` +
        `component leg (commonly a transistor's collector or emitter) isn't actually connected to ` +
        `anything. Check for a leg sitting in a row with nothing else in it.`);
      return;
    }

    // Current actually drawn from the permanent supply, remembered for next
    // tick's sag calculation.
    if (_battery.virtualPos) {
      const vVirt = netVoltage.get(_battery.virtualPos);
      const vReal = netVoltage.get(_battery.posNet);
      _battery.lastCurrent = (vVirt != null && vReal != null) ? Math.abs(vVirt - vReal) / _battery.Rint : 0;
    } else {
      _battery.lastCurrent = 0;
    }
    // Same, per-instance, for each draggable supply with its own sag/Rint.
    for (const { inst } of placedSupplies) {
      if (inst._battery.virtualPos) {
        const vVirt = netVoltage.get(inst._battery.virtualPos);
        const vReal = netVoltage.get(inst._battery.posNet);
        inst._battery.lastCurrent = (vVirt != null && vReal != null) ? Math.abs(vVirt - vReal) / inst._battery.Rint : 0;
      } else {
        inst._battery.lastCurrent = 0;
      }
    }

    // 4. Solve each component
    for (const inst of placed) {
      if (inst.failed) continue;
      const def = ComponentRegistry.getById(inst.defId);
      if (!def) continue;
      try { solveComponent(inst, def, nets, netVoltage, placed, diodeCurrents, bjtCurrents); }
      catch(e) { console.warn('[Sim]', e.message); }
    }

    // Small-signal pass, AFTER the component solve because it linearizes each
    // transistor around the operating point that pass just computed
    // (inst._current). Every solved node voltage is that node's gain relative
    // to the input, which is what the audio engine builds its stage gains and
    // pot ratios from.
    _lastSmallSignal = null;
    const cpSS = (typeof WorkbenchStrip !== 'undefined' && WorkbenchStrip.getConnectionPoints)
      ? WorkbenchStrip.getConnectionPoints() : null;
    if (cpSS) {
      // Supply rails count as AC ground alongside the ground rail.
      const acGrounds = [permNegNet, permPosNet, ...placedSupplies.flatMap(s => [s.nNet, s.pNet])];
      try {
        _lastSmallSignal = solveSmallSignal(
          placed, nets, nets.find(nets.key(cpSS.firstRow, cpSS.inputCol)), acGrounds);
      } catch (e) { console.warn('[Sim] small-signal solve failed:', e.message); }
    }

    if (_onUpdate) _onUpdate();
    Board.redraw();
  }

  // ── Component solver ─────────────────────────────────────────────────────────
  function solveComponent(inst, def, nets, netVoltage, placed, diodeCurrents, bjtCurrents) {
    const btype = def.behavior?.type;

    switch(btype) {

      case 'dc_supply':
        inst._voltage = parseFloat(inst.props.voltage) || 9;
        break;

      case 'resistor': {
        const R = resolvedValue(inst, 'resistance', 1000);
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
        // Signed, not absolute — polarized parts (electrolytic) care which
        // leg is higher, not just the magnitude across them. leg 0 = '+',
        // leg[last] = '–', matching leg_labels order in the component JSON.
        const vSigned = (vA??0) - (vB??0);
        const vAcross = Math.abs(vSigned);
        inst._voltage = vAcross;
        if (vAcross > vr * 1.1) fail(inst, def, 'over_voltage');
        // Real electrolytics tolerate a volt or so of reverse bias before
        // anything bad happens — a strict 0V check would false-positive on
        // ordinary solver settling at a near-zero bias point. 1V mirrors
        // that real-world tolerance rather than a textbook-SPICE hard zero.
        else if (def.polarized && vSigned < -1) fail(inst, def, 'reverse_polarity');
        break;
      }

      case 'potentiometer': {
        const Rt  = parseFloat(inst.props.resistance) || 100000;
        const parsedW = parseFloat(inst.props.wiper);
        const w   = Number.isNaN(parsedW) ? 0.5 : parsedW; // NOT `|| 0.5` — a real, valid wiper of exactly 0 is not "missing"
        const pos = (inst.props.taper||'').includes('Audio') ? Math.pow(w,2) : w;
        inst._rLow=Rt*pos; inst._rHigh=Rt*(1-pos);
        const [vA] = legVoltages(inst, nets, netVoltage);
        inst._voltage = (vA ?? 0) * pos;
        break;
      }

      case 'bjt_npn': {
        const mk  = inst.props.model || '2N3904';
        const pm  = def.model_params?.[mk] || {};
        const IcMax = (pm.max_ic_ma || 200) / 1000;
        const c = bjtCurrents?.get(inst);
        const Ic = c?.Ic || 0;
        inst._current = Ic;
        inst._saturated = !!c?.saturated;
        // 0 = sitting right at the saturation floor, 1 = comfortably clear
        // of it. The reference scales with the actual active supply
        // voltage (3V at a 9V supply, the original calibration point,
        // scaled proportionally otherwise) rather than a flat "3V is
        // enough headroom" assumption regardless of supply — that flat
        // assumption meant halving the supply barely moved this number,
        // which is why changing supply voltage barely changed the sound.
        // Measured from the model's OWN saturation floor, not a flat 0.2V —
        // germanium saturates at half silicon's Vce(sat), so a flat floor
        // understated how much headroom a germanium stage actually has.
        const headroomRef = 3 * ((_activeSupplyV ?? 9) / 9);
        const vceSatN = Number.isFinite(parseFloat(pm.vce_sat)) ? parseFloat(pm.vce_sat) : 0.2;
        inst._vceHeadroom = Utils.clamp(((c?.vce ?? 3) - vceSatN) / headroomRef, 0, 1);
        setOutputSwing(inst, nets, netVoltage, vceSatN, false);
        if (Ic > IcMax) fail(inst, def, 'over_current');
        break;
      }

      case 'bjt_pnp': {
        const mk  = inst.props.model || '2N3906';
        const pm  = def.model_params?.[mk] || {};
        const IcMax = (pm.max_ic_ma || 200) / 1000;
        const c = bjtCurrents?.get(inst);
        const Ic = c?.Ic || 0;
        inst._current = Ic;
        inst._saturated = !!c?.saturated;
        // Same reasoning as bjt_npn — see that case for the full comment.
        const headroomRefPnp = 3 * ((_activeSupplyV ?? 9) / 9);
        const vceSatP = Number.isFinite(parseFloat(pm.vce_sat)) ? parseFloat(pm.vce_sat) : 0.2;
        inst._vceHeadroom = Utils.clamp(((c?.vce ?? 3) - vceSatP) / headroomRefPnp, 0, 1);
        setOutputSwing(inst, nets, netVoltage, vceSatP, true);
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

  // How far a transistor's collector can actually swing, IN VOLTS, in each
  // direction from where it currently sits. This is the real, physical limit
  // on the stage's output, and it is what the audio engine's clipping
  // thresholds should be — the previous `0.15 + 0.75*vceHeadroom` was a
  // normalized 0-1 number sitting in a signal path whose gains are real
  // volts-per-volt, which made the two dimensionally incoherent.
  //
  // The two directions are genuinely DIFFERENT, and that asymmetry is real
  // rather than a stylistic choice. A starved-bias germanium stage might sit
  // at Vc = 0.77V on a 9V supply: it can only fall about 0.67V before hitting
  // saturation, but can rise 8.2V before hitting the rail. Clipping one way
  // long before the other is exactly where a fuzz's even-harmonic character
  // comes from.
  //
  //   _swingDown : how far the collector can fall  (to Ve + Vce_sat)
  //   _swingUp   : how far it can rise             (to the supply rail)
  function setOutputSwing(inst, nets, netVoltage, vceSat, pnp) {
    const eIdx = (inst.props.pinout === 'CBE') ? 2 : 0;
    const cIdx = eIdx === 0 ? 2 : 0;
    const vC = legVoltage(inst, cIdx, nets, netVoltage);
    const vE = legVoltage(inst, eIdx, nets, netVoltage);
    const supply = _activeSupplyV ?? 9;
    if (vC == null || vE == null) { inst._swingDown = null; inst._swingUp = null; return; }
    if (pnp) {
      // Mirrored: a PNP's collector sits BELOW its emitter, so it rises toward
      // saturation and falls toward the negative rail (ground here).
      inst._swingUp   = Math.max(0, vE - vceSat - vC);
      inst._swingDown = Math.max(0, vC - 0);
    } else {
      inst._swingDown = Math.max(0, vC - vE - vceSat);
      inst._swingUp   = Math.max(0, supply - vC);
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
  // hold). Transistors' base-emitter junctions are modeled the same way (see
  // bjtEdges below). Collector current (Ic = hFE*Ib) is a linear function of
  // the same B-E junction voltage once the junction's on/off state is
  // decided for an iteration, so it's stamped directly into the same matrix
  // solve rather than lagged — lagging it by an iteration was tried first
  // and found to diverge (Ic is too steep a function of Vbe for that to stay
  // stable). Saturation is modeled as a second binary state per transistor,
  // on the same relaxation loop: if the active-region math would drive Vce
  // below a realistic floor (~0.2V), the collector-emitter path switches
  // from "current source" to "small clamp resistance pinning Vce near that
  // floor" instead, and whatever current the external circuit (Rc, supply
  // voltage) can actually push through that clamp becomes Ic — reverting
  // back to active mode once that current would exceed what hFE*Ib allows
  // (the standard "check which constraint is violated, enforce the other"
  // piecewise treatment). Capacitors are intentionally not added as edges
  // here — a cap really does block DC, so it correctly stays isolated from
  // the rest of the net in this DC-only model.
  const RON    = 1;     // ohms — small "on" resistance for a conducting diode/LED
  const ROFF   = 1e9;   // ohms — effectively open for a non-conducting diode/LED
  const RBE    = 10000; // ohms — effective "on" resistance of a transistor's base-emitter junction past Vbe (same figure the old per-instance-only approximation used)
  const RSAT   = 1;     // ohms — small "on" resistance of the saturation clamp (collector-emitter, once saturated)
  // volts — fallback floor for Vce (or Vec for PNP) once a transistor
  // saturates, used only when the model has no vce_sat of its own. Every
  // model in the component JSON does define one, and germanium's (0.1V) is
  // half silicon's, so the per-model value is read from pm.vce_sat at edge
  // build time (see bjtEdges below). This constant used to be applied to
  // every transistor regardless of material, which clamped germanium parts
  // at the silicon floor.
  const VCESAT_FALLBACK = 0.2;
  const EPS    = 1e-12; // tiny leak-to-ground on every net so isolated islands don't produce a singular matrix

  function solveNetVoltages(placed, nets, fixedNodes, extraResistorEdges) {
    extraResistorEdges = extraResistorEdges || [];
    const fixed = new Map();
    for (const { net, voltage } of fixedNodes) { if (net != null) fixed.set(net, voltage); }

    function netOf(row, col) { return nets.find(nets.key(row, col)); }

    const resistorEdges = [...extraResistorEdges]; // {a,b,R}
    const diodeEdges    = []; // {a,b,Vf,inst}  a=anode net, b=cathode net
    const bjtEdges      = []; // {a,b,Vf,inst,hfe,collector,pnp}  a/b = B-E junction's anode/cathode nets (base/emitter for NPN, emitter/base for PNP)

    for (const inst of placed) {
      if (inst.failed) continue;
      const def = ComponentRegistry.getById(inst.defId);
      const btype = def?.behavior?.type;

      if (btype === 'resistor') {
        const R = resolvedValue(inst, 'resistance', 1000);
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

      } else if (btype === 'bjt_npn' || btype === 'bjt_pnp') {
        const pnp = btype === 'bjt_pnp';
        const mk  = inst.props.model || (pnp ? '2N3906' : '2N3904');
        const pm  = def.model_params?.[mk] || {};
        const hfe = parseFloat(inst.props.hfe) || pm.hfe || 100;
        // ICBO is collector-base junction leakage. It's stamped as a real
        // current source from collector to base (see the bjtEdges loop) and
        // the solve decides how much of it gets amplified, rather than being
        // pre-multiplied here.
        //
        // This used to be `(hFE+1) * ICBO` stamped collector-to-emitter. That
        // formula is the ICEO case, meaning base OPEN — the maximum possible
        // multiplication, not the general one. In a real circuit the base
        // isn't open: leakage arriving at the base splits between the base
        // network and the B-E junction, so the real multiplication runs from
        // ~1x (base shorted to emitter) up to (hFE+1)x (base open), set by
        // the base circuit's impedance. Applying the base-open maximum
        // unconditionally made realistic germanium ICBO values unusable — a
        // Fuzz Face with 5uA on both transistors had BOTH collector currents
        // pinned at exactly (hFE+1)*ICBO, the bias network contributing
        // nothing, and anything at or above 10uA drove the collector to a
        // non-physical negative voltage. Real builders run these parts at
        // 50-150uA.
        //
        // Stamping it at the base instead needs no special-casing: current
        // into the base raises Vbe, and the existing gm stamp amplifies
        // whatever the solve settles on. Base open still yields (hFE+1)*ICBO,
        // now as an emergent result rather than a hardcoded assumption.
        const icboNa = parseFloat(inst.props.leakage) || pm.icbo_na || 0;
        const Icbo = icboNa / 1e9; // nA -> A, raw junction leakage, NOT pre-multiplied
        const Vf  = pm.vbe || 0.65; // magnitude of the turn-on threshold, whichever junction direction applies
        const eIdx = (inst.props.pinout === 'CBE') ? 2 : 0;
        const cIdx = eIdx === 0 ? 2 : 0;
        const baseNet = netOf(inst.legs[1].row, inst.legs[1].col);
        const emitterNet = netOf(inst.legs[eIdx].row, inst.legs[eIdx].col);
        const collectorNet = netOf(inst.legs[cIdx].row, inst.legs[cIdx].col);
        // NPN: junction conducts base→emitter (anode=base, cathode=emitter),
        // and collector current is injected at the emitter / extracted from
        // the collector (external current flows in at collector, out at
        // emitter). PNP mirrors both: junction conducts emitter→base, and
        // collector current is injected at the collector / extracted from
        // the emitter.
        const a = pnp ? emitterNet : baseNet;
        const b = pnp ? baseNet : emitterNet;
        const icSrc  = pnp ? collectorNet : emitterNet;  // where Ic is injected
        const icSink = pnp ? emitterNet   : collectorNet; // where Ic is extracted from
        const vceSat = Number.isFinite(parseFloat(pm.vce_sat)) ? parseFloat(pm.vce_sat) : VCESAT_FALLBACK;
        bjtEdges.push({ a, b, Vf, inst, gm: hfe/RBE, icSrc, icSink, pnp, Icbo, vceSat,
                        baseNet, collectorNet });
      }
    }

    const netIndex = new Map();
    const register = net => { if (net!=null && !fixed.has(net) && !netIndex.has(net)) netIndex.set(net, netIndex.size); };
    resistorEdges.forEach(e => { register(e.a); register(e.b); });
    diodeEdges.forEach(e => { register(e.a); register(e.b); });
    bjtEdges.forEach(e => { register(e.a); register(e.b); register(e.icSrc); register(e.icSink); });

    const N = netIndex.size;
    const netVoltage = new Map(fixed);
    const diodeCurrents = new Map();
    const bjtCurrents = new Map(); // inst -> { Ib, Ic }
    if (N === 0) return { netVoltage, diodeCurrents, bjtCurrents };

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
    // Dependent collector current source: Ic = gm*(Va-Vb) - gm*Vf, where a/b
    // are the B-E junction's own anode/cathode (so this reuses exactly the
    // same junction voltage the B-E stamp above is keyed on), injected at
    // e.icSrc and extracted at e.icSink. This is linear in the node voltages
    // (gm = hFE/RBE is a fixed number once the junction's on/off state is
    // decided for this iteration), so — unlike the B-E on/off state itself —
    // it needs no relaxation: it's stamped directly into the same matrix and
    // solved in one shot, staying exactly consistent with whatever Ib the
    // solve converges to.
    function stampBjtIc(G, I, e, gm) {
      const pIdx = netIndex.has(e.a) ? netIndex.get(e.a) : -1;
      const qIdx = netIndex.has(e.b) ? netIndex.get(e.b) : -1;
      const pFixed = fixed.has(e.a), qFixed = fixed.has(e.b);
      const srcIdx  = netIndex.has(e.icSrc)  ? netIndex.get(e.icSrc)  : -1;
      const sinkIdx = netIndex.has(e.icSink) ? netIndex.get(e.icSink) : -1;

      if (srcIdx >= 0) {
        if (pIdx>=0) G[srcIdx][pIdx] -= gm; else if (pFixed) I[srcIdx] += gm*fixed.get(e.a);
        if (qIdx>=0) G[srcIdx][qIdx] += gm; else if (qFixed) I[srcIdx] -= gm*fixed.get(e.b);
        I[srcIdx] -= gm*e.Vf;
      }
      if (sinkIdx >= 0) {
        if (pIdx>=0) G[sinkIdx][pIdx] += gm; else if (pFixed) I[sinkIdx] -= gm*fixed.get(e.a);
        if (qIdx>=0) G[sinkIdx][qIdx] -= gm; else if (qFixed) I[sinkIdx] += gm*fixed.get(e.b);
        I[sinkIdx] += gm*e.Vf;
      }
    }

    let states = diodeEdges.map(() => false);
    let bjtStates = bjtEdges.map(() => false);
    let satStates = bjtEdges.map(() => false); // true once a bjt is clamped into saturation
    let V = new Array(N).fill(0);

    for (let iter=0; iter<15; iter++) {
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
      bjtEdges.forEach((e, idx) => {
        if (e.a==null || e.b==null || e.a===e.b) return;
        const on = bjtStates[idx];
        const g = 1/(on ? RBE : ROFF);
        stampConductance(G, I, e.a, e.b, g);
        // Collector-base leakage, stamped unconditionally: the CB junction is
        // reverse-biased and leaking whatever the B-E junction is doing, and
        // regardless of saturation. NPN: conventional current enters the
        // collector terminal and leaves at the base, so inject at base and
        // extract at collector. PNP mirrors it. Whether this ends up
        // amplified is left to the solve — it depends on how much of it the
        // base network drains versus how much reaches the B-E junction.
        if (e.Icbo && e.baseNet != null && e.collectorNet != null) {
          if (e.pnp) stampCurrentSource(I, e.collectorNet, e.baseNet, e.Icbo);
          else       stampCurrentSource(I, e.baseNet, e.collectorNet, e.Icbo);
        }
        if (on) {
          stampCurrentSource(I, e.a, e.b, g*e.Vf);
          if (satStates[idx]) {
            // Saturated: collector-emitter (or emitter-collector for PNP —
            // e.icSink/e.icSrc are already oriented per polarity) behaves
            // like a small clamp resistance pinning Vce near VCESAT, rather
            // than a current source. Whatever current the external circuit
            // can actually push through that clamp becomes Ic.
            const gs = 1/RSAT;
            stampConductance(G, I, e.icSink, e.icSrc, gs);
            stampCurrentSource(I, e.icSink, e.icSrc, gs*e.vceSat);
          } else {
            stampBjtIc(G, I, e, e.gm);
          }
        }
        // Nothing extra when the B-E junction is off: the collector-to-base
        // leakage stamped above is already flowing, and if the base network
        // can't drain it, it raises Vbe until the junction turns on and the
        // relaxation loop picks that up on the next iteration. That's the
        // real mechanism, rather than a separate hardcoded "off" leakage.
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
      bjtEdges.forEach((e, idx) => {
        if (e.a==null || e.b==null) return;
        const va = netIndex.has(e.a) ? V[netIndex.get(e.a)] : fixed.get(e.a);
        const vb = netIndex.has(e.b) ? V[netIndex.get(e.b)] : fixed.get(e.b);
        const shouldBeOn = (va - vb) > e.Vf * 0.5;
        if (shouldBeOn !== bjtStates[idx]) { bjtStates[idx] = shouldBeOn; changed = true; }
        if (!shouldBeOn) {
          if (satStates[idx]) { satStates[idx] = false; changed = true; } // saturation only means anything while conducting
          return;
        }

        const vSink = netIndex.has(e.icSink) ? V[netIndex.get(e.icSink)] : fixed.get(e.icSink);
        const vSrc  = netIndex.has(e.icSrc)  ? V[netIndex.get(e.icSrc)]  : fixed.get(e.icSrc);

        if (!satStates[idx]) {
          // Active: if this operating point would require Vce below the
          // realistic floor, the external circuit can't actually sustain it —
          // switch to the clamp for the next iteration.
          const vce = vSink - vSrc;
          if (vce < e.vceSat * 0.9) { satStates[idx] = true; changed = true; }
        } else {
          // Saturated: if the clamp is passing MORE current than hFE*Ib would
          // even allow, the transistor's own gain — not the external circuit —
          // is now the binding constraint, so revert to active mode.
          const IcActiveWouldBe = Math.max(0, e.gm*((va-vb) - e.Vf)) + (e.Icbo||0);
          const IcSatActual = Math.max(0, (1/RSAT)*((vSink-vSrc) - e.vceSat));
          if (IcSatActual > IcActiveWouldBe) { satStates[idx] = false; changed = true; }
        }
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
    bjtEdges.forEach((e, idx) => {
      if (e.a==null || e.b==null) { bjtCurrents.set(e.inst, { Ib:0, Ic:0, vce:0, saturated:false }); return; }
      const va = netIndex.has(e.a) ? V[netIndex.get(e.a)] : fixed.get(e.a);
      const vb = netIndex.has(e.b) ? V[netIndex.get(e.b)] : fixed.get(e.b);
      const on = bjtStates[idx];
      const g = 1/(on ? RBE : ROFF);
      const Ib = on ? Math.max(0, g*((va-vb) - e.Vf)) : 0;
      const vSink = netIndex.has(e.icSink) ? V[netIndex.get(e.icSink)] : fixed.get(e.icSink);
      const vSrc  = netIndex.has(e.icSrc)  ? V[netIndex.get(e.icSrc)]  : fixed.get(e.icSrc);
      const vce = vSink - vSrc; // Vce for NPN, Vec for PNP (icSink/icSrc already oriented per polarity)
      // Total current at the collector terminal: the amplified part plus the
      // collector-base leakage, which flows through the collector whatever
      // the junction is doing. The leakage's AMPLIFIED contribution is
      // already inside the gm term, via the Vbe the solve arrived at.
      let Ic = 0;
      if (on) {
        Ic = satStates[idx]
          ? Math.max(0, (1/RSAT)*(vce - e.vceSat))
          : Math.max(0, e.gm*((va-vb) - e.Vf));
      }
      Ic += (e.Icbo || 0); // leaks even with the junction off
      bjtCurrents.set(e.inst, { Ib, Ic, vce, saturated: satStates[idx] && on });
    });

    return { netVoltage, diodeCurrents, bjtCurrents };
  }

  // ── Small-signal (AC) solve ───────────────────────────────────────────────
  // The same nodal machinery as solveNetVoltages, but linearized for SIGNAL
  // rather than DC. Differences, all of them deliberate:
  //
  //   - The SUPPLY rail is AC ground. A supply is a low impedance at signal
  //     frequencies, so a collector resistor to V+ loads the collector exactly
  //     as one to ground would.
  //   - Coupling capacitors are SHORTS. Every corner frequency in a pedal sits
  //     below the audio band once computed properly (see audio-engine's
  //     acLoadResistance), so across the band they simply pass signal. The
  //     frequency shaping is handled separately by the biquads.
  //   - Transistors use the hybrid-pi small-signal model: r_pi between base and
  //     emitter, plus a gm*Vbe controlled current source into the collector.
  //     r_pi = hFE/gm is bias-dependent, unlike the DC solve's fixed RBE.
  //   - Diodes contribute their small-signal resistance Vt/I only when actually
  //     conducting; an off diode is an open, which is what a clipping pair
  //     sitting at 0V DC should be.
  //   - The INPUT net is driven at exactly 1V, so every solved node voltage IS
  //     that node's voltage gain relative to the input.
  //
  // Why this exists: it is the only thing in the engine that models FEEDBACK
  // (a nodal solve doesn't care that the netlist contains loops, so a Fuzz
  // Face's collector-to-base resistor finally participates), and it is what
  // lets a POTENTIOMETER be modelled once, as two resistors and a tap, with
  // volume/tone/fuzz behaviour emerging from the surrounding network instead
  // of from a per-use-case rule. See CLAUDE.md's note on the AC solve.
  const CAP_AC_SHORT_R = 0.01; // ohms — a coupling cap across the audio band
  const VT            = 0.026; // thermal voltage, same as the audio engine uses

  function solveSmallSignal(placed, nets, inputNet, acGroundNets) {
    if (inputNet == null) return null;
    const netOf = (row, col) => nets.find(nets.key(row, col));

    const fixed = new Map();
    for (const n of acGroundNets) if (n != null) fixed.set(n, 0);
    if (fixed.has(inputNet)) return null; // input shorted to ground/supply — no meaningful drive
    fixed.set(inputNet, 1);

    const edges = []; // { a, b, G }
    const vccs  = []; // { p, q, src, sink, gm } : gm*(Vp-Vq) injected at src, extracted at sink

    for (const inst of placed) {
      if (inst.failed) continue;
      const def = ComponentRegistry.getById(inst.defId);
      const bt  = def?.behavior?.type;
      const L   = inst.legs;

      if (bt === 'resistor' && L.length >= 2) {
        const R = resolvedValue(inst, 'resistance', 1000);
        edges.push({ a: netOf(L[0].row, L[0].col), b: netOf(L[L.length-1].row, L[L.length-1].col),
                     G: 1 / Math.max(R, 1e-6) });

      } else if (bt === 'potentiometer' && L.length >= 3) {
        // Identical to the DC model: two resistors and a tap. Nothing here
        // knows or cares whether this is a volume, tone or fuzz control.
        const Rt = parseFloat(inst.props.resistance) || 100000;
        const parsedW = parseFloat(inst.props.wiper);
        const w   = Number.isNaN(parsedW) ? 0.5 : parsedW;
        const pos = (inst.props.taper||'').includes('Audio') ? Math.pow(w,2) : w;
        edges.push({ a: netOf(L[0].row, L[0].col), b: netOf(L[1].row, L[1].col), G: 1/Math.max(Rt*pos, 1) });
        edges.push({ a: netOf(L[1].row, L[1].col), b: netOf(L[2].row, L[2].col), G: 1/Math.max(Rt*(1-pos), 1) });

      } else if (bt === 'capacitor' && L.length >= 2) {
        edges.push({ a: netOf(L[0].row, L[0].col), b: netOf(L[L.length-1].row, L[L.length-1].col),
                     G: 1 / CAP_AC_SHORT_R });

      } else if ((bt === 'diode' || bt === 'led') && L.length >= 2) {
        const I = inst._current || 0;
        if (I <= 0) continue; // off: open circuit, contributes nothing
        edges.push({ a: netOf(L[0].row, L[0].col), b: netOf(L[L.length-1].row, L[L.length-1].col),
                     G: I / VT }); // 1/(Vt/I)

      } else if ((bt === 'bjt_npn' || bt === 'bjt_pnp') && L.length >= 3) {
        const pnp = bt === 'bjt_pnp';
        const pm  = def.model_params?.[inst.props.model] || {};
        const hfe = parseFloat(inst.props.hfe) || pm.hfe || 100;
        const Ic  = Math.max(inst._current || 0, 1e-6);
        const gm  = Ic / VT;
        const rpi = Math.max(hfe / gm, 1);
        const eIdx = (inst.props.pinout === 'CBE') ? 2 : 0;
        const cIdx = eIdx === 0 ? 2 : 0;
        const bN = netOf(L[1].row, L[1].col);
        const eN = netOf(L[eIdx].row, L[eIdx].col);
        const cN = netOf(L[cIdx].row, L[cIdx].col);
        edges.push({ a: bN, b: eN, G: 1/rpi });
        // Orientation mirrors the DC solver's stampBjtIc exactly.
        if (pnp) vccs.push({ p: eN, q: bN, src: cN, sink: eN, gm });
        else     vccs.push({ p: bN, q: eN, src: eN, sink: cN, gm });

      } else if (bt === 'switch_spst') {
        // Already unioned into one net by buildNetMap when closed; open
        // switches correctly leave the two sides unconnected.
      }
    }

    // index the free (non-fixed) nets
    const idx = new Map();
    const reg = n => { if (n != null && !fixed.has(n) && !idx.has(n)) idx.set(n, idx.size); };
    for (const e of edges) { reg(e.a); reg(e.b); }
    for (const v of vccs)  { reg(v.p); reg(v.q); reg(v.src); reg(v.sink); }

    const N = idx.size;
    const out = new Map(fixed);
    if (N === 0) return out;

    const G = Array.from({length:N}, () => new Array(N).fill(0));
    const I = new Array(N).fill(0);
    for (let i=0;i<N;i++) G[i][i] += EPS;

    for (const e of edges) {
      if (e.a == null || e.b == null || e.a === e.b) continue;
      const ai = idx.has(e.a) ? idx.get(e.a) : -1;
      const bi = idx.has(e.b) ? idx.get(e.b) : -1;
      if (ai>=0) G[ai][ai] += e.G;
      if (bi>=0) G[bi][bi] += e.G;
      if (ai>=0 && bi>=0) { G[ai][bi] -= e.G; G[bi][ai] -= e.G; }
      else if (ai>=0 && fixed.has(e.b)) I[ai] += e.G * fixed.get(e.b);
      else if (bi>=0 && fixed.has(e.a)) I[bi] += e.G * fixed.get(e.a);
    }

    for (const v of vccs) {
      const pi = idx.has(v.p) ? idx.get(v.p) : -1, qi = idx.has(v.q) ? idx.get(v.q) : -1;
      const si = idx.has(v.src) ? idx.get(v.src) : -1, ki = idx.has(v.sink) ? idx.get(v.sink) : -1;
      if (si>=0) {
        if (pi>=0) G[si][pi] -= v.gm; else if (fixed.has(v.p)) I[si] += v.gm*fixed.get(v.p);
        if (qi>=0) G[si][qi] += v.gm; else if (fixed.has(v.q)) I[si] -= v.gm*fixed.get(v.q);
      }
      if (ki>=0) {
        if (pi>=0) G[ki][pi] += v.gm; else if (fixed.has(v.p)) I[ki] -= v.gm*fixed.get(v.p);
        if (qi>=0) G[ki][qi] -= v.gm; else if (fixed.has(v.q)) I[ki] += v.gm*fixed.get(v.q);
      }
    }

    const V = gaussianSolve(G, I);
    for (const [net, i] of idx) out.set(net, V[i]);
    return out;
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
  // Prefers a component's tolerance-resolved actual value (see
  // components-registry.js's applyToleranceRoll) over its nominal one — this
  // is what makes tolerance actually affect the simulation rather than just
  // being a label. Falls back to the nominal value for components that
  // predate the tolerance feature (no `<key>_actual` stored yet), then to
  // the caller's own fallback if neither is a valid number.
  function resolvedValue(inst, key, fallback) {
    const actual = parseFloat(inst.props[key+'_actual']);
    if (Number.isFinite(actual)) return actual;
    const nominal = parseFloat(inst.props[key]);
    return Number.isFinite(nominal) ? nominal : fallback;
  }

  // Real bias sag isn't purely a DC-current phenomenon — a transistor's
  // base-emitter junction rectifies a large AC swing, drawing measurably
  // more average current under a heavy signal than a silent DC solve alone
  // would ever show. Rather than routing live audio through the netlist's
  // coupling caps to capture that directly (a much bigger, riskier change
  // to how capacitors are modeled everywhere), this adds the live input
  // signal's energy as a second, independent contribution to how hard the
  // battery's being asked to work, on top of the real measured DC current
  // below. Returns 0..1, added to the DC-current-based sag factor.
  // Calibration (the /0.3 divisor) is provisional — needs an ear-tuning
  // pass once this is actually testable in-browser, same as the audio
  // gain knee constants were.
  function signalSagFactor() {
    if (typeof AudioEngine === 'undefined' || !AudioEngine.isRunning || !AudioEngine.isRunning() || !AudioEngine.getInputRMS) return 0;
    return Utils.clamp(AudioEngine.getInputRMS() / 0.3, 0, 1);
  }

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

    // Power rails span the full board width, no break — both top (fed by
    // the permanent supply) and bottom (unpowered by default, needs a
    // user-placed jumper or power_supply component to do anything) rails
    // are each one continuous electrical segment.
    for (const rr of ['rtp','rtm','rbp','rbm']) {
      for (let col=1; col<=62; col++) union(key(rr,0), key(rr,col));
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
    const which = inst.props?.title ? `"${inst.props.title}" (${inst.instanceId})` : inst.instanceId;
    if (_onFailure) _onFailure({
      icon: icons[fm?.result]||'💥',
      title: `${def.label} Failed — ${which}`,
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

  // First semiconductor terminal (transistor/diode/LED leg) that has nothing
  // else on its net, or null if every one is connected to something.
  //
  // Only semiconductors are checked. A resistor or capacitor with one leg
  // parked in an empty row is a normal in-progress board state and shouldn't
  // stop the sim, whereas a transistor terminal going nowhere means the part
  // can't conduct at all and every number downstream is meaningless.
  //
  // Rails are exempt (they're real conductors carrying the supply), as are
  // the workbench's Input and Output holes, where a single leg landing alone
  // is exactly how those are meant to be connected.
  function findFloatingTerminal(placed, nets) {
    const cp = (typeof WorkbenchStrip !== 'undefined' && WorkbenchStrip.getConnectionPoints)
      ? WorkbenchStrip.getConnectionPoints() : null;
    const exempt = new Set(['rtp','rtm','rbp','rbm'].map(r => nets.find(nets.key(r, 0))));
    if (cp) {
      exempt.add(nets.find(nets.key(cp.firstRow, cp.inputCol)));
      exempt.add(nets.find(nets.key(cp.firstRow, cp.outputCol)));
    }

    const legsOnNet = new Map();
    for (const inst of placed) {
      if (inst.failed) continue;
      for (const l of inst.legs) {
        const n = nets.find(nets.key(l.row, l.col));
        legsOnNet.set(n, (legsOnNet.get(n) || 0) + 1);
      }
    }

    for (const inst of placed) {
      if (inst.failed) continue;
      const def = ComponentRegistry.getById(inst.defId);
      const bt = def?.behavior?.type;
      if (bt !== 'bjt_npn' && bt !== 'bjt_pnp' && bt !== 'diode' && bt !== 'led') continue;
      for (let i = 0; i < inst.legs.length; i++) {
        const n = nets.find(nets.key(inst.legs[i].row, inst.legs[i].col));
        if (exempt.has(n) || (legsOnNet.get(n) || 0) > 1) continue;
        return {
          who:   inst.props?.title || def?.label || inst.instanceId,
          leg:   def?.leg_labels?.[i] ? `${def.leg_labels[i]} leg` : `leg ${i + 1}`,
          label: def?.label || 'component',
        };
      }
    }
    return null;
  }

  // Human-readable name for a net, for error messages: the first component
  // leg found sitting on it, named by the user's own title where they set one
  // and by the def's leg labels ('C', 'B', 'E', '+', '-') for the terminal.
  // Falls back to a generic phrase rather than exposing an internal net id,
  // which would mean nothing to someone looking at a breadboard.
  function describeNet(net, placed, nets) {
    for (const inst of placed) {
      const def = ComponentRegistry.getById(inst.defId);
      const legLabels = def?.leg_labels || [];
      for (let i = 0; i < inst.legs.length; i++) {
        const l = inst.legs[i];
        if (nets.find(nets.key(l.row, l.col)) !== net) continue;
        const who = inst.props?.title || def?.label || inst.instanceId;
        return legLabels[i] ? `${who}'s ${legLabels[i]} leg` : who;
      }
    }
    return 'A point on the board';
  }

  function formatVolts(v) {
    if (!Number.isFinite(v)) return 'a non-numeric value';
    return (Math.abs(v) >= 1e6 ? v.toExponential(2) : v.toFixed(2)) + 'V';
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

  // A switch changing state is the one thing that alters board TOPOLOGY while
  // the circuit is engaged (switches are deliberately exempt from the
  // engaged-lock — they're runtime controls, not edits). All four callers of
  // this are switch toggles in board.js.
  //
  // tick() re-solves DC first, THEN the topology callback fires, because the
  // audio rebuild reads this solve's inst._current/_vceHeadroom to compute
  // transistor stage gain. Reversing that order would rebuild every stage from
  // the pre-toggle operating point.
  function notifyStateChange(inst) {
    if (!_running) return;
    tick();
    // tick() can fail() and stop the sim. Don't rebuild the audio graph for a
    // circuit that just blew up — the failure handler has already stopped
    // AudioEngine, and its own guard would no-op anyway.
    if (_running && _onTopologyChange) _onTopologyChange();
  }
  function onFailure(fn) { _onFailure=fn; }
  function onUpdate(fn)  { _onUpdate=fn; }
  function onTopologyChange(fn) { _onTopologyChange=fn; }

  // Whether two specific holes are on the same electrical net right now —
  // reuses buildNetMap() exactly as tick() does (same wires, same closed-
  // switch handling), so this always matches what the simulation itself
  // would consider connected.
  //
  // Currently UNUSED. It was written for AudioEngine to check whether an
  // engaged bypass has a complete Input->Output path, but AudioEngine
  // answers that from its own walk instead (walk.reachedOutput), which is
  // strictly better: it means a real component-mediated path exists, not
  // just electrical continuity through a wire. Kept as a public query
  // helper; delete it if nothing has picked it up.
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

  // net -> small-signal voltage gain relative to the input (see
  // solveSmallSignal). Null until the first tick, or if there's no input.
  function getSmallSignalV() { return _lastSmallSignal; }

  return { start,stop,reset,isRunning,tick,onFailure,onUpdate,onTopologyChange,notifyStateChange,hasElectricalPath,getVoltageAt,getSmallSignalV,buildNetMap };
})();