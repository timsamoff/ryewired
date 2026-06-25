// ── Storage Module ────────────────────────────────────────────────────────────
// Replaces all Electron IPC file operations.
// Primary:  File System Access API (Chrome/Edge 86+) — in-place saves
// Fallback: download link + <input type="file"> — works everywhere

const Storage = (() => {

  const FILE_EXT        = 'rw';
  const FILE_MIME       = 'application/json';
  const FILE_DESC       = 'Ryewired Layout';
  const COMPONENT_BASE  = './data/components/';
  const MANIFEST_PATH   = './data/components/manifest.json';

  const supportsFilePicker = typeof window.showSaveFilePicker === 'function';

  let _fileHandle  = null;   // FileSystemFileHandle — persists across saves
  let _fileName    = 'Untitled';

  // ── Component loading ───────────────────────────────────────────────────────

  async function loadAllComponents() {
    try {
      // Try manifest first
      const res = await fetch(MANIFEST_PATH);
      if (res.ok) {
        const manifest = await res.json();
        const defs = await Promise.all(
          manifest.map(filename =>
            fetch(COMPONENT_BASE + filename)
              .then(r => r.ok ? r.json() : null)
              .catch(() => null)
          )
        );
        return defs.filter(Boolean);
      }
    } catch (_) {}

    // Fallback: try known filenames
    const known = [
      'resistor.json','capacitor.json','led.json','diode.json',
      'potentiometer.json','transistor_npn.json','switch.json',
      'power_supply.json','signal_generator.json'
    ];
    const defs = await Promise.all(
      known.map(f =>
        fetch(COMPONENT_BASE + f)
          .then(r => r.ok ? r.json() : null)
          .catch(() => null)
      )
    );
    return defs.filter(Boolean);
  }

  // ── Layout: New ─────────────────────────────────────────────────────────────

  function newLayout() {
    _fileHandle = null;
    _fileName   = 'Untitled';
    updateTitle();
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
            types: [{
              description: FILE_DESC,
              accept: { [FILE_MIME]: ['.' + FILE_EXT] }
            }]
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
        console.warn('[Storage] FilePicker save failed, falling back:', err);
        // Fall through to download fallback
      }
    }

    // Fallback: trigger download
    downloadJson(json, (_fileName || 'untitled') + '.' + FILE_EXT);
    updateTitle(false);
    return { saved: true, fileName: _fileName + '.' + FILE_EXT };
  }

  // ── Layout: Open ───────────────────────────────────────────────────────────

  async function openLayout() {
    if (supportsFilePicker) {
      try {
        const [handle] = await window.showOpenFilePicker({
          types: [{
            description: FILE_DESC,
            accept: { [FILE_MIME]: ['.' + FILE_EXT] }
          }],
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
        console.warn('[Storage] FilePicker open failed, falling back:', err);
      }
    }

    // Fallback: file input
    return new Promise(resolve => {
      const input   = document.getElementById('file-input');
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
          types: [{
            description: 'Audio Files',
            accept: { 'audio/*': ['.wav', '.mp3', '.ogg', '.flac', '.aac'] }
          }],
          multiple: false
        });
        const file   = await handle.getFile();
        const buffer = await file.arrayBuffer();
        return { name: file.name, buffer };
      } catch (err) {
        if (err.name === 'AbortError') return null;
        console.warn('[Storage] FilePicker audio failed, falling back:', err);
      }
    }

    // Fallback: file input
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
    a.href     = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function updateTitle(dirty = false) {
    const nameEl  = document.getElementById('app-file-name');
    const dirtyEl = document.getElementById('app-dirty');
    if (nameEl)  nameEl.textContent  = _fileName || 'Untitled';
    if (dirtyEl) dirtyEl.classList.toggle('hidden', !dirty);
    document.title = (_fileName || 'Untitled') + ' — Ryewired';
  }

  function markDirty()  { updateTitle(true); }
  function getFileName(){ return _fileName; }

  return {
    loadAllComponents,
    newLayout,
    saveLayout,
    openLayout,
    openAudioFile,
    markDirty,
    getFileName,
    updateTitle
  };
})();
