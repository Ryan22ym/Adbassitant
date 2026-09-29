package com.xiaoyang.screenrecorder

import android.content.Intent
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
 * 本地控制端口（采集端）。
 * ============================================================
 *
 * 电脑侧通过 `adb forward tcp:18081 tcp:18081` 把设备端口映射到电脑，
 * 用普通 HTTP 就能指挥这个 App 并拉走录制数据。
 *
 * ⚠️ 方向：`adb forward` = 电脑 → 设备（电脑主动访问设备），我们要的是这个。
 *
 * **只监听 127.0.0.1** —— 外部网络访问不到。唯一入口是 adb，
 * 与 adb 本身的信任级别一致（和弱网 App 同一套安全模型）。
 *
 * 端点一览（电脑侧 `electron/services/screen-recorder.ts` 一一对应）：
 *
 * | 方法 | 路径            | 作用                                        |
 * |------|-----------------|---------------------------------------------|
 * | GET  | /ping           | 探活 + 协议版本 + 权限状态                   |
 * | POST | /start          | 开始录制（需已授权 MediaProjection）          |
 * | POST | /pause          | 暂停 / 恢复（body: {"paused":true}）          |
 * | POST | /stop           | 停止录制，保留已录数据                        |
 * | POST | /reset          | 清空已录数据（为下一次录制做准备）             |
 * | GET  | /status         | 会话快照（计数、耗时、屏幕信息）               |
 * | GET  | /events         | 全部事件（触摸 + 截帧 + 系统），已按时间合并    |
 * | GET  | /touches        | 只要触摸事件（轻量，脚本本体）                 |
 * | GET  | /frame?id=N     | 取某帧 JPEG 二进制                            |
 * | POST | /authorize      | 拉起前台界面让用户授权投影                     |
 *
 * 为什么手写 HTTP 而不是引框架：APK 越小越好，端点固定，一个
 * 「读头 → 看路径 → 回响应」的循环足够（与弱网 App 同样的取舍）。
 */
