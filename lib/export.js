'use strict';
// Экспорт транскрипта в Markdown и HTML в том виде, в каком его показывает Claude Desktop в обычном
// режиме (Transcript view → Normal): сообщения пользователя, ответы Claude, а подряд идущие вызовы
// инструментов — одной свёрнутой строкой-сводкой. Размышления, сами команды, результаты инструментов
// и системные вставки в файл не попадают — в нём ровно то, что видно на экране.
// Сводка повторяет логику Desktop: один вызов — его описание (у shell и агентов) или действие,
// несколько — счётчики по категориям, самые частые первыми, не больше трёх частей.
const fs = require('fs');
const path = require('path');
const { Marked } = require('./vendor/marked');

const VIEW_NOTE = 'Вид как в Claude в обычном режиме: вызовы инструментов свёрнуты в строки-сводки; размышления, команды, результаты и системные вставки не сохранены.';

// ---------- Подписи ----------

function plural(n, one, few, many) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

// «Прочитан файл», «Прочитано 3 файла», «Прочитан 21 файл».
function counted(n, verbs, nouns) {
  if (n === 1) return `${verbs[0]} ${nouns[0]}`;
  const single = n % 10 === 1 && n % 100 !== 11;
  return `${single ? verbs[0] : verbs[1]} ${n} ${plural(n, ...nouns)}`;
}

const FILES = ['файл', 'файла', 'файлов'];
const COMMANDS = ['команда', 'команды', 'команд'];

// Категории, как их различает Desktop: имя инструмента в snake_case → категория.
const CATEGORY = {
  read: 'read', write: 'write', edit: 'edit', multi_edit: 'edit', notebook_edit: 'notebook_edit',
  glob: 'glob', grep: 'grep', web_fetch: 'web_fetch', web_search: 'web',
  bash: 'bash', power_shell: 'bash', task: 'task', agent: 'task', skill: 'skill',
  todo_write: 'plan', task_create: 'todo', task_update: 'todo', task_stop: 'todo', task_list: 'todo', task_get: 'todo',
  kill_bash: 'kill_bash', kill_shell: 'kill_bash', exit_plan_mode: 'exit_plan_mode', tool_search: 'tool_search',
  send_user_file: 'share',
};
// В этих категориях считаются разные файлы, а не вызовы: трижды прочитанный файл — «прочитан файл».
const FILE_CATS = new Set(['read', 'write', 'edit', 'notebook_edit']);

const LABEL = {
  read: (n) => counted(n, ['Прочитан', 'Прочитано'], FILES),
  write: (n) => counted(n, ['Создан', 'Создано'], FILES),
  edit: (n) => counted(n, ['Изменён', 'Изменено'], FILES),
  notebook_edit: (n) => counted(n, ['Изменён', 'Изменено'], ['блокнот', 'блокнота', 'блокнотов']),
  glob: () => 'Поиск файлов',
  grep: () => 'Поиск по файлам',
  web: () => 'Поиск в интернете',
  web_fetch: (n) => counted(n, ['Прочитана', 'Прочитано'], ['страница', 'страницы', 'страниц']),
  bash: (n) => counted(n, ['Выполнена', 'Выполнено'], COMMANDS),
  task: (n) => counted(n, ['Запущен', 'Запущено'], ['агент', 'агента', 'агентов']),
  skill: (n) => counted(n, ['Загружен', 'Загружено'], ['скилл', 'скилла', 'скиллов']),
  plan: () => 'Обновлён план',
  todo: () => 'Обновлены задачи',
  kill_bash: (n) => counted(n, ['Остановлена', 'Остановлено'], COMMANDS),
  exit_plan_mode: () => 'Предложен план',
  tool_search: () => 'Загружены инструменты',
  share: (n) => counted(n, ['Отправлен', 'Отправлено'], FILES),
  preview: () => 'Использован браузер',
  browser: (n) => (n === 1 ? 'Использован Claude in Chrome' : `Использован Claude in Chrome: ${n} ${plural(n, 'действие', 'действия', 'действий')}`),
};

