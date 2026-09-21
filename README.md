# ADB 桌面助手 v1.0.21

一个用 **Electron + React + TypeScript** 重构的 Android 设备管理工具。
界面简洁、深色/浅色可切换，代码分层清晰，方便长期维护与迭代。

> **发版策略调整（v1.0.24 起）**
> - 打包**只出 NSIS 安装包**（`ADB桌面助手-vX-x64.exe`），**不再产出免安装便携包**；
> - 更新**只发安装版增量小包**（`ADB桌面助手-vX-patch.zip`，约 150–220 KB），
>   不再生成便携版整包（`ADB桌面助手-vX-portable-patch.zip`）；
> - `win-unpacked/` 仍是必需的中间产物（`make-update.py` 靠它取 `app.asar`），
>   它本身也是一份完整绿色版；`install-local.py` 在产物里找不到安装包时会自动退到绿色部署；
> - ⚠️ 已装历史便携版的用户：更新清单里没有 `packages.portable` 时客户端会提示
>   「该版本没有你这种形态的包，请下载完整安装包」—— 这是预期行为。
>   `update.ts` / `update-core.ts` 里对便携形态（整包换 exe）的兼容代码**保留不动**，
>   只是不再为新版本生成 portable 整包。
> - 若要临时恢复便携包（不建议）：`electron-builder.json` 的 `win.target` 加回 `"portable"`，
>   并把 `scripts/make-update.py` 里注释掉的便携整包段恢复。
>
> <details><summary>旧策略（v1.0.21 之后，已被上面取代）</summary>
>
> 打包只出免安装便携包（portable）+ 增量小包，不出 NSIS 安装包；`install-local.py` 双路：
> 有安装包走静默安装，只有 `win-unpacked/` 就走免安装绿色部署（整目录搬到
> `%LOCALAPPDATA%\Programs\ADBAssistant`）。
>
> </details>

> **v1.0.21 更新（future 分支，已装到本机）**
> - **修「签名配置被默认值吃掉」**（真 bug）：`store.installSigning` 的初始值写死
>   `{ mode: 'bundled-debug' }`，而主进程持久化的那份**只在 SigningPanel 挂载**
>   （= 打开「安装安装包」页 + 选中 AAB）时才同步进 store。
>   于是「把 AAB 拖到窗口直接装」这条最常用的路径永远拿初始值去装，
>   后端存的正式签名压根没机会生效 —— 现在改到 App 启动时同步（`src/App.tsx`）；
> - **安装结果里写明本次用的签名**：`InstallResult.signingDesc` 打通到结果弹窗，
>   用调试密钥库时显式警告「应用签名已被替换，三方登录 / 推送可能失效」。
>   以前这条只落在「运行日志」页（`aab.ts` 里早就有），用户根本看不到；
> - 实测踩坑：装完 AAB 后 Facebook 登录报 `Invalid key hash`，
>   设备签名位与 `bin/bundletool/debug.keystore` **完全一致**（`495ff4ce`），
>   据此确认是拆包换了签名 —— 换成正式签名重装后恢复（`2222c440`）。

> **v1.0.20 更新**
> - **新增「导出通用 APK」**：把 AAB 转成一个**能装进任何设备**的普通 `.apk`
>   （bundletool `build-apks --mode=universal`），可直接发给别人、或随手装到任意手机；
> - 这条路**完全不需要设备** —— universal 不按设备挑 split，不取 device-spec、不碰 adb，
>   手机没插也能批量转换（这正是它与「按设备拆包」最大的区别）；
> - 代价只有体积：全部 ABI 的 so、所有屏幕密度的资源都打进同一个包
>   （实测 202MB 的游戏 AAB → 205MB 通用 APK，耗时约 10s）；
> - 缓存键是 `<文件指纹>-universal-<签名tag>`，**不含设备 key** ——
>   同一份 AAB + 同一份签名只会产出一份通用产物；换签名仍然会重做；
> - `.apks` 只是中间产物：抠出 `universal.apk` 落盘后立即删除，不占两倍磁盘；
> - 新增验收 `npm run check:aab-universal`（38 项，**纯 Node、不需要设备**；
>   有模拟器在线时额外做一次真实安装验证，真机自动跳过、不动用户设备）；
> - 界面侧新增 `npm run check:aab-universal-ui`（安装版冒烟，**默认不碰设备**）；
> - 已打包 `out-v1.0.20/` 并静默安装到本机，校验 exe FileVersion=1.0.20、bin 16 文件 md5 全一致。

> **v1.0.19 更新**
> - **拆包与安装拆成两件事**：新增「仅拆包并另存为 .apks」——AAB 按目标设备拆一次，
>   产物导出到磁盘；之后直接拖这个 `.apks` 进来装，不再重复拆包（同一份大包省几十秒）；
> - **拖放区 / 文件选择器开始接受 `.apks`**（本工具拆出来的产物），
>   覆盖 / 清洁 / 全新三种安装方式与**装后复核**对它同样适用；
> - `.apks` 是「按设备挑好 split 的产物」，安装走 `install-apks` 而非自己解 zip：
>   `toc.pb` 是 protobuf，复刻它的挑包逻辑既贵又易过时；
> - 拆包时记下 `source.aab.txt`（源 AAB 路径）——`.apks` 里不含包名，
>   靠它反查才能做「装完按包名复核」这条硬规矩；
> - **装现成 `.apks` 绝不偷偷重拆**：否则用户会以为「装 .apks 比装 .aab 还慢」；
> - 验收扩到 **`check:aab-install` 78 项**（新增 E 段 30 项：仅拆包、缓存命中、另存、装现成产物、缓存外产物）。

