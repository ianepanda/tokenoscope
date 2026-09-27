import { html, useMemo, useState } from '../lib/h.js';
import { useApp } from '../lib/app-context.js';
import { attribution, groupSegments, groupAttribution, heavyPieces, toolStats, GROUP_COLORS, GEN_LABEL } from '../lib/data.js';
import { ShareBar } from '../lib/charts.js';
import { Card, Table, Segmented, Bar } from '../lib/ui.js';
import { fmtUsd, fmtInt, fmtTok, fmtTokShort, fmtPct } from '../lib/format.js';
import { HeavyTable } from './session.js';

export function ContextView() {
  const { P, idx, f, go } = useApp();
  const [by, setBy] = useState('cost');
  const { att, heavy, tools } = useMemo(() => ({
    att: attribution(P, idx),
    heavy: heavyPieces(P, f, { limit: 150 }),
    tools: toolStats(P, f),
  }), [P, idx, f]);
  const groups = groupAttribution(P, att).filter((g) => g.tok > 0);
  const totCost = groups.reduce((s, g) => s + g.cost, 0) + att.gen;
  const totTok = groups.reduce((s, g) => s + g.tok, 0);
  const cats = P.ds.cats.map((c, i) => ({ i, c, cost: att.cost[i], tok: att.tok[i], tool: tools.get(i) })).filter((r) => r.tok > 0);
  const maxCost = Math.max(0, ...cats.map((r) => r.cost));
  const val = (x) => (by === 'cost' ? x.cost : x.tok);
  const fmtV = by === 'cost' ? fmtUsd : fmtTok;

  const catColumns = [
    { key: 'name', label: 'Категория', sort: (r) => r.c.detail, render: (r) => html`<div class="cell-title">
      <span class="legend-key rect" style=${{ background: GROUP_COLORS[r.c.group] || 'var(--other)' }}></span>${r.c.detail}</div>
      <div class="cell-sub">${P.ds.groups[r.c.group]}</div>` },
    { key: 'cost', label: '≈ $', align: 'right', sort: (r) => r.cost, render: (r) => html`${fmtUsd(r.cost)}<${Bar} value=${r.cost} max=${maxCost} color=${GROUP_COLORS[r.c.group] || 'var(--other)'} />` },
    { key: 'share', label: 'Доля', align: 'right', sort: (r) => r.cost, render: (r) => fmtPct(r.cost / (totCost || 1)) },
    { key: 'tok', label: 'Токено-шаги', align: 'right', title: 'Сколько токенов этой категории было перечитано суммарно по всем запросам', sort: (r) => r.tok, render: (r) => fmtTok(r.tok) },
    { key: 'calls', label: 'Вызовов', align: 'right', sort: (r) => (r.tool ? r.tool.calls : 0), render: (r) => (r.tool && r.tool.calls ? fmtInt(r.tool.calls) : '—') },
    { key: 'chars', label: 'Объём результатов', align: 'right', title: 'Символов в результатах инструментов', sort: (r) => (r.tool ? r.tool.chars : 0),
      render: (r) => (r.tool && r.tool.chars ? fmtTokShort(r.tool.chars) + ' симв.' : '—') },
    { key: 'avg', label: 'В среднем', align: 'right', title: 'Средний результат одного вызова', sort: (r) => (r.tool && r.tool.calls ? r.tool.chars / r.tool.calls : 0),
      render: (r) => (r.tool && r.tool.calls && r.tool.chars ? fmtTokShort(r.tool.chars / r.tool.calls) : '—') },
  ];

  const groupTotal = by === 'cost' ? totCost : totTok;
  return html`<div class="view">
    <${Card} title="Из чего складывается расход"
      subtitle="Каждый запрос отправляет весь контекст агента. Входная стоимость запроса разложена по тому, что лежало в контексте в этот момент; генерация ответа — отдельно."
      actions=${html`<${Segmented} small options=${[{ key: 'cost', label: '$' }, { key: 'tok', label: 'Токены' }]} value=${by} onChange=${setBy} />`}>
      <${ShareBar} segments=${groupSegments(P, att, { by, withGen: by === 'cost' })} fmt=${fmtV} height=${18} legend=${false} />
      <div class="context-split">
        <div class="group-list">
          ${groups.sort((a, b) => val(b) - val(a)).map((g) => html`<div class="group-line">
            <span class="legend-key rect" style=${{ background: GROUP_COLORS[g.group] || 'var(--other)' }}></span>
            <span class="gl-label">${g.label}</span>
            <span class="gl-val">${fmtV(val(g))}</span>
            <span class="gl-pct">${fmtPct(val(g) / (groupTotal || 1))}</span>
          </div>`)}
          ${by === 'cost' && html`<div class="group-line">
            <span class="legend-key rect" style=${{ background: GROUP_COLORS.gen }}></span>
            <span class="gl-label">${GEN_LABEL}</span>
            <span class="gl-val">${fmtUsd(att.gen)}</span>
            <span class="gl-pct">${fmtPct(att.gen / (totCost || 1))}</span>
          </div>`}
        </div>
        <div class="explain">
          <p><b>Как считается.</b> Контекст на каждом шаге — это стартовый контекст (системный промпт, описания инструментов, CLAUDE.md) и всё, что пришло потом: результаты инструментов, вставки, сообщения, собственный вывод модели. Размер кусков оценён по символам и откалиброван по реальному размеру контекста из usage этого шага, поэтому доли в сумме дают ровно его входные токены.</p>
          <p><b>Почему дорого.</b> Кусок стоит «его токены × число оставшихся шагов»: файл на 15k токенов, прочитанный на 10-м шаге агента из 200, перечитывается ещё 190 раз.</p>
          <p><b>Серым</b> — группы, не попавшие в первую семёрку цветов; в полосе они сложены в «Прочее».</p>
        </div>
      </div>
    </${Card}>

    <${Card} title="Категории" subtitle=${`${fmtTok(totTok)} токено-шагов · ${fmtUsd(totCost - att.gen)} входной стоимости`}>
      <${Table} columns=${catColumns} rows=${cats} initialSort=${{ key: 'cost', dir: -1 }} rowKey=${(r) => r.i} limit=${40} dense />
    </${Card}>

    <${Card} title="Самые дорогие куски контекста" subtitle="Крупные результаты инструментов, прочитанные файлы и собственный вывод, которые дольше всего ехали в контексте. Щёлкните строку, чтобы открыть это место в транскрипте.">
      <${HeavyTable} P=${P} rows=${heavy} showSession go=${go} limit=${40} />
    </${Card}>
  </div>`;
}
