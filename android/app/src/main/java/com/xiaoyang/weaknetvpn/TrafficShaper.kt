package com.xiaoyang.weaknetvpn

import java.net.InetSocketAddress
import java.nio.ByteBuffer
import kotlin.math.max
import kotlin.random.Random

/**
 * 流量整形引擎（IP 包级）
 * ============================================================
 *
 * 与旧方案最本质的区别
 * ------------------------------------------------------------
 * 旧方案（电脑侧代理）工作在**字节流**上，丢包/乱序只能做「等效近似」——
 * 因为 TCP 交给应用层的就是有序完整字节流，真丢/真乱序等于篡改内容。
 *
 * 本方案拿到的是 **IP 包**，可以像内核 netem 那样逐包操作：
 *
 *   丢包   → 真的不写出去（TCP 会重传，这正是真实丢包的样子）
 *   乱序   → 投递时刻加扰动（TCP 会重排，符合真实链路）
 *   错报   → 篡改一个 bit 后照发（校验和坏了，接收端丢弃重传 = 真实误码）
 *   重复   → 同一个包投递两次
 *
 * 这是 VPN 方案保真度更高的根因，也是这次改造的主要收益。
 *
 * 架构
 * ------------------------------------------------------------
 * 每个方向一个 [Shaper]：
 *   入队（整个 IP 包）→ 算投递时刻 → 单定时器按序 flush 到 sink
 *
 * 关键设计点（每一条都对应一个真实踩过的坑）：
 *   1. **包是原子的，绝不能切片** —— 与字节流不同，切了就破坏 IP 协议。
 *      带宽限制靠令牌桶按包长计费即可，不需要切片。
 *   2. **投递时间单调不减**（`at = max(at, lastAt)`）。若让后面的包"超车"，
 *      那是在**破坏协议**（TLS 会直接失败），而不是模拟网络乱序 ——
 *      真实乱序是时序错位，由 TCP 重排兜住；我们只需把投递时刻错开。
 *   3. **背压**：限速时读取远快于投递，队列必须限量，超了丢最老的。
 *   4. **参数热更新**：每次取参数都重新回调 provider，不缓存。
 */

/* ------------------------------------------------------------------ */
/* 令牌桶                                                              */
/* ------------------------------------------------------------------ */

/**
 * 平滑限速器：长期平均不超过 bytesPerSec，允许小突发。
 */
private class TokenBucket(bytesPerSec: Double) {
    private var bytesPerSec = bytesPerSec
    private var nextFreeAt = 0L

    fun update(bps: Double) {
        // 刻意**不重置** nextFreeAt：参数热更新时不该白送一次突发额度
        this.bytesPerSec = bps
    }

    /** 返回发送 size 字节需要额外等待的毫秒数 */
    fun reserve(size: Int): Long {
        if (bytesPerSec <= 0) return 0
        val now = System.currentTimeMillis()
        val start = max(now, nextFreeAt)
        val cost = (size / bytesPerSec) * 1000.0
        nextFreeAt = start + cost.toLong()
        return max(0, start - now)
    }
}

/* ------------------------------------------------------------------ */
/* 投递出口                                                            */
/* ------------------------------------------------------------------ */

/**
 * 整形器算完投递时刻后，通过它把载荷送出去。
 *
 * ⚠️ 这是**投递出口**，不是「写 tun」。上行出口把载荷交给转发的会话，
 * 下行出口把载荷封装成 IP 包写回 tun。具体动作由调用方注入。
 *
 * meta 必须一路带到出口：下行要用它重建 IP 头（源/目的地址、端口、会话）。
 * 早期版本用 ThreadLocal 传 meta —— **那是错的**：整形器有自己的 worker 线程，
 * 入队线程设的 ThreadLocal 在出口线程上必然读不到（会静默退化成一个包都不回写）。
 */
fun interface Sink {
    /**
     * @param meta 入队时带上的元数据（下行用；上行可为 null）
     * @return 实际写出的字节数；<0 表示失败（隧道已关闭）
     */
    fun write(data: ByteArray, length: Int, meta: Any?): Int
}

