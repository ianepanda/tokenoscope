import { html, useMemo } from '../lib/h.js';
import { useApp } from '../lib/app-context.js';
import { toolStats, attribution, groupBy, metricOf, KIND_SHORT, METRICS, GROUP_COLORS } from '../lib/data.js';
import { HBars } from '../lib/charts.js';
import { Card, Table, Bar } from '../lib/ui.js';
import { fmtUsd, fmtInt, fmtTok, fmtTokShort, fmtPct } from '../lib/format.js';

export function Tools() {
  const { P, idx, f, metric, fmt } = useApp();
  const d = useMemo(() => {
    const tools = toolStats(P, f);
    const att = attribution(P, idx);
    const skills = groupBy(P, idx, (i) => P.R.skill[i]);
    const mcps = groupBy(P, idx, (i) => P.R.mcp[i]);
    const models = groupBy(P, idx, (i) => P.R.model[i]);
    const effort = groupBy(P, idx, (i) => P.R.effort[i] * 4 + P.rowKind[i]);
    return { tools, att, skills, mcps, models, effort };
  }, [P, idx, f]);

  const toolRows = [...d.tools.values()].filter((t) => t.calls > 0 || t.chars > 0).map((t) => ({ ...t, c: P.ds.cats[t.cat], cost: d.att.cost[t.cat] }));
  const maxCalls = Math.max(0, ...toolRows.map((t) => t.calls));
  const toolColumns = [
    { key: 'name', label: 'Инструмент / категория', sort: (r) => r.c.detail, render: (r) => html`<div class="cell-title">
      <span class="legend-key rect" style=${{ background: GROUP_COLORS[r.c.group] || 'var(--other)' }}></span>${r.c.detail}</div><div class="cell-sub">${P.ds.groups[r.c.group]}</div>` },
    { key: 'calls', label: 'Вызовов', align: 'right', sort: (r) => r.calls, render: (r) => html`${fmtInt(r.calls)}<${Bar} value=${r.calls} max=${maxCalls} />` },
    { key: 'chars', label: 'Объём результатов', align: 'right', sort: (r) => r.chars, render: (r) => fmtTokShort(r.chars) + ' симв.' },
    { key: 'avg', label: 'В среднем', align: 'right', sort: (r) => (r.calls ? r.chars / r.calls : 0), render: (r) => (r.calls ? fmtTokShort(r.chars / r.calls) : '—') },
    { key: 'cost', label: '≈ $ в контексте', align: 'right', title: 'Входная стоимость, приходящаяся на результаты этой категории', sort: (r) => r.cost, render: (r) => fmtUsd(r.cost) },
  ];

  const named = (map, names) => [...map.entries()].filter(([k]) => names[k] !== '—').map(([k, a]) => ({ key: k, label: names[k], agg: a }));
  const skillItems = named(d.skills, P.ds.strings.skills).map((x) => ({ ...x, value: metricOf(x.agg, metric), sub: `${fmtInt(x.agg.req)} запросов` }))
    .sort((a, b) => b.value - a.value).slice(0, 14);
  const mcpItems = named(d.mcps, P.ds.strings.mcps).map((x) => ({ ...x, value: metricOf(x.agg, metric), sub: `${fmtInt(x.agg.req)} запросов` }))
    .sort((a, b) => b.value - a.value).slice(0, 14);

  const modelRows = [...d.models.entries()].map(([m, a]) => ({ m, name: P.ds.strings.models[m], agg: a, price: P.prices[m] }));
  const modelColumns = [
    { key: 'name', label: 'Модель', render: (r) => html`<div class="cell-title"><span class="legend-key rect" style=${{ background: P.modelColors[r.m] }}></span>${r.name}</div>
      <div class="cell-sub">${r.price.known ? `$${r.price.in} / $${r.price.out} за MTok, кэш $${r.price.cr}` : 'цена не задана — запасная'}</div>` },
    { key: 'req', label: 'Запросов', align: 'right', sort: (r) => r.agg.req, render: (r) => fmtInt(r.agg.req) },
    { key: 'cost', label: 'Стоимость', align: 'right', sort: (r) => r.agg.cost, render: (r) => fmtUsd(r.agg.cost) },
    { key: 'cr', label: 'Чтение кэша', align: 'right', sort: (r) => r.agg.cr, render: (r) => fmtTok(r.agg.cr) },
    { key: 'cw', label: 'Запись', align: 'right', sort: (r) => r.agg.cw, render: (r) => fmtTok(r.agg.cw) },
    { key: 'out', label: 'Вывод', align: 'right', sort: (r) => r.agg.out, render: (r) => fmtTok(r.agg.out) },
    { key: 'think', label: 'из них размышления', align: 'right', sort: (r) => r.agg.think, render: (r) => (r.agg.think ? fmtPct(r.agg.think / (r.agg.out || 1), 0) : '—') },
  ];

  // Effort × поток.
  const efforts = P.ds.strings.efforts;
  const effRows = [];
  for (let e = 0; e < efforts.length; e++) {
    const cells = [0, 1, 2].map((k) => d.effort.get(e * 4 + k) || null);
    if (cells.every((c) => !c)) continue;
    effRows.push({ e, name: efforts[e], cells, total: cells.reduce((s, c) => s + (c ? metricOf(c, metric) : 0), 0) });
  }
  const effTotals = [0, 1, 2].map((k) => effRows.reduce((s, r) => s + (r.cells[k] ? metricOf(r.cells[k], metric) : 0), 0));
  const EFF_ORDER = ['max', 'xhigh', 'high', 'medium', 'low', '—'];
  effRows.sort((a, b) => EFF_ORDER.indexOf(a.name) - EFF_ORDER.indexOf(b.name));

  return html`<div class="view">
    <${Card} title="Инструменты" subtitle="Вызовы и объём результатов, которые попали в контекст; ≈$ — сколько входной стоимости пришлось на эти результаты">
      <${Table} columns=${toolColumns} rows=${toolRows} initialSort=${{ key: 'cost', dir: -1 }} rowKey=${(r) => r.cat} limit=${30} dense />
    </${Card}>
    <div class="grid2">
      <${Card} title="Effort по потокам" subtitle=${`${METRICS[metric].label}: доля внутри потока`}>
        <div class="table-wrap"><table class="table dense">
          <thead><tr><th>Effort</th>${KIND_SHORT.map((k) => html`<th class="num">${k}</th>`)}<th class="num">всего</th></tr></thead>
          <tbody>${effRows.map((r) => html`<tr>
            <td>${r.name === '—' ? 'не указан' : r.name}</td>
            ${r.cells.map((c, k) => html`<td class="num">${c ? html`${fmt(metricOf(c, metric))} <span class="muted">${fmtPct(metricOf(c, metric) / (effTotals[k] || 1), 0)}</span>` : html`<span class="muted">—</span>`}</td>`)}
            <td class="num">${fmt(r.total)}</td>
          </tr>`)}</tbody>
        </table></div>
      </${Card}>
      <${Card} title="Модели">
        <${Table} columns=${modelColumns} rows=${modelRows} initialSort=${{ key: 'cost', dir: -1 }} dense />
      </${Card}>
    </div>
    <div class="grid2">
      <${Card} title="Скиллы" subtitle="Запросы, которые Claude Code приписал работе скилла">
        <${HBars} items=${skillItems} fmt=${fmt} showShare=${false} empty="Нет запросов со скиллами" />
      </${Card}>
      <${Card} title="MCP-серверы" subtitle="Запросы, которые Claude Code приписал работе с MCP-сервером">
        <${HBars} items=${mcpItems} fmt=${fmt} showShare=${false} color="var(--s6)" empty="Нет запросов с MCP" />
      </${Card}>
    </div>
  </div>`;
}
