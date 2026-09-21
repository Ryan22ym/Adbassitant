# 弱网模拟改造：App + VpnService 方案（future 分支）

> 目标：把弱网的实现从「电脑侧代理进程 + 设备全局 HTTP 代理」换成
> 「**在设备上装一个配套 App，由 App 建 VPN 在本机做流量整形**」。
> **前端界面表现保留**，只换实现方式。

---

## 1. 为什么要换

旧方案（`services/proxy-shaping.ts` + `services/weaknet.ts` 的 proxy 分支）：

```
手机 App ──► 手机 127.0.0.1:17890 ──adb reverse──► 电脑代理（注入弱网）──► 真实服务器
                     ▲
        settings put global http_proxy 127.0.0.1:17890
```

它有三个**结构性**问题，不是实现细节能修的：

| 问题 | 说明 |
|---|---|
| **覆盖不全** | 只作用于「遵循系统代理」的应用（OkHttp / 浏览器）。QUIC/UDP、原生 socket、走 `ConnectivityManager` 自己解析代理的应用、部分游戏统统绕过。弱网测试最想覆盖的正是这类真实场景。 |
| **依赖 ROM 权限** | `settings put global` 需要 `com.android.shell` 持 `WRITE_SECURE_SETTINGS`，ColorOS 等定制 ROM 直接剥夺。一旦被剥夺只能退化成「让用户去 WLAN 手动填代理」，而且**停止后我们清不掉**，用户会被留在「设备连不上网」的状态（详见 README 那段事故复盘）。 |
| **残留即断网** | 代理设置是**持久**的（存 settings 数据库），而 `adb reverse` + 电脑代理进程是**易失**的。拔线 / adb server 重启 / 工具被强杀 ⇒ 设备把所有流量打向一个没人监听的端口 ⇒ **ping 通但所有 App 上不了网**。 |

新方案：

```
手机 App ──► App 内的 VpnService（用户态 tunnels）──► 真实 socket ──► 真实服务器
                    ▲
         控制通道：adb reverse tcp:PORT tcp:PORT → App 里的本地 HTTP 控制端口
```

优势：

- **全量覆盖**：VPN 在 IP 层接管，不管应用走不走 HTTP 代理、是 TCP 还是 UDP，一律经过我们；
- **不需要写 global settings**：绕开 ColorOS 那套权限问题，也不再碰 `http_proxy` 那个事故源；
- **生命周期清晰**：VPN 的寿命 = 进程的寿命。进程死了隧道跟着断，**系统会自动恢复真实网络**，
  不会像代理设置那样留下持久残留；
- **参数精度更高**：可以在 IP 包级别做延迟/丢包/带宽，而不是在字节流上做等效近似；
- **可见可控**：系统状态栏有 VPN 标识，用户随时知道「有东西在改我的网络」，也能一键关掉。

## 2. 关键约束：VPN 需要用户授权，且不能免授权

这是本方案**必须正面处理**的事：`VpnService.prepare()` 会拉起系统授权对话框，
**必须由用户在设备上点一次「确定」**。没有任何后门可以绕过（那正是 VPN 权限的设计目的）。

所以流程必须设计成：

1. 电脑侧先把控制通道建好（`adb reverse`）；
2. 电脑侧让 App 的授权 Activity 弹到前台（`am start`），**用户点一下「确定」**；
3. 授权结果通过控制通道回报给电脑；UI 展示「等待设备授权」；
4. 授权拿到后，之后每次启动**都不再需要**授权（系统记住本应用的 VPN 授权），
   除非用户在系统设置里撤销。

> ⚠️ 一个必须如实告诉用户的限制：**首次使用需要用户在手机上点一次授权**。
> 不能假装全自动。

## 3. 组件划分

```
android/                                  ← 新增：配套 App（独立 Gradle 工程）
├── app/src/main/
│   ├── AndroidManifest.xml               VpnService + 授权 Activity + 前台服务
│   ├── java/.../WeakNetVpnService.kt     VpnService 实现：建隧道、整形、回写
│   ├── java/.../ControlServer.kt         本地 HTTP 控制端口（被 adb reverse 打进来）
│   ├── java/.../TrafficShaper.kt         整形引擎（延迟/抖动/带宽/丢包/错报）
│   ├── java/.../Protocol.kt              控制协议 DTO 与解析
│   └── res/                              通知图标、字符串
└── build.gradle.kts

electron/services/weaknet-vpn.ts          ← 新增：电脑侧 VPN 引擎编排
electron/services/weaknet.ts              ← 改造：vpn 作为首选引擎，旧实现保留回退
share/types.ts                            ← 增加 vpn 模式与状态字段
src/pages/WeakNetworkPage.tsx             ← 保留布局，实现方式改为以 VPN 为主
```

