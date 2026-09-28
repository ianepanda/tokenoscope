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

const port = +(process.argv[2] || 5178);
const root = path.join(__dirname, '..', 'renderer');
const dataDir = path.join(os.tmpdir(), 'tokenoscope-dev');
const settings = new Settings(path.join(dataDir, 'settings.json'));
let scanner = new Scanner({ roots: settings.get().roots, cacheFile: path.join(dataDir, 'parse-cache.bin') });
let cached = null;

async function dataset(force) {
  if (cached && !force) return cached;
  const t0 = Date.now();
  const scan = await scanner.scan();
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const ds = buildDataset(scan, readSidebar(appData));
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
    if (url.pathname === '/api/settings') {
      if (req.method === 'POST') {
        let raw = '';
        for await (const chunk of req) raw += chunk;
        const patch = JSON.parse(raw || '{}');
        const next = settings.set(patch);
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
