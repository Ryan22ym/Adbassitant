/**
 * 自动连点器验收（v1.0.32）
 * ============================================================
 *
 * 覆盖三层，**不碰真机**：
 *
 *   A. 服务层：脚本仓库（增删改查/清洗/持久化）
 *   B. 转换层：RecordedSession → ClickerStep[]（手势归并、wait 生成、note 注入）
 *   C. 链路层：preload → ipc → service 的真实往返（走 window.adbApi，不直连服务模块）
 *
 * ## 为什么 C 段必须走 window.adbApi
 *
 * 项目里踩过这个坑（弱网 /start 那次的教训）：直接 require 服务模块测，
 * 会**绕开 preload 的字面量副本与 ipcMain 注册**——通道名写错、handler 漏注册、
 * preload api 方法忘了加，全都能"测过"。所以 C 段一律从渲染层发。
 *
 * ## 为什么 B 段用合成数据而不是真录一段
 *
 * 真录制要连设备、要用户手动授权、要先在手机上点一堆东西 —— 放进回归脚本里
 * 就成了"跑不动"的测试，等于没有。手势归并是个**纯函数**，用构造好的
 * down/move/up 序列就能把三条判定路径（点击 / 长按 / 滑动）全打到。
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'ui-shots');
const LOG = path.join(OUT, '_clicker.log');
try {
  fs.mkdirSync(OUT, { recursive: true });
} catch {}
fs.writeFileSync(LOG, '');

function log(...a) {
  fs.appendFileSync(LOG, a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') + '\n');
}

const electronMain = require('electron');
if (typeof electronMain !== 'object' || !electronMain.app) process.exit(2);
const { app, BrowserWindow } = electronMain;

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
}

app.whenReady().then(async () => {
  log('=== CLICKER CHECK ===');

  /* ================================================================ */
  /* A. 服务层：脚本仓库                                                */
  /* ================================================================ */

  const clicker = require('../dist-electron/electron/services/auto-clicker.js');
  const storeFile = path.join(app.getPath('userData'), 'clicker-scripts.json');
  const backup = fs.existsSync(storeFile) ? fs.readFileSync(storeFile, 'utf8') : null;

  try {
    clicker.resetScripts();
    check('A1 初始为空', clicker.listScripts().length === 0);

    // 有效脚本
    const res1 = clicker.saveScript({
      name: '冒烟脚本',
      steps: [{ kind: 'tap', nx: 0.5, ny: 0.5 }],
      loop: 3,
      speed: 2,
      jitterPx: 8,
    });
    const list = res1.list;
    check('A2 保存后有 1 条', list.length === 1, `name=${list[0] && list[0].name}`);
    check('A2b created 标记正确', res1.created === true);
    const id = list[0] && list[0].id;
    check('A3 分配了 id', !!id);
    check('A4 loop/speed/jitter 落库', list[0].loop === 3 && list[0].speed === 2 && list[0].jitterPx === 8);

    // 无步骤 → 必须拒绝（防止存进去一个空壳，回放时才知道没内容）
    let rejected = false;
    try {
      clicker.saveScript({ name: '空的', steps: [] });
    } catch {
      rejected = true;
    }
    check('A5 空步骤被拒', rejected);

    // 非法 kind 被清洗掉 → 也算空 → 拒绝
    let rejected2 = false;
    try {
      clicker.saveScript({ name: '乱来', steps: [{ kind: '__evil__', x: 1 }] });
    } catch {
      rejected2 = true;
    }
    check('A6 非法步骤类型被拒', rejected2);

    // 越界值被夹回合法区间（IPC 传进来的东西不能信）
    const clamped = clicker
      .saveScript({
        name: '越界',
        steps: [{ kind: 'tap', nx: 99, ny: -5, count: 9999 }],
        loop: -100,
        speed: 999,
        jitterPx: -50,
      })
      .list.find((s) => s.name === '越界');
    check(
      'A7 越界值被夹回区间',
      clamped.steps[0].nx === 1 &&
        clamped.steps[0].ny === 0 &&
        clamped.steps[0].count === 100 &&
        clamped.loop === 0 &&
        clamped.speed === 10 &&
        clamped.jitterPx === 0,
      `nx=${clamped.steps[0].nx} ny=${clamped.steps[0].ny} count=${clamped.steps[0].count} loop=${clamped.loop} speed=${clamped.speed} jit=${clamped.jitterPx}`,
    );

    // shell 步骤不许空命令；launch 步骤不许空包名/非法字符
    const shellList = clicker.listScripts();
    check('A8 shell 空命令不落库', !shellList.some((s) => s.steps.some((x) => x.kind === 'shell' && !x.cmd)));
    let launchRejected = false;
    try {
      clicker.saveScript({ name: 'launch', steps: [{ kind: 'launch', pkg: 'com.a b;rm -rf /' }] });
    } catch {
      launchRejected = true;
    }
    check('A9 launch 非法包名被拒', launchRejected);

    // 同 id 保存 = 更新（不是新增），且保留 createdAt
    const beforeTs = clicker.listScripts().find((s) => s.id === id).createdAt;
    const upd = clicker.saveScript({
      id,
      name: '冒烟脚本改名',
      steps: [{ kind: 'wait', ms: 500 }],
      loop: 1,
      speed: 1,
      jitterPx: 0,
    });
    check('A10 同 id 是更新不是新增', upd.created === false, `created=${upd.created}`);
    check('A10b 条数没变', upd.list.length === clicker.listScripts().length);
    check('A10c 返回的 script.id 未变', upd.script.id === id);
    const updated = clicker.listScripts().find((s) => s.id === id);
    check('A11 名称已改', updated.name === '冒烟脚本改名');
    check('A12 createdAt 保留', updated.createdAt === beforeTs, `before=${beforeTs} after=${updated.createdAt}`);

    // 删除
    const afterDel = clicker.deleteScript(id);
    check('A13 删除生效', !afterDel.some((s) => s.id === id));

    // keycode 表非空且是纯数据
    check('A14 keycode 表可用', Array.isArray(clicker.CLICKER_KEYCODES) && clicker.CLICKER_KEYCODES.length > 5);

    /* ================================================================ */
    /* B. 转换层：录制数据 → 步骤                                          */
    /* ================================================================ */

    /*
     * 构造一段时间线（ms）：
     *   1000  down  @(0.30, 0.40)          ← 纯点击（无 move，短时长）
     *   1100  up    @(0.30, 0.40)
     *   ---- 间隔 900ms（>= MIN_WAIT 80）→ 应生成 wait
     *   2000  down  @(0.50, 0.50)
     *   2100  move  @(0.51, 0.505)         ← 位移 0.01 / 0.005，均在阈值内 → 仍算原地
     *   2600  up    @(0.51, 0.505)         ← 时长 600ms >= 450ms → 长按
     *   ---- 间隔 2000ms → wait
     *   4600  down  @(0.20, 0.80)
     *   4700  move  @(0.40, 0.60)          ← 超阈值 → 滑动
     *   4900  up    @(0.60, 0.30)
     *
     * 同时插一条 foreground 系统事件（应变成 note）与一条 no_permission（应被丢掉）。
     */
    const session = {
      meta: { width: 1080, height: 2400, density: 420, landscape: false },
      touches: [
        { type: 'down', nx: 0.3, ny: 0.4, t: 1000 },
        { type: 'up', nx: 0.3, ny: 0.4, t: 1100 },

        { type: 'down', nx: 0.5, ny: 0.5, t: 2000 },
        { type: 'move', nx: 0.51, ny: 0.505, t: 2100 },
        { type: 'up', nx: 0.51, ny: 0.505, t: 2600 },

        { type: 'down', nx: 0.2, ny: 0.8, t: 4600 },
        { type: 'move', nx: 0.4, ny: 0.6, t: 4700 },
        { type: 'up', nx: 0.6, ny: 0.3, t: 4900 },
      ],
      frames: [{ t: 2000, id: 1, bytes: 12345 }],
      sysEvents: [
        { kind: 'no_permission', pkg: '', t: 500, label: '没有使用情况访问权限' },
        { kind: 'foreground', pkg: 'com.android.settings', t: 1500, label: '前台切换到 设置' },
      ],
    };

    const steps = clicker.sessionToSteps(session);
    log('生成步骤：' + JSON.stringify(steps, null, 0));

    const kinds = steps.map((s) => s.kind);
    check('B1 产出步骤非空', steps.length > 0, `${steps.length} 步`);
    check('B2 含点击', kinds.includes('tap'));
    check('B3 含长按', kinds.includes('longPress'));
    check('B4 含滑动', kinds.includes('swipe'));
    check('B5 含说明(note)', kinds.includes('note'));

    check('B6 8 条触摸归并成 3 个动作', kinds.filter((k) => k !== 'wait' && k !== 'note').length === 3, kinds.join(','));

    const tap = steps.find((s) => s.kind === 'tap');
    check(
      'B7 点击坐标正确',
      tap && Math.abs(tap.nx - 0.3) < 0.001 && Math.abs(tap.ny - 0.4) < 0.001,
      tap ? `(${tap.nx},${tap.ny})` : 'none',
    );

    const lp = steps.find((s) => s.kind === 'longPress');
    check('B8 长按时长=600ms', lp && lp.ms === 600, lp ? `${lp.ms}` : 'none');

    const sw = steps.find((s) => s.kind === 'swipe');
    check(
      'B9 滑动起止点正确',
      sw && Math.abs(sw.nx1 - 0.2) < 0.001 && Math.abs(sw.ny1 - 0.8) < 0.001 &&
        Math.abs(sw.nx2 - 0.6) < 0.001 && Math.abs(sw.ny2 - 0.3) < 0.001,
      sw ? `(${sw.nx1},${sw.ny1})→(${sw.nx2},${sw.ny2})` : 'none',
    );
    check('B10 滑动时长=300ms（4900-4600）', sw && sw.durationMs === 300, sw ? `${sw.durationMs}` : 'none');

    const waits = steps.filter((s) => s.kind === 'wait');
    check('B11 生成了 wait 步骤', waits.length >= 1, waits.map((w) => w.ms).join(','));
    check(
      'B12 wait 时长贴近真实间隔',
      waits.some((w) => Math.abs(w.ms - 900) <= 5) && waits.some((w) => Math.abs(w.ms - 2000) <= 5),
      waits.map((w) => w.ms).join(','),
    );

    // no_permission 这类环境说明不该进脚本（回放时不会重现，放着只会误导）
    check(
      'B13 no_permission 事件被丢弃',
      !steps.some((s) => s.kind === 'note' && /权限/.test(s.text || '')),
    );
    check(
      'B14 foreground 事件变成 note',
      steps.some((s) => s.kind === 'note' && /设置/.test(s.text || '')),
    );

    // 空输入不能炸
    check('B15 空 session 返回空数组', clicker.sessionToSteps({ touches: [], sysEvents: [], frames: [] }).length === 0);
    check('B16 null 字段不炸', Array.isArray(clicker.sessionToSteps({ meta: null })));

    // 断头数据（有 down 没 up）也要能收尾，不能丢手势
    const truncated = clicker.sessionToSteps({
      touches: [
        { type: 'down', nx: 0.1, ny: 0.1, t: 0 },
        { type: 'move', nx: 0.5, ny: 0.5, t: 200 },
      ],
      sysEvents: [],
      frames: [],
    });
    check('B17 缺 up 的断头手势仍产出步骤', truncated.length >= 1, JSON.stringify(truncated));

    /*
     * B19（回归）：**恰好压在阈值上**的位移必须判为「没动」。
     *
     * 这是个真实踩过的坑：0.52 - 0.50 在 IEEE754 下等于 0.020000000000000018，
     * 用 `Math.abs(dx) > 0.02` 会得到 true —— 一个刚好移动 2% 屏宽的原地长按
     * 被判成滑动。录制端把坐标 round 到 4 位小数，落点压在阈值上很常见，
     * 于是同一段录制转两次可能给出不同的脚本。
     *
     * 三条数据分别验证：压线(0.02) → 未动；略超(0.021) → 动了；横向压线但纵向超 → 动了。
     */
    const boundary = (dx, dy) =>
      clicker.sessionToSteps({
        touches: [
          { type: 'down', nx: 0.5, ny: 0.5, t: 0 },
          { type: 'move', nx: 0.5 + dx, ny: 0.5 + dy, t: 100 },
          { type: 'up', nx: 0.5 + dx, ny: 0.5 + dy, t: 900 },
        ],
        sysEvents: [],
        frames: [],
      })[0].kind;

    check('B19a 位移恰好=阈值 判为未移动', boundary(0.02, 0) !== 'swipe', `→ ${boundary(0.02, 0)}`);
    check('B19b 位移略超阈值 判为移动', boundary(0.021, 0) === 'swipe', `→ ${boundary(0.021, 0)}`);
    check('B19c 纵向超阈值 判为移动', boundary(0, 0.03) === 'swipe', `→ ${boundary(0, 0.03)}`);
    check('B19d 压线的长按仍识别为长按', boundary(0.02, 0) === 'longPress', `→ ${boundary(0.02, 0)}`);

    // describeStep 不能对任何 kind 抛异常（界面进度条依赖它）
    let descOk = true;
    const allKinds = [
      { kind: 'tap', nx: 0.1, ny: 0.2, count: 2 },
      { kind: 'longPress', nx: 0.1, ny: 0.2, ms: 500 },
      { kind: 'swipe', nx1: 0, ny1: 0, nx2: 1, ny2: 1, durationMs: 300 },
      { kind: 'key', code: 3 },
      { kind: 'wait', ms: 100 },
      { kind: 'screenshot' },
      { kind: 'shell', cmd: 'ls' },
      { kind: 'launch', pkg: 'com.a.b' },
      { kind: 'note', text: 'hi' },
    ];
    for (const s of allKinds) {
      try {
        const d = clicker.describeStep(s, { w: 1080, h: 2400 });
        if (!d || typeof d !== 'string') descOk = false;
      } catch (e) {
        descOk = false;
        log(`describeStep 抛异常：${s.kind} → ${e.message}`);
      }
    }
    check('B18 describeStep 覆盖全部 kind', descOk);
  } catch (e) {
    check('A/B 段异常', false, e.stack || e.message);
  } finally {
    // 还原用户真实脚本库，别让回归把用户数据清了
    try {
      if (backup !== null) fs.writeFileSync(storeFile, backup, 'utf8');
      else if (fs.existsSync(storeFile)) fs.unlinkSync(storeFile);
    } catch (e) {
      log(`还原脚本库失败：${e.message}`);
    }
  }

  /* ================================================================ */
  /* C. 链路层：preload → ipc → service 真实往返                        */
  /* ================================================================ */

  const { registerIpc } = require('../dist-electron/electron/ipc.js');
  registerIpc();

  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    show: false,
    webPreferences: {
      preload: path.join(ROOT, 'dist-electron', 'electron', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const consoleErrors = [];
  win.webContents.on('console-message', (_e, level, msg) => {
    if (level >= 2) consoleErrors.push(msg);
  });
  /**
   * C14 会**故意**订阅一个不在白名单里的通道来验证拦截生效，
   * preload 为此打一条 warn 是预期行为，不算渲染层错误。
   * 这里把它排除掉，否则测试自己制造的噪声会污染 C15。
   */
  const filterNoise = (list) => list.filter((m) => !/未允许的通道：push:__not_allowed__/.test(m));

  try {
    await win.loadFile(path.join(ROOT, 'dist', 'index.html'), { hash: '/clicker' });
    await new Promise((r) => setTimeout(r, 1200));

    // C1: 页面真的渲染出来了（不是白屏 / 路由没接上）
    const dom = await win.webContents.executeJavaScript(`
      (() => ({
        title: document.querySelector('.header-title')?.textContent || '',
        hasSeg: !!document.querySelector('.segmented'),
        navActive: [...document.querySelectorAll('.nav-item.active .nav-label')].map(e => e.textContent),
      }))()
    `);
    check('C1 页面渲染成功', dom.title === '自动连点器', `title="${dom.title}"`);
    check('C2 侧栏高亮正确', dom.navActive.length === 1 && dom.navActive[0] === '自动连点器');
    check('C3 两个 Tab 存在', dom.hasSeg);

    // C4: 切到录制 Tab，验证录制面板渲染（未连设备时应给出提示而不是崩）
    const recTab = await win.webContents.executeJavaScript(`
      (async () => {
        const btns = [...document.querySelectorAll('.segmented-item')];
        const rec = btns.find(b => b.textContent.includes('录制'));
        if (!rec) return { ok: false, reason: '找不到录制 Tab' };
        rec.click();
        await new Promise(r => setTimeout(r, 700));
        return {
          ok: true,
          body: document.body.innerText.includes('录制'),
          hasCard: !!document.querySelector('.card'),
        };
      })()
    `);
    check('C4 录制 Tab 可切换', recTab.ok && recTab.hasCard, recTab.reason || '');

    // C5: preload 暴露的方法齐全（少一个就是界面点下去 undefined 崩）
    const apiShape = await win.webContents.executeJavaScript(`
      (() => {
        const need = [
          'clickerList','clickerSave','clickerDelete','clickerReset','clickerFromRecord',
          'clickerRun','clickerStop','clickerStatus','clickerRunStep','clickerKeycodes',
          'recorderInfo','recorderInstall','recorderAuthorize','recorderOpenUi','recorderStart',
          'recorderPause','recorderStop','recorderReset','recorderStatus','recorderPull','recorderFrame',
        ];
        const missing = need.filter(k => typeof window.adbApi[k] !== 'function');
        return { missing, total: need.length };
      })()
    `);
    check('C5 preload 方法齐全', apiShape.missing.length === 0, apiShape.missing.join(',') || 'ok');

    // C6: 通道常量与 preload 字面量副本一致（两处同步的硬要求）
    const chanSync = await win.webContents.executeJavaScript(`
      (() => {
        const c = window.adbApi.channels;
        const pairs = [
          ['CLICKER_LIST','clicker:list'], ['CLICKER_SAVE','clicker:save'],
          ['CLICKER_DELETE','clicker:delete'], ['CLICKER_RESET','clicker:reset'],
          ['CLICKER_FROM_RECORD','clicker:fromRecord'], ['CLICKER_RUN','clicker:run'],
          ['CLICKER_STOP','clicker:stop'], ['CLICKER_STATUS','clicker:status'],
          ['CLICKER_RUN_STEP','clicker:runStep'], ['CLICKER_KEYCODES','clicker:keycodes'],
          ['RECORDER_INFO','recorder:info'], ['RECORDER_INSTALL','recorder:install'],
          ['RECORDER_AUTHORIZE','recorder:authorize'], ['RECORDER_START','recorder:start'],
          ['RECORDER_PAUSE','recorder:pause'], ['RECORDER_STOP','recorder:stop'],
          ['RECORDER_RESET','recorder:reset'], ['RECORDER_STATUS','recorder:status'],
          ['RECORDER_PULL','recorder:pull'], ['RECORDER_FRAME','recorder:frame'],
          ['RECORDER_OPEN_UI','recorder:openUi'],
          ['PUSH_CLICKER_PROGRESS','push:clickerProgress'],
          ['PUSH_RECORDER_STATUS','push:recorderStatus'],
        ];
        const bad = pairs.filter(([k, v]) => c[k] !== v).map(([k, v]) => k + '=' + c[k] + '≠' + v);
        return { bad };
      })()
    `);
    check('C6 通道字面量两处一致', chanSync.bad.length === 0, chanSync.bad.join(' | ') || 'ok');

    // C7: 真实 IPC 往返 —— clicker:list
    const listRes = await win.webContents.executeJavaScript(
      `window.adbApi.clickerList().then(r => ({ ok: r.ok, isArr: Array.isArray(r.data) }))`,
    );
    check('C7 clicker:list 往返成功', listRes.ok && listRes.isArr, JSON.stringify(listRes));

    // C8: 真实 IPC 往返 —— clicker:keycodes
    const kcRes = await win.webContents.executeJavaScript(
      `window.adbApi.clickerKeycodes().then(r => ({ ok: r.ok, n: (r.data||[]).length }))`,
    );
    check('C8 clicker:keycodes 往返成功', kcRes.ok && kcRes.n > 5, `n=${kcRes.n}`);

    // C9: 真实 IPC 往返 —— clicker:status（未运行时必须返回 running=false，不能抛）
    const stRes = await win.webContents.executeJavaScript(
      `window.adbApi.clickerStatus().then(r => ({ ok: r.ok, running: r.data && r.data.running }))`,
    );
    check('C9 clicker:status 返回未运行', stRes.ok && stRes.running === false, JSON.stringify(stRes));

    // C10: 真实 IPC 往返 —— clicker:save + list + delete 全链路
    // 注意 save 返回 { script, list, created }：script 是后端权威结果，
    // 界面靠它回写草稿（不再用「名字+步数」猜自己刚存的是哪一条）
    const crud = await win.webContents.executeJavaScript(`
      (async () => {
        const save = await window.adbApi.clickerSave({
          id: '', name: '__e2e_clicker__',
          steps: [{ kind: 'tap', nx: 0.25, ny: 0.75, count: 2 }],
          loop: 2, speed: 1.5, jitterPx: 4,
        });
        if (!save.ok) return { step: 'save', err: save.error };
        const d = save.data;
        if (!d || !d.script || !d.script.id) return { step: 'shape', err: JSON.stringify(d) };
        if (d.created !== true) return { step: 'created-flag', err: String(d.created) };
        if (!Array.isArray(d.list)) return { step: 'list-shape', err: typeof d.list };

        // 第二次保存同一 id → created 应为 false（走更新分支）
        const again = await window.adbApi.clickerSave({ ...d.script, name: '__e2e_clicker2__' });
        if (!again.ok) return { step: 'save2', err: again.error };
        if (again.data.created !== false) return { step: 'update-flag', err: String(again.data.created) };
        if (again.data.script.id !== d.script.id) return { step: 'id-stable', err: 'id changed' };

        const del = await window.adbApi.clickerDelete(d.script.id);
        if (!del.ok) return { step: 'delete', err: del.error };
        const after = (del.data || []).some(s => s.name === '__e2e_clicker2__');
        return { step: 'done', id: d.script.id, removed: !after };
      })()
    `);
    check(
      'C10 save→update→delete 全链路',
      crud.step === 'done' && crud.removed,
      JSON.stringify(crud),
    );

    // C11: fromRecord 走真实 IPC（转换逻辑在主进程，验证它能被调通）
    const conv = await win.webContents.executeJavaScript(`
      window.adbApi.clickerFromRecord({
        meta: { width: 1080, height: 2400, density: 420, landscape: false },
        touches: [
          { type: 'down', nx: 0.5, ny: 0.5, t: 0 },
          { type: 'up', nx: 0.5, ny: 0.5, t: 80 },
        ],
        frames: [],
        sysEvents: [],
      }).then(r => ({ ok: r.ok, n: (r.data && r.data.steps || []).length, meta: !!(r.data && r.data.meta) }))
    `);
    check('C11 clicker:fromRecord 往返成功', conv.ok && conv.n >= 1 && conv.meta, JSON.stringify(conv));

    // C12: 未连设备时点回放必须给出可读错误，而不是静默失败或崩
    const runNoDev = await win.webContents.executeJavaScript(`
      window.adbApi.clickerRun(
        { id: '', name: 't', steps: [{ kind: 'tap', nx: 0.5, ny: 0.5, count: 1 }], loop: 1, speed: 1, jitterPx: 0 },
        'nonexistent-serial-xyz'
      ).then(r => ({ ok: r.ok, err: r.error || '' }))
    `);
    check(
      'C12 无设备回放给出可读错误',
      runNoDev.ok === false && runNoDev.err.length > 0,
      runNoDev.err.slice(0, 120),
    );

    // C13: 未连设备时 recorder:info 也要给可读错误（不是崩）
    const recInfo = await win.webContents.executeJavaScript(`
      window.adbApi.recorderInfo('nonexistent-serial-xyz')
        .then(r => ({ ok: r.ok, err: r.error || '' }))
    `);
    check('C13 recorder:info 无设备可读报错', recInfo.ok === false && recInfo.err.length > 0, recInfo.err.slice(0, 120));

    // C14: 推送白名单 —— 未允许的通道必须被拒（返回空取消函数）
    const pushGuard = await win.webContents.executeJavaScript(`
      (() => {
        const bad = window.adbApi.on('push:__not_allowed__', () => {});
        const good = window.adbApi.on('push:clickerProgress', () => {});
        const r = { badIsFn: typeof bad === 'function', goodIsFn: typeof good === 'function' };
        try { good(); } catch {}
        return r;
      })()
    `);
    check(
      'C14 推送白名单生效',
      pushGuard.badIsFn && pushGuard.goodIsFn,
      JSON.stringify(pushGuard),
    );

    const realErrors = filterNoise(consoleErrors);
    check('C15 渲染层无 console 错误', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));
  } catch (e) {
    check('C 段异常', false, e.stack || e.message);
  }

  /* ================================================================ */

  const failed = results.filter((r) => !r.ok);
  log('');
  log(`总计 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`);
  if (failed.length) {
    log('失败项：');
    for (const f of failed) log(`  · ${f.name}  ${f.detail}`);
  }

  app.exit(failed.length ? 1 : 0);
});
