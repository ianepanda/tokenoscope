'use strict';
// Настройки: корни транскриптов, цены (в эквиваленте API, $ за MTok), неделя лимита, тема.
const fs = require('fs');
const os = require('os');
const path = require('path');

// Цены первого лица Anthropic API на 27.09.2026. Запись в кэш: 5 мин = 1,25 × input, 1 ч = 2 × input.
// Быстрый режим (usage.speed = "fast") — множитель ко всем ставкам.
const DEFAULT_PRICING = {
  cw5mMult: 1.25,
  cw1hMult: 2,
  fastMult: 2,
  models: [
    { id: 'claude-fable-5-1', in: 10, out: 50, cr: 0.25 },
    { id: 'claude-mythos-5-1', in: 10, out: 50, cr: 0.25 },
    { id: 'claude-fable-5', in: 10, out: 50, cr: 1 },
    { id: 'claude-mythos-5', in: 10, out: 50, cr: 1 },
    { id: 'claude-opus-5-5', in: 4, out: 20, cr: 0.2 },
    { id: 'claude-opus-5', in: 5, out: 25, cr: 0.5 },
    { id: 'claude-opus-4-8', in: 5, out: 25, cr: 0.5 },
    { id: 'claude-opus-4-7', in: 5, out: 25, cr: 0.5 },
    { id: 'claude-opus-4-6', in: 5, out: 25, cr: 0.5 },
    { id: 'claude-opus-4-5', in: 5, out: 25, cr: 0.5 },
    { id: 'claude-opus-4-1', in: 15, out: 75, cr: 1.5 },
    { id: 'claude-opus-4', in: 15, out: 75, cr: 1.5 },
    { id: 'claude-sonnet-5', in: 2, out: 10, cr: 0.2 },
    { id: 'claude-sonnet-4-6', in: 3, out: 15, cr: 0.3 },
    { id: 'claude-sonnet-4-5', in: 3, out: 15, cr: 0.3 },
    { id: 'claude-sonnet-4', in: 3, out: 15, cr: 0.3 },
    { id: 'claude-haiku-4-5', in: 1, out: 5, cr: 0.1 },
    { id: 'claude-3-5-haiku', in: 0.8, out: 4, cr: 0.08 },
  ],
  fallback: { in: 5, out: 25, cr: 0.5 },
};

function defaults() {
  return {
    roots: [path.join(os.homedir(), '.claude', 'projects')],
    pricing: JSON.parse(JSON.stringify(DEFAULT_PRICING)),
    // Сброс недельного лимита: день недели (0 = воскресенье) и час по местному времени.
    weekReset: { day: 0, hour: 0 },
    theme: 'system',
    watch: true,
    // Папка последнего экспорта транскрипта: диалог сохранения открывается в ней.
    exportDir: null,
  };
}

class Settings {
  constructor(file) {
    this.file = file;
    this.data = defaults();
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      this.data = { ...this.data, ...saved };
      if (!Array.isArray(this.data.roots) || !this.data.roots.length) this.data.roots = defaults().roots;
      if (!this.data.pricing || !Array.isArray(this.data.pricing.models)) this.data.pricing = defaults().pricing;
    } catch (e) {
      // первый запуск
    }
  }

  get() {
    return JSON.parse(JSON.stringify(this.data));
  }

  set(patch) {
    const next = { ...this.data, ...patch };
    if (patch.resetPricing) {
      next.pricing = defaults().pricing;
      delete next.resetPricing;
    }
    this.data = next;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    } catch (e) { /* ignore */ }
    return this.get();
  }
}

module.exports = { Settings, DEFAULT_PRICING, defaults };
