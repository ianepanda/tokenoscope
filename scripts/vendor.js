// Копирует ESM-сборки preact/htm в renderer/vendor и переписывает голые импорты на относительные,
// чтобы рендерер работал без сборщика и без import map (CSP запрещает инлайн-скрипты).
// marked (UMD) кладётся в lib/vendor: его подключает main-процесс для экспорта транскрипта в HTML,
// а node_modules в сборку не попадает.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

const files = [
  ['node_modules/preact/dist/preact.module.js', 'renderer/vendor/preact.js'],
  ['node_modules/preact/hooks/dist/hooks.module.js', 'renderer/vendor/hooks.js'],
  ['node_modules/htm/dist/htm.module.js', 'renderer/vendor/htm.js'],
  ['node_modules/marked/lib/marked.umd.js', 'lib/vendor/marked.js'],
];
for (const [src, dst] of files) {
  let code = fs.readFileSync(path.join(root, src), 'utf8');
  code = code.replace(/from\s*["']preact["']/g, 'from"./preact.js"');
  code = code.replace(/\/\/# sourceMappingURL=.*$/m, '');
  fs.mkdirSync(path.dirname(path.join(root, dst)), { recursive: true });
  fs.writeFileSync(path.join(root, dst), code);
}
console.log('vendor: preact, hooks, htm -> renderer/vendor; marked -> lib/vendor');
