// ── Palette ────────────────────────────────────────────────────────────────────

const Palette = (() => {
  let _list, _search;

  function init() {
    _list   = document.getElementById('palette-list');
    _search = document.getElementById('palette-search');
    _search.addEventListener('input', () => render(ComponentRegistry.search(_search.value)));
    document.addEventListener('keydown', e => {
      if ((e.metaKey||e.ctrlKey) && e.key==='f') {
        e.preventDefault(); _search.focus(); _search.select();
      }
    });
    // Palette items used a native title= attribute (a leftover from before
    // the app-wide custom-tooltip conversion) — that's a second, OS-owned
    // tooltip mechanism with its own offset/timing, so it visibly didn't
    // match the custom Tooltip module's 2px-offset positioning used
    // everywhere else. One delegated binding, same pattern as
    // PropertiesPanel/toolbar.
    if (typeof Tooltip !== 'undefined') Tooltip.wireHintDelegate(_list, '.palette-item', { wrap: true });
  }

  function populate(defs) { render(defs); }

  function render(defs) {
    // Signal Generator stays registered (so any already-placed instance from
    // an earlier save still renders/simulates) but is hidden from the
    // palette — its functionality now lives on the permanent Input device.
    defs = defs.filter(d => d.id !== 'signal_generator');
    _list.innerHTML = '';
    const groups = {};
    for (const def of defs) {
      if (!groups[def.category]) groups[def.category] = [];
      groups[def.category].push(def);
    }
    const order = ['power','source','passive','semiconductor','switch','ic'];
    for (const cat of order) {
      if (!groups[cat]?.length) continue;
      const catEl = document.createElement('div');
      catEl.className = 'palette-category';
      catEl.textContent = ComponentRegistry.categoryLabel(cat);
      _list.appendChild(catEl);
      for (const def of groups[cat]) _list.appendChild(buildItem(def));
    }
    for (const [cat, list] of Object.entries(groups)) {
      if (order.includes(cat)) continue;
      const catEl = document.createElement('div');
      catEl.className = 'palette-category';
      catEl.textContent = cat;
      _list.appendChild(catEl);
      for (const def of list) _list.appendChild(buildItem(def));
    }
  }

  function buildItem(def) {
    const label = I18n.t(def.labelKey);
    const description = I18n.t(def.descriptionKey);
    const el = document.createElement('div');
    el.className     = 'palette-item';
    el.draggable     = true;
    el.dataset.defId = def.id;
    el.dataset.hint   = description || label;
    el.innerHTML     = `
      <div class="palette-item-symbol">${def.symbol || def.id.slice(0,2).toUpperCase()}</div>
      <div class="palette-item-info">
        <div class="palette-item-label">${label}</div>
        <div class="palette-item-desc">${trunc(description,40)}</div>
      </div>`;

    el.addEventListener('dragstart', e => {
      e.dataTransfer.setData('text/plain', def.id);
      e.dataTransfer.effectAllowed = 'copy';

      // Build drag image: unscaled canvas so hotspot math is reliable
      const img = buildDragImage(def);
      if (img) {
        // hotspot = center of image
        e.dataTransfer.setDragImage(img, Math.floor(img.width/2), Math.floor(img.height/2));
      }

      if (typeof currentTool==='function' && currentTool()!=='select' && typeof exitToolToSelect==='function') {
        exitToolToSelect(); // placing a component wants normal board interaction, not a measuring/jumper tool
      }
      Board.setDragGhost(def.id);
      document.body.classList.add('dragging');
    });

    el.addEventListener('dragend', () => {
      Board.setDragGhost(null);
      document.body.classList.remove('dragging');
      Board.redraw();
    });

    return el;
  }

  // Build a plain (non-retina) canvas so setDragImage hotspot math is exact.
  // The browser will display it at 1:1; sharpness here doesn't matter much.
  function buildDragImage(def) {
    try {
      const HOLE_PITCH = 20; // must match board.js's board geometry
      const DIP_GAP = 18; // must match board.js's board geometry
      const bw0  = def.visual?.body_width  || 28;
      const bh0  = def.visual?.body_height || 14;
      const legCount = def.legs || 2;
      const span = def.leg_span || 2;
      const STAND_GAP = 14;
      const halfLen = span*HOLE_PITCH/2; // real hole spacing, not body_width — matches board.js
      const isPowerSupply = def.id === 'power_supply';
      const isDip = def.category === 'ic' && legCount >= 8;
      // Match the size an ALREADY-PLACED IC renders at when dragged on-
      // canvas — that path draws through the board's own zoomed/DPR-scaled
      // canvas, so its on-screen size is real-board-units * current zoom.
      // A fixed 0.5 scale (an earlier attempt) was wrong for the same
      // reason a fixed 1.0 would be: this OS drag-image canvas is
      // rendered at 1:1 CSS pixels, independent of the board's own zoom
      // level, so matching the in-canvas drag's real behavior means
      // scaling by whatever the board is CURRENTLY zoomed to, not a
      // constant guess.
      const DIP_GHOST_SCALE = (typeof Board !== 'undefined' && Board.getZoom) ? Board.getZoom() : 1;

      // For standing 3-leg parts, compute the true top-most extent instead
      // of guessing with a fixed padding constant — the round pot knob uses
      // bw0 as its radius (not bh0), so a bh0-only estimate under-sized the
      // canvas and clipped the top of the part.
      let W, H, vOffset;
      if (isDip) {
        // Real DIP-8 footprint (4 pin columns wide, straddling the center
        // channel top-to-bottom) drawn at DIP_GHOST_SCALE (the board's
        // current zoom) — matches the on-screen size an already-placed IC
        // renders at while being dragged, per direct feedback that a
        // fixed scale (both 1.0 and a guessed 0.5) didn't match that.
        const dipPinSpanW = 3*HOLE_PITCH;
        const dipRowSpanH = HOLE_PITCH+DIP_GAP;
        H = (dipRowSpanH + 8) * DIP_GHOST_SCALE;
        W = (dipPinSpanW + 8) * DIP_GHOST_SCALE;
        vOffset = 0;
      } else if (legCount===3) {
        const bodyHalf   = Math.max(bh0/2, bw0/2);
        const topExtent  = -(bh0/2+STAND_GAP) - bodyHalf; // highest point drawn
        const bottomExtent = 0; // legs terminate at the row line
        const PAD = 10;
        H = (bottomExtent-topExtent) + PAD*2;
        vOffset = -((topExtent+bottomExtent)/2);
        W = Math.max(bw0+40, 80);
      } else if (isPowerSupply) {
        // Rotated 90° to match the new default vertical orientation — the
        // canvas needs to swap which dimension is "along the leads" vs
        // "across the body" accordingly, or the rotated content clips.
        H = Math.max(halfLen*2 + 20, 40);
        W = Math.max(bh0 + 24, 80);
        vOffset = 0;
      } else {
        H = Math.max(bh0 + 28, 40);
        vOffset = 0;
        W = Math.max(halfLen*2 + 24, 80); // based on the real leg span, not body width — matches actual placement footprint
      }

      const cvs  = document.createElement('canvas');
      // Use plain 1:1 pixel ratio — no retina scaling on drag images
      cvs.width  = W;
      cvs.height = H;
      const ctx  = cvs.getContext('2d');

      ctx.translate(W/2, H/2 + vOffset);
      if (isDip) ctx.scale(DIP_GHOST_SCALE, DIP_GHOST_SCALE); // canvas is already sized down; scale the real-board-unit drawing to match
      const ang = isPowerSupply ? Math.PI/2 : 0;
      ctx.rotate(ang);
      ctx.globalAlpha = 0.88;

      const ll = def.visual?.lead_length || 8;

      // Build a stand-in instance with default prop values so Shapes.drawBody
      // (the same dispatcher board.js uses for real components) can render
      // this correctly — including model-dependent looks like germanium
      // transistors/diodes — without needing a second copy of that logic.
      const fakeInst = {defId:def.id, props:{}, _brightness:0, _state:false};
      for (const p of (def.properties||[])) fakeInst.props[p.key] = p.default;

      if (isDip) {
        // Mirrors board.js's drawIcInst geometry exactly: 4 pin columns at
        // -1.5,-0.5,0.5,1.5 * HOLE_PITCH from center, body edge IC_TAB_LEN
        // short of the real hole row, a short tab filling that gap. Kept
        // in sync by comment rather than a shared constants module, since
        // this app has no build step to import across files — see
        // board.js's IC_TAB_LEN/IC_STUB_COLOR/IC_BODY_MARGIN for the
        // source values these mirror.
        const IC_TAB_LEN = HOLE_PITCH*0.1405 + 2;
        const IC_STUB_COLOR = '#8a8a8a';
        const IC_BODY_MARGIN = 4;
        const halfRowGapDip = HOLE_PITCH/2 + DIP_GAP/2;
        const bodyHalfHDip = halfRowGapDip - IC_TAB_LEN;
        const stubWDip = HOLE_PITCH*0.4;
        const pinXs = [-1.5, -0.5, 0.5, 1.5].map(m => m*HOLE_PITCH);

        ctx.fillStyle = IC_STUB_COLOR;
        for (const px of pinXs) {
          for (const sign of [-1, 1]) {
            const bodyEdgeY = sign*bodyHalfHDip;
            const holeY = sign*halfRowGapDip;
            const top = Math.min(bodyEdgeY, holeY), h = Math.abs(holeY-bodyEdgeY);
            ctx.fillRect(px-stubWDip/2, top, stubWDip, h);
          }
        }

        const dipBodyW = 3*HOLE_PITCH + IC_BODY_MARGIN*2;
        Shapes.drawBody(ctx, def, fakeInst, null, dipBodyW, bodyHalfHDip*2);
      } else if (legCount===3) {
        // Standing style: body above, three parallel legs straight down —
        // matches board.js's drawInst() for transistor/potentiometer.
        const mid  = Math.round(span/2);
        const xMid = Utils.mapRange(mid,0,span,-halfLen,halfLen);
        const bodyOffY   = -(bh0/2 + STAND_GAP);
        const bodyBottom = bodyOffY + bh0/2;

        ctx.strokeStyle='#555555'; ctx.lineWidth=2; ctx.lineCap='round'; ctx.fillStyle='#555555';
        for (const lx of [-halfLen, xMid, halfLen]) {
          ctx.beginPath(); ctx.moveTo(lx,bodyBottom); ctx.lineTo(lx,0); ctx.stroke();
          ctx.beginPath(); ctx.arc(lx,0,3,0,Math.PI*2); ctx.fill();
        }
        ctx.save();
        ctx.translate(0,bodyOffY);
        Shapes.drawBody(ctx, def, fakeInst, null, halfLen, ang);
        ctx.restore();
      } else {
        // Leads (flat 2-leg style)
        ctx.strokeStyle = '#555555'; ctx.lineWidth = 2; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(-halfLen,0); ctx.lineTo(-halfLen+ll,0); ctx.stroke();
        ctx.beginPath(); ctx.moveTo( halfLen,0); ctx.lineTo( halfLen-ll,0); ctx.stroke();
        ctx.fillStyle = '#555555';
        ctx.beginPath(); ctx.arc(-halfLen,0,3,0,Math.PI*2); ctx.fill();
        ctx.beginPath(); ctx.arc( halfLen,0,3,0,Math.PI*2); ctx.fill();

        Shapes.drawBody(ctx, def, fakeInst, null, halfLen, ang);
      }

      // Temporarily attach to DOM for setDragImage (browser requirement)
      cvs.style.cssText = 'position:absolute;left:-9999px;top:-9999px;pointer-events:none';
      document.body.appendChild(cvs);
      requestAnimationFrame(() => {
        if (cvs.parentNode) cvs.parentNode.removeChild(cvs);
      });

      return cvs;
    } catch(e) {
      return null;
    }
  }

  function trunc(str,len) {
    if (!str) return '';
    return str.length>len ? str.slice(0,len)+'…' : str;
  }

  return { init, populate };
})();