import { randomUUID } from 'crypto';
import { ensureDevice, listDevices, log, runAdb } from './adb';
import type { AiAdbStep } from '../../shared/types';

/**
 * AI 助手 · adb 指令执行器（v1.1.15）
 * ============================================================
 * 让 AI 自己查设备：模型在回复里给出 ```adb 代码块 → 这里解析 → 执行 → 输出回传 →
 * 模型决定「继续查」还是「给结论」。整条循环在 services/ai.ts 里，这个文件只负责
 * 「一条命令怎么变成一份结果」。
 *
 * 🔴 为什么用文本协议而不是 OpenAI 的 function calling：
 *   本工具同时支持 openai 和 anthropic 两套接口形态，function calling 的
 *   schema 两边完全不同（tools / tool_use blocks），且国产兼容接口对它的支持
 *   参差不齐 —— 有的直接报错，有的静默忽略。代码块协议两条协议通吃，模型本来
 *   就会写 markdown，命中率反而更高。
 *
 * 🔴 为什么命令必须过安全闸门：
 *   这些命令是**模型自己写、自己跑**的，没有人工逐条确认这一步。所以凡是会丢数据
 *   或让手机失联的操作（rm -rf / pm clear / wipe / fastboot / reboot bootloader）
 *   一律拦在执行之前，并把「为什么被拒」回传给模型 —— 它知道后一般会换一种只读的做法。
 *
 * 🔴 输出必须截断：
 *   `dumpsys`、`logcat -d`、`pm list packages -f` 随便一条就能吐几十万字符。
 *   原样塞回模型既烧 token 又可能超出上下文窗口，所以统一保留「头 + 尾」，
 *   中间用一行省略标记代替 —— 头尾各留一半是有意的：开头通常是表头/结论，
 *   结尾通常是异常/失败原因，中间大段重复内容信息量最低。
 */

/* ------------------------------------------------------------------ */
/* 常量                                                                */
/* ------------------------------------------------------------------ */

/**
 * 单条命令回传给模型的输出上限（字符，不是字节）。
 *
 * 为什么是 4000：一轮最多 4 条、最多 6 轮，最坏情况 96k 字符 ≈ 30k token，
 * 加上系统提示词与历史仍然落在 64k 上下文的模型里。再大就有把一个便宜模型
 * 直接顶爆的风险 —— 而截断本身几乎不损失判断力：看失败原因是看尾部，
 * 看结论是看头部，中间大段重复内容本来就没用。
 */
export const MAX_OUTPUT_CHARS = 4000;

/** 一次对话最多执行几轮命令（一轮 = 模型给一批命令 → 执行 → 回传） */
export const MAX_TOOL_ROUNDS = 6;

/** 一轮里最多执行几条命令（防止模型一次甩二十条把一轮拖成几分钟） */
export const MAX_CMDS_PER_ROUND = 4;

/** 单条 adb 命令超时。设备卡住时不能把整轮对话吊死在这里 */
export const ADB_TIMEOUT_MS = 20000;

/**
 * 不该被 -s 指定的全局命令。`adb devices` / `adb connect` 加 -s 会直接报错。
 */
const GLOBAL_CMDS = new Set([
  'devices',
  'connect',
  'disconnect',
  'start-server',
  'kill-server',
  'version',
  'pair',
  'mdns',
  'reconnect',
]);

/**
 * 允许被当成「命令块」的语言标注。
 *
 * 模型不总是乖乖写 adb —— 写 ```bash / ```sh / ```shell 都见过，
 * 所以这些也收，但**内容仍必须逐行以 adb 开头**，否则一律不执行。
 * 这一步是硬防线：模型输出 ```bash\rm -rf /` 也绝不可能被跑起来。
 */
const CMD_LANGS = new Set([
  'adb',
  'bash',
  'sh',
  'shell',
  'cmd',
  'bat',
  'powershell',
  'ps1',
  'ps',
  'console',
  'terminal',
  'text',
  'txt',
  '',
]);

/* ------------------------------------------------------------------ */
/* 系统提示词附加段                                                    */
/* ------------------------------------------------------------------ */

/**
 * 追加在用户系统提示词后面的「工具说明」。
 *
 * 刻意**不让用户改**（不走 Conf/ai.json）：这段一旦被改花，循环要么不触发、
 * 要么永远停不下来（比如把「不要输出代码块就代表结束」那句删掉就是死循环）。
 * 用户自己的提示词仍然在前面生效，这里只补协议。
 */
