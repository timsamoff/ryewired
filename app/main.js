const { app, BrowserWindow, Menu, dialog, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
const COMPONENTS_DIR = path.join(DATA_DIR, 'components');
const LAYOUTS_DIR = path.join(DATA_DIR, 'layouts');

let mainWindow;
let currentFilePath = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#1a1a1a',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    icon: path.join(__dirname, 'renderer', 'icon.png')
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }

  buildMenu();
}

function buildMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        {
          label: 'New Layout',
          accelerator: 'CmdOrCtrl+N',
          click: () => newLayout()
        },
        {
          label: 'Open Layout...',
          accelerator: 'CmdOrCtrl+O',
          click: () => openLayout()
        },
        { type: 'separator' },
        {
          label: 'Save Layout',
          accelerator: 'CmdOrCtrl+S',
          click: () => saveLayout(false)
        },
        {
          label: 'Save Layout As...',
          accelerator: 'CmdOrCtrl+Shift+S',
          click: () => saveLayout(true)
        },
        { type: 'separator' },
        {
          label: 'Import Audio File...',
          accelerator: 'CmdOrCtrl+I',
          click: () => importAudio()
        },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        {
          label: 'Undo',
          accelerator: 'CmdOrCtrl+Z',
          click: () => mainWindow.webContents.send('menu:undo')
        },
        {
          label: 'Redo',
          accelerator: 'CmdOrCtrl+Shift+Z',
          click: () => mainWindow.webContents.send('menu:redo')
        },
        { type: 'separator' },
        {
          label: 'Delete Selected',
          accelerator: 'Backspace',
          click: () => mainWindow.webContents.send('menu:delete')
        },
        {
          label: 'Clear Board',
          click: () => mainWindow.webContents.send('menu:clear')
        }
      ]
    },
    {
      label: 'Simulation',
      submenu: [
        {
          label: 'Run',
          accelerator: 'Space',
          click: () => mainWindow.webContents.send('menu:sim-run')
        },
        {
          label: 'Stop',
          accelerator: 'Escape',
          click: () => mainWindow.webContents.send('menu:sim-stop')
        },
        { type: 'separator' },
        {
          label: 'Reset Board',
          click: () => mainWindow.webContents.send('menu:sim-reset')
        }
      ]
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Toggle Oscilloscope',
          accelerator: 'CmdOrCtrl+D',
          click: () => mainWindow.webContents.send('menu:toggle-scope')
        },
        {
          label: 'Toggle Spectrum Analyzer',
          accelerator: 'CmdOrCtrl+Shift+D',
          click: () => mainWindow.webContents.send('menu:toggle-spectrum')
        },
        { type: 'separator' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { role: 'resetZoom' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'About Ryewired',
          click: () => {
            dialog.showMessageBox(mainWindow, {
              title: 'Ryewired',
              message: 'Ryewired v0.1.0',
              detail: 'An audio circuit simulator for hobbyists.\nDrop components, wire them up, press Play.'
            });
          }
        }
      ]
    }
  ];

  if (process.platform === 'darwin') {
    template.unshift({ role: 'appMenu' });
  }

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── IPC Handlers ─────────────────────────────────────────────────────────────

ipcMain.handle('components:load-all', () => {
  const files = fs.readdirSync(COMPONENTS_DIR).filter(f => f.endsWith('.json'));
  return files.map(f => {
    const raw = fs.readFileSync(path.join(COMPONENTS_DIR, f), 'utf8');
    return JSON.parse(raw);
  });
});

ipcMain.handle('layout:save', async (event, { data, forceDialog }) => {
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
  mainWindow.setTitle(`Ryewired — ${path.basename(currentFilePath)}`);
  return { saved: true, filePath: currentFilePath };
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
  const raw = fs.readFileSync(currentFilePath, 'utf8');
  mainWindow.setTitle(`Ryewired — ${path.basename(currentFilePath)}`);
  return JSON.parse(raw);
});

ipcMain.handle('audio:open', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Import Audio File',
    filters: [{ name: 'Audio', extensions: ['wav', 'mp3', 'ogg', 'flac'] }],
    properties: ['openFile']
  });
  if (result.canceled || !result.filePaths.length) return null;
  const filePath = result.filePaths[0];
  const buffer = fs.readFileSync(filePath);
  return {
    name: path.basename(filePath),
    buffer: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
  };
});

ipcMain.handle('layout:new', () => {
  currentFilePath = null;
  mainWindow.setTitle('Ryewired — Untitled');
  return true;
});

// ── Menu action helpers ───────────────────────────────────────────────────────

function newLayout() {
  mainWindow.webContents.send('menu:new');
}

function openLayout() {
  mainWindow.webContents.send('menu:open');
}

function saveLayout(forceDialog) {
  mainWindow.webContents.send('menu:save', { forceDialog });
}

function importAudio() {
  mainWindow.webContents.send('menu:import-audio');
}

// ── App lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
