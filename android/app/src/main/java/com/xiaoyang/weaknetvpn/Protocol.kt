package com.xiaoyang.weaknetvpn

import org.json.JSONObject

/**
 * 控制协议的数据模型与 JSON 编解码。
 *
 * 为什么不用 Gson / Moshi：APK 越小越好，而且这几个类的字段是固定的、
 * 手写解析完全可控（也避免依赖源拉不下来）。
 *
 * 协议与电脑侧 `electron/services/weaknet-vpn.ts` 的 DTO 一一对应，
 * 改这里必须同步改那边 —— 两边是同一个契约。
 */

/* ------------------------------------------------------------------ */
/* 单向参数                                                            */
/* ------------------------------------------------------------------ */

/**
 * 单个方向的弱网参数。
 *
 * 全部为 0 表示「该方向不整形」，直接透传（不做任何排队），
 * 这样「只测下行」这种常见用法不会给上行引入无谓的延迟。
 */
data class DirectionParams(
    /** 带宽上限 Mbps，0 = 不限 */
    val bandwidthMbps: Double = 0.0,
    /** 基础延迟 ms */
    val delayMs: Int = 0,
    /** 延迟抖动 ms */
    val jitterMs: Int = 0,
    /** 丢包率 % */
    val lossPercent: Double = 0.0,
    /** 错报率 %（篡改一个 bit） */
    val corruptPercent: Double = 0.0,
    /** 乱序率 %（投递时刻抖动，不重排） */
    val reorderPercent: Double = 0.0,
    /** 重复包率 % */
    val duplicatePercent: Double = 0.0,
) {
    /** 该方向是否需要整形 */
    val shaping: Boolean
        get() = bandwidthMbps > 0 || delayMs > 0 || jitterMs > 0 ||
            lossPercent > 0 || corruptPercent > 0 ||
            reorderPercent > 0 || duplicatePercent > 0

    fun toJson(): JSONObject = JSONObject().apply {
        put("bandwidthMbps", bandwidthMbps)
        put("delayMs", delayMs)
        put("jitterMs", jitterMs)
        put("lossPercent", lossPercent)
        put("corruptPercent", corruptPercent)
        put("reorderPercent", reorderPercent)
        put("duplicatePercent", duplicatePercent)
    }

    companion object {
        fun fromJson(o: JSONObject?): DirectionParams {
            if (o == null) return DirectionParams()
            return DirectionParams(
                bandwidthMbps = o.optDouble("bandwidthMbps", 0.0).coerceAtLeast(0.0),
                delayMs = o.optInt("delayMs", 0).coerceAtLeast(0),
                jitterMs = o.optInt("jitterMs", 0).coerceAtLeast(0),
                lossPercent = o.optDouble("lossPercent", 0.0).coerceIn(0.0, 100.0),
                corruptPercent = o.optDouble("corruptPercent", 0.0).coerceIn(0.0, 100.0),
                reorderPercent = o.optDouble("reorderPercent", 0.0).coerceIn(0.0, 100.0),
                duplicatePercent = o.optDouble("duplicatePercent", 0.0).coerceIn(0.0, 100.0),
            )
        }
    }
}

/* ------------------------------------------------------------------ */
/* 会话参数                                                            */
/* ------------------------------------------------------------------ */

data class SessionParams(
    val up: DirectionParams = DirectionParams(),
    val down: DirectionParams = DirectionParams(),
    /** 持续时长（秒），0 = 直到手动停止 */
    val durationSec: Int = 0,
    /** 整体断网（隧道建立但一个包都不过，等价于「网络没了」） */
    val blockNetwork: Boolean = false,
) {
    fun toJson(): JSONObject = JSONObject().apply {
        put("up", up.toJson())
        put("down", down.toJson())
        put("durationSec", durationSec)
        put("blockNetwork", blockNetwork)
    }

    companion object {
        fun fromJson(o: JSONObject?): SessionParams {
            if (o == null) return SessionParams()
            return SessionParams(
                up = DirectionParams.fromJson(o.optJSONObject("up")),
                down = DirectionParams.fromJson(o.optJSONObject("down")),
                durationSec = o.optInt("durationSec", 0).coerceAtLeast(0),
                blockNetwork = o.optBoolean("blockNetwork", false),
            )
        }
    }
}

/* ------------------------------------------------------------------ */
/* 统计                                                                */
/* ------------------------------------------------------------------ */

/**
 * 实时统计。
 *
 * 字段刻意与电脑侧 `SharedTypes.WeakNetStats` 对齐，这样 UI 不需要为
 * VPN 模式单独写一套展示逻辑（前端表现保持不变，正是需求要的）。
 */
class TrafficStats {
    @Volatile var connections: Int = 0
    @Volatile var active: Int = 0
    @Volatile var upBytes: Long = 0
    @Volatile var downBytes: Long = 0
    @Volatile var upRetrans: Int = 0
    @Volatile var downRetrans: Int = 0
    @Volatile var upReorder: Int = 0
    @Volatile var downReorder: Int = 0
    @Volatile var upCorrupt: Int = 0
    @Volatile var downCorrupt: Int = 0

    fun reset() {
        connections = 0; active = 0; upBytes = 0; downBytes = 0
        upRetrans = 0; downRetrans = 0
        upReorder = 0; downReorder = 0
        upCorrupt = 0; downCorrupt = 0
    }

    fun toJson(): JSONObject = JSONObject().apply {
        put("connections", connections)
        put("active", active)
        put("upBytes", upBytes)
        put("downBytes", downBytes)
        put("upRetrans", upRetrans)
        put("downRetrans", downRetrans)
        put("upReorder", upReorder)
        put("downReorder", downReorder)
        put("upCorrupt", upCorrupt)
        put("downCorrupt", downCorrupt)
    }
}

/* ------------------------------------------------------------------ */
/* 会话快照（供 /status 返回）                                          */
/* ------------------------------------------------------------------ */

data class SessionSnapshot(
    /** 隧道是否活着 */
    val vpnActive: Boolean,
    /** 是否已获得系统 VPN 授权 */
    val authorized: Boolean,
    /** 正在生效的参数 */
    val params: SessionParams,
    /** 会话开始时间戳（ms），未运行则为 0 */
    val startedAt: Long,
    /** 剩余秒数，-1 = 不限时 */
    val remainSec: Int,
    /** 人类可读的说明，UI 直接展示 */
    val note: String,
)
