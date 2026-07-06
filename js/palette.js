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
  }

  function populate(defs) { render(defs); }

  function render(defs) {
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
      catEl.textContent = ComponentRegistry.CATEGORY_LABELS[cat] || cat;
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
    const el = document.createElement('div');
    el.className     = 'palette-item';
    el.draggable     = true;
    el.dataset.defId = def.id;
    el.title         = def.description || def.label;
    el.innerHTML     = `
      <div class="palette-item-symbol">${def.symbol || def.id.slice(0,2).toUpperCase()}</div>
      <div class="palette-item-info">
        <div class="palette-item-label">${def.label}</div>
        <div class="palette-item-desc">${trunc(def.description,40)}</div>
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
      const bw0  = def.visual?.body_width  || 28;
      const bh0  = def.visual?.body_height || 14;
      const legCount = def.legs || 2;
      const span = def.leg_span || 2;
      const STAND_GAP = 14;
      const halfLen = span*HOLE_PITCH/2; // real hole spacing, not body_width — matches board.js
      const isPowerSupply = def.id === 'power_supply';

      // For standing 3-leg parts, compute the true top-most extent instead
      // of guessing with a fixed padding constant — the round pot knob uses
      // bw0 as its radius (not bh0), so a bh0-only estimate under-sized the
      // canvas and clipped the top of the part.
      let W, H, vOffset;
      if (legCount===3) {
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
        W = Math.max(bw0+40, 80);
      }

      const cvs  = document.createElement('canvas');
      // Use plain 1:1 pixel ratio — no retina scaling on drag images
      cvs.width  = W;
      cvs.height = H;
      const ctx  = cvs.getContext('2d');

      ctx.translate(W/2, H/2 + vOffset);
      const ang = isPowerSupply ? -Math.PI/2 : 0;
      ctx.rotate(ang);
      ctx.globalAlpha = 0.88;

      const ll = def.visual?.lead_length || 8;

      // Build a stand-in instance with default prop values so Shapes.drawBody
      // (the same dispatcher board.js uses for real components) can render
      // this correctly — including model-dependent looks like germanium
      // transistors/diodes — without needing a second copy of that logic.
      const fakeInst = {defId:def.id, props:{}, _brightness:0, _state:false};
      for (const p of (def.properties||[])) fakeInst.props[p.key] = p.default;

      if (legCount===3) {
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