"""Tab Transcriber 的本機轉文字程式（Chrome/Brave native messaging host）。

插件錄到的分頁聲音切成一段段 16 kHz 單聲道 PCM 送進來，這裡用 faster-whisper 轉成附時間的英文或日文文字。
瀏覽器在插件連線時啟動這支程式，斷線就結束，所以平常不佔記憶體。

訊息格式：每則前面 4 位元組 little-endian 長度，後面接 UTF-8 JSON。
  收  {"type": "start", "language": "en" | "ja"}（連線後第一則，決定載入哪個模型）
      {"type": "audio", "id": 3, "offset": 12.5, "pcm": "<base64，int16 LE 單聲道 16 kHz>"}（講完的一句，定稿）
      {"type": "partial", "id": 4, "offset": 20.1, "pcm": "..."}（還沒講完的一句，即時字幕）
  送  {"type": "status", "state": "loading" | "ready", "model": ..., "device": ..., "language": ...}
      {"type": "segments", "id": 3, "segments": [{"start": 12.9, "end": 15.1, "text": "..."}], "elapsed": 1.2}
      {"type": "partial", "id": 4, "offset": 20.1, "text": "..."}（失敗時 text 為空字串）
      {"type": "error", "id": 3, "message": "..."}
"""

import base64
import json
import logging
import struct
import sys
import time
from pathlib import Path

SAMPLE_RATE = 16000
CONFIG_PATH = Path.home() / ".config" / "tab-transcriber" / "config.json"
LOG_PATH = Path.home() / ".cache" / "tab-transcriber" / "host.log"
LANGUAGES = ("en", "ja")
DEFAULT_CONFIG = {
    # CPU 用的模型；速度與準確度見 docs/research/2026-10-tab-transcription.md
    "models": {"en": "small.en", "ja": "small"},
    # 偵測到 CUDA 時改用；RTX 2060 上 60 秒錄音約 1.9 秒轉完，即時字幕單次 0.3–0.4 秒
    "gpu_models": {"en": "large-v3-turbo", "ja": "large-v3-turbo"},
    "device": "auto",  # auto | cpu | cuda
    "cpu_threads": 8,
    "beam_size": 5,
    "partial_beam_size": 1,  # 即時字幕求快；定稿再用 beam_size
}
PROMPT_CHARS = 200  # 把上一段結尾當提示，讓跨段的句子接得上
# 放在提示最前面，示範要有標點與大小寫：large-v3-turbo 從句子中間開始聽時，不給這段會輸出全小寫、沒有標點
# （docs/research/2026-10-tab-transcription.md）。
STYLE_PROMPTS = {
    "en": "Hello, everyone. Welcome to today's lecture. Let's get started.",
    "ja": "こんにちは。今日は、いいお天気ですね。それでは、始めましょう。",
}

# stdout 只能拿來傳訊息；函式庫印的東西一律改去 stderr，以免弄壞通訊格式。
_out = sys.stdout.buffer
_in = sys.stdin.buffer
sys.stdout = sys.stderr
log = logging.getLogger("tab-transcriber")


def read_message():
    header = _in.read(4)
    if len(header) < 4:
        return None
    (length,) = struct.unpack("<I", header)
    data = _in.read(length)
    if len(data) < length:
        return None
    return json.loads(data)


def send(msg):
    data = json.dumps(msg, ensure_ascii=False).encode("utf-8")
    _out.write(struct.pack("<I", len(data)) + data)
    _out.flush()


def load_config():
    config = dict(DEFAULT_CONFIG)
    if CONFIG_PATH.exists():
        user = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        for key in ("models", "gpu_models"):
            user[key] = {**DEFAULT_CONFIG[key], **user.get(key, {})}
        config.update(user)
    return config


def load_model(config, language):
    import numpy as np
    from faster_whisper import WhisperModel

    if config["device"] in ("auto", "cuda"):
        try:
            import ctranslate2

            if ctranslate2.get_cuda_device_count() > 0:
                name = config["gpu_models"][language]
                model = WhisperModel(name, device="cuda", compute_type="float16")
                # CUDA 函式庫缺檔時要到真的轉文字才會出錯，先試轉一秒靜音。
                list(model.transcribe(np.zeros(SAMPLE_RATE, dtype=np.float32), language=language)[0])
                return model, name, "cuda"
        except Exception:
            log.exception("CUDA unavailable, falling back to CPU")
        if config["device"] == "cuda":
            raise RuntimeError("設定要求用 GPU，但 CUDA 無法使用（詳見 host.log）")
    name = config["models"][language]
    model = WhisperModel(name, device="cpu", compute_type="int8", cpu_threads=config["cpu_threads"])
    return model, name, "cpu"


