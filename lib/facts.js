'use strict';
// Что нужно новой записи сайдбара, прямо из транскрипта: рабочая папка, модель, effort, время первой
// и последней записи, своё название (customTitle), число реплик. Логика — как у claude-code-sessions:
// запись строится из того, что прочитано, а не из догадок, поэтому без ответа модели или без cwd
// транскрипт для записи не годится.
const fs = require('fs');
const { forEachLine } = require('./parser');

// Строки, которые пишет само приложение, а не человек: в число реплик не идут.
const PLUMBING = ['[Request interrupted by user', 'No response requested.'];
// Транскрипт больше этого реплики не считает: completedTurns тогда не пишется вовсе, а не «0».
const MAX_TURNS_BYTES = 96 * 1024 * 1024;

class FactsError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function isoMs(ts) {
  if (typeof ts !== 'string' || ts.length < 19) return null;
  const t = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(ts) ? ts : ts + 'Z');
  return isFinite(t) ? t : null;
}

function proseOf(msg) {
  const c = msg.content;
  let body;
  if (typeof c === 'string') body = c;
  else if (Array.isArray(c)) body = c.filter((b) => b && typeof b === 'object' && b.type === 'text').map((b) => b.text || '').join(' ');
  else return '';
  return body.split(/\s+/).filter(Boolean).join(' ');
}

function transcriptFacts(file) {
  let before;
  try {
    before = fs.statSync(file);
  } catch (e) {
    throw new FactsError('gone', `транскрипт не читается: ${e.message}`);
  }
  const countTurns = before.size <= MAX_TURNS_BYTES;
  let cwd = null;
  let custom = null;
  let model = null;
  let effort = null;
  let first = null;
  let last = null;
  let turns = 0;
  forEachLine(file, (buf, s, e) => {
    let d;
    try {
      d = JSON.parse(buf.toString('utf8', s, e));
    } catch (err) {
      return;
    }
    if (!d || typeof d !== 'object' || Array.isArray(d)) return;
    // cwd — первый: откуда сессия началась (так её группирует и приложение); модель, effort и
    // название — последние: с чем сессия остановилась и как её назвали в последний раз.
    if (cwd == null && typeof d.cwd === 'string' && d.cwd) cwd = d.cwd;
    if (typeof d.customTitle === 'string' && d.customTitle.trim()) custom = d.customTitle.trim();
    if (typeof d.effort === 'string' && d.effort) effort = d.effort;
    const msg = d.message;
    if (msg && typeof msg === 'object' && !Array.isArray(msg)) {
      if (typeof msg.model === 'string' && msg.model && !msg.model.startsWith('<')) model = msg.model;
      if (countTurns && (d.type === 'user' || d.type === 'assistant')) {
        const body = proseOf(msg);
        if (body && !PLUMBING.some((p) => body.startsWith(p))) turns++;
      }
    }
    const ms = isoMs(d.timestamp);
    if (ms != null) {
      if (first == null) first = ms;
      last = ms;
    }
  });
  let after;
  try {
    after = fs.statSync(file);
  } catch (e) {
    throw new FactsError('gone', `транскрипт исчез во время чтения: ${e.message}`);
  }
  if (after.size !== before.size || Math.floor(after.mtimeMs / 1000) !== Math.floor(before.mtimeMs / 1000)) {
    throw new FactsError('busy', 'в транскрипт пишут прямо сейчас — перенесётся, когда сессия затихнет');
  }
  const missing = [];
  if (!cwd) missing.push('нет рабочей папки');
  if (first == null) missing.push('нет времени');
  if (!model) missing.push('нет ни одного ответа модели');
  if (missing.length) throw new FactsError('unusable', `запись не из чего собрать: ${missing.join(', ')}`);
  return { cwd, created: first, last, turns: countTurns ? turns : null, customTitle: custom, model, effort, size: after.size, mtimeMs: after.mtimeMs };
}

module.exports = { transcriptFacts, FactsError, isoMs };