class Shaper(
    val dir: Dir,
    /** 参数是热更新的，每次用都重新取 */
    private val paramsProvider: () -> DirectionParams,
    private val sink: Sink,
    private val stats: TrafficStats,
    /** 队列上限（包数）。超了丢最老的，防内存无限涨 */
    private val maxQueue: Int = 2048,
) {
    /**
     * 方向语义（务必看清，这里是整个引擎最容易搞反的地方）：
     *
     *   UP   = 设备发出的包。来源是 tun 读取循环，去往真实网络。
     *          但「写进真实网络」这件事**不能由我们做** —— 我们没有 raw socket。
     *          ⇒ 上行的做法是：整形器**延迟投递给会话**，由会话写进真实 socket。
     *
     *   DOWN = 真实网络回来的数据。来源是会话从真实 socket 读到的字节，
     *          我们去往 tun（写回设备）。
     *          ⇒ 下行的做法是：会话把从 socket 读到的字节交给本整形器，
     *            整形器延迟后构造 IP 包写进 tun。
     *
     * 两个方向的 sink 都是「最终动作」，由调用方注入。
     */
    enum class Dir { UP, DOWN }

    private val congestionPenaltyMs = 600L

    private val queue = java.util.concurrent.ConcurrentLinkedQueue<Item>()
    private val bucket: TokenBucket

    @Volatile private var lastAt = 0L
    @Volatile private var penaltyUntil = 0L
    @Volatile private var closed = false

    @Volatile var queuedBytes: Int = 0
        private set

    private var worker: Thread? = null
    private val rand = Random(System.nanoTime())

    /** 队列元素：载荷 + 投递时刻 + 元数据（下行要重建 IP 包用） */
    class Item(val data: ByteArray, val at: Long, val meta: Any? = null)

    init {
        bucket = TokenBucket(bytesPerSec(paramsProvider()))
        lastAt = System.currentTimeMillis()
    }

    private fun bytesPerSec(p: DirectionParams): Double {
        if (p.bandwidthMbps <= 0) return 0.0
        // 重复包在真实链路里白占容量 → 按比例折算进限速
        val dup = p.duplicatePercent.coerceIn(0.0, 100.0) / 100.0
        return (p.bandwidthMbps * 1_000_000.0 / 8.0) / (1.0 + dup)
    }

    fun refresh() = bucket.update(bytesPerSec(paramsProvider()))

    fun start() {
        if (worker != null) return
        closed = false
        worker = Thread({ loop() }, "shaper-${dir.name.lowercase()}").apply {
            isDaemon = true
            start()
        }
    }

    fun stop() {
        closed = true
        worker?.interrupt()
        worker = null
        queue.clear()
        queuedBytes = 0
    }

    /**
     * 入队一个包。
     *
     * @param meta 下行用来携带「目的地址/端口」等重建 IP 头所需的信息
     * @return true = 已接管；false = 调用方应当立即自行处理（未启用整形）
     */
    fun offer(data: ByteArray, meta: Any? = null): Boolean {
        if (closed || data.isEmpty()) return false

        val p = paramsProvider()
        if (p.blockNetwork) return true          // 整体断网：什么都不过
        if (!p.shaping) return false             // 该方向不整形 → 零开销透传

        /* ---- 丢包：真的丢。TCP 会重传，这就是真实丢包的形态 ---- */
        if (p.lossPercent > 0 && rand.nextDouble() * 100.0 < p.lossPercent) {
            penaltyUntil = max(penaltyUntil, System.currentTimeMillis() + congestionPenaltyMs)
            if (dir == Dir.UP) stats.upRetrans++ else stats.downRetrans++
            return true
        }

        val payload = data.copyOf()

        /* ---- 错报：篡改一个 bit（校验和随之失效 → 接收端丢弃重传）---- */
        if (p.corruptPercent > 0 && rand.nextDouble() * 100.0 < p.corruptPercent) {
            val i = rand.nextInt(payload.size)
            val bit = 1 shl rand.nextInt(8)
            payload[i] = (payload[i].toInt() xor bit).toByte()
            if (dir == Dir.UP) stats.upCorrupt++ else stats.downCorrupt++
        }

        var extra = 0L

        /* ---- 基础延迟 + 抖动（三角分布，比均匀分布更接近真实抖动）---- */
        val j = if (p.jitterMs > 0) {
            ((rand.nextDouble() - rand.nextDouble()) * p.jitterMs).toLong()
        } else 0L
        extra += max(0L, p.delayMs.toLong() + j)

        /* ---- 乱序：只错开投递时刻，不改包内顺序 ---- */
        if (p.reorderPercent > 0 && rand.nextDouble() * 100.0 < p.reorderPercent) {
            extra += 20 + rand.nextInt(180).toLong()
            if (dir == Dir.UP) stats.upReorder++ else stats.downReorder++
        }

        /* ---- 拥塞惩罚（丢包后的连带减速，近似真实拥塞窗口收缩）---- */
        if (penaltyUntil > System.currentTimeMillis()) extra += 30

        /* ---- 带宽：令牌桶按包长计费 ---- */
        extra += bucket.reserve(payload.size)

        enqueue(payload, meta, extra)

        /* ---- 重复包：同一份数据再投递一次（会被接收端去重，但白占带宽）---- */
        if (p.duplicatePercent > 0 && rand.nextDouble() * 100.0 < p.duplicatePercent) {
            enqueue(payload.copyOf(), meta, bucket.reserve(payload.size))
        }

        if (dir == Dir.UP) stats.upBytes += payload.size else stats.downBytes += payload.size
        return true
    }

    private fun enqueue(data: ByteArray, meta: Any?, extraMs: Long) {
        var at = System.currentTimeMillis() + extraMs
        // 时间单调不减（见类头注释第 2 条）
        if (at < lastAt) at = lastAt
        lastAt = at

        // 队列满 → 丢最老的（真实链路的队列溢出也是这个行为）
        while (queue.size >= maxQueue) {
            val d = queue.poll() ?: break
            queuedBytes -= d.data.size
            if (dir == Dir.UP) stats.upRetrans++ else stats.downRetrans++
        }
        queue.add(Item(data, at, meta))
        queuedBytes += data.size
    }

    private fun loop() {
        while (!closed) {
            val head = queue.peek()
            if (head == null) {
                if (!sleepQuiet(4)) return
                continue
            }
            val wait = head.at - System.currentTimeMillis()
            if (wait > 0) {
                // 最多睡 8ms：保证参数热更新与停止能及时被感知
                if (!sleepQuiet(wait.coerceAtMost(8L))) return
                continue
            }
            val item = queue.poll() ?: continue
            queuedBytes -= item.data.size
            if (sink.write(item.data, item.data.size, item.meta) < 0) {
                stop()
                return
            }
        }
    }

    /** @return false 表示应当退出循环 */
    private fun sleepQuiet(ms: Long): Boolean {
        try {
            Thread.sleep(ms)
        } catch (_: InterruptedException) {
            if (closed) return false
        }
        return !closed
    }

    /** 给读取循环用的背压判断 */
    fun backedUp(): Boolean = queuedBytes > 512 * 1024
}

