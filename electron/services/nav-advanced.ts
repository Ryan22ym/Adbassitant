import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { app } from 'electron';
import { getSettings, saveSettings } from './settings';
import { resolveUiConfDir } from './ui-conf';
import { log } from './adb';
import type { NavAdvancedState } from '../../shared/types';

/**
 * 「导航增强」开关（v1.1.27）：左侧功能栏拖拽排序 + 页面浮动小窗口。
 *
 * ────────────────────────────────────────────────────────────────
 * 为什么它需要一份专门的服务（而不是像其它设置那样只存 settings.json）
 * ────────────────────────────────────────────────────────────────
 * 需求给的是**两个开关**：设置页里一个、Conf/features.json 里一个，而且
 * 「两种方式状态一致」「改完重启生效」。三条要求在实现上是互相拉扯的：
 *
 *   · 只存 settings.json → 文件开关是假的（改了文件不生效）；
 *   · 只认文件       → 设置页的开关得去改一个「用户手写」的文件，
 *                     而且 NSIS 覆盖安装会连整个 Conf/ 一起删掉，开关会莫名回退；
 *   · 两处各存一份、各读各的 → 必然漂移（界面开着、文件关着）。
 *
 * 所以这里做的是「**一份真值 + 双向写回**」：
 *   1. 启动时解析一次，得到本次进程的生效值（缓存在模块里，**改开关不会立刻生效**，
 *      这就是「重启后生效」的实现方式 —— 不是界面上假装修了一下，是真的没变）；
 *   2. 解析完立刻把同一个值写回两边，于是两边永远一致；
 *   3. 界面上的开关读的、写的都是「已落盘的值」（persisted），
 *      生效值不同时返回 restartPending=true，界面据此提示重启。
 *
 * 解析优先级（两边不一致才算「不一致」，一致时谁说了都一样）：
 *   · 文件里**显式**写了 `features.ui.navAdvanced` 且与 settings 不同 → **文件优先**
 *     （用户明确手改了文件，这是他能直接表达意图的唯一通道）；
 *   · 否则 → settings.json 的值；
 *   · 都没有 → true（v1.1.28 起出厂开启：拖动小窗是主力交互）。
 *
 * 🔴 为什么文件优先，而不是 settings 优先：
 *    设置页改一次就把 settings 写成非默认值，如果 settings 优先，
 *    用户之后手改 Conf/features.json 就永远不生效了 —— 文件开关变成一次性的。
 *    反过来「settings 被手改、文件没动」的概率极低（没人会去翻 userData），
 *    而且那种情况下文件里的值本来就是上一次界面写入的那份，结果也符合预期。
 */

/** features.json 里的路径：features.ui.navAdvanced */
const FILE_GROUP = 'ui';
const FILE_KEY = 'navAdvanced';

let effective: boolean | null = null;
let source: NavAdvancedState['source'] = 'default';
/** 解析那一刻两边各自的值（诊断用；不代表当前值） */
let snapshot = { setting: false, file: false };

function confFile(): string {
  return join(resolveUiConfDir(), 'features.json');
}

/**
 * 读文件里的开关。
 *
 * 返回值里的 `raw` 是整份 JSON —— 写回时要在原文件上改，不能另起一份，
 * 否则用户手写的注释键、其它 features 全部丢失。
 * 解析失败时 raw 为 null：此时**不写**这个文件（写回等于把用户的文件推平），
 * 只把值落到 settings.json。
 */
function readFileSwitch(): { value: boolean | null; raw: Record<string, unknown> | null } {
  const file = confFile();
  if (!existsSync(file)) return { value: null, raw: null };
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { value: null, raw: null };
    const features = (raw as Record<string, unknown>).features;
    if (!features || typeof features !== 'object' || Array.isArray(features)) {
      return { value: null, raw: raw as Record<string, unknown> };
    }
    const group = (features as Record<string, unknown>)[FILE_GROUP];
    if (!group || typeof group !== 'object' || Array.isArray(group)) {
      return { value: null, raw: raw as Record<string, unknown> };
    }
    const v = (group as Record<string, unknown>)[FILE_KEY];
    return { value: typeof v === 'boolean' ? v : null, raw: raw as Record<string, unknown> };
  } catch (e) {
    log('warn', '配置', `features.json 解析失败，导航增强开关只认设置：${(e as Error).message}`);
    return { value: null, raw: null };
  }
}

/**
 * 把开关写回 features.json。
 *
 * - 值没变就**一个字节都不写**：这个函数每次启动都会跑，无谓的写盘会把用户的
 *   文件修改时间一直刷成今天，也会让「我是不是改过这个文件」变得没法判断；
 * - JSON 写坏时直接放弃（见 readFileSwitch 的说明）；
 * - 保留文件里的其它所有键，只动 `features.ui.navAdvanced` 这一个。
 */
