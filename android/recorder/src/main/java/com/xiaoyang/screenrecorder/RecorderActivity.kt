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
 * 授权与状态界面（**不再是录制画布**）。
 * ============================================================
 *
 * ## 这一版最重要的变化
 *
 * 之前：录制必须在**这个 Activity 的画布上**操作（因为触摸只能被自己接住），
 * 所以「开始录制」会把界面拉到前台，用户就没法一边用别的 App 一边录。
 *
 * 现在改成**后台录制 + 电脑端远程控制**：
 *   · 画面：MediaProjection 在 [CaptureService] 里后台采集，与前台界面无关；
 *   · 触摸：由**电脑侧**读 `adb shell getevent` 取得（免 root，见
 *     `electron/services/touch-capture.ts`），不再依赖这块画布；
 *   · 开始 / 暂停 / 结束：全部由电脑端经 HTTP 控制端口下发。
 *
 * 所以本 Activity 只剩两个职责：
 *   1. **首次授权** —— MediaProjection 的系统授权框只能由 Activity 请求，
 *      这一步没有自动化余地，必须用户亲自点一次确认；
 *   2. 显示当前状态（画布仍保留作实时预览，方便确认采到的是哪块屏）。
 *
 * ## 授权后立刻退回后台
 *
 * 授权结果一交出去（给 Service 建投影），这里就 `moveTaskToBack(true)` ——
 * 用户点完「立即开始」会**直接回到他原来在用的 App**，而不是停在采集端。
 * 这是「不得切换回录制 App 界面」这条需求的关键落点。
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

    /** 是否由电脑侧显式要求打开（自动授权后要自动退回后台） */
    private var autoBack = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(buildUi())

        /*
         * 先把 Service 起起来 —— **控制端口是在 Service.onCreate 里开的**，
         * 不起它电脑侧连 /ping 都探不到。
         *
         * ⚠️ 这一句是必须的：Service 的另一条启动路径只有「授权结果回来之后」，
         * 而授权又要先连上电脑侧的控制端口才能被触发 —— 是个鸡生蛋问题。
         * 以前少了这句的后果是：用户在电脑上看到「服务未启动 → 请在手机上打开
         * 一次采集端」，照着做了却依然连不上（打开界面并不启动服务），
         * 只能靠反复重试撞运气。
         *
         * ACTION_FOREGROUND 只发一条低优先级通知把服务转成前台（后台服务在
         * Android 8+ 会被限制），**不碰投影** —— 此时还没授权，建投影必失败。
         */
        ensureServiceRunning()

        // 电脑侧通过 /authorize 拉起来时，直接弹授权框，省一步点击
        autoBack = intent?.getBooleanExtra(EXTRA_REQUEST_AUTH, false) == true
        if (autoBack) {
            handler.postDelayed({ requestProjection() }, 300)
        }
        startTicker()
    }

    /** 幂等地把 [CaptureService] 拉起来（内部有 started 标记，重复调用无副作用） */
    private fun ensureServiceRunning() {
        val i = Intent(this, CaptureService::class.java).apply {
            action = CaptureService.ACTION_FOREGROUND
        }
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startForegroundService(i)
            } else {
                startService(i)
            }
        } catch (e: Exception) {
            Log.w(TAG, "启动采集服务失败：${e.message}")
        }
    }

    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        if (intent?.getBooleanExtra(EXTRA_REQUEST_AUTH, false) == true) {
            autoBack = true
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

        // ---- 提示行：讲清楚「这里只用来授权，录制由电脑控制」 ----
        val hint = TextView(this).apply {
            setTextColor(0xFF8B949E.toInt())
            textSize = 11f
            setPadding(dp(14), dp(10), dp(14), dp(2))
            text = "本页只用于首次授权。授权后请直接切到你要操作的 App —— " +
                "录制全程由电脑端控制，这里不会自动跳回来。"
        }
        root.addView(hint)

        val hint2 = TextView(this).apply {
            setTextColor(0xFF6E7681.toInt())
            textSize = 11f
            setPadding(dp(14), dp(2), dp(14), dp(6))
            text = "画布仅作实时预览；触摸由电脑端读取，无需在此操作。"
        }
        root.addView(hint2)

        // ---- 按钮排 ----
        // 授权键是**唯一必点**的键，给它主样式；
        // 开始/暂停/停止三个是本地调试用的兜底（正式流程电脑端下发），
        // 做成次要样式 —— 免得用户误以为必须在这里点。
        val bar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(dp(10), dp(4), dp(10), dp(12))
            gravity = Gravity.CENTER_VERTICAL
        }
        btnAuth = mkButton("授权录屏", primary = true) { requestProjection() }
        btnStart = mkButton("开始", primary = false) { onStartClicked() }
        btnPause = mkButton("暂停", primary = false) { onPauseClicked() }
        btnStop = mkButton("停止", primary = false) { onStopClicked() }
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

        val footNote = TextView(this).apply {
            setTextColor(0xFF6E7681.toInt())
            textSize = 10f
            setPadding(dp(14), 0, dp(14), dp(10))
            text = "调试用：正常运行时由电脑端点「开始录制」，无需在此操作。"
        }
        root.addView(footNote)

        // ---- 画布不再采集触摸（触摸改由电脑侧 getevent 提供） ----
        // 这里**故意不设** OnTouchListener：画布是纯预览。
        // 留着旧监听会有副作用 —— 用户在预览上乱点会混进录制数据。
        // 见 [handleTouch] 的注释（保留方法仅供将来需要时切回）。

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

    /**
     * 造按钮。
     *
     * `primary = true` → 填充色主按钮（授权用，界面上唯一必须点的）；
     * `primary = false` → 描边次要按钮（本地调试用的开始/暂停/停止）。
     * 用颜色而非尺寸区分，是为了让「授权」在视觉上明显更重。
     */
    private fun mkButton(label: String, primary: Boolean, onClick: () -> Unit): Button =
        Button(this).apply {
            text = label
            textSize = 12f
            if (primary) {
                setBackgroundColor(0xFF1F6FEB.toInt())
                setTextColor(0xFFFFFFFF.toInt())
            } else {
                setBackgroundColor(0x00000000)
                setTextColor(0xFF8B949E.toInt())
            }
            setOnClickListener { onClick() }
        }

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

    /* ------------------------------------------------------------------ */
    /* 触摸采集                                                            */
    /* ------------------------------------------------------------------ */

    /**
     * 画布上的触摸 → [TouchEvent]。
     *
     * ⚠️ **已停用**：画布不再挂 `OnTouchListener`（见 [buildUi]）。
     *
     * 为什么废弃：画布只能接住**它自己**的触摸。要「一边用别的 App 一边录」，
     * 触摸必须从设备全局读取 —— 那是电脑侧 `adb shell getevent` 的活
     * （见 `electron/services/touch-capture.ts`）。这块画布的触摸监听留着
     * 只会污染数据（用户在预览上点几下就被记进录制脚本）。
     *
     * 方法本身**保留**：万一将来要支持「在采集端窗口里录一段演示」，
     * 把 `canvas.setOnTouchListener` 加回来即可，换算逻辑不用重写。
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
    @Suppress("unused")
    private fun handleTouch(@Suppress("UNUSED_PARAMETER") v: View, ev: MotionEvent): Boolean {
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
            if (autoBack) handler.postDelayed({ retreat() }, 800)
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
        toast("已授权，后台采集已启动")

        if (autoBack) {
            // 电脑发起的授权：**立刻退回后台**，用户回到他原来在用的 App。
            // 这就是「不得切换回录制 App 界面」的落点 —— 授权是所有流程里
            // 唯一必须前台的一步，做完马上让位。
            handler.postDelayed({ retreat() }, 400)
        } else {
            handler.postDelayed({ attachPreviewIfNeeded(); refreshButtons() }, 600)
        }
    }

    /**
     * 退回后台。
     *
     * `moveTaskToBack` 而不是 `finish()`：finish 会销毁 Activity，
     * 下次电脑侧要再看状态就得重建（多一次闪屏）。退到后台则保留实例，
     * 用户手动切回来时状态还在，也不需要重新授权。
     *
     * 注意**采集不受影响**：MediaProjection 与 VirtualDisplay 都在
     * [CaptureService] 里，Activity 退后台会 detach 预览那一路，
     * 截帧那一路照常跑。
     */
    private fun retreat() {
        Log.i(TAG, "授权完成，退回后台（采集继续）")
        try { detachPreview() } catch (_: Exception) {}
        moveTaskToBack(true)
    }

    /**
     * 手机上的「开始 / 暂停 / 停止」按钮。
     *
     * 保留它们只是**本地调试用**（装好后想手动验一下采集是否正常）。
     * 正式的录制流程一律走电脑端控制端口 —— 那三个按钮在界面上
     * 被刻意做成次要样式（ghost），并注明"电脑端会自动控制"。
     */
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
        syncNotification()
        toast("已开始录制")
        refreshButtons()
    }

    private fun onPauseClicked() {
        if (!RecordingStore.isRecording()) return
        val next = !RecordingStore.isPaused()
        RecordingStore.setPaused(next)
        syncNotification()
        toast(if (next) "已暂停" else "已恢复录制")
        refreshButtons()
    }

    private fun onStopClicked() {
        if (!RecordingStore.isRecording()) return
        RecordingStore.stop()
        toast("已停止，数据已保留 —— 电脑端可以拉取了")
        refreshButtons()
    }

    /** 让前台通知文案跟上状态（录制中 / 已暂停） */
    private fun syncNotification() {
        val i = Intent(this, CaptureService::class.java).apply {
            action = if (RecordingStore.isPaused()) {
                CaptureService.ACTION_NOTIFY_PAUSED
            } else {
                CaptureService.ACTION_NOTIFY_RECORDING
            }
        }
        try {
            startService(i)
        } catch (_: Exception) {
        }
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
