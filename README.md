# ADB 桌面助手 v1.0

一个用 **Electron + React + TypeScript** 重构的 Android 设备管理工具。
界面简洁、深色/浅色可切换，代码分层清晰，方便长期维护与迭代。

---

## 功能（v1.0）

| 模块 | 能力 |
| --- | --- |
| **设备** | USB / 无线自动识别、多设备切换、设备详情、USB 一键转无线、原生无线地址连接 |
| **投屏** | scrcpy 独立窗口投屏，画质预设（4 档）+ 自定义参数，键盘模式/常亮/置顶可选 |
| **截图** | 一键截屏，直读 PNG 到本地，界面内缩略图预览，支持打开所在文件夹 |
| **录屏** | 设备端 screenrecord；设备未内置时自动回退 scrcpy 录制通道，自动落地 MP4 |
| **分辨率** | 查看物理/当前分辨率与 DPI，5 组预设 + 自定义，一键恢复默认 |
| **Monkey** | 图形化稳定性测试，可选目标应用、事件数、节流、seed，实时输出日志 |
| **安装 APK** | 选择本地 APK 安装，支持覆盖安装与自动授权 |
| **文件传输** | 批量 push 到设备、批量 pull 到电脑 |
| **应用管理** 🆕 | 用户/系统/全部三态筛选 + 关键字搜索；详情（版本号/占用/安装时间/Activity 数/权限）；启动、强制停止、清除数据、提取 APK、启用停用、卸载 |
| **实时 Logcat** 🆕 | 流式抓取（120ms 批量推送 + 20000 行环形缓冲）；级别/TAG 通配/关键字/进程/缓冲区多路过滤；快捷过滤（只看错误 / 闪退 ANR / Activity 启动）；暂停刷新、一键保存 |
| **弱网模拟** 🆕 | 对标 clumsy，上行/下行独立配置 7 个参数（带宽/延迟/抖动/丢包/错报/乱序/重复包）；6 个内置档位 + 自定义预设持久化；持续时长与倒计时；设备能力探测（Root/tc/ifb）；未 Root 可走整体断网保底 |
| **命令终端** | 执行任意 adb 命令，16 个常用命令快捷入口，↑/↓ 翻阅历史 |
| **运行日志** | 实时记录全部命令与结果，按级别筛选、关键字搜索、一键导出 txt |
| **设置** | 主题切换、默认保存目录、环境自检 |

### 弱网模拟说明

| 方向 | 含义 | 实现 |
| --- | --- | --- |
| **上行** | 设备发出的流量（上传、请求） | `tc qdisc add dev <iface> root netem …` |
| **下行** | 设备收到的流量（下载、响应） | 先挂 `ifb` 网卡 + `ingress` 重定向，再在 ifb 上挂 netem |

- 带宽限制用 `tbf` 而非 netem 的 `rate`（更准）；其余参数走 netem。
- 两向可独立配置，模拟真实网络的不对称性。
- **前置条件**：上行 netem 需要 Root（`su`）；下行需要内核 `ifb` 模块。
  两者都不具备时，可用「整体断网」开关（`svc wifi/data disable`，免 Root）。
- 预设持久化在 `userData/weaknet-presets.json`，与内置档位分开管理。
- 启动前会先 `probeDevice()` 探测设备能力，UI 如实展示三行能力卡片。

---

## 技术架构

```
adb-assistant-v0.9/
├── electron/                  # 主进程（Node 侧）
│   ├── main.ts                # 应用入口、窗口、设备轮询
│   ├── preload.ts             # contextBridge 安全桥接
│   ├── ipc.ts                 # 所有 IPC 处理器集中注册
│   ├── env-check.ts           # 环境自检
│   └── services/              # 业务服务层（与 UI 完全解耦）
│       ├── adb.ts             # 子进程执行器、设备枚举、日志管道
│       ├── device-ops.ts      # 分辨率、截图、录屏
│       ├── mirror.ts          # scrcpy 投屏与录制
│       ├── files.ts           # push/pull、APK 安装、应用列表与详情、Monkey
│       ├── logcat.ts          # 实时 logcat 流式抓取、环形缓冲、多路过滤
│       ├── weaknet.ts         # 弱网模拟（tc/netem + ifb）、设备能力探测、预设持久化
│       ├── logger.ts          # 会话日志缓冲与导出
│       └── settings.ts        # 配置持久化
│
├── shared/
│   └── types.ts               # 主/渲染进程共享类型 + IPC 通道常量
│
├── src/                       # 渲染进程（React）
│   ├── App.tsx                # 路由与全局订阅
│   ├── components/
│   │   ├── ui.tsx             # 基础组件库（Button/Card/Field/Switch…）
│   │   ├── ui.css
│   │   ├── layout.tsx         # 侧边栏、顶栏、设备选择器、Toast
│   │   └── layout.css
│   ├── pages/                 # 九个功能页面
│   ├── store/app.ts           # Zustand 全局状态
│   ├── lib/                   # ipc 封装、格式化工具
│   └── styles/global.css      # 设计系统变量（浅/深色）
│
├── bin/                       # adb / scrcpy 等二进制（运行时资源）
└── scripts/prepare-bin.mjs    # 从原项目复制二进制
```

