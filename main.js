'use strict';
const { app, BrowserWindow, ipcMain, shell, clipboard, dialog, nativeTheme, Tray, Menu, Notification, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const { Scanner } = require('./lib/scanner');
const { buildDataset } = require('./lib/dataset');
const { readSidebar } = require('./lib/sidebar');
const { Settings } = require('./lib/settings');
const { readTranscript, readBlock, readJournal, readScript } = require('./lib/transcript');
const { buildExport } = require('./lib/export');
const { SyncService } = require('./lib/sync-service');
const { launchDesktop } = require('./lib/desktop');

app.setName('Токеноскоп');
// Один идентификатор с ярлыком — окно группируется на панели задач под иконкой приложения.
if (process.platform === 'win32') app.setAppUserModelId('ru.andreev.tokenoscope');

let win = null;
let settings = null;
let scanner = null;
let dataset = null;
let scanStats = null;
let scanning = null;
let rescanQueued = false;
let watchers = [];
let watchTimer = null;
let lastAutoScan = 0;
const AUTO_MIN_GAP = 20000;
// Файлы, сохранённые экспортом: открыть их или показать в папке можно, хотя они вне папок с транскриптами.
const exported = new Set();
let sync = null;
let tray = null;
let quitting = false;
// Запуск вместе с системой: окно не показываем, Токеноскоп сидит в трее и синхронизирует аккаунты.
const START_HIDDEN = process.argv.includes('--hidden');

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function makeScanner() {
  const s = settings.get();
  scanner = new Scanner({ roots: s.roots, cacheFile: path.join(app.getPath('userData'), 'parse-cache.bin') });
}

async function runScan({ clearCache } = {}) {
  if (scanning) {
    rescanQueued = true;
    return scanning;
  }
  scanning = (async () => {
    if (clearCache) scanner.clearCache();
    const t0 = Date.now();
    const scan = await scanner.scan((p) => send('scan:progress', p));
    send('scan:progress', { phase: 'build' });
    const sidebar = readSidebar(sync ? sync.env : undefined);
    dataset = buildDataset(scan, sidebar);
    scanStats = { ...scan.stats, totalMs: Date.now() - t0, roots: scanner.roots };
    dataset.meta.scan = scanStats;
    send('scan:progress', { phase: 'done' });
    return dataset;
  })();
  try {
    return await scanning;
  } finally {
    scanning = null;
    if (rescanQueued) {
      rescanQueued = false;
      runScan().then((d) => send('dataset:updated', d)).catch(() => {});
    }
  }
}

function stopWatch() {
  for (const w of watchers) {
    try {
      w.close();
    } catch (e) { /* ignore */ }
  }
  watchers = [];
}

// Живое обновление: транскрипты дописываются по ходу сессий.
function startWatch() {
  stopWatch();
  if (!settings.get().watch) return;
  for (const root of scanner.roots) {
    try {
      const w = fs.watch(root, { recursive: true }, (_ev, file) => {
        if (file && !String(file).endsWith('.jsonl')) return;
        if (watchTimer) return; // уже запланировано: троттлинг, а не дебаунс — во время длинного хода записи идут непрерывно
        const wait = Math.max(4000, AUTO_MIN_GAP - (Date.now() - lastAutoScan));
        watchTimer = setTimeout(() => {
          watchTimer = null;
          lastAutoScan = Date.now();
          runScan().then((d) => send('dataset:updated', d)).catch(() => {});
        }, wait);
      });
      w.on('error', () => {});
      watchers.push(w);
    } catch (e) { /* корня нет — пропускаем */ }
  }
}

function isKnownPath(p) {
  if (typeof p !== 'string') return false;
  const norm = path.resolve(p).toLowerCase();
  return scanner.roots.some((r) => norm.startsWith(path.resolve(r).toLowerCase() + path.sep));
}

// Режим снимка для проверки вёрстки: electron . --capture=out.png [--view=sessions] [--size=1440x920] [--theme=dark] [--session=<id>]
function argOf(name) {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : null;
}
const CAPTURE = argOf('capture');
if (CAPTURE) app.setPath('userData', path.join(app.getPath('temp'), 'tokenoscope-capture'));
// Один экземпляр: два трея и две автосинхронизации над одними сайдбарами ни к чему.
const GOT_LOCK = !!CAPTURE || app.requestSingleInstanceLock();

function createWindow() {
  const theme = argOf('theme') || settings.get().theme;
  nativeTheme.themeSource = theme === 'light' || theme === 'dark' ? theme : 'system';
  const [cw, ch] = (argOf('size') || '1440x920').split('x').map(Number);
  win = new BrowserWindow({
    width: cw || 1440,
    height: ch || 920,
    show: !CAPTURE && !(START_HIDDEN && settings.get().background),
    minWidth: 1024,
    minHeight: 680,
    title: 'Токеноскоп',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0d0d0d' : '#f9f9f7',
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Скрытое окно снимка иначе не перерисовывается, и capturePage отдаёт старый кадр.
      backgroundThrottling: !CAPTURE,
    },
  });
  win.removeMenu();
  const query = {};
  for (const k of ['view', 'session', 'theme', 'scroll', 'open']) if (argOf(k)) query[k] = argOf(k);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'), { query });
  if (CAPTURE) {
    win.webContents.on('console-message', (e) => {
      const { level, message } = e;
      if (level === 'error' || level === 'warning' || level === 3 || level === 2) process.stdout.write(`[renderer ${level}] ${message}\n`);
    });
    win.webContents.once('did-finish-load', async () => {
      // Ждём, пока рендерер получит датасет и дорисует.
      for (let i = 0; i < 240; i++) {
        const ready = await win.webContents.executeJavaScript('!!document.querySelector(".view")').catch(() => false);
        if (ready) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      await new Promise((r) => setTimeout(r, +(argOf('delay') || 1200)));
      await win.webContents.executeJavaScript('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))').catch(() => {});
      const img = await win.webContents.capturePage();
      fs.writeFileSync(path.resolve(CAPTURE), img.toPNG());
      app.quit();
    });
  }
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  // В фоновом режиме крестик прячет окно в трей: автосинхронизация аккаунтов продолжает работать.
  win.on('close', (e) => {
    if (!quitting && !CAPTURE && settings.get().background && tray) {
      e.preventDefault();
      win.hide();
    }
  });
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i'))) {
      win.webContents.toggleDevTools();
    }
    // На macOS — Cmd+R: заодно перехватывает перезагрузку страницы из стандартного меню.
    const mod = process.platform === 'darwin' ? input.meta : input.control;
    if (input.type === 'keyDown' && mod && input.key.toLowerCase() === 'r') {
      e.preventDefault();
      runScan().then((d) => send('dataset:updated', d)).catch(() => {});
    }
  });
}

