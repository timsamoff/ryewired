const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Components
  loadAllComponents: () => ipcRenderer.invoke('components:load-all'),

  // Layouts
  saveLayout:  (data, forceDialog) => ipcRenderer.invoke('layout:save', { data, forceDialog }),
  openLayout:  () => ipcRenderer.invoke('layout:open'),
  newLayout:   () => ipcRenderer.invoke('layout:new'),

  // Audio
  openAudioFile: () => ipcRenderer.invoke('audio:open'),

  // Menu events → renderer
  onMenu: (channel, fn) => {
    const valid = [
      'menu:new', 'menu:open', 'menu:save',
      'menu:undo', 'menu:redo', 'menu:delete', 'menu:clear',
      'menu:sim-run', 'menu:sim-stop', 'menu:sim-reset',
      'menu:toggle-scope', 'menu:toggle-spectrum',
      'menu:import-audio'
    ];
    if (valid.includes(channel)) {
      ipcRenderer.on(channel, (_, ...args) => fn(...args));
    }
  }
});