def transcribe(model, config, language, msg, prompt, beam_size=None):
    import numpy as np

    pcm = np.frombuffer(base64.b64decode(msg["pcm"]), dtype="<i2").astype(np.float32) / 32768.0
    offset = float(msg.get("offset", 0))
    segments, _info = model.transcribe(
        pcm,
        language=language,
        beam_size=beam_size or config["beam_size"],
        vad_filter=True,
        initial_prompt=f"{STYLE_PROMPTS[language]} {prompt}".strip(),
    )
    out = []
    for seg in segments:
        text = seg.text.strip()
        if text:
            out.append(
                {"start": round(offset + seg.start, 2), "end": round(offset + seg.end, 2), "text": text}
            )
    return out


def incoming(first):
    """第一則已經讀過了：不是 start 的話（舊版插件）也要當一般訊息處理。"""
    if first.get("type") != "start":
        yield first
    while (msg := read_message()) is not None:
        yield msg


def main():
    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    logging.basicConfig(
        filename=LOG_PATH, level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s"
    )
    config = load_config()
    send({"type": "status", "state": "loading"})
    first = read_message()
    if first is None:
        return 0
    language = first.get("language", "en") if first.get("type") == "start" else "en"
    if language not in LANGUAGES:
        send({"type": "error", "message": f"不支援的語言：{language}"})
        return 1
    try:
        model, name, device = load_model(config, language)
    except Exception as exc:
        log.exception("model load failed")
        send({"type": "error", "message": f"Whisper 模型載入失敗：{exc}"})
        return 1
    log.info("ready model=%s device=%s language=%s", name, device, language)
    send({"type": "status", "state": "ready", "model": name, "device": device, "language": language})

    prompt = ""
    for msg in incoming(first):
        if msg.get("type") == "partial":
            try:
                segments = transcribe(model, config, language, msg, prompt, config["partial_beam_size"])
                text = " ".join(s["text"] for s in segments)
            except Exception:
                log.exception("partial failed id=%s", msg.get("id"))
                text = ""
            send({"type": "partial", "id": msg.get("id"), "offset": msg.get("offset", 0), "text": text})
            continue
        if msg.get("type") != "audio":
            continue
        started = time.perf_counter()
        try:
            segments = transcribe(model, config, language, msg, prompt)
        except Exception as exc:
            log.exception("transcribe failed id=%s", msg.get("id"))
            send({"type": "error", "id": msg.get("id"), "message": f"轉文字失敗：{exc}"})
            continue
        elapsed = time.perf_counter() - started
        audio_s = len(msg["pcm"]) * 3 / 4 / 2 / SAMPLE_RATE
        log.info("chunk id=%s audio=%.1fs elapsed=%.2fs segments=%d",
                 msg.get("id"), audio_s, elapsed, len(segments))
        send({"type": "segments", "id": msg.get("id"), "segments": segments,
              "elapsed": round(elapsed, 2)})
        text = " ".join(s["text"] for s in segments)
        if text:
            prompt = (prompt + " " + text)[-PROMPT_CHARS:]
    log.info("browser disconnected")
    return 0


def download(gpu):
    """install.sh 用：先把會用到的模型下載好，第一次錄音才不用等。"""
    from faster_whisper.utils import download_model

    config = load_config()
    names = {config["models"][lang] for lang in LANGUAGES}
    if gpu:
        names |= {config["gpu_models"][lang] for lang in LANGUAGES}
    for name in sorted(names):
        print(f"  {name}", file=sys.stderr, flush=True)
        download_model(name)


if __name__ == "__main__":
    # 瀏覽器啟動時會帶插件來源當參數，所以只認 --download 這個明確的旗標。
    sys.exit(download("--gpu" in sys.argv[1:]) if "--download" in sys.argv[1:] else main())
