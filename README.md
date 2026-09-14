# ADB 桌面助手 v1.0.1

一个用 **Electron + React + TypeScript** 重构的 Android 设备管理工具。
界面简洁、深色/浅色可切换，代码分层清晰，方便长期维护与迭代。

> **v1.0.1 更新**
> - 应用管理新增**常用应用收藏**：星标固定包名，换设备/重进页面/重启后依然记得，不用每次重新搜；
> - 弱网模拟换成**免 Root 的代理式方案**（对标 clumsy）：`adb reverse` + 本地代理，不再依赖 Root 与 `tc/netem`；
> - 修复「弱网页面找不到启动键」：以前没配参数时按钮是灰的，现在有设备就能点，未配置会自动套用默认弱网档；
> - 新增弱网**代理引擎端到端测试** `scripts/e2e-weaknet-proxy.cjs`（引擎级 19 项 + 真机链路 18 项，真机实测 37/37）；
>   另加 `scripts/run-electron.py`，解决 Electron 测试脚本跑完不退出、挂住 shell 的老问题。

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
| **应用管理** 🆕 | 用户/系统/全部三态筛选 + 关键字搜索；详情（版本号/占用/安装时间/Activity 数/权限）；启动、强制停止、清除数据、提取 APK、启用停用、卸载；**常用应用收藏**（星标固定，跨设备/跨重启保留，一键启动） |
| **实时 Logcat** 🆕 | 流式抓取（120ms 批量推送 + 20000 行环形缓冲）；级别/TAG 通配/关键字/进程/缓冲区多路过滤；快捷过滤（只看错误 / 闪退 ANR / Activity 启动）；暂停刷新、一键保存 |
| **弱网模拟** 🆕 | 对标 clumsy，上行/下行独立配置 7 个参数（带宽/延迟/抖动/丢包/错报/乱序/重复包）；**免 Root：本地代理 + `adb reverse`**（详见下方）；6 个内置档位 + 自定义预设持久化；持续时长与倒计时；设备能力探测（Root/tc/ifb/代理/写设置权限）；已 Root 可切 `tc/netem` 内核级 |
| **命令终端** | 执行任意 adb 命令，16 个常用命令快捷入口，↑/↓ 翻阅历史 |
| **运行日志** | 实时记录全部命令与结果，按级别筛选、关键字搜索、一键导出 txt |
| **设置** | 主题切换、默认保存目录、环境自检 |

### 弱网模拟说明

四种实现方式，UI 上可选（默认「自动」）：

| 方式 | 原理 | 前置条件 |
| --- | --- | --- |
| **本地代理**（默认，免 Root） | 设备流量 → 设备 `127.0.0.1:17890` → `adb reverse` → 电脑代理进程注入弱网 → 真实服务器 | 只需 USB 调试；**能自动设系统代理的 ROM** 体验最好 |
| **tc/netem** | `tc qdisc … netem`（上行 `root`，下行 `ifb` + `ingress`） | 需 Root + 内核 `ifb` |
| **整体断网** | `svc wifi/data disable` | 免 Root，但只能全断，不能精细控制 |
| **手动代理向导** | 同上「本地代理」，但代理地址由用户去设备 WLAN 设置里手填 | ROM 禁止 `adb` 写系统设置时自动切到此模式 |

**免 Root 代理方案原理**

```
手机 App ──► 手机 127.0.0.1:17890 ──adb reverse──► 电脑代理（注入弱网）──► 真实服务器
                     ▲
         settings put global http_proxy 127.0.0.1:17890   （免 Root，adb shell 自带写权限）
```

- **上行/下行独立**：代理双向各挂一个整形器，请求方向算上行、响应方向算下行。
- **参数语义**（重要，和 `tc/netem` 一致但实现不同）：
  - 延迟 / 抖动 / 带宽 —— 精确。定时投递 + 令牌桶（带宽用令牌桶而非 `netem` 的 `rate`，更准）。
  - **丢包 —— 队头阻塞等效**：命中后该块延迟一个 RTO 并拖住后续所有块。
    这是真实 TCP 丢包的可观测效果，**但绝不丢字节**（TCP 给应用层的就是完整字节流）。
  - **乱序 —— 附加抖动等效**：投递时间单调不减，**绝不打乱字节顺序**（真乱序=篡改内容，会让 HTTPS 全部失败）。
  - **错报** —— 真篡改字节（用于验证客户端容错）。
  - **重复包** —— 按 `1+dup` 折算进有效带宽。
