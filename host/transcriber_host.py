"""Tab Transcriber 的本機轉文字程式（Chrome/Brave native messaging host）。

插件錄到的分頁聲音切成一段段 16 kHz 單聲道 PCM 送進來，這裡用 faster-whisper 轉成附時間的英文、日文或泰文文字。
打開雙語字幕時，另外啟動本機翻譯模型（Hy-MT2，跑在 llama.cpp 的 llama-server），把文字翻成繁體中文。
瀏覽器在插件連線時啟動這支程式，斷線就結束，所以平常不佔記憶體。

訊息格式：每則前面 4 位元組 little-endian 長度，後面接 UTF-8 JSON。
  收  {"type": "start", "language": "en" | "ja" | "th", "translate": false, "hints": "donk, MOUZ"}（連線後第一則，決定載入哪個模型）
      {"type": "audio", "id": 3, "offset": 12.5, "pcm": "<base64，int16 LE 單聲道 16 kHz>"}（講完的一句，定稿）
      {"type": "partial", "id": 4, "offset": 20.1, "pcm": "..."}（還沒講完的一句，即時字幕）
      {"type": "translate", "enabled": true}（錄音中打開或關掉雙語字幕）
      {"type": "hints", "text": "..."}（錄音中改了專有名詞）
      {"type": "flush"}（錄音停了：手上還沒翻的句子翻完後回 flushed）
  送  {"type": "status", "state": "loading" | "ready", "model": ..., "device": ..., "language": ...}
      {"type": "segments", "id": 3, "segments": [{"start": 12.9, "end": 15.1, "text": "..."}], "elapsed": 1.2}
      {"type": "partial", "id": 4, "offset": 20.1, "text": "..."}（失敗時 text 為空字串）
      {"type": "translator", "state": "loading" | "ready" | "off" | "error", "device": "gpu" | "cpu", "message": ...}
      {"type": "translation", "start": 12.9, "text": "..."}（一組句子的譯文；start 是這組最後一句的開始時間）
      {"type": "partial-translation", "id": 4, "text": "..."}（即時字幕的譯文）
      {"type": "flushed"}
      {"type": "error", "id": 3, "message": "..."}
"""

import base64
import json
import logging
import os
import re
import shutil
import socket
import struct
import subprocess
import sys
import threading
import time
import unicodedata
import urllib.request
from collections import deque
from pathlib import Path

SAMPLE_RATE = 16000
CONFIG_PATH = Path.home() / ".config" / "tab-transcriber" / "config.json"
CACHE_DIR = Path.home() / ".cache" / "tab-transcriber"
LOG_PATH = CACHE_DIR / "host.log"
WINDOWS = sys.platform == "win32"
# install.sh（Windows 是 install.ps1）下載
LLAMA_SERVER = Path(__file__).resolve().parent / "vendor" / "llama.cpp" / ("llama-server.exe" if WINDOWS else "llama-server")
INSTALLER = "install.ps1" if WINDOWS else "install.sh"
if WINDOWS:
    # 有裝 gpu 選配時，讓 CTranslate2 找得到 pip 裝的 CUDA 12 cuBLAS／cuDNN 9（Linux 是 run_host.sh 設 LD_LIBRARY_PATH）
    for _lib in (Path(sys.prefix) / "Lib" / "site-packages" / "nvidia").glob("*/bin"):
        os.add_dll_directory(str(_lib))
        os.environ["PATH"] = f"{_lib}{os.pathsep}{os.environ.get('PATH', '')}"
