'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getDataset: () => ipcRenderer.invoke('dataset:get'),
  rescan: (opts) => ipcRenderer.invoke('scan:run', opts || {}),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  readTranscript: (p) => ipcRenderer.invoke('transcript:read', p),
  readBlock: (p, ln, bi) => ipcRenderer.invoke('transcript:block', p, ln, bi),
  readJournal: (p) => ipcRenderer.invoke('journal:read', p),
  readScript: (p) => ipcRenderer.invoke('script:read', p),
  exportTranscript: (p, format, meta) => ipcRenderer.invoke('transcript:export', p, format, meta),
  openExport: (p) => ipcRenderer.invoke('export:open', p),
  revealExport: (p) => ipcRenderer.invoke('export:reveal', p),
  showInFolder: (p) => ipcRenderer.invoke('shell:showItem', p),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  copyText: (text) => ipcRenderer.invoke('clipboard:write', text),
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
  onProgress: (cb) => {
    const h = (_e, p) => cb(p);
    ipcRenderer.on('scan:progress', h);
    return () => ipcRenderer.removeListener('scan:progress', h);
  },
  onDataset: (cb) => {
    const h = (_e, d) => cb(d);
    ipcRenderer.on('dataset:updated', h);
    return () => ipcRenderer.removeListener('dataset:updated', h);
  },
});