// Одиночные вызовы инструментов без категории.
const SINGLE = {
  AskUserQuestion: 'Задан вопрос',
  EnterPlanMode: 'Начато планирование',
  Workflow: 'Запущен воркфлоу',
  SendMessage: 'Отправлено сообщение агенту',
  TaskOutput: 'Проверен вывод задачи',
  BashOutput: 'Проверен вывод команды',
  PushNotification: 'Отправлено уведомление',
  ScheduleWakeup: 'Запланировано продолжение',
};

function category(name) {
  if (name.startsWith('mcp__')) {
    if (name.includes('__claude-in-chrome__') || name.includes('__Claude_in_Chrome__')) return 'browser';
    if (name.startsWith('mcp__Claude_Browser__') || name.startsWith('mcp__Claude_Preview__')) return 'preview';
    return null;
  }
  return CATEGORY[name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()] || null;
}

function mcpServer(name) {
  const server = name.split('__')[1] || name;
  return server.startsWith('ccd_') ? 'Claude Desktop' : server;
}

const firstLine = (s) => String(s).trim().split('\n')[0].trim();
const upperFirst = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const lowerFirst = (s) => s.charAt(0).toLowerCase() + s.slice(1);

function filePath(input) {
  for (const k of ['file_path', 'notebook_path', 'path']) {
    if (typeof input[k] === 'string' && input[k].trim()) return input[k].trim().replace(/\\/g, '/').toLowerCase();
  }
  return null;
}

function singleLabel({ name, input }) {
  const cat = category(name);
  const mcp = name.startsWith('mcp__');
  // Описание — подпись, которую Claude пишет для человека (Bash, PowerShell, агенты, Monitor).
  const desc = !mcp && typeof input.description === 'string' ? firstLine(input.description) : '';
  if (name === 'TaskCreate' && typeof input.subject === 'string' && input.subject.trim()) return upperFirst(firstLine(input.subject));
  if (desc && !FILE_CATS.has(cat)) return upperFirst(desc);
  if (cat === 'skill' && typeof input.skill === 'string' && input.skill) return `Загружен скилл ${input.skill}`;
  if (cat) return LABEL[cat](1);
  if (SINGLE[name]) return SINGLE[name];
  if (mcp) return `Использована интеграция ${mcpServer(name)}`;
  return `Использован инструмент ${name}`;
}

function groupLabel(tools) {
  if (tools.length === 1) return singleLabel(tools[0]);
  const cats = new Map();
  const servers = new Map();
  let unknown = 0;
  const unknownNames = new Set();
  const first = new Map();
  const mark = (k) => first.has(k) || first.set(k, first.size);
  for (const t of tools) {
    const cat = category(t.name);
    if (cat) {
      let c = cats.get(cat);
      if (!c) cats.set(cat, (c = { calls: 0, paths: new Set(), pathless: 0 }));
      c.calls++;
      const p = FILE_CATS.has(cat) ? filePath(t.input) : null;
      if (p) c.paths.add(p);
      else c.pathless++;
      mark('cat:' + cat);
    } else if (t.name.startsWith('mcp__')) {
      const s = mcpServer(t.name);
      servers.set(s, (servers.get(s) || 0) + 1);
      mark('mcp');
    } else {
      unknown++;
      unknownNames.add(t.name);
      mark('unknown');
    }
  }
  const parts = [];
  for (const [cat, c] of cats) {
    const n = FILE_CATS.has(cat) ? c.paths.size + c.pathless : c.calls;
    parts.push({ label: LABEL[cat](n), count: c.calls, first: first.get('cat:' + cat) });
  }
  if (servers.size) {
    const calls = [...servers.values()].reduce((s, x) => s + x, 0);
    const label = servers.size === 1 ? `Использована интеграция ${[...servers.keys()][0]}`
      : counted(servers.size, ['Использована', 'Использовано'], ['интеграция', 'интеграции', 'интеграций']);
    parts.push({ label, count: calls, first: first.get('mcp') });
  }
  if (unknown) {
    // Desktop пишет «Used a tool»; один и тот же инструмент назовём по имени — так понятнее.
    const label = unknownNames.size === 1 ? `Использован инструмент ${[...unknownNames][0]}`
      : counted(unknown, ['Использован', 'Использовано'], ['инструмент', 'инструмента', 'инструментов']);
    parts.push({ label, count: unknown, first: first.get('unknown') });
  }
  parts.sort((a, b) => b.count - a.count || a.first - b.first);
  const text = parts.slice(0, 3).map((p, i) => (i ? lowerFirst(p.label) : p.label)).join(', ');
  const rest = parts.slice(3).reduce((s, p) => s + p.count, 0);
  return rest ? `${text} и ещё ${rest} ${plural(rest, 'вызов', 'вызова', 'вызовов')}` : text;
}

