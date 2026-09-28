package com.xiaoyang.screenrecorder

import android.app.AppOpsManager
import android.app.usage.UsageEvents
import android.app.usage.UsageStatsManager
import android.content.Context
import android.os.Process
import android.util.Log
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * 前台应用监听（系统事件来源）。
 * ============================================================
 *
 * ## 为什么不用 ActivityManager.getRunningTasks
 *
 * 那是「教科书做法」，但**在 Android 5.0+ 的第三方 App 上已经失效** ——
 * 系统只返回自己和他人的部分信息（实际就是空列表），因为它是隐私敏感 API。
 * 网上大量示例代码仍在用，装了才发现永远拿不到数据。
 *
 * ## 实际可用的两条路
 *
 *   · `UsageStatsManager.queryEvents` —— 需要用户在「设置 → 特殊应用权限 →
 *     使用情况访问」里手动授权。这是**唯一**可靠的免 root 途径。
 *   · `ActivityManager.getRunningAppProcesses` —— 也受限，且语义不是「前台」。
 *
 * 所以这里走 UsageStats，并且：
 *   · **没授权就静默降级**（不采集系统事件）—— 它只是辅助信息，
 *     不能因为拿不到权限就让整个录制失败；
 *   · 降级时在 [RecordingStore] 里记一条说明，让电脑端能告诉用户
 *     「想要事件可以授权使用情况访问」。
 *
 * ## 为什么轮询而不是监听
 *
 * UsageStats 没有「前台变了」的推送回调（UsageStatsManager 只有查询接口）。
 * 所以按 1s 轮询 —— 相较于录制这种分钟级场景，1s 延迟可以忽略，
 * 而且比 attempt 注册广播（ACTION_RESUME 之类，安卓各版本行为不一）稳得多。
 */
class ForegroundWatcher(private val ctx: Context) {

    companion object {
        private const val TAG = "RecorderFg"
        /** 轮询间隔。1s 够分辨页面跳转，又不至于太耗电 */
        private const val POLL_MS = 1000L
    }

    private var pool: ScheduledExecutorService? = null
    private val running = AtomicBoolean(false)
    private var lastPkg: String = ""

    fun start() {
        if (running.getAndSet(true)) return
        val usm = ctx.getSystemService(Context.USAGE_STATS_SERVICE) as? UsageStatsManager
        if (usm == null) {
            Log.w(TAG, "设备没有 UsageStatsManager，系统事件采集已关闭")
            RecordingStore.addSys(
                SysEvent(kind = "unavailable", pkg = "", t = RecordingStore.elapsedMs(),
                    label = "本设备不支持使用情况统计，系统事件未采集")
            )
            return
        }

        if (!hasUsageAccess()) {
            // 没授权：记一条提示，然后**不启动**轮询（免得每秒白跑一次查询）
            Log.i(TAG, "未获得「使用情况访问」权限，系统事件采集已降级")
            RecordingStore.addSys(
                SysEvent(
                    kind = "no_permission", pkg = "",
                    t = RecordingStore.elapsedMs(),
                    label = "未授权「使用情况访问」，本次录制不含前台应用事件（不影响触摸与截帧）",
                )
            )
            running.set(false)
            return
        }

        pool = Executors.newSingleThreadScheduledExecutor { r ->
            Thread(r, "recorder-fg").apply { isDaemon = true }
        }.also { p ->
            p.scheduleWithFixedDelay({ tick(usm) }, 0, POLL_MS, TimeUnit.MILLISECONDS)
        }
        Log.i(TAG, "前台应用监听已启动")
    }

    fun stop() {
        if (!running.getAndSet(false)) return
        try { pool?.shutdownNow() } catch (_: Exception) {}
        pool = null
    }

    private fun tick(usm: UsageStatsManager) {
        if (!running.get()) return
        if (!RecordingStore.isRecording() || RecordingStore.isPaused()) return
        try {
            val end = System.currentTimeMillis()
            // 往回查 3s：轮询有抖动，窗口太小会漏事件
            val begin = end - 3000
            val events = usm.queryEvents(begin, end) ?: return
            val e = UsageEvents.Event()
            while (events.hasNextEvent()) {
                events.getNextEvent(e)
                val type = e.eventType
                if (type != UsageEvents.Event.MOVE_TO_FOREGROUND) continue
                val pkg = e.packageName ?: continue
                if (pkg == lastPkg) continue
                lastPkg = pkg
                RecordingStore.addSys(
                    SysEvent(
                        kind = "foreground",
                        pkg = pkg,
                        t = RecordingStore.elapsedMs(),
                        label = "切换到 ${appLabel(pkg)}",
                    )
                )
            }
        } catch (e: Exception) {
            Log.w(TAG, "查询前台事件失败：${e.message}")
        }
    }

    /** 包名 → 应用名。拿不到就退回包名（不为一个展示名去冒崩的风险） */
    private fun appLabel(pkg: String): String = try {
        val pm = ctx.packageManager
        pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)).toString()
    } catch (_: Exception) {
        pkg
    }

    /**
     * 检查是否已授予「使用情况访问」。
     *
     * 这是**特殊权限**，不在运行时权限体系里 —— 只能跳设置页让用户手动开，
     * 没有 requestPermissions 可调。所以只能用 AppOpsManager 查状态。
     */
    private fun hasUsageAccess(): Boolean = try {
        val appOps = ctx.getSystemService(Context.APP_OPS_SERVICE) as AppOpsManager
        val mode = if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.Q) {
            appOps.unsafeCheckOpNoThrow(
                AppOpsManager.OPSTR_GET_USAGE_STATS,
                Process.myUid(),
                ctx.packageName,
            )
        } else {
            @Suppress("DEPRECATION")
            appOps.checkOpNoThrow(
                AppOpsManager.OPSTR_GET_USAGE_STATS,
                Process.myUid(),
                ctx.packageName,
            )
        }
        mode == AppOpsManager.MODE_ALLOWED
    } catch (e: Exception) {
        Log.w(TAG, "检查使用情况权限失败：${e.message}")
        false
    }
}