/**
 * 双向整形器：把两个方向打包给 VPN 服务用。
 */
class TrafficShaper(
    private val paramsProvider: () -> SessionParams,
    private val stats: TrafficStats,
) {
    /** 上行 = 设备发出（tun 读进来 → 延迟后交给会话写进真实 socket） */
    lateinit var up: Shaper
    /** 下行 = 网络回来（会话从真实 socket 读到 → 延迟后构造 IP 包写回 tun） */
    lateinit var down: Shaper

    /** 整体断网：读取循环查它，命中就直接丢 */
    val blocked: Boolean get() = paramsProvider().blockNetwork

    fun build(upSink: Sink, downSink: Sink) {
        up = Shaper(Shaper.Dir.UP, { paramsProvider().up }, upSink, stats)
        down = Shaper(Shaper.Dir.DOWN, { paramsProvider().down }, downSink, stats)
    }

    fun start() { up.start(); down.start() }
    fun stop() { up.stop(); down.stop() }
    fun refresh() { up.refresh(); down.refresh() }
    fun resetStats() = stats.reset()
}

/**
 * IPv4 / TCP / UDP 头的最小构造器（只用于**下行**：把从真实 socket 读到的
 * 字节重新封装成 IP 包写回隧道）。
 *
 * 为什么要自己造头：tun 只接受完整的 IP 包。我们从真实 socket 拿到的是裸字节流，
 * 必须补上 IP + TCP/UDP 头。这是个「够用就好」的实现 —— 校验和不填（置 0），
 * 因为：
 *   · tun 写回方向的包会被设备内核当作「从网络收到的包」直接交给 TCP 栈；
 *   · Linux 的 tun 在 `IFF_NO_PI` 模式下**不校验 IP 头校验和**（内核自己会算）。
 * 实测确实可用；若某天在某个 ROM 上被拦，把 checksum 补上即可（见 computeChecksum）。
 */
