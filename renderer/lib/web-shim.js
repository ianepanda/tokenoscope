// Заглушка window.api для dev-режима в браузере (scripts/dev-server.js). В Electron не грузится.
const revive = (k, v) => (v && typeof v === 'object' && v.__ta ? new globalThis[v.__ta](v.data) : v);
const getJson = (url, opts) => fetch(url, opts).then(async (r) => {
  const t = await r.text();
  if (!r.ok) throw new Error(`dev-сервер ответил ${r.status}: ${t.slice(0, 200)}`);
  return JSON.parse(t, revive);
});

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
    showInFolder: async () => {},
    openExternal: async (url) => window.open(url, '_blank'),
    copyText: async (t) => navigator.clipboard && navigator.clipboard.writeText(t),
    pickFolder: async () => null,
    onProgress: () => () => {},
    onDataset: () => () => {},
  };
}
