// Просмотр транскриптов, журналов и скриптов воркфлоу.
import { html, useState, useEffect, useMemo, useRef } from '../lib/h.js';
import { useApp } from '../lib/app-context.js';
import { resolvePrice, sessionTitle, runName } from '../lib/data.js';
import { Pill, useOutsideClose } from '../lib/ui.js';
import { fmtUsd, fmtInt, fmtTokShort, fmtDateTime, fmtTime } from '../lib/format.js';

const PAGE = 150;

function useLoad(fn, deps) {
  const [state, setState] = useState({ loading: true, data: null, error: null });
  useEffect(() => {
    let alive = true;
    setState({ loading: true, data: null, error: null });
    fn().then((data) => alive && setState({ loading: false, data, error: null }))
      .catch((e) => alive && setState({ loading: false, data: null, error: String((e && e.message) || e) }));
    return () => { alive = false; };
  }, deps);
  return state;
}

// Блок текста с усечением: «ещё» раскрывает загруженную часть, «полностью» догружает из файла.
function TextBlock({ block, path, preview = 1200, className = 'msg-text' }) {
  const [open, setOpen] = useState(false);
  const [full, setFull] = useState(null);
  const text = full != null ? full : block.text;
  const long = text.length > preview;
  const shown = open || !long ? text : text.slice(0, preview);
  const loadFull = async () => {
    const t = await window.api.readBlock(path, block.ln, block.bi);
    setFull(t);
    setOpen(true);
  };
  return html`<div>
    <pre class=${className}>${shown}${!open && long ? '…' : ''}</pre>
    <div class="block-actions">
      ${long && html`<button class="link" onClick=${() => setOpen(!open)}>${open ? 'Свернуть' : `Показать всё (${fmtInt(text.length)} симв.)`}</button>`}
      ${block.cut && full == null && html`<button class="link" onClick=${loadFull}>Загрузить полностью из файла (${fmtInt(block.len)} симв.)</button>`}
    </div>
  </div>`;
}

function ToolCard({ use, result, path, showResults }) {
  const [open, setOpen] = useState(false);
  const first = use.text.split('\n')[0];
  return html`<div class=${'tool-card' + (result && result.error ? ' error' : '')}>
    <div class="tool-head clickable" onClick=${() => setOpen(!open)}>
      <span class="caret">${open ? '▾' : '▸'}</span>
      <span class="tool-name">${use.name}</span>
      <span class="tool-arg">${first.length > 160 ? first.slice(0, 160) + '…' : first}</span>
      ${result && html`<span class="tool-size">${result.images ? `${result.images} изобр. · ` : ''}${fmtTokShort(result.len)} симв.</span>`}
      ${result && result.error && html`<${Pill} tone="bad">ошибка</${Pill}>`}
    </div>
    ${open && html`<div class="tool-body">
      <div class="tool-label">Вызов</div>
      <${TextBlock} block=${use} path=${path} preview=${4000} className="code-text" />
    </div>`}
    ${result && (open || showResults) && html`<div class="tool-body">
      <div class="tool-label">Результат</div>
      <${TextBlock} block=${result} path=${path} preview=${open ? 6000 : 500} className="code-text" />
    </div>`}
  </div>`;
}

function threadName(P, file) {
  const name = file.label || file.agentType || 'агент';
  const parts = [`Агент: ${name}`];
  if (file.agentType && file.agentType !== name && file.agentType !== 'workflow-subagent') parts.push(file.agentType);
  if (file.phase) parts.push(`фаза ${file.phase}`);
  const run = file.run ? P.ds.sessions[file.session].runs.find((r) => r.run === file.run) : null;
  if (run) parts.push(`прогон ${runName(run.name)}`);
  return parts.join(' · ');
}

