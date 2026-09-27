// Подготовка датасета: стоимость по ценам, индексы строк, фильтры и агрегаты.
export const DAY = 86400000;
export const HOUR = 3600000;

export const KIND_LABELS = ['Основной поток', 'Субагенты', 'Агенты воркфлоу'];
export const KIND_SHORT = ['основной', 'субагенты', 'воркфлоу'];
export const KIND_COLORS = ['var(--s1)', 'var(--s2)', 'var(--s3)'];

// Компоненты стоимости: чтение кэша, запись в кэш, вывод, некэшированный вход.
export const COMPONENTS = [
  { key: 'cCr', tok: 'cr', label: 'Чтение кэша', color: 'var(--s1)' },
  { key: 'cCw', tok: 'cw', label: 'Запись в кэш', color: 'var(--s2)' },
  { key: 'cOut', tok: 'out', label: 'Вывод', color: 'var(--s3)' },
  { key: 'cIn', tok: 'inp', label: 'Вход без кэша', color: 'var(--s4)' },
];

// Группы содержимого контекста: постоянные цвета, остальное — «Прочее».
export const GROUP_COLORS = {
  files: 'var(--s1)',
  start: 'var(--s2)',
  output: 'var(--s3)',
  reminders: 'var(--s4)',
  shell: 'var(--s5)',
  mcp: 'var(--s6)',
  browser: 'var(--s7)',
  gen: 'var(--s8)',
};
export const GROUP_ORDER = ['files', 'start', 'output', 'reminders', 'shell', 'mcp', 'browser', 'gen'];
export const GEN_LABEL = 'Генерация ответа (выходные токены)';

export const METRICS = {
  cost: { label: 'Стоимость API', short: '$', unit: 'usd' },
  tokens: { label: 'Токены всего', short: 'токены', unit: 'tok' },
  cr: { label: 'Чтение кэша', short: 'чтение кэша', unit: 'tok' },
  cw: { label: 'Запись в кэш', short: 'запись в кэш', unit: 'tok' },
  out: { label: 'Вывод', short: 'вывод', unit: 'tok' },
  req: { label: 'Запросы', short: 'запросы', unit: 'int' },
};

export function resolvePrice(model, pricing) {
  const m = String(model || '').replace(/\[[^\]]*\]$/, '').replace(/-\d{8}$/, '');
  let best = null;
  for (const p of pricing.models || []) {
    if (m === p.id || m.startsWith(p.id + '-')) {
      if (!best || p.id.length > best.id.length) best = p;
    }
  }
  const b = best || { id: '?', ...(pricing.fallback || { in: 5, out: 25, cr: 0.5 }) };
  return {
    id: b.id,
    known: !!best,
    in: +b.in || 0,
    out: +b.out || 0,
    cr: +b.cr || 0,
    cw5m: b.cw5m != null ? +b.cw5m : (+b.in || 0) * (pricing.cw5mMult ?? 1.25),
    cw1h: b.cw1h != null ? +b.cw1h : (+b.in || 0) * (pricing.cw1hMult ?? 2),
  };
}

