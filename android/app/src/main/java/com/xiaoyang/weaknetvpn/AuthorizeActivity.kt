package com.xiaoyang.weaknetvpn

import android.app.Activity
import android.content.Intent
import android.net.VpnService
import android.os.Bundle
import android.util.Log
import android.widget.Toast

/**
 * VPN 授权 Activity
 * ============================================================
 *
 * 这是**唯一需要用户操作**的地方。
 *
 * 为什么必须有它：`VpnService.prepare()` 返回非 null 时，必须由 Activity
 * 用 `startActivityForResult` 拉起系统授权框 —— 不能用 Service 或
 * `startActivity` 直接弹（系统会拒绝）。这是 Android 的硬性设计，
 * 任何「绕过授权」的想法在这条路上都行不通，也不应该行得通。
 *
 * 触发方式有两种：
 *   1. 电脑侧 `POST /authorize` → 控制端口拉起本 Activity
 *   2. 用户在桌面上点 App 图标（已配 MAIN/LAUNCHER，方便手动排查）
 *
 * 授权态由系统按 uid 持久记住，所以**通常只需要点一次**。
 */
class AuthorizeActivity : Activity() {

    companion object {
        private const val TAG = "WeakNetAuth"
        private const val REQ_VPN = 0x1001
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        requestAuth()
    }

    private fun requestAuth() {
        val intent = VpnService.prepare(this)
        if (intent == null) {
            // 已经授权过了（系统记住了）
            WeakNetVpnService.instance?.authorized = true
            onGranted()
            return
        }
        try {
            @Suppress("DEPRECATION")
            startActivityForResult(intent, REQ_VPN)
        } catch (e: Exception) {
            Log.e(TAG, "拉起授权框失败：${e.message}", e)
            Toast.makeText(this, "无法弹出 VPN 授权框：${e.message}", Toast.LENGTH_LONG).show()
            finish()
        }
    }

    @Deprecated("系统授权框走的是 startActivityForResult，必须用这个回调")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != REQ_VPN) return

        if (resultCode == RESULT_OK) {
            WeakNetVpnService.instance?.authorized = true
            ControlServerHost.authorized = true
            onGranted()
        } else {
            ControlServerHost.authorized = false
            Log.w(TAG, "用户拒绝了 VPN 授权")
            Toast.makeText(this, "已取消 VPN 授权，弱网模拟无法启动", Toast.LENGTH_LONG).show()
            finish()
        }
    }

    /**
     * 授权成功。
     *
     * 这里**不**自动启动 VPN —— 启动时机由电脑侧决定（它会发 /start）。
     * 如果这里自作主张启动，用户会遇到「只在电脑上点了一次授权、
     * 手机就突然开始改网络」的困惑。
     */
    private fun onGranted() {
        Log.i(TAG, "VPN 授权已获得")
        Toast.makeText(this, "授权成功，可以开始弱网模拟了", Toast.LENGTH_SHORT).show()

        // 如果电脑侧已经在等着（控制服务在跑），它会把授权态读走并继续。
        // 顺便让控制服务知道授权变了，下次 /status 就会报 authorized=true。
        ControlServerHost.authorized = true

        finish()
    }
}
