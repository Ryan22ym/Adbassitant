# 在线更新上线操作方案

> 适用版本：**v1.0.22 及以后**（客户端已内置在线更新能力）
> 前置文档：`docs/online-update-design.md`（协议与客户端设计）、`docs/update-design.md`（v1.0.7 起的本地选包增量更新）
> 本文只讲**你要动手做的事**：服务器怎么架、文件怎么摆、每次发版发什么、出问题怎么退。

---

## 0. 一句话

服务器上不需要任何后端代码，只要一个 **HTTPS 静态目录**，里面放一个 `latest.json` 加若干 zip。
客户端启动时（或你点「检查更新」时）读这个 `latest.json`，发现版本比自己新就下载对应 zip，剩下的校验与替换完全沿用 v1.0.7 就在跑的本地更新那条链。

**在服务器就绪之前，客户端不需要改动**：`更新源` 默认是空字符串，界面显示为「未配置」——这是正常状态，不是报错；离线那条「选择更新包…」一直可用。

---

## 1. 前置条件清单

上线前逐项确认，缺一项都会卡住：

| # | 项目 | 要求 | 为什么 |
|---|---|---|---|
| 1 | **HTTPS 可达地址** | 公网 HTTPS，证书有效；或内网 CA 能被系统信任 | 客户端用系统/Chromium 的证书链校验，自签证书会被拒 |
| 2 | **支持 Range 与 `Content-Length`** | 至少 `Content-Length` 必须正确 | 进度条与「下载完成」判定依赖它；缺了会显示成不确定态 |
| 3 | **`latest.json` 可 `no-cache`** | 该文件必须设 `Cache-Control: no-cache`（或很短 `max-age`） | 否则 CDN 会缓存旧清单，你发了新版客户端看不到 |
| 4 | **zip 可长缓存** | `*-patch.zip` 可以设长 `max-age` | 文件名含版本号，天然指纹，不会串版本 |
| 5 | **客户端基线版本 ≥ v1.0.22** | 老版本客户端没有联网能力 | 见 §3 步骤 2：这一步只能靠用户**手动装一次全量包**跨过去 |
| 6 | **正文里不要放巨长 notes** | `notes` 建议 ≤ 500 字 | 界面直接原样展示，太长会把面板撑开 |

**不需要**的：后端程序、数据库、鉴权、签名证书、CDN 回源规则（有更好，不是必需）。

### 1.1 🔴 别填 `https://服务器IP` —— 证书这关过不去

一句话：**HTTPS 的信任根是证书，而公共 CA 不给裸 IP 签证书。**

- 公共 CA（Let's Encrypt、DigiCert…）的 DV 证书只签**域名**，不签 IP。给 IP 上证书要么买昂贵的 IP 证书，要么自签。
- **自签 = 客户端直接拒绝**。Electron 走 Chromium 的证书链校验，而客户端**刻意没有**注册 `certificate-error` / `setCertificateVerifyProc` 去忽略证书错误 —— 在软件更新链路上"忽略证书错误"等于给中间人开门。
- 界面会显示「更新源地址不可用」，底层错误是 `ERR_CERT_COMMON_NAME_INVALID` 或 `ERR_CERT_AUTHORITY_INVALID`。

**那用 `http://` 明文呢？** 代码**允许**（`normalizeBaseUrl` 不拦协议）—— 但别这么干：

> `latest.json` 里的 `productName` / `appId` / `sha256` 就是客户端全部的安全判据，而它们**全部来自 `latest.json` 自己**，没有独立的签名根。也就是说，谁能在传输途中改写 `latest.json`，谁就能把更新指向自己的包并给出配套的 sha256。
> **HTTPS 是这套方案唯一的信任根。** 去掉它等于把软件更新的经典攻击面完全敞开。
>
> 想要独立的信任根，就得给 `latest.json`（或包内 manifest）加签名并内置公钥验签 —— v1 明确不做，见设计文档「明确不做的事」。

结论：**必须有一个域名 + 有效证书。** 下面两条路，选一条。

### 1.2 两条路：自建 Nginx，或用对象存储

**路线 A —— 域名 + Nginx（推荐，标准做法）**

