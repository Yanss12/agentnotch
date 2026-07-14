const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agentnotch', {
  onTelemetry: (cb) => ipcRenderer.on('telemetry', (_e, payload) => cb(payload)),
  setHover: (inside) => ipcRenderer.send('hover', inside),
  // mac notch mode: main drives expand/collapse by polling the real cursor.
  onMacExpand: (cb) => ipcRenderer.on('mac-expand', (_e, open) => cb(open)),
  onMacBanner: (cb) => ipcRenderer.on('mac-banner', (_e, info) => cb(info)),
  setPin: (pinned) => ipcRenderer.send('pin', pinned),
  reportPanelH: (px) => ipcRenderer.send('panel-h', px),
  // approvals: decision is 'allow' | 'deny' | 'answer' (answer carries a label)
  sendDecision: (id, decision, answer) => ipcRenderer.send('decision', { id, decision, answer }),
  dismissSession: (sid) => ipcRenderer.send('dismiss-session', sid),
});