function showWindow(view) {
  if (!win || win.isDestroyed()) createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  if (view) send('nav', view);
}

// Системное уведомление о фоновой синхронизации: когда окно на виду, хватает экрана «Аккаунты».
function notify(text, trigger) {
  if (CAPTURE || trigger === 'manual' || !Notification.isSupported()) return;
  if (win && !win.isDestroyed() && win.isVisible() && win.isFocused()) return;
  const n = new Notification({ title: 'Токеноскоп: сессии синхронизированы', body: text, silent: true });
  n.on('click', () => showWindow('accounts'));
  n.show();
}

function trayIcon() {
  const ico = path.join(__dirname, 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png');
  const img = nativeImage.createFromPath(ico);
  return process.platform === 'darwin' ? img.resize({ width: 18, height: 18 }) : img;
}

function updateTray() {
  const want = settings.get().background && !CAPTURE;
  if (!want) {
    if (tray) tray.destroy();
    tray = null;
    return;
  }
  if (!tray) {
    tray = new Tray(trayIcon());
    tray.setToolTip('Токеноскоп');
    tray.on('click', () => showWindow());
  }
  const s = settings.get();
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Открыть Токеноскоп', click: () => showWindow() },
    { label: 'Аккаунты Claude…', click: () => showWindow('accounts') },
    { label: 'Синхронизировать сессии сейчас', click: () => sync && sync.run({ trigger: 'tray' }).catch(() => {}) },
    { type: 'separator' },
    { label: 'Синхронизировать автоматически', type: 'checkbox', checked: !!s.syncAuto, click: (mi) => applySettings({ syncAuto: mi.checked }) },
    { type: 'separator' },
    { label: 'Выход', click: () => { quitting = true; app.quit(); } },
  ]));
}

