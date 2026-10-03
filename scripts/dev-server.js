// Dev-режим без Electron: отдаёт renderer/ по HTTP и датасет через /api/*.
// node scripts/dev-server.js [порт]
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Scanner } = require('../lib/scanner');
const { buildDataset } = require('../lib/dataset');
const { readSidebar } = require('../lib/sidebar');
const { Settings } = require('../lib/settings');
const { readTranscript, readBlock, readJournal, readScript } = require('../lib/transcript');
const { buildExport } = require('../lib/export');
const { SyncService } = require('../lib/sync-service');
const { launchDesktop } = require('../lib/desktop');

const port = +(process.argv[2] || 5178);
// --sandbox[=<папка>] — синхронизация аккаунтов пишет в песочницу scripts/sync-sandbox.js.
const sbxArg = process.argv.find((a) => a === '--sandbox' || a.startsWith('--sandbox='));
if (sbxArg) process.env.TOKENOSCOPE_SYNC_SANDBOX = sbxArg.includes('=') ? sbxArg.slice(10) : path.join(fs.realpathSync.native(os.tmpdir()), 'tokenoscope-sync-sbx');
const root = path.join(__dirname, '..', 'renderer');
const dataDir = path.join(os.tmpdir(), 'tokenoscope-dev');
const settings = new Settings(path.join(dataDir, 'settings.json'));
let scanner = new Scanner({ roots: settings.get().roots, cacheFile: path.join(dataDir, 'parse-cache.bin') });
let cached = null;

// Синхронизация аккаунтов. Писать dev-сервер может только в песочницу (TOKENOSCOPE_SYNC_SANDBOX,
// см. scripts/sync-sandbox.js): иначе кнопка в браузере меняла бы настоящие сайдбары Claude.
const sync = new SyncService({ dataDir: path.join(process.env.TOKENOSCOPE_SYNC_SANDBOX || dataDir, 'account-sync'), settings });
const sseClients = new Set();
const sse = (event, data) => {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) res.write(msg);
};
sync.on('status', (st) => sse('status', st));
sync.on('progress', (b) => sse('progress', b));
sync.start();
const SYNC_WRITES = new Set(['run', 'switch', 'closeAndSync', 'undo']);

async function dataset(force) {
  if (cached && !force) return cached;
  const t0 = Date.now();
  const scan = await scanner.scan();
  const ds = buildDataset(scan, readSidebar());
  ds.meta.scan = { ...scan.stats, totalMs: Date.now() - t0, roots: scanner.roots };
  cached = JSON.stringify(ds, (k, v) => (ArrayBuffer.isView(v) ? { __ta: v.constructor.name, data: Array.from(v) } : v));
  return cached;
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json' };

const inRoots = (p) => typeof p === 'string' && scanner.roots.some((r) => path.resolve(p).toLowerCase().startsWith(path.resolve(r).toLowerCase() + path.sep));

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/dataset') {
      const body = await dataset(url.searchParams.has('rescan'));
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(body);
    }
    if (url.pathname === '/api/export' && req.method === 'POST') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const { path: p, format, meta } = JSON.parse(raw || '{}');
      if (!inRoots(p) || !p.toLowerCase().endsWith('.jsonl')) {
        res.writeHead(403);
        return res.end();
      }
      const out = buildExport(p, format, meta);
      res.writeHead(200, {
        'content-type': format === 'html' ? 'text/html; charset=utf-8' : 'text/markdown; charset=utf-8',
        'x-file-name': encodeURIComponent(out.fileName),
      });
      return res.end(out.content);
    }
    if (url.pathname.startsWith('/api/read/')) {
      const p = url.searchParams.get('path');
      if (!inRoots(p)) {
        res.writeHead(403);
        return res.end();
      }
      const what = url.pathname.slice('/api/read/'.length);
      const out = what === 'transcript' ? readTranscript(p)
        : what === 'block' ? readBlock(p, +url.searchParams.get('ln'), +url.searchParams.get('bi'))
        : what === 'journal' ? readJournal(p) : readScript(p);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(out));
    }
    if (url.pathname === '/api/sync/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(': ok\n\n');
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return undefined;
    }
    if (url.pathname.startsWith('/api/sync/')) {
      const what = url.pathname.slice('/api/sync/'.length);
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw || '{}');
      if (SYNC_WRITES.has(what) && !sync.env.sandbox) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
        return res.end('dev-сервер пишет только в песочницу: запусти его с TOKENOSCOPE_SYNC_SANDBOX');
      }
      try {
        if (what === 'refresh') await sync.refresh();
        else if (what === 'run') await sync.run({ trigger: 'manual' });
        else if (what === 'switch') await sync.startSwitch(String(body.to || ''));
        else if (what === 'closeAndSync') await sync.closeAndSync();
        else if (what === 'cancel') sync.cancelFlow();
        else if (what === 'undo') {
          const report = await sync.engine.undo(String(body.opId || ''));
          sync.last = { at: Date.now(), trigger: 'undo', result: 'undone', undo: report };
          await sync.refresh();
        } else if (what === 'launch') {
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end(JSON.stringify(launchDesktop(sync.env)));
        } else if (what === 'setLabel') {
          const labels = { ...(settings.get().accountLabels || {}) };
          if (body.label && String(body.label).trim()) labels[body.account] = String(body.label).trim().slice(0, 60);
          else delete labels[body.account];
          settings.set({ accountLabels: labels });
          await sync.refresh();
        } else if (what === 'status' && !sync.plan && !sync.planning) sync.refresh().catch(() => {});
      } catch (e) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        return res.end(String(e.message || e));
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(sync.status()));
    }
    if (url.pathname === '/api/settings') {
      if (req.method === 'POST') {
        let raw = '';
        for await (const chunk of req) raw += chunk;
        const patch = JSON.parse(raw || '{}');
        const next = settings.set(patch);
        if ('syncAuto' in patch || 'syncLaunchAfter' in patch || 'background' in patch || 'autostart' in patch) sync.push();
        if (patch.syncAuto) sync.maybeAuto('enable').catch(() => {});
        if (patch.roots) {
          scanner = new Scanner({ roots: next.roots, cacheFile: path.join(dataDir, 'parse-cache.bin') });
          cached = null;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(next));
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(settings.get()));
    }
    let file = path.normalize(path.join(root, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname)));
    if (!file.startsWith(root)) {
      res.writeHead(403);
      return res.end();
    }
    let body = fs.readFileSync(file);
    if (file.endsWith('index.html')) {
      body = body.toString().replace("connect-src 'none'", "connect-src 'self'").replace('<script type="module" src="app.js"></script>',
        '<script type="module" src="lib/web-shim.js"></script><script type="module" src="app.js"></script>');
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  } catch (e) {
    res.writeHead(e.code === 'ENOENT' ? 404 : 500);
    res.end(String(e.message || e));
  }
}).listen(port, () => console.log(`dev: http://localhost:${port}`));
