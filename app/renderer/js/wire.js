// ── Wire Module ───────────────────────────────────────────────────────────────

const Wire = (() => {
  let _wiring = false;
  let _start  = null;

  const WIRE_COLORS = [
    '#ff9900','#ff3333','#3399ff','#33cc66',
    '#cc33ff','#ffff33','#ffffff','#ff6699'
  ];
  let _colorIndex = 0;

  function startOrFinish(hole) {
    if (!_wiring || !_start) {
      _start  = hole;
      _wiring = true;
      Board.setStartWire(hole);
      document.getElementById('status-wire-mode').textContent = '⬡ WIRING — click destination hole';
    } else {
      if (_start.row === hole.row && _start.col === hole.col) { cancel(); return; }
      Board.addWire({
        id:    Utils.uid('W'),
        r1:    _start.row, c1: _start.col,
        r2:    hole.row,   c2: hole.col,
        color: WIRE_COLORS[_colorIndex % WIRE_COLORS.length]
      });
      _colorIndex++;
      _start  = null;
      _wiring = false;
      Board.clearWire();
      document.getElementById('status-wire-mode').textContent = '';
      document.getElementById('status-msg').textContent = 'Wire placed';
    }
  }

  function cancel() {
    _start  = null;
    _wiring = false;
    Board.clearWire();
    document.getElementById('status-wire-mode').textContent = '';
  }

  function isWiring() { return _wiring; }
  function enter()    { _wiring = false; _start = null; document.body.classList.add('wire-mode'); }
  function exit()     { cancel(); document.body.classList.remove('wire-mode'); }

  return { startOrFinish, cancel, isWiring, enter, exit };
})();
