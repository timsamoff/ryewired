// ── Palette ───────────────────────────────────────────────────────────────────
// Renders the component palette and handles drag-to-board initiation.

const Palette = (() => {
  let _list;
  let _search;
  let _allDefs = [];

  function init() {
    _list   = document.getElementById('palette-list');
    _search = document.getElementById('palette-search');

    _search.addEventListener('input', () => render(ComponentRegistry.search(_search.value)));

    // Keyboard shortcut: focus search
    document.addEventListener('keydown', e => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault();
        _search.focus();
        _search.select();
      }
    });
  }

  function populate(defs) {
    _allDefs = defs;
    render(defs);
  }

  function render(defs) {
    _list.innerHTML = '';

    // Group by category
    const groups = {};
    for (const def of defs) {
      if (!groups[def.category]) groups[def.category] = [];
      groups[def.category].push(def);
    }

    const categoryOrder = ['power', 'source', 'passive', 'semiconductor', 'switch', 'ic'];

    for (const cat of categoryOrder) {
      if (!groups[cat] || groups[cat].length === 0) continue;

      const label = ComponentRegistry.CATEGORY_LABELS[cat] || cat;

      const catEl = document.createElement('div');
      catEl.className = 'palette-category';
      catEl.textContent = label;
      _list.appendChild(catEl);

      for (const def of groups[cat]) {
        const item = buildItem(def);
        _list.appendChild(item);
      }
    }

    // Any uncategorised
    const knownCats = new Set(categoryOrder);
    for (const [cat, defList] of Object.entries(groups)) {
      if (knownCats.has(cat)) continue;
      const catEl = document.createElement('div');
      catEl.className = 'palette-category';
      catEl.textContent = cat;
      _list.appendChild(catEl);
      for (const def of defList) _list.appendChild(buildItem(def));
    }
  }

  function buildItem(def) {
    const el = document.createElement('div');
    el.className   = 'palette-item';
    el.draggable   = true;
    el.dataset.defId = def.id;
    el.title       = def.description || def.label;

    el.innerHTML = `
      <div class="palette-item-symbol">${def.symbol || def.id.slice(0, 2).toUpperCase()}</div>
      <div class="palette-item-info">
        <div class="palette-item-label">${def.label}</div>
        <div class="palette-item-desc">${truncate(def.description, 40)}</div>
      </div>`;

    el.addEventListener('dragstart', e => {
      e.dataTransfer.setData('text/plain', def.id);
      e.dataTransfer.effectAllowed = 'copy';
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

  function truncate(str, len) {
    if (!str) return '';
    return str.length > len ? str.slice(0, len) + '…' : str;
  }

  return { init, populate };
})();
