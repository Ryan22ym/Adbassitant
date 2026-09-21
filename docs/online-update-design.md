# 在线更新方案（v1.0.22 / develop 分支）

> 状态：**P1–P4 已实现并验收通过**（2026-09-20）。协议按小杨确认的四项定稿：
> 静态 JSON 源 / 静默自检 + 手动 / Electron net / 只做 stable。
> 服务器未就绪 —— `updateBaseUrl` 默认空，界面显示「未配置」为正常状态。
> **上线怎么做 → 看 `docs/online-update-rollout.md`**（本文只讲设计与实现）。
> 前序：`docs/update-design.md`（v1.0.7 起的本地选包增量更新，已真机验证）。

## 实现状态速查

| 阶段 | 内容 | 状态 | 验收 |
|---|---|---|---|
| P1 | `update-core` 纯函数 + `update-source.ts` + `update-net.ts` + IPC + 设置项 | ✅ 完成 | `npm run check:update-online` — 47/47 |
| P2 | `checkOnlineUpdate()` + 静默自检 + `store.updateAvailable` 红点 | ✅ 完成 | 同上 + UI 脚本 |
| P3 | 下载 + 进度推送 + 接 `prepareUpdate` + 取消 | ✅ 完成 | `npm run check:update-online-ui` — 27/27 |
| P4 | `UpdatePanel` 重做 + 「更新源」设置卡片 | ✅ 完成 | 同上（含截图 `ui-shots/update-online-settings.png`） |
| P5 | 真机 e2e（下载 → 替换 → 重启） | ⏳ 待打真包后跑 | 见 `e2e-update-apply.cjs` |
| P6 | `make-update.py --manifest-out` + `publish-update.py` | ⏳ 未做 | 见 rollout 文档 §8 |

未做 P5/P6 的原因：这两项都要**真安装包**参与（P5 必须在打包版上跑），而本轮的边界是"客户端代码预留接口"。P6 的替代做法已在 rollout 文档里写清（手写 `latest.json` + PowerShell 算 hash）。

---

## 0. 一句话结论

现有的「本地选包 → 校验 → 助手替换 → 失败自动回滚」闭环**一行都不用改**；本次只在它前面接上「检查更新 + 下载」两段，把包从"用户手动挑的 zip"变成"程序自己下到 `%TEMP%` 的 zip"。服务器只需要托管静态文件，不需要任何后端代码。

---

## 1. 现状盘点（已实现 / 未实现 / 可复用）

### 1.1 已实现（不要重做）

| 能力 | 位置 | 说明 |
|---|---|---|
| 产物生成 | `scripts/make-update.py` | 出 `ADB桌面助手-vX-patch.zip`（安装版增量，~156 KB）与 `runtime-vX.json`（下一版差分基准），zip 旁带 `.sha256`。**v1.0.24 起不再产出便携版整包**（`-portable-patch.zip`）——打包只出 NSIS 安装包 |
| 包校验 | `electron/services/update-core.ts` | schema / productName / appId / 版本递增 / Electron 版本 / `baseRuntimeHash` / 逐文件 sha256，任一不过直接拒绝 |
| 执行替换 | `electron/services/update.ts` + `electron/assets/update-helper.ps1` | `cmd /c start` 代建 PowerShell 助手（绕开作业对象连坐），退出后原子替换，新版渲染层握手判定成功，30 s 无握手自动回滚 |
| 界面 | `src/pages/SettingsPage.tsx` 的 `UpdatePanel` | 选择更新包 / 立即更新并重启 / 回滚到 vX |
| 下载轮子 | `electron/services/aab.ts` 的 `httpGet()` + `downloadBundletool()` | `.part` 临时文件、进度回调、内容魔数校验、超时 20 s —— **本方案的下载器照这个写** |
| 进度推送范式 | `PUSH_AAB_DOWNLOAD` → `PUSH_AAB_OUTPUT` | 主进程 → 渲染层推送的既有写法 |

### 1.2 未实现（本次的范围）

- **联网检查更新**：`update.ts` 里联网代码 0 行，`prepareUpdate(zipPath)` 只吃本地路径。
- **下载更新包**：没有任何下载逻辑（bundletool 那套是给 jar 用的，不复用，只照抄写法）。
- **`UpdateSource` 抽象**：`docs/update-design.md` §3.1 纸上设计了 `{ kind: 'local-file' | 'url'; fetch() }`，但**代码里从未落地**（全仓 grep 无 `UpdateSource`）。本次把它真正写出来。
- **UI**：没有任何"检查更新"入口、版本公告、下载进度。

