'use strict';
// Синхронизация Code-сессий Claude Desktop между аккаунтами.
//
// У каждого аккаунта в Desktop свой сайдбар: папка <аккаунт>/<организация> с файлами local_*.json, по одному
// на сессию. Транскрипты общие (~/.claude/projects), поэтому «перенести сессию» — значит создать в другом
// аккаунте запись сайдбара, которая открывает тот же транскрипт. Транскрипты не меняются никогда.
//
// Логика выросла из claude-code-sessions (converge, retitle) и скрипта ccs-switch:
//  - запись собирается из шаблона и фактов транскрипта, а не копируется с чужой (не тянет чужие
//    разрешения, MCP и вкладки Chrome);
//  - пишется только туда, где приложение её не перетрёт: в аккаунты, под которыми Claude сейчас не открыт,
//    а в текущий — только когда Claude закрыт. Под каким аккаунтом Claude, видно по его main.log;
//  - удалённое в аккаунте (deleted_<id>) туда не возвращается; старая ветка после rewind не едет туда,
//    где уже есть её продолжение;
//  - одинаковые названия разных сессий различаются датой: «… (до ДД.ММ ЧЧ:ММ)» для старой ветки после
//    rewind, «… (ДД.ММ ЧЧ:ММ)» для просто тёзки; новее всех остаётся без даты;
//  - название, заданное руками в одном аккаунте, и время последней активности расходятся по остальным;
//  - каждое изменение записано в журнал до записи на диск, последнюю синхронизацию можно отменить.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Worker } = require('worker_threads');
const D = require('./desktop');
const { transcriptFacts } = require('./facts');

