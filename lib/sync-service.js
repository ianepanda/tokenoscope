'use strict';
// Синхронизация аккаунтов в главном процессе: держит свежий план, следит за main.log Claude и за
// сайдбарами, ведёт автосинхронизацию, мастер переключения аккаунта и «закрыть Claude и синхронизировать».
// Интерфейс получает всё одним объектом status() и событиями 'status' и 'progress'.
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const D = require('./desktop');
const { AccountSync, publicPlan } = require('./accsync');

const STORE_NEW_DELAY = 10000; // новая или удалённая запись сайдбара: пересчитать скоро
const STORE_CHANGE_DELAY = 120000; // запись изменилась (идёт работа в сессии): не чаще раза в 2 минуты
const ACTIVITY_EVERY = 30 * 60000; // одни только времена активности автоматом — не чаще раза в полчаса
const PERIODIC = 5 * 60000;

const significant = (ops) => ops.some((o) => o.kind === 'add' || (o.changes && o.changes.title));

class SyncService extends EventEmitter {
  constructor({ dataDir, settings, notify }) {
    super();
    this.settings = settings;
    this.notify = notify || (() => {});
    this.engine = new AccountSync({ dataDir, labels: () => this.settings.get().accountLabels || {} });
    this.env = this.engine.env;
    this.plan = null;
    this.planError = null;
    this.planning = null;
    this.replan = false;
    this.busy = null; // {trigger, progress, feed}
    this.flow = null; // мастер переключения
    this.waiting = null; // ждём закрытия Claude
    this.last = null; // итог последней синхронизации
    this.lastActivitySync = 0;
    this.watchers = [];
    this.timers = new Map();
    this.quietUntil = 0;
    this.lastAccountEvents = -1;
  }

  // --- состояние для интерфейса ------------------------------------------

  status() {
    const s = this.settings.get();
    return {
      plan: this.plan ? publicPlan(this.plan) : null,
      planError: this.planError,
      planning: !!this.planning,
      busy: this.busy,
      flow: this.flow,
      waiting: this.waiting,
      last: this.last,
      history: this.engine.history(),
      settings: { syncAuto: !!s.syncAuto, syncLaunchAfter: s.syncLaunchAfter !== false, background: !!s.background, autostart: !!s.autostart },
    };
  }

  push() {
    this.emit('status', this.status());
  }

  // Пересчёт плана. Одновременно идёт один; просьбы во время расчёта склеиваются в один повтор.
  async refresh() {
    if (this.planning) {
      this.replan = true;
      return this.planning;
    }
    this.planning = (async () => {
      try {
        this.plan = await this.engine.plan();
        this.planError = null;
      } catch (e) {
        this.planError = String(e.message || e);
      }
    })();
    this.push();
    try {
      await this.planning;
    } finally {
      this.planning = null;
    }
    if (this.replan) {
      this.replan = false;
      return this.refresh();
    }
    this.push();
    return this.plan;
  }

  later(key, ms, fn) {
    if (this.timers.has(key)) return;
    this.timers.set(key, setTimeout(() => {
      this.timers.delete(key);
      fn();
    }, ms));
  }

  // --- запись ------------------------------------------------------------

  async run({ trigger = 'manual', quiet = false } = {}) {
    if (this.busy) throw new Error('Синхронизация уже идёт');
    // законченный мастер переключения больше не нужен на экране
    if (trigger === 'manual' && this.flow && ['done', 'failed'].includes(this.flow.stage)) this.flow = null;
    this.busy = { trigger, progress: { phase: 'check' }, feed: [], startedAt: Date.now() };
    this.push();
    let res;
    try {
      res = await this.engine.apply({
        trigger,
        onProgress: (e) => {
          this.busy.progress = { phase: e.phase, done: e.done, total: e.total };
          if (e.op) {
            this.busy.feed.unshift(e.op);
            if (this.busy.feed.length > 12) this.busy.feed.length = 12;
          }
          this.emit('progress', this.busy);
        },
      });
      this.plan = res.plan;
      this.last = { at: Date.now(), trigger, result: res.result, written: res.written, skipped: res.skipped, left: res.left, aborted: res.aborted, summary: res.summary || null };
      if (res.written && res.summary) {
        const ops = res.summary.accounts;
        if (ops.some((a) => a.adds || a.renames)) this.lastActivitySync = Date.now();
        if (!quiet || ops.some((a) => a.adds || a.renames)) this.notify(notifyText(res.summary), trigger);
      }
      return this.last;
    } catch (e) {
      this.last = { at: Date.now(), trigger, result: 'error', error: String(e.message || e) };
      throw e;
    } finally {
      this.busy = null;
      this.quietUntil = Date.now() + 4000; // свои же записи не должны будить наблюдателя
      this.push();
    }
  }

