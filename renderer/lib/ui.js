// Общие элементы интерфейса: карточки, плитки, таблица с сортировкой, переключатели, выпадающий мультивыбор.
import { html, useState, useMemo, useEffect, useRef } from './h.js';
import { Sparkline } from './charts.js';

export function Card({ title, subtitle, actions, children, className = '', id }) {
  return html`<section class=${'card ' + className} id=${id}>
    ${(title || actions) && html`<header class="card-head">
      <div class="card-titles">
        ${title && html`<h2>${title}</h2>`}
        ${subtitle && html`<div class="card-sub">${subtitle}</div>`}
      </div>
      ${actions && html`<div class="card-actions">${actions}</div>`}
    </header>`}
    <div class="card-body">${children}</div>
  </section>`;
}

// Плитка-показатель: подпись, значение, изменение к прошлому периоду, спарклайн.
export function Tile({ label, value, sub, delta, deltaGoodWhenUp = false, spark, hero = false, title }) {
  let deltaEl = null;
  if (delta != null && isFinite(delta)) {
    const up = delta > 0;
    const good = deltaGoodWhenUp ? up : !up;
    const txt = `${up ? '▲' : delta < 0 ? '▼' : '•'} ${Math.abs(delta * 100) >= 1000 ? '>999' : Math.round(Math.abs(delta) * 100)}%`;
    deltaEl = html`<span class=${'delta ' + (delta === 0 ? '' : good ? 'good' : 'bad')}>${txt}</span>`;
  }
  return html`<div class=${'tile' + (hero ? ' hero' : '')} title=${title || ''}>
    <div class="tile-label">${label}</div>
    <div class="tile-value">${value}</div>
    <div class="tile-foot">
      ${deltaEl}
      ${sub && html`<span class="tile-sub">${sub}</span>`}
    </div>
    ${spark && html`<div class="tile-spark"><${Sparkline} values=${spark} /></div>`}
  </div>`;
}

export function Segmented({ options, value, onChange, small = false }) {
  return html`<div class=${'segmented' + (small ? ' small' : '')} role="tablist">
    ${options.map((o) => html`<button role="tab" class=${o.key === value ? 'on' : ''} aria-selected=${o.key === value}
      onClick=${() => onChange(o.key)} title=${o.title || ''}>${o.label}</button>`)}
  </div>`;
}

export function useOutsideClose(open, setOpen) {
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const h = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    const k = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', h);
    document.addEventListener('keydown', k);
    return () => {
      document.removeEventListener('mousedown', h);
      document.removeEventListener('keydown', k);
    };
  }, [open]);
  return ref;
}

// Мультивыбор: options [{key, label, sub, color}], selected: Set.
export function MultiSelect({ label, options, selected, onChange, allLabel = 'все', width = 320 }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useOutsideClose(open, setOpen);
  const shown = useMemo(() => {
    const ql = q.trim().toLowerCase();
    return ql ? options.filter((o) => (o.label + ' ' + (o.sub || '')).toLowerCase().includes(ql)) : options;
  }, [q, options]);
  const toggle = (key) => {
    const next = new Set(selected);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onChange(next);
  };
  const summary = !selected.size ? allLabel : selected.size === 1
    ? (options.find((o) => selected.has(o.key)) || {}).label || '1'
    : `${selected.size} из ${options.length}`;
  return html`<div class="dropdown" ref=${ref}>
    <button class=${'dd-button' + (selected.size ? ' active' : '')} onClick=${() => setOpen(!open)}>
      <span class="dd-label">${label}:</span> <span class="dd-value">${summary}</span><span class="dd-caret">▾</span>
    </button>
    ${open && html`<div class="dd-panel" style=${{ width: width + 'px' }}>
      ${options.length > 8 && html`<input class="dd-search" placeholder="Поиск…" value=${q} onInput=${(e) => setQ(e.target.value)} autofocus />`}
      <div class="dd-list">
        ${shown.map((o) => html`<label class="dd-item">
          <input type="checkbox" checked=${selected.has(o.key)} onChange=${() => toggle(o.key)} />
          ${o.color && html`<span class="legend-key rect" style=${{ background: o.color }}></span>`}
          <span class="dd-item-label">${o.label}</span>
          ${o.sub && html`<span class="dd-item-sub">${o.sub}</span>`}
        </label>`)}
        ${!shown.length && html`<div class="dd-empty">Ничего не найдено</div>`}
      </div>
      <div class="dd-foot">
        <button class="link" onClick=${() => onChange(new Set())}>Сбросить</button>
        <button class="link" onClick=${() => setOpen(false)}>Готово</button>
      </div>
    </div>`}
  </div>`;
}

