'use strict';
// Разбор одного JSONL-транскрипта Claude Code.
//
// Что считается:
//  - usage каждого запроса к API с дедупом по message.id (один ответ пишется несколькими строками);
//  - состав контекста на каждом шаге: стартовый контекст сегмента + куски, пришедшие до шага
//    (результаты инструментов, вставки, сообщения, собственный вывод модели). Размер куска
//    оценивается по символам, затем на каждом шаге калибруется по реальному размеру контекста
//    из usage — так доли складываются ровно в input + cache_write + cache_read этого шага;
//  - самые «дорогие» куски: токены куска × число шагов, которые он ехал в контексте.

const fs = require('fs');
const { toolCategory, attachmentCategory, oneLine } = require('./categories');

const PARSER_VERSION = 5;
const CHARS_PER_TOKEN = 3.2;
const IMAGE_TOKENS = 1600;
const HEAVY_MIN_EST = 300; // куски меньше не отслеживаем поштучно
const HEAVY_KEEP = 40; // сколько самых дорогих кусков хранить на файл
const HOUR = 3600000;

function contentSize(content) {
  let chars = 0;
  let images = 0;
  if (typeof content === 'string') return { chars: content.length, images };
  if (Array.isArray(content)) {
    for (const b of content) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'text') chars += (b.text || '').length;
      else if (b.type === 'image') images += 1;
      else if (b.type === 'tool_reference') chars += 40; // схема подгружается на сервере, размер неизвестен
      else if (b.type === 'document') chars += 2000;
      else if (b.content !== undefined) {
        const s = contentSize(b.content);
        chars += s.chars;
        images += s.images;
      }
    }
  }
  return { chars, images };
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let s = '';
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text') s += b.text || '';
    else if (b.content !== undefined) s += textOf(b.content);
  }
  return s;
}

// Построчное чтение без загрузки гигантских файлов в одну строку.
function forEachLine(filePath, cb) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const CHUNK = 16 * 1024 * 1024;
    let buf = Buffer.allocUnsafe(CHUNK);
    let carry = null;
    let pos = 0;
    for (;;) {
      const n = fs.readSync(fd, buf, 0, CHUNK, pos);
      if (n <= 0) break;
      pos += n;
      let data = buf.subarray(0, n);
      if (carry) {
        data = Buffer.concat([carry, data]);
        carry = null;
      }
      let start = 0;
      for (;;) {
        const nl = data.indexOf(10, start);
        if (nl < 0) break;
        if (nl > start) cb(data, start, nl);
        start = nl + 1;
      }
      if (start < data.length) carry = Buffer.from(data.subarray(start));
      if (n < CHUNK && !carry) break;
    }
    if (carry && carry.length) cb(carry, 0, carry.length);
  } finally {
    fs.closeSync(fd);
  }
}

const SKIP_PREFIXES = ['{"type":"file-history-snapshot"', '{"type":"queue-operation"', '{"type":"last-prompt"',
  '{"type":"file-history-delta"', '{"type":"atis-latch"', '{"type":"mode"', '{"type":"progress"'].map((s) => Buffer.from(s));

function skipLine(buf, start) {
  for (const p of SKIP_PREFIXES) {
    if (buf.length - start >= p.length && buf.compare(p, 0, p.length, start, start + p.length) === 0) return true;
  }
  return false;
}

function readMeta(filePath) {
  const metaPath = filePath.replace(/\.jsonl$/, '.meta.json');
  try {
    return JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  } catch (e) {
    return null;
  }
}