---

## 2. 协议设计：服务器只托管静态文件

```
https://<域名>/adb-assistant/
  latest.json                                       ← 客户端唯一入口
  ADB桌面助手-v1.0.24-patch.zip
  ADB桌面助手-v1.0.24-patch.zip.sha256
```

（v1.0.24 起不再有 `-portable-patch.zip`：打包只出 NSIS 安装包，更新只发安装版小包。
客户端对便携形态的兼容代码保留，仅不再被新版本用到。）

### 2.1 `latest.json`

```json
{
  "schema": 1,
  "productName": "ADB桌面助手",
  "appId": "com.xiaoyang.adbassistant",
  "channel": "stable",
  "generatedAt": "2026-09-25T10:00:00+08:00",
  "latest": {
    "version": "1.0.24",
    "publishedAt": "2026-09-25T09:50:00+08:00",
    "notes": "更新说明，界面直接显示（支持 \n 换行）",
    "critical": false,
    "packages": {
      "asar": {
        "url": "ADB桌面助手-v1.0.24-patch.zip",
        "size": 163840,
        "sha256": "…"
      }
    }
  }
}
```

| 字段 | 用途 / 约束 |
|---|---|
| `schema` | 固定 1；不认识的 schema → 提示"更新源版本过新，请升级程序" |
| `productName` / `appId` | 必须与 `shared/types.ts` 的 `UPDATE_PRODUCT_NAME` / `UPDATE_APP_ID` 一致，防止指错源 |
| `channel` | 本次只实现 `stable`；协议预留，将来加 `beta` 不动协议 |
| `latest.version` | 用现有 `cmpVersion()` 与 `app.getVersion()` 比较；**小于等于当前不算更新**（不做降级） |
| `latest.notes` / `critical` | 界面展示；`critical` 预留（强更提示），本次只做展示不强制 |
| `packages.asar` / `packages.portable` | 按 `localKind()` 取对应形态；缺失 → 「该版本没有你这种形态的包，请下载完整安装包」。**v1.0.24 起只写 `asar`**（不再发便携整包），已装便携版的用户会看到上述提示 |
| `packages.*.url` | **允许相对路径**，以 `latest.json` 的 URL 为 base 解析（`new URL(url, base)`）→ 换域名不用重发清单 |
| `packages.*.size` / `sha256` | 下载完先按此校验（第一道）；包内 manifest 的逐文件 sha256 是第二道 |

### 2.2 安全边界（为什么清单不签名也能接受）

`latest.json` 只负责"指路"，**所有安全判定仍在 zip 内部的 `manifest.json`**：产品名、appId、版本递增、Electron 版本、`runtimeHash`、逐文件 sha256。就算更新源被投毒换成一个别的 zip，`prepareUpdate()` 也会拒绝。因此第一版不做清单签名；将来要更严，可在 manifest 里加 ed25519 签名，客户端加公钥，不影响本协议。

---

## 3. 客户端设计

### 3.1 新增 / 改动清单

| 文件 | 类型 | 改动 |
|---|---|---|
| `electron/services/update-source.ts` | 新增 | `UpdateSource` 抽象落地：`local-file` / `http` 两种实现，含 `latest.json` 解析与就地校验 |
| `electron/services/update-net.ts` | 新增 | 下载器：Electron `net.request`（自动跟随系统代理）+ 超时 + `.part` + 进度回调 + sha256 校验 |
| `electron/services/update-core.ts` | 小改 | 追加纯函数 `parseLatestJson()` / `pickPackage()` / `resolvePackageUrl()`（不 import electron，验收脚本可直接 require） |
| `electron/services/update.ts` | 小改 | 新增 `checkOnlineUpdate()` / `prepareUpdateFromUrl()`；**现有 `prepareUpdate` / `applyUpdate` / `rollbackUpdate` 一行不动** |
| `electron/services/settings.ts` + `shared/types.ts` | 小改 | `AppSettings` 新增 `updateBaseUrl`（默认空 = 未配置）、`updateChannel`（默认 `stable`）、`autoCheckUpdate`（默认 `true`）、`lastCheckAt` |
| `electron/ipc.ts` / `electron/preload.ts` | 小改 | 新增 `update:check` / `update:download` / `update:cancelDownload`；推送 `push:updateDownload`（preload 内联常量 + 白名单两处都要同步） |
| `src/pages/SettingsPage.tsx` | 重做 `UpdatePanel` | 见 §4 |
| `src/store/app.ts` | 小改 | `updateAvailable`（侧栏红点用） |
| `scripts/make-update.py` | 小改 | 加 `--manifest-out`：生成/更新 `latest.json`（发布用），失败不影响原有产物 |
| `scripts/publish-update.py` | 新增（可选） | 把 `out-vX/update/*` + `latest.json` 推到服务器（scp / COS / OSS，按 `--target` 选） |
| `scripts/check-update-online.cjs` | 新增 | 验收脚本，见 §6 |
| `docs/online-update-design.md` | 本文档 | 方案与上线步骤 |

