// Эвристики «что можно улучшить» — по мотивам разбора расхода в воркфлоу (статья 27.09.2026).
import { html } from '../lib/h.js';
import { attribution, fileStats, sessionStats, heavyPieces, median, quantile, totals } from '../lib/data.js';
import { fmtUsd, fmtPct, fmtTokShort, fmtInt, plural } from '../lib/format.js';

export function computeInsights(P, idx, f) {
  const out = [];
  if (!idx.length) return out;
  const tot = totals(P, idx);
  if (!(tot.cost > 0)) return out;
  const att = attribution(P, idx);
  const cats = P.ds.cats;
  const inputCost = tot.cIn + tot.cCw + tot.cCr;
  const catCost = (pred) => {
    let s = 0;
    cats.forEach((c, i) => {
      if (pred(c)) s += att.cost[i];
    });
    return s;
  };

  // 1. Доля агентов.
  let agentCost = 0;
  const fs = fileStats(P, idx);
  for (let k = 0; k < idx.length; k++) if (P.rowKind[idx[k]] !== 0) agentCost += P.cost[idx[k]];
  const agentFiles = [...fs.entries()].filter(([fi]) => P.ds.files[fi].kind !== 0);
  const agentShare = agentCost / tot.cost;
  if (agentShare > 0.45 && agentFiles.length >= 5) {
    out.push({
      level: 'warn',
      title: `Агенты съедают ${fmtPct(agentShare, 0)} расхода`,
      text: `${fmtUsd(agentCost)} ушло на ${fmtInt(agentFiles.length)} ${plural(agentFiles.length, 'агента', 'агентов', 'агентов')} (субагенты и воркфлоу). Каждый шаг агента перечитывает весь его контекст, поэтому дорого стоят длинные агенты и крупные прочитанные файлы.`,
      action: 'Задавать effort в каждом agent() по стадиям, одну узкую задачу на агента, большие — эстафетой; повторную проверку запускать, только если первая что-то нашла.',
      go: { view: 'workflows' },
    });
  }

  // 2. Файлы целиком.
  const wholeFiles = catCost((c) => c.detail === 'Read: файл целиком' || c.detail === 'Shell: чтение файлов');
  const allFiles = catCost((c) => c.group === 'files');
  if (inputCost > 0 && wholeFiles / inputCost > 0.15) {
    out.push({
      level: 'warn',
      title: `${fmtPct(wholeFiles / inputCost, 0)} входной стоимости — файлы, прочитанные целиком`,
      text: `Read без offset/limit и cat/sed/grep через shell дают ${fmtUsd(wholeFiles)}, всё чтение файлов — ${fmtUsd(allFiles)}. Прочитанное едет в контексте до конца работы агента и перечитывается на каждом шаге.`,
      action: 'Правило в CLAUDE.md: файл длиннее ~200 строк не читать целиком — grep -n, затем Read с offset/limit; длинный вывод тестов и diff — в файл, в контекст только tail.',
      go: { view: 'context' },
    });
  }

  // 3. Стартовый контекст агентов.
  const starts = agentFiles.map(([fi, a]) => a.startCtx).filter((x) => x > 0);
  const startCost = (() => {
    let s = 0;
    const R = P.R;
    for (let k = 0; k < idx.length; k++) {
      const i = idx[k];
      if (P.rowKind[i] === 0 || !P.ctx[i]) continue;
      const per = (P.cIn[i] + P.cCw[i] + P.cCr[i]) / P.ctx[i];
      for (let j = R.aOff[i]; j < R.aOff[i + 1]; j++) if (cats[P.ds.attr.cat[j]].group === 'start') s += P.ds.attr.tok[j] * per;
    }
    return s;
  })();
  const medStart = median(starts);
  if (starts.length >= 10 && medStart > 25000) {
    out.push({
      level: 'info',
      title: `Агент стартует с ~${fmtTokShort(medStart)} токенов`,
      text: `Системный промпт, описания инструментов и CLAUDE.md у ${fmtInt(starts.length)} агентов обошлись в ${fmtUsd(startCost)}: стартовый контекст перечитывается на каждом шаге.`,
      action: 'Свой тип агента (.claude/agents/*.md) со списком tools урезает старт: замер в статье — 11k токенов у агента с 7 инструментами против 43k у general-purpose.',
      go: { view: 'workflows' },
    });
  }

  // 4. Effort агентов.
  const effIdx = (name) => P.ds.strings.efforts.indexOf(name);
  const hi = new Set([effIdx('xhigh'), effIdx('max')].filter((x) => x >= 0));
  let agentReq = 0;
  let agentHi = 0;
  let agentHiCost = 0;
  for (let k = 0; k < idx.length; k++) {
    const i = idx[k];
    if (P.rowKind[i] === 0) continue;
    agentReq++;
    if (hi.has(P.R.effort[i])) {
      agentHi++;
      agentHiCost += P.cost[i];
    }
  }
  if (agentReq >= 200 && agentHi / agentReq > 0.7) {
    out.push({
      level: 'info',
      title: `${fmtPct(agentHi / agentReq, 0)} запросов агентов — на xhigh/max`,
      text: `Это ${fmtUsd(agentHiCost)}. Если effort не задан в agent(), агент наследует уровень сессии.`,
      action: 'Код, отладка и дизайн — xhigh; проверка рискованного — high; механика (audit, map, merge, backfill) — medium.',
      go: { view: 'tools' },
    });
  }

  // 5. Длинные агенты.
  const longOnes = agentFiles.filter(([, a]) => a.req > 150);
  if (longOnes.length) {
    const lc = longOnes.reduce((s, [, a]) => s + a.cost, 0);
    const maxSteps = Math.max(...longOnes.map(([, a]) => a.req));
    if (lc / tot.cost > 0.1) {
      out.push({
        level: 'warn',
        title: `${fmtInt(longOnes.length)} ${plural(longOnes.length, 'агент сделал', 'агента сделали', 'агентов сделали')} больше 150 шагов`,
        text: `Рекорд — ${fmtInt(maxSteps)} шагов; на такие агенты пришлось ${fmtUsd(lc)} (${fmtPct(lc / tot.cost, 0)} расхода). Цена куска контекста — его токены × число оставшихся шагов.`,
        action: 'Эстафета из коротких агентов (бюджет ~60 вызовов, остаток передаётся следующему) дешевле одного длинного. maxTurns — только как страховка: результат со schema при обрыве теряется.',
        go: { view: 'workflows' },
      });
    }
  }

  // 6. Скрипты воркфлоу инлайн в основном потоке.
  const heavy = heavyPieces(P, f, { limit: 100000 });
  const inlineWf = heavy.filter((h) => P.ds.files[h.file].kind === 0 && /^Workflow:/.test(h.desc) && P.ds.cats[h.cat].group === 'output');
  const inlineCost = inlineWf.reduce((s, h) => s + h.costEst, 0);
  if (inlineCost > 2) {
    out.push({
      level: 'info',
      title: `Инлайн-скрипты воркфлоу стоят ≈${fmtUsd(inlineCost)}`,
      text: `Скрипт, написанный прямо в вызове Workflow, — это вывод модели: он остаётся в контексте основного потока и перечитывается на каждом следующем шаге (${fmtInt(inlineWf.length)} таких скриптов среди самых дорогих кусков).`,
      action: 'Сохранённые скрипты (.claude/workflows) и повторный запуск через scriptPath не кладут текст скрипта в контекст заново.',
      go: { view: 'context' },
    });
  }

  // 7. Большой контекст основного потока.
  const mainCtx = [];
  for (let k = 0; k < idx.length; k++) if (P.rowKind[idx[k]] === 0) mainCtx.push(P.ctx[idx[k]]);
  const p90 = quantile(mainCtx, 0.9);
  if (mainCtx.length > 200 && p90 > 450000) {
    out.push({
      level: 'info',
      title: `Основной поток живёт с огромным контекстом: p90 ${fmtTokShort(p90)}`,
      text: `Медиана — ${fmtTokShort(median(mainCtx))}. Каждый ход перечитывает весь контекст; автокомпакт по умолчанию срабатывает только около 967k при окне 1M.`,
      action: '/autocompact 500k (или autoCompactWindow в settings) и новая сессия под новую задачу.',
      go: { view: 'sessions' },
    });
  }

  // 8. Системные вставки.
  const rem = catCost((c) => c.group === 'reminders');
  if (inputCost > 0 && rem / inputCost > 0.1) {
    out.push({
      level: 'info',
      title: `Системные вставки — ${fmtPct(rem / inputCost, 0)} входной стоимости`,
      text: `Списки скиллов и отложенных инструментов, инструкции MCP, CLAUDE.md, вывод хуков: ${fmtUsd(rem)}. Они попадают в каждый агент и перечитываются на каждом шаге.`,
      action: 'Отключать ненужные в проекте MCP-серверы и скиллы, держать CLAUDE.md коротким.',
      go: { view: 'context' },
    });
  }

  // 9. Концентрация в одной сессии.
  const ss = sessionStats(P, idx);
  const top = [...ss.values()].sort((a, b) => b.all.cost - a.all.cost)[0];
  if (top && ss.size > 3 && top.all.cost / tot.cost > 0.35) {
    const s = P.ds.sessions[top.session];
    out.push({
      level: 'info',
      title: `Одна сессия — ${fmtPct(top.all.cost / tot.cost, 0)} расхода`,
      text: `«${s.title}»: ${fmtUsd(top.all.cost)}, из них агенты — ${fmtUsd(top.kinds[1].cost + top.kinds[2].cost)}.`,
      action: 'Открыть сессию и посмотреть, какие прогоны и куски контекста дороже всего.',
      go: { view: 'session', session: top.session },
    });
  }

  // 10. Запись в кэш.
  if (tot.cCw / tot.cost > 0.35) {
    out.push({
      level: 'info',
      title: `Запись в кэш — ${fmtPct(tot.cCw / tot.cost, 0)} стоимости`,
      text: 'Каждый новый кусок контекста сначала пишется в кэш: 5 минут — 1,25× цены входа, 1 час — 2×. Много записи — это много нового контекста (крупные результаты инструментов) или промахи кэша: пауза дольше TTL, смена модели или effort посреди сессии.',
      action: 'Смотреть «Что в контексте»: самые крупные результаты инструментов и есть основная запись.',
      go: { view: 'context' },
    });
  }
  return out;
}

export function Insights({ items, go }) {
  if (!items.length) return html`<div class="chart-empty small">Явных перекосов в этом срезе не видно.</div>`;
  return html`<div class="insights">
    ${items.map((it) => html`<div class=${'insight ' + it.level}>
      <div class="insight-icon" aria-hidden="true">${it.level === 'warn' ? '!' : 'i'}</div>
      <div class="insight-body">
        <div class="insight-title">${it.title}</div>
        <div class="insight-text">${it.text}</div>
        <div class="insight-action">${it.action}</div>
      </div>
      ${it.go && html`<button class="btn small ghost" onClick=${() => go(it.go)}>Открыть</button>`}
    </div>`)}
  </div>`;
}
