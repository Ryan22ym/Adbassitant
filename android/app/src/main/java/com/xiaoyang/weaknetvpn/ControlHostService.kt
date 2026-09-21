package com.xiaoyang.weaknetvpn

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.net.VpnService
import android.os.Build
import android.os.IBinder
import android.util.Log

/**
 * 控制端口的宿主 Service。
 * ============================================================
 *
 * 它**不建隧道、不动网络**，只做两件事：
 *   1. 保活 [ControlServer]（电脑侧唯一的入口）
 *   2. 作为 context 让控制端点能拉起授权 Activity / 启动 VPN Service
 *
 * 为什么要单独一个 Service 而不是复用 WeakNetVpnService：
 *   · VPN 只在「弱网运行中」存在，而控制端口必须**一直**在（否则第一次
 *     就没法指挥 App 去授权 —— 鸡生蛋）。
 *   · 两个生命周期完全不同，混在一起会让「关 VPN」不小心把控制端口也关了，
 *     那样电脑侧就再也发不进指令。
 *
 * 前台服务：Android 8+ 起后台 Service 会被杀，所以必须前台。
 * 通知刻意做得**低调**（低优先级、无声音），且明确说明它不是弱网运行中。
 */
class ControlHostService : Service() {

    companion object {
        private const val TAG = "WeakNetHost"
        private const val CH_ID = "weaknet_control"
        private const val NOTIFY_ID = 0x7E10
    }

    private var server: ControlServer? = null

    override fun onCreate() {
        super.onCreate()
        startForegroundQuietly()
        val s = ControlServer(this)
        server = s
        s.start()
        Log.i(TAG, "控制端口宿主已就绪")
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_STICKY

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        server?.stop()
        server = null
        super.onDestroy()
    }

    /**
     * 低调的前台通知。
     *
     * 文案刻意写「待命」而不是「运行中」：用户看到通知栏有东西时，
     * 需要立刻能分辨「这是待命的控制通道（正常）」还是「VPN 正在改我的网络」。
     * 后者由 [WeakNetVpnService] 的独立通知负责，文案不同。
     */
    private fun startForegroundQuietly() {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                val nm = getSystemService(NotificationManager::class.java)
                val ch = NotificationChannel(
                    CH_ID,
                    getString(R.string.notify_ctrl_channel),
                    NotificationManager.IMPORTANCE_MIN,
                )
                ch.setShowBadge(false)
                ch.setSound(null, null)
                nm?.createNotificationChannel(ch)
            }

            val b = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                Notification.Builder(this, CH_ID)
            } else {
                @Suppress("DEPRECATION")
                Notification.Builder(this)
            }

            val n: Notification = b
                .setContentTitle(getString(R.string.notify_ctrl_title))
                .setContentText(getString(R.string.notify_ctrl_text))
                .setSmallIcon(android.R.drawable.stat_sys_download_done)
                .setOngoing(true)
                .setPriority(Notification.PRIORITY_MIN)
                .build()

            startForeground(NOTIFY_ID, n)
        } catch (e: Exception) {
            Log.w(TAG, "前台通知失败（不影响功能）：${e.message}")
        }
    }
}
