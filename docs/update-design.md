# 增量更新方案（v1.0.7 / develop 分支）

> 目标：小更新不再重装 84 MB 安装包；应用内一键完成，重启即新版本。
> 状态：设计定稿，待实现。所有关键机制均已本机实测，来源标注在「依据」列。

---

## 0. 一句话结论

| | 体积 | 用户操作 |
|---|---|---|
| 现在（全量） | **84.1 MB** 安装包 | 下载 → 双击 → 下一步 → 选择安装目录 → 安装 → 手动启动 |
| 安装版增量 | **156 KB** zip（asar 541 KB 压缩后） | 应用内选文件 → 点「立即更新并重启」→ 自动重启成新版 |
| 便携版增量 | 整包替换（新 portable exe，约 84 MB） | 应用内选文件 → 点「立即更新并重启」→ 自动换 exe 并重启 |

安装版增量是**体积的 1/540**，这是本方案的核心收益。

---

## 1. 已实测的事实（决定了设计形态）

| # | 事实 | 依据 |
|---|---|---|
| 1 | 应用运行时 `resources/app.asar` **被独占锁定**，`os.replace` 报 WinError 5、`rename` 报 WinError 32 | 本机探针 `_probe-hotswap.py` |
| 2 | 应用运行时 `resources/bin/adb.exe` **可以替换**（即使 adb server 正在跑） | 同上，实验 2 成功 |
| 3 | PowerShell `-EncodedCommand` 处理**中文路径**稳定可用 | 同上，实验 3 `COPIED 12` |
| 4 | 便携版运行时解压到 `%TEMP%\<固定 hash 目录>\`，**同一 exe 每次复用同名目录**，**退出时 `RMDir /r` 删除** | 本机探针 `_probe-portable.py` + electron-builder `templates/nsis/portable.nsi` 源码 |
| 5 | 便携版会设置 `PORTABLE_EXECUTABLE_FILE`（= 用户手里那个 exe 的完整路径）、`PORTABLE_EXECUTABLE_DIR`、`PORTABLE_EXECUTABLE_APP_FILENAME` | 同上源码 `SetEnvironmentVariable` 段 |
| 6 | 便携版 exe 进程会 `ExecWait` 等到应用退出，再清理临时目录、自己退出 | 同上源码 |
| 7 | 本项目主进程**零第三方依赖**（只 require electron + node 内置），asar 自包含 | 扫描 `dist-electron/**/*.js` 的全部 require |
| 8 | asar 内容源 = `out-vX/win-unpacked/resources/app.asar` | 打包产物实测（v1.0.6 = 541434 B） |

**由 #1 得出的硬约束**：不能用「应用自己再起一个实例当更新器」（它同样会锁 asar）。必须用一个**非 Electron 的 helper** —— 即系统自带的 PowerShell（#3 已验证）。

**由 #4/#5 得出的便携版形态**：单文件便携版内部结构不可就地改，唯一有意义的形式是**替换 exe 本体**；`PORTABLE_EXECUTABLE_FILE` 让应用能定位到它（#5）。

---

## 2. 产物侧：多产一个小更新包

打包后追加一步（`scripts/build.py` 末尾自动调用）：

```
python scripts/make-update.py --out out-v1.0.7
```

产出 `out-v1.0.7/update/ADB桌面助手-v1.0.7-patch.zip`：

| 内容 | 说明 |
|---|---|
| `manifest.json` | 见下表 |
| `app.asar` | 必含 |
| `bin/**` | 可选，**只放与上一版有差异的文件**（用户要求支持 bin 更新） |

`manifest.json` 字段：

| 字段 | 用途 |
|---|---|
| `schema` | 固定 1，未来格式变更时拒绝旧包 |
| `productName` / `appId` | 防止装错产品 |
| `version` | 目标版本（必须 > 当前） |
| `builtAt` | 构建时间 |
| `electronVersion` | 与当前不一致 → 拒绝（运行时变了，必须全量） |
| `runtimeHash` | 对 `resources/bin/**` 的「相对路径+大小+sha256」汇总；不一致 → 本次小包不可用 |
| `kind` | `asar`（安装版小包）/ `portable`（便携版整包） |
| `files[]` | 每个文件的 `path` / `size` / `sha256` |

另外打包时输出 `out-vX/update/runtime-vX.json`（记录本版的 `electronVersion` + `runtimeHash`），供**下一版**生成小包时做差分比较。

---

## 3. 应用侧：更新器

### 3.1 更新源（抽象成接口，为第二阶段上服务器铺路）

第一阶段只实现 `local-file`（应用内选文件）。接口签名预留 `url` 实现：

```ts
interface UpdateSource {
  kind: 'local-file' | 'url';
  describe(): string;
  fetch(): Promise<string>;  // 返回本地已就绪的包路径
}
```

### 3.2 校验规则（任一不满足 → 明确拒绝，绝不硬来）

- `schema` 不支持
- `productName` / `appId` 与本机不符
- 目标 `version` ≤ 当前版本
- `electronVersion` ≠ 本机 → 「本更新包要求 Electron X，当前 Y，请改用完整安装包」
- 包内 `kind` 与本机形态不符：
  - 安装版拿到 `portable` 包 → 「这是便携版整包，当前是安装版」
  - 便携版拿到 `asar` 包 → 「便携版无法使用增量包，请选择便携版整包」
- `runtimeHash` ≠ 当前安装 → 「本更新包含运行库变更（adb/scrcpy），请改用完整安装包」
- 任一文件 sha256/size 不符 → 「更新包损坏」
- 目标目录不可写 → 提前报错（只读目录/U盘写保护）

### 3.3 执行流程（安装版）

```
用户选包
  → 主进程 prepareUpdate()：解压到 %TEMP%\adba-update-<ts>\、逐项校验
  → UI 展示「v1.0.6 → v1.0.7 · 156 KB · 安装版增量」+「立即更新并重启」
  → 用户确认
     ├─ 停止所有任务（投屏 / Logcat / 弱网）并 adb kill-server
     ├─ 写 job.json（UTF-8，全 ASCII 路径）+ pending.json
     ├─ spawn helper（detached、无窗口、路径全 ASCII）
     └─ app.quit()
  → helper（PowerShell，-File 方式）：
     1. 轮询：等主进程退出 + 目标文件可独占打开（最多 60s）
     2. 备份：app.asar → %APPDATA%\adb-assistant\update\backup\v1.0.6\app.asar
              bin 中被替换的文件同样备份
     3. 替换：先写 .new 再原子 rename（bin 逐文件）
     4. 启动新版本
     5. 轮询 30s：等待「健康标记」被清掉
          · 清掉 → 成功，写 update.log，保留备份
          · 没清掉 → 判定启动失败 → 杀进程 → 还原备份 → 启动旧版 → 写 last-error.txt
  → 新版启动：主进程读 update.log / last-error.txt
     · 渲染层 ready 后发一次 IPC 握手 → 主进程写健康标记 + 删 pending.json（toast「已更新到 v1.0.7」）
     · 若有 last-error.txt → 弹错误详情 + 「重试 / 回滚后继续」
```

**「启动成功」的判定**（关键设计）：不是「主进程起来了」就算成功，而是**渲染层加载完毕并完成一次 IPC 握手**才算。这样白屏（主进程活着、渲染层崩）也能被判定为失败并自动回滚。

### 3.4 执行流程（便携版）

差异只在 helper 的替换环节：

- 目标 = `process.env.PORTABLE_EXECUTABLE_FILE`（用户手里那个单文件 exe）
- 等待对象额外包含**便携版 exe 进程本身**（它 `ExecWait` 要等应用退出，源码见 #6）
- 替换：备份旧 exe → 新 exe 复制为 `xxx.new.exe` → 原子 rename 覆盖
- 启动：运行被替换后的 exe
- 回滚：还原旧 exe 并启动

### 3.5 回滚能力

| 场景 | 行为 |
|---|---|
| helper 替换失败（文件占用/磁盘满） | 立即还原备份，应用不重启（仍停在旧版），写错误日志 |
| 新版能启动、渲染层握手成功 | 保留备份，界面出现「回滚到 v1.0.6」按钮，可手动回滚 |
| 新版启动失败/白屏（30s 内无握手） | **自动回滚**到旧版并重启，界面提示原因 |
| 备份只保留最近 1 份 | 避免便携版备份（84 MB）堆积 |

### 3.6 代码改动清单（预计）

| 文件 | 改动 |
|---|---|
| `shared/types.ts` | `UpdateManifest` / `UpdateInfo` / `UpdateState` / `UpdateResult` / `UpdateTarget` |
| `electron/services/update.ts` | **新增**：源解析、校验、prepare、apply、rollback、健康握手、日志回读 |
| `electron/services/pe-version.ts` | **新增**：手写 PE VS_VERSIONINFO 读取（校验便携版整包的版本/产品名，不依赖文件名） |
| `electron/services/files.ts` | 复用：`runAdb`（更新前 `kill-server`）、任务停止钩子 |
| `electron/ipc.ts` / `electron/preload.ts` | 新增 `UPDATE_CHECK` / `UPDATE_PREPARE` / `UPDATE_APPLY` / `UPDATE_ROLLBACK` / `UPDATE_STATUS` 通道 + 白名单 |
| `src/pages/SettingsPage.tsx`（关于页） | 版本卡片 + 「检查更新」+ 更新包详情 + 结果/回滚 |
| `src/store/app.ts` | `update` 状态（idle/checking/prepared/applying/…） |
| `scripts/make-update.py` | **新增**：生成小包 + runtime 指纹 |
| `scripts/check-update.cjs` | **新增**：验收脚本 |
| `README.md` | 更新模块说明 + 踩坑 |

更新入口放在**「关于」页**（当前版本已在那里，语义最近），不动侧栏。

---

## 4. 明确不支持的情况（一律提示改用全量包）

- Electron 版本变化
- `resources/bin` 变化（除非提供含 bin 差量的包）
- 目标版本不比当前新（不做降级安装，降级走「回滚」）
- `app.isPackaged === false`（开发模式，直接禁用入口）
- 便携版用 asar 增量包 / 安装版用便携版整包

---

## 5. 验收计划

**新增 `scripts/check-update.cjs`（目标 30+ 项）**

- 产物侧：manifest 字段完整、sha256 正确、runtimeHash 稳定、差分只含变化文件
- 校验侧（纯函数，可离线跑）：上述 §3.2 每一条拒绝规则各一个反例
- 端到端（真机真安装版）：
  1. 造 `v1.0.6 → v1.0.7` 真小包 → 应用内走完 → **重启后确为 1.0.7**
  2. 投喂损坏 asar（能启动、渲染层崩）→ **验证 30s 内自动回滚到 1.0.6**
  3. 版本回退包 → 被拒绝且原版本不受影响
- 便携版：替换 `PORTABLE_EXECUTABLE_FILE` → 重启后版本变化
- 回归：现有 `check-drag-install` 47 项 / `check-install-modes` 21 项 / `check-apk-parse` 9 项 / `check-device-order` 9 项 / `check-about` 5 项 / `check-quick-mirror` 9 项

---

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| helper 被安全软件拦 | 只用系统自带 PowerShell，不落地任何自制 exe |
| 更新中 bin 被投屏进程占用 | 更新前强制停止任务；helper 对每个文件重试，失败整体回滚 |
| 替换中途断电 | 统一「先写 `.new` 再原子 rename」，最坏残留无用 `.new`，原文件不受影响 |
| 中文路径 / 编码 | 命令行只传 ASCII 路径（`%TEMP%\adba-update-<ts>\`），业务参数全部走 UTF-8 的 `job.json` |
| 便携版所在目录不可写 | prepare 阶段先探测写权限，提前给出明确提示 |
| 用户中途手动退出应用 | pending.json 未清 → 下次启动视为「上次更新未完成」，提示并保留回滚入口 |
| adb server 仍持有旧 adb.exe 映像 | 替换后 `adb kill-server`，下次调用自然重启新 server |
