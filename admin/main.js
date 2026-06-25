const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs   = require('fs');

const DATA_DIR       = path.join(__dirname, '..', 'data', 'components');
const BEHAVIORS_FILE = path.join(__dirname, '..', 'data', 'behaviors.json');

let win;

function createWindow() {
  win = new BrowserWindow({
    width:  1100,
    height: 800,
    title:  'Breadboard Sim — Component Admin',
    backgroundColor: '#1a1a1a',
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false
    }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// ── IPC ───────────────────────────────────────────────────────────────────────

ipcMain.handle('admin:list-components', () => {
  const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json'));
  return files.map(f => {
    const raw = fs.readFileSync(path.join(DATA_DIR, f), 'utf8');
    return { filename: f, def: JSON.parse(raw) };
  });
});

ipcMain.handle('admin:save-component', (_, { filename, def }) => {
  const filePath = path.join(DATA_DIR, filename);
  fs.writeFileSync(filePath, JSON.stringify(def, null, 2), 'utf8');
  return { ok: true, filePath };
});

ipcMain.handle('admin:delete-component', async (_, filename) => {
  const result = await dialog.showMessageBox(win, {
    type:    'warning',
    title:   'Delete Component',
    message: `Delete "${filename}"?`,
    detail:  'This cannot be undone.',
    buttons: ['Cancel', 'Delete'],
    defaultId: 0,
    cancelId:  0
  });
  if (result.response !== 1) return { deleted: false };
  fs.unlinkSync(path.join(DATA_DIR, filename));
  return { deleted: true };
});

ipcMain.handle('admin:read-component', (_, filename) => {
  const raw = fs.readFileSync(path.join(DATA_DIR, filename), 'utf8');
  return JSON.parse(raw);
});

ipcMain.handle('admin:validate-json', (_, jsonStr) => {
  try { JSON.parse(jsonStr); return { valid: true }; }
  catch (e) { return { valid: false, error: e.message }; }
});
