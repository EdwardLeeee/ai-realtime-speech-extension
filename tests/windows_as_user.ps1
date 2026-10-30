# CI 用：GitHub Actions 的 Windows 測試機是系統管理員，一般使用者才會遇到的問題（例如 issue #1 的 RedirectionGuard）
# 在那裡看不到，所以建一個一般權限的本機帳號，用它執行安裝和測試，和使用者自己點兩下 Setup.exe 一樣。
# 用排程工作執行：環境變數、HKCU、使用者資料夾都是那個帳號自己的（Start-Process -Credential 會帶著系統管理員的環境變數）。
#   pwsh tests/windows_as_user.ps1 -Create                    建帳號（密碼隨機，寫進 GITHUB_ENV 給後面的步驟用）
#   pwsh tests/windows_as_user.ps1 -Command '<PowerShell 指令>'  用那個帳號執行（{workspace} 換成 repo 的位置），
#                                                                印出輸出，用它的結束碼結束
# 這個檔案存成 UTF-8 加 BOM（和 install.ps1 一樣）。
param([switch]$Create, [string]$Command, [int]$TimeoutMinutes = 40)
$ErrorActionPreference = 'Stop'
$User = 'ttuser'
$Shared = 'C:\tt-shared' # 兩個帳號都能讀寫：放要執行的腳本和輸出
$Task = 'tab-transcriber-as-user'

if ($Create) {
  # 14 個字元以內 net user 才不會問「密碼超過 14 個字元」；大小寫、數字、符號都有，符合密碼原則
  $password = 'Tt1!' + [guid]::NewGuid().ToString('N').Substring(0, 10)
  Write-Output "::add-mask::$password"
  net user $User $password /add | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "建帳號失敗" }
  if ((net localgroup Administrators) -match "^$User$") { throw "$User 不應該是系統管理員" }
  # 排程工作用密碼登入要「以批次工作登入」的權限，伺服器版 Windows 預設只給系統管理員
  $sid = (New-Object Security.Principal.NTAccount $User).Translate([Security.Principal.SecurityIdentifier]).Value
  $inf = Join-Path $env:RUNNER_TEMP 'rights.inf'
  secedit /export /cfg $inf /areas USER_RIGHTS | Out-Null
  $lines = Get-Content $inf
  if ($lines -match '^SeBatchLogonRight') {
    $lines = $lines -replace '^(SeBatchLogonRight\s*=.*)$', "`$1,*$sid"
  } else {
    $lines = $lines -replace '^\[Privilege Rights\]$', "[Privilege Rights]`r`nSeBatchLogonRight = *$sid"
  }
  Set-Content $inf $lines -Encoding Unicode
  secedit /configure /db (Join-Path $env:RUNNER_TEMP 'rights.sdb') /cfg $inf /areas USER_RIGHTS | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "設定批次登入權限失敗" }
  New-Item -ItemType Directory -Force $Shared | Out-Null
  icacls $Shared /grant "${User}:(OI)(CI)M" /Q | Out-Null
  # 測試要讀 repo 裡的錄音和程式
  icacls $env:GITHUB_WORKSPACE /grant "${User}:(OI)(CI)RX" /T /Q | Out-Null
  "TT_USER_PASSWORD=$password" | Add-Content $env:GITHUB_ENV
  Write-Output "已建一般使用者 $User"
  exit 0
}

if (-not $Command) { throw '要給 -Create 或 -Command' }
if (-not $env:TT_USER_PASSWORD) { throw '找不到 TT_USER_PASSWORD，先執行 -Create' }
$step = Join-Path $Shared 'step.ps1'
$log = Join-Path $Shared 'step.log'
# Windows PowerShell 5.1 讀沒有 BOM 的 .ps1 會當成系統字碼頁
# 輸出經 cmd 寫進檔案：PowerShell 5.1 和 Python 預設都用系統字碼頁，中文會變問號或出錯，所以都改 UTF-8；
# 原生程式寫 stderr 不算失敗，只看結束碼
$prelude = @'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding $false
$env:PYTHONIOENCODING = 'utf-8'
$ErrorActionPreference = 'Continue'
'@
Set-Content $step -Value ($prelude + "`r`n" + $Command.Replace('{workspace}', $env:GITHUB_WORKSPACE)) -Encoding utf8BOM
Remove-Item $log -ErrorAction SilentlyContinue
# cmd 負責把輸出寫進 step.log；它的結束碼就是 PowerShell 的結束碼，排程工作記在 LastTaskResult
$action = New-ScheduledTaskAction -Execute 'cmd.exe' -WorkingDirectory $Shared `
  -Argument "/c powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$step`" > `"$log`" 2>&1"
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes $TimeoutMinutes)
Register-ScheduledTask -TaskName $Task -Action $action -Settings $settings -User $User -Password $env:TT_USER_PASSWORD -RunLevel Limited -Force | Out-Null
$started = Get-Date
Start-ScheduledTask -TaskName $Task

# 等它跑完，邊等邊印新的輸出
$shown = 0
$deadline = $started.AddMinutes($TimeoutMinutes + 1)
do {
  Start-Sleep 5
  if (Test-Path $log) {
    $lines = @(Get-Content $log -ErrorAction SilentlyContinue)
    if ($lines.Count -gt $shown) { $lines[$shown..($lines.Count - 1)] | Write-Output; $shown = $lines.Count }
  }
  $info = Get-ScheduledTaskInfo -TaskName $Task
  $state = (Get-ScheduledTask -TaskName $Task).State
  # 267009 = 執行中，267011 = 還沒執行過
  $done = $state -ne 'Running' -and $info.LastRunTime -ge $started.AddSeconds(-5) -and $info.LastTaskResult -notin 267009, 267011
} until ($done -or (Get-Date) -gt $deadline)
if (Test-Path $log) {
  $lines = @(Get-Content $log -ErrorAction SilentlyContinue)
  if ($lines.Count -gt $shown) { $lines[$shown..($lines.Count - 1)] | Write-Output }
}
Unregister-ScheduledTask -TaskName $Task -Confirm:$false
if (-not $done) { throw "以 $User 執行逾時（$TimeoutMinutes 分鐘）" }
Write-Output "（以 $User 執行，結束碼 $($info.LastTaskResult)）"
exit $info.LastTaskResult
