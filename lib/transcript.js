'use strict';
// Чтение транскрипта, журнала воркфлоу и скрипта для просмотра в интерфейсе.
// Большие блоки усекаются; полный текст блока отдаётся отдельным запросом по номеру строки.
const fs = require('fs');

const TEXT_LIMIT = 20000;
const RESULT_LIMIT = 6000;
const INPUT_LIMIT = 4000;

function cut(s, limit) {
  s = typeof s === 'string' ? s : s == null ? '' : String(s);
  return s.length > limit ? { text: s.slice(0, limit), len: s.length, cut: true } : { text: s, len: s.length, cut: false };
}

function flatText(content) {
  if (typeof content === 'string') return { text: content, images: 0 };
  let text = '';
  let images = 0;
  if (Array.isArray(content)) {
    for (const b of content) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'text') text += (text ? '\n' : '') + (b.text || '');
      else if (b.type === 'image') images++;
      else if (b.type === 'tool_reference') text += (text ? '\n' : '') + `[схема инструмента ${b.tool_name || ''}]`;
      else if (b.content !== undefined) {
        const x = flatText(b.content);
        text += (text ? '\n' : '') + x.text;
        images += x.images;
      }
    }
  }
  return { text, images };
}

function inputText(name, input) {
  if (!input || typeof input !== 'object') return String(input == null ? '' : input);
  if ((name === 'Bash' || name === 'PowerShell') && typeof input.command === 'string') {
    return input.command + (input.description ? `\n# ${input.description}` : '');
  }
  if (name === 'Read') return `${input.file_path || ''}${input.offset != null || input.limit != null ? `  [offset ${input.offset ?? 0}, limit ${input.limit ?? '—'}]` : ''}`;
  if (name === 'Workflow' && typeof input.script === 'string') return input.script;
  try {
    return JSON.stringify(input, null, 2);
  } catch (e) {
    return String(input);
  }
}

function readLines(filePath) {
  const data = fs.readFileSync(filePath, 'utf8');
  return data.split('\n');
}