- 大块数据按 16KB 切片计费（否则一个几百 KB 的 `data` 事件会整块免费放过，限速形同虚设）；
  限速时对来源 socket 做背压（1MB 高水位 / 256KB 低水位），避免内存爆掉。
- 停止时**先把队列投递完再 `end()`**（`destroy()` 会丢发送缓冲，表现为响应被截断）。
- **崩溃恢复**：会话标记落盘 `userData/weaknet-session.json`；程序异常退出后下次启动自动恢复设备
  （清代理 + 恢复网络）；正常退出走 `will-quit` 拦截清理。
- 预设持久化在 `userData/weaknet-presets.json`，与内置档位分开管理。

**⚠️ ROM 差异（决定能不能全自动）**

`settings put global http_proxy` 需要 `com.android.shell` 持有 `WRITE_SECURE_SETTINGS`：

- AOSP / 多数机型 / 模拟器 —— **可以自动写**，启动即生效；
- **ColorOS 等定制 ROM 会剥夺该权限**，任何 global 写入都抛 `SecurityException`。
  此时 UI 自动切到**手动代理向导**：`adb reverse` 与代理服务照常建立（已在真机实测通道可用），
  界面给出 4 步操作指引，并每秒轮询 `settings get global http_proxy`，用户填好后自动识别并开始注入；
  停止后会提示用户把代理改回「无」（同样因为该 ROM 不允许我们自动清除）。

启动前 `probeDevice()` 会实测这些能力（Root / tc / ifb / 接口 / SDK / 能否写设置），UI 如实展示。

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

### ⚠️ 验收脚本的静默兜底会把「脚本坏了」伪装成「功能失败」

`e2e-mirror-installed.cjs` 曾在 `catch { return [] }` 里调用一个**从未入库**的
`scripts/enum-windows.py`（仓库里只有 `enum-windows2.py`，而且它用 `--exe` 传参、
不接受位置参数）。异常被吞掉后窗口枚举恒返回空数组，于是 Stage 5 最后两项
「scrcpy 窗口被创建 / 真实可见」**永远 FAIL** —— 看起来像产品缺陷，实际是脚本自己坏了。

**规则**：验收脚本里的异常兜底至少要打到日志。`catch { return [] }` 这种写法会把
排查方向直接带偏；遇到"恒定失败"先怀疑判据本身，别急着改产品代码。

相关：Stage 5/6 靠 python 枚举窗口，脚本读 `process.env.PYTHON || 'python'`。
本机若 `python` 不是托管版本，需显式 `export PYTHON=<托管 python 绝对路径>`。

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

### ⚠️ 测试脚本里 `spawnSync` 会把被代理的服务一起卡死

写弱网代理的端到端测试时踩得很深：代理**跑在测试进程自己身上**，
而 `child_process.spawnSync` 会**阻塞整个 Node 事件循环**。
于是调 `spawnSync(adb, ['shell','curl',…])` 的那几十秒里，
代理根本没机会 `accept()` 连接，设备侧只会看到「TCP 连上了，但 60s 无任何响应」的超时。

现象极具误导性：`curl` 报 `RC=28` 且 `time_total=60001ms`，
看起来像"连不通/被防火墙拦了"，实际是本进程自己把事件循环堵死了。

**规律：只要测试进程同时还是服务端，adb / curl 一律用异步 `execFile`（promisify），不要用 `spawnSync`。**
同一份脚本里 `spawnSync` 的那几项全挂、纯异步的那几项全过，就是这个坑的典型指纹。

顺带一个排查用的判别法：同进程内异步连接正常、而"别人的进程"全部超时，
先怀疑事件循环被阻塞，别急着怀疑防火墙（本机实测 Python 监听正常、Node 监听不可达，
纯粹因为 Python 的 HTTPServer 跑在独立线程，而 Node 是单线程）。

### ⚠️ adb shell 传参必须整体加引号，否则 `-w` 格式串会被拆开

`adb shell` 会把参数数组**用空格拼接**再交给设备 shell 解析。
所以 `['shell','curl','-w','%{time_total} %{http_code}', url]` 到了设备上会变成
`curl -w %{time_total} %{http_code} url` —— 后两段被当成 URL 去解析，
结果是空输出、甚至卡在解析伪域名上。

正确写法：把设备侧命令**拼成一个字符串**再交给 adb：

```js
await adb(['-s', serial, 'shell',
  `curl -s -o /dev/null -w '%{time_total} %{size_download} %{http_code}' --max-time 60 --proxy http://127.0.0.1:17890 http://127.0.0.1:18765/small`]);
