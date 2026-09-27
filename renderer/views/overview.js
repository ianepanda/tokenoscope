import { html, useMemo, useState } from '../lib/h.js';
import { useApp } from '../lib/app-context.js';
import {
  totals, groupBy, timeBuckets, splitSeries, SPLITS, attribution, groupSegments, sessionStats,
  KIND_LABELS, KIND_COLORS, DAY, metricOf, METRICS, sessionTitle,
} from '../lib/data.js';
import { Columns, HBars, ShareBar } from '../lib/charts.js';
import { Card, Tile, Segmented } from '../lib/ui.js';
import { fmtUsd, fmtInt, fmtTok, fmtPct, fmtDay, fmtTime, fmtWeekday, fmtTokShort } from '../lib/format.js';
import { computeInsights, Insights } from './insights.js';

export function dropEmptySeries(buckets, series) {
  const keep = series.map((_, s) => buckets.some((b) => b.values[s] > 0));
  if (keep.every(Boolean)) return { buckets, series };
  const map = keep.map((k, s) => (k ? s : -1)).filter((s) => s >= 0);
  return {
    series: map.map((s) => series[s]),
    buckets: buckets.map((b) => ({ ...b, values: Float64Array.from(map.map((s) => b.values[s])) })),
  };
}

export function useDaily(split) {
  const { P, idx, rng, metric, fmt, axis } = useApp();
  return useMemo(() => {
    const span = (isFinite(rng.to) ? Math.min(rng.to, Date.now()) : Date.now()) - (rng.from || (idx.length ? P.R.ts[idx[0]] : Date.now()));
    const bucket = span <= 2 * DAY ? 'hour' : 'day';
    const sp = splitSeries(P, split, metric);
    const raw = timeBuckets(P, idx, { from: rng.from, to: rng.to, bucket, nSeries: sp.series.length, add: sp.add });
    const { buckets, series } = dropEmptySeries(raw, sp.series);
    const f = sp.fmtOverride === 'tok' ? fmtTok : fmt;
    const a = sp.fmtOverride === 'tok' ? fmtTokShort : axis;
    return {
      buckets,
      series,
      fmt: f,
      axis: a,
      bucket,
      xLabel: bucket === 'hour' ? (t) => fmtTime(t) : (t) => fmtDay(t),
      tipTitle: bucket === 'hour' ? (b) => `${fmtWeekday(b.t)}, ${fmtTime(b.t)}` : (b) => fmtWeekday(b.t),
    };
  }, [P, idx, rng, split, metric]);
}

