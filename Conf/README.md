# Conf —— 界面配置文件

这三个 JSON 用来调整**界面骨架**（顺序、显隐、默认展开收起），不需要改代码、不需要重新编译。

- 改完保存，**重启程序**生效。
- 程序首次启动时会把配置复制到程序目录下的 `Conf\`（与 `ADB桌面助手.exe` 同级）。
  之后就一直读那一份，**在线更新不会覆盖你改过的配置**。
- 改坏了不要紧：删掉某个文件，或把里面的 `_enabled` 改成 `false`，该项就恢复出厂默认；
  三个文件全删掉 = 界面与出厂状态完全一致。

---

## 一分钟上手

| 我想…… | 改哪个文件 | 怎么改 |
| --- | --- | --- |
| 把「投屏」挪到导航第一位 | `layout.json` | `sidebar.order` 写成 `["mirror", "device", ...]` |
| 每次打开都收起左侧功能栏 | `layout.json` | `sidebar.defaultCollapsed` 改成 `true` |
| 隐藏「弱网模拟」入口 | `features.json` | `nav.weaknet` 改成 `false` |
| 让「Monkey 测试」默认收起 | `panels.json` | `tools.monkey` 改成 `false` |
| 全部恢复出厂 | 三个文件 | 删除，或各自 `_enabled` 改成 `false` |

> `order` 数组**只写想调的项就够了**：列出的按你的顺序排在前面，没列出的按默认顺序接在后面。
> 写错的 id 会被忽略，不会导致界面异常。

---

## layout.json —— 顺序

| 字段 | 含义 | 可选值 |
| --- | --- | --- |
| `sidebar.order` | 左侧功能栏顺序 | 见下表「导航 id」 |
| `sidebar.defaultCollapsed` | 首次启动是否收起（只留图标） | `true` / `false` |
| `sidebar.rememberCollapsed` | 是否记住手动切换的收起状态 | `true`=记住（默认）；`false`=每次启动都回到 `defaultCollapsed` |
| `toolTabs.order` | 「常用工具」页标签顺序 | 见下表「工具标签 id」 |

### 导航 id

| id | 界面名称 |
| --- | --- |
| `device` | 设备 |
| `mirror` | 投屏 |
| `tools` | 常用工具 |
| `apps` | 应用管理 |
| `logcat` | 实时 Logcat |
| `weaknet` | 弱网模拟 |
| `clicker` | 自动连点器 |
| `command` | 命令终端 |
| `settings` | 设置 |

### 工具标签 id

| id | 界面名称 |
| --- | --- |
| `screenshot` | 截图 |
| `record` | 录屏 |
| `resolution` | 分辨率 |
| `monkey` | Monkey 测试 |
| `apk` | 安装安装包 |
| `file` | 文件传输 |
| `logcat` | Logcat 导出 |

---

## panels.json —— 默认展开 / 收起

每种功能块一个 `true` / `false`：`true` = 默认展开，`false` = 默认收起。
**收起只是视觉收起**，点一下标题就能展开，功能不受影响。

| 页面 | id | 功能块 |
| --- | --- | --- |
| 设备 | `device.list` | 已连接设备 |
| | `device.detail` | 设备详情 |
| | `device.wireless` | 无线连接 |
| 投屏 | `mirror.status` | 投屏状态 |
| | `mirror.quality` | 画质与行为 |
| | `mirror.hotkeys` | 快捷键 |
| 常用工具 | `tools.screenshot` | 屏幕截图 |
| | `tools.record` | 屏幕录制 |
| | `tools.resolution` | 分辨率与 DPI |
| | `tools.monkey` | Monkey 稳定性测试 |
| | `tools.apk` | 安装安装包 |
| | `tools.file` | 文件传输 |
| | `tools.logcat` | 导出 Logcat 日志 |
| 应用管理 | `apps.list` | 应用列表 |
| | `apps.detail` | 应用详情 |
| 实时 Logcat | `logcat.stream` | 日志流主体 |
| | `logcat.filter` | 过滤设置（默认是否展开） |
| 弱网模拟 | `weaknet.params` | 弱网参数 |
| | `weaknet.scope` | 生效范围与时长 |
| | `weaknet.presets` | 参数预设 |
| | `weaknet.device` | 设备能力 |
| | `weaknet.howto` | 实现原理与限制 |
| 自动连点器 | `clicker.steps` | 步骤 |
| | `clicker.preview` | 屏幕预览图 |
| | `clicker.params` | 执行参数 |
| | `clicker.library` | 脚本库 |
| 命令终端 | `command.input` | 命令输入 |
| | `command.common` | 常用命令 |
| | `command.output` | 执行结果 |
| 运行日志 | `logs.stream` | 日志主体 |
| 安装包管理 | `packages.workdir` | 工作目录 |
| | `packages.rules` | 整理规则 |
| | `packages.filter` | 标签筛选 |
| | `packages.list` | 包列表 |
| 设置 | `settings.appearance` | 外观 |
| | `settings.about` | 关于 |
| | `settings.dirs` | 默认保存目录 |
| | `settings.update` | 软件更新 |
| | `settings.logs` | 运行日志 |
| | `settings.env` | 环境自检 |
| | `settings.autoMirror` | 插入手机自动投屏 |

---

## features.json —— 入口开关

`true` = 显示，`false` = 该入口在界面上不出现（**只是藏起来，不是禁用**；
直接打开对应页面地址仍然可用）。代码全部保留，随时改回来。

| 分组 | id | 对应入口 |
| --- | --- | --- |
| `nav` | 同「导航 id」 | 左侧功能栏的九个入口 |
| `tools` | 同「工具标签 id」 | 「常用工具」页的七个标签 |
| `device` | `device.wireless` | 设备页的「无线连接」整块 |
| | `device.quickActions` | 设备行上的快捷动作按钮（清数据 / 冷启动…） |
| `clicker` | `clicker.record` | 连点器页的「手机端录制」标签 |
| `settings` | `settings.autoMirror` | 设置页的「插入手机自动投屏」 |
| | `settings.update` | 设置页的「软件更新」 |
| | `settings.envCheck` | 设置页的「环境自检」 |

> ⚠️ 把 `nav.settings` 也关掉之后，设置页就没有入口了，只能靠改这个文件恢复。

---

## 与「设置」页里的开关有什么区别？

- `Conf\*.json`（本目录）= **界面骨架**：顺序、显隐、默认展开。手改文件，重启生效。
- 程序「设置」页里的开关 = **运行时偏好**：主题、默认目录、开机自启等。
  存在 `%APPDATA%\adb-assistant\settings.json`，界面里随时改。

两者互不覆盖：这里改的是"界面长什么样"，设置页改的是"程序怎么跑"。

---

## 文件被谁管？

- 出厂默认值写在 `shared/ui-conf.ts`，本目录的三个 JSON 只是**可以改的那一份副本**。
- 程序升级后如果新增了配置项，你手上这份旧文件不会自动补上新项 ——
  但**缺的项会自动用出厂默认值**，所以不会出错，只是新项目用默认表现。
  想拿到最新的完整模板，把 `Conf\` 删掉再启动一次即可（会重新生成一份）。