> **v1.0.18 更新**
> - 「安装安装包」页新增**「签名方式」**：AAB 拆包时不再写死调试密钥库 ——
>   可指定应用自己的正式密钥库（路径 + 密码 + 别名），保住原签名；
> - 修掉由此引发的**三方登录 `Invalid key hash`**：Facebook / 微信 / QQ / Google 登录、
>   推送、地图 key 都按「包名 + 签名」校验，用调试 key 重签名会让它们全部失效；
> - 页面可**一键算出四个平台的 key hash**（Facebook / 微信 QQ / Google / SHA-256）直接粘后台；
> - 签名纳入**拆包缓存键**：换了签名不会复用旧产物（否则会「改了却没生效」）；
> - 新增验收 `npm run check:aab-signing`（32 项，含产物签名与设备实际签名的端到端交叉验证）。

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
| **安装 APK** | 选择本地 APK 安装，三种安装方式（**覆盖安装 -r 保留数据 / 清洁安装 先卸载清数据 / 全新安装 已存在则拒绝**）与自动授权；**支持把 APK 直接拖到程序窗口任意位置安装**，实时弹出进度（安装中 / 成功 / 失败），显示目标设备与包名，**装完按包名 `pm path` 复核**；**多台设备同时在线时，开装前一定先问「装到哪台」**（不猜、不取列表第一台），安装期间锁定不接受重复任务 |
| **文件传输** | 批量 push 到设备、批量 pull 到电脑 |
| **应用管理** 🆕 | 用户/系统/全部三态筛选 + 关键字搜索；详情（版本号/占用/安装时间/Activity 数/权限）；启动、强制停止、清除数据、提取 APK、启用停用、卸载；**常用应用收藏**（星标固定，跨设备/跨重启保留，一键启动） |
| **实时 Logcat** 🆕 | 流式抓取（120ms 批量推送 + 20000 行环形缓冲）；级别/TAG 通配/关键字/进程/缓冲区多路过滤；快捷过滤（只看错误 / 闪退 ANR / Activity 启动）；暂停刷新、一键保存 |
| **常用工具** 🆕 | 截图 / 录屏 / 分辨率 / Monkey / 安装安装包 / 文件传输 / **Logcat 导出**。Logcat 导出是**一次性 dump**（`adb logcat -d`，读完即退），把设备缓冲区里**已有**的日志按级别/TAG/关键字筛选后导成 txt；导出目录默认 `D:\adblogs\<机型 序列号>\<日期>\`，**不存在自动创建、导出后自动打开该目录**，可在面板上改根目录 |
| **弱网模拟** 🆕 | 对标 clumsy，上行/下行独立配置 7 个参数（带宽/延迟/抖动/丢包/错报/乱序/重复包）；**免 Root：本地代理 + `adb reverse`**（详见下方）；6 个内置档位 + 自定义预设持久化；持续时长与倒计时；设备能力探测（Root/tc/ifb/代理/写设置权限）；已 Root 可切 `tc/netem` 内核级 |
| **命令终端** | 执行任意 adb 命令，16 个常用命令快捷入口，↑/↓ 翻阅历史 |
| **运行日志** | 实时记录全部命令与结果，按级别筛选、关键字搜索、一键导出 txt |
| **软件更新** 🆕 | **应用内增量更新**：选一个小更新包（约 150 KB）→ 应用退出 → 外部助手替换 `app.asar` → 自动重启成新版；**新版启动异常（含白屏）自动回滚**；安装版走 asar 小包、便携版走整包换 exe；校验不过一律提示改用完整安装包（详见下方） |
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
  界面给出 4 步操作指引，并每秒轮询**全套代理键**（`settings list global` 里的 host/port 真身），
  用户填好后自动识别并开始注入；
  停止后会提示用户把代理改回「无」（同样因为该 ROM 不允许我们自动清除）。

**🔴 清代理必须「先 `put :0` 再清真身」—— 否则设备会彻底断网**

Android 8+ 的全局 HTTP 代理存在**两套键**里，读 / 判 / 清都必须同时覆盖：

| 键 | 角色 |
|---|---|
| `http_proxy` | 遗留别名，形如 `127.0.0.1:17890` |
| `global_http_proxy_host` / `..._port` / `..._exclusion_list` / `global_proxy_pac_url` | **系统实际读取的真身** |

工具写 `http_proxy` 后，系统会**立即同步出真身**（别名保持原值，两套键并存）。只认别名的代码两头都错：

- **清理**：`delete global http_proxy` → `Deleted 1 rows`，删掉的**只是别名**，真身留着，系统继续走代理；
- **检测**：别名已不在，读 `http_proxy` 得 null/`:0` → 判定「无残留」→ 直接 return，残留永远清不掉。

更隐蔽的第三层：**只 `delete` 也不够**。`ProxyTracker`（真正决定走不走代理的组件）只在
`http_proxy` 发生**变更**时才刷新；别名早就不存在时 delete 不产生任何通知（`Deleted 0 rows`），
于是「设置里查不到代理，内存里的旧代理却把**所有流量**（含系统的联网校验探针）继续送往已关闭的端口」。
实测：`put :0` 之前 45 秒抓到 11 条流向死端口的连接（含 `connectivitycheck.gstatic.com/generate_204`），
put 之后 0 条。**结果就是「ping 通、DNS 通，但所有 App 都上不了网」。**

正确顺序（`cleanupProxy()`，三步都不能省）：

1. `settings put global http_proxy :0` —— 触发变更通知刷新 ProxyTracker，**必须 put，不能只 delete**；
2. 删除真身四键 —— 顺序不能反，put 触发的同步会把 host/port 又写回来；
3. 撤 `adb reverse`，最后才关本地代理（反过来中间会有一小段设备把流量发向已关闭的端口）。

> 清理成功的判据**不能只看设置键** —— 只有「不再有流量打到该端口」才是决定性证据。
> 回归测试 `scripts/weaknet-proxy-cleanup-regression.cjs`（`npm run test:weaknet:cleanup`）
> 在真机上造出这个现场并锁死：PC 监听 17890 + `adb reverse` + 真实浏览器导航，
> 断言残留期有连接、清理后 0 连接。实测 **16/16 通过**。

启动前 `probeDevice()` 会实测这些能力（Root / tc / ifb / 接口 / SDK / 能否写设置），UI 如实展示。

---

### 增量更新说明（v1.0.7）

小更新不再重装整个安装包。体积账：全量安装包 **84.1 MB**，而本项目自己的代码
（`dist/` + `dist-electron/` + `package.json` 打成 `app.asar`）只有 **541 KB**，
压缩后约 **156 KB** —— 剩下的全是 Electron 运行时和 adb / scrcpy 二进制。

| | 包体 | 用户操作 |
| --- | --- | --- |
| 全量安装包 | 84.1 MB | 下载 → 双击 → 下一步 → 安装 → 手动启动 |
| 安装版增量 | ~156 KB zip | 应用内选包 → 「立即更新并重启」→ 自动重启成新版 |
| 便携版 | 整包换 exe（约 84 MB） | 同上，替换对象是那个单文件 exe（v1.0.24 起**不再发新整包**，只剩历史版本） |

**为什么必须用一个外部的 PowerShell 助手**

运行期间 `resources/app.asar` 被独占锁定（实测 `os.replace` → WinError 5、
`rename` → WinError 32），连「再起一个自己的实例来替换」都不行 —— 那个实例
同样会锁住 asar。所以只能交给系统自带的 PowerShell（不落地任何自制 exe，
避免被杀软拦）。脚本先落到暂存目录（带 UTF-8 BOM，见下方踩坑），再 `-File` 运行。
**但「谁来启动它」是有讲究的，见「🔴 更新助手必须由系统代建」那条。**
流程：

```
应用：prepareUpdate(zip)  解压到 %TEMP%\adba-update-<ts>\ → 逐项校验
     → applyUpdate()      停投屏/Logcat/弱网 + adb kill-server → 写 job.json
                          → cmd /c start 代建助手 → 等它落下第一行日志 → app.exit(0)
助手：等主进程退出 → 等目标文件解锁 → 备份 → 写 .new 再原子替换
     → 启动新版 → 轮询「健康标记」（最多 30 秒）
        ├─ 出现 → 成功（保留备份，界面出现「回滚到 vX」）
        └─ 没有 → 杀新版进程 → 还原备份 → 启动旧版 → 写 last-error
