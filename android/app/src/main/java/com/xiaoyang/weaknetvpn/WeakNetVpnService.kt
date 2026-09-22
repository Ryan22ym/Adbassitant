package com.xiaoyang.weaknetvpn

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
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
 *   3. 需要 `protect()` 真实 socket，否则自己转发出去的流量又进隧道 → 递归。
 *      本应用同时用 `addDisallowedApplication` 把自己整个排除在隧道外，
 *      所以 `protect()` 失败**不构成递归风险**，此时继续转发而不是丢弃会话
 *      （见 [protectForward]：旧实现一失败就丢会话，表现就是"开了弱网等于断网"）
 *   4. 不做 DNS 劫持，所以**绝不能**把 DNS 指向 tun 的虚拟地址 ——
 *      必须指向真实解析器，见 [FALLBACK_DNS]
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
        private const val TUN_MTU = 1500

        /**
         * DNS 兜底（只有在读不到底层网络 DNS 时才用）。
         *
         * 🔴 这里**绝对不能**填 tun 自己的虚拟地址（曾经是 `10.215.0.1`）。
         * 原因：`addDnsServer` 设了谁，系统就把**全部应用的 DNS 查询**发到那个地址；
         * 那个地址只存在于 tun 内部、真实网络里根本不存在，必须由隧道劫持后改写目的地
         * 再转发出去。本实现没做 DNS 劫持，于是每条 DNS 查询都变成「连一个不存在的地址」
         * —— 10s 超时后失败。结果就是：**VPN 一开，所有应用的域名解析全废，等于断网**
         * （症状：隧道 stats 里 connections 一直涨、downBytes 恒为 0）。
         *
         * 正确做法：直接告诉系统用**底层网络真实在用的 DNS**，这样查询进隧道后
         * 我们能原样转发给真实 DNS，回包源地址也对得上，不需要任何改写。
         */
        private const val FALLBACK_DNS = "223.5.5.5"

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

    /**
     * 是否已把「本应用」排除在隧道之外（addDisallowedApplication 成功）。
     *
     * 这个标志决定 protect() 失败时能不能继续：
     *   · true  → 本进程的 socket 天然绕过隧道，protect() 只是双保险，
     *             失败也**不构成递归风险**，继续转发即可（否则整条隧道变成黑洞）
     *   · false → protect() 是唯一防线，失败必须放弃会话
     *
     * 实测（MuMu 模拟器 / Android 12）：protect() 会返回 false，而
     * addDisallowedApplication 是成功的。旧逻辑把这两种情况一视同仁地当致命错误，
     * 结果所有进隧道的连接都被丢弃（stats.downBytes 恒为 0，网络等于被掐断）。
     */
    @Volatile private var selfDisallowed = false

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

        // DNS 必须指向**真实存在**的解析器，见 FALLBACK_DNS 的注释。
        val dns = underlyingDnsV4()
        dns.forEach { builder.addDnsServer(it) }
        Log.i(TAG, "隧道 DNS = $dns")

        // 自己转发用的真实 socket 绝不能再进隧道，否则无限递归。
        // 这是双保险：socket 侧还会调 protect()。
        selfDisallowed = false
        try {
            builder.addDisallowedApplication(packageName)
            selfDisallowed = true
        } catch (e: Exception) {
            /* 老 ROM 不支持，靠 protect() 兜住 */
            Log.w(TAG, "addDisallowedApplication 不支持，只能依赖 protect()：${e.message}")
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

        Log.i(TAG, "隧道已建立 mtu=$TUN_MTU route=0.0.0.0/0 addr=$TUN_ADDRESS selfDisallowed=$selfDisallowed")
    }

    /**
     * 取底层网络正在使用的 IPv4 DNS 地址。
     *
     * 为什么要这一步：隧道必须给系统一个**真实存在**的 DNS（见 [FALLBACK_DNS]）。
     * 继承底层网络的好处是行为与不开弱网时完全一致 —— 内网域名、运营商 DNS 都照旧，
     * 只是多绕了一跳隧道并受整形影响。读不到（无网络 / 无权限）才回退公共解析器。
     *
     * 注意必须在 `establish()` **之前**调用：隧道一起来，activeNetwork 可能就不是底层网络了。
     */
    private fun underlyingDnsV4(): List<String> {
        val fromNetwork = try {
            val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
            // activeNetwork 是 API 23 才有的，minSdk 21 要挡一下
            val lp = if (cm != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                cm.activeNetwork?.let { cm.getLinkProperties(it) }
            } else null
            lp?.dnsServers
                ?.mapNotNull { it.hostAddress }
                ?.filter { it.isNotBlank() && !it.contains(':') && it != "127.0.0.1" }
                ?.distinct()
                ?.take(3)
                .orEmpty()
        } catch (e: Exception) {
            Log.w(TAG, "读取底层网络 DNS 失败：${e.message}")
            emptyList()
        }
        return fromNetwork.ifEmpty { listOf(FALLBACK_DNS) }
    }

    /* ------------------------------------------------------------------ */
    /* 转发 socket 的「绕过隧道」保护                                        */
    /* ------------------------------------------------------------------ */

    /**
     * 给转发用的真实 socket 打「绕过隧道」标记；返回 **是否可以继续使用该会话**。
     *
     * 语义（这是本项目踩过的坑，别改回去）：
     *   · protect() 成功                     → 继续
     *   · protect() 失败 + 本应用已排除在隧道外 → 继续（socket 本来就绕过隧道，
     *                                            protect 只是双保险，失败无影响）
     *   · protect() 失败 + 未排除            → 放弃（否则流量会无限递归）
     *
     * 旧实现把第二种情况也当致命错误 → 隧道变成黑洞：所有流量有去无回，
     * 表现为「开了弱网等于断网」（stats.upBytes 涨、downBytes 恒为 0）。
     */
    internal fun protectForward(s: Socket): Boolean {
        if (protect(s)) return true
        if (selfDisallowed) {
            Log.w(TAG, "protect() 返回 false，但本应用已在 VPN 排除名单内 → 继续转发")
            return true
        }
        Log.w(TAG, "protect() 失败且本应用未排除 → 放弃会话（避免递归）")
        return false
    }

    /** 见 [protectForward] */
    internal fun protectForward(s: DatagramSocket): Boolean {
        if (protect(s)) return true
        if (selfDisallowed) {
            Log.w(TAG, "protect() 返回 false，但本应用已在 VPN 排除名单内 → 继续转发（UDP）")
            return true
        }
        Log.w(TAG, "protect() 失败且本应用未排除 → 放弃 UDP 会话")
        return false
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
                // SYN 没有 payload 但**必须**处理（要回 SYN-ACK），所以整包交给会话
                val payload = tcp.payload(data, pkt.headerLen)
                val bare = payload.isEmpty() && (tcp.flags and TcpHeader.SYN) == 0 &&
                    (tcp.flags and TcpHeader.FIN) == 0 && (tcp.flags and TcpHeader.RST) == 0
                if (bare) return len // 纯 ACK：无需理会

                val key = Session.key("tcp", tcp.srcPort, pkt.dstIp, tcp.dstPort)
                val s = sessions[key] ?: TcpSession(
                    key, pkt.dstIp, tcp.dstPort, this, stats,
                ).also { sessions[key] = it; it.start(); stats.connections++; stats.active++ }
                s.onUpstream(tcp, payload)
            }
            IpPacket.PROTO_UDP -> {
                val udp = UdpHeader.parse(data, pkt.headerLen, len - pkt.headerLen) ?: return len
                val key = Session.key("udp", udp.srcPort, pkt.dstIp, udp.dstPort)
                val s = sessions[key] ?: UdpSession(
                    key, pkt.dstIp, udp.dstPort, this, stats,
                ).also { sessions[key] = it; it.start(); stats.connections++; stats.active++ }
                if (s is UdpSession) s.onUpstream(null, udp.payload(data, pkt.headerLen))
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
                seq = meta.seq, ack = meta.ack,
                payload = data, payloadLen = len,
                flags = meta.flags,
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
        /**
         * 下面三个是 TCP 重建头用的，**必须由入队时的会话现场填**，不能等到出口再算。
         *
         * 为什么：整形器是异步投递的，多个包可能同时在队列里；出口再读「会话当前 seq」
         * 会把先入队的包写成后到的 seq（旧实现就是这么错的 —— 拿 `serverSeq` 现读，
         * 结果每个下行包都带上了「读完自己之后」的 seq，设备侧全是乱序包）。
         */
        val seq: Long = 0,
        val ack: Long = 0,
        val flags: Int = 0x18, // PSH|ACK
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

        /**
         * 上行数据到达。
         *
         * TCP 需要看到**头部**（SYN/FIN 标志、seq），否则无法完成三次握手 ——
         * 见 [TcpSession] 的注释。UDP 只需要 payload。
         */
        abstract fun onUpstream(header: TcpHeader?, payload: ByteArray)

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
     * TCP 会话：为每个流开一个真实 Socket 转发，并**代为完成设备的 TCP 三次握手**。
     *
     * 🔴 为什么必须自己回 SYN-ACK（本项目最大的一个坑）
     * ------------------------------------------------------------
     * tun 回写方向的包会被设备内核当作「从网络收到的包」直接交给它的 TCP 栈。
     * 设备发过 SYN 之后处于 SYN_SENT：**除了带 SYN 的包，其它一律丢弃（并回 RST）**。
     * 所以如果我们只是把服务器返回的 payload 包成 PSH|ACK 写回去，
     * 设备会认为「这不是我期待的 SYN-ACK」→ 连接永远建不起来。
     *
     * 症状（曾真实发生过）：
     *   · 隧道 stats 里 `connections` / `upBytes` / `downBytes` 都在涨，
     *     看起来「有流量、整形也在跑」；
     *   · 但设备上**所有应用都上不了网** —— 因为握手从没完成过。
     *   用 `adb shell curl` 测不出来（uid 2000 本来就不进 VPN），
     *   必须用真实应用（浏览器）才暴露。
     *
     * 于是这里维护一个最小但正确的状态机：
     *   · SYN       → 记录设备 ISN，连真实服务器，成功后回 SYN-ACK（seq=我们的 ISN）
     *   · payload   → 写进真实 socket，并**立刻回 ACK**（否则设备发送窗口很快填满，只靠重传推进）
     *   · 服务器数据 → 带正确 seq/ack 的 PSH|ACK 写回（seq 在入队时就固定，见 DownMeta）
     *   · FIN       → 双方各回一次 FIN|ACK
     *   · 服务器断开 → 主动回 FIN
     *
     * 已知限制：不做窗口管理和重排（对弱网测试够用），ACK 是逐包回的（比真实 TCP 略啰嗦）。
     */
    class TcpSession(
        key: String,
        dstIp: String,
        dstPort: Int,
        svc: WeakNetVpnService,
        stats: TrafficStats,
    ) : Session(key, dstIp, dstPort, svc, stats) {

        private val clientPort = key.split(":")[1].toIntOrNull() ?: 0
        private var socket: Socket? = null

        /** 下一个期望从设备收到的 seq */
        @Volatile private var clientNext = 0L
        /** 下一个要发给设备的 seq */
        @Volatile private var serverNext = 0L
        @Volatile private var established = false
        @Volatile private var finSent = false

        private val connectStarted = AtomicBoolean(false)

        /** 我们对外声明的 ISN（下行起始序号）。取值随意，只要 32 位内不撞车 */
        private val serverIsn = (System.nanoTime() ushr 5) and 0xFFFF_FFFFL

        /** 拿到 SYN 的 seq 之前不连 —— 所以这里什么都不做 */
        override fun start() = Unit

        private fun meta(seq: Long, ack: Long, flags: Int) = DownMeta(
            "tcp", dstIp, dstPort, TUN_ADDRESS, clientPort, this, seq, ack, flags,
        )

        /** 把控制包（SYN-ACK / ACK / FIN / RST）交给整形器下行出口 */
        private fun sendControl(flags: Int, seq: Long, ack: Long) {
            if (closed && flags != TcpHeader.RST) return
            svc.offerDown(meta(seq, ack, flags), EMPTY, 0)
        }

        private fun sendAck() {
            if (!established) return
            sendControl(TcpHeader.ACK, serverNext, clientNext)
        }

        private fun sendFin() {
            if (finSent) return
            finSent = true
            sendControl(TcpHeader.FIN or TcpHeader.ACK, serverNext, clientNext)
        }

        override fun onUpstream(header: TcpHeader?, payload: ByteArray) {
            val h = header ?: return
            if (h.flags and TcpHeader.RST != 0) { close(); return }

            if (h.flags and TcpHeader.SYN != 0) { onSyn(h.seq); return }

            if (payload.isNotEmpty()) {
                clientNext = (h.seq + payload.size) and 0xFFFF_FFFFL
                // 先 ACK 再转发：ACK 走的是控制包通道，不受 payload 队列积压影响
                sendAck()
                val s = socket
                if (s != null) {
                    try {
                        s.getOutputStream().write(payload)
                        s.getOutputStream().flush()
                    } catch (_: Exception) { close() }
                }
            }

            if (h.flags and TcpHeader.FIN != 0) {
                clientNext = (clientNext + 1) and 0xFFFF_FFFFL
                sendAck()
                try { socket?.close() } catch (_: Exception) {}
                close()
            }
        }

        /** 收到 SYN：记录设备 ISN 并连真实服务器；SYN 重传时重发 SYN-ACK */
        private fun onSyn(seq: Long) {
            clientNext = (seq + 1) and 0xFFFF_FFFFL
            if (!connectStarted.compareAndSet(false, true)) {
                if (established) sendControl(TcpHeader.SYN or TcpHeader.ACK, serverIsn, clientNext)
                return
            }
            serverNext = (serverIsn + 1) and 0xFFFF_FFFFL
            Thread({ connectAndRelay() }, "tcp-$dstPort").apply { isDaemon = true; start() }
        }

        private fun connectAndRelay() {
            try {
                val s = Socket()
                // 必须 protect：否则我们转发的流量又进隧道 → 无限递归
                if (!svc.protectForward(s)) {
                    Log.w(TAG, "TCP 会话放弃：无法把转发 socket 排除在隧道外 $dstIp:$dstPort")
                    close(); return
                }
                s.connect(InetSocketAddress(dstIp, dstPort), 10_000)
                s.tcpNoDelay = true
                socket = s
                established = true
                Log.i(TAG, "已连上真实服务器 $dstIp:$dstPort（本地 ${s.localAddress}:${s.localPort}）")

                // 握手第二步
                sendControl(TcpHeader.SYN or TcpHeader.ACK, serverIsn, clientNext)

                val buf = ByteArray(16384)
                val ins = s.getInputStream()
                while (!closed) {
                    val n = ins.read(buf)
                    if (n <= 0) break
                    // ⚠️ seq 必须在**入队前**取好：整形器是异步的，
                    //    出口再读 serverNext 会拿到后来的值（旧 bug）
                    val seq = serverNext
                    serverNext = (serverNext + n) and 0xFFFF_FFFFL
                    svc.offerDown(
                        meta(seq, clientNext, TcpHeader.PSH or TcpHeader.ACK),
                        buf.copyOf(n), n,
                    )
                }
                sendFin()
            } catch (e: Exception) {
                Log.d(TAG, "TCP 会话结束 $dstIp:$dstPort（${e.message}）")
                sendControl(TcpHeader.RST, serverNext, clientNext)
            } finally {
                close()
            }
        }

        override fun close() {
            super.close()
            try { socket?.close() } catch (_: Exception) {}
        }

        companion object {
            private val EMPTY = ByteArray(0)
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
        private val upCount = java.util.concurrent.atomic.AtomicInteger()
        private val downCount = java.util.concurrent.atomic.AtomicInteger()

        private fun srcPortGuess(): Int = key.split(":")[1].toIntOrNull() ?: 0

        /**
         * ⚠️ socket 必须**同步**建好再返回。
         *
         * 旧实现把 `DatagramSocket()` 放在新线程里，而上游包是紧接着 `start()` 之后
         * 由同一条调用链送进来的（`sessions[k] = it; it.start(); s.onUpstream(...)`）。
         * 那个竞态窗口里 `socket == null` → `onUpstream` 直接 return → **首包被静默丢弃**。
         * 对 TCP 无所谓（有重传），对 **DNS 是致命的**：解析器的第一个查询被吃掉，
         * 要等它自己超时重试 —— 实测真机上表现为「每次域名解析都恒定卡 ~20 秒」，
         * 而 IP 直连只要 120ms。DNS 走 UDP，没有任何一层会帮我们补这个包。
         */
        override fun start() {
            val s = try {
                DatagramSocket()
            } catch (e: Exception) {
                Log.w(TAG, "UDP socket 创建失败 $dstIp:$dstPort（${e.message}）")
                close(); return
            }
            if (!svc.protectForward(s)) {
                Log.w(TAG, "UDP 会话放弃：无法把转发 socket 排除在隧道外 $dstIp:$dstPort")
                s.close(); close(); return
            }
            socket = s
            Log.i(TAG, "UDP 会话建立 $dstIp:$dstPort（设备端口 ${srcPortGuess()}）")

            Thread({
                try {
                    val meta = DownMeta("udp", dstIp, dstPort, TUN_ADDRESS, srcPortGuess(), this)
                    val buf = ByteArray(8192)
                    while (!closed) {
                        val p = DatagramPacket(buf, buf.size)
                        s.receive(p)
                        downCount.incrementAndGet()
                        svc.offerDown(meta, p.data.copyOf(p.length), p.length)
                    }
                } catch (e: Exception) {
                    Log.d(TAG, "UDP 会话结束 $dstIp:$dstPort（上游 ${upCount.get()} 包 / 下游 ${downCount.get()} 包，${e.message}）")
                } finally {
                    close()
                }
            }, "udp-$dstPort").apply { isDaemon = true; start() }
        }

        override fun onUpstream(header: TcpHeader?, data: ByteArray) {
            if (data.isEmpty() || closed) return
            val s = socket ?: return
            try {
                upCount.incrementAndGet()
                s.send(DatagramPacket(data, data.size, InetSocketAddress(dstIp, dstPort)))
            } catch (_: Exception) {
                close()
            }
        }
    }
}
