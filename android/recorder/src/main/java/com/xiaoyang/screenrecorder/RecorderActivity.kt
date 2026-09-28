package com.xiaoyang.screenrecorder

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.Gravity
import android.view.MotionEvent
import android.view.SurfaceHolder
import android.view.SurfaceView
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast

/**
 * 主界面：内嵌画布 + 录制控制。
 * ============================================================
 *
 * ## 界面结构
 *
 * ```
 * ┌──────────────────────────────┐
 * │  状态条（● 录制中 · 12.3s · 45 点）│
 * ├──────────────────────────────┤
 * │                              │
 * │   画布（SurfaceView）          │  ← 显示本机屏幕实时画面
 * │   触在这里就是在操作            │     触摸事件被这里接住并记录
 * │                              │
 * ├──────────────────────────────┤
 * │ [授权录屏] [开始] [暂停] [停止]  │
 * └──────────────────────────────┘
 * ```
 *
 * ## 这块画布就是录制的核心
 *
 * 它显示的是**本机屏幕的镜像**（MediaProjection 采集 → 画到 SurfaceView），
 * 而触摸事件落在**这个 Activity 自己的 View 树**上 —— 所以能免 root 拿到。
 *
 * 这正是需求里「内嵌窗口 + 窗口中一块显示内容的屏幕 + 实时录制操作」的实现：
 * 内嵌窗口 = 本 Activity；那块屏幕 = SurfaceView；录操作 = 在它上面收 MotionEvent。
 *
 * ## 坐标换算（关键）
 *
 * 画布尺寸 ≠ 屏幕尺寸（有状态栏、按钮占位、宽高比可能不匹配），
 * 所以要把「画布上的触点」映射回「设备真实坐标」再归一化：
 *
 * ```
 * 归一化 nx = (touchLocalX - canvasLeft) / canvasWidth
 * 真实像素 x = nx * screenWidth        // 回放时由电脑端算
 * ```
 *
 * 归一化是**必须**的：录制的画布可能被缩放，回放的目标分辨率也可能不同，
 * 只有比例是两者都认的。
 */
class RecorderActivity : Activity() {

    companion object {
        private const val TAG = "RecorderActivity"
        private const val REQ_PROJECTION = 1001
        const val EXTRA_REQUEST_AUTH = "request_auth"
    }

    private lateinit var canvas: SurfaceView
    private lateinit var statusText: TextView
    private lateinit var btnAuth: Button
    private lateinit var btnStart: Button
    private lateinit var btnPause: Button
    private lateinit var btnStop: Button

    /** 画布当前的绘制区域（像素，相对 Activity 窗口）—— 坐标换算要用 */
    private var canvasLeft = 0f
    private var canvasTop = 0f
    private var canvasW = 0
    private var canvasH = 0

    private var ticker: Runnable? = null
    private val handler = android.os.Handler(android.os.Looper.getMainLooper())

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(buildUi())