export function prepare(ds, pricing) {
  const n = ds.meta.rows;
  const R = ds.rows;
  const prices = ds.strings.models.map((m) => resolvePrice(m, pricing));
  const fastMult = pricing.fastMult ?? 2;
  const cIn = new Float64Array(n);
  const cCw = new Float64Array(n);
  const cCr = new Float64Array(n);
  const cOut = new Float64Array(n);
  const cost = new Float64Array(n);
  const ctx = new Float64Array(n);
  const rowSession = new Uint32Array(n);
  const rowProject = new Uint32Array(n);
  const rowKind = new Uint8Array(n);
  const files = ds.files;
  const sessions = ds.sessions;
  const fileModelCost = new Map();
  for (let i = 0; i < n; i++) {
    const p = prices[R.model[i]];
    const mult = R.fast[i] ? fastMult : 1;
    cIn[i] = (R.inp[i] * p.in * mult) / 1e6;
    cCw[i] = ((R.cw5m[i] * p.cw5m + R.cw1h[i] * p.cw1h) * mult) / 1e6;
    cCr[i] = (R.cr[i] * p.cr * mult) / 1e6;
    cOut[i] = (R.out[i] * p.out * mult) / 1e6;
    cost[i] = cIn[i] + cCw[i] + cCr[i] + cOut[i];
    ctx[i] = R.inp[i] + R.cw5m[i] + R.cw1h[i] + R.cr[i];
    const f = files[R.file[i]];
    rowSession[i] = f.session;
    rowProject[i] = sessions[f.session].project;
    rowKind[i] = f.kind;
    const key = R.file[i] * 64 + R.model[i];
    fileModelCost.set(key, (fileModelCost.get(key) || 0) + cost[i]);
  }
  // Основная модель файла — для оценки стоимости «тяжёлых» кусков.
  const fileModel = new Int32Array(files.length).fill(-1);
  const fileBest = new Float64Array(files.length);
  for (const [key, c] of fileModelCost) {
    const fi = Math.floor(key / 64);
    if (c >= fileBest[fi]) {
      fileBest[fi] = c;
      fileModel[fi] = key % 64;
    }
  }

  // Постоянные цвета по суммарной стоимости за всё время — не меняются от фильтров.
  const modelTotals = new Float64Array(ds.strings.models.length);
  const projTotals = new Float64Array(ds.projects.length);
  for (let i = 0; i < n; i++) {
    modelTotals[R.model[i]] += cost[i];
    projTotals[rowProject[i]] += cost[i];
  }
  const slotColors = (totals) => {
    const order = [...totals.keys()].sort((a, b) => totals[b] - totals[a]);
    const colors = new Array(totals.length).fill('var(--other)');
    order.slice(0, 7).forEach((k, i) => {
      if (totals[k] > 0) colors[k] = `var(--s${i + 1})`;
    });
    return colors;
  };

  // Одинаковые названия (ветки после rewind) различаем коротким id.
  const titleCount = new Map();
  for (const s of ds.sessions) titleCount.set(s.title, (titleCount.get(s.title) || 0) + 1);
  const dupTitle = ds.sessions.map((s) => titleCount.get(s.title) > 1);

  return {
    ds,
    n,
    R,
    dupTitle,
    pricing,
    prices,
    cIn,
    cCw,
    cCr,
    cOut,
    cost,
    ctx,
    rowSession,
    rowProject,
    rowKind,
    fileModel,
    modelColors: slotColors(modelTotals),
    projectColors: slotColors(projTotals),
    unknownModels: ds.strings.models.filter((m, i) => !prices[i].known && modelTotals[i] > 0 && m !== '?'),
  };
}

// ---------- Периоды ----------