### 设计要点

- **分层解耦**：`services/` 只依赖 Node，不碰 Electron UI；`ipc.ts` 只做转发。
  想加功能，写 service → 在 `shared/types.ts` 加通道 → 在 `ipc.ts` 注册 → preload 暴露 → 页面调用。
- **契约先行**：所有跨进程类型集中定义在 `shared/types.ts`，前后端共用，避免各写一套。
- **统一错误处理**：主进程 `wrap()` 把异常转成 `{ ok, data, error }`；
  渲染进程 `call()` 统一拆包 + toast，页面只写成功路径。
- **日志即基础设施**：所有 adb 调用都经过 `runAdb()`，自动记录命令、耗时与输出，
  与"一键导出"天然打通，不需要各功能自己埋点。
- **设计系统**：颜色/圆角/阴影全部走 CSS 变量，深色模式只需覆盖变量表。

---

## 开发

```bash
# 1. 安装依赖
npm install

# 2. 从原项目复制 adb / scrcpy 二进制到 bin/
node scripts/prepare-bin.mjs

# 3. 启动开发环境（Vite + Electron 同时起）
npm run dev
```

> 若 `bin/` 为空，请把 `adb.exe`、`scrcpy.exe`、`scrcpy-server` 及配套 DLL
> 手动放入 `bin/` 目录，或在 `vendor/` 放一份后重跑复制脚本。

## 打包

```bash
# 推荐：自动起本地 mirror，绕开 winCodeSign 的 macOS 符号链接问题
python scripts/build.py

# 跳过编译，只重跑 electron-builder
python scripts/build.py --no-build

# 输出目录被句柄锁住时换个名字（见下方「输出目录被僵尸句柄锁住」）
python scripts/build.py --out out-v1.1
```

产物目录由 `electron-builder.json` 的 `directories.output` 决定，同时生成 NSIS 安装包与
免安装 portable 版本，命名形如 `ADB桌面助手-v1.0.0-x64.exe` / `ADB桌面助手-v1.0.0-portable.exe`。
二进制文件通过 `extraResources` 打进 `resources/bin/`。

> **别直接 `npm run dist`**：它去官方源下载 `winCodeSign-2.6.0.7z`，该包内含 macOS 符号链接，
> Windows 非管理员环境解压必然失败，会导致 exe 资源未被改写（产物退化为裸 Node 模式且静默失效）。
> `scripts/build.py` 会拉起本地 HTTP mirror（读 `eb-mirror/`）绕过这一步，
> 并且已经剔除环境里的 `ELECTRON_RUN_AS_NODE`。
>
> 生产包验收脚本的产物目录可用环境变量覆盖：
> `ADB_OUT_DIR=out-v1.1 node scripts/e2e-packaged.cjs`。默认仍是 `out-v1`。

### 打包前必读：不要让进程占住输出目录

打包会**删除并重建**输出目录下的 `win-unpacked/`。如果有进程把该目录作为**当前工作目录**
（例如测试脚本 `spawn(exe, { cwd: win-unpacked })`），Windows 会持有目录句柄，
electron-builder 删除时直接报"拒绝访问"。

**规则**：任何启动产物 exe 的脚本，`cwd` 必须指向中性目录（如 `os.tmpdir()`）。
同理，运行过产物后应确保进程完全退出再打包。

### ⚠️ 输出目录被僵尸句柄锁住时，只有重启能救