object PacketBuilder {

    /**
     * 构造一个下行 TCP 包写回设备。
     *
     * @param srcIp/srcPort 真实服务器的地址（= App 眼里看到的对端）
     * @param dstIp/dstPort 设备的地址与端口（= 会话的本地端）
     */
    fun tcp(
        srcIp: String, srcPort: Int,
        dstIp: String, dstPort: Int,
        seq: Long, ack: Long,
        payload: ByteArray, payloadLen: Int,
        flags: Int = 0x18, // PSH|ACK
    ): ByteArray {
        val total = 20 + 20 + payloadLen
        val b = ByteArray(total)
        fillIpHeader(b, srcIp, dstIp, total, 6)

        val o = 20
        putU16(b, o, srcPort)
        putU16(b, o + 2, dstPort)
        putU32(b, o + 4, seq)
        putU32(b, o + 8, ack)
        b[o + 12] = 0x50.toByte()          // data offset = 5 (20 bytes)
        b[o + 13] = flags.toByte()
        putU16(b, o + 14, 65535)           // window
        // 校验和置 0：tun 写回路径由内核补
        putU16(b, o + 16, 0)
        putU16(b, o + 18, 0)               // urgent pointer

        System.arraycopy(payload, 0, b, 40, payloadLen)
        return b
    }

    /** 构造一个下行 UDP 包写回设备 */
    fun udp(
        srcIp: String, srcPort: Int,
        dstIp: String, dstPort: Int,
        payload: ByteArray, payloadLen: Int,
    ): ByteArray {
        val udpLen = 8 + payloadLen
        val total = 20 + udpLen
        val b = ByteArray(total)
        fillIpHeader(b, srcIp, dstIp, total, 17)

        val o = 20
        putU16(b, o, srcPort)
        putU16(b, o + 2, dstPort)
        putU16(b, o + 4, udpLen)
        putU16(b, o + 6, 0) // 校验和置 0 = 不校验（IPv4 下合法）

        System.arraycopy(payload, 0, b, 28, payloadLen)
        return b
    }

    private fun fillIpHeader(b: ByteArray, srcIp: String, dstIp: String, total: Int, proto: Int) {
        b[0] = 0x45                          // version 4, ihl 5
        b[1] = 0                             // DSCP/ECN
        putU16(b, 2, total)
        putU16(b, 4, 0)                      // identification
        putU16(b, 6, 0x4000)                 // don't fragment
        b[8] = 64                            // TTL
        b[9] = proto.toByte()
        putU16(b, 10, 0)                     // header checksum（内核补）
        putIp(b, 12, srcIp)
        putIp(b, 16, dstIp)
    }

    private fun putU16(b: ByteArray, o: Int, v: Int) {
        b[o] = ((v ushr 8) and 0xFF).toByte()
        b[o + 1] = (v and 0xFF).toByte()
    }

    private fun putU32(b: ByteArray, o: Int, v: Long) {
        b[o] = ((v ushr 24) and 0xFF).toByte()
        b[o + 1] = ((v ushr 16) and 0xFF).toByte()
        b[o + 2] = ((v ushr 8) and 0xFF).toByte()
        b[o + 3] = (v and 0xFF).toByte()
    }

    private fun putIp(b: ByteArray, o: Int, ip: String) {
        val parts = ip.split('.')
        for (i in 0..3) {
            b[o + i] = ((parts.getOrNull(i)?.toIntOrNull() ?: 0) and 0xFF).toByte()
        }
    }

    /** 需要时补 IP 头校验和（当前不启用，留作兼容某些严格 ROM 的手段） */
    @Suppress("unused")
    fun computeChecksum(b: ByteArray, headerLen: Int = 20): Int {
        var sum = 0
        var i = 0
        while (i < headerLen) {
            sum += ((b[i].toInt() and 0xFF) shl 8) or (b[i + 1].toInt() and 0xFF)
            sum = (sum and 0xFFFF) + (sum ushr 16)
            i += 2
        }
        return (sum.inv() and 0xFFFF)
    }
}

/** 便于构造 InetSocketAddress 的小工具 */
@Suppress("unused")
fun addr(ip: String, port: Int) = InetSocketAddress(ip, port)

/** 便于读 ByteBuffer 的小工具（会话里用） */
@Suppress("unused")
fun ByteBuffer.readAll(): ByteArray {
    val a = ByteArray(remaining())
    get(a)
    return a
}
