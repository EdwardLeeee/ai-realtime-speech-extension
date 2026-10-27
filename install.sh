#!/usr/bin/env bash
# 安裝本機轉文字程式（Linux、macOS）：建 Python 環境、先下載 Whisper 模型與雙語字幕用的翻譯模型、向 Brave／Chrome 註冊 native messaging host。
# Windows 用 install.ps1（或 Setup.exe）。
# 用法：./install.sh                   註冊到這台電腦上有裝的 Brave、Chrome、Chromium（macOS 另外加 Edge）
#       ./install.sh <資料夾>           只把註冊檔寫進指定資料夾（測試用的瀏覽器設定檔）
#       ./install.sh --no-translate     不下載翻譯模型（約 2 GB）；之後打開雙語字幕會提示再執行一次 install.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
HOST_NAME=com.tab_transcriber.host
EXT_ID=pclblnfmncjbohcnbhlkgefpdhpljiae # 由 extension/manifest.json 的 key 決定

# 雙語字幕：llama.cpp 的 Vulkan 版（有顯示卡用顯示卡，沒有就用 CPU）＋騰訊 Hy-MT2-1.8B 翻譯模型。
# 版本和 SHA-256 寫死，換版時要一起更新（SHA-256 取自 GitHub release 與 Hugging Face 頁面）。
# macOS 用 Metal 版（只支援 Apple Silicon：faster-whisper 用到的 onnxruntime 只有 macOS 14 arm64 的安裝檔）。
LLAMA_TAG=b11840
case "$(uname -s)" in
  Darwin)
    [ "$(uname -m)" = arm64 ] || { echo "macOS 只支援 Apple Silicon（M1 以後）" >&2; exit 1; }
    LLAMA_BUILD=macos-arm64 LLAMA_SHA256=f24acd73f63f6c54b02dcee483c6d30d71b7b732e216c9215a932268e5c7d6f4
    BROWSER_DIRS=("$HOME/Library/Application Support/BraveSoftware/Brave-Browser" "$HOME/Library/Application Support/Google/Chrome"
      "$HOME/Library/Application Support/Chromium" "$HOME/Library/Application Support/Microsoft Edge")
    ;;
  *)
    LLAMA_BUILD=ubuntu-vulkan-x64 LLAMA_SHA256=f4dcde3cc4298a380865c3df07c70734f1025800d9a1916bb0143129f3858905
    BROWSER_DIRS=("$HOME/.config/BraveSoftware/Brave-Browser" "$HOME/.config/google-chrome" "$HOME/.config/chromium")
    ;;
esac
LLAMA_URL="https://github.com/ggml-org/llama.cpp/releases/download/$LLAMA_TAG/llama-$LLAMA_TAG-bin-$LLAMA_BUILD.tar.gz"
LLAMA_DIR="$ROOT/host/vendor/llama.cpp"
MT_URL=https://huggingface.co/tencent/Hy-MT2-1.8B-GGUF/resolve/main/Hy-MT2-1.8B-Q8_0.gguf
MT_SHA256=5c3fe0b1408a5ceb0143184ef247b11b579c525f4b02b060e6c851bb76fef1a4
MT_PATH="$HOME/.cache/tab-transcriber/models/Hy-MT2-1.8B-Q8_0.gguf"

TRANSLATE=1
dirs=()
for arg in "$@"; do
  case "$arg" in
    --no-translate) TRANSLATE=0 ;;
    *) dirs+=("$arg") ;;
  esac
done

command -v uv >/dev/null || { echo "需要先安裝 uv：https://docs.astral.sh/uv/" >&2; exit 1; }

# macOS 沒有 sha256sum，用 shasum
sha_ok() {
  if command -v sha256sum >/dev/null; then echo "$1  $2" | sha256sum -c --status; else echo "$1  $2" | shasum -a 256 -c --status; fi
}

# 下載到 .part，核對 SHA-256 才改成正式檔名；已經有而且核對正確就跳過。
fetch() {
  local url=$1 dest=$2 sha=$3
  if [ -f "$dest" ] && sha_ok "$sha" "$dest"; then return 0; fi
  mkdir -p "$(dirname "$dest")"
  curl -fL --retry 3 -C - -# -o "$dest.part" "$url"
  if ! sha_ok "$sha" "$dest.part"; then
    rm -f "$dest.part"
    echo "下載的檔案核對不符，請再執行一次：$url" >&2
    exit 1
  fi
  mv "$dest.part" "$dest"
}

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

if [ "$TRANSLATE" = 1 ]; then
  echo "準備雙語字幕的翻譯模型（第一次要下載約 2 GB）…"
  if [ "$(cat "$LLAMA_DIR/VERSION" 2>/dev/null)" != "$LLAMA_TAG-$LLAMA_BUILD" ]; then
    tmp="$(mktemp -d)"
    fetch "$LLAMA_URL" "$tmp/llama.tar.gz" "$LLAMA_SHA256"
    rm -rf "$LLAMA_DIR.new"
    mkdir -p "$LLAMA_DIR.new"
    tar -xzf "$tmp/llama.tar.gz" -C "$LLAMA_DIR.new" --strip-components=1
    echo "$LLAMA_TAG-$LLAMA_BUILD" > "$LLAMA_DIR.new/VERSION"
    rm -rf "$LLAMA_DIR" "$tmp"
    mv "$LLAMA_DIR.new" "$LLAMA_DIR"
  fi
  fetch "$MT_URL" "$MT_PATH" "$MT_SHA256"
fi

if [ ${#dirs[@]} -eq 0 ]; then
  for d in "${BROWSER_DIRS[@]}"; do
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
