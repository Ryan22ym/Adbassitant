# 弱网模拟 · VPN 配套 App

这个目录是**设备侧**的 Android 应用源码。它做一件事：用 Android `VpnService`
建一条 tun，把设备的全部 IPv4 流量在 **IP 层**逐包整形（延迟 / 带宽 / 丢包 /
错报 / 乱序 / 重复）。

电脑侧（Electron 主进程）通过 `adb forward` 用 HTTP 指挥它，见
`../../electron/services/weaknet-vpn.ts`。

---

## 为什么要有它

旧的弱网实现是「本地代理」：`adb reverse` + `settings put global http_proxy`。
它有三个绕不过去的缺陷：

| 问题 | 旧方案（本地代理） | 本方案（VPN） |
|---|---|---|
| **覆盖范围** | 只作用于「愿意读系统 HTTP 代理」的 App；走 QUIC / 自研网络库 / 纯 socket 的 App 直接绕过 | 全量接管 `0.0.0.0/0`，没有应用能绕开 |
| **设备权限** | 需要 `settings put global`（ColorOS 等 ROM 直接屏蔽 → 只能让用户手动去 WLAN 界面填代理） | 走系统 VPN 授权对话框，与 ROM 无关 |
| **参数保真度** | 字节流层只能做「队头阻塞」近似 —— 丢掉一段字节流等于篡改内容 | IP 层可以真丢包、真乱序，TCP 自己重传重排，观测到的就是真实弱网行为 |

唯一代价：**第一次使用需要在手机上点一次「确定」授权**。这是 Android 的硬性
安全设计（VPN 能看全部流量），没有任何自动化余地。

---

## 构建 APK

### 前置

- JDK 17
- Android SDK（`compileSdk 34`），或让 `local.properties` 指向 SDK 位置

#### 本机（开发机）的现成工具链

开发机上原本没有 Android SDK / NDK / Gradle。现在把一整套**装在仓库之外的独立目录**，
不污染系统环境、也不进 git：

```
D:\WorkSpace\android-toolchain\
  jdk-17.0.20.1+1\     Temurin JDK 17            （清华 Adoptium 镜像）
  gradle-8.7\          Gradle 发行版              （腾讯云 gradle 镜像）
  android-sdk\         platform-tools + platforms;android-34 + build-tools;34.0.0
  gradle-home\         Gradle 依赖缓存（独立，不动 ~/.gradle）
```

> 🔴 **路径必须纯 ASCII，所以它刻意放在工作区外面。**
> 本仓库路径含中文（`D:\WorkSpace\手机助手\`），AGP 默认会拒绝构建，
> 加 `-Pandroid.overridePathCheck=true` 可以绕过；但真正绕不过去的是 **aapt2** ——
> 它拿到非 ASCII 的 **SDK 路径**时会按非 UTF-8 处理，直接报「找不到 android.jar」。
> 所以项目路径可以带中文（override 掉），**SDK 路径绝对不行**。
> 曾经把它放在 `D:\WorkSpace\手机助手\.toolchain\`，构建就卡死在这里。
>
> 换路径的话改 `build-weaknet-apk.mjs` 的 `LOCAL_TC`，或设环境变量 `WEAKNET_TOOLCHAIN`。

一键构建（在仓库根目录）：

```bash
node scripts/build-weaknet-apk.mjs
# 产物：bin/weaknet-vpn.apk
```

> `build-weaknet-apk.mjs` 会**优先探测仓库外的工具链目录**并自动拼好
> `JAVA_HOME` / `ANDROID_HOME` / `GRADLE_USER_HOME` / `PATH`，所以在没配过 PATH 的机器上
> 也能直接跑；探测不到就退回原行为（用 PATH 里的 `gradle`），与以前完全一致。
> 它同时会自动带上 `-Pandroid.overridePathCheck=true`（本项目路径含中文，见上）。

> 整套工具链只是「下载 + 解压」，换机器照做一遍即可，**不需要装 Android Studio**：
> Gradle 8.7 ← `mirrors.cloud.tencent.com/gradle/`；
> JDK 17 ← `mirrors.tuna.tsinghua.edu.cn/Adoptium/17/jdk/x64/windows/`；
> cmdline-tools ← `mirrors.cloud.tencent.com/AndroidSDK/`，
> 然后 `sdkmanager --licenses` 接受许可，再装 `platform-tools` / `platforms;android-34` / `build-tools;34.0.0`。

当然，也可以在另一台有构建环境的机器上产出，产物同样放到 `bin/weaknet-vpn.apk`。

> ⚠️ 放 `bin/` 根下、**不要**建子目录：应用内增量更新不新建目录，
> 放进新子目录会让老版本（无 mkdir 的更新助手）永远升不上来。

### 命令

```bash
cd android
gradle :app:assembleRelease