function parseFile(filePath, opts = {}) {
  const st = fs.statSync(filePath);
  const sidechain = !!opts.sidechain;
  const out = {
    v: PARSER_VERSION,
    path: filePath,
    size: st.size,
    mtimeMs: st.mtimeMs,
    meta: sidechain ? readMeta(filePath) : null,
    firstTs: 0,
    lastTs: 0,
    cwd: null,
    gitBranch: null,
    version: null,
    titles: { custom: null, ai: null, agentName: null },
    firstPrompt: null,
    turns: 0,
    prLinks: [],
    artifacts: [],
    compactions: [],
    workflowCalls: [],
    cats: [],
    msgs: { id: [], ts: [], model: [], inp: [], cw5m: [], cw1h: [], cr: [], out: [], think: [], effort: [], fast: [], skill: [], mcp: [], aLen: [] },
    aCat: [],
    aTok: [],
    tools: [],
    heavy: [],
    steps: 0,
    startCtx: 0,
    peakCtx: 0,
    badLines: 0,
  };

  const catIndex = new Map();
  const cat = (group, detail) => {
    const key = group + '\t' + detail;
    let i = catIndex.get(key);
    if (i === undefined) {
      i = out.cats.length;
      out.cats.push(key);
      catIndex.set(key, i);
    }
    return i;
  };
  const CAT_START = cat('start', 'Системный промпт, инструменты, CLAUDE.md');
  const CAT_OUTPUT = cat('output', 'Вывод модели (текст, вызовы, размышления)');
  const CAT_UNKNOWN = cat('unknown', 'Не удалось отнести');

  const toolStats = new Map(); // `${hour}|${cat}` -> [calls, chars]
  const toolStat = (ts, c, calls, chars) => {
    const key = Math.floor((ts || 0) / HOUR) + '|' + c;
    let s = toolStats.get(key);
    if (!s) toolStats.set(key, (s = [0, 0]));
    s[0] += calls;
    s[1] += chars;
  };

  const seenMsg = new Set();
  const uses = new Map(); // tool_use_id -> {cat, desc, name}
  const promptIds = new Set();
  const workflowByUse = new Map();

  // Состояние сегмента (между компактами).
  let live = new Map(); // cat -> est tokens
  let liveTotal = 0;
  let segPieces = [];
  let baseStart = null; // токены стартового контекста текущего сегмента
  let step = 0; // сквозной номер шага в файле
  const fcum = []; // накопленная сумма калибровочных коэффициентов по шагам
  const finished = [];
  let curOut = null; // кусок вывода текущего сообщения (для описания)
  let curMsgId = null;
  let firstUserSeen = false;

  const addPiece = (c, est, chars, desc, ts) => {
    if (!(est > 0)) return null;
    live.set(c, (live.get(c) || 0) + est);
    liveTotal += est;
    if (est >= HEAVY_MIN_EST) {
      const p = { cat: c, est, arrival: step, chars, desc: desc || '', ts: ts || 0 };
      segPieces.push(p);
      return p;
    }
    return null;
  };

  const endSegment = () => {
    const last = step - 1;
    for (const p of segPieces) {
      if (p.arrival > last) continue;
      const f = fcum[last] - (p.arrival > 0 ? fcum[p.arrival - 1] : 0);
      const tokSteps = p.est * f;
      if (tokSteps > 0) finished.push({ cat: p.cat, desc: p.desc, chars: p.chars, est: p.est, steps: last - p.arrival + 1, tokSteps, ts: p.ts });
    }
    segPieces = [];
    live = new Map();
    liveTotal = 0;
    baseStart = null;
  };

  const doStep = (e, m, u, ts) => {
    const cc = u.cache_creation || null;
    const inp = u.input_tokens || 0;
    const cw = u.cache_creation_input_tokens || 0;
    const cr = u.cache_read_input_tokens || 0;
    const outTok = u.output_tokens || 0;
    let cw5m = 0;
    let cw1h = 0;
    if (cc) {
      cw5m = cc.ephemeral_5m_input_tokens || 0;
      cw1h = cc.ephemeral_1h_input_tokens || 0;
      const rest = cw - cw5m - cw1h;
      if (rest > 0) cw5m += rest;
    } else {
      cw5m = cw;
    }
    const ctx = inp + cw + cr;

    // Состав контекста на этом шаге.
    const comp = [];
    let f = 0;
    if (baseStart === null) {
      const scale = liveTotal > ctx && liveTotal > 0 ? ctx / liveTotal : 1;
      for (const [c, est] of live) comp.push(c, est * scale);
      baseStart = Math.max(0, ctx - liveTotal * scale);
      if (baseStart > 0) comp.push(CAT_START, baseStart);
      f = liveTotal > 0 ? scale : 0;
      if (out.steps === 0) out.startCtx = ctx;
    } else {
      const rest = ctx - baseStart;
      if (rest < 0) {
        comp.push(CAT_START, ctx);
      } else if (liveTotal <= 0) {
        if (baseStart > 0) comp.push(CAT_START, baseStart);
        if (rest > 0) comp.push(CAT_UNKNOWN, rest);
      } else {
        f = rest / liveTotal;
        if (baseStart > 0) comp.push(CAT_START, baseStart);
        for (const [c, est] of live) comp.push(c, est * f);
      }
    }
    fcum[step] = (step > 0 ? fcum[step - 1] : 0) + f;

    const M = out.msgs;
    M.id.push(m.id || e.requestId || e.uuid || `${out.path}#${step}`);
    M.ts.push(ts);
    M.model.push(m.model || '?');
    M.inp.push(inp);
    M.cw5m.push(cw5m);
    M.cw1h.push(cw1h);
    M.cr.push(cr);
    M.out.push(outTok);
    M.think.push((u.output_tokens_details && u.output_tokens_details.thinking_tokens) || 0);
    M.effort.push(e.effort || null);
    M.fast.push(u.speed === 'fast' ? 1 : 0);
    M.skill.push(e.attributionSkill || null);
    M.mcp.push(e.attributionMcpServer || null);
    let n = 0;
    for (let i = 0; i < comp.length; i += 2) {
      if (comp[i + 1] >= 1) {
        out.aCat.push(comp[i]);
        out.aTok.push(Math.round(comp[i + 1]));
        n++;
      }
    }
    M.aLen.push(n);

    out.steps++;
    if (ctx > out.peakCtx) out.peakCtx = ctx;
    step++;
    // Вывод модели остаётся в контексте со следующего шага.
    curOut = addPiece(CAT_OUTPUT, outTok, 0, '', ts);
  };

  const describeOutput = (block) => {
    if (!curOut || curOut.desc) return;
    if (block.type === 'tool_use') {
      const [, , d] = toolCategory(block.name || '?', block.input);
      curOut.desc = oneLine(`${block.name}${d ? ': ' + d : ''}`, 200);
    } else if (block.type === 'text' && block.text) {
      curOut.desc = oneLine(block.text, 200);
    }
  };

  const userTextPiece = (e, text, ts) => {
    if (!text) return;
    const len = text.length;
    if (e.isMeta) {
      addPiece(cat('skills', 'Тексты скиллов и команд'), len / CHARS_PER_TOKEN, len, oneLine(text, 160), ts);
    } else if (sidechain && !firstUserSeen) {
      addPiece(cat('prompt', 'Промпт задачи от родителя'), len / CHARS_PER_TOKEN, len, oneLine(text, 160), ts);
      if (!out.firstPrompt) out.firstPrompt = oneLine(text, 300);
    } else {
      addPiece(cat('user', 'Сообщения пользователя'), len / CHARS_PER_TOKEN, len, oneLine(text, 160), ts);
      if (!out.firstPrompt && !/^\s*<(command|local-command|system-reminder)/.test(text)) out.firstPrompt = oneLine(text, 300);
    }
  };

  const handleUser = (e, ts) => {
    const msg = e.message || {};
    const content = msg.content;
    if (!e.isMeta && e.promptId && ((e.origin && e.origin.kind === 'human') || typeof content === 'string')) {
      if (!promptIds.has(e.promptId)) {
        promptIds.add(e.promptId);
        out.turns++;
      }
    }
    if (e.isCompactSummary) {
      const { chars } = contentSize(content);
      addPiece(cat('compact', 'Сводка автокомпакта'), chars / CHARS_PER_TOKEN, chars, 'Сводка после компакта', ts);
      return;
    }
    if (typeof content === 'string') {
      userTextPiece(e, content, ts);
      firstUserSeen = true;
      return;
    }
    if (!Array.isArray(content)) return;
    let sawText = false;
    for (const b of content) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'tool_result') {
        const use = uses.get(b.tool_use_id);
        const { chars, images } = contentSize(b.content);
        const est = chars / CHARS_PER_TOKEN + images * IMAGE_TOKENS;
        const c = use ? use.cat : cat('other', 'Инструмент без вызова');
        addPiece(c, est, chars, use ? use.desc : '', ts);
        toolStat(ts, c, 0, chars);
        if (use && use.workflow) {
          const mm = /wf_[a-z0-9-]{6,}/.exec(textOf(b.content));
          if (mm) use.workflow.run = mm[0];
        }
      } else if (b.type === 'text') {
        userTextPiece(e, b.text || '', ts);
        sawText = true;
      } else if (b.type === 'image') {
        addPiece(cat('user', 'Изображения от пользователя'), IMAGE_TOKENS, 0, 'image', ts);
      } else if (b.type === 'document') {
        addPiece(cat('user', 'Документы от пользователя'), 2000, 0, 'document', ts);
      }
    }
    if (sawText) firstUserSeen = true;
  };

  const handleAssistant = (e, ts) => {
    const m = e.message || {};
    const u = m.usage;
    const id = m.id || e.requestId || e.uuid;
    if (u && m.model && m.model !== '<synthetic>' && id && !seenMsg.has(id)) {
      seenMsg.add(id);
      curMsgId = id;
      if ((u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.output_tokens || 0) > 0) {
        doStep(e, m, u, ts);
      } else {
        curOut = null;
      }
    } else if (id !== curMsgId) {
      curOut = null;
    }
    const content = m.content;
    if (!Array.isArray(content)) return;
    for (const b of content) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'tool_use') {
        const name = b.name || '?';
        const [g, d, desc] = toolCategory(name, b.input);
        const c = cat(g, d);
        const use = { cat: c, desc, name };
        if (name === 'Workflow') {
          const input = b.input || {};
          const script = input.script || '';
          const nm = /name:\s*['"]([^'"]+)/.exec(script);
          const ds = /description:\s*['"]([^'"]+)/.exec(script);
          use.workflow = {
            ts,
            name: nm ? nm[1] : (input.name || (input.scriptPath ? String(input.scriptPath).split(/[\\/]/).pop() : null)),
            desc: ds ? ds[1] : null,
            resume: input.resumeFromRunId || null,
            run: null,
          };
          out.workflowCalls.push(use.workflow);
          workflowByUse.set(b.id, use.workflow);
        }
        uses.set(b.id, use);
        toolStat(ts, c, 1, 0);
      }
      describeOutput(b);
    }
  };

  forEachLine(filePath, (buf, s, e) => {
    if (skipLine(buf, s)) return;
    let ent;
    try {
      ent = JSON.parse(buf.toString('utf8', s, e));
    } catch (err) {
      out.badLines++;
      return;
    }
    if (!ent || typeof ent !== 'object') return;
    const ts = ent.timestamp ? Date.parse(ent.timestamp) : 0;
    if (ts) {
      if (!out.firstTs || ts < out.firstTs) out.firstTs = ts;
      if (ts > out.lastTs) out.lastTs = ts;
    }
    if (!out.cwd && ent.cwd) out.cwd = ent.cwd;
    if (!out.gitBranch && ent.gitBranch) out.gitBranch = ent.gitBranch;
    if (ent.version) out.version = ent.version;
    switch (ent.type) {
      case 'assistant':
        handleAssistant(ent, ts);
        break;
      case 'user':
        handleUser(ent, ts);
        break;
      case 'attachment': {
        if (Array.isArray(ent.rendered)) {
          let chars = 0;
          for (const r of ent.rendered) chars += r && typeof r.content === 'string' ? r.content.length : 0;
          const a = ent.attachment || {};
          const [g, d] = attachmentCategory(a.type);
          addPiece(cat(g, d), chars / CHARS_PER_TOKEN, chars, a.filename || a.type || '', ts);
        }
        break;
      }
      case 'system':
        if (ent.subtype === 'compact_boundary') {
          const md = ent.compactMetadata || {};
          out.compactions.push({ ts, preTokens: md.preTokens || 0, trigger: md.trigger || null });
          endSegment();
        }
        break;
      case 'custom-title':
        if (ent.customTitle) out.titles.custom = ent.customTitle;
        break;
      case 'ai-title':
        if (ent.aiTitle) out.titles.ai = ent.aiTitle;
        break;
      case 'agent-name':
        if (ent.agentName) out.titles.agentName = ent.agentName;
        break;
      case 'pr-link':
        if (ent.prUrl && !out.prLinks.some((p) => p.url === ent.prUrl)) {
          out.prLinks.push({ url: ent.prUrl, number: ent.prNumber || null, repo: ent.prRepository || null });
        }
        break;
      case 'frame-link':
        if (ent.frameUrl && !out.artifacts.some((a) => a.url === ent.frameUrl)) {
          out.artifacts.push({ url: ent.frameUrl, title: ent.title || null });
        }
        break;
      default:
        break;
    }
  });
  endSegment();

  finished.sort((a, b) => b.tokSteps - a.tokSteps);
  out.heavy = finished.slice(0, HEAVY_KEEP).map((p) => ({ ...p, est: Math.round(p.est), tokSteps: Math.round(p.tokSteps) }));
  for (const [key, [calls, chars]] of toolStats) {
    const [h, c] = key.split('|');
    out.tools.push([+h, +c, calls, chars]);
  }
  return out;
}

module.exports = { parseFile, PARSER_VERSION, contentSize, forEachLine };
