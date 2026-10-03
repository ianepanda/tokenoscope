// Проверка синхронизации аккаунтов на песочнице: копия настоящих сайдбаров, транскрипты только читаются.
// Прогоняет переключения, закрытие Claude, отмену, удалённые сессии и остановку записи при смене аккаунта.
//   node scripts/sync-check.js
// Нужны хотя бы два аккаунта в Claude Desktop.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const sbx = path.join(fs.realpathSync.native(os.tmpdir()), 'tokenoscope-sync-check');
const run = (...args) => execFileSync(process.execPath, [path.join(__dirname, 'sync-sandbox.js'), ...args, `--dir=${sbx}`], { encoding: 'utf8' });
run('build');
process.env.TOKENOSCOPE_SYNC_SANDBOX = sbx;
const { AccountSync } = require('../lib/accsync');

let failed = 0;
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failed++;
};
const storeDir = (acct) => {
  const root = path.join(sbx, 'stores', 'claude-code-sessions', acct);
  return path.join(root, fs.readdirSync(root)[0]);
};
const rowsOf = (acct) => fs.readdirSync(storeDir(acct)).filter((n) => n.startsWith('local_'));

(async () => {
  const accts = fs.readdirSync(path.join(sbx, 'stores', 'claude-code-sessions')).sort();
  if (accts.length < 2) throw new Error('Нужно хотя бы два аккаунта');
  const [A, B] = accts;
  const s = new AccountSync({ dataDir: path.join(sbx, 'data') });

  run('state', '--running', `--live=${B.slice(0, 8)}`);
  let p = await s.plan();
  check(p.desktop.live === B && !p.writable.includes(B) && p.writable.includes(A), `Claude открыт под ${B.slice(0, 8)}: писать можно только в ${A.slice(0, 8)}`);
  const bRows = rowsOf(B).length;
  let r = await s.apply({ trigger: 'test' });
  check(r.result === 'ok' || r.result === 'nothing', `синхронизация в свободный аккаунт: ${r.result}, записано ${r.written}`);
  check(rowsOf(B).length === bRows, 'сайдбар открытого аккаунта не тронут');
  p = await s.plan();
  check(p.ops.length === 0, `повторный план пуст (${p.ops.length})`);

  run('state', '--running', `--live=${A.slice(0, 8)}`);
  p = await s.plan();
  check(p.writable.includes(B) && !p.writable.includes(A), 'после переключения свободен другой аккаунт');
  r = await s.apply({ trigger: 'test' });
  p = await s.plan();
  check(p.ops.length === 0 && p.pending.length === 0, `после обратной синхронизации делать нечего (ops ${p.ops.length}, позже ${p.pending.length})`);
  check(p.totals.completeNow === p.totals.completeEventually, `полнота ${p.totals.completeNow} из ${p.totals.conversations}`);

  run('state', '--running', '--signed-out');
  p = await s.plan();
  check(p.writable.length === 0, 'вход не выполнен — писать некуда');

  run('state', '--closed');
  p = await s.plan();
  check(p.writable.length === 2 && p.ops.length === 0, 'Claude закрыт: можно писать везде, и уже нечего');

  // Удаление в аккаунте: без пометки запись вернётся, с пометкой deleted_ — нет.
  const dirA = storeDir(A);
  const [r1, r2] = rowsOf(A).slice(0, 2);
  const sid1 = JSON.parse(fs.readFileSync(path.join(dirA, r1), 'utf8')).cliSessionId;
  const sid2 = JSON.parse(fs.readFileSync(path.join(dirA, r2), 'utf8')).cliSessionId;
  const holds = (acct, sid) => rowsOf(acct).some((n) => JSON.parse(fs.readFileSync(path.join(storeDir(acct), n), 'utf8')).cliSessionId === sid);
  fs.unlinkSync(path.join(dirA, r1));
  fs.unlinkSync(path.join(dirA, r2));
  fs.writeFileSync(path.join(dirA, 'deleted_' + sid2), String(Date.now()));
  p = await s.plan();
  check(p.skipped.deleted.some((x) => x.session === sid2 && x.account === A), 'удалённая с пометкой не возвращается');
  r = await s.apply({ trigger: 'test' });
  check(holds(A, sid1) && !holds(A, sid2), `удалённая без пометки вернулась, с пометкой — нет (записано ${r.written})`);

  // Отмена последней синхронизации и повтор.
  const h = s.history().find((x) => x.undoable);
  const u = await s.undo(h.opId);
  check(u.deleted >= 1, `отмена удалила записи (${u.deleted}) и вернула значения (${u.restored})`);
  p = await s.plan();
  check(p.ops.length >= 1, 'после отмены план снова видит работу');
  await s.apply({ trigger: 'test' });

  // Смена аккаунта посреди записи останавливает её.
  run('state', '--running', `--live=${B.slice(0, 8)}`);
  for (const n of rowsOf(A).slice(0, 5)) fs.unlinkSync(path.join(storeDir(A), n));
  let fired = false;
  r = await s.apply({
    trigger: 'test',
    onProgress: (e) => {
      if (e.phase === 'write' && e.done === 1 && !fired) {
        fired = true;
        run('state', '--running', `--live=${A.slice(0, 8)}`);
      }
    },
  });
  check(r.result === 'aborted', `вход под другим аккаунтом во время записи останавливает её (${r.result}: ${r.aborted || ''})`);

  console.log(failed ? `\nНе прошло: ${failed}` : '\nВсё прошло');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
