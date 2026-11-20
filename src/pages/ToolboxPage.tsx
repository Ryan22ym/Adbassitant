import { useEffect, useId, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Button, Card, Input, Notice, Segmented, Select, Textarea } from '@/components/ui';
import { Icon } from '@/components/icons';
import { useApp } from '@/store/app';
import { useUiConf } from '@/lib/ui-conf';
import { featureOnOf } from '@shared/ui-conf';
import { copyToClipboard } from '@/lib/clipboard';
import { md5 } from '@/lib/md5';
import {
  describeLevel,
  kingLevel,
  levelOf,
  MAX_LEVEL,
  KING_MAX_STARS,
  parseLevelInput,
  RANK_TIERS,
  ROMAN,
} from '@/lib/rank';
import './toolbox.css';

/* ================================================================== */
/* 工具注册表                                                          */
/* ================================================================== */

/**
 * 工具箱里的一个工具。
 *
 * 🔴 **加新功能只改这一处**：往 TOOL_DEFS 里加一条（id + 名字 + 一行说明 + 图标 + 渲染函数），
 *    左侧清单、选中态、显隐（Conf/features.json 的 `toolbox.<id>`）全部自动跟上 ——
 *    不需要动 <ToolboxPage> 的分支，也不需要动侧栏。
 *
 * ⚠️ id 一旦发布就不要再改名：Conf/features.json 里写着它，改名等于把用户关掉的工具
 *    重新放出来（旧 key 匹配不上，featureOnOf 回落 true）。
 */
interface ToolDef {
  id: string;
  /** 清单与页面标题上的名字 */
  name: string;
  /** 清单里的一行说明，**只写它是干什么的**，不写怎么用 */
  desc: string;
  icon: ReactNode;
  render: () => ReactNode;
}

const TOOL_DEFS: ToolDef[] = [
  {
    id: 'timestamp',
    name: '时间戳转换',
    desc: 'Unix 时间戳与本地时间互转',
    icon: Icon.clock,
    render: () => <TimestampTool />,
  },
  {
    id: 'md5',
    name: 'MD5',
    desc: '文本摘要，不可逆',
    icon: Icon.hash,
    render: () => <Md5Tool />,
  },
  {
    id: 'rank',
    name: '段位换算',
    desc: '编号与段位互查',
    icon: Icon.bolt,
    render: () => <RankTool />,
  },
];

/* ================================================================== */
/* 页面                                                                */
/* ================================================================== */

export default function ToolboxPage() {
  const conf = useUiConf();
  /* 可见工具 = 注册表 ∩ features.toolbox（顺序就是注册表顺序） */
  const tools = TOOL_DEFS.filter((t) => featureOnOf(conf, 'toolbox', t.id));
  const toolKey = tools.map((t) => t.id).join(',');

  const [activeId, setActiveId] = useState(() => TOOL_DEFS[0]?.id ?? '');
  /*
   * 当前工具必须始终落在 tools 里：用户在 Conf 里关掉一个工具后重启，
   * 不该停在一片空白上（与「常用工具」页同一套处理）。
   */
  useEffect(() => {
    if (!tools.some((t) => t.id === activeId)) setActiveId(tools[0]?.id ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toolKey, activeId]);

  const active = tools.find((t) => t.id === activeId) ?? tools[0];

  if (!active) {
    return (
      <Notice tone="warn">
        「工具箱」里的工具都被关闭了。打开程序目录下的
        <span className="mono"> Conf\features.json</span>，把 <span className="mono">toolbox</span>
        里对应项改回 <span className="mono">true</span> 后重启即可。
      </Notice>
    );
  }

  return (
    <div className="toolbox">
      {/* 收起/展开没有意义（就几个工具），列表固定常驻，工具多了自然出现滚动 */}
      <Card padding={false} className="toolbox-nav-card">
        <nav className="toolbox-nav">
          {tools.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`toolbox-nav-item ${t.id === active.id ? 'active' : ''}`}
              onClick={() => setActiveId(t.id)}
              data-tool={t.id}
            >
              <span className="toolbox-nav-icon">{t.icon}</span>
              <span className="toolbox-nav-text">
                <span className="toolbox-nav-name">{t.name}</span>
                <span className="toolbox-nav-desc">{t.desc}</span>
              </span>
            </button>
          ))}
        </nav>
      </Card>

      <div className="toolbox-main" data-tool-panel={active.id}>
        {active.render()}
      </div>
    </div>
  );
}

