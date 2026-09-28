plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.xiaoyang.screenrecorder"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.xiaoyang.screenrecorder"
        minSdk = 21
        targetSdk = 34
        versionCode = 1
        versionName = "1.0.0"
    }

    buildTypes {
        release {
            // 调试工具、随主程序分发，不上商店；debug 签名即可
            // （也让 `adb install -r` 覆盖安装不会因签名变化被拒）。
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
    // 与弱网 App 同样的取舍：不引第三方依赖（连 Gson 都不用，手写 JSON）。
    // 这个 App 只需要 MediaProjection + SurfaceView + 手写 HTTP 服务。
    implementation("androidx.core:core-ktx:1.12.0")
    implementation("androidx.appcompat:appcompat:1.6.1")
}
