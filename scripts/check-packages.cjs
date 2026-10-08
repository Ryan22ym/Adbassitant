/**
 * 安装包管理自测（纯 Node，不用 Electron）
 *
 *   node scripts/check-packages.cjs
 *
 * 两块：
 *   A 规则层 —— `shared/packages.ts` 的归类/目标目录/筛选/手动标签（纯函数）
 *   B 磁盘层 —— `electron/services/package-fs.ts` 在临时目录里真扫真移
 *
 * 为什么必须真跑磁盘层：整理是「按规则移动用户的文件」，最容易出的事故是
 * 覆盖同名包、把单包塞进 release/test、或者不幂等（每次进来都来回搬）。
 * 这三件事在纯函数里看是看不出来的，只能用真目录验。
 *
 * 全程只动 os.tmpdir() 下自建的临时目录，不碰用户任何真实文件。
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'ui-shots');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
const LOG = path.join(OUT, '_packages.log');

const P = require('../dist-electron/shared/packages.js');
const FS_ = require('../dist-electron/electron/services/package-fs.js');

const rows = [];
const log = (line) => {
  try {
    fs.appendFileSync(LOG, String(line) + '\n');
  } catch {
    /* ignore */
  }
};
const record = (ok, name, detail = '') => {
  rows.push(`${ok ? 'PASS' : 'FAIL'}  ${name}  ::  ${detail}`);
};

const DIRS = P.DEFAULT_PACKAGE_DIR_NAMES;

/** 归类一个文件名（默认配置） */
const cls = (name, folderVersions = []) =>
  P.classify(name, P.formatOf(name) || 'apk', folderVersions, P.DEFAULT_PACKAGE_KEYWORDS);

const targetOf = (name, folderVersions = [], structure = 'version-first', dirNames = DIRS) => {
  const c = cls(name, folderVersions);
  return P.targetDirOf(c, dirNames, structure);
};

/* ------------------------------------------------------------------ */
/* A 规则层                                                            */
/* ------------------------------------------------------------------ */

