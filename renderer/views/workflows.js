import { html, useMemo } from '../lib/h.js';
import { useApp } from '../lib/app-context.js';
import { runStats, fileStats, median, KIND_COLORS, sessionTitle, runName } from '../lib/data.js';
import { Card, Tile, Table, Bar } from '../lib/ui.js';
import { HBars } from '../lib/charts.js';
import { fmtUsd, fmtInt, fmtTokShort, fmtDateTime, fmtPct } from '../lib/format.js';

function effortText(map, efforts) {
  const tot = [...map.values()].reduce((s, x) => s + x, 0);
  if (map.size === 1) return efforts[[...map.keys()][0]];
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([e, c]) => `${efforts[e]} ${Math.round((100 * c) / tot)}%`).join(', ');
}

export function Workflows() {
  const { P, idx, go } = useApp();
  const efforts = P.ds.strings.efforts;
  const { runs, agents, byType, tot } = useMemo(() => {
    const runs = runStats(P, idx);
    const fs = fileStats(P, idx);
    const agents = [...fs.entries()].filter(([fi]) => P.ds.files[fi].kind !== 0).map(([fi, a]) => ({ file: fi, f: P.ds.files[fi], agg: a }));
    const byType = new Map();
    for (const a of agents) {
      const t = a.f.kind === 2 ? (a.f.agentType === 'workflow-subagent' || !a.f.agentType ? 'агент воркфлоу' : `${a.f.agentType} (в воркфлоу)`) : (a.f.agentType || 'субагент');
      let x = byType.get(t);
      if (!x) byType.set(t, (x = { type: t, n: 0, cost: 0, steps: [], starts: [], peaks: [] }));
      x.n++;
      x.cost += a.agg.cost;
      x.steps.push(a.agg.req);
      x.starts.push(a.agg.startCtx);
      x.peaks.push(a.agg.peak);
    }
    const tot = agents.reduce((s, a) => s + a.agg.cost, 0);
    return { runs, agents, byType: [...byType.values()], tot };
  }, [P, idx]);

  const wfAgents = agents.filter((a) => a.f.kind === 2);
  const wfCost = runs.reduce((s, r) => s + r.agg.cost, 0);
  const maxRun = Math.max(0, ...runs.map((r) => r.agg.cost));

  const runColumns = [
    { key: 'name', label: 'Прогон', sort: (r) => r.info.name, render: (r) => html`<div class="cell-title">${runName(r.info.name)}</div>
      <div class="cell-sub">${sessionTitle(P, r.session)}${r.info.desc ? ' · ' + r.info.desc : ''}</div>` },
    { key: 'cost', label: 'Стоимость', align: 'right', sort: (r) => r.agg.cost, render: (r) => html`${fmtUsd(r.agg.cost)}<${Bar} value=${r.agg.cost} max=${maxRun} color=${KIND_COLORS[2]} />` },
    { key: 'agents', label: 'Агентов', align: 'right', sort: (r) => r.agents.length, render: (r) => fmtInt(r.agents.length) },
    { key: 'req', label: 'Запросов', align: 'right', sort: (r) => r.agg.req, render: (r) => fmtInt(r.agg.req) },
    { key: 'steps', label: 'Шаги мед / макс', align: 'right', sort: (r) => Math.max(...r.agents.map((a) => a.agg.req)),
      render: (r) => `${fmtInt(median(r.agents.map((a) => a.agg.req)))} / ${fmtInt(Math.max(...r.agents.map((a) => a.agg.req)))}` },
    { key: 'start', label: 'Старт', align: 'right', title: 'Медиана контекста на первом запросе агента', sort: (r) => median(r.agents.map((a) => a.agg.startCtx)),
      render: (r) => fmtTokShort(median(r.agents.map((a) => a.agg.startCtx))) },
    { key: 'peak', label: 'Пик', align: 'right', title: 'Медиана пикового контекста агента', sort: (r) => median(r.agents.map((a) => a.agg.peak)),
      render: (r) => fmtTokShort(median(r.agents.map((a) => a.agg.peak))) },
    { key: 'effort', label: 'Effort', sortable: false, render: (r) => html`<span class="small nowrap">${effortText(r.effort, efforts)}</span>` },
    { key: 'first', label: 'Когда', align: 'right', sort: (r) => r.agg.first, render: (r) => fmtDateTime(r.agg.first) },
  ];

  const typeColumns = [
    { key: 'type', label: 'Тип агента', render: (r) => r.type },
    { key: 'n', label: 'Агентов', align: 'right', render: (r) => fmtInt(r.n) },
    { key: 'cost', label: 'Стоимость', align: 'right', render: (r) => fmtUsd(r.cost) },
    { key: 'share', label: 'Доля', align: 'right', sort: (r) => r.cost, render: (r) => fmtPct(r.cost / (tot || 1)) },
    { key: 'steps', label: 'Шаги мед', align: 'right', sort: (r) => median(r.steps), render: (r) => fmtInt(median(r.steps)) },
    { key: 'start', label: 'Старт мед', align: 'right', sort: (r) => median(r.starts), render: (r) => fmtTokShort(median(r.starts)) },
    { key: 'peak', label: 'Пик мед', align: 'right', sort: (r) => median(r.peaks), render: (r) => fmtTokShort(median(r.peaks)) },
  ];

  const topAgents = agents.slice().sort((a, b) => b.agg.cost - a.agg.cost).slice(0, 12).map((a) => ({
    key: a.file,
    label: a.f.label || a.f.agentType || 'агент',
    sub: `${a.agg.req} шагов · пик ${fmtTokShort(a.agg.peak)} · ${sessionTitle(P, a.f.session)}`,
    value: a.agg.cost,
    color: KIND_COLORS[a.f.kind],
    session: a.f.session,
    file: a.file,
  }));

  return html`<div class="view">
    <div class="tiles">
      <${Tile} hero label="Агенты, в ценах API" value=${fmtUsd(tot)} sub=${`субагенты ${fmtUsd(tot - wfCost)} · воркфлоу ${fmtUsd(wfCost)}`} />
      <${Tile} label="Прогонов воркфлоу" value=${fmtInt(runs.length)} sub=${runs.length ? `~${fmtUsd(wfCost / runs.length)} за прогон` : ''} />
      <${Tile} label="Агентов" value=${fmtInt(agents.length)} sub=${`из них в воркфлоу ${fmtInt(wfAgents.length)}`} />
      <${Tile} label="Шагов у агента" value=${fmtInt(median(agents.map((a) => a.agg.req)))} sub=${`медиана · максимум ${fmtInt(Math.max(0, ...agents.map((a) => a.agg.req)))}`} />
      <${Tile} label="Старт агента" value=${fmtTokShort(median(agents.map((a) => a.agg.startCtx)))} sub="медиана контекста на первом запросе" />
      <${Tile} label="Пик агента" value=${fmtTokShort(median(agents.map((a) => a.agg.peak)))} sub=${`медиана · максимум ${fmtTokShort(Math.max(0, ...agents.map((a) => a.agg.peak)))}`} />
    </div>
    <${Card} title="Прогоны воркфлоу" subtitle="Щёлкните прогон, чтобы открыть его сессию">
      <${Table} columns=${runColumns} rows=${runs} initialSort=${{ key: 'cost', dir: -1 }} rowKey=${(r) => r.key}
        onRowClick=${(r) => go({ view: 'session', session: r.session })} empty="В срезе нет прогонов воркфлоу" />
    </${Card}>
    <div class="grid2">
      <${Card} title="Типы агентов">
        <${Table} columns=${typeColumns} rows=${byType} initialSort=${{ key: 'cost', dir: -1 }} dense empty="Агентов нет" />
      </${Card}>
      <${Card} title="Самые дорогие агенты" subtitle="Щёлкните, чтобы прочитать транскрипт агента">
        <${HBars} items=${topAgents} fmt=${fmtUsd} showShare=${false} onPick=${(it) => go({ view: 'transcript', file: it.file })} empty="Агентов нет" />
      </${Card}>
    </div>
  </div>`;
}
