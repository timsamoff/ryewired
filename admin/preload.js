const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('admin', {
  listComponents:  ()             => ipcRenderer.invoke('admin:list-components'),
  saveComponent:   (filename, def)=> ipcRenderer.invoke('admin:save-component', { filename, def }),
  deleteComponent: (filename)     => ipcRenderer.invoke('admin:delete-component', filename),
  readComponent:   (filename)     => ipcRenderer.invoke('admin:read-component', filename),
  validateJson:    (jsonStr)      => ipcRenderer.invoke('admin:validate-json', jsonStr)
});