export const ADB_GUIDE = [
  '',
  '【你可以直接操作设备】',
  '除了回答问题，你可以执行本机的 adb 命令来查真机信息或完成操作。',
  '需要执行时，在回复里单独放一个代码块，语言标注写 adb，一行一条：',
  '',
  '```adb',
  'adb shell dumpsys window | grep mCurrentFocus',
  'adb shell getprop ro.product.model',
  '```',
  '',
  '规则（很重要）：',
  '1. 命令以 adb 开头，程序会原样执行，并把 stdout/stderr 回给你，你再判断下一步。',
  `2. 一次最多 ${MAX_CMDS_PER_ROUND} 条，只写你真正需要结果的命令，不要遍历式地把无关命令全跑一遍。`,
  `   每条输出超过 ${MAX_OUTPUT_CHARS} 字符会被截断（保留首尾），要更多就先缩小查询范围（grep / head / -d 限定时间）。`,
  '3. 过滤/截取在设备内做（用 grep、head、toybox），不要写 Windows 侧的管道或重定向（findstr / type / >）。',
  '4. 不要执行会挂住不退出的命令：logcat 必须带 -d、不要用 top / screenrecord / wait-for-device。',
  '5. 破坏性操作（rm -rf、pm clear、pm uninstall、wipe、fastboot、reboot bootloader）会被程序拒绝，不要尝试。',
  '6. 🔴 信息够了就**不要再输出 adb 代码块**，直接用文字给结论 ——',
  '   输出代码块等于「我还要继续查」，程序会再跑一轮；不输出代码块这一轮就结束了。',
].join('\n');

/* ------------------------------------------------------------------ */
/* 设备摘要                                                            */
/* ------------------------------------------------------------------ */

/**
 * 给模型一句「现在插着哪台机器」。
 *
 * 没有这段，模型会先花两三条命令去 `adb devices` / `getprop` 摸底，
 * 白烧一轮。顺带把「没设备」这件事提前说清楚，省得它对着一台没连上的手机乱试。
 */
export async function deviceSummary(): Promise<string> {
  try {
    const list = await listDevices(false);
    const online = list.filter((d) => d.state === 'device');
    if (online.length === 0) {
      const un = list.some((d) => d.state === 'unauthorized');
      return (
        '【当前设备】没有可用的在线设备，任何 adb 命令都会失败。' +
        (un
          ? '有一台设备未授权，请在手机屏幕上点「允许 USB 调试」。'
          : '请先让用户连接手机并开启 USB 调试，不要靠反复试命令来验证这一点。')
      );
    }
    const d = online[0];
    const bits = [d.model || d.serial, d.brand, d.androidVersion ? `Android ${d.androidVersion}` : '']
      .filter(Boolean)
      .join(' · ');
    const more =
      online.length > 1 ? `；另有 ${online.length - 1} 台在线设备，命令默认作用于第一台` : '';
    return `【当前设备】${bits}（序列号 ${d.serial}）${more}。`;
  } catch (e) {
    return `【当前设备】读取失败：${(e as Error).message}`;
  }
}

/** 拿一台在线设备给命令加 -s；拿不到就返回 undefined（让 adb 自己报错，错误也是信息） */
export async function pickSerial(): Promise<string | undefined> {
  try {
    return await ensureDevice();
  } catch {
    return undefined;
  }
}

/* ------------------------------------------------------------------ */
/* 解析：从模型回复里抠出 adb 命令                                      */
/* ------------------------------------------------------------------ */