export function startOfDay(t) {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function weekStart(t, reset) {
  const d = new Date(t);
  const c = new Date(d.getFullYear(), d.getMonth(), d.getDate(), reset.hour || 0, 0, 0, 0);
  c.setDate(c.getDate() - ((d.getDay() - (reset.day || 0) + 7) % 7));
  if (c.getTime() > t) c.setDate(c.getDate() - 7);
  return c.getTime();
}

export const PRESETS = [
  { key: 'today', label: 'Сегодня' },
  { key: '7d', label: '7 дней' },
  { key: 'week', label: 'Неделя лимита' },
  { key: '30d', label: '30 дней' },
  { key: 'all', label: 'Всё время' },
  { key: 'custom', label: 'Период…' },
];

export function rangeFor(range, weekReset, now = Date.now()) {
  const d0 = startOfDay(now);
  let from = 0;
  let to = Infinity;
  switch (range.preset) {
    case 'today':
      from = d0;
      to = d0 + DAY;
      break;
    case '7d':
      from = d0 - 6 * DAY;
      to = d0 + DAY;
      break;
    case '30d':
      from = d0 - 29 * DAY;
      to = d0 + DAY;
      break;
    case 'week':
      from = weekStart(now, weekReset);
      to = from + 7 * DAY;
      break;
    case 'custom':
      from = range.from ? startOfDay(range.from) : 0;
      to = range.to ? startOfDay(range.to) + DAY : Infinity;
      break;
    default:
      break;
  }
  // Предыдущий период той же длины и к тому же моменту — чтобы незаконченный период сравнивался честно.
  let prev = null;
  if (from > 0 && isFinite(to)) {
    const len = to - from;
    const until = Math.min(to, now);
    prev = { from: from - len, to: until - len };
  }
  return { from, to, prev };
}

// ---------- Фильтрация ----------

function lowerBound(arr, v) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export const KIND_FILTERS = [
  { key: 'all', label: 'Все потоки' },
  { key: 'main', label: 'Основные' },
  { key: 'sub', label: 'Субагенты' },
  { key: 'wf', label: 'Воркфлоу' },
];
const KIND_CODE = { main: 0, sub: 1, wf: 2 };

// Индексы строк, прошедших фильтр. f: {from, to, projects:Set|null, models:Set|null, kind, session}
export function filterRows(P, f) {
  const R = P.R;
  const lo = f.from > 0 ? lowerBound(R.ts, f.from) : 0;
  const hi = isFinite(f.to) ? lowerBound(R.ts, f.to) : P.n;
  const out = new Uint32Array(Math.max(0, hi - lo));
  const kind = f.kind && f.kind !== 'all' ? KIND_CODE[f.kind] : -1;
  const projects = f.projects && f.projects.size ? f.projects : null;
  const models = f.models && f.models.size ? f.models : null;
  const session = f.session != null ? f.session : -1;
  let k = 0;
  for (let i = lo; i < hi; i++) {
    if (kind >= 0 && P.rowKind[i] !== kind) continue;
    if (projects && !projects.has(P.rowProject[i])) continue;
    if (models && !models.has(R.model[i])) continue;
    if (session >= 0 && P.rowSession[i] !== session) continue;
    out[k++] = i;
  }
  return out.subarray(0, k);
}

// ---------- Агрегаты ----------

export function newAgg() {
  return { req: 0, inp: 0, cw: 0, cr: 0, out: 0, think: 0, ctx: 0, cost: 0, cIn: 0, cCw: 0, cCr: 0, cOut: 0, first: 0, last: 0, peak: 0 };
}

export function addRow(a, P, i) {
  const R = P.R;
  a.req++;
  a.inp += R.inp[i];
  a.cw += R.cw5m[i] + R.cw1h[i];
  a.cr += R.cr[i];
  a.out += R.out[i];
  a.think += R.think[i];
  a.ctx += P.ctx[i];
  a.cost += P.cost[i];
  a.cIn += P.cIn[i];
  a.cCw += P.cCw[i];
  a.cCr += P.cCr[i];
  a.cOut += P.cOut[i];
  const t = R.ts[i];
  if (!a.first || t < a.first) a.first = t;
  if (t > a.last) a.last = t;
  if (P.ctx[i] > a.peak) a.peak = P.ctx[i];
}

export function metricOf(a, metric) {
  switch (metric) {
    case 'cost': return a.cost;
    case 'tokens': return a.ctx + a.out;
    case 'cr': return a.cr;
    case 'cw': return a.cw;
    case 'out': return a.out;
    case 'req': return a.req;
    default: return a.cost;
  }
}

export function rowMetric(P, i, metric) {
  const R = P.R;
  switch (metric) {
    case 'cost': return P.cost[i];
    case 'tokens': return P.ctx[i] + R.out[i];
    case 'cr': return R.cr[i];
    case 'cw': return R.cw5m[i] + R.cw1h[i];
    case 'out': return R.out[i];
    case 'req': return 1;
    default: return P.cost[i];
  }
}

export function totals(P, idx) {
  const a = newAgg();
  for (let k = 0; k < idx.length; k++) addRow(a, P, idx[k]);
  return a;
}

// Группировка по ключу строки: keyOf(i) -> число/строка.
export function groupBy(P, idx, keyOf) {
  const m = new Map();
  for (let k = 0; k < idx.length; k++) {
    const i = idx[k];
    const key = keyOf(i);
    let a = m.get(key);
    if (!a) m.set(key, (a = newAgg()));
    addRow(a, P, i);
  }
  return m;
}

// Столбцы по дням/часам: [{t, values:[по сериям]}]; add(values, i) раскладывает строку по сериям.
export function timeBuckets(P, idx, { from, to, bucket = 'day', nSeries = 1, add }) {
  const R = P.R;
  if (!idx.length) return [];
  let start = isFinite(from) && from > 0 ? from : R.ts[idx[0]];
  const end = isFinite(to) ? Math.min(to, Date.now() + HOUR) : R.ts[idx[idx.length - 1]] + 1;
  start = bucket === 'hour' ? Math.floor(start / HOUR) * HOUR : startOfDay(start);
  const keyOf = bucket === 'hour' ? (t) => Math.floor(t / HOUR) * HOUR : (t) => startOfDay(t);
  const next = bucket === 'hour' ? (t) => t + HOUR : (t) => startOfDay(t + DAY + HOUR);
  const buckets = new Map();
  for (let t = start; t < end; t = next(t)) buckets.set(t, { t, values: new Float64Array(nSeries) });
  for (let k = 0; k < idx.length; k++) {
    const i = idx[k];
    const key = keyOf(R.ts[i]);
    let b = buckets.get(key);
    if (!b) buckets.set(key, (b = { t: key, values: new Float64Array(nSeries) }));
    add(b.values, i);
  }
  return [...buckets.values()].sort((a, b) => a.t - b.t);
}

// Разбивка столбцов: компоненты стоимости, потоки, модели, проекты.
export const SPLITS = [
  { key: 'components', label: 'Компоненты' },
  { key: 'kinds', label: 'Потоки' },
  { key: 'models', label: 'Модели' },
  { key: 'projects', label: 'Проекты' },
];

export function splitSeries(P, split, metric) {
  const R = P.R;
  if (split === 'components' && metric !== 'req') {
    const money = metric === 'cost';
    return {
      series: COMPONENTS.map((c) => ({ label: c.label, color: c.color })),
      add: money
        ? (v, i) => { v[0] += P.cCr[i]; v[1] += P.cCw[i]; v[2] += P.cOut[i]; v[3] += P.cIn[i]; }
        : (v, i) => { v[0] += R.cr[i]; v[1] += R.cw5m[i] + R.cw1h[i]; v[2] += R.out[i]; v[3] += R.inp[i]; },
      fmtOverride: money ? null : 'tok',
    };
  }
  if (split === 'models' || split === 'projects') {
    const colors = split === 'models' ? P.modelColors : P.projectColors;
    const names = split === 'models' ? P.ds.strings.models : P.ds.projects.map((p) => p.name);
    // Слоты 1..7 в порядке слотов, затем «Прочие».
    const slots = [];
    colors.forEach((c, k) => {
      const m = /--s(\d)/.exec(c);
      if (m) slots[+m[1] - 1] = k;
    });
    const series = [];
    const map = new Int32Array(colors.length).fill(-1);
    slots.forEach((k) => {
      if (k == null) return;
      map[k] = series.length;
      series.push({ label: names[k], color: colors[k] });
    });
    const otherIdx = series.length;
    series.push({ label: 'Прочие', color: 'var(--other)' });
    const keyArr = split === 'models' ? R.model : P.rowProject;
    return {
      series,
      add: (v, i) => {
        const s = map[keyArr[i]];
        v[s >= 0 ? s : otherIdx] += rowMetric(P, i, metric);
      },
    };
  }
  return {
    series: KIND_LABELS.map((l, k) => ({ label: l, color: KIND_COLORS[k] })),
    add: (v, i) => { v[P.rowKind[i]] += rowMetric(P, i, metric); },
  };
}

// Состав контекста: каждая строка раскладывает свою входную стоимость по долям категорий.
export function attribution(P, idx) {
  const cats = P.ds.cats;
  const A = P.ds.attr;
  const R = P.R;
  const tok = new Float64Array(cats.length);
  const cost = new Float64Array(cats.length);
  let gen = 0;
  let genTok = 0;
  for (let k = 0; k < idx.length; k++) {
    const i = idx[k];
    gen += P.cOut[i];
    genTok += R.out[i];
    const ctx = P.ctx[i];
    if (!ctx) continue;
    const perTok = (P.cIn[i] + P.cCw[i] + P.cCr[i]) / ctx;
    for (let j = R.aOff[i], e = R.aOff[i + 1]; j < e; j++) {
      const c = A.cat[j];
      const t = A.tok[j];
      tok[c] += t;
      cost[c] += t * perTok;
    }
  }
  return { tok, cost, gen, genTok };
}

export function groupAttribution(P, att) {
  const g = new Map();
  P.ds.cats.forEach((c, i) => {
    let x = g.get(c.group);
    if (!x) g.set(c.group, (x = { group: c.group, label: P.ds.groups[c.group] || c.group, tok: 0, cost: 0 }));
    x.tok += att.tok[i];
    x.cost += att.cost[i];
  });
  return [...g.values()];
}

// Сегменты для полосы долей: фиксированные группы по порядку слотов, остальное — «Прочее».
export function groupSegments(P, att, { withGen = true, by = 'cost' } = {}) {
  const groups = groupAttribution(P, att);
  const segs = [];
  let other = 0;
  const byKey = new Map(groups.map((g) => [g.group, g]));
  for (const key of GROUP_ORDER) {
    if (key === 'gen') {
      if (withGen) segs.push({ key, label: GEN_LABEL, value: by === 'cost' ? att.gen : att.genTok, color: GROUP_COLORS.gen });
      continue;
    }
    const g = byKey.get(key);
    if (g) segs.push({ key, label: g.label, value: by === 'cost' ? g.cost : g.tok, color: GROUP_COLORS[key] });
  }
  for (const g of groups) if (!GROUP_COLORS[g.group]) other += by === 'cost' ? g.cost : g.tok;
  if (other > 0) segs.push({ key: 'other', label: 'Прочее', value: other, color: 'var(--other)' });
  return segs;
}

// Сессии в выборке: итоги по потокам, пик контекста основного потока, агенты и прогоны.
export function sessionStats(P, idx) {
  const map = new Map();
  const files = P.ds.files;
  for (let k = 0; k < idx.length; k++) {
    const i = idx[k];
    const s = P.rowSession[i];
    let x = map.get(s);
    if (!x) {
      x = { session: s, all: newAgg(), kinds: [newAgg(), newAgg(), newAgg()], files: new Set(), runs: new Set(), mainPeak: 0 };
      map.set(s, x);
    }
    addRow(x.all, P, i);
    const kind = P.rowKind[i];
    addRow(x.kinds[kind], P, i);
    const fi = P.R.file[i];
    if (kind !== 0) x.files.add(fi);
    if (kind === 2 && files[fi].run) x.runs.add(files[fi].run);
    if (kind === 0 && P.ctx[i] > x.mainPeak) x.mainPeak = P.ctx[i];
  }
  return map;
}

export function fileStats(P, idx) {
  const map = new Map();
  for (let k = 0; k < idx.length; k++) {
    const i = idx[k];
    const fi = P.R.file[i];
    let a = map.get(fi);
    if (!a) {
      a = newAgg();
      a.startCtx = P.ctx[i];
      a.effort = new Map();
      map.set(fi, a);
    }
    addRow(a, P, i);
    const e = P.R.effort[i];
    a.effort.set(e, (a.effort.get(e) || 0) + 1);
  }
  return map;
}

// Прогоны воркфлоу в выборке.
export function runStats(P, idx) {
  const fs = fileStats(P, idx);
  const runs = new Map();
  for (const [fi, a] of fs) {
    const f = P.ds.files[fi];
    if (f.kind !== 2 || !f.run) continue;
    const key = f.session + '|' + f.run;
    let r = runs.get(key);
    if (!r) {
      const sess = P.ds.sessions[f.session];
      const info = sess.runs.find((x) => x.run === f.run) || { run: f.run, name: f.run };
      r = { key, session: f.session, run: f.run, info, agg: newAgg(), agents: [], phases: new Map(), effort: new Map() };
      runs.set(key, r);
    }
    r.agents.push({ file: fi, agg: a });
    for (const k of Object.keys(r.agg)) if (typeof a[k] === 'number' && k !== 'first' && k !== 'last' && k !== 'peak') r.agg[k] += a[k];
    r.agg.first = r.agg.first ? Math.min(r.agg.first, a.first) : a.first;
    r.agg.last = Math.max(r.agg.last, a.last);
    r.agg.peak = Math.max(r.agg.peak, a.peak);
    if (f.phase) r.phases.set(f.phase, (r.phases.get(f.phase) || 0) + 1);
    for (const [e, c] of a.effort) r.effort.set(e, (r.effort.get(e) || 0) + c);
  }
  return [...runs.values()];
}

export function median(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function quantile(xs, q) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * q))];
}

