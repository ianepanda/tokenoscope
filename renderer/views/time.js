import { html, useMemo } from '../lib/h.js';
import { useApp } from '../lib/app-context.js';
import { heatmap, fiveHourBlocks, limitWeeks, filterRows, metricOf, METRICS, HOUR, KIND_COLORS, weekStart, DAY } from '../lib/data.js';
import { Heatmap, Columns } from '../lib/charts.js';
import { Card, Tile, Table } from '../lib/ui.js';
import { fmtUsd, fmtInt, fmtDateTime, fmtTime, fmtDay, fmtWeekday, fmtDuration, fmtTok } from '../lib/format.js';

const DOW = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];
const DOW_FULL = ['понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота', 'воскресенье'];

export function TimeView() {
  const { P, idx, f, metric, fmt, axis, settings, now } = useApp();
  const reset = settings.weekReset;
  const d = useMemo(() => {
    // Окна и недели считаем по всем потокам и проектам выбранного фильтра, но без ограничения периода.
    const allIdx = filterRows(P, { ...f, from: 0, to: Infinity });
    const blocks = fiveHourBlocks(P, allIdx);
    const weeks = limitWeeks(P, allIdx, reset);
    return { grid: heatmap(P, idx, metric), blocks, weeks };
  }, [P, idx, f, metric, reset]);

  const cur = d.blocks.length && d.blocks[d.blocks.length - 1].end > now ? d.blocks[d.blocks.length - 1] : null;
  const ws = weekStart(now, reset);
  const thisWeek = d.weeks.find((w) => w.t === ws);
  const prevWeek = d.weeks.find((w) => w.t === ws - 7 * DAY);
  // Прошлая неделя к тому же моменту — честное сравнение незаконченной недели.
  const prevSame = useMemo(() => {
    let c = 0;
    const all = filterRows(P, { ...f, from: ws - 7 * DAY, to: now - 7 * DAY });
    for (let k = 0; k < all.length; k++) c += P.cost[all[k]];
    return c;
  }, [P, f, ws, now]);
  const elapsed = now - ws;
  const recent = d.blocks.slice(-40).reverse();
  const weekBuckets = d.weeks.slice(-16).map((w) => ({ t: w.t, values: Float64Array.of(metricOf(w.agg, metric)) }));
  const burn = cur ? cur.agg.cost / Math.max(0.25, (Math.min(now, cur.end) - cur.start) / HOUR) : 0;

  const blockColumns = [
    { key: 'start', label: 'Окно', sort: (b) => b.start, render: (b) => html`${fmtWeekday(b.start)}, ${fmtTime(b.start)}–${fmtTime(b.end)}${b.end > now ? html` <span class="pill live-pill">идёт</span>` : ''}` },
    { key: 'cost', label: 'Стоимость', align: 'right', sort: (b) => b.agg.cost, render: (b) => fmtUsd(b.agg.cost) },
    { key: 'req', label: 'Запросов', align: 'right', sort: (b) => b.agg.req, render: (b) => fmtInt(b.agg.req) },
    { key: 'tok', label: 'Токены', align: 'right', sort: (b) => b.agg.ctx + b.agg.out, render: (b) => fmtTok(b.agg.ctx + b.agg.out) },
    { key: 'active', label: 'Активность', align: 'right', title: 'От первого до последнего запроса в окне', sort: (b) => b.agg.last - b.agg.first, render: (b) => fmtDuration(b.agg.last - b.agg.first) },
  ];

  return html`<div class="view">
    <div class="tiles">
      <${Tile} hero label="Текущая неделя лимита" value=${fmtUsd(thisWeek ? thisWeek.agg.cost : 0)}
        sub=${`с ${fmtWeekday(ws)} ${fmtTime(ws)} · прошло ${fmtDuration(elapsed)} из 7 д`}
        delta=${prevSame > 0 ? (thisWeek ? thisWeek.agg.cost : 0) / prevSame - 1 : null}
        title="Неделя считается от сброса лимита (настраивается в «Настройках»); изменение — к прошлой неделе на тот же момент" />
      <${Tile} label="Прошлая неделя" value=${fmtUsd(prevWeek ? prevWeek.agg.cost : 0)} sub=${prevWeek ? `к этому моменту было ${fmtUsd(prevSame)}` : ''} />
      <${Tile} label="Текущее 5-часовое окно" value=${cur ? fmtUsd(cur.agg.cost) : '—'}
        sub=${cur ? `до ${fmtTime(cur.end)} · осталось ${fmtDuration(cur.end - now)}` : 'сейчас окна нет'} />
      <${Tile} label="Темп в окне" value=${cur ? fmtUsd(burn) + '/ч' : '—'} sub=${cur ? `${fmtInt(cur.agg.req)} запросов` : ''} />
    </div>
    <div class="note">Окна и недели учитывают фильтры проектов, моделей и потоков, но не период. Реальные лимиты подписки Anthropic не публикует; стоимость в ценах API — ориентир того, насколько быстро они расходуются.</div>

    <div class="grid2">
      <${Card} title=${`${METRICS[metric].label}: день недели × час`} subtitle="За выбранный период, по местному времени">
        <${Heatmap} grid=${d.grid} rowLabels=${DOW} colLabels=${Array.from({ length: 24 }, (_, h) => String(h))} fmt=${fmt}
          tipTitle=${(r, c) => `${DOW_FULL[r]}, ${String(c).padStart(2, '0')}:00–${String(c + 1).padStart(2, '0')}:00`} />
      </${Card}>
      <${Card} title="Недели лимита" subtitle=${`${METRICS[metric].label} · сброс: ${DOW_FULL[(reset.day + 6) % 7]}, ${String(reset.hour).padStart(2, '0')}:00`}>
        <${Columns} buckets=${weekBuckets} series=${[{ label: METRICS[metric].label, color: KIND_COLORS[0] }]} fmt=${fmt} fmtAxis=${axis}
          xLabel=${fmtDay} tipTitle=${(b) => `Неделя с ${fmtDateTime(b.t)}`} height=${230} />
      </${Card}>
    </div>

    <${Card} title="Пятичасовые окна" subtitle="Оценка в духе сессионных лимитов подписки: окно открывается с часа первого запроса и длится 5 часов">
      <${Table} columns=${blockColumns} rows=${recent} initialSort=${{ key: 'start', dir: -1 }} dense limit=${20} empty="Нет запросов" />
    </${Card}>
  </div>`;
}