function applyLoginItem() {
  if (CAPTURE || process.platform === 'linux' || !app.isPackaged) return;
  const s = settings.get();
  app.setLoginItemSettings({ openAtLogin: !!(s.autostart && s.background), args: ['--hidden'] });
}

// Побочные эффекты настроек, общие для окна и трея.
function applySettings(patch) {
  const before = settings.get();
  const next = settings.set(patch || {});
  if (patch && patch.theme) nativeTheme.themeSource = next.theme === 'light' || next.theme === 'dark' ? next.theme : 'system';
  if (patch && patch.roots && JSON.stringify(before.roots) !== JSON.stringify(next.roots)) {
    makeScanner();
    startWatch();
    runScan().then((d) => send('dataset:updated', d)).catch(() => {});
  } else if (patch && 'watch' in patch) {
    startWatch();
  }
  if (patch && ('background' in patch || 'autostart' in patch || 'syncAuto' in patch)) {
    updateTray();
    applyLoginItem();
  }
  if (patch && patch.accountLabels && sync) sync.refresh().catch(() => {});
  if (patch && patch.syncAuto && sync) sync.maybeAuto('enable').catch(() => {});
  if (patch && ('syncAuto' in patch || 'syncLaunchAfter' in patch || 'background' in patch || 'autostart' in patch) && sync) sync.push();
  return next;
}

