const { contextBridge, ipcRenderer } = require('electron');

// Track listeners so we can clean up on page navigation
const listeners = [];

function safeOn(channel, handler) {
  ipcRenderer.on(channel, handler);
  listeners.push({ channel, handler });
}

// Clean up old listeners when the page unloads (prevents leaks on navigation)
window.addEventListener('beforeunload', () => {
  for (const { channel, handler } of listeners) {
    ipcRenderer.removeListener(channel, handler);
  }
  listeners.length = 0;
});

contextBridge.exposeInMainWorld('api', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (config) => ipcRenderer.invoke('config:save', config),
  isSetupComplete: () => ipcRenderer.invoke('config:isSetupComplete'),
  completeSetup: (config) => ipcRenderer.invoke('setup:complete', config),

  runReport: (listingAddress) => ipcRenderer.invoke('report:run', listingAddress),
  onProgress: (callback) => {
    safeOn('report:progress', (_event, data) => callback(data));
  },

  openReview: () => ipcRenderer.invoke('review:open'),
  onReviewData: (callback) => {
    safeOn('review:data', (_event, data) => callback(data));
  },
  finalizeReport: (overrides, descEdits) => ipcRenderer.invoke('review:finalize', overrides, descEdits),
  goBack: () => ipcRenderer.invoke('review:back'),

  showEmail: (emailBody) => ipcRenderer.invoke('email:show', emailBody),
  onEmailReady: (callback) => {
    safeOn('email:ready', (_event, emailBody) => callback(emailBody));
  },
  copyToClipboard: (text) => ipcRenderer.invoke('email:copy', text),
  openPath: (filePath) => ipcRenderer.invoke('shell:openPath', filePath),

  getHistory: () => ipcRenderer.invoke('report:history'),
  openReportFolder: () => ipcRenderer.invoke('report:openFolder'),

  // License
  validateLicense: () => ipcRenderer.invoke('license:validate'),
  canRunReport: () => ipcRenderer.invoke('license:canRun'),
  activateLicense: (key) => ipcRenderer.invoke('license:activate', key),
  getLicenseKey: () => ipcRenderer.invoke('license:getKey'),
  saveLicenseKey: (key) => ipcRenderer.invoke('license:saveKey', key),
});
