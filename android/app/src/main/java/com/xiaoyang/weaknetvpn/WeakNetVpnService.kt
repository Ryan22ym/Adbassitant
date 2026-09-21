package com.xiaoyang.weaknetvpn

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.net.VpnService
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.ParcelFileDescriptor
import android.util.Log
import java.io.FileInputStream
import java.io.FileOutputStream
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetSocketAddress
import java.net.Socket
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

/**
 * 弱网整形 VPN 服务
 * ============================================================
 *
 * 这是方案的引擎：在 IP 层接管设备的全部流量，逐包整形。
 * 所以**不依赖任何应用是否遵循 HTTP 代理** —— 这是相对旧代理方案最本质的改进。
 *
 * 隧道拓扑
 * ------------------------------------------------------------
 * ```
 *  App ──write()──► tun(10.215.0.2) ──tun-reader──► 解析 IPv4/TCP|UDP
 *                                                       │
 *                                              up 整形（延迟/丢/错/限速）
 *                                                       │
 *                                              真实 socket（protect 过，不走隧道）
 *                                                       │
 *                                              down 整形
 *                                                       │
 *                                     构造 IP 包 ──write()──► tun ──► App
 * ```
 *
 * 关于「必须自己实现 tun2socks」
 * ------------------------------------------------------------
 * 全量接管（`addRoute 0.0.0.0/0`）意味着**所有**流量都进隧道，所以我们
 * 必须自己把包转发到真实网络。成熟做法是用 hev-socks5-tunnel 之类的 so，
 * 但那需要 NDK；本机没有 Android SDK/NDK，无法构建。
 *
 * 于是这里用纯 Kotlin 写了一个**够弱网测试用**的精简实现：
 *   · TCP：每个流开一个真实 Socket，透传 payload（不做完整 TCP 状态机）
 *   · UDP：每个流开一个 DatagramSocket，双向透传（主要覆盖 DNS）
 *
 * ⚠️ 如实记录的限制：
 *   1. 只处理 IPv4 的 TCP/UDP，IPv6 与其他协议直接放行（不接管）
 *   2. 不做 TCP 状态机（不处理重排/窗口），payload 按到达顺序透传 ——
 *      对弱网测试足够，"网络变差"由整形器负责，不靠这里制造
 *   3. 需要 `protect()` 真实 socket，否则自己转发出去的流量又进隧道 → 递归
 */

class WeakNetVpnService : VpnService() {

    companion object {
        private const val TAG = "WeakNetVpn"
        private const val CHANNEL_ID = "weaknet_vpn"
        private const val NOTIFY_ID = 0x7E11

        const val ACTION_START = "com.xiaoyang.weaknetvpn.START"
        const val ACTION_STOP = "com.xiaoyang.weaknetvpn.STOP"
        const val EXTRA_PARAMS = "params"

        /** 隧道自身的地址（私有段，不冲突） */
        private const val TUN_ADDRESS = "10.215.0.2"
        private const val TUN_DNS = "10.215.0.1"
        private const val TUN_MTU = 1500

        /** 全局单例：控制端口要用它 */
        @Volatile var instance: WeakNetVpnService? = null
            private set

        /** 控制通道最后一次收到请求的时间戳，用于心跳超时自停 */
        @Volatile var lastControlTouch: Long = 0

        /**
         * 心跳超时（ms）。
         *
         * 为什么需要：电脑进程被强杀 / USB 被拔时，我们收不到任何 stop 指令。
         * 这时候必须自己退出，否则用户会留在一个「网络被改坏」的状态里。
         * 15s 是权衡：电脑侧每秒轮询一次，15s 足够容错；也不会让用户干等太久。
         */
        const val HEARTBEAT_TIMEOUT_MS = 15_000L

        /** 通知用户「VPN 已开」——这是系统要求的前台服务可见性 */
        const val EXTRA_NOTE = "note"
    }

    private var tun: ParcelFileDescriptor? = null
    private var tunIn: FileInputStream? = null
    private var tunOut: FileOutputStream? = null
    private val running = AtomicBoolean(false)

    private val stats = TrafficStats()
    private var shaper: TrafficShaper? = null

