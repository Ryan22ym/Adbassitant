import type { LogcatFilter, LogcatLevel, LogcatLine } from '../../shared/types';

/**
 * Logcat 过滤条件「预编译」（性能优化 B2）
 *
 * 问题
 * ---------------------------------------------------------------
 * 原实现对**每一行**日志都重新做一遍准备工作：
 *   - `tagFilter.split(',').map(trim).filter(Boolean)` → 每行 3 个临时数组；
 *   - `wildcardMatch()` 里 `new RegExp(...)` → 每行每模式编译一次正则；
 *   - `raw.toLowerCase()` 最多两次（关键字 + 进程名）→ 每行两份整行副本。
 *
 * 刷屏 1000 行/秒时，这些短命对象会迅速把 young gen 打满，scavenge 变成
 * 主要 CPU 消耗，并把日志行对象提前晋升到老生代（内存曲线只涨不落）。
 *
 * 做法
 * ---------------------------------------------------------------
 * 过滤条件在 `startLogcat()` 时编译一次，之后逐行只做纯比较 / 子串查找：
 *   - TAG 模式：字面量预先小写，通配符预先编译成 RegExp；
 *   - 关键字：预先小写拆好，整行只小写一次并复用给进程名判断。
 *
 * 匹配语义必须与原实现**逐字一致**（回归见 scripts/check-memory-soak.cjs 的
 * 等价性用例），否则用户在界面上看到的过滤结果会变。
 */

const LEVEL_ORDER: Record<string, number> = { V: 0, D: 1, I: 2, W: 3, E: 4, F: 5, S: 6 };

export type LogcatMatcher = (parsed: Omit<LogcatLine, 'seq'>, raw: string) => boolean;

type TagPattern =
  | { kind: 'any' }
  | { kind: 'glob'; re: RegExp }
  | { kind: 'exact'; lower: string };

/** 逗号分隔 → 去空白 → 去空项（原 split/map/filter 链的等价函数） */
function splitList(s: string | undefined): string[] {
  const t = (s || '').trim();
  if (!t) return [];
  return t
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compileTag(p: string): TagPattern {
  if (p === '*') return { kind: 'any' };
  if (!p.includes('*')) return { kind: 'exact', lower: p.toLowerCase() };
  return {
    kind: 'glob',
    re: new RegExp('^' + p.split('*').map(escapeRe).join('.*') + '$', 'i'),
  };
}

function compileTags(tags: string | undefined): TagPattern[] {
  return splitList(tags).map(compileTag);
}

/** 大小为 1 的模式列表走快路径，省掉 `some()` 的回调开销；空列表返回 false */
function matchTag(patterns: TagPattern[], tag: string): boolean {
  if (patterns.length === 0) return false;
  if (patterns.length === 1) {
    const p = patterns[0];
    if (p.kind === 'any') return true;
    if (p.kind === 'exact') return tag.toLowerCase() === p.lower;
    return p.re.test(tag);
  }
  const lower = tag.toLowerCase();
  for (let i = 0; i < patterns.length; i += 1) {
    const p = patterns[i];
    if (p.kind === 'any') return true;
    if (p.kind === 'exact') {
      if (lower === p.lower) return true;
    } else if (p.re.test(tag)) {
      return true;
    }
  }
  return false;
}

export function compileLogcatMatcher(filter: LogcatFilter): LogcatMatcher {
  const minOrder = LEVEL_ORDER[filter.minLevel as LogcatLevel] ?? 0;
  const pid = filter.pid || 0;

  /*
   * 注意这里判断的是「trim 后有没有内容」，不是「拆出了几个模式」。
   * 原实现里 `if (tagFilter)` 用的是 trim 后的整串：用户填了 `, ,` 这种只有分隔符的
   * 内容时，split/filter 之后一条模式都没有，`.some()` 恒为 false → **整片过滤掉**。
   * 这行为看着像 bug，但它是既有语义；改内存实现不能顺手改可见结果，
   * 所以这里用 hasXxx 保留原样（要修也得单独提，别混在性能提交里）。
   */
  const hasTagFilter = (filter.tags || '').trim().length > 0;
  const hasKeywordFilter = (filter.keyword || '').trim().length > 0;

  const tagPatterns = compileTags(filter.tags);
  const keywords = splitList(filter.keyword).map((k) => k.toLowerCase());
  const proc = (filter.process || '').trim().toLowerCase();

  // 没有关键字也没有进程名时，逐行不必生成小写副本
  const needsLower = hasKeywordFilter || !!proc;

  return (parsed, raw) => {
    if (parsed.level && (LEVEL_ORDER[parsed.level] ?? 0) < minOrder) return false;

    if (pid && parsed.pid !== pid) return false;

    if (hasTagFilter && !matchTag(tagPatterns, parsed.tag || '')) return false;

    if (needsLower) {
      // 整行只小写一次：关键字与进程名共用这一份
      const lower = raw.toLowerCase();
      if (hasKeywordFilter) {
        let hit = false;
        for (let i = 0; i < keywords.length; i += 1) {
          if (lower.includes(keywords[i])) {
            hit = true;
            break;
          }
        }
        if (!hit) return false;
      }
      if (proc && !lower.includes(proc)) return false;
    }

    return true;
  };
}
