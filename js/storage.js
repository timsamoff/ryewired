// ── Storage Module ────────────────────────────────────────────────────────────
// File System Access API (Chrome/Edge 86+) with download/input fallback.

const Storage = (() => {

  const FILE_EXT       = 'rw';
  const FILE_MIME      = 'application/json';
  const FILE_DESC      = 'Ryewired Layout';
  const MANIFEST_PATH  = './data/components/manifest.json';
  const COMPONENT_BASE = './data/components/';
  const APP_VERSION    = '0.1.0';

  const supportsFilePicker = typeof window.showSaveFilePicker === 'function';

  let _fileHandle = null;
  let _fileName   = 'Untitled';

  // ── Component loading ───────────────────────────────────────────────────────

  async function loadAllComponents() {
    try {
      const res = await fetch(MANIFEST_PATH);
      if (!res.ok) throw new Error(`Manifest fetch failed: ${res.status}`);
      const manifest = await res.json();
      const defs = await Promise.all(
        manifest.map(filename =>
          fetch(COMPONENT_BASE + filename)
            .then(r => r.ok ? r.json() : null)
            .catch(() => null)
        )
      );
      const loaded = defs.filter(Boolean);
      console.log(`[Storage] Loaded ${loaded.length} components`);
      return loaded;
    } catch (err) {
      console.error('[Storage] Component load error:', err);
      return [];
    }
  }

  // ── Layout: New ─────────────────────────────────────────────────────────────

  function newLayout() {
    _fileHandle = null;
    _fileName   = 'Untitled';
    updateTitle(false);
    return true;
  }

  // ── Layout: Save ───────────────────────────────────────────────────────────

  async function saveLayout(data, forceDialog = false) {
    const json = JSON.stringify(data, null, 2);

    if (supportsFilePicker) {
      try {
        if (!_fileHandle || forceDialog) {
          _fileHandle = await window.showSaveFilePicker({
            suggestedName: (_fileName || 'untitled') + '.' + FILE_EXT,
            types: [{ description: FILE_DESC, accept: { [FILE_MIME]: ['.' + FILE_EXT] } }]
          });
        }
        const writable = await _fileHandle.createWritable();
        await writable.write(json);
        await writable.close();
        _fileName = _fileHandle.name.replace(/\.[^.]+$/, '');
        updateTitle(false);
        return { saved: true, fileName: _fileHandle.name };
      } catch (err) {
        if (err.name === 'AbortError') return { saved: false };
        console.warn('[Storage] FilePicker save failed, using download fallback:', err);
      }
    }

    // Fallback: download
    downloadJson(json, (_fileName || 'untitled') + '.' + FILE_EXT);
    updateTitle(false);
    return { saved: true, fileName: _fileName + '.' + FILE_EXT };
  }

  // ── Layout: Open ───────────────────────────────────────────────────────────

  async function openLayout() {
    if (supportsFilePicker) {
      try {
        const [handle] = await window.showOpenFilePicker({
          types: [{ description: FILE_DESC, accept: { [FILE_MIME]: ['.' + FILE_EXT] } }],
          multiple: false
        });
        _fileHandle = handle;
        const file  = await handle.getFile();
        const text  = await file.text();
        _fileName   = file.name.replace(/\.[^.]+$/, '');
        updateTitle(false);
        return JSON.parse(text);
      } catch (err) {
        if (err.name === 'AbortError') return null;
        console.warn('[Storage] FilePicker open failed, using input fallback:', err);
      }
    }

    // Fallback: file input
    return new Promise(resolve => {
      const input = document.getElementById('file-input');
      input.onchange = async () => {
        const file = input.files[0];
        if (!file) { resolve(null); return; }
        const text  = await file.text();
        _fileHandle = null;
        _fileName   = file.name.replace(/\.[^.]+$/, '');
        updateTitle(false);
        try { resolve(JSON.parse(text)); }
        catch { resolve(null); }
        input.value = '';
      };
      input.click();
    });
  }

  // ── Audio file ─────────────────────────────────────────────────────────────

  async function openAudioFile() {
    if (supportsFilePicker) {
      try {
        const [handle] = await window.showOpenFilePicker({
          types: [{ description: 'Audio Files', accept: { 'audio/*': ['.wav','.mp3','.ogg','.flac','.aac'] } }],
          multiple: false
        });
        const file   = await handle.getFile();
        const buffer = await file.arrayBuffer();
        return { name: file.name, buffer };
      } catch (err) {
        if (err.name === 'AbortError') return null;
      }
    }

    return new Promise(resolve => {
      const input    = document.createElement('input');
      input.type     = 'file';
      input.accept   = '.wav,.mp3,.ogg,.flac,.aac,audio/*';
      input.onchange = async () => {
        const file = input.files[0];
        if (!file) { resolve(null); return; }
        const buffer = await file.arrayBuffer();
        resolve({ name: file.name, buffer });
      };
      input.click();
    });
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  function downloadJson(json, filename) {
    const blob = new Blob([json], { type: FILE_MIME });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // Title format: "filename — Ryewired"
  function updateTitle(dirty = false) {
    const nameEl  = document.getElementById('app-file-name');
    const dirtyEl = document.getElementById('app-dirty');
    if (nameEl)  nameEl.textContent = _fileName || 'Untitled';
    if (dirtyEl) dirtyEl.classList.toggle('hidden', !dirty);
    document.title = (_fileName || 'Untitled') + ' — Ryewired';
  }

  function markDirty()   { updateTitle(true); }
  function getFileName() { return _fileName; }
  function getVersion()  { return APP_VERSION; }

  return {
    loadAllComponents,
    newLayout, saveLayout, openLayout, openAudioFile,
    markDirty, getFileName, getVersion, updateTitle
  };
})();