app.whenReady().then(() => {
  if (!GOT_LOCK) return;
  settings = new Settings(path.join(app.getPath('userData'), 'settings.json'));
  makeScanner();
  sync = new SyncService({ dataDir: path.join(app.getPath('userData'), 'account-sync'), settings, notify });
  sync.on('status', (st) => send('sync:status', st));
  sync.on('progress', (b) => send('sync:progress', b));
  const syncCall = (fn) => async (...args) => {
    await fn(...args);
    return sync.status();
  };
  ipcMain.handle('sync:status', () => {
    if (!sync.plan && !sync.planning) sync.refresh().catch(() => {});
    return sync.status();
  });
  ipcMain.handle('sync:refresh', syncCall(() => sync.refresh()));
  ipcMain.handle('sync:run', syncCall(() => sync.run({ trigger: 'manual' })));
  ipcMain.handle('sync:switch', syncCall((_e, to) => sync.startSwitch(String(to || '').toLowerCase())));
  ipcMain.handle('sync:closeAndSync', syncCall(() => sync.closeAndSync()));
  ipcMain.handle('sync:cancel', syncCall(() => sync.cancelFlow()));
  ipcMain.handle('sync:undo', syncCall(async (_e, opId) => {
    const report = await sync.engine.undo(String(opId || ''));
    sync.last = { at: Date.now(), trigger: 'undo', result: 'undone', undo: report };
    await sync.refresh();
  }));
  ipcMain.handle('sync:launch', () => launchDesktop(sync.env));
  ipcMain.handle('sync:setLabel', (_e, account, label) => {
    const labels = { ...(settings.get().accountLabels || {}) };
    const key = String(account || '').toLowerCase();
    if (!/^[0-9a-f-]{36}$/.test(key)) return sync.status();
    if (typeof label === 'string' && label.trim()) labels[key] = label.trim().slice(0, 60);
    else delete labels[key];
    applySettings({ accountLabels: labels });
    return sync.status();
  });
  // Папку сайдбара можно открыть, только если это одна из найденных папок аккаунтов.
  ipcMain.handle('sync:openStore', (_e, account) => {
    const a = sync.plan && sync.plan.accounts.find((x) => x.account === account && x.path);
    if (a) shell.openPath(a.path);
  });
  ipcMain.handle('sync:openJournal', () => {
    fs.mkdirSync(sync.engine.opsDir, { recursive: true });
    shell.openPath(sync.engine.opsDir);
  });

  ipcMain.handle('dataset:get', async () => dataset || runScan());
  ipcMain.handle('scan:run', async (_e, opts) => runScan({ clearCache: !!(opts && opts.clearCache) }));
  ipcMain.handle('settings:get', () => settings.get());
  ipcMain.handle('settings:set', async (_e, patch) => applySettings(patch));
  const guard = (p, ext) => {
    if (!isKnownPath(p) || !String(p).toLowerCase().endsWith(ext)) throw new Error('Путь вне папок с транскриптами');
    return path.resolve(p);
  };
  ipcMain.handle('transcript:read', (_e, p) => readTranscript(guard(p, '.jsonl')));
  ipcMain.handle('transcript:block', (_e, p, ln, bi) => readBlock(guard(p, '.jsonl'), ln, bi));
  ipcMain.handle('journal:read', (_e, p) => readJournal(guard(p, '.jsonl')));
  ipcMain.handle('script:read', (_e, p) => readScript(guard(p, '.js')));
  // Экспорт транскрипта: сначала сборка — из неё имя файла по умолчанию, и ошибка всплывёт до диалога
  // (даже 40 МБ транскрипта собираются за полсекунды), потом диалог сохранения.
  ipcMain.handle('transcript:export', async (_e, p, format, meta) => {
    const file = guard(p, '.jsonl');
    const fmt = format === 'html' ? 'html' : 'md';
    const out = buildExport(file, fmt, meta);
    const last = settings.get().exportDir;
    const dir = last && fs.existsSync(last) ? last : app.getPath('documents');
    const r = await dialog.showSaveDialog(win, {
      title: fmt === 'html' ? 'Сохранить транскрипт в HTML' : 'Сохранить транскрипт в Markdown',
      defaultPath: path.join(dir, out.fileName),
      filters: [fmt === 'html' ? { name: 'HTML', extensions: ['html'] } : { name: 'Markdown', extensions: ['md'] }],
    });
    if (r.canceled || !r.filePath) return null;
    fs.writeFileSync(r.filePath, out.content, 'utf8');
    exported.add(path.resolve(r.filePath).toLowerCase());
    settings.set({ exportDir: path.dirname(r.filePath) });
    return { path: r.filePath };
  });
  const isExported = (p) => typeof p === 'string' && exported.has(path.resolve(p).toLowerCase());
  ipcMain.handle('export:open', (_e, p) => {
    if (isExported(p)) shell.openPath(path.resolve(p));
  });
  ipcMain.handle('export:reveal', (_e, p) => {
    if (isExported(p)) shell.showItemInFolder(path.resolve(p));
  });
  ipcMain.handle('shell:showItem', (_e, p) => {
    if (isKnownPath(p)) shell.showItemInFolder(path.resolve(p));
  });
  ipcMain.handle('shell:openExternal', (_e, url) => {
    if (typeof url === 'string' && /^https:\/\//.test(url)) shell.openExternal(url);
  });
  ipcMain.handle('clipboard:write', (_e, text) => {
    if (typeof text === 'string') clipboard.writeText(text);
  });
  ipcMain.handle('dialog:pickFolder', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });

  createWindow();
  if (!CAPTURE) startWatch();
  updateTray();
  applyLoginItem();
  // Наблюдение за аккаунтами — после первого разбора транскриптов, чтобы не толкаться с ним за диск.
  setTimeout(() => sync.start(), CAPTURE ? 0 : 4000);
});

// Второй запуск (ярлык, автозапуск) поднимает уже открытое окно, а сам выходит.
if (GOT_LOCK) app.on('second-instance', () => showWindow());
else app.quit();

app.on('before-quit', () => {
  quitting = true;
});

app.on('window-all-closed', () => {
  stopWatch();
  if (sync) sync.stop();
  app.quit();
});