/** 一行命令的清洗：去提示符、去整行注释、去续行符 */
function cleanLine(raw: string): string {
  let s = raw.trim();
  if (!s) return '';
  // 复制终端记录时常见的提示符前缀：`$ ` / `> ` / `C:\xxx> ` / `PS C:\xxx> `
  s = s.replace(/^(?:\$|>|PS\s+[^>]*>|[A-Za-z]:\\[^>]*>)\s*/, '');
  s = s.replace(/\\\s*$/, '').trim();
  if (!/^adb(\s|$)/i.test(s)) return '';
  // 行尾注释（要求前后都有空格，避免把 grep "#foo" 这类参数切掉）
  s = s.replace(/\s+#\s.*$/, '').trim();
  return s;
}

/**
 * 把一段模型回复拆成「要执行的命令」和「剩下的正文」。
 *
 * 正文会从回复里剔掉所有代码块 —— 中间轮的正文只是模型的碎念，
 * 界面上用命令列表反而更清楚；最终轮的正文（没有命令时）才当回答展示。
 */
export function parseAdbCommands(text: string): { commands: string[]; body: string } {
  const src = String(text || '');
  const commands: string[] = [];
  const re = /```([^\r\n`]*)\r?\n([\s\S]*?)```/g;
  let last = 0;
  let body = '';
  let m: RegExpExecArray | null;

  while ((m = re.exec(src))) {
    body += src.slice(last, m.index);
    last = m.index + m[0].length;

    const lang = (m[1] || '').trim().toLowerCase();
    const block = m[2] || '';
    const hasAdbLine = /^\s*(?:\$|>)?\s*adb(\s|$)/im.test(block);
    // 语言标注不认识、内容里也没有 adb 行 → 当成普通代码块，只从正文里去掉
    if (!CMD_LANGS.has(lang) && !hasAdbLine) continue;

    for (const raw of block.split(/\r?\n/)) {
      const line = cleanLine(raw);
      if (!line) continue;
      commands.push(line);
      if (commands.length >= MAX_CMDS_PER_ROUND) break;
    }
    if (commands.length >= MAX_CMDS_PER_ROUND) break;
  }

  body += src.slice(last);
  return { commands, body: body.trim() };
}

/* ------------------------------------------------------------------ */
/* 安全闸门                                                            */
/* ------------------------------------------------------------------ */

const DENY_RULES: Array<{ re: RegExp; why: string }> = [
  { re: /\brm\s+(?:-[a-zA-Z]*[rf][a-zA-Z]*\s+)+/i, why: '递归/强制删除设备上的文件' },
  {
    re: /\bmkfs|\bformat\s+(?:\/|[a-z]:)|\bwipe\s+(?:data|userdata|system|all)|factory[_ ]?reset|\bmaster_clear/i,
    why: '格式化分区 / 恢复出厂设置',
  },
  { re: /\bfastboot\b|\bflash\s+(?:boot|system|recovery|super|vbmeta|dtbo)\b/i, why: '刷写分区' },
  {
    re: /\breboot\s+(?:bootloader|recovery|edl|sideload|fastboot|download)\b/i,
    why: '重启到刷机 / 恢复模式（设备会失联）',
  },
  { re: /\bpm\s+uninstall|\bpm\s+clear\b|\bpm\s+disable-user\b/i, why: '卸载应用 / 清除应用数据' },
  { re: /\bcontent\s+delete\b/i, why: '删除设备上的内容数据' },
  { re: /\bsettings\s+put\s+global\s+adb_enabled\s+0\b/i, why: '关闭 USB 调试（会直接断开连接）' },
];

/** 返回拦截原因；null 表示可以执行 */
export function blockedReason(command: string): string | null {
  for (const r of DENY_RULES) {
    if (r.re.test(command)) return r.why;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* 执行                                                                */
/* ------------------------------------------------------------------ */

interface Tok {
  v: string;
  /** 这一 token 在原命令里被引号包着 */
  q: boolean;
}

/** 极简命令行分词：只处理空格分隔与单/双引号，够覆盖 adb 的用法 */
function tokenize(cmd: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < cmd.length) {
    while (i < cmd.length && /\s/.test(cmd[i])) i++;
    if (i >= cmd.length) break;
    let quoted = false;
    let v = '';
    while (i < cmd.length && !/\s/.test(cmd[i])) {
      const c = cmd[i];
      if (c === '"' || c === "'") {
        quoted = true;
        i++;
        while (i < cmd.length && cmd[i] !== c) {
          if (c === '"' && cmd[i] === '\\' && i + 1 < cmd.length) {
            v += cmd[i + 1];
            i += 2;
            continue;
          }
          v += cmd[i];
          i++;
        }
        i++;
      } else {
        v += c;
        i++;
      }
    }
    out.push({ v, q: quoted });
  }
  return out;
}

/**
 * 命令 → runAdb 的参数数组。
 *
 * 🔴 `shell` 之后的部分要**重建成一个整串**再交给 adb：
 *    设备端 sh 会把它重新分词一次，所以参数里的引号必须留着，
 *    否则 `adb shell ls "/sdcard/My Music"` 到设备端就变成三个参数，路径断了。
 *
 * 🔴 但**整串被一对引号包住**时要反过来把引号去掉：
 *    `adb shell "dumpsys window | grep x"` 是最常见的高频写法（不成对包的话
 *    Windows 侧的 | 会截断命令）。这时候引号是「给 Windows 看的」，不能传到设备端 ——
 *    传过去设备端就会把整串当成一个词，管道彻底失效。
 *    判据：shell 后面正好只有一个 token、且它被引号包着。
 */
function buildArgs(command: string, serial?: string): string[] {
  const toks = tokenize(command);
  if (toks.length && /^adb$/i.test(toks[0].v)) toks.shift();

  const shellIdx = toks.findIndex((t) => /^shell$/i.test(t.v));
  let args: string[];
  if (shellIdx >= 0 && shellIdx + 1 < toks.length) {
    const head = toks.slice(0, shellIdx + 1).map((t) => t.v);
    const rest = toks.slice(shellIdx + 1);
    const wholeQuoted = rest.length === 1 && rest[0].q;
    const tail = wholeQuoted
      ? rest[0].v
      : rest.map((t) => (t.q ? `"${t.v.replace(/"/g, '\\"')}"` : t.v)).join(' ');
    args = [...head, tail];
  } else {
    args = toks.map((t) => t.v);
  }
  if (args.length === 0) return args;

  // 模型自己写了 -s / -d / -e，或者这是全局命令 → 不再插
  const hasTarget = args.some((a) => a === '-s' || a === '-d' || a === '-e');
  if (serial && !hasTarget && !GLOBAL_CMDS.has(args[0].toLowerCase())) {
    args = ['-s', serial, ...args];
  }
  return args;
}