症状：清理旧的打包产物时，目录里**只剩一个 `resources/app.asar` 删不掉**，
报 `ERROR_SHARING_VIOLATION(32)`；进一步连整个目录都改不了名，报 `ERROR_ACCESS_DENIED(5)`。
`tasklist` 里又找不到任何 electron/adb 进程 —— 那是**已退出进程泄漏的内核句柄**（见
「环境备注」里的"僵尸进程"），任何用户态手段都释放不了，**必须重启系统**。

| 手段 | 结果 |
|---|---|
| `shutil.rmtree` / `os.remove` | 被 safe-delete hook 拦，转回收站后失败（`SAFE_DELETE_FAIL_CLOSED`） |
| `cmd /c rd /s /q` | 大文件能删，`app.asar` 仍报拒绝访问 |
| `robocopy <空目录> <目标> /MIR` | **最有效**，能清掉绝大多数文件 |
| `MoveFileW`（Win32） | 同样失败，目录整体被锁 |
| 重启系统 | ✅ 唯一可靠的回收方式 |

**打包时的应对**：不要硬删，用 `--out` 换个输出目录即可（见「打包」章节）：

```bash
python scripts/build.py --out out-v1.1
ADB_OUT_DIR=out-v1.1 node scripts/e2e-packaged.cjs
```

### ⚠️ 绝对不要关闭 `signAndEditExecutable`

`electron.exe` 是**双模式二进制**。它读取**自身 PE 版本资源**里的
`ProductName` / `OriginalFilename` 字段来判断"我是 Electron 运行时"还是"我是打包后的应用"。

- 正常打包：electron-builder 用 `rcedit` 把 `ProductName` 改写成应用名 → exe 进入**应用模式**
- 若设 `"signAndEditExecutable": false`：改写被跳过，版本资源仍是
  `ProductName = "Electron"` / `OriginalFilename = "electron.exe"` → exe 退回**裸 Node 模式**

返回值（实测）：

| 命令 | 正常应用模式 | 裸 Node 模式（错误） |
| --- | --- | --- |
| `App.exe --version` | 无输出/应用版本 | `v20.18.3`（Node 版本） |
| `App.exe --help` | 启动应用 | Node 的 `Usage: node [options]...` |
| `App.exe --remote-debugging-port=9333` | 正常启动并开调试端口 | `bad option: --remote-debugging-port=9333`，**退出码 9** |
| `App.exe`（无参数） | 正常显示窗口 | **静默退出，退出码 0** |

**最坑的地方**：裸 Node 模式下无参数启动会**退出码 0 静默退出**，
看起来像"启动成功然后正常关闭"，极易误判为打包没问题。
这一条同时解释了 portable 版"退出码 9"的假象——那其实也是这个原因。

**校验手段**（`npm run inspect:pe`）：

```bash
python scripts/pe-version.py "dist-pkg/win-unpacked/ADB桌面助手.exe"
```

必须看到 `ProductName` = 你的应用名。若显示 `Electron` / `electron.exe`，就是没改写成功。

> 当初加 `signAndEditExecutable: false` 是为了绕过 `winCodeSign` 解压失败
> （包内含 macOS 符号链接，Windows 无权限创建）。但实际上 `rcedit-x64.exe`
> 已经成功解压到缓存目录，改写资源这步**本就可以正常工作**。
> 正确做法是保留该选项默认值 `true`，只关掉代码签名（`forceCodeSigning: false`）。

> **中文路径提醒（已实测排除）**：portable 版会把自身解压到 `%TEMP%` 下以产品名命名的目录。
> 曾怀疑产品名含中文（「ADB桌面助手」）会导致自解压失败，**实测证伪**：
> Stage 3 验收显示 83.71 MB 的 portable 包在 3 秒内完成自解压，
> 页面正常从 `%TEMP%\...\resources\app.asar\dist\index.html` 加载。
> 历史上观察到的 portable「退出码 9」真因是 `ELECTRON_RUN_AS_NODE` + 未改写 PE 资源，
> 与中文无关。

---

## 开发踩坑记录

这些是在真实设备（OPPO CPH1931 / Android 10）上验证出来的，改动前请先读一遍。

### scrcpy 3.1 参数差异
`--no-video-buffer` 和 `--window-icon` **不是 scrcpy 3.1 的合法参数**，传了会导致
`scrcpy.exe` 立刻以 exit 1 退出（报 `unknown option`）。
无窗口后台录制用的是 `--no-playback`，不是 `--no-display`（后者也不存在）。
排查手法：`bin/scrcpy.exe --help` 对一遍参数表。