新版：渲染层就绪后发一次 IPC 握手 → 主进程落健康标记 → 读结果 → toast 提示
```

**「启动成功」的判据是渲染层握手，不是「主进程活着」** —— 否则主进程活着但
白屏（渲染层崩）会被判成成功，那正是最需要回滚的情况。

**校验规则**（任一条不满足 → 明确拒绝，提示改用完整安装包，绝不硬来）

`schema` · `productName` / `appId` · 目标版本必须更新 · Electron 版本一致 ·
`resources/bin` 指纹一致（`adb` / `scrcpy` 有变化就得走全量）· 每个文件的
SHA-256 与字节数 · 包形态与本机一致（安装版 ↔ 便携版不能混用）· 目标目录可写。

便携版整包是**完整替换**，自带运行时，所以不受 Electron / 运行库约束；
它换的是程序本体，因此改为读 exe 内嵌的 PE 版本资源做身份与版本校验
（`electron/services/pe-version.ts`，手写，不依赖 PowerShell 的本地化字符串）。

**产物**（`python scripts/build.py --out out-vX` 会自动追加这一步）

```
out-vX/update/ADB桌面助手-vX-patch.zip   安装版小包（manifest.json + app.asar [+ bin 差量]）
out-vX/update/latest.json                发布清单（在线更新源的唯一入口，make-manifest.py 生成）
out-vX/update/runtime-vX.json            本版运行库指纹，供下一版做差分基准
out-vX/update/*.sha256                   包自身摘要（供人工核对，客户端不读）
```

> v1.0.24 起**不再产出便携版整包**（`*-portable-patch.zip`），打包只出 NSIS 安装包。

**发布清单 `latest.json`** —— 在线更新走纯静态托管（`latest.json` + 各版本 zip，无后端）：

```bash
python scripts/make-manifest.py --out out-v1.0.24          # 生成（build.py 收尾已自动跑一次）
python scripts/make-manifest.py --out out-v1.0.24 --check  # 只复核现有清单与产物是否还对得上
```

算 `size`/`sha256`、从 `SettingsPage.tsx` 的 `VERSION_NOTES` 抠出更新说明、写完回读自检；
版本三方（清单 / 产物目录 / `package.json`）不一致会直接报错 —— 这一步以前是手抄 hash，
发版流程见 `docs/online-update-rollout.md`。

`runtime-vX.json` 就是「下一个小包的差分基准」：`bin` 里没变的文件不会进包。
所以同一版第一次生成的包会偏大（没有基准，只能全带），从第二版起才是纯增量。

运行期文件（`%APPDATA%\adb-assistant\update\`）：`pending.json`（更新在途）、
`health.ok`（握手标记）、`result.json`（助手结论）、`helper.log`（助手日志）、
`backup/<stamp>/`（上一次更新的备份，只保留最近一份）。

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

产物目录由 `electron-builder.json` 的 `directories.output` 决定。**默认只出 NSIS 安装包**
（`ADB桌面助手-vX-x64.exe`，`win.target` = `nsis`），`scripts/build.py` 收尾时
再追加产出 `update/` 下的**安装版增量小包**（见下文「应用内更新」）。

`win-unpacked/` 是打包的中间产物，它本身也是一份完整绿色版（整目录复制即可运行），
`make-update.py` 正是靠它取 `app.asar` 生成小包，所以**不能从 `files`/target 里去掉**。

不再产出便携包（v1.0.24 起）。确需临时恢复：`win.target` 加一项 `"portable"` ——
`electron-builder.json` 里的 `portable` 配置段一直保留着。

二进制文件通过 `extraResources` 打进 `resources/bin/`。

### 装到本机（发版后自测）

```bash
python scripts/build.py --out out-v1.0.24     # 打包（NSIS 安装包 + 增量小包）
python scripts/install-local.py --out out-v1.0.24
```

`install-local.py` 自己选路：产物里有 NSIS 安装包就走静默安装（`/S /D=` 那套坑都在脚本里，
**现在走的就是这条**），只有在产物里找不到安装包时才退到免安装绿色部署 —— 整目录搬到
`%LOCALAPPDATA%\Programs\ADBAssistant`。

绿色部署的两个要点：

1. **先整份复制到同级 `.tmp`，再把旧目录挪成 `.old`、`.tmp` 改名顶上，最后删 `.old`**。
   不往目标目录里逐个覆盖：中途失败会留下半新半旧的目录，而「旧文件没被删掉」
   正是「版本号对、代码是旧的」那种最脏状态的来源。
2. **脚本会先自己把在跑的进程结束掉**（温和→强制）。不结束必定「装完还是旧版本」：
   exe 与 `app.asar` 被占用，复制直接失败。

装完照旧核对三件事：exe 的 FileVersion、`resources/bin` 逐文件 md5、asar 里的当前版本号
与 VERSION_NOTES 是否含本版。绿色部署不含卸载器，桌面/开始菜单快捷方式
（`%LOCALAPPDATA%\Programs\ADBAssistant\ADB桌面助手.exe`）指向没变，继续有效。

> ⚠️ **绿色部署实测踩到的坑（已经修了，别改回去）**
>
> `rename(.tmp, dst)` 会**间歇性 `PermissionError(13)`**：刚复制出来的目录里，
> exe / dll 还被 Defender 实时扫描（或索引器）占着，目录不是独占状态。
> 危害在于「旧目录**已经**改名成 `.old`、新目录**还没**顶上」的那个瞬间会卡住 ——
> 若这里不写回滚，应用就直接从原位置消失（目录还在，只是名字变成 `.old`，
> 快捷方式、`%APPDATA%` 之外的引用全失效）。
>
> 首次实测正是如此：`ADBAssistant.old`（旧版，91 文件）与 `ADBAssistant.tmp`
> （新版，89 文件）并排躺着，`ADBAssistant` 不存在。
>
> 现在的做法：改名**重试 10 次 × 0.8s**；`try_rename(.tmp, dst)` 失败时
> **把 `.old` 改回 `dst`** 再抛异常，保证「原位置始终有一个能跑的应用」。
> 复制阶段失败则清掉 `.tmp`（不留残骸）。

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

⚠️ **别小看这条**：`app.asar` 一被锁住，那个输出目录就**再也 rebuild 不了**（连
`win-unpacked` 改名都报 `ERROR_ACCESS_DENIED(5)`）。此时目录里如果还躺着**上一轮的
安装包**，就是最脏的状态 —— 名字对、内容是旧代码。**不要往里面再打包，也不要拿它发版**：
换个 `--out`（或顺手把版本号 +1，让新目录名天然区分开），重启后再删旧目录。

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

#### 但 `--until` 的判据是「体积变化」，不是「变大」

脚本常在一开始 `fs.writeFileSync(LOG, '')` 清空自己的日志 —— 此时体积**变小**。
早期用「体积变大」判断，遇到清空就永远等不到「变化」，每个脚本都白等到超时强杀（返回 124）。
现在用 `!=` 比较，并要求 `start < 0 || size < start` 时从 0 读。

#### 脚本自己的开关写在后面即可，但**绝不要**给脚本参数用 `REMAINDER`

`run-electron.py` 用 `parse_known_args()`：认识的留下，不认识的透传给脚本。
所以下面两种写法都能工作：

```bash
python scripts/run-electron.py scripts/check-aab-ui.cjs \
    --watch ui-shots/_aab-ui.log --until "AAB UI CHECK DONE" --timeout 600
python scripts/run-electron.py scripts/check-aab-ui.cjs \
    --watch ui-shots/_aab-ui.log --until "AAB UI CHECK DONE" -- --installed
```

**曾经的错误修法是给脚本参数声明 `nargs=argparse.REMAINDER`。** 这个坑极隐蔽：
`REMAINDER` 会把命令里它之后的**一切**都收走，包括本工具自己的
`--watch` / `--until` / `--timeout`。后果不是报错，而是：

> 脚本照常启动、照常把结果写进日志，但本工具**没在监视那个日志**，
> 于是永远等不到完成标记 → 干等到默认 240s 超时强杀（exit 124）。

日志里明明写着 `43 通过 / 2 失败` / `DRAG INSTALL CHECK DONE`，
命令却报「兜底超时 240s，已强杀」——**看起来像功能挂了，其实是参数没传进去**。
用 `--timeout 900` 也救不了，那个 `900` 同样会被吞掉。

#### 安装版分支需要 WebSocket 垫片

`--installed` 的检查跑在 **Electron 主进程**里，而 Electron 33 内置的是 Node 20，
**没有全局 `WebSocket`**（Node 22 才有，但那是跑 runner 的那个 node）。
CDP 客户端用标准 `WebSocket` 接口，于是直接抛 `WebSocket is not defined`，
表现为「0 通过 / 1 失败」——同样是脚手架缺件伪装成功能失败。

解法：`scripts/_ws-shim.cjs` 里手写了一个 RFC 6455 客户端侧最小实现
（`net.Socket` + 自己握手 + `Sec-WebSocket-Accept` 校验 + 掩码帧 + 分片 + ping/pong），
两个脚本在 `INSTALLED` 分支开头 `require('./_ws-shim.cjs').install()` 即可。
只在缺失时挂载，不会覆盖 Node 22 的原生实现。

另外 `Page.captureScreenshot` 默认 `fromSurface: true`，安装版窗口若在后台/未被合成
会一直等不到帧而超时 → 截图统一带 `fromSurface: false`，窗口不在前台也能出图。

### ⚠️ Electron 32+ 拖放拿不到文件路径：`File.path` 已被移除

`electron` 升到 32 之后，非标准的 `File.path` **被删掉了**，原本「拖进来一个文件 →
读 `file.path` → 扔给 adb」的写法会拿到 `undefined`，表现为拖放没反应或报
「文件不存在：undefined」。

官方替代品是 `webUtils.getPathForFile(file)`，**必须在 preload 里转发**——
`webUtils` 只在 Electron 的原生侧可用，渲染进程直接 `require('electron')` 拿不到：

```ts
// electron/preload.ts
import { contextBridge, ipcRenderer, webUtils } from 'electron';

getPathForFile: (file: File) => {
  try { return webUtils.getPathForFile(file) || ''; } catch { return ''; }
},
```

两个容易踩的点：
- 返回**空串**说明这个 `File` 不是来自磁盘（比如从压缩包里直接拖出来的虚拟文件），
  一定要当成「不可用」处理，而不是当成文件名用；
- 拖放到窗口上的 `dragenter` / `dragover` / `drop` 都必须 `preventDefault()`，
  否则 Chromium 会把拖进来的文件当成导航，**整个界面被那个文件顶掉**。

### ⚠️ 拖放区不要做在投屏窗口上

投屏画面是 `scrcpy.exe` 自己的原生窗口（SDL2），不是我们的 `BrowserWindow`，
**没有任何办法往里注入 UI**。所以「拖放 + 进度弹窗」只能做在本程序窗口上；
拖到投屏窗口仍然是 scrcpy 自己的拖放功能（APK 自动安装、其他文件存 Download），
但不会、也不可能有我们这边的弹窗。做需求前先确认拖放目标是哪一个。

### 假 APK / adb 失败输出会污染验收脚本的 PASS/FAIL 判定

`scripts/check-drag-install.cjs` 会故意用假 APK 走失败分支，adb 的报错里带
`Failure [INSTALL_PARSE_FAILED_...]`。而 `run-electron.py` 是按「日志里有没有
`FAIL` / `ERROR`」判成败的 —— 原始报错直接落盘会让**整个验收假失败**。
脚本里统一用 `safe()` 把外部输出打码（`FAIL`→`F*IL`）后再写日志。
新增验收脚本时只要会打印 adb / 异常原始输出，都要做同样的处理。

### ⚠️ 安装版专项检查要先清残留进程（单实例锁）

`--installed` 系列脚本（`check-drag-install.cjs` / `check-quick-mirror.cjs` /
`check-about.cjs`）会 `spawn` 安装目录的 exe 再连 CDP。而主进程有
`app.requestSingleInstanceLock()` —— **已经有实例在跑时，新起的那个会立刻退出**，
表现为「安装版未能在预期时间内开出调试端点」（白等 45 秒）。

跑之前一律先 `python scripts/_kill-our-processes.py`。
（另外这些脚本自己会 `delete env.ELECTRON_RUN_AS_NODE`，否则 Electron 退化成纯 Node。）

### ⚠️「adb 报 Success」不等于装上了：必须装后复核 + 目标设备定死

用户报过「界面显示安装成功、日志里 adb 命令也跑了，但手机上找不到应用」。查下来
**不是 `-r` 的问题**（实测 `-r` 装全新包完全正常），而是两个工程缺口：

1. **目标设备没定死**。`ensureDevice(serial)` 在 serial 为空时取的是「在线列表第一台」；
   三台设备同时在线（真机 + 两个模拟器）时等于随机挑一台，界面照样报「安装成功」，
   用户在自己手机上自然找不到。→ 安装路径上只认界面选中的那台，**serial 缺失且多台在线直接拒绝**；
   并且把「装到哪台」写进日志、页面和弹窗。
2. **装完不复核**。`adb install` 返回 `Success` 只代表设备端安装会话提交了，
   多用户 / 系统分身（装到了别的 user）、存储或权限受限、厂商安全策略拦截都可能
   「Success 但设备上没有这个包」。→ 装完必须 `pm path <包名>` 复核，
   查不到就判失败并把原因摊开写出来。

成本是要拿到**包名**：`pm path` 和「清洁安装」的 `uninstall` 都要按包名来，而
platform-tools 不带 aapt。所以有了 `electron/services/apk.ts` —— 手写的 ZIP + AXML 解析，
只读 APK 里的 `AndroidManifest.xml` 拿 package / versionName / versionCode。

### ⚠️ 手写 AXML 解析的两个必踩坑

自己解析二进制 `AndroidManifest.xml` 时，有两处极容易写错，而且症状都很隐蔽：

- **字符串池的字节序不固定**。同一个 flag（非 UTF-8 = UTF-16）下，aapt1 产的 manifest
  是 **UTF-16BE**，aapt2 有出小端的。按固定 `toString('utf16le')` 解，`t`(0x0074) 会变成
  U+7400 这种汉字区乱码 —— 属性名全错，但**解析过程不报任何错**，只是最后 `package` 匹配不上，
  表现为「读不出包名」。解法：两条字节序都试，按 **ASCII 可读字符数**投票
  （manifest 里的标签名/属性名/包名基本全是 ASCII，选错字节序 ASCII 计数会直接掉到 0）。
- **属性数组的起点是 `attrExt + attributeStart`**。StartElement 的布局是
  `chunk头 8B | lineNumber 4B | comment 4B | ← attrExt 在这里`，attrExt 内部才是
  `ns(4) name(4) attributeStart(2) attributeSize(2) attributeCount(2)…`。
  少加这 8 字节就会读到 `attributeCount` 上去，属性名整体错位，同样**不报错**。

`npm run check:apk-parse` 就是钉这两个坑：包名与版本号必须和设备端 `dumpsys package` 对上。

### ⚠️ AAB 不能直接装，且它的 manifest 不是 AXML

`.aab`（Android App Bundle）是**给应用商店用的原料**，不是安装包：里面的模块未签名，
R 资源与 dex 都还没拆包，`adb install` 根本不认。唯一官方路线是 Google 的 bundletool：

```
bundletool build-apks    --bundle=x.aab --output=x.apks  →  按目标设备拆成一堆 APK
bundletool install-apks  --apks=x.apks                   →  内部用 adb install-multiple
```

踩到的四个坑（都在 `electron/services/aab.ts` / `apk.ts` 里留了注释）：

- **AAB 的 `base/manifest/AndroidManifest.xml` 是 protobuf，不是 AXML**。既有解析器直接
  报「读不出 AndroidManifest.xml」。protobuf 里字符串是明文，但**值后面紧跟着下一个字段号
  字节**（`\x12\x0bversionName\x1a\x042.80(\x9c\x84\x84\x08` —— `2.80` 后的 `(` 是 0x28，
  也是可打印 ASCII），按引号切段会把 `2.80(` 当成整体。必须用**长度前缀 `0x1a <len> <value>`**
  精确切值，且只接受全可打印 ASCII 的结果。`parseAabManifestProto()` 在 15 份真实 AAB 上 15/15 正确。
- **bundletool 只在找得到 `~/.android/debug.keystore` 时才签名**，否则照常产出、
  只打一行 `WARNING: The APKs won't be signed and thus not installable`，到安装阶段才被拒。
  → 必须自带密钥库并显式 `--ks/--ks-pass/--key-pass/--ks-key-alias`（`bin/bundletool/debug.keystore`，
  `bin/` 已被 electron-builder 的 `extraResources` 映射到 `resources/bin/`，自动随包）。
- **`--device-id` 必须配 `--connected-device`，而那条路要求 bundletool 自己找得到 adb**
  （找不到就 `Unable to find the requested device.`）。正解是拆成两步：
  `get-device-spec --adb=<我们的 adb> --device-id=<serial>` 落一个 JSON，
  再 `build-apks --device-spec=<该 JSON>` —— 设备归属完全由我们决定，build 阶段不再碰 adb。
  `install-apks` 则**支持** `--adb`，直接指到随包的 adb。
- **`--adb` 只属于 `install-apks` 和 `get-device-spec`，`build-apks` 传它会报
  `Unrecognized flags: --adb`**；`install-apks` 也**不支持 `-r`**（覆盖本来就是默认语义）。

另外两条沿用 APK 的硬规矩：多台在线时**绝不猜目标设备**（先问装到哪台），
以及装完必须 `pm path <包名>` 复核（AAB 装出来是 split 多包，`pm path` 会返回多行）。

### ⚠️ 「按设备拆包」的缓存不能让安装方式判断短路

AAB 的 `.apks` 产物按「文件指纹 + 目标设备」缓存在临时目录，第二次装同一台设备直接复用。
但 `fresh`（已有则拒绝）与 `clean`（先卸载）是**设备侧**的判断，跟有没有拆包缓存无关 ——
第一版把它们写在了 `else`（未命中缓存）分支里，于是「第二次装同一台设备」会命中缓存、
跳过这两个判断，行为跟第一次不一致（`fresh` 该拦的没拦）。

规则：**缓存只能跳过纯计算的部分，任何跟设备当前状态有关的判断都必须每次执行。**
`scripts/check-aab-install.cjs` 里专门有一条「fresh 模式对已装应用中止（缓存命中时也拦）」。

### 🔴 AAB 拆包必须重新签名 —— 换掉签名 = 三方登录全废（Invalid key hash）

**症状**：用本工具装完 AAB，应用能装能跑，但**用 Facebook（或微信 / QQ / Google）登录报
`Invalid key hash`**，报错里给出一串 base64；后台配的 hash 全都对，就是登不上。

**根因**：`.aab` 是给应用商店的「原料」，**本身不含签名**。`bundletool build-apks` 把它拆成
一组 APK 时必须产出一个签名（否则 `install-multiple` 会被系统以「没有证书」拒掉；
而且 bundletool 在找不到 keystore 时**只打一行 WARNING、静默产出未签名 APK**）。
第一版固定用随包的 `debug.keystore`，于是：

- 应用能装、能跑、看起来一切正常；
- 但**签名被换成了调试 key**，凡是按「包名 + 签名」校验的能力全部失效 ——
  三方登录（Facebook / 微信 / QQ / Google）、推送（FCM / 厂商通道）、地图 key …

用 `base64` 反解报错里的那串值就能确认：它对应的是 `debug.keystore` 的 SHA-1，而不是应用正式签名的。
**只要报错里的 hash 不是应用正式签名的 hash，问题就一定出在签名上，跟网络、SDK 版本都无关。**

**修法（v1.0.18）**：`electron/services/aab-signing.ts` 把签名做成可配置，「安装安装包」页
多了一个**「签名方式」**面板：

| 模式 | 行为 | 什么时候用 |
| --- | --- | --- |
| `bundled-debug`（默认） | 用随包 `bin/bundletool/debug.keystore`（回退 `~/.android/debug.keystore`） | 只求装上跑起来，不在乎三方能力 |
| `custom` | 用**你自己的** `.jks` / `.keystore`（路径 + 库密码 + 别名 + key 密码） | 要保持原签名、要让三方登录能用 |
| `none` | 不传签名参数 | 调试用，产出的 APK 装不上，界面会警告 |

选 `custom` 后点「应用并测试」会当场跑一次 keytool 校验；下方「查看 key hash」会直接算出
四个平台的 hash 供粘贴到三方后台：

- **Facebook** = `base64(sha1(cert) 原始字节)`（就是这个报错要的值）
- **微信 / QQ** = `md5(cert DER)` 小写无冒号
- **Google** = `sha1` 大写带冒号
- 另附 **SHA-256**

**四条硬规矩**（踩过的坑，改这块务必保留）：

1. **签名必须参与拆包缓存键**。缓存目录是 `<指纹>-<设备key>-<签名tag>`，
   否则「换了签名还吃旧 apks 产物」= 白改，用户会以为「我换了签名怎么还不行」。
2. **keytool 是 JDK 独有，JRE 没有**；`findJava()` 在 PATH 命中时返回的是**裸名**
   （`java.exe`），`dirname('java.exe') === '.'`，拼不出 keytool —— 必须四路候选
   （java 同目录 / `JAVA_HOME/bin` / PATH / 扫常见安装位置含 Android Studio 的 `jbr`）。
3. **keytool 在中文 Windows 按 GBK 输出**，Node 按 utf8 解会乱码，连「别名:」都认不出来
   → 所有调用必须加 `-J-Dfile.encoding=UTF-8`。
4. **spawn ENOENT 的错误文案自带程序名**（`spawn keytool.exe ENOENT`），
   任何「输出含 keytool 就算成功」的宽松判定都会把没找到的程序误判为可用
   → 判据必须是 `r.code >= 0 && /Key and Certificate|密钥和证书/.test(text)`。

验收：`npm run check:aab-signing`（32 项，含「★产物签名指纹 == 用户所选密钥库」与
「★设备上实际生效的签名 == 用户所选密钥库」两条端到端；后一条靠 `adb pull` 回 APK 读指纹，
不信任本地产物）。样本用的是 `~/Downloads/AdbTools/pokercity.keystore`。

### ⚠️ 拆包与安装要分开：`.apks` 是「按设备挑好 split 的产物」

**为什么拆**：拆包（`build-apks`）吃的是「AAB + 一台设备的规格」，产出 `.apks`；
安装（`install-apks`）吃的是「`.apks` + 一台在线设备」。第一版把两步绑死在
`installBundle()` 里，于是每换一台设备、每重装一次都要**再跑一遍几十秒的拆包**
（缓存只省掉了 build，省不掉整个调用流程）。v1.0.19 拆成：

```
convertBundle()  →  AAB → .apks（可以不装，直接另存）
installBundle()  →  调 convertBundle 拿产物，再 install-apks
```

**四条硬规矩**：

1. **装现成的 `.apks` 绝不偷偷重拆**。`installApksFile()` 只做
   `install-apks --apks=<现成文件>`，不碰 `build-apks`。
   一旦「装不上就重新拆一遍」，用户会以为装 `.apks` 比装 `.aab` 还慢，
   整个功能的立意就没了。验证办法：断言输出里没有 `build-apks` / `device-spec` 字样
   （`check-aab-install.cjs` 的 E4）。
2. **`.apks` 里没有包名**。`toc.pb` 是 protobuf，为它引一个解析器不划算 ——
   但「装完按包名 `pm path` 复核」是本项目对 APK/AAB 一贯的硬规矩。
   解法：拆包时往产物目录写一份 `source.aab.txt`（源 AAB 绝对路径），
   装现成产物时靠它反查包名。老缓存没这个文件 → 退化为「不复核 + 打 warn」，不会装不上。
3. **不用自己解 `.apks` 里的 zip**。`.apks` 是 zip（内含 `splits/*.apk` + `toc.pb`），
   理论上可以自己解出 split 再 `adb install-multiple`，但那要求复刻 bundletool 的
   「挑哪些 split / 什么顺序 / 何时用 `install-multi-package`」逻辑，成本高且易过时。
   **只装本工具自己产的 `.apks`** 时没有任何理由放弃 `install-apks`
   —— 这条约束由缓存目录命名（含文件指纹 + 设备 key）天然保证。
4. **另存产物要先写 `.part` 再改名**。中途失败不会在用户目录里留一个看起来正常的半截包；
   验收里有一条专门断言不留 `.part`（E3）。

**验收**：`npm run check:aab-install` 已扩到 **78 项**，新增 E 段 30 项覆盖
「仅拆包 / 命中缓存不重拆 / 另存 / 装现成产物 / 缓存外产物 / fresh·clean 语义」。

### 🔴 「按设备拆包」之外还有一条路：通用 APK（universal）

**问题**：`.apks` 是**按目标设备挑好 split** 的产物 —— 换个 ABI / 屏幕的机器未必合适，
更没法直接发给别人（微信发过去是个装不上的 `.apks`）。
而「把手上的 AAB 转成能分发的 APK」是个高频真实需求。

**做法**：多开一条 `buildUniversalApk()`，走 bundletool 的 `--mode=universal`：

```
build-apks --bundle=x.aab --output=universal.apks --mode=universal <签名参数>
        ↓   （.apks 本身就是 zip，从里面取出 universal.apk）
universal.apk   ← 含全部 ABI / 屏幕资源的单文件 APK，任何设备都能装
```

**四条硬规矩**：

1. **这条路不碰设备**。universal 与设备配置无关，不取 `device-spec`、不调 `adb` ——
   手机没插也能跑。这不是巧合而是设计目标，所以验收里有一条**静态守卫**（B15）：
   直接扫 dist 里 `buildUniversalApk` 的函数体，出现 `device-spec` 或 `runAdb(` 就判 FAIL，
   防止以后有人「顺手」把设备逻辑加回来。
2. **缓存键里不能有设备**。目录名是 `<文件指纹>-universal-<签名tag>`，
   对比按设备拆包的 `<指纹>-<设备key>-<签名tag>`。加了设备 key 等于同一个文件在缓存里存好几份。
   但**签名标签必须留在键里** —— 否则换签名会吃到旧产物，等于把一个签名不对的包发出去（E1）。
3. **`.apks` 只是中间产物**。抠出 `universal.apk` 后立刻删掉 `universal.apks`：
   universal 模式下它几乎是未压缩的同一份数据，留着就是占两倍磁盘（B13 断言）。
4. **产物落盘前先验 ZIP 魔数**（`PK`）。`.apks` 里解出来的东西有可能是空壳，
   宁可在这里报错，也不要往用户目录里写一个「看起来正常」的文件。

**代价只有体积**：全部 ABI 的 so、每种屏幕密度的资源都在同一个包里 ——
实测 202MB 的游戏 AAB 产出 205MB 通用 APK（按设备拆通常只有几十 MB）。
所以界面上两个出口并存：**装自己的机器用「仅拆包并另存为 .apks」，要分发给别人用「导出通用 APK」**。

**验收**：`npm run check:aab-universal`（38 项，纯 Node，**不需要设备**）——
其中 G 段只在有**模拟器**在线时才做真实安装验证，真机自动跳过（不往用户手机里装东西）。
界面侧另有 `npm run check:aab-universal-ui`（安装版冒烟，默认不碰设备，见下一条坑）。

### 🔴 界面验收别「拖文件进去」—— 拖放区的 onDrop 就是安装

写「导出通用 APK」的安装版冒烟时踩到：以为「把文件拖到拖放区」只是**选中**，
就用合成的 `DataTransfer` + drop 事件去触发 AAB 分支，结果**真把 200 MB 的 AAB 装进了在线的那台真机**。

原因是 `ToolsPage` 里拖放区（`.apk-drop`）的 `onDrop` 直接调 `handleDroppedFiles` —— 它就是
**「拖入即安装」**，页面上根本不存在「拖进来只选中」这条路（真正只选中的入口只有 `onClick`
→ 原生文件对话框，脚本点不了）。而且合成事件是 `bubbles: true`，落点在哪都会冒泡到整窗处理器。

所以 `scripts/check-aab-universal-ui.cjs` 默认只做**不需要选中文件**的断言
（启动 / tab / 拖放区在不在 / 关于页版本与文案 / asar 痕迹 / 渲染层无 error）；
真要验证「选中 AAB → 按钮出现」必须显式加 `--with-drop`，
那时脚本会先确认**在线设备全是 `emulator-*`**，否则整段跳过。

自查手段：合成的拖放若没被拦住，界面上会弹出「正在安装 AAB…」遮罩 —— 看到它就已经开局装了。

### 🔴 怎么确认设备上某个包「是谁签的」（排查 Invalid key hash 用）

AAB 装了之后三方登录报 `Invalid key hash`，报错值只告诉你**当前签名是什么**，
不告诉你**它属于哪个密钥库**。定位就三步，本次实测很有效：

1. **报错里的 key hash = `base64(sha1(证书 DER))`**，而且最后一个有效字符的
   base64 索引**必是 4 的倍数**（SHA-1 是 20 字节：160 bit = 26×6 + 4）。
   截图里看着像小写 `l`（索引 37，非法）的，实际一定是大写 `I`（索引 8）—— 别读错。
2. **设备侧签名**：`adb shell dumpsys package <pkg>` 的 `signatures:[xxxxxxxx]`
   是 **`java.util.Arrays.hashCode(证书 DER)`** 的 hex，**不是 sha1**。
   我第一次拿 `Arrays.hashCode(sha1(cert))` 去比，怎么都对不上，白折腾一轮。
3. 把候选密钥库用 `keytool -exportcert -rfc -alias <a> -keystore <k> -storepass <p>`
   导出证书，**两种哈希各算一份**去比：对上哪个就知道设备上装的是谁签的。

实测结论表（可直接照抄成脚本）：

| 密钥库 | `Arrays.hashCode(证书DER)` | `base64(sha1(证书DER))` |
|---|---|---|
| `bin/bundletool/debug.keystore`（随包调试） | `495ff4ce` | `MsICged1jJf2MonQc6ENZ01j6uI=` |
| 小杨的正式签名 `pokercity.keystore` | `2222c440` | `BdD65U92Qj5jqpTQPwn9SD4uON0=` |

顺带一条：**换签名必须卸载重装**（签名不同的包不能覆盖，`adb install` 会失败），
卸载会清掉应用数据 —— 所以「重装成正式签名」前要先跟用户确认。

### 🔴 签名配置为什么会被「默认值」吃掉

`src/lib/install.ts` 里是 `const signing = options.signing ?? st.installSigning`，
而 `store.installSigning` 的初始值写死成 `{ mode: 'bundled-debug' }`，
真正持久化的那份（`%APPDATA%\adb-assistant\aab-signing.json`）**只在
`SigningPanel` 挂载时才同步**——而那个面板要「打开安装页 + 选中 AAB」才出现。
于是「把包拖到窗口直接装」永远用初始值，后端配置形同虚设。
已改为在 `App.tsx` 启动时同步；AAB 安装结果里也会写明本次用的签名。
**教训**：凡是有「持久化配置」+「只在某个组件挂载时才读」的写法，都要问一句
「有没有别的入口绕过了这个组件」。

### ⚠️ `adb install` 不带 `-r` 也会覆盖已装应用

老资料说「`adb install` 遇到已装包会报 `INSTALL_FAILED_ALREADY_EXISTS`，要覆盖得加 `-r`」——
**在 Android 12 上实测不成立**：不带 `-r` 照样把已装应用覆盖掉了（日志里 `Success`，
包正常更新）。所以「全新安装（已存在则拒绝）」这种语义**不能靠省略 `-r` 实现**，
必须自己先 `pm path <包名>` 判一次再决定要不要往下走。

### ⚠️ 多台设备在线时，「默认设备」是这一类 bug 的总根子

v1.0.5 加了「装后复核 + 目标设备写进界面」之后，同一个报障又复现了一次：
界面显示安装成功、复核也通过，**手机上还是没有**。原因不在安装，在**选设备**：

```ts
// 反例：启动时自动选「列表第一台」
if (!currentSerial || !online.some((d) => d.serial === currentSerial)) {
  next = online[0]?.serial;   // ← 就是这里
}
```

- 列表顺序就是 `adb devices -l` 的返回顺序，**模拟器常年在线、常常排在前面**；
- `currentSerial` 一旦有值就**一直沿用**（只有掉线才重选），于是「某次点过模拟器」
  或「启动时只有模拟器在线」会把这个选择永久钉住；
- 之后每次拖包都装到模拟器，界面一切正常 —— 而且**装后复核照样通过**，
  因为包真的装上了，只是不在你要的那台机器上。

判别这类问题不要看界面，看**设备端的最近安装时间**，一眼就能定位：

```bash
adb -s <serial> shell dumpsys package <包名> | findstr lastUpdateTime
```

三条改法（缺一不可）：

1. 自动选择时**优先物理设备**：`online.find((d) => !d.isEmulator) ?? online[0]`；
2. **多台在线就不猜**：把安装请求挂到 `pendingInstall`，弹一屏「装到哪台设备？」，
   把 `手机 / 模拟器` 标签放在设备名前面，物理设备排第一行，点哪台装哪台；
3. 选择结果**写回当前设备**（`setCurrentSerial`），让页面、日志、其他工具页一致。

> 「装到别的设备」是复核机制天然抓不到的失败模式，所以**必须靠交互消除**，
> 不能靠事后校验。单设备在线时不打扰用户，直接装。

### ⚠️ `isEmulator` 只看 `model` 会把模拟器判成手机

同一类问题的另一半：判断「这是不是模拟器」时，**不能只查 `model`**。
常见模拟器（雷电 / MuMu / AOSP 定制镜像）会把型号伪装成真机名 ——
我们的两个模拟器分别报 `PGT_AN00`（HONOR）和 `SM_S9210`（三星），
于是 `isEmulator` 判成 `false`，界面上「手机 / 模拟器」标签全错、
按 `isEmulator` 做的「优先物理设备」决策直接失效。

```ts
// 反例：model 有值时就不会去看 serial
isEmulator: /emulator|sdk_gphone|vbox/i.test(props['model'] || serial)
```

- **serial 前缀才是硬判据**：AOSP 模拟器固定叫 `emulator-xxxx`，
  先判 `^emulator-`，再用 model / product / device 做补充匹配。
- 还有一条隐蔽处：同一个 `isEmulator` 在 `listDevices()`（只读 `adb devices -l`）
  和 `getDeviceProps()`（读 `getprop`）里各算了一遍。深查时后者会
  `Object.assign` 覆盖前者 —— 两条路径判据不一致时，「先列一次再补详情」
  就会出现前后矛盾的结论。所以两处都收敛到同一个 `looksLikeEmulator()`。

`npm run check:device-order` 钉这两条：浅查 / 深查的判定都要与
「serial 是否以 `emulator-` 开头」一致，且两条路径结果必须相同。

---

### 🔴 Electron 把「叫 `*.asar` 的普通文件」当成 asar 容器，写它会抛 `Invalid package`

增量更新要把小包解压到 `%TEMP%\adba-update-<ts>\`，里面必然有一个文件叫
**`app.asar`** —— 于是**只有在真 Electron 里才炸**：

```
解压更新包失败：Invalid package C:\Users\…\Temp\adba-update-1789552702468\app.asar
```

Electron 的 asar fs shim 判断「这是不是一个 asar 容器」**只看 basename 是不是以
`.asar` 结尾**（**大小写不敏感**），是就不当普通文件，转去开归档 → 文件还不存在 /
不是归档，抛 `Invalid package`。

本机探针 `scripts/_probe-asar-write.cjs`（Electron 33.4.11）实测：

| 操作 | 结果 |
|---|---|
| `writeFileSync` → `a.bin` | ✅ |
| `writeFileSync` → `app.asar` | ❌ `Invalid package` |
| `openSync` + `writeSync` → `fd.asar` | ❌ `Invalid package`（**fd 层也被拦，换 API 没用**） |
| `writeFileSync` → `upper.ASAR` | ❌ `Invalid package`（大小写不敏感） |
| `writeFileSync` → `payload.asar.new` / `x.asar.txt` | ✅（只看结尾） |
| 目录名带 `.asar`，往里写普通文件 | ✅ |

**为什么特别阴**：纯 Node 下**完全没有这个 shim**。所以 `check-update.cjs` 的
A/B/C 段（普通 Node 跑）**全绿**，一到真安装版就必炸 —— 这也是为什么
`check-update.cjs --installed` 和 e2e 不能省。

**对策**：**逻辑名不动，只改暂存时的物理文件名**。

```ts
// electron/services/update-core.ts
export const STAGE_ASAR_SFX = '.__asar';
export function stageRel(logical: string): string {      // app.asar → app.asar.__asar
  const segs = logical.split('/');
  const i = segs.length - 1;
  if (/\.asar$/i.test(segs[i])) segs[i] = segs[i] + STAGE_ASAR_SFX;
  return segs.join('/');
}
```

`manifest.files[].path`、写进 `job.json` 的目标路径、交给 PowerShell 助手替换的
`resources\app.asar` 全部保持原名（助手是 PowerShell，没有这个 shim）；
只有 `extractZip(..., mapRel)` 落盘那一下改名。

`npm run check:asar-stage` 专门钉这条：**在真 Electron 里**把真实小包解压到临时目录，
断言「解压不抛错 + 暂存目录里没有任何以 `.asar` 结尾的路径 + 内容 sha256 与 manifest 逐项一致」，
开头还有一个自证探针（确认当前运行时确实有 shim），避免误用 node 跑出「假 PASS」。5 秒出结果。

---

### 🔴 更新助手必须由系统「代建」，不能直接 spawn —— 它在应用的作业对象里，会被连坐杀掉

**症状**：点了「立即更新并重启」，应用确实退出了，然后**什么都没发生** ——
`%APPDATA%\adb-assistant\update\helper.log` 一行都没有、新版本没起来、
自动回滚也没触发。不报错、不崩、日志空白，最难查的那一类。

**根因**：应用进程处在一个**带 `KILL_ON_JOB_CLOSE` 的作业对象**里。
本机探针 `scripts/_probe-job.cjs`（真 Electron）实测：

```
pid=38460 inJob=True LimitFlags=0x3C00 [KILL_ON_JOB_CLOSE,BREAKAWAY_OK,SILENT_BREAKAWAY_OK,DIE_ON_UNHANDLED_EXCEPTION]
```

作业对象里所有进程「一荣俱荣、一损俱损」：宿主 `app.exit(0)` 之后，
同作业的子进程会被**连坐杀掉**。而直接 `spawn()` 出来的助手恰恰就在同一个作业里。
更坑的是它**不是立刻死** —— 助手能写得出前几行日志，看起来一切正常，
等你把宿主关掉它才消失，于是「更新到一半没了」。

**为什么 `detached: true` 也不是解药**：那是 `DETACHED_PROCESS`，
PowerShell 会**退出码 0 但一行都不执行**（连它自己的日志都不写），比被杀掉还难查。
`stdio: 'ignore'` 之外的花样也别用：给了 pipe 却不读，子进程写满缓冲区就卡死。

**对策**：让助手由 **ShellExecute 代建**，这样它不属于应用的作业对象。

```ts
// electron/services/update.ts
const child = spawn(
  join(sysRoot, 'System32', 'cmd.exe'),
  ['/c', 'start', '', '/b', ps, '-NoProfile', '-NonInteractive',
   '-ExecutionPolicy', 'Bypass', '-File', scriptPath],   // scriptPath = 暂存目录里的 update-helper.ps1
  { stdio: 'ignore', cwd: tmpdir() },
);
```

本机探针 `scripts/_probe-spawn5.cjs（五种启动方式对照）+ scripts/_probe-spawn6.cjs（20 秒长任务存活）`（真 Electron）实测五种启动方式：

| 启动方式 | 真能执行 | 活过宿主退出 |
|---|---|---|
| 直接 `spawn(ps, …)` | ✅ | ❌ 被连坐（写得出首行日志，宿主一退就没了） |
| 直接 `spawn(ps, …, {detached:true})` | ❌ 静默不执行 | — |
| `spawn(ps, …, {stdio:'ignore'})` | ✅ | ❌ 同样被连坐 |
| **`cmd /c start "" /b ps -File …`** | ✅ | ✅ 20 秒长任务 10/10 tick 全活 |
| `explorer.exe <bootstrap.cmd>` | ✅（无作业环境下） | ✅ |

**还有两个配套细节，少一个都会踩坑**：

1. **退出前必须等助手落下第一行日志**。`cmd /c start` 是异步交接，
   中间那个 `cmd.exe` 自己还在作业里；宿主退得太早会把它连坐掉，
   助手于是永远起不来。等到了再退，这一环就是确定性的（`waitHelperStarted()`，
   超时 20 秒；等不到就撤掉本次更新并删掉 `job.json`，让「迟到的助手」立刻自杀，不动任何文件）。
2. **助手脚本要落地成 `.ps1` 再 `-File` 跑，且必须带 UTF-8 BOM**。
   无 BOM 时 PowerShell 5.1 会按 GBK 解，脚本里的中文注释变乱码，
   严重时把引号吃掉、整个脚本解析失败（同样表现为「静默不执行」）。

`npm run check:helper-launch` 专门钉这条：**在真 Electron 里**走一遍生产代码的
`spawnHelperForCheck()`，等助手落首行日志后 `app.exit(0)`；宿主死掉之后再断言
助手仍然把 `result.json`（`ok:true`）跑出来了 —— 因为助手的 `job.pid` 就是宿主，
它必须先看到宿主消失才会往下走，所以「结果存在」本身就是「没被连坐」的硬证据。6 项，约 8 秒。

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

```bash
# ---- 拖放安装（进度弹窗 + 防重复 + 目标设备）新增 ----

# 47 项：整窗拖放遮罩 / 非 AKP 拒绝 / 真实路径解析 / 安装中·成功·失败三种弹窗
#        / 安装中防重复（UI + 主进程互斥锁）/ 页面内拖放区
#        / 默认设备必须是物理设备（不是模拟器）/ 多台在线必须先问「装到哪台」
#          （列出全部设备、物理设备排第一、可选可取消、选定后才开装并回写当前设备）
# 需要一台在线设备：素材会自动从设备上拉一个真 APK（-r 重装必然成功）
# 默认设备 emulator-5556、包 com.zidongdianji，可用 ADB_SERIAL / PULL_PKG 覆盖
# ⚠️ 这条「默认选中物理设备」的用例要求真机插着；只有模拟器在线时它会被判失败（属预期）
python scripts/run-electron.py scripts/check-drag-install.cjs \
    --watch ui-shots/_draginstall.log --until "DRAG INSTALL CHECK DONE" --timeout 420
# 或 npm run check:drag-install

# 同一份用例打**安装版真身**（起 %LOCALAPPDATA%\Programs\ADBAssistant 的 exe 后用 CDP 连）
# 日志走 ui-shots/_draginstall-installed.log
# 注意：被测应用有单实例锁，跑之前先 python scripts/_kill-our-processes.py
node scripts/check-drag-install.cjs --installed
# 或 npm run check:drag-install:installed

# ---- APK 包名解析（纯 Node，秒级）----
# 9 项：手写的 ZIP + AXML 解析器能不能读出正确的包名/版本号（与设备端 dumpsys 交叉验证）
npm run check:apk-parse

# ---- 设备判定（纯 Node，秒级）----
# 9 项：isEmulator 在「浅查 / 深查」两条路径下都要与 serial 前缀一致
#       （模拟器伪装成真机型号时的经典误判；默认目标能否落到手机上全靠它）
npm run check:device-order

# ---- 三种安装方式（后端直测，21 项）----
# 覆盖 / 清洁 / 全新 + 目标设备定死 + 装后复核 + 互斥锁 + 日志可追溯
npm run check:install-modes

# ---- AAB 安装 + 拆包分离（后端直测，78 项；v1.0.19 扩到 78）----
# A 环境与工具链 7 项 / B AAB 文件识别 11 项 / C 真机安装链路 21 项
# D 缓存与安装方式 9 项
# E 拆包与安装分离 30 项（v1.0.19 新增）★
#   E1 仅拆包：产物落盘、不改设备状态、写下 source.aab.txt
#   E2 二次调用命中缓存、不重拆（buildMs=0）
#   E3 另存 outPath：产物复制到位、不留 .part 半成品
#   E4 装现成 .apks：不再拆包（输出里无 build-apks 痕迹）+ 靠来源反查做复核
#   E5/E6 不指定设备、扩展名不符一律拒
#   E7 fresh / clean 语义在 .apks 路径上同样成立
#   E8 缓存外的 .apks 也能装
# 需要一台在线设备；素材默认取 ~/Downloads 下最小的 .aab（AAB_FILE 可覆盖）
npm run check:aab-install

# ---- 通用 APK（纯 Node，38 项，v1.0.20 新增；**不需要设备**）----
# A 环境与素材 5 项 / B 生成与产物校验 16 项 / C 缓存复用 6 项
# D 另存与一致性 7 项 / E 换签名必须重做 / F 输入校验
#   B5·B6·B7 产物能被解析出包名与版本，且与源 AAB 一致
#   B9·B10 ★缓存目录名不含设备 key（`<指纹>-universal-<签名tag>`）
#   B15 ★静态守卫：实现里不许再出现 device-spec / adb（这条路与设备无关）
#   E1 ★换签名后另起缓存，绝不吃旧产物
# G 段（有模拟器在线才跑）：真实安装 + pm path 复核 + 单 APK（无 split）
# 真机一律跳过 —— 不会往用户的手机里装东西
npm run check:aab-universal

# ---- 「导出通用 APK」安装版界面冒烟（v1.0.20 新增；默认不碰设备）----
# 安全模式 14 项：exe 在不在 / asar 含新入口痕迹 / 启动 / tab / 拖放区
#   / 未选文件时无 AAB 出口 / 关于页版本与文案 / 截图 / 渲染层无 error
# ⚠️ 加 --with-drop 才会做「选中 AAB → 按钮出现」：那条路靠合成 drop 事件，
#    而拖放区 onDrop 就是「拖入即安装」—— 所以脚本会先确认在线设备
#    全是 emulator-*，含真机就整段跳过（别让验收把包装进用户的手机）
npm run check:aab-universal-ui

# ---- 拆包签名 / key hash（32 项，v1.0.18 新增）----
# A 段 key hash 计算 4 项 / B 段密钥库探测 7 项 / C 段配置 1 项
# D 段签名参数拼装 10 项 / E 段真机拆包验证签名 10 项
#   E6 ★产物签名指纹 == 用户所选密钥库（拆出来的 APK 逐个读指纹）
#   E9 ★设备上实际生效的签名 == 用户所选密钥库（adb pull 回 APK 读，不信本地产物）
# 需要模拟器在线；样本密钥库默认 ~/Downloads/AdbTools/pokercity.keystore（密码 111111，别名 pokercity）
npm run check:aab-signing

# ---- 常用工具：Logcat 导出（29 项，需一台设备；优先自动挑 emulator-*）----
# A 基础 dump / B 级别过滤 / C TAG / D 关键字 / E 组合 / F 子集关系
# G·G2 目录模式（自动建目录、<根>\<设备>\<日期>\ 层级、同秒连导不覆盖）
# H·H2 目录名净化（机型里的 / : * 等非法字符）与 resolveExportDir 纯函数行为
npm run check:logcat-export

# ---- AAB / APKS 界面验收（v1.0.19 扩到 39 项）----
# 标签名 / 拖放区接受 .apk·.aab·.apks / AAB 环境 / 类型标签分流
# / 安装方式提示按类型不同 / 选设备弹窗 / 安装中·成功弹窗 / 实时输出流
# / 「仅拆包并另存」按钮只对 AAB 出现 / .apks 安装弹窗 data-install-kind=apks
npm run check:aab-ui

# ---- 安装版真身验收（需先 python scripts/install-local.py 装一次）----
# ⚠️ 被测应用有单实例锁，跑之前先 python scripts/_kill-our-processes.py --installed
npm run check:aab-ui:installed                 # AAB/APKS 界面 39 项（CDP 连安装目录的 exe）
npm run check:drag-install:installed           # 拖放 47 项（node 跑，Node 22 自带 WebSocket）
npm run check:drag-install:installed:electron  # 同上，但用 electron 跑（走 _ws-shim.cjs 垫片）
npm run test:ws-shim                           # 垫片自检 7 项（握手/大响应/并发 id/close）
```

> 要往**脚本自己**传开关（如 `--installed`）直接跟在后面就行 —— `run-electron.py`
> 用 `parse_known_args()`，认识的自己留下、其余透传给脚本。
> **但绝不能给脚本参数声明 `nargs=REMAINDER`**：它会把 `--watch`/`--until`/`--timeout`
> 一起吞掉，导致「不监视日志 → 干等到默认 240s 超时强杀（exit 124）」，
> 而日志里其实早就写完了 —— 极易误判成功能失败。详见下方踩坑记录。

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
