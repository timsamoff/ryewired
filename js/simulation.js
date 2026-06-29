// ── Simulation Engine ─────────────────────────────────────────────────────────
// Behavioral nodal analysis. Uses inst.legs[] for hole positions.

const Simulation = (() => {
  let _running=false, _interval=null, _onFailure=null, _onUpdate=null;
  const TICK_MS=10;

  function start() {
    if (_running) return;
    _running=true; _interval=setInterval(tick,TICK_MS);
  }

  function stop() {
    if (!_running) return;
    _running=false; clearInterval(_interval); _interval=null;
  }

  function reset() {
    for (const inst of Board.getPlaced()) {
      inst.failed=false; inst.failureType=null;
      inst._voltage=0; inst._current=0; inst._brightness=0;
    }
    Board.redraw();
  }

  function isRunning() { return _running; }

  function tick() {
    const placed=Board.getPlaced(), wires=Board.getWires();
    const netMap=buildNetMap(placed,wires);
    const supply=placed.find(p=>p.defId==='power_supply');
    const Vs=supply?parseFloat(supply.props.voltage)||9:0;

    for (const inst of placed) {
      if (inst.failed) continue;
      const def=ComponentRegistry.getById(inst.defId);
      if (!def) continue;
      try { solveComponent(inst,def,Vs,netMap,placed); }
      catch(err) { console.warn('[Sim]',err); }
    }
    if (_onUpdate) _onUpdate();
    Board.redraw();
  }

  function solveComponent(inst,def,Vs,netMap,placed) {
    switch(def.behavior?.type) {
      case 'dc_supply':
        inst._voltage=parseFloat(inst.props.voltage)||9; break;

      case 'resistor': {
        const R=parseFloat(inst.props.resistance)||1000;
        const rating=parseWatts(inst.props.power_rating||'0.25W');
        inst._current=Vs/R; inst._voltage=Vs;
        if (inst._voltage*inst._current > rating*(def.failure_modes?.over_power?.threshold_multiplier||2))
          fail(inst,def,'over_power');
        break;
      }

      case 'led': {
        const cm=def.color_map?.[inst.props.color]||{vf:2.0};
        const Vf=parseFloat(inst.props.forward_voltage)||cm.vf;
        const ImA=(parseFloat(inst.props.max_current_ma)||20)/1000;
        const sr=placed.find(p=>p.defId==='resistor'&&!p.failed);
        const R=sr?parseFloat(sr.props.resistance)||470:0;
        const I=R>0?(Vs-Vf)/R:ImA*3;
        inst._current=I; inst._brightness=Utils.clamp(I/ImA,0,1);
        if (I>ImA*(def.failure_modes?.over_current?.threshold_multiplier||1.5)) fail(inst,def,'over_current');
        break;
      }

      case 'potentiometer': {
        const Rt=parseFloat(inst.props.resistance)||100000;
        const w=parseFloat(inst.props.wiper)||0.5;
        const pos=(inst.props.taper||'').includes('Audio')?Math.pow(w,2):w;
        inst._rLow=Rt*pos; inst._rHigh=Rt*(1-pos); inst._voltage=Vs*pos;
        break;
      }

      case 'bjt_npn': {
        const mk=inst.props.model||'2N3904';
        const pm=def.model_params?.[mk]||{};
        const hfe=parseFloat(inst.props.hfe)||pm.hfe||100;
        const Ib=Vs>(pm.vbe||0.65)?(Vs-(pm.vbe||0.65))/10000:0;
        const Ic=hfe*Ib; const IcMax=(pm.max_ic_ma||200)/1000;
        inst._current=Ic;
        if (Ic>IcMax) fail(inst,def,'over_current');
        break;
      }

      case 'capacitor': {
        const vr=parseFloat(inst.props.voltage_rating)||25;
        if (Vs>vr*1.1) fail(inst,def,'over_voltage');
        inst._voltage=Vs; break;
      }

      case 'switch_spst':
        inst._closed=inst._state||inst.props.state==='Closed'; break;

      default: break;
    }
  }

  function fail(inst,def,mode) {
    inst.failed=true; inst.failureType=mode; inst._brightness=0;
    const fm=def.failure_modes?.[mode];
    const icons={burn:'🔥',explode:'💥',smoke:'💨',silent_fail:'⚫'};
    if (_onFailure) _onFailure({
      icon:icons[fm?.result]||'💥',
      title:`${def.label} Failed`,
      message:fm?.message||`Component failure: ${mode}`
    });
    stop(); Board.redraw();
  }

  // Net map using inst.legs[] for hole coordinates
  function buildNetMap(placed,wires) {
    const parent={};
    function key(row,col) { return `${row},${col}`; }
    function find(k) {
      if (!parent[k]) parent[k]=k;
      if (parent[k]!==k) parent[k]=find(parent[k]);
      return parent[k];
    }
    function union(k1,k2) {
      const r1=find(k1),r2=find(k2);
      if (r1!==r2) parent[r1]=r2;
    }

    // Internal column connections (rows 0-4 share per col, rows 5-9 share per col)
    for (let col=0;col<63;col++) {
      for (let r=1;r<=4;r++) union(key(0,col),key(r,col));
      for (let r=6;r<=9;r++) union(key(5,col),key(r,col));
    }
    // Rail connections (with break at col 31)
    for (const rr of ['rtp','rtm','rbp','rbm']) {
      for (let col=1;col<=30;col++) union(key(rr,0),key(rr,col));
      for (let col=32;col<=62;col++) union(key(rr,31),key(rr,col));
    }
    // Wire connections
    for (const w of wires) {
      const k1=key(w.r1,w.c1),k2=key(w.r2,w.c2);
      if(!parent[k1])parent[k1]=k1; if(!parent[k2])parent[k2]=k2;
      union(k1,k2);
    }
    return {find,key};
  }

  function parseWatts(str) { return parseFloat(str)||0.25; }
  function notifyStateChange(inst) { if(_running) tick(); }
  function onFailure(fn) { _onFailure=fn; }
  function onUpdate(fn)  { _onUpdate=fn; }

  return { start,stop,reset,isRunning,tick,onFailure,onUpdate,notifyStateChange };
})();
