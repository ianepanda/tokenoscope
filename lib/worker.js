'use strict';
// Worker-поток: разбирает файлы по одному, отвечает результатом или ошибкой.
const { parentPort } = require('worker_threads');
const { parseFile } = require('./parser');

parentPort.on('message', (job) => {
  try {
    const result = parseFile(job.path, { sidechain: job.sidechain });
    parentPort.postMessage({ id: job.id, result });
  } catch (err) {
    parentPort.postMessage({ id: job.id, error: String((err && err.stack) || err) });
  }
});
