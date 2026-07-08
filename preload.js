const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agentnotch', {
  onTelemetry: (cb) => ipcRenderer.on('telemetry', (_e, payload) => cb(payload)),
  setHover: (inside) => ipcRenderer.send('hover', inside),
});
