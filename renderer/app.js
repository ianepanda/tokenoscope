import { html, render, useState, useEffect, useMemo, useCallback, useRef } from './lib/h.js';
import { AppCtx, metricFmt } from './lib/app-context.js';
import { prepare, rangeFor, filterRows, PRESETS, KIND_FILTERS, METRICS } from './lib/data.js';
import { TooltipLayer } from './lib/charts.js';
import { Segmented, MultiSelect } from './lib/ui.js';
import { fmtAgo, fmtInt, fmtTok, fmtUsd } from './lib/format.js';
import { Overview } from './views/overview.js';
import { Projects } from './views/projects.js';
import { Sessions } from './views/sessions.js';
import { SessionDetail } from './views/session.js';
import { Workflows } from './views/workflows.js';
import { ContextView } from './views/context.js';
import { Tools } from './views/tools.js';
import { TimeView } from './views/time.js';
import { SettingsView } from './views/settings.js';
import { Viewer } from './views/transcript.js';

const NAV = [
  { key: 'overview', label: 'Обзор', icon: '◎' },
  { key: 'projects', label: 'Проекты', icon: '▦' },
  { key: 'sessions', label: 'Сессии', icon: '☰' },
  { key: 'workflows', label: 'Воркфлоу и агенты', icon: '⋔' },
  { key: 'context', label: 'Что в контексте', icon: '◧' },
  { key: 'tools', label: 'Инструменты и модели', icon: '⚒' },
  { key: 'time', label: 'Время и лимиты', icon: '◷' },
  { key: 'settings', label: 'Настройки', icon: '⚙' },
];

// Параметры адреса задаёт режим снимка (main.js --capture): view, session, theme, scroll.
const params = new URLSearchParams(location.search);

function loadUiState() {
  let s = {};
  try {
    s = JSON.parse(localStorage.getItem('ui-state') || '{}');
  } catch (e) { /* ignore */ }
  const view = params.get('view') || s.view;
  return {
    range: s.range || { preset: '7d', from: null, to: null },
    kind: s.kind || 'all',
    metric: s.metric || 'cost',
    view: view && !['session', 'transcript', 'journal', 'script'].includes(view) ? view : 'overview',
  };
}

// Маршрут хранит индексы сессии и файла; после пересканирования индексы могут сдвинуться,
// поэтому рядом лежат устойчивые ключи (id сессии, путь файла), по которым индексы восстанавливаются.
function withKeys(r, d) {
  if (!d || !r) return r;
  const o = { ...r };
  if (r.session != null && d.sessions[r.session]) o.sid = d.sessions[r.session].id;
  if (r.file != null && d.files[r.file]) o.fpath = d.files[r.file].path;
  return o;
}

function remapRoute(r, d) {
  if (!r) return r;
  const o = { ...r };
  if (r.sid) {
    const k = d.sessions.findIndex((s) => s.id === r.sid);
    if (k < 0) return { view: 'sessions' };
    o.session = k;
  }
  if (r.fpath) {
    const k = d.files.findIndex((f) => f.path === r.fpath);
    if (k < 0) return { view: 'sessions' };
    o.file = k;
  }
  return o;
}

function remapSet(set, oldList, newList, keyOf) {
  if (!set.size) return set;
  const pos = new Map(newList.map((x, i) => [keyOf(x), i]));
  const next = new Set();
  for (const i of set) {
    const j = oldList[i] !== undefined ? pos.get(keyOf(oldList[i])) : undefined;
    if (j !== undefined) next.add(j);
  }
  return next;
}

function Loading({ progress, error }) {
  const pct = progress && progress.total ? Math.round((100 * progress.bytesDone) / Math.max(1, progress.bytesTotal)) : null;
  return html`<div class="loading">
    <div class="loading-box">
      <div class="brand big">Токеноскоп</div>
      ${error ? html`<div class="loading-err">${error}</div>` : html`
        <div class="loading-text">${!progress ? 'Ищу транскрипты…'
          : progress.phase === 'build' ? 'Собираю сводку…'
          : `Разбираю транскрипты: ${progress.done} из ${progress.total} файлов`}</div>
        <div class="progress"><div class="progress-fill" style=${{ width: (pct == null ? 8 : Math.max(4, pct)) + '%' }}></div></div>
        <div class="loading-hint">Первый разбор идёт несколько секунд, дальше — из кэша.</div>`}
    </div>
  </div>`;
}