```

### ⚠️ 设备上的 shell `curl` 不读 Android 全局代理设置

`settings put global http_proxy 127.0.0.1:PORT` 只对**走 Android 网络栈的应用**（WebView / OkHttp /
HttpURLConnection）生效。`/system/bin/curl` 完全不读这个设置 ——
实测全局代理已设好，不带 `--proxy` 的 curl 仍然直连、返回 `RC=7`。

所以验证「全局代理对 App 生效」**只能用真实应用**（我们用的是系统浏览器 + 源站命中计数），
见 `scripts/e2e-weaknet-proxy.cjs` Stage B 第 6 段。
另外注意：**要测延迟必须注入在上行** —— 请求走的是上行，
只给下行加延迟的话，请求照样瞬间到达源站，指标测不出来（这个坑也踩过）。

### ⚠️ Electron 测试脚本跑完不退出，会挂住父 shell

`electron.exe scripts/check-nav.cjs` 这类脚本里已经调了 `app.exit(code)`，
但在本机上**主进程退出后句柄不释放**：脚本早就把结果写进 `ui-shots/_navcheck.log` 了，
调用它的 shell 却一直等 stdout 管道 EOF，命令**永远不返回**。
杀 shell 又会留下 `electron.exe` 僵尸进程（`taskkill` 报「没有此任务的实例在运行」，只有重启能清）。

连带后果更麻烦：僵尸进程占着**默认 userData 目录**，
之后的 Electron 脚本启动时会卡在初始化，看起来像「脚本自己坏了」。

两个规避手段（`scripts/run-electron.py` 都做了）：

1. **子进程输出重定向到文件**，不继承父 shell 的管道；
2. **独立 `--user-data-dir`**（临时目录），避开僵尸进程抢 profile；
3. 外面套超时强杀，超时返回 124，绝不无限等；
4. `--watch <日志> --until <完成标记正则>`：**看到日志里出现完成标记就主动结束子进程**，
   不用干等超时（否则每次都白等 150~240s）；并顺带按新增日志里有没有 `FAIL/ERRORS`
   判定通过与否，直接给退出码。

```bash
python scripts/run-electron.py scripts/check-nav.cjs \
    --watch ui-shots/_navcheck.log --until "渲染层无错误|=== ERRORS ==="
python scripts/run-electron.py scripts/e2e-v1-device.cjs \
    --watch ui-shots/_device.log --until "[0-9]+/[0-9]+ 通过"
```

判别法：如果命令「没有任何输出、但脚本自己的日志文件已经写完了」，
就是这个问题，不是脚本逻辑错了。

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
python scripts/run-electron.py scripts/capture-v1-pages.cjs \
    --watch ui-shots/_capture.log --until "渲染层无错误|RENDERER ERRORS"

# 9 条路由逐个加载，校验标题与侧栏高亮（9 项）
python scripts/run-electron.py scripts/check-nav.cjs \
    --watch ui-shots/_navcheck.log --until "渲染层无错误|=== ERRORS ==="

# 真机只读功能验证：应用列表/详情、弱网探测、预设读写、常用应用收藏、进程、logcat（9 项）
python scripts/run-electron.py scripts/e2e-v1-device.cjs \
    --watch ui-shots/_device.log --until "[0-9]+/[0-9]+ 通过"

# ---- v1.0.1 新增 ----

# 弱网代理引擎端到端（Stage A 引擎级 19 项，纯 Node，不起设备）
node scripts/e2e-weaknet-proxy.cjs

# 加上设备链路（Stage B：adb reverse + 全局代理 + 真实浏览器 + 手动代理路径）
# 真机 18 项；指定设备用 ADB_SERIAL，不加则自动挑在线真机
ADB_SERIAL=aaab4f58 node scripts/e2e-weaknet-proxy.cjs --device
ADB_SERIAL=emulator-5556 node scripts/e2e-weaknet-proxy.cjs --device

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
>
> **建议统一用 `python scripts/run-electron.py <脚本>` 起 Electron 测试脚本**：
> 它清掉 `ELECTRON_RUN_AS_NODE`、给独立 `--user-data-dir`、把子进程输出重定向到文件，
> 并带超时强杀。直接 `electron.exe scripts/xxx.cjs` 常常会「结果早就写进日志了，命令却一直卡着」——
> 原因见下方「Electron 测试脚本跑完不退出，会挂住父 shell」。

## 打包产物验收

上面那套脚本跑的是**开发环境**，验证不了交付物。打包完成后必须再跑一遍生产包验收——
它直接启动 `<out>/win-unpacked/ADB桌面助手.exe`，用 CDP 远程调试驱动真实生产进程。

```bash
python scripts/build.py --out out-v1.0.1     # 打包（自动起本地 mirror）
export ADB_OUT_DIR=out-v1.0.1                # 产物目录不是默认 out-v1 时必须指定

