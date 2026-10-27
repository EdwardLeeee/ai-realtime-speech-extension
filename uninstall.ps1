# 移除 install.ps1 寫進登錄檔的註冊和註冊檔。專案資料夾和下載的模型不動。
# 用法：powershell -ExecutionPolicy Bypass -File uninstall.ps1
$ErrorActionPreference = 'Stop'
$HostName = 'com.tab_transcriber.host'
foreach ($browser in 'BraveSoftware\Brave-Browser', 'Google\Chrome', 'Chromium', 'Microsoft\Edge') {
  $key = "HKCU:\Software\$browser\NativeMessagingHosts\$HostName"
  if (Test-Path $key) {
    Remove-Item -Path $key -Recurse
    Write-Host "已移除：$key"
  }
}
$manifestPath = Join-Path $PSScriptRoot "host\$HostName.json"
if (Test-Path $manifestPath) { Remove-Item $manifestPath; Write-Host "已移除：$manifestPath" }