  // Автосинхронизация: только если включена, ничего не идёт и есть что-то заметное (новые сессии или
  // названия). Одни времена активности — не чаще раза в полчаса.
  async maybeAuto(reason) {
    if (!this.settings.get().syncAuto || this.busy || !this.engine.canWrite()) return;
    const p = await this.refresh();
    if (!p || !p.ops.length) return;
    const forced = reason === 'switch' || reason === 'quit';
    if (!forced && !significant(p.ops) && Date.now() - this.lastActivitySync < ACTIVITY_EVERY) return;
    try {
      await this.run({ trigger: 'auto', quiet: true });
      if (!significant(p.ops)) this.lastActivitySync = Date.now();
    } catch (e) { /* ошибка видна в last */ }
  }

  // --- мастер переключения -------------------------------------------------

  async startSwitch(to) {
    const p = await this.refresh();
    const live = p && p.desktop.live;
    if (!live) throw new Error('Не видно, под каким аккаунтом открыт Claude — переключение начинается из открытого Claude');
    if (to === live) throw new Error('Claude уже открыт под этим аккаунтом');
    this.flow = { stage: 'prepare', from: live, to, startedAt: Date.now(), notes: [] };
    this.push();
    try {
      if (p.ops.length) await this.run({ trigger: 'switch' });
      this.flow.stage = 'logout';
      this.flow.preparedAt = Date.now();
    } catch (e) {
      this.flow.stage = 'failed';
      this.flow.error = String(e.message || e);
    }
    this.push();
  }

  cancelFlow() {
    this.flow = null;
    this.waiting = null;
    this.push();
  }

  // Что происходит с аккаунтом в Claude: двигает мастер, будит автосинхронизацию.
  async onAccountEvent() {
    const st = this.engine.tracker.state || {};
    const f = this.flow;
    if (f && ['logout', 'login'].includes(f.stage)) {
      if (st.signedOut) f.stage = 'login';
      else if (st.account && st.account !== f.from) {
        if (st.account !== f.to) f.notes.push(`вход выполнен под другим аккаунтом (${st.account.slice(0, 8)}) — синхронизирую с ним`);
        f.stage = 'back';
        f.landed = st.account;
        this.push();
        // приложению нужно несколько секунд, чтобы загрузить новый сайдбар
        await new Promise((r) => setTimeout(r, 5000));
        try {
          await this.refresh();
          if (this.plan && this.plan.ops.length) await this.run({ trigger: 'switch' });
          f.stage = 'done';
          f.doneAt = Date.now();
        } catch (e) {
          f.stage = 'failed';
          f.error = String(e.message || e);
        }
        this.push();
        return;
      }
      this.push();
    }
    this.maybeAuto('switch');
  }

  // --- закрыть Claude и синхронизировать ------------------------------------

  async closeAndSync() {
    if (this.flow && ['done', 'failed'].includes(this.flow.stage)) this.flow = null;
    const launchAfter = this.settings.get().syncLaunchAfter !== false;
    this.waiting = { since: Date.now(), launchAfter, stage: 'wait' };
    this.push();
    this.pollClosed();
  }

