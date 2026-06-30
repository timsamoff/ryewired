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
      const bw   = (def.visual?.body_width  || 28) + 40;
      const bh   = (def.visual?.body_height || 14) + 28;
      const W    = Math.max(bw, 80);
      const H    = Math.max(bh, 40);

      const cvs  = document.createElement('canvas');
      // Use plain 1:1 pixel ratio — no retina scaling on drag images
      cvs.width  = W;
      cvs.height = H;
      const ctx  = cvs.getContext('2d');

      ctx.translate(W/2, H/2);
      ctx.globalAlpha = 0.88;

      const halfLen = (bw - 40) / 2;
      const ll      = def.visual?.lead_length || 8;
      const color   = def.visual?.body_color  || '#888';

      // Leads
      ctx.strokeStyle = '#555555'; ctx.lineWidth = 2; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(-halfLen,0); ctx.lineTo(-halfLen+ll,0); ctx.stroke();
      ctx.beginPath(); ctx.moveTo( halfLen,0); ctx.lineTo( halfLen-ll,0); ctx.stroke();
      ctx.fillStyle = '#555555';
      ctx.beginPath(); ctx.arc(-halfLen,0,3,0,Math.PI*2); ctx.fill();
      ctx.beginPath(); ctx.arc( halfLen,0,3,0,Math.PI*2); ctx.fill();

      drawDragBody(ctx, def, color, halfLen, ll);

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

  function drawDragBody(ctx, def, color, halfLen, ll) {
    const bw = def.visual?.body_width  || 28;
    const bh = def.visual?.body_height || 14;

    const rr = (x,y,w,h,r) => {
      ctx.beginPath();
      ctx.moveTo(x+r,y); ctx.lineTo(x+w-r,y); ctx.quadraticCurveTo(x+w,y,x+w,y+r);
      ctx.lineTo(x+w,y+h-r); ctx.quadraticCurveTo(x+w,y+h,x+w-r,y+h);
      ctx.lineTo(x+r,y+h); ctx.quadraticCurveTo(x,y+h,x,y+h-r);
      ctx.lineTo(x,y+r); ctx.quadraticCurveTo(x,y,x+r,y);
      ctx.closePath();
    };

    const BANDS = ['#000','#8B4513','#f00','#f80','#ff0','#0a0','#00f','#808','#999','#fff'];

    switch(def.id) {
      case 'resistor': {
        ctx.fillStyle='#d4b896'; rr(-bw/2,-bh/2,bw,bh,3); ctx.fill();
        ctx.strokeStyle='#b09070'; ctx.lineWidth=0.5; ctx.stroke();
        const res = def.properties?.find(p=>p.key==='resistance')?.default || 10000;
        const m = parseFloat(res.toPrecision(2));
        const s = m.toString().replace('.','').padStart(2,'0').split('').map(Number);
        const mul = Math.max(0,Math.floor(Math.log10(res)-1));
        [BANDS[s[0]%10],BANDS[s[1]%10],BANDS[mul%10],'#c8a000'].forEach((h,i)=>{
          ctx.fillStyle=h; ctx.fillRect(-bw/2+6+i*6,-(bh-2)/2,4,bh-2);
        });
        break;
      }
      case 'capacitor':
        ctx.fillStyle='#e8c860'; rr(-bw/2,-bh/2,bw,bh,2); ctx.fill();
        ctx.strokeStyle='#c8a840'; ctx.lineWidth=0.5; ctx.stroke();
        break;
      case 'capacitor_electrolytic': {
        const r=bw/2;
        ctx.beginPath(); ctx.arc(0,0,r,0,Math.PI*2); ctx.fillStyle=color; ctx.fill();
        ctx.beginPath(); ctx.moveTo(0,0); ctx.arc(0,0,r,Math.PI*0.6,Math.PI*1.4); ctx.closePath();
        ctx.fillStyle='rgba(255,255,255,0.55)'; ctx.fill();
        ctx.fillStyle='rgba(20,20,40,0.9)';
        ctx.font=`bold ${Math.max(8,r*0.65)}px monospace`; ctx.textAlign='center';
        ctx.fillText('–',-r*0.55,r*0.22);
        break;
      }
      case 'led': {
        const r=bw/2,h=bh/2;
        ctx.beginPath();
        ctx.moveTo(-r,-h); ctx.lineTo(-r,h); ctx.lineTo(r*0.3,h);
        ctx.arc(0,0,r,Math.PI*0.5,-Math.PI*0.5,true); ctx.lineTo(r*0.3,-h); ctx.closePath();
        ctx.fillStyle='#ff2200cc'; ctx.fill();
        ctx.strokeStyle='rgba(0,0,0,0.4)'; ctx.lineWidth=0.8; ctx.stroke();
        ctx.strokeStyle='rgba(255,255,255,0.6)'; ctx.lineWidth=1.5;
        ctx.beginPath(); ctx.moveTo(-r,-h); ctx.lineTo(-r,h); ctx.stroke();
        break;
      }
      case 'transistor_npn':
      case 'transistor_pnp': {
        const r=bw/2;
        ctx.fillStyle='#111'; ctx.beginPath();
        ctx.arc(0,0,r,-Math.PI/2,Math.PI/2); ctx.lineTo(0,r); ctx.lineTo(0,-r); ctx.closePath(); ctx.fill();
        ctx.strokeStyle='rgba(255,255,255,0.25)'; ctx.lineWidth=1;
        ctx.beginPath(); ctx.moveTo(0,-r); ctx.lineTo(0,r); ctx.stroke();
        // Center lead hint
        ctx.strokeStyle='#555555'; ctx.lineWidth=2;
        ctx.beginPath(); ctx.moveTo(0,r+2); ctx.lineTo(0,r+ll); ctx.stroke();
        ctx.fillStyle='#555555';
        ctx.beginPath(); ctx.arc(0,r+ll,3,0,Math.PI*2); ctx.fill();
        break;
      }
      case 'potentiometer': {
        ctx.fillStyle=color; rr(-bw/2,-bh/2,bw,bh,3); ctx.fill();
        ctx.beginPath(); ctx.arc(0,0,bw*0.28,0,Math.PI*2); ctx.fillStyle='#777'; ctx.fill();
        // Center lead hint
        ctx.strokeStyle='#555555'; ctx.lineWidth=2;
        ctx.beginPath(); ctx.moveTo(0,bh/2+2); ctx.lineTo(0,bh/2+ll); ctx.stroke();
        ctx.fillStyle='#555555';
        ctx.beginPath(); ctx.arc(0,bh/2+ll,3,0,Math.PI*2); ctx.fill();
        break;
      }
      case 'diode':
        ctx.fillStyle='#1a1a1a'; rr(-bw/2,-bh/2,bw,bh,2); ctx.fill();
        ctx.fillStyle='#ffffff'; ctx.fillRect(bw/2-5,-bh/2,3,bh);
        break;
      case 'power_supply': {
        const hw=bw/2,hh=bh/2;
        ctx.fillStyle='rgba(43,87,154,0.85)';
        ctx.fillRect(-hw,-hh,bw/2,bh);
        ctx.fillStyle='rgba(176,32,46,0.85)';
        ctx.fillRect(0,-hh,bw/2,bh);
        ctx.strokeStyle='rgba(255,255,255,0.2)'; ctx.lineWidth=0.8;
        rr(-hw,-hh,bw,bh,3); ctx.stroke();
        ctx.fillStyle='#fff'; ctx.font=`bold ${Math.max(7,bh*0.45)}px IBM Plex Mono,monospace`; ctx.textAlign='center';
        const v = def.properties?.find(p=>p.key==='voltage')?.default || 9;
        ctx.fillText(`${v}V`,0,3);
        ctx.font='bold 8px monospace';
        ctx.fillStyle='rgba(255,255,255,0.8)'; ctx.fillText('+',hw*0.6,-hh+9);
        ctx.fillText('–',-hw*0.6,-hh+9);
        break;
      }
      default:
        ctx.fillStyle=color; rr(-bw/2,-bh/2,bw,bh,3); ctx.fill();
        ctx.fillStyle='#fff'; ctx.font='bold 9px IBM Plex Mono,monospace'; ctx.textAlign='center';
        ctx.fillText(def.symbol||def.id.slice(0,4).toUpperCase(),0,3);
    }
  }

  function trunc(str,len) {
    if (!str) return '';
    return str.length>len ? str.slice(0,len)+'…' : str;
  }

  return { init, populate };
})();
