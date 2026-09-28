package com.xiaoyang.screenrecorder

import android.graphics.Bitmap
import android.util.Log
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong

/**
 * 录制数据仓库（单例）。
 * ============================================================
 *
 * 采集端（触摸监听、截帧器、前台监听）往里写，HTTP 端点往外读。
 * 两边在不同线程，所以全部用并发容器 + 原子量。
 *
 * 为什么可以有界地丢：
 *   · 触摸事件与系统事件**绝不丢** —— 它们是脚本的本体，丢了脚本就错了。
 *     数量级很小（一次录制几百条），全留。
 *   · 截帧**可以丢**：它是辅助信息。长时间录制若每 700ms 一帧，
 *     10 分钟就是 850 张 1080p 位图 ≈ 内存直接炸。
 *     所以设上限（[MAX_FRAMES]），超了就丢**最旧的**（保留最近的画面更有用），
 *     并且位图按 [JPEG_QUALITY] 压成 JPEG 存 —— 一张约 100~200KB，
 *     30 张也就几 MB，安全。
 *
 * 时间基准：所有 t 都是「相对录制开始」的毫秒数，且**暂停期间不累加**。
 * 见 [elapsedMs]：它是 `now - startedAt - totalPausedMs`。
 */
object RecordingStore {

    private const val TAG = "RecorderStore"

    /** 截帧上限：超过就丢最旧的。30 张 ≈ 4~6MB，够看关键节点了 */
    const val MAX_FRAMES = 30

    /** 截帧 JPEG 质量。70 足够看清界面文字，体积只有 PNG 的十几分之一 */
    private const val JPEG_QUALITY = 70

    /* ---------------- 状态 ---------------- */

    private val _recording = AtomicBoolean(false)
    private val _paused = AtomicBoolean(false)
    private val _capturing = AtomicBoolean(false)

    private val _startedAt = AtomicLong(0L)
    /** 累计暂停时长，算 elapsed 时扣掉 */
    private val _pausedTotalMs = AtomicLong(0L)
    /** 当前这一段暂停是从什么时候开始的，0 = 没在暂停 */
    private val _pauseBeganAt = AtomicLong(0L)

    @Volatile
    var meta: ScreenMeta = ScreenMeta(0, 0, 0, false)
        private set

    /**
     * 更新屏幕信息。
     *
     * 为什么允许在采集过程中被调用：屏幕信息是 CaptureService 在
     * 「拿到投影授权之前」就要读好的（电脑侧 /start 前要先看到 meta），
     * 而横竖屏切换会让它变。所以它不是 start 的一部分，单独一个入口。
     */
    fun updateMeta(m: ScreenMeta) {
        meta = m
    }

    /** 录制开始时的前台应用，用于 /events 里的第一个 launched 事件 */
    @Volatile
    var note: String = "未开始"
        private set

    /* ---------------- 数据 ---------------- */

    private val touches = ConcurrentLinkedQueue<TouchEvent>()
    private val frames = ConcurrentLinkedQueue<FrameEvent>()
    private val sysEvents = ConcurrentLinkedQueue<SysEvent>()

    /**
     * 帧位图：id → JPEG 字节。
     *
     * 直接存**编码后的字节**而不是 Bitmap：Bitmap 每张占 width*height*4 字节
     * （1080p 一张 8MB），30 张就 240MB，必 OOM。编码后一张 ~150KB。
     * 反正 HTTP 端点也是直接回二进制，不需要解码回去。
     */
    private val frameBytes = java.util.concurrent.ConcurrentHashMap<Int, ByteArray>()
    private val nextFrameId = AtomicInteger(1)

    /* ---------------- 开始 / 停止 ---------------- */

    fun start(m: ScreenMeta, startNote: String) {
        touches.clear(); frames.clear(); sysEvents.clear(); frameBytes.clear()
        nextFrameId.set(1)
        _pausedTotalMs.set(0); _pauseBeganAt.set(0)
        meta = m
        note = startNote
        _startedAt.set(System.currentTimeMillis())
        _paused.set(false)
        _recording.set(true)
        Log.i(TAG, "录制开始 ${m.width}x${m.height}@${m.density}，横屏=${m.landscape}")
    }

    fun stop() {
        _recording.set(false)
        _paused.set(false)
        _capturing.set(false)
        // 结束时间点定死，之后 elapsed 不再变
        note = "已停止"
        Log.i(TAG, "录制停止：触摸 ${touches.size} 条 / 帧 ${frames.size} 张 / 事件 ${sysEvents.size} 条")
    }

    fun reset() {
        touches.clear(); frames.clear(); sysEvents.clear(); frameBytes.clear()
        nextFrameId.set(1)
        _startedAt.set(0); _pausedTotalMs.set(0); _pauseBeganAt.set(0)
        _recording.set(false); _paused.set(false); _capturing.set(false)
        note = "未开始"
    }