## 4. 控制协议

控制通道是 **App 侧监听、电脑侧通过 `adb reverse` 打进来** 的本地 HTTP 服务。

为什么是「App 监听、电脑打进去」而不是反过来：`adb reverse` 只能把**设备的端口**映射到**电脑的端口**，
方向固定是「设备某端口 → 电脑某端口」。要让电脑主动访问设备的服务，就必须用 reverse。

```
adb reverse tcp:18080 tcp:18080
```
之后设备上任何进程访问 `127.0.0.1:18080` 都打到电脑；反过来，**电脑要访问设备的服务不能用 reverse**。

> ⚠️ 这里有个反直觉的点：`adb reverse` 帮不了我们「电脑 → 设备服务」这个方向。
> 电脑要访问设备上的端口，走的是 **`adb forward tcp:P tcp:P`**（设备端口 P 映射到电脑 P）。
> 所以控制通道用 **forward**，不是 reverse。

修正后的链路：

```
电脑 127.0.0.1:18080 ──adb forward tcp:18080 tcp:18080──► 设备 App 监听 127.0.0.1:18080
```

控制接口（HTTP + JSON，全部 `POST`，路径挂在 `/`）：

| 端点 | 作用 |
|---|---|
| `GET /ping` | 探活。返回 `{ok, version, vpnActive, authorized}` |
| `POST /authorize` | 拉起授权 Activity（设备上弹系统 VPN 授权框），立即返回；结果异步在 `/status` 里体现 |
| `POST /start` | 带完整参数启动 VPN。**未授权则返回 `need_authorize`** |
| `POST /params` | 热更新参数（不重建隧道，避免闪断） |
| `POST /stop` | 停 VPN，恢复系统网络 |
| `GET /status` | 会话状态 + 实时统计 + 当前参数 + 授权态 |

参数对象（与前端现有 7 个参数一一对应）：

```json
{
  "up":   { "bandwidthMbps":1, "delayMs":300, "jitterMs":80, "lossPercent":1,
            "corruptPercent":0, "reorderPercent":0, "duplicatePercent":0 },
  "down": { "...": "同上" },
  "durationSec": 60,
  "blockNetwork": false
}
```

## 5. 参数在 IP 层的真实语义（比代理方案更准）

VPN 拿到的是**原始 IP 包**，所以这里的语义就是内核对 netem 那种语义，不再需要「等效近似」：

| 参数 | 实现 | 说明 |
|---|---|---|
| 延迟 | 出/入方向包排队，按 `now + delay` 投递 | 逐包精确 |
| 抖动 | `delay ± jitter`（三角分布） | 逐包精确 |
| 带宽 | **令牌桶**（按包长计费） | 与 netem tbf 同语义 |
| 丢包 | **真的丢包** | IP 层丢包由 TCP 重传兜住 —— 这才是真实丢包的样子。发送方向直接不写；接收方向直接不返回给系统。 |
| 错报 | 篡改包内一个 bit 后按原样送出/送回 | 校验和会被打破，接收端丢弃并重传 —— 与真实信道误码一致 |
| 乱序 | 投递时刻加随机扰动（**不缓存重排**，靠时序自然错位） | IP 层乱序会由 TCP 重排兜住，符合真实网络 |
| 重复包 | 按概率把包再投递一次 | 真实重复包会被接收端去重，但白占带宽 |

> 注意与旧代理方案的本质区别：旧方案在**字节流**上不能真丢/真乱序（那是篡改内容）；
> 新方案在**包**层上可以真丢/真乱序，因为重传重排是 TCP 自己的职责。这是 VPN 方案保真度更高的根因。

## 6. 生命周期与「恢复网络」

这是需求里明确点出来的三件事：**创建、授权、恢复网络及时关闭 VPN**。

### 6.1 创建

App 冷启动 → 起前台服务 → `ControlServer` 监听 `127.0.0.1:18080` → 报 `vpnActive=false`。

### 6.2 授权

```
电脑 POST /authorize
  └─ App: am 级别的 startActivity(VpnService.prepare(intent))
        └─ 系统弹「允许 XX 建立 VPN 连接？」
              ├─ 用户点确定 → onActivityResult RESULT_OK → App 记 authorized=true
              └─ 用户点取消 → authorized=false
电脑 GET /status 轮询 → 拿到 authorized
```

授权态**持久**（系统按 uid 记住），所以只需一次。若用户在系统设置里撤销 VPN 权限，
`prepare()` 会返回非 null，我们会重新走授权流程。

### 6.3 恢复网络（最重要的一条）

