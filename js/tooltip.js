// ── Hover tooltip ──────────────────────────────────────────────────────────
// Canvas has no native per-shape title=, so board.js (placed components) and
// workbench-strip.js (Power/Input/Output/switch) both drive one shared
// floating div through this module instead. Typical OS tooltip behavior:
// ~500ms hover delay before showing, instant hide on leave.

const Tooltip = (() => {
  const SHOW_DELAY_MS = 500;
  let el = null;
  let showTimer = null;
  let lastKey = null;   // whatever the caller uses to identify "still hovering the same thing" — suppresses re-arming the delay on every mousemove pixel
  let pendingX = null, pendingY = null; // most recent (x,y) seen for lastKey WHILE STILL PENDING — kept fresh so the eventual position() uses where the cursor actually settled, not wherever it happened to be when lastKey was first set
  let shown = false; // true once the tooltip has actually appeared for lastKey — position is locked at that point, same real-tooltip behavior as before, just no longer locked in at the START of the delay window

  function el_() {
    if (!el) el = document.getElementById('hover-tooltip');
    return el;
  }

  // Called on every mousemove with (key, text, clientX, clientY, wrap,
  // theme). `key` identifies the hovered thing (e.g. an instanceId, or a
  // workbench target name). `key` changing (a new component, or null)
  // cancels any pending show and hides immediately.
  //
  // Positioning: while a tooltip is PENDING (still within the 500ms delay,
  // not visible yet), (x,y) keeps updating on every call — a real mouse path
  // toward a target routinely grazes a neighboring hinted element first
  // (e.g. an adjacent toolbar button), which would set `lastKey` there; if
  // position only used that FIRST (x,y), the tooltip would anchor to
  // wherever the path happened to cross, not wherever the cursor actually
  // came to rest before the delay elapsed — this produced a visibly
  // inconsistent gap in real usage even though it measured "correct" in an
  // isolated single-teleport test. Once the tooltip is actually SHOWN, it
  // stops tracking (matches real OS tooltip behavior — appears near the
  // settled cursor, then stays put rather than chasing every further pixel
  // of movement within the same target).
  //
  // `wrap` (default false) opts into the wider, word-wrapping style used for
  // long hints — short board/workbench labels stay single-line. `theme`
  // (default 'native') selects the tooltip's visual style; pass 'dark' for
  // the app's original dark-themed look (kept in app.css as a backup, see
  // #hover-tooltip.theme-dark).
  function show(key, text, x, y, wrap = false, theme = 'native') {
    if (key == null || !text) { hide(); return; }
    const node = el_();
    if (!node) return;

    if (key === lastKey) {
      if (!shown) { pendingX = x; pendingY = y; } // still waiting to appear — keep tracking where the cursor actually is
      return; // already shown for this target — hold position, don't track the cursor
    }

    // New target: cancel whatever was pending/showing and start the delay
    // fresh — instant hide on leaving the old target is the "instant
    // disappear on hover leave" half of typical tooltip behavior; the show
    // delay below is the other half.
    lastKey = key;
    pendingX = x; pendingY = y;
    shown = false;
    clearTimeout(showTimer);
    node.classList.add('hidden');
    showTimer = setTimeout(() => {
      node.textContent = text;
      node.classList.toggle('hint-wrap', wrap);
      node.classList.toggle('theme-dark', theme === 'dark');
      node.classList.remove('hidden');
      shown = true;
      position(node, pendingX, pendingY); // uses the LATEST tracked position for this key, not the one captured when the delay started
    }, SHOW_DELAY_MS);
  }

  // 2px gap from the cursor's visible glyph — not from (x,y) itself. (x,y)
  // is the cursor's HOTSPOT (the tip of the arrow), but the arrow icon's
  // visible body extends down and to the right of that hotspot, so a plain
  // 2px offset from (x,y) lands the tooltip's corner overlapping the
  // cursor graphic instead of clear of it. There's no DOM/CSS API to ask
  // the browser the current cursor glyph's real pixel size, so this uses a
  // fixed estimate (CURSOR_W/CURSOR_H, a typical default-arrow size at
  // 100% OS scale) added on top of the 2px gap — close for the default
  // pointer/arrow cursors used throughout the app, not pixel-exact for
  // every OS/theme/custom cursor.
  //
  // Placement when going right (the common case): the gap must clear the
  // glyph's width, since the tooltip's left edge sits to the right of the
  // hotspot where the glyph occupies that horizontal extent. Placement when
  // FLIPPED to the left of the cursor: the tooltip's right edge only needs
  // to clear the gap itself (2px past the hotspot's own left, since the
  // glyph doesn't extend left of its hotspot).
  const GAP = 2;
  const CURSOR_W = 6, CURSOR_H = 13; // rough default-arrow footprint at 100% OS scale — original estimate was 12/19 (too far), a 8px-per-axis cut to 4/11 landed right on the cursor's hotspot (too close/overlapping), so this is a 6px-per-axis cut from the original 12/19 instead

  // The Y anchor for the down-placement case is different depending on
  // whether `key` is a real DOM element or not. For a real element (every
  // caller through wireHintDelegate — toolbar buttons, palette items,
  // property field labels), a plain cursor+CURSOR_H offset isn't enough to
  // clear a TALL hovered row (a two-line palette item is ~45px, a cursor-
  // sized 15px offset lands the tooltip on top of that row's own second
  // line of text — confirmed as the real cause of tooltips appearing to
  // "overlap the row above": it was actually overlapping the BOTTOM of the
  // row being hovered). So for an Element key, the down-anchor is the
  // element's own bottom edge + GAP, not the cursor's Y + a fixed pad —
  // guarantees clearing the full row regardless of its height, while X
  // still tracks the cursor exactly as before. Canvas-driven callers
  // (board.js/workbench-strip.js) pass a string/id key, not an Element —
  // there's no DOM row to measure there, so they keep the pure
  // cursor-offset behavior, which is correct for their small drawn shapes.
  function position(node, x, y) {
    node.style.left = '0px'; node.style.top = '0px'; // reset before measuring, so a stale width doesn't skew the flip check
    const rect = node.getBoundingClientRect();
    const rightX = x + GAP + CURSOR_W, leftX = x - GAP - rect.width;
    const downAnchorY = (lastKey instanceof Element) ? lastKey.getBoundingClientRect().bottom : y + CURSOR_H;
    const downY = downAnchorY + GAP, upY = y - GAP - rect.height;
    const left = (rightX + rect.width  > window.innerWidth)  ? leftX : rightX;
    const top  = (downY  + rect.height > window.innerHeight) ? upY   : downY;
    node.style.left = Math.max(0, left) + 'px';
    node.style.top  = Math.max(0, top)  + 'px';
  }

  function hide() {
    lastKey = null;
    pendingX = null; pendingY = null;
    shown = false;
    clearTimeout(showTimer);
    const node = el_();
    if (node) node.classList.add('hidden');
  }

  // Wires a single delegated mousemove/mouseleave pair on `container` for
  // every descendant matching `selector` that carries a `data-hint`
  // attribute — the shared pattern used for real DOM tooltips (toolbar
  // buttons, menu items, properties-panel fields) as opposed to canvas
  // hit-testing (board.js/workbench-strip.js, which have no elements to
  // delegate from and call show()/hide() directly instead). One binding
  // survives the container's children being replaced wholesale on re-render
  // (e.g. properties-panel's showComponent()), so callers only need this
  // once per container, not once per rendered field.
  function wireHintDelegate(container, selector, { wrap = false } = {}) {
    if (!container) return;
    container.addEventListener('mousemove', e => {
      const target = e.target.closest(selector);
      if (!target || !target.dataset.hint) { hide(); return; }
      show(target, target.dataset.hint, e.clientX, e.clientY, wrap);
    });
    container.addEventListener('mouseleave', hide);
  }

  return { show, hide, wireHintDelegate };
})();
