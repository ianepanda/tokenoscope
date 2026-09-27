import { html, useMemo, useState } from '../lib/h.js';
import { useApp } from '../lib/app-context.js';
import {
  filterRows, totals, groupBy, fileStats, runStats, attribution, groupSegments, heavyPieces, toolStats,
  timeBuckets, KIND_LABELS, KIND_COLORS, DAY, median, catLabel, sessionTitle, runName,
} from '../lib/data.js';
import { Columns, LineChart, ShareBar } from '../lib/charts.js';
import { Card, Tile, Table, Pill, Bar } from '../lib/ui.js';
import {
  fmtUsd, fmtInt, fmtTok, fmtTokShort, fmtPct, fmtDateTime, fmtDuration, fmtDay, fmtTime, fmtWeekday, shortId,
} from '../lib/format.js';
import { dropEmptySeries } from './overview.js';

function effortSummary(map, efforts) {
  const tot = [...map.values()].reduce((s, x) => s + x, 0);
  if (map.size === 1) return efforts[[...map.keys()][0]];
  return [...map.entries()].sort((a, b) => b[1] - a[1])
    .map(([e, c]) => `${efforts[e]} ${Math.round((100 * c) / tot)}%`).join(', ');
}

export function SessionDetail({ session }) {
  const { P, back, go } = useApp();
  const s = P.ds.sessions[session];
  const [expanded, setExpanded] = useState(new Set());
  const data = useMemo(() => {
    const idx = filterRows(P, { from: 0, to: Infinity, session });
    const tot = totals(P, idx);
    const kinds = groupBy(P, idx, (i) => P.rowKind[i]);
    const models = groupBy(P, idx, (i) => P.R.model[i]);
    const fstats = fileStats(P, idx);
    const runs = runStats(P, idx);
    const att = attribution(P, idx);
    const heavy = heavyPieces(P, {}, { session, limit: 25 });
    const tools = toolStats(P, {}, { session });
    const main = [];
    let step = 0;
    for (let k = 0; k < idx.length; k++) {
      const i = idx[k];
      if (P.rowKind[i] !== 0) continue;
      main.push({ x: step++, y: P.ctx[i], t: P.R.ts[i], cost: P.cost[i] });
    }
    const span = tot.last - tot.first;
    const bucket = span <= 3 * DAY ? 'hour' : 'day';
    const raw = timeBuckets(P, idx, { from: 0, to: Infinity, bucket, nSeries: 3, add: (v, i) => { v[P.rowKind[i]] += P.cost[i]; } });
    const cols = dropEmptySeries(raw, KIND_LABELS.map((l, k) => ({ label: l, color: KIND_COLORS[k] })));
    return { idx, tot, kinds, models, fstats, runs, att, heavy, tools, main, bucket, cols };
  }, [P, session]);
  if (!s) return html`<div class="view"><button class="btn" onClick=${back}>← Назад</button></div>`;
  const { tot, kinds, models, fstats, runs, att, heavy, tools, main, bucket, cols } = data;
  const files = P.ds.files;
  const kindCost = (k) => (kinds.get(k) ? kinds.get(k).cost : 0);
  const mainFile = s.mainFile >= 0 ? files[s.mainFile] : null;
  const markers = s.compactions.map((c) => {
    const at = main.findIndex((p) => p.t >= c.ts);
    return { x: at >= 0 ? main[at].x : (main.length ? main[main.length - 1].x : 0), label: c.trigger === 'manual' ? 'компакт' : 'автокомпакт' };
  });

  // Треды: основной поток, субагенты, прогоны воркфлоу (раскрываются до агентов).
  const threadRows = [];
  if (fstats.has(s.mainFile)) threadRows.push({ type: 'main', label: 'Основной поток', agg: fstats.get(s.mainFile), file: s.mainFile });
  for (const [fi, a] of fstats) {
    if (files[fi].kind === 1) threadRows.push({ type: 'sub', label: files[fi].label || files[fi].agentType || 'субагент', agentType: files[fi].agentType, agg: a, file: fi });
  }
  for (const r of runs) threadRows.push({ type: 'run', run: r, label: r.info.name, agg: r.agg });
  threadRows.sort((a, b) => (a.type === 'main' ? -1 : b.type === 'main' ? 1 : b.agg.cost - a.agg.cost));
  const maxThread = Math.max(0, ...threadRows.map((r) => r.agg.cost));

  const catRows = P.ds.cats.map((c, i) => ({ i, c, cost: att.cost[i], tok: att.tok[i], tool: tools.get(i) }))
    .filter((r) => r.tok > 0).sort((a, b) => b.cost - a.cost);
  const attTotal = catRows.reduce((x, r) => x + r.cost, 0) + att.gen;
  const efforts = P.ds.strings.efforts;
  const effortMap = new Map();
  for (let k = 0; k < data.idx.length; k++) {
    const e = P.R.effort[data.idx[k]];
    effortMap.set(e, (effortMap.get(e) || 0) + 1);
  }

  const toggle = (key) => {
    const n = new Set(expanded);
    if (n.has(key)) n.delete(key);
    else n.add(key);
    setExpanded(n);
  };

  return html`<div class="view">
    <div class="detail-head">
      <button class="btn ghost" onClick=${back}>← Назад</button>
      <div class="detail-titles">
        <h1>${s.title}</h1>
        <div class="detail-meta">
          <span title=${s.cwd || ''}>${P.ds.projects[s.project].name}</span>
          <span class="mono clickable" title="Скопировать id сессии" onClick=${() => window.api.copyText(s.id)}>${shortId(s.id)} ⧉</span>
          ${s.gitBranch && s.gitBranch !== 'HEAD' && html`<span>ветка ${s.gitBranch}</span>`}
          <span>${fmtDateTime(tot.first)} — ${fmtDateTime(tot.last)}</span>
          <span>${fmtInt(s.turns)} ходов</span>
          <span>${[...models.keys()].map((m) => P.ds.strings.models[m]).join(', ')}</span>
          ${effortMap.size ? html`<span>effort: ${effortSummary(effortMap, efforts)}</span>` : ''}
          ${s.archived && html`<${Pill}>в архиве Desktop</${Pill}>`}
          ${s.accounts && s.accounts.length > 1 && html`<${Pill}>в сайдбаре ${s.accounts.length} аккаунтов</${Pill}>`}
        </div>
        ${(s.prLinks.length || s.artifacts.length) ? html`<div class="detail-links">
          ${s.prLinks.map((p) => html`<a class="link" onClick=${() => window.api.openExternal(p.url)}>MR !${p.number} ${p.repo || ''}</a>`)}
          ${s.artifacts.map((a) => html`<a class="link" onClick=${() => window.api.openExternal(a.url)}>◧ ${a.title || 'артефакт'}</a>`)}
        </div>` : ''}
      </div>
      ${mainFile && html`<div class="head-actions">
        <button class="btn small primary" onClick=${() => go({ view: 'transcript', file: s.mainFile })}>Читать транскрипт</button>
        <button class="btn small" onClick=${() => window.api.showInFolder(mainFile.path)}>Файл в папке</button>
      </div>`}
    </div>
    <div class="note">Показана вся сессия — фильтры периода, проекта и модели здесь не действуют.</div>

    <div class="tiles">
      <${Tile} hero label="Стоимость в ценах API" value=${fmtUsd(tot.cost)} sub=${`вывод ${fmtUsd(tot.cOut)} · чтение кэша ${fmtUsd(tot.cCr)} · запись ${fmtUsd(tot.cCw)}`} />
      <${Tile} label="Основной поток" value=${fmtUsd(kindCost(0))} sub=${fmtPct(kindCost(0) / (tot.cost || 1), 0) + ' расхода'} />
      <${Tile} label="Агенты" value=${fmtUsd(kindCost(1) + kindCost(2))} sub=${`${fmtInt([...fstats.keys()].filter((fi) => files[fi].kind !== 0).length)} агентов · ${runs.length} прогонов`} />
      <${Tile} label="Запросов" value=${fmtInt(tot.req)} sub=${fmtDuration(tot.last - tot.first)} />
      <${Tile} label="Пик контекста" value=${fmtTokShort(main.length ? Math.max(...main.map((p) => p.y)) : tot.peak)}
        sub=${s.compactions.length ? `${s.compactions.length} компакт.` : 'без компактов'} />
      <${Tile} label="Попадание в кэш" value=${fmtPct(tot.cr / (tot.ctx || 1))} sub=${`${fmtTok(tot.ctx + tot.out)} токенов`} />
    </div>

    <div class="grid2">
      <${Card} title="Контекст основного потока" subtitle="Размер контекста на каждом запросе; каждый запрос перечитывает его целиком">
        <${LineChart} points=${main} fmtY=${fmtTokShort} yLabel="контекст" markers=${markers} height=${230}
          xTip=${(p) => `Запрос ${p.x + 1} · ${fmtDateTime(p.t)}`}
          xAxis=${(x0, x1, pw) => {
            const n = Math.max(2, Math.floor(pw / 90));
            const out = [];
            for (let k = 0; k <= n; k++) {
              const x = Math.round(x0 + ((x1 - x0) * k) / n);
              out.push({ x, label: String(x + 1) });
            }
            return out;
          }} />
      </${Card}>
      <${Card} title=${`Расход по ${bucket === 'hour' ? 'часам' : 'дням'}`}>
        <${Columns} buckets=${cols.buckets} series=${cols.series} fmt=${fmtUsd} height=${230}
          xLabel=${bucket === 'hour' ? fmtTime : fmtDay}
          tipTitle=${bucket === 'hour' ? (b) => `${fmtWeekday(b.t)}, ${fmtTime(b.t)}` : (b) => fmtWeekday(b.t)} />
      </${Card}>
    </div>

    <${Card} title="Потоки сессии" subtitle="Щёлкните поток, чтобы прочитать его транскрипт; прогон воркфлоу сначала раскрывается до агентов">
      <div class="table-wrap"><table class="table threads">
        <thead><tr>
          <th>Поток</th><th class="num">Стоимость</th><th class="num">Запросов</th><th class="num">Агентов</th>
          <th class="num" title="Медиана / максимум запросов на агента">Шаги</th>
          <th class="num" title="Контекст на первом запросе (медиана по агентам)">Старт</th>
          <th class="num" title="Пиковый контекст (медиана по агентам)">Пик</th><th>Effort</th>
        </tr></thead>
        <tbody>
          ${threadRows.map((r) => {
            if (r.type !== 'run') {
              return html`<tr class="clickable" onClick=${() => go({ view: 'transcript', file: r.file })} title="Открыть транскрипт">
                <td><div class="cell-title"><span class="legend-key rect" style=${{ background: KIND_COLORS[r.type === 'main' ? 0 : 1] }}></span>${r.label}<span class="read-link">читать →</span></div>
                  ${r.agentType && r.agentType !== r.label && html`<div class="cell-sub">${r.agentType}</div>`}</td>
                <td class="num">${fmtUsd(r.agg.cost)}<${Bar} value=${r.agg.cost} max=${maxThread} /></td>
                <td class="num">${fmtInt(r.agg.req)}</td><td class="num muted">—</td>
                <td class="num">${fmtInt(r.agg.req)}</td>
                <td class="num">${fmtTokShort(r.agg.startCtx)}</td><td class="num">${fmtTokShort(r.agg.peak)}</td>
                <td class="small nowrap">${effortSummary(r.agg.effort, efforts)}</td>
              </tr>`;
            }
            const run = r.run;
            const steps = run.agents.map((a) => a.agg.req);
            const open = expanded.has(run.key);
            const stop = (fn) => (e) => { e.stopPropagation(); fn(); };
            return html`
              <tr class="clickable run-row" onClick=${() => toggle(run.key)} title=${open ? 'Свернуть' : 'Показать агентов прогона'}>
                <td><div class="cell-title"><span class="caret">${open ? '▾' : '▸'}</span><span class="legend-key rect" style=${{ background: KIND_COLORS[2] }}></span>${runName(run.info.name)}
                    ${run.info.journal && html`<a class="read-link always" onClick=${stop(() => go({ view: 'journal', session, run: run.run }))}>журнал</a>`}
                    ${run.info.script && html`<a class="read-link always" onClick=${stop(() => go({ view: 'script', session, run: run.run }))}>скрипт</a>`}
                  </div>
                  <div class="cell-sub" title=${run.info.desc || ''}>${run.info.desc || run.run}${run.phases.size ? ' · фазы: ' + [...run.phases.keys()].join(', ') : ''}</div></td>
                <td class="num">${fmtUsd(run.agg.cost)}<${Bar} value=${run.agg.cost} max=${maxThread} color=${KIND_COLORS[2]} /></td>
                <td class="num">${fmtInt(run.agg.req)}</td><td class="num">${fmtInt(run.agents.length)}</td>
                <td class="num">${fmtInt(median(steps))} / ${fmtInt(Math.max(...steps))}</td>
                <td class="num">${fmtTokShort(median(run.agents.map((a) => a.agg.startCtx)))}</td>
                <td class="num">${fmtTokShort(median(run.agents.map((a) => a.agg.peak)))}</td>
                <td class="small nowrap">${effortSummary(run.effort, efforts)}</td>
              </tr>
              ${open && run.agents.slice().sort((a, b) => b.agg.cost - a.agg.cost).map((a) => html`<tr class="sub-row clickable" onClick=${() => go({ view: 'transcript', file: a.file })} title="Открыть транскрипт агента">
                <td><div class="cell-title indent">${files[a.file].label || files[a.file].agentType}<span class="read-link">читать →</span></div>
                  <div class="cell-sub indent">${files[a.file].phase || ''}${files[a.file].agentType && files[a.file].agentType !== 'workflow-subagent' ? ' · ' + files[a.file].agentType : ''}</div></td>
                <td class="num">${fmtUsd(a.agg.cost)}</td><td class="num">${fmtInt(a.agg.req)}</td><td></td>
                <td class="num">${fmtInt(a.agg.req)}</td><td class="num">${fmtTokShort(a.agg.startCtx)}</td><td class="num">${fmtTokShort(a.agg.peak)}</td>
                <td class="small nowrap">${effortSummary(a.agg.effort, efforts)}</td>
              </tr>`)}`;
          })}
        </tbody>
      </table></div>
    </${Card}>

    <div class="grid2">
      <${Card} title="На что ушли деньги" subtitle="Входная стоимость по содержимому контекста + генерация ответа">
        <${ShareBar} segments=${groupSegments(P, att)} fmt=${fmtUsd} />
      </${Card}>
      <${Card} title="Категории контекста">
        <${Table} dense rows=${catRows} rowKey=${(r) => r.i} limit=${14} initialSort=${{ key: 'cost', dir: -1 }} columns=${[
          { key: 'name', label: 'Что', sort: (r) => r.c.detail, render: (r) => html`<div class="cell-title">${r.c.detail}</div><div class="cell-sub">${P.ds.groups[r.c.group]}</div>` },
          { key: 'cost', label: '≈ $', align: 'right', render: (r) => fmtUsd(r.cost) },
          { key: 'share', label: 'Доля', align: 'right', sort: (r) => r.cost, render: (r) => fmtPct(r.cost / (attTotal || 1)) },
          { key: 'calls', label: 'Вызовов', align: 'right', sort: (r) => (r.tool ? r.tool.calls : 0), render: (r) => (r.tool && r.tool.calls ? fmtInt(r.tool.calls) : '—') },
          { key: 'chars', label: 'Объём', align: 'right', title: 'Символов в результатах', sort: (r) => (r.tool ? r.tool.chars : 0), render: (r) => (r.tool && r.tool.chars ? fmtTokShort(r.tool.chars) : '—') },
        ]} />
      </${Card}>
    </div>

    <${Card} title="Самые дорогие куски контекста" subtitle="Токены куска × число шагов, которые он проехал в контексте после появления; ≈$ — по цене чтения кэша. Щёлкните строку, чтобы открыть это место в транскрипте.">
      <${HeavyTable} P=${P} rows=${heavy} showSession=${false} go=${go} />
    </${Card}>
  </div>`;
}