LANGUAGES = ("en", "ja", "th")
DEFAULT_CONFIG = {
    # CPU 用的模型；速度與準確度見 docs/research/2026-10-tab-transcription.md
    "models": {"en": "small.en", "ja": "small", "th": "small"},
    # 偵測到 CUDA 時改用；RTX 2060 上 60 秒錄音約 1.9 秒轉完，即時字幕單次 0.3–0.4 秒
    "gpu_models": {"en": "large-v3-turbo", "ja": "large-v3-turbo", "th": "large-v3-turbo"},
    "device": "auto",  # auto | cpu | cuda
    "cpu_threads": 8,
    "beam_size": 5,
    "partial_beam_size": 1,  # 即時字幕求快；定稿再用 beam_size
    # 雙語字幕的翻譯模型（install.sh 下載）；Q8_0 比 Q4_K_M 準，顯示記憶體約 1.9 GB
    "translate_model": str(CACHE_DIR / "models" / "Hy-MT2-1.8B-Q8_0.gguf"),
    "translate_gpu_layers": 99,  # 全部放顯示卡；載入失敗會改用 CPU
    "translate_context": 1024,  # 一次只翻一兩句，不需要長 context
}
PROMPT_CHARS = 200  # 把上一段結尾當提示，讓跨段的句子接得上
PROMPT_TOKENS = 222  # faster-whisper 的提示只留最後 223 個 token（前面多的砍掉）；留一個給它加在最前面的空白
# 側邊欄填的專有名詞（人名、隊名、武器名…）放在提示最前面，最多佔這麼多 token（約 30 個英文名字）。
# Twitch PGL 英文轉播 4 分鐘：加了兩隊的選手、隊名、武器名，turbo 轉對的名字從 3 處變 15 處，large-v3 從 4 處變 24 處（研究筆記第 13 節）。
HINT_TOKENS = 120
# Whisper 碰到配樂、歌聲這類幾乎沒人講話的段落，會卡在重複同一句（例如「ご視聴ありがとうございました」）直到產生上限，
# 再換溫度重試五次，一段要轉 10 秒，即時字幕也跟著停住。所以依講話長度限制最多產生幾個 token：
# 實測每秒講話泰文約 11 個、日文約 5 個、英文約 4 個，給到 25 個再加 20 個餘裕（docs/research/2026-10-tab-transcription.md 第 10 節）。
# 算出來超過 CAP_LIMIT 就照原本的上限（448 減掉提示長度）；提示最長 227 個 token 時還剩 221 個，所以 200 以內一定放得下。
TOKENS_PER_SPEECH_S = 25
TOKENS_BASE = 20
CAP_LIMIT = 200
FINAL_TEMPERATURES = (0.0, 0.2, 0.4, 0.6, 0.8, 1.0)  # faster-whisper 的預設
# 即時字幕少試幾個溫度：預設六個，每個都要再解碼五個候選，卡住時會拖慢每秒一次的更新；完全不重試的話泰文會卡在重複
PARTIAL_TEMPERATURES = (0.0, 0.4, 0.8)
PROMPT_RESET_TEMPERATURE = 0.5  # 要重試到這個溫度以上才轉得出來的結果不可靠，不拿來當下一段的提示（同 faster-whisper 段內的規則）
# faster-whisper 判定「這次解碼失敗、換下一個溫度」的門檻（它的預設值）
COMPRESSION_RATIO_LIMIT = 2.4
LOG_PROB_LIMIT = -1.0
# 連續的狀聲詞、附和（「うん。 うん。 …」「ううう…」「ha ha ha」）Whisper 會照實寫成一長串重複，壓縮比因此超過 2.4，
# 被當成卡住而換溫度重試；但聲音本來就在重複，每個溫度都一樣，一段要轉 10–16 秒（docs/research/2026-10-tab-transcription.md 第 11 節）。
# 所以先只用溫度 0 轉一次：沒失敗就照用；失敗了但大部分是很短的單位（只算字母，不超過 4 個字）連續重複 8 次以上，就當成狀聲詞直接用；
# 其他失敗才照原本的溫度重轉，配樂的幻覺句、泰文卡在重複都靠這個。
VOCAL_UNIT = 4
VOCAL_REPS = 8
VOCAL_SHARE = 0.5
# 同一個單位（最長 20 個字）連續出現 4 次以上就只留 3 次，後面接「…」，字幕和文字稿才不會被一長串重複塞滿
REPEAT_UNIT = 20
REPEAT_MIN = 4
REPEAT_KEEP = 3
# 放在提示最前面，示範要有標點與大小寫：large-v3-turbo 從句子中間開始聽時，不給這段會輸出全小寫、沒有標點
# （docs/research/2026-10-tab-transcription.md）。
# 泰文幾乎不用標點，加示範句也沒有變準（FLEURS 字元錯誤率 12.3% → 12.9%），所以不加。
STYLE_PROMPTS = {
    "en": "Hello, everyone. Welcome to today's lecture. Let's get started.",
    "ja": "こんにちは。今日は、いいお天気ですね。それでは、始めましょう。",
}
# Hy-MT2 模型卡的翻譯提示（中文提示配中文語言名）
TRANSLATE_PROMPT = "将以下文本翻译为繁体中文，注意只需要输出翻译后的结果，不要额外解释：\n\n{text}"
# 半句話翻出來常常不通順，所以定稿先湊到句尾標點再翻。泰文句子之間只空格、不用句號，Whisper 的每一段就當一句。
SENTENCE_END = {"en": re.compile(r"[.?!…][\"')\]]*$"), "ja": re.compile(r"[。？！?!」』）…]$")}
JOINERS = {"ja": ""}
MAX_UNIT_SEGMENTS = 3  # 最多湊三段就翻，免得一直等不到句號
HOLD_S = 6.0  # 等不到下一段定稿就先翻手上的半句

