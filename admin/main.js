const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs   = require('fs');

// data/ lives at repo root, one level up from admin/
const DATA_DIR = path.join(__dirname, '..', 'data', 'components');

let win;

function createWindow() {
  win = new BrowserWindow({
    width: 1100, height: 800,
    title: 'Ryewired — Component Admin',
    backgroundColor: '#0D0A08',
    icon: path.join(__dirname, 'renderer', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

ipcMain.handle('admin:list-components', () => {
  const files = fs.readdirSync(DATA_DIR)
    .filter(f => f.endsWith('.json') && f !== 'manifest.json');
  return files.map(f => ({
    filename: f,
    def: JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'))
  }));
});

ipcMain.handle('admin:save-component', (_, { filename, def }) => {
  const fp = path.join(DATA_DIR, filename);
  fs.writeFileSync(fp, JSON.stringify(def, null, 2), 'utf8');
  // Update manifest
  updateManifest();
  return { ok: true, filePath: fp };
});

ipcMain.handle('admin:delete-component', async (_, filename) => {
  const result = await dialog.showMessageBox(win, {
    type: 'warning', title: 'Delete Component',
    message: `Delete "${filename}"?`,
    detail: 'This cannot be undone.',
    buttons: ['Cancel', 'Delete'], defaultId: 0, cancelId: 0
  });
  if (result.response !== 1) return { deleted: false };
  fs.unlinkSync(path.join(DATA_DIR, filename));
  updateManifest();
  return { deleted: true };
});

ipcMain.handle('admin:read-component', (_, filename) => {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, filename), 'utf8'));
});

ipcMain.handle('admin:validate-json', (_, jsonStr) => {
  try { JSON.parse(jsonStr); return { valid: true }; }
  catch (e) { return { valid: false, error: e.message }; }
});

// Regenerate manifest.json whenever components change
function updateManifest() {
  const files = fs.readdirSync(DATA_DIR)
    .filter(f => f.endsWith('.json') && f !== 'manifest.json')
    .sort();
  fs.writeFileSync(
    path.join(DATA_DIR, 'manifest.json'),
    JSON.stringify(files, null, 2),
    'utf8'
  );
}
