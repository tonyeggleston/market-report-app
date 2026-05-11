const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (config) => ipcRenderer.invoke('config:save', config),
  isSetupComplete: () => ipcRenderer.invoke('config:isSetupComplete'),
  completeSetup: (config) => ipcRenderer.invoke('setup:complete', config),

  runReport: (listingAddress) => ipcRenderer.invoke('report:run', listingAddress),
  onProgress: (callback) => {
    ipcRenderer.on('report:progress', (_event, data) => callback(data));
  },

  openReview: () => ipcRenderer.invoke('review:open'),
  onReviewData: (callback) => {
    ipcRenderer.on('review:data', (_event, data) => callback(data));
  },
  finalizeReport: (overrides, descEdits) => ipcRenderer.invoke('review:finalize', overrides, descEdits),
  goBack: () => ipcRenderer.invoke('review:back'),

  showEmail: (emailBody) => ipcRenderer.invoke('email:show', emailBody),
  onEmailReady: (callback) => {
    ipcRenderer.on('email:ready', (_event, emailBody) => callback(emailBody));
  },
  copyToClipboard: (text) => ipcRenderer.invoke('email:copy', text),
  openPath: (filePath) => ipcRenderer.invoke('shell:openPath', filePath),

  getHistory: () => ipcRenderer.invoke('report:history'),
});