// Таблица с сортировкой. columns: [{key, label, align, render(row), sort(row), title, className}]
export function Table({ columns, rows, initialSort, onRowClick, limit = 100, rowKey, rowClass, empty = 'Нет строк', dense = false, className = '' }) {
  const [sort, setSort] = useState(initialSort || { key: columns[0].key, dir: -1 });
  const [shown, setShown] = useState(limit);
  useEffect(() => setShown(limit), [rows, limit]);
  const sorted = useMemo(() => {
    const col = columns.find((c) => c.key === sort.key);
    if (!col) return rows;
    const get = col.sort || ((r) => r[col.key]);
    return [...rows].sort((a, b) => {
      const va = get(a);
      const vb = get(b);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      if (typeof va === 'string' || typeof vb === 'string') return sort.dir * String(va).localeCompare(String(vb), 'ru');
      return sort.dir * (va - vb);
    });
  }, [rows, sort, columns]);
  if (!rows.length) return html`<div class="chart-empty small">${empty}</div>`;
  const head = (c) => {
    const on = sort.key === c.key;
    return html`<th class=${(c.align === 'right' ? 'num ' : '') + (c.sortable === false ? '' : 'sortable ') + (on ? 'sorted' : '')}
      title=${c.title || ''}
      onClick=${c.sortable === false ? null : () => setSort({ key: c.key, dir: on ? -sort.dir : (c.align === 'right' ? -1 : 1) })}>
      ${c.label}${on ? (sort.dir < 0 ? ' ↓' : ' ↑') : ''}
    </th>`;
  };
  return html`<div class="table-wrap">
    <table class=${'table' + (dense ? ' dense' : '') + (className ? ' ' + className : '')}>
      <thead><tr>${columns.map(head)}</tr></thead>
      <tbody>
        ${sorted.slice(0, shown).map((r, i) => html`<tr key=${rowKey ? rowKey(r) : i}
          class=${(onRowClick ? 'clickable ' : '') + (rowClass ? rowClass(r) : '')}
          onClick=${onRowClick ? () => onRowClick(r) : null}>
          ${columns.map((c) => html`<td class=${(c.align === 'right' ? 'num ' : '') + (c.className || '')}>${c.render ? c.render(r) : r[c.key]}</td>`)}
        </tr>`)}
      </tbody>
    </table>
    ${sorted.length > shown && html`<div class="table-more">
      <button class="link" onClick=${() => setShown(shown + limit)}>Показать ещё ${Math.min(limit, sorted.length - shown)} из ${sorted.length - shown}</button>
    </div>`}
  </div>`;
}

export function Pill({ children, tone = '' }) {
  return html`<span class=${'pill ' + tone}>${children}</span>`;
}

export function Empty({ children }) {
  return html`<div class="empty-state">${children}</div>`;
}

// Мини-полоска доли в ячейке таблицы.
export function Bar({ value, max, color = 'var(--s1)' }) {
  const w = max > 0 ? Math.max(1, (100 * value) / max) : 0;
  return html`<span class="cell-bar"><span style=${{ width: w + '%', background: color }}></span></span>`;
}

// Полоска из нескольких частей в ячейке (например, основной/субагенты/воркфлоу).
export function StackCell({ parts }) {
  const total = parts.reduce((s, p) => s + p.value, 0);
  if (!(total > 0)) return html`<span class="stack-cell empty"></span>`;
  return html`<span class="stack-cell">${parts.filter((p) => p.value > 0).map((p) => html`<span style=${{ flexGrow: p.value, background: p.color }} title=${p.title || ''}></span>`)}</span>`;
}
