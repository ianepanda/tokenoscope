// Сборка приложения под текущую ОС или под --platform/--arch:
//   win32  -> dist/Токеноскоп-win32-x64/Tokenoscope.exe
//   darwin -> dist/Токеноскоп-darwin-arm64/Токеноскоп.app (только на macOS: нужен codesign)
// node scripts/build.mjs [--platform=win32|darwin] [--arch=x64|arm64] [--shortcuts]
//   (--shortcuts — ярлыки Windows на рабочем столе и в меню «Пуск»)
import { packager } from '@electron/packager';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const argOf = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const platform = argOf('platform') || process.platform;
const arch = argOf('arch') || process.arch;
const iconExt = { win32: 'ico', darwin: 'icns' }[platform];
if (!iconExt) throw new Error(`Сборка под ${platform} не настроена, есть только win32 и darwin`);
// Без codesign бандл с изменённым Info.plist не запустится на Apple Silicon.
if (platform === 'darwin' && process.platform !== 'darwin') throw new Error('Сборка под macOS — только на macOS');

if (!existsSync(path.join(root, 'build', `icon.${iconExt}`))) {
  execFileSync(process.execPath, [path.join(root, 'scripts', 'make-icon.js')], { stdio: 'inherit' });
}

const options = {
  dir: root,
  out: path.join(root, 'dist'),
  overwrite: true,
  platform,
  arch,
  name: 'Токеноскоп',
  executableName: 'Tokenoscope',
  appVersion: pkg.version,
  icon: path.join(root, 'build', `icon.${iconExt}`),
  appBundleId: 'ru.andreev.tokenoscope',
  appCategoryType: 'public.app-category.developer-tools',
  // Без asar: worker-потоки грузят lib/worker.js с диска.
  asar: false,
  // Без временной папки: под Windows антивирус держит свежий electron.exe, и rename из %TEMP% падает с EPERM.
  tmpdir: false,
  prune: true,
  // node_modules не нужен: preact и htm лежат в renderer/vendor.
  ignore: [/^\/node_modules($|\/)/, /^\/dist($|\/)/, /^\/\.claude($|\/)/, /^\/scripts($|\/)/, /^\/\.github($|\/)/, /^\/README\.md$/, /^\/\.gitignore$/],
  win32metadata: {
    ProductName: 'Токеноскоп',
    FileDescription: 'Токеноскоп — куда уходят токены Claude',
    InternalName: 'Tokenoscope',
    OriginalFilename: 'Tokenoscope.exe',
    CompanyName: 'Николай Андреев',
  },
};

// Антивирус сканирует только что распакованный electron.exe и держит папку — переименование падает
// с EPERM. Ждём и пробуем снова, убирая недоделанные шаблоны.
const dist = path.join(root, 'dist');
const cleanTemplates = () => {
  if (!existsSync(dist)) return;
  for (const d of readdirSync(dist)) if (d.startsWith(`${platform}-${arch}-template-`)) rmSync(path.join(dist, d), { recursive: true, force: true });
};
let appDir;
for (let attempt = 1; ; attempt++) {
  cleanTemplates();
  try {
    [appDir] = await packager(options);
    break;
  } catch (err) {
    if (err.code !== 'EPERM' || attempt >= 6) throw err;
    console.log(`EPERM при переименовании, повтор через ${attempt * 3} с…`);
    await new Promise((r) => setTimeout(r, attempt * 3000));
  }
}
cleanTemplates();

if (platform === 'darwin') {
  // Упаковщик меняет Info.plist и имена helper'ов, и подпись Electron из коробки перестаёт сходиться.
  // Ad-hoc подпись («-») нужна, чтобы бандл вообще запускался на Apple Silicon; от Gatekeeper она не спасает.
  const bundle = path.join(appDir, `${options.name}.app`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', bundle], { stdio: 'inherit' });
  console.log(`app: ${bundle}`);
}

const exe = path.join(appDir, 'Tokenoscope.exe');
if (platform === 'win32') console.log(`app: ${exe}`);

if (platform === 'win32' && process.argv.includes('--shortcuts')) {
  const ps = `
$ws = New-Object -ComObject WScript.Shell
$targets = @([Environment]::GetFolderPath('Desktop'), (Join-Path ([Environment]::GetFolderPath('Programs')) ''))
foreach ($dir in $targets) {
  $lnk = $ws.CreateShortcut((Join-Path $dir 'Токеноскоп.lnk'))
  $lnk.TargetPath = $env:TOKENOSCOPE_EXE
  $lnk.WorkingDirectory = Split-Path $env:TOKENOSCOPE_EXE
  $lnk.IconLocation = "$env:TOKENOSCOPE_EXE,0"
  $lnk.Description = 'Куда уходят токены Claude'
  $lnk.Save()
  Write-Output "shortcut: $($lnk.FullName)"
}`;
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    stdio: 'inherit',
    env: { ...process.env, TOKENOSCOPE_EXE: exe },
  });
}