// «Тяжёлые» куски контекста в выборке (фильтр по файлам и времени прихода куска).
export function heavyPieces(P, f, { limit = 50, session = null } = {}) {
  const files = P.ds.files;
  const sessions = P.ds.sessions;
  const kind = f.kind && f.kind !== 'all' ? KIND_CODE[f.kind] : -1;
  const out = [];
  for (const h of P.ds.heavy) {
    const file = files[h.file];
    if (session != null) {
      if (file.session !== session) continue;
    } else {
      if (h.ts && (h.ts < f.from || h.ts >= f.to)) continue;
      if (kind >= 0 && file.kind !== kind) continue;
      if (f.projects && f.projects.size && !f.projects.has(sessions[file.session].project)) continue;
      if (f.models && f.models.size && !f.models.has(P.fileModel[h.file])) continue;
    }
    const mi = P.fileModel[h.file];
    const cr = mi >= 0 ? P.prices[mi].cr : 0.5;
    out.push({ ...h, costEst: (h.tokSteps * cr) / 1e6 });
  }
  out.sort((a, b) => b.tokSteps - a.tokSteps);
  return out.slice(0, limit);
}

// Статистика инструментов по часовым корзинам.
export function toolStats(P, f, { session = null } = {}) {
  const T = P.ds.tools;
  const files = P.ds.files;
  const sessions = P.ds.sessions;
  const kind = f.kind && f.kind !== 'all' ? KIND_CODE[f.kind] : -1;
  const fromH = f.from > 0 ? Math.floor(f.from / HOUR) : 0;
  const toH = isFinite(f.to) ? Math.ceil(f.to / HOUR) : Infinity;
  const byCat = new Map();
  for (let i = 0; i < T.file.length; i++) {
    const file = files[T.file[i]];
    if (session != null) {
      if (file.session !== session) continue;
    } else {
      if (T.hour[i] < fromH || T.hour[i] >= toH) continue;
      if (kind >= 0 && file.kind !== kind) continue;
      if (f.projects && f.projects.size && !f.projects.has(sessions[file.session].project)) continue;
    }
    const c = T.cat[i];
    let x = byCat.get(c);
    if (!x) byCat.set(c, (x = { cat: c, calls: 0, chars: 0 }));
    x.calls += T.calls[i];
    x.chars += T.chars[i];
  }
  return byCat;
}