### 3.2 `UpdateSource` 抽象（把纸上的写出来）

```ts
export interface LatestInfo {
  version: string;
  publishedAt?: string;
  notes?: string;
  critical?: boolean;
  /** 与当前形态匹配的包；null = 该版本未提供此形态 */
  pkg: { url: string; size?: number; sha256?: string } | null;
}

export interface UpdateSource {
  kind: 'local-file' | 'http';
  /** 面向用户的描述，如「官方更新源」/「本地文件」 */
  describe(): string;
  /** http：拉清单并比对版本；local-file：由用户选文件，不参与 check() */
  check(): Promise<LatestInfo>;
  /** 返回本地已就绪的更新包路径（http 会下载） */
  fetch(onProgress?: (p: DownloadProgress) => void): Promise<string>;
}
```

- `httpSource(baseUrl, snapshot, channel)`：`check()` 拉 `latest.json` → 校验 → 比对版本；`fetch()` 下载到 `%TEMP%\adba-update-dl-<ts>\<文件名>`（**注意文件名不能以 `.asar` 结尾的坑不涉及这里，包名是 `*-patch.zip`，安全**）。
- `localFileSource(zipPath)`：把现有流程包成同一个接口（`check()` 直接返回该包的 manifest 信息），**行为与今天完全一致**。

### 3.3 检查更新流程

```
启动后延迟 8s（不抢启动资源）、且 settings.autoCheckUpdate 为真
   └─ 静默 check()：任何失败都只记日志，不弹窗、不打扰
        有新版本 → store.updateAvailable = true → 侧栏「设置」挂红点 + 关于页卡片预填
手动点「检查更新」→ 强制 check()（忽略缓存）→ 结果如实呈现（含失败原因）

check() 内部：
  GET {base}latest.json（超时 10s，跟随 302）
    → parseLatestJson()：schema / productName / appId / channel
    → cmpVersion(latest.version, app.getVersion()) <= 0 → 「已是最新」
    → localKind() 取 packages[kind] → 缺失 → 「该版本未提供此形态的包」
    → 解析相对 URL → LatestInfo
```

### 3.4 下载器

- **传输层用 Electron `net.request`**（已确认）：自动跟随系统代理与 PAC，证书校验走 Chromium；`aab.ts` 那套 `https.get` 手动实现代理太麻烦，仅照抄它的 `.part` / 进度 / 校验思路。
- 超时：连接 10 s、无数据 30 s（`request.setTimeout` + 手动 abort），总时长不设死限（历史便携整包 88 MB；v1.0.24 起只有 ~156 KB 的安装版小包）。
- 落盘：`%TEMP%\adba-update-dl-<ts>\<原始文件名>`，先 `.part` 后改名 —— 断网不会留下一个"看起来正常"的坏包。
- 校验：下载完先比 `size` 与 `sha256`（清单给的），不符即删并要求重试。
- 进度：回调 `{ received, total, percent }` → 主进程 `push:updateDownload` → 界面进度条；下载可取消（`update:cancelDownload`）。
- 重试：界面提供「重试」；程序内自动重试 1 次（网络抖动最常见）。
- 不做断点续传（v1）：当时整包最大 88 MB，收益不值当；v1.0.24 起只剩百 KB 级小包，更不需要。

### 3.5 与现有校验链的衔接

```ts
prepareUpdateFromUrl(pkgUrl, expectedSha256)  // 新
  → 下载（上一步，已在 fetch() 里做完）
  → 校验清单 sha256
  → 直接调用现有 prepareUpdate(zipPath)       // 复用，一行不改
```

即：**下载层与校验层解耦**。服务器只负责"把字节搬过来"，安全性仍由包内 manifest 保证。

### 3.6 IPC 与设置项

| 通道 | 方向 | 签名 |
|---|---|---|
| `update:check` | invoke | `(force?: boolean) => UpdateCheckResult` |
| `update:download` | invoke | `(pkgUrl: string, sha256?: string) => UpdateInfo`（内部：下载 → `prepareUpdate`） |
| `update:cancelDownload` | invoke | `() => boolean` |
| `push:updateDownload` | 推送 | `{ received, total, percent, phase: 'download' \| 'verify' }` |

