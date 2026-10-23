#!/usr/bin/env bash
# 安裝本機轉文字程式：建 Python 環境、先下載 Whisper 模型、向 Brave／Chrome 註冊 native messaging host。
# 用法：./install.sh            註冊到這台電腦上有裝的 Brave、Chrome、Chromium
#       ./install.sh <資料夾>    只把註冊檔寫進指定資料夾（測試用的瀏覽器設定檔）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
HOST_NAME=com.tab_transcriber.host
EXT_ID=pclblnfmncjbohcnbhlkgefpdhpljiae # 由 extension/manifest.json 的 key 決定

command -v uv >/dev/null || { echo "需要先安裝 uv：https://docs.astral.sh/uv/" >&2; exit 1; }

# 有 NVIDIA 驅動（nvidia-smi 能跑）就裝 gpu 選配：pip 版的 CUDA 12 cuBLAS／cuDNN 9（約 2 GB）。
if nvidia-smi >/dev/null 2>&1; then GPU=1; else GPU=0; fi

echo "建立 Python 環境…"
if [ "$GPU" = 1 ]; then
  uv sync --project "$ROOT/host" --frozen --quiet --extra gpu
else
  uv sync --project "$ROOT/host" --frozen --quiet
fi
chmod +x "$ROOT/host/run_host.sh"

echo "準備 Whisper 模型（第一次要下載 1–3 GB）…"
download_args=(--download)
[ "$GPU" = 1 ] && download_args+=(--gpu)
"$ROOT/host/.venv/bin/python" "$ROOT/host/transcriber_host.py" "${download_args[@]}" 2> >(grep -E '^  [a-z]' >&2)

if [ $# -gt 0 ]; then
  dirs=("$1")
else
  dirs=()
  for d in "$HOME/.config/BraveSoftware/Brave-Browser" "$HOME/.config/google-chrome" "$HOME/.config/chromium"; do
    [ -d "$d" ] && dirs+=("$d/NativeMessagingHosts")
  done
  [ ${#dirs[@]} -gt 0 ] || { echo "找不到 Brave、Chrome 或 Chromium 的設定資料夾" >&2; exit 1; }
fi

for d in "${dirs[@]}"; do
  mkdir -p "$d"
  cat > "$d/$HOST_NAME.json" <<JSON
{
  "name": "$HOST_NAME",
  "description": "Tab Transcriber 本機轉文字程式（faster-whisper）",
  "path": "$ROOT/host/run_host.sh",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
JSON
  echo "已註冊：$d/$HOST_NAME.json"
done
echo "完成。接著在瀏覽器的擴充功能頁載入 $ROOT/extension（見 README.md）。"