export function Overview() {
  const A = useApp();
  const { P, idx, prevIdx, metric, fmt, go, setProjects, rng } = A;
  const [split, setSplit] = useState('components');
  const tot = useMemo(() => totals(P, idx), [P, idx]);
  const prev = useMemo(() => (prevIdx ? totals(P, prevIdx) : null), [P, prevIdx]);
  const daily = useDaily(split);
  const sparkDays = useMemo(() => {
    const d = timeBuckets(P, idx, { from: rng.from, to: rng.to, bucket: 'day', nSeries: 1, add: (v, i) => { v[0] += P.cost[i]; } });
    return d.map((b) => b.values[0]);
  }, [P, idx, rng]);
  const kinds = useMemo(() => groupBy(P, idx, (i) => P.rowKind[i]), [P, idx]);
  const models = useMemo(() => groupBy(P, idx, (i) => P.R.model[i]), [P, idx]);
  const projects = useMemo(() => groupBy(P, idx, (i) => P.rowProject[i]), [P, idx]);
  const sessions = useMemo(() => sessionStats(P, idx), [P, idx]);
  const att = useMemo(() => attribution(P, idx), [P, idx]);
  const insights = useMemo(() => computeInsights(P, idx, A.f), [P, idx, A.f]);

  const days = Math.max(1, sparkDays.length);
  const agentsCost = (kinds.get(1) ? kinds.get(1).cost : 0) + (kinds.get(2) ? kinds.get(2).cost : 0);
  const delta = (a, b) => (b && b > 0 ? a / b - 1 : null);
  const tokens = tot.ctx + tot.out;
  const total = metricOf(tot, metric);

  const projItems = [...projects.entries()]
    .map(([k, a]) => ({ key: k, label: P.ds.projects[k].name, sub: P.ds.projects[k].path, value: metricOf(a, metric), share: metricOf(a, metric) / (total || 1) }))
    .sort((a, b) => b.value - a.value).slice(0, 8);
  const sessItems = [...sessions.values()]
    .map((x) => {
      const s = P.ds.sessions[x.session];
      return { key: x.session, label: sessionTitle(P, x.session), sub: P.ds.projects[s.project].name, value: metricOf(x.all, metric), share: metricOf(x.all, metric) / (total || 1) };
    })
    .sort((a, b) => b.value - a.value).slice(0, 8);

  const kindSegs = [0, 1, 2].map((k) => ({ label: KIND_LABELS[k], value: kinds.get(k) ? metricOf(kinds.get(k), metric) : 0, color: KIND_COLORS[k] }));
  const modelSegs = [...models.entries()]
    .map(([m, a]) => ({ m, label: P.ds.strings.models[m], value: metricOf(a, metric), color: P.modelColors[m] }))
    .sort((a, b) => {
      const sa = /--s(\d)/.exec(a.color);
      const sb = /--s(\d)/.exec(b.color);
      return (sa ? +sa[1] : 99) - (sb ? +sb[1] : 99) || b.value - a.value;
    });
  const ctxSegs = groupSegments(P, att);

  return html`<div class="view">
    <div class="tiles">
      <${Tile} hero label="Стоимость в ценах API" value=${fmtUsd(tot.cost)} delta=${prev ? delta(tot.cost, prev.cost) : null}
        sub=${prev ? `было ${fmtUsd(prev.cost)} к этому моменту прошлого периода` : `~${fmtUsd(tot.cost / days)} в день`} spark=${sparkDays}
        title="Сколько стоил бы этот расход по тарифам API. Для подписки — мера того, насколько активно расходуется лимит." />
      <${Tile} label="Запросов к API" value=${fmtInt(tot.req)} delta=${prev ? delta(tot.req, prev.req) : null} sub=${`~${fmtInt(tot.req / days)} в день`} />
      <${Tile} label="Токенов обработано" value=${fmtTok(tokens)} delta=${prev ? delta(tokens, prev.ctx + prev.out) : null}
        sub=${`${fmtPct(tot.cr / (tokens || 1))} — чтение кэша`} />
      <${Tile} label="Попадание в кэш" value=${fmtPct(tot.cr / (tot.ctx || 1))} deltaGoodWhenUp
        sub=${`запись ${fmtTok(tot.cw)} · вывод ${fmtTok(tot.out)}`} title="Доля входного контекста, прочитанного из кэша" />
      <${Tile} label="Сессий" value=${fmtInt(sessions.size)} sub=${`${fmtInt(projects.size)} проектов`} />
      <${Tile} label="Субагенты и воркфлоу" value=${fmtPct(agentsCost / (tot.cost || 1), 0)} sub=${`${fmtUsd(agentsCost)} из ${fmtUsd(tot.cost)}`} />
    </div>

    <${Card} title=${`${METRICS[metric].label} по ${daily.bucket === 'hour' ? 'часам' : 'дням'}`}
      subtitle=${split === 'components' && metric !== 'cost' && metric !== 'req' ? 'Компоненты — в токенах' : null}
      actions=${html`<${Segmented} small options=${SPLITS} value=${split} onChange=${setSplit} />`}>
      <${Columns} buckets=${daily.buckets} series=${daily.series} fmt=${daily.fmt} fmtAxis=${daily.axis}
        xLabel=${daily.xLabel} tipTitle=${daily.tipTitle} height=${240} />
    </${Card}>

    <div class="grid2">
      <${Card} title="Проекты" subtitle="Щёлкните, чтобы открыть сессии проекта">
        <${HBars} items=${projItems} fmt=${fmt} onPick=${(it) => { setProjects(new Set([it.key])); go({ view: 'sessions' }); }} />
      </${Card}>
      <${Card} title="Самые дорогие сессии">
        <${HBars} items=${sessItems} fmt=${fmt} onPick=${(it) => go({ view: 'session', session: it.key })} />
      </${Card}>
    </div>

    <div class="grid3">
      <${Card} title="Кто тратит" subtitle="Основной поток сессии против агентов">
        <${ShareBar} segments=${kindSegs} fmt=${fmt} />
      </${Card}>
      <${Card} title="Модели">
        <${ShareBar} segments=${modelSegs} fmt=${fmt} />
      </${Card}>
      <${Card} title="На что уходят деньги" subtitle="Входная стоимость по содержимому контекста + генерация"
        actions=${html`<button class="btn small ghost" onClick=${() => go({ view: 'context' })}>Подробнее</button>`}>
        <${ShareBar} segments=${ctxSegs} fmt=${fmtUsd} />
      </${Card}>
    </div>

    <${Card} title="Что можно улучшить" subtitle="Эвристики по текущему срезу">
      <${Insights} items=${insights} go=${go} />
    </${Card}>
  </div>`;
}