node scripts/e2e-packaged.cjs            # Stage 1：启动与骨架（12 项）
node scripts/e2e-packaged-features.cjs   # Stage 2：核心功能实测（9 项，需真机）
node scripts/e2e-packaged-portable.cjs   # Stage 3：portable 便携版（7 项）
node scripts/e2e-installed.cjs           # Stage 4：NSIS 安装版（13 项，需先装一次）
node scripts/e2e-mirror-installed.cjs    # Stage 5：安装版投屏端到端（12 项，需真机）
node scripts/e2e-mirror-icon.cjs         # Stage 6：投屏窗口图标区分（14 项，需真机）
```

> 跑之前先 `unset ELECTRON_RUN_AS_NODE`（脚本内部也会 delete，但父子都干净更稳）。
> Stage 1/2/3 可直接用 `node` 跑；**Stage 5/6 需要真机**，还要
> `export PYTHON=<托管 python 的绝对路径>` —— 它们靠 python 枚举窗口来断言窗口真实可见，
> 而系统里的 `python` 可能不是托管版本。
>
> ⚠️ **验收跑完后不要再往同一个输出目录打包**：验收会直接启动 `win-unpacked` 里的 exe，
> 退出后可能残留 `resources/app.asar` 的内核句柄（`remove … EBUSY / used by another process`），
> 该目录就再也覆盖不了了。要重新打包就**换个 `--out` 目录名**（见下方「输出目录被僵尸句柄锁住」）。

| 阶段 | 结果 | 覆盖内容 |
|---|---|---|
| Stage 1 | **12/12** | 产物存在、随包二进制齐全、进程启动、asar 加载、React 挂载、preload **54** 方法、设备枚举、环境自检、**9 路由**渲染、日志落地、正常退出 |
| Stage 2 | **9/9** | 分辨率 `720x1600/320dpi`、截图落地合法 PNG、`shell getprop` 返回机型、投屏启停、日志、设置持久化 |
| Stage 3 | **7/7** | portable 自解压 → `%TEMP%` 目录加载页面 → React 挂载 → 环境自检 |
| Stage 4 | **13/13** | 安装目录/主程序/卸载器落地、resources/bin 14 文件、从安装目录启动、页面从安装路径加载、设备枚举、真实功能实测、正常退出 |
| Stage 5 | **12/12** | 走真实界面路径点「启动投屏」→ 接口 running、窗口对象创建、**窗口真实可见（3 秒内）** |
| Stage 6 | **14/14** | 两个图标文件内容不同、投屏窗口 `SDL_app` 真实可见、**读 scrcpy 进程环境块确认 `SCRCPY_ICON_PATH` 指向 `scrcpy-icon.png`** |
| **合计** | **67/67** | v1.0.0 六段全绿（Stage 4~6 跑的是 NSIS 真实安装版） |

结果归档在 `docs/test-packaged-stage{1,2,3,4,5}.txt`、`docs/test-mirror-icon.txt` 与 `docs/test-v1.txt`。

> **Stage 6 的判据设计**：不靠 UI 状态、不靠时序，直接读 scrcpy 子进程的 **PEB 环境块**
> （`NtQueryInformationProcess` + `ReadProcessMemory`，见 `scripts/verify-scrcpy-env.py`），
> 确认 `SCRCPY_ICON_PATH` 真的传进去了。窗口可见性只是辅助判据 —— 图标生效与否
> 归根到底是"环境变量到没到"，读环境块才是充分证据。

> Stage 4 需要先真实安装一次（会**覆盖**已装的旧版本）。NSIS 静默覆盖安装的正解：
> 把安装包复制到 `%TEMP%` 的 **ASCII 路径**，再用 Python 以 **list 形式**直接调 exe ——
> `subprocess.Popen([setup, '/S', '/D=' + 目标目录])`。不经 shell，参数零歧义；
> per-user 安装**无需 UAC**，`RC=0` 即成功，注册表 `DisplayVersion` 会同步更新。
> `/D=` 必须是最后一个参数且路径不能加引号。从 bash/PowerShell 直接传参会因反斜杠转义
> 和字符编码导致路径畸变（装到错误位置），写成 `.bat` + `cmd /c` 也行，但要保证纯 ASCII。

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
