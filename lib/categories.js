'use strict';
// Классификация того, что попадает в контекст агента: результаты инструментов, вставки, сообщения.
// Категория — пара «группа + деталь»; ключ `${group}\t${detail}` интернируется в датасете.

const GROUPS = {
  start: 'Старт: системный промпт и инструменты',
  compact: 'Сводка автокомпакта',
  user: 'Сообщения пользователя',
  prompt: 'Промпты задач агентов',
  skills: 'Тексты скиллов и команд',
  reminders: 'Системные вставки',
  output: 'Вывод модели',
  files: 'Чтение файлов',
  shell: 'Shell (кроме чтения файлов)',
  edit: 'Правки файлов',
  agents: 'Отчёты субагентов и воркфлоу',
  web: 'Веб',
  browser: 'Браузер',
  mcp: 'MCP-серверы',
  toolsearch: 'Поиск инструментов',
  other: 'Прочие инструменты',
  unknown: 'Неучтённое',
};

// Программы, чей вывод — по сути содержимое файлов.
const READERS = new Set(['cat', 'sed', 'head', 'tail', 'grep', 'rg', 'awk', 'less', 'more', 'type', 'nl', 'wc',
  'find', 'ls', 'tree', 'dir', 'get-content', 'gc', 'select-string', 'sls', 'get-childitem', 'gci', 'jq', 'xxd', 'od',
  'strings', 'file', 'stat', 'du', 'diff']);
const TESTS = new Set(['pytest', 'ruff', 'mypy', 'npm', 'npx', 'pnpm', 'yarn', 'node', 'uv', 'pip', 'docker', 'make',
  'cmake', 'cargo', 'go', 'dotnet', 'msbuild', 'gradle', 'mvn', 'tsc', 'eslint', 'jest', 'vitest', 'ctest', 'ninja']);
const NET = new Set(['curl', 'wget', 'invoke-webrequest', 'iwr', 'invoke-restmethod', 'irm', 'ssh', 'scp']);

const ATTACHMENT_NAMES = {
  skill_listing: 'Список скиллов',
  deferred_tools_delta: 'Список отложенных инструментов',
  deferred_tools_record: 'Список отложенных инструментов',
  mcp_instructions_delta: 'Инструкции MCP-серверов',
  instructions: 'CLAUDE.md и инструкции',
  nested_memory: 'CLAUDE.md и инструкции',
  total_tokens_reminder: 'Напоминания о бюджете токенов',
  hook_success: 'Вывод хуков',
  hook_additional_context: 'Вывод хуков',
  hook_error: 'Вывод хуков',
  edited_text_file: 'Уведомления об изменённых файлах',
  queued_command: 'Сообщения в очереди',
  environment: 'Окружение и дата',
  date: 'Окружение и дата',
  session_context: 'Окружение и дата',
  agent_listing_delta: 'Список типов агентов',
  structured_output: 'Структурированный вывод',
  task_reminder: 'Напоминания о задачах',
  todo_reminder: 'Напоминания о задачах',
};

