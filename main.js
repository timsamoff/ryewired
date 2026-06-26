const { app, BrowserWindow, Menu, dialog, ipcMain } = require('electron');
const path = require('path');
const fs   = require('fs');

// App root is the directory containing main.js (repo root)
const ROOT_DIR    = __dirname;
const DATA_DIR    = path.join(ROOT_DIR, 'data');
const COMP_DIR    = path.join(DATA_DIR, 'components');
const LAYOUTS_DIR = path.join(DATA_DIR, 'layouts');

let mainWindow;
let currentFilePath = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400, height: 900, minWidth: 1100, minHeight: 700,
    backgroundColor: '#0D0A08',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(ROOT_DIR, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    icon: path.join(ROOT_DIR, 'icon.png')
  });

  // Load index.html from repo root
  mainWindow.loadFile(path.join(ROOT_DIR, 'index.html'));
  buildMenu();
}

function buildMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        { label: 'New Layout',      accelerator: 'CmdOrCtrl+N',       click: () => mainWindow.webContents.send('menu:new') },
        { label: 'Open Layout…',    accelerator: 'CmdOrCtrl+O',       click: () => mainWindow.webContents.send('menu:open') },
        { type: 'separator' },
        { label: 'Save',            accelerator: 'CmdOrCtrl+S',       click: () => mainWindow.webContents.send('menu:save', { forceDialog: false }) },
        { label: 'Save As…',        accelerator: 'CmdOrCtrl+Shift+S', click: () => mainWindow.webContents.send('menu:save', { forceDialog: true }) },
        { type: 'separator' },
        { label: 'Import Audio…',                                      click: () => mainWindow.webContents.send('menu:import-audio') },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo',            accelerator: 'CmdOrCtrl+Z',       click: () => mainWindow.webContents.send('menu:undo') },
        { label: 'Redo',            accelerator: 'CmdOrCtrl+Shift+Z', click: () => mainWindow.webContents.send('menu:redo') },
        { type: 'separator' },
        { label: 'Delete Selected', accelerator: 'Backspace',         click: () => mainWindow.webContents.send('menu:delete') },
        { label: 'Clear Board',                                        click: () => mainWindow.webContents.send('menu:clear') }
      ]
    },
    {
      label: 'Simulation',
      submenu: [
        { label: 'Run',             accelerator: 'Space',             click: () => mainWindow.webContents.send('menu:sim-run') },
        { label: 'Stop',            accelerator: 'Escape',            click: () => mainWindow.webContents.send('menu:sim-stop') },
        { type: 'separator' },
        { label: 'Reset Failures',                                     click: () => mainWindow.webContents.send('menu:sim-reset') }
      ]
    },
    {
      label: 'View',
      submenu: [
        { label: 'Oscilloscope',    accelerator: 'CmdOrCtrl+D',       click: () => mainWindow.webContents.send('menu:toggle-scope') },
        { label: 'Spectrum Analyzer', accelerator: 'CmdOrCtrl+Shift+D', click: () => mainWindow.webContents.send('menu:toggle-spectrum') },
        { type: 'separator' },
        { label: 'Zoom In',         accelerator: 'CmdOrCtrl+=',       click: () => mainWindow.webContents.send('menu:zoom-in') },
        { label: 'Zoom Out',        accelerator: 'CmdOrCtrl+-',       click: () => mainWindow.webContents.send('menu:zoom-out') },
        { label: 'Fit to Window',   accelerator: 'CmdOrCtrl+0',       click: () => mainWindow.webContents.send('menu:zoom-fit') },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Help',
      submenu: [
        { label: 'Ryewired Help',                                      click: () => mainWindow.webContents.send('menu:help') }
      ]
    }
  ];

  if (process.platform === 'darwin') template.unshift({ role: 'appMenu' });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// IPC: component loading (Electron path — web path uses fetch)
ipcMain.handle('components:load-all', () => {
  const files = fs.readdirSync(COMP_DIR).filter(f => f.endsWith('.json') && f !== 'manifest.json');
  return files.map(f => JSON.parse(fs.readFileSync(path.join(COMP_DIR, f), 'utf8')));
});

ipcMain.handle('layout:save', async (_, { data, forceDialog }) => {
  if (!currentFilePath || forceDialog) {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Save Layout',
      defaultPath: path.join(LAYOUTS_DIR, 'untitled.rw'),
      filters: [{ name: 'Ryewired Layout', extensions: ['rw'] }]
    });
    if (result.canceled) return { saved: false };
    currentFilePath = result.filePath;
  }
  fs.writeFileSync(currentFilePath, JSON.stringify(data, null, 2), 'utf8');
  const fname = path.basename(currentFilePath);
  mainWindow.setTitle(`${fname.replace(/\.[^.]+$/, '')} — Ryewired`);
  return { saved: true, fileName: fname };
});

ipcMain.handle('layout:open', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Open Layout',
    defaultPath: LAYOUTS_DIR,
    filters: [{ name: 'Ryewired Layout', extensions: ['rw'] }],
    properties: ['openFile']
  });
  if (result.canceled || !result.filePaths.length) return null;
  currentFilePath = result.filePaths[0];
  const fname = path.basename(currentFilePath);
  mainWindow.setTitle(`${fname.replace(/\.[^.]+$/, '')} — Ryewired`);
  return JSON.parse(fs.readFileSync(currentFilePath, 'utf8'));
});

ipcMain.handle('audio:open', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Import Audio',
    filters: [{ name: 'Audio', extensions: ['wav','mp3','ogg','flac','aac'] }],
    properties: ['openFile']
  });
  if (result.canceled || !result.filePaths.length) return null;
  const fp  = result.filePaths[0];
  const buf = fs.readFileSync(fp);
  return { name: path.basename(fp), buffer: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
});

ipcMain.handle('layout:new', () => {
  currentFilePath = null;
  mainWindow.setTitle('Untitled — Ryewired');
  return true;
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
