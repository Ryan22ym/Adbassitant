pluginManagement {
    repositories {
        // 国内网络优先走镜像；两个源都留着，命中即止
        maven("https://maven.aliyun.com/repository/gradle-plugin")
        maven("https://maven.aliyun.com/repository/google")
        maven("https://maven.aliyun.com/repository/public")
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.PREFER_SETTINGS)
    repositories {
        maven("https://maven.aliyun.com/repository/google")
        maven("https://maven.aliyun.com/repository/public")
        google()
        mavenCentral()
    }
}

rootProject.name = "weaknet-vpn"
include(":app")
// 弱网验证探针（测试专用，不随主程序分发）。
// 为什么要单独立模块：验证弱网必须由**普通应用**发流量 —— Android 的 VPN
// 允许 UID 集合里没有 0/1000(system)/2000(shell)，adb shell curl 永远绕过隧道。
// 独立 applicationId → 独立 uid → 在网段内，且一次只发一个受控请求，指标可比。
include(":probe")
// 屏幕录制采集端（自动连点器的配套 App）。
//
// 为什么要一个设备侧 App：Android 从 5.0 起**第三方应用无法读取自己以外的触摸事件**
// （读全局触摸要 INJECT_EVENTS，只有系统签名或 root 有）。所以录制的可行路径是
// 「App 自己的窗口 = 录制画布」：它用 MediaProjection 采集本机屏幕画到自己的
// SurfaceView 上，用户在**这块画布上**操作，触摸事件自然落到自己手里 —— 免 root，
// 且天然就是电脑端要的「坐标 + 时间戳」。
//
// 产物 bin/screen-recorder.apk（同样放在 bin 根下，理由见 build-weaknet-apk.mjs）。
include(":recorder")