function stripWrappers(cmd) {
  let c = String(cmd || '');
  // cd dir && ..., переменные окружения, обёртка rtk
  c = c.replace(/^\s*(cd\s+("[^"]*"|'[^']*'|\S+)\s*(&&|;)\s*)+/i, '');
  c = c.replace(/^\s*(export\s+)?([A-Za-z_][A-Za-z0-9_]*=("[^"]*"|'[^']*'|\S*)\s+)+/, '');
  c = c.replace(/^\s*(\$env:[A-Za-z_]+\s*=\s*("[^"]*"|'[^']*'|\S+)\s*;\s*)+/i, '');
  c = c.replace(/^\s*rtk\s+(proxy\s+)?/, '');
  c = c.replace(/^\s*(timeout\s+\d+\s+|time\s+|sudo\s+|&\s*)/, '');
  return c.trim();
}

function programOf(cmd) {
  const c = stripWrappers(cmd);
  const first = (c.split(/[\s|;&()]/, 1)[0] || '').replace(/^["']|["']$/g, '');
  const base = first.split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, '');
  return base || '?';
}

function shellCategory(cmd) {
  const prog = programOf(cmd);
  const low = String(cmd || '').toLowerCase();
  if (READERS.has(prog)) return ['files', 'Shell: чтение файлов'];
  if (prog === 'git') return ['shell', 'Shell: git'];
  if (prog === 'gh' || prog === 'glab') return ['shell', 'Shell: gh/glab'];
  if (prog.startsWith('python') || prog === 'py') {
    if (/pytest|ruff|mypy/.test(low)) return ['shell', 'Shell: тесты и сборка'];
    return ['shell', 'Shell: python'];
  }
  if (TESTS.has(prog) || /pytest|ruff check|npm (run|test)|cargo (build|test)|go (build|test)/.test(low)) {
    return ['shell', 'Shell: тесты и сборка'];
  }
  if (NET.has(prog)) return ['shell', 'Shell: сеть (curl, ssh)'];
  if (prog.endsWith('els') || low.includes('/els/els')) return ['shell', 'Shell: els'];
  return ['shell', 'Shell: прочее'];
}

function isUuidLike(s) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(s);
}

// Имя MCP-сервера и инструмента из имени вида mcp__server__tool.
function splitMcp(name) {
  const rest = name.slice(5);
  const i = rest.indexOf('__');
  if (i < 0) return [rest, ''];
  return [rest.slice(0, i), rest.slice(i + 2)];
}

function shortServer(server) {
  if (isUuidLike(server)) return server.slice(0, 8);
  return server;
}

function oneLine(s, n) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

// Возвращает [group, detail, desc] для результата инструмента.
function toolCategory(name, input) {
  input = input || {};
  switch (name) {
    case 'Read': {
      const part = input.offset != null || input.limit != null || input.pages != null;
      return ['files', part ? 'Read: фрагмент' : 'Read: файл целиком', oneLine(input.file_path, 200) +
        (part ? ` [${input.offset ?? ''}:${input.limit ?? ''}${input.pages ? ' p' + input.pages : ''}]` : '')];
    }
    case 'Grep': return ['files', 'Grep', oneLine(`${input.pattern || ''} ${input.path || ''}`, 200)];
    case 'Glob': return ['files', 'Glob', oneLine(`${input.pattern || ''} ${input.path || ''}`, 200)];
    case 'LS': return ['files', 'LS', oneLine(input.path, 200)];
    case 'Bash':
    case 'PowerShell': {
      const [g, d] = shellCategory(input.command);
      return [g, d, oneLine(input.command, 220)];
    }
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
      return ['edit', 'Edit/Write', oneLine(input.file_path || input.notebook_path, 200)];
    case 'Agent':
    case 'Task':
      return ['agents', 'Отчёты субагентов', oneLine(`${input.subagent_type ? input.subagent_type + ': ' : ''}${input.description || ''}`, 200)];
    case 'Workflow': {
      const m = /name:\s*['"]([^'"]+)/.exec(input.script || '');
      return ['agents', 'Workflow', oneLine(m ? m[1] : (input.name || input.scriptPath || 'workflow'), 200)];
    }
    case 'TaskOutput':
    case 'AgentOutput':
    case 'SendMessage':
    case 'TaskStop':
    case 'ListAgents':
      return ['agents', 'Связь с агентами', oneLine(name, 80)];
    case 'WebFetch': return ['web', 'WebFetch', oneLine(input.url, 200)];
    case 'WebSearch': return ['web', 'WebSearch', oneLine(input.query, 200)];
    case 'ToolSearch': return ['toolsearch', 'ToolSearch', oneLine(input.query, 200)];
    case 'Skill': return ['skills', 'Skill (загрузка скилла)', oneLine(input.skill || input.name, 120)];
    case 'TodoWrite':
    case 'TaskCreate':
    case 'TaskUpdate':
    case 'TaskList':
      return ['other', 'Задачи (Todo)', name];
    default:
      break;
  }
  if (name.startsWith('mcp__')) {
    const [server, tool] = splitMcp(name);
    const low = server.toLowerCase();
    let summary = '';
    try {
      summary = oneLine(JSON.stringify(input), 160);
    } catch (e) { /* ignore */ }
    if (low.includes('browser') || low.includes('chrome')) {
      return ['browser', `Браузер: ${tool.split('_')[0] === 'computer' ? 'скриншоты и действия' : tool}`, oneLine(`${tool} ${summary}`, 200)];
    }
    return ['mcp', `MCP: ${shortServer(server)}`, oneLine(`${tool} ${summary}`, 200)];
  }
  return ['other', name, ''];
}

function attachmentCategory(type) {
  if (type === 'file' || type === 'compact_file_reference') return ['files', 'Вложенные файлы (@)'];
  if (type === 'plan_file_reference' || type === 'plan_mode') return ['reminders', 'План'];
  return ['reminders', ATTACHMENT_NAMES[type] || `Вставка: ${type}`];
}

module.exports = { GROUPS, toolCategory, attachmentCategory, shellCategory, programOf, oneLine, splitMcp, shortServer };
