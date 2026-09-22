package com.xiaoyang.weaknetvpn

import android.content.Intent
import android.net.VpnService
import android.os.Build
import android.util.Log
import org.json.JSONObject
import java.io.BufferedOutputStream
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * 本地控制端口
 * ============================================================
 *
 * 电脑侧通过 `adb forward tcp:P tcp:P` 把设备的这个端口映射到电脑，
 * 于是电脑就能用普通 HTTP 调用 App 的能力。
 *
 * ⚠️ 方向说明（很容易搞反，别改错）：
 *   · `adb reverse` = 设备某端口 → 电脑某端口（设备主动访问电脑）
 *   · `adb forward` = 电脑某端口 → 设备某端口（**电脑主动访问设备**）← 我们用这个
 *
 *   旧代理方案用的是 reverse（设备把流量打到电脑的代理进程）；
 *   本方案方向相反：电脑要指挥设备上的 App，所以必须用 forward。
 *
 * 为什么自己手写 HTTP 而不是引一个框架：
 *   APK 越小越好、依赖越少越好。这里只需要处理几个固定端点，
 *   手写一个「读头 → 看路径 → 回 JSON」的循环完全够用，且没有额外依赖。
 *
 * 安全：**只监听 127.0.0.1**，外部网络（WiFi/移动数据）访问不到。
 * 只有能通过 adb 连上这台设备的人才能调用 —— 与 adb 本身的信任级别一致。
 */

