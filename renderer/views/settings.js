import { html, useState, useEffect } from '../lib/h.js';
import { useApp } from '../lib/app-context.js';
import { Card, Segmented } from '../lib/ui.js';
import { fmtInt, fmtTok, fmtDateTime } from '../lib/format.js';

const DAYS = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];

export function SettingsView() {
  const { settings, updateSettings, rescan, busy, ds, P } = useApp();
  const [pricing, setPricing] = useState(settings.pricing);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    setPricing(settings.pricing);
    setDirty(false);
  }, [settings.pricing]);

  const setModel = (i, key, value) => {
    const models = pricing.models.map((m, k) => (k === i ? { ...m, [key]: key === 'id' ? value : value === '' ? '' : Number(value) } : m));
    setPricing({ ...pricing, models });
    setDirty(true);
  };
  const setMult = (key, value) => {
    setPricing({ ...pricing, [key]: Number(value) });
    setDirty(true);
  };
  const addModel = () => {
    setPricing({ ...pricing, models: [...pricing.models, { id: 'claude-', in: 5, out: 25, cr: 0.5 }] });
    setDirty(true);
  };
  const removeModel = (i) => {
    setPricing({ ...pricing, models: pricing.models.filter((_, k) => k !== i) });
    setDirty(true);
  };
  const savePricing = () => {
    const clean = { ...pricing, models: pricing.models.filter((m) => m.id && m.id.trim()).map((m) => ({ ...m, id: m.id.trim() })) };
    updateSettings({ pricing: clean });
  };
  const addRoot = async () => {
    const p = await window.api.pickFolder();
    if (p && !settings.roots.includes(p)) updateSettings({ roots: [...settings.roots, p] });
  };
  const scan = ds.meta.scan || {};
  const used = new Set(ds.strings.models);

  return html`<div class="view narrow">
    <${Card} title="Откуда брать данные" subtitle="Папки с транскриптами Claude Code (projects). Второй CLAUDE_CONFIG_DIR можно добавить сюда же.">
      <div class="roots">
        ${settings.roots.map((r) => html`<div class="root-row">
          <span class="mono">${r}</span>
          ${settings.roots.length > 1 && html`<button class="btn small ghost" onClick=${() => updateSettings({ roots: settings.roots.filter((x) => x !== r) })}>Убрать</button>`}
        </div>`)}
      </div>
      <div class="row-actions">
        <button class="btn small" onClick=${addRoot}>Добавить папку…</button>
        <label class="check"><input type="checkbox" checked=${settings.watch} onChange=${(e) => updateSettings({ watch: e.target.checked })} /> Следить за изменениями и обновлять сводку</label>
      </div>
      <div class="scan-stats">
        Файлов: ${fmtInt(scan.files || ds.meta.files)} · ${fmtTok(scan.bytes || 0)}Б · последний разбор ${scan.parsed != null ? `${fmtInt(scan.parsed)} новых/изменённых, ${fmtInt(scan.cached)} из кэша` : ''} за ${fmtInt(scan.totalMs || 0)} мс
        · запросов ${fmtInt(ds.meta.rows)} (дубликатов после rewind убрано: ${fmtInt(ds.meta.dupes)})
        ${scan.errors && scan.errors.length ? html`<div class="warn-text">Не разобраны: ${scan.errors.map((e) => e.path).join(', ')}</div>` : ''}
      </div>
      <div class="row-actions">
        <button class="btn small" disabled=${busy} onClick=${() => rescan()}>Обновить</button>
        <button class="btn small ghost" disabled=${busy} onClick=${() => rescan({ clearCache: true })}>Разобрать всё заново</button>
      </div>
    </${Card}>

    <${Card} title="Вид">
      <div class="form-row"><span class="form-label">Тема</span>
        <${Segmented} small options=${[{ key: 'system', label: 'Как в системе' }, { key: 'light', label: 'Светлая' }, { key: 'dark', label: 'Тёмная' }]}
          value=${settings.theme} onChange=${(t) => updateSettings({ theme: t })} />
      </div>
      <div class="form-row"><span class="form-label">Сброс недельного лимита</span>
        <select value=${settings.weekReset.day} onChange=${(e) => updateSettings({ weekReset: { ...settings.weekReset, day: +e.target.value } })}>
          ${DAYS.map((d, i) => html`<option value=${i}>${d}</option>`)}
        </select>
        <select value=${settings.weekReset.hour} onChange=${(e) => updateSettings({ weekReset: { ...settings.weekReset, hour: +e.target.value } })}>
          ${Array.from({ length: 24 }, (_, h) => html`<option value=${h}>${String(h).padStart(2, '0')}:00</option>`)}
        </select>
        <span class="muted small">по местному времени; видно в карточке лимитов Claude</span>
      </div>
    </${Card}>

    <${Card} title="Цены, $ за миллион токенов" subtitle="Стоимость считается в эквиваленте API. Модель сопоставляется с самым длинным совпавшим префиксом id."
      actions=${html`
        <button class="btn small ghost" onClick=${() => updateSettings({ resetPricing: true })}>Вернуть по умолчанию</button>
        <button class="btn small primary" disabled=${!dirty} onClick=${savePricing}>Сохранить</button>`}>
      <div class="form-row">
        <span class="form-label">Запись в кэш, × цены входа</span>
        <label class="inline">5 мин <input class="num-input" type="number" step="0.05" value=${pricing.cw5mMult} onInput=${(e) => setMult('cw5mMult', e.target.value)} /></label>
        <label class="inline">1 час <input class="num-input" type="number" step="0.05" value=${pricing.cw1hMult} onInput=${(e) => setMult('cw1hMult', e.target.value)} /></label>
        <label class="inline">быстрый режим × <input class="num-input" type="number" step="0.5" value=${pricing.fastMult} onInput=${(e) => setMult('fastMult', e.target.value)} /></label>
      </div>
      <div class="table-wrap"><table class="table dense price-table">
        <thead><tr><th>id модели (префикс)</th><th class="num">вход</th><th class="num">выход</th><th class="num">чтение кэша</th><th class="num">запись 5 мин</th><th class="num">запись 1 ч</th><th></th></tr></thead>
        <tbody>${pricing.models.map((m, i) => html`<tr class=${used.has(m.id) ? 'used' : ''}>
          <td><input class="text-input mono" value=${m.id} onInput=${(e) => setModel(i, 'id', e.target.value)} />${used.has(m.id) ? html` <span class="pill">в данных</span>` : ''}</td>
          <td class="num"><input class="num-input" type="number" step="0.01" value=${m.in} onInput=${(e) => setModel(i, 'in', e.target.value)} /></td>
          <td class="num"><input class="num-input" type="number" step="0.01" value=${m.out} onInput=${(e) => setModel(i, 'out', e.target.value)} /></td>
          <td class="num"><input class="num-input" type="number" step="0.01" value=${m.cr} onInput=${(e) => setModel(i, 'cr', e.target.value)} /></td>
          <td class="num"><input class="num-input" type="number" step="0.01" placeholder=${(m.in * pricing.cw5mMult).toFixed(2)} value=${m.cw5m ?? ''} onInput=${(e) => setModel(i, 'cw5m', e.target.value)} /></td>
          <td class="num"><input class="num-input" type="number" step="0.01" placeholder=${(m.in * pricing.cw1hMult).toFixed(2)} value=${m.cw1h ?? ''} onInput=${(e) => setModel(i, 'cw1h', e.target.value)} /></td>
          <td><button class="btn small ghost" onClick=${() => removeModel(i)} title="Удалить строку">✕</button></td>
        </tr>`)}</tbody>
      </table></div>
      <div class="row-actions"><button class="btn small ghost" onClick=${addModel}>Добавить модель</button>
        ${P.unknownModels.length ? html`<span class="warn-text">Без цены: ${P.unknownModels.join(', ')}</span>` : ''}</div>
    </${Card}>

    <${Card} title="О программе">
      <div class="explain">
        <p>Токеноскоп читает транскрипты Claude Code (<span class="mono">~/.claude/projects/**/*.jsonl</span>) только на чтение, ничего не отправляет и не меняет. Пишет он только в сайдбары Claude Desktop, когда синхронизирует сессии между аккаунтами (экран «Аккаунты Claude»). Запросы дедуплицируются по <span class="mono">message.id</span>: один ответ API пишется в транскрипт несколькими строками с одинаковым usage.</p>
        <p>Названия сессий — из сайдбара Claude Desktop, иначе из заголовков в транскрипте. Кэш разбора — в папке данных приложения; «Разобрать всё заново» его сбрасывает.</p>
        <p class="muted">Сводка собрана ${fmtDateTime(ds.meta.generatedAt)}. Ctrl+R — обновить, F12 — инструменты разработчика.</p>
      </div>
    </${Card}>
  </div>`;
}
