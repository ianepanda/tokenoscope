'use strict';
// Поиск транскриптов, кэш разобранных файлов и пул worker-потоков.
const fs = require('fs');
const os = require('os');
const path = require('path');
const v8 = require('v8');
const { Worker } = require('worker_threads');
const { PARSER_VERSION } = require('./parser');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return [];
  }
}

function safeStat(p) {
  try {
    return fs.statSync(p);
  } catch (e) {
    return null;
  }
}

// Файлы одного корня (~/.claude/projects): основные потоки, субагенты, агенты воркфлоу, скрипты воркфлоу.
function discover(roots) {
  const files = [];
  const scripts = []; // {sessionId, run, name, desc}
  for (const root of roots) {
    for (const pd of safeReaddir(root)) {
      if (!pd.isDirectory()) continue;
      const projDir = path.join(root, pd.name);
      for (const ent of safeReaddir(projDir)) {
        const p = path.join(projDir, ent.name);
        if (ent.isFile() && ent.name.endsWith('.jsonl')) {
          const st = safeStat(p);
          if (st) files.push({ path: p, kind: 'main', sessionId: ent.name.slice(0, -6), projDir: pd.name, root, size: st.size, mtimeMs: st.mtimeMs });
        } else if (ent.isDirectory() && UUID_RE.test(ent.name)) {
          const sessionId = ent.name;
          walkSubagents(path.join(p, 'subagents'), sessionId, pd.name, root, null, files);
          for (const sf of safeReaddir(path.join(p, 'workflows', 'scripts'))) {
            if (!sf.isFile() || !sf.name.endsWith('.js')) continue;
            const m = /^(.*)-(wf_[a-z0-9-]+)\.js$/i.exec(sf.name);
            if (!m) continue;
            let desc = null;
            try {
              const fd = fs.openSync(path.join(p, 'workflows', 'scripts', sf.name), 'r');
              const buf = Buffer.alloc(4096);
              const n = fs.readSync(fd, buf, 0, 4096, 0);
              fs.closeSync(fd);
              const head = buf.toString('utf8', 0, n);
              const dm = /description:\s*['"`]([^'"`]+)/.exec(head);
              if (dm) desc = dm[1];
            } catch (e) { /* ignore */ }
            scripts.push({ sessionId, run: m[2], name: m[1], desc, path: path.join(p, 'workflows', 'scripts', sf.name) });
          }
        }
      }
    }
  }
  return { files, scripts };
}

function walkSubagents(dir, sessionId, projDir, root, run, out) {
  for (const ent of safeReaddir(dir)) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      walkSubagents(p, sessionId, projDir, root, ent.name.startsWith('wf_') ? ent.name : run, out);
    } else if (ent.isFile() && ent.name.endsWith('.jsonl') && ent.name !== 'journal.jsonl') {
      const st = safeStat(p);
      if (st) out.push({ path: p, kind: run ? 'wf' : 'sub', sessionId, projDir, root, run, size: st.size, mtimeMs: st.mtimeMs });
    }
  }
}

class Pool {
  constructor(size) {
    this.size = size;
    this.workers = [];
    this.queue = [];
    this.pending = new Map();
    this.seq = 0;
  }

  _spawn() {
    const w = new Worker(path.join(__dirname, 'worker.js'));
    w.busy = false;
    w.on('message', (msg) => {
      const job = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      w.busy = false;
      if (job) {
        if (msg.error) job.reject(new Error(msg.error));
        else job.resolve(msg.result);
      }
      this._pump();
    });
    w.on('error', (err) => {
      for (const [id, job] of this.pending) {
        if (job.worker === w) {
          this.pending.delete(id);
          job.reject(err);
        }
      }
      this.workers = this.workers.filter((x) => x !== w);
      this._pump();
    });
    this.workers.push(w);
    return w;
  }

  run(payload) {
    return new Promise((resolve, reject) => {
      this.queue.push({ payload, resolve, reject });
      this._pump();
    });
  }