        // 电脑侧通过 /authorize 拉起来时，直接弹授权框，省一步点击
        if (intent?.getBooleanExtra(EXTRA_REQUEST_AUTH, false) == true) {
            handler.postDelayed({ requestProjection() }, 300)
        }
        startTicker()
    }

    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        if (intent?.getBooleanExtra(EXTRA_REQUEST_AUTH, false) == true) {
            requestProjection()
        }
    }

    override fun onResume() {
        super.onResume()
        // 回到前台时如果采集在跑，把预览接回来（切后台时被 detach 了）
        attachPreviewIfNeeded()
        refreshButtons()
    }

    override fun onPause() {
        super.onPause()
        // 切后台就断开预览：Surface 会被销毁，继续持有会出错。
        // 注意采集本身**继续跑**（Service 里那路 ImageReader 不受影响）。
        detachPreview()
    }

    override fun onDestroy() {
        stopTicker()
        super.onDestroy()
    }

    /* ------------------------------------------------------------------ */
    /* 界面                                                                */
    /* ------------------------------------------------------------------ */

    private fun buildUi(): View {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(0xFF0D1117.toInt())
        }

        // ---- 状态条 ----
        statusText = TextView(this).apply {
            setTextColor(0xFFE6EDF3.toInt())
            textSize = 13f
            setPadding(dp(14), dp(12), dp(14), dp(12))
            text = "待命 · 未授权录屏"
        }
        root.addView(
            statusText,
            LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
            ),
        )

        // ---- 画布：占满剩余空间，居中显示 ----
        val canvasWrap = FrameLayout(this).apply {
            setBackgroundColor(0xFF000000.toInt())
        }
        canvas = SurfaceView(this)
        canvasWrap.addView(
            canvas,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
                Gravity.CENTER,
            ),
        )
        root.addView(
            canvasWrap,
            LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f),
        )

        // ---- 提示行：告诉用户「在这里操作就是在录制」 ----
        val hint = TextView(this).apply {
            setTextColor(0xFF8B949E.toInt())
            textSize = 11f
            setPadding(dp(14), dp(8), dp(14), dp(4))
            text = "在这块画布上点击/滑动 —— 操作与坐标会被实时记录并传给电脑端"
        }
        root.addView(hint)

        // ---- 按钮排 ----
        val bar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(dp(10), dp(4), dp(10), dp(12))
            gravity = Gravity.CENTER_VERTICAL
        }
        btnAuth = mkButton("授权录屏") { requestProjection() }
        btnStart = mkButton("开始录制") { onStartClicked() }
        btnPause = mkButton("暂停") { onPauseClicked() }
        btnStop = mkButton("停止") { onStopClicked() }
        for (b in listOf(btnAuth, btnStart, btnPause, btnStop)) {
            val lp = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            lp.marginEnd = dp(6)
            bar.addView(b, lp)
        }
        root.addView(
            bar,
            LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
            ),
        )

        // ---- 画布触摸监听：录制的数据源头 ----
        canvas.setOnTouchListener { v, ev -> handleTouch(v, ev) }

        // Surface 尺寸变化时更新换算参数，并把预览接上
        canvas.holder.addCallback(object : SurfaceHolder.Callback {
            override fun surfaceCreated(holder: SurfaceHolder) {
                updateCanvasGeometry()
                attachPreviewIfNeeded()
            }

            override fun surfaceChanged(h: SurfaceHolder, f: Int, w: Int, hh: Int) {
                updateCanvasGeometry()
            }

            override fun surfaceDestroyed(holder: SurfaceHolder) {
                canvasW = 0; canvasH = 0
            }
        })

        return root
    }

    private fun mkButton(label: String, onClick: () -> Unit): Button =
        Button(this).apply {
            text = label
            textSize = 12f
            setOnClickListener { onClick() }
        }

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

    /* ------------------------------------------------------------------ */
    /* 触摸采集                                                            */
    /* ------------------------------------------------------------------ */

    /**
     * 画布上的触摸 → [TouchEvent]。
     *
     * 换算三步（顺序不能反）：
     *   1. 用**画布内**的局部坐标（减去画布位置），而不是窗口坐标 —— 否则会带上状态栏高度；
     *   2. 除以画布尺寸 → 0~1 的归一化比例；
     *   3. clamp 到 [0,1]：手指划出边界时坐标可能为负或 >1，
     *      不夹住的话回放时会点到屏幕外面（adb tap 会被系统忽略或点到别的控件）。
     *
     * 多点触控：只认真实存在的触点（`pointerId`），并且**只录第一根手指**（index 0）。
     * 录制多指手势的复杂度远超收益（自动连点器的场景基本都是单指），
     * 这里明确不支持 —— 但保留 pointer 字段，将来要加不用改协议。
     */
    private fun handleTouch(v: View, ev: MotionEvent): Boolean {
        if (!RecordingStore.isRecording() || RecordingStore.isPaused()) return true

        val action = ev.actionMasked
        val type = when (action) {
            MotionEvent.ACTION_DOWN -> "down"
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> "up"
            MotionEvent.ACTION_MOVE -> "move"
            else -> return true
        }

        val localX = ev.x
        val localY = ev.y
        if (canvasW <= 0 || canvasH <= 0) return true

        val nx = (localX / canvasW).coerceIn(0f, 1f).toDouble()
        val ny = (localY / canvasH).coerceIn(0f, 1f).toDouble()

        RecordingStore.addTouch(
            TouchEvent(
                type = type,
                nx = nx,
                ny = ny,
                t = RecordingStore.elapsedMs(),
                pointer = 0,
            )
        )
        // 消费掉事件：不让它传下去（画布就是个"遥控器"，不是可交互界面）
        return true
    }

    /** 画布在窗口里的位置与尺寸 —— 每次 surface 变化后刷新 */
    private fun updateCanvasGeometry() {
        canvas.post {
            canvasLeft = canvas.x
            canvasTop = canvas.y
            canvasW = canvas.width
            canvasH = canvas.height
            Log.d(TAG, "画布几何：($canvasLeft,$canvasTop) ${canvasW}x${canvasH}")
        }
    }

    /* ------------------------------------------------------------------ */
    /* 操作                                                                */
    /* ------------------------------------------------------------------ */

    /**
     * 请求录屏授权。
     *
     * **这一步没有自动化余地** —— Android 要求 MediaProjection 授权框由
     * Activity 主动请求、用户点确认。电脑侧的 `/authorize` 也只能把界面拉起来。
     */
    private fun requestProjection() {
        try {
            val mpm = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
            startActivityForResult(mpm.createScreenCaptureIntent(), REQ_PROJECTION)
        } catch (e: Exception) {
            Log.e(TAG, "请求录屏授权失败：${e.message}", e)
            toast("无法拉起授权框：${e.message}")
        }
    }

    @Deprecated("startActivityForResult 的老式回调；minSdk 21 无 registerForActivityResult 的简洁写法")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != REQ_PROJECTION) return
        if (resultCode != RESULT_OK || data == null) {
            toast("未授权录屏，无法采集画面")
            return
        }
        // 授权结果必须**立刻**交给 Service 去建 projection ——
        // 它是「一次性凭据」，放着不用就作废，不能存起来等下次。
        val i = Intent(this, CaptureService::class.java).apply {
            action = CaptureService.ACTION_START
            putExtra(CaptureService.EXTRA_RESULT_CODE, resultCode)
            putExtra(CaptureService.EXTRA_RESULT_DATA, data)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(i)
        } else {
            startService(i)
        }
        CaptureService.markAuthorized()
        toast("已授权，正在建立采集…")
        handler.postDelayed({ attachPreviewIfNeeded(); refreshButtons() }, 600)
    }

    private fun onStartClicked() {
        if (!CaptureService.hasProjection) {
            toast("请先点「授权录屏」")
            requestProjection()
            return
        }
        if (RecordingStore.meta.width <= 0) {
            toast("采集还在初始化，请稍等一下再点开始")
            return
        }
        // 每次开始都是新的一段：先清空上一轮
        RecordingStore.start(RecordingStore.meta, "录制中")
        toast("已开始录制")
        refreshButtons()
    }

    private fun onPauseClicked() {
        if (!RecordingStore.isRecording()) return
        val next = !RecordingStore.isPaused()
        RecordingStore.setPaused(next)
        toast(if (next) "已暂停（暂停期间的触摸不会被记录）" else "已恢复录制")
        refreshButtons()
    }

    private fun onStopClicked() {
        if (!RecordingStore.isRecording()) return
        RecordingStore.stop()
        toast("已停止，数据已保留 —— 电脑端可以拉取了")
        refreshButtons()
    }

    private fun refreshButtons() {
        val rec = RecordingStore.isRecording()
        val paused = RecordingStore.isPaused()
        btnAuth.isEnabled = !CaptureService.hasProjection
        btnStart.isEnabled = !rec
        btnPause.isEnabled = rec
        btnPause.text = if (paused) "恢复" else "暂停"
        btnStop.isEnabled = rec
    }

    /* ------------------------------------------------------------------ */
    /* 预览接驳                                                            */
    /* ------------------------------------------------------------------ */

    private fun attachPreviewIfNeeded() {
        val w = canvas.width
        val h = canvas.height
        if (w <= 0 || h <= 0) return
        if (!CaptureService.hasProjection) return
        val svc = CaptureService.ref()
        if (svc == null) {
            // Service 还没起来（授权刚回来那一瞬）—— 稍后重试一次
            handler.postDelayed({ attachPreviewIfNeeded() }, 400)
            return
        }
        // 按画布的实际尺寸建预览：让系统去缩放，
        // 比我们自己缩放省一次拷贝，且宽高比不对时会有黑边但不失真
        svc.attachSurface(canvas.holder.surface, w, h)
    }

    private fun detachPreview() {
        CaptureService.ref()?.detachSurface()
    }

    /* ------------------------------------------------------------------ */
    /* 状态条刷新                                                          */
    /* ------------------------------------------------------------------ */

    private fun startTicker() {
        val r = object : Runnable {
            override fun run() {
                updateStatus()
                handler.postDelayed(this, 500)
            }
        }
        ticker = r
        handler.post(r)
    }

    private fun stopTicker() {
        ticker?.let { handler.removeCallbacks(it) }
        ticker = null
    }

    private fun updateStatus() {
        val s = RecordingStore.snapshot()
        val head = when {
            s.recording && s.paused -> "⏸ 已暂停"
            s.recording -> "● 录制中"
            s.capturing -> "采集已就绪"
            CaptureService.hasProjection -> "已授权 · 待开始"
            else -> "待命 · 未授权录屏"
        }
        val secs = s.elapsedMs / 1000.0
        statusText.text = buildString {
            append(head)
            if (s.recording || s.touchCount > 0 || s.frameCount > 0) {
                append("  ·  ")
                append(String.format("%.1fs", secs))
                append("  ·  触摸 ")
                append(s.touchCount)
                append("  帧 ")
                append(s.frameCount)
                append("  事件 ")
                append(s.sysCount)
            }
            if (s.meta.width > 0) {
                append("  ·  ")
                append(s.meta.width)
                append("×")
                append(s.meta.height)
            }
        }
        refreshButtons()
    }

    private fun toast(msg: String) {
        Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()
    }
}
