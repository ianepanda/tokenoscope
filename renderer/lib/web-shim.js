// Заглушка window.api для dev-режима в браузере (scripts/dev-server.js). В Electron не грузится.
const revive = (k, v) => (v && typeof v === 'object' && v.__ta ? new globalThis[v.__ta](v.data) : v);
const getJson = (url, opts) => fetch(url, opts).then(async (r) => {
  const t = await r.text();
  if (!r.ok) throw new Error(`dev-сервер ответил ${r.status}: ${t.slice(0, 200)}`);
  return JSON.parse(t, revive);
});

const syncCall = (what, body) => getJson('/api/sync/' + what, { method: 'POST', body: JSON.stringify(body || {}) });
let events = null;
const syncEvent = (name, cb) => {
  if (!events) events = new EventSource('/api/sync/events');
  const h = (e) => cb(JSON.parse(e.data));
  events.addEventListener(name, h);
  return () => events.removeEventListener(name, h);
};

if (!window.api) {
  window.api = {
    getDataset: () => getJson('/api/dataset'),
    rescan: () => getJson('/api/dataset?rescan=1'),
    getSettings: () => getJson('/api/settings'),
    setSettings: (patch) => getJson('/api/settings', { method: 'POST', body: JSON.stringify(patch) }),
    readTranscript: (p) => getJson('/api/read/transcript?path=' + encodeURIComponent(p)),
    readBlock: (p, ln, bi) => getJson(`/api/read/block?path=${encodeURIComponent(p)}&ln=${ln}&bi=${bi}`),
    readJournal: (p) => getJson('/api/read/journal?path=' + encodeURIComponent(p)),
    readScript: (p) => getJson('/api/read/script?path=' + encodeURIComponent(p)),
    // Вместо диалога сохранения — обычное скачивание файла браузером.
    exportTranscript: async (p, format, meta) => {
      const r = await fetch('/api/export', { method: 'POST', body: JSON.stringify({ path: p, format, meta }) });
      if (!r.ok) throw new Error(`dev-сервер ответил ${r.status}: ${(await r.text()).slice(0, 200)}`);
      const name = decodeURIComponent(r.headers.get('x-file-name') || `transcript.${format}`);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(await r.blob());
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      return { path: name, download: true };
    },
    openExport: async () => {},
    revealExport: async () => {},
    showInFolder: async () => {},
    openExternal: async (url) => window.open(url, '_blank'),
    copyText: async (t) => navigator.clipboard && navigator.clipboard.writeText(t),
    pickFolder: async () => null,
    onProgress: () => () => {},
    onDataset: () => () => {},
    syncStatus: () => syncCall('status'),
    syncRefresh: () => syncCall('refresh'),
    syncRun: () => syncCall('run'),
    syncSwitch: (to) => syncCall('switch', { to }),
    syncCloseAndSync: () => syncCall('closeAndSync'),
    syncCancel: () => syncCall('cancel'),
    syncUndo: (opId) => syncCall('undo', { opId }),
    syncLaunch: () => syncCall('launch'),
    syncSetLabel: (account, label) => syncCall('setLabel', { account, label }),
    syncOpenStore: async () => {},
    syncOpenJournal: async () => {},
    onSyncStatus: (cb) => syncEvent('status', cb),
    onSyncProgress: (cb) => syncEvent('progress', cb),
    onNav: () => () => {},
  };
}