    fun setPaused(p: Boolean) {
        if (!_recording.get()) return
        if (p == _paused.get()) return
        if (p) {
            // 进入暂停：记下起点，等恢复时累加
            _pauseBeganAt.set(System.currentTimeMillis())
            note = "已暂停"
        } else {
            val began = _pauseBeganAt.getAndSet(0)
            if (began > 0) _pausedTotalMs.addAndGet(System.currentTimeMillis() - began)
            note = "录制中"
        }
        _paused.set(p)
    }

    fun setCapturing(c: Boolean) { _capturing.set(c) }

    fun isRecording() = _recording.get()
    fun isPaused() = _paused.get()
    fun isCapturing() = _capturing.get()

    /* ---------------- 时间 ---------------- */

    /**
     * 已录制毫秒数（扣除暂停）。
     *
     * 注意停止后这个值**还会随时间增长** —— 但那没关系：
     * 停止后不再有新事件写入，电脑端拉走的是定格的数据。
     * 真要冻结得再存一个 endAt，不值得（没有消费者需要它）。
     */
    fun elapsedMs(): Long {
        val st = _startedAt.get()
        if (st == 0L) return 0
        val pausedNow = _pauseBeganAt.get().let { if (it > 0) System.currentTimeMillis() - it else 0L }
        return (System.currentTimeMillis() - st - _pausedTotalMs.get() - pausedNow).coerceAtLeast(0)
    }

    /* ---------------- 写入 ---------------- */

    /**
     * 记一个触摸点。
     *
     * 暂停中直接丢弃（用户按了暂停就是不想录这一段）。
     * 录制未开始时也丢 —— 画布在 idle 状态下本来就该是死的。
     */
    fun addTouch(e: TouchEvent) {
        if (!_recording.get() || _paused.get()) return
        touches.add(e)
    }

    fun addSys(e: SysEvent) {
        if (!_recording.get() || _paused.get()) return
        sysEvents.add(e)
    }

    /**
     * 存一帧。
     *
     * 位图在这里就被编码掉并 [Bitmap.recycle]，调用方不需要管回收。
     * 注意：**必须回收**，否则 1080p 每 700ms 泄漏 8MB，几分钟就 OOM。
     */
    fun addFrame(bmp: Bitmap, t: Long) {
        if (!_recording.get() || _paused.get()) {
            bmp.recycle()
            return
        }
        val bytes = try {
            ByteArrayOutputStream(64 * 1024).use { out ->
                bmp.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, out)
                out.toByteArray()
            }
        } catch (e: Exception) {
            Log.w(TAG, "帧编码失败：${e.message}")
            bmp.recycle()
            return
        } finally {
            // 上面 use 块结束后再回收；放 finally 保证异常路径也回收
        }
        bmp.recycle()

        if (bytes.isEmpty()) return

        val id = nextFrameId.getAndIncrement()
        frameBytes[id] = bytes
        frames.add(FrameEvent(t = t, id = id, bytes = bytes.size))

        // 超上限丢最旧的（连同字节一起丢，否则内存还是涨）
        while (frames.size > MAX_FRAMES) {
            val old = frames.poll() ?: break
            frameBytes.remove(old.id)
        }
    }

    /* ---------------- 读取 ---------------- */

    fun snapshot(): SessionSnapshot = SessionSnapshot(
        recording = _recording.get(),
        paused = _paused.get(),
        capturing = _capturing.get(),
        startedAtWall = _startedAt.get(),
        elapsedMs = elapsedMs(),
        meta = meta,
        touchCount = touches.size,
        frameCount = frames.size,
        sysCount = sysEvents.size,
        note = note,
    )

    fun touches(): List<TouchEvent> = touches.toList()
    fun frames(): List<FrameEvent> = frames.toList()
    fun sysEvents(): List<SysEvent> = sysEvents.toList()

    fun frameBytes(id: Int): ByteArray? = frameBytes[id]

    /** 把三个事件流按时间合并成一个有序列表 —— 电脑端一次拉完，不用自己对齐 */
    fun mergedTimeline(): List<JSONObject> {
        data class Item(val t: Long, val kind: String, val obj: JSONObject)
        val all = ArrayList<Item>(touches.size + frames.size + sysEvents.size)
        for (e in touches) all.add(Item(e.t, "touch", e.toJson()))
        for (e in frames) all.add(Item(e.t, "frame", e.toJson()))
        for (e in sysEvents) all.add(Item(e.t, "sys", e.toJson()))
        return all.sortedBy { it.t }.map { item ->
            JSONObject().apply {
                put("kind", item.kind)
                put("t", item.t)
                put("data", item.obj)
            }
        }
    }
}
