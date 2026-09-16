# 更新助手（由应用 spawn 出来、脱离应用进程独立运行）
#
# 为什么必须是「非 Electron 的外部程序」：
#   Electron 运行期间 resources/app.asar 被独占锁定（实测 os.replace → WinError 5、
#   rename → WinError 32），连「再起一个自己的实例来替换」都不行 —— 那个实例同样会锁住
#   asar。所以只能用系统自带的 PowerShell（不落地任何自制 exe，避免被杀软拦）。
#
# 参数传递方式：
#   脚本正文里的 __STAGING__ 会被应用替换成暂存目录（ASCII 路径），整段脚本经
#   -EncodedCommand（UTF-16LE + base64）传进来 —— 命令行上只有 base64，彻底绕开
#   「命令行编码 / 执行策略 / 中文路径乱码」三个坑。
#
# 工作流程：
#   等旧进程退出 → 等目标文件解锁 → 备份 → 替换（先写 .new 再原子替换）→ 清标记
#   → 启动新版 → 轮询健康标记（渲染层完成一次 IPC 握手才会出现）
#   → 出现即成功；超时则杀新版进程、还原备份、再启动旧版
#
# 判据为什么是「渲染层握手」而不是「主进程活着」：主进程活着但白屏（渲染层崩）
# 也是坏的，只看进程会把这种坏版本判成成功。

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$staging = '__STAGING__'
$jobPath = Join-Path $staging 'job.json'
$job = Get-Content -LiteralPath $jobPath -Raw -Encoding UTF8 | ConvertFrom-Json

$script:enc = New-Object System.Text.UTF8Encoding($false)

function Write-Utf8($path, $text) {
  $d = Split-Path -Parent $path
  if ($d -and -not (Test-Path -LiteralPath $d)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }
  [System.IO.File]::WriteAllText($path, $text, $script:enc)
}

function Write-Log($msg) {
  $line = '[' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '] ' + $msg + [char]13 + [char]10
  try { [System.IO.File]::AppendAllText($job.logPath, $line, $script:enc) } catch { }
}

function Write-Result($obj) {
  Write-Utf8 $job.resultPath ($obj | ConvertTo-Json -Depth 8)
}