// ---------- Разбор транскрипта ----------

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const INTERRUPT = /^\[Request interrupted by user( for tool use)?\]$/;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

function tagText(s, tag) {
  const m = String(s).match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return m ? m[1] : null;
}

// Текст сообщения, как его видит пользователь: без системных вставок harness'а, вставленный текст — как есть.
function cleanUserText(s) {
  return String(s)
    .replace(/\r\n/g, '\n')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<pasted_content\b[^>]*>\n?([\s\S]*?)\n?<\/pasted_content>/g, '$1')
    .trim();
}

function imageOf(b) {
  const s = b.source || {};
  if (s.type === 'base64' && IMAGE_TYPES.has(s.media_type) && typeof s.data === 'string' && /^[A-Za-z0-9+/=\r\n]+$/.test(s.data)) {
    return { mime: s.media_type, data: s.data.replace(/[\r\n]/g, '') };
  }
  return { mime: null, data: null };
}

function contentParts(content) {
  if (typeof content === 'string') return { text: content, images: [] };
  let text = '';
  const images = [];
  if (Array.isArray(content)) {
    for (const b of content) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'text') text += (text ? '\n\n' : '') + (b.text || '');
      else if (b.type === 'image') images.push(imageOf(b));
    }
  }
  return { text, images };
}

function taskSummary(s) {
  const sum = tagText(s, 'summary');
  return sum && sum.trim() ? sum.trim() : 'Фоновая задача завершилась';
}

