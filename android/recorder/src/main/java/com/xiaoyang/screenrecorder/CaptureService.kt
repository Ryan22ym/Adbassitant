package com.xiaoyang.screenrecorder

import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.Image
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.util.DisplayMetrics
import android.util.Log
import android.view.WindowManager
import java.util.concurrent.atomic.AtomicBoolean

/**
 * 采集服务。
 * ============================================================
 *
 * 三件事：
 *   1. 持有 [MediaProjection] 与 [VirtualDisplay]（系统给的「虚拟屏幕」）；
 *   2. 把虚拟屏幕的实时画面推给前台 Activity 的 SurfaceView（[attachSurface]）；
 *   3. 跑 [ControlServer]，并驱动 [ForegroundWatcher]。
 *
 * ## 为什么画面要给 SurfaceView 而不是 ImageReader
 *
 * 两条路都能拿到画面，但用途不同，这里**两条都开**：
 *   · **SurfaceView 路径**（实时预览）：VirtualDisplay 直接把画面渲到 SurfaceView 的
 *     Surface 上 —— 零拷贝、GPU 直接合成，帧率能到 60fps。这是「内嵌窗口里那块屏幕」。
 *   · **ImageReader 路径**（截帧）：按需从图形缓冲里抢一帧转 Bitmap。
 *     ImageReader 是**有缓冲上限**的（这里设 2），拿完必须 close，
 *     不适合做实时预览（会丢帧 + 内存压力大），但适合「隔几百毫秒取一张」。
 *
 * 所以：预览走 SurfaceView，截帧走 ImageReader，互不干扰。
 *
 * ## 权限生命周期（很重要）
 *
 * MediaProjection 授权是**一次性的**：授权结果是一个 Intent（data），
 * 系统返回后必须**立刻**用它建 projection，否则废弃。而且：
 *   · App 进程被杀 → 授权失效，必须重新弹框；
 *   · Android 14+ 起不允许复用同一个授权结果建多个 projection。
 * 所以 [onStartCommand] 里收到 data 就马上建，建完把 Intent 丢掉。
 */
class CaptureService : Service() {

    companion object {
        private const val TAG = "RecorderCapture"

        private const val CH_ID = "screen_recorder_capture"
        private const val NOTIFY_ID = 0x7E11

        const val ACTION_START = "com.xiaoyang.screenrecorder.START"
        const val ACTION_STOP = "com.xiaoyang.screenrecorder.STOP"
        const val EXTRA_RESULT_CODE = "resultCode"
        const val EXTRA_RESULT_DATA = "resultData"

        /** 截帧间隔：700ms。够密（能跟上界面切换）又不至于把内存压垮 */
        const val FRAME_INTERVAL_MS = 700L

        /**
         * 是否已经拿到过投影授权（供 /ping 汇报）。
         *
         * 注意这是**静态**的：Service 实例可能被重建，但「授权过没过期」是进程级的事实。
         * 进程被杀时它自然归零，正好符合 Android 的授权有效期语义。
         */
        @Volatile
        var hasProjection: Boolean = false
            private set

        /**
         * 标记为「已授权」。
         *
         * 为什么需要从外面设：授权的**结果**（resultCode + data）是 Activity 拿到的，
         * 要交给 Service 建投影；而 Activity 与 Service 之间没有 binder 通道
         * （startService 单程）。所以 Activity 在把授权结果递过去之后，
         * 顺手把进程级的「已授权」标记点亮 —— /ping 与按钮状态都读它。
         */
        internal fun markAuthorized() {
            hasProjection = true
        }

        /**
         * 当前活着的 Service 实例（给 Activity 用来接预览 Surface）。
         *
         * 为什么需要它：Activity 要调 [attachSurface]，但 Service 是
         * `startService` 起的、没有 binder —— 拿不到实例就只能靠静态引用。
         * 用 WeakReference 防泄漏（Service 被销毁后 Activity 不该拖住它）。
         */
        private var instanceRef: java.lang.ref.WeakReference<CaptureService>? = null

        internal fun ref(): CaptureService? = instanceRef?.get()
    }

    private var projection: MediaProjection? = null
    private var virtualDisplay: VirtualDisplay? = null
    private var imageReader: ImageReader? = null

