// Графики на SVG/HTML без библиотек: столбцы с накоплением, ранжированные полосы, полоса долей,
// линия, тепловая карта, спарклайн. Подсказки — один общий слой.
import { html, useState, useRef, useEffect, useLayoutEffect } from './h.js';
import { niceTicks, fmtPct } from './format.js';

// ---------- Подсказка ----------

let setTipGlobal = null;

export function TooltipLayer() {
  const [tip, setTip] = useState(null);
  const ref = useRef(null);
  const [pos, setPos] = useState({ left: -9999, top: -9999 });
  setTipGlobal = setTip;
  useLayoutEffect(() => {
    if (!tip || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    let left = tip.x + 14;
    let top = tip.y + 14;
    if (left + r.width > window.innerWidth - 8) left = tip.x - r.width - 14;
    if (top + r.height > window.innerHeight - 8) top = tip.y - r.height - 14;
    setPos({ left: Math.max(8, left), top: Math.max(8, top) });
  }, [tip]);
  if (!tip) return null;
  return html`<div class="tooltip" ref=${ref} style=${{ left: pos.left + 'px', top: pos.top + 'px' }}>${tip.content}</div>`;
}

export function showTip(e, content) {
  if (setTipGlobal) setTipGlobal({ x: e.clientX, y: e.clientY, content });
}

export function hideTip() {
  if (setTipGlobal) setTipGlobal(null);
}

// Строки подсказки: значение впереди, подпись за ним, ключ — короткий штрих цвета серии.
export function TipRows({ title, rows, footer }) {
  return html`<div>
    ${title && html`<div class="tip-title">${title}</div>`}
    ${rows.map((r) => html`<div class="tip-row">
      ${r.color ? html`<span class="tip-key" style=${{ background: r.color }}></span>` : html`<span class="tip-key none"></span>`}
      <span class="tip-val">${r.value}</span>
      <span class="tip-label">${r.label}</span>
    </div>`)}
    ${footer && html`<div class="tip-foot">${footer}</div>`}
  </div>`;
}

// ---------- Размер контейнера ----------

export function useWidth(initial = 600) {
  const ref = useRef(null);
  const [w, setW] = useState(initial);
  useEffect(() => {
    if (!ref.current) return undefined;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        const cw = Math.floor(e.contentRect.width);
        if (cw > 0) setW(cw);
      }
    });
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

export function Legend({ series, kind = 'rect' }) {
  if (!series || series.length < 2) return null;
  return html`<div class="legend">
    ${series.map((s) => html`<span class="legend-item">
      <span class=${'legend-key ' + kind} style=${{ background: s.color }}></span>${s.label}
    </span>`)}
  </div>`;
}

// Путь прямоугольника со скруглёнными верхними углами (конец данных), низ — прямой.
function topRoundedRect(x, y, w, h, r) {
  if (h <= 0 || w <= 0) return '';
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

// ---------- Столбцы с накоплением ----------

export function Columns({ buckets, series, fmt, fmtAxis, xLabel, tipTitle, height = 220, onPick, empty = 'Нет данных за период' }) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState(-1);
  const W = Math.max(200, width);
  const H = height;
  const m = { l: 58, r: 8, t: 14, b: 24 };
  const pw = W - m.l - m.r;
  const ph = H - m.t - m.b;
  const n = buckets.length;
  let max = 0;
  let peak = -1;
  const sums = buckets.map((b, i) => {
    let s = 0;
    for (let k = 0; k < b.values.length; k++) s += b.values[k];
    if (s > max) {
      max = s;
      peak = i;
    }
    return s;
  });
  if (!n || max <= 0) {
    return html`<div ref=${ref} class="chart-empty" style=${{ height: H + 'px' }}>${empty}</div>`;
  }
  const ticks = niceTicks(max, 4);
  const yMax = ticks[ticks.length - 1] || 1;
  const band = pw / n;
  const barW = Math.max(1, Math.min(24, band - 2, band * 0.72));
  const y = (v) => m.t + ph - (v / yMax) * ph;
  const labelEvery = Math.max(1, Math.ceil(46 / band));
  const GAP = 2;

  const onMove = (e, i) => {
    setHover(i);
    const b = buckets[i];
    const rows = [];
    for (let s = series.length - 1; s >= 0; s--) {
      if (b.values[s] > 0) rows.push({ color: series[s].color, value: fmt(b.values[s]), label: series[s].label });
    }
    showTip(e, html`<${TipRows} title=${tipTitle ? tipTitle(b) : xLabel(b.t)} rows=${rows}
      footer=${series.length > 1 ? `Всего: ${fmt(sums[i])}` : null} />`);
  };

  return html`<div ref=${ref} class="chart">
    <${Legend} series=${series} />
    <svg width=${W} height=${H} role="img">
      ${ticks.map((t) => html`<g>
        <line x1=${m.l} x2=${W - m.r} y1=${y(t)} y2=${y(t)} class=${t === 0 ? 'axis' : 'grid'} />
        <text x=${m.l - 8} y=${y(t) + 4} class="tick" text-anchor="end">${(fmtAxis || fmt)(t)}</text>
      </g>`)}
      ${buckets.map((b, i) => {
        const cx = m.l + band * i + band / 2;
        const x = cx - barW / 2;
        let acc = 0;
        const segs = [];
        let topIdx = -1;
        for (let s = 0; s < series.length; s++) if (b.values[s] > 0) topIdx = s;
        for (let s = 0; s < series.length; s++) {
          const v = b.values[s];
          if (!(v > 0)) continue;
          const y0 = y(acc);
          const y1 = y(acc + v);
          acc += v;
          const hgt = y0 - y1 - (s === topIdx ? 0 : GAP);
          if (hgt <= 0.3) continue;
          if (s === topIdx) segs.push(html`<path d=${topRoundedRect(x, y1, barW, hgt, 4)} style=${{ fill: series[s].color }} />`);
          else segs.push(html`<rect x=${x} y=${y1 + GAP} width=${barW} height=${hgt} style=${{ fill: series[s].color }} />`);
        }
        return html`<g class=${hover === i ? 'col hover' : hover >= 0 ? 'col dim' : 'col'}>
          ${hover === i && html`<rect x=${m.l + band * i} y=${m.t} width=${band} height=${ph} class="col-wash" />`}
          ${segs}
          ${i % labelEvery === 0 && html`<text x=${cx} y=${H - 6} class="tick" text-anchor="middle">${xLabel(b.t)}</text>`}
          <rect x=${m.l + band * i} y=${m.t} width=${band} height=${ph + 4} class="hit"
            onMouseMove=${(e) => onMove(e, i)} onMouseLeave=${() => { setHover(-1); hideTip(); }}
            onClick=${onPick ? () => onPick(b) : null} style=${onPick ? { cursor: 'pointer' } : null} />
        </g>`;
      })}
      ${peak >= 0 && band >= 14 && html`<text x=${m.l + band * peak + band / 2} y=${y(sums[peak]) - 5} class="peak-label" text-anchor="middle">${fmt(sums[peak])}</text>`}
    </svg>
  </div>`;
}

// ---------- Ранжированные полосы ----------

export function HBars({ items, fmt, max, color = 'var(--s1)', onPick, empty = 'Пусто', showShare = true }) {
  if (!items.length) return html`<div class="chart-empty small">${empty}</div>`;
  const top = max || Math.max(...items.map((x) => x.value), 1e-12);
  return html`<div class="hbars">
    ${items.map((it) => html`<div class=${'hbar' + (onPick ? ' clickable' : '')} onClick=${onPick ? () => onPick(it) : null}
      title=${it.title || it.label}>
      <div class="hbar-head">
        <span class="hbar-label">${it.label}</span>
        ${it.sub && html`<span class="hbar-sub">${it.sub}</span>`}
        <span class="hbar-val">${fmt(it.value)}${showShare && it.share != null ? html`<span class="hbar-share">${fmtPct(it.share)}</span>` : ''}</span>
      </div>
      <div class="hbar-track"><div class="hbar-fill" style=${{ width: Math.max(0.5, (100 * it.value) / top) + '%', background: it.color || color }}></div></div>
    </div>`)}
  </div>`;
}

// ---------- Полоса долей ----------

export function ShareBar({ segments, fmt, legend = true, height = 14 }) {
  const total = segments.reduce((s, x) => s + (x.value > 0 ? x.value : 0), 0);
  if (!(total > 0)) return html`<div class="chart-empty small">Нет данных</div>`;
  const vis = segments.filter((s) => s.value > 0);
  return html`<div class="sharebar">
    <div class="sharebar-track" style=${{ height: height + 'px' }}>
      ${vis.map((s) => html`<div class="sharebar-seg" style=${{ flexGrow: s.value, background: s.color }}
        onMouseMove=${(e) => showTip(e, html`<${TipRows} rows=${[{ color: s.color, value: `${fmt(s.value)} · ${fmtPct(s.value / total)}`, label: s.label }]} />`)}
        onMouseLeave=${hideTip}></div>`)}
    </div>
    ${legend && html`<div class="sharebar-legend">
      ${vis.map((s) => html`<div class="sl-row">
        <span class="legend-key rect" style=${{ background: s.color }}></span>
        <span class="sl-label">${s.label}</span>
        <span class="sl-val">${fmt(s.value)}</span>
        <span class="sl-pct">${fmtPct(s.value / total)}</span>
      </div>`)}
    </div>`}
  </div>`;
}

// ---------- Линия ----------

export function LineChart({ points, fmtY, xTip, markers = [], height = 220, color = 'var(--s1)', yLabel, xAxis }) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState(-1);
  const W = Math.max(200, width);
  const H = height;
  const m = { l: 58, r: 12, t: 14, b: 24 };
  const pw = W - m.l - m.r;
  const ph = H - m.t - m.b;
  if (!points.length) return html`<div ref=${ref} class="chart-empty" style=${{ height: H + 'px' }}>Нет данных</div>`;
  const xs = points.map((p) => p.x);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const maxY = Math.max(...points.map((p) => p.y), 1);
  const ticks = niceTicks(maxY, 4);
  const yMax = ticks[ticks.length - 1] || 1;
  const X = (v) => m.l + (x1 === x0 ? pw / 2 : ((v - x0) / (x1 - x0)) * pw);
  const Y = (v) => m.t + ph - (v / yMax) * ph;
  let d = '';
  points.forEach((p, i) => {
    d += `${i ? 'L' : 'M'}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`;
  });
  const area = `${d}L${X(points[points.length - 1].x).toFixed(1)},${Y(0)}L${X(points[0].x).toFixed(1)},${Y(0)}Z`;
  const onMove = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const target = x0 + ((px - m.l) / pw) * (x1 - x0);
    let lo = 0;
    let hi = points.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (points[mid].x < target) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0 && Math.abs(points[lo - 1].x - target) < Math.abs(points[lo].x - target)) lo--;
    setHover(lo);
    const p = points[lo];
    showTip(e, html`<${TipRows} title=${xTip(p)} rows=${[{ color, value: fmtY(p.y), label: yLabel || '' }].concat(p.extra || [])} />`);
  };
  const xTicks = xAxis ? xAxis(x0, x1, pw) : [];
  const hp = hover >= 0 ? points[hover] : null;
  return html`<div ref=${ref} class="chart">
    <svg width=${W} height=${H} role="img">
      ${ticks.map((t) => html`<g>
        <line x1=${m.l} x2=${W - m.r} y1=${Y(t)} y2=${Y(t)} class=${t === 0 ? 'axis' : 'grid'} />
        <text x=${m.l - 8} y=${Y(t) + 4} class="tick" text-anchor="end">${fmtY(t)}</text>
      </g>`)}
      ${xTicks.map((t) => html`<text x=${X(t.x)} y=${H - 6} class="tick" text-anchor="middle">${t.label}</text>`)}
      ${markers.map((mk) => html`<g>
        <line x1=${X(mk.x)} x2=${X(mk.x)} y1=${m.t} y2=${m.t + ph} class="marker-line" />
        <text x=${X(mk.x) + 4} y=${m.t + 10} class="marker-label">${mk.label}</text>
      </g>`)}
      <path d=${area} style=${{ fill: color, opacity: 0.1 }} />
      <path d=${d} style=${{ stroke: color }} class="line" />
      ${hp && html`<g>
        <line x1=${X(hp.x)} x2=${X(hp.x)} y1=${m.t} y2=${m.t + ph} class="crosshair" />
        <circle cx=${X(hp.x)} cy=${Y(hp.y)} r="4.5" class="dot" style=${{ fill: color }} />
      </g>`}
      <rect x=${m.l} y=${m.t} width=${pw} height=${ph} class="hit" onMouseMove=${onMove} onMouseLeave=${() => { setHover(-1); hideTip(); }} />
    </svg>
  </div>`;
}

