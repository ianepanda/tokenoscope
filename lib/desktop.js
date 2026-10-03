'use strict';
// Claude Desktop, как его видно снаружи: где лежат сайдбары Code-сессий по аккаунтам, запущено ли приложение
// и под каким аккаунтом (по его собственному main.log), как его запустить.
//
// Всё, что зависит от машины, собрано в env (см. defaultEnv): тесты и песочница подменяют пути и список
// процессов, ничего не трогая на диске пользователя.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function defaultEnv() {
  const home = os.homedir();
  const env = {
    platform: process.platform,
    home,
    localAppData: process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'),
    appData: process.env.APPDATA || path.join(home, 'AppData', 'Roaming'),
    projectsRoot: path.join(home, '.claude', 'projects'),
    storeCandidates: null,
    logDirs: null,
    processes: null, // массив вместо настоящего списка процессов (песочница)
    noLaunch: false,
    sandbox: null,
  };
  // Песочница: TOKENOSCOPE_SYNC_SANDBOX=<папка> с env.json, которую готовит scripts/sync-sandbox.js.
  const sbx = process.env.TOKENOSCOPE_SYNC_SANDBOX;
  if (sbx) {
    try {
      Object.assign(env, JSON.parse(fs.readFileSync(path.join(sbx, 'env.json'), 'utf8')), { sandbox: sbx, noLaunch: true });
    } catch (e) {
      throw new Error(`Песочница ${sbx}: не читается env.json (${e.message})`);
    }
  }
  return env;
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch (e) {
    return false;
  }
}

function readdir(p) {
  try {
    return fs.readdirSync(p);
  } catch (e) {
    return [];
  }
}

// Где Desktop держит claude-code-sessions. В Windows приложение — MSIX-пакет: его запись в %APPDATA% уходит
// в ...\Packages\Claude_*\LocalCache\Roaming, и снаружи пакета %APPDATA%\Claude не существует. Классический
// путь оставлен для установок без пакета. Изнутри пакета (например, из терминала Claude) оба пути ведут
// в одну папку — дубли отсекаются по номеру файла.
function storeCandidates(env) {
  if (env.storeCandidates) return env.storeCandidates;
  if (env.platform === 'win32') {
    const pk = path.join(env.localAppData, 'Packages');
    const out = readdir(pk).filter((n) => /^Claude_/i.test(n)).sort()
      .map((n) => path.join(pk, n, 'LocalCache', 'Roaming', 'Claude', 'claude-code-sessions'));
    out.push(path.join(env.appData, 'Claude', 'claude-code-sessions'));
    return out;
  }
  if (env.platform === 'darwin') return [path.join(env.home, 'Library', 'Application Support', 'Claude', 'claude-code-sessions')];
  return [path.join(env.home, '.config', 'Claude', 'claude-code-sessions')];
}