function checkRules() {
  /* ---- 官网包（默认样式 Domino_GW_V2.83_release_18.apk）---- */
  {
    const c = cls('Domino_GW_V2.83_release_18.apk');
    record(c.kind === 'official', '官网包样例归官网包', c.kind);
    record(c.version === '2.83', '官网包样例版本 2.83', String(c.version));
    record(c.channel === 'release', '官网包样例通道 release', String(c.channel));
    record(c.build === '18', '官网包样例构建号 18', String(c.build));
    record(
      targetOf('Domino_GW_V2.83_release_18.apk') === '2.83/官网包/release',
      '官网包目标目录 = 2.83/官网包/release',
      targetOf('Domino_GW_V2.83_release_18.apk'),
    );
  }

  /* ---- Google 包（默认样式 app-dmno_release-release_10.aab）---- */
  {
    const c = cls('app-dmno_release-release_10.aab');
    record(c.kind === 'google', 'Google 包样例归 Google 包', c.kind);
    record(c.channel === 'release', 'Google 包样例通道 release', String(c.channel));
    record(c.build === '10', 'Google 包样例构建号 10', String(c.build));
    record(c.version === undefined, 'Google 包名字里没有版本号时不硬造');
    record(
      targetOf('app-dmno_release-release_10.aab') === '未识别版本/Google包/release',
      'Google 包无版本号时落 未识别版本/Google包/release',
      targetOf('app-dmno_release-release_10.aab'),
    );
  }

  /* ---- test 通道 ---- */
  {
    record(
      targetOf('Domino_GW_V2.84_test_3.apk') === '2.84/官网包/test',
      'test 版本落 test 目录',
      targetOf('Domino_GW_V2.84_test_3.apk'),
    );
    record(
      targetOf('app-dmno_test_4.aab') === '未识别版本/Google包/test',
      'Google 包 test 落 test 目录',
      targetOf('app-dmno_test_4.aab'),
    );
  }

  /* ---- 单包（认不出官网/Google 的都归这里，v1.1.6 收敛）---- */
  {
    const c = cls('weixin_8.0.50.apk');
    record(c.kind === 'single', '零散包归单包', c.kind);
    record(c.channel === undefined, '单包没有通道', String(c.channel));
    record(
      targetOf('weixin_8.0.50.apk') === '8.0.50/单包',
      '单包目标目录不出现 release/test',
      targetOf('weixin_8.0.50.apk'),
    );
    record(targetOf('随手下的包.apk') === '未识别版本/单包', '判不出版本的单包落 未识别版本/单包', targetOf('随手下的包.apk'));

    /*
     * 🔴 v1.1.6 收敛的核心：**不再按扩展名兜底**。
     * 以前 aab 兜底进 Google 包、apk 兜底进官网包，第三方包恰好带个 release 就冒充类型包了。
     */
    const aab = cls('app_release_1.0.0.aab');
    record(aab.kind === 'single', 'aab 认不出 Google 关键字 → 单包（不再按扩展名兜底）', aab.kind);
    record(
      targetOf('app_release_1.0.0.aab') === '1.0.0/单包',
      '这类包落 1.0.0/单包',
      targetOf('app_release_1.0.0.aab'),
    );
    record(
      cls('第三方_release_2.0.apk').kind === 'single' &&
        targetOf('第三方_release_2.0.apk') === '2.0/单包',
      'apk 带 release 但无类型关键字 → 单包（不带通道层）',
      targetOf('第三方_release_2.0.apk'),
    );
    record(cls('x_official_3.0.apk').kind === 'official', 'official 关键字仍然认官网包', cls('x_official_3.0.apk').kind);
  }

  /* ---- 只有类型关键字、没写通道 → 默认 release，且不被判成单包 ---- */
  {
    record(
      targetOf('Domino_GW_V2.83.apk') === '2.83/官网包/release',
      '有类型关键字、无通道时按 release 归置',
      targetOf('Domino_GW_V2.83.apk'),
    );
  }

  /* ---- 关键字必须整词匹配 ---- */
  {
    /*
     * 🔴 这里必须问 pickChannel 本身，不能拿 classify 的结果看：
     *    v1.1.6 起「认不出类型的包一律归单包」，单包不带通道，
     *    于是 `myapp_2.1.0_release.apk` 的 channel 恒为 undefined ——
     *    拿它去验「release 有没有被识别到」就什么都测不出来了。
     */
    const kw = P.DEFAULT_PACKAGE_KEYWORDS;
    record(
      P.pickChannel('app_prerelease_2.1.0.apk', kw) === undefined,
      'prerelease 不该被当成 release 通道',
      String(P.pickChannel('app_prerelease_2.1.0.apk', kw)),
    );
    record(
      P.pickChannel('myapp_2.1.0_release.apk', kw) === 'release',
      '正常 release 仍然命中',
      String(P.pickChannel('myapp_2.1.0_release.apk', kw)),
    );
    record(
      P.pickChannel('Domino_GW_x_test_3.apk', kw) === 'test',
      'test 也按整词命中',
      String(P.pickChannel('Domino_GW_x_test_3.apk', kw)),
    );
  }

  /* ---- 手动标签：覆盖自动识别 ---- */
  {
    const ov = P.normalizeOverrides({
      'weixin_8.0.50.apk': { kind: 'official', channel: 'test', version: 'v9.9.9' },
      'bad/name.apk': { kind: 'official' },
      './x.apk': { kind: 'nope' },
      'empty.apk': {},
    });
    record(
      Object.keys(ov).length === 1 && ov['weixin_8.0.50.apk'].version === '9.9.9',
      '手动标签表会清洗（非法键 / 非法值 / 空项丢掉，版本去 v 前缀）',
      JSON.stringify(ov),
    );

    const c = P.classifyWithOverride('weixin_8.0.50.apk', 'apk', [], P.DEFAULT_PACKAGE_KEYWORDS, ov);
    record(
      c.kind === 'official' && c.channel === 'test' && c.version === '9.9.9' && c.versionFrom === 'manual' && c.overridden === true,
      '手动标签优先于自动识别',
      JSON.stringify({ k: c.kind, ch: c.channel, v: c.version, from: c.versionFrom, ov: c.overridden }),
    );
    record(
      P.targetDirOf(c, DIRS, 'version-first') === '9.9.9/官网包/test',
      '手动标签决定目标目录',
      P.targetDirOf(c, DIRS, 'version-first'),
    );

    const auto = P.classifyWithOverride('weixin_8.0.50.apk', 'apk', [], P.DEFAULT_PACKAGE_KEYWORDS, undefined);
    record(auto.kind === 'single' && auto.overridden === false, '没有手动标签时按自动识别', JSON.stringify(auto));

    const forced = P.classifyWithOverride('Domino_GW_V2.83_release_18.apk', 'apk', [], P.DEFAULT_PACKAGE_KEYWORDS, {
      'Domino_GW_V2.83_release_18.apk': { kind: 'single', channel: '', version: '' },
    });
    record(
      forced.kind === 'single' && forced.channel === undefined && forced.version === undefined,
      '手工改成单包：通道与版本一起清掉',
      JSON.stringify({ k: forced.kind, ch: forced.channel, v: forced.version }),
    );
    record(
      P.targetDirOf(forced, DIRS, 'version-first') === '未识别版本/单包',
      '手工改成单包且版本留空 → 未识别版本/单包',
      P.targetDirOf(forced, DIRS, 'version-first'),
    );

    const onlyChannel = P.classifyWithOverride('app-dmno_release-release_10.aab', 'aab', [], P.DEFAULT_PACKAGE_KEYWORDS, {
      'app-dmno_release-release_10.aab': { kind: 'google', channel: 'test' },
    });
    record(
      onlyChannel.kind === 'google' && onlyChannel.channel === 'test',
      '只写了通道时类型仍按自动识别',
      `${onlyChannel.kind}/${onlyChannel.channel}`,
    );

    record(
      P.sanitizeOverrideVersion('V2.083') === '2.83' &&
        P.sanitizeOverrideVersion('abc') === '' &&
        P.sanitizeOverrideVersion('') === '',
      '版本输入清洗：V2.083→2.83、乱填→空',
      `${P.sanitizeOverrideVersion('V2.083')} / ${P.sanitizeOverrideVersion('abc')}`,
    );
    record(P.normalizeOverrides(null) && Object.keys(P.normalizeOverrides(null)).length === 0, '空 / 损坏的手动标签表回落成空表');
  }

  /* ---- 版本号兜底：取自上级目录 ---- */
  {
    const c = cls('app-dmno_release-release_10.aab', ['2.84']);
    record(c.version === '2.84' && c.versionFrom === 'folder', '文件名没版本时取上级目录版本', `${c.version}/${c.versionFrom}`);
    record(
      targetOf('app-dmno_release-release_10.aab', ['release', 'Google包', '2.84']) === '2.84/Google包/release',
      '多层上级目录里也能找到版本',
      targetOf('app-dmno_release-release_10.aab', ['release', 'Google包', '2.84']),
    );
    record(cls('a.aab', ['2024-10']).version === undefined, '日期式目录名不会被当版本号', String(cls('a.aab', ['2024-10']).version));
  }

  /* ---- 目录结构：类型优先 ---- */
  {
    record(
      targetOf('Domino_GW_V2.83_release_18.apk', [], 'type-first') === '官网包/2.83/release',
      'type-first：官网包/2.83/release',
      targetOf('Domino_GW_V2.83_release_18.apk', [], 'type-first'),
    );
    record(
      targetOf('weixin_8.0.50.apk', [], 'type-first') === '单包/8.0.50',
      'type-first：单包/8.0.50',
      targetOf('weixin_8.0.50.apk', [], 'type-first'),
    );
  }

  /* ---- 自定义目录名 ---- */
  {
    const en = { official: 'official', google: 'google', single: 'single', release: 'release', test: 'test', unknownVersion: 'unknown' };
    record(
      targetOf('Domino_GW_V2.83_release_18.apk', [], 'version-first', en) === '2.83/official/release',
      '目录名可自定义（英文）',
      targetOf('Domino_GW_V2.83_release_18.apk', [], 'version-first', en),
    );
    const dirty = P.normalizeDirNames({ official: 'a/b:c*?', google: '  ', single: '单包.' });
    record(dirty.official === 'abc', '目录名里的非法字符被清掉', dirty.official);
    record(dirty.google === 'Google包', '空目录名回落默认值', dirty.google);
    record(dirty.single === '单包', '目录名末尾的点被清掉', dirty.single);
  }

  /* ---- 筛选 ---- */
  {
    const e = (name) => {
      const c = cls(name);
      return { name, version: c.version, kind: c.kind, channel: c.channel, format: P.formatOf(name) };
    };
    const off = e('Domino_GW_V2.83_release_18.apk');
    const goog = e('app-dmno_test_4.aab');
    const single = e('weixin_8.0.50.apk');

    record(P.matchesFilters(off, P.DEFAULT_PACKAGE_FILTERS), '不选任何条件 = 全部命中');
    record(P.matchesFilters(off, { ...P.DEFAULT_PACKAGE_FILTERS, versions: ['2.83'] }), '按版本筛命中');
    record(!P.matchesFilters(goog, { ...P.DEFAULT_PACKAGE_FILTERS, versions: ['2.83'] }), '按版本筛不误命中别的版本');
    record(
      P.matchesFilters(goog, { ...P.DEFAULT_PACKAGE_FILTERS, versions: [P.PACKAGE_UNKNOWN_VERSION_KEY] }),
      '未识别版本这一档能筛到无版本号的包',
    );
    record(
      P.matchesFilters(off, { ...P.DEFAULT_PACKAGE_FILTERS, kinds: ['official'], channels: ['release'], formats: ['apk'] }),
      '多维度叠加（与）命中',
    );
    record(
      !P.matchesFilters(goog, { ...P.DEFAULT_PACKAGE_FILTERS, channels: ['release'] }),
      '选了 test 的包不会被 release 筛出来',
    );
    record(
      P.matchesFilters(single, { ...P.DEFAULT_PACKAGE_FILTERS, kinds: ['single'] }) &&
        !P.matchesFilters(single, { ...P.DEFAULT_PACKAGE_FILTERS, channels: ['release'] }),
      '单包能被类型筛到、但不属于任何通道',
    );
    record(P.matchesFilters(off, { ...P.DEFAULT_PACKAGE_FILTERS, keyword: 'domino' }), '关键字筛（忽略大小写）命中');
    record(P.isEmptyFilters({ ...P.DEFAULT_PACKAGE_FILTERS, keyword: '  ' }), '只有空关键字算「没筛选」');
  }

  /* ---- 排序 ---- */
  {
    const list = [
      { version: '2.9', kind: 'official', channel: 'release', name: 'b' },
      { version: '2.10', kind: 'official', channel: 'release', name: 'a' },
      { version: undefined, kind: 'single', channel: undefined, name: 'c' },
    ];
    list.sort(P.compareEntries);
    record(list[0].version === '2.10', '版本倒序按数值比较（2.10 > 2.9）', String(list[0].version));
    record(list[2].version === undefined, '没有版本号的排最后');
  }
}