function writeFileSwitch(value: boolean): boolean {
  const { value: current, raw } = readFileSwitch();
  if (!raw) return false;
  if (current === value) return true;
  try {
    const features = (raw.features as Record<string, unknown>) || {};
    const group = (features[FILE_GROUP] as Record<string, unknown>) || {};
    group[FILE_KEY] = value;
    features[FILE_GROUP] = group;
    raw.features = features;
    writeFileSync(confFile(), JSON.stringify(raw, null, 2) + '\n', 'utf8');
    return true;
  } catch (e) {
    log('warn', '配置', `features.json 写入失败，导航增强开关只认设置：${(e as Error).message}`);
    return false;
  }
}

/** 出厂默认值（v1.1.28：默认开启，拖动小窗是主力交互） */
const DEFAULT_NAV_ADVANCED = true;

/**
 * 读 settings.json 里**实际存在**的开关值。
 *
 * 🔴 不能直接用 getSettings().navAdvanced：它会把默认值合并进来，
 *    于是「用户从没点过开关」和「用户明确关了」都读成 false ——
 *    出厂改成 true 之后，这就等于把后者的关闭意图吞掉。
 *    所以这里直接读原始 JSON，键不存在时返回 null。
 */
function readSettingSwitch(): boolean | null {
  try {
    const file = join(app.getPath('userData'), 'settings.json');
    if (!existsSync(file)) return null;
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    const v = raw?.navAdvanced;
    return typeof v === 'boolean' ? v : null;
  } catch {
    return null;
  }
}

function build(): NavAdvancedState {
  const persisted = !!getSettings().navAdvanced;
  return {
    effective: effective ?? false,
    persisted,
    setting: snapshot.setting,
    file: snapshot.file,
    source,
    restartPending: persisted !== (effective ?? false),
  };
}

/**
 * 启动时解析一次（幂等）。第一次被调用时才是真正的解析，之后只返回缓存。
 *
 * 调用点是 IPC 的 NAV_ADV_GET —— 渲染层初始化时就会问一次，等于启动即解析。
 */
export function getNavAdvanced(): NavAdvancedState {
  if (effective !== null) return build();

  const settingSwitch = readSettingSwitch();
  const setting = settingSwitch ?? DEFAULT_NAV_ADVANCED;
  const { value: fileValue } = readFileSwitch();
  let value: boolean;
  if (fileValue !== null && fileValue !== setting) {
    value = fileValue;
    source = 'file';
  } else if (fileValue !== null || settingSwitch !== null) {
    value = setting;
    source = 'settings';
  } else {
    // v1.1.28：两边都没写过 → 出厂开启（拖动小窗是主力交互）
    value = true;
    source = 'default';
  }
  snapshot = { setting, file: fileValue ?? false };
  effective = value;

  /* 双向对齐：两边都写成解析结果。失败不影响本次启动（只影响下次读到的值）。 */
  if (setting !== value) {
    try {
      saveSettings({ navAdvanced: value });
    } catch (e) {
      log('warn', '配置', `导航增强开关写入设置失败：${(e as Error).message}`);
    }
  }
  /*
   * 反向对齐：**只在文件里本来就写了这个键、且与解析结果不同时**才写回。
   *
   * 🔴 不主动把键写进出厂模板里（absent → 不补），是为了「覆盖安装」这件事：
   *    NSIS 会连整个 Conf/ 一起删掉再铺回出厂模板，如果模板里带着
   *    `navAdvanced: false`，一次覆盖安装就会把用户开着的功能悄悄关掉
   *    （文件优先 → 文件的 false 赢了）。没有键时以 settings.json 为准，
   *    而 settings.json 在 userData 里，装多少次都不会被删。
   *    用户一旦在设置页点过开关，两边都会写（见 setNavAdvanced），
   *    那时键才出现在文件里。
   */
  if (fileValue !== null && fileValue !== value) writeFileSwitch(value);

  log('info', '配置', `导航增强：${value ? '开启' : '关闭'}（来源 ${source}）`);
  return build();
}

/**
 * 改开关。
 *
 * 🔴 **只落盘，不动 effective** —— 这是「重启后生效」的全部实现。
 *    想让它立刻生效的人应该去改业务代码，而不是绕过这里给 effective 赋值。
 */
export function setNavAdvanced(next: boolean): NavAdvancedState {
  const value = !!next;
  getNavAdvanced(); // 确保先解析过一次，否则 persisted 会拿错基准
  try {
    saveSettings({ navAdvanced: value });
  } catch (e) {
    log('warn', '配置', `导航增强开关写入设置失败：${(e as Error).message}`);
  }
  writeFileSwitch(value);
  snapshot = { setting: value, file: value };
  return build();
}

/**
 * 丢掉缓存，下次 getNavAdvanced() 重新解析。
 * 只给自检脚本用（同一个进程里验证「改文件 → 重启 → 生效」）。
 */
export function resetNavAdvancedCache(): void {
  effective = null;
  source = 'default';
  snapshot = { setting: false, file: false };
}
