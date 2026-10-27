# 安裝本機轉文字程式（Windows）：建 Python 環境、先下載 Whisper 模型與雙語字幕用的翻譯模型、向 Brave／Chrome／Edge 註冊 native messaging host。
# 用法：Setup.exe 安裝時會自動執行它；或點兩下 install.cmd；或 powershell -ExecutionPolicy Bypass -File install.ps1
#       powershell -ExecutionPolicy Bypass -File install.ps1 -NoTranslate   不下載翻譯模型（約 2 GB）；之後打開雙語字幕會提示再執行一次
# Windows PowerShell 5.1 讀沒有 BOM 的 .ps1 會當成系統字碼頁，所以這個檔案存成 UTF-8 加 BOM。
param([switch]$NoTranslate)
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSEdition -eq 'Desktop') {
  # 從 PowerShell 7（例如 Windows 終端機）啟動時會帶著它的 PSModulePath，Windows PowerShell 5.1 就找不到
  # Get-FileHash、Expand-Archive 這些內建指令（GitHub Actions 實測），所以換回 5.1 自己的模組路徑。
  $env:PSModulePath = @("$HOME\Documents\WindowsPowerShell\Modules",
    [Environment]::GetEnvironmentVariable('PSModulePath', 'Machine')) -join ';'
}

$Root = $PSScriptRoot
$HostName = 'com.tab_transcriber.host'
$ExtId = 'pclblnfmncjbohcnbhlkgefpdhpljiae' # 由 extension/manifest.json 的 key 決定

# 雙語字幕：llama.cpp 的 Vulkan 版（有顯示卡用顯示卡，沒有就用 CPU）＋騰訊 Hy-MT2-1.8B 翻譯模型。
# 版本和 SHA-256 和 install.sh 一樣寫死，換版時要一起更新（SHA-256 取自 GitHub release 與 Hugging Face 頁面）。
$LlamaTag = 'b11840'
$LlamaUrl = "https://github.com/ggml-org/llama.cpp/releases/download/$LlamaTag/llama-$LlamaTag-bin-win-vulkan-x64.zip"
$LlamaSha256 = '406c827d9cb6f968eafeabdfb6bca5a2c3c3a20722f6b8d4f0714fcba303a492'
$LlamaDir = Join-Path $Root 'host\vendor\llama.cpp'
$MtUrl = 'https://huggingface.co/tencent/Hy-MT2-1.8B-GGUF/resolve/main/Hy-MT2-1.8B-Q8_0.gguf'
$MtSha256 = '5c3fe0b1408a5ceb0143184ef247b11b579c525f4b02b060e6c851bb76fef1a4'
$MtPath = Join-Path $HOME '.cache\tab-transcriber\models\Hy-MT2-1.8B-Q8_0.gguf'

# 安裝過程另外記一份在 install.log（Setup.exe 失敗時請使用者看這個檔）
Start-Transcript -Path (Join-Path $Root 'install.log') -Force | Out-Null

# 原生程式寫到 stderr 的進度訊息不算錯誤（PowerShell 5.1 在 Stop 模式下會把它當成例外），只看 $LASTEXITCODE。
function Invoke-Native([scriptblock]$Command) {
  $ErrorActionPreference = 'Continue'
  & $Command
}

# 沒有 uv 就先裝：有 winget 用 winget，沒有就用 uv 官方的安裝程式；裝好的位置加進這次的 PATH。
if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
  Write-Host '找不到 uv，先安裝 uv…'
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    Invoke-Native { winget install --id=astral-sh.uv -e --accept-source-agreements --accept-package-agreements }
  }
  $env:PATH = "$env:LOCALAPPDATA\Microsoft\WinGet\Links;$HOME\.local\bin;$env:PATH"
  if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
    Invoke-Native { powershell -NoProfile -ExecutionPolicy Bypass -Command 'irm https://astral.sh/uv/install.ps1 | iex' }
  }
  if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
    throw '沒辦法自動安裝 uv。請照 https://docs.astral.sh/uv/ 安裝後再執行一次。'
  }
}