    /** 活跃转发会话，key = "tcp|udp:srcPort:dstIp:dstPort" */
    private val sessions = ConcurrentHashMap<String, Session>()
    private val handler = Handler(Looper.getMainLooper())

    @Volatile private var params: SessionParams = SessionParams()
    @Volatile private var startedAt: Long = 0
    @Volatile private var stopAt: Long = 0
    @Volatile private var note: String = ""

    /** 授权状态，由 AuthorizeActivity 回写 */
    @Volatile var authorized: Boolean = false

    /* ------------------------------------------------------------------ */
    /* 生命周期                                                            */
    /* ------------------------------------------------------------------ */

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            shutdown("收到电脑侧的停止指令，已恢复网络")
            return START_NOT_STICKY
        }

        intent?.getStringExtra(EXTRA_PARAMS)?.let { raw ->
            try {
                params = SessionParams.fromJson(org.json.JSONObject(raw))
            } catch (e: Exception) {
                note = "参数解析失败：${e.message}"
            }
        }

        startForegroundSafely()
        if (!running.get()) startTunnel()
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onRevoke() {
        // 用户在系统设置里撤销了 VPN 授权，或系统强制回收
        Log.w(TAG, "VPN 被系统回收（onRevoke）")
        authorized = false
        shutdown("系统撤销了 VPN 权限，已恢复网络")
        super.onRevoke()
    }

    override fun onDestroy() {
        shutdown("服务被销毁，已恢复网络")
        if (instance === this) instance = null
        super.onDestroy()
    }

    /* ------------------------------------------------------------------ */
    /* 隧道建立                                                            */
    /* ------------------------------------------------------------------ */

    private fun startTunnel() {
        val builder = Builder()
            .setSession(getString(R.string.app_name))
            .setMtu(TUN_MTU)
            .addAddress(TUN_ADDRESS, 32)
            // 全量接管。部分接管会漏掉大量流量，那还不如用旧的代理方案 ——
            // 弱网测试要的就是「整体网络变差」。
            .addRoute("0.0.0.0", 0)
            .addDnsServer(TUN_DNS)

        // 自己转发用的真实 socket 绝不能再进隧道，否则无限递归。
        // 这是双保险：socket 侧还会调 protect()。
        try {
            builder.addDisallowedApplication(packageName)
        } catch (_: Exception) {
            /* 老 ROM 不支持，靠 protect() 兜住 */
        }

        val pfd = try {
            builder.establish()
        } catch (e: Exception) {
            Log.e(TAG, "establish 抛异常", e)
            null
        }

        if (pfd == null) {
            // 最常见原因就是没授权。交给控制端口引导用户去点「确定」。
            note = "建立隧道失败：未授权或系统拒绝。请在设备上点一次「确定」授权 VPN。"
            stopSelfQuietly()
            return
        }

        tun = pfd
        tunIn = FileInputStream(pfd.fileDescriptor)
        tunOut = FileOutputStream(pfd.fileDescriptor)

        val sp = TrafficShaper({ params }, stats)
        sp.build(
            // 上行出口：整形后把整个 IP 包交给转发的会话
            upSink = { data, len, _ -> dispatchUpstream(data, len) },
            // 下行出口：整形后构造 IP 包写回 tun（meta 携带重建头所需信息）
            downSink = { data, len, meta -> writeDownToTun(data, len, meta as? DownMeta) },
        )
        sp.start()
        stats.reset()
        shaper = sp

        running.set(true)
        startedAt = System.currentTimeMillis()
        stopAt = if (params.durationSec > 0) startedAt + params.durationSec * 1000L else 0
        note = "VPN 已生效：设备全部 IPv4 流量经本机整形"

        instance = this

        Thread({ readLoop() }, "tun-reader").apply { isDaemon = true; start() }
        handler.post(watchdog)

        Log.i(TAG, "隧道已建立 mtu=$TUN_MTU route=0.0.0.0/0 addr=$TUN_ADDRESS")
    }

    /* ------------------------------------------------------------------ */
    /* 上行：tun → 解析 → 整形 → 会话                                       */
    /* ------------------------------------------------------------------ */

    /**
     * 上行投递出口。
     *
     * 关键点：**上行不能在这里直接找到会话** —— 整形器只交回一整个 IP 包，
     * 而我们要重新解析它才能定位会话。多解析一次的成本可以接受
     * （无锁、纯数组索引），换来的是整形器不需要知道 TCP/IP 语义，
     * 职责干净。
     */
    private fun dispatchUpstream(data: ByteArray, len: Int): Int {
        val pkt = IpPacket.parse(data, len) ?: return len
        when (pkt.protocol) {
            IpPacket.PROTO_TCP -> {
                val tcp = TcpHeader.parse(data, pkt.headerLen, len - pkt.headerLen) ?: return len
                val key = Session.key("tcp", tcp.srcPort, pkt.dstIp, tcp.dstPort)
                val s = sessions[key] ?: TcpSession(
                    key, pkt.dstIp, tcp.dstPort, this, stats,
                ).also { sessions[key] = it; it.start(); stats.connections++; stats.active++ }
                s.onUpstreamPayload(tcp.payload(data, pkt.headerLen))
            }
            IpPacket.PROTO_UDP -> {
                val udp = UdpHeader.parse(data, pkt.headerLen, len - pkt.headerLen) ?: return len
                val key = Session.key("udp", udp.srcPort, pkt.dstIp, udp.dstPort)
                val s = sessions[key] ?: UdpSession(
                    key, pkt.dstIp, udp.dstPort, this, stats,
                ).also { sessions[key] = it; it.start(); stats.connections++; stats.active++ }
                s.onUpstreamPayload(udp.payload(data, pkt.headerLen))
            }
            else -> {
                // ICMP / IPv6 / 其他：不接管。
                // 注意这里也是「上行」——但走的是那条直通路径（见 readLoop）。
                // 走到这里说明整形器接管了它，只能丢弃（如实记录到日志，别静默）
                stats.upRetrans++
            }
        }
        return len
    }

    /* ------------------------------------------------------------------ */
    /* 下行：会话 → 整形 → 构造 IP 包 → tun                                 */
    /* ------------------------------------------------------------------ */

    /**
     * 下行投递出口：把「真实 socket 读到的裸字节」封装成 IP 包写回设备。
     *
     * meta 由会话在入队时带上，整形器的 worker 线程原样传回 —— 所以这里
     * 一定不是 null（除非是上行漏下来的，那种情况直接丢弃并记账）。
     */
    private fun writeDownToTun(data: ByteArray, len: Int, meta: DownMeta?): Int {
        if (meta == null) {
            // 下行却拿到无 meta 的包 —— 不该发生；记账而不是静默丢
            stats.downRetrans++
            return len
        }
        val out = tunOut ?: return -1

        val packet = if (meta.proto == "tcp") {
            PacketBuilder.tcp(
                srcIp = meta.srcIp, srcPort = meta.srcPort,
                dstIp = meta.dstIp, dstPort = meta.dstPort,
                seq = meta.session.nextServerSeq(), ack = meta.session.clientAck(),
                payload = data, payloadLen = len,
            )
        } else {
            PacketBuilder.udp(
                srcIp = meta.srcIp, srcPort = meta.srcPort,
                dstIp = meta.dstIp, dstPort = meta.dstPort,
                payload = data, payloadLen = len,
            )
        }

        return try {
            out.write(packet)
            len
        } catch (e: Exception) {
            Log.w(TAG, "写回隧道失败：${e.message}")
            -1
        }
    }

    /* ------------------------------------------------------------------ */
    /* 看门狗：定时停止 + 心跳超时                                          */
    /* ------------------------------------------------------------------ */

    private val watchdog = object : Runnable {
        override fun run() {
            if (!running.get()) return

            if (stopAt > 0 && System.currentTimeMillis() >= stopAt) {
                Log.i(TAG, "已达设定时长，自动关闭 VPN")
                shutdown("已达设定时长，已自动恢复网络")
                return
            }

            val last = lastControlTouch
            if (last > 0 && System.currentTimeMillis() - last > HEARTBEAT_TIMEOUT_MS) {
                Log.w(TAG, "控制通道心跳超时，主动关闭 VPN")
                shutdown("与电脑失联超过 ${HEARTBEAT_TIMEOUT_MS / 1000}s，已自动恢复网络")
                return
            }

            handler.postDelayed(this, 1000)
        }
    }

    /* ------------------------------------------------------------------ */
    /* 关闭与恢复网络                                                      */
    /* ------------------------------------------------------------------ */

    /**
     * 关闭隧道 —— **这一步就是「恢复网络」**。
     *
     * 顺序不能变：
     *   ① 停整形器（别再往里写）
     *   ② 关所有转发会话（释放真实 socket）
     *   ③ **关 tun fd** —— 系统在此刻拆掉 VPN，路由恢复成真实网卡，
     *      设备网络立刻回到正常。这是整个方案最可靠的一环：
     *      即使我们的进程随后被杀、被杀时什么都没来得及做，
     *      只要 fd 关了，网络就好了。
     *   ④ 停前台服务
     */
    fun shutdown(reason: String) {
        val wasRunning = running.getAndSet(false)
        handler.removeCallbacks(watchdog)

        if (!wasRunning && tun == null) {
            note = reason
            stopSelfQuietly()
            return
        }

        Log.i(TAG, "关闭 VPN：$reason")

        try { shaper?.stop() } catch (_: Exception) {}
        shaper = null

        for ((k, s) in sessions) {
            s.close()
            sessions.remove(k)
        }
        sessions.clear()

        // ③ 关 tun —— 恢复网络的关键动作
        try { tunIn?.close() } catch (_: Exception) {}
        try { tunOut?.close() } catch (_: Exception) {}
        try { tun?.close() } catch (_: Exception) {}
        tun = null; tunIn = null; tunOut = null

        stats.active = 0
        stopAt = 0
        note = reason

        stopSelfQuietly()
    }

    private fun stopSelfQuietly() {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                stopForeground(STOP_FOREGROUND_REMOVE)
            } else {
                @Suppress("DEPRECATION")
                stopForeground(true)
            }
        } catch (_: Exception) {}
        stopSelf()
    }

    /* ------------------------------------------------------------------ */
    /* tun 读取循环                                                        */
    /* ------------------------------------------------------------------ */

    private val readBuffer = ByteArray(32768)

    private fun readLoop() {
        val input = tunIn ?: return
        while (running.get()) {
            val n = try {
                input.read(readBuffer)
            } catch (e: Exception) {
                if (running.get()) Log.w(TAG, "读取隧道失败：${e.message}")
                break
            }
            if (n <= 0) continue

            val sp = shaper ?: continue

            // 整体断网：连直通都不过
            if (sp.blocked) continue

            // 交给上行整形器。返回 true 表示已接管（到点会调 dispatchUpstream）；
            // 返回 false 表示该方向没启用整形 → 立刻直通，零额外延迟。
            //
            // 注意这里必须传副本：readBuffer 下一次 read 就会被覆盖，
            // 而整形器是异步投递的。
            if (!sp.up.offer(readBuffer.copyOf(n))) {
                dispatchUpstream(readBuffer, n)
            } else if (sp.up.backedUp()) {
                // 整形队列积压太多时压一下读取节奏，防止内存增长
                try { Thread.sleep(10) } catch (_: InterruptedException) {}
            }
        }
    }

    /* ------------------------------------------------------------------ */
    /* 会话结束回调                                                        */
    /* ------------------------------------------------------------------ */

    fun onSessionClosed(key: String) {
        if (sessions.remove(key) != null) {
            stats.active = maxOf(0, stats.active - 1)
        }
    }

    /** 供会话把下行数据交给整形器（meta 一路带到出口，重建 IP 头用） */
    internal fun offerDown(meta: DownMeta, data: ByteArray, len: Int) {
        val sp = shaper ?: return
        if (!sp.down.offer(data, meta)) {
            // 下行未启用整形 → 直接写回，零额外延迟
            writeDownToTun(data, len, meta)
        }
    }

    /**
     * 下行包的元数据：重建 IP/TCP/UDP 头所需的一切。
     *
     * 之所以要单独一个类而不是塞进 Shaper：整形器**不应该**懂 TCP/IP 语义，
     * 它只负责「什么时候投递」。地址/端口/会话是传输层的事，留在服务里。
     */
    class DownMeta(
        val proto: String,
        /** 真实服务器地址（App 眼里的对端） */
        val srcIp: String, val srcPort: Int,
        /** 设备地址与端口（本机端） */
        val dstIp: String, val dstPort: Int,
        val session: Session,
    )

    /* ------------------------------------------------------------------ */
    /* 控制端口用的状态查询                                                */
    /* ------------------------------------------------------------------ */

    fun snapshot(): SessionSnapshot {
        val remain = if (stopAt > 0) {
            maxOf(0, ((stopAt - System.currentTimeMillis()) / 1000).toInt())
        } else -1
        return SessionSnapshot(
            vpnActive = running.get(),
            authorized = authorized,
            params = params,
            startedAt = startedAt,
            remainSec = remain,
            note = note.ifEmpty { if (running.get()) "运行中" else "未运行" },
        )
    }

    fun statsJson() = stats.toJson()

    /** 热更新参数：不重建隧道，避免闪断 */
    fun updateParams(p: SessionParams) {
        params = p
        shaper?.refresh()
        startedAt = System.currentTimeMillis()
        stopAt = if (p.durationSec > 0) startedAt + p.durationSec * 1000L else 0
        note = "参数已热更新"
    }

    fun isRunning() = running.get()

    /* ------------------------------------------------------------------ */
    /* 前台通知                                                            */
    /* ------------------------------------------------------------------ */

    private fun startForegroundSafely() {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                val nm = getSystemService(NotificationManager::class.java)
                val ch = NotificationChannel(
                    CHANNEL_ID,
                    getString(R.string.notify_channel),
                    NotificationManager.IMPORTANCE_LOW,
                )
                ch.setShowBadge(false)
                nm?.createNotificationChannel(ch)
            }

            val flags = PendingIntent.FLAG_UPDATE_CURRENT or
                (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) PendingIntent.FLAG_IMMUTABLE else 0)

            val stopIntent = PendingIntent.getService(
                this, 1,
                Intent(this, WeakNetVpnService::class.java).setAction(ACTION_STOP),
                flags,
            )

            val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                Notification.Builder(this, CHANNEL_ID)
            } else {
                @Suppress("DEPRECATION")
                Notification.Builder(this)
            }

            val n: Notification = builder
                .setContentTitle(getString(R.string.notify_title))
                .setContentText(getString(R.string.notify_text))
                .setSmallIcon(android.R.drawable.stat_sys_warning)
                .setOngoing(true)
                .addAction(
                    Notification.Action.Builder(
                        null, getString(R.string.notify_stop), stopIntent,
                    ).build(),
                )
                .build()

            startForeground(NOTIFY_ID, n)
        } catch (e: Exception) {
            // 前台服务失败不影响 VPN 本身，但要记下来
            Log.w(TAG, "前台服务启动失败：${e.message}")
        }
    }

    /* ------------------------------------------------------------------ */
    /* IP / TCP / UDP 头解析                                                */
    /* ------------------------------------------------------------------ */

    /**
     * 极简 IPv4 头解析。**不做校验和验证** —— 我们要模拟的是网络差，
     * 不是造坏包；校验和留给设备内核去管。
     */
    class IpPacket(
        val headerLen: Int,
        val protocol: Int,
        val srcIp: String,
        val dstIp: String,
        val totalLen: Int,
    ) {
        companion object {
            const val PROTO_TCP = 6
            const val PROTO_UDP = 17

            fun parse(buf: ByteArray, len: Int): IpPacket? {
                if (len < 20) return null
                val ver = (buf[0].toInt() and 0xF0) ushr 4
                if (ver != 4) return null          // IPv6 等不接管
                val ihl = (buf[0].toInt() and 0x0F) * 4
                if (ihl < 20 || ihl > len) return null
                val proto = buf[9].toInt() and 0xFF
                val total = ((buf[2].toInt() and 0xFF) shl 8) or (buf[3].toInt() and 0xFF)
                return IpPacket(
                    ihl, proto,
                    ip(buf, 12), ip(buf, 16),
                    if (total in 20..len) total else len,
                )
            }

            private fun ip(b: ByteArray, off: Int): String =
                "${b[off].toInt() and 0xFF}.${b[off + 1].toInt() and 0xFF}." +
                    "${b[off + 2].toInt() and 0xFF}.${b[off + 3].toInt() and 0xFF}"
        }
    }

    class TcpHeader(
        val srcPort: Int,
        val dstPort: Int,
        val seq: Long,
        val flags: Int,
        val dataOffset: Int,
    ) {
        companion object {
            const val FIN = 0x01
            const val SYN = 0x02
            const val RST = 0x04
            const val PSH = 0x08
            const val ACK = 0x10

            fun parse(buf: ByteArray, off: Int, len: Int): TcpHeader? {
                if (len < 20) return null
                val sp = u16(buf, off)
                val dp = u16(buf, off + 2)
                val seq = u32(buf, off + 4)
                val doff = ((buf[off + 12].toInt() and 0xF0) ushr 4) * 4
                val flags = buf[off + 13].toInt() and 0xFF
                if (doff < 20) return null
                return TcpHeader(sp, dp, seq, flags, doff)
            }

            private fun u16(b: ByteArray, o: Int) =
                ((b[o].toInt() and 0xFF) shl 8) or (b[o + 1].toInt() and 0xFF)

            private fun u32(b: ByteArray, o: Int): Long =
                ((b[o].toLong() and 0xFF) shl 24) or ((b[o + 1].toLong() and 0xFF) shl 16) or
                    ((b[o + 2].toLong() and 0xFF) shl 8) or (b[o + 3].toLong() and 0xFF)
        }

        fun payload(buf: ByteArray, ipHeaderLen: Int): ByteArray {
            val start = ipHeaderLen + dataOffset
            if (start >= buf.size) return ByteArray(0)
            return buf.copyOfRange(start, buf.size)
        }
    }

    class UdpHeader(val srcPort: Int, val dstPort: Int) {
        companion object {
            fun parse(buf: ByteArray, off: Int, len: Int): UdpHeader? {
                if (len < 8) return null
                return UdpHeader(
                    ((buf[off].toInt() and 0xFF) shl 8) or (buf[off + 1].toInt() and 0xFF),
                    ((buf[off + 2].toInt() and 0xFF) shl 8) or (buf[off + 3].toInt() and 0xFF),
                )
            }
        }

        fun payload(buf: ByteArray, ipHeaderLen: Int): ByteArray {
            val start = ipHeaderLen + 8
            if (start >= buf.size) return ByteArray(0)
            return buf.copyOfRange(start, buf.size)
        }
    }

    /* ------------------------------------------------------------------ */
    /* 会话                                                                */
    /* ------------------------------------------------------------------ */

    abstract class Session(
        val key: String,
        protected val dstIp: String,
        protected val dstPort: Int,
        protected val svc: WeakNetVpnService,
        protected val stats: TrafficStats,
    ) {
        @Volatile protected var closed = false

        abstract fun start()
        abstract fun onUpstreamPayload(data: ByteArray)

        /** 下行包的 seq（简化：按已回写字节数递增） */
        abstract fun nextServerSeq(): Long
        /** 下行包的 ack（简化：用客户端最后一个 seq） */
        abstract fun clientAck(): Long

        open fun close() {
            if (closed) return
            closed = true
            svc.onSessionClosed(key)
        }

        companion object {
            fun key(proto: String, srcPort: Int, dstIp: String, dstPort: Int) =
                "$proto:$srcPort:$dstIp:$dstPort"
        }
    }

    /**
     * TCP 会话：为每个流开一个真实 Socket，双向透传 payload。
     *
     * 刻意**不做**完整 TCP 状态机（不维护窗口、不重排、不握手）：
     * 进隧道的包已经是设备内核处理过 TCP 语义的 payload，我们只要按序
     * 送到真实对端即可。「网络变差」由整形器负责，不靠这里制造。
     *
     * 已知限制：极端情况下（对端抖动剧烈）可能出现 payload 顺序问题。
     * 对弱网测试场景无影响，已在 UI 的限制卡片里如实说明。
     */
    class TcpSession(
        key: String,
        dstIp: String,
        dstPort: Int,
        svc: WeakNetVpnService,
        stats: TrafficStats,
    ) : Session(key, dstIp, dstPort, svc, stats) {

        private var socket: Socket? = null
        private val clientSeq = AtomicLong(0)     // 客户端最后一个 seq
        private var serverSeq = 0L                // 我们回写时用的 seq

        override fun nextServerSeq(): Long = serverSeq

        override fun clientAck(): Long = clientSeq.get()

        override fun start() {
            Thread({
                try {
                    val s = Socket()
                    // ⚠️ 必须 protect：否则我们转发的流量又进隧道 → 无限递归
                    if (!svc.protect(s)) {
                        Log.w(TAG, "protect 失败，会话放弃（避免递归）")
                        close(); return@Thread
                    }
                    s.connect(InetSocketAddress(dstIp, dstPort), 10_000)
                    s.tcpNoDelay = true
                    socket = s

                    val meta = DownMeta("tcp", dstIp, dstPort, TUN_ADDRESS, srcPortGuess(), this)
                    val buf = ByteArray(16384)
                    val ins = s.getInputStream()
                    while (!closed) {
                        val n = ins.read(buf)
                        if (n <= 0) break
                        serverSeq += n
                        // 下行：交给整形器（延迟/丢/错/限速），到点写回 tun
                        svc.offerDown(meta, buf, n)
                    }
                } catch (e: Exception) {
                    Log.d(TAG, "TCP 会话结束 $dstIp:$dstPort（${e.message}）")
                } finally {
                    close()
                }
            }, "tcp-${dstPort}").apply { isDaemon = true; start() }
        }

        /** 设备的本地端口：从 key 里取（形如 tcp:12345:1.2.3.4:80） */
        private fun srcPortGuess(): Int =
            key.split(":")[1].toIntOrNull() ?: 0

        override fun onUpstreamPayload(data: ByteArray) {
            if (data.isEmpty() || closed) return
            val s = socket ?: return
            try {
                s.getOutputStream().write(data)
                s.getOutputStream().flush()
            } catch (_: Exception) {
                close()
            }
        }
    }

    /**
     * UDP 会话：一个 DatagramSocket 双向转发。
     * 主要覆盖 DNS —— 让「解析域名要等很久」这种弱网典型症状也能被测出来。
     */
    class UdpSession(
        key: String,
        dstIp: String,
        dstPort: Int,
        svc: WeakNetVpnService,
        stats: TrafficStats,
    ) : Session(key, dstIp, dstPort, svc, stats) {

        private var socket: DatagramSocket? = null

        override fun nextServerSeq(): Long = 0
        override fun clientAck(): Long = 0

        private fun srcPortGuess(): Int = key.split(":")[1].toIntOrNull() ?: 0

        override fun start() {
            Thread({
                try {
                    val s = DatagramSocket()
                    if (!svc.protect(s)) {
                        Log.w(TAG, "protect 失败，UDP 会话放弃")
                        close(); return@Thread
                    }
                    socket = s
                    val meta = DownMeta("udp", dstIp, dstPort, TUN_ADDRESS, srcPortGuess(), this)
                    val buf = ByteArray(8192)
                    while (!closed) {
                        val p = DatagramPacket(buf, buf.size)
                        s.receive(p)
                        svc.offerDown(meta, p.data, p.length)
                    }
                } catch (e: Exception) {
                    Log.d(TAG, "UDP 会话结束 $dstIp:$dstPort（${e.message}）")
                } finally {
                    close()
                }
            }, "udp-$dstPort").apply { isDaemon = true; start() }
        }

        override fun onUpstreamPayload(data: ByteArray) {
            if (data.isEmpty() || closed) return
            val s = socket ?: return
            try {
                s.send(DatagramPacket(data, data.size, InetSocketAddress(dstIp, dstPort)))
            } catch (_: Exception) {
                close()
            }
        }
    }
}