### scrcpy 需要注入 ADB 环境变量
系统里若装了 ADB 且路径失效，scrcpy 会报 `ERROR: Command not found`。
`spawnBinary()` 里统一注入了 `env: { ...process.env, ADB: adbPath() }`，
确保始终用随包的 adb。**新增 spawn scrcpy 的地方都要走 `spawnBinary`。**

> 实测案例：某机器上 `ADB` 环境变量被设成 `D:\AdbSDk\...\platform-tools;`
> （带尾分号的**目录**，不是 exe），scrcpy 3.1 读它当可执行文件 →
> `CreateProcessW() error 2` → `Could not start adb server` → **秒退**。
> 非 debug 级别下 scrcpy 不打印这些错，主进程只看到进程起来又死了。

### ⚠️ spawn GUI 程序绝对不能加 `windowsHide: true`
这是本项目最隐蔽的一个坑，症状极具欺骗性：**进程存活、日志显示渲染成功、
窗口对象也创建了（有 HWND、尺寸位置都对），但屏幕上和任务栏里都看不到。**

原因：`windowsHide: true` 会在子进程 `STARTUPINFO` 里设置
`STARTF_USESHOWWINDOW` + `SW_HIDE`，这个"默认隐藏窗口"首选项会被
scrcpy(SDL2) 继承，导致它创建窗口后调 `ShowWindow` 无效 ——
`IsWindowVisible()` 恒为 false。

`windowsHide` **只适用于不想弹控制台的 CLI 程序**（见 `runBinary()` 里的用法）；
GUI 程序必须让它自己决定窗口可见性。

实测对照（同一 Electron 进程内，顺序反过来复测过）：

| `windowsHide` | 结果 |
|---|---|
| `false` | 3 秒内窗口可见 ✓ |
| `true` | 15 秒以上始终不可见 ✗ |

排障工具：`python scripts/enum-windows2.py`（`ENUM_ALL=1` 含不可见窗口）。
⚠️ **别用 `Get-Process \| Where MainWindowHandle -ne 0`** —— 它拿不到 SDL2 窗口，
会得出错误的"无窗口"结论。

### ⚠️ 投屏窗口图标会被 `bin/icon.png` 顶掉

症状：任务栏里「ADB 桌面助手」主窗口和 scrcpy 投屏窗口**图标完全一样**，分不清谁是谁。

真因：scrcpy 找窗口图标的顺序是
1. 环境变量 `SCRCPY_ICON_PATH`
2. **exe 同目录的 `icon.png`**（portable 模式）
3. 编译期内置图标

我们随包的 `resources/bin/` 里放了应用图标 `bin/icon.png`，而 `scrcpy.exe` 也在这个
目录下，于是它顺手把我们的应用图标当成了自己的窗口图标。debug 日志实锤：
`DEBUG: Using icon (portable): ...\resources\bin\icon.png`

修复：单独放一份 scrcpy 原版图标 `bin/scrcpy-icon.png`（从 `scrcpy.exe` 的
`RT_GROUP_ICON` 资源提取，见 `scripts/extract-scrcpy-icon.py`），启动时注入
`SCRCPY_ICON_PATH`。日志变成
`DEBUG: Using SCRCPY_ICON_PATH: ...\resources\bin\scrcpy-icon.png`。

> 曾先尝试用 Win32 `SetClassLongPtrW(GCLP_HICON)` 硬改窗体图标（需要 koffi FFI
> 依赖），后发现 scrcpy 原生支持 `SCRCPY_ICON_PATH`，遂整体废弃该方案、移除依赖。
> koffi 3.x 的 API 与 2.x 不兼容，且**回调内调 `koffi.decode` 会段错误**；
> 若将来仍需 FFI，细节见 `docs/test-mirror-icon.txt`。

### ⚠️ QtScrcpy 与 scrcpy 同名，别用 `taskkill /IM`

用户机器上很可能同时装着 QtScrcpy，它的进程名也叫 `scrcpy.exe`。
`taskkill /IM scrcpy.exe` 以及 PowerShell 的 `-like '*scrcpy.exe'` 都会**误杀**它。