  async pollClosed() {
    if (!this.waiting) return;
    const st = await D.desktopState(this.env, this.engine.tracker);
    if (!this.waiting) return;
    if (st.running !== false) {
      this.waiting.procCount = st.procCount;
      this.push();
      this.timers.set('poll', setTimeout(() => {
        this.timers.delete('poll');
        this.pollClosed();
      }, 2000));
      return;
    }
    // приложение закрылось — дать ему дописать файлы сессий
    this.waiting.stage = 'closed';
    this.push();
    await new Promise((r) => setTimeout(r, 3000));
    if (!this.waiting) return;
    const { launchAfter } = this.waiting;
    this.waiting.stage = 'sync';
    try {
      await this.refresh();
      if (this.plan && this.plan.ops.length) await this.run({ trigger: 'close' });
    } catch (e) { /* видно в last */ }
    if (launchAfter) {
      const r = D.launchDesktop(this.env);
      if (this.last) this.last.launched = r.ok ? true : r.why;
    }
    this.waiting = null;
    this.push();
  }

  // --- наблюдатели -----------------------------------------------------------

  start() {
    this.stop();
    this.engine.tracker.reset();
    this.lastAccountEvents = this.engine.tracker.accountEvents;
    const logs = D.logFiles(this.env);
    if (logs.length) this.watch(path.dirname(logs[0]), false, (ev, file) => {
      if (file && !/^main\d*\.log$/i.test(String(file))) return;
      this.later('log', 1000, () => this.onLog());
    });
    for (const root of D.storeRoots(this.env)) {
      this.watch(root, true, (ev, file) => {
        if (Date.now() < this.quietUntil || this.busy) return;
        const name = String(file || '');
        if (!/local_[^\\/]+\.json$/.test(name) && !/deleted_/.test(name)) return;
        if (ev === 'rename') this.later('store-new', STORE_NEW_DELAY, () => this.onStore());
        else this.later('store-change', STORE_CHANGE_DELAY, () => this.onStore());
      });
    }
    this.periodic = setInterval(() => {
      if (this.settings.get().syncAuto) this.maybeAuto('periodic');
    }, PERIODIC);
    this.refresh().then(() => this.maybeAuto('start')).catch(() => {});
  }

  watch(dir, recursive, cb) {
    try {
      // Короткое имя 8.3 (C:\Users\ABCD~1\…) рекурсивный fs.watch в Windows роняет целиком: libuv сверяет
      // длинные пути событий с коротким путём папки и падает на assert. Поэтому — канонический длинный путь.
      const real = fs.realpathSync.native(dir);
      const w = fs.watch(real, { recursive }, cb);
      w.on('error', () => {});
      this.watchers.push(w);
    } catch (e) { /* папки нет */ }
  }

  stop() {
    for (const w of this.watchers) {
      try {
        w.close();
      } catch (e) { /* уже закрыт */ }
    }
    this.watchers = [];
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    if (this.periodic) clearInterval(this.periodic);
  }

  async onLog() {
    const before = this.lastAccountEvents;
    const st = this.engine.tracker.update();
    this.lastAccountEvents = this.engine.tracker.accountEvents;
    if (this.lastAccountEvents !== before) {
      await this.refresh();
      await this.onAccountEvent();
    } else if (st && st.event === 'quit') {
      // приложение закрывается: как только процессы уйдут, писать можно во все аккаунты
      this.watchQuit(0);
    }
  }

  async watchQuit(n) {
    const st = await D.desktopState(this.env, this.engine.tracker);
    if (st.running === false) {
      await new Promise((r) => setTimeout(r, 3000));
      await this.refresh();
      if (this.flow && ['logout', 'login'].includes(this.flow.stage)) await this.onAccountEvent();
      this.maybeAuto('quit');
      return;
    }
    if (n < 30) this.timers.set('quit', setTimeout(() => this.watchQuit(n + 1), 2000));
  }

  async onStore() {
    await this.refresh();
    this.maybeAuto('store');
  }
}

function plural(n, one, few, many) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

function notifyText(summary) {
  const parts = summary.accounts.map((a) => {
    const bits = [];
    if (a.adds) bits.push(`+${a.adds} ${plural(a.adds, 'сессия', 'сессии', 'сессий')}`);
    if (a.renames) bits.push(`${a.renames} ${plural(a.renames, 'переименование', 'переименования', 'переименований')}`);
    if (!bits.length && a.activity) bits.push(`обновлено время у ${a.activity}`);
    return `${a.label}: ${bits.join(', ')}`;
  });
  return parts.join('; ');
}

module.exports = { SyncService, notifyText, plural };
