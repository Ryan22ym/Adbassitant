// 弱网测试配套 App —— 顶层构建脚本
//
// 为什么单独立一个 Gradle 工程（而不是塞进主项目）：
//   · 主项目是 Electron + React，tsconfig 只 include electron/shared；
//     这里的 Kotlin/Gradle 完全不参与 npm 构建，互不干扰。
//   · 产物只有一个 APK，随主程序打包进 bin/（bin/weaknet-vpn.apk），电脑侧只负责装 + 用。
//
// 构建（有 SDK 的机器上）：
//   cd android && ./gradlew :app:assembleDebug
//   产物：android/app/build/outputs/apk/debug/app-debug.apk
//   复制到：bin/weaknet-vpn.apk（放 bin 根下，勿建子目录，见 weaknet-vpn.ts）
plugins {
    id("com.android.application") version "8.5.2" apply false
    id("org.jetbrains.kotlin.android") version "1.9.24" apply false
}