| # | 做什么 | 注意 |
|---|---|---|
| 1 | 买域名，加一条 **A 记录**指向服务器 IP | 域名不必贵，几块钱一年 |
| 2 | ⚠️ **国内节点必须 ICP 备案** | 腾讯云 Lighthouse 广州/上海/北京等节点：域名不备案，443/80 访问会被拦。**香港/新加坡等境外节点免备案**（但大陆访问速度略慢） |
| 3 | 控制台 → 防火墙 → 放行 **443**（和 80，签发证书要用） | Lighthouse 防火墙是独立于系统 `ufw` 的一层，别只改系统防火墙 |
| 4 | 装 Nginx，产物传到 `/var/www/adb-assistant/` | 目录名随便，客户端填的地址跟它对齐即可 |
| 5 | 上证书：`certbot` 自动签，或控制台申请免费 DV 证书再手动装 | 免费证书 90 天，`certbot` 可自动续期 |
| 6 | 配 server 块 + 缓存头 | 用 §3 步骤 5 的现成配置 |
| 7 | 客户端「更新源」填 `https://<域名>/adb-assistant/` | 见 §1.3 |

**路线 B —— 对象存储（最省事，连服务器都不用）**

腾讯云 COS / 阿里 OSS / 七牛：建 Bucket → 设**公有读** → 把 `latest.json` + zip 传上去 → 用它给的**自带 HTTPS 域名**。

- 好处：不用买服务器、不用装 Nginx、不用配证书、不用备案（用厂商默认域名时）。
- 代价：默认域名不好看、可能有限速、以后接 CDN 要额外配。
- 如果你只是想把更新跑起来，**这条最快**。以后想换成自有域名，只需改客户端的「更新源」—— 清单里的包地址写的是**相对路径**，换域名不用重新生成 `latest.json`。

### 1.3 地址到底填成什么样

程序会把你填的地址规整成「以 `/` 结尾」，再拼 `latest.json`：

| 你填的 | 规整后 | 实际请求 |
|---|---|---|
| `https://update.example.com/adb-assistant/` | 同上 | `…/adb-assistant/latest.json` |
| `update.example.com/adb-assistant/` | 自动补 `https://` | 同上 |
| `https://update.example.com/adb-assistant` | 自动补结尾斜杠 | 同上 |

**填到"目录一级"**，不是填域名根。填 `https://example.com/` 会把 `latest.json` 要求到网站根目录，和你的站点头页打架 —— 用**子域名**（`update.example.com`）或**子目录**（`/adb-assistant/`）隔开，后者更省事。

### 1.4 服务器还没买，也能先把链路验一遍

不必等到买完服务器。本机起一个静态服务就能把「读清单 → 下载 → 校验 → 替换」整条链走通（客户端允许 `http`，仅限这种本机演练场景）：

```powershell
# 在 out-v1.0.22\update 的**上一级**目录起服务，让 /adb-assistant/ 正好对上
python -m http.server 8000
# 然后客户端「更新源」填： http://127.0.0.1:8000/adb-assistant/
```

> 开发模式（未打包）下客户端会拒绝应用内更新，所以这个演练**不会真的替换你的安装文件**，只是把网络与解析这一段走通。

---

## 2. 服务器目录结构（最终长这样）

```
https://<你的域名>/adb-assistant/
  latest.json                                     ← 客户端唯一入口，必须叫这个名字
  ADB桌面助手-v1.0.22-patch.zip                    ← 安装版增量包（约 150–220 KB）
  ADB桌面助手-v1.0.22-patch.zip.sha256             ← 可选：给人看的，客户端不读
  ADB桌面助手-v1.0.22-portable-patch.zip           ← 便携版整包（约 88–110 MB）
  ADB桌面助手-v1.0.22-portable-patch.zip.sha256
  ADB桌面助手-v1.0.21-patch.zip                    ← 历史版本建议保留
  ADB桌面助手-v1.0.21-portable-patch.zip
```

- 客户端的「更新源」填 `https://<你的域名>/adb-assistant/`（**结尾斜杠可有可无**，程序会自动补；缺 `https://` 也会自动补）。
- 它会去请求 `<更新源>latest.json`。
- 清单里 `packages.*.url` **可以写相对路径**（推荐），以 `latest.json` 自己的地址为基准解析 —— 这样换域名、换 CDN 都不用重新生成清单。

---

## 3. 首次上线：六步

### 步骤 1 — 在代码里写上默认更新源

改 `electron/services/settings.ts` 的 `DEFAULTS`：

```ts
updateBaseUrl: 'https://<你的域名>/adb-assistant/',
```

其余三项保持默认即可：`updateChannel: 'stable'`、`autoCheckUpdate: true`、`lastCheckAt: ''`。

> 注意：这只是**默认值**。用户在设置页手动填的地址优先级更高，不会被覆盖。

### 步骤 2 — 发一版带这个默认值的版本，让用户装全量包

这一步**必须靠用户手动安装安装包**，因为老版本客户端根本不知道去哪儿查更新 —— 鸡生蛋问题，只有这一次。