# 产物
# app/build/outputs/apk/release/app-release.apk
```

> **注意：这个仓库里没有 gradle wrapper。**
> 生成 wrapper 需要 `gradle-wrapper.jar`（一个二进制文件），而本机可下载的
> 镜像都拿不到完整文件（GitHub raw 被截断、jsdelivr 403、ghproxy ECONNRESET）。
> 与其塞一个坏掉的 jar 让人以为 wrapper 能用，不如直接不提供 ——
> 用系统装的 gradle 8.x 即可，效果一样。
> 如果你的构建机有网络，可以自己补上：
> `gradle wrapper --gradle-version 8.7` 会自动生成 `gradlew` + `gradle/wrapper/`。

产出后复制到随包位置：

```bash
cp app/build/outputs/apk/release/app-release.apk ../bin/weaknet-vpn.apk
```

或者直接用封装好的脚本（在仓库根目录）：

```bash
node scripts/build-weaknet-apk.mjs
```

---

## 关于签名

`app/build.gradle.kts` 里 release 用的是 **debug 签名**。这是刻意为之：

- 这个 App 不进应用商店，只在开发/测试设备上通过 adb 安装
- 用 debug 签名可以让 `adb install -r` 稳定地覆盖升级（自建 keystore 也行，
  但要额外管一份密钥文件，收益为零）
- 副作用：如果设备上之前装过包名相同但签名不同的版本，会报
  `INSTALL_FAILED_UPDATE_INCOMPATIBLE`，需要先卸载。电脑侧已经识别这个错误
  并给出了明确提示。

---

## 控制协议

只监听 `127.0.0.1:18080`（外部网络访问不到）。选 18080 而不是旧代理方案的
17890，是为了两个方案共存时不撞车。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/ping` | 握手 + 版本核对 |
| POST | `/authorize` | 弹系统 VPN 授权框（异步，结果轮询 `/status`） |
| POST | `/start` | 下发参数并建隧道；未授权返回 `need_authorize` |
| POST | `/params` | 参数热更新（不重建隧道，避免闪断） |
| POST | `/stop` | **幂等**关闭隧道并恢复网络 |
| GET | `/status` | 隧道状态 + 授权态 + 实时统计 |

协议版本：`PROTOCOL_VERSION = 1`（`ControlServer.kt`）。
电脑侧会核对这个值，不一致时给明确提示而不是诡异失败。

⚠️ **方向别搞反**：电脑要主动访问设备，所以用 `adb forward`
（`forward` = 电脑端口 → 设备端口）。旧代理方案用的是 `adb reverse`，方向相反。

---

## 恢复网络：四层保障

弱网没关干净会让用户遇到「手机突然上不了网」，这是最难自查的问题，
所以不能只依赖「用户点停止」：

| 层 | 触发条件 | 动作 |
|---|---|---|
| ① 手动停止 | 用户点「立即恢复网络」 | `stopWeakNet()` 完整清理 |
| ② 双端定时器 | 达到设定时长 | 电脑侧 `setTimeout` + 设备侧 `watchdog` **各自独立**计时 |
| ③ 应用退出 | 工具正常退出 | `main.ts` 的 `will-quit` → `stopWeakNet()` |
| ④ 心跳超时自停 | 电脑进程被**强杀**（③ 来不及执行） | 设备侧 15s 收不到任何控制请求就自己关隧道 |

兜底：`WeakNetVpnService.shutdown()` 的第三步会关掉 tun fd —— 系统在此刻拆 VPN、
路由回到真实网卡。**即使 App 进程随后被杀，网络也已经好了。**

---

## 源码结构

```
app/src/main/java/com/xiaoyang/weaknetvpn/
├── App.kt                 进程启动即拉起 ControlHostService（解决授权鸡生蛋）
├── ControlHostService.kt  只开控制端口，不建隧道、不改网络
├── AuthorizeActivity.kt   只负责弹 VpnService.prepare() 授权框
├── ControlServer.kt       手写 HTTP 控制端口（只绑回环）
├── WeakNetVpnService.kt   核心：建 tun、转发、回写、看门狗、四层清理
├── TrafficShaper.kt       整形引擎：令牌桶 / 丢包 / 错报 / 乱序 / 延迟+抖动
└── Protocol.kt            数据模型 + JSON 编解码（字段与电脑侧 DTO 一一对应）
```

### 一个必须知道的限制

全量接管意味着**我们必须自己把包转发到真实网络**（tun2socks）。成熟做法是用
`hev-socks5-tunnel` 之类的 native so，但那需要 NDK，本机没有，无法构建。

所以这里是**纯 Kotlin 的精简实现**：

- TCP：每个流开一个真实 Socket，透传 payload（不做完整 TCP 状态机）
- UDP：每个流开一个 DatagramSocket，双向透传（主要覆盖 DNS）
- 只处理 IPv4 的 TCP/UDP；IPv6 与其他协议不接管
- 真实转发 socket 必须调 `protect()`，否则自己的流量又进隧道 → 无限递归

对弱网测试够用：「网络变差」由整形器负责，不靠转发层制造。