  _pump() {
    while (this.queue.length) {
      let w = this.workers.find((x) => !x.busy);
      if (!w && this.workers.length < this.size) w = this._spawn();
      if (!w) return;
      const job = this.queue.shift();
      const id = ++this.seq;
      w.busy = true;
      job.worker = w;
      this.pending.set(id, job);
      w.postMessage({ id, ...job.payload });
    }
  }

  async close() {
    await Promise.all(this.workers.map((w) => w.terminate()));
    this.workers = [];
  }
}

class Scanner {
  constructor({ roots, cacheFile, poolSize }) {
    this.roots = roots;
    this.cacheFile = cacheFile;
    this.poolSize = poolSize || Math.max(1, Math.min(6, os.cpus().length - 1));
    this.cache = new Map(); // path -> result
    this.loaded = false;
    this.dirty = false;
  }

  loadCache() {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.cacheFile) return;
    try {
      const data = v8.deserialize(fs.readFileSync(this.cacheFile));
      if (data && data.v === PARSER_VERSION && Array.isArray(data.entries)) {
        for (const r of data.entries) this.cache.set(r.path, r);
      }
    } catch (e) {
      // нет кэша или битый — просто разберём заново
    }
  }

  saveCache() {
    if (!this.cacheFile || !this.dirty) return;
    try {
      fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true });
      const tmp = this.cacheFile + '.tmp';
      fs.writeFileSync(tmp, v8.serialize({ v: PARSER_VERSION, entries: [...this.cache.values()] }));
      fs.renameSync(tmp, this.cacheFile);
      this.dirty = false;
    } catch (e) {
      // кэш — оптимизация, без него всё работает
    }
  }

  clearCache() {
    this.cache.clear();
    this.dirty = true;
    try {
      if (this.cacheFile) fs.unlinkSync(this.cacheFile);
    } catch (e) { /* ignore */ }
  }

  // Возвращает { found, results: Map(path -> result), scripts, stats }.
  async scan(onProgress) {
    const t0 = Date.now();
    this.loadCache();
    const { files, scripts } = discover(this.roots);
    const alive = new Set(files.map((f) => f.path));
    for (const p of [...this.cache.keys()]) {
      if (!alive.has(p)) {
        this.cache.delete(p);
        this.dirty = true;
      }
    }
    const todo = files.filter((f) => {
      const c = this.cache.get(f.path);
      return !c || c.v !== PARSER_VERSION || c.size !== f.size || c.mtimeMs !== f.mtimeMs;
    });
    todo.sort((a, b) => b.size - a.size);
    const bytesTotal = todo.reduce((s, f) => s + f.size, 0);
    let bytesDone = 0;
    let done = 0;
    const errors = [];
    if (onProgress) onProgress({ phase: 'parse', done, total: todo.length, bytesDone, bytesTotal });
    if (todo.length) {
      const pool = new Pool(Math.min(this.poolSize, todo.length));
      try {
        await Promise.all(todo.map((f) => pool.run({ path: f.path, sidechain: f.kind !== 'main' })
          .then((res) => {
            this.cache.set(f.path, res);
            this.dirty = true;
          })
          .catch((err) => {
            errors.push({ path: f.path, error: String(err.message || err).split('\n')[0] });
          })
          .finally(() => {
            done++;
            bytesDone += f.size;
            if (onProgress && (done % 8 === 0 || done === todo.length)) {
              onProgress({ phase: 'parse', done, total: todo.length, bytesDone, bytesTotal });
            }
          })));
      } finally {
        await pool.close();
      }
    }
    this.saveCache();
    const results = new Map();
    for (const f of files) {
      const r = this.cache.get(f.path);
      if (r) results.set(f.path, r);
    }
    return {
      found: files,
      results,
      scripts,
      stats: {
        files: files.length,
        parsed: todo.length,
        cached: files.length - todo.length,
        bytes: files.reduce((s, f) => s + f.size, 0),
        ms: Date.now() - t0,
        errors,
      },
    };
  }
}

module.exports = { Scanner, discover };