```ts
export interface UpdateCheckResult {
  ok: boolean;                 // 检查动作本身是否成功（网络+清单合法）
  reason?: string;             // ok=false 时的用户可读原因
  sourceDesc: string;          // 「官方更新源」/「未配置」
  hasUpdate: boolean;
  currentVersion: string;
  latest?: { version: string; publishedAt?: string; notes?: string; critical?: boolean;
             pkg: { url: string; size?: number } | null };
  checkedAt: string;
}
```

设置项（`AppSettings` 追加）：

- `updateBaseUrl: string` —— 默认 `''` = 未配置。未配置时「检查更新」直接提示「更新源未配置」而不是报错（**服务器没就绪时的正确姿态**）。
- `updateChannel: 'stable'` —— 类型先写成 `'stable' | 'beta'`，UI 本次只暴露 stable。
- `autoCheckUpdate: boolean` —— 默认 `true`。
- `lastCheckAt: string` —— 上次检查时间，界面显示；静默检查也写。

---

## 4. UI 设计（关于页 `UpdatePanel` 重做）

现有面板只做一件事（选文件）。重做后是「状态条 + 结果区 + 按钮组」三层：

```
┌ 软件更新 ──────────────────────────────────────── [更新目录] ┐
│ 当前版本 v1.0.21 · 安装版（增量更新）                          │
│ 最近检查：2026-09-20 15:10                                    │
│                                                              │
│ ┌ 有新版本 v1.0.22 ──────────────────────── 156 KB ────────┐ │
│ │ 发布时间 2026-09-25 10:00                                │ │
│ │ 更新说明：……（notes 的正文）                             │ │
│ │ [下载并更新]                                             │ │
│ └──────────────────────────────────────────────────────────┘ │
│                                                              │
│ [检查更新]  [选择本地更新包…]  [回滚到 v1.0.20]                │
│ 日志与备份在 %APPDATA%\adb-assistant\update\                  │
└──────────────────────────────────────────────────────────────┘
```

三种结果态：

| 态 | 呈现 |
|---|---|
| 已是最新 | 一行绿字「已是最新版本（检查于 15:10）」 |
| 有新版本 | 上述卡片：版本、发布时间、更新说明、包大小 →「下载并更新」→ 进度条（`data-update-progress`）→ 下载完成后**自动切换成现有的「已就绪 + 立即更新并重启」确认块**（完全复用，不另写一套） |
| 检查失败 | 一行灰字「检查更新失败：连接超时 / 更新源未配置」，**不弹错误弹窗、不打断**；手动选包入口照旧可用 |

其他约定：

- 「**选择本地更新包…**」降为次要按钮但**必须保留** —— 服务器挂了、内网隔离、内测发临时包，全靠它；这是"功能不退化"的底线。
- 「回滚到 vX」保持原样。
- 静默自检发现新版本时：侧栏「设置」项挂红点（`store.updateAvailable`），关于页卡片预填结果，**不弹任何窗**。
- 所有新元素带上 `data-update-*` 属性，供验收脚本按字面量定位（本项目惯例，改文案必须 grep 验收脚本）。

---

## 5. 分期计划

| 阶段 | 内容 | 可独立验收 |
|---|---|---|
| **P1** | 联通层：`update-core` 纯函数（解析/比对/选包/URL 解析）+ `update-source.ts` + `update-net.ts` + IPC 通道 + 设置项 | 纯 Node 断言 + 本地 http 服务 |
| **P2** | 检查更新：`checkOnlineUpdate()` + 静默自检 + store 状态（**只读，不碰安装**） | 起假服务看三种结果态 |
| **P3** | 下载：`fetch()` + 进度推送 + 接 `prepareUpdate` + 取消/重试 | 本地服务下真包 |
| **P4** | UI 重做 `UpdatePanel` + 设置项出现在设置页 | 安装版界面验收脚本 |
| **P5** | `check-update-online.cjs` 验收脚本（§6）+ 真机 e2e | 全绿 |
| **P6** | `make-update.py --manifest-out` + `publish-update.py` + README/文档 | 本地 dry-run |

版本号：**v1.0.22**（发版三步照旧，`VERSION_NOTES` 别忘了加 `'1.0.22'` 一条）。

---

## 6. 验收计划

**新增 `scripts/check-update-online.cjs`（目标 30+ 项，全部离线可跑）**

