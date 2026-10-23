#!/bin/sh
# 瀏覽器透過 native messaging 啟動這支腳本；用專案 .venv 的 Python 執行 host。
DIR="$(cd "$(dirname "$0")" && pwd)"
# 有裝 gpu 選配（uv sync --extra gpu）時，讓 CTranslate2 找得到 pip 裝的 CUDA 12 cuBLAS／cuDNN 9。
for lib in "$DIR"/.venv/lib/python*/site-packages/nvidia/*/lib; do
  [ -d "$lib" ] && LD_LIBRARY_PATH="$lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
done
export LD_LIBRARY_PATH
exec "$DIR/.venv/bin/python" -u "$DIR/transcriber_host.py" "$@"