# 文件能不能被独占打开（= 没人占用）
function Wait-FileFree($path, $sec) {
  if (-not (Test-Path -LiteralPath $path)) { return $true }
  $dl = (Get-Date).AddSeconds($sec)
  while ((Get-Date) -lt $dl) {
    try {
      $fs = [System.IO.File]::Open($path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
      $fs.Close()
      return $true
    } catch {
      Start-Sleep -Milliseconds 400
    }
  }
  return $false
}

function Backup-Path($name) {
  return (Join-Path $job.backupDir ('files\' + ($name -replace '/', '\')))
}

function Restore-Files($restore) {
  foreach ($e in $restore.files) {
    if ($e.existed) {
      Copy-Item -LiteralPath (Backup-Path $e.name) -Destination $e.dest -Force
      Write-Log ('restored ' + $e.dest)
    } elseif (Test-Path -LiteralPath $e.dest) {
      Remove-Item -LiteralPath $e.dest -Force
      Write-Log ('removed ' + $e.dest)
    }
  }
}

function Start-App() {
  if (-not $job.launchExe) { return }
  Write-Log ('launch ' + $job.launchExe)
  # ⚠️ 生产里 launchArgs 恒为「空数组」，而 `Start-Process -ArgumentList @()` 会抛
  #    「无法对参数"ArgumentList"执行参数验证。该参数为 Null、为空或参数集合的某个元素包含 Null 值」
  #    —— 于是助手恰好死在「启动新版」这一步，紧接着 catch 把刚替换好的文件全还原回去，
  #    用户看到的是「更新了一趟、版本却没变」。所以空集合时干脆不要传这个参数。
  $a = @()
  if ($job.launchArgs) { $a = @($job.launchArgs | Where-Object { $_ -ne $null -and [string]$_ -ne '' }) }
  $dir = $null
  if ($job.workDir -and (Test-Path -LiteralPath $job.workDir)) { $dir = $job.workDir }
  if ($a.Count -gt 0) {
    if ($dir) { Start-Process -FilePath $job.launchExe -ArgumentList $a -WorkingDirectory $dir | Out-Null }
    else { Start-Process -FilePath $job.launchExe -ArgumentList $a | Out-Null }
  } else {
    if ($dir) { Start-Process -FilePath $job.launchExe -WorkingDirectory $dir | Out-Null }
    else { Start-Process -FilePath $job.launchExe | Out-Null }
  }
}

# 超时回滚时先杀掉「刚启动的新版」，否则它可能还占着文件 / 和旧版抢单实例锁
function Stop-NewApp() {
  if (-not $job.launchExe) { return }
  $n = [System.IO.Path]::GetFileNameWithoutExtension($job.launchExe)
  Get-Process -Name $n -ErrorAction SilentlyContinue | ForEach-Object {
    try { Stop-Process -Id $_.Id -Force } catch { }
  }
}

Write-Log ('helper start mode=' + $job.mode + ' kind=' + $job.kind + ' ' + $job.fromVersion + ' -> ' + $job.toVersion)
Write-Log ('staging=' + $staging)

$restore = $null

try {
  # ---- 1) 等旧进程退出 ----
  if ([int]$job.pid -gt 0) {
    $dl = (Get-Date).AddSeconds(60)
    while ((Get-Date) -lt $dl) {
      if (-not (Get-Process -Id ([int]$job.pid) -ErrorAction SilentlyContinue)) { break }
      Start-Sleep -Milliseconds 300
    }
    if (Get-Process -Id ([int]$job.pid) -ErrorAction SilentlyContinue) {
      throw ('等待旧进程退出超时（pid=' + $job.pid + '）')
    }
  }
  Write-Log 'old process gone'

  # ---- 2) 等目标文件解锁 ----
  foreach ($t in $job.targets) {
    if (-not (Wait-FileFree $t.dest 60)) { throw ('目标文件被占用，无法替换：' + $t.dest) }
  }
  Write-Log 'targets unlocked'

  # ---- 3) 备份（或读取已有备份用于回滚）----
  if ($job.mode -eq 'apply') {
    if (-not (Test-Path -LiteralPath $job.backupDir)) { New-Item -ItemType Directory -Force -Path $job.backupDir | Out-Null }
    $entries = @()
    foreach ($t in $job.targets) {
      $ex = Test-Path -LiteralPath $t.dest
      if ($ex) {
        $bp = Backup-Path $t.name
        $bpDir = Split-Path -Parent $bp
        if (-not (Test-Path -LiteralPath $bpDir)) { New-Item -ItemType Directory -Force -Path $bpDir | Out-Null }
        Copy-Item -LiteralPath $t.dest -Destination $bp -Force
        Write-Log ('backup ' + $t.dest)
      }
      $entries += [pscustomobject]@{ name = $t.name; dest = $t.dest; existed = $ex }
    }
    $restore = [pscustomobject]@{
      schema = 1
      kind = $job.kind
      fromVersion = $job.fromVersion
      toVersion = $job.toVersion
      at = (Get-Date).ToString('o')
      launchExe = $job.launchExe
      launchArgs = @($job.launchArgs)
      workDir = $job.workDir
      logPath = $job.logPath
      files = @($entries)
    }
    Write-Utf8 (Join-Path $job.backupDir 'restore.json') ($restore | ConvertTo-Json -Depth 8)
    Write-Log 'backup done'
  } else {
    $rp = Join-Path $job.backupDir 'restore.json'
    if (-not (Test-Path -LiteralPath $rp)) { throw ('找不到回滚信息：' + $rp) }
    $restore = Get-Content -LiteralPath $rp -Raw -Encoding UTF8 | ConvertFrom-Json
  }

  # ---- 4) 替换 / 还原 ----
  if ($job.mode -eq 'apply') {
    foreach ($t in $job.targets) {
      $new = $t.dest + '.new'
      if (Test-Path -LiteralPath $new) { Remove-Item -LiteralPath $new -Force }
      Copy-Item -LiteralPath $t.src -Destination $new -Force
      # 先整份写好 .new，再原子替换；中断最坏只留下无用的 .new，原文件不受影响
      $ok = $false
      try { [System.IO.File]::Replace($new, $t.dest, $null); $ok = $true } catch { }
      if (-not $ok) {
        if (Test-Path -LiteralPath $t.dest) { Remove-Item -LiteralPath $t.dest -Force }
        Move-Item -LiteralPath $new -Destination $t.dest -Force
      }
      Write-Log ('replaced ' + $t.dest)
    }
  } else {
    Restore-Files $restore
  }

  # ---- 5) 清掉健康标记（必须在启动之前，否则上一轮遗留的标记会让新版被误判为「已就绪」）----
  # 注意：pending.json 故意不删 —— 它是「本次启动是更新后的首次启动」的凭据，
  # 新版渲染层完成握手、读到本次结果之后自己删。
  if ($job.healthPath -and (Test-Path -LiteralPath $job.healthPath)) { Remove-Item -LiteralPath $job.healthPath -Force }

  # ---- 6) 启动 ----
  Start-App

  # ---- 7) 健康检查 ----
  if ($job.mode -eq 'apply' -and [int]$job.healthTimeoutSec -gt 0) {
    $dl = (Get-Date).AddSeconds([int]$job.healthTimeoutSec)
    $healthy = $false
    while ((Get-Date) -lt $dl) {
      if (Test-Path -LiteralPath $job.healthPath) { $healthy = $true; break }
      Start-Sleep -Milliseconds 400
    }

    if ($healthy) {
      Write-Log 'health ok'
      Remove-Item -LiteralPath $job.healthPath -Force -ErrorAction SilentlyContinue
      Write-Result ([pscustomobject]@{
        ok = $true; mode = 'apply'; from = $job.fromVersion; to = $job.toVersion
        at = (Get-Date).ToString('o'); logPath = $job.logPath
      })
    } else {
      Write-Log 'health timeout -> rollback'
      Stop-NewApp
      Start-Sleep -Seconds 2
      Restore-Files $restore
      # 先落结果再拉起旧版：旧版启动后第一件事就是找这份结果，写晚了它会读不到
      Write-Result ([pscustomobject]@{
        ok = $false; mode = 'apply'; from = $job.fromVersion; to = $job.toVersion
        at = (Get-Date).ToString('o'); rolledBack = $true; logPath = $job.logPath
        error = ('新版本启动后 ' + $job.healthTimeoutSec + ' 秒内没有完成界面握手（可能白屏或启动失败），已自动回滚到 v' + $job.fromVersion)
      })
      Start-App
    }
  } else {
    Write-Result ([pscustomobject]@{
      ok = $true; mode = $job.mode; from = $job.fromVersion; to = $job.toVersion
      at = (Get-Date).ToString('o'); logPath = $job.logPath
    })
  }
} catch {
  $err = $_.Exception.Message
  Write-Log ('FAILED: ' + $err)
  try {
    if ($job.mode -eq 'apply') {
      # 备份阶段就失败时 $restore 为 null，此时还没动过任何目标文件，直接拉起旧版即可
      if ($restore) { Restore-Files $restore }
      Start-App
      Write-Result ([pscustomobject]@{
        ok = $false; mode = 'apply'; from = $job.fromVersion; to = $job.toVersion
        at = (Get-Date).ToString('o'); rolledBack = $true; logPath = $job.logPath
        error = $err
      })
    } else {
      Write-Result ([pscustomobject]@{
        ok = $false; mode = $job.mode; from = $job.fromVersion; to = $job.toVersion
        at = (Get-Date).ToString('o'); logPath = $job.logPath; error = $err
      })
    }
  } catch { }
}

Write-Log 'helper exit'