class ControlServer(
    private val host: CaptureService,
    private val port: Int = DEFAULT_PORT,
) {

    companion object {
        private const val TAG = "RecorderCtrl"

        /** 控制端口。18080 已被弱网 App 占用，这里用 18081 避免撞车 */
        const val DEFAULT_PORT = 18081

        /** 协议版本，电脑侧核对；不一致时明确提示而不是诡异失败 */
        const val PROTOCOL_VERSION = 1
    }

    private var server: ServerSocket? = null
    private val running = AtomicBoolean(false)
    private val pool = Executors.newFixedThreadPool(4)

    fun start() {
        if (running.getAndSet(true)) return
        Thread({
            try {
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
        }, "recorder-control-server").apply { isDaemon = true; start() }
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
            c.soTimeout = 15_000
            val reader = BufferedReader(InputStreamReader(c.getInputStream(), Charsets.UTF_8))

            val requestLine = reader.readLine() ?: return
            val parts = requestLine.split(" ")
            if (parts.size < 2) return
            val method = parts[0].uppercase()
            // query 单独留一份 —— /frame?id=N 要用
            val fullTarget = parts[1]
            val path = fullTarget.substringBefore('?')
            val query = parseQuery(fullTarget)

            var contentLength = 0
            while (true) {
                val line = reader.readLine() ?: break
                if (line.isEmpty()) break
                val idx = line.indexOf(':')
                if (idx > 0 && line.substring(0, idx).trim().equals("Content-Length", true)) {
                    contentLength = line.substring(idx + 1).trim().toIntOrNull() ?: 0
                }
            }

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

            // 二进制响应（帧图片）单独走一条路 —— json() 装不下
            val resp: HttpResp = try {
                if (path == "/frame") frameResponse(query) else route(method, path, body)
            } catch (e: Exception) {
                Log.w(TAG, "处理 $method $path 失败：${e.message}")
                json(500, JSONObject().put("ok", false).put("error", e.message ?: "内部错误"))
            }
            write(c, resp)
        }
    }

    private fun parseQuery(target: String): Map<String, String> {
        val q = target.substringAfter('?', "")
        if (q.isEmpty()) return emptyMap()
        val m = HashMap<String, String>()
        for (kv in q.split('&')) {
            if (kv.isEmpty()) continue
            val i = kv.indexOf('=')
            if (i <= 0) m[kv] = "" else m[kv.substring(0, i)] = kv.substring(i + 1)
        }
        return m
    }

    private fun route(method: String, path: String, body: String): HttpResp {
        return when (path) {

            "/ping" -> json(200, JSONObject().apply {
                put("ok", true)
                put("app", "screen-recorder")
                put("protocol", PROTOCOL_VERSION)
                put("model", "${Build.MANUFACTURER} ${Build.MODEL}")
                put("sdk", Build.VERSION.SDK_INT)
                // 投影授权是「一次授权、会话内有效」的：App 被杀就要重新授权。
                // 这个字段让电脑侧能提前知道「点了开始会弹授权框」。
                put("authorized", CaptureService.hasProjection)
                put("recording", RecordingStore.isRecording())
            })

            "/authorize" -> {
                // 拉起前台 Activity —— MediaProjection 授权框只能由 Activity 请求，
                // 没有自动化余地。立即返回，授权结果由电脑侧轮询 /ping 拿。
                val i = Intent(host, RecorderActivity::class.java).apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP)
                    putExtra(RecorderActivity.EXTRA_REQUEST_AUTH, true)
                }
                host.startActivity(i)
                json(200, JSONObject().apply {
                    put("ok", true)
                    put("message", "已请求在设备上弹出录屏授权框，请在手机上点「立即开始」")
                })
            }

            "/start" -> {
                if (!CaptureService.hasProjection) {
                    json(200, JSONObject().apply {
                        put("ok", false)
                        put("code", "need_authorize")
                        put("error", "尚未获得录屏授权。请在手机上点一次「授权录屏」。")
                    })
                } else {
                    val m = RecordingStore.meta
                    if (m.width <= 0) {
                        json(200, JSONObject().apply {
                            put("ok", false)
                            put("code", "no_meta")
                            put("error", "采集尚未就绪（还没拿到屏幕信息），请稍后重试")
                        })
                    } else {
                        RecordingStore.start(m, "录制中")
                        json(200, JSONObject().apply {
                            put("ok", true)
                            put("message", "已开始录制")
                        })
                    }
                }
            }

            "/pause" -> {
                val p = try {
                    if (body.isNotBlank()) JSONObject(body).optBoolean("paused", true) else true
                } catch (_: Exception) { true }
                RecordingStore.setPaused(p)
                // 文案用**请求的意图**（p），状态用**实际生效值**（isPaused）。
                // 未在录制时 setPaused 会被忽略，两者会不一致 —— 这时别硬说
                // "已暂停"，直接说明现在没在录，免得电脑侧显示的状态自相矛盾。
                val active = RecordingStore.isRecording()
                json(200, JSONObject().apply {
                    put("ok", true)
                    put("paused", RecordingStore.isPaused())
                    put(
                        "message",
                        when {
                            !active -> "当前没有在录制，暂停请求已忽略"
                            p -> "已暂停"
                            else -> "已恢复"
                        },
                    )
                })
            }

            "/stop" -> {
                RecordingStore.stop()
                json(200, JSONObject().apply {
                    put("ok", true)
                    put("message", "已停止录制（数据保留，可用 /events 拉取）")
                })
            }

            "/reset" -> {
                RecordingStore.reset()
                json(200, JSONObject().apply {
                    put("ok", true)
                    put("message", "已清空录制数据")
                })
            }

            "/status" -> {
                val s = RecordingStore.snapshot()
                json(200, JSONObject().apply {
                    put("ok", true)
                    put("recording", s.recording)
                    put("paused", s.paused)
                    put("capturing", s.capturing)
                    put("startedAtWall", s.startedAtWall)
                    put("elapsedMs", s.elapsedMs)
                    put("meta", s.meta.toJson())
                    put("touchCount", s.touchCount)
                    put("frameCount", s.frameCount)
                    put("sysCount", s.sysCount)
                    put("note", s.note)
                })
            }

            "/touches" -> {
                val arr = RecordingStore.touches().toJsonArray { it.toJson() }
                json(200, JSONObject().apply {
                    put("ok", true)
                    put("count", arr.length())
                    put("meta", RecordingStore.meta.toJson())
                    put("touches", arr)
                })
            }

            "/events" -> {
                val merged = RecordingStore.mergedTimeline()
                val arr = org.json.JSONArray()
                for (o in merged) arr.put(o)
                json(200, JSONObject().apply {
                    put("ok", true)
                    put("count", arr.length())
                    put("meta", RecordingStore.meta.toJson())
                    put("events", arr)
                })
            }

            else -> json(404, JSONObject().apply {
                put("ok", false)
                put("error", "未知端点：$path")
            })
        }
    }

    /* ------------------------------------------------------------------ */
    /* 帧图片（二进制响应）                                                 */
    /* ------------------------------------------------------------------ */

    private fun frameResponse(query: Map<String, String>): HttpResp {
        val id = query["id"]?.toIntOrNull()
            ?: return json(400, JSONObject().put("ok", false).put("error", "缺少 id 参数"))
        val bytes = RecordingStore.frameBytes(id)
            ?: return json(404, JSONObject().put("ok", false).put("error", "帧 $id 不存在（可能已被更新的帧挤出上限）"))
        // 具名传参，否则 bytes 会落到 body（String?）槽位
        return HttpResp(status = 200, binary = bytes, contentType = "image/jpeg")
    }

    /* ------------------------------------------------------------------ */
    /* HTTP 写回                                                           */
    /* ------------------------------------------------------------------ */

    /**
     * HTTP 响应。
     *
     * [binary] 为空时走文本（JSON）路径；非空时直接回字节流 ——
     * 帧图片必须走二进制，用 String 中转会把 JPEG 的任意字节序列搞坏。
     */
    class HttpResp(
        val status: Int,
        val body: String? = null,
        val contentType: String = "application/json; charset=utf-8",
        val binary: ByteArray? = null,
    )

    private fun json(status: Int, obj: JSONObject) = HttpResp(status, obj.toString())

    private fun write(c: Socket, resp: HttpResp) {
        // 二进制路径优先：帧图片必须走字节流（JPEG 里的任意字节序列用 String 中转会坏）
        val bytes: ByteArray = resp.binary ?: ((resp.body ?: "").toByteArray(Charsets.UTF_8))
        val head = buildString {
            append("HTTP/1.1 ${resp.status} ${reason(resp.status)}\r\n")
            append("Content-Type: ${resp.contentType}\r\n")
            append("Content-Length: ${bytes.size}\r\n")
            // 帧图片可能被重复拉取，但内容会随 MAX_FRAMES 淘汰而变 —— 统一 no-store 最省心
            append("Cache-Control: no-store\r\n")
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
        400 -> "Bad Request"
        404 -> "Not Found"
        500 -> "Internal Server Error"
        else -> "OK"
    }
}