/* ================================================================== */
/* 时间戳转换                                                          */
/* ================================================================== */

type TsUnit = 'auto' | 's' | 'ms';

const UNIT_OPTIONS: { value: TsUnit; label: string }[] = [
  { value: 'auto', label: '自动' },
  { value: 's', label: '秒' },
  { value: 'ms', label: '毫秒' },
];

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function pad3(n: number): string {
  return String(n).padStart(3, '0');
}

/** 本地时间 `YYYY-MM-DD HH:mm:ss` */
function fmtLocal(ms: number, withMs = false): string {
  const d = new Date(ms);
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}` +
    (withMs ? `.${pad3(d.getMilliseconds())}` : '')
  );
}

/** UTC 时间，末尾带 UTC 免得和本地时间看混 */
function fmtUtc(ms: number): string {
  const d = new Date(ms);
  return (
    `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ` +
    `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())} UTC`
  );
}

/** `<input type="datetime-local">` 认的写法：本地时间，不带时区后缀 */
function toLocalInput(ms: number): string {
  return fmtLocal(ms).replace(' ', 'T');
}

/**
 * 输入框里的一串数字 → 毫秒时间戳。
 *
 * auto 的判定只看**整数位数**：10 位及以下是秒（10 位秒到 2286 年），12 位及以上是毫秒。
 * 11 位是个空档（既像「几千年后的秒」也像「12 位毫秒少了一位」），按秒处理 ——
 * 反正这种值本身就多半是手抖，宁可给个能看见的结果，也好过弹一堆错。
 */
function parseTimestamp(raw: string, unit: TsUnit): number | null {
  const s = raw.trim().replace(/[,_\s]/g, '');
  if (!s) return null;
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const val = Number(s);
  if (!Number.isFinite(val)) return null;

  const digits = s.replace(/^-/, '').split('.')[0].length;
  const isMs = unit === 'ms' || (unit === 'auto' && digits >= 12);
  const ms = isMs ? val : val * 1000;
  // Date 的可表示范围是 ±8.64e15 ms，超了会得到 Invalid Date
  if (Number.isNaN(new Date(ms).getTime())) return null;
  return ms;
}

/** 与「现在」的差，带单位，读一眼就知道差多远 */
function fmtRelative(ms: number, now: number): string {
  const diff = ms - now;
  const abs = Math.abs(diff);
  const suffix = diff >= 0 ? '后' : '前';
  if (abs < 1000) return '就在此刻';
  const sec = Math.floor(abs / 1000);
  if (sec < 60) return `${sec} 秒${suffix}`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟${suffix}`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时${suffix}`;
  const day = Math.floor(hour / 24);
  if (day < 30) return `${day} 天${suffix}`;
  const month = Math.floor(day / 30);
  if (month < 12) return `${month} 个月${suffix}`;
  return `${Math.floor(day / 365)} 年${suffix}`;
}

function TimestampTool() {
  const toast = useApp((s) => s.toast);
  /* 每秒走一次：「当前时间戳」和「距今」都靠它活着 */
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const [unit, setUnit] = useState<TsUnit>('auto');
  const [tsInput, setTsInput] = useState('');
  const [dtInput, setDtInput] = useState(() => toLocalInput(Date.now()));

  const parsed = parseTimestamp(tsInput, unit);
  const dtMs = dtInput ? new Date(dtInput).getTime() : NaN;

  const copy = async (label: string, text: string) => {
    const ok = await copyToClipboard(text);
    toast(ok ? 'success' : 'warn', ok ? `${label}已复制` : '复制失败', ok ? text : '');
  };

  return (
    <Card title="时间戳转换" subtitle="Unix 时间戳与本机时间互转，全部按本地时区计算">
      <div className="tb-block">
        <div className="tb-block-title">当前时间戳</div>
        <ResultRow label="秒" value={String(Math.floor(now / 1000))} onCopy={(v) => copy('秒级时间戳', v)} />
        <ResultRow label="毫秒" value={String(now)} onCopy={(v) => copy('毫秒级时间戳', v)} />
        <ResultRow label="本地时间" value={fmtLocal(now, true)} onCopy={(v) => copy('时间', v)} />
      </div>

      <div className="tb-block">
        <div className="tb-block-title">时间戳 → 时间</div>
        <div className="tb-input-row">
          <Input
            value={tsInput}
            onChange={(e) => setTsInput(e.target.value)}
            placeholder="输入时间戳，如 1731234567"
            inputMode="numeric"
            spellCheck={false}
            data-tb-input="ts"
          />
          <Segmented value={unit} onChange={setUnit} options={UNIT_OPTIONS} size="sm" />
        </div>
        {parsed === null ? (
          <div className="tb-hint">
            {tsInput.trim() ? '看不懂这串数字，请只输入数字（可带小数）' : '输入后自动换算'}
          </div>
        ) : (
          <>
            <ResultRow label="本地时间" value={fmtLocal(parsed, true)} onCopy={(v) => copy('时间', v)} />
            <ResultRow label="UTC" value={fmtUtc(parsed)} onCopy={(v) => copy('UTC 时间', v)} />
            <ResultRow
              label="ISO 8601"
              value={new Date(parsed).toISOString()}
              onCopy={(v) => copy('ISO 时间', v)}
            />
            <ResultRow label="距今" value={fmtRelative(parsed, now)} />
          </>
        )}
      </div>

      <div className="tb-block">
        <div className="tb-block-title">时间 → 时间戳</div>
        <div className="tb-input-row">
          <input
            type="datetime-local"
            step="1"
            className="input"
            value={dtInput}
            onChange={(e) => setDtInput(e.target.value)}
            data-tb-input="dt"
          />
          <Button size="sm" onClick={() => setDtInput(toLocalInput(Date.now()))}>
            现在
          </Button>
        </div>
        {Number.isNaN(dtMs) ? (
          <div className="tb-hint">选择一个日期时间</div>
        ) : (
          <>
            <ResultRow
              label="秒"
              value={String(Math.floor(dtMs / 1000))}
              onCopy={(v) => copy('秒级时间戳', v)}
            />
            <ResultRow label="毫秒" value={String(dtMs)} onCopy={(v) => copy('毫秒级时间戳', v)} />
          </>
        )}
      </div>
    </Card>
  );
}

/* ================================================================== */
/* MD5                                                                 */
/* ================================================================== */

function Md5Tool() {
  const toast = useApp((s) => s.toast);
  const [text, setText] = useState('');
  /* 输入几十万字也是几十毫秒级，直接 useMemo 同步算，不做防抖（防抖反而让结果慢半拍） */
  const digest = useMemo(() => (text ? md5(text) : ''), [text]);

  const copy = async (label: string, value: string) => {
    const ok = await copyToClipboard(value);
    toast(ok ? 'success' : 'warn', ok ? `${label}已复制` : '复制失败', ok ? value : '');
  };

  return (
    <Card title="MD5" subtitle="按 UTF-8 计算，与 md5sum 等命令行工具的结果一致">
      <Textarea
        rows={6}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="粘贴要计算摘要的文本，支持中文与换行"
        data-tb-input="md5"
      />

      <div className="tb-toolbar">
        <span className="tb-hint">{text.length ? `${text.length} 个字符` : ''}</span>
        <Button size="sm" variant="ghost" onClick={() => setText('')} disabled={!text}>
          清空
        </Button>
      </div>

      <div className="tb-block tb-block-flat">
        <ResultRow label="32 位小写" value={digest || '—'} onCopy={(v) => copy('MD5', v)} />
        <ResultRow label="32 位大写" value={digest ? digest.toUpperCase() : '—'} onCopy={(v) => copy('MD5', v)} />
        <ResultRow label="16 位" value={digest ? digest.slice(8, 24) : '—'} onCopy={(v) => copy('MD5', v)} />
      </div>
    </Card>
  );
}

/* ================================================================== */
/* 段位换算                                                            */
/* ================================================================== */

/**
 * 两条独立的路径，互不联动：上面「输编号看段位」，下面「选段位看编号」。
 * 联动会让两边互相回写，改一个字符就跳回上一格，手感很差。
 */
function RankTool() {
  const toast = useApp((s) => s.toast);

  /* ---------------- 编号 → 段位 ---------------- */
  const [raw, setRaw] = useState('');
  const level = parseLevelInput(raw);
  const info = level === null ? null : describeLevel(level);

  /* ---------------- 段位 → 编号 ---------------- */
  /* tierIdx 等于 RANK_TIERS.length 时是王者（没有小段） */
  const KING = RANK_TIERS.length;
  const [tierIdx, setTierIdx] = useState(0);
  const [sub, setSub] = useState(RANK_TIERS[0].subs[0]);
  const [star, setStar] = useState(1);
  const [kingStar, setKingStar] = useState(1);

  const isKing = tierIdx === KING;
  const tier = isKing ? null : RANK_TIERS[tierIdx];
  const picked = isKing ? kingLevel(kingStar) : levelOf(tierIdx, sub, star);

  const changeTier = (i: number) => {
    setTierIdx(i);
    /* 换大段后旧的小段/星级可能不存在（青铜没有 Ⅴ、大师没有 1⭐ 以外的 3⭐） */
    if (i < KING) {
      setSub(RANK_TIERS[i].subs[0]);
      setStar(1);
    }
  };

  const copy = async (value: string) => {
    const ok = await copyToClipboard(value);
    toast(ok ? 'success' : 'warn', ok ? '编号已复制' : '复制失败', ok ? value : '');
  };

  const tierOptions = [
    ...RANK_TIERS.map((t, i) => ({ value: String(i), label: t.name })),
    { value: String(KING), label: '王者' },
  ];

  return (
    <Card title="段位换算" subtitle="编号与段位互查">
      <div className="tb-block">
        <div className="tb-block-title">编号 → 段位</div>
        <Input
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          placeholder="输入编号，如 55"
          inputMode="numeric"
          spellCheck={false}
          data-tb-input="rank-level"
        />
        {info ? (
          <div className="rank-result" data-rank-result={info.text}>
            <span className="rank-name">{info.name}</span>
            {info.sub !== null && <span className="rank-sub">{ROMAN[info.sub]}</span>}
            <span className="rank-stars">{info.star}⭐</span>
            <span className="rank-range">
              {info.from === info.to ? info.from : `${info.from} – ${info.to}`}
            </span>
          </div>
        ) : (
          <div className="tb-hint">
            {raw.trim() ? `只认 0 – ${MAX_LEVEL} 的整数编号` : '输入后自动换算'}
          </div>
        )}
      </div>

      <div className="tb-block">
        <div className="tb-block-title">段位 → 编号</div>
        <div className="tb-input-row rank-picker">
          <Select
            value={String(tierIdx)}
            onChange={(e) => changeTier(Number(e.target.value))}
            options={tierOptions}
            data-rank-tier=""
          />
          {!isKing && (
            <Select
              value={String(sub)}
              onChange={(e) => setSub(Number(e.target.value))}
              options={tier!.subs.map((s) => ({ value: String(s), label: ROMAN[s] }))}
              data-rank-sub=""
            />
          )}
          {isKing ? (
            <Input
              type="number"
              min={1}
              max={KING_MAX_STARS}
              value={String(kingStar)}
              onChange={(e) => {
                const n = Number(e.target.value);
                setKingStar(
                  Number.isFinite(n) ? Math.min(KING_MAX_STARS, Math.max(1, Math.trunc(n))) : 1,
                );
              }}
              data-rank-star=""
            />
          ) : (
            <Select
              value={String(star)}
              onChange={(e) => setStar(Number(e.target.value))}
              options={Array.from({ length: tier!.stars }, (_, i) => ({
                value: String(i + 1),
                label: `${i + 1}⭐`,
              }))}
              data-rank-star=""
            />
          )}
        </div>
        <ResultRow
          label="编号"
          value={picked === null ? '—' : String(picked)}
          onCopy={picked === null ? undefined : (v) => copy(v)}
        />
      </div>
    </Card>
  );
}

/* ================================================================== */
/* 结果行                                                              */
/* ================================================================== */

/**
 * 一行「标签 + 值 + 复制」。
 *
 * 值区不换行、超长省略，完整值挂在 title 上：时间戳/摘要这类内容一行放不下时
 * 撑高整块反而更难读。没有 onCopy 的行（如「距今」）不显示复制按钮。
 */
function ResultRow({
  label,
  value,
  onCopy,
}: {
  label: string;
  value: string;
  onCopy?: (v: string) => void;
}) {
  const empty = !value || value === '—';
  return (
    <div className="tb-row">
      <span className="tb-row-label">{label}</span>
      <span className={`tb-row-value mono ${empty ? 'is-empty' : ''}`} title={value}>
        {value || '—'}
      </span>
      {onCopy && (
        <button
          type="button"
          className="icon-btn sm tb-copy"
          title="复制"
          aria-label={`复制${label}`}
          disabled={empty}
          onClick={() => onCopy(value)}
        >
          {Icon.copy}
        </button>
      )}
    </div>
  );
}