// Сохранение потока в Markdown или HTML — так, как он виден в Claude в обычном режиме (lib/export.js).
export function ExportMenu({ fileIdx }) {
  const { P } = useApp();
  const [panel, setPanel] = useState(null); // 'menu' | { saved, download } | { error }
  const [busy, setBusy] = useState(false);
  const ref = useOutsideClose(!!panel, () => setPanel(null));
  const file = P.ds.files[fileIdx];
  if (!file) return null;
  const save = async (format) => {
    const sess = P.ds.sessions[file.session];
    const meta = {
      title: sessionTitle(P, file.session),
      thread: file.kind === 0 ? null : threadName(P, file),
      project: P.ds.projects[sess.project].name,
      branch: sess.gitBranch,
    };
    setPanel(null);
    setBusy(true);
    try {
      const r = await window.api.exportTranscript(file.path, format, meta);
      setPanel(r ? { saved: r.path, download: !!r.download } : null);
    } catch (e) {
      setPanel({ error: String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') });
    } finally {
      setBusy(false);
    }
  };
  const done = panel && panel !== 'menu' ? panel : null;
  const act = (fn) => () => {
    fn(done.saved);
    setPanel(null);
  };
  return html`<div class="dropdown" ref=${ref}>
    <button class="btn small" disabled=${busy} onClick=${() => setPanel(panel === 'menu' ? null : 'menu')}
      title="Сохранить транскрипт так, как он виден в Claude в обычном режиме">${busy ? 'Сохраняю…' : 'Сохранить ▾'}</button>
    ${panel === 'menu' && html`<div class="dd-panel right export-panel">
      <button class="dd-action" onClick=${() => save('md')}>Markdown<span class="muted">.md</span></button>
      <button class="dd-action" onClick=${() => save('html')}>HTML-страница<span class="muted">.html</span></button>
      <div class="dd-note">Как в Claude в обычном режиме: сообщения и ответы целиком, вызовы инструментов — строками-сводками. Размышления, команды и результаты в файл не попадают.</div>
    </div>`}
    ${done && html`<div class="dd-panel right export-panel">
      ${done.error ? html`<div class="warn-text">Не удалось сохранить: ${done.error}</div>` : html`
        <div>${done.download ? 'Скачано' : 'Сохранено'}: <span class="export-name" title=${done.saved}>${done.saved.split(/[\\/]/).pop()}</span></div>
        ${!done.download && html`<div class="export-links">
          <button class="link" onClick=${act(window.api.openExport)}>Открыть</button>
          <button class="link" onClick=${act(window.api.revealExport)}>Показать в папке</button>
        </div>`}`}
    </div>`}
  </div>`;
}

function Transcript({ fileIdx, focusTs }) {
  const { P, back, go } = useApp();
  const file = P.ds.files[fileIdx];
  const sess = P.ds.sessions[file.session];
  const run = file.run ? sess.runs.find((r) => r.run === file.run) : null;
  const st = useLoad(() => window.api.readTranscript(file.path), [file.path]);
  const [opts, setOpts] = useState({ tools: true, results: false, attachments: false, meta: false, thinking: false });
  const [q, setQ] = useState('');
  const [shown, setShown] = useState(PAGE);
  const [focus, setFocus] = useState(-1);
  const listRef = useRef(null);

  const data = useMemo(() => {
    if (!st.data) return null;
    const results = new Map();
    let step = 0;
    const entries = st.data.entries.map((e) => {
      if (e.kind === 'results') for (const b of e.blocks) results.set(b.id, b);
      if (e.kind === 'assistant' && e.usage) return { ...e, step: ++step };
      return e;
    });
    return { entries, results, steps: step };
  }, [st.data]);

  const visible = useMemo(() => {
    if (!data) return [];
    const ql = q.trim().toLowerCase();
    const out = [];
    data.entries.forEach((e, i) => {
      if (e.kind === 'results') return; // результаты показываются под вызовом
      if (e.kind === 'attachment' && !opts.attachments) return;
      if (e.kind === 'meta' && !opts.meta) return;
      if (ql) {
        let hay = e.text || '';
        if (e.blocks) for (const b of e.blocks) {
          hay += '\n' + (b.text || '') + (b.name ? ' ' + b.name : '');
          if (b.k === 'tool_use' && data.results.get(b.id)) hay += '\n' + data.results.get(b.id).text;
        }
        if (!hay.toLowerCase().includes(ql)) return;
      }
      out.push(i);
    });
    return out;
  }, [data, opts, q]);

  // Переход к месту, где появился «тяжёлый» кусок.
  useEffect(() => {
    if (!data || !focusTs) return;
    let best = -1;
    for (let k = 0; k < data.entries.length; k++) {
      if (data.entries[k].ts && data.entries[k].ts >= focusTs - 500) {
        best = k;
        break;
      }
    }
    if (best < 0) return;
    // Кусок — результат инструмента: подсвечиваем вызов, к которому он относится.
    const target = data.entries[best];
    let at = best;
    if (target.kind === 'results') {
      const id = target.blocks[0] && target.blocks[0].id;
      for (let k = best - 1; k >= 0; k--) {
        const e = data.entries[k];
        if (e.kind === 'assistant' && e.blocks.some((b) => b.id === id)) {
          at = k;
          break;
        }
      }
    }
    setFocus(at);
    setOpts((o) => ({ ...o, results: true, attachments: o.attachments || target.kind === 'attachment', meta: o.meta || target.kind === 'meta' }));
  }, [data, focusTs]);

  useEffect(() => {
    if (focus < 0) return;
    const pos = visible.indexOf(focus);
    if (pos >= shown) setShown(pos + 40);
    setTimeout(() => {
      const el = document.getElementById('tr-' + focus);
      if (el) el.scrollIntoView({ block: 'center' });
    }, 80);
  }, [focus, visible]);

  const price = (model) => resolvePrice(model, P.pricing);
  const agentLabel = file.kind === 0 ? 'Основной поток' : (file.label || file.agentType || 'агент');

  let body;
  if (st.loading) body = html`<div class="empty-state">Читаю транскрипт…</div>`;
  else if (st.error) body = html`<div class="empty-state warn-text">${st.error}</div>`;
  else {
    body = html`<div class="transcript" ref=${listRef}>
      ${visible.slice(0, shown).map((i) => {
        const e = data.entries[i];
        const cls = 'entry ' + e.kind + (i === focus ? ' focus' : '');
        if (e.kind === 'user' || e.kind === 'meta') {
          return html`<div class=${cls} id=${'tr-' + i}>
            <div class="entry-head"><span class="who">${e.kind === 'meta' ? 'Вставка (скилл, команда)' : file.kind !== 0 && i < 3 ? 'Промпт задачи' : 'Пользователь'}</span><span class="when">${fmtDateTime(e.ts)}</span></div>
            ${e.blocks.map((b) => (b.k === 'image' ? html`<div class="muted small">[изображение]</div>` : html`<${TextBlock} block=${b} path=${file.path} preview=${e.kind === 'meta' ? 400 : 3000} />`))}
          </div>`;
        }
        if (e.kind === 'summary') {
          return html`<div class=${cls} id=${'tr-' + i}>
            <div class="entry-head"><span class="who">Сводка после компакта</span><span class="when">${fmtDateTime(e.ts)}</span></div>
            <${TextBlock} block=${e} path=${file.path} preview=${800} />
          </div>`;
        }
        if (e.kind === 'attachment') {
          return html`<div class=${cls} id=${'tr-' + i}>
            <div class="entry-head"><span class="who">Системная вставка: ${e.atype}${e.name ? ' · ' + e.name : ''}</span><span class="when">${fmtTokShort(e.len)} симв. · ${fmtTime(e.ts)}</span></div>
            <${TextBlock} block=${e} path=${file.path} preview=${300} className="code-text" />
          </div>`;
        }
        if (e.kind === 'system') {
          const compact = e.subtype === 'compact_boundary';
          return html`<div class=${'entry-divider' + (compact ? ' compact' : '')} id=${'tr-' + i}>
            <span>${compact ? `Компакт (${e.trigger === 'manual' ? 'вручную' : 'авто'})${e.preTokens ? ` · до него ${fmtTokShort(e.preTokens)} токенов` : ''}` : `${e.subtype || 'system'}${e.text ? ': ' + e.text.slice(0, 200) : ''}`}</span>
            <span class="when">${fmtDateTime(e.ts)}</span>
          </div>`;
        }
        // assistant
        const u = e.usage;
        let usageText = null;
        if (u) {
          const p = price(e.model);
          const mult = u.fast ? P.pricing.fastMult ?? 2 : 1;
          const cost = ((u.inp * p.in + u.cw5m * p.cw5m + u.cw1h * p.cw1h + u.cr * p.cr + u.out * p.out) * mult) / 1e6;
          usageText = `контекст ${fmtTokShort(u.inp + u.cw + u.cr)} · записано ${fmtTokShort(u.cw)} · вывод ${fmtTokShort(u.out)}${u.think ? ` (размышления ${fmtTokShort(u.think)})` : ''} · ${fmtUsd(cost)}`;
        }
        const blocks = e.blocks.filter((b) => (b.k === 'thinking' ? opts.thinking && b.text : b.k !== 'tool_use' || opts.tools));
        const hiddenTools = e.blocks.filter((b) => b.k === 'tool_use').length;
        return html`<div class=${cls} id=${'tr-' + i}>
          <div class="entry-head">
            <span class="who">Claude${e.step ? html` <span class="step">шаг ${e.step}</span>` : ''}</span>
            ${e.model && html`<span class="muted small">${e.model}${e.effort ? ' · ' + e.effort : ''}${e.skill ? ' · скилл ' + e.skill : ''}${e.mcp ? ' · MCP ' + e.mcp : ''}</span>`}
            <span class="when">${usageText ? usageText + ' · ' : ''}${fmtTime(e.ts)}</span>
          </div>
          ${blocks.map((b) => {
            if (b.k === 'text') return html`<${TextBlock} block=${b} path=${file.path} preview=${4000} />`;
            if (b.k === 'thinking') return html`<div class="thinking"><div class="tool-label">Размышления</div><${TextBlock} block=${b} path=${file.path} preview=${600} /></div>`;
            return html`<${ToolCard} use=${b} result=${data.results.get(b.id)} path=${file.path} showResults=${opts.results} />`;
          })}
          ${!opts.tools && hiddenTools ? html`<div class="muted small">${hiddenTools} вызов(а/ов) инструментов скрыто</div>` : ''}
        </div>`;
      })}
      ${visible.length > shown && html`<div class="table-more">
        <button class="btn small" onClick=${() => setShown(shown + PAGE)}>Показать ещё ${Math.min(PAGE, visible.length - shown)} из ${fmtInt(visible.length - shown)}</button>
        <button class="btn small ghost" onClick=${() => setShown(visible.length)}>Показать всё</button>
      </div>`}
    </div>`;
  }

  const toggle = (k) => setOpts({ ...opts, [k]: !opts[k] });
  return html`<div class="view">
    <div class="detail-head">
      <button class="btn ghost" onClick=${back}>← Назад</button>
      <div class="detail-titles">
        <h1>${agentLabel}</h1>
        <div class="detail-meta">
          <span class="clickable link" onClick=${() => go({ view: 'session', session: file.session })}>${sessionTitle(P, file.session)}</span>
          ${file.agentType && html`<span>${file.agentType}</span>`}
          ${file.phase && html`<span>фаза: ${file.phase}</span>`}
          ${run && html`<span>прогон: ${runName(run.name)}</span>`}
          ${data && html`<span>${fmtInt(data.steps)} запросов · ${fmtInt(data.entries.length)} записей</span>`}
        </div>
        ${run && html`<div class="detail-links">
          ${run.journal && html`<a class="link" onClick=${() => go({ view: 'journal', session: file.session, run: run.run })}>Журнал прогона</a>`}
          ${run.script && html`<a class="link" onClick=${() => go({ view: 'script', session: file.session, run: run.run })}>Скрипт воркфлоу</a>`}
        </div>`}
      </div>
      <div class="head-actions">
        <${ExportMenu} fileIdx=${fileIdx} />
        <button class="btn small" onClick=${() => window.api.showInFolder(file.path)}>Файл в папке</button>
      </div>
    </div>
    <div class="viewer-bar">
      <input class="search" placeholder="Поиск по тексту, командам и результатам…" value=${q} onInput=${(e) => { setQ(e.target.value); setShown(PAGE); }} />
      <label class="check"><input type="checkbox" checked=${opts.tools} onChange=${() => toggle('tools')} /> вызовы инструментов</label>
      <label class="check"><input type="checkbox" checked=${opts.results} onChange=${() => toggle('results')} /> результаты раскрыты</label>
      <label class="check"><input type="checkbox" checked=${opts.thinking} onChange=${() => toggle('thinking')} /> размышления</label>
      <label class="check"><input type="checkbox" checked=${opts.meta} onChange=${() => toggle('meta')} /> тексты скиллов</label>
      <label class="check"><input type="checkbox" checked=${opts.attachments} onChange=${() => toggle('attachments')} /> системные вставки</label>
      ${data && html`<span class="muted small">показано ${fmtInt(Math.min(shown, visible.length))} из ${fmtInt(visible.length)}</span>`}
    </div>
    ${body}
  </div>`;
}

function Journal({ session, run }) {
  const { P, back, go } = useApp();
  const sess = P.ds.sessions[session];
  const info = sess.runs.find((r) => r.run === run) || {};
  const st = useLoad(() => window.api.readJournal(info.journal), [info.journal]);
  const agentFile = (agentId) => P.ds.files.findIndex((f) => f.session === session && f.run === run && f.path.endsWith(`agent-${agentId}.jsonl`));
  const agents = useMemo(() => {
    if (!st.data) return [];
    const m = new Map();
    for (const ev of st.data) {
      const key = ev.agentId || ev.key;
      if (!key) continue; // служебные события прогона без агента
      let a = m.get(key);
      if (!a) m.set(key, (a = { agentId: ev.agentId, label: null, phase: null, status: 'started', result: null, error: null }));
      if (ev.label) a.label = ev.label;
      if (ev.phase) a.phase = ev.phase;
      if (ev.type === 'result') { a.status = 'result'; a.result = ev.result; }
      if (ev.type === 'failed') { a.status = 'failed'; a.error = ev.error; }
    }
    return [...m.values()];
  }, [st.data]);
  return html`<div class="view">
    <div class="detail-head">
      <button class="btn ghost" onClick=${back}>← Назад</button>
      <div class="detail-titles">
        <h1>Журнал прогона: ${runName(info.name || run)}</h1>
        <div class="detail-meta">
          <span class="clickable link" onClick=${() => go({ view: 'session', session })}>${sessionTitle(P, session)}</span>
          ${info.desc && html`<span>${info.desc}</span>`}
          <span>${fmtInt(agents.length)} агентов</span>
        </div>
        ${info.script && html`<div class="detail-links"><a class="link" onClick=${() => go({ view: 'script', session, run })}>Скрипт воркфлоу</a></div>`}
      </div>
    </div>
    ${st.loading ? html`<div class="empty-state">Читаю журнал…</div>` : st.error ? html`<div class="empty-state warn-text">${st.error}</div>` : html`
      <div class="journal">${agents.map((a) => {
        const fi = a.agentId ? agentFile(a.agentId) : -1;
        return html`<div class=${'journal-item ' + a.status}>
          <div class="entry-head">
            <span class="who">${a.label || a.agentId || 'агент'}</span>
            ${a.phase && html`<span class="muted small">${a.phase}</span>`}
            <${Pill} tone=${a.status === 'failed' ? 'bad' : a.status === 'result' ? 'good' : ''}>${a.status === 'result' ? 'готово' : a.status === 'failed' ? 'сбой' : 'запущен'}</${Pill}>
            <span class="when">${fi >= 0 ? html`<button class="btn small ghost" onClick=${() => go({ view: 'transcript', file: fi })}>Транскрипт агента</button>` : ''}</span>
          </div>
          ${a.result && html`<${TextBlock} block=${{ ...a.result, ln: -1, bi: -1, cut: false }} path=${null} preview=${700} className="code-text" />`}
          ${a.error && html`<pre class="code-text warn-text">${a.error.text}</pre>`}
        </div>`;
      })}</div>`}
  </div>`;
}

function Script({ session, run }) {
  const { P, back, go } = useApp();
  const info = P.ds.sessions[session].runs.find((r) => r.run === run) || {};
  const st = useLoad(() => window.api.readScript(info.script), [info.script]);
  return html`<div class="view">
    <div class="detail-head">
      <button class="btn ghost" onClick=${back}>← Назад</button>
      <div class="detail-titles">
        <h1>Скрипт: ${runName(info.name || run)}</h1>
        <div class="detail-meta">
          <span class="clickable link" onClick=${() => go({ view: 'session', session })}>${sessionTitle(P, session)}</span>
          ${st.data && html`<span>${fmtInt(st.data.text.split('\n').length)} строк · ${fmtTokShort(st.data.len)} симв.</span>`}
        </div>
        ${info.journal && html`<div class="detail-links"><a class="link" onClick=${() => go({ view: 'journal', session, run })}>Журнал прогона</a></div>`}
      </div>
      <button class="btn small" onClick=${() => window.api.showInFolder(info.script)}>Файл в папке</button>
    </div>
    ${st.loading ? html`<div class="empty-state">Читаю скрипт…</div>` : st.error ? html`<div class="empty-state warn-text">${st.error}</div>`
      : html`<div class="card"><div class="card-body"><ol class="code-lines">${st.data.text.split('\n').map((l) => html`<li><code>${l || ' '}</code></li>`)}</ol></div></div>`}
  </div>`;
}

export function Viewer({ route }) {
  if (route.view === 'journal') return html`<${Journal} session=${route.session} run=${route.run} />`;
  if (route.view === 'script') return html`<${Script} session=${route.session} run=${route.run} />`;
  return html`<${Transcript} fileIdx=${route.file} focusTs=${route.focusTs} />`;
}
