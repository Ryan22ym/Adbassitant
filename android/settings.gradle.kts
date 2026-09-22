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
