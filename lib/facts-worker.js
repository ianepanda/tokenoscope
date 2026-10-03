'use strict';
// Worker-поток для lib/accsync.js: читает транскрипты, не занимая главный процесс.
const { parentPort, workerData } = require('worker_threads');
const { transcriptFacts } = require('./facts');

const out = [];
for (const file of workerData.files) {
  try {
    out.push({ file, facts: transcriptFacts(file) });
  } catch (e) {
    out.push({ file, error: { code: e.code || 'error', message: String(e.message || e) } });
  }
  if (out.length % 20 === 0) parentPort.postMessage({ progress: out.length });
}
parentPort.postMessage({ done: out });