class ControlServer(
    /**
     * 常驻宿主 Service。
     *
     * 只当 Context 用（startActivity / startService / VpnService.prepare 都要它）：
     * 控制端口必须**一直在**，而 VPN 只在弱网运行期间存在 —— 两者生命周期完全不同，
     * 所以不能直接拿 VPN Service 当宿主（它大部分时间是 null）。
     */
    private val host: ControlHostService,
    private val port: Int = DEFAULT_PORT,
) {

    /**
     * 当前 VPN 会话；未运行时为 null。
     *
     * 取自 [WeakNetVpnService.instance]（隧道建立后赋值、onDestroy 置空），
     * 所以这里按可空处理：VPN 没跑时 /status 要老实报「未运行」，而不是崩。
     *
     * 授权态另走 [ControlServerHost.authorized] —— 它与 VPN 是否在跑无关
     * （用户授权一次，系统一直记得），所以不能只看 vpn。
     */
    private val vpn: WeakNetVpnService?
        get() = WeakNetVpnService.instance

    companion object {
        private const val TAG = "WeakNetCtrl"

        /**
         * 控制端口默认值。
         *
         * 选 18080 而不是 17890：17890 是旧代理方案的端口，
         * 两个方案可能同时存在（回退用），换个端口避免撞车。
         */
        const val DEFAULT_PORT = 18080

        /** 协议版本，电脑侧会核对；不一致时给出明确提示而不是诡异失败 */
        const val PROTOCOL_VERSION = 1
    }

    private var server: ServerSocket? = null
    private val running = AtomicBoolean(false)
    private val pool = Executors.newFixedThreadPool(4)

    fun start() {
        if (running.getAndSet(true)) return
        Thread({
            try {
                // 只绑回环：外部网络访问不到
                val s = ServerSocket(port, 16, InetAddress.getByName("127.0.0.1"))
                server = s
                Log.i(TAG, "控制端口已监听 127.0.0.1:$port")
                while (running.get()) {
                    val c = try {
                        s.accept()
                    } catch (e: Exception) {
                        if (running.get()) Log.w(TAG, "accept 失败：${e.message}")
                        break
                    }
                    pool.execute { handle(c) }
                }
            } catch (e: Exception) {
                Log.e(TAG, "控制端口启动失败：${e.message}", e)
                running.set(false)
            }
        }, "control-server").apply { isDaemon = true; start() }
    }

    fun stop() {
        running.set(false)
        try { server?.close() } catch (_: Exception) {}
        server = null
        pool.shutdownNow()
    }

    fun isRunning() = running.get()

    /* ------------------------------------------------------------------ */
    /* 请求处理                                                            */
    /* ------------------------------------------------------------------ */

    private fun handle(client: Socket) {
        client.use { c ->
            c.soTimeout = 10_000
            val reader = BufferedReader(InputStreamReader(c.getInputStream(), Charsets.UTF_8))

            // 请求行
            val requestLine = reader.readLine() ?: return
            val parts = requestLine.split(" ")
            if (parts.size < 2) return
            val method = parts[0].uppercase()
            val path = parts[1].substringBefore('?')

            // 读头，顺便算 Content-Length
            var contentLength = 0
            while (true) {
                val line = reader.readLine() ?: break
                if (line.isEmpty()) break
                val idx = line.indexOf(':')
                if (idx > 0 && line.substring(0, idx).trim().equals("Content-Length", true)) {
                    contentLength = line.substring(idx + 1).trim().toIntOrNull() ?: 0
                }
            }

            // 读 body
            val body = if (contentLength > 0) {
                val buf = CharArray(contentLength)
                var read = 0
                while (read < contentLength) {
                    val n = reader.read(buf, read, contentLength - read)
                    if (n < 0) break
                    read += n
                }
                String(buf, 0, read)
            } else ""

            // 每次请求都算一次心跳：电脑侧每秒轮询 /status
            WeakNetVpnService.lastControlTouch = System.currentTimeMillis()

            val resp = try {
                route(method, path, body)
            } catch (e: Exception) {
                Log.w(TAG, "处理 $method $path 失败：${e.message}")
                json(500, JSONObject().put("ok", false).put("error", e.message ?: "内部错误"))
            }
            write(c, resp)
        }
    }

    private fun route(method: String, path: String, body: String): HttpResp {
        return when (path) {
            "/ping" -> json(200, JSONObject().apply {
                put("ok", true)
                put("app", "weaknet-vpn")
                put("protocol", PROTOCOL_VERSION)
                put("vpnActive", vpn?.isRunning() == true)
                put("authorized", ControlServerHost.authorized || vpn?.authorized == true)
            })

            "/authorize" -> {
                // 拉起授权 Activity（设备上弹系统 VPN 授权框）。
                // 立即返回 —— 授权结果是异步的，电脑侧轮询 /status 拿。
                val i = Intent(host, AuthorizeActivity::class.java).apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP)
                }
                host.startActivity(i)
                json(200, JSONObject().apply {
                    put("ok", true)
                    put("message", "已请求在设备上弹出授权框，请在手机上点「确定」")
                })
            }

            "/start" -> {
                // 前置检查：没授权就明确告知，而不是让 establish() 静默失败
                val needAuth = VpnService.prepare(host) != null
                if (needAuth) {
                    json(200, JSONObject().apply {
                        put("ok", false)
                        put("code", "need_authorize")
                        put("error", "设备尚未授权 VPN。请在手机上点一次「确定」。")
                    })
                } else {
                    ControlServerHost.authorized = true
                    vpn?.authorized = true
                    val params = SessionParams.fromJson(
                        if (body.isNotBlank()) JSONObject(body) else null,
                    )
                    // 首次启动时 vpn 还是 null（instance 在隧道建好后才有值），
                    // 参数靠下面的 EXTRA_PARAMS 带过去，onStartCommand 会解析。
                    vpn?.updateParams(params)
                    val i = Intent(host, WeakNetVpnService::class.java).apply {
                        action = WeakNetVpnService.ACTION_START
                        putExtra(WeakNetVpnService.EXTRA_PARAMS, params.toJson().toString())
                    }
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                        host.startForegroundService(i)
                    } else {
                        host.startService(i)
                    }
                    json(200, JSONObject().apply {
                        put("ok", true)
                        put("message", "VPN 启动指令已下发")
                    })
                }
            }

            "/params" -> {
                val params = SessionParams.fromJson(
                    if (body.isNotBlank()) JSONObject(body) else null,
                )
                // VPN 没在跑时无处可热更新 —— 但也不报错：电脑侧只会在运行中调这个端点
                vpn?.updateParams(params)
                json(200, JSONObject().apply {
                    put("ok", true)
                    put("message", "参数已热更新")
                })
            }

            "/stop" -> {
                // 关键：这一步必须幂等。电脑侧可能重复发（退出清理 + 崩溃恢复都发）
                val i = Intent(host, WeakNetVpnService::class.java).apply {
                    action = WeakNetVpnService.ACTION_STOP
                }
                try {
                    host.startService(i)
                } catch (_: Exception) {}
                json(200, JSONObject().apply {
                    put("ok", true)
                    put("message", "已关闭 VPN，网络已恢复")
                })
            }

            "/status" -> {
                val s = vpn
                val snap = s?.snapshot() ?: SessionSnapshot(
                    vpnActive = false,
                    authorized = ControlServerHost.authorized,
                    params = SessionParams(),
                    startedAt = 0,
                    remainSec = -1,
                    note = "未运行",
                )
                json(200, JSONObject().apply {
                    put("ok", true)
                    put("vpnActive", snap.vpnActive)
                    put("authorized", snap.authorized)
                    put("startedAt", snap.startedAt)
                    put("remainSec", snap.remainSec)
                    put("note", snap.note)
                    put("params", snap.params.toJson())
                    put("stats", s?.statsJson() ?: TrafficStats().toJson())
                })
            }

            else -> json(404, JSONObject().apply {
                put("ok", false)
                put("error", "未知端点：$path")
            })
        }
    }

    /* ------------------------------------------------------------------ */
    /* HTTP 写回                                                           */
    /* ------------------------------------------------------------------ */

    class HttpResp(val status: Int, val body: String)

    private fun json(status: Int, obj: JSONObject) = HttpResp(status, obj.toString())

    private fun write(c: Socket, resp: HttpResp) {
        val bytes = resp.body.toByteArray(Charsets.UTF_8)
        val head = buildString {
            append("HTTP/1.1 ${resp.status} ${reason(resp.status)}\r\n")
            append("Content-Type: application/json; charset=utf-8\r\n")
            append("Content-Length: ${bytes.size}\r\n")
            append("Connection: close\r\n")
            append("\r\n")
        }
        try {
            val out = BufferedOutputStream(c.getOutputStream())
            out.write(head.toByteArray(Charsets.UTF_8))
            out.write(bytes)
            out.flush()
        } catch (e: Exception) {
            Log.d(TAG, "回写响应失败：${e.message}")
        }
    }

    private fun reason(code: Int) = when (code) {
        200 -> "OK"
        404 -> "Not Found"
        500 -> "Internal Server Error"
        else -> "OK"
    }
}
