"""照瀏覽器的方式找到註冊檔、啟動本機程式、用 native messaging 格式交換訊息（不需要瀏覽器）。

Linux、macOS、Windows 都能跑，用來確認 install.sh／install.ps1 裝好的東西真的能用：
  1. 從註冊位置（Linux 的 NativeMessagingHosts 資料夾、Windows 的登錄檔）讀到註冊檔，啟動裡面寫的程式。
  2. 送 start，等模型載入；送一段英文錄音，要回轉好的英文。
  3. 打開雙語字幕，要回翻譯模型 ready 和中文譯文；送 flush 要回 flushed。
  4. 關掉 stdin（等於瀏覽器斷線），本機程式和翻譯模型都要結束。
  5. Windows：本機程式被強制結束時，放進 job 的子程序要跟著結束。

用法：host/.venv/bin/python tests/test_native_host.py [--no-translate]（Windows：host\\.venv\\Scripts\\python.exe）
"""

import base64
import json
import os
import queue
import struct
import subprocess
import sys
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HOST_NAME = "com.tab_transcriber.host"
ORIGIN = "chrome-extension://pclblnfmncjbohcnbhlkgefpdhpljiae/"
AUDIO = ROOT / "docs" / "research" / "tab-transcription" / "corpus" / "alice-one-syllable-ch02.mp3"
WINDOWS = sys.platform == "win32"
failed = []


def check(ok, label):
    print(f"{'PASS' if ok else 'FAIL'} {label}", flush=True)
    if not ok:
        failed.append(label)


def manifest_path():
    if WINDOWS:
        import winreg

        for browser in (r"BraveSoftware\Brave-Browser", r"Google\Chrome", "Chromium", r"Microsoft\Edge"):
            try:
                with winreg.OpenKey(winreg.HKEY_CURRENT_USER, rf"Software\{browser}\NativeMessagingHosts\{HOST_NAME}") as key:
                    return Path(winreg.QueryValue(key, None))
            except OSError:
                continue
        return None
    for d in (".config/BraveSoftware/Brave-Browser", ".config/google-chrome", ".config/chromium",
              "Library/Application Support/BraveSoftware/Brave-Browser", "Library/Application Support/Google/Chrome",
              "Library/Application Support/Chromium", "Library/Application Support/Microsoft Edge"):
        p = Path.home() / d / "NativeMessagingHosts" / f"{HOST_NAME}.json"
        if p.exists():
            return p
    return None


def processes(name):
    """名稱（或命令列）含 name 的程序 PID。"""
    if WINDOWS:
        out = subprocess.run(["tasklist", "/FO", "CSV", "/NH"], capture_output=True, text=True).stdout
        return [int(line.split('","')[1]) for line in out.splitlines() if line.lower().startswith(f'"{name.lower()}')]
    if not os.path.isdir("/proc"):  # macOS
        out = subprocess.run(["ps", "-axo", "pid=,command="], capture_output=True, text=True).stdout
        return [int(line.split(None, 1)[0]) for line in out.splitlines() if name in line]
    pids = []
    for d in os.listdir("/proc"):
        if d.isdigit():
            try:
                if name in Path(f"/proc/{d}/cmdline").read_bytes().replace(b"\0", b" ").decode(errors="replace"):
                    pids.append(int(d))
            except OSError:
                pass
    return pids