# stdout 只能拿來傳訊息；函式庫印的東西一律改去 stderr，以免弄壞通訊格式。
if sys.stderr is None:  # 瀏覽器啟動時可能沒給 stderr
    sys.stderr = open(os.devnull, "w")
_out = sys.stdout.buffer
_in = sys.stdin.buffer
_send_lock = threading.Lock()  # 翻譯執行緒也會送訊息
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
    with _send_lock:
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


def clip_hints(model, text):
    """側邊欄填的專有名詞：空白壓成一個，太長的話只留前面 HINT_TOKENS 個 token。"""
    text = " ".join(str(text or "").split())
    ids = model.hf_tokenizer.encode(text, add_special_tokens=False).ids
    return model.hf_tokenizer.decode(ids[:HINT_TOKENS]) if len(ids) > HINT_TOKENS else text


def build_prompt(model, language, prompt, hints):
    style = STYLE_PROMPTS.get(language, "")
    if not hints:
        return f"{style} {prompt}".strip() or None
    # 提示太長時會從前面砍，專有名詞就不見了；所以改成縮短後面接的上一段結尾。
    head = f"{hints} {style}".strip()
    budget = PROMPT_TOKENS - len(model.hf_tokenizer.encode(f" {head} ", add_special_tokens=False).ids)
    ids = model.hf_tokenizer.encode(prompt, add_special_tokens=False).ids
    tail = model.hf_tokenizer.decode(ids[-budget:]) if budget > 0 and ids else ""
    return f"{head} {tail}".strip()


def transcribe(model, config, language, msg, prompt, partial=False, hints=""):
    """回傳 (段落, 講話秒數, 最高重試溫度, 是否當成狀聲詞沒有重試)。"""
    import numpy as np
    from faster_whisper.vad import get_speech_timestamps

    pcm = np.frombuffer(base64.b64decode(msg["pcm"]), dtype="<i2").astype(np.float32) / 32768.0
    offset = float(msg.get("offset", 0))
    # 先量出有多少講話（和 transcribe 裡的 VAD 同一套設定）：沒有就不用轉，有的話依長度定產生上限。
    speech_s = sum(s["end"] - s["start"] for s in get_speech_timestamps(pcm)) / SAMPLE_RATE
    if not speech_s:
        return [], 0.0, 0.0, False
    cap = TOKENS_BASE + TOKENS_PER_SPEECH_S * speech_s
    options = dict(
        language=language,
        beam_size=config["partial_beam_size"] if partial else config["beam_size"],
        max_new_tokens=int(cap) if cap < CAP_LIMIT else None,
        vad_filter=True,
        initial_prompt=build_prompt(model, language, prompt, hints),
    )
    temperatures = PARTIAL_TEMPERATURES if partial else FINAL_TEMPERATURES
    segments = list(model.transcribe(pcm, temperature=temperatures[0], **options)[0])
    # 什麼都沒轉出來時看不到這次解碼算不算失敗（例如很早就結束、平均機率太低，原本會換溫度重試），所以也重轉
    failed = not segments or any(
        s.compression_ratio > COMPRESSION_RATIO_LIMIT or s.avg_logprob < LOG_PROB_LIMIT for s in segments
    )
    vocal = failed and bool(segments) and is_vocalization(" ".join(s.text for s in segments))
    if failed and not vocal:
        # 照原本的溫度從頭轉：一段錄音可能分成幾次解碼，沒失敗的那幾次這樣才會和以前一樣停在溫度 0
        segments = list(model.transcribe(pcm, temperature=temperatures, **options)[0])
    temperature = max((s.temperature for s in segments), default=0.0)
    # 一模一樣的句子接連出現（例如六個「うん。」）併成一行
    parts = []
    for seg in segments:
        text = seg.text.strip()
        if parts and text == parts[-1][2][-1]:
            parts[-1][1] = seg.end
            parts[-1][2].append(text)
        elif text:
            parts.append([seg.start, seg.end, [text]])
    out = [
        {"start": round(offset + start, 2), "end": round(offset + end, 2), "text": collapse_repeats(" ".join(texts))}
        for start, end, texts in parts
    ]
    return out, speech_s, temperature, vocal


