/**
 * 探针 7：子进程到底在不在 Job Object 里？job 有没有 KILL_ON_JOB_CLOSE / BREAKAWAY_OK？
 *
 * 起因：探针 5/6 证明 Electron spawn 出来的进程**一律活不过主进程退出**
 * （连「自己持有文件句柄」也不行）。这把「用外部 PowerShell 助手替换 app.asar」
 * 的整套设计架在火上烤 —— 助手必须在应用退出之后还活着。
 *
 * 本探针起一个 python 子进程，让它用 ctypes 调：
 *   IsProcessInJob(GetCurrentProcess(), NULL, &r)          —— 在不在任何 job 里
 *   QueryInformationJobObject(..., BasicLimitInformation)  —— job 的 LimitFlags
 * 同时也在 **Electron 主进程自己** 身上查一遍（通过再起一个 python 查它的 pid）。
 * 主进程保持存活 6 秒，保证子进程能被读取输出。
 */
const { app } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const T = os.tmpdir();
const TAG = Date.now();
const PY = 'C:\\Users\\yangming\\.workbuddy\\binaries\\python\\versions\\3.13.12\\python.exe';
const out = path.join(T, `p7-report-${TAG}.txt`);
const lines = [`electron=${process.versions.electron} pid=${process.pid}`];

const SRC = `
import ctypes, sys, os
from ctypes import wintypes
k32 = ctypes.WinDLL('kernel32', use_last_error=True)
k32.GetCurrentProcess.restype = wintypes.HANDLE
k32.IsProcessInJob.argtypes = [wintypes.HANDLE, wintypes.HANDLE, ctypes.POINTER(wintypes.BOOL)]
k32.IsProcessInJob.restype = wintypes.BOOL

class JOBOBJECT_BASIC_LIMIT_INFORMATION(ctypes.Structure):
    _fields_ = [('PerProcessUserTimeLimit', wintypes.LARGE_INTEGER),
                ('PerJobUserTimeLimit', wintypes.LARGE_INTEGER),
                ('LimitFlags', wintypes.DWORD),
                ('MinimumWorkingSetSize', ctypes.c_size_t),
                ('MaximumWorkingSetSize', ctypes.c_size_t),
                ('ActiveProcessLimit', wintypes.DWORD),
                ('Affinity', ctypes.POINTER(wintypes.ULONG)),
                ('PriorityClass', wintypes.DWORD),
                ('SchedulingClass', wintypes.DWORD)]

class IO_COUNTERS(ctypes.Structure):
    _fields_ = [('ReadOperationCount', ctypes.c_ulonglong), ('WriteOperationCount', ctypes.c_ulonglong),
                ('OtherOperationCount', ctypes.c_ulonglong), ('ReadTransferCount', ctypes.c_ulonglong),
                ('WriteTransferCount', ctypes.c_ulonglong), ('OtherTransferCount', ctypes.c_ulonglong)]

class JOBOBJECT_EXTENDED_LIMIT_INFORMATION(ctypes.Structure):
    _fields_ = [('BasicLimitInformation', JOBOBJECT_BASIC_LIMIT_INFORMATION),
                ('IoInfo', IO_COUNTERS),
                ('ProcessMemoryLimit', ctypes.c_size_t),
                ('JobMemoryLimit', ctypes.c_size_t),
                ('PeakProcessMemoryUsed', ctypes.c_size_t),
                ('PeakJobMemoryUsed', ctypes.c_size_t)]

JobObjectBasicLimitInformation = 2
JobObjectExtendedLimitInformation = 9

def query(pid):
    h = k32.OpenProcess(0x0400 | 0x1000, False, pid)  # QUERY_INFORMATION|QUERY_LIMITED_INFORMATION
    r = wintypes.BOOL()
    k32.IsProcessInJob(h, None, ctypes.byref(r))
    line = 'pid=%d inJob=%s' % (pid, bool(r.value))
    if r.value:
        info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
        ret = wintypes.DWORD()
        h2 = k32.OpenProcess(0x0400, False, pid)
        # 需要 job 句柄；用 NULL 不行，改为直接查当前进程所在 job 的方式：
        # QueryInformationJobObject(NULL, ...) 查的是「当前进程所属 job」
        ok = k32.QueryInformationJobObject(None, JobObjectExtendedLimitInformation, ctypes.byref(info), ctypes.sizeof(info), ctypes.byref(ret))
        err = ctypes.get_last_error()
        if ok:
            lf = info.BasicLimitInformation.LimitFlags
            line += ' LimitFlags=0x%X' % lf
            flags = []
            if lf & 0x00002000: flags.append('KILL_ON_JOB_CLOSE')
            if lf & 0x00000800: flags.append('BREAKAWAY_OK')
            if lf & 0x00001000: flags.append('SILENT_BREAKAWAY_OK')
            if lf & 0x00000400: flags.append('DIE_ON_UNHANDLED_EXCEPTION')
            if lf & 0x00000004: flags.append('ACTIVE_PROCESS')
            line += ' [' + ','.join(flags) + ']'
        else:
            line += ' QueryInfo 失败 err=%d' % err
    return line

print(query(int(sys.argv[1])))
print('self ' + query(os.getpid()))
print('parent(electron) ' + query(int(sys.argv[2])))
`;

const pyFile = path.join(T, `p7-job-${TAG}.py`);
fs.writeFileSync(pyFile, SRC, 'utf8');

const c = spawn(PY, [pyFile, String(process.pid), String(process.pid)], { stdio: ['ignore', 'pipe', 'pipe'], cwd: T });
let so = '',
  se = '';
c.stdout.on('data', (d) => (so += d.toString('utf8')));
c.stderr.on('data', (d) => (se += d.toString('utf8')));
c.on('error', (e) => (se += ' ERR ' + e.message));

app.whenReady().then(() => {
  setTimeout(() => {
    lines.push('--- python 子进程输出 ---');
    lines.push(so.trim() || '(空)');
    if (se.trim()) lines.push('--- stderr ---\n' + se.trim().slice(0, 600));
    fs.writeFileSync(out, lines.join('\n'), 'utf8');
    app.exit(0);
  }, 6000);
});
