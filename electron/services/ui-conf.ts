import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, copyFileSync } from 'fs';
import { join, dirname, basename } from 'path';
import { normalizeUiConf, type UiConf } from '../../shared/ui-conf';
import { log } from './adb';

/**
 * 界面配置（Conf/ 目录）的读取与初始化。
 *
 * 两份目录，职责不同：
 *   · **出厂目录** = 随包分发的模板（打包后 resources/Conf，开发期就是仓库根的 Conf/），
 *     只读、不写，每次发版都会跟着更新；
 *   · **用户目录** = exe 同级的 `Conf/`，**用户手改的就是这一份**，
 *     首次启动从出厂目录复制过来，之后程序只读它、从不覆盖。
 *
 * 这样设计解决了一个矛盾：在线更新的主槽补丁**只替换 app.asar**，
 * 不会碰 resources/ 下的东西 —— 用户改过的配置天然不会被更新冲掉；
 * 代价是发版新增的配置项不会自动出现在用户那份里，
 * 由 shared/ui-conf.ts 的「缺项回落出厂默认」兜住（不会报错，只是走默认表现）。
 *
 * 🔴 不变量：**任何异常都不能让程序起不来**。文件缺失 / JSON 写坏 / 目录不可写，
 *    一律记一条 warn 然后按出厂默认继续跑。
 */

/**
 * 配置文件。顺序即日志与复制的顺序。
 *
 * ⚠️ ai.json（v1.1.14）也在这里，但它**不属于 UiConf**：
 *    它是 AI 模块的接入配置，由 services/ai.ts 自己读（同样借这个目录，
 *    让用户只需要认识一个 Conf/ 文件夹）。放在这份清单里的唯一目的是
 *    「首次启动时把出厂模板复制到用户目录」—— 复制完就与 ui-conf 无关了，
 *    别顺手把它塞进 getUiConf() 的 normalize 里。
 */
const CONF_FILES = ['layout.json', 'panels.json', 'features.json', 'ai.json'] as const;

/** 出厂说明文档，每次启动都刷新一份到用户目录（是文档不是配置，覆盖无风险） */
const CONF_README = 'README.md';

/**
 * 出厂配置目录（只读）。
 * 与 services/adb.ts 的 resolveBinDir 同一套 candidates 思路：
 * 打包后优先 resourcesPath，开发期退回仓库根。
 */
function bundledConfDir(): string {
  const candidates: string[] = [];

  // 打包后：extraResources 把仓库根的 Conf/ 复制到 resources/Conf
  if (process.resourcesPath) {
    candidates.push(join(process.resourcesPath, 'Conf'));
  }

  // 开发期：__dirname = dist-electron/electron/services，回退三级到仓库根
  candidates.push(join(__dirname, '..', '..', '..', 'Conf'));
  // 容错：编译输出层级变化时再退一级
  candidates.push(join(__dirname, '..', '..', 'Conf'));
  candidates.push(join(process.cwd(), 'Conf'));

  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  // 都不存在时返回最可能的那个，让后续的「找不到文件」日志能定位到真实路径
  return candidates[1];
}

/**
 * 用户配置目录（exe 同级 `Conf/`）。
 *
 * ⚠️ 便携版必须认 `PORTABLE_EXECUTABLE_DIR`：portable 包每次启动都会把自身解压到
 *    临时目录再运行，`app.getPath('exe')` 指向的是那个临时目录 —— 配置写进去，
 *    下次启动换了个临时目录就「丢失」了。这个环境变量给的才是用户双击的那个 exe 所在目录。
 */
function userConfDir(): string {
  const portable = (process.env.PORTABLE_EXECUTABLE_DIR || '').trim();
  const base = portable || dirname(app.getPath('exe'));
  return join(base, 'Conf');
}

/**
 * 首次启动时把出厂配置铺到用户目录。
 *
 * - 三份 JSON：**已存在就跳过**，绝不覆盖用户改动；
 * - README：每次都覆盖，保证用户看到的是当前版本的 id 对照表。
 */
function seedUserConf(dir: string): void {
  try {
    const src = bundledConfDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    let copied = 0;
    for (const name of CONF_FILES) {
      const dst = join(dir, name);
      if (existsSync(dst)) continue; // 用户手上那份优先，不覆盖
      const from = join(src, name);
      if (!existsSync(from)) continue;
      copyFileSync(from, dst);
      copied++;
    }

    try {
      const fromReadme = join(src, CONF_README);
      if (existsSync(fromReadme)) copyFileSync(fromReadme, join(dir, CONF_README));
    } catch {
      /* 说明文档复制失败无关紧要 */
    }

    if (copied > 0) {
      log('info', '配置', `已初始化界面配置目录（${copied} 份文件）：${dir}`);
    }
  } catch (e) {
    log('warn', '配置', `初始化配置目录失败，改用出厂默认：${(e as Error).message}`);
  }
}

/**
 * 实际读取的目录。
 * 开发期**就地读仓库里的 Conf/** —— 不往 node_modules/electron 旁边复制文件，
 * 改完源码目录里的配置刷新一下就能看到效果。
 */
function activeConfDir(): string {
  if (!app.isPackaged) return bundledConfDir();
  const dir = userConfDir();
  seedUserConf(dir);
  return dir;
}

/** 读一个 JSON；缺失或解析失败返回 undefined（交由 normalize 回落到出厂默认） */
function readJson(file: string): unknown {
  try {
    if (!existsSync(file)) return undefined;
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    log('warn', '配置', `${basename(file)} 读取失败，该项按出厂默认处理：${(e as Error).message}`);
    return undefined;
  }
}

let cached: UiConf | null = null;

/**
 * 取合并后的界面配置（带缓存）。
 *
 * 只在启动时读一次 —— 设计上就是「改完文件重启生效」，
 * 不做文件监听：半截写入、编辑器另存为等场景都会让热重载变得不可靠，
 * 而这类配置本来就改得很少。
 */
export function getUiConf(): UiConf {
  if (cached) return cached;
  const dir = activeConfDir();
  cached = normalizeUiConf({
    layout: readJson(join(dir, 'layout.json')),
    panels: readJson(join(dir, 'panels.json')),
    features: readJson(join(dir, 'features.json')),
  });
  return cached;
}

/** 配置目录路径（设置页「打开配置文件夹」与自检脚本用） */
export function resolveUiConfDir(): string {
  return activeConfDir();
}

/**
 * 丢弃已缓存的配置，下次 getUiConf() 重新读盘。
 *
 * 只给自检脚本用：scripts/check-ui-conf.cjs 要在同一个进程里连续验证
 * 「自定义配置生效 → 文件写坏回落默认」两种状态，而 getUiConf 的缓存是为了
 * 「启动读一次」的语义存在的，不清掉第二次读到的还是旧值。
 *
 * 🔴 程序运行期**没有任何调用点** —— 别拿它做热重载：
 *    设计上就是改完文件重启生效（见 getUiConf 的注释）。
 */
export function resetUiConfCache(): void {
  cached = null;
}
