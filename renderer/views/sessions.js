import { html, useMemo, useState } from '../lib/h.js';
import { useApp } from '../lib/app-context.js';
import { sessionStats, metricOf, KIND_COLORS, KIND_LABELS, METRICS } from '../lib/data.js';
import { Card, Table, StackCell, Bar, Pill } from '../lib/ui.js';
import { fmtUsd, fmtInt, fmtTokShort, fmtDateTime, fmtAgo, shortId, fmtDuration } from '../lib/format.js';

export function Sessions() {
  const { P, idx, metric, fmt, go, projects, setProjects } = useApp();
  const [q, setQ] = useState('');
  const stats = useMemo(() => [...sessionStats(P, idx).values()], [P, idx]);
  const rows = useMemo(() => {
    const ql = q.trim().toLowerCase();
    if (!ql) return stats;
    return stats.filter((x) => {
      const s = P.ds.sessions[x.session];
      return (s.title + ' ' + s.id + ' ' + P.ds.projects[s.project].name + ' ' + (s.firstPrompt || '')).toLowerCase().includes(ql);
    });
  }, [stats, q]);
  const maxV = Math.max(0, ...rows.map((r) => metricOf(r.all, metric)));
  const sess = (r) => P.ds.sessions[r.session];

  const columns = [
    {
      key: 'title', label: 'Сессия', sort: (r) => sess(r).title,
      render: (r) => {
        const s = sess(r);
        return html`<div class="cell-title" title=${s.firstPrompt || ''}>${s.title}${s.archived ? html` <${Pill}>архив</${Pill}>` : ''}</div>
          <div class="cell-sub">${P.ds.projects[s.project].name} · ${shortId(s.id)}${s.gitBranch && s.gitBranch !== 'HEAD' ? ' · ' + s.gitBranch : ''}</div>`;
      },
    },
    { key: 'value', label: METRICS[metric].label, align: 'right', sort: (r) => metricOf(r.all, metric),
      render: (r) => html`<div>${fmt(metricOf(r.all, metric))}</div><${Bar} value=${metricOf(r.all, metric)} max=${maxV} />` },
    { key: 'kinds', label: 'Потоки', title: 'Основной поток / субагенты / воркфлоу', sortable: false,
      render: (r) => html`<${StackCell} parts=${r.kinds.map((a, k) => ({ value: metricOf(a, metric), color: KIND_COLORS[k], title: `${KIND_LABELS[k]}: ${fmt(metricOf(a, metric))}` }))} />` },
    metric !== 'cost' && { key: 'cost', label: 'Стоимость', align: 'right', sort: (r) => r.all.cost, render: (r) => fmtUsd(r.all.cost) },
    { key: 'agents', label: 'Агенты', align: 'right', title: 'Субагенты и агенты воркфлоу с запросами в срезе', sort: (r) => r.files.size,
      render: (r) => (r.files.size ? html`${fmtInt(r.files.size)}${r.runs.size ? html`<span class="muted"> · ${r.runs.size} wf</span>` : ''}` : html`<span class="muted">—</span>`) },
    { key: 'req', label: 'Запросов', align: 'right', sort: (r) => r.all.req, render: (r) => fmtInt(r.all.req) },
    { key: 'peak', label: 'Пик', align: 'right', title: 'Максимальный контекст основного потока', sort: (r) => r.mainPeak, render: (r) => (r.mainPeak ? fmtTokShort(r.mainPeak) : '—') },
    { key: 'turns', label: 'Ходов', align: 'right', title: 'Сообщений пользователя за всю сессию', sort: (r) => sess(r).turns, render: (r) => fmtInt(sess(r).turns) },
    { key: 'span', label: 'Длит.', title: 'От первого до последнего запроса в срезе', align: 'right', sort: (r) => r.all.last - r.all.first, render: (r) => fmtDuration(r.all.last - r.all.first) },
    { key: 'last', label: 'Активность', align: 'right', sort: (r) => r.all.last, render: (r) => html`<span title=${`с ${fmtDateTime(r.all.first)}`}>${fmtAgo(r.all.last)}</span>` },
  ].filter(Boolean);

  return html`<div class="view">
    <${Card} title=${`Сессии: ${fmtInt(rows.length)}`}
      subtitle="Суммы — за выбранный период; щёлкните строку, чтобы открыть всю сессию"
      actions=${html`
        ${projects.size ? html`<button class="btn small ghost" onClick=${() => setProjects(new Set())}>Все проекты</button>` : ''}
        <input class="search" placeholder="Поиск по названию, id, проекту…" value=${q} onInput=${(e) => setQ(e.target.value)} />`}>
      <${Table} className="narrow-titles" columns=${columns} rows=${rows} initialSort=${{ key: 'value', dir: -1 }} rowKey=${(r) => r.session}
        onRowClick=${(r) => go({ view: 'session', session: r.session })} limit=${80} />
    </${Card}>
  </div>`;
}
