// Проверка без Electron: разбирает транскрипты и печатает итоги за окно.
// node scripts/check.js [начало ISO] [конец ISO] [--no-cache]
const os = require('os');
const path = require('path');
const { Scanner } = require('../lib/scanner');
const { buildDataset } = require('../lib/dataset');
const { readSidebar } = require('../lib/sidebar');

(async () => {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const noCache = process.argv.includes('--no-cache');
  const start = args[0] ? Date.parse(args[0] + 'Z') : 0;
  const end = args[1] ? Date.parse(args[1] + 'Z') : Infinity;
  const roots = [path.join(os.homedir(), '.claude', 'projects')];
  const scanner = new Scanner({ roots, cacheFile: noCache ? null : path.join(os.tmpdir(), 'claude-usage-lens-check.cache') });
  const t0 = Date.now();
  const scan = await scanner.scan((p) => {
    if (p.done === p.total) process.stderr.write(`parsed ${p.done}/${p.total} files, ${(p.bytesDone / 1e6).toFixed(0)} MB\n`);
  });
  const t1 = Date.now();
  const ds = buildDataset(scan, readSidebar());
  const t2 = Date.now();
  console.log(`scan ${t1 - t0} ms (parsed ${scan.stats.parsed}, cached ${scan.stats.cached}, errors ${scan.stats.errors.length}), build ${t2 - t1} ms`);
  console.log(`rows ${ds.meta.rows}, dupes ${ds.meta.dupes}, files ${ds.meta.files}, sessions ${ds.meta.sessions}, projects ${ds.projects.length}, cats ${ds.cats.length}, attr ${ds.attr.cat.length}, heavy ${ds.heavy.length}, badLines ${ds.meta.badLines}`);
  const R = ds.rows;
  const tot = { req: 0, inp: 0, cw5m: 0, cw1h: 0, cr: 0, out: 0, ctx: 0, attr: 0 };
  const kinds = [0, 0, 0];
  for (let i = 0; i < ds.meta.rows; i++) {
    if (R.ts[i] < start || R.ts[i] >= end) continue;
    tot.req++;
    tot.inp += R.inp[i];
    tot.cw5m += R.cw5m[i];
    tot.cw1h += R.cw1h[i];
    tot.cr += R.cr[i];
    tot.out += R.out[i];
    const ctx = R.inp[i] + R.cw5m[i] + R.cw1h[i] + R.cr[i];
    tot.ctx += ctx;
    kinds[ds.files[R.file[i]].kind] += ctx;
    for (let j = R.aOff[i]; j < R.aOff[i + 1]; j++) tot.attr += ds.attr.tok[j];
  }
  console.log('window totals', tot, 'attr/ctx', (tot.attr / tot.ctx).toFixed(4));
  console.log('ctx by kind main/sub/wf', kinds.map((k) => (k / 1e9).toFixed(2) + 'B'));
  // Доли по группам
  const g = {};
  for (let i = 0; i < ds.meta.rows; i++) {
    if (R.ts[i] < start || R.ts[i] >= end) continue;
    for (let j = R.aOff[i]; j < R.aOff[i + 1]; j++) {
      const c = ds.cats[ds.attr.cat[j]];
      g[c.group] = (g[c.group] || 0) + ds.attr.tok[j];
    }
  }
  const gs = Object.entries(g).sort((a, b) => b[1] - a[1]);
  const gt = gs.reduce((s, x) => s + x[1], 0);
  for (const [k, v] of gs) console.log(`  ${ds.groups[k].padEnd(40)} ${(100 * v / gt).toFixed(1)}%`);
  const top = ds.sessions.map((s, i) => ({ s, i, ctx: 0 }));
  for (let i = 0; i < ds.meta.rows; i++) {
    if (R.ts[i] < start || R.ts[i] >= end) continue;
    top[ds.files[R.file[i]].session].ctx += R.inp[i] + R.cw5m[i] + R.cw1h[i] + R.cr[i];
  }
  top.sort((a, b) => b.ctx - a.ctx);
  for (const t of top.slice(0, 6)) console.log(`  ${(t.ctx / 1e9).toFixed(2)}B  ${ds.projects[t.s.project].name}  ${t.s.title}`);
})();