function storeRoots(env) {
  const seen = new Set();
  const out = [];
  for (const c of storeCandidates(env)) {
    let st;
    try {
      st = fs.statSync(c, { bigint: true });
    } catch (e) {
      continue;
    }
    if (!st.isDirectory()) continue;
    const key = `${st.dev}:${st.ino}`;
    if (st.ino && seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

// Папки <аккаунт>/<организация> во всех корнях.
function accountDirs(env) {
  const out = [];
  for (const root of storeRoots(env)) {
    for (const acct of readdir(root).sort()) {
      if (!UUID_RE.test(acct) || !isDir(path.join(root, acct))) continue;
      for (const org of readdir(path.join(root, acct)).sort()) {
        const p = path.join(root, acct, org);
        if (UUID_RE.test(org) && isDir(p)) out.push({ account: acct.toLowerCase(), org: org.toLowerCase(), path: p, root });
      }
    }
  }
  return out;
}

// --- main.log --------------------------------------------------------------

function logDirs(env) {
  if (env.logDirs) return env.logDirs;
  const out = [];
  if (env.platform === 'win32') {
    out.push(path.join(env.localAppData, 'Claude', 'Logs'));
    // старое место внутри пакета: туда приложение писало до 2026-08
    for (const r of storeCandidates(env)) out.push(path.join(path.dirname(r), 'logs'));
  } else if (env.platform === 'darwin') {
    out.push(path.join(env.home, 'Library', 'Logs', 'Claude'));
  } else {
    out.push(path.join(env.home, '.config', 'Claude', 'logs'));
  }
  return out;
}

// Файлы журнала от нового к старому: main.log и ротированные main1.log, main2.log… той папки,
// где main.log свежее всего.
function logFiles(env) {
  let best = null;
  for (const d of logDirs(env)) {
    try {
      const st = fs.statSync(path.join(d, 'main.log'));
      if (!best || st.mtimeMs > best.mtimeMs) best = { dir: d, mtimeMs: st.mtimeMs };
    } catch (e) { /* нет журнала */ }
  }
  if (!best) return [];
  return readdir(best.dir).filter((n) => /^main\d*\.log$/i.test(n))
    .map((n) => {
      const p = path.join(best.dir, n);
      try {
        return { path: p, mtimeMs: fs.statSync(p).mtimeMs };
      } catch (e) {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .map((f) => f.path);
}

const LINE_TIME_RE = /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)/;
const INIT_RE = /\[LocalSessionManager\] Initialization succeeded\W+accountId=([0-9a-f-]{36}), orgId=([0-9a-f-]{36})/i;
const LOADED_RE = /Loaded \d+ persisted sessions from (.+claude-code-sessions[\\/]([0-9a-f-]{36})[\\/]([0-9a-f-]{36}))/i;
const TRANSITION_RE = /Login-state transition \(loggedOut: (true|false)\W+(true|false), uuid: (\S+?)\W+→\W*(\S+?)\)/;
const QUIT_RE = /willQuit: handler is ready for quit/;

function lineTime(line) {
  const m = LINE_TIME_RE.exec(line);
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : null;
}

// Применяет к состоянию события входа и выхода из строки журнала. Возвращает вид события
// (init, login, logout, loaded, quit) или null, если строка не про аккаунт.
function applyLogLine(state, line) {
  let m;
  if ((m = INIT_RE.exec(line))) {
    Object.assign(state, { account: m[1].toLowerCase(), org: m[2].toLowerCase(), signedOut: false, at: lineTime(line), event: 'init' });
    return 'init';
  }
  if ((m = LOADED_RE.exec(line))) {
    if (state.account === m[2].toLowerCase()) state.storePath = m[1];
    return 'loaded';
  }
  if ((m = TRANSITION_RE.exec(line))) {
    const toOut = m[2] === 'true';
    const uuid = m[4].toLowerCase();
    if (toOut) Object.assign(state, { account: null, org: null, storePath: null, signedOut: true, at: lineTime(line), event: 'logout' });
    else if (UUID_RE.test(uuid)) Object.assign(state, { account: uuid, org: null, storePath: null, signedOut: false, at: lineTime(line), event: 'login' });
    return toOut ? 'logout' : 'login';
  }
  if (QUIT_RE.test(line)) {
    state.quitAt = lineTime(line);
    state.event = 'quit';
    return 'quit';
  }
  return null;
}

function parseLogText(text) {
  const state = { account: null, org: null, storePath: null, signedOut: false, at: null, quitAt: null, event: null, seen: false };
  let start = 0;
  while (start < text.length) {
    let nl = text.indexOf('\n', start);
    if (nl < 0) nl = text.length;
    const line = text.slice(start, nl);
    // дешёвый фильтр: почти все строки журнала не про аккаунт
    if (line.includes('LocalSessionManager') || line.includes('persisted sessions') || line.includes('Login-state') || line.includes('willQuit')) {
      if (applyLogLine(state, line)) state.seen = true;
    }
    start = nl + 1;
  }
  return state;
}

// Следит за main.log по смещению: при каждом update() дочитывает только новое. Ротация (файл сменился
// или стал короче) — полный перечит.
class LogTracker {
  constructor(env) {
    this.env = env;
    this.file = null;
    this.offset = 0;
    this.rest = '';
    this.state = null;
    this.events = 0; // все события журнала про аккаунт и выход из приложения
    this.accountEvents = 0; // только вход, выход и загрузка аккаунта: по их росту видно, что аккаунт сменился
  }

  reset() {
    const files = logFiles(this.env);
    this.file = files[0] || null;
    this.offset = 0;
    this.rest = '';
    let state = null;
    for (const f of files) {
      let text;
      try {
        text = fs.readFileSync(f, 'utf8');
      } catch (e) {
        continue;
      }
      if (f === this.file) this.offset = Buffer.byteLength(text, 'utf8');
      const s = parseLogText(text);
      if (!state) state = s;
      // В свежем файле нет ни одного события — берём последнее из более старого.
      if (state.seen) break;
      if (s.seen) {
        state = { ...s, quitAt: state.quitAt || s.quitAt };
        break;
      }
    }
    this.state = state || { account: null, org: null, storePath: null, signedOut: false, at: null, quitAt: null, event: null, seen: false };
    this.state.file = this.file;
    this.events++;
    this.accountEvents++;
    return this.state;
  }

  update() {
    if (!this.state) return this.reset();
    const files = logFiles(this.env);
    if (files[0] !== this.file) return this.reset();
    let size;
    try {
      size = fs.statSync(this.file).size;
    } catch (e) {
      return this.reset();
    }
    if (size < this.offset) return this.reset();
    if (size === this.offset) return this.state;
    let chunk = '';
    try {
      const fd = fs.openSync(this.file, 'r');
      try {
        const buf = Buffer.alloc(size - this.offset);
        const n = fs.readSync(fd, buf, 0, buf.length, this.offset);
        chunk = buf.toString('utf8', 0, n);
        this.offset += n;
      } finally {
        fs.closeSync(fd);
      }
    } catch (e) {
      return this.state;
    }
    const text = this.rest + chunk;
    const lastNl = text.lastIndexOf('\n');
    this.rest = lastNl < 0 ? text : text.slice(lastNl + 1);
    const complete = lastNl < 0 ? '' : text.slice(0, lastNl);
    for (const line of complete.split('\n')) {
      const kind = applyLogLine(this.state, line);
      if (!kind) continue;
      this.state.seen = true;
      this.events++;
      if (kind === 'init' || kind === 'login' || kind === 'logout') this.accountEvents++;
    }
    return this.state;
  }
}

// --- процессы --------------------------------------------------------------

function parseWinProcs(out) {
  const procs = [];
  for (const line of out.split(/\r?\n/)) {
    const parts = line.split('|');
    if (parts.length < 4) continue;
    const pid = parseInt(parts[0], 10);
    if (!pid) continue;
    const started = Date.parse(parts.slice(3).join('|').trim());
    procs.push({ pid, name: parts[1].trim(), path: parts[2].trim(), started: isFinite(started) ? started : null });
  }
  return procs;
}

// ps: etime — [[дд-]чч:]мм:сс от запуска процесса.
function etimeMs(s) {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(s.trim());
  if (!m) return null;
  return ((((+m[1] || 0) * 24 + (+m[2] || 0)) * 60 + +m[3]) * 60 + +m[4]) * 1000;
}

function listProcesses(env) {
  if (env.sandbox) {
    // в песочнице список процессов перечитывается из env.json: так можно «открыть» и «закрыть» Claude на ходу
    try {
      env.processes = JSON.parse(fs.readFileSync(path.join(env.sandbox, 'env.json'), 'utf8')).processes || [];
    } catch (e) { /* оставляем прежний */ }
  }
  if (env.processes) return Promise.resolve(env.processes.map((p) => ({ started: null, ...p })));
  return new Promise((resolve) => {
    if (env.platform === 'win32') {
      const script = "[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-CimInstance Win32_Process | ForEach-Object { '{0}|{1}|{2}|{3}' -f $_.ProcessId, $_.Name, $_.ExecutablePath, $(if ($_.CreationDate) { $_.CreationDate.ToString('o') } else { '' }) }";
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
        { windowsHide: true, timeout: 30000, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' },
        (err, stdout) => {
          const procs = err ? [] : parseWinProcs(stdout || '');
          resolve(procs.length ? procs : null); // null — «не удалось посмотреть», это не «ничего не запущено»
        });
      return;
    }
    execFile('ps', ['-A', '-o', 'pid=,etime=,args='], { timeout: 15000, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' }, (err, stdout) => {
      if (err) return resolve(null);
      const now = Date.now();
      const procs = [];
      for (const line of (stdout || '').split('\n')) {
        const m = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line);
        if (!m) continue;
        const el = etimeMs(m[2]);
        procs.push({ pid: +m[1], name: path.basename(m[3].split(' ')[0]), path: m[3], started: el == null ? null : now - el });
      }
      resolve(procs.length ? procs : null);
    });
  });
}

// Процессы самого приложения Claude Desktop. CLI Claude Code — тоже claude.exe, поэтому смотрим на путь:
// MSIX-установка в WindowsApps\Claude_*, классическая — в AnthropicClaude. Мост расширения Chrome
// (chrome-native-host.exe) и бэкенды Code-сессий лежат вне этих папок и сайдбары не трогают.
function desktopProcesses(env, procs) {
  if (!procs) return null;
  const own = new Set([process.pid, process.ppid]);
  return procs.filter((p) => {
    if (own.has(p.pid)) return false;
    const lp = (p.path || '').toLowerCase().replace(/\//g, '\\');
    if (env.platform === 'win32') {
      if (lp) return lp.includes('\\windowsapps\\claude_') || lp.includes('\\anthropicclaude\\');
      return (p.name || '').toLowerCase() === 'claude.exe'; // путь не прочитался — считаем приложением
    }
    if (env.platform === 'darwin') return (p.path || '').toLowerCase().includes('/claude.app/contents/');
    return false;
  });
}

// Состояние приложения: запущено ли (true/false/null — не удалось узнать), с какого момента, под каким аккаунтом.
// Аккаунт берётся из main.log, только если событие входа случилось уже в этом запуске: иначе приложение
// ещё поднимается, и чей сайдбар оно загрузит, неизвестно.
async function desktopState(env, tracker) {
  const procs = desktopProcesses(env, await listProcesses(env));
  const log = tracker ? tracker.update() : new LogTracker(env).reset();
  const running = procs == null ? null : procs.length > 0;
  const startedAt = procs && procs.length ? Math.min(...procs.map((p) => p.started || Infinity)) : null;
  let live = null;
  let liveProblem = null;
  if (running !== false) {
    if (!log || !log.seen) liveProblem = 'no-log';
    else if (log.signedOut) liveProblem = 'signed-out';
    else if (!log.account) liveProblem = 'no-account';
    else if (running && isFinite(startedAt) && log.at != null && log.at < startedAt - 5000) liveProblem = 'starting';
    else live = log.account;
  }
  return {
    running,
    startedAt: isFinite(startedAt) ? startedAt : null,
    procCount: procs ? procs.length : null,
    live,
    liveProblem,
    log: log ? { account: log.account, signedOut: log.signedOut, at: log.at, event: log.event, quitAt: log.quitAt, file: log.file, storePath: log.storePath } : null,
  };
}

// --- почта аккаунтов -------------------------------------------------------

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    return null;
  }
}

// uuid -> {email, source}: ~/.claude.json (аккаунт CLI), конфиги песочниц локального агента в папке
// приложения (там у каждого аккаунта свой oauthAccount), память ccs и своя память Токеноскопа.
function accountEmails(env, memoFile) {
  const out = {};
  const put = (uuid, email, source) => {
    if (typeof uuid === 'string' && typeof email === 'string' && email && !out[uuid.toLowerCase()]) out[uuid.toLowerCase()] = { email, source };
  };
  const cj = readJson(path.join(env.home, '.claude.json'));
  if (cj && cj.oauthAccount) put(cj.oauthAccount.accountUuid, cj.oauthAccount.emailAddress, 'claude.json');
  for (const r of storeCandidates(env)) {
    const base = path.join(path.dirname(r), 'local-agent-mode-sessions');
    for (const acct of readdir(base)) {
      if (!UUID_RE.test(acct) || out[acct.toLowerCase()]) continue;
      search: for (const org of readdir(path.join(base, acct))) {
        for (const s of readdir(path.join(base, acct, org))) {
          const j = readJson(path.join(base, acct, org, s, '.claude', '.claude.json'));
          const oa = j && j.oauthAccount;
          if (oa && String(oa.accountUuid || '').toLowerCase() === acct.toLowerCase() && oa.emailAddress) {
            put(acct, oa.emailAddress, 'agent-mode');
            break search;
          }
        }
      }
    }
  }
  for (const f of [memoFile, path.join(env.home, '.claude-code-journal', 'account-emails.json')]) {
    const memo = f && readJson(f);
    if (memo && typeof memo === 'object') for (const [uuid, rec] of Object.entries(memo)) if (rec && rec.email) put(uuid, rec.email, 'memo');
  }
  return out;
}

// --- запуск ----------------------------------------------------------------

function launchDesktop(env) {
  if (env.noLaunch) return { ok: false, why: 'песочница: Claude не запускается' };
  try {
    if (env.platform === 'win32') {
      const fam = storeRoots(env).map((r) => /\\Packages\\(Claude_[^\\]+)\\/i.exec(r)).find(Boolean);
      if (fam) {
        spawn('explorer.exe', [`shell:AppsFolder\\${fam[1]}!Claude`], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
        return { ok: true };
      }
      const exe = path.join(env.localAppData, 'AnthropicClaude', 'claude.exe');
      if (fs.existsSync(exe)) {
        spawn(exe, [], { detached: true, stdio: 'ignore' }).unref();
        return { ok: true };
      }
      return { ok: false, why: 'не нашёлся установленный Claude Desktop' };
    }
    if (env.platform === 'darwin') {
      spawn('open', ['-a', 'Claude'], { detached: true, stdio: 'ignore' }).unref();
      return { ok: true };
    }
  } catch (e) {
    return { ok: false, why: e.message };
  }
  return { ok: false, why: 'на этой системе Claude Desktop нет' };
}

module.exports = {
  defaultEnv, storeRoots, storeCandidates, accountDirs, logFiles, LogTracker, parseLogText,
  listProcesses, desktopProcesses, desktopState, accountEmails, launchDesktop, UUID_RE,
};