有**四层**保障，缺一层就会留下「设备上不了网」的坑：

| 层 | 触发时机 | 动作 |
|---|---|---|
| 1 | 电脑点「立即恢复网络」 | `POST /stop` → App `stopSelf()` 关隧道 |
| 2 | **到点自动停止** | 电脑侧定时器 + **App 侧也有自己的定时器**（双保险，电脑被杀也停） |
| 3 | 电脑进程退出 | `will-quit` 里先 `POST /stop` 再退出 |
| 4 | **电脑被强杀 / 拔线** | App 侧**控制通道心跳超时**（默认 15s 收不到请求）→ 自动停 VPN；且 VPN 进程一旦被杀，系统自动恢复网络 |

第 4 层是本方案相对旧代理方案最大的改进：**旧方案在最坏情况下会留下持久残留（设置里的代理），
新方案的最坏情况只是「VPN 还开着」，而 VPN 是易失的 —— 连进程一起被杀就自动恢复。**

另外还有一层兜底：电脑侧落一个**会话标记**（`weaknet-session.json`），
启动时若发现上次异常退出，直接 `POST /stop` 把设备上的 VPN 关掉（如果设备还在）。

## 7. 失败与降级

| 情况 | 处理 |
|---|---|
| 电脑没有 Android SDK / 构建不出 APK | 仓库**预置 APK**（`bin/weaknet/weaknet-vpn.apk`）。电脑侧只负责「装 + 用」。 |
| App 没装 | 电脑侧自动 `adb install -r`，装完用 `pm path` 复核（沿用本项目一贯的硬规矩） |
| 设备未授权且有交互需求 | 走 `/authorize`，UI 显示「等待设备授权」，并提供「重新弹出授权框」按钮 |
| 设备无 VPN 能力（极老 ROM） | 回退到旧代理方案（保留，不删） |
| `adb forward` 建不起来 | 报错并提示检查 USB；旧代理方案同样起不来 |

## 8. 界面（保留现有表现）

`WeakNetworkPage` 的布局、参数卡片、预设、时长、能力探测卡片**全部保留**，
只改三处：

1. 「实现方式」分段控件：`自动(VPN) / VPN / tc/netem / 本地代理` —— VPN 成为默认首选；
2. 主操作区新增 **VPN 授权状态卡**（未授权 / 已授权 / 等待设备确认），
   未授权时显示「在手机上点一次确定」的引导 + 重新弹框按钮；
3. 运行中信息从「设备流量 → 127.0.0.1:17890 → 电脑代理」改为
   「设备流量 → 本机 VPN（App 内整形）」，统计仍复用 `WeakNetStats` 结构。

## 9. 构建工具链（实测结论）

本机**没有** Android SDK / NDK / Gradle（`.gradle`、`.m2` 均不存在，`D:\AdbSDk`
里只有 platform-tools）。实测可访问 `dl.google.com` 与 `services.gradle.org`，
所以 APK 可以在配好环境的机器上构建，产出后预置到 `bin/weaknet/`。

**关于 gradle wrapper（踩过的坑，记下来免得重复）：**

生成 wrapper 需要 `gradle-wrapper.jar` 这个二进制文件。本机实测**所有能想到的
下载源都拿不到完整文件**：

| 源 | 结果 |
|---|---|
| `raw.githubusercontent.com`（HTTP 200） | 文件被**截断**（43453 字节，尾部是 `00000000` 而不是 ZIP 的 EOCD `PK\x05\x06`），解压必然 `ClassNotFoundException: GradleWrapperMain` |
| `raw.gitmirror.com` | `ENOTFOUND` |
| `ghproxy.net` | `ECONNRESET` |
| `cdn.jsdelivr.net` | `403` |
| `repo1.maven.org/.../gradle-wrapper-8.7.jar` | `404`（该坐标不存在） |

结论：**不提供 wrapper**。与其塞一个坏掉的 jar 让人以为 `gradlew` 能用，
不如直接要求构建机装 gradle 8.x —— 效果一样，也不会误导。
仓库里留了 `scripts/build-weaknet-apk.mjs`，逻辑是「有 wrapper 就用，没有就找
PATH 里的 gradle，都没有就给一条能照着做的提示」。

---

## 10. 取舍记录

- **不做**：在电脑侧用 `adb forward` + 电脑代理来实现 VPN（那还是代理方案，绕不开覆盖不全）。
- **不做**：要求设备 Root。
- **做**：保留旧代理实现作为回退，不删代码 —— 它覆盖「APK 装不上」的极端情况，
  且已验证过（`e2e-weaknet-proxy.cjs` 37/37）。新方案上线后它降级为兜底。
