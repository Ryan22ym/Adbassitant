package com.xiaoyang.trafficprobe

import android.app.Activity
import android.os.Bundle
import android.util.Log
import java.net.HttpURLConnection
import java.net.URL

/**
 * 弱网验证探针 —— 发**一个**受控 HTTP 请求，把精确指标写进 logcat。
 *
 * 用法（电脑侧）：
 * ```
 * adb shell am start -n com.xiaoyang.trafficprobe/.ProbeActivity \
 *   --es url "http://www.baidu.com/" --ei maxMs 30000 --ei maxBytes 200000 --es tag lat1
 * adb shell "logcat -d -t 3000 | grep PROBE"
 * ```
 *
 * 输出：
 * ```
 * PROBE tag=lat1 start url=...
 * PROBE tag=lat1 done code=200 connectMs=10412 ttfbMs=10413 totalMs=10480 bytes=32768
 * ```
 *
 * 指标含义：
 *   · connectMs —— 从「开始请求」到「拿到响应头」。含 TCP 三次握手 + 请求 + 响应头，
 *                  是测**延迟**最干净的指标（单程 3000ms 时应约 +12000ms）
 *   · ttfbMs    —— 到第一个响应体字节
 *   · bytes     —— 实际读到的字节数，配合 maxMs 窗口测**吞吐**
 *
 * 为什么要单独一个 APK：Android 不会把 uid 0/1000(system)/2000(shell) 的流量送进 VPN，
 * 所以 adb shell 里的 curl 测不出弱网；而这个包是独立 applicationId → 独立 uid → 在网段内。
 */
class ProbeActivity : Activity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val url = intent?.getStringExtra("url") ?: "http://www.baidu.com/"
        val maxMs = intent?.getIntExtra("maxMs", 30_000) ?: 30_000
        val maxBytes = intent?.getIntExtra("maxBytes", 200_000) ?: 200_000
        val tag = intent?.getStringExtra("tag") ?: "run"

        // 注意：这里**不能**立刻 finish()，否则进程可能在下载完成前被回收。
        Thread({ run(url, maxMs, maxBytes, tag) }, "probe").apply { isDaemon = true; start() }
    }

    private fun run(url: String, maxMs: Int, maxBytes: Int, tag: String) {
        var conn: HttpURLConnection? = null
        try {
            Log.i(TAG, "PROBE tag=$tag start url=$url maxMs=$maxMs maxBytes=$maxBytes")
            val t0 = System.currentTimeMillis()
            conn = (URL(url).openConnection() as HttpURLConnection).apply {
                connectTimeout = maxMs
                readTimeout = maxMs
                requestMethod = "GET"
                instanceFollowRedirects = true
                useCaches = false
                setRequestProperty("Connection", "close")   // 别复用连接，保证每次都是完整握手
                setRequestProperty("Accept-Encoding", "identity")
            }
            conn.connect()
            val code = conn.responseCode
            val connectMs = System.currentTimeMillis() - t0

            val ins = conn.inputStream
            val buf = ByteArray(16384)
            var total = 0L
            var ttfb = -1L
            val deadline = t0 + maxMs
            while (total < maxBytes && System.currentTimeMillis() < deadline) {
                val n = ins.read(buf)
                if (n <= 0) break
                if (ttfb < 0) ttfb = System.currentTimeMillis() - t0
                total += n
            }
            val totalMs = System.currentTimeMillis() - t0
            Log.i(TAG, "PROBE tag=$tag done code=$code connectMs=$connectMs ttfbMs=$ttfb totalMs=$totalMs bytes=$total")
        } catch (e: Exception) {
            Log.i(
                TAG,
                "PROBE tag=$tag error afterMs=${System.currentTimeMillis()} " +
                    "${e.javaClass.simpleName}: ${e.message}",
            )
        } finally {
            try { conn?.disconnect() } catch (_: Exception) {}
            runOnUiThread { finish() }
        }
    }

    companion object {
        const val TAG = "TrafficProbe"
    }
}
