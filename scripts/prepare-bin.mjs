/**
 * 准备 bin 目录：从原项目复制 adb / scrcpy 等二进制文件
 * 用法：node scripts/prepare-bin.mjs
 */
import { existsSync, mkdirSync, copyFileSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const binDir = join(root, 'bin');

const SOURCE_DIRS = [
  join(root, '..', 'ADB桌面助手-v3.11', 'ADB桌面助手-v3.11'),
  join(root, 'vendor'),
];

const NEEDED = [
  'adb.exe',
  'AdbWinApi.dll',
  'AdbWinUsbApi.dll',
  'scrcpy.exe',
  'scrcpy-server',
  'SDL2.dll',
  'avcodec-61.dll',
  'avformat-61.dll',
  'avutil-59.dll',
  'swresample-5.dll',
  'libusb-1.0.dll',
  'icon.png',
];

function main() {
  if (!existsSync(binDir)) mkdirSync(binDir, { recursive: true });

  let src = null;
  for (const d of SOURCE_DIRS) {
    if (existsSync(join(d, 'adb.exe'))) {
      src = d;
      break;
    }
  }

  if (!src) {
    console.error('x 未找到源二进制目录，请把 adb.exe / scrcpy.exe 放到 vendor/ 目录');
    process.exit(1);
  }

  console.log(`源目录：${src}`);

  let copied = 0;
  const missing = [];

  for (const f of NEEDED) {
    const from = join(src, f);
    const to = join(binDir, f);
    if (!existsSync(from)) {
      missing.push(f);
      continue;
    }
    copyFileSync(from, to);
    copied++;
    const size = (statSync(to).size / 1024 / 1024).toFixed(1);
    console.log(`  [ok] ${f} (${size} MB)`);
  }

  if (missing.length) {
    console.warn(`  [!] 缺失：${missing.join(', ')}`);
  }
  console.log('');
  console.log(`完成：复制 ${copied} 个文件到 ${binDir}`);
}

main();
