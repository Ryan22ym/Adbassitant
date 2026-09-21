plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.xiaoyang.weaknetvpn"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.xiaoyang.weaknetvpn"
        minSdk = 21
        targetSdk = 34
        versionCode = 1
        versionName = "1.0.0"
    }

    buildTypes {
        release {
            // 这个包是调试工具、随主程序分发，不需要上商店；
            // 用 debug 签名即可（也让 `adb install -r` 覆盖安装不会因签名变化被拒）。
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    packaging {
        resources.excludes += setOf("META-INF/*.kotlin_module")
    }
}

dependencies {
    // 刻意不引第三方依赖：这个 App 只需要 VpnService + 一个手写的 HTTP 服务，
    // 依赖越少，APK 越小、装上越不容易出岔子（也避免网络代理导致依赖拉不下来）。
    implementation("androidx.core:core-ktx:1.12.0")
    implementation("androidx.appcompat:appcompat:1.6.1")
}
