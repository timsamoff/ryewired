// ── Storage Module ────────────────────────────────────────────────────────────

const Storage = (() => {
  const FILE_EXT      = 'rw';
  const FILE_MIME     = 'application/json';
  const FILE_DESC     = 'Ryewired Layout';
  const MANIFEST_PATH = './data/components/manifest.json';
  const COMP_BASE     = './data/components/';
  const APP_VERSION   = '0.1.0';

  const supportsFilePicker = typeof window.showSaveFilePicker === 'function';
  let _fileHandle = null;
  let _fileName   = 'Untitled';

  // ── Component loading ───────────────────────────────────────────────────────
  async function loadAllComponents() {
    try {
      const res = await fetch(MANIFEST_PATH);
      if (!res.ok) throw new Error(`${res.status}`);
      const manifest = await res.json();
      const defs = await Promise.all(
        manifest.map(f => fetch(COMP_BASE+f).then(r=>r.ok?r.json():null).catch(()=>null))
      );
      const loaded = defs.filter(Boolean);
      console.log(`[Storage] Loaded ${loaded.length} components`);
      return loaded;
    } catch(err) {
      console.error('[Storage] Component load error:', err);
      return [];
    }
  }

  // ── Layout migration ────────────────────────────────────────────────────────
  // Converts old-format instances (inst.row/col) to new legs[] model.
  function migrateLayout(layout) {
    if (!layout?.components) return layout;
    layout.components = layout.components.map(inst => {
      if (inst.legs && inst.legs.length > 0) return inst; // already new format
      const row  = inst.row ?? 3;
      const col  = inst.col ?? 10;
      // Use a conservative 2-leg layout; user can reposition legs after load
      inst.legs = [
        { row, col },
        { row, col: Math.min(62, col + 1) }
      ];
      delete inst.row; delete inst.col; delete inst.orientation; delete inst.rotation;
      return inst;
    });
    return layout;
  }

  // ── New layout ──────────────────────────────────────────────────────────────
  function newLayout() {
    _fileHandle = null;
    _fileName   = 'Untitled';
    updateTitle(false);
    return true;
  }

  // ── Save ────────────────────────────────────────────────────────────────────
  async function saveLayout(data, forceDialog=false) {
    const json = JSON.stringify(data, null, 2);
    if (supportsFilePicker) {
      try {
        if (!_fileHandle||forceDialog) {
          _fileHandle = await window.showSaveFilePicker({
            suggestedName: (_fileName||'untitled')+'.'+FILE_EXT,
            types: [{description:FILE_DESC, accept:{[FILE_MIME]:['.' +FILE_EXT]}}]
          });
        } else {
          // A handle from Open Layout only carries 'read' permission —
          // writing to it needs 'readwrite', which the browser gates behind
          // its own native permission prompt (can't be replaced by an app
          // modal, same security constraint as the file picker itself).
          // Surface our own modal first, on a fresh click, so that native
          // prompt doesn't appear out of nowhere on a plain Ctrl+S.
          const perm = await _fileHandle.queryPermission({ mode: 'readwrite' });
          if (perm !== 'granted') {
            await Modal.alert(
              'Ryewired needs permission to save changes to this file. Click Allow on the next prompt.',
              { title: 'Save Permission Needed', okLabel: 'Continue' }
            );
          }
        }
        const w = await _fileHandle.createWritable();
        await w.write(json); await w.close();
        _fileName = _fileHandle.name.replace(/\.[^.]+$/,'');
        updateTitle(false);
        return { saved:true, fileName:_fileHandle.name };
      } catch(err) {
        if (err.name==='AbortError') return { saved:false };
        if (err.name==='NotAllowedError') {
          await Modal.alert("Save permission was denied, so the file wasn't saved.", { title:'Save Cancelled' });
          return { saved:false };
        }
      }
    }
    downloadJson(json, (_fileName||'untitled')+'.'+FILE_EXT);
    updateTitle(false);
    return { saved:true, fileName:_fileName+'.'+FILE_EXT };
  }

  // ── Open ────────────────────────────────────────────────────────────────────
  async function openLayout() {
    let raw = null;
    if (supportsFilePicker) {
      try {
        const [handle] = await window.showOpenFilePicker({
          types:[{description:FILE_DESC, accept:{[FILE_MIME]:['.' +FILE_EXT]}}], multiple:false
        });
        _fileHandle = handle;
        const file  = await handle.getFile();
        raw         = await file.text();
        _fileName   = file.name.replace(/\.[^.]+$/,'');
        updateTitle(false);
      } catch(err) {
        if (err.name==='AbortError') return null;
      }
    }
    if (!raw) {
      raw = await new Promise(resolve => {
        const input = document.getElementById('file-input');
        input.onchange = async () => {
          const file=input.files[0];
          if (!file){resolve(null);return;}
          _fileHandle=null; _fileName=file.name.replace(/\.[^.]+$/,'');
          updateTitle(false);
          resolve(await file.text());
          input.value='';
        };
        input.click();
      });
    }
    if (!raw) return null;
    try {
      const layout = JSON.parse(raw);
      return migrateLayout(layout);
    } catch { return null; }
  }

  // ── Bundled sample circuits ──────────────────────────────────────────────────
  // Same pattern as AudioEngine's bundled sample clips: fetched once, cached,
  // warmed at module load. The manifest just maps a display name to a .rw
  // filename in vendor/circuits/ — add a new circuit by dropping the file
  // there and adding one line to manifest.json, no code changes needed.
  const CIRCUITS_MANIFEST_PATH = 'vendor/circuits/manifest.json';
  const CIRCUITS_BASE          = 'vendor/circuits/';
  let _circuitManifest = [];
  let _circuitManifestPromise = null;
  function fetchCircuitManifest() {
    if (_circuitManifestPromise) return _circuitManifestPromise;
    _circuitManifestPromise = fetch(CIRCUITS_MANIFEST_PATH)
      .then(res => res.ok ? res.json() : { circuits: [] })
      .then(data => { _circuitManifest = data.circuits || []; return _circuitManifest; })
      .catch(err => { console.error('[Storage] Circuit manifest load error:', err); _circuitManifest = []; return _circuitManifest; });
    return _circuitManifestPromise;
  }
  function getCachedCircuits() { return _circuitManifest; }
  function listCircuits() { return fetchCircuitManifest(); }

  // Fetches a bundled sample circuit and runs it through the exact same
  // parse/migrate path a user-opened .rw file already uses. Also resets the
  // file-identity state the same way newLayout() does — a bundled circuit
  // isn't tied to a writable file handle, so Save should prompt Save As
  // rather than silently trying to overwrite the vendor asset.
  async function loadBundledCircuit(fileName, displayName) {
    try {
      const res = await fetch(CIRCUITS_BASE + fileName);
      if (!res.ok) throw new Error('fetch failed: ' + res.status);
      const raw = await res.text();
      const layout = migrateLayout(JSON.parse(raw));
      _fileHandle = null;
      _fileName   = displayName || fileName.replace(/\.[^.]+$/, '');
      updateTitle(false);
      return layout;
    } catch (err) {
      console.error('[Storage] Sample circuit load error:', err);
      return null;
    }
  }
  fetchCircuitManifest(); // warm the cache at module load, well before File menu could realistically be opened

  // ── Audio ───────────────────────────────────────────────────────────────────
  async function openAudioFile() {
    if (supportsFilePicker) {
      try {
        const [h] = await window.showOpenFilePicker({
          types:[{description:'Audio',accept:{'audio/*':['.wav','.mp3','.ogg','.flac','.aac']}}],
          multiple:false
        });
        const f=await h.getFile();
        return { name:f.name, buffer:await f.arrayBuffer() };
      } catch(err) { if (err.name==='AbortError') return null; }
    }
    return new Promise(resolve=>{
      const input=document.createElement('input');
      input.type='file'; input.accept='.wav,.mp3,.ogg,.flac,.aac,audio/*';
      input.onchange=async()=>{
        const f=input.files[0];
        if(!f){resolve(null);return;}
        resolve({name:f.name,buffer:await f.arrayBuffer()});
      };
      input.click();
    });
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────
  function downloadJson(json, filename) {
    const blob=new Blob([json],{type:FILE_MIME}), url=URL.createObjectURL(blob);
    const a=document.createElement('a'); a.href=url; a.download=filename; a.click();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
  }

  function updateTitle(dirty=false) {
    const n=document.getElementById('app-file-name');
    const d=document.getElementById('app-dirty');
    if(n) n.textContent=_fileName||'Untitled';
    if(d) d.classList.toggle('hidden',!dirty);
    document.title='RYEWIRED — '+(_fileName||'Untitled');
  }

  function markDirty()   { updateTitle(true); }
  function getFileName() { return _fileName; }
  function getVersion()  { return APP_VERSION; }

  return {
    loadAllComponents, newLayout, saveLayout, openLayout, openAudioFile,
    markDirty, getFileName, getVersion, updateTitle,
    getCachedCircuits, listCircuits, loadBundledCircuit
  };
})();