class Host:
    def __init__(self, path):
        # 瀏覽器在 Windows 經過 cmd.exe 啟動 .bat；Python 的 subprocess 直接給 .bat 也一樣交給 cmd.exe
        self.proc = subprocess.Popen([str(path), ORIGIN], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
        self.messages = queue.Queue()
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        out = self.proc.stdout
        while True:
            header = out.read(4)
            if len(header) < 4:
                self.messages.put(None)
                return
            (length,) = struct.unpack("<I", header)
            self.messages.put(json.loads(out.read(length)))

    def send(self, msg):
        data = json.dumps(msg).encode()
        self.proc.stdin.write(struct.pack("<I", len(data)) + data)
        self.proc.stdin.flush()

    def wait_for(self, pred, timeout):
        """等到符合 pred 的訊息；途中收到的其他訊息印出來。"""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                msg = self.messages.get(timeout=max(0.1, deadline - time.monotonic()))
            except queue.Empty:
                break
            if msg is None:
                print("  本機程式斷線了", flush=True)
                return None
            if pred(msg):
                return msg
            print("  收到", json.dumps(msg, ensure_ascii=False)[:160], flush=True)
        return None


def pcm(start, seconds):
    from faster_whisper import decode_audio

    audio = decode_audio(str(AUDIO), sampling_rate=16000)[int(start * 16000):int((start + seconds) * 16000)]
    return base64.b64encode((audio * 32767).astype("<i2").tobytes()).decode()


def main():
    sys.stdout.reconfigure(encoding="utf-8")  # Windows 的管線預設是系統字碼頁，印中文會出錯
    translate = "--no-translate" not in sys.argv[1:]
    server = "llama-server.exe" if WINDOWS else "vendor/llama.cpp/llama-server"
    preexisting = set(processes(server))  # 使用者自己正在錄音時的翻譯模型不算
    path = manifest_path()
    check(path is not None and path.exists(), f"找到註冊檔：{path}")
    if not path:
        return
    manifest = json.loads(path.read_text(encoding="utf-8"))
    check(manifest.get("allowed_origins") == [ORIGIN], "註冊檔只允許插件的 ID")
    program = Path(manifest["path"])
    check(program.exists(), f"註冊檔指向的程式存在：{program}")

    host = Host(program)
    host.send({"type": "start", "language": "en", "translate": False})
    ready = host.wait_for(lambda m: m.get("type") == "status" and m.get("state") == "ready", 600)
    check(ready is not None, f"模型載入完成：{ready}")

    host.send({"type": "audio", "id": 1, "offset": 0, "pcm": pcm(62, 9)})
    seg = host.wait_for(lambda m: m.get("type") in ("segments", "error"), 300)
    text = " ".join(s["text"] for s in (seg or {}).get("segments", []))
    print("  轉出：", text, flush=True)
    check(seg is not None and seg["type"] == "segments" and sum(c.isalpha() for c in text) > 20, "英文錄音轉成英文")

    if translate:
        host.send({"type": "translate", "enabled": True})
        tr = host.wait_for(lambda m: m.get("type") == "translator" and m.get("state") in ("ready", "error"), 300)
        check(tr is not None and tr["state"] == "ready", f"翻譯模型啟動：{tr}")
        host.send({"type": "audio", "id": 2, "offset": 9, "pcm": pcm(71, 9)})
        got = host.wait_for(lambda m: m.get("type") == "translation", 300)
        print("  譯文：", (got or {}).get("text"), flush=True)
        check(got is not None and any("一" <= c <= "鿿" for c in got["text"]), "譯文是中文")
        host.send({"type": "flush"})
        check(host.wait_for(lambda m: m.get("type") == "flushed", 120) is not None, "flush 之後回 flushed")

    host.proc.stdin.close()  # 瀏覽器斷線
    try:
        host.proc.wait(timeout=30)
        exited = True
    except subprocess.TimeoutExpired:
        host.proc.kill()
        exited = False
    check(exited, "瀏覽器斷線後本機程式結束")
    time.sleep(2)
    check(not set(processes(server)) - preexisting, "翻譯模型也已結束")

    if WINDOWS:
        # 用本機程式的 kill_with_host 把一個子程序放進 job，再強制結束父程序：子程序要跟著結束
        script = (
            "import importlib.util, subprocess, sys, time\n"
            f"spec = importlib.util.spec_from_file_location('host', r'{ROOT / 'host' / 'transcriber_host.py'}')\n"
            "host = importlib.util.module_from_spec(spec); spec.loader.exec_module(host)\n"
            "child = subprocess.Popen(['ping', '-n', '120', '127.0.0.1'], stdout=subprocess.DEVNULL)\n"
            "host.kill_with_host(child)\n"
            "print(child.pid, flush=True)\n"
            "time.sleep(120)\n"
        )
        parent = subprocess.Popen([sys.executable, "-c", script], stdout=subprocess.PIPE, text=True)
        child_pid = int(parent.stdout.readline())
        parent.kill()  # TerminateProcess，和瀏覽器強制結束本機程式一樣
        parent.wait()
        time.sleep(2)
        alive = subprocess.run(["tasklist", "/FI", f"PID eq {child_pid}", "/NH"], capture_output=True, text=True).stdout
        check(str(child_pid) not in alive, "本機程式被強制結束時，job 裡的子程序跟著結束")


if __name__ == "__main__":
    main()
    if failed:
        print(f"{len(failed)} 項失敗")
        sys.exit(1)
    print("全部通過")