# 下載到 .part，核對 SHA-256 才改成正式檔名；已經有而且核對正確就跳過。用 Windows 10 起內建的 curl.exe，可以續傳。
function Get-Verified($Url, $Dest, $Sha) {
  if ((Test-Path $Dest) -and (Get-FileHash $Dest -Algorithm SHA256).Hash -eq $Sha) { return }
  New-Item -ItemType Directory -Force (Split-Path $Dest) | Out-Null
  Invoke-Native { curl.exe -fL --retry 3 -C - '-#' -o "$Dest.part" $Url }
  if ($LASTEXITCODE -ne 0) { throw "下載失敗，請再執行一次：$Url" }
  if ((Get-FileHash "$Dest.part" -Algorithm SHA256).Hash -ne $Sha) {
    Remove-Item "$Dest.part"
    throw "下載的檔案核對不符，請再執行一次：$Url"
  }
  Move-Item -Force "$Dest.part" $Dest
}

# 有 NVIDIA 驅動（nvidia-smi 能跑）就裝 gpu 選配：pip 版的 CUDA 12 cuBLAS／cuDNN 9（約 2 GB）。
$Gpu = $false
if (Get-Command nvidia-smi -ErrorAction SilentlyContinue) {
  Invoke-Native { nvidia-smi } | Out-Null
  $Gpu = $LASTEXITCODE -eq 0
}

Write-Host '建立 Python 環境…'
$extra = @()
if ($Gpu) { $extra = @('--extra', 'gpu') }
Invoke-Native { uv sync --project (Join-Path $Root 'host') --frozen --quiet @extra }
if ($LASTEXITCODE -ne 0) { throw 'uv sync 失敗' }

Write-Host '準備 Whisper 模型（第一次要下載 1–3 GB）…'
$python = Join-Path $Root 'host\.venv\Scripts\python.exe'
$downloadArgs = @('--download')
if ($Gpu) { $downloadArgs += '--gpu' }
Invoke-Native { & $python (Join-Path $Root 'host\transcriber_host.py') @downloadArgs }
if ($LASTEXITCODE -ne 0) { throw 'Whisper 模型下載失敗' }

if (-not $NoTranslate) {
  Write-Host '準備雙語字幕的翻譯模型（第一次要下載約 2 GB）…'
  $versionFile = Join-Path $LlamaDir 'VERSION'
  if (-not (Test-Path $versionFile) -or (Get-Content $versionFile) -ne "$LlamaTag-vulkan") {
    $zip = Join-Path ([IO.Path]::GetTempPath()) "llama-$LlamaTag-win-vulkan.zip"
    Get-Verified $LlamaUrl $zip $LlamaSha256
    if (Test-Path "$LlamaDir.new") { Remove-Item -Recurse -Force "$LlamaDir.new" }
    Expand-Archive -Path $zip -DestinationPath "$LlamaDir.new"
    Set-Content -Path "$LlamaDir.new\VERSION" -Value "$LlamaTag-vulkan" -Encoding ASCII
    if (Test-Path $LlamaDir) { Remove-Item -Recurse -Force $LlamaDir }
    Move-Item "$LlamaDir.new" $LlamaDir
    Remove-Item $zip
  }
  Get-Verified $MtUrl $MtPath $MtSha256
}

# Windows 的瀏覽器從登錄檔找註冊檔：HKCU\Software\<瀏覽器>\NativeMessagingHosts\<名稱> 的預設值是 JSON 檔的路徑。
$manifestPath = Join-Path $Root "host\$HostName.json"
$manifest = [ordered]@{
  name            = $HostName
  description     = 'Tab Transcriber 本機轉文字程式（faster-whisper）'
  path            = (Join-Path $Root 'host\run_host.bat')
  type            = 'stdio'
  allowed_origins = @("chrome-extension://$ExtId/")
}
# 不加 BOM（Set-Content -Encoding UTF8 在 PowerShell 5.1 會加）
[IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json), (New-Object Text.UTF8Encoding $false))

foreach ($browser in 'BraveSoftware\Brave-Browser', 'Google\Chrome', 'Chromium', 'Microsoft\Edge') {
  $key = "HKCU:\Software\$browser\NativeMessagingHosts\$HostName"
  New-Item -Path $key -Force | Out-Null
  Set-Item -Path $key -Value $manifestPath
  Write-Host "已註冊：$key"
}
Write-Host "完成。接著在瀏覽器的擴充功能頁載入 $(Join-Path $Root 'extension')（見 README.md）。"
Stop-Transcript | Out-Null
