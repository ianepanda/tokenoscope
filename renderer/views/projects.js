import { html, useMemo } from '../lib/h.js';
import { useApp } from '../lib/app-context.js';
import { sessionStats, newAgg, metricOf, KIND_COLORS, KIND_LABELS, METRICS } from '../lib/data.js';
import { Columns } from '../lib/charts.js';
import { Card, Table, StackCell, Bar } from '../lib/ui.js';
import { fmtUsd, fmtInt, fmtTok, fmtPct, fmtAgo } from '../lib/format.js';
import { useDaily } from './overview.js';

export function Projects() {
  const { P, idx, metric, fmt, go, setProjects } = useApp();
  const daily = useDaily('projects');
  const rows = useMemo(() => {
    const ss = sessionStats(P, idx);
    const map = new Map();
    for (const x of ss.values()) {
      const p = P.ds.sessions[x.session].project;
      let r = map.get(p);
      if (!r) map.set(p, (r = { project: p, all: newAgg(), kinds: [0, 0, 0], sessions: 0, last: 0 }));
      r.sessions++;
      for (const k of Object.keys(r.all)) if (typeof x.all[k] === 'number' && k !== 'first' && k !== 'last' && k !== 'peak') r.all[k] += x.all[k];
      r.last = Math.max(r.last, x.all.last);
      x.kinds.forEach((a, k) => { r.kinds[k] += metricOf(a, metric); });
    }
    return [...map.values()];
  }, [P, idx, metric]);
  const maxV = Math.max(0, ...rows.map((r) => metricOf(r.all, metric)));
  const total = rows.reduce((s, r) => s + metricOf(r.all, metric), 0);

  const columns = [
    {
      key: 'name', label: 'Проект', sort: (r) => P.ds.projects[r.project].name,
      render: (r) => html`<div class="cell-title"><span class="legend-key rect" style=${{ background: P.projectColors[r.project] }}></span>${P.ds.projects[r.project].name}</div>
        <div class="cell-sub">${P.ds.projects[r.project].path || ''}</div>`,
    },
    { key: 'value', label: METRICS[metric].label, align: 'right', sort: (r) => metricOf(r.all, metric),
      render: (r) => html`<div>${fmt(metricOf(r.all, metric))}</div><${Bar} value=${metricOf(r.all, metric)} max=${maxV} />` },
    { key: 'share', label: 'Доля', align: 'right', sort: (r) => metricOf(r.all, metric), render: (r) => fmtPct(metricOf(r.all, metric) / (total || 1)) },
    { key: 'kinds', label: 'Потоки', title: 'Основной поток / субагенты / воркфлоу', sortable: false,
      render: (r) => html`<${StackCell} parts=${r.kinds.map((v, k) => ({ value: v, color: KIND_COLORS[k], title: `${KIND_LABELS[k]}: ${fmt(v)}` }))} />` },
    { key: 'sessions', label: 'Сессий', align: 'right', sort: (r) => r.sessions, render: (r) => fmtInt(r.sessions) },
    { key: 'req', label: 'Запросов', align: 'right', sort: (r) => r.all.req, render: (r) => fmtInt(r.all.req) },
    metric !== 'cost' && { key: 'cost', label: 'Стоимость', align: 'right', sort: (r) => r.all.cost, render: (r) => fmtUsd(r.all.cost) },
    { key: 'tok', label: 'Токены', align: 'right', sort: (r) => r.all.ctx + r.all.out, render: (r) => fmtTok(r.all.ctx + r.all.out) },
    { key: 'hit', label: 'Кэш', align: 'right', title: 'Попадание в кэш', sort: (r) => r.all.cr / (r.all.ctx || 1), render: (r) => fmtPct(r.all.cr / (r.all.ctx || 1), 0) },
    { key: 'last', label: 'Активность', align: 'right', sort: (r) => r.last, render: (r) => fmtAgo(r.last) },
  ].filter(Boolean);

  return html`<div class="view">
    <${Card} title=${`${METRICS[metric].label} по проектам`}>
      <${Columns} buckets=${daily.buckets} series=${daily.series} fmt=${daily.fmt} fmtAxis=${daily.axis} xLabel=${daily.xLabel} tipTitle=${daily.tipTitle} height=${220} />
    </${Card}>
    <${Card} title="Проекты" subtitle="Проект — рабочая папка сессии; worktree'ы сведены к репозиторию. Щёлкните строку, чтобы открыть сессии проекта.">
      <${Table} columns=${columns} rows=${rows} initialSort=${{ key: 'value', dir: -1 }} rowKey=${(r) => r.project}
        onRowClick=${(r) => { setProjects(new Set([r.project])); go({ view: 'sessions' }); }} />
    </${Card}>
  </div>`;
}