- **A 段（纯逻辑，Node 直接 require）**：`parseLatestJson` / `pickPackage` / `resolvePackageUrl` 的正常与异常：缺 schema、schema 过新、productName 不符、appId 不符、channel 不符、版本不递增、版本相等、无对应形态包、相对 URL 解析、绝对 URL 解析、sha256 大小写、notes 换行。
- **B 段（本地 HTTP，`node:http` 起临时服务，照 `mirror-server.py` 思路）**：8 种场景各一条断言 —— ① 有新版本 ② 已是最新 ③ 404 ④ 连接超时（服务端 sleep）⑤ 摘要不符 ⑥ `kind` 不匹配（便携版只给 asar 包）⑦ 坏 manifest 的 zip ⑧ 服务器直接拒连（端口关闭）→ 提示降级且不崩。
- **C 段（真 Electron）**：下载小包走完 `net.request`，断言进度回调递增、`.part` 不残留、sha256 不符时被删。
- **D 段（`--installed`，安装版界面）**：点「检查更新」→ 三种结果态各断言一次（假服务可控）。

**回归**：`check:update`（现有 30+ 项）、`check:asar-stage`、`check:helper-launch`、`e2e-update-apply` 必须全绿 —— 本次不动 `prepareUpdate`/`applyUpdate`，理论上零回归，但要跑。

**真机 e2e**（P5）：本地假服务 → 下载 → 更新 → 重启后版本确为 v1.0.22；再投喂坏包验证自动回滚仍生效。

---

## 7. 服务器就绪后的落地步骤

**正式《上线操作方案》已交付：`docs/online-update-rollout.md`** —— 那里有逐条命令、`latest.json` 模板、
缓存头配置、灰度流程、三层回退预案和一张「界面提示 → 真实原因 → 怎么修」对照表。
下面只留骨架索引：

1. **定托管**：对象存储 + CDN，或一台 Nginx 静态目录，只要 HTTPS 可达。
2. **建目录**：`/adb-assistant/`，放 `latest.json` + 各版本 zip + `.sha256`（历史版本建议保留，便于回退）。
3. **生成清单**：`python scripts/make-update.py --out out-v1.0.22` 出包，再写 `latest.json`（P6 前是手工的）。
4. **上传**：手动或 `scripts/publish-update.py`（P6 待做）。
5. **改默认地址**：`settings.ts` 里 `updateBaseUrl` 默认值改为真实地址 → 发一版全量包（这次改动需要用户装一次全量）。
6. **可达性自检**：HTTPS 通、跟随 302、`Content-Length` 正确（进度条靠它）。
7. **灰度**：先把 `latest.json` 的 `version` 写成**当前版本**，确认客户端显示「已是最新」→ 再改成真新版。
8. **缓存策略**：`latest.json` 必须 `Cache-Control: no-cache`；`*-patch.zip` 可长缓存（文件名含版本号，天然可缓存）。
9. **回退**：出问题就把 `latest.json` 改回旧版本 —— 客户端只认版本号，**天然不会降级**；客户端侧还有手动选包 + 备份回滚双保险。

---

## 8. 风险与对策

| 风险 | 对策 |
|---|---|
| 服务器没就绪时界面报错、体验变差 | `updateBaseUrl` 默认空 → 「更新源未配置」是**正常状态**而非错误；静默自检失败只写日志 |
| 更新源被投毒 / 指向别的产品 | 清单校验 productName + appId；包内 manifest 二次校验（产品、版本、运行库、逐文件 sha256） |
| 代理环境下下载卡死 | 用 Electron `net.request` 走系统代理；连接 10 s / 无数据 30 s 超时 |
| 下载中断留下坏包 | `.part` → 改名；下载后先验 sha256，不符即删并提示重试 |
| 便携版整包 88 MB 下载慢 | 只在便携版形态下才下整包；安装版走 156 KB 小包。**v1.0.24 起只发安装版小包，这个风险已消失** |
| 用户手动选包路径被新 UI 挤掉 | 明确保留为常驻次要按钮，验收脚本钉住它仍可用 |
| 新增设置项漏同步到 `App.tsx` | 启动时读取设置的地方（v1.0.21 的教训：持久化配置只在某组件挂载时才读 → 必有入口绕过它） |

---

## 9. 明确不做的事

- 不做断点续传（v1）。
- 不做增量差分下载（bin 差量已有，但整包级 diff 不做）。
- 不做强制更新 / 静默安装（`critical` 只展示不强制）。
- 不做 beta 通道的 UI（协议与类型预留，界面只暴露 stable）。
- 不做服务端接口（本次确认走静态托管）。
