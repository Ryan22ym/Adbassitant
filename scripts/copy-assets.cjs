/**
 * 把 electron/assets 下的非 TS 资源复制到 dist-electron/assets。
 *
 * tsc 只编译 .ts，不会搬运 .ps1 之类的资源；而打包时 electron-builder 只收
 * dist/、dist-electron/、package.json，所以必须在编译后补一步复制。
 * （update.ts 里对找不到编译产物的情况有源码目录兜底，但这只对开发期有效。）
 *
 * ⚠️ 这里**刻意不用 fs.cpSync**：本机环境下 `cpSync(src, dest, { recursive: true })`
 * 会让 Node 直接 fail-fast 退出（退出码 0xC0000409，连 try/catch 都来不及走），
 * 表现为「npm run build:electron 报 3221226505 且没有任何输出」。
 * 改成手写遍历 + copyFileSync 就没问题。
 * 也不要写成 .mjs —— 用 CommonJS 少一层加载器的变量。
 */
const { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } = require('fs');
const { dirname, join, sep } = require('path');

const ROOT = join(__dirname, '..');

/** 手写递归复制（不用 cpSync，原因见文件头） */
function copyTree(src, dest) {
  const st = statSync(src);
  if (st.isDirectory()) {
    mkdirSync(dest, { recursive: true });
    for (const name of readdirSync(src)) {
      copyTree(join(src, name), join(dest, name));
    }
    return 1;
  }
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  return 1;
}

const PAIRS = [['electron/assets', 'dist-electron/assets']];

let n = 0;
for (const [from, to] of PAIRS) {
  const src = join(ROOT, ...from.split('/'));
  if (!existsSync(src)) continue;
  const dest = join(ROOT, ...to.split('/'));
  mkdirSync(dest, { recursive: true });
  copyTree(src, dest);
  n++;
  console.log(`[assets] ${from}${sep === '\\' ? '/' : sep} -> ${to}/`);
}
if (!n) console.log('[assets] 没有需要复制的资源');
