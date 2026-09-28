package com.xiaoyang.screenrecorder

import org.json.JSONArray
import org.json.JSONObject

/**
 * 录制协议的数据模型。
 * ============================================================
 *
 * 与电脑侧 `electron/services/screen-recorder.ts` 的 DTO **一一对应**，
 * 改这里必须同步改那边 —— 两边是同一个契约。
 *
 * 为什么不用 Gson / Moshi：APK 越小越好，字段固定，手写 JSON 完全可控
 * （与弱网 App 同样的取舍）。
 *
 * 时间基准：**所有时间戳都是「相对录制开始的毫秒数」**，不是墙钟时间。
 * 理由：电脑端要做的是「回放这段操作」，需要的是步骤之间的间隔；
 * 相对时间不受设备与电脑的时钟偏差影响（两边时间从来就没对齐过）。
 */

/* ------------------------------------------------------------------ */
/* 触摸事件                                                            */
/* ------------------------------------------------------------------ */

/**
 * 一个触摸动作。
 *
 * 注意这里存的是**归一化坐标**（0~1 的浮点数）而不是像素：
 * 录制时画布尺寸、回放时设备分辨率、投屏窗口大小三者都可能不同，
 * 存像素值会让脚本换台机器就完全错位。除以屏幕宽高存比例，
 * 回放时再乘目标分辨率 —— 这样「720p 上录的脚本」在 1080p 上也能用。
 */
data class TouchEvent(
    /** 事件类型：down / move / up */
    val type: String,
    /** 归一化 x（0~1，相对屏幕宽度） */
    val nx: Double,
    /** 归一化 y（0~1，相对屏幕高度） */
    val ny: Double,
    /** 相对录制开始的毫秒数 */
    val t: Long,
    /** 触点 id（多点触控；单指恒为 0） */
    val pointer: Int = 0,
) {
    fun toJson(): JSONObject = JSONObject().apply {
        put("type", type)
        put("nx", round4(nx))
        put("ny", round4(ny))
        put("t", t)
        put("pointer", pointer)
    }

    companion object {
        fun fromJson(o: JSONObject): TouchEvent = TouchEvent(
            type = o.optString("type", "move"),
            nx = o.optDouble("nx", 0.0),
            ny = o.optDouble("ny", 0.0),
            t = o.optLong("t", 0L),
            pointer = o.optInt("pointer", 0),
        )
    }
}

/* ------------------------------------------------------------------ */
/* 关键帧                                                              */
/* ------------------------------------------------------------------ */

/**
 * 一次截帧。
 *
 * 为什么要截帧：光有坐标看不出「当时屏幕上是什么」，无法判断这个步骤点的是
 * 哪个按钮。存下关键帧后，电脑端可以在步骤列表里显示缩略图，
 * 而且回放前能靠模板匹配校验「当前画面和录制时是否一致」。
 *
 * 图片不进 JSON（会撑爆内存），走二进制端点 `/frame?id=N` 单独取。
 */
data class FrameEvent(
    /** 相对录制开始的毫秒数 */
    val t: Long,
    /** 帧图片在内存里的槽位 id */
    val id: Int,
    /** 编码后的字节数（电脑端用来判断是否值得下载） */
    val bytes: Int,
) {
    fun toJson(): JSONObject = JSONObject().apply {
        put("t", t)
        put("id", id)
        put("bytes", bytes)
    }
}

/* ------------------------------------------------------------------ */
/* 系统事件                                                            */
/* ------------------------------------------------------------------ */

/**
 * 系统 / 应用事件。
 *
 * 主要记「前台应用切换」，用于在步骤列表里插入分节说明
 * （「这里跳到了设置页」），让脚本可读、也方便定位失败点。
 *
 * 实现见 [ForegroundWatcher]：第三方 App 拿不到 getRunningTasks，
 * 所以走 UsageStats（需要用户手动授权「使用情况访问」），拿不到就降级为不采集
 * —— 这个事件是**辅助信息**，缺失不影响录制主体（触摸 + 截帧）。
 */
data class SysEvent(
    /** launched / foreground / screenOn / screenOff */
    val kind: String,
    /** 应用包名（screenOn/Off 时为空） */
    val pkg: String,
    /** 相对录制开始的毫秒数 */
    val t: Long,
    /** 人类可读的说明 */
    val label: String = "",
) {
    fun toJson(): JSONObject = JSONObject().apply {
        put("kind", kind)
        put("pkg", pkg)
        put("t", t)
        put("label", label)
    }
}

/* ------------------------------------------------------------------ */
/* 录制会话元信息                                                       */
/* ------------------------------------------------------------------ */

data class ScreenMeta(
    /** 屏幕宽（像素，采集时的真实分辨率） */
    val width: Int,
    /** 屏幕高 */
    val height: Int,
    /** 屏幕密度 dpi */
    val density: Int,
    /** 是否横屏 */
    val landscape: Boolean,
) {
    fun toJson(): JSONObject = JSONObject().apply {
        put("width", width)
        put("height", height)
        put("density", density)
        put("landscape", landscape)
    }
}

/**
 * 录制会话快照 —— 电脑端 `/status` 就是拿这个。
 *
 * 事件数组默认**不在这里返回**（可能上千条），走 `/events` 单独拉。
 * 这里只给计数，让电脑端知道「拉不拉得动」。
 */
data class SessionSnapshot(
    val recording: Boolean,
    /** 录制是否已暂停（暂停期间不收触摸、不截帧） */
    val paused: Boolean,
    /** 采集是否真的在跑（MediaProjection 是否活着） */
    val capturing: Boolean,
    val startedAtWall: Long,
    /** 录制已进行的毫秒数（暂停时间不计） */
    val elapsedMs: Long,
    val meta: ScreenMeta,
    val touchCount: Int,
    val frameCount: Int,
    val sysCount: Int,
    val note: String,
)

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

internal fun round4(v: Double): Double = Math.round(v * 10000.0) / 10000.0

/**
 * List → JSONArray。
 *
 * ⚠️ 这里必须写成**泛型**，不能为每种事件各写一个 `List<TouchEvent>.toJsonArray()`
 * 这样的扩展 —— 泛型擦除后三个扩展函数的 JVM 签名完全一样
 * （`toJsonArray(List)`），Kotlin 直接报 "Platform declaration clash"。
 * 靠 `toJson()` 由 lambda 提供，一个函数覆盖所有事件类型。
 */
internal fun <T> List<T>.toJsonArray(toJson: (T) -> JSONObject): JSONArray {
    val arr = JSONArray()
    for (e in this) arr.put(toJson(e))
    return arr
}
