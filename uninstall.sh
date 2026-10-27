#!/usr/bin/env bash
# 移除 install.sh 寫進瀏覽器設定的註冊檔。專案資料夾和下載的模型不動。
set -euo pipefail
HOST_NAME=com.tab_transcriber.host
for d in "$HOME/.config/BraveSoftware/Brave-Browser" "$HOME/.config/google-chrome" "$HOME/.config/chromium" \
  "$HOME/Library/Application Support/BraveSoftware/Brave-Browser" "$HOME/Library/Application Support/Google/Chrome" \
  "$HOME/Library/Application Support/Chromium" "$HOME/Library/Application Support/Microsoft Edge"; do
  f="$d/NativeMessagingHosts/$HOST_NAME.json"
  if [ -f "$f" ]; then rm -f "$f"; echo "已移除：$f"; fi
done