// Видимая лента: user, text (ответ Claude), tools (свёрнутая группа), note, compact, chapter.
function collect(filePath) {
  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  const items = [];
  const info = { sessionId: null, cwd: null, branch: null, first: 0, last: 0, models: new Set(), title: { custom: null, ai: null, agent: null }, firstPrompt: null };
  const seen = new Set();
  let group = null;

  const flush = () => {
    if (!group) return;
    items.push({ k: 'tools', ts: group.ts, text: groupLabel(group.tools), n: group.tools.length });
    group = null;
  };
  const push = (it) => {
    flush();
    items.push(it);
  };
  const note = (ts, text, tone = '') => {
    const t = String(text).replace(ANSI, '').replace(/\r\n/g, '\n').replace(/\n\s*\n/g, '\n').trim();
    if (t) push({ k: 'note', ts, text: t, tone });
  };

  // Сообщение пользователя: промпт, слэш-команда, её вывод или отметка о прерывании.
  // Служебные теги узнаём только в начале: в обычном промпте их могут просто обсуждать.
  const userText = (ts, raw, images) => {
    const t = String(raw).trim();
    const lead = (t.match(/^<([a-z-]+)>/) || [])[1];
    if (INTERRUPT.test(t)) return note(ts, 'Прервано пользователем');
    if (lead === 'local-command-caveat') return;
    if (lead === 'local-command-stdout' || lead === 'local-command-stderr') return note(ts, tagText(t, lead) || '');
    if (lead === 'task-notification') return note(ts, taskSummary(t));
    if (lead === 'command-message' || lead === 'command-name') {
      const cmd = (tagText(t, 'command-name') || '').trim();
      // Без «/» — это Skill-инструмент подгружает скилл сам, а не пользователь набрал команду.
      if (!cmd.startsWith('/')) return;
      const args = (tagText(t, 'command-args') || '').trim();
      return userText(ts, cmd + (args ? ' ' + args : ''), images);
    }
    if (lead === 'bash-input') return userText(ts, '! ' + (tagText(t, lead) || '').trim(), images);
    if (lead === 'bash-stdout' || lead === 'bash-stderr') {
      const ls = (tagText(t, lead) || '').replace(ANSI, '').trim().split('\n');
      return note(ts, ls.slice(0, 6).join('\n') + (ls.length > 6 ? `\n… ещё ${ls.length - 6} строк` : ''));
    }
    const text = cleanUserText(t);
    if (!text && !images.length) return;
    if (!info.firstPrompt && text) info.firstPrompt = text;
    push({ k: 'user', ts, text, images });
  };

  for (const raw of lines) {
    if (!raw || raw.length < 2) continue;
    let e;
    try {
      e = JSON.parse(raw);
    } catch (err) {
      continue;
    }
    if (e.uuid) {
      if (seen.has(e.uuid)) continue;
      seen.add(e.uuid);
    }
    if (e.type === 'custom-title') {
      if (e.customTitle) info.title.custom = e.customTitle;
      continue;
    }
    if (e.type === 'ai-title') {
      if (e.aiTitle) info.title.ai = e.aiTitle;
      continue;
    }
    if (e.type === 'agent-name') {
      if (e.agentName) info.title.agent = e.agentName;
      continue;
    }
    if (e.type !== 'user' && e.type !== 'assistant' && e.type !== 'attachment' && e.type !== 'system') continue;
    const ts = e.timestamp ? Date.parse(e.timestamp) || 0 : 0;
    if (ts && (e.type === 'user' || e.type === 'assistant')) {
      if (!info.first || ts < info.first) info.first = ts;
      if (ts > info.last) info.last = ts;
    }
    if (e.sessionId && !info.sessionId) info.sessionId = e.sessionId;
    if (e.cwd && !info.cwd) info.cwd = e.cwd;
    if (e.gitBranch) info.branch = e.gitBranch;

    if (e.type === 'assistant') {
      const m = e.message || {};
      const content = Array.isArray(m.content) ? m.content : [];
      if (m.model === '<synthetic>') {
        // Служебные ответы («No response requested.») Claude не показывает, ошибки API — показывает.
        if (e.isApiErrorMessage) note(ts, contentParts(content).text, 'error');
        continue;
      }
      if (m.model) info.models.add(m.model);
      for (const b of content) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'text') {
          const t = (b.text || '').trim();
          if (t && t !== '(no content)') push({ k: 'text', ts, text: t });
        } else if (b.type === 'tool_use') {
          const input = b.input && typeof b.input === 'object' ? b.input : {};
          // Глава Desktop — разделитель с заголовком в ленте, а не вызов инструмента.
          if (b.name === 'mcp__ccd_session__mark_chapter') {
            if (typeof input.title === 'string' && input.title.trim()) {
              push({ k: 'chapter', ts, title: input.title.trim(), summary: typeof input.summary === 'string' ? input.summary.trim() : '' });
            }
            continue;
          }
          if (!group) group = { ts, tools: [] };
          group.tools.push({ name: String(b.name || '?'), input });
        }
        // thinking и redacted_thinking в обычном виде скрыты
      }
      continue;
    }

    if (e.type === 'user') {
      if (e.isMeta || e.isCompactSummary || e.isVisibleInTranscriptOnly) continue;
      const m = e.message || {};
      const origin = e.origin && e.origin.kind;
      if (origin === 'task-notification') {
        note(ts, taskSummary(contentParts(m.content).text));
        continue;
      }
      // Сообщения других агентов и координатора Claude не показывает как реплики пользователя.
      if (origin && origin !== 'human') continue;
      const { text, images } = contentParts(m.content);
      // Результаты инструментов (tool_result) скрыты; в тех же записях бывает только отметка о прерывании.
      if (text || images.length) userText(ts, text, images);
      continue;
    }

    if (e.type === 'attachment') {
      const a = e.attachment || {};
      // Сообщение, набранное, пока Claude работал: Desktop показывает его в ленте там, где оно дошло.
      if (a.type !== 'queued_command') continue;
      const { text, images } = contentParts(a.prompt);
      if (a.commandMode === 'task-notification') {
        note(ts, taskSummary(text));
        continue;
      }
      if (a.commandMode && a.commandMode !== 'prompt') continue;
      if (a.origin && a.origin.kind !== 'human') continue;
      userText(ts, text, images);
      continue;
    }

    // system
    const content = typeof e.content === 'string' ? e.content : '';
    if (e.subtype === 'compact_boundary') {
      const md = e.compactMetadata || {};
      push({ k: 'compact', ts, trigger: md.trigger || null });
    } else if (e.subtype === 'local_command') {
      userText(ts, content, []);
    } else if (e.subtype === 'informational' || e.subtype === 'model_refusal_fallback') {
      note(ts, content, e.level === 'warning' || e.subtype === 'model_refusal_fallback' ? 'warn' : '');
    }
  }
  flush();
  return { items, info };
}