/* ------------------------------------------------------------------ */
/* B 磁盘层                                                            */
/* ------------------------------------------------------------------ */

function checkDisk() {
  const root = path.join(os.tmpdir(), `adb-assistant-pkg-${process.pid}`);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });

  /** 列某个相对目录下的文件名（断言失败时用来还原现场） */
  const listUnder = (base, rel) => {
    try {
      return fs.readdirSync(path.join(base, ...rel.split('/')));
    } catch {
      return [];
    }
  };

  const write = (rel, bytes) => {
    const p = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, Buffer.alloc(bytes, 1));
    return p;
  };

  // 散在根目录的样例
  write('Domino_GW_V2.83_release_18.apk', 64 * 1024);
  write('app-dmno_release-release_10.aab', 96 * 1024);
  write('weixin_8.0.50.apk', 32 * 1024);
  // 带上层版本目录的 Google 包（应该跟着目录走 2.84）
  write('下载/2.84/app-dmno_release-release_11.aab', 48 * 1024);
  // 无关文件：不该被移动
  write('说明.txt', 10);
  write('.hidden.apk', 10);
  write('~$temp.apk', 10);
  // 同名不同大小：应加 (2) 后缀，不覆盖
  write('2.83/官网包/release/Domino_GW_V2.83_release_18.apk', 32 * 1024);

  const cfg = {
    root,
    dirNames: DIRS,
    structure: 'version-first',
    keywords: P.DEFAULT_PACKAGE_KEYWORDS,
  };

  const scan1 = FS_.scanPackages(cfg);
  record(scan1.exists, '工作目录存在');
  record(scan1.entries.length === 5, '扫到 5 个 apk/aab（忽略非包与隐藏文件）', `actual=${scan1.entries.length}`);
  /*
   * ignored 只数「看得见的非安装包文件」（说明.txt）。
   * `.hidden.apk` 与 `~$temp.apk` 在遍历阶段就被跳过了，连计数都不进 ——
   * 它们不该出现在「另有 N 个文件不参与整理」这句提示里。
   */
  record(scan1.stats.ignored === 1, '非 apk/aab 文件计入 ignored（txt）', `actual=${scan1.stats.ignored}`);
  record(scan1.stats.byKind.official === 2, '官网包计数 2', `actual=${scan1.stats.byKind.official}`);
  record(scan1.stats.byKind.google === 2, 'Google 包计数 2', `actual=${scan1.stats.byKind.google}`);
  record(scan1.stats.byKind.single === 1, '单包计数 1', `actual=${scan1.stats.byKind.single}`);
  record(scan1.pending === 4, '待归置 4 个（已在位的那 1 个不算）', `actual=${scan1.pending}`);
  record(
    scan1.versions.join(',') === '8.0.50,2.84,2.83',
    '识别到的版本按数值倒序（8.0.50 > 2.84 > 2.83）',
    scan1.versions.join(','),
  );
  const f84 = scan1.entries.find((e) => e.name === 'app-dmno_release-release_11.aab');
  record(f84 && f84.version === '2.84' && f84.versionFrom === 'folder', 'Google 包版本取自上级目录', `${f84 && f84.version}/${f84 && f84.versionFrom}`);

  /* ---- 整理 ---- */
  const r1 = FS_.organizePackages(cfg);
  record(r1.moved === 4, '第一次整理移动 4 个', `actual=${r1.moved}`);
  record(r1.failed.length === 0, '第一次整理没有失败项', JSON.stringify(r1.failed));

  const at = (rel) => fs.existsSync(path.join(root, ...rel.split('/')));
  // 后缀加在扩展名之前（x.apk → x (2).apk），不是 x.apk (2).apk
  record(
    at('2.83/官网包/release/Domino_GW_V2.83_release_18 (2).apk'),
    '同名不同大小 → 加 (2) 后缀搬过去',
    listUnder(root, '2.83/官网包/release').join(' | '),
  );
  record(
    fs.statSync(path.join(root, '2.83/官网包/release/Domino_GW_V2.83_release_18.apk')).size === 32 * 1024,
    '原位置的同名文件没有被覆盖',
  );
  record(at('未识别版本/Google包/release/app-dmno_release-release_10.aab'), 'Google 包落到 未识别版本/Google包/release');
  record(at('8.0.50/单包/weixin_8.0.50.apk'), '单包落到 8.0.50/单包（无 release/test 层）');
  record(at('2.84/Google包/release/app-dmno_release-release_11.aab'), '带目录版本的 Google 包落到 2.84/Google包/release');
  record(at('说明.txt') && at('.hidden.apk') && at('~$temp.apk'), '非安装包文件原地不动');

  /* ---- 幂等 ---- */
  const scan2 = FS_.scanPackages(cfg);
  record(scan2.pending === 0, '整理后没有「待归置」', `actual=${scan2.pending}`);
  const r2 = FS_.organizePackages(cfg);
  record(r2.moved === 0 && r2.failed.length === 0, '再整理一次移动 0 个（幂等）', `moved=${r2.moved}`);

  /* ---- 幂等：加过 (2) 后缀的包也不会被反复搬 ---- */
  record(
    scan2.entries.some((e) => e.name.endsWith('(2).apk') && e.organized),
    '(2) 后缀的包被视为已在正确位置',
  );

  /* ---- 类型优先结构下重新归置 ---- */
  const cfg2 = { ...cfg, structure: 'type-first' };
  const r3 = FS_.organizePackages(cfg2);
  record(r3.moved === 5, '切到类型优先结构后 5 个都被重新归置', `actual=${r3.moved}`);
  record(at('官网包/2.83/release/Domino_GW_V2.83_release_18.apk'), 'type-first：官网包/2.83/release');
  record(at('单包/8.0.50/weixin_8.0.50.apk'), 'type-first：单包/8.0.50');

  /* ---- 目录不存在时：scan 返回 exists=false，不抛错 ---- */
  const ghost = { ...cfg, root: path.join(os.tmpdir(), `adb-assistant-pkg-ghost-${process.pid}`) };
  const scanGhost = FS_.scanPackages(ghost);
  record(scanGhost.exists === false && scanGhost.entries.length === 0, '目录不存在时 scan 返回 exists=false');

  /* ---- 带手动标签的整理（配置里带 overrides，磁盘层要照它搬） ---- */
  {
    const root2 = path.join(os.tmpdir(), `adb-assistant-pkg-ov-${process.pid}`);
    fs.rmSync(root2, { recursive: true, force: true });
    fs.mkdirSync(root2, { recursive: true });
    fs.writeFileSync(path.join(root2, 'weixin_8.0.50.apk'), Buffer.alloc(16 * 1024, 3));

    const cfgOv = {
      ...cfg,
      root: root2,
      overrides: { 'weixin_8.0.50.apk': { kind: 'official', channel: 'test', version: '9.9.9' } },
    };
    const s = FS_.scanPackages(cfgOv);
    const e0 = s.entries[0];
    record(
      s.entries.length === 1 && e0.kind === 'official' && e0.overridden === true && e0.targetDir === '9.9.9/官网包/test',
      '扫描结果按手动标签归类',
      JSON.stringify(e0 && { k: e0.kind, t: e0.targetDir, ov: e0.overridden }),
    );
    const rr = FS_.organizePackages(cfgOv);
    record(
      rr.moved === 1 && fs.existsSync(path.join(root2, '9.9.9/官网包/test/weixin_8.0.50.apk')),
      '整理把它搬到 9.9.9/官网包/test',
      `moved=${rr.moved}`,
    );

    // 撤掉标签后要能按自动识别搬回来 —— 否则「改错了没法回头」
    const rr2 = FS_.organizePackages({ ...cfg, root: root2 });
    record(
      rr2.moved === 1 && fs.existsSync(path.join(root2, '8.0.50/单包/weixin_8.0.50.apk')),
      '取消手动标签后整理搬回 8.0.50/单包',
      `moved=${rr2.moved}`,
    );
    fs.rmSync(root2, { recursive: true, force: true });
  }

  /* ---- 安全闸门：盘符根不能当工作目录 ---- */
  const driveRoot = path.parse(root).root;
  record(!!FS_.checkRootUsable(driveRoot), '盘符根被拒绝', String(FS_.checkRootUsable(driveRoot)));
  record(FS_.checkRootUsable(root) === null, '正常目录通过安全检查');
  record(!!FS_.checkRootUsable(''), '空目录被拒绝');

  fs.rmSync(root, { recursive: true, force: true });
}

/* ------------------------------------------------------------------ */

(() => {
  try {
    fs.writeFileSync(LOG, '');
  } catch {
    /* ignore */
  }

  let crashed = '';
  try {
    checkRules();
    checkDisk();
  } catch (e) {
    crashed = e && e.stack ? e.stack : String(e);
    record(false, '用例执行异常', e && e.message ? e.message : String(e));
  }

  const pass = rows.filter((r) => r.startsWith('PASS')).length;
  const fail = rows.filter((r) => r.startsWith('FAIL')).length;

  log('===== 安装包管理 CHECK =====');
  for (const r of rows) log(r);
  log(`${pass} 通过 / ${fail} 失败`);
  if (crashed) log(crashed);
  log('PACKAGES CHECK DONE');

  process.exit(fail === 0 ? 0 : 1);
})();