一律用**完整路径结尾**精确匹配：`\resources\bin\scrcpy.exe`。
现成工具：`python scripts/find-scrcpy-pid.py`。

### ctypes 枚举窗口的回调签名

`ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)` 在 64 位下宽度不对，
会让枚举结果**恒为空**，从而误判成"没有窗口"。正确写法：

```python
ctypes.WINFUNCTYPE(ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p)
```

### 投屏状态竞态
启动投屏时必须**先登记 `current` 句柄，再挂 `close`/`error` 回调**。
顺序反了的话，进程若快速退出，回调会在赋值前触发，导致状态错乱
（表现为 `getMirrorStatus()` 返回 `running:false` / `pid=undefined`）。

### adb 1.0.41 会截断中文长文件名
`adb push` 一个长中文名文件，设备端落地名会被截成两半
（`e2e-roundtrip.txt` → `e2e-roundtr` + 另一个碎片）。这是 adb 自身行为，非本程序 bug。
`files.ts` 的规避方案是：**先推送纯 ASCII 临时名，再用设备端 `mv` 改回真实名**。

### screenrecord 不一定存在
部分厂商 ROM（实测 OPPO Android 10）精简掉了 `/system/bin/screenrecord`。
`startRecord()` 会先 `which screenrecord` 探测，不可用则自动回退到
scrcpy 录制通道（`startScrcpyRecord`）。

### 空字符串会顶掉默认目录
`settings.json` 里若残留 `screenshotDir: ""`，旧写法 `{...defaults, ...stored}`
会让空串覆盖掉默认目录，导致 `mkdir ''` 报 ENOENT。
现在 `getSettings()` 过滤空串，并提供 `resolveDir('screenshot'|'record'|'pull')` 兜底。

### 依赖安装（国内网络）
`npm` 官方源不可达时改用 `registry.npmmirror.com`（已写入 `.npmrc`）。
镜像偶发**文件截断**（下载的包缺文件、目录为空），表现为运行时 `Cannot find module './lib/xxx'`。
排查用 `python scripts/check-modules.py`，修复办法是删掉该包目录后单独重装。

### ⚠️ 新增推送通道必须同步 preload 白名单

`preload.ts` 的 `on()` 有一个 `allowed` 白名单，只放行白名单内的通道。
**新加任何主进程 → 渲染进程的推送通道，都要把它加进 `allowed`，否则渲染层静默收不到任何消息**
（不报错、不警告，只是永远不触发回调）。

同时 `preload.ts` 里的 IPC 通道常量是**内联字面量**，不 import `shared/types.ts`
（编译后相对路径失效）。所以**改通道名要改两处**：`shared/types.ts` 和 `preload.ts`。
忘了同步的典型症状是"主进程日志显示推了，界面纹丝不动"。

### ⚠️ ColorOS 精简 ROM 没有 `ip` 命令

`probeDevice()` 原实现用 `ip -o link show` 拿网络接口列表，在 OPPO ColorOS（实测 CPH1931 /
Android 10）上直接返回空 —— ROM 精简掉了 `ip`。现象是弱网页面的「网络接口」下拉框空白。

兜底方案：再并发跑一条 `cat /proc/net/dev`，用 `parseProcNetDev()` 解析
（格式 `iface: rx_bytes rx_packets … tx_bytes …`），并过滤掉 `lo` / `ifb*`
（后者是我们自己建的虚拟网卡，不该给用户选）。优先用 `ip` 的结果，为空才退到 `/proc/net/dev`。

同理 `hasTc` / `hasIfb` 也不能只靠 `which`：`which` 在部分 toybox 环境返回非零但工具其实可用。
现在是**实际执行探测** —— 跑一次 `tc qdisc show` 看输出/报错里有没有 `qdisc|netem|RTNETLINK`；
ifb 则在有 Root 时直接 `modprobe ifb numifbs=1 && echo IFB_OK` 验证。

### 侧栏高亮"滞后一页"是测试假象

写 UI 校验脚本时若直接改 `window.location.hash` 跳页，会绕过 React Router 的更新时序，
截图里出现"页面已经是弱网，侧栏高亮还停在 Logcat"。这不是 router 的 bug。
正确做法是用 `loadFile(file, { hash })` 逐页重新加载，见 `scripts/check-nav.cjs`。

---

## 环境要求