def find_repeats(text, max_unit, min_reps, keep=lambda unit: True, tail=False):
    """找出 text 裡連續重複的片段，回傳 [(開始, 結束, 單位長度)]；不分大小寫，每個位置取最短的單位。

    tail：最後一次常少了結尾（「うん。 」最後一個沒有空白、「ーオ」最後只剩「ー」），後面接著的不是字母或數字的話一起算進去。
    """
    text = "".join(c.lower() if len(c.lower()) == 1 else c for c in text)  # 「No, no, no」從第一個就對齊
    runs, i, n = [], 0, len(text)
    while i < n:
        for size in range(1, min(max_unit, (n - i) // min_reps) + 1):
            unit = text[i:i + size]
            j = i + size
            while text.startswith(unit, j):
                j += size
            if (j - i) // size < min_reps or not keep(unit):
                continue
            if tail:
                j += next((k for k in range(size - 1, 0, -1)
                           if text.startswith(unit[:k], j) and not is_letter(text[j + k:j + k + 1])), 0)
            runs.append((i, j, size))
            i = j
            break
        else:
            i += 1
    return runs


def is_letter(ch):
    # 泰文的母音、聲調符號是組合字元（M 類），也要算字母，才不會把一個字拆開
    return bool(ch) and unicodedata.category(ch)[0] in "LMN"


def collapse_repeats(text):
    """同一個單位連續重複太多次時縮短，例如「うん。 」七十次 → 「うん。 うん。 うん。…」。只有數字或標點的不縮，以免 1000000 變短。"""
    out, pos = [], 0
    for start, end, size in find_repeats(text, REPEAT_UNIT, REPEAT_MIN, lambda u: any(c.isalpha() for c in u), tail=True):
        out.append(text[pos:start])
        out.append(text[start:start + size * REPEAT_KEEP].rstrip() + "…")
        # 單位結尾的空白跟著被收掉了，後面還有字就補回一個（最後一次只剩半個時，後面本來就是標點或空白）
        if (end - start) % size == 0 and text[end - 1].isspace() and end < len(text) and not text[end].isspace():
            out.append(" ")
        pos = end
    out.append(text[pos:])
    return "".join(out)


def is_vocalization(text):
    """大部分是很短的聲音一直重複（狀聲詞、附和、笑聲），而不是卡在重複同一句話。只看字母，不管標點和空白怎麼夾。"""
    letters = "".join(c for c in text if c.isalpha())
    covered = sum(end - start for start, end, _ in find_repeats(letters, VOCAL_UNIT, VOCAL_REPS))
    return bool(letters) and covered >= VOCAL_SHARE * len(letters)


class Translator:
    """雙語字幕：在另一條執行緒用 llama-server 翻成繁體中文，轉文字不用等翻譯。

    定稿優先，即時字幕只留最新一則。只在打開雙語字幕時才啟動 llama-server，關掉就結束它，把顯示記憶體還回去。
    """

    def __init__(self, config, language, partials):
        self.config = config
        self.language = language
        self.partials = partials  # 即時字幕也翻；只有顯示卡模式才開，CPU 一句要 3 秒，跟不上每秒一次
        self.cv = threading.Condition()
        self.enabled = False
        self.closed = False
        self.generation = 0  # 每次關掉就加一，關掉前排隊或翻到一半的結果都丟掉
        self.finals = deque()  # ("unit", 最後一段的 start, 原文) 或 ("flush",)
        self.held = []  # 還沒等到句尾的定稿 [(start, text)]
        self.held_at = 0.0
        self.partial = None  # (id, text)
        self.proc = None
        self.port = None
        self.proc_lock = threading.Lock()
        threading.Thread(target=self._run, daemon=True).start()

    # ---- 主執行緒呼叫 ----

    def set_enabled(self, on):
        with self.cv:
            if on == self.enabled:
                return
            self.enabled = on
            log.info("translator %s", "on" if on else "off")
            if not on:
                self.generation += 1
                self.finals.clear()
                self.held.clear()
                self.partial = None
            self.cv.notify()
        if not on:
            # 直接收掉，不等翻到一半的那句；翻譯執行緒的請求會失敗，結果本來就要丟掉。
            self._stop_server()
            send({"type": "translator", "state": "off"})

    def add_segments(self, segments):
        with self.cv:
            if not self.enabled:
                return
            for seg in segments:
                self.held.append((seg["start"], seg["text"]))
                pattern = SENTENCE_END.get(self.language)
                if pattern is None or pattern.search(seg["text"]) or len(self.held) >= MAX_UNIT_SEGMENTS:
                    self._release()
            self.held_at = time.monotonic()
            self.cv.notify()

    def add_partial(self, msg_id, text):
        if not text or not self.partials:
            return
        with self.cv:
            if self.enabled:
                self.partial = (msg_id, text)
                self.cv.notify()

    def flush(self):
        with self.cv:
            if self.enabled:
                self._release()
                self.finals.append(("flush",))
                self.cv.notify()
                return
        send({"type": "flushed"})

    def close(self):
        with self.cv:
            self.closed = True
            self.cv.notify()
        self._stop_server()

    # ---- 翻譯執行緒 ----

    def _release(self):
        if self.held:
            text = JOINERS.get(self.language, " ").join(t for _, t in self.held)
            self.finals.append(("unit", self.held[-1][0], text))
            self.held = []

    def _next_job(self):
        if self.closed:
            return ("exit",)
        if not self.enabled:
            return ("stop",) if self.proc else None
        if self.proc is None:
            return ("start",)
        if self.held and time.monotonic() - self.held_at >= HOLD_S:
            self._release()
        if self.finals:
            return self.finals.popleft()
        if self.partial:
            job, self.partial = ("partial", *self.partial), None
            return job
        return None

    def _run(self):
        while True:
            with self.cv:
                while (job := self._next_job()) is None:
                    self.cv.wait(timeout=0.5)
                generation = self.generation
            if job[0] == "exit":
                self._stop_server()
                return
            try:
                self._do(job, generation)
            except Exception:
                # 這條執行緒死掉的話，側邊欄會一直顯示翻譯就緒卻等不到譯文，所以收掉 server、明說翻譯停了。
                log.exception("translator job failed: %s", job[0])
                self._stop_server()
                self._give_up(f"翻譯程式出錯而停止，詳細原因在 {LOG_PATH}。")

    def _do(self, job, generation):
        kind = job[0]
        if kind == "stop":
            self._stop_server()  # 關掉時剛好載入完成的 server
        elif kind == "start":
            self._start_server(generation)
        elif kind == "flush":
            send({"type": "flushed"})
        else:
            text = self._translate(job[-1])
            with self.cv:
                if generation != self.generation or text is None:
                    return
            if kind == "unit":
                send({"type": "translation", "start": job[1], "text": text})
            else:
                send({"type": "partial-translation", "id": job[1], "text": text})

    def _give_up(self, message):
        """翻譯用不了：關掉雙語字幕，告訴側邊欄原因。之後要再打開開關才會重試。"""
        with self.cv:
            self.enabled = False
            self.generation += 1
            self.finals.clear()
            self.held.clear()
            self.partial = None
        send({"type": "translator", "state": "error", "message": message})
        send({"type": "flushed"})  # 正在等收尾的話不用再等翻譯

    def _start_server(self, generation):
        model = Path(self.config["translate_model"]).expanduser()
        if not LLAMA_SERVER.exists() or not model.exists():
            missing = LLAMA_SERVER if not LLAMA_SERVER.exists() else model
            log.error("translator missing: %s", missing)
            self._give_up(f"翻譯模型還沒安裝，請在終端機執行一次 tab-transcriber/{INSTALLER}。")
            return
        send({"type": "translator", "state": "loading"})
        gpu_layers = int(self.config["translate_gpu_layers"])
        for layers in dict.fromkeys((gpu_layers, 0)):
            started = time.perf_counter()
            proc, port = self._spawn(model, layers)
            if self._wait_ready(proc, port, generation):
                with self.proc_lock:
                    self.proc, self.port = proc, port
                device = "gpu" if layers else "cpu"
                if not layers:
                    self.partials = False
                log.info("translator ready device=%s load=%.1fs", device, time.perf_counter() - started)
                send({"type": "translator", "state": "ready", "device": device})
                return
            self._terminate(proc)
            with self.cv:
                if generation != self.generation or self.closed:
                    return  # 載入途中被關掉了
            log.error("llama-server failed to start with -ngl %s (see llama-server.log)", layers)
        self._give_up(f"翻譯模型啟動失敗，詳細原因在 {CACHE_DIR / 'llama-server.log'}。")

    def _spawn(self, model, layers):
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            port = s.getsockname()[1]
        cmd = [str(LLAMA_SERVER), "-m", str(model), "-ngl", str(layers), "-c", str(self.config["translate_context"]),
               "-np", "1", "--host", "127.0.0.1", "--port", str(port), "--no-webui"]
        # 本機程式被強制結束時，setpriv 設的 pdeathsig 會讓 llama-server 跟著結束，不會留在背景佔顯示記憶體。
        if shutil.which("setpriv"):
            cmd = ["setpriv", "--pdeathsig", "TERM", "--", *cmd]
        logfile = open(CACHE_DIR / "llama-server.log", "wb")
        try:
            # Windows：瀏覽器啟動的本機程式沒有主控台，不加 CREATE_NO_WINDOW 的話 llama-server 會自己開一個黑色視窗
            proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=logfile, stderr=subprocess.STDOUT,
                                    creationflags=subprocess.CREATE_NO_WINDOW if WINDOWS else 0)
        finally:
            logfile.close()
        if WINDOWS:
            kill_with_host(proc)
        return proc, port

    def _wait_ready(self, proc, port, generation):
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            if proc.poll() is not None:
                return False
            with self.cv:
                if generation != self.generation or self.closed:
                    return False
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=1) as r:
                    if r.status == 200:
                        return True
            except Exception:
                time.sleep(0.2)
        return False

    def _translate(self, text):
        payload = {
            "messages": [{"role": "user", "content": TRANSLATE_PROMPT.format(text=text)}],
            # 每次選機率最高的字：同一句不會這次翻這樣、下次翻那樣，即時字幕比較不會跳
            "temperature": 0,
            "repeat_penalty": 1.05,
            "max_tokens": 512,
        }
        req = urllib.request.Request(
            f"http://127.0.0.1:{self.port}/v1/chat/completions",
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.load(r)["choices"][0]["message"]["content"].strip()
        except Exception:
            proc = self.proc
            if proc is None:
                return None  # 關掉雙語字幕或停止錄音時收掉了 server，翻到一半的這句本來就要丟掉
            log.exception("translate failed")
            if proc.poll() is not None:
                self._stop_server()
                self._give_up(f"翻譯模型意外結束，詳細原因在 {CACHE_DIR / 'llama-server.log'}。")
            return None

    def _stop_server(self):
        with self.proc_lock:
            proc, self.proc = self.proc, None
        if proc:
            self._terminate(proc)
            log.info("translator stopped")

    @staticmethod
    def _terminate(proc):
        # llama-server 收到 SIGTERM 會先把正在翻的那句翻完（實測要好幾秒），等一秒不走就直接收掉。
        proc.terminate()
        try:
            proc.wait(timeout=1)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()


_job = None


def kill_with_host(proc):
    """Windows：把 llama-server 放進設了 KILL_ON_JOB_CLOSE 的 job。本機程式被強制結束、job handle 關掉時，
    系統會一起收掉它，不會留在背景佔顯示記憶體（Linux 是 setpriv 的 pdeathsig）。"""
    global _job
    import ctypes
    from ctypes import wintypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateJobObjectW.restype = wintypes.HANDLE
    kernel32.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    kernel32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    if _job is None:
        class BasicLimit(ctypes.Structure):  # JOBOBJECT_BASIC_LIMIT_INFORMATION
            _fields_ = [("per_process_time", ctypes.c_longlong), ("per_job_time", ctypes.c_longlong),
                        ("flags", wintypes.DWORD), ("min_working_set", ctypes.c_size_t),
                        ("max_working_set", ctypes.c_size_t), ("active_processes", wintypes.DWORD),
                        ("affinity", ctypes.c_size_t), ("priority_class", wintypes.DWORD),
                        ("scheduling_class", wintypes.DWORD)]

        class ExtendedLimit(ctypes.Structure):  # JOBOBJECT_EXTENDED_LIMIT_INFORMATION
            _fields_ = [("basic", BasicLimit), ("io", ctypes.c_ulonglong * 6), ("process_memory", ctypes.c_size_t),
                        ("job_memory", ctypes.c_size_t), ("peak_process_memory", ctypes.c_size_t),
                        ("peak_job_memory", ctypes.c_size_t)]

        job = kernel32.CreateJobObjectW(None, None)
        info = ExtendedLimit()
        info.basic.flags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        # 9 = JobObjectExtendedLimitInformation
        if not job or not kernel32.SetInformationJobObject(job, 9, ctypes.byref(info), ctypes.sizeof(info)):
            log.warning("job object setup failed: %s", ctypes.get_last_error())
            return
        _job = job
    if not kernel32.AssignProcessToJobObject(_job, proc._handle):
        log.warning("AssignProcessToJobObject failed: %s", ctypes.get_last_error())


def incoming(first):
    """第一則已經讀過了：不是 start 的話（舊版插件）也要當一般訊息處理。"""
    if first.get("type") != "start":
        yield first
    while (msg := read_message()) is not None:
        yield msg


def main():
    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    logging.basicConfig(
        filename=LOG_PATH, encoding="utf-8", level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s"
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

    # Whisper 先載入完才啟動翻譯模型：CUDA 載入失敗沒有退路，翻譯模型放不進顯示卡還可以改用 CPU。
    translator = Translator(config, language, partials=device == "cuda")
    if first.get("translate"):
        translator.set_enabled(True)
    try:
        run(model, config, language, translator, first)
    finally:
        translator.close()
    log.info("browser disconnected")
    return 0


def run(model, config, language, translator, first):
    prompt = ""
    hints = clip_hints(model, first.get("hints")) if first.get("type") == "start" else ""
    log.info("hints chars=%d", len(hints))  # 只記長度，不記內容
    for msg in incoming(first):
        kind = msg.get("type")
        if kind == "hints":  # 錄音中改了側邊欄的專有名詞
            hints = clip_hints(model, msg.get("text"))
            log.info("hints chars=%d", len(hints))
            continue
        if kind == "translate":
            translator.set_enabled(bool(msg.get("enabled")))
            continue
        if kind == "flush":
            translator.flush()
            continue
        if kind == "partial":
            try:
                segments, _, _, _ = transcribe(model, config, language, msg, prompt, partial=True, hints=hints)
                text = collapse_repeats(" ".join(s["text"] for s in segments))
            except Exception:
                log.exception("partial failed id=%s", msg.get("id"))
                text = ""
            send({"type": "partial", "id": msg.get("id"), "offset": msg.get("offset", 0), "text": text})
            translator.add_partial(msg.get("id"), text)
            continue
        if kind != "audio":
            continue
        started = time.perf_counter()
        try:
            segments, speech_s, temperature, vocal = transcribe(model, config, language, msg, prompt, hints=hints)
        except Exception as exc:
            log.exception("transcribe failed id=%s", msg.get("id"))
            send({"type": "error", "id": msg.get("id"), "message": f"轉文字失敗：{exc}"})
            continue
        elapsed = time.perf_counter() - started
        audio_s = len(msg["pcm"]) * 3 / 4 / 2 / SAMPLE_RATE
        log.info("chunk id=%s audio=%.1fs speech=%.1fs elapsed=%.2fs segments=%d temperature=%.1f%s",
                 msg.get("id"), audio_s, speech_s, elapsed, len(segments), temperature, " vocal" if vocal else "")
        send({"type": "segments", "id": msg.get("id"), "segments": segments,
              "elapsed": round(elapsed, 2)})
        translator.add_segments(segments)
        text = " ".join(s["text"] for s in segments)
        # 重試到高溫才有的結果常是幻覺；拿來當提示的話，下一段會跟著重複同一句。狀聲詞也一樣，會讓下一段跟著「うん。」
        if text and temperature <= PROMPT_RESET_TEMPERATURE and not vocal:
            prompt = (prompt + " " + text)[-PROMPT_CHARS:]


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
