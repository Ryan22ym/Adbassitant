// 弱网验证探针（**仅用于测试，不随主程序分发**）
//
// 为什么需要它：验证弱网是否需要「普通应用」发流量 —— Android 的 VPN 允许 UID 集合
// {@1-999,1001-1999,2001-10338,10340-99999} 里没有 0/1000(system)/2000(shell)，
// 所以 `adb shell curl` 永远绕过隧道。
// 而用 Chrome 代理流量又不可控（缓存、连接复用、多连接并发 → 指标完全不可比）。
//
// 这个探针是独立包名 → 独立 uid → 在 VPN 网段内；一次只发一个受控 HTTP 请求，
// 把精确的 connectMs / ttfbMs / bytes 写进 logcat，用电竞的"跑一次就知道"方式量化整形效果。
plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.xiaoyang.trafficprobe"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.xiaoyang.trafficprobe"
        minSdk = 21
        targetSdk = 34
        versionCode = 1
        versionName = "1.0.0"
    }

    buildTypes {
        debug {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

// 刻意零依赖：只用一个 Activity + HttpURLConnection