    private var control: ControlServer? = null
    private var foreground: ForegroundWatcher? = null

    /** 截帧与 ImageReader 回调都跑在这个后台线程上，避免占用主线程 */
    private var bgThread: HandlerThread? = null
    private var bgHandler: Handler? = null

    /** 当前已附加的预览 Surface 的尺寸（Activity 那边会告诉我） */
    @Volatile private var previewWidth = 0
    @Volatile private var previewHeight = 0

    /** 防止 onStartCommand 被重复调用时反复建 display */
    private val started = AtomicBoolean(false)
    private var lastFrameAt = 0L

    override fun onCreate() {
        super.onCreate()
        instanceRef = java.lang.ref.WeakReference(this)
        bgThread = HandlerThread("recorder-capture").apply { start() }
        bgHandler = Handler(bgThread!!.looper)

        val c = ControlServer(this)
        control = c
        c.start()

        // 先把屏幕信息读出来 —— 电脑侧 /start 前要能看到 meta，否则会拿不到就拒启
        readScreenMeta()

        Log.i(TAG, "采集服务已就绪")
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                teardown()
                stopSelf()
                return START_NOT_STICKY
            }
            ACTION_START -> {
                startForegroundQuietly()
                val code = intent.getIntExtra(EXTRA_RESULT_CODE, Activity.RESULT_CANCELED)
                @Suppress("DEPRECATION")
                val data: Intent? = intent.getParcelableExtra(EXTRA_RESULT_DATA)
                if (code != Activity.RESULT_OK || data == null) {
                    Log.w(TAG, "没有有效的投影授权结果，无法开始采集")
                    return START_STICKY
                }
                beginProjection(code, data)
            }
        }
        // START_STICKY：进程被系统回收后尽量拉起（虽然授权会失效，但控制端口能恢复）
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        teardown()
        control?.stop()
        control = null
        bgThread?.quitSafely()
        bgThread = null
        bgHandler = null
        if (instanceRef?.get() === this) instanceRef = null
        super.onDestroy()
    }

    /* ------------------------------------------------------------------ */
    /* 投影建立 / 拆除                                                      */
    /* ------------------------------------------------------------------ */

    private fun beginProjection(resultCode: Int, data: Intent) {
        if (started.getAndSet(true)) {
            Log.i(TAG, "已经在采集了，忽略重复的 START")
            return
        }
        try {
            val mpm = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
            val mp = mpm.getMediaProjection(resultCode, data)
            if (mp == null) {
                Log.e(TAG, "getMediaProjection 返回 null（授权可能已过期）")
                started.set(false)
                return
            }
            projection = mp

            // Android 14+ 要求先注册回调再用，否则 createVirtualDisplay 直接抛
            mp.registerCallback(object : MediaProjection.Callback() {
                override fun onStop() {
                    // 用户可能在系统通知里点了「停止投屏」，或系统强制结束
                    Log.i(TAG, "投影被结束（用户或系统）")
                    teardown()
                }
            }, bgHandler)

            createDisplay()
            hasProjection = true
            RecordingStore.setCapturing(true)

            // 前台应用监听（拿不到 UsageStats 就自动降级，不影响录制）
            foreground = ForegroundWatcher(this).also { it.start() }

            Log.i(TAG, "投影已建立，采集开始")
        } catch (e: Exception) {
            Log.e(TAG, "建立投影失败：${e.message}", e)
            started.set(false)
        }
    }

    /**
     * 建虚拟屏幕 + ImageReader。
     *
     * 尺寸用**屏幕真实分辨率**：预览那份可以缩放，但截帧要原分辨率 ——
     * 电脑端要用它做坐标标定，缩过就跟「设备真实坐标」对不上了。
     */
    private fun createDisplay() {
        val m = RecordingStore.meta
        val w = if (m.width > 0) m.width else 1080
        val h = if (m.height > 0) m.height else 1920
        val dpi = if (m.density > 0) m.density else 320

        val reader = ImageReader.newInstance(w, h, PixelFormat.RGBA_8888, 2)
        reader.setOnImageAvailableListener({ r -> onImage(r) }, bgHandler)
        imageReader = reader

        val mp = projection ?: return
        virtualDisplay = mp.createVirtualDisplay(
            "recorder-display",
            w, h, dpi,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
            reader.surface,   // 截帧的落点
            null,
            bgHandler,
        )
        Log.i(TAG, "虚拟屏幕已建：${w}x${h}@${dpi}")
    }

    /**
     * ImageReader 新帧到达。
     *
     * ⚠️ 这里**必须**无条件把消耗掉 [Image]（`acquireLatestImage` → `close`），
     * 否则缓冲区永远不回收，ImageReader 会在攒满 maxImages 之后直接停止投递新帧
     * —— 表现就是「录着录着就没有截帧了」。
     *
     * 另外这里是「最新一帧」语义：累了几帧就丢掉旧的只取最新的，
     * 不然后台一卡就会按积压顺序补帧，截出来的时间全是错的。
     */
    private fun onImage(reader: ImageReader) {
        val image: Image? = try {
            reader.acquireLatestImage()
        } catch (e: Exception) {
            Log.w(TAG, "acquireLatestImage 失败：${e.message}")
            null
        }
        if (image == null) return

        try {
            // 帧率限制：Preview Surface 那条路照常 60fps，截帧这条路按间隔来
            val now = System.currentTimeMillis()
            if (now - lastFrameAt < FRAME_INTERVAL_MS) return
            lastFrameAt = now

            val bmp = imageToBitmap(image) ?: return
            RecordingStore.addFrame(bmp, RecordingStore.elapsedMs())
        } catch (e: Exception) {
            Log.w(TAG, "帧处理失败：${e.message}")
        } finally {
            // 无论如何都要关掉 —— 这是 ImageReader 不卡死的前提
            try { image.close() } catch (_: Exception) {}
        }
    }

    /**
     * Image(YUV/RGBA) → Bitmap。
     *
     * 这里按 RGBA_8888 处理：ImageReader.newInstance 用的是 RGBA_8888，
     * cropRect 通常就是全屏，但**行 stride 可能大于宽度**（对齐填充），
     * 所以不能简单 copyPixelsFromBuffer —— 那会把 padding 一起读进来导致画面错行。
     * 必须先建一个含 padding 的临时 Bitmap 再裁剪。
     */
    private fun imageToBitmap(image: Image): Bitmap? {
        val plane = image.planes.firstOrNull() ?: return null
        val buffer = plane.buffer
        val pixelStride = plane.pixelStride
        val rowStride = plane.rowStride
        val rowPadding = rowStride - pixelStride * image.width

        val rawW = image.width + rowPadding / pixelStride
        val raw = Bitmap.createBitmap(rawW, image.height, Bitmap.Config.ARGB_8888)
        raw.copyPixelsFromBuffer(buffer)

        return if (rowPadding == 0) {
            raw
        } else {
            // 裁掉右侧 padding，得到干净的一帧
            val clean = Bitmap.createBitmap(raw, 0, 0, image.width, image.height)
            raw.recycle()
            clean
        }
    }

    /* ------------------------------------------------------------------ */
    /* 预览 Surface（Activity 调）                                          */
    /* ------------------------------------------------------------------ */

    /**
     * 把虚拟屏幕的画面重定向到 Activity 的预览 Surface。
     *
     * 为什么不一开始就把 VirtualDisplay 输出指到预览 Surface：
     * Activity 的生命周期比 Service 短（用户切后台就 destroy），
     * 而采集必须继续。所以 VirtualDisplay 固定输出到 ImageReader（永在），
     * 预览只是**额外**接一路 —— 用 setSurface 换掉输出目标会在预览消失时
     * 把整条采集链路也带走，这是绝对不能接受的。
     *
     * 这里的实现：预览用另一条独立的 VirtualDisplay 指向预览 Surface。
     * Android 允许同一个 MediaProjection 建多个 VirtualDisplay，
     * 这样预览消失时只销毁预览那一路，采集不受影响。
     */
    fun attachSurface(surface: android.view.Surface, w: Int, h: Int) {
        detachSurface()
        val mp = projection ?: return
        if (w <= 0 || h <= 0) return
        previewWidth = w
        previewHeight = h
        try {
            previewDisplay = mp.createVirtualDisplay(
                "recorder-preview",
                w, h, if (RecordingStore.meta.density > 0) RecordingStore.meta.density else 320,
                DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
                surface,
                null,
                bgHandler,
            )
            Log.i(TAG, "预览已附加：${w}x${h}")
        } catch (e: Exception) {
            Log.w(TAG, "附加预览失败：${e.message}")
        }
    }

    fun detachSurface() {
        try { previewDisplay?.release() } catch (_: Exception) {}
        previewDisplay = null
        previewWidth = 0
        previewHeight = 0
    }

    private var previewDisplay: VirtualDisplay? = null

    /* ------------------------------------------------------------------ */
    /* 屏幕信息                                                            */
    /* ------------------------------------------------------------------ */

    /**
     * 读屏幕宽高与密度。
     *
     * ⚠️ 用 [WindowManager.getDefaultDisplay]（deprecated）而不是
     * `getCurrentWindowMetrics`：后者在 API 30+ 才有，而我们 minSdk 21。
     * 而且这里要的是**物理分辨率**，用 display.getRealMetrics 更准
     * （getMetrics 会扣掉状态栏/导航栏，跟 adb `input tap` 的坐标系不一致）。
     */
    private fun readScreenMeta() {
        try {
            val wm = getSystemService(Context.WINDOW_SERVICE) as WindowManager
            val dm = DisplayMetrics()
            @Suppress("DEPRECATION")
            wm.defaultDisplay.getRealMetrics(dm)
            val landscape = dm.widthPixels > dm.heightPixels
            RecordingStore.updateMeta(
                ScreenMeta(
                    width = dm.widthPixels,
                    height = dm.heightPixels,
                    density = dm.densityDpi,
                    landscape = landscape,
                )
            )
            Log.i(TAG, "屏幕 ${dm.widthPixels}x${dm.heightPixels} @ ${dm.densityDpi}dpi")
        } catch (e: Exception) {
            Log.w(TAG, "读屏幕信息失败：${e.message}")
        }
    }

    /* ------------------------------------------------------------------ */
    /* 收尾                                                                */
    /* ------------------------------------------------------------------ */

    private fun teardown() {
        started.set(false)
        hasProjection = false
        RecordingStore.setCapturing(false)
        RecordingStore.stop()

        foreground?.stop()
        foreground = null

        detachSurface()
        try { virtualDisplay?.release() } catch (_: Exception) {}
        virtualDisplay = null
        try { imageReader?.close() } catch (_: Exception) {}
        imageReader = null
        try { projection?.stop() } catch (_: Exception) {}
        projection = null

        try { stopForeground(true) } catch (_: Exception) {}
        Log.i(TAG, "采集已收尾")
    }

    /* ------------------------------------------------------------------ */
    /* 前台通知                                                            */
    /* ------------------------------------------------------------------ */

    /**
     * 前台通知。
     *
     * Android 14 起 mediaProjection 类型的前台服务**必须先有投影授权**
     * 才能 startForeground，否则抛 SecurityException。所以这个函数
     * 只在拿到授权结果之后的 ACTION_START 分支里调 —— 不要在 onCreate 里调。
     */
    private fun startForegroundQuietly() {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                val nm = getSystemService(NotificationManager::class.java)
                val ch = NotificationChannel(
                    CH_ID,
                    getString(R.string.notify_channel),
                    NotificationManager.IMPORTANCE_LOW,
                )
                ch.setShowBadge(false)
                nm?.createNotificationChannel(ch)
            }

            val b = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                Notification.Builder(this, CH_ID)
            } else {
                @Suppress("DEPRECATION")
                Notification.Builder(this)
            }

            val n: Notification = b
                .setContentTitle(getString(R.string.notify_title))
                .setContentText(getString(R.string.notify_text))
                .setSmallIcon(android.R.drawable.presence_video_online)
                .setOngoing(true)
                .build()

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(NOTIFY_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
            } else {
                startForeground(NOTIFY_ID, n)
            }
        } catch (e: Exception) {
            Log.w(TAG, "前台通知失败：${e.message}")
        }
    }
}