// ---------- Тепловая карта ----------

const RAMP = ['var(--q1)', 'var(--q2)', 'var(--q3)', 'var(--q4)', 'var(--q5)', 'var(--q6)', 'var(--q7)'];

export function Heatmap({ grid, rowLabels, colLabels, fmt, tipTitle }) {
  let max = 0;
  for (const r of grid) for (const v of r) if (v > max) max = v;
  const colorOf = (v) => {
    if (!(v > 0) || !(max > 0)) return 'var(--q0)';
    const k = Math.min(RAMP.length - 1, Math.floor(Math.sqrt(v / max) * RAMP.length));
    return RAMP[k];
  };
  return html`<div class="heatmap">
    <div class="hm-grid" style=${{ gridTemplateColumns: `36px repeat(${colLabels.length}, 1fr)` }}>
      <div></div>
      ${colLabels.map((c, i) => html`<div class="hm-col">${i % 3 === 0 ? c : ''}</div>`)}
      ${grid.map((row, r) => html`
        <div class="hm-row">${rowLabels[r]}</div>
        ${[...row].map((v, c) => html`<div class="hm-cell" style=${{ background: colorOf(v) }}
          onMouseMove=${(e) => showTip(e, html`<${TipRows} title=${tipTitle(r, c)} rows=${[{ value: fmt(v), label: '' }]} />`)}
          onMouseLeave=${hideTip}></div>`)}
      `)}
    </div>
    <div class="hm-scale"><span>меньше</span>${['var(--q0)', ...RAMP].map((c) => html`<span class="hm-swatch" style=${{ background: c }}></span>`)}<span>больше</span></div>
  </div>`;
}

// ---------- Спарклайн ----------

export function Sparkline({ values, width = 120, height = 28 }) {
  if (!values || values.length < 2) return null;
  const max = Math.max(...values, 1e-12);
  const step = width / (values.length - 1);
  let d = '';
  values.forEach((v, i) => {
    d += `${i ? 'L' : 'M'}${(i * step).toFixed(1)},${(height - 3 - (v / max) * (height - 6)).toFixed(1)}`;
  });
  const lx = (values.length - 1) * step;
  const ly = height - 3 - (values[values.length - 1] / max) * (height - 6);
  return html`<svg width=${width} height=${height} class="spark">
    <path d=${d} class="spark-line" />
    <circle cx=${lx} cy=${ly} r="3" class="spark-dot" />
  </svg>`;
}