// Тепловая карта: день недели (пн..вс) × час.
export function heatmap(P, idx, metric) {
  const grid = Array.from({ length: 7 }, () => new Float64Array(24));
  for (let k = 0; k < idx.length; k++) {
    const i = idx[k];
    const d = new Date(P.R.ts[i]);
    grid[(d.getDay() + 6) % 7][d.getHours()] += rowMetric(P, i, metric);
  }
  return grid;
}

// Пятичасовые окна в духе лимитов подписки: окно начинается с часа первого запроса.
export function fiveHourBlocks(P, idx) {
  const blocks = [];
  let cur = null;
  for (let k = 0; k < idx.length; k++) {
    const i = idx[k];
    const t = P.R.ts[i];
    if (!cur || t >= cur.end) {
      const start = Math.floor(t / HOUR) * HOUR;
      cur = { start, end: start + 5 * HOUR, agg: newAgg() };
      blocks.push(cur);
    }
    addRow(cur.agg, P, i);
  }
  return blocks;
}

export function limitWeeks(P, idx, reset) {
  const m = new Map();
  for (let k = 0; k < idx.length; k++) {
    const i = idx[k];
    const w = weekStart(P.R.ts[i], reset);
    let a = m.get(w);
    if (!a) m.set(w, (a = newAgg()));
    addRow(a, P, i);
  }
  return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([t, agg]) => ({ t, agg }));
}

export function catLabel(P, c) {
  const cat = P.ds.cats[c];
  return cat ? cat.detail : '?';
}

export function projectName(P, pIdx) {
  const p = P.ds.projects[pIdx];
  return p ? p.name : '?';
}

// Название сессии для подписей: у тёзок добавляется короткий id.
export function sessionTitle(P, k) {
  const s = P.ds.sessions[k];
  if (!s) return '?';
  return P.dupTitle[k] ? `${s.title} · ${s.id.slice(0, 8)}` : s.title;
}

// Имя прогона без хвоста «-wf_<id>» и расширения.
export function runName(name) {
  return String(name || '').replace(/\.js$/i, '').replace(/-wf_[a-z0-9-]+$/i, '') || name;
}