- 开发：Node.js ≥ 18
- 使用：Windows 10/11 x64
- 设备：Android，需开启「开发者选项」与「USB 调试」

## 自测

```bash
# 环境自检 + IPC 冒烟（不依赖真实设备）
node_modules/electron/dist/electron.exe scripts/smoke.cjs

# 真机功能实测（需连接设备）
node_modules/electron/dist/electron.exe scripts/e2e.cjs
node_modules/electron/dist/electron.exe scripts/e2e-record.cjs

# 抓取各页面 UI 截图到 ui-shots/
node_modules/electron/dist/electron.exe scripts/capture-ui.cjs

# ---- v1.0 新增 ----

# 静态产物检查（纯 Node，不启动 electron，7 项）
node scripts/e2e-v1-smoke.cjs

# 三个新页面截图 + 标题/侧栏/卡片/api 校验（3 项）
node_modules/electron/dist/electron.exe scripts/capture-v1-pages.cjs

# 9 条路由逐个加载，校验标题与侧栏高亮（9 项）
node_modules/electron/dist/electron.exe scripts/check-nav.cjs

# 真机只读功能验证：应用列表/详情、弱网探测、预设读写、进程、logcat（8 项）
node_modules/electron/dist/electron.exe scripts/e2e-v1-device.cjs

# 检查 node_modules 是否被镜像截断
python scripts/check-modules.py

# 按完整路径定位我们的 scrcpy（排除 QtScrcpy）
python scripts/find-scrcpy-pid.py

# 验证 scrcpy 图标环境变量（独立起一个 scrcpy 读它的环境块）
python scripts/verify-scrcpy-env.py
```

> Windows 下跑 electron 脚本前需先 `unset ELECTRON_RUN_AS_NODE`，
> 否则 electron 会以 Node 模式启动。
>
> `scripts/e2e-v1-smoke.cjs` 是**纯 Node** 脚本（只读编译产物做静态检查），
> 必须用 `node` 跑，**不能**用 `electron.exe` 跑 —— 见下方 ELECTRON_RUN_AS_NODE 陷阱。
>
> 现成包装器：`scripts/run-capture-v1.bat`（清变量后启动截图脚本）。
> 这些脚本里 `spawn` electron 之前都做了 `delete env.ELECTRON_RUN_AS_NODE`。

## 打包产物验收

上面那套脚本跑的是**开发环境**，验证不了交付物。打包完成后必须再跑一遍生产包验收——
它直接启动 `out-v1/win-unpacked/ADB桌面助手.exe`，用 CDP 远程调试驱动真实生产进程。

```bash
node scripts/e2e-packaged.cjs            # Stage 1：启动与骨架（12 项）
node scripts/e2e-packaged-features.cjs   # Stage 2：核心功能实测（9 项，需真机）
node scripts/e2e-packaged-portable.cjs   # Stage 3：portable 便携版（7 项）
node scripts/e2e-installed.cjs           # Stage 4：NSIS 安装版（13 项，需先装一次）
node scripts/e2e-mirror-installed.cjs    # Stage 5：安装版投屏端到端（12 项，需真机）
node scripts/e2e-mirror-icon.cjs         # Stage 6：投屏窗口图标区分（14 项，需真机）

# 产物目录不是默认的 out-v1 时，用 ADB_OUT_DIR 指定
ADB_OUT_DIR=out-v1.1 node scripts/e2e-packaged.cjs
```

> 跑之前先 `unset ELECTRON_RUN_AS_NODE`（脚本内部也会 delete，但父子都干净更稳）。
> Stage 1/2/3 可直接用 `node` 跑；Stage 5/6 需要真机。

| 阶段 | 结果 | 覆盖内容 |
|---|---|---|
| Stage 1 | **12/12** | 产物存在、随包二进制齐全、进程启动、asar 加载、React 挂载、preload 34 方法、设备枚举、环境自检、6 路由渲染、日志落地、正常退出 |
| Stage 2 | **9/9** | 分辨率 `720x1600/320dpi`、截图落地合法 PNG、`shell getprop` 返回机型、投屏启停、日志、设置持久化 |
| Stage 3 | **7/7** | portable 自解压 → `%TEMP%` 目录加载页面 → React 挂载 → 环境自检 |
| Stage 4 | **13/13** | 安装目录/主程序/卸载器落地、resources/bin 12 文件、从安装目录启动、页面从安装路径加载、设备枚举、真实功能实测、正常退出 |
| Stage 5 | **12/12** | 走真实界面路径点「启动投屏」→ 接口 running、窗口对象创建、**窗口真实可见** |
| Stage 6 | **14/14** | 两个图标文件内容不同、投屏窗口 `SDL_app` 真实可见、**读 scrcpy 进程环境块确认 `SCRCPY_ICON_PATH` 指向 `scrcpy-icon.png`** |

