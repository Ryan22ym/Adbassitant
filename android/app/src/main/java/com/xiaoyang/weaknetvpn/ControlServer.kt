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
    private val service: WeakNetVpnService,
    private val port: Int = DEFAULT_PORT,
) {

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
                put("vpnActive", service.isRunning())
                put("authorized", service.authorized)
            })

            "/authorize" -> {
                // 拉起授权 Activity（设备上弹系统 VPN 授权框）。
                // 立即返回 —— 授权结果是异步的，电脑侧轮询 /status 拿。
                val i = Intent(service, AuthorizeActivity::class.java).apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP)
                }
                service.startActivity(i)
                json(200, JSONObject().apply {
                    put("ok", true)
                    put("message", "已请求在设备上弹出授权框，请在手机上点「确定」")
                })
            }

            "/start" -> {
                // 前置检查：没授权就明确告知，而不是让 establish() 静默失败
                val needAuth = VpnService.prepare(service) != null
                if (needAuth) {
                    json(200, JSONObject().apply {
                        put("ok", false)
                        put("code", "need_authorize")
                        put("error", "设备尚未授权 VPN。请在手机上点一次「确定」。")
                    })
                } else {
                    service.authorized = true
                    val params = SessionParams.fromJson(
                        if (body.isNotBlank()) JSONObject(body) else null,
                    )
                    service.updateParams(params)
                    val i = Intent(service, WeakNetVpnService::class.java).apply {
                        action = WeakNetVpnService.ACTION_START
                        putExtra(WeakNetVpnService.EXTRA_PARAMS, params.toJson().toString())
                    }
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                        service.startForegroundService(i)
                    } else {
                        service.startService(i)
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
                service.updateParams(params)
                json(200, JSONObject().apply {
                    put("ok", true)
                    put("message", "参数已热更新")
                })
            }

            "/stop" -> {
                // 关键：这一步必须幂等。电脑侧可能重复发（退出清理 + 崩溃恢复都发）
                val i = Intent(service, WeakNetVpnService::class.java).apply {
                    action = WeakNetVpnService.ACTION_STOP
                }
                try {
                    service.startService(i)
                } catch (_: Exception) {}
                json(200, JSONObject().apply {
                    put("ok", true)
                    put("message", "已关闭 VPN，网络已恢复")
                })
            }

            "/status" -> {
                val snap = service.snapshot()
                json(200, JSONObject().apply {
                    put("ok", true)
                    put("vpnActive", snap.vpnActive)
                    put("authorized", snap.authorized)
                    put("startedAt", snap.startedAt)
                    put("remainSec", snap.remainSec)
                    put("note", snap.note)
                    put("params", snap.params.toJson())
                    put("stats", service.statsJson())
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