// ---------- Шапка ----------

const dDate = new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
const dTime = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' });

function fmtRange(a, b) {
  if (!a) return null;
  const d1 = dDate.format(a);
  const t1 = dTime.format(a);
  if (!b || b - a < 60000) return `${d1}, ${t1}`;
  const d2 = dDate.format(b);
  return d1 === d2 ? `${d1}, ${t1}–${dTime.format(b)}` : `${d1}, ${t1} — ${d2}, ${dTime.format(b)}`;
}

function headOf(info, meta) {
  const str = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 300) : null);
  const branch = str(meta.branch) || info.branch;
  return {
    title: str(meta.title) || info.title.custom || info.title.agent || info.title.ai
      || (info.firstPrompt ? firstLine(info.firstPrompt).slice(0, 90) : null) || 'Транскрипт',
    thread: str(meta.thread),
    parts: [
      str(meta.project) || (info.cwd ? path.basename(info.cwd) : null),
      branch && branch !== 'HEAD' ? `ветка ${branch}` : null,
      fmtRange(info.first, info.last),
      [...info.models].join(', ') || null,
      info.sessionId ? `сессия ${info.sessionId.slice(0, 8)}` : null,
    ].filter(Boolean),
    first: info.first,
  };
}

function fileNameOf(head, format) {
  const d = head.first ? new Date(head.first) : new Date();
  const pad = (x) => String(x).padStart(2, '0');
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const name = [head.title, head.thread].filter(Boolean).join(' — ')
    .replace(/[<>:"/\\|?*\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100).replace(/[. ]+$/, '');
  return `${date} ${name || 'транскрипт'}.${format}`;
}

function compactLabel(it) {
  return it.trigger === 'manual' ? 'Контекст сжат (/compact)' : 'Контекст сжат (автокомпакт)';
}

// ---------- Markdown ----------

// Строчный текст (подписи, заметки): экранируем всё, что Markdown и Obsidian приняли бы за разметку.
// «_» внутри слова (YANDEX_TOKEN) курсивом не станет, а «>» опасен только в начале строки —
// их не трогаем, чтобы исходник читался.
function mdInline(s) {
  return String(s)
    .replace(/[\\`*[\]<#|~$]/g, '\\$&')
    .replace(/_/g, (m, i, str) => (/[\p{L}\p{N}]/u.test(str[i - 1] || '') && /[\p{L}\p{N}]/u.test(str[i + 1] || '') ? m : '\\_'))
    .replace(/&(?=#?\w+;)/g, '\\&')
    .replace(/^(\s*)>/, '$1\\>');
}

// Сообщение пользователя Claude показывает как простой текст, а не Markdown: переносим построчно,
// экранируя разметку и сохраняя отступы и переносы строк.
function mdPlainLines(text) {
  return text.split('\n').map((line) => {
    let l = mdInline(line.replace(/\t/g, '    '));
    l = l.replace(/^(\s*)([+-])(?=\s|$)/, '$1\\$2');
    l = l.replace(/^(\s*\d+)([.)])(?=\s|$)/, '$1\\$2');
    l = l.replace(/^(\s*)([-=])(?=[-=\s]*$)/, '$1\\$2');
    return l.replace(/^ +/, (m) => '\u00a0'.repeat(m.length));
  });
}

function mdQuote(lines) {
  return lines.map((l, i) => {
    if (!l.trim()) return '>';
    const next = lines[i + 1];
    return '> ' + l + (next && next.trim() ? '  ' : '');
  }).join('\n');
}

// Незакрытый блок кода в одном ответе не должен проглотить остаток файла.
function closeFences(text) {
  let open = null;
  for (const line of text.split('\n')) {
    const m = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (!m) continue;
    if (!open) open = m[1];
    else if (m[1][0] === open[0] && m[1].length >= open.length && !line.trim().slice(m[1].length).trim()) open = null;
  }
  return open ? `${text}\n${open}` : text;
}

function mdNote(text, tone) {
  // Ошибку API Claude показывает в рамке; в Markdown рамка — это блок кода.
  if (tone === 'error') {
    const run = Math.max(0, ...(text.match(/`+/g) || []).map((s) => s.length));
    const fence = '`'.repeat(Math.max(3, run + 1));
    return `${fence}text\n${text}\n${fence}`;
  }
  const ls = text.split('\n').filter((l) => l.trim());
  const shown = ls.slice(0, 12).map(mdInline);
  if (ls.length > 12) shown.push('…');
  return `*${shown.join('  \n')}*`;
}