走项目常规发版三步：
1. `package.json` 的 `version` 递增（例如 → `1.0.23`）
2. `src/pages/SettingsPage.tsx` 的 `VERSION_NOTES` 加一条 `'1.0.23'`
3. `python scripts/build.py --out out-v1.0.23` → `python scripts/install-local.py --out out-v1.0.23`

把产物发给用户装。从这一版起，后续所有更新都不再需要用户做任何事。

### 步骤 3 — 生成发布物

```powershell
python scripts/make-update.py --out out-v1.0.23
```

产物在 `out-v1.0.23\update\`：

```
ADB桌面助手-v1.0.23-patch.zip            安装版增量包
ADB桌面助手-v1.0.23-patch.zip.sha256
ADB桌面助手-v1.0.23-portable-patch.zip   便携版整包
ADB桌面助手-v1.0.23-portable-patch.zip.sha256
runtime-v1.0.23.json                     下一版差分基准（自己留着，不用传）
```

### 步骤 4 — 生成 `latest.json`

> ⚠️ **目前这一步是手工的**（`make-update.py --manifest-out` 还没做，见 §8）。
> 用下面的模板手写，或者跑本节末尾的小脚本。

把 `latest.json` 建在 `out-v1.0.23\update\` 下：

```json
{
  "schema": 1,
  "productName": "ADB桌面助手",
  "appId": "com.xiaoyang.adbassistant",
  "channel": "stable",
  "generatedAt": "2026-09-26T10:00:00+08:00",
  "latest": {
    "version": "1.0.23",
    "publishedAt": "2026-09-26T09:50:00+08:00",
    "notes": "第一行更新说明\n第二行也会保留换行",
    "critical": false,
    "packages": {
      "asar": {
        "url": "ADB桌面助手-v1.0.23-patch.zip",
        "size": 0,
        "sha256": ""
      },
      "portable": {
        "url": "ADB桌面助手-v1.0.23-portable-patch.zip",
        "size": 0,
        "sha256": ""
      }
    }
  }
}
```

**必须逐字正确**的四个字段（客户端会硬校验，不符直接拒绝并给出原因）：

| 字段 | 值 |
|---|---|
| `schema` | `1` |
| `productName` | `ADB桌面助手` |
| `appId` | `com.xiaoyang.adbassistant` |
| `channel` | `stable` |

`size` / `sha256` 用下面这段 PowerShell 填（`size` = 字节数）：

```powershell
$dir = "out-v1.0.23\update"
foreach ($f in @("ADB桌面助手-v1.0.23-patch.zip","ADB桌面助手-v1.0.23-portable-patch.zip")) {
  $p = Join-Path $dir $f
  $size = (Get-Item $p).Length
  $sha  = (Get-FileHash -Algorithm SHA256 $p).Hash.ToLower()
  "{0}`n  size   = {1}`n  sha256 = {2}" -f $f, $size, $sha
}
```

> `sha256` 大小写不敏感，客户端会统一转小写比较；但**必须与 zip 内容一致**。
> 这个 sha256 是**第一道**校验（防传输损坏），包内 `manifest.json` 的逐文件 sha256 是**第二道**（防投毒）。

### 步骤 5 — 上传 + 设缓存头

把 `out-v1.0.23\update\` 里的东西（**`runtime-vX.json` 不用传**）上传到 `/adb-assistant/`：

- 覆盖 `latest.json`（这是唯一会变的文件）
- 新增本版的 4 个 zip / sha256 文件
- **保留历史版本的 zip**，回退时要用

Nginx 参考配置：

```nginx
location = /adb-assistant/latest.json {
    add_header Cache-Control "no-cache, must-revalidate";
    types { } default_type application/json;
    charset utf-8;
}
location /adb-assistant/ {
    add_header Cache-Control "public, max-age=31536000, immutable";
    autoindex off;
}
```

对象存储（COS / OSS / S3）就把 `latest.json` 的元数据设成 `Cache-Control: no-cache`，其余默认即可。

> 中文文件名没问题（URL 编码由客户端处理），但如果你用的对象存储/CDN 对中文支持不稳，
> 可以直接把 zip 改成纯 ASCII 名（如 `adb-assistant-v1.0.23-patch.zip`），
> 只需同步改 `latest.json` 里的 `url`，客户端不关心文件名长什么样。

### 步骤 6 — 上线自检（4 项，逐项过）

**① 清单可读、内容是自己认识的**

```powershell
curl.exe -s https://<你的域名>/adb-assistant/latest.json
```

应该是合法 JSON、`schema=1`、`productName=ADB桌面助手`。
如果返回 HTML（网关错误页）或 404，客户端会提示「更新源返回的内容不是合法 JSON」/「更新源未配置或不可达」—— 先把这个修好再往下。

**② 清单声明的 sha256 与文件一致**

```powershell
$a = (curl.exe -s https://<你的域名>/adb-assistant/latest.json | ConvertFrom-Json).latest.packages.asar
$b = (Get-FileHash -Algorithm SHA256 "<本地 out-v1.0.23\update\$(Split-Path $a.url -Leaf)>").Hash.ToLower()
if ($a.sha256.ToLower() -eq $b) { "sha256 OK" } else { "不一致！清单=$($a.sha256) 文件=$b" }
```

**③ 客户端显示「已是最新」**（灰度，见 §5）

在自己机器上把更新源填成正式地址、点「检查更新」。如果清单里的 `version` 就是**你当前装的版本**，应该显示「已是最新版本」。
这一步能验证到：HTTPS 通、证书过、缓存头对（否则可能拿到旧的）。

**④ 客户端能看到新版并下载成功**

把 `latest.json` 的 `version` 改成真新版（如 `1.0.23`），重新点「检查更新」→ 应出现新版本卡片（版本号 / 发布时间 / 更新说明 / 包大小）→ 点「下载并更新」→ 进度条走满 → 变成「已就绪」→ 点「立即更新并重启」→ 重启后版本号变新。

> 便携版会下 88 MB 整包，安装版只有 150 KB 左右。**第一次务必两种形态各测一遍**。

---

## 4. 每次发版的例行流程

有服务器之后，日常发版就是这条链，前面 4 步都是本地动作：

```powershell
# 1) 改版本号三件套（缺一即失败，见项目记忆）
#    package.json version / SettingsPage.tsx VERSION_NOTES / 然后打包
python scripts/build.py --out out-v1.0.24
python scripts/install-local.py --out out-v1.0.24

# 2) 出更新包
python scripts/make-update.py --out out-v1.0.24

# 3) 写 latest.json（version 改成 1.0.24，size/sha256 按 §3 步骤 4 填）

# 4) 上传（覆盖 latest.json + 新增 4 个文件）

# 5) 自检 4 项（§3 步骤 6）
```

**每次都要确认的三件事**：

- `latest.json` 的 `version` **严格大于**客户端当前版本 —— 小于等于都算「已是最新」，**客户端不会降级**。
- `asar` 与 `portable` 两个包**都在**。只给一个的话，另一种形态的用户会看到「该版本没有你这种形态的包」。
- `notes` 里别放引号嵌套或换行符的转义错误 —— JSON 里换行必须写 `\n`。

---

## 5. 灰度与试运行

没有服务端分流能力（纯静态），所以灰度靠**改文件**：

| 阶段 | `latest.json` 怎么写 | 期望现象 |
|---|---|---|
| **冷启动确认** | `version` = 当前线上版本 | 所有客户端显示「已是最新版本」，说明链路通、缓存没作怪 |
| **小范围试投** | 正常发新版；但只把新版 zip 传给少数用户手动安装 | 验证新包在真实机器上能自升级、能回滚 |
| **全量** | `latest.json` 指向新版 | 所有人点「检查更新」或启动 8 秒后自检可见红点 |

**注意**：客户端默认 `autoCheckUpdate = true`，启动 8 秒后会静默检查一次，**只挂一个侧栏红点，不弹窗、不打断**。所以「全量」并不会造成集中下载风暴 —— 用户点到「下载并更新」才真正拉包。

---

## 6. 回退预案

从外到内三层，按出问题的位置选：

| 层次 | 场景 | 动作 | 影响 |
|---|---|---|---|
| **① 清单回退** | 新版有严重 bug，不想再有人升上去 | 把 `latest.json` 的 `version` 改回**旧版本号**（或直接删掉 `latest.json` 中的 `packages`） | 已升级的用户**不会自动降级**（客户端只认「比我新」）；未升级的用户看不到更新 |
| **② 换包重发** | 清单填错了 sha256 / 传错文件 | 直接覆盖对应的 zip + 改 `latest.json` | 下载中的人重试即可；已下完并校验通过的人不受影响 |
| **③ 客户端回滚** | 用户升上去之后应用起不来 | 用户自己点设置页的「回滚到 vX.XX」 | 见下 |

**客户端自带的两道保险**（v1.0.7 起就有，与在线更新无关地生效）：

1. **自动回滚**：新版替换完成后，新版本渲染层必须在 30 秒内握手；没握手（含白屏、崩溃）→ 更新助手自动还原旧文件并重启回旧版。
2. **手动回滚**：设置页「回滚到 vX.XX」按钮，按更新备份还原。

所以**最坏情况是"更新了一趟、版本没变"**，不会把用户的机器搞成一个起不来的程序。

> ⚠️ 有一件事回不掉：`latest.json` 里的 `schema` 一旦升到 `2`，只有认识 `2` 的新客户端能读，老客户端会拒绝并提示「请改用完整安装包升级」。**在 v2 客户端铺开之前不要动 `schema`。**

---

## 7. 常见故障对照表

客户端会把这些原因**原样显示在设置页的更新面板上**，按它说的查即可。

| 界面提示（关键词） | 真实原因 | 怎么修 |
|---|---|---|
| `更新源未配置` | `updateBaseUrl` 是空 | 设置页「更新源」填地址并保存；或改 `settings.ts` 默认值后发版 |
| `更新源地址不可用` / 连接超时 | 域名解析不了、端口不通、被防火墙拦、代理拦了 | `curl.exe -sv https://<域名>/adb-assistant/latest.json` 在**出问题的机器上**跑一遍 |
| `不是合法 JSON` | 网关/CDN 返回了 HTML 错误页（502/403/登录页） | 检查对象存储是否 private、Nginx 是否在/error 兜底 |
| `格式版本 X` | `schema` 不匹配 | 见 §6 的警告 |
| `提供的是「XX」的更新` | `productName` 写错 | 必须逐字 `ADB桌面助手` |
| `产品标识不符` | `appId` 写错 | 必须逐字 `com.xiaoyang.adbassistant` |
| `通道` | 清单 `channel` 与客户端设置不符 | 都用 `stable` |
| `版本号不合法` | `latest.version` 写成了 `v1.0.24`（带 v） | **不能带 v**，只能是 `1.0.24` |
| `没有提供便携版整包` | 清单缺 `packages.portable` | 补上；便携版无法就地替换，必须有整包 |
| `下载更新包失败：HTTP 404` | `url` 写错，或文件没传上去 | 注意相对路径是相对 `latest.json` 所在目录 |
| `校验值不符` | `sha256` 与 zip 实际内容不一致 | 按 §3 步骤 4 重算；确认传的是没被改过的文件 |
| `下载中断：30 秒没有收到新数据` | 网络抖动 / 服务端卡住 | 点重试；服务端加 `Range` 支持会更好 |
| 检查更新一直显示「已是最新」，但明明发了新版 | CDN 缓存了旧 `latest.json` | 确认缓存头是 `no-cache`；手动刷新 CDN |
| 进度条不动 / 显示不确定 | 缺 `Content-Length` | 让静态服务返回正确的 `Content-Length`（不要开 chunked） |

---

## 8. 还没自动化的部分（坦白说）

设计文档 §3.1 里列了两个脚本，**这一版还没写**，所以 §3 步骤 4 目前是手工的：

| 脚本 | 作用 | 现在的替代做法 |
|---|---|---|
| `scripts/make-update.py --manifest-out` | 从 `out-vX/update/` 直接生成 `latest.json`（顺便算 size/sha256） | §3 步骤 4 手写 + PowerShell 算 hash |
| `scripts/publish-update.py --target` | 把产物推到 COS/OSS/scp 目标 | 手动上传（或你自己的同步工具） |

要不要现在就补上，你说了算 —— 补上之后「发版」就是一条命令，手工最容易错的两个点（`version` 漏改、sha256 抄错）都会消失。

---

## 9. 相关文件索引

| 文件 | 作用 |
|---|---|
| `electron/services/update-core.ts` | `latest.json` 解析与选包（纯函数，无 electron 依赖） |
| `electron/services/update-net.ts` | 下载器：Electron `net.request`（跟随系统代理）+ `.part` + 进度 + sha256 + 取消 |
| `electron/services/update-source.ts` | `UpdateSource` 抽象：`http` / `local-file` 两种实现 |
| `electron/services/update.ts` | `checkOnlineUpdate()` / `prepareUpdateFromUrl()`；下载层与校验层在这里衔接 |
| `electron/services/settings.ts` | `updateBaseUrl` / `updateChannel` / `autoCheckUpdate` / `lastCheckAt` |
| `src/pages/SettingsPage.tsx` | 设置页「软件更新」面板 + 「更新源」卡片 |
| `scripts/check-update-online.cjs` | 纯逻辑 + 下载器验收（47 项，离线可跑） |
| `scripts/check-update-online-ui.cjs` | 界面与下载链路验收（29 项，需要 Electron） |
| `docs/online-update-design.md` | 协议与设计的完整记录 |
