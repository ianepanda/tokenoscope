// Экспорт транскрипта без Electron — то же, что «Сохранить» в просмотре транскрипта.
// node scripts/export.js <файл.jsonl | id сессии или его начало> [--format=md|html] [--out=путь]
// Без --out файл ложится в out/ под тем же именем, что предложил бы диалог сохранения.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildExport } = require('../lib/export');

const argOf = (name) => {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : null;
};
const target = process.argv.slice(2).find((a) => !a.startsWith('--'));
if (!target) {
  console.error('node scripts/export.js <файл.jsonl | id сессии> [--format=md|html] [--out=путь]');
  process.exit(2);
}

// Основной поток сессии лежит прямо в папке проекта: ~/.claude/projects/<проект>/<id>.jsonl
function findSession(prefix) {
  const root = path.join(os.homedir(), '.claude', 'projects');
  const hits = [];
  for (const dir of fs.readdirSync(root, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    for (const name of fs.readdirSync(path.join(root, dir.name))) {
      if (name.endsWith('.jsonl') && name.startsWith(prefix)) hits.push(path.join(root, dir.name, name));
    }
  }
  if (hits.length > 1) throw new Error(`id ${prefix} подходит к ${hits.length} сессиям:\n${hits.join('\n')}`);
  if (!hits.length) throw new Error(`Сессия ${prefix} не найдена в ${root}`);
  return hits[0];
}

const file = target.endsWith('.jsonl') && fs.existsSync(target) ? path.resolve(target) : findSession(target);
const format = argOf('format') === 'html' ? 'html' : 'md';
const t0 = Date.now();
const out = buildExport(file, format);
const dest = path.resolve(argOf('out') || path.join(__dirname, '..', 'out', out.fileName));
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, out.content, 'utf8');
console.log(`${dest}\n${out.items} элементов, ${(Buffer.byteLength(out.content) / 1024).toFixed(0)} КБ, ${Date.now() - t0} мс`);