export function HeavyTable({ P, rows, showSession, go, limit = 25 }) {
  const files = P.ds.files;
  const threadOf = (h) => {
    const f = files[h.file];
    if (f.kind === 0) return 'основной поток';
    return (f.label || f.agentType || 'агент') + (f.run ? ` · ${f.run}` : '');
  };
  const columns = [
    { key: 'desc', label: 'Кусок', sort: (h) => h.desc, render: (h) => html`<div class="cell-title mono-ish" title=${h.desc}>${h.desc || '—'}</div>
      <div class="cell-sub">${catLabel(P, h.cat)} · ${threadOf(h)}${showSession ? ' · ' + sessionTitle(P, files[h.file].session) : ''}</div>` },
    { key: 'est', label: 'Токенов', align: 'right', sort: (h) => h.est, render: (h) => fmtTokShort(h.est) },
    { key: 'steps', label: 'Шагов', align: 'right', title: 'Сколько запросов кусок ехал в контексте', sort: (h) => h.steps, render: (h) => fmtInt(h.steps) },
    { key: 'tokSteps', label: 'Токено-шаги', align: 'right', sort: (h) => h.tokSteps, render: (h) => fmtTok(h.tokSteps) },
    { key: 'cost', label: '≈ $', align: 'right', sort: (h) => h.costEst, render: (h) => fmtUsd(h.costEst) },
    { key: 'ts', label: 'Когда', align: 'right', sort: (h) => h.ts, render: (h) => fmtDateTime(h.ts) },
  ];
  return html`<${Table} columns=${columns} rows=${rows} dense limit=${limit} initialSort=${{ key: 'tokSteps', dir: -1 }}
    onRowClick=${go ? (h) => go({ view: 'transcript', file: h.file, focusTs: h.ts }) : null} empty="Крупных кусков нет" />`;
}

