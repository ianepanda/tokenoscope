// Аккаунты Claude Desktop: какие сессии есть в каком сайдбаре, что и куда переедет, синхронизация,
// мастер переключения аккаунта, автоматика и журнал с отменой.
import { html, useState, useEffect } from '../lib/h.js';
import { useApp } from '../lib/app-context.js';
import { Card, Segmented, Table, Pill, Empty } from '../lib/ui.js';
import { fmtInt, fmtDateTime, fmtAgo } from '../lib/format.js';

const plural = (n, one, few, many) => {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
};
const sessions = (n) => `${fmtInt(n)} ${plural(n, 'сессия', 'сессии', 'сессий')}`;
const errText = (e) => String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const leaf = (cwd) => String(cwd || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '';

const REASONS = {
  fork: 'старая ветка после rewind — различаю датой развилки',
  dup: 'другая сессия с тем же названием — различаю датой',
  title: 'название из другого аккаунта',
  pin: 'закрепляю название, заданное руками',
  activity: 'время последней активности из другого аккаунта',
};
const TRIGGERS = { manual: 'вручную', auto: 'автоматически', switch: 'при переключении', close: 'при закрытии Claude', tray: 'из трея', test: 'тест' };
const STATUS = { completed: 'готово', interrupted: 'прервана', undone: 'отменена', writing: 'идёт', journaled: 'записана в журнал' };

export function AccountsView() {
  const { go, ds } = useApp();
  // Ссылка на сессию из плана ведёт в её карточку, если Токеноскоп её знает.
  const openSession = (sid) => {
    const k = ds.sessions.findIndex((x) => x.id === sid);
    if (k >= 0) go({ view: 'session', session: k });
  };
  const [st, setSt] = useState(null);
  const [err, setErr] = useState(null);
  const [tab, setTab] = useState('add');
  const [editing, setEditing] = useState(null);
  const [labelDraft, setLabelDraft] = useState('');

  useEffect(() => {
    let alive = true;
    window.api.syncStatus().then((s) => alive && setSt(s)).catch((e) => setErr(errText(e)));
    const off1 = window.api.onSyncStatus((s) => setSt(s));
    const off2 = window.api.onSyncProgress((b) => setSt((s) => (s ? { ...s, busy: b } : s)));
    const t = setInterval(() => setSt((s) => (s ? { ...s } : s)), 30000); // «… назад» сами стареют
    return () => {
      alive = false;
      off1();
      off2();
      clearInterval(t);
    };
  }, []);

  const act = async (fn) => {
    setErr(null);
    try {
      const s = await fn();
      if (s && s.settings) setSt(s);
    } catch (e) {
      setErr(errText(e));
    }
  };
  const setOpt = (patch) => act(async () => {
    await window.api.setSettings(patch);
    return window.api.syncStatus();
  });

  if (!st) return html`<div class="view narrow"><${Card} title="Аккаунты Claude Desktop"><div class="muted">Смотрю сайдбары Claude Desktop…</div>${err && html`<div class="warn-text">${err}</div>`}</${Card}></div>`;

  const p = st.plan;
  if (!p) {
    return html`<div class="view narrow"><${Card} title="Аккаунты Claude Desktop">
      ${st.planError ? html`<div class="warn-text">Не удалось посмотреть сайдбары: ${st.planError}</div>` : html`<div class="muted">Читаю сайдбары и транскрипты…</div>`}
      <div class="row-actions"><button class="btn small" onClick=${() => act(() => window.api.syncRefresh())}>Повторить</button></div>
    </${Card}></div>`;
  }

  const accts = p.accounts.filter((a) => a.dest);
  const byId = Object.fromEntries(p.accounts.map((a) => [a.account, a]));
  const lab = (id) => (byId[id] ? byId[id].label : String(id || '').slice(0, 8));
  const busy = st.busy;
  const writingTo = busy && busy.feed && busy.feed[0] ? busy.feed[0].account : null;
  const problems = p.problems.filter((x) => !x.quiet);

  const startEdit = (a) => {
    setEditing(a.account);
    setLabelDraft(a.userLabel || '');
  };
  const saveLabel = (a) => {
    setEditing(null);
    act(() => window.api.syncSetLabel(a.account, labelDraft));
  };

  return html`<div class="view accounts-view">
    <${Card} title="Аккаунты Claude Desktop"
      subtitle="У каждого аккаунта свой сайдбар Code-сессий, а транскрипты общие. Синхронизация создаёт недостающие записи сайдбара — сами транскрипты не меняются."
      actions=${html`<button class="btn small ghost" disabled=${st.planning || busy} onClick=${() => act(() => window.api.syncRefresh())}>${st.planning ? 'Смотрю…' : 'Обновить'}</button>`}>
      <${DesktopLine} p=${p} lab=${lab} />
      ${p.sandbox && html`<div class="sbx-note">Песочница: пишу в копию сайдбаров <span class="mono">${p.sandbox}</span>, настоящие не трогаю.</div>`}
      ${!p.canWrite && html`<div class="insight warn"><div class="insight-icon">!</div><div class="insight-body"><div class="insight-title">Только просмотр</div><div class="insight-text">Запись в сайдбары Claude Desktop пока проверена только в Windows: здесь видно, чего где не хватает, но ничего не меняется.</div></div></div>`}
      ${problems.map((x) => html`<div class="sync-problem">${x.text}</div>`)}
      ${accts.length < 2 ? html`<${Empty}>${accts.length ? 'Найден один аккаунт — синхронизировать пока не с кем. Войди в Claude под вторым аккаунтом и открой там хотя бы одну Code-сессию: он появится здесь.' : 'Аккаунтов с Code-сессиями не найдено.'}</${Empty}>` : html`
        <div class=${'acct-flow' + (accts.length === 2 ? ' pair' : '')}>
          ${accts.length === 2
            ? html`<${AccountCard} a=${accts[0]} p=${p} writing=${writingTo === accts[0].account} editing=${editing} labelDraft=${labelDraft} setLabelDraft=${setLabelDraft} startEdit=${startEdit} saveLabel=${saveLabel} cancelEdit=${() => setEditing(null)} />
              <${FlowArrows} left=${accts[0]} right=${accts[1]} writingTo=${writingTo} />
              <${AccountCard} a=${accts[1]} p=${p} writing=${writingTo === accts[1].account} editing=${editing} labelDraft=${labelDraft} setLabelDraft=${setLabelDraft} startEdit=${startEdit} saveLabel=${saveLabel} cancelEdit=${() => setEditing(null)} />`
            : accts.map((a) => html`<${AccountCard} a=${a} p=${p} writing=${writingTo === a.account} editing=${editing} labelDraft=${labelDraft} setLabelDraft=${setLabelDraft} startEdit=${startEdit} saveLabel=${saveLabel} cancelEdit=${() => setEditing(null)} />`)}
        </div>
        <${Completeness} t=${p.totals} />`}
    </${Card}>

    ${(busy || st.waiting || st.flow || st.last || err) && html`<${ProgressCard} st=${st} p=${p} lab=${lab} err=${err} act=${act} />`}

    ${accts.length >= 2 && html`<${ActionsCard} st=${st} p=${p} accts=${accts} lab=${lab} act=${act} setOpt=${setOpt} />`}

    ${accts.length >= 2 && html`<${PlanCard} p=${p} lab=${lab} tab=${tab} setTab=${setTab} openSession=${openSession} />`}

    <${HistoryCard} st=${st} act=${act} />

    <${Card} title="Как это работает">
      <div class="explain how">
        <p><b>Куда пишется.</b> Только в аккаунты, под которыми Claude сейчас не открыт: приложение держит сайдбар текущего аккаунта в памяти и перезаписывает его, а чужой не трогает (видно по его журналу main.log). Поэтому закрывать Claude не нужно — текущий аккаунт получит своё, когда переключишься или закроешь Claude.</p>
        <p><b>Что переезжает.</b> Каждая сессия, у которой есть транскрипт и запись хотя бы в одном сайдбаре, появляется во всех. Запись собирается из транскрипта (папка, модель, время), а не копируется: чужие разрешения, MCP и вкладки Chrome не переносятся.</p>
        <p><b>Что не переезжает.</b> Удалённое в аккаунте туда не возвращается. Старая ветка после rewind не едет туда, где уже есть её продолжение. Без ответа модели или без рабочей папки запись собрать не из чего.</p>
        <p><b>Названия.</b> Заданное руками расходится по всем аккаунтам. Разные сессии с одинаковым названием различаются датой: старая ветка после rewind — «… (до ДД.ММ ЧЧ:ММ)», тёзка — «… (ДД.ММ ЧЧ:ММ)», самая свежая остаётся как есть.</p>
        <p><b>Если что-то не так.</b> Каждое изменение сначала записывается в журнал, последнюю синхронизацию можно отменить. Если Токеноскоп закроют посреди записи, при следующем запуске он сверит по байтам, что успело лечь. С claude-code-sessions (ccs) он не пишет одновременно: держит его блокировку.</p>
      </div>
    </${Card}>
  </div>`;
}

function DesktopLine({ p, lab }) {
  const d = p.desktop;
  let dot = 'off';
  let text;
  if (d.running === true && d.live) {
    dot = 'on';
    text = html`Claude открыт под <b>${lab(d.live)}</b> — в его сайдбар запишу, когда переключишься или закроешь Claude; в остальные — сразу.`;
  } else if (d.running === true && d.liveProblem === 'signed-out') {
    dot = 'warn';
    text = 'Claude открыт, но вход не выполнен — пока никто не вошёл, писать некуда: неизвестно, чей сайдбар он загрузит.';
  } else if (d.running === true && d.liveProblem === 'starting') {
    dot = 'warn';
    text = 'Claude запускается — подожду, пока он загрузит аккаунт.';
  } else if (d.running === true) {
    dot = 'warn';
    text = 'Claude открыт, но по его журналу не видно, под каким аккаунтом. Пока это так, писать безопасно только с закрытым Claude.';
  } else if (d.running === false) {
    text = 'Claude закрыт — писать можно во все аккаунты.';
  } else {
    dot = 'warn';
    text = 'Не удалось проверить, запущен ли Claude, — считаю, что запущен.';
  }
  return html`<div class="desktop-line"><span class=${'dl-dot ' + dot}></span><span>${text}</span>
    <span class="muted small dl-at">проверено ${fmtAgo(p.at)}</span></div>`;
}

function AccountCard({ a, p, writing, editing, labelDraft, setLabelDraft, startEdit, saveLabel, cancelEdit }) {
  const total = p.totals.conversations || 1;
  const present = a.have || 0;
  const seg = (v, cls, title) => (v > 0 ? html`<span class=${'ab-seg ' + cls} style=${{ flexGrow: v }} title=${title}></span>` : null);
  const missing = Math.max(0, total - present - a.addsNow - a.addsLater);
  const nameless = !a.userLabel && !a.email;
  const state = a.live ? html`<${Pill} tone="live">в Claude сейчас</${Pill}>`
    : a.writable ? html`<${Pill} tone="good">пишу сразу</${Pill}>` : html`<${Pill}>запишу позже</${Pill}>`;
  return html`<div class=${'acct-card' + (a.live ? ' is-live' : '') + (writing ? ' writing' : '')}>
    <div class="acct-head">
      ${editing === a.account
        ? html`<input class="text-input acct-label-input" value=${labelDraft} placeholder=${a.email || a.short} autofocus
            onInput=${(e) => setLabelDraft(e.target.value)}
            onKeyDown=${(e) => { if (e.key === 'Enter') saveLabel(a); if (e.key === 'Escape') cancelEdit(); }}
            onBlur=${() => saveLabel(a)} />`
        : html`<div class="acct-name" title=${a.account}>${a.label}</div>
          <button class=${'link small acct-rename' + (nameless ? ' always' : '')} onClick=${() => startEdit(a)} title="Своя подпись аккаунта: почта этого аккаунта неизвестна, пока под ним не войдёт Claude Code CLI">${nameless ? 'как назвать?' : 'подписать'}</button>`}
      <span class="acct-state">${state}</span>
    </div>
    ${a.label !== a.short && html`<div class="acct-sub muted small">${a.userLabel && a.email ? a.email + ' · ' : ''}${a.short}</div>`}
    <div class="acct-numbers">
      <div class="acct-big">${fmtInt(a.rows)}</div>
      <div class="acct-big-sub">${plural(a.rows, 'сессия', 'сессии', 'сессий')} в сайдбаре</div>
      ${a.addsNow > 0 && html`<div class="acct-in now">+${fmtInt(a.addsNow)} сейчас</div>`}
      ${a.addsLater > 0 && html`<div class="acct-in later">+${fmtInt(a.addsLater)} позже</div>`}
      ${!a.addsNow && !a.addsLater && html`<div class="acct-in ok">✓ все на месте</div>`}
    </div>
    <div class="acct-bar" title="Сессии с транскриптом: есть в сайдбаре / добавлю сейчас / добавлю позже / не переносятся">
      ${seg(present, 'have', `есть: ${present}`)}
      ${seg(a.addsNow, 'now', `добавлю сейчас: ${a.addsNow}`)}
      ${seg(a.addsLater, 'later', `добавлю позже: ${a.addsLater}`)}
      ${seg(missing, 'none', `не переносятся сюда: ${missing}`)}
    </div>
    <div class="acct-foot small">
      ${a.why ? html`<span class="muted">${a.why}</span>` : html`<span class="muted">${[
        a.updatesNow ? `обновлю записей: ${fmtInt(a.updatesNow)}` : null,
        a.holds ? `не переносится: ${a.holds}` : null,
      ].filter(Boolean).join(' · ') || 'свободен: Claude открыт под другим аккаунтом или закрыт'}</span>`}
    </div>
  </div>`;
}

// Две стрелки между парой аккаунтов: сколько едет в каждую сторону; пунктир — «позже», бегущие штрихи — пишу сейчас.
function FlowArrows({ left, right, writingTo }) {
  const arrow = (to, n, later, dir) => {
    const cls = 'fa-line' + (later && !n.now ? ' later' : '') + (writingTo === to.account ? ' moving' : '') + (!n.now && !n.later ? ' idle' : '');
    const label = n.now ? `+${fmtInt(n.now)}${n.later ? ` и ${fmtInt(n.later)} позже` : ''}` : n.later ? `+${fmtInt(n.later)} позже` : 'всё на месте';
    return html`<div class=${'fa-row ' + dir}>
      <svg viewBox="0 0 120 16" class=${cls} preserveAspectRatio="none">
        ${dir === 'right'
          ? html`<line x1="2" y1="8" x2="110" y2="8" /><path d="M108 3 L117 8 L108 13" />`
          : html`<line x1="10" y1="8" x2="118" y2="8" /><path d="M12 3 L3 8 L12 13" />`}
      </svg>
      <div class="fa-label">${label}</div>
    </div>`;
  };
  return html`<div class="flow-arrows">
    ${arrow(right, { now: right.addsNow, later: right.addsLater }, !right.writable, 'right')}
    ${arrow(left, { now: left.addsNow, later: left.addsLater }, !left.writable, 'left')}
  </div>`;
}

function Completeness({ t }) {
  const total = t.conversations || 1;
  const w = (v) => Math.max(0, (100 * v) / total) + '%';
  return html`<div class="completeness">
    <div class="cmp-head">
      <span><b>${fmtInt(t.completeNow)}</b> из ${fmtInt(t.conversations)} сессий открываются во всех аккаунтах</span>
      ${t.completeAfter > t.completeNow && html`<span class="cmp-after">→ после синхронизации <b>${fmtInt(t.completeAfter)}</b></span>`}
      ${t.completeEventually > t.completeAfter && html`<span class="cmp-ev">→ после переключения <b>${fmtInt(t.completeEventually)}</b></span>`}
    </div>
    <div class="cmp-bar">
      <span class="cmp-now" style=${{ width: w(t.completeNow) }}></span>
      <span class="cmp-plus" style=${{ width: w(t.completeAfter - t.completeNow) }}></span>
      <span class="cmp-later" style=${{ width: w(t.completeEventually - t.completeAfter) }}></span>
    </div>
    ${t.dead > 0 && html`<div class="muted small">Ещё ${fmtInt(t.dead)} ${plural(t.dead, 'запись указывает', 'записи указывают', 'записей указывают')} на транскрипты, которых уже нет на диске, — их не трогаю.</div>`}
  </div>`;
}

function ActionsCard({ st, p, accts, lab, act, setOpt }) {
  const s = st.settings;
  const busy = !!st.busy || !!st.waiting || (st.flow && !['done', 'failed'].includes(st.flow.stage));
  const n = p.ops.length;
  const d = p.desktop;
  const adds = p.ops.filter((o) => o.kind === 'add').length;
  const upd = n - adds;
  let reason = null;
  if (!p.canWrite) reason = 'Запись пока только в Windows.';
  else if (!n && p.pending.length) reason = `Сейчас писать нечего: оставшееся (${p.pending.length}) — в аккаунт, под которым открыт Claude.`;
  else if (!n) reason = 'Всё уже на месте.';
  const others = d.running === true && d.live ? accts.filter((a) => a.account !== d.live) : [];
  return html`<${Card} title="Синхронизация">
    <div class="sync-actions">
      <button class="btn primary big" disabled=${busy || !n || !p.canWrite} onClick=${() => act(() => window.api.syncRun())}>
        Синхронизировать${n ? html` <span class="btn-count">${adds ? `+${fmtInt(adds)}` : ''}${adds && upd ? ' · ' : ''}${upd ? `✎ ${fmtInt(upd)}` : ''}</span>` : ''}
      </button>
      ${others.map((a) => html`<button class="btn big" disabled=${busy || !p.canWrite} onClick=${() => act(() => window.api.syncSwitch(a.account))}
          title="Перенесу всё в этот аккаунт, подскажу выйти и войти в Claude, а после входа перенесу новое обратно">
        Переключиться на ${a.label} →</button>`)}
      ${d.running !== false && html`<button class="btn big ghost" disabled=${busy || !p.canWrite} onClick=${() => act(() => window.api.syncCloseAndSync())}
          title="Дождусь, пока закроешь Claude, синхронизирую все аккаунты, включая текущий, и запущу его снова">
        Закрыть Claude и синхронизировать всё</button>`}
      ${d.running === false && html`<button class="btn big ghost" onClick=${() => act(() => window.api.syncLaunch())}>Запустить Claude</button>`}
    </div>
    ${reason && html`<div class="muted small sync-reason">${reason}</div>`}
    <div class="sync-opts">
      <label class="check opt"><input type="checkbox" checked=${s.syncAuto} disabled=${!p.canWrite} onChange=${(e) => setOpt({ syncAuto: e.target.checked })} />
        <span><b>Синхронизировать автоматически</b><span class="muted small"> — новые сессии и названия расходятся по свободным аккаунтам сами, через несколько секунд после появления; при входе под другим аккаунтом — сразу.</span></span></label>
      <label class="check opt"><input type="checkbox" checked=${s.background} onChange=${(e) => setOpt({ background: e.target.checked })} />
        <span><b>Работать в фоне</b><span class="muted small"> — крестик прячет окно в трей, и автосинхронизация не останавливается.</span></span></label>
      <label class="check opt"><input type="checkbox" checked=${s.autostart} disabled=${!s.background} onChange=${(e) => setOpt({ autostart: e.target.checked })} />
        <span><b>Запускать вместе с системой</b><span class="muted small"> — сразу в трей, без окна (нужен фоновый режим; работает в собранном приложении).</span></span></label>
      <label class="check opt"><input type="checkbox" checked=${s.syncLaunchAfter} onChange=${(e) => setOpt({ syncLaunchAfter: e.target.checked })} />
        <span><b>Запускать Claude после «Закрыть и синхронизировать»</b></span></label>
    </div>
  </${Card}>`;
}

const PHASES = [
  { key: 'check', label: 'Проверяю Claude и сайдбары' },
  { key: 'facts', label: 'Читаю транскрипты' },
  { key: 'write', label: 'Записываю' },
  { key: 'verify', label: 'Сверяю результат' },
];

function ProgressCard({ st, p, lab, err, act }) {
  const b = st.busy;
  const f = st.flow;
  const w = st.waiting;
  return html`<${Card} title=${f ? `Переключение: ${lab(f.from)} → ${lab(f.to)}` : w ? 'Закрыть Claude и синхронизировать' : b ? 'Синхронизация' : 'Последняя синхронизация'} className="progress-card"
      actions=${(f || w) && html`<button class="btn small ghost" onClick=${() => act(() => window.api.syncCancel())}>${f && ['done', 'failed'].includes(f.stage) ? 'Закрыть' : 'Отменить'}</button>`}>
    ${err && html`<div class="sync-error">${err}</div>`}
    ${f && html`<${SwitchSteps} f=${f} lab=${lab} busy=${b} act=${act} />`}
    ${w && !f && html`<${WaitClose} w=${w} busy=${b} />`}
    ${b && html`<${Writing} b=${b} lab=${lab} />`}
    ${!b && st.last && html`<${LastResult} last=${st.last} lab=${lab} />`}
  </${Card}>`;
}

function Writing({ b, lab }) {
  const cur = PHASES.findIndex((x) => x.key === b.progress.phase);
  const pr = b.progress;
  const pct = pr.total ? Math.round((100 * (pr.done || 0)) / pr.total) : null;
  return html`<div class="writing">
    <div class="phases">
      ${PHASES.map((ph, i) => html`<div class=${'phase' + (i < cur || pr.phase === 'done' ? ' done' : i === cur ? ' on' : '')}>
        <span class="ph-dot">${i < cur || pr.phase === 'done' ? '✓' : i + 1}</span>
        <span>${ph.label}${i === cur && pr.total ? html` <span class="muted">${fmtInt(pr.done || 0)} из ${fmtInt(pr.total)}</span>` : ''}</span>
      </div>`)}
    </div>
    ${pct != null && html`<div class="progress big"><div class="progress-fill" style=${{ width: Math.max(2, pct) + '%' }}></div></div>`}
    <div class="feed">
      ${(b.feed || []).map((o, i) => html`<div class=${'feed-row' + (i === 0 ? ' fresh' : '') + (o.skipped ? ' skipped' : '')}>
        <span class=${'feed-icon ' + (o.kind === 'add' ? 'add' : 'upd')}>${o.kind === 'add' ? '+' : '✎'}</span>
        <span class="feed-title">${o.kind === 'update' && o.oldTitle && o.oldTitle !== o.title ? html`${o.oldTitle} <span class="muted">→</span> ${o.title}` : o.title || '(без названия)'}</span>
        <span class="feed-acct muted">${o.skipped ? o.skipped : '→ ' + lab(o.account)}</span>
      </div>`)}
    </div>
  </div>`;
}

function WaitClose({ w, busy }) {
  if (busy) return null;
  return html`<div class="wait-close">
    ${w.stage === 'wait' && html`<div class="big-instruction"><span class="spinner"></span>Закрой Claude: иконка в трее → <b>Quit</b>. Сначала дождись, пока в сессиях ничего не выполняется — закрытие их оборвёт.</div>
      <div class="muted small">Процессов Claude: ${w.procCount ?? '…'} · жду с ${fmtDateTime(w.since)}${w.launchAfter ? ' · после синхронизации запущу Claude снова' : ''}</div>`}
    ${w.stage === 'closed' && html`<div class="big-instruction"><span class="spinner"></span>Claude закрыт, даю ему пару секунд дописать файлы…</div>`}
    ${w.stage === 'sync' && html`<div class="big-instruction"><span class="spinner"></span>Синхронизирую все аккаунты…</div>`}
  </div>`;
}

function SwitchSteps({ f, lab, busy, act }) {
  const order = ['prepare', 'logout', 'login', 'back', 'done'];
  const at = f.stage === 'failed' ? -1 : order.indexOf(f.stage);
  const steps = [
    { label: html`Перенести всё в <b>${lab(f.to)}</b>`, sub: 'Claude закрывать не нужно' },
    { label: html`В Claude: <b>Settings → Log out</b>`, sub: html`<button class="link" onClick=${() => act(() => window.api.syncLaunch())}>Открыть Claude</button>` },
    { label: html`Войти как <b>${lab(f.to)}</b>`, sub: 'жду входа по журналу Claude' },
    { label: html`Перенести новое в <b>${lab(f.from)}</b>`, sub: 'теперь свободен он' },
  ];
  return html`<div class="switch-steps">
    ${steps.map((s, i) => {
      const done = at > i || f.stage === 'done';
      const on = at === i;
      return html`<div class=${'sw-step' + (done ? ' done' : on ? ' on' : '')}>
        <span class="ph-dot">${done ? '✓' : on ? html`<span class="spinner small"></span>` : i + 1}</span>
        <div><div>${s.label}</div><div class="muted small">${s.sub}</div></div>
      </div>`;
    })}
    ${f.stage === 'done' && html`<div class="sw-done">Готово: Claude открыт под ${lab(f.landed || f.to)}, все сессии на месте в обоих аккаунтах.</div>`}
    ${f.stage === 'failed' && html`<div class="sync-error">Переключение остановлено: ${f.error}</div>`}
    ${(f.notes || []).map((n) => html`<div class="muted small">${n}</div>`)}
  </div>`;
}

function LastResult({ last, lab }) {
  if (last.result === 'error') return html`<div class="sync-error">${fmtDateTime(last.at)}: ${last.error}</div>`;
  if (last.result === 'undone') {
    const u = last.undo || {};
    return html`<div class="last-result">Отменено: удалено записей ${u.deleted || 0}, возвращено прежних значений ${u.restored || 0}${u.gone ? `, уже не было ${u.gone}` : ''}.
      ${(u.skipped || []).length ? html`<div class="muted small">Не тронуто: ${u.skipped.map((x) => `«${x.title}» — ${x.why}`).join('; ')}</div>` : ''}</div>`;
  }
  if (last.result === 'nothing') return html`<div class="last-result muted">${fmtDateTime(last.at)}: писать было нечего — всё уже на месте.</div>`;
  const acc = (last.summary && last.summary.accounts) || [];
  return html`<div class="last-result">
    <div class=${'lr-head ' + (last.result === 'ok' ? 'ok' : 'warn')}>${last.result === 'ok' ? '✓ Готово' : last.result === 'aborted' ? 'Остановлено' : 'Готово не всё'} · ${TRIGGERS[last.trigger] || last.trigger} · ${fmtAgo(last.at)}</div>
    ${acc.map((a) => html`<div>${lab(a.account)}: ${[a.adds ? `добавлено ${sessions(a.adds)}` : null, a.renames ? `переименовано ${a.renames}` : null, a.activity ? `обновлено время у ${a.activity}` : null].filter(Boolean).join(', ')}</div>`)}
    ${last.aborted && html`<div class="warn-text small">${last.aborted}</div>`}
    ${last.left > 0 && html`<div class="warn-text small">После записи план ещё видит ${last.left} — нажми «Обновить» и посмотри, что осталось.</div>`}
    ${last.skipped > 0 && html`<div class="muted small">Пропущено: ${last.skipped} (подробности в журнале)</div>`}
    ${last.launched === true && html`<div class="muted small">Claude запущен.</div>`}
    ${typeof last.launched === 'string' && html`<div class="warn-text small">Claude не запустился: ${last.launched}</div>`}
  </div>`;
}

function PlanCard({ p, lab, tab, setTab, openSession }) {
  const adds = p.ops.filter((o) => o.kind === 'add');
  const renames = p.ops.filter((o) => o.kind === 'update' && o.changes.title);
  const times = p.ops.filter((o) => o.kind === 'update' && !o.changes.title);
  const skipped = [
    ...p.holds.map((h) => ({ ...h, why: h.detail })),
    ...p.skipped.deleted.map((x) => ({ ...x, why: 'удалена в этом аккаунте — не возвращаю' })),
    ...p.skipped.superseded.map((x) => ({ ...x, why: 'старая ветка после rewind: здесь уже есть её продолжение' })),
  ];
  const tabs = [
    { key: 'add', label: `Добавить · ${adds.length}`, rows: adds },
    { key: 'rename', label: `Переименовать · ${renames.length}`, rows: renames },
    { key: 'time', label: `Время · ${times.length}`, rows: times },
    { key: 'later', label: `Позже · ${p.pending.length}`, rows: p.pending },
    { key: 'skip', label: `Не переносится · ${skipped.length}`, rows: skipped },
  ];
  const cur = tabs.find((t) => t.key === tab) || tabs[0];
  const titleCell = (o) => html`<div class="cell-title" title=${o.session}>${o.kind === 'update' && o.changes && o.changes.title
    ? html`<span class="old-title">${o.oldTitle || '(без названия)'}</span> → ${o.title}` : o.title || html`<span class="muted">(без названия)</span>`}</div>
    <div class="cell-sub">${leaf(o.cwd)}${o.session ? html` · <button class="link" title="Открыть карточку сессии" onClick=${(e) => { e.stopPropagation(); openSession(o.session); }}>${o.session.slice(0, 8)}</button>` : ''}</div>`;
  const detail = (o) => {
    if (o.why) return o.why;
    if (o.kind === 'add') return o.from && o.from.length ? `есть в ${o.from.map(lab).join(', ')}` : '';
    const bits = [REASONS[o.reason] || ''];
    if (o.changes && o.changes.lastActivityAt) bits.push(`активность ${fmtDateTime(o.changes.lastActivityAt[0])} → ${fmtDateTime(o.changes.lastActivityAt[1])}`);
    return bits.filter(Boolean).join(' · ');
  };
  const cols = [
    { key: 'title', label: 'Сессия', render: titleCell, sort: (o) => o.title || '' },
    { key: 'account', label: 'Куда', render: (o) => lab(o.account), sort: (o) => lab(o.account) },
    { key: 'detail', label: 'Почему', render: (o) => html`<span class="small">${detail(o)}</span>`, sortable: false },
    { key: 'activity', label: 'Активность', align: 'right', render: (o) => fmtDateTime(o.activity), sort: (o) => o.activity || 0 },
  ];
  return html`<${Card} title="Что изменится" subtitle="План пересчитывается перед каждой записью: пишется то, что верно на тот момент.">
    <${Segmented} small options=${tabs.map(({ key, label }) => ({ key, label }))} value=${cur.key} onChange=${setTab} />
    <div class="plan-table"><${Table} columns=${cols} rows=${cur.rows} initialSort=${{ key: 'activity', dir: -1 }} limit=${50} dense
      empty=${cur.key === 'add' ? 'Добавлять нечего' : cur.key === 'later' ? 'Отложенного нет' : 'Пусто'} /></div>
  </${Card}>`;
}

function HistoryCard({ st, act }) {
  const h = st.history || [];
  if (!h.length) return null;
  const cols = [
    { key: 'created', label: 'Когда', render: (r) => fmtDateTime(r.created), sort: (r) => r.created },
    { key: 'trigger', label: 'Как', render: (r) => TRIGGERS[r.trigger] || r.trigger, sortable: false },
    {
      key: 'what', label: 'Что сделано', sortable: false,
      render: (r) => html`<span class="small">${r.accounts.length ? r.accounts.map((a) => `${a.label}: ${[a.adds ? '+' + a.adds : null, a.renames ? '✎' + a.renames : null, a.activity ? '◷' + a.activity : null].filter(Boolean).join(' ')}`).join(' · ') : '—'}</span>`,
    },
    {
      key: 'status', label: 'Итог', sortable: false,
      render: (r) => html`<span>${STATUS[r.status] || r.status}${r.result && r.result.aborted ? html` <span class="muted small">(${r.result.aborted})</span>` : ''}</span>`,
    },
    {
      key: 'undo', label: '', sortable: false,
      render: (r) => (r.undoable ? html`<button class="btn small ghost" disabled=${!!st.busy} onClick=${() => { if (confirm('Отменить эту синхронизацию? Добавленные записи удалятся, переименования вернутся.')) act(() => window.api.syncUndo(r.opId)); }}>Отменить</button>` : null),
    },
  ];
  return html`<${Card} title="Журнал" subtitle="Последние синхронизации; отменить можно последнюю."
      actions=${html`<button class="btn small ghost" onClick=${() => window.api.syncOpenJournal()}>Открыть папку журнала</button>`}>
    <${Table} columns=${cols} rows=${h} initialSort=${{ key: 'created', dir: -1 }} limit=${10} dense />
  </${Card}>`;
}
