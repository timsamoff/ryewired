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
      failBoard('🔌', I18n.t('app.simulation.disconnectedLegTitle'),
        I18n.t('app.simulation.disconnectedLegMessage', { who: floating.who, leg: floating.leg, label: floating.label }));
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

    const { netVoltage, diodeCurrents, zenerCurrents, bjtCurrents, jfetCurrents, mosfetCurrents, opampStates } = solveNetVoltages(placed, nets, fixedNodes, extraResistorEdges);
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
      try { solveComponent(inst, def, nets, netVoltage, placed, diodeCurrents, zenerCurrents, bjtCurrents, jfetCurrents, mosfetCurrents, opampStates); }
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
  function solveComponent(inst, def, nets, netVoltage, placed, diodeCurrents, zenerCurrents, bjtCurrents, jfetCurrents, mosfetCurrents, opampStates) {
    const btype = def.behavior?.type;

    switch(btype) {

      case 'dc_supply':
        inst._voltage = parseFloat(inst.props.voltage) || 9;
        break;

      case 'opamp_dual': {
        // Per-unit ['linear'|'sat_high'|'sat_low', ...], read by
        // audio-engine.js to pick the right small-signal/clip behavior per
        // unit — same "state set during the DC pass, read back later"
        // pattern as _zenerState.
        inst._opampState = opampStates?.get(inst) || null;
        // Supply over-voltage: the only failure mode that makes sense here,
        // since this app has no negative-rail concept (see opampEdges'
        // comment in solveNetVoltages) — there's no Vce/Vds-style per-branch
        // voltage to exceed, only the chip's own rated max SINGLE supply
        // voltage (supply_max, already in volts in the component JSON,
        // unlike max_ic_ma elsewhere — no unit conversion needed here).
        const mkV = inst.props.model || 'JRC4558';
        const pmV = def.model_params?.[mkV] || {};
        const supplyMax = pmV.supply_max || 18;
        if ((_activeSupplyV ?? 0) > supplyMax) fail(inst, def, 'over_voltage');
        break;
      }

      case 'pt2399_delay': {
        // Same per-unit state pattern as opamp_dual — OP1 is slot 0, OP2 is
        // slot 1 (see the opampEdges push order in the DC-edges loop above).
        inst._opampState = opampStates?.get(inst) || null;
        // Only supply over-voltage makes sense as a failure mode here, same
        // reasoning as opamp_dual — no negative-rail concept in this app, and
        // the datasheet's rated 4.5-5.5V window is narrow enough that this is
        // the realistic way a PT2399 actually dies in a hand-built pedal
        // (fed 9V directly instead of through the required 5V regulator).
        const pmP = def.model_params?.PT2399 || {};
        const supplyMaxP = pmP.supply_max || 5.5;
        if ((_activeSupplyV ?? 0) > supplyMaxP) fail(inst, def, 'over_voltage');
        break;
      }

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

      case 'zener_diode': {
        const mk  = inst.props.model || '1N4742A';
        const pm  = def.model_params?.[mk] || {};
        const IzmA = (pm.izm_ma || 150) / 1000;

        // No reverse_voltage failure here, deliberately — unlike a signal
        // diode, a Zener is DESIGNED to sit in reverse breakdown as its
        // normal operating mode (that's the whole point of the part), so
        // treating "in breakdown" as a fault would make the component
        // impossible to use for what it's for. The only real failure mode
        // is thermal: drawing more current than the part's rated Izm can
        // dissipate, in EITHER direction (forward overcurrent is also
        // possible, if unusual for how these are normally wired).
        const zc = zenerCurrents?.get(inst) ?? { current: 0, state: 'off' };
        inst._current = zc.current;
        inst._zenerState = zc.state; // read back by solveSmallSignal, which has no netVoltage of its own to re-derive this from
        if (zc.current > IzmA) fail(inst, def, 'over_current');
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

      case 'jfet_n': {
        const mk = inst.props.model || 'J201';
        const pm = def.model_params?.[mk] || {};
        const IdMax = (pm.max_id_ma || 20) / 1000;
        const c = jfetCurrents?.get(inst);
        const Id = c?.Id || 0;
        inst._current = Id;
        inst._triode = !!c?.triode;
        if (Id > IdMax) fail(inst, def, 'over_current');
        break;
      }

      case 'mosfet_n': {
        const mk = inst.props.model || '2N7000';
        const pm = def.model_params?.[mk] || {};
        const IdMax = (pm.max_id_ma || 200) / 1000;
        const c = mosfetCurrents?.get(inst);
        const Id = c?.Id || 0;
        inst._current = Id;
        inst._triode = !!c?.triode;
        inst._on = !!c?.on;
        if (Id > IdMax) fail(inst, def, 'over_current');
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
  // ohms — effective "on" resistance of a transistor's base-emitter junction
  // past Vbe. Used as the iteration-0 starting value (before any Ic estimate
  // exists) and as a floor, below RBE_MIN, on the bias-dependent r_pi
  // computed each iteration below. A real junction is exponential, not a
  // fixed resistance: r_pi = hFE*Vt/Ic (Vt ~= 26mV), which is what
  // solveSmallSignal already uses. Treating it as this fixed 10k regardless
  // of current was fine for silicon (nanoamp leakage keeps Ib negligible
  // either way) but broke germanium, whose realistic 50-300uA of ICBO
  // multiplied by 10k adds 0.5-3V of fictitious Vbe — enough on its own to
  // saturate a stage that a real germanium Fuzz Face biases correctly.
  const RBE     = 10000;
  const VT      = 0.026; // volts, thermal voltage at room temperature
  const RBE_MIN = 20;    // ohms — floor for r_pi so a runaway high Ic estimate can't divide the base conductance toward a singular stamp
  const RBE_MAX = RBE;   // ceiling — never worse than the old fixed behavior
  // amps — sanity ceiling on the Ic ESTIMATE carried between iterations for
  // r_pi = hFE*Vt/Ic (not a real device limit; those live per-model as
  // max_ic_ma). The relaxation loop's early iterations can legitimately
  // overshoot by hundreds of volts before bjtStates/satStates converge —
  // e.g. an AC128 on a 1.8M base resistor solves iteration 0 at Vbe=458V,
  // implying several AMPS of Ic, before settling to 0.64mA by iteration 2 —
  // and that was always harmless before because only the booleans carried
  // forward. icEstimate is a VALUE carried forward, so an overshoot
  // iteration otherwise poisons the very next iteration's r_pi. No real part
  // in this engine draws anywhere near 1A; this exists only to reject
  // solver noise, not to model an actual current limit.
  const IC_ESTIMATE_CEILING = 1; // A
  // A real transistor's hFE is not constant with Ic — every datasheet's
  // rated hFE is measured at a specific test current (often ~1mA for
  // small-signal parts regardless of type; confirmed against a real
  // NKT275 datasheet, Ie=1.0mA), and gain falls off well below that as
  // base-region recombination current starts to dominate over the
  // amplifying diffusion current. Treating hFE as one fixed number
  // regardless of Ic was fine as long as every transistor operated near
  // its rated test current, but a leakage-dominated germanium stage can
  // run its BASE current in the single-digit microamps — three orders of
  // magnitude below HFE_REF_IC — where (hFE+1)*Icbo's amplified leakage
  // then gets the full, undiminished rated hFE applied to it. Real
  // hardware doesn't do this (a schematically-correct Fuzz Face biases
  // fine on the bench); this rolloff is what was missing.
  //
  // No per-model rolloff data exists for the other 25 transistors in this
  // library (one real datasheet page doesn't generalize into 26), so this
  // is deliberately ONE generic curve applied to every model alike:
  // hFE_effective = hFE_rated * clamp(Ic/HFE_REF_IC, HFE_ROLLOFF_FLOOR, 1).
  // Full rated hFE at/above the reference current (matching the datasheet
  // exactly at its own test point), scaling down proportionally below it,
  // floored so gain never fully collapses (real transistors don't either).
  // An approximation of a real curve's shape, not a per-device fit —
  // revisit if a specific model's real low-current hFE data ever surfaces.
  const HFE_REF_IC       = 0.001; // A — assumed datasheet test current
  const HFE_ROLLOFF_FLOOR = 0.1;  // fraction of rated hFE, at very low Ic
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
  const BIG_G  = 1e9;   // stiff conductance used to pin a node to a fixed voltage mid-solve (op-amp saturation clamp) — same role as fixedNodes' handling but for a state that can change iteration to iteration

  function solveNetVoltages(placed, nets, fixedNodes, extraResistorEdges) {
    extraResistorEdges = extraResistorEdges || [];
    const fixed = new Map();
    for (const { net, voltage } of fixedNodes) { if (net != null) fixed.set(net, voltage); }

    function netOf(row, col) { return nets.find(nets.key(row, col)); }

    const resistorEdges = [...extraResistorEdges]; // {a,b,R}
    const diodeEdges    = []; // {a,b,Vf,inst}  a=anode net, b=cathode net
    const zenerEdges    = []; // {a,b,Vz,Zzt,inst}  a=anode net, b=cathode net — see the zener_diode state machine below
    const bjtEdges      = []; // {a,b,Vf,inst,hfe,collector,pnp}  a/b = B-E junction's anode/cathode nets (base/emitter for NPN, emitter/base for PNP)
    const jfetEdges     = []; // {gateNet,sourceNet,drainNet,inst,idss,vgsOff}  N-channel only for now
    const mosfetEdges   = []; // {gateNet,sourceNet,drainNet,inst,vgsTh,k}  N-channel enhancement-mode only for now
    const opampEdges    = []; // {vpNet,vmNet,voutNet,inst,unit,aol,headroomLo,headroomHi,railHi,railLo}  one entry per op-amp UNIT (2 per DIP-8 package)

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
        const parsedW = parseFloat(inst.props.wiper);
        const w   = Number.isNaN(parsedW) ? 0.5 : parsedW; // NOT `|| 0.5` — a real, valid wiper of exactly 0 is not "missing"
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

      } else if (btype === 'zener_diode') {
        const mk  = inst.props.model || '1N4742A';
        const pm  = def.model_params?.[mk] || {};
        const Vz  = parseFloat(inst.props.zener_voltage) || pm.vz || 12;
        // Zzt: real per-model dynamic impedance at the datasheet's rated test
        // current (see CLAUDE.md/component notes) — this is what gives the
        // clamped region a small, realistic upward slope with current
        // instead of pinning dead-flat at Vz, same spirit as a real
        // regulator's load-dependent output. Falls back to a generic 10ohm
        // if a model's Zzt is somehow missing, rather than defaulting to 0
        // (a literal short) or a huge number (defeating the clamp).
        const Zzt = pm.zzt || 10;
        const a   = netOf(inst.legs[0].row, inst.legs[0].col);              // anode
        const b   = netOf(inst.legs[inst.legs.length-1].row, inst.legs[inst.legs.length-1].col); // cathode
        zenerEdges.push({ a, b, Vz, Zzt, inst });

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
        // rbe starts at the fixed fallback and is re-estimated from the
        // solve's own Ic each iteration below (see rEstimate) — this initial
        // value only matters for iteration 0, before any Ic estimate exists.
        // hfeRated is the fixed datasheet value; hfe (below) is re-derived
        // each iteration as the low-current-rolled-off EFFECTIVE gain — see
        // HFE_REF_IC/HFE_ROLLOFF_FLOOR above for why they're not the same.
        bjtEdges.push({ a, b, Vf, inst, hfeRated: hfe, hfe, gm: hfe/RBE, rbe: RBE, icSrc, icSink, pnp, Icbo, vceSat,
                        baseNet, collectorNet });

      } else if (btype === 'jfet_n') {
        // Voltage-controlled, unlike a BJT: the gate draws no DC current
        // (ideal — real gate leakage is picoamps, negligible at this
        // model's precision, so it's not stamped at all), and drain current
        // is a smooth function of Vgs with no on/off threshold to relax
        // toward. That means no bjtStates-style boolean state is needed
        // here — only the current ESTIMATE (see jfetIdEstimate below) needs
        // relaxation, because Id depends on Vgs which depends on the very
        // node voltages being solved for.
        const mk = inst.props.model || 'J201';
        const pm = def.model_params?.[mk] || {};
        const idssMa = parseFloat(inst.props.idss) || pm.idss_ma || 2.0;
        const idss = idssMa / 1000; // mA -> A
        const vgsOff = parseFloat(inst.props.vgs_off) || pm.vgs_off || -0.7;
        // Per-pinout leg order — unlike a BJT, the gate isn't always the
        // middle leg: BF245A's real TO-92 lead order is Gate-Source-Drain,
        // confirmed against its datasheet ("1. Gate 2. Source 3. Drain").
        const JFET_PINOUTS = { SGD: [0,1,2], DGS: [2,1,0], GSD: [1,0,2] }; // [sourceLegIdx, gateLegIdx, drainLegIdx]
        const [sIdx, gIdx, dIdx] = JFET_PINOUTS[inst.props.pinout] || JFET_PINOUTS.SGD;
        const gateNet = netOf(inst.legs[gIdx].row, inst.legs[gIdx].col);
        const sourceNet = netOf(inst.legs[sIdx].row, inst.legs[sIdx].col);
        const drainNet = netOf(inst.legs[dIdx].row, inst.legs[dIdx].col);
        const vdsSat = 0.2; // volts — floor for Vds once the device enters triode/ohmic region, same role as BJT's VCESAT_FALLBACK
        jfetEdges.push({ inst, gateNet, sourceNet, drainNet, idss, vgsOff, vdsSat });

      } else if (btype === 'mosfet_n') {
        // Enhancement-mode N-channel MOSFET. Like a JFET, gate draws no DC
        // current and Id is a voltage-controlled current source — but with a
        // real, hard threshold (Vgs < Vth means fully OFF, Id=0 exactly, not
        // a smooth asymptote the way a JFET's pinch-off is). Built as its
        // own edge type rather than sharing the JFET's, deliberately: the
        // JFET stamp's sign convention took real back-and-forth to get
        // right (see stampJfetId's comment), and copying it here BY ANALOGY
        // without independently re-deriving would risk repeating exactly
        // that class of bug. This edge type gets its own stamp function,
        // verified against its own hand-solved reference circuits.
        const mk = inst.props.model || '2N7000';
        const pm = def.model_params?.[mk] || {};
        const vgsTh = parseFloat(inst.props.vgs_th) || pm.vgs_th || 2.0;
        const k = parseFloat(inst.props.k) || pm.k || 0.02;
        const MOSFET_PINOUTS = { DGS: [2,1,0], SGD: [0,1,2] }; // [sourceLegIdx, gateLegIdx, drainLegIdx]
        const [msIdx, mgIdx, mdIdx] = MOSFET_PINOUTS[inst.props.pinout] || MOSFET_PINOUTS.DGS;
        const gateNetM = netOf(inst.legs[mgIdx].row, inst.legs[mgIdx].col);
        const sourceNetM = netOf(inst.legs[msIdx].row, inst.legs[msIdx].col);
        const drainNetM = netOf(inst.legs[mdIdx].row, inst.legs[mdIdx].col);
        const vdsSatM = 0.1; // volts — floor for Vds once fully into triode, same role as BJT's VCESAT_FALLBACK
        mosfetEdges.push({ inst, gateNet: gateNetM, sourceNet: sourceNetM, drainNet: drainNetM, vgsTh, k, vdsSat: vdsSatM });

      } else if (btype === 'opamp_dual') {
        // DIP-8 dual op-amp: legs (per opamp.json's leg_labels) are
        // [1OUT, 1IN-, 1IN+, VCC-, 2IN+, 2IN-, 2OUT, VCC+] — the real JRC4558/
        // TL072 pinout. Two independent VCVS units sharing one package, each
        // gets its own opampEdges entry (own V+/V-/Vout nets, own relaxation
        // state), since nothing about the ideal-op-amp model couples them
        // beyond sharing physical supply pins, which aren't part of the
        // signal stamp at all — this app has no negative-rail concept
        // anywhere (see the single-supply assumption baked into BJT/JFET/
        // MOSFET bias throughout), so VCC- is simply not used as a solver
        // node: the clamp uses ground (0V) and _activeSupplyV as the rails,
        // same convention as every other active device here.
        const mk = inst.props.model || 'JRC4558';
        const pm = def.model_params?.[mk] || {};
        const aol = pm.aol || 100000;
        // Separate low/high headroom, not one symmetric value — a real op-amp's
        // output stage isn't always equally close to both rails. LM358/LM324
        // swing to within millivolts of the negative rail (headroom_lo near 0)
        // but still sit ~1.5V short of V+ (headroom_hi, ordinary NPN pull-up
        // headroom) — genuinely asymmetric, not a symmetric rail-to-rail part.
        // Each falls back to the single legacy output_swing_headroom field
        // (then 1.5) so JRC4558/TL072 are unaffected by this split.
        const headroomLo = pm.output_swing_headroom_lo ?? pm.output_swing_headroom ?? 1.5;
        const headroomHi = pm.output_swing_headroom_hi ?? pm.output_swing_headroom ?? 1.5;
        const railLo = 0, railHi = _activeSupplyV ?? 9;
        const unitDefs = [
          { unit: 0, outIdx: 0, mIdx: 1, pIdx: 2 },
          { unit: 1, outIdx: 6, mIdx: 5, pIdx: 4 }
        ];
        for (const { unit, outIdx, mIdx, pIdx } of unitDefs) {
          const voutNet = netOf(inst.legs[outIdx].row, inst.legs[outIdx].col);
          const vmNet   = netOf(inst.legs[mIdx].row, inst.legs[mIdx].col);
          const vpNet   = netOf(inst.legs[pIdx].row, inst.legs[pIdx].col);
          opampEdges.push({ inst, unit, vpNet, vmNet, voutNet, aol, headroomLo, headroomHi, railHi, railLo });
        }

      } else if (btype === 'pt2399_delay') {
        // Real 16-pin pinout (see leg_labels in pt2399.json):
        // 0 VCC, 1 REF, 2 AGND, 3 DGND, 4 CLK_O, 5 VCO, 6 CC1, 7 CC0,
        // 8 OP1-OUT, 9 OP1-IN, 10 OP2-IN, 11 OP2-OUT, 12 LPF2-IN, 13 LPF2-OUT,
        // 14 LPF1-OUT, 15 LPF-IN. Only VCC/REF/AGND and the OP1/OP2 pins
        // participate in the DC solve — VCO/CC0/CC1/LPF*/CLK_O set the
        // internal delay-line's clock/filtering and are read directly off
        // the netlist by the audio engine (Stage 2+), not stamped here.
        const mkP = 'PT2399';
        const pmP = def.model_params?.[mkP] || {};
        const aolP = pmP.aol || 100000;
        const headroomP = pmP.output_swing_headroom ?? 0.3;
        const railLoP = 0, railHiP = _activeSupplyV ?? 5;

        const vccNet = netOf(inst.legs[0].row, inst.legs[0].col);
        const refNet = netOf(inst.legs[1].row, inst.legs[1].col);
        const agndNet = netOf(inst.legs[2].row, inst.legs[2].col);
        // REF self-biases to ~VCC/2 on a real PT2399 via an internal resistor
        // divider from VCC and AGND — not a fixed node (this app's fixedNodes
        // is reserved for the physical supply/battery), just two ordinary
        // resistor edges landing on REF, so it settles near VCC/2 as a real
        // consequence of the network solve, same as any other resistor
        // divider on this board. Value itself doesn't matter, only that both
        // legs match (so the midpoint is exactly VCC/2) and it's stiff enough
        // not to meaningfully load VCC — 20k is a reasonable, unverified
        // internal-impedance guess since the datasheet doesn't publish one.
        resistorEdges.push({ a: vccNet, b: refNet, R: 20000 });
        resistorEdges.push({ a: refNet, b: agndNet, R: 20000 });

        // OP1 and OP2 are real internal op-amps, but single-ended in the
        // datasheet: only one input pin each is brought out (OP1-IN,
        // OP2-IN), with the other input tied internally to REF rather than
        // exposed as a second leg. Modeled as the same ideal-op-amp VCVS as
        // opamp_dual, just with the hidden input pinned to refNet instead of
        // a second real leg — electrically honest to how a real inverting-
        // gain stage built around OP1/OP2 actually biases against REF.
        const op1OutNet = netOf(inst.legs[8].row, inst.legs[8].col);
        const op1InNet  = netOf(inst.legs[9].row, inst.legs[9].col);
        const op2InNet  = netOf(inst.legs[10].row, inst.legs[10].col);
        const op2OutNet = netOf(inst.legs[11].row, inst.legs[11].col);
        // unit 0/1 (not strings) — opampStates' per-inst array is keyed by
        // numeric slot (see its build site below), same convention as
        // opamp_dual's two DIP-8 units regardless of what a real datasheet
        // calls each stage.
        opampEdges.push({ inst, unit: 0, vpNet: refNet, vmNet: op1InNet, voutNet: op1OutNet,
                           aol: aolP, headroomLo: headroomP, headroomHi: headroomP, railHi: railHiP, railLo: railLoP });
        opampEdges.push({ inst, unit: 1, vpNet: refNet, vmNet: op2InNet, voutNet: op2OutNet,
                           aol: aolP, headroomLo: headroomP, headroomHi: headroomP, railHi: railHiP, railLo: railLoP });
      }
    }

    const netIndex = new Map();
    const register = net => { if (net!=null && !fixed.has(net) && !netIndex.has(net)) netIndex.set(net, netIndex.size); };
    resistorEdges.forEach(e => { register(e.a); register(e.b); });
    diodeEdges.forEach(e => { register(e.a); register(e.b); });
    zenerEdges.forEach(e => { register(e.a); register(e.b); });
    bjtEdges.forEach(e => { register(e.a); register(e.b); register(e.icSrc); register(e.icSink); });
    jfetEdges.forEach(e => { register(e.gateNet); register(e.sourceNet); register(e.drainNet); });
    mosfetEdges.forEach(e => { register(e.gateNet); register(e.sourceNet); register(e.drainNet); });
    opampEdges.forEach(e => { register(e.vpNet); register(e.vmNet); register(e.voutNet); });

    const netCount = netIndex.size;
    // Each op-amp unit contributes one extra unknown beyond the net voltages
    // themselves: its own output branch current (Iout), the same MNA
    // extension a VCVS always needs (an ideal voltage-controlled source has
    // no fixed conductance of its own — Iout is whatever the external
    // circuit draws, discovered by the solve, not assumed). These slots are
    // appended AFTER all real net indices and never registered in netIndex,
    // so the `for (const [net, idx] of netIndex) netVoltage.set(...)`
    // readback below naturally ignores them — only V's first `netCount`
    // entries are ever net voltages.
    const N = netCount + opampEdges.length;
    const netVoltage = new Map(fixed);
    const diodeCurrents = new Map();
    const zenerCurrents = new Map();
    const bjtCurrents = new Map(); // inst -> { Ib, Ic }
    const jfetCurrents = new Map(); // inst -> { Id, vgs, vds, triode }
    const mosfetCurrents = new Map(); // inst -> { Id, vgs, vds, on, triode }
    const opampStates = new Map(); // inst -> [unit0State, unit1State], each 'linear'|'sat_high'|'sat_low' — read by solveComponent/audio-engine
    if (N === 0) return { netVoltage, diodeCurrents, zenerCurrents, bjtCurrents, jfetCurrents, mosfetCurrents, opampStates };

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
    // (gm = hFE/e.rbe is fixed for the DURATION OF THIS ITERATION — e.rbe
    // itself is re-estimated once per iteration from the previous iteration's
    // Ic, not resolved within it), so — unlike the B-E on/off state itself —
    // it needs no relaxation of its own: it's stamped directly into the same
    // matrix and solved in one shot, staying exactly consistent with whatever Ib the
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
    // Newton linearization around this iteration's operating point:
    //   Id ≈ idAtOp + gm*(Vgs-vgsOp) + gds*(Vds-vdsOp)
    // where idAtOp is the ACTUAL current at that point (not just the
    // derivatives there) — dropping it makes Id evaluate to exactly 0
    // whenever Vgs/Vds sit at their own operating-point estimates, which
    // iteration 0's seed (vgsOp=vdsOp=0) trivially satisfies before anything
    // has been solved, so the loop found a spurious zero-current fixed point
    // and never moved. gds (dId/dVds) is only nonzero in the triode region —
    // saturation's ideal square law has no Vds dependence, so gds=0 recovers
    // that case from the same code path.
    //
    // Physical current direction: Id flows INTO the drain from the external
    // circuit, through the channel, OUT of the JFET at the source terminal
    // and back INTO the source node (which then typically drains to ground
    // through a resistor). The drain and source rows are NOT mirror images
    // of each other under this convention — current LEAVES the drain row
    // (into the JFET) but ENTERS the source row (from the JFET), so the
    // source row's coefficients on the controlling variables (gate, drain)
    // carry the OPPOSITE sign from the drain row's. Getting this backwards
    // was a real bug found here: the source row's controlling coefficients
    // were stamped with the same sign as the drain row's (by incorrect
    // analogy), which satisfied the row equation internally — G[row].V = I
    // held exactly — while representing a current balance that doesn't match
    // real KCL. That produced a stable, fast-converging fixed point (2-3
    // iterations) that was still wrong by >10x versus a hand-solved
    // reference (self-bias JFET stage, Vdd=0.70V, Rd=100, Rs=1000: true
    // Id=388.9uA, buggy solve converged to 1358.5uA) — internal consistency
    // of the linear system is necessary but not sufficient for correctness;
    // it has to be checked against the real KCL current independently.
    // Confirmed fixed by verifying Id is now continuous crossing the
    // saturation/triode boundary (the two formulas meet algebraically there
    // by construction) rather than jumping, and matches three independent
    // hand-solved saturation-region circuits plus the boundary-region value.
    function stampJfetId(G, I, e, gm, vgsOp, idAtOp, gds, vdsOp) {
      gds = gds || 0; vdsOp = vdsOp || 0;
      const gIdx = netIndex.has(e.gateNet)   ? netIndex.get(e.gateNet)   : -1;
      const sIdx = netIndex.has(e.sourceNet) ? netIndex.get(e.sourceNet) : -1;
      const dIdx = netIndex.has(e.drainNet)  ? netIndex.get(e.drainNet)  : -1;
      const gFixed = fixed.has(e.gateNet), sFixed = fixed.has(e.sourceNet), dFixed = fixed.has(e.drainNet);
      const gV = gFixed ? fixed.get(e.gateNet) : 0, sV = sFixed ? fixed.get(e.sourceNet) : 0, dV = dFixed ? fixed.get(e.drainNet) : 0;
      // Id(op) - gm*vgsOp - gds*vdsOp — the part of the two-variable Newton
      // linearization that doesn't depend on the solved Vg/Vd/Vs.
      const constTerm = idAtOp - gm * vgsOp - gds * vdsOp;

      const terms = [[gm, gIdx, gFixed, gV], [gds, dIdx, dFixed, dV]];
      // Row(drain): current entering the drain node from the JFET is +Id.
      if (dIdx >= 0) {
        for (const [g, cIdx, cFixed, cV] of terms) {
          if (!g) continue;
          if (cIdx>=0) G[dIdx][cIdx] += g; else if (cFixed) I[dIdx] -= g*cV;
          if (sIdx>=0) G[dIdx][sIdx] -= g; else if (sFixed) I[dIdx] += g*sV;
        }
        I[dIdx] -= constTerm;
      }
      // Row(source): current entering the source node FROM the JFET is +Id
      // (current flows in at drain, through the channel, out at source, back
      // INTO this node — opposite direction from the drain row's own "current
      // leaving into the JFET"). Confirmed against a hand-solved triode-region
      // circuit: the earlier +gm/+gds here (mirroring the drain row's sign
      // instead of properly deriving the reversed current direction) satisfied
      // the linearized system internally but violated real KCL through Rs by
      // >10x — self-consistent with its own (wrong) equation, so the
      // relaxation loop converged cleanly to a state that doesn't solve the
      // actual circuit. Undetected by the earlier saturation-only tests
      // because every one of them held the gate at a FIXED node (via Rg to
      // ground), so this coefficient's bug never appeared in the live matrix,
      // only through the (differently-coded) fixed-node branch below.
      if (sIdx >= 0) {
        for (const [g, cIdx, cFixed, cV] of terms) {
          if (!g) continue;
          if (cIdx>=0) G[sIdx][cIdx] -= g; else if (cFixed) I[sIdx] += g*cV;
          G[sIdx][sIdx] += g;
        }
        I[sIdx] += constTerm;
      }
    }

    // stampMosfetId — independently derived for the enhancement-mode N-channel
    // MOSFET, not copied from stampJfetId. The device equation is different
    // (hard threshold Vgs(th), square-law with the standard MOSFET convention
    // Id = k*(Vgs-Vth)^2 in saturation and Id = k*[2*(Vgs-Vth)*Vds - Vds^2] in
    // triode — no 1/2 factor the way JFET's Idss/Vp form has one, since k here
    // is fit directly from a datasheet gm/Id point via k = Id/Vov^2), so gm and
    // gds are re-derived from this device's own partials, not reused.
    //   gm  = dId/dVgs = 2*k*(Vgs-Vth)              [sat]   = 2*k*Vds        [triode]
    //   gds = dId/dVds = 0                          [sat]   = 2*k*(Vgs-Vth-Vds) [triode]
    // Newton linearization: Id ≈ idAtOp + gm*(Vgs-vgsOp) + gds*(Vds-vdsOp),
    // same reasoning as JFET's stamp (dropping idAtOp gives a spurious Id=0
    // fixed point at the zero seed) but re-stated here rather than assumed.
    //
    // Physical current direction is the same physical fact for any 3-terminal
    // FET regardless of channel doping: current enters the DRAIN node from the
    // external circuit, flows through the channel, and re-enters the external
    // circuit AT the source node. That means the source row's coefficients on
    // the controlling variables (gate, drain) must carry the opposite sign
    // from the drain row's — this was verified the hard way for JFET (a same-
    // sign source row was self-consistent, G·V=I held, but wrong by >10x
    // against real KCL). Applying that here as a starting hypothesis, but
    // proving it independently below with a hand-solved MOSFET reference
    // circuit and a direct KCL cross-check (Id from the device formula vs.
    // Id implied by Ohm's law through the source resistor), exactly the way
    // the JFET bug was actually caught — not assuming it carries over just
    // because the device family is similar.
    function stampMosfetId(G, I, e, gm, vgsOp, idAtOp, gds, vdsOp) {
      gds = gds || 0; vdsOp = vdsOp || 0;
      const gIdx = netIndex.has(e.gateNet)   ? netIndex.get(e.gateNet)   : -1;
      const sIdx = netIndex.has(e.sourceNet) ? netIndex.get(e.sourceNet) : -1;
      const dIdx = netIndex.has(e.drainNet)  ? netIndex.get(e.drainNet)  : -1;
      const gFixed = fixed.has(e.gateNet), sFixed = fixed.has(e.sourceNet), dFixed = fixed.has(e.drainNet);
      const gV = gFixed ? fixed.get(e.gateNet) : 0, sV = sFixed ? fixed.get(e.sourceNet) : 0, dV = dFixed ? fixed.get(e.drainNet) : 0;
      const constTerm = idAtOp - gm * vgsOp - gds * vdsOp;

      const terms = [[gm, gIdx, gFixed, gV], [gds, dIdx, dFixed, dV]];
      // Row(drain): current entering the drain node from the MOSFET is +Id.
      if (dIdx >= 0) {
        for (const [g, cIdx, cFixed, cV] of terms) {
          if (!g) continue;
          if (cIdx>=0) G[dIdx][cIdx] += g; else if (cFixed) I[dIdx] -= g*cV;
          if (sIdx>=0) G[dIdx][sIdx] -= g; else if (sFixed) I[dIdx] += g*sV;
        }
        I[dIdx] -= constTerm;
      }
      // Row(source): current entering the source node FROM the MOSFET is +Id,
      // opposite direction from the drain row, so the controlling-coefficient
      // signs flip here (self-term stays positive on both rows).
      if (sIdx >= 0) {
        for (const [g, cIdx, cFixed, cV] of terms) {
          if (!g) continue;
          if (cIdx>=0) G[sIdx][cIdx] -= g; else if (cFixed) I[sIdx] += g*cV;
          G[sIdx][sIdx] += g;
        }
        I[sIdx] += constTerm;
      }
    }

    // Ideal op-amp VCVS stamp (verified in isolation against a textbook
    // non-inverting-amp closed form to floating-point precision before being
    // wired in here). Each op-amp unit gets its own extra row/column (the
    // branch current Iout, at netCount+idx — see N's definition above): the
    // extra ROW encodes the VCVS's own defining equation, the extra COLUMN
    // is where Iout actually enters the circuit (Vout's own KCL row).
    //
    // Linear region: -Aol*Vp + Aol*Vm + 1*Vout + 0*Iout = 0, i.e. Vout =
    // Aol*(Vp-Vm) — an ideal voltage source of value Aol*(Vp-Vm) in series
    // with nothing, so Vout is pinned to that value regardless of load, and
    // Iout (whatever current the load actually draws) is discovered by the
    // solve, not assumed. Saturated region: same "pin the output to a fixed
    // voltage" trick used by the diode/BJT ROFF/RSAT stamps elsewhere in
    // this file — Vout is pinned near the rail via a stiff conductance, and
    // the Iout row goes inert (BIG*Iout=0) so the matrix stays well-
    // conditioned without changing its size between states.
    function stampOpamp(G, I, e, idx, state) {
      const iRow = netCount + idx; // this unit's Iout unknown
      const pIdx = netIndex.has(e.vpNet)   ? netIndex.get(e.vpNet)   : -1;
      const mIdx = netIndex.has(e.vmNet)   ? netIndex.get(e.vmNet)   : -1;
      const oIdx = netIndex.has(e.voutNet) ? netIndex.get(e.voutNet) : -1;
      const pFixed = fixed.has(e.vpNet), mFixed = fixed.has(e.vmNet);
      G[iRow][iRow] += EPS;

      if (state === 'linear') {
        if (pIdx>=0) G[iRow][pIdx] -= e.aol; else if (pFixed) I[iRow] += e.aol*fixed.get(e.vpNet);
        if (mIdx>=0) G[iRow][mIdx] += e.aol; else if (mFixed) I[iRow] -= e.aol*fixed.get(e.vmNet);
        if (oIdx>=0) { G[iRow][oIdx] += 1; G[oIdx][iRow] += 1; }
      } else {
        const clampV = state === 'sat_high' ? (e.railHi - e.headroomHi) : (e.railLo + e.headroomLo);
        if (oIdx>=0) { G[oIdx][oIdx] += BIG_G; I[oIdx] += BIG_G*clampV; }
        G[iRow][iRow] += BIG_G; // inert row — Iout unconstrained/unused while saturated
      }
    }

    let states = diodeEdges.map(() => false);
    // Zener state is one of 'off' / 'forward' / 'clamped' — a real 3-region
    // device, unlike the plain diode's on/off boolean. 'off': neither
    // forward-biased past Vf nor reverse-biased past Vz — effectively open
    // (ROFF), same as an off signal diode. 'forward': behaves exactly like a
    // normal diode (RON, Vf) — a Zener conducts forward too, it's not
    // reverse-only. 'clamped': in breakdown, stamped as a resistor of the
    // model's real Zzt in series with a Vz source (see the zenerEdges loop
    // below) — this is what gives the clamped output its small, realistic
    // upward slope with current instead of a flat pin.
    let zenerStates = zenerEdges.map(() => 'off');
    let bjtStates = bjtEdges.map(() => false);
    // bjtStates is committed with a one-iteration delay: a proposed flip only
    // takes effect once the SAME proposal repeats on the next iteration (see
    // where this is used below). Without this, a feedback pair (this stage's
    // collector feeding the next stage's base, feeding back into this one)
    // can land exactly on the on/off boundary and flip every single
    // iteration forever — measured on a real Fuzz Face NPN file, where Q2
    // alternated between Vbe~20V/Ic~314mA and Vbe~0.65V/Ic=0 every iteration
    // and never converged, hitting the 15-iteration cap and reporting
    // whichever half of the oscillation the cap happened to land on (Ic=0,
    // even though KCL on the surrounding resistor network independently
    // measured ~917uA genuinely flowing into that same collector node — the
    // reported state was self-inconsistent, not just imprecise). This is why
    // that Fuzz Face's Q2 read as unsaturated with implausibly low current,
    // and why its Fuzz pot barely changed the output (gain built from a
    // non-equilibrium snapshot is meaningless). Requiring two consecutive
    // agreeing proposals breaks the cycle by holding the state through a
    // single-iteration flip, while a genuinely converging circuit reaches
    // the same proposal on consecutive iterations near equilibrium anyway,
    // so this doesn't change correct behavior — confirmed byte-identical
    // results on the PNP Fuzz Face and Electra Distortion files, and the NPN
    // file went from hitting the cap unconverged to converging in fewer
    // iterations than the old broken loop even ran.
    let bjtProposed = bjtEdges.map(() => false);
    let satStates = bjtEdges.map(() => false); // true once a bjt is clamped into saturation
    // Ic estimate feeding this iteration's r_pi = hFE*Vt/Ic (see rbe/gm
    // recompute below). Seeded from Icbo alone, since at iteration 0 nothing
    // has been solved yet — a germanium part's own leakage is already a
    // reasonable order-of-magnitude starting current, and silicon's is close
    // enough to zero that RBE_MAX (the old fixed value) governs instead.
    let icEstimate = bjtEdges.map(e => Math.max(e.Icbo || 0, 1e-9));
    // Ib estimate, tracked the same way as icEstimate — used to key the
    // low-current hFE rolloff (see HFE_REF_IC) on the junction's ACTUAL
    // drive current rather than the already-amplified Ic, which is
    // self-referential (a leakage-dominated stage's Ic stays "big enough"
    // to look up its own full rated hFE, even though the Ib driving it is
    // three-plus orders of magnitude below any realistic hFE test current).
    let ibEstimate = bjtEdges.map(() => 1e-9);
    // JFET's own relaxation state: Vgs/Vds estimates (what stampJfetId
    // linearizes around each iteration) and whether the device is in the
    // triode/ohmic region rather than saturation (same role as satStates for
    // a BJT — this model uses the real two-region square-law/Shichman-Hodges
    // equations, continuous by construction at the boundary, rather than an
    // approximation that would jump there). Seeded at 0V (Vgs=0, i.e. full
    // Idss; Vds=0) since a gate network typically starts near the source's
    // own voltage before any bias resistor divides it down.
    let jfetVgsEstimate = jfetEdges.map(() => 0);
    let jfetVdsEstimate = jfetEdges.map(() => 0);
    let jfetTriode = jfetEdges.map(() => false);
    // MOSFET's own relaxation state. Unlike the JFET's smooth pinch-off, an
    // enhancement-mode device is hard-OFF below Vgs(th) (Id=0 exactly), so a
    // Vgs seed of 0 starts every device off — the same "starts off, has to
    // turn on as the solve progresses" shape as a BJT's B-E junction, not
    // JFET's "starts at full Idss" shape. Committed on/off state (mosfetOn)
    // uses the same two-consecutive-agreement hysteresis as bjtStates/
    // bjtProposed, for the same reason: a hard threshold sitting exactly on a
    // feedback boundary can flip every iteration otherwise.
    let mosfetVgsEstimate = mosfetEdges.map(() => 0);
    let mosfetVdsEstimate = mosfetEdges.map(() => 0);
    let mosfetTriode = mosfetEdges.map(() => false);
    let mosfetOn = mosfetEdges.map(() => false);
    let mosfetProposed = mosfetEdges.map(() => false);
    // Op-amp relaxation state, one of 'linear'/'sat_high'/'sat_low' per unit —
    // same shape as bjtStates/satStates, but no on/off hysteresis is needed
    // here: an ideal op-amp has no conduction threshold to oscillate across,
    // only a saturation BOUNDARY, and that's decided from the LINEAR-model
    // prediction each iteration (see the state-update block below), the same
    // "recompute from the unclamped relation, not from a pinned solve" logic
    // the isolated verification script proved out before this was wired in.
    let opampStateArr = opampEdges.map(() => 'linear');
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
      zenerEdges.forEach((e, idx) => {
        if (e.a==null || e.b==null || e.a===e.b) return;
        const st = zenerStates[idx];
        if (st === 'forward') {
          // Identical to a plain diode's forward stamp — a Zener conducts
          // forward just like any other silicon junction. Vf isn't in the
          // per-model table (every part in this family sits close to the
          // same ~0.9-1V forward drop at rated current per their datasheets'
          // VF@IF=200mA spec), so a single representative constant is used
          // here rather than adding a 6th per-model number for a region
          // these parts are essentially never used in.
          const g = 1/RON;
          stampConductance(G, I, e.a, e.b, g);
          stampCurrentSource(I, e.a, e.b, g*0.9);
        } else if (st === 'clamped') {
          // Mirror of the forward stamp: current flows CATHODE->ANODE in
          // breakdown, so the (a,b) roles swap to (e.b,e.a) and Vf->Vz. g
          // here is 1/Zzt (the model's real datasheet dynamic impedance at
          // its rated test current), not 1/RON — this is what gives the
          // clamped output a small, realistic upward slope with current
          // instead of a flat pin at exactly Vz. Verified against a
          // hand-derived closed-form shunt-regulator solution before this
          // was wired in (see CLAUDE.md's Verification technique).
          const g = 1/e.Zzt;
          stampConductance(G, I, e.a, e.b, g);
          stampCurrentSource(I, e.b, e.a, g*e.Vz);
        } else {
          stampConductance(G, I, e.a, e.b, 1/ROFF);
        }
      });
      bjtEdges.forEach((e, idx) => {
        if (e.a==null || e.b==null || e.a===e.b) return;
        // Low-current hFE rolloff (see HFE_REF_IC above), keyed on Ib (the
        // junction's actual drive current) rather than Ic. Ic = hFE*Ib is
        // already amplified, so keying the rolloff on Ic is self-referential:
        // a leakage-dominated stage's Ic can look "big enough" to justify
        // its own full rated hFE even while the Ib actually driving it sits
        // at a small fraction of any realistic test current. HFE_REF_IC is
        // a COLLECTOR reference current (matching the datasheet convention,
        // confirmed against a real NKT275 page), so it's converted to the
        // equivalent base current here via the transistor's OWN rated hFE
        // (Ib_ref = Ic_ref / hFE_rated) before comparing against ibEstimate.
        const ibRef = HFE_REF_IC / e.hfeRated;
        e.hfe = e.hfeRated * Utils.clamp(ibEstimate[idx] / ibRef, HFE_ROLLOFF_FLOOR, 1);
        // r_pi = hFE*Vt/Ic, re-estimated each iteration from the previous
        // iteration's solved Ic (icEstimate). This is what makes germanium's
        // real leakage current land at a realistic few-hundred-ohm r_pi
        // instead of the fixed 10k, without changing silicon's behavior
        // (whose Ic is already large enough that Vt-scaled r_pi is small
        // either way, or clamped to RBE_MAX same as before if it isn't).
        e.rbe = Utils.clamp(e.hfe * VT / icEstimate[idx], RBE_MIN, RBE_MAX);
        e.gm  = e.hfe / e.rbe;
        const on = bjtStates[idx];
        const g = 1/(on ? e.rbe : ROFF);
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
      jfetEdges.forEach((e, idx) => {
        if (e.gateNet==null || e.sourceNet==null || e.drainNet==null) return;
        // Saturation: Id = Idss*(1 - Vgs/Vp)^2 for Vp <= Vgs <= 0 (N-channel,
        // Vp = e.vgsOff is negative). Clamped so a Vgs estimate that strays
        // past pinch-off (Vgs < Vp, device fully off) or past 0 (forward
        // gate-source, not a normal operating region for a JFET used as an
        // amplifier) doesn't produce a negative or runaway gm.
        //
        // Triode (Shichman-Hodges): Id = k*[(Vgs-Vp)*Vds - Vds^2/2], where
        // k = 2*Idss/Vp^2. Chosen over a plain Rds_on approximation because
        // that approximation is only correct AT the saturation boundary by
        // construction, not smoothly either side of it — measured as a ~20%
        // current jump right at the boundary on a swept test circuit. This
        // formula reduces ALGEBRAICALLY to the saturation formula above when
        // Vds = Vgs-Vp (substitute and simplify), so the two regions meet
        // with no discontinuity.
        const vgsOp = Utils.clamp(jfetVgsEstimate[idx], e.vgsOff, 0);
        const vdsOp = Math.max(0, jfetVdsEstimate[idx]);
        const k = 2 * e.idss / (e.vgsOff * e.vgsOff);
        let gm, gds, idAtOp;
        if (jfetTriode[idx]) {
          gm  = Math.max(0, k * vdsOp);
          gds = k * (vgsOp - e.vgsOff - vdsOp);
          idAtOp = Math.max(0, k * ((vgsOp - e.vgsOff) * vdsOp - vdsOp * vdsOp / 2));
        } else {
          const ratio = 1 - vgsOp / e.vgsOff;
          gm  = Math.max(0, (2 * e.idss / Math.abs(e.vgsOff)) * ratio);
          gds = 0; // ideal saturation: Id independent of Vds (no channel-length modulation in this model)
          idAtOp = e.idss * ratio * ratio;
        }
        e.gm = gm;
        // Newton linearization, NOT a small-signal AC stamp: Id ≈ Id(op) +
        // gm*(Vgs-vgsOp) + gds*(Vds-vdsOp). Dropping the Id(op) constant (an
        // earlier version of this stamp did) makes Id evaluate to exactly 0
        // whenever Vgs/Vds sit exactly at their own operating-point
        // estimates — which iteration 0's seed (vgsOp=vdsOp=0) trivially
        // satisfies before anything has been solved, so the whole relaxation
        // loop found a spurious zero-current fixed point and never moved,
        // confirmed on a hand-solved self-bias test circuit (expected
        // ~0.39mA, got 0).
        stampJfetId(G, I, e, gm, vgsOp, idAtOp, gds, vdsOp);
      });
      mosfetEdges.forEach((e, idx) => {
        if (e.gateNet==null || e.sourceNet==null || e.drainNet==null) return;
        if (!mosfetOn[idx]) return; // below threshold: Id=0 exactly, no stamp at all (not even a zero-gm one) — same as an off diode/BJT junction
        // Saturation: Id = k*(Vgs-Vth)^2 for Vgs >= Vth. Triode (standard
        // MOSFET square law, the enhancement-mode analogue of JFET's
        // Shichman-Hodges form): Id = k*[2*(Vgs-Vth)*Vds - Vds^2]. Substituting
        // Vds = Vgs-Vth into the triode formula gives k*(Vgs-Vth)^2, the same
        // saturation value, so the two meet with no discontinuity at the
        // boundary — verified below against a hand-solved reference rather
        // than assumed from the algebra alone.
        const vov = Math.max(0, mosfetVgsEstimate[idx] - e.vgsTh);
        const vdsOp = Math.max(0, mosfetVdsEstimate[idx]);
        let gm, gds, idAtOp;
        if (mosfetTriode[idx]) {
          gm  = 2 * e.k * vdsOp;
          gds = 2 * e.k * (vov - vdsOp);
          idAtOp = Math.max(0, e.k * (2 * vov * vdsOp - vdsOp * vdsOp));
        } else {
          gm  = 2 * e.k * vov;
          gds = 0; // ideal saturation: no channel-length modulation in this model
          idAtOp = e.k * vov * vov;
        }
        e.gm = gm;
        stampMosfetId(G, I, e, gm, mosfetVgsEstimate[idx], idAtOp, gds, vdsOp);
      });
      opampEdges.forEach((e, idx) => { stampOpamp(G, I, e, idx, opampStateArr[idx]); });

      V = gaussianSolve(G, I);

      let changed = false;
      diodeEdges.forEach((e, idx) => {
        if (e.a==null || e.b==null) return;
        const va = netIndex.has(e.a) ? V[netIndex.get(e.a)] : fixed.get(e.a);
        const vb = netIndex.has(e.b) ? V[netIndex.get(e.b)] : fixed.get(e.b);
        const shouldBeOn = (va - vb) > e.Vf * 0.5;
        if (shouldBeOn !== states[idx]) { states[idx] = shouldBeOn; changed = true; }
      });
      zenerEdges.forEach((e, idx) => {
        if (e.a==null || e.b==null) return;
        const va = netIndex.has(e.a) ? V[netIndex.get(e.a)] : fixed.get(e.a);
        const vb = netIndex.has(e.b) ? V[netIndex.get(e.b)] : fixed.get(e.b);
        // Forward check mirrors the plain diode's own rule exactly (same
        // 0.9V representative Vf used in the stamp above, same half-Vf
        // hysteresis band). Clamped check requires the REVERSE voltage
        // (vb-va, cathode above anode) to reach Vz — checked with NO margin
        // subtracted, so breakdown engages right at the rated Zener voltage,
        // matching how the datasheet defines Vz as the point the device
        // starts conducting in reverse.
        const shouldBeForward = (va - vb) > 0.9 * 0.5;
        const shouldBeClamped = !shouldBeForward && (vb - va) > e.Vz;
        const newState = shouldBeForward ? 'forward' : (shouldBeClamped ? 'clamped' : 'off');
        if (newState !== zenerStates[idx]) { zenerStates[idx] = newState; changed = true; }
      });
      bjtEdges.forEach((e, idx) => {
        if (e.a==null || e.b==null) return;
        const va = netIndex.has(e.a) ? V[netIndex.get(e.a)] : fixed.get(e.a);
        const vb = netIndex.has(e.b) ? V[netIndex.get(e.b)] : fixed.get(e.b);
        const shouldBeOn = (va - vb) > e.Vf * 0.5;
        // Commit only on two consecutive agreeing proposals — see the
        // bjtStates/bjtProposed declaration above for why. Everything below
        // (saturation logic, icEstimate/ibEstimate, and next iteration's
        // stamping via bjtStates) uses committedOn, never the raw shouldBeOn.
        let committedOn = bjtStates[idx];
        if (shouldBeOn === bjtProposed[idx]) {
          if (shouldBeOn !== bjtStates[idx]) { bjtStates[idx] = shouldBeOn; changed = true; }
          committedOn = shouldBeOn;
        } else {
          bjtProposed[idx] = shouldBeOn; changed = true;
        }
        if (!committedOn) {
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

        // Refresh the Ic estimate that next iteration's r_pi = hFE*Vt/Ic will
        // be computed from. A meaningful swing in Ic changes r_pi enough to
        // shift the operating point again, so it counts toward `changed` the
        // same as an on/off flip does — otherwise the loop could exit on a
        // stale first-guess r_pi from the RBE seed.
        const newIc = satStates[idx]
          ? Math.max(0, (1/RSAT)*(vSink - vSrc - e.vceSat))
          : Math.max(0, e.gm*((va-vb) - e.Vf)) + (e.Icbo||0);
        const icFloor = Math.max(e.Icbo || 0, 1e-9);
        const clampedIc = Utils.clamp(newIc, icFloor, IC_ESTIMATE_CEILING);
        if (Math.abs(clampedIc - icEstimate[idx]) > icEstimate[idx] * 0.05) changed = true;
        icEstimate[idx] = clampedIc;

        // Ib actually driving the junction this iteration — the same
        // quantity the B-E stamp above conducts, at the g=1/e.rbe
        // conductance that stamp used. Tracked separately from icEstimate
        // for the hFE rolloff above (see its comment for why Ic can't be
        // used for that directly).
        const newIb = Math.max(0, ((va - vb) - e.Vf) / e.rbe);
        const clampedIb = Utils.clamp(newIb, 1e-9, IC_ESTIMATE_CEILING);
        if (Math.abs(clampedIb - ibEstimate[idx]) > ibEstimate[idx] * 0.05) changed = true;
        ibEstimate[idx] = clampedIb;
      });
      jfetEdges.forEach((e, idx) => {
        if (e.gateNet==null || e.sourceNet==null || e.drainNet==null) return;
        const vg = netIndex.has(e.gateNet)   ? V[netIndex.get(e.gateNet)]   : fixed.get(e.gateNet);
        const vs = netIndex.has(e.sourceNet) ? V[netIndex.get(e.sourceNet)] : fixed.get(e.sourceNet);
        const vd = netIndex.has(e.drainNet)  ? V[netIndex.get(e.drainNet)]  : fixed.get(e.drainNet);
        const vgs = vg - vs, vds = vd - vs;

        const newVgs = Utils.clamp(vgs, e.vgsOff, 0);
        if (Math.abs(newVgs - jfetVgsEstimate[idx]) > 0.01) changed = true; // volts, not a ratio — Vgs sits in a narrow range so an absolute threshold reads better than BJT's relative one
        jfetVgsEstimate[idx] = newVgs;

        const newVds = Math.max(0, vds); // triode's formula assumes Vds>=0; a negative solve here means the region guess needs correcting next iteration anyway
        if (Math.abs(newVds - jfetVdsEstimate[idx]) > 0.01) changed = true;
        jfetVdsEstimate[idx] = newVds;

        // Region check: saturation requires Vds >= Vgs - Vp (equivalently
        // Vds >= |Vp| - |Vgs| for this sign convention). Below that, the
        // channel hasn't fully pinched off and triode applies instead — same
        // "does the external circuit actually support this operating point"
        // check as a BJT's saturation boundary.
        const vdsSatBoundary = newVgs - e.vgsOff;
        const shouldBeTriode = vds < vdsSatBoundary;
        if (shouldBeTriode !== jfetTriode[idx]) { jfetTriode[idx] = shouldBeTriode; changed = true; }
      });
      mosfetEdges.forEach((e, idx) => {
        if (e.gateNet==null || e.sourceNet==null || e.drainNet==null) return;
        const vg = netIndex.has(e.gateNet)   ? V[netIndex.get(e.gateNet)]   : fixed.get(e.gateNet);
        const vs = netIndex.has(e.sourceNet) ? V[netIndex.get(e.sourceNet)] : fixed.get(e.sourceNet);
        const vd = netIndex.has(e.drainNet)  ? V[netIndex.get(e.drainNet)]  : fixed.get(e.drainNet);
        const vgs = vg - vs, vds = vd - vs;

        const newVgs = Math.max(0, vgs); // negative Vgs is a normal off condition (not clamped away like JFET's asymptotic Vp — a MOSFET simply has zero overdrive there)
        if (Math.abs(newVgs - mosfetVgsEstimate[idx]) > 0.01) changed = true;
        mosfetVgsEstimate[idx] = newVgs;

        const newVds = Math.max(0, vds);
        if (Math.abs(newVds - mosfetVdsEstimate[idx]) > 0.01) changed = true;
        mosfetVdsEstimate[idx] = newVds;

        // On/off, committed with the same one-iteration-delay hysteresis as
        // bjtStates (see its declaration for why): a proposed flip only takes
        // effect once the SAME proposal repeats on the next iteration, so a
        // hard threshold sitting on a feedback boundary can't flip every pass.
        const shouldBeOn = vgs > e.vgsTh;
        let committedOn = mosfetOn[idx];
        if (shouldBeOn === mosfetProposed[idx]) {
          if (shouldBeOn !== committedOn) { committedOn = shouldBeOn; changed = true; }
        } else {
          changed = true;
        }
        mosfetProposed[idx] = shouldBeOn;
        mosfetOn[idx] = committedOn;

        // Region check: saturation requires Vds >= Vgs-Vth (the overdrive).
        // Below that the channel hasn't fully pinched off and triode applies.
        const vdsSatBoundary = Math.max(0, newVgs - e.vgsTh);
        const shouldBeTriode = vds < vdsSatBoundary;
        if (shouldBeTriode !== mosfetTriode[idx]) { mosfetTriode[idx] = shouldBeTriode; changed = true; }
      });
      opampEdges.forEach((e, idx) => {
        const vp = netIndex.has(e.vpNet) ? V[netIndex.get(e.vpNet)] : fixed.get(e.vpNet);
        const vm = netIndex.has(e.vmNet) ? V[netIndex.get(e.vmNet)] : fixed.get(e.vmNet);
        if (vp == null || vm == null) return;
        // Decide next state from the LINEAR-model prediction (what Vout WOULD
        // be if unclamped), not from the just-solved Vout itself — a
        // saturated solve's own Vout is definitionally already pinned and
        // uninformative about whether linear operation would now be back in
        // range. Verified in isolation this is what lets the relaxation
        // correctly re-enter linear mode once an overdriven input recedes.
        const linearVout = e.aol * (vp - vm);
        const highClamp = e.railHi - e.headroomHi, lowClamp = e.railLo + e.headroomLo;
        // A real op-amp genuinely in saturation drives vp-vm to a real error
        // signal (millivolts+), so aol*(vp-vm) overshoots the clamp by many
        // multiples, not a hair. But vp/vm here can themselves be solved
        // nodes (e.g. a divider-referenced input, not a fixed rail) that are
        // still converging from a cold start elsewhere in the SAME iterative
        // pass — a not-yet-settled few-microvolt gap, times aol~1e5, can
        // cross the clamp by a tiny margin and get mistaken for real
        // saturation. Found on a PT2399 test circuit (unity-gain loop
        // referenced to an internally-generated ~VCC/2 node, zero real error
        // signal) that latched sat_high from a 6%-over-threshold prediction
        // on iteration 0 and then stayed there — a genuine stable fixed
        // point of the WRONG branch, not oscillation, so "state stopped
        // changing" never caught it. SAT_LATCH_MARGIN requires overshooting
        // by a real multiple (2x the clamp's distance from the linear
        // window's edge) before LATCHING INTO saturation — asymmetric on
        // purpose: recovering FROM saturation back to linear keeps the exact
        // boundary test above, since a real stage crossing back into range
        // isn't the noise-amplification case this guards against.
        // Both clamps are structurally positive in every real configuration
        // here (railHi/headroom come from real, positive supply/headroom
        // values), so a plain multiple is a safe "further past the boundary"
        // test — not defended against a negative clamp, which would mean a
        // misconfigured component and should surface as a visibly wrong
        // result rather than be silently absorbed here.
        const SAT_LATCH_MARGIN = 2;
        const alreadyLatched = opampStateArr[idx] !== 'linear';
        const enteringHigh = linearVout > highClamp && (alreadyLatched || linearVout > highClamp * SAT_LATCH_MARGIN);
        const enteringLow  = linearVout < lowClamp  && (alreadyLatched || linearVout < lowClamp  * SAT_LATCH_MARGIN);
        const newState = enteringHigh ? 'sat_high' : (enteringLow ? 'sat_low' : 'linear');
        if (newState !== opampStateArr[idx]) { opampStateArr[idx] = newState; changed = true; }
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
    zenerEdges.forEach((e, idx) => {
      if (e.a==null || e.b==null) { zenerCurrents.set(e.inst, { current: 0, state: 'off' }); return; }
      const va = netIndex.has(e.a) ? V[netIndex.get(e.a)] : fixed.get(e.a);
      const vb = netIndex.has(e.b) ? V[netIndex.get(e.b)] : fixed.get(e.b);
      const st = zenerStates[idx];
      // Magnitude only, regardless of direction — the over_current failure
      // check downstream (see the zener_diode case in solveComponent) cares
      // about how hard the device is being driven either way, not which
      // direction the current happens to flow. `state` rides along too
      // (rather than just the magnitude) because solveSmallSignal needs to
      // know WHICH region the device is in to pick the right small-signal
      // formula (exponential I/Vt when forward, linear 1/Zzt when clamped)
      // — it has no netVoltage of its own to re-derive that from itself.
      let current = 0;
      if (st === 'forward') current = Math.max(0, (1/RON) * ((va-vb) - 0.9));
      else if (st === 'clamped') current = Math.max(0, (1/e.Zzt) * ((vb-va) - e.Vz));
      zenerCurrents.set(e.inst, { current, state: st });
    });
    bjtEdges.forEach((e, idx) => {
      if (e.a==null || e.b==null) { bjtCurrents.set(e.inst, { Ib:0, Ic:0, vce:0, saturated:false }); return; }
      const va = netIndex.has(e.a) ? V[netIndex.get(e.a)] : fixed.get(e.a);
      const vb = netIndex.has(e.b) ? V[netIndex.get(e.b)] : fixed.get(e.b);
      const on = bjtStates[idx];
      const g = 1/(on ? e.rbe : ROFF);
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
    jfetEdges.forEach((e, idx) => {
      if (e.gateNet==null || e.sourceNet==null || e.drainNet==null) { jfetCurrents.set(e.inst, { Id:0, vgs:0, vds:0, triode:false }); return; }
      const vg = netIndex.has(e.gateNet)   ? V[netIndex.get(e.gateNet)]   : fixed.get(e.gateNet);
      const vs = netIndex.has(e.sourceNet) ? V[netIndex.get(e.sourceNet)] : fixed.get(e.sourceNet);
      const vd = netIndex.has(e.drainNet)  ? V[netIndex.get(e.drainNet)]  : fixed.get(e.drainNet);
      const vgs = vg - vs, vds = vd - vs;
      const vgsClamped = Utils.clamp(vgs, e.vgsOff, 0);
      const vdsClamped = Math.max(0, vds);
      const k = 2 * e.idss / (e.vgsOff * e.vgsOff);
      let Id;
      if (jfetTriode[idx]) {
        Id = Math.max(0, k * ((vgsClamped - e.vgsOff) * vdsClamped - vdsClamped * vdsClamped / 2));
      } else {
        const ratio = 1 - vgsClamped / e.vgsOff;
        Id = Math.max(0, e.idss * ratio * ratio);
      }
      jfetCurrents.set(e.inst, { Id, vgs, vds, triode: jfetTriode[idx] });
    });
    mosfetEdges.forEach((e, idx) => {
      if (e.gateNet==null || e.sourceNet==null || e.drainNet==null) { mosfetCurrents.set(e.inst, { Id:0, vgs:0, vds:0, on:false, triode:false }); return; }
      const vg = netIndex.has(e.gateNet)   ? V[netIndex.get(e.gateNet)]   : fixed.get(e.gateNet);
      const vs = netIndex.has(e.sourceNet) ? V[netIndex.get(e.sourceNet)] : fixed.get(e.sourceNet);
      const vd = netIndex.has(e.drainNet)  ? V[netIndex.get(e.drainNet)]  : fixed.get(e.drainNet);
      const vgs = vg - vs, vds = vd - vs;
      const on = mosfetOn[idx];
      let Id = 0;
      if (on) {
        const vov = Math.max(0, vgs - e.vgsTh);
        const vdsClamped = Math.max(0, vds);
        Id = mosfetTriode[idx]
          ? Math.max(0, e.k * (2 * vov * vdsClamped - vdsClamped * vdsClamped))
          : Math.max(0, e.k * vov * vov);
      }
      mosfetCurrents.set(e.inst, { Id, vgs, vds, on, triode: mosfetTriode[idx] });
    });
    opampEdges.forEach((e, idx) => {
      // Keyed by inst with a per-unit array (2 slots, one per DIP-8 package
      // unit), not by e itself — solveComponent/audio-engine look this up by
      // instance the same way every other per-inst state map here does, and
      // a package's two units need to stay distinguishable under one key.
      const arr = opampStates.get(e.inst) || [null, null];
      arr[e.unit] = opampStateArr[idx];
      opampStates.set(e.inst, arr);
    });

    return { netVoltage, diodeCurrents, zenerCurrents, bjtCurrents, jfetCurrents, mosfetCurrents, opampStates };
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
  //     r_pi = hFE*Vt/Ic here is computed fresh from THIS solve's own Ic — the
  //     DC solve's r_pi (bjtEdges' e.rbe) is also bias-dependent now, but as a
  //     relaxation estimate carried over from solveNetVoltages rather than
  //     recomputed inside this pass.
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
  // VT (thermal voltage) is declared once, above, near RBE — solveNetVoltages'
  // bias-dependent r_pi and this small-signal solve's r_pi both use it.

  function solveSmallSignal(placed, nets, inputNet, acGroundNets) {
    if (inputNet == null) return null;
    const netOf = (row, col) => nets.find(nets.key(row, col));

    const fixed = new Map();
    for (const n of acGroundNets) if (n != null) fixed.set(n, 0);
    if (fixed.has(inputNet)) return null; // input shorted to ground/supply — no meaningful drive
    fixed.set(inputNet, 1);

    const edges = []; // { a, b, G }
    const vccs  = []; // { p, q, src, sink, gm } : gm*(Vp-Vq) injected at src, extracted at sink
    const opampBranches = []; // { vpNet, vmNet, voutNet, aol } : ideal VCVS, needs its own extra unknown — see below

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

      } else if (bt === 'zener_diode' && L.length >= 2) {
        // Off: open, contributes nothing, same as an off signal diode.
        // Forward: same exponential small-signal treatment as a plain diode
        // (I/Vt), since forward conduction is the same junction physics.
        // Clamped: NOT exponential — this region is modeled in the DC solve
        // as a fixed linear resistor (the model's real Zzt), so its
        // small-signal conductance is just 1/Zzt directly, not I/Vt.
        // `_zenerState` is set by solveComponent's zener_diode case during
        // the DC pass this function always runs after — solveSmallSignal
        // has no netVoltage of its own to re-derive which region the
        // device is in, so it reads back what the DC solve already decided.
        const I = inst._current || 0;
        if (I <= 0) continue;
        const mk = inst.props.model || '1N4742A';
        const pm = def.model_params?.[mk] || {};
        const clamped = inst._zenerState === 'clamped';
        edges.push({ a: netOf(L[0].row, L[0].col), b: netOf(L[L.length-1].row, L[L.length-1].col),
                     G: clamped ? 1/(pm.zzt || 10) : I / VT });

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

      } else if (bt === 'jfet_n' && L.length >= 3) {
        // Gate draws no DC current, so unlike a BJT's base there is no
        // rpi edge at all here — the gate is a true open circuit into this
        // network, reached only through the gm-controlled current source
        // below. gm at the DC operating point comes from the saturation
        // square law Id=Idss*(1-Vgs/Vp)^2, solved for gm algebraically
        // rather than needing Vgs itself: ratio=sqrt(Id/Idss)=1-Vgs/Vp, so
        // gm=(2*Idss/|Vp|)*ratio=2*sqrt(Idss*Id)/|Vp|. Verified against the
        // DC solver's own e.gm (computed per-iteration inside
        // solveNetVoltages, not otherwise available here) on two real
        // circuits: J201 at Id=0.1341mA reproduced gm to 5 significant
        // figures. Triode-region gm would differ (2*k*Vds instead), but
        // small-signal gain is only meaningful for a stage actually
        // amplifying in saturation, so this is the right region to model.
        const pm = def.model_params?.[inst.props.model] || {};
        const idss = parseFloat(inst.props.idss) ? parseFloat(inst.props.idss)/1000 : (pm.idss_ma||0.45)/1000;
        const vgsOff = parseFloat(inst.props.vgs_off) || pm.vgs_off || -0.65;
        const Id = Math.max(inst._current || 0, 1e-9);
        const gm = 2 * Math.sqrt(idss * Id) / Math.abs(vgsOff);
        const JFET_PINOUTS = { SGD: [0,1,2], DGS: [2,1,0], GSD: [1,0,2] };
        const [sIdx, gIdx, dIdx] = JFET_PINOUTS[inst.props.pinout] || JFET_PINOUTS.SGD;
        const gN = netOf(L[gIdx].row, L[gIdx].col);
        const sN = netOf(L[sIdx].row, L[sIdx].col);
        const dN = netOf(L[dIdx].row, L[dIdx].col);
        // Current direction matches stampJfetId: enters drain, leaves via
        // source, controlled by Vgs (gate relative to source).
        vccs.push({ p: gN, q: sN, src: dN, sink: sN, gm });

      } else if (bt === 'mosfet_n' && L.length >= 3) {
        // Same reasoning as the JFET case above, but for the enhancement-
        // mode square law Id=k*(Vgs-Vth)^2: Vov=sqrt(Id/k), gm=2*k*Vov=
        // 2*sqrt(k*Id) — again solved without needing Vgs directly.
        // Verified against the DC solver's own gm on a real 2N7000 circuit
        // (Id=5.4473mA) to 6 significant figures.
        const pm = def.model_params?.[inst.props.model] || {};
        const k = parseFloat(inst.props.k) || pm.k || 0.02;
        const Id = Math.max(inst._current || 0, 1e-9);
        const gm = 2 * Math.sqrt(k * Id);
        const MOSFET_PINOUTS = { DGS: [2,1,0], SGD: [0,1,2] };
        const [sIdx, gIdx, dIdx] = MOSFET_PINOUTS[inst.props.pinout] || MOSFET_PINOUTS.DGS;
        const gN = netOf(L[gIdx].row, L[gIdx].col);
        const sN = netOf(L[sIdx].row, L[sIdx].col);
        const dN = netOf(L[dIdx].row, L[dIdx].col);
        vccs.push({ p: gN, q: sN, src: dN, sink: sN, gm });

      } else if (bt === 'opamp_dual' && L.length >= 8) {
        // An ideal op-amp's gain (Aol, ~1e5-2e5) swamps any transistor gm in
        // this network, so it CANNOT be modeled as a vccs-style gm-controlled
        // current source the way a BJT/JFET/MOSFET is above — that shape
        // assumes the controlled quantity is a current injected against the
        // node's own conductance, not a near-ideal voltage source with
        // (effectively) zero output impedance. It needs the same branch-
        // current MNA extension used in solveNetVoltages' stampOpamp: see
        // opampBranches below, stamped after indexing exactly like the DC
        // solve's opampEdges are appended after netCount.
        //
        // A unit saturated in the DC operating point contributes NOTHING to
        // small-signal gain — its output is pinned to a fixed rail-adjacent
        // voltage by the clamp, not tracking Vp-Vm at all, so signal arriving
        // at its inputs produces no AC change at its output. Modeled here by
        // simply not adding a branch for a saturated unit's output net: the
        // net still exists (from other edges touching it) but sees no gm/Aol
        // contribution, matching a real saturated op-amp's near-zero
        // incremental gain right at the rail.
        const mk = inst.props.model || 'JRC4558';
        const pm = def.model_params?.[mk] || {};
        const aol = pm.aol || 100000;
        const states = inst._opampState || [null, null];
        const unitDefs = [ { unit:0, outIdx:0, mIdx:1, pIdx:2 }, { unit:1, outIdx:6, mIdx:5, pIdx:4 } ];
        for (const { unit, outIdx, mIdx, pIdx } of unitDefs) {
          if (states[unit] && states[unit] !== 'linear') continue; // saturated: no small-signal contribution
          const voutN = netOf(L[outIdx].row, L[outIdx].col);
          const vmN   = netOf(L[mIdx].row, L[mIdx].col);
          const vpN   = netOf(L[pIdx].row, L[pIdx].col);
          opampBranches.push({ vpNet: vpN, vmNet: vmN, voutNet: voutN, aol });
        }

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
    for (const o of opampBranches) { reg(o.vpNet); reg(o.vmNet); reg(o.voutNet); }

    const netCountSS = idx.size;
    const N = netCountSS + opampBranches.length;
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
        // qi===ki (q and sink are the SAME node) needs +=, not the general
        // case's -=. This is a real, narrow sign bug, found and fixed via a
        // hand-solved JFET source follower (gate driven, source is both the
        // controlling voltage's "-" terminal AND where current arrives —
        // exactly this collision). With -=gm the follower solved to a
        // physically impossible 1.09x gain (a follower can never exceed
        // unity gain); with +=gm it correctly gives 0.9295, matching
        // gm*Rs/(1+gm*Rs) by hand to 6 figures. The qi!==ki case (an
        // emitter-degeneration BJT stage's G[collector][emitter] term, a
        // DIFFERENT verified circuit) needs the ORIGINAL -=gm — confirmed
        // by hand-solving Rc/(re+Re) and getting a match only with -=gm
        // there. Do not "simplify" this back to one uniform sign for all
        // qi>=0: the two cases are genuinely different accumulations and
        // conflating them breaks one to fix the other, as happened here.
        // The mirror case on the OTHER block (si block's pi===si, e.g. a
        // gate tied directly to its own drain) is NOT handled — no circuit
        // in this codebase exercises that topology, so it's left as the
        // block's original code rather than guessing a fix nothing can verify.
        if (qi>=0) G[ki][qi] += (qi===ki ? v.gm : -v.gm); else if (fixed.has(v.q)) I[ki] += v.gm*fixed.get(v.q);
      }
    }

    // Ideal op-amp small-signal VCVS: identical shape to the DC solve's
    // stampOpamp linear branch (-Aol*Vp + Aol*Vm + Vout = 0, i.e. Vout =
    // Aol*(Vp-Vm)), just without a saturation state machine — a unit that
    // reached here at all was already filtered to 'linear' above, and AC
    // small-signal analysis has no rail-clamp concept of its own (same
    // reasoning solveAcNetwork will re-state independently for its own copy
    // of this stamp).
    opampBranches.forEach((o, bIdx) => {
      const iRow = netCountSS + bIdx;
      const pi = idx.has(o.vpNet) ? idx.get(o.vpNet) : -1;
      const mi = idx.has(o.vmNet) ? idx.get(o.vmNet) : -1;
      const oi = idx.has(o.voutNet) ? idx.get(o.voutNet) : -1;
      G[iRow][iRow] += EPS;
      if (pi>=0) G[iRow][pi] -= o.aol; else if (fixed.has(o.vpNet)) I[iRow] += o.aol*fixed.get(o.vpNet);
      if (mi>=0) G[iRow][mi] += o.aol; else if (fixed.has(o.vmNet)) I[iRow] -= o.aol*fixed.get(o.vmNet);
      if (oi>=0) { G[iRow][oi] += 1; G[oi][iRow] += 1; }
    });

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

  // ── Real AC solve: complex-admittance small-signal network at ONE frequency
  // (item 8's fix, step 2) ───────────────────────────────────────────────────
  // A deliberate near-duplicate of solveSmallSignal above, not a shared
  // helper — per CLAUDE.md's "surgical fixes over rewrites", the existing
  // function is proven correct (extensively hand-verified this session) and
  // is NOT touched here. Refactoring the two into one parametrized function
  // would risk the working one to build the new one; a second explicit
  // function costs some duplication but keeps both readable and keeps the
  // proven one's git history/blame clean.
  //
  // The real difference from solveSmallSignal: EVERY conductance here is
  // complex (re/im), and a capacitor's admittance is the actual jwC instead
  // of the fixed CAP_AC_SHORT_R near-short. Solving this at many frequencies
  // (the caller's job) is what finally gives coupling caps and any other
  // frequency-dependent element a real transfer function, instead of the
  // fixed-shape pattern-matching acLoadResistance does in audio-engine.js.
  //
  // gm terms (BJT/JFET/MOSFET controlled sources) stay REAL — this project's
  // hybrid-pi model has no frequency dependence in gm itself (no Cbe/Cbc
  // modeled), only the capacitors introduce frequency dependence. Lifted
  // into complex form via cReal() so they combine with the complex resistor/
  // capacitor admittances in the same matrix.
  // sourceImpedance/loadImpedance: item 6 (input/output impedance). Zero
  // (the default when a caller doesn't pass one) reproduces the old ideal-
  // source/no-load behavior exactly, so existing callers that don't know
  // about this yet keep working unchanged.
  //
  // A source with nonzero output impedance can't be a FIXED node — that
  // would make it an ideal source again, impedance and all downstream
  // loading be damned. It has to be a real Thevenin equivalent: an ideal 1V
  // node, connected through a resistor to the ACTUAL driven net, which
  // becomes a free node like any other. Same pattern this codebase's DC
  // solver already uses for battery internal resistance (see _battery's
  // virtualPos in solveNetVoltages) — a synthetic fixed node plus a real
  // resistor edge, not a special-cased fixed voltage.
  function solveAcNetwork(placed, nets, inputNet, acGroundNets, freqHz, sourceImpedance = 0, outputNet = null, loadImpedance = 0) {
    if (inputNet == null) return null;
    const w = 2 * Math.PI * freqHz;
    const netOf = (row, col) => nets.find(nets.key(row, col));

    const fixed = new Map();
    for (const n of acGroundNets) if (n != null) fixed.set(n, cReal(0));
    if (fixed.has(inputNet)) return null;

    const edges = []; // { a, b, Y } — Y is a complex admittance
    const vccs  = []; // { p, q, src, sink, gm } — gm is REAL (see above); lifted to complex at stamp time
    const opampBranches = []; // { vpNet, vmNet, voutNet, aol } — same ideal-VCVS shape as solveSmallSignal's, aol is real

    if (sourceImpedance > 0) {
      // inputNet is now a FREE node, driven through Rsrc from an ideal 1V
      // node — exactly the shape a real source with output impedance has.
      const idealSrc = '__ac_source_ideal__';
      fixed.set(idealSrc, cReal(1));
      edges.push({ a: idealSrc, b: inputNet, Y: cReal(1 / sourceImpedance) });
    } else {
      fixed.set(inputNet, cReal(1)); // ideal source, unchanged from before this parameter existed
    }
    if (outputNet != null && loadImpedance > 0 && !fixed.has(outputNet)) {
      // A load resistor from the output net to AC ground. Reuses whichever
      // AC-ground net is already fixed at 0 — a real load returns to the
      // same reference everything else in the circuit does.
      const acGroundNet = acGroundNets.find(n => n != null);
      if (acGroundNet != null) edges.push({ a: outputNet, b: acGroundNet, Y: cReal(1 / loadImpedance) });
    }

    for (const inst of placed) {
      if (inst.failed) continue;
      const def = ComponentRegistry.getById(inst.defId);
      const bt  = def?.behavior?.type;
      const L   = inst.legs;

      if (bt === 'resistor' && L.length >= 2) {
        const R = resolvedValue(inst, 'resistance', 1000);
        edges.push({ a: netOf(L[0].row, L[0].col), b: netOf(L[L.length-1].row, L[L.length-1].col),
                     Y: cReal(1 / Math.max(R, 1e-6)) });

      } else if (bt === 'potentiometer' && L.length >= 3) {
        const Rt = parseFloat(inst.props.resistance) || 100000;
        const parsedW = parseFloat(inst.props.wiper);
        const wpos = Number.isNaN(parsedW) ? 0.5 : parsedW;
        const pos = (inst.props.taper||'').includes('Audio') ? Math.pow(wpos,2) : wpos;
        edges.push({ a: netOf(L[0].row, L[0].col), b: netOf(L[1].row, L[1].col), Y: cReal(1/Math.max(Rt*pos, 1)) });
        edges.push({ a: netOf(L[1].row, L[1].col), b: netOf(L[2].row, L[2].col), Y: cReal(1/Math.max(Rt*(1-pos), 1)) });

      } else if (bt === 'capacitor' && L.length >= 2) {
        // The actual point of this function: a real, frequency-dependent
        // admittance instead of solveSmallSignal's fixed near-short.
        const C = resolvedValue(inst, 'capacitance', 1e-6);
        edges.push({ a: netOf(L[0].row, L[0].col), b: netOf(L[L.length-1].row, L[L.length-1].col),
                     Y: capAdmittance(C, w) });

      } else if (bt === 'capacitor_electrolytic' && L.length >= 2) {
        const C = resolvedValue(inst, 'capacitance', 1e-6);
        edges.push({ a: netOf(L[0].row, L[0].col), b: netOf(L[L.length-1].row, L[L.length-1].col),
                     Y: capAdmittance(C, w) });

      } else if ((bt === 'diode' || bt === 'led') && L.length >= 2) {
        const I = inst._current || 0;
        if (I <= 0) continue;
        edges.push({ a: netOf(L[0].row, L[0].col), b: netOf(L[L.length-1].row, L[L.length-1].col),
                     Y: cReal(I / VT) });

      } else if (bt === 'zener_diode' && L.length >= 2) {
        // Same reasoning as solveSmallSignal's zener_diode case: forward
        // uses the exponential I/Vt small-signal conductance, clamped uses
        // the model's real linear Zzt, and `_zenerState` (set by the DC
        // pass in solveComponent) is what distinguishes the two, since this
        // function has no netVoltage to re-derive it from either.
        const I = inst._current || 0;
        if (I <= 0) continue;
        const mk = inst.props.model || '1N4742A';
        const pm = def.model_params?.[mk] || {};
        const clamped = inst._zenerState === 'clamped';
        edges.push({ a: netOf(L[0].row, L[0].col), b: netOf(L[L.length-1].row, L[L.length-1].col),
                     Y: cReal(clamped ? 1/(pm.zzt || 10) : I / VT) });

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
        edges.push({ a: bN, b: eN, Y: cReal(1/rpi) });
        if (pnp) vccs.push({ p: eN, q: bN, src: cN, sink: eN, gm });
        else     vccs.push({ p: bN, q: eN, src: eN, sink: cN, gm });

      } else if (bt === 'jfet_n' && L.length >= 3) {
        const pm = def.model_params?.[inst.props.model] || {};
        const idss = parseFloat(inst.props.idss) ? parseFloat(inst.props.idss)/1000 : (pm.idss_ma||0.45)/1000;
        const vgsOff = parseFloat(inst.props.vgs_off) || pm.vgs_off || -0.65;
        const Id = Math.max(inst._current || 0, 1e-9);
        const gm = 2 * Math.sqrt(idss * Id) / Math.abs(vgsOff);
        const JFET_PINOUTS = { SGD: [0,1,2], DGS: [2,1,0], GSD: [1,0,2] };
        const [sIdx, gIdx, dIdx] = JFET_PINOUTS[inst.props.pinout] || JFET_PINOUTS.SGD;
        const gN = netOf(L[gIdx].row, L[gIdx].col);
        const sN = netOf(L[sIdx].row, L[sIdx].col);
        const dN = netOf(L[dIdx].row, L[dIdx].col);
        vccs.push({ p: gN, q: sN, src: dN, sink: sN, gm });

      } else if (bt === 'mosfet_n' && L.length >= 3) {
        const pm = def.model_params?.[inst.props.model] || {};
        const k = parseFloat(inst.props.k) || pm.k || 0.02;
        const Id = Math.max(inst._current || 0, 1e-9);
        const gm = 2 * Math.sqrt(k * Id);
        const MOSFET_PINOUTS = { DGS: [2,1,0], SGD: [0,1,2] };
        const [sIdx, gIdx, dIdx] = MOSFET_PINOUTS[inst.props.pinout] || MOSFET_PINOUTS.DGS;
        const gN = netOf(L[gIdx].row, L[gIdx].col);
        const sN = netOf(L[sIdx].row, L[sIdx].col);
        const dN = netOf(L[dIdx].row, L[dIdx].col);
        vccs.push({ p: gN, q: sN, src: dN, sink: sN, gm });

      } else if (bt === 'opamp_dual' && L.length >= 8) {
        // Same reasoning as solveSmallSignal's opamp_dual case: an ideal
        // op-amp needs the branch-current MNA extension, not the vccs
        // gm-current shape, and a unit saturated in the DC operating point
        // (per _opampState, set by the DC pass) contributes no small-signal
        // gain at all here either.
        const mk = inst.props.model || 'JRC4558';
        const pm = def.model_params?.[mk] || {};
        const aol = pm.aol || 100000;
        const states = inst._opampState || [null, null];
        const unitDefs = [ { unit:0, outIdx:0, mIdx:1, pIdx:2 }, { unit:1, outIdx:6, mIdx:5, pIdx:4 } ];
        for (const { unit, outIdx, mIdx, pIdx } of unitDefs) {
          if (states[unit] && states[unit] !== 'linear') continue;
          const voutN = netOf(L[outIdx].row, L[outIdx].col);
          const vmN   = netOf(L[mIdx].row, L[mIdx].col);
          const vpN   = netOf(L[pIdx].row, L[pIdx].col);
          opampBranches.push({ vpNet: vpN, vmNet: vmN, voutNet: voutN, aol });
        }

      } else if (bt === 'switch_spst') {
        // Already unioned into one net by buildNetMap when closed.
      }
    }

    const idx = new Map();
    const reg = n => { if (n != null && !fixed.has(n) && !idx.has(n)) idx.set(n, idx.size); };
    for (const e of edges) { reg(e.a); reg(e.b); }
    for (const v of vccs)  { reg(v.p); reg(v.q); reg(v.src); reg(v.sink); }
    for (const o of opampBranches) { reg(o.vpNet); reg(o.vmNet); reg(o.voutNet); }

    const netCountAc = idx.size;
    const N = netCountAc + opampBranches.length;
    const out = new Map(fixed);
    if (N === 0) return out;

    const G = Array.from({length:N}, () => new Array(N).fill(null).map(() => ({re:0,im:0})));
    const I = new Array(N).fill(null).map(() => ({re:0,im:0}));
    for (let i=0;i<N;i++) G[i][i] = cAdd(G[i][i], cReal(EPS));

    for (const e of edges) {
      if (e.a == null || e.b == null || e.a === e.b) continue;
      const ai = idx.has(e.a) ? idx.get(e.a) : -1;
      const bi = idx.has(e.b) ? idx.get(e.b) : -1;
      if (ai>=0) G[ai][ai] = cAdd(G[ai][ai], e.Y);
      if (bi>=0) G[bi][bi] = cAdd(G[bi][bi], e.Y);
      if (ai>=0 && bi>=0) { G[ai][bi] = cSub(G[ai][bi], e.Y); G[bi][ai] = cSub(G[bi][ai], e.Y); }
      else if (ai>=0 && fixed.has(e.b)) I[ai] = cAdd(I[ai], cMul(e.Y, fixed.get(e.b)));
      else if (bi>=0 && fixed.has(e.a)) I[bi] = cAdd(I[bi], cMul(e.Y, fixed.get(e.a)));
    }

    // Same structure and the same qi===ki sign distinction as
    // solveSmallSignal's verified vccs loop — see that function's comment
    // for the full derivation and the hand-solved circuits that pinned down
    // which sign belongs where. gm is real, lifted via cReal() per term.
    for (const v of vccs) {
      const gm = cReal(v.gm);
      const pi = idx.has(v.p) ? idx.get(v.p) : -1, qi = idx.has(v.q) ? idx.get(v.q) : -1;
      const si = idx.has(v.src) ? idx.get(v.src) : -1, ki = idx.has(v.sink) ? idx.get(v.sink) : -1;
      if (si>=0) {
        if (pi>=0) G[si][pi] = cSub(G[si][pi], gm); else if (fixed.has(v.p)) I[si] = cAdd(I[si], cMul(gm, fixed.get(v.p)));
        if (qi>=0) G[si][qi] = cAdd(G[si][qi], gm); else if (fixed.has(v.q)) I[si] = cSub(I[si], cMul(gm, fixed.get(v.q)));
      }
      if (ki>=0) {
        if (pi>=0) G[ki][pi] = cAdd(G[ki][pi], gm); else if (fixed.has(v.p)) I[ki] = cSub(I[ki], cMul(gm, fixed.get(v.p)));
        if (qi>=0) G[ki][qi] = qi===ki ? cAdd(G[ki][qi], gm) : cSub(G[ki][qi], gm);
        else if (fixed.has(v.q)) I[ki] = cAdd(I[ki], cMul(gm, fixed.get(v.q)));
      }
    }

    // Ideal op-amp VCVS, complex form: same -Aol*Vp + Aol*Vm + Vout = 0
    // equation as solveSmallSignal's real-valued version, with aol lifted to
    // complex via cReal() so it can mix into this matrix's complex entries.
    opampBranches.forEach((o, bIdx) => {
      const iRow = netCountAc + bIdx;
      const aolC = cReal(o.aol);
      const pi = idx.has(o.vpNet) ? idx.get(o.vpNet) : -1;
      const mi = idx.has(o.vmNet) ? idx.get(o.vmNet) : -1;
      const oi = idx.has(o.voutNet) ? idx.get(o.voutNet) : -1;
      G[iRow][iRow] = cAdd(G[iRow][iRow], cReal(EPS));
      if (pi>=0) G[iRow][pi] = cSub(G[iRow][pi], aolC); else if (fixed.has(o.vpNet)) I[iRow] = cAdd(I[iRow], cMul(aolC, fixed.get(o.vpNet)));
      if (mi>=0) G[iRow][mi] = cAdd(G[iRow][mi], aolC); else if (fixed.has(o.vmNet)) I[iRow] = cSub(I[iRow], cMul(aolC, fixed.get(o.vmNet)));
      if (oi>=0) { G[iRow][oi] = cAdd(G[iRow][oi], cReal(1)); G[oi][iRow] = cAdd(G[oi][iRow], cReal(1)); }
    });

    const V = gaussianSolveComplex(G, I);
    for (const [net, i] of idx) out.set(net, V[i]);
    return out;
  }

  // ── Complex arithmetic + complex Gaussian solve (foundation for the real AC
  // solve — item 8's fix) ────────────────────────────────────────────────────
  // No external library, per this project's zero-dependency rule, so this is
  // a small hand-rolled {re, im} pair type. Deliberately NOT wired into
  // anything yet — this is step one of a multi-step build (see CLAUDE.md
  // Open work item 8): verify the arithmetic and the solver are correct in
  // isolation, against a hand-solvable RC filter's known closed-form
  // frequency response, before any stamping code or consumer touches it.
  //
  // Why this is needed at all: solveSmallSignal (above) treats every
  // capacitor as a fixed near-short (CAP_AC_SHORT_R), which is deliberate
  // there — it only needs GAIN, and frequency shaping is handled separately
  // by acLoadResistance + hardcoded biquad shapes in audio-engine.js. A real
  // AC solve needs a capacitor's impedance to be 1/(jwC), which varies with
  // frequency, so both the matrix entries and the solve itself have to work
  // over complex numbers.
  function cAdd(a, b) { return { re: a.re + b.re, im: a.im + b.im }; }
  function cSub(a, b) { return { re: a.re - b.re, im: a.im - b.im }; }
  function cMul(a, b) { return { re: a.re*b.re - a.im*b.im, im: a.re*b.im + a.im*b.re }; }
  function cDiv(a, b) {
    const d = b.re*b.re + b.im*b.im;
    if (d === 0) return { re: 0, im: 0 }; // caller's job to keep denominators away from exactly zero (same convention as the real solver's EPS diagonal floor)
    return { re: (a.re*b.re + a.im*b.im) / d, im: (a.im*b.re - a.re*b.im) / d };
  }
  function cAbs(a) { return Math.hypot(a.re, a.im); }
  function cReal(x) { return { re: x, im: 0 }; } // lift a real number into complex, for mixing real conductances with complex ones in the same matrix

  // Complex admittance of a capacitor at angular frequency w (rad/s): jwC.
  // Returns {re:0, im: w*C}.
  function capAdmittance(C, w) { return { re: 0, im: w * C }; }

  // Same shape and pivoting strategy as gaussianSolve, over complex G/I.
  // Kept as a fully separate function rather than a generic templated one —
  // this codebase has no module system and no generics; a second explicit
  // function is more readable here than parametrizing arithmetic ops through
  // callbacks, and it means the real solver (proven correct all session)
  // stays untouched by this change.
  function gaussianSolveComplex(G, I) {
    const n = I.length;
    if (n === 0) return [];
    const A = G.map(row => row.map(x => ({ re: x.re, im: x.im })));
    const b = I.map(x => ({ re: x.re, im: x.im }));
    for (let col = 0; col < n; col++) {
      let piv = col;
      for (let r = col+1; r < n; r++) if (cAbs(A[r][col]) > cAbs(A[piv][col])) piv = r;
      if (cAbs(A[piv][col]) < 1e-15) continue;
      [A[col], A[piv]] = [A[piv], A[col]];
      [b[col], b[piv]] = [b[piv], b[col]];
      for (let r = 0; r < n; r++) {
        if (r === col) continue;
        const f = cDiv(A[r][col], A[col][col]);
        if (f.re === 0 && f.im === 0) continue;
        for (let c = col; c < n; c++) A[r][c] = cSub(A[r][c], cMul(f, A[col][c]));
        b[r] = cSub(b[r], cMul(f, b[col]));
      }
    }
    const x = new Array(n).fill(null).map(() => ({ re: 0, im: 0 }));
    for (let i = 0; i < n; i++) x[i] = cAbs(A[i][i]) > 1e-15 ? cDiv(b[i], A[i][i]) : { re: 0, im: 0 };
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
    const label = def?.labelKey ? I18n.t(def.labelKey) : def.id;
    if (_onFailure) _onFailure({
      icon: icons[fm?.result]||'💥',
      title: I18n.t('app.simulation.componentFailedTitle', { label, which }),
      message: (fm?.messageKey ? I18n.t(fm.messageKey) : null) || I18n.t('app.simulation.genericFailure', { mode })
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
      if (bt !== 'bjt_npn' && bt !== 'bjt_pnp' && bt !== 'jfet_n' && bt !== 'mosfet_n' && bt !== 'diode' && bt !== 'led' && bt !== 'zener_diode') continue;
      for (let i = 0; i < inst.legs.length; i++) {
        const n = nets.find(nets.key(inst.legs[i].row, inst.legs[i].col));
        if (exempt.has(n) || (legsOnNet.get(n) || 0) > 1) continue;
        return {
          who:   inst.props?.title || (def?.labelKey ? I18n.t(def.labelKey) : null) || inst.instanceId,
          leg:   def?.leg_labels?.[i] ? `${def.leg_labels[i]} leg` : `leg ${i + 1}`,
          label: (def?.labelKey ? I18n.t(def.labelKey) : null) || I18n.t('app.simulation.genericComponent'),
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
        const who = inst.props?.title || (def?.labelKey ? I18n.t(def.labelKey) : null) || inst.instanceId;
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

  return { start,stop,reset,isRunning,tick,onFailure,onUpdate,onTopologyChange,notifyStateChange,getVoltageAt,getSmallSignalV,buildNetMap,solveAcNetwork };
})();