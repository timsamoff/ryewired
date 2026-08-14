// ── Wire Module ───────────────────────────────────────────────────────────────

const Wire = (() => {
  let _wiring = false;
  let _start  = null;

  const COLORS = [
    '#ff9900','#ff3333','#3399ff','#33cc66',
    '#cc33ff','#ffee33','#ffffff','#ff6699',
    '#ff6600','#00ccaa','#aa44ff','#ff99aa'
  ];
  let _colorIdx = 0;

  function startOrFinish(hole) {
    if (!_start) {
      if (typeof Board!=='undefined' && Board.holeOccupied && Board.holeOccupied(hole.row,hole.col,null,null)) {
        // An occupied hole (existing jumper or component leg) can never be a
        // valid wire start (the collision policy forbids two things sharing
        // a hole), so staying in Jumper mode here would just dead-end the
        // user — switch back to Select instead, so the click is useful.
        if (typeof exitToolToSelect === 'function') exitToolToSelect();
        return;
      }
      _start = hole;
      Board.setStartWire(hole);
      const lbl = rowLabel(hole.row);
      setStatus(I18n.t('app.wire.startedAt', { hole: `${lbl}${hole.col+1}` }));
    } else {
      if (_start.row===hole.row && _start.col===hole.col) {
        _start=null; Board.clearWire();
        setStatus(I18n.t('app.wire.cancelledRestart'));
        return;
      }
      if (typeof Board!=='undefined' && Board.holeOccupied && Board.holeOccupied(hole.row,hole.col,null,null)) {
        setStatus(I18n.t('app.wire.holeOccupied'));
        return;
      }
      Board.addWire({
        id:    Utils.uid('W'),
        r1:    _start.row, c1: _start.col,
        r2:    hole.row,   c2: hole.col,
        color: COLORS[(_colorIdx++)%COLORS.length]
      });
      Storage.markDirty();
      History.push();
      _start=null; Board.clearWire();
      setStatus(I18n.t('app.wire.placed'));
    }
  }

  function cancelCurrent() {
    if (!_start) return;
    _start=null; Board.clearWire();
    setStatus(I18n.t('app.wire.cancelled'));
  }

  function enter() { _wiring=true; _start=null; document.body.classList.add('wire-mode'); document.getElementById('status-wire-mode').textContent='⬡ JUMPER'; }
  function exit()  { _wiring=false; _start=null; Board.clearWire(); document.body.classList.remove('wire-mode'); document.getElementById('status-wire-mode').textContent=''; }

  function isWiring() { return _wiring; }
  function hasStart() { return _start!==null; }

  function rowLabel(row) {
    return typeof row==='number'?Board.rowDisplayLabel(row):row;
  }

  // setStatus is a shared global function defined in app.js (not wrapped in
  // its own module), so it's used directly here rather than duplicated —
  // this also means Wire's status messages participate in app.js's
  // generation-tracked auto-clear (see scheduleStatusClear in app.js).

  return { startOrFinish, cancelCurrent, enter, exit, isWiring, hasStart };
})();