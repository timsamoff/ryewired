// ── Hover tooltip ──────────────────────────────────────────────────────────
// Canvas has no native per-shape title=, so board.js (placed components) and
// workbench-strip.js (Power/Input/Output/switch) both drive one shared
// floating div through this module instead. Typical OS tooltip behavior:
// ~500ms hover delay before showing, instant hide on leave.

const Tooltip = (() => {
  const SHOW_DELAY_MS = 500;
  let el = null;
  let showTimer = null;
  let lastKey = null; // whatever the caller uses to identify "still hovering the same thing" — suppresses re-arming the delay on every mousemove pixel

  function el_() {
    if (!el) el = document.getElementById('hover-tooltip');
    return el;
  }

  // Called on every mousemove with (key, text, clientX, clientY). `key`
  // identifies the hovered thing (e.g. an instanceId, or a workbench target
  // name) — passing the SAME key repeatedly (the common case: the mouse
  // drifting a few pixels within one component) just repositions an already-
  // shown tooltip without restarting the delay. `key` changing (a new
  // component, or null) cancels any pending show and hides immediately.
  function show(key, text, x, y) {
    if (key == null || !text) { hide(); return; }
    const node = el_();
    if (!node) return;

    if (key === lastKey) {
      // Same target: if already visible, just follow the cursor. If still
      // pending (within the delay window), leave the timer running as-is.
      if (!node.classList.contains('hidden')) position(node, x, y);
      return;
    }

    // New target: cancel whatever was pending/showing and start the delay
    // fresh — instant hide on leaving the old target is the "instant
    // disappear on hover leave" half of typical tooltip behavior; the show
    // delay below is the other half.
    lastKey = key;
    clearTimeout(showTimer);
    node.classList.add('hidden');
    showTimer = setTimeout(() => {
      node.textContent = text;
      node.classList.remove('hidden');
      position(node, x, y);
    }, SHOW_DELAY_MS);
  }

  function position(node, x, y) {
    // Offset from the cursor so the tooltip doesn't sit directly under it
    // (which would immediately re-trigger a hitTest miss/flicker on some
    // pointer setups). Clamped to the viewport so it can't run off-screen
    // near the board's edges.
    const OFFSET = 14;
    node.style.left = '0px'; node.style.top = '0px'; // reset before measuring, so a stale width doesn't skew the clamp
    const rect = node.getBoundingClientRect();
    let left = x + OFFSET, top = y + OFFSET;
    if (left + rect.width  > window.innerWidth)  left = x - OFFSET - rect.width;
    if (top  + rect.height > window.innerHeight) top  = y - OFFSET - rect.height;
    node.style.left = Math.max(0, left) + 'px';
    node.style.top  = Math.max(0, top)  + 'px';
  }

  function hide() {
    lastKey = null;
    clearTimeout(showTimer);
    const node = el_();
    if (node) node.classList.add('hidden');
  }

  return { show, hide };
})();