// Список записей для просмотра.
function readTranscript(filePath) {
  const lines = readLines(filePath);
  const entries = [];
  const toolNames = new Map();
  const byMsg = new Map(); // один ответ API пишется несколькими строками, иногда вперемешку с результатами
  for (let ln = 0; ln < lines.length; ln++) {
    const raw = lines[ln];
    if (!raw || raw.length < 2) continue;
    let e;
    try {
      e = JSON.parse(raw);
    } catch (err) {
      continue;
    }
    const ts = e.timestamp ? Date.parse(e.timestamp) : 0;
    if (e.type === 'assistant') {
      const m = e.message || {};
      const id = m.id || e.requestId || e.uuid;
      let entry = id ? byMsg.get(id) : null;
      if (!entry) {
        const u = m.usage || null;
        const cc = u && u.cache_creation;
        const cw = (u && u.cache_creation_input_tokens) || 0;
        const cw1h = cc ? cc.ephemeral_1h_input_tokens || 0 : 0;
        entry = {
          kind: 'assistant', ln, ts, msgId: id, model: m.model || null, effort: e.effort || null, blocks: [],
          // Пустой usage (служебные и скопированные записи) — не шаг: парсер его тоже не считает.
          usage: u && m.model !== '<synthetic>' && (u.input_tokens || 0) + cw + (u.cache_read_input_tokens || 0) + (u.output_tokens || 0) > 0 ? {
            inp: u.input_tokens || 0,
            cw5m: cw - cw1h,
            cw1h,
            cw,
            cr: u.cache_read_input_tokens || 0,
            out: u.output_tokens || 0,
            think: (u.output_tokens_details && u.output_tokens_details.thinking_tokens) || 0,
            fast: u.speed === 'fast',
          } : null,
          skill: e.attributionSkill || null,
          mcp: e.attributionMcpServer || null,
        };
        entries.push(entry);
        if (id) byMsg.set(id, entry);
      }
      const content = Array.isArray(m.content) ? m.content : [];
      content.forEach((b, bi) => {
        if (!b || typeof b !== 'object') return;
        if (b.type === 'text') entry.blocks.push({ k: 'text', ln, bi, ...cut(b.text || '', TEXT_LIMIT) });
        else if (b.type === 'thinking' || b.type === 'redacted_thinking') entry.blocks.push({ k: 'thinking', ln, bi, ...cut(b.thinking || '', TEXT_LIMIT) });
        else if (b.type === 'tool_use') {
          toolNames.set(b.id, b.name);
          entry.blocks.push({ k: 'tool_use', ln, bi, id: b.id, name: b.name, ...cut(inputText(b.name, b.input), INPUT_LIMIT) });
        }
      });
      continue;
    }
    if (e.type === 'user') {
      const m = e.message || {};
      const content = m.content;
      if (e.isCompactSummary) {
        entries.push({ kind: 'summary', ln, ts, ...cut(flatText(content).text, TEXT_LIMIT) });
        continue;
      }
      if (typeof content === 'string') {
        entries.push({ kind: e.isMeta ? 'meta' : 'user', ln, ts, blocks: [{ k: 'text', ln, bi: -1, ...cut(content, TEXT_LIMIT) }] });
        continue;
      }
      if (!Array.isArray(content)) continue;
      const blocks = [];
      const results = [];
      content.forEach((b, bi) => {
        if (!b || typeof b !== 'object') return;
        if (b.type === 'tool_result') {
          const x = flatText(b.content);
          results.push({ k: 'tool_result', ln, bi, id: b.tool_use_id, name: toolNames.get(b.tool_use_id) || null, error: !!b.is_error, images: x.images, ...cut(x.text, RESULT_LIMIT) });
        } else if (b.type === 'text') blocks.push({ k: 'text', ln, bi, ...cut(b.text || '', TEXT_LIMIT) });
        else if (b.type === 'image') blocks.push({ k: 'image', ln, bi, text: '', len: 0 });
      });
      if (results.length) entries.push({ kind: 'results', ln, ts, blocks: results });
      if (blocks.length) entries.push({ kind: e.isMeta ? 'meta' : 'user', ln, ts, blocks });
      continue;
    }
    if (e.type === 'attachment' && Array.isArray(e.rendered)) {
      const text = e.rendered.map((r) => (r && typeof r.content === 'string' ? r.content : '')).join('\n');
      const a = e.attachment || {};
      entries.push({ kind: 'attachment', ln, ts, atype: a.type || '?', name: a.filename || a.hookName || null, ...cut(text, RESULT_LIMIT) });
      continue;
    }
    if (e.type === 'system') {
      if (e.subtype === 'stop_hook_summary') continue;
      const md = e.compactMetadata || null;
      entries.push({ kind: 'system', ln, ts, subtype: e.subtype || null, preTokens: md ? md.preTokens : null, trigger: md ? md.trigger : null, ...cut(typeof e.content === 'string' ? e.content : '', 2000) });
    }
  }
  return { entries, lines: lines.length };
}

// Полный текст одного блока (по строке и номеру блока).
function readBlock(filePath, ln, bi) {
  const lines = readLines(filePath);
  const e = JSON.parse(lines[ln]);
  if (e.type === 'attachment') return (e.rendered || []).map((r) => (r && typeof r.content === 'string' ? r.content : '')).join('\n');
  if (e.isCompactSummary) return flatText((e.message || {}).content).text;
  const content = (e.message || {}).content;
  if (typeof content === 'string') return content;
  const b = Array.isArray(content) ? content[bi] : null;
  if (!b) return '';
  if (b.type === 'text') return b.text || '';
  if (b.type === 'thinking') return b.thinking || '';
  if (b.type === 'tool_use') return inputText(b.name, b.input);
  if (b.type === 'tool_result') return flatText(b.content).text;
  return '';
}

// Журнал прогона воркфлоу: started/result/failed по агентам.
function readJournal(filePath) {
  const events = [];
  for (const raw of readLines(filePath)) {
    if (!raw || raw.length < 2) continue;
    let e;
    try {
      e = JSON.parse(raw);
    } catch (err) {
      continue;
    }
    let result = null;
    if (e.result !== undefined) {
      try {
        result = cut(typeof e.result === 'string' ? e.result : JSON.stringify(e.result, null, 2), 60000);
      } catch (err) {
        result = cut(String(e.result), 60000);
      }
    }
    events.push({ type: e.type || '?', agentId: e.agentId || null, label: e.label || null, phase: e.phase || null, key: e.key || null, result, error: e.error ? cut(String(e.error), 4000) : null });
  }
  return events;
}

function readScript(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  return cut(text, 400000);
}

module.exports = { readTranscript, readBlock, readJournal, readScript };