/** 头尾各留一半，中间省略 */
function clipOutput(raw: string): { text: string; truncated: boolean } {
  const s = String(raw || '').replace(/\r\n/g, '\n').trim();
  if (!s) return { text: '（无输出）', truncated: false };
  if (s.length <= MAX_OUTPUT_CHARS) return { text: s, truncated: false };
  const half = Math.floor(MAX_OUTPUT_CHARS / 2);
  return {
    text: `${s.slice(0, half)}\n\n…（中间省略 ${s.length - half * 2} 个字符）…\n\n${s.slice(-half)}`,
    truncated: true,
  };
}

/** 执行一条命令，永远返回 step（不抛错）—— 出错本身就是要回传给模型的信息 */
export async function execAdb(command: string, serial?: string): Promise<AiAdbStep> {
  const at = Date.now();
  const id = randomUUID();
  const base = { id, command, output: '', truncated: false, durationMs: 0, at };

  const blocked = blockedReason(command);
  if (blocked) {
    log('warn', 'AI', `已拦截 adb 指令：${command}`, blocked);
    return { ...base, ok: false, code: -1, blocked, output: `（已拦截，未执行：${blocked}）` };
  }

  const args = buildArgs(command, serial);
  if (args.length === 0) {
    return { ...base, ok: false, code: -1, output: '（命令为空，未执行）' };
  }

  const r = await runAdb(args, { timeout: ADB_TIMEOUT_MS, source: 'AI' });
  const raw = [r.stdout || '', r.stderr || ''].filter((x) => x.trim()).join('\n');
  const { text, truncated } = clipOutput(raw);
  return {
    ...base,
    ok: r.ok,
    code: r.code ?? -1,
    output: text,
    truncated,
    durationMs: r.duration,
  };
}

/* ------------------------------------------------------------------ */
/* 结果 → 回传给模型的文本                                              */
/* ------------------------------------------------------------------ */

/** 一条命令的结果摘要（模型下一轮看到的就是这个） */
function stepBlock(step: AiAdbStep, index: number): string {
  const status = step.blocked
    ? `⊘ 未执行（${step.blocked}）`
    : step.ok
      ? `✔ exit 0 · ${step.durationMs}ms`
      : `✘ exit ${step.code} · ${step.durationMs}ms`;
  const cut = step.truncated ? '\n[输出已截断，只给了首尾]' : '';
  return `--- [${index}] ${step.command}\n${status}\n${step.output}${cut}`;
}

/** 把这一批结果拼成下一条 user 消息 */
export function resultsPrompt(steps: AiAdbStep[], from: number): string {
  const blocks = steps.map((s, i) => stepBlock(s, from + i + 1));
  return [
    '【命令执行结果】',
    blocks.join('\n\n'),
    '',
    '如果你还需要更多信息，继续输出 adb 代码块；信息已经够了，就直接用文字给出最终结论，不要再输出代码块。',
  ].join('\n');
}
