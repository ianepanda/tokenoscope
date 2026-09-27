// Форматирование чисел и дат по-русски.
const nf0 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1, minimumFractionDigits: 0 });
const nf2 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2, minimumFractionDigits: 2 });
const nf3s = new Intl.NumberFormat('ru-RU', { maximumSignificantDigits: 3 });

export function fmtInt(v) {
  return nf0.format(Math.round(v || 0));
}

export function fmtUsd(v) {
  v = v || 0;
  const a = Math.abs(v);
  if (a === 0) return '$0';
  if (a < 0.01) return '<$0,01';
  if (a < 10) return '$' + nf2.format(v);
  if (a < 100) return '$' + nf1.format(v);
  return '$' + nf0.format(v);
}

// Компактно: 4,69 млрд · 85,1 млн · 12,3 тыс. · 950
export function fmtTok(v) {
  v = v || 0;
  const a = Math.abs(v);
  if (a >= 1e9) return nf3s.format(v / 1e9) + ' млрд';
  if (a >= 1e6) return nf3s.format(v / 1e6) + ' млн';
  if (a >= 1e4) return nf3s.format(v / 1e3) + ' тыс.';
  return nf0.format(v);
}

// Короче для осей и узких колонок: 4,7B · 85M · 12k
export function fmtTokShort(v) {
  v = v || 0;
  const a = Math.abs(v);
  if (a >= 1e9) return nf3s.format(v / 1e9) + 'B';
  if (a >= 1e6) return nf3s.format(v / 1e6) + 'M';
  if (a >= 1e3) return nf3s.format(v / 1e3) + 'k';
  return nf0.format(v);
}

export function fmtPct(v, digits = 1) {
  if (!isFinite(v)) return '—';
  const x = v * 100;
  if (x > 0 && x < 0.1) return '<0,1%';
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: digits }).format(x) + '%';
}

export function fmtChars(v) {
  return fmtTok(v) + ' симв.';
}

const dDate = new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
const dShort = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' });
const dDT = new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const dTime = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' });
const dWeekday = new Intl.DateTimeFormat('ru-RU', { weekday: 'short', day: 'numeric', month: 'short' });

export const fmtDate = (t) => (t ? dDate.format(t) : '—');
export const fmtDay = (t) => (t ? dShort.format(t).replace('.', '') : '—');
export const fmtDateTime = (t) => (t ? dDT.format(t) : '—');
export const fmtTime = (t) => (t ? dTime.format(t) : '—');
export const fmtWeekday = (t) => (t ? dWeekday.format(t).replace('.', '') : '—');

export function fmtDuration(ms) {
  if (!(ms > 0)) return '—';
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} мин`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  if (h < 48) return mm ? `${h} ч ${mm} мин` : `${h} ч`;
  const d = Math.floor(h / 24);
  return `${d} д ${h % 24} ч`;
}

export function fmtAgo(t) {
  if (!t) return '—';
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'только что';
  if (s < 3600) return `${Math.floor(s / 60)} мин назад`;
  if (s < 86400) return `${Math.floor(s / 3600)} ч назад`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} д назад`;
  return fmtDate(t);
}

export function plural(n, one, few, many) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

export function shortId(id) {
  return String(id || '').slice(0, 8);
}

// «Круглые» деления оси.
export function niceTicks(max, count = 4) {
  if (!(max > 0)) return [0];
  const raw = max / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  const ticks = [];
  for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(v);
  if (ticks[ticks.length - 1] < max) ticks.push(ticks[ticks.length - 1] + step);
  return ticks;
}
