'use strict';
// Записи сайдбара Code-сессий Claude Desktop: <корень>\claude-code-sessions\<account>\<org>\local_*.json.
// Оттуда берём название сессии, как его видно в Desktop, и признак архива. Где корень — решает lib/desktop.js:
// у MSIX-установки он внутри пакета, а %APPDATA%\Claude снаружи пакета не существует.
const fs = require('fs');
const path = require('path');
const D = require('./desktop');

function readSidebar(env) {
  const byCli = new Map();
  for (const { account: acc, path: dir } of D.accountDirs(env || D.defaultEnv())) {
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch (e) {
      continue;
    }
    for (const name of names) {
      if (!name.startsWith('local_') || !name.endsWith('.json')) continue;
      let j;
      try {
        j = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      } catch (e) {
        continue;
      }
      if (!j || !j.cliSessionId) continue;
      const rec = {
        title: j.title || null,
        titleSource: j.titleSource || null,
        createdAt: j.createdAt || 0,
        lastActivityAt: j.lastActivityAt || 0,
        archived: !!j.isArchived,
        cwd: j.cwd || null,
        model: j.model || null,
        effort: j.effort || null,
        accounts: [acc.slice(0, 8)],
      };
      const prev = byCli.get(j.cliSessionId);
      if (!prev) {
        byCli.set(j.cliSessionId, rec);
        continue;
      }
      if (!prev.accounts.includes(rec.accounts[0])) prev.accounts.push(rec.accounts[0]);
      // Название, заданное руками, важнее автоматического; дальше — самое свежее.
      const better = (rec.titleSource === 'user' && prev.titleSource !== 'user') ||
        (rec.titleSource === prev.titleSource && rec.lastActivityAt > prev.lastActivityAt);
      if (better && rec.title) {
        prev.title = rec.title;
        prev.titleSource = rec.titleSource;
      }
      prev.lastActivityAt = Math.max(prev.lastActivityAt, rec.lastActivityAt);
      prev.archived = prev.archived && rec.archived;
    }
  }
  return byCli;
}

module.exports = { readSidebar };