结果归档在 `docs/test-packaged-stage{1,2,3,4}.txt` 与 `docs/test-mirror-icon.txt`。

> **Stage 6 的判据设计**：不靠 UI 状态、不靠时序，直接读 scrcpy 子进程的 **PEB 环境块**
> （`NtQueryInformationProcess` + `ReadProcessMemory`，见 `scripts/verify-scrcpy-env.py`），
> 确认 `SCRCPY_ICON_PATH` 真的传进去了。窗口可见性只是辅助判据 —— 图标生效与否
> 归根到底是"环境变量到没到"，读环境块才是充分证据。

> Stage 4 需要先真实安装一次。NSIS 静默安装的正确姿势：
> 从 **cmd** 调用 `Setup.exe /S /D=<绝对路径>`，`/D=` 必须是最后一个参数、路径不能加引号。
> 从 bash/PowerShell 直接传参会因反斜杠转义和字符编码导致路径畸变，务必写成 `.bat` 再用 `cmd /c` 执行。

> **Stage 5 的设计要点**：必须**走真实用户路径**（切投屏页 → 找按钮 → `element.click()`），
> 不能直接调 `window.adbApi.startMirror()`。绕开界面的测试会漏掉
> `windowsHide` 这类只在真实调用链上暴露的问题（详见「开发踩坑记录」）。
> 判据必须是 **`IsWindowVisible === true`**，而不是"进程存活"或"接口返回 running"。

### 生产包验收必读

**1. 必须清掉 `ELECTRON_RUN_AS_NODE`**

该变量为 `1` 时，任何 Electron 二进制都会被强制以纯 Node 模式运行。症状极具误导性：

| 现象 | 实际含义 |
|---|---|
| `ADB桌面助手.exe --version` → `v20.18.3` | 跑的是 Electron 内置 Node，不是应用 |
| `--remote-debugging-port=9333` → `bad option` | Node 不认这个参数 |
| 无参数启动 → 静默退出，退出码 0 | Node 无脚本可执行，正常结束 |
| portable 启动 → 退出码 9 | 自解压后被 Node 模式吞掉 |

所有验收脚本都在 spawn 前 `delete env.ELECTRON_RUN_AS_NODE`。**新增启动生产 exe 的脚本都要照做。**

**2. CDP 端点就绪 ≠ 首屏渲染完成**

`/json/list` 能拿到 page target，只说明渲染进程活了。React 挂载（异步路由 + 首屏数据）
可能还要数百毫秒到数秒，portable 因自解压更慢。**一次性求值会产生假失败**
（曾误报 `React 已挂载 :: root 子节点 0`）。正确做法是轮询 `#root.children.length > 0`，
脚本里统一用 30 次 × 400ms。

**3. 启动时 `cwd` 不能指向 `win-unpacked`**

进程会持有该目录句柄，导致后续打包时 electron-builder 无法删除/重建。统一用 `os.tmpdir()`。

**4. 输出目录被锁**

历史遗留的 `dist-release` / `dist-pkg` / `build-output` / `release` 目录可能因句柄残留无法删除。
打包时用 `--config.directories.output=<新目录名>` 绕开，别硬删。

## 版本规划

- **v0.9**：设备管理、投屏、截图/录屏、分辨率、Monkey、APK 安装、
  文件传输、命令终端、日志导出
- **v1.0（当前）**：
  - 实时 logcat（流式抓取、级别/tag/关键字/进程过滤、一键保存）
  - 应用管理（列表、详情、卸载、强制停止、清数据、启动、提取 APK、启用停用）
  - 弱网模拟（clumsy 风格，上行/下行独立 7 参数，预设持久化，能力探测）
  - 验收：静态 7/7、页面 3/3、导航 9/9、真机 8/8 —— 见 `docs/test-v1.txt`
- **v1.0+（候选）**：相册浏览、双向剪贴板、拖放安装、连点器
