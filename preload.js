const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  selectFiles: (options) => ipcRenderer.invoke('select-files', options),
  selectOutputDir: () => ipcRenderer.invoke('select-output-dir'),
  getBackendPort: () => ipcRenderer.invoke('get-backend-port'),
  getTheme: () => ipcRenderer.invoke('get-theme'),
  platform: process.platform,
  isMac: process.platform === 'darwin',
});
