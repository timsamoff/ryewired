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
      _start = hole;
      Board.setStartWire(hole);
      const lbl = rowLabel(hole.row);
      setStatus(`Wire started at ${lbl}${hole.col+1} — click another hole to finish, W or Esc to cancel`);
    } else {
      if (_start.row===hole.row && _start.col===hole.col) {
        _start=null; Board.clearWire();
        setStatus('Wire cancelled — click a hole to start again, or press W to exit jumper mode');
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
      setStatus('Wire placed — click another hole to start a new wire, or press W to exit');
    }
  }

  function cancelCurrent() {
    if (!_start) return;
    _start=null; Board.clearWire();
    setStatus('Wire cancelled');
  }

  function enter() { _wiring=true; _start=null; document.body.classList.add('wire-mode'); document.getElementById('status-wire-mode').textContent='⬡ JUMPER'; }
  function exit()  { _wiring=false; _start=null; Board.clearWire(); document.body.classList.remove('wire-mode'); document.getElementById('status-wire-mode').textContent=''; }

  function isWiring() { return _wiring; }
  function hasStart() { return _start!==null; }

  function rowLabel(row) {
    const L=['a','b','c','d','e','f','g','h','i','j'];
    return typeof row==='number'?(L[row]||row):row;
  }

  function setStatus(msg) {
    const el=document.getElementById('status-msg'); if(el) el.textContent=msg;
  }

  return { startOrFinish, cancelCurrent, enter, exit, isWiring, hasStart };
})();
