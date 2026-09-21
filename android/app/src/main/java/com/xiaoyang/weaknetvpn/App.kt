package com.xiaoyang.weaknetvpn

import android.app.Application
import android.content.Intent
import android.os.Build
import android.util.Log

/**
 * 应用入口。
 *
 * 核心职责：**保证控制端口一定在跑**。
 *
 * 为什么放在 Application 而不是 Service 里：
 *   · 控制端口是电脑侧唯一的入口。如果它只在 VPN 跑的时候才监听，
 *     那么「第一次使用」就无法指挥 App 去授权（鸡生蛋问题）。
 *   · 所以进程一起来就监听，直到进程结束。它只绑 127.0.0.1，
 *     开销极小（一个 accept 循环 + 4 线程池）。
 *
 * 自启动：用户点了桌面图标、或被电脑侧 `am start` 拉起时都会走到这里。
 * 我们不注册 BOOT_COMPLETED（没必要，弱网测试一定是人在电脑前）。
 */
class App : Application() {

    companion object {
        private const val TAG = "WeakNetApp"
    }

    override fun onCreate() {
        super.onCreate()
        Log.i(TAG, "进程启动，准备控制端口")

        // 起一个「空壳」Service 来承载控制端口。
        //
        // 为什么不直接在 Application 里 new 一个 ControlServer：
        //   控制端点的很多动作要 startService / startForegroundService，
        //   需要一个 Service 实例作为 context。空壳 Service 最省事，
        //   而且它不建隧道、不做任何网络动作，纯粹是宿主。
        val i = Intent(this, ControlHostService::class.java)
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startForegroundService(i)
            } else {
                startService(i)
            }
        } catch (e: Exception) {
            Log.w(TAG, "控制宿主服务启动失败：${e.message}")
        }
    }
}

/** 全局授权态快照（App 进程内共享，供控制端点快速回答） */
object ControlServerHost {
    @Volatile var authorized: Boolean = false
}
