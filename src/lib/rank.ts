/**
 * 段位换算（v1.1.26）
 * ==================================================================
 * 「编号 ←→ 段位」的纯逻辑，工具箱里的段位换算器只负责画界面。
 *
 * 规则（用户口径）：
 *   青铜 4→1、白银 4→1、黄金 4→1：每小段 3 星
 *   白金 4→1：每小段 4 星
 *   钻石 5→1、大师 5→1：每小段 4 星
 *   王者：1⭐ 起，最多 9999⭐
 *
 * 锚点：青铜 4 的 1⭐ = 0，王者 1⭐ = 92。
 *   12 + 12 + 12 + 16 + 20 + 20 = 92 —— 改了任何一段的星数/小段数，
 *   `RANK_STEPS.length` 就会变，`check-toolbox.cjs` 的 D 组断言会立刻炸出来。
 *
 * 全程从 1⭐ 开始，不存在 0⭐ 的中间态：小段内 1⭐→2⭐→…→满星，满星即进下一小段。
 */

export interface RankTier {
  /** 界面上的大段名 */
  name: string;
  /** 小段编号，按**从低到高**列（4,3,2,1 / 5,4,3,2,1） */
  subs: number[];
  /** 每个小段几颗星 */
  stars: number;
}

export const RANK_TIERS: RankTier[] = [
  { name: '青铜', subs: [4, 3, 2, 1], stars: 3 },
  { name: '白银', subs: [4, 3, 2, 1], stars: 3 },
  { name: '黄金', subs: [4, 3, 2, 1], stars: 3 },
  { name: '白金', subs: [4, 3, 2, 1], stars: 4 },
  { name: '钻石', subs: [5, 4, 3, 2, 1], stars: 4 },
  { name: '大师', subs: [5, 4, 3, 2, 1], stars: 4 },
];

/** 小段用罗马数字，跟「钻石 Ⅳ 3⭐」这种写法对齐 */
export const ROMAN: Record<number, string> = {
  1: 'Ⅰ',
  2: 'Ⅱ',
  3: 'Ⅲ',
  4: 'Ⅳ',
  5: 'Ⅴ',
};

export interface RankStep {
  /** 在 RANK_TIERS 里的下标 */
  tier: number;
  /** 小段编号（4/3/2/1、5/4/…） */
  sub: number;
  /** 星，从 1 开始 */
  star: number;
  /** 全局编号，青铜 4 1⭐ = 0 */
  level: number;
}

/** 展开成「一格一级」的扁平表，编号就是数组下标 */
export const RANK_STEPS: RankStep[] = (() => {
  const out: RankStep[] = [];
  RANK_TIERS.forEach((tier, ti) => {
    for (const sub of tier.subs) {
      for (let star = 1; star <= tier.stars; star++) {
        out.push({ tier: ti, sub, star, level: out.length });
      }
    }
  });
  return out;
})();

/** 王者 1⭐ 的编号（= 92，由 RANK_STEPS 长度推出来，不写死） */
export const KING_BASE = RANK_STEPS.length;

export const KING_MAX_STARS = 9999;

/** 王者 9999⭐ 的编号 */
export const MAX_LEVEL = KING_BASE + KING_MAX_STARS - 1;

export interface RankInfo {
  /** 大段名，王者也叫「王者」 */
  name: string;
  /** 小段编号；王者没有小段，为 null */
  sub: number | null;
  star: number;
  /** 该小段（王者为全段）的起止编号，用来告诉用户「这个数字能落在哪」 */
  from: number;
  to: number;
  /** 成品文案：`钻石 Ⅳ 3⭐` / `王者 123⭐` */
  text: string;
}

/** 编号 → 段位。超出 0..MAX_LEVEL 返回 null */
export function describeLevel(level: number): RankInfo | null {
  if (!Number.isInteger(level) || level < 0 || level > MAX_LEVEL) return null;

  if (level >= KING_BASE) {
    const star = level - KING_BASE + 1;
    return {
      name: '王者',
      sub: null,
      star,
      from: KING_BASE,
      to: MAX_LEVEL,
      text: `王者 ${star}⭐`,
    };
  }

  const step = RANK_STEPS[level];
  const tier = RANK_TIERS[step.tier];
  /* 同一小段的编号一定连续：起点 = 当前编号 - (当前星 - 1) */
  const from = level - (step.star - 1);
  const to = from + tier.stars - 1;
  return {
    name: tier.name,
    sub: step.sub,
    star: step.star,
    from,
    to,
    text: `${tier.name} ${ROMAN[step.sub]} ${step.star}⭐`,
  };
}

/** 只取文案，列表/断言里用 */
export function formatRank(level: number): string {
  return describeLevel(level)?.text ?? '';
}

/** 段位三要素 → 编号；组合不存在（如青铜 Ⅴ）返回 null */
export function levelOf(tierIndex: number, sub: number, star: number): number | null {
  const tier = RANK_TIERS[tierIndex];
  if (!tier || !tier.subs.includes(sub) || star < 1 || star > tier.stars) return null;
  const step = RANK_STEPS.find((s) => s.tier === tierIndex && s.sub === sub && s.star === star);
  return step ? step.level : null;
}

/** 王者星数 → 编号（超出 1..9999 返回 null） */
export function kingLevel(star: number): number | null {
  if (!Number.isInteger(star) || star < 1 || star > KING_MAX_STARS) return null;
  return KING_BASE + star - 1;
}

/**
 * 界面输入框里的一串字符 → 编号。
 *
 * 只认非负整数：段位是离散的，写 `12.5` 没有对应段位，
 * 与其四舍五入给个「看着对其实错」的结果，不如直接返回 null 让它提示。
 */
export function parseLevelInput(raw: string): number | null {
  const s = raw.trim().replace(/[,\s]/g, '');
  if (!/^\+?\d+$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n < 0 || n > MAX_LEVEL) return null;
  return n;
}