function renderMarkdown(items, head) {
  const out = [`# ${mdInline(head.title)}`];
  if (head.thread) out.push(`**${mdInline(head.thread)}**`);
  if (head.parts.length) out.push(head.parts.map(mdInline).join(' · '));
  out.push(`*${mdInline(VIEW_NOTE)}*`, '---');
  for (const it of items) {
    if (it.k === 'user') {
      const lines = it.text ? mdPlainLines(it.text) : [];
      for (let i = 0; i < it.images.length; i++) {
        if (lines.length) lines.push('');
        lines.push('*\\[изображение\\]*');
      }
      out.push(mdQuote(lines));
    } else if (it.k === 'text') out.push(closeFences(it.text));
    else if (it.k === 'tools') out.push(`*▸ ${mdInline(it.text)}*`);
    else if (it.k === 'note') out.push(mdNote(it.text, it.tone));
    else if (it.k === 'compact') out.push(`*— ${mdInline(compactLabel(it))} —*`);
    else if (it.k === 'chapter') out.push(`## ${mdInline(it.title)}` + (it.summary ? `\n\n*${mdInline(it.summary)}*` : ''));
  }
  return out.join('\n\n') + '\n';
}

// ---------- HTML ----------

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);
const SAFE_URL = /^(https?:|mailto:)/i;

