const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  loadAllComponents: () => ipcRenderer.invoke('components:load-all'),
  saveLayout:  (data, forceDialog) => ipcRenderer.invoke('layout:save', { data, forceDialog }),
  openLayout:  () => ipcRenderer.invoke('layout:open'),
  newLayout:   () => ipcRenderer.invoke('layout:new'),
  openAudioFile: () => ipcRenderer.invoke('audio:open'),
  onMenu: (channel, fn) => {
    const valid = [
      'menu:new','menu:open','menu:save','menu:undo','menu:redo',
      'menu:delete','menu:clear','menu:sim-run','menu:sim-stop','menu:sim-reset',
      'menu:toggle-scope','menu:toggle-spectrum',
      'menu:zoom-in','menu:zoom-out','menu:zoom-fit',
      'menu:import-audio','menu:help'
    ];
    if (valid.includes(channel)) ipcRenderer.on(channel, (_, ...args) => fn(...args));
  }
});
