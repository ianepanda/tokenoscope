// Песочница для синхронизации аккаунтов: копия сайдбаров Claude Desktop, свой main.log и выдуманный список
// процессов. Транскрипты читаются настоящие (только чтение), а пишется всё в копию.
//
//   node scripts/sync-sandbox.js build [--dir=<папка>]          свежая копия сайдбаров
//   node scripts/sync-sandbox.js state --running --live=<id>     Claude «открыт» под аккаунтом (префикс id)
//   node scripts/sync-sandbox.js state --closed                  Claude «закрыт»
//   node scripts/sync-sandbox.js state --running --signed-out    Claude открыт, но из аккаунта вышли
//
// Потом: TOKENOSCOPE_SYNC_SANDBOX=<папка> npm start (или node scripts/dev-server.js).
const fs = require('fs');
const os = require('os');
const path = require('path');
const D = require('../lib/desktop');

const args = process.argv.slice(2);
const arg = (name) => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : null;
};
const has = (name) => args.includes(`--${name}`);
const tmp = (() => {
  try {
    return fs.realpathSync.native(os.tmpdir()); // длинный путь вместо C:\Users\ABCD~1\…
  } catch (e) {
    return os.tmpdir();
  }
})();
const dir = path.resolve(arg('dir') || path.join(tmp, 'tokenoscope-sync-sbx'));
const cmd = args[0];

function logLine(t, text) {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} [info] ${text}\n`;
}

function readEnv() {
  return JSON.parse(fs.readFileSync(path.join(dir, 'env.json'), 'utf8'));
}

function writeEnv(e) {
  fs.writeFileSync(path.join(dir, 'env.json'), JSON.stringify(e, null, 1));
}

function accounts() {
  const root = path.join(dir, 'stores', 'claude-code-sessions');
  const out = [];
  for (const a of fs.readdirSync(root)) for (const o of fs.readdirSync(path.join(root, a))) out.push({ account: a, org: o });
  return out;
}

if (cmd === 'build') {
  const real = D.defaultEnv();
  if (real.sandbox) throw new Error('Сними TOKENOSCOPE_SYNC_SANDBOX, песочницу строят из настоящих данных');
  const roots = D.storeRoots(real);
  if (!roots.length) throw new Error('Не нашлось сайдбаров Claude Desktop');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.cpSync(roots[0], path.join(dir, 'stores', 'claude-code-sessions'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'home'), { recursive: true });
  // ~/.claude.json только с oauthAccount — для подписи аккаунта почтой
  try {
    const cj = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8'));
    fs.writeFileSync(path.join(dir, 'home', '.claude.json'), JSON.stringify({ oauthAccount: cj.oauthAccount || null }));
  } catch (e) { /* без почты */ }
  writeEnv({
    home: path.join(dir, 'home'),
    projectsRoot: real.projectsRoot,
    storeCandidates: [path.join(dir, 'stores', 'claude-code-sessions')],
    logDirs: [path.join(dir, 'logs')],
    processes: [],
  });
  fs.writeFileSync(path.join(dir, 'logs', 'main.log'), logLine(Date.now() - 3600e3, 'sandbox log'));
  console.log(`Песочница: ${dir}\nАккаунты: ${accounts().map((a) => a.account.slice(0, 8)).join(', ')}`);
} else if (cmd === 'state') {
  const e = readEnv();
  const now = Date.now();
  const log = path.join(dir, 'logs', 'main.log');
  if (has('closed')) {
    if (e.processes.length) fs.appendFileSync(log, logLine(now, 'willQuit: handler is ready for quit, so quitting'));
    e.processes = [];
  } else if (has('running')) {
    if (!e.processes.length) {
      e.processes = [{ pid: 424242, name: 'claude.exe', path: 'C:\\Program Files\\WindowsApps\\Claude_0.0.0.0_x64__sandbox\\app\\Claude.exe', started: now - 2000 }];
    }
    const want = arg('live');
    if (has('signed-out')) {
      fs.appendFileSync(log, logLine(now, '[account] Login-state transition (loggedOut: false → true, uuid: x → <none>), clearing oauth cache'));
    } else if (want) {
      const acc = accounts().find((a) => a.account.startsWith(want));
      if (!acc) throw new Error('Нет аккаунта ' + want);
      fs.appendFileSync(log, logLine(now, `[account] Login-state transition (loggedOut: true → false, uuid: <none> → ${acc.account}), clearing oauth cache`));
      fs.appendFileSync(log, logLine(now, `[LocalSessionManager] Initialization succeeded — accountId=${acc.account}, orgId=${acc.org}, existingSessions=0`));
    }
  }
  writeEnv(e);
  console.log(`Claude ${e.processes.length ? 'открыт' : 'закрыт'}${arg('live') ? ' под ' + arg('live') : has('signed-out') ? ', вход не выполнен' : ''}`);
} else {
  console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(0, 10).join('\n'));
}