// Ответы Claude — Markdown. Сырой HTML в них Claude показывает текстом, так и здесь; ссылки — только
// http(s) и mailto: относительные пути к файлам проекта в чужом браузере всё равно никуда не ведут.
const marked = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    html(t) {
      return t.block ? `<p class="raw">${esc(t.text.trim())}</p>\n` : esc(t.text);
    },
    link({ href, title, tokens }) {
      const inner = this.parser.parseInline(tokens);
      if (!SAFE_URL.test(href || '')) return `<span class="ref" title="${esc(href || '')}">${inner}</span>`;
      return `<a href="${esc(href)}"${title ? ` title="${esc(title)}"` : ''} target="_blank" rel="noopener noreferrer">${inner}</a>`;
    },
    image({ href, title, text }) {
      const label = esc(text || title || href || 'изображение');
      return SAFE_URL.test(href || '') ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${label}</a>` : label;
    },
  },
});

const CSS = `
:root {
  color-scheme: light dark;
  --bg: #faf9f5; --ink: #1f1e1d; --ink-2: #3d3c38; --muted: #7c7a73; --line: #e4e1d7;
  --bubble: #f0eee6; --code-bg: #f3f1ea; --link: #2459a8; --warn: #946000; --bad: #b3261e;
  --mono: ui-monospace, "Cascadia Mono", Consolas, "SF Mono", Menlo, monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #262624; --ink: #f4f3ee; --ink-2: #dcdad2; --muted: #a29f96; --line: #3c3b37;
    --bubble: #141413; --code-bg: #1d1d1b; --link: #86b6ef; --warn: #e0a93b; --bad: #f28b82;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 16px/1.6 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; -webkit-font-smoothing: antialiased; }
.page { max-width: 780px; margin: 0 auto; padding: 40px 20px 80px; }
.head { margin-bottom: 28px; padding-bottom: 16px; border-bottom: 1px solid var(--line); }
.head h1 { font-size: 26px; line-height: 1.25; margin: 0 0 8px; font-weight: 600; letter-spacing: -0.01em; }
.thread { font-weight: 600; color: var(--ink-2); margin-bottom: 4px; }
.meta { color: var(--muted); font-size: 14px; }
.meta span + span::before { content: "·"; margin: 0 8px; }
.view-note { color: var(--muted); font-size: 13px; margin-top: 6px; }
.user { display: flex; justify-content: flex-end; margin: 32px 0 16px; }
.bubble { max-width: 85%; background: var(--bubble); border-radius: 18px; padding: 10px 16px; white-space: pre-wrap; overflow-wrap: anywhere; }
.bubble img { display: block; max-width: 100%; max-height: 360px; border-radius: 8px; margin: 6px 0; }
.img-ph { color: var(--muted); font-style: italic; }
.claude { margin: 14px 0; overflow-wrap: break-word; }
.claude > :first-child { margin-top: 0; }
.claude > :last-child { margin-bottom: 0; }
.claude p, .claude ul, .claude ol, .claude pre, .claude table, .claude blockquote { margin: 0 0 12px; }
.claude h1, .claude h2, .claude h3, .claude h4, .claude h5, .claude h6 { line-height: 1.3; margin: 20px 0 8px; font-weight: 600; }
.claude h1 { font-size: 22px; } .claude h2 { font-size: 19px; } .claude h3 { font-size: 17px; } .claude h4, .claude h5, .claude h6 { font-size: 16px; }
.claude ul, .claude ol { padding-left: 24px; }
.claude li + li, .claude li > ul, .claude li > ol { margin-top: 4px; }
.claude li:has(> input[type=checkbox]) { list-style: none; margin-left: -20px; }
.claude input[type=checkbox] { margin: 0 6px 0 0; vertical-align: -1px; }
.claude code { font: 0.875em/1.5 var(--mono); background: var(--code-bg); padding: 0.1em 0.35em; border-radius: 4px; }
.claude pre { background: var(--code-bg); border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px; overflow-x: auto; }
.claude pre code { background: none; padding: 0; font-size: 13.5px; line-height: 1.5; }
.claude table { border-collapse: collapse; display: block; overflow-x: auto; max-width: 100%; font-size: 15px; }
.claude th, .claude td { border: 1px solid var(--line); padding: 6px 10px; text-align: left; vertical-align: top; }
.claude th { background: var(--code-bg); font-weight: 600; }
.claude blockquote { border-left: 3px solid var(--line); padding-left: 14px; color: var(--ink-2); margin-left: 0; }
.claude hr { border: 0; border-top: 1px solid var(--line); margin: 20px 0; }
.claude a { color: var(--link); }
.claude .ref { text-decoration: underline dotted; text-underline-offset: 3px; }
.claude .raw { white-space: pre-wrap; }
.row { color: var(--muted); font-size: 14px; margin: 8px 0; }
.tools { display: flex; gap: 8px; align-items: baseline; }
.tools .ico { flex: none; width: 10px; font-size: 12px; }
.note { font-style: italic; white-space: pre-wrap; overflow-wrap: anywhere; }
.note.warn { color: var(--warn); }
.note.error {
  color: var(--bad); font-style: normal; margin: 12px 0; padding: 10px 14px; border-radius: 10px;
  border: 1px solid color-mix(in srgb, var(--bad) 45%, transparent); background: color-mix(in srgb, var(--bad) 7%, transparent);
}
.divider { display: flex; align-items: center; gap: 12px; color: var(--muted); font-size: 13px; margin: 28px 0; }
.divider::before, .divider::after { content: ""; flex: 1; border-top: 1px solid var(--line); }
.chapter { font-size: 20px; line-height: 1.3; margin: 44px 0 6px; padding-top: 18px; border-top: 1px solid var(--line); font-weight: 600; }
.chapter-sub { color: var(--muted); font-size: 14px; margin: 0 0 12px; }
@media (max-width: 600px) { .page { padding: 24px 16px 48px; } .bubble { max-width: 92%; } }
@media print {
  :root { --bg: #fff; --ink: #000; --bubble: #f2f2f2; --code-bg: #f6f6f6; }
  .page { max-width: none; padding: 0; }
  .user, .claude pre, .claude table { break-inside: avoid; }
}
`;

function htmlItem(it) {
  if (it.k === 'user') {
    const imgs = it.images.map((im) => (im.mime
      ? `<img alt="изображение" src="data:${im.mime};base64,${im.data}">`
      : '<span class="img-ph">[изображение]</span>')).join('');
    const when = it.ts ? ` title="${esc(`${dDate.format(it.ts)}, ${dTime.format(it.ts)}`)}"` : '';
    return `<div class="user"${when}><div class="bubble">${esc(it.text)}${imgs}</div></div>`;
  }
  if (it.k === 'text') return `<div class="claude">${marked.parse(it.text)}</div>`;
  if (it.k === 'tools') return `<div class="row tools"><span class="ico" aria-hidden="true">▸</span><span>${esc(it.text)}</span></div>`;
  if (it.k === 'note') return `<div class="row note${it.tone ? ' ' + it.tone : ''}">${esc(it.text)}</div>`;
  if (it.k === 'compact') return `<div class="divider"><span>${esc(compactLabel(it))}</span></div>`;
  if (it.k === 'chapter') return `<h2 class="chapter">${esc(it.title)}</h2>${it.summary ? `<p class="chapter-sub">${esc(it.summary)}</p>` : ''}`;
  return '';
}

function renderHtml(items, head) {
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="generator" content="Токеноскоп">
<title>${esc(head.title)}</title>
<style>${CSS}</style>
</head>
<body>
<main class="page">
<header class="head">
<h1>${esc(head.title)}</h1>
${head.thread ? `<div class="thread">${esc(head.thread)}</div>\n` : ''}<div class="meta">${head.parts.map((p) => `<span>${esc(p)}</span>`).join('')}</div>
<div class="view-note">${esc(VIEW_NOTE)}</div>
</header>
${items.map(htmlItem).join('\n')}
</main>
</body>
</html>
`;
}

// meta — то, что знает интерфейс: название сессии как в списке, поток, проект, ветка. Чего нет — берётся из файла.
function buildExport(filePath, format, meta) {
  const fmt = format === 'html' ? 'html' : 'md';
  const { items, info } = collect(filePath);
  const head = headOf(info, meta && typeof meta === 'object' ? meta : {});
  return {
    content: fmt === 'html' ? renderHtml(items, head) : renderMarkdown(items, head),
    fileName: fileNameOf(head, fmt),
    items: items.length,
  };
}

module.exports = { buildExport, groupLabel, collect };