function App() {
  const init = useMemo(loadUiState, []);
  const [ds, setDs] = useState(null);
  const [settings, setSettings] = useState(null);
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [range, setRange] = useState(init.range);
  const [projects, setProjects] = useState(new Set());
  const [models, setModels] = useState(new Set());
  const [kind, setKind] = useState(init.kind);
  const [metric, setMetric] = useState(init.metric);
  const [route, setRoute] = useState({ view: init.view });
  const [history, setHistory] = useState([]);
  const [now, setNow] = useState(Date.now());
  const dsRef = useRef(null);

  const applyDataset = (d) => {
    const old = dsRef.current;
    dsRef.current = d;
    if (old && old !== d) {
      setRoute((r) => remapRoute(r, d));
      setHistory((h) => h.map((r) => remapRoute(r, d)));
      setProjects((s) => remapSet(s, old.projects, d.projects, (p) => p.key));
      setModels((s) => remapSet(s, old.strings.models, d.strings.models, (m) => m));
    }
    setDs(d);
  };

  useEffect(() => {
    const off1 = window.api.onProgress((p) => {
      setProgress(p);
      if (p.phase === 'parse' || p.phase === 'build') setBusy(true);
      if (p.phase === 'done') setBusy(false);
    });
    const off2 = window.api.onDataset((d) => {
      applyDataset(d);
      setBusy(false);
      setNow(Date.now());
    });
    Promise.all([window.api.getSettings(), window.api.getDataset()])
      .then(([s, d]) => {
        setSettings(s);
        applyDataset(d);
        const theme = params.get('theme') || s.theme;
        document.documentElement.dataset.theme = theme === 'light' || theme === 'dark' ? theme : '';
        const sid = params.get('session');
        if (sid) {
          const k = d.sessions.findIndex((x) => x.id.startsWith(sid));
          const open = params.get('open');
          const sess = d.sessions[k];
          if (k >= 0 && open === 'transcript' && sess.mainFile >= 0) setRoute(withKeys({ view: 'transcript', file: sess.mainFile }, d));
          else if (k >= 0 && (open === 'journal' || open === 'script') && sess.runs.length) setRoute(withKeys({ view: open, session: k, run: sess.runs[0].run }, d));
          else if (k >= 0) setRoute(withKeys({ view: 'session', session: k }, d));
        }
        const scroll = +(params.get('scroll') || 0);
        if (scroll) setTimeout(() => { const m = document.querySelector('.main'); if (m) m.scrollTop = scroll; }, 200);
      })
      .catch((e) => setError(String(e && e.message ? e.message : e)));
    const t = setInterval(() => setNow(Date.now()), 60000);
    return () => {
      off1();
      off2();
      clearInterval(t);
    };
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem('ui-state', JSON.stringify({ range, kind, metric, view: route.view }));
    } catch (e) { /* ignore */ }
  }, [range, kind, metric, route.view]);

  const P = useMemo(() => (ds && settings ? prepare(ds, settings.pricing) : null), [ds, settings && settings.pricing]);
  const weekReset = settings ? settings.weekReset : { day: 0, hour: 0 };
  const rng = useMemo(() => rangeFor(range, weekReset, now), [range, weekReset, now]);
  const f = useMemo(() => ({ from: rng.from, to: rng.to, projects, models, kind }), [rng, projects, models, kind]);
  const idx = useMemo(() => (P ? filterRows(P, f) : new Uint32Array(0)), [P, f]);
  const prevIdx = useMemo(() => (P && rng.prev ? filterRows(P, { ...f, from: rng.prev.from, to: rng.prev.to }) : null), [P, f, rng]);

  const go = useCallback((next) => {
    setHistory((h) => [...h.slice(-20), route]);
    setRoute(withKeys(next, dsRef.current));
    const main = document.querySelector('.main');
    if (main) main.scrollTop = 0;
  }, [route]);
  const back = useCallback(() => {
    setHistory((h) => {
      const prev = h[h.length - 1];
      setRoute(prev || { view: 'overview' });
      return h.slice(0, -1);
    });
  }, []);

  const updateSettings = useCallback(async (patch) => {
    const s = await window.api.setSettings(patch);
    setSettings(s);
    if (patch.theme) document.documentElement.dataset.theme = s.theme === 'light' || s.theme === 'dark' ? s.theme : '';
    return s;
  }, []);

  const rescan = useCallback(async (opts) => {
    setBusy(true);
    try {
      const d = await window.api.rescan(opts);
      applyDataset(d);
      setNow(Date.now());
    } finally {
      setBusy(false);
    }
  }, []);

  if (!P) return html`<${Loading} progress=${progress} error=${error} />`;

  const mf = metricFmt(metric);
  const ctx = {
    P, ds, settings, updateSettings, rescan, busy,
    f, rng, idx, prevIdx, now,
    range, setRange, projects, setProjects, models, setModels, kind, setKind,
    metric, setMetric, fmt: mf.fmt, axis: mf.axis,
    route, go, back,
  };

  const projectOptions = ds.projects.map((p, i) => ({ key: i, label: p.name, sub: p.path || '', color: P.projectColors[i] }));
  const modelOptions = ds.strings.models.map((m, i) => ({ key: i, label: m, color: P.modelColors[i] })).filter((o) => o.label !== '?');

  let view;
  switch (route.view) {
    case 'projects': view = html`<${Projects} />`; break;
    case 'sessions': view = html`<${Sessions} />`; break;
    case 'session': view = html`<${SessionDetail} session=${route.session} />`; break;
    case 'workflows': view = html`<${Workflows} />`; break;
    case 'context': view = html`<${ContextView} />`; break;
    case 'tools': view = html`<${Tools} />`; break;
    case 'time': view = html`<${TimeView} />`; break;
    case 'settings': view = html`<${SettingsView} />`; break;
    case 'transcript':
    case 'journal':
    case 'script': view = html`<${Viewer} route=${route} />`; break;
    default: view = html`<${Overview} />`;
  }
  const showFilters = !['settings', 'session', 'transcript', 'journal', 'script'].includes(route.view);
  const scan = ds.meta.scan || {};

  return html`<${AppCtx.Provider} value=${ctx}>
    <div class="layout">
      <aside class="sidebar">
        <div class="brand">Токеноскоп</div>
        <div class="brand-sub">куда уходят токены Claude</div>
        <nav>
          ${NAV.map((n) => html`<button class=${'nav-item' + (route.view === n.key || (n.key === 'sessions' && ['session', 'transcript', 'journal', 'script'].includes(route.view)) ? ' on' : '')}
            onClick=${() => go({ view: n.key })}><span class="nav-icon">${n.icon}</span>${n.label}</button>`)}
        </nav>
        <div class="sidebar-foot">
          <div class=${'live' + (busy ? ' busy' : '')}>${busy ? 'обновляю…' : settings.watch ? 'слежу за изменениями' : 'автообновление выключено'}</div>
          <div class="muted small">${fmtInt(ds.meta.rows)} запросов · ${fmtInt(ds.meta.sessions)} сессий</div>
          <div class="muted small">обновлено ${fmtAgo(ds.meta.generatedAt)}</div>
          <button class="btn small" onClick=${() => rescan()} disabled=${busy} title="Ctrl+R">Обновить</button>
        </div>
      </aside>
      <main class="main">
        ${showFilters && html`<div class="filters">
          <${Segmented} options=${PRESETS} value=${range.preset} onChange=${(p) => setRange({ ...range, preset: p })} />
          ${range.preset === 'custom' && html`<span class="date-range">
            <input type="date" value=${range.from || ''} onInput=${(e) => setRange({ ...range, from: e.target.value || null })} />
            <span class="muted">—</span>
            <input type="date" value=${range.to || ''} onInput=${(e) => setRange({ ...range, to: e.target.value || null })} />
          </span>`}
          <${MultiSelect} label="Проекты" options=${projectOptions} selected=${projects} onChange=${setProjects} />
          <${MultiSelect} label="Модели" options=${modelOptions} selected=${models} onChange=${setModels} width=${260} />
          <${Segmented} options=${KIND_FILTERS} value=${kind} onChange=${setKind} />
        </div>`}
        ${showFilters && html`<div class="filter-summary">
          <span>
            ${idx.length ? `${fmtInt(idx.length)} запросов · ${fmtUsd(sumCost(P, idx))} · ${fmtTok(sumTok(P, idx))} токенов` : 'В выбранном срезе нет запросов'}
            ${scan.errors && scan.errors.length ? html`<span class="warn-text"> · не разобрано файлов: ${scan.errors.length}</span>` : ''}
            ${P.unknownModels.length ? html`<span class="warn-text"> · нет цены для: ${P.unknownModels.join(', ')} (считаю по запасной)</span>` : ''}
          </span>
          <label class="metric-select">Метрика графиков и рейтингов
            <select value=${metric} onChange=${(e) => setMetric(e.target.value)}>
              ${Object.entries(METRICS).map(([k, m]) => html`<option value=${k}>${m.label}</option>`)}
            </select>
          </label>
        </div>`}
        <div class=${'content' + (busy ? ' refreshing' : '')}>${view}</div>
      </main>
    </div>
    <${TooltipLayer} />
  </${AppCtx.Provider}>`;
}

function sumCost(P, idx) {
  let s = 0;
  for (let k = 0; k < idx.length; k++) s += P.cost[idx[k]];
  return s;
}

function sumTok(P, idx) {
  let s = 0;
  for (let k = 0; k < idx.length; k++) s += P.ctx[idx[k]] + P.R.out[idx[k]];
  return s;
}

render(html`<${App} />`, document.getElementById('app'));
