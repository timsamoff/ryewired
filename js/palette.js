// ── Palette ────────────────────────────────────────────────────────────────────
// Renders the component list and handles drag-to-board.
// Uses an offscreen canvas to render the actual component as the drag image.

const Palette = (() => {
  let _list, _search;

  function init() {
    _list   = document.getElementById('palette-list');
    _search = document.getElementById('palette-search');
    _search.addEventListener('input', () => render(ComponentRegistry.search(_search.value)));
    document.addEventListener('keydown', e => {
      if ((e.metaKey||e.ctrlKey)&&e.key==='f') { e.preventDefault(); _search.focus(); _search.select(); }
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
    // Any unlisted categories
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
    el.className   = 'palette-item';
    el.draggable   = true;
    el.dataset.defId = def.id;
    el.title       = def.description || def.label;
    el.innerHTML   = `
      <div class="palette-item-symbol">${def.symbol || def.id.slice(0,2).toUpperCase()}</div>
      <div class="palette-item-info">
        <div class="palette-item-label">${def.label}</div>
        <div class="palette-item-desc">${trunc(def.description,40)}</div>
      </div>`;

    el.addEventListener('dragstart', e => {
      e.dataTransfer.setData('text/plain', def.id);
      e.dataTransfer.effectAllowed = 'copy';

      // Build a canvas-rendered drag image of the actual component
      const img = buildDragImage(def);
      if (img) {
        e.dataTransfer.setDragImage(img, img.width/2, img.height/2);
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

  // Build an offscreen canvas with the component rendered on it
  function buildDragImage(def) {
    try {
      const bw  = (def.visual?.body_width  || 28) + 32; // extra room for leads
      const bh  = (def.visual?.body_height || 14) + 24;
      const W   = Math.max(bw * 2, 80);
      const H   = Math.max(bh * 2, 40);
      const cvs = document.createElement('canvas');
      cvs.width  = W * 2; // retina
      cvs.height = H * 2;
      cvs.style.width  = W + 'px';
      cvs.style.height = H + 'px';
      const ctx  = cvs.getContext('2d');
      ctx.scale(2, 2); // retina

      ctx.translate(W/2, H/2);
      ctx.globalAlpha = 0.85;

      const halfLen = (bw - 32) / 2;
      const ll = def.visual?.lead_length || 8;
      const color = def.visual?.body_color || '#888';

      // Leads
      ctx.strokeStyle = '#aaaaaa'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(-halfLen, 0); ctx.lineTo(-halfLen+ll, 0); ctx.stroke();
      ctx.beginPath(); ctx.moveTo( halfLen, 0); ctx.lineTo( halfLen-ll, 0); ctx.stroke();

      // Body — simplified for each type
      drawDragBody(ctx, def, color, halfLen, ll, bw-32, bh-24);

      // Append to body temporarily so setDragImage works
      cvs.style.position = 'absolute';
      cvs.style.left = '-9999px';
      document.body.appendChild(cvs);
      setTimeout(() => document.body.removeChild(cvs), 0);

      return cvs;
    } catch(e) {
      return null;
    }
  }

  function drawDragBody(ctx, def, color, halfLen, ll, bw, bh) {
    const BANDS = ['#000','#8B4513','#f00','#f80','#ff0','#0a0','#00f','#808','#999','#fff'];

    switch(def.id) {
      case 'resistor': {
        ctx.fillStyle = '#d4b896';
        rr(ctx, -bw/2, -bh/2, bw, bh, 3); ctx.fill();
        ctx.strokeStyle = '#b09070'; ctx.lineWidth=0.5; ctx.stroke();
        const res = def.properties?.find(p=>p.key==='resistance')?.default || 10000;
        const m   = parseFloat(res.toPrecision(2));
        const s   = m.toString().replace('.','').padStart(2,'0').split('').map(Number);
        const mul = Math.max(0,Math.floor(Math.log10(res)-1));
        [BANDS[s[0]%10],BANDS[s[1]%10],BANDS[mul%10],'#c8a000'].forEach((h,i)=>{
          ctx.fillStyle=h; ctx.fillRect(-bw/2+6+i*6,-(bh-2)/2,4,bh-2);
        });
        break;
      }
      case 'capacitor':
        ctx.fillStyle='#e8c860'; rr(ctx,-bw/2,-bh/2,bw,bh,2); ctx.fill();
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
        const hex=def.color_map?.['Red']?.hex||'#ff2200', r=bw/2, h2=bh/2;
        ctx.beginPath();
        ctx.moveTo(-r,-h2); ctx.lineTo(-r,h2); ctx.lineTo(r*0.3,h2);
        ctx.arc(0,0,r,Math.PI*0.5,-Math.PI*0.5,true); ctx.lineTo(r*0.3,-h2); ctx.closePath();
        ctx.fillStyle=hex+'cc'; ctx.fill();
        ctx.strokeStyle='rgba(0,0,0,0.4)'; ctx.lineWidth=0.8; ctx.stroke();
        ctx.strokeStyle='rgba(255,255,255,0.6)'; ctx.lineWidth=1.5;
        ctx.beginPath(); ctx.moveTo(-r,-h2); ctx.lineTo(-r,h2); ctx.stroke();
        break;
      }
      case 'transistor_npn':
      case 'transistor_pnp': {
        const r=bw/2;
        ctx.fillStyle='#111'; ctx.beginPath();
        ctx.arc(0,0,r,-Math.PI/2,Math.PI/2); ctx.lineTo(0,r); ctx.lineTo(0,-r); ctx.closePath(); ctx.fill();
        ctx.strokeStyle='rgba(255,255,255,0.25)'; ctx.lineWidth=1;
        ctx.beginPath(); ctx.moveTo(0,-r); ctx.lineTo(0,r); ctx.stroke();
        break;
      }
      case 'diode': {
        ctx.fillStyle='#1a1a1a'; rr(ctx,-bw/2,-bh/2,bw,bh,2); ctx.fill();
        ctx.fillStyle='#ffffff'; ctx.fillRect(bw/2-5,-bh/2,3,bh);
        break;
      }
      default:
        ctx.fillStyle=color; rr(ctx,-bw/2,-bh/2,bw,bh,3); ctx.fill();
        ctx.fillStyle='#fff';
        ctx.font='bold 9px IBM Plex Mono,monospace'; ctx.textAlign='center';
        ctx.fillText(def.symbol||def.id.slice(0,4).toUpperCase(),0,3);
    }
  }

  function rr(ctx,x,y,w,h,r) {
    ctx.beginPath();
    ctx.moveTo(x+r,y);ctx.lineTo(x+w-r,y);ctx.quadraticCurveTo(x+w,y,x+w,y+r);
    ctx.lineTo(x+w,y+h-r);ctx.quadraticCurveTo(x+w,y+h,x+w-r,y+h);
    ctx.lineTo(x+r,y+h);ctx.quadraticCurveTo(x,y+h,x,y+h-r);
    ctx.lineTo(x,y+r);ctx.quadraticCurveTo(x,y,x+r,y);
    ctx.closePath();
  }

  function trunc(str,len) {
    if (!str) return '';
    return str.length>len?str.slice(0,len)+'…':str;
  }

  return { init, populate };
})();