const STAMP_RE = / \((?:до )?\d\d\.\d\d \d\d:\d\d\)(?: #\d+)?$/;
const NONTERMINAL = new Set(['journaled', 'writing']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BUSY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

// Свежий файл может на миг держать другой процесс, обычно антивирус: замена падает с EPERM (у ccs так
// падал журнал 27.09). Повторяем с паузами от четверти секунды до 4 с, всего около полуминуты.
async function retryBusy(fn) {
  for (let attempt = 0; ; attempt++) {
    try {
      return { value: fn(), retries: attempt };
    } catch (e) {
      if (!BUSY_CODES.has(e.code) || attempt >= 10) throw e;
      await sleep(Math.min(250 * 2 ** attempt, 4000));
    }
  }
}

const titleKey = (t) => (typeof t === 'string' ? t.trim() : '');
const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
const arr = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
const short = (id) => String(id || '').slice(0, 8);

function maxOf(vals) {
  let m = null;
  for (const v of vals) if (v != null && (m == null || v > m)) m = v;
  return m;
}

function minOf(vals) {
  let m = null;
  for (const v of vals) if (v != null && (m == null || v < m)) m = v;
  return m;
}

function stamp(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function leaf(cwd) {
  const parts = String(cwd || '').replace(/[\\/]+$/, '').split(/[\\/]/);
  const l = parts[parts.length - 1] || '';
  return /^[A-Za-z]:$/.test(l) ? '' : l;
}

// --- чтение сайдбаров ------------------------------------------------------

async function readRows(dirs) {
  const rows = [];
  const unreadable = [];
  const tombstones = new Map();
  for (const d of dirs) {
    let names = [];
    try {
      names = fs.readdirSync(d.path);
    } catch (e) {
      unreadable.push({ account: d.account, path: d.path, error: e.message });
      continue;
    }
    const tomb = tombstones.get(d.account) || new Set();
    tombstones.set(d.account, tomb);
    for (const name of names.sort()) {
      if (name.startsWith('deleted_')) {
        tomb.add(name.slice('deleted_'.length).toLowerCase());
        continue;
      }
      if (!name.startsWith('local_') || !name.endsWith('.json')) continue;
      const p = path.join(d.path, name);
      let rec = null;
      let err = null;
      // Приложение может писать файл прямо сейчас: один повтор через четверть секунды.
      for (let attempt = 0; attempt < 2 && !rec; attempt++) {
        try {
          const raw = fs.readFileSync(p);
          const data = JSON.parse(raw.toString('utf8').replace(/^\uFEFF/, ''));
          if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('не JSON-объект');
          rec = { account: d.account, org: d.org, store: d.path, name, path: p, raw, data };
        } catch (e) {
          err = e;
          if (attempt === 0) await sleep(250);
        }
      }
      if (rec) rows.push(rec);
      else unreadable.push({ account: d.account, path: p, error: err ? err.message : '?' });
    }
  }
  return { rows, unreadable, tombstones };
}

// Куда писать каждому аккаунту: в ту папку организации, где у него уже есть записи. Пустой аккаунт или
// записи в двух организациях сразу — не угадываем.
function destinations(dirs, rows) {
  const counts = new Map();
  for (const r of rows) counts.set(r.store, (counts.get(r.store) || 0) + 1);
  const byAcct = new Map();
  for (const d of dirs) {
    if (!byAcct.has(d.account)) byAcct.set(d.account, []);
    byAcct.get(d.account).push({ ...d, rows: counts.get(d.path) || 0 });
  }
  const dests = new Map();
  const problems = [];
  for (const [acct, list] of byAcct) {
    const populated = list.filter((d) => d.rows > 0);
    if (populated.length === 1) dests.set(acct, populated[0]);
    else if (populated.length > 1) problems.push({ code: 'several-orgs', account: acct, text: `у аккаунта ${short(acct)} записи лежат в нескольких папках организаций — не понять, какая из них настоящая` });
    else problems.push({ code: 'empty', account: acct, text: `у аккаунта ${short(acct)} пока нет ни одной записи — неизвестно, в какую организацию писать`, quiet: true });
  }
  return { dests, problems };
}

function transcriptIndex(projectsRoot) {
  const map = new Map();
  let dirs = [];
  try {
    dirs = fs.readdirSync(projectsRoot, { withFileTypes: true });
  } catch (e) {
    return map;
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    let names = [];
    try {
      names = fs.readdirSync(path.join(projectsRoot, d.name));
    } catch (e) {
      continue;
    }
    for (const n of names) {
      if (!n.endsWith('.jsonl')) continue;
      const sid = n.slice(0, -6).toLowerCase();
      if (!map.has(sid)) map.set(sid, []);
      map.get(sid).push(path.join(projectsRoot, d.name, n));
    }
  }
  return map;
}

// --- факты транскриптов (с кэшем по размеру и времени изменения) -----------

class FactsCache {
  constructor() {
    this.map = new Map();
  }

  async get(files, onProgress) {
    const out = new Map();
    const todo = [];
    for (const f of files) {
      let st = null;
      try {
        st = fs.statSync(f);
      } catch (e) { /* исчез */ }
      const c = this.map.get(f);
      if (c && st && c.size === st.size && c.mtimeMs === st.mtimeMs) out.set(f, c.value);
      else todo.push(f);
    }
    if (todo.length) {
      const results = await runFactsWorker(todo, onProgress);
      for (const r of results) {
        const value = r.facts ? { facts: r.facts } : { error: r.error };
        out.set(r.file, value);
        if (r.facts) this.map.set(r.file, { size: r.facts.size, mtimeMs: r.facts.mtimeMs, value });
        else this.map.delete(r.file);
      }
    }
    return out;
  }
}

function runFactsWorker(files, onProgress) {
  return new Promise((resolve) => {
    let w;
    try {
      w = new Worker(path.join(__dirname, 'facts-worker.js'), { workerData: { files } });
    } catch (e) {
      return resolve(files.map(inlineFacts));
    }
    let done = false;
    w.on('message', (m) => {
      if (m.progress && onProgress) onProgress(m.progress, files.length);
      if (m.done) {
        done = true;
        resolve(m.done);
      }
    });
    w.on('error', () => {
      if (!done) {
        done = true;
        resolve(files.map(inlineFacts));
      }
    });
    w.on('exit', () => {
      if (!done) resolve(files.map(inlineFacts));
    });
  });
}

function inlineFacts(file) {
  try {
    return { file, facts: transcriptFacts(file) };
  } catch (e) {
    return { file, error: { code: e.code || 'error', message: String(e.message || e) } };
  }
}

// --- план ------------------------------------------------------------------

// Заглушка для сессии, у которой нет названия ни в одной записи. В записи без названия она не расходится:
// там приложение показывает своё.
const PLACEHOLDER_RE = /^\(без названия · [^)]*\)(?: #\d+)?$/;

// Название сессии по всем её записям: заданное руками важнее автоматического, дальше — запись с самой
// свежей активностью. Пустые названия и заглушки не участвуют.
function canonicalTitle(recs) {
  const titled = recs.filter((r) => titleKey(r.data.title) && !PLACEHOLDER_RE.test(titleKey(r.data.title)));
  if (!titled.length) return null;
  const users = titled.filter((r) => r.data.titleSource === 'user');
  const pool = users.length ? users : titled;
  let best = pool[0];
  for (const r of pool.slice(1)) {
    const a = num(r.data.lastActivityAt) || 0;
    const b = num(best.data.lastActivityAt) || 0;
    if (a > b || (a === b && (r.account > best.account || (r.account === best.account && r.name > best.name)))) best = r;
  }
  return { title: titleKey(best.data.title), source: best.data.titleSource === 'user' ? 'user' : 'auto' };
}

function placeholderTitle(facts) {
  const d = new Date(facts.last || facts.created || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  const l = leaf(facts.cwd);
  return `(без названия · ${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}${l ? ' · ' + l : ''})`;
}

function uniqueTitle(title, taken) {
  let t = title;
  for (let n = 2; taken.has(t); n++) t = `${title} #${n}`;
  taken.add(t);
  return t;
}

// Новая запись: шаблон + факты транскрипта. Поля — те, что есть почти у всех настоящих записей и имеют
// честное нулевое значение (перепись claude-code-sessions); permissionMode — самый строгий из встречающихся.
function synthesizeRow(sid, title, source, facts, extra) {
  const row = {
    sessionId: 'local_' + crypto.randomUUID(),
    cliSessionId: sid,
    cwd: facts.cwd,
    originCwd: facts.cwd,
    lastFocusedAt: extra.lastFocusedAt ?? extra.lastActivityAt,
    createdAt: extra.createdAt,
    lastActivityAt: extra.lastActivityAt,
    model: facts.model,
  };
  if (facts.effort) row.effort = facts.effort;
  Object.assign(row, {
    isArchived: !!extra.isArchived,
    title,
    titleSource: source,
    permissionMode: 'auto',
    chromePermissionMode: null,
  });
  if (facts.turns != null) row.completedTurns = facts.turns;
  Object.assign(row, { alwaysAllowedReasons: [], sessionPermissionUpdates: [], spawnSeed: {} });
  return row;
}

function ccsUnfinished(env) {
  const dir = path.join(env.home, '.claude-code-journal', 'ops');
  let n = 0;
  for (const name of readdirSafe(dir)) {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(dir, name, 'manifest.json'), 'utf8'));
      if (m && ['journaled', 'copying', 'copied', 'rewriting', 'committed', 'aborting', 'writing'].includes(m.status)) n++;
    } catch (e) { /* не операция */ }
  }
  return n;
}

function readdirSafe(p) {
  try {
    return fs.readdirSync(p);
  } catch (e) {
    return [];
  }
}

class AccountSync {
  // dataDir — папка Токеноскопа для журнала и памяти; labels() — подписи аккаунтов из настроек.
  constructor({ env, dataDir, labels } = {}) {
    this.env = env || D.defaultEnv();
    this.dataDir = dataDir;
    this.labels = labels || (() => ({}));
    this.tracker = new D.LogTracker(this.env);
    this.facts = new FactsCache();
    this.opsDir = path.join(dataDir, 'ops');
    this.memoFile = path.join(dataDir, 'account-emails.json');
  }

  canWrite() {
    return this.env.platform === 'win32';
  }

  // Запоминает почту аккаунта CLI: ~/.claude.json называет только текущий, а нужна она для любого.
  rememberEmail() {
    try {
      const cj = JSON.parse(fs.readFileSync(path.join(this.env.home, '.claude.json'), 'utf8'));
      const oa = cj && cj.oauthAccount;
      if (!oa || !oa.accountUuid || !oa.emailAddress) return;
      let memo = {};
      try {
        memo = JSON.parse(fs.readFileSync(this.memoFile, 'utf8')) || {};
      } catch (e) { /* первый раз */ }
      const id = String(oa.accountUuid).toLowerCase();
      if (memo[id] && memo[id].email === oa.emailAddress) return;
      memo[id] = { email: oa.emailAddress, seen: new Date().toISOString().slice(0, 10) };
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.writeFileSync(this.memoFile, JSON.stringify(memo, null, 1));
    } catch (e) { /* только улучшает подписи */ }
  }

  // Полный план от текущего состояния диска. Ничего не пишет.
  async plan({ onProgress } = {}) {
    const env = this.env;
    const problems = [];
    const desktop = await D.desktopState(env, this.tracker);
    // Счётчик событий входа на момент, когда решалось, кому можно писать: запись сверяется с ним.
    const events = this.tracker.accountEvents;
    this.rememberEmail();
    const emails = D.accountEmails(env, this.memoFile);
    const userLabels = this.labels() || {};
    const dirs = D.accountDirs(env);
    const { rows, unreadable, tombstones } = await readRows(dirs);
    const { dests, problems: destProblems } = destinations(dirs, rows);
    problems.push(...destProblems);
    if (!D.storeRoots(env).length) problems.push({ code: 'no-store', text: 'Не нашлось папки с сайдбарами Claude Desktop — он не установлен или ещё ни разу не открывал Code-сессии' });

    // Кому можно писать прямо сейчас.
    const writable = new Set();
    const why = new Map();
    for (const acct of dests.keys()) {
      let w = false;
      let reason;
      if (!this.canWrite()) reason = 'запись пока только в Windows';
      else if (desktop.running === false) w = true;
      else if (desktop.live) {
        if (acct === desktop.live) reason = 'Claude открыт под этим аккаунтом — запишу, когда переключишься или закроешь Claude';
        else w = true;
      } else if (desktop.liveProblem === 'signed-out') reason = 'в Claude никто не вошёл — неизвестно, чей сайдбар он загрузит следующим';
      else if (desktop.liveProblem === 'starting') reason = 'Claude ещё запускается';
      else if (desktop.running == null) reason = 'не удалось проверить, запущен ли Claude';
      else reason = 'не видно, под каким аккаунтом открыт Claude';
      const bad = unreadable.filter((u) => u.account === acct);
      if (w && bad.length) {
        w = false;
        reason = `не читается ${bad.length === 1 ? 'запись' : bad.length + ' записей'} сайдбара: ${path.basename(bad[0].path)} — сначала её нужно починить или убрать`;
      }
      if (w) writable.add(acct);
      else why.set(acct, reason);
    }
    for (const u of unreadable) {
      problems.push({ code: 'unreadable', account: u.account, path: u.path, text: `Не читается ${u.path}: ${u.error}`, quiet: !writable.has(u.account) && u.account === desktop.live });
    }
    if (desktop.running == null) problems.push({ code: 'proc', text: 'Не удалось получить список процессов — считаю, что Claude может быть открыт' });
    const ccs = ccsUnfinished(env);
    if (ccs) problems.push({ code: 'ccs', text: `В журнале claude-code-sessions не закончено операций: ${ccs}. Синхронизации это не мешает, но их стоит довести: ccs recover`, quiet: true });

    // Разговоры: cliSessionId -> записи во всех аккаунтах.
    const convs = new Map();
    for (const r of rows) {
      const sid = typeof r.data.cliSessionId === 'string' ? r.data.cliSessionId.toLowerCase() : '';
      if (!sid) continue;
      if (!convs.has(sid)) convs.set(sid, []);
      convs.get(sid).push(r);
    }
    const tids = transcriptIndex(env.projectsRoot);

    // Развилки после rewind: запись, переехавшая на новый транскрипт, помнит старые.
    const parents = new Map();
    for (const r of rows) {
      const sid = typeof r.data.cliSessionId === 'string' ? r.data.cliSessionId.toLowerCase() : '';
      if (!sid) continue;
      const known = parents.get(sid) || new Map();
      parents.set(sid, known);
      for (const p of arr(r.data.priorCliSessionIds)) if (typeof p === 'string' && !known.has(p.toLowerCase())) known.set(p.toLowerCase(), null);
      for (const e of arr(r.data.rewindEdges)) {
        if (e && typeof e.parent === 'string') known.set(e.parent.toLowerCase(), num(e.at) ?? known.get(e.parent.toLowerCase()) ?? null);
      }
    }
    const ancCache = new Map();
    const ancestors = (sid) => {
      if (ancCache.has(sid)) return ancCache.get(sid);
      const out = new Set();
      const stack = [sid];
      while (stack.length) {
        const s = stack.pop();
        for (const p of (parents.get(s) || new Map()).keys()) if (!out.has(p) && p !== sid) {
          out.add(p);
          stack.push(p);
        }
      }
      ancCache.set(sid, out);
      return out;
    };
    const forkTime = (old) => {
      for (const m of parents.values()) if (num(m.get(old)) != null) return m.get(old);
      return null;
    };

    const live = new Map(); // разговоры с транскриптом
    const dead = new Set();
    for (const [sid, recs] of convs) {
      if (tids.has(sid)) live.set(sid, recs);
      else dead.add(sid);
    }
    const activity = (sid) => maxOf((convs.get(sid) || []).map((r) => num(r.data.lastActivityAt)));
    const focus = (sid) => maxOf((convs.get(sid) || []).map((r) => num(r.data.lastFocusedAt)));

    // Окончательные названия: общее по записям, затем различение тёзок.
    const final = new Map();
    const taken = new Set();
    for (const [sid, recs] of convs) {
      const c = canonicalTitle(recs);
      if (c && live.has(sid)) final.set(sid, { ...c, why: null });
      for (const r of recs) if (titleKey(r.data.title)) taken.add(titleKey(r.data.title));
    }
    const groups = new Map();
    for (const [sid, f] of final) {
      if (!groups.has(f.title)) groups.set(f.title, []);
      groups.get(f.title).push(sid);
    }
    for (const [base, members] of groups) {
      if (members.length < 2) continue;
      members.sort((a, b) => (activity(b) || 0) - (activity(a) || 0) || (a < b ? -1 : 1));
      for (const m of members.slice(1)) {
        const isOld = members.some((s) => s !== m && ancestors(s).has(m));
        const at = isOld ? forkTime(m) ?? activity(m) : activity(m);
        const raw = at == null || STAMP_RE.test(base) ? base : `${base} (${isOld ? 'до ' : ''}${stamp(at)})`;
        final.set(m, { title: uniqueTitle(raw, taken), source: 'user', why: isOld ? 'fork' : 'dup', base });
      }
    }

    const ops = [];
    const pending = [];
    const holds = [];
    const skipped = { deleted: [], superseded: [] };
    const labelOf = (acct) => userLabels[acct] || (emails[acct] && emails[acct].email) || short(acct);

    // Обновления существующих записей: название и время активности.
    for (const [sid, recs] of live) {
      const f = final.get(sid);
      const act = activity(sid);
      const foc = focus(sid);
      for (const r of recs) {
        if (!dests.has(r.account)) continue;
        const ch = {};
        if (f && titleKey(r.data.title) !== f.title) ch.title = [r.data.title ?? null, f.title];
        if (f && (ch.title ? (r.data.titleSource ?? null) !== f.source : f.source === 'user' && r.data.titleSource !== 'user')) ch.titleSource = [r.data.titleSource ?? null, f.source];
        if (act != null && num(r.data.lastActivityAt) != null && r.data.lastActivityAt < act) ch.lastActivityAt = [r.data.lastActivityAt, act];
        if (foc != null && num(r.data.lastFocusedAt) != null && r.data.lastFocusedAt < foc) ch.lastFocusedAt = [r.data.lastFocusedAt, foc];
        if (!Object.keys(ch).length) continue;
        const reason = ch.title ? (f.why || 'title') : ch.titleSource ? 'pin' : 'activity';
        const item = {
          kind: 'update', account: r.account, store: r.store, name: r.name, dest: r.path, session: sid,
          title: f ? f.title : titleKey(r.data.title), oldTitle: titleKey(r.data.title), reason, changes: ch,
          cwd: r.data.cwd || null, activity: act,
        };
        if (writable.has(r.account)) {
          const post = { ...r.data };
          for (const [k, v] of Object.entries(ch)) post[k] = v[1];
          item.pre = r.raw;
          item.post = Buffer.from(JSON.stringify(post), 'utf8');
          ops.push(item);
        } else pending.push(item);
      }
    }

    // Новые записи: разговор есть в одном аккаунте, а в другом нет. Старые ветки разговоров, продолжение
    // которых в аккаунте уже есть, туда не едут.
    const superseded = new Map();
    for (const r of rows) {
      if (typeof r.data.cliSessionId !== 'string') continue;
      if (!superseded.has(r.account)) superseded.set(r.account, new Set());
      for (const a of ancestors(r.data.cliSessionId.toLowerCase())) superseded.get(r.account).add(a);
    }
    const adds = [];
    for (const [sid, recs] of live) {
      const holders = new Set(recs.map((r) => r.account));
      for (const acct of dests.keys()) {
        if (holders.has(acct)) continue;
        const base = { kind: 'add', account: acct, session: sid, from: [...holders], cwd: (recs[0] && recs[0].data.cwd) || null, activity: activity(sid), title: final.has(sid) ? final.get(sid).title : '' };
        if ((tombstones.get(acct) || new Set()).has(sid)) {
          skipped.deleted.push(base);
          continue;
        }
        if ((superseded.get(acct) || new Set()).has(sid)) {
          skipped.superseded.push(base);
          continue;
        }
        adds.push({ ...base, recs, later: !writable.has(acct) });
      }
    }
    // Факты нужны и для отложенных: чтобы честно сказать, что переедет потом, а что не переедет вовсе.
    const needed = [...new Set(adds.filter((a) => tids.get(a.session).length === 1).map((a) => tids.get(a.session)[0]))];
    const facts = needed.length ? await this.facts.get(needed, onProgress) : new Map();
    for (const a of adds) {
      const files = tids.get(a.session);
      const { recs, later } = a;
      delete a.recs;
      delete a.later;
      if (files.length > 1) {
        holds.push({ ...a, code: 'several', detail: `транскрипт с этим id лежит в ${files.length} папках проектов — неясно, какой открывать` });
        continue;
      }
      const fx = facts.get(files[0]);
      if (!fx || !fx.facts) {
        holds.push({ ...a, code: (fx && fx.error && fx.error.code) || 'error', detail: (fx && fx.error && fx.error.message) || 'транскрипт не прочитался' });
        continue;
      }
      const fct = fx.facts;
      if (later) {
        pending.push({ ...a, title: a.title || fct.customTitle || placeholderTitle(fct), cwd: fct.cwd });
        continue;
      }
      let title;
      let source;
      if (final.has(a.session)) ({ title, source } = final.get(a.session));
      else {
        // ни у одной записи нет названия: берём своё название из транскрипта или заглушку
        title = uniqueTitle(fct.customTitle || placeholderTitle(fct), taken);
        source = 'auto';
        final.set(a.session, { title, source, why: null });
      }
      // Времена — как у остальных записей разговора (иначе следующая синхронизация начнёт подтягивать их
      // к новой записи); транскрипт — только если записи их не знают.
      const recAct = maxOf(recs.map((r) => num(r.data.lastActivityAt)));
      const recCreated = minOf(recs.map((r) => num(r.data.createdAt)));
      const row = synthesizeRow(a.session, title, source, fct, {
        lastActivityAt: recAct ?? fct.last,
        lastFocusedAt: maxOf(recs.map((r) => num(r.data.lastFocusedAt))),
        createdAt: recCreated ?? fct.created,
        isArchived: recs.every((r) => r.data.isArchived === true),
      });
      const d = dests.get(a.account);
      const name = row.sessionId + '.json';
      ops.push({ ...a, title, cwd: fct.cwd, store: d.path, name, dest: path.join(d.path, name), post: Buffer.from(JSON.stringify(row), 'utf8') });
    }

    // Полнота: разговор «на месте», когда он есть во всех аккаунтах (кроме тех, где его удалили
    // или где уже есть его продолжение после rewind).
    const exempt = new Set([...skipped.deleted, ...skipped.superseded].map((x) => x.account + '|' + x.session));
    const addNow = new Set(ops.filter((o) => o.kind === 'add').map((o) => o.account + '|' + o.session));
    const addLater = new Set(pending.filter((o) => o.kind === 'add').map((o) => o.account + '|' + o.session));
    let completeNow = 0;
    let completeAfter = 0;
    let completeEventually = 0;
    for (const [sid, recs] of live) {
      const holders = new Set(recs.map((r) => r.account));
      let now = true;
      let after = true;
      let ev = true;
      for (const acct of dests.keys()) {
        const k = acct + '|' + sid;
        if (holders.has(acct) || exempt.has(k)) continue;
        now = false;
        if (!addNow.has(k)) after = false;
        if (!addNow.has(k) && !addLater.has(k)) ev = false;
      }
      completeNow += now;
      completeAfter += after;
      completeEventually += ev;
    }

    const accounts = [...new Set([...dests.keys(), ...dirs.map((d) => d.account)])].sort().map((acct) => {
      const d = dests.get(acct);
      return {
        account: acct,
        short: short(acct),
        label: labelOf(acct),
        email: emails[acct] ? emails[acct].email : null,
        userLabel: userLabels[acct] || null,
        dest: !!d,
        path: d ? d.path : null,
        rows: rows.filter((r) => r.account === acct).length,
        have: [...live.values()].filter((recs) => recs.some((r) => r.account === acct)).length,
        live: desktop.live === acct,
        lastLogged: desktop.log && desktop.log.account === acct,
        writable: writable.has(acct),
        why: why.get(acct) || (d ? null : 'нет папки с записями'),
        addsNow: ops.filter((o) => o.kind === 'add' && o.account === acct).length,
        updatesNow: ops.filter((o) => o.kind === 'update' && o.account === acct).length,
        addsLater: pending.filter((o) => o.kind === 'add' && o.account === acct).length,
        updatesLater: pending.filter((o) => o.kind === 'update' && o.account === acct).length,
        holds: holds.filter((o) => o.account === acct).length,
      };
    });

    return {
      at: Date.now(),
      events,
      canWrite: this.canWrite(),
      sandbox: env.sandbox || null,
      desktop,
      accounts,
      writable: [...writable],
      totals: { conversations: live.size, dead: dead.size, completeNow, completeAfter, completeEventually },
      ops,
      pending,
      holds,
      skipped,
      problems,
    };
  }

  // --- запись --------------------------------------------------------------

  lockPaths() {
    const ccsOps = path.join(this.env.home, '.claude-code-journal', 'ops');
    return { own: path.join(this.dataDir, 'lock'), ccs: fs.existsSync(ccsOps) ? path.join(ccsOps, 'lock') : null };
  }

  // Своя блокировка и блокировка claude-code-sessions (если он стоит): Токеноскоп и ccs не пишут одновременно.
  acquireLock() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    const { own, ccs } = this.lockPaths();
    const take = (p, tag, foreignHint) => {
      for (let i = 0; i < 2; i++) {
        try {
          fs.writeFileSync(p, `${process.pid} ${tag}`, { flag: 'wx' });
          return;
        } catch (e) {
          if (e.code !== 'EEXIST') throw e;
          let txt = '';
          try {
            txt = fs.readFileSync(p, 'utf8');
          } catch (e2) { /* исчезла */ }
          const pid = parseInt(txt, 10);
          let alive = false;
          if (pid && pid !== process.pid) {
            try {
              process.kill(pid, 0);
              alive = true;
            } catch (e3) {
              alive = e3.code === 'EPERM';
            }
          }
          if (alive) throw new Error(foreignHint(pid, txt));
          if (pid === process.pid || txt.includes('tokenoscope') || p === own) {
            try {
              fs.unlinkSync(p);
            } catch (e4) { /* уже нет */ }
            continue;
          }
          throw new Error(`Висит блокировка claude-code-sessions (${txt.trim() || 'неизвестно чья'}). Если ccs не работает: ccs recover`);
        }
      }
      throw new Error('Не удалось взять блокировку ' + p);
    };
    take(own, 'tokenoscope-sync', (pid) => `Синхронизация уже идёт (процесс ${pid})`);
    if (ccs) {
      try {
        take(ccs, 'tokenoscope-sync', (pid) => `Сейчас работает claude-code-sessions (процесс ${pid}) — подожди, пока он закончит`);
      } catch (e) {
        this.releaseLock();
        throw e;
      }
    }
  }

  releaseLock() {
    const { own, ccs } = this.lockPaths();
    for (const p of [ccs, own]) {
      if (!p) continue;
      try {
        if (fs.readFileSync(p, 'utf8').startsWith(`${process.pid} tokenoscope`)) fs.unlinkSync(p);
      } catch (e) { /* нет */ }
    }
  }

  async saveManifest(m) {
    const dir = path.join(this.opsDir, m.op_id);
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, 'manifest.json');
    await retryBusy(() => fs.writeFileSync(p + '.tmp', JSON.stringify(m, null, 1)));
    await retryBusy(() => fs.renameSync(p + '.tmp', p));
  }

  listManifests() {
    const out = [];
    for (const name of readdirSafe(this.opsDir)) {
      try {
        const m = JSON.parse(fs.readFileSync(path.join(this.opsDir, name, 'manifest.json'), 'utf8'));
        if (m && m.op_id) out.push(m);
      } catch (e) { /* не операция */ }
    }
    return out.sort((a, b) => (b.created || 0) - (a.created || 0));
  }

  // Прерванная запись (Токеноскоп закрыли или он упал посреди): что легло на диск — сверяется по байтам.
  async settleInterrupted() {
    for (const m of this.listManifests()) {
      if (!NONTERMINAL.has(m.status)) continue;
      for (const op of m.ops || []) {
        if (op.written) continue;
        try {
          if (fs.readFileSync(op.dest).equals(Buffer.from(op.post_b64, 'base64'))) op.written = true;
        } catch (e) { /* не легла */ }
      }
      m.status = 'interrupted';
      m.history.push({ status: 'interrupted', at: Date.now() });
      if (!m.result) m.result = { written: (m.ops || []).filter((o) => o.written).length, skipped: 0, aborted: 'запись прервалась — что успело лечь, сверено по байтам' };
      await this.saveManifest(m);
    }
  }

  // Старые записи журнала: хранится последних 30.
  rotate() {
    const list = this.listManifests();
    for (const m of list.slice(30)) {
      if (NONTERMINAL.has(m.status)) continue;
      try {
        fs.rmSync(path.join(this.opsDir, m.op_id), { recursive: true, force: true });
      } catch (e) { /* не страшно */ }
    }
  }

  // Запись через временный файл и замену, с повторами, если файл держит другой процесс.
  // Возвращает число повторов.
  async atomicWrite(dest, buf) {
    const tmp = dest + '.tks-tmp';
    try {
      const a = await retryBusy(() => {
        const fd = fs.openSync(tmp, 'w');
        try {
          fs.writeSync(fd, buf);
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
      });
      const b = await retryBusy(() => fs.renameSync(tmp, dest));
      return a.retries + b.retries;
    } catch (e) {
      try {
        fs.unlinkSync(tmp);
      } catch (e2) { /* нет */ }
      throw e;
    }
  }

  // Синхронизация: свежий план и запись всего, что можно записать сейчас.
  async apply({ trigger = 'manual', onProgress = () => {}, only } = {}) {
    if (!this.canWrite()) throw new Error('Запись в сайдбары Claude Desktop пока поддерживается только в Windows');
    this.acquireLock();
    try {
      await this.settleInterrupted();
      onProgress({ phase: 'check' });
      const p = await this.plan({ onProgress: (done, total) => onProgress({ phase: 'facts', done, total }) });
      let ops = p.ops;
      if (only) ops = ops.filter((o) => only.includes(o.account));
      if (!ops.length) {
        onProgress({ phase: 'done', done: 0, total: 0 });
        return { result: 'nothing', plan: p, written: 0 };
      }
      const labels = Object.fromEntries(p.accounts.map((a) => [a.account, a.label]));
      const m = {
        op_id: new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '') + '-' + crypto.randomBytes(3).toString('hex'),
        tool: 'tokenoscope', version: 1, trigger, created: Date.now(), status: 'journaled', history: [{ status: 'journaled', at: Date.now() }],
        live: p.desktop.live, running: p.desktop.running, accounts: labels,
        ops: ops.map((o) => ({
          kind: o.kind, account: o.account, store: o.store, name: o.name, dest: o.dest, session: o.session, title: o.title,
          oldTitle: o.oldTitle || null, reason: o.reason || null, changes: o.changes || null, cwd: o.cwd || null,
          pre_b64: o.pre ? o.pre.toString('base64') : null, post_b64: o.post.toString('base64'), written: false,
        })),
      };
      await this.saveManifest(m);
      m.status = 'writing';
      m.history.push({ status: 'writing', at: Date.now() });
      await this.saveManifest(m);
      const evBefore = p.events;
      let written = 0;
      let retried = 0;
      let aborted = null;
      onProgress({ phase: 'write', done: 0, total: m.ops.length });
      for (let i = 0; i < m.ops.length; i++) {
        const op = m.ops[i];
        // Пока пишем, в Claude могли сменить аккаунт или запустить его: тогда «свободный» аккаунт мог стать
        // текущим, и приложение загрузит его сайдбар недописанным.
        this.tracker.update();
        if (this.tracker.accountEvents !== evBefore) {
          aborted = p.desktop.running === false
            ? 'Claude запустился во время записи — остановлено, чтобы он не загрузил сайдбар наполовину'
            : 'В Claude сменился аккаунт — запись остановлена, чтобы не писать под открытое приложение';
          break;
        }
        const post = Buffer.from(op.post_b64, 'base64');
        let cur = null;
        try {
          cur = fs.readFileSync(op.dest);
        } catch (e) { /* нет файла */ }
        if (cur && cur.equals(post)) {
          op.written = true;
        } else if (op.kind === 'add' && cur) {
          op.skipped = 'на этом месте уже лежит другой файл';
        } else if (op.kind === 'update' && (!cur || !cur.equals(Buffer.from(op.pre_b64, 'base64')))) {
          op.skipped = cur ? 'запись изменилась после планирования' : 'запись исчезла после планирования';
        } else {
          try {
            retried += (await this.atomicWrite(op.dest, post)) ? 1 : 0;
            op.written = true;
          } catch (e) {
            op.skipped = 'не записалось: ' + e.message;
          }
        }
        if (op.written) written++;
        onProgress({ phase: 'write', done: i + 1, total: m.ops.length, op: { kind: op.kind, account: op.account, title: op.title, oldTitle: op.oldTitle, reason: op.reason, written: !!op.written, skipped: op.skipped || null } });
        if (i % 10 === 9) await this.saveManifest(m);
      }
      m.status = aborted ? 'interrupted' : 'completed';
      m.history.push({ status: m.status, at: Date.now() });
      m.result = { written, skipped: m.ops.filter((o) => o.skipped).length, aborted, retried };
      await this.saveManifest(m);
      this.rotate();
      onProgress({ phase: 'verify' });
      const after = await this.plan();
      const left = after.ops.filter((o) => m.ops.some((x) => x.account === o.account && x.session === o.session && x.kind === o.kind));
      m.result.left = left.length;
      await this.saveManifest(m);
      onProgress({ phase: 'done', done: written, total: m.ops.length });
      return { result: aborted ? 'aborted' : left.length ? 'partial' : 'ok', opId: m.op_id, written, skipped: m.result.skipped, aborted, left: left.length, plan: after, summary: summarize(m) };
    } finally {
      this.releaseLock();
    }
  }

  history() {
    const list = this.listManifests();
    const undoable = list.find((m) => ['completed', 'interrupted'].includes(m.status) && (m.ops || []).some((o) => o.written));
    return list.slice(0, 30).map((m) => ({ ...summarize(m), undoable: !!undoable && m.op_id === undoable.op_id }));
  }

  // Отмена последней синхронизации: новые записи удаляются (если их с тех пор не переименовали и не
  // перенаправили и если это не последняя запись разговора), у обновлённых возвращаются прежние значения тех
  // полей, которые с тех пор никто не трогал.
  async undo(opId) {
    if (!this.canWrite()) throw new Error('Запись пока поддерживается только в Windows');
    this.acquireLock();
    try {
      await this.settleInterrupted();
      const list = this.listManifests();
      const latest = list.find((m) => ['completed', 'interrupted'].includes(m.status) && (m.ops || []).some((o) => o.written));
      if (!latest || latest.op_id !== opId) throw new Error('Отменить можно только последнюю синхронизацию');
      const p = await this.plan();
      const touched = [...new Set(latest.ops.filter((o) => o.written).map((o) => o.account))];
      const blocked = touched.filter((a) => !p.writable.includes(a));
      if (blocked.length) {
        const lab = (a) => (p.accounts.find((x) => x.account === a) || {}).label || short(a);
        throw new Error(`Сейчас нельзя писать в ${blocked.map(lab).join(', ')}: Claude открыт под этим аккаунтом. Переключись или закрой Claude и повтори`);
      }
      // Кто ещё открывает каждый разговор: последнюю запись разговора не удаляем.
      const pointers = new Map();
      for (const d of D.accountDirs(this.env)) {
        for (const name of readdirSafe(d.path)) {
          if (!name.startsWith('local_') || !name.endsWith('.json')) continue;
          try {
            const j = JSON.parse(fs.readFileSync(path.join(d.path, name), 'utf8'));
            const sid = String(j.cliSessionId || '').toLowerCase();
            if (!pointers.has(sid)) pointers.set(sid, new Set());
            pointers.get(sid).add(path.join(d.path, name).toLowerCase());
          } catch (e) { /* пропускаем */ }
        }
      }
      const report = { deleted: 0, restored: 0, gone: 0, skipped: [] };
      for (const op of [...latest.ops].reverse()) {
        if (!op.written) continue;
        let cur;
        try {
          cur = JSON.parse(fs.readFileSync(op.dest, 'utf8'));
        } catch (e) {
          if (e.code === 'ENOENT') report.gone++;
          else report.skipped.push({ title: op.title, why: 'не читается: ' + e.message });
          continue;
        }
        if (op.kind === 'add') {
          if (String(cur.cliSessionId || '').toLowerCase() !== op.session) {
            report.skipped.push({ title: op.title, why: 'запись с тех пор перенаправили на другой разговор' });
            continue;
          }
          if (cur.title !== op.title) {
            report.skipped.push({ title: op.title, why: 'запись с тех пор переименовали' });
            continue;
          }
          const others = new Set(pointers.get(op.session) || []);
          others.delete(op.dest.toLowerCase());
          if (!others.size) {
            report.skipped.push({ title: op.title, why: 'это уже единственная запись разговора — без неё он пропадёт из всех сайдбаров' });
            continue;
          }
          try {
            fs.unlinkSync(op.dest);
            (pointers.get(op.session) || new Set()).delete(op.dest.toLowerCase());
            report.deleted++;
          } catch (e) {
            report.skipped.push({ title: op.title, why: 'не удалилась: ' + e.message });
          }
        } else {
          const pre = JSON.parse(Buffer.from(op.pre_b64, 'base64').toString('utf8'));
          const post = JSON.parse(Buffer.from(op.post_b64, 'base64').toString('utf8'));
          let changed = false;
          for (const k of Object.keys(op.changes || {})) {
            if (JSON.stringify(cur[k]) !== JSON.stringify(post[k])) continue;
            if (k in pre) cur[k] = pre[k];
            else delete cur[k];
            changed = true;
          }
          if (!changed) {
            report.skipped.push({ title: op.title, why: 'эти поля с тех пор уже поменялись' });
            continue;
          }
          try {
            await this.atomicWrite(op.dest, Buffer.from(JSON.stringify(cur), 'utf8'));
            report.restored++;
          } catch (e) {
            report.skipped.push({ title: op.title, why: 'не записалось: ' + e.message });
          }
        }
      }
      latest.status = 'undone';
      latest.history.push({ status: 'undone', at: Date.now() });
      latest.undo = report;
      await this.saveManifest(latest);
      return report;
    } finally {
      this.releaseLock();
    }
  }
}

function summarize(m) {
  const per = {};
  for (const o of m.ops || []) {
    if (!o.written) continue;
    const a = (per[o.account] = per[o.account] || { account: o.account, label: (m.accounts || {})[o.account] || short(o.account), adds: 0, renames: 0, activity: 0 });
    if (o.kind === 'add') a.adds++;
    else if (o.changes && o.changes.title) a.renames++;
    else a.activity++;
  }
  return {
    opId: m.op_id, created: m.created, trigger: m.trigger, status: m.status, result: m.result || null, undo: m.undo || null,
    accounts: Object.values(per), total: (m.ops || []).length,
  };
}

// План без байтов и без служебного — для интерфейса.
function publicPlan(p) {
  const strip = (o) => {
    const { pre, post, recs, ...rest } = o;
    return rest;
  };
  return { ...p, ops: p.ops.map(strip), pending: p.pending.map(strip), holds: p.holds.map(strip) };
}

module.exports = { AccountSync, publicPlan, canonicalTitle, synthesizeRow, STAMP_RE };
