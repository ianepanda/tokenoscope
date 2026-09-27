// Копирует ESM-сборки preact/htm в renderer/vendor и переписывает голые импорты на относительные,
// чтобы рендерер работал без сборщика и без import map (CSP запрещает инлайн-скрипты).
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const out = path.join(root, 'renderer', 'vendor');
fs.mkdirSync(out, { recursive: true });

const files = [
  ['node_modules/preact/dist/preact.module.js', 'preact.js'],
  ['node_modules/preact/hooks/dist/hooks.module.js', 'hooks.js'],
  ['node_modules/htm/dist/htm.module.js', 'htm.js'],
];
for (const [src, dst] of files) {
  let code = fs.readFileSync(path.join(root, src), 'utf8');
  code = code.replace(/from\s*["']preact["']/g, 'from"./preact.js"');
  code = code.replace(/\/\/# sourceMappingURL=.*$/m, '');
  fs.writeFileSync(path.join(out, dst), code);
}
console.log('vendor: preact, hooks, htm -> renderer/vendor');
